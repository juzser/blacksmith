import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, readLineageEvents, type StoredEvent } from './events.js';
import type { EventContext, Finding, StaleEvidence } from './findings.js';
import { listFindings, preWaiverStatus, staleFindings, transition } from './findings.js';

export class WaiverError extends SmithError {}

/**
 * Only S3/S4 findings are ever waived (severity.yml waiver_semantics) —
 * single source of truth, reused by findings.ts's transition() so `→ waived`
 * is gated the same way everywhere it can be reached (direct transition
 * call or via a waiver grant).
 */
export const WAIVABLE_SEVERITIES: readonly string[] = ['S3-minor', 'S4-nit'];
/** finding_status values transition() allows a "waived" edge from (findings.ts LEGAL_TRANSITIONS). */
const WAIVABLE_STATUSES: readonly string[] = ['raised', 'confirmed'];

export interface SessionRef {
  sessionId: string;
}

/**
 * Fold waiver-granted/waiver-denied events for one fingerprint: the last
 * decision wins (a denial can, in principle, be revisited by a later grant
 * — the log keeps both, this just answers "is it waived right now").
 *
 * Over the lineage since D-119: a waiver is granted against a FINGERPRINT, and
 * findings.ts folds those over the lineage now, so a session-scoped answer here
 * would re-raise a finding the operator already waived the moment an epic
 * continued in a new session. "Last decision wins" is decided on the merged
 * order, which is `ts` between sessions and append order within one.
 */
export async function isWaived(
  fingerprint: string,
  ref: SessionRef,
  opts: EventOpts = {},
): Promise<boolean> {
  const events = await readLineageEvents(ref.sessionId, opts);
  let waived = false;
  for (const { record } of events) {
    const payload = record.payload as { fingerprint?: string };
    if (payload.fingerprint !== fingerprint) continue;
    if (record.event_type === 'waiver-granted') waived = true;
    else if (record.event_type === 'waiver-denied') waived = false;
  }
  return waived;
}

/**
 * Has the operator recorded ANY waiver decision for this fingerprint (granted
 * or denied)? Lineage-wide, for isWaived's reason (D-119): a decision recorded
 * in the parent session is still a decision.
 */
async function hasDecision(
  fingerprint: string,
  ref: SessionRef,
  opts: EventOpts,
): Promise<boolean> {
  const events = await readLineageEvents(ref.sessionId, opts);
  return events.some(({ record }) => {
    const payload = record.payload as { fingerprint?: string };
    return (
      payload.fingerprint === fingerprint &&
      (record.event_type === 'waiver-granted' || record.event_type === 'waiver-denied')
    );
  });
}

/**
 * Every finding sharing `fingerprint` that is still open (raised/confirmed,
 * a waivable severity) is transitioned to `waived` with `waiver_id` set to
 * the granting event's id — otherwise a granted waiver never shows up on
 * finding_status and kanban/analytics/queue consumers that trust it see the
 * finding as open forever. Findings the state machine can't legally move
 * (already terminal, or a non-S3/S4 severity that somehow shares this
 * fingerprint) are left alone; this is reconciliation, not a mandate.
 */
async function reconcileFindingsToWaived(
  fingerprint: string,
  waiverEventId: string,
  ctx: EventContext,
  opts: EventOpts,
): Promise<void> {
  const findings = await listFindings(ctx.sessionId, {}, opts);
  const reconcilable = findings.filter(
    (f) =>
      f.fingerprint === fingerprint &&
      WAIVABLE_SEVERITIES.includes(f.severity) &&
      WAIVABLE_STATUSES.includes(f.finding_status),
  );
  const transitionCtx: EventContext = { ...ctx, causalParent: waiverEventId };
  for (const finding of reconcilable) {
    await transition(finding.finding_id, 'waived', transitionCtx, opts, {
      waiverId: waiverEventId,
    });
  }
}

export async function grantWaiver(
  fingerprint: string,
  operatorNote: string,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  const waiverEvent = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: 'waiver-granted',
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: { fingerprint, operator_note: operatorNote },
    },
    opts,
  );

  await reconcileFindingsToWaived(fingerprint, waiverEvent.event_id, ctx, opts);

  return waiverEvent;
}

/**
 * The mirror of reconcileFindingsToWaived, and it exists for the same reason
 * (D-180). A denial that follows a grant revokes it — isWaived() folds
 * last-decision-wins and answers "not waived" the moment it lands — but the
 * findings that grant closed stayed at `waived` regardless: discretionary at
 * the epic gate, absent from pendingBatch because a decision exists, and
 * unreachable by `finding transition` because `waived` was terminal. The
 * operator's reversal changed nothing anyone downstream could see.
 *
 * Only findings this session's log actually shows at `waived` are touched, and
 * each goes back to the status its own grant recorded as from_status. A
 * finding waived under some other fingerprint is not this denial's business.
 */
async function reconcileFindingsFromWaived(
  fingerprint: string,
  denialEventId: string,
  ctx: EventContext,
  opts: EventOpts,
): Promise<void> {
  const findings = await listFindings(ctx.sessionId, {}, opts);
  const reopenable = findings.filter(
    (f) => f.fingerprint === fingerprint && f.finding_status === 'waived',
  );
  const transitionCtx: EventContext = { ...ctx, causalParent: denialEventId };
  for (const finding of reopenable) {
    const to = await preWaiverStatus(finding.finding_id, ctx.sessionId, opts);
    // A `waived` finding whose grant left no from_status is not something this
    // reconciliation can place, so it is left where it is: a guessed status
    // here either credits a verification that never ran or discards one that
    // did. Only transitions written before from_status existed can produce it.
    if (to === undefined) continue;
    await transition(finding.finding_id, to, transitionCtx, opts, {
      waiverRevokedBy: denialEventId,
    });
  }
}

export async function denyWaiver(
  fingerprint: string,
  operatorNote: string,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  const denialEvent = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'user',
      event_type: 'waiver-denied',
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: { fingerprint, operator_note: operatorNote },
    },
    opts,
  );

  await reconcileFindingsFromWaived(fingerprint, denialEvent.event_id, ctx, opts);

  return denialEvent;
}

/**
 * S3/S4 findings for one epic that have no waiver decision yet, grouped for
 * a single batched operator prompt (architecture §11: never re-ask). Not
 * "all S3/S4 ever raised" — a finding already granted or denied is settled
 * and never resurfaces here.
 */
export async function pendingBatch(
  epic: string,
  ref: SessionRef,
  opts: EventOpts = {},
): Promise<Finding[]> {
  const findings = await listFindings(ref.sessionId, { epic }, opts);
  const pending: Finding[] = [];
  for (const finding of findings) {
    if (!WAIVABLE_SEVERITIES.includes(finding.severity)) continue;
    if (await hasDecision(finding.fingerprint, ref, opts)) continue;
    pending.push(finding);
  }
  return pending;
}

export interface WaiverBatchDecision {
  fingerprint: string;
  decision: 'granted' | 'denied';
  operatorNote: string;
}

/**
 * Apply a batch of operator waiver answers. Validates every fingerprint
 * against a real finding in this session, AND (for `granted` decisions)
 * that every finding sharing that fingerprint sits at a waivable severity
 * (S3/S4) — all before writing anything. A batch referencing an unknown
 * fingerprint, or attempting to grant a waiver over a non-waivable
 * (S1/S2) finding, fails entirely (typed error), rather than partially
 * applying. This is a stricter, operator-facing policy check on top of
 * grantWaiver()'s own lower-level reconciliation, which — reached directly,
 * not through this batch API — still only ever moves the WAIVABLE findings
 * sharing a fingerprint to `waived` and leaves any non-waivable sibling
 * alone (see waivers.test.ts).
 *
 * Without this gate, grantWaiver() would append `waiver-granted` for a
 * fingerprint whose only finding is S2 — isWaived() folds that event
 * regardless of severity, so the operator's answer would stand on the record
 * as having settled a merge-blocking finding it was never allowed to be asked
 * about, while the finding itself stays open forever (reconcileFindingsToWaived
 * leaves non-waivable findings alone, by design). Since D-196, raiseFinding no
 * longer suppresses a re-raise at a non-waivable severity, so the damage stops
 * at the record rather than reaching the next round's gate — but a waiver that
 * settles nothing is still not a waiver, and the batch refuses to write one.
 *
 * A `granted` decision is additionally refused when the finding's evidence is
 * stale — a wave has merged over its file since it was raised or last
 * re-verified (P9-15). The operator is answering a question about code that
 * no longer exists; the remedy is `smith findings reverify`, which is named in
 * the error. Denials are allowed through: a denial closes nothing and grants
 * nothing, so blocking it would only strand the batch.
 */
export async function applyBatch(
  decisions: WaiverBatchDecision[],
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent[]> {
  const findings = await listFindings(ctx.sessionId, {}, opts);
  const findingsByFingerprint = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = findingsByFingerprint.get(f.fingerprint) ?? [];
    list.push(f);
    findingsByFingerprint.set(f.fingerprint, list);
  }
  // Computed once for the batch, and only when it can matter: a batch of pure
  // denials never reads the merge history at all.
  const stale: Map<string, StaleEvidence> = decisions.some((d) => d.decision === 'granted')
    ? await staleFindings(ctx.sessionId, opts)
    : new Map();

  for (const decision of decisions) {
    const owning = findingsByFingerprint.get(decision.fingerprint);
    if (!owning) {
      throw new WaiverError(
        'waivers.unknown-fingerprint',
        `No finding with fingerprint "${decision.fingerprint}" in session "${ctx.sessionId}".`,
        { fingerprint: decision.fingerprint },
      );
    }
    if (decision.decision === 'granted') {
      const nonWaivable = owning.filter((f) => !WAIVABLE_SEVERITIES.includes(f.severity));
      if (nonWaivable.length > 0) {
        throw new WaiverError(
          'waivers.non-waivable-severity',
          `Fingerprint "${decision.fingerprint}" has finding(s) at a non-waivable severity ` +
            `(${nonWaivable.map((f) => f.severity).join(', ')}) — only ${WAIVABLE_SEVERITIES.join('/')} findings can be waived.`,
          { fingerprint: decision.fingerprint, severities: nonWaivable.map((f) => f.severity) },
        );
      }
      for (const finding of owning) {
        const evidence = stale.get(finding.finding_id);
        if (!evidence) continue;
        throw new WaiverError(
          'waivers.stale-evidence',
          `Finding "${finding.finding_id}" is anchored to ${evidence.filePath}, which task ` +
            `"${evidence.mergedTaskId}" has merged over since the finding was raised (matched by ` +
            `${evidence.basis}: ${evidence.matched}). Its evidence describes code that no longer ` +
            'exists, so this waiver would answer a question about a deleted file. Re-read it first: ' +
            `smith findings reverify --finding ${finding.finding_id}`,
          {
            fingerprint: decision.fingerprint,
            findingId: finding.finding_id,
            filePath: evidence.filePath,
            mergedTaskId: evidence.mergedTaskId,
            basis: evidence.basis,
          },
        );
      }
    }
  }

  const results: StoredEvent[] = [];
  for (const decision of decisions) {
    if (decision.decision === 'granted') {
      results.push(await grantWaiver(decision.fingerprint, decision.operatorNote, ctx, opts));
    } else {
      results.push(await denyWaiver(decision.fingerprint, decision.operatorNote, ctx, opts));
    }
  }
  return results;
}
