// lib/inboxSeen.ts: the per-viewer set of Needs-you rows already opened.
import { describe, expect, it } from 'vitest';
import { INBOX_SEEN_CAP, INBOX_SEEN_KEY, loadSeen, markSeen } from '../src/lib/inboxSeen.js';

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
});
