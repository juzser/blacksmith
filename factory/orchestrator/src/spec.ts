import { claimCoversPath } from './claims.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import {
  // The status an amendment can actually put a finding into. Not `amended`:
  // since D-127 that is reachable only once the amendment's task ids land, so
  // a guard here that asked about the terminal status would be asking about a
  // transition this module never attempts.
  AMEND_PENDING_STATUS,
  type EventContext,
  type Finding,
  type FindingEvidence,
  findingScope,
  LEGAL_TRANSITIONS,
  listFindings,
  mintFindings,
  raiseFinding,
  SPEC_FINDING_SCOPE,
  transition,
} from './findings.js';
import {
  diffPlans,
  draftNextVersion,
  livePlanTasks,
  nextVersion,
  type PlanChanges,
  type PlanDiff,
  type PlanFile,
  type PlanOpts,
  planRefTaskId,
  validatePlan,
} from './plan.js';
import { RESERVED_TASK_ID } from './worktree.js';

/**
 * P9-9/D-33. Every judge in this factory returns findings against a diff, and
 * every finding against a diff blocks the diff. That is right until the judge
 * is reading the plan rather than the code: "the criterion is wrong" recorded
 * as a builder defect blocks a task whose diff cannot legally contain the fix,
 * because the fix is a new plan version and plans are immutable. The dogfood
 * epic deadlocked there — a wave-3 spec defect, correctly found, recorded as a
 * coder failure, bounced back to a coder who had nothing to change.
 *
 * This module is the other route. A spec-scoped finding (findings.ts's
 * `finding_scope`) leaves the task gate untouched and arrives here, where the
 * only legitimate way to change an immutable plan lives: `amendPlan` cuts a
 * new version, records which criterion moved and why, and puts the finding on
 * the amendment path at `amend-pending` — the one exit an S1/S2 spec finding
 * has, since severity.yml makes it categorically unwaivable. It opens that
 * exit; the tasks the new version added or superseded are what walk through
 * it (D-127).
 *
 * The second half is `recordSpecReview`: the closing spec-reviewer dispatch,
 * run at epic close against composite behaviour, when the code the spec
 * describes finally exists. A spec review before the code is written cannot
 * see the wave-3 defect; only this one can, and epic.ts's verdict now refuses
 * to certify an epic that never ran it.
 *
 * Dependency direction is one-way on purpose: epic.ts imports from here, never
 * the reverse, so the fold that decides readiness stays downstream of the
 * facts it folds.
 */
export class SpecError extends SmithError {}

export const SPEC_REVIEW_EVENT = 'spec-review-recorded';

/**
 * The graph event the taxonomy has declared since Phase 2 and nothing has ever
 * written (P9-12's shape, in the one place a producer is genuinely owed).
 * `nextVersion()` writes the plan file; this module is what makes the cut a
 * recorded decision rather than a new file appearing on disk.
 */
export const PLAN_AMENDED_EVENT = 'plan-version-created';

/** One recorded spec-reviewer dispatch against an epic. */
export interface SpecReviewRecord {
  epicId: string;
  /** The plan version that was read — a review of v1 says nothing about v2. */
  planVersion: number;
  /** The commit the reviewer actually read; what makes a record stale or current. */
  headSha: string;
  reviewedBy: string;
  /** Ids of the spec findings this review raised; empty means "ran and was clean". */
  findingIds: string[];
  eventId: string;
  ts: string;
}

/**
 * What is known about the epic's closing spec review: the last recorded one
 * and where the assembled branch head actually is right now. Two fields for
 * the same reason IntegrationStatus has two — a review is only evidence about
 * the commit it read, and the pair is what makes "current" decidable.
 */
export interface SpecReviewStatus {
  review: SpecReviewRecord | null;
  headSha: string | null;
}

/** Last-wins fold: a re-review supersedes its predecessor, it does not stack. */
export function latestSpecReview(
  events: readonly StoredEvent[],
  epicId: string,
): SpecReviewRecord | null {
  let latest: SpecReviewRecord | null = null;
  for (const event of events) {
    if (event.record.event_type !== SPEC_REVIEW_EVENT) continue;
    const payload = event.record.payload as Record<string, unknown>;
    if (payload.epic_id !== epicId) continue;
    latest = {
      epicId,
      planVersion: Number(payload.plan_version ?? 0),
      headSha: String(payload.head_sha ?? ''),
      reviewedBy: String(payload.reviewed_by ?? ''),
      findingIds: (payload.finding_ids ?? []) as string[],
      eventId: event.event_id,
      ts: event.record.ts,
    };
  }
  return latest;
}

/**
 * The epic gate refusing to certify a spec nobody re-read once the code
 * existed. Mirrors integrationBlockers exactly, including the fail-closed
 * unknown-head case: a review pinned to a sha nobody can compare against is
 * not evidence about anything.
 *
 * There is deliberately no SPEC_REVIEW_NOT_REQUIRED escape hatch. An epic can
 * legitimately owe no MCP surface; every epic has a plan, and every plan can
 * be wrong in a way only the finished code reveals.
 *
 * A review reads two things, so it goes stale two ways (D-125). The sha axis
 * was the only one this function knew, and the plan axis is the one that
 * matters most: an amendment is by definition a plan that just changed because
 * a review found it wrong, so the single moment a plan is likeliest to be
 * freshly defective was the one moment the gate was blind to. `epic verdict`
 * certified a review of v4 against a plan that had been v5 for seconds. The
 * two axes are independent — an amendment can land before any commit
 * implements it — so a current sha must not vouch for a plan the review never
 * read, and neither check is allowed to stand in for the other.
 *
 * `planVersion` is the live plan's version, or null when the epic has no
 * readable plan file. Null casts no vote, which is D-126's deliberate scope
 * line rather than a hole: most epics ran as punch-list branches with no plan
 * directory, and making absence a blocker would make them unclosable. It is
 * a required parameter for the reason `integration` and `mcp` are required on
 * summarizeEpic — a defaulted one is a forgotten argument that manufactures a
 * green.
 */
export function specReviewBlockers(
  epicId: string,
  status: SpecReviewStatus,
  planVersion: number | null,
): string[] {
  const branch = `smith/${epicId}/${RESERVED_TASK_ID}`;
  const { review, headSha } = status;

  if (review === null) {
    return [
      `Epic "${epicId}" has no closing spec review on record: nothing re-read the plan against the code that now exists. A spec review run before the code was written cannot see the defects the code reveals (D-33).`,
    ];
  }

  if (planVersion !== null) {
    // latestSpecReview reads a missing plan_version as 0, and "I did not
    // record which plan I read" is unverifiable, not current — the same
    // fail-closed call as the unknown head below.
    if (!Number.isInteger(review.planVersion) || review.planVersion < 1) {
      return [
        `The closing spec review for "${epicId}" records no plan version, so it cannot be shown to cover plan v${planVersion}.`,
      ];
    }
    if (review.planVersion < planVersion) {
      return [
        `The closing spec review for "${epicId}" is stale: it read plan v${review.planVersion}, and the epic's live plan is v${planVersion}. Whatever the amendment changed has been reviewed against no spec at all.`,
      ];
    }
    // Newer than the plan on disk: a rolled-back or hand-written record. The
    // review names a version nothing can be compared against, so it is
    // evidence about a plan this epic is not on.
    if (review.planVersion > planVersion) {
      return [
        `The closing spec review for "${epicId}" records plan v${review.planVersion}, and the epic's live plan is v${planVersion}: the review names a version the repository does not have.`,
      ];
    }
  }

  if (headSha === null) {
    return [
      `Could not read the head of ${branch}, so the closing spec review recorded at ${review.headSha.slice(0, 8)} cannot be shown to cover it.`,
    ];
  }

  if (review.headSha !== headSha) {
    return [
      `The closing spec review for "${epicId}" is stale: it read ${review.headSha.slice(0, 8)}, and ${branch} is now at ${headSha.slice(0, 8)}. Anything merged since has been reviewed against no spec at all.`,
    ];
  }

  return [];
}

export interface SpecReviewInput {
  epicId: string;
  /** The plan version the reviewer read; stamped onto every finding's spec_ref. */
  planVersion: number;
  /** The commit the reviewer read — supplied by the caller, which owns the git read. */
  headSha: string;
  /** taxonomy `agent`, normally `spec-reviewer`. */
  reviewedBy: string;
  reviewedByProvider?: string;
  /** Evidence, no identity: each item must name the criterion it is against. */
  evidence: readonly FindingEvidence[];
}

/**
 * Run the closing spec review's bookkeeping: mint the reviewer's evidence as
 * spec-scoped findings, raise each, and record that the review happened.
 *
 * The event is written even when the evidence is empty. "Ran and was clean" and
 * "never ran" are different facts and the epic gate distinguishes them; a
 * review that only logged when it found something would make a silent skip
 * indistinguishable from a pass, which is the same shape of hole D-42 was.
 *
 * Findings are raised BEFORE the review event so the event can cite them: a
 * record naming finding ids that do not exist yet is a record that lies for
 * however long the raise loop takes to crash.
 */
export async function recordSpecReview(
  input: SpecReviewInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<SpecReviewRecord> {
  const { epicId, planVersion, headSha, reviewedBy } = input;

  const drafts = mintFindings(
    input.evidence,
    {
      taskId: `${epicId}/${RESERVED_TASK_ID}`,
      foundBy: reviewedBy,
      ...(input.reviewedByProvider === undefined
        ? {}
        : { foundByProvider: input.reviewedByProvider }),
      spec: { planVersion },
    },
    opts,
  );

  const findingIds: string[] = [];
  for (const draft of drafts) {
    const raised = await raiseFinding(draft, ctx, opts);
    // A suppressed raise (fingerprint already waived) logged its own
    // finding-suppressed event and appended no finding. Citing an id that was
    // never raised would make this record unresolvable; the suppression is
    // already in the log where analytics can see the recurrence.
    if (raised.suppressed) continue;
    findingIds.push(raised.finding.finding_id);
  }

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: SPEC_REVIEW_EVENT,
      task_id: `${epicId}/${RESERVED_TASK_ID}`,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        plan_version: planVersion,
        head_sha: headSha,
        reviewed_by: reviewedBy,
        ...(input.reviewedByProvider === undefined
          ? {}
          : { reviewed_by_provider: input.reviewedByProvider }),
        finding_ids: findingIds,
        finding_count: findingIds.length,
      },
    },
    opts,
  );

  return {
    epicId,
    planVersion,
    headSha,
    reviewedBy,
    findingIds,
    eventId: stored.event_id,
    ts: stored.record.ts,
  };
}

export interface AmendPlanInput {
  /** The plan version being amended; the new version is cut from it. */
  plan: PlanFile;
  /** The spec findings this amendment answers. Never empty — see below. */
  findingIds: readonly string[];
  /** Why the criterion moved, in the operator's words. Never blank. */
  rationale: string;
  /**
   * Every site the cited findings' shape occurs at, enumerated by the author —
   * not just the one the finding happened to name. Never empty (D-123).
   */
  sites: readonly string[];
  /** What actually changes. Absent means a pure carry-forward re-cut. */
  changes?: PlanChanges;
}

export interface AmendPlanResult {
  plan: PlanFile;
  diff: PlanDiff;
  /** Named sites no task this version obligates claims. Not an error — see below. */
  sitesUnclaimed: readonly string[];
}

/**
 * The one legitimate way to change an immutable plan.
 *
 * Three guards make this an amendment rather than a rewrite: it must cite at
 * least one spec-scoped finding, it must say why, and it must enumerate the
 * sites the finding's shape occurs at. Without the first, "the plan changed"
 * has no recorded cause and the immutability is decorative — a new version any
 * time anyone wants one is just a mutable plan with extra files. Without the
 * second, the diff records what moved and nothing records the argument, which
 * is the half that a future reader actually needs. Without the third, the
 * remediation scope is chosen by whoever writes the amendment and checked by
 * nothing: a finding names one site, and the question of where else that shape
 * lives gets asked by nobody (D-123, and D-83 one run before it — the same
 * defect twice, which is what moved it out of prose and into a guard).
 *
 * Everything validates before anything acts. The alternative ordering — cut
 * the version, then discover a cited finding is already closed — leaves a plan
 * file on disk that no event explains and findings that were never
 * transitioned, and plan files are not deletable by anything in this codebase.
 *
 * What this does NOT do is close the findings it cites. It used to transition
 * them straight to `amended` — terminal, and counted closed by the epic
 * verdict — in the same call that wrote the plan file, so the severity class
 * severity.yml refuses to waive was discharged in full by writing a sentence
 * (D-127). They now reach `amend-pending`, carrying the task ids this version
 * added or superseded. Those ids landing is what earns `amended`.
 */
export async function amendPlan(
  input: AmendPlanInput,
  ctx: EventContext,
  opts: EventOpts & PlanOpts = {},
): Promise<AmendPlanResult> {
  const { plan, findingIds, rationale, sites } = input;
  const epicId = plan.epic_id;

  if (findingIds.length === 0) {
    throw new SpecError(
      'plan.amendment-without-finding',
      `Refusing to amend plan "${epicId}" v${plan.version}: an amendment cites the spec finding that forced it. A version cut on request is not an amendment, it is a mutable plan.`,
      { epicId, version: plan.version },
    );
  }

  if (rationale.trim() === '') {
    throw new SpecError(
      'plan.amendment-without-rationale',
      `Refusing to amend plan "${epicId}" v${plan.version} with a blank rationale: the diff already records what moved, and only the rationale records why.`,
      { epicId, version: plan.version, findingIds: [...findingIds] },
    );
  }

  // Trimmed and de-duplicated once, here: what the guard accepts and what the
  // event records have to be the same list, or the record answers a question
  // the guard never asked.
  const namedSites = [...new Set(sites.map((s) => s.trim()))];
  if (namedSites.length === 0 || namedSites.some((s) => s === '')) {
    throw new SpecError(
      'plan.amendment-without-sites',
      `Refusing to amend plan "${epicId}" v${plan.version}: name every site the finding's shape occurs at, not only the one it was reported against. A finding names where it was noticed; the amendment has to answer where the shape lives (D-123).`,
      { epicId, version: plan.version, findingIds: [...findingIds] },
    );
  }

  // listFindings has no by-id filter (it folds by task/epic/status/severity),
  // so index the session's findings here rather than folding once per id.
  const all = await listFindings(ctx.sessionId, {}, opts);
  const byId = new Map(all.map((f) => [f.finding_id, f]));

  const cited: Finding[] = [];
  for (const findingId of findingIds) {
    const finding = byId.get(findingId);
    if (finding === undefined) {
      throw new SpecError(
        'plan.amendment-unknown-finding',
        `Amendment of "${epicId}" v${plan.version} cites finding ${findingId}, which was never raised in session ${ctx.sessionId}.`,
        { epicId, version: plan.version, findingId },
      );
    }
    cited.push(finding);
  }

  for (const finding of cited) {
    if (findingScope(finding) !== SPEC_FINDING_SCOPE) {
      throw new SpecError(
        'plan.amendment-not-spec-scoped',
        `Finding ${finding.finding_id} is scoped ${findingScope(finding)}, not ${SPEC_FINDING_SCOPE}: it says the code is wrong. A new plan version is not how a diff defect gets fixed.`,
        { epicId, findingId: finding.finding_id, scope: findingScope(finding) },
      );
    }
  }

  for (const finding of cited) {
    if (!(LEGAL_TRANSITIONS[finding.finding_status] ?? []).includes(AMEND_PENDING_STATUS)) {
      throw new SpecError(
        'plan.amendment-finding-closed',
        `Finding ${finding.finding_id} is already ${finding.finding_status} and cannot reach ${AMEND_PENDING_STATUS}. An amendment answering a closed finding answers nothing.`,
        { epicId, findingId: finding.finding_id, findingStatus: finding.finding_status },
      );
    }
  }

  // The last guard needs the diff, and the diff is only defined against the
  // version this amendment would cut — so the version is CONSTRUCTED here and
  // written a few lines below, once the guard has passed. That is what
  // `draftNextVersion` is for: "everything validates before anything acts"
  // only holds if this check can run before a plan file exists, and nothing in
  // this codebase deletes a plan file (D-127).
  const draft = draftNextVersion(plan, input.changes ?? {});

  // D-21: a malformed `--changes` file can still produce a draft that reads
  // fine structurally (every entry a plain object with a string task_id) but
  // fails the plan's own schema/taxonomy rules — the exact check `smith plan
  // validate` runs. Plans are immutable and nothing deletes one, so a
  // schema-invalid version written to disk is unrecoverable; refusing it here,
  // before the write, is what closes that loop rather than leaving `smith
  // plan validate` to reject the file this tool just produced.
  const draftValidation = validatePlan(draft, opts);
  if (!draftValidation.valid) {
    throw new SpecError(
      'plan.amendment-invalid-draft',
      `Refusing to amend plan "${epicId}" v${plan.version}: v${draft.version} would fail its own validation (the same check \`smith plan validate\` runs), so nothing was written. ${draftValidation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join(' ')}`,
      { epicId, version: plan.version, nextVersion: draft.version, errors: draftValidation.errors },
    );
  }

  const diff = diffPlans(plan, draft);

  // The task ids this amendment makes the cited findings' discharge
  // condition. `removed` and `carried` are not obligations: a carried task is
  // untouched by this amendment, and a removed one will never land. The two
  // rejected shapes are named apart in the message because the diff is not
  // always empty here: `PlanChanges` has no `remove`, so the only way an id
  // leaves a version is `draftNextVersion` dropping a completed task from the
  // live backlog. That is a real `removed` entry the operator did not ask for,
  // and telling them nothing changed would be arguing about the wrong thing.
  //
  // A superseded id only counts while the amended version still claims it. A
  // supersede whose replacement carries a different id leaves the old one
  // behind as a dead record — `diffPlans` calls that renamed away or retired,
  // and still reports it superseded — and nothing will ever dispatch it. The
  // replacement is in `added`, so the obligation survives the rename; keeping
  // the dead id too would make the finding undischargeable, which is the
  // failure this whole defect is about, reached from the other side.
  const live = new Set(livePlanTasks(draft).map((t) => t.task_id));
  const obligations = [
    ...new Set([...diff.added, ...diff.superseded.filter((id) => live.has(id))]),
  ];
  if (obligations.length === 0) {
    const shape =
      diff.removed.length > 0
        ? `would drop completed ${diff.removed.join(', ')} and carry the rest forward unchanged`
        : 'would carry every task forward unchanged';
    throw new SpecError(
      'plan.amendment-without-obligation',
      `Refusing to amend plan "${epicId}" v${plan.version}: v${draft.version} ${shape}, adding no task and superseding none. Those two are the only changes that leave work to land, so ${cited.map((f) => f.finding_id).join(', ')} would have nothing to wait on and cutting the version would discharge the finding on the spot (D-127). Say which task the amendment adds or supersedes.`,
      {
        epicId,
        version: plan.version,
        nextVersion: draft.version,
        findingIds: [...findingIds],
        diff,
      },
    );
  }

  // Which named sites this version leaves no work to land on. Deliberately not
  // a guard: the fix for a shape in one file legitimately lands in another, and
  // refusing here would price the act of naming a site — pushing the next
  // author toward the shorter list, which is the defect rather than the cure.
  // Recorded so the closing review reads the scope question off the event
  // instead of reconstructing it (D-123).
  // Through `claimCoversPath`, not string equality: claims are globs, and a
  // site under `src/bar/*.ts` is claimed whether or not it is spelled that way.
  // That function is the one place this question gets answered (P9-15).
  // `TaskSpecRecord.claims` is `unknown` and the plan's own schema is what
  // guarantees it is a string array, so it is filtered rather than re-validated
  // here — the same call `ownershipFromPlan` makes. A task with no claims
  // contributes no coverage, which leaves its sites unclaimed rather than
  // silently covered: the safe direction for a list whose job is to be read.
  const obligated = new Set(obligations);
  const claims = draft.tasks
    .filter((t) => obligated.has(t.task_id) && Array.isArray(t.claims))
    .flatMap((t) => t.claims as string[]);
  const unclaimedSites = namedSites.filter((s) => !claims.some((c) => claimCoversPath(c, s)));

  // Validation is done; from here the version exists and the record has to
  // catch up to it, so nothing below is allowed to be conditional. The write
  // goes through `nextVersion` rather than from `draft`: `draftNextVersion` is
  // pure, so the two agree by construction, and there stays exactly one
  // function in this codebase that puts a plan version on disk.
  const amended = nextVersion(plan, input.changes ?? {}, opts);

  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: PLAN_AMENDED_EVENT,
      task_id: planRefTaskId(epicId, amended.version),
      plan_version: amended.version,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        version: amended.version,
        previous_version: plan.version,
        amends: cited.map((f) => ({
          finding_id: f.finding_id,
          criterion_ref: f.spec_ref?.criterion_ref ?? null,
        })),
        rationale,
        sites: namedSites,
        sites_unclaimed: unclaimedSites,
        diff,
      },
    },
    opts,
  );

  for (const finding of cited) {
    await transition(finding.finding_id, AMEND_PENDING_STATUS, ctx, opts, {
      amendsTaskIds: obligations,
      amendsPlanVersion: amended.version,
    });
  }

  return { plan: amended, diff, sitesUnclaimed: unclaimedSites };
}
