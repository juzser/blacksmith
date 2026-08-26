import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TASK_RESULT_EVENT_TYPE } from './agents-registry.js';
import { type ArtifactDecl, type ArtifactIssue, checkArtifacts } from './artifacts.js';
import { type RoutedFinding, recordReattribution, routeFindings } from './attribution.js';
import { type BudgetOverrun, checkTaskBudget, type TaskBudget } from './budgets.js';
import type { ClaimedTask } from './claims.js';
import { type CommitCertificate, certifyCommit } from './commit.js';
import { type CoverageEvidence, collectCoverageEvidence } from './coverage.js';
import { type CrosscheckPolicy, loadCrosscheckPolicy } from './crosscheck.js';
import { DiffstatError, measureDiff } from './diffstat.js';
import { appendEvent, type EventOpts, readLineageEvents } from './events.js';
import {
  type Finding,
  findingScope,
  type RaiseFindingInput,
  raiseFinding,
  SPEC_FINDING_SCOPE,
  transition,
} from './findings.js';
import { type JudgeTurn, outstandingJudges, readJudgeTurns } from './judges.js';
import type { JudgeBudget } from './providers/types.js';
import {
  enabledExternalProviders,
  findingJudgeRequest,
  nativeProviderName,
  type ProviderVerdict,
  type QuorumResult,
  runQuorumCase,
  type TriggerReason,
} from './quorum.js';
import {
  type CompiledSchemaSet,
  compileSchemas,
  type ValidationIssue,
  validateRecord,
} from './schemas.js';
import { canEscalate, decide, type LessonRule, type SeverityDecision } from './severity.js';
import { type AddedTask, readAddedTasks } from './taskEvents.js';
import { taskIdsMatch } from './taskId.js';
import { loadTaxonomy, type Taxonomy } from './taxonomy.js';
import { type CheckCommand, type RunResult, run as runTestgate } from './testgate.js';

// No GateError: a gate failing is the gate working. Every outcome here comes
// back as a verdict the caller records, never as an exception the caller
// might catch and shrug off. Do not add one back for symmetry.

export interface GateContext {
  sessionId: string;
  planVersion: number;
  causalParent: string | null;
  actor?: string;
}

/** Injection seam for the cross-provider quorum. Every field is optional: with none of them the gate reads factory/policies/crosscheck.yml itself, so flipping a provider there is the whole activation step (docs/runbooks/providers.md §4). */
export interface GateCrosscheckOptions {
  policy?: CrosscheckPolicy;
  budget?: JudgeBudget;
  fetchImpl?: typeof fetch;
}

export interface GateInput {
  taskId: string;
  /** Worker's structured Result, checked against result.schema.json before anything else runs. */
  result: unknown;
  worktreeDir: string;
  checks: CheckCommand[];
  /** Reviewer/verifier findings JSON for this task, each paired with the file it's about. */
  findingsInput: RaiseFindingInput[];
  /**
   * The plan's claims map, for attributing each finding to whoever owns its
   * file rather than to whoever is at the gate (D-41/P9-24). Omit it and every
   * finding stays on `taskId`, which is the pre-P9-24 behaviour — so a caller
   * that has no plan to hand (an ad-hoc gate run) is not forced to invent one.
   */
  ownership?: readonly ClaimedTask[];
  /**
   * The ref the task's branch has to be ahead of — normally
   * `smith/<epic>/integration`, the base the worktree was cut from. Optional
   * like `ownership`: an ad-hoc gate run against a repo with no integration
   * branch is not forced to invent one, and gets `commitsAhead: null` on the
   * certificate rather than a silent pass (P9-8). The budget check reads the
   * same field to measure the diff against; without it, `measureDiff` falls
   * back to the base the task-branch name implies (P9-18, src/diffstat.ts).
   */
  baseRef?: string;
  /**
   * The whole grader result file, as read off disk (D-34/P9-14). Checked
   * against grader-verdict.schema.json before the tests run, and a not-met
   * rubric blocks the gate. Omit it and the pipeline is the pre-P9-14 one — an
   * ad-hoc gate run is not forced to invent a rubric result.
   */
  graderVerdict?: unknown;
  lessons: readonly LessonRule[];
  /** Where artifact homes live; defaults to `state/artifacts` (P9-22). */
  artifactsDir?: string;
  runAll?: boolean;
  timeoutMs?: number;
  crosscheck?: GateCrosscheckOptions;
  /**
   * The gated task's declared budget, straight from its plan entry (P9-18).
   * Omit it and the gate says so in the event rather than skipping the check —
   * an ad-hoc gate run with no plan to hand is a legitimate case, but a check
   * that leaves no trace is indistinguishable from one that never ran.
   */
  budget?: TaskBudget;
  coverage?: GateCoverageOptions;
}

/**
 * Where to find the coverage run's machine-readable evidence, and which check
 * produces it. Both have defaults, so wiring coverage evidence into an
 * existing caller is a matter of naming a check `coverage` — and a gate with
 * no such check is untouched by any of this (P9-25).
 */
export interface GateCoverageOptions {
  /** Name of the check in `checks` whose evidence this is. Default `coverage`. */
  checkName?: string;
  /** Summary path relative to the worktree. Default `coverage/coverage-summary.json`. */
  summaryPath?: string;
}

/**
 * What the gate could establish about this task's economy. `not-declared` and
 * `unmeasurable` are outcomes, not omissions: the first means the plan named no
 * budget, the second that git could not be asked (the worktree is not a
 * checkout, or the base ref does not resolve). Reporting either as a clean
 * zero-line, zero-overrun check would make every cap pass forever.
 */
export interface BudgetCheck {
  status: 'checked' | 'not-declared' | 'unmeasurable';
  overruns: BudgetOverrun[];
  /** From the result's token_usage — real spend, not the plan's estimate. */
  tokensUsed?: number;
  /** Authored lines changed; absent when the diff could not be measured. */
  diffLines?: number;
  baseRef?: string;
  excludedLines?: number;
  /**
   * Counted paths git gave no lines for, present only when there are any. A
   * binary file adds 0 to `diffLines`, so a real diff can pass a cap on a zero
   * that means "could not count" (D-157) — this is what makes that zero
   * readable instead of invisible.
   */
  unmeasuredFiles?: string[];
  unmeasurableReason?: string;
}

export interface SeverityDecisionRecord {
  fingerprint: string;
  findingId: string;
  originalSeverity: string;
  decision: SeverityDecision;
}

/** A quorum case the gate could not settle: the finding still blocks, and the operator gets both rationales side by side (crosscheck.yml `quorum_rule.tie_break`). */
export interface QuorumEscalation {
  findingId: string;
  triggerReason: TriggerReason;
  reason: 'disagreement' | 'insufficient-providers';
  rationales: ProviderVerdict[];
}

/**
 * A finding this gate run did NOT keep: it was about a file the gated task
 * does not own, so it went to the owner (`reassigned`) or to a follow-up task
 * against the epic (`follow-up`). Reported on the outcome so the caller can
 * say what moved and where — a finding that silently changed hands is how the
 * gated task ends up looking clean when it never was.
 */
export interface ReattributedFinding {
  findingId: string;
  filePath: string;
  /** The task the finding now belongs to: the owner, or the new follow-up. */
  taskId: string;
  attribution: 'reassigned' | 'follow-up';
  reason: string;
}

export type GateOutcome =
  | {
      outcome: 'pass';
      taskId: string;
      testResult: RunResult;
      /** Absent only when the run never got as far as certifying — i.e. a schema-invalid block. */
      commitCheck?: CommitCertificate;
      /** Absent means finding intake never ran; `[]` means it ran and settled. Only ever non-empty when at least one ACTIVE external judge took part — a shadow-mode case has nothing to escalate. */
      quorumEscalations?: QuorumEscalation[];
      reattributedFindings?: ReattributedFinding[];
      specFindings?: Finding[];
      budgetCheck?: BudgetCheck;
      /** Present exactly when a coverage check ran (P9-25). */
      coverageEvidence?: CoverageEvidence;
    }
  | {
      outcome: 'blocked';
      taskId: string;
      reason:
        | 'schema-invalid'
        | 'artifacts-missing'
        | 'not-committed'
        | 'deps-missing'
        | 'judges-outstanding'
        | 'grader-invalid'
        | 'grader-fail'
        | 'tests-failed'
        | 'coverage-evidence'
        | 'findings';
      testResult: RunResult | null;
      /**
       * Why the result document failed its schema — inline, exactly as
       * `testResult` carries why the tests failed (P9-21). The block used to
       * name the reason and nothing else, so the one caller who could act on it
       * had to go back to the event log to read the `schema-check-result` it had
       * just caused. Required, not optional, for the same reason `testResult`
       * is: an absent field and an empty one must not both mean "no errors".
       */
      schemaErrors: ValidationIssue[];
      blockingFindings: Finding[];
      /**
       * Required, and `[]` when the artifacts were fine — an absent field and
       * an empty one must not both have to mean "nothing wrong here".
       */
      artifactIssues: ArtifactIssue[];
      commitCheck?: CommitCertificate;
      /** Absent means finding intake never ran; `[]` means it ran and settled. Only ever non-empty when at least one ACTIVE external judge took part — a shadow-mode case has nothing to escalate. */
      quorumEscalations?: QuorumEscalation[];
      reattributedFindings?: ReattributedFinding[];
      specFindings?: Finding[];
      /** Set only on `judges-outstanding`: the judges this task is still waiting on, and the file each one owes. */
      outstandingJudges?: JudgeTurn[];
      budgetCheck?: BudgetCheck;
      coverageEvidence?: CoverageEvidence;
    }
  | {
      outcome: 'pass-with-waivers-pending';
      taskId: string;
      testResult: RunResult;
      commitCheck?: CommitCertificate;
      pendingFindings: Finding[];
      /** Absent means finding intake never ran; `[]` means it ran and settled. Only ever non-empty when at least one ACTIVE external judge took part — a shadow-mode case has nothing to escalate. */
      quorumEscalations?: QuorumEscalation[];
      reattributedFindings?: ReattributedFinding[];
      specFindings?: Finding[];
      budgetCheck?: BudgetCheck;
      coverageEvidence?: CoverageEvidence;
    };

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

function resolveTaxonomyAndSchemas(opts: EventOpts): {
  taxonomy: Taxonomy;
  schemas: CompiledSchemaSet;
} {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(cachedTaxonomy);
  const taxonomy = opts.taxonomy ?? cachedTaxonomy;
  const schemas = opts.schemas ?? cachedSchemas;
  return { taxonomy, schemas };
}

async function emit(
  eventType: string,
  payload: Record<string, unknown>,
  taskId: string,
  ctx: GateContext,
  opts: EventOpts,
): Promise<void> {
  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: eventType,
      task_id: taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload,
    },
    opts,
  );
}

/**
 * Canonical form for content-addressing a Result: object keys sorted at every
 * depth, arrays left in the order they were written (an artifact list is a
 * sequence, not a set). Two serializations of one Result must hash the same,
 * or a round-trip through JSON would read as a second worker run.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function resultHash(result: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(result)))
    .digest('hex');
}

/**
 * D-23/P9-12 — emit the event the rest of the factory has been reading and
 * nobody was writing.
 *
 * `task-result-recorded` is what agents-registry.ts closes a live agent on and
 * what db/queries.ts's analytics() and tokensSpentByEpic() sum `token_usage`
 * out of. Until now the only way one reached the log was an operator typing
 * `smith event append`, so "agent still live" and "0 tokens spent" were not
 * observations — they were a record of what someone remembered to write down.
 * The gate is the right producer because it is the one component that has
 * already proved the Result is schema-valid; emitting from the dispatcher
 * would put unvalidated payloads into the rows budget accounting trusts.
 *
 * Emitted BEFORE the test gate runs and regardless of how the gate then rules:
 * the worker's tokens were spent and its agent stopped running whether or not
 * the tests it left behind pass. Deferring the event to a clean outcome would
 * make the live-agent count wrong for exactly the tasks that go wrong.
 *
 * Deduped on a content hash rather than an event id, scoped to the session and
 * task: `smith gate run` over an unchanged result.json is an operator
 * re-reading their own gate, not a second worker run, and double-counting it
 * would inflate the very budget numbers P9-17/P9-18 exist to make honest. A
 * genuinely re-run worker differs somewhere — a new `token_usage` at the very
 * least — and hashes differently, so it counts again.
 *
 * The dedup reads the lineage (D-119). "Scoped to the session" was the bug: an
 * epic that continues in a fresh session re-gates the same result.json against
 * an empty history, and the double count lands in the budget numbers P9-17/
 * P9-18 exist to keep honest.
 */
async function recordResult(
  result: unknown,
  taskId: string,
  ctx: GateContext,
  opts: EventOpts,
): Promise<void> {
  const hash = resultHash(result);
  const events = await readLineageEvents(ctx.sessionId, opts);
  for (const { record } of events) {
    if (record.event_type !== TASK_RESULT_EVENT_TYPE) continue;
    // Matched, not compared: the same task reaches the log under both
    // spellings — whoever appended a result stamped what they typed, and
    // `smith gate run` stamps its own argument — and a raw `!==` makes the
    // dedup miss its own task (D-183). The content hash below still has to
    // agree, so a match here can only ever suppress a byte-identical Result.
    if (!taskIdsMatch(record.task_id, taskId)) continue;
    // Re-hashed from the stored payload, not carried on it: the payload is the
    // Result verbatim (db/projector.ts reads it as one), and a hash field
    // wedged in beside it would be a Result that no longer validates.
    if (resultHash(record.payload) === hash) return;
  }
  await emit(TASK_RESULT_EVENT_TYPE, result as Record<string, unknown>, taskId, ctx, opts);
}

interface IntakeResult {
  blocking: Finding[];
  pendingWaivers: Finding[];
  escalations: QuorumEscalation[];
  reattributed: ReattributedFinding[];
  /** Findings that say the PLAN is wrong: reported, never blocking (P9-9/D-33). */
  specFindings: Finding[];
}

/** A judge call is a network round-trip, not a test: generous enough that a reasoning model finishes, bounded so one hung provider can't hold the gate open. */
const DEFAULT_JUDGE_BUDGET: JudgeBudget = { timeout_ms: 120_000, max_output_bytes: 262_144 };

/**
 * crosscheck.yml `quorum_triggers`, restricted to the two the gate owns: "any
 * S1/S2 finding, before it blocks a task" and "same-mistake findings
 * (judgment.same-mistake)". These two are automatic — every intake evaluates
 * them. The other two live in their own operator-invoked hosts and call
 * runQuorumCase() the same way: epic-level final verdict in epic.ts
 * (`smith epic verdict`) and the plan_quorum triggers in planQuorum.ts
 * (`smith plan quorum`). See docs/runbooks/providers.md §2.
 */
function quorumTriggerFor(decision: SeverityDecision): TriggerReason | null {
  if (decision.sameMistake) return 'same-mistake';
  if (decision.blocks) return 'blocking-finding';
  return null;
}

interface ResolvedCrosscheck {
  policy: CrosscheckPolicy;
  providers: string[];
  nativeProvider: string;
  budget: JudgeBudget;
}

/** null when no external provider is `enabled` — the shipped default, and the reason cross-checking costs exactly nothing until an operator turns it on. */
function resolveCrosscheck(input: GateInput): ResolvedCrosscheck | null {
  const policy = input.crosscheck?.policy ?? loadCrosscheckPolicy();
  const providers = enabledExternalProviders(policy);
  if (providers.length === 0) return null;
  return {
    policy,
    providers,
    nativeProvider: nativeProviderName(policy),
    budget: input.crosscheck?.budget ?? DEFAULT_JUDGE_BUDGET,
  };
}

function quorumDecisionPayload(
  quorum: QuorumResult,
  finding: Finding,
  trigger: TriggerReason,
  finderProvider: string,
  blocks: boolean,
): Record<string, unknown> {
  const gating = quorum.gating;
  return {
    task_id: finding.task_id,
    finding_id: finding.finding_id,
    fingerprint: finding.fingerprint,
    trigger_reason: trigger,
    finder_provider: finderProvider,
    outcome: gating.outcome,
    decision: gating.outcome === 'decided' ? gating.decision : null,
    agreement: gating.outcome === 'decided' ? gating.agreement : null,
    gating_participants: gating.outcome === 'decided' ? gating.participants : [],
    escalation_reason: gating.outcome === 'escalate' ? gating.reason : null,
    rationales: gating.outcome === 'escalate' ? gating.rationales : [],
    participants: quorum.participants.map((p) => ({
      provider: p.provider,
      mode: p.mode,
      ok: p.ok,
      verdict: p.verdict,
      excluded_as_finder: p.excludedAsFinder,
    })),
    native_verdict: 'confirm',
    /** What the gate actually did with the finding after the quorum spoke. */
    blocks,
  };
}

interface CrossCheckArgs {
  finding: Finding;
  filePath: string;
  trigger: TriggerReason;
  decision: SeverityDecision;
  crosscheck: ResolvedCrosscheck;
  input: GateInput;
}

/**
 * Run one quorum case for a finding that tripped a trigger, emit its
 * `quorum-decision` event, and report whether the quorum overturned the
 * finding. Escalations are appended to `escalations` (an operator-facing
 * list) only when an ACTIVE external judge actually took part — a
 * shadow-mode case always comes back `insufficient-providers` by
 * construction and there is nothing there for an operator to arbitrate.
 */
async function crossCheckFinding(
  args: CrossCheckArgs,
  ctx: GateContext,
  opts: EventOpts,
  escalations: QuorumEscalation[],
): Promise<boolean> {
  const { finding, trigger, crosscheck } = args;
  // asymmetric_roles.finder_ne_critic: whoever raised the finding gets no
  // vote on it. Unknown provenance reads as the native provider — the
  // conservative default, since it removes a vote rather than adding one.
  const finderProvider = finding.found_by_provider ?? crosscheck.nativeProvider;

  const quorum = await runQuorumCase(
    {
      taskId: finding.task_id,
      findingId: finding.finding_id,
      triggerReason: trigger,
      finderProvider,
      kind: 'verify',
      native: {
        provider: crosscheck.nativeProvider,
        verdict: 'confirm',
        rationale: finding.summary,
      },
      providers: crosscheck.providers,
      request: findingJudgeRequest(finding, args.filePath, crosscheck.budget),
      policy: crosscheck.policy,
      quorumPolicy: { minProviders: crosscheck.policy.quorumRule.minProviders },
      fetchImpl: args.input.crosscheck?.fetchImpl,
    },
    ctx,
    opts,
  );

  const gating = quorum.gating;
  const overturned = gating.outcome === 'decided' && gating.decision === 'refute';
  const blocks = overturned ? false : args.decision.blocks;

  if (gating.outcome === 'escalate') {
    const hadActiveJudge = quorum.participants.some(
      (p) => p.mode === 'active' && p.ok && !p.excludedAsFinder,
    );
    if (hadActiveJudge) {
      escalations.push({
        findingId: finding.finding_id,
        triggerReason: trigger,
        reason: gating.reason,
        rationales: gating.rationales,
      });
    }
  }

  await emit(
    'quorum-decision',
    quorumDecisionPayload(quorum, finding, trigger, finderProvider, blocks),
    finding.task_id,
    ctx,
    opts,
  );

  return overturned;
}

/** One row of the grader's rubric, once it has validated. */
interface GradedCriterion {
  criterion: string;
  status: 'pass' | 'fail' | 'partial';
  evidence: string;
}

type GraderCheck = { ok: true } | { ok: false; reason: 'grader-invalid' | 'grader-fail' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the grader's rubric result and let it gate (D-34/P9-14). The grader
 * runs before the gates precisely so its verdict can inform them, but until
 * now no code path opened the file — which is how two graders on the same
 * template wrote two different shapes and nothing objected. A schema is
 * load-bearing only if something loads it.
 *
 * The verdict lives at `.structured_output` of the result envelope the grader
 * writes (.claude/agents/grader.md, "Output contract"); the envelope itself is
 * a Result and is not re-checked here. Three ways to not pass: the file is not
 * shaped like a grader result (`grader-invalid`), the run came back `dead`
 * because the task spec had no checkable acceptance criteria (`grader-fail`,
 * verdict `not-graded`), or the rubric says the criteria were not met
 * (`grader-fail`).
 */
async function checkGraderVerdict(
  verdictFile: unknown,
  taskId: string,
  ctx: GateContext,
  opts: EventOpts,
  taxonomy: Taxonomy,
  schemas: CompiledSchemaSet,
): Promise<GraderCheck> {
  const emitVerdict = (payload: Record<string, unknown>) =>
    emit(
      'grader-verdict',
      {
        run_status: null,
        round: null,
        overall: null,
        failed_criteria: [],
        errors: [],
        ...payload,
      },
      taskId,
      ctx,
      opts,
    );

  if (!isRecord(verdictFile)) {
    await emitVerdict({
      verdict: 'invalid',
      errors: [{ path: '/', message: 'grader verdict file is not a JSON object' }],
    });
    return { ok: false, reason: 'grader-invalid' };
  }

  const runStatus = verdictFile.run_status;
  // `dead` is the grader's own word for "this task spec has no checkable
  // acceptance criteria". Reported as its own verdict rather than as a missing
  // `structured_output`, which is what it would otherwise look like.
  if (runStatus === 'dead') {
    await emitVerdict({ verdict: 'not-graded', run_status: runStatus });
    return { ok: false, reason: 'grader-fail' };
  }

  const structured = verdictFile.structured_output;
  if (!isRecord(structured)) {
    await emitVerdict({
      verdict: 'invalid',
      run_status: typeof runStatus === 'string' ? runStatus : null,
      errors: [
        {
          path: '/structured_output',
          message:
            'grader verdict must be at .structured_output (round, criteria, overall), per the grader Output contract',
        },
      ],
    });
    return { ok: false, reason: 'grader-invalid' };
  }

  const validation = validateRecord(schemas, taxonomy, 'grader-verdict', structured);
  if (!validation.valid) {
    await emitVerdict({
      verdict: 'invalid',
      run_status: typeof runStatus === 'string' ? runStatus : null,
      errors: validation.errors,
    });
    return { ok: false, reason: 'grader-invalid' };
  }

  const criteria = structured.criteria as GradedCriterion[];
  // A `fail` or `partial` criterion under an overall `pass` is the grader
  // contradicting itself, and the per-criterion verdict is the one carrying
  // evidence — so it wins. `partial` is what the grader writes when it runs
  // out of context mid-rubric: a criterion nobody finished grading is not met.
  const failed = criteria.filter((c) => c.status !== 'pass');
  const met = structured.overall === 'pass' && failed.length === 0;

  await emitVerdict({
    verdict: met ? 'met' : 'not-met',
    run_status: typeof runStatus === 'string' ? runStatus : null,
    round: structured.round,
    overall: structured.overall,
    failed_criteria: failed,
    ...(Array.isArray(structured.gaps) ? { gaps: structured.gaps } : {}),
  });
  return met ? { ok: true } : { ok: false, reason: 'grader-fail' };
}

async function intakeAndDecide(
  input: GateInput,
  ctx: GateContext,
  opts: EventOpts,
): Promise<IntakeResult> {
  const decisions: SeverityDecisionRecord[] = [];
  const blocking: Finding[] = [];
  const pendingWaivers: Finding[] = [];
  const escalations: QuorumEscalation[] = [];
  const reattributed: ReattributedFinding[] = [];
  const specFindings: Finding[] = [];

  // Resolved at most once per gate run, and only if some finding actually
  // trips a trigger — a task with no S1/S2 and no same-mistake finding never
  // reads crosscheck.yml at all.
  let crosscheck: ResolvedCrosscheck | null | undefined;

  // Whose finding each one is, decided up front and written nowhere yet: a
  // routing that turns out to belong to a waived or refuted finding is simply
  // dropped, and mints no task for a bug nobody is going to fix.
  const routings: RoutedFinding[] = await routeFindings(
    input.findingsInput,
    { defaultTaskId: input.taskId, ownership: input.ownership },
    ctx,
    opts,
  );

  for (const routing of routings) {
    const filePath = routing.input.filePath;

    const raised = await raiseFinding(routing.input, ctx, opts);
    if (raised.suppressed) continue;

    const decision = decide(
      { finding_category: raised.finding.finding_category, severity: raised.finding.severity },
      { filePath, lessons: input.lessons },
    );
    decisions.push({
      fingerprint: raised.finding.fingerprint,
      findingId: raised.finding.finding_id,
      originalSeverity: raised.finding.severity,
      decision,
    });

    const effective: Finding = { ...raised.finding, severity: decision.severity };

    const trigger = quorumTriggerFor(decision);
    if (trigger) {
      if (crosscheck === undefined) crosscheck = resolveCrosscheck(input);
      if (crosscheck !== null) {
        const overturned = await crossCheckFinding(
          { finding: effective, filePath, trigger, decision, crosscheck, input },
          ctx,
          opts,
          escalations,
        );
        // The one behavior change a quorum can make: a decided refute kills
        // the finding outright, so it neither blocks nor spends a waiver.
        // Everything else (decided confirm, either escalation, shadow mode)
        // leaves the severity decision exactly as severity.ts made it.
        if (overturned) {
          await transition(effective.finding_id, 'refuted', ctx, opts);
          continue;
        }
      }
    }

    // A spec finding says the code is right and the plan is wrong, so it
    // leaves before attribution rather than after it: reattribution would
    // hand it to whoever owns the file, or mint a follow-up task, and neither
    // can contain the fix — the fix is a plan amendment (spec.ts's
    // amendPlan). Blocking here instead is D-33, the deadlock this diverts
    // around: the gated diff cannot legally change the criterion it violates.
    if (findingScope(effective) === SPEC_FINDING_SCOPE) {
      specFindings.push(effective);
      continue;
    }

    // Only now — past the waiver check and past the quorum — is the finding
    // real enough to change somebody else's world. A finding that belongs to
    // another task never enters `blocking`: blocking here would stop a diff
    // that cannot contain the fix, which is D-41 itself.
    if (routing.attribution !== 'gated') {
      await recordReattribution(routing, effective, ctx, opts);
      reattributed.push({
        findingId: effective.finding_id,
        filePath,
        taskId: routing.taskId,
        attribution: routing.attribution,
        reason: routing.reason,
      });
      continue;
    }

    if (decision.blocks) blocking.push(effective);
    else if (decision.action === 'waiver-batch') pendingWaivers.push(effective);
  }

  await emit(
    'severity-decisions',
    {
      decisions: decisions.map((d) => ({
        fingerprint: d.fingerprint,
        finding_id: d.findingId,
        original_severity: d.originalSeverity,
        severity: d.decision.severity,
        action: d.decision.action,
        same_mistake: d.decision.sameMistake,
        matched_lesson_id: d.decision.matchedLessonId,
      })),
      // The instrument, recorded next to the reading. Every `same_mistake:
      // false` above is conditional on the gate having held a lesson that
      // could have said otherwise, and `--lessons` is optional (cli.ts): a
      // gate run without it decides "no repeat" for every finding and used to
      // leave no trace that it was blind. Without this count the same-mistake
      // KPI cannot tell a clean run from an unequipped one, so it reports
      // `unverifiable` for every intake missing it — including all the ones
      // already on disk, deliberately.
      lessons_loaded: input.lessons.length,
      lessons_escalating: input.lessons.filter(canEscalate).length,
    },
    input.taskId,
    ctx,
    opts,
  );

  return { blocking, pendingWaivers, escalations, reattributed, specFindings };
}

export interface DepsCheck {
  /** False only when the worktree declares dependencies and has not installed them. */
  ok: boolean;
  /** Whether there was anything to install at all — a no-op check is still a check. */
  declaresDependencies: boolean;
  /** What was looked at and what was concluded, in one sentence, for the log. */
  detail: string;
}

const BIN_DIR = path.join('node_modules', '.bin');

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

const DEFAULT_COVERAGE_CHECK = 'coverage';

/**
 * The per-file numbers a coverage check produced, or null when this gate has
 * no coverage check to speak for (D-40/P9-25).
 *
 * The subjects are the gated task's OWN literal claims. Not the whole plan's:
 * a file another task owns is that task's gate's business, and blocking here
 * for it is D-41 in a new costume. Not its globs either — `src/**` names a
 * region, and a region has no single number a per-file criterion could cite.
 *
 * A table with no row for this task is not that task owning no file. The read
 * used to spell both `[]`, and zero subjects reports `complete: true` — "0 of
 * 0 named files have a per-file number" — so the gate passed by never having
 * looked at anything, on exactly the runs where a plan WAS handed to it.
 * `CoverageEvidence.complete` says what that is worth: "Evidence that omits
 * the subject of the criterion is not evidence."
 *
 * The reachable spelling is the id form, not a typo. A plan lists
 * `epic-1/task-1` and an operator types `task-1` — which is why plan.ts
 * carries resolveTaskId ("Use the full id the plan lists"), and why cli.ts's
 * budgetFromFlags resolves through it before reading the budget off the very
 * same `--plan` file. This read compares raw strings, so on one `smith gate
 * run` the budget check finds its task and coverage silently finds nobody. A
 * `--plan` from the wrong epic reads the same way from in here.
 *
 * So it refuses, and cli.ts already wrote the rule for the dispatch side of
 * the same read: "a `--plan` that names a task it does not contain is an error
 * rather than an empty claims list, which would silently drop every claim-path
 * lesson the task was supposed to see" (claimsForDispatch). Absent ownership
 * stays what it was — a caller with no plan to hand is not forced to invent
 * one, and gets the total with no subjects to narrow it.
 *
 * The plan is not the only register (D-48/P9-31). A follow-up minted by
 * `findings raise` is real, gateable work that no plan version has been cut
 * for yet — budgetFromFlags reports its budget as not-declared rather than
 * refusing to gate it — and `gate run` has no `--claims` flag, so for such a
 * task "use the id the plan lists" names no id that exists. Refusing on the
 * plan alone would make every follow-up gate carrying a coverage check
 * unpassable. `emitFollowUpTask` wrote its claims into the log, so the log is
 * asked second, and only for the one id at the gate: it is a register of what
 * was added, not a second ownership table, and folding every added task into
 * the map would change whose finding is whose on gates that have nothing to
 * do with follow-ups.
 */
async function gatherCoverageEvidence(
  input: GateInput,
  ctx: GateContext,
  opts: EventOpts,
): Promise<CoverageEvidence | null> {
  const checkName = input.coverage?.checkName ?? DEFAULT_COVERAGE_CHECK;
  if (!input.checks.some((c) => c.name === checkName)) return null;
  const owner = input.ownership?.find((t) => t.task_id === input.taskId);
  // Only when the plan came up empty, and only then: this fold reads the whole
  // lineage, and the common gate is a planned task the table names on the
  // first pass.
  const registered =
    input.ownership !== undefined && owner === undefined
      ? await readAddedTasks({ sessionId: ctx.sessionId }, opts)
      : [];
  const claims = owner?.claims ?? loggedClaims(registered.find((t) => t.taskId === input.taskId));
  const evidence = await collectCoverageEvidence({
    worktreeDir: input.worktreeDir,
    claims: claims ?? [],
    ...(input.coverage?.summaryPath ? { summaryPath: input.coverage.summaryPath } : {}),
  });
  if (input.ownership === undefined || claims !== undefined) return evidence;

  // Whatever the reporter did produce stays on the certificate: the hole is
  // whose files to judge, not whether the run measured anything.
  const known = [
    ...new Set([
      ...input.ownership.map((t) => t.task_id ?? '(unnamed)'),
      ...registered.map((t) => t.taskId),
    ]),
  ].join(', ');
  return {
    ...evidence,
    complete: false,
    detail: `neither the ownership table handed to this gate nor the log's register of added tasks has readable claims for "${input.taskId}", so this task's coverage subjects cannot be read and zero subjects would report complete without measuring anything. Known task ids: ${known === '' ? '(none)' : known} — use the id the plan lists, or record the follow-up before gating it.`,
  };
}

/**
 * The claims a `task-added` introduced this id with, or undefined when the log
 * does not name it or names it with something that is not a list of paths.
 * `AddedTask.claims` is `unknown` because the payload is free-form, and a
 * half-readable list is the same hole as no list: filtering it would hand the
 * criterion a shorter subject set than the task declared and call that
 * complete.
 */
function loggedClaims(task: AddedTask | undefined): string[] | undefined {
  if (task === undefined || !Array.isArray(task.claims)) return undefined;
  return task.claims.every((c) => typeof c === 'string') ? (task.claims as string[]) : undefined;
}

/**
 * Does this worktree own the toolchain its checks are about to run?
 *
 * `git worktree add` does not bring `node_modules` with it — git never copies
 * an ignored directory — and Node answers a missing dependency by walking UP
 * the filesystem. A task worktree under the factory's own tree therefore
 * finds the FACTORY's vitest and biome, runs those, and the gate reports
 * their verdict as if it were the project's. Wave 3 shipped a green epic that
 * way (P9-16d).
 *
 * The question asked is `node_modules/.bin`, not `node_modules`: a vite run
 * creates `node_modules/.vite` by itself, and that directory is precisely
 * what made wave 3's worktree look installed. A project that declares no
 * dependencies has nothing to install and is not blocked — the check reports
 * that it ran and found nothing to do, rather than staying silent.
 */
export function checkWorktreeDeps(worktreeDir: string): DepsCheck {
  let manifest: { dependencies?: unknown; devDependencies?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(worktreeDir, 'package.json'), 'utf8'));
  } catch (err) {
    // A malformed package.json is a real problem, but it is not THIS problem,
    // and blocking on it here would file a JSON syntax error under "you forgot
    // to install". The schema and test gates downstream get to say it.
    const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'has no' : 'has an unreadable';
    return {
      ok: true,
      declaresDependencies: false,
      detail: `${worktreeDir} ${why} package.json — nothing to install.`,
    };
  }

  const counts = (section: unknown): number =>
    typeof section === 'object' && section !== null ? Object.keys(section).length : 0;
  const declared = counts(manifest.dependencies) + counts(manifest.devDependencies);
  if (declared === 0) {
    return {
      ok: true,
      declaresDependencies: false,
      detail: 'package.json declares no dependencies — nothing to install.',
    };
  }

  if (isDirectory(path.join(worktreeDir, BIN_DIR))) {
    return {
      ok: true,
      declaresDependencies: true,
      detail: `${declared} dependencies declared and ${BIN_DIR} is present.`,
    };
  }

  return {
    ok: false,
    declaresDependencies: true,
    detail:
      `${declared} dependencies declared but ${BIN_DIR} is missing in ${worktreeDir}. ` +
      'Every check would resolve its binaries from a parent node_modules, so the ' +
      'result would describe some other tree. Run `pnpm install` in the worktree.',
  };
}

/**
 * The composed gate pipeline for one task: schemaCheck(result) -> commit
 * certificate -> worktree deps -> outstanding judges -> grader verdict ->
 * testgate -> intake(findings) -> severity decisions -> outcome. The cheap
 * refusals run first on purpose: each one is a reason the stages below it
 * would be scoring something other than the diff the merge queue will take.
 * Every stage emits its own event before the next stage runs; the function
 * returns a pure structured outcome and never dispatches anything itself
 * (dispatch decisions — e.g. bouncing back to the coder — stay with the
 * caller).
 */
export async function runGate(
  input: GateInput,
  ctx: GateContext,
  opts: EventOpts = {},
): Promise<GateOutcome> {
  const { taxonomy, schemas } = resolveTaxonomyAndSchemas(opts);

  const schemaResult = validateRecord(schemas, taxonomy, 'result', input.result);
  await emit(
    'schema-check-result',
    { valid: schemaResult.valid, errors: schemaResult.valid ? [] : schemaResult.errors },
    input.taskId,
    ctx,
    opts,
  );
  if (!schemaResult.valid) {
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'schema-invalid',
        testResult: null,
        schemaErrors: schemaResult.errors,
        blockingFindings: [],
        artifactIssues: [],
      },
      ctx,
      opts,
    );
  }

  // The worker's Result is a fact about a run that already happened, so it is
  // recorded before the gate's own refusals — a task blocked for an uncommitted
  // worktree or an owed judge still produced this Result, and the projector
  // should see it (P9-12).
  await recordResult(input.result, input.taskId, ctx, opts);

  // Before the tests, for the same reason the schema check comes before them:
  // a Result whose evidence cannot be opened is not worth spending a test run
  // on, and the operator would rather be told which path than be told it late.
  // Behind the record above, though: a task blocked for an artifact under /tmp
  // still produced this Result, exactly as one blocked for an uncommitted
  // worktree did (P9-12).
  const artifacts = (input.result as { artifacts?: ArtifactDecl[] }).artifacts ?? [];
  const artifactCheck = checkArtifacts(artifacts, {
    taskId: input.taskId,
    artifactsDir: input.artifactsDir,
  });
  await emit(
    'artifact-check-result',
    {
      ok: artifactCheck.ok,
      checked: artifactCheck.checked,
      home: artifactCheck.home,
      issues: artifactCheck.issues,
    },
    input.taskId,
    ctx,
    opts,
  );
  if (!artifactCheck.ok) {
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'artifacts-missing',
        testResult: null,
        schemaErrors: [],
        blockingFindings: [],
        artifactIssues: artifactCheck.issues,
      },
      ctx,
      opts,
    );
  }

  // Before anything expensive runs: is there a commit here to score at all?
  // The gate scores a worktree, the merge queue merges a branch — when those
  // are two different things, every check below goes green against work the
  // merge will never see (D-30 / P9-8).
  const commitCheck = certifyCommit(input.worktreeDir, {
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
  });
  await emit(
    'commit-check-result',
    {
      certified: commitCheck.certified,
      reason: commitCheck.reason,
      head: commitCheck.head,
      branch: commitCheck.branch,
      dirty: commitCheck.dirty,
      base_ref: commitCheck.baseRef,
      base_sha: commitCheck.baseSha,
      commits_ahead: commitCheck.commitsAhead,
    },
    input.taskId,
    ctx,
    opts,
  );
  if (!commitCheck.certified) {
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'not-committed',
        testResult: null,
        schemaErrors: [],
        blockingFindings: [],
        artifactIssues: [],
        commitCheck,
      },
      ctx,
      opts,
    );
  }

  // Before anything is RUN in the worktree — the schema check only reads the
  // result document, but everything after this point executes a command there.
  // Behind the commit certificate for the same reason the tests are: a
  // toolchain proved sound in a worktree the merge will never see proves
  // nothing (P9-16d / D-30).
  const deps = checkWorktreeDeps(input.worktreeDir);
  await emit(
    'deps-check-result',
    { ok: deps.ok, declares_dependencies: deps.declaresDependencies, detail: deps.detail },
    input.taskId,
    ctx,
    opts,
  );
  if (!deps.ok) {
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'deps-missing',
        testResult: null,
        schemaErrors: [],
        blockingFindings: [],
        artifactIssues: [],
        commitCheck,
      },
      ctx,
      opts,
    );
  }

  // D-31, D-20 / P9-11. Scoring a task while one of its judges is still owed
  // is scoring an unknown: `--evidence` absent reads identically whether the
  // security reviewer found nothing or died mid-turn without writing its file,
  // and wave 3 produced five of the second kind in one wave. So the gate
  // compares the two sets before it does anything expensive. A task that
  // dispatched no judges through `smith judge dispatch` has an empty dispatch
  // set and is unaffected — this refuses only where there is a promise on
  // record to refuse against.
  const outstanding = outstandingJudges(await readJudgeTurns(input.taskId, ctx, opts));
  if (outstanding.length > 0) {
    await emit(
      'judges-outstanding',
      {
        judges: outstanding.map((j) => ({
          agent_role: j.role,
          round: j.round,
          declared_artifact: j.declaredArtifact,
        })),
      },
      input.taskId,
      ctx,
      opts,
    );
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'judges-outstanding',
        testResult: null,
        schemaErrors: [],
        blockingFindings: [],
        artifactIssues: [],
        commitCheck,
        outstandingJudges: outstanding,
      },
      ctx,
      opts,
    );
  }

  // Before the tests, not after: the grader has already run, and if its rubric
  // says the criteria were not met the diff bounces whatever the suite says —
  // so a full test run here is spent for nothing. It sits behind the commit
  // certificate for the same reason the tests do: a rubric scored against a
  // worktree the merge will never see is scored against nothing (D-30/D-34).
  if (input.graderVerdict !== undefined) {
    const grader = await checkGraderVerdict(
      input.graderVerdict,
      input.taskId,
      ctx,
      opts,
      taxonomy,
      schemas,
    );
    if (!grader.ok) {
      return finalize(
        {
          outcome: 'blocked',
          taskId: input.taskId,
          reason: grader.reason,
          testResult: null,
          schemaErrors: [],
          blockingFindings: [],
          artifactIssues: [],
          commitCheck,
        },
        ctx,
        opts,
      );
    }
  }

  // Before the testgate, not after: the runs that most need an economy record
  // are the expensive ones that then failed, and a check gated behind green
  // tests would never produce one for them. Behind the refusals above for the
  // opposite reason — a task blocked for an uncommitted worktree or an owed
  // judge has no diff worth measuring yet, and stamping one would put a
  // number on work the merge queue will never see.
  const budgetCheck = runBudgetCheck(input);
  await emit('budget-check-result', { ...budgetCheck }, input.taskId, ctx, opts);
  const budget = { budgetCheck };

  const testResult = await runTestgate(input.checks, {
    cwd: input.worktreeDir,
    runAll: input.runAll ?? false,
    timeoutMs: input.timeoutMs,
  });
  await emit(
    'testgate-result',
    { pass: testResult.pass, results: testResult.results },
    input.taskId,
    ctx,
    opts,
  );
  if (!testResult.pass) {
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'tests-failed',
        testResult,
        schemaErrors: [],
        blockingFindings: [],
        artifactIssues: [],
        commitCheck,
        ...budget,
      },
      ctx,
      opts,
    );
  }

  // After the tests pass, before the findings are judged: a green coverage
  // check that cannot name a number for the file the criterion is about has
  // not answered the criterion (D-40/P9-25).
  const coverage = await gatherCoverageEvidence(input, ctx, opts);
  const withCoverage = coverage === null ? {} : { coverageEvidence: coverage };
  if (coverage !== null) {
    await emit(
      'coverage-evidence',
      {
        summary_path: coverage.summaryPath,
        present: coverage.present,
        complete: coverage.complete,
        files_measured: coverage.filesMeasured,
        total: coverage.total,
        subjects: coverage.subjects.map((s) => ({
          path: s.path,
          status: s.status,
          lines_pct: s.coverage?.lines.pct ?? null,
          statements_pct: s.coverage?.statements.pct ?? null,
          functions_pct: s.coverage?.functions.pct ?? null,
          branches_pct: s.coverage?.branches.pct ?? null,
        })),
        detail: coverage.detail,
      },
      input.taskId,
      ctx,
      opts,
    );
    if (!coverage.complete) {
      return finalize(
        {
          outcome: 'blocked',
          taskId: input.taskId,
          reason: 'coverage-evidence',
          testResult,
          schemaErrors: [],
          blockingFindings: [],
          artifactIssues: [],
          commitCheck,
          ...budget,
          ...withCoverage,
        },
        ctx,
        opts,
      );
    }
  }

  const { blocking, pendingWaivers, escalations, reattributed, specFindings } =
    await intakeAndDecide(input, ctx, opts);
  // Reported on every outcome, not just the clean one: a task can block on its
  // own findings AND have handed one to somebody else in the same run.
  const moved = reattributed.length > 0 ? { reattributedFindings: reattributed } : {};
  // Same rule, and the reason a spec finding is not simply dropped: the gate
  // passes the diff and still has to say the plan is wrong, or a diverted
  // finding reads as a clean run.
  const diverted = specFindings.length > 0 ? { specFindings } : {};
  // Unconditional, unlike `moved`/`diverted` above: absent has to keep meaning
  // "intake never ran" (every block before this point returns early), so `[]`
  // is the only way to say the quorum ran and settled everything it saw.
  // Attached to the passing outcomes too, because an escalation is addressed to
  // the operator and does not become settled just because the finding that
  // raised it was waived, re-attributed, or diverted to the spec (D-201).
  const unsettled = { quorumEscalations: escalations };

  if (blocking.length > 0) {
    return finalize(
      {
        outcome: 'blocked',
        taskId: input.taskId,
        reason: 'findings',
        testResult,
        schemaErrors: [],
        blockingFindings: blocking,
        artifactIssues: [],
        commitCheck,
        ...unsettled,
        ...moved,
        ...diverted,
        ...budget,
        ...withCoverage,
      },
      ctx,
      opts,
    );
  }
  if (pendingWaivers.length > 0) {
    return finalize(
      {
        outcome: 'pass-with-waivers-pending',
        taskId: input.taskId,
        testResult,
        commitCheck,
        pendingFindings: pendingWaivers,
        ...unsettled,
        ...moved,
        ...diverted,
        ...budget,
        ...withCoverage,
      },
      ctx,
      opts,
    );
  }
  return finalize(
    {
      outcome: 'pass',
      taskId: input.taskId,
      testResult,
      commitCheck,
      ...unsettled,
      ...moved,
      ...diverted,
      ...budget,
      ...withCoverage,
    },
    ctx,
    opts,
  );
}

/** Real token spend off the already-schema-valid result, or undefined if absent. */
function tokensSpent(result: unknown): number | undefined {
  const usage = (result as { token_usage?: { total_tokens?: unknown } } | null)?.token_usage;
  return typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined;
}

/**
 * Declared budget vs. measured spend, for one task. The check never blocks: an
 * overrun is recorded on the outcome and in the event log, and the operator
 * decides. Blocking a green, reviewed task on its budget would move D-29's
 * "trade finishing for compliance" pressure off the agent and onto the gate,
 * and an overrun is as often evidence that the plan under-estimated the task as
 * that the task overran.
 */
function runBudgetCheck(input: GateInput): BudgetCheck {
  const tokensUsed = tokensSpent(input.result);
  if (input.budget === undefined) {
    return {
      status: 'not-declared',
      overruns: [],
      ...(tokensUsed !== undefined && { tokensUsed }),
    };
  }

  try {
    const measured = measureDiff(input.worktreeDir, {
      ...(input.baseRef !== undefined && { baseRef: input.baseRef }),
    });
    return {
      status: 'checked',
      overruns: checkTaskBudget({
        budget: input.budget,
        ...(tokensUsed !== undefined && { tokensUsed }),
        diffLines: measured.diffLines,
      }),
      ...(tokensUsed !== undefined && { tokensUsed }),
      diffLines: measured.diffLines,
      baseRef: measured.baseRef,
      excludedLines: measured.excludedLines,
      ...(measured.unmeasuredFiles.length > 0 && { unmeasuredFiles: measured.unmeasuredFiles }),
    };
  } catch (err) {
    // The token half is still worth having, so the diff half failing degrades
    // the check rather than cancelling it — but `diffLines` stays absent, since
    // "0 lines" and "could not look" must not read the same.
    return {
      status: 'unmeasurable',
      overruns: checkTaskBudget({
        budget: input.budget,
        ...(tokensUsed !== undefined && { tokensUsed }),
      }),
      ...(tokensUsed !== undefined && { tokensUsed }),
      unmeasurableReason:
        err instanceof DiffstatError ? `${err.code}: ${err.message}` : String(err),
    };
  }
}

async function finalize(
  outcome: GateOutcome,
  ctx: GateContext,
  opts: EventOpts,
): Promise<GateOutcome> {
  await emit(
    'gate-outcome',
    { outcome: outcome.outcome, reason: 'reason' in outcome ? outcome.reason : null },
    outcome.taskId,
    ctx,
    opts,
  );
  return outcome;
}
