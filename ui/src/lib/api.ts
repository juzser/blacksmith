// Thin fetch client for ui/server's read routes (app.ts). Response shapes
// mirror factory/orchestrator/src/db/queries.ts's return types field-for-
// field — kept as local interfaces rather than importing across the
// server/client boundary (ui/ and ui/server/ are separate TS projects; see
// ui/server/src/app.ts's header comment for why they don't share a build).
import type { LiveSessionsResult } from './liveSessions.js';
import { applySessionScope, type SessionScope } from './sessionScope.js';
import type { StoreRef } from './storeKey.js';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: { code: 'unknown', message: res.statusText } }));
    throw new ApiError(
      body.error?.code ?? 'unknown',
      body.error?.message ?? res.statusText,
      res.status,
    );
  }
  return (await res.json()) as T;
}

export interface LiveAgentGroup {
  agentRole: string;
  provider: string;
  modelTier: string;
  count: number;
}
export interface LiveAgentEntry {
  id: string;
  /**
   * Which run dispatched this agent. `agents` rows stay `live` until a
   * terminal event closes them out, so one Overview can hold rows from
   * several sessions at once — this is what lets a row be attributed to the
   * session it belongs to instead of being shown as "running now".
   */
  sessionId: string;
  agentRole: string;
  provider: string;
  modelTier: string;
  taskId: string | null;
  /**
   * The epic this agent works on. An epic-level dispatch — planner,
   * spec-reviewer, scribe, epic-close judge — names one and holds no task,
   * which is half the live fleet in a real run (D-234). Read it through
   * lib/agentScope.ts, never bare.
   */
  epicId: string | null;
  dispatchedAt: string;
}
/**
 * One projected session — a factory run — as the Overview's "Now running"
 * card reads it. Mirrors queries.ts's RunningSession field-for-field.
 */
export interface RunningSession {
  sessionId: string;
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  /** `agents` rows still `live` for this session. Includes stale ghosts. */
  liveAgentCount: number;
  /**
   * The subset of `liveAgentCount` dispatched within the factory's own 4h
   * staleness window (agents-registry.ts DEFAULT_STALE_HOURS) as of the
   * server's clock. Additive next to `liveAgentCount` rather than replacing
   * it: the ghosts are still a fact worth stating ("3 stalled not shown"),
   * just no longer one worth drawing (operator directive, running-only
   * liveness). The client's own `agentActivity()` decides the same question
   * from `liveAgentEntries` against the browser clock; this field exists for
   * the surfaces that get the count without the entries (session picker).
   */
  workingAgentCount: number;
  /** The most recent event's type — what this session just did. */
  lastEventType: string | null;
  /** Agent role of the last event when it is a dispatch, else null. */
  lastStepRole: string | null;
  /** Id of the task that dispatch was for, else null. */
  lastStepTaskId: string | null;
  /** That task's `title` column, null when unset; name it with shortTaskName(). */
  lastStepTaskTitle: string | null;
  /**
   * Projects the session worked on: those of the tasks it created, and of
   * every task and epic its own events and agents name. Empty for a run that
   * names none yet (the `sessions` table has no project column of its own —
   * membership is derived from tasks).
   */
  projects: string[];
  /**
   * The session id when it starts with the first dispatched agent's epic
   * id plus a dash, else that epic id, else null; never prompt text.
   */
  title?: string | null;
  /** Which store the row came from; set by `?stores=all`, absent on the served store's own list. */
  store?: StoreRef;
}
export interface EpicTokenSpend {
  epicId: string;
  tokensSpent: number;
  tokensBudget: number | null;
  /** Results whose `token_usage` was `{ measured: false }` — tokensSpent is a floor, not exact, when this is > 0. */
  unmeasured: number;
}
export interface MilestoneTaskRef {
  taskId: string;
  taskStatus: string;
  /** The task's objective (a paragraph): hover text only. Name the task from `taskTitle`. */
  title: string | null;
  /** The `tasks.title` column; null when unset. Never the objective. */
  taskTitle: string | null;
  updatedAt: string;
  dependencyReady: boolean;
}
export interface MilestoneProgress {
  /** Which store the milestone came from; set by the merged roadmap read, absent on a single-store payload. */
  store?: StoreRef;
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
  /** Results whose `token_usage` was `{ measured: false }` — tokensSpent is a floor, not exact, when this is > 0. */
  unmeasured: number;
  project: string;
  /** 'factory' | 'dogfood' | 'product' — roadmap.ts's MilestoneKind. */
  kind: string;
  recentDone?: MilestoneTaskRef[];
  nextUp?: MilestoneTaskRef[];
  /** DS4 S5a — earliest task activity / latest completion (null until every task is terminal). See orchestrator queries.ts's MilestoneProgress. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Same derivation, one row per epic this milestone maps, for the Roadmap swimlane's per-epic bars. */
  epics: EpicDates[];
  /** DS4 S5b — this milestone's tasks folded into the same 4 buckets as each epic's `statusCounts` below. */
  statusCounts: StatusCounts;
}
/** DS4 S5b — the Kanban board's status->column fold, condensed to 4 buckets. See orchestrator queries.ts's StatusCounts. */
export interface StatusCounts {
  done: number;
  review: number;
  inProgress: number;
  todo: number;
  /** DS4 S5b fix round 1 — tasks in status `superseded`, see orchestrator queries.ts's StatusCounts. */
  superseded: number;
}
/** DS4 S5b — an epic's own status, derived from its statusCounts. See orchestrator queries.ts's EpicStatus. */
export type EpicStatus = 'done' | 'review' | 'in_progress' | 'todo';
export interface EpicDates {
  epicId: string;
  startedAt: string | null;
  finishedAt: string | null;
  statusCounts: StatusCounts;
  status: EpicStatus;
  project: string;
  prUrl: string | null;
  sourcePrompt: RequestQuote | null;
}
export interface RecentDispatch {
  store?: StoreRef;
  eventId: string;
  ts: string;
  agentRole: string;
  provider: string;
  modelTier: string;
  taskId: string | null;
  /** The dispatched task's `tasks.title` column; null when unset. Never the objective. */
  taskTitle: string | null;
  reason: string | null;
  /** Which attempt this was — Home's derived line when `reason` is null. */
  round: number;
}
/** An in-flight epic nothing has touched for more than 7 days. */
export interface IdleEpic {
  epicId: string;
  /** Whole days since its last activity, rounded down. */
  idleDays: number;
}
export interface ProjectOverviewSummary {
  store?: StoreRef;
  project: string;
  liveAgentCount: number;
  /** Of `liveAgentCount`, the ones inside the 4h window — see RunningSession.workingAgentCount. */
  workingAgentCount: number;
  epicsInFlight: string[];
  /** `epicsInFlight` narrowed to epics with a task in a truly open status (not merely escalated/failed). */
  epicsActivelyRunning: string[];
  /** The in-flight epics left out of `epicsActivelyRunning` for being idle over 7 days. */
  epicsIdle: IdleEpic[];
  tokensSpent: number;
  tokensBudget: number | null;
  /** Results whose `token_usage` was `{ measured: false }` — tokensSpent is a floor, not exact, when this is > 0. */
  unmeasured: number;
  /** Per-epic spend and budget for the project, as OverviewResult.tokensByEpic. */
  tokensByEpic: EpicTokenSpend[];
  alerts: { escalations: number; pendingWaivers: number };
}
export interface ClosedEpic {
  store?: StoreRef;
  epicId: string;
  closedBy: string;
  machineVerdict: string | null;
  machineReason: string | null;
  overrideRationale: string | null;
  blockers: string[];
  closedAt: string;
}
export interface OverviewResult {
  liveAgents: LiveAgentGroup[];
  liveAgentEntries: LiveAgentEntry[];
  liveAgentCount: number;
  /**
   * `liveAgentCount` split by the factory's 4h window (see
   * RunningSession.workingAgentCount): `working + stalled === liveAgentCount`.
   * The Overview's "Active agents" stat reads `working` and states `stalled`
   * beside it, so a registry full of ghosts no longer reads as a busy factory.
   */
  workingAgentCount: number;
  stalledAgentCount: number;
  /** Every projected session, most recently active first. */
  runningSessions: RunningSession[];
  /** Epics with non-terminal work and no `epic-closed` event. */
  epicsInFlight: string[];
  /** `epicsInFlight` narrowed to epics with a task in a truly open status (not merely escalated/failed). */
  epicsActivelyRunning: string[];
  /** The in-flight epics left out of `epicsActivelyRunning` for being idle over 7 days. */
  epicsIdle: IdleEpic[];
  /** `epicsInFlight` with the store each epic lives in; absent from an older single-store payload. */
  epicsInFlightByStore?: { epicId: string; store: StoreRef }[];
  /** Epics with an `epic-closed` event, newest first (D-43/P9-27). */
  closedEpics: ClosedEpic[];
  tokensByEpic: EpicTokenSpend[];
  alerts: { escalations: number; pendingWaivers: number };
  milestoneProgress: MilestoneProgress[];
  recentDispatches: RecentDispatch[];
  liveAgentCountDelta5m: number;
  /**
   * `workingAgentCount` now minus the working count five minutes ago, the
   * window re-folded at the cutoff — one population measured at both ends, so
   * an agent ageing past 4h shows as a -1 here and nowhere else.
   */
  workingAgentCountDelta5m: number;
  budgetUsedPctPointDelta1h: number | null;
  projects?: ProjectOverviewSummary[];
}

/**
 * Every epic an operator can still pick on Kanban/Flow: the ones in flight,
 * the running ones before the idle ones, then the closed ones newest first. A close removes an epic from
 * `epicsInFlight` (D-43/P9-27), and its board has to stay reachable after that.
 */
export function selectableEpics(overview: OverviewResult): string[] {
  const closed = overview.closedEpics ?? [];
  const idle = new Set(overview.epicsIdle.map((e) => e.epicId));
  const running = overview.epicsInFlight.filter((id) => !idle.has(id));
  const idling = overview.epicsInFlight.filter((id) => idle.has(id));
  return [...new Set([...running, ...idling, ...closed.map((e) => e.epicId)])];
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
  /** DS6 PR4b: the session this event belongs to. */
  sessionId: string;
  /** DS6 PR4b: the owning session's title, falling back to its id when untitled. */
  sessionTitle: string;
  /** The `title` column of the task the event names; null when none. Name it with shortTaskName(). */
  taskTitle: string | null;
}

export interface KanbanTag {
  case: string | null;
  origin: string | null;
  severity: string | null;
}
export interface KanbanDependency {
  taskId: string;
  /** The dependency's objective. Name it from `taskTitle`. */
  title: string | null;
  /** The dependency's `tasks.title` column; null when unset. */
  taskTitle: string | null;
  status: string | null;
  edgeType: string;
}
export interface KanbanTask {
  store?: StoreRef;
  taskId: string;
  taskStatus: string;
  /** The task's objective (a paragraph): hover text only. Name the task from `taskTitle`. */
  title: string | null;
  /** The `tasks.title` column; null when unset. Never the objective. */
  taskTitle: string | null;
  agentRole: string | null;
  agentModelTier: string | null;
  /**
   * Whether the agent the chip names is still on the task — read off the
   * agents rows, not the dispatch (fix n of the 2026-09-14 cross-provider
   * UI check: `agentRole` alone says who was *sent*). `null` is nobody.
   */
  agentActivity: 'working' | 'stalled' | null;
  milestoneId: string | null;
  tags: KanbanTag;
  /** DS3 — tasks.updated_at. */
  updatedAt: string;
  /** DS3 — tasks.project. */
  project: string | null;
  /** DS3 — count of this task's dispatch_decision events. */
  attemptCount: number;
  /** DS3 — highest judge round among this task's judge-role dispatches, or null. */
  judgeRound: number | null;
  /** DS3 — count of this task's operator_feedback rows. */
  commentCount: number;
  /** DS3 — the epic's integration PR url, or null. */
  prUrl: string | null;
  /** DS3 — this task's own edges. */
  dependencies: KanbanDependency[];
  /** DS3 — "<project>: <humanized epic id>[ (finished)]", or null with no epic. */
  epicLabel: string | null;
  /** DS3 — whether the causal-parent walk found a linked request. */
  hasRequest: boolean;
  /** DS3 — first line of the linked request's prompt, or null when `hasRequest` is false. */
  requestFirstLine: string | null;
  /** The task a follow-up fix came from, or null for any other task. */
  parentTaskId: string | null;
  /** That parent's objective, or null when this is no follow-up or the parent has no task row. */
  parentTitle: string | null;
  /** That parent's `tasks.title` column, or null when unset, no follow-up, or no task row. */
  parentTaskTitle: string | null;
}
export interface KanbanColumn {
  taskStatus: string;
  tasks: KanbanTask[];
}

/** DS3 §4.7 — the operator prompt behind a task, or its epic's source prompt as a fallback. */
export interface RequestQuote {
  prompt: string;
  ts: string;
  eventId: string;
  source: 'task' | 'epic';
}

export interface TaskDetail {
  task: {
    taskId: string;
    sessionId: string;
    epicId: string | null;
    caseTag: string | null;
    origin: string | null;
    taskStatus: string;
    planVersion: number | null;
    objective: string | null;
    /** DS3 part 2 item 1 — optional task-spec fields (slice A), carried through unchanged. */
    title: string | null;
    summary: string | null;
    branch: string | null;
    project: string | null;
    updatedAt: string;
  };
  claims: string[];
  attempts: Array<{
    eventId: string;
    ts: string;
    agentRole: string;
    provider: string;
    modelTier: string;
    agentStatus: string | null;
    terminalAt: string | null;
  }>;
  agents: Array<{
    id: string;
    agentRole: string;
    provider: string;
    modelTier: string;
    dispatchedAt: string;
    status: SessionAgent['status'];
  }>;
  findings: Array<{
    findingId: string;
    fingerprint: string;
    findingCategory: string;
    severity: string;
    findingStatus: string;
    summary: string;
    waiverId: string | null;
    findingScope: string;
    specPlanVersion: number | null;
    criterionRef: string | null;
  }>;
  artifacts: Array<{ id: string; type: string; path: string; description: string | null }>;
  feedback: Array<{
    id: string;
    taskId: string;
    sessionId: string;
    body: string;
    kind: string;
    source: string;
    externalId: string | null;
    author: string | null;
    recordedAt: string;
    recordedEventId: string;
    resolvedAt: string | null;
    resolution: string | null;
    followUpTaskId: string | null;
  }>;
  branch: string | null;
  /** DS3 §4.7 — the operator prompt behind this task, or its epic's source prompt as a fallback. */
  requestQuote: RequestQuote | null;
  /** DS3 part 2 item 1 — same "is anybody still on this task" field as `KanbanTask.agentActivity`. */
  agentActivity: 'working' | 'stalled' | null;
  /** A follow-up's origin task, else null (same derivation as `KanbanTask.parentTaskId`). */
  parentTaskId: string | null;
  /** The origin task's `title` column; null when there is no parent or it has none. */
  parentTaskTitle: string | null;
}

/** DS3 §4.7 — one entry per dispatch attempt, judge round, result, or error, for `RunHistoryTimeline`. */
export interface TaskRun {
  eventId: string;
  ts: string;
  kind: 'dispatch' | 'judge-report' | 'judge-verdict' | 'result' | 'error';
  agentRole: string | null;
  round: number | null;
  tokensTotal: number | null;
  outcome: string | null;
}

/** Pattern 11 totals bar (ds-spec.md §4.7): sums across a task's runs. A
 * `null` field means "not measured" and is left out, never rendered as 0. */
export interface TaskTotals {
  tokens: number | null;
  agentTimeMs: number | null;
  elapsedMs: number | null;
  /** DS6 PR4b: first dispatch's ts; null when the task has no dispatch yet. */
  startedAt: string | null;
  /** DS6 PR4b: last result/error's ts; null while no run has ended yet. */
  endedAt: string | null;
}

export interface LessonRecord {
  lessonId: string;
  sessionId: string;
  lessonType: string;
  lessonLevel: string;
  lessonStatus: string;
  lessonScope: string;
  statement: string;
  provenanceEventIds: string; // JSON array, parsed by the caller
  evidence: string | null;
  timesPrevented: number;
  validFrom: string;
  claimPath: string | null;
  agentRole: string | null;
  caseType: string | null;
}
export interface LessonsResult {
  pending: LessonRecord[];
  approved: LessonRecord[];
  /** Rejected, superseded, or invalidated — closed, but still auditable (D-220). */
  closed: LessonRecord[];
  /** The ts of the latest lessons-pass-completed event, or null if dream() has never run (DS8 plan §2.3). */
  lastCheckedAt: string | null;
}

/** ds-spec.md §4.1 NeedsYouInbox row: mirrors queries.ts's InboxRow. */
export type InboxKind = 'waiver' | 'escalation' | 'lesson_candidate';
export interface InboxRow {
  id: string;
  kind: InboxKind;
  project: string | null;
  taskId: string | null;
  createdAt: string;
  taskTitle: string | null;
  role: string | null;
  reason: string | null;
  findingCount: number;
  findingSummaries: string[];
  statement: string | null;
  /** Which store the row came from; absent from an API that predates multi-store reads. */
  store?: StoreRef;
}
export interface InboxResult {
  rows: InboxRow[];
}

/** lessons.ts's NoveltyMatch — the nearest statement in the corpus and its Jaccard score. */
export interface NoveltyMatch {
  statement: string;
  score: number;
  /**
   * The bar THIS pair was judged at. Equal to `LessonNoveltyReview.threshold`
   * unless the gate corrected it down for the length of the shorter statement
   * (P9-35 (a)) — which it does for most real lessons, so a notice that quotes
   * the configured threshold next to the score can read as a contradiction.
   */
  threshold: number;
}
/**
 * lessons.ts's LessonNoveltyReview: what the novelty gate saw at transition
 * time. Every lesson write route returns it (ui/server/src/app.ts's
 * `transition()`), and it is null when the lesson is only moving OUT of
 * memory — scoring text that is leaving answers no question.
 */
export interface LessonNoveltyReview {
  /** The text actually scored: the edit if there was one, else the current statement. */
  statement: string;
  edited: boolean;
  novel: boolean;
  polarityConflict: boolean;
  /** The configured bar; `mostSimilar.threshold` is the one the verdict was taken at. */
  threshold: number;
  mostSimilar: NoveltyMatch | null;
  mostSimilarLessonId: string | null;
  /** True when a non-novel edit was let through by `acceptDuplicate`. */
  overridden: boolean;
}
export interface LessonWriteResult {
  lessonId: string;
  status: string;
  novelty: LessonNoveltyReview | null;
}

export interface ErrorGroupCount {
  /** `${errorGroup}.${errorClass}|${severity}` -- the row's whole identity.
   *  Keying an Errors row on `errorGroup` alone merges every class and
   *  severity in that group onto one key (D-214). */
  id: string;
  errorGroup: string;
  errorClass: string;
  severity: string;
  count: number;
}
export interface ErrorDayCount {
  day: string;
  count: number;
}
/** DS6 PR2 (§4.3 Errors chip, audit Errors-5) — one row per error class, merged
 *  across session/project/severity. Additive; `byClass`/`byDay` are unchanged. */
export interface ErrorClassSummary {
  id: string;
  errorGroup: string;
  errorClass: string;
  count: number;
  severityMix: Record<string, number>;
  lastSeen: string;
  projects: string[];
  trend7d: number[];
}
export interface ErrorsResult {
  byClass: ErrorGroupCount[];
  byDay: ErrorDayCount[];
  classSummary: ErrorClassSummary[];
}

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
  /** Of taskCount, the results whose `token_usage` was `{ measured: false }` — excluded from avgTokensPerTask's denominator. */
  unmeasuredTaskCount: number;
}
export interface SameMistakeDay {
  day: string;
  decisions: number;
  sameMistake: number;
  /**
   * `null` on a day the gate decided nothing — mirrors queries.ts's
   * SameMistakeDay, which returns exactly that. Declaring it `number` here hid
   * the case from every consumer's type-checker and the page plotted it at
   * zero (D-31: silence is not assent). Read it through
   * lib/analytics.ts's latestSameMistakeRate.
   */
  rate: number | null;
}
export interface RecheckOutcome {
  taskStatus: string;
  count: number;
}
/**
 * One judge provider's calibration over the runs in scope. Mirrors
 * `ProviderAgreementStat` in db/queries.ts, which `smith stats providers`
 * prints from the same function.
 */
export interface ProviderAgreementStat {
  provider: string;
  /** Every judge run attempted, whether or not it came back. */
  runs: number;
  /** The subset that produced a schema-valid verdict. */
  verdicts: number;
  /** agreements / verdicts — null when nothing answered, which is not 0% (D-168). */
  agreementRate: number | null;
  latencySamples: number;
  meanLatencyMs: number | null;
  schemaFailureRate: number;
  transportFailureRate: number;
  /** Failure count per provider error code; pre-D-253 rows key as `unclassified`. */
  failuresByCode: Record<string, number>;
}

/** DS7 §4.4 — mirrors db/queries.ts's `AnalyticsPeriod`. */
export type AnalyticsPeriod = '7d' | '30d' | '90d';

/** DS7 §4.4 — mirrors db/queries.ts's `DailyTokenBucket`. */
export interface DailyTokenBucket {
  day: string;
  tokensByRole: Record<string, number>;
  tokensByModelTier: Record<string, number>;
  unmeasuredRunCount: number;
}

/** DS7 §4.4 — mirrors db/queries.ts's `RoleModelTierBucket`. */
export interface RoleModelTierBucket {
  role: string;
  modelTier: string;
  runCount: number;
  tokens: number;
  avgTokensPerRun: number | null;
  unmeasuredRunCount: number;
}

export interface AnalyticsResult {
  throughput: ThroughputDay[];
  costByModelTierAndProvider: CostBucket[];
  sameMistakeRateByDay: SameMistakeDay[];
  recheckOutcomes: RecheckOutcome[];
  /**
   * Per-provider judge calibration. The cost series above cannot stand in for
   * it: cost is read off `task-result-recorded`, which only a builder writes,
   * and every external provider here judges rather than builds — so cost names
   * claude alone in every session ever logged (D-255).
   */
  providerAgreement: ProviderAgreementStat[];
  /** Present only when `period` was requested. */
  tokensByDay?: DailyTokenBucket[];
  /** Present only when `period` was requested. */
  tokensByRoleAndModelTier?: RoleModelTierBucket[];
}

export function fetchOverview(session?: SessionScope, project?: string): Promise<OverviewResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  const qs = q.toString();
  return getJson(`/api/overview${qs ? `?${qs}` : ''}`);
}

/**
 * Mirrors PulseResult in factory/orchestrator/src/db/queries.ts. `counts` are
 * monotonic — they only ever grow — which is what lets the shell subtract two
 * polls and call the difference an arrival. `lessonsPending` is a level and is
 * rendered as itself. See usePulse.ts.
 */
export interface PulseResult {
  lastEventAt: string | null;
  lastEventType: string | null;
  counts: { events: number; errors: number };
  lessonsPending: number;
  /**
   * What the server's projection could not land — a session log it could not
   * read, or an event whose payload it had to hold back (D-249). Every count
   * and status the dashboard shows is computed without those events, so the
   * shell says so above the page rather than letting a blank canvas read as an
   * idle factory. Mirrors ProjectionIssue in ui/server/src/app.ts. Optional
   * because a server built before the field omits it, and "the server did not
   * say" must render as nothing to report.
   */
  projectionIssues?: ProjectionIssue[];
}

export interface ProjectionIssue {
  sessionId: string;
  kind: 'session-not-projected' | 'artifacts-skipped';
  eventId?: string;
  /** Already worded for an operator: names the log, the line or the event. */
  message: string;
}

export function fetchPulse(session?: SessionScope, project?: string): Promise<PulseResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  const qs = q.toString();
  return getJson(`/api/pulse${qs ? `?${qs}` : ''}`);
}

/**
 * The topbar session picker's feed: /api/overview's `runningSessions` slice on
 * its own.
 *
 * A route of its own rather than a call to fetchOverview() for two reasons.
 * The shell asks on every scopable page and wants a list of ids, not the stat
 * row and review queue that would ride along. And the two pages that poll
 * /api/overview every 5s are the ones whose e2e guards fail that endpoint
 * deliberately -- a shell-level caller of the same URL puts the frame's
 * picker inside the page's outage, and the page's error state inside the
 * frame's.
 */
export function fetchSessions(
  session?: SessionScope,
  project?: string,
  stores?: 'all',
): Promise<RunningSession[]> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  applyStores(q, stores);
  const qs = q.toString();
  return getJson(`/api/sessions${qs ? `?${qs}` : ''}`);
}

/**
 * One agent in the roster returned by `/api/sessions/:sessionId/agents`.
 * Mirrors queries.ts's SessionAgent field-for-field (DS8 plan §2.1).
 */
export interface SessionAgent {
  id: string;
  agentRole: string;
  provider: string | null;
  modelTier: string | null;
  taskId: string | null;
  taskTitle: string | null;
  epicId: string | null;
  round: number | null;
  dispatchedAt: string;
  terminalAt: string | null;
  terminalType: 'result' | 'error' | 'superseded' | 'abandoned' | null;
  status: 'live' | 'done' | 'error' | 'superseded' | 'abandoned';
  tokens:
    | { state: 'measured'; input: number; output: number; total: number }
    | { state: 'unmeasured' }
    | { state: 'pending' }
    | { state: 'none' };
  lastEventType: string | null;
  lastEventAt: string | null;
}
export interface SessionAgentsResult {
  sessionId: string;
  /** Roles in first-dispatch order, each with its own agents in dispatch order. */
  roles: { agentRole: string; agents: SessionAgent[] }[];
}

/** The session detail drawer's agent roster (DS8 plan §2.1, plan F). */
export function fetchSessionAgents(
  sessionId: string,
  project?: string,
  store?: string,
): Promise<SessionAgentsResult> {
  const q = new URLSearchParams();
  if (project) q.set('project', project);
  applyStores(q, undefined, store);
  const qs = q.toString();
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/agents${qs ? `?${qs}` : ''}`);
}

export function fetchProjects(session?: SessionScope): Promise<ProjectOverviewSummary[]> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  const qs = q.toString();
  return getJson(`/api/projects${qs ? `?${qs}` : ''}`);
}

export interface TimelineParams {
  session?: SessionScope;
  task?: string;
  epic?: string;
  project?: string;
  eventTypes?: string[];
  decisionsOnly?: boolean;
}

export function fetchTimeline(params: TimelineParams = {}): Promise<TimelineEntry[]> {
  const q = new URLSearchParams();
  applySessionScope(q, params.session);
  if (params.task) q.set('task', params.task);
  if (params.epic) q.set('epic', params.epic);
  if (params.project) q.set('project', params.project);
  if (params.eventTypes?.length) q.set('eventTypes', params.eventTypes.join(','));
  if (params.decisionsOnly) q.set('decisionsOnly', 'true');
  const qs = q.toString();
  return getJson(`/api/timeline${qs ? `?${qs}` : ''}`);
}

/** DS6 (ds-spec.md §4.3): the Activity feed's 9 row kinds -- a text tag. */
export type EventKind =
  | 'Prompt'
  | 'Dispatched'
  | 'Returned'
  | 'Finding'
  | 'Gate'
  | 'Merge'
  | 'Error'
  | 'Feedback'
  | 'System';

/** DS6 PR2 (§4.3 table) — a Dispatched row's run result. */
export interface DispatchRun {
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  runStatus: string | null;
  dispatchedAt: string;
  round: number;
}

/** `/api/timeline`'s paged-mode envelope: newest-first entries plus the "Load older" cursor. */
export interface TimelinePage {
  entries: (TimelineEntry & {
    kind: EventKind;
    nearestPromptId: string | null;
    /** Present only on `Dispatched` rows. */
    run?: DispatchRun;
    /** Present only on `Gate` rows; null when the counts cannot be derived. */
    gateCounts?: { passed: number; failed: number } | null;
    /** Present on rows of a `stores=all` or foreign-`store` read. */
    store?: StoreRef;
  })[];
  nextBefore: string | null;
  newestId: string | null;
}

export interface TimelinePageParams extends TimelineParams {
  before?: string;
  after?: string;
  limit?: number;
  kinds?: EventKind[];
  /** Narrow to these factory sessions (one `sessions=` each); never with `session`. */
  sessions?: string[];
  /** `all` reads every store (Activity with no explicit filter); never with `store` or a task/epic/session filter. */
  stores?: 'all';
  /** Reads this one store instead of the served one. */
  store?: string;
}

/** Paged mode (newest-first): present whenever before/after/limit is set, so always here. */
export function fetchTimelinePage(params: TimelinePageParams = {}): Promise<TimelinePage> {
  const q = new URLSearchParams();
  applySessionScope(q, params.session);
  if (params.task) q.set('task', params.task);
  if (params.epic) q.set('epic', params.epic);
  if (params.project) q.set('project', params.project);
  if (params.eventTypes?.length) q.set('eventTypes', params.eventTypes.join(','));
  if (params.decisionsOnly) q.set('decisionsOnly', 'true');
  if (params.kinds?.length) q.set('kind', params.kinds.join(','));
  if (params.before) q.set('before', params.before);
  if (params.after) q.set('after', params.after);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  applySessions(q, params.sessions);
  applyStores(q, params.stores, params.store);
  const qs = q.toString();
  return getJson(`/api/timeline${qs ? `?${qs}` : ''}`);
}

export function fetchKanban(
  epic?: string,
  session?: SessionScope,
  project?: string,
): Promise<KanbanColumn[]> {
  const q = new URLSearchParams();
  if (epic) q.set('epic', epic);
  applySessionScope(q, session);
  if (project) q.set('project', project);
  const qs = q.toString();
  return getJson(`/api/kanban${qs ? `?${qs}` : ''}`);
}

/** One `sessions=` per id (an id may hold a comma); undefined writes nothing. */
function applySessions(q: URLSearchParams, sessions?: string[]): void {
  for (const id of sessions ?? []) q.append('sessions', id);
}

/** `stores=all` fans out; `store=<id>` names one store. Neither: the served store. */
function applyStores(q: URLSearchParams, stores?: 'all', store?: string): void {
  if (stores) q.set('stores', stores);
  if (store) q.set('store', store);
}

/** `?store=` names a foreign store; absent reads the served store. */
function storeQuery(store?: string): string {
  return store ? `?store=${encodeURIComponent(store)}` : '';
}

export function fetchTaskDetail(taskId: string, store?: string): Promise<TaskDetail> {
  return getJson(`/api/tasks/${encodeURIComponent(taskId)}${storeQuery(store)}`);
}

export async function fetchTaskRuns(
  taskId: string,
  store?: string,
): Promise<{ runs: TaskRun[]; totals: TaskTotals }> {
  return getJson<{ runs: TaskRun[]; totals: TaskTotals }>(
    `/api/tasks/${encodeURIComponent(taskId)}/runs${storeQuery(store)}`,
  );
}

export function fetchLessons(session?: SessionScope): Promise<LessonsResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  const qs = q.toString();
  return getJson(`/api/lessons${qs ? `?${qs}` : ''}`);
}

/** `GET /api/active-scope`: what the live CLI sessions drive. Ids, project names and counts only. */
export interface ActiveScopeResult {
  /** false when the CLI session registry could not be read; every list is then empty. */
  measured: boolean;
  readAt: string;
  liveSessions: number;
  unlinkedSessions: number;
  projects: { storeId: string; project: string; liveSessions: number; agentsWorking: number }[];
  epics: { storeId: string; epicId: string; project: string | null }[];
  factorySessions: { storeId: string; sessionId: string }[];
}

export function fetchActiveScope(): Promise<ActiveScopeResult> {
  return getJson('/api/active-scope');
}

export function fetchCliSessions(): Promise<LiveSessionsResult> {
  return getJson('/api/cli-sessions');
}

export function fetchInbox(session?: SessionScope): Promise<InboxResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  const qs = q.toString();
  return getJson(`/api/inbox${qs ? `?${qs}` : ''}`);
}

export function fetchErrors(
  session?: SessionScope,
  project?: string,
  sessions?: string[],
  stores?: 'all',
  store?: string,
): Promise<ErrorsResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  applySessions(q, sessions);
  applyStores(q, stores, store);
  const qs = q.toString();
  return getJson(`/api/errors${qs ? `?${qs}` : ''}`);
}

export function fetchAnalytics(
  session?: SessionScope,
  project?: string,
  period?: AnalyticsPeriod,
  sessions?: string[],
  stores?: 'all',
): Promise<AnalyticsResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  if (period) q.set('period', period);
  applySessions(q, sessions);
  applyStores(q, stores);
  const qs = q.toString();
  return getJson(`/api/analytics${qs ? `?${qs}` : ''}`);
}

export function fetchRoadmap(
  session?: SessionScope,
  project?: string,
): Promise<MilestoneProgress[]> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  const qs = q.toString();
  return getJson(`/api/roadmap${qs ? `?${qs}` : ''}`);
}

export interface FlowNode {
  taskId: string;
  taskStatus: string;
  /** The task's objective (a paragraph): hover text only. Name the task from `taskTitle`. */
  title: string | null;
  /** The `tasks.title` column; null when unset. Never the objective. */
  taskTitle: string | null;
  liveAgentRole: string | null;
  /**
   * `liveAgentRole` restricted to the 4h window — null when the only live
   * agent on this task is a stalled ghost. Drives the Flow node's pulse, which
   * `liveAgentRole` no longer does: a pulse is a claim that work is happening.
   */
  workingAgentRole: string | null;
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
  waves: string[][];
  /** Every plan version in scope, newest first — including ones `nodes` does not show (D-165). */
  planVersions: number[];
}

export function fetchFlow(
  params: {
    session?: SessionScope;
    project?: string;
    epic?: string;
    planVersion?: number;
    /** Reads this one store; epic ids repeat across stores, so a caller that knows the owner names it. */
    store?: string;
  } = {},
): Promise<FlowGraph> {
  const q = new URLSearchParams();
  applySessionScope(q, params.session);
  applyStores(q, undefined, params.store);
  if (params.project) q.set('project', params.project);
  if (params.epic) q.set('epic', params.epic);
  if (params.planVersion !== undefined) q.set('planVersion', String(params.planVersion));
  const qs = q.toString();
  return getJson(`/api/flow${qs ? `?${qs}` : ''}`);
}

export interface WaiverBatchDecision {
  fingerprint: string;
  decision: 'granted' | 'denied';
  operatorNote: string;
}

export function applyWaiverBatch(
  sessionId: string,
  decisions: WaiverBatchDecision[],
): Promise<{ applied: number; findingIdsToCarry: string[] }> {
  return postJson('/api/waivers/apply-batch', { sessionId, decisions });
}

export function approveLesson(sessionId: string, lessonId: string): Promise<LessonWriteResult> {
  return postJson(`/api/lessons/${encodeURIComponent(lessonId)}/approve`, { sessionId });
}

export function rejectLesson(sessionId: string, lessonId: string): Promise<LessonWriteResult> {
  return postJson(`/api/lessons/${encodeURIComponent(lessonId)}/reject`, { sessionId });
}

/**
 * `acceptDuplicate` is the operator's override of the novelty gate on an
 * edited statement, forwarded to the route that already accepts it. Without
 * it the only remedy the server's `lessons.edit-not-novel` message offers is
 * `--accept-duplicate`, a CLI flag no one reading a Dialog can type (P9-36).
 */
export function editLesson(
  sessionId: string,
  lessonId: string,
  edits: {
    statement?: string;
    lessonType?: string;
    lessonScope?: string;
    acceptDuplicate?: boolean;
  },
): Promise<LessonWriteResult> {
  return postJson(`/api/lessons/${encodeURIComponent(lessonId)}/edit`, { sessionId, ...edits });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res
      .json()
      .catch(() => ({ error: { code: 'unknown', message: res.statusText } }));
    throw new ApiError(
      errBody.error?.code ?? 'unknown',
      errBody.error?.message ?? res.statusText,
      res.status,
    );
  }
  return (await res.json()) as T;
}
