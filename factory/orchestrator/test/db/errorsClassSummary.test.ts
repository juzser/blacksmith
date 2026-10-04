// DS6 PR2 (§4.3 Errors chip, audit Errors-5) — a new class-level summary on
// top of `errorsPage()`'s existing per-triple `byClass`/`byDay` (D-214): rows
// across sessions/projects merge by `${errorGroup}.${errorClass}` ALONE, and
// gain severityMix/lastSeen/projects/trend7d. `byClass`/`byDay` are untouched
// so existing consumers stay compatible.
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { errorsPage } from '../../src/db/queries.js';

function errorLine(
  ts: string,
  session: string,
  causalParent: string | null,
  opts: { error: string; severity: string; project?: string; taskId?: string },
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'coder',
    event_type: 'error-logged',
    plan_version: 1,
    causal_parent: causalParent,
    task_id: opts.taskId ?? 'epic-a/task-1',
    ...(opts.project ? { project: opts.project } : {}),
    payload: {
      error: opts.error,
      severity: opts.severity,
      task_ref: opts.taskId ?? 'epic-a/task-1',
    },
    ts,
  })}\n`;
}

function sessionStartLine(ts: string, session: string): string {
  return `${JSON.stringify({
    session_id: session,
    actor: 'system',
    event_type: 'session-start',
    plan_version: 1,
    causal_parent: null,
    payload: {},
    ts,
  })}\n`;
}

describe('errorsPage() class summary (DS6 PR2)', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-error-class-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-error-class-db-'));
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function openFixture(): Promise<void> {
    const x = 'class-x';
    const y = 'class-y';
    // Session x, project proj-a: two S2 errors of the same class, three days
    // and one day before "now" (2030-04-10T12:00:00Z).
    await appendFile(
      path.join(stateDir, `${x}.jsonl`),
      sessionStartLine('2030-04-01T00:00:00.000Z', x) +
        errorLine('2030-04-07T09:00:00.000Z', x, `${x}#0`, {
          error: 'execution.test-failure',
          severity: 'S2-major',
          project: 'proj-a',
        }) +
        errorLine('2030-04-09T09:00:00.000Z', x, `${x}#1`, {
          error: 'execution.test-failure',
          severity: 'S2-major',
          project: 'proj-a',
        }),
      'utf8',
    );
    // Session y, project proj-b: one S3 error of the same class, "today", and
    // one unrelated class (judgment.hallucination) that must stay separate.
    await appendFile(
      path.join(stateDir, `${y}.jsonl`),
      sessionStartLine('2030-04-01T00:00:00.000Z', y) +
        errorLine('2030-04-10T08:00:00.000Z', y, `${y}#0`, {
          error: 'execution.test-failure',
          severity: 'S3-minor',
          project: 'proj-b',
        }) +
        errorLine('2030-04-10T08:30:00.000Z', y, `${y}#1`, {
          error: 'judgment.hallucination',
          severity: 'S1-stop-the-line',
          project: 'proj-b',
        }),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  }

  const NOW = '2030-04-10T12:00:00.000Z';

  it('merges rows of the same class across sessions and projects into one summary row', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    const testFailure = result.classSummary.find((r) => r.id === 'execution.test-failure');
    expect(testFailure).toBeDefined();
    expect(testFailure?.count).toBe(3);
    expect(testFailure?.errorGroup).toBe('execution');
    expect(testFailure?.errorClass).toBe('test-failure');
  });

  it('keeps a different class in its own summary row', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    expect(result.classSummary.find((r) => r.id === 'judgment.hallucination')?.count).toBe(1);
    expect(result.classSummary).toHaveLength(2);
  });

  it('reports severity mix across the merged rows', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    const testFailure = result.classSummary.find((r) => r.id === 'execution.test-failure');
    expect(testFailure?.severityMix).toEqual({ 'S2-major': 2, 'S3-minor': 1 });
  });

  it('reports the distinct list of projects the class occurred in', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    const testFailure = result.classSummary.find((r) => r.id === 'execution.test-failure');
    expect(testFailure?.projects.slice().sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('reports lastSeen as the most recent row ts', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    const testFailure = result.classSummary.find((r) => r.id === 'execution.test-failure');
    expect(testFailure?.lastSeen).toBe('2030-04-10T08:00:00.000Z');
  });

  it('buckets trend7d into 7 UTC daily counts, oldest-first, ending today, honouring the day boundary', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    const testFailure = result.classSummary.find((r) => r.id === 'execution.test-failure');
    // Window: 04-04 .. 04-10. The 04-07 and 04-09 rows land on their own
    // days; the 04-10 row lands on "today". 04-01's session-start is not an
    // error and must not be counted.
    expect(testFailure?.trend7d).toEqual([0, 0, 0, 1, 0, 1, 1]);
    expect(testFailure?.trend7d).toHaveLength(7);
  });

  it('leaves byClass and byDay (the pre-existing per-triple shape) untouched', async () => {
    await openFixture();
    const result = errorsPage(handle.db, {}, { nowIso: NOW });
    expect(result.byClass.length).toBe(3); // the 3 distinct (class, severity) triples
    expect(result.byDay.length).toBeGreaterThan(0);
  });
});
