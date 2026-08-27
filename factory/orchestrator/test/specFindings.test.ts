import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EpicPlanRoster,
  type EpicTaskRow,
  type IntegrationStatus,
  summarizeEpic,
} from '../src/epic.js';
import { appendEvent, readEvents } from '../src/events.js';
import {
  type Finding,
  type FindingDraft,
  FindingError,
  type FindingEvidence,
  findingScope,
  listFindings,
  mintFindings,
  raiseFinding,
  transition,
} from '../src/findings.js';
import { type GateInput, runGate } from '../src/gate.js';
import { type GoalCheckStatus, goalDigest } from '../src/goalCheck.js';
import type { IntegrationCheckRecord } from '../src/integration.js';
import { MCP_SURFACE_NOT_REQUIRED } from '../src/mcp.js';
import type { PlanChanges, PlanFile } from '../src/plan.js';
import {
  amendPlan,
  latestSpecReview,
  PLAN_AMENDED_EVENT,
  recordSpecReview,
  SPEC_REVIEW_EVENT,
  SpecError,
  type SpecReviewStatus,
  specReviewBlockers,
} from '../src/spec.js';

// ---------------------------------------------------------------------------
// P9-9 / D-33: a spec defect recorded as a builder defect deadlocks the queue.
// `task-1b-parse-quotes` passed all five checks and was blocked by one correct
// S2 whose fix the plan forbids: criterion 3 mandates multi-line quoted values,
// criterion 1 forbids the only other remedy, and S1/S2 are categorically
// unwaivable. The diff cannot be fixed, the finding cannot be waived, the queue
// never admits the task. These tests pin the way out: a finding scoped to the
// SPEC blocks the plan, not the diff, and its one legitimate exit is a
// plan-version amendment that records which criterion moved and why.
// ---------------------------------------------------------------------------

const HEAD_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const OLD_SHA = 'aaaabbbbccccddddeeeeffff00001111aaaabbbb';

function specDraft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    finding_id: 'finding-spec-1',
    task_id: 'envkit/task-1b-parse-quotes',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    finding_scope: 'spec',
    spec_ref: { plan_version: 1, criterion_ref: 'task-1b:criterion-3' },
    summary: 'an unbalanced quote swallows the following line',
    failure_scenario: {
      inputs: 'A="oops\\nB=2',
      expected: 'B parsed as its own entry',
      actual: 'B swallowed into A',
    },
    found_by: 'security-reviewer',
    ...overrides,
  };
}

describe('spec-scoped findings (P9-9)', () => {
  let stateDir: string;
  const ctx = { sessionId: 'sess-spec', planVersion: 1, causalParent: null };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-spec-'));
    await appendEvent(
      {
        session_id: ctx.sessionId,
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
  });

  const rootCtx = () => ({ ...ctx, causalParent: `${ctx.sessionId}#0` });

  describe('scope and spec_ref coherence', () => {
    it('raises a spec finding and carries scope + criterion ref into the event', async () => {
      const result = await raiseFinding(
        { finding: specDraft(), filePath: 'src/parse.ts' },
        rootCtx(),
        { stateDir },
      );
      expect(result.suppressed).toBe(false);
      if (result.suppressed) throw new Error('unreachable');
      expect(result.finding.finding_scope).toBe('spec');
      expect(result.finding.spec_ref).toEqual({
        plan_version: 1,
        criterion_ref: 'task-1b:criterion-3',
      });

      const events = await readEvents(ctx.sessionId, { stateDir });
      const raised = events.find((e) => e.record.event_type === 'finding-raised');
      expect(raised?.record.payload.finding_scope).toBe('spec');
      expect(raised?.record.payload.spec_ref).toEqual({
        plan_version: 1,
        criterion_ref: 'task-1b:criterion-3',
      });
    });

    it('refuses a spec-scoped finding with no spec_ref — "the plan is wrong" must say where', async () => {
      const { spec_ref: _dropped, ...noRef } = specDraft();
      await expect(
        raiseFinding({ finding: noRef as FindingDraft, filePath: 'src/parse.ts' }, rootCtx(), {
          stateDir,
        }),
      ).rejects.toMatchObject({ code: 'findings.spec-finding-needs-ref' });
    });

    it('refuses a spec_ref on a diff-scoped finding', async () => {
      await expect(
        raiseFinding(
          { finding: specDraft({ finding_scope: 'diff' }), filePath: 'src/parse.ts' },
          rootCtx(),
          { stateDir },
        ),
      ).rejects.toMatchObject({ code: 'findings.spec-ref-without-scope' });
    });

    it('treats a finding written before P9-9 (no scope at all) as diff-scoped', async () => {
      const { finding_scope: _s, spec_ref: _r, ...legacy } = specDraft();
      const result = await raiseFinding(
        { finding: legacy as FindingDraft, filePath: 'src/parse.ts' },
        rootCtx(),
        { stateDir },
      );
      if (result.suppressed) throw new Error('unreachable');
      expect(result.finding.finding_scope).toBeUndefined();
      expect(findingScope(result.finding)).toBe('diff');
    });
  });

  describe('mintFindings with a spec dispatch', () => {
    const evidence: FindingEvidence = {
      file_path: 'src/parse.ts',
      finding_category: 'correctness',
      severity: 'S2-major',
      summary: 'criterion 3 and criterion 1 cannot both hold',
      failure_scenario: { inputs: 'A="oops', expected: 'parse error', actual: 'silent swallow' },
      criterion_ref: 'task-1b:criterion-3',
    };

    it('stamps scope and the reviewed plan version onto every minted finding', () => {
      const [minted] = mintFindings([evidence], {
        taskId: 'envkit/task-1b',
        foundBy: 'spec-reviewer',
        spec: { planVersion: 4 },
      });
      expect(minted?.finding.finding_scope).toBe('spec');
      expect(minted?.finding.spec_ref).toEqual({
        plan_version: 4,
        criterion_ref: 'task-1b:criterion-3',
      });
    });

    it('refuses spec evidence that names no criterion', () => {
      const { criterion_ref: _dropped, ...noCriterion } = evidence;
      expect(() =>
        mintFindings([noCriterion], {
          taskId: 'envkit/task-1b',
          foundBy: 'spec-reviewer',
          spec: { planVersion: 4 },
        }),
      ).toThrow(FindingError);
    });

    it('ignores a criterion_ref on a diff dispatch rather than minting a half-spec finding', () => {
      const [minted] = mintFindings([evidence], {
        taskId: 'envkit/task-1b',
        foundBy: 'reviewer',
      });
      expect(minted?.finding.finding_scope).toBeUndefined();
      expect(minted?.finding.spec_ref).toBeUndefined();
    });
  });

  // D-127: the D-33 exit used to be one edge. `amended` hung off `raised` and
  // `confirmed`, so the finding closed the moment somebody said it had — with
  // no diff, no task outcome and no grade behind the claim. It is now two
  // edges: `amend-pending` names the task ids the amendment made this
  // finding's discharge condition, and `amended` is what those ids landing
  // earns. These tests pin the second edge's unreachability from the first.
  describe('the amendment path: amend-pending, then amended (D-127)', () => {
    const OBLIGATIONS = ['envkit/task-1b-parse-quotes', 'envkit/task-1c-quote-errors'];

    async function raiseSpec(): Promise<Finding> {
      const raised = await raiseFinding(
        { finding: specDraft(), filePath: 'src/parse.ts' },
        rootCtx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');
      return raised.finding;
    }

    it('lets an unwaivable S2 spec finding enter "amend-pending" — the D-33 exit, still owing work', async () => {
      const finding = await raiseSpec();
      const moved = await transition(
        finding.finding_id,
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      expect(moved.finding_status).toBe('amend-pending');
      expect(moved.amends_task_ids).toEqual(OBLIGATIONS);
      expect(moved.amends_plan_version).toBe(2);

      const stillRaised = await listFindings(ctx.sessionId, { status: 'raised' }, { stateDir });
      expect(stillRaised).toHaveLength(0);
    });

    it('enters "amend-pending" from confirmed as well as from raised', async () => {
      const finding = await raiseSpec();
      await transition(finding.finding_id, 'confirmed', rootCtx(), { stateDir });
      const moved = await transition(
        finding.finding_id,
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      expect(moved.finding_status).toBe('amend-pending');
    });

    it.each(['raised', 'confirmed'])(
      'refuses to discharge a spec finding straight to "amended" from %s',
      async (from) => {
        const finding = await raiseSpec();
        if (from === 'confirmed') {
          await transition(finding.finding_id, 'confirmed', rootCtx(), { stateDir });
        }
        await expect(
          transition(finding.finding_id, 'amended', rootCtx(), { stateDir }),
        ).rejects.toMatchObject({ code: 'findings.illegal-transition' });
      },
    );

    it('refuses an "amend-pending" that names no task ids', async () => {
      const finding = await raiseSpec();
      await expect(
        transition(finding.finding_id, 'amend-pending', rootCtx(), { stateDir }),
      ).rejects.toMatchObject({ code: 'findings.amendment-without-obligation' });
    });

    it('refuses to amend a diff-scoped finding — a plan amendment cannot fix the diff', async () => {
      const { finding_scope: _s, spec_ref: _r, ...diffFinding } = specDraft();
      const raised = await raiseFinding(
        { finding: diffFinding as FindingDraft, filePath: 'src/parse.ts' },
        rootCtx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      await expect(
        transition(
          raised.finding.finding_id,
          'amend-pending',
          rootCtx(),
          { stateDir },
          { amendsTaskIds: OBLIGATIONS },
        ),
      ).rejects.toMatchObject({ code: 'findings.not-amendable' });
    });

    it('closes at "amended" from "amend-pending", and keeps "amended" terminal', async () => {
      const finding = await raiseSpec();
      await transition(
        finding.finding_id,
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      const closed = await transition(
        finding.finding_id,
        'amended',
        rootCtx(),
        { stateDir },
        { amendsSatisfiedBy: OBLIGATIONS.map((taskId) => ({ taskId, planVersion: 2 })) },
      );
      expect(closed.finding_status).toBe('amended');

      await expect(
        transition(finding.finding_id, 'confirmed', rootCtx(), { stateDir }),
      ).rejects.toMatchObject({ code: 'findings.illegal-transition' });
    });

    it('lets an epic boundary expire an amendment whose tasks never landed', async () => {
      const finding = await raiseSpec();
      await transition(
        finding.finding_id,
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      const expired = await transition(finding.finding_id, 'expired', rootCtx(), { stateDir });
      expect(expired.finding_status).toBe('expired');
    });
  });

  describe('the gate diverts spec findings instead of blocking the diff', () => {
    let worktreeDir: string;

    beforeEach(async () => {
      worktreeDir = await mkdtemp(path.join(tmpdir(), 'smith-spec-wt-'));
      // A committed worktree: since D-30/P9-8 the gate certifies the commit
      // before it scores anything, so a bare scratch dir blocks every run with
      // `not-committed` and this suite would never reach its own subject.
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: worktreeDir, encoding: 'utf8' });
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'task work']);
    });

    afterEach(async () => {
      await rm(worktreeDir, { recursive: true, force: true });
    });

    function gateInput(overrides: Partial<GateInput> = {}): GateInput {
      return {
        taskId: 'envkit/task-1b-parse-quotes',
        result: {
          task_id: 'envkit/task-1b-parse-quotes',
          run_status: 'done',
          structured_output: {},
          artifacts: [],
          token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          agent: 'coder',
          provider: 'claude',
          model_tier: 'mid',
        },
        worktreeDir,
        checks: [{ name: 'test', cmd: 'true' }],
        findingsInput: [],
        lessons: [],
        ...overrides,
      };
    }

    it('passes the task and reports the S2 spec finding separately (D-33)', async () => {
      const outcome = await runGate(
        gateInput({ findingsInput: [{ finding: specDraft(), filePath: 'src/parse.ts' }] }),
        rootCtx(),
        { stateDir },
      );

      expect(outcome.outcome).toBe('pass');
      expect(outcome.specFindings).toHaveLength(1);
      expect(outcome.specFindings?.[0]).toMatchObject({
        finding_id: 'finding-spec-1',
        finding_scope: 'spec',
        spec_ref: { plan_version: 1, criterion_ref: 'task-1b:criterion-3' },
      });

      // The diverted finding is still on the record: a gate that passed the
      // diff and said nothing would read as a clean run.
      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === 'finding-raised')).toBe(true);
    });

    it('still blocks on a diff-scoped S2 in the same run', async () => {
      const {
        finding_scope: _s,
        spec_ref: _r,
        ...diffFinding
      } = specDraft({
        summary: 'a genuinely broken loop bound',
      });
      const outcome = await runGate(
        gateInput({
          findingsInput: [
            { finding: specDraft(), filePath: 'src/parse.ts' },
            { finding: diffFinding as FindingDraft, filePath: 'src/loop.ts' },
          ],
        }),
        rootCtx(),
        { stateDir },
      );

      expect(outcome).toMatchObject({ outcome: 'blocked', reason: 'findings' });
      if (outcome.outcome !== 'blocked') throw new Error('unreachable');
      expect(outcome.blockingFindings).toHaveLength(1);
      expect(outcome.specFindings).toHaveLength(1);
    });
  });

  describe('amendPlan — the one legitimate way to change an immutable plan', () => {
    let specsDir: string;

    beforeEach(async () => {
      specsDir = await mkdtemp(path.join(tmpdir(), 'smith-spec-plans-'));
    });

    afterEach(async () => {
      await rm(specsDir, { recursive: true, force: true });
    });

    function planFixture(): PlanFile {
      return {
        epic_id: 'envkit',
        version: 1,
        status: 'active',
        tasks: [
          {
            task_id: 'envkit/task-1b-parse-quotes',
            epic_id: 'envkit',
            plan_version: 1,
            objective: 'Parse quoted values.',
            output_schema_ref: 'result.schema.json',
            acceptance_criteria: ['multi-line double-quoted values are supported'],
            claims: ['src/parse.ts'],
            // D-29: `max_turns` has no mechanical reader, so `validatePlan`
            // refuses it — omitted here so this fixture stays schema-valid
            // now that `amendPlan` validates its draft before writing (D-21).
            budget: { tokens: 1000, diff_lines: 100 },
            contract: { functional_clauses: ['parse quotes'], nonfunctional_clauses: [] },
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
          },
        ],
        edges: [],
      };
    }

    async function raiseSpecFinding(): Promise<Finding> {
      const raised = await raiseFinding(
        { finding: specDraft(), filePath: 'src/parse.ts' },
        rootCtx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');
      return raised.finding;
    }

    /** The real shape of this amendment: criterion 3 moved, so task-1b's spec is replaced. */
    function supersedeQuotes(): PlanChanges {
      const task = planFixture().tasks[0];
      if (task === undefined) throw new Error('unreachable');
      return {
        supersede: {
          'envkit/task-1b-parse-quotes': {
            ...task,
            acceptance_criteria: ['an unterminated double quote is a parse error'],
          },
        },
      };
    }

    it('cuts v2, emits one plan-version-created naming the criterion, and puts the finding on the amendment path', async () => {
      const finding = await raiseSpecFinding();
      const result = await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale:
            'Criterion 3 and criterion 1 are jointly unsatisfiable; 3 now requires a parse error on an unterminated quote.',
          sites: ['src/parse.ts'],
          changes: supersedeQuotes(),
        },
        rootCtx(),
        { stateDir, specsDir },
      );

      expect(result.plan.version).toBe(2);

      const events = await readEvents(ctx.sessionId, { stateDir });
      const amendments = events.filter((e) => e.record.event_type === PLAN_AMENDED_EVENT);
      expect(amendments).toHaveLength(1);
      expect(amendments[0]?.record.payload).toMatchObject({
        epic_id: 'envkit',
        version: 2,
        previous_version: 1,
        amends: [{ finding_id: finding.finding_id, criterion_ref: 'task-1b:criterion-3' }],
      });

      // D-127: the amendment opens the finding's exit, it does not walk
      // through it. What closes the finding is the superseded task landing.
      const after = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(after[0]?.finding_status).toBe('amend-pending');
      expect(after[0]?.amends_task_ids).toEqual(['envkit/task-1b-parse-quotes']);
      expect(after[0]?.amends_plan_version).toBe(2);
    });

    it('obligates exactly added ∪ superseded — a carried task is not what answered the finding', async () => {
      const finding = await raiseSpecFinding();
      const plan = planFixture();
      const carried = plan.tasks[0];
      if (carried === undefined) throw new Error('unreachable');
      // A second task nobody touches: it must not end up in the obligation set.
      plan.tasks.push({ ...carried, task_id: 'envkit/task-2-docs', claims: ['docs/envkit.md'] });

      await amendPlan(
        {
          plan,
          findingIds: [finding.finding_id],
          rationale: 'criterion 3 moved and a new task now owns the error path',
          sites: ['src/parse.ts'],
          changes: {
            ...supersedeQuotes(),
            added: [{ ...carried, task_id: 'envkit/task-1c-quote-errors' }],
          },
        },
        rootCtx(),
        { stateDir, specsDir },
      );

      const after = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(after[0]?.amends_task_ids?.slice().sort()).toEqual([
        'envkit/task-1b-parse-quotes',
        'envkit/task-1c-quote-errors',
      ]);
    });

    // A supersede whose replacement carries a *different* id leaves the old id
    // in the file as a dead record — `diffPlans` says so in as many words
    // ("renamed away, or retired"). It is still `superseded` in the diff, but
    // no future version claims it, so nothing will ever dispatch it and no
    // task event will ever name it. Obligating the finding on a dead id makes
    // the finding undischargeable and the epic uncloseable — the shape D-127
    // exists to avoid, arrived at from the other side.
    it('obligates the replacement, not the dead id, when a supersede renames a task', async () => {
      const finding = await raiseSpecFinding();
      const task = planFixture().tasks[0];
      if (task === undefined) throw new Error('unreachable');

      await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale: 'criterion 3 moved to a task that owns the error path alone',
          sites: ['src/parse.ts'],
          changes: {
            supersede: {
              'envkit/task-1b-parse-quotes': {
                ...task,
                task_id: 'envkit/task-1b-quote-errors',
                acceptance_criteria: ['an unterminated double quote is a parse error'],
              },
            },
          },
        },
        rootCtx(),
        { stateDir, specsDir },
      );

      const after = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(after[0]?.finding_status).toBe('amend-pending');
      expect(after[0]?.amends_task_ids).toEqual(['envkit/task-1b-quote-errors']);
    });

    it('refuses an amendment that moves no task — it would discharge the finding on the spot (D-127)', async () => {
      const finding = await raiseSpecFinding();
      const err = await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale: 'reworded criterion 3, honest',
          sites: ['src/parse.ts'],
        },
        rootCtx(),
        { stateDir, specsDir },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpecError);
      expect(err).toMatchObject({ code: 'plan.amendment-without-obligation' });

      // The guard sits with the other pre-action guards: nothing was written.
      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === PLAN_AMENDED_EVENT)).toBe(false);
      expect(existsSync(path.join(specsDir, 'envkit', 'plan-v2.json'))).toBe(false);

      const after = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(after[0]?.finding_status).toBe('raised');
    });

    // The refused diff is not always empty. `PlanChanges` cannot remove a task,
    // so the one way an id leaves a version is a completed task being dropped
    // from the live backlog — which makes `removed` non-empty for an amendment
    // that still obligates nothing. The guard reads `added ∪ superseded`, not
    // "did the diff move", and the message has to describe what actually
    // happened or the operator goes looking for a task they never removed.
    it('refuses an amendment whose only diff is a completed task dropping out (D-127)', async () => {
      const finding = await raiseSpecFinding();
      const plan = planFixture();
      const done = plan.tasks[0];
      if (done === undefined) throw new Error('unreachable');
      plan.tasks = [
        { ...done, task_status: 'completed' },
        { ...done, task_id: 'envkit/task-2-docs', claims: ['docs/envkit.md'] },
      ];

      const err = await amendPlan(
        {
          plan,
          findingIds: [finding.finding_id],
          rationale: 'reworded criterion 3, honest',
          sites: ['src/parse.ts'],
        },
        rootCtx(),
        { stateDir, specsDir },
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'plan.amendment-without-obligation' });
      expect((err as SpecError).message).toContain(
        'would drop completed envkit/task-1b-parse-quotes',
      );
      expect(existsSync(path.join(specsDir, 'envkit', 'plan-v2.json'))).toBe(false);
    });

    // D-123 (and D-83 before it, in the previous run): the remediation scope of
    // a finding was chosen by whoever wrote the amendment and checked by
    // nothing. The finding names one site; the question "where else does this
    // shape occur" was asked by nobody. Writing that lesson down did not stop
    // the second instance, so it is a guard now.
    it('refuses an amendment that enumerates no sites (D-123)', async () => {
      const finding = await raiseSpecFinding();
      const err = await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale: 'criterion 3 moved',
          sites: [],
          changes: supersedeQuotes(),
        },
        rootCtx(),
        { stateDir, specsDir },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpecError);
      expect(err).toMatchObject({ code: 'plan.amendment-without-sites' });

      // Sits with the other pre-action guards: nothing was written.
      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === PLAN_AMENDED_EVENT)).toBe(false);
      expect(existsSync(path.join(specsDir, 'envkit', 'plan-v2.json'))).toBe(false);
      const after = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(after[0]?.finding_status).toBe('raised');
    });

    // "Enumerated, not asserted" is the whole point. A list of one blank string
    // is a non-empty list, and satisfies a length check while stating nothing.
    it('refuses sites that are blank once trimmed (D-123)', async () => {
      const finding = await raiseSpecFinding();
      const err = await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale: 'criterion 3 moved',
          sites: ['src/parse.ts', '   '],
          changes: supersedeQuotes(),
        },
        rootCtx(),
        { stateDir, specsDir },
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'plan.amendment-without-sites' });
      expect(existsSync(path.join(specsDir, 'envkit', 'plan-v2.json'))).toBe(false);
    });

    // The enumeration is recorded with the half that makes it reviewable: which
    // named sites this version actually leaves work to land on. A site nobody
    // claims is NOT refused — the fix for a shape in one file legitimately
    // lands in another, and more to the point, refusing would price the act of
    // naming a site and push the next author toward the shorter list. That is
    // the defect, not the cure. It is recorded instead, so the closing review
    // reads a list rather than reconstructing one.
    it('records the enumeration and which sites no obligated task claims (D-123)', async () => {
      const finding = await raiseSpecFinding();
      await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale: 'criterion 3 moved; the same quote handling is duplicated in the lexer',
          sites: ['src/parse.ts', 'src/lex.ts', ' src/parse.ts '],
          changes: supersedeQuotes(),
        },
        rootCtx(),
        { stateDir, specsDir },
      );

      const events = await readEvents(ctx.sessionId, { stateDir });
      const amendment = events.find((e) => e.record.event_type === PLAN_AMENDED_EVENT);
      expect(amendment?.record.payload).toMatchObject({
        // Trimmed and de-duplicated, in the order given.
        sites: ['src/parse.ts', 'src/lex.ts'],
        // task-1b is superseded and claims src/parse.ts; nothing claims the lexer.
        sites_unclaimed: ['src/lex.ts'],
      });
    });

    it('refuses an amendment that cites no finding — the plan does not change on a whim', async () => {
      const err = await amendPlan(
        {
          plan: planFixture(),
          findingIds: [],
          rationale: 'because I said so',
          sites: ['src/parse.ts'],
        },
        rootCtx(),
        { stateDir, specsDir },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpecError);
      expect(err).toMatchObject({ code: 'plan.amendment-without-finding' });
    });

    it('refuses an amendment citing a diff-scoped finding', async () => {
      const { finding_scope: _s, spec_ref: _r, ...diffFinding } = specDraft();
      const raised = await raiseFinding(
        { finding: diffFinding as FindingDraft, filePath: 'src/parse.ts' },
        rootCtx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      await expect(
        amendPlan(
          {
            plan: planFixture(),
            findingIds: [raised.finding.finding_id],
            rationale: 'the diff is wrong',
            sites: ['src/parse.ts'],
          },
          rootCtx(),
          { stateDir, specsDir },
        ),
      ).rejects.toMatchObject({ code: 'plan.amendment-not-spec-scoped' });
    });

    it('refuses a blank rationale', async () => {
      const finding = await raiseSpecFinding();
      await expect(
        amendPlan(
          {
            plan: planFixture(),
            findingIds: [finding.finding_id],
            rationale: '   ',
            sites: ['src/parse.ts'],
          },
          rootCtx(),
          { stateDir, specsDir },
        ),
      ).rejects.toMatchObject({ code: 'plan.amendment-without-rationale' });
    });

    it('refuses to cite an already-closed finding, and writes no plan file when it does', async () => {
      const finding = await raiseSpecFinding();
      await transition(
        finding.finding_id,
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: ['envkit/task-1b-parse-quotes'], amendsPlanVersion: 2 },
      );
      await transition(
        finding.finding_id,
        'amended',
        rootCtx(),
        { stateDir },
        { amendsSatisfiedBy: [{ taskId: 'envkit/task-1b-parse-quotes', planVersion: 2 }] },
      );

      await expect(
        amendPlan(
          {
            plan: planFixture(),
            findingIds: [finding.finding_id],
            rationale: 'amending twice for the same finding',
            sites: ['src/parse.ts'],
            changes: supersedeQuotes(),
          },
          rootCtx(),
          { stateDir, specsDir },
        ),
      ).rejects.toMatchObject({ code: 'plan.amendment-finding-closed' });

      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === PLAN_AMENDED_EVENT)).toBe(false);
    });

    // D-21: `draftNextVersion` is documented as pure and split out precisely so
    // its caller can validate the draft before cutting the version — plans are
    // immutable and nothing deletes one, so a schema-invalid draft written to
    // disk is unrecoverable. This is the root-cause fix: every future shape
    // error becomes a refusal instead of a corrupt artifact `smith plan
    // validate` rejects after the fact.
    it('refuses an amendment whose draft would fail plan validation, and writes no file', async () => {
      const finding = await raiseSpecFinding();
      const task = planFixture().tasks[0];
      if (task === undefined) throw new Error('unreachable');

      const err = await amendPlan(
        {
          plan: planFixture(),
          findingIds: [finding.finding_id],
          rationale: 'criterion 3 moved to a new task, typo and all',
          sites: ['src/parse.ts'],
          changes: {
            added: [
              {
                ...task,
                task_id: 'envkit/task-1c-quote-errors',
                claims: ['src/parse.ts'],
                // Not a real taxonomy value — this is what makes the draft
                // schema-invalid, the same way plan.test.ts's own
                // validatePlan suite provokes it.
                case: 'not-a-real-case',
              },
            ],
          },
        },
        rootCtx(),
        { stateDir, specsDir },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SpecError);
      expect((err as SpecError).code).toBe('plan.amendment-invalid-draft');

      // Nothing reached disk, and no event was recorded — the point of the
      // guard, not just that it threw.
      expect(existsSync(path.join(specsDir, 'envkit', 'plan-v2.json'))).toBe(false);
      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === PLAN_AMENDED_EVENT)).toBe(false);
      const after = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(after[0]?.finding_status).toBe('raised');
    });
  });

  describe('the closing spec review', () => {
    it('records that the review ran even when it found nothing', async () => {
      const record = await recordSpecReview(
        {
          epicId: 'envkit',
          planVersion: 2,
          headSha: HEAD_SHA,
          reviewedBy: 'spec-reviewer',
          evidence: [],
        },
        rootCtx(),
        { stateDir },
      );
      expect(record.findingIds).toEqual([]);

      const events = await readEvents(ctx.sessionId, { stateDir });
      const reviews = events.filter((e) => e.record.event_type === SPEC_REVIEW_EVENT);
      expect(reviews).toHaveLength(1);
      expect(latestSpecReview(events, 'envkit')).toMatchObject({
        epicId: 'envkit',
        headSha: HEAD_SHA,
        planVersion: 2,
      });
    });

    it('raises the review evidence as spec findings and names them on the record', async () => {
      const record = await recordSpecReview(
        {
          epicId: 'envkit',
          planVersion: 2,
          headSha: HEAD_SHA,
          reviewedBy: 'spec-reviewer',
          evidence: [
            {
              file_path: 'src/parse.ts',
              finding_category: 'correctness',
              severity: 'S2-major',
              summary: 'composite behaviour contradicts criterion 3',
              failure_scenario: {
                inputs: 'A="x\\nB=2',
                expected: 'parse error',
                actual: 'B swallowed',
              },
              criterion_ref: 'task-1b:criterion-3',
            },
          ],
        },
        rootCtx(),
        { stateDir },
      );
      expect(record.findingIds).toHaveLength(1);

      const findings = await listFindings(ctx.sessionId, { epic: 'envkit' }, { stateDir });
      expect(findings[0]?.finding_scope).toBe('spec');
      expect(findings[0]?.spec_ref?.plan_version).toBe(2);
    });

    it('last-wins across repeated reviews', async () => {
      for (const sha of [OLD_SHA, HEAD_SHA]) {
        await recordSpecReview(
          {
            epicId: 'envkit',
            planVersion: 2,
            headSha: sha,
            reviewedBy: 'spec-reviewer',
            evidence: [],
          },
          rootCtx(),
          { stateDir },
        );
      }
      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(latestSpecReview(events, 'envkit')?.headSha).toBe(HEAD_SHA);
    });
  });

  describe('specReviewBlockers', () => {
    function status(overrides: Partial<SpecReviewStatus> = {}): SpecReviewStatus {
      return {
        review: {
          epicId: 'envkit',
          planVersion: 2,
          headSha: HEAD_SHA,
          reviewedBy: 'spec-reviewer',
          findingIds: [],
          eventId: 'sess-spec#1',
          ts: '2026-08-08T00:00:00.000Z',
        },
        headSha: HEAD_SHA,
        ...overrides,
      };
    }

    it('passes a current review', () => {
      expect(specReviewBlockers('envkit', status(), 2)).toEqual([]);
    });

    it('blocks when no spec review was ever recorded', () => {
      const blockers = specReviewBlockers('envkit', status({ review: null }), 2);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('no closing spec review');
    });

    it('blocks when the review predates the current integration head', () => {
      const blockers = specReviewBlockers('envkit', status({ headSha: OLD_SHA }), 2);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('stale');
    });

    it('blocks when the head cannot be read at all (fail closed)', () => {
      expect(specReviewBlockers('envkit', status({ headSha: null }), 2)).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // D-125. The sha axis was the only staleness this function knew, and the
    // plan is the other half of what a spec review reads. An amendment is by
    // definition a plan that just changed because a review found it wrong, so
    // the moment the plan is likeliest to be freshly defective was the moment
    // this gate was blind to: `epic verdict` passed on a review of v4 seconds
    // after the plan became v5.
    // -----------------------------------------------------------------------

    it('blocks when the plan was amended after the review read it', () => {
      const blockers = specReviewBlockers('envkit', status(), 3);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('stale');
      expect(blockers[0]).toContain('v2');
      expect(blockers[0]).toContain('v3');
    });

    it('blocks a plan amendment even when the review read the current head', () => {
      // The two axes are independent: an amendment can land with no commit
      // behind it yet, so a current sha must not vouch for a stale plan.
      const blockers = specReviewBlockers('envkit', status({ headSha: HEAD_SHA }), 5);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('plan');
    });

    it('blocks a review that names a plan version the repository does not have', () => {
      const blockers = specReviewBlockers(
        'envkit',
        status({
          review: {
            epicId: 'envkit',
            planVersion: 4,
            headSha: HEAD_SHA,
            reviewedBy: 'spec-reviewer',
            findingIds: [],
            eventId: 'sess-spec#1',
            ts: '2026-08-08T00:00:00.000Z',
          },
        }),
        3,
      );
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('v4');
    });

    it('blocks a review that records no plan version at all (fail closed)', () => {
      // latestSpecReview reads a missing plan_version as 0. "I did not record
      // which plan I read" cannot be shown to cover the live one.
      const blockers = specReviewBlockers(
        'envkit',
        status({
          review: {
            epicId: 'envkit',
            planVersion: 0,
            headSha: HEAD_SHA,
            reviewedBy: 'spec-reviewer',
            findingIds: [],
            eventId: 'sess-spec#1',
            ts: '2026-08-08T00:00:00.000Z',
          },
        }),
        3,
      );
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('no plan version');
    });

    it('casts no plan vote when the epic has no readable plan file (D-126)', () => {
      // The deliberate scope line D-126 drew: most epics ran as punch-list
      // branches with no plan directory, and making absence a blocker would
      // make them unclosable. Absence casts no vote; it does not manufacture
      // one either way.
      expect(specReviewBlockers('envkit', status(), null)).toEqual([]);
    });
  });

  describe('summarizeEpic folds the spec review', () => {
    function okIntegration(): IntegrationStatus {
      const check: IntegrationCheckRecord = {
        epicId: 'envkit',
        branch: 'smith/envkit/integration',
        headSha: HEAD_SHA,
        pass: true,
        results: [{ name: 'test', pass: true, exitCode: 0, tail: '' }],
        eventId: 'sess-spec#1',
        ts: '2026-08-08T00:00:00.000Z',
      };
      return { check, headSha: HEAD_SHA };
    }

    function okSpecReview(): SpecReviewStatus {
      return {
        review: {
          epicId: 'envkit',
          planVersion: 2,
          headSha: HEAD_SHA,
          reviewedBy: 'spec-reviewer',
          findingIds: [],
          eventId: 'sess-spec#2',
          ts: '2026-08-08T00:00:00.000Z',
        },
        headSha: HEAD_SHA,
      };
    }

    // The goal half of the epic gate. This suite is about the closing spec
    // review, so the goal check is held current the way okIntegration() holds
    // the integration run current -- both halves fail closed, and neither is
    // what these cases are pinning.
    const GOAL_TEXT = 'Parse .env files the way dotenv does.';

    function okGoalCheck(): GoalCheckStatus {
      return {
        check: {
          epicId: 'envkit',
          milestoneId: 'milestone-envkit',
          planVersion: 2,
          goalDigest: goalDigest(GOAL_TEXT),
          checkedBy: 'spec-reviewer',
          coverage: [
            {
              clause: GOAL_TEXT,
              verdict: 'covered',
              taskIds: ['envkit/task-1b-parse-quotes'],
            },
          ],
          findingIds: [],
          eventId: 'sess-spec#3',
          ts: '2026-08-08T00:00:00.000Z',
        },
        goal: {
          milestoneId: 'milestone-envkit',
          goal: GOAL_TEXT,
          clauses: [GOAL_TEXT],
          digest: goalDigest(GOAL_TEXT),
        },
      };
    }

    const tasks: EpicTaskRow[] = [
      {
        taskId: 'envkit/task-1b-parse-quotes',
        sessionId: 'sess-spec',
        epicId: 'envkit',
        caseTag: 'feature',
        origin: 'user',
        taskStatus: 'completed',
        planVersion: 2,
        objective: 'Parse quoted values.',
        claims: ['src/parse.ts'],
        budgetTokens: 1000,
        branch: 'smith/envkit/task-1b-parse-quotes',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
        project: 'black-smith',
        // This suite is about the closing spec review, not the gate record —
        // a task the log holds a real gate run for keeps it that way (D-138).
        gate: { gateOutcome: true, resultRecorded: true },
      },
    ];

    it('is ready when every gate including the closing spec review is current', () => {
      const summary = summarizeEpic(
        'envkit',
        tasks,
        [],
        okIntegration(),
        MCP_SURFACE_NOT_REQUIRED,
        okSpecReview(),
        okGoalCheck(),
      );
      expect(summary.mechanicallyReady).toBe(true);
    });

    it('holds when the closing spec review never ran', () => {
      const summary = summarizeEpic(
        'envkit',
        tasks,
        [],
        okIntegration(),
        MCP_SURFACE_NOT_REQUIRED,
        {
          review: null,
          headSha: HEAD_SHA,
        },
        okGoalCheck(),
      );
      expect(summary.mechanicallyReady).toBe(false);
      expect(summary.blockers.join('\n')).toContain('no closing spec review');
    });

    // The roster the gate already resolves (D-126) is where the live plan
    // version comes from, so the two amendment blind spots close off the same
    // read: a task the plan added, and a plan the review predates.
    const roster = (version: number): EpicPlanRoster => ({
      version,
      tasks: [{ taskId: 'envkit/task-1b-parse-quotes', taskStatus: 'completed' }],
    });

    it('is ready when the review read the plan version the epic is on', () => {
      const summary = summarizeEpic(
        'envkit',
        tasks,
        [],
        okIntegration(),
        MCP_SURFACE_NOT_REQUIRED,
        okSpecReview(),
        okGoalCheck(),
        roster(2),
      );
      expect(summary.mechanicallyReady).toBe(true);
    });

    it('holds when the plan was amended after the closing spec review (D-125)', () => {
      const summary = summarizeEpic(
        'envkit',
        tasks,
        [],
        okIntegration(),
        MCP_SURFACE_NOT_REQUIRED,
        okSpecReview(),
        okGoalCheck(),
        roster(3),
      );
      expect(summary.mechanicallyReady).toBe(false);
      expect(summary.blockers.join('\n')).toContain('stale');
    });
  });
});
