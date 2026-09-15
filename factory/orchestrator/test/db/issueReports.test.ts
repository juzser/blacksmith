// Task 7 (factory-error-log): the `issue-reported` and `error-report-proposed`
// events are durable on the log, but a fact nobody can read is not a fact —
// this file pins that both reach the timeline, that `issue-reported` is
// projected into a queryable `issue_reports` table, and that the roadmap's
// `error_issues` switch reaches roadmapPage(). AC1 is a regression pin (the
// type is already on the timeline via the taxonomy's gate_event dimension);
// AC2-AC6 are fail-first against the null at f97486a.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb, rebuild } from '../../src/db/projector.js';
import { roadmapPage, timeline } from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, type EventOpts } from '../../src/events.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SESSION_ID = 'sess-issue-reports';
const EPIC_ID = 'epic-x';
const TASK_ID = `${EPIC_ID}/task-1`;

async function seedSession(opts: EventOpts): Promise<string> {
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
  return root.event_id;
}

describe('issue-reported / error-report-proposed reach the timeline and the read model', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-issue-reports-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-issue-reports-db-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  // AC1: regression pin. `issue-reported` is registered as a `gate_event`
  // taxonomy value (task 4), and timelineEventTypes() spreads that dimension
  // in, so this passes at its first run — never added to
  // FREE_TIMELINE_EVENT_TYPES, which would double-list it.
  it('shows an issue-reported event on its epic timeline (regression pin, passes under the null)', async () => {
    const parent = await seedSession({ stateDir });
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'issue-reported',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: {
          outcome: 'opened',
          fingerprint: 'fp-ac1',
          source: 'error-logged',
          error_class: 'execution.test-failure',
          task_ref: TASK_ID,
          latest_event_id: parent,
          repo_slug: 'proj-a/repo',
          issue_url: 'https://example.com/issues/1',
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID });
    handle.sqlite.close();

    const issueRows = rows.filter((r) => r.eventType === 'issue-reported');
    expect(issueRows).toHaveLength(1);
  });

  // AC2: the real differential. Under the null, error-report-proposed is not
  // in FREE_TIMELINE_EVENT_TYPES and not a taxonomy value, so timeline()
  // returns zero rows; after F1 it returns one.
  it('shows an error-report-proposed event on its epic timeline (0 under the null, 1 after)', async () => {
    const parent = await seedSession({ stateDir });
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'error-report-proposed',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: {
          fingerprint: 'fp-ac2',
          project: 'proj-a',
          source: 'error-logged',
          errorClass: 'execution.test-failure',
          taskRef: TASK_ID,
          sessionId: SESSION_ID,
          latestEventId: parent,
          occurrences: 3,
          confidence: 0.9,
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = timeline(handle.db, { sessionId: SESSION_ID, epicId: EPIC_ID });
    handle.sqlite.close();

    const proposedRows = rows.filter((r) => r.eventType === 'error-report-proposed');
    expect(proposedRows).toHaveLength(1);
  });

  // AC3: the storage. Against the shipped migrations (opts.migrationsDir
  // unset — DB_MIGRATIONS_DIR), issue_reports is queryable. Against the
  // pre-change migrations (a copy of drizzle/ at f97486a, before this task's
  // migration), the same query fails with SQLite's "no such table".
  it('is queryable against the shipped migrations, and fails "no such table" against the pre-change set', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.issue_reports).all();
    handle.sqlite.close();
    expect(rows).toEqual([]);

    const preChangeDir = await mkdtemp(path.join(tmpdir(), 'smith-issue-reports-premigrations-'));
    try {
      // git archive writes a tar stream; unpack it directly into preChangeDir.
      const tar = execFileSync('git', ['archive', 'f97486a', 'factory/orchestrator/drizzle'], {
        cwd: REPO_ROOT,
      });
      execFileSync('tar', ['-x', '-C', preChangeDir], { input: tar });

      const preDbPath = path.join(dbDir, 'pre-change.db');
      const preMigrationsDir = path.join(preChangeDir, 'factory/orchestrator/drizzle');
      const preHandle = openDb(preDbPath, { migrationsDir: preMigrationsDir });
      let thrown: unknown;
      try {
        preHandle.db.select().from(schema.issue_reports).all();
      } catch (err) {
        thrown = err;
      } finally {
        preHandle.sqlite.close();
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('no such table: issue_reports');
    } finally {
      await rm(preChangeDir, { recursive: true, force: true });
    }
  });

  it('records exactly one new journal entry, tagged with the new migration file', async () => {
    const journalPath = path.join(REPO_ROOT, 'factory/orchestrator/drizzle/meta/_journal.json');
    const { readFile, readdir } = await import('node:fs/promises');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.length).toBe(12);
    const last = journal.entries[journal.entries.length - 1];
    expect(last?.idx).toBe(11);

    const files = await readdir(path.join(REPO_ROOT, 'factory/orchestrator/drizzle'));
    const newSql = files.find((f) => f.startsWith('0011_') && f.endsWith('.sql'));
    expect(newSql).toBeDefined();
    expect(last?.tag).toBe(newSql?.replace(/\.sql$/, ''));
  });

  // AC4: the projected row carries outcome and fingerprint, not nulls.
  it('projects issue-reported with its outcome and fingerprint readable', async () => {
    const parent = await seedSession({ stateDir });
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'issue-reported',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: {
          outcome: 'opened',
          fingerprint: 'fp-ac4',
          source: 'error-logged',
          error_class: 'execution.test-failure',
          task_ref: TASK_ID,
          latest_event_id: parent,
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.issue_reports).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('opened');
    expect(rows[0]?.fingerprint).toBe('fp-ac4');
  });

  // Re-projection: apply()/rebuild() re-derive a session's rows from
  // scratch every time (clearSession()/clearAll() then re-insert), so a
  // second pass over the same session must not throw a UNIQUE constraint
  // violation on issue_reports.event_id.
  it('projects the same session twice without a duplicate issue_reports row (re-projection is idempotent)', async () => {
    const parent = await seedSession({ stateDir });
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'issue-reported',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: {
          outcome: 'opened',
          fingerprint: 'fp-reproject',
          source: 'error-logged',
          error_class: 'execution.test-failure',
          task_ref: TASK_ID,
          latest_event_id: parent,
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await apply(dbPath, SESSION_ID, { stateDir });
    await apply(dbPath, SESSION_ID, { stateDir });
    await rebuild(dbPath, 'all', { stateDir });

    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.issue_reports).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(1);
  });

  describe('the error_issues switch reaches roadmapPage()', () => {
    const ROADMAP_MD = `# Roadmap

## Phase A — Tracker off
- id: phase-a
- status: in-progress
- epics: []
- project: proj-off
- error_issues: off

## Phase B — Tracker on
- id: phase-b
- status: planned
- epics: []
- project: proj-on
`;

    it('roadmapPage() reports the off project as not writable, the other as writable (one assertion, both facts)', async () => {
      const roadmapPath = path.join(dbDir, 'roadmap.md');
      await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
      await seedSession({ stateDir });

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handle = openDb(dbPath);
      const rows = roadmapPage(handle.db);
      handle.sqlite.close();

      expect(
        rows
          .filter((r) => r.milestoneId === 'phase-a' || r.milestoneId === 'phase-b')
          .sort((a, b) => a.milestoneId.localeCompare(b.milestoneId))
          .map((r) => [r.project, r.errorIssuesEnabled]),
      ).toEqual([
        ['proj-off', false],
        ['proj-on', true],
      ]);
    });

    it('leaves milestones unchanged and logs to stderr when error_issues is invalid, never defaulting', async () => {
      const roadmapPath = path.join(dbDir, 'roadmap.md');
      await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
      await seedSession({ stateDir });

      const dbPath = path.join(dbDir, 'smith.db');
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
      const handleBefore = openDb(dbPath);
      const before = handleBefore.db.select().from(schema.milestones).all();
      handleBefore.sqlite.close();

      const badRoadmapPath = path.join(dbDir, 'bad-roadmap.md');
      await writeFile(
        badRoadmapPath,
        `## Phase A\n- id: phase-a\n- status: planned\n- error_issues: maybe\n`,
        'utf8',
      );

      const calls: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        calls.push(args);
      };
      try {
        await apply(dbPath, SESSION_ID, { stateDir, roadmapPath: badRoadmapPath });
      } finally {
        console.error = originalConsoleError;
      }

      const handleAfter = openDb(dbPath);
      const after = handleAfter.db.select().from(schema.milestones).all();
      handleAfter.sqlite.close();

      expect(after).toEqual(before);
      expect(before.length).toBeGreaterThan(0);
      const messages = calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('phase-a'))).toBe(true);
    });
  });
});
