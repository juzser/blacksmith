// Criterion 7 (bs-audit-2/task-7): a plan that serialises by claim geometry
// used to be invisible until `/bs run` actually hit the ceiling. This file
// covers `computePlanParallelism` directly (claims + edges, no repo scan),
// the two CLI surfaces it feeds (`plan ingest`'s `parallelism` key and `wave
// schedule`'s `size` block), and the `.claude/skills/bs/plan.md` prose that
// tells an operator to read it.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorktreePolicy } from '../src/claims.js';
import { REPO_ROOT } from '../src/paths.js';
import type { PlanDependencyEdge, PlanFile } from '../src/plan.js';
import { assertExited, runProcess } from './helpers/process.js';

const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');

function runCli(args: string[]): { stdout: string; status: number } {
  const run = runProcess('node', [CLI_PATH, ...args]);
  assertExited(run, `smith ${args.join(' ')}`);
  return { stdout: run.stdout, status: run.status as number };
}

const POLICY: WorktreePolicy = { serializeAlwaysGlobs: ['**/pnpm-lock.yaml'] };

interface TaskSeed {
  id: string;
  claims: string[];
}

function planOf(seeds: readonly TaskSeed[], edges: PlanDependencyEdge[] = []): PlanFile {
  return {
    epic_id: 'e1',
    version: 1,
    status: 'active',
    tasks: seeds.map((s) => ({
      task_id: s.id,
      task_status: 'todo',
      plan_version: 1,
      claims: s.claims,
    })),
    edges,
  };
}

function edge(task: string, dependsOn: string): PlanDependencyEdge {
  return { task, dependsOn, edge_type: 'artifact', edge_provenance: 'declared' };
}

describe('computePlanParallelism — how wide this plan can ever run, per task', () => {
  it('reports widest and parallel_with for a disjoint pair plus a dependent third', async () => {
    const { computePlanParallelism } = await import('../src/waveSchedule.js');
    const plan = planOf(
      [
        { id: 'A', claims: ['src/a/**'] },
        { id: 'B', claims: ['src/b/**'] },
        { id: 'C', claims: ['src/c/**'] },
      ],
      [edge('C', 'A')],
    );
    const result = computePlanParallelism(plan, POLICY);
    expect(result.widest).toBe(2);
    expect(result.parallel_with.A).toEqual(['B']);
    expect(result.parallel_with.B).toEqual(['A', 'C']);
    expect(result.parallel_with.C).toEqual(['B']);
  });

  it('reports widest 1 and no parallel_with for two tasks sharing one claim path', async () => {
    const { computePlanParallelism } = await import('../src/waveSchedule.js');
    const plan = planOf([
      { id: 'A', claims: ['src/shared/**'] },
      { id: 'B', claims: ['src/shared/**'] },
    ]);
    const result = computePlanParallelism(plan, POLICY);
    expect(result.widest).toBe(1);
    expect(result.parallel_with.A).toEqual([]);
    expect(result.parallel_with.B).toEqual([]);
  });

  it('rules out a transitively-dependent pair with no direct edge between them', async () => {
    const { computePlanParallelism } = await import('../src/waveSchedule.js');
    const plan = planOf(
      [
        { id: 'A', claims: ['src/a/**'] },
        { id: 'B', claims: ['src/b/**'] },
        { id: 'C', claims: ['src/c/**'] },
      ],
      [edge('B', 'A'), edge('C', 'B')],
    );
    const result = computePlanParallelism(plan, POLICY);
    // C depends on B depends on A: A and C share no direct edge, but the
    // chain still connects them, so neither may name the other.
    expect(result.parallel_with.A).not.toContain('C');
    expect(result.parallel_with.C).not.toContain('A');
  });

  it('reads size.small true at 3 tasks / 10 claims, false at 4 tasks / 11 claims', async () => {
    const { computePlanParallelism } = await import('../src/waveSchedule.js');
    const threeTasksTenClaims = computePlanParallelism(
      planOf([
        { id: 'A', claims: Array.from({ length: 4 }, (_, i) => `src/a/${i}/**`) },
        { id: 'B', claims: Array.from({ length: 3 }, (_, i) => `src/b/${i}/**`) },
        { id: 'C', claims: Array.from({ length: 3 }, (_, i) => `src/c/${i}/**`) },
      ]),
      POLICY,
    );
    expect(threeTasksTenClaims.size).toEqual({ tasks: 3, claims: 10, small: true });

    const fourTasks = computePlanParallelism(
      planOf([
        { id: 'A', claims: ['src/a/**'] },
        { id: 'B', claims: ['src/b/**'] },
        { id: 'C', claims: ['src/c/**'] },
        { id: 'D', claims: ['src/d/**'] },
      ]),
      POLICY,
    );
    expect(fourTasks.size.small).toBe(false);

    const elevenClaims = computePlanParallelism(
      planOf([
        { id: 'A', claims: Array.from({ length: 4 }, (_, i) => `src/a/${i}/**`) },
        { id: 'B', claims: Array.from({ length: 4 }, (_, i) => `src/b/${i}/**`) },
        { id: 'C', claims: Array.from({ length: 3 }, (_, i) => `src/c/${i}/**`) },
      ]),
      POLICY,
    );
    expect(elevenClaims.size).toEqual({ tasks: 3, claims: 11, small: false });
  });
});

describe('plan ingest / wave schedule — the same widest, printed two ways', () => {
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-parallelism-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  const PLAN = {
    epic_id: 'epic-par',
    version: 1,
    status: 'active',
    tasks: [
      {
        task_id: 'epic-par/task-1',
        epic_id: 'epic-par',
        plan_version: 1,
        objective: 'Do the thing.',
        output_schema_ref: 'result.schema.json',
        acceptance_criteria: ['it works'],
        claims: ['src/foo/*.ts'],
        budget: { tokens: 1000, diff_lines: 100 },
        contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      },
      {
        task_id: 'epic-par/task-2',
        epic_id: 'epic-par',
        plan_version: 1,
        objective: 'Do the other thing.',
        output_schema_ref: 'result.schema.json',
        acceptance_criteria: ['it works'],
        claims: ['src/bar/*.ts'],
        budget: { tokens: 1000, diff_lines: 100 },
        contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
      },
    ],
    edges: [],
  };

  it('ingest prints parallelism.widest equal to wave schedule widest, and the same size block', async () => {
    const sessionId = `parallelism-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const eventsDir = path.join(scratchDir, `${sessionId}-events`);
    const planPath = path.join(scratchDir, `${sessionId}-plan.json`);
    await writeFile(planPath, JSON.stringify(PLAN));

    const root = runCli([
      'event',
      'append',
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      }),
      '--state-dir',
      eventsDir,
    ]);
    expect(root.status).toBe(0);

    const ingest = runCli([
      'plan',
      'ingest',
      planPath,
      '--session',
      sessionId,
      '--causal-parent',
      `${sessionId}#0`,
      '--state-dir',
      eventsDir,
    ]);
    expect(ingest.status).toBe(0);
    const ingested = JSON.parse(ingest.stdout);
    expect(ingested.parallelism.widest).toBe(2);
    expect(ingested.parallelism.size).toEqual({ tasks: 2, claims: 2, small: true });

    // Neither task's claim names a file in this repo, so scanning it (the
    // fixture's own scratch dir stands in for `--repo`) finds no crossings
    // and the two commands' widths cannot drift apart from that.
    const schedule = runCli(['wave', 'schedule', planPath, '--repo', scratchDir]);
    expect(schedule.status).toBe(0);
    const scheduled = JSON.parse(schedule.stdout);
    expect(scheduled.widest).toBe(ingested.parallelism.widest);
    expect(scheduled.size).toEqual(ingested.parallelism.size);
  });
});

describe('.claude/skills/bs/plan.md — parallelism guidance', () => {
  const planMd = readFileSync(path.join(REPO_ROOT, '.claude/skills/bs/plan.md'), 'utf8');
  const lines = planMd.split('\n');

  it('names the small-epic path off size.small', () => {
    expect(planMd).toMatch(/size\.small/);
    expect(planMd).toMatch(/effort tier `small`/);
  });

  it('step 7 tells the operator to read parallelism.widest back', () => {
    const step7 = lines.findIndex((l) => l.startsWith('7. Log the sign-off'));
    expect(step7).toBeGreaterThan(-1);
    const step8 = lines.findIndex((l) => l.startsWith('8. If this epic'));
    expect(step8).toBeGreaterThan(step7);
    const body = lines.slice(step7, step8).join('\n');
    expect(body).toMatch(/parallelism\.widest/);
    expect(body).toMatch(/plan of two or more tasks/);
  });

  it('says import-graph crossings stay wave schedule --repo\'s job, once', () => {
    const matches = planMd.match(/wave schedule --repo/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('step 3\'s review-focus list has at most six items, counted by position', () => {
    // "By position" rather than by text search: find item 3's line, then walk
    // forward counting a contiguous run of nested `N. ` list lines (indented,
    // so they read as item 3's own sub-list) until the first blank line that
    // is not immediately followed by another list line.
    const step3 = lines.findIndex((l) => l.startsWith('3. Dispatch a'));
    expect(step3).toBeGreaterThan(-1);
    const step4 = lines.findIndex((l) => l.startsWith('4. Planner fixes'));
    expect(step4).toBeGreaterThan(step3);
    const between = lines.slice(step3, step4);
    const focusItems = between.filter((l) => /^ {3}\d+\. /.test(l));
    expect(focusItems.length).toBeGreaterThan(0);
    expect(focusItems.length).toBeLessThanOrEqual(6);
  });
});
