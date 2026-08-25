// Phase 6b fix-round (code review #13): overview()'s liveAgentCountDelta5m
// / budgetUsedPctPointDelta1h StatCard deltas, exact-boundary + empty-
// history cases. Uses projectSession() directly with hand-built StoredEvent
// arrays (not the file-based appendEvent()) so event `ts` is fully
// controllable — appendEvent() always stamps `new Date().toISOString()`,
// which can't hit an exact cutoff boundary deterministically.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectSession } from '../../src/db/projector.js';
import { overview } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const SESSION_ID = 'sess-overview-deltas-fixture';
const NOW = '2026-08-04T12:00:00.000Z';
const FIVE_MIN_AGO = '2026-08-04T11:55:00.000Z'; // exact cutoff for the 5min delta
const ONE_HOUR_AGO = '2026-08-04T11:00:00.000Z'; // exact cutoff for the 1h delta

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

describe('overview() StatCard deltas (Phase 6b fix-round)', () => {
  let dbDir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    eventCounter = 0;
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-overview-deltas-db-'));
    dbPath = path.join(dbDir, 'smith.db');
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('empty history: liveAgentCountDelta5m is 0, budgetUsedPctPointDelta1h is null (no budget)', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null }),
    ]);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.liveAgentCountDelta5m).toBe(0);
    expect(result.budgetUsedPctPointDelta1h).toBeNull();
  });

  it('a dispatch at exactly the 5-minute cutoff counts as "live 5 minutes ago" (lte, not lt)', () => {
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: FIVE_MIN_AGO }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: FIVE_MIN_AGO,
        payload: { epic_id: 'epic-1', case: 'feature', origin: 'user', task_status: 'todo' },
      }),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        ts: FIVE_MIN_AGO, // exactly at the cutoff
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    // Still live now (never terminated) AND live at the exact 5min-ago cutoff -> delta 0.
    expect(result.liveAgentCount).toBe(1);
    expect(result.liveAgentCountDelta5m).toBe(0);
  });

  it('a dispatch strictly AFTER the 5-minute cutoff is a net-new agent (delta +1)', () => {
    const justAfterCutoff = '2026-08-04T11:55:01.000Z';
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: justAfterCutoff }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: justAfterCutoff,
        payload: { epic_id: 'epic-1', case: 'feature', origin: 'user', task_status: 'todo' },
      }),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        ts: justAfterCutoff,
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.liveAgentCount).toBe(1);
    expect(result.liveAgentCountDelta5m).toBe(1);
  });

  // D-161. `liveAgentCountAt` re-runs agents-registry.ts's fold over a slice of
  // events_raw, and its own comment promises "a snapshot can never disagree
  // with the live agents table's own semantics" because "the fold logic is
  // REUSED, not re-implemented". But the slice is taken with a hand-written
  // list of event types that omits `judge-reported` — a terminal the fold has
  // honoured since P9-11. The event that closes a judge never reaches the
  // fold, so every judge that ever reported is live forever in the historical
  // half of the subtraction, and the card shows a drop that never happened.
  it('a judge that reported before the cutoff is not live 5 minutes ago (D-161)', () => {
    const longAgo = '2026-08-04T11:00:00.000Z';
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: longAgo }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: longAgo,
        payload: { epic_id: 'epic-1', case: 'feature', origin: 'user', task_status: 'todo' },
      }),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        ts: longAgo,
        payload: {
          agent_role: 'reviewer',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          declared_artifact: './review.json',
        },
      }),
      event({
        event_type: 'judge-reported',
        task_id: 'epic-1/task-1',
        ts: longAgo,
        payload: { agent_role: 'reviewer', round: 1, artifact: './review.json' },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    // Nobody is live now, and nobody was live five minutes ago either: the
    // judge was dispatched and reported a full hour before the cutoff.
    expect(result.liveAgentCount).toBe(0);
    expect(result.liveAgentCountDelta5m).toBe(0);
  });

  // The same slice, for the terminal D-160 added: a cross-provider judge is
  // dispatched into the registry and closed by its `judge-verdict`. Deriving
  // the list from REGISTRY_EVENT_TYPES is what makes this case free — a
  // hand-copied list would have needed a second edit nobody would make.
  it('a cross-provider judge that returned before the cutoff is not live 5 minutes ago', () => {
    const longAgo = '2026-08-04T11:00:00.000Z';
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: longAgo }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: longAgo,
        payload: { epic_id: 'epic-1', case: 'feature', origin: 'user', task_status: 'todo' },
      }),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        ts: longAgo,
        payload: {
          agent_role: 'verifier',
          provider: 'codex',
          model_tier: 'frontier',
          model: 'codex:default',
          reason: 'cross-provider judge (active)',
        },
      }),
      event({
        event_type: 'judge-verdict',
        task_id: 'epic-1/task-1',
        ts: longAgo,
        payload: { task_id: 'epic-1/task-1', agent: 'verifier', provider: 'codex', ok: true },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.liveAgentCount).toBe(0);
    expect(result.liveAgentCountDelta5m).toBe(0);
  });

  it('a task-result at exactly the 1-hour cutoff counts toward spend "1 hour ago" (delta 0pp)', () => {
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: ONE_HOUR_AGO }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO,
        payload: {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 1000,
        },
      }),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO, // exactly at the cutoff
        payload: { task_id: 'epic-1/task-1', token_usage: { total_tokens: 500 } },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(result.budgetUsedPctPointDelta1h).toBe(0);
  });

  it('spend strictly AFTER the 1-hour cutoff raises budget-used % (positive delta)', () => {
    const justAfterCutoff = '2026-08-04T11:00:01.000Z';
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: justAfterCutoff }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: justAfterCutoff,
        payload: {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 1000,
        },
      }),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-1/task-1',
        ts: justAfterCutoff,
        payload: { task_id: 'epic-1/task-1', token_usage: { total_tokens: 500 } },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    // 50% now, 0% an hour ago -> +50pp.
    expect(result.budgetUsedPctPointDelta1h).toBe(50);
  });

  // D-170. The two halves of this delta counted different populations. The
  // "now" half (epicTokenMaps) attributes a result to a project through the
  // TASK it belongs to; the "1 hour ago" half (tokensSpentAt) additionally
  // filtered on the EVENT's own `project` column, which is null on every row
  // logged before Phase 6b. A result whose task is tagged but whose event is
  // not therefore counted toward "now" and not toward "an hour ago" — the
  // subtraction reported spend that never happened, and only in project
  // scope. The factory's own log carries nine such rows.
  it('counts an untagged result the same way at both ends of the delta (D-170)', () => {
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: ONE_HOUR_AGO }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO,
        project: 'envkit',
        payload: {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 1000,
        },
      }),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO, // an hour old: nothing was spent in the last hour
        // No `project` — the pre-Phase-6b shape, and the shape the factory's
        // own `task-result-recorded` rows actually have.
        payload: { task_id: 'epic-1/task-1', token_usage: { total_tokens: 500 } },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const scoped = overview(db, { sessionId: SESSION_ID, project: 'envkit' }, { nowIso: NOW });
    const unscoped = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    // The spend is an hour old in both readings, so neither may report a rise.
    expect(unscoped.budgetUsedPctPointDelta1h).toBe(0);
    expect(scoped.budgetUsedPctPointDelta1h).toBe(0);
  });

  // D-170, the other half of the same mismatch. `allAgentsForScope()` scopes
  // the live count through the owning TASK — it says so in its own comment,
  // because the agents table has no project column. `liveAgentCountAt()`
  // scoped its event slice by the EVENT's project instead, so an untagged
  // dispatch left the historical fold while its agent stayed in the live one.
  it('counts an untagged dispatch the same way at both ends of the delta (D-170)', () => {
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: ONE_HOUR_AGO }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO,
        project: 'envkit',
        payload: { epic_id: 'epic-1', case: 'feature', origin: 'user', task_status: 'todo' },
      }),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO, // an hour old: nothing was dispatched in the last 5 minutes
        // No `project` — the pre-Phase-6b shape.
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const scoped = overview(db, { sessionId: SESSION_ID, project: 'envkit' }, { nowIso: NOW });
    // The agent is in scope now (its task is envkit), so it was in scope then.
    expect(scoped.liveAgentCount).toBe(1);
    expect(scoped.liveAgentCountDelta5m).toBe(0);
  });

  // The delta is the change in a RATIO, and only one of its two terms was
  // read as of the cutoff. `pctAgo` divided the hour-old spend by the budget
  // as it stands NOW, so a budget that grew during the hour shrank the
  // historical percentage after the fact -- the gauge fell from 90% to 10%
  // and the card reported it rising by a point.
  //
  // `tasks.budgetTokens` is written by exactly one event type (projector.ts's
  // `task-added` case, `p.budget_tokens ?? row.budgetTokens`), so folding
  // those rows up to the cutoff reproduces the column as it stood -- the same
  // move `tokensSpentAt` already makes for the other term.
  it('divides the hour-old spend by the budget as it stood then, not as it stands now', () => {
    const twoHoursAgo = '2026-08-04T10:00:00.000Z';
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: twoHoursAgo }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: twoHoursAgo,
        payload: {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 1000,
        },
      }),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-1/task-1',
        ts: twoHoursAgo,
        payload: { task_id: 'epic-1/task-1', token_usage: { total_tokens: 900 } },
      }),
      // Planned inside the hour, and nine times the budget of what came
      // before it: the epic just got bigger, not cheaper.
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-2',
        ts: NOW,
        payload: {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          budget_tokens: 9000,
        },
      }),
      event({
        event_type: 'task-result-recorded',
        task_id: 'epic-1/task-2',
        ts: NOW,
        payload: { task_id: 'epic-1/task-2', token_usage: { total_tokens: 100 } },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const result = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    // 900/1000 = 90% an hour ago, 1000/10000 = 10% now.
    expect(result.budgetUsedPctPointDelta1h).toBe(-80);
  });

  // D-170 guard: dropping the event-level filter must not let another
  // project's agents into this project's historical count.
  it("keeps another project's agent out of the historical count (D-170)", () => {
    const events: StoredEvent[] = [
      event({ event_type: 'session-start', causal_parent: null, ts: ONE_HOUR_AGO }),
      event({
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO,
        project: 'other',
        payload: { epic_id: 'epic-1', case: 'feature', origin: 'user', task_status: 'todo' },
      }),
      event({
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        ts: ONE_HOUR_AGO,
        project: 'other',
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      }),
    ];
    projectSession({ sqlite, db }, SESSION_ID, events);
    const scoped = overview(db, { sessionId: SESSION_ID, project: 'envkit' }, { nowIso: NOW });
    expect(scoped.liveAgentCount).toBe(0);
    expect(scoped.liveAgentCountDelta5m).toBe(0);
  });
});
