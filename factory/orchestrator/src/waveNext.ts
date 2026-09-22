/**
 * The widest wave the graph allows, computed instead of guessed.
 *
 * `wave check` answers a closed question — may *these* task ids run together
 * — and answers it well. But it only ever sees a set someone already picked,
 * and the safest set to pick is always a set of one: a single task is
 * pairwise-disjoint with nothing, shares no hotspot with nothing, and crosses
 * no import edge with nothing, so it passes every gate in the file. The gate
 * cannot tell a deliberate wave of one from an orchestrator that never
 * thought to ask for more, and both come back `valid: true`. A factory whose
 * whole claim is parallel execution therefore had no command that computes
 * parallelism; it had a command that declines to forbid it.
 *
 * `waveLayers` in graph.ts already bands a plan by longest-path depth, and
 * its docblock says the band means "these can run in parallel right now" —
 * but nothing outside the Flow page's layout ever imported it, so the one
 * function that knew the answer only ever drew it.
 *
 * This module closes that gap from the other end: given a plan, the live
 * status of its tasks and the import-graph crossings between them, it
 * returns the largest set that `wave check` would admit, plus a named reason
 * for every task it left out. It is pure and it writes nothing. Admission
 * stays where it was — `wave check` remains the single command that emits
 * `wave-admitted`, so a proposal here still has to survive the gate that
 * enforces it, and a bug in this file costs a rejected proposal rather than
 * two agents in one worktree.
 */
import {
  claimsOverlap,
  type ProposedWaveTask,
  readClaimList,
  readEdgeList,
  touchesSerializeAlways,
  type WaveTask,
  type WorktreePolicy,
} from './claims.js';
import { type DependencyEdge, topoSort } from './graph.js';
import { livePlanTasks, type PlanFile, type TaskSpecRecord } from './plan.js';
import { TERMINAL_OK_TASK_STATUSES } from './taskStatus.js';

/** The two statuses that mean "nothing has been dispatched for this yet". */
const CANDIDATE_TASK_STATUSES = new Set(['todo', 'ready']);

/**
 * One import-graph crossing, reduced to what this computation reads: the two
 * task ids to order by, and the two files and symbols the deferral names so
 * the operator knows which file a `keeps_exports` promise would have to
 * cover. `SymbolCrossing` from impact.ts is assignable as-is.
 */
export interface SymbolCouplingEdge {
  producer: string;
  consumer: string;
  exportedBy: string;
  importedBy: string;
  symbols: readonly string[];
  typeOnly: boolean;
}

export type DeferralReason =
  | 'dependency-pending'
  | 'claim-overlap'
  | 'serialize-hotspot'
  | 'symbol-coupled';

/** Why one live task is not in the wave this call returns. */
export interface WaveDeferral {
  taskId: string;
  reason: DeferralReason;
  /** The task ids that held it back — never empty. */
  blockedBy: string[];
  detail: string;
}

export interface NextWaveInput {
  plan: PlanFile;
  policy: WorktreePolicy;
  /** Import-graph crossings between the plan's tasks; absent means unanalyzed. */
  crossings?: readonly SymbolCouplingEdge[];
  /**
   * Live status per task id, when the caller has a fresher register than the
   * plan file — the event log. Overrides `task_status` where it has an entry.
   */
  statusById?: ReadonlyMap<string, string>;
}

export interface NextWaveResult {
  epicId: string;
  /** Dispatch order: producers before consumers, lexicographic on a tie. */
  wave: string[];
  deferred: WaveDeferral[];
  done: string[];
  /** Non-terminal tasks that still hold their claims and are not candidates. */
  occupied: string[];
  /** Live tasks this wave does not start: `deferred` plus `occupied`. */
  remaining: number;
}

function nameList(ids: readonly string[]): string {
  return ids.join(', ');
}

/**
 * Order the candidates so that when two of them are coupled, the one that
 * must land first is the one offered admission. Plan edges and import
 * crossings are the same shape of constraint here — "this one after that
 * one" — so both feed one sort, and a coupled pair resolves the way the
 * playbook already resolves it by hand: run the producer first.
 *
 * A cycle among the crossings is not this function's to diagnose (plan.ts
 * rejects cyclic plan edges; import cycles are legal TypeScript), so it falls
 * back to lexicographic order — an arbitrary but stable pick, which still
 * admits one of the pair and defers the other with a reason.
 */
function admissionOrder(
  candidates: readonly WaveTask[],
  edges: readonly DependencyEdge[],
  crossings: readonly SymbolCouplingEdge[],
): WaveTask[] {
  const byId = new Map(candidates.map((t) => [t.task_id, t]));
  const ids = [...byId.keys()].sort();
  const ordering: DependencyEdge[] = [
    ...edges,
    ...crossings.map((c) => ({ task: c.consumer, dependsOn: c.producer })),
  ];
  const sorted = topoSort(ids, ordering);
  const order = sorted.ok ? sorted.order : ids;
  return order.flatMap((id) => {
    const task = byId.get(id);
    return task ? [task] : []; // provably total: topoSort returns only ids it was given
  });
}

/**
 * Every live task in the plan, with its claims read as a list of globs.
 *
 * Exists because a caller has to hand `waveImpact` a readable claim set
 * before `computeNextWave` runs, and there must not be a second, laxer way to
 * obtain one. `readClaimList` is the door `wave check` refuses through; a CLI
 * that reached past it — `(t.claims ?? []) as string[]` is the obvious
 * shortcut — would hand the symbol graph a claims string to iterate by
 * character, and a task claiming nothing crosses nobody. The wave would then
 * be admitted for the one reason it must not be: the check could not read it.
 *
 * Terminal tasks are kept. The graph is built over the whole live plan
 * because a crossing with an in-flight task is exactly the crossing that has
 * to defer a candidate, and a caller cannot know which tasks are in flight
 * until `computeNextWave` has partitioned them by status.
 */
export function liveWaveTasks(plan: PlanFile): WaveTask[] {
  return livePlanTasks(plan).map((record) => readClaimList(proposedFrom(record)));
}

/**
 * The plan record as `readClaimList` wants it: claims always, the
 * `keeps_exports` promise only when the record has one, so a task that
 * promised nothing reads back without the key rather than with `undefined`.
 */
function proposedFrom(record: TaskSpecRecord): ProposedWaveTask {
  const { claims, keeps_exports } = record as { claims?: unknown; keeps_exports?: unknown };
  return keeps_exports === undefined
    ? { task_id: record.task_id, claims }
    : { task_id: record.task_id, claims, keeps_exports };
}

interface Coupling {
  /** The deferred task's side of the crossing. */
  role: 'consumes' | 'produces';
  crossing: SymbolCouplingEdge;
}

const NAMED_SYMBOLS = 3;

/**
 * The deferral names both files and both remedies, because the operator's
 * choice is between them: order the tasks, or have the producer promise the
 * exporting file in `keeps_exports` (impact.ts verifies it post-run). Only
 * the producer can promise, so the sentence names the producer either way.
 */
function describeCoupling(taskId: string, blocker: string, coupling: Coupling): string {
  const { crossing, role } = coupling;
  const shown = crossing.symbols.slice(0, NAMED_SYMBOLS);
  const symbols = [...shown, ...(crossing.symbols.length > NAMED_SYMBOLS ? ['…'] : [])].join(', ');
  const typeOnly = crossing.typeOnly ? ', type-only' : '';
  return role === 'consumes'
    ? `Imports ${symbols} from ${crossing.exportedBy} (${blocker}) into ${crossing.importedBy}${typeOnly}: ` +
        `the producer runs first, or ${blocker} promises the file in keeps_exports and both run now.`
    : `${blocker} imports ${symbols} from ${crossing.exportedBy} into ${crossing.importedBy}${typeOnly}${typeOnly ? ',' : ''} ` +
        `and is already scheduled, so this one follows, or ${taskId} promises the file in keeps_exports and both run now.`;
}

export function computeNextWave(input: NextWaveInput): NextWaveResult {
  const { plan, policy } = input;
  const crossings = input.crossings ?? [];
  const edges = readEdgeList(plan.edges);

  const done: string[] = [];
  const occupied: string[] = [];
  const occupiedTasks: WaveTask[] = [];
  const candidates: WaveTask[] = [];

  for (const record of livePlanTasks(plan)) {
    const id = record.task_id;
    const status = input.statusById?.get(id) ?? String(record.task_status);
    // *Done* here is the narrow question — the work ended well, so the
    // worktree is free. Its neighbour in taskStatus.ts, TERMINAL_TASK_STATUSES,
    // answers a different one — which rows the log refuses to overwrite — and
    // holds `failed` and `escalated` too. Those are waiting on a person, not
    // on nothing, and their uncommitted work is exactly what a second agent in
    // the same paths would destroy: reading that set here is a data-loss bug,
    // and this file carried its own copy of this one under *that* name until
    // both answers moved to the module that owns the dimension.
    // (`superseded` is in neither conversation: livePlanTasks drops an id
    // whose every record is superseded, so one never reaches this line.)
    if (TERMINAL_OK_TASK_STATUSES.has(status)) {
      done.push(id);
      continue;
    }
    // Past this door claims are a real string[], for a candidate and for a
    // task merely holding ground — the wave is unanswerable either way.
    const task = readClaimList(proposedFrom(record));
    if (CANDIDATE_TASK_STATUSES.has(status)) {
      candidates.push(task);
    } else {
      occupied.push(id);
      occupiedTasks.push(task);
    }
  }
  done.sort();
  occupied.sort();

  const doneSet = new Set(done);
  const dependsByTask = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependsByTask.get(edge.task) ?? [];
    list.push(edge.dependsOn);
    dependsByTask.set(edge.task, list);
  }

  // task -> (other task -> the first crossing between them, and this task's
  // side of it). First wins: the caller hands crossings in a stable order,
  // and one named crossing is what the deferral renders.
  const coupledWith = new Map<string, Map<string, Coupling>>();
  const link = (a: string, b: string, coupling: Coupling): void => {
    const map = coupledWith.get(a) ?? new Map<string, Coupling>();
    if (!map.has(b)) map.set(b, coupling);
    coupledWith.set(a, map);
  };
  for (const crossing of crossings) {
    link(crossing.consumer, crossing.producer, { role: 'consumes', crossing });
    link(crossing.producer, crossing.consumer, { role: 'produces', crossing });
  }

  const admitted: WaveTask[] = [];
  const deferred: WaveDeferral[] = [];
  const defer = (taskId: string, reason: DeferralReason, blockedBy: string[], detail: string) => {
    deferred.push({ taskId, reason, blockedBy: [...blockedBy].sort(), detail });
  };

  for (const task of admissionOrder(candidates, edges, crossings)) {
    const id = task.task_id;

    const pending = [...new Set(dependsByTask.get(id) ?? [])].filter((d) => !doneSet.has(d)).sort();
    if (pending.length > 0) {
      defer(
        id,
        'dependency-pending',
        pending,
        `Depends on ${nameList(pending)}, which ${pending.length === 1 ? 'is' : 'are'} not terminal.`,
      );
      continue;
    }

    // Occupied tasks hold their claims for the same reason admitted ones do:
    // a worktree exists and its edits are not merged.
    const holders = [...admitted, ...occupiedTasks];

    const overlapping: string[] = [];
    let overlapDetail = '';
    for (const holder of holders) {
      const overlap = claimsOverlap(task, holder);
      if (!overlap.overlaps) continue;
      overlapping.push(holder.task_id);
      const pair = overlap.offendingGlobs[0];
      if (overlapDetail === '' && pair !== undefined) {
        overlapDetail = `Claims overlap ${holder.task_id} (${pair.globA} vs ${pair.globB}).`;
      }
    }
    if (overlapping.length > 0) {
      defer(id, 'claim-overlap', overlapping, overlapDetail);
      continue;
    }

    const hotspots = touchesSerializeAlways(task, policy.serializeAlwaysGlobs);
    const sharing: string[] = [];
    let hotspotDetail = '';
    if (hotspots.length > 0) {
      for (const holder of holders) {
        const glob = touchesSerializeAlways(holder, hotspots)[0];
        if (glob === undefined) continue;
        sharing.push(holder.task_id);
        if (hotspotDetail === '') {
          hotspotDetail =
            `Shares the serialize-always glob ${glob} with ${holder.task_id}, ` +
            'which worktree.yml never schedules concurrently.';
        }
      }
    }
    if (sharing.length > 0) {
      defer(id, 'serialize-hotspot', sharing, hotspotDetail);
      continue;
    }

    const couplings = coupledWith.get(id);
    const coupled = couplings ? holders.filter((h) => couplings.has(h.task_id)) : [];
    const blocker = coupled[0];
    const coupling = couplings?.get(blocker?.task_id ?? '');
    if (blocker !== undefined && coupling !== undefined) {
      defer(
        id,
        'symbol-coupled',
        coupled.map((h) => h.task_id),
        describeCoupling(id, blocker.task_id, coupling),
      );
      continue;
    }

    admitted.push(task);
  }

  deferred.sort((a, b) => a.taskId.localeCompare(b.taskId));

  return {
    epicId: plan.epic_id,
    wave: admitted.map((t) => t.task_id),
    deferred,
    done,
    occupied,
    remaining: deferred.length + occupied.length,
  };
}
