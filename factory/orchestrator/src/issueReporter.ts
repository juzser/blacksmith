/**
 * Compose the three pure pieces into the run's write path: fold the log
 * (errorIssues.ts), ask the roadmap whether a project's tracker is writable
 * (the resolved switch, handed in), resolve the repo and classify `gh`
 * (git.ts/gh.ts), deduplicate against already-open issues, open or comment,
 * and record what happened as an `issue-reported` event of its own.
 *
 * `reportErrors()` is the one entry point a run calls right after it
 * records an error. It is idempotent by fingerprint: called twice over the
 * same log plus the events the first call appended, it opens and comments
 * nothing the second time, because step 4 below reads that history back.
 *
 * Dedup asks GitHub, not a local index (functional clause 3). No file
 * under `state/` tracks which fingerprints are already open. The loser's
 * cost of that choice: one `gh issue list --search` round trip per
 * candidate error rather than an O(1) local lookup, and every `commented`
 * outcome pays a second `gh issue comment` round trip on top. Both are
 * accepted because a local index would drift the moment an issue is closed
 * or reopened by a human outside this process, and this module would have
 * no way to notice.
 *
 * This module never re-implements task 2 or task 3: `errorIssues.ts`,
 * `gh.ts` and `git.ts` are imported, never edited, and never touched here
 * are `PROJECTS_DIR`, `process.cwd()` or `REPO_ROOT` — the project register
 * is a required parameter, supplied by the caller (task 5), never read off
 * the filesystem by this module.
 */

import {
  type ErrorReport,
  FINGERPRINT_LINE_PREFIX,
  foldErrorEvents,
  type ResolveProjectForTaskRef,
  type RowProjectResolver,
  renderBody,
  renderComment,
  renderTitle,
  toIssueBodyFields,
  toIssueCommentFields,
  withSessionFallback,
} from './errorIssues.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import {
  buildCommentArgv,
  buildCreateIssueArgv,
  buildSearchIssuesArgv,
  type CommandRunner,
  classifyGh,
  resolveProjectRepo,
} from './gh.js';
import type { ProjectRef } from './projects.js';

/**
 * The closed, named outcome vocabulary. Exactly one of these nine words is
 * recorded for every candidate error, always — functional clause 2.
 * `skipped-unresolved-project` is settled before any of the others can be:
 * a row this factory cannot identify the project of is never filed against
 * this factory's own repository by default (the privacy-leak guard).
 */
export const ISSUE_REPORT_OUTCOMES = [
  'opened',
  'commented',
  'deduped-open',
  'skipped-disabled',
  'skipped-no-remote',
  'skipped-gh-missing',
  'skipped-unauthenticated',
  'skipped-unresolved-project',
  'failed',
] as const;

export type IssueReportOutcome = (typeof ISSUE_REPORT_OUTCOMES)[number];

const ISSUE_REPORTED_EVENT_TYPE = 'issue-reported';

/**
 * The `issue-reported` payload allowlist (functional clause 6, nonfunctional
 * clause 3): named fields only, never a spread of a source event's payload.
 * Sorted, and this is the literal the test asserts against.
 */
export const ISSUE_REPORT_PAYLOAD_KEYS = [
  'detail',
  'error_class',
  'fingerprint',
  'issue_url',
  'latest_event_id',
  'outcome',
  'reason',
  'repo_slug',
  'source',
  'task_ref',
] as const;

export interface IssueReportRecord {
  outcome: IssueReportOutcome;
  fingerprint: string;
  project: string | null;
  source: ErrorReport['source'];
  error_class: string;
  task_ref: string;
  latest_event_id: string;
  /** Present once the repository is resolved — absent for `skipped-disabled` and `skipped-no-remote`. */
  repo_slug?: string;
  /** Present exactly on `opened`/`commented`. */
  issue_url?: string;
  /** Present on every outcome except `opened`/`commented`. */
  reason?: string;
  /** Present exactly on `skipped-no-remote` -- the refusal's own detail. */
  detail?: string;
}

interface GhIssue {
  number: number;
  body: string;
  url?: string;
}

function parseSearchResult(stdout: string): GhIssue[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const issues: GhIssue[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const number = (item as { number?: unknown }).number;
    const body = (item as { body?: unknown }).body;
    if (typeof number !== 'number' || typeof body !== 'string') return null;
    const url = (item as { url?: unknown }).url;
    issues.push({ number, body, url: typeof url === 'string' ? url : undefined });
  }
  return issues;
}

/** The exact machine-readable fingerprint line, built the same way errorIssues.ts's renderers do. */
function fingerprintLine(fingerprint: string): string {
  return `${FINGERPRINT_LINE_PREFIX}${fingerprint}`;
}

/** An exact line match, not a substring: functional clause 4. */
function findExactMatch(issues: readonly GhIssue[], fingerprint: string): GhIssue | null {
  const line = fingerprintLine(fingerprint);
  return issues.find((issue) => issue.body.split('\n').includes(line)) ?? null;
}

interface PriorReport {
  project: string;
  fingerprint: string;
  outcome: string;
  latest_event_id: string;
}

/**
 * The task ref an unstamped row carries, if any -- the envelope's own
 * `task_id` first, falling back to a hand-appended row's `payload.task_ref`.
 * Mirrors errorIssues.ts's `candidateTaskRef`, which this module never
 * imports so as to keep the two folds' internals independent.
 */
function candidateTaskRef(record: StoredEvent['record']): string | undefined {
  if (typeof record.task_id === 'string' && record.task_id.length > 0) return record.task_id;
  const payload = (record.payload ?? {}) as { task_ref?: unknown };
  return typeof payload.task_ref === 'string' && payload.task_ref.length > 0
    ? payload.task_ref
    : undefined;
}

/**
 * A row's project, resolved the same way `errorIssues.ts`'s fold resolves
 * one: an explicit stamp always wins; absent that, `resolveRow` (the row's
 * own task ref widened with `withSessionFallback`'s session fallbacks) gets
 * the answer. `null` when none of them can tell -- this factory's own
 * project is never guessed. This is what keeps an unstamped row from a
 * foreign (or unidentifiable) project's session from being folded into this
 * factory's own prior-report history (and, through `decideOutcome`'s dedup
 * key, its own repository) merely because nothing stamped it.
 */
function resolveRecordProject(
  record: StoredEvent['record'],
  resolveRow: RowProjectResolver,
): string | null {
  if (typeof record.project === 'string') return record.project;
  return resolveRow(candidateTaskRef(record), record.session_id);
}

/**
 * Every already-appended `issue-reported` record still open, read off the
 * SNAPSHOT of events this call was handed — never off events this same call
 * itself appends. That is what lets the five duplicate candidates a single
 * broken gate produces in one round resolve through GitHub search (one
 * create, four comments) rather than short-circuiting on each other.
 *
 * A record whose project cannot be resolved at all is dropped rather than
 * pushed: it can never match `priorReportFor`'s `h.project === report.project`
 * comparison against a null-project report either (Step 0 below settles
 * those before Step 4 runs), so keeping it around would only cost a lookup.
 */
function priorOpenReports(
  events: readonly StoredEvent[],
  resolveProject: ResolveProjectForTaskRef = () => null,
): PriorReport[] {
  const resolveRow = withSessionFallback(events, resolveProject);
  const out: PriorReport[] = [];
  for (const event of events) {
    const { record } = event;
    if (record.event_type !== ISSUE_REPORTED_EVENT_TYPE) continue;
    const payload = record.payload as Partial<IssueReportRecord>;
    if (
      payload.outcome !== 'opened' &&
      payload.outcome !== 'commented' &&
      payload.outcome !== 'deduped-open'
    ) {
      continue;
    }
    if (typeof payload.fingerprint !== 'string' || typeof payload.latest_event_id !== 'string') {
      continue;
    }
    const project = resolveRecordProject(record, resolveRow);
    if (project === null) continue;
    out.push({
      project,
      fingerprint: payload.fingerprint,
      outcome: payload.outcome,
      latest_event_id: payload.latest_event_id,
    });
  }
  return out;
}

function toPayload(record: IssueReportRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    outcome: record.outcome,
    fingerprint: record.fingerprint,
    source: record.source,
    error_class: record.error_class,
    task_ref: record.task_ref,
    latest_event_id: record.latest_event_id,
  };
  if (record.repo_slug !== undefined) payload.repo_slug = record.repo_slug;
  if (record.issue_url !== undefined) payload.issue_url = record.issue_url;
  if (record.reason !== undefined) payload.reason = record.reason;
  if (record.detail !== undefined) payload.detail = record.detail;
  return payload;
}

async function appendIssueReported(
  report: ErrorReport,
  record: IssueReportRecord,
  opts: EventOpts,
): Promise<StoredEvent> {
  return appendEvent(
    {
      session_id: report.session_id,
      actor: 'system',
      event_type: ISSUE_REPORTED_EVENT_TYPE,
      task_id: report.task_ref,
      // Schema minimum is 1; a report folded from an event that carried no
      // plan version (e.g. a hand-appended error-logged) has none either.
      plan_version: report.plan_version ?? 1,
      causal_parent: report.latest_event_id,
      payload: toPayload(record),
      // `EventInput.project` is `string | undefined` -- omitted, never
      // `null`, when a row's project could not be resolved; the writer
      // never stamps a guess (events.ts's documented convention).
      ...(report.project !== null ? { project: report.project } : {}),
    },
    opts,
  );
}

/**
 * Step 4's dedup rule, the one copy both the real path and the preview read:
 * same project, same fingerprint, same latest event, already open.
 */
function priorReportFor(
  history: readonly PriorReport[],
  report: ErrorReport,
): PriorReport | undefined {
  return history.find(
    (h) =>
      h.project === report.project &&
      h.fingerprint === report.fingerprint &&
      h.latest_event_id === report.latest_event_id,
  );
}

/**
 * `register` is required and never defaulted: forwarded `undefined` would
 * otherwise fail inside `resolveProjectRepo` naming neither the parameter
 * nor this module. `[]` is a legitimate register and is not rejected.
 */
function requireRegister(register: readonly ProjectRef[], entryPoint: string): void {
  if (!Array.isArray(register)) {
    throw new Error(
      `${entryPoint}: the register parameter is required (readonly ProjectRef[]), got ${String(register)}`,
    );
  }
}

/** Functional clause 2's decision procedure, in order, stopping at the first match. */
async function decideOutcome(
  report: ErrorReport,
  isProjectEnabled: (project: string) => boolean,
  register: readonly ProjectRef[],
  runner: CommandRunner,
  history: readonly PriorReport[],
): Promise<IssueReportRecord> {
  const base = {
    fingerprint: report.fingerprint,
    project: report.project,
    source: report.source,
    error_class: report.error_class,
    task_ref: report.task_ref,
    latest_event_id: report.latest_event_id,
  };

  // Step 0: can this row's project be identified at all. A row still
  // unresolved after the fold's own session fallbacks is never filed
  // against this factory's own repository by default (the privacy-leak
  // guard this whole module exists to close) -- settled before repo
  // resolution or any `gh` interaction, ahead of every other step.
  if (report.project === null) {
    return { ...base, outcome: 'skipped-unresolved-project', reason: 'project-unresolved' };
  }
  const project = report.project;

  // Step 1: the switch.
  if (!isProjectEnabled(project)) {
    return { ...base, outcome: 'skipped-disabled', reason: 'switch-off' };
  }

  // Step 2: which repository.
  const repo = resolveProjectRepo(project, register);
  if (!('slug' in repo)) {
    return { ...base, outcome: 'skipped-no-remote', reason: repo.reason, detail: repo.detail };
  }
  const repoSlug = repo.slug;

  // Step 3: can `gh` actually be used.
  const gh = classifyGh(runner);
  if (gh.outcome === 'missing') {
    return {
      ...base,
      outcome: 'skipped-gh-missing',
      reason: 'gh-not-on-path',
      repo_slug: repoSlug,
    };
  }
  if (gh.outcome === 'unauthenticated') {
    return {
      ...base,
      outcome: 'skipped-unauthenticated',
      reason: 'gh-unauthenticated',
      repo_slug: repoSlug,
    };
  }
  if (gh.outcome === 'unknown') {
    return { ...base, outcome: 'failed', reason: 'gh-unknown', repo_slug: repoSlug };
  }

  // Step 4: already reported and still open, per the snapshot this call read.
  if (priorReportFor(history, report)) {
    return {
      ...base,
      outcome: 'deduped-open',
      reason: 'already-reported',
      repo_slug: repoSlug,
    };
  }

  // Step 5: search GitHub itself.
  const searchResult = runner('gh', buildSearchIssuesArgv(repoSlug, report.fingerprint));
  if (searchResult.status !== 0) {
    return { ...base, outcome: 'failed', reason: 'search-failed', repo_slug: repoSlug };
  }
  const issues = parseSearchResult(searchResult.stdout);
  if (issues === null) {
    // gh exited 0 but the output could not be read as an issue list (e.g.
    // --json was dropped somewhere upstream and gh printed its human table,
    // or the response was truncated). Distinct from a genuine nonzero exit
    // above, which is a process failure rather than an unreadable payload.
    return { ...base, outcome: 'failed', reason: 'search-unparseable', repo_slug: repoSlug };
  }

  // Step 6: an exact fingerprint-line match gets a comment.
  const match = findExactMatch(issues, report.fingerprint);
  if (match) {
    const body = renderComment(toIssueCommentFields(report));
    const commentResult = runner('gh', buildCommentArgv(repoSlug, match.number, body));
    if (commentResult.status !== 0) {
      return { ...base, outcome: 'failed', reason: 'comment-failed', repo_slug: repoSlug };
    }
    const issueUrl = match.url ?? `https://github.com/${repoSlug}/issues/${String(match.number)}`;
    return { ...base, outcome: 'commented', repo_slug: repoSlug, issue_url: issueUrl };
  }

  // Step 7: no match — open a new issue.
  const fields = toIssueBodyFields(report);
  const createResult = runner(
    'gh',
    buildCreateIssueArgv(repoSlug, renderTitle(fields), renderBody(fields)),
  );
  if (createResult.status !== 0) {
    return { ...base, outcome: 'failed', reason: 'create-failed', repo_slug: repoSlug };
  }
  return {
    ...base,
    outcome: 'opened',
    repo_slug: repoSlug,
    issue_url: createResult.stdout.trim(),
  };
}

/** Preview's statement about the one step it has no instrument to measure. */
const STEP_3_NOT_PERFORMED = 'not-performed' as const;

const DECISION_NOTE =
  'create or comment: which of the two would run is decided by the search ' +
  'this preview deliberately does not perform';

/**
 * One candidate's preview: settled at step 1, 2 or 4 -- `(outcome, reason)`
 * plus the step, no argv -- or gh-reaching, with every argv the real path
 * could run and the rendered texts. Every record says step 3 was not
 * performed: preview spawns no `gh`, so it reports the step as unperformed
 * rather than guessing a word for it.
 */
export interface IssuePreviewRecord {
  fingerprint: string;
  project: string | null;
  source: ErrorReport['source'];
  error_class: string;
  task_ref: string;
  latest_event_id: string;
  step_3_gh_availability: typeof STEP_3_NOT_PERFORMED;
  settled_at_step?: 0 | 1 | 2 | 4;
  outcome?: Extract<
    IssueReportOutcome,
    'skipped-unresolved-project' | 'skipped-disabled' | 'skipped-no-remote' | 'deduped-open'
  >;
  reason?: string;
  detail?: string;
  repo_slug?: string;
  search_argv?: string[];
  create_argv?: string[];
  comment_argv?: string[];
  issue_body?: string;
  comment_text?: string;
  decision_note?: string;
}

/**
 * The preview-safe half of `decideOutcome`: steps 1, 2 and 4 only, through
 * the same fold, `priorOpenReports` and `priorReportFor` the real path uses.
 * Never invokes the runner with command `gh`, never appends an event. For a
 * gh-reaching candidate it BUILDS the search, create and comment argv, and
 * prints both create and comment because which one runs is settled by a
 * search this helper does not perform; the comment argv's issue number is
 * `0`, a placeholder known only after that search. `runner` is accepted for
 * signature parity with `reportErrors()`; nothing here reaches it.
 */
export async function previewOutcomes(
  events: readonly StoredEvent[],
  isProjectEnabled: (project: string) => boolean,
  register: readonly ProjectRef[],
  runner: CommandRunner,
  clock: () => string,
  resolveProject: ResolveProjectForTaskRef = () => null,
): Promise<IssuePreviewRecord[]> {
  requireRegister(register, 'previewOutcomes');
  void runner;
  const { reports } = foldErrorEvents(events, clock(), () => true, resolveProject);
  const history = priorOpenReports(events, resolveProject);

  const out: IssuePreviewRecord[] = [];
  for (const report of reports) {
    const { fingerprint, project, source, error_class, task_ref, latest_event_id } = report;
    const base = { fingerprint, project, source, error_class, task_ref, latest_event_id };
    const step3 = { step_3_gh_availability: STEP_3_NOT_PERFORMED as typeof STEP_3_NOT_PERFORMED };
    const settle = (rest: Omit<IssuePreviewRecord, keyof typeof base | keyof typeof step3>) =>
      out.push({ ...base, ...step3, ...rest });

    // Step 0: can this row's project be identified at all.
    if (project === null) {
      settle({
        settled_at_step: 0,
        outcome: 'skipped-unresolved-project',
        reason: 'project-unresolved',
      });
      continue;
    }

    // Step 1: the switch.
    if (!isProjectEnabled(project)) {
      settle({ settled_at_step: 1, outcome: 'skipped-disabled', reason: 'switch-off' });
      continue;
    }
    // Step 2: which repository -- git-only, and the source of the slug.
    const repo = resolveProjectRepo(project, register);
    if (!('slug' in repo)) {
      settle({
        settled_at_step: 2,
        outcome: 'skipped-no-remote',
        reason: repo.reason,
        detail: repo.detail,
      });
      continue;
    }
    const repoSlug = repo.slug;
    // Step 3 is skipped, not guessed. Step 4: the own-log dedup.
    if (priorReportFor(history, report)) {
      const reason = 'already-reported';
      settle({ settled_at_step: 4, outcome: 'deduped-open', reason, repo_slug: repoSlug });
      continue;
    }
    const fields = toIssueBodyFields(report);
    const issueBody = renderBody(fields);
    const commentText = renderComment(toIssueCommentFields(report));
    settle({
      repo_slug: repoSlug,
      search_argv: buildSearchIssuesArgv(repoSlug, fingerprint),
      create_argv: buildCreateIssueArgv(repoSlug, renderTitle(fields), issueBody),
      comment_argv: buildCommentArgv(repoSlug, 0, commentText),
      issue_body: issueBody,
      comment_text: commentText,
      decision_note: DECISION_NOTE,
    });
  }
  return out;
}

/**
 * Fold `events` into candidate errors, decide and act on each in order, and
 * record every attempt as an `issue-reported` event. Never throws on a
 * reporting failure — every path returns an outcome (functional clause 8).
 *
 * `isProjectEnabled` is the resolved `error_issues` switch, `register` is
 * `projects.ts`'s `{name, dir}` list (task 5 supplies it; this module never
 * calls `factoryProjects()` itself), `runner` is task 3's injected `gh`
 * command runner, and `clock` supplies `now` for the fold below.
 */
export async function reportErrors(
  events: readonly StoredEvent[],
  isProjectEnabled: (project: string) => boolean,
  register: readonly ProjectRef[],
  runner: CommandRunner,
  clock: () => string,
  opts: EventOpts = {},
  resolveProject: ResolveProjectForTaskRef = () => null,
): Promise<IssueReportRecord[]> {
  requireRegister(register, 'reportErrors');
  // Every project's switch is applied by this module's own step 1, not by
  // the fold: foldErrorEvents dropping a disabled project's candidates
  // silently would lose the `skipped-disabled` record clause 2 requires.
  const { reports } = foldErrorEvents(events, clock(), () => true, resolveProject);
  const history = priorOpenReports(events, resolveProject);

  const out: IssueReportRecord[] = [];
  for (const report of reports) {
    const record = await decideOutcome(report, isProjectEnabled, register, runner, history);
    await appendIssueReported(report, record, opts);
    out.push(record);
  }
  return out;
}
