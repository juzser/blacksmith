import { describe, expect, it } from 'vitest';
import { effectiveness } from '../src/db/effectiveness.js';
import type { StoredEvent } from '../src/events.js';
import type { SessionTokens } from '../src/transcriptTokens.js';

const CLI_A = '11111111-2222-4333-8444-555555555555';
const CLI_B = '66666666-7777-4888-8999-000000000000';

let seq = 0;
function ev(
  event_type: string,
  payload: Record<string, unknown>,
  extra: { task_id?: string; agent_id?: string; cli_session_id?: string } = {},
): StoredEvent {
  seq += 1;
  return {
    event_id: `sess-x#${seq}`,
    record: {
      session_id: 'sess-x',
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

const dispatch = (task: string, role: string, agentId: string, cli = CLI_A) =>
  ev(
    'dispatch_decision',
    { agent_role: role },
    { task_id: task, agent_id: agentId, cli_session_id: cli },
  );

const sub = (agentId: string, used: number, complete = true) => ({
  agentId,
  role: null,
  used,
  complete,
});

function reader(table: Record<string, SessionTokens>) {
  return async (id: string): Promise<SessionTokens> =>
    table[id] ?? { used: 0, complete: false, subagents: [] };
}

const finding = (id: string, task: string, found_by: string, status = 'raised') =>
  ev('finding-raised', {
    finding_id: id,
    task_id: task,
    fingerprint: `fp-${id}`,
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: status,
    summary: 'placeholder',
    failure_scenario: { inputs: 'a', expected: 'b', actual: 'c' },
    found_by,
  });
const transition = (id: string, to: string) =>
  ev('finding-transitioned', { finding_id: id, to_status: to });
const merged = (...ids: string[]) => ev('wave-merged', { task_ids: ids });
const gate = (task: string, outcome: string) => ev('gate-outcome', { outcome }, { task_id: task });

describe('effectiveness tokens', () => {
  it('sums sub-agent tokens per task and role, and reports the rest as unattributed', async () => {
    const events = [
      dispatch('t1', 'coder', 'agent-a'),
      dispatch('t1', 'reviewer', 'agent-b'),
      dispatch('t2', 'coder', 'agent-c'),
    ];
    const read = reader({
      [CLI_A]: {
        used: 1000,
        complete: true,
        subagents: [
          sub('agent-a', 100),
          sub('agent-b', 200),
          sub('agent-c', 300),
          sub('agent-z', 50),
        ],
      },
    });
    const r = await effectiveness(events, { readTokens: read });
    expect(r.tokens.byTask.t1?.used).toBe(300);
    expect(r.tokens.byTask.t2?.used).toBe(300);
    expect(r.tokens.byRole.coder?.used).toBe(400);
    expect(r.tokens.byRole.reviewer?.used).toBe(200);
    // main thread (1000 - 650) plus the sub-agent no dispatch names (50)
    expect(r.tokens.unattributed.used).toBe(400);
    expect(r.tokens.unattributed.agentIds).toEqual(['agent-z']);
    expect(r.tokens.byTask.t1?.agentIds).toEqual(['agent-a', 'agent-b']);
    expect(r.tokens.complete).toBe(true);
  });

  it('propagates complete:false from a partial transcript to every total it feeds only', async () => {
    const events = [dispatch('t1', 'coder', 'agent-a'), dispatch('t2', 'coder', 'agent-c', CLI_B)];
    const read = reader({
      [CLI_A]: { used: 100, complete: false, subagents: [sub('agent-a', 100, false)] },
      [CLI_B]: { used: 300, complete: true, subagents: [sub('agent-c', 300)] },
    });
    const r = await effectiveness(events, { readTokens: read });
    expect(r.tokens.byTask.t1?.complete).toBe(false);
    expect(r.tokens.byTask.t2?.complete).toBe(true);
    expect(r.tokens.byRole.coder?.complete).toBe(false);
    expect(r.tokens.complete).toBe(false);
  });

  it('marks everything incomplete when a session transcript cannot be read', async () => {
    const events = [dispatch('t1', 'coder', 'agent-a')];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.tokens.unattributed.complete).toBe(false);
    expect(r.tokens.complete).toBe(false);
  });

  it('counts measured and unmeasured results with their event ids', async () => {
    const good = ev(
      'task-result-recorded',
      { token_usage: { total_tokens: 5000 } },
      { task_id: 't1' },
    );
    const bad = ev('task-result-recorded', { token_usage: { measured: false } }, { task_id: 't2' });
    const r = await effectiveness([good, bad], { readTokens: reader({}) });
    expect(r.tokens.resultsMeasured).toBe(1);
    expect(r.tokens.resultsUnmeasured).toBe(1);
    expect(r.tokens.resultEventIds).toEqual({
      measured: [good.event_id],
      unmeasured: [bad.event_id],
    });
  });
});

describe('effectiveness escaped defects', () => {
  it('counts confirmed and fix-* findings raised after a merge on a passing gate', async () => {
    const events = [
      gate('t1', 'pass'),
      merged('t1'),
      finding('f1', 't1', 'reviewer'),
      transition('f1', 'confirmed'),
      finding('f2', 't1', 'reviewer'),
      transition('f2', 'confirmed'),
      transition('f2', 'fix-pending'),
      transition('f2', 'fix-landed'),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.escapedDefects.count).toBe(2);
    expect(r.escapedDefects.pending).toBe(0);
    expect(r.escapedDefects.items.map((i) => i.findingId)).toEqual(['f1', 'f2']);
  });

  it('reports a still-raised finding as pending and excludes a refuted one', async () => {
    const events = [
      gate('t1', 'pass-with-waivers-pending'),
      merged('t1'),
      finding('f1', 't1', 'reviewer'),
      finding('f2', 't1', 'reviewer'),
      transition('f2', 'refuted'),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.escapedDefects.count).toBe(0);
    expect(r.escapedDefects.pending).toBe(1);
    expect(r.escapedDefects.items.map((i) => [i.findingId, i.state])).toEqual([['f1', 'pending']]);
    expect(r.escapedDefects.excluded).toEqual(['f2']);
  });

  it('ignores findings raised before the merge and tasks without a passing gate', async () => {
    const events = [
      gate('t1', 'pass'),
      finding('early', 't1', 'reviewer'),
      transition('early', 'confirmed'),
      merged('t1'),
      gate('t2', 'blocked'),
      merged('t2'),
      finding('blocked', 't2', 'reviewer'),
      transition('blocked', 'confirmed'),
      merged('t3'),
      finding('nogate', 't3', 'reviewer'),
      transition('nogate', 'confirmed'),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.escapedDefects.count).toBe(0);
    expect(r.escapedDefects.items).toEqual([]);
  });

  it('uses the latest gate-outcome before the merge, across id spellings', async () => {
    const events = [
      gate('epic-1/t1', 'blocked'),
      gate('t1', 'pass'),
      merged('epic-1/t1'),
      finding('f1', 't1', 'reviewer'),
      transition('f1', 'confirmed'),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.escapedDefects.count).toBe(1);
  });

  it('counts an opened issue reported after the merge', async () => {
    const events = [
      gate('t1', 'pass'),
      merged('t1'),
      ev('issue-reported', { outcome: 'opened', task_ref: 't1' }),
      ev('issue-reported', { outcome: 'skipped-disabled', task_ref: 't1' }),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.escapedDefects.count).toBe(1);
    expect(r.escapedDefects.items[0]?.kind).toBe('issue');
  });
});

describe('effectiveness precision', () => {
  it('reads 0.75 for 3 confirmed and 1 refuted, with the counts', async () => {
    const events = [
      ...['a', 'b', 'c'].flatMap((id) => [
        finding(id, 't1', 'reviewer'),
        transition(id, 'confirmed'),
      ]),
      finding('d', 't1', 'reviewer'),
      transition('d', 'refuted'),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.precision.reviewer).toMatchObject({
      value: 0.75,
      confirmed: 3,
      refuted: 1,
      waived: 0,
    });
  });

  it('reads null, not 0, for a role with no decided findings', async () => {
    const r = await effectiveness([finding('a', 't1', 'tester')], { readTokens: reader({}) });
    expect(r.precision.tester?.value).toBeNull();
    expect(r.precision.tester).toMatchObject({ confirmed: 0, refuted: 0, waived: 0 });
  });

  it('counts waived in the denominator and a fixed finding as confirmed', async () => {
    const events = [
      finding('a', 't1', 'verifier'),
      transition('a', 'confirmed'),
      transition('a', 'fix-pending'),
      finding('b', 't1', 'verifier'),
      transition('b', 'waived'),
    ];
    const r = await effectiveness(events, { readTokens: reader({}) });
    expect(r.precision.verifier).toMatchObject({ value: 0.5, confirmed: 1, waived: 1 });
    expect(r.precision.verifier?.ids.waived).toEqual(['b']);
  });
});
