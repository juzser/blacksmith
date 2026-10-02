// DS4 S2 — pure swimlane geometry + the two zero-task audit fixes (items 6/7
// from the UI audit). Kept out of RoadmapSwimlane.vue/EpicBlock.vue so the
// bar-state and layout math run under vitest's node environment, same split
// as the old roadmapFlow.ts this slice replaces.
import type { MilestoneProgress } from './api.js';

export type BarState = 'past' | 'now' | 'upcoming' | 'not-scheduled';

export interface DateRange {
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Spec's four bar states, in the order the signed-off spec lists them.
 * `finishedAt` set is always `past` regardless of `startedAt` — a task that
 * finished is done, whatever its start looked like. `startedAt` in the
 * future (relative to `now`) is `upcoming`; otherwise it is the one `now`
 * state, ongoing. Both null is `not-scheduled`.
 */
export function barState(range: DateRange, now: Date): BarState {
  if (range.finishedAt !== null) return 'past';
  if (range.startedAt !== null) {
    return Date.parse(range.startedAt) > now.getTime() ? 'upcoming' : 'now';
  }
  return 'not-scheduled';
}

export interface SwimlaneBar {
  state: BarState;
  /** Percent (0-100) from the lane's left edge. */
  left: number;
  /** Percent (0-100) width. */
  width: number;
}

export interface SwimlaneRow {
  kind: 'phase' | 'epic';
  id: string;
  label: string;
  /** null only for `not-scheduled` — the component renders the text label, not a track. */
  bar: SwimlaneBar | null;
}

export interface MonthMark {
  /** e.g. "Jan". */
  label: string;
  /** Percent (0-100) from the lane's left edge. */
  left: number;
}

export interface Swimlane {
  rows: SwimlaneRow[];
  /** Percent (0-100) position of the now-line. */
  nowOffset: number;
  /** Month labels along the same time axis as the bars (fix round 1 #1). */
  months: MonthMark[];
}

const UPCOMING_STUB_WIDTH = 8;
const MIN_BAR_WIDTH = 2;
const FALLBACK_SPAN_MS = 1000 * 60 * 60 * 24 * 30;

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fix round 1 #2 — the raw end (latest of any date, or `now`) used to equal
 * `now` whenever nothing ran past today, pinning the now-line to exactly
 * 100% (the right edge, under the overflow clip). Padding the end out to the
 * end of next month guarantees `end > now` always, so the now-line — and the
 * months axis — always has room past today.
 */
function paddedEnd(rawEnd: number, now: Date): number {
  const endOfNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1) - 1;
  return Math.max(rawEnd, endOfNextMonth);
}

function computeBounds(ranges: DateRange[], now: Date): { start: number; end: number } {
  const times: number[] = [now.getTime()];
  for (const r of ranges) {
    if (r.startedAt !== null) times.push(Date.parse(r.startedAt));
    if (r.finishedAt !== null) times.push(Date.parse(r.finishedAt));
  }
  let start = Math.min(...times);
  let end = paddedEnd(Math.max(...times), now);
  if (start === end) {
    start -= FALLBACK_SPAN_MS;
    end += FALLBACK_SPAN_MS;
  }
  return { start, end };
}

function pct(t: number, bounds: { start: number; end: number }): number {
  return ((t - bounds.start) / (bounds.end - bounds.start)) * 100;
}

/** Fix round 1 #1 — one mark per calendar month boundary within bounds,
 * same axis the bars and now-line are computed against. UTC throughout so
 * the labels don't drift between a dev machine's zone and CI's. */
export function buildMonthMarks(bounds: { start: number; end: number }): MonthMark[] {
  const marks: MonthMark[] = [];
  const startDate = new Date(bounds.start);
  let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  while (cursor <= bounds.end) {
    const d = new Date(cursor);
    marks.push({
      label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      left: clamp(pct(cursor, bounds)),
    });
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return marks;
}

function computeBar(
  range: DateRange,
  state: BarState,
  bounds: { start: number; end: number },
  now: Date,
): SwimlaneBar | null {
  if (state === 'not-scheduled') return null;
  if (state === 'past') {
    const startT = range.startedAt !== null ? Date.parse(range.startedAt) : bounds.start;
    const left = clamp(pct(startT, bounds));
    const right = clamp(pct(Date.parse(range.finishedAt as string), bounds));
    return { state, left, width: Math.max(right - left, MIN_BAR_WIDTH) };
  }
  const left = clamp(pct(Date.parse(range.startedAt as string), bounds));
  if (state === 'now') {
    const right = clamp(pct(now.getTime(), bounds));
    return { state, left, width: Math.max(right - left, MIN_BAR_WIDTH) };
  }
  // upcoming — no end date is known yet, so the bar is a fixed-width stub.
  return { state, left, width: Math.min(UPCOMING_STUB_WIDTH, 100 - left) };
}

/** One row per phase, plus one indented sub-row per epic (always visible —
 * S2 has no collapse toggle), in `epicIds` order, dates looked up from the
 * milestone's own `epics` array (DS4 S5a). */
export function buildSwimlane(milestones: MilestoneProgress[], now: Date): Swimlane {
  const ranges: DateRange[] = [];
  for (const m of milestones) {
    ranges.push({ startedAt: m.startedAt, finishedAt: m.finishedAt });
    for (const e of m.epics) ranges.push(e);
  }
  const bounds = computeBounds(ranges, now);
  const rows: SwimlaneRow[] = [];
  for (const m of milestones) {
    const phaseRange = { startedAt: m.startedAt, finishedAt: m.finishedAt };
    rows.push({
      kind: 'phase',
      id: m.milestoneId,
      label: m.name,
      bar: computeBar(phaseRange, barState(phaseRange, now), bounds, now),
    });
    for (const epicId of m.epicIds) {
      const dates = m.epics.find((e) => e.epicId === epicId) ?? {
        epicId,
        startedAt: null,
        finishedAt: null,
      };
      rows.push({
        kind: 'epic',
        id: epicId,
        label: epicId,
        bar: computeBar(dates, barState(dates, now), bounds, now),
      });
    }
  }
  return { rows, nowOffset: clamp(pct(now.getTime(), bounds)), months: buildMonthMarks(bounds) };
}

/** A project with no declared phases: one row per epic, no dates available
 * at this layer (selectableEpics only carries ids) — every row reads
 * `not-scheduled` until a phase exists to carry its own dates. */
export function buildEpicOnlySwimlane(epics: readonly string[]): Swimlane {
  return {
    rows: epics.map((id) => ({ kind: 'epic' as const, id, label: id, bar: null })),
    nowOffset: 50,
    months: [],
  };
}

/** Audit item 6: no `tasksTotal || 1` — zero tasks reads as a real sentence,
 * never a bogus "0 of 1" or a percentage over a denominator that was never real. */
export function taskCountLabel(total: number, completed: number): string {
  if (total === 0) return 'No tasks tracked';
  return `${completed} of ${total} tasks done`;
}

/** Audit item 7: the empty state is a measurement over real counts, not a
 * hardcoded sentence — true only once both the phase and epic-only sources
 * have actually answered empty. */
export function hasRoadmapContent(
  milestones: MilestoneProgress[],
  epics: readonly string[],
): boolean {
  return milestones.length > 0 || epics.length > 0;
}
