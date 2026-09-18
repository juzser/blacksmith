import { describe, expect, it } from 'vitest';
import { compareLogOrder, isLaterEvent, tryParseEventId } from '../src/eventOrder.js';

describe('compareLogOrder', () => {
  it('breaks a tied ts by log index, not lexical event id (the #9/#10 inversion)', () => {
    const t = '2026-01-03T00:00:00.000Z';
    const nine = { ts: t, eventId: 'sess-1#9' };
    const ten = { ts: t, eventId: 'sess-1#10' };

    expect(compareLogOrder(nine, ten)).toBeLessThan(0);
    expect(compareLogOrder(ten, nine)).toBeGreaterThan(0);
  });

  it('lets ts win over index whenever the two events have different ts', () => {
    const earlier = { ts: '2026-01-01T00:00:00.000Z', eventId: 'sess-1#50' };
    const later = { ts: '2026-01-02T00:00:00.000Z', eventId: 'sess-1#1' };

    expect(compareLogOrder(earlier, later)).toBeLessThan(0);
  });

  it('settles a tied ts across sessions by session id, and isLaterEvent agrees', () => {
    const t = '2026-01-03T00:00:00.000Z';
    const a = { ts: t, eventId: 'sess-a#5' };
    const b = { ts: t, eventId: 'sess-b#1' };

    expect(compareLogOrder(a, b)).toBeLessThan(0);
    expect(isLaterEvent(b, a)).toBe(true);
    expect(isLaterEvent(a, b)).toBe(false);
  });

  it('never throws on an unparseable id and treats it as index -1', () => {
    const t = '2026-01-03T00:00:00.000Z';
    const unparseable = { ts: t, eventId: 'sess-1' };
    const parseable = { ts: t, eventId: 'sess-1#0' };

    expect(() => compareLogOrder(unparseable, parseable)).not.toThrow();
    expect(Number.isFinite(compareLogOrder(unparseable, parseable))).toBe(true);
    expect(compareLogOrder(unparseable, parseable)).toBeLessThan(0);
  });

  it('is zero for the same event', () => {
    const x = { ts: '2026-01-03T00:00:00.000Z', eventId: 'sess-1#7' };

    expect(compareLogOrder(x, x)).toBe(0);
  });
});

describe('tryParseEventId', () => {
  it('parses a well-formed id', () => {
    expect(tryParseEventId('sess-1#42')).toEqual({ sessionId: 'sess-1', index: 42 });
  });

  it('splits on the LAST #, so a session id may itself contain one', () => {
    expect(tryParseEventId('sess#weird#3')).toEqual({ sessionId: 'sess#weird', index: 3 });
  });

  it('returns null, never throws, for every malformed shape', () => {
    expect(tryParseEventId('sess-1')).toBeNull();
    expect(tryParseEventId('#3')).toBeNull();
    expect(tryParseEventId('sess-1#last')).toBeNull();
    expect(tryParseEventId('sess-1#-1')).toBeNull();
  });

  it('returns null for a non-string reached through a cast, and does not throw', () => {
    expect(() => tryParseEventId(42 as unknown as string)).not.toThrow();
    expect(tryParseEventId(42 as unknown as string)).toBeNull();
  });
});
