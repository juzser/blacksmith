// DS4 S3 §2 — pure classification + card data for WaveList.vue, built from
// FlowGraph.waves (node ids per wave) and isTaskOver (lib/taxonomy.ts). Kept
// out of the .vue file so the three-way past/current/upcoming split and the
// dependency-line composition are unit-tested under vitest's node
// environment rather than resting on a mount.
import type { FlowEdge, FlowGraph, FlowNode, MilestoneProgress } from './api.js';
import { edgeWords } from './edgeWords.js';
import { isTaskOver, type KitTone } from './taxonomy.js';

export type WaveKind = 'past' | 'current' | 'upcoming';

export interface WaveTaskInfo {
  taskId: string;
  title: string | null;
  taskStatus: string;
  workingAgentRole: string | null;
  /** §2's "After T3 · uses its output" line, or null with no incoming edge. */
  dependencyLine: string | null;
}

export interface EpicStatus {
  statusTone: KitTone;
  statusLabel: string;
}

/**
 * DS4 S2/S3 — one epic's status tone/label, derived from its FlowGraph.
 * Shared between phase mode's `epicSections` and epic mode's header (spec
 * §1: "a status Tag, from the same status tone/label logic as
 * `epicSections` and `selectedEpicData`"). The label is always one of a
 * fixed three, so the tone keys off that label rather than off whichever
 * task status happens to be driving `anyInFlight` (fix round 2 #3).
 */
export function epicStatusFromFlow(flow: Pick<FlowGraph, 'nodes'>): EpicStatus {
  const total = flow.nodes.length;
  const completed = flow.nodes.filter((n) => isTaskOver(n.taskStatus)).length;
  const anyInFlight = flow.nodes.some((n) => !isTaskOver(n.taskStatus));
  const status =
    total === 0 ? 'todo' : completed === total ? 'completed' : anyInFlight ? 'in-progress' : 'todo';
  return {
    statusTone: status === 'completed' ? 'done' : status === 'in-progress' ? 'progress' : 'neutral',
    statusLabel:
      status === 'completed' ? 'Done' : status === 'in-progress' ? 'In progress' : 'To do',
  };
}

/**
 * DS4 S3 fix round 1 finding 3 — epic mode's Tag used the project-filter
 * value directly, which is empty under "All projects"; `FlowGraph` carries
 * no project field to fall back on either. Derived instead from the
 * roadmap's own milestones, each of which already names the project its
 * epics belong to. Falls back to the given value only when no milestone
 * lists this epic (a closed epic the current roadmap no longer shows).
 */
export function epicProject(
  milestones: Pick<MilestoneProgress, 'project' | 'epicIds'>[],
  epicId: string,
  fallback: string | null,
): string | null {
  const milestone = milestones.find((m) => m.epicIds.includes(epicId));
  return milestone?.project ?? fallback;
}

export interface WaveInfo {
  /** 0-based position in graph.waves. */
  index: number;
  /** Total number of waves, for "Wave N of M". */
  total: number;
  kind: WaveKind;
  doneCount: number;
  taskCount: number;
  /** done/taskCount as a whole-number percent, 0 for an empty wave. */
  pct: number;
  tasks: WaveTaskInfo[];
}

/**
 * §2's "After T3 · uses its output" line, composed the way kanban.ts's
 * dependencyChainText() names one dependency and tails the rest as "+N
 * more". Null when the node has no incoming edge (no line is shown).
 */
export function dependencyLine(edges: FlowEdge[], taskId: string): string | null {
  const incoming = edges.filter((e) => e.task === taskId);
  const first = incoming[0];
  if (!first) return null;
  const rest = incoming.length - 1;
  const extra = rest > 0 ? ` +${rest} more` : '';
  return `After ${first.dependsOn} · ${edgeWords(first.edgeType)}${extra}`;
}

function taskInfo(node: FlowNode | undefined, taskId: string, edges: FlowEdge[]): WaveTaskInfo {
  return {
    taskId,
    title: node?.title ?? null,
    taskStatus: node?.taskStatus ?? 'todo',
    workingAgentRole: node?.workingAgentRole ?? null,
    dependencyLine: dependencyLine(edges, taskId),
  };
}

/**
 * §2's three-way split: a wave is `past` when every one of its nodes is
 * over, `current` is the lowest-indexed wave that is not past, and every
 * wave after it is `upcoming`. An empty graph (no waves) returns `[]`.
 */
export function buildWaveList(graph: Pick<FlowGraph, 'waves' | 'nodes' | 'edges'>): WaveInfo[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.taskId, n]));
  const total = graph.waves.length;
  const isPast = graph.waves.map(
    (ids) => ids.length > 0 && ids.every((id) => isTaskOver(nodeById.get(id)?.taskStatus ?? '')),
  );
  const currentIndex = isPast.findIndex((past) => !past);

  return graph.waves.map((ids, index) => {
    const kind: WaveKind = isPast[index] ? 'past' : index === currentIndex ? 'current' : 'upcoming';
    const doneCount = ids.filter((id) => isTaskOver(nodeById.get(id)?.taskStatus ?? '')).length;
    return {
      index,
      total,
      kind,
      doneCount,
      taskCount: ids.length,
      pct: ids.length > 0 ? Math.round((doneCount / ids.length) * 100) : 0,
      tasks: ids.map((id) => taskInfo(nodeById.get(id), id, graph.edges)),
    };
  });
}
