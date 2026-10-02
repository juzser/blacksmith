import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, openDb, rebuild } from '../../src/db/projector.js';
import { kanban, overview, roadmapPage } from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, readEvents } from '../../src/events.js';
import { buildFixture, EPIC_ID, SESSION_ID } from './fixtures.js';

const ROADMAP_MD = `# Roadmap

## Phase A — Fixture epic
- id: phase-a
- status: in-progress
- epics: [${EPIC_ID}]
- goal: Covers the fixture's one epic.


## Phase B — Nothing mapped yet
- id: phase-b
- status: planned
- epics: []
`;

describe('milestones projection + roadmap queries', () => {
  let stateDir: string;
  let dbDir: string;
  let roadmapPath: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-milestones-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-milestones-db-'));
    roadmapPath = path.join(dbDir, 'roadmap.md');
    await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
    await buildFixture({ stateDir });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('rebuild() populates milestones from roadmap.md, in sequence order', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });

    const handle = openDb(dbPath);
    const rows = handle.db
      .select()
      .from(schema.milestones)
      .orderBy(schema.milestones.sequence)
      .all();
    handle.sqlite.close();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      milestoneId: 'phase-a',
      name: 'Phase A — Fixture epic',
      status: 'in-progress',
      sequence: 1,
      goal: "Covers the fixture's one epic.",
    });
    expect(JSON.parse(rows[0]?.epicIds ?? '[]')).toEqual([EPIC_ID]);
    expect(rows[1]).toMatchObject({ milestoneId: 'phase-b', status: 'planned', sequence: 2 });
    expect(JSON.parse(rows[1]?.epicIds ?? '[]')).toEqual([]);
  });

  it('is idempotent: rebuilding twice yields the same milestone rows', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
    const handle1 = openDb(dbPath);
    const first = handle1.db.select().from(schema.milestones).all();
    handle1.sqlite.close();

    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
    const handle2 = openDb(dbPath);
    const second = handle2.db.select().from(schema.milestones).all();
    handle2.sqlite.close();

    expect(second).toEqual(first);
  });

  it('apply() (session-scoped) also refreshes the global milestones table', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await apply(dbPath, SESSION_ID, { stateDir, roadmapPath });

    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.milestones).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(2);
  });

  it('rebuild() does not crash on a malformed roadmap.md (duplicate id) — it just skips the refresh', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    const dupRoadmapPath = path.join(dbDir, 'dup-roadmap.md');
    await writeFile(
      dupRoadmapPath,
      `## Phase A\n- id: phase-a\n- status: planned\n\n## Phase A again\n- id: phase-a\n- status: completed\n`,
      'utf8',
    );

    await expect(
      rebuild(dbPath, 'all', { stateDir, roadmapPath: dupRoadmapPath }),
    ).resolves.toBeDefined();

    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.milestones).all();
    handle.sqlite.close();
    expect(rows).toEqual([]); // never populated, but the rebuild itself did not throw
  });

  it('apply() after a good rebuild leaves existing milestone rows in place when roadmap.md later becomes malformed', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath }); // good roadmap.md — 2 rows

    const dupRoadmapPath = path.join(dbDir, 'dup-roadmap.md');
    await writeFile(
      dupRoadmapPath,
      `## Phase A\n- id: phase-a\n- status: planned\n\n## Phase A again\n- id: phase-a\n- status: completed\n`,
      'utf8',
    );

    await expect(
      apply(dbPath, SESSION_ID, { stateDir, roadmapPath: dupRoadmapPath }),
    ).resolves.toBeDefined();

    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.milestones).all();
    handle.sqlite.close();
    expect(rows).toHaveLength(2); // stale rows from the earlier good rebuild, untouched
  });

  it('leaves milestones empty (not fatal) when roadmap.md is missing', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath: path.join(dbDir, 'no-such-roadmap.md') });

    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.milestones).all();
    handle.sqlite.close();

    expect(rows).toEqual([]);
  });

  describe('roadmapPage()', () => {
    it("joins each milestone with its mapped epics' task/token stats", async () => {
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);

      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      expect(page).toHaveLength(2);
      const phaseA = page.find((m) => m.milestoneId === 'phase-a');
      // Fixture's epic-1 has 4 tasks (task-1..4); only task-1 is completed.
      expect(phaseA).toMatchObject({
        tasksTotal: 4,
        tasksCompleted: 1,
        tokensSpent: 2000, // task-1's task-result-recorded total_tokens
        tokensBudget: 4300, // sum of the 4 tasks' budget_tokens
      });
      // task-3/task-4 are still open (escalated/confirmed finding, never
      // terminal) -- finishedAt stays null even though task-1 completed.
      expect(phaseA?.startedAt).not.toBeNull();
      expect(phaseA?.finishedAt).toBeNull();
      // task-1 completed ('done'); task-2's gate landed pass-with-waivers-
      // pending, so it's still 'reviewing' ('review') even though its one
      // finding was waived; task-3 escalated and task-4 left in-progress
      // (both fall to the default 'inProgress' bucket) -- see
      // statusBucketForTaskStatus()'s doc comment.
      expect(phaseA?.statusCounts).toEqual({
        done: 1,
        review: 1,
        inProgress: 2,
        todo: 0,
        superseded: 0,
      });
      expect(phaseA?.epics).toMatchObject([
        {
          epicId: EPIC_ID,
          startedAt: phaseA?.startedAt,
          finishedAt: null,
          statusCounts: { done: 1, review: 1, inProgress: 2, todo: 0, superseded: 0 },
          status: 'in_progress',
          project: 'black-smith',
          prUrl: null,
        },
      ]);

      const phaseB = page.find((m) => m.milestoneId === 'phase-b');
      expect(phaseB).toMatchObject({
        tasksTotal: 0,
        tasksCompleted: 0,
        tokensSpent: 0,
        tokensBudget: null,
      });
      // No epics mapped and no tasks -- no activity to derive a date from.
      expect(phaseB?.startedAt).toBeNull();
      expect(phaseB?.finishedAt).toBeNull();
      expect(phaseB?.statusCounts).toEqual({
        done: 0,
        review: 0,
        inProgress: 0,
        todo: 0,
        superseded: 0,
      });
      expect(phaseB?.epics).toEqual([]);
    });

    it("sums statusCounts' five buckets to tasksTotal, at both the milestone and the epic level", async () => {
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const sumOf = (c: {
        done: number;
        review: number;
        inProgress: number;
        todo: number;
        superseded: number;
      }) => c.done + c.review + c.inProgress + c.todo + c.superseded;

      for (const m of page) {
        expect(sumOf(m.statusCounts)).toBe(m.tasksTotal);
      }
      // phase-a maps exactly one epic (EPIC_ID), so its epic-level sum must
      // equal the same tasksTotal as the milestone it rolls up into.
      const phaseA = page.find((m) => m.milestoneId === 'phase-a');
      expect(
        sumOf(
          phaseA?.epics[0]?.statusCounts ?? {
            done: 0,
            review: 0,
            inProgress: 0,
            todo: 0,
            superseded: 0,
          },
        ),
      ).toBe(phaseA?.tasksTotal);
    });

    it('done === tasksCompleted for every milestone (both are exactly TERMINAL_OK_TASK_STATUSES)', async () => {
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      for (const m of page) {
        expect(m.statusCounts.done).toBe(m.tasksCompleted);
      }
    });
  });

  describe('roadmapPage() statusCounts.superseded (DS4 S5b fix round 1, finding 1)', () => {
    const SUPERSEDED_ROADMAP = `# Roadmap

## Phase S — superseded/failed fixtures
- id: phase-s
- status: in-progress
- epics: [epic-super]
- goal: Covers done/superseded/failed interplay.
`;

    // task-added's initial task_status is honored as long as the row isn't
    // already terminal (projector.ts's guard) — the row is born 'todo', so
    // this sets the status directly, with no dispatch/gate ceremony needed
    // for a fixture that only cares about the terminal value.
    async function addTask(taskId: string, taskStatus: string): Promise<void> {
      const events = await readEvents(SESSION_ID, { stateDir });
      const parent = events[events.length - 1]?.event_id ?? null;
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'planner',
          event_type: 'task-added',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: {
            epic_id: 'epic-super',
            case: 'feature',
            origin: 'user',
            task_status: taskStatus,
            plan_version: 1,
            objective: 'Ship it.',
            claims: [`src/${taskId.replace('/', '-')}.ts`],
            budget_tokens: 100,
          },
        },
        { stateDir },
      );
    }

    async function buildAndRoadmap() {
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();
      return page.find((m) => m.milestoneId === 'phase-s');
    }

    beforeEach(async () => {
      // Reuses the outer beforeEach's already-open SESSION_ID log (one
      // session-start per log) and its own separate epic id (epic-super),
      // so these tasks neither collide with nor need buildFixture()'s own
      // four (TASK_1..TASK_4, epic-1).
      await writeFile(roadmapPath, SUPERSEDED_ROADMAP, 'utf8');
    });

    it('one completed + one waived task: done matches tasksCompleted (both 2), nothing superseded', async () => {
      await addTask('epic-super/task-1', 'completed');
      await addTask('epic-super/task-2', 'waived');
      const phaseS = await buildAndRoadmap();

      expect(phaseS?.tasksCompleted).toBe(2);
      expect(phaseS?.statusCounts).toEqual({
        done: 2,
        review: 0,
        inProgress: 0,
        todo: 0,
        superseded: 0,
      });
    });

    it('one completed + one superseded task: done === tasksCompleted (1), superseded counted separately, epic reads done', async () => {
      await addTask('epic-super/task-1', 'completed');
      await addTask('epic-super/task-2', 'superseded');
      const phaseS = await buildAndRoadmap();

      expect(phaseS?.tasksCompleted).toBe(1);
      expect(phaseS?.statusCounts).toEqual({
        done: 1,
        review: 0,
        inProgress: 0,
        todo: 0,
        superseded: 1,
      });
      // The five-bucket sum still accounts for every task.
      const c = phaseS?.statusCounts;
      expect(
        (c?.done ?? 0) +
          (c?.review ?? 0) +
          (c?.inProgress ?? 0) +
          (c?.todo ?? 0) +
          (c?.superseded ?? 0),
      ).toBe(phaseS?.tasksTotal);
      // The replanned-away task is not "still open": the one live task shipped.
      expect(phaseS?.epics[0]?.status).toBe('done');
    });

    it('one completed + one failed task: epic reads in_progress (a person is still holding the failed task)', async () => {
      await addTask('epic-super/task-1', 'completed');
      await addTask('epic-super/task-2', 'failed');
      const phaseS = await buildAndRoadmap();

      expect(phaseS?.statusCounts).toEqual({
        done: 1,
        review: 0,
        inProgress: 1,
        todo: 0,
        superseded: 0,
      });
      expect(phaseS?.epics[0]?.status).toBe('in_progress');
    });

    it('an epic whose tasks are ALL superseded reads todo (nothing live to call done)', async () => {
      await addTask('epic-super/task-1', 'superseded');
      await addTask('epic-super/task-2', 'superseded');
      const phaseS = await buildAndRoadmap();

      expect(phaseS?.tasksCompleted).toBe(0);
      expect(phaseS?.statusCounts).toEqual({
        done: 0,
        review: 0,
        inProgress: 0,
        todo: 0,
        superseded: 2,
      });
      expect(phaseS?.epics[0]?.status).toBe('todo');
    });
  });

  describe('roadmapPage() epics[].prUrl / sourcePrompt / status', () => {
    async function integrationPrOpened(prUrl: string, causalParent: string): Promise<string> {
      const event = await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'system',
          event_type: 'integration-pr-opened',
          task_id: `${EPIC_ID}/integration`,
          plan_version: 1,
          causal_parent: causalParent,
          payload: { pr_url: prUrl },
        },
        { stateDir },
      );
      return event.event_id;
    }

    it('reports epics[].prUrl from the latest integration-pr-opened event, matching kanban()', async () => {
      const events = await readEvents(SESSION_ID, { stateDir });
      let parent = events[events.length - 1]?.event_id;
      if (!parent) throw new Error('expected the fixture log to be non-empty');
      parent = await integrationPrOpened('https://example.com/pr/1', parent);
      parent = await integrationPrOpened('https://example.com/pr/2', parent); // latest wins

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      const columns = kanban(handle.db, EPIC_ID);
      handle.sqlite.close();

      const phaseA = page.find((m) => m.milestoneId === 'phase-a');
      expect(phaseA?.epics[0]?.prUrl).toBe('https://example.com/pr/2');

      // DS4 S5b — kanban()'s own prUrl output is unchanged by the
      // prUrlsByEpic() extraction: every task in the epic still resolves to
      // the same latest PR url roadmapPage() reports.
      const anyTask = columns.flatMap((c) => c.tasks)[0];
      expect(anyTask?.prUrl).toBe('https://example.com/pr/2');
    });

    it("reports epics[].sourcePrompt matching requestQuoteForTask()'s own shape, and status derived from statusCounts", async () => {
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseA = page.find((m) => m.milestoneId === 'phase-a');
      const quote = phaseA?.epics[0]?.sourcePrompt;
      expect(quote).not.toBeNull();
      expect(quote).toMatchObject({
        prompt: expect.any(String),
        ts: expect.any(String),
        eventId: expect.any(String),
        source: expect.stringMatching(/^(task|epic)$/),
      });
      // 1 done, 1 review, 2 inProgress, 0 todo -- not all done, and not every
      // open task is in review, so 'in_progress' (see epicStatusFromCounts()).
      expect(phaseA?.epics[0]?.status).toBe('in_progress');
    });
  });

  describe('roadmapPage() dates (startedAt/finishedAt)', () => {
    const DATES_ROADMAP = `# Roadmap

## Phase C — All done
- id: phase-c
- status: completed
- epics: [epic-dates]
- goal: Two tasks, both merged.
`;

    let clock: number;

    beforeEach(() => {
      clock = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function tick(): Promise<string> {
      clock += 60_000;
      vi.setSystemTime(new Date(clock));
      const events = await readEvents(SESSION_ID, { stateDir });
      const last = events[events.length - 1];
      if (!last) throw new Error('expected the fixture log to be non-empty');
      return last.event_id;
    }

    async function planTask(taskId: string): Promise<void> {
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'planner',
          event_type: 'task-added',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: {
            epic_id: 'epic-dates',
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
            plan_version: 1,
            objective: 'Ship it.',
            claims: [`src/${taskId.replace('/', '-')}.ts`],
            budget_tokens: 1000,
          },
        },
        { stateDir },
      );
    }

    async function dispatchTask(taskId: string): Promise<void> {
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'planner',
          event_type: 'dispatch_decision',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'small',
            model: 'claude-haiku-4-5',
            reason: 'ship it',
          },
        },
        { stateDir },
      );
    }

    async function mergeTasks(taskIds: string[]): Promise<void> {
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'system',
          event_type: 'wave-merged',
          task_id: taskIds[0],
          plan_version: 1,
          causal_parent: parent,
          payload: { epic_id: 'epic-dates', task_ids: taskIds },
        },
        { stateDir },
      );
    }

    async function errorLog(taskId: string): Promise<void> {
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'system',
          event_type: 'error-logged',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: {
            error: 'execution.tool-failure',
            severity: 'S2-major',
            task_ref: taskId,
            detail: 'a later flow (e.g. lessons/audit) named this already-done task',
          },
        },
        { stateDir },
      );
    }

    async function gateOutcome(taskId: string, outcome: string): Promise<void> {
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'system',
          event_type: 'gate-outcome',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: { outcome, reason: null },
        },
        { stateDir },
      );
    }

    it("reports epics[].status 'review' when every non-done task is in review (none todo, none otherwise in progress)", async () => {
      await writeFile(roadmapPath, DATES_ROADMAP, 'utf8');
      await planTask('epic-dates/task-a');
      await dispatchTask('epic-dates/task-a');
      await mergeTasks(['epic-dates/task-a']); // done

      await planTask('epic-dates/task-b');
      await dispatchTask('epic-dates/task-b');
      await gateOutcome('epic-dates/task-b', 'pass-with-waivers-pending'); // reviewing

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseC = page.find((m) => m.milestoneId === 'phase-c');
      expect(phaseC?.epics[0]?.statusCounts).toEqual({
        done: 1,
        review: 1,
        inProgress: 0,
        todo: 0,
        superseded: 0,
      });
      expect(phaseC?.epics[0]?.status).toBe('review');
    });

    it('reports startedAt from the earliest DISPATCH, not the earliest task-added (planning != starting)', async () => {
      await writeFile(roadmapPath, DATES_ROADMAP, 'utf8');
      await planTask('epic-dates/task-a');
      const dbPathNoDispatch = path.join(dbDir, 'no-dispatch.db');
      await rebuild(dbPathNoDispatch, 'all', { stateDir, roadmapPath });
      const noDispatchHandle = openDb(dbPathNoDispatch);
      const noDispatchPage = roadmapPage(noDispatchHandle.db);
      noDispatchHandle.sqlite.close();
      const noDispatchPhase = noDispatchPage.find((m) => m.milestoneId === 'phase-c');
      // Planned but never dispatched: not "not scheduled" as started.
      expect(noDispatchPhase?.startedAt).toBeNull();
      expect(noDispatchPhase?.epics).toMatchObject([
        {
          epicId: 'epic-dates',
          startedAt: null,
          finishedAt: null,
          statusCounts: { done: 0, review: 0, inProgress: 0, todo: 1 },
          status: 'todo',
          project: 'black-smith',
          prUrl: null,
        },
      ]);

      await dispatchTask('epic-dates/task-a');
      const dispatchTs = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.record.ts;

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseC = page.find((m) => m.milestoneId === 'phase-c');
      expect(phaseC?.startedAt).toBe(dispatchTs);
      expect(phaseC?.finishedAt).toBeNull();
    });

    it('reports finishedAt from the first terminal transition, unmoved by a LATER error-logged naming an already-done task', async () => {
      await writeFile(roadmapPath, DATES_ROADMAP, 'utf8');
      await planTask('epic-dates/task-a'); // T0
      await dispatchTask('epic-dates/task-a'); // T1
      const startedTs = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.record.ts;

      await mergeTasks(['epic-dates/task-a']); // T2
      const mergedTs = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.record.ts;

      await errorLog('epic-dates/task-a'); // T3 — names the already-merged task

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseC = page.find((m) => m.milestoneId === 'phase-c');
      expect(phaseC?.startedAt).toBe(startedTs);
      // Drift regression: finishedAt must stay T2, never the T3 touch.
      expect(phaseC?.finishedAt).toBe(mergedTs);
      expect(phaseC?.epics).toMatchObject([
        {
          epicId: 'epic-dates',
          startedAt: startedTs,
          finishedAt: mergedTs,
          statusCounts: { done: 1, review: 0, inProgress: 0, todo: 0 },
          status: 'done',
          project: 'black-smith',
          prUrl: null,
        },
      ]);
    });

    it('leaves finishedAt null for a phase (and its epic) while one of its tasks is still open', async () => {
      await writeFile(roadmapPath, DATES_ROADMAP, 'utf8');
      await planTask('epic-dates/task-a');
      await dispatchTask('epic-dates/task-a');
      await mergeTasks(['epic-dates/task-a']);

      await planTask('epic-dates/task-b');
      await dispatchTask('epic-dates/task-b'); // dispatched, never merged

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseC = page.find((m) => m.milestoneId === 'phase-c');
      expect(phaseC?.finishedAt).toBeNull();
      // task-a merged (done), task-b dispatched but never merged (inProgress).
      expect(phaseC?.epics).toMatchObject([
        {
          epicId: 'epic-dates',
          startedAt: phaseC?.startedAt,
          finishedAt: null,
          statusCounts: { done: 1, review: 0, inProgress: 1, todo: 0 },
          status: 'in_progress',
          project: 'black-smith',
          prUrl: null,
        },
      ]);
    });
  });

  describe('overview().milestoneProgress', () => {
    it('embeds the same per-milestone progress rows as roadmapPage(), minus roadmapPage()-only mini-timeline fields', async () => {
      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);

      const result = overview(handle.db);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      // Phase 6b: roadmapPage() additionally computes each milestone's
      // recentDone/nextUp mini-timeline (operator directive 4) — overview()
      // intentionally omits it (its own card doesn't render the timeline,
      // and computing it is one extra edges-table scan per call).
      const pageWithoutTaskRefs = page.map(({ recentDone, nextUp, ...rest }) => rest);
      expect(result.milestoneProgress).toEqual(pageWithoutTaskRefs);
      expect(page.every((m) => m.recentDone !== undefined && m.nextUp !== undefined)).toBe(true);
    });
  });

  describe("roadmapPage()'s NEXT mini-timeline order", () => {
    // NEXT is the operator's "what do I pick up next" list, and
    // milestoneTaskRefs promises "oldest-created first within each group".
    // It sorted on `updatedAt`, which db/projector.ts's touch() rewrites on
    // EVERY event carrying the task id -- so dispatching the task that was
    // planned FIRST (into `in-progress`, a status NEXT still lists) sank it
    // below a task planned after it and untouched since. The one task
    // already being worked on is exactly the one the operator expects at the
    // head of NEXT, not at its tail.
    const ORDER_ROADMAP = `# Roadmap

## Phase A — Ordering
- id: phase-a
- status: in-progress
- epics: [epic-order]
- goal: Two tasks planned in order, the first of them dispatched.
`;

    let clock: number;

    beforeEach(() => {
      clock = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** appendEvent() stamps `ts` off the clock; step it so two appends in the
     * same millisecond cannot decide the assertion. */
    async function tick(): Promise<string> {
      clock += 60_000;
      vi.setSystemTime(new Date(clock));
      const events = await readEvents(SESSION_ID, { stateDir });
      const last = events[events.length - 1];
      if (!last) throw new Error('expected the fixture log to be non-empty');
      return last.event_id;
    }

    async function planTask(taskId: string, objective: string): Promise<void> {
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'planner',
          event_type: 'task-added',
          task_id: taskId,
          plan_version: 1,
          causal_parent: parent,
          payload: {
            epic_id: 'epic-order',
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
            plan_version: 1,
            objective,
            claims: [`src/${taskId.replace('/', '-')}.ts`],
            budget_tokens: 1000,
          },
        },
        { stateDir },
      );
    }

    it('lists NEXT oldest-planned first, even once the first one is dispatched', async () => {
      await writeFile(roadmapPath, ORDER_ROADMAP, 'utf8');
      await planTask('epic-order/task-a', 'Planned first.');
      await planTask('epic-order/task-b', 'Planned second.');

      // Dispatching task-a touches only its `updatedAt`, and leaves it in
      // `in-progress` -- a status NEXT still lists.
      const parent = await tick();
      await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'planner',
          event_type: 'dispatch_decision',
          task_id: 'epic-order/task-a',
          plan_version: 1,
          causal_parent: parent,
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            model: 'claude-sonnet-5',
            spec_ref: 'factory/specs/active/epic-order/task-a.json',
            reason: 'start the first-planned task',
          },
        },
        { stateDir },
      );

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseA = page.find((m) => m.milestoneId === 'phase-a');
      expect(phaseA?.nextUp?.map((t) => t.taskId)).toEqual([
        'epic-order/task-a',
        'epic-order/task-b',
      ]);
    });
  });
});

describe('roadmapPage() epics[].sourcePrompt — absent case', () => {
  // A session with no recordUserPrompt() anywhere in its log: no user_prompt
  // event exists for epicSourcePrompt()'s lineage walk to find.
  const NO_PROMPT_SESSION = 'sess-no-prompt';
  const NO_PROMPT_ROADMAP = `# Roadmap

## Phase D — No prompt
- id: phase-d
- status: in-progress
- epics: [epic-no-prompt]
- goal: A task with no recorded prompt anywhere in its session.
`;

  it('reports sourcePrompt as null when no user_prompt is recorded in the lineage', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-milestones-no-prompt-events-'));
    const dbDir = await mkdtemp(path.join(tmpdir(), 'smith-milestones-no-prompt-db-'));
    try {
      const roadmapPath = path.join(dbDir, 'roadmap.md');
      await writeFile(roadmapPath, NO_PROMPT_ROADMAP, 'utf8');

      const root = await appendEvent(
        {
          session_id: NO_PROMPT_SESSION,
          actor: 'planner',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        },
        { stateDir },
      );
      await appendEvent(
        {
          session_id: NO_PROMPT_SESSION,
          actor: 'planner',
          event_type: 'task-added',
          task_id: 'epic-no-prompt/task-a',
          plan_version: 1,
          causal_parent: root.event_id,
          payload: {
            epic_id: 'epic-no-prompt',
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
            plan_version: 1,
            objective: 'Ship it.',
            claims: ['src/epic-no-prompt-task-a.ts'],
            budget_tokens: 1000,
          },
        },
        { stateDir },
      );

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const page = roadmapPage(handle.db);
      handle.sqlite.close();

      const phaseD = page.find((m) => m.milestoneId === 'phase-d');
      expect(phaseD?.epics[0]?.sourcePrompt).toBeNull();
      expect(phaseD?.epics[0]?.statusCounts).toEqual({
        done: 0,
        review: 0,
        inProgress: 0,
        todo: 1,
        superseded: 0,
      });
      expect(phaseD?.epics[0]?.status).toBe('todo');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(dbDir, { recursive: true, force: true });
    }
  });
});
