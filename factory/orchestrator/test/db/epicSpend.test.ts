// D-207's named-not-fixed item. `epicTokenMaps()` and `tokensSpentAt()` are
// the two ends of every per-epic spend number the UI shows -- overview()'s
// tokensByEpic, roadmapPage()'s per-milestone roll-up, and the 1h budget
// delta -- and both resolved a result row to its epic with an exact map
// lookup on `payload.task_id`. The log does not oblige. In today's real
// state/events, of thirteen `task-result-recorded` rows, two spell the task
// id bare (`task-2-path-guard`, 1.58M tokens between them) and one omits it
// from the payload entirely while the envelope carries it qualified
// (`envkit-mcp-surface/task-3-env-lint`). Three rows of thirteen fell out of
// per-epic spend, and a partition that silently loses rows reads as a smaller
// number, not as an error.
//
// Uses projectSession() with hand-built events (the overviewDeltas.test.ts
// idiom) rather than appendEvent(), because the delta test needs an event `ts`
// on a chosen side of the one-hour cutoff.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectSession } from '../../src/db/projector.js';
import { overview } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

const SESSION_ID = 'sess-epic-spend-fixture';
const NOW = '2026-08-20T12:00:00.000Z';
const TWO_HOURS_AGO = '2026-08-20T10:00:00.000Z';

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

function taskAdded(
  taskId: string,
  epicId: string,
  budgetTokens: number,
  ts: string = NOW,
): StoredEvent {
  return event({
    event_type: 'task-added',
    task_id: taskId,
    actor: 'planner',
    ts,
    payload: {
      epic_id: epicId,
      case: 'feature',
      origin: 'user',
      task_status: 'completed',
      budget_tokens: budgetTokens,
    },
  });
}

/**
 * A worker's Result. `envelopeTaskId` and `payloadTaskId` are separate on
 * purpose: the two spellings and the omission are exactly what this file is
 * about, and a helper that kept them in sync could not express the log.
 */
function result(
  envelopeTaskId: string | undefined,
  payloadTaskId: string | undefined,
  totalTokens: number,
  ts: string = NOW,
): StoredEvent {
  return event({
    event_type: 'task-result-recorded',
    actor: 'coder',
    ts,
    ...(envelopeTaskId === undefined ? {} : { task_id: envelopeTaskId }),
    payload: {
      ...(payloadTaskId === undefined ? {} : { task_id: payloadTaskId }),
      run_status: 'done',
      structured_output: {},
      artifacts: [],
      token_usage: {
        input_tokens: totalTokens,
        output_tokens: 0,
        total_tokens: totalTokens,
      },
      agent: 'coder',
      provider: 'claude',
      model_tier: 'mid',
    },
  });
}

describe('per-epic spend attribution (D-207)', () => {
  let dbDir: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    eventCounter = 0;
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-epic-spend-db-'));
    const handle = openDb(path.join(dbDir, 'smith.db'));
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  /** An epic with a budget always has a row, so "not attributed" reads as 0. */
  function spentOn(epicId: string): number | undefined {
    return overview(db, { sessionId: SESSION_ID }, { nowIso: NOW }).tokensByEpic.find(
      (e) => e.epicId === epicId,
    )?.tokensSpent;
  }

  it('counts a result row whose payload spells the task id bare', () => {
    // The `task-2-path-guard` shape: both envelope and payload bare, while
    // the tasks table knows the task by its qualified id. taskInScope() folds
    // these twenty lines up the same file; the spend maps did not.
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null }),
      taskAdded('epic-e/task-1', 'epic-e', 1000),
      result('task-1', 'task-1', 300),
    ]);

    expect(spentOn('epic-e')).toBe(300);
  });

  it('counts a result row whose payload omits the id but whose envelope names it', () => {
    // The `envkit-mcp-surface/task-3-env-lint` shape: the row the finding
    // named. `events_raw.task_id` is the envelope's own field, stored
    // verbatim by the projector, and it is the same claim the payload would
    // have made.
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null }),
      taskAdded('epic-e/task-1', 'epic-e', 1000),
      result('epic-e/task-1', undefined, 700),
    ]);

    expect(spentOn('epic-e')).toBe(700);
  });

  it('still ignores a row that names no task at all, in either place', () => {
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null }),
      taskAdded('epic-e/task-1', 'epic-e', 1000),
      result(undefined, undefined, 900),
    ]);

    expect(spentOn('epic-e')).toBe(0);
  });

  it('refuses to place a bare id that two epics could both claim', () => {
    // Folding is safe for a membership predicate and unsafe for a sum: a bare
    // id counted into both epics invents spend on the one that did not incur
    // it, and makes the per-epic column add up to more than the run. Dropping
    // it is the same answer as today's, held deliberately rather than by
    // accident.
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null }),
      taskAdded('epic-e/task-1', 'epic-e', 1000),
      taskAdded('epic-f/task-1', 'epic-f', 1000),
      result('task-1', 'task-1', 400),
    ]);

    expect(spentOn('epic-e')).toBe(0);
    expect(spentOn('epic-f')).toBe(0);
  });

  it('reads the same rows at both ends of the 1h budget delta', () => {
    // The corollary D-207 wrote down: the fix for a class of bug has to be
    // applied to the whole class. epicTokenMaps() answers "now" and
    // tokensSpentAt() answers "an hour ago"; teaching only one of them to
    // read a bare id turns two-hour-old spend into a rise that never
    // happened. 300 of the 1000-token budget was spent before the cutoff and
    // 200 after, so the honest delta is 20 points, not 50.
    //
    // The budget is planned before it is spent, here as in the log: the
    // denominator of "an hour ago" is now read as of an hour ago too, so a
    // task-added stamped NOW would mean nothing was budgeted then and the
    // whole 50% would be the move since.
    projectSession({ sqlite, db }, SESSION_ID, [
      event({ event_type: 'session-start', causal_parent: null, ts: TWO_HOURS_AGO }),
      taskAdded('epic-e/task-1', 'epic-e', 1000, TWO_HOURS_AGO),
      result('task-1', 'task-1', 300, TWO_HOURS_AGO),
      result('epic-e/task-1', 'epic-e/task-1', 200),
    ]);

    const view = overview(db, { sessionId: SESSION_ID }, { nowIso: NOW });
    expect(view.tokensByEpic).toEqual([{ epicId: 'epic-e', tokensSpent: 500, tokensBudget: 1000 }]);
    expect(view.budgetUsedPctPointDelta1h).toBe(20);
  });
});
