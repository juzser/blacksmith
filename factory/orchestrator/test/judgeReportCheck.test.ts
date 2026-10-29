import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import {
  checkJudgeReport,
  type JudgeReportInput,
  readJudgeTurns,
  recordJudgeDispatch,
  recordJudgeReport,
} from '../src/judges.js';

// `checkJudgeReport` is everything `recordJudgeReport` checks before it appends,
// so each case runs the same input through both and compares the refusal.
describe('checkJudgeReport', () => {
  let stateDir: string;
  let artifactDir: string;
  const sessionId = 'sess-judge-check';
  const taskId = 'epic-1/task-1';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'bs-jcheck-state-'));
    artifactDir = await mkdtemp(path.join(tmpdir(), 'bs-jcheck-art-'));
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
    await rm(artifactDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
  const opts = () => ({ stateDir });
  const reviewerPath = () => path.join(artifactDir, 'reviewer.json');
  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

  async function dispatch(role = 'reviewer', kind?: 'spec' | 'visual', round = 1) {
    await recordJudgeDispatch(
      {
        taskId,
        role,
        round,
        artifactPath: path.join(artifactDir, `${role}${kind ? `-${kind}` : ''}.json`),
        model: 'claude-opus-5',
        ...(kind ? { kind } : {}),
      },
      ctx(),
      opts(),
    );
  }

  async function logBytes(): Promise<string[]> {
    const files = (await readdir(stateDir)).sort();
    return Promise.all(
      files.map(async (f) => `${f}:${await readFile(path.join(stateDir, f), 'utf8')}`),
    );
  }

  /** The code `recordJudgeReport` throws for this input, and what `checkJudgeReport` throws for it. */
  async function bothCodes(input: JudgeReportInput): Promise<[unknown, unknown]> {
    const turns = await readJudgeTurns(taskId, ctx(), opts());
    const before = await logBytes();
    let checked: unknown = 'no-throw';
    try {
      checkJudgeReport(input, turns, opts());
    } catch (err) {
      checked = (err as { code?: string }).code;
    }
    expect(await logBytes()).toEqual(before);
    let recorded: unknown = 'no-throw';
    try {
      await recordJudgeReport(input, ctx(), opts());
    } catch (err) {
      recorded = (err as { code?: string }).code;
    }
    return [checked, recorded];
  }

  it('throws judges.not-dispatched where recordJudgeReport throws it, and appends nothing', async () => {
    const [checked, recorded] = await bothCodes({ taskId, role: 'reviewer' });
    expect(recorded).toBe('judges.not-dispatched');
    expect(checked).toBe(recorded);
  });

  it('throws the kind refusals recordJudgeReport throws', async () => {
    await dispatch();
    const notAllowed = await bothCodes({ taskId, role: 'reviewer', kind: 'visual' });
    expect(notAllowed).toEqual(['judges.kind-not-allowed', 'judges.kind-not-allowed']);
    const invalid = await bothCodes({ taskId, role: 'uiux', kind: 'nope' as never });
    expect(invalid).toEqual(['judges.invalid-kind', 'judges.invalid-kind']);
  });

  it('throws the wrong-round refusal', async () => {
    await dispatch();
    const [checked, recorded] = await bothCodes({ taskId, role: 'reviewer', round: 2 });
    expect(recorded).toBe('judges.not-dispatched');
    expect(checked).toBe(recorded);
  });

  it('throws judges.not-dispatched for a kindless report against two open uiux turns', async () => {
    await dispatch('uiux', 'spec');
    await dispatch('uiux', 'visual');
    const [checked, recorded] = await bothCodes({
      taskId,
      role: 'uiux',
      noFindings: true,
    });
    expect(recorded).toBe('judges.not-dispatched');
    expect(checked).toBe(recorded);
  });

  it('throws judges.artifact-stale for an artifact older than the dispatch', async () => {
    await writeFile(reviewerPath(), '[]', 'utf8');
    await utimes(reviewerPath(), anHourAgo(), anHourAgo());
    await dispatch();
    const [checked, recorded] = await bothCodes({ taskId, role: 'reviewer' });
    expect(recorded).toBe('judges.artifact-stale');
    expect(checked).toBe(recorded);
  });

  it('throws the artifact refusals readJudgeArtifact throws: missing, unreadable, not a list', async () => {
    await dispatch();
    const missing = await bothCodes({ taskId, role: 'reviewer' });
    expect(missing[1]).toMatch(/^judges\.artifact/);
    expect(missing[0]).toBe(missing[1]);

    await writeFile(reviewerPath(), '{not json', 'utf8');
    const unreadable = await bothCodes({ taskId, role: 'reviewer' });
    expect(unreadable[1]).toMatch(/^judges\.artifact/);
    expect(unreadable[0]).toBe(unreadable[1]);

    await writeFile(reviewerPath(), '42', 'utf8');
    const notList = await bothCodes({ taskId, role: 'reviewer' });
    expect(notList).toEqual(['judges.artifact-not-a-list', 'judges.artifact-not-a-list']);
  });

  it('returns the turn and finding count recordJudgeReport reports, appending nothing', async () => {
    await dispatch();
    await writeFile(reviewerPath(), '[]', 'utf8');
    const turns = await readJudgeTurns(taskId, ctx(), opts());
    const before = await logBytes();
    const checked = checkJudgeReport({ taskId, role: 'reviewer' }, turns, opts());
    expect(await logBytes()).toEqual(before);
    expect(checked).toMatchObject({
      turn: { role: 'reviewer', round: 1, reported: false },
      artifactPath: reviewerPath(),
      findingCount: 0,
    });

    const report = await recordJudgeReport({ taskId, role: 'reviewer' }, ctx(), opts());
    expect(report).toMatchObject({
      round: checked.turn.round,
      artifactPath: checked.artifactPath,
      findingCount: checked.findingCount,
    });
    expect(await logBytes()).not.toEqual(before);
  });

  it('checks an attestation without reading any artifact', async () => {
    await dispatch();
    const turns = await readJudgeTurns(taskId, ctx(), opts());
    expect(
      checkJudgeReport({ taskId, role: 'reviewer', noFindings: true }, turns, opts()),
    ).toMatchObject({
      artifactPath: null,
      findingCount: 0,
    });
  });
});
