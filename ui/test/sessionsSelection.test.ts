import { describe, expect, it } from 'vitest';
import {
  isSessionActive,
  isStaleResponse,
  selectedSessionFromQuery,
  sessionsByProject,
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

describe('isSessionActive', () => {
  it('is active when workingAgentCount is above zero', () => {
    expect(isSessionActive({ workingAgentCount: 1 })).toBe(true);
  });

  it('is not active when workingAgentCount is zero, even with live-but-stale agents', () => {
    // liveAgentCount > 0 but workingAgentCount 0: a ghost run whose agents
    // dispatched outside the 4h staleness window -- counts as quiet, not
    // running (operator directive: workingAgentCount, never liveAgentCount).
    const ghost = { workingAgentCount: 0, liveAgentCount: 3 };
    expect(isSessionActive(ghost)).toBe(false);
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
