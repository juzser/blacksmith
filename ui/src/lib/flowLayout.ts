// Pure layout for FlowPage's task DAG (operator directive, Phase 6b round 11:
// "Flow node cần tách nhau ra và hiển thị rõ ràng hơn"). Split out of the .vue
// file for the reason roadmapFlow.ts's header already anticipated — "the same
// split FlowPage's wave layout would have wanted" — so the geometry is unit-
// tested under ui/vitest.config.ts's node environment instead of resting on a
// screenshot nobody in this session can take.
//
// What changed, and why the numbers are what they are:
//
//   * The old geometry reserved 220px per wave for a node up to 200px wide and
//     96px per row for a node that measured ~92px. Two nodes in the same wave
//     were four pixels apart and two waves were twenty — the nodes read as one
//     block, which is exactly what the directive is about. Every step here is
//     now stated as `box + gap`, so the separation cannot be silently eaten by
//     a node that grows a line.
//   * Each wave is centred on y = 0 rather than hung from it. A wave of one
//     feeding a wave of five now fans out symmetrically instead of dropping
//     everything below the source node.
//   * The wave label is a NODE, not the absolutely-positioned band this page
//     used to paint. design-spec.md §A.4-5 already records why: bands are
//     drawn in canvas pixels and "drift out of register the moment the
//     operator pans" — and `fit-view-on-init` guarantees the register is wrong
//     from the first paint. A node lives in the same coordinate space as the
//     tasks it heads, so it simply cannot drift.
//
// NODE_WIDTH/NODE_HEIGHT are the box `.flow-node` occupies. They are mirrored
// in ds-components.css (`width`, `min-height`) and the two must move
// together — a node wider than NODE_WIDTH would overlap its neighbour, which
// is what flowLayout.test.ts's overlap check is there to catch.
import type { FlowGraph, FlowNode } from './api.js';

/** The node box. Mirrored by `.flow-node { width; min-height }`. */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 132;

/** Clear space between columns — the channel the edges are drawn through. */
export const COLUMN_GAP = 96;
/** Clear space between two nodes stacked in the same wave. */
export const ROW_GAP = 48;

export const WAVE_STEP_X = NODE_WIDTH + COLUMN_GAP;
export const ROW_STEP_Y = NODE_HEIGHT + ROW_GAP;

/** Distance from the top of the tallest column up to the wave label's own top. */
export const WAVE_LABEL_GAP = 72;

export interface XY {
  x: number;
  y: number;
}

export interface FlowTaskNode {
  id: string;
  type: 'task';
  position: XY;
  data: FlowNode;
  sourcePosition: 'right';
  targetPosition: 'left';
}

export interface FlowWaveNode {
  id: string;
  type: 'wave';
  position: XY;
  data: { wave: number; count: number };
  selectable: false;
  focusable: false;
  draggable: false;
}

export type FlowLayoutNode = FlowTaskNode | FlowWaveNode;

/**
 * The diagram's columns, left to right. `graph.waves` is the ordering the
 * server computed (`graph.ts`'s `waveLayers()`); `graph.nodes` is what there
 * is to draw. They come from two queries, so this reconciles them rather than
 * trusting either alone: ids in `waves` with no node are dropped, and nodes
 * missing from `waves` fall back to their own `wave` field instead of
 * disappearing from the picture.
 */
export function flowColumns(graph: FlowGraph): FlowNode[][] {
  const byId = new Map(graph.nodes.map((n) => [n.taskId, n]));
  const placed = new Set<string>();
  const columns: FlowNode[][] = graph.waves.map((wave) => {
    const column: FlowNode[] = [];
    for (const id of wave) {
      const node = byId.get(id);
      if (!node || placed.has(id)) continue;
      column.push(node);
      placed.add(id);
    }
    return column;
  });

  for (const node of graph.nodes) {
    if (placed.has(node.taskId)) continue;
    const index = Math.max(0, node.wave);
    while (columns.length <= index) columns.push([]);
    columns[index]?.push(node);
    placed.add(node.taskId);
  }
  return columns;
}

/**
 * Positioned nodes for `<VueFlow :nodes>`: one per task, plus one label per
 * non-empty wave. Labels share a single y so they read as a header row, and
 * that row sits clear above the tallest column.
 */
export function flowLayoutNodes(graph: FlowGraph): FlowLayoutNode[] {
  const columns = flowColumns(graph);
  const tallest = Math.max(0, ...columns.map((c) => c.length));
  if (tallest === 0) return [];

  const labelY = -((tallest - 1) / 2) * ROW_STEP_Y - WAVE_LABEL_GAP;
  const nodes: FlowLayoutNode[] = [];

  columns.forEach((column, wave) => {
    if (column.length === 0) return;
    const x = wave * WAVE_STEP_X;
    nodes.push({
      id: waveNodeId(wave),
      type: 'wave',
      position: { x, y: labelY },
      data: { wave, count: column.length },
      selectable: false,
      focusable: false,
      draggable: false,
    });
    column.forEach((node, index) => {
      nodes.push({
        id: node.taskId,
        type: 'task',
        position: { x, y: (index - (column.length - 1) / 2) * ROW_STEP_Y },
        data: node,
        sourcePosition: 'right',
        targetPosition: 'left',
      });
    });
  });

  return nodes;
}

/** Prefixed so a label can never collide with a real task id. */
export function waveNodeId(wave: number): string {
  return `__wave-${wave}`;
}

export interface PlanVersionOption {
  value: string;
  label: string;
}

/**
 * The Flow page's plan-version picker. Built from the graph's `planVersions`
 * — every version in scope — and never from `graph.nodes`, which the query
 * has already narrowed to the version being shown; a picker derived from
 * those could only offer what is on screen, so a superseded plan was
 * unreachable once the page had filtered it away (D-165). Sorted and
 * de-duplicated here as well as in the query, so an older server cannot
 * scramble the list.
 */
export function planVersionOptions(graph: FlowGraph | null): PlanVersionOption[] {
  const versions = [...new Set(graph?.planVersions ?? [])].sort((a, b) => b - a);
  return [
    { value: '', label: 'Current plan' },
    ...versions.map((v) => ({ value: String(v), label: `v${v}` })),
  ];
}

/**
 * What the screen-reader table's "Depends on" cell may say about one task.
 *
 * `edge-recorded` has no writer outside test fixtures, so the `edges` table is
 * empty on every session the factory has recorded, and the cell used to print
 * `none` for every row — a positive claim that the task has no prerequisites.
 * The plan files on disk declare those edges and `queue.admit()` orders real
 * merges by them, so the claim is false; the store simply has not been told
 * (D-166). With no edge in the whole graph the honest answer is that nothing
 * was recorded. `none` stays available for the case it actually describes: a
 * graph that does have edges, in which this task appears on no arrow.
 */
export function dependsOnLabel(graph: FlowGraph | null, taskId: string): string {
  if (!graph || graph.edges.length === 0) return 'not recorded';
  const deps = graph.edges.filter((e) => e.task === taskId).map((e) => e.dependsOn);
  return deps.length === 0 ? 'none' : deps.join(', ');
}
