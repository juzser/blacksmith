import { describe, expect, it } from 'vitest';
import { checkDelegationLog, type DelegationPolicy } from '../src/delegation.js';
import type { StoredEvent } from '../src/events.js';

// A continuation dispatch C (continuation_of = O) is answered by the session it
// opened itself, else by the one its chain's original opened.

const POLICY: DelegationPolicy = {
  grants: [{ role: 'wave-runner', mayDispatch: ['coder'], mustOpenSession: true }],
} as unknown as DelegationPolicy;

let n = 0;
function ev(
  sessionId: string,
  index: number,
  eventType: string,
  parent: string | null,
  payload: Record<string, unknown> = {},
): StoredEvent {
  n += 1;
  return {
    event_id: `${sessionId}#${index}`,
    record: {
      session_id: sessionId,
      actor: 'system',
      event_type: eventType,
      task_id: 'E1/t-1',
      plan_version: 1,
      causal_parent: parent,
      ts: `2026-09-03T10:${String(n).padStart(2, '0')}:00.000Z`,
      payload,
    },
  };
}

const dispatchOf = (index: number, extra: Record<string, unknown> = {}) =>
  ev('epic-1', index, 'dispatch_decision', 'epic-1#0', {
    agent_role: 'wave-runner',
    provider: 'claude',
    model_tier: 'frontier',
    model: 'claude-opus-5',
    ...extra,
  });

const summary = (events: StoredEvent[]) =>
  checkDelegationLog(events, POLICY, { sessionId: 'epic-1' }).checks.map(
    (c) => `${c.eventId}:${c.status}:${c.sessionId}`,
  );

describe('a continuation dispatch and the session that answers it', () => {
  it('verifies ok under its own session when the original opened none', () => {
    const events = [
      ev('epic-1', 0, 'session-start', null),
      dispatchOf(1),
      dispatchOf(2, { continuation_of: 'epic-1#1' }),
      ev('wave-2', 0, 'session-start', 'epic-1#2'),
    ];
    expect(summary(events)).toEqual(['epic-1#1:unverifiable:epic-1', 'epic-1#2:ok:wave-2']);
  });

  it('verifies ok under its own session even when the original opened another', () => {
    const events = [
      ev('epic-1', 0, 'session-start', null),
      dispatchOf(1),
      ev('wave-1', 0, 'session-start', 'epic-1#1'),
      dispatchOf(2, { continuation_of: 'epic-1#1' }),
      ev('wave-2', 0, 'session-start', 'epic-1#2'),
    ];
    expect(summary(events)).toEqual(['epic-1#1:ok:wave-1', 'epic-1#2:ok:wave-2']);
  });

  it('still answers a continuation with no session of its own under the original', () => {
    const events = [
      ev('epic-1', 0, 'session-start', null),
      dispatchOf(1),
      ev('wave-1', 0, 'session-start', 'epic-1#1'),
      dispatchOf(2, { continuation_of: 'epic-1#1' }),
    ];
    expect(summary(events)).toEqual(['epic-1#1:ok:wave-1', 'epic-1#2:ok:wave-1']);
  });

  it('still fails a dispatch with neither a session of its own nor an original', () => {
    const events = [ev('epic-1', 0, 'session-start', null), dispatchOf(1)];
    expect(summary(events)).toEqual(['epic-1#1:unverifiable:epic-1']);
  });
});
