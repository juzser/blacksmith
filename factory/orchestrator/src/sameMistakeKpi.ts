// The consumer architecture §9.7's "key quality KPI" never had.
//
// The escalation ladder is real (severity.ts), the tag is real
// (`judgment.same-mistake`), and `analytics()` in db/queries.ts already counts
// a per-day rate. None of that is a KPI. §9.7 states a target — "monotonically
// decreasing" — and nothing in the factory reads the number against it, or
// refuses to read it when the number could not have been anything but zero.
//
// THE THREE ZEROS. The same-mistake rate reads 0.00 in three different worlds,
// and the event log distinguishes none of them:
//
//   1. Nothing repeated. The one we want.
//   2. No lesson in the corpus can escalate anything. `findMatchingLesson`
//      skips an entry with no `finding_category` before consulting its claim
//      path, and skips `agent-role`/`case-type` scopes entirely. As of the
//      phase-9 compile, all fourteen approved lessons are in one or both
//      buckets, so the numerator is pinned at zero by the corpus rather than by
//      the factory's conduct.
//   3. The gate ran without lessons at all. `--lessons` is optional
//      (cli.ts:1110, `flags.lessons ? parseLessons(...) : []`), and a gate
//      holding an empty list decides `same_mistake: false` for every finding.
//
// So this report carries the instrument next to the reading, the way
// budgetAlarm.ts carries `projectedTokens` next to `measuredTokens`. `reach`
// is what the corpus could ever detect; `lessons_escalating` on each intake is
// what the gate actually held at the time. An intake that recorded neither is a
// hole, and a hole that could hide a repeat means `unverifiable` rather than
// clean — D-35's lesson, now compiled: never ask a component for a fact it has
// no instrument to measure; it will not refuse, it will estimate, and the
// estimate will look exactly like data.
//
// THE ASYMMETRY, mirrored from budgetAlarm.ts. There, every hole in the record
// could only make the bill bigger, so a threshold crossing was a fact and a
// non-crossing was a claim about the record. Here it runs the other way and
// lands in the same place: a *recorded repeat* is a fact, because the
// instrument had to fire to record it, so a rise survives any hole in the log.
// Zero repeats is a claim about the instrument, and is only honest once the
// instrument is shown to have been able to fire at all.
import type { StoredEvent } from './events.js';
import { canEscalate, isFileScoped, type LessonRule } from './severity.js';

/**
 * Where the rate stands against §9.7's target.
 *
 * Ordered by how much they bind: `off-target` is a fact about the factory's
 * conduct, the rest are facts about the record.
 */
export type SameMistakeStatus =
  /** Two or more measured windows, non-increasing throughout, instrument sound. */
  | 'on-target'
  /** The rate rose between measured windows. Outranks every hole. */
  | 'off-target'
  /** The instrument is sound but one window is not a trend. */
  | 'insufficient-history'
  /** Nothing measured, or nothing that *could* have been measured. */
  | 'unverifiable';

/**
 * What the compiled corpus could ever detect, independent of what it did.
 *
 * `withoutCategory` and `nonFileScoped` overlap deliberately — an `agent-role`
 * entry with no category is in both — because they are two separate reasons an
 * entry is inert, and collapsing them hides one of the two fixes.
 */
export interface LessonReach {
  total: number;
  /** Entries the gate can match a finding against: category AND file-scoped. */
  escalating: number;
  /** Entries naming no `finding_category`, whatever their scope. */
  withoutCategory: number;
  /** Entries whose scope never participates in the per-file match. */
  nonFileScoped: number;
  /** The finding categories a repeat could actually be detected in. */
  categoriesCovered: string[];
}

/** One day the gate decided at least one finding. */
export interface SameMistakeWindow {
  day: string;
  /** `severity-decisions` events on this day. */
  intakes: number;
  /** Of those, the ones that decided nothing at all. */
  emptyIntakes: number;
  decisions: number;
  sameMistake: number;
  rate: number;
  /** Second trace: `quorum-decision` events triggered by `same-mistake`. */
  quorumSameMistake: number;
  /**
   * Decisions this day made by a gate the log cannot show was equipped.
   *
   * They are still in `decisions` — dropping them would invent a different
   * denominator — but a window holding any of them reads low by construction
   * and cannot serve as the baseline a rise is measured against.
   */
  uninstrumentedDecisions: number;
}

export interface SameMistakeKpiReport {
  sessionId: string;
  reach: LessonReach;
  /**
   * Measured windows only, oldest first. A day whose every intake decided
   * nothing has no denominator and therefore no rate — it is in `silentDays`,
   * not here. `analytics()` buckets such a day anyway and reports 0.00, which
   * makes a gate that saw no findings read identically to a gate that saw
   * findings and cleared them all (D-31: silence is not assent).
   */
  windows: SameMistakeWindow[];
  /** Days that recorded intakes but never a decision. */
  silentDays: string[];
  totalDecisions: number;
  totalSameMistake: number;
  /** Intakes whose payload does not say how many escalating lessons the gate held. */
  intakesWithoutInstrumentRecord: number;
  /** Intakes the log shows ran with no escalating lesson loaded. */
  blindIntakes: number;
  /** Days where the quorum trace saw a same mistake the decisions trace did not. */
  traceDisagreements: string[];
  /** Every consecutive measured pair non-increasing — §9.7's target, read literally. */
  monotonic: boolean;
  /** Days the rate rose from a baseline whose every decision was instrumented. */
  provenRises: string[];
  /** Days the rate rose from a baseline that could not have recorded a repeat. */
  unprovenRises: string[];
  status: SameMistakeStatus;
  detail: string;
  ok: boolean;
}

export interface SameMistakeKpiOptions {
  sessionId: string;
}

export function lessonReach(lessons: readonly LessonRule[]): LessonReach {
  const categories = new Set<string>();
  let escalating = 0;
  let withoutCategory = 0;
  let nonFileScoped = 0;

  for (const lesson of lessons) {
    if (canEscalate(lesson)) {
      escalating += 1;
      categories.add(lesson.category);
      continue;
    }
    // Both reasons are recorded for an entry that has both, because each is a
    // different edit to make the entry live.
    if (lesson.category === '') withoutCategory += 1;
    if (!isFileScoped(lesson)) nonFileScoped += 1;
  }

  return {
    total: lessons.length,
    escalating,
    withoutCategory,
    nonFileScoped,
    categoriesCovered: [...categories].sort(),
  };
}

interface DayAccumulator {
  intakes: number;
  emptyIntakes: number;
  decisions: number;
  sameMistake: number;
  quorumSameMistake: number;
  uninstrumentedDecisions: number;
}

function emptyDay(): DayAccumulator {
  return {
    intakes: 0,
    emptyIntakes: 0,
    decisions: 0,
    sameMistake: 0,
    quorumSameMistake: 0,
    uninstrumentedDecisions: 0,
  };
}

interface DecisionsPayload {
  decisions?: Array<{ same_mistake?: boolean }>;
  lessons_escalating?: number;
}

function decide(
  windows: readonly SameMistakeWindow[],
  provenRises: readonly string[],
  reach: LessonReach,
  holes: boolean,
): SameMistakeStatus {
  // Order matters, and it is the asymmetry in code. A repeat the log already
  // recorded proves the instrument fired, so a rise between measured windows
  // survives any hole elsewhere in the record rather than being downgraded to
  // "we cannot tell" by an unrelated unknown. Only when nothing has risen does
  // the quality of the instrument decide between "on target" and "unreadable".
  //
  // "Elsewhere" is the load-bearing word, and it used to be unchecked: a rise
  // has two operands, and a hole in the earlier one is not elsewhere. Only a
  // rise the baseline could have contradicted is a fact about the work (D-174).
  if (provenRises.length > 0) return 'off-target';
  if (reach.escalating === 0) return 'unverifiable';
  if (holes) return 'unverifiable';
  if (windows.length === 0) return 'unverifiable';
  if (windows.length === 1) return 'insufficient-history';
  return 'on-target';
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function describe(report: Omit<SameMistakeKpiReport, 'detail' | 'ok'>): string {
  const head =
    `${report.totalSameMistake} same-mistake of ${report.totalDecisions} decision(s) across ` +
    `${report.windows.length} measured window(s)` +
    (report.windows.length > 0
      ? ` — ${report.windows.map((w) => `${w.day} ${pct(w.rate)}`).join(', ')}.`
      : '.');

  const holes: string[] = [];
  if (report.reach.escalating === 0) {
    holes.push(
      `none of the ${report.reach.total} compiled lesson(s) can escalate anything ` +
        `(${report.reach.withoutCategory} name no finding_category, ` +
        `${report.reach.nonFileScoped} are not file-scoped), so a zero here is a property ` +
        `of the corpus, not of the work`,
    );
  }
  if (report.intakesWithoutInstrumentRecord > 0) {
    holes.push(
      `${report.intakesWithoutInstrumentRecord} intake(s) record no lessons_escalating count, ` +
        `so the log does not say whether the gate held any lesson at all`,
    );
  }
  if (report.blindIntakes > 0) {
    holes.push(
      `${report.blindIntakes} intake(s) ran with no escalating lesson loaded and could not ` +
        `have found a repeat`,
    );
  }
  if (report.unprovenRises.length > 0) {
    holes.push(
      `the rate rose on ${report.unprovenRises.join(', ')} from a window whose decisions came ` +
        `from a gate that could not have recorded a repeat, so the rise measures the corpus ` +
        `rather than the work`,
    );
  }
  if (report.traceDisagreements.length > 0) {
    holes.push(
      `the quorum trace saw a same mistake the severity trace did not on ` +
        `${report.traceDisagreements.join(', ')}`,
    );
  }
  if (report.silentDays.length > 0) {
    holes.push(
      `${report.silentDays.length} day(s) recorded intakes but no decision ` +
        `(${report.silentDays.join(', ')}) and are excluded rather than counted as 0%`,
    );
  }
  const holeText = holes.length > 0 ? ` Holes: ${holes.join('; ')}.` : '';

  switch (report.status) {
    case 'off-target':
      return (
        `${head} The rate rose between measured windows, against §9.7's monotonically ` +
        `decreasing target. The window it rose from recorded every decision under a gate ` +
        `equipped to escalate, so this stands whatever else the record is missing.${holeText}`
      );
    case 'insufficient-history':
      return (
        `${head} One measured window is a reading, not a trend; §9.7's target is about ` +
        `direction and needs a second.${holeText}`
      );
    case 'unverifiable':
      return report.unprovenRises.length > 0
        ? `${head} The rate rose, but not from a window that could have read anything else: ` +
            `the baseline's zeros belong to the corpus, not to the work.${holeText}`
        : `${head} Nothing here shows the rate rising, but neither can it show the rate ` +
            `falling: the number could not have been other than what it is.${holeText}`;
    default:
      return (
        `${head} Non-increasing across every measured window, against a corpus that can ` +
        `escalate ${report.reach.escalating} lesson(s) in ` +
        `${report.reach.categoriesCovered.join(', ')}.`
      );
  }
}

/**
 * The same-mistake rate read as §9.7's KPI: is it going down, and is the number
 * one that could have gone up.
 *
 * Read-only over the log. Fails the report on anything but `on-target` — an
 * unreadable instrument is not a clean one, for the same reason
 * dispatchAudit.ts emits a synthetic check for an empty pair set.
 */
export function checkSameMistakeKpi(
  events: readonly StoredEvent[],
  lessons: readonly LessonRule[],
  options: SameMistakeKpiOptions,
): SameMistakeKpiReport {
  const reach = lessonReach(lessons);
  const byDay = new Map<string, DayAccumulator>();
  const dayFor = (day: string): DayAccumulator => {
    let acc = byDay.get(day);
    if (acc === undefined) {
      acc = emptyDay();
      byDay.set(day, acc);
    }
    return acc;
  };

  let intakesWithoutInstrumentRecord = 0;
  let blindIntakes = 0;

  for (const { record } of events) {
    const day = record.ts.slice(0, 10);

    if (record.event_type === 'quorum-decision') {
      if (record.payload.trigger_reason === 'same-mistake') dayFor(day).quorumSameMistake += 1;
      continue;
    }
    if (record.event_type !== 'severity-decisions') continue;

    const payload = record.payload as DecisionsPayload;
    const acc = dayFor(day);
    acc.intakes += 1;

    const loaded = payload.lessons_escalating;
    if (typeof loaded !== 'number') intakesWithoutInstrumentRecord += 1;
    else if (loaded === 0) blindIntakes += 1;

    const decisions = payload.decisions ?? [];
    if (decisions.length === 0) acc.emptyIntakes += 1;
    let fired = false;
    for (const decision of decisions) {
      acc.decisions += 1;
      if (decision.same_mistake) {
        acc.sameMistake += 1;
        fired = true;
      }
    }
    // What this intake's decisions are worth as a baseline. A recorded repeat
    // is its own attestation — `same_mistake: true` cannot be written by a gate
    // holding nothing to escalate against — so an intake that fired needs no
    // separate count, which is why an event predating `lessons_escalating` can
    // still anchor a rise. An intake that did not fire needs the count, and
    // without it its zeros are the corpus's zeros, not the work's.
    const shownEquipped = fired || (typeof loaded === 'number' && loaded > 0);
    if (!shownEquipped) acc.uninstrumentedDecisions += decisions.length;
  }

  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  const windows: SameMistakeWindow[] = days
    .filter(([, acc]) => acc.decisions > 0)
    .map(([day, acc]) => ({
      day,
      intakes: acc.intakes,
      emptyIntakes: acc.emptyIntakes,
      decisions: acc.decisions,
      sameMistake: acc.sameMistake,
      rate: acc.sameMistake / acc.decisions,
      quorumSameMistake: acc.quorumSameMistake,
      uninstrumentedDecisions: acc.uninstrumentedDecisions,
    }));

  // A day with intakes but no decision at all. Not a rate of zero — there is no
  // denominator to divide by, and inventing one is the whole bug.
  const silentDays = days
    .filter(([, acc]) => acc.decisions === 0 && acc.intakes > 0)
    .map(([day]) => day);

  // The quorum trace is written by a different code path (gate.ts:487) and only
  // when an external provider is enabled, so it is normally silent. What it can
  // never be is *more* clean than the severity trace: a same-mistake quorum on
  // a day the decisions call clean means one of the two traces is wrong.
  const traceDisagreements = days
    .filter(([, acc]) => acc.quorumSameMistake > acc.sameMistake)
    .map(([day]) => day);

  // Split every rise by whether the window it rose FROM could have read
  // anything but low. A baseline holding decisions no gate was equipped to
  // escalate is one of the three zeros in this file's header, and a difference
  // taken against it measures the corpus rather than the factory's conduct —
  // the substitution `reach` already refuses for the level, refused here for
  // the trend.
  const provenRises: string[] = [];
  const unprovenRises: string[] = [];
  for (let i = 1; i < windows.length; i += 1) {
    const window = windows[i] as SameMistakeWindow;
    const previous = windows[i - 1] as SameMistakeWindow;
    if (window.rate <= previous.rate) continue;
    if (previous.uninstrumentedDecisions === 0) provenRises.push(window.day);
    else unprovenRises.push(window.day);
  }

  const monotonic = provenRises.length === 0 && unprovenRises.length === 0;

  const totalDecisions = windows.reduce((sum, w) => sum + w.decisions, 0);
  const totalSameMistake = windows.reduce((sum, w) => sum + w.sameMistake, 0);

  const holes =
    intakesWithoutInstrumentRecord > 0 ||
    blindIntakes > 0 ||
    unprovenRises.length > 0 ||
    traceDisagreements.length > 0;

  const partial: Omit<SameMistakeKpiReport, 'detail' | 'ok'> = {
    sessionId: options.sessionId,
    reach,
    windows,
    silentDays,
    totalDecisions,
    totalSameMistake,
    intakesWithoutInstrumentRecord,
    blindIntakes,
    traceDisagreements,
    monotonic,
    provenRises,
    unprovenRises,
    status: decide(windows, provenRises, reach, holes),
  };

  return { ...partial, detail: describe(partial), ok: partial.status === 'on-target' };
}
