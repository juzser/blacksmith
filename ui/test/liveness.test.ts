import { describe, expect, it } from 'vitest';
import type { LiveAgentEntry, RunningSession } from '../src/lib/api.js';
import {
  AGENT_STALE_AFTER_MS,
  activeSessionCount,
  agentActivity,
  byRuntimeDesc,
  bySessionRecency,
  lastEventLabel,
  livenessLabel,
  livenessLevel,
  longestRunningSince,
  SESSION_ACTIVE_WITHIN_MS,
  sessionActivity,
  workingCount,
} from '../src/lib/liveness.js';

const now = '2026-08-05T12:00:00.000Z';
const INTERVAL = 5000;

function entry(
  id: string,
  dispatchedAt: string,
  taskId: string | null = `T-${id}`,
): LiveAgentEntry {
  return {
    id,
    sessionId: 'sess-1',
    agentRole: 'coder',
    provider: 'anthropic',
    modelTier: 'sonnet',
    taskId,
    epicId: null,
    dispatchedAt,
  };
}

function session(sessionId: string, lastEventAt: string): RunningSession {
  return {
    sessionId,
    startedAt: '2026-08-05T09:00:00.000Z',
    lastEventAt,
    eventCount: 12,
    lastEventType: 'dispatch_decision',
    liveAgentCount: 1,
    projects: ['black-smith'],
  };
}

describe('lib/liveness.ts livenessLevel()', () => {
  it('is "connecting" before the first successful load', () => {
    expect(livenessLevel(null, now, INTERVAL)).toBe('connecting');
  });

  it('is "live" within two poll intervals of the last update', () => {
    expect(livenessLevel('2026-08-05T11:59:56.000Z', now, INTERVAL)).toBe('live');
  });

  it('is "lagging" once one poll has clearly been missed', () => {
    expect(livenessLevel('2026-08-05T11:59:48.000Z', now, INTERVAL)).toBe('lagging');
  });

  it('is "stale" once six intervals have passed', () => {
    expect(livenessLevel('2026-08-05T11:59:25.000Z', now, INTERVAL)).toBe('stale');
  });

  it('treats a clock-skewed future timestamp as live rather than stale', () => {
    expect(livenessLevel('2026-08-05T12:00:02.000Z', now, INTERVAL)).toBe('live');
  });

  it('is "stale" for an unparseable timestamp', () => {
    expect(livenessLevel('not-a-date', now, INTERVAL)).toBe('stale');
  });
});

describe('lib/liveness.ts livenessLabel()', () => {
  it('says so plainly before the first load', () => {
    expect(livenessLabel(null, now, INTERVAL)).toBe('Connecting…');
  });

  it('pairs the level with the age of the data', () => {
    expect(livenessLabel('2026-08-05T11:59:56.000Z', now, INTERVAL)).toBe(
      'Live · updated just now',
    );
    expect(livenessLabel('2026-08-05T11:59:48.000Z', now, INTERVAL)).toBe(
      'Lagging · updated 12s ago',
    );
    expect(livenessLabel('2026-08-05T11:58:00.000Z', now, INTERVAL)).toBe('Stale · updated 2m ago');
  });
});

describe('lib/liveness.ts byRuntimeDesc()', () => {
  it('puts the longest-running agent first', () => {
    const sorted = byRuntimeDesc([
      entry('b', '2026-08-05T11:59:00.000Z'),
      entry('a', '2026-08-05T11:00:00.000Z'),
      entry('c', '2026-08-05T11:30:00.000Z'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });

  it('breaks ties on id so the order does not jitter between polls', () => {
    const sorted = byRuntimeDesc([
      entry('z', '2026-08-05T11:00:00.000Z'),
      entry('a', '2026-08-05T11:00:00.000Z'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'z']);
  });

  it('does not mutate its input', () => {
    const input = [entry('b', '2026-08-05T11:59:00.000Z'), entry('a', '2026-08-05T11:00:00.000Z')];
    byRuntimeDesc(input);
    expect(input.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('sorts unparseable timestamps last instead of scattering them', () => {
    const sorted = byRuntimeDesc([
      entry('bad', 'not-a-date'),
      entry('ok', '2026-08-05T11:59:00.000Z'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['ok', 'bad']);
  });
});

describe('lib/liveness.ts agentActivity()', () => {
  it("mirrors the factory's own staleness threshold (agents-registry.ts DEFAULT_STALE_HOURS = 4)", () => {
    expect(AGENT_STALE_AFTER_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('is "working" for an agent dispatched inside the window', () => {
    expect(agentActivity(entry('a', '2026-08-05T11:40:00.000Z'), now)).toBe('working');
  });

  it('is still "working" exactly at the threshold — the factory stales on >, not >=', () => {
    expect(agentActivity(entry('a', '2026-08-05T08:00:00.000Z'), now)).toBe('working');
  });

  it('is "stalled" once past the threshold', () => {
    expect(agentActivity(entry('a', '2026-08-05T07:59:59.000Z'), now)).toBe('stalled');
  });

  it('is "unknown" for an unreadable dispatch timestamp rather than guessing', () => {
    expect(agentActivity(entry('a', 'not-a-date'), now)).toBe('unknown');
  });

  it('is "unknown" when the clock it is measured against is unreadable', () => {
    expect(agentActivity(entry('a', '2026-08-05T11:40:00.000Z'), 'not-a-date')).toBe('unknown');
  });

  it('treats a clock-skewed future dispatch as working, not as 4h of runtime', () => {
    expect(agentActivity(entry('a', '2026-08-05T12:00:30.000Z'), now)).toBe('working');
  });
});

describe('lib/liveness.ts workingCount()', () => {
  it('counts only the entries inside the window', () => {
    expect(
      workingCount(
        [
          entry('a', '2026-08-05T11:40:00.000Z'),
          entry('b', '2026-08-05T03:00:00.000Z'),
          entry('c', 'not-a-date'),
        ],
        now,
      ),
    ).toBe(1);
  });

  it('is 0 for an empty group', () => {
    expect(workingCount([], now)).toBe(0);
  });
});

describe('lib/liveness.ts longestRunningSince()', () => {
  it('returns the oldest dispatch timestamp in the group', () => {
    expect(
      longestRunningSince([
        entry('b', '2026-08-05T11:59:00.000Z'),
        entry('a', '2026-08-05T11:00:00.000Z'),
      ]),
    ).toBe('2026-08-05T11:00:00.000Z');
  });

  it('returns null for an empty group', () => {
    expect(longestRunningSince([])).toBeNull();
  });

  it('returns null when no entry carries a usable timestamp', () => {
    expect(longestRunningSince([entry('bad', 'not-a-date')])).toBeNull();
  });
});

// Operator directive (dogfood round 2): "the now-running block should show the
// sessions that are running right now, with an animated indicator".
describe('lib/liveness.ts sessionActivity()', () => {
  it('is "active" while the session appended an event inside the window', () => {
    expect(sessionActivity('2026-08-05T11:52:00.000Z', now)).toBe('active');
  });

  it('is "active" at the window boundary and "idle" past it', () => {
    const boundary = new Date(new Date(now).getTime() - SESSION_ACTIVE_WITHIN_MS).toISOString();
    const pastIt = new Date(new Date(now).getTime() - SESSION_ACTIVE_WITHIN_MS - 1).toISOString();
    expect(sessionActivity(boundary, now)).toBe('active');
    expect(sessionActivity(pastIt, now)).toBe('idle');
  });

  it('is "idle" for a session whose last event is hours old', () => {
    expect(sessionActivity('2026-08-05T06:00:00.000Z', now)).toBe('idle');
  });

  it('is "unknown" — never animated — when the timestamp is unreadable', () => {
    expect(sessionActivity('not-a-date', now)).toBe('unknown');
    expect(sessionActivity('2026-08-05T11:59:00.000Z', 'not-a-date')).toBe('unknown');
  });

  it('clamps a browser clock running behind the server rather than reporting idle', () => {
    expect(sessionActivity('2026-08-05T12:00:30.000Z', now)).toBe('active');
  });
});

describe('lib/liveness.ts bySessionRecency()', () => {
  it('puts the most recently active session first', () => {
    expect(
      bySessionRecency([
        session('older', '2026-08-05T10:00:00.000Z'),
        session('newest', '2026-08-05T11:59:00.000Z'),
        session('middle', '2026-08-05T11:00:00.000Z'),
      ]).map((s) => s.sessionId),
    ).toEqual(['newest', 'middle', 'older']);
  });

  it('sorts unreadable timestamps last and breaks ties on sessionId', () => {
    expect(
      bySessionRecency([
        session('bad', 'not-a-date'),
        session('b', '2026-08-05T11:00:00.000Z'),
        session('a', '2026-08-05T11:00:00.000Z'),
      ]).map((s) => s.sessionId),
    ).toEqual(['a', 'b', 'bad']);
  });

  it('does not mutate its input', () => {
    const input = [session('a', '2026-08-05T10:00:00.000Z'), session('b', now)];
    bySessionRecency(input);
    expect(input.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});

describe('lib/liveness.ts activeSessionCount()', () => {
  it('counts only the sessions inside the activity window', () => {
    expect(
      activeSessionCount(
        [
          session('a', '2026-08-05T11:59:00.000Z'),
          session('b', '2026-08-05T06:00:00.000Z'),
          session('c', 'not-a-date'),
        ],
        now,
      ),
    ).toBe(1);
  });

  it('is 0 for no sessions', () => {
    expect(activeSessionCount([], now)).toBe(0);
  });
});

describe('lib/liveness.ts lastEventLabel()', () => {
  it('says the factory has never emitted rather than showing an empty age', () => {
    expect(lastEventLabel(null, now)).toBe('no events yet');
  });

  it('ages the last event, which is a different question from the poll age', () => {
    // livenessLabel would say "Live" for all three of these: the screen is
    // current in every case. Whether anything is *happening* is not.
    expect(lastEventLabel('2026-08-05T11:59:58.000Z', now)).toBe('last event just now');
    expect(lastEventLabel('2026-08-05T11:58:00.000Z', now)).toBe('last event 2m ago');
    expect(lastEventLabel('2026-08-01T12:00:00.000Z', now)).toBe('last event 4d ago');
  });
});
