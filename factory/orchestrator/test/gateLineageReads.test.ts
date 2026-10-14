import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiProviderConfig, CliProviderConfig, CrosscheckPolicy } from '../src/crosscheck.js';
import { appendEvent, readEvents, readLineageEvents } from '../src/events.js';
import { type FindingDraft, type RaiseFindingInput, raiseFinding } from '../src/findings.js';
import { type GateInput, type GateOutcome, runGate } from '../src/gate.js';
import { recordJudgeDispatch, recordJudgeReport } from '../src/judges.js';
import { beginLineageRun, endLineageRun, readLineage } from '../src/lineageSnapshot.js';
import { grantWaiver, isWaived } from '../src/waivers.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

// Counts the lineage reads that cross the events module boundary. Reads made
// inside events.ts itself (appendEvent's own) never go through this export.
vi.mock('../src/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/events.js')>();
  return { ...actual, readLineageEvents: vi.fn(actual.readLineageEvents) };
});

// Lets one case run the gate with no snapshot, to compare outcomes.
const switches = vi.hoisted(() => ({ withoutSnapshot: false }));
vi.mock('../src/lineageSnapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lineageSnapshot.js')>();
  return {
    ...actual,
    beginLineageRun: (opts: object) => {
      if (!switches.withoutSnapshot) actual.beginLineageRun(opts);
    },
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_CLI = path.join(here, 'fixtures', 'fake-judge-cli.mjs');
const API_KEY_ENV = 'TEST_LINEAGE_API_KEY';
const TASK = 'epic-a/task-1';
const OTHER_TASK = 'epic-a/task-2';

function codex(): CliProviderConfig {
  return {
    name: 'codex',
    kind: 'api',
    transport: 'cli',
    enabled: true,
    enabledSource: 'declared',
    mode: 'active',
    modelTier: 'mid',
    command: 'node',
    args: [JUDGE_CLI, 'refute'],
  };
}

function remote(): ApiProviderConfig {
  return {
    name: 'deepseek',
    kind: 'api',
    transport: 'api',
    enabled: true,
    enabledSource: 'declared',
    mode: 'active',
    modelTier: 'mid',
    baseUrl: 'https://api.example.test',
    model: 'test-model',
    apiKeyEnv: API_KEY_ENV,
    responseFormatJsonObject: true,
  };
}

function policy(): CrosscheckPolicy {
  return {
    ...crosscheckDefaults(),
    providers: {
      claude: { name: 'claude', kind: 'native', enabled: true },
      codex: codex(),
      deepseek: remote(),
    },
    quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
  };
}

// The cli judge refutes and this one confirms, so every cross-checked finding escalates.
function confirmingFetch() {
  return vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ verdict: 'confirm', rationale: 'confirmed' }) },
            },
          ],
        }),
        { status: 200 },
      ),
  );
}

function draft(i: number, severity: string): FindingDraft {
  return {
    finding_id: `finding-${i}`,
    task_id: TASK,
    finding_category: 'correctness',
    severity,
    finding_status: 'raised',
    summary: `defect number ${i}`,
    failure_scenario: { inputs: `n=${i}`, expected: 'ok', actual: 'wrong' },
    found_by: 'reviewer',
  } as FindingDraft;
}

describe('gate lineage reads', () => {
  let stateDir: string;
  let worktreeDir: string;
  let artifactsDir: string;
  const sessionId = 'sess-lineage-reads';
  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
  const originalKey = process.env[API_KEY_ENV];

  function git(args: string[]) {
    return execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' }).trim();
  }

  async function append(
    eventType: string,
    taskId: string | undefined,
    payload: Record<string, unknown>,
    actor = 'system',
  ) {
    await appendEvent(
      {
        session_id: sessionId,
        actor,
        event_type: eventType,
        ...(taskId === undefined ? {} : { task_id: taskId }),
        plan_version: 1,
        causal_parent: eventType === 'session-start' ? null : `${sessionId}#0`,
        payload,
      },
      { stateDir },
    );
  }

  /** The starting lineage: a second task still open, and the gated task's uiux turns reported. */
  async function seed() {
    await append('session-start', undefined, {}, 'user');
    await append('task-added', OTHER_TASK, {
      epic_id: 'epic-a',
      task_status: 'todo',
      claims: ['src/other.ts'],
    });
    const opts = { stateDir };
    for (const kind of ['spec', 'visual'] as const) {
      if (kind === 'visual') {
        const home = path.join(artifactsDir, 'epic-a', 'task-1');
        await mkdir(home, { recursive: true });
        const shots = [
          ['home-desktop-light.png', 'desktop', 'light'],
          ['home-desktop-dark.png', 'desktop', 'dark'],
          ['home-mobile-light.png', 'mobile', 'light'],
          ['home-mobile-dark.png', 'mobile', 'dark'],
        ] as const;
        for (const [name] of shots) await writeFile(path.join(home, name), 'png-bytes');
        await append(
          'artifact-check-result',
          TASK,
          {
            ok: true,
            checked: 4,
            home,
            issues: [],
            head: git(['rev-parse', 'HEAD']),
            screenshots: shots.map(([name, viewport, theme]) => ({ path: name, viewport, theme })),
          },
          'tester',
        );
      }
      await recordJudgeDispatch(
        {
          taskId: TASK,
          role: 'uiux',
          round: 1,
          artifactPath: path.join(stateDir, `${kind}.json`),
          model: 'claude-opus-5',
          kind,
        },
        ctx(),
        opts,
      );
      await recordJudgeReport({ taskId: TASK, role: 'uiux', noFindings: true, kind }, ctx(), opts);
    }
  }

  /** A ui-affecting task whose uiux spec and visual turns are reported and fresh. */
  beforeEach(async () => {
    switches.withoutSnapshot = false;
    process.env[API_KEY_ENV] = 'sk-test-key';
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-'));
    worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-wt-'));
    artifactsDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-art-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n');
    git(['add', 'src.ts']);
    git(['commit', '-q', '-m', 'task work']);

    await seed();
  });

  afterEach(async () => {
    if (originalKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = originalKey;
    await rm(stateDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
    await rm(artifactsDir, { recursive: true, force: true });
  });

  function input(findingsInput: RaiseFindingInput[]): GateInput {
    return {
      taskId: TASK,
      result: {
        task_id: TASK,
        run_status: 'done',
        structured_output: {},
        artifacts: [],
        token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        agent: 'coder',
        provider: 'claude',
        model_tier: 'mid',
      },
      worktreeDir,
      checks: [{ name: 'test', cmd: 'true' }],
      findingsInput,
      lessons: [],
      artifactsDir,
      uiAffecting: true,
      ownership: [
        { task_id: TASK, claims: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`) },
        { task_id: OTHER_TASK, claims: ['src/other.ts'] },
      ],
    };
  }

  /** `count` findings, the first on a file another open task owns; the first `serious` of them are S2. */
  function findings(count: number, serious = 0): RaiseFindingInput[] {
    return Array.from({ length: count }, (_, i) => ({
      finding: draft(i, i < serious ? 'S2-major' : 'S3-minor'),
      filePath: i === 0 ? 'src/other.ts' : `src/f${i}.ts`,
    }));
  }

  const reads = () => vi.mocked(readLineageEvents);

  async function gate(
    findingsInput: RaiseFindingInput[],
    crosscheck?: GateInput['crosscheck'],
    opts: { stateDir: string } = { stateDir },
  ): Promise<{ outcome: GateOutcome; reads: number }> {
    reads().mockClear();
    const outcome = await runGate(
      { ...input(findingsInput), ...(crosscheck === undefined ? {} : { crosscheck }) },
      ctx(),
      opts,
    );
    return { outcome, reads: reads().mock.calls.length };
  }

  it('reads the lineage once for 1 finding and once for 10', async () => {
    const one = await gate(findings(1));
    expect(one.reads).toBe(1);
    const ten = await gate(findings(10));
    expect(ten.reads).toBe(1);
    console.log(`lineage reads: 1 finding -> ${one.reads}, 10 findings -> ${ten.reads}`);
  });

  it('reads the lineage once when a cross-check escalates 2 of 10 findings and no actor is named', async () => {
    const run = await gate(findings(10, 2), { policy: policy(), fetchImpl: confirmingFetch() });
    expect(run.outcome).toMatchObject({ outcome: 'blocked' });
    if (run.outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(run.outcome.quorumEscalations).toHaveLength(2);
    expect(run.reads).toBe(1);
    console.log(`lineage reads: 2 escalations among 10 findings -> ${run.reads}`);
  });

  it('gives the same outcome and events with and without the snapshot', async () => {
    const mixed: RaiseFindingInput[] = [
      ...findings(4, 1),
      { finding: draft(40, 'S2-major'), filePath: 'src/other.ts' },
      { finding: draft(41, 'S3-minor'), filePath: 'src/nobody.ts' },
    ];
    const crosscheck = { policy: policy(), fetchImpl: confirmingFetch() };

    async function observe() {
      const before = (await readEvents(sessionId, { stateDir })).length;
      const { outcome } = await gate(mixed, crosscheck);
      const events = (await readEvents(sessionId, { stateDir })).slice(before);
      const o = outcome as unknown as Record<string, unknown>;
      return {
        outcome: o.outcome,
        reason: o.reason,
        blocking: o.blockingFindings,
        pending: o.pendingFindings,
        escalations: o.quorumEscalations,
        reattributed: o.reattributedFindings,
        events: events.map((e) => [
          e.record.event_type,
          e.record.task_id,
          e.record.event_type.startsWith('finding-') ? e.record.payload : null,
        ]),
      };
    }

    switches.withoutSnapshot = true;
    const without = await observe();
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir, { recursive: true });
    // Rebuild the same starting lineage for the second run.
    switches.withoutSnapshot = false;
    await seed();
    const withSnapshot = await observe();

    expect(withSnapshot.events.length).toBeGreaterThan(5);
    expect(withSnapshot.reattributed).toHaveLength(3);
    expect(withSnapshot).toEqual(without);
  });

  it('shows an event appended mid-run to the next waiver check', async () => {
    const opts = { stateDir };
    const probe = draft(0, 'S3-minor');
    beginLineageRun(opts);
    try {
      // The first raise seeds the snapshot; its fingerprint is unwaived.
      const first = await raiseFinding({ finding: probe, filePath: 'src/f0.ts' }, ctx(), opts);
      if (first.suppressed) throw new Error('unreachable');
      const ref = { sessionId };
      expect(await isWaived(first.finding.fingerprint, ref, opts)).toBe(false);
      await grantWaiver(first.finding.fingerprint, 'accepted', { ...ctx(), actor: 'user' }, opts);
      expect(await isWaived(first.finding.fingerprint, ref, opts)).toBe(true);
      const again = await raiseFinding(
        { finding: { ...probe, finding_id: 'finding-0b' }, filePath: 'src/f0.ts' },
        ctx(),
        opts,
      );
      expect(again.suppressed).toBe(true);
    } finally {
      endLineageRun(opts);
    }
  });

  it('shares no snapshot between two runs in one process', async () => {
    const opts = { stateDir };
    beginLineageRun(opts);
    const firstView = await readLineage(sessionId, opts);
    endLineageRun(opts);
    // Written behind the first run's back, so only a fresh read can see it.
    await append('operator-note', undefined, { note: 'between runs' });

    reads().mockClear();
    beginLineageRun(opts);
    const secondView = await readLineage(sessionId, opts);
    endLineageRun(opts);
    expect(reads().mock.calls.length).toBe(1);
    expect(secondView.length).toBe(firstView.length + 1);

    // And with the same opts object through the gate, the second run starts afresh.
    const shared = { stateDir };
    const a = await gate(findings(1), undefined, shared);
    const b = await gate(findings(1), undefined, shared);
    expect(a.reads).toBe(1);
    expect(b.reads).toBe(1);
  });
});
