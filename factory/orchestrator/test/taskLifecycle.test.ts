import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldTasks } from '../src/db/projector.js';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';

import { reinstateTask } from '../src/reinstate.js';
import { PLAN_AMENDED_EVENT } from '../src/spec.js';
import { reinstatedWithoutSuccessor, type TaskEventContext } from '../src/taskEvents.js';
import {
  honouredReinstatements,
  reinstatementBlocker,
  taskSuccessorsOf,
} from '../src/taskLifecycle.js';

const EPIC = 'epic-a';
const T = 'epic-a/task-1';
const T2 = 'epic-a/task-2';
const sessionId = 'sess-lifecycle';

type Step = 'added' | 'merged' | 'superseded' | 'reinstated' | 'amended';

const SCENARIOS: { name: string; steps: Step[]; honoured: boolean }[] = [
  {
    name: 'a: never merged, no successor',
    steps: ['added', 'superseded', 'reinstated'],
    honoured: false,
  },
  {
    name: 'b: merged, no successor',
    steps: ['added', 'merged', 'superseded', 'reinstated'],
    honoured: true,
  },
  {
    name: 'c: merged, with a successor',
    steps: ['added', 'merged', 'superseded', 'amended', 'reinstated'],
    honoured: false,
  },
];

describe('one predicate decides a reinstatement', () => {
  let stateDir: string;
  let ctx: TaskEventContext;
  const opts = () => ({ stateDir });

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lifecycle-'));
    const root = await appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      opts(),
    );
    ctx = { sessionId, planVersion: 1, causalParent: root.event_id, actor: 'system' };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function emit(event_type: string, payload: Record<string, unknown> = {}, task_id = T) {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type,
        task_id,
        plan_version: 1,
        causal_parent: ctx.causalParent,
        payload,
      },
      opts(),
    );
  }

  async function play(steps: Step[]): Promise<void> {
    for (const step of steps) {
      if (step === 'added') await emit('task-added', { epic_id: EPIC, task_status: 'todo' });
      else if (step === 'merged') await emit('wave-merged', { epic_id: EPIC, task_ids: [T] });
      else if (step === 'superseded') await emit('task-superseded', { epic_id: EPIC });
      else if (step === 'reinstated') await emit('task-reinstated', { epic_id: EPIC });
      else {
        await emit(
          PLAN_AMENDED_EVENT,
          { epic_id: EPIC, successors: { [T]: T2 } },
          `${EPIC}/plan-v2`,
        );
      }
    }
  }

  for (const sc of SCENARIOS) {
    describe(`scenario ${sc.name}`, () => {
      it('the projector and ingest agree on the reinstatement', async () => {
        await play(sc.steps);
        const status = foldTasks(await readEvents(sessionId, opts())).find(
          (r) => r.taskId === T,
        )?.taskStatus;
        const projectorHonours = status === 'completed';
        const ingestHonours = (await reinstatedWithoutSuccessor(EPIC, ctx, opts())).has(T);
        expect(ingestHonours).toBe(projectorHonours);
        expect(projectorHonours).toBe(sc.honoured);
        expect(status).toBe(sc.honoured ? 'completed' : 'superseded');
      });

      it('reinstateTask agrees', async () => {
        // The verb runs before the reinstatement is written.
        await play(sc.steps.filter((s) => s !== 'reinstated'));
        const attempt = reinstateTask(T, { reason: 'dropped by mistake' }, ctx, opts());
        if (sc.honoured) {
          await expect(attempt).resolves.toMatchObject({
            record: { event_type: 'task-reinstated' },
          });
        } else {
          await expect(attempt).rejects.toMatchObject({
            code: sc.steps.includes('amended')
              ? 'task.reinstate-has-successor'
              : 'task.reinstate-never-merged',
          });
        }
      });
    });
  }
});

describe('honouredReinstatements and reinstatementBlocker on synthetic logs', () => {
  const ev = (
    event_type: string,
    task_id?: string,
    payload: Record<string, unknown> = {},
  ): StoredEvent => ({
    event_id: `sess-x#${event_type}`,
    record: {
      session_id: 'sess-x',
      actor: 'system',
      event_type,
      task_id,
      plan_version: 1,
      causal_parent: null,
      payload,
    } as unknown as StoredEvent['record'],
  });
  const merged = (ids: string[]) => ev('wave-merged', undefined, { epic_id: EPIC, task_ids: ids });
  const amended = (payload: Record<string, unknown>) =>
    ev(PLAN_AMENDED_EVENT, `${EPIC}/plan-v2`, { epic_id: EPIC, ...payload });

  it('honours a merged, superseded, reinstated task with no successor', () => {
    const log = [merged([T]), ev('task-superseded', T), ev('task-reinstated', T)];
    expect([...honouredReinstatements(log, EPIC)]).toEqual([T]);
  });

  it('ignores a reinstatement that follows no supersede', () => {
    const log = [merged([T]), ev('task-reinstated', T)];
    expect(honouredReinstatements(log, EPIC).size).toBe(0);
  });

  it('drops a reinstatement when the task is superseded again afterwards', () => {
    const log = [
      merged([T]),
      ev('task-superseded', T),
      ev('task-reinstated', T),
      ev('task-superseded', T),
    ];
    expect(honouredReinstatements(log, EPIC).size).toBe(0);
  });

  it('matches a wave-merged by envelope task id as well as by payload task_ids', () => {
    const log = [ev('wave-merged', T), ev('task-superseded', T), ev('task-reinstated', T)];
    expect(honouredReinstatements(log, EPIC).has(T)).toBe(true);
  });

  it('matches a successor recorded under the bare id', () => {
    const log = [
      merged([T]),
      ev('task-superseded', T),
      amended({ successors: { 'task-1': T2 } }),
      ev('task-reinstated', T),
    ];
    expect(honouredReinstatements(log, EPIC).size).toBe(0);
    expect(reinstatementBlocker(log, T, EPIC)).toEqual({
      code: 'has-successor',
      successor: T2,
    });
  });

  it('reads the legacy one-for-one diff as a successor, and ignores a many-to-one diff', () => {
    const legacy = amended({ diff: { superseded: [T], added: [T2] } });
    expect(taskSuccessorsOf([legacy], EPIC).get(T)).toBe(T2);
    const wide = amended({ diff: { superseded: [T, 'epic-a/task-3'], added: [T2] } });
    expect(taskSuccessorsOf([wide], EPIC).size).toBe(0);
  });

  it('ignores an amendment of another epic and a malformed successors value', () => {
    const other = ev(PLAN_AMENDED_EVENT, 'epic-b/plan-v2', {
      epic_id: 'epic-b',
      successors: { [T]: T2 },
    });
    expect(taskSuccessorsOf([other], EPIC).size).toBe(0);
    expect(taskSuccessorsOf([amended({ successors: null })], EPIC).size).toBe(0);
    expect(taskSuccessorsOf([amended({ successors: { [T]: 7 } })], EPIC).size).toBe(0);
  });

  it('reports never-merged before has-successor', () => {
    const log = [amended({ successors: { [T]: T2 } })];
    expect(reinstatementBlocker(log, T, EPIC)).toEqual({ code: 'never-merged' });
  });
});
