import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
// A second, independent repo also on `main` — used to prove the fallback's
// new reason text only fires when a named directory is NOT itself protected.
let mainRepo2: string;
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
  mainRepo2 = initRepoOnBranch(path.join(scratch, 'main-clone-2'), 'main');
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

// Rule 3 (merge-into-protected) can only judge a command in its named target
// alone when the command matches the narrow `shortcutDirectories` shape.
// Anything else falls back to also judging the session's cwd, and that
// fallback is correct and stays. But when the fallback is what denied the
// command, and the command named another directory that is NOT itself
// protected, "you are on main" states a guess as fact: the session's cwd was
// judged only because the shape could not be read for certain, not because
// that is provably where the command runs. See GitHub issue #263.
describe('decideHookPayload — rule 3 reason on the fallback path', () => {
  it('explains the fallback, and the readable shapes, when a named side branch fell out of the shortcut shape via a pipe', () => {
    const reason = reasonOf(decide(`git -C ${sideRepo} merge main | tail -1`, mainRepo));
    expect(reason).toMatch(/on main/);
    expect(reason).toMatch(/could not.*read.*certain|not one the guard can read for certain/i);
    expect(reason).toMatch(/session's own directory/i);
    expect(reason).toMatch(/no pipes/i);
    expect(reason).toMatch(/&&/);
    expect(reason).toMatch(/git -C <dir> merge/);
  });

  it('explains the fallback when a named side branch fell out of the shortcut shape via a semicolon', () => {
    const reason = reasonOf(decide(`cd ${sideRepo}; git merge main`, mainRepo));
    expect(reason).toMatch(/on main/);
    expect(reason).toMatch(/session's own directory/i);
    expect(reason).toMatch(/no pipes/i);
  });

  it('still allows the same command once rewritten into the shortcut shape', () => {
    expect(decide(`git -C ${sideRepo} merge main`, mainRepo)).toBeNull();
  });

  it('keeps the old reason for a plain merge on main naming no other directory', () => {
    const reason = reasonOf(decide('git merge feat/side', mainRepo));
    expect(reason).toMatch(/Check out a side branch instead/);
    expect(reason).not.toMatch(/session's own directory/i);
  });

  it('keeps the old reason when the named directory is also on a protected branch', () => {
    const reason = reasonOf(decide(`git -C ${mainRepo2} merge main | tail -1`, mainRepo));
    expect(reason).toMatch(/Check out a side branch instead/);
    expect(reason).not.toMatch(/session's own directory/i);
  });

  it('explains the fallback without naming a specific cause when a non-allowlisted subcommand forfeits the shortcut', () => {
    // `checkout` is not in `GIT_SUBCOMMAND_ALLOWLIST`, so this all-`&&` chain
    // still falls out of the shortcut shape even though it has no pipe, `;`
    // or redirect — the reason must not claim one of those as the cause.
    const reason = reasonOf(
      decide(`cd ${sideRepo} && git checkout main && git merge main`, mainRepo),
    );
    expect(reason).toMatch(/on main/);
    expect(reason).toMatch(/session's own directory/i);
    expect(reason).toMatch(/not one the guard can read for certain/i);
    expect(reason).not.toMatch(/leaves it ambiguous/i);
    expect(reason).not.toMatch(/\(a pipe/i);
  });

  it('keeps the force-push reason, not the fallback merge text, when both fire in the same chain', () => {
    const reason = reasonOf(
      decide(`cd ${sideRepo} && git push --force origin main && git merge main`, mainRepo),
    );
    expect(reason).toMatch(/push to main|force-push/i);
    expect(reason).not.toMatch(/session's own directory/i);
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
    // -x stuck to a value, or bundled with another short flag: still runs an
    // arbitrary command as part of the rebase.
    ['rebase -x stuck to a value', () => `cd ${sideRepo} && git rebase -x./s main`],
    ['rebase -x bundled with another flag', () => `cd ${sideRepo} && git rebase -kx./s main`],
    ['rebase --exe= (a long-option prefix)', () => `cd ${sideRepo} && git rebase --exe=./s main`],
    // `-s`/`--strategy` runs `git-<name>` off PATH.
    ['merge -s (a strategy flag)', () => `cd ${sideRepo} && git merge -s foo main`],
    ['merge --strategy=', () => `cd ${sideRepo} && git merge --strategy=foo main`],
    // `checkout`/`switch` can move the target onto a different branch than
    // the one the shortcut just read, so a merge later in the same chain is
    // judged on the branch the target left, not the one it moved to.
    [
      'checkout moves the target onto the branch a later merge lands on',
      () => `cd ${sideRepo} && git checkout --ignore-other-worktrees main && ${merge}`,
    ],
    [
      'switch moves the target onto the branch a later merge lands on',
      () => `cd ${sideRepo} && git switch --ignore-other-worktrees main && ${merge}`,
    ],
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

describe('Agent dispatches (judge artifact line)', () => {
  const abs = '/abs/state/results/task-1.reviewer.json';
  const agent = (
    subagentType: string | undefined,
    prompt: unknown,
    toolName = 'Agent',
  ): ReturnType<typeof decideHookPayload> =>
    decideHookPayload(
      JSON.stringify({
        tool_name: toolName,
        tool_input: {
          ...(subagentType === undefined ? {} : { subagent_type: subagentType }),
          prompt,
        },
        // Outside any repo, so no case here leans on a branch. This does not
        // show the order; the last test in this block does.
        cwd: path.join(scratch, 'not-a-repo'),
      }),
      path.join(scratch, 'not-a-repo'),
      leaseDir,
    );

  // `bs-<role>` is the agent name; the bare names stay denied for a box whose
  // installed plugin predates the prefix. A foreign namespace is stripped the
  // same way judge-stop strips it (roleOfAgentType), so the two agree.
  it.each([
    'reviewer',
    'blacksmith:reviewer',
    'auditor',
    'spec-reviewer',
    'bs-reviewer',
    'blacksmith:bs-reviewer',
    'bs-spec-reviewer',
    'bs-security-reviewer',
    'other:bs-reviewer',
    'other:reviewer',
  ])(
    'denies %s with no declared-artifact line',
    (type) => {
      const reason = reasonOf(agent(type, 'Role: reviewer. Do the review.'));
      expect(reason).toContain('Declared artifact: <absolute path>');
      expect(reason).toContain('judge dispatch');
      expect(reason).toContain('expected_line');
    },
  );

  it('treats Task like Agent', () => {
    expect(agent('reviewer', 'no line', 'Task')).not.toBeNull();
    expect(agent('reviewer', `Declared artifact: ${abs}\n`, 'Task')).toBeNull();
  });

  it('names a relative path it found', () => {
    const reason = reasonOf(agent('verifier', 'Declared artifact: state/results/x.json\n'));
    expect(reason).toContain('state/results/x.json');
    expect(reason).toMatch(/relative/);
  });

  it('does not count an indented line', () => {
    expect(agent('reviewer', `  Declared artifact: ${abs}\n`)).not.toBeNull();
  });

  it('reads a non-string prompt as no line', () => {
    expect(agent('reviewer', undefined)).not.toBeNull();
    expect(agent('reviewer', 42)).not.toBeNull();
  });

  // Parity with judge-stop, which reads the line with the same parser.
  it('allows an absolute line in a CRLF prompt', () => {
    expect(agent('reviewer', `Role: reviewer.\r\nDeclared artifact: ${abs}\r\nGo.\r\n`)).toBeNull();
  });

  it('denies a line with text after the path', () => {
    expect(agent('reviewer', `Declared artifact: ${abs} extra\n`)).not.toBeNull();
  });

  it('lets the first of two lines decide', () => {
    const relative = 'Declared artifact: state/results/x.json';
    const absolute = `Declared artifact: ${abs}`;
    expect(agent('reviewer', `${relative}\n${absolute}\n`)).not.toBeNull();
    expect(agent('reviewer', `${absolute}\n${relative}\n`)).toBeNull();
  });

  it.each([
    ['reviewer', `Role: reviewer.\nDeclared artifact: ${abs}\n`],
    ['blacksmith:grader', `Declared artifact: ${abs}`],
    ['bs-reviewer', `Declared artifact: ${abs}`],
    ['blacksmith:bs-reviewer', `Declared artifact: ${abs}`],
    ['bs-coder', 'no line needed'],
    ['blacksmith:bs-uiux', 'no line needed'],
    ['bs-', 'no line needed'],
    ['coder', 'no line needed'],
    ['uiux', 'no line needed'],
    ['general-purpose', 'no line needed'],
    [undefined, 'no line needed'],
  ])('allows %s silently (%j)', (type, prompt) => {
    expect(agent(type, prompt)).toBeNull();
  });

  // The command alone cannot show the order: the guardrail inspects only Bash
  // and file tools, so it never reads an Agent payload's `command` either way.
  // The lease read can, because an unreadable lease makes it throw: an Agent
  // payload answered after that read would throw here instead of allowing.
  it('answers an Agent payload before any lease or command work', () => {
    const cwd = path.join(scratch, 'not-a-repo');
    const badLeases = path.join(scratch, 'bad-leases');
    mkdirSync(badLeases, { recursive: true });
    writeFileSync(path.join(badLeases, 'corrupt.json'), '{');
    const forcePush = 'git push --force origin main';
    const payload = (toolName: string) =>
      JSON.stringify({
        tool_name: toolName,
        tool_input: { subagent_type: 'coder', prompt: 'no line needed', command: forcePush },
        cwd,
      });
    // The same payload as Bash: the command is denied, and the lease read throws.
    expect(reasonOf(decideHookPayload(payload('Bash'), cwd, leaseDir))).toMatch(/^BLOCKED:/);
    expect(() => decideHookPayload(payload('Bash'), cwd, badLeases)).toThrow();
    expect(decideHookPayload(payload('Agent'), cwd, badLeases)).toBeNull();
    expect(decideHookPayload(payload('Task'), cwd, badLeases)).toBeNull();
  });
});
