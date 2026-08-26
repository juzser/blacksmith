import { describe, expect, it } from 'vitest';
import type { BudgetPolicy } from '../src/budgets.js';
import type { StoredEvent } from '../src/events.js';
import { checkWaveBudget, inFlightTasks, type ProposedWaveBudget } from '../src/waveBudget.js';

// ---------------------------------------------------------------------------
// Wave admission's budget gate. budgetAlarm.ts (P9-33) made epic.cap_tokens
// readable; this is the first reader that blocks on what it reads, at the
// one point upstream of every dispatch in a wave. It reuses checkBudgetAlarm
// for the epic's measured/projected spend rather than re-deriving either
// number -- one price list, one accounting -- and asks the one question that
// alarm was never asked: does headroom survive the wave about to be admitted.
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

function withMaxInFlight(maxInFlightTasks: number | null): BudgetPolicy {
  return { ...POLICY, epic: { ...POLICY.epic, maxInFlightTasks } };
}

const OPTS = { sessionId: 'sess-1', epicId: 'epic-1' };

let seq = 0;

function ts(): string {
  return `2026-08-26T10:${String(seq).padStart(2, '0')}:00.000Z`;
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

/** A wave admitting `taskIds` to `epicId` -- the log's own membership record. */
function waveAdmitted(epicId: string, taskIds: string[]): StoredEvent {
  return stored('wave-admitted', { epic_id: epicId, wave: 1, task_ids: taskIds });
}

function waveMerged(epicId: string, taskIds: string[]): StoredEvent {
  return stored('wave-merged', { epic_id: epicId, wave: 1, task_ids: taskIds });
}

function result(taskId: string, totalTokens: number): StoredEvent {
  return stored('task-result-recorded', { token_usage: { total_tokens: totalTokens } }, taskId);
}

function proposed(taskId: string, tokens: number | null): ProposedWaveBudget {
  return { taskId, tokens };
}

describe('inFlightTasks', () => {
  it('is empty when nothing has been admitted', () => {
    seq = 0;
    expect(inFlightTasks([], 'epic-1')).toEqual([]);
  });

  it('lists a bare id from a wave-admitted payload', () => {
    seq = 0;
    expect(inFlightTasks([waveAdmitted('epic-1', ['task-1'])], 'epic-1')).toEqual(['task-1']);
  });

  it('drops a task once wave-merged names it, admitted and merged spelled the same', () => {
    seq = 0;
    const events = [waveAdmitted('epic-1', ['task-1', 'task-2']), waveMerged('epic-1', ['task-1'])];
    expect(inFlightTasks(events, 'epic-1')).toEqual(['task-2']);
  });

  it('drops a task merged under the other spelling than the one it was admitted under', () => {
    // Admitted qualified, merged bare -- both name the same task (D-46/P9-10:
    // the log is append-only, so old and new producers interleave spellings).
    // A cancellation keyed on exact string equality would miss this and leave
    // the task "in flight" forever.
    seq = 0;
    const events = [waveAdmitted('epic-1', ['epic-1/task-1']), waveMerged('epic-1', ['task-1'])];
    expect(inFlightTasks(events, 'epic-1')).toEqual([]);
  });

  it('counts a task admitted under both spellings once, not twice', () => {
    seq = 0;
    const events = [waveAdmitted('epic-1', ['epic-1/task-1']), waveAdmitted('epic-1', ['task-1'])];
    expect(inFlightTasks(events, 'epic-1')).toEqual(['task-1']);
  });

  it('ignores another epic entirely', () => {
    seq = 0;
    expect(inFlightTasks([waveAdmitted('epic-2', ['task-1'])], 'epic-1')).toEqual([]);
  });
});

describe('checkWaveBudget', () => {
  it('treats a wave with no prior epic history as ok, not not-applicable, when it fits the cap', () => {
    seq = 0;
    const check = checkWaveBudget([], POLICY, [proposed('epic-1/task-1', 100_000)], OPTS);
    expect(check.epicId).toBe('epic-1');
    expect(check.measuredTokens).toBe(0);
    expect(check.projectedTokens).toBe(0);
    expect(check.waveTokens).toBe(100_000);
    expect(check.status).toBe('ok');
  });

  it('is ok when the wave fits under headroom the epic already has', () => {
    seq = 0;
    const events = [waveAdmitted('epic-1', ['task-1']), result('task-1', 500_000)];
    const check = checkWaveBudget(events, POLICY, [proposed('epic-1/task-2', 200_000)], OPTS);
    expect(check.measuredTokens).toBe(500_000);
    expect(check.projectedTokens).toBe(500_000);
    expect(check.headroomTokens).toBe(500_000);
    expect(check.waveTokens).toBe(200_000);
    expect(check.status).toBe('ok');
  });

  it('refuses only once the proposed wave adds enough to cross the cap', () => {
    seq = 0;
    const events = [waveAdmitted('epic-1', ['task-1']), result('task-1', 800_000)];
    // 800k alone is under the 1,000,000 cap -- the point is that adding the
    // wave's declared 300k is what tips it, not the pre-existing spend alone.
    expect(800_000).toBeLessThan(POLICY.epic.capTokens);
    const check = checkWaveBudget(events, POLICY, [proposed('epic-1/task-2', 300_000)], OPTS);
    expect(check.waveTokens).toBe(300_000);
    expect(check.projectedTokens + check.waveTokens).toBeGreaterThan(POLICY.epic.capTokens);
    expect(check.status).toBe('refused');
  });

  it('is unverifiable when one proposed task declares no budget, even if every other task is cheap', () => {
    seq = 0;
    const proposedTasks = [proposed('epic-1/task-2', 1_000), proposed('epic-1/task-3', null)];
    const check = checkWaveBudget([], POLICY, proposedTasks, OPTS);
    expect(check.unpricedTasks).toEqual(['epic-1/task-3']);
    expect(check.status).toBe('unverifiable');
  });

  it('never reports over-fan-out when max_in_flight_tasks is null', () => {
    seq = 0;
    const events = [waveAdmitted('epic-1', ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'])];
    const proposedTasks = [proposed('epic-1/task-6', 1_000)];
    const check = checkWaveBudget(events, POLICY, proposedTasks, OPTS);
    expect(check.maxInFlightTasks).toBeNull();
    expect(check.inFlightTasks).toBe(5);
    expect(check.status).not.toBe('over-fan-out');
    expect(check.status).toBe('ok');
  });

  it('reports over-fan-out once a set max_in_flight_tasks would be exceeded', () => {
    seq = 0;
    const policy = withMaxInFlight(2);
    const events = [waveAdmitted('epic-1', ['task-1', 'task-2'])];
    const proposedTasks = [proposed('epic-1/task-3', 1_000)];
    const check = checkWaveBudget(events, policy, proposedTasks, OPTS);
    expect(check.inFlightTasks).toBe(2);
    expect(check.status).toBe('over-fan-out');
  });

  it('does not count a merged task toward the in-flight total', () => {
    seq = 0;
    const policy = withMaxInFlight(2);
    const events = [waveAdmitted('epic-1', ['task-1', 'task-2']), waveMerged('epic-1', ['task-1'])];
    // Only task-2 is still in flight. Admitting one more task keeps the total
    // at the cap of 2, not 3 -- proving the merged task was not counted.
    const proposedTasks = [proposed('epic-1/task-3', 1_000)];
    const check = checkWaveBudget(events, policy, proposedTasks, OPTS);
    expect(check.inFlightTasks).toBe(1);
    expect(check.status).not.toBe('over-fan-out');
  });

  it('is not-applicable when no epic id was given for the wave', () => {
    seq = 0;
    const check = checkWaveBudget([], POLICY, [proposed('task-1', 1_000)], {
      sessionId: 'sess-1',
      epicId: '',
    });
    expect(check.epicId).toBeNull();
    expect(check.status).toBe('not-applicable');
  });
});
