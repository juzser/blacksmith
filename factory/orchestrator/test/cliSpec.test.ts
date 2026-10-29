import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOAL_CHECK_EVENT } from '../src/goalCheck.js';
import { runCli, taskStatusFixtures } from './helpers/cliHarness.js';
import { runOrThrow } from './helpers/process.js';

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

  describe('task-status producers (D-46/P9-29)', () => {
    const { PLAN, session, tail, ingest, append } = taskStatusFixtures(() => scratchDir);

    // The other side of the same wall. `plan amend` above is the operator's
    // exit from a spec defect; these four verbs are the worker's way of
    // reaching it. A coder cannot emit an event and cannot mint a spec-scoped
    // finding, so it returns the request and the dispatcher records it.
    describe('living spec: worker-proposed amendments', () => {
      const CRITERION = 'epic-1/task-2:criterion-1';

      /** The diff a worker would propose: task-2's criterion, restated. */
      function proposedChanges() {
        return {
          supersede: {
            'epic-1/task-2': {
              ...PLAN.tasks[1],
              acceptance_criteria: ['parses `A="x\\ny"` into a single entry'],
            },
          },
        };
      }

      async function requestFile(
        name: string,
        overrides: Record<string, unknown> = {},
      ): Promise<string> {
        const filePath = path.join(scratchDir, `${name}-request.json`);
        await writeFile(
          filePath,
          JSON.stringify({
            criterion_ref: CRITERION,
            assumption: 'a .env value never spans two physical lines',
            evidence: 'src/bar/thing.ts:41 reads line by line and never rewinds',
            changes: proposedChanges(),
            sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
            blocking: true,
            ...overrides,
          }),
        );
        return filePath;
      }

      async function propose(
        name: string,
        s: { sessionId: string; eventsDir: string; planPath: string },
        specsDir: string,
        overrides: Record<string, unknown> = {},
      ) {
        return runCli([
          'plan',
          'propose',
          '--plan',
          s.planPath,
          '--task',
          'epic-1/task-2',
          '--proposed-by',
          'coder',
          '--request',
          await requestFile(name, overrides),
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
      }

      it('records a proposal, raises the finding that anchors it, and cuts no version', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-propose-specs`);

        const result = await propose('cli-propose', s, specsDir);
        expect(result.status).toBe(0);
        const proposal = JSON.parse(result.stdout);
        expect(proposal).toMatchObject({
          epicId: 'epic-1',
          taskId: 'epic-1/task-2',
          baseVersion: 1,
          proposedBy: 'coder',
          criterionRef: CRITERION,
          blocking: true,
          status: 'open',
          decision: null,
          // Defaulted above the waivable band (D-196), so a standing waiver
          // cannot swallow the finding the amendment would have to cite.
          severity: 'S2-major',
          diff: { superseded: ['epic-1/task-2'] },
        });
        expect(proposal.proposalId).toBeTruthy();
        expect(proposal.findingId).toBeTruthy();

        const records = tail(s.sessionId, s.eventsDir);
        expect(records.filter((r) => r.event_type === 'spec-change-proposed')).toHaveLength(1);
        // A proposal is data, not a command: the finding exists so the
        // amendment has something to cite, and nothing else has moved.
        expect(records.filter((r) => r.event_type === 'finding-raised')).toHaveLength(1);
        expect(records.filter((r) => r.event_type === 'plan-version-created')).toEqual([]);
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
      });

      it('refuses a diff that could never be applied, while the worker is still there to be told', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-badpropose-specs`);

        const result = await propose('cli-propose-bad', s, specsDir, {
          changes: {
            supersede: { 'epic-1/task-2': { ...PLAN.tasks[1], case: 'not-a-real-case' } },
          },
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('spec-change.proposal-invalid-draft');
        // Refused before the anchor is minted: an unappliable proposal must
        // not leave a finding behind waiting on an amendment nobody can cut.
        expect(
          tail(s.sessionId, s.eventsDir).filter((r) => r.event_type === 'finding-raised'),
        ).toEqual([]);
      });

      it('lists open proposals with the diff the operator has to answer', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-list-specs`);
        expect((await propose('cli-list', s, specsDir)).status).toBe(0);

        const listed = runCli([
          'plan',
          'proposals',
          '--session',
          s.sessionId,
          '--status',
          'open',
          '--specs-dir',
          specsDir,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(listed.status).toBe(0);
        const open = JSON.parse(listed.stdout);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
          status: 'open',
          criterionRef: CRITERION,
          sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
          diff: { superseded: ['epic-1/task-2'] },
        });
        // The whole diff, not a reference to it: the operator's next move is
        // yes or no on this object.
        expect(open[0].changes.supersede['epic-1/task-2']).toBeTruthy();

        const filtered = runCli([
          'plan',
          'proposals',
          '--session',
          s.sessionId,
          '--task',
          'epic-1/task-1',
          '--specs-dir',
          specsDir,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(filtered.status).toBe(0);
        expect(JSON.parse(filtered.stdout)).toEqual([]);
      });

      it('approves in one command: the amendment cites the finding and diff the worker recorded', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-approve-specs`);
        const proposed = await propose('cli-approve', s, specsDir);
        expect(proposed.status).toBe(0);
        const { proposalId, findingId } = JSON.parse(proposed.stdout);

        // No --changes, no --sites, no --rationale. That is the whole of
        // "approve it fast": everything `plan amend` demands was recorded by
        // the
        // worker that hit the wall, so approval supplies it rather than
        // asking the operator to reconstruct it.
        const result = runCli([
          'plan',
          'approve',
          proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          proposalId,
          epic: 'epic-1',
          version: 2,
          previousVersion: 1,
          findingIds: [findingId],
          sites: ['src/bar/thing.ts', 'src/elsewhere/same-shape.ts'],
          sitesUnclaimed: ['src/elsewhere/same-shape.ts'],
        });

        // Immutable and on disk, cut by the one code path that cuts versions.
        const written = JSON.parse(
          await readFile(path.join(specsDir, 'epic-1', 'plan-v2.json'), 'utf8'),
        ) as { version: number };
        expect(written.version).toBe(2);

        const records = tail(s.sessionId, s.eventsDir);
        const cut = records.filter((r) => r.event_type === 'plan-version-created');
        expect(cut).toHaveLength(1);
        expect(cut[0]?.payload).toMatchObject({
          version: 2,
          amends: [{ finding_id: findingId, criterion_ref: CRITERION }],
        });
        // The rationale the operator never typed: the worker's own argument,
        // which is the thing they actually agreed with.
        expect(
          String((cut[0]?.payload as { rationale?: string } | undefined)?.rationale),
        ).toContain('a .env value never spans two physical lines');
        const decided = records.filter((r) => r.event_type === 'spec-change-decided');
        expect(decided).toHaveLength(1);
        expect(decided[0]?.payload).toMatchObject({
          proposal_id: proposalId,
          decision: 'approved',
          decided_by: 'operator',
          plan_version: 2,
        });

        // And it is answered: a second approval of the same proposal is not a
        // second version.
        const again = runCli([
          'plan',
          'approve',
          proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(again.status).toBe(1);
        expect(JSON.parse(again.stdout).error.code).toBe('spec-change.already-decided');
      });

      it('defaults --specs-dir to the directory --plan already lives in, not the work root (#287)', async () => {
        const s = await session();
        // A plan filed in the `<specsDir>/<epicId>/plan-vN.json` shape, the
        // same move `plan amend`'s own #219 test makes, so the pre-fix
        // fallback to the work root's specs/active is provably distinct from
        // where this plan actually lives.
        const ownSpecsDir = path.join(scratchDir, `${s.sessionId}-approve-own-specs`);
        const planPath = path.join(ownSpecsDir, 'epic-1', 'plan-v1.json');
        await mkdir(path.dirname(planPath), { recursive: true });
        await writeFile(planPath, JSON.stringify(PLAN));
        const own = { ...s, planPath };

        const proposed = await propose('cli-approve-default-dir', own, ownSpecsDir);
        expect(proposed.status).toBe(0);
        const { proposalId } = JSON.parse(proposed.stdout);

        // A work root of its own, so the pre-fix default (the work root's
        // specs/active) is provably distinct from `ownSpecsDir`.
        const smithHome = path.join(scratchDir, `${s.sessionId}-approve-smith-home`);

        const result = runCli(
          [
            'plan',
            'approve',
            proposalId,
            '--plan',
            planPath,
            '--decided-by',
            'operator',
            '--session',
            s.sessionId,
            '--causal-parent',
            `${s.sessionId}#0`,
            '--state-dir',
            s.eventsDir,
          ],
          { SMITH_HOME: smithHome },
        );

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ epic: 'epic-1', version: 2 });
        expect(existsSync(path.join(ownSpecsDir, 'epic-1', 'plan-v2.json'))).toBe(true);
        expect(
          existsSync(path.join(smithHome, 'factory', 'specs', 'active', 'epic-1', 'plan-v2.json')),
        ).toBe(false);
      });

      it('refuses a proposal a newer version has already overtaken, and says which one', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-stale-specs`);
        const first = await propose('cli-stale-a', s, specsDir);
        const second = await propose('cli-stale-b', s, specsDir);
        expect(first.status).toBe(0);
        expect(second.status).toBe(0);

        // Approve one. The other was written against v1, which no longer
        // describes the plan its diff would be applied to.
        const approved = runCli([
          'plan',
          'approve',
          JSON.parse(first.stdout).proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(approved.status).toBe(0);

        const stale = runCli([
          'plan',
          'approve',
          JSON.parse(second.stdout).proposalId,
          '--plan',
          s.planPath,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(stale.status).toBe(1);
        const error = JSON.parse(stale.stdout).error;
        expect(error.code).toBe('spec-change.approval-stale');
        // Named, not merely refused: the operator's next move is to re-propose
        // against v2, and the message is where they learn that.
        expect(error.message).toContain('v2');
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v3.json'))).toBe(false);

        // And the listing agrees with the refusal rather than still offering it.
        const listed = runCli([
          'plan',
          'proposals',
          '--session',
          s.sessionId,
          '--status',
          'open',
          '--specs-dir',
          specsDir,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(listed.status).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual([]);
      });

      it('rejects a proposal: the anchor finding is refuted and no version is cut', async () => {
        const s = await session();
        const specsDir = path.join(scratchDir, `${s.sessionId}-reject-specs`);
        const proposed = await propose('cli-reject', s, specsDir);
        expect(proposed.status).toBe(0);
        const { proposalId, findingId } = JSON.parse(proposed.stdout);

        const bare = runCli([
          'plan',
          'reject',
          proposalId,
          '--decided-by',
          'operator',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        // Required, unlike on approve: the log already holds the case for.
        expect(bare.status).toBe(1);
        expect(bare.stdout).toContain('rationale');

        const result = runCli([
          'plan',
          'reject',
          proposalId,
          '--decided-by',
          'operator',
          '--rationale',
          'the reader is line-oriented by contract; multi-line values are out of scope for v1',
          '--specs-dir',
          specsDir,
          '--session',
          s.sessionId,
          '--causal-parent',
          `${s.sessionId}#0`,
          '--state-dir',
          s.eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          proposalId,
          status: 'rejected',
          decision: { decision: 'rejected', decidedBy: 'operator', planVersion: null },
        });

        const records = tail(s.sessionId, s.eventsDir);
        expect(records.filter((r) => r.event_type === 'plan-version-created')).toEqual([]);
        expect(existsSync(path.join(specsDir, 'epic-1', 'plan-v2.json'))).toBe(false);
        // The finding does not outlive the answer. Left raised, it would block
        // the epic gate over a criterion the operator has just said is fine.
        const transitioned = records.filter((r) => r.event_type === 'finding-transitioned');
        expect(transitioned).toHaveLength(1);
        expect(transitioned[0]?.payload).toMatchObject({
          finding_id: findingId,
          to_status: 'refuted',
        });
      });
    });

    // B3. Every gate before this one grades planner-authored text against
    // planner-authored text: the spec review reads the plan, the schema gate
    // reads the task's own output schema, the reviewer reads the criteria the
    // planner wrote. `epic goal-check` is the one that reads the roadmap goal
    // the operator wrote before planning began, so a plan that decomposes the
    // wrong problem has somewhere to fail.
    describe('the spec-vs-goal gate', () => {
      const GOAL = 'Load config from .env files. Reject unbalanced quotes.';
      const CLAUSES = ['Load config from .env files.', 'Reject unbalanced quotes.'];

      /** A roadmap whose one milestone owns epic-1. Pass null to drop the goal. */
      async function roadmap(name: string, goalLine: string | null = `- goal: ${GOAL}`) {
        const filePath = path.join(scratchDir, `${name}-roadmap.md`);
        await writeFile(
          filePath,
          [
            '## Phase 1 — Config',
            '- id: phase-1-config',
            '- status: in-progress',
            ...(goalLine === null ? [] : [goalLine]),
            '- epics: [epic-1]',
            '',
          ].join('\n'),
        );
        return filePath;
      }

      async function coverageFile(name: string, coverage: unknown) {
        const filePath = path.join(scratchDir, `${name}-coverage.json`);
        await writeFile(filePath, JSON.stringify(coverage));
        return filePath;
      }

      function checks(sessionId: string, eventsDir: string) {
        return tail(sessionId, eventsDir).filter((r) => r.event_type === GOAL_CHECK_EVENT);
      }

      it('prints the clause list a coverage map has to answer', async () => {
        const result = runCli([
          'epic',
          'goal',
          '--epic',
          'epic-1',
          '--roadmap-path',
          await roadmap('cli-goal-read'),
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          milestoneId: 'phase-1-config',
          goal: GOAL,
          clauses: CLAUSES,
          digest: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
      });

      it('keeps `epic goal` read-only by declaring no flag a write would need', async () => {
        // The check that bites here is D-132's: a flag no usage line declares
        // is a refusal, so the day this command starts appending an event it
        // fails until someone declares --session and says why.
        const { sessionId } = await session();
        const result = runCli([
          'epic',
          'goal',
          '--epic',
          'epic-1',
          '--roadmap-path',
          await roadmap('cli-goal-readonly'),
          '--session',
          sessionId,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.unknown-flag');
      });

      it('records a plan checked clause by clause against the goal', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-ok'),
          '--coverage',
          await coverageFile('cli-goal-ok', [
            { clause: CLAUSES[0], verdict: 'covered', taskIds: ['epic-1/task-1'] },
            { clause: CLAUSES[1], verdict: 'covered', taskIds: ['epic-1/task-2'] },
          ]),
          '--checked-by',
          'spec-reviewer',
          '--checked-by-provider',
          'gemini',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          epicId: 'epic-1',
          milestoneId: 'phase-1-config',
          planVersion: 1,
          checkedBy: 'spec-reviewer',
          findingIds: [],
        });

        const recorded = checks(sessionId, eventsDir);
        expect(recorded).toHaveLength(1);
        // The check is epic-level work, so it is filed against the epic's
        // integration task rather than any one task it graded.
        expect(recorded[0]?.task_id).toBe('epic-1/integration');
        expect(recorded[0]?.payload).toMatchObject({
          epic_id: 'epic-1',
          milestone_id: 'phase-1-config',
          checked_by: 'spec-reviewer',
          checked_by_provider: 'gemini',
          clause_count: 2,
          uncovered_count: 0,
          out_of_scope_count: 0,
          finding_count: 0,
        });
      });

      it('turns an uncovered clause into a spec finding against the plan', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-gap'),
          '--coverage',
          await coverageFile('cli-goal-gap', [
            { clause: CLAUSES[0], verdict: 'covered', taskIds: ['epic-1/task-1'] },
            { clause: CLAUSES[1], verdict: 'uncovered' },
          ]),
          '--checked-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        // Exit 0 for the reason `epic spec-review` exits 0 on a finding: the
        // check ran. What blocks the epic is the finding, and `plan amend` is
        // the verb that answers it.
        expect(result.status).toBe(0);
        const record = JSON.parse(result.stdout) as { findingIds: string[] };
        expect(record.findingIds).toHaveLength(1);

        const listed = JSON.parse(
          runCli([
            'findings',
            'list',
            '--session',
            sessionId,
            '--epic',
            'epic-1',
            '--state-dir',
            eventsDir,
          ]).stdout,
        ) as Record<string, unknown>[];
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
          finding_id: record.findingIds[0],
          severity: 'S2-major',
          finding_scope: 'spec',
          // Anchored to the plan file, not to any source file: the defect is
          // that the plan never promised the clause, so no diff can hold it.
          file_path: 'factory/specs/active/epic-1/plan-v1.json',
          spec_ref: { plan_version: 1, criterion_ref: 'goal:phase-1-config#2' },
        });
      });

      it('refuses to record a check against a milestone that states no goal', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-none', null),
          '--coverage',
          await coverageFile('cli-goal-none', []),
          '--checked-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('cli.no-epic-goal');
        // A recorded check against nothing would read, at the epic gate, as a
        // check that passed. The gate's own blocker is what has to fire here.
        expect(checks(sessionId, eventsDir)).toEqual([]);
      });

      it('refuses coverage credited to a task the plan does not have', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        const result = runCli([
          'epic',
          'goal-check',
          '--epic',
          'epic-1',
          '--plan',
          planPath,
          '--roadmap-path',
          await roadmap('cli-goal-phantom'),
          '--coverage',
          await coverageFile('cli-goal-phantom', [
            { clause: CLAUSES[0], verdict: 'covered', taskIds: ['epic-1/task-1'] },
            { clause: CLAUSES[1], verdict: 'covered', taskIds: ['epic-1/task-9'] },
          ]),
          '--checked-by',
          'spec-reviewer',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('goal-check.unknown-task');
        // Validate before acting: the first clause was answerable, and it
        // still leaves no half-written record behind.
        expect(checks(sessionId, eventsDir)).toEqual([]);
        expect(
          JSON.parse(
            runCli([
              'findings',
              'list',
              '--session',
              sessionId,
              '--epic',
              'epic-1',
              '--state-dir',
              eventsDir,
            ]).stdout,
          ),
        ).toEqual([]);
      });

      // A task that finished before the epic's last amendment is dropped from
      // the latest plan version outright (draftNextVersion), so the latest
      // live roster alone leaves its work nowhere a clause may cite it. The
      // log is what earns the credit: a plan row's own `completed` never does.
      describe('a task finished before the last amendment', () => {
        const row = (id: string, status: string) => ({ task_id: id, task_status: status });
        const FINISHED = 'epic-1/task-1';
        const KEPT = [row('epic-1/task-2', 'todo')];

        /** plan-v1 holds task-1 and task-2; plan-v2 (the --plan file) holds what `latest` says. */
        async function specsWith(name: string, latest: ReturnType<typeof row>[]) {
          const specsDir = path.join(scratchDir, `${name}-specs`);
          await mkdir(path.join(specsDir, 'epic-1'), { recursive: true });
          const v1 = {
            epic_id: 'epic-1',
            version: 1,
            status: 'active',
            edges: [],
            tasks: [row(FINISHED, 'completed'), row('epic-1/task-2', 'todo')],
          };
          const v2 = { ...v1, version: 2, tasks: latest };
          await writeFile(path.join(specsDir, 'epic-1', 'plan-v1.json'), JSON.stringify(v1));
          await writeFile(path.join(specsDir, 'epic-1', 'plan-v2.json'), JSON.stringify(v2));
          return { specsDir, planPath: path.join(specsDir, 'epic-1', 'plan-v2.json') };
        }

        function goalCheck(
          s: { sessionId: string; eventsDir: string },
          specs: { specsDir: string; planPath: string },
          roadmapPath: string,
          coveragePath: string,
        ) {
          return runCli([
            'epic',
            'goal-check',
            '--epic',
            'epic-1',
            '--plan',
            specs.planPath,
            '--specs-dir',
            specs.specsDir,
            '--roadmap-path',
            roadmapPath,
            '--coverage',
            coveragePath,
            '--checked-by',
            'spec-reviewer',
            '--session',
            s.sessionId,
            '--causal-parent',
            `${s.sessionId}#0`,
            '--state-dir',
            s.eventsDir,
          ]);
        }

        const cites = (taskId: string) => [
          { clause: CLAUSES[0], verdict: 'covered', taskIds: [taskId] },
          { clause: CLAUSES[1], verdict: 'covered', taskIds: ['epic-1/task-2'] },
        ];

        function merge(s: { sessionId: string; eventsDir: string }, ids: string[]) {
          append(s.sessionId, s.eventsDir, {
            event_type: 'wave-merged',
            payload: { task_ids: ids },
          });
        }

        it('credits it when the log reports it merged', async () => {
          const s = await session();
          const specs = await specsWith('cli-goal-fin-ok', KEPT);
          merge(s, [FINISHED]);
          const result = goalCheck(
            s,
            specs,
            await roadmap('cli-goal-fin-ok'),
            await coverageFile('cli-goal-fin-ok', cites(FINISHED)),
          );
          expect(result.status).toBe(0);
          expect(checks(s.sessionId, s.eventsDir)).toHaveLength(1);
        });

        const refused: { name: string; setup: string; latest: ReturnType<typeof row>[] }[] = [
          { name: 'never merged in the log', setup: 'none', latest: KEPT },
          { name: 'superseded after its last merge', setup: 'superseded', latest: KEPT },
          { name: 'merged under a bare log id', setup: 'bare', latest: KEPT },
          { name: 'merged under another epic', setup: 'other-epic', latest: KEPT },
          {
            name: 'superseded in the latest version, though merged',
            setup: 'merged',
            latest: [row(FINISHED, 'superseded'), ...KEPT],
          },
        ];
        for (const c of refused) {
          it(`still refuses it when it was ${c.name}`, async () => {
            const s = await session();
            const specs = await specsWith(`cli-goal-fin-${c.setup}`, c.latest);
            if (c.setup === 'merged') merge(s, [FINISHED]);
            if (c.setup === 'superseded') {
              merge(s, [FINISHED]);
              append(s.sessionId, s.eventsDir, {
                event_type: 'task-superseded',
                task_id: FINISHED,
                payload: {},
              });
            }
            if (c.setup === 'bare') merge(s, ['task-1']);
            if (c.setup === 'other-epic') merge(s, ['epic-9/task-1']);
            const result = goalCheck(
              s,
              specs,
              await roadmap(`cli-goal-fin-${c.setup}`),
              await coverageFile(`cli-goal-fin-${c.setup}`, cites(FINISHED)),
            );
            expect(result.status).toBe(1);
            expect(JSON.parse(result.stdout).error.code).toBe('goal-check.unknown-task');
            expect(checks(s.sessionId, s.eventsDir)).toEqual([]);
          });
        }

        it('still refuses an id no plan version ever held', async () => {
          const s = await session();
          const specs = await specsWith('cli-goal-fin-never', KEPT);
          merge(s, ['epic-1/task-9']);
          const result = goalCheck(
            s,
            specs,
            await roadmap('cli-goal-fin-never'),
            await coverageFile('cli-goal-fin-never', cites('epic-1/task-9')),
          );
          expect(result.status).toBe(1);
          expect(JSON.parse(result.stdout).error.code).toBe('goal-check.unknown-task');
        });
      });

      // Same shape as the D-139 check on `epic spec-review`: an undeclared
      // flag is a refusal, so the usage line is load-bearing.
      it('documents every flag epic goal-check requires', () => {
        const { stdout, status } = runCli(['epic', 'goal-check', '--help']);
        expect(status).toBe(0);
        expect(stdout).toContain('--coverage');
        expect(stdout).toContain('--checked-by');
        expect(stdout).toContain('--plan');
      });
    });

    // D-48/P9-31: P9-24 made the factory mint a follow-up task for a bug
    // nobody could own. It could not then execute one: every producer resolved
    // ids through the plan alone, and a plan cut before the finding existed
    // cannot name the follow-up. So the task the factory had just created was
    // refused by `wave check` and by `queue run`, and the only way out was to
    // hand-write the events with `smith event append` — which is how D-41's
    // own follow-up was actually driven to merged.
    describe('a minted follow-up is executable (D-48/P9-31)', () => {
      // Nothing in PLAN claims scripts/, so this finding has no owner and the
      // routing mints a task for it.
      const UNOWNED = [
        {
          file_path: 'scripts/release.sh',
          finding_category: 'correctness',
          severity: 'S2-major',
          summary: 'release script swallows a non-zero exit code',
          failure_scenario: { inputs: 'a failing step', expected: 'exit 1', actual: 'exit 0' },
        },
      ];

      /** Raise the unowned finding and return the follow-up id it minted. */
      async function mintFollowUp(
        sessionId: string,
        eventsDir: string,
        planPath: string,
      ): Promise<string> {
        const evidence = path.join(scratchDir, `${sessionId}-followup-evidence.json`);
        await writeFile(evidence, JSON.stringify(UNOWNED));
        const raised = runCli([
          'findings',
          'raise',
          '--evidence',
          evidence,
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
        expect(raised.status).toBe(0);
        const [routed] = JSON.parse(raised.stdout);
        expect(routed.attribution).toBe('follow-up');
        return routed.taskId as string;
      }

      // The acceptance the punch list names: D-41's own follow-up, from the
      // finding that mints it to the merge that closes it, with `event append`
      // used exactly once — for `session-start`, which is where a session
      // begins. Every other event below is written by the verb that did the
      // work.
      it('runs from findings raise to wave-merged with no hand-appended event', async () => {
        const { sessionId, eventsDir, planPath } = await session();

        // A real project: the queue merges branches, so there has to be one.
        const originDir = path.join(scratchDir, `${sessionId}-origin.git`);
        const projectDir = path.join(scratchDir, `${sessionId}-project`);
        runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
        runOrThrow('git', ['clone', '-q', originDir, projectDir]);
        runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
        runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: projectDir });
        await mkdir(path.join(projectDir, 'scripts'), { recursive: true });
        await writeFile(path.join(projectDir, 'scripts', 'release.sh'), 'run_steps\n');
        runOrThrow('git', ['add', '.'], { cwd: projectDir });
        runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
        runOrThrow('git', ['push', '-q', 'origin', 'main'], { cwd: projectDir });

        ingest(planPath, sessionId, eventsDir);
        const followUpId = await mintFollowUp(sessionId, eventsDir, planPath);
        // Typed the short way from here on, exactly as a human would — the
        // whole point is that both spellings resolve to the one id the log
        // holds, for a task no plan declares.
        const bare = followUpId.slice('epic-1/'.length);

        const admitted = runCli([
          'wave',
          'check',
          planPath,
          bare,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(admitted.status).toBe(0);
        expect(JSON.parse(admitted.stdout).valid).toBe(true);

        const worktree = runCli(['worktree', 'create', projectDir, 'epic-1', bare]);
        expect(worktree.status).toBe(0);
        const { worktreeDir, branch } = JSON.parse(worktree.stdout);
        await writeFile(path.join(worktreeDir, 'scripts', 'release.sh'), 'run_steps || exit 1\n');
        runOrThrow('git', ['commit', '-q', '-am', 'fix release exit code'], { cwd: worktreeDir });

        const tasksPath = path.join(scratchDir, `${sessionId}-followup-tasks.json`);
        await writeFile(tasksPath, JSON.stringify([{ taskId: bare, branch, worktreeDir }]));
        const queued = runCli([
          'queue',
          'run',
          'epic-1',
          '--project',
          projectDir,
          '--test-cmd',
          'true',
          '--tasks',
          tasksPath,
          '--plan',
          planPath,
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(queued.status).toBe(0);
        expect(JSON.parse(queued.stdout)).toEqual([{ outcome: 'merged', taskId: followUpId }]);

        const records = tail(sessionId, eventsDir);
        expect(
          records.filter((r) => r.event_type === 'wave-admitted')[0]?.payload.task_ids,
        ).toEqual([followUpId]);
        const merged = records.filter((r) => r.event_type === 'wave-merged');
        expect(merged).toHaveLength(1);
        expect(merged[0]?.task_id).toBe(followUpId);
      });

      // The other half of the same bug: an id resolved out of the log with no
      // claims attached is a task allowed to touch nothing. Admissibility is
      // decided from claims, so an empty set makes every wave look disjoint —
      // the check passes and the first edit is what fails.
      it('gets the follow-up’s real claims from the log when checking a wave', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        const followUpId = await mintFollowUp(sessionId, eventsDir, planPath);

        // A plan whose task claims the same tree the follow-up owns. If the
        // follow-up were admitted claimless, this wave would read as disjoint.
        const rivalPath = path.join(scratchDir, `${sessionId}-rival-plan.json`);
        await writeFile(
          rivalPath,
          JSON.stringify({
            ...PLAN,
            tasks: [{ ...PLAN.tasks[0], task_id: 'epic-1/task-3', claims: ['scripts/**'] }],
          }),
        );
        ingest(rivalPath, sessionId, eventsDir);

        const result = runCli([
          'wave',
          'check',
          rivalPath,
          followUpId,
          'epic-1/task-3',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        const parsed = JSON.parse(result.stdout);
        // Named apart on purpose: exit 1 here should mean "checked, and the
        // wave overlaps", not "could not resolve the id" — the two failures
        // share a status and say opposite things about whether this works.
        expect(parsed.error).toBeUndefined();
        expect(parsed.valid).toBe(false);
        expect(JSON.stringify(parsed)).toContain('scripts/release.sh');
      });

      it('still refuses an id neither the plan nor the log knows', async () => {
        const { sessionId, eventsDir, planPath } = await session();
        await mintFollowUp(sessionId, eventsDir, planPath);

        const result = runCli([
          'wave',
          'check',
          planPath,
          'followup-deadbeef',
          '--session',
          sessionId,
          '--causal-parent',
          `${sessionId}#0`,
          '--state-dir',
          eventsDir,
        ]);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.message).toContain('no task "followup-deadbeef"');
        expect(tail(sessionId, eventsDir).filter((r) => r.event_type === 'wave-admitted')).toEqual(
          [],
        );
      });
    });
  });

  // The planner and the scribe write outside any worktree, so they have no
  // claims and no smith/<epic>/<task-id> branch — the check that used to exist
  // only for worktree agents now reaches them through --roots (P9-3).
  describe('claims check --roots (P9-3)', () => {
    let repoDir: string;

    beforeAll(async () => {
      repoDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-roots-'));
      runOrThrow('git', ['init', '-q', '-b', 'main', repoDir]);
      runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      await writeFile(path.join(repoDir, 'README.md'), '# scratch\n');
      runOrThrow('git', ['add', '.'], { cwd: repoDir });
      runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    });

    afterAll(async () => {
      if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('exits 0 on an ordinary branch when every write landed inside a root', async () => {
      await mkdir(path.join(repoDir, 'factory', 'specs', 'active', 'epic-1'), { recursive: true });
      await writeFile(path.join(repoDir, 'factory/specs/active/epic-1/plan-v1.json'), '{}\n');

      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'factory/specs/active/epic-1/**',
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        inClaim: ['factory/specs/active/epic-1/plan-v1.json'],
        outOfClaim: [],
        violation: null,
      });
    });

    it('accumulates repeated --roots instead of keeping only the last one', async () => {
      await mkdir(path.join(repoDir, 'state', 'lessons'), { recursive: true });
      await writeFile(path.join(repoDir, 'state/lessons/epic-1.candidates.json'), '[]\n');

      // Last-wins on a repeated flag would drop the planner root and report the
      // plan file as a violation — the failure mode this test exists to catch.
      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'factory/specs/active/epic-1/**',
        '--roots',
        'state/lessons/**',
      ]);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).inClaim.sort()).toEqual([
        'factory/specs/active/epic-1/plan-v1.json',
        'state/lessons/epic-1.candidates.json',
      ]);
    });

    it('exits 1 and names the write-root violation when a role wrote outside its root', async () => {
      await writeFile(path.join(repoDir, 'README.md'), '# edited by a role that may not\n');

      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'state/lessons/**',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.violation).toEqual({
        error: 'contract.write-root-violation',
        files: expect.arrayContaining(['README.md']),
      });
    });

    it('with --since, also sees what the role committed itself (the planner holds Bash)', async () => {
      const since = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.trim();
      await writeFile(path.join(repoDir, 'README.md'), '# committed by the role\n');
      runOrThrow('git', ['commit', '-q', '-am', 'role committed its own work'], { cwd: repoDir });

      // Working tree is clean for README.md now; without --since the check
      // would call this pass.
      const clean = runCli(['claims', 'check', repoDir, '--roots', 'state/lessons/**']);
      expect(JSON.parse(clean.stdout).outOfClaim).not.toContain('README.md');

      const { stdout, status } = runCli([
        'claims',
        'check',
        repoDir,
        '--roots',
        'state/lessons/**',
        '--since',
        since,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).outOfClaim).toContain('README.md');
    });

    it('still requires a spec file when --roots is absent', () => {
      const { stdout, status } = runCli(['claims', 'check', repoDir]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('cli.missing-positional');
      expect(parsed.error.message).toContain('spec.json');
    });
  });

  // The blind spot `claims check` cannot see (P9-3): two disjoint claim lists
  // joined by an import edge.
  describe('claims impact', () => {
    let repoDir: string;
    let planPath: string;

    const IMPACT_PLAN = {
      epic_id: 'epic-1',
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: 'epic-1/task-a',
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Own the producer.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src/a.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
        {
          task_id: 'epic-1/task-b',
          epic_id: 'epic-1',
          plan_version: 1,
          objective: 'Own the consumer.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['it works'],
          claims: ['src/b.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['do it'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
      ],
      edges: [],
    };

    beforeAll(async () => {
      repoDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-impact-'));
      await mkdir(path.join(repoDir, 'src'), { recursive: true });
      await writeFile(
        path.join(repoDir, 'src/a.ts'),
        'export function parse(x: string) { return x; }\n',
      );
      await writeFile(
        path.join(repoDir, 'src/b.ts'),
        "import { parse } from './a.js';\nexport const b = parse('x');\n",
      );
      await writeFile(path.join(repoDir, 'src/c.ts'), 'export const c = 1;\n');
      planPath = path.join(repoDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(IMPACT_PLAN));
    });

    afterAll(async () => {
      if (repoDir) await rm(repoDir, { recursive: true, force: true });
    });

    it('exits 1 and names the crossing when one task imports what another exports', () => {
      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        planPath,
        '--repo',
        repoDir,
        'epic-1/task-a',
        'epic-1/task-b',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('coupled');
      expect(parsed.crossings).toEqual([
        {
          producer: 'epic-1/task-a',
          consumer: 'epic-1/task-b',
          exportedBy: 'src/a.ts',
          importedBy: 'src/b.ts',
          symbols: ['parse'],
          typeOnly: false,
          dynamic: false,
        },
      ]);
    });

    it('exits 0 when no task in the wave imports what another one exports', async () => {
      const disjoint = {
        ...IMPACT_PLAN,
        tasks: IMPACT_PLAN.tasks.map((task, index) =>
          index === 1 ? { ...task, claims: ['src/c.ts'] } : task,
        ),
      };
      const disjointPath = path.join(repoDir, 'plan-disjoint.json');
      await writeFile(disjointPath, JSON.stringify(disjoint));

      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        disjointPath,
        '--repo',
        repoDir,
        'epic-1/task-a',
        'epic-1/task-b',
      ]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('clean');
      expect(parsed.crossings).toEqual([]);
      // src/b.ts still imports src/a.ts, and nobody in this wave claims it.
      expect(parsed.exposure).toEqual([
        {
          producer: 'epic-1/task-a',
          exportedBy: 'src/a.ts',
          importedBy: 'src/b.ts',
          symbols: ['parse'],
        },
      ]);
    });

    it('exits 0 and lists the crossing as promised when the producer keeps the file in keeps_exports', async () => {
      const promised = {
        ...IMPACT_PLAN,
        tasks: IMPACT_PLAN.tasks.map((task, index) =>
          index === 0 ? { ...task, keeps_exports: ['src/a.ts'] } : task,
        ),
      };
      const promisedPath = path.join(repoDir, 'plan-promised.json');
      await writeFile(promisedPath, JSON.stringify(promised));

      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        promisedPath,
        '--repo',
        repoDir,
        'epic-1/task-a',
        'epic-1/task-b',
      ]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('clean');
      expect(parsed.crossings).toEqual([]);
      expect(parsed.promised).toHaveLength(1);
      expect(parsed.promised[0]).toMatchObject({
        producer: 'epic-1/task-a',
        consumer: 'epic-1/task-b',
        exportedBy: 'src/a.ts',
        importedBy: 'src/b.ts',
        symbols: ['parse'],
      });
    });

    it('refuses a wave with no task ids rather than pronouncing the empty set clean', () => {
      const { stdout, status } = runCli([
        'claims',
        'impact',
        '--plan',
        planPath,
        '--repo',
        repoDir,
      ]);
      expect(status).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe('cli.empty-wave');
    });

    describe('post-run, against a task branch', () => {
      let worktree: string;
      let specPath: string;

      beforeAll(async () => {
        worktree = await mkdtemp(path.join(tmpdir(), 'smith-cli-impact-run-'));
        runOrThrow('git', ['init', '-q', '-b', 'smith/epic-1/integration', worktree]);
        runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
        runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: worktree });
        await mkdir(path.join(worktree, 'src'), { recursive: true });
        await writeFile(
          path.join(worktree, 'src/a.ts'),
          'export const kept = 1;\nexport const gone = 2;\n',
        );
        await writeFile(
          path.join(worktree, 'src/theirs.ts'),
          "import { gone } from './a.js';\nexport const t = gone;\n",
        );
        runOrThrow('git', ['add', '.'], { cwd: worktree });
        runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: worktree });
        runOrThrow('git', ['checkout', '-q', '-b', 'smith/epic-1/task-1'], { cwd: worktree });
        await writeFile(path.join(worktree, 'src/a.ts'), 'export const kept = 1;\n');
        runOrThrow('git', ['commit', '-q', '-am', 'drop gone'], { cwd: worktree });
        specPath = path.join(worktree, 'spec.json');
        await writeFile(
          specPath,
          JSON.stringify({ task_id: 'epic-1/task-1', claims: ['src/a.ts'] }),
        );
      });

      afterAll(async () => {
        if (worktree) await rm(worktree, { recursive: true, force: true });
      });

      it('exits 1 when a removed export is still imported outside the claims', () => {
        const { stdout, status } = runCli(['claims', 'impact', worktree, specPath]);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(false);
        expect(parsed.breaks).toEqual([
          {
            severity: 'proven',
            reason: 'removed',
            exportedBy: 'src/a.ts',
            importedBy: 'src/theirs.ts',
            symbols: ['gone'],
          },
        ]);
      });

      it('exits 0 when the claims already cover every importer', async () => {
        const widePath = path.join(worktree, 'spec-wide.json');
        await writeFile(widePath, JSON.stringify({ task_id: 'epic-1/task-1', claims: ['src/**'] }));

        const { stdout, status } = runCli(['claims', 'impact', worktree, widePath]);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.breaks).toEqual([]);
      });
    });

    describe('post-run, on a promised barrel of star re-exports', () => {
      const barrel = "export * from './a.ts';\nexport * from './b.ts';\n";
      const repos: string[] = [];

      // One repo per task branch: the barrel on integration, the task's edit on top.
      async function taskBranchWith(after: string): Promise<[string, string]> {
        const worktree = await mkdtemp(path.join(tmpdir(), 'smith-cli-impact-barrel-'));
        repos.push(worktree);
        runOrThrow('git', ['init', '-q', '-b', 'smith/epic-1/integration', worktree]);
        runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
        runOrThrow('git', ['config', 'user.name', 'Test'], { cwd: worktree });
        await mkdir(path.join(worktree, 'src'), { recursive: true });
        await writeFile(path.join(worktree, 'src/index.ts'), barrel);
        for (const name of ['a', 'b', 'c']) {
          await writeFile(path.join(worktree, `src/${name}.ts`), `export const ${name} = 1;\n`);
        }
        runOrThrow('git', ['add', '.'], { cwd: worktree });
        runOrThrow('git', ['commit', '-q', '-m', 'init'], { cwd: worktree });
        runOrThrow('git', ['checkout', '-q', '-b', 'smith/epic-1/task-1'], { cwd: worktree });
        await writeFile(path.join(worktree, 'src/index.ts'), after);
        runOrThrow('git', ['commit', '-q', '-am', 'edit the barrel'], { cwd: worktree });
        const specPath = path.join(worktree, 'spec.json');
        await writeFile(
          specPath,
          JSON.stringify({
            task_id: 'epic-1/task-1',
            claims: ['src/index.ts'],
            keeps_exports: ['src/index.ts'],
          }),
        );
        return [worktree, specPath];
      }

      afterAll(async () => {
        for (const worktree of repos) await rm(worktree, { recursive: true, force: true });
      });

      it('exits 0 with the promise kept when the task appends a star re-export', async () => {
        const [worktree, specPath] = await taskBranchWith(`${barrel}export * from './c.ts';\n`);
        const { stdout, status } = runCli(['claims', 'impact', worktree, specPath]);
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.promises).toEqual([
          {
            file: 'src/index.ts',
            status: 'kept',
            removed: [],
            signatureChanged: [],
            added: ["* from './c.ts'"],
          },
        ]);
      });

      it('exits 1 with the promise broken when the task drops a star re-export', async () => {
        const [worktree, specPath] = await taskBranchWith("export * from './b.ts';\n");
        const { stdout, status } = runCli(['claims', 'impact', worktree, specPath]);
        expect(status).toBe(1);
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(false);
        expect(parsed.promises[0]).toMatchObject({
          status: 'broken',
          reason: 'removed',
          removed: ["* from './a.ts'"],
          signatureChanged: [],
        });
      });
    });
  });

  // The security-reviewer's trigger used to fire only when the orchestrator
  // remembered to check the glob list by eye (P9-4).
  describe('effort show', () => {
    const task = (overrides: Record<string, unknown> = {}) => ({
      task_id: 'epic-1/task-1',
      epic_id: 'epic-1',
      plan_version: 1,
      objective: 'Do the thing.',
      output_schema_ref: 'result.schema.json',
      acceptance_criteria: ['it works'],
      claims: ['src/foo/**'],
      budget: { tokens: 100, diff_lines: 10, max_turns: 5 },
      contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
      case: 'feature',
      origin: 'user',
      task_status: 'todo',
      ...overrides,
    });

    async function writePlan(name: string, overrides: Record<string, unknown>): Promise<string> {
      const planPath = path.join(scratchDir, name);
      await writeFile(
        planPath,
        JSON.stringify({
          epic_id: 'epic-1',
          version: 1,
          status: 'active',
          tasks: [task()],
          edges: [],
          ...overrides,
        }),
      );
      return planPath;
    }

    it("answers from the plan's own tier and returns the profile that tier buys", async () => {
      const planPath = await writePlan('effort-small.json', { effort: 'small' });
      const { stdout, status } = runCli(['effort', 'show', '--plan', planPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.requestedFrom).toBe('plan');
      expect(parsed.effective).toBe('small');
      expect(parsed.profile.specReviewRounds).toBe('single-pass');
      expect(parsed.profile.verifierSeverities).toEqual(['S1-stop-the-line']);
      expect(parsed.invariants.length).toBeGreaterThan(0);
    });

    it('falls back to the policy default when the plan names no tier', async () => {
      const planPath = await writePlan('effort-none.json', {});
      const { stdout, status } = runCli(['effort', 'show', '--plan', planPath]);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.requested).toBeNull();
      expect(parsed.requestedFrom).toBe('default');
      expect(parsed.effective).toBe(parsed.defaultTier);
    });

    it('lifts a small epic to the security floor on a case: infra task', async () => {
      const planPath = await writePlan('effort-infra.json', {
        effort: 'small',
        tasks: [task({ case: 'infra' })],
      });
      const { stdout, status } = runCli(['effort', 'show', '--plan', planPath]);
      expect(status).toBe(0); // a floored tier is a plan for the run, not a violation
      const parsed = JSON.parse(stdout);
      expect(parsed.effective).toBe('medium');
      expect(parsed.floorApplied).toBe(true);
      expect(parsed.securityFloorEvaluated).toBe(true);
      expect(parsed.securityTriggers[0]).toMatchObject({ kind: 'security', matchType: 'case' });
    });

    it('answers with no plan at all, and says the floor was not evaluated', async () => {
      const { stdout, status } = runCli(['effort', 'show', '--effort', 'huge']);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.requestedFrom).toBe('flag');
      expect(parsed.effective).toBe('huge');
      expect(parsed.securityFloorEvaluated).toBe(false);
      expect(parsed.reason).toMatch(/not evaluated/);
    });

    it('names the tier it cannot read instead of quietly running the default', async () => {
      const { stdout, status } = runCli(['effort', 'show', '--effort', 'tiny']);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.error.code).toBe('effort.unknown-tier');
      expect(parsed.error.message).toMatch(/tiny/);
      expect(parsed.error.message).toMatch(/small, medium, huge/);
    });
  });
});
