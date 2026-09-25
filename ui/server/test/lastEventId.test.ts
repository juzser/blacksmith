// Differential coverage for finding d50d4c1f: resolveContext()/lessonContext()
// used to call readEvents() (a full log read) on every write that omitted
// causalParent. They now ask one AppOpts.logCache instance instead. This file
// wires task 1's factory (createLogCache) with its counting seam directly
// into AppOpts.logCache and asserts on the seam's own byte counters, so a
// regression back to readEvents() fails by construction: the seam would stay
// at zero.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent, readEvents } from '../../../factory/orchestrator/src/events.js';
import { buildFixture, EPIC_ID, SESSION_ID } from '../../../factory/orchestrator/test/db/fixtures.js';
import type { LogCacheSeam } from '../../../factory/orchestrator/dist/logCache.js';
import { createLogCache } from '../../../factory/orchestrator/dist/logCache.js';
import { closeApp, createApp } from '../src/app.js';

const ROADMAP_MD = `## Phase A
- id: phase-a
- status: in-progress
- epics: [${EPIC_ID}]
`;

const NEWLINE = 0x0a;

/** Byte length of the last complete line of `buf`, terminating `\n` included. */
function lastLineBytes(buf: Buffer): number {
  const prevNL = buf.lastIndexOf(NEWLINE, buf.length - 2);
  return buf.length - (prevNL + 1);
}

describe('ui/server app.ts: writes read the last event id through the cache', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let roadmapPath: string;
  let logPath: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lastid-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-lastid-db-'));
    roadmapPath = path.join(dbDir, 'roadmap.md');
    await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
    await buildFixture({ stateDir });
    dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
    logPath = path.join(stateDir, `${SESSION_ID}.jsonl`);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  /** Raises a fresh `candidate` lesson so it has an approve path left (P9-36). */
  async function seedCandidate(lessonId: string, statement: string): Promise<void> {
    const existing = await readEvents(SESSION_ID, { stateDir });
    const tip = existing[existing.length - 1] as { event_id: string };
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: tip.event_id,
        payload: {
          lesson_id: lessonId,
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          claim_path: '**/pnpm-lock.yaml',
          statement,
          valid_from: '2026-08-01T00:00:00.000Z',
          superseded_by: null,
          provenance_event_ids: [tip.event_id],
        },
      },
      { stateDir },
    );
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
  }

  async function approve(handle: ReturnType<typeof createApp>, lessonId: string): Promise<Response> {
    return handle.app.request(`/api/lessons/${lessonId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
  }

  it('reads the cached tail incrementally and chains causal_parent across two writes', async () => {
    await seedCandidate('lesson-ui-1', 'Approve the first candidate.');
    await seedCandidate('lesson-ui-2', 'Approve the second candidate.');

    const seam: LogCacheSeam = { opens: 0, fstats: 0, bytesRead: 0, readEventsCalls: 0, fullReparses: 0 };
    const logCache = createLogCache(seam);
    const handle = createApp({ dbPath, stateDir, roadmapPath, logCache });
    try {
      const beforeWrite1 = await readFile(logPath);
      const anchorBytes = lastLineBytes(beforeWrite1);
      const parentOfWrite1 = (await readEvents(SESSION_ID, { stateDir })).at(-1)?.event_id;

      const res1 = await approve(handle, 'lesson-ui-1');
      expect(res1.status).toBe(200);
      const eventsAfterWrite1 = await readEvents(SESSION_ID, { stateDir });
      expect(eventsAfterWrite1.at(-1)?.record.causal_parent).toBe(parentOfWrite1);

      const afterWrite1 = await readFile(logPath);
      const appendedByWrite1 = afterWrite1.length - beforeWrite1.length;
      const seamAfterWrite1: LogCacheSeam = { ...seam };
      const parentOfWrite2 = eventsAfterWrite1.at(-1)?.event_id;

      const res2 = await approve(handle, 'lesson-ui-2');
      expect(res2.status).toBe(200);
      const eventsAfterWrite2 = await readEvents(SESSION_ID, { stateDir });
      expect(eventsAfterWrite2.at(-1)?.record.causal_parent).toBe(parentOfWrite2);

      // The regression this guards against: a re-read of the whole log on
      // every write would see zero opens/bytes on this seam by construction,
      // since only the injected cache is wired to it.
      expect(seam.opens - seamAfterWrite1.opens).toBeGreaterThanOrEqual(1);
      expect(seam.bytesRead - seamAfterWrite1.bytesRead).toBe(anchorBytes + appendedByWrite1);
    } finally {
      closeApp(handle);
    }
  });

  it('chains onto an event another process appended between two dashboard writes', async () => {
    await seedCandidate('lesson-ui-1', 'Approve the first candidate.');
    await seedCandidate('lesson-ui-2', 'Approve the second candidate.');

    const logCache = createLogCache();
    const handle = createApp({ dbPath, stateDir, roadmapPath, logCache });
    try {
      expect((await approve(handle, 'lesson-ui-1')).status).toBe(200);

      const priorTip = (await readEvents(SESSION_ID, { stateDir })).at(-1) as { event_id: string };
      const other = await appendEvent(
        {
          session_id: SESSION_ID,
          actor: 'scribe',
          event_type: 'lesson-candidate-raised',
          plan_version: 1,
          causal_parent: priorTip.event_id,
          payload: {
            lesson_id: 'lesson-ui-3',
            lesson_type: 'rule',
            lesson_level: 'principle',
            lesson_status: 'candidate',
            lesson_scope: 'claim-path',
            claim_path: '**/pnpm-lock.yaml',
            statement: 'Appended by another process, not the dashboard.',
            valid_from: '2026-08-01T00:00:00.000Z',
            superseded_by: null,
            provenance_event_ids: [priorTip.event_id],
          },
        },
        { stateDir },
      );
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });

      const res2 = await approve(handle, 'lesson-ui-2');
      expect(res2.status).toBe(200);
      const events = await readEvents(SESSION_ID, { stateDir });
      expect(events.at(-1)?.record.causal_parent).toBe(other.event_id);
    } finally {
      closeApp(handle);
    }
  });

  it('answers a missing session log the same way with the cache injected', async () => {
    const other = 'sess-archived';
    await appendEvent(
      {
        session_id: other,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    await appendEvent(
      {
        session_id: other,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: `${other}#0`,
        payload: {
          lesson_id: 'lesson-archived',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          claim_path: '**/pnpm-lock.yaml',
          statement: 'A lesson whose log is about to vanish.',
          valid_from: '2026-08-01T00:00:00.000Z',
          superseded_by: null,
          provenance_event_ids: [`${other}#0`],
        },
      },
      { stateDir },
    );
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });

    const logCache = createLogCache();
    const handle = createApp({ dbPath, stateDir, roadmapPath, logCache });
    try {
      expect((await handle.app.request('/api/lessons')).status).toBe(200);
      await rm(path.join(stateDir, `${other}.jsonl`), { force: true });

      const res = await handle.app.request('/api/lessons/lesson-archived/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('events.unknown-session');
      expect(body.error.message).toContain(other);
    } finally {
      closeApp(handle);
    }
  });
});
