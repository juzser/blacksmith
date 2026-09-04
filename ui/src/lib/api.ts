// Thin fetch client for ui/server's read routes (app.ts). Response shapes
// mirror factory/orchestrator/src/db/queries.ts's return types field-for-
// field — kept as local interfaces rather than importing across the
// server/client boundary (ui/ and ui/server/ are separate TS projects; see
// ui/server/src/app.ts's header comment for why they don't share a build).
import { applySessionScope, type SessionScope } from './sessionScope.js';

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
  /** The most recent event's type — what this session just did. */
  lastEventType: string | null;
  /**
   * Projects the session's tasks belong to. Empty for a run that has not
   * created a task yet (the `sessions` table has no project column of its
   * own — membership is derived from tasks).
   */
  projects: string[];
}
export interface EpicTokenSpend {
  epicId: string;
  tokensSpent: number;
  tokensBudget: number | null;
}
export interface MilestoneTaskRef {
  taskId: string;
  taskStatus: string;
  title: string | null;
  updatedAt: string;
  dependencyReady: boolean;
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
  project: string;
  /** 'factory' | 'dogfood' | 'product' — roadmap.ts's MilestoneKind. */
  kind: string;
  recentDone?: MilestoneTaskRef[];
  nextUp?: MilestoneTaskRef[];
}
export interface RecentDispatch {
  eventId: string;
  ts: string;
  agentRole: string;
  provider: string;
  modelTier: string;
  taskId: string | null;
  reason: string | null;
}
export interface ProjectOverviewSummary {
  project: string;
  liveAgentCount: number;
  epicsInFlight: string[];
  tokensSpent: number;
  tokensBudget: number | null;
  alerts: { escalations: number; pendingWaivers: number };
}
export interface ClosedEpic {
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
  /** Every projected session, most recently active first. */
  runningSessions: RunningSession[];
  /** Epics with non-terminal work and no `epic-closed` event. */
  epicsInFlight: string[];
  /** Epics with an `epic-closed` event, newest first (D-43/P9-27). */
  closedEpics: ClosedEpic[];
  tokensByEpic: EpicTokenSpend[];
  alerts: { escalations: number; pendingWaivers: number };
  milestoneProgress: MilestoneProgress[];
  recentDispatches: RecentDispatch[];
  liveAgentCountDelta5m: number;
  budgetUsedPctPointDelta1h: number | null;
  projects?: ProjectOverviewSummary[];
}

/**
 * Every epic an operator can still pick on Kanban/Flow: the ones in flight,
 * then the closed ones newest first. A close removes an epic from
 * `epicsInFlight` (D-43/P9-27), and its board has to stay reachable after that.
 */
export function selectableEpics(overview: OverviewResult): string[] {
  const closed = overview.closedEpics ?? [];
  return [...new Set([...overview.epicsInFlight, ...closed.map((e) => e.epicId)])];
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

export interface KanbanTag {
  case: string | null;
  origin: string | null;
  severity: string | null;
}
export interface KanbanTask {
  taskId: string;
  taskStatus: string;
  title: string | null;
  agentRole: string | null;
  agentModelTier: string | null;
  milestoneId: string | null;
  tags: KanbanTag;
}
export interface KanbanColumn {
  taskStatus: string;
  tasks: KanbanTask[];
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
    branch: string | null;
    project: string | null;
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
    status: string;
  }>;
  findings: Array<{
    findingId: string;
    fingerprint: string;
    findingCategory: string;
    severity: string;
    findingStatus: string;
    summary: string;
    waiverId: string | null;
  }>;
  artifacts: Array<{ id: string; type: string; path: string; description: string | null }>;
  branch: string | null;
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
}
export interface LessonsResult {
  pending: LessonRecord[];
  approved: LessonRecord[];
  /** Rejected, superseded, or invalidated — closed, but still auditable (D-220). */
  closed: LessonRecord[];
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
export interface ErrorsResult {
  byClass: ErrorGroupCount[];
  byDay: ErrorDayCount[];
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
export function fetchSessions(session?: SessionScope, project?: string): Promise<RunningSession[]> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  const qs = q.toString();
  return getJson(`/api/sessions${qs ? `?${qs}` : ''}`);
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

export function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  return getJson(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function fetchLessons(session?: SessionScope): Promise<LessonsResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  const qs = q.toString();
  return getJson(`/api/lessons${qs ? `?${qs}` : ''}`);
}

export function fetchErrors(session?: SessionScope, project?: string): Promise<ErrorsResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
  const qs = q.toString();
  return getJson(`/api/errors${qs ? `?${qs}` : ''}`);
}

export function fetchAnalytics(session?: SessionScope, project?: string): Promise<AnalyticsResult> {
  const q = new URLSearchParams();
  applySessionScope(q, session);
  if (project) q.set('project', project);
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
  title: string | null;
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
  waves: string[][];
  /** Every plan version in scope, newest first — including ones `nodes` does not show (D-165). */
  planVersions: number[];
}

export function fetchFlow(
  params: { session?: SessionScope; project?: string; epic?: string; planVersion?: number } = {},
): Promise<FlowGraph> {
  const q = new URLSearchParams();
  applySessionScope(q, params.session);
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
): Promise<{ applied: number }> {
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
