// Asymmetric-roles audit (P9-23), the after-the-fact half of
// crosscheck.yml's `asymmetric_roles.finder_ne_critic`.
//
// The rule has been in the role templates since Phase 1 — spec-reviewer
// "never runs on the planner's own model", verifier "never runs on the
// reviewer's own model" — and it was prose the whole time. Nothing read it,
// nothing checked it, and the event log couldn't have answered the question
// even if something had: `dispatch_decision` recorded `model_tier`, and opus
// and fable are both `frontier`. So "did the critic run on the finder's own
// model?" was unanswerable from the record, which is the same class of gap as
// the missing no-op quorum event in planQuorum.ts: an unrecorded check and a
// check that never ran look identical afterwards.
//
// Two changes make this module possible: dispatch_decision now carries the
// concrete `model` (events.ts PAYLOAD_DIMENSION_MAP, required and
// presence-only), and crosscheck.yml names the pairs (asymmetric_roles.pairs)
// instead of only asserting that pairs exist.
//
// Fail-closed by construction. `unverifiable` — a critic dispatch with no
// model, or with no finder dispatch before it to compare against — fails the
// report exactly like a `violation` does. "I cannot tell" that exits 0 is
// indistinguishable from "it held", and this whole module exists because that
// confusion is expensive. `not-applicable` (the critic never ran in this
// session) is stated per pair rather than silently dropped, so an empty check
// set can never be mistaken for a clean one.
//
// The domain is critic WORK, not critic dispatches (D-124). Fail-closed
// within a domain is worth nothing at the edge of it: `smith epic
// spec-review` writes `spec-review-recorded` and no dispatch record, so a
// closing review nobody dispatched was not `unverifiable` here — it was
// invisible, and the planner/spec-reviewer pair read `not-applicable`, which
// counts as ok. CRITIC_WORK_EVENTS below is that edge written down. Every
// event type on it is critic work that can reach the log without a
// dispatch_decision, and each such record must be answered for by a dispatch
// of the same role or it fails the report. Enumerating the domain is not
// documentation for a fail-closed check; it is the check.
import type { AsymmetricRolePair } from './crosscheck.js';
import { eventTaskId, type StoredEvent } from './events.js';
import { taskIdsMatch } from './taskId.js';

/** One `dispatch_decision` event, flattened to the fields the audit needs. */
export interface DispatchRecord {
  eventId: string;
  ts: string;
  taskId: string | null;
  role: string;
  provider: string;
  /** null for events written before `model` became a required dimension. */
  model: string | null;
  modelTier: string | null;
}

/**
 * Critic work that reaches the event log without a `dispatch_decision`.
 *
 * `key` is the payload field naming the role that did the work, and `label`
 * is how the operator hears it in a detail line. Adding an entry widens the
 * audit's domain; leaving one off is how D-124 happened, so a new event type
 * that records a critic's output belongs here at the moment it is written.
 */
const CRITIC_WORK_EVENTS: Record<string, { key: string; label: string }> = {
  'spec-review-recorded': { key: 'reviewed_by', label: 'spec review' },
};

/** One critic-work event, flattened the way DispatchRecord flattens a dispatch. */
export interface CriticWorkRecord {
  eventId: string;
  ts: string;
  taskId: string | null;
  role: string;
  /** What the operator is told this record is, e.g. "spec review". */
  label: string;
}

export type DispatchCheckStatus = 'ok' | 'violation' | 'unverifiable' | 'not-applicable';

export interface DispatchAsymmetryCheck {
  finder: string;
  critic: string;
  status: DispatchCheckStatus;
  /** The critic dispatch this check is about; null when the critic never ran. */
  criticEventId: string | null;
  criticModel: string | null;
  /** The finder dispatch it was compared against; null when none preceded it. */
  finderEventId: string | null;
  finderModel: string | null;
  /** Why this status, in the words the operator sees. */
  detail: string;
}

export interface DispatchAsymmetryReport {
  sessionId: string;
  taskId: string | null;
  dispatchesExamined: number;
  /**
   * Critic-work records in scope (CRITIC_WORK_EVENTS), counted apart from the
   * dispatches so neither number overstates what it read. A pair that raises
   * no check and a domain that held nothing to check are different answers.
   */
  criticWorkExamined: number;
  checks: DispatchAsymmetryCheck[];
  /** False on any violation OR any unverifiable — see the module header. */
  ok: boolean;
}

export interface DispatchAsymmetryOptions {
  sessionId: string;
  /** Scope to one task; dispatches for other tasks then answer for nothing. */
  taskId?: string;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether two task scopes can answer for each other.
 *
 * They disagree only when both are named and differ. A dispatch with no task
 * id answers for anything: pre-task-id history is on disk and unrewritable,
 * and refusing it would turn every one of those runs into a wall of false
 * alarms rather than a finding anyone can act on.
 *
 * D-181: "differ" is taskIdsMatch's question, not `===`'s. The log writes one
 * task both qualified and bare, so a raw comparison here un-pairs a critic
 * from the very finder it ran against whenever the two dispatches were
 * spelled differently -- and the report says `unverifiable` about a pair it
 * holds both halves of. taskIdsMatch keeps this function's own guarantee: two
 * DIFFERENT qualified ids stay different tasks even when their bare halves
 * collide, which is the whole point of scoping the finder search.
 */
function scopesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || taskIdsMatch(a, b);
}

/**
 * Flatten a session's events down to its dispatch records, in log order.
 *
 * Pre-P9-23 events are kept with `model: null` rather than filtered out.
 * They are on disk and are never rewritten (the log is append-only), and
 * dropping them would turn "this dispatch cannot be checked" into "no such
 * dispatch happened" — the report would look emptier and cleaner than the
 * history it describes.
 */
export function readDispatchRecords(events: readonly StoredEvent[]): DispatchRecord[] {
  const records: DispatchRecord[] = [];
  for (const stored of events) {
    const record = stored.record;
    if (record.event_type !== 'dispatch_decision') continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const role = payloadString(payload, 'agent_role');
    if (!role) continue;
    records.push({
      eventId: stored.event_id,
      ts: record.ts ?? '',
      taskId: eventTaskId(record),
      role,
      provider: payloadString(payload, 'provider') ?? '',
      model: payloadString(payload, 'model'),
      modelTier: payloadString(payload, 'model_tier'),
    });
  }
  return records;
}

/**
 * Flatten a session's events down to its critic-work records, in log order.
 *
 * The mirror of readDispatchRecords for the other route into the log. A
 * record here is a claim that a critic role produced something; it carries no
 * model, because no dispatch chose one, which is exactly why an uncovered
 * record can only ever be `unverifiable`.
 */
export function readCriticWorkRecords(events: readonly StoredEvent[]): CriticWorkRecord[] {
  const records: CriticWorkRecord[] = [];
  for (const stored of events) {
    const record = stored.record;
    const spec = CRITIC_WORK_EVENTS[record.event_type];
    if (!spec) continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const role = payloadString(payload, spec.key);
    if (!role) continue;
    records.push({
      eventId: stored.event_id,
      ts: record.ts ?? '',
      taskId: eventTaskId(record),
      role,
      label: spec.label,
    });
  }
  return records;
}

/**
 * The critic-work records no dispatch of that role can answer for.
 *
 * A record is covered when a dispatch of the same role falls in the window
 * (previous record of that role, this record] — since the last time this
 * critic recorded something, and no later than the record itself.
 *
 * The window is the whole check. Treating dispatches as fungible tokens —
 * five spec-reviewer dispatches, so the next five recorded reviews are fine —
 * is exactly the laundering `precedingFinder` refuses on the finder side, and
 * it is not hypothetical: dogfood-mcp-1 dispatched five spec-reviewers across
 * two days and then recorded two more reviews by hand three days later, which
 * a fungible count would have passed. A dispatch that predates the previous
 * record already answered for that one; it cannot answer twice.
 */
function uncoveredCriticWork(
  work: readonly CriticWorkRecord[],
  dispatches: readonly DispatchRecord[],
): CriticWorkRecord[] {
  const uncovered: CriticWorkRecord[] = [];
  let since = '';
  for (const record of [...work].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (!dispatches.some((d) => d.ts > since && d.ts <= record.ts)) uncovered.push(record);
    since = record.ts;
  }
  return uncovered;
}

/**
 * The finder dispatch a given critic dispatch was reviewing: the latest one
 * at or before the critic's timestamp, on the critic's own task.
 *
 * "At or before" is the whole point. A later re-plan on a different model
 * cannot retroactively make an earlier review adversarial, and comparing a
 * critic against the newest finder dispatch in the session would let exactly
 * that launder a violation into a pass.
 *
 * The task axis is the same argument on the other coordinate, and it is not
 * hypothetical: on dogfood-mcp-1 four `integration` verifiers were answered
 * for by a task-4 reviewer dispatched three days earlier, on a task with no
 * reviewer dispatch of its own anywhere in the log. Different code, different
 * finding, reported ok. Evidence about one task vouches for nothing about
 * another (D-172).
 */
function precedingFinder(
  finders: readonly DispatchRecord[],
  critic: DispatchRecord,
): DispatchRecord | null {
  let best: DispatchRecord | null = null;
  for (const finder of finders) {
    if (finder.ts > critic.ts) continue;
    if (!scopesAgree(finder.taskId, critic.taskId)) continue;
    if (!best || finder.ts >= best.ts) best = finder;
  }
  return best;
}

function checkOneCritic(
  pair: AsymmetricRolePair,
  critic: DispatchRecord,
  finders: readonly DispatchRecord[],
): DispatchAsymmetryCheck {
  const finder = precedingFinder(finders, critic);
  const base = {
    finder: pair.finder,
    critic: pair.critic,
    criticEventId: critic.eventId,
    criticModel: critic.model,
    finderEventId: finder?.eventId ?? null,
    finderModel: finder?.model ?? null,
  };

  if (!finder) {
    return {
      ...base,
      status: 'unverifiable',
      detail: `${pair.critic} ran at ${critic.ts}${
        critic.taskId ? ` on ${critic.taskId}` : ''
      } with no preceding ${pair.finder} dispatch to compare against.`,
    };
  }
  if (!critic.model || !finder.model) {
    const missing = !critic.model ? pair.critic : pair.finder;
    return {
      ...base,
      status: 'unverifiable',
      detail: `The ${missing} dispatch records no model, so finder_ne_critic cannot be evaluated.`,
    };
  }
  if (critic.model === finder.model) {
    return {
      ...base,
      status: 'violation',
      detail: `${pair.critic} ran on ${critic.model}, the same model as the ${pair.finder} dispatch it followed.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    detail: `${pair.critic} ran on ${critic.model}; ${pair.finder} ran on ${finder.model}.`,
  };
}

/**
 * Assert crosscheck.yml's finder_ne_critic against what the log actually
 * records. Every critic dispatch is checked, not just the last one: a session
 * that got it wrong once and right afterwards did get it wrong once.
 */
export function checkDispatchAsymmetry(
  events: readonly StoredEvent[],
  pairs: readonly AsymmetricRolePair[],
  options: DispatchAsymmetryOptions,
): DispatchAsymmetryReport {
  const taskId = options.taskId ?? null;
  const all = readDispatchRecords(events);
  // D-181: `--task` is answered across both spellings of the id. The log
  // writes one task both qualified and bare, so a raw `===` here answered the
  // operator with the subset that happened to be spelled their way — and a
  // dropped critic dispatch reads as a critic that never ran.
  const inScope = (scope: string) => (r: { taskId: string | null }) =>
    r.taskId !== null && taskIdsMatch(r.taskId, scope);
  const records = taskId ? all.filter(inScope(taskId)) : all;
  const allWork = readCriticWorkRecords(events);
  const criticWork = taskId ? allWork.filter(inScope(taskId)) : allWork;

  // A policy that declares no pairs cannot be satisfied OR violated, and
  // reporting that as a pass would advertise an audit nobody configured.
  if (pairs.length === 0) {
    return {
      sessionId: options.sessionId,
      taskId,
      dispatchesExamined: records.length,
      criticWorkExamined: criticWork.length,
      checks: [
        {
          finder: '*',
          critic: '*',
          status: 'unverifiable',
          criticEventId: null,
          criticModel: null,
          finderEventId: null,
          finderModel: null,
          detail:
            'crosscheck.yml declares no asymmetric_roles.pairs, so finder_ne_critic asserts nothing.',
        },
      ],
      ok: false,
    };
  }

  const checks: DispatchAsymmetryCheck[] = [];
  for (const pair of pairs) {
    const critics = records.filter((r) => r.role === pair.critic);
    const work = criticWork.filter((r) => r.role === pair.critic);
    if (critics.length === 0 && work.length === 0) {
      checks.push({
        finder: pair.finder,
        critic: pair.critic,
        status: 'not-applicable',
        criticEventId: null,
        criticModel: null,
        finderEventId: null,
        finderModel: null,
        detail: `No ${pair.critic} dispatch in scope; the pair had nothing to check.`,
      });
      continue;
    }
    const finders = records.filter((r) => r.role === pair.finder);
    for (const critic of critics) {
      checks.push(checkOneCritic(pair, critic, finders));
    }
    for (const record of uncoveredCriticWork(work, critics)) {
      checks.push({
        finder: pair.finder,
        critic: pair.critic,
        status: 'unverifiable',
        criticEventId: record.eventId,
        criticModel: null,
        finderEventId: null,
        finderModel: null,
        detail: `${pair.critic} recorded a ${record.label} at ${record.ts} with no ${pair.critic} dispatch behind it, so no model is on record and finder_ne_critic cannot be evaluated.`,
      });
    }
  }

  return {
    sessionId: options.sessionId,
    taskId,
    dispatchesExamined: records.length,
    criticWorkExamined: criticWork.length,
    checks,
    ok: checks.every((c) => c.status === 'ok' || c.status === 'not-applicable'),
  };
}
