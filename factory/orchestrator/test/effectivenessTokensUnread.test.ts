import { describe, expect, it } from 'vitest';
import { effectiveness } from '../src/db/effectiveness.js';
import type { StoredEvent } from '../src/events.js';
import type { SessionTokens } from '../src/transcriptTokens.js';

const CLI = '11111111-2222-4333-8444-555555555555';

let seq = 0;
function ev(
  event_type: string,
  payload: Record<string, unknown>,
  extra: { task_id?: string; agent_id?: string; cli_session_id?: string } = {},
): StoredEvent {
  seq += 1;
  return {
    event_id: `sess-u#${seq}`,
    record: {
      session_id: 'sess-u',
      actor: 'orchestrator',
      event_type,
      plan_version: 1,
      causal_parent: null,
      payload,
      ts: `2026-10-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
      ...extra,
    },
  };
}

const dispatch = (agent: string, task = 't1', role = 'coder') =>
  ev(
    'dispatch_decision',
    { agent_role: role },
    { task_id: task, agent_id: agent, cli_session_id: CLI },
  );

const row = (agentId: string) => ({ agentId, role: null, used: 100, complete: true });
const reading = (s: SessionTokens) => async (): Promise<SessionTokens> => s;

describe('effectiveness tokens for dispatched agents the reader returned no row for', () => {
  it('marks task and role incomplete when one of two dispatched agents has no row', async () => {
    const r = await effectiveness([dispatch('a1'), dispatch('a2')], {
      readTokens: reading({ used: 100, complete: true, subagents: [row('a1')] }),
    });
    expect(r.tokens.byTask.t1).toEqual({ used: 100, complete: false, agentIds: ['a1'] });
    expect(r.tokens.byRole.coder?.complete).toBe(false);
    expect(r.tokens.complete).toBe(false);
  });

  it('creates incomplete totals when the transcript cannot be read at all', async () => {
    const r = await effectiveness([dispatch('a1')], {
      readTokens: reading({ used: 0, complete: false, subagents: [] }),
    });
    expect(r.tokens.byTask.t1).toEqual({ used: 0, complete: false, agentIds: [] });
    expect(r.tokens.byRole.coder).toEqual({ used: 0, complete: false, agentIds: [] });
  });

  it('keeps every total complete when the reader returns every dispatched agent', async () => {
    const r = await effectiveness([dispatch('a1'), dispatch('a2')], {
      readTokens: reading({ used: 200, complete: true, subagents: [row('a1'), row('a2')] }),
    });
    expect(r.tokens.byTask.t1).toEqual({ used: 200, complete: true, agentIds: ['a1', 'a2'] });
    expect(r.tokens.byRole.coder?.complete).toBe(true);
    expect(r.tokens.complete).toBe(true);
  });

  it('marks unattributed incomplete for an unread agent with neither task nor role', async () => {
    const bare = ev('dispatch_decision', {}, { agent_id: 'a9', cli_session_id: CLI });
    const r = await effectiveness([bare], {
      readTokens: reading({ used: 0, complete: true, subagents: [] }),
    });
    expect(r.tokens.unattributed.complete).toBe(false);
    expect(r.tokens.byTask).toEqual({});
    expect(r.tokens.byRole).toEqual({});
  });
});
