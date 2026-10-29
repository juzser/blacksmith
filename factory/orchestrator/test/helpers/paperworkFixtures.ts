import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent } from '../../src/events.js';
import { type GateInput, recordTaskResult } from '../../src/gate.js';
import { recordJudgeDispatch, recordJudgeReport } from '../../src/judges.js';

/**
 * Fixtures for the gate's paperwork checks: one builder per defect, each
 * returning the `GateInput` a `runGate` call takes. A builder leaves its world
 * (event log, worktree, artifact home) in the state the defect needs, so the
 * gate and a preflight can be pointed at the very same input. Shared by
 * test/paperwork.test.ts and the `bs results check` CLI tests.
 */

export const TASK_ID = 'epic-1/task-1';
export const SESSION_ID = 'sess-paperwork';

export interface World {
  stateDir: string;
  worktreeDir: string;
  artifactsDir: string;
  /** A directory outside every artifact home, for the outside-home fixture. */
  elsewhereDir: string;
  sessionId: string;
  taskId: string;
  ctx(): { sessionId: string; planVersion: number; causalParent: string };
  opts(): { stateDir: string };
  git(args: string[]): string;
  /** The artifact home of this task: where declared artifacts have to live. */
  home(): string;
  dispose(): Promise<void>;
}

/** What `result.schema.json` requires of a stamped worker result. */
export function stampedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: TASK_ID,
    run_status: 'done',
    structured_output: {},
    artifacts: [],
    token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    agent: 'coder',
    provider: 'claude',
    model_tier: 'mid',
    ...overrides,
  };
}

/**
 * A real repository: `smith/epic-1/task-1` one commit ahead of `main`, with a
 * package.json that declares a dependency and a `.gitignore` that keeps
 * node_modules out of the dirty list. The deps stage therefore blocks until a
 * fixture creates `node_modules/.bin`.
 */
export async function createWorld(): Promise<World> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bs-paperwork-state-'));
  const worktreeDir = await mkdtemp(path.join(tmpdir(), 'bs-paperwork-wt-'));
  const artifactsDir = await mkdtemp(path.join(tmpdir(), 'bs-paperwork-art-'));
  const elsewhereDir = await mkdtemp(path.join(tmpdir(), 'bs-paperwork-else-'));
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' }).trim();

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  await writeFile(path.join(worktreeDir, 'README.md'), '# repo\n');
  await writeFile(path.join(worktreeDir, '.gitignore'), 'node_modules/\ncoverage/\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'smith/epic-1/task-1']);
  await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n');
  await writeFile(
    path.join(worktreeDir, 'package.json'),
    `${JSON.stringify({ name: 'proj', private: true, devDependencies: { somepkg: '1.0.0' } })}\n`,
  );
  git(['add', '.']);
  git(['commit', '-q', '-m', 'task work']);
  await mkdir(path.join(worktreeDir, 'node_modules', '.bin'), { recursive: true });

  await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    { stateDir },
  );

  return {
    stateDir,
    worktreeDir,
    artifactsDir,
    elsewhereDir,
    sessionId: SESSION_ID,
    taskId: TASK_ID,
    ctx: () => ({ sessionId: SESSION_ID, planVersion: 1, causalParent: `${SESSION_ID}#0` }),
    opts: () => ({ stateDir }),
    git,
    home: () => path.join(artifactsDir, TASK_ID),
    dispose: async () => {
      for (const dir of [stateDir, worktreeDir, artifactsDir, elsewhereDir]) {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The gate input a clean world passes: stamped result, committed work, no judges, a no-op check. */
export function baseInput(w: World, overrides: Partial<GateInput> = {}): GateInput {
  return {
    taskId: w.taskId,
    result: stampedResult(),
    worktreeDir: w.worktreeDir,
    baseRef: 'main',
    checks: [{ name: 'noop', cmd: 'true' }],
    findingsInput: [],
    lessons: [],
    artifactsDir: w.artifactsDir,
    ...overrides,
  };
}

export type FixtureBuilder = (w: World) => Promise<GateInput>;

export const clean: FixtureBuilder = async (w) => baseInput(w);

/** A worker half: the envelope the dispatcher stamps is missing. */
export const unstamped: FixtureBuilder = async (w) =>
  baseInput(w, {
    result: {
      run_status: 'done',
      structured_output: {},
      artifacts: [],
    },
  });

export const shapeError: FixtureBuilder = async (w) =>
  baseInput(w, { result: stampedResult({ run_status: 'not-a-real-status' }) });

export const artifactMissing: FixtureBuilder = async (w) =>
  baseInput(w, {
    result: stampedResult({ artifacts: [{ type: 'log', path: 'never-written.txt' }] }),
  });

export const artifactOutsideHome: FixtureBuilder = async (w) => {
  const elsewhere = path.join(w.elsewhereDir, 'evidence.txt');
  await writeFile(elsewhere, 'evidence\n');
  return baseInput(w, { result: stampedResult({ artifacts: [{ type: 'log', path: elsewhere }] }) });
};

export const uncommitted: FixtureBuilder = async (w) => {
  await writeFile(path.join(w.worktreeDir, 'src.ts'), 'export const x = 2;\n');
  return baseInput(w);
};

export const depsMissing: FixtureBuilder = async (w) => {
  await rm(path.join(w.worktreeDir, 'node_modules'), { recursive: true, force: true });
  return baseInput(w);
};

/** The reviewer judge turn the outstanding fixtures leave open. */
export const OPEN_JUDGE = { role: 'reviewer', kind: null } as const;

export async function dispatchJudge(w: World, role: string, round = 1): Promise<void> {
  await recordJudgeDispatch(
    {
      taskId: w.taskId,
      role,
      round,
      artifactPath: path.join(w.stateDir, `${role}.json`),
      model: 'claude-opus-5',
    },
    w.ctx(),
    w.opts(),
  );
}

export const judgesOutstanding: FixtureBuilder = async (w) => {
  await dispatchJudge(w, 'reviewer');
  return baseInput(w);
};

/** The shape the grader's own output contract mandates. */
export function graderVerdictBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    round: 1,
    criteria: [{ criterion: 'a bare CR splits a line', status: 'pass', evidence: 'test green' }],
    overall: 'pass',
    ...overrides,
  };
}

export function graderFile(
  structuredOutput: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    run_status: 'done',
    structured_output: structuredOutput,
    artifacts: [],
    token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

export const graderMet: FixtureBuilder = async (w) =>
  baseInput(w, { graderVerdict: graderFile(graderVerdictBody()) });

export const graderOutsideStructured: FixtureBuilder = async (w) =>
  baseInput(w, {
    graderVerdict: { task_id: w.taskId, round: 1, verdict: 'pass', criteria: [], notes: 'ok' },
  });

export const graderMissingCriteriaFields: FixtureBuilder = async (w) =>
  baseInput(w, {
    graderVerdict: graderFile(
      graderVerdictBody({ criteria: [{ criterion: 'no evidence or status here' }] }),
    ),
  });

export const graderRoundThree: FixtureBuilder = async (w) =>
  baseInput(w, { graderVerdict: graderFile(graderVerdictBody({ round: 3 })) });

/** Well formed, rubric not met: a verdict, not a paperwork problem. */
export const graderFailed: FixtureBuilder = async (w) =>
  baseInput(w, {
    graderVerdict: graderFile(
      graderVerdictBody({
        criteria: [{ criterion: 'c1', status: 'fail', evidence: 'test red' }],
        overall: 'fail',
      }),
    ),
  });

export const graderDead: FixtureBuilder = async (w) =>
  baseInput(w, { graderVerdict: graderFile({}, { run_status: 'dead' }) });

const COMBOS = [
  ['desktop', 'light'],
  ['desktop', 'dark'],
  ['mobile', 'light'],
  ['mobile', 'dark'],
] as const;

export const SHOT_NAMES = COMBOS.map(([v, t]) => `home-${v}-${t}.png`);

async function writeShots(w: World, names: readonly string[]): Promise<void> {
  await mkdir(w.home(), { recursive: true });
  for (const name of names) await writeFile(path.join(w.home(), name), 'png-bytes');
}

/** The tester's result document for a set of screenshot file names. Files are written unless `onDisk` is given. */
export async function testerResult(
  w: World,
  names: readonly string[],
  onDisk: readonly string[] = names,
): Promise<Record<string, unknown>> {
  await writeShots(w, onDisk);
  return stampedResult({
    agent: 'tester',
    artifacts: names.map((name) => ({ type: 'screenshot', path: name })),
  });
}

export async function closeUiuxTurn(w: World, kind: 'spec' | 'visual', round = 1): Promise<void> {
  await recordJudgeDispatch(
    {
      taskId: w.taskId,
      role: 'uiux',
      round,
      artifactPath: path.join(w.stateDir, `uiux-${kind}-${round}.json`),
      model: 'claude-opus-5',
      kind,
    },
    w.ctx(),
    w.opts(),
  );
  await recordJudgeReport(
    { taskId: w.taskId, role: 'uiux', kind, noFindings: true, round },
    w.ctx(),
    w.opts(),
  );
}

/** Dispatch a uiux turn and leave it unreported. */
export async function openUiuxTurn(w: World, kind: 'spec' | 'visual', round = 1): Promise<void> {
  await recordJudgeDispatch(
    {
      taskId: w.taskId,
      role: 'uiux',
      round,
      artifactPath: path.join(w.stateDir, `uiux-${kind}-${round}.json`),
      model: 'claude-opus-5',
      kind,
    },
    w.ctx(),
    w.opts(),
  );
}

/** A session that already holds the uiux spec turn, as the tester's does. */
export async function withSpecTurn(w: World): Promise<void> {
  await closeUiuxTurn(w, 'spec');
}

/** The tester has run: record its result with the worktree head, as `results record --worktree` does. */
export async function recordTester(
  w: World,
  names: readonly string[] = SHOT_NAMES,
): Promise<Record<string, unknown>> {
  const result = await testerResult(w, names);
  await recordTaskResult(
    { taskId: w.taskId, result, artifactsDir: w.artifactsDir, worktreeDir: w.worktreeDir },
    w.ctx(),
    w.opts(),
  );
  return result;
}

export const uiuxSpecMissing: FixtureBuilder = async (w) => baseInput(w, { uiAffecting: true });

/** Tester recorded with a screenshot named without the viewport and theme suffix. */
export const screenshotMisnamed: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTester(w, ['home.png']);
  return baseInput(w, { uiAffecting: true });
};

/** Tester recorded with the mobile-dark shot missing. */
export const screenshotComboMissing: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTester(w, SHOT_NAMES.slice(0, 3));
  return baseInput(w, { uiAffecting: true });
};

/** Screenshots recorded at a head the branch has since moved past. */
export const screenshotsStale: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTester(w);
  await writeFile(path.join(w.worktreeDir, 'later.ts'), 'export const y = 1;\n');
  w.git(['add', 'later.ts']);
  w.git(['commit', '-q', '-m', 'later work']);
  return baseInput(w, { uiAffecting: true });
};

/** Spec closed, screenshots complete and fresh, no visual turn at all. */
export const uiuxVisualMissing: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTester(w);
  return baseInput(w, { uiAffecting: true });
};

/** As above, with the visual turn dispatched after the tester record and not yet reported. */
export const uiuxVisualOpen: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTester(w);
  await openUiuxTurn(w, 'visual');
  return baseInput(w, { uiAffecting: true });
};

/** Every uiux turn and the tester record in place: the ui-affecting clean fixture. */
export const uiuxClean: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTester(w);
  await closeUiuxTurn(w, 'visual');
  return baseInput(w, { uiAffecting: true });
};

/** A ui-affecting task with no uiux spec, tester record or visual turn, and a dispatched, unreported reviewer. */
export const earlyHandBack: FixtureBuilder = async (w) => {
  await dispatchJudge(w, 'reviewer');
  return baseInput(w, { uiAffecting: true });
};

/** Parity table: fixture, and the reason `runGate` blocks with (null: it passes). */
export const PARITY_CASES: readonly {
  name: string;
  build: FixtureBuilder;
  reason: string | null;
}[] = [
  { name: 'clean', build: clean, reason: null },
  { name: 'unstamped envelope', build: unstamped, reason: 'schema-invalid' },
  { name: 'worker shape error', build: shapeError, reason: 'schema-invalid' },
  { name: 'artifact never written', build: artifactMissing, reason: 'artifacts-missing' },
  { name: 'artifact outside the home', build: artifactOutsideHome, reason: 'artifacts-missing' },
  { name: 'uncommitted work', build: uncommitted, reason: 'not-committed' },
  { name: 'deps missing', build: depsMissing, reason: 'deps-missing' },
  { name: 'judge turn outstanding', build: judgesOutstanding, reason: 'judges-outstanding' },
  {
    name: 'grader verdict outside structured_output',
    build: graderOutsideStructured,
    reason: 'grader-invalid',
  },
  {
    name: 'grader criteria missing fields',
    build: graderMissingCriteriaFields,
    reason: 'grader-invalid',
  },
  { name: 'grader round 3', build: graderRoundThree, reason: 'grader-invalid' },
  { name: 'screenshot misnamed', build: screenshotMisnamed, reason: 'screenshots-missing' },
  {
    name: 'screenshot combo missing',
    build: screenshotComboMissing,
    reason: 'screenshots-missing',
  },
  { name: 'uiux spec missing', build: uiuxSpecMissing, reason: 'uiux-spec-missing' },
  { name: 'screenshots stale', build: screenshotsStale, reason: 'screenshots-stale' },
  { name: 'uiux visual missing', build: uiuxVisualMissing, reason: 'uiux-visual-missing' },
  { name: 'ui-affecting, everything in place', build: uiuxClean, reason: null },
];

/**
 * The stage-order ladder: one world carrying every paperwork defect, and the
 * steps that remove them one at a time, in the gate's order. `steps[i].reason`
 * is what both the gate and the preflight say while that defect is the first
 * one standing; after the last step the input passes.
 */
export interface Ladder {
  input(): GateInput;
  steps: { reason: string; fix: () => Promise<void> }[];
}

export async function buildLadder(w: World): Promise<Ladder> {
  const file = path.join(w.worktreeDir, 'src.ts');
  const declared = { type: 'log', path: 'ladder-evidence.txt' };
  let result: Record<string, unknown> = {
    run_status: 'done',
    structured_output: {},
    artifacts: [declared],
  };
  let graderVerdict: unknown = { verdict: 'pass' };
  await writeFile(file, 'export const x = 3;\n');
  await rm(path.join(w.worktreeDir, 'node_modules'), { recursive: true, force: true });
  await dispatchJudge(w, 'reviewer');

  return {
    input: () => baseInput(w, { result, graderVerdict, uiAffecting: true }),
    steps: [
      {
        reason: 'schema-invalid',
        fix: async () => {
          result = stampedResult({ artifacts: [declared] });
        },
      },
      {
        reason: 'artifacts-missing',
        fix: async () => {
          await mkdir(w.home(), { recursive: true });
          await writeFile(path.join(w.home(), declared.path), 'evidence\n');
        },
      },
      {
        reason: 'not-committed',
        fix: async () => {
          w.git(['add', 'src.ts']);
          w.git(['commit', '-q', '-m', 'ladder work']);
        },
      },
      {
        reason: 'deps-missing',
        fix: async () => {
          await mkdir(path.join(w.worktreeDir, 'node_modules', '.bin'), { recursive: true });
        },
      },
      {
        reason: 'judges-outstanding',
        fix: async () => {
          await writeFile(path.join(w.stateDir, 'reviewer.json'), '[]', 'utf8');
          await recordJudgeReport({ taskId: w.taskId, role: 'reviewer' }, w.ctx(), w.opts());
        },
      },
      {
        reason: 'uiux-spec-missing',
        fix: async () => {
          await withSpecTurn(w);
          await recordTester(w);
          await closeUiuxTurn(w, 'visual');
        },
      },
      {
        reason: 'grader-invalid',
        fix: async () => {
          graderVerdict = graderFile(graderVerdictBody());
        },
      },
    ],
  };
}
