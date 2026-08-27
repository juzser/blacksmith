// Tester-isolation audit, the other half of "a worker never grades its own
// work" (crosscheck.yml `role_isolation`).
//
// dispatchAudit.ts answers `finder_ne_critic`, which compares the two
// dispatches' MODELS. For a tester that is the wrong question: a tester may
// legitimately run on the coder's model, and forcing a second vendor onto it
// would buy nothing. What it may not do is run inside the coder's own turn.
// A coder that writes its own tests grades itself, and every gate downstream
// still goes green — the test gate reports what the tests say, and the tests
// say what their author decided to assert.
//
// The only evidence of a separate turn the event log can hold is a separate
// `dispatch_decision`. No role template grants `Agent`, so a dispatch is
// written by the orchestrator once per agent it invokes, never by an agent
// about itself (.claude/skills/bs/SKILL.md, "You own the log for what you
// dispatch"). That is why this module reads dispatches and not, say, file
// authorship: authorship is not in the log, and inventing a proxy for it
// would be a check that answers a question it cannot see.
//
// Required-role semantics, which is why this is not another pair in
// dispatchAudit.ts. There, a critic that never ran raises no check at all —
// `not-applicable`, and the report stays ok, because a session that
// dispatched no verifier violated nothing. Here the absence IS the finding:
// tests were graded, so somebody wrote them, and if no tester was dispatched
// the only remaining author is the coder.
//
// Fail-closed on the same terms as dispatchAudit.ts: `unverifiable` fails the
// report exactly like `violation`. `not-applicable` is reserved for the one
// case where nothing was graded at all (a gate that ran zero checks), because
// then there is no self-grading to find.
import type { RoleIsolationPair } from './crosscheck.js';
import { type DispatchRecord, readDispatchRecords } from './dispatchAudit.js';
import { eventTaskId, type StoredEvent } from './events.js';
import { taskIdsMatch } from './taskId.js';

/**
 * The event this audit is anchored to. `testgate-result` is emitted once per
 * gate run (gate.ts), and it is the moment the question becomes answerable:
 * before it, a task whose tester has not been dispatched yet is merely early.
 */
const TEST_GATE_EVENT = 'testgate-result';

/**
 * How a dispatched agent's turn is recorded as over, and which payload field
 * names the role that ended it. Falling back to the record's `actor` is not a
 * nicety: the older half of the log names the role there and nowhere else,
 * and reading only the payload would report those runs as testers that never
 * reported — an `unverifiable` about evidence the log is holding.
 */
const TERMINAL_ROLE_EVENTS: Record<string, string> = {
  'task-result-recorded': 'agent',
  'error-logged': 'agent',
  'judge-reported': 'agent_role',
  'judge-verdict': 'agent',
};

export type TesterCheckStatus = 'ok' | 'violation' | 'unverifiable' | 'not-applicable';

/** One terminal event, flattened to the fields the audit needs. */
export interface TerminalRoleRecord {
  eventId: string;
  ts: string;
  taskId: string | null;
  role: string;
  eventType: string;
}

export interface TesterIsolationCheck {
  /** The task whose tests were graded; null only when the gate named none. */
  taskId: string | null;
  worker: string;
  auditor: string;
  status: TesterCheckStatus;
  /** The `testgate-result` this check is about; null when no gate was in scope. */
  gateEventId: string | null;
  /** How many test checks that gate actually ran. Zero means nothing to grade. */
  checksRun: number;
  /** The worker dispatch the auditor was paired against; null when none preceded it. */
  workerEventId: string | null;
  /** The auditor dispatch; null when no auditor was dispatched before the gate. */
  auditorEventId: string | null;
  /** Why this status, in the words the operator sees. */
  detail: string;
}

export interface TesterIsolationReport {
  sessionId: string;
  taskId: string | null;
  /** `testgate-result` events in scope — 0 and "all clean" are different answers. */
  gatesExamined: number;
  dispatchesExamined: number;
  checks: TesterIsolationCheck[];
  /** False on any violation OR any unverifiable — see the module header. */
  ok: boolean;
}

export interface TesterIsolationOptions {
  sessionId: string;
  /** Scope to one task; gates and dispatches for other tasks then answer for nothing. */
  taskId?: string;
}

/** One `testgate-result`, flattened. `results` stays raw: its shape is the check. */
interface GateRecord {
  eventId: string;
  ts: string;
  taskId: string | null;
  results: unknown;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether two task scopes can answer for each other. dispatchAudit.ts's rule,
 * for its reasons: a record with no task id answers for anything (pre-task-id
 * history is on disk and unrewritable), and "differ" is taskIdsMatch's
 * question, not `===`'s, because the log writes one task both qualified and
 * bare (D-181).
 */
function scopesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || taskIdsMatch(a, b);
}

/**
 * Flatten a session's terminal events, in log order.
 *
 * "Terminal" is TERMINAL_ROLE_EVENTS: the events that say an agent's turn
 * ended. A dispatch that never reaches one of these is a dispatch whose
 * outcome the log does not hold, and this audit says so rather than assuming
 * the tester ran to completion.
 */
export function readTerminalRoleRecords(events: readonly StoredEvent[]): TerminalRoleRecord[] {
  const records: TerminalRoleRecord[] = [];
  for (const stored of events) {
    const record = stored.record;
    const field = TERMINAL_ROLE_EVENTS[record.event_type];
    if (!field) continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const role = payloadString(payload, field) ?? record.actor;
    if (!role) continue;
    records.push({
      eventId: stored.event_id,
      ts: record.ts ?? '',
      taskId: eventTaskId(record),
      role,
      eventType: record.event_type,
    });
  }
  return records;
}

function readGateRecords(events: readonly StoredEvent[]): GateRecord[] {
  const records: GateRecord[] = [];
  for (const stored of events) {
    const record = stored.record;
    if (record.event_type !== TEST_GATE_EVENT) continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    records.push({
      eventId: stored.event_id,
      ts: record.ts ?? '',
      taskId: eventTaskId(record),
      results: payload.results,
    });
  }
  return records;
}

/**
 * The latest dispatch of `role` at or before `ts`, on a task scope that
 * agrees.
 *
 * "At or before" is dispatchAudit.ts's argument on this axis too: a tester
 * dispatched after the gate ran cannot have written what the gate graded, and
 * taking the newest dispatch in the session would let exactly that launder a
 * violation into a pass. The task axis is the same argument on the other
 * coordinate — evidence about one task vouches for nothing about another
 * (D-172).
 */
function latestDispatchBefore(
  dispatches: readonly DispatchRecord[],
  role: string,
  ts: string,
  scope: string | null,
): DispatchRecord | null {
  let best: DispatchRecord | null = null;
  for (const dispatch of dispatches) {
    if (dispatch.role !== role) continue;
    if (dispatch.ts > ts) continue;
    if (!scopesAgree(dispatch.taskId, scope)) continue;
    if (!best || dispatch.ts >= best.ts) best = dispatch;
  }
  return best;
}

function noPairsCheck(): TesterIsolationCheck {
  return {
    taskId: null,
    worker: '*',
    auditor: '*',
    status: 'unverifiable',
    gateEventId: null,
    checksRun: 0,
    workerEventId: null,
    auditorEventId: null,
    detail:
      'crosscheck.yml declares no role_isolation.pairs, so this audit asserts nothing. A policy that names no roles cannot be satisfied or violated, and reporting that as a pass would advertise a check nobody configured.',
  };
}

/**
 * Assert crosscheck.yml's `role_isolation` against what the log records: for
 * every test gate, was the auditor role dispatched in a turn of its own,
 * before the gate, on this task, and did it report?
 *
 * Every gate is checked, not just the last one. A task that got it wrong once
 * and right on the re-run did get it wrong once.
 */
export function checkTesterIsolation(
  events: readonly StoredEvent[],
  pairs: readonly RoleIsolationPair[],
  options: TesterIsolationOptions,
): TesterIsolationReport {
  const taskId = options.taskId ?? null;
  // D-181: `--task` is answered across both spellings of the id, so a gate
  // logged qualified is not dropped from a bare-spelled scope.
  const inScope = (scope: string) => (r: { taskId: string | null }) =>
    r.taskId !== null && taskIdsMatch(r.taskId, scope);
  const allDispatches = readDispatchRecords(events);
  const dispatches = taskId ? allDispatches.filter(inScope(taskId)) : allDispatches;
  const allGates = readGateRecords(events);
  const gates = taskId ? allGates.filter(inScope(taskId)) : allGates;
  const terminals = readTerminalRoleRecords(events);

  const base = {
    sessionId: options.sessionId,
    taskId,
    gatesExamined: gates.length,
    dispatchesExamined: dispatches.length,
  };

  if (pairs.length === 0) {
    return { ...base, checks: [noPairsCheck()], ok: false };
  }

  const checks: TesterIsolationCheck[] = [];
  for (const gate of gates) {
    for (const pair of pairs) {
      checks.push(checkOneGate(pair, gate, dispatches, terminals));
    }
  }

  // No gate at all is not a clean run. It is a session that never reached the
  // moment this audit reads, and saying `ok` about it would answer a question
  // the log never posed.
  if (gates.length === 0) {
    for (const pair of pairs) {
      checks.push({
        taskId,
        worker: pair.worker,
        auditor: pair.auditor,
        status: 'unverifiable',
        gateEventId: null,
        checksRun: 0,
        workerEventId: null,
        auditorEventId: null,
        detail: `No ${TEST_GATE_EVENT} event in scope, so nothing here says whether ${pair.auditor} graded ${pair.worker}'s work.`,
      });
    }
  }

  return {
    ...base,
    checks,
    ok: checks.every((c) => c.status === 'ok' || c.status === 'not-applicable'),
  };
}

function checkOneGate(
  pair: RoleIsolationPair,
  gate: GateRecord,
  dispatches: readonly DispatchRecord[],
  terminals: readonly TerminalRoleRecord[],
): TesterIsolationCheck {
  const base = {
    taskId: gate.taskId,
    worker: pair.worker,
    auditor: pair.auditor,
    gateEventId: gate.eventId,
    workerEventId: null as string | null,
    auditorEventId: null as string | null,
  };

  if (gate.taskId === null) {
    return {
      ...base,
      status: 'unverifiable',
      checksRun: 0,
      detail: `The ${TEST_GATE_EVENT} at ${gate.ts} names no task, so no dispatch can be paired with it.`,
    };
  }
  if (!Array.isArray(gate.results)) {
    return {
      ...base,
      status: 'unverifiable',
      checksRun: 0,
      detail: `The ${TEST_GATE_EVENT} for ${gate.taskId} records no result list, so how much was graded is unknown.`,
    };
  }
  const checksRun = gate.results.length;
  if (checksRun === 0) {
    // Nothing ran, so nothing was self-graded. This is the one status that
    // passes without evidence, and it is safe precisely because there is no
    // verdict here for a coder to have written in its own favour.
    return {
      ...base,
      status: 'not-applicable',
      checksRun: 0,
      detail: `The ${TEST_GATE_EVENT} for ${gate.taskId} ran no test checks, so there was no verdict to grade.`,
    };
  }

  const auditor = latestDispatchBefore(dispatches, pair.auditor, gate.ts, gate.taskId);
  if (!auditor) {
    return {
      ...base,
      status: 'violation',
      checksRun,
      detail: `No ${pair.auditor} was dispatched at or before the test gate for ${gate.taskId}, so the ${checksRun} test check(s) it graded were written in some other role's turn — on this pipeline, ${pair.worker}'s.`,
    };
  }
  base.auditorEventId = auditor.eventId;

  const worker = latestDispatchBefore(dispatches, pair.worker, auditor.ts, auditor.taskId);
  if (!worker) {
    return {
      ...base,
      status: 'unverifiable',
      checksRun,
      detail: `${pair.auditor} was dispatched for ${gate.taskId} with no preceding ${pair.worker} dispatch to have been isolated from.`,
    };
  }
  base.workerEventId = worker.eventId;

  // A shared agent id is one turn wearing two role names, which is the exact
  // thing the pair forbids. A MISSING id is not evidence of anything: the
  // dispatch contract does not require `agent_id`, so demanding it would make
  // every real log unverifiable and teach the operator to ignore this audit.
  if (auditor.agentId && worker.agentId && auditor.agentId === worker.agentId) {
    return {
      ...base,
      status: 'violation',
      checksRun,
      detail: `The ${pair.worker} and ${pair.auditor} dispatches for ${gate.taskId} share agent id ${auditor.agentId}, so the tests were graded in the turn that wrote the code.`,
    };
  }

  const reported = terminals.find(
    (t) =>
      t.role === pair.auditor &&
      t.ts >= auditor.ts &&
      t.ts <= gate.ts &&
      scopesAgree(t.taskId, gate.taskId),
  );
  if (!reported) {
    return {
      ...base,
      status: 'unverifiable',
      checksRun,
      detail: `${pair.auditor} was dispatched for ${gate.taskId} and never reported before the gate ran, so the log does not say whose work the gate graded.`,
    };
  }

  return {
    ...base,
    status: 'ok',
    checksRun,
    detail: `${pair.auditor} was dispatched for ${gate.taskId} after ${pair.worker} and reported (${reported.eventType}) before the gate graded ${checksRun} test check(s).`,
  };
}
