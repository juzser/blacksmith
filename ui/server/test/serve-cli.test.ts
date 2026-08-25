// `smith ui serve` as the operator actually runs it — the built binary, a
// spawned process, over HTTP. app.test.ts drives createApp() directly and so
// can never see a flag the CLI forgets to forward; this file exists for
// exactly that gap.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { buildFixture, EPIC_ID } from '../../../factory/orchestrator/test/db/fixtures.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
// Not 4680 (the operator's own dashboard) and not 4681 (the e2e server), so a
// `pnpm test:server` while either is up does not fight it for the port.
const PORT = 4683;

// A name no real roadmap.md in this repo has, so "the server answered from
// MY roadmap" cannot be satisfied by black-smith's own factory/specs/roadmap.md.
const MILESTONE = 'Phase Q — served roadmap';
const ROADMAP_MD = `## ${MILESTONE}
- id: phase-q
- status: in-progress
- epics: [${EPIC_ID}]
`;

interface MilestoneRow {
  name: string;
  status: string;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`smith ui serve did not become healthy at ${url} within ${timeoutMs}ms`);
}

describe('smith ui serve (built binary)', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let roadmapPath: string;
  let server: ChildProcess | undefined;
  let stderr: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-serve-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-serve-db-'));
    dbPath = path.join(dbDir, 'smith.db');
    roadmapPath = path.join(dbDir, 'roadmap.md');
    stderr = '';
    await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
    await buildFixture({ stateDir });
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
  });

  afterEach(async () => {
    if (server && !server.killed) server.kill();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  async function serve(extraArgs: string[]): Promise<void> {
    server = spawn(
      process.execPath,
      [
        CLI_PATH,
        'ui',
        'serve',
        '--port',
        String(PORT),
        '--db',
        dbPath,
        '--state-dir',
        stateDir,
        ...extraArgs,
      ],
      { stdio: 'pipe', env: process.env },
    );
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`, 20_000);
  }

  /**
   * The read path re-projects every session on the first request (app.ts's
   * createRefresher), and apply() rebuilds the whole milestones table from a
   * roadmap file while it is there. With no --roadmap-path forwarded, that
   * file defaults to black-smith's own factory/specs/roadmap.md — so serving
   * any other project's db silently replaced its roadmap with this repo's on
   * the first page load. black-smith's own CI found it: two ui/e2e/
   * roadmap.spec.ts assertions failed on a fixture roadmap that the server
   * had overwritten between global-setup and the first fetch.
   */
  it('answers /api/roadmap from --roadmap-path, not from black-smith own roadmap.md', async () => {
    await serve(['--roadmap-path', roadmapPath]);

    const rows = (await (await fetch(`http://127.0.0.1:${PORT}/api/roadmap`)).json()) as
      | MilestoneRow[]
      | { milestones: MilestoneRow[] };
    const milestones = Array.isArray(rows) ? rows : rows.milestones;
    const names = milestones.map((m) => m.name);

    expect(names, `server stderr:\n${stderr}`).toEqual([MILESTONE]);
    expect(milestones[0]?.status).toBe('in-progress');
  }, 60_000); // spawns the built CLI and waits for a real HTTP server
});
