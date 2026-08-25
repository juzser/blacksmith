// D-214 — a row's identity is the triple, not the group. errorsPage() buckets
// its rows by `${group}.${class}|${severity}` and then returns them without
// that key, so every consumer has to re-derive it. The Errors table did not:
// it keyed its rows by `errorGroup` alone, which repeats by construction (the
// same page's own bar chart exists precisely to SUM the rows that share a
// group). This fixture is deliberately self-contained -- fixtures.ts logs a
// single error, which is the one shape under which the bug is invisible.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb } from '../../src/db/projector.js';
import { errorsPage } from '../../src/db/queries.js';
import { appendEvent, type EventOpts } from '../../src/events.js';

const SESSION_ID = 'sess-error-identity';

/** group.class + severity pairs chosen so that each collision axis is
 *  exercised once: same group different class, same class different
 *  severity, and a plain repeat that must still fold into one row. */
const ERRORS: Array<{ error: string; severity: string }> = [
  { error: 'execution.test-failure', severity: 'S2-major' },
  { error: 'execution.test-failure', severity: 'S2-major' },
  { error: 'execution.regression', severity: 'S2-major' },
  { error: 'execution.test-failure', severity: 'S3-minor' },
  { error: 'judgment.hallucination', severity: 'S1-stop-the-line' },
];

async function buildErrorFixture(opts: EventOpts): Promise<void> {
  const root = await appendEvent(
    {
      session_id: SESSION_ID,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    opts,
  );
  let parent = root.event_id;
  for (const e of ERRORS) {
    const logged = await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'coder',
        event_type: 'error-logged',
        task_id: 'epic-a/task-1',
        plan_version: 1,
        causal_parent: parent,
        payload: { error: e.error, severity: e.severity, task_ref: 'epic-a/task-1' },
      },
      opts,
    );
    parent = logged.event_id;
  }
}

describe('errorsPage() row identity', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-error-identity-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-error-identity-db-'));
    dbPath = path.join(dbDir, 'smith.db');
    await buildErrorFixture({ stateDir });
    await apply(dbPath, SESSION_ID, { stateDir, roadmapPath: path.join(dbDir, 'roadmap.md') });
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('folds repeats but keeps class and severity apart', () => {
    const rows = errorsPage(db).byClass;
    expect(
      rows.map((r) => `${r.errorGroup}.${r.errorClass}|${r.severity}=${r.count}`).sort(),
    ).toEqual([
      'execution.regression|S2-major=1',
      'execution.test-failure|S2-major=2',
      'execution.test-failure|S3-minor=1',
      'judgment.hallucination|S1-stop-the-line=1',
    ]);
  });

  it('gives every row an id that is unique across the result', () => {
    const rows = errorsPage(db).byClass;
    const ids = rows.map((r) => r.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(rows.length);
  });

  it('does not collapse rows that only share an error group', () => {
    // The three `execution.*` rows are what a group-keyed list would merge.
    const execRows = errorsPage(db).byClass.filter((r) => r.errorGroup === 'execution');
    expect(execRows).toHaveLength(3);
    expect(new Set(execRows.map((r) => r.id)).size).toBe(3);
  });
});
