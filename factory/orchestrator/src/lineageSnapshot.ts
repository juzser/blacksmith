import {
  appendEvent,
  type EventInput,
  type EventOpts,
  readLineageEvents,
  type StoredEvent,
} from './events.js';

/**
 * One gate run's view of the session lineage.
 *
 * Every stage of a gate run used to fold the whole lineage again for each
 * finding it handled. A run now reads it once, keeps the result here, and
 * extends it with the events the run itself appends, so a later stage sees
 * exactly what a fresh read would have shown it.
 *
 * The snapshot is keyed on the `opts` object the run already passes down, and
 * `runGate` opens and closes it, so it never outlives or crosses a run. With
 * no run open every reader falls through to `readLineageEvents`.
 */
interface RunSnapshot {
  sessionId?: string;
  events?: StoredEvent[];
}

const runs = new WeakMap<object, RunSnapshot>();

/** Open a snapshot for the run that owns `opts`; the first read fills it. */
export function beginLineageRun(opts: EventOpts): void {
  runs.set(opts, {});
}

/** Drop the run's snapshot. */
export function endLineageRun(opts: EventOpts): void {
  runs.delete(opts);
}

/** The lineage of `sessionId`: the run's snapshot when one is open, else a fresh read. */
export async function readLineage(sessionId: string, opts: EventOpts): Promise<StoredEvent[]> {
  const run = runs.get(opts);
  if (run === undefined) return readLineageEvents(sessionId, opts);
  if (run.events === undefined) {
    run.sessionId = sessionId;
    run.events = await readLineageEvents(sessionId, opts);
  } else if (run.sessionId !== sessionId) {
    return readLineageEvents(sessionId, opts);
  }
  return [...run.events];
}

/** Add an event the run just appended to the run's snapshot, once it holds one. */
export function recordAppend(opts: EventOpts, stored: StoredEvent): void {
  const run = runs.get(opts);
  if (run?.events !== undefined && stored.record.session_id === run.sessionId) {
    run.events.push(stored);
  }
}

/** `appendEvent`, plus the snapshot extension. */
export async function appendTracked(input: EventInput, opts: EventOpts): Promise<StoredEvent> {
  const stored = await appendEvent(input, opts);
  recordAppend(opts, stored);
  return stored;
}
