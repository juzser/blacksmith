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
  ctx(): { sessionId: string; planVersion: number; causalParent: string; actor: string };
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
    ctx: () => ({
      sessionId: SESSION_ID,
      planVersion: 1,
      causalParent: `${SESSION_ID}#0`,
      actor: 'operator',
    }),
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

/** A manifest `checkManifest` accepts; `tools` replaces the one read-only tool. */
export function mcpManifest(tools?: Record<string, unknown>[]): string {
  return `${JSON.stringify({
    name: 'demo',
    version: '0.1.0',
    protocolRevision: '2025-11-25',
    transport: { kind: 'stdio' },
    tools: tools ?? [
      {
        name: 'project_health',
        title: 'Project health',
        description: 'Reports the surface revision.',
        mutation: 'read-only',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  })}\n`;
}

/** A write tool that nobody signed off (MCP-T4). */
export const UNSIGNED_TOOL = {
  name: 'rotate_widget',
  title: 'Rotate widget',
  description: 'Rotates a widget.',
  mutation: 'write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** Commit `mcp.manifest.json` with `body` on the task branch, so the commit stage stays green. */
export async function commitMcpManifest(w: World, body: string): Promise<void> {
  await writeFile(path.join(w.worktreeDir, 'mcp.manifest.json'), body);
  w.git(['add', 'mcp.manifest.json']);
  w.git(['commit', '-q', '-m', 'mcp manifest']);
}

/** The operator's signature on a tool, as `mcp.md` MCP-T4 spells it. */
export const OPERATOR_APPROVAL = {
  operator: 'sam',
  date: '2026-11-04',
  milestone: 'demo-mcp-surface',
};

/** A write tool whose annotation breaks MCP-T2 as well as lacking a signature. */
export const MISANNOTATED_TOOL = {
  ...UNSIGNED_TOOL,
  annotations: { ...UNSIGNED_TOOL.annotations, readOnlyHint: true },
};

/**
 * Commit `body` as `mcp.manifest.json` on the base branch, then move the task
 * branch onto it: the way an operator-authored approval reaches a task. Call
 * before the task commits a manifest of its own.
 */
export async function commitMcpManifestOnBase(w: World, body: string): Promise<void> {
  const task = w.git(['branch', '--show-current']);
  w.git(['checkout', '-q', 'main']);
  await writeFile(path.join(w.worktreeDir, 'mcp.manifest.json'), body);
  w.git(['add', 'mcp.manifest.json']);
  w.git(['commit', '-q', '-m', 'operator manifest']);
  w.git(['checkout', '-q', task]);
  w.git(['rebase', '-q', 'main']);
}

export const mcpUnsignedTool: FixtureBuilder = async (w) => {
  await commitMcpManifest(w, mcpManifest([UNSIGNED_TOOL]));
  return baseInput(w);
};

export const mcpMisannotatedTool: FixtureBuilder = async (w) => {
  await commitMcpManifest(w, mcpManifest([MISANNOTATED_TOOL]));
  return baseInput(w);
};

/** The task itself writes the approval. */
export const mcpSelfSigned: FixtureBuilder = async (w) => {
  await commitMcpManifest(w, mcpManifest([{ ...UNSIGNED_TOOL, approval: OPERATOR_APPROVAL }]));
  return baseInput(w);
};

/** The operator signed on the base branch; the task leaves the manifest alone. */
export const mcpSignedOnBase: FixtureBuilder = async (w) => {
  await commitMcpManifestOnBase(
    w,
    mcpManifest([{ ...UNSIGNED_TOOL, approval: OPERATOR_APPROVAL }]),
  );
  return baseInput(w);
};

export const mcpValid: FixtureBuilder = async (w) => {
  await commitMcpManifest(w, mcpManifest());
  return baseInput(w);
};

export const mcpUnreadable: FixtureBuilder = async (w) => {
  await commitMcpManifest(w, '{ not json');
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
    artifacts: names.map((name) => {
      const w = name.includes('-mobile-') ? 390 : 1280;
      return { type: 'screenshot', path: name, inner_width: w, client_width: w };
    }),
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

/** Tester recorded with the mobile-light page wider than its 390 px viewport. */
export async function recordTesterWithOverflow(w: World): Promise<Record<string, unknown>> {
  const result = await testerResult(w, SHOT_NAMES);
  for (const art of result.artifacts as Record<string, unknown>[]) {
    if (art.path === 'home-mobile-light.png') {
      art.inner_width = 600;
      art.client_width = 390;
    }
  }
  await recordTaskResult(
    { taskId: w.taskId, result, artifactsDir: w.artifactsDir, worktreeDir: w.worktreeDir },
    w.ctx(),
    w.opts(),
  );
  return result;
}

export const mobileOverflow: FixtureBuilder = async (w) => {
  await withSpecTurn(w);
  await recordTesterWithOverflow(w);
  return baseInput(w, { uiAffecting: true });
};

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
  {
    name: 'mcp unsigned mutating tool',
    build: mcpUnsignedTool,
    reason: 'mcp-approval-unsigned-by-operator',
  },
  {
    name: 'mcp approval written by the task',
    build: mcpSelfSigned,
    reason: 'mcp-approval-unsigned-by-operator',
  },
  { name: 'mcp misannotated tool', build: mcpMisannotatedTool, reason: 'mcp-manifest-invalid' },
  { name: 'mcp unreadable manifest', build: mcpUnreadable, reason: 'mcp-manifest-invalid' },
  { name: 'mcp valid manifest', build: mcpValid, reason: null },
  { name: 'mcp tool signed on the base', build: mcpSignedOnBase, reason: null },
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
  { name: 'mobile overflow', build: mobileOverflow, reason: 'mobile-overflow' },
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
  await commitMcpManifest(w, mcpManifest([MISANNOTATED_TOOL]));

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
        reason: 'mcp-manifest-invalid',
        fix: async () => {
          await commitMcpManifest(w, mcpManifest([UNSIGNED_TOOL]));
        },
      },
      {
        reason: 'mcp-approval-unsigned-by-operator',
        fix: async () => {
          await commitMcpManifest(w, mcpManifest());
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
          await recordTesterWithOverflow(w);
          await closeUiuxTurn(w, 'visual');
        },
      },
      {
        reason: 'mobile-overflow',
        fix: async () => {
          await recordTester(w);
          await closeUiuxTurn(w, 'visual', 2);
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
