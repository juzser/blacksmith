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
//
// A later directive — "Flow cũng cần tổ chức lại để dễ nhìn hơn" — arrived
// after the factory started dispatching twenty tasks in one wave, which the
// geometry above draws as a single 3552px stack: correct, separated, and
// unreadable without scrolling past everything either side of it. Three
// answers, all here rather than in the .vue file, because all three are
// arithmetic:
//
//   * A wave taller than ROW_CAP wraps into sub-columns instead of growing
//     down forever. The wrap is balanced, not greedy, so seven tasks read as
//     4 + 3 rather than as a full column and one orphan.
//   * Work that is finished is folded away by default and counted on the wave
//     header. `failed` is deliberately NOT folded: a failed task is the one
//     thing an operator opens this page to find.
//   * When the store has edges to order by, a column is sorted to sit near
//     what it depends on, which shortens the arrows. With no edges recorded —
//     which is every session the factory has actually run (D-166) — that step
//     is the identity, so it can never scramble a plan's own ordering.
import type { FlowEdge, FlowGraph, FlowNode } from './api.js';

/** The node box. Mirrored by `.flow-node { width; min-height }`. */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 132;

/** Clear space between columns — the channel the edges are drawn through. */
export const COLUMN_GAP = 96;
/** Clear space between two nodes stacked in the same wave. */
export const ROW_GAP = 48;

export const WAVE_STEP_X = NODE_WIDTH + COLUMN_GAP;
export const ROW_STEP_Y = NODE_HEIGHT + ROW_GAP;

/**
 * Rows a single sub-column may hold before a wave wraps beside itself. Six
 * rows is 5 * ROW_STEP_Y + NODE_HEIGHT = 1032px — a canvas height a laptop can
 * show whole at 1:1, which is the whole point of the cap.
 */
export const ROW_CAP = 6;

/**
 * Clear space between two sub-columns of the SAME wave. Tighter than
 * COLUMN_GAP on purpose: no edge is ever drawn between sub-columns, so the
 * channel COLUMN_GAP exists to reserve is not needed here, and the tighter
 * step is what makes a wrapped wave read as one wave.
 */
export const SUBCOL_GAP = 24;
export const SUBCOL_STEP_X = NODE_WIDTH + SUBCOL_GAP;

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
  /**
   * `count` is the whole wave; `collapsed` is how much of it is not drawn.
   * Both travel, because reporting only what was drawn is how a count label
   * ends up disagreeing with the board beside it (D-242).
   */
  data: { wave: number; count: number; subcolumns: number; collapsed: number };
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
 * Splits one wave's column into sub-columns of at most `cap` rows, filling
 * each sub-column top to bottom before starting the next, so reading order
 * survives the wrap.
 *
 * The split is BALANCED rather than greedy: seven tasks under a cap of six
 * become 4 + 3, not 6 + 1. Greedy is correct and looks like a mistake — a full
 * column with a single node stranded beside it reads as something having gone
 * wrong, and the operator then spends attention on the orphan. Balanced costs
 * the same width and reads as one shape.
 *
 * A cap below one is read as no cap at all, the same way `capColumn` treats it
 * on the Kanban board: it is a misconfiguration, and drawing nothing is a
 * worse answer to it than drawing everything.
 */
export function wrapWaveColumn<T>(column: readonly T[], cap: number = ROW_CAP): T[][] {
  if (column.length === 0) return [];
  const limit = cap >= 1 ? Math.floor(cap) : column.length;
  if (column.length <= limit) return [[...column]];
  const subcolumns = Math.ceil(column.length / limit);
  const per = Math.ceil(column.length / subcolumns);
  const out: T[][] = [];
  for (let i = 0; i < column.length; i += per) out.push(column.slice(i, i + per));
  return out;
}

/**
 * The horizontal space one wave occupies, sub-columns included. A wave of one
 * sub-column measures exactly NODE_WIDTH, which is what keeps every unwrapped
 * diagram stepping by WAVE_STEP_X — the wrap changes nothing until a wave is
 * actually tall enough to need it.
 *
 * A wave with NO sub-columns still measures a node wide: everything in it was
 * folded away, but its header is still drawn and still needs somewhere to sit.
 */
export function waveWidth(subcolumns: number): number {
  return Math.max(1, subcolumns) * SUBCOL_STEP_X - SUBCOL_GAP;
}

/**
 * Statuses that mean the task is not going to change again. `failed` is
 * pointedly absent: it is terminal in the plan's sense but it is the single
 * most interesting node on the canvas, and folding it away would hide the one
 * thing the operator came here to see.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'waived', 'superseded']);

export interface TerminalCollapse {
  visible: FlowNode[];
  collapsedCount: number;
}

/**
 * Drops finished work out of a wave and reports how much it dropped, so the
 * header can say so. `expanded` is the operator's per-wave override.
 */
export function collapseTerminalTasks(
  column: readonly FlowNode[],
  expanded: boolean,
): TerminalCollapse {
  if (expanded) return { visible: [...column], collapsedCount: 0 };
  const visible = column.filter((n) => !TERMINAL_STATUSES.has(n.taskStatus));
  return { visible, collapsedCount: column.length - visible.length };
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Reorders one column so each task sits near the tasks it depends on — the
 * standard median heuristic for crossing reduction, which is what makes a
 * dense wave's arrows readable instead of a hairball.
 *
 * The two index spaces are different lengths, so both keys are normalised into
 * [0, 1] before they are compared; otherwise a column of three sorted against
 * a previous column of twenty would put every anchored task first regardless
 * of where its predecessor actually was. Unanchored tasks keep their own
 * position in that same normalised space, so they drift neither to the top nor
 * to the bottom, and the sort is broken by original index so it is stable.
 *
 * With no edges recorded — which is every session the factory has run
 * (D-166) — this returns the column untouched. That is the important case:
 * the plan's own ordering is meaningful, and a heuristic with no data must not
 * be allowed to shuffle it.
 */
export function orderColumnByDependency(
  column: readonly FlowNode[],
  edges: readonly FlowEdge[],
  previousOrder: readonly string[],
): FlowNode[] {
  if (column.length < 2 || edges.length === 0 || previousOrder.length === 0) return [...column];
  const rank = new Map(previousOrder.map((id, i) => [id, i]));
  const anchorSpan = Math.max(1, previousOrder.length - 1);
  const ownSpan = Math.max(1, column.length - 1);

  const keyed = column.map((node, index) => {
    const anchors = edges
      .filter((e) => e.task === node.taskId)
      .map((e) => rank.get(e.dependsOn))
      .filter((r): r is number => r !== undefined)
      .sort((a, b) => a - b);
    return {
      node,
      index,
      key: anchors.length === 0 ? index / ownSpan : median(anchors) / anchorSpan,
    };
  });
  keyed.sort((a, b) => a.key - b.key || a.index - b.index);
  return keyed.map((k) => k.node);
}

/**
 * The edge-type legend doubles as the filter. An empty selection means "all",
 * matching the convention FilterChips already carries on the Timeline page:
 * selecting nothing is how you say you have not narrowed anything, not how you
 * ask for an empty canvas.
 */
export function filterEdgesByType(
  edges: readonly FlowEdge[],
  visibleTypes?: ReadonlySet<string>,
): FlowEdge[] {
  if (!visibleTypes || visibleTypes.size === 0) return [...edges];
  return edges.filter((e) => visibleTypes.has(e.edgeType));
}

export type ZoomTier = 'detail' | 'compact' | 'mini';

/**
 * How much of a node card is worth painting at the current zoom. Below ~0.6 a
 * 12px supporting line is under 8 device pixels and reads as grey noise, so it
 * is dropped rather than drawn illegibly; below ~0.3 only the status colour and
 * the box survive. A zoom the caller cannot supply a number for is read as full
 * detail — the failure mode of guessing wrong that way is a slightly busy
 * canvas, and the failure mode of guessing the other way is a blank one.
 */
export function zoomTier(zoom: number): ZoomTier {
  if (!Number.isFinite(zoom)) return 'detail';
  if (zoom >= 0.6) return 'detail';
  if (zoom >= 0.3) return 'compact';
  return 'mini';
}

/**
 * What the Toolbar says the canvas is currently drawing. Each axis names
 * itself when it is not narrowed, because a toolbar that shows only the
 * narrowed axes leaves the operator to infer the rest from an absence.
 */
export function flowScopeLabel(
  project?: string | null,
  epic?: string | null,
  planVersion?: number | null,
): string {
  return [
    project || 'All projects',
    epic || 'All epics',
    planVersion == null ? 'Current plan' : `Plan v${planVersion}`,
  ].join(' · ');
}

export interface FlowLayoutOptions {
  /** Waves the operator has opened back up, by wave index. */
  expandedWaves?: ReadonlySet<number>;
  /** Set false to draw finished work everywhere, ignoring per-wave state. */
  collapseTerminal?: boolean;
}

interface PreparedWave {
  wave: number;
  count: number;
  collapsed: number;
  subcolumns: FlowNode[][];
}

/**
 * Positioned nodes for `<VueFlow :nodes>`: one per drawn task, plus one label
 * per non-empty wave. Labels share a single y so they read as a header row,
 * and that row sits clear above the tallest sub-column in the diagram.
 *
 * Two passes, because a wave's x depends on how wide every wave to its left
 * turned out to be, and that width is not known until its own column has been
 * folded and wrapped. An empty wave is skipped entirely — it has no count to
 * report, so it gets no header — while a wave that is merely *fully folded*
 * keeps its header and reports what it folded.
 */
export function flowLayoutNodes(graph: FlowGraph, opts: FlowLayoutOptions = {}): FlowLayoutNode[] {
  const collapse = opts.collapseTerminal !== false;
  const expandedWaves = opts.expandedWaves ?? new Set<number>();

  const prepared: PreparedWave[] = [];
  let previousOrder: string[] = [];
  flowColumns(graph).forEach((column, wave) => {
    if (column.length === 0) return;
    const ordered = orderColumnByDependency(column, graph.edges, previousOrder);
    previousOrder = ordered.map((n) => n.taskId);
    // Ordering runs on the whole column, folding after it: a task that is not
    // drawn is still a real predecessor for the wave to its right.
    const { visible, collapsedCount } = collapseTerminalTasks(
      ordered,
      !collapse || expandedWaves.has(wave),
    );
    prepared.push({
      wave,
      count: column.length,
      collapsed: collapsedCount,
      subcolumns: wrapWaveColumn(visible),
    });
  });
  if (prepared.length === 0) return [];

  const tallest = Math.max(
    1,
    ...prepared.map((p) => Math.max(0, ...p.subcolumns.map((s) => s.length))),
  );
  const labelY = -((tallest - 1) / 2) * ROW_STEP_Y - WAVE_LABEL_GAP;
  const nodes: FlowLayoutNode[] = [];
  let x = 0;

  for (const p of prepared) {
    nodes.push({
      id: waveNodeId(p.wave),
      type: 'wave',
      position: { x, y: labelY },
      data: {
        wave: p.wave,
        count: p.count,
        subcolumns: p.subcolumns.length,
        collapsed: p.collapsed,
      },
      selectable: false,
      focusable: false,
      draggable: false,
    });

    // All sub-columns of one wave share a top, and the block is centred on
    // y = 0 by its tallest sub-column. For a wave that did not wrap this is
    // the old formula exactly, which is why an unwrapped diagram is unmoved.
    const rows = Math.max(0, ...p.subcolumns.map((s) => s.length));
    const top = -((rows - 1) / 2) * ROW_STEP_Y;
    p.subcolumns.forEach((sub, subIndex) => {
      sub.forEach((node, row) => {
        nodes.push({
          id: node.taskId,
          type: 'task',
          position: { x: x + subIndex * SUBCOL_STEP_X, y: top + row * ROW_STEP_Y },
          data: node,
          sourcePosition: 'right',
          targetPosition: 'left',
        });
      });
    });

    x += waveWidth(p.subcolumns.length) + COLUMN_GAP;
  }

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
