import { describe, expect, it } from 'vitest';
import type { ActiveScopeResult } from '../src/lib/api.js';
import {
  activeFirst,
  isSessionActive,
  isStaleResponse,
  otherStoreProjects,
  selectedSessionFromQuery,
  sessionsByProject,
  sessionsInScope,
} from '../src/lib/sessionsSelection.js';

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

const live = (over: Partial<ActiveScopeResult> = {}): ActiveScopeResult => ({
  measured: true,
  readAt: '2026-10-07T12:00:00.000Z',
  liveSessions: 1,
  unlinkedSessions: 0,
  projects: [],
  epics: [],
  factorySessions: [{ storeId: 'home', sessionId: 'session-a' }],
  ...over,
});

describe('isSessionActive', () => {
  const row = (sessionId: string, workingAgentCount: number) => ({ sessionId, workingAgentCount });
  it('is active when a live CLI session drives it, whatever workingAgentCount says', () => {
    expect(isSessionActive(live(), row('session-a', 0))).toBe(true);
  });

  it('is quiet when no live CLI session drives it, even with working agents', () => {
    expect(isSessionActive(live(), row('session-b', 3))).toBe(false);
  });

  it('is not active for a session of another store with the same id', () => {
    const other = live({ factorySessions: [{ storeId: 'store-b', sessionId: 'session-a' }] });
    expect(isSessionActive(other, row('session-a', 1))).toBe(false);
  });
});

describe('otherStoreProjects', () => {
  const p = (storeId: string, project: string) => ({
    storeId,
    project,
    liveSessions: 1,
    agentsWorking: 0,
  });

  it('names the active projects that live outside the home store, once each', () => {
    const scope = live({
      projects: [p('home', 'project-a'), p('store-b', 'project-b'), p('store-b', 'project-b')],
    });
    expect(otherStoreProjects(scope)).toEqual(['project-b']);
  });

  it('is empty when unmeasured or not loaded', () => {
    expect(otherStoreProjects(live({ measured: false, projects: [p('store-b', 'x')] }))).toEqual(
      [],
    );
    expect(otherStoreProjects(null)).toEqual([]);
  });
});

describe('sessionsByProject', () => {
  function s(partial: { sessionId: string; lastEventAt: string; projects: string[] }) {
    return partial;
  }

  it('groups sessions under each project they belong to, newest group first', () => {
    const a = s({ sessionId: 'a', lastEventAt: '2026-01-01T03:00:00.000Z', projects: ['proj-a'] });
    const b = s({ sessionId: 'b', lastEventAt: '2026-01-01T02:00:00.000Z', projects: ['proj-b'] });
    const c = s({ sessionId: 'c', lastEventAt: '2026-01-01T01:00:00.000Z', projects: ['proj-a'] });
    const groups = sessionsByProject([a, b, c]);
    expect(groups.map((g) => g.project)).toEqual(['proj-a', 'proj-b']);
    expect(groups[0]?.sessions.map((x) => x.sessionId)).toEqual(['a', 'c']);
    expect(groups[1]?.sessions.map((x) => x.sessionId)).toEqual(['b']);
  });

  it('sorts newest-first within a group regardless of input order', () => {
    const older = s({
      sessionId: 'older',
      lastEventAt: '2026-01-01T01:00:00.000Z',
      projects: ['p'],
    });
    const newer = s({
      sessionId: 'newer',
      lastEventAt: '2026-01-01T02:00:00.000Z',
      projects: ['p'],
    });
    const groups = sessionsByProject([older, newer]);
    expect(groups[0]?.sessions.map((x) => x.sessionId)).toEqual(['newer', 'older']);
  });

  it('puts a session with no project under the "" group so it is never dropped', () => {
    const noProject = s({
      sessionId: 'orphan',
      lastEventAt: '2026-01-01T01:00:00.000Z',
      projects: [],
    });
    const groups = sessionsByProject([noProject]);
    expect(groups).toEqual([{ project: '', sessions: [noProject] }]);
  });

  it('lists a multi-project session under every one of its projects', () => {
    // The session genuinely belongs to both -- projects: string[] already
    // represents real multi-membership elsewhere (e.g. Overview's per-project
    // cards), so hiding it from one group would misrepresent the data rather
    // than simplify it.
    const multi = s({
      sessionId: 'shared',
      lastEventAt: '2026-01-01T01:00:00.000Z',
      projects: ['proj-a', 'proj-b'],
    });
    const groups = sessionsByProject([multi]);
    expect(groups.map((g) => g.project)).toEqual(['proj-a', 'proj-b']);
    expect(groups[0]?.sessions).toEqual([multi]);
    expect(groups[1]?.sessions).toEqual([multi]);
  });
});

describe('sessionsInScope', () => {
  const mk = (sessionId: string, workingAgentCount: number) => ({ sessionId, workingAgentCount });
  // 'a' has no working agent but a live CLI session drives it; 'q1' has three
  // working agents and no live session.
  const list = [mk('a', 0), mk('q1', 3), mk('q2', 0)];
  const scope = live({ factorySessions: [{ storeId: 'home', sessionId: 'a' }] });
  const ids = (xs: readonly { sessionId: string }[]) => xs.map((s) => s.sessionId);

  it('active keeps only sessions a live CLI session drives', () => {
    expect(ids(sessionsInScope(list, 'active', null, scope))).toEqual(['a']);
  });

  it('all keeps every session', () => {
    expect(ids(sessionsInScope(list, 'all', null, scope))).toEqual(['a', 'q1', 'q2']);
  });

  it('active keeps a quiet selected session pinned, and only that one', () => {
    expect(ids(sessionsInScope(list, 'active', 'q2', scope))).toEqual(['a', 'q2']);
  });

  it('a selected id that no longer exists adds nothing', () => {
    expect(ids(sessionsInScope(list, 'active', 'gone', scope))).toEqual(['a']);
  });

  it('the hidden quiet count excludes a pinned session', () => {
    expect(list.length - sessionsInScope(list, 'active', null, scope).length).toBe(2);
    expect(list.length - sessionsInScope(list, 'active', 'q1', scope).length).toBe(1);
    expect(list.length - sessionsInScope(list, 'all', 'q1', scope).length).toBe(0);
  });

  it('unmeasured: active returns the full list, as all does', () => {
    const unmeasured = live({ measured: false, factorySessions: [] });
    expect(ids(sessionsInScope(list, 'active', null, unmeasured))).toEqual(['a', 'q1', 'q2']);
    expect(ids(sessionsInScope(list, 'active', null, null))).toEqual(['a', 'q1', 'q2']);
  });
});

describe('activeFirst', () => {
  const mk = (sessionId: string, lastEventAt: string) => ({ sessionId, lastEventAt });
  const scope = live({
    factorySessions: [
      { storeId: 'home', sessionId: 'a-old' },
      { storeId: 'home', sessionId: 'a-new' },
    ],
  });

  it('puts active ahead of quiet, each group newest first', () => {
    const out = activeFirst(
      [
        mk('q-new', '2026-01-04'),
        mk('a-old', '2026-01-01'),
        mk('q-old', '2026-01-02'),
        mk('a-new', '2026-01-03'),
      ],
      scope,
    );
    expect(out.map((s) => s.sessionId)).toEqual(['a-new', 'a-old', 'q-new', 'q-old']);
  });

  it('is stable for equal keys and does not mutate its input', () => {
    const input = [mk('a-new', '2026-01-01'), mk('a-old', '2026-01-01'), mk('z', '2026-01-01')];
    const copy = [...input];
    expect(activeFirst(input, scope).map((s) => s.sessionId)).toEqual(['a-new', 'a-old', 'z']);
    expect(input).toEqual(copy);
  });
});
