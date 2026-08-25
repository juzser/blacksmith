import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, openDb, rebuild } from '../../src/db/projector.js';
import { overview, roadmapPage } from '../../src/db/queries.js';
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

      const phaseB = page.find((m) => m.milestoneId === 'phase-b');
      expect(phaseB).toMatchObject({
        tasksTotal: 0,
        tasksCompleted: 0,
        tokensSpent: 0,
        tokensBudget: null,
      });
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
