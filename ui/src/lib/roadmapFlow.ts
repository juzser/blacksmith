// Pure layout for RoadmapPage's VueFlow diagram (operator directive,
// Phase 6b round 6: "Trong dashboard, phần roadmap, display theo dạng
// VueFlow"). Kept out of the .vue file so it is unit-testable under
// ui/vitest.config.ts's `environment: node` — the same split FlowPage's
// wave layout would have wanted.
//
// The honest shape of the graph: `MilestoneProgress` has `sequence` and no
// dependency field anywhere in the API (api.ts:58-72), so the only edge this
// data can justify is "the next milestone in sequence". That is a chain, not
// a DAG, and it is drawn as one — one lane per project, left to right. If a
// real milestone-dependency edge ever lands in the API, it belongs here.
import type { MilestoneProgress } from './api.js';

/** Horizontal distance between two milestones in the same lane (node width + gutter). */
export const MILESTONE_STEP_X = 360;
/** Vertical distance between project lanes. */
export const LANE_HEIGHT = 340;

export interface RoadmapLane {
  /** `null` when the whole view is one project — no lane label is drawn. */
  project: string | null;
  items: MilestoneProgress[];
}

export interface RoadmapFlowNode {
  id: string;
  type: 'milestone';
  position: { x: number; y: number };
  data: MilestoneProgress;
  sourcePosition: 'right';
  targetPosition: 'left';
}

export interface RoadmapFlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * Operator directive (round 8): "hiển thị line nối giữa các node thẳng".
   * Vue Flow's default edge is a bezier, which only looks straight when both
   * handles share a y. Milestone nodes are content-sized (goal length,
   * mini-timeline row count), so within a lane they share a TOP edge but not
   * a height — the handles sit at different y and the bezier bows into an
   * S-curve. `straight` draws the connector as the direct line between the
   * two handles instead.
   */
  type: 'straight';
  animated: boolean;
}

/** Node ids must be unique across the whole graph; two projects may each own a "phase-1". */
export function roadmapNodeId(m: MilestoneProgress): string {
  return `${m.project}::${m.milestoneId}`;
}

function bySequence(a: MilestoneProgress, b: MilestoneProgress): number {
  return a.sequence - b.sequence || a.milestoneId.localeCompare(b.milestoneId);
}

/**
 * Group milestones into the rows of the diagram. Mirrors RoadmapPage's old
 * `groupedMilestones`: one unlabelled lane when the view is already scoped to
 * a project or only one project is present, otherwise one lane per project in
 * alphabetical order.
 */
export function roadmapLanes(
  milestones: MilestoneProgress[],
  scopedProject?: string | null,
): RoadmapLane[] {
  const distinct = new Set(milestones.map((m) => m.project));
  if (scopedProject || distinct.size <= 1) {
    return [{ project: null, items: [...milestones].sort(bySequence) }];
  }
  return [...distinct].sort().map((project) => ({
    project,
    items: milestones.filter((m) => m.project === project).sort(bySequence),
  }));
}

export function roadmapFlowNodes(lanes: RoadmapLane[]): RoadmapFlowNode[] {
  return lanes.flatMap((lane, laneIdx) =>
    lane.items.map((m, idx) => ({
      id: roadmapNodeId(m),
      type: 'milestone' as const,
      position: { x: idx * MILESTONE_STEP_X, y: laneIdx * LANE_HEIGHT },
      data: m,
      sourcePosition: 'right' as const,
      targetPosition: 'left' as const,
    })),
  );
}

/**
 * One edge per adjacent pair inside a lane. The edge *into* the milestone
 * work has reached is animated — that is the one place on the page where
 * motion carries information ("this is where the factory is now"); animating
 * every edge would just be decoration.
 */
export function roadmapFlowEdges(lanes: RoadmapLane[]): RoadmapFlowEdge[] {
  const edges: RoadmapFlowEdge[] = [];
  for (const lane of lanes) {
    for (let i = 1; i < lane.items.length; i++) {
      const prev = lane.items[i - 1];
      const next = lane.items[i];
      if (!prev || !next) continue;
      edges.push({
        id: `${roadmapNodeId(prev)}->${roadmapNodeId(next)}`,
        source: roadmapNodeId(prev),
        target: roadmapNodeId(next),
        type: 'straight',
        animated: next.status === 'in-progress',
      });
    }
  }
  return edges;
}
