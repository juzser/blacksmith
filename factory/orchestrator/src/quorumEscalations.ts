import type { StoredEvent } from './events.js';

/**
 * Which cross-provider disagreements is the operator still owed?
 *
 * D-201 fixed the half where an escalation reached the caller. It named the
 * half it did not fix: "there is still no command that lists open escalations
 * from the log. The `quorum-decision` event is written on every case ... but
 * nothing answers 'which disagreements is the operator still owed?'". The gate
 * outcome was the only surface, and a gate outcome is a moment, not a ledger --
 * it is gone by the next run. Worse, gate.ts pushes an escalation to its caller
 * only `if (hadActiveJudge)`, so a disagreement found entirely in shadow mode
 * was written to the log and reported to nobody.
 *
 * This is a fold over the log and not a projection table on purpose: every fact
 * it reports was already recorded on the event when the quorum spoke. Adding a
 * table would have meant a second copy that can disagree with the first.
 *
 * Three emitters write `quorum-decision` with three payload shapes around one
 * core -- gate.ts for a finding, epic.ts for a final verdict, planQuorum.ts for
 * a plan critique. They are told apart by the one field each carries alone:
 * `blocks`, `ready`, `sound`. Those three also mean opposite things (`blocks:
 * true` and `ready: false` both mean "this did not go through"), so they are
 * normalised into one `held`, and an escalation with `held: false` is the one
 * worth reading first: the quorum could not settle it and the pipeline went
 * ahead regardless.
 *
 * `escalation.ts` is a different ladder entirely (the budgets.yml model tier).
 * Nothing here touches it.
 */

/** The closed vocabulary quorum.ts escalates with. Anything else is a payload this fold does not understand. */
export type EscalationReason = 'disagreement' | 'insufficient-providers';

/** Which of the three emitters wrote the case. */
export type EscalationSubject = 'finding' | 'epic' | 'plan';

export interface EscalationParticipant {
  provider: string;
  mode: string;
  ok: boolean;
  verdict: string | null;
  excludedAsFinder: boolean;
}

export interface EscalationRationale {
  provider: string;
  verdict: string;
  rationale: string;
}

export interface OpenEscalation {
  /**
   * Identity of the CASE, not of the event. Two runs of the same gate mint two
   * finding ids for one defect, so keying on `finding_id` would report one
   * disagreement as two; the fingerprint is what survives a re-run. Namespaced
   * by subject so an epic verdict can never close a finding that happens to
   * share a task id.
   */
  key: string;
  subject: EscalationSubject;
  reason: EscalationReason;
  taskId: string;
  epicId: string | null;
  findingId: string | null;
  fingerprint: string | null;
  planVersion: number | null;
  triggerReason: string | null;
  finderProvider: string | null;
  /**
   * Did the escalation actually stop anything? `true` means the finding blocked,
   * the epic was held, or the plan was not endorsed. `false` means the quorum
   * failed to settle the case and the work proceeded anyway -- which is the
   * shadow-mode case, and the one the operator most needs to see.
   */
  held: boolean | null;
  participants: readonly EscalationParticipant[];
  rationales: readonly EscalationRationale[];
  ts: string;
  sessionId: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function subjectOf(payload: Record<string, unknown>): EscalationSubject {
  // The boolean each emitter alone writes is the primary discriminator: it is
  // always present, where `fingerprint` and `plan_version` are only usually so.
  if ('blocks' in payload) return 'finding';
  if ('sound' in payload) return 'plan';
  if ('ready' in payload) return 'epic';
  if (str(payload.fingerprint)) return 'finding';
  if (typeof payload.plan_version === 'number') return 'plan';
  return 'epic';
}

function heldOf(subject: EscalationSubject, payload: Record<string, unknown>): boolean | null {
  if (subject === 'finding') return bool(payload.blocks);
  const ready = subject === 'epic' ? bool(payload.ready) : bool(payload.sound);
  return ready === null ? null : !ready;
}

function reasonOf(payload: Record<string, unknown>, taskId: string): EscalationReason {
  const raw = payload.escalation_reason;
  if (raw === 'disagreement' || raw === 'insufficient-providers') return raw;
  if (raw === null || raw === undefined) {
    throw new Error(
      `quorum-escalations.missing-reason: an escalate outcome on "${taskId}" carries no escalation_reason`,
    );
  }
  throw new Error(
    `quorum-escalations.unknown-reason: "${String(raw)}" on "${taskId}" is not one of disagreement, insufficient-providers`,
  );
}

function participantsOf(payload: Record<string, unknown>): EscalationParticipant[] {
  const raw = payload.participants;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const r = (p ?? {}) as Record<string, unknown>;
    return {
      provider: str(r.provider) ?? '(unnamed)',
      mode: str(r.mode) ?? '(unknown)',
      ok: r.ok === true,
      verdict: str(r.verdict),
      excludedAsFinder: r.excluded_as_finder === true,
    };
  });
}

function rationalesOf(payload: Record<string, unknown>): EscalationRationale[] {
  const raw = payload.rationales;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const r = (p ?? {}) as Record<string, unknown>;
    return {
      provider: str(r.provider) ?? '(unnamed)',
      verdict: str(r.verdict) ?? '(none)',
      rationale: str(r.rationale) ?? '',
    };
  });
}

/**
 * The cases whose LATEST word was `escalate`.
 *
 * Latest in log order, not first: a case settled on a later run is closed, and
 * a case that escalated again after being settled is open again. `not-run` --
 * planQuorum's "no quorum was called at all" -- closes a case exactly like
 * `decided` does; there is nothing outstanding about a quorum nobody needed.
 *
 * Oldest first, because the list is a debt and the oldest debt is the one that
 * has been ignored longest.
 */
export function openQuorumEscalations(events: readonly StoredEvent[]): OpenEscalation[] {
  const latest = new Map<string, OpenEscalation | null>();

  for (const { record } of events) {
    if (record.event_type !== 'quorum-decision') continue;
    const payload = record.payload;
    const subject = subjectOf(payload);
    const taskId = str(payload.task_id) ?? str(record.task_id) ?? '(no task)';
    const fingerprint = str(payload.fingerprint);
    const key = `${subject}:${subject === 'finding' ? (fingerprint ?? taskId) : taskId}`;

    if (payload.outcome !== 'escalate') {
      latest.set(key, null);
      continue;
    }

    latest.set(key, {
      key,
      subject,
      reason: reasonOf(payload, taskId),
      taskId,
      epicId: str(payload.epic_id),
      findingId: str(payload.finding_id),
      fingerprint,
      planVersion: typeof payload.plan_version === 'number' ? payload.plan_version : null,
      triggerReason: str(payload.trigger_reason),
      finderProvider: str(payload.finder_provider),
      held: heldOf(subject, payload),
      participants: participantsOf(payload),
      rationales: rationalesOf(payload),
      ts: record.ts,
      sessionId: record.session_id,
    });
  }

  const open: OpenEscalation[] = [];
  for (const entry of latest.values()) if (entry) open.push(entry);
  return open.sort((a, b) =>
    a.ts === b.ts ? a.key.localeCompare(b.key) : a.ts.localeCompare(b.ts),
  );
}

export interface EscalationSummary {
  /** One entry per case a person has to read: two providers looked and disagreed. */
  disagreements: readonly OpenEscalation[];
  /**
   * Cases where no quorum could be formed at all. Collapsed to a count on
   * purpose: this is ONE fact about `crosscheck.yml` repeated once per finding,
   * and listing it as a per-finding backlog buries the disagreements that are
   * actually about the code. The cases are kept so nothing is hidden, but the
   * count and the hint are the part meant to be read.
   */
  ungated: {
    count: number;
    hint: string | null;
    cases: readonly OpenEscalation[];
  };
  /**
   * 0 nothing open, 1 a disagreement is open, 2 no disagreement but something
   * was never cross-checked. 2 exists because 0 would be a false green: with
   * `min_providers: 2` and one active external, every finding escalates as
   * `insufficient-providers` and the gate decides nothing -- a command that
   * answered "clean" there would be reporting the absence of a check as the
   * absence of a problem.
   */
  exitCode: 0 | 1 | 2;
}

const UNGATED_HINT =
  "No quorum could be formed: the gating pool was smaller than crosscheck.yml's " +
  '`quorum.min_providers`. The finder is excluded from its own case, so one active ' +
  'external provider leaves a pool of one. Enable a second external provider, or ' +
  'lower `min_providers` and accept that a single judge decides.';

/** Split the debt by what answering it costs: a review each, or one edit for all of them. */
export function summariseEscalations(open: readonly OpenEscalation[]): EscalationSummary {
  const disagreements = open.filter((e) => e.reason === 'disagreement');
  const ungated = open.filter((e) => e.reason === 'insufficient-providers');
  const exitCode: 0 | 1 | 2 = disagreements.length > 0 ? 1 : ungated.length > 0 ? 2 : 0;
  return {
    disagreements,
    ungated: {
      count: ungated.length,
      hint: ungated.length > 0 ? UNGATED_HINT : null,
      cases: ungated,
    },
    exitCode,
  };
}
