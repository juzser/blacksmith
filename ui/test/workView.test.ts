import { describe, expect, it } from 'vitest';
import {
  legacyWorkRedirect,
  switchQuery,
  WORK_VIEWS,
  workViewFromRouteName,
} from '../src/lib/workView.js';

describe('WORK_VIEWS', () => {
  it('lists Kanban then Roadmap, each pointing at its child route', () => {
    expect(WORK_VIEWS).toEqual([
      { value: 'kanban', label: 'Kanban', path: '/work/kanban', routeName: 'work-kanban' },
      { value: 'roadmap', label: 'Roadmap', path: '/work/roadmap', routeName: 'work-roadmap' },
    ]);
  });
});

describe('workViewFromRouteName', () => {
  it('reads roadmap only from the work-roadmap route name', () => {
    expect(workViewFromRouteName('work-roadmap')).toBe('roadmap');
  });

  it('defaults to kanban for work-kanban and anything else', () => {
    expect(workViewFromRouteName('work-kanban')).toBe('kanban');
    expect(workViewFromRouteName(undefined)).toBe('kanban');
    expect(workViewFromRouteName('task-detail')).toBe('kanban');
  });
});

describe('switchQuery', () => {
  it('carries epic, project and session across a view switch', () => {
    expect(switchQuery({ epic: 'e1', project: 'p1', session: 's1' })).toEqual({
      epic: 'e1',
      project: 'p1',
      session: 's1',
    });
  });

  it('drops milestone and phase, and any key not carried', () => {
    expect(switchQuery({ milestone: 'm1', phase: 'p1', other: 'x' })).toEqual({});
  });

  it('omits carried keys that are absent rather than writing them as undefined', () => {
    const out = switchQuery({ epic: 'e1' });
    expect(out).toEqual({ epic: 'e1' });
    expect('project' in out).toBe(false);
  });
});

describe('legacyWorkRedirect', () => {
  it('redirects to the given target path, keeping the full query', () => {
    const redirect = legacyWorkRedirect('/work/kanban');
    const to = { query: { epic: 'e1', milestone: 'm1' }, hash: '' } as Parameters<
      typeof redirect
    >[0];
    expect(redirect(to)).toEqual({
      path: '/work/kanban',
      query: { epic: 'e1', milestone: 'm1' },
      hash: '',
    });
  });

  it('keeps the hash when redirecting', () => {
    const redirect = legacyWorkRedirect('/work/kanban');
    const to = { query: { epic: 'e1' }, hash: '#task-42' } as Parameters<typeof redirect>[0];
    expect(redirect(to)).toEqual({ path: '/work/kanban', query: { epic: 'e1' }, hash: '#task-42' });
  });
});
