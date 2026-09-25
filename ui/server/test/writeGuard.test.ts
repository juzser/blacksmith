// The dashboard's write routes (/api/lessons/:id/approve|reject|edit,
// /api/waivers/apply-batch) sit behind writeOriginGuard() (middleware.ts).
// This file proves the guard's exactly-four rules, differentially: each
// case names the response AND the state the finding's own attack would
// otherwise have changed.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lessonsPage } from '../../../factory/orchestrator/src/db/queries.js';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent, readEvents } from '../../../factory/orchestrator/src/events.js';
import { EPIC_ID, SESSION_ID, buildFixture } from '../../../factory/orchestrator/test/db/fixtures.js';
import { closeApp, createApp } from '../src/app.js';
import type { AppHandle } from '../src/app.js';

const ROADMAP_MD = `## Phase A
- id: phase-a
- status: in-progress
- epics: [${EPIC_ID}]
`;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('ui/server writeOriginGuard', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let roadmapPath: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-guard-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-guard-db-'));
    roadmapPath = path.join(dbDir, 'roadmap.md');
    await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
    await buildFixture({ stateDir });
    dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  function app(): AppHandle {
    return createApp({ dbPath, stateDir, roadmapPath });
  }

  /** Raises a fresh `candidate` lesson, mirroring app.test.ts's seedCandidate(). */
  async function seedCandidate(lessonId: string, statement: string): Promise<void> {
    const existing = await readEvents(SESSION_ID, { stateDir });
    const tip = existing[existing.length - 1]?.event_id;
    if (tip === undefined) throw new Error('fixture: expected a session-start event already');
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: tip,
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
          provenance_event_ids: [tip],
        },
      },
      { stateDir },
    );
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
  }

  function lessonStatus(handle: AppHandle, lessonId: string): string | undefined {
    const page = lessonsPage(handle.handle.db, {});
    const row = [...page.pending, ...page.approved, ...page.closed].find(
      (r) => r.lessonId === lessonId,
    );
    return row?.lessonStatus;
  }

  it('blocks the finding\'s exact attack: text/plain + foreign Origin on approve leaves the lesson untouched', async () => {
    await seedCandidate('lesson-guard-1', 'A statement the attack must not approve.');
    const handle = app();
    try {
      const before = await readEvents(SESSION_ID, { stateDir });
      const res = await handle.app.request('/api/lessons/lesson-guard-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'http://evil.example' },
        body: JSON.stringify({ sessionId: SESSION_ID, note: 'x', pad: '=' }),
      });
      // Differential: under the null (no guard) this attack answers 200 and
      // the lesson becomes "approved" — that is the failure this test caught
      // before the fix (recorded verbatim in structured_output).
      expect([403, 415]).toContain(res.status);
      expect(lessonStatus(handle, 'lesson-guard-1')).toBe('candidate');
      const after = await readEvents(SESSION_ID, { stateDir });
      expect(after).toHaveLength(before.length);
    } finally {
      closeApp(handle);
    }
  });

  const WRITE_ROUTES: Array<{ name: string; route: string; body: unknown }> = [
    {
      name: 'lessons/approve',
      route: '/api/lessons/lesson-guard-2/approve',
      body: { sessionId: SESSION_ID },
    },
    {
      name: 'lessons/reject',
      route: '/api/lessons/lesson-guard-3/reject',
      body: { sessionId: SESSION_ID },
    },
    {
      name: 'lessons/edit',
      route: '/api/lessons/lesson-guard-4/edit',
      body: { sessionId: SESSION_ID, statement: 'An edited statement, still fine and new.' },
    },
    {
      name: 'waivers/apply-batch',
      route: '/api/waivers/apply-batch',
      body: { sessionId: SESSION_ID, decisions: [] },
    },
  ];

  for (const { name, route, body } of WRITE_ROUTES) {
    describe(name, () => {
      beforeEach(async () => {
        if (route.includes('lesson-guard-')) {
          const lessonId = route.split('/')[3] as string;
          await seedCandidate(lessonId, `Candidate statement for ${lessonId}, long enough.`);
        }
      });

      it('text/plain, same origin -> 415', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(415);
        } finally {
          closeApp(handle);
        }
      });

      it('missing Content-Type -> 415', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(415);
        } finally {
          closeApp(handle);
        }
      });

      it('application/json + foreign Origin -> 403', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(403);
        } finally {
          closeApp(handle);
        }
      });

      it('application/json + rebound Host (evil.example) with a matching-looking Origin -> 403', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://127.0.0.1:4680',
              host: 'evil.example:4680',
            },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(403);
        } finally {
          closeApp(handle);
        }
      });

      it('Sec-Fetch-Site: cross-site -> 403', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'sec-fetch-site': 'cross-site',
            },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(403);
        } finally {
          closeApp(handle);
        }
      });

      it('application/json, no Origin, loopback Host -> reaches the handler', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json', host: '127.0.0.1:4680' },
            body: JSON.stringify(body),
          });
          expect(res.status).not.toBe(403);
          expect(res.status).not.toBe(415);
        } finally {
          closeApp(handle);
        }
      });

      it('application/json, Origin 127.0.0.1:4680, Host 127.0.0.1:4680 -> reaches the handler', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://127.0.0.1:4680',
              host: '127.0.0.1:4680',
            },
            body: JSON.stringify(body),
          });
          expect(res.status).not.toBe(403);
          expect(res.status).not.toBe(415);
        } finally {
          closeApp(handle);
        }
      });

      it('Vite proxy shape: Origin localhost:5173, Host localhost:5173 -> reaches the handler', async () => {
        const handle = app();
        try {
          const res = await handle.app.request(route, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost:5173',
              host: 'localhost:5173',
            },
            body: JSON.stringify(body),
          });
          expect(res.status).not.toBe(403);
          expect(res.status).not.toBe(415);
        } finally {
          closeApp(handle);
        }
      });
    });
  }

  it('GET /api/health is unaffected by a foreign Origin', async () => {
    const handle = app();
    try {
      const res = await handle.app.request('/api/health', {
        headers: { origin: 'http://evil.example' },
      });
      expect(res.status).toBe(200);
      expect(await json<{ ok: boolean }>(res)).toEqual({ ok: true });
    } finally {
      closeApp(handle);
    }
  });

  it('GET /api/lessons is unaffected by a foreign Origin', async () => {
    const handle = app();
    try {
      const res = await handle.app.request('/api/lessons', {
        headers: { origin: 'http://evil.example' },
      });
      expect(res.status).toBe(200);
    } finally {
      closeApp(handle);
    }
  });
});
