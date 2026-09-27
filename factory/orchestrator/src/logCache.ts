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
//
// Per log, the cache keeps an OFFSET (the byte offset just past the last
// consumed newline) and an ANCHOR (the bytes of the last complete line,
// terminating newline included, occupying exactly
// `[offset - anchor.length, offset)`). A grown file is read once, from
// `offset - anchor.length` to the new end; only when the leading
// `anchor.length` bytes of that read still equal the cached anchor is the
// growth treated as a genuine append, and only the bytes after `offset` are
// parsed. Every other outcome — a different dev/ino, a shrink, an anchor
// mismatch, or a cached offset of 0 with no anchor at all — is a full
// re-read from byte 0.
//
// RESIDUAL CONTRACT: session logs are append-only by design (`appendEvent`
// only ever appends). This cache DETECTS truncation, replacement, and any
// rewrite that changes the anchor's bytes or offset. It does NOT detect an
// in-place rewrite, on the same inode, that happens to keep the anchor's
// bytes — terminating newline included — sitting in the same
// `[offset - anchor.length, offset)` window, nor a same-size rewrite that
// lands inside one mtime tick. Both are out of scope: nothing in this repo
// writes a session log that way, so this is stated as a limit rather than
// implied to be full change detection.
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
 * The counting I/O seam the differential tests key on, and the seam a caller
 * may inject into the factory below to share one set of counters across
 * several caches (or to assert on it directly). `opens` and `fstats` count
 * syscalls; `bytesRead` counts content bytes actually read off disk (zero for
 * a cache hit or an unchanged-fingerprint fast path); `readEventsCalls`
 * counts delegation to the `readEvents` module-level reader (always zero —
 * this module never calls it, so a caller who wired the cache in cannot
 * accidentally fall back to the unbounded reader without it showing here);
 * `fullReparses` counts reads that could not reuse a cached anchor and
 * re-parsed the log from byte 0, as against a read that reused the anchor's
 * already-parsed events and only parsed the newly appended bytes.
 */
export interface LogCacheSeam {
  opens: number;
  fstats: number;
  bytesRead: number;
  readEventsCalls: number;
  fullReparses: number;
}

/** @deprecated Kept as an alias of {@link LogCacheSeam}; use that name. */
export type LogCacheCounters = LogCacheSeam;

interface CacheEntry {
  fp: LogFingerprint;
  /** Byte offset just past the last consumed (newline-terminated) line. */
  offset: number;
  /**
   * The last complete line, terminating `\n` included — the bytes occupying
   * `[offset - anchor.length, offset)`. Empty when `offset` is 0.
   */
  anchor: Buffer;
  /** Events parsed from newline-terminated lines only — what advances `offset`/`anchor`. */
  cachedEvents: StoredEvent[];
  /** `cachedEvents` plus a still-unterminated pending tail, if one exists. What `read()` returns. */
  events: StoredEvent[];
}

export interface LogCacheReadOpts {
  stateDir?: string;
}

function fpEqual(a: LogFingerprint, b: LogFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Whatever a thrown value has to say for itself, without assuming it is an Error. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
function parseCompleteLines(
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
        `Line ${index + 1} of ${filePath} is not JSON, so session "${sessionId}" cannot be read: ${errorText(err)}.`,
        { session_id: sessionId, path: filePath, line: index + 1 },
      );
    }
    return { event_id: `${sessionId}#${index}`, record };
  });
}

/**
 * Parse a JSON pending tail — a well-formed JSON value with no terminating
 * newline yet — into the one event it names. Throws the same
 * `events.unreadable-session-log` error, with the same line number,
 * `readEvents` would report for a malformed final line.
 */
function parsePendingTail(
  text: string,
  sessionId: string,
  filePath: string,
  index: number,
): StoredEvent {
  let record: EventRecord;
  try {
    record = JSON.parse(text) as EventRecord;
  } catch (err) {
    throw new EventError(
      'events.unreadable-session-log',
      `Line ${index + 1} of ${filePath} is not JSON, so session "${sessionId}" cannot be read: ${errorText(err)}.`,
      { session_id: sessionId, path: filePath, line: index + 1 },
    );
  }
  return { event_id: `${sessionId}#${index}`, record };
}

const NEWLINE = 0x0a;

/**
 * The result of parsing everything from `baseOffset` onward: the complete
 * (newline-terminated) events, any pending tail, and the offset/anchor those
 * complete events advance the entry to.
 */
interface TailParse {
  /** `baseCachedEvents` plus the newly parsed complete lines. */
  cachedEvents: StoredEvent[];
  /** `cachedEvents` plus a parsed pending tail, if `tailBuf` ends in one. */
  events: StoredEvent[];
  offset: number;
  anchor: Buffer;
}

/**
 * Tail-detection and parse, applied to the RAW, untrimmed bytes of
 * `tailBuf` — everything at and after `baseOffset` in the log.
 *
 * Locates the LAST `\n` in `tailBuf`: everything up to and including it is
 * newline-terminated ("complete") lines, parsed and cached; everything after
 * it is the candidate pending tail. A whitespace-only (or empty) candidate is
 * no pending tail at all. `baseAnchor`/`baseOffset` are reused unchanged when
 * `tailBuf` holds no newline — nothing newline-terminated was added, so
 * nothing the entry remembers may advance.
 */
function parseTail(
  tailBuf: Buffer,
  sessionId: string,
  filePath: string,
  baseOffset: number,
  baseIndex: number,
  baseAnchor: Buffer,
  baseCachedEvents: readonly StoredEvent[],
): TailParse {
  const lastNL = tailBuf.lastIndexOf(NEWLINE);

  let offset = baseOffset;
  let anchor = baseAnchor;
  let newComplete: StoredEvent[] = [];
  let pendingBuf: Buffer;

  if (lastNL === -1) {
    pendingBuf = tailBuf;
  } else {
    const completeBuf = tailBuf.subarray(0, lastNL + 1);
    const prevNL = lastNL <= 0 ? -1 : tailBuf.lastIndexOf(NEWLINE, lastNL - 1);
    const anchorStart = prevNL === -1 ? 0 : prevNL + 1;
    anchor = Buffer.from(tailBuf.subarray(anchorStart, lastNL + 1));
    offset = baseOffset + lastNL + 1;
    newComplete = parseCompleteLines(completeBuf.toString('utf8'), sessionId, filePath, baseIndex);
    pendingBuf = tailBuf.subarray(lastNL + 1);
  }

  const cachedEvents =
    newComplete.length === 0 ? [...baseCachedEvents] : [...baseCachedEvents, ...newComplete];
  const pendingText = pendingBuf.toString('utf8');
  if (pendingText.trim().length === 0) {
    return { cachedEvents, events: cachedEvents, offset, anchor };
  }

  const pendingIndex = baseIndex + newComplete.length;
  const pendingEvent = parsePendingTail(pendingText, sessionId, filePath, pendingIndex);
  return { cachedEvents, events: [...cachedEvents, pendingEvent], offset, anchor };
}

const EMPTY_SEAM: LogCacheSeam = {
  opens: 0,
  fstats: 0,
  bytesRead: 0,
  readEventsCalls: 0,
  fullReparses: 0,
};

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
  readonly counters: LogCacheSeam;

  /** `seam` lets a caller inject (and so share, or directly assert on) the counting object. */
  constructor(seam?: LogCacheSeam) {
    this.counters = seam ?? { ...EMPTY_SEAM };
  }

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
        // The previous entry, if any, is left untouched — same rule as a
        // read that throws below. A log that has vanished (and may come
        // back) is not the same fact as a log this cache has never seen.
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

      // Append-only is verified, never inferred from size: the incremental
      // path is only even attempted when the anchor byte-for-byte matches
      // what the file now holds at the same window.
      const canAttemptIncremental =
        cached !== undefined &&
        fp.dev === cached.fp.dev &&
        fp.ino === cached.fp.ino &&
        cached.anchor.length > 0 &&
        fp.size >= cached.offset;

      if (canAttemptIncremental) {
        // biome-ignore lint/style/noNonNullAssertion: canAttemptIncremental narrows `cached`.
        const entry = cached!;
        const start = entry.offset - entry.anchor.length;
        const readLen = fp.size - start;
        const buf = Buffer.alloc(readLen);
        const { bytesRead } = await handle.read(buf, 0, readLen, start);
        this.counters.bytesRead += bytesRead;
        const slice = buf.subarray(0, bytesRead);

        if (slice.subarray(0, entry.anchor.length).equals(entry.anchor)) {
          const tailBuf = slice.subarray(entry.anchor.length);
          const parsed = parseTail(
            tailBuf,
            sessionId,
            filePath,
            entry.offset,
            entry.cachedEvents.length,
            entry.anchor,
            entry.cachedEvents,
          );
          this.entries.set(sessionId, {
            fp,
            offset: parsed.offset,
            anchor: parsed.anchor,
            cachedEvents: parsed.cachedEvents,
            events: parsed.events,
          });
          return parsed.events;
        }
        // Anchor mismatch: a same-size-or-larger rewrite that is not a
        // genuine append. Fall through to a full re-read.
      }

      this.counters.fullReparses += 1;
      const whole = await handle.readFile();
      this.counters.bytesRead += whole.length;
      const parsed = parseTail(whole, sessionId, filePath, 0, 0, Buffer.alloc(0), []);
      this.entries.set(sessionId, {
        fp,
        offset: parsed.offset,
        anchor: parsed.anchor,
        cachedEvents: parsed.cachedEvents,
        events: parsed.events,
      });
      return parsed.events;
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

  /**
   * Evicts every key not in `liveSessionIds` from both `entries` and
   * `appliedSignatures`, so the cache's memory is bounded by live logs, not
   * by history. `runTick` calls this once per tick with the session ids
   * `listSessionIds` just returned -- the LISTED set, not the set of
   * sessions whose read succeeded this tick -- so a session that is listed
   * but unreadable keeps its entry (a read that throws leaves the entry
   * untouched; eviction is the tick's decision, driven by the listing, not
   * the read). A session that vanishes and later reappears loses both its
   * fingerprint and its applied signature, so it is read cold and its leaf
   * is re-applied. One pass over each map's own keys; no file I/O.
   */
  retainOnly(liveSessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.entries.keys()) {
      if (!liveSessionIds.has(sessionId)) this.entries.delete(sessionId);
    }
    for (const leaf of this.appliedSignatures.keys()) {
      if (!liveSessionIds.has(leaf)) this.appliedSignatures.delete(leaf);
    }
  }
}

/**
 * The public factory. `dist/logCache.js` exports this, the `LogCache` type
 * it returns, and the `LogCacheSeam` type its optional argument takes — the
 * three names a consumer (task 3's dashboard wiring) imports to inject a
 * counting cache elsewhere.
 */
export function createLogCache(seam?: LogCacheSeam): LogCache {
  return new LogCache(seam);
}
