import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiProviderConfig,
  CliProviderConfig,
  CrosscheckPolicy,
  ProviderConfig,
} from '../src/crosscheck.js';
import type { TaskFoldRow } from '../src/db/projector.js';
import type { EpicPlanRoster, EpicTaskRow, IntegrationStatus } from '../src/epic.js';
import {
  closeEpic,
  EPIC_CLOSED_EVENT_TYPE,
  EpicCloseError,
  epicVerdictJudgeRequest,
  runEpicVerdict,
  summarizeEpic,
  withGateEvidence,
} from '../src/epic.js';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import {
  AMEND_PENDING_STATUS,
  AMENDED_STATUS,
  type Finding,
  type FindingDraft,
  listFindings,
  raiseFinding,
  repairObligation,
  transition,
} from '../src/findings.js';
import type { IntegrationCheckRecord } from '../src/integration.js';
import { MCP_SURFACE_NOT_REQUIRED, type McpSurfaceStatus } from '../src/mcp.js';
import type { SpecReviewStatus } from '../src/spec.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

// ---------------------------------------------------------------------------
// epic.ts is the third quorum_triggers host (crosscheck.yml): "epic-level
// final verdict, before the integration PR opens". Same cross-provider
// quorum harness as gate.test.ts's "Phase 8" describe block — copied
// deliberately rather than shared, since gate.ts's own fixtures are
// Finding-shaped and epic.ts's claim is epic-shaped.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_CLI = path.join(here, 'fixtures', 'fake-judge-cli.mjs');
const DEEPSEEK_KEY_ENV = 'TEST_DEEPSEEK_API_KEY';

function codexProvider(overrides: Partial<CliProviderConfig> = {}): CliProviderConfig {
  return {
    name: 'codex',
    kind: 'api',
    transport: 'cli',
    enabled: true,
    mode: 'shadow',
    modelTier: 'mid',
    command: 'node',
    args: [JUDGE_CLI, 'refute'],
    ...overrides,
  };
}

function deepseekProvider(overrides: Partial<ApiProviderConfig> = {}): ApiProviderConfig {
  return {
    name: 'deepseek',
    kind: 'api',
    transport: 'api',
    enabled: true,
    mode: 'shadow',
    modelTier: 'mid',
    baseUrl: 'https://api.example.test',
    model: 'test-model',
    apiKeyEnv: DEEPSEEK_KEY_ENV,
    responseFormatJsonObject: true,
    ...overrides,
  };
}

function policyWith(...externals: ProviderConfig[]): CrosscheckPolicy {
  return {
    ...crosscheckDefaults(),
    providers: {
      claude: { name: 'claude', kind: 'native', enabled: true },
      ...Object.fromEntries(externals.map((p) => [p.name, p])),
    },
    quorumRule: { agreement: '2-of-3', minProviders: 2 },
  };
}

function judgingFetch(verdict: 'confirm' | 'refute') {
  return vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ verdict, rationale: `deepseek: ${verdict}` }) },
            },
          ],
        }),
        { status: 200 },
      ),
  );
}

function taskRow(overrides: Partial<EpicTaskRow> = {}): EpicTaskRow {
  return {
    taskId: 'epic-1/task-1',
    sessionId: 'sess-epic',
    epicId: 'epic-1',
    caseTag: null,
    origin: null,
    taskStatus: 'completed',
    planVersion: 1,
    objective: null,
    claims: null,
    budgetTokens: null,
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    project: null,
    // D-138: the default is a task that really was gated — both events the
    // gate writes for the same task id. Tests about the missing-evidence
    // cases override it rather than the other way round, so every test that
    // is not about gate evidence keeps describing the case it was written for.
    gate: { gateOutcome: true, resultRecorded: true },
    ...overrides,
  };
}

function findingFixture(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'finding-1',
    task_id: 'epic-1/task-1',
    fingerprint: 'fp-1',
    // Required, and the fingerprint's first component — a fixture that omits
    // it is not a Finding the raise path could ever have produced.
    file_path: 'src/loop.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'fix-verified',
    summary: 'off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    found_by: 'reviewer',
    ...overrides,
  };
}

const HEAD_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';

function checkRecord(overrides: Partial<IntegrationCheckRecord> = {}): IntegrationCheckRecord {
  return {
    epicId: 'epic-1',
    branch: 'smith/epic-1/integration',
    headSha: HEAD_SHA,
    pass: true,
    results: [{ name: 'lint', pass: true, exitCode: 0, tail: '' }],
    eventId: 'sess-epic#7',
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A passing check covering the current head — the only shape that clears the gate. */
function okIntegration(): IntegrationStatus {
  return { check: checkRecord(), headSha: HEAD_SHA };
}

/** A closing spec review pinned to the current head — the P9-9 counterpart of okIntegration(). */
function okSpecReview(): SpecReviewStatus {
  return {
    review: {
      epicId: 'epic-1',
      planVersion: 1,
      headSha: HEAD_SHA,
      reviewedBy: 'spec-reviewer',
      findingIds: [],
      eventId: 'sess-epic#8',
      ts: '2026-01-01T00:00:00.000Z',
    },
    headSha: HEAD_SHA,
  };
}

/** The statuses that mean "done" to the epic gate, and so demand a gate run. */
const TERMINAL_OK = new Set(['completed', 'waived']);

/**
 * The two events `gate run` writes for the task it grades: the worker's Result
 * (gate.ts:893, before the gate rules on it) and the outcome it then rules.
 * Fixtures that record a task as terminal-OK have to write both — since D-138
 * the epic gate refuses a task claimed done that the log holds no gate run for.
 *
 * Emitted BEFORE the `task-added` that claims the status, deliberately: the
 * fold reads a passing `gate-outcome` as `merging`, and in a real log
 * `wave-merged` is what lands after it. Ordering the claim last keeps these
 * fixtures about what they were written to be about.
 */
async function addGateRun(taskId: string, sessionId: string, stateDir: string) {
  const envelope = {
    session_id: sessionId,
    task_id: taskId,
    plan_version: 1,
    causal_parent: `${sessionId}#0`,
  };
  await appendEvent(
    {
      ...envelope,
      actor: 'gate',
      event_type: 'task-result-recorded',
      payload: { task_id: taskId, status: 'done' },
    },
    { stateDir },
  );
  await appendEvent(
    {
      ...envelope,
      actor: 'gate',
      event_type: 'gate-outcome',
      payload: { outcome: 'pass', reason: null },
    },
    { stateDir },
  );
}

describe('epic.ts summarizeEpic (pure)', () => {
  it('is not mechanically ready when a task has not reached a terminal-OK status', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'in-progress' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.nonTerminalTaskCount).toBe(1);
    expect(summary.blockers.some((b) => b.includes('epic-1/task-1'))).toBe(true);
  });

  it('is not mechanically ready when a finding is still open', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [findingFixture({ finding_status: 'confirmed' })],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.openFindings).toHaveLength(1);
    expect(summary.blockers.some((b) => b.includes('finding-1'))).toBe(true);
  });

  it('is not mechanically ready when the epic has no tasks at all', () => {
    const summary = summarizeEpic(
      'epic-typo',
      [],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('no tasks'))).toBe(true);
  });

  // D-135. A `finding-raised` record the fold could not parse is a finding of
  // unknown status: it may well be the one open S1 that should have held this
  // epic. Counting it as "not open" is the same mistake as counting an
  // undispatched task as done — absence read as a yes. The epic holds until a
  // human has looked at the record.
  it('holds when the fold had to quarantine a finding-raised record', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      null,
      [{ event_id: 'sess-1#7', reason: 'missing required string field(s): task_id' }],
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('sess-1#7'))).toBe(true);
  });

  it('is unaffected when nothing was quarantined', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      null,
      [],
    );
    expect(summary.mechanicallyReady).toBe(true);
  });

  it('is mechanically ready when every task is terminal-OK and no finding is open', () => {
    const summary = summarizeEpic(
      'epic-1',
      [
        taskRow({ taskStatus: 'completed' }),
        taskRow({ taskId: 'epic-1/task-2', taskStatus: 'waived' }),
      ],
      [findingFixture({ finding_status: 'fix-verified' })],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(true);
    expect(summary.blockers).toHaveLength(0);
  });
});

// D-138. `envkit-mcp-followup` closed `ship` with three of its four tasks
// carrying a hand-written `gate-outcome` and nothing behind it — the session
// holds exactly one `task-result-recorded`, for the one task that was in fact
// replayed through `gate run`. Validating the gate-outcome PAYLOAD would not
// have caught it: a real one is only `{outcome, reason}`, which is trivially
// typed by hand. The tell is the companion event. `gate run` records the
// worker's Result for the same task id before it rules (gate.ts:893) and then
// emits the outcome, so a `gate-outcome` standing alone is hand-authored by
// construction. This is the move D-126 made for plan rosters, applied to the
// gate record itself: stop accepting a claim where evidence is contractually
// required.
describe('epic.ts summarizeEpic — gate evidence (D-138)', () => {
  it('holds when a completed task has a gate-outcome with nothing recorded behind it', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ gate: { gateOutcome: true, resultRecorded: false } })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    const blocker = summary.blockers.find((b) => b.includes('epic-1/task-1'));
    expect(blocker).toContain('task-result-recorded');
  });

  it('holds when a completed task has no gate record at all', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ gate: { gateOutcome: false, resultRecorded: false } })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    const blocker = summary.blockers.find((b) => b.includes('epic-1/task-1'));
    expect(blocker).toContain('gate-outcome');
  });

  it('names every ungated task, not just the first', () => {
    const summary = summarizeEpic(
      'epic-1',
      [
        taskRow({ gate: { gateOutcome: true, resultRecorded: false } }),
        taskRow({ taskId: 'epic-1/task-2' }),
        taskRow({ taskId: 'epic-1/task-3', gate: { gateOutcome: false, resultRecorded: false } }),
      ],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.ungatedTasks.map((t) => t.taskId)).toEqual(['epic-1/task-1', 'epic-1/task-3']);
    expect(summary.blockers.some((b) => b.includes('epic-1/task-2'))).toBe(false);
  });

  // A task that has not reached terminal-OK already blocks for that reason,
  // and it is not expected to have been gated yet. Repeating it as a missing-
  // evidence blocker would make the in-flight case read as a forged one.
  it('says nothing about a task that has not reached terminal-OK yet', () => {
    const summary = summarizeEpic(
      'epic-1',
      [
        taskRow({
          taskStatus: 'in-progress',
          gate: { gateOutcome: false, resultRecorded: false },
        }),
      ],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.ungatedTasks).toHaveLength(0);
    expect(summary.blockers).toHaveLength(1);
    expect(summary.blockers[0]).toContain('not terminal-OK');
  });

  it('is ready when every terminal-OK task carries both events', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow(), taskRow({ taskId: 'epic-1/task-2', taskStatus: 'waived' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.ungatedTasks).toHaveLength(0);
    expect(summary.mechanicallyReady).toBe(true);
  });
});

describe('epic.ts withGateEvidence (D-138)', () => {
  const ev = (eventType: string, taskId: string): StoredEvent => ({
    event_id: `sess-1#${eventType}-${taskId}`,
    record: {
      session_id: 'sess-1',
      actor: 'gate',
      event_type: eventType,
      task_id: taskId,
      plan_version: 1,
      causal_parent: 'sess-1#0',
      payload: {},
      ts: '2026-01-01T00:00:00.000Z',
    },
  });

  /** foldTasks() output carries no gate evidence — that is what this adds. */
  const bareRow = (taskId: string): TaskFoldRow => {
    const { gate: _gate, ...row } = taskRow({ taskId });
    return row;
  };

  it('credits a row with the gate run written for the same task', () => {
    const [row] = withGateEvidence(
      [bareRow('epic-1/task-1')],
      [ev('gate-outcome', 'epic-1/task-1'), ev('task-result-recorded', 'epic-1/task-1')],
      'epic-1',
    );
    expect(row?.gate).toEqual({ gateOutcome: true, resultRecorded: true });
  });

  it('reports a gate-outcome standing alone as exactly that', () => {
    const [row] = withGateEvidence(
      [bareRow('epic-1/task-1')],
      [ev('gate-outcome', 'epic-1/task-1')],
      'epic-1',
    );
    expect(row?.gate).toEqual({ gateOutcome: true, resultRecorded: false });
  });

  it('does not credit a row with a gate run belonging to another task', () => {
    const [row] = withGateEvidence(
      [bareRow('epic-1/task-1')],
      [ev('gate-outcome', 'epic-1/task-2'), ev('task-result-recorded', 'epic-1/task-2')],
      'epic-1',
    );
    expect(row?.gate).toEqual({ gateOutcome: false, resultRecorded: false });
  });

  // Both registers spell ids either way (D-46/P9-29): the fold row can carry
  // the bare id while the gate stamped the qualified one. Comparing raw would
  // read every such task as ungated.
  it('matches ids bare, so a qualified event and a bare row are the same task', () => {
    const [row] = withGateEvidence(
      [bareRow('task-1')],
      [ev('gate-outcome', 'epic-1/task-1'), ev('task-result-recorded', 'epic-1/task-1')],
      'epic-1',
    );
    expect(row?.gate).toEqual({ gateOutcome: true, resultRecorded: true });
  });
});

// D-127 Part B: amendPlan() no longer discharges a cited spec finding straight
// to `amended` — it parks it at `amend-pending`, naming the task ids the
// amendment made its discharge condition. Without this block the gate never
// learns that: `amend-pending` sat outside OPEN_FINDING_STATUSES entirely, so
// an epic could close over a finding sitting on the amendment path with
// nothing landed, and nobody would ever see a blocker for it.
describe('epic.ts summarizeEpic — the amendment path (D-127 Part B)', () => {
  function amendPendingFinding(overrides: Partial<Finding> = {}): Finding {
    return findingFixture({
      finding_status: 'amend-pending',
      finding_scope: 'spec',
      amends_task_ids: ['epic-1/task-2'],
      amends_plan_version: 2,
      ...overrides,
    });
  }

  it('is not mechanically ready when an amend-pending finding names a task that has not landed', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [amendPendingFinding()],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.openFindings).toHaveLength(1);
    expect(summary.satisfiedAmendments).toHaveLength(0);
    expect(summary.blockers.some((b) => b.includes('epic-1/task-2'))).toBe(true);
  });

  it('is mechanically ready when the amendment obligation has landed terminal-OK at the cited plan version', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
      [amendPendingFinding()],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(true);
    expect(summary.openFindings).toHaveLength(0);
    expect(summary.satisfiedAmendments).toHaveLength(1);
    expect(summary.satisfiedAmendments[0]?.findingId).toBe('finding-1');
  });

  // D-21 Part 4. summarizeEpic applies the latest finding-obligation-repaired
  // event before evaluating a finding's obligation (findings.ts's own fold),
  // so by the time a Finding reaches here amends_task_ids is already the
  // REPAIRED list -- but a clean discharge must still say so. Without this, a
  // reader sees an ordinary satisfied amendment and has no way to learn the
  // obligation it rested on was corrected, which is the exact difference
  // between an auditable repair and quietly dropping a null from an S2
  // finding severity.yml says can never be waived.
  it('surfaces that a discharged amendment rested on a repaired obligation, carrying the reason', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
      [
        amendPendingFinding({
          obligation_repair_reason:
            'dropped a null entry written by a malformed plan amend; the real obligation is unaffected',
        }),
      ],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.satisfiedAmendments).toHaveLength(1);
    expect(summary.satisfiedAmendments[0]?.repairedObligationReason).toBe(
      'dropped a null entry written by a malformed plan amend; the real obligation is unaffected',
    );
  });

  // Regression: a finding with no repair event must behave byte-identically
  // to before this feature existed -- no repairedObligationReason key at all,
  // not merely an undefined value a reader could still be misled by.
  it('carries no repaired-obligation note when the finding was never repaired', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
      [amendPendingFinding()],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.satisfiedAmendments).toHaveLength(1);
    expect(summary.satisfiedAmendments[0]).not.toHaveProperty('repairedObligationReason');
  });

  it('does not satisfy the amendment when the landed row is stuck at an older plan version', () => {
    // amends_plan_version: 2 names the version the amendment cut; a task that
    // completed against v1 (before the amendment existed) proves nothing
    // about the amended plan, even though its own status is terminal-OK.
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 1 })],
      [amendPendingFinding()],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.satisfiedAmendments).toHaveLength(0);
    expect(summary.blockers.some((b) => b.includes('epic-1/task-2'))).toBe(true);
  });

  it('compares amends_task_ids against fold rows bare, regardless of which side is epic-qualified (D-46/P9-29)', () => {
    const summary = summarizeEpic(
      'epic-1',
      // Fold row spelled bare; amends_task_ids spelled epic-qualified (the
      // default fixture value, 'epic-1/task-2').
      [taskRow({ taskId: 'task-2', taskStatus: 'completed', planVersion: 2 })],
      [amendPendingFinding()],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(true);
    expect(summary.satisfiedAmendments).toHaveLength(1);
  });

  it('can never satisfy an amend-pending finding that names no task ids', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
      [amendPendingFinding({ amends_task_ids: [] })],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.satisfiedAmendments).toHaveLength(0);
    expect(summary.blockers.some((b) => b.includes('names no task ids'))).toBe(true);
  });

  // D-21: a malformed amendment can write a non-string entry into
  // amends_task_ids -- the real incident found `[null,
  // "demo-rpg-reading-interface/task-5-reader-memory"]` after an operator
  // passed `supersede` as an array instead of a map. `bareTaskId(epicId,
  // null)` calls `.startsWith` on it, and before this fix that crashed
  // `smith epic verdict` and `smith epic close` outright, rendering nothing.
  it('does not throw on a null obligation id, and reports a blocker naming the finding and the bad type', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
      [
        amendPendingFinding({
          amends_task_ids: [null, 'epic-1/task-2'] as unknown as string[],
        }),
      ],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    // Never silently discharged: the well-formed id in the same list landed,
    // but the malformed sibling must still block the finding.
    expect(summary.satisfiedAmendments).toHaveLength(0);
    expect(summary.blockers.some((b) => b.includes('finding-1'))).toBe(true);
    expect(summary.blockers.some((b) => b.includes('null'))).toBe(true);
  });

  // D-21 Part 4 review finding (S3 behavioral-drift): repairObligation's guard
  // 1 calls "" corrupt (isNonEmptyString), but this filter used typeof alone,
  // so "" read as well-formed here -- landing bareTaskId(epicId, "") = "" ,
  // which no real task id ever bares to. The empty id then sat outstanding
  // FOREVER (never malformed, never landed, never repairable-by-suggestion),
  // and the blocker read "waiting on  to land terminal-OK..." with a literal
  // double space where the id should have been -- never pointing the operator
  // at the repair verb at all.
  it('does not let an empty-string obligation id sit outstanding forever, and names it as malformed', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
      [amendPendingFinding({ amends_task_ids: [''] })],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.satisfiedAmendments).toHaveLength(0);
    expect(summary.blockers.some((b) => b.includes('finding-1'))).toBe(true);
    expect(summary.blockers.some((b) => b.includes('empty string'))).toBe(true);
    // The double-space bug must never resurface.
    expect(summary.blockers.some((b) => b.includes('waiting on  to land'))).toBe(false);
  });

  it('still evaluates the well-formed ids in the same list normally (still-outstanding case)', () => {
    const summary = summarizeEpic(
      'epic-1',
      // task-2 not landed at all -- the well-formed id is genuinely outstanding.
      [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'todo', planVersion: 1 })],
      [
        amendPendingFinding({
          amends_task_ids: [null, 'epic-1/task-2'] as unknown as string[],
        }),
      ],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.satisfiedAmendments).toHaveLength(0);
    expect(summary.blockers.some((b) => b.includes('epic-1/task-2'))).toBe(true);
  });

  // Regression guard: a multi-task, multi-finding epic with NO malformed
  // obligation anywhere in it must fold exactly as before -- every task and
  // every finding present and accounted for. The malformed-entry guard above
  // lives inside one branch of one loop iteration (the amend-pending case for
  // one finding); this pins that the surrounding fold -- tasks, other
  // findings, discretionary findings -- is untouched by it.
  it('folds every task and every finding for a clean epic with no malformed obligation at all', () => {
    const summary = summarizeEpic(
      'epic-1',
      [
        taskRow({ taskId: 'epic-1/task-1', taskStatus: 'completed' }),
        taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed' }),
        taskRow({ taskId: 'epic-1/task-3', taskStatus: 'completed' }),
      ],
      [
        findingFixture({ finding_id: 'finding-a', finding_status: 'fix-verified' }),
        findingFixture({
          finding_id: 'finding-b',
          finding_status: 'raised',
          severity: 'S3-minor',
        }),
      ],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.tasks.map((t) => t.taskId)).toEqual([
      'epic-1/task-1',
      'epic-1/task-2',
      'epic-1/task-3',
    ]);
    expect(summary.openFindings.map((f) => f.findingId)).toEqual(['finding-b']);
    expect(summary.blockers.some((b) => b.includes('finding-b'))).toBe(true);
  });
});

// D-42/P9-26: an epic whose six per-task gates are all green has demonstrated
// six things about six worktrees and nothing at all about the branch that
// actually ships. These four blockers are the difference.
describe('epic.ts summarizeEpic — integration-root check (D-42/P9-26)', () => {
  const readyTasks = [taskRow({ taskStatus: 'completed' })];

  it('blocks when no integration-root check has ever run', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      { check: null, headSha: HEAD_SHA },
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('no integration-root check'))).toBe(true);
  });

  it('blocks when the recorded check failed, naming the checks that failed', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      {
        check: checkRecord({
          pass: false,
          results: [
            { name: 'lint', pass: false, exitCode: 1, tail: 'nested root config' },
            { name: 'test', pass: true, exitCode: 0, tail: '' },
          ],
        }),
        headSha: HEAD_SHA,
      },
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('lint'))).toBe(true);
  });

  // A check pinned to a sha certifies that sha and nothing after it. A merge
  // landing after the check is exactly how a green record outlives its truth.
  it('blocks when the check ran against an older head than the branch is at now', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      {
        check: checkRecord({ headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        headSha: HEAD_SHA,
      },
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.toLowerCase().includes('stale'))).toBe(true);
  });

  // Unknown head means the recorded check cannot be shown to cover anything.
  it('blocks when the current integration head could not be read', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      {
        check: checkRecord(),
        headSha: null,
      },
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('smith/epic-1/integration'))).toBe(true);
  });
});

// D-126: the roster came from the event log alone. A task the plan added and
// nobody dispatched emitted no events, contributed no fold row, and so was not
// counted as unfinished — it was not counted at all. `envkit-mcp-surface`
// closed with a four-task roster while its live plan held five, and the fifth
// was the one fixing a real leak. The plan file now has a vote.
describe('epic.ts summarizeEpic — the plan roster (D-126)', () => {
  function roster(tasks: { taskId: string; taskStatus: string }[], version = 1): EpicPlanRoster {
    return { version, tasks };
  }

  it('blocks on a task the live plan claims and the log has never seen', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      roster(
        [
          { taskId: 'epic-1/task-1', taskStatus: 'todo' },
          { taskId: 'epic-1/task-2', taskStatus: 'todo' },
        ],
        5,
      ),
    );

    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.undispatchedTasks.map((t) => t.taskId)).toEqual(['epic-1/task-2']);
    expect(summary.planVersion).toBe(5);
    // Counted as unfinished, not merely listed: the judge prompt and the
    // closed record both read this number.
    expect(summary.nonTerminalTaskCount).toBe(1);
    expect(summary.blockers.some((b) => b.includes('epic-1/task-2') && b.includes('v5'))).toBe(
      true,
    );
  });

  // The plan file is operator-writable; the log is hash-chained. A plan row
  // asserting its own completion with nothing in the log behind it is a claim,
  // not evidence.
  it('blocks an undispatched task even when the plan record calls it completed', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      roster([
        { taskId: 'epic-1/task-1', taskStatus: 'completed' },
        { taskId: 'epic-1/task-2', taskStatus: 'completed' },
      ]),
    );

    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.undispatchedTasks.map((t) => t.taskId)).toEqual(['epic-1/task-2']);
  });

  // D-46/P9-29 again, from the other side: the plan may hold a qualified id
  // where the log holds a bare one. Matching on the raw string would report
  // every task in the epic as undispatched.
  it('matches a planned id against its bare spelling in the log', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskId: 'task-1', taskStatus: 'completed' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      roster([{ taskId: 'epic-1/task-1', taskStatus: 'todo' }]),
    );

    expect(summary.undispatchedTasks).toEqual([]);
    expect(summary.mechanicallyReady).toBe(true);
  });

  it('is ready when every planned task has a terminal-OK row in the log', () => {
    const summary = summarizeEpic(
      'epic-1',
      [
        taskRow({ taskStatus: 'completed' }),
        taskRow({ taskId: 'epic-1/task-2', taskStatus: 'waived' }),
      ],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      roster([
        { taskId: 'epic-1/task-1', taskStatus: 'todo' },
        { taskId: 'epic-1/task-2', taskStatus: 'todo' },
      ]),
    );

    expect(summary.blockers).toEqual([]);
    expect(summary.mechanicallyReady).toBe(true);
    expect(summary.nonTerminalTaskCount).toBe(0);
  });

  // Epics driven as branch work rather than from a plan file (the whole of
  // Phase 9) have no plan to consult. That is recorded as `planVersion: null`
  // in the summary and the closed record, not silently treated as agreement.
  it('records that no plan was consulted rather than inventing one', () => {
    const summary = summarizeEpic(
      'epic-1',
      [taskRow({ taskStatus: 'completed' })],
      [],
      okIntegration(),
      MCP_SURFACE_NOT_REQUIRED,
      okSpecReview(),
      null,
    );

    expect(summary.planVersion).toBeNull();
    expect(summary.undispatchedTasks).toEqual([]);
    expect(summary.mechanicallyReady).toBe(true);
  });
});

describe('epic.ts runEpicVerdict (Phase 8, epic-final-verdict quorum trigger)', () => {
  let stateDir: string;
  const sessionId = 'sess-epic-verdict';
  const epicId = 'epic-1';
  const originalKey = process.env[DEEPSEEK_KEY_ENV];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-q-'));
    process.env[DEEPSEEK_KEY_ENV] = 'sk-test-key';
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    if (originalKey === undefined) delete process.env[DEEPSEEK_KEY_ENV];
    else process.env[DEEPSEEK_KEY_ENV] = originalKey;
    await rm(stateDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  async function addTask(taskId: string, status: string) {
    if (TERMINAL_OK.has(status)) await addGateRun(taskId, sessionId, stateDir);
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'planner',
        event_type: 'task-added',
        task_id: taskId,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: { epic_id: epicId, task_status: status },
      },
      { stateDir },
    );
  }

  /** The integration-root check the epic gate now requires (D-42/P9-26). */
  async function addIntegrationCheck(pass = true, headSha = HEAD_SHA) {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'operator',
        event_type: 'integration-check',
        task_id: `${epicId}/integration`,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          epic_id: epicId,
          branch: `smith/${epicId}/integration`,
          head_sha: headSha,
          pass,
          results: [{ name: 'lint', pass, exitCode: pass ? 0 : 1, tail: '' }],
        },
      },
      { stateDir },
    );
  }

  /** The closing spec review the epic gate now requires (P9-9/D-33). */
  async function addSpecReview(headSha = HEAD_SHA) {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'spec-reviewer',
        event_type: 'spec-review-recorded',
        task_id: `${epicId}/integration`,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          epic_id: epicId,
          plan_version: 1,
          head_sha: headSha,
          reviewed_by: 'spec-reviewer',
          finding_ids: [],
          finding_count: 0,
        },
      },
      { stateDir },
    );
  }

  async function quorumEvents() {
    const events = await readEvents(sessionId, { stateDir });
    return {
      all: events,
      quorum: events.filter((e) => e.record.event_type === 'quorum-decision'),
      verdicts: events.filter((e) => e.record.event_type === 'judge-verdict'),
      dispatches: events.filter((e) => e.record.event_type === 'dispatch_decision'),
    };
  }

  it('holds with mechanical-blockers and appends zero events when a task is not terminal-OK', async () => {
    await addTask('epic-1/task-1', 'in-progress');
    // Present and passing, so the only thing left to block on is the task.
    await addIntegrationCheck();
    await addSpecReview();
    const before = await readEvents(sessionId, { stateDir });

    const outcome = await runEpicVerdict(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      {
        stateDir,
      },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.reason).toBe('mechanical-blockers');
    const after = await readEvents(sessionId, { stateDir });
    expect(after).toHaveLength(before.length);
  });

  // D-138, end to end and in the exact shape that shipped: a task the log
  // records as completed, a `gate-outcome` typed by hand beside it, and no
  // `task-result-recorded` anywhere in the session. `envkit-mcp-followup`
  // closed `ship` on three of these.
  it('holds when a completed task carries a gate-outcome with no result behind it', async () => {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'operator',
        event_type: 'gate-outcome',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: { outcome: 'pass', reason: null },
      },
      { stateDir },
    );
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'planner',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: { epic_id: epicId, task_status: 'completed' },
      },
      { stateDir },
    );
    await addIntegrationCheck();
    await addSpecReview();
    const before = await readEvents(sessionId, { stateDir });

    const outcome = await runEpicVerdict(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.reason).toBe('mechanical-blockers');
    expect(outcome.summary.ungatedTasks.map((t) => t.taskId)).toEqual(['epic-1/task-1']);
    const after = await readEvents(sessionId, { stateDir });
    expect(after).toHaveLength(before.length);
  });

  // D-49/P9-10: membership came from `taskId.startsWith("epic-1/")`, so a task
  // whose event carried the epic in its payload rather than in its id was
  // invisible — and an epic with real work read "no tasks in the event log".
  it('counts a task whose epic is carried in the event payload, not in its id', async () => {
    await addTask('task-1', 'completed');
    await addIntegrationCheck();
    // P9-9/D-33 landed the closing-spec-review blocker on a parallel branch:
    // this test is about membership, so it clears that blocker rather than
    // asserting around it.
    await addSpecReview();

    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        crosscheck: { policy: policyWith() },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.summary.blockers).toEqual([]);
    expect(outcome.summary.tasks).toHaveLength(1);
    expect(outcome.outcome).toBe('go');
  });

  it('goes with zero judge events when mechanically ready and no external provider is enabled (zero-cost default)', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck();
    await addSpecReview();

    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        crosscheck: { policy: policyWith() },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('go');
    const { quorum, verdicts } = await quorumEvents();
    expect(quorum).toHaveLength(0);
    expect(verdicts).toHaveLength(0);
  });

  // D-126, end to end: this is `envkit-mcp-surface` in miniature. Plan v2 adds
  // task-2; nothing ever dispatches it; the log holds only a completed task-1.
  // Before the fix this returned `go` on a one-task roster.
  it('holds when the live plan claims a task the log has never seen', async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-plan-'));
    try {
      await mkdir(path.join(specsDir, epicId), { recursive: true });
      await writeFile(
        path.join(specsDir, epicId, 'plan-v2.json'),
        JSON.stringify({
          epic_id: epicId,
          version: 2,
          status: 'active',
          edges: [],
          tasks: [
            { task_id: `${epicId}/task-1`, task_status: 'completed' },
            { task_id: `${epicId}/task-2`, task_status: 'todo' },
          ],
        }),
        'utf8',
      );
      await addTask('epic-1/task-1', 'completed');
      await addIntegrationCheck();
      await addSpecReview();
      const before = await readEvents(sessionId, { stateDir });

      const outcome = await runEpicVerdict(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: MCP_SURFACE_NOT_REQUIRED,
          crosscheck: { policy: policyWith() },
          planOpts: { specsDir },
        },
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('hold');
      if (outcome.outcome !== 'hold') throw new Error('unreachable');
      expect(outcome.reason).toBe('mechanical-blockers');
      expect(outcome.summary.planVersion).toBe(2);
      expect(outcome.summary.undispatchedTasks.map((t) => t.taskId)).toEqual([`${epicId}/task-2`]);
      // A hold is a read, not a write.
      expect(await readEvents(sessionId, { stateDir })).toHaveLength(before.length);
    } finally {
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  // The counterpart: an epic driven as branch work has no plan directory, and
  // that must stay a `go` rather than becoming an unclearable blocker. Every
  // Phase 9 epic is in this shape.
  it('goes when the epic has no plan directory at all', async () => {
    const specsDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-noplan-'));
    try {
      await addTask('epic-1/task-1', 'completed');
      await addIntegrationCheck();
      await addSpecReview();

      const outcome = await runEpicVerdict(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: MCP_SURFACE_NOT_REQUIRED,
          crosscheck: { policy: policyWith() },
          planOpts: { specsDir },
        },
        ctx(),
        { stateDir },
      );

      expect(outcome.summary.blockers).toEqual([]);
      expect(outcome.summary.planVersion).toBeNull();
      expect(outcome.outcome).toBe('go');
    } finally {
      await rm(specsDir, { recursive: true, force: true });
    }
  });

  it('holds when two active externals both refute epic readiness', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck();
    await addSpecReview();
    const fetchMock = judgingFetch('refute');

    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active' }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.reason).toBe('quorum-refuted');
    const { quorum } = await quorumEvents();
    expect(quorum).toHaveLength(1);
    expect(quorum[0]?.record.payload).toMatchObject({ outcome: 'decided', decision: 'refute' });
  });

  it('goes when two active externals both confirm epic readiness', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck();
    await addSpecReview();
    const fetchMock = judgingFetch('confirm');

    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active', args: [JUDGE_CLI, 'success'] }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('go');
    const { quorum } = await quorumEvents();
    expect(quorum[0]?.record.payload).toMatchObject({ outcome: 'decided', decision: 'confirm' });
  });

  it('holds with insufficient-providers when exactly one active external ran (fail-closed, §4)', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck();
    await addSpecReview();

    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.reason).toBe('insufficient-providers');
    const { quorum } = await quorumEvents();
    expect(quorum[0]?.record.payload).toMatchObject({
      outcome: 'escalate',
      escalation_reason: 'insufficient-providers',
    });
  });

  it('goes with a shadow-only external, but still records its judge-verdict', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck();
    await addSpecReview();

    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        crosscheck: { policy: policyWith(codexProvider({ mode: 'shadow' })) },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('go');
    const { verdicts, quorum } = await quorumEvents();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.record.payload).toMatchObject({ provider: 'codex', mode: 'shadow' });
    expect(quorum).toHaveLength(1);
  });

  // The dogfood epic's actual state at close: every task completed, no open
  // finding, no command ever run against the assembled branch. It reached a
  // ship verdict. It must not be able to again.
  it('holds when every task is done but no integration-root check was ever recorded', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addSpecReview();

    const outcome = await runEpicVerdict(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      {
        stateDir,
      },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.reason).toBe('mechanical-blockers');
    expect(outcome.summary.blockers.some((b) => b.includes('no integration-root check'))).toBe(
      true,
    );
    const { quorum, verdicts } = await quorumEvents();
    expect(quorum).toHaveLength(0);
    expect(verdicts).toHaveLength(0);
  });

  it('holds when the recorded check covers an older head than the branch is at now', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck(true, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await addSpecReview();

    const outcome = await runEpicVerdict(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      {
        stateDir,
      },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.summary.blockers.some((b) => b.toLowerCase().includes('stale'))).toBe(true);
  });

  it('holds when the recorded integration-root check failed', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addIntegrationCheck(false);
    await addSpecReview();

    const outcome = await runEpicVerdict(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      {
        stateDir,
      },
    );

    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.summary.blockers.some((b) => b.includes('lint'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-43/P9-27. runEpicVerdict is a read-only probe by design, and in the
// zero-cost default config BOTH of its terminal outcomes append nothing: the
// dogfood epic was declared shippable, overridden by a human, merged and
// tagged, and the event log recorded none of it. `smith epic close` is the
// verb that makes the close a fact. The probe stays free; recording costs an
// event, on purpose.
// ---------------------------------------------------------------------------
describe('epic.ts closeEpic (D-43/P9-27)', () => {
  let stateDir: string;
  const sessionId = 'sess-epic-close';
  const epicId = 'epic-1';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-close-'));
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  async function addTask(taskId: string, status: string, planVersion?: number) {
    if (TERMINAL_OK.has(status)) await addGateRun(taskId, sessionId, stateDir);
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'planner',
        event_type: 'task-added',
        task_id: taskId,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          epic_id: epicId,
          task_status: status,
          // foldTasks() reads planVersion from the payload, not the event
          // envelope's own plan_version — leaving this unset (as every
          // pre-D-127 caller here does) leaves row.planVersion null.
          ...(planVersion === undefined ? {} : { plan_version: planVersion }),
        },
      },
      { stateDir },
    );
  }

  async function addIntegrationCheck(pass = true) {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'operator',
        event_type: 'integration-check',
        task_id: `${epicId}/integration`,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          epic_id: epicId,
          branch: `smith/${epicId}/integration`,
          head_sha: HEAD_SHA,
          pass,
          results: [{ name: 'lint', pass, exitCode: pass ? 0 : 1, tail: '' }],
        },
      },
      { stateDir },
    );
  }

  /** The closing spec review the epic gate now requires (P9-9/D-33). */
  async function addSpecReview() {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'spec-reviewer',
        event_type: 'spec-review-recorded',
        task_id: `${epicId}/integration`,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          epic_id: epicId,
          plan_version: 1,
          head_sha: HEAD_SHA,
          reviewed_by: 'spec-reviewer',
          finding_ids: [],
          finding_count: 0,
        },
      },
      { stateDir },
    );
  }

  async function closedEvents() {
    const events = await readEvents(sessionId, { stateDir });
    return events.filter((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
  }

  /** A ready epic closes on the machine's own say-so — no human in the loop. */
  it('records an epic-closed event carrying the verdict and the summary it was computed from', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addTask('epic-1/task-2', 'waived');
    await addIntegrationCheck();
    await addSpecReview();

    const record = await closeEpic(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      { stateDir },
    );

    expect(record.closedBy).toBe('verdict');
    expect(record.machineVerdict).toBe('go');
    expect(record.blockers).toEqual([]);

    const closed = await closedEvents();
    expect(closed).toHaveLength(1);
    const event = closed[0]?.record;
    // <epic>/integration, not <epic>/epic: an unreserved suffix escapes
    // foldTasks()'s isReservedRef guard and mints a phantom task row (D-44).
    expect(event?.task_id).toBe(`${epicId}/integration`);
    expect(record.eventId).toBe(closed[0]?.event_id);

    const payload = event?.payload as Record<string, unknown>;
    expect(payload.epic_id).toBe(epicId);
    expect(payload.closed_by).toBe('verdict');
    expect(payload.machine_verdict).toBe('go');
    expect(payload.machine_reason).toBe(null);
    expect(payload.override_rationale).toBe(null);
    expect(payload.blockers).toEqual([]);

    // "the summary it was computed from" — the tasks and their statuses, not a
    // bare verdict word an operator has to take on faith.
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.mechanically_ready).toBe(true);
    expect(summary.non_terminal_task_count).toBe(0);
    expect(summary.tasks).toEqual([
      { task_id: 'epic-1/task-1', task_status: 'completed' },
      { task_id: 'epic-1/task-2', task_status: 'waived' },
    ]);
    expect((summary.integration as Record<string, unknown>).head_sha).toBe(HEAD_SHA);
  });

  // D-120 gives the judge every closure a person decided rather than earned —
  // the waived tasks, the findings closed by waiver or amendment, the ungated
  // terminal-OK rows, the surface verdict. The judge sees it and is gone. The
  // epic-closed event is the only reader left afterwards, and it kept none of
  // it, so "was this epic closed on waivers?" was answerable for the length of
  // one prompt and unanswerable forever after. Projected even when empty, for
  // the reason the D-126 comment beside plan_version already gives: an absent
  // key reads as an older event rather than as nothing to report.
  it('keeps the discretionary closures the judge was shown, so the close stays answerable', async () => {
    await addTask('epic-1/task-1', 'completed');
    await addTask('epic-1/task-2', 'waived');
    await addIntegrationCheck();
    await addSpecReview();
    await raiseFinding(
      {
        finding: {
          finding_id: 'finding-minor',
          task_id: 'epic-1/task-1',
          finding_category: 'maintainability',
          // S3 is the severity a waiver can close at all (severity.yml
          // waiver_semantics); transition() refuses `-> waived` above it.
          severity: 'S3-minor',
          finding_status: 'raised',
          finding_scope: 'diff',
          summary: 'names the local `t` where the file spells it `task`',
          failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
          found_by: 'reviewer',
        },
        filePath: 'src/foo.ts',
      },
      ctx(),
      { stateDir },
    );
    await transition('finding-minor', 'waived', ctx(), { stateDir });

    const record = await closeEpic(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
      ctx(),
      { stateDir },
    );
    expect(record.machineVerdict).toBe('go');

    const closed = await closedEvents();
    const payload = closed[0]?.record.payload as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;

    expect(summary.waived_tasks).toEqual([{ task_id: 'epic-1/task-2', task_status: 'waived' }]);
    expect(summary.discretionary_findings).toEqual([
      {
        finding_id: 'finding-minor',
        task_id: 'epic-1/task-1',
        severity: 'S3-minor',
        finding_status: 'waived',
        summary: 'names the local `t` where the file spells it `task`',
      },
    ]);
    // Empty, and said so: every task here was gated, and that is a fact about
    // this close worth recording rather than an absence to be inferred.
    expect(summary.ungated_tasks).toEqual([]);
    expect(summary.mcp).toEqual({
      required: false,
      milestone_id: null,
      manifest_path: null,
      problem: null,
      check: null,
    });
  });

  it('refuses to close a held epic without an override rationale, and appends nothing', async () => {
    await addTask('epic-1/task-1', 'in-progress');
    await addIntegrationCheck();
    await addSpecReview();
    const before = await readEvents(sessionId, { stateDir });

    await expect(
      closeEpic({ epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED }, ctx(), {
        stateDir,
      }),
    ).rejects.toThrow(EpicCloseError);

    const after = await readEvents(sessionId, { stateDir });
    expect(after).toHaveLength(before.length);
  });

  it('names the blockers it is refusing over', async () => {
    await addTask('epic-1/task-1', 'in-progress');
    await addIntegrationCheck();
    await addSpecReview();

    await expect(
      closeEpic({ epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED }, ctx(), {
        stateDir,
      }),
    ).rejects.toThrow(/epic-1\/task-1/);
  });

  // The dogfood close itself: a human looked at the blockers and shipped
  // anyway. That is legitimate and must stay possible — what must not stay
  // possible is doing it silently.
  it('records an operator override with the machine verdict and the blockers it overrode', async () => {
    await addTask('epic-1/task-1', 'in-progress');
    await addIntegrationCheck();
    await addSpecReview();

    const record = await closeEpic(
      {
        epicId,
        integrationHeadSha: HEAD_SHA,
        mcp: MCP_SURFACE_NOT_REQUIRED,
        overrideRationale: 'Blocker is a known carry-forward defect, tracked as D-99.',
      },
      ctx(),
      { stateDir },
    );

    expect(record.closedBy).toBe('operator-override');
    expect(record.machineVerdict).toBe('hold');
    expect(record.machineReason).toBe('mechanical-blockers');
    expect(record.blockers.length).toBeGreaterThan(0);

    const closed = await closedEvents();
    expect(closed).toHaveLength(1);
    const payload = closed[0]?.record.payload as Record<string, unknown>;
    expect(payload.closed_by).toBe('operator-override');
    expect(payload.machine_verdict).toBe('hold');
    expect(payload.machine_reason).toBe('mechanical-blockers');
    expect(payload.override_rationale).toBe(
      'Blocker is a known carry-forward defect, tracked as D-99.',
    );
    expect((payload.blockers as string[]).some((b) => b.includes('epic-1/task-1'))).toBe(true);
  });

  // An override whose rationale is whitespace is the same forgery class as
  // integration.ts's empty check list reading back as a pass.
  it('refuses a blank override rationale rather than recording an empty reason', async () => {
    await addTask('epic-1/task-1', 'in-progress');
    await addIntegrationCheck();
    await addSpecReview();

    await expect(
      closeEpic(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: MCP_SURFACE_NOT_REQUIRED,
          overrideRationale: '   ',
        },
        ctx(),
        { stateDir },
      ),
    ).rejects.toThrow(EpicCloseError);
    expect(await closedEvents()).toHaveLength(0);
  });

  // D-45: `event tail` answers a typo'd session id with [] and exit 0. Close
  // must not inherit that — an unknown session here would mint a brand-new
  // log file whose first line is "this epic is closed".
  it('refuses to close against a session id with no event log at all (D-45)', async () => {
    await expect(
      closeEpic(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: MCP_SURFACE_NOT_REQUIRED,
          overrideRationale: 'ship it',
        },
        { sessionId: 'sess-typo', planVersion: 1, causalParent: null },
        { stateDir },
      ),
    ).rejects.toThrow(EpicCloseError);

    const events = await readEvents('sess-typo', { stateDir });
    expect(events).toHaveLength(0);
  });

  // D-127 Part B: amendPlan() parks a cited spec finding at amend-pending
  // rather than discharging it straight to amended — the gate has to notice
  // when the amendment's own obligation (amends_task_ids at
  // amends_plan_version) hasn't landed, and closeEpic is the one write path
  // that gets to turn a satisfied one into a fact.
  describe('the amendment path (D-127 Part B)', () => {
    function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
      return {
        finding_id: 'finding-spec',
        task_id: 'epic-1/task-2',
        finding_category: 'correctness',
        severity: 'S2-major',
        finding_status: 'raised',
        finding_scope: 'spec',
        spec_ref: { plan_version: 1, criterion_ref: 'epic-1/task-2:criterion-1' },
        summary: 'plan v1 asked for the wrong thing on task-2',
        failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
        found_by: 'reviewer',
        ...overrides,
      };
    }

    async function raiseAmendPending(amendsTaskIds: string[] = ['epic-1/task-2']) {
      await raiseFinding({ finding: draft(), filePath: 'src/foo.ts' }, ctx(), { stateDir });
      await transition(
        'finding-spec',
        AMEND_PENDING_STATUS,
        ctx(),
        { stateDir },
        { amendsTaskIds, amendsPlanVersion: 2 },
      );
    }

    it('discharges a satisfied amend-pending finding to amended, before the epic-closed event', async () => {
      await addTask('epic-1/task-1', 'completed');
      await addTask('epic-1/task-2', 'completed', 2);
      await addIntegrationCheck();
      await addSpecReview();
      await raiseAmendPending();

      const record = await closeEpic(
        { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
        ctx(),
        { stateDir },
      );

      expect(record.closedBy).toBe('verdict');
      expect(record.machineVerdict).toBe('go');

      const events = await readEvents(sessionId, { stateDir });
      const dischargeIndex = events.findIndex(
        (e) =>
          e.record.event_type === 'finding-transitioned' &&
          (e.record.payload as Record<string, unknown>).to_status === AMENDED_STATUS,
      );
      const closedIndex = events.findIndex((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
      expect(dischargeIndex).toBeGreaterThan(-1);
      expect(closedIndex).toBeGreaterThan(dischargeIndex);

      const payload = events[closedIndex]?.record.payload as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      expect(summary.satisfied_amendments).toEqual([
        {
          finding_id: 'finding-spec',
          task_id: 'epic-1/task-2',
          severity: 'S2-major',
          finding_status: AMEND_PENDING_STATUS,
          summary: 'plan v1 asked for the wrong thing on task-2',
          // The evidence rides along: the verdict says which amendments are
          // about to discharge AND what discharges them, which is the same
          // proof transition() will demand a few lines later.
          satisfied_by: [{ task_id: 'epic-1/task-2', plan_version: 2 }],
        },
      ]);
    });

    // D-21 Part 4. The PERSISTED epic-closed record is what outlives the
    // session -- what anyone auditing the close months later actually reads
    // -- so the honesty requirement has to reach it, not only the live
    // verdict summarizeEpic hands the judge. A discharge that reads as
    // ordinary in the durable record while the judge saw the truth would
    // satisfy the letter of D-21 Part 4 and defeat its purpose.
    it('persists that a discharged amendment rested on a repaired obligation, carrying the reason', async () => {
      await addTask('epic-1/task-1', 'completed');
      await addTask('epic-1/task-2', 'completed', 2);
      await addIntegrationCheck();
      await addSpecReview();
      await raiseAmendPending([null, 'epic-1/task-2'] as unknown as string[]);
      await repairObligation(
        {
          findingId: 'finding-spec',
          replaceWith: ['epic-1/task-2'],
          reason: 'dropped the null entry a malformed plan amend wrote',
        },
        ctx(),
        { stateDir },
      );

      const record = await closeEpic(
        { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
        ctx(),
        { stateDir },
      );
      expect(record.machineVerdict).toBe('go');

      const events = await readEvents(sessionId, { stateDir });
      const closedIndex = events.findIndex((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
      const payload = events[closedIndex]?.record.payload as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      const amendments = summary.satisfied_amendments as Array<Record<string, unknown>>;
      expect(amendments).toHaveLength(1);
      expect(amendments[0]?.repaired_obligation_reason).toBe(
        'dropped the null entry a malformed plan amend wrote',
      );
    });

    // The exact real-world shape this verb exists for:
    // f-demo-rpg-reading-interface/integration-3e6bd014 carries
    // amends_task_ids: [null, "demo-rpg-reading-interface/task-5-reader-memory"].
    // A repair drops the null and keeps the real id; the finding must then
    // discharge AND the verdict must say the discharge rested on a repaired
    // obligation, carrying the reason -- both halves, end to end.
    it('discharges the real f-demo-rpg-reading-interface/integration-3e6bd014 shape once repaired, and says so', async () => {
      await addTask('epic-1/task-1', 'completed');
      await addTask('epic-1/task-5-reader-memory', 'completed', 2);
      await addIntegrationCheck();
      await addSpecReview();
      await raiseFinding(
        {
          finding: draft({
            finding_id: 'integration-3e6bd014',
            task_id: 'epic-1/task-1',
            spec_ref: { plan_version: 1, criterion_ref: 'epic-1/task-1:criterion-3' },
          }),
          filePath: 'src/foo.ts',
        },
        ctx(),
        { stateDir },
      );
      await transition(
        'integration-3e6bd014',
        AMEND_PENDING_STATUS,
        ctx(),
        { stateDir },
        {
          amendsTaskIds: [null, 'epic-1/task-5-reader-memory'] as unknown as string[],
          amendsPlanVersion: 2,
        },
      );
      await repairObligation(
        {
          findingId: 'integration-3e6bd014',
          replaceWith: ['epic-1/task-5-reader-memory'],
          reason:
            'dropped the null written by a malformed plan amend; the real obligation is unaffected',
        },
        ctx(),
        { stateDir },
      );

      const record = await closeEpic(
        { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
        ctx(),
        { stateDir },
      );
      expect(record.machineVerdict).toBe('go');

      const events = await readEvents(sessionId, { stateDir });
      const discharged = events.find(
        (e) =>
          e.record.event_type === 'finding-transitioned' &&
          (e.record.payload as Record<string, unknown>).finding_id === 'integration-3e6bd014' &&
          (e.record.payload as Record<string, unknown>).to_status === AMENDED_STATUS,
      );
      expect(discharged).toBeDefined();

      const closedIndex = events.findIndex((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
      const payload = events[closedIndex]?.record.payload as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      const amendments = summary.satisfied_amendments as Array<Record<string, unknown>>;
      expect(amendments).toHaveLength(1);
      expect(amendments[0]?.finding_id).toBe('integration-3e6bd014');
      expect(amendments[0]?.repaired_obligation_reason).toBe(
        'dropped the null written by a malformed plan amend; the real obligation is unaffected',
      );
    });

    it('refuses to close over an amend-pending finding whose obligation has not landed, without an override', async () => {
      await addTask('epic-1/task-1', 'completed');
      await addTask('epic-1/task-2', 'in-progress');
      await addIntegrationCheck();
      await addSpecReview();
      await raiseAmendPending();
      const before = await readEvents(sessionId, { stateDir });

      await expect(
        closeEpic({ epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED }, ctx(), {
          stateDir,
        }),
      ).rejects.toThrow(/finding-spec/);

      const after = await readEvents(sessionId, { stateDir });
      expect(after).toHaveLength(before.length);
    });

    it('still discharges a satisfied amendment on an operator-override close over an unrelated blocker', async () => {
      // The override question ("does THIS close proceed") is orthogonal to
      // amendment satisfaction ("did THIS obligation land") — summarizeEpic
      // already computed the latter as a pure fact before override enters the
      // picture, so an unrelated blocker being overridden must not hold the
      // amendment's own discharge hostage.
      await addTask('epic-1/task-1', 'in-progress');
      await addTask('epic-1/task-2', 'completed', 2);
      await addIntegrationCheck();
      await addSpecReview();
      await raiseAmendPending();

      const record = await closeEpic(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: MCP_SURFACE_NOT_REQUIRED,
          overrideRationale: 'task-1 carry-forward tracked separately',
        },
        ctx(),
        { stateDir },
      );

      expect(record.closedBy).toBe('operator-override');
      expect(record.blockers.some((b) => b.includes('epic-1/task-1'))).toBe(true);
      expect(record.blockers.some((b) => b.includes('finding-spec'))).toBe(false);

      const events = await readEvents(sessionId, { stateDir });
      const discharged = events.some(
        (e) =>
          e.record.event_type === 'finding-transitioned' &&
          (e.record.payload as Record<string, unknown>).finding_id === 'finding-spec' &&
          (e.record.payload as Record<string, unknown>).to_status === AMENDED_STATUS,
      );
      expect(discharged).toBe(true);
    });

    // The discharge lives in closeEpic and nowhere else, deliberately.
    // `epic verdict` is a question an operator asks as often as they like; a
    // question that closes findings the first time it is asked answers
    // differently the second time, and the amendment would be discharged by
    // looking at it rather than by the work landing — D-127 with a different
    // verb.
    it('reports a satisfied amendment without discharging it — verdict stays read-only', async () => {
      await addTask('epic-1/task-1', 'completed');
      await addTask('epic-1/task-2', 'completed', 2);
      await addIntegrationCheck();
      await addSpecReview();
      await raiseAmendPending();
      const before = await readEvents(sessionId, { stateDir });

      const outcome = await runEpicVerdict(
        { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('go');
      expect(outcome.summary.blockers).toEqual([]);
      expect(outcome.summary.satisfiedAmendments.map((a) => a.findingId)).toEqual(['finding-spec']);
      // Asked twice, answered twice, wrote nothing either time.
      await runEpicVerdict(
        { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED },
        ctx(),
        { stateDir },
      );
      const after = await readEvents(sessionId, { stateDir });
      expect(after).toHaveLength(before.length);
      const findings = await listFindings(sessionId, {}, { stateDir });
      expect(findings.find((f) => f.finding_id === 'finding-spec')?.finding_status).toBe(
        AMEND_PENDING_STATUS,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The MCP hard gate (operator decision of 2026-08-07: "hard gate at epic
// close, with an operator override"). It rides the blocker channel rather
// than a second refusal path: runEpicVerdict already turns a non-empty
// `blockers` into hold/mechanical-blockers, and closeEpic already refuses a
// hold without a rationale and records what it overrode. A parallel gate
// would be a second override policy to keep in sync with the first.
// ---------------------------------------------------------------------------
describe('epic.ts — the mcp surface gate (docs/standards/mcp.md step 4)', () => {
  const readyTasks = [taskRow({ taskStatus: 'completed' })];

  const redSurface = (): McpSurfaceStatus => ({
    required: true,
    milestoneId: 'demo-mcp-surface',
    manifestPath: '/tmp/demo/mcp.manifest.json',
    check: {
      ok: false,
      violations: [{ rule: 'MCP-P1', path: 'protocolRevision', message: 'must be "2025-11-25"' }],
    },
    problem: null,
  });

  it('does not block an epic outside the mcp surface milestone', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      okIntegration(),
      {
        required: false,
        milestoneId: null,
        manifestPath: null,
        check: null,
        problem: null,
      },
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(true);
  });

  it('blocks an mcp-surface epic whose manifest violates the standard, naming the rule', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      okIntegration(),
      redSurface(),
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('MCP-P1'))).toBe(true);
  });

  it('blocks an mcp-surface epic that has no manifest at all', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      okIntegration(),
      {
        required: true,
        milestoneId: 'demo-mcp-surface',
        manifestPath: '/tmp/demo/mcp.manifest.json',
        check: null,
        problem: 'missing',
      },
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(false);
    expect(summary.blockers.some((b) => b.includes('mcp.manifest.json'))).toBe(true);
  });

  it('lets a green surface through', () => {
    const summary = summarizeEpic(
      'epic-1',
      readyTasks,
      [],
      okIntegration(),
      {
        required: true,
        milestoneId: 'demo-mcp-surface',
        manifestPath: '/tmp/demo/mcp.manifest.json',
        check: { ok: true, violations: [] },
        problem: null,
      },
      okSpecReview(),
    );
    expect(summary.mechanicallyReady).toBe(true);
    expect(summary.blockers).toHaveLength(0);
  });

  // The gate is only a gate if the override leaves a name and a reason behind.
  describe('closeEpic over a red surface', () => {
    let stateDir: string;
    const sessionId = 'sess-epic-mcp';
    const epicId = 'epic-1';
    const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

    beforeEach(async () => {
      stateDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-mcp-'));
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        },
        { stateDir },
      );
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'planner',
          event_type: 'task-added',
          task_id: `${epicId}/task-1`,
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { epic_id: epicId, task_status: 'completed' },
        },
        { stateDir },
      );
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'operator',
          event_type: 'integration-check',
          task_id: `${epicId}/integration`,
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: {
            epic_id: epicId,
            branch: `smith/${epicId}/integration`,
            head_sha: HEAD_SHA,
            pass: true,
            results: [{ name: 'lint', pass: true, exitCode: 0, tail: '' }],
          },
        },
        { stateDir },
      );
    });

    afterEach(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    it('refuses without a rationale, naming the rule it refused over', async () => {
      await expect(
        closeEpic({ epicId, integrationHeadSha: HEAD_SHA, mcp: redSurface() }, ctx(), {
          stateDir,
        }),
      ).rejects.toThrow(/MCP-P1/);
      const events = await readEvents(sessionId, { stateDir });
      expect(events.filter((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE)).toHaveLength(0);
    });

    it('records the overridden mcp rule in the epic-closed event', async () => {
      const record = await closeEpic(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: redSurface(),
          overrideRationale: 'Surface ships next sprint; tracked as D-100.',
        },
        ctx(),
        { stateDir },
      );

      expect(record.closedBy).toBe('operator-override');
      expect(record.blockers.some((b) => b.includes('MCP-P1'))).toBe(true);

      const events = await readEvents(sessionId, { stateDir });
      const closed = events.filter((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
      expect(closed).toHaveLength(1);
      const payload = closed[0]?.record.payload as Record<string, unknown>;
      expect((payload.blockers as string[]).some((b) => b.includes('MCP-P1'))).toBe(true);
    });

    // The blocker string says a rule was broken; it does not say the surface
    // was ever checked, which manifest was read, or that the epic was in the
    // surface milestone at all. Those are the questions a later reader asks of
    // an override, and only the status itself answers them.
    //
    // Projected as the check's own scalars — rule and path — and not its
    // `message`: the message is manifest-derived text, and this payload is
    // persisted. Same reason the D-198 fix keeps the JSON parser's message out
    // of an mcpBlockers string.
    it('records what the surface verdict actually was, not just the rule it broke', async () => {
      await closeEpic(
        {
          epicId,
          integrationHeadSha: HEAD_SHA,
          mcp: redSurface(),
          overrideRationale: 'Surface ships next sprint; tracked as D-100.',
        },
        ctx(),
        { stateDir },
      );

      const events = await readEvents(sessionId, { stateDir });
      const closed = events.filter((e) => e.record.event_type === EPIC_CLOSED_EVENT_TYPE);
      const payload = closed[0]?.record.payload as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      expect(summary.mcp).toEqual({
        required: true,
        milestone_id: 'demo-mcp-surface',
        manifest_path: '/tmp/demo/mcp.manifest.json',
        problem: null,
        check: { ok: false, violations: [{ rule: 'MCP-P1', path: 'protocolRevision' }] },
      });
      // This epic's one task is recorded completed with no gate run behind it
      // (the beforeEach appends task-added and nothing else) — the other
      // closure nobody re-derives after the fact.
      expect(summary.ungated_tasks).toEqual([
        { task_id: 'epic-1/task-1', task_status: 'completed' },
      ]);
    });
  });
});

// D-120. The epic-level quorum fired twice on byte-identical input — 4 tasks
// completed, 0 non-terminal, 0 open findings — and answered `refute` then
// `confirm`, same model, minutes apart. Neither answer was derivable: the
// prompt carried a refute mandate, a status table, and the sentence "you do not
// have file contents or the diff", and nothing else. A judge that takes the
// mandate seriously refutes every epic forever; one that doesn't confirms every
// epic forever. Which you get is sampling noise.
//
// The fix is not a better mandate. It is evidence the judge can be WRONG about:
// the commands that actually ran against the assembled branch, the review that
// closed the spec, and — the part the old prompt hid completely — every closure
// a human decided rather than the machine. summarizeEpic drops all of it today,
// because its own job is to decide readiness and none of it blocks. That is
// exactly why the judge needs it: what does not block is what nobody re-checks.
describe('epic.ts epicVerdictJudgeRequest — refutable evidence (D-120)', () => {
  const BUDGET = { timeout_ms: 1_000, max_output_bytes: 4_096 };

  function summaryFor(
    tasks: EpicTaskRow[],
    findings: Finding[] = [],
    integration: IntegrationStatus = okIntegration(),
    mcp: McpSurfaceStatus = MCP_SURFACE_NOT_REQUIRED,
    specReview: SpecReviewStatus = okSpecReview(),
  ) {
    return summarizeEpic('epic-1', tasks, findings, integration, mcp, specReview);
  }

  function promptFor(...args: Parameters<typeof summaryFor>): string {
    return epicVerdictJudgeRequest(summaryFor(...args), BUDGET).prompt;
  }

  const doneTask = () => taskRow({ taskStatus: 'completed' });

  describe('what summarizeEpic keeps for the judge but does not block on', () => {
    it('separates a task that reached terminal-OK by waiver from one that completed', () => {
      const summary = summaryFor([
        doneTask(),
        taskRow({ taskId: 'epic-1/task-2', taskStatus: 'waived' }),
      ]);
      expect(summary.mechanicallyReady).toBe(true);
      expect(summary.waivedTasks.map((t) => t.taskId)).toEqual(['epic-1/task-2']);
    });

    it('keeps findings closed by waiver or amendment, which openFindings drops entirely', () => {
      const summary = summaryFor(
        [doneTask()],
        [
          findingFixture({ finding_id: 'f-waived', finding_status: 'waived' }),
          findingFixture({ finding_id: 'f-amended', finding_status: AMENDED_STATUS }),
          findingFixture({ finding_id: 'f-verified', finding_status: 'fix-verified' }),
        ],
      );
      expect(summary.mechanicallyReady).toBe(true);
      expect(summary.openFindings).toHaveLength(0);
      // fix-verified was closed by showing the fix; the other two were closed by
      // deciding not to. Only the decisions belong here.
      expect(summary.discretionaryFindings.map((f) => f.findingId)).toEqual([
        'f-waived',
        'f-amended',
      ]);
    });
  });

  describe('the assembled branch', () => {
    it('names the branch, the commit the check covers, and every command it ran', () => {
      const prompt = promptFor([doneTask()], [], {
        check: checkRecord({
          results: [
            { name: 'lint', pass: true, exitCode: 0, tail: '' },
            { name: 'test', pass: true, exitCode: 0, tail: '' },
          ],
        }),
        headSha: HEAD_SHA,
      });
      expect(prompt).toContain('smith/epic-1/integration');
      expect(prompt).toContain(HEAD_SHA.slice(0, 8));
      expect(prompt).toContain('lint: passed (exit 0)');
      expect(prompt).toContain('test: passed (exit 0)');
    });

    // The command set is the refutable part: an epic whose integration check ran
    // one command called `lint` and nothing else is green and unshippable, and
    // that is a judgement about a list — which a judge can make and a blocker
    // cannot, since every command in the list passed.
    it('states how many commands ran, so a one-command suite reads as one command', () => {
      const prompt = promptFor([doneTask()], [], {
        check: checkRecord({ results: [{ name: 'lint', pass: true, exitCode: 0, tail: '' }] }),
        headSha: HEAD_SHA,
      });
      expect(prompt).toMatch(/1 command/);
    });

    // CheckResult.tail is the last 50 lines of combined stdout+stderr from a
    // command run at the integration root. It goes to an EXTERNAL provider from
    // here. guardrails.md "No secrets in outputs" is not satisfied by hoping
    // that output is clean.
    it('never carries a command tail into the provider prompt', () => {
      const prompt = promptFor([doneTask()], [], {
        check: checkRecord({
          results: [
            {
              name: 'test',
              pass: true,
              exitCode: 0,
              tail: 'token=synthetic-not-a-real-secret\n214 passed',
            },
          ],
        }),
        headSha: HEAD_SHA,
      });
      expect(prompt).not.toContain('synthetic-not-a-real-secret');
      expect(prompt).not.toContain('214 passed');
      expect(prompt).toContain('test: passed (exit 0)');
    });

    // Unreachable through runEpicVerdict, which holds before the judge on a
    // missing check — stated anyway, because a prompt that silently omits the
    // block reads to the judge as an epic with nothing to say about its branch.
    it('says so when there is no check on record at all', () => {
      const prompt = promptFor([doneTask()], [], { check: null, headSha: HEAD_SHA });
      expect(prompt).toMatch(/no integration-root check/i);
    });
  });

  it('names the closing spec review — who ran it, against which commit and plan version', () => {
    const prompt = promptFor([doneTask()]);
    expect(prompt).toContain('spec-reviewer');
    expect(prompt).toContain(HEAD_SHA.slice(0, 8));
    expect(prompt).toMatch(/plan v1/);
  });

  it('states the MCP surface verdict either way', () => {
    expect(promptFor([doneTask()])).toMatch(/no MCP surface/i);
    const required: McpSurfaceStatus = {
      required: true,
      milestoneId: 'black-smith-mcp-surface',
      manifestPath: 'factory/mcp/manifest.yml',
      check: { ok: true, violations: [] },
      problem: null,
    };
    expect(promptFor([doneTask()], [], okIntegration(), required)).toContain(
      'black-smith-mcp-surface',
    );
  });

  // D-198. Unreachable through runEpicVerdict today — a red surface is a
  // blocker, and step 1 holds on blockers without calling a judge — so this
  // line only renders the day something reaches the prompt past a violation
  // (an override path, a preview command). That is exactly when nobody is
  // watching, and the line said `[object Object]; [object Object]`: the one
  // sentence describing HOW the surface is red carried nothing the judge could
  // be wrong about, which is the whole point of the material D-120 added.
  it('renders a red surface as rules the judge can place, not [object Object]', () => {
    const red: McpSurfaceStatus = {
      required: true,
      milestoneId: 'demo-mcp-surface',
      manifestPath: 'workspaces/demo/mcp.manifest.json',
      check: {
        ok: false,
        violations: [
          { rule: 'MCP-P1', path: '/protocolRevision', message: 'Pin the wire revision.' },
          { rule: 'MCP-T4', path: '/tools/0', message: 'A write tool needs approval.' },
        ],
      },
      problem: null,
    };
    const prompt = promptFor([doneTask()], [], okIntegration(), red);
    expect(prompt).not.toContain('[object Object]');
    expect(prompt).toContain('MCP-P1');
    expect(prompt).toContain('/tools/0');
    expect(prompt).toContain('A write tool needs approval.');
  });

  it('says which way the manifest failed when no verdict could be rendered', () => {
    const base = {
      required: true,
      milestoneId: 'demo-mcp-surface',
      manifestPath: 'workspaces/demo/mcp.manifest.json',
      check: null,
    };
    const missing: McpSurfaceStatus = { ...base, problem: 'missing' };
    const unreadable: McpSurfaceStatus = { ...base, problem: 'unreadable' };
    expect(promptFor([doneTask()], [], okIntegration(), missing)).not.toEqual(
      promptFor([doneTask()], [], okIntegration(), unreadable),
    );
  });

  describe('the closures a human decided', () => {
    it('names a waived task as waived rather than burying it in the status table', () => {
      const prompt = promptFor([
        doneTask(),
        taskRow({ taskId: 'epic-1/task-2', taskStatus: 'waived' }),
      ]);
      expect(prompt).toMatch(/Discretionary closures/i);
      expect(prompt).toMatch(/Tasks waived rather than completed: 1/);
    });

    it('names each finding closed by waiver or amendment, with its severity and summary', () => {
      const prompt = promptFor(
        [doneTask()],
        [
          findingFixture({
            finding_id: 'f-waived',
            finding_status: 'waived',
            severity: 'S2-major',
            summary: 'race in the cache warmer',
          }),
        ],
      );
      expect(prompt).toContain('f-waived');
      expect(prompt).toContain('S2-major');
      expect(prompt).toContain('race in the cache warmer');
    });

    it('names an amendment this close will discharge, and what discharges it', () => {
      const prompt = promptFor(
        [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
        [
          findingFixture({
            finding_status: AMEND_PENDING_STATUS,
            finding_scope: 'spec',
            amends_task_ids: ['epic-1/task-2'],
            amends_plan_version: 2,
          }),
        ],
      );
      expect(prompt).toMatch(/finding-1/);
      expect(prompt).toMatch(/epic-1\/task-2 at plan v2/);
    });

    // D-21 Part 4: the judge is the reader this honesty requirement is
    // fundamentally for -- a clean discharge in the prompt must not read as
    // ordinary when the obligation it rested on was corrected.
    it('names that a discharged amendment rested on a repaired obligation, carrying the reason', () => {
      const prompt = promptFor(
        [taskRow({ taskId: 'epic-1/task-2', taskStatus: 'completed', planVersion: 2 })],
        [
          findingFixture({
            finding_status: AMEND_PENDING_STATUS,
            finding_scope: 'spec',
            amends_task_ids: ['epic-1/task-2'],
            amends_plan_version: 2,
            obligation_repair_reason: 'dropped a null entry written by a malformed plan amend',
          }),
        ],
      );
      expect(prompt).toMatch(/finding-1/);
      expect(prompt).toMatch(/obligation repaired/i);
      expect(prompt).toContain('dropped a null entry written by a malformed plan amend');
    });

    it('says none, rather than nothing, when every closure was earned', () => {
      const prompt = promptFor([doneTask()], [findingFixture({ finding_status: 'fix-verified' })]);
      expect(prompt).toMatch(/Discretionary closures/i);
      expect(prompt).toMatch(/Tasks waived rather than completed: 0/);
    });
  });

  describe('the mandate', () => {
    it('inventories what the judge has and has not, instead of only the absence', () => {
      const prompt = promptFor([doneTask()]);
      expect(prompt).toMatch(/you do not have/i);
      // The old prompt's entire evidence paragraph. Keeping it would leave the
      // judge free to answer the same content-free question it answered twice
      // and differently.
      expect(prompt).not.toContain(
        'You are judging the claim as stated above; you do not have file contents',
      );
    });

    // Run 1's rationale was "without diffs, acceptance-criteria results, or test
    // evidence, readiness cannot be verified" — correct about the old prompt and
    // useless as a verdict, because it is true of every epic this gate will ever
    // see. A refutation has to point at a line.
    it('requires a refutation to name the line it rests on, and forbids refusing over the missing diff alone', () => {
      // Normalised: this asserts about a sentence, and the prompt is hard-
      // wrapped, so a line break inside the sentence is not a defect.
      const sentences = promptFor([doneTask()]).replace(/\s+/g, ' ');
      expect(sentences).toMatch(/name the line you are refuting/i);
      expect(sentences).toMatch(/true of every epic this gate will ever see/i);
    });

    it('still carries the critic mandate and the judge-verdict schema', () => {
      const request = epicVerdictJudgeRequest(summaryFor([doneTask()]), BUDGET);
      expect(request.prompt).toMatch(/REFUTE/);
      expect(request.schemaName).toBe('judge-verdict');
      expect(request.taskId).toBe('epic-1/integration');
    });
  });
});
