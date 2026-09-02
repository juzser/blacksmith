/**
 * Which scheduler proposals may run themselves, and which wait for a person.
 *
 * The scheduler already decided WHAT is due (architecture §12); this decides
 * WHO gets to say yes to it. Keeping the two apart is the point: `scheduler.ts`
 * can be read as "what does the log say is owed" without also encoding trust,
 * and this file can be read as trust alone.
 *
 * It enacts nothing. No dispatch, no worktree, no event — the same doctrine
 * `daemon.ts` states for the scheduler ("never dispatches an agent, never
 * merges, never writes to a worktree") and `wave next` follows: compute, hand
 * back, let the caller act. `smith scheduler admit` prints this and stops, so
 * the classification can be read, disagreed with, and diffed before anything
 * moves.
 *
 * EVERY RULE HERE CAN ONLY DENY. There is no branch that promotes a proposal
 * the policy did not already name, so the answer to "what can run without me?"
 * is the whitelist in scheduler.yml, not this code. A reader who trusts that
 * sentence never has to audit the file to bound the blast radius, which is the
 * only reason auto-dispatch is safe to have at all.
 *
 * Two consequences worth stating because they are easy to get backwards:
 *
 *   - A recheck is whitelisted BY REASON, never by confidence. A
 *     `RecheckProposal.confidence` is the completed task's confidence, and a
 *     low one is why the recheck exists at all (`proposeRechecks`:
 *     `taskConfidence < policy.confidenceThreshold` -> 'low-confidence').
 *     Applying `MaintenanceProposal`'s floor to it would hold back precisely
 *     the rechecks that matter and wave through the routine ones. The two
 *     fields share a name and mean opposite things.
 *   - The security keywords are crosscheck.yml's list, passed in rather than
 *     copied, so promoting a word to security-sensitive moves the cross-check
 *     trigger and this gate together. Matching is case-insensitive substring,
 *     as `plan_quorum` already matches, and it over-matches on purpose:
 *     "author" contains "auth". A false positive costs one operator tick; a
 *     false negative auto-runs a change to an auth path.
 */

import type { SchedulerProposal } from './scheduler.js';

/** Who says yes. */
export type AdmissionDecision = 'auto' | 'operator';

export type AdmissionCode =
  | 'admitted'
  | 'autonomy-disabled'
  | 'growth-never-auto'
  | 'kind-not-whitelisted'
  | 'reason-not-whitelisted'
  | 'below-confidence-floor'
  | 'security-surface';

export interface Admission {
  proposal: SchedulerProposal;
  /** What the proposal is about, in one line, for a human reading the list. */
  subject: string;
  decision: AdmissionDecision;
  code: AdmissionCode;
  /** Why, in the terms the operator would use to argue with it. */
  reason: string;
}

/** scheduler.yml's `autonomy:` block. */
export interface AutonomyPolicy {
  enabled: boolean;
  autoDispatchKinds: string[];
  autoDispatchRecheckReasons: string[];
  /** Maintenance only — see the module header on why rechecks are not gated by confidence. */
  confidenceFloor: number;
}

export interface AdmissionContext {
  /** crosscheck.yml `plan_quorum.security_keywords`, passed in, never copied. */
  securityKeywords: readonly string[];
  /**
   * task id -> the claim globs that task owns, for the security match. A
   * `RecheckProposal` carries no paths, so without this a recheck of
   * `src/auth/session.ts` looks like any other. Absent means the caller could
   * not say; the match then sees the ids alone.
   */
  claimsByTask?: ReadonlyMap<string, readonly string[]>;
}

interface Field {
  field: string;
  value: string;
}

interface SecurityHit extends Field {
  keyword: string;
}

function firstSecurityHit(
  fields: readonly Field[],
  keywords: readonly string[],
): SecurityHit | null {
  for (const { field, value } of fields) {
    const haystack = value.toLowerCase();
    for (const keyword of keywords) {
      const needle = keyword.toLowerCase();
      if (needle.length > 0 && haystack.includes(needle)) return { field, value, keyword };
    }
  }
  return null;
}

function subjectOf(proposal: SchedulerProposal): string {
  switch (proposal.kind) {
    case 'recheck':
      return proposal.epicId
        ? `recheck of task ${proposal.taskId} (epic ${proposal.epicId})`
        : `recheck of task ${proposal.taskId}`;
    case 'maintenance': {
      const names = proposal.packages.map((p) => p.name);
      const shown = names.slice(0, 5).join(', ');
      const rest = names.length > 5 ? `, +${names.length - 5} more` : '';
      return `maintenance bump of ${names.length} package(s): ${shown}${rest}`;
    }
    case 'growth-review-due':
      return `product-growth review, ${proposal.cadenceDays}-day cadence`;
  }
}

/** The text the security keywords are matched against, named by field so a hit can say where. */
function securityFields(proposal: SchedulerProposal, ctx: AdmissionContext): Field[] {
  switch (proposal.kind) {
    case 'recheck': {
      const claims = ctx.claimsByTask?.get(proposal.taskId) ?? [];
      return [
        ...claims.map((claim) => ({ field: 'claim', value: claim })),
        { field: 'task id', value: proposal.taskId },
      ];
    }
    case 'maintenance':
      return proposal.packages.map((p) => ({ field: 'package', value: p.name }));
    case 'growth-review-due':
      return [];
  }
}

function classify(
  proposal: SchedulerProposal,
  policy: AutonomyPolicy,
  ctx: AdmissionContext,
): Pick<Admission, 'decision' | 'code' | 'reason'> {
  if (!policy.enabled) {
    return {
      decision: 'operator',
      code: 'autonomy-disabled',
      reason: 'scheduler.yml autonomy.enabled is false: every proposal waits for an operator tick.',
    };
  }

  // Ahead of the whitelist, not inside it: architecture §12 puts growth scope
  // with the operator unconditionally, so listing the kind must not be enough.
  if (proposal.kind === 'growth-review-due') {
    return {
      decision: 'operator',
      code: 'growth-never-auto',
      reason:
        'A product-growth review proposes SCOPE, and scope is the operator\'s (architecture §12: "product-growth proposals always wait for an operator tick"). Listing the kind in auto_dispatch_kinds changes nothing.',
    };
  }

  if (!policy.autoDispatchKinds.includes(proposal.kind)) {
    return {
      decision: 'operator',
      code: 'kind-not-whitelisted',
      reason: `scheduler.yml autonomy.auto_dispatch_kinds does not list "${proposal.kind}".`,
    };
  }

  const hit = firstSecurityHit(securityFields(proposal, ctx), ctx.securityKeywords);
  if (hit) {
    return {
      decision: 'operator',
      code: 'security-surface',
      reason: `The ${hit.field} "${hit.value}" matches security keyword "${hit.keyword}" (crosscheck.yml plan_quorum.security_keywords). A security surface always waits, whatever the confidence.`,
    };
  }

  if (proposal.kind === 'recheck') {
    const held = proposal.reasons.filter((r) => !policy.autoDispatchRecheckReasons.includes(r));
    if (held.length > 0) {
      return {
        decision: 'operator',
        code: 'reason-not-whitelisted',
        reason: `Reason(s) ${held.map((r) => `"${r}"`).join(', ')} are not in autonomy.auto_dispatch_recheck_reasons. One unlisted reason holds the proposal even when the others are listed: a recheck is dispatched once, and it would carry the unlisted reason with it.`,
      };
    }
    return {
      decision: 'auto',
      code: 'admitted',
      reason: `Every reason (${proposal.reasons.join(', ')}) is whitelisted.`,
    };
  }

  if (proposal.confidence < policy.confidenceFloor) {
    return {
      decision: 'operator',
      code: 'below-confidence-floor',
      reason: `Confidence ${proposal.confidence} is below autonomy.confidence_floor ${policy.confidenceFloor} — scheduler.ts scores a major-version bump low precisely so a person reads it.`,
    };
  }
  return {
    decision: 'auto',
    code: 'admitted',
    reason: `Confidence ${proposal.confidence} meets autonomy.confidence_floor ${policy.confidenceFloor}, and no package name touches a security keyword.`,
  };
}

/**
 * Pure: one admission per proposal, in the order given, nothing written and
 * nothing mutated. The caller decides what to do with the `auto` ones.
 */
export function admitProposals(
  proposals: readonly SchedulerProposal[],
  policy: AutonomyPolicy,
  ctx: AdmissionContext,
): Admission[] {
  return proposals.map((proposal) => ({
    proposal,
    subject: subjectOf(proposal),
    ...classify(proposal, policy, ctx),
  }));
}
