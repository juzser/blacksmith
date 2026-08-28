// Independent finder (factory/policies/crosscheck.yml `independent_finder`).
//
// quorum.ts is subtractive by construction: its vocabulary is
// `confirm | refute`, a critic is handed one claim and told to kill it, and
// the strongest thing a quorum can do is drop a finding the native reviewer
// already raised. A bug the native reviewer's context never surfaced is
// therefore a bug no amount of cross-checking reaches -- nothing outside that
// context is ever asked to look.
//
// This module is the other direction. A finder from a different vendor reads
// the same diff in a fresh context and returns its own evidence; reconcile()
// matches the two lists and says, per finding, whether the two sides agree. A
// quorum can now RAISE: a corroborated finding takes the worse of the two
// severities under `severity_resolution: highest-wins`, and an
// independent-only finding is minted into the gate.
//
// Three rules the reconciliation keeps, each written out on the policy block
// itself and enforced here:
//
//   1. Silence never subtracts. A native finding the finder did not raise is
//      `native-only` with effect `none`. The finder was asked to read a diff,
//      not to answer that claim, so its silence is absence of evidence.
//   2. Same file and category with different wording is `co-located`, never
//      merged and never auto-raised: nothing here can tell one bug described
//      twice from two bugs in one function.
//   3. An independent-only finding is minted, not privileged. It enters the
//      gate as an ordinary finding and, at S1/S2, meets the same
//      `quorum_triggers` critic as any other.
//
// Shadow is honoured the way quorum.ts honours it, and twice: every entry is
// computed and recorded, and `applied` is false unless BOTH the block's own
// `mode` and the mode of the provider that raised it are `active`. Recording
// a reconciliation costs a judge call that has already happened; acting on
// one is a gate change, and shadow means no gate changes.

import {
  type CrosscheckPolicy,
  type IndependentFinder,
  loadCrosscheckPolicy,
  providerModel,
  type SeverityResolution,
} from './crosscheck.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts } from './events.js';
import {
  computeFingerprint,
  type EventContext,
  type FindingEvidence,
  mintFindings,
  normalizeFilePath,
  type RaiseFindingInput,
} from './findings.js';
import { runJudge } from './providers/index.js';
import type { JudgeBudget, JudgeRequest } from './providers/types.js';
import {
  type ExternalJudgeRun,
  type JudgeRunOutcome,
  nativeProviderName,
  type ProviderRunMode,
  type ProviderVerdict,
  recordJudgeRun,
} from './quorum.js';
import { worseSeverity } from './severity.js';

export class CrossFindingError extends SmithError {}

/** The event one reconciliation writes. A free-string event_type, like every other (event.schema.json). */
export const CROSS_FINDING_EVENT_TYPE = 'cross-finding-reconciled';

/** taxonomy.yml `agent` role an independent finder's evidence is attributed to: it is a reviewer, run by someone else. */
const FINDER_AGENT_ROLE = 'reviewer';

// ---------------------------------------------------------------------------
// Reconciliation -- pure. No I/O, no events, no minting.
// ---------------------------------------------------------------------------

export type ReconcileOutcome =
  /** Same fingerprint both sides: same file, same category, same normalized summary. */
  | 'corroborated'
  /** Same file and category, different wording. Recorded for the operator; never merged. */
  | 'co-located'
  /** Only the independent finder raised it. The additive case. */
  | 'independent-only'
  /** Only the native reviewer raised it. Never subtracts -- rule 1. */
  | 'native-only';

export type ReconcileEffect = 'none' | 'raise-severity' | 'raise-finding';

/**
 * The subset of a stored `Finding` a reconciliation reads. Structural and
 * snake_case so a record straight out of listFindings() passes through
 * untouched -- a hand-written adapter would be one more place for `severity`
 * and `finding_category` to end up paired with the wrong file.
 */
export interface NativeFindingRecord {
  finding_id: string;
  fingerprint: string;
  /**
   * Optional exactly as `Finding.file_path` is: records raised before P9-15
   * carry none. Such a record can still be corroborated -- the fingerprint is
   * a digest of the path it was raised on -- but can never be co-located,
   * because co-location needs the path itself.
   */
  file_path?: string;
  finding_category: string;
  severity: string;
  summary: string;
}

/** One provider's return from one finder dispatch. */
export interface IndependentRun {
  provider: string;
  /** The provider's own crosscheck.yml `mode`. A shadow provider's evidence is recorded and acted on by nothing. */
  mode: ProviderRunMode;
  evidence: readonly FindingEvidence[];
}

export interface ReconcileInput {
  taskId: string;
  native: readonly NativeFindingRecord[];
  independent: readonly IndependentRun[];
  policy: IndependentFinder;
}

export interface ReconcileEntry {
  outcome: ReconcileOutcome;
  fingerprint: string;
  /** Normalized, or null for a pre-P9-15 native record that carries no path. */
  file_path: string | null;
  finding_category: string;
  summary: string;
  native_finding_id: string | null;
  native_severity: string | null;
  /** Worst severity any independent provider gave this fingerprint; null when only the native side raised it. */
  independent_severity: string | null;
  /** Every independent provider that raised this fingerprint. Empty for `native-only`. */
  providers: string[];
  /** The subset of `providers` running in `mode: active` -- the only ones whose evidence may move a gate. */
  gating_providers: string[];
  effect: ReconcileEffect;
  /** What a `raise-severity` resolves the finding to. Null for every other effect. */
  resolved_severity: string | null;
  /** False when the effect was computed but not acted on: shadow mode, or an effect no active provider backs. */
  applied: boolean;
  /**
   * Ids of the native findings this one is co-located with. Empty for every
   * other outcome. Ids, not fingerprints, so one report speaks one identifier
   * language: `native_finding_id` above names a finding the same way.
   */
  counterparts: string[];
}

export interface SeverityRaise {
  fingerprint: string;
  from: string;
  to: string;
}

/** One independent-only finding, paired with the provider that takes the `found_by_provider` credit. */
export interface MintableFinding {
  provider: string;
  evidence: FindingEvidence;
}

export interface ReconcileReport {
  task_id: string;
  /** The `independent_finder.mode` this ran under -- not any one provider's. */
  mode: ProviderRunMode;
  severity_resolution: SeverityResolution;
  /** True iff at least one entry is `applied`: this reconciliation changes something. */
  gates: boolean;
  counts: Record<ReconcileOutcome, number>;
  entries: ReconcileEntry[];
  /** Applied severity raises. Feeds gate.ts through SeverityContext.corroboratedSeverity. */
  severity_raises: SeverityRaise[];
  /** Applied independent-only findings, ready for mintFindings(). Empty in shadow mode. */
  mintable: MintableFinding[];
}

const EMPTY_COUNTS: Readonly<Record<ReconcileOutcome, number>> = Object.freeze({
  corroborated: 0,
  'co-located': 0,
  'independent-only': 0,
  'native-only': 0,
});

/**
 * The co-location key: normalized path plus category, as a two-element JSON
 * array rather than a joined string. Both halves are prose from a third-party
 * provider, and any separator character we picked could appear inside a
 * category -- letting one finding collide with another's location. JSON
 * escaping makes the two fields unmergeable.
 */
function coLocationKey(filePath: string, category: string): string {
  return JSON.stringify([normalizeFilePath(filePath), category]);
}

interface IndependentGroup {
  fingerprint: string;
  filePath: string;
  category: string;
  summary: string;
  severity: string;
  providers: string[];
  gatingProviders: string[];
  /** Whoever raised it first, in policy provider order -- the one credited if it is minted. */
  first: MintableFinding;
}

/**
 * Group one dispatch's evidence by fingerprint, so two providers raising the
 * same bug is ONE entry naming both, not two entries racing each other into
 * the gate.
 *
 * Severity across a group is the worst offered, regardless of
 * `severity_resolution`: that setting arbitrates between the native side and
 * the independent one, and has nothing to say about two independent providers
 * who read the same code and disagreed. Taking the milder of two readings
 * there is how an S1 quietly becomes an S3.
 */
function groupIndependent(runs: readonly IndependentRun[]): IndependentGroup[] {
  const groups = new Map<string, IndependentGroup>();
  for (const run of runs) {
    for (const evidence of run.evidence) {
      const fingerprint = computeFingerprint({
        filePath: evidence.file_path,
        category: evidence.finding_category,
        summary: evidence.summary,
      });
      const existing = groups.get(fingerprint);
      if (existing) {
        if (!existing.providers.includes(run.provider)) existing.providers.push(run.provider);
        if (run.mode === 'active' && !existing.gatingProviders.includes(run.provider)) {
          existing.gatingProviders.push(run.provider);
        }
        existing.severity = worseSeverity(existing.severity, evidence.severity);
        continue;
      }
      groups.set(fingerprint, {
        fingerprint,
        filePath: normalizeFilePath(evidence.file_path),
        category: evidence.finding_category,
        summary: evidence.summary,
        severity: evidence.severity,
        providers: [run.provider],
        gatingProviders: run.mode === 'active' ? [run.provider] : [],
        first: { provider: run.provider, evidence },
      });
    }
  }
  return [...groups.values()];
}

/**
 * Match the native reviewer's findings against an independent finder's and say
 * what each match does. Pure: every effect it names is a recommendation until
 * runIndependentFinder() writes it down and a caller acts on it.
 *
 * Accounting is linear, not quadratic: one entry per independent fingerprint,
 * plus one per native finding nothing matched. A native finding named as a
 * co-located counterpart is accounted for by that entry and does not also
 * appear as `native-only` -- otherwise one finding would be reported twice,
 * under two outcomes that mean different things.
 */
export function reconcile(input: ReconcileInput): ReconcileReport {
  const nativeByFingerprint = new Map<string, NativeFindingRecord>();
  const nativeByLocation = new Map<string, NativeFindingRecord[]>();
  for (const finding of input.native) {
    if (!nativeByFingerprint.has(finding.fingerprint)) {
      nativeByFingerprint.set(finding.fingerprint, finding);
    }
    if (finding.file_path === undefined) continue;
    const key = coLocationKey(finding.file_path, finding.finding_category);
    const bucket = nativeByLocation.get(key);
    if (bucket) bucket.push(finding);
    else nativeByLocation.set(key, [finding]);
  }

  const blockActive = input.policy.mode === 'active';
  const entries: ReconcileEntry[] = [];
  const mintable: MintableFinding[] = [];
  const accounted = new Set<string>();

  for (const group of groupIndependent(input.independent)) {
    const gating = blockActive && group.gatingProviders.length > 0;
    const native = nativeByFingerprint.get(group.fingerprint);

    if (native) {
      accounted.add(native.fingerprint);
      const resolved =
        input.policy.severityResolution === 'highest-wins'
          ? worseSeverity(native.severity, group.severity)
          : native.severity;
      const raises = resolved !== native.severity;
      entries.push({
        outcome: 'corroborated',
        fingerprint: group.fingerprint,
        file_path: group.filePath,
        finding_category: group.category,
        // The native wording, because the native finding is the record that
        // exists; the independent side corroborates it, it does not restate it.
        summary: native.summary,
        native_finding_id: native.finding_id,
        native_severity: native.severity,
        independent_severity: group.severity,
        providers: group.providers,
        gating_providers: group.gatingProviders,
        effect: raises ? 'raise-severity' : 'none',
        resolved_severity: raises ? resolved : null,
        applied: raises && gating,
        counterparts: [],
      });
      continue;
    }

    const coLocated = nativeByLocation.get(coLocationKey(group.filePath, group.category)) ?? [];
    if (coLocated.length > 0) {
      for (const finding of coLocated) accounted.add(finding.fingerprint);
      entries.push({
        outcome: 'co-located',
        fingerprint: group.fingerprint,
        file_path: group.filePath,
        finding_category: group.category,
        summary: group.summary,
        // No single native counterpart is named: co-location is a location
        // match, and picking one of several would read as an identification.
        // `counterparts` below carries all of them.
        native_finding_id: null,
        native_severity: null,
        independent_severity: group.severity,
        providers: group.providers,
        gating_providers: group.gatingProviders,
        effect: 'none',
        resolved_severity: null,
        applied: false,
        counterparts: coLocated.map((f) => f.finding_id),
      });
      continue;
    }

    entries.push({
      outcome: 'independent-only',
      fingerprint: group.fingerprint,
      file_path: group.filePath,
      finding_category: group.category,
      summary: group.summary,
      native_finding_id: null,
      native_severity: null,
      independent_severity: group.severity,
      providers: group.providers,
      gating_providers: group.gatingProviders,
      effect: 'raise-finding',
      resolved_severity: null,
      applied: gating,
      counterparts: [],
    });
    if (gating) mintable.push(group.first);
  }

  for (const finding of input.native) {
    if (accounted.has(finding.fingerprint)) continue;
    accounted.add(finding.fingerprint);
    entries.push({
      outcome: 'native-only',
      fingerprint: finding.fingerprint,
      file_path: finding.file_path === undefined ? null : normalizeFilePath(finding.file_path),
      finding_category: finding.finding_category,
      summary: finding.summary,
      native_finding_id: finding.finding_id,
      native_severity: finding.severity,
      independent_severity: null,
      providers: [],
      gating_providers: [],
      // Rule 1. The finder was never asked about this claim.
      effect: 'none',
      resolved_severity: null,
      applied: false,
      counterparts: [],
    });
  }

  const counts = { ...EMPTY_COUNTS };
  for (const entry of entries) counts[entry.outcome] += 1;

  const severityRaises: SeverityRaise[] = [];
  for (const entry of entries) {
    if (!entry.applied || entry.effect !== 'raise-severity') continue;
    if (entry.native_severity === null || entry.resolved_severity === null) continue;
    severityRaises.push({
      fingerprint: entry.fingerprint,
      from: entry.native_severity,
      to: entry.resolved_severity,
    });
  }

  return {
    task_id: input.taskId,
    mode: input.policy.mode,
    severity_resolution: input.policy.severityResolution,
    gates: entries.some((e) => e.applied),
    counts,
    entries,
    severity_raises: severityRaises,
    mintable,
  };
}

// ---------------------------------------------------------------------------
// The judge call.
// ---------------------------------------------------------------------------

export interface IndependentFinderRequestInput {
  taskId: string;
  /** The unified diff, whole. Never truncated here -- see the max_diff_bytes refusal below. */
  diff: string;
  /** What the diff is of (e.g. `smith/<epic>/integration...<branch>`). Provenance for the event; no transport dereferences it. */
  diffRef: string;
  /** The task's acceptance criteria, verbatim. Omitted rather than invented when the caller has no plan in hand. */
  criteria?: readonly string[];
  budget: JudgeBudget;
  policy: IndependentFinder;
}

/**
 * Assemble the `review` JudgeRequest an independent finder answers.
 *
 * quorum.ts's findingJudgeRequest() deliberately carries the CLAIM and never
 * the source. This one has nothing to send but the source: a finder with no
 * diff has nothing to read, and a "find bugs in task X" prompt with no code
 * produces confident findings about code that does not exist. So the diff IS
 * the request, and every way of not having one is a refusal:
 *
 *   - `send_diff: false` (the shipped default) is the operator's standing
 *     answer to "may worktree source leave this machine". No code in this repo
 *     has standing to answer that quietly.
 *   - an empty diff is refused rather than sent, per the paragraph above.
 *   - a diff over `max_diff_bytes` is refused rather than truncated. A finder
 *     cannot tell half a diff from a whole one, and reports what it was not
 *     shown as absent rather than as unread.
 */
export function independentFinderRequest(input: IndependentFinderRequestInput): JudgeRequest {
  if (!input.policy.sendDiff) {
    throw new CrossFindingError(
      'crossfind.diff-not-authorized',
      'crosscheck.yml independent_finder.send_diff is false, so worktree source may not be sent to an external provider. There is no diffless fallback: a finder with no code invents findings. Set send_diff: true to authorize it.',
      { taskId: input.taskId },
    );
  }
  if (input.diff.trim().length === 0) {
    throw new CrossFindingError(
      'crossfind.empty-diff',
      `Task "${input.taskId}" has an empty diff (${input.diffRef}). A finder prompted with no code returns findings about code it imagined.`,
      { taskId: input.taskId, diffRef: input.diffRef },
    );
  }
  const bytes = Buffer.byteLength(input.diff, 'utf8');
  if (bytes > input.policy.maxDiffBytes) {
    throw new CrossFindingError(
      'crossfind.diff-too-large',
      `Task "${input.taskId}" has a ${bytes}-byte diff, over independent_finder.max_diff_bytes (${input.policy.maxDiffBytes}). Refused rather than truncated: half a diff produces confident findings about code that is not there.`,
      { taskId: input.taskId, bytes, maxDiffBytes: input.policy.maxDiffBytes },
    );
  }

  const prompt = [
    'You are an independent code reviewer in an automated review gate.',
    'Another reviewer has already read this diff. You have not been shown its',
    'findings and you will not be: your value here is the fresh context, so',
    'anything you do not raise is a bug nobody else is going to catch.',
    '',
    'Your mandate is to FIND. Report only defects you can state as a concrete',
    'failure -- given these inputs, this is expected, this happens instead. A',
    'finding you cannot write a failure scenario for is not a finding, and a',
    'style preference is not a defect.',
    '',
    `Task: ${input.taskId}`,
    `Diff: ${input.diffRef}`,
    ...(input.criteria && input.criteria.length > 0
      ? ['', 'Acceptance criteria this task is held to:', ...input.criteria.map((c) => `  - ${c}`)]
      : []),
    '',
    'Diff under review:',
    '```diff',
    input.diff,
    '```',
    '',
    'Return ONLY a JSON array matching finding-evidence.schema.json. One element',
    'per finding:',
    '[{"file_path": "<repo-relative path>", "finding_category": "<taxonomy value>",',
    '  "severity": "<taxonomy value>", "summary": "<one sentence>",',
    '  "failure_scenario": {"inputs": "...", "expected": "...", "actual": "..."}}]',
    '',
    'Return [] if you find nothing. An empty array is a real answer; an invented',
    'finding is not. Do not return finding_id, task_id, fingerprint,',
    'finding_status or found_by -- those are not yours to assign, and an answer',
    'carrying them is rejected unread.',
  ].join('\n');

  return {
    kind: 'review',
    taskId: input.taskId,
    inputRefs: { diff_ref: input.diffRef, diff_bytes: String(bytes) },
    prompt,
    schemaName: 'finding-evidence',
    budget: input.budget,
  };
}

export interface RunIndependentFinderInput {
  taskId: string;
  /** From independentFinderRequest(), built separately so a caller can inspect exactly what is about to be sent. */
  request: JudgeRequest;
  /** The native reviewer's findings for this task, as stored. */
  native: readonly NativeFindingRecord[];
  policy?: CrosscheckPolicy;
  fetchImpl?: typeof fetch;
}

export interface IndependentFinderResult {
  report: ReconcileReport;
  runs: ExternalJudgeRun[];
  /** Ready for raiseFinding(), one per applied independent-only finding. Empty in shadow mode. */
  raise: RaiseFindingInput[];
  reconciledEventId: string;
}

/**
 * Invoke every provider `independent_finder.providers` names, record each run
 * the way quorum.ts records a judge run (one `dispatch_decision` plus one
 * chained `judge-verdict`, so a finder appears in `smith stats providers`
 * alongside every other judge), reconcile what came back against the native
 * findings, and write one `cross-finding-reconciled` event.
 *
 * Minting stops at `raise`: this returns the drafts and never calls
 * raiseFinding(). Which findings actually enter a gate is the caller's
 * decision, and a function that both judges and admits leaves no seam for an
 * operator to stand in.
 *
 * Every way of running nothing throws rather than returning an empty report.
 * "No provider ran" and "the finder found nothing" serialize to nearly the
 * same JSON and mean opposite things, and the first one reads as a clean bill
 * of health.
 */
export async function runIndependentFinder(
  input: RunIndependentFinderInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<IndependentFinderResult> {
  const policy = input.policy ?? loadCrosscheckPolicy();
  const finder = policy.independentFinder;

  if (!finder.enabled) {
    throw new CrossFindingError(
      'crossfind.disabled',
      'crosscheck.yml independent_finder.enabled is false, so no finder ran. That is not the same answer as "no findings".',
      { taskId: input.taskId },
    );
  }

  // Before the native check, because "names nobody" is not a wrong name -- and
  // before the loop, because an empty list reaches the bottom of it having
  // skipped no one, where the "named them, none are enabled" sentence renders
  // with a hole where the operator's own words belong. Two mistakes, two
  // repairs: add a name here, or enable one over in `providers:`.
  if (finder.providers.length === 0) {
    throw new CrossFindingError(
      'crossfind.no-providers',
      "crosscheck.yml independent_finder.enabled is true but independent_finder.providers is empty, so there was nobody to ask and no finder ran. Name at least one external provider from this file's `providers:` map. There is no default: which vendors this box can reach is something only the operator knows.",
      { taskId: input.taskId },
    );
  }

  const nativeName = nativeProviderName(policy);
  if (finder.providers.includes(nativeName)) {
    throw new CrossFindingError(
      'crossfind.native-finder',
      `crosscheck.yml independent_finder.providers names "${nativeName}", the provider running the factory itself. A second opinion from the same model is one opinion billed twice.`,
      { provider: nativeName },
    );
  }

  // What the native side is on record as saying about this diff AT ALL --
  // "there are bugs here" or "there are none". recordJudgeRun() compares each
  // provider's derived verdict against it to fill `agreement_with_native`, and
  // for a finder that is the only honest reading of agreement: both sides
  // answered the same question, neither answered one about the other's claim.
  // `findingId` stays unset for the same reason -- a finder judges no single
  // finding.
  const nativeVerdict: ProviderVerdict = {
    provider: nativeName,
    verdict: input.native.length > 0 ? 'confirm' : 'refute',
    rationale:
      input.native.length > 0
        ? `${input.native.length} native finding(s) raised.`
        : 'No native findings raised.',
  };

  const runs: ExternalJudgeRun[] = [];
  const independent: IndependentRun[] = [];
  const skipped: string[] = [];

  for (const providerName of finder.providers) {
    const config = policy.providers[providerName];
    if (!config || config.kind === 'native' || !config.enabled) {
      skipped.push(providerName);
      continue;
    }

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
    runs.push(run);
    if (outcome.ok) {
      // Already validated element-wise against finding-evidence.schema.json by
      // the transport (providers/schema-validate.ts), taxonomy values and all,
      // so a non-canonical severity arrives here as a failed run rather than as
      // evidence mintFindings() would have to reject a second time. The
      // Array.isArray guard is for the type, not the contract.
      const output = outcome.result.output;
      independent.push({
        provider: providerName,
        mode: config.mode,
        evidence: (Array.isArray(output) ? output : []) as readonly FindingEvidence[],
      });
    }

    await recordJudgeRun(
      {
        taskId: input.taskId,
        modelTier: config.modelTier,
        model: providerModel(config),
        kind: 'review',
        run,
        native: nativeVerdict,
      },
      ctx,
      opts,
    );
  }

  if (runs.length === 0) {
    throw new CrossFindingError(
      'crossfind.no-providers',
      `independent_finder.providers names ${finder.providers.map((p) => `"${p}"`).join(', ')}, and crosscheck.yml enables none of them as an external provider. No finder ran.`,
      { taskId: input.taskId, skipped },
    );
  }

  const report = reconcile({
    taskId: input.taskId,
    native: input.native,
    independent,
    policy: finder,
  });

  // Grouped by provider because `found_by_provider` is one field on one
  // finding: a batch minted under the wrong name credits a vendor for evidence
  // it never produced, and provider calibration reads that field.
  const raise: RaiseFindingInput[] = [];
  const byProvider = new Map<string, FindingEvidence[]>();
  for (const item of report.mintable) {
    const bucket = byProvider.get(item.provider);
    if (bucket) bucket.push(item.evidence);
    else byProvider.set(item.provider, [item.evidence]);
  }
  for (const [provider, evidence] of byProvider) {
    raise.push(
      ...mintFindings(
        evidence,
        { taskId: input.taskId, foundBy: FINDER_AGENT_ROLE, foundByProvider: provider },
        opts,
      ),
    );
  }

  const reconciled = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: CROSS_FINDING_EVENT_TYPE,
      task_id: input.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        task_id: input.taskId,
        mode: report.mode,
        severity_resolution: report.severity_resolution,
        gates: report.gates,
        counts: report.counts,
        providers: runs.map((r) => r.provider),
        // Both recorded, and separately: a provider crosscheck.yml never
        // enabled and one that was dispatched and failed are the same absence
        // in the entries and different facts about the run.
        skipped_providers: skipped,
        failed_providers: runs.filter((r) => !r.outcome.ok).map((r) => r.provider),
        entries: report.entries,
        severity_raises: report.severity_raises,
        // Drafted, not raised: these ids exist only if the caller admits them.
        mintable_finding_ids: raise.map((r) => r.finding.finding_id),
      },
    },
    opts,
  );

  return { report, runs, raise, reconciledEventId: reconciled.event_id };
}
