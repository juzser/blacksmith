// Seeds a scratch db from the test fixture (buildFixture + rebuild — the
// same fixture factory/orchestrator's own db tests use), then starts
// `smith ui serve` against it. Playwright's globalSetup/globalTeardown pair.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFixtureClock } from './fixtureClock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const PORT = 4681;

/** Run a build to completion, or fail with whatever it printed. */
function runBuild(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: 'pipe' });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      // tsc prints type errors on stdout and exits non-zero. There is nothing
      // to test in a tree that does not compile, so its output is the message.
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}\n${output}`));
    });
  });
}

/**
 * Rebuild the three artifacts this suite serves, in dependency order.
 *
 * None of them is produced by the server that hands them out: the cli entry
 * (`factory/orchestrator/dist/cli.js`), the api server it imports at runtime
 * (`ui/server/dist/index.js`), and the front-end bundle (`ui/dist`) are all
 * read off disk as they are. `pnpm test:e2e` builds them first; `playwright
 * test` started any other way — a filtered run, `--ui` mode, an editor's run
 * button — does not, and artifacts left over from an older checkout answer
 * every request without saying so. That fails loudly when what is stale
 * predates a feature under test, and passes quietly when it predates a
 * regression, which is the direction that matters: a green suite would then
 * be a statement about a tree nobody has anymore.
 *
 * Under a second in total, and it makes every way of starting the suite mean
 * the same thing. `test:e2e` keeps its own build steps — they say out loud
 * what the entry point does — but nothing here depends on them having run.
 */
async function buildServedArtifacts(): Promise<void> {
  const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  // Ordered, not parallel: ui/server compiles against the orchestrator's built
  // dist/, not its src/ (see ui/server/src/app.ts's header comment).
  await runBuild([tsc, '-p', path.join(REPO_ROOT, 'tsconfig.json')], 'tsc -p tsconfig.json');
  await runBuild(
    [tsc, '-p', path.join(REPO_ROOT, 'ui', 'server', 'tsconfig.json')],
    'tsc -p ui/server/tsconfig.json',
  );
  // Vite's own api rather than a fourth subprocess: the config sets an
  // absolute root and outDir, so it lands in ui/dist from any cwd.
  const { build } = await import('vite');
  await build({ configFile: path.join(REPO_ROOT, 'ui', 'vite.config.ts'), logLevel: 'warn' });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`smith ui serve did not become healthy at ${url} within ${timeoutMs}ms`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { buildFixture, EPIC_ID } = await import(
    path.join(REPO_ROOT, 'factory', 'orchestrator', 'test', 'db', 'fixtures.ts')
  );
  const { buildMultiProjectFixture, DEMO_HUB_EPIC_A, DEMO_HUB_EPIC_B, DEMO_HUB_PROJECT } =
    await import(path.join(here, 'multiProjectFixture.ts'));
  const { rebuild } = await import(
    path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'db', 'projector.ts')
  );

  await buildServedArtifacts();

  const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-e2e-events-'));
  const dbDir = await mkdtemp(path.join(tmpdir(), 'smith-e2e-db-'));
  const dbPath = path.join(dbDir, 'smith.db');
  const roadmapPath = path.join(dbDir, 'roadmap.md');

  // Phase 6b: 2 projects x 2 epics — "black-smith" (default, single epic,
  // fixtures.ts's existing single-project fixture) + "demo-hub" (2 epics,
  // parallel waves, live agents, done+next tasks — multiProjectFixture.ts)
  // — dense enough for Roadmap/Flow/Projects screenshots to render
  // meaningfully.
  //
  // Plus a third phase that declares a project and nothing else: no epics, no
  // tasks, no events anywhere in the fixture logs. black-smith's own roadmap
  // has phases in exactly that state (an `envkit` milestone with `epics: []`),
  // and it is the state a project spends between "added to the roadmap" and
  // "first task planned". overview().projects used to be derived from the
  // tasks table alone, so a project there was absent from the Projects hub and
  // from the topbar switcher — unreachable until some task happened to carry
  // its id.
  await writeFile(
    roadmapPath,
    `## Phase 6a — Dashboard foundation\n- id: phase-6a\n- status: in-progress\n- epics: [${EPIC_ID}]\n- project: black-smith\n- goal: Overview, Timeline, Kanban.\n\n## Phase 6b — Remaining pages\n- id: phase-6b\n- status: in-progress\n- epics: [${DEMO_HUB_EPIC_A}, ${DEMO_HUB_EPIC_B}]\n- project: ${DEMO_HUB_PROJECT}\n- goal: Roadmap, Flow, Task detail, Lessons, Errors, Analytics, Projects hub.\n\n## Phase 7 — envkit bootstrap\n- id: phase-7\n- status: planned\n- epics: []\n- project: envkit\n- goal: Declared on the roadmap; not one task planned against it yet.\n`,
    'utf8',
  );

  await buildFixture({ stateDir });
  await buildMultiProjectFixture({ stateDir });
  // Between writing the logs and projecting them: the builders go through the
  // real event writer, which stamps the wall clock, so without this every run
  // seeds a different timeline and re-writes most of the committed screenshot
  // corpus (D-235). See fixtureClock.ts.
  await normalizeFixtureClock(stateDir);
  await rebuild(dbPath, 'all', { stateDir, roadmapPath });

  const cliPath = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
  const serverProcess: ChildProcess = spawn(
    process.execPath,
    // --roadmap-path is not optional here: the server re-projects every
    // session on the first request, and that rebuilds the milestones table
    // from whatever roadmap it was given — unset, black-smith's own
    // factory/specs/roadmap.md, which would replace the fixture roadmap
    // written above before the first assertion runs.
    [
      cliPath,
      'ui',
      'serve',
      '--port',
      String(PORT),
      '--db',
      dbPath,
      '--state-dir',
      stateDir,
      '--roadmap-path',
      roadmapPath,
    ],
    { stdio: 'pipe', env: process.env },
  );
  serverProcess.stdout?.on('data', () => {});
  serverProcess.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  await waitForHealth(`http://127.0.0.1:${PORT}/api/health`, 15000);

  return async () => {
    if (!serverProcess.killed) serverProcess.kill();
  };
}
