// The daemon's fix for finding 50acc356: `runTick` used to call `readEvents`
// for every session on every tick, re-reading and re-parsing every byte ever
// written to every log, forever. This module is the one place that reads a
// session log more than once in a process's lifetime, and it reads each log
// exactly once per byte that was ever appended to it.
//
// The fingerprint that decides "did this log change" is taken from an OPEN
// file descriptor's fstat, never a path stat: `stat(path)` can race a
// concurrent writer (open, then unlink-and-replace, then stat sees the new
// inode while a reader mid-read still holds the old one) in a way an fstat on
// a handle already open for THIS read cannot.
import { open } from 'node:fs/promises';
import path from 'node:path';
import { EventError, type EventRecord, type StoredEvent } from './events.js';
import { STATE_EVENTS_DIR } from './paths.js';

export interface LogFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * The counting seam the differential tests key on. `opens` and `fstats`
 * count syscalls; `bytesRead` counts content bytes actually read off disk
 * (zero for a cache hit); `readEventsCalls` counts delegation to the
 * `readEvents` module-level reader (always zero — this module never calls
 * it, so a caller who wired the cache in cannot accidentally fall back to
 * the unbounded reader without it showing here); `fullReparses` counts reads
 * that could not reuse a cached anchor and re-parsed the log from byte 0,
 * as against a read that reused the anchor's already-parsed events and only
 * parsed the newly appended tail.
 */
export interface LogCacheCounters {
  opens: number;
  fstats: number;
  bytesRead: number;
  readEventsCalls: number;
  fullReparses: number;
}

interface CacheEntry {
  fp: LogFingerprint;
  /** The exact raw file content this entry's `events` were parsed from. */
  anchorText: string;
  events: StoredEvent[];
}

export interface LogCacheReadOpts {
  stateDir?: string;
}

function fpEqual(a: LogFingerprint, b: LogFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Same algorithm as `events.ts`'s private `readEventsAtPath` — trim trailing
 * whitespace, split on `\n`, drop empty lines, parse each survivor as JSON —
 * copied rather than imported so this module never calls `readEvents` (the
 * `readEventsCalls` seam stays truthfully zero) while still throwing the
 * identical `events.unreadable-session-log` error other readers throw.
 *
 * `startIndex` offsets the event id / line-number math for a delta parse:
 * parsing only the newly appended tail of a log must still number its events
 * (and report a malformed line's number) as if the whole file had been
 * parsed at once.
 */
function parseLog(
  text: string,
  sessionId: string,
  filePath: string,
  startIndex: number,
): StoredEvent[] {
  const lines = text
    .trimEnd()
    .split('\n')
    .filter((line) => line.length > 0);
  return lines.map((line, offset) => {
    const index = startIndex + offset;
    let record: EventRecord;
    try {
      record = JSON.parse(line) as EventRecord;
    } catch (err) {
      throw new EventError(
        'events.unreadable-session-log',
        `Line ${index + 1} of ${filePath} is not JSON, so session "${sessionId}" cannot be read: ${
          err instanceof Error ? err.message : String(err)
        }.`,
        { session_id: sessionId, path: filePath, line: index + 1 },
      );
    }
    return { event_id: `${sessionId}#${index}`, record };
  });
}

/**
 * A reusable, package-internal cache of session event logs, keyed by a
 * fingerprint taken from an open handle rather than a path stat.
 *
 * One instance is meant to live across many `runTick` calls (the daemon's
 * long-running loop holds one for its whole run); a fresh instance is always
 * cold, so `runTick` with no shared cache reads exactly what `readEvents`
 * would have — this is an optimization for the repeat-tick case, not a
 * change in what any single read returns.
 */
export class LogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly appliedSignatures = new Map<string, string>();
  readonly counters: LogCacheCounters = {
    opens: 0,
    fstats: 0,
    bytesRead: 0,
    readEventsCalls: 0,
    fullReparses: 0,
  };

  private logPath(sessionId: string, opts: LogCacheReadOpts): string {
    return path.join(opts.stateDir ?? STATE_EVENTS_DIR, `${sessionId}.jsonl`);
  }

  /** This session's log, read through the cache. */
  async read(sessionId: string, opts: LogCacheReadOpts = {}): Promise<StoredEvent[]> {
    const filePath = this.logPath(sessionId, opts);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, 'r');
      this.counters.opens += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries.delete(sessionId);
        return [];
      }
      throw err;
    }

    try {
      const stats = await handle.stat();
      this.counters.fstats += 1;
      const fp: LogFingerprint = {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };

      const cached = this.entries.get(sessionId);
      if (cached !== undefined && fpEqual(fp, cached.fp)) {
        return cached.events;
      }

      const text = await handle.readFile('utf8');
      this.counters.bytesRead += Buffer.byteLength(text, 'utf8');

      // The anchor comparison: reuse the cached anchor's already-parsed
      // events, and parse only the newly appended tail, ONLY when the
      // current content still starts with exactly the bytes the anchor was
      // parsed from. Same device+inode is necessary but not sufficient — a
      // log truncated and rewritten larger, in place, keeps its inode but is
      // not an append, and only a byte comparison of the region the anchor
      // already answered for catches that; size and mtime alone cannot.
      let events: StoredEvent[];
      if (
        cached !== undefined &&
        fp.dev === cached.fp.dev &&
        fp.ino === cached.fp.ino &&
        text.length >= cached.anchorText.length &&
        text.startsWith(cached.anchorText)
      ) {
        const delta = text.slice(cached.anchorText.length);
        const deltaEvents = parseLog(delta, sessionId, filePath, cached.events.length);
        events = deltaEvents.length === 0 ? cached.events : [...cached.events, ...deltaEvents];
      } else {
        this.counters.fullReparses += 1;
        events = parseLog(text, sessionId, filePath, 0);
      }

      this.entries.set(sessionId, { fp, anchorText: text, events });
      return events;
    } finally {
      await handle.close();
    }
  }

  /** The `event_id` of this session's last event, or `null` for empty/absent. */
  async lastEventId(sessionId: string, opts: LogCacheReadOpts = {}): Promise<string | null> {
    const events = await this.read(sessionId, opts);
    return events.length === 0 ? null : (events[events.length - 1] as StoredEvent).event_id;
  }

  /**
   * The fingerprint this cache last read for `sessionId`, or `undefined` if
   * it has never been read through this cache. Lets a caller (the daemon's
   * apply-skip below) build a cheap in-memory signature over a set of
   * sessions without re-reading any of them.
   */
  fingerprintOf(sessionId: string): LogFingerprint | undefined {
    return this.entries.get(sessionId)?.fp;
  }

  /**
   * The signature this cache last recorded a projector `apply()` against for
   * `leaf` (`setAppliedSignature`'s argument), so the daemon can skip a
   * redundant apply when nothing in the leaf's lineage changed since.
   */
  getAppliedSignature(leaf: string): string | undefined {
    return this.appliedSignatures.get(leaf);
  }

  setAppliedSignature(leaf: string, signature: string): void {
    this.appliedSignatures.set(leaf, signature);
  }
}
