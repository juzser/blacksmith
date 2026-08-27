import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import {
  type EventContext,
  type Finding,
  type FindingEvidence,
  listFindings,
  mintFindings,
  raiseFinding,
  transition,
} from './findings.js';
import {
  diffPlans,
  draftNextVersion,
  latestPlanVersion,
  livePlanTasks,
  type PlanChanges,
  type PlanDiff,
  type PlanFile,
  type PlanOpts,
  validatePlan,
} from './plan.js';
import { type CompiledSchemaSet, compileSchemas, validateRecord } from './schemas.js';
import { amendPlan } from './spec.js';
import { loadTaxonomy, type Taxonomy } from './taxonomy.js';

/**
 * The worker half of a living spec.
 *
 * D-33 gave the operator a legitimate way out of a spec defect: `amendPlan`
 * cuts a new plan version against the spec-scoped finding that forced it, and
 * every version stays immutable and on the event log. It left two gaps on the
 * other side of the wall.
 *
 * The first is who may say it. Only a judge dispatched with `spec: {planVersion}`
 * can mint a spec-scoped finding, so a coder that reads a criterion, builds
 * against it and discovers halfway through that it assumes something untrue
 * has no way to say so. Its choices were to build the wrong thing or to fail
 * the task, and the dogfood log has both.
 *
 * The second is who writes the fix. `plan amend` requires the operator to
 * hand-author the `--changes` JSON — the content of the amendment, which the
 * worker that hit the wall knows and the operator does not. "Approve quickly"
 * is not possible while approving means writing the diff yourself.
 *
 * This module is the bridge, and its shape is forced rather than chosen. A
 * worker cannot emit an event — only the node that dispatched it can — so the
 * worker's signal is a field returned in `structured_output`, exactly like
 * `research_request` and for the same reason: a returned field is the only
 * shape that survives the worker dying mid-flight, which is precisely what
 * discovering a wrong assumption tends to produce.
 *
 * What the dispatcher records is a PROPOSAL. It is data, not a command:
 * nothing here writes a plan file, and the only path to a new version is still
 * `amendPlan`, with every guard it already has. What approval removes is the
 * typing, not the checking.
 */
export class SpecChangeError extends SmithError {}

/** A worker returned a spec diff. Recorded; nothing has moved. */
export const SPEC_CHANGE_PROPOSED_EVENT = 'spec-change-proposed';
/** An operator answered one. Approval is what calls `plan amend`. */
export const SPEC_CHANGE_DECIDED_EVENT = 'spec-change-decided';

/**
 * The severity a proposal carries when the worker states none. S2 rather than
 * S3 because the floor matters: `raiseFinding` only consults the waiver list
 * for `S3-minor`/`S4-nit` (D-196), so a default inside that band would let a
 * standing waiver silently swallow the anchor an amendment has to cite.
 */
const DEFAULT_SEVERITY = 'S2-major';

/**
 * Fixed, not taken from the worker. Every proposal makes the same claim — the
 * criterion does not describe the system it is about — and that claim is a
 * correctness one regardless of which subsystem exposed it.
 */
const PROPOSAL_CATEGORY = 'correctness';

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

/** Same lazy pair every module that validates a record keeps, for the same
 *  reason: compiling the schema set is not free and the set never changes
 *  inside a process. `opts` still wins, so a test can hand in its own. */
function loadCachedTaxonomy(): Taxonomy {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  return cachedTaxonomy;
}

function resolveSchemas(opts: PlanOpts): CompiledSchemaSet {
  if (opts.schemas !== undefined) return opts.schemas;
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(loadCachedTaxonomy());
  return cachedSchemas;
}

/** Mirrors factory/specs/schema/spec-change-request.schema.json. */
export interface SpecChangeRequest {
  criterion_ref: string;
  assumption: string;
  evidence: string;
  changes: PlanChanges;
  sites: readonly string[];
  blocking: boolean;
  severity?: string;
}

export interface ProposeSpecChangeInput {
  /** The plan version the worker was dispatched against. */
  plan: PlanFile;
  /** The worker's own task — the one that hit the wall. */
  taskId: string;
  proposedBy: string;
  proposedByProvider?: string;
  request: SpecChangeRequest;
}

/**
 * `stale` is never written to the log. It is computed at read time from the
 * plan versions that exist on disk, the same way `specReviewBlockers` decides
 * a review has been outrun (D-125/D-126) — a status baked into an event would
 * be a fact about the past asserted about the present.
 */
export type SpecChangeStatus = 'open' | 'approved' | 'rejected' | 'stale';

export interface SpecChangeDecision {
  decision: 'approved' | 'rejected';
  decidedBy: string;
  rationale: string;
  /** The version approval cut, or null for a rejection. */
  planVersion: number | null;
  ts: string;
}

export interface SpecChangeProposal {
  /**
   * The `spec-change-proposed` event's own id. A proposal is not a thing that
   * exists apart from the event that recorded it, so it mints no id of its
   * own — the same rule `SpecReviewRecord.eventId` follows.
   */
  proposalId: string;
  epicId: string;
  taskId: string;
  baseVersion: number;
  proposedBy: string;
  proposedByProvider?: string;
  /** The spec-scoped finding an approval will cite. Without it, unapprovable. */
  findingId: string;
  criterionRef: string;
  assumption: string;
  evidence: string;
  sites: string[];
  changes: PlanChanges;
  /** Computed at proposal time, so the queue shows what would happen. */
  diff: PlanDiff;
  blocking: boolean;
  severity: string;
  status: SpecChangeStatus;
  decision: SpecChangeDecision | null;
  ts: string;
}

export interface SpecChangeFilter {
  epicId?: string;
  taskId?: string;
  status?: SpecChangeStatus;
}

export interface ApproveSpecChangeInput {
  proposalId: string;
  /**
   * The plan to amend, supplied by the caller exactly as `plan amend` takes
   * it. Not loaded from disk: the operator is the one who knows which file is
   * the live plan, and a fixture with no file on disk is a legitimate caller.
   */
  plan: PlanFile;
  decidedBy: string;
  /** Optional. Absent, the worker's own recorded argument becomes the reason. */
  rationale?: string;
}

export interface ApproveSpecChangeResult {
  proposal: SpecChangeProposal;
  plan: PlanFile;
  diff: PlanDiff;
  sitesUnclaimed: readonly string[];
}

export interface RejectSpecChangeInput {
  proposalId: string;
  decidedBy: string;
  /** Required. A rejection is the half a worker has to act on. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/**
 * Record a worker's spec diff as a proposal.
 *
 * Everything validates before anything acts. A proposal reaches an operator's
 * queue only if it could actually be applied — the draft is built and run
 * through the plan's own validator here rather than at approval, so an
 * unappliable diff is refused while the worker that wrote it is still the one
 * being told, not hours later when an operator tries to say yes.
 *
 * It writes no plan file. The version is cut by `plan amend` alone.
 */
export async function proposeSpecChange(
  input: ProposeSpecChangeInput,
  ctx: EventContext,
  opts: PlanOpts & EventOpts = {},
): Promise<SpecChangeProposal> {
  const { plan, taskId, proposedBy, request } = input;
  const epicId = plan.epic_id;

  // The shape check first, and against the published schema rather than a
  // second reading of it here. `request` arrives from a worker's
  // `structured_output`, which is to say from a model: it is the least
  // trustworthy input this module takes, and the field the guards below never
  // reach on their own is `severity`, whose taxonomy membership the schema's
  // `x-taxonomy` pointer resolves. Without this the first thing to notice an
  // invented severity would be the finding schema, several steps later, and
  // it would name the finding rather than the request that malformed it.
  const shape = validateRecord(
    resolveSchemas(opts),
    opts.taxonomy ?? loadCachedTaxonomy(),
    'spec-change-request',
    request,
  );
  if (!shape.valid) {
    throw new SpecChangeError(
      'spec-change.proposal-malformed',
      `Refusing a spec change proposal from ${proposedBy} on "${taskId}": the request does not match the spec-change-request schema. ${shape.errors.map((e) => `${e.path}: ${e.message}`).join(' ')}`,
      { taskId, proposedBy, errors: shape.errors },
    );
  }

  const criterionRef = request.criterion_ref?.trim() ?? '';
  if (criterionRef === '') {
    throw new SpecChangeError(
      'spec-change.proposal-without-criterion',
      `Refusing a spec change proposal from ${proposedBy} on "${taskId}": it names no criterion_ref. "The plan is wrong" has to say which clause — the same rule mintFindings enforces on spec-review evidence.`,
      { taskId, proposedBy },
    );
  }

  const assumption = request.assumption?.trim() ?? '';
  const evidence = request.evidence?.trim() ?? '';
  if (assumption === '' || evidence === '') {
    throw new SpecChangeError(
      'spec-change.proposal-without-argument',
      `Refusing a spec change proposal against ${criterionRef}: it states ${assumption === '' ? 'no assumption' : 'no evidence'}. The operator is being asked to overturn a criterion, and the assumption plus what contradicts it is the whole of what they have to go on.`,
      { taskId, criterionRef, hasAssumption: assumption !== '', hasEvidence: evidence !== '' },
    );
  }

  // D-123, asked at the one point in the pipeline where the answer is known.
  // The worker has just read the code the wrong assumption's shape occurs in;
  // the operator has not, and `plan amend` will demand this list from whoever
  // is standing there at approval time.
  const sites = [...new Set((request.sites ?? []).map((site) => site.trim()))].filter(
    (site) => site !== '',
  );
  if (sites.length === 0) {
    throw new SpecChangeError(
      'spec-change.proposal-without-sites',
      `Refusing a spec change proposal against ${criterionRef}: it names no sites. Every place the wrong assumption's shape occurs, not only where you hit it — you are better placed to enumerate them now than an operator is later.`,
      { taskId, criterionRef },
    );
  }

  // The same check `amendPlan` runs on its own draft (D-21), one step earlier.
  // Plans are immutable and nothing deletes one, so the cost of finding this
  // out after the write is unrecoverable; the cost of finding it out here is a
  // refusal the worker can still answer.
  const draft = draftNextVersion(plan, request.changes ?? {});
  const validation = validatePlan(draft, opts);
  if (!validation.valid) {
    throw new SpecChangeError(
      'spec-change.proposal-invalid-draft',
      `Refusing a spec change proposal against ${criterionRef}: v${draft.version} would fail its own validation, so it could never be approved. ${validation.errors.map((e) => `${e.path}: ${e.message}`).join(' ')}`,
      { taskId, criterionRef, errors: validation.errors },
    );
  }

  const diff = diffPlans(plan, draft);
  // Mirrors `amendPlan`'s obligation rule: added tasks, plus superseded ones
  // that are still live in the draft. A proposal that obligates nothing would
  // be approved into a finding that discharges the instant it is parked — an
  // amendment nobody has to build, which is another way of saying no
  // amendment at all.
  const live = new Set(livePlanTasks(draft).map((t) => t.task_id));
  const obligations = [
    ...new Set([...diff.added, ...diff.superseded.filter((id) => live.has(id))]),
  ];
  if (obligations.length === 0) {
    throw new SpecChangeError(
      'spec-change.proposal-without-obligation',
      `Refusing a spec change proposal against ${criterionRef}: the diff adds no task and supersedes no live one, so approving it would obligate nobody to build anything. Say which task's spec changes.`,
      { taskId, criterionRef, diff },
    );
  }

  const severity = request.severity ?? DEFAULT_SEVERITY;
  const summary = proposalSummary(criterionRef, assumption);
  const item: FindingEvidence = {
    file_path: sites[0] as string,
    finding_category: PROPOSAL_CATEGORY,
    severity,
    summary,
    failure_scenario: {
      inputs: `${taskId} built against ${criterionRef}`,
      expected: assumption,
      actual: evidence,
    },
    criterion_ref: criterionRef,
  };

  const drafts = mintFindings(
    [item],
    {
      taskId,
      foundBy: proposedBy,
      ...(input.proposedByProvider === undefined
        ? {}
        : { foundByProvider: input.proposedByProvider }),
      // What makes this finding spec-scoped, and so routable out of the task
      // gate to `amendPlan` instead of back to a coder with nothing to change.
      spec: { planVersion: plan.version },
    },
    opts,
  );
  const minted = drafts[0];
  if (minted === undefined) throw new Error('unreachable: one evidence item mints one draft');

  const raised = await raiseFinding(minted, ctx, opts);
  if (raised.suppressed) {
    // `recordSpecReview` skips a suppressed raise, and is right to: a
    // suppressed review finding is one the operator has already answered.
    // Here the finding is not a record of the proposal — it is the anchor
    // `amendPlan` cites, and a proposal without one can never be approved.
    // Failing loudly beats queueing something permanently unapprovable.
    throw new SpecChangeError(
      'spec-change.proposal-suppressed',
      `Refusing a spec change proposal against ${criterionRef}: a standing waiver on fingerprint ${raised.fingerprint} suppressed the finding an approval would have to cite, so the proposal could never be applied. Deny the waiver, or raise the proposal's severity above the waivable band.`,
      { taskId, criterionRef, fingerprint: raised.fingerprint, severity },
    );
  }

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: SPEC_CHANGE_PROPOSED_EVENT,
      task_id: taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        base_version: plan.version,
        proposed_by: proposedBy,
        ...(input.proposedByProvider === undefined
          ? {}
          : { proposed_by_provider: input.proposedByProvider }),
        finding_id: raised.finding.finding_id,
        criterion_ref: criterionRef,
        assumption,
        evidence,
        sites,
        changes: request.changes ?? {},
        diff,
        blocking: request.blocking === true,
        severity,
      },
    },
    opts,
  );

  return {
    proposalId: stored.event_id,
    epicId,
    taskId,
    baseVersion: plan.version,
    proposedBy,
    ...(input.proposedByProvider === undefined
      ? {}
      : { proposedByProvider: input.proposedByProvider }),
    findingId: raised.finding.finding_id,
    criterionRef,
    assumption,
    evidence,
    sites,
    changes: request.changes ?? {},
    diff,
    blocking: request.blocking === true,
    severity,
    status: 'open',
    decision: null,
    ts: stored.record.ts,
  };
}

/**
 * The finding's summary, and so — through `computeFingerprint` — the identity
 * two proposals against the same wrong assumption share. Built from the
 * criterion and the assumption rather than the evidence, so a second worker
 * that hits the same wall from a different file dedups onto the first.
 */
function proposalSummary(criterionRef: string, assumption: string): string {
  return `${criterionRef} rests on a wrong assumption: ${assumption}`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fold the log into proposals. Pure, and deliberately unable to say `stale`:
 * staleness is a fact about the plan files that exist right now, and a fold
 * that quietly read the disk would make a re-fold of an old log disagree with
 * the log.
 */
export function foldSpecChanges(
  events: readonly StoredEvent[],
  filter: SpecChangeFilter = {},
): SpecChangeProposal[] {
  const byId = new Map<string, SpecChangeProposal>();

  for (const stored of events) {
    const { record } = stored;
    if (record.event_type === SPEC_CHANGE_PROPOSED_EVENT) {
      const payload = record.payload as {
        epic_id?: string;
        base_version?: number;
        proposed_by?: string;
        proposed_by_provider?: string;
        finding_id?: string;
        criterion_ref?: string;
        assumption?: string;
        evidence?: string;
        sites?: string[];
        changes?: PlanChanges;
        diff?: PlanDiff;
        blocking?: boolean;
        severity?: string;
      };
      byId.set(stored.event_id, {
        proposalId: stored.event_id,
        epicId: payload.epic_id ?? '',
        taskId: record.task_id ?? '',
        baseVersion: payload.base_version ?? 0,
        proposedBy: payload.proposed_by ?? 'unknown',
        ...(payload.proposed_by_provider === undefined
          ? {}
          : { proposedByProvider: payload.proposed_by_provider }),
        findingId: payload.finding_id ?? '',
        criterionRef: payload.criterion_ref ?? '',
        assumption: payload.assumption ?? '',
        evidence: payload.evidence ?? '',
        sites: [...(payload.sites ?? [])],
        changes: payload.changes ?? {},
        diff: payload.diff ?? { added: [], removed: [], superseded: [], carried: [] },
        blocking: payload.blocking === true,
        severity: payload.severity ?? DEFAULT_SEVERITY,
        status: 'open',
        decision: null,
        ts: record.ts,
      });
      continue;
    }

    if (record.event_type === SPEC_CHANGE_DECIDED_EVENT) {
      const payload = record.payload as {
        proposal_id?: string;
        decision?: 'approved' | 'rejected';
        decided_by?: string;
        rationale?: string;
        plan_version?: number | null;
      };
      const target = payload.proposal_id ? byId.get(payload.proposal_id) : undefined;
      // A decision naming no proposal this fold has seen is dropped rather
      // than invented: the proposal is the record, and half a record read back
      // as a whole one is worse than a gap.
      if (target === undefined) continue;
      const decision = payload.decision === 'rejected' ? 'rejected' : 'approved';
      target.status = decision;
      target.decision = {
        decision,
        decidedBy: payload.decided_by ?? 'unknown',
        rationale: payload.rationale ?? '',
        planVersion: payload.plan_version ?? null,
        ts: record.ts,
      };
    }
  }

  return [...byId.values()].filter(
    (p) =>
      (filter.epicId === undefined || p.epicId === filter.epicId) &&
      (filter.taskId === undefined || p.taskId === filter.taskId) &&
      (filter.status === undefined || p.status === filter.status),
  );
}

/**
 * Has the plan moved out from under this proposal? The diff was computed
 * against `baseVersion`; if a later version exists, nobody has checked that it
 * still applies, and `writePlanFile` would refuse the collision anyway with a
 * message about version numbers rather than about the proposal.
 *
 * A missing plan directory casts no vote (D-126) — `latestPlanVersion` returns
 * null, and a proposal held against a plan not yet on disk stays open.
 */
export function isStale(proposal: SpecChangeProposal, opts: PlanOpts = {}): boolean {
  const latest = latestPlanVersion(proposal.epicId, opts);
  return latest !== null && latest > proposal.baseVersion;
}

/**
 * The operator's queue: the fold, with staleness applied, then filtered.
 *
 * The status filter runs last on purpose. Asking for `open` should not return
 * a proposal the plan has already outrun, and asking for `stale` should return
 * exactly those — neither is answerable before the disk has been consulted.
 */
export async function listSpecChanges(
  sessionId: string,
  filter: SpecChangeFilter = {},
  opts: PlanOpts & EventOpts = {},
): Promise<SpecChangeProposal[]> {
  const events = await readLineageEvents(sessionId, opts);
  const { status, ...rest } = filter;
  const folded = foldSpecChanges(events, rest);
  const marked = folded.map((proposal) =>
    proposal.status === 'open' && isStale(proposal, opts)
      ? { ...proposal, status: 'stale' as const }
      : proposal,
  );
  return status === undefined ? marked : marked.filter((p) => p.status === status);
}

async function requireProposal(
  proposalId: string,
  opts: PlanOpts & EventOpts,
  ctx: EventContext,
): Promise<SpecChangeProposal> {
  const listed = await listSpecChanges(ctx.sessionId, {}, opts);
  const found = listed.find((p) => p.proposalId === proposalId);
  if (found === undefined) {
    throw new SpecChangeError(
      'spec-change.unknown-proposal',
      `No spec change proposal "${proposalId}" on this session's lineage. \`smith plan proposals\` lists what is there.`,
      { proposalId, sessionId: ctx.sessionId },
    );
  }
  return found;
}

function refuseIfDecided(proposal: SpecChangeProposal): void {
  if (proposal.decision !== null) {
    throw new SpecChangeError(
      'spec-change.already-decided',
      `Spec change proposal ${proposal.proposalId} was already ${proposal.decision.decision} by ${proposal.decision.decidedBy}. A decision is a fact on the log, not a draft — re-propose against the current plan version instead.`,
      { proposalId: proposal.proposalId, decision: proposal.decision.decision },
    );
  }
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/**
 * Approve a proposal: cut the version the worker asked for.
 *
 * This adds no power. It delegates to `amendPlan`, which still demands a
 * spec-scoped finding, a non-blank rationale, a site list, a draft that
 * validates and a diff that obligates somebody — every one of those is
 * satisfied from the proposal rather than relaxed. What the operator no longer
 * has to do is type them.
 */
export async function approveSpecChange(
  input: ApproveSpecChangeInput,
  ctx: EventContext,
  opts: PlanOpts & EventOpts = {},
): Promise<ApproveSpecChangeResult> {
  const proposal = await requireProposal(input.proposalId, opts, ctx);
  refuseIfDecided(proposal);

  if (input.plan.epic_id !== proposal.epicId) {
    throw new SpecChangeError(
      'spec-change.approval-wrong-epic',
      `Spec change proposal ${proposal.proposalId} is against epic "${proposal.epicId}", but the plan supplied is "${input.plan.epic_id}". Amending the wrong epic from the right proposal is the one mistake this guard exists to make impossible.`,
      { proposalId: proposal.proposalId, expected: proposal.epicId, given: input.plan.epic_id },
    );
  }

  // Fail closed on both axes of staleness, the same pair `specReviewBlockers`
  // reads (D-125/D-126): the version the proposal was drafted against, and the
  // versions that exist now. Without this the fallback is `writePlanFile`'s
  // `plan.version-exists` — a correct refusal carrying a message about file
  // names, at the point where the operator wanted to hear about their diff.
  const latest = latestPlanVersion(proposal.epicId, opts);
  const overtaken = latest !== null && latest > proposal.baseVersion;
  if (input.plan.version !== proposal.baseVersion || overtaken) {
    const current = overtaken ? latest : input.plan.version;
    throw new SpecChangeError(
      'spec-change.approval-stale',
      `Spec change proposal ${proposal.proposalId} was drafted against "${proposal.epicId}" v${proposal.baseVersion}, and the plan has since moved to v${current}. Its diff has not been checked against the newer version — re-propose against v${current} rather than applying it blind.`,
      {
        proposalId: proposal.proposalId,
        baseVersion: proposal.baseVersion,
        planVersion: input.plan.version,
        latestVersion: latest,
      },
    );
  }

  // The point of the whole exercise. `amendPlan` refuses a blank rationale,
  // and rightly — the diff records what moved and only the rationale records
  // why. Approval stays one command by REUSING the worker's own recorded
  // argument, not by relaxing that guard and not by inventing a sentence: the
  // reason on the log is the reason the change was made.
  const rationale =
    input.rationale?.trim() !== undefined && input.rationale.trim() !== ''
      ? input.rationale.trim()
      : defaultRationale(proposal);

  const amendment = await amendPlan(
    {
      plan: input.plan,
      findingIds: [proposal.findingId],
      rationale,
      sites: proposal.sites,
      changes: proposal.changes,
    },
    ctx,
    opts,
  );

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: SPEC_CHANGE_DECIDED_EVENT,
      task_id: proposal.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        proposal_id: proposal.proposalId,
        epic_id: proposal.epicId,
        decision: 'approved',
        decided_by: input.decidedBy,
        rationale,
        plan_version: amendment.plan.version,
      },
    },
    opts,
  );

  return {
    proposal: {
      ...proposal,
      status: 'approved',
      decision: {
        decision: 'approved',
        decidedBy: input.decidedBy,
        rationale,
        planVersion: amendment.plan.version,
        ts: stored.record.ts,
      },
    },
    plan: amendment.plan,
    diff: amendment.diff,
    sitesUnclaimed: amendment.sitesUnclaimed,
  };
}

/**
 * The worker's argument, replayed as the amendment's reason.
 *
 * Nothing here is the machine's opinion: every clause is a field the worker
 * wrote. That is what makes it safe to use unattended — an operator who wants
 * to say something else passes `--rationale` and this is never reached.
 */
function defaultRationale(proposal: SpecChangeProposal): string {
  return `Approved ${proposal.proposalId}: ${proposal.proposedBy} on ${proposal.taskId} found that ${proposal.criterionRef} assumes "${proposal.assumption}", contradicted by ${proposal.evidence}.`;
}

/**
 * Reject a proposal: the criterion stands.
 *
 * This refutes the finding, which is the strong reading and the reason the
 * rationale is mandatory — the worker is being sent back to build against the
 * criterion it just argued was wrong, and "no" without a reason is an
 * instruction it cannot act on.
 *
 * There is a third answer this deliberately does not cover. An operator who
 * agrees the criterion is wrong but dislikes the proposed shape does not
 * reject: they run `plan amend` citing the same still-`raised` finding with
 * their own `--changes`. That path needs no code here, and rejection stays
 * unambiguous because of it.
 */
export async function rejectSpecChange(
  input: RejectSpecChangeInput,
  ctx: EventContext,
  opts: PlanOpts & EventOpts = {},
): Promise<SpecChangeProposal> {
  const proposal = await requireProposal(input.proposalId, opts, ctx);
  refuseIfDecided(proposal);

  const rationale = input.rationale?.trim() ?? '';
  if (rationale === '') {
    throw new SpecChangeError(
      'spec-change.rejection-without-rationale',
      `Refusing to reject spec change proposal ${proposal.proposalId} without a rationale. The worker is being sent back to build against ${proposal.criterionRef} after arguing it is wrong; "no" on its own is not something it can act on.`,
      { proposalId: proposal.proposalId, criterionRef: proposal.criterionRef },
    );
  }

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: SPEC_CHANGE_DECIDED_EVENT,
      task_id: proposal.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        proposal_id: proposal.proposalId,
        epic_id: proposal.epicId,
        decision: 'rejected',
        decided_by: input.decidedBy,
        rationale,
        plan_version: null,
      },
    },
    opts,
  );

  await refuteAnchor(proposal, ctx, opts);

  return {
    ...proposal,
    status: 'rejected',
    decision: {
      decision: 'rejected',
      decidedBy: input.decidedBy,
      rationale,
      planVersion: null,
      ts: stored.record.ts,
    },
  };
}

/**
 * Close the finding the proposal raised. Best-effort by design: a finding an
 * operator has already waived or expired by hand is a decision that outranks
 * this one, and a rejection that threw over it would leave the decision on the
 * log with no way to record the same answer twice.
 */
async function refuteAnchor(
  proposal: SpecChangeProposal,
  ctx: EventContext,
  opts: EventOpts,
): Promise<void> {
  const findings = await listFindings(ctx.sessionId, {}, opts);
  const anchor: Finding | undefined = findings.find((f) => f.finding_id === proposal.findingId);
  if (anchor === undefined || anchor.finding_status !== 'raised') return;
  // The reason rides on `spec-change-decided`, where a reader looking for why
  // the proposal died will actually be standing. Repeating it on the
  // transition would be a second copy free to drift from the first.
  await transition(proposal.findingId, 'refuted', ctx, opts);
}
