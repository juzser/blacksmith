import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOrThrow, runProcess } from './helpers/process.js';

// .claude/hooks/guard.sh is the PreToolUse gate on every Bash tool call an
// agent session makes, and it is the one piece of this repo written in bash
// rather than TypeScript — which is exactly why it is tested here rather than
// trusted. Its predecessor was 174 lines of bash that silently allowed
// everything on macOS for eight phases (a `\|` alternation inside a BRE, which
// BSD sed does not support) and no test noticed, because no test existed. The
// rules moved to policy.ts, where policy.test.ts covers them; what is left in
// bash is the transport, and these are its tests.
//
// The property under test is the three-way split the shim exists to make:
// allow is SILENT, a rule violation is relayed as a hard `deny`, and "the
// policy layer could not answer at all" is `ask` — never `allow`, and never a
// dead-end `deny` (see the fresh-clone test below for why that distinction is
// load-bearing rather than cosmetic).
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GUARD_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'guard.sh');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

type Decision = { permissionDecision: string; permissionDecisionReason: string };

function payload(command: string, cwd: string = REPO_ROOT): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
}

/** Runs the hook exactly as Claude Code does: payload on stdin, decision on stdout. */
function askGuard(input: string, guard: string = GUARD_PATH): { stdout: string; status: number } {
  const run = runProcess('bash', [guard], { input });
  return { stdout: run.stdout.trim(), status: run.status as number };
}

function decisionOf(stdout: string): Decision {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: Decision };
  return parsed.hookSpecificOutput;
}

/**
 * A copy of the hook rooted somewhere else, so `REPO_ROOT` inside guard.sh
 * (derived from `BASH_SOURCE`) resolves to `root` and its `dist/cli.js` is
 * whatever this test put there — or nothing at all.
 */
function guardRootedAt(root: string): string {
  const hooks = path.join(root, '.claude', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const dest = path.join(hooks, 'guard.sh');
  cpSync(GUARD_PATH, dest);
  return dest;
}

/**
 * Opens and closes a judge lease through the built binary, the way the
 * orchestrator does — and deliberately with no `--lease-dir`. The guard hook
 * has no such flag, so the only leases it can ever see are the real ones under
 * state/; a test that pointed the lease somewhere else would be testing a path
 * the hook does not take.
 */
function openLease(worktreeDir: string, role = 'reviewer'): void {
  runOrThrow('node', [
    CLI_PATH,
    'sandbox',
    'open',
    worktreeDir,
    '--role',
    role,
    '--task',
    'epic-1/task-1',
    '--session',
    'sess-1',
  ]);
}

function closeLease(worktreeDir: string): void {
  runOrThrow('node', [CLI_PATH, 'sandbox', 'close', worktreeDir]);
}

describe('guard.sh (PreToolUse transport shim)', () => {
  let scratchDir: string;

  // dist/ comes from test/globalSetup.ts — see cli.test.ts's note.
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-guard-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  describe('when the policy layer answers', () => {
    it('says nothing at all for a command that trips no rule', () => {
      const { stdout, status } = askGuard(payload('echo hi'));
      expect(status).toBe(0);
      // Not merely "does not deny": an explicit allow envelope would make this
      // hook a blanket auto-approver, because Claude Code reads a hook's
      // `allow` as "skip the permission system for this call" — it outranks
      // the operator's own permissions.deny list.
      expect(stdout).toBe('');
    });

    it('relays a rule violation as a hard deny, with the rule’s own wording', () => {
      const { stdout, status } = askGuard(payload('git push origin main'));
      expect(status).toBe(0);
      const decision = decisionOf(stdout);
      expect(decision.permissionDecision).toBe('deny');
      expect(decision.permissionDecisionReason).toContain('main/master');
    });

    it('denies a chained command whose *second* segment targets a protected ref', () => {
      // The bash predecessor took the first matching segment and stopped, so
      // this pair read as a push to feat/x and sailed through. A chain is one
      // tool call and every command in it runs.
      const { stdout } = askGuard(payload('git push origin feat/x; git push origin master'));
      expect(decisionOf(stdout).permissionDecision).toBe('deny');
    });

    it('leaves a chain alone when every segment targets a side branch', () => {
      const { stdout } = askGuard(payload('git push origin feat/x && git push upstream feat/y'));
      expect(stdout).toBe('');
    });

    it('ignores tools other than Bash', () => {
      const input = JSON.stringify({
        tool_name: 'Read',
        tool_input: { command: 'git push origin main' },
        cwd: REPO_ROOT,
      });
      expect(askGuard(input).stdout).toBe('');
    });
  });

  describe('when the policy layer cannot answer', () => {
    it('escalates to the operator on a fresh clone, rather than dead-ending', () => {
      // The load-bearing case. A fresh clone has no dist/ at all, so if this
      // returned `deny` the very first command of INSTALL.md's self-install
      // runbook — `pnpm install` — would be refused, and the runbook could not
      // execute at all. The same trap closes on any `git pull` that touches
      // src/ before a rebuild, because the remedy (`pnpm run build`) is itself
      // a Bash call the hook has just refused. `ask` keeps a human in the loop
      // without making the factory unrepairable from inside.
      const guard = guardRootedAt(path.join(scratchDir, 'fresh'));
      const { stdout, status } = askGuard(payload('pnpm install'), guard);
      expect(status).toBe(0);
      const decision = decisionOf(stdout);
      expect(decision.permissionDecision).toBe('ask');
      expect(decision.permissionDecisionReason).toMatch(/pnpm run build/);
    });

    it('escalates when the policy layer exits without reaching a decision', () => {
      const root = path.join(scratchDir, 'broken');
      const guard = guardRootedAt(root);
      const dist = path.join(root, 'factory', 'orchestrator', 'dist');
      mkdirSync(dist, { recursive: true });
      // The file guard.sh actually execs — `policyHook.js`, not `cli.js`.
      // Writing the wrong name here would exercise the "not built" path above
      // instead of this one, and the two escalate with different wording.
      writeFileSync(path.join(dist, 'policyHook.js'), 'process.exit(1)\n');

      const decision = decisionOf(askGuard(payload('echo hi'), guard).stdout);
      expect(decision.permissionDecision).toBe('ask');
      expect(decision.permissionDecisionReason).toContain('exited 1');
    });

    it('escalates on a payload it cannot parse instead of waving it through', () => {
      const decision = decisionOf(askGuard('not json at all').stdout);
      expect(decision.permissionDecision).toBe('ask');
    });

    it('escalates on empty stdin', () => {
      expect(decisionOf(askGuard('').stdout).permissionDecision).toBe('ask');
    });
  });

  describe('when a judge sandbox is open', () => {
    // A3 end to end. Three components that are unit-tested apart have to line
    // up here or the sandbox is decorative: the lease file the orchestrator
    // wrote into the main clone, the `cwd` the PreToolUse payload carries from
    // wherever the judge actually stands, and the rules policy.ts only applies
    // when those two meet. Nothing below stubs the lease directory, so this
    // fails if the wiring is wrong even where every unit test passes.
    let judgeWorktree: string;

    beforeAll(() => {
      judgeWorktree = path.join(scratchDir, 'judge-wt');
      mkdirSync(judgeWorktree, { recursive: true });
      openLease(judgeWorktree);
    });

    afterAll(() => {
      closeLease(judgeWorktree);
    });

    it('denies a network command issued from inside the leased worktree', () => {
      const { stdout, status } = askGuard(payload('curl https://example.com', judgeWorktree));
      expect(status).toBe(0);
      const decision = decisionOf(stdout);
      expect(decision.permissionDecision).toBe('deny');
      // The role, not just the rule: a judge told "denied" learns nothing,
      // and a denial it cannot attribute is one it will try to work around.
      expect(decision.permissionDecisionReason).toContain('reviewer');
    });

    it('follows the judge into a subdirectory of its worktree', () => {
      // A judge that reads a file two directories down is standing there when
      // it runs its next command. If the lease matched only its own root, one
      // `cd` would step out of the sandbox.
      const deep = path.join(judgeWorktree, 'factory', 'orchestrator');
      mkdirSync(deep, { recursive: true });
      const decision = decisionOf(askGuard(payload('curl https://example.com', deep)).stdout);
      expect(decision.permissionDecision).toBe('deny');
    });

    it('says nothing about the same command run outside the lease', () => {
      // The half that is easy to lose: a coder session's `curl` is ordinary
      // work. A lease that leaked past the worktree it names would refuse
      // every session in this repo, and the factory would stop.
      expect(askGuard(payload('curl https://example.com')).stdout).toBe('');
    });

    it('stops denying once the lease is closed', () => {
      // The sandbox is scoped in time as well as in space. A worktree that
      // stayed judged after its verdict was filed would poison whatever the
      // merge queue did with it next.
      const worktree = path.join(scratchDir, 'judge-wt-closed');
      mkdirSync(worktree, { recursive: true });
      openLease(worktree, 'verifier');
      const denied = decisionOf(askGuard(payload('curl https://example.com', worktree)).stdout);
      expect(denied.permissionDecision).toBe('deny');

      closeLease(worktree);
      expect(askGuard(payload('curl https://example.com', worktree)).stdout).toBe('');
    });
  });

  // The single assertion that would have caught the original bug. Every path
  // above is re-run here through one lens: whatever else the shim does, it
  // must never hand back an envelope that bypasses the permission system.
  it('never emits an allow envelope, on any path', () => {
    const freshGuard = guardRootedAt(path.join(scratchDir, 'never-allow'));
    const outputs = [
      askGuard(payload('echo hi')).stdout,
      askGuard(payload('git push origin main')).stdout,
      askGuard(payload('rm -rf src/important')).stdout,
      askGuard(payload('wrangler deploy')).stdout,
      askGuard('not json at all').stdout,
      askGuard(payload('pnpm install'), freshGuard).stdout,
    ];
    for (const out of outputs) {
      expect(out).not.toContain('"permissionDecision":"allow"');
    }
  });
});
