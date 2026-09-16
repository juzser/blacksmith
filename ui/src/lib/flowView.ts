import type { FlowGraph } from './api.js';

/**
 * FlowPage's per-graph view state — which waves the operator opened back up
 * (Round 12's per-wave disclosure) and which edge types the legend/filter
 * currently narrows to. Both only mean something inside the graph they came
 * from: a wave index is a position in `graph.waves`, and an edge type is a
 * value that has to appear on at least one of `graph.edges`.
 */
export interface FlowViewState {
  expandedWaves: Set<number>;
  edgeTypes: string[];
}

/**
 * D-243: the topbar Refresh reaches Flow via a 15s poll now, and a poll tick
 * must not reset what the operator was looking at. `load()` used to zero
 * both fields unconditionally on every success (a wave index or edge type
 * from the PREVIOUS graph, replayed against a freshly fetched one, would
 * otherwise risk pointing at nothing, or worse, at a wave/edge type that
 * coincidentally exists but means something else). This is the intersection
 * instead of the reset: keep what still exists, drop what does not.
 */
export function retainFlowView(prev: FlowViewState, graph: FlowGraph): FlowViewState {
  const waveCount = graph.waves.length;
  const expandedWaves = new Set<number>();
  for (const wave of prev.expandedWaves) {
    if (wave >= 0 && wave < waveCount) expandedWaves.add(wave);
  }
  const availableTypes = new Set(graph.edges.map((e) => e.edgeType));
  const edgeTypes = prev.edgeTypes.filter((type) => availableTypes.has(type));
  return { expandedWaves, edgeTypes };
}
