import { describe, expect, it } from 'vitest';
import type { AsymmetricRolePair } from '../src/crosscheck.js';
import { checkDispatchAsymmetry, readDispatchRecords } from '../src/dispatchAudit.js';
import type { StoredEvent } from '../src/events.js';

// ---------------------------------------------------------------------------
// P9-23, second half. crosscheck.yml's asymmetric_roles.finder_ne_critic was
// prose until now: the roles are dispatchable by name (D-1), so a template's
// `model:` is honoured, but nothing asserted after the fact that the critic
// ran on a different model from the finder. This module is that assertion,
// read off the event log — which is only possible because dispatch_decision
// now carries the concrete model, not just its tier.
// ---------------------------------------------------------------------------

const PAIRS: AsymmetricRolePair[] = [
  { finder: 'planner', critic: 'spec-reviewer' },
  { finder: 'reviewer', critic: 'verifier' },
];

let seq = 0;

function dispatch(
  role: string,
  model: string | null,
  // `taskId: null` writes no record-level task id at all, and `payloadTaskId`
  // writes one where the dispatching agent puts it instead. Both spellings are
  // in the real log, so both have to be expressible here (D-172).
  overrides: {
    taskId?: string | null;
    payloadTaskId?: string;
    ts?: string;
    provider?: string;
  } = {},
): StoredEvent {
  const n = seq++;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'dispatch_decision',
      ...(overrides.taskId === null ? {} : { task_id: overrides.taskId ?? 'T-1' }),
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: overrides.ts ?? `2026-08-08T10:${String(n).padStart(2, '0')}:00.000Z`,
      payload: {
        agent_role: role,
        provider: overrides.provider ?? 'claude',
        model_tier: 'frontier',
        ...(model === null ? {} : { model }),
        ...(overrides.payloadTaskId === undefined ? {} : { task_id: overrides.payloadTaskId }),
      },
    },
  };
}

function specReview(
  reviewedBy: string,
  overrides: { ts?: string; epicId?: string; taskId?: string } = {},
): StoredEvent {
  const n = seq++;
  const epicId = overrides.epicId ?? 'epic-1';
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'operator-skill',
      event_type: 'spec-review-recorded',
      task_id: overrides.taskId ?? `${epicId}/__epic__`,
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: overrides.ts ?? `2026-08-08T10:${String(n).padStart(2, '0')}:00.000Z`,
      payload: {
        epic_id: epicId,
        plan_version: 1,
        head_sha: '0f1e2d3c',
        reviewed_by: reviewedBy,
        finding_ids: [],
        finding_count: 0,
      },
    },
  };
}

function goalCheck(
  checkedBy: string,
  overrides: { ts?: string; epicId?: string; taskId?: string } = {},
): StoredEvent {
  const n = seq++;
  const epicId = overrides.epicId ?? 'epic-1';
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'operator-skill',
      event_type: 'goal-check-recorded',
      task_id: overrides.taskId ?? `${epicId}/integration`,
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: overrides.ts ?? `2026-08-08T10:${String(n).padStart(2, '0')}:00.000Z`,
      payload: {
        epic_id: epicId,
        milestone_id: 'phase-1',
        plan_version: 1,
        goal_digest: '0123456789abcdef',
        checked_by: checkedBy,
        coverage: [],
        clause_count: 0,
        uncovered_count: 0,
        out_of_scope_count: 0,
        finding_ids: [],
        finding_count: 0,
      },
    },
  };
}

function noise(): StoredEvent {
  return {
    event_id: 'sess-1#noise',
    record: {
      session_id: 'sess-1',
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      ts: '2026-08-08T09:00:00.000Z',
      payload: {},
    },
  };
}

describe('dispatchAudit.ts readDispatchRecords()', () => {
  it('reads role, provider, model and tier off dispatch_decision events and ignores everything else', () => {
    seq = 0;
    const records = readDispatchRecords([noise(), dispatch('planner', 'claude-opus-5')]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventId: 'sess-1#0',
      role: 'planner',
      provider: 'claude',
      model: 'claude-opus-5',
      modelTier: 'frontier',
      taskId: 'T-1',
    });
  });

  it('reports a legacy dispatch with no model as model null rather than dropping it', () => {
    seq = 0;
    // Events written before P9-23 exist on disk and are never rewritten.
    // Dropping them would make an unverifiable pair look empty; keeping them
    // with model: null is what lets the check say "cannot tell" out loud.
    const records = readDispatchRecords([dispatch('planner', null)]);
    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBeNull();
  });
});

describe('dispatchAudit.ts checkDispatchAsymmetry()', () => {
  it('passes when the critic ran on a different model from the finder it reviewed', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [dispatch('planner', 'claude-opus-5'), dispatch('spec-reviewer', 'claude-sonnet-5')],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(true);
    const check = report.checks.find((c) => c.critic === 'spec-reviewer');
    expect(check).toMatchObject({
      finder: 'planner',
      critic: 'spec-reviewer',
      status: 'ok',
      finderModel: 'claude-opus-5',
      criticModel: 'claude-sonnet-5',
    });
    // The other declared pair never ran; that is a stated no-op, not a pass.
    expect(report.checks.find((c) => c.critic === 'verifier')?.status).toBe('not-applicable');
  });

  it('flags a violation when the critic ran on the finder-s own model', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [dispatch('planner', 'claude-opus-5'), dispatch('spec-reviewer', 'claude-opus-5')],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.critic === 'spec-reviewer')).toMatchObject({
      status: 'violation',
      finderModel: 'claude-opus-5',
      criticModel: 'claude-opus-5',
    });
  });

  it('is unverifiable, not ok, when the critic dispatch carries no model', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [dispatch('planner', 'claude-opus-5'), dispatch('spec-reviewer', null)],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.critic === 'spec-reviewer')).toMatchObject({
      status: 'unverifiable',
      criticModel: null,
    });
  });

  it('is unverifiable when a critic ran with no preceding finder dispatch to compare against', () => {
    seq = 0;
    // A spec-review with no planner dispatch on the log is exactly the D-1b
    // case: the asymmetry may well have held, but nothing recorded says so.
    const report = checkDispatchAsymmetry([dispatch('spec-reviewer', 'claude-sonnet-5')], PAIRS, {
      sessionId: 'sess-1',
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.critic === 'spec-reviewer')).toMatchObject({
      status: 'unverifiable',
      finderModel: null,
    });
  });

  it('compares against the finder dispatch that preceded the critic, not a later one', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-opus-5', { ts: '2026-08-08T10:05:00.000Z' }),
        // A later re-plan on a different model cannot retroactively make the
        // review above adversarial.
        dispatch('planner', 'claude-fable-5', { ts: '2026-08-08T10:09:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.critic === 'spec-reviewer')).toMatchObject({
      status: 'violation',
      finderModel: 'claude-opus-5',
    });
  });

  it('checks every critic dispatch, not just the last one', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-opus-5', { ts: '2026-08-08T10:01:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:02:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    const specChecks = report.checks.filter((c) => c.critic === 'spec-reviewer');
    expect(specChecks).toHaveLength(2);
    expect(specChecks.map((c) => c.status)).toEqual(['violation', 'ok']);
    expect(report.ok).toBe(false);
  });

  it('scopes to one task when asked, so an unrelated task-s dispatches cannot answer for it', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { taskId: 'T-other' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { taskId: 'T-1' }),
      ],
      PAIRS,
      { sessionId: 'sess-1', taskId: 'T-1' },
    );

    expect(report.taskId).toBe('T-1');
    expect(report.dispatchesExamined).toBe(1);
    expect(report.checks.find((c) => c.critic === 'spec-reviewer')?.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });

  it('scopes by either spelling of the task id, and keeps two epics apart (D-181)', () => {
    seq = 0;
    // The critic ran on the finder's own model — a violation — but its
    // dispatch was logged bare while the finder's was qualified. Raw `===`
    // dropped it and the scoped audit came back clean (D-181).
    const events = [
      dispatch('planner', 'claude-opus-5', { taskId: 'epic-1/task-1' }),
      dispatch('spec-reviewer', 'claude-opus-5', { taskId: 'task-1' }),
    ];
    const report = checkDispatchAsymmetry(events, PAIRS, {
      sessionId: 'sess-1',
      taskId: 'epic-1/task-1',
    });
    expect(report.dispatchesExamined).toBe(2);
    expect(report.checks.find((c) => c.critic === 'spec-reviewer')?.status).toBe('violation');

    const other = checkDispatchAsymmetry(events, PAIRS, {
      sessionId: 'sess-1',
      taskId: 'epic-2/task-1',
    });
    expect(other.dispatchesExamined).toBe(1);
  });

  it('says so when no pair is declared instead of passing an empty check set', () => {
    seq = 0;
    const report = checkDispatchAsymmetry([dispatch('planner', 'claude-opus-5')], [], {
      sessionId: 'sess-1',
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ status: 'unverifiable', finder: '*', critic: '*' });
  });

  it('is ok and explicit when neither declared critic ever ran', () => {
    seq = 0;
    const report = checkDispatchAsymmetry([dispatch('coder', 'claude-sonnet-5')], PAIRS, {
      sessionId: 'sess-1',
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(['not-applicable', 'not-applicable']);
    expect(report.dispatchesExamined).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-124. Critic work reaches the log by two routes, and until now the audit
// read one of them. `smith epic spec-review` writes `spec-review-recorded`
// and no dispatch record, so a closing review that no dispatch ever produced
// was not `unverifiable` to this module — it was invisible, and the pair read
// `not-applicable`, which counts as ok. A check whose domain excludes the
// thing that went wrong reports a pass; enumerating the domain is the check.
// ---------------------------------------------------------------------------
describe('dispatchAudit.ts checkDispatchAsymmetry() — undispatched critic work (D-124)', () => {
  it('will not read not-applicable for a pair whose critic recorded a review', () => {
    seq = 0;
    const report = checkDispatchAsymmetry([specReview('spec-reviewer')], PAIRS, {
      sessionId: 'sess-1',
    });

    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.critic === 'spec-reviewer');
    expect(check).toMatchObject({
      finder: 'planner',
      critic: 'spec-reviewer',
      status: 'unverifiable',
      criticEventId: 'sess-1#0',
      criticModel: null,
    });
    // The other pair genuinely had nothing — that distinction must survive.
    expect(report.checks.find((c) => c.critic === 'verifier')?.status).toBe('not-applicable');
  });

  it('raises no blocker when a spec-reviewer dispatch stands behind the review', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:01:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-08T10:02:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(true);
    // One check, from the dispatch. The review is covered by it and does not
    // get a second, weaker check claiming independence the audit never saw.
    const specChecks = report.checks.filter((c) => c.critic === 'spec-reviewer');
    expect(specChecks).toHaveLength(1);
    expect(specChecks[0]).toMatchObject({ status: 'ok', criticEventId: 'sess-1#1' });
  });

  it('does not let one dispatch cover a second, undispatched re-review', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:01:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-08T10:02:00.000Z' }),
        // The v4 re-review in D-124: recorded by hand after the plan moved on,
        // with no dispatch of its own. The earlier dispatch is spent.
        specReview('spec-reviewer', { ts: '2026-08-08T10:09:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    const uncovered = report.checks.filter(
      (c) => c.critic === 'spec-reviewer' && c.status === 'unverifiable',
    );
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.criticEventId).toBe('sess-1#3');
  });

  it('will not spend a dispatch that predates the previous review on the next one', () => {
    seq = 0;
    // dogfood-mcp-1's shape: a run of spec-reviewer dispatches, then reviews
    // recorded by hand days later. Counting dispatches against reviews would
    // pass this; the second review had no critic behind it and the audit has
    // to say so.
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-10T10:32:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-10T10:50:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-11T07:33:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-11T07:52:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-14T05:54:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    const uncovered = report.checks.filter((c) => c.status === 'unverifiable');
    expect(uncovered.map((c) => c.criticEventId)).toEqual(['sess-1#4']);
  });

  it('counts review work separately from dispatches, so neither number lies', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-08T10:02:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.dispatchesExamined).toBe(1);
    expect(report.criticWorkExamined).toBe(1);
    // readDispatchRecords keeps its own domain: dispatch_decision, nothing else.
    expect(readDispatchRecords([specReview('spec-reviewer')])).toEqual([]);
  });

  it('counts a review by a role no pair declares without promoting it to a critic', () => {
    seq = 0;
    const report = checkDispatchAsymmetry([specReview('coder')], PAIRS, { sessionId: 'sess-1' });

    // finder_ne_critic says nothing about a role it never named; the count is
    // what stops that silence reading as an empty domain.
    expect(report.criticWorkExamined).toBe(1);
    expect(report.checks.map((c) => c.status)).toEqual(['not-applicable', 'not-applicable']);
    expect(report.ok).toBe(true);
  });

  it('scopes review work to one task alongside the dispatches', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [specReview('spec-reviewer', { epicId: 'epic-other' }), specReview('spec-reviewer')],
      PAIRS,
      { sessionId: 'sess-1', taskId: 'epic-1/__epic__' },
    );

    expect(report.criticWorkExamined).toBe(1);
    const uncovered = report.checks.filter((c) => c.status === 'unverifiable');
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.criticEventId).toBe('sess-1#1');
  });
});

// ---------------------------------------------------------------------------
// B3, the same shape one event type later. `smith epic goal-check` writes
// `goal-check-recorded` by the route `epic spec-review` writes its own event:
// a judge's verdict on the planner's output, produced by a command and never
// by a dispatch. D-124 is the reason it was added to CRITIC_WORK_EVENTS as it
// was written rather than after the audit was found reporting a pass over it.
// ---------------------------------------------------------------------------
describe('dispatchAudit.ts checkDispatchAsymmetry() — the spec-vs-goal check (B3)', () => {
  it('will not read not-applicable for a pair whose critic recorded a goal check', () => {
    seq = 0;
    const report = checkDispatchAsymmetry([goalCheck('spec-reviewer')], PAIRS, {
      sessionId: 'sess-1',
    });

    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.critic === 'spec-reviewer');
    expect(check).toMatchObject({
      status: 'unverifiable',
      criticEventId: 'sess-1#0',
      criticModel: null,
    });
    // Named as itself, so an operator reading the line knows which piece of
    // critic work is missing a dispatch.
    expect(check?.detail).toContain('spec-vs-goal check');
    expect(report.criticWorkExamined).toBe(1);
  });

  it('raises no blocker when a spec-reviewer dispatch stands behind the check', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:01:00.000Z' }),
        goalCheck('spec-reviewer', { ts: '2026-08-08T10:02:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(true);
    const specChecks = report.checks.filter((c) => c.critic === 'spec-reviewer');
    expect(specChecks).toHaveLength(1);
    expect(specChecks[0]).toMatchObject({ status: 'ok', criticEventId: 'sess-1#1' });
  });

  it('does not let one dispatch cover both a spec review and a goal check', () => {
    seq = 0;
    // The live shape: `epic spec-review` and `epic goal-check` are two verbs,
    // and an operator who ran one dispatch and then typed both has one piece
    // of critic work whose independence nothing witnessed. Adding an event
    // type to the domain is only worth anything if it competes for a dispatch
    // instead of quietly sharing one.
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:01:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-08T10:02:00.000Z' }),
        goalCheck('spec-reviewer', { ts: '2026-08-08T10:03:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    expect(report.criticWorkExamined).toBe(2);
    const uncovered = report.checks.filter((c) => c.status === 'unverifiable');
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.criticEventId).toBe('sess-1#3');
    expect(uncovered[0]?.detail).toContain('spec-vs-goal check');
  });

  it('accepts two dispatches when the second follows the first record', () => {
    seq = 0;
    // The shape the /bs run playbook asks for: step 13 dispatches and records
    // the closing spec review, then step 14 dispatches a fresh session and
    // records the goal check. Two pieces of critic work, two dispatches, and
    // each dispatch inside its own record's window.
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:01:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-08T10:02:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:03:00.000Z' }),
        goalCheck('spec-reviewer', { ts: '2026-08-08T10:04:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(true);
    expect(report.criticWorkExamined).toBe(2);
    expect(report.checks.filter((c) => c.status === 'unverifiable')).toHaveLength(0);
  });

  it('refuses two dispatches that both precede the first record', () => {
    seq = 0;
    // Order is part of the contract, not an accident of how the window was
    // written: a dispatch that predates the previous record already answered
    // for that one. Firing both spec-reviewer sessions up front and then
    // typing both commands leaves the second record with nothing behind it,
    // and it is worth a test because the playbook's step order is the only
    // thing that keeps an operator out of this shape.
    const report = checkDispatchAsymmetry(
      [
        dispatch('planner', 'claude-opus-5', { ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:01:00.000Z' }),
        dispatch('spec-reviewer', 'claude-sonnet-5', { ts: '2026-08-08T10:02:00.000Z' }),
        specReview('spec-reviewer', { ts: '2026-08-08T10:03:00.000Z' }),
        goalCheck('spec-reviewer', { ts: '2026-08-08T10:04:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    expect(report.ok).toBe(false);
    const uncovered = report.checks.filter((c) => c.status === 'unverifiable');
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.criticEventId).toBe('sess-1#4');
    expect(uncovered[0]?.detail).toContain('spec-vs-goal check');
  });

  it('keeps the goal check out of readDispatchRecords entirely', () => {
    seq = 0;
    // Two domains, deliberately: a critic-work record carries no model, so
    // counting it as a dispatch would invent one.
    expect(readDispatchRecords([goalCheck('spec-reviewer'), noise()])).toEqual([]);
  });
});

describe('checkDispatchAsymmetry — task scoping (D-172)', () => {
  it('compares a critic against the finder for its own task, not the latest one', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('reviewer', 'claude-opus-5', { taskId: 'T-a', ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('reviewer', 'claude-sonnet-5', { taskId: 'T-b', ts: '2026-08-08T10:01:00.000Z' }),
        dispatch('verifier', 'claude-opus-5', { taskId: 'T-a', ts: '2026-08-08T10:05:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    // T-b-s sonnet reviewer is the latest one before the verifier, and reading
    // it launders a same-model pairing on T-a into a pass.
    const check = report.checks.find((c) => c.critic === 'verifier');
    expect(check?.status).toBe('violation');
    expect(check?.finderEventId).toBe('sess-1#0');
    expect(report.ok).toBe(false);
  });

  it('is unverifiable when the critic-s own task has no finder dispatch at all', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('reviewer', 'claude-sonnet-5', { taskId: 'T-a', ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('verifier', 'claude-opus-5', { taskId: 'T-b', ts: '2026-08-08T10:05:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    const check = report.checks.find((c) => c.critic === 'verifier');
    expect(check?.status).toBe('unverifiable');
    expect(check?.detail).toContain('T-b');
    expect(report.ok).toBe(false);
  });

  it('lets a finder dispatch with no task id answer for a scoped critic', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('reviewer', 'claude-sonnet-5', { taskId: null, ts: '2026-08-08T10:00:00.000Z' }),
        dispatch('verifier', 'claude-opus-5', { taskId: 'T-a', ts: '2026-08-08T10:05:00.000Z' }),
      ],
      PAIRS,
      { sessionId: 'sess-1' },
    );

    // An unscoped dispatch answers for whatever ran after it; refusing it would
    // turn every pre-task-id run into a wall of false alarms.
    expect(report.checks.find((c) => c.critic === 'verifier')?.status).toBe('ok');
    expect(report.ok).toBe(true);
  });

  it('reads a task id the dispatching agent wrote into the payload', () => {
    seq = 0;
    const report = checkDispatchAsymmetry(
      [
        dispatch('reviewer', 'claude-sonnet-5', { taskId: null, payloadTaskId: 'T-a' }),
        dispatch('verifier', 'claude-opus-5', { taskId: null, payloadTaskId: 'T-a' }),
      ],
      PAIRS,
      { sessionId: 'sess-1', taskId: 'T-a' },
    );

    // On dogfood-envkit-1 fifteen of nineteen dispatches carry only the payload
    // copy; reading one level scopes all fifteen out and examines nothing.
    expect(report.dispatchesExamined).toBe(2);
    expect(report.checks.find((c) => c.critic === 'verifier')?.status).toBe('ok');
  });
});
