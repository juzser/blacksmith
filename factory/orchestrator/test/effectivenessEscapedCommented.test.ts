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
    event_id: `sess-c#${seq}`,
    record: {
      session_id: 'sess-c',
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

const issue = (outcome: string, fingerprint?: string) =>
  ev('issue-reported', {
    outcome,
    task_ref: 't1',
    ...(fingerprint === undefined ? {} : { fingerprint }),
  });

async function count(...reports: StoredEvent[]) {
  const events = [
    ev('gate-outcome', { outcome: 'pass' }, { task_id: 't1' }),
    ev('wave-merged', { task_ids: ['t1'] }),
    ...reports,
  ];
  return (await effectiveness(events, { readTokens: none })).escapedDefects;
}

describe('escaped issue reports per fingerprint', () => {
  it('counts an opened report and a later comment on the same fingerprint once', async () => {
    const r = await count(issue('opened', 'fp1'), issue('commented', 'fp1'));
    expect(r.count).toBe(1);
    expect(r.items).toHaveLength(1);
  });

  it('counts two opened reports on the same fingerprint once', async () => {
    const r = await count(issue('opened', 'fp1'), issue('opened', 'fp1'));
    expect(r.count).toBe(1);
  });

  it('counts a comment with no earlier opened report once', async () => {
    const r = await count(issue('commented', 'fp1'), issue('commented', 'fp1'));
    expect(r.count).toBe(1);
  });

  it('counts different fingerprints separately', async () => {
    const r = await count(issue('opened', 'fp1'), issue('opened', 'fp2'));
    expect(r.count).toBe(2);
  });

  it('counts each report that carries no fingerprint', async () => {
    const r = await count(issue('opened'), issue('commented'));
    expect(r.count).toBe(2);
  });
});
