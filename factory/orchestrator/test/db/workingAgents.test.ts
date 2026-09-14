// "Working" vs "stalled" agents (ui/running-only-liveness): the server-side
// counterpart of ui/src/lib/liveness.ts's agentActivity(). An agent is
// working iff its registry row is live AND its dispatch is within
// DEFAULT_STALE_HOURS of "now" (strict `>` stales, exactly as detectStale()
// does). Every field under test is additive: the liveAgentCount* fields and
// their tests stand untouched, and these assertions sit beside them.
//
// Same fixture technique as overviewDeltas.test.ts: projectSession() over
// hand-built StoredEvents, because appendEvent() stamps the wall clock and
// the 4h boundary (working at exactly 4h, stalled at 4h + 1ms) is only
// reachable with a `ts` the test chooses.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STALE_HOURS, isWorkingAt } from '../../src/agents-registry.js';
import { openDb, projectSession } from '../../src/db/projector.js';
import { flowGraph, overview, runningSessions } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const SESSION_ID = 'sess-working-agents-fixture';
const NOW = '2026-08-04T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const HOUR_MS = 60 * 60 * 1000;
const STALE_MS = DEFAULT_STALE_HOURS * HOUR_MS;

function isoAt(deltaMs: number): string {
  return new Date(NOW_MS + deltaMs).toISOString();
}

const EXACTLY_STALE_AGO = isoAt(-STALE_MS); // 4h before NOW: still working
const JUST_PAST_STALE_AGO = isoAt(-STALE_MS - 1); // 4h + 1ms: stalled
const FIVE_MIN_AGO = isoAt(-5 * 60 * 1000);
const FOUR_H_FIVE_MIN_AGO = isoAt(-STALE_MS - 5 * 60 * 1000);
const ONE_MIN_AGO = isoAt(-60 * 1000);

let eventCounter = 0;
function event(overrides: Partial<StoredEvent['record']> & { event_type: string }): StoredEvent {
  eventCounter += 1;
  return {
    event_id: `${SESSION_ID}#${eventCounter}`,
    record: {
      session_id: SESSION_ID,
      actor: 'system',
      plan_version: 1,
      causal_parent: eventCounter === 1 ? null : `${SESSION_ID}#${eventCounter - 1}`,
      payload: {},
      ts: NOW,
      ...overrides,
    },
  };
}

// The epic is the task id's prefix, so a fixture that wants two projects
// gives them two epics: under a project scope an agent is placed by its epic
// as well as its task (D-234), and one epic straddling two projects would
// put every agent in both.
function taskAdded(taskId: string, ts: string, project?: string): StoredEvent {
  const epicId = taskId.slice(0, taskId.indexOf('/'));
  return event({
    event_type: 'task-added',
    task_id: taskId,
    ts,
    ...(project ? { project } : {}),
    payload: { epic_id: epicId, case: 'feature', origin: 'user', task_status: 'todo' },
  });
}

function dispatched(taskId: string, ts: string, role = 'coder', project?: string): StoredEvent {
  return event({
    event_type: 'dispatch_decision',
    task_id: taskId,
    ts,
    ...(project ? { project } : {}),
    payload: { agent_role: role, provider: 'claude', model_tier: 'mid', model: 'claude-sonnet-5' },
  });
}

describe('isWorkingAt()', () => {
  it('is working at exactly the stale threshold and stalled one millisecond past it', () => {
    expect(isWorkingAt(EXACTLY_STALE_AGO, NOW)).toBe(true);
    expect(isWorkingAt(JUST_PAST_STALE_AGO, NOW)).toBe(false);
  });

  it('never calls an unparseable dispatch timestamp working', () => {
    expect(isWorkingAt('not-a-date', NOW)).toBe(false);
    expect(isWorkingAt('', NOW)).toBe(false);
  });

  it('treats a future-dated dispatch as working (clock skew is not staleness)', () => {
    expect(isWorkingAt(isoAt(HOUR_MS), NOW)).toBe(true);
  });
});

describe('working vs stalled agents in the projection queries', () => {
  let dbDir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    eventCounter = 0;
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-working-agents-db-'));
    dbPath = path.join(dbDir, 'smith.db');
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('overview(): a dispatch at exactly 4h is working, one at 4h + 1ms is stalled, and the two counts add up to liveAgentCount', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: JUST_PAST_STALE_AGO }),
      taskAdded('epic-1/task-1', JUST_PAST_STALE_AGO),
      taskAdded('epic-1/task-2', JUST_PAST_STALE_AGO),
      dispatched('epic-1/task-1', JUST_PAST_STALE_AGO),
      dispatched('epic-1/task-2', EXACTLY_STALE_AGO),
    ]);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.liveAgentCount).toBe(2);
    expect(result.workingAgentCount).toBe(1);
    expect(result.stalledAgentCount).toBe(1);
  });

  it('overview(): an unparseable dispatchedAt is live but never working', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: ONE_MIN_AGO }),
      taskAdded('epic-1/task-1', ONE_MIN_AGO),
      dispatched('epic-1/task-1', 'garbage-timestamp'),
    ]);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.liveAgentCount).toBe(1);
    expect(result.workingAgentCount).toBe(0);
    expect(result.stalledAgentCount).toBe(1);
  });

  it('overview(): workingAgentCountDelta5m applies the 4h window at the cutoff too (D-170: one population at both ends)', () => {
    // Dispatched 4h05m ago: at the 5-minute cutoff it was 4h old, so working
    // *then*; now it is 4h05m old, so stalled. No new dispatch since. The
    // live delta is 0 (live at both ends); the working delta must read -1.
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: FOUR_H_FIVE_MIN_AGO }),
      taskAdded('epic-1/task-1', FOUR_H_FIVE_MIN_AGO),
      dispatched('epic-1/task-1', FOUR_H_FIVE_MIN_AGO),
    ]);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.liveAgentCountDelta5m).toBe(0);
    expect(result.workingAgentCount).toBe(0);
    expect(result.workingAgentCountDelta5m).toBe(-1);
  });

  it('overview(): a dispatch after the cutoff raises workingAgentCountDelta5m by one', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: FIVE_MIN_AGO }),
      taskAdded('epic-1/task-1', FIVE_MIN_AGO),
      dispatched('epic-1/task-1', ONE_MIN_AGO),
    ]);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.workingAgentCount).toBe(1);
    expect(result.workingAgentCountDelta5m).toBe(1);
  });

  it('overview(): the delta under a project scope counts only that project at both ends', () => {
    // Two projects, one stalled-since-the-cutoff agent each. Scoped to
    // envkit the delta must be -1, not -2: the cutoff population is scoped
    // through the owning task the same way the live one is.
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: FOUR_H_FIVE_MIN_AGO }),
      taskAdded('epic-1/task-1', FOUR_H_FIVE_MIN_AGO, 'envkit'),
      taskAdded('epic-2/task-2', FOUR_H_FIVE_MIN_AGO, 'other'),
      dispatched('epic-1/task-1', FOUR_H_FIVE_MIN_AGO, 'coder', 'envkit'),
      dispatched('epic-2/task-2', FOUR_H_FIVE_MIN_AGO, 'coder', 'other'),
    ]);
    const all = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(all.workingAgentCountDelta5m).toBe(-2);
    const scoped = overview(db, { sessionId: SESSION_ID, project: 'envkit' }, { nowIso: NOW });
    expect(scoped.workingAgentCountDelta5m).toBe(-1);
  });

  it('runningSessions() and overview().runningSessions carry workingAgentCount beside liveAgentCount', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: JUST_PAST_STALE_AGO }),
      taskAdded('epic-1/task-1', JUST_PAST_STALE_AGO),
      taskAdded('epic-1/task-2', JUST_PAST_STALE_AGO),
      dispatched('epic-1/task-1', JUST_PAST_STALE_AGO),
      dispatched('epic-1/task-2', ONE_MIN_AGO),
    ]);
    const direct = runningSessions(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ liveAgentCount: 2, workingAgentCount: 1 });

    const viaOverview = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(viaOverview.runningSessions[0]).toMatchObject({
      liveAgentCount: 2,
      workingAgentCount: 1,
    });
  });

  it('overview().projects[] carries workingAgentCount per project, read at the same instant', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: JUST_PAST_STALE_AGO }),
      taskAdded('epic-1/task-1', JUST_PAST_STALE_AGO, 'envkit'),
      taskAdded('epic-1/task-2', JUST_PAST_STALE_AGO, 'envkit'),
      taskAdded('epic-2/task-3', JUST_PAST_STALE_AGO, 'other'),
      dispatched('epic-1/task-1', JUST_PAST_STALE_AGO, 'coder', 'envkit'),
      dispatched('epic-1/task-2', ONE_MIN_AGO, 'coder', 'envkit'),
      dispatched('epic-2/task-3', ONE_MIN_AGO, 'coder', 'other'),
    ]);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    const byProject = new Map((result.projects ?? []).map((p) => [p.project, p]));
    expect(byProject.get('envkit')).toMatchObject({ liveAgentCount: 2, workingAgentCount: 1 });
    expect(byProject.get('other')).toMatchObject({ liveAgentCount: 1, workingAgentCount: 1 });
  });

  it('flowGraph(): workingAgentRole is absent for a stalled agent while liveAgentRole still names it', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: JUST_PAST_STALE_AGO }),
      taskAdded('epic-1/task-1', JUST_PAST_STALE_AGO),
      taskAdded('epic-1/task-2', JUST_PAST_STALE_AGO),
      dispatched('epic-1/task-1', JUST_PAST_STALE_AGO, 'coder'),
      dispatched('epic-1/task-2', ONE_MIN_AGO, 'reviewer'),
    ]);
    const graph = flowGraph(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    const byTask = new Map(graph.nodes.map((n) => [n.taskId, n]));
    expect(byTask.get('epic-1/task-1')).toMatchObject({
      liveAgentRole: 'coder',
      workingAgentRole: null,
    });
    expect(byTask.get('epic-1/task-2')).toMatchObject({
      liveAgentRole: 'reviewer',
      workingAgentRole: 'reviewer',
    });
  });
});
