import { describe, expect, it } from 'vitest';
import { assertNotInFlight, InFlightError, inFlightTasks } from '../src/admission.js';
import type { StoredEvent } from '../src/events.js';
import type { PlanFile } from '../src/plan.js';
import { computeNextWave } from '../src/waveNext.js';

const EPIC = 'e1';
const A = 'e1/task-a';
const B = 'e1/task-b';
const SCOPE = { epicId: EPIC, planVersion: 1 };

let seq = 0;
function ev(
  eventType: string,
  payload: Record<string, unknown>,
  taskId?: string,
  planVersion = 1,
): StoredEvent {
  seq += 1;
  return {
    event_id: `e${seq}`,
    record: {
      session_id: 's1',
      actor: 'system',
      event_type: eventType,
      task_id: taskId,
      plan_version: planVersion,
      causal_parent: null,
      payload,
      ts: `2026-10-22T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    },
  };
}

const admitted = (ids: string[], epic: string | null = EPIC, pv = 1) =>
  ev('wave-admitted', { ...(epic ? { epic_id: epic } : {}), task_ids: ids }, undefined, pv);
const dispatch = (taskId: string, role = 'coder') =>
  ev('dispatch_decision', { agent_role: role, provider: 'claude', model_tier: 'frontier' }, taskId);
const merged = (taskId: string) => ev('wave-merged', { task_ids: [taskId] }, taskId);

function ids(events: StoredEvent[], scope = SCOPE): string[] {
  return [...inFlightTasks(events, scope)].sort();
}

describe('inFlightTasks — admitted and not yet finished (epic criterion 9)', () => {
  it('holds a task a wave-admitted names, and one a coder dispatch names', () => {
    expect(ids([admitted([A])])).toEqual([A]);
    expect(ids([dispatch(B)])).toEqual([B]);
  });

  it('ignores a non-coder dispatch, another epic and a plan version from the future', () => {
    expect(ids([dispatch(A, 'reviewer')])).toEqual([]);
    expect(ids([admitted(['e2/task-a'], 'e2'), dispatch('e2/task-z')])).toEqual([]);
    expect(ids([admitted([A], EPIC, 2)])).toEqual([]);
  });

  it('keeps a task in flight after a bounce, a re-dispatch and a failed agent run', () => {
    const base = [admitted([A]), dispatch(A)];
    const bounce = ev('gate-outcome', { outcome: 'blocked' }, A);
    expect(ids([...base, bounce])).toEqual([A]);
    expect(ids([...base, dispatch(A)])).toEqual([A]);
    const failed = ev('error-logged', { task_ref: A, error: 'execution.agent-failed' }, A);
    expect(ids([...base, failed])).toEqual([A]);
  });

  it('frees a task on wave-merged', () => {
    expect(ids([admitted([A, B]), dispatch(A), merged(A)])).toEqual([B]);
  });

  it('frees a task on task-superseded', () => {
    expect(ids([admitted([A, B]), ev('task-superseded', {}, A)])).toEqual([B]);
  });

  it('frees every task of the epic on epic-closed, and only that epic', () => {
    const other = admitted(['e2/task-a'], 'e2');
    const events = [admitted([A, B]), other, ev('epic-closed', { epic_id: EPIC })];
    expect(ids(events)).toEqual([]);
    expect(ids(events, { epicId: 'e2', planVersion: 1 })).toEqual(['e2/task-a']);
  });

  it('puts a task back in flight when it is dispatched again after its merge', () => {
    expect(ids([admitted([A]), merged(A), dispatch(A)])).toEqual([A]);
  });
});

describe('assertNotInFlight', () => {
  it('raises wave.in-flight naming the task', () => {
    const inFlight = new Set([A]);
    expect(() => assertNotInFlight(A, inFlight)).toThrow(InFlightError);
    expect(() => assertNotInFlight(A, inFlight)).toThrow(/wave\.in-flight.*e1\/task-a/);
    expect(() => assertNotInFlight(B, inFlight)).not.toThrow();
  });
});

describe('computeNextWave with inFlight — the ingest-resets-in-flight hazard', () => {
  // `plan ingest` rewrote the plan file: A is in flight but reads `todo`.
  const plan: PlanFile = {
    epic_id: EPIC,
    version: 1,
    status: 'active',
    tasks: [{ task_id: A, task_status: 'todo', plan_version: 1, claims: ['src/a/**'] }],
    edges: [],
  };
  const policy = { serializeAlwaysGlobs: [] };

  it('re-offers A without inFlight (today), and occupies it with inFlight', () => {
    expect(computeNextWave({ plan, policy }).wave).toEqual([A]);
    const inFlight = inFlightTasks([admitted([A])], SCOPE);
    const result = computeNextWave({ plan, policy, inFlight });
    expect(result.occupied).toEqual([A]);
    expect(result.wave).toEqual([]);
  });

  it('defers a task whose claims overlap an in-flight one with claim-overlap', () => {
    const two: PlanFile = {
      ...plan,
      tasks: [
        ...plan.tasks,
        { task_id: B, task_status: 'todo', plan_version: 1, claims: ['src/a/deep/**'] },
      ],
    };
    const result = computeNextWave({ plan: two, policy, inFlight: new Set([A]) });
    expect(result.wave).toEqual([]);
    expect(result.deferred).toMatchObject([{ taskId: B, reason: 'claim-overlap', blockedBy: [A] }]);
  });
});
