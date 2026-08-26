import { describe, expect, it } from 'vitest';
import { checkBudgetAlarm, readEpicMembership, readMeasuredSpend } from '../src/budgetAlarm.js';
import type { BudgetPolicy } from '../src/budgets.js';
import type { StoredEvent } from '../src/events.js';

// ---------------------------------------------------------------------------
// P9-33. `epic.alarm_ratio` has been in budgets.yml since Phase 1 and D-12
// found its runtime host to be "no": parsed into BudgetPolicy, asserted in
// budgets.test.ts, read by no production path. Its only real consumer was a
// sentence in SKILL.md telling a human to eyeball it.
//
// This is that consumer. It is a measurement, not an obligation, so the shape
// differs from dispatchAudit.ts/escalation.ts in one way that matters:
// unmeasured spend is monotone. Every hole in the record can only make the
// bill bigger, so a threshold crossing is a fact and a non-crossing is a claim
// about the record rather than about the world.
// ---------------------------------------------------------------------------

const POLICY: BudgetPolicy = {
  epic: { capTokens: 1_000_000, alarmRatio: 0.7, maxInFlightTasks: null },
  task: {
    coder: { capTokens: 150_000, capDiffLines: 400 },
    researcher: { capTokens: 60_000 },
    judges: { capTokens: 40_000 },
  },
  preCodeBudget: { shareOfEpicBudgetMax: 0.15 },
  escalationLadder: [],
};

const OPTS = { sessionId: 'sess-1' };

let seq = 0;

function ts(): string {
  return `2026-08-10T10:${String(seq).padStart(2, '0')}:00.000Z`;
}

function stored(eventType: string, payload: Record<string, unknown>, taskId?: string): StoredEvent {
  const n = seq++;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'system',
      event_type: eventType,
      ...(taskId === undefined ? {} : { task_id: taskId }),
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: ts(),
      payload,
    },
  };
}

/** A wave admitting `taskIds` to `epicId` — the log's own membership record. */
function waveAdmitted(epicId: string, taskIds: string[]): StoredEvent {
  return stored('wave-admitted', { epic_id: epicId, wave: 1, task_ids: taskIds });
}

function result(taskId: string, totalTokens: number): StoredEvent {
  return stored('task-result-recorded', { token_usage: { total_tokens: totalTokens } }, taskId);
}

function budgetCheck(taskId: string, tokensUsed: number): StoredEvent {
  return stored('budget-check-result', { status: 'checked', overruns: [], tokensUsed }, taskId);
}

function dispatch(role: string, taskId?: string): StoredEvent {
  return stored('dispatch_decision', { agent_role: role, provider: 'claude' }, taskId);
}

/** A dispatch naming its task only in the payload — dogfood's shape for 15 of 19. */
function payloadOnlyDispatch(role: string, taskId: string): StoredEvent {
  return stored('dispatch_decision', { agent_role: role, provider: 'claude', task_id: taskId });
}

describe('readEpicMembership', () => {
  it('reads a task -> epic edge from a qualified task id', () => {
    seq = 0;
    const map = readEpicMembership([result('epic-1/task-1', 10)]);
    expect(map.get('epic-1/task-1')).toBe('epic-1');
  });

  it('reads a bare task id from the wave that admitted it', () => {
    seq = 0;
    const map = readEpicMembership([waveAdmitted('epic-1', ['task-1'])]);
    expect(map.get('task-1')).toBe('epic-1');
  });

  it('indexes a qualified admission under its bare id too', () => {
    // dogfood-envkit-1 wave 1 admitted `envkit-config-loader/task-0-toolchain`
    // and every dispatch for it was recorded under the bare `task-0-toolchain`
    // (D-14). A map keyed only on the admitted spelling attributes none of them.
    seq = 0;
    const map = readEpicMembership([waveAdmitted('epic-1', ['epic-1/task-1'])]);
    expect(map.get('epic-1/task-1')).toBe('epic-1');
    expect(map.get('task-1')).toBe('epic-1');
  });

  it('has no entry for a task id no trace attributes', () => {
    seq = 0;
    const map = readEpicMembership([dispatch('coder', 'task-9')]);
    expect(map.has('task-9')).toBe(false);
  });
});

describe('readMeasuredSpend', () => {
  it('sums task-result-recorded token_usage', () => {
    seq = 0;
    const spend = readMeasuredSpend([result('task-1', 12_000)]);
    expect(spend.get('task-1')).toBe(12_000);
  });

  it('reads budget-check-result when no result event carries the number', () => {
    seq = 0;
    const spend = readMeasuredSpend([budgetCheck('task-1', 9_000)]);
    expect(spend.get('task-1')).toBe(9_000);
  });

  it('takes the larger of the two traces rather than their sum', () => {
    // Both describe the same spend — the gate reads tokensUsed off the very
    // result it is checking. Adding them would double the bill; taking either
    // one alone would read zero whenever that trace is the missing one.
    seq = 0;
    const spend = readMeasuredSpend([result('task-1', 12_000), budgetCheck('task-1', 12_000)]);
    expect(spend.get('task-1')).toBe(12_000);
  });

  it('ignores a result that carries no token_usage', () => {
    seq = 0;
    const spend = readMeasuredSpend([stored('task-result-recorded', {}, 'task-1')]);
    expect(spend.has('task-1')).toBe(false);
  });
});

describe('checkBudgetAlarm', () => {
  it('is under the alarm when measured and projected spend both are', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 100_000), dispatch('coder', 'task-1')],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.epicId).toBe('epic-1');
    expect(epic?.measuredTokens).toBe(100_000);
    expect(epic?.status).toBe('under');
    expect(report.ok).toBe(true);
  });

  it('fires the alarm when measured spend alone crosses alarmRatio * capTokens', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 700_000), dispatch('coder', 'task-1')],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.status).toBe('alarm');
    expect(report.epics[0]?.alarmTokens).toBe(700_000);
    expect(report.ok).toBe(false);
  });

  it('reports over-cap separately from the alarm', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 1_000_000),
        dispatch('coder', 'task-1'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.status).toBe('over-cap');
    expect(report.ok).toBe(false);
  });

  it('prices judge dispatches from the declared cap — they never reach a task result', () => {
    // A judge produces findings, not a Result, so its tokens are in no
    // task-result-recorded event and never will be. Leaving them at zero is
    // what let D-9's ~1.6M epic read as 545k.
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 100_000),
        dispatch('coder', 'task-1'),
        dispatch('reviewer', 'task-1'),
        dispatch('grader', 'task-1'),
      ],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.measuredTokens).toBe(100_000);
    expect(epic?.projectedTokens).toBe(180_000);
    expect(epic?.projectedFrom).toEqual({ reviewer: 40_000, grader: 40_000 });
  });

  it('is at-risk when the projection crosses the alarm and measured spend does not', () => {
    // The D-9 shape exactly: the visible half of the bill reads comfortably
    // under while the whole bill does not.
    seq = 0;
    const judges = Array.from({ length: 16 }, () => dispatch('reviewer', 'task-1'));
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 100_000),
        dispatch('coder', 'task-1'),
        ...judges,
      ],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.measuredTokens).toBe(100_000);
    expect(epic?.projectedTokens).toBe(740_000);
    expect(epic?.status).toBe('at-risk');
    expect(report.ok).toBe(false);
  });

  it('projects an unmeasured coder dispatch at the coder cap', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), dispatch('coder', 'task-1')],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.measuredTokens).toBe(0);
    expect(epic?.projectedTokens).toBe(150_000);
    expect(epic?.projectedFrom).toEqual({ coder: 150_000 });
  });

  it('does not project the one worker dispatch the measured result paid for', () => {
    // The other half of D-171: a task dispatched once, with that dispatch's
    // tokens in the result, must not be billed twice. Widening the projection
    // to every worker dispatch would do exactly that.
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 120_000), dispatch('coder', 'task-1')],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.projectedTokens).toBe(120_000);
    expect(epic?.projectedFrom).toEqual({});
  });

  it('projects a re-dispatched worker round the measured max discarded (D-171)', () => {
    // readMeasuredSpend keeps the largest spend-bearing event per task, so a
    // task dispatched twice puts one round into `measuredTokens`. The other
    // round's tokens are in the log all the same — 300,000 of them here — and
    // a skip keyed on the task kept them out of the projection too. In
    // neither bound, 900,000 recorded tokens reported as under a 700,000
    // alarm: the ceiling was not a ceiling.
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 600_000),
        dispatch('coder', 'task-1'),
        result('task-1', 300_000),
        dispatch('coder', 'task-1'),
      ],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.measuredTokens).toBe(600_000);
    expect(epic?.projectedTokens).toBe(750_000);
    expect(epic?.status).toBe('at-risk');
    expect(report.ok).toBe(false);
  });

  it('accounts for exactly one worker dispatch per measured task (D-171)', () => {
    // One measured number per task accounts for one dispatch, not for every
    // dispatch the task ever had. Two re-dispatches, two coder caps.
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 10_000),
        dispatch('coder', 'task-1'),
        dispatch('coder', 'task-1'),
        dispatch('coder', 'task-1'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.projectedFrom).toEqual({ coder: 300_000 });
  });

  it('is unverifiable when a dispatched role has no declared cap', () => {
    // budgets.yml prices coder, researcher and four named judges. The factory
    // also dispatches security-reviewer, merger, tester and uiux. A role the
    // policy is silent about cannot be projected, and a projection with a hole
    // in it is not an upper bound.
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), dispatch('security-reviewer', 'task-1')],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    expect(epic?.status).toBe('unverifiable');
    expect(epic?.rolesWithoutCap).toEqual(['security-reviewer']);
    expect(report.ok).toBe(false);
  });

  it('still fires the alarm when measured spend crosses it despite a priceless role', () => {
    // Monotonicity: the unpriced dispatch can only add to the bill, so a
    // crossing survives the hole. Downgrading this to unverifiable would hide
    // a fact behind an unknown.
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 800_000),
        dispatch('security-reviewer', 'task-1'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.status).toBe('alarm');
  });

  it('counts dispatches that name no task, and makes the epic unverifiable', () => {
    // dogfood-envkit-1 is 15 of 19 dispatches with no task_id at all. The
    // alarm's denominator is per-epic; spend nobody can attribute is spend the
    // epic line does not contain, and "under" over that hole is the same false
    // clean the escalation audit shipped with (P9-32).
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 10_000), dispatch('coder')],
      POLICY,
      OPTS,
    );
    expect(report.unattributedDispatches).toBe(1);
    expect(report.unattributedRoles).toEqual(['coder']);
    expect(report.epics[0]?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('reads a dispatch’s task from the payload when the record does not name one', () => {
    // dogfood-envkit-1: 15 of 19 dispatch_decision events carry no record-level
    // task_id, and all 19 carry `payload.task_id`. Reading one level only
    // reports 15 unattributable dispatches on a run where none are.
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 10_000),
        payloadOnlyDispatch('reviewer', 'epic-1/task-1'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.unattributedDispatches).toBe(0);
    expect(report.epics[0]?.projectedFrom).toEqual({ reviewer: 40_000 });
    expect(report.epics[0]?.status).toBe('under');
  });

  it('counts a dispatch whose task no trace attributes to an epic', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 10_000), dispatch('coder', 'task-9')],
      POLICY,
      OPTS,
    );
    expect(report.unattributedDispatches).toBe(1);
    expect(report.epics[0]?.status).toBe('unverifiable');
  });

  it('does not count an epic-level synthetic task id as a task', () => {
    // `epic-closed` on dogfood-envkit-1 carries task_id
    // `envkit-config-loader/epic`. It attributes to the epic — spend charged to
    // it would be the epic's — but it is not a sixth task on a five-task epic,
    // and a report that says otherwise is wrong about something checkable.
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 10_000),
        dispatch('coder', 'task-1'),
        stored('epic-closed', { epic_id: 'epic-1' }, 'epic-1/epic'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.taskCount).toBe(1);
  });

  it('reports no-epics-in-scope as unverifiable, never as clean', () => {
    seq = 0;
    const report = checkBudgetAlarm([dispatch('coder')], POLICY, OPTS);
    expect(report.epics).toHaveLength(1);
    expect(report.epics[0]?.epicId).toBe('*');
    expect(report.epics[0]?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('scopes to one epic when asked, and drops the others entirely', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        waveAdmitted('epic-2', ['task-2']),
        result('task-1', 10_000),
        result('task-2', 900_000),
        dispatch('coder', 'task-1'),
        dispatch('coder', 'task-2'),
      ],
      POLICY,
      { sessionId: 'sess-1', epicId: 'epic-1' },
    );
    expect(report.epics.map((e) => e.epicId)).toEqual(['epic-1']);
    expect(report.epics[0]?.status).toBe('under');
    expect(report.ok).toBe(true);
  });

  it('reports every epic in the session when not scoped, sorted by id', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-2', ['task-2']),
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 10_000),
        result('task-2', 900_000),
        dispatch('coder', 'task-1'),
        dispatch('coder', 'task-2'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics.map((e) => e.epicId)).toEqual(['epic-1', 'epic-2']);
    expect(report.epics[0]?.status).toBe('under');
    expect(report.epics[1]?.status).toBe('alarm');
    expect(report.ok).toBe(false);
  });

  it('counts spend exactly at the alarm as having reached it', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 700_000), dispatch('coder', 'task-1')],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.status).toBe('alarm');
  });

  it('carries the ratio and cap it judged against into the report', () => {
    seq = 0;
    const report = checkBudgetAlarm([waveAdmitted('epic-1', ['task-1'])], POLICY, OPTS);
    expect(report.alarmRatio).toBe(0.7);
    expect(report.capTokens).toBe(1_000_000);
    expect(report.sessionId).toBe('sess-1');
  });

  it('says in the detail which half of the bill it could see', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1']),
        result('task-1', 100_000),
        dispatch('coder', 'task-1'),
        dispatch('reviewer', 'task-1'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.detail).toContain('100,000');
    expect(report.epics[0]?.detail).toContain('140,000');
  });
});

describe('the cap that was not a bound (D-188)', () => {
  // `under` is the only status that clears, and it asserts that the real spend
  // is under the alarm because the projection is. That holds only while a
  // declared cap bounds what a dispatch can spend — and it does not. The gate
  // records an overrun and does not block on one, so a cap is a target the log
  // can already have blown past. dogfood's did: `envkit-mcp-surface/
  // task-2-path-guard` recorded a single coder round at 1,484,000 tokens
  // against a 150,000 coder cap, and budgets.yml's own comment cites that run
  // as the reason the epic cap was raised. An epic that has been measured
  // spending more on one task than the projection charges an unmeasured
  // dispatch has falsified its own price list, and a projection built from a
  // falsified price list is not a ceiling.

  it('cannot clear an epic that outspent the largest price the projection charges', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1', 'task-2']),
        result('task-1', 200_000),
        dispatch('coder', 'task-1'),
        dispatch('coder', 'task-2'),
      ],
      POLICY,
      OPTS,
    );
    const epic = report.epics[0];
    // Neither bound crosses: 200,000 measured, 350,000 projected, 700,000 alarm.
    expect(epic?.measuredTokens).toBe(200_000);
    expect(epic?.projectedTokens).toBe(350_000);
    expect(epic?.tasksOverPrice).toEqual(['task-1']);
    expect(epic?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('names the falsified price in the detail', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 200_000)],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.detail).toContain('task-1');
    expect(report.epics[0]?.detail).toContain('150,000');
  });

  it('leaves an epic whose tasks stayed inside the price list clearing', () => {
    seq = 0;
    const report = checkBudgetAlarm(
      [
        waveAdmitted('epic-1', ['task-1', 'task-2']),
        result('task-1', 100_000),
        dispatch('coder', 'task-1'),
        dispatch('coder', 'task-2'),
      ],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.tasksOverPrice).toEqual([]);
    expect(report.epics[0]?.status).toBe('under');
    expect(report.ok).toBe(true);
  });

  it('reads a task measured exactly at the largest price as inside it', () => {
    // Same reading as checkTaskBudget's: a cap of 150,000 permits 150,000.
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 150_000)],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.tasksOverPrice).toEqual([]);
    expect(report.epics[0]?.status).toBe('under');
  });

  it('still reports a crossing the log can prove, hole or not', () => {
    // Monotonicity again: a measured crossing survives any doubt about the
    // projection, so it is reported as the fact it is and the hole is named
    // alongside it rather than replacing it.
    seq = 0;
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 800_000)],
      POLICY,
      OPTS,
    );
    expect(report.epics[0]?.tasksOverPrice).toEqual(['task-1']);
    expect(report.epics[0]?.status).toBe('alarm');
    expect(report.epics[0]?.detail).toContain('Holes:');
  });

  it('prices the hole from the largest declared cap, not from the coder’s', () => {
    // The projection can charge an unmeasured dispatch at most the largest cap
    // in the policy. Read the coder's specifically and a policy that priced a
    // researcher higher would let spend above the real ceiling pass unnamed.
    seq = 0;
    const researcherHeavy: BudgetPolicy = {
      ...POLICY,
      task: { ...POLICY.task, researcher: { capTokens: 300_000 } },
    };
    const report = checkBudgetAlarm(
      [waveAdmitted('epic-1', ['task-1']), result('task-1', 200_000)],
      researcherHeavy,
      OPTS,
    );
    expect(report.epics[0]?.tasksOverPrice).toEqual([]);
    expect(report.epics[0]?.status).toBe('under');
  });
});
