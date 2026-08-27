// Spec-vs-goal gate.
//
// Every other gate in this factory reads something the planner authored. The
// schema check reads the plan's own shape, the grader reads the plan's own
// acceptance criteria, the reviewer reads a diff against the plan, and the
// closing spec review (spec.ts) re-reads the plan against the code. All of
// them answer "does the work match the spec". None of them can answer "is the
// spec the right spec" -- a plan that decomposes the wrong goal perfectly
// passes every one of them, and the epic closes green having built the wrong
// thing. That is the failure this module exists for.
//
// The reference text therefore has to come from outside the plan. It is the
// `- goal:` line of the roadmap milestone that owns the epic (roadmap.ts,
// `ownsEpic`) -- written by the operator before planning, and never rewritten
// by the planner. The gate splits it into clauses mechanically and asks: for
// each clause, which live plan task delivers it?
//
// Three properties keep this from being a rubber stamp:
//
//   1. The clause list is not the judge's to choose. `goalClauses()` splits
//      the goal deterministically, and recordGoalCheck refuses a coverage map
//      whose clauses are not exactly that list, in that order. A judge cannot
//      make an epic green by declining to mention the clause it failed.
//   2. `covered` has to name live plan task ids, and they are checked against
//      the plan roster. "Yes, somewhere" is not an answer.
//   3. `out-of-scope` has to carry a reason, and the reason is recorded in the
//      event. A milestone that holds several epics has clauses that belong to
//      the siblings, and a retrospective goal paragraph has sentences that are
//      history rather than requirements -- both are legitimate, and both are
//      now a written dismissal an operator can audit instead of a silent drop.
//
// An `uncovered` clause mints a spec-scoped finding, so the remedy is the one
// the plan's immutability allows: `smith plan amend`, cutting a version that
// covers it. It is deliberately not a task-scoped finding -- no coder's diff
// can contain the fix.
//
// Fail-closed on a missing goal, unlike mcp.ts's MCP_SURFACE_NOT_REQUIRED.
// An epic can legitimately owe no MCP surface; an epic that owes no statement
// of what it was for is an epic nobody can say succeeded. Treating that as
// "not required" would rebuild the exact hole roadmap.ts's ownsEpic() doc
// already regrets in writing -- a gate that skipped every project silently
// from the day it shipped -- so the blockers below name the one-line roadmap
// edit that clears them.
//
// Dependency direction matches spec.ts: epic.ts imports from here, never the
// reverse.

import { createHash } from 'node:crypto';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import { type EventContext, type FindingEvidence, mintFindings, raiseFinding } from './findings.js';
import { loadRoadmap, ownsEpic } from './roadmap.js';
import { RESERVED_TASK_ID } from './worktree.js';

export class GoalCheckError extends SmithError {}

export const GOAL_CHECK_EVENT = 'goal-check-recorded';

/**
 * An uncovered clause is always S2-major, and the judge does not get to grade
 * it. "This epic does not deliver a clause of the goal it exists for" is one
 * kind of defect, not a spectrum, and a judge that scores the severity of its
 * own finding is the self-assessment problem the tester isolation just
 * removed from the test gate.
 */
export const UNCOVERED_SEVERITY = 'S2-major';

/**
 * `finding_category` has no `spec-gap` value -- the taxonomy keeps that
 * vocabulary in the `error.spec` group, for errors rather than findings. The
 * scope (`finding_scope: spec`, set by mintFindings' `spec` context) is what
 * says this is about the plan; the category says what kind of wrong it is,
 * and a plan that does not deliver its goal is not correct.
 */
const UNCOVERED_CATEGORY = 'correctness';

export const CLAUSE_VERDICTS = ['covered', 'out-of-scope', 'uncovered'] as const;

export type ClauseVerdict = (typeof CLAUSE_VERDICTS)[number];

/** One clause of the goal, and what the check found about it. */
export interface ClauseCoverage {
  clause: string;
  verdict: ClauseVerdict;
  /** Live plan task ids that deliver this clause. Required when `covered`. */
  taskIds?: string[];
  /** Why this clause is not this epic's to answer. Required when `out-of-scope`. */
  reason?: string;
}

/**
 * The goal an epic is measured against, resolved from the roadmap. Carries
 * the milestone it came from so a blocker can name the line to edit, and the
 * digest so a rewritten goal invalidates a check the way a new plan version
 * does.
 */
export interface EpicGoalStatus {
  milestoneId: string | null;
  goal: string | null;
  clauses: string[];
  digest: string | null;
}

/** No milestone owns this epic, or the one that does declares no goal. */
export const EPIC_GOAL_UNDECLARED: EpicGoalStatus = Object.freeze({
  milestoneId: null,
  goal: null,
  clauses: [],
  digest: null,
});

/**
 * Split a goal into the clauses a plan has to answer, deterministically.
 *
 * Sentence-level and nothing finer. Comma splitting is the tempting next step
 * and it is unsafe -- "Test gate, reviewer/verifier chain, severity policy"
 * and "the worktree, which the coder owns, is disposable" are the same shape
 * to a splitter and opposite things to a reader. A goal author who wants a
 * requirement graded on its own writes it as its own sentence.
 *
 * Paragraph breaks split too, so a goal written as a bulleted or multi-line
 * block grades line by line even where the lines carry no full stop.
 *
 * No abbreviation table. "e.g." splits a clause in two, and both halves then
 * have to be answered or dismissed in writing -- noisier than ideal, but the
 * safe direction: this function can over-split, and must never drop text a
 * requirement was hiding in.
 */
export function goalClauses(text: string): string[] {
  const clauses: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // A terminator ends a clause only where the next sentence visibly starts:
    // an uppercase letter, a digit, a quote or a backtick. "v1.2" and
    // "state/events/x.jsonl" stay whole.
    for (const piece of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/)) {
      const clause = piece.trim();
      if (clause.length > 0) clauses.push(clause);
    }
  }
  return clauses;
}

/**
 * Digest of the goal text, whitespace-normalized so rewrapping a roadmap
 * paragraph does not invalidate a check while rewording it does.
 */
export function goalDigest(text: string): string {
  const material = text.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export interface ResolveEpicGoalOptions {
  epicId: string;
  roadmapPath?: string;
}

/**
 * Read the epic's goal off the roadmap. Mirrors resolveMcpSurface: the I/O
 * lives here and in the CLI that calls it, so summarizeEpic stays a pure fold
 * over values it was handed.
 *
 * A milestone with a `- goal:` line that is present but empty resolves the
 * same as one with no line at all. Both are "nobody wrote down what this was
 * for", and the remedy is identical.
 */
export function resolveEpicGoal(opts: ResolveEpicGoalOptions): EpicGoalStatus {
  const milestone = loadRoadmap(opts.roadmapPath).find((m) => ownsEpic(m, opts.epicId));
  if (!milestone) return EPIC_GOAL_UNDECLARED;

  const goal = milestone.goal?.trim() ?? '';
  if (goal.length === 0) {
    return { milestoneId: milestone.milestoneId, goal: null, clauses: [], digest: null };
  }
  return {
    milestoneId: milestone.milestoneId,
    goal,
    clauses: goalClauses(goal),
    digest: goalDigest(goal),
  };
}

/** One recorded spec-vs-goal check against an epic. */
export interface GoalCheckRecord {
  epicId: string;
  /** The milestone whose goal was read. */
  milestoneId: string;
  /** The plan version that was checked — a check of v1 says nothing about v2. */
  planVersion: number;
  /** Digest of the goal text as it read — the second staleness axis. */
  goalDigest: string;
  checkedBy: string;
  coverage: ClauseCoverage[];
  /** Ids of the spec findings this check raised; empty means "ran and was clean". */
  findingIds: string[];
  eventId: string;
  ts: string;
}

/**
 * What is known about the epic's spec-vs-goal check: the last recorded one and
 * the goal the roadmap declares right now. Two fields for the reason
 * SpecReviewStatus has two — a check is only evidence about the text it read.
 */
export interface GoalCheckStatus {
  check: GoalCheckRecord | null;
  goal: EpicGoalStatus;
}

/** Last-wins fold: a re-check supersedes its predecessor, it does not stack. */
export function latestGoalCheck(
  events: readonly StoredEvent[],
  epicId: string,
): GoalCheckRecord | null {
  let latest: GoalCheckRecord | null = null;
  for (const event of events) {
    if (event.record.event_type !== GOAL_CHECK_EVENT) continue;
    const payload = event.record.payload as Record<string, unknown>;
    if (payload.epic_id !== epicId) continue;
    latest = {
      epicId,
      milestoneId: String(payload.milestone_id ?? ''),
      planVersion: Number(payload.plan_version ?? 0),
      goalDigest: String(payload.goal_digest ?? ''),
      checkedBy: String(payload.checked_by ?? ''),
      coverage: (payload.coverage ?? []) as ClauseCoverage[],
      findingIds: (payload.finding_ids ?? []) as string[],
      eventId: event.event_id,
      ts: event.record.ts,
    };
  }
  return latest;
}

const ROADMAP_REMEDY =
  "Give the milestone that owns it a `- goal:` line in factory/specs/roadmap.md, or add the epic to an existing milestone's `- epics:` list.";

/**
 * The epic gate refusing to certify a plan nobody checked against the goal it
 * was written from.
 *
 * Every check here is mechanical — a deterministic oracle over recorded
 * values, decided before any judge's opinion enters. The judge's opinion is
 * in the coverage map; these are the things it is not allowed to be wrong
 * about.
 *
 * A check reads two things and so goes stale two ways, exactly as D-125 found
 * for the spec review: the plan it graded and the goal it graded against. An
 * amendment bumps the version; an operator sharpening a vague goal line bumps
 * the digest. Neither may stand in for the other — the moment a goal is
 * rewritten is the moment a plan is likeliest to no longer answer it.
 *
 * `livePlanTaskIds` is the plan's live roster. Coverage citing an id that is
 * not on it is rejected here as well as at record time, because an event can
 * also arrive by hand.
 */
export function goalCheckBlockers(
  epicId: string,
  status: GoalCheckStatus,
  planVersion: number | null,
  livePlanTaskIds: readonly string[],
): string[] {
  const { check, goal } = status;

  if (goal.milestoneId === null) {
    return [
      `No roadmap milestone owns epic "${epicId}", so there is no goal to check its plan against — the spec could be wrong from the first line and every other gate would still pass. ${ROADMAP_REMEDY}`,
    ];
  }
  if (goal.goal === null || goal.digest === null) {
    return [
      `Milestone "${goal.milestoneId}" owns epic "${epicId}" but declares no goal, so there is nothing to check its plan against. ${ROADMAP_REMEDY}`,
    ];
  }

  if (check === null) {
    return [
      `Epic "${epicId}" has no spec-vs-goal check on record: nothing has asked whether its plan answers the goal milestone "${goal.milestoneId}" declares. Run \`smith epic goal-check --epic ${epicId}\`.`,
    ];
  }

  if (check.goalDigest !== goal.digest) {
    return [
      `The spec-vs-goal check for "${epicId}" is stale: it read a goal that digests to ${check.goalDigest}, and milestone "${goal.milestoneId}" now declares one that digests to ${goal.digest}. The plan has been checked against a goal the roadmap no longer states.`,
    ];
  }

  if (planVersion !== null) {
    // latestGoalCheck reads a missing plan_version as 0, and "I did not record
    // which plan I graded" is unverifiable rather than current — the same
    // fail-closed call specReviewBlockers makes.
    if (!Number.isInteger(check.planVersion) || check.planVersion < 1) {
      return [
        `The spec-vs-goal check for "${epicId}" records no plan version, so it cannot be shown to cover plan v${planVersion}.`,
      ];
    }
    if (check.planVersion < planVersion) {
      return [
        `The spec-vs-goal check for "${epicId}" is stale: it graded plan v${check.planVersion}, and the epic's live plan is v${planVersion}. Whatever the amendment changed has been checked against no goal at all.`,
      ];
    }
    if (check.planVersion > planVersion) {
      return [
        `The spec-vs-goal check for "${epicId}" records plan v${check.planVersion}, and the epic's live plan is v${planVersion}: the check names a version the repository does not have.`,
      ];
    }

    const live = new Set(livePlanTaskIds);
    const phantom = [
      ...new Set(
        check.coverage.flatMap((entry) => entry.taskIds ?? []).filter((id) => !live.has(id)),
      ),
    ];
    if (phantom.length > 0) {
      return [
        `The spec-vs-goal check for "${epicId}" credits ${phantom.length === 1 ? 'a task' : 'tasks'} that plan v${planVersion} does not have: ${phantom.join(', ')}. A clause covered by a task that does not exist is a clause nothing delivers.`,
      ];
    }
  }

  // The clause list is the goal's, not the check's (see goalClauses). A record
  // whose clauses have drifted from the goal's is answering a different
  // question, whatever its verdicts say.
  const recorded = check.coverage.map((entry) => entry.clause);
  if (recorded.length !== goal.clauses.length || recorded.some((c, i) => c !== goal.clauses[i])) {
    return [
      `The spec-vs-goal check for "${epicId}" covers ${recorded.length} clause(s) and milestone "${goal.milestoneId}" declares ${goal.clauses.length}. The recorded check does not answer the goal as written.`,
    ];
  }

  const uncovered = check.coverage.filter((entry) => entry.verdict === 'uncovered');
  if (uncovered.length > 0) {
    return [
      `The spec-vs-goal check for "${epicId}" left ${uncovered.length} goal clause(s) uncovered by plan v${check.planVersion}: ${uncovered.map((entry) => JSON.stringify(entry.clause)).join('; ')}. Answer them with \`smith plan amend\` — no task diff can contain the fix.`,
    ];
  }

  return [];
}

export interface GoalCheckInput {
  epicId: string;
  /** The milestone the goal was read from — resolveEpicGoal's answer. */
  milestoneId: string;
  /** The goal text as read; clause-split here rather than trusted from the judge. */
  goal: string;
  /** The plan version graded; stamped onto every finding's spec_ref. */
  planVersion: number;
  /** The plan's live roster, used to refuse coverage that credits a phantom task. */
  livePlanTaskIds: readonly string[];
  /** taxonomy `agent`, normally `spec-reviewer`. */
  checkedBy: string;
  checkedByProvider?: string;
  /** One entry per clause of `goal`, in order. */
  coverage: readonly ClauseCoverage[];
}

/**
 * Run the spec-vs-goal check's bookkeeping: validate the judge's coverage map
 * against the goal it claims to answer, mint every uncovered clause as a
 * spec-scoped finding, and record that the check happened.
 *
 * Everything validates before anything acts, the way amendPlan does: a run
 * that raises three findings and then rejects the fourth clause has already
 * changed the log for a check that never completed.
 *
 * The event is written even when every clause is covered, for the reason
 * recordSpecReview's is: "ran and was clean" and "never ran" are different
 * facts, and a gate that only logged the first would make a silent skip
 * indistinguishable from a pass.
 */
export async function recordGoalCheck(
  input: GoalCheckInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<GoalCheckRecord> {
  const { epicId, milestoneId, planVersion, checkedBy } = input;
  const taskId = `${epicId}/${RESERVED_TASK_ID}`;

  const expected = goalClauses(input.goal);
  if (expected.length === 0) {
    throw new GoalCheckError(
      'goal-check.empty-goal',
      `Milestone "${milestoneId}" declares no goal text for "${epicId}", so there are no clauses to check.`,
      { epicId, milestoneId },
    );
  }

  const recorded = input.coverage.map((entry) => entry.clause);
  if (recorded.length !== expected.length || recorded.some((c, i) => c !== expected[i])) {
    throw new GoalCheckError(
      'goal-check.clause-mismatch',
      `The coverage map for "${epicId}" must carry one entry per goal clause, in order: ${expected.length} expected, ${recorded.length} given. The clause list is the goal's, not the check's.`,
      { epicId, expected, recorded },
    );
  }

  const live = new Set(input.livePlanTaskIds);
  input.coverage.forEach((entry, index) => {
    // Verdict first, and against a runtime list rather than the union type:
    // this input arrives as JSON from a judge, so the compiler's guarantee is
    // about the callers it can see, not about the value that shows up.
    if (!(CLAUSE_VERDICTS as readonly string[]).includes(entry.verdict)) {
      throw new GoalCheckError(
        'goal-check.unknown-verdict',
        `Clause ${index + 1} of "${epicId}" carries verdict "${entry.verdict}". Valid: ${CLAUSE_VERDICTS.join(', ')}.`,
        { epicId, index, verdict: entry.verdict },
      );
    }
    if (entry.verdict === 'covered') {
      const cited = entry.taskIds ?? [];
      if (cited.length === 0) {
        throw new GoalCheckError(
          'goal-check.covered-without-task',
          `Clause ${index + 1} of "${epicId}" is marked covered and names no task. "Covered somewhere" is not an answer a plan can be graded on.`,
          { epicId, index, clause: entry.clause },
        );
      }
      const phantom = cited.filter((id) => !live.has(id));
      if (phantom.length > 0) {
        throw new GoalCheckError(
          'goal-check.unknown-task',
          `Clause ${index + 1} of "${epicId}" is covered by ${phantom.join(', ')}, which plan v${planVersion} does not have as a live task.`,
          { epicId, index, clause: entry.clause, taskIds: phantom },
        );
      }
      return;
    }
    if (entry.verdict === 'out-of-scope' && (entry.reason ?? '').trim().length === 0) {
      throw new GoalCheckError(
        'goal-check.dismissal-without-reason',
        `Clause ${index + 1} of "${epicId}" is dismissed as out of scope with no reason. A dismissal an operator cannot audit is a clause silently dropped.`,
        { epicId, index, clause: entry.clause },
      );
    }
  });

  // Anchored at the plan file's repo-relative path, written out rather than
  // derived from opts.specsDir: the path is fingerprint material, and a
  // tmpdir-rooted one would make the same defect dedup differently on every
  // machine. Carrying the version means a re-check of an amended plan raises
  // its own finding — a distinct claim about a distinct immutable artifact.
  const anchor = `factory/specs/active/${epicId}/plan-v${planVersion}.json`;
  const evidence: FindingEvidence[] = [];
  input.coverage.forEach((entry, index) => {
    if (entry.verdict !== 'uncovered') return;
    evidence.push({
      file_path: anchor,
      finding_category: UNCOVERED_CATEGORY,
      severity: UNCOVERED_SEVERITY,
      criterion_ref: `goal:${milestoneId}#${index + 1}`,
      summary: `Plan v${planVersion} delivers no clause of the epic goal: ${entry.clause}`,
      failure_scenario: {
        inputs: `Milestone "${milestoneId}" declares the goal clause: ${entry.clause}`,
        expected: `Some live task of plan v${planVersion} delivers it.`,
        actual:
          'No task in the plan answers it, so every task gate can pass, the epic can close, and the clause is still undelivered.',
      },
    });
  });

  const drafts = mintFindings(
    evidence,
    {
      taskId,
      foundBy: checkedBy,
      ...(input.checkedByProvider === undefined
        ? {}
        : { foundByProvider: input.checkedByProvider }),
      spec: { planVersion },
    },
    opts,
  );

  const findingIds: string[] = [];
  for (const draft of drafts) {
    const raised = await raiseFinding(draft, ctx, opts);
    // A suppressed raise (fingerprint already waived) logged its own
    // finding-suppressed event and appended no finding; citing an id that was
    // never raised would make this record unresolvable.
    if (raised.suppressed) continue;
    findingIds.push(raised.finding.finding_id);
  }

  const coverage = input.coverage.map((entry) => ({ ...entry }));
  const digest = goalDigest(input.goal);

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: GOAL_CHECK_EVENT,
      task_id: taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        milestone_id: milestoneId,
        plan_version: planVersion,
        goal_digest: digest,
        checked_by: checkedBy,
        ...(input.checkedByProvider === undefined
          ? {}
          : { checked_by_provider: input.checkedByProvider }),
        coverage,
        clause_count: coverage.length,
        uncovered_count: coverage.filter((entry) => entry.verdict === 'uncovered').length,
        out_of_scope_count: coverage.filter((entry) => entry.verdict === 'out-of-scope').length,
        finding_ids: findingIds,
        finding_count: findingIds.length,
      },
    },
    opts,
  );

  return {
    epicId,
    milestoneId,
    planVersion,
    goalDigest: digest,
    checkedBy,
    coverage,
    findingIds,
    eventId: stored.event_id,
    ts: stored.record.ts,
  };
}
