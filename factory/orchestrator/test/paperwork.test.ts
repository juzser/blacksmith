import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEvents } from '../src/events.js';
import { type GateInput, recordTaskResult, runGate } from '../src/gate.js';
import {
  checkPaperwork,
  graderStage,
  type PaperworkInput,
  type PaperworkResult,
  type PaperworkRole,
  resolveTaxonomyAndSchemas,
  SCREENSHOT_RE,
  STAGES_FOR_ROLE,
  screenshotsFromArtifacts,
} from '../src/paperwork.js';
import { checkUiux } from '../src/uiuxGate.js';
import {
  artifactMissing,
  artifactOutsideHome,
  buildLadder,
  clean,
  createWorld,
  depsMissing,
  earlyHandBack,
  type FixtureBuilder,
  graderDead,
  graderFailed,
  graderMet,
  graderOutsideStructured,
  judgesOutstanding,
  OPEN_JUDGE,
  PARITY_CASES,
  SHOT_NAMES,
  screenshotMisnamed,
  shapeError,
  stampedResult,
  testerResult,
  uiuxVisualMissing,
  uiuxVisualOpen,
  uncommitted,
  unstamped,
  type World,
  withSpecTurn,
} from './helpers/paperworkFixtures.js';

describe('gate characterization: the lineage runGate writes (pinned before the refactor)', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  /** The gate's own events after the fixture setup, with machine-specific strings made stable. */
  async function lineageOf(build: FixtureBuilder) {
    const input = await build(w);
    const before = (await readEvents(w.sessionId, w.opts())).length;
    const outcome = await runGate(input, w.ctx(), w.opts());
    const events = (await readEvents(w.sessionId, w.opts())).slice(before);
    const stable = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value)
          .replace(/\/[^"]*?bs-paperwork-(state|wt|art|else)-[A-Za-z0-9]+/g, '<$1>')
          .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
          .replace(/"(duration_ms|elapsed_ms)":\d+/g, '"$1":0'),
      );
    return {
      outcome: outcome.outcome,
      reason: outcome.outcome === 'blocked' ? outcome.reason : null,
      events: events.map((e) => ({
        event_type: e.record.event_type,
        payload: stable(e.record.payload),
      })),
    };
  }

  it('clean fixture', async () => {
    expect(await lineageOf(clean)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": "<sha>",
              "branch": "smith/epic-1/task-1",
              "certified": true,
              "commits_ahead": 1,
              "dirty": [],
              "head": "<sha>",
              "reason": null,
            },
          },
          {
            "event_type": "deps-check-result",
            "payload": {
              "declares_dependencies": true,
              "detail": "1 dependencies declared and node_modules/.bin is present.",
              "ok": true,
            },
          },
          {
            "event_type": "budget-check-result",
            "payload": {
              "overruns": [],
              "status": "not-declared",
              "tokensUsed": 150,
            },
          },
          {
            "event_type": "testgate-result",
            "payload": {
              "pass": true,
              "results": [
                {
                  "exitCode": 0,
                  "lock_wait_ms": 0,
                  "name": "noop",
                  "pass": true,
                  "tail": "",
                },
              ],
            },
          },
          {
            "event_type": "severity-decisions",
            "payload": {
              "decisions": [],
              "lesson_ids_escalating": [],
              "lessons_escalating": 0,
              "lessons_loaded": 0,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "pass",
              "reason": null,
            },
          },
        ],
        "outcome": "pass",
        "reason": null,
      }
    `);
  });

  it('schema-invalid fixture', async () => {
    expect(await lineageOf(unstamped)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [
                {
                  "message": "must have required property 'task_id'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'token_usage'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'agent'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'provider'",
                  "path": "/",
                },
                {
                  "message": "must have required property 'model_tier'",
                  "path": "/",
                },
              ],
              "valid": false,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "schema-invalid",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "schema-invalid",
      }
    `);
  });

  it('artifacts-missing fixture', async () => {
    expect(await lineageOf(artifactMissing)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [
                {
                  "path": "never-written.txt",
                  "type": "log",
                },
              ],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 1,
              "home": "<art>/epic-1/task-1",
              "issues": [
                {
                  "declared": "never-written.txt",
                  "problem": "missing",
                  "resolved": "<art>/epic-1/task-1/never-written.txt",
                },
              ],
              "ok": false,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "artifacts-missing",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "artifacts-missing",
      }
    `);
  });

  it('not-committed fixture', async () => {
    expect(await lineageOf(uncommitted)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": null,
              "branch": "smith/epic-1/task-1",
              "certified": false,
              "commits_ahead": null,
              "dirty": [
                "src.ts",
              ],
              "head": "<sha>",
              "reason": "uncommitted-work",
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "not-committed",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "not-committed",
      }
    `);
  });

  it('grader-invalid fixture', async () => {
    expect(await lineageOf(graderOutsideStructured)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": "<sha>",
              "branch": "smith/epic-1/task-1",
              "certified": true,
              "commits_ahead": 1,
              "dirty": [],
              "head": "<sha>",
              "reason": null,
            },
          },
          {
            "event_type": "deps-check-result",
            "payload": {
              "declares_dependencies": true,
              "detail": "1 dependencies declared and node_modules/.bin is present.",
              "ok": true,
            },
          },
          {
            "event_type": "grader-verdict",
            "payload": {
              "errors": [
                {
                  "message": "grader verdict must be at .structured_output (round, criteria, overall), per the grader Output contract",
                  "path": "/structured_output",
                },
              ],
              "failed_criteria": [],
              "overall": null,
              "round": null,
              "run_status": null,
              "verdict": "invalid",
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "grader-invalid",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "grader-invalid",
      }
    `);
  });

  it('screenshots-missing fixture', async () => {
    expect(await lineageOf(screenshotMisnamed)).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "event_type": "schema-check-result",
            "payload": {
              "errors": [],
              "valid": true,
            },
          },
          {
            "event_type": "task-result-recorded",
            "payload": {
              "agent": "coder",
              "artifacts": [],
              "model_tier": "mid",
              "provider": "claude",
              "run_status": "done",
              "structured_output": {},
              "task_id": "epic-1/task-1",
              "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
              },
            },
          },
          {
            "event_type": "artifact-check-result",
            "payload": {
              "checked": 0,
              "home": "<art>/epic-1/task-1",
              "issues": [],
              "ok": true,
            },
          },
          {
            "event_type": "commit-check-result",
            "payload": {
              "base_ref": "main",
              "base_sha": "<sha>",
              "branch": "smith/epic-1/task-1",
              "certified": true,
              "commits_ahead": 1,
              "dirty": [],
              "head": "<sha>",
              "reason": null,
            },
          },
          {
            "event_type": "deps-check-result",
            "payload": {
              "declares_dependencies": true,
              "detail": "1 dependencies declared and node_modules/.bin is present.",
              "ok": true,
            },
          },
          {
            "event_type": "gate-outcome",
            "payload": {
              "outcome": "blocked",
              "reason": "screenshots-missing",
            },
          },
        ],
        "outcome": "blocked",
        "reason": "screenshots-missing",
      }
    `);
  });
});

/** The preflight input that mirrors a gate input, for one role. */
function paperworkInput(g: GateInput, as: PaperworkRole): PaperworkInput {
  return {
    as,
    taskId: g.taskId,
    result: g.result,
    worktreeDir: g.worktreeDir,
    ...(g.baseRef === undefined ? {} : { baseRef: g.baseRef }),
    ...(g.artifactsDir === undefined ? {} : { artifactsDir: g.artifactsDir }),
    ...(g.graderVerdict === undefined ? {} : { graderVerdict: g.graderVerdict }),
    ...(g.uiAffecting === undefined ? {} : { uiAffecting: g.uiAffecting }),
  };
}

function stageOf(res: PaperworkResult, stage: string) {
  return res.problems.find((p) => p.stage === stage);
}

describe('paperwork parity with the gate', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  it.each(PARITY_CASES)(
    '$name: the gate and the preflight say the same',
    async ({ build, reason }) => {
      const input = await build(w);
      const pre = await checkPaperwork(paperworkInput(input, 'gate'), w.ctx(), w.opts());
      const gate = await runGate(input, w.ctx(), w.opts());
      if (reason === null) {
        expect(gate.outcome).toBe('pass');
        expect(pre).toMatchObject({ outcome: 'pass', as: 'gate', problems: [] });
        expect(pre.reason).toBeUndefined();
      } else {
        expect(gate).toMatchObject({ outcome: 'blocked', reason });
        expect(pre).toMatchObject({ outcome: 'blocked', reason, as: 'gate' });
      }
    },
  );

  it('a well-formed grader fail and a dead grader file block the gate, never the preflight', async () => {
    const failed = await graderFailed(w);
    expect(await runGate(failed, w.ctx(), w.opts())).toMatchObject({
      outcome: 'blocked',
      reason: 'grader-fail',
    });
    for (const as of ['gate', 'grader'] as const) {
      const pre = await checkPaperwork(paperworkInput(failed, as), w.ctx(), w.opts());
      expect(pre).toMatchObject({ outcome: 'pass', verdicts: { grader: 'fail' } });
    }

    const dead = await graderDead(w);
    expect(await runGate(dead, w.ctx(), w.opts())).toMatchObject({
      outcome: 'blocked',
      reason: 'grader-fail',
    });
    for (const as of ['gate', 'grader'] as const) {
      const pre = await checkPaperwork(paperworkInput(dead, as), w.ctx(), w.opts());
      expect(pre).toMatchObject({ outcome: 'pass', verdicts: { grader: 'not-graded' } });
    }

    const met = await graderMet(w);
    const pre = await checkPaperwork(paperworkInput(met, 'grader'), w.ctx(), w.opts());
    expect(pre).toMatchObject({ outcome: 'pass', verdicts: { grader: 'met' } });
  });
});

describe('paperwork role parity', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  it.each([
    ['unstamped envelope', unstamped, 'schema-invalid'],
    ['shape error', shapeError, 'schema-invalid'],
    ['missing artifact', artifactMissing, 'artifacts-missing'],
    ['artifact outside the home', artifactOutsideHome, 'artifacts-missing'],
    ['uncommitted work', uncommitted, 'not-committed'],
    ['deps missing', depsMissing, 'deps-missing'],
  ] as [string, FixtureBuilder, string][])(
    'coder: %s returns the gate reason',
    async (_n, build, reason) => {
      const input = await build(w);
      const pre = await checkPaperwork(paperworkInput(input, 'coder'), w.ctx(), w.opts());
      const gate = await runGate(input, w.ctx(), w.opts());
      expect(gate).toMatchObject({ outcome: 'blocked', reason });
      expect(pre).toMatchObject({ outcome: 'blocked', reason, as: 'coder' });
    },
  );

  /** The tester's hand-back on a session that already holds the uiux spec turn. */
  async function testerCase(names: readonly string[], onDisk: readonly string[] = names) {
    await withSpecTurn(w);
    const result = await testerResult(w, names, onDisk);
    const recorded = await recordTaskResult(
      { taskId: w.taskId, result, artifactsDir: w.artifactsDir, worktreeDir: w.worktreeDir },
      w.ctx(),
      w.opts(),
    );
    const head = w.git(['rev-parse', 'HEAD']);
    const uiux = await checkUiux(
      { taskId: w.taskId, head, artifactsDir: w.artifactsDir },
      w.ctx(),
      w.opts(),
    );
    const pre = await checkPaperwork(
      {
        as: 'tester',
        taskId: w.taskId,
        result,
        artifactsDir: w.artifactsDir,
        uiAffecting: true,
      },
      w.ctx(),
      w.opts(),
    );
    return { recorded, uiux, pre };
  }

  it('tester: a misnamed screenshot is screenshots-missing in both', async () => {
    const { uiux, pre } = await testerCase(['home.png']);
    expect(uiux).toEqual({ outcome: 'blocked', reason: 'screenshots-missing' });
    expect(pre).toMatchObject({ outcome: 'blocked', reason: 'screenshots-missing', as: 'tester' });
  });

  it('tester: a missing combo is screenshots-missing in both', async () => {
    const { uiux, pre } = await testerCase(SHOT_NAMES.slice(0, 3));
    expect(uiux).toEqual({ outcome: 'blocked', reason: 'screenshots-missing' });
    expect(pre).toMatchObject({ outcome: 'blocked', reason: 'screenshots-missing' });
  });

  it('tester: a screenshot declared but not on disk is screenshots-missing in the uiux stage and a problem in the preflight', async () => {
    const { recorded, uiux, pre } = await testerCase(SHOT_NAMES, SHOT_NAMES.slice(0, 3));
    expect(recorded).toMatchObject({ outcome: 'blocked', reason: 'artifacts-missing' });
    expect(uiux).toEqual({ outcome: 'blocked', reason: 'screenshots-missing' });
    // The artifacts stage comes first in the tester's set and says the same file is missing;
    // the screenshots stage still reports the set as incomplete.
    expect(pre.reason).toBe('artifacts-missing');
    expect(pre.problems.map((p) => p.reason)).toEqual(['artifacts-missing', 'screenshots-missing']);
  });

  it('tester: a clean tester result passes in both', async () => {
    const { recorded, uiux, pre } = await testerCase(SHOT_NAMES);
    expect(recorded.outcome).toBe('recorded');
    // spec closed and tester recorded, visual turn still to come: only the visual turn is missing.
    expect(uiux).toEqual({ outcome: 'blocked', reason: 'uiux-visual-missing' });
    expect(pre).toMatchObject({ outcome: 'pass', as: 'tester' });
  });

  it('a worker role checks only what its hand-off can satisfy; the rest is skipped with why', async () => {
    const input = await earlyHandBack(w);
    expect(input.uiAffecting).toBe(true);
    const shots = await testerResult(w, SHOT_NAMES);
    for (const as of ['coder', 'tester'] as const) {
      // The tester's clean hand-back carries its screenshot set; the coder's carries none.
      const doc = as === 'tester' ? { ...input, result: shots } : input;
      const pre = await checkPaperwork(paperworkInput(doc, as), w.ctx(), w.opts());
      expect(pre.outcome).toBe('pass');
      for (const stage of ['judges', 'uiux'] as const) {
        expect(pre.skipped).toContainEqual({ stage, why: `not-checked-for-${as}` });
      }
    }
    const gate = await checkPaperwork(paperworkInput(input, 'gate'), w.ctx(), w.opts());
    expect(gate).toMatchObject({ outcome: 'blocked', reason: 'judges-outstanding' });
    expect(stageOf(gate, 'uiux')?.reason).toBe('uiux-spec-missing');

    const grader = await checkPaperwork(
      { ...paperworkInput(input, 'grader'), graderVerdict: (await graderMet(w)).graderVerdict },
      w.ctx(),
      w.opts(),
    );
    const checked = STAGES_FOR_ROLE.grader;
    expect(checked).toEqual(['grader']);
    expect(
      grader.skipped.filter((s) => s.why === 'not-checked-for-grader').map((s) => s.stage),
    ).toEqual(['schema', 'artifacts', 'commit', 'deps', 'judges', 'uiux', 'screenshots']);
  });

  it('the stage sets are the contract', () => {
    expect(STAGES_FOR_ROLE).toEqual({
      coder: ['schema', 'artifacts', 'commit', 'deps'],
      tester: ['schema', 'artifacts', 'screenshots'],
      grader: ['grader'],
      gate: ['schema', 'artifacts', 'commit', 'deps', 'judges', 'uiux', 'grader'],
    });
  });
});

describe('alsoReported', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  async function eventsBefore() {
    return JSON.stringify(await readEvents(w.sessionId, w.opts()));
  }

  it('names an open judge turn the caller is about to close', async () => {
    const input = await judgesOutstanding(w);
    const before = await eventsBefore();
    const without = await checkPaperwork(paperworkInput(input, 'gate'), w.ctx(), w.opts());
    expect(without).toMatchObject({ outcome: 'blocked', reason: 'judges-outstanding' });
    const withIt = await checkPaperwork(
      { ...paperworkInput(input, 'gate'), alsoReported: [OPEN_JUDGE] },
      w.ctx(),
      w.opts(),
    );
    expect(withIt).toMatchObject({ outcome: 'pass' });
    expect(await eventsBefore()).toBe(before);
  });

  it('names an open uiux visual turn', async () => {
    const input = await uiuxVisualOpen(w);
    const before = await eventsBefore();
    const without = await checkPaperwork(paperworkInput(input, 'gate'), w.ctx(), w.opts());
    // The open visual turn is both an outstanding judge and a missing visual pass.
    expect(without).toMatchObject({ outcome: 'blocked', reason: 'judges-outstanding' });
    expect(stageOf(without, 'uiux')?.reason).toBe('uiux-visual-missing');
    const withIt = await checkPaperwork(
      { ...paperworkInput(input, 'gate'), alsoReported: [{ role: 'uiux', kind: 'visual' }] },
      w.ctx(),
      w.opts(),
    );
    expect(withIt).toMatchObject({ outcome: 'pass' });
    expect(await eventsBefore()).toBe(before);
    expect(await runGate(input, w.ctx(), w.opts())).toMatchObject({
      outcome: 'blocked',
      reason: 'judges-outstanding',
    });
  });

  it('a turn that was never dispatched is not made reported by naming it', async () => {
    const input = await uiuxVisualMissing(w);
    const res = await checkPaperwork(
      { ...paperworkInput(input, 'gate'), alsoReported: [{ role: 'uiux', kind: 'visual' }] },
      w.ctx(),
      w.opts(),
    );
    expect(res).toMatchObject({ outcome: 'blocked', reason: 'uiux-visual-missing' });
  });
});

describe('stage order', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  it('the gate and the preflight name the same first defect at every step of the ladder', async () => {
    const ladder = await buildLadder(w);
    for (const step of ladder.steps) {
      const input = ladder.input();
      const pre = await checkPaperwork(paperworkInput(input, 'gate'), w.ctx(), w.opts());
      const gate = await runGate(input, w.ctx(), w.opts());
      expect(gate).toMatchObject({ outcome: 'blocked' });
      const gateReason = gate.outcome === 'blocked' ? gate.reason : null;
      // A ladder step names the family; the uiux step may be any of its four reasons.
      if (step.reason === 'uiux-spec-missing') expect(gateReason).toMatch(/uiux|screenshots/);
      else expect(gateReason).toBe(step.reason);
      expect(pre.reason).toBe(gateReason);
      await step.fix();
    }
    const input = ladder.input();
    const pre = await checkPaperwork(paperworkInput(input, 'gate'), w.ctx(), w.opts());
    const gate = await runGate(input, w.ctx(), w.opts());
    expect(gate.outcome).toBe('pass');
    expect(pre.outcome).toBe('pass');
  });

  it('reports every problem in the gate order, not only the first', async () => {
    const ladder = await buildLadder(w);
    const pre = await checkPaperwork(paperworkInput(ladder.input(), 'gate'), w.ctx(), w.opts());
    expect(pre.reason).toBe('schema-invalid');
    expect(pre.problems.map((p) => p.stage)).toEqual([
      'schema',
      'artifacts',
      'commit',
      'deps',
      'judges',
      'uiux',
      'grader',
    ]);
  });
});

describe('what checkPaperwork writes and what it skips', () => {
  let w: World;
  beforeEach(async () => {
    w = await createWorld();
  });
  afterEach(async () => {
    await w.dispose();
  });

  async function treeBytes(dir: string): Promise<string> {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out.push(`${path.relative(dir, full)}\n${await readFile(full, 'utf8')}`);
      }
    };
    await walk(dir);
    return out.join('\n--\n');
  }

  it('writes nothing: events, results and the git index are byte-identical after every role on every fixture', async () => {
    const resultsDir = await mkdtemp(path.join(tmpdir(), 'bs-paperwork-results-'));
    await mkdir(resultsDir, { recursive: true });
    try {
      await writeFile(path.join(resultsDir, 'epic-1.task-1.json'), '{}');
      for (const { build } of PARITY_CASES) {
        const input = await build(w);
        const snap = async () => [
          await treeBytes(w.stateDir),
          await treeBytes(resultsDir),
          await readFile(path.join(w.worktreeDir, '.git', 'index')),
          w.git(['status', '--porcelain']),
        ];
        const before = await snap();
        for (const as of ['coder', 'tester', 'grader', 'gate'] as const) {
          await checkPaperwork(paperworkInput(input, as), w.ctx(), w.opts());
          await checkPaperwork(
            { ...paperworkInput(input, as), alsoReported: [OPEN_JUDGE] },
            w.ctx(),
            w.opts(),
          );
        }
        expect(await snap()).toEqual(before);
      }
    } finally {
      await rm(resultsDir, { recursive: true, force: true });
    }
  });

  it('never reports a stage as passed when it did not run', async () => {
    // No worktree, no session, not ui-affecting, no grader file.
    const res = await checkPaperwork(
      { as: 'gate', taskId: w.taskId, result: stampedResult(), artifactsDir: w.artifactsDir },
      {},
      w.opts(),
    );
    expect(res.outcome).toBe('pass');
    expect(res.skipped).toEqual([
      { stage: 'commit', why: 'no-input' },
      { stage: 'deps', why: 'no-input' },
      { stage: 'judges', why: 'no-input' },
      { stage: 'uiux', why: 'no-input' },
      { stage: 'screenshots', why: 'not-checked-for-gate' },
      { stage: 'grader', why: 'no-input' },
    ]);
  });

  it('skips uiux when the task is not ui-affecting, or when the flag is unknown', async () => {
    for (const uiAffecting of [false, undefined]) {
      const res = await checkPaperwork(
        {
          as: 'gate',
          taskId: w.taskId,
          result: stampedResult(),
          worktreeDir: w.worktreeDir,
          baseRef: 'main',
          artifactsDir: w.artifactsDir,
          ...(uiAffecting === undefined ? {} : { uiAffecting }),
        },
        w.ctx(),
        w.opts(),
      );
      expect(res.skipped).toContainEqual({ stage: 'uiux', why: 'no-input' });
    }
  });

  it('tester screenshots stage: skipped with no screenshots on a non-ui task, blocking on a ui-affecting one', async () => {
    const plain = await checkPaperwork(
      { as: 'tester', taskId: w.taskId, result: stampedResult(), artifactsDir: w.artifactsDir },
      w.ctx(),
      w.opts(),
    );
    expect(plain.skipped).toContainEqual({ stage: 'screenshots', why: 'no-input' });
    const ui = await checkPaperwork(
      {
        as: 'tester',
        taskId: w.taskId,
        result: stampedResult(),
        artifactsDir: w.artifactsDir,
        uiAffecting: true,
      },
      w.ctx(),
      w.opts(),
    );
    expect(ui).toMatchObject({ outcome: 'blocked', reason: 'screenshots-missing' });
  });

  it('does not guess at artifacts when the result left them unreadable', async () => {
    const res = await checkPaperwork(
      {
        as: 'coder',
        taskId: w.taskId,
        result: stampedResult({ artifacts: 'not-a-list' }),
        worktreeDir: w.worktreeDir,
        baseRef: 'main',
        artifactsDir: w.artifactsDir,
      },
      w.ctx(),
      w.opts(),
    );
    expect(res.reason).toBe('schema-invalid');
    expect(res.skipped).toContainEqual({ stage: 'artifacts', why: 'unreadable-input' });
    expect(stageOf(res, 'artifacts')).toBeUndefined();
  });

  it('lists a schema error and a missing artifact together; the reason is the first', async () => {
    const res = await checkPaperwork(
      {
        as: 'coder',
        taskId: w.taskId,
        result: {
          run_status: 'done',
          structured_output: {},
          artifacts: [{ type: 'log', path: 'nope.txt' }],
        },
        artifactsDir: w.artifactsDir,
      },
      w.ctx(),
      w.opts(),
    );
    expect(res.reason).toBe('schema-invalid');
    expect(res.problems.map((p) => p.reason)).toEqual(['schema-invalid', 'artifacts-missing']);
  });
});

describe('paperwork pieces', () => {
  it('screenshotsFromArtifacts reads the viewport and theme off the file name', () => {
    expect(
      screenshotsFromArtifacts([
        { type: 'screenshot', path: 'a-desktop-light.png' },
        { type: 'screenshot', path: 'a.png' },
        { type: 'log', path: 'a-mobile-dark.png.txt' },
        { type: 'screenshot', path: 'dir/b-mobile-dark.png' },
      ]),
    ).toEqual([
      { path: 'a-desktop-light.png', viewport: 'desktop', theme: 'light' },
      { path: 'dir/b-mobile-dark.png', viewport: 'mobile', theme: 'dark' },
    ]);
    expect(SCREENSHOT_RE.test('x-desktop-light.png')).toBe(true);
    expect(SCREENSHOT_RE.test('x-tablet-light.png')).toBe(false);
  });

  it('graderStage splits the shape verdict from the rubric verdict', async () => {
    const { taxonomy, schemas } = resolveTaxonomyAndSchemas({});
    const met = graderStage(
      {
        run_status: 'done',
        structured_output: {
          round: 1,
          criteria: [{ criterion: 'c', status: 'pass', evidence: 'e' }],
          overall: 'pass',
        },
      },
      taxonomy,
      schemas,
    );
    expect(met).toMatchObject({
      shape: 'ok',
      rubric: 'met',
      payload: { verdict: 'met', round: 1 },
    });
    const notMet = graderStage(
      {
        run_status: 'done',
        structured_output: {
          round: 1,
          criteria: [{ criterion: 'c', status: 'partial', evidence: 'e' }],
          overall: 'pass',
        },
      },
      taxonomy,
      schemas,
    );
    expect(notMet).toMatchObject({
      shape: 'ok',
      rubric: 'not-met',
      payload: { verdict: 'not-met' },
    });
    expect(graderStage({ run_status: 'dead' }, taxonomy, schemas)).toMatchObject({
      shape: 'ok',
      rubric: 'not-graded',
      payload: { verdict: 'not-graded', run_status: 'dead' },
    });
    expect(graderStage('nope', taxonomy, schemas)).toMatchObject({
      shape: 'invalid',
      rubric: null,
      payload: { verdict: 'invalid', errors: [{ path: '/' }] },
    });
  });
});
