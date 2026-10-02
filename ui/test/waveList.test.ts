import { describe, expect, it } from 'vitest';
import type { FlowEdge, FlowGraph, FlowNode, MilestoneProgress } from '../src/lib/api.js';
import {
  buildWaveList,
  dependencyLine,
  epicProject,
  epicStatusFromFlow,
} from '../src/lib/waveList.js';

function node(taskId: string, taskStatus: string, workingAgentRole: string | null = null): FlowNode {
  return {
    taskId,
    taskStatus,
    title: `Title for ${taskId}`,
    liveAgentRole: null,
    workingAgentRole,
    planVersion: 1,
    wave: 0,
  };
}

function graph(nodes: FlowNode[], waves: string[][], edges: FlowEdge[] = []): FlowGraph {
  return { nodes, edges, waves, planVersions: [1] };
}

describe('buildWaveList() (DS4 S3 §2)', () => {
  it('classifies every wave as past when all its tasks are done', () => {
    const g = graph(
      [node('t1', 'completed'), node('t2', 'completed'), node('t3', 'waived')],
      [['t1'], ['t2'], ['t3']],
    );
    const waves = buildWaveList(g);
    expect(waves.map((w) => w.kind)).toEqual(['past', 'past', 'past']);
    expect(waves[0]).toMatchObject({ index: 0, total: 3, doneCount: 1, taskCount: 1, pct: 100 });
  });

  it('makes the first wave current when none are done', () => {
    const g = graph([node('t1', 'todo'), node('t2', 'todo')], [['t1'], ['t2']]);
    const waves = buildWaveList(g);
    expect(waves.map((w) => w.kind)).toEqual(['current', 'upcoming']);
    expect(waves[1]?.doneCount).toBe(0);
  });

  it('handles a mixed wave: past waves before it, current at the first not-fully-done wave, upcoming after', () => {
    const g = graph(
      [
        node('t1', 'completed'),
        node('t2', 'completed'),
        node('t3', 'in-progress'),
        node('t4', 'todo'),
        node('t5', 'todo'),
      ],
      [['t1', 't2'], ['t3', 't4'], ['t5']],
    );
    const waves = buildWaveList(g);
    expect(waves.map((w) => w.kind)).toEqual(['past', 'current', 'upcoming']);
    expect(waves[1]).toMatchObject({ doneCount: 0, taskCount: 2, pct: 0 });
  });

  it('returns an empty list for an empty graph', () => {
    expect(buildWaveList(graph([], []))).toEqual([]);
  });

  it('carries workingAgentRole and the dependency line onto each task', () => {
    const g = graph(
      [node('t1', 'completed'), node('t2', 'in-progress', 'coder')],
      [['t1'], ['t2']],
      [{ task: 't2', dependsOn: 't1', edgeType: 'artifact', edgeProvenance: 'plan' }],
    );
    const waves = buildWaveList(g);
    expect(waves[1]?.tasks[0]).toMatchObject({
      taskId: 't2',
      workingAgentRole: 'coder',
      dependencyLine: 'After t1 · uses its output',
    });
    expect(waves[0]?.tasks[0]?.dependencyLine).toBeNull();
  });
});

describe('epicStatusFromFlow() (DS4 S1/S3 shared status logic)', () => {
  it('reads "To do" for an epic with no tasks', () => {
    expect(epicStatusFromFlow({ nodes: [] })).toEqual({ statusTone: 'neutral', statusLabel: 'To do' });
  });

  it('reads "Done" when every task is over', () => {
    expect(
      epicStatusFromFlow({ nodes: [node('t1', 'completed'), node('t2', 'waived')] }),
    ).toEqual({ statusTone: 'done', statusLabel: 'Done' });
  });

  it('reads "In progress" when some tasks are over and at least one is not', () => {
    expect(
      epicStatusFromFlow({ nodes: [node('t1', 'completed'), node('t2', 'in-progress')] }),
    ).toEqual({ statusTone: 'progress', statusLabel: 'In progress' });
  });

  it('reads "In progress" for any not-yet-over mix, even all-todo (existing S2 semantics)', () => {
    expect(epicStatusFromFlow({ nodes: [node('t1', 'todo'), node('t2', 'todo')] })).toEqual({
      statusTone: 'progress',
      statusLabel: 'In progress',
    });
  });
});

describe('dependencyLine() (DS4 S3 §2/§6)', () => {
  it('returns null with no incoming edge', () => {
    expect(dependencyLine([], 't1')).toBeNull();
  });

  it('names the first dependency and tails the rest, the way dependencyChainText does', () => {
    const edges: FlowEdge[] = [
      { task: 't3', dependsOn: 't1', edgeType: 'artifact', edgeProvenance: 'plan' },
      { task: 't3', dependsOn: 't2', edgeType: 'claim-order', edgeProvenance: 'plan' },
    ];
    expect(dependencyLine(edges, 't3')).toBe('After t1 · uses its output +1 more');
  });
});

// DS4 S3 fix round 1 finding 3: epic mode passed the project-filter value
// straight into EpicBlock, so "All projects" (no filter) never showed a Tag
// at all. epicProject() derives it from the epic's own milestone instead.
function milestone(project: string, epicIds: string[]): Pick<MilestoneProgress, 'project' | 'epicIds'> {
  return { project, epicIds };
}

describe('epicProject() (DS4 S3 fix round 1 finding 3)', () => {
  it('finds the project of the milestone that lists this epic', () => {
    const milestones = [milestone('black-smith', ['epic-1']), milestone('demo-hub', ['epic-9'])];
    expect(epicProject(milestones, 'epic-9', null)).toBe('demo-hub');
  });

  it('falls back to the given value when no milestone lists the epic', () => {
    const milestones = [milestone('black-smith', ['epic-1'])];
    expect(epicProject(milestones, 'epic-9', 'fallback-project')).toBe('fallback-project');
  });

  it('falls back to null when no milestone lists the epic and no fallback is given', () => {
    expect(epicProject([], 'epic-9', null)).toBeNull();
  });
});
