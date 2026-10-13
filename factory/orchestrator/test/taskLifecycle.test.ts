import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldTasks } from '../src/db/projector.js';
import { appendEvent, readEvents } from '../src/events.js';

import { reinstateTask } from '../src/reinstate.js';
import { PLAN_AMENDED_EVENT } from '../src/spec.js';
import { reinstatedWithoutSuccessor, type TaskEventContext } from '../src/taskEvents.js';

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
