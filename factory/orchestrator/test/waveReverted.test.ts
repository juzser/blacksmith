import { describe, expect, it } from 'vitest';
import { inFlightTasks } from '../src/admission.js';
import { foldTasks } from '../src/db/projector.js';
import { summarizeEpic } from '../src/epic.js';
import type { StoredEvent } from '../src/events.js';
import { creditableTaskIds } from '../src/goalCheck.js';
import { MCP_SURFACE_NOT_REQUIRED } from '../src/mcp.js';
import {
  draftNextVersion,
  markFinishedFromLog,
  type PlanFile,
  type TaskSpecRecord,
} from '../src/plan.js';
import { finishedInLog, reinstatementBlocker } from '../src/taskLifecycle.js';
import { computeNextWave } from '../src/waveNext.js';

const EPIC = 'e1';
const T = 'e1/task-t';
const U = 'e1/task-u';

let seq = 0;
function ev(
  eventType: string,
  payload: Record<string, unknown>,
  taskId?: string,
  planVersion = 1,
): StoredEvent {
  seq += 1;
  return {
    event_id: `ev${seq}`,
    record: {
      session_id: 's1',
      actor: 'system',
      event_type: eventType,
      task_id: taskId,
      plan_version: planVersion,
      causal_parent: null,
      payload,
      ts: `2026-10-30T00:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`,
    },
  };
}

const added = (id: string) => ev('task-added', { epic_id: EPIC }, id);
const merged = (id: string, pv = 1) => ev('wave-merged', { task_ids: [id] }, id, pv);
const reverted = (id: string, disposition: string, extra: Record<string, unknown> = {}) =>
  ev('wave-reverted', { disposition, task_ids: [id], ...extra }, id);

function rec(id: string, status = 'todo'): TaskSpecRecord {
  return {
    task_id: id,
    epic_id: EPIC,
    plan_version: 1,
    objective: `Do ${id}.`,
    claims: [`src/${id.split('/')[1]}/**`],
    task_status: status,
  } as unknown as TaskSpecRecord;
}

const plan1: PlanFile = {
  epic_id: EPIC,
  version: 1,
  status: 'active',
  tasks: [rec(T), rec(U)],
  edges: [],
};

const status = (events: StoredEvent[], id = T) =>
  foldTasks(events).find((r) => r.taskId === id)?.taskStatus;

function readiness(events: StoredEvent[]) {
  const summary = summarizeEpic(
    EPIC,
    foldTasks(events)
      .filter((r) => r.epicId === EPIC)
      .map((r) => ({ ...r, gate: {} }) as never),
    [],
    { check: null, headSha: 'h', branch: 'b' },
    MCP_SURFACE_NOT_REQUIRED,
    { review: null, headSha: 'h', branch: 'b' },
    { check: null, goal: { milestoneId: 'm', goal: 'g', clauses: ['g'], digest: 'd' } },
    { tier: 'huge', closingSpecReview: 'always' },
    null,
    [],
    null,
    new Map(),
  );
  return summary.nonTerminalTaskCount;
}

function readers(events: StoredEvent[]) {
  const finished = finishedInLog(events, EPIC);
  const statusById = new Map(foldTasks(events).map((r) => [r.taskId, r.taskStatus]));
  const drafted = draftNextVersion(markFinishedFromLog(plan1, finished), {
    supersede: { [U]: rec('e1/task-u2') },
  });
  const latest: PlanFile = { ...plan1, version: 2, tasks: [rec(U)] };
  return {
    finished: finished.has(T),
    credited: creditableTaskIds(EPIC, latest, [plan1], events).includes(T),
    keptLive: drafted.tasks.some((t) => t.task_id === T && t.task_status !== 'superseded'),
    notTerminal: readiness(events) > 0,
    offered: computeNextWave({
      plan: plan1,
      policy: { serializeAlwaysGlobs: [] },
      statusById,
    }).wave.includes(T),
    inFlight: inFlightTasks(events, { epicId: EPIC, planVersion: 1 }).has(T),
  };
}

const FINISHED = {
  finished: true,
  credited: true,
  keptLive: false,
  notTerminal: false,
  offered: false,
  inFlight: false,
};
const OPEN = {
  finished: false,
  credited: false,
  keptLive: true,
  notTerminal: true,
  offered: true,
  inFlight: false,
};

describe('a bounced wave-reverted reopens the task everywhere the lifecycle is read', () => {
  const base = () => [added(T), added(U), merged(T), merged(U)];

  it('folds completed to todo, and a second wave-merged completes it again', () => {
    expect(status(base())).toBe('completed');
    const bounced = [...base(), reverted(T, 'bounce')];
    expect(status(bounced)).toBe('todo');
    expect(foldTasks(bounced).find((r) => r.taskId === T)?.terminalAt).toBeNull();
    const remerged = [...bounced, merged(T)];
    expect(status(remerged)).toBe('completed');
    expect(foldTasks(remerged).find((r) => r.taskId === T)?.terminalAt).not.toBeNull();
  });

  it('is read the same by every reader, and reversed by a second merge', () => {
    expect(readers(base())).toEqual(FINISHED);
    const bounced = [...base(), reverted(T, 'bounce')];
    expect(readers(bounced)).toEqual(OPEN);
    expect(readers([...bounced, merged(T)])).toEqual(FINISHED);
  });

  it('matches an envelope-only or payload-only naming of the task', () => {
    const payloadOnly = ev('wave-reverted', { disposition: 'bounce', task_ids: [T] });
    expect(status([...base(), payloadOnly])).toBe('todo');
    expect(finishedInLog([...base(), payloadOnly], EPIC).has(T)).toBe(false);
    const envelopeOnly = ev('wave-reverted', { disposition: 'bounce' }, T);
    expect(finishedInLog([...base(), envelopeOnly], EPIC).has(T)).toBe(false);
  });

  it('never reopens a superseded task', () => {
    const events = [...base(), ev('task-superseded', {}, T), reverted(T, 'bounce')];
    expect(status(events)).toBe('superseded');
  });

  it('reads a reverted merge as no merge in reinstatementBlocker', () => {
    const events = [...base(), ev('task-superseded', {}, T)];
    expect(reinstatementBlocker(events, T, EPIC)).toBeNull();
    expect(reinstatementBlocker([...events, reverted(T, 'bounce')], T, EPIC)).toEqual({
      code: 'never-merged',
    });
    expect(reinstatementBlocker([...events, reverted(T, 'bounce'), merged(T)], T, EPIC)).toBeNull();
  });
});

describe('a record-only wave-reverted reopens nothing', () => {
  it('changes no reader for a completed task', () => {
    const events = [
      added(T),
      added(U),
      merged(T),
      merged(U),
      reverted(T, 'record-only', { reason: 're-merged' }),
    ];
    expect(status(events)).toBe('completed');
    expect(readers(events)).toEqual(FINISHED);
  });

  it('changes no reader for a superseded task', () => {
    const events = [added(T), merged(T), ev('task-superseded', {}, T)];
    const withRecord = [...events, reverted(T, 'record-only', { reason: 'superseded' })];
    expect(status(withRecord)).toBe('superseded');
    expect(finishedInLog(withRecord, EPIC)).toEqual(finishedInLog(events, EPIC));
  });

  it('leaves a task the amendment dropped finished and out of v2', () => {
    const v2: PlanFile = { ...plan1, version: 2, tasks: [rec(U)] };
    const events = [
      added(T),
      added(U),
      merged(T),
      ev('plan-version-created', { epic_id: EPIC, version: 2 }, undefined, 2),
      reverted(T, 'record-only', { reason: 'not-in-live-plan' }),
    ];
    expect(finishedInLog(events, EPIC).has(T)).toBe(true);
    expect(creditableTaskIds(EPIC, v2, [plan1], events)).toContain(T);
    const next = draftNextVersion(markFinishedFromLog(v2, finishedInLog(events, EPIC)), {});
    expect(next.tasks.some((t) => t.task_id === T)).toBe(false);
  });
});
