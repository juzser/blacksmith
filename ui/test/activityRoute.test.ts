import { describe, expect, it } from 'vitest';
import { errorsRedirect, timelineRedirect } from '../src/lib/activityRoute.js';

// DS6 PR3 scope item 1: `/timeline` and `/errors` are retired in favour of
// `/activity`, but old links/bookmarks keep working — same query, plus a
// forced `kind=errors` for the old Errors page.
describe('lib/activityRoute.ts timelineRedirect()', () => {
  it('sends a bare /timeline link to /activity', () => {
    expect(timelineRedirect({ query: {} })).toEqual({ path: '/activity', query: {} });
  });

  it('keeps every existing query param', () => {
    expect(timelineRedirect({ query: { kind: 'dispatch', task: 'epic-1/task-1' } })).toEqual({
      path: '/activity',
      query: { kind: 'dispatch', task: 'epic-1/task-1' },
    });
  });
});

describe('lib/activityRoute.ts errorsRedirect()', () => {
  it('sends a bare /errors link to /activity?kind=errors', () => {
    expect(errorsRedirect({ query: {} })).toEqual({
      path: '/activity',
      query: { kind: 'errors' },
    });
  });

  it('keeps the rest of the query and still forces kind=errors', () => {
    expect(errorsRedirect({ query: { task: 'epic-1/task-1', kind: 'ignored' } })).toEqual({
      path: '/activity',
      query: { task: 'epic-1/task-1', kind: 'errors' },
    });
  });
});
