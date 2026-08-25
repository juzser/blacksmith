import { describe, expect, it } from 'vitest';
import type { FlowGraph, FlowNode } from '../src/lib/api.js';
import {
  COLUMN_GAP,
  flowColumns,
  flowLayoutNodes,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_GAP,
  ROW_STEP_Y,
  WAVE_STEP_X,
} from '../src/lib/flowLayout.js';

// Operator directive (Phase 6b round 11): "Flow node cần tách nhau ra và hiển
// thị rõ ràng hơn". "Tách nhau ra" is a geometric claim, and no browser is
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
      { wave: 0, count: 1 },
      { wave: 1, count: 3 },
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
