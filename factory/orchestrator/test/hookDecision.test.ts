import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideHookPayload } from '../src/hookDecision.js';
import { closeSandbox, openSandbox } from '../src/sandbox.js';
import { runOrThrow } from './helpers/process.js';

// The branch-dependent rules (a merge onto main, a bare push from main, a
// rebase on an integration branch) are only as right as the directory the
// branch is read from. The payload's `cwd` is where the SESSION stands, not
// where the command runs: `cd <worktree> && git merge main` issued from a
// session parked in the main clone runs on the worktree's side branch, and
// judging it against `main` is a false deny that teaches agents to route
// around the gate. The reverse — a session in a worktree running `cd
// <main clone> && git merge x` — is the false allow, and the one that matters.
// These cases use real repos, because the branch is read with real git.

let scratch: string;
let mainRepo: string;
let sideRepo: string;
// A worktree on no named branch — `detectCurrentBranch` reads it as `HEAD`.
let detachedRepo: string;
// Leases go to a scratch directory, never the live state/sandboxes: a lease
// a crashed run left there would sandbox a real worktree.
let leaseDir: string;

function initRepoOnBranch(dir: string, branch: string): string {
  mkdirSync(dir, { recursive: true });
  runOrThrow('git', ['init', '-q', '-b', branch, dir]);
  runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // An unborn branch resolves to '' and matches no protected name, which would
  // let a deny case pass for the wrong reason.
  runOrThrow('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function decide(command: string, cwd: string): ReturnType<typeof decideHookPayload> {
  return decideHookPayload(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    cwd,
    leaseDir,
  );
}

function reasonOf(decision: ReturnType<typeof decideHookPayload>): string | null {
  return decision === null ? null : decision.hookSpecificOutput.permissionDecisionReason;
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'hook-decision-'));
  mainRepo = initRepoOnBranch(path.join(scratch, 'main-clone'), 'main');
  sideRepo = path.join(scratch, 'side-worktree');
  runOrThrow('git', ['worktree', 'add', '-q', '-b', 'feat/side', sideRepo], { cwd: mainRepo });
  detachedRepo = path.join(scratch, 'detached-worktree');
  runOrThrow('git', ['worktree', 'add', '-q', '--detach', detachedRepo], { cwd: mainRepo });
  leaseDir = path.join(scratch, 'leases');
  mkdirSync(path.join(mainRepo, 'factory'));
  // `link/..` is the side worktree lexically and the main clone physically.
  symlinkSync(path.join(mainRepo, 'factory'), path.join(sideRepo, 'link'));
  // A directory literally named `q"/"r`, which is what a naive unquote makes
  // of the double-quoted splice `"<side>/q"/"r"`.
  mkdirSync(path.join(sideRepo, 'q"', '"r'), { recursive: true });
  // Exists, is a directory, and cannot be entered.
  mkdirSync(path.join(sideRepo, 'locked'));
  chmodSync(path.join(sideRepo, 'locked'), 0o000);
  // `<side> ` — a real entry a shell would cd into, distinct from
  // `sideRepo` itself, that a naive `.trim()` reads as the same word.
  symlinkSync(mainRepo, `${sideRepo} `);
});

afterAll(async () => {
  chmodSync(path.join(sideRepo, 'locked'), 0o755);
  await rm(scratch, { recursive: true, force: true });
});

describe('decideHookPayload — where the command runs, not where the session stands', () => {
  it('denies a plain merge from a session on main, as before', () => {
    expect(reasonOf(decide('git merge feat/side', mainRepo))).toMatch(/on main/);
  });

  it('allows a plain merge from a session on a side branch, as before', () => {
    expect(decide('git merge main', sideRepo)).toBeNull();
  });

  it('judges `cd <side> && git merge main` from the main clone on the side branch', () => {
    expect(decide(`cd ${sideRepo} && git merge main`, mainRepo)).toBeNull();
  });

  it('accepts a quoted cd target, and a relative one resolved against the session cwd', () => {
    expect(decide(`cd "${sideRepo}" && git merge main`, mainRepo)).toBeNull();
    expect(decide(`cd '${sideRepo}' && git merge main`, mainRepo)).toBeNull();
    expect(decide('cd ../side-worktree && git merge main', mainRepo)).toBeNull();
  });

  it('denies `cd <main> && git merge feat/side` from a side-branch session', () => {
    expect(reasonOf(decide(`cd ${mainRepo} && git merge feat/side`, sideRepo))).toMatch(/on main/);
  });

  it('judges `git -C <side> merge main` from the main clone on the side branch', () => {
    expect(decide(`git -C ${sideRepo} merge main`, mainRepo)).toBeNull();
  });

  it('denies `git -C <main> merge feat/side` from a side-branch session', () => {
    expect(reasonOf(decide(`git -C ${mainRepo} merge feat/side`, sideRepo))).toMatch(/on main/);
  });

  it('still denies when the cd target cannot be read statically', () => {
    expect(reasonOf(decide('cd $X && git merge main', mainRepo))).toMatch(/on main/);
    expect(reasonOf(decide('cd ~/somewhere && git merge main', mainRepo))).toMatch(/on main/);
  });

  it('checks every directory a multi-hop command could run in', () => {
    // A second hop makes the fast path unsafe: the merge could run in either.
    expect(
      reasonOf(decide(`cd ${sideRepo} && cd ${mainRepo} && git merge feat/side`, sideRepo)),
    ).toMatch(/on main/);
    // `;` rather than `&&`: a failed cd leaves the merge running where the
    // session stands, so the session cwd is still a candidate.
    expect(reasonOf(decide(`cd ${sideRepo}; git merge main`, mainRepo))).toMatch(/on main/);
    // A subshell hop into main from a side-branch session.
    expect(reasonOf(decide(`(cd ${mainRepo} && git merge feat/side)`, sideRepo))).toMatch(
      /on main/,
    );
    // `git -C` only moves its own invocation; the second merge runs in the cwd.
    expect(
      reasonOf(decide(`git -C ${sideRepo} merge main && git merge feat/side`, mainRepo)),
    ).toMatch(/on main/);
  });

  it('keeps a judge lease on the session when the command cds out of the leased worktree', () => {
    // The lease binds the session that was handed the worktree. Reading it
    // only from the cd target would let `cd <elsewhere> && curl …` walk out
    // of the sandbox with one hop.
    openSandbox(
      {
        worktreeDir: sideRepo,
        role: 'reviewer',
        taskId: 'epic-1/task-1',
        sessionId: 'sess-hook-decision',
        openedAt: new Date().toISOString(),
      },
      leaseDir,
    );
    try {
      expect(decide('curl https://example.com', sideRepo)).not.toBeNull();
      expect(decide(`cd ${mainRepo} && curl https://example.com`, sideRepo)).not.toBeNull();
      expect(decide(`git -C ${mainRepo} fetch`, sideRepo)).not.toBeNull();
    } finally {
      closeSandbox(sideRepo, leaseDir);
    }
  });

  it('binds a command by the lease over the directory it moves into', () => {
    openSandbox(
      {
        worktreeDir: sideRepo,
        role: 'reviewer',
        taskId: 'epic-1/task-1',
        sessionId: 'sess-hook-decision',
        openedAt: new Date().toISOString(),
      },
      leaseDir,
    );
    try {
      expect(decide('curl https://example.com', mainRepo)).toBeNull();
      expect(decide(`cd ${sideRepo} && curl https://example.com`, mainRepo)).not.toBeNull();
      expect(decide(`git -C ${sideRepo} fetch`, mainRepo)).not.toBeNull();
    } finally {
      closeSandbox(sideRepo, leaseDir);
    }
  });

  it('judges the rm rule on the repo the shortcut resolves to', () => {
    const rm = `rm -${'rf'}`;
    expect(decide(`${rm} workspaces/x`, mainRepo)).toBeNull();
    expect(reasonOf(decide(`cd ${sideRepo} && ${rm} src`, mainRepo))).toMatch(/rm -rf/);
    // Outside any repo there is no root to bound the removal by.
    expect(reasonOf(decide(`cd ${scratch} && ${rm} workspaces`, mainRepo))).toMatch(/rm -rf/);
  });
});

// Every shape below is denied when judged where the session stands (the main
// clone), and must stay denied: the shortcut may only take away a denial it
// can prove wrong, never one it cannot parse.
describe('decideHookPayload — the shortcut forfeits any shape it cannot read with certainty', () => {
  const merge = 'git merge feat/side';
  const cases: [string, () => string][] = [
    ['a lone & after the cd', () => `cd ${sideRepo} && true & ${merge}`],
    ['a backslashed cd', () => `cd ${sideRepo} && \\cd ${mainRepo} && ${merge}`],
    ['eval of a string', () => `cd ${sideRepo} && eval "cd ${mainRepo}; ${merge}"`],
    ['eval of plain words', () => `cd ${sideRepo} && eval cd ${mainRepo} && ${merge}`],
    ['sh -c', () => `cd ${sideRepo} && sh -c 'cd ${mainRepo} && ${merge}'`],
    ['bash -c', () => `cd ${sideRepo} && bash -c 'cd ${mainRepo} && ${merge}'`],
    ['a git -c alias', () => `cd ${sideRepo} && git -c alias.m='!cd ${mainRepo} && ${merge}' m`],
    ['a quoted cd', () => `cd ${sideRepo} && "cd" ${mainRepo} && ${merge}`],
    ['builtin cd', () => `cd ${sideRepo} && builtin cd ${mainRepo} && ${merge}`],
    ['|| after an unenterable cd', () => `cd ${sideRepo}/locked && : || ${merge}`],
    ['an unenterable cd target', () => `cd ${sideRepo}/locked && ${merge}`],
    ['a target outside any repo', () => `cd ${scratch} && ${merge}`],
    [
      'GIT_DIR and GIT_WORK_TREE',
      () => `cd ${sideRepo} && GIT_DIR=${mainRepo}/.git GIT_WORK_TREE=${mainRepo} ${merge}`,
    ],
    [
      '--git-dir and --work-tree',
      () => `cd ${sideRepo} && git --git-dir=${mainRepo}/.git --work-tree=${mainRepo} merge x`,
    ],
    ['git -C with --git-dir', () => `git -C ${sideRepo} --git-dir=${mainRepo}/.git merge x`],
    ['a spliced quoted target', () => `cd "${sideRepo}/q"/"r" && ${merge}`],
    ['cd -', () => `cd - && ${merge}`],
    ['a bare cd', () => `cd && ${merge}`],
    ['a CDPATH-dependent relative target', () => `cd side-worktree && ${merge}`],
    ['a newline', () => `cd ${sideRepo} &&\n${merge}`],
    ['a redirection', () => `cd ${sideRepo} && ${merge} > out`],
    // A word after the target can be a shell alias (zsh's autopushd defines
    // `-` and `1`..`9` as `cd -`/`cd -N`), and any plain word could be one —
    // a denylist of mover words is unsound, so only a literal `git` segment
    // may follow.
    ['an autopushd `-` alias segment', () => `cd ${sideRepo} && - && ${merge}`],
    ['an autopushd numbered alias segment', () => `cd ${sideRepo} && 1 && ${merge}`],
    // A naive `.trim()` reads NBSP/BOM/form-feed as whitespace and drops
    // them, so the parser sees a clean target while the shell — which does
    // not treat them as IFS — keeps them as part of the word.
    ['a trailing NBSP a naive trim swallows', () => `cd ${sideRepo} && ${merge}`],
    ['a trailing BOM a naive trim swallows', () => `cd ${sideRepo}﻿&& ${merge}`],
    ['a trailing form feed a naive trim swallows', () => `cd ${sideRepo}\f&& ${merge}`],
    // Indirect executors are plain words too: they run a git command in
    // another repo entirely, in both shortcut forms.
    [
      'git for-each-repo, cd form',
      () => `cd ${sideRepo} && git for-each-repo --config=x.repos merge feat/side`,
    ],
    [
      'git for-each-repo, -C form',
      () => `git -C ${sideRepo} for-each-repo --config=x.repos merge feat/side`,
    ],
    [
      'git submodule foreach, cd form',
      () => `cd ${sideRepo} && git submodule foreach git merge feat/side`,
    ],
    [
      'git submodule foreach, -C form',
      () => `git -C ${sideRepo} submodule foreach git merge feat/side`,
    ],
    // A detached target has no named branch to judge.
    ['a detached target', () => `cd ${detachedRepo} && ${merge}`],
    // `-x`/`--exec` runs an arbitrary command as part of the rebase.
    ['rebase -x, cd form', () => `cd ${sideRepo} && git rebase -x id main`],
    ['rebase -x, -C form', () => `git -C ${sideRepo} rebase -x id main`],
    ['rebase --exec=', () => `cd ${sideRepo} && git rebase --exec=id main`],
  ];

  it.each(cases)('keeps the session-cwd denial through %s', (_label, command) => {
    expect(decide(command(), mainRepo)).not.toBeNull();
  });

  it('judges a move on the physical directory as well as the lexical one', () => {
    // `link/..` is the side worktree to a lexical resolver, but git chdir()s
    // physically — into the main clone.
    expect(reasonOf(decide('git -C link/.. merge feat/side', sideRepo))).toMatch(/on main/);
    expect(reasonOf(decide('cd ./link/.. && git merge feat/side', sideRepo))).toMatch(/on main/);
  });
});
