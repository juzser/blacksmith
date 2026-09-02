import { describe, expect, it } from 'vitest';
import type { WorktreePolicy } from '../src/claims.js';
import type { PlanDependencyEdge, PlanFile } from '../src/plan.js';
import { scheduleWaves } from '../src/waveSchedule.js';

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

describe('scheduleWaves — how wide this plan can ever run', () => {
  it('runs a plan of independent tasks in one round', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/a/**'] },
        { id: 't2', claims: ['src/b/**'] },
        { id: 't3', claims: ['src/c/**'] },
      ]),
      policy: POLICY,
    });
    expect(schedule.rounds.map((r) => r.tasks)).toEqual([['t1', 't2', 't3']]);
    expect(schedule.depth).toBe(1);
    expect(schedule.widest).toBe(3);
    expect(schedule.scheduled).toBe(3);
    expect(schedule.stalled).toEqual([]);
    expect(schedule.constraints).toEqual([]);
    expect(schedule.exitCode).toBe(0);
  });

  it('drives the plan to exhaustion, one round unlocking the next', () => {
    const schedule = scheduleWaves({
      plan: planOf(
        [
          { id: 't1', claims: ['src/a/**'] },
          { id: 't2', claims: ['src/b/**'] },
          { id: 't3', claims: ['src/c/**'] },
        ],
        [edge('t2', 't1'), edge('t3', 't2')],
      ),
      policy: POLICY,
    });
    expect(schedule.rounds.map((r) => r.tasks)).toEqual([['t1'], ['t2'], ['t3']]);
    expect(schedule.depth).toBe(3);
    expect(schedule.widest).toBe(1);
  });

  // The distinction the whole command exists to draw. A chain of dependencies
  // is the shape of the work; a chain of claim overlaps is the shape of the
  // planner's slicing, and only one of them is anybody's to fix.
  it('passes a plan serialized purely by its own declared dependencies', () => {
    const schedule = scheduleWaves({
      plan: planOf(
        [
          { id: 't1', claims: ['src/a/**'] },
          { id: 't2', claims: ['src/b/**'] },
        ],
        [edge('t2', 't1')],
      ),
      policy: POLICY,
    });
    expect(schedule.widest).toBe(1);
    expect(schedule.constraints).toEqual([]);
    expect(schedule.exitCode).toBe(0);
  });

  it('fails a plan serialized by claim overlap, and names the pair', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/api/**'] },
        { id: 't2', claims: ['src/api/deep/**'] },
      ]),
      policy: POLICY,
    });
    expect(schedule.rounds.map((r) => r.tasks)).toEqual([['t1'], ['t2']]);
    expect(schedule.constraints).toHaveLength(1);
    expect(schedule.constraints[0]?.reason).toBe('claim-overlap');
    expect(schedule.constraints[0]?.tasks).toEqual(['t2']);
    expect(schedule.constraints[0]?.blockedBy).toEqual(['t1']);
    expect(schedule.constraints[0]?.detail).toContain('src/api');
    expect(schedule.exitCode).toBe(2);
  });

  it('reports a serialize-always hotspot as its own constraint', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/a/**', 'app/pnpm-lock.yaml'] },
        { id: 't2', claims: ['src/b/**', 'lib/pnpm-lock.yaml'] },
      ]),
      policy: POLICY,
    });
    expect(schedule.constraints.map((c) => c.reason)).toEqual(['serialize-hotspot']);
    expect(schedule.exitCode).toBe(2);
  });

  it('reports an import crossing as its own constraint', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/a/**'] },
        { id: 't2', claims: ['src/b/**'] },
      ]),
      policy: POLICY,
      crossings: [{ producer: 't1', consumer: 't2' }],
    });
    expect(schedule.rounds.map((r) => r.tasks)).toEqual([['t1'], ['t2']]);
    expect(schedule.constraints.map((c) => c.reason)).toEqual(['symbol-coupled']);
    expect(schedule.exitCode).toBe(2);
  });

  // A round that loses width is worth naming even when the plan still ends in
  // the same number of rounds — the claim geometry is the fixable part, and
  // whether fixing it shortens the schedule is the dependency graph's to say.
  it('names an avoidable deferral per round, not just per plan', () => {
    const schedule = scheduleWaves({
      plan: planOf(
        [
          { id: 't1', claims: ['src/api/**'] },
          { id: 't2', claims: ['src/api/deep/**'] },
          { id: 't3', claims: ['src/c/**'] },
        ],
        [edge('t3', 't1')],
      ),
      policy: POLICY,
    });
    expect(schedule.rounds[0]?.tasks).toEqual(['t1']);
    expect(schedule.rounds[0]?.avoidable.map((d) => d.taskId)).toEqual(['t2']);
    // t3 waited on t1 in round 1, which is the work's shape and not a finding.
    expect(schedule.rounds[0]?.avoidable).toHaveLength(1);
  });

  it('groups one reason across rounds, listing every task it ever held', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/api/**'] },
        { id: 't2', claims: ['src/api/a/**'] },
        { id: 't3', claims: ['src/api/a/deep/**'] },
      ]),
      policy: POLICY,
    });
    expect(schedule.depth).toBe(3);
    expect(schedule.constraints).toHaveLength(1);
    expect(schedule.constraints[0]?.tasks).toEqual(['t2', 't3']);
    expect(schedule.constraints[0]?.blockedBy).toEqual(['t1', 't2']);
  });

  it('stalls rather than looping when a dependency names a task the plan lost', () => {
    const schedule = scheduleWaves({
      plan: planOf([{ id: 't1', claims: ['src/a/**'] }], [edge('t1', 'ghost')]),
      policy: POLICY,
    });
    expect(schedule.rounds).toEqual([]);
    expect(schedule.stalled).toEqual(['t1']);
    expect(schedule.scheduled).toBe(0);
    expect(schedule.exitCode).toBe(1);
    expect(schedule.hint).toMatch(/stall/i);
  });

  // A stall outranks a lost round: a plan that cannot finish is not a plan
  // whose claims want re-slicing.
  it('reports the stall, not the constraint, when a plan has both', () => {
    const schedule = scheduleWaves({
      plan: planOf(
        [
          { id: 't1', claims: ['src/api/**'] },
          { id: 't2', claims: ['src/api/deep/**'] },
          { id: 't3', claims: ['src/c/**'] },
        ],
        [edge('t3', 'ghost')],
      ),
      policy: POLICY,
    });
    expect(schedule.stalled).toEqual(['t3']);
    expect(schedule.constraints.map((c) => c.reason)).toEqual(['claim-overlap']);
    expect(schedule.exitCode).toBe(1);
  });

  it('says nothing when there is nothing to say', () => {
    const schedule = scheduleWaves({
      plan: planOf([{ id: 't1', claims: ['src/a/**'] }]),
      policy: POLICY,
    });
    expect(schedule.hint).toBe('');
    expect(schedule.exitCode).toBe(0);
  });

  it('schedules nothing for a plan whose tasks are all finished', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/a/**'], status: 'completed' },
        { id: 't2', claims: ['src/b/**'], status: 'waived' },
      ]),
      policy: POLICY,
    });
    expect(schedule.rounds).toEqual([]);
    expect(schedule.depth).toBe(0);
    expect(schedule.widest).toBe(0);
    expect(schedule.stalled).toEqual([]);
    expect(schedule.exitCode).toBe(0);
  });

  // The simulation can complete a task; it cannot un-block one. An escalated
  // task is waiting on a person, and saying so is more use than calling the
  // plan stalled on it.
  it('separates a task waiting on a person from a task the plan cannot start', () => {
    const schedule = scheduleWaves({
      plan: planOf([
        { id: 't1', claims: ['src/api/**'], status: 'escalated' },
        { id: 't2', claims: ['src/api/deep/**'] },
        { id: 't3', claims: ['src/c/**'] },
      ]),
      policy: POLICY,
    });
    expect(schedule.occupied).toEqual(['t1']);
    expect(schedule.rounds.map((r) => r.tasks)).toEqual([['t3']]);
    expect(schedule.stalled).toEqual(['t2']);
    expect(schedule.exitCode).toBe(1);
    // And the report names who is holding it, so the operator reads one line.
    expect(schedule.hint).toContain('t2');
  });

  it('takes the live status register over the plan file, as the dispatcher does', () => {
    const schedule = scheduleWaves({
      plan: planOf(
        [
          { id: 't1', claims: ['src/a/**'] },
          { id: 't2', claims: ['src/b/**'] },
        ],
        [edge('t2', 't1')],
      ),
      policy: POLICY,
      statusById: new Map([['t1', 'completed']]),
    });
    expect(schedule.rounds.map((r) => r.tasks)).toEqual([['t2']]);
    expect(schedule.depth).toBe(1);
  });

  it('carries the epic id through, so a report can name what it read', () => {
    const schedule = scheduleWaves({
      plan: planOf([{ id: 't1', claims: ['src/a/**'] }]),
      policy: POLICY,
    });
    expect(schedule.epicId).toBe('e1');
  });
});
