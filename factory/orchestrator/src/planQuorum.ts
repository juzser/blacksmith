import { loadBudgetPolicy } from './budgets.js';
import {
  type CrosscheckPolicy,
  loadCrosscheckPolicy,
  type PlanQuorumPolicy,
} from './crosscheck.js';
import { appendEvent, type EventOpts } from './events.js';
import type { EventContext } from './findings.js';
import {
  livePlanTasks,
  loadPlan,
  type PlanFile,
  type PlanOpts,
  planRefTaskId,
  type TaskSpecRecord,
} from './plan.js';
import type { JudgeBudget, JudgeRequest } from './providers/types.js';
import {
  enabledExternalProviders,
  nativeProviderName,
  type QuorumResult,
  runQuorumCase,
  type TriggerReason,
} from './quorum.js';

/**
 * Fourth quorum_triggers host (factory/policies/crosscheck.yml): the
 * `plan_quorum` block's three triggers (epic budget, security-sensitive
 * case/role/clause, low planner confidence) — "smith plan quorum". Same
 * trigger-agnostic quorum.ts engine gate.ts/epic.ts already use; this module
 * is a CALLER, not a variant of it.
 *
 * CRITIQUE-ONLY, by construction: every export below is either a pure
 * function or an async function whose only side effects are reading a plan
 * file (loadPlan(), read-only) and appending events. Nothing here calls
 * plan.ts's nextVersion() or its private writePlanFile() — neither is even
 * imported — and no event type emitted here is one any `plan cut` path
 * treats as plan-mutating. A non-zero `smith plan quorum` exit means
 * "operator must look at this before approving the plan"; it never rewrites
 * the plan and never blocks anything automatically (proven in
 * test/planQuorum.test.ts: after a refute, the plan file on disk is
 * byte-identical and no plan-mutating event exists).
 *
 * mechanical_oracles_first, applied here: there is no deterministic
 * pass/fail oracle for "is this plan sound" the way there is for a schema or
 * a terminal task status, but evaluatePlanQuorumTriggers() below IS a
 * deterministic oracle over the plan's own data (three threshold checks) and
 * it runs first — zero fired triggers is a mechanical "nothing to
 * critique", never reaching a judge (step 1).
 *
 * §3 consequence of asymmetric_roles.finder_ne_critic (crosscheck.yml): the
 * plan-soundness claim is the planner's own (native, in-process — a plan is
 * always authored by the native planner, never an external provider), so
 * native is always the finder and always excluded from the gating pool.
 * With quorum_rule.min_providers: 2:
 *   - 0 enabled externals: computeQuorum() would escalate
 *     insufficient-providers on every triggered plan, since the gating pool
 *     is empty by construction. Calling runQuorumCase() at all in that case
 *     would be pure overhead for a foregone conclusion, so step 2 below
 *     short-circuits straight to `endorsed` — the same "shipped default costs nothing" rule as
 *     gate.ts's resolveCrosscheck() returning null and epic.ts's step 2;
 *     mandatory, not an optimisation. Skipping the judges is free; skipping
 *     the RECORD is not, so every path emits exactly one quorum-decision
 *     naming its endorser (P9-23) — the fired triggers ride on it.
 *   - exactly 1 active external: gating pool size 1 < 2 -> escalate
 *     insufficient-providers -> escalated, every time. Fail-closed: the
 *     operator sees why and turns on a second provider rather than the plan
 *     silently proceeding on one external model's word.
 *   - 2+ active externals: a real quorum vote decides it.
 *   - shadow-only externals: verdicts are recorded (judge-verdict events)
 *     for calibration, but shadow mode has zero gating power — the outcome
 *     is whatever it would have been with no externals at all (`endorsed`,
 *     shadow verdicts still surfaced via quorum.participants).
 * crosscheck.yml's plan_quorum.judges: "2 providers distinct from the
 * planner's" says exactly this.
 */

export interface PlanQuorumBudgetTrigger {
  kind: 'budget';
  totalTokens: number;
  capTokens: number;
  ratio: number;
}

export type SecurityMatchType = 'case' | 'agent_role' | 'nonfunctional_clause';

export interface PlanQuorumSecurityTrigger {
  kind: 'security';
  taskId: string;
  matchType: SecurityMatchType;
  matchedValue: string;
  matchedKeyword?: string;
}

export type LowConfidenceSource = 'task' | 'planner';

export interface PlanQuorumLowConfidenceTrigger {
  kind: 'low-confidence';
  source: LowConfidenceSource;
  taskId?: string;
  value: number;
  threshold: number;
}

export type PlanQuorumTrigger =
  | PlanQuorumBudgetTrigger
  | PlanQuorumSecurityTrigger
  | PlanQuorumLowConfidenceTrigger;

// Defensive field readers: TaskSpecRecord is Record<string, unknown>-ish
// (schema-validated elsewhere, not here), so every field read below narrows
// via typeof/Array.isArray before use — same precedent as cli.ts's
// `(t.claims as string[] | undefined) ?? []`, minus the unchecked cast.

function taskTokens(t: TaskSpecRecord): number {
  const budget = t.budget;
  if (typeof budget !== 'object' || budget === null) return 0;
  const tokens = (budget as Record<string, unknown>).tokens;
  return typeof tokens === 'number' ? tokens : 0;
}

function taskCase(t: TaskSpecRecord): string | undefined {
  return typeof t.case === 'string' ? t.case : undefined;
}

function taskAgentRole(t: TaskSpecRecord): string | undefined {
  return typeof t.agent_role === 'string' ? t.agent_role : undefined;
}

function taskNonfunctionalClauses(t: TaskSpecRecord): string[] {
  const contract = t.contract;
  if (typeof contract !== 'object' || contract === null) return [];
  const clauses = (contract as Record<string, unknown>).nonfunctional_clauses;
  return Array.isArray(clauses) ? clauses.filter((c): c is string => typeof c === 'string') : [];
}

function taskConfidence(t: TaskSpecRecord): number | undefined {
  return typeof t.confidence === 'number' ? t.confidence : undefined;
}

export interface PlanQuorumEvalOpts {
  /** The planner's own self-reported confidence in the plan as a whole, distinct from any per-task `confidence` field. */
  plannerConfidence?: number;
}

/**
 * Trigger 2 of three, on its own: which of the plan's live tasks are
 * security-sensitive, one entry per (task, match) pair — a task can fire on
 * its `case`, its `agent_role`, AND each matching `nonfunctional_clauses`
 * keyword hit, each reported separately so the operator sees exactly what
 * tripped it.
 *
 * Split out of `evaluatePlanQuorumTriggers` (which still calls it, unchanged)
 * because effort.ts asks the same question for a different reason: an epic
 * whose plan is security-sensitive may not run at a cheap effort tier, and
 * that floor has to be computed from the same list the quorum uses or the two
 * answers drift. Reusing the evaluation is the point; a second copy of the
 * keyword-matching rules would be a second policy.
 */
export function evaluatePlanSecurityTriggers(
  plan: PlanFile,
  policy: PlanQuorumPolicy,
): PlanQuorumSecurityTrigger[] {
  const triggers: PlanQuorumSecurityTrigger[] = [];
  const securityCases = new Set(policy.securityCases);
  const securityRoles = new Set(policy.securityRoles);

  for (const t of livePlanTasks(plan)) {
    const taskId = t.task_id;

    const caseValue = taskCase(t);
    if (caseValue !== undefined && securityCases.has(caseValue)) {
      triggers.push({ kind: 'security', taskId, matchType: 'case', matchedValue: caseValue });
    }

    const role = taskAgentRole(t);
    if (role !== undefined && securityRoles.has(role)) {
      triggers.push({ kind: 'security', taskId, matchType: 'agent_role', matchedValue: role });
    }

    for (const clause of taskNonfunctionalClauses(t)) {
      const lowerClause = clause.toLowerCase();
      const matchedKeyword = policy.securityKeywords.find((kw) =>
        lowerClause.includes(kw.toLowerCase()),
      );
      if (matchedKeyword !== undefined) {
        triggers.push({
          kind: 'security',
          taskId,
          matchType: 'nonfunctional_clause',
          matchedValue: clause,
          matchedKeyword,
        });
      }
    }
  }

  return triggers;
}

/**
 * Pure, no I/O: given a loaded plan, the plan_quorum policy, and the epic's
 * token cap, decide which of the three crosscheck.yml plan_quorum triggers
 * fire, each carrying the evidence an operator (or a judge prompt) needs to
 * evaluate it without re-deriving it from the plan.
 *
 * All three triggers read `livePlanTasks(plan)`, never `plan.tasks`. D-113,
 * carried as D-185: a plan version keeps each superseded copy of a task beside
 * the record that replaced it, under the same `task_id` (D-121), so the raw
 * field is a history and not the plan's ask. plan-v5.json on disk holds 13
 * records for 5 live tasks, and read raw it declares 1,110,000 tokens against
 * a real 410,000 and names four tasks security-sensitive three times each.
 * Both numbers are evidence a judge is asked to weigh, so both have to be the
 * plan's, not the amendment history's. Same rule, same reason, as D-126.
 */
export function evaluatePlanQuorumTriggers(
  plan: PlanFile,
  policy: PlanQuorumPolicy,
  epicCapTokens: number,
  opts: PlanQuorumEvalOpts = {},
): PlanQuorumTrigger[] {
  const triggers: PlanQuorumTrigger[] = [];
  const tasks = livePlanTasks(plan);

  // Trigger 1 — epic budget >= budget_ratio * epicCapTokens.
  const totalTokens = tasks.reduce((sum, t) => sum + taskTokens(t), 0);
  if (totalTokens >= policy.budgetRatio * epicCapTokens) {
    triggers.push({
      kind: 'budget',
      totalTokens,
      capTokens: epicCapTokens,
      ratio: policy.budgetRatio,
    });
  }

  // Trigger 2 — security-sensitive (extracted below: effort.ts asks the same
  // question on its own, to decide whether an epic may run at a cheap tier).
  triggers.push(...evaluatePlanSecurityTriggers(plan, policy));

  // Trigger 3 — low confidence: per task (task-spec.schema.json's
  // `confidence`, set only for origin: inferred tasks) and/or the planner's
  // own self-report for the plan as a whole.
  for (const t of tasks) {
    const confidence = taskConfidence(t);
    if (confidence !== undefined && confidence < policy.confidenceThreshold) {
      triggers.push({
        kind: 'low-confidence',
        source: 'task',
        taskId: t.task_id,
        value: confidence,
        threshold: policy.confidenceThreshold,
      });
    }
  }
  if (opts.plannerConfidence !== undefined && opts.plannerConfidence < policy.confidenceThreshold) {
    triggers.push({
      kind: 'low-confidence',
      source: 'planner',
      value: opts.plannerConfidence,
      threshold: policy.confidenceThreshold,
    });
  }

  return triggers;
}

/**
 * Pseudo task id for a plan-level (not task-level) event/judge-request —
 * distinct from any real task_id and from epic.ts's
 * `${epicId}/${RESERVED_TASK_ID}`. event.schema.json's `task_id` is an
 * unconstrained free-form string, so this is schema-safe; the shape is defined
 * in plan.ts (not here) because db/projector.ts's foldTasks() must recognise it
 * to keep a plan ref out of the tasks projection, and db/ must not import a
 * quorum host.
 */
function planPseudoTaskId(plan: PlanFile): string {
  return planRefTaskId(plan.epic_id, plan.version);
}

function describeTrigger(t: PlanQuorumTrigger): string {
  if (t.kind === 'budget') {
    return `budget: ${t.totalTokens} tokens >= ${t.ratio} * ${t.capTokens} cap`;
  }
  if (t.kind === 'security') {
    const keywordSuffix = t.matchedKeyword ? ` (keyword "${t.matchedKeyword}")` : '';
    return `security: task ${t.taskId} matched ${t.matchType} = "${t.matchedValue}"${keywordSuffix}`;
  }
  const taskSuffix = t.taskId ? ` task ${t.taskId}` : '';
  return `low-confidence: ${t.source}${taskSuffix} confidence ${t.value} < ${t.threshold}`;
}

/**
 * The reason this plan qualified for a quorum, for the event payload.
 *
 * The first trigger that fired, and `fired_triggers` lists the whole set in
 * the same order — so `trigger_reason` and `fired_triggers[0]` always name the
 * same trigger, and a reader can check that relation without a precedence
 * table. Null when nothing fired: a mechanical "nothing to critique" has no
 * reason to name, and this payload already spells honest-empty as null for
 * `decision` and `escalation_reason`.
 *
 * This was the constant `'low-confidence-plan'` on every path. The two plan
 * quorums on dogfood-mcp-1 each fired four security triggers and zero
 * confidence triggers — that run passed no confidence value at all — and both
 * events name low confidence anyway, with the contradicting `fired_triggers`
 * list sitting in the same payload (D-112).
 */
function planTriggerReason(triggers: readonly PlanQuorumTrigger[]): TriggerReason | null {
  const first = triggers[0];
  if (!first) return null;
  if (first.kind === 'budget') return 'budget-plan';
  if (first.kind === 'security') return 'security-plan';
  return 'low-confidence-plan';
}

/** A judge call is a network round-trip, not a test — same rationale and same numbers as gate.ts's/epic.ts's DEFAULT_JUDGE_BUDGET; not imported from either since planQuorum.ts must not depend on gate.ts/epic.ts (parallel quorum_triggers hosts, not a hierarchy). */
const DEFAULT_JUDGE_BUDGET: JudgeBudget = { timeout_ms: 120_000, max_output_bytes: 262_144 };

/**
 * Pure prompt builder, mirrors quorum.ts's findingJudgeRequest() and
 * epic.ts's epicVerdictJudgeRequest() style and trust boundary: the prompt
 * carries the CLAIM ONLY (epic id, plan version, task ids/objectives/
 * case/token budgets, edge count, fired triggers with their evidence) —
 * never file contents, never a diff. The tasks it lists are `livePlanTasks`,
 * not `plan.tasks`: this prompt is the whole of what the critic sees, so a
 * superseded record listed here is an objective the plan withdrew, offered to
 * a judge as the plan's current ask (D-185). Carries
 * asymmetric_roles.critic_mandate ("refute, not confirm"): the judge's
 * mandate is to REFUTE the plan's soundness; it critiques the plan, it does
 * not authorize any change to it.
 */
export function planQuorumJudgeRequest(
  plan: PlanFile,
  triggers: readonly PlanQuorumTrigger[],
  budget: JudgeBudget,
): JudgeRequest {
  const tasks = livePlanTasks(plan);
  const taskLines =
    tasks.length > 0
      ? tasks
          .map((t) => {
            const caseValue = taskCase(t) ?? '(no case)';
            const objective = typeof t.objective === 'string' ? t.objective : '(no objective)';
            return `  ${t.task_id} [${caseValue}, ${taskTokens(t)} tokens]: ${objective}`;
          })
          .join('\n')
      : '  (no tasks)';
  const triggerLines =
    triggers.length > 0 ? triggers.map((t) => `  - ${describeTrigger(t)}`).join('\n') : '  (none)';

  const prompt = [
    'You are an adversarial critic in an automated plan-quorum gate.',
    `Plan "${plan.epic_id}" v${plan.version} is claimed sound as scoped.`,
    'Your mandate is to REFUTE that claim: assume it is NOT sound until the',
    'evidence below forces you to agree. You are critiquing the plan, not',
    'authorizing any change to it — nothing you say rewrites the plan.',
    '',
    `Epic: ${plan.epic_id}`,
    `Plan version: ${plan.version}`,
    `Tasks: ${tasks.length}`,
    taskLines,
    '',
    `Dependency edges: ${plan.edges.length}`,
    '',
    `Fired triggers (${triggers.length}):`,
    triggerLines,
    '',
    'You are judging the claim as stated above; you do not have file contents',
    'or a diff for any task in this plan.',
    '',
    'Return only JSON matching judge-verdict.schema.json:',
    '{"verdict": "confirm" | "refute", "rationale": "<one or two sentences>"}',
    '"confirm" = the plan is genuinely sound as scoped. "refute" = it is not.',
  ].join('\n');

  return {
    kind: 'plan-critique',
    taskId: planPseudoTaskId(plan),
    inputRefs: { epic_id: plan.epic_id, plan_version: String(plan.version) },
    prompt,
    schemaName: 'judge-verdict',
    budget,
  };
}

/** Injection seam for the cross-provider quorum, mirrors gate.ts's GateCrosscheckOptions / epic.ts's EpicCrosscheckOptions. With none of these set, runPlanQuorum() reads factory/policies/crosscheck.yml itself. */
export interface PlanQuorumCrosscheckOptions {
  policy?: CrosscheckPolicy;
  budget?: JudgeBudget;
  fetchImpl?: typeof fetch;
}

export interface PlanQuorumInput {
  epicId: string;
  version: number;
  /** Planner's self-reported confidence for the plan as a whole (trigger 3's second arm). */
  plannerConfidence?: number;
  planOpts?: PlanOpts;
  /** Defaults to factory/policies/budgets.yml's epic.cap_tokens. */
  epicCapTokens?: number;
  crosscheck?: PlanQuorumCrosscheckOptions;
}

/**
 * Who endorsed the plan, on every path that endorses one (P9-23). Required,
 * never inferred from an absent field: "no external provider was enabled" and
 * "two providers voted confirm" are both `endorsed` with exit 0, and an
 * operator reading the log after the fact must be able to tell them apart.
 *   - `no-triggers`         — the mechanical oracle fired nothing (step 1).
 *   - `default-no-provider` — triggers fired, zero enabled externals to ask,
 *                             endorsed by the shipped default (step 2).
 *   - `quorum`              — a real cross-provider vote decided confirm.
 */
export type PlanQuorumEndorser = 'no-triggers' | 'default-no-provider' | 'quorum';

export type PlanQuorumOutcome =
  | {
      outcome: 'endorsed';
      epicId: string;
      version: number;
      triggers: PlanQuorumTrigger[];
      endorsedBy: PlanQuorumEndorser;
      quorum?: QuorumResult;
    }
  | {
      outcome: 'critiqued';
      epicId: string;
      version: number;
      triggers: PlanQuorumTrigger[];
      quorum: QuorumResult;
    }
  | {
      outcome: 'escalated';
      epicId: string;
      version: number;
      triggers: PlanQuorumTrigger[];
      reason: 'disagreement' | 'insufficient-providers';
      quorum: QuorumResult;
    };

/**
 * One key set for all three paths (P9-23). The short-circuit paths run no
 * quorum, so their gating fields are honestly empty — `outcome: 'not-run'`
 * rather than a missing key, because a consumer that has to distinguish
 * "absent" from "empty" ends up guessing, and the whole point of the record
 * is that nobody has to guess whether a check happened.
 */
function planQuorumDecisionPayload(args: {
  quorum?: QuorumResult;
  plan: PlanFile;
  finderProvider: string;
  triggers: readonly PlanQuorumTrigger[];
  sound: boolean;
  endorsedBy: PlanQuorumEndorser | null;
}): Record<string, unknown> {
  const { quorum, plan, finderProvider, triggers, sound, endorsedBy } = args;
  const gating = quorum?.gating;
  return {
    task_id: planPseudoTaskId(plan),
    epic_id: plan.epic_id,
    plan_version: plan.version,
    finding_id: null,
    trigger_reason: planTriggerReason(triggers),
    finder_provider: finderProvider,
    /** `not-run` is a first-class outcome here: no quorum was called at all. */
    outcome: gating?.outcome ?? 'not-run',
    decision: gating?.outcome === 'decided' ? gating.decision : null,
    agreement: gating?.outcome === 'decided' ? gating.agreement : null,
    gating_participants: gating?.outcome === 'decided' ? gating.participants : [],
    escalation_reason: gating?.outcome === 'escalate' ? gating.reason : null,
    rationales: gating?.outcome === 'escalate' ? gating.rationales : [],
    participants: (quorum?.participants ?? []).map((p) => ({
      provider: p.provider,
      mode: p.mode,
      ok: p.ok,
      verdict: p.verdict,
      excluded_as_finder: p.excludedAsFinder,
    })),
    native_verdict: 'confirm',
    fired_triggers: triggers.map(describeTrigger),
    /** Whether the plan is endorsed as sound after the quorum spoke — never "approved", this is critique-only. */
    sound,
    /** Non-null exactly when `sound` is true; null pairs with a critique or an escalation. */
    endorsed_by: endorsedBy,
  };
}

/** Emit the one quorum-decision this run is allowed (step 1, 2 or 5 — never two). */
async function emitPlanQuorumDecision(
  args: Parameters<typeof planQuorumDecisionPayload>[0],
  ctx: EventContext,
  opts: EventOpts,
): Promise<void> {
  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'quorum-decision',
      task_id: planPseudoTaskId(args.plan),
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: planQuorumDecisionPayload(args),
    },
    opts,
  );
}

/**
 * Operator-invoked critique for one plan version: mechanical trigger
 * evaluation first, then (only when triggered and it isn't free to skip) a
 * cross-provider quorum on the claim "this plan is sound as scoped". Never
 * mutates the plan file and never blocks anything itself — the caller (the
 * CLI) surfaces the outcome for a human; a non-`endorsed` exit means the
 * operator must look before approving the plan.
 */
export async function runPlanQuorum(
  input: PlanQuorumInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<PlanQuorumOutcome> {
  const plan = loadPlan(input.epicId, input.version, input.planOpts);
  const policy = input.crosscheck?.policy ?? loadCrosscheckPolicy();
  const epicCapTokens = input.epicCapTokens ?? loadBudgetPolicy().epic.capTokens;
  const triggers = evaluatePlanQuorumTriggers(plan, policy.planQuorum, epicCapTokens, {
    plannerConfidence: input.plannerConfidence,
  });

  const nativeProvider = nativeProviderName(policy);

  // Step 1 — mechanical_oracles_first: zero fired triggers is a mechanical
  // "nothing to critique". Zero judge calls — but not zero events (P9-23):
  // an endorsement nobody can find in the log is indistinguishable from a
  // check that never ran.
  if (triggers.length === 0) {
    await emitPlanQuorumDecision(
      { plan, finderProvider: nativeProvider, triggers, sound: true, endorsedBy: 'no-triggers' },
      ctx,
      opts,
    );
    return {
      outcome: 'endorsed',
      epicId: input.epicId,
      version: input.version,
      triggers,
      endorsedBy: 'no-triggers',
    };
  }

  const providers = enabledExternalProviders(policy);

  // Step 2 — zero-cost-by-default short-circuit, see module header §3. The
  // skip stays free (zero judge calls); the silence does not. This is the
  // only path the shipped crosscheck.yml can take, so it is precisely the
  // path whose record an operator will need six weeks later.
  if (providers.length === 0) {
    await emitPlanQuorumDecision(
      {
        plan,
        finderProvider: nativeProvider,
        triggers,
        sound: true,
        endorsedBy: 'default-no-provider',
      },
      ctx,
      opts,
    );
    return {
      outcome: 'endorsed',
      epicId: input.epicId,
      version: input.version,
      triggers,
      endorsedBy: 'default-no-provider',
    };
  }

  const budget = input.crosscheck?.budget ?? DEFAULT_JUDGE_BUDGET;
  const rationale = `${plan.epic_id} v${plan.version}: ${triggers.length} trigger(s) fired; native planner claims the plan is sound as scoped.`;

  // Step 3 — the claim is native's own (the planner's); finder_ne_critic
  // excludes it from gating (§3). Native's own report of the ACTUAL fired
  // triggers lives in the event payload (fired_triggers), not in this
  // "confirm" claim — the claim is always "sound", exactly as epic.ts's
  // native claim is always "ready".
  const quorum = await runQuorumCase(
    {
      taskId: planPseudoTaskId(plan),
      triggerReason: 'low-confidence-plan',
      finderProvider: nativeProvider,
      kind: 'plan-critique',
      native: { provider: nativeProvider, verdict: 'confirm', rationale },
      providers,
      request: planQuorumJudgeRequest(plan, triggers, budget),
      policy,
      quorumPolicy: { minProviders: policy.quorumRule.minProviders },
      fetchImpl: input.crosscheck?.fetchImpl,
    },
    ctx,
    opts,
  );

  // Step 4 — map the quorum's gating decision to endorsed/critiqued/
  // escalated. escalated only holds when an ACTIVE judge actually ran
  // (epic.ts's runEpicVerdict rule, reused verbatim): shadow-only/all-failed
  // participants have zero gating power by construction, so there's nothing
  // for an operator to arbitrate and the plan is endorsed exactly as it
  // would have been with 0 externals (shadow verdicts still surfaced via
  // quorum.participants for calibration, per on_disagreement's "surface both
  // rationales" applying equally to the active-disagreement case below).
  const gating = quorum.gating;
  let outcome: PlanQuorumOutcome;
  if (gating.outcome === 'decided') {
    outcome =
      gating.decision === 'confirm'
        ? {
            outcome: 'endorsed',
            epicId: input.epicId,
            version: input.version,
            triggers,
            endorsedBy: 'quorum',
            quorum,
          }
        : { outcome: 'critiqued', epicId: input.epicId, version: input.version, triggers, quorum };
  } else {
    const hadActiveJudge = quorum.participants.some(
      (p) => p.mode === 'active' && p.ok && !p.excludedAsFinder,
    );
    outcome = hadActiveJudge
      ? {
          outcome: 'escalated',
          epicId: input.epicId,
          version: input.version,
          triggers,
          reason: gating.reason,
          quorum,
        }
      : {
          outcome: 'endorsed',
          epicId: input.epicId,
          version: input.version,
          triggers,
          // Shadow-only/all-failed judges have zero gating power, so the
          // endorsement is still the shipped default's, not a vote's — the
          // participants list on the payload shows who ran anyway.
          endorsedBy: 'default-no-provider',
          quorum,
        };
  }

  // Step 5 — emit exactly once, for any case that actually ran a quorum.
  // Never a plan-mutating event: quorum-decision is not a type any plan-cut
  // path reads or reacts to (critique-only invariant, see module header).
  await emitPlanQuorumDecision(
    {
      quorum,
      plan,
      finderProvider: nativeProvider,
      triggers,
      sound: outcome.outcome === 'endorsed',
      endorsedBy: outcome.outcome === 'endorsed' ? outcome.endorsedBy : null,
    },
    ctx,
    opts,
  );

  return outcome;
}
