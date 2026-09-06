import { createHash } from 'node:crypto';
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

/**
 * Source 2: `task_status: failed` is set in exactly one place in the whole
 * projector, `db/projector.ts`'s `case 'task-added'` arm copying
 * `p.task_status` verbatim -- every other case assigns a hardcoded literal,
 * never a payload-derived value. So this source is always a `task-added`
 * event whose own payload already declares `task_status: 'failed'`, and
 * carries no failure discriminator beyond that.
 */
const TASK_FAILED_ERROR_CLASS = 'task.failed';

/** Default project for an event stamped with none (events.ts's documented convention; the writer never sets it, only read helpers default it). */
const DEFAULT_PROJECT = 'black-smith';

export type ErrorSource = 'gate-outcome' | 'error-logged' | 'task-failed';

/**
 * One reportable error, folded from one contributing log event. `severity`,
 * `latest_event_id`, `timestamp`, `session_id`, `epic_id` and `plan_version`
 * describe its fingerprint group's newest occurrence -- identical across
 * every report sharing a fingerprint.
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
  /** Events matching a source's shape but missing a required field. Never thrown. */
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
 * One event to a `Candidate`, `'ignore'` when it is not one of the three
 * sources at all, or `null` when it matches a source's shape but is missing
 * a required field (malformed, counted by the caller as `skipped`).
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
 * The first 16 hex characters of a SHA-256 over the NUL-joined tuple
 * `project`, `source`, `error_class`, `task_ref`. Deliberately excludes
 * session id, epic id, plan version, event id and timestamp -- those are
 * exactly the fields that change across repeated rounds of one broken gate,
 * and including any of them would open one issue per round instead of one.
 */
function computeFingerprint(
  project: string,
  source: ErrorSource,
  errorClass: string,
  taskRef: string,
): string {
  const material = [project, source, errorClass, taskRef].join('\0');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Fold a stored event sequence into reportable errors. Pure: two calls with
 * identical input return byte-identical output. `now` is threaded in rather
 * than read off the clock; nothing in this contract branches on it yet.
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
    `Project: ${fields.project}`,
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
