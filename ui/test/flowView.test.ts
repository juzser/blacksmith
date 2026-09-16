import { describe, expect, it } from 'vitest';
import type { FlowEdge, FlowGraph, FlowNode } from '../src/lib/api.js';
import { retainFlowView } from '../src/lib/flowView.js';

// A poll tick must not wipe the operator's view state (D-243: the topbar
// Refresh must reach Flow without resetting an expanded wave or a chosen
// edge-type filter back to nothing every 15s). But a wave index or an edge
// type only means something inside the graph it came from, so a refetch
// that dropped a wave or stopped drawing an edge type must not keep
// pointing at it either — retainFlowView() is the pure intersection this
// page's load() defers to instead of load()'s old unconditional reset.

function node(taskId: string, wave: number, over: Partial<FlowNode> = {}): FlowNode {
  return {
    taskId,
    taskStatus: 'in-progress',
    title: null,
    liveAgentRole: null,
    workingAgentRole: null,
    planVersion: 1,
    wave,
    ...over,
  };
}

function edge(task: string, dependsOn: string, edgeType: string): FlowEdge {
  return { task, dependsOn, edgeType, edgeProvenance: 'plan' };
}

function graph(waves: string[][], nodes: FlowNode[], edges: FlowEdge[] = []): FlowGraph {
  return { waves, nodes, edges, planVersions: [1] };
}

describe('retainFlowView', () => {
  it('keeps expanded waves whose index still exists in the new graph', () => {
    const prev = { expandedWaves: new Set([0, 1]), edgeTypes: [] };
    const next = graph([['a'], ['b']], [node('a', 0), node('b', 1)]);
    const result = retainFlowView(prev, next);
    expect(result.expandedWaves).toEqual(new Set([0, 1]));
  });

  it('drops an expanded wave whose index no longer exists', () => {
    const prev = { expandedWaves: new Set([0, 1, 2]), edgeTypes: [] };
    const next = graph([['a']], [node('a', 0)]);
    const result = retainFlowView(prev, next);
    expect(result.expandedWaves).toEqual(new Set([0]));
  });

  it('keeps edge types that still appear among the new graph edges', () => {
    const prev = { expandedWaves: new Set<number>(), edgeTypes: ['artifact', 'claim-order'] };
    const next = graph([['a'], ['b']], [node('a', 0), node('b', 1)], [edge('b', 'a', 'artifact')]);
    const result = retainFlowView(prev, next);
    expect(result.edgeTypes).toEqual(['artifact']);
  });

  it('drops an edge type no longer present among the new graph edges', () => {
    const prev = { expandedWaves: new Set<number>(), edgeTypes: ['claim-order'] };
    const next = graph([['a'], ['b']], [node('a', 0), node('b', 1)], [edge('b', 'a', 'artifact')]);
    const result = retainFlowView(prev, next);
    expect(result.edgeTypes).toEqual([]);
  });

  it('leaves an empty previous state empty', () => {
    const prev = { expandedWaves: new Set<number>(), edgeTypes: [] };
    const next = graph([['a']], [node('a', 0)], [edge('a', 'a', 'artifact')]);
    const result = retainFlowView(prev, next);
    expect(result.expandedWaves).toEqual(new Set());
    expect(result.edgeTypes).toEqual([]);
  });

  it('returns a fresh Set instance rather than mutating the previous one', () => {
    const prevWaves = new Set([0]);
    const prev = { expandedWaves: prevWaves, edgeTypes: [] };
    const next = graph([['a']], [node('a', 0)]);
    const result = retainFlowView(prev, next);
    expect(result.expandedWaves).not.toBe(prevWaves);
  });
});
