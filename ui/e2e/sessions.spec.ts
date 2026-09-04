import { expect, test } from './harness.js';
import { setTheme, settleForShot, shoot, VIEWPORTS } from './helpers.js';

// The canvas half of the Sessions page. Layout arithmetic (band order, band
// height, which edge animates) is asserted in ui/test/sessionsFlow.test.ts,
// which runs everywhere; this file makes the same claims against the real
// rendered boxes, which only a browser can do.
test.describe('Sessions', () => {
  test('renders running sessions as a canvas with an sr-only table alternative', async ({
    page,
  }) => {
    await page.goto('/sessions');
    await expect(page.locator('h1')).toHaveText('Sessions');
    await expect(page.locator('a.skip-link')).toHaveText('Skip to content');
    await expect(page.locator('.session-node').first()).toBeVisible();
    // A DOM graph carries no text alternative for its order, nor for which
    // agent hangs off which run — same pattern as Roadmap and Flow.
    await expect(page.locator('table.sr-only')).toBeAttached();
  });

  test('draws the agents a run dispatched, in their own column', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('.agent-node').first()).toBeVisible();
    // The two columns are the whole point of the layout: a session on the
    // left, everything it dispatched to the right of it.
    const sessionX = await page
      .locator('.session-node')
      .first()
      .evaluate((el) => el.getBoundingClientRect().x);
    const agentX = await page
      .locator('.agent-node')
      .first()
      .evaluate((el) => el.getBoundingClientRect().x);
    expect(agentX).toBeGreaterThan(sessionX);
  });

  test('tiles the bands across the canvas it measured, not down one column', async ({ page }) => {
    // The fixture has two sessions, which the layout correctly keeps in ONE
    // column — two bands fit at 1.46 zoom stacked and 0.69 tiled, and tiling
    // them would make the text smaller. So the tiling path has to be driven
    // with a payload that needs it: eight bands stacked is 0.59 and unreadable,
    // which is the squint this page was built to remove.
    //
    // Asserted in a browser rather than against sessionsFlowNodes() because the
    // failure it guards is not arithmetic. The column count is chosen from the
    // canvas's measured box, so the first correct layout necessarily arrives
    // AFTER the canvas mounts — and Vue Flow syncs `:nodes` through a *pausable*
    // watcher that drops a prop change landing in the same flush as its own
    // initial store sync. Binding the corrected array was not enough: the store
    // kept the pre-measurement positions and drew one tall column forever.
    await page.route('**/api/overview*', async (route) => {
      const payload = await (await route.fetch()).json();
      payload.runningSessions = Array.from({ length: 8 }, (_, i) => ({
        sessionId: `sess-tiling-${i}`,
        startedAt: '2026-08-13T10:00:00.000Z',
        lastEventAt: `2026-08-13T11:${String(50 - i).padStart(2, '0')}:00.000Z`,
        eventCount: 3,
        liveAgentCount: 0,
        lastEventType: 'task-created',
        projects: ['black-smith'],
      }));
      payload.liveAgentEntries = [];
      await route.fulfill({ json: payload });
    });
    await page.goto('/sessions');
    await expect(page.locator('.session-node')).toHaveCount(8);
    const xs = await page
      .locator('.session-node')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
    expect(new Set(xs).size, `all session cards share an x: ${xs.join(', ')}`).toBeGreaterThan(1);
  });

  test('draws the whole graph inside the canvas, with nothing to drag to', async ({ page }) => {
    // The request behind this layout was "reduce the space you have to drag
    // through to see it". That is one measurable claim:
    // after fit-view-on-init, every node the canvas drew is already inside the
    // canvas box. A layout that spends the wrong axis fails this by putting
    // cards below the fold, which no unit test on positions can see.
    await page.goto('/sessions');
    await expect(page.locator('.session-node').first()).toBeVisible();
    const canvas = await page.locator('.sessions-canvas').boundingBox();
    if (!canvas) throw new Error('the canvas the nodes must fit inside has no box');
    const nodes = await page.locator('.session-node, .agent-node').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }),
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const [i, n] of nodes.entries()) {
      // Half a pixel of slack: Vue Flow's transform is fractional and a node
      // flush against the edge rounds either way.
      expect(n.x, `node ${i} starts left of the canvas`).toBeGreaterThanOrEqual(canvas.x - 0.5);
      expect(n.y, `node ${i} starts above the canvas`).toBeGreaterThanOrEqual(canvas.y - 0.5);
      expect(n.right, `node ${i} runs past the right edge`).toBeLessThanOrEqual(
        canvas.x + canvas.width + 0.5,
      );
      expect(n.bottom, `node ${i} runs past the bottom edge`).toBeLessThanOrEqual(
        canvas.y + canvas.height + 0.5,
      );
    }
  });

  test('re-measures the canvas when it comes back from an idle factory', async ({ page }) => {
    // `measured` gates the flow's mount, so it has to mean "canvasSize describes
    // the canvas that is on screen right now". The canvas unmounts whenever the
    // last run finishes — `groups.length === 0` hands the page to EmptyState —
    // and comes back when the next run starts. If the window changed size in
    // between, the measurement taken before the gap is a measurement of a
    // different box, and the flow would mount against it: Vue Flow's pausable
    // prop watcher drops the correction that arrives a tick later, so the wrong
    // column count is not transient, it is permanent until the next resize.
    let sessionCount = 8;
    await page.route('**/api/overview*', async (route) => {
      const payload = await (await route.fetch()).json();
      payload.runningSessions = Array.from({ length: sessionCount }, (_, i) => ({
        sessionId: `sess-remount-${i}`,
        startedAt: '2026-08-13T10:00:00.000Z',
        lastEventAt: `2026-08-13T11:${String(50 - i).padStart(2, '0')}:00.000Z`,
        eventCount: 3,
        liveAgentCount: 0,
        lastEventType: 'task-created',
        projects: ['black-smith'],
      }));
      payload.liveAgentEntries = [];
      await route.fulfill({ json: payload });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/sessions');
    await expect(page.locator('.session-node')).toHaveCount(8);

    // The factory goes idle and the canvas leaves the page entirely.
    sessionCount = 0;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.sessions-canvas')).toHaveCount(0);

    // The operator narrows the window while there is nothing to draw, so this
    // width is one the canvas has never been measured at.
    await page.setViewportSize({ width: 390, height: 844 });

    // A run starts again.
    sessionCount = 8;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.session-node')).toHaveCount(8);

    // Same claim as the fit test, made after a remount: a layout chosen for the
    // old 1280px box needs columns this one cannot show, and Vue Flow will not
    // zoom out past 0.5 to rescue it — it crops, and the cards land outside.
    const canvas = await page.locator('.sessions-canvas').boundingBox();
    if (!canvas) throw new Error('the canvas the nodes must fit inside has no box');
    const nodes = await page
      .locator('.session-node, .agent-node')
      .evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, right: r.right })),
      );
    for (const [i, n] of nodes.entries()) {
      expect(
        n.x,
        `node ${i} was drawn left of the canvas it came back into`,
      ).toBeGreaterThanOrEqual(canvas.x - 0.5);
      expect(n.right, `node ${i} was drawn past the canvas it came back into`).toBeLessThanOrEqual(
        canvas.x + canvas.width + 0.5,
      );
    }
  });

  test('never overlaps two rendered nodes', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('.session-node').first()).toBeVisible();
    const boxes = await page
      .locator('.session-node, .agent-node')
      .evaluateAll((els) =>
        els
          .map((el) => el.getBoundingClientRect())
          .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
      );
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (!a || !b) continue;
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps, `node ${i} overlaps node ${j}`).toBe(false);
      }
    }
  });

  test('exposes the project switcher it scopes its fetch by', async ({ page }) => {
    // The page passes useProjectContext()'s project into fetchOverview and
    // renders a "<project> · Sessions" breadcrumb, so /sessions?project=x is a
    // reachable state (bookmark, shared link). Without the route in App.vue's
    // SCOPABLE_ROUTES the switcher is hidden and that filter cannot be cleared.
    await page.goto('/sessions');
    await expect(page.locator('h1')).toHaveText('Sessions');
    // Exact: Vue Flow labels every edge "Edge from … to …", which a substring
    // match on "Project" would not hit but a loose one does once ids contain it.
    await expect(page.getByLabel('Project', { exact: true })).toBeVisible();
  });

  test('never reports an idle factory when the API is what failed', async ({ page }) => {
    // The two states are indistinguishable from the operator's seat unless the
    // page keeps them apart: a failed FIRST fetch leaves `data` null and
    // `loading` false, which is the same shape as a factory with nothing
    // running. Saying "No sessions are running" there is a claim about the
    // factory made from evidence that never arrived.
    await page.route('**/api/overview*', (route) => route.abort('failed'));
    await page.goto('/sessions');
    await expect(page.locator('h1')).toHaveText('Sessions');
    await expect(page.locator('.ds-banner')).toBeVisible();
    await expect(page.getByText('No sessions are running')).toHaveCount(0);
    await expect(page.locator('.sessions-canvas')).toHaveCount(0);
  });

  // Same 5s poll as Overview, same omission, worse ending: here a cleared
  // `error` with `data` still null leaves the banner gone, the skeleton gone
  // (`loading` went false on the first failure), and `canClaimEmpty` refusing
  // to draw the empty state -- so the page under an outage is blank for the
  // length of every poll's flight and red only in the gaps between them. The
  // sibling rule is stated inside this very `load()`: `graphNow` is "only
  // advanced on a SUCCESSFUL fetch". The error above it was not (D-240).
  test('a failing refresh never takes the error banner off the screen', async ({ page }) => {
    let served = 0;
    await page.route('**/api/overview*', async (route) => {
      served += 1;
      if (served === 1) {
        await route.abort('failed');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      await route.abort('failed').catch(() => {});
    });
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    const refetch = page.waitForRequest('**/api/overview*');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await refetch;

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('offers the same viewport controls as the other canvases', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('.session-node').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fit view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
  });

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of ['light', 'dark'] as const) {
      test(`screenshot ${vpName}/${theme}`, async ({ page }) => {
        await setTheme(page, theme);
        await page.setViewportSize(viewport);
        await page.goto('/sessions');
        await expect(page.locator('h1')).toHaveText('Sessions');
        await settleForShot(page, page.locator('.session-node').first());
        await shoot(page, `sessions-${vpName}-${theme}`);
      });
    }
  }
});
