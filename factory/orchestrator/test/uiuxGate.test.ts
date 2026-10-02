import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import { recordJudgeDispatch, recordJudgeReport } from '../src/judges.js';
import { checkUiux } from '../src/uiuxGate.js';

describe('uiuxGate.ts checkUiux', () => {
  let stateDir: string;
  let artifactsDir: string;
  const sessionId = 'sess-uiux';
  const taskId = 'epic-1/task-1';

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
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

  async function dispatchUiux(kind: 'spec' | 'visual', artifactPath: string) {
    return recordJudgeDispatch(
      { taskId, role: 'uiux', round: 1, artifactPath, model: 'claude-opus-5', kind },
      ctx(),
      opts(),
    );
  }

  async function reportUiux(kind: 'spec' | 'visual') {
    return recordJudgeReport({ taskId, role: 'uiux', noFindings: true, kind }, ctx(), opts());
  }

  const SCREENSHOTS = [
    { path: 'home-desktop-light.png', viewport: 'desktop', theme: 'light' },
    { path: 'home-desktop-dark.png', viewport: 'desktop', theme: 'dark' },
    { path: 'home-mobile-light.png', viewport: 'mobile', theme: 'light' },
    { path: 'home-mobile-dark.png', viewport: 'mobile', theme: 'dark' },
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
});
