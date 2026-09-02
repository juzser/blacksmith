import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiProviderConfig,
  CliProviderConfig,
  CrosscheckPolicy,
  ProviderConfig,
} from '../src/crosscheck.js';
import { appendEvent, readEvents } from '../src/events.js';
import { type FindingDraft, type RaiseFindingInput, SPEC_FINDING_SCOPE } from '../src/findings.js';
import { type GateInput, runGate } from '../src/gate.js';
import { recordJudgeDispatch, recordJudgeReport } from '../src/judges.js';
import type { LessonRule } from '../src/severity.js';
import { emitFollowUpTask } from '../src/taskEvents.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

function resultFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    task_id: 'epic-1/task-1',
    run_status: 'done',
    structured_output: {},
    artifacts: [],
    token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    agent: 'coder',
    provider: 'claude',
    model_tier: 'mid',
    ...overrides,
  };
}

function findingDraft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    finding_id: 'finding-1',
    task_id: 'epic-1/task-1',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    summary: 'off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    found_by: 'reviewer',
    ...overrides,
  };
}

describe('gate.ts (integration)', () => {
  let stateDir: string;
  let worktreeDir: string;
  let artifactsDir: string;
  const sessionId = 'sess-gate';

  function git(args: string[], cwd = worktreeDir) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  /**
   * A real repo, not a bare temp dir: since P9-8 the gate certifies the commit
   * it is about to score, so every case here has to be a worktree that actually
   * has one — `smith/epic-1/task-1` sitting one commit ahead of `main`.
   */
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-'));
    worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-wt-'));
    artifactsDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-art-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(worktreeDir, 'README.md'), '# repo\n');
    // `coverage/` is ignored here for the same reason every real repo ignores it:
    // it is reporter output, not source. Without this the P9-25 cases that write a
    // coverage summary would dirty the worktree and P9-8's certificate would block
    // them with `not-committed` before the coverage stage ever ran.
    await writeFile(path.join(worktreeDir, '.gitignore'), 'coverage/\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    git(['checkout', '-q', '-b', 'smith/epic-1/task-1']);
    await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);
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
    await rm(worktreeDir, { recursive: true, force: true });
    await rm(artifactsDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  function baseInput(overrides: Partial<GateInput> = {}): GateInput {
    return {
      taskId: 'epic-1/task-1',
      result: resultFixture(),
      worktreeDir,
      checks: [{ name: 'test', cmd: 'true' }],
      findingsInput: [],
      lessons: [],
      artifactsDir,
      ...overrides,
    };
  }

  it('passes clean: valid result, green tests, no findings', async () => {
    const outcome = await runGate(baseInput(), ctx(), { stateDir });
    expect(outcome).toMatchObject({ outcome: 'pass', taskId: 'epic-1/task-1' });

    const events = await readEvents(sessionId, { stateDir });
    const types = events.map((e) => e.record.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'schema-check-result',
        'testgate-result',
        'severity-decisions',
        'gate-outcome',
      ]),
    );
  });

  it('blocks on a schema-invalid result before running tests at all', async () => {
    const outcome = await runGate(
      baseInput({ result: resultFixture({ run_status: 'not-a-real-status' }) }),
      ctx(),
      { stateDir },
    );
    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'schema-invalid' });

    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === 'testgate-result')).toBe(false);
  });

  it('certifies the commit and reports it on a clean pass (P9-8)', async () => {
    const outcome = await runGate(baseInput({ baseRef: 'main' }), ctx(), { stateDir });

    expect(outcome.outcome).toBe('pass');
    expect(outcome.commitCheck).toMatchObject({
      certified: true,
      reason: null,
      branch: 'smith/epic-1/task-1',
      commitsAhead: 1,
      head: git(['rev-parse', 'HEAD']),
    });

    const events = await readEvents(sessionId, { stateDir });
    const commitCheck = events.find((e) => e.record.event_type === 'commit-check-result');
    expect(commitCheck?.record.payload).toMatchObject({ certified: true, commits_ahead: 1 });
  });

  it('refuses to score a worktree with uncommitted work, before any check runs (D-30)', async () => {
    await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 2;\n');

    const outcome = await runGate(
      baseInput({ checks: [{ name: 'test', cmd: 'touch ran-anyway.txt' }] }),
      ctx(),
      { stateDir },
    );

    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'not-committed' });
    if (outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(outcome.testResult).toBeNull();
    expect(outcome.commitCheck).toMatchObject({ reason: 'uncommitted-work', dirty: ['src.ts'] });

    const events = await readEvents(sessionId, { stateDir });
    const types = events.map((e) => e.record.event_type);
    expect(types).toContain('schema-check-result');
    expect(types).toContain('commit-check-result');
    expect(types).not.toContain('testgate-result');
    expect(existsSync(path.join(worktreeDir, 'ran-anyway.txt'))).toBe(false);
  });

  it('refuses a branch head that still equals the base it was cut from (D-30)', async () => {
    git(['checkout', '-q', '-b', 'smith/epic-1/task-3']);

    const outcome = await runGate(baseInput({ baseRef: 'smith/epic-1/task-1' }), ctx(), {
      stateDir,
    });

    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'not-committed' });
    expect(outcome.commitCheck).toMatchObject({ reason: 'branch-not-advanced', commitsAhead: 0 });
  });

  it('skips the base half when no base is given rather than inventing one', async () => {
    const outcome = await runGate(baseInput(), ctx(), { stateDir });

    expect(outcome.outcome).toBe('pass');
    expect(outcome.commitCheck).toMatchObject({
      certified: true,
      baseRef: null,
      commitsAhead: null,
    });
  });

  it('never certifies a commit it did not get to check (schema-invalid)', async () => {
    const outcome = await runGate(
      baseInput({ result: resultFixture({ run_status: 'not-a-real-status' }) }),
      ctx(),
      { stateDir },
    );

    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'schema-invalid' });
    expect(outcome.commitCheck).toBeUndefined();

    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === 'commit-check-result')).toBe(false);
  });

  // P9-21: the outcome used to say `schema-invalid` and nothing else — the
  // actual validation errors existed only in the preceding schema-check-result
  // event, which the caller had to know to go looking for. `testResult` is
  // already returned inline for `tests-failed`; the asymmetry was an omission.
  it('returns the schema errors inline, exactly as it returns testResult', async () => {
    const outcome = await runGate(
      baseInput({ result: resultFixture({ run_status: 'not-a-real-status' }) }),
      ctx(),
      { stateDir },
    );
    if (outcome.outcome !== 'blocked') throw new Error(`expected blocked, got ${outcome.outcome}`);

    expect(outcome.schemaErrors.length).toBeGreaterThan(0);
    for (const issue of outcome.schemaErrors) {
      expect(typeof issue.path).toBe('string');
      expect(issue.message).toBeTruthy();
    }

    // The same errors, not a re-derived summary: what the log records is what
    // the caller gets, so the two registers cannot drift.
    const events = await readEvents(sessionId, { stateDir });
    const check = events.find((e) => e.record.event_type === 'schema-check-result');
    if (!check) throw new Error('expected a schema-check-result event');
    expect(outcome.schemaErrors).toEqual((check.record.payload as { errors: unknown[] }).errors);
  });

  it('reports schemaErrors as empty rather than absent when the block is about something else', async () => {
    const outcome = await runGate(baseInput({ checks: [{ name: 'test', cmd: 'false' }] }), ctx(), {
      stateDir,
    });
    if (outcome.outcome !== 'blocked') throw new Error(`expected blocked, got ${outcome.outcome}`);
    expect(outcome.reason).toBe('tests-failed');
    expect(outcome.schemaErrors).toEqual([]);
  });

  // D-23/P9-12. `task-result-recorded` is what the agents registry closes a
  // live agent on and what db/queries.ts's analytics() sums token_usage from.
  // Nothing emitted it: every row in those two views came from a human typing
  // `smith event append`, so "abandoned agent" and "0 tokens spent" were both
  // just bookkeeping that nobody did. The gate is the right producer because
  // it is the one component that has already proved the Result is schema-valid.
  describe('task-result-recorded (D-23 / P9-12)', () => {
    async function resultsRecorded() {
      const events = await readEvents(sessionId, { stateDir });
      return events.filter((e) => e.record.event_type === 'task-result-recorded');
    }

    it('records the validated Result verbatim, once the schema check passes', async () => {
      await runGate(baseInput(), ctx(), { stateDir });

      const recorded = await resultsRecorded();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.record.task_id).toBe('epic-1/task-1');
      expect(recorded[0]?.record.payload).toEqual(resultFixture());
    });

    it('records it even when the gate goes on to block — the work still happened', async () => {
      const outcome = await runGate(
        baseInput({ checks: [{ name: 'test', cmd: 'false' }] }),
        ctx(),
        { stateDir },
      );
      expect(outcome.outcome).toBe('blocked');
      expect(await resultsRecorded()).toHaveLength(1);
    });

    it('records nothing for a Result that failed the schema check', async () => {
      await runGate(
        baseInput({ result: resultFixture({ run_status: 'not-a-real-status' }) }),
        ctx(),
        {
          stateDir,
        },
      );
      expect(await resultsRecorded()).toHaveLength(0);
    });

    it('does not double-count a re-run of the gate over the same Result', async () => {
      await runGate(baseInput(), ctx(), { stateDir });
      await runGate(baseInput(), ctx(), { stateDir });
      expect(await resultsRecorded()).toHaveLength(1);
    });

    it('does not double-count a Result the log already holds bare (D-183)', async () => {
      // The live log carries one task's results under both spellings: whoever
      // appended the first stamped what they typed, and `smith gate run`
      // stamps its own argument. Scoped by a raw id, the dedup misses its own
      // task and counts the single worker run twice.
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: 'task-result-recorded',
          task_id: 'task-1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: resultFixture() as Record<string, unknown>,
        },
        { stateDir },
      );
      await runGate(baseInput(), ctx(), { stateDir });
      expect(await resultsRecorded()).toHaveLength(1);
    });

    it('records a second time when the worker genuinely ran again', async () => {
      await runGate(baseInput(), ctx(), { stateDir });
      await runGate(
        baseInput({
          result: resultFixture({
            token_usage: { input_tokens: 900, output_tokens: 90, total_tokens: 990 },
          }),
        }),
        ctx(),
        { stateDir },
      );

      const recorded = await resultsRecorded();
      expect(recorded).toHaveLength(2);
      expect(
        recorded.map(
          (e) =>
            (e.record.payload as { token_usage: { total_tokens: number } }).token_usage
              .total_tokens,
        ),
      ).toEqual([150, 990]);
    });

    it('is keyed on content, not key order — a reserialized Result is the same Result', async () => {
      await runGate(baseInput(), ctx(), { stateDir });
      const reordered = {
        model_tier: 'mid',
        provider: 'claude',
        agent: 'coder',
        token_usage: { total_tokens: 150, output_tokens: 50, input_tokens: 100 },
        artifacts: [],
        structured_output: {},
        run_status: 'done',
        task_id: 'epic-1/task-1',
      };
      await runGate(baseInput({ result: reordered }), ctx(), { stateDir });
      expect(await resultsRecorded()).toHaveLength(1);
    });
  });

  // P9-22 / D-19: the wave-1 coder recorded three artifacts under /tmp. The
  // evidence in them was real; the paths were not durable, and nothing in the
  // gate noticed, because the gate reads the result file and never the
  // artifacts it names.
  describe('artifact check', () => {
    it('blocks when a declared artifact is not where artifacts live', async () => {
      const outcome = await runGate(
        baseInput({
          result: resultFixture({
            artifacts: [{ type: 'test-output', path: '/tmp/probe-fail-output.txt' }],
          }),
        }),
        ctx(),
        { stateDir },
      );
      if (outcome.outcome !== 'blocked')
        throw new Error(`expected blocked, got ${outcome.outcome}`);
      expect(outcome.reason).toBe('artifacts-missing');
      expect(outcome.artifactIssues).toHaveLength(1);
      expect(outcome.artifactIssues[0]).toMatchObject({
        declared: '/tmp/probe-fail-output.txt',
        problem: 'outside-home',
      });
    });

    it('checks artifacts before running the tests, as the schema check does', async () => {
      const outcome = await runGate(
        baseInput({
          result: resultFixture({ artifacts: [{ type: 'log', path: 'gone.txt' }] }),
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome.outcome).toBe('blocked');

      const events = await readEvents(sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === 'testgate-result')).toBe(false);
    });

    it('records that the check ran even when the task declared nothing', async () => {
      // A check that only logs when it has something to say is
      // indistinguishable, later, from a check that never ran (P9-23).
      await runGate(baseInput(), ctx(), { stateDir });
      const events = await readEvents(sessionId, { stateDir });
      const check = events.find((e) => e.record.event_type === 'artifact-check-result');
      if (!check) throw new Error('expected an artifact-check-result event');
      expect(check.record.payload).toMatchObject({ ok: true, checked: 0, issues: [] });
    });

    it('passes an artifact that lives in the task home', async () => {
      const home = path.join(artifactsDir, 'epic-1', 'task-1');
      await mkdir(home, { recursive: true });
      await writeFile(path.join(home, 'coverage.txt'), 'All files 98.99%\n');
      const outcome = await runGate(
        baseInput({
          result: resultFixture({ artifacts: [{ type: 'coverage-report', path: 'coverage.txt' }] }),
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome.outcome).toBe('pass');
    });

    it('reports artifactIssues as empty rather than absent on an unrelated block', async () => {
      const outcome = await runGate(
        baseInput({ checks: [{ name: 'test', cmd: 'false' }] }),
        ctx(),
        {
          stateDir,
        },
      );
      if (outcome.outcome !== 'blocked')
        throw new Error(`expected blocked, got ${outcome.outcome}`);
      expect(outcome.reason).toBe('tests-failed');
      expect(outcome.artifactIssues).toEqual([]);
    });
  });

  it('blocks on failing tests before findings are ever raised', async () => {
    const findingsInput: RaiseFindingInput[] = [
      { finding: findingDraft(), filePath: 'src/foo.ts' },
    ];
    const outcome = await runGate(
      baseInput({ checks: [{ name: 'test', cmd: 'false' }], findingsInput }),
      ctx(),
      { stateDir },
    );
    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'tests-failed' });

    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === 'finding-raised')).toBe(false);
  });

  it('blocks on an S2 finding', async () => {
    const findingsInput: RaiseFindingInput[] = [
      { finding: findingDraft({ severity: 'S2-major' }), filePath: 'src/foo.ts' },
    ];
    const outcome = await runGate(baseInput({ findingsInput }), ctx(), { stateDir });
    expect(outcome.outcome).toBe('blocked');
    if (outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(outcome.reason).toBe('findings');
    expect(outcome.blockingFindings).toHaveLength(1);
  });

  it('passes with a waiver batch pending on an S3 finding', async () => {
    const findingsInput: RaiseFindingInput[] = [
      {
        finding: findingDraft({
          severity: 'S3-minor',
          finding_category: 'over-engineering',
          summary: 'unnecessary abstraction layer',
        }),
        filePath: 'src/foo.ts',
      },
    ];
    const outcome = await runGate(baseInput({ findingsInput }), ctx(), { stateDir });
    expect(outcome.outcome).toBe('pass-with-waivers-pending');
    if (outcome.outcome !== 'pass-with-waivers-pending') throw new Error('unreachable');
    expect(outcome.pendingFindings).toHaveLength(1);
  });

  it('passes clean on an S4 finding (log-only, no block, no waiver batch)', async () => {
    const findingsInput: RaiseFindingInput[] = [
      { finding: findingDraft({ severity: 'S4-nit' }), filePath: 'src/foo.ts' },
    ];
    const outcome = await runGate(baseInput({ findingsInput }), ctx(), { stateDir });
    expect(outcome.outcome).toBe('pass');
  });

  it('escalates an S3 finding to S2 (block) via a matching same-mistake lesson', async () => {
    const lessons: LessonRule[] = [
      {
        lessonId: 'lesson-1',
        scope: 'claim-path',
        category: 'over-engineering',
        claimPath: 'src/**',
        agentRole: '',
        caseType: '',
        statement: 'never add unrequested abstraction layers again',
      },
    ];
    const findingsInput: RaiseFindingInput[] = [
      {
        finding: findingDraft({
          severity: 'S3-minor',
          finding_category: 'over-engineering',
          summary: 'unnecessary abstraction layer',
        }),
        filePath: 'src/foo.ts',
      },
    ];
    const outcome = await runGate(baseInput({ findingsInput, lessons }), ctx(), { stateDir });
    expect(outcome.outcome).toBe('blocked');
    if (outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(outcome.blockingFindings[0]?.severity).toBe('S2-major');

    const events = await readEvents(sessionId, { stateDir });
    const decisionsEvent = events.find((e) => e.record.event_type === 'severity-decisions');
    if (!decisionsEvent) throw new Error('unreachable');
    const decisions = (
      decisionsEvent.record.payload as { decisions: Array<{ same_mistake: boolean }> }
    ).decisions;
    expect(decisions[0]?.same_mistake).toBe(true);
    // The instrument, recorded next to the reading: this gate held one lesson
    // and that lesson could escalate.
    expect(decisionsEvent.record.payload).toMatchObject({
      lessons_loaded: 1,
      lessons_escalating: 1,
    });
  });

  it('records that the gate held no escalating lesson, so a clean run is distinguishable from a blind one', async () => {
    // `--lessons` is optional and an agent-role lesson can never escalate
    // anything, so both of these decide `same_mistake: false` for every
    // finding — same reading, different reasons, and until this count went on
    // the event the log could not tell them from a run that genuinely found no
    // repeat. `smith kpi same-mistake` reads exactly this field.
    const findingsInput: RaiseFindingInput[] = [
      {
        finding: findingDraft({ severity: 'S3-minor', finding_category: 'over-engineering' }),
        filePath: 'src/foo.ts',
      },
    ];

    await runGate(baseInput({ findingsInput }), ctx(), { stateDir });
    const noLessons = (await readEvents(sessionId, { stateDir })).find(
      (e) => e.record.event_type === 'severity-decisions',
    );
    expect(noLessons?.record.payload).toMatchObject({
      lessons_loaded: 0,
      lessons_escalating: 0,
    });

    const lessons: LessonRule[] = [
      {
        lessonId: 'lesson-role',
        scope: 'agent-role',
        category: '',
        claimPath: '**',
        agentRole: 'coder',
        caseType: '',
        statement: 'read the spec before writing code',
      },
    ];
    await runGate(baseInput({ findingsInput, lessons }), ctx(), { stateDir });
    const inert = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === 'severity-decisions',
    );
    expect(inert.at(-1)?.record.payload).toMatchObject({
      lessons_loaded: 1,
      lessons_escalating: 0,
    });
  });

  it('names the escalating lessons and places each decision, so an idle lesson is provable', async () => {
    // `lessons_escalating` is a count, and a count answers "could this gate
    // have caught a repeat at all" — the question `kpi same-mistake` asks. It
    // cannot answer "was THIS entry loaded", which is the question that
    // separates a lesson worth retiring from one that was never installed. So
    // the ids go on the event beside the count, and each decision carries the
    // two fields the escalation match itself consumes, so `lessons audit` can
    // reconstruct which entries had an opportunity rather than infer it.
    const lessons: LessonRule[] = [
      {
        lessonId: 'lesson-live',
        scope: 'claim-path',
        category: 'over-engineering',
        claimPath: 'src/**',
        agentRole: '',
        caseType: '',
        statement: 'never add an abstraction layer for a single caller',
      },
      {
        lessonId: 'lesson-role',
        scope: 'agent-role',
        category: '',
        claimPath: '**',
        agentRole: 'coder',
        caseType: '',
        statement: 'read the spec before writing code',
      },
    ];
    const findingsInput: RaiseFindingInput[] = [
      {
        finding: findingDraft({
          severity: 'S3-minor',
          finding_category: 'over-engineering',
          summary: 'unnecessary abstraction layer',
        }),
        filePath: 'src/foo.ts',
      },
    ];

    await runGate(baseInput({ findingsInput, lessons }), ctx(), { stateDir });
    const event = (await readEvents(sessionId, { stateDir })).find(
      (e) => e.record.event_type === 'severity-decisions',
    );
    if (!event) throw new Error('unreachable');
    // The role lesson is loaded and cannot escalate, so it is absent here for
    // the same reason it does not count: this list is what the match walked.
    expect(event.record.payload).toMatchObject({
      lessons_loaded: 2,
      lessons_escalating: 1,
      lesson_ids_escalating: ['lesson-live'],
    });
    const decisions = (
      event.record.payload as {
        decisions: Array<{ finding_category: string; file_path: string }>;
      }
    ).decisions;
    expect(decisions[0]).toMatchObject({
      finding_category: 'over-engineering',
      file_path: 'src/foo.ts',
      matched_lesson_id: 'lesson-live',
    });
  });

  it('a waived finding is suppressed and never blocks or enters the waiver batch again', async () => {
    const findingsInput: RaiseFindingInput[] = [
      {
        finding: findingDraft({ severity: 'S3-minor', finding_category: 'over-engineering' }),
        filePath: 'src/foo.ts',
      },
    ];

    const first = await runGate(baseInput({ findingsInput }), ctx(), { stateDir });
    expect(first.outcome).toBe('pass-with-waivers-pending');
    if (first.outcome !== 'pass-with-waivers-pending') throw new Error('unreachable');

    const { grantWaiver } = await import('../src/waivers.js');
    await grantWaiver(first.pendingFindings[0]?.fingerprint as string, 'ok', ctx(), { stateDir });

    const second = await runGate(
      baseInput({
        findingsInput: [
          {
            finding: findingDraft({
              finding_id: 'finding-2',
              severity: 'S3-minor',
              finding_category: 'over-engineering',
            }),
            filePath: 'src/foo.ts',
          },
        ],
      }),
      ctx(),
      { stateDir },
    );
    expect(second.outcome).toBe('pass');
  });

  // D-41/P9-24: the wave-4 security reviewer anchored a real S2 to
  // src/parse.ts — a file task-4-api was forbidden to touch. The gate blocked
  // task-4-api's diff, which could not fix it, and left the actual owner
  // untouched. Ownership is a property of the file, read off the plan's
  // claims map; the gate invocation is not evidence of anything.
  describe('finding ownership', () => {
    const claimsMap = [
      { task_id: 'epic-1/task-1', claims: ['src/index.ts'] },
      { task_id: 'epic-1/task-2', claims: ['src/parse.ts'] },
    ];

    const parseFinding = (): RaiseFindingInput[] => [
      {
        finding: findingDraft({
          severity: 'S2-major',
          summary: 'bare CR is silently swallowed by the line splitter',
        }),
        filePath: 'src/parse.ts',
      },
    ];

    async function eventsOfType(eventType: string) {
      const events = await readEvents(sessionId, { stateDir });
      return events.filter((e) => e.record.event_type === eventType);
    }

    /** The realistic "already merged" shape: added, then its branch landed. */
    async function markMerged(taskId: string) {
      for (const [eventType, payload] of [
        ['task-added', { epic_id: 'epic-1', task_status: 'ready' }],
        ['wave-merged', { task_ids: [taskId] }],
      ] as const) {
        await appendEvent(
          {
            session_id: sessionId,
            actor: 'system',
            event_type: eventType,
            task_id: taskId,
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload,
          },
          { stateDir },
        );
      }
    }

    it('without a claims map, keeps blocking the gated task exactly as before', async () => {
      const outcome = await runGate(baseInput({ findingsInput: parseFinding() }), ctx(), {
        stateDir,
      });
      expect(outcome.outcome).toBe('blocked');
      const raised = await eventsOfType('finding-raised');
      expect(raised[0]?.record.task_id).toBe('epic-1/task-1');
      expect(await eventsOfType('finding-reattributed')).toHaveLength(0);
    });

    it('blocks the gated task when it is the file’s owner', async () => {
      const outcome = await runGate(
        baseInput({
          findingsInput: [
            { finding: findingDraft({ severity: 'S2-major' }), filePath: 'src/index.ts' },
          ],
          ownership: claimsMap,
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome.outcome).toBe('blocked');
      expect(await eventsOfType('finding-reattributed')).toHaveLength(0);
    });

    it('re-attributes to the owning open task instead of blocking the gated diff', async () => {
      const outcome = await runGate(
        baseInput({ findingsInput: parseFinding(), ownership: claimsMap }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.reattributedFindings).toMatchObject([
        { attribution: 'reassigned', taskId: 'epic-1/task-2', filePath: 'src/parse.ts' },
      ]);

      const raised = await eventsOfType('finding-raised');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.record.task_id).toBe('epic-1/task-2');
      // Identity is re-minted under the owner, not carried over from the gate.
      expect(raised[0]?.record.payload).toMatchObject({ task_id: 'epic-1/task-2' });
      const payload = raised[0]?.record.payload as { finding_id: string } | undefined;
      expect(payload?.finding_id).toContain('epic-1/task-2');

      const moved = await eventsOfType('finding-reattributed');
      expect(moved).toHaveLength(1);
      expect(moved[0]?.record.payload).toMatchObject({
        from_task_id: 'epic-1/task-1',
        to_task_id: 'epic-1/task-2',
        attribution: 'reassigned',
        file_path: 'src/parse.ts',
      });
    });

    it('opens an epic follow-up task when the owning task has already merged', async () => {
      await markMerged('epic-1/task-2');

      const outcome = await runGate(
        baseInput({ findingsInput: parseFinding(), ownership: claimsMap }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.reattributedFindings?.[0]?.attribution).toBe('follow-up');

      const followUpId = outcome.reattributedFindings?.[0]?.taskId as string;
      expect(followUpId.startsWith('epic-1/')).toBe(true);

      const added = (await eventsOfType('task-added')).filter(
        (e) => e.record.task_id === followUpId,
      );
      expect(added).toHaveLength(1);
      expect(added[0]?.record.payload).toMatchObject({
        epic_id: 'epic-1',
        task_status: 'todo',
        claims: ['src/parse.ts'],
      });

      const raised = await eventsOfType('finding-raised');
      expect(raised[0]?.record.task_id).toBe(followUpId);
    });

    it('opens a follow-up when no task in the plan claims the file', async () => {
      const outcome = await runGate(
        baseInput({
          findingsInput: [
            { finding: findingDraft({ severity: 'S2-major' }), filePath: 'scripts/release.sh' },
          ],
          ownership: claimsMap,
        }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.reattributedFindings?.[0]).toMatchObject({
        attribution: 'follow-up',
        filePath: 'scripts/release.sh',
      });
      expect(outcome.reattributedFindings?.[0]?.reason).toMatch(/claims/i);
    });

    it('opens a follow-up rather than guessing between two equally specific claims', async () => {
      const outcome = await runGate(
        baseInput({
          findingsInput: parseFinding(),
          ownership: [
            { task_id: 'epic-1/task-a', claims: ['src/*.ts'] },
            { task_id: 'epic-1/task-b', claims: ['src/**'] },
          ],
        }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.reattributedFindings?.[0]?.attribution).toBe('follow-up');
      expect(outcome.reattributedFindings?.[0]?.reason).toContain('epic-1/task-a');
      expect(outcome.reattributedFindings?.[0]?.reason).toContain('epic-1/task-b');
    });

    // D-173: a tie is only a reason to escalate when nothing can break it.
    // The real envkit-config-loader plan splits src/parse.ts across two tasks
    // with identical claims, serialized by a `claim-order` edge — so every
    // finding on that file is permanently ambiguous. When the task at the
    // gate is one of the tied owners, the gate is the tie-breaker: it is
    // holding the file, and the diff under review is where the fix belongs.
    // Escalating there minted a follow-up competing for claims the gated task
    // still held, and — since only `gated` findings enter `blocking` — let an
    // S2 land un-blocked.
    it('blocks the gated task when it is one of the equally specific claimants', async () => {
      const tied = [
        { task_id: 'epic-1/task-1', claims: ['src/parse.ts', 'test/parse.test.ts'] },
        { task_id: 'epic-1/task-2', claims: ['src/parse.ts', 'test/parse.test.ts'] },
      ];

      const outcome = await runGate(
        baseInput({ findingsInput: parseFinding(), ownership: tied }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('blocked');
      if (outcome.outcome !== 'blocked') throw new Error('unreachable');
      expect(outcome.reason).toBe('findings');
      expect(outcome.blockingFindings).toHaveLength(1);
      expect(outcome.reattributedFindings ?? []).toHaveLength(0);
      expect(await eventsOfType('finding-reattributed')).toHaveLength(0);
      // No follow-up task competing for the claims task-1 is still holding.
      expect(await eventsOfType('task-added')).toHaveLength(0);

      const raised = await eventsOfType('finding-raised');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.record.task_id).toBe('epic-1/task-1');
    });

    // D-48/P9-31: the follow-up used to be minted with the single file the
    // finding named. A parser bug's regression test does not live in the
    // parser, so `smith claims check` on the real fix returned
    // `outOfClaim: ["test/parse.test.ts"]` — a task created to fix a bug could
    // not legally prove it fixed it. It inherits the claims of whoever
    // resolved its ownership instead.
    async function claimsOfFollowUp(followUpId: string): Promise<string[]> {
      const added = (await eventsOfType('task-added')).filter(
        (e) => e.record.task_id === followUpId,
      );
      expect(added).toHaveLength(1);
      const payload = added[0]?.record.payload as { claims?: string[] } | undefined;
      return payload?.claims ?? [];
    }

    it('mints the follow-up with the merged owner’s full claims, not just the named file', async () => {
      await markMerged('epic-1/task-2');

      const outcome = await runGate(
        baseInput({
          findingsInput: parseFinding(),
          ownership: [
            { task_id: 'epic-1/task-1', claims: ['src/index.ts'] },
            { task_id: 'epic-1/task-2', claims: ['src/parse.ts', 'test/parse.test.ts'] },
          ],
        }),
        ctx(),
        { stateDir },
      );

      const followUpId = outcome.reattributedFindings?.[0]?.taskId as string;
      expect(await claimsOfFollowUp(followUpId)).toEqual(['src/parse.ts', 'test/parse.test.ts']);
    });

    it('mints an ambiguous finding’s follow-up with the union of both candidates’ claims', async () => {
      const outcome = await runGate(
        baseInput({
          findingsInput: parseFinding(),
          ownership: [
            { task_id: 'epic-1/task-a', claims: ['src/*.ts', 'docs/a.md'] },
            { task_id: 'epic-1/task-b', claims: ['src/**', 'docs/b.md'] },
          ],
        }),
        ctx(),
        { stateDir },
      );

      const followUpId = outcome.reattributedFindings?.[0]?.taskId as string;
      // Sorted on both sides: the set is the assertion, not the order.
      expect([...(await claimsOfFollowUp(followUpId))].sort()).toEqual(
        ['docs/a.md', 'docs/b.md', 'src/**', 'src/*.ts'].sort(),
      );
    });

    it('falls back to the file the finding named when no task claims it', async () => {
      const outcome = await runGate(
        baseInput({
          findingsInput: [
            { finding: findingDraft({ severity: 'S2-major' }), filePath: 'scripts/release.sh' },
          ],
          ownership: claimsMap,
        }),
        ctx(),
        { stateDir },
      );

      const followUpId = outcome.reattributedFindings?.[0]?.taskId as string;
      expect(await claimsOfFollowUp(followUpId)).toEqual(['scripts/release.sh']);
    });

    it('does not mint a second follow-up task when the same gate runs twice', async () => {
      const input = baseInput({
        findingsInput: [
          { finding: findingDraft({ severity: 'S2-major' }), filePath: 'scripts/release.sh' },
        ],
        ownership: claimsMap,
      });
      await runGate(input, ctx(), { stateDir });
      await runGate(input, ctx(), { stateDir });

      const added = await eventsOfType('task-added');
      expect(added).toHaveLength(1);
    });
  });

  // D-31, D-20 / P9-11. Five of wave 3's eight judges ended their turn
  // without writing their result file and signalled `completed` anyway. The
  // gate scored the task on whatever happened to be on the command line, so
  // "the security reviewer never reported" and "the security reviewer found
  // nothing" arrived here as the same thing: no findings.
  describe('outstanding judges', () => {
    /**
     * Judge artifacts live OUTSIDE the worktree they are about. A reviewer.json
     * written next to the code would be an untracked file in the worktree, and
     * two separate guards already call that a defect: `smith worktree verify`
     * reads it as judge mutation (P9-5), and the commit certificate reads it as
     * uncommitted work and refuses to score the task at all (P9-8). So the
     * declared path here is under the state dir, which is where a real dispatch
     * points it too.
     */
    const artifactDir = () => stateDir;

    async function dispatchJudge(role: string, artifactPath: string, round = 1) {
      await recordJudgeDispatch(
        { taskId: 'epic-1/task-1', role, round, artifactPath, model: 'claude-opus-5' },
        ctx(),
        { stateDir },
      );
    }

    it('is a no-op for a task that dispatched no judges', async () => {
      const outcome = await runGate(baseInput(), ctx(), { stateDir });
      expect(outcome.outcome).toBe('pass');
    });

    it('refuses to score a task whose dispatch set and report set differ', async () => {
      await dispatchJudge('reviewer', path.join(artifactDir(), 'reviewer.json'));
      await dispatchJudge('security-reviewer', path.join(artifactDir(), 'sec.json'));
      await writeFile(path.join(artifactDir(), 'reviewer.json'), '[]', 'utf8');
      await recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), { stateDir });

      const outcome = await runGate(baseInput(), ctx(), { stateDir });
      expect(outcome).toMatchObject({
        outcome: 'blocked',
        reason: 'judges-outstanding',
        testResult: null,
      });
      expect(
        outcome.outcome === 'blocked' ? outcome.outstandingJudges?.map((j) => j.role) : undefined,
      ).toEqual(['security-reviewer']);
    });

    // D-183. `smith judge dispatch --task` and `smith gate run <task-id>` both
    // stamp the id they were handed, and neither qualifies it. Fold the two
    // halves on the raw string and a spelling difference hands the gate an
    // empty turn set — which `outstandingJudges` cannot tell from "every judge
    // reported". The gate then scores a task whose reviewer never came back,
    // the exact state P9-11 exists to refuse.
    it('refuses to score a task whose judge was dispatched under the bare id', async () => {
      await recordJudgeDispatch(
        {
          taskId: 'task-1',
          role: 'reviewer',
          round: 1,
          artifactPath: path.join(artifactDir(), 'reviewer.json'),
          model: 'claude-opus-5',
        },
        ctx(),
        { stateDir },
      );

      const outcome = await runGate(baseInput(), ctx(), { stateDir });
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'judges-outstanding' });
    });

    // D-156. An epic that outgrows one operator session is the recommended
    // shape (P9-7), and D-119 already swept every fold that decides something
    // onto the lineage reader — every one it could find. `judges.ts` carried a
    // NUL byte at the time (D-155), so the grep that found the callers skipped
    // it in silence, and this fold stayed on the single-session reader. Round 1
    // dispatches the reviewer, round 2 runs the gate, and the promise made in
    // round 1 is outside the scope round 2 reads.
    it('still owes a judge the previous session dispatched', async () => {
      await dispatchJudge('reviewer', path.join(artifactDir(), 'reviewer.json'));

      const child = 'sess-gate-round-2';
      await appendEvent(
        {
          session_id: child,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { continues: sessionId },
        },
        { stateDir },
      );

      const outcome = await runGate(
        baseInput(),
        { sessionId: child, planVersion: 1, causalParent: `${child}#0` },
        { stateDir },
      );

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'judges-outstanding' });
      expect(
        outcome.outcome === 'blocked' ? outcome.outstandingJudges?.map((j) => j.role) : undefined,
      ).toEqual(['reviewer']);
    });

    it('refuses before paying for the test run', async () => {
      await dispatchJudge('reviewer', path.join(artifactDir(), 'reviewer.json'));
      await runGate(baseInput(), ctx(), { stateDir });
      const events = await readEvents(sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === 'testgate-result')).toBe(false);
    });

    it('still blocks on a schema-invalid result first — that is an input error too', async () => {
      await dispatchJudge('reviewer', path.join(artifactDir(), 'reviewer.json'));
      const outcome = await runGate(
        baseInput({ result: resultFixture({ run_status: 'not-a-real-status' }) }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'schema-invalid' });
    });

    it('scores normally once every dispatched judge has reported', async () => {
      await dispatchJudge('reviewer', path.join(artifactDir(), 'reviewer.json'));
      await writeFile(path.join(artifactDir(), 'reviewer.json'), '[]', 'utf8');
      await recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), { stateDir });
      const outcome = await runGate(baseInput(), ctx(), { stateDir });
      expect(outcome.outcome).toBe('pass');
    });

    it('only looks at the task being gated', async () => {
      await recordJudgeDispatch(
        {
          taskId: 'epic-1/task-2',
          role: 'reviewer',
          round: 1,
          artifactPath: path.join(artifactDir(), 'other.json'),
          model: 'claude-opus-5',
        },
        ctx(),
        { stateDir },
      );
      const outcome = await runGate(baseInput(), ctx(), { stateDir });
      expect(outcome.outcome).toBe('pass');
    });
  });

  // D-34/P9-14: the grader runs before the gates so its rubric result can
  // inform them, and no code path in the orchestrator ever opened a grader
  // verdict file. Inside one wave, two graders on the same role and the same
  // template wrote two different shapes and nothing objected — because nothing
  // read them. A schema is load-bearing only if something loads it.
  describe('grader verdict (D-34/P9-14)', () => {
    /** The `structured_output` the grader's own output contract mandates. */
    function verdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        round: 1,
        criteria: [
          {
            criterion: 'a bare CR splits a line',
            status: 'pass',
            evidence: 'test/parse.test.ts:42 green',
          },
        ],
        overall: 'pass',
        ...overrides,
      };
    }

    /** The whole file the grader writes: a result envelope with the verdict inside it. */
    function graderFile(
      structuredOutput: unknown,
      overrides: Record<string, unknown> = {},
    ): unknown {
      return {
        run_status: 'done',
        structured_output: structuredOutput,
        artifacts: [],
        token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        ...overrides,
      };
    }

    async function graderEventPayload(): Promise<Record<string, unknown>> {
      const events = await readEvents(sessionId, { stateDir });
      const event = events.find((e) => e.record.event_type === 'grader-verdict');
      if (!event) throw new Error('no grader-verdict event was written');
      return event.record.payload as Record<string, unknown>;
    }

    async function reachedTheTestGate(): Promise<boolean> {
      const events = await readEvents(sessionId, { stateDir });
      return events.some((e) => e.record.event_type === 'testgate-result');
    }

    it('passes a met rubric through, and writes down that it was read', async () => {
      const outcome = await runGate(baseInput({ graderVerdict: graderFile(verdict()) }), ctx(), {
        stateDir,
      });
      expect(outcome.outcome).toBe('pass');
      expect(await graderEventPayload()).toMatchObject({
        verdict: 'met',
        round: 1,
        overall: 'pass',
        failed_criteria: [],
      });
    });

    it('blocks on a fail verdict before spending a test run on it', async () => {
      const outcome = await runGate(
        baseInput({
          graderVerdict: graderFile(
            verdict({
              overall: 'fail',
              round: 2,
              criteria: [
                {
                  criterion: 'a bare CR splits a line',
                  status: 'fail',
                  evidence: 'test/parse.test.ts:42 red — input "a\\rb" yields one line',
                },
              ],
              gaps: ['the splitter still treats \\r as ordinary text'],
            }),
          ),
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-fail' });
      expect(await reachedTheTestGate()).toBe(false);
      expect(await graderEventPayload()).toMatchObject({
        verdict: 'not-met',
        failed_criteria: [{ criterion: 'a bare CR splits a line', status: 'fail' }],
      });
    });

    // The grader's two verdict fields can contradict each other, and the
    // per-criterion one is the one carrying evidence.
    it('blocks on a criterion marked fail even when overall claims pass', async () => {
      const outcome = await runGate(
        baseInput({
          graderVerdict: graderFile(
            verdict({
              overall: 'pass',
              criteria: [
                { criterion: 'a bare CR splits a line', status: 'pass', evidence: 'green' },
                { criterion: 'CRLF is one break', status: 'fail', evidence: 'red at line 51' },
              ],
            }),
          ),
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-fail' });
      expect(await graderEventPayload()).toMatchObject({
        overall: 'pass',
        failed_criteria: [{ criterion: 'CRLF is one break', status: 'fail' }],
      });
    });

    // `partial` is what the grader is told to write when it runs out of
    // context mid-rubric. A criterion nobody could finish grading is not a
    // criterion met.
    it('blocks on a partial criterion', async () => {
      const outcome = await runGate(
        baseInput({
          graderVerdict: graderFile(
            verdict({
              criteria: [
                {
                  criterion: 'CRLF is one break',
                  status: 'partial',
                  evidence: 'graded the splitter, not the reader',
                },
              ],
            }),
          ),
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-fail' });
    });

    // The exact second shape from D-34: same role, same template, verdict at
    // `.verdict` instead of `.structured_output.overall`.
    it('blocks as grader-invalid on the shape that put the verdict at .verdict', async () => {
      const outcome = await runGate(
        baseInput({
          graderVerdict: {
            task_id: 'epic-1/task-1',
            round: 1,
            verdict: 'pass',
            criteria: [],
            notes: 'looks good',
          },
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-invalid' });
      expect(await reachedTheTestGate()).toBe(false);

      const payload = await graderEventPayload();
      expect(payload.verdict).toBe('invalid');
      expect(JSON.stringify(payload.errors)).toContain('structured_output');
    });

    it('blocks as grader-invalid on a round the grader is not allowed to open', async () => {
      const outcome = await runGate(
        baseInput({ graderVerdict: graderFile(verdict({ round: 3 })) }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-invalid' });
      expect(JSON.stringify((await graderEventPayload()).errors)).toContain('/round');
    });

    it('blocks as grader-invalid on a criterion with no evidence', async () => {
      const outcome = await runGate(
        baseInput({
          graderVerdict: graderFile(
            verdict({
              criteria: [{ criterion: 'a bare CR splits a line', status: 'pass' }],
            }),
          ),
        }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-invalid' });
    });

    // `dead` is the grader's own word for "this task spec has no checkable
    // acceptance criteria". Passing it through would mean the criteria gated
    // nothing at all.
    it('blocks when the grading run came back dead', async () => {
      const outcome = await runGate(
        baseInput({ graderVerdict: graderFile({}, { run_status: 'dead' }) }),
        ctx(),
        { stateDir },
      );
      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'grader-fail' });
      expect(await graderEventPayload()).toMatchObject({
        verdict: 'not-graded',
        run_status: 'dead',
      });
    });

    // A gate run with no grader verdict is the pre-P9-14 pipeline, unchanged:
    // an ad-hoc gate run is not forced to invent a rubric result.
    it('runs the pipeline exactly as before when no verdict is handed over', async () => {
      const outcome = await runGate(baseInput(), ctx(), { stateDir });
      expect(outcome.outcome).toBe('pass');

      const events = await readEvents(sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === 'grader-verdict')).toBe(false);
    });
  });

  // P9-25/D-40. The coverage gate was correct and its transcript was not: the
  // v8 text reporter hides every file at 100% on all four metrics, so
  // `src/index.ts` — the file task-4-api existed to add, and the file its C12
  // named — was absent from a table that did list two other modules. Read
  // literally, the gate's own evidence said the criterion was unverifiable.
  // The summary is attached now, and a named file with no number blocks.
  describe('coverage evidence', () => {
    async function writeSummary(files: Record<string, number>): Promise<void> {
      await mkdir(path.join(worktreeDir, 'coverage'), { recursive: true });
      const entry = (pct: number) => ({
        lines: { total: 10, covered: pct / 10, skipped: 0, pct },
        statements: { total: 10, covered: pct / 10, skipped: 0, pct },
        functions: { total: 2, covered: 2, skipped: 0, pct },
        branches: { total: 4, covered: 4, skipped: 0, pct },
      });
      const doc: Record<string, unknown> = { total: entry(90) };
      for (const [rel, pct] of Object.entries(files)) {
        doc[path.join(worktreeDir, rel)] = entry(pct);
      }
      await writeFile(
        path.join(worktreeDir, 'coverage/coverage-summary.json'),
        JSON.stringify(doc),
        'utf8',
      );
    }

    const withCoverage = (overrides: Partial<GateInput> = {}) =>
      baseInput({
        checks: [
          { name: 'test', cmd: 'true' },
          { name: 'coverage', cmd: 'true' },
        ],
        ownership: [
          { task_id: 'epic-1/task-1', claims: ['src/index.ts', 'test/index.test.ts'] },
          { task_id: 'epic-1/task-2', claims: ['src/parse.ts'] },
        ],
        ...overrides,
      });

    it('attaches the per-file summary to a passing outcome', async () => {
      await writeSummary({ 'src/index.ts': 100, 'src/parse.ts': 90 });

      const outcome = await runGate(withCoverage(), ctx(), { stateDir });

      expect(outcome.outcome).toBe('pass');
      const evidence = outcome.coverageEvidence;
      expect(evidence?.present).toBe(true);
      expect(evidence?.complete).toBe(true);
      expect(evidence?.filesMeasured).toBe(2);
      // The 100% row the text reporter would have hidden, present with a number.
      expect(evidence?.subjects.find((s) => s.path === 'src/index.ts')).toMatchObject({
        status: 'measured',
      });
      // A test file is out of the include glob — a fact, not a hole.
      expect(evidence?.subjects.find((s) => s.path === 'test/index.test.ts')?.status).toBe(
        'not-instrumented',
      );
    });

    it('emits a coverage-evidence event carrying the numbers', async () => {
      await writeSummary({ 'src/index.ts': 100 });

      await runGate(withCoverage(), ctx(), { stateDir });

      const events = await readEvents(sessionId, { stateDir });
      const evidence = events.find((e) => e.record.event_type === 'coverage-evidence');
      expect(evidence).toBeDefined();
      const payload = evidence?.record.payload as Record<string, unknown>;
      expect(payload.complete).toBe(true);
      expect(payload.files_measured).toBe(1);
    });

    it('blocks when the criterion names a file the run did not measure', async () => {
      // Only the sibling got a row. `perFile: true` proves every *included*
      // file cleared the bar — it says nothing about one that was never included.
      await writeSummary({ 'src/parse.ts': 90 });

      const outcome = await runGate(withCoverage(), ctx(), { stateDir });

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'coverage-evidence' });
      expect(outcome.coverageEvidence?.complete).toBe(false);
      expect(outcome.coverageEvidence?.detail).toContain('src/index.ts');
    });

    it('blocks, naming the reporter, when the coverage check wrote no summary', async () => {
      const outcome = await runGate(withCoverage(), ctx(), { stateDir });

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'coverage-evidence' });
      expect(outcome.coverageEvidence?.present).toBe(false);
      expect(outcome.coverageEvidence?.detail).toContain('json-summary');
    });

    it('does not judge coverage evidence when no coverage check was configured', async () => {
      const outcome = await runGate(
        withCoverage({ checks: [{ name: 'test', cmd: 'true' }] }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.coverageEvidence).toBeUndefined();
      const events = await readEvents(sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === 'coverage-evidence')).toBe(false);
    });

    it('judges only the gated task’s own claims, not the whole plan’s', async () => {
      // src/parse.ts belongs to task-2. Its absence is task-2's problem at
      // task-2's gate, and blocking task-1 for it is D-41 all over again.
      await writeSummary({ 'src/index.ts': 100 });

      const outcome = await runGate(withCoverage(), ctx(), { stateDir });

      expect(outcome.outcome).toBe('pass');
      expect(outcome.coverageEvidence?.subjects.map((s) => s.path)).toEqual([
        'src/index.ts',
        'test/index.test.ts',
      ]);
    });

    it('reports the total with no ownership to narrow it, and does not block', async () => {
      await writeSummary({ 'src/index.ts': 100 });

      const outcome = await runGate(withCoverage({ ownership: undefined }), ctx(), { stateDir });

      expect(outcome.outcome).toBe('pass');
      expect(outcome.coverageEvidence?.subjects).toEqual([]);
      expect(outcome.coverageEvidence?.total?.lines.pct).toBe(90);
    });

    /**
     * An empty claims list is what a task that owns no file looks like, and
     * `find(...)?.claims ?? []` returned it for a table with no row for this
     * task at all. Zero subjects then reports `complete: true` — "0 of 0 named
     * files have a per-file number" — so the P9-25 gate passed by never having
     * looked at anything, on exactly the runs where a plan WAS handed to it.
     *
     * The table above deliberately holds the sibling only, which is what a
     * `--plan` from the wrong epic, or a `--task` that names a task the plan
     * does not carry, look like from in here. cli.ts already wrote the rule
     * for the dispatch side of the same read: "a `--plan` that names a task it
     * does not contain is an error rather than an empty claims list, which
     * would silently drop every claim-path lesson the task was supposed to
     * see" (claimsForDispatch). The gate's copy of the read did the opposite.
     */
    it('blocks when the ownership table has no row for the gated task', async () => {
      await writeSummary({ 'src/index.ts': 100 });

      const outcome = await runGate(
        withCoverage({ ownership: [{ task_id: 'epic-1/task-2', claims: ['src/parse.ts'] }] }),
        ctx(),
        { stateDir },
      );

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'coverage-evidence' });
      expect(outcome.coverageEvidence?.complete).toBe(false);
      expect(outcome.coverageEvidence?.detail).toContain('epic-1/task-1');
      // Naming the ids it does hold is the whole repair path, and it is what
      // plan.ts's resolveTaskId prints for the same miss.
      expect(outcome.coverageEvidence?.detail).toContain('epic-1/task-2');
      // The numbers it did read stay on the certificate: the hole is whose
      // files to judge, not whether the reporter ran.
      expect(outcome.coverageEvidence?.total?.lines.pct).toBe(90);
    });

    /**
     * The reachable spelling is not a typo, it is the id form. A plan lists
     * `epic-1/task-1` and an operator types `task-1` — which is precisely why
     * plan.ts carries resolveTaskId ("Use the full id the plan lists"), and
     * why cli.ts's budgetFromFlags resolves through it before reading the
     * budget off the very same `--plan` file. This read compares raw strings,
     * so on one `smith gate run` the budget check found its task and the
     * coverage gate silently found nobody.
     */
    it('blocks on a bare task id the ownership table spells out in full', async () => {
      await writeSummary({ 'src/index.ts': 100 });

      const outcome = await runGate(
        withCoverage({ taskId: 'task-1', result: resultFixture({ task_id: 'task-1' }) }),
        ctx(),
        { stateDir },
      );

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'coverage-evidence' });
      expect(outcome.coverageEvidence?.complete).toBe(false);
      expect(outcome.coverageEvidence?.detail).toContain('task-1');
    });

    /**
     * D-48/P9-31 again, from the other side. A follow-up minted by `findings
     * raise` is real, gateable work that no plan version has been cut for yet
     * — cli.ts's budgetFromFlags says so out loud ("refusing to gate it would
     * be a worse answer than reporting its budget as not-declared"), and
     * `queue run` already learned that "the plan is not the only register".
     * The refusal above reads only the table `--plan` produced, and `gate run`
     * has no `--claims` flag, so for a follow-up "use the id the plan lists"
     * names no id that exists: every follow-up gate carrying a coverage check
     * would be unpassable. The register the follow-up IS in holds the claims
     * `emitFollowUpTask` minted, and that is where its subjects come from.
     */
    it('takes a follow-up task subjects from the log when no plan names it', async () => {
      await writeSummary({ 'src/parse.ts': 100 });
      const followUp = 'epic-1/followup-ab12cd34';
      await emitFollowUpTask(
        {
          taskId: followUp,
          epicId: 'epic-1',
          objective: 'cover the parser the finding was about',
          claims: ['src/parse.ts'],
        },
        ctx(),
        { stateDir },
      );

      const outcome = await runGate(
        withCoverage({ taskId: followUp, result: resultFixture({ task_id: followUp }) }),
        ctx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.coverageEvidence?.complete).toBe(true);
      expect(outcome.coverageEvidence?.subjects.map((s) => s.path)).toEqual(['src/parse.ts']);
    });

    /**
     * The register answers who a task is, not what it may be assumed to own.
     * An id in neither table is still the miss the refusal exists for — and
     * the message has to name both places that were asked, or it sends the
     * operator to fix the only one it mentions.
     */
    it('still blocks when neither the plan nor the log names the gated task', async () => {
      await writeSummary({ 'src/index.ts': 100 });
      await emitFollowUpTask(
        {
          taskId: 'epic-1/followup-99999999',
          epicId: 'epic-1',
          objective: 'a different follow-up entirely',
          claims: ['src/other.ts'],
        },
        ctx(),
        { stateDir },
      );

      const outcome = await runGate(
        withCoverage({
          taskId: 'epic-1/followup-ab12cd34',
          result: resultFixture({ task_id: 'epic-1/followup-ab12cd34' }),
        }),
        ctx(),
        { stateDir },
      );

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'coverage-evidence' });
      expect(outcome.coverageEvidence?.detail).toContain('epic-1/followup-99999999');
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-provider quorum (Phase 8). Two of crosscheck.yml's four
// `quorum_triggers` have a real host in this pipeline and only these are
// wired here: "any S1/S2 finding, before it blocks a task" and
// "same-mistake findings". The other two (epic-level final verdict,
// low-confidence planner verdict) have no code path yet — see
// docs/runbooks/providers.md §2.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_CLI = path.join(here, 'fixtures', 'fake-judge-cli.mjs');
const DEEPSEEK_KEY_ENV = 'TEST_DEEPSEEK_API_KEY';

function codexProvider(overrides: Partial<CliProviderConfig> = {}): CliProviderConfig {
  return {
    name: 'codex',
    kind: 'api',
    transport: 'cli',
    enabled: true,
    mode: 'shadow',
    modelTier: 'mid',
    command: 'node',
    args: [JUDGE_CLI, 'refute'],
    ...overrides,
  };
}

function deepseekProvider(overrides: Partial<ApiProviderConfig> = {}): ApiProviderConfig {
  return {
    name: 'deepseek',
    kind: 'api',
    transport: 'api',
    enabled: true,
    mode: 'shadow',
    modelTier: 'mid',
    baseUrl: 'https://api.example.test',
    model: 'test-model',
    apiKeyEnv: DEEPSEEK_KEY_ENV,
    responseFormatJsonObject: true,
    ...overrides,
  };
}

function policyWith(...externals: ProviderConfig[]): CrosscheckPolicy {
  return {
    ...crosscheckDefaults(),
    providers: {
      claude: { name: 'claude', kind: 'native', enabled: true },
      ...Object.fromEntries(externals.map((p) => [p.name, p])),
    },
    quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
  };
}

function judgingFetch(verdict: 'confirm' | 'refute') {
  return vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ verdict, rationale: `deepseek: ${verdict}` }) },
            },
          ],
        }),
        { status: 200 },
      ),
  );
}

interface QuorumDecisionPayload {
  task_id: string;
  finding_id: string | null;
  trigger_reason: string;
  finder_provider: string;
  outcome: 'decided' | 'escalate';
  decision: string | null;
  agreement: string | null;
  escalation_reason: string | null;
  blocks: boolean;
  participants: Array<{ provider: string; mode: string; ok: boolean; verdict: string | null }>;
  rationales: Array<{ provider: string; verdict: string; rationale: string }>;
}

describe('gate.ts cross-provider quorum (Phase 8)', () => {
  let stateDir: string;
  let worktreeDir: string;
  const sessionId = 'sess-gate-quorum';
  const originalKey = process.env[DEEPSEEK_KEY_ENV];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-q-'));
    worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-q-wt-'));
    // A committed worktree, for the same reason as the integration suite above:
    // runGate certifies the commit before it scores anything (P9-8).
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);
    process.env[DEEPSEEK_KEY_ENV] = 'sk-test-key';
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
    if (originalKey === undefined) delete process.env[DEEPSEEK_KEY_ENV];
    else process.env[DEEPSEEK_KEY_ENV] = originalKey;
    await rm(stateDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  function gateInput(overrides: Partial<GateInput> = {}): GateInput {
    return {
      taskId: 'epic-1/task-1',
      result: resultFixture(),
      worktreeDir,
      checks: [{ name: 'test', cmd: 'true' }],
      findingsInput: [],
      lessons: [],
      ...overrides,
    };
  }

  const blockingFinding = (overrides: Partial<FindingDraft> = {}): RaiseFindingInput[] => [
    { finding: findingDraft({ severity: 'S2-major', ...overrides }), filePath: 'src/foo.ts' },
  ];

  async function quorumEvents() {
    const events = await readEvents(sessionId, { stateDir });
    return {
      all: events,
      quorum: events
        .filter((e) => e.record.event_type === 'quorum-decision')
        .map((e) => e.record.payload as unknown as QuorumDecisionPayload),
      verdicts: events.filter((e) => e.record.event_type === 'judge-verdict'),
    };
  }

  it('never invokes a judge, and emits no quorum events, when no external provider is enabled', async () => {
    const fetchMock = judgingFetch('refute');
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        crosscheck: {
          policy: policyWith(
            codexProvider({ enabled: false, mode: 'active' }),
            deepseekProvider({ enabled: false, mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('blocked');
    expect(fetchMock).not.toHaveBeenCalled();
    const { quorum, verdicts } = await quorumEvents();
    expect(quorum).toHaveLength(0);
    expect(verdicts).toHaveLength(0);
  });

  it('records a shadow-mode verdict but leaves the block exactly as it was', async () => {
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        crosscheck: { policy: policyWith(codexProvider({ mode: 'shadow' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('blocked');
    if (outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(outcome.blockingFindings).toHaveLength(1);
    // Shadow mode never escalates to the operator — nothing was ever going to gate.
    expect(outcome.quorumEscalations ?? []).toHaveLength(0);

    const { quorum, verdicts } = await quorumEvents();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.record.payload).toMatchObject({ provider: 'codex', mode: 'shadow' });
    expect(quorum).toHaveLength(1);
    expect(quorum[0]).toMatchObject({
      trigger_reason: 'blocking-finding',
      outcome: 'escalate',
      blocks: true,
    });
    expect(quorum[0]?.participants.map((p) => p.provider)).toEqual(['claude', 'codex']);
  });

  it('drops a blocking finding when an active quorum refutes it', async () => {
    const fetchMock = judgingFetch('refute');
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active' }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('pass');

    const { all, quorum } = await quorumEvents();
    expect(quorum[0]).toMatchObject({
      outcome: 'decided',
      decision: 'refute',
      agreement: '2-of-2',
      blocks: false,
    });
    const transitions = all.filter((e) => e.record.event_type === 'finding-transitioned');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.record.payload).toMatchObject({
      from_status: 'raised',
      to_status: 'refuted',
    });
  });

  it('keeps the block when an active quorum confirms the finding', async () => {
    const fetchMock = judgingFetch('confirm');
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active', args: [JUDGE_CLI, 'success'] }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('blocked');
    const { quorum } = await quorumEvents();
    expect(quorum[0]).toMatchObject({ outcome: 'decided', decision: 'confirm', blocks: true });
  });

  it('escalates instead of dropping when a lone active refuter is below min_providers', async () => {
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('blocked');
    if (outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(outcome.blockingFindings).toHaveLength(1);
    expect(outcome.quorumEscalations).toHaveLength(1);
    expect(outcome.quorumEscalations?.[0]).toMatchObject({
      reason: 'insufficient-providers',
      triggerReason: 'blocking-finding',
    });

    const { quorum } = await quorumEvents();
    expect(quorum[0]).toMatchObject({
      outcome: 'escalate',
      escalation_reason: 'insufficient-providers',
      blocks: true,
    });
  });

  it('escalates on active disagreement and keeps the block', async () => {
    const fetchMock = judgingFetch('confirm');
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active' }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('blocked');
    if (outcome.outcome !== 'blocked') throw new Error('unreachable');
    expect(outcome.quorumEscalations?.[0]).toMatchObject({ reason: 'disagreement' });
    const { quorum } = await quorumEvents();
    expect(quorum[0]).toMatchObject({ outcome: 'escalate', escalation_reason: 'disagreement' });
    expect(quorum[0]?.rationales?.length ?? 0).toBeGreaterThan(0);
  });

  it('fires the same-mistake trigger on a lesson-escalated finding', async () => {
    const lessons: LessonRule[] = [
      {
        lessonId: 'lesson-1',
        scope: 'claim-path',
        category: 'over-engineering',
        claimPath: 'src/**',
        agentRole: '',
        caseType: '',
        statement: 'never add unrequested abstraction layers again',
      },
    ];
    const outcome = await runGate(
      gateInput({
        findingsInput: [
          {
            finding: findingDraft({ severity: 'S3-minor', finding_category: 'over-engineering' }),
            filePath: 'src/foo.ts',
          },
        ],
        lessons,
        crosscheck: { policy: policyWith(codexProvider({ mode: 'shadow' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('blocked');
    const { quorum } = await quorumEvents();
    expect(quorum).toHaveLength(1);
    expect(quorum[0]).toMatchObject({ trigger_reason: 'same-mistake' });
  });

  it('never triggers a quorum case for a log-only S4 finding', async () => {
    const outcome = await runGate(
      gateInput({
        findingsInput: [{ finding: findingDraft({ severity: 'S4-nit' }), filePath: 'src/foo.ts' }],
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('pass');
    const { quorum, verdicts } = await quorumEvents();
    expect(quorum).toHaveLength(0);
    expect(verdicts).toHaveLength(0);
  });

  // D-201. An escalation is a judge disagreement the gate could not settle;
  // it is addressed to the operator, and it does not become less unsettled
  // because the finding that raised it turned out not to block. These three
  // cover the three ways a quorum-triggering finding leaves the loop without
  // reaching `blocking`: waived, re-attributed, diverted to the spec.
  it('reports an escalation on a finding that ends in the waiver batch', async () => {
    const lessons: LessonRule[] = [
      {
        lessonId: 'lesson-1',
        scope: 'claim-path',
        category: 'over-engineering',
        claimPath: 'src/**',
        agentRole: '',
        caseType: '',
        statement: 'never add unrequested abstraction layers again',
      },
    ];
    const outcome = await runGate(
      gateInput({
        findingsInput: [
          {
            finding: findingDraft({ severity: 'S4-nit', finding_category: 'over-engineering' }),
            filePath: 'src/foo.ts',
          },
        ],
        lessons,
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('pass-with-waivers-pending');
    const { quorum } = await quorumEvents();
    expect(quorum[0]).toMatchObject({ outcome: 'escalate', trigger_reason: 'same-mistake' });
    expect(outcome.quorumEscalations).toHaveLength(1);
    expect(outcome.quorumEscalations?.[0]).toMatchObject({ triggerReason: 'same-mistake' });
  });

  it('reports an escalation on a finding handed to the task that owns the file', async () => {
    const outcome = await runGate(
      gateInput({
        findingsInput: blockingFinding(),
        ownership: [
          { task_id: 'epic-1/task-1', claims: ['src/index.ts'] },
          { task_id: 'epic-1/task-2', claims: ['src/foo.ts'] },
        ],
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('pass');
    expect(outcome.reattributedFindings).toHaveLength(1);
    expect(outcome.quorumEscalations).toHaveLength(1);
    expect(outcome.quorumEscalations?.[0]).toMatchObject({
      reason: 'insufficient-providers',
      triggerReason: 'blocking-finding',
    });
  });

  it('reports an escalation on a finding diverted to the spec', async () => {
    const outcome = await runGate(
      gateInput({
        findingsInput: [
          {
            finding: findingDraft({
              severity: 'S2-major',
              finding_scope: SPEC_FINDING_SCOPE,
              spec_ref: { plan_version: 1, criterion_ref: 'AC-1' },
            }),
            filePath: 'src/foo.ts',
          },
        ],
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('pass');
    expect(outcome.specFindings).toHaveLength(1);
    expect(outcome.quorumEscalations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P9-16(d). A task worktree is a `git worktree` of the project, and git does
// not copy `node_modules` into one. Wave 3 ran its gates anyway: the check
// commands resolved `vitest` and `biome` by walking UP out of the worktree
// into the FACTORY's own `node_modules`, so the green the gate reported was
// the factory's toolchain passing, not the project's. The tell was a
// `node_modules` inside the worktree that held only `.vite`/`.vite-temp` —
// directories a vite run creates, with no `.bin` in sight — which is why
// "does node_modules exist" is not the question worth asking.
// ---------------------------------------------------------------------------
describe('deps precondition (P9-16d)', () => {
  let stateDir: string;
  let worktreeDir: string;
  const sessionId = 'sess-gate-deps';

  const git = (args: string[]) => execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' });

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-deps-'));
    worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-deps-wt-'));
    // A committed worktree: since P9-8 the gate certifies the commit before it
    // scores anything, so a bare scratch dir blocks on `not-committed` and this
    // suite never reaches its own subject. `node_modules` is ignored here for
    // the same reason a real project ignores it — these cases create one on
    // purpose, and an untracked one would read as uncommitted work.
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    await writeFile(path.join(worktreeDir, '.gitignore'), 'node_modules/\n');
    await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'task work']);
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
    await rm(worktreeDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  /** A check that WOULD pass, so a block can only have come from the precondition. */
  function input(): GateInput {
    return {
      taskId: 'epic-1/task-1',
      result: resultFixture(),
      worktreeDir,
      checks: [{ name: 'test', cmd: 'true' }],
      findingsInput: [],
      lessons: [],
    };
  }

  async function writePackageJson(deps: Record<string, unknown>): Promise<void> {
    await writeFile(
      path.join(worktreeDir, 'package.json'),
      `${JSON.stringify({ name: 'proj', private: true, ...deps }, null, 2)}\n`,
      'utf8',
    );
    // Committed, not merely written: a stray uncommitted manifest would block
    // on the commit certificate ahead of the deps check (P9-8).
    git(['add', 'package.json']);
    git(['commit', '-q', '-m', 'declare dependencies']);
  }

  it('blocks a worktree whose declared dependencies were never installed', async () => {
    await writePackageJson({ devDependencies: { vitest: '^4.0.0' } });

    const outcome = await runGate(input(), ctx(), { stateDir });

    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'deps-missing' });
    // The tests must not have run: a green from a borrowed toolchain is the
    // exact result this precondition exists to refuse to produce.
    expect((outcome as { testResult: unknown }).testResult).toBeNull();
    const types = (await readEvents(sessionId, { stateDir })).map((e) => e.record.event_type);
    expect(types).toContain('deps-check-result');
    expect(types).not.toContain('testgate-result');
  });

  it('does not count a node_modules that holds only a build cache', async () => {
    await writePackageJson({ dependencies: { vue: '^3.5.0' } });
    // Precisely wave 3's worktree: vite wrote here, pnpm never did.
    await mkdir(path.join(worktreeDir, 'node_modules', '.vite'), { recursive: true });
    await mkdir(path.join(worktreeDir, 'node_modules', '.vite-temp'), { recursive: true });

    const outcome = await runGate(input(), ctx(), { stateDir });

    expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'deps-missing' });
  });

  it('passes once the worktree has its own installed binaries', async () => {
    await writePackageJson({ devDependencies: { vitest: '^4.0.0' } });
    await mkdir(path.join(worktreeDir, 'node_modules', '.bin'), { recursive: true });

    const outcome = await runGate(input(), ctx(), { stateDir });

    expect(outcome).toMatchObject({ outcome: 'pass' });
  });

  it('lets a package.json with nothing to install through', async () => {
    await writePackageJson({});

    const outcome = await runGate(input(), ctx(), { stateDir });

    expect(outcome).toMatchObject({ outcome: 'pass' });
  });

  it('lets a worktree that is not a node project through', async () => {
    const outcome = await runGate(input(), ctx(), { stateDir });

    expect(outcome).toMatchObject({ outcome: 'pass' });
  });

  // P9-23 in miniature: a check that decided "nothing to check here" is a
  // check that happened, and the log has to be able to tell that apart from
  // a check that never ran at all.
  it('records the check even when it was a no-op', async () => {
    await runGate(input(), ctx(), { stateDir });

    const events = await readEvents(sessionId, { stateDir });
    const depsCheck = events.find((e) => e.record.event_type === 'deps-check-result');
    expect(depsCheck?.record.payload).toMatchObject({ ok: true, declares_dependencies: false });
  });
});

describe('gate.ts budget check (P9-18)', () => {
  let stateDir: string;
  let root: string;
  let repo: string;
  const sessionId = 'sess-gate-budget';

  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-gate-budget-'));
    root = await mkdtemp(path.join(tmpdir(), 'smith-gate-budget-wt-'));
    repo = path.join(root, 'repo');
    await mkdir(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'src.ts'), 'one\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    git(repo, ['branch', 'smith/epic-1/integration']);
    git(repo, ['checkout', '-q', '-b', 'smith/epic-1/task-1']);
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
    await rm(root, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  function budgetInput(overrides: Partial<GateInput> = {}): GateInput {
    return {
      taskId: 'epic-1/task-1',
      result: resultFixture(),
      worktreeDir: repo,
      checks: [{ name: 'test', cmd: 'true' }],
      findingsInput: [],
      lessons: [],
      ...overrides,
    };
  }

  async function budgetEvent(): Promise<Record<string, unknown>> {
    const events = await readEvents(sessionId, { stateDir });
    const found = events.filter((e) => e.record.event_type === 'budget-check-result');
    expect(found).toHaveLength(1);
    return (found[0] as { record: { payload: Record<string, unknown> } }).record.payload;
  }

  async function commitLines(count: number): Promise<void> {
    await writeFile(path.join(repo, 'src.ts'), 'x\n'.repeat(count));
    git(repo, ['commit', '-q', '-am', 'work']);
  }

  it('compares the declared budget against what the task actually spent', async () => {
    await commitLines(20);
    const outcome = await runGate(
      budgetInput({ budget: { tokens: 1000, diff_lines: 400 } }),
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('pass');
    expect(outcome.budgetCheck).toMatchObject({
      status: 'checked',
      overruns: [],
      tokensUsed: 150,
      baseRef: 'smith/epic-1/integration',
    });
    expect(await budgetEvent()).toMatchObject({ status: 'checked', overruns: [] });
  });

  it('records a diff overrun with both numbers, and still lets the task pass', async () => {
    await commitLines(60);
    const outcome = await runGate(
      budgetInput({ budget: { tokens: 1000, diff_lines: 10 } }),
      ctx(),
      {
        stateDir,
      },
    );

    // Recorded, not blocking. Blocking a green, reviewed task on its budget
    // moves D-29's "trade finishing for compliance" pressure from the agent to
    // the gate — and the overrun is a fact about the plan's estimate as much as
    // about the task.
    expect(outcome.outcome).toBe('pass');
    expect(outcome.budgetCheck?.overruns).toEqual([{ field: 'diff_lines', cap: 10, measured: 61 }]);
    expect(await budgetEvent()).toMatchObject({
      overruns: [{ field: 'diff_lines', cap: 10, measured: 61 }],
    });
  });

  // D-157. A 400-line source change lands in a file that carries a NUL byte
  // (D-155), git calls the file binary, numstat gives it no line counts, and
  // the total it folds into is zero. The `unmeasurable` branch below already
  // refuses to report "0 lines" when it could not look; this is the same zero
  // arriving through the file list instead of through a thrown error.
  it('names the files behind a zero it could not count', async () => {
    await writeFile(path.join(repo, 'src.ts'), `${'x\n'.repeat(400)}\u0000\n`);
    git(repo, ['commit', '-q', '-am', 'work in a file git reads as binary']);

    const outcome = await runGate(
      budgetInput({ budget: { tokens: 1000, diff_lines: 10 } }),
      ctx(),
      {
        stateDir,
      },
    );

    // The zero is honest about the lines — git has none to give — and now says
    // which file it is standing in for, so a cap that passed on nothing is
    // auditable rather than invisible.
    expect(outcome.budgetCheck).toMatchObject({ status: 'checked', diffLines: 0, overruns: [] });
    expect(outcome.budgetCheck?.unmeasuredFiles).toEqual(['src.ts']);
    expect(await budgetEvent()).toMatchObject({ unmeasuredFiles: ['src.ts'] });
  });

  it('reads real token spend off the result, not off the plan', async () => {
    const outcome = await runGate(
      budgetInput({ budget: { tokens: 100, diff_lines: 400 } }),
      ctx(),
      {
        stateDir,
      },
    );

    expect(outcome.budgetCheck?.overruns).toEqual([{ field: 'tokens', cap: 100, measured: 150 }]);
  });

  it('emits the event even when no budget was declared, saying so', async () => {
    const outcome = await runGate(budgetInput(), ctx(), { stateDir });

    expect(outcome.outcome).toBe('pass');
    expect(outcome.budgetCheck).toMatchObject({ status: 'not-declared', overruns: [] });
    expect(await budgetEvent()).toMatchObject({ status: 'not-declared' });
  });

  it('says it could not measure rather than reporting a zero diff', async () => {
    // Off the smith/<epic>/<task> naming, so there is no integration branch to
    // derive — the same shape as the original bare-temp-dir case, but one the
    // P9-8 commit certificate lets through: since the certificate runs first,
    // a non-worktree now blocks on `not-committed` and never reaches here.
    git(repo, ['checkout', '-q', '-b', 'wip']);
    const outcome = await runGate(
      budgetInput({ budget: { tokens: 1000, diff_lines: 400 } }),
      ctx(),
      { stateDir },
    );

    // A budget check that reported 0 lines here would pass every cap forever.
    expect(outcome.outcome).toBe('pass');
    expect(outcome.budgetCheck).toMatchObject({
      status: 'unmeasurable',
      unmeasurableReason: expect.stringContaining('diffstat.'),
      tokensUsed: 150,
    });
    expect(outcome.budgetCheck?.diffLines).toBeUndefined();
  });

  it('still records the budget when the task is blocked on its tests', async () => {
    await commitLines(60);
    const outcome = await runGate(
      budgetInput({
        checks: [{ name: 'test', cmd: 'false' }],
        budget: { tokens: 1000, diff_lines: 10 },
      }),
      ctx(),
      { stateDir },
    );

    // The expensive runs are the failing ones; deferring the economy record
    // behind a green testgate would lose exactly the cases worth seeing.
    expect(outcome.outcome).toBe('blocked');
    expect(outcome.budgetCheck?.overruns).toHaveLength(1);
    expect(await budgetEvent()).toMatchObject({ status: 'checked' });
  });
});
