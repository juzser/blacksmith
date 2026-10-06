// UI spec Part 2 — the Roadmap split into one section per project, each
// windowed to its recent lanes: 1 before the current lane, the current lane,
// and the 2 after it, with an "earlier" and a "later" disclosure for the
// rest. Pure, like roadmapSwimlane.ts beside it, so the current-lane rule and
// the window cut run under vitest's node environment; RoadmapPage.vue and
// RoadmapProjectSection.vue are wiring.
import type { MilestoneProgress, ProjectOverviewSummary } from './api.js';
import {
  buildEpicOnlySwimlane,
  buildSwimlane,
  type Swimlane,
  type SwimlaneRow,
} from './roadmapSwimlane.js';

/** `expandedRows.ts` scope for the two disclosures, ids from `windowExpandId`. */
export const ROADMAP_WINDOW_SCOPE = 'roadmap-window';

const LANES_BEFORE = 1;
const LANES_AFTER = 2;
/** A phase-less section windows its epics only past this many (spec §2.1). */
const EPIC_WINDOW_MIN = 4;

export type WindowSide = 'earlier' | 'later';

export interface CurrentLane {
  /** -1 only with no lanes at all. */
  index: number;
  /** Every lane completed: the current lane is the last one, with no later side. */
  allDone: boolean;
}

export interface LaneWindow<T> {
  /** Hidden until the "earlier" disclosure opens, in declared order. */
  earlier: T[];
  visible: T[];
  /** Hidden until the "later" disclosure opens, in declared order. */
  later: T[];
  current: T | null;
}

/**
 * The operator's rule: the lane holding an actively running epic
 * (`overview.epicsActivelyRunning`), else the first lane by `sequence` that
 * is not completed, else (all done) the last lane. `lanes` must already be in
 * `sequence` order (`groupByProject`).
 */
export function currentLaneIndex(
  lanes: readonly MilestoneProgress[],
  activeEpics: readonly string[],
): CurrentLane {
  if (lanes.length === 0) return { index: -1, allDone: false };
  const running = lanes.findIndex((m) => m.epicIds.some((e) => activeEpics.includes(e)));
  if (running >= 0) return { index: running, allDone: false };
  const open = lanes.findIndex((m) => m.status !== 'completed');
  if (open >= 0) return { index: open, allDone: false };
  return { index: lanes.length - 1, allDone: true };
}

/** 1 before + current + 2 after; all done keeps only the last lane. Never pads. */
export function cutWindow<T>(items: readonly T[], current: CurrentLane): LaneWindow<T> {
  const at = items[current.index];
  if (at === undefined) return { earlier: [], visible: [], later: [], current: null };
  if (current.allDone) {
    return { earlier: items.slice(0, -1), visible: [at], later: [], current: at };
  }
  const start = Math.max(0, current.index - LANES_BEFORE);
  const end = Math.min(items.length, current.index + LANES_AFTER + 1);
  return {
    earlier: items.slice(0, start),
    visible: items.slice(start, end),
    later: items.slice(end),
    current: at,
  };
}

export function disclosureLabel(side: WindowSide, hidden: number, expanded: boolean): string {
  if (expanded) return `Show fewer ${side} lanes`;
  return `Show ${hidden} ${side} ${hidden === 1 ? 'lane' : 'lanes'}`;
}

/** The section heading's muted count; null with no phases (never "0 of 0"). */
export function doneCountLabel(lanes: readonly MilestoneProgress[]): string | null {
  if (lanes.length === 0) return null;
  const done = lanes.filter((m) => m.status === 'completed').length;
  if (done === lanes.length)
    return `All ${lanes.length} ${lanes.length === 1 ? 'phase' : 'phases'} done`;
  return `${done} of ${lanes.length} ${lanes.length === 1 ? 'phase' : 'phases'} done`;
}

export function windowExpandId(project: string, side: WindowSide): string {
  return `${project}:${side}`;
}

/** The hidden-lanes container's id, the disclosure's `aria-controls`. */
export function windowRegionId(project: string, side: WindowSide): string {
  return `rm-window-${project.replace(/[^A-Za-z0-9_-]/g, '-')}-${side}`;
}

/** The phone picker's id: on phone the disclosures widen its options, so they control it. */
export function windowPickerId(project: string): string {
  return `rm-window-${project.replace(/[^A-Za-z0-9_-]/g, '-')}-picker`;
}

export interface ProjectLanes {
  project: string;
  lanes: MilestoneProgress[];
}

/** Projects in first-seen order, each one's lanes in `sequence` order. */
export function groupByProject(milestones: readonly MilestoneProgress[]): ProjectLanes[] {
  const byProject = new Map<string, MilestoneProgress[]>();
  for (const m of milestones) {
    const list = byProject.get(m.project) ?? [];
    list.push(m);
    byProject.set(m.project, list);
  }
  return [...byProject].map(([project, lanes]) => ({
    project,
    lanes: [...lanes].sort((a, b) => a.sequence - b.sequence),
  }));
}

/** Newest start or finish across a project's lanes and their epics; null with no dates. */
function lastActivity(lanes: readonly MilestoneProgress[]): number | null {
  let latest: number | null = null;
  const consider = (iso: string | null) => {
    if (iso === null) return;
    const t = Date.parse(iso);
    if (latest === null || t > latest) latest = t;
  };
  for (const m of lanes) {
    consider(m.startedAt);
    consider(m.finishedAt);
    for (const e of m.epics) {
      consider(e.startedAt);
      consider(e.finishedAt);
    }
  }
  return latest;
}

interface SectionBase {
  project: string;
  /** The heading text: the project, or "Epics" for the unscoped epic-only fallback. */
  title: string;
  /** Holds an epic in `overview.epicsActivelyRunning`; sorts first, opens on phone. */
  running: boolean;
  activity: number | null;
}

export type RoadmapSection =
  | (SectionBase & {
      kind: 'phase';
      countLabel: string | null;
      window: LaneWindow<MilestoneProgress>;
    })
  | (SectionBase & {
      kind: 'epic';
      countLabel: null;
      window: LaneWindow<string>;
    });

/** Running first, then newest activity (none last), ties alphabetical (spec §2.1). */
function compareSections(a: RoadmapSection, b: RoadmapSection): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (a.activity !== b.activity) {
    if (a.activity === null) return 1;
    if (b.activity === null) return -1;
    return b.activity - a.activity;
  }
  return a.project.localeCompare(b.project);
}

/** A phase-less project's epics as lanes: current = the running one, else the first. */
function epicSection(
  project: string,
  title: string,
  epicIds: readonly string[],
  activeEpics: readonly string[],
): RoadmapSection {
  const runningIndex = epicIds.findIndex((e) => activeEpics.includes(e));
  const current = { index: Math.max(0, runningIndex), allDone: false };
  const window =
    epicIds.length > EPIC_WINDOW_MIN
      ? cutWindow(epicIds, current)
      : { earlier: [], visible: [...epicIds], later: [], current: epicIds[current.index] ?? null };
  return {
    kind: 'epic',
    project,
    title,
    running: runningIndex >= 0,
    activity: null,
    countLabel: null,
    window,
  };
}

/**
 * One section per project. With no declared phase at all the page keeps its
 * epic-only swimlane as one section over `epics` (`selectableEpics`: in-flight
 * first, then closed newest first). Unscoped, a project that declares no
 * phase but has epics in flight (`overview.projects`) gets an epic section of
 * its own; `projects` is undefined when the page is scoped to one project.
 */
export function buildRoadmapSections(
  milestones: readonly MilestoneProgress[],
  epics: readonly string[],
  activeEpics: readonly string[],
  projects: readonly ProjectOverviewSummary[] | undefined,
  projectFilter: string | null,
): RoadmapSection[] {
  if (milestones.length === 0) {
    if (epics.length === 0) return [];
    return [epicSection(projectFilter ?? 'epics', projectFilter ?? 'Epics', epics, activeEpics)];
  }
  const sections: RoadmapSection[] = groupByProject(milestones).map(({ project, lanes }) => ({
    kind: 'phase',
    project,
    title: project,
    running: lanes.some((m) => m.epicIds.some((e) => activeEpics.includes(e))),
    activity: lastActivity(lanes),
    countLabel: doneCountLabel(lanes),
    window: cutWindow(lanes, currentLaneIndex(lanes, activeEpics)),
  }));
  const declared = new Set(sections.map((s) => s.project));
  for (const summary of projects ?? []) {
    if (declared.has(summary.project) || summary.epicsInFlight.length === 0) continue;
    sections.push(
      epicSection(summary.project, summary.project, summary.epicsInFlight, activeEpics),
    );
  }
  return sections.sort(compareSections);
}

export interface RoadmapPick {
  phaseId: string | null;
  epicId: string | null;
}

function laneHolds(lane: MilestoneProgress | string, pick: RoadmapPick): boolean {
  if (typeof lane === 'string') return pick.epicId === lane;
  return (
    pick.phaseId === lane.milestoneId ||
    (pick.epicId !== null && lane.epicIds.includes(pick.epicId))
  );
}

/** The hidden side a deep-linked phase (or the phase of a deep-linked epic) sits on; null when shown or elsewhere. */
export function selectionSide(section: RoadmapSection, pick: RoadmapPick): WindowSide | null {
  const { earlier, later } = section.window as LaneWindow<MilestoneProgress | string>;
  if (earlier.some((lane) => laneHolds(lane, pick))) return 'earlier';
  if (later.some((lane) => laneHolds(lane, pick))) return 'later';
  return null;
}

/** True when the selection lives in this section, shown or hidden. */
export function sectionHolds(section: RoadmapSection, pick: RoadmapPick): boolean {
  const { earlier, visible, later } = section.window as LaneWindow<MilestoneProgress | string>;
  return [...earlier, ...visible, ...later].some((lane) => laneHolds(lane, pick));
}

/** One lane on screen: its head row (a phase, or a bare epic) and the epic rows under it. */
export interface LaneGroup {
  head: SwimlaneRow;
  rows: SwimlaneRow[];
}

/** A run of lanes; `id` names a side's container (the disclosure's `aria-controls`), null for the window. */
export interface LaneRegion {
  id: string | null;
  lanes: LaneGroup[];
}

/** Each phase row with the epic rows after it; an epic row with no phase before it is a lane of its own. */
export function groupLanes(rows: readonly SwimlaneRow[]): LaneGroup[] {
  const lanes: LaneGroup[] = [];
  for (const row of rows) {
    const last = lanes[lanes.length - 1];
    if (row.kind === 'epic' && last && last.head.kind === 'phase') last.rows.push(row);
    else lanes.push({ head: row, rows: [row] });
  }
  return lanes;
}

export interface SectionView {
  /** The shown lanes only, so the time axis spans what is on screen. */
  swimlane: Swimlane;
  /** [earlier container,] the window, [later container] — a side only when it hides lanes. */
  regions: LaneRegion[];
  currentLane: string | null;
}

export function sectionSwimlane(
  section: RoadmapSection,
  expanded: { earlier: boolean; later: boolean },
  now: Date,
): SectionView {
  const w = section.window as LaneWindow<MilestoneProgress | string>;
  const shownEarlier = expanded.earlier ? w.earlier : [];
  const shownLater = expanded.later ? w.later : [];
  const swimlane =
    section.kind === 'phase'
      ? buildSwimlane([...shownEarlier, ...w.visible, ...shownLater] as MilestoneProgress[], now)
      : buildEpicOnlySwimlane([...shownEarlier, ...w.visible, ...shownLater] as string[]);
  // buildSwimlane emits one phase row per lane, in order, so the lane groups
  // split back into the three runs by count.
  const lanes = groupLanes(swimlane.rows);
  const regions: LaneRegion[] = [];
  if (w.earlier.length > 0) {
    regions.push({
      id: windowRegionId(section.project, 'earlier'),
      lanes: lanes.slice(0, shownEarlier.length),
    });
  }
  regions.push({
    id: null,
    lanes: lanes.slice(shownEarlier.length, shownEarlier.length + w.visible.length),
  });
  if (w.later.length > 0) {
    regions.push({
      id: windowRegionId(section.project, 'later'),
      lanes: lanes.slice(shownEarlier.length + w.visible.length),
    });
  }
  const current = w.current;
  const currentLane =
    current === null ? null : typeof current === 'string' ? current : current.milestoneId;
  return { swimlane, regions, currentLane };
}

/** The phone picker's options: every shown lane head, in order. */
export function laneOptions(
  regions: readonly LaneRegion[],
): Array<{ value: string; label: string }> {
  return regions.flatMap((r) =>
    r.lanes.map((lane) => ({ value: lane.head.id, label: lane.head.label })),
  );
}
