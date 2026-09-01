// The §10 dashboard page queries, each a typed function over the
// projection tables in db/schema.ts. Every function accepts a `SmithDb`
// (see db/projector.ts's openDb()) plus an optional session scope — when
// omitted, a query spans every projected session (a single Blacksmith
// instance is one continuously-running factory, so "no session filter"
// is the normal case; a session filter is for debugging one run).
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { isOperatorActor } from '../actors.js';
import {
  foldAgents,
  liveAgents as foldLiveAgents,
  REGISTRY_EVENT_TYPES,
} from '../agents-registry.js';
import { compareLogOrder, isLaterEvent } from '../events.js';
import { waveLayers } from '../graph.js';
import { judgeFailureKind } from '../providers/types.js';
import { severityRank } from '../severity.js';
import { epicOfTaskId, taskIdsMatch } from '../taskId.js';
import { loadTaxonomy, type Taxonomy } from '../taxonomy.js';
import type { SmithDb } from './projector.js';
import {
  agents,
  artifacts,
  dispatches,
  edges,
  epics,
  errors,
  eventsRaw,
  findings,
  lessons,
  milestones,
  prompts,
  sessions,
  tasks,
  waivers,
} from './schema.js';

/** Phase 6b default: every event/task/etc. logged before the project dimension existed. */
export const DEFAULT_PROJECT = 'black-smith';

export interface Scope {
  sessionId?: string;
  /**
   * Phase 6b — a plain-string project identifier (architecture §8 note: NOT
   * a taxonomy.yml vocabulary value). Omitted => "global mode": spans every
   * project (old behaviour, unchanged). Every `project` column is nullable
   * for migration safety (rows logged before Phase 6b) — every comparison
   * in this file goes through `filterByProject()`/`projectOf()`, which
   * normalize a null column to DEFAULT_PROJECT first, so old/untagged rows
   * are treated as belonging to the default project rather than falling
   * into an unfiltered null bucket.
   *
   * That normalization only holds for rows that ARE the thing being scoped —
   * a `tasks` row, an `errors` row, anything the projector tags from the
   * event that created it. A row whose project is really its parent's must
   * be scoped through that parent instead: a `task-result-recorded` or a
   * `dispatch_decision` belongs to whatever project its TASK belongs to, and
   * before Phase 6b it carried no project of its own, so normalizing the
   * null moves it silently into `default`'s totals (D-170).
   */
  project?: string;
}

/**
 * `null` (never-tagged, pre-Phase-6b) reads as DEFAULT_PROJECT, same as the
 * schema.ts columns' doc comment promises. Project scoping is applied
 * JS-side, after a (session-scoped) row fetch, everywhere in this file —
 * dataset sizes here are "one local factory's projection tables", not a
 * multi-tenant SaaS table, so this is the §-ladder "reuse the existing
 * pattern" choice over hand-writing a COALESCE into every one of this
 * file's ~15 query shapes (and it composes for free with every function
 * below that already builds its own JS-side Maps/aggregations from a rows
 * array — one filter step ahead of the aggregation, not a SQL rewrite).
 */
function projectOf(value: string | null): string {
  return value ?? DEFAULT_PROJECT;
}

/** Filters an already-fetched row array to `scope.project`; a no-op in global mode (project omitted). */
function filterByProject<T extends { project: string | null }>(rows: T[], scope: Scope): T[] {
  return scope.project !== undefined
    ? rows.filter((r) => projectOf(r.project) === scope.project)
    : rows;
}

/** Rows in the order the log wrote them, oldest first. Never mutates the input. */
function inLogOrder<T extends { ts: string; eventId: string }>(rows: readonly T[]): T[] {
  return rows.slice().sort(compareLogOrder);
}

/** Every distinct project value present across the row sets, DEFAULT_PROJECT-normalized, sorted. */
function distinctProjects(
  ...rowSets: ReadonlyArray<ReadonlyArray<{ project: string | null }>>
): string[] {
  return [...new Set(rowSets.flat().map((r) => projectOf(r.project)))].sort();
}

// ---------------------------------------------------------------------------
// overview()
// ---------------------------------------------------------------------------

export interface LiveAgentGroup {
  agentRole: string;
  provider: string;
  modelTier: string;
  count: number;
}

/**
 * Phase 6b round 4 (operator directive): one row per live agent, not
 * grouped by role/provider/tier — the compact 2-column "Live agents" card
 * needs each running agent's own task id (and dispatch time, for the
 * elapsed-time tooltip), which `LiveAgentGroup`'s counts-only shape can't
 * carry. Additive alongside `liveAgents` (unchanged, still used by
 * `queries.test.ts`/`cli.test.ts`), not a replacement.
 */
export interface LiveAgentEntry {
  id: string;
  /**
   * Dogfood round 2 — which run dispatched this agent. `agents` rows stay
   * `live` until a terminal event closes them out, so a single Overview can
   * hold rows from several sessions at once (in the real state/smith.db, from
   * sessions days apart). Without this the UI cannot tell a row belonging to
   * the run happening now from one left behind by a run that ended.
   */
  sessionId: string;
  agentRole: string;
  provider: string;
  modelTier: string;
  taskId: string | null;
  /**
   * The epic this agent works on. An epic-level dispatch — planner,
   * spec-reviewer, scribe, epic-close judge — names one and has no task at
   * all, which is the only thing that stops the UI reading `taskId: null` and
   * rendering "no task assigned" for half the live fleet (D-234).
   */
  epicId: string | null;
  dispatchedAt: string;
}

/**
 * One projected session, with just enough context for the Overview's "Now
 * running" card to say what that run is doing (dogfood round 2 operator
 * directive: "nên thay thông tin trong block now running bằng các session
 * đang chạy hiện tại").
 *
 * There is no `session-ended` event anywhere in the vocabulary, so this query
 * cannot report "running" as a fact — it reports `lastEventAt`, and the UI
 * (ui/src/lib/liveness.ts sessionActivity()) decides how recent still counts
 * as active. Every field here is evidence the operator can check, not a
 * verdict the query invented.
 */
export interface RunningSession {
  sessionId: string;
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  /** `agents` rows still `live` for this session — scoped exactly like liveAgentCount. */
  liveAgentCount: number;
  /** The most recent event's type — what this session just did. Null if its events are gone. */
  lastEventType: string | null;
  /**
   * Projects this session's tasks belong to, sorted. `sessions` has no
   * project column of its own (schema.ts), so project membership is derived
   * from the session's tasks — a session that has not created a task yet
   * belongs to no project, and is therefore invisible under a project scope.
   */
  projects: string[];
}

export interface EpicTokenSpend {
  epicId: string;
  tokensSpent: number;
  tokensBudget: number | null;
}

export interface MilestoneProgress {
  milestoneId: string;
  name: string;
  status: string;
  sequence: number;
  goal: string | null;
  epicIds: string[];
  tasksTotal: number;
  tasksCompleted: number;
  tokensSpent: number;
  tokensBudget: number | null;
  /** Phase 6b — the milestone's own project (roadmap.md's `- project:` bullet, defaults 'black-smith'). */
  project: string;
  /**
   * Phase 6b, operator directive 4 (mini-timeline): up to 3 most-recently-
   * completed tasks and up to 3 next-up tasks for this milestone, in plan/
   * dependency order. `null` when milestoneProgressRows() didn't compute it
   * (only roadmapPage()'s callers ask for it — overview()'s summary card
   * doesn't need the per-task drilldown).
   */
  recentDone?: MilestoneTaskRef[];
  nextUp?: MilestoneTaskRef[];
}

export interface MilestoneTaskRef {
  taskId: string;
  taskStatus: string;
  /** Phase 6b round 3 (operator directive 4) — tasks.objective, for the Roadmap mini-timeline's truncated-title row (falls back to taskId when null). */
  title: string | null;
  updatedAt: string;
  /** True when every dependency this task has (edges.dependsOn) is already terminal-complete. */
  dependencyReady: boolean;
}

/** Phase 6b — one project's slice of overview(), used for the hub's per-project breakdown. */
/**
 * D-43/P9-27. An epic that was closed, and how — folded from `epic-closed`
 * (db/projector.ts's foldEpics). The override fields matter more than the
 * verdict: an operator-override close is precisely the case where tasks stay
 * non-terminal, so before this existed those epics read as "in flight"
 * forever, and the one thing a reader needed — that a human closed over the
 * machine's hold, and why — was nowhere on any surface.
 */
export interface ClosedEpic {
  epicId: string;
  closedBy: string;
  machineVerdict: string | null;
  machineReason: string | null;
  overrideRationale: string | null;
  blockers: string[];
  closedAt: string;
}

export interface ProjectOverviewSummary {
  project: string;
  liveAgentCount: number;
  epicsInFlight: string[];
  tokensSpent: number;
  tokensBudget: number | null;
  alerts: { escalations: number; pendingWaivers: number };
}

export interface OverviewResult {
  liveAgents: LiveAgentGroup[];
  /** Phase 6b round 4 — per-agent rows for the compact "Live agents" card (see LiveAgentEntry). */
  liveAgentEntries: LiveAgentEntry[];
  liveAgentCount: number;
  /** Dogfood round 2 — every projected session, most recently active first (see RunningSession). */
  runningSessions: RunningSession[];
  /** Epics with non-terminal work AND no close on the log — see closedEpics. */
  epicsInFlight: string[];
  /** D-43/P9-27: every epic the log says was closed, newest close first. */
  closedEpics: ClosedEpic[];
  tokensByEpic: EpicTokenSpend[];
  alerts: { escalations: number; pendingWaivers: number };
  milestoneProgress: MilestoneProgress[];
  /** Phase 6b (closes the 6a DESIGN.md deviation): the 10 most recent dispatch_decisions, newest first. */
  recentDispatches: RecentDispatch[];
  /** Phase 6b StatCard deltas: liveAgentCount minus its value 5 minutes ago. */
  liveAgentCountDelta5m: number;
  /** Phase 6b StatCard deltas: budget-used percentage-point change vs 1 hour ago; null with no known budget. */
  budgetUsedPctPointDelta1h: number | null;
  /**
   * Phase 6b "global mode": present whenever this call spans more than one
   * project (i.e. `scope.project` was omitted) — one summary per distinct
   * project seen in the data, sorted by project id. A single-project-scoped
   * call (scope.project set) omits this (nothing to break down).
   */
  projects?: ProjectOverviewSummary[];
}

interface TaskResultPayload {
  task_id?: string;
  token_usage?: { total_tokens?: number };
}

const NON_TERMINAL_TASK_STATUSES = [
  'todo',
  'ready',
  'in-progress',
  'grading',
  'reviewing',
  'merging',
  'blocked',
];

/** Every `tasks` row for `scope`, session-filtered in SQL and project-filtered in JS. */
function allTasksForScope(db: SmithDb, scope: Scope): (typeof tasks.$inferSelect)[] {
  const rows = scope.sessionId
    ? db.select().from(tasks).where(eq(tasks.sessionId, scope.sessionId)).all()
    : db.select().from(tasks).all();
  return filterByProject(rows, scope);
}

/**
 * A predicate for "this event belongs to `scope.project`", answered through
 * the event's TASK rather than through its own `project` column.
 *
 * That route is the rule the `Scope.project` doc comment states and D-170
 * paid for: a `task-result-recorded` carries no project of its own on any row
 * logged before Phase 6b, so normalizing its null to `default` files real
 * spend under a project that never incurred it. The task row is the thing the
 * projector actually tagged, and `allTasksForScope` has already scoped it.
 *
 * Membership asks `taskIdsMatch`, not `Set.has` (D-130/D-143): the log spells
 * the same task both qualified and bare, and a raw comparison drops the bare
 * rows into no project at all — a partition that silently loses rows reads as
 * a smaller number, not as an error. The Set is only the exact-match fast
 * path in front of it.
 *
 * Global mode (no project) admits everything, including rows that name no
 * task — unchanged behaviour, and the honest one: an untasked row still
 * belongs to the whole.
 */
function taskInScope(db: SmithDb, scope: Scope): (taskId: string | null | undefined) => boolean {
  if (scope.project === undefined) return () => true;
  const scopedIds = allTasksForScope(db, scope).map((t) => t.taskId);
  const exact = new Set(scopedIds);
  return (taskId) =>
    typeof taskId === 'string' &&
    (exact.has(taskId) || scopedIds.some((id) => taskIdsMatch(taskId, id)));
}

/**
 * A worker's Result, paired with the task id its *envelope* named. The
 * payload's own `task_id` is the primary claim and the envelope is the
 * fallback (D-207): a real row in today's log — `envkit-mcp-surface/
 * task-3-env-lint` — omits it from the payload while the envelope carries it
 * qualified, and the projector stores that id in `events_raw.task_id`, so the
 * claim is there to be read. (Since D-245 the projector fills that column with
 * `eventTaskId`, envelope first and payload second, so the column is never
 * emptier than the record — never fuller with a different id, either: no
 * `task-result-recorded` row in today's log names two different tasks.)
 */
interface TaskResultRow {
  payload: TaskResultPayload;
  envelopeTaskId: string | null;
}

function taskResultRows(db: SmithDb, scope: Scope): TaskResultRow[] {
  const cols = { payload: eventsRaw.payload, envelopeTaskId: eventsRaw.taskId };
  const rows = scope.sessionId
    ? db
        .select(cols)
        .from(eventsRaw)
        .where(
          and(
            eq(eventsRaw.eventType, 'task-result-recorded'),
            eq(eventsRaw.sessionId, scope.sessionId),
          ),
        )
        .all()
    : db.select(cols).from(eventsRaw).where(eq(eventsRaw.eventType, 'task-result-recorded')).all();
  return rows.map((r) => ({
    payload: JSON.parse(r.payload) as TaskResultPayload,
    envelopeTaskId: r.envelopeTaskId,
  }));
}

/** The task a Result names, payload first, envelope second. */
function resultTaskId(row: TaskResultRow): string | undefined {
  return row.payload.task_id ?? row.envelopeTaskId ?? undefined;
}

/**
 * Resolves the task a Result names to the epic that owns it, against a map
 * keyed by the tasks table's ids.
 *
 * Exact first, then `taskIdsMatch` (D-130/D-143), for the same reason
 * `taskInScope` above folds: the log spells one task both qualified and bare,
 * and today's `state/events` has two `task-result-recorded` rows spelled bare
 * against a tasks table that knows them qualified. An exact `Map.get` drops
 * those rows out of per-epic spend entirely, and a partition that silently
 * loses rows reads as a smaller number, not as an error.
 *
 * Where this deliberately differs from `taskInScope`: an ambiguous bare id —
 * one that folds onto tasks in **two** epics — resolves to neither. Folding is
 * free for a membership predicate, which can only say yes once; a sum counted
 * into both epics would invent spend on the epic that did not incur it and
 * make the per-epic column add up to more than the run. Under-counting an
 * ambiguity is recoverable; over-counting it is a number nobody can reconcile.
 */
function epicResolver(
  epicByTask: Map<string, string>,
): (taskId: string | undefined) => string | undefined {
  const keys = [...epicByTask.keys()];
  return (taskId) => {
    if (taskId === undefined) return undefined;
    const exact = epicByTask.get(taskId);
    if (exact !== undefined) return exact;
    const matched = new Set(
      keys.filter((id) => taskIdsMatch(taskId, id)).map((id) => epicByTask.get(id) as string),
    );
    return matched.size === 1 ? [...matched][0] : undefined;
  };
}

/**
 * Per-epic budget (sum of tasks.budgetTokens) and spend (sum of
 * task-result-recorded token_usage for that epic's tasks) — shared by
 * overview()'s tokensByEpic and roadmapPage()'s per-milestone token roll-up,
 * so the two views never compute the same numbers two different ways.
 *
 * Attribution goes through `epicResolver` (D-207), not a raw `Map.get`: on
 * today's real log that raw lookup dropped 1,585,899 tokens of
 * `envkit-mcp-surface` spend on the floor, because two of its Results spell
 * the task id bare and one omits it from the payload.
 */
function epicTokenMaps(
  db: SmithDb,
  scope: Scope,
  taskRows: (typeof tasks.$inferSelect)[],
): { budgetByEpic: Map<string, number>; spentByEpic: Map<string, number> } {
  const budgetByEpic = new Map<string, number>();
  const epicByTask = new Map<string, string>();
  for (const t of taskRows) {
    if (!t.epicId) continue;
    epicByTask.set(t.taskId, t.epicId);
    if (t.budgetTokens !== null) {
      budgetByEpic.set(t.epicId, (budgetByEpic.get(t.epicId) ?? 0) + t.budgetTokens);
    }
  }

  const epicOf = epicResolver(epicByTask);
  const spentByEpic = new Map<string, number>();
  for (const row of taskResultRows(db, scope)) {
    const epicId = epicOf(resultTaskId(row));
    if (!epicId) continue;
    const total = row.payload.token_usage?.total_tokens ?? 0;
    spentByEpic.set(epicId, (spentByEpic.get(epicId) ?? 0) + total);
  }

  return { budgetByEpic, spentByEpic };
}

const MILESTONE_COMPLETE_TASK_STATUSES = new Set(['completed', 'waived']);
const MILESTONE_NEXT_EXCLUDED_STATUSES = new Set(['completed', 'waived', 'failed', 'superseded']);
const MINI_TIMELINE_LIMIT = 3;

/**
 * Operator directive 4 (Phase 6b, ui/docs/design-spec.md addendum): up to 3
 * most-recent DONE tasks (success tone) and 3 NEXT tasks (plan/dependency
 * order) per milestone, for the Roadmap page's mini-timeline row under each
 * progress bar. `dependencyReady` = every edge this task depends on
 * (edges.dependsOn) already points at a completed/waived task.
 */
function milestoneTaskRefs(
  milestoneTasks: (typeof tasks.$inferSelect)[],
  allTaskRows: (typeof tasks.$inferSelect)[],
  edgeRows: (typeof edges.$inferSelect)[],
): { recentDone: MilestoneTaskRef[]; nextUp: MilestoneTaskRef[] } {
  const statusById = new Map(allTaskRows.map((t) => [t.taskId, t.taskStatus]));
  const dependsOnByTask = new Map<string, string[]>();
  for (const e of edgeRows) {
    const list = dependsOnByTask.get(e.taskId) ?? [];
    list.push(e.dependsOn);
    dependsOnByTask.set(e.taskId, list);
  }
  const dependencyReady = (taskId: string): boolean =>
    (dependsOnByTask.get(taskId) ?? []).every((dep) => {
      const status = statusById.get(dep);
      return status !== undefined && MILESTONE_COMPLETE_TASK_STATUSES.has(status);
    });

  const recentDone = milestoneTasks
    .filter((t) => MILESTONE_COMPLETE_TASK_STATUSES.has(t.taskStatus))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MINI_TIMELINE_LIMIT)
    .map((t) => ({
      taskId: t.taskId,
      taskStatus: t.taskStatus,
      title: t.objective,
      updatedAt: t.updatedAt,
      dependencyReady: true,
    }));

  const nextUp = milestoneTasks
    .filter((t) => !MILESTONE_NEXT_EXCLUDED_STATUSES.has(t.taskStatus))
    .map((row) => ({ row, ready: dependencyReady(row.taskId) }))
    // Dependency-ready tasks first (plan/dependency order), then oldest-created
    // first within each group -- `createdAt`, because db/projector.ts's touch()
    // rewrites `updatedAt` on every event carrying the task id: ordering NEXT
    // by it sank the first-planned task below a later one the moment it was
    // dispatched, which is when the operator most expects to see it at the top.
    .sort((a, b) => {
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      return a.row.createdAt.localeCompare(b.row.createdAt);
    })
    .slice(0, MINI_TIMELINE_LIMIT)
    .map(({ row, ready }) => ({
      taskId: row.taskId,
      taskStatus: row.taskStatus,
      title: row.objective,
      updatedAt: row.updatedAt,
      dependencyReady: ready,
    }));

  return { recentDone, nextUp };
}

/**
 * Join factory/specs/roadmap.md's milestones (db/schema.ts's `milestones`
 * table) with each milestone's mapped epics' task/token stats. A milestone
 * with no epics mapped yet (roadmap.md's `epics: []`) reports zero tasks —
 * not an error, just "nothing tagged to this phase yet". `scope.project`
 * filters to milestones whose OWN `- project:` tag matches (milestones are
 * declared per-project, not derived from their epics' tasks).
 */
function milestoneProgressRows(
  db: SmithDb,
  scope: Scope = {},
  opts: { includeTaskRefs?: boolean } = {},
): MilestoneProgress[] {
  const allMilestoneRows = db.select().from(milestones).orderBy(milestones.sequence).all();
  const milestoneRows =
    scope.project !== undefined
      ? allMilestoneRows.filter((m) => m.project === scope.project)
      : allMilestoneRows;
  if (milestoneRows.length === 0) return [];

  const taskRows = allTasksForScope(db, scope);
  const { budgetByEpic, spentByEpic } = epicTokenMaps(db, scope, taskRows);
  const edgeRows = opts.includeTaskRefs
    ? scope.sessionId
      ? db.select().from(edges).where(eq(edges.sessionId, scope.sessionId)).all()
      : db.select().from(edges).all()
    : [];

  return milestoneRows.map((m) => {
    const epicIds = JSON.parse(m.epicIds) as string[];
    const epicSet = new Set(epicIds);
    const milestoneTasks = taskRows.filter((t) => t.epicId !== null && epicSet.has(t.epicId));
    const tasksCompleted = milestoneTasks.filter((t) =>
      MILESTONE_COMPLETE_TASK_STATUSES.has(t.taskStatus),
    ).length;

    let tokensSpent = 0;
    let tokensBudget = 0;
    let hasBudget = false;
    for (const epicId of epicIds) {
      tokensSpent += spentByEpic.get(epicId) ?? 0;
      const budget = budgetByEpic.get(epicId);
      if (budget !== undefined) {
        tokensBudget += budget;
        hasBudget = true;
      }
    }

    const refs = opts.includeTaskRefs
      ? milestoneTaskRefs(milestoneTasks, taskRows, edgeRows)
      : undefined;

    return {
      milestoneId: m.milestoneId,
      name: m.name,
      status: m.status,
      sequence: m.sequence,
      goal: m.goal,
      epicIds,
      tasksTotal: milestoneTasks.length,
      tasksCompleted,
      tokensSpent,
      tokensBudget: hasBudget ? tokensBudget : null,
      project: m.project,
      ...(refs ? { recentDone: refs.recentDone, nextUp: refs.nextUp } : {}),
    };
  });
}

/** Roadmap page (§5.4): every milestone with its progress + mini-timeline, in roadmap.md order. */
export function roadmapPage(db: SmithDb, scope: Scope = {}): MilestoneProgress[] {
  return milestoneProgressRows(db, scope, { includeTaskRefs: true });
}

/** Phase 6b (6a deviation closed): a recent dispatch_decision, for Overview's "Recent dispatch decisions" card. */
export interface RecentDispatch {
  eventId: string;
  ts: string;
  agentRole: string;
  provider: string;
  modelTier: string;
  taskId: string | null;
  reason: string | null;
}

const RECENT_DISPATCHES_LIMIT = 10;

function allFindingsForScope(db: SmithDb, scope: Scope): (typeof findings.$inferSelect)[] {
  const rows = scope.sessionId
    ? db.select().from(findings).where(eq(findings.sessionId, scope.sessionId)).all()
    : db.select().from(findings).all();
  return filterByProject(rows, scope);
}

function allAgentsForScope(db: SmithDb, scope: Scope): (typeof agents.$inferSelect)[] {
  // agents has no project column of its own (schema.ts) — scope it by
  // membership in this scope's own task set (agents.taskId -> tasks.project),
  // the same "derive via the owning task" approach projectFindings() uses.
  const liveRows = scope.sessionId
    ? db
        .select()
        .from(agents)
        .where(and(eq(agents.status, 'live'), eq(agents.sessionId, scope.sessionId)))
        .all()
    : db.select().from(agents).where(eq(agents.status, 'live')).all();
  if (scope.project === undefined) return liveRows;
  const scopedTasks = allTasksForScope(db, scope);
  const scopedEpics = new Set(scopedTasks.flatMap((t) => (t.epicId === null ? [] : [t.epicId])));
  // A task OR an epic places a row. Half the dispatches in a real run name an
  // epic and no task at all — a planner, a spec-reviewer, a scribe, the
  // epic-close judges — and matching on the task alone dropped every one of
  // them the moment a project was selected (D-234).
  //
  // taskIdsMatch, not Set.has: the log spells the same task both qualified
  // and bare, and a spelling difference is not a different task (D-130/D-143).
  return liveRows.filter((a) => {
    if (a.epicId !== null && scopedEpics.has(a.epicId)) return true;
    return a.taskId !== null && scopedTasks.some((t) => taskIdsMatch(a.taskId as string, t.taskId));
  });
}

/**
 * Every projected session, most recently active first.
 *
 * Why the Overview needs this at all (dogfood round 2): the "Now running"
 * card was built from `liveAgentEntries`, and an `agents` row stays `live`
 * until a terminal event closes it out — which never happens for a run that
 * was killed, crashed, or simply ended without one. In the real
 * state/smith.db that left the card permanently filled with rows dispatched
 * days earlier, so it never changed no matter what the factory was doing.
 * Sessions are the honest unit: `lastEventAt` moves every time anything at
 * all is appended.
 *
 * Ties on `lastEventAt` break on `sessionId` so the order is stable under the
 * dashboard's 5s poll rather than shuffling between renders.
 */
export function runningSessions(db: SmithDb, scope: Scope = {}): RunningSession[] {
  const rows = scope.sessionId
    ? db.select().from(sessions).where(eq(sessions.sessionId, scope.sessionId)).all()
    : db.select().from(sessions).all();

  const liveBySession = new Map<string, number>();
  for (const a of allAgentsForScope(db, scope)) {
    liveBySession.set(a.sessionId, (liveBySession.get(a.sessionId) ?? 0) + 1);
  }

  const projectsBySession = new Map<string, Set<string>>();
  for (const t of allTasksForScope(db, scope)) {
    const set = projectsBySession.get(t.sessionId) ?? new Set<string>();
    set.add(projectOf(t.project));
    projectsBySession.set(t.sessionId, set);
  }

  // What each session did most recently. events_raw is not guaranteed to come
  // back in ts order, so the latest row is chosen by comparison rather than by
  // trusting scan order — and isLaterEvent settles a tie on ts the same way
  // pulse() does, which is what lets the two agree about one session.
  const lastEvent = new Map<string, { ts: string; eventType: string; eventId: string }>();
  const eventQuery = db
    .select({
      sessionId: eventsRaw.sessionId,
      ts: eventsRaw.ts,
      eventType: eventsRaw.eventType,
      eventId: eventsRaw.eventId,
    })
    .from(eventsRaw);
  for (const e of scope.sessionId
    ? eventQuery.where(eq(eventsRaw.sessionId, scope.sessionId)).all()
    : eventQuery.all()) {
    const seen = lastEvent.get(e.sessionId);
    if (seen === undefined || isLaterEvent(e, seen)) lastEvent.set(e.sessionId, e);
  }

  return (
    rows
      .map((s) => ({
        sessionId: s.sessionId,
        startedAt: s.startedAt,
        lastEventAt: s.lastEventAt,
        eventCount: s.eventCount,
        liveAgentCount: liveBySession.get(s.sessionId) ?? 0,
        lastEventType: lastEvent.get(s.sessionId)?.eventType ?? null,
        projects: [...(projectsBySession.get(s.sessionId) ?? [])].sort(),
      }))
      // Under a project scope, a session belongs to the project only through
      // its tasks — one with none (a run that has not planned anything yet) is
      // not this project's business, and would otherwise show up in every
      // project's Overview at once.
      .filter((s) => scope.project === undefined || s.projects.length > 0)
      .sort(
        (a, b) =>
          b.lastEventAt.localeCompare(a.lastEventAt) || a.sessionId.localeCompare(b.sessionId),
      )
  );
}

function groupLiveAgents(rows: (typeof agents.$inferSelect)[]): LiveAgentGroup[] {
  const grouped = new Map<string, LiveAgentGroup>();
  for (const row of rows) {
    const key = `${row.agentRole}|${row.provider}|${row.modelTier}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else {
      grouped.set(key, {
        agentRole: row.agentRole,
        provider: row.provider,
        modelTier: row.modelTier,
        count: 1,
      });
    }
  }
  return [...grouped.values()];
}

/**
 * Every closed epic in scope, newest close first (D-43/P9-27). One reader for
 * both overview() and projectSummary(), so "in flight" can never mean two
 * different things depending on which card you're looking at.
 */
function closedEpicsForScope(db: SmithDb, scope: Scope): ClosedEpic[] {
  const rows = scope.sessionId
    ? db.select().from(epics).where(eq(epics.sessionId, scope.sessionId)).all()
    : db.select().from(epics).all();
  return filterByProject(rows, scope)
    .map((e) => ({
      epicId: e.epicId,
      closedBy: e.closedBy,
      machineVerdict: e.machineVerdict,
      machineReason: e.machineReason,
      overrideRationale: e.overrideRationale,
      blockers: e.blockers ? (JSON.parse(e.blockers) as string[]) : [],
      closedAt: e.closedAt,
    }))
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
}

/**
 * D-43/P9-27: "in flight" used to mean "has a non-terminal task", full stop —
 * so an epic closed by an operator overriding a hold (exactly the case where a
 * task stays non-terminal) read as in flight forever. A close on the log ends
 * the flight, whatever the task rows still say.
 */
function inFlightEpics(
  taskRows: readonly { epicId: string | null; taskStatus: string }[],
  closed: readonly ClosedEpic[],
): string[] {
  const closedIds = new Set(closed.map((e) => e.epicId));
  return [
    ...new Set(
      taskRows
        .filter(
          (t) =>
            t.epicId &&
            NON_TERMINAL_TASK_STATUSES.includes(t.taskStatus) &&
            !closedIds.has(t.epicId),
        )
        .map((t) => t.epicId as string),
    ),
  ].sort();
}

/** One project's overview slice, computed by the same logic overview() itself uses (no drift). */
function projectSummary(db: SmithDb, project: string, baseScope: Scope): ProjectOverviewSummary {
  const scope: Scope = { ...baseScope, project };
  const liveRows = allAgentsForScope(db, scope);
  const taskRows = allTasksForScope(db, scope);
  const epicsInFlight = inFlightEpics(taskRows, closedEpicsForScope(db, scope));
  const { budgetByEpic, spentByEpic } = epicTokenMaps(db, scope, taskRows);
  const tokensSpent = [...spentByEpic.values()].reduce((s, v) => s + v, 0);
  const tokensBudget =
    budgetByEpic.size > 0 ? [...budgetByEpic.values()].reduce((s, v) => s + v, 0) : null;
  const escalations = taskRows.filter((t) => t.taskStatus === 'escalated').length;
  const findingRows = allFindingsForScope(db, scope).filter(
    (f) =>
      (f.severity === 'S3-minor' || f.severity === 'S4-nit') &&
      (f.findingStatus === 'raised' || f.findingStatus === 'confirmed'),
  );
  const pendingWaivers = findingRows.filter((f) => f.waiverId === null).length;

  return {
    project,
    liveAgentCount: liveRows.length,
    epicsInFlight,
    tokensSpent,
    tokensBudget,
    alerts: { escalations, pendingWaivers },
  };
}

// D-161: the fold's own alphabet, not a hand-copied subset of it. The list
// here used to omit `judge-reported`, so the slice fed to foldAgents() below
// contained judges being dispatched and never reporting — every judge that
// ever ran stayed live in the historical count, and the delta reported a drop
// that never happened.
const SNAPSHOT_EVENT_TYPES = REGISTRY_EVENT_TYPES as readonly string[];

/**
 * Phase 6b StatCard deltas (6a DESIGN.md deviation closed): live-agent count
 * as of `cutoffIso`, reconstructed by re-running agents-registry.ts's own
 * fold over a `ts <=` slice of events_raw — a real point-in-time scan, not
 * a fabricated trend (the fold logic is REUSED, not re-implemented, so a
 * snapshot can never disagree with the live agents table's own semantics).
 *
 * Project scope is applied to the folded agents, not to the events going in
 * — the same "derive via the owning task" route `allAgentsForScope()` takes
 * for the live half of the delta. Filtering the events by their own
 * `project` column instead (D-170) counted a different population at each
 * end of the subtraction: a dispatch logged before Phase 6b carries no
 * project, so its agent stayed in the live count and vanished from the
 * historical one, and the StatCard reported an arrival that never happened.
 */
function liveAgentCountAt(db: SmithDb, scope: Scope, cutoffIso: string): number {
  const conds = [lte(eventsRaw.ts, cutoffIso), inArray(eventsRaw.eventType, SNAPSHOT_EVENT_TYPES)];
  if (scope.sessionId) conds.push(eq(eventsRaw.sessionId, scope.sessionId));
  const rows = inLogOrder(
    db
      .select()
      .from(eventsRaw)
      .where(and(...conds))
      .all(),
  );
  const storedEvents = rows.map((r) => ({
    event_id: r.eventId,
    record: {
      session_id: r.sessionId,
      actor: r.actor ?? 'system',
      event_type: r.eventType,
      task_id: r.taskId ?? undefined,
      agent_id: r.agentId ?? undefined,
      plan_version: r.planVersion,
      causal_parent: r.causalParent,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      ts: r.ts,
    },
  }));
  const live = foldLiveAgents(foldAgents(storedEvents));
  if (scope.project === undefined) return live.length;
  const scopedTaskIds = new Set(allTasksForScope(db, scope).map((t) => t.taskId));
  return live.filter((a) => a.taskId !== null && scopedTaskIds.has(a.taskId)).length;
}

/**
 * Total tokens spent (task-result-recorded token_usage) across `epicByTask`'s tasks, as of `cutoffIso`.
 *
 * Project scope arrives through `epicByTask`, which is built from rows
 * `allTasksForScope()` already filtered — the same route `epicTokenMaps()`
 * takes for the "now" end of the delta. Do NOT also filter these events on
 * their own `project` column (D-170): `task-result-recorded` rows logged
 * before Phase 6b carry no project, so the extra filter dropped spend here
 * that the "now" total still counted, and the subtraction invented a rise
 * that never happened — visible only when a project was selected.
 *
 * For the same reason it resolves the task id through `epicResolver`, exactly
 * as `epicTokenMaps()` does (D-207): the two functions are the two ends of one
 * subtraction, and teaching only the "now" end to read a bare id would turn
 * hours-old spend into a rise that never happened — the identical bug in a new
 * disguise.
 */
function tokensSpentAt(
  db: SmithDb,
  scope: Scope,
  cutoffIso: string,
  epicByTask: Map<string, string>,
): number {
  const conds = [eq(eventsRaw.eventType, 'task-result-recorded'), lte(eventsRaw.ts, cutoffIso)];
  if (scope.sessionId) conds.push(eq(eventsRaw.sessionId, scope.sessionId));
  const rows = db
    .select()
    .from(eventsRaw)
    .where(and(...conds))
    .all();
  const epicOf = epicResolver(epicByTask);
  let total = 0;
  for (const r of rows) {
    const payload = JSON.parse(r.payload) as TaskResultPayload;
    if (!epicOf(resultTaskId({ payload, envelopeTaskId: r.taskId }))) continue;
    total += payload.token_usage?.total_tokens ?? 0;
  }
  return total;
}

/**
 * Total budget across `epicByTask`'s tasks, as of `cutoffIso` — the other
 * term of the 1h budget-used delta, read as of the same instant as the spend.
 *
 * `tasks.budgetTokens` has no history, but it needs none: exactly one event
 * type ever writes it (projector.ts's `task-added` case, `p.budget_tokens ??
 * row.budgetTokens`, keyed on the envelope's task id), so folding those rows
 * up to the cutoff in the same order reproduces the column as it stood then.
 *
 * Scope and epic attribution arrive through `epicByTask`, exactly as in
 * `tokensSpentAt` and for the reasons D-170 and D-207 record there: the two
 * ends of one subtraction have to count the same population, and a term
 * computed as-of-now against a term computed as-of-then reports a change that
 * never happened. Here it was the denominator: a budget that grew during the
 * hour retroactively shrank the historical percentage, so an epic that had
 * burned 90% of its budget and then had a large task planned into it read as
 * a one-point rise while the gauge in fact fell eighty.
 */
function tokensBudgetedAt(
  db: SmithDb,
  scope: Scope,
  cutoffIso: string,
  epicByTask: Map<string, string>,
): number {
  const conds = [eq(eventsRaw.eventType, 'task-added'), lte(eventsRaw.ts, cutoffIso)];
  if (scope.sessionId) conds.push(eq(eventsRaw.sessionId, scope.sessionId));
  const rows = inLogOrder(
    db
      .select()
      .from(eventsRaw)
      .where(and(...conds))
      .all(),
  );
  const epicOf = epicResolver(epicByTask);
  // Last write per task wins, as the projector's fold does — a re-plan that
  // re-states a task carries the budget it has from then on. Which write is
  // last is the log's answer, not `ts`'s: this read used to break the tie on
  // `event_id` as text, so within one re-plan's burst the eleventh task-added
  // sorted before the ninth and a task could keep the budget it had been
  // re-planned out of.
  const budgetByTask = new Map<string, number>();
  for (const r of rows) {
    if (!r.taskId || !epicOf(r.taskId)) continue;
    const payload = JSON.parse(r.payload) as { budget_tokens?: number };
    if (payload.budget_tokens === undefined) continue;
    budgetByTask.set(r.taskId, payload.budget_tokens);
  }
  let total = 0;
  for (const v of budgetByTask.values()) total += v;
  return total;
}

export interface OverviewOpts {
  /** Injectable "now" for deterministic snapshot-delta tests; defaults to `new Date()`. */
  nowIso?: string;
}

export function overview(db: SmithDb, scope: Scope = {}, opts: OverviewOpts = {}): OverviewResult {
  const liveRows = allAgentsForScope(db, scope);
  const taskRows = allTasksForScope(db, scope);

  const closedEpics = closedEpicsForScope(db, scope);
  const epicsInFlight = inFlightEpics(taskRows, closedEpics);

  const { budgetByEpic, spentByEpic } = epicTokenMaps(db, scope, taskRows);

  const epicIds = new Set([...budgetByEpic.keys(), ...spentByEpic.keys()]);
  const tokensByEpic: EpicTokenSpend[] = [...epicIds].sort().map((epicId) => ({
    epicId,
    tokensSpent: spentByEpic.get(epicId) ?? 0,
    tokensBudget: budgetByEpic.get(epicId) ?? null,
  }));

  const escalations = taskRows.filter((t) => t.taskStatus === 'escalated').length;

  const pendingWaiverFindings = allFindingsForScope(db, scope).filter(
    (f) =>
      (f.severity === 'S3-minor' || f.severity === 'S4-nit') &&
      (f.findingStatus === 'raised' || f.findingStatus === 'confirmed'),
  );
  const pendingWaivers = pendingWaiverFindings.filter((f) => f.waiverId === null).length;

  const dispatchRows = scope.sessionId
    ? db.select().from(dispatches).where(eq(dispatches.sessionId, scope.sessionId)).all()
    : db.select().from(dispatches).all();
  const scopedDispatches = filterByProject(dispatchRows, scope);
  // Newest first, then the top ten — so the tie has to be broken before the
  // slice, not left to the sort's stability. A wave admits its whole cohort
  // inside one millisecond, and a comparison that returned 0 across all of
  // them left the rows in the ascending order they arrived in: the ten this
  // then kept were the *oldest* ten of the burst, under a heading that says
  // recent.
  const recentDispatches: RecentDispatch[] = inLogOrder(scopedDispatches)
    .reverse()
    .slice(0, RECENT_DISPATCHES_LIMIT)
    .map((d) => ({
      eventId: d.eventId,
      ts: d.ts,
      agentRole: d.agentRole,
      provider: d.provider,
      modelTier: d.modelTier,
      taskId: d.taskId,
      reason: d.reason,
    }));

  let projects: ProjectOverviewSummary[] | undefined;
  if (scope.project === undefined) {
    const allTaskRowsUnfiltered = scope.sessionId
      ? db.select().from(tasks).where(eq(tasks.sessionId, scope.sessionId)).all()
      : db.select().from(tasks).all();
    // Milestones too, not just tasks: roadmap.md's `- project:` bullet
    // declares a project before any of its work is planned, and
    // milestoneProgressRows() filters phases by that same bullet. This list
    // is the whole of GET /api/projects, which is the whole of the UI's
    // project switcher -- deriving it from `tasks` alone left a declared but
    // unstarted project unselectable, so its phases showed only in "All
    // projects" and the scope built to serve them could not be reached.
    // Milestones carry no session_id and milestoneProgressRows() never
    // filters them by one, so they join the list under a session scope too.
    const declaredRows = db.select({ project: milestones.project }).from(milestones).all();
    projects = distinctProjects(allTaskRowsUnfiltered, declaredRows).map((p) =>
      projectSummary(db, p, scope),
    );
  }

  const now = opts.nowIso ? new Date(opts.nowIso) : new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const liveAgentCountDelta5m = liveRows.length - liveAgentCountAt(db, scope, fiveMinAgo);

  const epicByTask = new Map(
    taskRows.filter((t) => t.epicId !== null).map((t) => [t.taskId, t.epicId as string]),
  );
  const totalBudgetNow = [...budgetByEpic.values()].reduce((s, v) => s + v, 0);
  const totalSpentNow = [...spentByEpic.values()].reduce((s, v) => s + v, 0);
  let budgetUsedPctPointDelta1h: number | null = null;
  if (totalBudgetNow > 0) {
    const currentPct = (totalSpentNow / totalBudgetNow) * 100;
    const spentAgo = tokensSpentAt(db, scope, oneHourAgo, epicByTask);
    const budgetAgo = tokensBudgetedAt(db, scope, oneHourAgo, epicByTask);
    // Nothing was budgeted an hour ago, so nothing was used: the card read
    // "No budget set" then, and the honest reading of the move since is the
    // whole of today's percentage. Dividing by today's budget instead would
    // be the bug this guard exists to avoid, in its smallest form.
    const pctAgo = budgetAgo > 0 ? (spentAgo / budgetAgo) * 100 : 0;
    budgetUsedPctPointDelta1h = currentPct - pctAgo;
  }

  return {
    liveAgents: groupLiveAgents(liveRows),
    // Newest dispatch first — a live-agents card that's about to show many
    // concurrent agents should surface the most recently-started ones up top.
    liveAgentEntries: [...liveRows]
      .sort((a, b) => b.dispatchedAt.localeCompare(a.dispatchedAt))
      .map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        agentRole: a.agentRole,
        provider: a.provider,
        modelTier: a.modelTier,
        taskId: a.taskId,
        epicId: a.epicId,
        dispatchedAt: a.dispatchedAt,
      })),
    liveAgentCount: liveRows.length,
    runningSessions: runningSessions(db, scope),
    epicsInFlight,
    closedEpics,
    tokensByEpic,
    alerts: { escalations, pendingWaivers },
    milestoneProgress: milestoneProgressRows(db, scope),
    recentDispatches,
    liveAgentCountDelta5m,
    budgetUsedPctPointDelta1h,
    ...(projects ? { projects } : {}),
  };
}

// ---------------------------------------------------------------------------
// timeline()
// ---------------------------------------------------------------------------

/**
 * The timeline's event types that are NOT taxonomy values: `event_type` is a
 * free string (event.schema.json), and these predate — or sit outside — the
 * gate/graph dimensions.
 *
 * `lesson-status-changed` is here because of a fix-round finding (code review
 * #11): the "Decisions" lens's DECISION_EVENT_TYPES includes it, but
 * timeline()'s eventType filter runs BEFORE the lens, so a lesson decision
 * could never reach the lens — or the plain Timeline page — at all.
 *
 * The seven below it were found the same way, one layer further out: the
 * event-type lint (P9-37) knows which free types `src` writes, and comparing
 * that set against this one showed seven written correctly, folded correctly,
 * and dropped here — including `epic-closed`, the most consequential event in
 * an epic's life. Over the factory's own logs that filter was hiding 117 of
 * 461 recorded events. The list is now guarded in both directions by
 * factory/orchestrator/test/eventTypes.test.ts, so it cannot fall behind the
 * writers again without a red test naming the type.
 *
 * `operator-note` was the exception that guard cannot catch on its own, and it
 * cost the most: the scan reads `src`, and this type is only ever written from
 * outside it (`smith event append`), so nothing pointed at the gap while it
 * grew into the third most common event in the factory's own logs. It carries
 * the operator's reasoning in their own words — the one thing on the timeline
 * a machine did not write — and none of it reached the screen. The guard now
 * covers it because a human named it in FREE_EVENT_TYPES; that human step is
 * load-bearing for every `writtenBy: 'cli'` type, which is why each one says so.
 */
export const FREE_TIMELINE_EVENT_TYPES = [
  'user_prompt',
  'operator-note',
  'dispatch_decision',
  'error-logged',
  'lesson-status-changed',
  'session-start',
  'task-result-recorded',
  'judge-verdict',
  'judge-reported',
  'epic-closed',
  'lesson-candidate-raised',
  'lesson-edited',
  // D-21 Part 4: the whole point of this event is that a reader must not see
  // a clean amendment discharge without learning its obligation was repaired
  // -- hiding the repair itself from the timeline would be the same failure
  // one layer out.
  'finding-obligation-repaired',
  // The independent finder's reconciliation. It is the one event that says a
  // second, differently-vendored eye read this diff at all, and in shadow mode
  // it is the ONLY thing the run produces -- gating nothing by definition. A
  // shadow verdict nobody can see is a shadow deployment nobody can evaluate,
  // which is the whole reason the mode exists.
  'cross-finding-reconciled',
  // The scheduler's three proposals. Architecture §12 has the scheduler
  // propose and the operator dispose, so the timeline is the only place the
  // offer is ever made -- drop the row and the proposal is never put to
  // anyone. They arrive through scheduler.ts eventTypeFor(), a helper return
  // rather than a literal at the `event_type:` position, which is how all
  // three stayed off this list without failing the P9-37 lint (Rule D).
  'recheck-proposed',
  'maintenance-proposed',
  'growth-review-due',
];

let cachedTaxonomy: Taxonomy | undefined;

/**
 * event_types rendered on the timeline: user prompts + dispatch decisions +
 * gate/graph events, interleaved (architecture §7 "a hard requirement";
 * §7 also requires "errors and gate results attach to the same timeline").
 *
 * Read off the taxonomy rather than hand-copied (P9-37). The copy had fallen
 * eight gate events behind — `deps-check-result` had an icon and a title in
 * ui/src/lib/timelineDisplay.ts that could never fire, because this filter
 * dropped the row before the renderer saw it. A gate result the operator
 * cannot see is one the factory may as well not have logged, and a list that
 * has to be updated twice is a list that will be updated once.
 *
 * Exported since D-163: `smith event append` reads it to tell the operator, on
 * the receipt, that the type they just wrote lands outside it. The write side
 * is open on purpose and this side is closed on purpose; the export is what
 * keeps the two from being two different lists.
 */
export function timelineEventTypes(): string[] {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  return [
    ...FREE_TIMELINE_EVENT_TYPES,
    ...(cachedTaxonomy.dimensions.gate_event ?? []),
    ...(cachedTaxonomy.dimensions.graph_event ?? []),
  ];
}

export interface TimelineEntry {
  eventId: string;
  ts: string;
  eventType: string;
  taskId: string | null;
  agentId: string | null;
  planVersion: number;
  causalParent: string | null;
  payload: Record<string, unknown>;
  project: string | null;
  actor: string | null;
}

export interface TimelineFilter extends Scope {
  taskId?: string;
  epicId?: string;
  eventTypes?: string[];
  /** Expand the causal-parent chain (ancestors) for this one event id instead of a flat list. */
  causalChainFor?: string;
  /**
   * Phase 6b "Decisions" lens (design-spec addendum): only user_prompt events
   * + operator-actor decision events (waiver-granted/-denied, lesson
   * approve/reject, and since D-213 operator-note) + the dispatch_decision
   * events causally attached to one of those (by parent_prompt_id or a direct
   * causal_parent edge) survive.
   */
  decisionsOnly?: boolean;
}

function toEntry(row: {
  eventId: string;
  ts: string;
  eventType: string;
  taskId: string | null;
  agentId: string | null;
  planVersion: number;
  causalParent: string | null;
  payload: string;
  project: string | null;
  actor: string | null;
}): TimelineEntry {
  return {
    eventId: row.eventId,
    ts: row.ts,
    eventType: row.eventType,
    taskId: row.taskId,
    agentId: row.agentId,
    planVersion: row.planVersion,
    causalParent: row.causalParent,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    project: row.project,
    actor: row.actor,
  };
}

/**
 * Operator-actor decision event kinds (Timeline "Decisions" lens). Limited
 * to kinds this codebase's write paths attribute to the operator; the actor
 * is still checked below rather than trusted from the type alone, so a
 * system-authored event of one of these kinds is correctly excluded rather
 * than silently miscounted as a decision. `plan-version-created`/
 * `-superseded` ("plan sign-offs" per the operator's own phrasing) are
 * deliberately NOT included yet — this codebase has no dedicated event
 * distinguishing an operator's plan sign-off from the planner's own
 * automatic version cut, and inventing that distinction was out of this
 * task's scope; flagged in ui/docs/DESIGN.md rather than guessed.
 *
 * D-164: that actor check used to read `entry.actor === 'user'`. The default
 * is `'user'` only when a caller passes no actor at all — true of the UI, and
 * of nothing else. The CLI paths the operator guide documents pass
 * `--actor operator`, the operator's console passes `operator-skill`, and so
 * across all 668 events the factory has ever recorded the string `'user'`
 * never appears: 26 waiver and lesson decisions were on the timeline and the
 * lens returned 0 of them, on every session. `isOperatorActor` is now the one
 * place that answers this, shared with lessons.ts, which had answered it
 * differently.
 *
 * D-213: `operator-note` is the fourth kind, and it was the one worth the most.
 * D-153 taught the Prompts chip that "a person said this" means `user_prompt`
 * OR `operator-note`, because this factory's logs hold 0 of the first and 57 of
 * the second. This lens asks the stronger form of the same question and knew
 * only `user_prompt`, so over the real store it answered with 27 of the 103
 * rows it exists to show: every note the operator wrote gone, and the 19
 * dispatches those notes caused gone with them — a lens whose subject is the
 * operator's decisions, returning almost none of them. The type belongs here
 * rather than beside `user_prompt` above precisely because it needs the actor
 * check: `smith event append` is open on the write side, so an agent can write
 * one, and `operator-note` should be read as a decision only when the operator
 * is who wrote it.
 */
const DECISION_EVENT_TYPES = new Set([
  'waiver-granted',
  'waiver-denied',
  'lesson-status-changed',
  'operator-note',
]);

function isDecisionEntry(entry: TimelineEntry): boolean {
  if (entry.eventType === 'user_prompt') return true;
  return DECISION_EVENT_TYPES.has(entry.eventType) && isOperatorActor(entry.actor);
}

function applyDecisionsLens(entries: TimelineEntry[]): TimelineEntry[] {
  const decisionIds = new Set(entries.filter(isDecisionEntry).map((e) => e.eventId));
  return entries.filter((e) => {
    if (isDecisionEntry(e)) return true;
    if (e.eventType !== 'dispatch_decision') return false;
    const parentPromptId = (e.payload as { parent_prompt_id?: string }).parent_prompt_id;
    return (
      (parentPromptId !== undefined && decisionIds.has(parentPromptId)) ||
      (e.causalParent !== null && decisionIds.has(e.causalParent))
    );
  });
}

/**
 * Walk causal_parent pointers back to the root, oldest-first.
 *
 * P9-7: the walk crosses session boundaries. Event ids are globally unique
 * (`<session-id>#<index>`), so a hop needs the id alone; constraining every
 * lookup to `sessionId` used to stop the chain dead at the session root of a
 * continued epic — the projection reported a two-event history for a chain
 * that ran back through three sessions. `sessionId` still gates the FIRST
 * lookup, so asking for a chain that does not start in the named session
 * remains an empty answer rather than a silent redirect.
 */
function causalChain(db: SmithDb, sessionId: string, eventId: string): TimelineEntry[] {
  const chain: TimelineEntry[] = [];
  let currentId: string | null = eventId;
  const seen = new Set<string>();
  let first = true;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const idMatch = eq(eventsRaw.eventId, currentId);
    const row = db
      .select()
      .from(eventsRaw)
      .where(first ? and(idMatch, eq(eventsRaw.sessionId, sessionId)) : idMatch)
      .get();
    if (!row) break;
    first = false;
    chain.unshift(toEntry(row));
    currentId = row.causalParent as string | null;
  }
  return chain;
}

/**
 * Which epic an entry belongs to, or null when it names none.
 *
 * The task id decides it whenever it qualifies one, because `<epic>/<task>` is
 * the row's own identity and a payload is only ever a claim about it. Asked
 * through `epicOfTaskId`, not `split('/')[0]`: this filter was one of the call
 * sites D-49 wrote that module for, and it still spelled the derivation by
 * hand, so a bare `task-2-path-guard` answered "epic task-2-path-guard".
 *
 * The fallback is the actual defect (D-206). The events an operator opens an
 * epic timeline *for* -- `plan-version-created`, `wave-admitted`,
 * `wave-merged` -- belong to the epic rather than to any one task, so they
 * carry no task id and were filtered out of the one lens built to show them.
 * Those name their epic in the payload instead. An entry with neither drops
 * out, which is the honest answer for a legacy row that recorded neither.
 */
function epicOfEntry(entry: TimelineEntry): string | null {
  const fromTaskId = entry.taskId === null ? null : epicOfTaskId(entry.taskId);
  if (fromTaskId !== null) return fromTaskId;
  const fromPayload = entry.payload.epic_id;
  return typeof fromPayload === 'string' ? fromPayload : null;
}

export function timeline(db: SmithDb, filter: TimelineFilter = {}): TimelineEntry[] {
  if (filter.causalChainFor) {
    if (!filter.sessionId) {
      throw new RangeError('timeline(): causalChainFor requires sessionId to be set.');
    }
    return causalChain(db, filter.sessionId, filter.causalChainFor);
  }

  const eventTypes = filter.eventTypes ?? timelineEventTypes();
  const conditions = [inArray(eventsRaw.eventType, eventTypes)];
  if (filter.sessionId) conditions.push(eq(eventsRaw.sessionId, filter.sessionId));
  if (filter.taskId) conditions.push(eq(eventsRaw.taskId, filter.taskId));

  const rows = inLogOrder(
    db
      .select()
      .from(eventsRaw)
      .where(and(...conditions))
      .all(),
  );

  let entries = rows.map(toEntry);
  entries = filterByProject(entries, filter);
  if (filter.epicId) entries = entries.filter((e) => epicOfEntry(e) === filter.epicId);
  if (filter.decisionsOnly) entries = applyDecisionsLens(entries);
  return entries;
}

// ---------------------------------------------------------------------------
// kanban()
// ---------------------------------------------------------------------------

export interface KanbanTag {
  case: string | null;
  origin: string | null;
  /** Worst severity among this task's still-open findings, or null if none. */
  severity: string | null;
}

export interface KanbanTask {
  taskId: string;
  taskStatus: string;
  /** Phase 6b (closes the 6a DESIGN.md deviation) — tasks.objective, the closest field to a "title". */
  title: string | null;
  /** Phase 6b — the most recent dispatch_decision's agent_role for this task, or null if never dispatched. */
  agentRole: string | null;
  /** Phase 6b round 3 (operator directive 2) — same dispatch's model_tier, paired with agentRole for the "role · tier" Kanban chip. */
  agentModelTier: string | null;
  /** Phase 6b — the roadmap.md milestone whose `epics:` list includes this task's epic, or null. */
  milestoneId: string | null;
  tags: KanbanTag;
}

export interface KanbanColumn {
  taskStatus: string;
  tasks: KanbanTask[];
}

// D-127: `amend-pending` is open. The amendment has been written but the tasks
// it obligates have not landed, so nothing is discharged yet. This query has no
// obligation data — that lives in epic.ts's summary, which checks each named
// task id — so it treats the status as unconditionally open: correct for a
// per-task severity chip, and it fails closed.
const OPEN_FINDING_STATUSES = new Set([
  'raised',
  'confirmed',
  'fix-pending',
  'fix-landed',
  'amend-pending',
]);

function worstSeverity(severities: string[]): string | null {
  let worst: string | null = null;
  let worstIndex = Number.POSITIVE_INFINITY;
  for (const s of severities) {
    // Not worseSeverity(): this list comes out of SQL and may hold a severity a
    // taxonomy edit has since retired. A chip on a Kanban card degrades to
    // "no severity" for one; a reconciliation must not, so that one throws.
    const index = severityRank(s);
    if (index !== null && index < worstIndex) {
      worstIndex = index;
      worst = s;
    }
  }
  return worst;
}

/**
 * Tasks for one epic (or, Phase 6b, every epic when `epicId` is omitted —
 * closes the 6a DESIGN.md "no all-epics mode" deviation), grouped by
 * task_status, tagged with case/origin/worst-open-finding severity plus
 * (Phase 6b) title/agent-role/milestone.
 */
export function kanban(db: SmithDb, epicId?: string, scope: Scope = {}): KanbanColumn[] {
  const epicCond = epicId !== undefined ? eq(tasks.epicId, epicId) : undefined;
  const sessionCond =
    scope.sessionId !== undefined ? eq(tasks.sessionId, scope.sessionId) : undefined;
  const taskConds = [epicCond, sessionCond].filter((c) => c !== undefined);
  const taskRows = filterByProject(
    taskConds.length > 0
      ? db
          .select()
          .from(tasks)
          .where(and(...taskConds))
          .all()
      : db.select().from(tasks).all(),
    scope,
  );

  const epicIdsInScope = new Set(
    taskRows.map((t) => t.epicId).filter((e): e is string => e !== null),
  );

  const findingCond = epicId !== undefined ? eq(findings.epicId, epicId) : undefined;
  const findingRows = findingCond
    ? db.select().from(findings).where(findingCond).all()
    : db.select().from(findings).all();

  const openSeverityByTask = new Map<string, string[]>();
  for (const f of findingRows) {
    if (f.epicId !== null && !epicIdsInScope.has(f.epicId)) continue;
    if (!OPEN_FINDING_STATUSES.has(f.findingStatus)) continue;
    const list = openSeverityByTask.get(f.taskId) ?? [];
    list.push(f.severity);
    openSeverityByTask.set(f.taskId, list);
  }

  // Latest dispatch per task_id (agentRole + modelTier fields — operator
  // directive 2, Phase 6b round 3: Kanban's "subagent + model" chip. Same
  // minimal-widening pattern as the earlier agentRole/title/milestoneId
  // additions in this function, disclosed the same way.
  const dispatchRows = scope.sessionId
    ? db.select().from(dispatches).where(eq(dispatches.sessionId, scope.sessionId)).all()
    : db.select().from(dispatches).all();
  const latestAgentRoleByTask = new Map<
    string,
    { ts: string; eventId: string; agentRole: string; modelTier: string }
  >();
  for (const d of dispatchRows) {
    if (!d.taskId) continue;
    const existing = latestAgentRoleByTask.get(d.taskId);
    if (!existing || isLaterEvent(d, existing))
      latestAgentRoleByTask.set(d.taskId, {
        ts: d.ts,
        eventId: d.eventId,
        agentRole: d.agentRole,
        modelTier: d.modelTier,
      });
  }

  // epicId -> milestoneId, from roadmap.md's milestones table.
  const milestoneRows = db.select().from(milestones).all();
  const milestoneByEpic = new Map<string, string>();
  for (const m of milestoneRows) {
    for (const e of JSON.parse(m.epicIds) as string[]) milestoneByEpic.set(e, m.milestoneId);
  }

  const columns = new Map<string, KanbanTask[]>();
  for (const t of taskRows) {
    const column = columns.get(t.taskStatus) ?? [];
    column.push({
      taskId: t.taskId,
      taskStatus: t.taskStatus,
      title: t.objective,
      agentRole: latestAgentRoleByTask.get(t.taskId)?.agentRole ?? null,
      agentModelTier: latestAgentRoleByTask.get(t.taskId)?.modelTier ?? null,
      milestoneId: t.epicId ? (milestoneByEpic.get(t.epicId) ?? null) : null,
      tags: {
        case: t.caseTag,
        origin: t.origin,
        severity: worstSeverity(openSeverityByTask.get(t.taskId) ?? []),
      },
    });
    columns.set(t.taskStatus, column);
  }

  return [...columns.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskStatus, tasksInColumn]) => ({ taskStatus, tasks: tasksInColumn }));
}

// ---------------------------------------------------------------------------
// taskDetail()
// ---------------------------------------------------------------------------

/**
 * Fix-round (uiux S2 #5): design-spec.md §5.5's "Attempts" RowList needs
 * end ts + run_status, neither of which `dispatches` carries (it's the
 * dispatch-time record only — agents-registry.ts's fold, projected into
 * the separate `agents` table, owns the terminal outcome). Rather than
 * duplicate that fold's logic here, each attempt is joined to its matching
 * `agents` row by event id (`agents.id` IS the dispatch event id, per
 * agents-registry.ts's own `AgentRecord.id` doc comment) — one extra
 * lookup, not a new state machine.
 */
export interface TaskAttempt {
  eventId: string;
  ts: string;
  agentRole: string;
  provider: string;
  modelTier: string;
  /** From the matching `agents` row (see `AgentStatus`); null if the agents fold has no matching row (shouldn't happen in practice). */
  agentStatus: string | null;
  terminalAt: string | null;
}

export interface TaskDetail {
  task: typeof tasks.$inferSelect;
  claims: string[];
  attempts: TaskAttempt[];
  /** Every `agents` row for this task — design-spec.md §5.5's rail "Agents" card. */
  agents: (typeof agents.$inferSelect)[];
  findings: (typeof findings.$inferSelect)[];
  artifacts: (typeof artifacts.$inferSelect)[];
  branch: string | null;
}

export function taskDetail(db: SmithDb, taskId: string): TaskDetail | null {
  const task = db.select().from(tasks).where(eq(tasks.taskId, taskId)).get();
  if (!task) return null;

  const dispatchRows = inLogOrder(
    db.select().from(dispatches).where(eq(dispatches.taskId, taskId)).all(),
  );
  const agentRows = db.select().from(agents).where(eq(agents.taskId, taskId)).all();
  const agentByEventId = new Map(agentRows.map((a) => [a.id, a]));
  const attempts: TaskAttempt[] = dispatchRows.map((d) => {
    const agent = agentByEventId.get(d.eventId);
    return {
      eventId: d.eventId,
      ts: d.ts,
      agentRole: d.agentRole,
      provider: d.provider,
      modelTier: d.modelTier,
      agentStatus: agent?.status ?? null,
      terminalAt: agent?.terminalAt ?? null,
    };
  });
  const findingRows = db.select().from(findings).where(eq(findings.taskId, taskId)).all();
  const artifactRows = db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).all();

  return {
    task,
    claims: task.claims ? (JSON.parse(task.claims) as string[]) : [],
    attempts,
    agents: agentRows,
    findings: findingRows,
    artifacts: artifactRows,
    branch: task.branch,
  };
}

// ---------------------------------------------------------------------------
// lessons()
// ---------------------------------------------------------------------------

export interface LessonsResult {
  pending: (typeof lessons.$inferSelect)[];
  approved: (typeof lessons.$inferSelect)[];
  /** Everything that has stopped moving: rejected, superseded, or invalidated. */
  closed: (typeof lessons.$inferSelect)[];
}

/**
 * Every `lesson_status` the taxonomy declares, mapped to the bucket the
 * Lessons page renders it in. Total on purpose (D-220).
 *
 * Buckets used to be two filters over three of the six statuses, so
 * `novelty-rejected`, `superseded`, and `invalidated` rows reached no surface
 * at all — not even the filter labelled "All". That silently undid two
 * contracts: lessons.ts raises a near-duplicate and transitions it to
 * `novelty-rejected` precisely so it is "never silently dropped"
 * (architecture §9.3), and §9.6 calls an invalidated lesson a "traceable
 * rollback, never silent deletion". It also made the page's own Reject button
 * look broken — the row it wrote vanished instead of closing.
 *
 * factory/orchestrator/test/db/queries.test.ts asserts these keys equal
 * factory/policies/taxonomy.yml's `lesson_status`, so a seventh status cannot
 * be declared without landing here.
 */
export const LESSON_BUCKET_FOR_STATUS: Record<string, 'pending' | 'approved' | 'closed'> = {
  candidate: 'pending',
  'pending-approval': 'pending',
  approved: 'approved',
  'novelty-rejected': 'closed',
  superseded: 'closed',
  invalidated: 'closed',
};

export function lessonsPage(db: SmithDb, scope: Scope = {}): LessonsResult {
  const rows = scope.sessionId
    ? db.select().from(lessons).where(eq(lessons.sessionId, scope.sessionId)).all()
    : db.select().from(lessons).all();

  const result: LessonsResult = { pending: [], approved: [], closed: [] };
  for (const row of rows) {
    // An unrecognised status lands in `closed` rather than nowhere: being
    // invisible is the defect this map exists to close, and a row the
    // operator can see and question beats a row that does not exist.
    result[LESSON_BUCKET_FOR_STATUS[row.lessonStatus] ?? 'closed'].push(row);
  }
  return result;
}

// ---------------------------------------------------------------------------
// errors()
// ---------------------------------------------------------------------------

export interface ErrorGroupCount {
  /** `${errorGroup}.${errorClass}|${severity}` -- the triple this row is
   *  bucketed by, carried out so consumers key on the same thing the
   *  aggregation did. It used to be computed here and dropped, which left
   *  every caller to re-derive it; the Errors table keyed its rows on
   *  `errorGroup` alone instead, and every class and severity within a
   *  group collapsed onto one key (D-214). */
  id: string;
  errorGroup: string;
  errorClass: string;
  severity: string;
  count: number;
}

export interface ErrorDayCount {
  day: string; // YYYY-MM-DD
  count: number;
}

export interface ErrorsResult {
  byClass: ErrorGroupCount[];
  byDay: ErrorDayCount[];
}

export function errorsPage(db: SmithDb, scope: Scope = {}): ErrorsResult {
  const allRows = scope.sessionId
    ? db.select().from(errors).where(eq(errors.sessionId, scope.sessionId)).all()
    : db.select().from(errors).all();
  const rows = filterByProject(allRows, scope);

  const byClass = new Map<string, ErrorGroupCount>();
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.errorGroup}.${row.errorClass}|${row.severity}`;
    const existing = byClass.get(key);
    if (existing) existing.count += 1;
    else {
      byClass.set(key, {
        id: key,
        errorGroup: row.errorGroup,
        errorClass: row.errorClass,
        severity: row.severity,
        count: 1,
      });
    }
    const day = row.ts.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  return {
    byClass: [...byClass.values()].sort((a, b) => b.count - a.count),
    byDay: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, count })),
  };
}

// ---------------------------------------------------------------------------
// analytics()
// ---------------------------------------------------------------------------

export interface ThroughputDay {
  day: string;
  completed: number;
}

export interface CostBucket {
  modelTier: string;
  provider: string;
  taskCount: number;
  totalTokens: number;
  avgTokensPerTask: number;
}

export interface SameMistakeDay {
  day: string;
  decisions: number;
  sameMistake: number;
  /**
   * `null` on a day that recorded gate intakes but decided nothing — there is
   * no denominator, so there is no rate. It used to read 0, which made a day
   * the gate saw no findings on indistinguishable from a day it saw findings
   * and cleared every one (D-31: silence is not assent). Anything reading a
   * trend off this series must skip the nulls rather than plot them at zero;
   * `smith kpi same-mistake` does, and is the verb that reads it against
   * §9.7's target.
   */
  rate: number | null;
}

export interface RecheckOutcome {
  taskStatus: string;
  count: number;
}

export interface AnalyticsResult {
  throughput: ThroughputDay[];
  costByModelTierAndProvider: CostBucket[];
  sameMistakeRateByDay: SameMistakeDay[];
  recheckOutcomes: RecheckOutcome[];
  /**
   * Per-provider judge-run calibration — the same rows `smith stats providers`
   * prints, computed by the same function so the dashboard and the terminal
   * cannot disagree about how a provider is judging.
   *
   * It belongs on this payload because it answers the question the cost series
   * structurally cannot. `costByModelTierAndProvider` reads
   * `task-result-recorded`, which only a builder writes, and every external
   * provider in this factory judges rather than builds — so that series names
   * claude in every session ever logged, and a page fed only by it reports a
   * single-provider factory while codex and deepseek are judging in the same
   * log (D-255).
   */
  providerAgreement: ProviderAgreementStat[];
}

interface ResultPayloadForCost {
  task_id?: string;
  provider?: string;
  model_tier?: string;
  token_usage?: { total_tokens?: number };
}

interface SeverityDecisionsPayloadForAnalytics {
  decisions?: Array<{ same_mistake?: boolean }>;
}

export function analytics(db: SmithDb, scope: Scope = {}): AnalyticsResult {
  const taskRows = allTasksForScope(db, scope);
  const inScope = taskInScope(db, scope);

  const throughputByDay = new Map<string, number>();
  for (const t of taskRows) {
    if (t.taskStatus !== 'completed') continue;
    const day = t.updatedAt.slice(0, 10);
    throughputByDay.set(day, (throughputByDay.get(day) ?? 0) + 1);
  }
  const throughput: ThroughputDay[] = [...throughputByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, completed]) => ({ day, completed }));

  const resultRows = scope.sessionId
    ? db
        .select({ taskId: eventsRaw.taskId, payload: eventsRaw.payload })
        .from(eventsRaw)
        .where(
          and(
            eq(eventsRaw.eventType, 'task-result-recorded'),
            eq(eventsRaw.sessionId, scope.sessionId),
          ),
        )
        .all()
    : db
        .select({ taskId: eventsRaw.taskId, payload: eventsRaw.payload })
        .from(eventsRaw)
        .where(eq(eventsRaw.eventType, 'task-result-recorded'))
        .all();

  const costBuckets = new Map<string, { taskCount: number; totalTokens: number }>();
  for (const row of resultRows) {
    const p = JSON.parse(row.payload) as ResultPayloadForCost;
    // Column first, payload second: both spellings occur, and one real row
    // omits `payload.task_id` while the column carries it.
    if (!inScope(row.taskId ?? p.task_id)) continue;
    if (!p.model_tier || !p.provider) continue;
    const key = `${p.model_tier}|${p.provider}`;
    const bucket = costBuckets.get(key) ?? { taskCount: 0, totalTokens: 0 };
    bucket.taskCount += 1;
    bucket.totalTokens += p.token_usage?.total_tokens ?? 0;
    costBuckets.set(key, bucket);
  }
  const costByModelTierAndProvider: CostBucket[] = [...costBuckets.entries()].map(([key, v]) => {
    const [modelTier, provider] = key.split('|') as [string, string];
    return {
      modelTier,
      provider,
      taskCount: v.taskCount,
      totalTokens: v.totalTokens,
      avgTokensPerTask: v.taskCount > 0 ? v.totalTokens / v.taskCount : 0,
    };
  });

  const decisionRows = scope.sessionId
    ? db
        .select({ ts: eventsRaw.ts, taskId: eventsRaw.taskId, payload: eventsRaw.payload })
        .from(eventsRaw)
        .where(
          and(
            eq(eventsRaw.eventType, 'severity-decisions'),
            eq(eventsRaw.sessionId, scope.sessionId),
          ),
        )
        .all()
    : db
        .select({ ts: eventsRaw.ts, taskId: eventsRaw.taskId, payload: eventsRaw.payload })
        .from(eventsRaw)
        .where(eq(eventsRaw.eventType, 'severity-decisions'))
        .all();

  const sameMistakeByDay = new Map<string, { decisions: number; sameMistake: number }>();
  for (const row of decisionRows) {
    // The payload names no task at all — gate.ts puts the id in the column.
    if (!inScope(row.taskId)) continue;
    const p = JSON.parse(row.payload) as SeverityDecisionsPayloadForAnalytics;
    const day = row.ts.slice(0, 10);
    const bucket = sameMistakeByDay.get(day) ?? { decisions: 0, sameMistake: 0 };
    for (const d of p.decisions ?? []) {
      bucket.decisions += 1;
      if (d.same_mistake) bucket.sameMistake += 1;
    }
    sameMistakeByDay.set(day, bucket);
  }
  const sameMistakeRateByDay: SameMistakeDay[] = [...sameMistakeByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({
      day,
      decisions: v.decisions,
      sameMistake: v.sameMistake,
      rate: v.decisions > 0 ? v.sameMistake / v.decisions : null,
    }));

  const recheckByStatus = new Map<string, number>();
  for (const t of taskRows) {
    if (t.origin !== 'recheck') continue;
    recheckByStatus.set(t.taskStatus, (recheckByStatus.get(t.taskStatus) ?? 0) + 1);
  }
  const recheckOutcomes: RecheckOutcome[] = [...recheckByStatus.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskStatus, count]) => ({ taskStatus, count }));

  return {
    throughput,
    costByModelTierAndProvider,
    sameMistakeRateByDay,
    recheckOutcomes,
    // Same db, same scope: a project-scoped page gets project-scoped judge
    // stats, and no second round trip is needed to render the card.
    providerAgreement: providerAgreement(db, scope),
  };
}

// ---------------------------------------------------------------------------
// flowGraph() — Flow page (design-spec addendum, Phase 6b)
// ---------------------------------------------------------------------------

export interface FlowNode {
  taskId: string;
  taskStatus: string;
  title: string | null;
  /** The most recent dispatch's agent role, only when the agent is currently live. */
  liveAgentRole: string | null;
  planVersion: number | null;
  wave: number;
}

export interface FlowEdge {
  task: string;
  dependsOn: string;
  edgeType: string;
  edgeProvenance: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Task ids grouped by wave, in wave order — the wave-band rendering the Flow page draws. */
  waves: string[][];
  /**
   * Every plan version present in the scoped tasks, newest first — including
   * the ones this graph is not showing. The Flow page's version picker is
   * built from this, not from `nodes`: a picker sourced from the filtered
   * result can only ever offer the version already on screen (D-165).
   */
  planVersions: number[];
}

export interface FlowFilter extends Scope {
  epicId?: string;
  /**
   * When set, the plan as it stood at that version, across every scoped epic:
   * every task that had entered a plan by then. When omitted, each epic falls
   * back to its own highest plan_version (its "active" plan), and tasks with
   * no recorded plan_version are kept.
   */
  planVersion?: number;
}

/**
 * The active plan's task DAG (Flow page): nodes = tasks (+ live
 * agent, if one is currently dispatched on that task), edges = dependency
 * edges, waves = graph.ts's own longest-path layering (docs/standards/
 * stack.md: "no separate layout library" — this IS that orchestrator
 * utility, exposed via this query/endpoint per the same doc's instruction).
 */
export function flowGraph(db: SmithDb, filter: FlowFilter = {}): FlowGraph {
  let taskRows = allTasksForScope(db, filter);
  if (filter.epicId) taskRows = taskRows.filter((t) => t.epicId === filter.epicId);

  // The picker's options are read off the scoped tasks BEFORE the filter
  // below narrows them — see FlowGraph.planVersions.
  const planVersions = [
    ...new Set(taskRows.map((t) => t.planVersion).filter((v): v is number => v !== null)),
  ].sort((a, b) => b - a);

  // D-167: `tasks.plan_version` is stamped once, off the task's `task-added`,
  // so it records the version the task ENTERED at — not the one version it
  // belongs to. Every amendment carries its unfinished tasks forward
  // (`draftNextVersion`) and re-emits `task-added` only for the ones it adds,
  // so a task that entered at v1 is still in v2's plan file wearing a v1
  // stamp. Membership is therefore "entered at or before", and matching the
  // stamp exactly hid three of envkit-mcp-followup's four tasks the moment its
  // v2 added a fourth.
  //
  // What this cannot express is departure. `draftNextVersion` drops completed
  // tasks from the live backlog and a supersede that renames an id leaves the
  // old one dead, both recorded in the amendment's `diff` — and nothing
  // projects that diff, so a task that left at v3 still reads as present at
  // v3. That over-includes, which is the direction to err in: the plan file's
  // `edges` array carries every earlier version's edges forward, so a node set
  // narrower than "everything that ever entered" leaves arrows pointing at
  // tasks the page is not drawing.
  const belongsTo = (t: { planVersion: number | null }, version: number): boolean =>
    t.planVersion !== null && t.planVersion <= version;

  if (filter.planVersion !== undefined) {
    const version = filter.planVersion;
    taskRows = taskRows.filter((t) => belongsTo(t, version));
  } else {
    // D-165: "the active plan" is a property of an epic, not of the store.
    // Taking one global max meant a single re-planned epic's v2 evicted every
    // other epic's v1 — on the factory's own log that left 1 of 15 tasks on
    // the page. Each epic now answers for its own latest plan.
    const latestByEpic = new Map<string, number>();
    for (const t of taskRows) {
      if (t.planVersion === null) continue;
      const key = t.epicId ?? '';
      const max = latestByEpic.get(key);
      if (max === undefined || t.planVersion > max) latestByEpic.set(key, t.planVersion);
    }
    // A task whose `task-added` carried no plan_version was never assigned to
    // a plan, so no re-plan can have superseded it. Dropping it hid it at
    // every setting of the picker — the Flow page is the only view of the DAG,
    // so there is no other surface on which it would have been noticed.
    taskRows = taskRows.filter((t) => {
      if (t.planVersion === null) return true;
      const latest = latestByEpic.get(t.epicId ?? '');
      return latest !== undefined && belongsTo(t, latest);
    });
  }

  const taskIds = new Set(taskRows.map((t) => t.taskId));

  const edgeRows = filter.sessionId
    ? db.select().from(edges).where(eq(edges.sessionId, filter.sessionId)).all()
    : db.select().from(edges).all();
  const scopedEdges = edgeRows.filter((e) => taskIds.has(e.taskId) && taskIds.has(e.dependsOn));

  const liveRows = allAgentsForScope(db, filter);
  const liveRoleByTask = new Map<string, string>();
  for (const a of liveRows) {
    if (a.taskId) liveRoleByTask.set(a.taskId, a.agentRole);
  }

  const waveMap = waveLayers(
    [...taskIds],
    scopedEdges.map((e) => ({ task: e.taskId, dependsOn: e.dependsOn })),
  );

  const nodes: FlowNode[] = taskRows.map((t) => ({
    taskId: t.taskId,
    taskStatus: t.taskStatus,
    title: t.objective,
    liveAgentRole: liveRoleByTask.get(t.taskId) ?? null,
    planVersion: t.planVersion,
    wave: waveMap.get(t.taskId) ?? 0,
  }));

  const waveBuckets = new Map<number, string[]>();
  for (const n of nodes) {
    const list = waveBuckets.get(n.wave) ?? [];
    list.push(n.taskId);
    waveBuckets.set(n.wave, list);
  }
  const waves = [...waveBuckets.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids.sort());

  return {
    nodes,
    edges: scopedEdges.map((e) => ({
      task: e.taskId,
      dependsOn: e.dependsOn,
      edgeType: e.edgeType,
      edgeProvenance: e.edgeProvenance,
    })),
    waves,
    planVersions,
  };
}

// ---------------------------------------------------------------------------
// providerAgreement() — Phase 8 cross-provider calibration (`smith stats
// providers`, CLI only — no UI page in scope for Phase 8).
// ---------------------------------------------------------------------------

export interface ProviderAgreementStat {
  provider: string;
  /** Every judge run attempted against this provider, answered or not. */
  runs: number;
  /**
   * Runs that produced a schema-valid verdict — `agreementRate`'s denominator,
   * carried in the row so a reader can tell 0-of-0 from 0-of-many (D-168).
   */
  verdicts: number;
  /**
   * Fraction of the runs that ANSWERED whose verdict matched the native
   * verdict — includes shadow-mode runs, the whole point of calibrating before
   * promotion. `null` when nothing answered: a provider that never returned a
   * schema-valid verdict has told us nothing about how it judges, and 0 there
   * would read as a consistent dissenter (D-168, and D-31 before it — silence
   * is not assent).
   */
  agreementRate: number | null;
  /** Runs that reported a latency — `meanLatencyMs`'s denominator (D-168). */
  latencySamples: number;
  /** Mean over the runs that reported a latency; `null` when none did — a failed run records `latency_ms: null`, and averaging that in at 0 would make the provider that never answered the fastest on the board (D-168). */
  meanLatencyMs: number | null;
  /**
   * Fraction of runs where the provider ANSWERED and the answer could not be
   * used — invalid JSON, a schema the compiled validator rejects, or an answer
   * past the output cap — even after quorum.ts's one retry. High here means
   * the provider/prompt pairing needs work before promotion.
   *
   * Narrowed under D-253. It used to count every failed run, so a provider
   * that was never sent a request scored 1.0 and read as one whose answers do
   * not parse. Runs that failed before an answer arrived are in
   * `transportFailureRate`; runs logged before D-253, which recorded no code
   * at all, are in neither.
   */
  schemaFailureRate: number;
  /**
   * Fraction of runs where no usable answer ever arrived: no key exported, no
   * CLI on PATH, a timeout, an HTTP error, a provider not configured at all.
   * High here means the transport is broken, and NOTHING here is evidence
   * about how this provider judges — fix the transport, then re-measure
   * (D-253).
   */
  transportFailureRate: number;
  /**
   * Failed runs by provider error code, the field that names which repair to
   * make. `{}` when every run answered. Failures logged before D-253 carry no
   * code and key as `unclassified`: they are counted here so the totals still
   * add up, and charged to neither rate, because the log does not record why
   * they failed and this is not the place to guess.
   */
  failuresByCode: Record<string, number>;
}

interface JudgeVerdictPayload {
  provider?: string;
  agreement_with_native?: boolean;
  schema_failure?: boolean;
  error_code?: string | null;
  latency_ms?: number | null;
}

/** Per-provider judge-run calibration stats, read straight off `judge-verdict` events (quorum.ts's recordJudgeRun()) — no dedicated projection table (YAGNI: eventsRaw already carries every event untouched, same pattern analytics() uses for task-result-recorded). */
export function providerAgreement(
  db: SmithDb,
  scope: Scope = {},
  opts: { since?: string } = {},
): ProviderAgreementStat[] {
  const conds = [eq(eventsRaw.eventType, 'judge-verdict')];
  if (scope.sessionId) conds.push(eq(eventsRaw.sessionId, scope.sessionId));
  if (opts.since) conds.push(gte(eventsRaw.ts, opts.since));

  const rows = db
    .select({ payload: eventsRaw.payload, project: eventsRaw.project })
    .from(eventsRaw)
    .where(and(...conds))
    .all();
  const scoped = filterByProject(rows, scope);

  const byProvider = new Map<
    string,
    {
      runs: number;
      verdicts: number;
      agreements: number;
      latencySum: number;
      latencyCount: number;
      schemaFailures: number;
      transportFailures: number;
      failuresByCode: Map<string, number>;
    }
  >();
  for (const row of scoped) {
    const p = JSON.parse(row.payload) as JudgeVerdictPayload;
    if (!p.provider) continue;
    const bucket = byProvider.get(p.provider) ?? {
      runs: 0,
      verdicts: 0,
      agreements: 0,
      latencySum: 0,
      latencyCount: 0,
      schemaFailures: 0,
      transportFailures: 0,
      failuresByCode: new Map<string, number>(),
    };
    bucket.runs += 1;
    // D-168: `schema_failure` is the one predicate for "this run never came
    // back with a verdict", so it decides both counters. recordJudgeRun()
    // stamps `agreement_with_native: false` on a failed run — not because the
    // provider dissented but because there was nothing to compare — and that
    // false is on the log for good. Reading it as a disagreement is the
    // reader's mistake to avoid, not the writer's to re-record.
    if (p.schema_failure) {
      // D-253: which kind of failure is the error code's answer, not this
      // boolean's — it is true for an answer that would not parse and equally
      // true for a request that was never sent. A pre-D-253 row has no code,
      // so it is counted as a failure and named `unclassified` rather than
      // assigned to a rate on a guess.
      const code = p.error_code ?? null;
      bucket.failuresByCode.set(
        code ?? 'unclassified',
        (bucket.failuresByCode.get(code ?? 'unclassified') ?? 0) + 1,
      );
      if (code !== null) {
        if (judgeFailureKind(code) === 'schema') bucket.schemaFailures += 1;
        else bucket.transportFailures += 1;
      }
    } else {
      bucket.verdicts += 1;
      if (p.agreement_with_native) bucket.agreements += 1;
    }
    if (typeof p.latency_ms === 'number') {
      bucket.latencySum += p.latency_ms;
      bucket.latencyCount += 1;
    }
    byProvider.set(p.provider, bucket);
  }

  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, b]) => ({
      provider,
      runs: b.runs,
      verdicts: b.verdicts,
      // Each rate divides by the observations it actually has, and says `null`
      // when it has none. The old code divided both by `runs`, which turned
      // the factory's five all-failing deepseek runs into "agrees 0% of the
      // time, answers in 0ms" — a dissent and a speed record, both off zero
      // observations. The two failure rates keep `runs` as their denominator
      // because every run is evidence for them: a run either reached a verdict
      // or failed in one of two nameable ways, and all three are recorded.
      // They do not sum to 1 minus the answer rate when pre-D-253 rows are in
      // the window — those are in `failuresByCode` under `unclassified` and
      // nowhere else.
      agreementRate: b.verdicts > 0 ? b.agreements / b.verdicts : null,
      latencySamples: b.latencyCount,
      meanLatencyMs: b.latencyCount > 0 ? b.latencySum / b.latencyCount : null,
      schemaFailureRate: b.runs > 0 ? b.schemaFailures / b.runs : 0,
      transportFailureRate: b.runs > 0 ? b.transportFailures / b.runs : 0,
      failuresByCode: Object.fromEntries(b.failuresByCode),
    }));
}

// ---------------------------------------------------------------------------
// pulse()
// ---------------------------------------------------------------------------

/**
 * The counters the app shell watches for movement.
 *
 * Only monotonic quantities belong here. A nav badge reading "3 new" is a
 * claim that three things *arrived*, and a difference between two polls only
 * means that if the underlying number can never fall — subtract a *level*
 * (open tasks, pending lessons) and the operator clearing one produces a
 * negative "arrival" count. Both fields below are counts of rows projected
 * from an append-only log, so a poll-over-poll delta is always an arrival.
 */
export interface PulseCounts {
  /** Every projected event — the universe the Timeline page lists. */
  events: number;
  /** Every projected error row — what the Errors page aggregates. */
  errors: number;
}

export interface PulseResult {
  /** ISO ts of the newest projected event; `null` when nothing is projected. */
  lastEventAt: string | null;
  /** That event's type — the last thing the factory actually did. */
  lastEventType: string | null;
  counts: PulseCounts;
  /**
   * Lessons still waiting on an operator decision. A *level*, not a counter:
   * it falls when the operator approves one, so the shell renders the number
   * itself rather than a delta (see PulseCounts). Never project-scoped — the
   * `lessons` table carries no project column (schema.ts), and filtering it
   * here would be a claim the projection cannot back.
   */
  lessonsPending: number;
}

/**
 * One cheap read the app shell polls from every page: "is the factory still
 * moving, and what has arrived since I looked?"
 *
 * It exists so liveness is a *shell* fact rather than an Overview fact. Every
 * page polls its own data, and on nine of them a frozen server was
 * indistinguishable from a quiet factory — which is precisely the confusion
 * ui/src/lib/liveness.ts was written to end, on the one page that had it.
 *
 * This changes nothing about the transport: design-spec.md §8 ("No
 * WebSockets") still holds, and this is the same polling contract asked once
 * for the frame instead of once more per page. It is deliberately not a push
 * and deliberately not a toast — an arrival the operator did not cause
 * belongs on a surface they can come back to, not in something that expires.
 *
 * Column-projected on purpose: `events_raw.payload` holds every event body,
 * and nothing here reads one, so a 5s shell poll never pulls the log's bodies
 * into memory just to count its rows.
 */
export function pulse(db: SmithDb, scope: Scope = {}): PulseResult {
  const eventCols = {
    ts: eventsRaw.ts,
    eventType: eventsRaw.eventType,
    project: eventsRaw.project,
    eventId: eventsRaw.eventId,
  };
  const allEvents = scope.sessionId
    ? db.select(eventCols).from(eventsRaw).where(eq(eventsRaw.sessionId, scope.sessionId)).all()
    : db.select(eventCols).from(eventsRaw).all();
  const events = filterByProject(allEvents, scope);

  const errorCols = { project: errors.project };
  const allErrors = scope.sessionId
    ? db.select(errorCols).from(errors).where(eq(errors.sessionId, scope.sessionId)).all()
    : db.select(errorCols).from(errors).all();

  const lessonCols = { lessonStatus: lessons.lessonStatus };
  const lessonRows = scope.sessionId
    ? db.select(lessonCols).from(lessons).where(eq(lessons.sessionId, scope.sessionId)).all()
    : db.select(lessonCols).from(lessons).all();

  // Max over `ts`, not "the last row": rows land in the order the projector
  // folded them, and a rebuild folds one session to completion before it
  // starts the next — so the final row is the newest event of the last
  // session, which is not the newest event. Ties on `ts` are common enough to
  // need an answer of their own; isLaterEvent has it.
  let newest: { ts: string; eventType: string; eventId: string } | null = null;
  for (const e of events) {
    if (newest === null || isLaterEvent(e, newest)) newest = e;
  }

  return {
    lastEventAt: newest?.ts ?? null,
    lastEventType: newest?.eventType ?? null,
    counts: {
      events: events.length,
      errors: filterByProject(allErrors, scope).length,
    },
    // An unrecognised status is not pending — same reading as lessonsPage(),
    // which buckets it as `closed`.
    lessonsPending: lessonRows.filter((r) => LESSON_BUCKET_FOR_STATUS[r.lessonStatus] === 'pending')
      .length,
  };
}

// Re-exported for callers that only need the raw prompt/edge/waiver rows
// (e.g. a future UI's simpler list views) without the composed pages above.
export { edges, prompts, waivers };
