// Hono app: read endpoints wrap db/queries.ts's page queries 1:1 (architecture
// §10). There are no write endpoints: the dashboard only reads, and every
// operator decision (a waiver, a lesson review) goes through the CLI
// (`/bs waivers`, `/bs lessons`). readOnlyGuard() answers 405 to any `/api`
// method that is not GET or HEAD, and loopbackGuard() answers 403 to any `/api`
// request whose host is not a loopback address.
//
// Imports factory/orchestrator's BUILT `dist/` output, not its `src/` —
// several orchestrator modules (taxonomy.ts, schemas.ts) resolve policy/
// schema files relative to their OWN compiled location via paths.ts's
// REPO_ROOT (self-location from import.meta.url). Recompiling those files a
// second time into ui/server's own dist tree would nest them one level
// deeper and silently compute the wrong REPO_ROOT — a real bug caught before
// it shipped, not a style preference. Depending on the canonical
// factory/orchestrator/dist/ build (`pnpm build`, run first) keeps every
// path computation correct. See docs/standards/stack.md's directory
// conventions — dist/ is gitignored/generated, never committed.
import { existsSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { resolveArtifactPath } from '../../../factory/orchestrator/dist/artifacts.js';
import type {
  DbHandle,
  DbOpts,
  Projection,
  SmithDb,
} from '../../../factory/orchestrator/dist/db/projector.js';
import { openDb, openProjection } from '../../../factory/orchestrator/dist/db/projector.js';
import type {
  AnalyticsPeriod,
  AnalyticsResult,
  EventKind,
  OverviewProjection,
  OverviewResult,
  Scope,
  TimelineEntry,
} from '../../../factory/orchestrator/dist/db/queries.js';
import {
  analytics,
  artifactById,
  EVENT_KINDS,
  errorsPage,
  flowGraph,
  kanban,
  lessonsPage,
  overview,
  overviewAt,
  overviewProjection,
  projectedLineage,
  pulse,
  roadmapPage,
  runningSessions,
  sessionAgents,
  taskDetail,
  taskRuns,
  taskTotals,
  timeline,
} from '../../../factory/orchestrator/dist/db/queries.js';
import { SmithError } from '../../../factory/orchestrator/dist/errors.js';
import { compareLogOrder } from '../../../factory/orchestrator/dist/eventOrder.js';
import { STATE_ARTIFACTS_DIR, STATE_EVENTS_DIR } from '../../../factory/orchestrator/dist/paths.js';
import {
  type ActiveScopeResponse,
  type ActiveScopeStore,
  computeActiveScope,
} from './activeScope.js';
import {
  decodeCursor,
  encodeCursor,
  mergeErrors,
  mergePages,
  type StorePage,
  sessionsByStore,
} from './activityFanout.js';
import { mergeAnalytics } from './analyticsFanout.js';
import type { CliConfigSource } from './cliSessions.js';
import { createCliSessionsReader, liveSessionCwds } from './cliSessions.js';
import { fanOut, mergeKanban, mergeOverview, mergeRoadmap, relabelProject } from './fanout.js';
import { loopbackGuard, readOnlyGuard } from './middleware.js';
import { REPO_ROOT } from './paths.js';
import type { StoreEntry, StoreRef } from './stores.js';
import { createStoreRegistry } from './stores.js';

/**
 * The only image types the artifact route will stream — a screenshot is a
 * png, jpeg, webp or gif in practice, and serving anything else (svg, html)
 * with an image content type is an XSS vector the route has no reason to
 * open. Keyed by lowercase extension, checked before the bytes are read.
 */
const ARTIFACT_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Largest artifact the route will read. A screenshot is well under this; a
 * bigger file is refused rather than buffered, since the task page polls and
 * one oversized declared path would otherwise be read into memory each time.
 */
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

/**
 * How often the change stream re-scans `state/events/` while at least one
 * client is connected. One second, not sub-second: the scan is a readdir plus
 * one stat per session, and a page that learns about an event 900ms late is
 * indistinguishable to a person from one that learns about it instantly. The
 * number that mattered was the old 5000/15000, which is long enough to watch.
 */
const STREAM_TICK_MS = 1000;

/**
 * A `:` comment on an idle stream, so the connection is not reaped as dead by
 * something between the browser and this process. Local-direct there is
 * nothing in between, but §10's Cloudflare port puts a proxy there, and a
 * keepalive written now costs one line per client per 25s and saves debugging
 * a stream that dies only in production.
 */
const STREAM_KEEPALIVE_MS = 25_000;

export interface AppOpts {
  dbPath: string;
  stateDir?: string;
  roadmapPath?: string;
  specsDir?: string;
  /** Injection seam for tests; production is `state/artifacts`. */
  artifactsDir?: string;
  /** Injection seam for tests; production is MAX_ARTIFACT_BYTES. */
  maxArtifactBytes?: number;
  /**
   * Test-only hook run between resolving an artifact's path and opening it,
   * so a test can stage the swap the open has to survive.
   */
  onArtifactResolved?: () => Promise<void>;
  /** Root of the built Vue app (ui/dist) to static-serve; omitted in tests (API-only). */
  uiDistDir?: string;
  /**
   * A fixed clock for screenshot harnesses, never for operators. Production
   * omits it and every request reads the wall clock, so "working" (a
   * dispatch within DEFAULT_STALE_HOURS) keeps ticking; the e2e harness pins
   * the browser to ui/e2e/fixtureClock.ts's instant and passes the same one
   * here (`smith ui serve --now-iso`), because a fixed browser clock is only
   * half a fixed page once the server computes time-dependent facts too.
   */
  nowIso?: string;
  /**
   * The Claude Code config dir whose `sessions/` and `projects/` feed
   * `/api/cli-sessions`. Only `smith ui serve` resolves a default; omitted
   * here the route answers `absent`, so no test or harness reads a real
   * ~/.claude by accident.
   */
  claudeConfigDir?: string;
  /** Where `claudeConfigDir` came from, echoed in the response. */
  claudeConfigSource?: CliConfigSource;
  /** Roots whose sessions count as Blacksmith sessions; the repo this server lives in when omitted. */
  knownRoots?: string[];
  /** Injection seams for tests of the route. */
  cliIsAlive?: (pid: number) => boolean;
  /** Test seam for the reused-pid check; `ps` by default. */
  cliProcStartOf?: (pids: number[]) => Promise<Map<number, string>>;
  cliListWorktrees?: () => Promise<string[]>;
  /**
   * Extra state homes to read besides the live sessions' own (`ui serve
   * --store <dir>`, repeatable). Each is only ever read.
   */
  stores?: string[];
  /** How often store discovery is recomputed; 5 s in production, 0 in tests. */
  storeRefreshMs?: number;
  /**
   * Retained for callers that still pass it; the shared projection has no age
   * bound, so neither field is read.
   */
  overviewMemo?: { maxAgeMs?: number; now?: () => number };
}

/**
 * One fact the change stream carries: a session's log advanced, and to how
 * many events. Deliberately not a status, a count of "new" anything, or a
 * rendered label — architecture §18 rules 1 and 2. The server knows which log
 * file changed and how many events that log now holds; everything a page
 * shows about those events is derived by the page's own query, after it
 * refetches. A stream that carried a judgement would be a second writer of
 * state with no event behind it.
 */
export interface SessionAdvance {
  session: string;
  events: number;
}

/**
 * One thing the projection could not land, as `/api/pulse` reports it. The
 * refresher below keeps these because it is the only reader that ever learns
 * of them: `apply()` returns the report, and the operator is looking at the
 * dashboard, not at the terminal that launched it (D-249).
 */
export interface ProjectionIssue {
  sessionId: string;
  /**
   * `session-not-projected`: the session's own log could not be folded, so
   * none of its rows exist -- a line that is not JSON, usually. Cleared the
   * moment the log projects again.
   * `artifacts-skipped`: one task-result-recorded of the session carried an
   * `artifacts` that is not a list, so its artifact rows are missing while the
   * rest of the session stands. Cleared when the session re-projects without
   * it.
   * `store-unavailable`: a foreign project's store (see stores.ts) was dropped
   * because its logs are gone or its cache could not open; `sessionId` is the
   * store's label. Cleared when the store is found again.
   */
  kind: 'session-not-projected' | 'artifacts-skipped' | 'store-unavailable';
  /** The event whose payload was held back; only for `artifacts-skipped`. */
  eventId?: string;
  message: string;
}

/**
 * The read path's change source, shared by the freshness gate (every `/api/*`
 * request), the change stream (`/api/stream`) and the issue report
 * (`/api/pulse`). See createRefresher().
 */
export interface Refresher {
  /** Fold anything newly appended into the projection. Concurrent calls share one scan. */
  refresh(): Promise<void>;
  /** Every issue still standing after the latest scan, one per session or event. */
  issues(): ProjectionIssue[];
  /** Called after any scan that advanced at least one session. Returns its own unsubscribe. */
  subscribe(listener: (advances: SessionAdvance[]) => void): () => void;
  /**
   * Keeps the background scan ticking while at least one caller holds it.
   * Returns the release; the ticker stops when the last hold is released, so
   * a dashboard nobody has open costs nothing.
   */
  hold(): () => void;
  /** Drops every listener and stops the ticker outright. closeApp()'s half. */
  stop(): void;
  /** Counts the sessions a scan has folded; a changed value means the projection moved. */
  generation?(): number;
}

export interface AppHandle {
  app: Hono;
  handle: DbHandle;
  /**
   * Stops the change stream's background scan. A Hono app is a value, not a
   * process, so nothing else would ever clear the interval — a test that
   * created an app and never called this would hold the event loop open.
   */
  closeStream: () => void;
}

function dbOptsFrom(opts: AppOpts): DbOpts {
  return {
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    ...(opts.roadmapPath ? { roadmapPath: opts.roadmapPath } : {}),
    ...(opts.specsDir ? { specsDir: opts.specsDir } : {}),
  };
}

function errorStatus(code: string): 400 | 404 | 500 {
  // A malformed query or cursor is the caller's fault; a missing session,
  // store or task is a 404. The server has no write path, so these are the
  // only refusals a read raises.
  if (code.endsWith('.bad-request') || code.endsWith('.unknown-cursor')) return 400;
  if (code.endsWith('.not-found')) return 404;
  return 500;
}

function errorBody(err: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (err instanceof SmithError) {
    return { error: { code: err.code, message: err.message, details: err.details } };
  }
  return {
    error: {
      code: 'server.internal-error',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

class BadRequestError extends SmithError {}

/**
 * The read path's freshness gate — operator report, dogfood round 2: "the
 * kanban still is not updating, and in-progress shows no tasks at all."
 *
 * The DB is a projection; `state/events/<session>.jsonl` is the record. Every
 * read route here queries the single connection createApp() opens, and until
 * now nothing on the read path ever re-projected — applyDb() was called only
 * by the write routes the server had then. So the dashboard served whatever the last `smith db
 * apply` had left behind, and since the projector writes `in-progress` only
 * from a `dispatch_decision`, and the orchestrator appends those to the LOG,
 * every dispatch after that point was invisible. Polling did not help: it
 * refetched the same frozen snapshot forever, which is exactly what an
 * operator watching an empty "In progress" column was looking at.
 *
 * The gate is a per-session {size, mtimeMs} fingerprint. A session is
 * re-projected only when its log file has actually changed, so an idle
 * dashboard costs one readdir + one stat per session per request and no
 * database work at all.
 *
 * Three details that are load-bearing:
 *
 *  - The fingerprint is taken BEFORE apply(), never after. A log appended to
 *    while apply() is folding it leaves the pre-read fingerprint stale, so the
 *    next request re-projects. Stamping the post-apply fingerprint would
 *    silently swallow those events.
 *  - The directory is re-read every time, not enumerated once at startup: a
 *    dashboard left open across `smith run` invocations has to notice a
 *    session whose log did not exist when the process booted.
 *  - Concurrent requests share one in-flight scan. A page load fires several
 *    API calls at once; without this they would each re-project the same
 *    session, and since projectSession() clears and re-folds inside a
 *    transaction, they would serialise behind each other for no gain.
 *  - The scan runs on a request OR on the stream's ticker, and the same one
 *    either way. `/api/stream` does not get a second scanner: it holds this
 *    one open on an interval and listens to what it already reports. Two
 *    scanners against one projection would mean two fingerprint maps, and
 *    whichever ran second would find nothing changed and tell its listeners
 *    nothing had.
 *
 * What the stream adds is only the reporting: scan() already knows which
 * sessions it re-projected, and apply() already returns how many events each
 * one now holds. Until now both were discarded.
 */
function createRefresher(dbPath: string, eventsDir: string, dbOpts: DbOpts): Refresher {
  const projected = new Map<string, string>();
  const warned = new Map<string, string>();
  const listeners = new Set<(advances: SessionAdvance[]) => void>();
  let holds = 0;
  let ticker: NodeJS.Timeout | null = null;
  // Keyed by finding id and not by session, because apply() folds EVERY
  // session's log at once (D-200): the same quarantine comes back on every
  // poll of every session, and only a finding not named yet is news.
  const namedFindings = new Set<string>();
  // Same rule for the artifact events, keyed by event id: apply() re-folds the
  // session on every change to its log, and the same event is skipped again
  // each time.
  const namedArtifacts = new Set<string>();
  // What the latest apply() of each session left unlanded. A session is
  // rewritten whole on every apply, so its entry is too: set on success from
  // the report, set on failure to the one issue there is, deleted when the
  // report is empty. That is what lets an issue clear itself once the log
  // behind it is repaired -- the next poll re-projects and finds nothing.
  const issues = new Map<string, ProjectionIssue[]>();
  let inFlight: Promise<void> | null = null;
  let generation = 0;

  // One handle for the life of this refresher, on its own database path: the
  // log cache inside it is what lets a scan read each log once.
  const projection = openProjection(dbPath, dbOpts);
  let stopped = false;
  let closed = false;

  function closeProjection(): void {
    if (closed) return;
    closed = true;
    projection.close();
  }

  async function scan(): Promise<void> {
    const advances: SessionAdvance[] = [];
    if (stopped || !existsSync(eventsDir)) return;
    const changed = new Map<string, string>();
    for (const entry of readdirSync(eventsDir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      try {
        const stats = statSync(path.join(eventsDir, entry));
        const fingerprint = `${stats.size}:${stats.mtimeMs}`;
        if (projected.get(sessionId) !== fingerprint) changed.set(sessionId, fingerprint);
      } catch {
        // Deleted between readdir and stat; nothing to project.
      }
    }
    if (changed.size === 0) return;
    let batch: Awaited<ReturnType<Projection['applySessions']>>;
    try {
      batch = await projection.applySessions([...changed.keys()]);
    } catch (err) {
      // The whole batch failed (the database, not one log): every session in
      // it reports the failure. stop() never closes the handle under a batch.
      batch = {
        sessions: [...changed.keys()].map((sessionId) => ({ sessionId, error: err })),
        skippedFindings: [],
        unreadableSessions: [],
      };
    }
    generation += 1;
    for (const result of batch.sessions) {
      const { sessionId } = result;
      const fingerprint = changed.get(sessionId) as string;
      if ('error' in result) {
        // A read is never failed by a log this process does not control. The
        // fingerprint is deliberately NOT recorded, so a torn line caught
        // mid-append is retried on the next request rather than skipped for
        // the life of the process — and the warning is printed once per
        // distinct fingerprint, so a genuinely broken log does not spam the
        // console at the poll interval.
        const err = result.error;
        const message = `could not project session '${sessionId}': ${err instanceof Error ? err.message : String(err)}`;
        issues.set(sessionId, [{ sessionId, kind: 'session-not-projected', message }]);
        if (warned.get(sessionId) !== fingerprint) {
          warned.set(sessionId, fingerprint);
          process.stderr.write(`bs ui: ${message}\n`);
        }
        continue;
      }
      projected.set(sessionId, fingerprint);
      advances.push({ session: sessionId, events: result.eventsApplied });
      const landed: ProjectionIssue[] = result.skippedArtifacts.map((skipped) => ({
        sessionId,
        kind: 'artifacts-skipped',
        eventId: skipped.event_id,
        message: `artifacts of '${skipped.task_id}' (${skipped.event_id}) are missing from the projection: ${skipped.reason}`,
      }));
      if (landed.length > 0) issues.set(sessionId, landed);
      else issues.delete(sessionId);
      for (const issue of landed) {
        if (!issue.eventId || namedArtifacts.has(issue.eventId)) continue;
        namedArtifacts.add(issue.eventId);
        process.stderr.write(`bs ui: ${issue.message}\n`);
      }
    }
    // D-141 turned "a finding that cannot fill a notNull column" from a
    // crash into a returned report, on the rule that a loud undercount
    // beats a crash and both beat a quiet one. That made the catch above
    // unreachable for this class and left the report unread: this is the
    // only caller an operator running the dashboard ever goes through, so
    // the undercount was quiet exactly where it had to be loud (D-248).
    for (const skipped of batch.skippedFindings) {
      // `finding_id` is optional on the record for the honest reason that
      // a payload short of its required fields can be short of that one
      // too. The row is still missing either way, so such a record is
      // keyed and named by the event id, which every record carries.
      const named = skipped.finding_id ?? skipped.event_id;
      if (namedFindings.has(named)) continue;
      namedFindings.add(named);
      // The event id too, because it is what an operator greps the log
      // for; the reason because it says the data is short, not the server.
      process.stderr.write(
        `bs ui: finding '${named}' (${skipped.event_id}) is missing from the projection: ${skipped.reason}\n`,
      );
    }
    // Once per scan, not once per session: a page that hears "three sessions
    // advanced" refetches once. Listeners are notified after every session in
    // this pass has been folded, so a refetch triggered by the frame reads a
    // projection that already holds all of it.
    if (stopped || advances.length === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(advances);
      } catch {
        // A listener is a client's open connection. One that throws loses its
        // own frame; it does not get to fail the scan for the others, and it
        // does not get to leave `projected` half-stamped for the next pass.
      }
    }
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const run = scan().finally(() => {
      inFlight = null;
      // A stop() during this scan left the handle open for the batch in flight.
      if (stopped) closeProjection();
    });
    inFlight = run;
    return run;
  }

  function subscribe(listener: (advances: SessionAdvance[]) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function hold(): () => void {
    holds += 1;
    if (ticker === null) {
      ticker = setInterval(() => void refresh(), STREAM_TICK_MS);
      // A dashboard nobody is watching must not keep `smith ui serve` — or a
      // test's node process — alive. unref() makes the ticker a passenger on
      // an event loop something else is holding open, which on a server is
      // the listening socket.
      ticker.unref();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      if (holds === 0 && ticker !== null) {
        clearInterval(ticker);
        ticker = null;
      }
    };
  }

  function stop(): void {
    stopped = true;
    if (inFlight === null) closeProjection();
    listeners.clear();
    holds = 0;
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  return {
    refresh,
    subscribe,
    hold,
    stop,
    generation: () => generation,
    // An arrow rather than a declaration beside the others, because `issues`
    // is already the map above: a function of that name in this scope would
    // not shadow it, it would redeclare it.
    issues: () => [...issues.keys()].sort().flatMap((sessionId) => issues.get(sessionId) ?? []),
  };
}

/**
 * `planVersion` off the query string, or undefined when the caller did not
 * ask about a version at all.
 *
 * `Number()` on its own answers NaN for anything it cannot read, and NaN is
 * `!== undefined` -- so flowGraph()'s version filter engaged with a bound
 * that no task compares less than, dropped every one of them, and returned
 * an empty DAG under a 200. The Flow page is the only view of that graph, so
 * "this plan has no tasks" was indistinguishable from the truth; worse, the
 * D-165/D-167 fallback that exists precisely so the page always shows
 * something was skipped, because the filter looked like it had been asked
 * for.
 *
 * `v2` is the spelling to expect: the picker labels versions `v2` while
 * their values are `2` (flowLayout.ts's planVersionOptions). The Flow page
 * keeps its version in memory rather than in the browser URL, so the caller
 * that reaches this is one hitting the read-only API directly -- a curl, a
 * script, or the next page to seed its picker off `route.query` the way
 * KanbanPage already does for `epic` and `milestone`.
 *
 * The domain is event.schema.json's own `plan_version`: an integer >= 1.
 * `0`, `-1` and `v2` all empty the DAG; `1.5` does not, but it is no more a
 * plan version than the others, and one rule is easier to hold than two.
 */
function parsePlanVersion(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new SmithError(
      'flow.bad-request',
      `planVersion must be a whole number 1 or greater; got "${raw}".`,
      { planVersion: raw },
    );
  }
  return version;
}

export function createApp(opts: AppOpts): AppHandle {
  const handle = openDb(opts.dbPath);
  const dbOpts = dbOptsFrom(opts);
  const artifactsDir = opts.artifactsDir ?? STATE_ARTIFACTS_DIR;
  const maxArtifactBytes = opts.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  // Spread into every clock-dependent query rather than resolved to a
  // default here: an absent pin must stay absent so each query reads the
  // wall clock per call (AppOpts.nowIso), not the instant the server booted.
  const clock = opts.nowIso ? { nowIso: opts.nowIso } : {};

  /**
   * The session half of every read route's scope, in one place (D-263).
   *
   * `?session` narrows to one session. `?lineage=true` widens that to the
   * chain it continues, resolved off the projection by the same
   * `projectedLineage()` the CLI's `--lineage` calls -- so the dashboard and
   * `smith stats` draw the same scope from the same rows, and the server
   * still needs nothing but a database to do it.
   *
   * Two refusals, both 400, both for the same reason. `?lineage` with no
   * `?session` has nothing to widen, and reading it as "every session at
   * once" would be D-263's failure in the other direction. And a `lineage`
   * value that is neither `true` nor `false` is refused rather than ignored:
   * falling through on `lineage=1` hands back the window, which is precisely
   * the answer the caller asked not to get. A narrowing flag
   * (`decisionsOnly`) can afford to be lenient about its spelling; a widening
   * one cannot.
   */
  function sessionScope(
    c: Context,
    db: SmithDb = handle.db,
  ): Pick<Scope, 'sessionId' | 'sessionIds'> {
    const sessionId = c.req.query('session');
    const lineage = c.req.query('lineage');
    if (lineage !== undefined && lineage !== 'true' && lineage !== 'false') {
      throw new BadRequestError(
        'scope.bad-request',
        `Query parameter "lineage" must be "true" or "false", not "${lineage}".`,
        { lineage },
      );
    }
    if (lineage !== 'true') return sessionId ? { sessionId } : {};
    if (!sessionId) {
      throw new BadRequestError(
        'scope.bad-request',
        'Query parameter "lineage" needs a "session" to widen: a lineage is resolved from a session, and every session at once is not one.',
      );
    }
    return { sessionId, sessionIds: projectedLineage(db, sessionId) };
  }

  /**
   * S9: `?sessions=a&sessions=b` narrows Activity and Cost & quality to the
   * factory sessions the dashboard's active scope names. Repeated, never
   * comma-joined: a session id may contain a comma. Absent changes nothing.
   *
   * Refused (400): together with `session` or `lineage`, an empty or
   * non-segment value (the shape `requireSessionIdShape` in events.ts keeps
   * for a log file name, copied rather than exported so this route needs no
   * orchestrator rebuild), or more than 200 values. A request that carries
   * `sessions` never yields an empty list, which `scopedToSessions` refuses.
   */
  const MAX_SESSIONS = 200;
  function sessionsScope(c: Context): Pick<Scope, 'sessionIds'> {
    const values = c.req.queries('sessions');
    if (values === undefined) return {};
    const bad = (message: string) =>
      new BadRequestError('scope.bad-request', message, { sessions: values.length });
    if (c.req.query('session') !== undefined || c.req.query('lineage') !== undefined) {
      throw bad('Query parameter "sessions" cannot be combined with "session" or "lineage".');
    }
    if (values.length > MAX_SESSIONS) {
      throw bad(`Query parameter "sessions" takes at most ${MAX_SESSIONS} values.`);
    }
    for (const id of values) {
      if (id.length === 0 || id === '.' || id === '..' || id.includes('/')) {
        throw bad(
          'Every "sessions" value must be a single non-empty path segment: no "/", and not "." or "..".',
        );
      }
    }
    return { sessionIds: [...new Set(values)] };
  }

  /**
   * `?stores=all` (Activity): read every store. Only `all` is a value, and it
   * cannot be combined with a filter that names one store's ids (task, epic,
   * session, lineage, causalChainFor) or with `store`, since those ids repeat
   * across projects. Returns whether the request asked for it.
   */
  function allStoresScope(c: Context, bad: (message: string) => Error): boolean {
    const mode = c.req.query('stores');
    if (mode === undefined) return false;
    if (mode !== 'all') throw bad(`Query parameter "stores" must be "all", not "${mode}".`);
    for (const name of ['task', 'epic', 'session', 'lineage', 'causalChainFor', 'store']) {
      if (c.req.query(name) !== undefined) {
        throw bad(`Query parameter "stores=all" cannot be combined with "${name}".`);
      }
    }
    return true;
  }

  const qualifiedSessions = (c: Context): Map<string, string[]> | undefined => {
    const values = c.req.queries('sessions');
    if (values === undefined) return undefined;
    return sessionsByStore(values, (m) => new BadRequestError('scope.bad-request', m));
  };

  /** A foreign store's rows read as that store's project and carry its tag. */
  const foreignRows = (only: StoreEntry, rows: TimelineEntry[]) =>
    relabelProject(rows, only.label).map((r) => ({
      ...r,
      store: { id: only.id, label: only.label },
    }));

  interface AllStoresFilter {
    project: string | undefined;
    limit: number | undefined;
    before: string | undefined;
    after: string | undefined;
    eventTypes: string[] | undefined;
    decisionsOnly: boolean;
    kinds: EventKind[] | undefined;
  }

  /** `/api/timeline?stores=all`: each store's page, merged (see activityFanout.ts). */
  function timelineAllStores(c: Context, f: AllStoresFilter): unknown {
    const bad = (m: string) => new BadRequestError('timeline.bad-request', m);
    const sessions = qualifiedSessions(c);
    const entries = stores.entries().filter((e) => !sessions || sessions.has(e.id));
    const idOf = new Map(entries.map((e) => [e.handle.db, e.id]));
    const filter = (db: SmithDb, p: string | undefined) => ({
      ...(sessions ? { sessionIds: sessions.get(idOf.get(db) as string) as string[] } : {}),
      ...(p ? { project: p } : {}),
      ...(f.eventTypes ? { eventTypes: f.eventTypes } : {}),
      ...(f.decisionsOnly ? { decisionsOnly: true } : {}),
      ...(f.kinds ? { kinds: f.kinds } : {}),
    });
    const paged = f.limit !== undefined || f.before !== undefined || f.after !== undefined;
    if (!paged) {
      const rows = fanOut(entries, f.project, (db, p) => timeline(db, filter(db, p))).flatMap(
        (part) => part.data.map((r) => ({ ...r, store: part.store })),
      );
      return rows.sort((a, b) => compareLogOrder(a, b) || a.store.id.localeCompare(b.store.id));
    }
    const before = f.before === undefined ? new Map<string, string>() : decodeCursor(f.before, bad);
    const after = f.after === undefined ? new Map<string, string>() : decodeCursor(f.after, bad);
    const direction = f.after === undefined ? 'before' : 'after';
    const limit = f.limit ?? 100;
    const parts = fanOut(entries, f.project, (db, p) => {
      const id = idOf.get(db) as string;
      const b = before.get(id);
      const a = after.get(id);
      const rows = timeline(db, {
        ...filter(db, p),
        ...(b ? { before: b } : {}),
        ...(a ? { after: a } : {}),
        limit,
      });
      const oldest = rows[rows.length - 1];
      const more =
        direction === 'before' &&
        oldest !== undefined &&
        timeline(db, { ...filter(db, p), before: oldest.eventId, limit: 1 }).length > 0;
      return { rows, more };
    });
    const pages: StorePage[] = parts.map((part) => ({ store: part.store, ...part.data }));
    const merged = mergePages(pages, direction, limit, direction === 'before' ? before : after);
    return {
      entries: merged.entries,
      nextBefore: merged.nextBefore ? encodeCursor(merged.nextBefore) : null,
      newestId: merged.entries.length > 0 ? encodeCursor(merged.newest) : null,
    };
  }

  const app = new Hono();

  app.onError((err, c) => {
    const body = errorBody(err);
    const status = err instanceof SmithError ? errorStatus(err.code) : 500;
    return c.json(body, status);
  });

  // The dashboard only reads: any `/api` method other than GET or HEAD is a
  // 405, ahead of every route and of the refresh, so a refused request costs
  // no fold and no route below can grow a write by accident.
  app.use('/api/*', readOnlyGuard());

  // Every `/api` route answers loopback requests only: one mount covers the
  // whole prefix, including routes added later, ahead of the refresh so a
  // refused request costs no fold.
  app.use('/api/*', loopbackGuard());

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Fold any newly-appended events into the projection before ANY api route
  // answers — see createRefresher(). /api/health is deliberately registered
  // above this so a liveness probe stays a constant-time no-op.
  const refresher = createRefresher(opts.dbPath, opts.stateDir ?? STATE_EVENTS_DIR, dbOpts);
  // Every other live project's store: discovered from the CLI sessions'
  // working directories and read-only (see stores.ts).
  const homeStore: StoreEntry = { id: 'home', label: 'home', handle, refresher, home: true };
  const stores = createStoreRegistry({
    home: homeStore,
    homeEventsDir: opts.stateDir ?? STATE_EVENTS_DIR,
    cacheDir: path.join(path.dirname(opts.dbPath), 'ui-stores'),
    extra: opts.stores ?? [],
    liveCwds: () => liveSessionCwds(opts.claudeConfigDir, opts.cliIsAlive, opts.cliProcStartOf),
    makeRefresher: createRefresher,
    refreshMs: opts.storeRefreshMs ?? 5000,
  });
  // A `?session` names a session of the served store, so no other store has
  // anything to say about it.
  const readable = (c: Context): StoreEntry[] =>
    c.req.query('session') ? [homeStore] : stores.entries();
  // One overviewProjection() per store per scope while the store's projection
  // has not moved, with no age bound: every request runs the clock stage
  // (overviewAt) on the held projection with its own clock, so a repeat poll
  // with nothing appended re-reads neither the log nor the projection tables.
  const projectionMemo = new WeakMap<
    SmithDb,
    Map<string, { generation: string; data: OverviewProjection }>
  >();
  const sharedOverview = (db: SmithDb, scope: Scope): OverviewResult => {
    const entry = db === handle.db ? homeStore : stores.entries().find((e) => e.handle.db === db);
    const scans = entry?.refresher.generation?.();
    if (entry === undefined || scans === undefined) return overview(db, scope, clock);
    // A commit by another connection (the scan's own, or a repaired or broken
    // cache) moves data_version, so a change the scan never reported cannot
    // be served stale either.
    const generation = `${scans}:${entry.handle.sqlite.pragma('data_version', { simple: true })}`;
    const key = JSON.stringify(scope);
    const memo = projectionMemo.get(db) ?? new Map();
    projectionMemo.set(db, memo);
    let hit = memo.get(key);
    if (!hit || hit.generation !== generation) {
      hit = { generation, data: overviewProjection(db, scope) };
      memo.set(key, hit);
    }
    return overviewAt(db, hit.data, scope, clock);
  };
  app.use('/api/*', async (_c, next) => {
    await refresher.refresh();
    await stores.refresh();
    await next();
  });

  /**
   * The change stream: "these sessions' logs advanced, and to how many
   * events". It carries facts, never a rendered status (architecture §18
   * rules 1 and 2) — a page that hears a session advanced refetches the query
   * it already has and derives its own display, exactly as it does on a poll
   * tick today. So this endpoint replaces the *timing* of the refetch and
   * nothing else, which is why every page's query, every derived status and
   * the no-optimistic-UI rule are untouched by it.
   *
   * Server-Sent Events rather than a WebSocket, and design-spec.md's "No
   * WebSockets" §8 is answered in that file's 2026-09-15 addendum rather than
   * here: the short of it is that a text/event-stream response is an HTTP
   * response, so §8's real objection — that a socket needs a Durable Object
   * at the eventual Workers port — does not apply to it, while the poll stays
   * in place as the documented fallback.
   *
   * Registered AFTER the freshness middleware on purpose: the first scan a
   * connecting client causes is the middleware's, so the `ready` frame is
   * written against a projection that is already current.
   */
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      // Two ways a client goes away and both must fire the same cleanup: the
      // server aborting the stream (stream.onAbort) and the request itself
      // being aborted (the fetch signal, which is what app.request() in a
      // test and a closed tab in a browser both raise).
      let done: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        done = resolve;
      });
      const release = refresher.hold();
      const unsubscribe = refresher.subscribe((advances) => {
        // Fire-and-forget on purpose: writeSSE resolves when the chunk is
        // handed to the socket, and a scan must not wait on a slow client to
        // finish reporting to the others.
        void stream
          .writeSSE({ event: 'advanced', data: JSON.stringify({ sessions: advances }) })
          .catch(done);
      });
      const keepalive = setInterval(() => {
        void stream.writeSSE({ data: '', event: 'keepalive' }).catch(done);
      }, STREAM_KEEPALIVE_MS);
      keepalive.unref();
      stream.onAbort(done);
      c.req.raw.signal.addEventListener('abort', done, { once: true });

      // Named rather than anonymous so a client can tell "the stream is open"
      // from "the stream has simply said nothing yet" — the difference
      // decides whether the page keeps its polling fallback running.
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ tickMs: STREAM_TICK_MS }) });
      await closed;

      unsubscribe();
      release();
      clearInterval(keepalive);
    }),
  );

  // --- Reads: one route per §10 page query -----------------------------
  app.get('/api/overview', (c) => {
    const project = c.req.query('project');
    const scope = sessionScope(c);
    return c.json(
      mergeOverview(
        fanOut(readable(c), project, (db, p) =>
          sharedOverview(db, { ...(db === handle.db ? scope : {}), ...(p ? { project: p } : {}) }),
        ),
      ),
    );
  });

  app.get('/api/timeline', (c) => {
    const taskId = c.req.query('task');
    const epicId = c.req.query('epic');
    const project = c.req.query('project');
    const causalChainFor = c.req.query('causalChainFor');
    const eventTypesParam = c.req.query('eventTypes');
    const decisionsOnly = c.req.query('decisionsOnly');
    const beforeParam = c.req.query('before');
    const afterParam = c.req.query('after');
    const limitParam = c.req.query('limit');
    const kindParam = c.req.query('kind');

    let limit: number | undefined;
    if (limitParam !== undefined) {
      limit = Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new BadRequestError(
          'timeline.bad-request',
          `"limit" must be an integer from 1 to 500, got "${limitParam}".`,
        );
      }
    }

    let kinds: EventKind[] | undefined;
    if (kindParam !== undefined) {
      kinds = kindParam.split(',').filter(Boolean) as EventKind[];
      const unknown = kinds.find((k) => !(EVENT_KINDS as readonly string[]).includes(k));
      if (unknown !== undefined) {
        throw new BadRequestError('timeline.bad-request', `Unknown kind "${unknown}".`);
      }
    }

    if (
      causalChainFor &&
      (limit !== undefined ||
        beforeParam !== undefined ||
        afterParam !== undefined ||
        kinds !== undefined)
    ) {
      throw new BadRequestError(
        'timeline.bad-request',
        'The causal chain for "causalChainFor" is not pageable; drop "limit", "before", "after" and "kind".',
      );
    }

    if (allStoresScope(c, (m) => new BadRequestError('timeline.bad-request', m))) {
      return c.json(
        timelineAllStores(c, {
          project,
          limit,
          before: beforeParam,
          after: afterParam,
          eventTypes: eventTypesParam ? eventTypesParam.split(',').filter(Boolean) : undefined,
          decisionsOnly: decisionsOnly === 'true',
          kinds,
        }),
      );
    }
    const sessions = sessionsScope(c);
    if (causalChainFor && sessions.sessionIds) {
      throw new BadRequestError(
        'scope.bad-request',
        'The causal chain for "causalChainFor" needs one "session", not "sessions".',
      );
    }

    const paged = limit !== undefined || beforeParam !== undefined || afterParam !== undefined;
    // `?store=<id>` reads that one store (404 when none answers to it); the
    // served store answers as it always has, rows untagged.
    const only = storeOf(c);
    const { db } = only.handle;
    const answer = (rows: TimelineEntry[]): TimelineEntry[] =>
      only.home ? rows : foreignRows(only, rows);
    const entries = timeline(db, {
      ...sessionScope(c, db),
      ...sessions,
      ...(taskId ? { taskId } : {}),
      ...(epicId ? { epicId } : {}),
      ...(project ? { project } : {}),
      ...(causalChainFor ? { causalChainFor } : {}),
      ...(eventTypesParam ? { eventTypes: eventTypesParam.split(',').filter(Boolean) } : {}),
      ...(decisionsOnly === 'true' ? { decisionsOnly: true } : {}),
      ...(kinds ? { kinds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(beforeParam !== undefined ? { before: beforeParam } : {}),
      ...(afterParam !== undefined ? { after: afterParam } : {}),
    });

    if (!paged) return c.json(answer(entries));

    const oldest = entries[entries.length - 1];
    const nextBefore = oldest
      ? timeline(db, {
          ...sessionScope(c, db),
          ...sessions,
          ...(taskId ? { taskId } : {}),
          ...(epicId ? { epicId } : {}),
          ...(project ? { project } : {}),
          ...(eventTypesParam ? { eventTypes: eventTypesParam.split(',').filter(Boolean) } : {}),
          ...(decisionsOnly === 'true' ? { decisionsOnly: true } : {}),
          ...(kinds ? { kinds } : {}),
          before: oldest.eventId,
          limit: 1,
        }).length > 0
        ? oldest.eventId
        : null
      : null;
    return c.json({
      entries: answer(entries),
      nextBefore,
      newestId: entries[0]?.eventId ?? null,
    });
  });

  app.get('/api/kanban', (c) => {
    const epic = c.req.query('epic');
    const project = c.req.query('project');
    const scope = sessionScope(c);
    return c.json(
      mergeKanban(
        fanOut(readable(c), project, (db, p) =>
          kanban(
            db,
            epic,
            { ...(db === handle.db ? scope : {}), ...(p ? { project: p } : {}) },
            clock,
          ),
        ),
      ),
    );
  });

  // The app shell's own poll — "is the factory still moving, and what has
  // arrived since I looked?". It sits under the refresh middleware like every
  // other read, so the frame's liveness reading and the page's data are folded
  // from the same event log at the same moment.
  //
  // `projectionIssues` rides on it for the same reason: what the refresher
  // could not fold is a fact about THIS server's projection, not about the
  // events, so it is answered here rather than by queries.ts, and on the one
  // read every page makes rather than on a page nobody opens (D-249).
  app.get('/api/pulse', (c) => {
    const project = c.req.query('project');
    return c.json({
      ...pulse(handle.db, { ...sessionScope(c), ...(project ? { project } : {}) }),
      projectionIssues: [...refresher.issues(), ...stores.issues()],
    });
  });

  // A foreign session that has not reached an epic yet would read as a home
  // one ("No project"); it belongs to its store's project instead: listed under
  // the store's label, kept by a filter on that label, and its roster opens
  // there. A home one stays outside every project. Both session routes below
  // ask this one rule.
  const storeProjectOf = (store: StoreRef, session: { projects: string[] }) =>
    store.id !== 'home' && session.projects.length === 0 ? store.label : undefined;
  const NO_EPIC = { projects: [] };

  // The topbar session picker's feed -- the same thin-projection shape as
  // /api/projects below, and for the same reason. The shell asks for this on
  // every scopable page, and what it wants is a list of ids; routing it
  // through /api/overview would ship the stat row, the epics in flight and the
  // review queue alongside, on every route change, to be thrown away.
  app.get('/api/sessions', (c) => {
    const project = c.req.query('project');
    if (allStoresScope(c, (m) => new BadRequestError('scope.bad-request', m))) {
      // Each store's own list (queries.ts runningSessions: newest event first,
      // then session id), tagged, then merged on the same keys with the store
      // id breaking a tie; the sort is stable, so one store keeps its own order.
      const sessions = qualifiedSessions(c);
      const entries = stores.entries().filter((e) => !sessions || sessions.has(e.id));
      const idOf = new Map(entries.map((e) => [e.handle.db, e.id]));
      const list = (db: SmithDb, p: string | undefined) =>
        sharedOverview(db, {
          ...(sessions ? { sessionIds: sessions.get(idOf.get(db) as string) as string[] } : {}),
          ...(p ? { project: p } : {}),
        }).runningSessions;
      // The filtered query cannot see a session with no epic, so a filter on
      // a foreign store's label reads that store once more, unfiltered, for
      // those sessions alone.
      const own = project
        ? fanOut(
            entries.filter((e) => storeProjectOf(e, NO_EPIC) === project),
            undefined,
            list,
          ).map(({ store, data }) => ({
            store,
            data: data.filter((r) => storeProjectOf(store, r) === project),
          }))
        : [];
      return c.json(
        [...fanOut(entries, project, list), ...own]
          .flatMap(({ store, data }) =>
            data.map((r) => {
              const label = storeProjectOf(store, r);
              return { ...r, ...(label ? { projects: [label] } : {}), store };
            }),
          )
          .sort(
            (a, b) =>
              b.lastEventAt.localeCompare(a.lastEventAt) ||
              a.sessionId.localeCompare(b.sessionId) ||
              a.store.id.localeCompare(b.store.id),
          ),
      );
    }
    const result = sharedOverview(handle.db, {
      ...sessionScope(c),
      ...(project ? { project } : {}),
    });
    return c.json(result.runningSessions);
  });

  // DS8 PR1 plan F -- the session detail drawer's agent roster. A thin read
  // over sessionAgents(): grouped by role in first-dispatch order already,
  // so the route is scoping plus a 404 for a session this store does not know
  // (or that is not this project's). A session the store does know but that
  // has dispatched no agent yet is a normal live state: 200 with empty roles.
  app.get('/api/sessions/:sessionId/agents', (c) => {
    const sessionId = c.req.param('sessionId');
    const project = c.req.query('project');
    // `?store=<id>` reads that store (a session id repeats between stores).
    const only = storeOf(c);
    const { db } = only.handle;
    if (project) {
      const session =
        overview(db, { sessionId, project }, clock).runningSessions[0] ??
        (storeProjectOf(only, NO_EPIC) === project
          ? overview(db, { sessionId }, clock).runningSessions.find(
              (r) => storeProjectOf(only, r) === project,
            )
          : undefined);
      if (!session) {
        throw new SmithError('session.not-found', `No session "${sessionId}".`, { sessionId });
      }
    }
    const result = sessionAgents(db, sessionId, clock);
    // Its row in the store's session list, the same one the page lists it
    // from (running or ended), tells "no agents yet" from "no such session".
    if (result.roles.length === 0 && runningSessions(db, { sessionId }, clock).length === 0) {
      throw new SmithError('session.not-found', `No session "${sessionId}".`, { sessionId });
    }
    return c.json(only.home ? result : relabelProject(result, only.label));
  });

  // Live Claude Code CLI sessions (name, working/waiting/idle, doing now,
  // linked epic). Behind the refresh middleware above so links are current,
  // and loopback-only (guard mounted ahead of the refresh) because it carries
  // operator prompt text.
  const cliSessions = createCliSessionsReader({
    configDir: opts.claudeConfigDir,
    configSource: opts.claudeConfigDir ? (opts.claudeConfigSource ?? 'flag') : 'none',
    roots: opts.knownRoots && opts.knownRoots.length > 0 ? opts.knownRoots : [REPO_ROOT],
    nowIso: () => opts.nowIso ?? new Date().toISOString(),
    ...(opts.cliIsAlive ? { isAlive: opts.cliIsAlive } : {}),
    ...(opts.cliProcStartOf ? { procStartOf: opts.cliProcStartOf } : {}),
    ...(opts.cliListWorktrees ? { listWorktrees: opts.cliListWorktrees } : {}),
  });
  app.get('/api/cli-sessions', async (c) => c.json(await cliSessions.read(readable(c))));

  // The one "active" scope: what the live CLI sessions are driving. The
  // actively-running set and the epic -> project map come from overview() per
  // store (the same call /api/overview fans out), so Home's "Running now" and
  // this cannot drift. Prompt-free (ids, project names, counts only).
  // A foreign store whose overview throws is left out (fanOut skips it) and
  // counted in `storesUnread`, so the page can say its totals may be low.
  app.get('/api/active-scope', async (c) => {
    const entries = readable(c);
    const cli = await cliSessions.read(entries);
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const stores: ActiveScopeStore[] =
      cli.state === 'ok'
        ? fanOut(entries, undefined, (db) => sharedOverview(db, {})).map(({ store, data }) => ({
            store,
            activelyRunning: data.epicsActivelyRunning,
            epicProjects: Object.fromEntries(
              (data.projects ?? []).flatMap((p) =>
                p.epicsInFlight.map((epicId) => [epicId, p.project] as const),
              ),
            ),
            tokens: Object.fromEntries(
              data.tokensByEpic.map((t) => [
                t.epicId,
                { tokensSpent: t.tokensSpent, unmeasured: t.unmeasured },
              ]),
            ),
          }))
        : [];
    const body: ActiveScopeResponse = {
      ...computeActiveScope(cli, stores, nowIso),
      storesUnread: cli.state === 'ok' ? entries.length - stores.length : 0,
    };
    return c.json(body);
  });

  app.get('/api/projects', (c) => {
    const scope = sessionScope(c);
    const merged = mergeOverview(
      fanOut(readable(c), undefined, (db) => sharedOverview(db, db === handle.db ? scope : {})),
    );
    return c.json(merged.projects ?? []);
  });

  // `?store=<id>` reads a task of another project's store. An id no store
  // answers to is a 404: falling back to the served store would show it
  // another project's task of the same id.
  const storeOf = (c: Context): StoreEntry => {
    const id = c.req.query('store');
    if (id === undefined) return homeStore;
    const found = stores.store(id);
    if (!found) throw new SmithError('store.not-found', `No store "${id}".`, { store: id });
    return found;
  };

  app.get('/api/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const store = storeOf(c);
    const detail = taskDetail(store.handle.db, taskId);
    if (!detail) throw new SmithError('task.not-found', `No task "${taskId}".`, { taskId });
    return c.json(store.home ? detail : relabelProject(detail, store.label));
  });

  // DS3 §4.7 — RunHistoryTimeline's data source: a scoped read on the
  // existing event-log projection (dispatch/judge-report/result/error rows
  // for this task). No new event type, no writer.
  app.get('/api/tasks/:taskId/runs', (c) => {
    const taskId = c.req.param('taskId');
    const { db } = storeOf(c).handle;
    return c.json({ runs: taskRuns(db, taskId), totals: taskTotals(db, taskId) });
  });

  // Serves a task's own screenshots to the dashboard. The id comes from the
  // projected `artifacts` row, never from the URL directly: what the request
  // names is looked up, and what gets opened is what resolveArtifactPath()
  // resolves that row's own taskId/path to — never a caller-supplied path.
  app.get('/api/artifacts/:artifactId', async (c) => {
    const artifactId = c.req.param('artifactId');
    const row = artifactById(handle.db, artifactId);
    if (!row) return c.body(null, 404);
    const resolved = resolveArtifactPath(row.taskId, row.path, artifactsDir);
    if (!resolved) return c.body(null, 404);
    const contentType = ARTIFACT_CONTENT_TYPE_BY_EXT[path.extname(resolved).toLowerCase()];
    if (!contentType) return c.body(null, 415);
    await opts.onArtifactResolved?.();
    // resolveArtifactPath() returned the real path, so no component of it is
    // a link. Open with O_NOFOLLOW and check the descriptor, not the path: a
    // file swapped for a symlink after the check fails the open, and what is
    // read is exactly what fstat() described.
    let file: FileHandle;
    try {
      file = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      return c.body(null, 404);
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return c.body(null, 404);
      if (stat.size > maxArtifactBytes) return c.body(null, 413);
      const bytes = await file.readFile();
      c.header('Content-Type', contentType);
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(bytes);
    } finally {
      await file.close();
    }
  });

  app.get('/api/lessons', (c) => c.json(lessonsPage(handle.db, sessionScope(c))));

  app.get('/api/errors', (c) => {
    const project = c.req.query('project');
    if (allStoresScope(c, (m) => new BadRequestError('scope.bad-request', m))) {
      const sessions = qualifiedSessions(c);
      const entries = stores.entries().filter((e) => !sessions || sessions.has(e.id));
      const idOf = new Map(entries.map((e) => [e.handle.db, e.id]));
      return c.json(
        mergeErrors(
          fanOut(entries, project, (db, p) =>
            errorsPage(
              db,
              {
                ...(sessions
                  ? { sessionIds: sessions.get(idOf.get(db) as string) as string[] }
                  : {}),
                ...(p ? { project: p } : {}),
              },
              clock,
            ),
          ),
        ),
      );
    }
    const only = storeOf(c);
    const result = errorsPage(
      only.handle.db,
      { ...sessionScope(c, only.handle.db), ...sessionsScope(c), ...(project ? { project } : {}) },
      clock,
    );
    return c.json(only.home ? result : relabelProject(result, only.label));
  });

  const ANALYTICS_PERIODS: readonly AnalyticsPeriod[] = ['7d', '30d', '90d'];

  app.get('/api/analytics', (c) => {
    const project = c.req.query('project');
    const periodParam = c.req.query('period');
    if (periodParam !== undefined && !ANALYTICS_PERIODS.includes(periodParam as AnalyticsPeriod)) {
      throw new BadRequestError(
        'analytics.bad-request',
        `"period" must be one of ${ANALYTICS_PERIODS.join(', ')}, got "${periodParam}".`,
      );
    }
    const period = periodParam as AnalyticsPeriod | undefined;
    if (allStoresScope(c, (m) => new BadRequestError('analytics.bad-request', m))) {
      const sessions = qualifiedSessions(c);
      const entries = stores.entries().filter((e) => !sessions || sessions.has(e.id));
      const idOf = new Map(entries.map((e) => [e.handle.db, e.id]));
      return c.json(
        mergeAnalytics(
          fanOut(entries, project, (db, p) =>
            analytics(
              db,
              {
                ...(sessions
                  ? { sessionIds: sessions.get(idOf.get(db) as string) as string[] }
                  : {}),
                ...(p ? { project: p } : {}),
              },
              { ...clock, ...(period ? { period } : {}) },
            ),
          ),
          { period: period !== undefined },
        ),
      );
    }
    const result: AnalyticsResult = analytics(
      handle.db,
      { ...sessionScope(c), ...sessionsScope(c), ...(project ? { project } : {}) },
      { ...clock, ...(period ? { period } : {}) },
    );
    return c.json(result);
  });

  app.get('/api/flow', (c) => {
    const project = c.req.query('project');
    const epic = c.req.query('epic');
    const planVersion = parsePlanVersion(c.req.query('planVersion'));
    const filter = (p: string | undefined) => ({
      ...sessionScope(c),
      ...(p ? { project: p } : {}),
      ...(epic ? { epicId: epic } : {}),
      ...(planVersion !== undefined ? { planVersion } : {}),
    });
    // An explicit `?store=` reads that store alone.
    if (c.req.query('store') !== undefined) {
      const only = storeOf(c);
      const graph = flowGraph(only.handle.db, filter(project), clock);
      return c.json(only.home ? graph : relabelProject(graph, only.label));
    }
    // An epic belongs to one store: the served store first, then the first
    // other store that has tasks for it. Without an epic the graph is the served store's.
    const parts = fanOut(epic ? readable(c) : [homeStore], project, (db, p) =>
      flowGraph(db, filter(p), clock),
    );
    return c.json((parts.find((p) => p.data.nodes.length > 0) ?? parts[0])?.data);
  });

  app.get('/api/roadmap', (c) => {
    const project = c.req.query('project');
    return c.json(
      mergeRoadmap(
        fanOut(readable(c), project, (db, p) =>
          roadmapPage(db, { ...sessionScope(c), ...(p ? { project: p } : {}) }),
        ),
      ),
    );
  });

  // --- Static-serve the built UI (skipped when uiDistDir is omitted) ---
  if (opts.uiDistDir) {
    const root = opts.uiDistDir;
    app.use('/assets/*', serveStatic({ root }));

    // Vite hashes bundles into assets/ but copies ui/public/* to the dist
    // ROOT, so favicon.ico and friends live one level above the rule above.
    // Without this they hit the SPA catch-all and come back as index.html
    // under content-type text/html — a browser asking for an icon gets a
    // document, shows the default globe, and reports nothing anywhere.
    //
    // The pattern is deliberately "one segment, containing a dot": real
    // filenames match, SPA routes (/roadmap, /tasks/x) do not. serveStatic
    // falls through to next() when the file is absent, so a dotted path with
    // nothing behind it still lands on the shell rather than 404ing.
    app.use('/:rootFile{[^/]+\\.[^/]+}', serveStatic({ root }));

    app.get('/', serveStatic({ path: 'index.html', root }));
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next();
      return serveStatic({ path: 'index.html', root })(c, next);
    });
  }

  return {
    app,
    handle,
    closeStream: () => {
      refresher.stop();
      stores.close();
    },
  };
}

export function closeApp(handle: AppHandle): void {
  // Before the db, not after: stop() clears the ticker, and a scan that fired
  // between the close and the clear would call apply() against a closed
  // connection.
  handle.closeStream();
  handle.handle.sqlite.close();
}
