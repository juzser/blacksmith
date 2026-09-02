import { describe, expect, it } from 'vitest';
import { ClaimsError, validateWave, type WorktreePolicy } from '../src/claims.js';
import type { PlanDependencyEdge, PlanFile } from '../src/plan.js';
import { computeNextWave, liveWaveTasks } from '../src/waveNext.js';

const POLICY: WorktreePolicy = { serializeAlwaysGlobs: ['**/pnpm-lock.yaml'] };

interface TaskSeed {
  id: string;
  claims?: unknown;
  status?: string;
}

function planOf(seeds: readonly TaskSeed[], edges: PlanDependencyEdge[] = []): PlanFile {
  return {
    epic_id: 'e1',
    version: 1,
    status: 'active',
    tasks: seeds.map((s) => ({
      task_id: s.id,
      task_status: s.status ?? 'todo',
      plan_version: 1,
      claims: s.claims ?? [],
    })),
    edges,
  };
}

function edge(task: string, dependsOn: string): PlanDependencyEdge {
  return { task, dependsOn, edge_type: 'artifact', edge_provenance: 'declared' };
}

describe('computeNextWave — the widest wave the graph allows', () => {
  it('admits every independent task at once, which is the whole point', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'] },
      { id: 't2', claims: ['src/b/**'] },
      { id: 't3', claims: ['src/c/**'] },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t1', 't2', 't3']);
    expect(result.deferred).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  it('proposes a wave that `wave check` would admit — never one it would refuse', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'] },
      { id: 't2', claims: ['src/a/deep/**'] },
      { id: 't3', claims: ['src/b/**'] },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    const proposed = result.wave.map((id) => ({
      task_id: id,
      claims: (plan.tasks.find((t) => t.task_id === id) as { claims: unknown }).claims,
    }));
    expect(validateWave(proposed, POLICY, plan.edges)).toEqual({ valid: true });
  });

  it('defers a task whose dependency has not landed, and names the dependency', () => {
    const plan = planOf(
      [
        { id: 't1', claims: ['src/a/**'] },
        { id: 't2', claims: ['src/b/**'] },
      ],
      [edge('t2', 't1')],
    );
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t1']);
    expect(result.deferred).toEqual([
      {
        taskId: 't2',
        reason: 'dependency-pending',
        blockedBy: ['t1'],
        detail: 'Depends on t1, which is not terminal.',
      },
    ]);
    expect(result.remaining).toBe(1);
  });

  it('admits a task whose dependency has already landed', () => {
    const plan = planOf(
      [
        { id: 't1', claims: ['src/a/**'], status: 'completed' },
        { id: 't2', claims: ['src/b/**'] },
      ],
      [edge('t2', 't1')],
    );
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t2']);
    expect(result.done).toEqual(['t1']);
  });

  it('counts a waived dependency as landed — a decision is terminal too', () => {
    const plan = planOf(
      [
        { id: 't1', claims: ['src/a/**'], status: 'waived' },
        { id: 't2', claims: ['src/b/**'] },
      ],
      [edge('t2', 't1')],
    );
    expect(computeNextWave({ plan, policy: POLICY }).wave).toEqual(['t2']);
  });

  it('defers the second of two tasks whose claims overlap, naming the first', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'] },
      { id: 't2', claims: ['src/a/inner.ts'] },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t1']);
    expect(result.deferred[0]).toMatchObject({
      taskId: 't2',
      reason: 'claim-overlap',
      blockedBy: ['t1'],
    });
  });

  it('defers on a shared serialize-always hotspot even when the claims are disjoint', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**', 'app/pnpm-lock.yaml'] },
      { id: 't2', claims: ['src/b/**', 'lib/pnpm-lock.yaml'] },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t1']);
    expect(result.deferred[0]).toMatchObject({
      taskId: 't2',
      reason: 'serialize-hotspot',
      blockedBy: ['t1'],
    });
  });

  it('treats an in-flight task as holding its claims — a new wave never overlaps live work', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'], status: 'in-progress' },
      { id: 't2', claims: ['src/a/inner.ts'] },
      { id: 't3', claims: ['src/b/**'] },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t3']);
    expect(result.occupied).toEqual(['t1']);
    expect(result.deferred[0]).toMatchObject({
      taskId: 't2',
      reason: 'claim-overlap',
      blockedBy: ['t1'],
    });
  });

  it('runs the producer first when an import edge couples two otherwise-disjoint tasks', () => {
    // t2 sorts first lexicographically but consumes what t9 exports: the
    // playbook's remedy is "run the producer first", so t9 is the admission.
    const plan = planOf([
      { id: 't2', claims: ['src/consumer/**'] },
      { id: 't9', claims: ['src/producer/**'] },
    ]);
    const result = computeNextWave({
      plan,
      policy: POLICY,
      crossings: [{ producer: 't9', consumer: 't2' }],
    });
    expect(result.wave).toEqual(['t9']);
    expect(result.deferred[0]).toMatchObject({
      taskId: 't2',
      reason: 'symbol-coupled',
      blockedBy: ['t9'],
    });
  });

  it('falls back to lexicographic order when the crossings are themselves cyclic', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'] },
      { id: 't2', claims: ['src/b/**'] },
    ]);
    const result = computeNextWave({
      plan,
      policy: POLICY,
      crossings: [
        { producer: 't1', consumer: 't2' },
        { producer: 't2', consumer: 't1' },
      ],
    });
    expect(result.wave).toEqual(['t1']);
    expect(result.deferred[0]).toMatchObject({ taskId: 't2', reason: 'symbol-coupled' });
  });

  it('prefers the live status map over the plan file record', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'] },
      { id: 't2', claims: ['src/b/**'] },
    ]);
    const result = computeNextWave({
      plan,
      policy: POLICY,
      statusById: new Map([['t1', 'completed']]),
    });
    expect(result.wave).toEqual(['t2']);
    expect(result.done).toEqual(['t1']);
  });

  it('never re-proposes a superseded record', () => {
    const plan: PlanFile = {
      epic_id: 'e1',
      version: 2,
      status: 'active',
      tasks: [
        { task_id: 't1', task_status: 'superseded', plan_version: 1, claims: ['src/old/**'] },
        { task_id: 't1', task_status: 'todo', plan_version: 2, claims: ['src/new/**'] },
      ],
      edges: [],
    };
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t1']);
  });

  it('is deterministic: the same plan yields the same wave every time', () => {
    const plan = planOf([
      { id: 'b', claims: ['src/b/**'] },
      { id: 'a', claims: ['src/a/**'] },
      { id: 'c', claims: ['src/a/inner.ts'] },
    ]);
    const first = computeNextWave({ plan, policy: POLICY });
    const second = computeNextWave({ plan, policy: POLICY });
    expect(first).toEqual(second);
    expect(first.wave).toEqual(['a', 'b']);
  });

  it('refuses a claim set no comparison can read, rather than admitting it as disjoint', () => {
    const plan = planOf([
      { id: 't1', claims: 'src/a/**' },
      { id: 't2', claims: ['src/b/**'] },
    ]);
    expect(() => computeNextWave({ plan, policy: POLICY })).toThrow(ClaimsError);
    expect(() => computeNextWave({ plan, policy: POLICY })).toThrow(/not a list of globs/);
  });

  it('reports an empty wave rather than inventing one when every task is done', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'], status: 'completed' },
      { id: 't2', claims: ['src/b/**'], status: 'waived' },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual([]);
    expect(result.remaining).toBe(0);
    expect(result.done).toEqual(['t1', 't2']);
  });

  it('names a blocked task as needing the operator, never as a wave candidate', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'], status: 'blocked' },
      { id: 't2', claims: ['src/b/**'] },
    ]);
    const result = computeNextWave({ plan, policy: POLICY });
    expect(result.wave).toEqual(['t2']);
    expect(result.occupied).toEqual(['t1']);
  });
});

describe('liveWaveTasks — one door for the claim sets a caller needs before the wave', () => {
  it('returns every live task with its claims read, terminal ones included', () => {
    // The symbol graph is built over the whole live plan, not just the
    // candidates: a crossing with an in-flight task is exactly the crossing
    // that must defer a candidate, and the caller cannot know which tasks
    // those are before computeNextWave has partitioned them.
    const plan = planOf([
      { id: 't1', claims: ['src/a/**'], status: 'completed' },
      { id: 't2', claims: ['src/b/**'], status: 'in-progress' },
      { id: 't3', claims: ['src/c/**'] },
    ]);
    expect(liveWaveTasks(plan)).toEqual([
      { task_id: 't1', claims: ['src/a/**'] },
      { task_id: 't2', claims: ['src/b/**'] },
      { task_id: 't3', claims: ['src/c/**'] },
    ]);
  });

  it('drops a superseded record rather than reporting a task twice', () => {
    const plan = planOf([
      { id: 't1', claims: ['src/old/**'], status: 'superseded' },
      { id: 't1', claims: ['src/new/**'] },
    ]);
    expect(liveWaveTasks(plan)).toEqual([{ task_id: 't1', claims: ['src/new/**'] }]);
  });

  it('refuses a claim set no comparison can read, at the same door as the wave', () => {
    const plan = planOf([{ id: 't1', claims: 'src/a/**' }]);
    expect(() => liveWaveTasks(plan)).toThrow(ClaimsError);
  });
});
