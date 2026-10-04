import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { taskTotals } from '../../src/db/queries.js';

const SESSION_ID = 'sess-totals';

/** A raw log line with the ts spelled out, so ordering in the fixture is the
 * test's own choice and not the clock's — appendEvent() stamps the moment it
 * is called. */
function tiedLine(
  eventType: string,
  ts: string,
  payload: Record<string, unknown>,
  session: string = SESSION_ID,
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'user',
    event_type: eventType,
    plan_version: 1,
    causal_parent: eventType === 'session-start' ? null : `${session}#0`,
    payload,
    ts,
  })}\n`;
}

describe('taskTotals() (DS6 PR2)', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-task-totals-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-task-totals-db-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function buildHandle(lines: string): Promise<DbHandle> {
    await appendFile(
      path.join(stateDir, `${SESSION_ID}.jsonl`),
      tiedLine('session-start', '2029-01-01T00:00:00.000Z', {}, SESSION_ID) + lines,
      'utf8',
    );
    const dbPath = path.join(dbDir, 'totals.db');
    await rebuild(dbPath, 'all', { stateDir });
    return openDb(dbPath);
  }

  it('sums tokens and agentTimeMs, and spans elapsedMs from the first dispatch to the last result/error', async () => {
    const task = 'epic-totals/task-1';
    const handle = await buildHandle(
      tiedLine(
        'dispatch_decision',
        '2029-06-01T00:00:00.000Z',
        { task_id: task, agent_role: 'coder', provider: 'claude', model_tier: 'mid' },
      ) +
        tiedLine(
          'dispatch_decision',
          '2029-06-01T00:05:00.000Z',
          { task_id: task, agent_role: 'coder', provider: 'claude', model_tier: 'mid' },
        ) +
        tiedLine('task-result-recorded', '2029-06-01T00:10:00.000Z', {
          task_id: task,
          run_status: 'done',
          token_usage: { total_tokens: 100 },
          duration_ms: 1000,
        }),
    );
    try {
      const totals = taskTotals(handle.db, task);
      expect(totals.tokens).toBe(100);
      expect(totals.agentTimeMs).toBe(1000);
      // first dispatch 00:00:00 -> result 00:10:00 == 600000ms
      expect(totals.elapsedMs).toBe(600000);
    } finally {
      handle.sqlite.close();
    }
  });

  it('does not let a judge-report or error before the first dispatch move the start (S3 fix)', async () => {
    const task = 'epic-totals/task-2';
    const handle = await buildHandle(
      // error-logged sorts before the dispatch but must not become startTs
      tiedLine('error-logged', '2029-06-01T00:00:00.000Z', {
        task_id: task,
        error: 'execution.flaky-test',
        agent_role: 'coder',
      }) +
        tiedLine('dispatch_decision', '2029-06-01T00:05:00.000Z', {
          task_id: task,
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
        }) +
        tiedLine('task-result-recorded', '2029-06-01T00:15:00.000Z', {
          task_id: task,
          run_status: 'done',
          token_usage: { total_tokens: 10 },
        }),
    );
    try {
      const totals = taskTotals(handle.db, task);
      // dispatch 00:05:00 -> result 00:15:00 == 600000ms, NOT from the 00:00:00 error
      expect(totals.elapsedMs).toBe(600000);
    } finally {
      handle.sqlite.close();
    }
  });

  it('is immune to out-of-order insertion in the log', async () => {
    const task = 'epic-totals/task-3';
    const handle = await buildHandle(
      // result row appended before the dispatch row in the raw log
      tiedLine('task-result-recorded', '2029-06-01T00:20:00.000Z', {
        task_id: task,
        run_status: 'done',
        token_usage: { total_tokens: 5 },
      }) +
        tiedLine('dispatch_decision', '2029-06-01T00:10:00.000Z', {
          task_id: task,
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
        }),
    );
    try {
      const totals = taskTotals(handle.db, task);
      expect(totals.elapsedMs).toBe(600000);
    } finally {
      handle.sqlite.close();
    }
  });

  it('leaves tokens and agentTimeMs null (never 0) when no run measured them, while elapsedMs is still computed', async () => {
    const task = 'epic-totals/task-4';
    const handle = await buildHandle(
      tiedLine('dispatch_decision', '2029-06-01T00:00:00.000Z', {
        task_id: task,
        agent_role: 'coder',
        provider: 'claude',
        model_tier: 'mid',
      }) +
        tiedLine('task-result-recorded', '2029-06-01T00:05:00.000Z', {
          task_id: task,
          run_status: 'done',
        }),
    );
    try {
      const totals = taskTotals(handle.db, task);
      expect(totals.tokens).toBeNull();
      expect(totals.agentTimeMs).toBeNull();
      expect(totals.elapsedMs).toBe(300000);
    } finally {
      handle.sqlite.close();
    }
  });

  it('returns all nulls when the task has no runs at all', async () => {
    const task = 'epic-totals/task-5';
    const handle = await buildHandle('');
    try {
      const totals = taskTotals(handle.db, task);
      expect(totals.tokens).toBeNull();
      expect(totals.agentTimeMs).toBeNull();
      expect(totals.elapsedMs).toBeNull();
    } finally {
      handle.sqlite.close();
    }
  });
});
