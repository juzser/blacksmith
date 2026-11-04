import { describe, expect, it } from 'vitest';
import { foldAgents, liveAgents } from '../src/agents-registry.js';
import type { StoredEvent } from '../src/events.js';

// A hook-recorded agent and a hand-written dispatch for the same real agent
// are one entry, not two, and a role-based close of the hand-written side
// closes that one entry.
const S = 's1';
let n = 0;
const ev = (event_type: string, payload: Record<string, unknown>, extra = {}): StoredEvent => ({
  event_id: `${S}#${n++}`,
  record: {
    ts: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    session_id: S,
    actor: 'orchestrator',
    event_type,
    plan_version: 1,
    causal_parent: null,
    payload,
    ...extra,
  } as StoredEvent['record'],
});
const hand = (role: string, task?: string) =>
  ev(
    'dispatch_decision',
    { agent_role: role, provider: 'claude', model_tier: 'mid' },
    task === undefined ? {} : { task_id: task },
  );
const start = (id: string, role: string) =>
  ev('subagent-started', { agent_role: role }, { agent_id: id });
const stop = (id: string, parent: string) =>
  ev('subagent-stopped', { agent_role: 'coder' }, { agent_id: id, causal_parent: parent });

describe('hook entries beside hand-written dispatches', () => {
  it('folds a hand-written dispatch plus a hook start of its role to one live entry', () => {
    const d = hand('coder', 'e/t1');
    const s = start('a1', 'coder');
    const agents = foldAgents([d, s]);
    expect(liveAgents(agents)).toHaveLength(1);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe('a1');
  });

  it('a role-based close plus the hook stop leaves nothing live', () => {
    const d = hand('coder');
    const s = start('a1', 'coder');
    const result = ev('task-result-recorded', { agent_role: 'coder' });
    const e = stop('a1', s.event_id);
    expect(liveAgents(foldAgents([d, s, result, e]))).toEqual([]);
    expect(liveAgents(foldAgents([d, s, e]))).toEqual([]);
  });

  it('a role-based close never takes a hook-only entry', () => {
    const s = start('a1', 'coder');
    const result = ev('task-result-recorded', { agent_role: 'coder' });
    expect(liveAgents(foldAgents([s, result]))).toHaveLength(1);
  });

  it('two concurrent same-role agents bind one to one', () => {
    const d1 = hand('coder', 'e/t1');
    const d2 = hand('coder', 'e/t2');
    const s1 = start('a1', 'coder');
    const s2 = start('a2', 'coder');
    const agents = foldAgents([d1, d2, s1, s2]);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.agentId).sort()).toEqual(['a1', 'a2']);
    const after = foldAgents([d1, d2, s1, s2, stop('a1', s1.event_id)]);
    expect(liveAgents(after).map((a) => a.agentId)).toEqual(['a2']);
    expect(
      liveAgents(foldAgents([d1, d2, s1, s2, stop('a1', s1.event_id), stop('a2', s2.event_id)])),
    ).toEqual([]);
  });

  it('a resumed agent folds to a second entry that its own stop closes', () => {
    const s1 = start('a1', 'coder');
    const e1 = stop('a1', s1.event_id);
    const s2 = start('a1', 'coder');
    const e2 = stop('a1', s2.event_id);
    expect(liveAgents(foldAgents([s1, e1, s2]))).toHaveLength(1);
    expect(liveAgents(foldAgents([s1, e1, s2, e2]))).toEqual([]);
  });

  it('a stop that arrives before its start closes that start when it lands', () => {
    const s = start('a1', 'coder');
    const e = stop('a1', s.event_id);
    expect(liveAgents(foldAgents([e, s]))).toEqual([]);
  });

  it('pairs a resumed agent by occurrence in any arrival order', () => {
    const s1 = start('a1', 'coder');
    const s2 = start('a1', 'coder');
    const e1 = stop('a1', s1.event_id);
    const e2 = stop('a1', s2.event_id);
    expect(liveAgents(foldAgents([s1, s2, e1, e2]))).toEqual([]);
    expect(liveAgents(foldAgents([s1, s2, e1]))).toHaveLength(1);
    expect(liveAgents(foldAgents([e1, s1, e2, s2]))).toEqual([]);
    expect(liveAgents(foldAgents([e1, s1, s2]))).toHaveLength(1);
  });

  it('keeps a bound pair live until its hook stop, whatever the hand terminal says', () => {
    const t1 = hand('coder', 'e/t1');
    const t2 = hand('coder', 'e/t2');
    const a1 = start('a1', 'coder');
    const a2 = start('a2', 'coder');
    const r1 = ev('task-result-recorded', { agent: 'coder' }, { task_id: 'e/t1' });
    // a1's hook stop, then t1's hand result: a2 is still running.
    expect(liveAgents(foldAgents([t1, t2, a1, a2, stop('a1', a1.event_id), r1]))).toHaveLength(1);
    // The same with the pair reversed (t2 result first, a1 stops).
    const r2 = ev('task-result-recorded', { agent: 'coder' }, { task_id: 'e/t2' });
    expect(liveAgents(foldAgents([t1, t2, a1, a2, r2, stop('a1', a1.event_id)]))).toHaveLength(1);
    // A hand result alone ends no bound pair.
    expect(liveAgents(foldAgents([t1, t2, a1, a2, r1, r2]))).toHaveLength(2);
    // Binding is oldest first.
    expect(foldAgents([t1, t2, a1, a2]).map((a) => [a.taskId, a.agentId])).toEqual([
      ['e/t1', 'a1'],
      ['e/t2', 'a2'],
    ]);
  });

  it('epic-closed ends a bound pair whose hook stop never came', () => {
    const t1 = hand('coder', 'e/t1');
    const a1 = start('a1', 'coder');
    const result = ev('task-result-recorded', { agent: 'coder' }, { task_id: 'e/t1' });
    const err = ev('error-logged', { agent_role: 'coder', task_ref: 'e/t1' });
    const closed = ev('epic-closed', { epic_id: 'e' });
    expect(liveAgents(foldAgents([t1, a1, result, err]))).toHaveLength(1);
    expect(liveAgents(foldAgents([t1, a1, result, err, closed]))).toEqual([]);
    expect(liveAgents(foldAgents([t1, a1, closed]))).toEqual([]);
  });
});
