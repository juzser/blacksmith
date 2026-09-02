import { type AgentRecord, foldAgents } from './agents-registry.js';
import type { StoredEvent } from './events.js';

/**
 * Did the wave that was admitted N wide actually run N wide?
 *
 * `wave next` computes the widest wave a plan admits and `wave check` admits
 * one. Both are statements about what MAY happen next: the first proposes, the
 * second permits, and neither has any way of knowing what the dispatcher did
 * afterwards. So a factory whose whole premise is "many subagents running the
 * plan's tasks in parallel" could serialise every wave it ever admitted and
 * say nothing about it — the admission would still be in the log, four ids
 * wide, indistinguishable from a wave that genuinely ran four at once.
 *
 * That is the declarations-vs-state split this repo keeps drawing (AGENTS.md):
 * `wave-admitted` is a declaration, and the only state that can answer it is
 * when each agent was actually live. Both halves were already in the log —
 * `dispatch_decision` opens an agent and its terminal event closes one, and
 * agents-registry.ts already folds exactly that pair into intervals. So this
 * is a fold over facts that were always there, not a new thing to record.
 *
 * It reuses `foldAgents` rather than reading `dispatch_decision` directly for
 * the reason that fold documents (D-161): a dispatch superseded by a
 * redispatch, or abandoned at `epic-closed`, has an end even though no
 * terminal event names it, and reading the raw dispatches would leave those
 * intervals open forever and score every wave after one as parallel.
 */

const ADMITTED_EVENT_TYPE = 'wave-admitted';

/**
 * What the log says a wave did.
 *
 * - `parallel`   — every admitted task was in flight at one instant.
 * - `partial`    — two or more were, but never all of them.
 * - `serialized` — work is recorded, and no two tasks ever overlapped.
 * - `single`     — the wave admitted one task. Nothing to be parallel about,
 *                  and scoring it against a width it never claimed would make
 *                  the failing verdicts unreadable.
 * - `unobserved` — the wave was admitted and the log records no work for any
 *                  of its tasks. Not the same fact as `serialized`, and the
 *                  whole point of separating them: one says the factory ran
 *                  narrow, the other says nobody can tell.
 */
export type WaveVerdict = 'parallel' | 'partial' | 'serialized' | 'single' | 'unobserved';

/** One admitted task, as the log shows it actually running. */
export interface TaskRun {
  taskId: string;
  /** The first dispatch inside this wave's window. */
  startedAt: string;
  /**
   * When the last agent on it closed, or null while one is still open. Null
   * is read as "still running" and not as "ran for no time": an agent that
   * never reported back was, as far as anything can tell, still working, and
   * a task after it started while it was.
   */
  endedAt: string | null;
  /** The roles that ran on it, in dispatch order, each named once. */
  roles: string[];
}

export interface WaveConcurrency {
  /** The `wave-admitted` event's id — the handle for this wave. */
  eventId: string;
  admittedAt: string;
  /** As the admission spelled it; null when it named none (never guessed). */
  epicId: string | null;
  /** The width that was declared: the task ids the admission admitted. */
  declared: string[];
  /** The subset the log holds work for, ordered by when that work started. */
  observed: TaskRun[];
  /** Admitted tasks with no dispatch inside this wave's window. */
  unobserved: string[];
  /** The most admitted tasks in flight at any one instant. */
  peak: number;
  verdict: WaveVerdict;
}

export interface WaveConcurrencyOptions {
  /** Narrow to one epic, as the admission spelled it. */
  epicId?: string;
}

export interface WaveConcurrencySummary {
  waves: WaveConcurrency[];
  /** Epics holding a wave that ran strictly one task at a time. */
  serialized: string[];
  /** Epics holding a wave that ran in parallel, but narrower than admitted. */
  partial: string[];
  /** Epics holding a wave the log shows no work for at all. */
  unobserved: string[];
  /** The widest wave admitted anywhere, against the widest ever observed. */
  widest: { declared: number; observed: number };
  /** Empty unless something came back `unobserved`; see {@link UNOBSERVED_HINT}. */
  hint: string;
  /** 1 on a serialized wave, 2 when nothing could be judged, else 0. */
  exitCode: 0 | 1 | 2;
}

/**
 * Said when a wave was admitted and no agent was ever dispatched for it. The
 * two readings are genuinely different problems and the operator has to pick
 * between them by hand, so the hint names both rather than choosing.
 */
export const UNOBSERVED_HINT =
  'A wave admitted with no dispatch_decision under any of its tasks ran nowhere this log can ' +
  'see. Either the dispatcher never started it, or the agents ran outside the lineage that was ' +
  'read — narrow with --epic, or check that the run wrote its dispatches to this state dir.';

interface Admission {
  eventId: string;
  ts: string;
  epicId: string | null;
  taskIds: string[];
}

function readAdmission(event: StoredEvent): Admission {
  const payload = event.record.payload as { epic_id?: unknown; task_ids?: unknown };
  const raw = payload.task_ids;
  const taskIds =
    Array.isArray(raw) && raw.every((id) => typeof id === 'string' && id.length > 0)
      ? (raw as string[])
      : null;
  if (!taskIds || taskIds.length === 0) {
    // Refused rather than read as a zero-wide wave: a malformed admission that
    // audited clean is exactly the silence this command exists to end.
    throw new Error(
      `wave-concurrency.missing-task-ids: wave-admitted "${event.event_id}" names no tasks`,
    );
  }
  return {
    eventId: event.event_id,
    ts: event.record.ts,
    // Never derived from the task ids. `emitWaveAdmitted` always writes this
    // field, so an admission without one was hand-authored, and inventing the
    // epic it probably meant would put a guess where the log has a gap.
    epicId: typeof payload.epic_id === 'string' && payload.epic_id ? payload.epic_id : null,
    taskIds,
  };
}

/** Milliseconds, with an unclosed agent reaching forward without bound. */
function endMs(endedAt: string | null): number {
  return endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(endedAt);
}

/**
 * The most intervals overlapping at one instant. Ends are processed before
 * starts at the same timestamp, so a task that finishes exactly as the next
 * one begins counts as a handoff and not as concurrency — without that, a
 * dispatcher running strictly one task at a time would score `parallel` on
 * nothing but the clock's granularity.
 *
 * Times are doubled first so that a run whose dispatch and terminal share a
 * millisecond still gets a width of one tick instead of none. On the raw axis
 * such a run is an empty interval, overlapping nothing — not even itself —
 * and two admitted tasks would come back as a peak of zero, which is a claim
 * about the clock dressed up as a claim about the factory.
 */
function peakOverlap(runs: readonly TaskRun[]): number {
  const points = runs.flatMap((run) => {
    const start = Date.parse(run.startedAt) * 2;
    return [
      { t: start, d: 1 },
      { t: Math.max(endMs(run.endedAt) * 2, start + 1), d: -1 },
    ];
  });
  // Subtraction would give NaN for two unclosed agents (Infinity - Infinity),
  // and a NaN comparator silently leaves the array unsorted.
  points.sort((a, b) => (a.t === b.t ? a.d - b.d : a.t < b.t ? -1 : 1));
  let live = 0;
  let peak = 0;
  for (const point of points) {
    live += point.d;
    if (live > peak) peak = live;
  }
  return peak;
}

function verdictFor(declared: number, observed: number, peak: number): WaveVerdict {
  if (declared <= 1) return 'single';
  if (observed === 0) return 'unobserved';
  if (peak >= declared) return 'parallel';
  if (peak <= 1) return 'serialized';
  return 'partial';
}

/**
 * Fold one task's agents into the interval it was worked on. Every role counts,
 * not just the coder's: a task whose reviewer is still running is still work
 * in progress, and a wave holding it has not narrowed yet.
 */
function runFor(taskId: string, agents: readonly AgentRecord[]): TaskRun | null {
  if (agents.length === 0) return null;
  const ordered = [...agents].sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt));
  const startedAt = ordered[0]?.dispatchedAt as string;
  let endedAt: string | null = null;
  for (const agent of ordered) {
    // One unclosed agent leaves the whole task open — the task is only done
    // being worked on when every role on it is.
    if (agent.terminalAt === null)
      return { taskId, startedAt, endedAt: null, roles: rolesOf(ordered) };
    if (endedAt === null || agent.terminalAt > endedAt) endedAt = agent.terminalAt;
  }
  return { taskId, startedAt, endedAt, roles: rolesOf(ordered) };
}

function rolesOf(ordered: readonly AgentRecord[]): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const agent of ordered) {
    if (seen.has(agent.agentRole)) continue;
    seen.add(agent.agentRole);
    roles.push(agent.agentRole);
  }
  return roles;
}

/**
 * Every wave in the log, scored against what the log says it did.
 *
 * A task can be admitted more than once — a follow-up, a redispatch after a
 * bounce — so each wave owns its tasks' agents only until the admission that
 * re-opens them. Without that window, a later wave that genuinely ran wide
 * would retro-fit its parallelism onto the earlier serial one that admitted
 * the same task, and the command would report the opposite of the truth.
 */
export function auditWaveConcurrency(
  events: readonly StoredEvent[],
  options: WaveConcurrencyOptions = {},
): WaveConcurrency[] {
  const admissions = events
    .filter((event) => event.record.event_type === ADMITTED_EVENT_TYPE)
    .map(readAdmission)
    .sort((a, b) => (a.ts === b.ts ? a.eventId.localeCompare(b.eventId) : a.ts < b.ts ? -1 : 1));

  // Built from every admission, before the epic filter: a window closed by an
  // admission the caller filtered out is still closed, and asking about one
  // epic must not widen another epic's windows.
  const admittedAtByTask = new Map<string, string[]>();
  for (const admission of admissions) {
    for (const taskId of admission.taskIds) {
      const list = admittedAtByTask.get(taskId);
      if (list) list.push(admission.ts);
      else admittedAtByTask.set(taskId, [admission.ts]);
    }
  }

  const agentsByTask = new Map<string, AgentRecord[]>();
  for (const agent of foldAgents(events)) {
    if (!agent.taskId) continue;
    const list = agentsByTask.get(agent.taskId);
    if (list) list.push(agent);
    else agentsByTask.set(agent.taskId, [agent]);
  }

  const waves: WaveConcurrency[] = [];
  for (const admission of admissions) {
    if (options.epicId !== undefined && admission.epicId !== options.epicId) continue;

    const observed: TaskRun[] = [];
    const unobserved: string[] = [];
    for (const taskId of admission.taskIds) {
      const closesAt = (admittedAtByTask.get(taskId) ?? []).find((ts) => ts > admission.ts);
      const run = runFor(
        taskId,
        (agentsByTask.get(taskId) ?? []).filter(
          (agent) =>
            // A run already under way when the wave was cut is not this wave's
            // to claim; a run after the next admission belongs to that one.
            agent.dispatchedAt >= admission.ts &&
            (closesAt === undefined || agent.dispatchedAt < closesAt),
        ),
      );
      if (run) observed.push(run);
      else unobserved.push(taskId);
    }
    observed.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const peak = peakOverlap(observed);
    waves.push({
      eventId: admission.eventId,
      admittedAt: admission.ts,
      epicId: admission.epicId,
      declared: admission.taskIds,
      observed,
      unobserved,
      peak,
      verdict: verdictFor(admission.taskIds.length, observed.length, peak),
    });
  }
  return waves;
}

/** The handle an operator has on a wave: its epic, or its own id when it named none. */
function labelOf(wave: WaveConcurrency): string {
  return wave.epicId ?? wave.eventId;
}

function labelsWith(waves: readonly WaveConcurrency[], verdict: WaveVerdict): string[] {
  const labels: string[] = [];
  for (const wave of waves) {
    if (wave.verdict !== verdict) continue;
    const label = labelOf(wave);
    // Once per epic, not once per wave: an epic that serialised every wave it
    // ever cut has one problem, and listing it eight times reads as eight.
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Score the audit.
 *
 * Exit 1 is `serialized` alone. A `partial` wave — three admitted, two in
 * flight — is the factory working and is reported rather than failed: an exit
 * code that cried about it would be routed to /dev/null inside a week, and
 * then the serialized one would go with it.
 *
 * Exit 2 is the same shape `judge escalations` uses: nothing was judged. A
 * wave the log holds no dispatch for is not a passing wave, and returning 0
 * for it would make an empty state dir look like a healthy factory.
 */
export function summariseWaveConcurrency(
  waves: readonly WaveConcurrency[],
): WaveConcurrencySummary {
  const serialized = labelsWith(waves, 'serialized');
  const unobserved = labelsWith(waves, 'unobserved');
  return {
    waves: [...waves],
    serialized,
    partial: labelsWith(waves, 'partial'),
    unobserved,
    widest: {
      declared: waves.reduce((max, wave) => Math.max(max, wave.declared.length), 0),
      observed: waves.reduce((max, wave) => Math.max(max, wave.peak), 0),
    },
    hint: unobserved.length > 0 ? UNOBSERVED_HINT : '',
    exitCode: serialized.length > 0 ? 1 : unobserved.length > 0 ? 2 : 0,
  };
}
