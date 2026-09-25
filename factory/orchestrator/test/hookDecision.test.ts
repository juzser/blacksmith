import { mkdirSync } from 'node:fs';
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
});

afterAll(async () => {
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
    openSandbox({
      worktreeDir: sideRepo,
      role: 'reviewer',
      taskId: 'epic-1/task-1',
      sessionId: 'sess-hook-decision',
      openedAt: new Date().toISOString(),
    });
    try {
      expect(decide('curl https://example.com', sideRepo)).not.toBeNull();
      expect(decide(`cd ${mainRepo} && curl https://example.com`, sideRepo)).not.toBeNull();
      expect(decide(`git -C ${mainRepo} fetch`, sideRepo)).not.toBeNull();
    } finally {
      closeSandbox(sideRepo);
    }
  });
});
