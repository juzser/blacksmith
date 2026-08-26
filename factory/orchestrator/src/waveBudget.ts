// Wave admission's budget gate, added the same day `epic.max_in_flight_tasks`
// reached budgets.yml.
//
// budgetAlarm.ts (P9-33) made `epic.cap_tokens` and `epic.alarm_ratio`
// readable, but every reader that gave those numbers stands downstream of the
// spend it reports: planQuorum's budget trigger and `smith budget alarm` both
// describe a bill, neither refuses one. `smith wave check` (this module) is
// the first reader standing upstream of the spend it is judging -- at wave
// admission, before any task in the wave has been dispatched -- so it is the
// only one of the three that CAN refuse the spend instead of merely
// describing it afterward.
//
// It reuses checkBudgetAlarm for the epic's measured/projected spend rather
// than re-deriving either number: a second price list is a second thing that
// can disagree with the first, and this module has no business owning its
// own opinion about what a role costs or how a task's tokens are counted.
// What it adds is the one question checkBudgetAlarm was never asked: given
// the headroom that leaves under the cap right now, does the wave about to
// be admitted still fit once its own declared cost is added.
//
// This does not revisit D-29's finding for the task gate: a coder cap the
// worker polices itself is pressure on the very work it is measuring, and it
// stays advisory for exactly that reason (see budgets.yml's header). An epic
// cap checked at wave admission is not a stricter version of that same
// check -- it is a different question asked at a different time. It asks
// before any task in the wave has started, when there is nothing in flight
// yet for a refusal to distort. A decision made before the work exists cannot
// become pressure on the work.
import { checkBudgetAlarm } from './budgetAlarm.js';
import type { BudgetPolicy } from './budgets.js';
import type { StoredEvent } from './events.js';
import { bareTaskId } from './taskId.js';

export type WaveBudgetStatus =
  | 'ok' // headroom covers this wave's declared cost
  | 'refused' // admitting it would cross epic.cap_tokens
  | 'over-fan-out' // max_in_flight_tasks would be exceeded
  | 'unverifiable' // a proposed task declares no budget, so the cost cannot be summed
  | 'not-applicable'; // no epic could be identified for the wave

export interface ProposedWaveBudget {
  taskId: string;
  /** `budget.tokens` as the plan declares it, or null when it declares none. */
  tokens: number | null;
}

export interface WaveBudgetCheck {
  epicId: string | null;
  capTokens: number;
  /** What the log recorded for this epic. A floor on the bill, never the bill. */
  measuredTokens: number;
  /** Measured plus a declared cap for every dispatch nothing measured (budgetAlarm's projection). */
  projectedTokens: number;
  /** max(0, capTokens - projectedTokens). */
  headroomTokens: number;
  /** Sum of the proposed tasks' declared budgets. */
  waveTokens: number;
  waveTaskCount: number;
  /** Proposed tasks with no declared `budget.tokens`. Non-empty forces `unverifiable`. */
  unpricedTasks: string[];
  /** Tasks this epic admitted and has not merged. */
  inFlightTasks: number;
  maxInFlightTasks: number | null;
  status: WaveBudgetStatus;
  detail: string;
}

export interface WaveBudgetOptions {
  sessionId: string;
  epicId: string;
}

const NUMBER = new Intl.NumberFormat('en-US');

function fmt(n: number): string {
  return NUMBER.format(n);
}

function payloadEpicId(payload: Record<string, unknown>): string | null {
  const value = payload.epic_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Bare task ids this epic has admitted and not yet merged, sorted.
 *
 * Folded through bareTaskId exactly as checkBudgetAlarm's own accumulators
 * are (D-46/P9-10): the log is append-only, so a task admitted under its
 * qualified `<epic>/<task>` spelling can be merged under the bare `<task>`
 * spelling later in the same session (or the reverse), and a set keyed on
 * exact string equality would either miss the cancellation or count the one
 * task twice under its two spellings.
 */
export function inFlightTasks(events: readonly StoredEvent[], epicId: string): string[] {
  const admitted = new Set<string>();
  const merged = new Set<string>();

  for (const event of events) {
    const { record } = event;
    if (record.event_type !== 'wave-admitted' && record.event_type !== 'wave-merged') continue;
    if (payloadEpicId(record.payload) !== epicId) continue;

    const taskIds = record.payload.task_ids;
    if (!Array.isArray(taskIds)) continue;

    const target = record.event_type === 'wave-admitted' ? admitted : merged;
    for (const taskId of taskIds) {
      if (typeof taskId === 'string' && taskId.length > 0) target.add(bareTaskId(taskId));
    }
  }

  return [...admitted].filter((taskId) => !merged.has(taskId)).sort();
}

function unverifiableDetail(unpricedTasks: readonly string[]): string {
  return (
    `${fmt(unpricedTasks.length)} of the proposed task(s) (${unpricedTasks.join(', ')}) declare ` +
    `no budget.tokens, so the wave's cost cannot be summed. Price every task before the wave is ` +
    `admitted -- a wave with an unpriced task is not cheaper, it is unmeasured.`
  );
}

function overFanOutDetail(
  inFlight: number,
  waveTaskCount: number,
  maxInFlightTasks: number,
): string {
  return (
    `Admitting this wave would put ${fmt(inFlight + waveTaskCount)} of the epic's tasks in ` +
    `flight at once (${fmt(inFlight)} already admitted and unmerged, ${fmt(waveTaskCount)} ` +
    `proposed), past the ${fmt(maxInFlightTasks)} epic.max_in_flight_tasks allows. Merge or ` +
    `cancel enough in-flight work first, or raise the cap by explicit operator decision.`
  );
}

function refusedDetail(projectedTokens: number, waveTokens: number, capTokens: number): string {
  return (
    `${fmt(projectedTokens)} tokens projected for this epic plus ${fmt(waveTokens)} declared ` +
    `for this wave would reach ${fmt(projectedTokens + waveTokens)}, past the ${fmt(capTokens)} ` +
    `epic.cap_tokens allows. Split the epic at spec time so the remaining work fits, or extend ` +
    `the cap by explicit operator decision.`
  );
}

function okDetail(headroomTokens: number, waveTokens: number, capTokens: number): string {
  return (
    `${fmt(waveTokens)} tokens declared for this wave fit within ${fmt(headroomTokens)} of ` +
    `headroom under the ${fmt(capTokens)} epic.cap_tokens cap.`
  );
}

const NOT_APPLICABLE_DETAIL =
  'No epic id was given for this wave, so there is no epic cap to check it against.';

/**
 * Whether a wave may be admitted, checked once, before any task in it has
 * been dispatched.
 *
 * Reuses checkBudgetAlarm for the epic's measured/projected spend (see this
 * file's header) and adds one number of its own: the wave's own declared
 * cost, summed from `proposed`. Decision order matters and is
 * first-match-wins:
 *
 *   1. not-applicable  -- no epic id was given for the wave at all. Reserved
 *      for exactly this: an epic with no history yet still has an epic, so
 *      its first wave is judged on rule 5 below, not this one.
 *   2. unverifiable    -- some proposed task declares no budget.tokens, so
 *      the wave's own cost cannot be summed. Checked before the fan-out and
 *      cap comparisons because neither means anything once one of their
 *      inputs is missing.
 *   3. over-fan-out    -- admitting the wave would put more of the epic's
 *      tasks in flight than epic.max_in_flight_tasks allows.
 *   4. refused         -- admitting the wave would cross epic.cap_tokens.
 *   5. ok              -- otherwise, including an epic's genuine first wave.
 *
 * An epic on its genuine first wave (checkBudgetAlarm finds no prior event
 * attributing anything to it) reads `measuredTokens: 0, projectedTokens: 0`
 * -- ok if the wave itself fits under the cap, never not-applicable. A fresh
 * epic is not an unreadable one.
 */
export function checkWaveBudget(
  events: readonly StoredEvent[],
  policy: BudgetPolicy,
  proposed: readonly ProposedWaveBudget[],
  options: WaveBudgetOptions,
): WaveBudgetCheck {
  const capTokens = policy.epic.capTokens;
  const maxInFlightTasks = policy.epic.maxInFlightTasks;
  const waveTaskCount = proposed.length;
  const unpricedTasks = proposed.filter((task) => task.tokens === null).map((task) => task.taskId);
  const waveTokens = proposed.reduce((sum, task) => sum + (task.tokens ?? 0), 0);

  if (options.epicId.trim().length === 0) {
    return {
      epicId: null,
      capTokens,
      measuredTokens: 0,
      projectedTokens: 0,
      headroomTokens: capTokens,
      waveTokens,
      waveTaskCount,
      unpricedTasks,
      inFlightTasks: 0,
      maxInFlightTasks,
      status: 'not-applicable',
      detail: NOT_APPLICABLE_DETAIL,
    };
  }

  const epicId = options.epicId;
  const report = checkBudgetAlarm(events, policy, { sessionId: options.sessionId, epicId });
  const epicCheck = report.epics[0];
  // checkBudgetAlarm emits a synthetic `epicId: '*'` entry exactly when it
  // found no event attributing anything to this epic id (its own comment on
  // the empty-epics-array branch) -- that is this epic's genuine first wave,
  // not a hole in the record, so it is measured at zero rather than reported
  // unverifiable.
  const isFirstWave = epicCheck === undefined || epicCheck.epicId === '*';
  const measuredTokens = isFirstWave ? 0 : epicCheck.measuredTokens;
  const projectedTokens = isFirstWave ? 0 : epicCheck.projectedTokens;
  const headroomTokens = Math.max(0, capTokens - projectedTokens);
  const inFlight = inFlightTasks(events, epicId).length;

  const base = {
    epicId,
    capTokens,
    measuredTokens,
    projectedTokens,
    headroomTokens,
    waveTokens,
    waveTaskCount,
    unpricedTasks,
    inFlightTasks: inFlight,
    maxInFlightTasks,
  };

  if (unpricedTasks.length > 0) {
    return { ...base, status: 'unverifiable', detail: unverifiableDetail(unpricedTasks) };
  }

  if (maxInFlightTasks !== null && inFlight + waveTaskCount > maxInFlightTasks) {
    return {
      ...base,
      status: 'over-fan-out',
      detail: overFanOutDetail(inFlight, waveTaskCount, maxInFlightTasks),
    };
  }

  if (projectedTokens + waveTokens > capTokens) {
    return {
      ...base,
      status: 'refused',
      detail: refusedDetail(projectedTokens, waveTokens, capTokens),
    };
  }

  return { ...base, status: 'ok', detail: okDetail(headroomTokens, waveTokens, capTokens) };
}
