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
import { FIXTURE_NOW_ISO } from './fixtureClock.js';
import { ARIAL_FONT_CSS, arialInit } from './fontSwitch.js';
import { expect, type Page, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const TASK_1 = 'epic-1/task-1';
const TASK_2 = 'epic-1/task-2';
const TASK_4 = 'epic-1/task-4';
const HOME_TITLE_1 = 'Add the widget renderer.';
const HOME_TITLE_2 = 'Simplify the config loader.';
const FOREIGN_TITLE_1 = 'Foreign widget renderer.';
const FOREIGN_TITLE_2 = 'Foreign config loader.';
const EXTRA_NOTES = 40;
const FOREIGN_EPIC = 'epic-b';

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

/**
 * Records every response body the page finishes reading, so a test can wait on
 * a signal instead of a timer. The page's `await res.json()` continuation, its
 * throw and the stale-guarded catch (and Vue's render) are all chained after
 * this wrapper's `.finally`, so they run in the same microtask checkpoint; a
 * later `page.evaluate` (a new task) that sees the count has run after them.
 */
async function recordBodies(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __bodies: { url: string; status: number }[] };
    w.__bodies = [];
    const orig = Response.prototype.json;
    Response.prototype.json = function (this: Response) {
      return orig.call(this).finally(() => {
        w.__bodies.push({ url: this.url, status: this.status });
      });
    };
  });
}

/** How many 500 bodies the page has finished reading for a URL containing `part`. */
const errorBodiesRead = (page: Page, part: string) =>
  page.evaluate(
    (p) =>
      (window as unknown as { __bodies: { url: string; status: number }[] }).__bodies.filter(
        (b) => b.url.includes(p) && b.status === 500,
      ).length,
    part,
  );

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

    // Enough extra events, written first and store by store in turn, that the
    // merged feed outgrows one 50-row page, the fixture stays on the newest page,
    // and the older page still holds rows of both stores.
    for (let n = 0; n < EXTRA_NOTES; n++) {
      for (const dir of [homeEvents, foreignEvents]) {
        await appendEvent(
          {
            session_id: 'sess-extra',
            actor: 'user',
            event_type: n === 0 ? 'session-start' : 'operator-note',
            plan_version: 1,
            causal_parent: n === 0 ? null : `sess-extra#${n - 1}`,
            payload: n === 0 ? {} : { note: `extra ${n}` },
          },
          { stateDir: dir },
        );
      }
    }
    for (const eventsDir of [homeEvents, foreignEvents]) {
      const opts = { stateDir: eventsDir };
      await buildFixture(opts);
      if (eventsDir === foreignEvents) {
        // An epic and a milestone only the foreign store has, for the Roadmap. Its
        // tasks join the fixture's session so no extra session row appears.
        for (const n of [1, 2]) {
          const parent = (await readEvents('sess-fixture', { stateDir: foreignEvents })).at(-1);
          await appendEvent(
            {
              session_id: 'sess-fixture',
              actor: 'planner',
              event_type: 'task-added',
              task_id: `${FOREIGN_EPIC}/task-${n}`,
              plan_version: 1,
              causal_parent: parent?.event_id ?? null,
              payload: {
                epic_id: FOREIGN_EPIC,
                case: 'feature',
                origin: 'user',
                task_status: 'todo',
                plan_version: 1,
                objective: `Foreign roadmap work ${n}.`,
                claims: [],
                budget_tokens: 100,
              },
            },
            { stateDir: foreignEvents },
          );
        }
      }
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
    // Stamped after the foreign store's last event: a same-ms tie flipped the Sessions group order.
    const foreignTs: string = (await readEvents('sess-fixture', { stateDir: foreignEvents })).at(-1)
      .record.ts;
    while (new Date().toISOString() <= foreignTs) await new Promise((r) => setTimeout(r, 1));
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
    const foreignSpecs = path.join(foreign, '.blacksmith', 'factory', 'specs');
    await mkdir(foreignSpecs, { recursive: true });
    await writeFile(
      path.join(foreignSpecs, 'roadmap.md'),
      `## Foreign phase\n- id: phase-b\n- status: in-progress\n- epics: [${FOREIGN_EPIC}]\n`,
    );
    // The foreign store's own wording, and each store's own project on every
    // event, so the merged Activity feed spans two projects.
    const stamp = (text: string, project: string) =>
      text
        .split('\n')
        .map((line) => (line ? JSON.stringify({ ...JSON.parse(line), project }) : line))
        .join('\n');
    for (const [dir, project] of [
      [homeEvents, 'project-a'],
      [foreignEvents, 'project-b'],
    ] as const) {
      for (const file of (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))) {
        const full = path.join(dir, file);
        let text = await readFile(full, 'utf8');
        if (dir === foreignEvents) {
          text = text
            .replaceAll(HOME_TITLE_1, FOREIGN_TITLE_1)
            .replaceAll(HOME_TITLE_2, FOREIGN_TITLE_2);
        }
        await writeFile(full, stamp(text, project));
      }
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
    // The server writes its cache under tmp: let it exit before the tree goes.
    const child = server;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(forced);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    // Every read the page makes is issued when it loads, before the Findings
    // tab above could render, so nothing is still to come.

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

  test('R1: the Roadmap shows a foreign epic with its tasks and waves, and its milestone', async ({
    page,
  }) => {
    await page.goto(`${origin}/work/roadmap?scope=all&phase=phase-b`);
    const block = page.getByRole('region', { name: /Foreign phase.*goal and epics/ });
    await expect(block).toBeVisible();
    const section = block.locator('.esec', { hasText: FOREIGN_EPIC });
    await expect(section.getByText('0 of 2 tasks done')).toBeVisible();
    await expect(section.getByText('No tasks tracked')).toHaveCount(0);
    await section.getByRole('button', { name: /Show waves|Hide waves/ }).click();
    await expect(section.locator(`#waves-${FOREIGN_EPIC}`)).toContainText('Foreign roadmap work');
  });

  test('B2: a foreign Kanban card peeks its own task and opens the store-scoped page', async ({
    page,
  }) => {
    // All: this is about a foreign card, and no live session drives its epic.
    await page.goto(`${origin}/work/kanban?scope=all`);
    const card = page.getByRole('button', { name: /Foreign config loader.*opens task detail/ });
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
    // The page's 15 s poll runs on a clock this test owns: paused, so no poll
    // can fire by itself, and advanced by hand past exactly one interval.
    // With the change stream open the interval stands down, so refuse the
    // stream: the interval is then the page's only trigger for a re-read.
    await page.route('**/api/stream', (route) => route.abort());
    const start = new Date(FIXTURE_NOW_ISO);
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 1000));
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

    // One read per change so far; the poll of the old task is gone.
    expect(detailReads).toEqual([
      `/api/tasks/epic-1%2Ftask-1?store=${foreignId}`,
      `/api/tasks/epic-1%2Ftask-2?store=${foreignId}`,
    ]);
    // One poll interval later: one read, for the new task only.
    await page.clock.runFor(15_000);
    await expect.poll(() => detailReads.length).toBe(3);
    expect(detailReads[2]).toBe(`/api/tasks/epic-1%2Ftask-2?store=${foreignId}`);
  });

  test('A1: a history answer for the old task leaves nothing on the new one', async ({ page }) => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    await page.route('**/api/timeline?*', async (route) => {
      if (held) return route.continue();
      held = true;
      await gate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'boom', message: 'boom-history' } }),
      });
    });
    await recordBodies(page);
    await page.goto(taskUrl(TASK_4));
    await expect(title(page)).toBeVisible();
    await expect.poll(() => held).toBe(true);
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_2)}`);
    await expect(title(page)).toHaveText(HOME_TITLE_2);
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText('No events recorded.')).toHaveCount(0);
    await expect(page.locator('.timeline-feed').first()).toBeVisible();
    release();
    await expect.poll(() => errorBodiesRead(page, '/api/timeline')).toBe(1);
    await expect(page.getByText('boom-history')).toHaveCount(0);
    await expect(page.locator('.timeline-feed').first()).toBeVisible();
  });

  test('A2: a waiver answer for the old task writes no error on the new one', async ({ page }) => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    await page.route('**/api/waivers/apply-batch', async (route) => {
      held = true;
      await gate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'boom', message: 'boom-decide' } }),
      });
    });
    await recordBodies(page);
    await page.goto(taskUrl(TASK_4));
    await page.getByRole('tab', { name: 'Findings' }).click();
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => held).toBe(true);
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_2)}`);
    await expect(title(page)).toHaveText(HOME_TITLE_2);
    release();
    await expect.poll(() => errorBodiesRead(page, '/api/waivers/')).toBe(1);
    await expect(page.getByText('boom-decide')).toHaveCount(0);
    // The waiver is still there to act on, its controls not left disabled.
    await pushRoute(page, `/tasks/${encodeURIComponent(TASK_4)}`);
    await page.getByRole('tab', { name: 'Findings' }).click();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeEnabled();
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

  test.describe('Activity reads every store', () => {
    const rows = (page: Page) =>
      page.getByRole('feed', { name: 'Activity' }).locator('.bs-timeline-row__title');
    // Both stores replay one fixture, so every event id repeats; a row's DOM id
    // is `activity-row-<storeId>:<eventId>`, which is how the stores tell apart.
    const rowsOf = (page: Page, storeId: string) =>
      page.locator(`li[id^="activity-row-${storeId}:"]`);

    test('C1: no filter fetches stores=all and shows both stores, without an other-store line', async ({
      page,
    }) => {
      const reads: string[] = [];
      page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.pathname === '/api/timeline') reads.push(url.search);
      });
      await page.goto(`${origin}/activity?scope=all`);
      await expect(rowsOf(page, 'home').first()).toBeVisible();
      await expect(rowsOf(page, foreignId).first()).toBeVisible();
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) expect(new URLSearchParams(read).get('stores')).toBe('all');
      await expect(page.getByText(/in another store/i)).toHaveCount(0);
      // No two rows may share a DOM id even though event ids repeat.
      const ids = await page
        .locator('li[id^="activity-row-"]')
        .evaluateAll((els) => els.map((e) => e.id));
      expect(ids.length).toBeGreaterThan(1);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test('C4: Load older pages back across both stores with stores=all and the cursor', async ({
      page,
    }) => {
      const reads: URLSearchParams[] = [];
      page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.pathname === '/api/timeline') reads.push(url.searchParams);
      });
      const domIds = () =>
        page.locator('li[id^="activity-row-"]').evaluateAll((els) => els.map((e) => e.id));
      await page.goto(`${origin}/activity?scope=all`);
      await expect(rowsOf(page, 'home').first()).toBeVisible();
      const loadOlder = page.getByRole('button', { name: 'Load older' });
      await expect(loadOlder).toBeVisible();
      const firstPage = await domIds();
      await loadOlder.click();
      await expect.poll(() => reads.some((q) => q.has('before'))).toBe(true);
      await expect.poll(async () => (await domIds()).length).toBeGreaterThan(firstPage.length);

      const older = reads.filter((q) => q.has('before'));
      expect(older.length).toBeGreaterThan(0);
      for (const q of older) {
        expect(q.get('stores')).toBe('all');
        expect(q.get('before')).toBeTruthy();
      }
      const after = await domIds();
      const arrived = after.filter((id) => !firstPage.includes(id));
      expect(arrived.some((id) => id.startsWith('activity-row-home:'))).toBe(true);
      expect(arrived.some((id) => id.startsWith(`activity-row-${foreignId}:`))).toBe(true);
      await expect(rowsOf(page, 'home').first()).toBeVisible();
      await expect(rowsOf(page, foreignId).first()).toBeVisible();
      expect(new Set(after).size).toBe(after.length);
    });

    test('C2: a foreign row opens its own store task, and an explicit filter keeps the old request', async ({
      page,
    }) => {
      await page.goto(`${origin}/activity?scope=all`);
      const link = rowsOf(page, foreignId)
        .filter({ hasText: TASK_1 })
        .locator('.bs-timeline-row__title--link')
        .first();
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/tasks/epic-1%2Ftask-1\\?store=${foreignId}$`));
      await expect(title(page)).toHaveText(FOREIGN_TITLE_1);

      const reads: string[] = [];
      page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.pathname === '/api/timeline') reads.push(url.search);
      });
      await page.goto(`${origin}/activity?task=${encodeURIComponent(TASK_1)}`);
      await expect(rows(page).first()).toBeVisible();
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) expect(new URLSearchParams(read).has('stores')).toBe(false);
    });

    test('C3: the multi-project feed names each project in its dividers and expanded rows', async ({
      page,
    }) => {
      await page.goto(`${origin}/activity?scope=all`);
      const feed = page.getByRole('feed', { name: 'Activity' });
      const items = feed.locator('ol > li');
      await expect(rowsOf(page, foreignId).first()).toBeVisible();
      // The first block is labelled: a divider sits above the first row.
      await expect(items.first()).toHaveClass(/bs-session-divider/);
      await expect(items.first()).toContainText(/^project-[ab] · Session: /);
      await expect(
        feed.locator('.bs-session-divider', { hasText: 'project-b · Session:' }).first(),
      ).toBeVisible();

      // A foreign row names its project when expanded, and links carry its store.
      const foreignRow = rowsOf(page, foreignId).filter({ hasText: TASK_1 }).first();
      await foreignRow.getByRole('button', { name: 'Show details' }).click();
      const detail = foreignRow.locator('.bs-timeline-row__detail');
      await expect(detail.locator('dt', { hasText: 'Project' })).toBeVisible();
      await expect(detail.locator('dt:has-text("Project") + dd')).toHaveText('project-b');
      await expect(detail.getByRole('link')).toHaveAttribute(
        'href',
        new RegExp(`store=${foreignId}`),
      );

      const homeRow = rowsOf(page, 'home')
        .filter({ has: page.locator('.bs-timeline-row__title--link') })
        .first();
      await homeRow.getByRole('button', { name: 'Show details' }).click();
      const homeDetail = homeRow.locator('.bs-timeline-row__detail');
      await expect(homeDetail.locator('dt:has-text("Project") + dd')).toHaveText('project-a');
      await expect(homeDetail.getByRole('link')).not.toHaveAttribute('href', /store=/);

      // The task link (a button that routes) is store-scoped for a foreign row only.
      await homeRow.locator('.bs-timeline-row__title--link').click();
      await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
      await page.goBack();
      await rowsOf(page, foreignId)
        .filter({ has: page.locator('.bs-timeline-row__title--link') })
        .first()
        .locator('.bs-timeline-row__title--link')
        .click();
      await expect(page).toHaveURL(new RegExp(`/tasks/[^?]+\\?store=${foreignId}$`));
    });

    for (const [name, viewport] of [
      ['desktop-light', VIEWPORTS.desktop],
      ['phone-light', { width: 375, height: 812 }],
    ] as const) {
      test(`screenshot two stores ${name}`, async ({ page }) => {
        await setTheme(page, 'light');
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/activity?scope=all`);
        await expect(rowsOf(page, foreignId).first()).toBeVisible();
        await settleForShot(page, rowsOf(page, 'home').first());
        await shoot(page, `activity-two-stores-${name}`);
      });
    }
  });

  test.describe('Cost & quality over two stores', () => {
    // Home holds two recorded runs (2000 + 2 tokens), the foreign store one
    // (2000): the page must show three runs and about 4K tokens, not either alone.
    // The server stamps the fixture with the wall clock, so the day labels are
    // pinned for the screenshot; every figure stays the server's.
    const pinDays = async (page: Page) => {
      await page.route('**/api/analytics*', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.tokensByDay = (body.tokensByDay as { day: string }[]).map((d, i) => ({
          ...d,
          day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
        }));
        await route.fulfill({ response, json: body });
      });
    };

    test('the page asks every store and shows the summed runs', async ({ page }) => {
      const reads: URL[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname === '/api/analytics') reads.push(u);
      });
      await page.goto(`${origin}/analytics?scope=all`);
      // The role table: three runs and 4K tokens, the sum of both stores.
      const row = page.getByRole('row', { name: /^Builder 3 4K tok/ });
      await expect(row).toBeVisible();
      expect(reads.every((u) => u.searchParams.get('stores') === 'all')).toBe(true);
      await expect(page.getByText('in another store')).toHaveCount(0);
    });

    for (const [name, viewport] of [
      ['desktop-light', VIEWPORTS.desktop],
      ['phone-light', { width: 375, height: 812 }],
    ] as const) {
      test(`screenshot two stores ${name}`, async ({ page }) => {
        await setTheme(page, 'light');
        await page.setViewportSize(viewport);
        await pinDays(page);
        await page.goto(`${origin}/analytics?scope=all`);
        await expect(page.locator('h1')).toHaveText('Cost & quality');
        const marker =
          name === 'phone-light'
            ? page.locator('.bs-analytics-page__phone-metrics')
            : page.locator('.bs-card__title').getByText('Tokens per day', { exact: true });
        await settleForShot(page, marker);
        await shoot(page, `analytics-two-stores-${name}`);
      });
    }
  });

  test.describe('Sessions over two stores', () => {
    // Both stores replay one fixture, so the session id repeats: the foreign
    // copy sits under its store's label and opens its own roster.
    const groupOf = (page: Page, project: string) =>
      page.locator('section.bs-sessions__group').filter({
        has: page.getByRole('heading', { level: 2, name: project }),
      });
    const roster = (page: Page) => page.getByLabel("Selected session's agents", { exact: true });

    test('the page asks every store and opens a foreign roster with its store', async ({
      page,
    }) => {
      const lists: URL[] = [];
      const rosters: string[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname === '/api/sessions') lists.push(u);
        if (/^\/api\/sessions\/[^/]+\/agents$/.test(u.pathname))
          rosters.push(u.pathname + u.search);
      });
      await page.goto(`${origin}/sessions?scope=all`);
      const row = groupOf(page, 'project-b').locator('.bs-sessionrow').first();
      await expect(row).toBeVisible();
      expect(lists.some((u) => u.searchParams.get('stores') === 'all')).toBe(true);
      await expect(page.getByText(/in another store/i)).toHaveCount(0);
      await row.click();
      await expect(page).toHaveURL(new RegExp(`[?&]session=sess-fixture&store=${foreignId}`));
      await expect(roster(page).locator('.bs-agentblock').first()).toBeVisible();
      expect(rosters).toContain(`/api/sessions/sess-fixture/agents?store=${foreignId}`);
    });

    test('a session with no epic sits under its own store: foreign under its label, home under No project', async ({
      page,
    }) => {
      await page.goto(`${origin}/sessions?scope=all`);
      const extra = (group: ReturnType<Page['locator']>) =>
        group.locator('.bs-sessionrow').filter({ hasText: 'sess-extra' });
      await expect(extra(groupOf(page, 'project-b'))).toHaveCount(1);
      await expect(extra(groupOf(page, 'No project'))).toHaveCount(1);
      await expect(extra(groupOf(page, 'project-a'))).toHaveCount(0);
    });

    for (const [name, viewport] of [
      ['desktop-light', VIEWPORTS.desktop],
      ['phone-light', { width: 375, height: 812 }],
    ] as const) {
      test(`screenshot two stores ${name}`, async ({ page }) => {
        await setTheme(page, 'light');
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/sessions?scope=all`);
        const row = groupOf(page, 'project-b').locator('.bs-sessionrow').first();
        await expect(row).toBeVisible();
        // Home's last event is the fixture's newest, so its group leads.
        await expect(page.locator('.bs-sessions__group-title')).toHaveText([
          'project-a',
          'project-b',
          'No project',
        ]);
        await settleForShot(page, row);
        await shoot(page, `sessions-two-stores-${name}`);
      });
    }

    // Gives the foreign `sess-extra` an agent that works for the session
    // itself, so the session still has no epic. Idempotent: it appends the
    // `dispatch_decision` only when none is there. Each test that reads the
    // agent calls it, so none depends on another test's write (a failed test
    // restarts the worker and `beforeAll` rebuilds the fixtures without it).
    // The screenshot tests above never call it, so they shoot the no-agent state.
    const ensureExtraAgent = async () => {
      const { appendEvent, readEvents } = await import(
        path.join(REPO_ROOT, 'factory', 'orchestrator', 'src', 'events.ts')
      );
      const opts = { stateDir: path.join(tmp, 'project-b', '.blacksmith', 'state', 'events') };
      const events = await readEvents('sess-extra', opts);
      if (!events.some((e: { event_type: string }) => e.event_type === 'dispatch_decision')) {
        await appendEvent(
          {
            session_id: 'sess-extra',
            actor: 'orchestrator',
            event_type: 'dispatch_decision',
            plan_version: 1,
            causal_parent: events.at(-1)?.event_id ?? null,
            project: 'project-b',
            payload: {
              agent_role: 'researcher',
              provider: 'claude',
              model_tier: 'mid',
              model: 'claude-sonnet-5',
              reason: 'Look around before any epic.',
            },
          },
          opts,
        );
      }
      await waitFor(
        async () => (await fetch(`${origin}/api/sessions/sess-extra/agents?store=${foreignId}`)).ok,
        15000,
        'the foreign agent',
      );
    };

    test('the foreign project link keeps its session with no epic, and its roster opens', async ({
      page,
    }) => {
      await ensureExtraAgent();
      await page.goto(`${origin}/sessions?scope=all`);
      const group = groupOf(page, 'project-b');
      const extra = () => page.locator('.bs-sessionrow').filter({ hasText: 'sess-extra' });
      await expect(group.locator('.bs-sessionrow').filter({ hasText: 'sess-extra' })).toHaveCount(
        1,
      );
      await group.getByRole('link', { name: 'project-b', exact: true }).click();
      await expect(page).toHaveURL(/[?&]project=project-b(&|$)/);
      await expect(page.locator('section.bs-sessions__group')).toHaveCount(0);
      await expect(extra()).toHaveCount(1);
      await extra().click();
      await expect(page).toHaveURL(new RegExp(`[?&]session=sess-extra&store=${foreignId}`));
      await expect(roster(page).locator('.bs-agentblock')).toHaveCount(1);
    });

    test('Tab walks from one session row to the next, with no stop on a time inside a row', async ({
      page,
    }) => {
      await ensureExtraAgent();
      await page.goto(`${origin}/sessions?scope=all`);
      const rows = groupOf(page, 'project-b').locator('button.bs-sessionrow');
      await expect(rows).toHaveCount(2);
      await rows.first().focus();
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => {
          const el = document.activeElement;
          return {
            isRow: el?.matches('button.bs-sessionrow') ?? false,
            inRow: !!el?.closest('button.bs-sessionrow') && !el?.matches('button.bs-sessionrow'),
          };
        }),
      ).toEqual({ isRow: true, inRow: false });
      expect(
        await page.locator('button.bs-sessionrow [tabindex], button.bs-sessionrow a').count(),
      ).toBe(0);
    });

    for (const [name, viewport] of [
      ['desktop', VIEWPORTS.desktop],
      ['phone', { width: 375, height: 812 }],
    ] as const) {
      test(`both group header branches read alike on ${name}: same type, one colour per quiet state, underline on keyboard focus`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        // One live factory session in the home store (project-a): that group is
        // not quiet, the other two are, so both colour branches run.
        await page.route('**/api/active-scope*', async (route) => {
          const real = await (await route.fetch()).json();
          await route.fulfill({
            json: {
              ...real,
              measured: true,
              factorySessions: [{ storeId: 'home', sessionId: 'sess-fixture' }],
            },
          });
        });
        await page.goto(`${origin}/sessions?scope=all`);
        const titles = page.locator('.bs-sessions__group-title');
        await expect(titles).toHaveCount(3);
        const read = await page.evaluate(() => {
          const probe = (v: string) => {
            const el = document.createElement('span');
            el.style.color = `var(${v})`;
            document.body.append(el);
            const c = getComputedStyle(el).color;
            el.remove();
            return c;
          };
          return {
            text: probe('--bs-text'),
            subtle: probe('--bs-text-subtle'),
            groups: [...document.querySelectorAll('section.bs-sessions__group')].map((g) => {
              const h = g.querySelector('.bs-sessions__group-title') as HTMLElement;
              const target = (h.querySelector('a') ?? h) as HTMLElement;
              const cs = getComputedStyle(target);
              return {
                name: h.textContent?.trim(),
                quiet: g.classList.contains('bs-sessions__group--quiet'),
                size: cs.fontSize,
                weight: cs.fontWeight,
                color: cs.color,
                line: cs.textDecorationLine,
              };
            }),
          };
        });
        expect(read.groups.filter((g) => g.quiet).length).toBe(2);
        expect(read.groups.filter((g) => !g.quiet).length).toBe(1);
        expect(new Set(read.groups.map((g) => g.size)).size).toBe(1);
        expect(new Set(read.groups.map((g) => g.weight)).size).toBe(1);
        for (const g of read.groups) {
          expect([g.name, g.color]).toEqual([g.name, g.quiet ? read.subtle : read.text]);
          expect([g.name, g.line]).toEqual([g.name, 'none']);
        }
        const link = groupOf(page, 'project-a').getByRole('link', {
          name: 'project-a',
          exact: true,
        });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        for (let i = 0; i < 40; i++) {
          if (await link.evaluate((el) => el === document.activeElement)) break;
          await page.keyboard.press('Tab');
        }
        await expect(link).toBeFocused();
        expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe(
          'underline',
        );
      });
    }

    for (const width of [375, 390]) {
      for (const font of ['default', 'arial'] as const) {
        test(`on a ${width}px phone (${font} font) each group header link is a 44px target that touches no other target, and every header is as tall`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 812 });
          if (font === 'arial') await page.addInitScript(arialInit, ARIAL_FONT_CSS);
          await page.goto(`${origin}/sessions?scope=all`);
          await expect(page.locator('.bs-sessions__group-title a')).toHaveCount(2);
          const found = await page.evaluate(() => {
            const sel = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
            const all = [...document.querySelectorAll<HTMLElement>(sel)].filter(
              (el) => el.getBoundingClientRect().width > 0,
            );
            return [...document.querySelectorAll<HTMLElement>('.bs-sessions__group-title a')].map(
              (link) => {
                const b = link.getBoundingClientRect();
                const hits = all
                  .filter((o) => o !== link && !link.contains(o) && !o.contains(link))
                  .map((o) => {
                    const r = o.getBoundingClientRect();
                    return {
                      who: (o.textContent ?? '').trim().slice(0, 20),
                      w: Math.min(b.right, r.right) - Math.max(b.left, r.left),
                      h: Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top),
                    };
                  })
                  .filter((x) => x.w > 1 && x.h > 1);
                return { name: link.textContent?.trim(), w: b.width, h: b.height, hits };
              },
            );
          });
          for (const f of found) {
            expect(f.w).toBeGreaterThanOrEqual(44);
            expect(f.h).toBeGreaterThanOrEqual(44);
            expect([f.name, f.hits]).toEqual([f.name, []]);
          }

          const heights = await page
            .locator('.bs-sessions__group-title')
            .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
          expect(heights).toHaveLength(3);
          expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
        });
      }
    }

    // A project name far longer than the page is wide: with and without spaces.
    const LONG_NAMES = {
      spaced: 'a-very long project name that keeps going well past any screen edge, twice over',
      unbroken: `project-${'a'.repeat(52)}`,
    };
    for (const [width, height] of [
      [375, 812],
      [390, 812],
      [1280, 800],
    ] as const) {
      for (const [variant, longName] of Object.entries(LONG_NAMES)) {
        test(`a long project name (${variant}) wraps to two lines at ${width}px and never leaves the page`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height });
          await page.route('**/api/sessions?*', async (route) => {
            const real = await (await route.fetch()).json();
            await route.fulfill({
              json: real.map((r: { projects: string[]; title: string | null }) => ({
                ...r,
                projects: r.projects.map((p) => (p === 'project-a' ? longName : p)),
                title: r.projects.includes('project-a') ? `${longName}-title` : r.title,
              })),
            });
          });
          await page.goto(`${origin}/sessions?scope=all`);
          const link = page.locator('.bs-sessions__group-title a').filter({ hasText: longName });
          await expect(link).toHaveCount(1);
          const m = await page.evaluate((name) => {
            const scroll = document.querySelector('.app-scroll') as HTMLElement;
            const link = [
              ...document.querySelectorAll<HTMLElement>('.bs-sessions__group-title a'),
            ].find((a) => a.textContent?.trim() === name) as HTMLElement;
            const label = (link.querySelector('span') ?? link) as HTMLElement;
            const page = document.querySelector('.app-page') as HTMLElement;
            const pr = page.getBoundingClientRect();
            const pad = parseFloat(getComputedStyle(page).paddingRight);
            const lr = link.getBoundingClientRect();
            const lh = parseFloat(getComputedStyle(label).lineHeight);
            // The previous focusable target above this header.
            const above = [...document.querySelectorAll<HTMLElement>('a, button')]
              .filter(
                (o) =>
                  o !== link &&
                  !link.contains(o) &&
                  o.getBoundingClientRect().bottom <= lr.top + 60,
              )
              .map((o) => o.getBoundingClientRect().bottom)
              .filter((b) => b > 0 && b <= lr.top + 60);
            return {
              scroll: { sw: scroll.scrollWidth, cw: scroll.clientWidth },
              root: {
                sw: document.documentElement.scrollWidth,
                cw: document.documentElement.clientWidth,
              },
              overflow: lr.right - (pr.right - pad),
              width: lr.width,
              lines: Math.round(label.getBoundingClientRect().height / lh),
              title: link.getAttribute('title'),
              overlap: above.length ? Math.max(...above) - lr.top : 0,
              top: lr.top,
            };
          }, longName);
          expect(m.scroll.sw).toBeLessThanOrEqual(m.scroll.cw);
          expect(m.root.sw).toBeLessThanOrEqual(m.root.cw);
          expect(m.overflow).toBeLessThanOrEqual(0.5);
          expect(m.lines).toBeLessThanOrEqual(2);
          expect(m.title).toBe(longName);
          expect(await link.getAttribute('aria-label')).toBeNull();
          await expect(page.getByRole('link', { name: longName, exact: true })).toHaveCount(1);
          if (width < 640) expect(m.overlap).toBeLessThanOrEqual(1);

          // The same name in a session row's meta line, and the row title.
          const row = await page.evaluate((name) => {
            const meta = [
              ...document.querySelectorAll<HTMLElement>('.bs-sessionrow__meta > span:first-child'),
            ].find((s) => s.textContent?.trim() === name) as HTMLElement;
            const card = meta.closest('.bs-sessionrow') as HTMLElement;
            const title = card.querySelector('.bs-sessionrow__title') as HTMLElement;
            const cr = card.getBoundingClientRect();
            const inner = cr.right - parseFloat(getComputedStyle(card).paddingRight);
            const lh = parseFloat(getComputedStyle(meta).lineHeight);
            const tlh = parseFloat(getComputedStyle(title).lineHeight);
            return {
              overflow: meta.getBoundingClientRect().right - inner,
              lines: Math.round(meta.getBoundingClientRect().height / lh),
              title: meta.getAttribute('title'),
              titleOverflow: title.getBoundingClientRect().right - inner,
              titleScroll: title.scrollWidth - title.clientWidth,
              titleLines: Math.round(title.getBoundingClientRect().height / tlh),
            };
          }, longName);
          expect(row.overflow).toBeLessThanOrEqual(0.5);
          expect(row.lines).toBeLessThanOrEqual(2);
          expect(row.title).toBe(longName);
          expect(row.titleOverflow).toBeLessThanOrEqual(0.5);
          expect(row.titleScroll).toBeLessThanOrEqual(0);
          expect(row.titleLines).toBeLessThanOrEqual(2);
        });
      }
    }

    for (const [name, viewport] of [
      ['phone', { width: 375, height: 812 }],
      ['desktop', { width: 1280, height: 800 }],
    ] as const) {
      test(`on ${name} a linked group header's text starts flush with the card edge, like No project`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/sessions?scope=all`);
        await expect(page.locator('.bs-sessions__group-title a')).toHaveCount(2);
        const lefts = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('section.bs-sessions__group')].map((g) => {
            const h = g.querySelector('.bs-sessions__group-title') as HTMLElement;
            const range = document.createRange();
            range.selectNodeContents(h.querySelector('a') ?? h);
            return {
              name: h.textContent?.trim(),
              text: range.getClientRects()[0]?.left ?? -1,
              card: (g.querySelector('.bs-sessionrow') as HTMLElement).getBoundingClientRect().left,
            };
          }),
        );
        expect(lefts).toHaveLength(3);
        for (const l of lefts) {
          expect(Math.abs(l.text - l.card)).toBeLessThanOrEqual(0.5);
        }
      });
    }

    test('a selected session names where it is from: title, project, start time', async ({
      page,
    }) => {
      await ensureExtraAgent();
      const line = (p: Page) => roster(p).locator('.bs-sessions__detail-head');
      await page.goto(`${origin}/sessions?scope=all`);
      await groupOf(page, 'project-b')
        .locator('.bs-sessionrow')
        .filter({ hasText: 'sess-extra' })
        .click();
      await expect(line(page)).toContainText('sess-extra');
      await expect(line(page)).toContainText('project-b');
      await expect(line(page).locator('time')).toHaveCount(1);
      await page.goto(`${origin}/sessions?scope=all&session=sess-extra&store=${foreignId}`);
      await expect(line(page)).toContainText('project-b');
      await expect(line(page).locator('time')).toHaveCount(1);
      await page.goto(`${origin}/sessions?scope=all`);
      await groupOf(page, 'No project')
        .locator('.bs-sessionrow')
        .filter({ hasText: 'sess-extra' })
        .click();
      await expect(line(page)).toContainText('No project');
    });

    test('selecting a session that has no agents yet shows a plain line, not an error', async ({
      page,
    }) => {
      // The home store's `sess-extra` only ever got notes; the foreign one's
      // agent (ensureExtraAgent) lives in another store under the same id.
      await page.goto(`${origin}/sessions?scope=all`);
      await groupOf(page, 'No project')
        .locator('.bs-sessionrow')
        .filter({ hasText: 'sess-extra' })
        .click();
      await expect(page).toHaveURL(/[?&]session=sess-extra(&|$)/);
      await expect(roster(page).getByText('No agents yet.', { exact: true })).toBeVisible();
      await expect(roster(page).locator('.bs-agentblock')).toHaveCount(0);
      await expect(page.locator('.bs-banner')).toHaveCount(0);
      await expect(page.getByText('0 agents')).toHaveCount(0);
    });

    test('a selected session that drops out of the list keeps its roster, without a head line', async ({
      page,
    }) => {
      await ensureExtraAgent();
      let drop = false;
      await page.route('**/api/sessions?*', async (route) => {
        const real = await (await route.fetch()).json();
        await route.fulfill({
          json: drop
            ? real.filter((r: { sessionId: string }) => r.sessionId !== 'sess-extra')
            : real,
        });
      });
      await page.goto(`${origin}/sessions?scope=all`);
      await groupOf(page, 'project-b')
        .locator('.bs-sessionrow')
        .filter({ hasText: 'sess-extra' })
        .click();
      await expect(roster(page).locator('.bs-sessions__detail-head')).toHaveCount(1);
      drop = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(
        groupOf(page, 'project-b').locator('.bs-sessionrow').filter({ hasText: 'sess-extra' }),
      ).toHaveCount(0);
      await expect(roster(page)).toBeVisible();
      await expect(roster(page).locator('.bs-sessions__detail-head')).toHaveCount(0);
    });
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
