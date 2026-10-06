import { describe, expect, it } from 'vitest';
import { parseActivityScope, scopeQuery } from '../src/lib/activityScope.js';

describe('parseActivityScope', () => {
  it("reads 'all' as all", () => {
    expect(parseActivityScope('all')).toBe('all');
  });

  it('falls back to active for absent, empty, array and unknown values', () => {
    expect(parseActivityScope(undefined)).toBe('active');
    expect(parseActivityScope(null)).toBe('active');
    expect(parseActivityScope('')).toBe('active');
    expect(parseActivityScope(['all'])).toBe('active');
    expect(parseActivityScope('ALL')).toBe('active');
    expect(parseActivityScope('active')).toBe('active');
    expect(parseActivityScope('nope')).toBe('active');
  });
});

describe('scopeQuery', () => {
  it('sets scope=all and keeps every other key', () => {
    expect(scopeQuery({ project: 'x', session: 's1' }, 'all')).toEqual({
      project: 'x',
      session: 's1',
      scope: 'all',
    });
  });

  it('removes scope for active and keeps every other key', () => {
    expect(scopeQuery({ project: 'x', scope: 'all' }, 'active')).toEqual({ project: 'x' });
  });

  it('does not mutate its input', () => {
    const q = { scope: 'all' };
    scopeQuery(q, 'active');
    expect(q).toEqual({ scope: 'all' });
  });

  it('round-trips through parseActivityScope', () => {
    for (const s of ['active', 'all'] as const) {
      expect(parseActivityScope(scopeQuery({ a: '1' }, s).scope)).toBe(s);
    }
  });
});
