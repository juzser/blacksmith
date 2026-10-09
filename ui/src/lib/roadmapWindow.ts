// UI spec Part 2 — the Roadmap split into one section per project, each
// windowed to its recent lanes: 1 before the current lane, the current lane,
// and the 2 after it, with an "earlier" and a "later" disclosure for the
// rest. Pure, like roadmapSwimlane.ts beside it, so the current-lane rule and
// the window cut run under vitest's node environment; RoadmapPage.vue and
// RoadmapProjectSection.vue are wiring.
import { isActiveEpic, isActiveProject, isActiveProjectName } from './activeScope.js';
import type { ActiveScopeResult, MilestoneProgress, ProjectOverviewSummary } from './api.js';
import {
  buildEpicOnlySwimlane,
  buildSwimlane,
  type Swimlane,
  type SwimlaneRow,
} from './roadmapSwimlane.js';
import { HOME_STORE_ID, type StoreRef, storeKey } from './storeKey.js';

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

/** Injective DOM-safe spelling of a project key: every char outside [A-Za-z0-9-] becomes `_<hex>_`. */
function idPart(project: string): string {
  return project.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/** The hidden-lanes container's id, the disclosure's `aria-controls`. */
export function windowRegionId(project: string, side: WindowSide): string {
  return `rm-window-${idPart(project)}-${side}`;
}

/** The phone picker's id: on phone the disclosures widen its options, so they control it. */
export function windowPickerId(project: string): string {
  return `rm-window-${idPart(project)}-picker`;
}

export interface ProjectLanes {
  project: string;
  /** The store the lanes came from; absent on a single-store payload. */
  store?: StoreRef;
  lanes: MilestoneProgress[];
}

/**
 * Projects in first-seen order, each one's lanes in `sequence` order. A label
 * is not unique across stores, so a project of another store is its own group.
 */
export function groupByProject(milestones: readonly MilestoneProgress[]): ProjectLanes[] {
  const groups = new Map<string, ProjectLanes>();
  for (const m of milestones) {
    const key = storeKey(m, m.project);
    const group = groups.get(key) ?? { project: m.project, store: m.store, lanes: [] };
    group.lanes.push(m);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    lanes: [...g.lanes].sort((a, b) => a.sequence - b.sequence),
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
  /** The store the section reads from; absent on a single-store payload. */
  store?: StoreRef;
  /** Names the section across stores (`storeKey`): the bare project when there is no store. */
  key: string;
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
  store?: StoreRef,
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
    store,
    key: storeKey({ store }, project),
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
    return [epicSection(projectFilter ?? '', projectFilter ?? 'Epics', epics, activeEpics)];
  }
  const sections: RoadmapSection[] = groupByProject(milestones).map(
    ({ project, store, lanes }) => ({
      kind: 'phase',
      project,
      store,
      key: storeKey({ store }, project),
      title: project,
      running: lanes.some((m) => m.epicIds.some((e) => activeEpics.includes(e))),
      activity: lastActivity(lanes),
      countLabel: doneCountLabel(lanes),
      window: cutWindow(lanes, currentLaneIndex(lanes, activeEpics)),
    }),
  );
  const declared = new Set(sections.map((s) => s.key));
  for (const summary of projects ?? []) {
    if (declared.has(storeKey(summary, summary.project)) || summary.epicsInFlight.length === 0)
      continue;
    sections.push(
      epicSection(
        summary.project,
        summary.project,
        summary.epicsInFlight,
        activeEpics,
        summary.store,
      ),
    );
  }
  // Two sections that report one label are told apart by their store's name.
  const seen = new Map<string, number>();
  for (const s of sections) seen.set(s.title, (seen.get(s.title) ?? 0) + 1);
  for (const s of sections) {
    if (s.store && (seen.get(s.title) ?? 0) > 1) s.title = `${s.title} · ${s.store.label}`;
  }
  return sections.sort(compareSections);
}

/**
 * Active scope: keep the sections a live CLI session is on. A section with a
 * store matches by store + project, and its epics by store + epic id, because
 * two stores can hold the same label or epic id and only one of them has the
 * session. A section with no store is read as the home store's, except a
 * phase-less epic section: its epic ids come from the overview, which merges
 * every store by id, so it matches by project name and by epic id in any
 * store (which is also how the unscoped "Epics" fallback, with no project,
 * qualifies). A null or unmeasured scope is "unknown", not "nothing active":
 * the sections come back as they are. `keepProject` names the section the
 * user is reading: it stays listed when its project turns quiet (Sessions'
 * rule), in its place.
 */
export function filterActiveSections(
  sections: readonly RoadmapSection[],
  scope: ActiveScopeResult | null,
  keepProject: string | null = null,
): RoadmapSection[] {
  if (scope?.measured !== true) return [...sections];
  return sections.filter((s) => {
    if (keepProject !== null && s.key === keepProject) return true;
    const merged = s.kind === 'epic' && s.store === undefined;
    if (s.project !== '') {
      if (merged ? isActiveProjectName(scope, s.project) : isActiveProject(scope, s, s.project)) {
        return true;
      }
    }
    if (s.kind !== 'epic') return false;
    const { earlier, visible, later } = s.window;
    return [...earlier, ...visible, ...later].some((id) =>
      merged ? scope.epics.some((e) => e.epicId === id) : isActiveEpic(scope, s, id),
    );
  });
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

/**
 * The epics a live CLI session is on, keyed by store and id (an epic id can
 * repeat between stores). `known` is false while the read is missing or
 * unmeasured: that is "unknown", never "nothing is live".
 */
export interface LiveEpics {
  known: boolean;
  keys: ReadonlySet<string>;
  /** The same epics by bare id, for a section that merges several stores. */
  ids: ReadonlySet<string>;
}

export function liveEpicKeys(scope: ActiveScopeResult | null): LiveEpics {
  if (scope?.measured !== true) return { known: false, keys: new Set(), ids: new Set() };
  return {
    known: true,
    keys: new Set(scope.epics.map((e) => `${e.storeId}:${e.epicId}`)),
    ids: new Set(scope.epics.map((e) => e.epicId)),
  };
}

/** `anyStore`: the caller's section merges stores, so the id alone is the key. */
export function isLiveEpic(
  live: LiveEpics | null | undefined,
  storeId: string,
  epicId: string,
  anyStore = false,
): boolean {
  if (!live?.known) return false;
  return anyStore ? live.ids.has(epicId) : live.keys.has(`${storeId}:${epicId}`);
}

/** The store a section's lanes belong to, and whether it spans several (a store-less epic section). */
export function sectionStore(section: RoadmapSection): { storeId: string; anyStore: boolean } {
  return {
    storeId: section.store?.id ?? HOME_STORE_ID,
    anyStore: section.store === undefined && section.kind === 'epic',
  };
}

export interface SectionView {
  /** The shown lanes only, so the time axis spans what is on screen. */
  swimlane: Swimlane;
  /** [earlier container,] the window, [later container] — a side only when it hides lanes. */
  regions: LaneRegion[];
  /** The lane the window is cut around (`currentLaneIndex`). */
  currentLane: string | null;
  /** Lane heads marked Current: those holding a live epic, else the single `currentLane`. */
  currentLanes: string[];
  /** Shown epic rows a live session is on. */
  liveEpics: string[];
}

export function sectionSwimlane(
  section: RoadmapSection,
  expanded: { earlier: boolean; later: boolean },
  now: Date,
  live?: LiveEpics | null,
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
      id: windowRegionId(section.key, 'earlier'),
      lanes: lanes.slice(0, shownEarlier.length),
    });
  }
  regions.push({
    id: null,
    lanes: lanes.slice(shownEarlier.length, shownEarlier.length + w.visible.length),
  });
  if (w.later.length > 0) {
    regions.push({
      id: windowRegionId(section.key, 'later'),
      lanes: lanes.slice(shownEarlier.length + w.visible.length),
    });
  }
  const current = w.current;
  const currentLane =
    current === null ? null : typeof current === 'string' ? current : current.milestoneId;
  const { storeId, anyStore } = sectionStore(section);
  const liveEpics: string[] = [];
  const liveHeads: string[] = [];
  for (const group of regions.flatMap((r) => r.lanes)) {
    const held = group.rows.filter(
      (r) => r.kind === 'epic' && isLiveEpic(live, storeId, r.id, anyStore),
    );
    liveEpics.push(...held.map((r) => r.id));
    if (held.length > 0) liveHeads.push(group.head.id);
  }
  // Nothing live here (or the read is unknown): keep the single "where are we" mark.
  const currentLanes = liveHeads.length > 0 ? liveHeads : currentLane === null ? [] : [currentLane];
  return { swimlane, regions, currentLane, currentLanes, liveEpics };
}

/** The phone picker's options: every shown lane head, in order. */
export function laneOptions(
  regions: readonly LaneRegion[],
  current: string | readonly string[] | null = null,
): Array<{ value: string; label: string }> {
  const marked = typeof current === 'string' ? [current] : (current ?? []);
  return regions.flatMap((r) =>
    r.lanes.map((lane) => ({
      value: lane.head.id,
      label: marked.includes(lane.head.id) ? `${lane.head.label} (current)` : lane.head.label,
    })),
  );
}
