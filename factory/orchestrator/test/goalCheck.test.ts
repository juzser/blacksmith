import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { type EventContext, listFindings, raiseFinding } from '../src/findings.js';
import {
  type ClauseCoverage,
  EPIC_GOAL_UNDECLARED,
  GOAL_CHECK_EVENT,
  GoalCheckError,
  type GoalCheckStatus,
  goalCheckBlockers,
  goalClauses,
  goalDigest,
  latestGoalCheck,
  recordGoalCheck,
  resolveEpicGoal,
} from '../src/goalCheck.js';

// ---------------------------------------------------------------------------
// The spec-vs-goal gate (B3).
//
// Every other gate reads something the planner authored, so a plan that
// decomposes the WRONG goal passes all of them and the epic closes green
// having built the wrong thing. This gate is the only one whose reference
// text comes from outside the plan -- the `- goal:` line of the roadmap
// milestone that owns the epic -- and these tests pin the three things that
// keep it from being a rubber stamp:
//
//   * the clause list is the goal's, not the judge's (goalClauses is
//     deterministic, and both recordGoalCheck and goalCheckBlockers refuse a
//     coverage map that drifted from it);
//   * `covered` has to name live plan task ids;
//   * `out-of-scope` has to carry an auditable reason.
//
// Plus the property the rest of the epic gate leans on: this gate fails
// CLOSED. An epic whose milestone declares no goal holds, rather than being
// waved through the way MCP_SURFACE_NOT_REQUIRED waves through an epic that
// owes no MCP surface.
// ---------------------------------------------------------------------------

const EPIC = 'envkit-config-loader';
const MILESTONE = 'phase-3-config';
const TASK_A = `${EPIC}/task-1a`;
const TASK_B = `${EPIC}/task-1b`;

describe('goalClauses', () => {
  it('splits on a terminator only where the next sentence visibly starts', () => {
    expect(goalClauses('Parse .env files. Reject unbalanced quotes.')).toEqual([
      'Parse .env files.',
      'Reject unbalanced quotes.',
    ]);
  });

  it('keeps versions and paths whole — the dots inside them end no sentence', () => {
    // The lookahead is what earns this: a full stop followed by a lowercase
    // letter is punctuation inside a token, not a sentence boundary. Without
    // it "state/events/x.jsonl" becomes two clauses a judge has to answer
    // separately, and neither half is a requirement.
    expect(
      goalClauses('Write v1.2 records to state/events/x.jsonl and keep them append-only.'),
    ).toEqual(['Write v1.2 records to state/events/x.jsonl and keep them append-only.']);
  });

  it('splits a bulleted or multi-line goal line by line, with or without full stops', () => {
    expect(goalClauses('- parse quotes\n- expand vars\n- refuse duplicates')).toEqual([
      '- parse quotes',
      '- expand vars',
      '- refuse duplicates',
    ]);
  });

  it('never splits on a comma', () => {
    // "the worktree, which the coder owns, is disposable" and "test gate,
    // reviewer chain, severity policy" are the same shape to a splitter and
    // opposite things to a reader, so the splitter does not get to guess.
    const goal = 'Ship the test gate, the reviewer chain, and the severity policy.';
    expect(goalClauses(goal)).toEqual([goal]);
  });

  it('drops no text: every clause concatenated back is the goal, whitespace aside', () => {
    // The direction this function is allowed to be wrong in. Over-splitting
    // costs a judge an extra dismissal; dropping a sentence loses a
    // requirement silently, which is the failure the whole gate exists for.
    const goal = 'Load config. Validate it (e.g. types). \n\n  Then cache the result.\n';
    const rejoined = goalClauses(goal).join(' ').replace(/\s+/g, ' ');
    expect(rejoined).toBe(goal.replace(/\s+/g, ' ').trim());
  });

  it('reads whitespace-only text as no clauses at all', () => {
    expect(goalClauses('   \n\t\n ')).toEqual([]);
  });
});

describe('goalDigest', () => {
  it('is stable across rewrapping and unstable across rewording', () => {
    // The two edits an operator makes to a roadmap goal line. Reflowing a
    // paragraph must not invalidate a check that read the same words;
    // sharpening a vague requirement must.
    const a = goalDigest('Parse .env files.\n  Reject unbalanced quotes.');
    expect(goalDigest('Parse .env files. Reject unbalanced quotes.')).toBe(a);
    expect(goalDigest('Parse .env files. Reject unbalanced quotes loudly.')).not.toBe(a);
  });

  it('is a short hex digest, short enough to read out of a blocker message', () => {
    expect(goalDigest('anything')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('resolveEpicGoal', () => {
  let roadmapPath: string;
  let dir: string;

  async function writeRoadmap(body: string) {
    await writeFile(roadmapPath, body, 'utf8');
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-goal-roadmap-'));
    roadmapPath = path.join(dir, 'roadmap.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the goal off the milestone whose epics list names the epic', async () => {
    await writeRoadmap(
      [
        '## Phase 3 — Config',
        `- id: ${MILESTONE}`,
        '- status: in-progress',
        '- goal: Parse .env files. Reject unbalanced quotes.',
        `- epics: [${EPIC}, other-epic]`,
        '',
      ].join('\n'),
    );

    expect(resolveEpicGoal({ epicId: EPIC, roadmapPath })).toEqual({
      milestoneId: MILESTONE,
      goal: 'Parse .env files. Reject unbalanced quotes.',
      clauses: ['Parse .env files.', 'Reject unbalanced quotes.'],
      digest: goalDigest('Parse .env files. Reject unbalanced quotes.'),
    });
  });

  it('falls back to the milestone whose id IS the epic id', async () => {
    // ownsEpic's second arm, and the reason the gate is reachable at all: the
    // roadmap ships `- epics: []` on nearly every milestone, and an id match
    // is the convention `smith mcp init` and the epic naming already create.
    await writeRoadmap(
      [
        '## Demo surface',
        '- id: demo-mcp-surface',
        '- status: planned',
        '- goal: Expose the tools.',
        '- epics: []',
        '',
      ].join('\n'),
    );

    expect(resolveEpicGoal({ epicId: 'demo-mcp-surface', roadmapPath })).toMatchObject({
      milestoneId: 'demo-mcp-surface',
      goal: 'Expose the tools.',
    });
  });

  it('reads a present-but-empty goal line the same as no goal line at all', async () => {
    // Both are "nobody wrote down what this was for", and the remedy is the
    // same one line of roadmap.md — so they must not resolve to two states a
    // caller then has to tell apart.
    await writeRoadmap(
      [
        '## Phase 3 — Config',
        `- id: ${MILESTONE}`,
        '- status: planned',
        '- goal:',
        `- epics: [${EPIC}]`,
        '',
      ].join('\n'),
    );

    expect(resolveEpicGoal({ epicId: EPIC, roadmapPath })).toEqual({
      milestoneId: MILESTONE,
      goal: null,
      clauses: [],
      digest: null,
    });
  });

  it('resolves an epic no milestone owns to the undeclared status', async () => {
    await writeRoadmap(
      [
        '## Phase 3 — Config',
        `- id: ${MILESTONE}`,
        '- status: planned',
        '- goal: Something.',
        '- epics: [other-epic]',
        '',
      ].join('\n'),
    );

    expect(resolveEpicGoal({ epicId: EPIC, roadmapPath })).toEqual(EPIC_GOAL_UNDECLARED);
  });
});

// ---------------------------------------------------------------------------
// The fold and the oracle. Both read recorded values only; neither runs a
// judge, and neither is allowed to be charitable about what it reads.
// ---------------------------------------------------------------------------

const GOAL = 'Parse .env files. Reject unbalanced quotes.';
const CLAUSES = ['Parse .env files.', 'Reject unbalanced quotes.'];

function goalStatus(overrides: Partial<GoalCheckStatus['goal']> = {}) {
  return {
    milestoneId: MILESTONE,
    goal: GOAL,
    clauses: CLAUSES,
    digest: goalDigest(GOAL),
    ...overrides,
  };
}

function checkRecord(overrides: Partial<GoalCheckStatus['check']> = {}) {
  return {
    epicId: EPIC,
    milestoneId: MILESTONE,
    planVersion: 1,
    goalDigest: goalDigest(GOAL),
    checkedBy: 'spec-reviewer',
    coverage: [
      { clause: CLAUSES[0] as string, verdict: 'covered' as const, taskIds: [TASK_A] },
      { clause: CLAUSES[1] as string, verdict: 'covered' as const, taskIds: [TASK_B] },
    ],
    findingIds: [],
    eventId: 'sess-goal#7',
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('latestGoalCheck', () => {
  let stateDir: string;
  const sessionId = 'sess-goal-fold';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-goal-fold-'));
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function record(payload: Record<string, unknown>) {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'spec-reviewer',
        event_type: GOAL_CHECK_EVENT,
        task_id: `${EPIC}/integration`,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload,
      },
      { stateDir },
    );
  }

  it('answers null when nothing has checked this epic', async () => {
    expect(latestGoalCheck(await readEvents(sessionId, { stateDir }), EPIC)).toBeNull();
  });

  it('ignores checks recorded against a different epic', async () => {
    await record({ epic_id: 'some-other-epic', milestone_id: MILESTONE, plan_version: 1 });
    expect(latestGoalCheck(await readEvents(sessionId, { stateDir }), EPIC)).toBeNull();
  });

  it('is last-wins: a re-check supersedes its predecessor rather than stacking', async () => {
    await record({
      epic_id: EPIC,
      milestone_id: MILESTONE,
      plan_version: 1,
      checked_by: 'spec-reviewer',
    });
    await record({
      epic_id: EPIC,
      milestone_id: MILESTONE,
      plan_version: 2,
      checked_by: 'spec-reviewer',
    });

    const latest = latestGoalCheck(await readEvents(sessionId, { stateDir }), EPIC);
    expect(latest?.planVersion).toBe(2);
  });

  it('reads a payload with no plan version as version 0, not as "current"', async () => {
    // The value goalCheckBlockers then refuses. A hand-written event that
    // omits the field must not be readable as "graded whatever is live".
    await record({ epic_id: EPIC, milestone_id: MILESTONE });
    const latest = latestGoalCheck(await readEvents(sessionId, { stateDir }), EPIC);
    expect(latest).toMatchObject({ planVersion: 0, coverage: [], findingIds: [] });
  });
});

describe('goalCheckBlockers', () => {
  it('holds an epic no milestone owns, naming the roadmap edit that clears it', () => {
    const blockers = goalCheckBlockers(EPIC, { check: null, goal: EPIC_GOAL_UNDECLARED }, 1, [
      TASK_A,
    ]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('No roadmap milestone owns epic');
    expect(blockers[0]).toContain('factory/specs/roadmap.md');
  });

  it('holds an epic whose milestone declares no goal — the fail-closed call', () => {
    // Deliberately NOT the MCP surface's "not required" answer. An epic can
    // legitimately owe no MCP surface; an epic that owes no statement of what
    // it was for is an epic nobody can say succeeded.
    const blockers = goalCheckBlockers(
      EPIC,
      { check: null, goal: { milestoneId: MILESTONE, goal: null, clauses: [], digest: null } },
      1,
      [TASK_A],
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('declares no goal');
  });

  it('holds an epic with a goal and no check on record', () => {
    const blockers = goalCheckBlockers(EPIC, { check: null, goal: goalStatus() }, 1, [
      TASK_A,
      TASK_B,
    ]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('smith epic goal-check');
  });

  it('holds a check that read a goal the roadmap no longer states', () => {
    const status = {
      check: checkRecord({ goalDigest: goalDigest('Something the roadmap used to say.') }),
      goal: goalStatus(),
    };
    const blockers = goalCheckBlockers(EPIC, status, 1, [TASK_A, TASK_B]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('is stale');
    expect(blockers[0]).toContain(goalDigest(GOAL));
  });

  it('holds a check that records no plan version at all', () => {
    const status = { check: checkRecord({ planVersion: 0 }), goal: goalStatus() };
    expect(goalCheckBlockers(EPIC, status, 1, [TASK_A, TASK_B])[0]).toContain(
      'records no plan version',
    );
  });

  it('holds a check of an older plan version — the amendment was checked against no goal', () => {
    const status = { check: checkRecord({ planVersion: 1 }), goal: goalStatus() };
    expect(goalCheckBlockers(EPIC, status, 2, [TASK_A, TASK_B])[0]).toContain('graded plan v1');
  });

  it('holds a check that names a plan version the repository does not have', () => {
    const status = { check: checkRecord({ planVersion: 3 }), goal: goalStatus() };
    expect(goalCheckBlockers(EPIC, status, 2, [TASK_A, TASK_B])[0]).toContain(
      'names a version the repository does not have',
    );
  });

  it('holds a check that credits a task the live plan does not have', () => {
    // Coverage is re-checked here as well as at record time, because an event
    // can also arrive by hand — and a clause covered by a task that does not
    // exist is a clause nothing delivers.
    const status = { check: checkRecord(), goal: goalStatus() };
    const blockers = goalCheckBlockers(EPIC, status, 1, [TASK_A]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain(TASK_B);
  });

  it('holds a check whose clause list has drifted from the goal as written', () => {
    // The rubber-stamp defence: a judge cannot make an epic green by declining
    // to mention the clause it failed.
    const status = {
      check: checkRecord({
        coverage: [{ clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] }],
      }),
      goal: goalStatus(),
    };
    const blockers = goalCheckBlockers(EPIC, status, 1, [TASK_A, TASK_B]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('does not answer the goal as written');
  });

  it('holds an uncovered clause and points at the only remedy the plan allows', () => {
    const status = {
      check: checkRecord({
        coverage: [
          { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
          { clause: CLAUSES[1] as string, verdict: 'uncovered' },
        ],
      }),
      goal: goalStatus(),
    };
    const blockers = goalCheckBlockers(EPIC, status, 1, [TASK_A, TASK_B]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('smith plan amend');
    expect(blockers[0]).toContain(CLAUSES[1] as string);
  });

  it('passes a check whose clauses are all covered or dismissed in writing', () => {
    const status = {
      check: checkRecord({
        coverage: [
          { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
          {
            clause: CLAUSES[1] as string,
            verdict: 'out-of-scope',
            reason: 'owned by the sibling epic',
          },
        ],
      }),
      goal: goalStatus(),
    };
    expect(goalCheckBlockers(EPIC, status, 1, [TASK_A, TASK_B])).toEqual([]);
  });

  it('skips the version and roster checks when the epic has no live plan', () => {
    // planVersion null means "no plan file to read" — the goal itself is still
    // checkable, and holding on a roster nobody can produce would just be a
    // second, less legible version of the missing-plan blocker.
    const status = { check: checkRecord({ planVersion: 9 }), goal: goalStatus() };
    expect(goalCheckBlockers(EPIC, status, null, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recordGoalCheck: validate everything, then act. A run that raises two
// findings and then rejects the third clause has already changed the log for
// a check that never completed.
// ---------------------------------------------------------------------------

describe('recordGoalCheck', () => {
  let stateDir: string;
  const sessionId = 'sess-goal-record';
  const ctx: EventContext = {
    sessionId,
    planVersion: 1,
    causalParent: `${sessionId}#0`,
    actor: 'spec-reviewer',
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-goal-record-'));
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function input(coverage: ClauseCoverage[], overrides: Record<string, unknown> = {}) {
    return {
      epicId: EPIC,
      milestoneId: MILESTONE,
      goal: GOAL,
      planVersion: 1,
      livePlanTaskIds: [TASK_A, TASK_B],
      checkedBy: 'spec-reviewer',
      coverage,
      ...overrides,
    };
  }

  const covered: ClauseCoverage[] = [
    { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
    { clause: CLAUSES[1] as string, verdict: 'covered', taskIds: [TASK_B] },
  ];

  async function goalEvents() {
    const events = await readEvents(sessionId, { stateDir });
    return events.filter((e) => e.record.event_type === GOAL_CHECK_EVENT);
  }

  it('records a clean check — "ran and was clean" is not the same fact as "never ran"', async () => {
    const record = await recordGoalCheck(input(covered), ctx, { stateDir });

    expect(record).toMatchObject({
      epicId: EPIC,
      milestoneId: MILESTONE,
      planVersion: 1,
      goalDigest: goalDigest(GOAL),
      findingIds: [],
    });

    const [event] = await goalEvents();
    expect(event?.record.task_id).toBe(`${EPIC}/integration`);
    expect(event?.record.payload).toMatchObject({
      epic_id: EPIC,
      milestone_id: MILESTONE,
      plan_version: 1,
      goal_digest: goalDigest(GOAL),
      checked_by: 'spec-reviewer',
      clause_count: 2,
      uncovered_count: 0,
      out_of_scope_count: 0,
      finding_count: 0,
    });
    expect(await listFindings(sessionId, {}, { stateDir })).toHaveLength(0);
  });

  it('records the dismissal reason for an out-of-scope clause, and raises nothing', async () => {
    // A milestone that holds several epics has clauses that belong to the
    // siblings. Legitimate — and now a written dismissal an operator can
    // audit rather than a silent drop.
    const record = await recordGoalCheck(
      input([
        { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
        {
          clause: CLAUSES[1] as string,
          verdict: 'out-of-scope',
          reason: 'the sibling epic owns quoting',
        },
      ]),
      ctx,
      { stateDir },
    );

    expect(record.findingIds).toEqual([]);
    const [event] = await goalEvents();
    expect(event?.record.payload.out_of_scope_count).toBe(1);
    const coverage = (event?.record.payload.coverage ?? []) as ClauseCoverage[];
    expect(coverage[1]?.reason).toBe('the sibling epic owns quoting');
  });

  it('mints an uncovered clause as a spec-scoped finding against the plan, not a task diff', async () => {
    const record = await recordGoalCheck(
      input([
        { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
        { clause: CLAUSES[1] as string, verdict: 'uncovered' },
      ]),
      ctx,
      { stateDir },
    );

    expect(record.findingIds).toHaveLength(1);

    const findings = await listFindings(sessionId, {}, { stateDir });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      finding_scope: 'spec',
      severity: 'S2-major',
      finding_category: 'correctness',
      // Anchored at the plan file's repo-relative path, written out rather
      // than derived from a tmpdir — the path is fingerprint material, and a
      // machine-local one would dedup differently on every machine.
      file_path: `factory/specs/active/${EPIC}/plan-v1.json`,
      spec_ref: { plan_version: 1, criterion_ref: `goal:${MILESTONE}#2` },
    });
    expect(findings[0]?.summary).toContain(CLAUSES[1] as string);

    const [event] = await goalEvents();
    expect(event?.record.payload.finding_ids).toEqual(record.findingIds);
    expect(event?.record.payload.uncovered_count).toBe(1);
  });

  it('raises a distinct finding per plan version, so a re-check of an amended plan is its own claim', async () => {
    const uncovered: ClauseCoverage[] = [
      { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
      { clause: CLAUSES[1] as string, verdict: 'uncovered' },
    ];
    const first = await recordGoalCheck(input(uncovered), ctx, { stateDir });
    const second = await recordGoalCheck(input(uncovered, { planVersion: 2 }), ctx, { stateDir });

    expect(second.findingIds).not.toEqual(first.findingIds);
    const findings = await listFindings(sessionId, {}, { stateDir });
    expect(findings.map((f) => f.file_path).sort()).toEqual([
      `factory/specs/active/${EPIC}/plan-v1.json`,
      `factory/specs/active/${EPIC}/plan-v2.json`,
    ]);
  });

  it('refuses a goal with no clauses in it', async () => {
    await expect(
      recordGoalCheck(input([], { goal: '   \n ' }), ctx, { stateDir }),
    ).rejects.toMatchObject({ code: 'goal-check.empty-goal' });
  });

  it("refuses a coverage map whose clauses are not the goal's, in order", async () => {
    await expect(
      recordGoalCheck(
        input([
          { clause: CLAUSES[1] as string, verdict: 'covered', taskIds: [TASK_B] },
          { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
        ]),
        ctx,
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'goal-check.clause-mismatch' });
  });

  it('refuses a verdict outside the closed set, however the JSON reached it', async () => {
    await expect(
      recordGoalCheck(
        input([
          { clause: CLAUSES[0] as string, verdict: 'probably-fine' as ClauseCoverage['verdict'] },
          { clause: CLAUSES[1] as string, verdict: 'covered', taskIds: [TASK_B] },
        ]),
        ctx,
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'goal-check.unknown-verdict' });
  });

  it('refuses "covered somewhere" — a covered clause has to name a task', async () => {
    await expect(
      recordGoalCheck(
        input([
          { clause: CLAUSES[0] as string, verdict: 'covered' },
          { clause: CLAUSES[1] as string, verdict: 'covered', taskIds: [TASK_B] },
        ]),
        ctx,
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'goal-check.covered-without-task' });
  });

  it('refuses coverage credited to a task the plan does not have', async () => {
    await expect(
      recordGoalCheck(
        input([
          { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [`${EPIC}/task-99`] },
          { clause: CLAUSES[1] as string, verdict: 'covered', taskIds: [TASK_B] },
        ]),
        ctx,
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'goal-check.unknown-task' });
  });

  it('refuses an out-of-scope dismissal with no reason an operator could audit', async () => {
    await expect(
      recordGoalCheck(
        input([
          { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
          { clause: CLAUSES[1] as string, verdict: 'out-of-scope', reason: '   ' },
        ]),
        ctx,
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'goal-check.dismissal-without-reason' });
  });

  it('validates every clause before raising any finding', async () => {
    // The amendPlan property. Clause 1 is a legitimate uncovered finding and
    // clause 2 is invalid; a run that minted the first and then threw would
    // leave a finding on the log for a check that never completed, blocking
    // the epic on the say-so of a rejected input.
    await expect(
      recordGoalCheck(
        input([
          { clause: CLAUSES[0] as string, verdict: 'uncovered' },
          { clause: CLAUSES[1] as string, verdict: 'covered' },
        ]),
        ctx,
        { stateDir },
      ),
    ).rejects.toBeInstanceOf(GoalCheckError);

    expect(await listFindings(sessionId, {}, { stateDir })).toHaveLength(0);
    expect(await goalEvents()).toHaveLength(0);
  });

  it('cannot have its finding waived away: an uncovered clause is S2, and S2 is unwaivable', async () => {
    // recordGoalCheck skips a suppressed raise when it collects finding_ids,
    // because citing an id that was never raised makes the record
    // unresolvable. That branch is unreachable at UNCOVERED_SEVERITY and this
    // pins why: suppression is keyed on a waiver, and severity.yml lets no
    // operator grant one over an S2. The defence is the severity, not the
    // bookkeeping.
    const uncovered: ClauseCoverage[] = [
      { clause: CLAUSES[0] as string, verdict: 'covered', taskIds: [TASK_A] },
      { clause: CLAUSES[1] as string, verdict: 'uncovered' },
    ];
    const first = await recordGoalCheck(input(uncovered), ctx, { stateDir });
    const fingerprint = (await listFindings(sessionId, {}, { stateDir }))[0]?.fingerprint;
    expect(fingerprint).toBeTruthy();

    // The same fingerprint raised again is a fresh finding, not a suppression.
    const again = await recordGoalCheck(input(uncovered), ctx, { stateDir });
    expect(again.findingIds).toEqual(first.findingIds);
    const raised = await raiseFinding(
      {
        finding: {
          finding_id: 'finding-manual',
          task_id: `${EPIC}/integration`,
          finding_category: 'correctness',
          severity: 'S2-major',
          finding_status: 'raised',
          finding_scope: 'spec',
          spec_ref: { plan_version: 1, criterion_ref: `goal:${MILESTONE}#2` },
          summary: `Plan v1 delivers no clause of the epic goal: ${CLAUSES[1] as string}`,
          failure_scenario: { inputs: 'x', expected: 'y', actual: 'z' },
          found_by: 'spec-reviewer',
        },
        filePath: `factory/specs/active/${EPIC}/plan-v1.json`,
      },
      ctx,
      { stateDir },
    );
    expect(raised.suppressed).toBe(false);
  });
});
