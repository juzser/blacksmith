// Task 7 (factory-error-log): the `issue-reported` and `error-report-proposed`
// events are durable on the log, but a fact nobody can read is not a fact —
// this file pins that both reach the timeline, that `issue-reported` is
// projected into a queryable `issue_reports` table, and that the roadmap's
// `error_issues` switch reaches roadmapPage(). AC1 is a regression pin (the
// type is already on the timeline via the taxonomy's gate_event dimension);
// AC2-AC6 were written fail-first against the migration set that predates
// this task.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb, rebuild } from '../../src/db/projector.js';
import { roadmapPage, timeline } from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, type EventOpts } from '../../src/events.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DRIZZLE_DIR = path.join(REPO_ROOT, 'factory/orchestrator/drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

async function journalEntries(): Promise<JournalEntry[]> {
  const raw = await readFile(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

// Which migration creates issue_reports is a fact the shipped SQL already
// states, so read it rather than remember it. A remembered index is correct
// only until the next migration lands, and then it is wrong in the quiet
// direction: the count it anchors goes red saying `expected 14 to be 13`,
// which names neither this table nor the migration that actually arrived,
// and the cheapest way back to green re-points the check at whatever landed
// last -- leaving a test about nothing under a name about issue_reports.
async function migrationsCreatingIssueReports(entries: JournalEntry[]): Promise<JournalEntry[]> {
  const creators: JournalEntry[] = [];
  for (const entry of entries) {
    const sql = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), 'utf8');
    if (/create table\s+`issue_reports`/i.test(sql)) creators.push(entry);
  }
  return creators;
}
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
  // pre-change migrations (the shipped drizzle/ with this task's migration
  // withheld), the same query fails with SQLite's "no such table".
  it('is queryable against the shipped migrations, and fails "no such table" against the pre-change set', async () => {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.issue_reports).all();
    handle.sqlite.close();
    expect(rows).toEqual([]);

    // Build the pre-change set from the working tree, never from a git
    // revision: the commit this task branched from is not an ancestor of main,
    // and CI clones one commit deep, so `git archive <sha>` there dies with
    // "not a valid object name" and takes the whole gate with it.
    const preChangeDir = await mkdtemp(path.join(tmpdir(), 'smith-issue-reports-premigrations-'));
    try {
      const shippedDir = DRIZZLE_DIR;
      const preMigrationsDir = path.join(preChangeDir, 'drizzle');
      await mkdir(path.join(preMigrationsDir, 'meta'), { recursive: true });
      const shipped = JSON.parse(
        await readFile(path.join(shippedDir, 'meta/_journal.json'), 'utf8'),
      ) as { entries: JournalEntry[] };
      const [creator] = await migrationsCreatingIssueReports(shipped.entries);
      if (!creator) throw new Error('no shipped migration creates issue_reports');
      const kept = shipped.entries.filter((e) => e.idx < creator.idx);
      expect(kept).toHaveLength(creator.idx);
      await writeFile(
        path.join(preMigrationsDir, 'meta/_journal.json'),
        JSON.stringify({ ...shipped, entries: kept }),
      );
      for (const entry of kept) {
        await copyFile(
          path.join(shippedDir, `${entry.tag}.sql`),
          path.join(preMigrationsDir, `${entry.tag}.sql`),
        );
      }

      const preDbPath = path.join(dbDir, 'pre-change.db');
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

  // AC5: the journal and the directory agree, and exactly one migration
  // created this table. Both halves are asserted over the whole shipped set
  // and never over its last entry, so a later migration belonging to some
  // other task neither turns this red nor quietly becomes its subject.
  it('the journal matches the directory, and exactly one migration creates issue_reports', async () => {
    const entries = await journalEntries();

    // First, because it is the cheap structural fact the rest stands on:
    // reading a .sql the journal names is only safe once the journal is known
    // to name real files. drizzle-kit writes the two together and nothing else
    // in the repo reads the journal at all, so a hand-edited entry or a
    // dropped file has no way to surface here -- it waits to be found by a
    // migration that fails on someone else's machine.
    const files = (await readdir(DRIZZLE_DIR)).filter((f) => f.endsWith('.sql'));
    expect(files.sort()).toEqual(entries.map((e) => `${e.tag}.sql`).sort());

    // Listed rather than counted: `toHaveLength(1)` prints `[ ...(2) ]` and
    // leaves the reader to go find which two.
    const creators = (await migrationsCreatingIssueReports(entries)).map((e) => e.tag);
    expect(
      creators.length === 1
        ? []
        : [`migrations creating issue_reports: ${creators.join(', ') || '(none)'}`],
    ).toEqual([]);

    // The pre-change set above keeps every entry below the creator's idx and
    // expects exactly that many, which is only true while idx is the position.
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
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
