import { describe, expect, it } from 'vitest';
import type { EscalationRung } from '../src/budgets.js';
import { parseBudgetPolicy } from '../src/budgets.js';
import { checkEscalationLadder, escalationRungFor, readFailedRounds } from '../src/escalation.js';
import type { StoredEvent } from '../src/events.js';

// ---------------------------------------------------------------------------
// P9-32. budgets.yml has declared the escalation ladder since Phase 1 — "2
// failed rounds -> escalate model tier, 3 -> escalate to the operator, rungs
// never skipped and never looped past their bound" — and nothing read it.
// budgets.ts said so in its own header: `escalation_ladder` is "still
// prompt-level ... nothing here parses them". So a task could fail four rounds
// on sonnet with the operator never told, and the log would look the same as a
// task that escalated correctly.
//
// This is the dispatchAudit.ts shape applied to that gap: a pure module over
// the event log, four-valued statuses, fail-closed (`unverifiable` fails the
// report exactly like `violation`), and an explicit `not-applicable` so a rung
// that never tripped is stated rather than silently dropped.
// ---------------------------------------------------------------------------

const LADDER: EscalationRung[] = [
  {
    rung: 1,
    failedRounds: 1,
    trigger: 'bounded retry on the same contract',
    action: null,
    enforce: null,
  },
  {
    rung: 2,
    failedRounds: 2,
    trigger: '2 failed rounds on the same task',
    action: 'escalate model tier automatically (sonnet -> opus), logged',
    enforce: 'model-tier',
  },
  {
    rung: 3,
    failedRounds: 3,
    trigger: '3 failed rounds on the same task',
    action: 'escalate to operator',
    enforce: 'operator',
  },
];

let seq = 0;
function ts(): string {
  const n = seq++;
  return `2026-08-09T10:${String(n).padStart(2, '0')}:00.000Z`;
}

function stored(
  eventType: string,
  payload: Record<string, unknown>,
  taskId: string | null = 'epic-1/task-1',
): StoredEvent {
  const n = seq;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'system',
      event_type: eventType,
      ...(taskId === null ? {} : { task_id: taskId }),
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: ts(),
      payload,
    },
  };
}

/** A failed round: the gate blocked this task (gate.ts emits gate-outcome). */
function blocked(taskId = 'epic-1/task-1', reason = 'tests-failed'): StoredEvent {
  return stored('gate-outcome', { outcome: 'blocked', reason }, taskId);
}

function passed(taskId = 'epic-1/task-1'): StoredEvent {
  return stored('gate-outcome', { outcome: 'pass', reason: null }, taskId);
}

function dispatch(
  role: string,
  modelTier: string | null,
  taskId: string | null = 'epic-1/task-1',
): StoredEvent {
  return stored(
    'dispatch_decision',
    {
      agent_role: role,
      provider: 'claude',
      model: 'claude-sonnet-5',
      ...(modelTier === null ? {} : { model_tier: modelTier }),
    },
    taskId,
  );
}

function operatorAnswer(): StoredEvent {
  return stored('user_prompt', { text: 'take the tier up and retry' }, null);
}

const OPTS = { sessionId: 'sess-1' };

describe('parseBudgetPolicy — escalation_ladder', () => {
  it('parses the rungs budgets.yml declares, sorted by trigger threshold', () => {
    const policy = parseBudgetPolicy(`
escalation_ladder:
  rungs:
    - rung: 3
      trigger: 3 failed rounds on the same task
      failed_rounds: 3
      enforce: operator
      action: escalate to operator
    - rung: 1
      trigger: bounded retry on the same contract
      failed_rounds: 1
    - rung: 2
      trigger: 2 failed rounds on the same task
      failed_rounds: 2
      enforce: model-tier
      action: escalate model tier automatically (sonnet -> opus), logged
`);
    expect(policy.escalationLadder.map((r) => r.rung)).toEqual([1, 2, 3]);
    expect(policy.escalationLadder[0]).toEqual({
      rung: 1,
      failedRounds: 1,
      trigger: 'bounded retry on the same contract',
      action: null,
      enforce: null,
    });
    expect(policy.escalationLadder[1]?.enforce).toBe('model-tier');
    expect(policy.escalationLadder[2]?.action).toBe('escalate to operator');
  });

  it('keeps a rung whose failed_rounds is missing rather than dropping it', () => {
    const policy = parseBudgetPolicy(`
escalation_ladder:
  rungs:
    - rung: 2
      trigger: two failed rounds, someday
      action: escalate model tier
`);
    expect(policy.escalationLadder).toHaveLength(1);
    expect(policy.escalationLadder[0]?.failedRounds).toBeNull();
  });

  it('defaults to an empty ladder — a missing policy is not a satisfied one', () => {
    expect(parseBudgetPolicy('epic:\n  cap_tokens: 10\n').escalationLadder).toEqual([]);
  });

  it('reads the real factory/policies/budgets.yml as three enforceable rungs', async () => {
    const { loadBudgetPolicy } = await import('../src/budgets.js');
    const ladder = loadBudgetPolicy().escalationLadder;
    expect(ladder.map((r) => [r.rung, r.failedRounds, r.enforce])).toEqual([
      [1, 1, null],
      [2, 2, 'model-tier'],
      [3, 3, 'operator'],
    ]);
  });
});

describe('readFailedRounds', () => {
  it('counts blocked gate outcomes and ignores passes and other events', () => {
    seq = 0;
    const rounds = readFailedRounds([blocked(), passed(), dispatch('coder', 'mid'), blocked()]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.reason).toBe('tests-failed');
    expect(rounds.every((r) => r.taskId === 'epic-1/task-1')).toBe(true);
  });

  it('keeps each task’s rounds separate', () => {
    seq = 0;
    const rounds = readFailedRounds([
      blocked('epic-1/task-1'),
      blocked('epic-1/task-2'),
      blocked('epic-1/task-1'),
    ]);
    expect(rounds.filter((r) => r.taskId === 'epic-1/task-1')).toHaveLength(2);
    expect(rounds.filter((r) => r.taskId === 'epic-1/task-2')).toHaveLength(1);
  });
});

describe('escalationRungFor', () => {
  it('returns the highest rung the failure count has reached', () => {
    expect(escalationRungFor(0, LADDER)).toBeNull();
    expect(escalationRungFor(1, LADDER)?.rung).toBe(1);
    expect(escalationRungFor(2, LADDER)?.rung).toBe(2);
    expect(escalationRungFor(7, LADDER)?.rung).toBe(3);
  });
});

describe('checkEscalationLadder', () => {
  it('reports not-applicable for a session with no failed rounds', () => {
    seq = 0;
    const report = checkEscalationLadder([passed(), dispatch('coder', 'mid')], LADDER, OPTS);
    expect(report.roundsExamined).toBe(0);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe('not-applicable');
    expect(report.ok).toBe(true);
  });

  it('is unverifiable when the policy declares no rungs at all', () => {
    seq = 0;
    const report = checkEscalationLadder([blocked()], [], OPTS);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('rung 1 asserts nothing: a bounded retry leaves no evidence to check', () => {
    seq = 0;
    const report = checkEscalationLadder([blocked(), dispatch('coder', 'mid')], LADDER, OPTS);
    expect(report.checks.map((c) => c.rung)).toEqual([1]);
    expect(report.checks[0]?.status).toBe('not-applicable');
    expect(report.ok).toBe(true);
  });

  it('rung 2 passes when the retry after the second failure moves up a tier', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'frontier'),
      ],
      LADDER,
      OPTS,
    );
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('ok');
    expect(rung2?.failedRounds).toBe(2);
    expect(report.ok).toBe(true);
  });

  it('rung 2 is a violation when the third round runs on the same tier', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'mid'),
      ],
      LADDER,
      OPTS,
    );
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('violation');
    expect(rung2?.detail).toContain('mid');
    expect(report.ok).toBe(false);
  });

  it('rung 2 counts only builder dispatches — a judge rerun is not a retry', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('reviewer', 'mid'),
        dispatch('coder', 'frontier'),
      ],
      LADDER,
      OPTS,
    );
    expect(report.checks.find((c) => c.rung === 2)?.status).toBe('ok');
  });

  it('rung 2 is not-applicable when the task was never dispatched again', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [dispatch('coder', 'mid'), blocked(), dispatch('coder', 'mid'), blocked()],
      LADDER,
      OPTS,
    );
    expect(report.checks.find((c) => c.rung === 2)?.status).toBe('not-applicable');
    expect(report.ok).toBe(true);
  });

  it('rung 2 is not-applicable when the failing round already ran at the top tier', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'frontier'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
        dispatch('coder', 'frontier'),
      ],
      LADDER,
      OPTS,
    );
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('not-applicable');
    expect(rung2?.detail).toContain('frontier');
  });

  it('rung 2 is unverifiable when a dispatch records no model_tier', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', null),
      ],
      LADDER,
      OPTS,
    );
    expect(report.checks.find((c) => c.rung === 2)?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  // The dogfood-envkit-1 log is exactly this shape: task-1b-parse-quotes
  // blocked twice and then passed, with no dispatch_decision event anywhere
  // for the task. It plainly ran a third round; the log just cannot say on
  // what tier. Reporting that as "never dispatched again" would turn a hole in
  // the record into a clean bill of health.
  it('rung 2 is unverifiable when a later round is evidenced but no dispatch is', () => {
    seq = 0;
    const report = checkEscalationLadder([blocked(), blocked(), passed()], LADDER, OPTS);
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('rung 3 is a violation when a later round happened with no operator answer', () => {
    seq = 0;
    const report = checkEscalationLadder([blocked(), blocked(), blocked(), passed()], LADDER, OPTS);
    expect(report.checks.find((c) => c.rung === 3)?.status).toBe('violation');
    expect(report.ok).toBe(false);
  });

  it('rung 2 is unverifiable when no builder dispatch preceded the failure', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [blocked(), blocked(), dispatch('coder', 'mid')],
      LADDER,
      OPTS,
    );
    expect(report.checks.find((c) => c.rung === 2)?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('rung 3 holds when the factory stops dispatching after the third failure', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
      ],
      LADDER,
      OPTS,
    );
    const rung3 = report.checks.find((c) => c.rung === 3);
    expect(rung3?.status).toBe('ok');
    expect(rung3?.failedRounds).toBe(3);
    expect(report.ok).toBe(true);
  });

  it('rung 3 is a violation when a fourth round runs with no operator answer', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
        dispatch('coder', 'frontier'),
      ],
      LADDER,
      OPTS,
    );
    expect(report.checks.find((c) => c.rung === 3)?.status).toBe('violation');
    expect(report.ok).toBe(false);
  });

  it('rung 3 holds when the operator answered before the fourth round', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
        dispatch('coder', 'frontier'),
        blocked(),
        operatorAnswer(),
        dispatch('coder', 'frontier'),
      ],
      LADDER,
      OPTS,
    );
    expect(report.checks.find((c) => c.rung === 3)?.status).toBe('ok');
    expect(report.ok).toBe(true);
  });

  it('a rung declaring an action with no enforce keyword is unverifiable, not advisory', () => {
    seq = 0;
    const ladder: EscalationRung[] = [
      { rung: 2, failedRounds: 2, trigger: 'two', action: 'do something', enforce: null },
    ];
    const report = checkEscalationLadder([blocked(), blocked()], ladder, OPTS);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('a rung with an unknown enforce keyword is unverifiable', () => {
    seq = 0;
    const ladder: EscalationRung[] = [
      { rung: 2, failedRounds: 2, trigger: 'two', action: 'x', enforce: 'telepathy' },
    ];
    const report = checkEscalationLadder([blocked(), blocked()], ladder, OPTS);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('a rung with no numeric threshold is unverifiable rather than skipped', () => {
    seq = 0;
    const ladder: EscalationRung[] = [
      {
        rung: 2,
        failedRounds: null,
        trigger: 'someday',
        action: 'escalate',
        enforce: 'model-tier',
      },
    ];
    const report = checkEscalationLadder([blocked()], ladder, OPTS);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('a blocked round with no task id cannot join any ladder and is reported', () => {
    seq = 0;
    const orphan = stored('gate-outcome', { outcome: 'blocked', reason: 'tests-failed' }, null);
    const report = checkEscalationLadder([orphan], LADDER, OPTS);
    expect(report.checks.some((c) => c.status === 'unverifiable')).toBe(true);
    expect(report.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // D-249. The block above reports a blocked round that names no task, on the
  // rule it states itself: dropping it "would shrink the audit to fit the
  // damage". A builder DISPATCH that names no task was dropped instead --
  // filtered out per task by `d.taskId !== null` and counted nowhere -- and
  // the two hide different things. A round the audit loses is a round it
  // cannot judge; a dispatch it loses is the retry that a rung is judged BY,
  // so losing it does not weaken the answer, it inverts it.
  //
  // Both dogfood-demo-rpg-1#263 (tester) and #418 (coder) are real: 2 of the
  // session's 20 builder dispatches carry no task id, and the audit's report
  // named neither.
  // -------------------------------------------------------------------------

  it('a builder dispatch with no task id is reported, not dropped', () => {
    seq = 0;
    // Two failed rounds trip rung 2, then the retry that answers it is
    // dispatched on the SAME tier -- a violation -- but names no task. With
    // that dispatch dropped the rung reads "never exercised", which is
    // not-applicable, which counts as OK: the ladder was skipped and the
    // audit exits 0.
    const events = [dispatch('coder', 'mid'), blocked(), blocked(), dispatch('coder', 'mid', null)];
    const report = checkEscalationLadder(events, LADDER, OPTS);
    expect(report.checks.some((c) => c.status === 'unverifiable')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('reports it under --task too, because the dispatch could be that task\u2019s', () => {
    seq = 0;
    // Scoping drops a dispatch whose task id is null before any task sees it,
    // so the one question `--task` exists to answer -- did THIS task climb the
    // ladder -- is answered from a set the audit knows is short.
    const events = [dispatch('coder', 'mid'), blocked(), blocked(), dispatch('coder', 'mid', null)];
    const report = checkEscalationLadder(events, LADDER, { ...OPTS, taskId: 'epic-1/task-1' });
    expect(report.checks.some((c) => c.status === 'unverifiable')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('leaves an epic-level role alone: a planner dispatch owes no task id', () => {
    seq = 0;
    // The population is builder roles only. A planner, a spec-reviewer and a
    // scribe are dispatched for the epic and never carried a task id, so
    // reporting them would make every honest run unverifiable.
    const events = [dispatch('planner', 'frontier', null), dispatch('coder', 'mid'), passed()];
    const report = checkEscalationLadder(events, LADDER, OPTS);
    expect(report.checks.every((c) => c.status !== 'unverifiable')).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('scopes to one task when asked, and each task climbs its own ladder', () => {
    seq = 0;
    const events = [
      dispatch('coder', 'mid', 'epic-1/task-1'),
      blocked('epic-1/task-1'),
      dispatch('coder', 'mid', 'epic-1/task-1'),
      blocked('epic-1/task-1'),
      dispatch('coder', 'mid', 'epic-1/task-1'),
      dispatch('coder', 'mid', 'epic-1/task-2'),
      blocked('epic-1/task-2'),
    ];
    const all = checkEscalationLadder(events, LADDER, OPTS);
    expect(all.checks.filter((c) => c.taskId === 'epic-1/task-1').map((c) => c.rung)).toEqual([
      1, 2,
    ]);
    expect(all.checks.filter((c) => c.taskId === 'epic-1/task-2').map((c) => c.rung)).toEqual([1]);
    expect(all.ok).toBe(false); // task-1 retried on the same tier

    const scoped = checkEscalationLadder(events, LADDER, { ...OPTS, taskId: 'epic-1/task-2' });
    expect(scoped.checks.every((c) => c.taskId === 'epic-1/task-2')).toBe(true);
    expect(scoped.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-181. The same task is written both ways in the real logs — qualified
// "<epic>/<task>" and bare "<task>" — and taskId.ts exists because of exactly
// that (D-130/D-143). This module compared raw, so one task's rounds split
// into two ladders: the real one undercounted, and a phantom one that reported
// `not-applicable` ("neither dispatched again nor reached the gate again")
// while the dispatches sat under the other spelling. `not-applicable` counts
// as OK, so the phantom half of a violated ladder passed the audit.
// ---------------------------------------------------------------------------
describe('checkEscalationLadder — task-id spelling (D-181)', () => {
  it('counts both spellings of one task as one ladder', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid', 'epic-1/task-1'),
        blocked('epic-1/task-1'),
        dispatch('coder', 'mid', 'epic-1/task-1'),
        blocked('task-1'),
        dispatch('coder', 'mid', 'epic-1/task-1'),
        blocked('epic-1/task-1'),
      ],
      LADDER,
      OPTS,
    );
    expect([...new Set(report.checks.map((c) => c.taskId))]).toEqual(['epic-1/task-1']);
    expect(report.checks.map((c) => c.rung)).toEqual([1, 2, 3]);
    expect(report.checks.map((c) => c.failedRounds)).toEqual([3, 3, 3]);
  });

  it('does not report a bare-spelled round as a task that never ran again', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [
        dispatch('coder', 'mid', 'epic-1/task-1'),
        blocked('task-1'),
        blocked('task-1'),
        dispatch('coder', 'mid', 'epic-1/task-1'),
        passed('epic-1/task-1'),
      ],
      LADDER,
      OPTS,
    );
    expect(report.checks.filter((c) => c.detail.includes('never exercised'))).toEqual([]);
    // Two rounds on mid, retried on mid: the tier rung was exercised and lost.
    expect(report.checks.find((c) => c.rung === 2)?.status).toBe('violation');
    expect(report.ok).toBe(false);
  });

  it('refuses to attribute a bare round when two epics hold that bare name', () => {
    seq = 0;
    const report = checkEscalationLadder(
      [blocked('epic-1/task-1'), blocked('epic-2/task-1'), blocked('task-1')],
      LADDER,
      OPTS,
    );
    const ambiguous = report.checks.find((c) => c.status === 'unverifiable');
    expect(ambiguous?.detail).toContain('task-1');
    expect(ambiguous?.failedRounds).toBe(1);
    expect(
      report.checks.filter((c) => c.taskId === 'epic-1/task-1').map((c) => c.failedRounds),
    ).toEqual([1]);
    expect(
      report.checks.filter((c) => c.taskId === 'epic-2/task-1').map((c) => c.failedRounds),
    ).toEqual([1]);
    expect(report.ok).toBe(false);
  });

  it('scopes by either spelling, and still keeps two epics apart', () => {
    seq = 0;
    const events = [
      dispatch('coder', 'mid', 'epic-1/task-1'),
      blocked('epic-1/task-1'),
      blocked('task-1'),
      blocked('epic-2/task-1'),
    ];
    const bare = checkEscalationLadder(events, LADDER, { ...OPTS, taskId: 'task-1' });
    const qualified = checkEscalationLadder(events, LADDER, { ...OPTS, taskId: 'epic-1/task-1' });
    expect(bare.roundsExamined).toBe(3);
    expect(qualified.roundsExamined).toBe(2);
    expect([...new Set(qualified.checks.map((c) => c.taskId))]).toEqual(['epic-1/task-1']);
  });
});

// ---------------------------------------------------------------------------
// A round and the retry that answers it can land in one millisecond.
//
// appendEvent stamps `new Date().toISOString()`, so `ts` resolves to the
// millisecond and two writes in one tick share it. The gate writes
// `gate-outcome` and the orchestrator writes the retry's `dispatch_decision`
// back to back, which is exactly the pair that ties — and every neighbour
// finder in this module used to answer with a bare `<` or `>` on `ts`, so a
// tie was not a decision, it was whichever side the operator happened to fall.
//
// The damage is the D-249 inversion from a different cause. A retry the log
// plainly holds is dropped by `dispatchAfter` and picked up by
// `dispatchBefore` as the round's OWN dispatch, and the rung then reports
// "neither dispatched again nor reached the gate again" — `not-applicable`,
// which counts as OK. A ladder skipped on the same tier exits 0.
// ---------------------------------------------------------------------------

/**
 * `event`, restamped to the millisecond of one written earlier.
 *
 * The tie is built by copying a fixture's own `ts` rather than hand-writing
 * one, so the timestamp and the event id cannot drift apart about which event
 * the log wrote first — the id's index is the only thing left that knows.
 */
function sameMsAs(earlier: StoredEvent, event: StoredEvent): StoredEvent {
  return { ...event, record: { ...event.record, ts: earlier.record.ts } };
}

/** A judge dispatch: no builder role, so nothing here counts it as a round. */
function filler(): StoredEvent {
  return dispatch('reviewer', 'mid');
}

describe('checkEscalationLadder — a round and its retry in one millisecond', () => {
  it('rung 2 passes when the tier went up in the failed round’s own millisecond', () => {
    seq = 0;
    const opening = [dispatch('coder', 'mid'), blocked(), dispatch('coder', 'mid')];
    const round = blocked();
    const retry = sameMsAs(round, dispatch('coder', 'frontier'));
    const report = checkEscalationLadder([...opening, round, retry], LADDER, OPTS);
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('ok');
    expect(rung2?.detail).toBe('Retried on frontier after failing on mid.');
    expect(report.ok).toBe(true);
  });

  it('rung 2 is a violation when the same-millisecond retry stayed on the tier', () => {
    seq = 0;
    const opening = [dispatch('coder', 'mid'), blocked(), dispatch('coder', 'mid')];
    const round = blocked();
    const retry = sameMsAs(round, dispatch('coder', 'mid'));
    const report = checkEscalationLadder([...opening, round, retry], LADDER, OPTS);
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('violation');
    expect(report.ok).toBe(false);
  });

  it('rung 2 reads the tier off a same-millisecond retry rather than calling it unrecorded', () => {
    seq = 0;
    const opening = [dispatch('coder', 'mid'), blocked(), dispatch('coder', 'mid')];
    const round = blocked();
    const retry = sameMsAs(round, dispatch('coder', 'frontier'));
    const report = checkEscalationLadder([...opening, round, retry, passed()], LADDER, OPTS);
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('ok');
    expect(rung2?.detail).toBe('Retried on frontier after failing on mid.');
  });

  it('rung 3 is a violation when the task was dispatched again in the third round’s millisecond', () => {
    seq = 0;
    const opening = [
      dispatch('coder', 'mid'),
      blocked(),
      dispatch('coder', 'frontier'),
      blocked(),
      dispatch('coder', 'frontier'),
    ];
    const round = blocked();
    const retry = sameMsAs(round, dispatch('coder', 'frontier'));
    const report = checkEscalationLadder([...opening, round, retry], LADDER, OPTS);
    expect(report.checks.find((c) => c.rung === 3)?.status).toBe('violation');
    expect(report.ok).toBe(false);
  });

  it('rung 3 holds when the operator’s answer shares a millisecond with the retry it released', () => {
    seq = 0;
    const opening = [
      dispatch('coder', 'mid'),
      blocked(),
      dispatch('coder', 'frontier'),
      blocked(),
      dispatch('coder', 'frontier'),
      blocked(),
    ];
    const answer = operatorAnswer();
    const retry = sameMsAs(answer, dispatch('coder', 'frontier'));
    const report = checkEscalationLadder([...opening, answer, retry], LADDER, OPTS);
    expect(report.checks.find((c) => c.rung === 3)?.status).toBe('ok');
    expect(report.ok).toBe(true);
  });

  // Which carry-on the bound is measured against is its own question. When the
  // gate ran again and a dispatch answered it inside one millisecond, the
  // operator's answer can land between the two, and only the earlier one is the
  // moment the factory stopped waiting. Measured against the later one the
  // answer looks like it arrived in time, and a breached bound reports `ok`.
  it('rung 3 measures the bound against the first carry-on, not the last', () => {
    seq = 0;
    const opening = [
      dispatch('coder', 'mid'),
      blocked(),
      dispatch('coder', 'frontier'),
      blocked(),
      dispatch('coder', 'frontier'),
      blocked(),
    ];
    const resumed = passed();
    const answer = sameMsAs(resumed, operatorAnswer());
    const retry = sameMsAs(resumed, dispatch('coder', 'frontier'));
    const report = checkEscalationLadder([...opening, resumed, answer, retry], LADDER, OPTS);
    const rung3 = report.checks.find((c) => c.rung === 3);
    expect(rung3?.status).toBe('violation');
    expect(report.ok).toBe(false);
  });

  // The index behind the event id has to be read as a number. Ordered as text
  // — the shape a tiebreak on the raw id would take — `sess-1#10` sorts before
  // `sess-1#9`, so the retry moves to the wrong side of the round and the rung
  // inverts, but only once a session's log passes ten events. Six inert judge
  // dispatches put this tie there; the five rows above all tie under index 10
  // and would pass a fix that compared the ids as strings.
  it('breaks the tie on the log index as a number, past the log’s tenth event', () => {
    seq = 0;
    const opening = [
      dispatch('coder', 'mid'),
      blocked(),
      dispatch('coder', 'mid'),
      filler(),
      filler(),
      filler(),
      filler(),
      filler(),
      filler(),
    ];
    const round = blocked();
    const retry = sameMsAs(round, dispatch('coder', 'frontier'));
    expect([round.event_id, retry.event_id]).toEqual(['sess-1#9', 'sess-1#10']);
    const report = checkEscalationLadder([...opening, round, retry], LADDER, OPTS);
    const rung2 = report.checks.find((c) => c.rung === 2);
    expect(rung2?.status).toBe('ok');
    expect(rung2?.detail).toBe('Retried on frontier after failing on mid.');
  });
});
