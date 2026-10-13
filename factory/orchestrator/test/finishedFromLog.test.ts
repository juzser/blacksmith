import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldTasks } from '../src/db/projector.js';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import type { PlanChanges, PlanFile, TaskSpecRecord } from '../src/plan.js';
import { approveSpecChange, proposeSpecChange } from '../src/specChange.js';
import { emitTasksAdded, emitWaveMerged, type TaskEventContext } from '../src/taskEvents.js';
import { finishedInLog } from '../src/taskLifecycle.js';

// A merged task is finished because the log says so, whatever the plan file's
// task_status still reads. An amendment that does not name it used to carry it
// live as `todo`, and a later ingest could then supersede work that had merged.

const EPIC = 'epic-a';
const T = 'epic-a/task-1';
const U = 'epic-a/task-2';
const V = 'epic-a/task-3';

function spec(taskId: string, overrides: Record<string, unknown> = {}): TaskSpecRecord {
  return {
    task_id: taskId,
    epic_id: EPIC,
    plan_version: 1,
    objective: `Do ${taskId}.`,
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: [`src/${taskId.split('/')[1]}/**`],
    budget: { tokens: 1000, diff_lines: 100 },
    contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
    ...overrides,
  } as TaskSpecRecord;
}

function plan1(): PlanFile {
  return { epic_id: EPIC, version: 1, status: 'active', tasks: [spec(T), spec(U)], edges: [] };
}

describe('an amendment reads "finished" from the log', () => {
  let stateDir: string;
  let specsDir: string;
  const sessionId = 'sess-finished';
  let ctx: TaskEventContext;
  const opts = () => ({ stateDir, specsDir });

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-finished-'));
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-finished-plans-'));
    const root = await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      opts(),
    );
    ctx = { sessionId, planVersion: 1, causalParent: root.event_id, actor: 'system' };
    // v1 lists T as todo while the log records its merge.
    await emitTasksAdded(plan1(), ctx, opts());
    await emitWaveMerged(T, ctx, opts());
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(specsDir, { recursive: true, force: true });
  });

  async function amend(changes: PlanChanges, taskId = U): Promise<PlanFile> {
    const proposal = await proposeSpecChange(
      {
        plan: plan1(),
        taskId,
        proposedBy: 'coder',
        request: {
          criterion_ref: 'task-2:criterion-1',
          assumption: 'the second task is specified as written',
          evidence: 'the code contradicts the second task as written',
          changes,
          sites: ['src/task-2/**'],
          blocking: true,
        },
      },
      ctx,
      opts(),
    );
    const result = await approveSpecChange(
      { proposalId: proposal.proposalId, plan: plan1(), decidedBy: 'operator' },
      ctx,
      opts(),
    );
    return result.plan;
  }

  it('drops a merged task whose plan-file status is todo, and ingest never supersedes it', async () => {
    const v2 = await amend({ added: [spec(V, { plan_version: 2 })] });

    expect(v2.tasks.filter((t) => t.task_id === T)).toEqual([]);
    expect(v2.tasks.some((t) => t.task_id === U && t.task_status === 'todo')).toBe(true);

    await emitTasksAdded(v2, { ...ctx, planVersion: 2 }, opts());
    const events = await readEvents(sessionId, opts());
    const superseded = events
      .filter((e) => e.record.event_type === 'task-superseded')
      .map((e) => e.record.task_id);
    expect(superseded).not.toContain(T);
    const status = new Map(foldTasks(events).map((r) => [r.taskId, r.taskStatus]));
    expect(status.get(T)).toBe('completed');
  });

  it('still supersedes a finished task an amendment names in changes.supersede', async () => {
    const v2 = await amend(
      { supersede: { [T]: spec(T, { objective: 'Do task-1 differently.' }) } },
      T,
    );

    const records = v2.tasks.filter((t) => t.task_id === T).map((t) => t.task_status);
    expect(records).toContain('superseded');
    expect(records).toContain('todo');
  });
});

describe('finishedInLog agrees with the projector', () => {
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
  const added = () => ev('task-added', T, { epic_id: EPIC, task_status: 'todo' });
  const merged = () => ev('wave-merged', undefined, { epic_id: EPIC, task_ids: [T] });
  const superseded = () => ev('task-superseded', T, { epic_id: EPIC });
  const reinstated = () => ev('task-reinstated', T, { epic_id: EPIC });

  const TABLE: [string, StoredEvent[]][] = [
    ['merged', [added(), merged()]],
    ['merged then superseded', [added(), merged(), superseded()]],
    ['superseded then honoured reinstatement', [added(), merged(), superseded(), reinstated()]],
    ['superseded then merged', [added(), superseded(), merged()]],
    ['never merged', [added()]],
    ['never merged, superseded and reinstated', [added(), superseded(), reinstated()]],
  ];

  for (const [name, log] of TABLE) {
    it(`row: ${name}`, () => {
      const completed = foldTasks(log).find((r) => r.taskId === T)?.taskStatus === 'completed';
      expect(finishedInLog(log, EPIC).has(T)).toBe(completed);
    });
  }
});
