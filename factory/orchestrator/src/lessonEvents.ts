// The one store reader for lesson recurrence (bs-optimize epic D2); the CLI
// and brief compose both call it, so "store-wide" has one definition.
import { statSync } from 'node:fs';
import path from 'node:path';
import { listSessionIds, readEvents, type StoredEvent } from './events.js';
import { isRecurrenceEvent, type RecurrenceWindow } from './lessonRecurrence.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Injectable file and log access, so a test can count the calls (cost bound). */
export interface RecurrenceReaders {
  stat?: (file: string) => { mtimeMs: number };
  readEvents?: (sessionId: string, opts: { stateDir: string }) => Promise<StoredEvent[]>;
}

/**
 * Serves epic criterion 3 (store-wide means every session): the events
 * `isRecurrenceEvent` admits (`error-logged`, and a blocked `gate-outcome`) of
 * every session log under `stateDir` whose `ts` lies in the window.
 * A session file whose mtime is older than the window is never opened: every
 * `ts` is stamped at write time, so the file's mtime is never earlier than its
 * newest event (epic-spec D2). One `stat` per file, one read per in-window
 * file. A missing dir reads as []; a file that vanishes after listing is skipped.
 */
export async function readRecurrenceEvents(
  stateDir: string,
  { now, windowDays }: RecurrenceWindow,
  readers: RecurrenceReaders = {},
): Promise<StoredEvent[]> {
  const stat = readers.stat ?? ((file: string) => statSync(file));
  const read = readers.readEvents ?? readEvents;
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const kept: StoredEvent[] = [];
  for (const sessionId of listSessionIds(stateDir)) {
    let mtimeMs: number;
    try {
      mtimeMs = stat(path.join(stateDir, `${sessionId}.jsonl`)).mtimeMs;
    } catch (err) {
      // Listed, then gone before the stat: nothing to read from it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (mtimeMs < cutoff) continue;
    for (const event of await read(sessionId, { stateDir })) {
      if (isRecurrenceEvent(event.record) && Date.parse(event.record.ts) >= cutoff) {
        kept.push(event);
      }
    }
  }
  return kept;
}
