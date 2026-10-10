// DS4 S2 — pure swimlane geometry + the two zero-task audit fixes (items 6/7
// from the UI audit). Kept out of RoadmapSwimlane.vue/EpicBlock.vue so the
// bar-state and layout math run under vitest's node environment, same split
// as the old roadmapFlow.ts this slice replaces.
import type { EpicStatus, MilestoneProgress, StatusCounts } from './api.js';

export type BarState = 'past' | 'now' | 'upcoming' | 'not-scheduled';

/** The bar's colour: how the work stands, not where it sits in time. */
export type BarTone = 'done' | 'review' | 'in-progress' | 'todo';

const TONE_BY_STATUS: Record<EpicStatus, BarTone> = {
  done: 'done',
  review: 'review',
  in_progress: 'in-progress',
  todo: 'todo',
};

/**
 * A phase's status from its own task counts. Mirrors the orchestrator's
 * `epicStatusFromCounts` (db/queries.ts) rule for an epic: all live tasks
 * done is `done`; otherwise any review or in-progress is `review` when
 * nothing is in progress or todo, else `in_progress`; otherwise some done
 * with the rest to do is `in_progress`, and nothing done is `todo`.
 */
export function phaseStatusFromCounts(counts: StatusCounts, tasksTotal: number): EpicStatus {
  const live = tasksTotal - counts.superseded;
  if (live > 0 && counts.done === live) return 'done';
  if (counts.review > 0 || counts.inProgress > 0) {
    return counts.inProgress === 0 && counts.todo === 0 ? 'review' : 'in_progress';
  }
  return counts.done > 0 ? 'in_progress' : 'todo';
}

/**
 * A phase bar's tone. The declared milestone status wins, so the bar agrees
 * with the header's "N of M phases done" (`doneCountLabel`, roadmapWindow.ts)
 * and the phase badge (`milestoneStatusLabel` / `milestoneStatusKitTone`,
 * taxonomy.ts). Task counts only split an in-progress phase into review vs
 * in progress.
 */
export function phaseTone(m: MilestoneProgress): BarTone {
  if (m.status === 'completed') return 'done';
  if (m.status !== 'in-progress') return 'todo';
  const live = m.tasksTotal - m.statusCounts.superseded;
  if (live > 0 && phaseStatusFromCounts(m.statusCounts, m.tasksTotal) === 'review') return 'review';
  return 'in-progress';
}

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
  tone: BarTone;
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
/** Padding either side of the real data span, as a fraction of that span. */
const BOUNDS_PADDING_FRACTION = 0.15;

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fix round 2 #1 — the axis used to be forced to span at least two calendar
 * months regardless of the actual data, so a real project running for days
 * or weeks collapsed to a sliver next to that forced width and every bar hit
 * `MIN_BAR_WIDTH`. The domain now fits the real earliest-start/latest-
 * end-or-now span, padded by a fraction of that span on both sides, so a
 * short project still reads as proportional bars.
 *
 * Fix round 1 #2's invariant still holds: the padding is strictly positive
 * whenever there is any real span at all (and the fallback span otherwise),
 * so `end` is always past `now` and the now-line never pins to the right
 * edge.
 */
function computeBounds(ranges: DateRange[], now: Date): { start: number; end: number } {
  const times: number[] = [now.getTime()];
  for (const r of ranges) {
    if (r.startedAt !== null) times.push(Date.parse(r.startedAt));
    if (r.finishedAt !== null) times.push(Date.parse(r.finishedAt));
  }
  const rawStart = Math.min(...times);
  const rawEnd = Math.max(...times);
  const span = rawEnd - rawStart;
  if (span === 0) return { start: rawStart - FALLBACK_SPAN_MS, end: rawEnd + FALLBACK_SPAN_MS };
  const padding = span * BOUNDS_PADDING_FRACTION;
  return { start: rawStart - padding, end: rawEnd + padding };
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
    // The 1st of the opening month can sit before the window opens; no mark
    // for a boundary the window does not contain.
    if (cursor < bounds.start) {
      cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    marks.push({
      label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      left: clamp(pct(cursor, bounds)),
    });
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return marks;
}

const MINUTE_MS = 1000 * 60;
const HOUR_MS = MINUTE_MS * 60;
const DAY_MS = HOUR_MS * 24;
const WEEK_MS = DAY_MS * 7;

export type TickUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';

/** Fix round 2 #1 — now that the axis fits the real span, a short project
 * (days/weeks) needs finer ticks than a calendar month, or it would show
 * zero or one month mark.
 *
 * Fix round 3 #2 — a fixture that spans only minutes (e.g. a demo clock
 * ticking seconds-per-event) fell into the day bucket and rendered one
 * calendar-day tick for its whole, sub-hour lane. `minute`/`hour` units
 * cover anything under a day so the axis always has at least 3 ticks. */
export function chooseTickUnit(bounds: { start: number; end: number }): TickUnit {
  const span = bounds.end - bounds.start;
  if (span <= HOUR_MS * 2) return 'minute';
  if (span <= DAY_MS) return 'hour';
  if (span <= DAY_MS * 21) return 'day';
  if (span <= DAY_MS * 90) return 'week';
  return 'month';
}

/** Largest candidate step (ms) that still guarantees >=3 ticks across
 * `span` (a step at most span/2 means floor(span/step)+1 >= 3). Falls back
 * to the smallest candidate for a span too short for even that. */
function pickStep(span: number, candidatesMs: readonly number[]): number {
  let chosen = candidatesMs[0] as number;
  for (const c of candidatesMs) {
    if (c <= span / 2) chosen = c;
  }
  return chosen;
}

function buildTimeMarks(bounds: { start: number; end: number }, stepMs: number): MonthMark[] {
  const marks: MonthMark[] = [];
  let cursor = bounds.start;
  while (cursor <= bounds.end) {
    marks.push({
      label: new Date(cursor).toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }),
      left: clamp(pct(cursor, bounds)),
    });
    cursor += stepMs;
  }
  return marks;
}

function buildFixedStepMarks(bounds: { start: number; end: number }, stepMs: number): MonthMark[] {
  const marks: MonthMark[] = [];
  const startDate = new Date(bounds.start);
  let cursor = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  );
  while (cursor <= bounds.end) {
    // The first midnight can sit before the window opens; a label clamped to
    // the track edge would then claim a tick it is not over.
    if (cursor < bounds.start) {
      cursor += stepMs;
      continue;
    }
    marks.push({
      label: new Date(cursor).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      left: clamp(pct(cursor, bounds)),
    });
    cursor += stepMs;
  }
  return marks;
}

/** Dispatches to day/week/month ticks by span — the production entry point
 * `buildSwimlane` calls this instead of `buildMonthMarks` directly. */
export function buildAxisMarks(bounds: { start: number; end: number }): MonthMark[] {
  const unit = chooseTickUnit(bounds);
  const span = bounds.end - bounds.start;
  if (unit === 'minute') {
    return buildTimeMarks(
      bounds,
      pickStep(span, [MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS]),
    );
  }
  if (unit === 'hour') {
    return buildTimeMarks(
      bounds,
      pickStep(span, [HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS]),
    );
  }
  if (unit === 'day') return buildFixedStepMarks(bounds, DAY_MS);
  if (unit === 'week') return buildFixedStepMarks(bounds, WEEK_MS);
  return buildMonthMarks(bounds);
}

function computeBar(
  range: DateRange,
  state: BarState,
  tone: BarTone,
  bounds: { start: number; end: number },
  now: Date,
): SwimlaneBar | null {
  if (state === 'not-scheduled') return null;
  if (state === 'past') {
    const startT = range.startedAt !== null ? Date.parse(range.startedAt) : bounds.start;
    const left = clamp(pct(startT, bounds));
    const right = clamp(pct(Date.parse(range.finishedAt as string), bounds));
    return { state, tone, left, width: Math.max(right - left, MIN_BAR_WIDTH) };
  }
  const left = clamp(pct(Date.parse(range.startedAt as string), bounds));
  if (state === 'now') {
    const right = clamp(pct(now.getTime(), bounds));
    return { state, tone, left, width: Math.max(right - left, MIN_BAR_WIDTH) };
  }
  // upcoming — no end date is known yet, so the bar is a fixed-width stub.
  return { state, tone, left, width: Math.min(UPCOMING_STUB_WIDTH, 100 - left) };
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
      bar: computeBar(phaseRange, barState(phaseRange, now), phaseTone(m), bounds, now),
    });
    for (const epicId of m.epicIds) {
      const found = m.epics.find((e) => e.epicId === epicId);
      const dates = found ?? { epicId, startedAt: null, finishedAt: null };
      rows.push({
        kind: 'epic',
        id: epicId,
        label: epicId,
        bar: computeBar(
          dates,
          barState(dates, now),
          TONE_BY_STATUS[found?.status ?? 'todo'],
          bounds,
          now,
        ),
      });
    }
  }
  return { rows, nowOffset: clamp(pct(now.getTime(), bounds)), months: buildAxisMarks(bounds) };
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
