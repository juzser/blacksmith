// Phase 6b fix-round (code review #11): dedicated coverage for timeline()'s
// `decisionsOnly` lens — the mutation "drop the `entry.actor === 'user'`
// check from isDecisionEntry()" must fail these tests (a system-actor
// waiver/lesson event would otherwise leak into the lens).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb } from '../../src/db/projector.js';
import { timeline } from '../../src/db/queries.js';
import { appendEvent, type EventOpts } from '../../src/events.js';

const SESSION_ID = 'sess-decisions-lens-fixture';

async function buildDecisionsLensFixture(opts: EventOpts): Promise<void> {
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

  // 1. user_prompt — always a decision, regardless of actor field's value.
  const prompt = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'user_prompt',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { prompt: 'Ship the lens.' },
    },
    opts,
  );
  parent = prompt.event_id;

  // 2. dispatch_decision causally attached to the prompt (parent_prompt_id) — included.
  const attachedDispatch = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: 'epic-1/task-1',
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
        reason: 'attached to the prompt',
        parent_prompt_id: prompt.event_id,
      },
    },
    opts,
  );
  parent = attachedDispatch.event_id;

  // 3. dispatch_decision with NO parent_prompt_id and no causal_parent link
  //    to a decision event — NOT causally attached, excluded.
  const unattachedDispatch = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: 'epic-1/task-2',
      plan_version: planVersion,
      causal_parent: parent,
      payload: {
        agent_role: 'coder',
        provider: 'codex',
        model_tier: 'small',
        model: 'codex:default',
        reason: 'unrelated dispatch',
      },
    },
    opts,
  );
  parent = unattachedDispatch.event_id;

  // 4. waiver-granted with actor: 'user' — a real operator decision, included.
  const userWaiver = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'waiver-granted',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { fingerprint: 'fp-user-granted', operator_note: 'looks fine' },
    },
    opts,
  );
  parent = userWaiver.event_id;

  // 5. waiver-denied with actor: 'system' — NOT operator-authored, excluded
  //    even though the event_type is in DECISION_EVENT_TYPES.
  const systemWaiver = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'system',
      event_type: 'waiver-denied',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { fingerprint: 'fp-system-denied', operator_note: 'auto-denied by policy' },
    },
    opts,
  );
  parent = systemWaiver.event_id;

  // 6. lesson-status-changed with actor: 'scribe' — NOT operator-authored, excluded.
  const scribeLesson = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'scribe',
      event_type: 'lesson-status-changed',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { lesson_id: 'lesson-1', to_status: 'pending-approval' },
    },
    opts,
  );
  parent = scribeLesson.event_id;

  // 7. lesson-status-changed with actor: 'user' (an approve/reject click) — included.
  const userLesson = await appendEvent(
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
  parent = userLesson.event_id;

  // 8. waiver-granted with actor: 'operator' — D-163's sibling, D-164. This is
  //    the actor string docs/guide/operator-guide.md:1276 hands the operator
  //    for exactly this command, and 'user' is the one the UI writes when no
  //    --actor is passed. Both are the same person deciding the same thing.
  const operatorWaiver = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'operator',
      event_type: 'waiver-granted',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { fingerprint: 'fp-operator-granted', operator_note: 'accepted the risk' },
    },
    opts,
  );
  parent = operatorWaiver.event_id;

  // 9. lesson-status-changed with actor: 'operator-skill' — what the factory's
  //    own console writes; 467 of the 668 events in the real store carry it.
  const consoleLesson = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'operator-skill',
      event_type: 'lesson-status-changed',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { lesson_id: 'lesson-2', to_status: 'approved' },
    },
    opts,
  );
  parent = consoleLesson.event_id;

  // 10. operator-note with actor: 'operator-skill' — D-213. The operator's own
  //     reasoning, written in their own words, and the third most common event
  //     in the real store (57 of 670). Included.
  const note = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'operator-skill',
      event_type: 'operator-note',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { note_kind: 'decision', note: 'Widen, do not narrow.' },
    },
    opts,
  );
  parent = note.event_id;

  // 11. dispatch_decision causally attached to that note — the work the
  //     operator's decision caused. Included with it, or the lens shows the
  //     decision and hides what came of it.
  const noteDispatch = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'planner',
      event_type: 'dispatch_decision',
      task_id: 'epic-1/task-3',
      plan_version: planVersion,
      causal_parent: note.event_id,
      payload: {
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
        model: 'claude-sonnet-5',
        reason: 'attached to the operator note',
      },
    },
    opts,
  );
  parent = noteDispatch.event_id;

  // 12. operator-note with actor: 'scribe' — the type is open on the write
  //     side, so an agent can append one. The actor guard has to cover this
  //     type exactly as it covers the waivers and the lessons.
  await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'scribe',
      event_type: 'operator-note',
      plan_version: planVersion,
      causal_parent: parent,
      payload: { note_kind: 'summary', note: 'Distilled from the run.' },
    },
    opts,
  );
}

describe('timeline() decisionsOnly lens (Phase 6b fix-round)', () => {
  let stateDir: string;
  let dbDir: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-decisions-lens-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-decisions-lens-db-'));
    const dbPath = path.join(dbDir, 'smith.db');
    await buildDecisionsLensFixture({ stateDir });
    await apply(dbPath, SESSION_ID, { stateDir });
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('includes user_prompt + the causally-attached dispatch_decision + the user-actor waiver', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    const types = entries.map((e) => e.eventType);
    expect(types).toContain('user_prompt');
    expect(types).toContain('waiver-granted');
    expect(entries.some((e) => e.taskId === 'epic-1/task-1')).toBe(true); // the attached dispatch
  });

  it('excludes a dispatch_decision with no causal/parent_prompt_id attachment to a decision', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    expect(entries.some((e) => e.taskId === 'epic-1/task-2')).toBe(false);
  });

  it('excludes a system-actor waiver-denied event even though its event_type is a decision kind', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    expect(entries.some((e) => e.eventType === 'waiver-denied')).toBe(false);
  });

  it('excludes a scribe-actor lesson-status-changed but includes the operator-authored ones', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    const lessonEntries = entries.filter((e) => e.eventType === 'lesson-status-changed');
    expect(lessonEntries.map((e) => e.actor)).toEqual(['user', 'operator-skill']);
    expect(lessonEntries.every((e) => e.payload.to_status === 'approved')).toBe(true);
  });

  // D-164. The lens asked `actor === 'user'`, and the factory has never written
  // that string: 668 real events carry operator-skill (467), system (119) and
  // operator (74), so the lens was empty over every session ever recorded — 643
  // timeline rows, 0 decisions. The guard is right to exist; the vocabulary it
  // guarded against was one string wide.
  it('includes a waiver the operator granted as --actor operator (D-164)', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    const grants = entries.filter((e) => e.eventType === 'waiver-granted');
    expect(grants.map((e) => e.actor)).toEqual(['user', 'operator']);
  });

  it('includes a lesson decision the operator console recorded (D-164)', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    expect(entries.some((e) => e.actor === 'operator-skill')).toBe(true);
  });

  // D-213. D-153 taught the Prompts chip that "a person said this" means
  // user_prompt OR operator-note, because this factory's logs hold 0 of the
  // first and 57 of the second. The Decisions lens is the stronger form of the
  // same question and was left knowing only user_prompt, so over the real store
  // it answered with 27 of the 103 rows it exists to show: every one of the
  // operator's own notes gone, and the 19 dispatches those notes caused with
  // them. The vocabulary was one string wide in exactly the way D-164's was.
  it("includes the operator's own note (D-213)", () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    const notes = entries.filter((e) => e.eventType === 'operator-note');
    expect(notes.map((e) => e.payload.note)).toEqual(['Widen, do not narrow.']);
  });

  it('includes the dispatch that note caused (D-213)', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    expect(entries.some((e) => e.taskId === 'epic-1/task-3')).toBe(true);
  });

  it('excludes an agent-actor operator-note (D-213: the actor guard covers it too)', () => {
    const entries = timeline(db, { sessionId: SESSION_ID, decisionsOnly: true });
    expect(entries.some((e) => e.actor === 'scribe')).toBe(false);
  });

  it('the unfiltered timeline still contains every content event (the lens narrows, it does not lose data)', () => {
    // 13 content events: session-start, user_prompt, 3x dispatch_decision,
    // 2x waiver-granted, waiver-denied, 3x lesson-status-changed, 2x
    // operator-note. session-start used to be dropped by timeline()'s eventType
    // filter — the root event of every log, absent from the log's own view of
    // itself — and this count pinned that. FREE_TIMELINE_EVENT_TYPES now
    // carries it, and operator-note alongside it.
    const all = timeline(db, { sessionId: SESSION_ID });
    expect(all.length).toBe(13);
  });
});
