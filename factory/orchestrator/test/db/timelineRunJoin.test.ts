import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { timeline } from '../../src/db/queries.js';
import { buildFixture, EPIC_ID, SESSION_ID, TASK_1, TASK_4 } from './fixtures.js';

describe('timeline() run + gate join (DS6 PR2)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-run-join-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-run-join-db-'));
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function openFixture(): Promise<void> {
    await buildFixture({ stateDir });
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  }

  it('a finished Dispatched row joins its run tokens, status and dispatchedAt; duration is null (no writer stamps it)', async () => {
    await openFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_1 });
    const dispatch = entries.find((e) => e.eventType === 'dispatch_decision');
    expect(dispatch).toBeDefined();
    expect(dispatch?.run).toEqual({
      tokensIn: 1500,
      tokensOut: 500,
      durationMs: null,
      runStatus: 'done',
      dispatchedAt: dispatch?.ts,
      round: 1,
    });
  });

  it('a still-running Dispatched row has runStatus null, every token field null, and dispatchedAt set', async () => {
    await openFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_4 });
    const dispatch = entries.find((e) => e.eventType === 'dispatch_decision');
    expect(dispatch).toBeDefined();
    expect(dispatch?.run?.runStatus).toBeNull();
    expect(dispatch?.run?.tokensIn).toBeNull();
    expect(dispatch?.run?.tokensOut).toBeNull();
    expect(dispatch?.run?.durationMs).toBeNull();
    expect(dispatch?.run?.dispatchedAt).toBe(dispatch?.ts);
  });

  describe.each([
    ['ended by judge-reported (no task-result)', 'done', 'judge-reported', 'done'],
    ['superseded', 'superseded', null, 'superseded'],
    ['ended by error-logged', 'error', 'error-logged', 'error'],
  ])('a Dispatched row whose agent is %s', (_label, agentStatus, terminalType, expected) => {
    it(`reads runStatus ${expected} with tokens null`, async () => {
      await openFixture();
      const before = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_4 });
      const dispatch = before.find((e) => e.eventType === 'dispatch_decision');
      expect(dispatch?.run?.runStatus).toBeNull();
      handle.sqlite
        .prepare('UPDATE agents SET status = ?, terminal_type = ? WHERE id = ?')
        .run(agentStatus, terminalType, dispatch?.eventId);
      const after = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_4 });
      const run = after.find((e) => e.eventType === 'dispatch_decision')?.run;
      expect(run?.runStatus).toBe(expected);
      expect(run?.tokensIn).toBeNull();
      expect(run?.tokensOut).toBeNull();
    });
  });

  it('non-Dispatched rows carry no run field at all', async () => {
    await openFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_1 });
    const nonDispatch = entries.filter((e) => e.eventType !== 'dispatch_decision');
    expect(nonDispatch.length).toBeGreaterThan(0);
    for (const e of nonDispatch) expect(e.run).toBeUndefined();
  });

  it('the run join costs one query per table for the page, not one per row (perf regression)', async () => {
    await openFixture();
    const totalRows = timeline(handle.db, { sessionId: SESSION_ID }).length;
    expect(totalRows).toBeGreaterThan(5);

    const spy = vi.spyOn(handle.db, 'select');
    const page = timeline(handle.db, { sessionId: SESSION_ID, limit: 2 });
    const selectCalls = spy.mock.calls.length;
    spy.mockRestore();

    expect(page.length).toBe(2);
    expect(selectCalls).toBeLessThan(totalRows);
  });

  it('Gate rows normalise pass/fail counts from testgate-result.results; an empty results array is 0/0', async () => {
    await openFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID });
    const gateRow = entries.find((e) => e.eventType === 'testgate-result');
    expect(gateRow).toBeDefined();
    expect(gateRow?.gateCounts).toEqual({ passed: 0, failed: 0 });
  });

  it('a Gate row whose payload carries no results array leaves gateCounts unset', async () => {
    await openFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID });
    const outcomeRow = entries.find((e) => e.eventType === 'gate-outcome');
    expect(outcomeRow).toBeDefined();
    expect(outcomeRow?.gateCounts).toBeUndefined();
  });

  it('non-Gate rows carry no gateCounts field at all', async () => {
    await openFixture();
    const entries = timeline(handle.db, { sessionId: SESSION_ID, taskId: TASK_1 });
    const nonGate = entries.filter((e) => e.kind !== 'Gate');
    expect(nonGate.length).toBeGreaterThan(0);
    for (const e of nonGate) expect(e.gateCounts).toBeUndefined();
  });
});
