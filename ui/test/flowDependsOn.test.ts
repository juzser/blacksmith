import { describe, expect, it } from 'vitest';
import type { FlowEdge, FlowGraph } from '../src/lib/api.js';
import { dependsOnLabel } from '../src/lib/flowLayout.js';

// D-166: nothing in production writes `edge-recorded`, so the `edges` table is
// empty on every session the factory has ever run. The Flow page's screen-
// reader table rendered that as "none" in each task's Depends on cell — a
// positive claim that the task has no prerequisites. It is false: the plan
// files on disk declare the edges, and the merge queue orders real merges by
// them. An unwritten fact and a known-empty one are different answers, and the
// page is only entitled to the first.
function edge(task: string, dependsOn: string): FlowEdge {
  return { task, dependsOn, edgeType: 'artifact', edgeProvenance: 'declared' };
}

function graph(edges: FlowEdge[]): FlowGraph {
  return { nodes: [], edges, waves: [], planVersions: [] };
}

describe('dependsOnLabel', () => {
  it('does not claim a task has no prerequisites when no edge was ever recorded', () => {
    expect(dependsOnLabel(graph([]), 'task-4-api')).toBe('not recorded');
  });

  it('says the same for a graph that has not loaded', () => {
    expect(dependsOnLabel(null, 'task-4-api')).toBe('not recorded');
  });

  it('says none only when the graph has edges and this task is in none of them', () => {
    expect(dependsOnLabel(graph([edge('task-2', 'task-1')]), 'task-1')).toBe('none');
  });

  it('lists the prerequisites in the order the graph reports them', () => {
    const g = graph([edge('task-4', 'task-1'), edge('task-3', 'task-1'), edge('task-4', 'task-2')]);
    expect(dependsOnLabel(g, 'task-4')).toBe('task-1, task-2');
  });
});
