// `smith ui serve` as the operator actually runs it — the built binary, a
// spawned process, over HTTP. app.test.ts drives createApp() directly and so
// can never see a flag the CLI forgets to forward; this file exists for
// exactly that gap.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

  async function serve(extraArgs: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
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
        // No registry: never discover the host's live sessions' stores.
        '--claude-config-dir',
        path.join(dbDir, 'no-claude'),
        ...extraArgs,
      ],
      { stdio: 'pipe', env: { ...process.env, ...env } },
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

  /**
   * ui/e2e pins the browser clock to one fixture instant and, since the server
   * decides working-vs-stalled itself, passes the same instant as --now-iso.
   * app.test.ts proves AppOpts.nowIso moves that line; this proves the flag
   * reaches it through the CLI. The fixture's dispatches are stamped at the
   * wall clock, so a pin five hours ahead is the one instant at which every
   * live agent is past DEFAULT_STALE_HOURS: unpinned, the same db reports them
   * all working, so a dropped flag cannot pass by accident.
   */
  it('forwards --now-iso, so the served working/stalled split is read at the pinned instant', async () => {
    const fiveHoursAhead = new Date(Date.now() + 5 * 3.6e6).toISOString();
    await serve(['--now-iso', fiveHoursAhead]);

    const overview = (await (await fetch(`http://127.0.0.1:${PORT}/api/overview`)).json()) as {
      liveAgentCount: number;
      workingAgentCount: number;
      stalledAgentCount: number;
    };

    expect(overview, `server stderr:\n${stderr}`).toMatchObject({
      liveAgentCount: 2,
      workingAgentCount: 0,
      stalledAgentCount: 2,
    });
  }, 60_000); // spawns the built CLI and waits for a real HTTP server

  /**
   * app.test.ts hands createApp a claudeConfigDir directly and so cannot see
   * the flag being dropped between the CLI and the server. A session file in
   * a temp config dir, answered by the spawned binary, proves it travels. The
   * pid is this runner's own, so it is alive for the whole test.
   *
   * The session's cwd is a temp work root, not REPO_ROOT. A live session's
   * cwd is where the server looks for other stores, and in a linked worktree
   * REPO_ROOT's `.git` file leads to the main clone: its real state/events was
   * found as a foreign store and folded on the first /api/* request, so this
   * test read the developer's own store and its time grew with that store
   * until it passed 60 s. The temp dir's own `.git` stops the walk there and
   * it holds no state/events. BS_HOME makes it the CLI's work root, which
   * `ui serve` passes as a known root, so the cwd is still in scope by cwd.
   */
  it('forwards --claude-config-dir, so /api/cli-sessions reads that directory', async () => {
    const configDir = path.join(dbDir, 'claude');
    const workRoot = path.join(dbDir, 'work');
    await mkdir(path.join(workRoot, '.git'), { recursive: true });
    await mkdir(path.join(configDir, 'sessions'), { recursive: true });
    await writeFile(
      path.join(configDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: '77777777-7777-4777-8777-777777777777',
        cwd: workRoot,
        kind: 'interactive',
        status: 'busy',
        name: 'served-fixture',
        version: '2.1.290',
        startedAt: 1_790_000_000_000,
        statusUpdatedAt: 1_790_000_100_000,
      }),
    );
    await serve(['--claude-config-dir', configDir], { BS_HOME: workRoot });

    const body = (await (await fetch(`http://127.0.0.1:${PORT}/api/cli-sessions`)).json()) as {
      state: string;
      configSource: string;
      sessions: { name: string; status: string; inScopeBy: string }[];
    };

    expect(body, `server stderr:\n${stderr}`).toMatchObject({ state: 'ok', configSource: 'flag' });
    expect(body.sessions).toEqual([
      expect.objectContaining({ name: 'served-fixture', status: 'working', inScopeBy: 'cwd' }),
    ]);

    // No foreign store. /api/projects rows come from overview(), so a foreign
    // store with no epics adds none: that check alone cannot see one. Discovery
    // itself leaves a mark: the registry opens `<db dir>/ui-stores/<id>.db` for
    // every foreign store it finds, epics or not, and never for the home store.
    // So that directory must hold no db file. Ids only, so a failure never
    // prints a real project's name.
    const projects = (await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as {
      store: { id: string };
    }[];
    expect([...new Set(projects.map((p) => p.store.id))]).toEqual(['home']);
    const cached = await readdir(path.join(dbDir, 'ui-stores')).catch(() => [] as string[]);
    expect(cached.filter((n) => n.endsWith('.db')).map((n) => n.slice(0, 8))).toEqual([]);
  }, 60_000); // spawns the built CLI and waits for a real HTTP server
});
