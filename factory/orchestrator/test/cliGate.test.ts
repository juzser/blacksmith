import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { committedWorktreeIn, runCli, taskStatusFixtures } from './helpers/cliHarness.js';
import { git, runOrThrow } from './helpers/process.js';

// Part of the former cli.test.ts, split along its describe blocks so vitest runs
// the parts on separate workers. cli.ts is thin argv->module wiring (excluded from
// the coverage floor, like UI glue per stack.md); it is verified end-to-end here
// as a built binary, the way it actually runs (`smith <ns> <action> ...`).
// Shared harness: helpers/cliHarness.ts.

describe('cli.ts (built binary)', () => {
  let scratchDir: string;

  // dist/ is built once for the whole run by test/globalSetup.ts, not here:
  // guardHook.test.ts execs the same binary, and two parallel vitest workers
  // emitting into one dist/ while a third reads it is a race. Each file of the
  // old single cli.test.ts now owns its scratch directory, so none depends on
  // another having run first.
  beforeAll(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  /**
   * A worktree the gate will actually score — see committedWorktreeIn in
   * helpers/cliHarness.ts.
   */
  const committedWorktree = (name: string) => committedWorktreeIn(scratchDir, name);

  describe('task-status producers (D-46/P9-29)', () => {
    const { PLAN, session, tail } = taskStatusFixtures(() => scratchDir);

    // The same routing, reached the way the factory actually reaches it. Without
    // `--plan` wired through here, the ownership fix exists only in the library.
    /**
     * A committed task worktree, one commit ahead of `main`. Since P9-8 the gate
     * certifies the commit it is about to score, so a gate run needs a real
     * branch — a bare temp dir is exactly the thing it now refuses.
     */
    describe('gate run ownership (D-41/P9-24)', () => {
      it('does not block the gated task for a finding about another task’s file', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const worktreeDir = await committedWorktree('gate-ownership');
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        const evidencePath = path.join(scratchDir, `${sessionId}-evidence.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        await writeFile(
          evidencePath,
          JSON.stringify([
            {
              file_path: 'src/bar/thing.ts',
              finding_category: 'correctness',
              severity: 'S2-major',
              summary: 'off-by-one in loop bound',
              failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
            },
          ]),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          evidencePath,
          '--found-by',
          'reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        // An S2 about src/bar/*.ts blocked task-1's diff before P9-24, and the
        // fix could not legally have been in that diff. Drop either half of the
        // wiring and this goes red: without --plan the finding stays on task-1
        // and blocks it, without the EventOpts the gate writes to the real
        // state/events/ instead of the dir the rest of the test reads.
        expect(result.status).toBe(0);
        const outcome = JSON.parse(result.stdout);
        expect(outcome.outcome).not.toBe('blocked');
        expect(outcome.reattributedFindings).toMatchObject([
          { taskId: 'epic-1/task-2', attribution: 'reassigned', filePath: 'src/bar/thing.ts' },
        ]);

        // --state-dir has to be honoured too, or the gate writes this run into
        // the real state/events/ log while the test reads an empty scratch dir.
        const records = tail(sessionId, eventsDir);
        expect(records.filter((r) => r.event_type === 'finding-raised')[0]?.task_id).toBe(
          'epic-1/task-2',
        );
        expect(records.filter((r) => r.event_type === 'finding-reattributed')).toHaveLength(1);
      });
    });

    describe('gate run ownership reads live records only', () => {
      it('does not attribute a finding to a superseded copy of the gated task', async () => {
        const { sessionId, eventsDir } = await session();
        const planPath = path.join(scratchDir, `${sessionId}-gate-superseded-plan.json`);
        await writeFile(
          planPath,
          JSON.stringify({
            epic_id: 'epic-1',
            version: 2,
            status: 'active',
            tasks: [
              { task_id: 'epic-1/task-1', claims: ['src/bar/**'], task_status: 'superseded' },
              { task_id: 'epic-1/task-1', claims: ['src/live/**'], task_status: 'todo' },
            ],
            edges: [],
          }),
        );
        const worktreeDir = await committedWorktree('gate-ownership-superseded');
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        const evidencePath = path.join(scratchDir, `${sessionId}-evidence.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        await writeFile(
          evidencePath,
          JSON.stringify([
            {
              file_path: 'src/bar/thing.ts',
              finding_category: 'correctness',
              severity: 'S2-major',
              summary: 'off-by-one in loop bound',
              failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
            },
          ]),
        );
        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          evidencePath,
          '--found-by',
          'reviewer',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        // src/bar/ was claimed only by the dead copy, so the finding is not
        // task-1's: it must not block task-1 nor be stamped with its id.
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');
        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised[0]?.task_id).not.toBe('epic-1/task-1');
      });
    });

    // A per-check `timeout_ms` in checks.json is read straight into a
    // `setTimeout` call downstream; a bogus value there does not fail loudly,
    // it fails as either an instant "timed out after 0ms" false red or a
    // timeout that silently never fires. Refused here, at the point the file
    // is read — before the worktree, the result file or the session context
    // are even touched — rather than let a gate run act on either.
    describe('gate run --checks timeout_ms validation', () => {
      async function gateInvocation(
        checksBody: unknown,
      ): Promise<{ status: number; stdout: string }> {
        const { sessionId, eventsDir, planPath } = await session();
        const worktreeDir = await committedWorktree(`checks-timeout-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify(checksBody));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        return runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
      }

      it('refuses a non-positive timeout_ms instead of running the check', async () => {
        const result = await gateInvocation([{ name: 'test', cmd: 'true', timeout_ms: 0 }]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.message).toContain('timeout_ms');
        expect(JSON.parse(result.stdout).error.message).toContain('test');
      });

      it('refuses a non-integer timeout_ms instead of running the check', async () => {
        const result = await gateInvocation([{ name: 'test', cmd: 'true', timeout_ms: 12.5 }]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.message).toContain('timeout_ms');
      });

      // Node clamps a setTimeout delay above 2^31-1 to 1ms: an oversized
      // timeout_ms would time the check out instantly, not wait longer.
      it('refuses a timeout_ms above the setTimeout ceiling', async () => {
        const result = await gateInvocation([
          { name: 'test', cmd: 'true', timeout_ms: 2_147_483_648 },
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.message).toContain('2147483647');
      });

      it('still runs a checks.json with a valid timeout_ms', async () => {
        const result = await gateInvocation([{ name: 'test', cmd: 'true', timeout_ms: 1000 }]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');
      });
    });

    // #285: `gate run --findings` reads the same pre-minted RaiseFindingInput[]
    // shape `findings raise --findings` does, through the same unvalidated
    // readJsonFile call — so a judge artifact handed to it crashed the same
    // way, inside `normalizeRepoPath`, instead of naming the shape problem.
    describe('gate run --findings shape validation (#285)', () => {
      async function gateInvocation(findingsBody: unknown): Promise<{
        status: number;
        stdout: string;
      }> {
        const { sessionId, eventsDir, planPath } = await session();
        const worktreeDir = await committedWorktree(`findings-shape-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        const findingsPath = path.join(scratchDir, `${sessionId}-findings.json`);
        await writeFile(checksPath, JSON.stringify([]));
        await writeFile(findingsPath, JSON.stringify(findingsBody));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        return runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--findings',
          findingsPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
      }

      it('refuses a judge-artifact-shaped --findings file with a named shape error, not a crash', async () => {
        const result = await gateInvocation([
          {
            file_path: 'src/bar/thing.ts',
            finding_category: 'correctness',
            severity: 'S2-major',
            summary: 'off-by-one in loop bound',
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ]);
        expect(result.status).toBe(1);
        const error = JSON.parse(result.stdout).error;
        expect(error.code).toBe('cli.invalid-flag');
        expect(error.message).toContain('item 0');
        expect(error.message).toContain('--evidence');
      });
    });

    // The ownership split reached the way the factory reaches it. Without these
    // flags wired through, `stampResultEnvelope` exists only in the library and
    // every real gate run still takes the agent's word for its own token count.
    describe('gate run --agent stamps the envelope (P9-17)', () => {
      /** What a worker is allowed to write once P9-17 lands: three keys. */
      const AGENT_HALF = {
        run_status: 'done',
        structured_output: {},
        artifacts: [],
      };

      async function gateRunWith(
        result: Record<string, unknown>,
        extraFlags: string[],
      ): Promise<{ stdout: string; status: number; sessionId: string; eventsDir: string }> {
        const { sessionId, eventsDir } = await session();
        // A committed worktree, not the scratch dir: since P9-8 the gate
        // certifies the commit before it scores anything, so a bare directory
        // blocks on `not-committed` and never reaches the envelope (D-30).
        const worktreeDir = await committedWorktree(`p9-17-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(resultPath, JSON.stringify(result));
        const cli = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--base',
          'main',
          '--checks',
          checksPath,
          '--result',
          resultPath,
          ...extraFlags,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        return { ...cli, sessionId, eventsDir };
      }

      const ENVELOPE_FLAGS = [
        '--agent',
        'coder',
        '--provider',
        'claude',
        '--model-tier',
        'mid',
        '--input-tokens',
        '19264',
        '--output-tokens',
        '4118',
      ];

      it('accepts a result file holding only the agent\u2019s three keys', async () => {
        const result = await gateRunWith(AGENT_HALF, ENVELOPE_FLAGS);
        expect(result.status).toBe(0);
        // Before P9-17 this file was rejected by result.schema.json for the
        // five fields it does not carry — the agent was obliged to invent them.
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');
      });

      it('refuses a result whose agent wrote its own token_usage', async () => {
        const result = await gateRunWith(
          {
            ...AGENT_HALF,
            token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
          ENVELOPE_FLAGS,
        );
        expect(result.status).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('results.agent-wrote-owned-field');
        expect(error.message).toContain('token_usage');
      });

      // The `--findings` half of the existing dual shape has a `--result`
      // twin: a replay hands over a complete document and nothing is stamped.
      it('leaves a complete result document alone when --agent is absent', async () => {
        const result = await gateRunWith(
          {
            ...AGENT_HALF,
            task_id: 'epic-1/task-1',
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          },
          [],
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');
      });

      // #220. A dispatcher running inside an environment with no API onto a
      // subagent's token spend has no honest number to give `--input-tokens`/
      // `--output-tokens` — before this, `requireIntFlag` made the pair
      // mandatory and forced one to be invented. Omitting both now stamps the
      // envelope's own "not measured" rather than a fabricated count.
      const NO_TOKEN_FLAGS = ['--agent', 'coder', '--provider', 'claude', '--model-tier', 'mid'];

      it('stamps {measured: false} when both token flags are omitted', async () => {
        const result = await gateRunWith(AGENT_HALF, NO_TOKEN_FLAGS);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).not.toBe('blocked');

        const events = tail(result.sessionId, result.eventsDir);
        const recorded = events.find((e) => e.event_type === 'task-result-recorded');
        expect(recorded?.payload).toMatchObject({ token_usage: { measured: false } });
      });

      it('still stamps a real count when both token flags are given', async () => {
        const result = await gateRunWith(AGENT_HALF, ENVELOPE_FLAGS);
        expect(result.status).toBe(0);

        const events = tail(result.sessionId, result.eventsDir);
        const recorded = events.find((e) => e.event_type === 'task-result-recorded');
        expect(recorded?.payload).toMatchObject({
          token_usage: { input_tokens: 19264, output_tokens: 4118, total_tokens: 23382 },
        });
      });

      it('refuses one token flag without the other rather than guessing the missing half', async () => {
        const result = await gateRunWith(AGENT_HALF, [...NO_TOKEN_FLAGS, '--input-tokens', '100']);
        expect(result.status).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('results.partial-token-count');
        expect(error.message).toContain('output_tokens');
      });
    });

    describe('gate run budget (P9-18)', () => {
      async function budgetRun(opts: { withPlan: boolean }): Promise<{
        status: number;
        outcome: { budgetCheck?: Record<string, unknown> };
        records: ReturnType<typeof tail>;
      }> {
        const { sessionId, eventsDir } = await session();
        // A committed worktree, not the scratch dir: the P9-8 commit
        // certificate runs ahead of the budget check, so a bare directory
        // blocks on `not-committed` and never gets one. Its base branch does
        // not exist here, which is the point of the `unmeasurable` half — the
        // token cap is still read, and still overrun.
        const worktreeDir = await committedWorktree(`p9-18-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-b-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-b-result.json`);
        const planPath = path.join(scratchDir, `${sessionId}-b-plan.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        // A cap the run has already blown, so a passing assertion can only mean
        // the number was read off this file and not defaulted from anywhere.
        await writeFile(
          planPath,
          JSON.stringify({
            ...PLAN,
            tasks: PLAN.tasks.map((t) => ({ ...t, budget: { tokens: 100, diff_lines: 100 } })),
          }),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          ...(opts.withPlan ? ['--plan', planPath] : []),
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        return {
          status: result.status,
          outcome: JSON.parse(result.stdout),
          records: tail(sessionId, eventsDir),
        };
      }

      it('checks the gated task’s declared caps against what the run actually spent', async () => {
        const { status, outcome, records } = await budgetRun({ withPlan: true });

        // Recorded, not blocking: an overrun is as often evidence the plan
        // under-estimated the task as evidence the task overran.
        expect(status).toBe(0);
        expect(outcome.budgetCheck).toMatchObject({
          tokensUsed: 150,
          overruns: [{ field: 'tokens', cap: 100, measured: 150 }],
        });

        const events = records.filter((r) => r.event_type === 'budget-check-result');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toMatchObject({
          overruns: [{ field: 'tokens', cap: 100, measured: 150 }],
        });
      });

      it('says the budget was never declared rather than inventing one', async () => {
        const { status, outcome, records } = await budgetRun({ withPlan: false });

        expect(status).toBe(0);
        expect(outcome.budgetCheck).toMatchObject({ status: 'not-declared', overruns: [] });
        // Still emitted. A check that ran and found nothing to check is a
        // different fact from a check that never ran, and only one of them is
        // visible if the no-op stays silent (P9-23).
        expect(records.filter((r) => r.event_type === 'budget-check-result')).toHaveLength(1);
      });
    });

    // #294: a plan holds every superseded copy of a task alongside its live
    // replacement (D-121), and `budgetFromFlags`/`uiAffectingFromFlags`/`uiux
    // check` used a bare `plan.tasks.find`, which answers with whichever
    // record `plan amend` happened to write first — the dead one. These read
    // through `liveSpec` instead, the same rule `livePlanTasks` already
    // applies for every other reader (plan.ts:~930).
    describe('gate reads the live plan row, not a superseded one (#294)', () => {
      /** The two-row fixture: a dead copy of task-1, then its live replacement. */
      function supersededAndLivePlan(overrides: {
        superseded: Record<string, unknown>;
        live: Record<string, unknown>;
      }) {
        const [task1, ...rest] = PLAN.tasks;
        return {
          ...PLAN,
          tasks: [
            { ...task1, task_status: 'superseded', ...overrides.superseded },
            { ...task1, task_status: 'todo', ...overrides.live },
            ...rest,
          ],
        };
      }

      it('gate run budget check uses the live diff_lines cap, not a superseded one', async () => {
        const { sessionId, eventsDir } = await session();
        const worktreeDir = await committedWorktree(`p9-294-budget-${sessionId}`);
        // Widen the diff past the superseded row's cap (100) but keep it under
        // the live row's cap (300): only the live cap passes it.
        await writeFile(
          path.join(worktreeDir, 'wide.ts'),
          `${Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
        );
        git(worktreeDir, ['add', '.']);
        git(worktreeDir, ['commit', '-q', '-m', 'widen diff']);

        const checksPath = path.join(scratchDir, `${sessionId}-live-budget-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-live-budget-result.json`);
        const planPath = path.join(scratchDir, `${sessionId}-live-budget-plan.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        await writeFile(
          planPath,
          JSON.stringify(
            supersededAndLivePlan({
              superseded: { budget: { tokens: 1000, diff_lines: 100 } },
              live: { budget: { tokens: 1000, diff_lines: 300 } },
            }),
          ),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          // Without an explicit base, measureDiff derives one from the branch
          // name convention (smith/<epic>/integration), which committedWorktree
          // never creates — the diff would stay unmeasurable rather than
          // exercise the cap this test is about.
          '--base',
          'main',
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);

        expect(result.status).toBe(0);
        const outcome = JSON.parse(result.stdout);
        // Reading the superseded row's diff_lines: 100 cap would have reported
        // an overrun here; the live row's 300 cap passes it.
        expect(outcome.budgetCheck.overruns).toEqual([]);
      });

      it('gate run and uiux check resolve ui_affecting off the live row, not a superseded one', async () => {
        const { sessionId, eventsDir } = await session();
        const worktreeDir = await committedWorktree(`p9-294-ui-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-live-ui-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-live-ui-result.json`);
        const planPath = path.join(scratchDir, `${sessionId}-live-ui-plan.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        // The superseded row says ui_affecting: false; the live replacement
        // says true. A reader stuck on the superseded row would skip the uiux
        // stage entirely instead of blocking on the missing screenshot set.
        await writeFile(
          planPath,
          JSON.stringify(
            supersededAndLivePlan({
              superseded: { ui_affecting: false },
              live: { ui_affecting: true },
            }),
          ),
        );

        const check = runCli([
          'uiux',
          'check',
          '--task',
          'epic-1/task-1',
          '--plan',
          planPath,
          '--worktree',
          worktreeDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(check.status).toBe(1);
        expect(JSON.parse(check.stdout)).toEqual({
          outcome: 'blocked',
          reason: 'uiux-spec-missing',
        });

        const gate = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(gate.status).toBe(1);
        expect(JSON.parse(gate.stdout).reason).toBe('uiux-spec-missing');
      });
    });

    // D-32/P9-13. A task normally has several judges, and `gate run` paired one
    // `--evidence` with one `--found-by`, so passing two judges' findings
    // through one gate meant concatenating them under a single attribution —
    // which makes at least one attribution false. Attribution feeds the
    // same-mistake quorum trigger, so a false one is a wrong decision later,
    // not a cosmetic label.
    describe('gate run multi-judge evidence (D-32/P9-13)', () => {
      function evidence(filePath: string, summary: string) {
        return [
          {
            file_path: filePath,
            finding_category: 'correctness',
            severity: 'S2-major',
            summary,
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ];
      }

      /** The worktree and the two files a gate run needs before it will look at any evidence. */
      async function gateFixture(sessionId: string): Promise<[string, string, string]> {
        const worktreeDir = await committedWorktree(`p9-13-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        return [worktreeDir, checksPath, resultPath];
      }

      async function evidenceFile(name: string, body: unknown): Promise<string> {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(body));
        return filePath;
      }

      // Both findings are about src/bar/*.ts, which the plan gives to task-2:
      // the gate run being about task-1 is the point (this is how the real one
      // went), and it keeps the outcome unblocked so the assertions are about
      // attribution rather than about the testgate.
      it('mints each --evidence under the --found-by written after it', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const reviewer = await evidenceFile(
          `${sessionId}-reviewer`,
          evidence('src/bar/one.ts', 'off-by-one in loop bound'),
        );
        const security = await evidenceFile(
          `${sessionId}-security`,
          evidence('src/bar/two.ts', 'totality violation on the error branch'),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          reviewer,
          '--found-by',
          'reviewer',
          '--evidence',
          security,
          '--found-by',
          'security-reviewer',
          '--found-by-provider',
          'codex',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir)
          .filter((r) => r.event_type === 'finding-raised')
          .map((r) => r.payload);
        // The finding carries the path only inside its fingerprint, so the
        // summary is what names which judge's evidence each record came from.
        expect(raised.map((f) => [f.summary, f.found_by, f.found_by_provider ?? null])).toEqual([
          ['off-by-one in loop bound', 'reviewer', null],
          ['totality violation on the error branch', 'security-reviewer', 'codex'],
        ]);
      });

      // The pre-P9-13 line — role before evidence — is what the skill, the docs
      // and every existing caller write. Flags were order-independent, so making
      // them positional must not turn a valid invocation into an error.
      it('still accepts the single-judge line with --found-by written first', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const only = await evidenceFile(
          `${sessionId}-legacy`,
          evidence('src/bar/one.ts', 'off-by-one in loop bound'),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--found-by',
          'reviewer',
          '--evidence',
          only,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(1);
        expect(raised[0]?.payload.found_by).toBe('reviewer');
      });

      // The failure this item exists to prevent, in its cheapest form: an
      // evidence file with no role of its own and no leading default. Inheriting
      // the neighbouring judge's role is exactly the false attribution, so it
      // has to be an error that names the file — and it has to happen before any
      // finding is written, or the log carries half a gate run.
      it('refuses an --evidence with no --found-by, naming the file', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const reviewer = await evidenceFile(
          `${sessionId}-attributed`,
          evidence('src/bar/one.ts', 'off-by-one in loop bound'),
        );
        const orphan = await evidenceFile(
          `${sessionId}-orphan`,
          evidence('src/bar/two.ts', 'totality violation on the error branch'),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--evidence',
          reviewer,
          '--found-by',
          'reviewer',
          '--evidence',
          orphan,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const error = JSON.parse(result.stdout).error;
        expect(error.code).toBe('cli.missing-flag');
        expect(error.message).toContain(orphan);
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised')).toEqual(
          [],
        );
      });

      // `findings raise` mints through the same helper and has the same judges.
      // Fixing one call site and not the other would leave the bug wherever the
      // operator happened to record the finding from.
      it('pairs the same way for findings raise', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const reviewer = await evidenceFile(
          `${sessionId}-raise-reviewer`,
          evidence('src/foo/one.ts', 'off-by-one in loop bound'),
        );
        const security = await evidenceFile(
          `${sessionId}-raise-security`,
          evidence('src/foo/two.ts', 'totality violation on the error branch'),
        );

        const result = runCli([
          'findings',
          'raise',
          '--evidence',
          reviewer,
          '--found-by',
          'reviewer',
          '--evidence',
          security,
          '--found-by',
          'security-reviewer',
          '--task',
          'epic-1/task-1',
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir)
          .filter((r) => r.event_type === 'finding-raised')
          .map((r) => r.payload);
        expect(raised.map((f) => f.found_by)).toEqual(['reviewer', 'security-reviewer']);
      });
    });

    // S2: `--uiux-visual` hands over a uiux visual pass's Result document
    // (not a findings-evidence array) and must follow the same severity
    // policy as every other judge's evidence.
    describe('gate run --uiux-visual (uiux turn kinds)', () => {
      async function gateFixture(sessionId: string): Promise<[string, string, string]> {
        const worktreeDir = await committedWorktree(`uiux-visual-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        return [worktreeDir, checksPath, resultPath];
      }

      // The screenshot path has to fall under epic-1/task-1's claims
      // (src/foo/*.ts in the shared PLAN fixture) for the gate to score the
      // deviation against the task being gated instead of filing it as an
      // unclaimed follow-up (D-41/P9-24's ownership check, exercised above
      // with --evidence findings the same way).
      function deviation(overrides: Record<string, unknown> = {}) {
        return {
          screenshot: 'src/foo/screenshot-desktop-light.ts',
          viewport: 'desktop',
          theme: 'light',
          dimension: 'layout_spacing',
          severity: 'S3-minor',
          expected: '16px gutter',
          observed: '8px gutter',
          ...overrides,
        };
      }

      async function visualFile(name: string, deviations: unknown[]): Promise<string> {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(
          filePath,
          JSON.stringify({ run_status: 'done', structured_output: { deviations } }),
        );
        return filePath;
      }

      it('blocks the gate on an S2 deviation', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const visual = await visualFile(`${sessionId}-visual-s2`, [
          deviation({ severity: 'S2-major', dimension: 'accessibility' }),
        ]);

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--uiux-visual',
          visual,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);

        const raised = tail(sessionId, eventsDir)
          .filter((r) => r.event_type === 'finding-raised')
          .map((r) => r.payload);
        expect(raised).toHaveLength(1);
        expect(raised[0]?.found_by).toBe('uiux');
        expect(raised[0]?.finding_category).toBe('a11y');
        expect(raised[0]?.severity).toBe('S2-major');
      });

      it('does not block the gate on an S3 deviation', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const visual = await visualFile(`${sessionId}-visual-s3`, [
          deviation({ severity: 'S3-minor' }),
        ]);

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--uiux-visual',
          visual,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir)
          .filter((r) => r.event_type === 'finding-raised')
          .map((r) => r.payload);
        expect(raised).toHaveLength(1);
        expect(raised[0]?.finding_category).toBe('visual-design');
        expect(raised[0]?.severity).toBe('S3-minor');
      });

      // S2: a document with no `deviations` array, or one where it is not an
      // array, used to mint nothing and let the gate pass silently. It must
      // be refused the same way `readJudgeArtifact`'s uiux visual branch
      // refuses it (judges.ts), not treated as a clean pass.
      it('rejects a uiux visual document with no structured_output.deviations', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const visualPath = path.join(scratchDir, `${sessionId}-visual-missing.json`);
        await writeFile(visualPath, JSON.stringify({ run_status: 'done', structured_output: {} }));

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--uiux-visual',
          visualPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('judges.artifact-invalid-evidence');

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(0);
      });

      it('rejects a uiux visual document whose deviations is not an array', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const visualPath = path.join(scratchDir, `${sessionId}-visual-not-array.json`);
        await writeFile(
          visualPath,
          JSON.stringify({ run_status: 'done', structured_output: { deviations: 'none' } }),
        );

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--uiux-visual',
          visualPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('judges.artifact-invalid-evidence');

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(0);
      });

      it('accepts an explicit empty deviations array as a clean pass', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        const visual = await visualFile(`${sessionId}-visual-empty`, []);

        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--uiux-visual',
          visual,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);

        const raised = tail(sessionId, eventsDir).filter((r) => r.event_type === 'finding-raised');
        expect(raised).toHaveLength(0);
      });

      // The uiux-visual hand-over closes the uiux visual turn exactly the way
      // --evidence closes a reviewer's turn, independent of any spec turn
      // still open on the same task.
      it('closes the open uiux visual turn and leaves a same-task uiux spec turn open', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(sessionId);
        await runCli([
          'judge',
          'dispatch',
          '--role',
          'uiux',
          '--kind',
          'spec',
          '--task',
          'epic-1/task-1',
          '--artifact',
          path.join(scratchDir, 'spec.json'),
          '--model',
          'claude-opus-5',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        const dispatchVisual = runCli([
          'judge',
          'dispatch',
          '--role',
          'uiux',
          '--kind',
          'visual',
          '--task',
          'epic-1/task-1',
          '--artifact',
          path.join(scratchDir, 'visual.json'),
          '--model',
          'claude-opus-5',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#1`,
          '--state-dir',
          eventsDir,
        ]);
        expect(dispatchVisual.status).toBe(0);

        const visual = await visualFile(`${sessionId}-visual-close`, [
          deviation({ severity: 'S3-minor' }),
        ]);
        const result = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--uiux-visual',
          visual,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#2`,
          '--state-dir',
          eventsDir,
        ]);
        // The gate still blocks here — the spec turn is deliberately left
        // open — but that is judges-outstanding on the *spec* turn, not a
        // sign the visual hand-over failed to close its own turn.
        expect(result.status).toBe(1);

        const outstanding = runCli([
          'judge',
          'outstanding',
          '--task',
          'epic-1/task-1',
          '--session',
          sessionId,
          '--state-dir',
          eventsDir,
        ]);
        const payload = JSON.parse(outstanding.stdout) as {
          outstanding: Array<{ kind: string | null }>;
        };
        expect(payload.outstanding.map((t) => t.kind)).toEqual(['spec']);
      });
    });

    // U2 S3/D4: `bs uiux check` is a preflight over the exact same `checkUiux`
    // the gate stage calls, so the two must never disagree about the same
    // fixture -- here, a ui-affecting task with no uiux turns dispatched at
    // all yet, which both must call uiux-spec-missing.
    describe('bs uiux check (agrees with the gate, U2 S3)', () => {
      it('blocks on the same reason the gate stage would block on', async () => {
        const { sessionId, eventsDir } = await session();
        const uiPlan = {
          ...PLAN,
          tasks: PLAN.tasks.map((t) =>
            t.task_id === 'epic-1/task-1' ? { ...t, ui_affecting: true } : t,
          ),
        };
        const planPath = path.join(scratchDir, `${sessionId}-ui-plan.json`);
        await writeFile(planPath, JSON.stringify(uiPlan));

        const worktreeDir = await committedWorktree(`uiux-check-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-ui-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-ui-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );

        const check = runCli([
          'uiux',
          'check',
          '--task',
          'epic-1/task-1',
          '--plan',
          planPath,
          '--worktree',
          worktreeDir,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(check.status).toBe(1);
        expect(JSON.parse(check.stdout)).toEqual({
          outcome: 'blocked',
          reason: 'uiux-spec-missing',
        });

        const gate = runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(gate.status).toBe(1);
        const gateOutcome = JSON.parse(gate.stdout);
        expect(gateOutcome.outcome).toBe('blocked');
        expect(gateOutcome.reason).toBe('uiux-spec-missing');
      });
    });

    // D-42: a project's .blacksmith/crosscheck.yml overlay has to reach the
    // gate the same way it reaches `plan quorum`/`judge preflight` -- the gate
    // is where a blocking finding actually triggers a quorum case
    // (crossCheckFinding, gate.ts), so a provider the overlay turns on has to
    // show up in the `quorum-decision` event the gate emits for it.
    describe('gate run --project / --worktree derivation (D-42)', () => {
      function blockingEvidence(filePath: string, summary: string) {
        return [
          {
            file_path: filePath,
            finding_category: 'correctness',
            severity: 'S2-major',
            summary,
            failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          },
        ];
      }

      async function evidenceFile(name: string, body: unknown): Promise<string> {
        const filePath = path.join(scratchDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(body));
        return filePath;
      }

      /** The worktree and the two files a gate run needs before it will look at any evidence (same shape as the multi-judge fixture above). */
      async function gateFixture(name: string): Promise<[string, string, string]> {
        const worktreeDir = await committedWorktree(`d42-${name}`);
        const checksPath = path.join(scratchDir, `${name}-checks.json`);
        const resultPath = path.join(scratchDir, `${name}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        return [worktreeDir, checksPath, resultPath];
      }

      // Same neutralization as the plan-quorum --project test in cliBasics.test.ts: turn the
      // suite-wide SMITH_CROSSCHECK_OFFLINE switch off (it disables every
      // non-native provider regardless of configSource, including one the
      // overlay adds), then neutralize this dev box's real codex/deepseek/
      // OpenRouter credentials individually so nothing here makes a live call.
      function neutralizeRealProviders(): Record<string, string> {
        const pathWithoutCodex = (process.env.PATH ?? '')
          .split(path.delimiter)
          .filter((dir) => dir.length > 0 && !existsSync(path.join(dir, 'codex')))
          .join(path.delimiter);
        return {
          SMITH_CROSSCHECK_OFFLINE: '',
          PATH: pathWithoutCodex,
          DEEPSEEK_API_KEY: '',
          OPENROUTER_API_KEY: '',
          OPENROUTER_MODELS: '',
        };
      }

      function overlayYaml(): string {
        return [
          'providers:',
          '  deepseek:',
          '    enabled: true',
          '    mode: shadow',
          '    base_url: https://example.invalid',
          '    model: test-model',
          '    api_key_env: SMITH_TEST_KEY_THAT_IS_NEVER_SET',
          '',
        ].join('\n');
      }

      it("--project: reads the project overlay's provider over the shipped policy", async () => {
        const env = neutralizeRealProviders();

        // Without --project: the shipped policy's codex/deepseek both fail
        // their precondition above (PATH stripped, DEEPSEEK_API_KEY blank), so
        // resolveCrosscheck() sees zero enabled providers and never calls
        // runQuorumCase -- no quorum-decision event at all for the finding
        // that blocks this gate run.
        const baseline = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(baseline.sessionId);
        const baselineFinding = await evidenceFile(
          `${baseline.sessionId}-finding`,
          blockingEvidence('src/foo/one.ts', 'off-by-one in loop bound'),
        );
        const withoutProject = runCli(
          [
            'gate',
            'run',
            'epic-1/task-1',
            '--worktree',
            worktreeDir,
            '--checks',
            checksPath,
            '--result',
            resultPath,
            '--evidence',
            baselineFinding,
            '--found-by',
            'reviewer',
            '--plan',
            baseline.planPath,
            '--session',
            baseline.sessionId,
            '--causal-parent',
            `${baseline.sessionId}#0`,
            '--state-dir',
            baseline.eventsDir,
          ],
          env,
        );
        expect(withoutProject.status).toBe(1);
        expect(
          tail(baseline.sessionId, baseline.eventsDir).filter(
            (r) => r.event_type === 'quorum-decision',
          ),
        ).toEqual([]);

        // With --project: the overlay forces deepseek on regardless of its
        // (unmet, by construction) precondition -- parseProvider only gates
        // `enabled: auto`, not an explicit boolean -- so this proves the CLI
        // actually threads --project into runGate()'s crosscheck.policy load,
        // not just that loadCrosscheckPolicy() itself supports a projectDir.
        const projectDir = path.join(scratchDir, `${baseline.sessionId}-project-overlay`);
        await mkdir(path.join(projectDir, '.blacksmith'), { recursive: true });
        await writeFile(path.join(projectDir, '.blacksmith', 'crosscheck.yml'), overlayYaml());

        const overlay = await session();
        const [overlayWorktreeDir, overlayChecksPath, overlayResultPath] = await gateFixture(
          overlay.sessionId,
        );
        const overlayFinding = await evidenceFile(
          `${overlay.sessionId}-finding`,
          blockingEvidence('src/foo/one.ts', 'off-by-one in loop bound'),
        );
        const withProject = runCli(
          [
            'gate',
            'run',
            'epic-1/task-1',
            '--worktree',
            overlayWorktreeDir,
            '--checks',
            overlayChecksPath,
            '--result',
            overlayResultPath,
            '--evidence',
            overlayFinding,
            '--found-by',
            'reviewer',
            '--project',
            projectDir,
            '--plan',
            overlay.planPath,
            '--session',
            overlay.sessionId,
            '--causal-parent',
            `${overlay.sessionId}#0`,
            '--state-dir',
            overlay.eventsDir,
          ],
          env,
        );
        // Still blocked -- resolveApiKey() throws before any fetch (the api
        // transport, same as the plan-quorum test), so deepseek's run comes
        // back ok:false and never overturns the finding. What proves --project
        // worked is the quorum-decision event naming a provider that never ran
        // in the baseline above.
        expect(withProject.status).toBe(1);
        const decisions = tail(overlay.sessionId, overlay.eventsDir)
          .filter((r) => r.event_type === 'quorum-decision')
          .map((r) => r.payload);
        expect(decisions).toHaveLength(1);
        const participants = decisions[0]?.participants as Array<{
          provider: string;
          mode: string;
          ok: boolean;
          verdict: string | null;
        }>;
        const overlayParticipant = participants.find((p) => p.provider === 'deepseek');
        expect(overlayParticipant).toMatchObject({ mode: 'shadow', ok: false, verdict: null });
      });

      it('derives --project from --worktree when --project is omitted', async () => {
        const env = neutralizeRealProviders();

        // committedWorktree() hands back a plain, self-contained git repo (its
        // own `git init`), not a `.wt/<project>/<task>` sibling layout -- but
        // that is exactly what makes it a fair worktree-derivation fixture:
        // `git rev-parse --git-common-dir` inside it resolves to its own
        // `.git`, so projectDirFromFlags() derives the worktree's own root as
        // the project dir. Dropping the overlay there proves derivation reads
        // `--worktree` when `--project` is absent, not that a copy of the
        // explicit-flag test happens to also pass. It has to be committed, not
        // just written: certifyCommit() (commit.ts) reads `git status
        // --untracked-files=all` and blocks the gate on ANY dirty path before
        // a single check runs (D-30/P9-8), so an untracked overlay file would
        // fail the run for "not-committed" before crossCheckFinding ever sees
        // the evidence below.
        const derived = await session();
        const [worktreeDir, checksPath, resultPath] = await gateFixture(derived.sessionId);
        await mkdir(path.join(worktreeDir, '.blacksmith'), { recursive: true });
        await writeFile(path.join(worktreeDir, '.blacksmith', 'crosscheck.yml'), overlayYaml());
        const git = (args: string[]) => runOrThrow('git', args, { cwd: worktreeDir });
        git(['add', '.blacksmith/crosscheck.yml']);
        git(['commit', '-q', '-m', 'add project overlay']);
        const finding = await evidenceFile(
          `${derived.sessionId}-finding`,
          blockingEvidence('src/foo/one.ts', 'off-by-one in loop bound'),
        );

        const result = runCli(
          [
            'gate',
            'run',
            'epic-1/task-1',
            '--worktree',
            worktreeDir,
            '--checks',
            checksPath,
            '--result',
            resultPath,
            '--evidence',
            finding,
            '--found-by',
            'reviewer',
            '--plan',
            derived.planPath,
            '--session',
            derived.sessionId,
            '--causal-parent',
            `${derived.sessionId}#0`,
            '--state-dir',
            derived.eventsDir,
          ],
          env,
        );
        expect(result.status).toBe(1);
        const decisions = tail(derived.sessionId, derived.eventsDir)
          .filter((r) => r.event_type === 'quorum-decision')
          .map((r) => r.payload);
        expect(decisions).toHaveLength(1);
        const participants = decisions[0]?.participants as Array<{
          provider: string;
          mode: string;
          ok: boolean;
          verdict: string | null;
        }>;
        const overlayParticipant = participants.find((p) => p.provider === 'deepseek');
        expect(overlayParticipant).toMatchObject({ mode: 'shadow', ok: false, verdict: null });
      });
    });

    // Same reason as the ownership block above: without `--grader` wired
    // through here, the grader gate exists only in the library, and the grader
    // file goes on being written and never read (D-34/P9-14).
    describe('gate run --grader (D-34/P9-14)', () => {
      async function gateFixtures(sessionId: string): Promise<{
        checksPath: string;
        resultPath: string;
        worktreeDir: string;
      }> {
        // Since D-30/P9-8 the commit certificate runs ahead of the rubric, so
        // these runs need a worktree that actually carries a commit — a bare
        // scratch dir blocks with `not-committed` before the grader is read.
        const worktreeDir = await committedWorktree(`p9-14-${sessionId}`);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        await writeFile(checksPath, JSON.stringify([{ name: 'test', cmd: 'true' }]));
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        return { checksPath, resultPath, worktreeDir };
      }

      function runGateWithGrader(
        sessionId: string,
        eventsDir: string,
        checksPath: string,
        resultPath: string,
        graderPath: string,
        worktreeDir: string,
      ) {
        return runCli([
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--grader',
          graderPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
      }

      it('blocks the gate, and exits 1, when the rubric says a criterion was not met', async () => {
        const { sessionId, eventsDir } = await session();
        const { checksPath, resultPath, worktreeDir } = await gateFixtures(sessionId);
        const graderPath = path.join(scratchDir, `${sessionId}-grader.json`);
        await writeFile(
          graderPath,
          JSON.stringify({
            run_status: 'done',
            structured_output: {
              round: 1,
              criteria: [
                {
                  criterion: 'a bare CR splits a line',
                  status: 'fail',
                  evidence: 'test/parse.test.ts:42 red',
                },
              ],
              overall: 'fail',
              gaps: ['the splitter still treats \\r as ordinary text'],
            },
            artifacts: [],
            token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        );

        const result = runGateWithGrader(
          sessionId,
          eventsDir,
          checksPath,
          resultPath,
          graderPath,
          worktreeDir,
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: 'blocked',
          reason: 'grader-fail',
        });

        const records = tail(sessionId, eventsDir);
        expect(records.filter((r) => r.event_type === 'grader-verdict')[0]?.payload).toMatchObject({
          verdict: 'not-met',
        });
        // The checks never ran: the rubric already decided this diff bounces.
        expect(records.filter((r) => r.event_type === 'testgate-result')).toEqual([]);
      });

      it('passes a met rubric through to the rest of the pipeline', async () => {
        const { sessionId, eventsDir } = await session();
        const { checksPath, resultPath, worktreeDir } = await gateFixtures(sessionId);
        const graderPath = path.join(scratchDir, `${sessionId}-grader.json`);
        await writeFile(
          graderPath,
          JSON.stringify({
            run_status: 'done',
            structured_output: {
              round: 2,
              criteria: [
                {
                  criterion: 'a bare CR splits a line',
                  status: 'pass',
                  evidence: 'test/parse.test.ts:42 green',
                },
              ],
              overall: 'pass',
            },
            artifacts: [],
            token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        );

        const result = runGateWithGrader(
          sessionId,
          eventsDir,
          checksPath,
          resultPath,
          graderPath,
          worktreeDir,
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).outcome).toBe('pass');

        const records = tail(sessionId, eventsDir);
        expect(records.filter((r) => r.event_type === 'grader-verdict')[0]?.payload).toMatchObject({
          verdict: 'met',
          round: 2,
        });
        expect(records.filter((r) => r.event_type === 'testgate-result')).toHaveLength(1);
      });
    });

    // D-30/P9-8: the gate scored a worktree while the queue merged a branch.
    // `--base` is what lets the CLI ask the second question the queue asks —
    // is this branch actually ahead of the integration head it was cut from.
    describe('gate run commit certification (D-30/P9-8)', () => {
      async function gateRunFixture(name: string) {
        const { sessionId, eventsDir } = await session();
        const worktreeDir = await committedWorktree(name);
        const checksPath = path.join(scratchDir, `${sessionId}-checks.json`);
        const resultPath = path.join(scratchDir, `${sessionId}-result.json`);
        // `touch ran-anyway.txt` rather than `true`: the certificate is only
        // worth anything if it lands before the checks spend a test run.
        await writeFile(
          checksPath,
          JSON.stringify([{ name: 'test', cmd: 'touch ran-anyway.txt' }]),
        );
        await writeFile(
          resultPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            agent: 'coder',
            provider: 'claude',
            model_tier: 'mid',
          }),
        );
        const argv = (extra: string[]) => [
          'gate',
          'run',
          'epic-1/task-1',
          '--worktree',
          worktreeDir,
          '--checks',
          checksPath,
          '--result',
          resultPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
          ...extra,
        ];
        return { sessionId, eventsDir, worktreeDir, argv };
      }

      it('exits 1 and names the uncommitted paths, before any check runs', async () => {
        const { worktreeDir, argv } = await gateRunFixture('gate-dirty');
        await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 2;\n');

        const result = runCli(argv([]));

        expect(result.status).toBe(1);
        const outcome = JSON.parse(result.stdout);
        expect(outcome).toMatchObject({
          outcome: 'blocked',
          reason: 'not-committed',
          commitCheck: { certified: false, reason: 'uncommitted-work', dirty: ['src.ts'] },
        });
        expect(existsSync(path.join(worktreeDir, 'ran-anyway.txt'))).toBe(false);
      });

      it('--base refuses a branch head that still equals the base it was cut from', async () => {
        const { worktreeDir, argv, sessionId, eventsDir } = await gateRunFixture('gate-base');
        runOrThrow('git', ['checkout', '-q', '-b', 'smith/epic-1/task-9'], { cwd: worktreeDir });

        const result = runCli(argv(['--base', 'smith/epic-1/gate-base']));

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: 'blocked',
          reason: 'not-committed',
          commitCheck: { reason: 'branch-not-advanced', commitsAhead: 0 },
        });
        const check = tail(sessionId, eventsDir).find(
          (r) => r.event_type === 'commit-check-result',
        );
        expect(check?.payload).toMatchObject({
          certified: false,
          base_ref: 'smith/epic-1/gate-base',
          commits_ahead: 0,
        });
      });

      it('passes without --base rather than inventing a base to measure against', async () => {
        const { argv } = await gateRunFixture('gate-nobase');

        const result = runCli(argv([]));

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: 'pass',
          commitCheck: { certified: true, baseRef: null, commitsAhead: null },
        });
      });
    });
  });
});
