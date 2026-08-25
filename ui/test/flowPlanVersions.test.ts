import { describe, expect, it } from 'vitest';
import type { FlowGraph, FlowNode } from '../src/lib/api.js';
import { planVersionOptions } from '../src/lib/flowLayout.js';

// D-165: the picker used to be derived from `graph.nodes` — the tasks the
// server had ALREADY filtered to one plan version. It could therefore only
// ever offer the version on screen, so the operator had no way back to a
// superseded plan: a filter that seals itself shut. The options now come from
// the graph's own `planVersions`, which the query reports before filtering.
function node(taskId: string, planVersion: number | null): FlowNode {
  return {
    taskId,
    taskStatus: 'ready',
    title: null,
    liveAgentRole: null,
    planVersion,
    wave: 0,
  };
}

function graph(planVersions: number[], nodes: FlowNode[]): FlowGraph {
  return { nodes, edges: [], waves: [nodes.map((n) => n.taskId)], planVersions };
}

describe('planVersionOptions() (D-165)', () => {
  it('offers a version the current view does not contain', () => {
    // The v2 plan is what is being shown; v1 is what the operator wants back.
    const options = planVersionOptions(graph([2, 1], [node('epic-b/task-b2', 2)]));
    expect(options).toEqual([
      { value: '', label: 'Current plan' },
      { value: '2', label: 'v2' },
      { value: '1', label: 'v1' },
    ]);
  });

  it('always leads with the unfiltered default', () => {
    expect(planVersionOptions(null)).toEqual([{ value: '', label: 'Current plan' }]);
    expect(planVersionOptions(graph([], [node('epic-a/task-a1', null)]))).toEqual([
      { value: '', label: 'Current plan' },
    ]);
  });

  it('sorts newest first and drops duplicates, whatever order the server sent', () => {
    const options = planVersionOptions(graph([1, 3, 1, 2], []));
    expect(options.map((o) => o.label)).toEqual(['Current plan', 'v3', 'v2', 'v1']);
  });
});
