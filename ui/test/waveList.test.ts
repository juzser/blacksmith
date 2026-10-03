import { describe, expect, it } from 'vitest';
import type {
  FlowEdge,
  FlowGraph,
  FlowNode,
  MilestoneProgress,
  StatusCounts,
} from '../src/lib/api.js';
import {
  buildWaveList,
  dependencyLine,
  epicPhase,
  epicProject,
  epicStatusFromFlow,
  epicStatusFromServerStatus,
  isHttpsUrl,
  mobileEpicStatusLine,
  statusCountsBar,
} from '../src/lib/waveList.js';

function node(
  taskId: string,
  taskStatus: string,
  workingAgentRole: string | null = null,
): FlowNode {
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
    expect(epicStatusFromFlow({ nodes: [] })).toEqual({
      statusTone: 'neutral',
      statusLabel: 'To do',
    });
  });

  it('reads "Done" when every task is over', () => {
    expect(epicStatusFromFlow({ nodes: [node('t1', 'completed'), node('t2', 'waived')] })).toEqual({
      statusTone: 'done',
      statusLabel: 'Done',
    });
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

// DS4 S5c §1 — statusCounts -> ProgressBar's stacked segments + aria-label.
function counts(done: number, review: number, inProgress: number, todo: number): StatusCounts {
  return { done, review, inProgress, todo, superseded: 0 };
}

describe('statusCountsBar() (DS4 S5c §1)', () => {
  it('orders segments done, review, progress and excludes superseded from the total', () => {
    const bar = statusCountsBar({ ...counts(13, 3, 4, 5), superseded: 7 });
    expect(bar.segments.map((s) => s.tone)).toEqual(['done', 'review', 'progress']);
    expect(bar.segments[0]).toMatchObject({ tone: 'done', value: 52 });
  });

  it('matches the mock aria-label when some tasks remain', () => {
    const bar = statusCountsBar(counts(13, 3, 4, 5));
    expect(bar.ariaLabel).toBe(
      '13 of 25 tasks done (52%); the rest in review, in progress or todo',
    );
  });

  it('drops the "the rest" clause once nothing remains', () => {
    const bar = statusCountsBar(counts(10, 0, 0, 0));
    expect(bar.ariaLabel).toBe('10 of 10 tasks done (100%)');
  });

  it('reads 0% for an all-zero total rather than dividing by zero', () => {
    const bar = statusCountsBar(counts(0, 0, 0, 0));
    expect(bar.segments.every((s) => s.value === 0)).toBe(true);
    expect(bar.ariaLabel).toBe('0 of 0 tasks done (0%)');
  });
});

describe('epicStatusFromServerStatus() (DS4 S5c §2)', () => {
  it('maps every server status to the existing tone/label set', () => {
    expect(epicStatusFromServerStatus('done')).toEqual({ statusTone: 'done', statusLabel: 'Done' });
    expect(epicStatusFromServerStatus('review')).toEqual({
      statusTone: 'review',
      statusLabel: 'In review',
    });
    expect(epicStatusFromServerStatus('in_progress')).toEqual({
      statusTone: 'progress',
      statusLabel: 'In progress',
    });
    expect(epicStatusFromServerStatus('todo')).toEqual({
      statusTone: 'todo',
      statusLabel: 'To do',
    });
  });
});

describe('isHttpsUrl() (DS4 S5c §4)', () => {
  it('accepts an https URL', () => {
    expect(isHttpsUrl('https://github.com/example/pr/1')).toBe(true);
  });

  it('rejects null, http and other schemes', () => {
    expect(isHttpsUrl(null)).toBe(false);
    expect(isHttpsUrl('http://github.com/example/pr/1')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects an unparsable value instead of throwing', () => {
    expect(isHttpsUrl('not a url')).toBe(false);
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
function milestone(
  project: string,
  epicIds: string[],
): Pick<MilestoneProgress, 'project' | 'epicIds'> {
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

// DS4 S4 R1: the phone epic-mode back link ("← {phase name}") renders only
// when the phase for this epic is known.
function phaseMilestone(
  milestoneId: string,
  name: string,
  epicIds: string[],
): Pick<MilestoneProgress, 'milestoneId' | 'name' | 'epicIds'> {
  return { milestoneId, name, epicIds };
}

describe('epicPhase() (DS4 S4 R1)', () => {
  it('finds the phase that lists this epic', () => {
    const milestones = [
      phaseMilestone('phase-6b', 'Phase 6b', ['epic-9']),
      phaseMilestone('phase-7', 'Phase 7 — envkit bootstrap', ['epic-20']),
    ];
    expect(epicPhase(milestones, 'epic-9')).toEqual({ milestoneId: 'phase-6b', name: 'Phase 6b' });
  });

  it('returns null when no phase lists the epic', () => {
    expect(epicPhase([phaseMilestone('phase-6b', 'Phase 6b', ['epic-9'])], 'epic-20')).toBeNull();
  });
});

// DS4 S4 §1: the phone epic row's status line.
describe('mobileEpicStatusLine() (DS4 S4 §1)', () => {
  it('reads "No tasks tracked" for a zero-task epic', () => {
    expect(
      mobileEpicStatusLine({ statusLabel: 'To do', tasksTotal: 0, tasksCompleted: 0, waves: [] }),
    ).toBe('No tasks tracked');
  });

  it('reads "Loading" while the epic flow is still in flight', () => {
    expect(
      mobileEpicStatusLine({
        statusLabel: 'Loading',
        tasksTotal: null,
        tasksCompleted: null,
        waves: [],
      }),
    ).toBe('Loading');
  });

  it("reads the failed copy when the epic's flow could not load", () => {
    expect(
      mobileEpicStatusLine({
        statusLabel: 'Unavailable',
        tasksTotal: 0,
        tasksCompleted: 0,
        failed: true,
        waves: [],
      }),
    ).toBe("Could not load this epic's tasks.");
  });

  it('names the current wave for an in-progress epic', () => {
    const g = graph(
      [
        node('t1', 'completed'),
        node('t2', 'completed'),
        node('t3', 'in-progress'),
        node('t4', 'todo'),
      ],
      [['t1', 't2'], ['t3'], ['t4']],
    );
    const waves = buildWaveList(g);
    expect(
      mobileEpicStatusLine({ statusLabel: 'In progress', tasksTotal: 4, tasksCompleted: 2, waves }),
    ).toBe('In progress · 2 of 4 · wave 2 of 3 running');
  });

  it('names no wave for a fully done epic', () => {
    const g = graph([node('t1', 'completed'), node('t2', 'completed')], [['t1'], ['t2']]);
    const waves = buildWaveList(g);
    expect(
      mobileEpicStatusLine({ statusLabel: 'Done', tasksTotal: 2, tasksCompleted: 2, waves }),
    ).toBe('Done · 2 of 2');
  });
});
