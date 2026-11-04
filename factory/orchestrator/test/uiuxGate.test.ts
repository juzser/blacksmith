import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import { recordJudgeDispatch, recordJudgeReport } from '../src/judges.js';
import { checkUiux, screenshotSetComplete, shotWidthIssues } from '../src/uiuxGate.js';

describe('uiuxGate.ts checkUiux', () => {
  let stateDir: string;
  let artifactsDir: string;
  const sessionId = 'sess-uiux';
  const taskId = 'epic-1/task-1';

  const ctx = () => ({
    sessionId,
    planVersion: 1,
    causalParent: `${sessionId}#0`,
    actor: 'operator',
  });
  const opts = () => ({ stateDir });

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-uiuxgate-'));
    artifactsDir = await mkdtemp(path.join(tmpdir(), 'smith-uiuxgate-art-'));
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(artifactsDir, { recursive: true, force: true });
  });

  async function dispatchUiux(kind: 'spec' | 'visual', artifactPath: string, round = 1) {
    return recordJudgeDispatch(
      { taskId, role: 'uiux', round, artifactPath, model: 'claude-opus-5', kind },
      ctx(),
      opts(),
    );
  }

  async function reportUiux(kind: 'spec' | 'visual', round?: number) {
    return recordJudgeReport(
      { taskId, role: 'uiux', noFindings: true, kind, ...(round === undefined ? {} : { round }) },
      ctx(),
      opts(),
    );
  }

  const D = { inner_width: 1280, client_width: 1280 };
  const M = { inner_width: 390, client_width: 390 };
  const SCREENSHOTS = [
    { path: 'home-desktop-light.png', viewport: 'desktop', theme: 'light', ...D },
    { path: 'home-desktop-dark.png', viewport: 'desktop', theme: 'dark', ...D },
    { path: 'home-mobile-light.png', viewport: 'mobile', theme: 'light', ...M },
    { path: 'home-mobile-dark.png', viewport: 'mobile', theme: 'dark', ...M },
  ];

  async function writeScreenshotsToDisk(entries = SCREENSHOTS) {
    const home = path.join(artifactsDir, taskId);
    await mkdir(home, { recursive: true });
    for (const s of entries) await writeFile(path.join(home, s.path), 'png-bytes', 'utf8');
  }

  /**
   * Stands in for what `results record --worktree <dir>` writes onto
   * `artifact-check-result` (gate.ts): the sha freshness is proven against,
   * plus the screenshot set it found among the Result's artifacts. Written
   * directly here so this suite can test `checkUiux` against the shape of
   * that payload without re-deriving gate.ts's own git/recordTaskResult path.
   */
  async function recordTester(head: string, entries = SCREENSHOTS) {
    return appendEvent(
      {
        session_id: sessionId,
        actor: 'tester',
        event_type: 'artifact-check-result',
        task_id: taskId,
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload: {
          ok: true,
          checked: entries.length,
          home: artifactsDir,
          issues: [],
          head,
          screenshots: entries,
        },
      },
      opts(),
    );
  }

  it('blocks uiux-spec-missing when no closed uiux spec turn exists', async () => {
    const result = await checkUiux({ taskId, artifactsDir }, ctx(), opts());
    expect(result).toEqual({ outcome: 'blocked', reason: 'uiux-spec-missing' });
  });

  it('blocks screenshots-missing when a combo is absent or a file is missing on disk', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    // No tester record at all yet.
    const noRecord = await checkUiux({ taskId, artifactsDir }, ctx(), opts());
    expect(noRecord).toEqual({ outcome: 'blocked', reason: 'screenshots-missing' });

    // Tester records, but never writes the files to disk.
    await recordTester('sha-1');
    const missingOnDisk = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(missingOnDisk).toEqual({ outcome: 'blocked', reason: 'screenshots-missing' });
  });

  it('blocks screenshots-missing on the real crop (inner 500, client 485) and names the shot', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    const cropped = SCREENSHOTS.map((s) =>
      s.path === 'home-mobile-dark.png' ? { ...s, inner_width: 500, client_width: 485 } : s,
    );
    await writeScreenshotsToDisk(cropped);
    await recordTester('sha-1', cropped);
    const result = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'screenshots-missing',
      invalidShots: [
        {
          path: 'home-mobile-dark.png',
          viewport: 'mobile',
          inner_width: 500,
          client_width: 485,
          why: 'width-mismatch',
          hint: expect.stringContaining('scrollbar'),
        },
      ],
    });
  });

  it('blocks mobile-overflow when a mobile page is wider than its viewport (inner 600, client 390)', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    const wide = SCREENSHOTS.map((s) =>
      s.path === 'home-mobile-light.png' ? { ...s, inner_width: 600, client_width: 390 } : s,
    );
    await writeScreenshotsToDisk(wide);
    await recordTester('sha-1', wide);
    await dispatchUiux('visual', path.join(artifactsDir, 'visual.json'));
    await reportUiux('visual');
    const result = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'mobile-overflow',
      overflow: [
        { path: 'home-mobile-light.png', viewport: 'mobile', inner_width: 600, client_width: 390 },
      ],
    });
  });

  it.each([
    ['980/980 (no meta viewport under isMobile)', 980, 980],
    ['780/780 (initial-scale=0.5)', 780, 780],
    ['1200/980 (no meta viewport and the page overflows)', 1200, 980],
  ])('names the meta viewport when a narrow shot measures %s', async (_n, inner, width) => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    const unscaled = SCREENSHOTS.map((s) =>
      s.path === 'home-mobile-dark.png' ? { ...s, inner_width: inner, client_width: width } : s,
    );
    await writeScreenshotsToDisk(unscaled);
    await recordTester('sha-1', unscaled);
    const result = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(result).toEqual({
      outcome: 'blocked',
      reason: 'screenshots-missing',
      invalidShots: [
        {
          path: 'home-mobile-dark.png',
          viewport: 'mobile',
          inner_width: inner,
          client_width: width,
          why: 'page-not-mobile-scaled',
          hint: expect.stringContaining(
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
          ),
        },
      ],
    });
  });

  it.each([
    ['mobile with a scrollbar (client 375)', 'mobile', 390, 375, true],
    ['mobile at the crop (inner 500, client 485)', 'mobile', 500, 485, false],
    ['mobile far narrower than 390', 'mobile', 300, 300, false],
    ['desktop inner 768 with a 15px scrollbar', 'desktop', 768, 753, true],
    ['desktop inner 767', 'desktop', 767, 767, false],
  ])('shot width rule: %s', (_n, viewport, inner, client, ok) => {
    const shot = { path: `x-${viewport}-light.png`, viewport, theme: 'light' };
    const issues = shotWidthIssues([{ ...shot, inner_width: inner, client_width: client }]);
    expect(issues.length === 0).toBe(ok);
  });

  it('screenshotSetComplete refuses a shot with no recorded width, and a narrow shot whose widths disagree', async () => {
    await writeScreenshotsToDisk();
    expect(screenshotSetComplete(taskId, SCREENSHOTS, artifactsDir)).toBe(true);
    const noRecord = SCREENSHOTS.map(({ path: p, viewport, theme }) => ({
      path: p,
      viewport,
      theme,
    }));
    expect(screenshotSetComplete(taskId, noRecord, artifactsDir)).toBe(false);
    const skewed = SCREENSHOTS.map((s) =>
      s.viewport === 'mobile' ? { ...s, client_width: 500 } : s,
    );
    expect(screenshotSetComplete(taskId, skewed, artifactsDir)).toBe(false);
  });

  it('blocks screenshots-stale when the latest tester head does not match the gate head', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    await writeScreenshotsToDisk();
    await recordTester('sha-old');

    const result = await checkUiux({ taskId, head: 'sha-new', artifactsDir }, ctx(), opts());
    expect(result).toEqual({ outcome: 'blocked', reason: 'screenshots-stale' });
  });

  it('blocks uiux-visual-missing when no closed visual turn exists, or one dispatched before the tester record', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    await writeScreenshotsToDisk();
    await recordTester('sha-1');

    const noVisual = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(noVisual).toEqual({ outcome: 'blocked', reason: 'uiux-visual-missing' });
  });

  it('a visual turn dispatched before the tester record does not count', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    // Visual turn dispatched and closed BEFORE the tester's record.
    await dispatchUiux('visual', path.join(artifactsDir, 'visual.json'));
    await reportUiux('visual');
    await writeScreenshotsToDisk();
    await recordTester('sha-1');

    const result = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(result).toEqual({ outcome: 'blocked', reason: 'uiux-visual-missing' });
  });

  it('passes a fully fresh set: spec closed, screenshots complete and fresh, visual closed after the record', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    await writeScreenshotsToDisk();
    await recordTester('sha-1');
    await dispatchUiux('visual', path.join(artifactsDir, 'visual.json'));
    await reportUiux('visual');

    const result = await checkUiux({ taskId, head: 'sha-1', artifactsDir }, ctx(), opts());
    expect(result).toEqual({ outcome: 'pass' });
  });

  it('passes when a later visual round, dispatched and reported after a newer tester record, supersedes round 1', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    await writeScreenshotsToDisk();
    await recordTester('sha-1');
    await dispatchUiux('visual', path.join(artifactsDir, 'visual-r1.json'), 1);
    await reportUiux('visual', 1);
    // The tester re-records; round 1 now predates the latest record.
    await recordTester('sha-2');
    await dispatchUiux('visual', path.join(artifactsDir, 'visual-r2.json'), 2);
    await reportUiux('visual', 2);

    const result = await checkUiux({ taskId, head: 'sha-2', artifactsDir }, ctx(), opts());
    expect(result).toEqual({ outcome: 'pass' });
  });

  it('blocks uiux-visual-missing when a later visual round is dispatched but not yet reported', async () => {
    await dispatchUiux('spec', path.join(artifactsDir, 'spec.json'));
    await reportUiux('spec');
    await writeScreenshotsToDisk();
    await recordTester('sha-1');
    await dispatchUiux('visual', path.join(artifactsDir, 'visual-r1.json'), 1);
    await reportUiux('visual', 1);
    await recordTester('sha-2');
    await dispatchUiux('visual', path.join(artifactsDir, 'visual-r2.json'), 2);

    const result = await checkUiux({ taskId, head: 'sha-2', artifactsDir }, ctx(), opts());
    expect(result).toEqual({ outcome: 'blocked', reason: 'uiux-visual-missing' });
  });
});
