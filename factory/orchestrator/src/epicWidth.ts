import type { StoredEvent } from './events.js';
import { UNOBSERVED_HINT, type WaveVerdict } from './waveConcurrency.js';

/**
 * Does this factory build in parallel, or has every epic it closed been narrow?
 *
 * The wave commands each answer half a question and all four share a boundary:
 * `wave schedule` says how wide a plan could run, `wave check` admits a wave,
 * `wave audit` reads one log back to see whether the admission was honoured,
 * and `epic close` writes that reading permanently into `epic-closed`. Every
 * one of them is scoped to the session the operator happens to be standing in.
 * The claim this repo actually makes — that a project here is built by many
 * agents working a plan's tasks at the same time — is a claim about the
 * workshop, and nothing could be asked it.
 *
 * So this folds closes rather than waves. Two reasons, and the second is the
 * one that matters:
 *
 * 1. A close outlives its lineage. The `wave-admitted` and `dispatch_decision`
 *    events behind it sit in whichever session ran the build, and an operator
 *    asking about the factory is not standing in any of them. The width was
 *    copied into the close precisely so it would still be there afterwards.
 *
 * 2. Re-deriving cannot see a close that measured nothing. `auditWaveConcurrency`
 *    reports the waves that exist; it has no way to report an epic whose close
 *    carried no width at all — an older close from before the field, or one
 *    whose record could not be read. Those closes are the honest answer to
 *    "how much of this do you actually know", and a summary that silently
 *    omitted them would report a factory of three measured epics exactly as
 *    confidently as a factory of three hundred.
 */

const CLOSED_EVENT_TYPE = 'epic-closed';

/**
 * What the closes say about one epic.
 *
 * The five wave verdicts, read off the record rather than recomputed, plus
 * three answers no wave can give:
 *
 * - `unwaved`    — the close measured, and this epic never cut a wave at all.
 *                  A real thing to know and never a fault: a one-task epic has
 *                  no wave to cut, and a hand-run close is allowed to exist.
 * - `unmeasured` — the close carried no width. Nobody looked; this is not a
 *                  narrow epic, it is an unknown one.
 * - `unreadable` — the close carried a width that could not be read, either
 *                  because `epic close` already reported a problem folding it
 *                  or because the payload is not the shape it should be.
 */
export type EpicWidthVerdict = WaveVerdict | 'unwaved' | 'unmeasured' | 'unreadable';

/** The verdicts an epic can be graded on, widest first — see {@link gradeOf}. */
const BEST_FIRST: readonly WaveVerdict[] = [
  'parallel',
  'partial',
  'serialized',
  'single',
  'unobserved',
];

const ALL_VERDICTS: readonly EpicWidthVerdict[] = [
  ...BEST_FIRST,
  'unwaved',
  'unmeasured',
  'unreadable',
];

/** One closed epic, as its close records the width. */
export interface ClosedEpicWidth {
  epicId: string;
  /** The `epic-closed` event's id — the handle for this close. */
  eventId: string;
  closedAt: string;
  /** Where the close was written, not where the waves ran. */
  sessionId: string;
  project: string | null;
  /** 'verdict' | 'operator-override', as the close attributed itself. */
  closedBy: string;
  machineVerdict: string | null;
  verdict: EpicWidthVerdict;
  /** Waves admitted under this epic, as the close counted them. */
  waves: number;
  /** How many waves came back with each verdict, as recorded. */
  byVerdict: Record<WaveVerdict, number>;
  widest: { declared: number; observed: number };
  /** The admitted waves the log held no dispatch for, by `wave-admitted` id. */
  unobserved: string[];
  /** Why the width could not be read, or null when it could. */
  problem: string | null;
}

export interface EpicWidthSummary {
  /** Every closed epic, newest close first. */
  epics: ClosedEpicWidth[];
  /** How many epics reached each verdict. Keyed at zero, for D-126's reason. */
  verdicts: Record<EpicWidthVerdict, number>;
  /** The widest wave any closed epic admitted, against the widest ever run. */
  widest: { declared: number; observed: number };
  /** Epics whose record holds a wave admitted wide that ran one task at a time. */
  serialized: string[];
  /** Epics whose record holds a wave the log shows no work for. */
  unobserved: string[];
  /** Epics whose close carried no width, or one that could not be read. */
  unmeasured: string[];
  /** Empty when there is nothing to say; see the two hint constants. */
  hint: string;
  /** 1 on a serialized epic, 2 when nothing could be judged, else 0. */
  exitCode: 0 | 1 | 2;
}

/**
 * Said when no close carried a width anybody could read.
 *
 * The distinction this hint exists to protect is the one an exit code cannot
 * carry: "every epic closed narrow" and "no epic was ever measured" are
 * opposite states of knowledge, and a factory that has never measured itself
 * must not be able to read as a healthy one.
 */
export const UNMEASURED_HINT =
  'No close read here carried a width. Either these epics were closed before `smith epic close` ' +
  'recorded one, or the closes were written by hand — close a current epic with `smith epic ' +
  'close`, or read a live log back with `smith wave audit --session <id>`.';

/** The payload shape `epicSummaryPayload` projects; every key optional here. */
interface RecordedWidth {
  waves?: unknown;
  verdicts?: unknown;
  widest?: unknown;
  unobserved?: unknown;
  problem?: unknown;
}

interface ClosedPayload {
  epic_id?: unknown;
  closed_by?: unknown;
  machine_verdict?: unknown;
  summary?: { concurrency?: unknown } | unknown;
}

/** Nothing was recorded, or nothing readable was. */
function blank(verdict: 'unmeasured' | 'unreadable', problem: string | null) {
  return {
    verdict,
    waves: 0,
    byVerdict: Object.fromEntries(BEST_FIRST.map((v) => [v, 0])) as Record<WaveVerdict, number>,
    widest: { declared: 0, observed: 0 },
    unobserved: [] as string[],
    problem,
  };
}

function countsFrom(raw: unknown): Record<WaveVerdict, number> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const counts = {} as Record<WaveVerdict, number>;
  for (const verdict of BEST_FIRST) {
    const n = source[verdict];
    // A missing key is not read as zero. The close projects all five even at
    // zero (D-126), so an absent one means this is not a width record at all,
    // and defaulting it would turn a malformed payload into a confident count.
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    counts[verdict] = n;
  }
  return counts;
}

function widthFrom(raw: unknown): { declared: number; observed: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { declared, observed } = raw as Record<string, unknown>;
  if (typeof declared !== 'number' || typeof observed !== 'number') return null;
  return { declared, observed };
}

/**
 * The epic's verdict is the BEST any of its waves reached, not the worst.
 *
 * The question this answers is whether the epic ever ran wide. An epic that
 * ran three waves in parallel and one serially is the factory working, and
 * grading it by its narrowest wave would report every real build as a failure
 * — which is how a signal becomes a constant and then becomes noise. The
 * serial wave is not thereby hidden: `EpicWidthSummary.serialized` names the
 * epic and the exit code still fails on it. The verdict summarises the epic;
 * it does not speak for every wave inside it.
 */
function gradeOf(counts: Record<WaveVerdict, number>, waves: number): EpicWidthVerdict {
  if (waves === 0) return 'unwaved';
  for (const verdict of BEST_FIRST) if (counts[verdict] > 0) return verdict;
  // Unreachable: every wave carries one of the five. Reported rather than
  // guessed, because a count that adds up to nothing is a malformed record.
  return 'unwaved';
}

/** Read one close's recorded width, or say why it could not be read. */
function widthOf(payload: ClosedPayload) {
  const summary = payload.summary;
  const raw =
    typeof summary === 'object' && summary !== null
      ? (summary as { concurrency?: unknown }).concurrency
      : undefined;

  // Absent and explicitly null are the same answer — nobody measured — and
  // they are BOTH different from a record of zero waves. An older close
  // predating the field has no key; a close that measured and found no wave
  // projects `waves: 0`. Collapsing those would let the factory's unmeasured
  // history read as a history of epics that simply never cut a wave.
  if (raw === undefined || raw === null) return blank('unmeasured', null);
  if (typeof raw !== 'object') {
    return blank('unreadable', `epic-width.malformed-record: concurrency is not an object`);
  }

  const record = raw as RecordedWidth;
  const counts = countsFrom(record.verdicts);
  const widest = widthFrom(record.widest);
  if (typeof record.waves !== 'number' || counts === null || widest === null) {
    return blank(
      'unreadable',
      'epic-width.malformed-record: the recorded concurrency has no readable waves, verdicts or widest',
    );
  }

  // The close's own refusal, carried through rather than re-judged. `epic
  // close` catches an unreadable wave record so the close is not lost over it
  // (D-21); reading that as a measured zero here would undo exactly that care.
  const problem = typeof record.problem === 'string' ? record.problem : null;

  return {
    verdict: problem !== null ? ('unreadable' as const) : gradeOf(counts, record.waves),
    waves: record.waves,
    byVerdict: counts,
    widest,
    unobserved: Array.isArray(record.unobserved)
      ? record.unobserved.filter((id): id is string => typeof id === 'string')
      : [],
    problem,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Fold every `epic-closed` in these events into one closed epic each.
 *
 * Keyed on the payload's `epic_id` and never on `task_id`, and last close
 * wins — both rules `foldEpics` already keeps, for the reasons it documents:
 * the dogfood close used an unreserved `<epic>/epic` task id that would mint a
 * phantom epic here, and re-closing an epic is a correction rather than a
 * second epic.
 */
export function readClosedEpicWidths(events: readonly StoredEvent[]): ClosedEpicWidth[] {
  const byId = new Map<string, ClosedEpicWidth>();

  for (const { event_id, record } of events) {
    if (record.event_type !== CLOSED_EVENT_TYPE) continue;
    const payload = record.payload as ClosedPayload;
    const epicId = str(payload.epic_id);
    // No epic id means no epic to speak for. Inferring one is the phantom-card
    // inference D-43 exists to prevent.
    if (epicId === null) continue;

    byId.set(epicId, {
      epicId,
      eventId: event_id,
      closedAt: record.ts,
      sessionId: record.session_id,
      project: record.project ?? null,
      closedBy: str(payload.closed_by) ?? 'unspecified',
      machineVerdict: str(payload.machine_verdict),
      ...widthOf(payload),
    });
  }

  return [...byId.values()];
}

/**
 * Score the factory.
 *
 * Exit 1 is a closed epic whose record holds a `serialized` wave — admitted
 * wider than one task and never running two at once. It is the same fact
 * `wave audit` exits 1 on, deliberately: an operator who learned that code has
 * learned this one, and a second rule for the same failure is a second answer
 * waiting to disagree.
 *
 * What is NOT exit 1, and the discipline this depends on: a narrow epic. An
 * epic whose tasks genuinely depend on one another has nothing to run side by
 * side, and `unwaved` and `single` are not faults. Failing on those would fire
 * on every honest serial build in the repo, and a code that fires on
 * everything is routed to /dev/null inside a week — taking the serialized one
 * with it.
 *
 * Exit 2 is the `judge escalations` shape: nothing was judged. Either an
 * admitted wave has no work behind it — a declaration with nothing under it,
 * which epic.ts already tells the judge is the refutable case — or no close
 * carried a width at all, which is the state an empty factory is in and must
 * never be able to report as a healthy one.
 */
export function summariseEpicWidth(events: readonly StoredEvent[]): EpicWidthSummary {
  const epics = readClosedEpicWidths(events).sort((a, b) =>
    a.closedAt === b.closedAt
      ? a.epicId.localeCompare(b.epicId)
      : b.closedAt.localeCompare(a.closedAt),
  );

  const verdicts = Object.fromEntries(ALL_VERDICTS.map((v) => [v, 0])) as Record<
    EpicWidthVerdict,
    number
  >;
  for (const epic of epics) verdicts[epic.verdict] += 1;

  const serialized = epics.filter((e) => e.byVerdict.serialized > 0).map((e) => e.epicId);
  const unobserved = epics
    .filter((e) => e.byVerdict.unobserved > 0 || e.unobserved.length > 0)
    .map((e) => e.epicId);
  const unmeasured = epics
    .filter((e) => e.verdict === 'unmeasured' || e.verdict === 'unreadable')
    .map((e) => e.epicId);

  // "Judged" means a width was read and there was a wave in it. An epic that
  // measured zero waves is measured and is not evidence either way, so it
  // cannot on its own turn an unmeasured factory into a passing one.
  const judged = epics.some((e) => e.problem === null && e.waves > 0);

  return {
    epics,
    verdicts,
    widest: {
      declared: epics.reduce((max, e) => Math.max(max, e.widest.declared), 0),
      observed: epics.reduce((max, e) => Math.max(max, e.widest.observed), 0),
    },
    serialized,
    unobserved,
    unmeasured,
    hint: unobserved.length > 0 ? UNOBSERVED_HINT : judged ? '' : UNMEASURED_HINT,
    exitCode: serialized.length > 0 ? 1 : unobserved.length > 0 || !judged ? 2 : 0,
  };
}
