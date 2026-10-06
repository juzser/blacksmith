// A foreign store in the dashboard, end to end. The suite's shared server runs
// against an empty CLI registry (global-setup.ts), so nothing here can use it:
// this spec starts a second `ui serve` of its own on a free port, with a home
// store, a registry naming this process as a live CLI session, and a second
// project's store behind that session's cwd. Both stores come from the same
// fixture, so every task id collides on purpose; the foreign one gets its own
// objectives so a page that read the wrong store shows the wrong title.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const TASK_1 = 'epic-1/task-1';
const TASK_2 = 'epic-1/task-2';
const TASK_4 = 'epic-1/task-4';
const HOME_TITLE_1 = 'Add the widget renderer.';
const HOME_TITLE_2 = 'Simplify the config loader.';
const FOREIGN_TITLE_1 = 'Foreign widget renderer.';
const FOREIGN_TITLE_2 = 'Foreign config loader.';

let tmp = '';
let origin = '';
let server: ChildProcess | null = null;
let foreignId = '';
let registryFile = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const taskUrl = (id: string, store?: string) =>
  `${origin}/tasks/${encodeURIComponent(id)}${store ? `?store=${store}` : ''}`;

/** A router navigation, not a reload: the component is reused, as in the app. */
async function pushRoute(page: Page, to: string) {
  await page.evaluate((target) => {
    const app = (document.querySelector('#app') as { __vue_app__?: unknown } | null)?.__vue_app__ as
      | { config: { globalProperties: { $router: { push: (t: string) => unknown } } } }
      | undefined;
    app?.config.globalProperties.$router.push(target);
  }, to);
}

const title = (page: Page) => page.getByRole('heading', { level: 1 });

test.describe('a foreign store in the dashboard', () => {
  test.beforeAll(async () => {
    const { buildFixture } = await import(
      path.join(REPO_ROOT, 'factory', 'orchestrator', 'test', 'db', 'fixtures.ts')
    );
    const { appendEvent, readEvents } = await import(
      path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'events.ts')
    );
    const { raiseFinding } = await import(
      path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'findings.ts')
    );
    const { rebuild } = await import(
      path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'db', 'projector.ts')
    );
    delete process.env.CLAUDE_CODE_SESSION_ID;

    tmp = await mkdtemp(path.join(tmpdir(), 'smith-e2e-multistore-'));
    const home = path.join(tmp, 'home');
    const foreign = path.join(tmp, 'project-b');
    const config = path.join(tmp, 'config');
    const homeEvents = path.join(home, 'state', 'events');
    const foreignEvents = path.join(foreign, '.blacksmith', 'state', 'events');
    await mkdir(path.join(foreign, '.git'), { recursive: true });
    await mkdir(path.join(foreign, 'src'), { recursive: true });
    await mkdir(path.join(config, 'sessions'), { recursive: true });
    await mkdir(homeEvents, { recursive: true });
    await mkdir(foreignEvents, { recursive: true });

    for (const eventsDir of [homeEvents, foreignEvents]) {
      const opts = { stateDir: eventsDir };
      await buildFixture(opts);
      // A waivable finding on task-4, so a store-blind page would offer Waive.
      const events = await readEvents('sess-fixture', opts);
      const last = events[events.length - 1];
      await raiseFinding(
        {
          finding: {
            finding_id: 'finding-9',
            task_id: TASK_4,
            finding_category: 'over-engineering',
            severity: 'S3-minor',
            finding_status: 'raised',
            summary: 'one more layer than the task needs',
            failure_scenario: { inputs: 'n/a', expected: 'none', actual: 'a layer' },
            found_by: 'reviewer',
          },
          filePath: 'src/config.ts',
        },
        { sessionId: 'sess-fixture', planVersion: 1, causalParent: last?.event_id ?? null },
        opts,
      );
    }
    // An image output on the home task-4, for the lightbox.
    const homeOpts = { stateDir: homeEvents };
    const homeLast = (await readEvents('sess-fixture', homeOpts)).at(-1);
    await appendEvent(
      {
        session_id: 'sess-fixture',
        actor: 'coder',
        event_type: 'task-result-recorded',
        task_id: TASK_4,
        plan_version: 1,
        causal_parent: homeLast?.event_id ?? null,
        payload: {
          task_id: TASK_4,
          run_status: 'done',
          structured_output: {},
          artifacts: [{ type: 'screenshot', path: 'artifacts/task-4.png' }],
          token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          agent: 'coder',
          provider: 'claude',
          model_tier: 'mid',
        },
      },
      homeOpts,
    );
    // The foreign store's own wording.
    for (const file of (await readdir(foreignEvents)).filter((f) => f.endsWith('.jsonl'))) {
      const full = path.join(foreignEvents, file);
      const text = (await readFile(full, 'utf8'))
        .replaceAll(HOME_TITLE_1, FOREIGN_TITLE_1)
        .replaceAll(HOME_TITLE_2, FOREIGN_TITLE_2);
      await writeFile(full, text);
    }

    const roadmap = path.join(home, 'roadmap.md');
    const dbPath = path.join(home, 'state', 'smith.db');
    await writeFile(
      roadmap,
      '## Phase A\n- id: phase-a\n- status: in-progress\n- epics: [epic-1]\n',
    );
    await rebuild(dbPath, 'all', { stateDir: homeEvents, roadmapPath: roadmap });

    // This process is the live CLI session the registry names.
    registryFile = path.join(config, 'sessions', `${process.pid}.json`);
    await writeFile(
      registryFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: path.join(foreign, 'src'),
        kind: 'interactive',
        status: 'busy',
      }),
    );

    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js'),
        'ui',
        'serve',
        '--port',
        String(port),
        '--db',
        dbPath,
        '--state-dir',
        homeEvents,
        '--roadmap-path',
        roadmap,
        '--claude-config-dir',
        config,
      ],
      { stdio: 'pipe', env: { ...process.env, CLAUDE_CODE_SESSION_ID: undefined } },
    );
    server.stdout?.on('data', () => {});
    server.stderr?.on('data', () => {});
    await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, 15000, 'the server');
    await waitFor(
      async () => {
        const cols = (await (await fetch(`${origin}/api/kanban`)).json()) as {
          tasks: { taskId: string; store: { id: string } }[];
        }[];
        const hit = cols
          .flatMap((c) => c.tasks)
          .find((t) => t.taskId === TASK_1 && t.store.id !== 'home');
        foreignId = hit?.store.id ?? '';
        return foreignId !== '';
      },
      30000,
      'the foreign store',
    );
  });

  test.afterAll(async () => {
    if (server && !server.killed) server.kill();
    await rm(tmp, { recursive: true, force: true });
  });

  test('B1: a foreign task page reads its own store and offers nothing store-blind', async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search);
    });
    await page.goto(taskUrl(TASK_1, foreignId));
    await expect(title(page)).toHaveText(FOREIGN_TITLE_1);
    await page.getByRole('tab', { name: 'Outputs' }).click();
    await expect(page.getByText('No outputs recorded.')).toBeVisible();
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText('No events recorded.')).toBeVisible();
    await page.goto(taskUrl(TASK_4, foreignId));
    await page.getByRole('tab', { name: 'Findings' }).click();
    await expect(page.getByText('one more layer than the task needs')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Waive' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await page.waitForTimeout(500);

    const taskReads = requests.filter((p) => p.startsWith('/api/tasks/'));
    expect(taskReads.length).toBeGreaterThan(0);
    for (const read of taskReads) expect(read).toContain(`store=${foreignId}`);
    // Reads keyed by the served store's own ids are not made for a foreign task.
    expect(requests.filter((p) => /^\/api\/(timeline|artifacts|waivers)/.test(p))).toEqual([]);

    // The same task id in the served store is a different task, with Waive.
    await page.goto(taskUrl(TASK_4));
    await page.getByRole('tab', { name: 'Findings' }).click();
    await expect(page.getByRole('button', { name: 'Waive' })).toBeVisible();
  });

  test('B2: a foreign Kanban card peeks its own task and opens the store-scoped page', async ({
    page,
  }) => {
    await page.goto(`${origin}/work/kanban`);
    const card = page.getByRole('link', { name: /Foreign config loader/ });
    await expect(card).toBeVisible();
    await card.click();
    const peek = page.getByRole('dialog');
    await expect(peek.getByText(FOREIGN_TITLE_2)).toBeVisible();
    await peek.getByRole('link', { name: 'Open full page' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/epic-1%2Ftask-2\\?store=${foreignId}$`));
    await expect(title(page)).toHaveText(FOREIGN_TITLE_2);
  });

  test('B3: changing task or store on the open page loads the new one at once, once', async ({
    page,
  }) => {
    await page.goto(taskUrl(TASK_1));
    await expect(title(page)).toHaveText(HOME_TITLE_1);

    // Store changes, task id stays.
    const detailReads: string[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (/^\/api\/tasks\/[^/]+$/.test(url.pathname)) detailReads.push(url.pathname + url.search);
    });
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_1)}?store=${foreignId}`);
    await expect(title(page)).toHaveText(FOREIGN_TITLE_1, { timeout: 3000 });
    await expect(page.getByText(HOME_TITLE_1)).toHaveCount(0);

    // Task changes inside the foreign store.
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_2)}?store=${foreignId}`);
    await expect(title(page)).toHaveText(FOREIGN_TITLE_2, { timeout: 3000 });
    await expect(page.getByText(FOREIGN_TITLE_1)).toHaveCount(0);

    // One read per change, and no second poll behind it.
    await page.waitForTimeout(2500);
    expect(detailReads).toEqual([
      `/api/tasks/epic-1%2Ftask-1?store=${foreignId}`,
      `/api/tasks/epic-1%2Ftask-2?store=${foreignId}`,
    ]);
  });

  test('B5: a lightbox and a popover do not outlive the task they belong to', async ({ page }) => {
    await page.goto(taskUrl(TASK_4));
    await page.getByRole('tab', { name: 'Outputs' }).click();
    await page.getByRole('button', { name: 'screenshot' }).click();
    await expect(page.getByRole('dialog', { name: 'Artifact preview' })).toBeVisible();
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_2)}?store=${foreignId}`);
    await expect(title(page)).toHaveText(FOREIGN_TITLE_2);
    await expect(page.getByRole('dialog', { name: 'Artifact preview' })).toHaveCount(0);

    await page.goto(taskUrl(TASK_4));
    await page.getByRole('tab', { name: 'Findings' }).click();
    await page.getByRole('button', { name: 'Waive' }).click();
    await expect(page.getByRole('dialog', { name: 'Waive finding' })).toBeVisible();
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_4)}?store=${foreignId}`);
    await expect(page.getByRole('dialog', { name: 'Waive finding' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Waive' })).toHaveCount(0);
  });

  // Last: it ends the foreign CLI session. The grace period is 5 minutes, which
  // the server has no flag to shorten, so this runs the real window: the store
  // leaves the Kanban board at once and its task page keeps loading.
  test('B4: after its CLI session ends the store still serves an open task page', async ({
    page,
  }) => {
    await page.goto(taskUrl(TASK_1, foreignId));
    await expect(title(page)).toHaveText(FOREIGN_TITLE_1);
    await rm(registryFile);
    await waitFor(
      async () => {
        const cols = (await (await fetch(`${origin}/api/kanban`)).json()) as {
          tasks: { store: { id: string } }[];
        }[];
        return !cols.flatMap((c) => c.tasks).some((t) => t.store.id === foreignId);
      },
      20000,
      'the foreign store to leave the board',
    );
    await page.reload();
    await expect(title(page)).toHaveText(FOREIGN_TITLE_1);
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_2)}?store=${foreignId}`);
    await expect(title(page)).toHaveText(FOREIGN_TITLE_2, { timeout: 3000 });
  });
});
