// Task 7 (factory-error-log) — tester pass. The coder's issueReports.test.ts
// pins that issue-reported reaches the timeline and the read model with its
// outcome/fingerprint readable; these `it`s pin the projector's edges the
// coder's suite did not: missing required payload keys, envelope fallbacks,
// column defaults, PK-per-event-id (no dedup), secret/extra-key exclusion,
// and the roadmap's error_issues default. Each is a regression pin against
// the projector on this branch.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb, rebuild } from '../../src/db/projector.js';
import { roadmapPage } from '../../src/db/queries.js';
import * as schema from '../../src/db/schema.js';
import { appendEvent, type EventOpts } from '../../src/events.js';

const SESSION_ID = 'sess-issue-reports-edges';
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

describe('issue-reported projection edges (tester pass)', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-issue-edges-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-issue-edges-db-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('skips an issue-reported event whose payload lacks fingerprint or outcome', async () => {
    const parent = await seedSession({ stateDir });
    // Missing fingerprint.
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'issue-reported',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: { outcome: 'opened' },
      },
      { stateDir },
    );
    // Missing outcome.
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'issue-reported',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: { fingerprint: 'fp-missing-outcome' },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await expect(rebuild(dbPath, 'all', { stateDir })).resolves.not.toThrow();
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.issue_reports).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(0);
  });

  it('falls back taskRef to the envelope task_id and keeps the envelope project', async () => {
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
          fingerprint: 'fp-envelope-fallback',
          // No task_ref in the payload.
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
    expect(rows[0]?.taskRef).toBe(TASK_ID);
    expect(rows[0]?.project).toBe('proj-a');
  });

  it('defaults reason/issueUrl/repoSlug to null and errorClass/latestEventId/source to empty string', async () => {
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
          fingerprint: 'fp-minimal-payload',
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
    const row = rows[0];
    expect(row?.reason).toBeNull();
    expect(row?.issueUrl).toBeNull();
    expect(row?.repoSlug).toBeNull();
    expect(row?.errorClass).toBe('');
    expect(row?.latestEventId).toBe('');
    expect(row?.source).toBe('');
  });

  it('inserts two rows for two issue-reported events sharing a fingerprint (no dedup)', async () => {
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
        payload: { outcome: 'opened', fingerprint: 'fp-shared-dup' },
      },
      { stateDir },
    );
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'issue-reported',
        task_id: TASK_ID,
        plan_version: 1,
        causal_parent: parent,
        project: 'proj-a',
        payload: { outcome: 'updated', fingerprint: 'fp-shared-dup' },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const rows = handle.db.select().from(schema.issue_reports).all();
    handle.sqlite.close();

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(2);
    expect(rows.every((r) => r.fingerprint === 'fp-shared-dup')).toBe(true);
  });

  it('stores exactly the schema columns: no extra key or secret-shaped value reaches the row', async () => {
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
          fingerprint: 'fp-extra-keys',
          detail: 'stack trace with sensitive-looking content',
          gh_token: 'ghp_notasecret',
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
    const row = rows[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      [
        'eventId',
        'sessionId',
        'ts',
        'taskRef',
        'errorClass',
        'fingerprint',
        'issueUrl',
        'latestEventId',
        'outcome',
        'reason',
        'repoSlug',
        'source',
        'project',
      ].sort(),
    );
    const values = Object.values(row).map((v) => String(v));
    expect(values.some((v) => v.includes('stack trace'))).toBe(false);
    expect(values.some((v) => v.includes('ghp_notasecret'))).toBe(false);
  });

  it('roadmapPage() reports errorIssuesEnabled: true for a milestone without the bullet', async () => {
    const ROADMAP_MD = `# Roadmap

## Phase C — No error_issues bullet
- id: phase-c
- status: planned
- epics: []
- project: proj-c
`;
    const roadmapPath = path.join(dbDir, 'roadmap-no-bullet.md');
    await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
    await seedSession({ stateDir });

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
    const handle = openDb(dbPath);
    const rows = roadmapPage(handle.db);
    handle.sqlite.close();

    const phaseC = rows.find((r) => r.milestoneId === 'phase-c');
    expect(phaseC?.errorIssuesEnabled).toBe(true);
  });
});
