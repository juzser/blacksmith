import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_LINE_PREFIX,
  foldErrorEvents,
  GATE_BLOCKED_REASONS,
  type GateBlockedReason,
  renderBody,
  renderComment,
  toIssueBodyFields,
  toIssueCommentFields,
} from '../src/errorIssues.js';
import type { EventRecord, StoredEvent } from '../src/events.js';
import type { GateOutcome } from '../src/gate.js';

// ---------------------------------------------------------------------------
// Compile-time tie-back to gate.ts (AC4): if GateOutcome's blocked arm ever
// gains or loses a reason without errorIssues.ts's GateBlockedReason
// following, `pnpm run typecheck:test` fails to compile this file. `reason`
// is not exported as a runtime value by gate.ts, so this is the "asserts
// against a list the test derives from the type" fallback the criterion
// allows, and this comment is how it says so.
// ---------------------------------------------------------------------------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type AssertTrue<T extends true> = T;
type RealBlockedReason = Extract<GateOutcome, { outcome: 'blocked' }>['reason'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _GateReasonsMatchSource = AssertTrue<Equal<GateBlockedReason, RealBlockedReason>>;

let counter = 0;

function ev(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<EventRecord> & { eventId?: string } = {},
): StoredEvent {
  counter += 1;
  const sessionId = overrides.session_id ?? 'session-1';
  return {
    event_id: overrides.eventId ?? `${sessionId}-${counter}`,
    record: {
      session_id: sessionId,
      actor: 'system',
      event_type: eventType,
      plan_version: overrides.plan_version ?? 1,
      causal_parent: overrides.causal_parent ?? null,
      payload,
      ts: overrides.ts ?? '2026-01-01T00:00:00.000Z',
      ...(overrides.task_id ? { task_id: overrides.task_id } : {}),
      ...(overrides.project ? { project: overrides.project } : {}),
    },
  };
}

function gateBlocked(
  taskId: string,
  reason: string,
  overrides: Partial<EventRecord> & { eventId?: string } = {},
): StoredEvent {
  return ev('gate-outcome', { outcome: 'blocked', reason }, { task_id: taskId, ...overrides });
}

function taskFailed(
  taskId: string,
  overrides: Partial<EventRecord> & { eventId?: string } = {},
): StoredEvent {
  return ev(
    'task-added',
    { task_status: 'failed', epic_id: 'epic-1' },
    { task_id: taskId, ...overrides },
  );
}

function errorLogged(
  taskId: string,
  errorClass: string,
  overrides: Partial<EventRecord> & { eventId?: string } = {},
): StoredEvent {
  return ev(
    'error-logged',
    { error: errorClass, severity: 'S2-major', task_ref: taskId },
    { task_id: taskId, ...overrides },
  );
}

const alwaysEnabled = () => true;

/**
 * A hook-shaped rival, built to lose exactly the third source: it walks the
 * log looking only at `gate-outcome` and `task-added`, the two sources a
 * call-site hook could plausibly observe in-process. It never looks at
 * `error-logged` at all -- standing in for a producer wired into `gate.ts`
 * and `taskEvents.ts` but never into whatever hand-appends `error-logged`.
 */
function nullHookShapedFold(events: readonly StoredEvent[]): number {
  let count = 0;
  for (const { record } of events) {
    if (record.event_type === 'gate-outcome' && record.payload.outcome === 'blocked') count += 1;
    if (record.event_type === 'task-added' && record.payload.task_status === 'failed') count += 1;
  }
  return count;
}

describe('foldErrorEvents', () => {
  it('folds all three sources the log holds -- a hook-shaped rival misses the hand-appended one (AC1)', () => {
    const events: StoredEvent[] = [
      gateBlocked('epic-1/task-a', 'tests-failed'),
      taskFailed('epic-1/task-b'),
      // Hand-appended: no dispatch context, no session-start, no
      // surrounding task events -- just this one event, alone.
      errorLogged('epic-1/task-c', 'execution.test-failure', { session_id: 'hand-appended' }),
    ];

    const hypothesis = foldErrorEvents(events, '2026-01-02T00:00:00.000Z', alwaysEnabled);
    const nullCount = nullHookShapedFold(events);

    // The differential this module exists for: 2 !== 3.
    expect(nullCount).toBe(2);
    expect(hypothesis.reports).toHaveLength(3);
  });

  it('collapses five rounds of one broken gate into one fingerprint (AC2)', () => {
    const events: StoredEvent[] = [1, 2, 3, 4, 5].map((n) =>
      gateBlocked('epic-1/task-a', 'tests-failed', {
        session_id: `session-${n}`,
        plan_version: n,
        ts: `2026-01-0${n}T00:00:00.000Z`,
      }),
    );

    const result = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', alwaysEnabled);
    const distinctFingerprints = new Set(result.reports.map((r) => r.fingerprint));

    expect(result.reports).toHaveLength(5);
    expect(distinctFingerprints.size).toBe(1);
  });

  it('the fingerprint discriminates on task id, error class and project (AC3)', () => {
    const now = '2026-01-06T00:00:00.000Z';
    const baseline = foldErrorEvents(
      [gateBlocked('epic-1/task-a', 'tests-failed', { project: 'proj-a' })],
      now,
      alwaysEnabled,
    ).reports[0]?.fingerprint;
    const differentTask = foldErrorEvents(
      [gateBlocked('epic-1/task-z', 'tests-failed', { project: 'proj-a' })],
      now,
      alwaysEnabled,
    ).reports[0]?.fingerprint;
    const differentReason = foldErrorEvents(
      [gateBlocked('epic-1/task-a', 'findings', { project: 'proj-a' })],
      now,
      alwaysEnabled,
    ).reports[0]?.fingerprint;
    const differentProject = foldErrorEvents(
      [gateBlocked('epic-1/task-a', 'tests-failed', { project: 'proj-b' })],
      now,
      alwaysEnabled,
    ).reports[0]?.fingerprint;

    const values = [baseline, differentTask, differentReason, differentProject];
    expect(new Set(values).size).toBe(4);
  });

  it('maps all ten gate-blocked reasons, read from GATE_BLOCKED_REASONS (AC4)', () => {
    // GATE_BLOCKED_REASONS is Object.keys() of errorIssues.ts's own mapping
    // table, not a second hand-typed list in this test; _GateReasonsMatchSource
    // above ties that table's key type back to gate.ts's GateOutcome at
    // compile time, so an eleventh reason fails `typecheck:test` here.
    expect(GATE_BLOCKED_REASONS).toHaveLength(10);
    for (const reason of GATE_BLOCKED_REASONS as GateBlockedReason[]) {
      const result = foldErrorEvents(
        [gateBlocked('epic-1/task-a', reason)],
        '2026-01-06T00:00:00.000Z',
        alwaysEnabled,
      );
      expect(result.reports[0]?.error_class).toBe(`gate.blocked.${reason}`);
    }
  });

  it('never leaks a secret-shaped detail or a diff hunk into the body or the comment (AC5)', () => {
    const events: StoredEvent[] = [
      errorLogged('epic-1/task-a', 'execution.test-failure'),
    ];
    // Attach the payload's own `detail` after construction so the fixture
    // reads as a single literal record of what a real writer could log.
    (events[0] as StoredEvent).record.payload.detail =
      'token=SECRETLIKE-abc123\n+added line\n-removed line';

    const result = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', alwaysEnabled);
    const report = result.reports[0];
    if (!report) throw new Error('expected one report');

    const body = renderBody(toIssueBodyFields(report));
    const comment = renderComment(toIssueCommentFields(report));

    for (const artifact of [body, comment]) {
      expect(artifact.includes('SECRETLIKE-abc123')).toBe(false);
      expect(artifact.split('\n').some((line) => /^[+-]/.test(line))).toBe(false);
    }
  });

  it('renders byte-identically whether or not the source event carries an unknown extra field (AC5)', () => {
    const withoutExtra = foldErrorEvents(
      [errorLogged('epic-1/task-a', 'execution.test-failure', { eventId: 'fixed-event-id' })],
      '2026-01-06T00:00:00.000Z',
      alwaysEnabled,
    );
    const eventWithExtra = errorLogged('epic-1/task-a', 'execution.test-failure', {
      eventId: 'fixed-event-id',
    });
    eventWithExtra.record.payload.unknown_field = 'never seen before';
    const withExtra = foldErrorEvents(
      [eventWithExtra],
      '2026-01-06T00:00:00.000Z',
      alwaysEnabled,
    );

    const reportA = withoutExtra.reports[0];
    const reportB = withExtra.reports[0];
    if (!reportA || !reportB) throw new Error('expected one report each');

    expect(renderBody(toIssueBodyFields(reportB))).toBe(renderBody(toIssueBodyFields(reportA)));
    expect(renderComment(toIssueCommentFields(reportB))).toBe(
      renderComment(toIssueCommentFields(reportA)),
    );
  });

  it('renderComment has no free-text field: its record is exactly this key set (AC6)', () => {
    const result = foldErrorEvents(
      [gateBlocked('epic-1/task-a', 'tests-failed')],
      '2026-01-06T00:00:00.000Z',
      alwaysEnabled,
    );
    const report = result.reports[0];
    if (!report) throw new Error('expected one report');
    const fields = toIssueCommentFields(report);

    expect(Object.keys(fields).sort()).toEqual(
      ['epic_id', 'fingerprint', 'latest_event_id', 'plan_version', 'session_id', 'timestamp'].sort(),
    );
  });

  it('is pure: two folds of identical input are byte-identical (AC7)', () => {
    const events: StoredEvent[] = [
      gateBlocked('epic-1/task-a', 'tests-failed'),
      taskFailed('epic-1/task-b'),
      errorLogged('epic-1/task-c', 'execution.test-failure'),
    ];
    const a = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', alwaysEnabled);
    const b = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', alwaysEnabled);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('skips a malformed event and counts it, without throwing (AC8)', () => {
    const malformed = ev('error-logged', { severity: 'S2-major' }, { task_id: 'epic-1/task-a' }); // missing `error`
    const valid = gateBlocked('epic-1/task-b', 'tests-failed');

    const result = foldErrorEvents([malformed, valid], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('excludes reports for a disabled project without counting them as skipped', () => {
    const events: StoredEvent[] = [gateBlocked('epic-1/task-a', 'tests-failed', { project: 'off' })];
    const result = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', (project) => project !== 'off');
    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('ignores unrelated event types and a non-blocked gate outcome entirely', () => {
    const events: StoredEvent[] = [
      ev('session-start', {}),
      ev('gate-outcome', { outcome: 'pass' }, { task_id: 'epic-1/task-a' }),
      ev('task-added', { task_status: 'todo' }, { task_id: 'epic-1/task-b' }),
    ];
    const result = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', alwaysEnabled);
    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('renderBody carries the fingerprint line prefix used for dedup search', () => {
    const result = foldErrorEvents(
      [gateBlocked('epic-1/task-a', 'tests-failed')],
      '2026-01-06T00:00:00.000Z',
      alwaysEnabled,
    );
    const report = result.reports[0];
    if (!report) throw new Error('expected one report');
    expect(renderBody(toIssueBodyFields(report))).toContain(FINGERPRINT_LINE_PREFIX);
  });
});
