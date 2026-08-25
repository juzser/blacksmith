import {
  type ClaimedTask,
  decideFindingAttribution,
  type FindingOwnership,
  resolveFindingOwner,
} from './claims.js';
import { foldTasks } from './db/projector.js';
import { appendEvent, type EventOpts, readLineageEvents } from './events.js';
import {
  computeFingerprint,
  type EventContext,
  type Finding,
  type RaiseFindingInput,
  reattributeFinding,
} from './findings.js';
import { emitFollowUpTask, followUpTaskId } from './taskEvents.js';
import { requireEpicOfTaskId } from './taskId.js';

/**
 * Who a finding belongs to, decided from the file it names (D-41/P9-24).
 *
 * The wave-4 security reviewer anchored a real S2 to src/parse.ts, a file the
 * task at the gate was forbidden to touch. Everything downstream then read the
 * gate invocation as the answer to "whose finding is this": it blocked a diff
 * that could not contain the fix, and left the file's actual owner untouched.
 * Ownership is a property of the file, so it is resolved here, once, and both
 * hosts — the gate (gate.ts) and a bare `smith findings raise` (cli.ts) — call
 * the same code. A second copy of this decision would be a second answer.
 */
export type AttributionKind = 'gated' | 'reassigned' | 'follow-up';

export interface RoutedFinding {
  /** The intake item, re-minted under `taskId` unless it stayed `gated`. */
  input: RaiseFindingInput;
  attribution: AttributionKind;
  /** The task the finding belongs to: the default, the owner, or a new follow-up. */
  taskId: string;
  epicId: string;
  /** Where the finding would have landed without this routing. */
  fromTaskId: string;
  /** Why it is not on `fromTaskId`; empty when it is. */
  reason: string;
  /**
   * The claim set a `follow-up` is minted with; empty for the other two kinds,
   * which land on a task that already has claims of its own (D-48/P9-31).
   */
  claims: string[];
}

export interface RouteOptions {
  /**
   * Who owns a finding when the claims map cannot say otherwise — the task at
   * the gate, or `--task` for a bare raise.
   */
  defaultTaskId: string;
  /**
   * The plan's claims map. Omit it and every finding stays on
   * `defaultTaskId`, which is the pre-P9-24 behaviour — so a caller with no
   * plan to hand is not forced to invent one.
   */
  ownership?: readonly ClaimedTask[];
  /**
   * The epic every routing belongs to, when the caller knows it outright.
   *
   * `smith findings raise --plan` with no `--task` deliberately puts the
   * EPIC id in `defaultTaskId` — it is a fallback owner, not a task — so
   * there is no epic to derive from it. Passing it here keeps that case
   * honest instead of making the derivation lenient for everyone else
   * (D-49/P9-10).
   */
  epicId?: string;
}

/**
 * Every epic this module derives becomes a durable artifact — the `epic_id`
 * on a routed finding, and the `<epic>/followup-<fp>` id of a task that gets
 * dispatched. So an id with no epic is refused here rather than answered with
 * itself: `epicOf("task-1")` used to return "task-1", minting the follow-up
 * `task-1/followup-ab12` under an epic that does not exist (D-49/P9-10).
 */
const epicOf = requireEpicOfTaskId;

/** Every claim the ownership map records for a task id. */
function claimsOf(taskId: string, ownership: readonly ClaimedTask[]): string[] {
  return ownership.filter((t) => t.task_id === taskId).flatMap((t) => t.claims);
}

/**
 * The claims a follow-up inherits (D-48/P9-31).
 *
 * A follow-up minted with only the file the finding named is a task that
 * cannot fix the bug: the fix lands in the implementation AND its test, and
 * the second edit is out of claim. So the follow-up inherits from whoever
 * resolved its ownership — the owner's whole claim set when one task owns the
 * file, the union of the candidates' sets when several could, and the named
 * file alone only when nobody claims it and there is nothing to inherit.
 *
 * The candidate records carry only the single matching claim, so the full set
 * is looked up by id in the ownership map. Sorted and de-duplicated: the
 * claim set is a set, and a task spec that differs run to run is not one.
 */
function followUpClaims(
  owner: FindingOwnership,
  filePath: string,
  ownership: readonly ClaimedTask[],
): string[] {
  const inherited =
    owner.owner === 'resolved'
      ? claimsOf(owner.taskId, ownership)
      : owner.owner === 'ambiguous'
        ? owner.candidates.flatMap((c) => claimsOf(c.taskId, ownership))
        : [];
  return inherited.length === 0 ? [filePath] : [...new Set(inherited)].sort();
}

/**
 * Whether any finding's owner needs looking up in the log at all. Only one
 * that resolves to a DIFFERENT task does — the common case is a judge speaking
 * about the very task at the gate, and that case should not pay for a fold of
 * the whole session.
 */
function needsTaskStatuses(
  items: readonly RaiseFindingInput[],
  ownership: readonly ClaimedTask[],
  defaultTaskId: string,
): boolean {
  return items.some((item) => {
    const owner = resolveFindingOwner(item.filePath, ownership);
    return owner.owner === 'resolved' && owner.taskId !== defaultTaskId;
  });
}

/**
 * Decide where each finding goes, writing nothing. Every id is derived (the
 * follow-up's from the fingerprint), so a caller can compute the whole routing
 * and then discard it if the finding turns out to be waived or refuted — and
 * mint no task for a bug nobody is going to fix.
 */
export async function routeFindings(
  items: readonly RaiseFindingInput[],
  options: RouteOptions,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<RoutedFinding[]> {
  const { defaultTaskId, ownership } = options;
  // Asked once, up front, so an epic that cannot be derived fails before any
  // routing exists rather than on whichever finding happens to need it.
  const defaultEpicId = options.epicId ?? epicOf(defaultTaskId);
  const gated = (item: RaiseFindingInput): RoutedFinding => ({
    input: item,
    attribution: 'gated',
    taskId: defaultTaskId,
    epicId: defaultEpicId,
    fromTaskId: defaultTaskId,
    reason: '',
    claims: [],
  });

  if (ownership === undefined || ownership.length === 0) return items.map(gated);

  // Current status of every task the log knows about, folded once. A task the
  // log has never heard of is simply absent, and reads as open: a task in the
  // plan but not yet in the log is `todo`, not merged.
  //
  // The lineage's log (D-119), because "absent reads as open" is the reading
  // that goes wrong across a session boundary: a task the parent session
  // merged is absent from the child's, so a finding against it would be
  // reassigned to a task that is already done rather than gated.
  const statuses = needsTaskStatuses(items, ownership, defaultTaskId)
    ? new Map(
        foldTasks(await readLineageEvents(ctx.sessionId, opts)).map((t) => [
          t.taskId,
          t.taskStatus,
        ]),
      )
    : undefined;

  return items.map((item) => {
    const owner = resolveFindingOwner(item.filePath, ownership);
    const decided = decideFindingAttribution(owner, defaultTaskId, (id) => statuses?.get(id));
    if (decided.attribution === 'gated') return gated(item);

    if (decided.attribution === 'reassigned') {
      return {
        input: reattributeFinding(item, decided.taskId),
        attribution: 'reassigned',
        taskId: decided.taskId,
        epicId: epicOf(decided.taskId),
        fromTaskId: defaultTaskId,
        reason: `${decided.taskId} claims ${decided.claim}; ${defaultTaskId} does not own this file.`,
        claims: [],
      };
    }

    const epicId = owner.owner === 'resolved' ? epicOf(owner.taskId) : defaultEpicId;
    const taskId = followUpTaskId(
      epicId,
      computeFingerprint({
        filePath: item.filePath,
        category: item.finding.finding_category,
        summary: item.finding.summary,
      }),
    );
    return {
      input: reattributeFinding(item, taskId),
      attribution: 'follow-up',
      taskId,
      epicId,
      fromTaskId: defaultTaskId,
      reason: decided.reason,
      claims: followUpClaims(owner, item.filePath, ownership),
    };
  });
}

/**
 * Write the two facts a re-attributed finding produces: the follow-up task it
 * needs (only when nobody open could take it), and the move itself. The
 * `finding-reattributed` event is what makes a clean gate outcome readable —
 * without it the log shows a finding under a task that was never gated, and no
 * trace of how it got there.
 *
 * Call this only once the finding has survived intake. A waived or refuted
 * finding minting a `todo` follow-up would block the epic verdict on a bug the
 * team already settled.
 */
export async function recordReattribution(
  routed: RoutedFinding,
  finding: Finding,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<void> {
  if (routed.attribution === 'gated') return;

  if (routed.attribution === 'follow-up') {
    await emitFollowUpTask(
      {
        epicId: routed.epicId,
        taskId: routed.taskId,
        objective: `Fix: ${finding.summary}`,
        claims: routed.claims,
      },
      ctx,
      opts,
    );
  }

  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'finding-reattributed',
      task_id: routed.taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        from_task_id: routed.fromTaskId,
        to_task_id: routed.taskId,
        attribution: routed.attribution,
        file_path: routed.input.filePath,
        finding_id: finding.finding_id,
        reason: routed.reason,
      },
    },
    opts,
  );
}
