import { createHash } from 'node:crypto';
import { isLaterEvent } from './eventOrder.js';
import type { StoredEvent } from './events.js';

/**
 * Pure core of the factory-error-log mechanism: fold the event log into
 * reportable errors from three sources -- a blocked `gate-outcome`, a task
 * reaching `task_status: failed`, and every `error-logged` (including
 * hand-appended ones no in-process hook could observe) -- fingerprint them,
 * and render an issue title/body/comment from named fields only.
 *
 * Purity: no filesystem, no network, no child process, no clock. Events,
 * `now`, and project enablement all arrive as parameters.
 */

// Source 1: `gate-outcome` blocked. `reason` is one of exactly ten strings,
// gate.ts's `GateOutcome`'s blocked arm (not exported as a runtime value, so
// restated here; test/errorIssues.test.ts ties this back to `GateOutcome`
// with a compile-time equality check).
export type GateBlockedReason =
  | 'schema-invalid'
  | 'artifacts-missing'
  | 'not-committed'
  | 'deps-missing'
  | 'judges-outstanding'
  | 'grader-invalid'
  | 'grader-fail'
  | 'tests-failed'
  | 'coverage-evidence'
  | 'findings';

/** A `Record` over every `GateBlockedReason`, not a switch with a default: a reason missing from `GateBlockedReason` fails to compile here. */
const GATE_BLOCKED_ERROR_CLASSES: Record<GateBlockedReason, string> = {
  'schema-invalid': 'gate.blocked.schema-invalid',
  'artifacts-missing': 'gate.blocked.artifacts-missing',
  'not-committed': 'gate.blocked.not-committed',
  'deps-missing': 'gate.blocked.deps-missing',
  'judges-outstanding': 'gate.blocked.judges-outstanding',
  'grader-invalid': 'gate.blocked.grader-invalid',
  'grader-fail': 'gate.blocked.grader-fail',
  'tests-failed': 'gate.blocked.tests-failed',
  'coverage-evidence': 'gate.blocked.coverage-evidence',
  findings: 'gate.blocked.findings',
};

/** Exported for the table-driven test: the ten reasons, read off the table above rather than hand-copied a second time. */
export const GATE_BLOCKED_REASONS = Object.keys(GATE_BLOCKED_ERROR_CLASSES) as GateBlockedReason[];

/** A blocked gate and a failed task carry no payload-level severity; both block a task outright, matching taxonomy.yml's `S2-major`. */
const BLOCKING_SEVERITY = 'S2-major';

const GATE_OUTCOME_EVENT_TYPE = 'gate-outcome';
const ERROR_LOGGED_EVENT_TYPE = 'error-logged';
const TASK_ADDED_EVENT_TYPE = 'task-added';
/** `agents-registry.ts`'s `DISPATCH_EVENT_TYPE`, hand-restated rather than
 * imported -- this module's only imports are `node:crypto` and two local,
 * type-only siblings, on purpose (see the file banner). */
const DISPATCH_DECISION_EVENT_TYPE = 'dispatch_decision';

/**
 * Source 2: `task_status: failed` is set in exactly one place in the whole
 * projector, `db/projector.ts`'s `case 'task-added'` arm copying
 * `p.task_status` verbatim -- every other case assigns a hardcoded literal,
 * never a payload-derived value. So this source is always a `task-added`
 * event whose own payload already declares `task_status: 'failed'`, and
 * carries no failure discriminator beyond that.
 */
const TASK_FAILED_ERROR_CLASS = 'task.failed';

export type ErrorSource = 'gate-outcome' | 'error-logged' | 'task-failed';

/**
 * One reportable error, folded from one contributing log event. `severity`,
 * `latest_event_id`, `timestamp`, `session_id`, `epic_id` and `plan_version`
 * describe its fingerprint group's newest occurrence -- identical across
 * every report sharing a fingerprint.
 */
export interface ErrorReport {
  fingerprint: string;
  project: string | null;
  source: ErrorSource;
  error_class: string;
  task_ref: string;
  severity: string;
  latest_event_id: string;
  timestamp: string;
  session_id: string;
  epic_id: string | null;
  plan_version: number | null;
}

export interface FoldResult {
  reports: ErrorReport[];
  /** Events matching a source's shape but missing a required field. Never thrown. */
  skipped: number;
}

interface Candidate {
  project: string | null;
  source: ErrorSource;
  errorClass: string;
  taskRef: string;
  severity: string;
  eventId: string;
  ts: string;
  sessionId: string;
  epicId: string | null;
  planVersion: number | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The fields every reader takes off the envelope rather than the payload — read once, identical across the sources. */
interface Envelope {
  payload: Record<string, unknown>;
  project: string | null;
  sessionId: string | undefined;
  planVersion: number | null;
  ts: string | undefined;
}

/**
 * One source's reader: a `Candidate`, `'ignore'` when the event carries the
 * type but is not a candidate after all, or `null` when it is one and a
 * required field is missing -- malformed, counted by the caller as `skipped`.
 */
type CandidateReader = (event: StoredEvent, envelope: Envelope) => Candidate | 'ignore' | null;

/**
 * The sources, keyed by the event type each one reads. A table rather than a
 * chain of `if`s so that ISSUE_CANDIDATE_EVENT_TYPES below can be read off
 * it: a fourth source cannot be folded without appearing here, and appearing
 * here is what puts it in the roster.
 */
const CANDIDATE_READERS: Readonly<Record<string, CandidateReader>> = Object.freeze({
  [GATE_OUTCOME_EVENT_TYPE]: (event, { payload, project, sessionId, planVersion, ts }) => {
    const { record } = event;
    if (payload.outcome !== 'blocked') return 'ignore';
    const reasonRaw = asString((payload as { reason?: unknown }).reason);
    const taskRef = asString(record.task_id);
    if (!sessionId || !ts || !taskRef || !reasonRaw) return null;
    if (!(reasonRaw in GATE_BLOCKED_ERROR_CLASSES)) return null;
    const reason = reasonRaw as GateBlockedReason;
    return {
      project,
      source: 'gate-outcome',
      errorClass: GATE_BLOCKED_ERROR_CLASSES[reason],
      taskRef,
      severity: BLOCKING_SEVERITY,
      eventId: event.event_id,
      ts,
      sessionId,
      epicId: null,
      planVersion,
    };
  },
  [ERROR_LOGGED_EVENT_TYPE]: (event, { payload, project, sessionId, planVersion, ts }) => {
    const { record } = event;
    const errorClass = asString((payload as { error?: unknown }).error);
    const severity = asString((payload as { severity?: unknown }).severity);
    const taskRef =
      asString(record.task_id) ?? asString((payload as { task_ref?: unknown }).task_ref);
    if (!sessionId || !ts || !taskRef || !errorClass || !severity) return null;
    return {
      project,
      source: 'error-logged',
      errorClass,
      taskRef,
      severity,
      eventId: event.event_id,
      ts,
      sessionId,
      epicId: null,
      planVersion,
    };
  },
  [TASK_ADDED_EVENT_TYPE]: (event, { payload, project, sessionId, planVersion, ts }) => {
    const { record } = event;
    if ((payload as { task_status?: unknown }).task_status !== 'failed') return 'ignore';
    const taskRef = asString(record.task_id);
    if (!sessionId || !ts || !taskRef) return null;
    const epicId = asString((payload as { epic_id?: unknown }).epic_id) ?? null;
    return {
      project,
      source: 'task-failed',
      errorClass: TASK_FAILED_ERROR_CLASS,
      taskRef,
      severity: BLOCKING_SEVERITY,
      eventId: event.event_id,
      ts,
      sessionId,
      epicId,
      planVersion,
    };
  },
});

/**
 * The event types this fold reads candidates from — read off the table above
 * rather than hand-copied a second time, the way GATE_BLOCKED_REASONS is.
 * cli.ts scopes `--epic`/`--since` with it and passes everything else
 * through as history; typed there instead, a source added here and not there
 * would be reported outside the window the operator asked about.
 */
export const ISSUE_CANDIDATE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(CANDIDATE_READERS),
);

/**
 * A row's project when nothing has stamped one: given the row's own task
 * ref, answer the project that task belongs to, or `null` to say "cannot
 * tell" -- never a guess, and never this factory's own name. Optional at
 * every call site in this module (default `() => null`, see below);
 * `cli.ts` is the only caller wiring in a real answer (D-246 precedent:
 * `db/projector.ts`'s `planProjectResolver` never backfills 'black-smith'
 * either). A `null` answer from this resolver no longer becomes a default
 * project anywhere downstream -- `withSessionFallback` below gets one more
 * try from the row's own session before the row is reported unresolvable.
 */
export type ResolveProjectForTaskRef = (taskRef: string) => string | null;

/**
 * The composed per-row answer `toCandidate`/`issueReporter.ts`'s
 * `resolveRecordProject` actually call: a task ref's own resolved project,
 * widened with the two session-scoped fallbacks `withSessionFallback` builds
 * below, or `null` when none of them can tell.
 */
export type RowProjectResolver = (
  taskRef: string | undefined,
  sessionId: string | undefined,
) => string | null;

/** The row's task ref, off the envelope first and the payload second -- the same two places every `CandidateReader` above already looks. */
function candidateTaskRef(record: StoredEvent['record']): string | undefined {
  const payload = (record.payload ?? {}) as { task_ref?: unknown };
  return asString(record.task_id) ?? asString(payload.task_ref);
}

/**
 * Event types allowed to stamp a session's project for
 * `sessionProjectStamps` below: the issue candidates themselves, plus
 * `task-added` and `dispatch_decision` rows recording where a task was
 * planned or dispatched. Deliberately excludes `issue-reported` and every
 * other reporter-authored row -- those carry this module's own *guess* at a
 * row's project (see `appendIssueReported` in `issueReporter.ts`), not an
 * independent origin stamp, so folding them back in here would let one run's
 * guess leak into the next run's resolution of an unrelated, unstamped row
 * in the same session.
 */
const ORIGIN_STAMP_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...ISSUE_CANDIDATE_EVENT_TYPES,
  DISPATCH_DECISION_EVENT_TYPE,
]);

/**
 * The session's project, from its origin-stamped rows only -- and only when
 * every one of them agrees. Real sessions mix dozens of stamped rows with
 * unstamped ones (evidence: a foreign project's session stamps some events
 * and not others); a unanimous stamped sibling in the same session is strong
 * evidence for an unstamped one. A session whose origin stamps disagree
 * tells us nothing safe to guess, so it answers unresolved rather than
 * picking whichever stamp happened to come first.
 */
function sessionProjectStamps(events: readonly StoredEvent[]): ReadonlyMap<string, string> {
  const bySession = new Map<string, Set<string>>();
  for (const { record } of events) {
    if (!ORIGIN_STAMP_EVENT_TYPES.has(record.event_type)) continue;
    const project = asString(record.project);
    if (project === undefined) continue;
    const seen = bySession.get(record.session_id);
    if (seen) seen.add(project);
    else bySession.set(record.session_id, new Set([project]));
  }
  const stamps = new Map<string, string>();
  for (const [sessionId, projects] of bySession) {
    if (projects.size !== 1) continue;
    const [project] = projects;
    if (project !== undefined) stamps.set(sessionId, project);
  }
  return stamps;
}

function taskAddedKey(sessionId: string, taskId: string): string {
  return `${sessionId}\u0000${taskId}`;
}

/** `task-added`'s own `payload.epic_id`, keyed by session and task id, so a bare ref (no epic segment) can still be widened to `<epic>/<ref>` before asking the resolver. */
function taskAddedEpicIds(events: readonly StoredEvent[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const { record } of events) {
    if (record.event_type !== TASK_ADDED_EVENT_TYPE) continue;
    const taskId = asString(record.task_id);
    const epicId = asString((record.payload as { epic_id?: unknown } | undefined)?.epic_id);
    if (taskId !== undefined && epicId !== undefined) {
      out.set(taskAddedKey(record.session_id, taskId), epicId);
    }
  }
  return out;
}

/**
 * Widens a per-epic `ResolveProjectForTaskRef` into a `RowProjectResolver`
 * with three session-scoped fallbacks a single task ref cannot answer alone,
 * tried strictly in this order (S2-c):
 *
 * 1. `resolveProject`, the strict/direct resolver -- a bare ref (no epic
 *    segment) tried again as `<epic>/<ref>` using the same session's own
 *    `task-added` row when the bare ref alone cannot answer.
 * 2. The session stamp: the ONE project every origin-stamped row in the same
 *    session agrees on (`sessionProjectStamps`), when unanimous.
 * 3. `selfFallback`, tried last and only when neither of the above could
 *    answer -- same widening as step 1.
 *
 * Self-fallback sits last on purpose: it is "no plan says otherwise, and a
 * plan exists locally for this epic, so guess this factory's own name" --
 * the weakest of the three signals. A session's OWN unanimous stamp naming a
 * DIFFERENT project is stronger evidence than that guess, and must not be
 * overridden by it just because the same session also has an unrelated,
 * unstamped row whose epic happens to have a local, unlabeled plan. Before
 * this order existed, the self-fallback was folded into `resolveProject`
 * itself (step 1) and so always outran the session stamp.
 *
 * Exported so `issueReporter.ts`'s `priorOpenReports` can apply the identical
 * fallback to the same event snapshot.
 */
export function withSessionFallback(
  events: readonly StoredEvent[],
  resolveProject: ResolveProjectForTaskRef,
  selfFallback: ResolveProjectForTaskRef = () => null,
): RowProjectResolver {
  const stamps = sessionProjectStamps(events);
  const epicIds = taskAddedEpicIds(events);
  const tryResolve = (
    resolve: ResolveProjectForTaskRef,
    taskRef: string | undefined,
    sessionId: string | undefined,
  ): string | null => {
    if (taskRef === undefined) return null;
    const direct = resolve(taskRef);
    if (direct !== null) return direct;
    if (sessionId === undefined) return null;
    const epicId = epicIds.get(taskAddedKey(sessionId, taskRef));
    if (epicId === undefined) return null;
    return resolve(`${epicId}/${taskRef}`);
  };
  return (taskRef, sessionId) => {
    const direct = tryResolve(resolveProject, taskRef, sessionId);
    if (direct !== null) return direct;
    if (sessionId !== undefined) {
      const stamp = stamps.get(sessionId);
      if (stamp !== undefined) return stamp;
    }
    return tryResolve(selfFallback, taskRef, sessionId);
  };
}

/** One event to a `Candidate`, or `'ignore'` when no source claims its event type at all. */
function toCandidate(
  event: StoredEvent,
  resolveRow: RowProjectResolver,
): Candidate | 'ignore' | null {
  const { record } = event;
  const read = CANDIDATE_READERS[record.event_type];
  if (!read) return 'ignore';
  const stamped = asString(record.project);
  const taskRef = candidateTaskRef(record);
  const sessionId = asString(record.session_id);
  const project = stamped ?? resolveRow(taskRef, sessionId);
  return read(event, {
    payload: record.payload ?? {},
    project,
    sessionId,
    planVersion: asNumber(record.plan_version) ?? null,
    ts: asString(record.ts),
  });
}

/**
 * A row whose project cannot be resolved at all still needs a stable
 * fingerprint-grouping key -- otherwise two unrelated foreign projects'
 * rows sharing `(source, error_class, task_ref)` would incorrectly group
 * together and leak one row's session/epic/severity metadata onto the
 * other's report, inside this factory's own private log (both rows are
 * always skipped before anything is filed publicly, but the log itself
 * should stay correct). `task_ref` alone already disambiguates in practice
 * (refs are namespaced by epic id), so a single fixed sentinel is enough.
 */
const UNRESOLVED_PROJECT_FINGERPRINT_KEY = '\u0000unresolved-project\u0000';

/**
 * The first 16 hex characters of a SHA-256 over the NUL-joined tuple
 * `project`, `source`, `error_class`, `task_ref`. Deliberately excludes
 * session id, epic id, plan version, event id and timestamp -- those are
 * exactly the fields that change across repeated rounds of one broken gate,
 * and including any of them would open one issue per round instead of one.
 */
function computeFingerprint(
  project: string | null,
  source: ErrorSource,
  errorClass: string,
  taskRef: string,
): string {
  const material = [
    project ?? UNRESOLVED_PROJECT_FINGERPRINT_KEY,
    source,
    errorClass,
    taskRef,
  ].join('\0');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Fold a stored event sequence into reportable errors. Pure: two calls with
 * identical input return byte-identical output. `now` is threaded in rather
 * than read off the clock; nothing in this contract branches on it yet.
 *
 * `resolveProject` and `selfFallback` both default to "no answer" so the
 * ~50 existing call sites across this module's own tests and
 * `issueReporter.ts`'s need no change. An unstamped row still unresolved
 * after `withSessionFallback`'s three fallbacks reports `project: null`
 * rather than this factory's own name -- `isProjectEnabled` is never asked
 * about a row it cannot identify, and the decision to skip filing it
 * belongs to `issueReporter.ts`, the one caller that goes on to call `gh`.
 *
 * `scopeEvents` defaults to `events` itself -- the session-stamp/`task-added`
 * maps `withSessionFallback` builds read the same rows this fold iterates,
 * same as before this parameter existed. A caller that narrows `events` to a
 * candidate WINDOW (`cli.ts`'s `--epic`/`--since`) passes the full, unscoped
 * lineage here instead (S3), so a session-mate's stamp sitting outside that
 * window still counts as evidence for a row inside it -- scoping which rows
 * get REPORTED must not also scope which rows get CONSULTED, or the same
 * unstamped row resolves to a different project (and hashes a different
 * fingerprint, S1-b) depending on whether the caller happened to pass
 * `--epic`.
 */
export function foldErrorEvents(
  events: readonly StoredEvent[],
  now: string,
  isProjectEnabled: (project: string) => boolean,
  resolveProject: ResolveProjectForTaskRef = () => null,
  selfFallback: ResolveProjectForTaskRef = () => null,
  scopeEvents: readonly StoredEvent[] = events,
): FoldResult {
  void now;

  const resolveRow = withSessionFallback(scopeEvents, resolveProject, selfFallback);
  const candidates: Candidate[] = [];
  let skipped = 0;

  for (const event of events) {
    const outcome = toCandidate(event, resolveRow);
    if (outcome === 'ignore') continue;
    if (outcome === null) {
      skipped += 1;
      continue;
    }
    if (outcome.project !== null && !isProjectEnabled(outcome.project)) continue;
    candidates.push(outcome);
  }

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const fingerprint = computeFingerprint(
      candidate.project,
      candidate.source,
      candidate.errorClass,
      candidate.taskRef,
    );
    const group = groups.get(fingerprint);
    if (group) group.push(candidate);
    else groups.set(fingerprint, [candidate]);
  }

  const reports: ErrorReport[] = [];
  for (const [fingerprint, group] of groups) {
    const latest = group.reduce((a, b) => (isLaterEvent(b, a) ? b : a));
    for (const candidate of group) {
      reports.push({
        fingerprint,
        project: candidate.project,
        source: candidate.source,
        error_class: candidate.errorClass,
        task_ref: candidate.taskRef,
        severity: latest.severity,
        latest_event_id: latest.eventId,
        timestamp: latest.ts,
        session_id: latest.sessionId,
        epic_id: latest.epicId,
        plan_version: latest.planVersion,
      });
    }
  }

  return { reports, skipped };
}

// Rendering -- metadata and pointers only, safe by construction. Both
// renderers take the same shape of typed record, built from an ErrorReport,
// never a raw source event: neither signature has a free-text field.

/** The fixed literal format of the machine-readable fingerprint line, exported so the dedup search and the renderer read the same constant. */
export const FINGERPRINT_LINE_PREFIX = 'Fingerprint: ';

function fingerprintLine(fingerprint: string): string {
  return `${FINGERPRINT_LINE_PREFIX}${fingerprint}`;
}

/** The local, read-only command an operator runs to see the detail this body/comment deliberately omit. */
function smithEventCommand(sessionId: string): string {
  return `smith event tail ${sessionId} --lineage`;
}

export interface IssueBodyFields {
  latest_event_id: string;
  task_ref: string;
  error_class: string;
  severity: string;
  session_id: string;
  epic_id: string | null;
  plan_version: number | null;
  project: string | null;
  source: ErrorSource;
  fingerprint: string;
}

export interface IssueCommentFields {
  latest_event_id: string;
  timestamp: string;
  session_id: string;
  epic_id: string | null;
  plan_version: number | null;
  fingerprint: string;
}

/** Builds a body-renderer input record from a folded report -- the record's key set is the allowlist; nothing else can reach `renderBody`. */
export function toIssueBodyFields(report: ErrorReport): IssueBodyFields {
  return {
    latest_event_id: report.latest_event_id,
    task_ref: report.task_ref,
    error_class: report.error_class,
    severity: report.severity,
    session_id: report.session_id,
    epic_id: report.epic_id,
    plan_version: report.plan_version,
    project: report.project,
    source: report.source,
    fingerprint: report.fingerprint,
  };
}

/** Builds a comment-renderer input record from a folded report -- same allowlist-by-construction guarantee, same mechanism. */
export function toIssueCommentFields(report: ErrorReport): IssueCommentFields {
  return {
    latest_event_id: report.latest_event_id,
    timestamp: report.timestamp,
    session_id: report.session_id,
    epic_id: report.epic_id,
    plan_version: report.plan_version,
    fingerprint: report.fingerprint,
  };
}

/** The issue title: stable, human-first, derived only from allowlisted fields. */
export function renderTitle(fields: Pick<IssueBodyFields, 'task_ref' | 'error_class'>): string {
  return `${fields.task_ref}: ${fields.error_class}`;
}

/** Issue body -- metadata and pointers only, opened once per fingerprint. */
export function renderBody(fields: IssueBodyFields): string {
  return [
    `Task: ${fields.task_ref}`,
    `Error class: ${fields.error_class}`,
    `Severity: ${fields.severity}`,
    `Session: ${fields.session_id}`,
    `Epic: ${fields.epic_id ?? '(none)'}`,
    `Plan version: ${fields.plan_version ?? '(unknown)'}`,
    `Project: ${fields.project ?? '(unknown)'}`,
    `Source: ${fields.source}`,
    fingerprintLine(fields.fingerprint),
    '',
    'Read the detail locally:',
    `\`${smithEventCommand(fields.session_id)}\``,
  ].join('\n');
}

/** Issue comment -- the higher-volume write path (five rounds of one broken gate write one body and four comments). Same allowlist construction. */
export function renderComment(fields: IssueCommentFields): string {
  return [
    `New occurrence: ${fields.latest_event_id}`,
    `Timestamp: ${fields.timestamp}`,
    `Session: ${fields.session_id}`,
    `Epic: ${fields.epic_id ?? '(none)'}`,
    `Plan version: ${fields.plan_version ?? '(unknown)'}`,
    fingerprintLine(fields.fingerprint),
    '',
    'Read the detail locally:',
    `\`${smithEventCommand(fields.session_id)}\``,
  ].join('\n');
}
