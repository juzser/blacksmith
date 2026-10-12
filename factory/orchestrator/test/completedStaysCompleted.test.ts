import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldTasks } from '../src/db/projector.js';
import { summarizeEpic, withGateEvidence } from '../src/epic.js';
import { appendEvent, readEvents } from '../src/events.js';
import { MCP_SURFACE_NOT_REQUIRED } from '../src/mcp.js';
import { draftNextVersion, type PlanFile, type TaskSpecRecord } from '../src/plan.js';
import { reinstateTask } from '../src/reinstate.js';
import { PLAN_AMENDED_EVENT, taskSuccessors } from '../src/spec.js';
import {
  emitTaskSuperseded,
  emitTasksAdded,
  emitWaveMerged,
  type TaskEventContext,
} from '../src/taskEvents.js';

// A task that finished stays finished unless an amendment actually supersedes
// it. The failure this file pins: an amendment that named some OTHER task in
// `changes.supersede` dropped a completed task's record from the new version
// but kept the older dead copies of the same id, so the new version held that
// id only as dead records, ingest read the id as "superseded, no successor",
// and the log said the finished task was replaced by nothing.

const EPIC = 'epic-1';
const A = 'epic-1/task-a';
const B = 'epic-1/task-b';
const A2 = 'epic-1/task-a2';
const B2 = 'epic-1/task-b2';

function spec(taskId: string, overrides: Record<string, unknown> = {}): TaskSpecRecord {
  return {
    task_id: taskId,
    epic_id: EPIC,
    plan_version: 1,
    objective: `Do ${taskId}.`,
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: [`src/${taskId.split('/')[1]}/**`],
    budget: { tokens: 1000, diff_lines: 100, max_turns: 10 },
    contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
    ...overrides,
  } as TaskSpecRecord;
}

function plan1(): PlanFile {
  return {
    epic_id: EPIC,
    version: 1,
    status: 'active',
    tasks: [spec(A), spec(B)],
    edges: [],
  };
}

/** Mark the live record of `taskId` completed, the way a plan file records a merged task. */
function markCompleted(plan: PlanFile, taskId: string): PlanFile {
  return {
    ...plan,
    tasks: plan.tasks.map((t) =>
      t.task_id === taskId && t.task_status !== 'superseded'
        ? { ...t, task_status: 'completed' }
        : t,
    ),
  };
}

describe('a completed task stays completed across an amendment that does not supersede it', () => {
  let stateDir: string;
  const sessionId = 'sess-completed-stays';
  let ctx: TaskEventContext;
  const opts = () => ({ stateDir });

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-completed-stays-'));
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

  async function statuses(): Promise<Map<string, string>> {
    const events = await readEvents(sessionId, opts());
    return new Map(foldTasks(events).map((r) => [r.taskId, r.taskStatus]));
  }

  /**
   * v1 -> v2 (same-id supersede of A: A now has a dead copy beside its live
   * one) -> A merges and is recorded completed in the plan.
   */
  async function ingestThroughA(): Promise<PlanFile> {
    await emitTasksAdded(plan1(), ctx, opts());
    const v2 = draftNextVersion(plan1(), {
      supersede: { [A]: spec(A, { objective: 'Do A again, better.' }) },
    });
    await emitTasksAdded(v2, { ...ctx, planVersion: 2 }, opts());
    await emitWaveMerged(A, { ...ctx, planVersion: 2 }, opts());
    return markCompleted(v2, A);
  }

  it('does not carry the finished task, nor its dead copies, into the next version', async () => {
    const v2 = await ingestThroughA();
    expect(v2.tasks.filter((t) => t.task_id === A).map((t) => t.task_status)).toEqual([
      'superseded',
      'completed',
    ]);

    const v3 = draftNextVersion(v2, { supersede: { [B]: spec(B2) } });

    expect(v3.tasks.filter((t) => t.task_id === A)).toEqual([]);
  });

  it('never writes task-superseded for it, and the projection keeps it completed', async () => {
    const v2 = await ingestThroughA();
    const v3 = draftNextVersion(v2, { supersede: { [B]: spec(B2) } });

    await emitTasksAdded(v3, { ...ctx, planVersion: 3 }, opts());

    const events = await readEvents(sessionId, opts());
    const supersededIds = events
      .filter((e) => e.record.event_type === 'task-superseded')
      .map((e) => e.record.task_id);
    expect(supersededIds).toEqual([B]);
    const status = await statuses();
    expect(status.get(A)).toBe('completed');
    expect(status.get(B)).toBe('superseded');
  });

  it('still supersedes a completed task an amendment names with a different-id successor, and the verdict waits on the successor', async () => {
    const v2 = await ingestThroughA();
    const v3 = draftNextVersion(v2, { supersede: { [A]: spec(A2) } });
    await emitTasksAdded(v3, { ...ctx, planVersion: 3 }, opts());

    const status = await statuses();
    expect(status.get(A)).toBe('superseded');
    expect(status.get(A2)).toBe('todo');

    const verdict = async () => {
      const events = await readEvents(sessionId, opts());
      const rows = withGateEvidence(
        foldTasks(events).filter((r) => r.epicId === EPIC),
        events,
        EPIC,
      );
      const summary = summarizeEpic(
        EPIC,
        rows,
        [],
        { check: null, headSha: 'h', branch: 'b' },
        MCP_SURFACE_NOT_REQUIRED,
        { review: null, headSha: 'h', branch: 'b' },
        { check: null, goal: { milestoneId: 'm', goal: 'g', clauses: ['g'], digest: 'd' } },
        { tier: 'huge', closingSpecReview: 'always' },
        null,
        [],
        null,
        new Map([[A, A2]]),
      );
      return summary.blockers.filter((b) => b.includes(`superseded by "${A2}"`));
    };
    expect(await verdict()).toHaveLength(1);

    await emitWaveMerged(A2, { ...ctx, planVersion: 3 }, opts());
    expect(await verdict()).toEqual([]);
  });

  describe('reinstateTask: the way back for an epic that already hit it', () => {
    /** The bad log: merged, then a task-superseded with no successor behind it. */
    async function hit(): Promise<void> {
      await emitTasksAdded(plan1(), ctx, opts());
      await emitWaveMerged(A, ctx, opts());
      await emitTaskSuperseded(plan1(), A, ctx, opts());
    }

    it('flips it back to completed, auditably, from the log alone', async () => {
      await hit();
      expect((await statuses()).get(A)).toBe('superseded');

      const event = await reinstateTask(
        A,
        { reason: 'an amendment dropped the record, not the work' },
        ctx,
        opts(),
      );

      expect((await statuses()).get(A)).toBe('completed');
      const events = await readEvents(sessionId, opts());
      const written = events.find((e) => e.event_id === event.event_id);
      expect(written?.record.event_type).toBe('task-reinstated');
      expect(written?.record.task_id).toBe(A);
      expect(written?.record.payload).toMatchObject({
        epic_id: EPIC,
        reason: 'an amendment dropped the record, not the work',
      });
      expect(written?.record.payload).toHaveProperty('superseded_event_id');
      expect(written?.record.payload).toHaveProperty('merged_event_id');
    });

    it('is undone by a later real supersede', async () => {
      await hit();
      await reinstateTask(A, { reason: 'dropped by mistake' }, ctx, opts());
      await emitTaskSuperseded(plan1(), A, ctx, opts());
      expect((await statuses()).get(A)).toBe('superseded');
    });

    it('lets a later different-id supersede of the reinstated task be recorded', async () => {
      await hit();
      await reinstateTask(A, { reason: 'dropped by mistake' }, ctx, opts());
      const v2 = draftNextVersion(markCompleted(plan1(), A), { supersede: { [A]: spec(A2) } });
      await emitTasksAdded(v2, { ...ctx, planVersion: 2 }, opts());
      expect((await statuses()).get(A)).toBe('superseded');
    });

    it('refuses a task that never merged', async () => {
      await emitTasksAdded(plan1(), ctx, opts());
      await emitTaskSuperseded(plan1(), B, ctx, opts());
      await expect(reinstateTask(B, { reason: 'x' }, ctx, opts())).rejects.toMatchObject({
        code: 'task.reinstate-never-merged',
      });
    });

    it('refuses a task that is not superseded', async () => {
      await emitTasksAdded(plan1(), ctx, opts());
      await emitWaveMerged(A, ctx, opts());
      await expect(reinstateTask(A, { reason: 'x' }, ctx, opts())).rejects.toMatchObject({
        code: 'task.reinstate-not-superseded',
      });
    });

    it('refuses a task a plan supersedes with a successor', async () => {
      await hit();
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: PLAN_AMENDED_EVENT,
          task_id: `${EPIC}/plan-v2`,
          plan_version: 2,
          causal_parent: ctx.causalParent,
          payload: {
            epic_id: EPIC,
            version: 2,
            previous_version: 1,
            amends: [],
            rationale: 'replace A',
            successors: { [A]: A2 },
          },
        },
        opts(),
      );
      const events = await readEvents(sessionId, opts());
      expect(taskSuccessors(events, EPIC).get(A)).toBe(A2);

      await expect(reinstateTask(A, { reason: 'x' }, ctx, opts())).rejects.toMatchObject({
        code: 'task.reinstate-has-successor',
      });
      expect((await statuses()).get(A)).toBe('superseded');
    });

    it('refuses an empty reason', async () => {
      await hit();
      await expect(reinstateTask(A, { reason: '  ' }, ctx, opts())).rejects.toMatchObject({
        code: 'task.reinstate-reason-required',
      });
    });

    it('refuses an unknown task', async () => {
      await hit();
      await expect(
        reinstateTask('epic-1/nope', { reason: 'x' }, ctx, opts()),
      ).rejects.toMatchObject({ code: 'task.reinstate-unknown-task' });
    });
  });
});
