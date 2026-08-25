import { describe, expect, it } from 'vitest';
import { agentScopeLabel } from '../src/lib/agentScope.js';
import type { LiveAgentEntry } from '../src/lib/api.js';

function entry(over: Partial<LiveAgentEntry> = {}): LiveAgentEntry {
  return {
    id: 'e1',
    sessionId: 'sess-1',
    agentRole: 'planner',
    provider: 'claude',
    modelTier: 'frontier',
    taskId: null,
    epicId: null,
    dispatchedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('agentScopeLabel', () => {
  it('names the task when there is one', () => {
    expect(agentScopeLabel(entry({ taskId: 'epic-1/task-2', epicId: 'epic-1' }))).toBe(
      'epic-1/task-2',
    );
  });

  // The whole point of D-234: a planner, a spec-reviewer, a scribe and the
  // epic-close judges are dispatched for the epic and never hold a task, and
  // half the live fleet in the real state/smith.db is one of these. "no task
  // assigned" was true of the column and false of the agent.
  it('names the epic when the agent works on one and has no task', () => {
    expect(agentScopeLabel(entry({ epicId: 'demo-rpg-story-engine' }))).toBe(
      'epic: demo-rpg-story-engine',
    );
  });

  // Nothing in the log places it, and inventing a scope is the failure this
  // whole change exists to stop. Left saying exactly what is known.
  it('still says no task assigned when nothing places the agent', () => {
    expect(agentScopeLabel(entry())).toBe('no task assigned');
  });

  // An empty string is not an epic id. Falsy-but-present values are how a
  // wrong-shaped value reaches a render without anything throwing.
  it('treats an empty id as absent', () => {
    expect(agentScopeLabel(entry({ taskId: '', epicId: '' }))).toBe('no task assigned');
  });
});
