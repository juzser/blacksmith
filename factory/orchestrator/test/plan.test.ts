import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bareTaskId,
  diffPlans,
  draftNextVersion,
  latestPlanVersion,
  livePlanTasks,
  loadPlan,
  nextVersion,
  PlanError,
  type PlanFile,
  resolveTaskId,
  type TaskSpecRecord,
  validatePlan,
} from '../src/plan.js';

// `TaskSpecRecord`, not `Record<string, unknown>`: every caller feeds the
// result to a validator, and many override a field with something deliberately
// invalid — which is what a validator suite is for. The cast is the one place
// that says so, instead of 46 call sites each restating it.
function task(overrides: Record<string, unknown> = {}): TaskSpecRecord {
  return {
    task_id: 'epic-1/task-1',
    epic_id: 'epic-1',
    plan_version: 1,
    objective: 'Do the thing.',
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: ['src/foo/**'],
    budget: { tokens: 1000, diff_lines: 100 },
    contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
    ...overrides,
  } as TaskSpecRecord;
}

describe('plan.ts', () => {
  let specsDir: string;

  beforeEach(async () => {
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-plans-'));
  });

  afterEach(async () => {
    await rm(specsDir, { recursive: true, force: true });
  });

  async function writePlanFixture(plan: PlanFile) {
    const dir = path.join(specsDir, plan.epic_id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `plan-v${plan.version}.json`), JSON.stringify(plan, null, 2));
  }

  it('loads a plan version from disk', async () => {
    const plan: PlanFile = {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [task()],
      edges: [],
    };
    await writePlanFixture(plan);

    const loaded = loadPlan('epic-1', 1, { specsDir });
    expect(loaded).toEqual(plan);
  });

  it('throws a typed error when the plan file does not exist', () => {
    expect(() => loadPlan('epic-1', 99, { specsDir })).toThrow(PlanError);
  });

  describe('validatePlan', () => {
    it('accepts a plan whose tasks are all schema/taxonomy valid and edges acyclic', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [
          {
            task: 'epic-1/task-2',
            dependsOn: 'epic-1/task-1',
            edge_type: 'artifact',
            edge_provenance: 'declared',
          },
        ],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(true);
    });

    it('rejects a budget field nothing can enforce, and says where the number belongs', () => {
      // D-29: max_turns, diff_lines and tokens all read as limits; none of the
      // three had a reader. Two now do. A plan that still writes down the third
      // is claiming a limit the factory cannot apply, and should fail here
      // rather than look enforced for the length of the epic.
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ budget: { tokens: 1000, diff_lines: 100, max_turns: 10 } })],
        edges: [],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual({
          path: '/tasks/epic-1/task-1/budget/max_turns',
          message: expect.stringContaining('no mechanical reader'),
        });
      }
    });

    it('accepts the two budget fields that do have readers', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ budget: { tokens: 1000, diff_lines: 100 } })],
        edges: [],
      };
      expect(validatePlan(plan).valid).toBe(true);
    });

    it('reports schema-invalid tasks without throwing', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ case: 'not-a-real-case' })],
        edges: [],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.length).toBeGreaterThan(0);
    });

    it('reports an edge referencing an unknown task', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' })],
        edges: [
          {
            task: 'epic-1/task-1',
            dependsOn: 'epic-1/ghost-task',
            edge_type: 'artifact',
            edge_provenance: 'declared',
          },
        ],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
    });

    // P9-20 / D-6: taxonomy.yml declares edge_type and edge_provenance as
    // required dimensions on an edge, and nothing checked membership at the
    // point of writing. A plan carrying "NOT-A-REAL-EDGE-TYPE" validated
    // clean, exit 0, reproduced twice.
    it('reports an edge whose edge_type is not in the taxonomy, naming the legal values', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [
          {
            task: 'epic-1/task-2',
            dependsOn: 'epic-1/task-1',
            edge_type: 'NOT-A-REAL-EDGE-TYPE',
            edge_provenance: 'declared',
          },
        ],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.path === '/edges/0')).toBe(true);
        const said = result.errors.map((e) => e.message).join('\n');
        expect(said).toMatch(/edge_type/);
        // The error has to carry the vocabulary, not just reject the value —
        // that is the whole point of the finding.
        expect(said).toMatch(/artifact/);
        expect(said).toMatch(/regression-test/);
      }
    });

    it('reports an edge whose edge_provenance is not in the taxonomy', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [
          {
            task: 'epic-1/task-2',
            dependsOn: 'epic-1/task-1',
            edge_type: 'artifact',
            edge_provenance: 'guessed',
          },
        ],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const said = result.errors.map((e) => e.message).join('\n');
        expect(said).toMatch(/edge_provenance/);
        expect(said).toMatch(/observed/);
      }
    });

    it('reports an edge missing a required dimension entirely', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [
          {
            task: 'epic-1/task-2',
            dependsOn: 'epic-1/task-1',
            edge_provenance: 'declared',
          } as unknown as PlanFile['edges'][number],
        ],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.map((e) => e.message).join('\n')).toMatch(/edge_type/);
      }
    });

    it('reports every bad edge, not just the first', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [
          task({ task_id: 'epic-1/task-1' }),
          task({ task_id: 'epic-1/task-2' }),
          task({ task_id: 'epic-1/task-3' }),
        ],
        edges: [
          {
            task: 'epic-1/task-2',
            dependsOn: 'epic-1/task-1',
            edge_type: 'nope',
            edge_provenance: 'declared',
          },
          {
            task: 'epic-1/task-3',
            dependsOn: 'epic-1/task-1',
            edge_type: 'artifact',
            edge_provenance: 'nope',
          },
        ],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.filter((e) => e.path.startsWith('/edges/'))).toHaveLength(2);
      }
    });

    // P9-20 / D-7: result.schema.json defers structured_output's shape to the
    // task spec's output_schema_ref, and nothing ever checked that the ref
    // named a schema that exists.
    it('reports an output_schema_ref that names a schema the factory does not have', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ output_schema_ref: 'factory/specs/schema/no-such-thing.schema.json' })],
        edges: [],
      };
      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const said = result.errors.map((e) => e.message).join('\n');
        expect(said).toMatch(/output_schema_ref/);
        expect(said).toMatch(/no-such-thing/);
        // Names what the factory does have, so the planner can fix it.
        expect(said).toMatch(/result/);
        expect(result.errors.some((e) => e.path.endsWith('/output_schema_ref'))).toBe(true);
      }
    });

    it('accepts an output_schema_ref written as a path, a bare name, or a $id URL', () => {
      for (const ref of [
        'factory/specs/schema/result.schema.json',
        'result.schema.json',
        'result',
        'https://black-smith.dev/schema/result.schema.json',
      ]) {
        const plan: PlanFile = {
          epic_id: 'epic-1',
          version: 1,
          status: 'active',
          tasks: [task({ output_schema_ref: ref })],
          edges: [],
        };
        const result = validatePlan(plan);
        expect(result.valid, `ref ${ref} should resolve`).toBe(true);
      }
    });

    it('throws a typed cyclic-dependency error (does not just accumulate it)', () => {
      const plan: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [
          {
            task: 'epic-1/task-1',
            dependsOn: 'epic-1/task-2',
            edge_type: 'artifact',
            edge_provenance: 'declared',
          },
          {
            task: 'epic-1/task-2',
            dependsOn: 'epic-1/task-1',
            edge_type: 'artifact',
            edge_provenance: 'declared',
          },
        ],
      };
      expect(() => validatePlan(plan)).toThrow(PlanError);
      try {
        validatePlan(plan);
      } catch (err) {
        expect((err as PlanError).code).toBe('plan.cyclic-dependency');
      }
    });
  });

  describe('nextVersion', () => {
    it('carries forward unfinished tasks and marks replaced ones superseded, writing v(n+1)', async () => {
      const v1: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [
          task({ task_id: 'epic-1/task-1', task_status: 'completed' }),
          task({ task_id: 'epic-1/task-2', task_status: 'in-progress' }),
          task({ task_id: 'epic-1/task-3', task_status: 'todo' }),
        ],
        edges: [],
      };

      await writePlanFixture(v1);

      const replacement = task({
        task_id: 'epic-1/task-3b',
        task_status: 'todo',
        origin: 'inferred',
      });

      const v2 = nextVersion(
        v1,
        {
          supersede: { 'epic-1/task-3': replacement },
          added: [task({ task_id: 'epic-1/task-4', origin: 'inferred' })],
        },
        { specsDir },
      );

      expect(v2.version).toBe(2);
      const byId = new Map(v2.tasks.map((t) => [t.task_id as string, t]));
      expect(byId.has('epic-1/task-1')).toBe(false); // completed, dropped
      expect((byId.get('epic-1/task-2') as Record<string, unknown>).plan_version).toBe(2);
      expect((byId.get('epic-1/task-3') as Record<string, unknown>).task_status).toBe('superseded');
      expect(byId.has('epic-1/task-3b')).toBe(true);
      expect(byId.has('epic-1/task-4')).toBe(true);

      // Actually persisted, and v1 untouched.
      const onDisk = JSON.parse(
        await readFile(path.join(specsDir, 'epic-1', 'plan-v2.json'), 'utf8'),
      );
      expect(onDisk.version).toBe(2);
      const v1OnDisk = JSON.parse(
        await readFile(path.join(specsDir, 'epic-1', 'plan-v1.json'), 'utf8'),
      );
      expect(v1OnDisk).toEqual(v1);
    });

    it('refuses to overwrite an existing plan version file (never mutates)', async () => {
      const v1: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [],
        edges: [],
      };
      await writePlanFixture(v1);
      const v2: PlanFile = {
        epic_id: 'epic-1',
        version: 2,
        status: 'active',
        tasks: [],
        edges: [],
      };
      await writePlanFixture(v2); // simulate v2 already existing on disk

      expect(() => nextVersion(v1, {}, { specsDir })).toThrow(PlanError);
      try {
        nextVersion(v1, {}, { specsDir });
      } catch (err) {
        expect((err as PlanError).code).toBe('plan.version-exists');
      }
    });
  });

  describe('diffPlans', () => {
    it('categorizes added, removed, superseded, and carried tasks', () => {
      const vA: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'superseded',
        tasks: [
          task({ task_id: 'epic-1/task-1', task_status: 'completed' }),
          task({ task_id: 'epic-1/task-2', task_status: 'in-progress' }),
          task({ task_id: 'epic-1/task-3', task_status: 'todo' }),
        ],
        edges: [],
      };
      const vB: PlanFile = {
        epic_id: 'epic-1',
        version: 2,
        status: 'active',
        tasks: [
          task({ task_id: 'epic-1/task-2', task_status: 'in-progress', plan_version: 2 }),
          task({ task_id: 'epic-1/task-3', task_status: 'superseded', plan_version: 2 }),
          task({ task_id: 'epic-1/task-3b', task_status: 'todo', plan_version: 2 }),
          task({ task_id: 'epic-1/task-4', task_status: 'todo', plan_version: 2 }),
        ],
        edges: [],
      };

      const diff = diffPlans(vA, vB);
      expect(diff.added.sort()).toEqual(['epic-1/task-3b', 'epic-1/task-4']);
      expect(diff.removed).toEqual(['epic-1/task-1']);
      expect(diff.superseded).toEqual(['epic-1/task-3']);
      expect(diff.carried).toEqual(['epic-1/task-2']);
    });

    // D-121, found by dogfooding the envkit-mcp-surface amendment. `supersede`
    // is keyed by task_id and the replacement normally KEEPS that id — every
    // amendment in this repo's history has used that shape, and the test above
    // uses the other one (task-3 replaced by a differently-named task-3b),
    // which is why nothing caught this. diffPlans indexed both plans with a
    // last-wins Map and nextVersion emits [...carried, ...replacements], so
    // the live replacement always hid the superseded copy: all three real
    // amendments (v1→v2, v2→v3, v3→v4) reported superseded: [] and listed
    // every task under `carried`. The permanent audit record in the
    // `plan-version-created` payload said the amendments moved nothing, and
    // the CLI printed "carries every task forward unchanged — check --changes"
    // at an operator whose --changes file was correct.
    it('reports a same-id supersede as superseded, not carried', async () => {
      const v1: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [],
      };
      await writePlanFixture(v1);

      const v2 = nextVersion(
        v1,
        {
          supersede: {
            'epic-1/task-1': task({
              task_id: 'epic-1/task-1',
              acceptance_criteria: ['it works, and the second key survives'],
            }),
          },
        },
        { specsDir },
      );

      // The shape the fix has to cope with: one id, two records.
      expect(v2.tasks.filter((t) => t.task_id === 'epic-1/task-1')).toHaveLength(2);

      const diff = diffPlans(v1, v2);
      expect(diff.superseded).toEqual(['epic-1/task-1']);
      expect(diff.carried).toEqual(['epic-1/task-2']);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    // The second amendment in a row. v2 already holds a dead copy of task-1
    // from the amendment above; v3 supersedes task-2 only. task-1's live spec
    // is untouched and must read as carried even though the plan now contains
    // two records for it — a count-the-superseded-copies fix would get this
    // one wrong.
    it('does not re-report a task superseded by an earlier version', async () => {
      const v1: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
        edges: [],
      };
      await writePlanFixture(v1);

      const v2 = nextVersion(
        v1,
        {
          supersede: {
            'epic-1/task-1': task({ task_id: 'epic-1/task-1', objective: 'Do the thing better.' }),
          },
        },
        { specsDir },
      );
      const v3 = nextVersion(
        v2,
        {
          supersede: {
            'epic-1/task-2': task({ task_id: 'epic-1/task-2', objective: 'Do the other thing.' }),
          },
        },
        { specsDir },
      );

      const diff = diffPlans(v2, v3);
      expect(diff.superseded).toEqual(['epic-1/task-2']);
      expect(diff.carried).toEqual(['epic-1/task-1']);
    });

    // Only the version stamp and the workflow status move on a pure carry.
    // Neither is spec content, so neither makes a task look amended.
    it('treats a plan_version bump and a task_status change as carried', () => {
      const vA: PlanFile = {
        epic_id: 'epic-1',
        version: 1,
        status: 'superseded',
        tasks: [task({ task_id: 'epic-1/task-1', task_status: 'todo' })],
        edges: [],
      };
      const vB: PlanFile = {
        epic_id: 'epic-1',
        version: 2,
        status: 'active',
        tasks: [task({ task_id: 'epic-1/task-1', task_status: 'in-progress', plan_version: 2 })],
        edges: [],
      };

      const diff = diffPlans(vA, vB);
      expect(diff.carried).toEqual(['epic-1/task-1']);
      expect(diff.superseded).toEqual([]);
    });
  });

  // D-46/P9-29: the dogfood's phantom task row came from one human typing
  // `envkit/task-1` where another typed `task-1`. Ids must be minted from
  // the plan, never retyped, so both spellings resolve to the one string
  // the plan itself holds.
  describe('resolveTaskId', () => {
    const plan: PlanFile = {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [task({ task_id: 'epic-1/task-1' }), task({ task_id: 'epic-1/task-2' })],
      edges: [],
    };

    it('returns the plan spelling unchanged when given it exactly', () => {
      expect(resolveTaskId(plan, 'epic-1/task-1')).toBe('epic-1/task-1');
    });

    it('resolves a bare id to the plan spelling', () => {
      expect(resolveTaskId(plan, 'task-2')).toBe('epic-1/task-2');
    });

    it('resolves an epic-qualified id against a plan that holds bare ones', () => {
      const bare: PlanFile = { ...plan, tasks: [task({ task_id: 'task-1' })] };
      expect(resolveTaskId(bare, 'epic-1/task-1')).toBe('task-1');
      expect(resolveTaskId(bare, 'task-1')).toBe('task-1');
    });

    it('throws naming the known ids when the plan does not contain the task', () => {
      let err: unknown;
      try {
        resolveTaskId(plan, 'task-9');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe('plan.unknown-task');
      expect((err as PlanError).message).toContain('epic-1/task-1');
    });

    it('refuses an id that two tasks could plausibly mean', () => {
      const ambiguous: PlanFile = {
        ...plan,
        tasks: [task({ task_id: 'task-1' }), task({ task_id: 'epic-1/task-1' })],
      };
      expect(() => resolveTaskId(ambiguous, 'task-1')).toThrow(/ambiguous/i);
    });

    // D-48/P9-31: the plan is not the only register of what exists. A
    // follow-up minted by `findings raise` is written to the log and to
    // nothing else, so a resolver that consults only the plan refuses the
    // very task the factory has just created — leaving it `todo` forever,
    // blocking the epic verdict, with `smith event append` as its only exit.
    it('accepts a task id the log added though the plan does not declare it', () => {
      expect(resolveTaskId(plan, 'epic-1/followup-4b70d608', ['epic-1/followup-4b70d608'])).toBe(
        'epic-1/followup-4b70d608',
      );
    });

    it('resolves a bare spelling of a logged id, exactly as it does a planned one', () => {
      expect(resolveTaskId(plan, 'followup-4b70d608', ['epic-1/followup-4b70d608'])).toBe(
        'epic-1/followup-4b70d608',
      );
    });

    it('still refuses an id neither source knows, and names both sources', () => {
      let err: unknown;
      try {
        resolveTaskId(plan, 'task-9', ['epic-1/followup-4b70d608']);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe('plan.unknown-task');
      expect((err as PlanError).message).toContain('epic-1/task-1');
      expect((err as PlanError).message).toContain('epic-1/followup-4b70d608');
    });
  });

  // D-126: the epic verdict took its roster from the event log alone, so a task
  // the plan added and nobody dispatched was not "not done" — it was absent.
  // These two readers are what let epic.ts ask the plan what it still claims.
  describe('latestPlanVersion / livePlanTasks (D-126)', () => {
    function planAt(version: number, tasks: Record<string, unknown>[]): PlanFile {
      return {
        epic_id: 'epic-1',
        version,
        status: 'active',
        tasks: tasks as PlanFile['tasks'],
        edges: [],
      };
    }

    it('reports the highest version written for the epic', async () => {
      await writePlanFixture(planAt(1, [task()]));
      await writePlanFixture(planAt(2, [task({ plan_version: 2 })]));
      await writePlanFixture(planAt(10, [task({ plan_version: 10 })]));

      expect(latestPlanVersion('epic-1', { specsDir })).toBe(10);
    });

    it('reports null for an epic with no plan directory at all', () => {
      expect(latestPlanVersion('epic-never-planned', { specsDir })).toBeNull();
    });

    it('ignores files in the epic directory that are not plan versions', async () => {
      await writePlanFixture(planAt(1, [task()]));
      await writeFile(path.join(specsDir, 'epic-1', 'notes.md'), '# not a plan\n');
      await writeFile(path.join(specsDir, 'epic-1', 'plan-vX.json'), '{}\n');

      expect(latestPlanVersion('epic-1', { specsDir })).toBe(1);
    });

    // A plan version holds each superseded record alongside its replacement,
    // and an amendment that keeps the id (D-121) leaves both under one key.
    it('keeps the live record of an id the amendment superseded and replaced', () => {
      const plan = planAt(2, [
        task({ task_id: 'epic-1/task-1', task_status: 'superseded', objective: 'old' }),
        task({ task_id: 'epic-1/task-1', task_status: 'todo', objective: 'new' }),
      ]);

      const live = livePlanTasks(plan);
      expect(live.map((t) => t.task_id)).toEqual(['epic-1/task-1']);
      expect(live[0]?.objective).toBe('new');
    });

    it('drops an id whose every record is superseded', () => {
      const plan = planAt(2, [
        task({ task_id: 'epic-1/task-1', task_status: 'superseded' }),
        task({ task_id: 'epic-1/task-2', task_status: 'todo' }),
      ]);

      expect(livePlanTasks(plan).map((t) => t.task_id)).toEqual(['epic-1/task-2']);
    });

    it('preserves plan order so the roster reads like the plan file', () => {
      const plan = planAt(1, [
        task({ task_id: 'epic-1/task-1' }),
        task({ task_id: 'epic-1/task-2' }),
        task({ task_id: 'epic-1/task-3' }),
      ]);

      expect(livePlanTasks(plan).map((t) => t.task_id)).toEqual([
        'epic-1/task-1',
        'epic-1/task-2',
        'epic-1/task-3',
      ]);
    });

    // One register for the both-spellings rule resolveTaskId already applies.
    it('strips the epic prefix from an id, and leaves a bare one alone', () => {
      expect(bareTaskId('epic-1', 'epic-1/task-1')).toBe('task-1');
      expect(bareTaskId('epic-1', 'task-1')).toBe('task-1');
      expect(bareTaskId('epic-1', 'epic-2/task-1')).toBe('epic-2/task-1');
    });
  });
});

describe('plan.ts effort tier (factory/policies/effort.yml)', () => {
  function plan(overrides: Partial<PlanFile> = {}): PlanFile {
    return {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [task()],
      edges: [],
      ...overrides,
    };
  }

  it('accepts a plan with no tier — the field is optional and means "policy default"', () => {
    expect(validatePlan(plan())).toEqual({ valid: true });
  });

  it.each(['small', 'medium', 'huge'])('accepts the "%s" tier', (tier) => {
    expect(validatePlan(plan({ effort: tier }))).toEqual({ valid: true });
  });

  it('rejects a tier that names no tier, instead of silently taking the default', () => {
    // A typo here is the worst kind of quiet: `smith effort show` would read
    // "hgue" as "no tier named" and hand back the policy default, so an epic
    // meant to run at full depth would run at the default one.
    const result = validatePlan(plan({ effort: 'hgue' }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('/effort');
    expect(result.errors[0]?.message).toMatch(/hgue/);
    expect(result.errors[0]?.message).toMatch(/small, medium, huge/);
  });

  it('carries the tier across an amendment — v2 is not a fresh choice', () => {
    const v1 = plan({ effort: 'huge' });
    const v2 = draftNextVersion(v1, { added: [task({ task_id: 'epic-1/task-2' })] });
    expect(v2.effort).toBe('huge');
  });

  it('leaves the tier off v2 when v1 never named one', () => {
    const v2 = draftNextVersion(plan(), { added: [task({ task_id: 'epic-1/task-2' })] });
    expect('effort' in v2).toBe(false);
  });
});

describe("draftNextVersion's edges vs the tasks the version still declares", () => {
  // A completed task leaves the live backlog (spec.ts calls that a `removed`
  // entry the operator did not ask for). Its edges did not: every edge was
  // carried forward verbatim, so v2 declared a dependency on a task v2 does
  // not contain -- and `validatePlan` rejects exactly that, by its own rule
  // that "dependency edges reference real tasks".
  //
  // The operator guide tells the operator to run `smith plan validate`, and
  // `smith plan amend` does not run it for them. So the first amendment after
  // any task with a declared dependency completes writes a version that fails
  // validation on an id the file no longer mentions -- and plans are
  // immutable, so there is nothing to edit and no way out.
  function edge(task: string, dependsOn: string) {
    return { task, dependsOn, edge_type: 'artifact', edge_provenance: 'declared' };
  }

  function planWith(tasks: TaskSpecRecord[], edges: PlanFile['edges']): PlanFile {
    return { epic_id: 'epic-1', version: 1, status: 'active', tasks, edges };
  }

  it('drops an edge onto a completed task the new version no longer declares', () => {
    const v1 = planWith(
      [
        task({ task_id: 'epic-1/task-1', task_status: 'completed' }),
        task({ task_id: 'epic-1/task-2' }),
      ],
      [edge('epic-1/task-2', 'epic-1/task-1')],
    );
    expect(validatePlan(v1)).toEqual({ valid: true });

    const v2 = draftNextVersion(v1, { added: [task({ task_id: 'epic-1/task-3' })] });

    expect(v2.tasks.map((t) => t.task_id)).toEqual(['epic-1/task-2', 'epic-1/task-3']);
    expect(v2.edges).toEqual([]);
    // The point of the whole test: the version a cut produces is one its own
    // validator accepts.
    expect(validatePlan(v2)).toEqual({ valid: true });
  });

  it('keeps an edge onto a superseded task, which the version still declares', () => {
    // Superseding a completed task carries it forward as `superseded` rather
    // than dropping it, so the edge still names a task in the file and the
    // history stays readable. Only the ids that actually left may take their
    // edges with them.
    const v1 = planWith(
      [
        task({ task_id: 'epic-1/task-1', task_status: 'completed' }),
        task({ task_id: 'epic-1/task-2' }),
      ],
      [edge('epic-1/task-2', 'epic-1/task-1')],
    );

    const v2 = draftNextVersion(v1, {
      supersede: { 'epic-1/task-1': task({ task_id: 'epic-1/task-1b' }) },
    });

    expect(v2.edges).toEqual([edge('epic-1/task-2', 'epic-1/task-1')]);
    expect(validatePlan(v2)).toEqual({ valid: true });
  });

  it('reports a new edge naming an unknown task rather than quietly dropping it', () => {
    // The filter is a consequence of the carry rule, so it applies to carried
    // edges only. An edge this amendment adds is something the author wrote;
    // silently deleting it would answer a typo with a plan that no longer says
    // what they asked for.
    const v1 = planWith([task({ task_id: 'epic-1/task-1' })], []);

    const v2 = draftNextVersion(v1, { newEdges: [edge('epic-1/task-1', 'epic-1/task-9')] });

    expect(v2.edges).toHaveLength(1);
    const result = validatePlan(v2);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.errors[0]?.message).toMatch(/epic-1\/task-9/);
  });
});

// D-21: an operator passed `changes.supersede` as an array of task-id strings
// instead of the map `{ task_id: replacement }` this function has always
// expected. `task_id in supersede` was false for every task (arrays have
// numeric keys, not the task_id strings under test), and
// `Object.values(["some-task-id"])` handed back the array's own element -- a
// bare string -- which `{ ...aString }` then spread character-by-character
// into a "task record" with no `task_id` at all. That record reached
// `amendPlan`, which wrote it to an immutable plan file and reported success;
// `smith plan validate` rejected the file the tool had just produced.
describe('draftNextVersion rejects a malformed supersede (D-21)', () => {
  function planWithOneTask(): PlanFile {
    return {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [task({ task_id: 'epic-1/task-1' })],
      edges: [],
    };
  }

  it('throws a named error instead of spreading an array supersede character-by-character (the real-world case)', () => {
    const v1 = planWithOneTask();
    let err: unknown;
    try {
      draftNextVersion(v1, {
        supersede: ['epic-1/task-1'] as unknown as Record<string, TaskSpecRecord>,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanError);
    // The type is named ("a list"), never the value spread across it.
    expect((err as PlanError).message).toMatch(/supersede/);
    expect((err as PlanError).message).toMatch(/a list/);
    // The message has to make the map-vs-array mistake legible, not just
    // reject the value.
    expect((err as PlanError).message).toMatch(/map/i);
  });
});

describe('draftNextVersion rejects a malformed supersede entry / added entry (D-21)', () => {
  function planWithOneTask(): PlanFile {
    return {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [task({ task_id: 'epic-1/task-1' })],
      edges: [],
    };
  }

  it('throws naming the offending key when a supersede value has no string task_id', () => {
    const v1 = planWithOneTask();
    let err: unknown;
    try {
      draftNextVersion(v1, {
        supersede: {
          'epic-1/task-1': { objective: 'no task_id here' } as unknown as TaskSpecRecord,
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).message).toContain('epic-1/task-1');
    expect((err as PlanError).message).toMatch(/task_id/);
  });

  it('throws naming the index when an added entry has no string task_id', () => {
    const v1 = planWithOneTask();
    let err: unknown;
    try {
      draftNextVersion(v1, { added: [{ objective: 'no task_id' } as unknown as TaskSpecRecord] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).message).toMatch(/added/);
    expect((err as PlanError).message).toMatch(/task_id/);
  });
});

describe('draftNextVersion still works for the correct supersede map shape (D-21 regression guard)', () => {
  it('supersedes one task: dead record carried as superseded, replacement added, both at the new version', () => {
    const v1: PlanFile = {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [task({ task_id: 'epic-1/task-1' })],
      edges: [],
    };
    const replacement = task({ task_id: 'epic-1/task-1', objective: 'Do the thing better.' });

    const v2 = draftNextVersion(v1, { supersede: { 'epic-1/task-1': replacement } });

    expect(v2.version).toBe(2);
    const copies = v2.tasks.filter((t) => t.task_id === 'epic-1/task-1');
    expect(copies).toHaveLength(2);
    expect(copies.find((t) => t.task_status === 'superseded')?.plan_version).toBe(2);
    expect(copies.find((t) => t.task_status !== 'superseded')?.objective).toBe(
      'Do the thing better.',
    );
    expect(copies.every((t) => t.plan_version === 2)).toBe(true);
  });
});
