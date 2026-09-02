/**
 * How wide this plan can *ever* run, answered before an agent is dispatched.
 *
 * The factory now brackets parallelism from two sides and neither one reaches
 * the plan. `wave check` certifies that a set someone already picked *could*
 * run together; `wave audit` reads the log afterwards and reports whether it
 * *did*. Both take the plan as given. But a plan whose tasks all claim
 * overlapping globs has a ceiling of one no matter how many agents are
 * available, and a planner that sliced it that way gets the same silent
 * `valid: true` from every gate downstream — each wave of one is admitted,
 * each run of one is faithful to its admission, and the epic serializes with
 * nothing anywhere reporting a problem. The cost is paid at plan time and
 * every check that could have named it runs too late to matter.
 *
 * So this module replays the dispatcher against the plan. It calls the same
 * pure `computeNextWave` the real wave loop calls, marks the returned wave
 * terminal, and calls it again until nothing more can start. What comes back
 * is the number of rounds the plan needs and the widest round it ever gets --
 * computed by the containment code itself, so the ceiling reported here is
 * the ceiling the dispatcher will actually hit, not a second opinion about
 * it that can drift.
 *
 * The one distinction that makes the output actionable: a task deferred
 * `dependency-pending` is waiting on work it genuinely needs, and that is the
 * shape of the problem, not a defect — a chain of five real dependencies
 * takes five rounds and no re-slicing changes it. A task deferred for any
 * other reason had its dependencies satisfied, was ready to run that round,
 * and was held back purely by how the planner drew the claims. Only the
 * second kind is anybody's to fix, so only the second kind is reported as a
 * constraint.
 *
 * What this deliberately does not do is claim a counterfactual. It never says
 * "re-slice these claims and the plan runs in three rounds instead of five",
 * because knowing that would mean inventing the claim geometry the planner
 * would have written instead, and the dependency graph may simply bind next.
 * It names which tasks were held back, by whom, and in which round. Deciding
 * whether that is worth re-planning is the operator's, and the numbers are
 * there to decide on.
 *
 * Pure, and it writes nothing. Like `waveNext`, admission stays where it was:
 * a round simulated here has been admitted by nobody.
 */
import {
  computeNextWave,
  type DeferralReason,
  type NextWaveInput,
  type WaveDeferral,
} from './waveNext.js';

/**
 * Reported in this order, which is the order `computeNextWave` tests them in.
 * `dependency-pending` is absent on purpose — it is the one reason that is
 * never a finding.
 */
const AVOIDABLE_REASONS: readonly DeferralReason[] = [
  'claim-overlap',
  'serialize-hotspot',
  'symbol-coupled',
];

export interface ScheduleRound {
  /** 1-based, so a round number reads the way an operator counts them. */
  round: number;
  /** The wave this round starts, in the dispatch order `wave next` would use. */
  tasks: string[];
  /**
   * Tasks this round could have started but did not, excluding the ones
   * waiting on a dependency. Per-round because width lost in round 1 and
   * width lost in round 4 are different conversations.
   */
  avoidable: WaveDeferral[];
}

/** One reason the plan runs narrower than its dependency graph requires. */
export interface AvoidableConstraint {
  /** Never `dependency-pending`. */
  reason: DeferralReason;
  /** Every task this reason ever held back, deduped and sorted. */
  tasks: string[];
  /** Every task that ever did the holding, deduped and sorted. */
  blockedBy: string[];
  /** The first detail seen, so the report names one concrete pair. */
  detail: string;
}

export interface PlanSchedule {
  epicId: string;
  rounds: ScheduleRound[];
  /** `rounds.length` — how many sequential waves the plan needs. */
  depth: number;
  /** The most tasks any single round starts. This is the parallelism ceiling. */
  widest: number;
  /** How many tasks the simulation managed to start at all. */
  scheduled: number;
  /**
   * Candidate tasks no round could ever start. Empty is the healthy answer;
   * anything here means the plan cannot be finished as written.
   */
  stalled: string[];
  /**
   * Non-terminal, non-candidate tasks — mid-flight, or waiting on a person.
   * Reported as a fact about where the run stands, not against the plan: the
   * simulation can complete a task but it cannot un-block one.
   */
  occupied: string[];
  constraints: AvoidableConstraint[];
  /** Empty unless there is something to say. */
  hint: string;
  /** 1 when the plan stalls, 2 when it runs but loses width, else 0. */
  exitCode: 0 | 1 | 2;
}

function nameList(ids: readonly string[]): string {
  return ids.join(', ');
}

interface ConstraintAccumulator {
  tasks: Set<string>;
  blockedBy: Set<string>;
  detail: string;
}

function buildHint(
  stalled: readonly string[],
  occupied: readonly string[],
  constraints: readonly AvoidableConstraint[],
  depth: number,
): string {
  if (stalled.length > 0) {
    const held = constraints.flatMap((c) => c.blockedBy).filter((id) => occupied.includes(id));
    const because =
      held.length > 0
        ? ` ${nameList([...new Set(held)].sort())} still holds claims and is waiting on a person, not on the schedule.`
        : '';
    return (
      `The schedule stalls: ${nameList(stalled)} can never start, ` +
      `so ${stalled.length === 1 ? 'that task' : 'those tasks'} will not run as this plan is written.${because}`
    );
  }
  if (constraints.length > 0) {
    const reasons = constraints.map((c) => c.reason);
    return (
      `This plan runs in ${depth} ${depth === 1 ? 'round' : 'rounds'}, and some of that ` +
      `depth is claim geometry rather than dependencies (${nameList(reasons)}). ` +
      'Re-slicing the claims may widen it; whether it does depends on the dependency graph, ' +
      'which this command does not speculate about.'
    );
  }
  return '';
}

/**
 * Replay the wave loop against a plan until nothing more can start.
 *
 * Termination is structural, not capped: every iteration either admits at
 * least one task — which is then marked terminal, strictly shrinking the
 * candidate set — or admits none, and the loop ends. So it runs at most
 * once per task plus the final unproductive round that proves there is
 * nothing left.
 */
export function scheduleWaves(input: NextWaveInput): PlanSchedule {
  // A copy, because a caller's status register is theirs and this simulation
  // completes tasks that have not been dispatched.
  const statusById = new Map<string, string>(input.statusById ?? []);
  const rounds: ScheduleRound[] = [];
  const accumulators = new Map<DeferralReason, ConstraintAccumulator>();
  let epicId = input.plan.epic_id;
  let stalled: string[] = [];
  let occupied: string[] = [];

  for (;;) {
    const result = computeNextWave({ ...input, statusById });
    epicId = result.epicId;
    occupied = result.occupied;

    const avoidable = result.deferred.filter((d) => d.reason !== 'dependency-pending');
    for (const deferral of avoidable) {
      const acc = accumulators.get(deferral.reason) ?? {
        tasks: new Set<string>(),
        blockedBy: new Set<string>(),
        detail: deferral.detail,
      };
      acc.tasks.add(deferral.taskId);
      for (const holder of deferral.blockedBy) acc.blockedBy.add(holder);
      accumulators.set(deferral.reason, acc);
    }

    if (result.wave.length === 0) {
      // The round that starts nothing is the round that names the stall:
      // anything still deferred here is a candidate no later round reaches.
      stalled = result.deferred.map((d) => d.taskId).sort();
      break;
    }

    rounds.push({ round: rounds.length + 1, tasks: result.wave, avoidable });
    for (const taskId of result.wave) statusById.set(taskId, 'completed');
  }

  const constraints: AvoidableConstraint[] = AVOIDABLE_REASONS.flatMap((reason) => {
    const acc = accumulators.get(reason);
    if (acc === undefined) return [];
    return [
      {
        reason,
        tasks: [...acc.tasks].sort(),
        blockedBy: [...acc.blockedBy].sort(),
        detail: acc.detail,
      },
    ];
  });

  const depth = rounds.length;
  const hint = buildHint(stalled, occupied, constraints, depth);
  return {
    epicId,
    rounds,
    depth,
    widest: rounds.reduce((max, r) => Math.max(max, r.tasks.length), 0),
    scheduled: rounds.reduce((total, r) => total + r.tasks.length, 0),
    stalled,
    occupied,
    constraints,
    hint,
    exitCode: stalled.length > 0 ? 1 : constraints.length > 0 ? 2 : 0,
  };
}
