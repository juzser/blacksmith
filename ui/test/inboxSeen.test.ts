// lib/inboxSeen.ts: the per-viewer set of Needs-you rows already opened.
import { describe, expect, it } from 'vitest';
import {
  INBOX_SEEN_CAP,
  INBOX_SEEN_KEY,
  inboxSeenId,
  isSeen,
  loadSeen,
  markSeen,
} from '../src/lib/inboxSeen.js';

const memory = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(INBOX_SEEN_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};
const throwing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

describe('inboxSeen', () => {
  it('reads an empty storage as nothing seen', () => {
    expect(loadSeen(memory()).size).toBe(0);
  });

  it('reads garbage as nothing seen', () => {
    expect(loadSeen(memory('not json')).size).toBe(0);
    expect(loadSeen(memory('{"a":1}')).size).toBe(0);
    expect([...loadSeen(memory('["a",3,"b"]'))]).toEqual(['a', 'b']);
  });

  it('reads a throwing storage as nothing seen, and marking never throws', () => {
    expect(loadSeen(throwing).size).toBe(0);
    expect(() => markSeen(throwing, 'x')).not.toThrow();
    expect(markSeen(throwing, 'x').has('x')).toBe(true);
  });

  it('marks a key and reads it back', () => {
    const s = memory();
    markSeen(s, 'waiver:t1');
    markSeen(s, 'escalation:t2');
    expect([...loadSeen(s)]).toEqual(['waiver:t1', 'escalation:t2']);
  });

  it('keeps one entry per key and caps at the newest 200', () => {
    const s = memory();
    markSeen(s, 'k0');
    markSeen(s, 'k0');
    expect(loadSeen(s).size).toBe(1);
    for (let i = 1; i <= INBOX_SEEN_CAP + 5; i++) markSeen(s, `k${i}`);
    const seen = loadSeen(s);
    expect(seen.size).toBe(INBOX_SEEN_CAP);
    expect(seen.has('k0')).toBe(false);
    expect(seen.has(`k${INBOX_SEEN_CAP + 5}`)).toBe(true);
  });

  it('names one decision: a newer createdAt on the same row id is a different key', () => {
    const first = { id: 'escalation:t1', createdAt: '2026-10-01T00:00:00.000Z' };
    expect(inboxSeenId({ ...first })).toBe(inboxSeenId({ ...first }));
    expect(inboxSeenId({ ...first, createdAt: '2026-10-02T00:00:00.000Z' })).not.toBe(
      inboxSeenId(first),
    );
    expect(inboxSeenId({ id: 'waiver:t1', createdAt: first.createdAt })).not.toBe(
      inboxSeenId(first),
    );
  });

  it('a row seen before keeps reading as read until a newer decision arrives', () => {
    const store = memory();
    const old = { id: 'waiver:t1', createdAt: '2026-10-01T00:00:00.000Z' };
    const seen = markSeen(store, inboxSeenId(old));
    expect(seen.has(inboxSeenId(old))).toBe(true);
    expect(seen.has(inboxSeenId({ ...old, createdAt: '2026-10-03T00:00:00.000Z' }))).toBe(false);
  });

  describe('isSeen', () => {
    const row = (id: string, createdAt: string) => ({ id, createdAt });
    const seenOf = (id: string, at: string) => new Set([inboxSeenId(row(id, at))]);

    it('reads a row with an older createdAt than the stored one as seen', () => {
      expect(
        isSeen(
          seenOf('waiver:t1', '2026-02-01T00:00:00Z'),
          row('waiver:t1', '2026-01-01T00:00:00Z'),
        ),
      ).toBe(true);
    });

    it('reads the same createdAt as seen and a newer one as unseen', () => {
      const seen = seenOf('waiver:t1', '2026-02-01T00:00:00Z');
      expect(isSeen(seen, row('waiver:t1', '2026-02-01T00:00:00Z'))).toBe(true);
      expect(isSeen(seen, row('waiver:t1', '2026-03-01T00:00:00Z'))).toBe(false);
    });

    it('does not count a different row id with a later date', () => {
      expect(
        isSeen(
          seenOf('waiver:t2', '2026-09-01T00:00:00Z'),
          row('waiver:t1', '2026-01-01T00:00:00Z'),
        ),
      ).toBe(false);
    });

    it('parses a key whose id contains @ or :', () => {
      const id = 'escalation:store@a:task@1';
      const seen = seenOf(id, '2026-02-01T00:00:00Z');
      expect(isSeen(seen, row(id, '2026-01-01T00:00:00Z'))).toBe(true);
      expect(isSeen(seen, row(id, '2026-03-01T00:00:00Z'))).toBe(false);
      expect(isSeen(seen, row('escalation:store', '2026-01-01T00:00:00Z'))).toBe(false);
    });
  });

  it('markSeen drops older keys of the same row id', () => {
    const s = memory();
    markSeen(s, 'waiver:t1@2026-01-01T00:00:00Z');
    markSeen(s, 'lesson:l1@2026-01-01T00:00:00Z');
    const next = markSeen(s, 'waiver:t1@2026-02-01T00:00:00Z');
    expect([...next]).toEqual(['lesson:l1@2026-01-01T00:00:00Z', 'waiver:t1@2026-02-01T00:00:00Z']);
  });
});
