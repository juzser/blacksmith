import { describe, expect, it } from 'vitest';
import type { LiveAgentEntry } from '../src/lib/api.js';
import {
  AGENT_STALE_AFTER_MS,
  agentActivity,
  isPastStaleWindow,
  workingAgents,
} from '../src/lib/liveness.js';

const now = '2026-08-05T12:00:00.000Z';

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

const WORKING_AT = '2026-08-05T11:40:00.000Z';
const STALLED_AT = '2026-08-05T07:00:00.000Z';

describe('lib/liveness.ts workingAgents()', () => {
  it('keeps only the entries inside the window, in input order', () => {
    const kept = workingAgents(
      [
        entry('b', WORKING_AT),
        entry('stalled', STALLED_AT),
        entry('a', '2026-08-05T11:00:00.000Z'),
        entry('bad', 'not-a-date'),
      ],
      now,
    );
    expect(kept.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('is still "working" exactly at the threshold and not one millisecond past it', () => {
    const boundary = new Date(new Date(now).getTime() - AGENT_STALE_AFTER_MS).toISOString();
    const pastIt = new Date(new Date(now).getTime() - AGENT_STALE_AFTER_MS - 1).toISOString();
    expect(
      workingAgents([entry('edge', boundary), entry('past', pastIt)], now).map((e) => e.id),
    ).toEqual(['edge']);
  });

  it('does not mutate its input', () => {
    const input = [entry('stalled', STALLED_AT), entry('a', WORKING_AT)];
    workingAgents(input, now);
    expect(input.map((e) => e.id)).toEqual(['stalled', 'a']);
  });
});

describe('isPastStaleWindow', () => {
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();

  it('answers false for an unparseable timestamp on either side', () => {
    expect(isPastStaleWindow('not-a-date', now)).toBe(false);
    expect(isPastStaleWindow(now, 'not-a-date')).toBe(false);
  });

  it('answers false for a start in the future', () => {
    expect(isPastStaleWindow(at(60_000), now)).toBe(false);
  });

  it('answers false at exactly the window and true 1 ms past it', () => {
    expect(isPastStaleWindow(at(-AGENT_STALE_AFTER_MS), now)).toBe(false);
    expect(isPastStaleWindow(at(-AGENT_STALE_AFTER_MS - 1), now)).toBe(true);
  });
});
