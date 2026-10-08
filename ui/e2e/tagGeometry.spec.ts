import type { Page } from '@playwright/test';
import { stubActiveScope } from './activeScopeStub.js';
import { expect, test } from './harness.js';
import { setTheme, settleForShot, shootElement, VIEWPORTS } from './helpers.js';

// G4 PR-B: the kit has one tag box (ds-review.html `.tag`, 20px tall) and the
// phone timeline row ends in kind tag + 44px chevron column (`.mrow.tlrow`).
// The rows below are synthetic; every name is a fixture.

const PHONE = { width: 375, height: 812 } as const;
const DEMO_HUB_COMPLETED_TASK = 'epic-9/task-1';

function entry(eventId: string, minsAgo: number, over: Record<string, unknown> = {}) {
  return {
    eventId,
    ts: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    eventType: 'user_prompt',
    taskId: null as string | null,
    agentId: null,
    planVersion: 1,
    causalParent: null,
    payload: { prompt: 'Hi' },
    project: 'project-a',
    actor: 'operator',
    sessionId: 'sess-a',
    sessionTitle: 'Session A',
    nearestPromptId: null,
    ...over,
  };
}

// A prompt row (details), a gate row with a status tag and a task link, and a
// system row (no meta, so no chevron), all with short titles.
const ROWS = [
  entry('row-prompt', 1),
  entry('row-gate', 2, {
    eventType: 'commit-check-result',
    taskId: 'epic-a/task-1',
    payload: { certified: true },
  }),
  entry('row-system', 3, { eventType: 'session-started', payload: {} }),
];

async function serveTimeline(page: Page, limit?: string) {
  await page.route('**/api/timeline?*', (route) => {
    const url = new URL(route.request().url());
    if (limit && url.searchParams.get('limit') !== limit) {
      route.continue();
      return;
    }
    route.fulfill({
      json: { entries: ROWS, nextBefore: null, newestId: ROWS[0]?.eventId ?? null },
    });
  });
}

async function serveRuns(page: Page) {
  await page.route('**/api/tasks/*/runs*', (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            eventId: 'run-b',
            ts: '2029-06-01T00:03:00.000Z',
            kind: 'judge-verdict',
            agentRole: 'verifier',
            round: 1,
            tokensTotal: null,
            outcome: 'pass',
          },
        ],
        totals: {
          tokens: null,
          agentTimeMs: null,
          elapsedMs: null,
          startedAt: null,
          endedAt: null,
        },
      },
    }),
  );
}

type Consumer = { name: string; open: (page: Page) => Promise<void>; rows: string };
const CONSUMERS: Consumer[] = [
  {
    name: 'activity',
    rows: '.bs-timeline-row',
    open: async (page) => {
      await stubActiveScope(page, [], {
        factorySessions: [{ storeId: 'home', sessionId: 'sess-a' }],
      });
      await serveTimeline(page);
      await page.goto('/activity');
    },
  },
  {
    name: 'home',
    rows: '.bs-home__recent-activity > .bs-timeline-row',
    open: async (page) => {
      await serveTimeline(page, '8');
      await page.goto('/overview');
    },
  },
  {
    name: 'task-history',
    rows: '.bs-run-history .bs-timeline-row',
    open: async (page) => {
      await serveRuns(page);
      await page.goto(`/tasks/${encodeURIComponent(DEMO_HUB_COMPLETED_TASK)}`);
      await page.getByRole('tab', { name: 'History' }).click();
    },
  },
];

async function right(loc: ReturnType<Page['locator']>) {
  const box = await loc.boundingBox();
  return (box?.x ?? 0) + (box?.width ?? 0);
}

test.describe('Kit tag height', () => {
  for (const [name, viewport] of [
    ['desktop', VIEWPORTS.desktop],
    ['375', PHONE],
  ] as const) {
    test(`${name}: a size=sm tag and an EventKindTag are both 20px tall`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await serveTimeline(page);
      await stubActiveScope(page, [], {
        factorySessions: [{ storeId: 'home', sessionId: 'sess-a' }],
      });
      await page.goto('/activity');
      const kindTag = page.locator('.bs-event-kind-tag').first();
      const smTag = page.locator('.bs-timeline-row__status.bs-tag--sm').first();
      await expect(kindTag).toBeVisible();
      await expect(smTag).toBeVisible();
      expect((await kindTag.boundingBox())?.height).toBe(20);
      expect((await smTag.boundingBox())?.height).toBe(20);
    });
  }
});

test.describe('Phone timeline row: tag at the right end, fixed chevron column', () => {
  for (const c of CONSUMERS) {
    test(`375 ${c.name}: the last tag ends at the head's right edge`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await c.open(page);
      const rows = page.locator(c.rows);
      await expect(rows.first()).toBeVisible();
      const n = Math.min(await rows.count(), 3);
      for (let i = 0; i < n; i++) {
        const head = rows.nth(i).locator('.bs-timeline-row__head');
        const tags = head.locator('.bs-event-kind-tag, .bs-timeline-row__status');
        let tagRight = 0;
        for (let t = 0; t < (await tags.count()); t++) {
          tagRight = Math.max(tagRight, await right(tags.nth(t)));
        }
        const headRight = await right(head);
        console.log(`B2 ${c.name} row ${i}: tag right ${tagRight}, head right ${headRight}`);
        expect(Math.abs(tagRight - headRight)).toBeLessThanOrEqual(1);
      }
    });
  }

  for (const c of CONSUMERS.filter((x) => x.name !== 'task-history')) {
    test(`375 ${c.name}: a row without a chevron ends where a row with one ends`, async ({
      page,
    }) => {
      await page.setViewportSize(PHONE);
      await c.open(page);
      const rows = page.locator(c.rows);
      await expect(rows.nth(2)).toBeVisible();
      // row 0 has details (chevron); row 2 is a System row with none.
      await expect(rows.nth(0).getByRole('button', { name: 'Show details' })).toHaveCount(1);
      await expect(rows.nth(2).getByRole('button', { name: 'Show details' })).toHaveCount(0);
      const a = rows.nth(0).locator('.bs-timeline-row__head .bs-event-kind-tag');
      const b = rows.nth(2).locator('.bs-timeline-row__head .bs-event-kind-tag');
      console.log(
        `B3 ${c.name}: tag right with chevron ${await right(a)}, without ${await right(b)}`,
      );
      expect(Math.abs((await right(a)) - (await right(b)))).toBeLessThanOrEqual(1);
      const ta = rows.nth(0).locator('.bs-timeline-row__ts--meta');
      const tb = rows.nth(2).locator('.bs-timeline-row__ts--meta');
      console.log(
        `B3 ${c.name}: ts right with chevron ${await right(ta)}, without ${await right(tb)}`,
      );
    });
  }

  for (const c of CONSUMERS) {
    test(`screenshot timeline-row-tag-end-${c.name}-phone-light`, async ({ page }) => {
      await setTheme(page, 'light');
      await page.setViewportSize(PHONE);
      await c.open(page);
      const rows = page.locator(c.rows);
      await settleForShot(page, rows.first());
      await shootElement(
        page.locator(c.rows).first().locator('xpath=..'),
        `timeline-row-tag-end-${c.name}-phone-light`,
      );
    });
  }
});
