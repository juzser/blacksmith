// The dashboard only reads. Every operator decision goes through the CLI
// (`/bs waivers`, `/bs lessons`), so the server has no write route left, and
// readOnlyGuard() (middleware.ts) answers 405 to any `/api` request whose
// method is not GET or HEAD -- including the paths that used to write.
//
// The loopback cases at the bottom moved here from the old write-guard test:
// loopbackGuard() still reads the same Host parsing, now on reads only.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { readEvents } from '../../../factory/orchestrator/src/events.js';
import {
  buildFixture,
  EPIC_ID,
  SESSION_ID,
} from '../../../factory/orchestrator/test/db/fixtures.js';
import type { AppHandle } from '../src/app.js';
import { closeApp, createApp } from '../src/app.js';

const ROADMAP_MD = `## Phase A
- id: phase-a
- status: in-progress
- epics: [${EPIC_ID}]
`;

describe('ui/server is read-only', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let roadmapPath: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-readonly-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-readonly-db-'));
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

  async function withApp<T>(fn: (handle: AppHandle) => T | Promise<T>): Promise<T> {
    const handle = createApp({ dbPath, stateDir, roadmapPath });
    try {
      return await fn(handle);
    } finally {
      closeApp(handle);
    }
  }

  const FORMER_WRITES = [
    '/api/waivers/apply-batch',
    '/api/lessons/lesson-1/approve',
    '/api/lessons/lesson-1/reject',
    '/api/lessons/lesson-1/edit',
  ];

  for (const route of FORMER_WRITES) {
    it(`POST ${route} -> 405 and the log is untouched`, async () => {
      const before = (await readEvents(SESSION_ID, { stateDir })).length;
      const res = await withApp((handle) =>
        handle.app.request(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: SESSION_ID, decisions: [], statement: 'x' }),
        }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
      expect(await res.json()).toEqual({
        error: {
          code: 'ui.method-not-allowed',
          message: expect.stringContaining('/bs waivers'),
        },
      });
      expect((await readEvents(SESSION_ID, { stateDir })).length).toBe(before);
    });
  }

  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    it(`${method} on a read route -> 405`, async () => {
      const res = await withApp((handle) => handle.app.request('/api/overview', { method }));
      expect(res.status).toBe(405);
    });
  }

  it('POST /api/health -> 405, though health answers ahead of the refresh', async () => {
    const res = await withApp((handle) => handle.app.request('/api/health', { method: 'POST' }));
    expect(res.status).toBe(405);
  });

  it('GET and HEAD still answer', async () => {
    await withApp(async (handle) => {
      expect((await handle.app.request('/api/overview')).status).toBe(200);
      expect((await handle.app.request('/api/health', { method: 'HEAD' })).status).toBe(200);
    });
  });

  describe('the request checks cover the whole /api prefix', () => {
    const readPaths = (handle: AppHandle): string[] => {
      const paths = handle.app.routes
        .filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !r.path.includes('*'))
        .map((r) => r.path.replace(/:[^/]+/g, 'epic-a'));
      return [...new Set(paths)];
    };

    it('every GET route under /api refuses a non-loopback request host', async () => {
      await withApp(async (handle) => {
        const paths = readPaths(handle);
        expect(paths).toEqual(
          expect.arrayContaining(['/api/timeline', '/api/stream', '/api/health']),
        );
        const unguarded: string[] = [];
        for (const p of paths) {
          const res = await handle.app.request(p, { headers: { host: 'other.example' } });
          await res.body?.cancel();
          if (res.status !== 403) unguarded.push(`${p} -> ${res.status}`);
        }
        expect(unguarded).toEqual([]);
      });
    });

    it('a loopback request host still reaches /api/health and /api/timeline', async () => {
      await withApp(async (handle) => {
        for (const p of ['/api/health', '/api/timeline']) {
          const res = await handle.app.request(p, { headers: { host: '127.0.0.1:4680' } });
          await res.body?.cancel();
          expect(res.status).not.toBe(403);
        }
      });
    });
  });

  describe('loopbackGuard on a read route', () => {
    const allowed = ['127.0.0.1:4680', 'localhost:5173', '[::1]:4680', '[::1]'];
    const refused = [
      'evil.example',
      '[::2]:4680',
      '[::ffff:127.0.0.1]:4680',
      '[::1].evil.example:4680',
      '::1:4680',
    ];

    for (const host of allowed) {
      it(`Host ${host} -> 200`, async () => {
        const res = await withApp((handle) =>
          handle.app.request('/api/overview', { headers: { host } }),
        );
        expect(res.status).toBe(200);
      });
    }

    for (const host of refused) {
      it(`Host ${host} -> 403`, async () => {
        const res = await withApp((handle) =>
          handle.app.request('/api/overview', { headers: { host } }),
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: { code: 'ui.forbidden-host' } });
      });
    }
  });
});
