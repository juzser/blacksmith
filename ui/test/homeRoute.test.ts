import { describe, expect, it } from 'vitest';
import { homeRedirect } from '../src/lib/homeRoute.js';

// `/` and the retired `/projects` both land on Home (ds-spec.md §4.1: Home
// is Overview + Projects merged). A deep link keeps its query, and a
// `?project=` scope becomes Home's own project route, so the scope survives.
describe('lib/homeRoute.ts homeRedirect()', () => {
  it('sends a bare link to the global Home', () => {
    expect(homeRedirect({ query: {} })).toEqual({ name: 'overview-global', query: {} });
  });

  it('keeps every other query param', () => {
    expect(homeRedirect({ query: { session: 's1', width: 'all' } })).toEqual({
      name: 'overview-global',
      query: { session: 's1', width: 'all' },
    });
  });

  it('turns a ?project= scope into the project Home route', () => {
    expect(homeRedirect({ query: { project: 'shop-api', session: 's1' } })).toEqual({
      name: 'overview-project',
      params: { project: 'shop-api' },
      query: { session: 's1' },
    });
  });

  it('ignores an empty or repeated project param rather than guessing', () => {
    expect(homeRedirect({ query: { project: '' } })).toEqual({
      name: 'overview-global',
      query: {},
    });
    expect(homeRedirect({ query: { project: ['a', 'b'] } })).toEqual({
      name: 'overview-global',
      query: {},
    });
  });
});
