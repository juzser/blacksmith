// Epic spend against budgets.yml's `epic.alarm_ratio` — the consumer that
// number never had (P9-33, closing D-12's "no" row).
//
// `epic.alarm_ratio: 0.7` has been in the policy since Phase 1. It parses into
// BudgetPolicy, budgets.test.ts asserts it, and no production path reads it.
// Its only real host was a sentence in SKILL.md telling a human to keep an eye
// on the number — which is to say the alarm fired when someone remembered to
// look.
//
// This module is the check that the two audits before it (dispatchAudit.ts,
// escalation.ts) established the shape for: a pure function over the event log,
// a status union with an explicit unverifiable, and a paired CLI verb that
// exits 1. It differs from them in one way that changes the whole design.
//
// MONOTONICITY. Those audits ask whether a rule was obeyed, and a gap in the
// record leaves the answer genuinely unknown in both directions. This one asks
// how much an epic spent, and every gap in the record can only make the real
// bill *bigger*. Measured spend is therefore a floor, never a total, and the
// two directions are not symmetric:
//
//   * A crossing is a fact. If the tokens we can see already exceed the alarm,
//     the tokens we cannot see do not un-exceed it. Report it, hole or no hole.
//   * A non-crossing is a claim about the record, not about the world. "Under
//     the alarm" is only honest when the *upper* bound is under it too.
//
// So the report carries two numbers per epic. `measuredTokens` is what the log
// actually recorded. `projectedTokens` adds, for every dispatch the measured
// number does not already account for, the cap budgets.yml declares for that
// role — which is one cap per re-dispatch, not one per task (D-171). A role
// the policy prices nowhere cannot be added to the ceiling at all — and a
// ceiling with a hole in it is not a ceiling, so the epic goes unverifiable
// rather than under.
//
// A cap is not a bound, though, and that is the third hole (D-188). The gate
// records a task budget overrun and does not block on one, so a dispatch is
// free to spend past its declared cap — dogfood's did, by an order of
// magnitude: `envkit-mcp-surface/task-2-path-guard` recorded a single coder
// round at 1,484,000 tokens against a 150,000 coder cap, and budgets.yml's own
// comment cites that run as the reason the epic cap was raised. Once an epic
// has been *measured* spending more on one task than the projection charges an
// unmeasured dispatch, its own log has falsified the price list the projection
// is built from, and the result is an estimate wearing a ceiling's name. So a
// task over that price counts as a hole too: the epic still gets its numbers,
// it just no longer gets to clear on them.
//
// The gap this makes visible is D-9's. On dogfood-envkit-1 the epic's declared
// task budgets summed to 545,000 against a 2,000,000 cap — 27%, comfortably
// under the 1,400,000 alarm — while the run's real projection was several times
// that. The plan-quorum budget trigger, the one automated check meant to catch
// "this plan is too expensive", measures the smaller half of the bill. Judge
// tokens are in no task result and never will be: a judge returns findings, not
// a Result. Anything that reads only `task-result-recorded` is reading the
// builder's half and calling it the total.
import type { BudgetPolicy } from './budgets.js';
import { eventTaskId, type StoredEvent } from './events.js';
import { bareTaskId, epicOfTaskId } from './taskId.js';

/**
 * Per epic, where spend stands against `epic.cap_tokens` and the alarm derived
 * from it.
 *
 * Ordered by how much they bind: `over-cap` and `alarm` are facts about spend,
 * `at-risk` and `unverifiable` are facts about the record.
 */
export type EpicBudgetStatus =
  /** The upper bound is below the alarm. The only status that clears. */
  | 'under'
  /** Measured spend alone has reached `alarm_ratio × cap_tokens`. */
  | 'alarm'
  /** Measured spend alone has reached the cap. */
  | 'over-cap'
  /** Measured spend has not, but the projected ceiling has. D-9's shape. */
  | 'at-risk'
  /** Neither bound crossed, and the record has holes that could hide one. */
  | 'unverifiable';

export interface EpicSpendCheck {
  epicId: string;
  capTokens: number;
  /** `alarm_ratio × cap_tokens`, rounded down. */
  alarmTokens: number;
  /** What the log recorded. A floor on the bill, never the bill. */
  measuredTokens: number;
  /** Measured spend plus a declared cap for every dispatch nothing measured. */
  projectedTokens: number;
  /** Tasks the log attributes to this epic, by bare id. */
  taskCount: number;
  /** Of those, the ones with a recorded token count. */
  measuredTaskCount: number;
  /** Tokens added to the projection, by the role they were priced from. */
  projectedFrom: Record<string, number>;
  /** Roles dispatched to this epic that budgets.yml declares no cap for. */
  rolesWithoutCap: string[];
  /**
   * Tasks measured above the largest price the projection can charge a
   * dispatch. Each one is proof this epic's spend outruns its price list.
   */
  tasksOverPrice: string[];
  status: EpicBudgetStatus;
  detail: string;
}

export interface BudgetAlarmReport {
  sessionId: string;
  /** `epic.alarm_ratio` as judged against, echoed so the verdict is auditable. */
  alarmRatio: number;
  capTokens: number;
  epics: EpicSpendCheck[];
  /** Dispatches no epic can be charged for. Their tokens are in nobody's total. */
  unattributedDispatches: number;
  /** The roles those dispatches ran, sorted and deduplicated. */
  unattributedRoles: string[];
  ok: boolean;
}

export interface BudgetAlarmOptions {
  sessionId: string;
  /** Report only this epic. Others are dropped, not merely un-flagged. */
  epicId?: string;
}

/**
 * The roles budgets.yml prices under `task.judges` — its line 53 comment is the
 * enumeration: "# spec-reviewer, reviewer, verifier, grader".
 *
 * Hardcoded here rather than added to the YAML as a `roles:` list, for the same
 * reason escalation.ts derives BUILDER_ROLES from the policy's own prose: the
 * list is already written down, and a second copy in a different file is a
 * second thing to keep true. What matters is that a role absent from *both*
 * this list and the priced worker roles is reported rather than assumed free —
 * see rolesWithoutCap. `security-reviewer` and `merger` are the live examples:
 * both appear in budgets.yml's `narrowing_roles`, neither has a declared cap.
 */
const JUDGE_ROLES: readonly string[] = ['spec-reviewer', 'reviewer', 'verifier', 'grader'];

/**
 * How a dispatch's tokens can be accounted for.
 *
 * `worker` roles produce a Result, so their spend reaches
 * `task-result-recorded` and needs projecting only when that event is missing.
 * `judge` roles produce findings, so their spend reaches no result event ever
 * and is always projected. `unpriced` is neither, and is the hole.
 */
type RolePricing =
  | { kind: 'worker'; capTokens: number }
  | { kind: 'judge'; capTokens: number }
  | { kind: 'unpriced' };

function priceRole(role: string, policy: BudgetPolicy): RolePricing {
  if (role === 'coder') return { kind: 'worker', capTokens: policy.task.coder.capTokens };
  if (role === 'researcher') return { kind: 'worker', capTokens: policy.task.researcher.capTokens };
  if (JUDGE_ROLES.includes(role)) return { kind: 'judge', capTokens: policy.task.judges.capTokens };
  return { kind: 'unpriced' };
}

/**
 * The most the projection can charge one unmeasured dispatch.
 *
 * Read across every priced role rather than off `coder`, which merely happens
 * to be the largest today: a policy that priced a researcher higher would
 * otherwise let spend above the real ceiling pass unnamed.
 */
function largestDeclaredPrice(policy: BudgetPolicy): number {
  return Math.max(
    policy.task.coder.capTokens,
    policy.task.researcher.capTokens,
    policy.task.judges.capTokens,
  );
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Task -> epic, from every trace in the log that carries the edge.
 *
 * Two traces, because either can be absent (the P9-32 lesson: an audit that
 * reads one trace reports that trace's gaps as the world's clean state):
 *
 *   1. A qualified id names its own epic — `<epic>/<task>`.
 *   2. `wave-admitted` / `wave-merged` carry `epic_id` plus the `task_ids` they
 *      moved, which is the only trace for a bare id.
 *
 * Every admitted id is indexed under both its own spelling and its bare form.
 * dogfood-envkit-1 admitted wave 1 as `envkit-config-loader/task-0-toolchain`
 * and recorded every one of that task's later events under the bare
 * `task-0-toolchain` (D-14, deliberately). A map keyed on the admitted spelling
 * alone attributes none of them.
 */
export function readEpicMembership(events: readonly StoredEvent[]): Map<string, string> {
  const membership = new Map<string, string>();

  const remember = (taskId: string, epicId: string): void => {
    if (!membership.has(taskId)) membership.set(taskId, epicId);
    const bare = bareTaskId(taskId);
    if (!membership.has(bare)) membership.set(bare, epicId);
  };

  for (const event of events) {
    const { record } = event;

    if (record.event_type === 'wave-admitted' || record.event_type === 'wave-merged') {
      const epicId = payloadString(record.payload, 'epic_id');
      const taskIds = record.payload.task_ids;
      if (epicId !== null && Array.isArray(taskIds)) {
        for (const taskId of taskIds) {
          if (typeof taskId === 'string' && taskId.length > 0) remember(taskId, epicId);
        }
      }
    }

    const taskId = eventTaskId(event.record);
    if (taskId === null) continue;
    const epicId = epicOfTaskId(taskId);
    if (epicId !== null) remember(taskId, epicId);
  }

  return membership;
}

/**
 * Task -> tokens recorded, from both traces that carry a spend number.
 *
 *   1. `task-result-recorded.token_usage.total_tokens` — the worker's own count.
 *   2. `budget-check-result.tokensUsed` — the gate's copy of that same number.
 *
 * The larger of the two wins rather than their sum. They describe one spend: the
 * gate reads `tokensUsed` off the very result it is checking, so adding them
 * doubles the bill, and taking either alone reads zero whenever that trace is
 * the one missing. On dogfood-envkit-1 *both* are missing for every task — the
 * log holds neither event type — which is what makes measured-only reporting
 * useless there and the projection load-bearing.
 *
 * Max also collapses re-dispatch, which is a different claim and a wrong one.
 * dogfood-mcp-1 recorded `task-2-path-guard` seven times: three distinct
 * rounds, each re-recorded under both the qualified and the bare id spelling.
 * Summing would bill a round two or three times; max bills one round of three.
 * Both are wrong about the total, and max is the safe direction to be wrong in
 * only because this map is a floor — the projection is what has to carry the
 * rounds it drops (D-171).
 */
export function readMeasuredSpend(events: readonly StoredEvent[]): Map<string, number> {
  const spend = new Map<string, number>();

  const record = (taskId: string, tokens: number): void => {
    const seen = spend.get(taskId);
    if (seen === undefined || tokens > seen) spend.set(taskId, tokens);
  };

  for (const event of events) {
    const taskId = eventTaskId(event.record);
    if (taskId === null) continue;
    const { payload, event_type: eventType } = event.record;

    if (eventType === 'task-result-recorded') {
      const usage = payload.token_usage;
      if (usage !== null && typeof usage === 'object') {
        const total = payloadNumber(usage as Record<string, unknown>, 'total_tokens');
        if (total !== null) record(taskId, total);
      }
      continue;
    }

    if (eventType === 'budget-check-result') {
      const used = payloadNumber(payload, 'tokensUsed');
      if (used !== null) record(taskId, used);
    }
  }

  return spend;
}

const NUMBER = new Intl.NumberFormat('en-US');

function fmt(n: number): string {
  return NUMBER.format(n);
}

/** Per-epic accumulator, before it is turned into a verdict. */
interface EpicAccumulator {
  tasks: Set<string>;
  measuredTasks: Set<string>;
  measuredTokens: number;
  projectedFrom: Map<string, number>;
  rolesWithoutCap: Set<string>;
  tasksOverPrice: Set<string>;
}

function emptyAccumulator(): EpicAccumulator {
  return {
    tasks: new Set(),
    measuredTasks: new Set(),
    measuredTokens: 0,
    projectedFrom: new Map(),
    rolesWithoutCap: new Set(),
    tasksOverPrice: new Set(),
  };
}

function decide(
  measured: number,
  projected: number,
  alarmTokens: number,
  capTokens: number,
  hasHoles: boolean,
): EpicBudgetStatus {
  // Order matters, and it is the monotonicity argument in code. A crossing the
  // log can already prove survives any hole in the log, so it is reported as
  // the fact it is rather than downgraded to unverifiable by an unrelated
  // unknown. Only when nothing has crossed does the quality of the record
  // decide between "under" and "we cannot tell".
  if (measured >= capTokens) return 'over-cap';
  if (measured >= alarmTokens) return 'alarm';
  if (projected >= alarmTokens) return 'at-risk';
  if (hasHoles) return 'unverifiable';
  return 'under';
}

function describe(
  check: Omit<EpicSpendCheck, 'detail'>,
  unattributed: number,
  largestPrice: number,
): string {
  const head =
    `${fmt(check.measuredTokens)} tokens measured across ${check.measuredTaskCount} of ` +
    `${check.taskCount} task(s), ${fmt(check.projectedTokens)} projected, against a ` +
    `${fmt(check.alarmTokens)} alarm and a ${fmt(check.capTokens)} cap.`;

  const holes: string[] = [];
  if (check.rolesWithoutCap.length > 0) {
    holes.push(
      `budgets.yml declares no cap for ${check.rolesWithoutCap.join(', ')}, so those ` +
        `dispatches are in neither number`,
    );
  }
  if (unattributed > 0) {
    holes.push(`${unattributed} dispatch(es) name no epic, so their tokens are in nobody's total`);
  }
  if (check.tasksOverPrice.length > 0) {
    holes.push(
      `${check.tasksOverPrice.join(', ')} measured above the ${fmt(largestPrice)} this ` +
        `projection charges an unmeasured dispatch, so a cap does not bound one here`,
    );
  }
  const holeText = holes.length > 0 ? ` Holes: ${holes.join('; ')}.` : '';

  switch (check.status) {
    case 'over-cap':
      return `${head} Measured spend alone is at or past the cap.${holeText}`;
    case 'alarm':
      return (
        `${head} Measured spend alone has reached the alarm — re-plan the remaining work to ` +
        `fit, or ask the operator to extend. Unrecorded spend can only add to this.${holeText}`
      );
    case 'at-risk':
      return (
        `${head} Measured spend is under the alarm but the projected ceiling is not: the ` +
        `visible half of the bill reads clear while the whole bill does not (D-9).${holeText}`
      );
    case 'unverifiable':
      return (
        `${head} Neither bound has crossed the alarm, but the projection is not an upper ` +
        `bound, so "under" would be a claim about the record rather than the spend.${holeText}`
      );
    default:
      return (
        `${head} The projected ceiling is under the alarm, so the real spend is too.` +
        ` Measured spend remains a floor: judge tokens never reach a task result.`
      );
  }
}

/**
 * Epic spend against `epic.alarm_ratio`, counted from the log.
 *
 * Fails the report on anything but `under`, and on an empty epic set: a session
 * the log attributes no epic to has not been shown to be within budget, it has
 * been shown to be unreadable. Same reason dispatchAudit.ts emits a synthetic
 * check for an empty pair set — an empty check set must never be mistaken for
 * a clean one.
 */
export function checkBudgetAlarm(
  events: readonly StoredEvent[],
  policy: BudgetPolicy,
  options: BudgetAlarmOptions,
): BudgetAlarmReport {
  const capTokens = policy.epic.capTokens;
  const alarmRatio = policy.epic.alarmRatio;
  const alarmTokens = Math.floor(capTokens * alarmRatio);

  const largestPrice = largestDeclaredPrice(policy);

  const membership = readEpicMembership(events);
  const rawSpend = readMeasuredSpend(events);

  const epicOf = (taskId: string): string | null =>
    membership.get(taskId) ?? membership.get(bareTaskId(taskId)) ?? null;

  // Fold spend onto the bare id, so a task recorded under both spellings is one
  // task with one bill rather than two of each.
  const spendByTask = new Map<string, number>();
  for (const [taskId, tokens] of rawSpend) {
    const bare = bareTaskId(taskId);
    const seen = spendByTask.get(bare);
    if (seen === undefined || tokens > seen) spendByTask.set(bare, tokens);
  }

  const inScope = (epicId: string): boolean =>
    options.epicId === undefined || options.epicId === epicId;

  const accumulators = new Map<string, EpicAccumulator>();
  const accumulatorFor = (epicId: string): EpicAccumulator => {
    let acc = accumulators.get(epicId);
    if (acc === undefined) {
      acc = emptyAccumulator();
      accumulators.set(epicId, acc);
    }
    return acc;
  };

  // An epic's task set comes from evidence a task existed — a wave that
  // admitted it, spend recorded against it, or a dispatch charged to it. Not
  // from the membership map, which is deliberately broader: epic-level events
  // carry synthetic `<epic>/epic` ids (dogfood's `epic-closed` does), and those
  // belong in the attribution index without inflating a task count.
  for (const event of events) {
    const { record } = event;
    if (record.event_type !== 'wave-admitted' && record.event_type !== 'wave-merged') continue;
    const epicId = payloadString(record.payload, 'epic_id');
    const taskIds = record.payload.task_ids;
    if (epicId === null || !inScope(epicId) || !Array.isArray(taskIds)) continue;
    const acc = accumulatorFor(epicId);
    for (const taskId of taskIds) {
      if (typeof taskId === 'string' && taskId.length > 0) acc.tasks.add(bareTaskId(taskId));
    }
  }

  for (const [bare, tokens] of spendByTask) {
    const epicId = epicOf(bare);
    if (epicId === null || !inScope(epicId)) continue;
    const acc = accumulatorFor(epicId);
    acc.tasks.add(bare);
    acc.measuredTasks.add(bare);
    acc.measuredTokens += tokens;
    if (tokens > largestPrice) acc.tasksOverPrice.add(bare);
  }

  let unattributedDispatches = 0;
  const unattributedRoles = new Set<string>();
  // Tasks whose measured number has already paid for one worker dispatch.
  const accountedByMeasured = new Set<string>();

  for (const event of events) {
    if (event.record.event_type !== 'dispatch_decision') continue;
    const role = payloadString(event.record.payload, 'agent_role');
    if (role === null) continue;

    const taskId = eventTaskId(event.record);
    const epicId = taskId === null ? null : epicOf(taskId);
    if (epicId === null) {
      unattributedDispatches += 1;
      unattributedRoles.add(role);
      continue;
    }
    if (!inScope(epicId)) continue;

    const acc = accumulatorFor(epicId);
    if (taskId !== null) acc.tasks.add(bareTaskId(taskId));
    const pricing = priceRole(role, policy);
    if (pricing.kind === 'unpriced') {
      acc.rolesWithoutCap.add(role);
      continue;
    }
    // A judge's tokens are in no result and never will be, so a judge dispatch
    // is always projected. A worker's are inside a result — but `spendByTask`
    // holds one number per task, the largest, so it accounts for exactly one of
    // that task's worker dispatches. Exempting all of them (D-171) put a
    // re-dispatched round in neither number: the max had discarded its tokens
    // and the exemption then declined to price them.
    if (pricing.kind === 'worker' && taskId !== null) {
      const bare = bareTaskId(taskId);
      if (spendByTask.has(bare) && !accountedByMeasured.has(bare)) {
        accountedByMeasured.add(bare);
        continue;
      }
    }
    acc.projectedFrom.set(role, (acc.projectedFrom.get(role) ?? 0) + pricing.capTokens);
  }

  const epics: EpicSpendCheck[] = [...accumulators.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([epicId, acc]) => {
      const projectedFrom = Object.fromEntries(
        [...acc.projectedFrom.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      const projectedTokens =
        acc.measuredTokens + Object.values(projectedFrom).reduce((sum, n) => sum + n, 0);
      const rolesWithoutCap = [...acc.rolesWithoutCap].sort();
      const tasksOverPrice = [...acc.tasksOverPrice].sort();
      const status = decide(
        acc.measuredTokens,
        projectedTokens,
        alarmTokens,
        capTokens,
        rolesWithoutCap.length > 0 || unattributedDispatches > 0 || tasksOverPrice.length > 0,
      );
      const partial: Omit<EpicSpendCheck, 'detail'> = {
        epicId,
        capTokens,
        alarmTokens,
        measuredTokens: acc.measuredTokens,
        projectedTokens,
        taskCount: acc.tasks.size,
        measuredTaskCount: acc.measuredTasks.size,
        projectedFrom,
        rolesWithoutCap,
        tasksOverPrice,
        status,
      };
      return { ...partial, detail: describe(partial, unattributedDispatches, largestPrice) };
    });

  if (epics.length === 0) {
    const partial: Omit<EpicSpendCheck, 'detail'> = {
      epicId: '*',
      capTokens,
      alarmTokens,
      measuredTokens: 0,
      projectedTokens: 0,
      taskCount: 0,
      measuredTaskCount: 0,
      projectedFrom: {},
      rolesWithoutCap: [],
      tasksOverPrice: [],
      status: 'unverifiable',
    };
    epics.push({
      ...partial,
      detail:
        options.epicId === undefined
          ? 'No epic in this session has a task the log attributes to it, so there is no ' +
            'spend to measure. An unreadable session is not a session within budget.'
          : `No task in this session is attributed to epic "${options.epicId}". Either the ` +
            'id is wrong or the log never recorded the wave that admitted its tasks.',
    });
  }

  return {
    sessionId: options.sessionId,
    alarmRatio,
    capTokens,
    epics,
    unattributedDispatches,
    unattributedRoles: [...unattributedRoles].sort(),
    ok: epics.every((epic) => epic.status === 'under'),
  };
}
