// Synthesizes one realistic session event log covering every projection
// table (db/schema.ts): prompts, dispatches, task lifecycle, findings incl.
// waived + suppressed, edges, errors, lessons, artifacts. Uses the REAL
// findings.ts/waivers.ts functions (raiseFinding/transition/grantWaiver/
// denyWaiver) for anything they own — the same "reuse the fold" rule the
// projector itself follows — and plain appendEvent() for event kinds no
// module owns yet (task-added/wave-admitted/wave-merged/task-superseded/
// task-result-recorded/lesson-candidate-raised/lesson-status-changed).
// prompts.ts joined the first list in D-142; operator-note is still in the
// second, and is the remaining event here a person writes by hand.
import { appendEdge, appendEvent, type EventOpts, readEvents } from '../../src/events.js';
import type { EventContext } from '../../src/findings.js';
import { raiseFinding, transition } from '../../src/findings.js';
import { recordUserPrompt } from '../../src/prompts.js';
import { denyWaiver, grantWaiver } from '../../src/waivers.js';

/**
 * raiseFinding()/transition() append an event but return the Finding, not
 * the event's id — read the log back for the true latest event id so the
 * next appendEvent's causal_parent stays accurate.
 */
async function lastEventId(opts: EventOpts): Promise<string> {
  const events = await readEvents(SESSION_ID, opts);
  const last = events[events.length - 1];
  if (!last) throw new Error('fixture: expected at least one event in the log');
  return last.event_id;
}

export const SESSION_ID = 'sess-fixture';
export const EPIC_ID = 'epic-1';
export const TASK_1 = 'epic-1/task-1'; // happy path: raised -> fixed -> merged
export const TASK_2 = 'epic-1/task-2'; // waiver path: S3 finding granted a waiver
export const TASK_3 = 'epic-1/task-3'; // error path: agent errors out, task escalates
export const TASK_4 = 'epic-1/task-4'; // a finding parked at "confirmed" — never fixed or waived

export interface FixtureIds {
  userPromptId: string;
  dispatchTask1Id: string;
  dispatchTask2Id: string;
  dispatchTask3Id: string;
  finding1Id: string; // task-1, S2, fixed
  finding2Id: string; // task-2, S3, waived
  finding3Id: string; // re-raise of finding-2's fingerprint after the waiver (suppressed)
  finding4Id: string; // task-4, S2, parked at "confirmed"
  lessonId: string;
  rejectedLessonId: string; // raised, then invalidated by the operator
}

export async function buildFixture(opts: EventOpts): Promise<FixtureIds> {
  const planVersion = 1;

  const root = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'session-start',
      plan_version: planVersion,
      causal_parent: null,
      payload: {},
    },
    opts,
  );
  let parent = root.event_id;

  // Through the real writer since D-142, not a hand-shaped appendEvent: the
  // header rule above, and the reason for it. Every db test downstream now
  // asserts against what `smith prompt record` actually emits, so a change to
  // the payload the writer produces fails where the readers are, not only
  // where the writer is tested.
  const prompt = await recordUserPrompt(
    'Build the widget and fix the flaky import.',
    { sessionId: SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  parent = prompt.event_id;

  const taskAdded1 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'task-added',
      task_id: TASK_1,
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        epic_id: EPIC_ID,
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
        plan_version: planVersion,
        objective: 'Add the widget renderer.',
        claims: ['src/widget.ts'],
        budget_tokens: 2000,
      },
    },
    opts,
  );
  parent = taskAdded1.event_id;

  const taskAdded2 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'task-added',
      task_id: TASK_2,
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        epic_id: EPIC_ID,
        case: 'refactor',
        origin: 'user',
        task_status: 'todo',
        plan_version: planVersion,
        objective: 'Simplify the config loader.',
        claims: ['src/config.ts'],
        budget_tokens: 1000,
      },
    },
    opts,
  );
  parent = taskAdded2.event_id;

  const taskAdded3 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'task-added',
      task_id: TASK_3,
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        epic_id: EPIC_ID,
        case: 'bugfix',
        origin: 'user',
        task_status: 'todo',
        plan_version: planVersion,
        objective: 'Fix the flaky import resolution.',
        claims: ['src/import.ts'],
        budget_tokens: 500,
      },
    },
    opts,
  );
  parent = taskAdded3.event_id;

  const taskAdded4 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'task-added',
      task_id: TASK_4,
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        epic_id: EPIC_ID,
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
        plan_version: planVersion,
        objective: 'Add the settings panel.',
        claims: ['src/settings.ts'],
        budget_tokens: 800,
      },
    },
    opts,
  );
  parent = taskAdded4.event_id;

  const waveAdmitted = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'system',
      event_type: 'wave-admitted',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { epic_id: EPIC_ID, task_ids: [TASK_1, TASK_2, TASK_3, TASK_4] },
    },
    opts,
  );
  parent = waveAdmitted.event_id;

  const dispatch1 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: TASK_1,
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
        spec_ref: 'factory/specs/active/epic-1/task-1.json',
        reason: 'implement the widget renderer',
        parent_prompt_id: prompt.event_id,
      },
    },
    opts,
  );
  parent = dispatch1.event_id;

  // The other thing a person writes, and the one this fixture used to lack
  // (D-153): `smith event append` puts operator-note into every real log —
  // 57 of them in this factory's own, against 0 user_prompt — so a fixture
  // carrying only user_prompt left the Prompts filter looking populated in
  // the e2e suite while it was empty over real data. Hung off the dispatch
  // rather than threaded into the chain because that is the real shape: all
  // 57 have a causal parent, and 37 of them name a machine event, so the
  // Prompts filter drops the parent and promotes the note to a root row.
  // Free-form payload on purpose — note_kind + note is the common case.
  await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'operator-note',
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        note_kind: 'scope-check',
        note: 'the flaky import is in the same module, so one task covers it',
      },
    },
    opts,
  );

  const edge = await appendEdge(
    {
      session_id: SESSION_ID,
      actor: 'system',
      task_id: TASK_2,
      plan_version: planVersion,
      causal_parent: parent,
      payload: { depends_on: TASK_1 },
    },
    { edge_type: 'artifact', edge_provenance: 'observed' },
    opts,
  );
  parent = edge.event_id;

  // The wave's other three dispatches hang off `wave-admitted`, not off each
  // other. A wave admits N tasks and the planner fans out N dispatches from
  // that one decision, so they are siblings — and the real log agrees: of the
  // 73 dispatch_decision events in this factory's own state/events, zero name
  // another dispatch as their causal parent, while 14 parents carry more than
  // one. Chaining them here made the fixture's timeline a staircase no real
  // log produces, and hid the sibling fan-out every causal-tree reader (the
  // Timeline's dispatch grouping, the sessions canvas) is built to fold.
  const dispatch2 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: TASK_2,
      plan_version: planVersion,
      causal_parent: waveAdmitted.event_id,
      payload: {
        agent_role: 'coder',
        provider: 'codex',
        model_tier: 'small',
        model: 'codex:default',
        reason: 'simplify the config loader',
      },
    },
    opts,
  );
  parent = dispatch2.event_id;

  const dispatch3 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: TASK_3,
      plan_version: planVersion,
      causal_parent: waveAdmitted.event_id,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'small',
        model: 'claude-haiku-4-5',
        reason: 'fix the flaky import',
      },
    },
    opts,
  );
  parent = dispatch3.event_id;

  const dispatch4 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: TASK_4,
      plan_version: planVersion,
      causal_parent: waveAdmitted.event_id,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
        reason: 'add the settings panel',
      },
    },
    opts,
  );
  parent = dispatch4.event_id;

  // --- task-1: schema-check + testgate + a blocking finding, then fixed and merged ---
  const schemaCheck1 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'system',
      event_type: 'schema-check-result',
      task_id: TASK_1,
      plan_version: planVersion,
      causal_parent: parent,
      payload: { valid: true, errors: [] },
    },
    opts,
  );
  parent = schemaCheck1.event_id;

  const testgate1 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'system',
      event_type: 'testgate-result',
      task_id: TASK_1,
      plan_version: planVersion,
      causal_parent: parent,
      payload: { pass: true, results: [] },
    },
    opts,
  );
  parent = testgate1.event_id;

  const findCtx1: EventContext = { sessionId: SESSION_ID, planVersion, causalParent: parent };
  const raised1 = await raiseFinding(
    {
      finding: {
        finding_id: 'finding-1',
        task_id: TASK_1,
        finding_category: 'correctness',
        severity: 'S2-major',
        finding_status: 'raised',
        summary: 'off-by-one in the widget loop bound',
        failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
        found_by: 'reviewer',
      },
      filePath: 'src/widget.ts',
    },
    findCtx1,
    opts,
  );
  if (raised1.suppressed) throw new Error('fixture: finding-1 unexpectedly suppressed');
  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'reviewer',
        event_type: 'severity-decisions',
        task_id: TASK_1,
        plan_version: planVersion,
        causal_parent: parent,
        payload: {
          decisions: [
            {
              fingerprint: raised1.finding.fingerprint,
              finding_id: raised1.finding.finding_id,
              original_severity: 'S2-major',
              severity: 'S2-major',
              action: 'block',
              same_mistake: false,
              matched_lesson_id: null,
            },
          ],
        },
      },
      opts,
    )
  ).event_id;

  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'gate-outcome',
        task_id: TASK_1,
        plan_version: planVersion,
        causal_parent: parent,
        payload: { outcome: 'blocked', reason: 'findings' },
      },
      opts,
    )
  ).event_id;

  for (const status of ['confirmed', 'fix-pending', 'fix-landed', 'fix-verified'] as const) {
    await transition(
      'finding-1',
      status,
      { sessionId: SESSION_ID, planVersion, causalParent: parent },
      opts,
    );
    parent = await lastEventId(opts);
  }

  const result1 = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'coder',
      event_type: 'task-result-recorded',
      task_id: TASK_1,
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        task_id: TASK_1,
        run_status: 'done',
        structured_output: {},
        artifacts: [
          { type: 'diff', path: 'artifacts/task-1.diff', description: 'the landed diff' },
        ],
        token_usage: { input_tokens: 1500, output_tokens: 500, total_tokens: 2000 },
        agent: 'coder',
        provider: 'claude',
        model_tier: 'mid',
      },
    },
    opts,
  );
  parent = result1.event_id;

  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'gate-outcome',
        task_id: TASK_1,
        plan_version: planVersion,
        causal_parent: parent,
        payload: { outcome: 'pass', reason: null },
      },
      opts,
    )
  ).event_id;

  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'wave-merged',
        plan_version: planVersion,
        causal_parent: parent,
        payload: { epic_id: EPIC_ID, task_ids: [TASK_1] },
      },
      opts,
    )
  ).event_id;

  // --- task-2: an S3 finding that gets waived (and a repeat raise gets suppressed) ---
  const findCtx2: EventContext = { sessionId: SESSION_ID, planVersion, causalParent: parent };
  const raised2 = await raiseFinding(
    {
      finding: {
        finding_id: 'finding-2',
        task_id: TASK_2,
        finding_category: 'over-engineering',
        severity: 'S3-minor',
        finding_status: 'raised',
        summary: 'unnecessary abstraction layer in the config loader',
        failure_scenario: {
          inputs: 'n/a',
          expected: 'direct read',
          actual: 'extra indirection layer',
        },
        found_by: 'reviewer',
      },
      filePath: 'src/config.ts',
    },
    findCtx2,
    opts,
  );
  if (raised2.suppressed) throw new Error('fixture: finding-2 unexpectedly suppressed');
  parent = await lastEventId(opts);

  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'reviewer',
        event_type: 'severity-decisions',
        task_id: TASK_2,
        plan_version: planVersion,
        causal_parent: parent,
        payload: {
          decisions: [
            {
              fingerprint: raised2.finding.fingerprint,
              finding_id: raised2.finding.finding_id,
              original_severity: 'S3-minor',
              severity: 'S3-minor',
              action: 'waiver-batch',
              same_mistake: false,
              matched_lesson_id: null,
            },
          ],
        },
      },
      opts,
    )
  ).event_id;

  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'gate-outcome',
        task_id: TASK_2,
        plan_version: planVersion,
        causal_parent: parent,
        payload: { outcome: 'pass-with-waivers-pending', reason: null },
      },
      opts,
    )
  ).event_id;

  const waiverCtx: EventContext = { sessionId: SESSION_ID, planVersion, causalParent: parent };
  const waiverEvent = await grantWaiver(
    raised2.finding.fingerprint,
    'accepted for now — tracked separately',
    waiverCtx,
    opts,
  );
  parent = waiverEvent.event_id;

  // Re-raising the same fingerprint on a later review round must suppress, not duplicate.
  const raised3 = await raiseFinding(
    {
      finding: {
        finding_id: 'finding-3',
        task_id: TASK_2,
        finding_category: 'over-engineering',
        severity: 'S3-minor',
        finding_status: 'raised',
        summary: 'unnecessary abstraction layer in the config loader',
        failure_scenario: {
          inputs: 'n/a',
          expected: 'direct read',
          actual: 'extra indirection layer',
        },
        found_by: 'reviewer',
      },
      filePath: 'src/config.ts',
    },
    { sessionId: SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  if (!raised3.suppressed) throw new Error('fixture: finding-3 expected to be suppressed');
  parent = await lastEventId(opts);

  // A denied waiver too, so waivers table has both decisions represented.
  const denied = await denyWaiver(
    'fp-never-waived',
    'not accepting this one',
    { sessionId: SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  parent = denied.event_id;

  // --- lessons: a candidate raised, then approved, referenced by task-1's severity-decisions ---
  const lessonRaised = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'scribe',
      event_type: 'lesson-candidate-raised',
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        lesson_id: 'lesson-1',
        lesson_type: 'rule',
        lesson_level: 'principle',
        lesson_status: 'candidate',
        lesson_scope: 'claim-path',
        statement: 'Always check the upper loop bound against array length, not a hardcoded value.',
        valid_from: new Date().toISOString(),
        provenance_event_ids: [raised1.finding.finding_id],
        evidence: 'finding-1 in epic-1/task-1',
      },
    },
    opts,
  );
  parent = lessonRaised.event_id;

  const lessonApproved = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'lesson-status-changed',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { lesson_id: 'lesson-1', to_status: 'approved' },
    },
    opts,
  );
  parent = lessonApproved.event_id;

  // --- a second lesson the operator rejected: raised, then `invalidated` ---
  // Architecture §9.6 calls an invalidated lesson a "traceable rollback, never
  // silent deletion", and lessons.ts writes `novelty-rejected` rather than
  // dropping a near-duplicate for the same reason. A fixture whose only lesson
  // is `approved` cannot tell whether a reader honours that (D-220).
  const lessonRejectedRaised = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'scribe',
      event_type: 'lesson-candidate-raised',
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        lesson_id: 'lesson-2',
        lesson_type: 'fact',
        lesson_level: 'principle',
        lesson_status: 'candidate',
        lesson_scope: 'stack-wide',
        statement: 'CI runners have no network access, so tests must not fetch remote fixtures.',
        valid_from: new Date().toISOString(),
        provenance_event_ids: [raised1.finding.finding_id],
        evidence: 'finding-1 in epic-1/task-1',
      },
    },
    opts,
  );
  parent = lessonRejectedRaised.event_id;

  const lessonRejected = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'lesson-status-changed',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { lesson_id: 'lesson-2', from_status: 'candidate', to_status: 'invalidated' },
    },
    opts,
  );
  parent = lessonRejected.event_id;

  // A later review round catches the SAME class of mistake again — the lesson "prevents" it.
  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'reviewer',
        event_type: 'severity-decisions',
        task_id: TASK_1,
        plan_version: planVersion,
        causal_parent: parent,
        payload: {
          decisions: [
            {
              fingerprint: 'fp-repeat',
              finding_id: 'finding-repeat',
              original_severity: 'S3-minor',
              severity: 'S2-major',
              action: 'block',
              same_mistake: true,
              matched_lesson_id: 'lesson-1',
            },
          ],
        },
      },
      opts,
    )
  ).event_id;

  // --- task-3: the dispatched agent errors out instead of returning a result ---
  parent = (
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'coder',
        event_type: 'error-logged',
        task_id: TASK_3,
        plan_version: planVersion,
        causal_parent: parent,
        payload: {
          error: 'coordination.deadlock',
          severity: 'S1-stop-the-line',
          task_ref: TASK_3,
          detail: 'worker deadlocked waiting on a claim it never held',
        },
      },
      opts,
    )
  ).event_id;

  // --- task-4: a finding raised and confirmed, then left there — never
  // fixed, never waived. Covers the "confirmed" branch of kanban()'s
  // open-finding severity chip (reviewer finding: OPEN_FINDING_STATUSES
  // dropping 'confirmed' passed every test until this fixture existed). ---
  const findCtx4: EventContext = { sessionId: SESSION_ID, planVersion, causalParent: parent };
  const raised4 = await raiseFinding(
    {
      finding: {
        finding_id: 'finding-4',
        task_id: TASK_4,
        finding_category: 'correctness',
        severity: 'S2-major',
        finding_status: 'raised',
        summary: 'settings panel does not persist the theme toggle',
        failure_scenario: {
          inputs: 'toggle theme, reload',
          expected: 'theme persists',
          actual: 'theme resets to default',
        },
        found_by: 'reviewer',
      },
      filePath: 'src/settings.ts',
    },
    findCtx4,
    opts,
  );
  if (raised4.suppressed) throw new Error('fixture: finding-4 unexpectedly suppressed');
  parent = await lastEventId(opts);

  await transition(
    'finding-4',
    'confirmed',
    { sessionId: SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  parent = await lastEventId(opts);

  return {
    userPromptId: prompt.event_id,
    dispatchTask1Id: dispatch1.event_id,
    dispatchTask2Id: dispatch2.event_id,
    dispatchTask3Id: dispatch3.event_id,
    finding1Id: raised1.finding.finding_id,
    finding2Id: raised2.finding.finding_id,
    finding3Id: 'finding-3',
    finding4Id: raised4.finding.finding_id,
    lessonId: 'lesson-1',
    rejectedLessonId: 'lesson-2',
  };
}
