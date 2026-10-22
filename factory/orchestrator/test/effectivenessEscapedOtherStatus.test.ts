import { describe, expect, it } from 'vitest';
import { effectiveness } from '../src/db/effectiveness.js';
import type { StoredEvent } from '../src/events.js';

let seq = 0;
function ev(
  event_type: string,
  payload: Record<string, unknown>,
  extra: { task_id?: string } = {},
): StoredEvent {
  seq += 1;
  return {
    event_id: `sess-o#${seq}`,
    record: {
      session_id: 'sess-o',
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

const none = async () => ({ used: 0, complete: true, subagents: [] });

function scenario(...statuses: string[]): StoredEvent[] {
  return [
    ev('gate-outcome', { outcome: 'pass' }, { task_id: 't1' }),
    ev('wave-merged', { task_ids: ['t1'] }),
    ev('finding-raised', {
      finding_id: 'w',
      task_id: 't1',
      fingerprint: 'fp-w',
      finding_category: 'correctness',
      severity: 'S2-major',
      finding_status: 'raised',
      summary: 'placeholder',
      failure_scenario: { inputs: 'a', expected: 'b', actual: 'c' },
      found_by: 'reviewer',
    }),
    ...statuses.map((to) => ev('finding-transitioned', { finding_id: 'w', to_status: to })),
  ];
}

describe('escaped findings in other statuses', () => {
  for (const status of ['waived', 'expired', 'amend-pending', 'amended', 'some-future-status']) {
    it(`lists a ${status} escape-window finding under uncounted, outside the count`, async () => {
      const r = await effectiveness(scenario('confirmed', status), { readTokens: none });
      expect(r.escapedDefects.uncounted).toEqual([{ findingId: 'w', status }]);
      expect(r.escapedDefects.count).toBe(0);
      expect(r.escapedDefects.pending).toBe(0);
      expect(r.escapedDefects.items).toEqual([]);
      expect(r.escapedDefects.excluded).toEqual([]);
    });
  }

  it('keeps a refuted finding in excluded only', async () => {
    const r = await effectiveness(scenario('refuted'), { readTokens: none });
    expect(r.escapedDefects.excluded).toEqual(['w']);
    expect(r.escapedDefects.uncounted).toEqual([]);
  });
});
