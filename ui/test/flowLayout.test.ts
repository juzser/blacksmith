import { describe, expect, it } from 'vitest';
import type { FlowEdge, FlowGraph, FlowNode } from '../src/lib/api.js';
import {
  COLUMN_GAP,
  collapseTerminalTasks,
  filterEdgesByType,
  flowColumns,
  flowLayoutNodes,
  flowScopeLabel,
  NODE_HEIGHT,
  NODE_WIDTH,
  orderColumnByDependency,
  ROW_CAP,
  ROW_GAP,
  ROW_STEP_Y,
  SUBCOL_GAP,
  SUBCOL_STEP_X,
  WAVE_STEP_X,
  waveWidth,
  wrapWaveColumn,
  zoomTier,
} from '../src/lib/flowLayout.js';

// Operator directive (Phase 6b round 11): "flow nodes need to be spaced apart
// and shown more clearly". "Spaced apart" is a geometric claim, and no browser
// is
// reachable from this session (ui/playwright.config.ts points at a chromium
// binary that isn't installed), so it is asserted here as arithmetic over the
// boxes the layout reserves rather than left to a screenshot nobody can take.

function task(taskId: string, wave: number, over: Partial<FlowNode> = {}): FlowNode {
  return {
    taskId,
    taskStatus: 'in-progress',
    title: null,
    liveAgentRole: null,
    planVersion: 1,
    wave,
    ...over,
  };
}

function graph(waves: string[][], nodes?: FlowNode[]): FlowGraph {
  return {
    nodes: nodes ?? waves.flatMap((w, i) => w.map((id) => task(id, i))),
    edges: [],
    waves,
    planVersions: [1],
  };
}

interface Box {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxes(g: FlowGraph): Box[] {
  return flowLayoutNodes(g).map((n) => ({
    id: n.id,
    left: n.position.x,
    right: n.position.x + NODE_WIDTH,
    top: n.position.y,
    bottom: n.position.y + (n.type === 'task' ? NODE_HEIGHT : ROW_GAP),
  }));
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe('flowColumns', () => {
  it('groups nodes into the wave columns the API sent', () => {
    const cols = flowColumns(graph([['a'], ['b', 'c']]));
    expect(cols.map((c) => c.map((n) => n.taskId))).toEqual([['a'], ['b', 'c']]);
  });

  it('preserves the order inside a wave', () => {
    const cols = flowColumns(graph([['c', 'a', 'b']]));
    expect(cols[0]?.map((n) => n.taskId)).toEqual(['c', 'a', 'b']);
  });

  it('still draws a node the wave list forgot, at its own wave index', () => {
    // The server builds `waves` and `nodes` from two queries; a node missing
    // from `waves` must not vanish from the diagram.
    const g: FlowGraph = {
      nodes: [task('a', 0), task('orphan', 2)],
      edges: [],
      waves: [['a']],
      planVersions: [1],
    };
    const cols = flowColumns(g);
    expect(cols).toHaveLength(3);
    expect(cols[2]?.map((n) => n.taskId)).toEqual(['orphan']);
  });

  it('ignores a wave entry with no matching node', () => {
    const g: FlowGraph = {
      nodes: [task('a', 0)],
      edges: [],
      waves: [['a', 'ghost']],
      planVersions: [1],
    };
    expect(flowColumns(g)[0]?.map((n) => n.taskId)).toEqual(['a']);
  });
});

describe('flowLayoutNodes', () => {
  it('leaves a full column gutter between waves', () => {
    const [a, b] = flowLayoutNodes(graph([['a'], ['b']])).filter((n) => n.type === 'task');
    expect(a?.position.x).toBe(0);
    expect((b?.position.x ?? 0) - (a?.position.x ?? 0)).toBe(WAVE_STEP_X);
    // The gutter is what the edges are drawn through: node width plus clear space.
    expect(WAVE_STEP_X - NODE_WIDTH).toBe(COLUMN_GAP);
  });

  it('leaves a full row gutter between stacked nodes', () => {
    const stacked = flowLayoutNodes(graph([['a', 'b']])).filter((n) => n.type === 'task');
    const [a, b] = stacked;
    expect((b?.position.y ?? 0) - (a?.position.y ?? 0)).toBe(ROW_STEP_Y);
    expect(ROW_STEP_Y - NODE_HEIGHT).toBe(ROW_GAP);
  });

  it('centres each wave vertically so a fan-out reads symmetrically', () => {
    const single = flowLayoutNodes(graph([['solo']])).filter((n) => n.type === 'task');
    expect(single[0]?.position.y).toBe(0);

    const three = flowLayoutNodes(graph([['a', 'b', 'c']])).filter((n) => n.type === 'task');
    expect(three.map((n) => n.position.y)).toEqual([-ROW_STEP_Y, 0, ROW_STEP_Y]);
  });

  it('never overlaps two boxes, however ragged the waves are', () => {
    const all = boxes(graph([['a'], ['b', 'c', 'd', 'e'], ['f', 'g'], ['h']]));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [x, y] = [all[i], all[j]];
        if (!x || !y) continue;
        expect(overlaps(x, y), `${x.id} overlaps ${y.id}`).toBe(false);
      }
    }
  });

  it('heads every non-empty column with one wave label, all on the same row', () => {
    const nodes = flowLayoutNodes(graph([['a'], ['b', 'c', 'd']]));
    const labels = nodes.filter((n) => n.type === 'wave');
    expect(labels.map((n) => n.data)).toEqual([
      { wave: 0, count: 1, subcolumns: 1, collapsed: 0 },
      { wave: 1, count: 3, subcolumns: 1, collapsed: 0 },
    ]);
    expect(new Set(labels.map((n) => n.position.y)).size).toBe(1);
    // Above every task in the diagram, including the tallest column's first node.
    const highestTask = Math.min(
      ...nodes.filter((n) => n.type === 'task').map((n) => n.position.y),
    );
    for (const label of labels) expect(label.position.y).toBeLessThan(highestTask);
  });

  it('puts each label over its own column', () => {
    const nodes = flowLayoutNodes(graph([['a'], ['b']]));
    const label = nodes.find((n) => n.type === 'wave' && n.data.wave === 1);
    const taskNode = nodes.find((n) => n.id === 'b');
    expect(label?.position.x).toBe(taskNode?.position.x);
  });

  it('labels nothing and lays out nothing for an empty graph', () => {
    expect(flowLayoutNodes(graph([]))).toEqual([]);
  });

  it('carries the task through as node data, wired left-to-right', () => {
    const node = flowLayoutNodes(graph([['a']], [task('a', 0, { liveAgentRole: 'coder' })])).find(
      (n) => n.type === 'task',
    );
    expect(node?.type).toBe('task');
    expect(node?.data).toMatchObject({ taskId: 'a', liveAgentRole: 'coder' });
    if (node?.type === 'task') {
      expect(node.sourcePosition).toBe('right');
      expect(node.targetPosition).toBe('left');
    }
  });

  it('never lets a wave label be selected or dragged into the graph', () => {
    const label = flowLayoutNodes(graph([['a']])).find((n) => n.type === 'wave');
    expect(label).toMatchObject({ selectable: false, focusable: false, draggable: false });
  });
});

// Operator directive (dashboard round, item 4): "Flow cung can to chuc lai de de
// nhin hon, uiux can can thiep." The uiux spec answered with four moves -- wrap a
// tall wave into sub-columns, fold finished work away, thin the edge paint to one
// colour with a filter, and give the page the Toolbar every other scoped page
// already has. The first two are geometry and are pinned here; the last two are
// paint, and are pinned only where they are pure (the filter, the zoom tier, the
// scope label).

function edge(task: string, dependsOn: string, edgeType = 'artifact'): FlowEdge {
  return { task, dependsOn, edgeType, edgeProvenance: 'planner' };
}

function ids(nodes: { id: string }[]): string[] {
  return nodes.map((n) => n.id);
}

describe('wrapWaveColumn', () => {
  it('leaves a column at or under the cap in one piece', () => {
    expect(wrapWaveColumn(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
    expect(wrapWaveColumn(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual([
      ['a', 'b', 'c', 'd', 'e', 'f'],
    ]);
  });

  it('balances the wrap instead of leaving a stub beside a full column', () => {
    // Greedy would draw 6 + 1: a full column and one lonely node. Balanced reads
    // as one shape.
    expect(wrapWaveColumn(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g'],
    ]);
  });

  it('never puts more than the cap in a sub-column', () => {
    for (let n = 1; n <= 40; n++) {
      const column = Array.from({ length: n }, (_, i) => `t${i}`);
      const wrapped = wrapWaveColumn(column);
      for (const sub of wrapped) expect(sub.length).toBeLessThanOrEqual(ROW_CAP);
      expect(wrapped.flat()).toEqual(column);
    }
  });

  it('fills down before it moves across, so reading order survives', () => {
    expect(wrapWaveColumn(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('reads a cap below one as no wrap at all, rather than dividing by zero', () => {
    expect(wrapWaveColumn(['a', 'b', 'c'], 0)).toEqual([['a', 'b', 'c']]);
  });

  it('wraps an empty column into no sub-columns', () => {
    expect(wrapWaveColumn([])).toEqual([]);
  });
});

describe('waveWidth', () => {
  it('measures a single sub-column as exactly one node box', () => {
    // This is what keeps every existing one-column diagram stepping by WAVE_STEP_X.
    expect(waveWidth(1)).toBe(NODE_WIDTH);
    expect(waveWidth(0)).toBe(NODE_WIDTH);
  });

  it('adds a node and a sub-column gutter for each extra sub-column', () => {
    expect(waveWidth(2)).toBe(NODE_WIDTH + SUBCOL_GAP + NODE_WIDTH);
    expect(waveWidth(3) - waveWidth(2)).toBe(SUBCOL_STEP_X);
  });
});

describe('flowLayoutNodes, wrapped waves', () => {
  const thirteen = graph([Array.from({ length: 13 }, (_, i) => `t${i}`)]);

  it('caps a tall wave at ROW_CAP rows and puts the rest beside it', () => {
    const tasks = flowLayoutNodes(thirteen).filter((n) => n.type === 'task');
    const byX = new Map<number, typeof tasks>();
    for (const n of tasks) byX.set(n.position.x, [...(byX.get(n.position.x) ?? []), n]);
    expect(byX.size).toBe(3);
    for (const column of byX.values()) expect(column.length).toBeLessThanOrEqual(ROW_CAP);
  });

  it('steps sub-columns by the tighter sub-column gutter, not the wave gutter', () => {
    const xs = [
      ...new Set(
        flowLayoutNodes(thirteen)
          .filter((n) => n.type === 'task')
          .map((n) => n.position.x),
      ),
    ].sort((a, b) => a - b);
    // Absolute, not pairwise: the wave opens at x = 0 and each sub-column is
    // one tighter gutter to the right of the last, so the whole ladder is one
    // assertion rather than three indexes that have to be asserted non-null.
    expect(xs).toEqual([0, SUBCOL_STEP_X, 2 * SUBCOL_STEP_X]);
    // Tighter than a wave gutter on purpose: sub-columns are one wave, and no
    // edge is ever drawn between them.
    expect(SUBCOL_STEP_X).toBeLessThan(WAVE_STEP_X);
  });

  it('keeps a wrapped wave inside the height a screen can hold', () => {
    const tasks = flowLayoutNodes(thirteen).filter((n) => n.type === 'task');
    const ys = tasks.map((n) => n.position.y);
    const span = Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT;
    expect(span).toBeLessThanOrEqual((ROW_CAP - 1) * ROW_STEP_Y + NODE_HEIGHT);
    // And decisively shorter than the single stack it replaces.
    expect(span).toBeLessThan((13 - 1) * ROW_STEP_Y + NODE_HEIGHT);
  });

  it('starts every sub-column of a wave on the same row', () => {
    const tasks = flowLayoutNodes(thirteen).filter((n) => n.type === 'task');
    const tops = new Map<number, number>();
    for (const n of tasks)
      tops.set(n.position.x, Math.min(tops.get(n.position.x) ?? n.position.y, n.position.y));
    expect(new Set(tops.values()).size).toBe(1);
  });

  it('still centres the wrapped block on the axis the edges run along', () => {
    const ys = flowLayoutNodes(thirteen)
      .filter((n) => n.type === 'task')
      .map((n) => n.position.y);
    expect(Math.min(...ys) + Math.max(...ys)).toBe(0);
  });

  it('pushes the next wave clear of the widest sub-column, not of one node', () => {
    const g = graph([Array.from({ length: 13 }, (_, i) => `t${i}`), ['after']]);
    const after = flowLayoutNodes(g).find((n) => n.id === 'after');
    expect(after?.position.x).toBe(waveWidth(3) + COLUMN_GAP);
  });

  it('never overlaps two boxes once a wave wraps', () => {
    const all = boxes(graph([['a'], Array.from({ length: 13 }, (_, i) => `t${i}`), ['z']]));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [x, y] = [all[i], all[j]];
        if (!x || !y) continue;
        expect(overlaps(x, y), `${x.id} overlaps ${y.id}`).toBe(false);
      }
    }
  });

  it('tells the wave label how many sub-columns it is heading', () => {
    const label = flowLayoutNodes(thirteen).find((n) => n.type === 'wave');
    expect(label?.data).toMatchObject({ wave: 0, count: 13, subcolumns: 3 });
  });
});

describe('collapseTerminalTasks', () => {
  const done = (id: string) => task(id, 0, { taskStatus: 'completed' });

  it('folds finished work away and says how much it folded', () => {
    const column = [done('a'), task('b', 0), done('c')];
    const { visible, collapsedCount } = collapseTerminalTasks(column, false);
    expect(visible.map((n) => n.taskId)).toEqual(['b']);
    expect(collapsedCount).toBe(2);
  });

  it('folds waived and superseded work too, since neither is still being worked', () => {
    const column = [
      task('a', 0, { taskStatus: 'waived' }),
      task('b', 0, { taskStatus: 'superseded' }),
      task('c', 0),
    ];
    expect(collapseTerminalTasks(column, false).visible.map((n) => n.taskId)).toEqual(['c']);
  });

  it('keeps a failed task on the canvas -- that is the one being looked for', () => {
    const column = [done('a'), task('b', 0, { taskStatus: 'failed' })];
    const { visible, collapsedCount } = collapseTerminalTasks(column, false);
    expect(visible.map((n) => n.taskId)).toEqual(['b']);
    expect(collapsedCount).toBe(1);
  });

  it('draws the whole column once the operator expands the wave', () => {
    const column = [done('a'), task('b', 0)];
    const { visible, collapsedCount } = collapseTerminalTasks(column, true);
    expect(visible).toHaveLength(2);
    expect(collapsedCount).toBe(0);
  });

  it('folds nothing away in a wave that is still running', () => {
    const column = [task('a', 0), task('b', 0)];
    expect(collapseTerminalTasks(column, false).collapsedCount).toBe(0);
  });
});

describe('flowLayoutNodes, folded waves', () => {
  const finished = graph(
    [['a', 'b'], ['c']],
    [
      task('a', 0, { taskStatus: 'completed' }),
      task('b', 0, { taskStatus: 'completed' }),
      task('c', 1),
    ],
  );

  it('still heads a wave it drew nothing for, and says what it folded', () => {
    const nodes = flowLayoutNodes(finished);
    expect(ids(nodes.filter((n) => n.type === 'task'))).toEqual(['c']);
    const label = nodes.find((n) => n.type === 'wave' && n.data.wave === 0);
    expect(label?.data).toMatchObject({ wave: 0, count: 2, collapsed: 2, subcolumns: 0 });
  });

  it('counts the whole wave in the header, never just what it drew', () => {
    // D-242: a count label must not disagree with the thing beside it. Here the
    // disagreement is the point, so both numbers are carried, not one.
    const label = flowLayoutNodes(finished).find((n) => n.type === 'wave' && n.data.wave === 0);
    expect(label?.data).toMatchObject({ count: 2 });
  });

  it('reopens a wave the operator expanded', () => {
    const nodes = flowLayoutNodes(finished, { expandedWaves: new Set([0]) });
    expect(ids(nodes.filter((n) => n.type === 'task'))).toEqual(['a', 'b', 'c']);
    const label = nodes.find((n) => n.type === 'wave' && n.data.wave === 0);
    expect(label?.data).toMatchObject({ collapsed: 0 });
  });

  it('draws everything when the caller turns folding off outright', () => {
    const nodes = flowLayoutNodes(finished, { collapseTerminal: false });
    expect(ids(nodes.filter((n) => n.type === 'task'))).toEqual(['a', 'b', 'c']);
  });

  it('lays out nothing at all for a wave the plan left empty', () => {
    // An empty wave is not a folded wave: there is no count to report, so there
    // is no header either.
    const nodes = flowLayoutNodes(graph([['a'], [], ['b']]));
    expect(nodes.filter((n) => n.type === 'wave').map((n) => n.data.wave)).toEqual([0, 2]);
  });
});

describe('orderColumnByDependency', () => {
  const column = [task('x', 1), task('y', 1)];
  const previous = ['p0', 'p1', 'p2', 'p3'];

  it('leaves the column exactly as it found it when no edge is recorded', () => {
    // D-166: the edges table is empty on every session the factory has recorded,
    // so this is the live case, and it must be the identity.
    expect(orderColumnByDependency(column, [], previous).map((n) => n.taskId)).toEqual(['x', 'y']);
  });

  it('pulls a task up beside the predecessor it depends on', () => {
    const edges = [edge('x', 'p3'), edge('y', 'p0')];
    expect(orderColumnByDependency(column, edges, previous).map((n) => n.taskId)).toEqual([
      'y',
      'x',
    ]);
  });

  it('anchors a task with several predecessors at their median', () => {
    const edges = [edge('x', 'p3'), edge('y', 'p0'), edge('y', 'p2')];
    expect(orderColumnByDependency(column, edges, previous).map((n) => n.taskId)).toEqual([
      'y',
      'x',
    ]);
  });

  it('leaves unanchored tasks in the order the plan gave them', () => {
    const three = [task('u', 1), task('v', 1), task('w', 1)];
    const ordered = orderColumnByDependency(three, [edge('w', 'p0')], previous);
    expect(ordered.map((n) => n.taskId)).toEqual(['u', 'w', 'v']);
  });

  it('ignores a dependency that is not in the column it is being aligned to', () => {
    const edges = [edge('y', 'somewhere-else')];
    expect(orderColumnByDependency(column, edges, previous).map((n) => n.taskId)).toEqual([
      'x',
      'y',
    ]);
  });

  it('survives a previous column of one, where every position is the same', () => {
    const edges = [edge('y', 'only')];
    expect(orderColumnByDependency(column, edges, ['only']).map((n) => n.taskId)).toEqual([
      'x',
      'y',
    ]);
  });
});

describe('filterEdgesByType', () => {
  const edges = [edge('b', 'a', 'artifact'), edge('c', 'a', 'claim-order'), edge('d', 'a')];

  it('draws every edge when nothing has been selected', () => {
    expect(filterEdgesByType(edges, new Set())).toEqual(edges);
    expect(filterEdgesByType(edges, undefined)).toEqual(edges);
  });

  it('keeps only the selected types', () => {
    expect(filterEdgesByType(edges, new Set(['claim-order'])).map((e) => e.task)).toEqual(['c']);
  });

  it('draws nothing when the selection matches no edge in the graph', () => {
    expect(filterEdgesByType(edges, new Set(['spec-clause']))).toEqual([]);
  });
});

describe('zoomTier', () => {
  it('shows the whole card while the canvas is readable', () => {
    expect(zoomTier(1)).toBe('detail');
    expect(zoomTier(0.6)).toBe('detail');
  });

  it('drops the supporting lines before they turn into grey mush', () => {
    expect(zoomTier(0.59)).toBe('compact');
    expect(zoomTier(0.3)).toBe('compact');
  });

  it('keeps only status and shape once a card is smaller than its own text', () => {
    expect(zoomTier(0.29)).toBe('mini');
  });

  it('reads a zoom it cannot make sense of as full detail, not as a blank canvas', () => {
    expect(zoomTier(Number.NaN)).toBe('detail');
  });
});

describe('flowScopeLabel', () => {
  it('names what the canvas is actually drawing', () => {
    expect(flowScopeLabel('envkit', 'envkit-bootstrap', 3)).toBe(
      'envkit · envkit-bootstrap · Plan v3',
    );
  });

  it('says so plainly on each axis that is not narrowed', () => {
    expect(flowScopeLabel('', '', null)).toBe('All projects · All epics · Current plan');
  });

  it('narrows one axis without claiming the others are narrowed too', () => {
    expect(flowScopeLabel('envkit', '', null)).toBe('envkit · All epics · Current plan');
  });
});
