// Escalation-ladder audit (P9-32), the after-the-fact half of budgets.yml's
// `escalation_ladder`.
//
// The ladder has been policy since Phase 1 — "2 failed rounds -> escalate the
// model tier, 3 -> escalate to the operator, rungs are never skipped and never
// looped past their bound" — and budgets.ts said in its own header that
// nothing parsed it. So a task could fail four rounds on the same tier with
// the operator never told, and the log would be indistinguishable from a task
// that climbed the ladder correctly. Same shape of gap as P9-23's
// finder_ne_critic: a rule written down, honoured by habit, checkable by
// nobody.
//
// Built on dispatchAudit.ts's pattern deliberately: a pure module over
// `readonly StoredEvent[]`, four-valued statuses, and fail-closed —
// `unverifiable` fails the report exactly like `violation`, because "I cannot
// tell" that exits 0 is indistinguishable from "it held". `not-applicable` is
// stated per rung rather than dropped, so an empty check set can never be
// mistaken for a clean one.
//
// What this module does NOT claim. Rung 3's obligation is "escalate to the
// operator", and the log has no event for the handoff itself — nothing writes
// "the operator was told". So the rung-3 check asserts the BOUND, not the
// notification: after the third failed round the factory must stop working the
// task until an operator answer appears in the log. A task that simply stopped
// passes, and the detail string says exactly that much and no more. Closing the
// remaining half needs a new event type, which is a taxonomy version bump and
// an architecture §8 edit — deliberately not folded in here.
//
// "The task ran again" is read from two independent traces, because either can
// be missing: a builder `dispatch_decision`, and a `gate-outcome` for the next
// round. The dogfood session has the second without the first, and reading only
// dispatches there would have reported a task that plainly retried as one that
// never did.
import type { EscalationRung } from './budgets.js';
import { eventTaskId, type StoredEvent } from './events.js';
import { bareTaskId, epicOfTaskId, isQualifiedTaskId, taskIdsMatch } from './taskId.js';

/**
 * Roles whose dispatch constitutes a new round on the task.
 *
 * The split follows budgets.yml: `task.judges` names spec-reviewer, reviewer,
 * verifier and grader, and `context_window.narrowing_roles` adds
 * security-reviewer and merger — those roles read a diff, they do not produce
 * the one the gate scores. planner/researcher/scribe produce no task diff
 * either. What is left is what a "round" means: someone built again.
 */
export const BUILDER_ROLES: readonly string[] = Object.freeze(['coder', 'tester', 'uiux']);

/** taxonomy.yml `model_tier`, ordered by capability. */
const TIER_RANK: Readonly<Record<string, number>> = Object.freeze({
  small: 0,
  mid: 1,
  frontier: 2,
});

const TOP_TIER = 'frontier';

/** Event types that record the operator having answered (see rung 3). */
const OPERATOR_ANSWER_EVENTS: readonly string[] = Object.freeze([
  'user_prompt',
  'waiver-granted',
  'waiver-denied',
]);

export type EscalationCheckStatus = 'ok' | 'violation' | 'unverifiable' | 'not-applicable';

/** One `gate-outcome` event, whatever the outcome was. */
export interface GateRound {
  eventId: string;
  ts: string;
  /** null when the event carries no task id — see checkEscalationLadder. */
  taskId: string | null;
  outcome: string | null;
  reason: string | null;
}

/** A `GateRound` whose outcome was `blocked`. */
export type FailedRound = GateRound;

/** One builder `dispatch_decision`, flattened to what the ladder needs. */
export interface BuilderDispatch {
  eventId: string;
  ts: string;
  taskId: string | null;
  role: string;
  modelTier: string | null;
}

export interface EscalationCheck {
  /** '*' on a check that answers for the policy or the log, not a task. */
  taskId: string;
  rung: number;
  /** The rung's threshold, from the policy; null when it declares none. */
  triggerRounds: number | null;
  /** How many rounds this task failed in scope. */
  failedRounds: number;
  status: EscalationCheckStatus;
  /** The blocked round that tripped the rung; null when none did. */
  triggerEventId: string | null;
  /** Why this status, in the words the operator sees. */
  detail: string;
}

export interface EscalationReport {
  sessionId: string;
  taskId: string | null;
  /** Failed rounds examined, across every task in scope. */
  roundsExamined: number;
  checks: EscalationCheck[];
  /** False on any violation OR any unverifiable — see the module header. */
  ok: boolean;
}

export interface EscalationOptions {
  sessionId: string;
  /** Scope to one task; other tasks' rounds then answer for nothing. */
  taskId?: string;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function payloadOf(stored: StoredEvent): Record<string, unknown> {
  return (stored.record.payload ?? {}) as Record<string, unknown>;
}

/**
 * Every `gate-outcome` in the log, in order — gate.ts's terminal event per
 * round, whatever it decided.
 *
 * The passes matter as much as the blocks. A gate outcome after a failed round
 * is proof the task ran again, and it is proof the log keeps even when the
 * dispatch that caused it went unrecorded — which is exactly the case the
 * dogfood session is in. See checkModelTierRung.
 */
export function readGateRounds(events: readonly StoredEvent[]): GateRound[] {
  const rounds: GateRound[] = [];
  for (const stored of events) {
    const record = stored.record;
    if (record.event_type !== 'gate-outcome') continue;
    const payload = payloadOf(stored);
    rounds.push({
      eventId: stored.event_id,
      ts: record.ts ?? '',
      taskId: eventTaskId(record),
      outcome: payloadString(payload, 'outcome'),
      reason: payloadString(payload, 'reason'),
    });
  }
  return rounds;
}

/**
 * A session's failed rounds, in log order.
 *
 * A failed round is one `gate-outcome` with outcome `blocked`. Passes are not
 * rounds, and neither is a gate that never reached an outcome — an unrecorded
 * gate run and a clean one look the same here, which is why gate.ts emits the
 * event unconditionally.
 */
export function readFailedRounds(events: readonly StoredEvent[]): FailedRound[] {
  return readGateRounds(events).filter((round) => round.outcome === 'blocked');
}

/** A session's builder dispatches, in log order. Judges are not rounds. */
export function readBuilderDispatches(events: readonly StoredEvent[]): BuilderDispatch[] {
  const dispatches: BuilderDispatch[] = [];
  for (const stored of events) {
    const record = stored.record;
    if (record.event_type !== 'dispatch_decision') continue;
    const payload = payloadOf(stored);
    const role = payloadString(payload, 'agent_role');
    if (!role || !BUILDER_ROLES.includes(role)) continue;
    dispatches.push({
      eventId: stored.event_id,
      ts: record.ts ?? '',
      // Both levels (D-245): a dispatch whose task id is only in its payload
      // scopes out of `--task`, and the ladder then reports `unverifiable`
      // for a task the log holds every round of.
      taskId: eventTaskId(record),
      role,
      modelTier: payloadString(payload, 'model_tier'),
    });
  }
  return dispatches;
}

/**
 * The rung a given failure count puts a task on: the highest rung whose
 * threshold it has reached, or null below the first one. Rungs with no
 * numeric threshold are not reachable by counting and are skipped here — the
 * audit reports them separately rather than guessing where they sit.
 */
export function escalationRungFor(
  failedRounds: number,
  ladder: readonly EscalationRung[],
): EscalationRung | null {
  let reached: EscalationRung | null = null;
  for (const rung of ladder) {
    if (rung.failedRounds === null) continue;
    if (failedRounds < rung.failedRounds) continue;
    if (!reached || rung.failedRounds >= (reached.failedRounds ?? -1)) reached = rung;
  }
  return reached;
}

/** The last builder dispatch at or before `ts`; null when none preceded it. */
function dispatchBefore(
  dispatches: readonly BuilderDispatch[],
  ts: string,
): BuilderDispatch | null {
  let best: BuilderDispatch | null = null;
  for (const d of dispatches) {
    if (d.ts > ts) continue;
    if (!best || d.ts >= best.ts) best = d;
  }
  return best;
}

/** The first builder dispatch strictly after `ts`. */
function dispatchAfter(dispatches: readonly BuilderDispatch[], ts: string): BuilderDispatch | null {
  let best: BuilderDispatch | null = null;
  for (const d of dispatches) {
    if (d.ts <= ts) continue;
    if (!best || d.ts < best.ts) best = d;
  }
  return best;
}

/** The first gate outcome strictly after `ts` — the task demonstrably ran again. */
function gateRoundAfter(rounds: readonly GateRound[], ts: string): GateRound | null {
  let best: GateRound | null = null;
  for (const r of rounds) {
    if (r.ts <= ts) continue;
    if (!best || r.ts < best.ts) best = r;
  }
  return best;
}

function checkModelTierRung(
  base: Omit<EscalationCheck, 'status' | 'detail'>,
  trigger: FailedRound,
  dispatches: readonly BuilderDispatch[],
  gateRounds: readonly GateRound[],
): EscalationCheck {
  const failing = dispatchBefore(dispatches, trigger.ts);
  const retry = dispatchAfter(dispatches, trigger.ts);

  if (!retry) {
    // Two different facts hide behind "no dispatch after the trigger". If the
    // task was gated again, it plainly ran again and the log simply failed to
    // record on what tier; calling that "never exercised" would turn a hole in
    // the record into a clean bill of health. This is not hypothetical —
    // dogfood-envkit-1's task-1b-parse-quotes blocked twice, then passed, with
    // no dispatch_decision event anywhere for the task.
    const resumed = gateRoundAfter(gateRounds, trigger.ts);
    if (resumed) {
      return {
        ...base,
        status: 'unverifiable',
        detail: `The task was gated again at ${resumed.ts} after ${base.failedRounds} failed rounds, but no builder dispatch is recorded for that round, so the tier it ran on is unknown.`,
      };
    }
    return {
      ...base,
      status: 'not-applicable',
      detail: `${base.failedRounds} failed rounds, and the task neither was dispatched again nor reached the gate again — the tier rung was never exercised.`,
    };
  }
  if (!failing) {
    return {
      ...base,
      status: 'unverifiable',
      detail: `No builder dispatch precedes the failed round at ${trigger.ts}, so there is no tier for the retry to be higher than.`,
    };
  }
  if (!failing.modelTier || !retry.modelTier) {
    const which = failing.modelTier ? 'retry' : 'failing';
    return {
      ...base,
      status: 'unverifiable',
      detail: `The ${which} dispatch records no model_tier, so the tier escalation cannot be evaluated.`,
    };
  }

  const from = TIER_RANK[failing.modelTier];
  const to = TIER_RANK[retry.modelTier];
  if (from === undefined || to === undefined) {
    const unknown = from === undefined ? failing.modelTier : retry.modelTier;
    return {
      ...base,
      status: 'unverifiable',
      detail: `model_tier "${unknown}" is not in taxonomy.yml's model_tier, so the tiers cannot be ordered.`,
    };
  }
  if (to > from) {
    return {
      ...base,
      status: 'ok',
      detail: `Retried on ${retry.modelTier} after failing on ${failing.modelTier}.`,
    };
  }
  if (failing.modelTier === TOP_TIER) {
    return {
      ...base,
      status: 'not-applicable',
      detail: `The failing round already ran on ${TOP_TIER}; the tier rung has no higher tier to move to, and the ladder's remaining answer is the operator rung.`,
    };
  }
  return {
    ...base,
    status: 'violation',
    detail: `Retried on ${retry.modelTier} after failing on ${failing.modelTier} — the ladder requires a strictly higher tier at this rung.`,
  };
}

function checkOperatorRung(
  base: Omit<EscalationCheck, 'status' | 'detail'>,
  trigger: FailedRound,
  dispatches: readonly BuilderDispatch[],
  gateRounds: readonly GateRound[],
  operatorAnswers: readonly string[],
): EscalationCheck {
  // Either kind of event proves the factory carried on: a builder dispatch, or
  // a gate outcome for a round whose dispatch went unrecorded. The bound is
  // breached by the work continuing, not by which event happened to capture it,
  // so take whichever came first.
  const retry = dispatchAfter(dispatches, trigger.ts);
  const resumed = gateRoundAfter(gateRounds, trigger.ts);
  const carriedOn =
    retry && resumed ? (retry.ts <= resumed.ts ? retry : resumed) : (retry ?? resumed);

  if (!carriedOn) {
    return {
      ...base,
      status: 'ok',
      detail: `${base.failedRounds} failed rounds and nothing after them — the bound held. The log records no operator-handoff event, so this check asserts the bound, not the notification.`,
    };
  }
  const evidence =
    carriedOn === retry ? `Dispatched again at ${carriedOn.ts}` : `Gated again at ${carriedOn.ts}`;
  if (operatorAnswers.some((ts) => ts > trigger.ts && ts < carriedOn.ts)) {
    return {
      ...base,
      status: 'ok',
      detail: `The operator answered between the failed round at ${trigger.ts} and the next round at ${carriedOn.ts}.`,
    };
  }
  return {
    ...base,
    status: 'violation',
    detail: `${evidence} after ${base.failedRounds} failed rounds with no operator answer in between — the ladder was looped past its bound (coordination.livelock).`,
  };
}

function checkOneRung(
  taskId: string,
  rung: EscalationRung,
  rounds: readonly FailedRound[],
  dispatches: readonly BuilderDispatch[],
  gateRounds: readonly GateRound[],
  operatorAnswers: readonly string[],
): EscalationCheck | null {
  const failedRounds = rounds.length;
  const base = {
    taskId,
    rung: rung.rung,
    triggerRounds: rung.failedRounds,
    failedRounds,
    triggerEventId: null as string | null,
  };

  if (rung.failedRounds === null) {
    return {
      ...base,
      status: 'unverifiable',
      detail: `Rung ${rung.rung} declares no numeric failed_rounds, so nothing can tell whether it tripped.`,
    };
  }
  if (failedRounds < rung.failedRounds) return null;

  const trigger = rounds[rung.failedRounds - 1];
  if (!trigger) return null;
  const withTrigger = { ...base, triggerEventId: trigger.eventId };

  if (rung.action === null) {
    return {
      ...withTrigger,
      status: 'not-applicable',
      detail: `Rung ${rung.rung} declares no action (${rung.trigger || 'no trigger recorded'}); there is nothing for the log to evidence.`,
    };
  }
  if (rung.enforce === null) {
    return {
      ...withTrigger,
      status: 'unverifiable',
      detail: `Rung ${rung.rung} declares the action "${rung.action}" with no enforce keyword, so the audit cannot check it.`,
    };
  }
  if (rung.enforce === 'model-tier') {
    return checkModelTierRung(withTrigger, trigger, dispatches, gateRounds);
  }
  if (rung.enforce === 'operator') {
    return checkOperatorRung(withTrigger, trigger, dispatches, gateRounds, operatorAnswers);
  }
  return {
    ...withTrigger,
    status: 'unverifiable',
    detail: `Rung ${rung.rung} declares enforce: "${rung.enforce}", which this audit does not implement.`,
  };
}

/**
 * Assert budgets.yml's escalation ladder against what the log actually
 * records. Every rung a task reached is checked, not just the highest one: a
 * task that skipped the tier rung and later reached the operator did skip the
 * tier rung, and the ladder's own note calls that a coordination error.
 */
export function checkEscalationLadder(
  events: readonly StoredEvent[],
  ladder: readonly EscalationRung[],
  options: EscalationOptions,
): EscalationReport {
  const scopedTask = options.taskId ?? null;
  // D-181: an operator who types either spelling of a task id means the same
  // task, and taskIdsMatch already owns that rule — including its limit, that
  // two DIFFERENT qualified ids stay different tasks even when their bare
  // halves collide. Raw `===` here answered `--task epic-1/task-2` with the
  // subset of rounds that happened to be logged qualified.
  const inScope = (taskId: string | null) =>
    scopedTask === null || (taskId !== null && taskIdsMatch(taskId, scopedTask));

  const allGateRounds = readGateRounds(events).filter((r) => inScope(r.taskId));
  const allRounds = allGateRounds.filter((r) => r.outcome === 'blocked');
  const allBuilderDispatches = readBuilderDispatches(events);
  const dispatches = allBuilderDispatches.filter((d) => inScope(d.taskId));
  const operatorAnswers = events
    .filter((e) => OPERATOR_ANSWER_EVENTS.includes(e.record.event_type))
    .filter((e) => e.record.event_type === 'user_prompt' || inScope(eventTaskId(e.record)))
    .map((e) => e.record.ts ?? '');

  const report = (checks: EscalationCheck[]): EscalationReport => ({
    sessionId: options.sessionId,
    taskId: scopedTask,
    roundsExamined: allRounds.length,
    checks,
    ok: checks.every((c) => c.status === 'ok' || c.status === 'not-applicable'),
  });

  // A ladder with no rungs cannot be satisfied OR violated, and reporting that
  // as a pass would advertise an audit nobody configured.
  if (ladder.length === 0) {
    return report([
      {
        taskId: '*',
        rung: 0,
        triggerRounds: null,
        failedRounds: allRounds.length,
        status: 'unverifiable',
        triggerEventId: null,
        detail: 'budgets.yml declares no escalation_ladder.rungs, so the ladder asserts nothing.',
      },
    ]);
  }

  const checks: EscalationCheck[] = [];

  // Rounds with no task id can't join any task's ladder. They are a defect in
  // the record — gate.ts always passes a task id — and dropping them would
  // shrink the audit to fit the damage.
  const orphans = allRounds.filter((r) => r.taskId === null);
  if (orphans.length > 0) {
    checks.push({
      taskId: '*',
      rung: 0,
      triggerRounds: null,
      failedRounds: orphans.length,
      status: 'unverifiable',
      triggerEventId: orphans[0]?.eventId ?? null,
      detail: `${orphans.length} blocked gate-outcome event(s) carry no task id, so they cannot be counted against any task's ladder.`,
    });
  }

  // D-249: the same rule as the rounds above, for the other half of the
  // evidence. A dispatch with no task id was dropped per task by
  // `d.taskId !== null` below and counted nowhere, and the two losses do not
  // cost the same. A round the audit loses is a round it cannot judge; a
  // dispatch it loses is the retry a rung is judged BY, so the answer does not
  // weaken, it inverts: the rung reads "the task neither was dispatched again
  // nor reached the gate again", which is `not-applicable`, which counts as
  // OK. A ladder skipped on the same tier then exits 0.
  //
  // Read from the unscoped list on purpose. `inScope` drops a null task id
  // before any task sees it, so under `--task` the one question being asked
  // would be answered from a set the audit already knows is short.
  //
  // Builder roles only (readBuilderDispatches). A planner, a spec-reviewer and
  // a scribe are dispatched for the epic and never carried a task id; naming
  // them here would make every honest run unverifiable.
  const unscopedDispatches = allBuilderDispatches.filter((d) => d.taskId === null);
  if (unscopedDispatches.length > 0) {
    checks.push({
      taskId: '*',
      rung: 0,
      triggerRounds: null,
      // Rounds, not dispatches: this check reports none, and the count that
      // matters is in the detail where it cannot be read as a round.
      failedRounds: 0,
      status: 'unverifiable',
      triggerEventId: unscopedDispatches[0]?.eventId ?? null,
      detail: `${unscopedDispatches.length} builder dispatch(es) carry no task id, so no task's ladder can count them as the retry that answers a rung.`,
    });
  }

  // D-181: the log writes one task both ways — "<epic>/<task>" and bare
  // "<task>" — because it is append-only and predates D-46/P9-10, so the two
  // spellings interleave rather than splitting at a cutover. Grouping on the
  // raw string therefore built TWO ladders for one task: the real one
  // undercounted its rounds, and a phantom one reported "neither dispatched
  // again nor reached the gate again" while every dispatch sat under the other
  // spelling. That answer is `not-applicable`, which counts as OK, so half of
  // a violated ladder passed the audit. Every qualified id teaches the audit
  // which epic a bare name belongs to, and the bare rounds join that ladder.
  const epicsByBare = new Map<string, Set<string>>();
  const learnEpic = (taskId: string | null): void => {
    if (taskId === null) return;
    const epic = epicOfTaskId(taskId);
    if (epic === null) return;
    const bare = bareTaskId(taskId);
    const seen = epicsByBare.get(bare);
    if (seen) seen.add(epic);
    else epicsByBare.set(bare, new Set([epic]));
  };
  for (const round of allGateRounds) learnEpic(round.taskId);
  for (const dispatched of dispatches) learnEpic(dispatched.taskId);

  // The qualified spelling of a task id, or null when a bare name is one two
  // epics both use. Merging those would trade a silent undercount for a silent
  // merge, which is the trade taskIdsMatch refuses to make.
  const canonicalTaskId = (taskId: string): string | null => {
    if (isQualifiedTaskId(taskId)) return taskId;
    const epics = epicsByBare.get(taskId);
    if (epics === undefined) return taskId;
    if (epics.size > 1) return null;
    const [epic] = epics;
    return epic === undefined ? taskId : `${epic}/${taskId}`;
  };

  const byTask = new Map<string, FailedRound[]>();
  const unplaceable: FailedRound[] = [];
  const unplaceableNames = new Set<string>();
  for (const round of allRounds) {
    if (round.taskId === null) continue;
    const canonical = canonicalTaskId(round.taskId);
    if (canonical === null) {
      unplaceable.push(round);
      unplaceableNames.add(round.taskId);
      continue;
    }
    const list = byTask.get(canonical);
    if (list) list.push(round);
    else byTask.set(canonical, [round]);
  }

  // Same fail-closed answer as the orphans above, for the same reason: a round
  // the audit cannot attribute is reported as unattributable, not guessed onto
  // one epic and not quietly dropped.
  if (unplaceable.length > 0) {
    const names = [...unplaceableNames].sort().join(', ');
    checks.push({
      taskId: '*',
      rung: 0,
      triggerRounds: null,
      failedRounds: unplaceable.length,
      status: 'unverifiable',
      triggerEventId: unplaceable[0]?.eventId ?? null,
      detail: `${unplaceable.length} blocked gate-outcome event(s) name a task without its epic (${names}), and more than one epic uses that name, so they cannot be counted against one task's ladder.`,
    });
  }

  if (byTask.size === 0 && orphans.length === 0 && unplaceable.length === 0) {
    checks.push({
      taskId: scopedTask ?? '*',
      rung: 0,
      triggerRounds: null,
      failedRounds: 0,
      status: 'not-applicable',
      triggerEventId: null,
      detail: 'No failed rounds in scope; no task reached the first rung.',
    });
    return report(checks);
  }

  for (const [taskId, rounds] of byTask) {
    const taskDispatches = dispatches.filter(
      (d) => d.taskId !== null && canonicalTaskId(d.taskId) === taskId,
    );
    const taskGateRounds = allGateRounds.filter(
      (r) => r.taskId !== null && canonicalTaskId(r.taskId) === taskId,
    );
    for (const rung of ladder) {
      const check = checkOneRung(
        taskId,
        rung,
        rounds,
        taskDispatches,
        taskGateRounds,
        operatorAnswers,
      );
      if (check) checks.push(check);
    }
  }

  return report(checks);
}
