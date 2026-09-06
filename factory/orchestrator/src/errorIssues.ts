import { createHash } from 'node:crypto';
import type { StoredEvent } from './events.js';

/**
 * Pure core of the factory-error-log mechanism (epic `factory-error-log`,
 * task 2): fold the event log into reportable errors, fingerprint them, and
 * render an issue title, body and comment from named fields only.
 *
 * It folds the LOG, not the call sites. The three sources the epic names --
 * a `gate-outcome` blocked, a task reaching `task_status: failed`, and every
 * `error-logged` -- share no call site (`error-logged` is routinely written
 * BY HAND through `smith event append`, which no in-process hook can ever
 * observe), but they share one writer, `appendEvent`, and therefore one
 * reader: the log. A hook-shaped producer covers at most two of the three; a
 * fold over already-stored events covers all three uniformly.
 *
 * Purity: no filesystem, no network, no child process, no clock. Events
 * arrive as a parameter, `now` arrives as a parameter, and project
 * enablement arrives as a parameter -- this module never reads the roadmap.
 */

// ---------------------------------------------------------------------------
// Source 1 -- `gate-outcome` blocked. `reason` is one of exactly ten
// strings, gate.ts's `GateOutcome`'s blocked arm (gate.ts:220-230). Restated
// here because the type carries no runtime value to import; test/errorIssues
// .test.ts ties this list back to `GateOutcome` with a compile-time equality
// check, so the two cannot drift silently.
// ---------------------------------------------------------------------------

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

/**
 * The error-class table for source 1. A `Record` over every
 * `GateBlockedReason` rather than a template literal or a switch with a
 * default arm: TypeScript refuses to compile this object if a reason is
 * ever added to or removed from the type above without updating it here, and
 * a `reason` read off an event that is not one of these ten keys is treated
 * as malformed (see `toCandidate`) rather than silently mapped to something.
 */
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
export const GATE_BLOCKED_REASONS = Object.keys(
  GATE_BLOCKED_ERROR_CLASSES,
) as GateBlockedReason[];

/**
 * A blocked gate and a failed task carry no payload-level severity (only
 * `error-logged` does, taxonomy.yml requiring it as one of the "error"
 * record type's dimensions). Both conditions block a task outright, which is
 * exactly severity.yml's own definition of `S2-major` ("blocks merge...
 * broken core flow"), so that is the constant this module assigns them.
 */
const BLOCKING_SEVERITY = 'S2-major';

/** The literal event types this fold understands, one entry per source. */
const GATE_OUTCOME_EVENT_TYPE = 'gate-outcome';
const ERROR_LOGGED_EVENT_TYPE = 'error-logged';
const TASK_ADDED_EVENT_TYPE = 'task-added';

/**
 * A payload string becomes a task's `task_status` in exactly one place in
 * the whole projector: `db/projector.ts`'s `case 'task-added'` arm does
 * `row.taskStatus = p.task_status ?? row.taskStatus` (db/projector.ts:612-613,
 * and see events.ts:516-519's comment on the same line) -- every other
 * assignment in that switch sets a literal from the status vocabulary, never
 * a value read off a payload. So source 2, "a task reaches
 * `task_status: failed`", can only be produced by a `task-added` event whose
 * own payload already declares `task_status: 'failed'` (a task re-added, or
 * hand-appended, already in a terminal state) -- there is no other event
 * type in this codebase that can put a task into that status. `task-added`'s
 * payload (see taskEvents.ts's `addedPayload`) carries no separate failure
 * discriminator, so this source's error class is exactly `task.failed`, with
 * no extension.
 */
const TASK_FAILED_ERROR_CLASS = 'task.failed';

/** Default project for an event stamped with none, matching events.ts's documented convention (db/queries.ts's read helpers apply the same default; the writer never does). */
const DEFAULT_PROJECT = 'black-smith';

export type ErrorSource = 'gate-outcome' | 'error-logged' | 'task-failed';

/**
 * One reportable error, folded from one contributing log event and enriched
 * with its fingerprint group's newest occurrence (clause 3/5). `severity`,
 * `latest_event_id`, `timestamp`, `session_id`, `epic_id` and `plan_version`
 * describe that newest occurrence -- identical across every report sharing a
 * fingerprint -- so a caller comparing `latest_event_id` against a
 * previously stored value never has to rescan the log or recompute it.
 */
export interface ErrorReport {
  fingerprint: string;
  project: string;
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
  /** Count of events that matched one of the three sources by shape but could not be turned into a report -- a missing or malformed required field. Never thrown. */
  skipped: number;
}

interface Candidate {
  project: string;
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

/**
 * One event to a `Candidate`, or `null` when the event either is not one of
 * the three sources at all (ignored, not counted) or matches a source's
 * shape but is missing a required field (malformed, counted by the caller).
 * Distinguished by returning `'ignore'` for the former and `null` for the
 * latter.
 */
function toCandidate(event: StoredEvent): Candidate | 'ignore' | null {
  const { record } = event;
  const payload = record.payload ?? {};
  const project = asString(record.project) ?? DEFAULT_PROJECT;
  const sessionId = asString(record.session_id);
  const planVersion = asNumber(record.plan_version) ?? null;
  const ts = asString(record.ts);

  if (record.event_type === GATE_OUTCOME_EVENT_TYPE) {
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
  }

  if (record.event_type === ERROR_LOGGED_EVENT_TYPE) {
    const errorClass = asString((payload as { error?: unknown }).error);
    const severity = asString((payload as { severity?: unknown }).severity);
    const taskRef = asString(record.task_id) ?? asString((payload as { task_ref?: unknown }).task_ref);
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
  }

  if (record.event_type === TASK_ADDED_EVENT_TYPE) {
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
  }

  return 'ignore';
}

/**
 * The fingerprint is exactly this: the first 16 hex characters of a
 * SHA-256 over the NUL-joined tuple `project`, `source`, `error_class`,
 * `task_ref`. It deliberately excludes session id, epic id, plan version,
 * event id, timestamp and detail -- the failure the operator named is one
 * broken gate repeating across five rounds, and session, plan version and
 * timestamp are precisely the fields that change between those rounds. A
 * fingerprint that included any of them would be correct-looking and would
 * open five issues instead of one.
 */
function computeFingerprint(
  project: string,
  source: ErrorSource,
  errorClass: string,
  taskRef: string,
): string {
  const material = [project, source, errorClass, taskRef].join(' ');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Fold a stored event sequence into reportable errors. Pure: two calls with
 * identical input return byte-identical output (verified by a JSON-equality
 * test). `now` is threaded in rather than read off the clock so the fold
 * never has to reach for `Date.now()` even if a later clause needs it;
 * nothing in this task's contract branches on it, so it is otherwise unread.
 */
export function foldErrorEvents(
  events: readonly StoredEvent[],
  now: string,
  isProjectEnabled: (project: string) => boolean,
): FoldResult {
  void now;

  const candidates: Candidate[] = [];
  let skipped = 0;

  for (const event of events) {
    const outcome = toCandidate(event);
    if (outcome === 'ignore') continue;
    if (outcome === null) {
      skipped += 1;
      continue;
    }
    if (!isProjectEnabled(outcome.project)) continue;
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
    const latest = group.reduce((a, b) =>
      b.ts > a.ts || (b.ts === a.ts && b.eventId > a.eventId) ? b : a,
    );
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

// ---------------------------------------------------------------------------
// Rendering -- metadata and pointers only, safe by construction. Both
// renderers take the same shape of typed record, built from an ErrorReport,
// never a raw source event: there is no `detail`/`text`/`string` free-text
// field anywhere in either signature, so there is nothing for a filter to
// miss.
// ---------------------------------------------------------------------------

/** The fixed literal format of the machine-readable fingerprint line, exported so the dedup search and the renderer read the same constant. */
export const FINGERPRINT_LINE_PREFIX = 'Fingerprint: ';

function fingerprintLine(fingerprint: string): string {
  return `${FINGERPRINT_LINE_PREFIX}${fingerprint}`;
}

/** The local, read-only command an operator runs to see the detail this body and comment deliberately omit. `--lineage` follows the epic across sessions, the same reason cli.ts's `event tail --lineage` does. */
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
  project: string;
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

/** Builds a comment-renderer input record from a folded report -- the higher-volume write path gets the same allowlist-by-construction guarantee, by the same mechanism. */
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
    `Project: ${fields.project}`,
    `Source: ${fields.source}`,
    fingerprintLine(fields.fingerprint),
    '',
    'Read the detail locally:',
    `\`${smithEventCommand(fields.session_id)}\``,
  ].join('\n');
}

/** Issue comment -- the higher-volume write path (D-load: five rounds of one broken gate write one body and four comments). Same allowlist construction. */
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
