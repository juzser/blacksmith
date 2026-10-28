import { describe, expect, it } from 'vitest';
import { effectiveness } from '../src/db/effectiveness.js';
import type { StoredEvent } from '../src/events.js';
import type { SessionTokens } from '../src/transcriptTokens.js';

const CLI = '11111111-2222-4333-8444-555555555555';
const RESERVED = ['__proto__', 'constructor', 'toString'];

let seq = 0;
function ev(
  event_type: string,
  payload: Record<string, unknown>,
  extra: { task_id?: string; agent_id?: string; cli_session_id?: string } = {},
): StoredEvent {
  seq += 1;
  return {
    event_id: `sess-r#${seq}`,
    record: {
      session_id: 'sess-r',
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

const read = async (): Promise<SessionTokens> => ({
  used: 100,
  complete: true,
  subagents: [{ agentId: 'agent-x', role: null, used: 40, complete: true }],
});

describe('effectiveness with reserved object keys as ids', () => {
  for (const id of RESERVED) {
    it(`folds task id and role "${id}" into buckets of their own`, async () => {
      const events = [
        ev(
          'dispatch_decision',
          { agent_role: id },
          { task_id: id, agent_id: 'agent-x', cli_session_id: CLI },
        ),
        ev('dispatch_decision', { agent_role: 'coder' }, { task_id: 't1', agent_id: 'agent-y' }),
      ];
      const r = await effectiveness(events, { readTokens: read });
      expect(Object.hasOwn(r.tokens.byTask, id)).toBe(true);
      expect(Object.hasOwn(r.tokens.byRole, id)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(r.tokens.byTask, id)?.value).toEqual({
        used: 40,
        complete: true,
        agentIds: ['agent-x'],
      });
      expect(Object.getOwnPropertyDescriptor(r.tokens.byRole, id)?.value?.used).toBe(40);
      expect(Object.keys(r.tokens.byTask)).toEqual([id]);
      expect(r.tokens.unattributed.used).toBe(60);
      expect(Object.hasOwn(Object.prototype, 'used')).toBe(false);
      expect(Object.hasOwn(Object.prototype, 'agentIds')).toBe(false);
      expect(JSON.stringify(r.tokens.byTask)).toBe(
        `{${JSON.stringify(id)}:{"used":40,"complete":true,"agentIds":["agent-x"]}}`,
      );
    });

    it(`accumulates two agents into one "${id}" bucket`, async () => {
      const events = [
        ev(
          'dispatch_decision',
          { agent_role: id },
          { task_id: id, agent_id: 'agent-x', cli_session_id: CLI },
        ),
        ev('dispatch_decision', { agent_role: id }, { task_id: id, agent_id: 'agent-z' }),
      ];
      const two = async (): Promise<SessionTokens> => ({
        used: 100,
        complete: true,
        subagents: [
          { agentId: 'agent-x', role: null, used: 40, complete: true },
          { agentId: 'agent-z', role: null, used: 10, complete: false },
        ],
      });
      const r = await effectiveness(events, { readTokens: two });
      expect(Object.keys(r.tokens.byTask)).toEqual([id]);
      expect(Object.getOwnPropertyDescriptor(r.tokens.byTask, id)?.value).toEqual({
        used: 50,
        complete: false,
        agentIds: ['agent-x', 'agent-z'],
      });
      expect(Object.hasOwn(Object.prototype, 'used')).toBe(false);
    });

    it(`counts precision for a finder named "${id}"`, async () => {
      const events = [
        ev('finding-raised', {
          finding_id: 'f1',
          task_id: 't1',
          fingerprint: 'fp-f1',
          finding_category: 'correctness',
          severity: 'S2-major',
          finding_status: 'confirmed',
          summary: 'placeholder',
          failure_scenario: { inputs: 'a', expected: 'b', actual: 'c' },
          found_by: id,
        }),
      ];
      const r = await effectiveness(events, { readTokens: read });
      expect(Object.getOwnPropertyDescriptor(r.precision, id)?.value?.confirmed).toBe(1);
      expect(Object.hasOwn(Object.prototype, 'confirmed')).toBe(false);
    });
  }
});
