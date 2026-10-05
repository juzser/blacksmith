import { describe, expect, it } from 'vitest';
import { isStaleResponse, selectedSessionFromQuery } from '../src/lib/sessionsSelection.js';

const sessions = [{ sessionId: 'sess-a' }, { sessionId: 'sess-b' }];

describe('selectedSessionFromQuery', () => {
  it('selects the id named in the query when it is a known session', () => {
    expect(selectedSessionFromQuery({ session: 'sess-b' }, sessions)).toBe('sess-b');
  });

  it('returns null when the query names no session', () => {
    expect(selectedSessionFromQuery({}, sessions)).toBeNull();
  });

  it('returns null for an id the session list does not know about', () => {
    expect(selectedSessionFromQuery({ session: 'sess-z' }, sessions)).toBeNull();
  });

  it('returns null when the query repeats the key (vue-router hands an array)', () => {
    expect(selectedSessionFromQuery({ session: ['sess-a', 'sess-b'] }, sessions)).toBeNull();
  });
});

describe('isStaleResponse', () => {
  it('flags a response for a run no longer selected as stale', () => {
    // User selects A, then B; A's response is still in flight.
    let selectedId: string | null = 'sess-a';
    selectedId = 'sess-b';
    expect(isStaleResponse('sess-a', selectedId)).toBe(true);
  });

  it('accepts a response that matches the currently selected run', () => {
    // A late response for A lands first, then B's own response lands;
    // B's response must apply even though A resolved after the click.
    const selectedId = 'sess-b';
    expect(isStaleResponse('sess-a', selectedId)).toBe(true);
    expect(isStaleResponse('sess-b', selectedId)).toBe(false);
  });

  it('treats no selection as stale for any response', () => {
    expect(isStaleResponse('sess-a', null)).toBe(true);
  });
});
