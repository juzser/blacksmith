import { mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
// The one src import this harness needs, and it is not anything under test.
// `ALL_BUDGET_ENV_NAMES` names the budget vars runCli blanks, so the harness
// stays hermetic when a var is added. Test files that read a policy file or a
// poll interval through `loadBudgetPolicy` / `FOLLOW_TICK_MS` do so for the
// same reason: an assertion that reads the value through the loader the
// binary uses cannot drift away from it when it is retuned.
import { ALL_BUDGET_ENV_NAMES } from '../../src/budgets.js';
import { assertExited, runOrThrow, runProcess } from './process.js';

// Shared by the cli*.test.ts files, split out of the former cli.test.ts. Each
// file owns its own scratch directory (see their beforeAll); only the
// scratch-free pieces live here.
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

// `status` stays a number for the assertions below, but a child killed by a
// signal never reaches them: it throws first, naming the signal. The previous
// `e.status ?? 1` turned a SIGSEGV into a plain exit 1, so a segfaulting
// runtime read as three ordinary assertion failures about `0` and cost a full
// false diagnosis (D-47).
// `stdin` is third rather than folded into a single opts bag so the dozens of
// existing `runCli(args, envOverrides)` callers keep their shape; only the
// verbs that read fd 0 (`prompt wrap -`, `prompt record -`) pass it.
export function runCli(
  args: string[],
  envOverrides?: Record<string, string>,
  stdin?: string,
  cwd?: string,
): { stdout: string; stderr: string; status: number } {
  // The CLI loads the repo-root `.env` (src/cli.ts's `loadDotEnv`) and fills
  // in any budget var not already set in the child's env. An operator `.env`
  // pinning e.g. SMITH_EPIC_CAP_TOKENS beats a test's own `--budget-policy`
  // file (env wins over policy in budgets.ts's `envValue`), and the gate
  // itself strips SMITH_* before running checks (src/testgate.ts), so this
  // harness has to be the one place that stays hermetic. Blank every budget
  // var first, then let explicit overrides win, same order the CLI resolves
  // them in.
  const blankBudgetEnv = Object.fromEntries(ALL_BUDGET_ENV_NAMES.map((name) => [name, '']));
  const run = runProcess('node', [CLI_PATH, ...args], {
    // The `session start` settings hint reads the project's and the user's
    // Claude settings, which a test must never do: BS_NO_SETTINGS_HINT=1 (a
    // test and CI switch, not a user setting) turns it off, and
    // CLAUDE_CONFIG_DIR names a directory that does not exist so no real
    // ~/.claude is read. The hint tests switch it back on and sandbox their own.
    env: {
      ...process.env,
      BS_NO_SETTINGS_HINT: '1',
      CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'smith-cli-tests-no-claude-config'),
      ...blankBudgetEnv,
      ...envOverrides,
    },
    ...(stdin === undefined ? {} : { input: stdin }),
    ...(cwd === undefined ? {} : { cwd }),
  });
  assertExited(run, `smith ${args.join(' ')}`);
  return { stdout: run.stdout, stderr: run.stderr, status: run.status as number };
}

/**
 * Setup for `lessons for-dispatch` tests (bs-optimize epic criterion 4): a
 * fresh temporary event store whose `error-logged` events put `errorClass` on
 * three distinct tasks, so the selection reads that class as recurring. With
 * no `errorClass` the store is empty. Returns the directory for `--state-dir`.
 */
export function dispatchStore(parent: string, name: string, errorClass?: string): string {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  if (errorClass === undefined) return dir;
  const session = `${name}-sess`;
  const base = { session_id: session, plan_version: 1, causal_parent: null };
  const events = [
    { ...base, actor: 'user', event_type: 'session-start', payload: {} },
    ...['p-a/task-1', 'p-b/task-2', 'p-c/task-3'].map((task) => ({
      ...base,
      actor: 'orchestrator',
      event_type: 'error-logged',
      task_id: task,
      causal_parent: `${session}#0`,
      payload: { error: errorClass, severity: 'S3-minor', task_ref: task },
    })),
  ];
  for (const event of events) {
    const run = runCli(['event', 'append', JSON.stringify(event), '--state-dir', dir]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }
  return dir;
}

// `bs init` writes into the project it runs in and reads the user's Claude
// settings, so each run gets a temp project (its cwd) and an isolated HOME and
// CLAUDE_CONFIG_DIR: no test here touches the checkout's own
// `.claude/settings.local.json` or the real `~/.claude/settings.json`.
export function sandboxFor(base: string): { project: string; env: Record<string, string> } {
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    project,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
    },
  };
}

/**
 * A worktree the gate will actually score: on its own task branch, one
 * commit ahead of the base, nothing uncommitted. Since D-30/P9-8 the gate
 * certifies the commit before it runs a single check, so a bare scratch
 * directory now blocks every gate run with `not-committed` — every describe
 * that shells out to `gate run` needs this, not just P9-8's own tests.
 */
export async function committedWorktreeIn(scratchDir: string, name: string): Promise<string> {
  const dir = path.join(scratchDir, 'wt', name);
  await mkdir(dir, { recursive: true });
  const git = (args: string[]) => runOrThrow('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'README.md'), '# repo\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', `smith/epic-1/${name}`]);
  await writeFile(path.join(dir, 'src.ts'), 'export const x = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'task work']);
  return dir;
}

/**
 * The fixtures the `task-status producers` describes share (a plan, a session
 * root on the log, and the verbs that read and write it). They were closures
 * over one describe in the old single file; they take the caller's scratch
 * directory so each file can keep its own.
 */
export function taskStatusFixtures(scratch: () => string) {
  const PLAN = {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: [
      {
        task_id: 'epic-1/task-1',
        epic_id: 'epic-1',
        plan_version: 1,
        objective: 'Do the thing.',
        output_schema_ref: 'result.schema.json',
        acceptance_criteria: ['it works'],
        // Narrow claims on purpose: a `src/foo/**` claim could contain a
        // pnpm-lock.yaml, so worktree.yml's serialize-always rule would
        // (correctly) refuse to run these two concurrently, and this test
        // is about the event, not about admissibility.
        claims: ['src/foo/*.ts'],
        budget: { tokens: 1000, diff_lines: 100 },
        contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      },
      {
        task_id: 'epic-1/task-2',
        epic_id: 'epic-1',
        plan_version: 1,
        objective: 'Do the other thing.',
        output_schema_ref: 'result.schema.json',
        acceptance_criteria: ['it works'],
        claims: ['src/bar/*.ts'],
        budget: { tokens: 1000, diff_lines: 100 },
        contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      },
    ],
    edges: [],
  };

  async function session(): Promise<{ sessionId: string; eventsDir: string; planPath: string }> {
    const sessionId = `cli-p9-29-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const eventsDir = path.join(scratch(), `${sessionId}-events`);
    const planPath = path.join(scratch(), `${sessionId}-plan.json`);
    await writeFile(planPath, JSON.stringify(PLAN));
    const root = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(root.status).toBe(0);
    return { sessionId, eventsDir, planPath };
  }

  function tail(
    sessionId: string,
    eventsDir: string,
  ): {
    event_type: string;
    task_id?: string;
    edge?: { edge_type: string; edge_provenance: string };
    payload: Record<string, unknown>;
  }[] {
    const result = runCli(['event', 'tail', sessionId, '--n', '100', '--state-dir', eventsDir]);
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout).map((e: { record: Record<string, unknown> }) => e.record);
  }

  /** `plan ingest` — what `wave check --session` requires first since #250. */
  function ingest(planPath: string, sessionId: string, eventsDir: string): void {
    const result = runCli([
      'plan',
      'ingest',
      planPath,
      '--session',
      sessionId,
      '--causal-parent',
      `${sessionId}#0`,
      '--state-dir',
      eventsDir,
    ]);
    expect(result.status).toBe(0);
  }

  /** Append one hand-written event under the session root. */
  function append(
    sessionId: string,
    eventsDir: string,
    record: { event_type: string; task_id?: string; payload: Record<string, unknown> },
  ): void {
    const result = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'system',
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        ...record,
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(result.status).toBe(0);
  }

  /**
   * D-137: the other side of the guard above. Refusing to log a merge the
   * queue did not make is right; leaving no way to record one is what turned
   * `envkit-mcp-followup` — merged by hand, four tasks on its integration
   * branch — into an epic that could only be closed by hand-appending the
   * `wave-merged` its log was missing. A repaired hole one verb wide.
   */
  async function handMergedProject(
    sessionId: string,
  ): Promise<{ projectDir: string; branch: string; sha: string }> {
    const originDir = path.join(scratch(), `${sessionId}-adopt-origin.git`);
    const projectDir = path.join(scratch(), `${sessionId}-adopt-project`);
    runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
    runOrThrow('git', ['clone', '-q', originDir, projectDir]);
    runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
    runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
    await writeFile(path.join(projectDir, 'a.txt'), 'a\n');
    runOrThrow('git', ['add', '.'], { cwd: projectDir });
    runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
    runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

    const worktree = runCli(['worktree', 'create', projectDir, 'epic-1', 'task-1']);
    expect(worktree.status).toBe(0);
    const { worktreeDir, branch } = JSON.parse(worktree.stdout);
    await writeFile(path.join(worktreeDir, 'a.txt'), 'a-edited\n');
    runOrThrow('git', ['commit', '-q', '-am', 'edit a'], { cwd: worktreeDir });

    // Merged with no queue anywhere near it — the case this verb is for.
    runOrThrow('git', ['checkout', '-q', 'bs/epic-1/integration'], { cwd: projectDir });
    runOrThrow('git', ['merge', '--no-ff', branch, '-m', 'merged by hand'], { cwd: projectDir });
    const sha = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: projectDir }).stdout.trim();
    return { projectDir, branch, sha };
  }

  return { PLAN, session, tail, ingest, append, handMergedProject };
}
