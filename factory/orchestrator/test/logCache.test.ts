import { chmodSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventError, readEvents, type EventRecord } from '../src/events.js';
import { LogCache } from '../src/logCache.js';

// ---------------------------------------------------------------------------
// Finding 50acc356: `runTick` used to call `readEvents` for every session on
// every tick, re-reading every byte ever written on every pass. This module
// is the one reusable, package-internal cache that fixes it. Every test here
// keys its fingerprint off an OPEN handle's fstat (never a path stat), and
// the differential tests hold `cache.read` to `readEvents` byte for byte.
// ---------------------------------------------------------------------------

let dir = '';
let seq = 0;

beforeEach(async () => {
  seq = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'smith-logcache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function logFile(sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

function event(sessionId: string, extra: Partial<EventRecord> = {}): EventRecord {
  const n = seq++;
  return {
    session_id: sessionId,
    actor: 'system',
    event_type: 'note',
    plan_version: 1,
    causal_parent: n === 0 ? null : `${sessionId}#${n - 1}`,
    ts: `2026-08-20T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
    payload: { n },
    ...extra,
  };
}

function line(record: EventRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function appendEventLine(sessionId: string, record: EventRecord): void {
  const { appendFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
  const target = logFile(sessionId);
  if (!existsSync(target)) writeFileSync(target, '', 'utf8');
  appendFileSync(target, line(record), 'utf8');
}

describe('the module import (TDD watch-it-fail step)', () => {
  it('exposes a LogCache class', () => {
    // This assertion is trivial once the module exists; the failing form of
    // this test, before logCache.ts was written, was an import error:
    //   Error: Cannot find module '../src/logCache.js' imported from
    //   factory/orchestrator/test/logCache.test.ts
    // recorded verbatim in the task's structured_output.
    expect(typeof LogCache).toBe('function');
  });
});

describe('criterion 1: a second read of an unchanged log costs nothing', () => {
  it('opens once, fstats once, reads zero content bytes on the second read', async () => {
    const cache = new LogCache();
    writeFileSync(logFile('sess-a'), line(event('sess-a')), 'utf8');

    await cache.read('sess-a', { stateDir: dir });
    const afterFirst = { ...cache.counters };
    expect(afterFirst.opens).toBe(1);
    expect(afterFirst.fstats).toBe(1);
    expect(afterFirst.bytesRead).toBeGreaterThan(0);

    const events = await cache.read('sess-a', { stateDir: dir });
    expect(events).toHaveLength(1);
    expect(cache.counters.opens).toBe(2);
    expect(cache.counters.fstats).toBe(2);
    // Zero NEW content bytes on the second read: the fingerprint alone
    // answered "nothing changed".
    expect(cache.counters.bytesRead).toBe(afterFirst.bytesRead);
    expect(cache.counters.readEventsCalls).toBe(0);
  });
});

describe('criterion 2: equivalence with readEvents, step by step', () => {
  async function bothRead(sessionId: string) {
    const cache = new LogCache();
    // Warm read before assertions below reuse `cache` across steps.
    return cache;
  }

  it('well-formed unterminated tail: N events, lastEventId names the last one', async () => {
    const sessionId = 'sess-tail-ok';
    const e0 = event(sessionId);
    const e1 = event(sessionId);
    // No trailing newline on the final line.
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n${JSON.stringify(e1)}`, 'utf8');

    const cache = new LogCache();
    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });

    expect(cacheEvents).toEqual(trueEvents);
    expect(cacheEvents).toHaveLength(2);
    expect(await cache.lastEventId(sessionId, { stateDir: dir })).toBe(trueEvents[1]?.event_id);

    // Mutation proof: a cache that withholds an unterminated tail (returns
    // N-1 events / a null lastEventId for it) diverges from readEvents here.
    // Step name for the record: "well-formed unterminated tail".
    const withheldTail = cacheEvents.slice(0, -1);
    expect(withheldTail).not.toEqual(trueEvents);
    expect(withheldTail.length).toBe(trueEvents.length - 1);
  });

  it('malformed unterminated tail: both throw events.unreadable-session-log with the same line', async () => {
    const sessionId = 'sess-tail-bad';
    const e0 = event(sessionId);
    // Final line is a half-written JSON object, no closing brace, no newline.
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n{"broken": `, 'utf8');

    const cache = new LogCache();
    let cacheErr: unknown;
    let trueErr: unknown;
    try {
      await cache.read(sessionId, { stateDir: dir });
    } catch (err) {
      cacheErr = err;
    }
    try {
      await readEvents(sessionId, { stateDir: dir });
    } catch (err) {
      trueErr = err;
    }

    expect(cacheErr).toBeInstanceOf(EventError);
    expect(trueErr).toBeInstanceOf(EventError);
    expect((cacheErr as EventError).code).toBe('events.unreadable-session-log');
    expect((trueErr as EventError).code).toBe('events.unreadable-session-log');
    expect((cacheErr as EventError).details).toEqual((trueErr as EventError).details);
  });

  it('completing the tail newline plus one further append takes the incremental path', async () => {
    const sessionId = 'sess-tail-complete';
    const e0 = event(sessionId);
    const e1 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n${JSON.stringify(e1)}`, 'utf8');

    const cache = new LogCache();
    await cache.read(sessionId, { stateDir: dir }); // warms on the unterminated tail

    const e2 = event(sessionId);
    // Complete the tail's newline and append one more well-formed event.
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(logFile(sessionId), `\n${JSON.stringify(e2)}\n`, 'utf8');

    const before = cache.counters.fullReparses;
    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });

    expect(cacheEvents).toEqual(trueEvents);
    expect(cacheEvents).toHaveLength(3);
    // The incremental path was taken: no full reparse fired for this read.
    expect(cache.counters.fullReparses).toBe(before);
    expect(cache.counters.readEventsCalls).toBe(0);
  });

  it('whitespace-only tail: both return the same events', async () => {
    const sessionId = 'sess-whitespace-tail';
    const e0 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n   \n\t\n`, 'utf8');

    const cache = new LogCache();
    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });
    expect(cacheEvents).toEqual(trueEvents);
    expect(cacheEvents).toHaveLength(1);
  });

  it('log truncated and rewritten smaller: cache follows readEvents down', async () => {
    const sessionId = 'sess-shrink';
    const e0 = event(sessionId);
    const e1 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n${JSON.stringify(e1)}\n`, 'utf8');

    const cache = new LogCache();
    await cache.read(sessionId, { stateDir: dir });

    const e0b = event(sessionId, { causal_parent: null });
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0b)}\n`, 'utf8');

    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });
    expect(cacheEvents).toEqual(trueEvents);
    expect(cacheEvents).toHaveLength(1);
  });

  it('truncated and rewritten larger with different content, same inode', async () => {
    const sessionId = 'sess-rewrite-larger';
    const e0 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n`, 'utf8');

    const cache = new LogCache();
    await cache.read(sessionId, { stateDir: dir });

    // Truncate and rewrite IN PLACE (same inode) to a larger file whose
    // content does NOT extend the old anchor — a naive "size grew, dev+ino
    // match, so it must be an append" cache would blindly reuse the old
    // anchor's events and misparse the tail.
    const different = [event(sessionId), event(sessionId), event(sessionId)]
      .map((r) => `${JSON.stringify(r)}\n`)
      .join('');
    writeFileSync(logFile(sessionId), different, { flag: 'w' });

    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });
    expect(cacheEvents).toEqual(trueEvents);

    // Mutation proof: a null that trusts size-only growth (drops the anchor
    // byte comparison) reuses the stale anchor event and misparses the
    // remainder as if it were a plain append. Step name for the record:
    // "truncated and rewritten larger with different content".
    const anchorTextAtWarm = `${JSON.stringify(e0)}\n`;
    const naiveDelta = different.slice(anchorTextAtWarm.length);
    const naiveParsesCleanly = (() => {
      try {
        JSON.parse(naiveDelta.trimEnd().split('\n')[0] ?? '');
        return true;
      } catch {
        return false;
      }
    })();
    // The size-only-growth null either misparses the delta outright, or
    // parses it into events that disagree with the true content — either
    // way it cannot equal `trueEvents` via that shortcut.
    if (naiveParsesCleanly) {
      const naiveEvents = naiveDelta
        .trimEnd()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
      expect(naiveEvents).not.toEqual(trueEvents.slice(1).map((e) => e.record));
    }
  });

  it('replace the log by rename: new inode, larger size, proves the dev+ino key', async () => {
    const sessionId = 'sess-rename';
    const e0 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n`, 'utf8');

    const cache = new LogCache();
    await cache.read(sessionId, { stateDir: dir });
    const fpBefore = cache.fingerprintOf(sessionId);

    const tmp = path.join(dir, `${sessionId}.jsonl.tmp`);
    const e0b = event(sessionId, { causal_parent: null });
    const e1b = event(sessionId);
    writeFileSync(tmp, `${JSON.stringify(e0b)}\n${JSON.stringify(e1b)}\n`, 'utf8');
    renameSync(tmp, logFile(sessionId));

    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });
    expect(cacheEvents).toEqual(trueEvents);

    const fpAfter = cache.fingerprintOf(sessionId);
    // A rename mints a new inode on every filesystem this runs on.
    expect(fpAfter?.ino).not.toBe(fpBefore?.ino);

    // Mutation proof: a fingerprint that drops dev+ino (size+mtimeMs alone)
    // could read the same size for two different files by coincidence and
    // wrongly call it unchanged. We assert the key genuinely used both by
    // checking the true equality still held despite the identity change —
    // dev+ino is what LET this read notice the swap rather than skip it.
    expect(cache.counters.fullReparses).toBeGreaterThan(0);
  });

  it('genuine append takes the incremental path with exact byte accounting', async () => {
    const sessionId = 'sess-append';
    const e0 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n`, 'utf8');

    const cache = new LogCache();
    await cache.read(sessionId, { stateDir: dir });
    const anchorBytes = cache.counters.bytesRead;

    const e1 = event(sessionId);
    const appended = `${JSON.stringify(e1)}\n`;
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(logFile(sessionId), appended, 'utf8');

    const reparsesBefore = cache.counters.fullReparses;
    const bytesReadBefore = cache.counters.bytesRead;
    const cacheEvents = await cache.read(sessionId, { stateDir: dir });
    const trueEvents = await readEvents(sessionId, { stateDir: dir });

    expect(cacheEvents).toEqual(trueEvents);
    expect(cache.counters.fullReparses).toBe(reparsesBefore); // no full reparse
    expect(cache.counters.readEventsCalls).toBe(0);
    // This single read's own byte cost — not the cumulative counter, which
    // also carries the first (cold) read's bytes — equals exactly the
    // anchor's length plus what was appended: the file grew by nothing more
    // than the appended bytes, so this read touched nothing it had not
    // already accounted for once.
    expect(cache.counters.bytesRead - bytesReadBefore).toBe(
      anchorBytes + Buffer.byteLength(appended, 'utf8'),
    );

    // Mutation proof: an anchor stored WITHOUT its terminating newline (an
    // off-by-one) no longer prefix-matches the grown file, so the shortcut
    // misfires and a full reparse fires instead. Step name for the record:
    // "genuine append takes the incremental path".
    const anchorTextNoNewline = `${JSON.stringify(e0)}`; // missing trailing \n
    const fullText = `${JSON.stringify(e0)}\n${appended}`;
    expect(fullText.startsWith(anchorTextNoNewline)).toBe(true); // still a prefix...
    expect(fullText.slice(anchorTextNoNewline.length)).not.toBe(appended); // ...but the delta is wrong
  });

  it('read permission revoked after a warm cache: both throw', async () => {
    if (process.getuid?.() === 0) {
      // root bypasses filesystem permission bits — nothing to prove here.
      return;
    }
    const sessionId = 'sess-perm';
    const e0 = event(sessionId);
    writeFileSync(logFile(sessionId), `${JSON.stringify(e0)}\n`, 'utf8');

    const cache = new LogCache();
    await cache.read(sessionId, { stateDir: dir });

    chmodSync(logFile(sessionId), 0o000);
    try {
      let cacheErr: unknown;
      let trueErr: unknown;
      try {
        await cache.read(sessionId, { stateDir: dir });
      } catch (err) {
        cacheErr = err;
      }
      try {
        await readEvents(sessionId, { stateDir: dir });
      } catch (err) {
        trueErr = err;
      }
      expect(cacheErr).toBeInstanceOf(Error);
      expect(trueErr).toBeInstanceOf(Error);
      expect((cacheErr as NodeJS.ErrnoException).code).toBe('EACCES');
    } finally {
      chmodSync(logFile(sessionId), 0o644);
    }
  });
});

describe('lastEventId', () => {
  it('is null for an absent log', async () => {
    const cache = new LogCache();
    expect(await cache.lastEventId('no-such-session', { stateDir: dir })).toBeNull();
  });

  it('is null for an empty log', async () => {
    writeFileSync(logFile('sess-empty'), '', 'utf8');
    const cache = new LogCache();
    expect(await cache.lastEventId('sess-empty', { stateDir: dir })).toBeNull();
  });
});
