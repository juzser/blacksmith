// DS4 S3 §2 — pure classification + card data for WaveList.vue, built from
// FlowGraph.waves (node ids per wave) and isTaskOver (lib/taxonomy.ts). Kept
// out of the .vue file so the three-way past/current/upcoming split and the
// dependency-line composition are unit-tested under vitest's node
// environment rather than resting on a mount.
import type {
  FlowEdge,
  FlowGraph,
  FlowNode,
  MilestoneProgress,
  EpicStatus as ServerEpicStatus,
  StatusCounts,
} from './api.js';
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
      status === 'completed' ? 'Done' : status === 'in-progress' ? 'In progress' : 'Todo',
  };
}

export interface StackedBarSegment {
  tone: 'done' | 'review' | 'progress';
  value: number;
}

export interface StackedBar {
  segments: StackedBarSegment[];
  ariaLabel: string;
}

/**
 * DS4 S5c §1 — `statusCounts` -> `kit/ProgressBar.vue`'s stacked segments.
 * `superseded` is excluded from the total (ds-review.html's mock draws only
 * done/review/in-progress, with the remaining, uncoloured track standing for
 * todo). Values are percentages of the total, not raw counts, so they line
 * up with `ProgressBar`'s own `denom = max(sum, 100)` sizing.
 */
export function statusCountsBar(counts: StatusCounts): StackedBar {
  const total = counts.done + counts.review + counts.inProgress + counts.todo;
  const pctOf = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const donePct = pctOf(counts.done);
  const restRemains = counts.review + counts.inProgress + counts.todo > 0;
  const ariaLabel = restRemains
    ? `${counts.done} of ${total} tasks done (${donePct}%); the rest in review, in progress or todo`
    : `${counts.done} of ${total} tasks done (${donePct}%)`;
  return {
    segments: [
      { tone: 'done', value: donePct },
      { tone: 'review', value: pctOf(counts.review) },
      { tone: 'progress', value: pctOf(counts.inProgress) },
    ],
    ariaLabel,
  };
}

const SERVER_EPIC_STATUS: Record<ServerEpicStatus, EpicStatus> = {
  done: { statusTone: 'done', statusLabel: 'Done' },
  review: { statusTone: 'review', statusLabel: 'In review' },
  in_progress: { statusTone: 'progress', statusLabel: 'In progress' },
  todo: { statusTone: 'todo', statusLabel: 'Todo' },
};

/**
 * DS4 S5c §2 — `epics[].status` (server-computed) onto the same tone/label
 * set `epicStatusFromFlow` uses, plus `review` (the flow-derived guess has no
 * such bucket). Callers fall back to `epicStatusFromFlow` when the server
 * gives no status at all.
 */
export function epicStatusFromServerStatus(status: ServerEpicStatus): EpicStatus {
  return SERVER_EPIC_STATUS[status];
}

/** DS4 S5c §4 — only an `https:` `prUrl` renders the "Open ... PR" button. */
export function isHttpsUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
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

/**
 * DS4 S4 R1 — the phase (milestone) that lists this epic, for the phone
 * epic-mode back link ("← {phase name}"). Null when no phase lists it (the
 * same "closed epic" edge case epicProject() above already handles), which
 * the component reads as "render nothing".
 */
export function epicPhase(
  milestones: Pick<MilestoneProgress, 'milestoneId' | 'name' | 'epicIds'>[],
  epicId: string,
): { milestoneId: string; name: string } | null {
  const milestone = milestones.find((m) => m.epicIds.includes(epicId));
  return milestone ? { milestoneId: milestone.milestoneId, name: milestone.name } : null;
}

/**
 * DS4 S5c §2/§3/§4 — the `EpicDates` row (`status`, `statusCounts`, `prUrl`,
 * `sourcePrompt`) `/api/roadmap` already attaches to the milestone that
 * lists this epic. Null for an epic no current milestone lists, the same
 * "closed epic" edge case `epicProject`/`epicPhase` above handle.
 */
export function epicDatesFor(
  milestones: Pick<MilestoneProgress, 'epicIds' | 'epics'>[],
  epicId: string,
): MilestoneProgress['epics'][number] | null {
  for (const milestone of milestones) {
    const found = milestone.epics.find((e) => e.epicId === epicId);
    if (found) return found;
  }
  return null;
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
 * DS4 S4 §1 — the phone phase-mode row's status line: "In progress · 9 of
 * 14 · wave 3 of 4 running", "Done · 6 of 6" or "No tasks tracked".
 * `tasksTotal`/`tasksCompleted` null means the per-epic flow fetch is still
 * in flight (phase mode's `epicSections`, EpicBlock.vue); `failed` is that
 * same fetch's error state. R7: never a made-up count — each branch here
 * only reads fields the caller already has for real.
 */
export function mobileEpicStatusLine(input: {
  statusLabel: string;
  tasksTotal: number | null;
  tasksCompleted: number | null;
  failed?: boolean;
  waves: WaveInfo[];
}): string {
  if (input.failed) return "Could not load this epic's tasks.";
  if (input.tasksTotal === null || input.tasksCompleted === null) return 'Loading';
  if (input.tasksTotal === 0) return 'No tasks tracked';
  const current = input.waves.find((w) => w.kind === 'current');
  const wavePart = current ? ` · wave ${current.index + 1} of ${current.total} running` : '';
  return `${input.statusLabel} · ${input.tasksCompleted} of ${input.tasksTotal}${wavePart}`;
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
