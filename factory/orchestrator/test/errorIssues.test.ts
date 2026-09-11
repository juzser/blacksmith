import { describe, expect, it } from 'vitest';
import {
  foldErrorEvents,
  GATE_BLOCKED_REASONS,
  type GateBlockedReason,
  renderBody,
  renderComment,
  renderTitle,
  toIssueBodyFields,
  toIssueCommentFields,
} from '../src/errorIssues.js';
import type { EventRecord, StoredEvent } from '../src/events.js';
import type { GateOutcome } from '../src/gate.js';

// Compile-time tie-back to gate.ts (AC4): `reason` isn't exported as a
// runtime value, so this ties GateBlockedReason to GateOutcome's blocked arm
// via a type-equality check -- `pnpm run typecheck:test` fails to compile
// this file if the two ever diverge.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
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

/** A hook-shaped rival that only watches `gate-outcome` and `task-added` in-process, missing hand-appended `error-logged` events entirely (AC1's differential). */
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
    // Read off errorIssues.ts's own table, not a second hand-typed list here.
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
    const events: StoredEvent[] = [errorLogged('epic-1/task-a', 'execution.test-failure')];
    // Attach `detail` after construction: what a real writer could log.
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
    const withExtra = foldErrorEvents([eventWithExtra], '2026-01-06T00:00:00.000Z', alwaysEnabled);

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
      [
        'epic_id',
        'fingerprint',
        'latest_event_id',
        'plan_version',
        'session_id',
        'timestamp',
      ].sort(),
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

  it('ignores unrelated event types and titles the report from task and error class', () => {
    const result = foldErrorEvents(
      [ev('session-start', {}), gateBlocked('epic-1/task-a', 'tests-failed')],
      '2026-01-06T00:00:00.000Z',
      alwaysEnabled,
    );
    expect(result.reports).toHaveLength(1);
    expect(result.skipped).toBe(0);
    const report = result.reports[0];
    if (!report) throw new Error('expected one report');
    expect(renderTitle(report)).toBe('epic-1/task-a: gate.blocked.tests-failed');
  });

  // Branch coverage for the remaining arms `toCandidate`, the reduce that
  // picks each fingerprint group's newest occurrence, and the null-epic
  // render path leave untouched by the acceptance-criterion tests above.

  it('a missing payload defaults to {} and is ignored as not-blocked (asString/payload fallback)', () => {
    const noPayload: StoredEvent = {
      event_id: 'e-no-payload',
      record: {
        session_id: 'session-1',
        actor: 'system',
        event_type: 'gate-outcome',
        plan_version: 1,
        causal_parent: null,
        payload: undefined as unknown as Record<string, unknown>,
        ts: '2026-01-01T00:00:00.000Z',
        task_id: 'epic-1/task-a',
      },
    };

    const result = foldErrorEvents([noPayload], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('a non-finite plan_version is treated as absent (asNumber rejects it)', () => {
    const event = gateBlocked('epic-1/task-a', 'tests-failed', {
      plan_version: Number.NaN,
    });

    const result = foldErrorEvents([event], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    const report = result.reports[0];
    if (!report) throw new Error('expected one report');
    expect(report.plan_version).toBeNull();

    const body = renderBody(toIssueBodyFields(report));
    const comment = renderComment(toIssueCommentFields(report));
    expect(body).toContain('Plan version: (unknown)');
    expect(comment).toContain('Plan version: (unknown)');
  });

  it('a gate-outcome that is not blocked is ignored, not folded', () => {
    const notBlocked = ev('gate-outcome', { outcome: 'passed' }, { task_id: 'epic-1/task-a' });

    const result = foldErrorEvents([notBlocked], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('a blocked gate-outcome missing task_id is malformed and skipped', () => {
    const malformed = ev('gate-outcome', { outcome: 'blocked', reason: 'tests-failed' }, {});

    const result = foldErrorEvents([malformed], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('a blocked gate-outcome with a reason outside the ten-string vocabulary is malformed and skipped', () => {
    const unknownReason = gateBlocked('epic-1/task-a', 'not-a-real-reason');

    const result = foldErrorEvents([unknownReason], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('error-logged falls back to payload.task_ref when the event carries no task_id', () => {
    const event = ev(
      'error-logged',
      { error: 'execution.test-failure', severity: 'S2-major', task_ref: 'epic-1/task-a' },
      {},
    );

    const result = foldErrorEvents([event], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    const report = result.reports[0];
    if (!report) throw new Error('expected one report');
    expect(report.task_ref).toBe('epic-1/task-a');
  });

  it('a task-added event whose task_status is not failed is ignored', () => {
    const notFailed = ev(
      'task-added',
      { task_status: 'in-progress' },
      { task_id: 'epic-1/task-a' },
    );

    const result = foldErrorEvents([notFailed], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('a failed task-added event missing task_id is malformed and skipped', () => {
    const malformed = ev('task-added', { task_status: 'failed' }, {});

    const result = foldErrorEvents([malformed], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('a failed task-added event with no epic_id folds with a null epic, rendered as (none)', () => {
    const event = ev('task-added', { task_status: 'failed' }, { task_id: 'epic-1/task-a' });

    const result = foldErrorEvents([event], '2026-01-06T00:00:00.000Z', alwaysEnabled);

    const report = result.reports[0];
    if (!report) throw new Error('expected one report');
    expect(report.epic_id).toBeNull();

    const body = renderBody(toIssueBodyFields(report));
    const comment = renderComment(toIssueCommentFields(report));
    expect(body).toContain('Epic: (none)');
    expect(comment).toContain('Epic: (none)');
  });

  it('drops candidates from a disabled project while keeping enabled ones', () => {
    const events: StoredEvent[] = [
      gateBlocked('epic-1/task-a', 'tests-failed', { project: 'enabled-proj' }),
      gateBlocked('epic-1/task-b', 'tests-failed', { project: 'disabled-proj' }),
    ];
    const isProjectEnabled = (project: string) => project === 'enabled-proj';

    const result = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', isProjectEnabled);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.project).toBe('enabled-proj');
  });

  it('the latest-occurrence reduce picks the newest ts, and breaks ties on event id', () => {
    // Same fingerprint group (same project/source/error_class/task_ref),
    // fed out of chronological order so the reduce must reject an earlier
    // `b` (accumulator stays `a`), then break a tied timestamp on event id
    // both ways: `b` wins when its id sorts later, `a` stays when it does not.
    const events: StoredEvent[] = [
      gateBlocked('epic-1/task-a', 'tests-failed', {
        eventId: 'e-2',
        ts: '2026-01-03T00:00:00.000Z',
      }),
      gateBlocked('epic-1/task-a', 'tests-failed', {
        eventId: 'e-1',
        ts: '2026-01-01T00:00:00.000Z',
      }),
      gateBlocked('epic-1/task-a', 'tests-failed', {
        eventId: 'e-3',
        ts: '2026-01-03T00:00:00.000Z',
      }),
      gateBlocked('epic-1/task-a', 'tests-failed', {
        eventId: 'a-0',
        ts: '2026-01-03T00:00:00.000Z',
      }),
    ];

    const result = foldErrorEvents(events, '2026-01-06T00:00:00.000Z', alwaysEnabled);

    expect(result.reports).toHaveLength(4);
    // Newest ts is 2026-01-03; among the three sharing it, 'e-3' sorts
    // after both 'e-2' and 'a-0' lexicographically.
    expect(result.reports.every((r) => r.latest_event_id === 'e-3')).toBe(true);
  });
});
