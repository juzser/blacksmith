import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import { openQuorumEscalations, summariseEscalations } from '../src/quorumEscalations.js';

// ---------------------------------------------------------------------------
// D-201's tail. The `quorum-decision` event has been written on every case
// since the cross-check shipped, and nothing ever read one back. The gate
// outcome was the only surface: a finding the quorum could not settle showed
// up as a blocked gate in one run and was gone by the next, and a shadow-only
// disagreement -- gate.ts pushes an escalation only `if (hadActiveJudge)` --
// was recorded in the log and reported nowhere at all.
//
// So the question "which cross-provider disagreements is the operator still
// owed?" had no answer, in a repo whose whole doctrine is that judgment is
// never rendered in isolation. This fold is the answer, and it is a fold over
// the log rather than a new table because the facts were already all there.
//
// Three emitters write the event -- gate.ts (a finding), epic.ts (a final
// verdict), planQuorum.ts (a plan critique) -- with three payload shapes that
// share a core. The fold reads the core and discriminates on what only one of
// them carries: `fingerprint` is the gate's, `plan_version` in the payload is
// planQuorum's, and neither is the epic's.
// ---------------------------------------------------------------------------

let seq = 0;

/** Default `ts` just has to be monotonic; the tests that care pass one. */
function ev(payload: Record<string, unknown>, ts?: string): StoredEvent {
  seq += 1;
  return {
    event_id: `e${seq}`,
    record: {
      session_id: 's1',
      actor: 'system',
      event_type: 'quorum-decision',
      task_id: String(payload.task_id ?? 't1'),
      plan_version: 1,
      causal_parent: null,
      payload,
      ts: ts ?? `2026-09-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    },
  };
}

function findingEscalation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 't1',
    finding_id: 'f1',
    fingerprint: 'fp-1',
    trigger_reason: 'severity-s1',
    finder_provider: 'claude',
    outcome: 'escalate',
    decision: null,
    agreement: null,
    gating_participants: [],
    escalation_reason: 'disagreement',
    rationales: [
      { provider: 'claude', verdict: 'confirm', rationale: 'unchecked index' },
      { provider: 'codex', verdict: 'refute', rationale: 'guarded two lines up' },
    ],
    participants: [
      {
        provider: 'claude',
        mode: 'native',
        ok: true,
        verdict: 'confirm',
        excluded_as_finder: true,
      },
      { provider: 'codex', mode: 'active', ok: true, verdict: 'refute', excluded_as_finder: false },
    ],
    native_verdict: 'confirm',
    blocks: true,
    ...over,
  };
}

describe('openQuorumEscalations()', () => {
  it('reads a finding escalation out of the log', () => {
    const open = openQuorumEscalations([ev(findingEscalation())]);

    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      subject: 'finding',
      reason: 'disagreement',
      taskId: 't1',
      findingId: 'f1',
      fingerprint: 'fp-1',
      finderProvider: 'claude',
      held: true,
    });
    expect(open[0]?.rationales).toHaveLength(2);
  });

  it('ignores every event type that is not a quorum-decision', () => {
    const noise: StoredEvent = {
      event_id: 'x1',
      record: {
        session_id: 's1',
        actor: 'system',
        event_type: 'judge-verdict',
        plan_version: 1,
        causal_parent: null,
        payload: { outcome: 'escalate' },
        ts: '2026-09-01T00:00:00.000Z',
      },
    };
    expect(openQuorumEscalations([noise])).toEqual([]);
  });

  it('drops a case the quorum later decided', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation(), '2026-09-01T00:00:00.000Z'),
      ev(
        findingEscalation({
          outcome: 'decided',
          decision: 'refute',
          agreement: '2-of-2',
          escalation_reason: null,
          rationales: [],
          blocks: false,
        }),
        '2026-09-02T00:00:00.000Z',
      ),
    ]);
    expect(open).toEqual([]);
  });

  // The other direction: a case that was settled once and escalated again on a
  // later run is open again. Latest word per case wins, not first, and not
  // "any escalation ever".
  it('reopens a case that escalated after it was decided', () => {
    const open = openQuorumEscalations([
      ev(
        findingEscalation({ outcome: 'decided', decision: 'confirm', escalation_reason: null }),
        '2026-09-01T00:00:00.000Z',
      ),
      ev(findingEscalation(), '2026-09-02T00:00:00.000Z'),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.ts).toBe('2026-09-02T00:00:00.000Z');
  });

  // The fingerprint is the identity, not the finding id: a re-run of the same
  // gate mints a fresh finding_id for the same defect, and keying on that
  // would report one disagreement as two.
  it('keys a finding on its fingerprint, not its finding id', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation(), '2026-09-01T00:00:00.000Z'),
      ev(findingEscalation({ finding_id: 'f2' }), '2026-09-02T00:00:00.000Z'),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.findingId).toBe('f2');
  });

  it('separates two fingerprints on the same task', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation()),
      ev(findingEscalation({ fingerprint: 'fp-2', finding_id: 'f2' })),
    ]);
    expect(open).toHaveLength(2);
  });

  it('reads an epic verdict escalation and normalises `ready` into `held`', () => {
    const open = openQuorumEscalations([
      ev({
        task_id: 'epic-a/integration',
        epic_id: 'epic-a',
        finding_id: null,
        trigger_reason: 'epic-final-verdict',
        finder_provider: 'claude',
        outcome: 'escalate',
        escalation_reason: 'disagreement',
        rationales: [],
        participants: [],
        native_verdict: 'confirm',
        ready: false,
      }),
    ]);
    expect(open[0]).toMatchObject({
      subject: 'epic',
      epicId: 'epic-a',
      taskId: 'epic-a/integration',
      fingerprint: null,
      findingId: null,
      held: true,
    });
  });

  it('reads a plan critique escalation and normalises `sound` into `held`', () => {
    const open = openQuorumEscalations([
      ev({
        task_id: 'epic-a/plan@3',
        epic_id: 'epic-a',
        plan_version: 3,
        finding_id: null,
        trigger_reason: 'low-confidence-plan',
        finder_provider: 'claude',
        outcome: 'escalate',
        escalation_reason: 'insufficient-providers',
        rationales: [],
        participants: [],
        native_verdict: 'confirm',
        fired_triggers: ['confidence 0.4 < 0.6'],
        sound: false,
      }),
    ]);
    expect(open[0]).toMatchObject({
      subject: 'plan',
      epicId: 'epic-a',
      planVersion: 3,
      reason: 'insufficient-providers',
      held: true,
    });
  });

  // planQuorum's `not-run` is a real outcome, not a missing one: no quorum was
  // called at all. It closes a case exactly like `decided` does -- there is
  // nothing outstanding about a quorum nobody needed.
  it('treats a plan `not-run` outcome as closing the case', () => {
    const open = openQuorumEscalations([
      ev({
        task_id: 'epic-a/plan@3',
        epic_id: 'epic-a',
        plan_version: 3,
        outcome: 'escalate',
        escalation_reason: 'disagreement',
        sound: false,
      }),
      ev({
        task_id: 'epic-a/plan@3',
        epic_id: 'epic-a',
        plan_version: 3,
        outcome: 'not-run',
        escalation_reason: null,
        sound: true,
      }),
    ]);
    expect(open).toEqual([]);
  });

  // A plan escalation is per version. Version 3 being settled says nothing
  // about version 4, so folding them onto one key would hide a live one.
  it('keys a plan escalation per version', () => {
    const open = openQuorumEscalations([
      ev({
        task_id: 'epic-a/plan@3',
        epic_id: 'epic-a',
        plan_version: 3,
        outcome: 'escalate',
        escalation_reason: 'disagreement',
        sound: false,
      }),
      ev({
        task_id: 'epic-a/plan@4',
        epic_id: 'epic-a',
        plan_version: 4,
        outcome: 'escalate',
        escalation_reason: 'disagreement',
        sound: false,
      }),
    ]);
    expect(open).toHaveLength(2);
  });

  // A finding, an epic and a plan could in principle land on the same task id
  // string. The key is namespaced so one never closes another.
  it('never lets one subject close another', () => {
    const open = openQuorumEscalations([
      ev({
        task_id: 'x',
        fingerprint: 'x',
        outcome: 'escalate',
        escalation_reason: 'disagreement',
        blocks: true,
      }),
      ev({ task_id: 'x', outcome: 'decided', decision: 'confirm', ready: true }),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.subject).toBe('finding');
  });

  // Oldest first. The list is a debt, and the oldest debt is the one that has
  // been ignored longest -- newest-first would bury it as the log grows.
  it('sorts oldest first', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation({ fingerprint: 'fp-b' }), '2026-09-05T00:00:00.000Z'),
      ev(findingEscalation({ fingerprint: 'fp-a' }), '2026-09-01T00:00:00.000Z'),
    ]);
    expect(open.map((e) => e.fingerprint)).toEqual(['fp-a', 'fp-b']);
  });

  // A shadow-only disagreement is the case D-201 named as reported nowhere:
  // gate.ts pushes an escalation to its caller only `if (hadActiveJudge)`, so
  // with every external provider in shadow the gate says nothing. The event is
  // still written, so this fold still sees it -- that is the whole point.
  it('sees a shadow-only disagreement the gate never reported', () => {
    const open = openQuorumEscalations([
      ev(
        findingEscalation({
          blocks: false,
          participants: [
            {
              provider: 'claude',
              mode: 'native',
              ok: true,
              verdict: 'confirm',
              excluded_as_finder: true,
            },
            {
              provider: 'codex',
              mode: 'shadow',
              ok: true,
              verdict: 'refute',
              excluded_as_finder: false,
            },
          ],
        }),
      ),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0]?.held).toBe(false);
  });

  it('carries every participant, shadow and active alike', () => {
    const open = openQuorumEscalations([ev(findingEscalation())]);
    expect(open[0]?.participants).toEqual([
      { provider: 'claude', mode: 'native', ok: true, verdict: 'confirm', excludedAsFinder: true },
      { provider: 'codex', mode: 'active', ok: true, verdict: 'refute', excludedAsFinder: false },
    ]);
  });

  // Fail loud, not quiet: an escalate event with a reason outside the closed
  // vocabulary is a payload this fold does not understand, and reporting it as
  // one of the two known reasons would be a lie about what the quorum said.
  it('throws on an escalation reason outside the vocabulary', () => {
    expect(() =>
      openQuorumEscalations([ev(findingEscalation({ escalation_reason: 'ran-out-of-money' }))]),
    ).toThrow(/ran-out-of-money/);
  });

  it('throws on an escalate event carrying no reason at all', () => {
    expect(() =>
      openQuorumEscalations([ev(findingEscalation({ escalation_reason: null }))]),
    ).toThrow(/escalation_reason/);
  });
});

// ---------------------------------------------------------------------------
// The two reasons are not two flavours of the same debt. `disagreement` is N
// cases a person reads one at a time; `insufficient-providers` is ONE fact
// about crosscheck.yml, repeated once per finding. Reporting the second as a
// per-finding backlog buries the first -- and in the shipped config it is not
// a rare case: with `min_providers: 2` and claude as the finder on nearly
// every finding, codex alone is a gating pool of one and EVERY case escalates
// this way. So they are split, and the split is what makes the list readable.
// ---------------------------------------------------------------------------

describe('summariseEscalations()', () => {
  it('lists disagreements one by one', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation({ fingerprint: 'fp-a' })),
      ev(findingEscalation({ fingerprint: 'fp-b' })),
    ]);
    const summary = summariseEscalations(open);
    expect(summary.disagreements).toHaveLength(2);
    expect(summary.ungated.count).toBe(0);
  });

  it('collapses insufficient-providers into one count', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation({ fingerprint: 'fp-a', escalation_reason: 'insufficient-providers' })),
      ev(findingEscalation({ fingerprint: 'fp-b', escalation_reason: 'insufficient-providers' })),
      ev(findingEscalation({ fingerprint: 'fp-c', escalation_reason: 'insufficient-providers' })),
    ]);
    const summary = summariseEscalations(open);
    expect(summary.disagreements).toEqual([]);
    expect(summary.ungated.count).toBe(3);
    expect(summary.ungated.cases).toHaveLength(3);
  });

  // The count alone would not say what to do about it. The hint names the file
  // and the field, because the fix is one edit there and no review at all.
  it('names crosscheck.yml in the ungated hint', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation({ escalation_reason: 'insufficient-providers' })),
    ]);
    expect(summariseEscalations(open).ungated.hint).toMatch(/crosscheck\.yml/);
  });

  it('has no hint when nothing was ungated', () => {
    expect(summariseEscalations([]).ungated).toMatchObject({ count: 0, hint: null, cases: [] });
  });

  // Exit codes are the machine-readable half. A green exit while nothing was
  // cross-checked at all would be the exact false signal this command exists
  // to remove, so "never gated" gets its own code rather than sharing 0.
  it('scores an empty log clean', () => {
    expect(summariseEscalations([]).exitCode).toBe(0);
  });

  it('scores an open disagreement 1', () => {
    const open = openQuorumEscalations([ev(findingEscalation())]);
    expect(summariseEscalations(open).exitCode).toBe(1);
  });

  it('scores an ungated-only log 2, not 0', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation({ escalation_reason: 'insufficient-providers' })),
    ]);
    expect(summariseEscalations(open).exitCode).toBe(2);
  });

  it('prefers 1 over 2 when both are open', () => {
    const open = openQuorumEscalations([
      ev(findingEscalation({ fingerprint: 'fp-a' })),
      ev(findingEscalation({ fingerprint: 'fp-b', escalation_reason: 'insufficient-providers' })),
    ]);
    expect(summariseEscalations(open).exitCode).toBe(1);
  });
});
