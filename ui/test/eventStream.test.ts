import { describe, expect, it } from 'vitest';
import type { SessionAdvance } from '../src/lib/eventStream.js';
import { hasNews, parseAdvanced, shouldRunInterval } from '../src/lib/eventStream.js';

// The change stream's pure half (design-spec.md's 2026-09-15 addendum to §8).
// Everything asserted here is a decision the page makes about data that came
// off a socket this process does not control, which is why the shape checks
// are worth writing down: a frame is not a promise, it is an input.

function frame(sessions: unknown): string {
  return JSON.stringify({ sessions });
}

describe('shouldRunInterval: the fallback rule', () => {
  it('stands the interval down only when the stream confirmed itself open', () => {
    expect(shouldRunInterval('open')).toBe(false);
  });

  it('keeps polling in every state that is not a live stream', () => {
    // Listed rather than looped, so adding a state to StreamState fails
    // here — the compiler cannot tell that a new state defaults safely, and
    // the unsafe default (stop polling) is the one that shows stale data.
    expect(shouldRunInterval('idle')).toBe(true);
    expect(shouldRunInterval('connecting')).toBe(true);
    expect(shouldRunInterval('closed')).toBe(true);
  });

  it('never stands a heartbeat down, not even against a healthy stream', () => {
    // The shell's pulse (composables/usePulse.ts). Its subject is the server,
    // not the data, and an open stream that reports nothing is the single
    // state where those two questions have different answers: nothing
    // changed, and nobody is home, look identical from here.
    expect(shouldRunInterval('open', true)).toBe(true);
  });

  it('is the same rule for a heartbeat in every other state', () => {
    // i.e. the flag only ever adds an interval; it can never remove one. A
    // heartbeat that polled *less* than a data page in some state would be a
    // liveness probe that went quiet exactly when the connection was sick.
    expect(shouldRunInterval('idle', true)).toBe(true);
    expect(shouldRunInterval('connecting', true)).toBe(true);
    expect(shouldRunInterval('closed', true)).toBe(true);
  });

  it('polls by default, so a caller that forgets the flag still polls', () => {
    expect(shouldRunInterval('open', false)).toBe(false);
    expect(shouldRunInterval('open')).toBe(shouldRunInterval('open', false));
  });
});

describe('parseAdvanced: a frame is an input, not a promise', () => {
  it('reads the frame the server writes', () => {
    expect(parseAdvanced(frame([{ session: 'epic-1', events: 42 }]))).toEqual([
      { session: 'epic-1', events: 42 },
    ]);
  });

  it('reads an empty advance list as no news rather than as a failure', () => {
    expect(parseAdvanced(frame([]))).toEqual([]);
  });

  it('returns [] instead of throwing on malformed JSON', () => {
    expect(parseAdvanced('{"sessions":')).toEqual([]);
    expect(parseAdvanced('')).toEqual([]);
  });

  it('returns [] for JSON that is not the frame shape', () => {
    expect(parseAdvanced('null')).toEqual([]);
    expect(parseAdvanced('"advanced"')).toEqual([]);
    expect(parseAdvanced('[{"session":"a","events":1}]')).toEqual([]);
    expect(parseAdvanced('{"sessions":{"a":1}}')).toEqual([]);
  });

  it('drops a malformed entry without dropping the sound ones beside it', () => {
    const parsed = parseAdvanced(
      frame([
        { session: 'good-1', events: 1 },
        null,
        'not-an-object',
        { session: '', events: 3 },
        { session: 'no-count' },
        { session: 'nan', events: Number.NaN },
        { session: 'stringy', events: '7' },
        { session: 'good-2', events: 0 },
      ]),
    );
    expect(parsed).toEqual([
      { session: 'good-1', events: 1 },
      { session: 'good-2', events: 0 },
    ]);
  });
});

describe('hasNews: a count is compared, never accumulated', () => {
  const advances: SessionAdvance[] = [{ session: 'epic-1', events: 7 }];

  it('is news when the session has not been seen', () => {
    expect(hasNews(advances, new Map())).toBe(true);
  });

  it('is news when the count moved', () => {
    expect(hasNews(advances, new Map([['epic-1', 6]]))).toBe(true);
  });

  it('is not news when the same count is reported twice', () => {
    // The server reports a total, and a fingerprint can change without the
    // count changing — a touched mtime re-projects the same log. Refetching
    // every page on that is work with no news behind it.
    expect(hasNews(advances, new Map([['epic-1', 7]]))).toBe(false);
  });

  it('is news when any one session moved, not only when all did', () => {
    const seen = new Map([
      ['epic-1', 7],
      ['epic-2', 1],
    ]);
    expect(
      hasNews(
        [
          { session: 'epic-1', events: 7 },
          { session: 'epic-2', events: 2 },
        ],
        seen,
      ),
    ).toBe(true);
  });

  it('is not news for an empty advance list', () => {
    expect(hasNews([], new Map())).toBe(false);
  });

  it('treats a zero-event session as seen, not as unseen', () => {
    // `seen.get() ?? -1` and not `?? 0`: a session whose log projected to
    // zero events is a real report, and defaulting to 0 would swallow it.
    expect(hasNews([{ session: 'fresh', events: 0 }], new Map())).toBe(true);
    expect(hasNews([{ session: 'fresh', events: 0 }], new Map([['fresh', 0]]))).toBe(false);
  });

  it('does not write to the map it is given', () => {
    const seen = new Map<string, number>();
    hasNews(advances, seen);
    expect(seen.size).toBe(0);
  });
});
