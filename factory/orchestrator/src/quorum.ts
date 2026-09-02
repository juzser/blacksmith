// Quorum engine (architecture §6 "Diversity quorum" + "Asymmetric roles,
// kill mandate"; factory/policies/crosscheck.yml `quorum_rule`/
// `asymmetric_roles`). Given the native (Claude) verdict plus zero or more
// external JudgeResults for one trigger case (crosscheck.yml
// `quorum_triggers`: a blocking S1/S2 finding, an epic-final verdict, a
// same-mistake finding, or a low-confidence planner verdict), decide
// whether the case is settled or must escalate to the operator with both
// rationales side by side.
//
// Shadow mode (Phase 8 design decision): until crosscheck.yml flips a
// provider's `mode` to `active`, its verdict is recorded for calibration
// analytics (providerAgreement() in db/queries.ts) but has ZERO gating
// power — computeQuorum() falls back to the native verdict alone whenever
// no ACTIVE external judge is present in the case, exactly the pre-Phase-8
// behavior. This is the mechanism that makes "flip crosscheck.yml" the
// entire promotion step (docs/runbooks/providers.md).

import { type CrosscheckPolicy, loadCrosscheckPolicy, providerModel } from './crosscheck.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts } from './events.js';
import type { EventContext } from './findings.js';
import { runJudge } from './providers/index.js';
import type { JudgeBudget, JudgeKind, JudgeRequest, JudgeResult } from './providers/types.js';

// No QuorumError: a provider blowing up is a recorded verdict of its own
// (see the catch below), not an exception that takes the quorum with it.
// SmithError is still imported -- it is what that catch reads a code from.

export type VerdictValue = 'confirm' | 'refute';

export interface ProviderVerdict {
  provider: string;
  verdict: VerdictValue;
  rationale: string;
}

/**
 * Why a quorum ran, as recorded on its `quorum-decision` event.
 *
 * The three `-plan` members are planQuorum.ts's three triggers. Only the
 * low-confidence one existed until D-112: the other two triggers could fire —
 * and on dogfood-mcp-1 were the ONLY ones that fired — with no name to be
 * recorded under, so the payload named low confidence regardless.
 */
export type TriggerReason =
  | 'blocking-finding'
  | 'epic-final-verdict'
  | 'same-mistake'
  | 'budget-plan'
  | 'security-plan'
  | 'low-confidence-plan';

export type ProviderRunMode = 'shadow' | 'active';

export type JudgeRunOutcome =
  | { ok: true; result: JudgeResult }
  | { ok: false; error: { code: string; message: string } };

export interface ExternalJudgeRun {
  provider: string;
  mode: ProviderRunMode;
  outcome: JudgeRunOutcome;
}

export interface QuorumCase {
  taskId: string;
  findingId?: string;
  triggerReason: TriggerReason;
  /** The provider whose claim is under judgment — asymmetric_roles: a critic sharing this provider is excluded from gating (crosscheck.yml `asymmetric_roles.finder_ne_critic`), native included. */
  finderProvider: string;
  /** Claude's own verdict — always present, always a participant. */
  native: ProviderVerdict;
  external: ExternalJudgeRun[];
}

export interface QuorumParticipant {
  provider: string;
  mode: 'native' | ProviderRunMode;
  ok: boolean;
  verdict: VerdictValue | null;
  rationale: string;
  excludedAsFinder: boolean;
}

export type QuorumDecision =
  | { outcome: 'decided'; decision: VerdictValue; agreement: string; participants: string[] }
  | {
      outcome: 'escalate';
      reason: 'disagreement' | 'insufficient-providers';
      rationales: ProviderVerdict[];
    };

export interface QuorumResult {
  case: { taskId: string; findingId?: string; triggerReason: TriggerReason };
  /** What actually governs the gate — see the shadow-mode header note. */
  gating: QuorumDecision;
  /** Every participant, shadow AND active, for calibration analytics — never itself the gating decision. */
  participants: QuorumParticipant[];
}

export interface QuorumPolicy {
  minProviders: number;
}

const DEFAULT_QUORUM_POLICY: QuorumPolicy = { minProviders: 2 };

/**
 * Bridge a raw JudgeResult into the binary confirm/refute quorum needs.
 * `kind: review` has no explicit verdict field (its contract is a findings
 * array, .claude/agents/reviewer.md) — presence of any finding IS the
 * claim being judged ("this task has a real blocking issue"), so a
 * non-empty array reads as `confirm`. `kind: verify`/`plan-critique` carry
 * an explicit judge-verdict.schema.json object instead.
 */
export function deriveVerdict(result: JudgeResult): ProviderVerdict {
  if (result.kind === 'review') {
    const findings = Array.isArray(result.output) ? result.output : [];
    return {
      provider: result.provider,
      verdict: findings.length > 0 ? 'confirm' : 'refute',
      rationale:
        findings.length > 0 ? `${findings.length} finding(s) raised.` : 'No findings raised.',
    };
  }
  const output = result.output as { verdict?: string; rationale?: string };
  const verdict: VerdictValue = output.verdict === 'confirm' ? 'confirm' : 'refute';
  return { provider: result.provider, verdict, rationale: output.rationale ?? '' };
}

function toRationales(participants: QuorumParticipant[]): ProviderVerdict[] {
  return participants
    .filter((p): p is QuorumParticipant & { verdict: VerdictValue } => p.ok && p.verdict !== null)
    .map(({ provider, verdict, rationale }) => ({ provider, verdict, rationale }));
}

/**
 * Pure decision function (table-driven testable): no I/O, no events. Applies
 * quorum_rule (majority-of-N, generalizing "2-of-3") over the gating pool —
 * native plus every ACTIVE, non-finder external participant. Shadow-mode
 * and finder-excluded participants are recorded in `participants` for
 * calibration but never enter the pool.
 */
export function computeQuorum(
  kase: QuorumCase,
  policy: QuorumPolicy = DEFAULT_QUORUM_POLICY,
): QuorumResult {
  const nativeParticipant: QuorumParticipant = {
    provider: kase.native.provider,
    mode: 'native',
    ok: true,
    verdict: kase.native.verdict,
    rationale: kase.native.rationale,
    excludedAsFinder: kase.native.provider === kase.finderProvider,
  };

  const externalParticipants: QuorumParticipant[] = kase.external.map((run) => {
    const excludedAsFinder = run.provider === kase.finderProvider;
    if (!run.outcome.ok) {
      return {
        provider: run.provider,
        mode: run.mode,
        ok: false,
        verdict: null,
        rationale: run.outcome.error.message,
        excludedAsFinder,
      };
    }
    const verdict = deriveVerdict(run.outcome.result);
    return {
      provider: run.provider,
      mode: run.mode,
      ok: true,
      verdict: verdict.verdict,
      rationale: verdict.rationale,
      excludedAsFinder,
    };
  });

  const participants = [nativeParticipant, ...externalParticipants];
  const caseSummary = {
    taskId: kase.taskId,
    findingId: kase.findingId,
    triggerReason: kase.triggerReason,
  };

  const activeExternal = externalParticipants.filter(
    (p) => p.mode === 'active' && p.ok && !p.excludedAsFinder,
  );

  // Shadow mode: no ACTIVE external participant in this case's pool yet —
  // gating stays exactly what it always was pre-Phase-8, the native verdict
  // alone (zero gating power for shadow-mode providers, per the header note).
  if (activeExternal.length === 0) {
    if (nativeParticipant.excludedAsFinder) {
      return {
        case: caseSummary,
        gating: { outcome: 'escalate', reason: 'insufficient-providers', rationales: [] },
        participants,
      };
    }
    return {
      case: caseSummary,
      gating: {
        outcome: 'decided',
        decision: nativeParticipant.verdict as VerdictValue,
        agreement: 'native-only',
        participants: [nativeParticipant.provider],
      },
      participants,
    };
  }

  const gatingPool = [
    ...(nativeParticipant.excludedAsFinder ? [] : [nativeParticipant]),
    ...activeExternal,
  ];

  if (gatingPool.length < policy.minProviders) {
    return {
      case: caseSummary,
      gating: {
        outcome: 'escalate',
        reason: 'insufficient-providers',
        rationales: toRationales(gatingPool),
      },
      participants,
    };
  }

  const confirmCount = gatingPool.filter((p) => p.verdict === 'confirm').length;
  const refuteCount = gatingPool.length - confirmCount;
  const majority = Math.floor(gatingPool.length / 2) + 1;

  if (confirmCount >= majority || refuteCount >= majority) {
    return {
      case: caseSummary,
      gating: {
        outcome: 'decided',
        decision: confirmCount >= majority ? 'confirm' : 'refute',
        agreement: `${Math.max(confirmCount, refuteCount)}-of-${gatingPool.length}`,
        participants: gatingPool.map((p) => p.provider),
      },
      participants,
    };
  }

  return {
    case: caseSummary,
    gating: { outcome: 'escalate', reason: 'disagreement', rationales: toRationales(gatingPool) },
    participants,
  };
}

// ---------------------------------------------------------------------------
// Event recording — "Emit events for every judge run" (architecture §7/§8).
// ---------------------------------------------------------------------------

const KIND_TO_AGENT: Record<JudgeKind, string> = {
  review: 'reviewer',
  verify: 'verifier',
  'plan-critique': 'spec-reviewer',
};

export interface RecordJudgeRunInput {
  taskId: string;
  findingId?: string;
  modelTier: string;
  /**
   * The concrete model this judge ran on (P9-23), from providerModel(). The
   * tier can't answer "did the critic run on the finder's model?" — two
   * different frontier models share one tier — so the dispatch record now
   * carries the id itself. Required, not optional: an omitted model reads as
   * compliance, which is the exact failure this field exists to prevent.
   */
  model: string;
  kind: JudgeKind;
  run: ExternalJudgeRun;
  native: ProviderVerdict;
}

/**
 * One judge run -> one `dispatch_decision` event (so it shows up in the same
 * analytics/timeline as any other agent dispatch, architecture §7) plus one
 * `judge-verdict` event chained off it, always emitted whether the run
 * succeeded or failed (the failure rates providerAgreement() reports need
 * the failures on the log too — a call that throws before any event exists
 * would make them unobservable).
 *
 * A failed run carries `error_code` as well as the message (D-253). The two
 * are not interchangeable: the message is prose written for a human reading
 * one row, the code is the field every count is grouped by, and
 * judgeFailureKind() reads it to say whether the provider answered badly or
 * never answered at all.
 */
export async function recordJudgeRun(
  input: RecordJudgeRunInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<{ dispatchEventId: string; verdictEventId: string }> {
  const agentRole = KIND_TO_AGENT[input.kind];

  const dispatch = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'dispatch_decision',
      task_id: input.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        agent_role: agentRole,
        provider: input.run.provider,
        model_tier: input.modelTier,
        model: input.model,
        reason: `cross-provider judge (${input.run.mode})`,
      },
    },
    opts,
  );

  const ok = input.run.outcome.ok;
  const verdict = ok ? deriveVerdict(input.run.outcome.result) : null;
  // A failed run produced no verdict, so there is nothing for the native one to
  // agree or disagree with. `false` there would be a placeholder wearing an
  // observation's clothes -- and a reader grouping by it counts a provider that
  // never answered as one that dissented. `null` is how the record says the
  // question has no answer, the same choice `latency_ms` below already makes
  // (D-168). Rows written before this carry `false` permanently; providerAgreement()
  // gates on `schema_failure` first for exactly that reason.
  const agreementWithNative = ok ? verdict?.verdict === input.native.verdict : null;

  const verdictEvent = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'judge-verdict',
      task_id: input.taskId,
      plan_version: ctx.planVersion,
      causal_parent: dispatch.event_id,
      payload: {
        task_id: input.taskId,
        finding_id: input.findingId ?? null,
        agent: agentRole,
        provider: input.run.provider,
        model_tier: input.modelTier,
        model: input.model,
        kind: input.kind,
        mode: input.run.mode,
        ok,
        verdict: ok ? verdict?.verdict : null,
        rationale: ok
          ? (verdict?.rationale ?? '')
          : (input.run.outcome as { ok: false; error: { message: string } }).error.message,
        native_verdict: input.native.verdict,
        agreement_with_native: agreementWithNative,
        schema_failure: !ok,
        // `schema_failure` stays what it has always been -- "this run reached
        // no verdict" -- because a decade of rows and ten-odd readers already
        // spell it that way. What it cannot do is say *why*, and it was being
        // read as though it could: runQuorumCase()'s catch had the code in
        // hand and dropped it here, so eight straight deepseek runs killed by
        // an unset DEEPSEEK_API_KEY were reported as unparseable answers from
        // a provider that had not been sent a single request (D-253).
        error_code: ok
          ? null
          : (input.run.outcome as { ok: false; error: { code: string } }).error.code,
        latency_ms: ok ? input.run.outcome.result.latency_ms : null,
      },
    },
    opts,
  );

  return { dispatchEventId: dispatch.event_id, verdictEventId: verdictEvent.event_id };
}

// ---------------------------------------------------------------------------
// End-to-end orchestration — invoke every configured provider, record every
// run, then decide. The CLI's `judge run` command (manual calibration) calls
// providers/index.ts's runJudge() directly instead; this is the path a real
// quorum_triggers case takes.
// ---------------------------------------------------------------------------

export interface RunQuorumCaseInput {
  taskId: string;
  findingId?: string;
  triggerReason: TriggerReason;
  finderProvider: string;
  kind: JudgeKind;
  native: ProviderVerdict;
  /** Provider names to invoke (crosscheck.yml `enabled: false` providers are skipped, never invoked at all). */
  providers: string[];
  request: JudgeRequest;
  policy?: CrosscheckPolicy;
  quorumPolicy?: QuorumPolicy;
  fetchImpl?: typeof fetch;
}

/**
 * Every non-native provider crosscheck.yml has switched on. `enabled: false`
 * means never invoked at all regardless of `mode`, so an all-disabled policy
 * (the shipped default) returns [] and callers can skip the case entirely —
 * no judge call, no events, no spend.
 */
export function enabledExternalProviders(policy: CrosscheckPolicy): string[] {
  return Object.values(policy.providers)
    .filter((p) => p.kind !== 'native' && p.enabled)
    .map((p) => p.name);
}

/** The provider running the factory itself (crosscheck.yml `kind: native`). */
export function nativeProviderName(policy: CrosscheckPolicy): string {
  return Object.values(policy.providers).find((p) => p.kind === 'native')?.name ?? 'claude';
}

/** The subset of finding.schema.json a critic needs. Structural on purpose: the provider layer never sees a factory-internal type (types.ts trust-boundary note). */
export interface FindingUnderJudgment {
  task_id: string;
  finding_id: string;
  fingerprint: string;
  finding_category: string;
  severity: string;
  summary: string;
  failure_scenario: { inputs: string; expected: string; actual: string };
}

/**
 * Assemble the `verify` JudgeRequest for one finding, carrying
 * crosscheck.yml's `asymmetric_roles.critic_mandate` ("refute, not confirm")
 * into the prompt — the critic's job is to kill the finding, not to agree
 * with it.
 *
 * Deliberate limitation: the prompt carries the CLAIM (summary + failure
 * scenario + file path), never the file's contents or the diff. Shipping
 * worktree source to a third-party API is an operator decision this call
 * has no mandate to make, so a critic judges whether the claimed failure
 * scenario is internally coherent and plausible, not whether the code
 * really does that. Documented in docs/runbooks/providers.md §2.
 */
export function findingJudgeRequest(
  finding: FindingUnderJudgment,
  filePath: string,
  budget: JudgeBudget,
): JudgeRequest {
  const prompt = [
    'You are an adversarial critic in an automated code-review gate.',
    'Another reviewer raised the finding below and it is about to block a task.',
    'Your mandate is to REFUTE it: assume it is wrong until the stated failure',
    'scenario forces you to agree. Confirm only if the described failure would',
    'genuinely occur as written.',
    '',
    `Task: ${finding.task_id}`,
    `File: ${filePath}`,
    `Category: ${finding.finding_category}`,
    `Severity: ${finding.severity}`,
    `Summary: ${finding.summary}`,
    '',
    'Claimed failure scenario:',
    `  inputs:   ${finding.failure_scenario.inputs}`,
    `  expected: ${finding.failure_scenario.expected}`,
    `  actual:   ${finding.failure_scenario.actual}`,
    '',
    'You are judging the claim as stated; you do not have the file contents.',
    'A claim that is vague, self-contradictory, or that would not actually',
    'produce the stated `actual` is a refute.',
    '',
    'Return only JSON matching judge-verdict.schema.json:',
    '{"verdict": "confirm" | "refute", "rationale": "<one or two sentences>"}',
    '"confirm" = the finding is real and should block. "refute" = it should not.',
  ].join('\n');

  return {
    kind: 'verify',
    taskId: finding.task_id,
    inputRefs: { finding_id: finding.finding_id, fingerprint: finding.fingerprint, file: filePath },
    prompt,
    schemaName: 'judge-verdict',
    budget,
  };
}

export async function runQuorumCase(
  input: RunQuorumCaseInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<QuorumResult> {
  const policy = input.policy ?? loadCrosscheckPolicy();
  const external: ExternalJudgeRun[] = [];

  for (const providerName of input.providers) {
    const config = policy.providers[providerName];
    if (!config || config.kind === 'native' || !config.enabled) continue;

    let outcome: JudgeRunOutcome;
    try {
      const result = await runJudge(providerName, input.request, {
        policy,
        fetchImpl: input.fetchImpl,
      });
      outcome = { ok: true, result };
    } catch (err) {
      outcome = {
        ok: false,
        error: {
          code: err instanceof SmithError ? err.code : 'provider.unknown-error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const run: ExternalJudgeRun = { provider: providerName, mode: config.mode, outcome };
    external.push(run);
    await recordJudgeRun(
      {
        taskId: input.taskId,
        findingId: input.findingId,
        modelTier: config.modelTier,
        model: providerModel(config),
        kind: input.kind,
        run,
        native: input.native,
      },
      ctx,
      opts,
    );
  }

  return computeQuorum(
    {
      taskId: input.taskId,
      findingId: input.findingId,
      triggerReason: input.triggerReason,
      finderProvider: input.finderProvider,
      native: input.native,
      external,
    },
    input.quorumPolicy,
  );
}
