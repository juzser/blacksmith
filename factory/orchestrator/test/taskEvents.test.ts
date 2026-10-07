import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldTasks } from '../src/db/projector.js';
import { appendEvent, readEvents } from '../src/events.js';
import type { PlanFile } from '../src/plan.js';
import {
  emitEdgesRecorded,
  emitFollowUpTask,
  emitTaskBlocked,
  emitTaskSuperseded,
  emitTasksAdded,
  emitWaveAdmitted,
  emitWaveMerged,
  planIngestGaps,
  readAddedTasks,
  type TaskEventContext,
  unadmissibleTasks,
} from '../src/taskEvents.js';
import { git } from './helpers/process.js';

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 'epic-1/task-1',
    epic_id: 'epic-1',
    plan_version: 1,
    objective: 'Do the thing.',
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: ['src/foo/**'],
    budget: { tokens: 1000, diff_lines: 100, max_turns: 10 },
    contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
    ...overrides,
  };
}

/** The shape `findings raise` mints for a finding no open task can own. */
function followUp(overrides: Record<string, unknown> = {}) {
  return {
    epicId: 'epic-1',
    taskId: 'epic-1/followup-4b70d608',
    objective: 'Fix: bare CR is silently swallowed by the line splitter',
    claims: ['src/parse.ts', 'test/parse.test.ts'],
    ...overrides,
  };
}

function planWith(...tasks: Record<string, unknown>[]): PlanFile {
  return {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: tasks as PlanFile['tasks'],
    edges: [],
  };
}

/** `task` depends on `dependsOn`, spelled the way a plan file spells it. */
function edge(task: string, dependsOn: string, edgeType = 'artifact'): PlanFile['edges'][number] {
  return { task, dependsOn, edge_type: edgeType, edge_provenance: 'declared' };
}

describe('taskEvents', () => {
  let stateDir: string;
  const sessionId = 'sess-p9-29';
  let ctx: TaskEventContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-taskevents-'));
    const root = await appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    ctx = { sessionId, planVersion: 1, causalParent: root.event_id, actor: 'system' };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function typesFor(eventType: string) {
    const events = await readEvents(sessionId, { stateDir });
    return events.filter((e) => e.record.event_type === eventType).map((e) => e.record);
  }

  describe('emitTasksAdded', () => {
    it('emits one task-added per plan task, carrying the fields the projector folds', async () => {
      const plan = planWith(task(), task({ task_id: 'epic-1/task-2', case: 'bugfix' }));
      await emitTasksAdded(plan, ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added.map((r) => r.task_id)).toEqual(['epic-1/task-1', 'epic-1/task-2']);
      expect(added[0]?.payload).toMatchObject({
        epic_id: 'epic-1',
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
        plan_version: 1,
        objective: 'Do the thing.',
        claims: ['src/foo/**'],
        budget_tokens: 1000,
        // D-23/P9-12: the branch is declared at add time, not inferred later.
        // The board needs to link to it before any worktree exists, and a
        // second derivation of the convention is a second thing to keep right.
        branch: 'bs/epic-1/task-1',
      });
    });

    // DS3 — title/summary are optional task-spec fields; present them when
    // the spec carries them, and never fabricate a value when it does not.
    it('carries title/summary through when the spec sets them, and omits them when it does not', async () => {
      const plan = planWith(
        task({ task_id: 'epic-1/task-1', title: 'Add the widget', summary: 'Renders the widget.' }),
        task({ task_id: 'epic-1/task-2' }),
      );
      await emitTasksAdded(plan, ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added[0]?.payload).toMatchObject({
        title: 'Add the widget',
        summary: 'Renders the widget.',
      });
      expect(added[1]?.payload?.title).toBeUndefined();
      expect(added[1]?.payload?.summary).toBeUndefined();
    });

    it('declares the branch worktree.ts will actually create, epic prefix and all', async () => {
      const plan = planWith(task({ task_id: 'epic-1/task-1' }), {
        ...task({ task_id: 'loose-task', epic_id: 'epic-2' }),
      });
      await emitTasksAdded(plan, ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added.map((r) => r.payload?.branch)).toEqual([
        'bs/epic-1/task-1', // epic prefix stripped, never doubled
        'bs/epic-2/loose-task', // an id that carries no epic is used whole
      ]);
    });

    it('is idempotent — a second ingest of the same plan adds nothing', async () => {
      const plan = planWith(task());
      await emitTasksAdded(plan, ctx, { stateDir });
      const second = await emitTasksAdded(plan, ctx, { stateDir });

      expect(second).toHaveLength(0);
      expect(await typesFor('task-added')).toHaveLength(1);
    });

    // D-18 (dogfood, demo-rpg-reading-interface). An amendment supersedes a
    // task by REUSING its id: v(n+1) carries the dead copy beside a live one
    // at the higher plan_version. Keying "already added" on the id alone made
    // that live record invisible, so the amended task kept the projected
    // plan_version of the version it was first added under — and
    // `satisfiedAmendments` (epic.ts), which requires `planVersion >= version`
    // for every id the amendment names, could never discharge the finding that
    // forced the amendment. Measured: ingest of a v2 plan reported
    // `added: 1, skipped: 7`, and the two superseded-and-replaced tasks still
    // read plan_version 1. Epic 1 hit the same deadlock and it was diagnosed as
    // "ingest was never run"; that was incomplete — running it correctly, twice,
    // still deadlocks without this.
    it('re-adds a task whose live spec carries a higher plan_version than the one recorded', async () => {
      await emitTasksAdded(planWith(task()), ctx, { stateDir });

      // The v2 shape draftNextVersion writes: the dead v1 copy, then the live v2 one.
      const amended = planWith(
        task({ task_status: 'superseded', plan_version: 1 }),
        task({ plan_version: 2, objective: 'Do the thing, with restart.' }),
      );
      amended.version = 2;
      const second = await emitTasksAdded(amended, { ...ctx, planVersion: 2 }, { stateDir });

      const addedEvents = await typesFor('task-added');
      expect(addedEvents).toHaveLength(2);
      expect(second.map((e) => e.record.task_id)).toEqual(['epic-1/task-1']);
      // The point of re-adding: the projector reads plan_version off task-added
      // and is last-wins, so the row now carries the version the amendment cut.
      const readded = addedEvents[1]?.payload as
        | { plan_version?: number; objective?: string }
        | undefined;
      expect(readded?.plan_version).toBe(2);
      expect(readded?.objective).toBe('Do the thing, with restart.');
    });

    it('stays idempotent at the same plan_version — re-ingesting an amended plan adds nothing', async () => {
      const amended = planWith(
        task({ task_status: 'superseded', plan_version: 1 }),
        task({ plan_version: 2 }),
      );
      amended.version = 2;
      await emitTasksAdded(amended, { ...ctx, planVersion: 2 }, { stateDir });
      const again = await emitTasksAdded(amended, { ...ctx, planVersion: 2 }, { stateDir });

      expect(again).toHaveLength(0);
      expect(await typesFor('task-added')).toHaveLength(1);
    });

    it('does not re-add when the live spec carries a LOWER plan_version than the record', async () => {
      const v2 = planWith(task({ plan_version: 2 }));
      v2.version = 2;
      await emitTasksAdded(v2, { ...ctx, planVersion: 2 }, { stateDir });
      const stale = await emitTasksAdded(planWith(task({ plan_version: 1 })), ctx, { stateDir });

      expect(stale).toHaveLength(0);
      expect(await typesFor('task-added')).toHaveLength(1);
    });

    // D-18b. `plan amend`'s draftNextVersion stamps EVERY task with the new
    // plan_version, carried ones included, so a version-aware ingest would
    // re-add tasks whose spec never changed. Only the ids the amendment
    // actually touched — the ones carrying a superseded record beside a live
    // one — get a second task-added.
    it('does not re-add a carried task whose version was merely restamped by the amendment', async () => {
      await emitTasksAdded(planWith(task(), task({ task_id: 'epic-1/task-2' })), ctx, { stateDir });

      // v2: task-1 was genuinely amended (dead copy + live copy); task-2 was
      // only carried forward, but draftNextVersion restamped it to 2 anyway.
      const amended = planWith(
        task({ task_status: 'superseded', plan_version: 1 }),
        task({ plan_version: 2 }),
        task({ task_id: 'epic-1/task-2', plan_version: 2 }),
      );
      amended.version = 2;
      const second = await emitTasksAdded(amended, { ...ctx, planVersion: 2 }, { stateDir });

      expect(second.map((e) => e.record.task_id)).toEqual(['epic-1/task-1']);
    });

    it('emits task-superseded for a task the plan marks superseded, once', async () => {
      const plan = planWith(task({ task_id: 'epic-1/task-1', task_status: 'superseded' }));
      await emitTasksAdded(plan, ctx, { stateDir });
      await emitTasksAdded(plan, ctx, { stateDir });

      const superseded = await typesFor('task-superseded');
      expect(superseded).toHaveLength(1);
      expect(superseded[0]?.task_id).toBe('epic-1/task-1');
    });

    // D-184. `draftNextVersion` keeps each superseded copy of a task *beside*
    // the record that replaced it, under the same `task_id` (D-121), so a
    // v(n+1) file is routinely longer than the backlog it describes:
    // envkit-mcp-surface's plan-v5.json holds 13 records for 5 live tasks,
    // four ids appearing three times each. Walking the file record by record
    // ingests every dead copy as if it were a task of its own.
    it('ingests each id once, from its live spec, not from every dead copy', async () => {
      const plan = planWith(
        task({ task_status: 'superseded' }),
        task({ task_id: 'epic-1/task-2' }),
        task({ objective: 'Do the thing, properly.' }),
      );
      const written = await emitTasksAdded(plan, ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added.map((r) => r.task_id)).toEqual(['epic-1/task-1', 'epic-1/task-2']);
      expect(added[0]?.payload?.objective).toBe('Do the thing, properly.');
      // The id is not superseded: the same plan still lists a live spec for
      // it. Saying otherwise in an append-only log is a claim nothing retracts.
      expect(await typesFor('task-superseded')).toEqual([]);
      // "5 added, 0 already present" — the backlog, not the file's length.
      expect(written).toHaveLength(2);
    });

    // The record order above is the one `draftNextVersion` writes (dead
    // copies first), and under it the projector's last-write-wins happens to
    // land on the right status. Nothing here depends on that, so nothing here
    // should break when it changes.
    it('projects the live status whichever copy the plan happens to list last', async () => {
      const plan = planWith(
        task({ objective: 'the live spec' }),
        task({ task_status: 'superseded', objective: 'the copy it replaced' }),
      );
      await emitTasksAdded(plan, ctx, { stateDir });

      const rows = foldTasks(await readEvents(sessionId, { stateDir }));
      expect(rows.map((r) => [r.taskId, r.taskStatus])).toEqual([['epic-1/task-1', 'todo']]);
    });

    // The shape on disk today: factory/specs/active/envkit-mcp-surface/
    // plan-v5.json, 13 records for 5 live tasks, four ids three times each.
    it('reports the backlog a real v5 plan describes, not its record count', async () => {
      const copies = ['superseded', 'superseded', 'todo'].flatMap((task_status) =>
        [1, 2, 3, 4].map((n) => task({ task_id: `epic-1/task-${n}`, task_status })),
      );
      const plan = planWith(...copies, task({ task_id: 'epic-1/task-5' }));
      const written = await emitTasksAdded(plan, ctx, { stateDir });

      expect(plan.tasks).toHaveLength(13);
      expect(written).toHaveLength(5);
      expect(await typesFor('task-superseded')).toEqual([]);
    });

    it('still supersedes an id whose every record is dead, once', async () => {
      const plan = planWith(
        task({ task_status: 'superseded', objective: 'first attempt' }),
        task({ task_status: 'superseded', objective: 'second attempt' }),
      );
      const written = await emitTasksAdded(plan, ctx, { stateDir });

      expect((await typesFor('task-added')).map((r) => r.payload?.objective)).toEqual([
        'second attempt',
      ]);
      expect(await typesFor('task-superseded')).toHaveLength(1);
      expect(written).toHaveLength(2);
    });
  });

  // bs-rename part 1. `plan ingest`'s `--project` flag resolves the branch
  // prefix per epic, the same way `worktree create` does, instead of always
  // declaring the plain `bs` default.
  describe('emitTasksAdded — projectDir resolves the branch prefix', () => {
    let projectRoot: string;
    let projectDir: string;

    beforeEach(async () => {
      projectRoot = await mkdtemp(path.join(tmpdir(), 'smith-taskevents-project-'));
      const originDir = path.join(projectRoot, 'origin.git');
      projectDir = path.join(projectRoot, 'project');
      git(projectRoot, ['init', '-q', '--bare', '-b', 'main', originDir]);
      git(projectRoot, ['clone', '-q', originDir, projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test']);
      await writeFile(path.join(projectDir, 'README.md'), '# project\n');
      git(projectDir, ['add', '.']);
      git(projectDir, ['commit', '-q', '-m', 'init']);
      git(projectDir, ['push', '-q', 'origin', 'main']);
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
    });

    it('declares smith/... for an epic already integrating on smith/<epic>/integration', async () => {
      git(projectDir, ['branch', 'smith/epic-1/integration', 'main']);

      await emitTasksAdded(planWith(task()), ctx, { stateDir }, projectDir);

      const added = await typesFor('task-added');
      expect(added[0]?.payload?.branch).toBe('smith/epic-1/task-1');
    });

    it('still declares bs/... for a brand-new epic with a projectDir but no legacy branch', async () => {
      await emitTasksAdded(planWith(task()), ctx, { stateDir }, projectDir);

      const added = await typesFor('task-added');
      expect(added[0]?.payload?.branch).toBe('bs/epic-1/task-1');
    });

    it('without a projectDir, keeps declaring bs/... even when a legacy branch exists', async () => {
      git(projectDir, ['branch', 'smith/epic-1/integration', 'main']);

      await emitTasksAdded(planWith(task()), ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added[0]?.payload?.branch).toBe('bs/epic-1/task-1');
    });
  });

  // #250. `wave check --session` must refuse a plan version the lineage never
  // ingested, and it asks through the same decision the ingest makes.
  describe('planIngestGaps', () => {
    it('names every event an ingest would still write, and writes none of them', async () => {
      const plan = planWith(task(), task({ task_id: 'epic-1/task-2', task_status: 'superseded' }));
      const gaps = await planIngestGaps(plan, { sessionId }, { stateDir });

      expect(gaps).toEqual([
        { taskId: 'epic-1/task-1', eventType: 'task-added' },
        { taskId: 'epic-1/task-2', eventType: 'task-added' },
        { taskId: 'epic-1/task-2', eventType: 'task-superseded' },
      ]);
      expect(await typesFor('task-added')).toEqual([]);
    });

    it('is empty once the plan has been ingested', async () => {
      const plan = planWith(task(), task({ task_id: 'epic-1/task-2' }));
      await emitTasksAdded(plan, ctx, { stateDir });

      expect(await planIngestGaps(plan, { sessionId }, { stateDir })).toEqual([]);
    });

    it('names the amended ids of a v2 cut whose v1 alone was ingested', async () => {
      await emitTasksAdded(planWith(task(), task({ task_id: 'epic-1/task-2' })), ctx, {
        stateDir,
      });
      const amended = planWith(
        task({ task_status: 'superseded', plan_version: 1 }),
        task({ plan_version: 2 }),
        task({ task_id: 'epic-1/task-2', plan_version: 2 }),
      );
      amended.version = 2;

      expect(await planIngestGaps(amended, { sessionId }, { stateDir })).toEqual([
        { taskId: 'epic-1/task-1', eventType: 'task-added' },
      ]);
    });
  });

  describe('unadmissibleTasks', () => {
    it('splits ids with no row from ids whose status is terminal', () => {
      const statusOf = new Map([
        ['epic-1/task-1', 'todo'],
        ['epic-1/task-2', 'superseded'],
        ['epic-1/task-3', 'completed'],
        ['epic-1/task-4', 'in-progress'],
      ]);
      expect(
        unadmissibleTasks(
          ['epic-1/task-1', 'epic-1/task-2', 'epic-1/task-3', 'epic-1/task-4', 'epic-1/ghost'],
          statusOf,
        ),
      ).toEqual({
        missing: ['epic-1/ghost'],
        terminal: [
          { taskId: 'epic-1/task-2', taskStatus: 'superseded' },
          { taskId: 'epic-1/task-3', taskStatus: 'completed' },
        ],
      });
    });

    it('admits every live id', () => {
      const statusOf = new Map([
        ['epic-1/task-1', 'todo'],
        ['epic-1/followup-4b70d608', 'ready'],
      ]);
      expect(unadmissibleTasks(['epic-1/task-1', 'epic-1/followup-4b70d608'], statusOf)).toEqual({
        missing: [],
        terminal: [],
      });
    });

    // HELD_OPEN_BY_AN_OPERATOR: work can still land on a failed or escalated
    // task, and the escalation ladder re-admits it — refusing it here would
    // strand the retry the ladder exists to run.
    it('admits a failed and an escalated task, which an operator still holds', () => {
      const statusOf = new Map([
        ['epic-1/task-1', 'failed'],
        ['epic-1/task-2', 'escalated'],
        ['epic-1/task-3', 'waived'],
      ]);
      expect(
        unadmissibleTasks(['epic-1/task-1', 'epic-1/task-2', 'epic-1/task-3'], statusOf),
      ).toEqual({
        missing: [],
        terminal: [{ taskId: 'epic-1/task-3', taskStatus: 'waived' }],
      });
    });
  });

  // D-254. A plan declares a DAG, not a list: `plan.edges` is what the
  // scheduler reads to build waves and what every dependency claim on the
  // Flow and Roadmap pages rests on. Until this emitter existed the ingest
  // wrote the nodes and dropped the arrows, so the `edges` table was empty in
  // every real db and the DAG rendered as one flat wave.
  describe('emitEdgesRecorded', () => {
    it('emits one edge-recorded per declared edge, the dependent task as subject', async () => {
      const plan = {
        ...planWith(task(), task({ task_id: 'epic-1/task-2' })),
        edges: [edge('epic-1/task-2', 'epic-1/task-1')],
      };
      const written = await emitEdgesRecorded(plan, ctx, { stateDir });

      const recorded = await typesFor('edge-recorded');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.task_id).toBe('epic-1/task-2');
      expect(recorded[0]?.payload.depends_on).toBe('epic-1/task-1');
      expect(recorded[0]?.payload.epic_id).toBe('epic-1');
      expect(recorded[0]?.edge).toEqual({ edge_type: 'artifact', edge_provenance: 'declared' });
      expect(written).toHaveLength(1);
    });

    it('writes nothing for a plan that declares no edges', async () => {
      const written = await emitEdgesRecorded(planWith(task()), ctx, { stateDir });

      expect(written).toEqual([]);
      expect(await typesFor('edge-recorded')).toEqual([]);
    });

    // Same reason `task-added` is idempotent: re-ingesting a plan is normal
    // (a resumed session, a v(n+1) that carries v1's edges forward), and
    // doubling the arrows would double every line the Flow page draws.
    it('adds nothing on a re-ingest of the same plan', async () => {
      const plan = {
        ...planWith(task(), task({ task_id: 'epic-1/task-2' })),
        edges: [edge('epic-1/task-2', 'epic-1/task-1')],
      };
      await emitEdgesRecorded(plan, ctx, { stateDir });
      const second = await emitEdgesRecorded(plan, ctx, { stateDir });

      expect(second).toEqual([]);
      expect(await typesFor('edge-recorded')).toHaveLength(1);
    });

    // Keyed on the triple, not the pair: demo-rpg-chapter-reading's plan-v1
    // declares both an `artifact` and a `claim-order` edge between the same
    // two tasks, and they are two different claims about the same handoff.
    it('keeps both edges when a plan declares two types between one pair', async () => {
      const plan = {
        ...planWith(task(), task({ task_id: 'epic-1/task-2' })),
        edges: [
          edge('epic-1/task-2', 'epic-1/task-1', 'artifact'),
          edge('epic-1/task-2', 'epic-1/task-1', 'claim-order'),
        ],
      };
      await emitEdgesRecorded(plan, ctx, { stateDir });
      const second = await emitEdgesRecorded(plan, ctx, { stateDir });

      const recorded = await typesFor('edge-recorded');
      expect(recorded.map((r) => r.edge?.edge_type)).toEqual(['artifact', 'claim-order']);
      expect(second).toEqual([]);
    });

    // The plan declares the same handoff twice with no extra information;
    // one arrow is what it means.
    it('collapses an edge the plan repeats verbatim', async () => {
      const plan = {
        ...planWith(task(), task({ task_id: 'epic-1/task-2' })),
        edges: [edge('epic-1/task-2', 'epic-1/task-1'), edge('epic-1/task-2', 'epic-1/task-1')],
      };
      const written = await emitEdgesRecorded(plan, ctx, { stateDir });

      expect(written).toHaveLength(1);
    });

    it('emits an edge whose ends the plan spells bare', async () => {
      const plan = {
        ...planWith(task(), task({ task_id: 'epic-1/task-2' })),
        edges: [edge('task-2', 'task-1')],
      };
      await emitEdgesRecorded(plan, ctx, { stateDir });

      const recorded = await typesFor('edge-recorded');
      expect(recorded[0]?.task_id).toBe('epic-1/task-2');
      expect(recorded[0]?.payload.depends_on).toBe('epic-1/task-1');
    });

    // Same refusal `emitWaveAdmitted` makes, for the same reason: an arrow to
    // a task that does not exist is a plan bug, and writing it would leave an
    // edge every reader silently drops rather than a error anyone sees.
    it('refuses an edge naming a task the plan does not contain', async () => {
      const plan = { ...planWith(task()), edges: [edge('epic-1/task-1', 'epic-1/task-9')] };

      await expect(emitEdgesRecorded(plan, ctx, { stateDir })).rejects.toThrow(/task "epic-1/);
      expect(await typesFor('edge-recorded')).toEqual([]);
    });
  });

  describe('emitWaveAdmitted', () => {
    it('records the plan spelling of every admitted id, whatever was typed', async () => {
      const plan = planWith(task(), task({ task_id: 'epic-1/task-2' }));
      await emitWaveAdmitted(plan, ['task-1', 'epic-1/task-2'], ctx, { stateDir });

      const admitted = await typesFor('wave-admitted');
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.payload.task_ids).toEqual(['epic-1/task-1', 'epic-1/task-2']);
    });

    it('refuses a wave naming a task the plan does not contain', async () => {
      const plan = planWith(task());
      await expect(emitWaveAdmitted(plan, ['task-9'], ctx, { stateDir })).rejects.toThrow(
        /no task "task-9"/,
      );
      expect(await typesFor('wave-admitted')).toHaveLength(0);
    });

    // D-48/P9-31: the plan cannot declare a task that did not exist when it
    // was cut. A follow-up lives in the log, so the log is the second
    // register an id may be found in — and a bare spelling of one resolves
    // the same way a planned id's does.
    it('admits a follow-up the log added, which the plan never declared', async () => {
      const plan = planWith(task());
      await emitFollowUpTask(followUp(), ctx, { stateDir });
      await emitWaveAdmitted(plan, ['followup-4b70d608'], ctx, { stateDir });

      const admitted = await typesFor('wave-admitted');
      expect(admitted[0]?.payload.task_ids).toEqual(['epic-1/followup-4b70d608']);
    });
  });

  describe('emitWaveMerged', () => {
    it('records one event per task at the moment that task merged', async () => {
      await emitWaveMerged('epic-1/task-1', ctx, { stateDir });
      await emitWaveMerged('epic-1/task-2', ctx, { stateDir });

      const merged = await typesFor('wave-merged');
      expect(merged.map((r) => r.payload.task_ids)).toEqual([['epic-1/task-1'], ['epic-1/task-2']]);
    });
  });

  describe('emitTaskBlocked', () => {
    it('logs a taxonomy-valid error class against the task', async () => {
      await emitTaskBlocked(
        'epic-1/task-1',
        { error: 'execution.test-failure', severity: 'S2-major', detail: 'suite red' },
        ctx,
        { stateDir },
      );

      const logged = await typesFor('error-logged');
      expect(logged[0]?.task_id).toBe('epic-1/task-1');
      expect(logged[0]?.payload).toMatchObject({
        error: 'execution.test-failure',
        severity: 'S2-major',
        task_ref: 'epic-1/task-1',
      });
    });

    it('rejects an error class the taxonomy does not know', async () => {
      await expect(
        emitTaskBlocked(
          'epic-1/task-1',
          { error: 'execution.not-a-real-class', severity: 'S2-major' },
          ctx,
          { stateDir },
        ),
      ).rejects.toThrow();
    });
  });

  describe('emitTaskSuperseded', () => {
    it('supersedes the plan spelling of a bare id', async () => {
      const plan = planWith(task());
      await emitTaskSuperseded(plan, 'task-1', ctx, { stateDir });

      expect((await typesFor('task-superseded'))[0]?.task_id).toBe('epic-1/task-1');
    });

    // Superseding is the other terminal exit a follow-up needs: an operator
    // who folds the bug into a replanned task must be able to say so without
    // hand-writing the event (D-48/P9-31).
    it('supersedes a follow-up the log added, which the plan cannot name', async () => {
      const plan = planWith(task());
      await emitFollowUpTask(followUp(), ctx, { stateDir });
      await emitTaskSuperseded(plan, 'epic-1/followup-4b70d608', ctx, { stateDir });

      expect((await typesFor('task-superseded'))[0]?.task_id).toBe('epic-1/followup-4b70d608');
    });
  });

  // D-48/P9-31: the log is the only place a follow-up exists, so it has to be
  // readable as a register of tasks — ids AND claims. Ids alone would let a
  // wave admit a follow-up with an empty claim set, which is a task allowed to
  // touch nothing.
  // D-232. Every plan file under factory/specs/ declares its `project`, and
  // until now nothing at runtime read it: `plan ingest` handed the plan to
  // emitTasksAdded, which passed it to addedPayload() and dropped the field.
  // So every event of a demo-rpg run landed with a NULL project, and
  // db/queries.ts's projectOf() reads a NULL back as the default project --
  // filing 307 events, 12 tasks and 2 epics under black-smith, invisible on
  // the board of the project they actually belong to.
  describe('project scope', () => {
    it("stamps the plan's project on every event it writes", async () => {
      const plan = {
        ...planWith(task(), task({ task_id: 'epic-1/task-2' })),
        project: 'demo-rpg',
        edges: [edge('epic-1/task-2', 'epic-1/task-1')],
      };
      await emitTasksAdded(plan, ctx, { stateDir });
      await emitEdgesRecorded(plan, ctx, { stateDir });
      await emitWaveAdmitted(plan, ['epic-1/task-1'], ctx, { stateDir });
      await emitTaskSuperseded(plan, 'epic-1/task-2', ctx, { stateDir });

      for (const type of ['task-added', 'edge-recorded', 'wave-admitted', 'task-superseded']) {
        const records = await typesFor(type);
        expect(records.length).toBeGreaterThan(0);
        expect(records.map((r) => r.project)).toEqual(records.map(() => 'demo-rpg'));
      }
    });

    // The writer never invents the default. events.ts says so in as many
    // words: an absent project is resolved by db/queries.ts's read helpers,
    // "never by this writer -- the log stays a faithful record of what was
    // actually stamped". A plan that declares nothing writes nothing.
    it('leaves the envelope absent when the plan declares no project', async () => {
      await emitTasksAdded(planWith(task()), ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added).toHaveLength(1);
      expect(added[0]?.project).toBeUndefined();
    });

    // A caller that knows better than the file it was handed still wins --
    // the plan is the fallback, not an override.
    it("prefers an explicit ctx.project over the plan's", async () => {
      const plan = { ...planWith(task()), project: 'demo-rpg' };
      await emitTasksAdded(plan, { ...ctx, project: 'envkit' }, { stateDir });

      expect((await typesFor('task-added'))[0]?.project).toBe('envkit');
    });

    // A follow-up is minted inside a wave, where no plan is at hand and the
    // wave-runner stamps no project -- so it carries the project of the task
    // whose finding it was raised for, as the log already recorded it.
    it("stamps a follow-up with the originating task's project", async () => {
      await emitTasksAdded({ ...planWith(task()), project: 'beta' }, ctx, { stateDir });

      await emitFollowUpTask(followUp({ fromTaskId: 'epic-1/task-1' }), ctx, { stateDir });

      const added = await typesFor('task-added');
      expect(added.map((r) => [r.task_id, r.project])).toEqual([
        ['epic-1/task-1', 'beta'],
        ['epic-1/followup-4b70d608', 'beta'],
      ]);
    });

    it("prefers the caller's project over the originating task's", async () => {
      await emitTasksAdded({ ...planWith(task()), project: 'beta' }, ctx, { stateDir });

      await emitFollowUpTask(
        followUp({ fromTaskId: 'task-1' }),
        { ...ctx, project: 'alpha' },
        { stateDir },
      );

      expect((await typesFor('task-added'))[1]?.project).toBe('alpha');
    });

    it("ignores another epic's bare event for a qualified originating task", async () => {
      await emitTasksAdded(
        {
          ...planWith(task({ task_id: 'task-2', epic_id: 'epic-b' })),
          epic_id: 'epic-b',
          project: 'beta',
        },
        ctx,
        { stateDir },
      );

      await emitFollowUpTask(followUp({ fromTaskId: 'epic-a/task-2' }), ctx, { stateDir });

      expect((await typesFor('task-added'))[1]?.project).toBeUndefined();
    });

    it('stamps nothing when no source names a project', async () => {
      await emitTasksAdded(planWith(task()), ctx, { stateDir });

      await emitFollowUpTask(followUp({ fromTaskId: 'epic-1/task-1' }), ctx, { stateDir });

      expect((await typesFor('task-added'))[1]?.project).toBeUndefined();
    });
  });

  describe('readAddedTasks', () => {
    it('returns every task the log has added, with the claims it was added with', async () => {
      await emitTasksAdded(planWith(task()), ctx, { stateDir });
      await emitFollowUpTask(followUp(), ctx, { stateDir });

      const added = await readAddedTasks(ctx, { stateDir });
      expect(added.every((a) => typeof a.payload === 'object')).toBe(true);
      expect(added).toMatchObject([
        { taskId: 'epic-1/task-1', claims: ['src/foo/**'], epicId: 'epic-1' },
        {
          taskId: 'epic-1/followup-4b70d608',
          claims: ['src/parse.ts', 'test/parse.test.ts'],
          epicId: 'epic-1',
        },
      ]);
    });

    it('is empty for a session that has added nothing', async () => {
      expect(await readAddedTasks(ctx, { stateDir })).toEqual([]);
    });
  });

  // The acceptance shape of P9-29: a task's whole life is now written down,
  // so the projector's fold is a reading of what happened rather than a
  // reading of what someone remembered to type.
  describe('the fold sees a complete life cycle', () => {
    it('walks a task from todo to completed with no hand-appended events', async () => {
      const plan = planWith(task(), task({ task_id: 'epic-1/task-2' }));
      await emitTasksAdded(plan, ctx, { stateDir });
      await emitWaveAdmitted(plan, ['task-1', 'task-2'], ctx, { stateDir });
      await emitWaveMerged('epic-1/task-1', ctx, { stateDir });
      await emitTaskBlocked(
        'epic-1/task-2',
        { error: 'integration.merge-conflict-textual', severity: 'S2-major' },
        ctx,
        { stateDir },
      );

      const rows = foldTasks(await readEvents(sessionId, { stateDir }));
      const byId = new Map(rows.map((r) => [r.taskId, r]));
      expect(byId.get('epic-1/task-1')?.taskStatus).toBe('completed');
      expect(byId.get('epic-1/task-2')?.taskStatus).toBe('blocked');
      expect(rows).toHaveLength(2);
    });
  });
});
