import { describe, expect, it } from 'vitest';
import type { MilestoneProgress } from '../src/lib/api.js';
import {
  DEFAULT_ROADMAP_KIND,
  LANE_HEIGHT,
  MILESTONE_STEP_X,
  partitionByKind,
  roadmapFlowEdges,
  roadmapFlowNodes,
  roadmapLanes,
} from '../src/lib/roadmapFlow.js';
import { nth } from './helpers.js';

function m(over: Partial<MilestoneProgress> & { milestoneId: string }): MilestoneProgress {
  return {
    name: over.milestoneId,
    status: 'planned',
    sequence: 1,
    goal: null,
    epicIds: [],
    tasksTotal: 0,
    tasksCompleted: 0,
    tokensSpent: 0,
    tokensBudget: null,
    project: 'black-smith',
    kind: 'factory',
    ...over,
  };
}

describe('lib/roadmapFlow.ts partitionByKind()', () => {
  const all = [
    m({ milestoneId: 'phase-1' }),
    m({ milestoneId: 'phase-2' }),
    m({ milestoneId: 'envkit-1', project: 'envkit', kind: 'dogfood' }),
    m({ milestoneId: 'acme-1', project: 'acme', kind: 'product' }),
  ];

  it('shows only product milestones by default', () => {
    expect(partitionByKind(all, false).shown.map((x) => x.milestoneId)).toEqual(['acme-1']);
  });

  it('shows everything when the operator asks for the machinery', () => {
    expect(partitionByKind(all, true).shown).toHaveLength(4);
  });

  /**
   * The D-119 rule applied to a filter: hiding is only honest when the page
   * can say how much it hid. A bare empty diagram is indistinguishable from a
   * roadmap the orchestrator failed to read.
   */
  it('counts what it held back and names the projects it came from', () => {
    const part = partitionByKind(all, false);
    expect(part.hiddenCount).toBe(3);
    expect(part.hiddenProjects).toEqual(['black-smith', 'envkit']);
  });

  it('holds nothing back once internal milestones are shown', () => {
    expect(partitionByKind(all, true).hiddenCount).toBe(0);
  });

  /**
   * A project registered by `smith new` before the kind bullet existed parses
   * to `product` (roadmap.ts's defaultKindFor), so the page's default must be
   * exactly that value and nothing narrower.
   */
  it('treats "product" as the shown kind', () => {
    expect(DEFAULT_ROADMAP_KIND).toBe('product');
  });

  it('holds back a milestone whose kind the client does not recognise', () => {
    const part = partitionByKind([m({ milestoneId: 'x', project: 'p', kind: 'future' })], false);
    expect(part.shown).toEqual([]);
    expect(part.hiddenCount).toBe(1);
  });
});

describe('lib/roadmapFlow.ts roadmapLanes()', () => {
  it('puts one project into a single unlabelled lane, ordered by sequence', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'p2', sequence: 2 }),
      m({ milestoneId: 'p1', sequence: 1 }),
      m({ milestoneId: 'p3', sequence: 3 }),
    ]);
    expect(lanes).toHaveLength(1);
    expect(nth(lanes, 0).project).toBeNull();
    expect(nth(lanes, 0).items.map((x) => x.milestoneId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('splits multiple projects into alphabetical lanes', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'z1', project: 'zeta', sequence: 1 }),
      m({ milestoneId: 'a2', project: 'alpha', sequence: 2 }),
      m({ milestoneId: 'a1', project: 'alpha', sequence: 1 }),
    ]);
    expect(lanes.map((l) => l.project)).toEqual(['alpha', 'zeta']);
    expect(nth(lanes, 0).items.map((x) => x.milestoneId)).toEqual(['a1', 'a2']);
  });

  it('keeps a single lane when the view is already scoped to one project', () => {
    const lanes = roadmapLanes(
      [
        m({ milestoneId: 'a1', project: 'alpha', sequence: 1 }),
        m({ milestoneId: 'z1', project: 'zeta', sequence: 2 }),
      ],
      'alpha',
    );
    expect(lanes).toHaveLength(1);
    expect(nth(lanes, 0).project).toBeNull();
  });

  it('breaks a sequence tie on milestoneId so the layout is deterministic', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'b', sequence: 1 }),
      m({ milestoneId: 'a', sequence: 1 }),
    ]);
    expect(nth(lanes, 0).items.map((x) => x.milestoneId)).toEqual(['a', 'b']);
  });
});

describe('lib/roadmapFlow.ts roadmapFlowNodes()', () => {
  it('lays each lane out left-to-right, one row per lane', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'a1', project: 'alpha', sequence: 1 }),
      m({ milestoneId: 'a2', project: 'alpha', sequence: 2 }),
      m({ milestoneId: 'z1', project: 'zeta', sequence: 1 }),
    ]);
    const nodes = roadmapFlowNodes(lanes);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: MILESTONE_STEP_X, y: 0 },
      { x: 0, y: LANE_HEIGHT },
    ]);
  });

  it('namespaces node ids by project so two projects can share a milestone id', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'phase-1', project: 'alpha' }),
      m({ milestoneId: 'phase-1', project: 'zeta' }),
    ]);
    const ids = roadmapFlowNodes(lanes).map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['alpha::phase-1', 'zeta::phase-1']);
  });

  it('carries the milestone through as node data and wires the handles left→right', () => {
    const nodes = roadmapFlowNodes(roadmapLanes([m({ milestoneId: 'p1', name: 'Phase 1' })]));
    expect(nth(nodes, 0).type).toBe('milestone');
    expect(nth(nodes, 0).data.name).toBe('Phase 1');
    expect(nth(nodes, 0).sourcePosition).toBe('right');
    expect(nth(nodes, 0).targetPosition).toBe('left');
  });
});

describe('lib/roadmapFlow.ts roadmapFlowEdges()', () => {
  it('chains consecutive milestones within a lane and never across lanes', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'a1', project: 'alpha', sequence: 1 }),
      m({ milestoneId: 'a2', project: 'alpha', sequence: 2 }),
      m({ milestoneId: 'z1', project: 'zeta', sequence: 1 }),
    ]);
    const edges = roadmapFlowEdges(lanes);
    expect(edges).toHaveLength(1);
    expect(nth(edges, 0).source).toBe('alpha::a1');
    expect(nth(edges, 0).target).toBe('alpha::a2');
    expect(nth(edges, 0).id).toBe('alpha::a1->alpha::a2');
  });

  it('animates only the edge into the milestone work has reached', () => {
    const lanes = roadmapLanes([
      m({ milestoneId: 'p1', sequence: 1, status: 'completed' }),
      m({ milestoneId: 'p2', sequence: 2, status: 'in-progress' }),
      m({ milestoneId: 'p3', sequence: 3, status: 'planned' }),
    ]);
    const edges = roadmapFlowEdges(lanes);
    expect(edges.map((e) => e.animated)).toEqual([true, false]);
  });

  it('emits no edges for a lane holding a single milestone', () => {
    expect(roadmapFlowEdges(roadmapLanes([m({ milestoneId: 'only' })]))).toEqual([]);
  });

  it('draws straight connectors rather than the default bezier', () => {
    // Operator directive (round 8): "hiển thị line nối giữa các node thẳng".
    // A milestone node is content-sized — goal length and mini-timeline row
    // count differ per milestone — so two nodes in the same lane share a top
    // edge but rarely a height. Their handles therefore sit at different y,
    // and Vue Flow's default bezier renders that offset as a visible S-curve.
    const lanes = roadmapLanes([
      m({ milestoneId: 'p1', sequence: 1 }),
      m({ milestoneId: 'p2', sequence: 2 }),
      m({ milestoneId: 'p3', sequence: 3 }),
    ]);
    expect(roadmapFlowEdges(lanes).map((e) => e.type)).toEqual(['straight', 'straight']);
  });
});
