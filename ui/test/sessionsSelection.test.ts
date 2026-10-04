import { describe, expect, it } from 'vitest';
import { selectedSessionFromQuery } from '../src/lib/sessionsSelection.js';

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
