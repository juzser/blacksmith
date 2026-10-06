import { describe, expect, it } from 'vitest';
import { agentStatus, lastStepLabel, tokenDisplay } from '../src/lib/agentStatus.js';
import type { SessionAgent } from '../src/lib/api.js';

const now = '2026-08-05T12:00:00.000Z';

function agent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'a1',
    agentRole: 'coder',
    provider: 'anthropic',
    modelTier: 'sonnet',
    taskId: 'T-1',
    taskTitle: 'Title',
    epicId: 'epic-1',
    round: 1,
    dispatchedAt: '2026-08-05T11:00:00.000Z',
    terminalAt: null,
    terminalType: null,
    status: 'live',
    tokens: { state: 'pending' },
    lastEventType: null,
    lastEventAt: null,
    ...overrides,
  };
}

describe('agentStatus', () => {
  it('reports a live agent dispatched recently as Working', () => {
    expect(agentStatus(agent({ status: 'live' }), now)).toEqual({
      state: 'working',
      label: 'Working',
      tone: 'progress',
    });
  });

  it('reports a live agent dispatched over 4h ago with no terminal as the anomaly state', () => {
    const stale = agent({ status: 'live', dispatchedAt: '2026-08-05T07:59:00.000Z' });
    expect(agentStatus(stale, now)).toEqual({
      state: 'no-result',
      label: 'No result after 4h',
      tone: 'warning',
    });
  });

  it('does not flag a live agent exactly at the 4h boundary', () => {
    const boundary = agent({ status: 'live', dispatchedAt: '2026-08-05T08:00:00.000Z' });
    expect(agentStatus(boundary, now).state).toBe('working');
  });

  it('reports a done agent as Done', () => {
    expect(agentStatus(agent({ status: 'done' }), now)).toEqual({
      state: 'done',
      label: 'Done',
      tone: 'done',
    });
  });

  it('reports an error agent as Failed', () => {
    expect(agentStatus(agent({ status: 'error' }), now)).toEqual({
      state: 'failed',
      label: 'Failed',
      tone: 'danger',
    });
  });

  it('reports a superseded agent as Stopped', () => {
    expect(agentStatus(agent({ status: 'superseded' }), now)).toEqual({
      state: 'stopped',
      label: 'Stopped',
      tone: 'neutral',
    });
  });

  it('reports an abandoned agent as Stopped', () => {
    expect(agentStatus(agent({ status: 'abandoned' }), now)).toEqual({
      state: 'stopped',
      label: 'Stopped',
      tone: 'neutral',
    });
  });
});

describe('tokenDisplay', () => {
  it('shows CompactNumber-ready input/output when measured', () => {
    expect(
      tokenDisplay(agent({ tokens: { state: 'measured', input: 1200, output: 340, total: 1540 } })),
    ).toEqual({ kind: 'measured', input: 1200, output: 340 });
  });

  it('shows "not measured" text, never 0, when unmeasured', () => {
    expect(tokenDisplay(agent({ tokens: { state: 'unmeasured' } }))).toEqual({
      kind: 'text',
      text: 'not measured',
    });
  });

  it('shows "Running" text when pending', () => {
    expect(tokenDisplay(agent({ tokens: { state: 'pending' } }))).toEqual({
      kind: 'text',
      text: 'Running',
    });
  });

  it('shows nothing when none', () => {
    expect(tokenDisplay(agent({ tokens: { state: 'none' } }))).toEqual({ kind: 'none' });
  });
});

describe('lastStepLabel', () => {
  it('says there are no events yet when lastEventType is null', () => {
    expect(lastStepLabel(null)).toBe('No events yet');
  });

  it('humanizes an event type titleFor has no special case for', () => {
    expect(lastStepLabel('operator-feedback-resolved')).toBe('Operator feedback resolved');
  });

  it('runs a known event type through titleFor, with no payload to read from', () => {
    expect(lastStepLabel('user_prompt')).toBe('');
  });

  it('names the role and the task for a dispatch, with no tier/provider', () => {
    const label = lastStepLabel('dispatch_decision', { role: 'coder', task: 'Fix the thing' });
    expect(label).toBe('Dispatched Builder · Fix the thing');
    expect(label).not.toContain('(/)');
  });

  it('never prints "(/)" for a dispatch the API gave no detail for', () => {
    expect(lastStepLabel('dispatch_decision')).not.toMatch(/\(\/\)|\/\)/);
  });
});
