// Hono app: read endpoints wrap db/queries.ts's page queries 1:1 (architecture
// §10); write endpoints wrap ONLY waivers.ts's applyBatch() and lessons.ts's
// transitionLesson(). No other writes exist.
//
// P9-36: the three lesson-review routes used to hand-write their events with
// plain appendEvent(), which made the UI a third door into memory past both
// the legal-transition check (P9-1) and the novelty gate (P9-34) — the CLI
// refused what the Approve button did anyway. They now call the same
// transitionLesson() the CLI calls, against the session that OWNS the lesson
// rather than whichever one the request body named.
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
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { DbHandle, DbOpts, SmithDb } from '../../../factory/orchestrator/dist/db/projector.js';
import { apply as applyDb, openDb } from '../../../factory/orchestrator/dist/db/projector.js';
import type { AnalyticsResult, Scope } from '../../../factory/orchestrator/dist/db/queries.js';
import {
  analytics,
  errorsPage,
  flowGraph,
  kanban,
  lessonsPage,
  overview,
  projectedLineage,
  pulse,
  roadmapPage,
  taskDetail,
  timeline,
} from '../../../factory/orchestrator/dist/db/queries.js';
import { lessons as lessonsTable } from '../../../factory/orchestrator/dist/db/schema.js';
import { SmithError } from '../../../factory/orchestrator/dist/errors.js';
import type { EventOpts } from '../../../factory/orchestrator/dist/events.js';
import { readEvents, requireSession } from '../../../factory/orchestrator/dist/events.js';
import type { EventContext } from '../../../factory/orchestrator/dist/findings.js';
import type {
  LessonEdit,
  LessonTransitionExtra,
} from '../../../factory/orchestrator/dist/lessons.js';
import { transitionLesson } from '../../../factory/orchestrator/dist/lessons.js';
import { STATE_EVENTS_DIR } from '../../../factory/orchestrator/dist/paths.js';
import type { SchedulerPolicy } from '../../../factory/orchestrator/dist/scheduler.js';
import { loadSchedulerPolicy } from '../../../factory/orchestrator/dist/scheduler.js';
import type { WaiverBatchDecision } from '../../../factory/orchestrator/dist/waivers.js';
import { applyBatch } from '../../../factory/orchestrator/dist/waivers.js';

export interface AppOpts {
  dbPath: string;
  stateDir?: string;
  roadmapPath?: string;
  specsDir?: string;
  /** Root of the built Vue app (ui/dist) to static-serve; omitted in tests (API-only). */
  uiDistDir?: string;
  /**
   * Injected only by tests that need a specific novelty bar. Production omits
   * it and createApp() reads factory/policies/scheduler.yml — see the
   * lessonsPolicy comment in createApp().
   */
  schedulerPolicy?: SchedulerPolicy;
}

export interface AppHandle {
  app: Hono;
  handle: DbHandle;
}

function dbOptsFrom(opts: AppOpts): DbOpts {
  return {
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    ...(opts.roadmapPath ? { roadmapPath: opts.roadmapPath } : {}),
    ...(opts.specsDir ? { specsDir: opts.specsDir } : {}),
  };
}

function errorStatus(code: string): 400 | 404 | 409 | 500 {
  if (
    code.endsWith('.missing-flag') ||
    code.endsWith('.unknown-fingerprint') ||
    code.endsWith('.non-waivable-severity') ||
    code.endsWith('.invalid-lesson-tag') ||
    code.endsWith('.bad-request') ||
    // Fix-round (code review #12): the lesson-edit route's lessonType/
    // lessonScope validation (events.ts's validatePayloadDimensions(),
    // reached via appendEvent()) was falling through to 500 — a malformed
    // request body, not a server fault.
    code.endsWith('.invalid-payload-dimensions') ||
    // P9-36: what transitionLesson() refuses about the request itself.
    code.endsWith('.illegal-transition') ||
    code.endsWith('.empty-statement') ||
    code.endsWith('.session-mismatch')
  ) {
    return 400;
  }
  if (code.endsWith('.not-found') || code.endsWith('.unknown-lesson')) return 404;
  // 409, not 400: the request is well-formed and the caller may retry it
  // after something outside the request changes — restore the archived log,
  // or decide the duplicate is wanted and re-send with acceptDuplicate.
  if (code.endsWith('.edit-not-novel') || code.endsWith('.unknown-session')) return 409;
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

/** Every write endpoint's shared envelope: who's writing, and where in the causal chain. */
interface WriteEnvelope {
  sessionId?: string;
  planVersion?: number;
  causalParent?: string | null;
  actor?: string;
}

/** The three lesson-review routes' envelope. `sessionId` is optional — see lessonContext(). */
interface LessonWriteBody extends WriteEnvelope {
  statement?: string;
  lessonType?: string;
  lessonScope?: string;
  /** Operator rationale, recorded on the status-change payload. */
  note?: string;
  /** Keep a statement the novelty gate scored as a duplicate, on the record (P9-34). */
  acceptDuplicate?: boolean;
}

class BadRequestError extends SmithError {}

/**
 * The session that OWNS this lesson — the one whose log the transition has to
 * fold and append to. Doubles as the 3 lesson write routes' existence check,
 * mirroring the /api/tasks/:taskId 404 pattern.
 *
 * P9-36: this is the whole reason the routes could not simply be pointed at
 * transitionLesson(). The lessons projection spans every session, but a
 * transition is a fold over ONE log; taking the session from the request body
 * (as these routes did) meant folding a log that may not contain the lesson at
 * all, and `lessons.unknown-lesson` on a lesson that plainly exists.
 */
function lessonSession(db: SmithDb, lessonId: string): string {
  const row = db
    .select({ sessionId: lessonsTable.sessionId })
    .from(lessonsTable)
    .where(eq(lessonsTable.lessonId, lessonId))
    .get();
  if (!row) {
    throw new SmithError('lessons.not-found', `No lesson "${lessonId}".`, { lessonId });
  }
  return row.sessionId;
}

/**
 * The read path's freshness gate — operator report, dogfood round 2: "the
 * kanban still is not updating, and in-progress shows no tasks at all."
 *
 * The DB is a projection; `state/events/<session>.jsonl` is the record. Every
 * read route here queries the single connection createApp() opens, and until
 * now nothing on the read path ever re-projected — applyDb() was called only
 * by the two WRITE routes. So the dashboard served whatever the last `smith db
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
 */
function createRefresher(dbPath: string, eventsDir: string, dbOpts: DbOpts): () => Promise<void> {
  const projected = new Map<string, string>();
  const warned = new Map<string, string>();
  // Keyed by finding id and not by session, because apply() folds EVERY
  // session's log at once (D-200): the same quarantine comes back on every
  // poll of every session, and only a finding not named yet is news.
  const namedFindings = new Set<string>();
  let inFlight: Promise<void> | null = null;

  async function scan(): Promise<void> {
    if (!existsSync(eventsDir)) return;
    for (const entry of readdirSync(eventsDir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      let fingerprint: string;
      try {
        const stats = statSync(path.join(eventsDir, entry));
        fingerprint = `${stats.size}:${stats.mtimeMs}`;
      } catch {
        continue; // Deleted between readdir and stat; nothing to project.
      }
      if (projected.get(sessionId) === fingerprint) continue;
      try {
        const { skippedFindings } = await applyDb(dbPath, sessionId, dbOpts);
        projected.set(sessionId, fingerprint);
        // D-141 turned "a finding that cannot fill a notNull column" from a
        // crash into a returned report, on the rule that a loud undercount
        // beats a crash and both beat a quiet one. That made the catch below
        // unreachable for this class and left the report unread: this is the
        // only caller an operator running the dashboard ever goes through, so
        // the undercount was quiet exactly where it had to be loud (D-248).
        for (const skipped of skippedFindings) {
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
            `smith ui: finding '${named}' (${skipped.event_id}) is missing from the projection: ${skipped.reason}\n`,
          );
        }
      } catch (err) {
        // A read is never failed by a log this process does not control. The
        // fingerprint is deliberately NOT recorded, so a torn line caught
        // mid-append is retried on the next request rather than skipped for
        // the life of the process — and the warning is printed once per
        // distinct fingerprint, so a genuinely broken log does not spam the
        // console at the poll interval.
        if (warned.get(sessionId) !== fingerprint) {
          warned.set(sessionId, fingerprint);
          process.stderr.write(
            `smith ui: could not project session '${sessionId}': ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  return function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    const run = scan().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}

function requireSessionId(body: WriteEnvelope): string {
  if (!body.sessionId) {
    throw new BadRequestError('write.bad-request', 'Request body must include "sessionId".');
  }
  return body.sessionId;
}

/**
 * Resolves an explicit causalParent, or falls back to the session's current
 * last event id.
 *
 * `readEvents` and NOT the lineage read D-119 put on every deciding fold: a
 * non-`session-start` event's causal_parent must live in its own session's log
 * (validateCausalParent), so a lineage-wide "last event" would hand back an
 * ancestor's id whenever the parent session's clock ran ahead, and every write
 * from this route would be refused as `events.cross-session-parent-not-root`.
 * This is asking "what do I chain onto here", which is a question about one log.
 */
async function resolveContext(body: WriteEnvelope, eventOpts: EventOpts): Promise<EventContext> {
  const sessionId = requireSessionId(body);
  let causalParent = body.causalParent;
  if (causalParent === undefined) {
    const events = await readEvents(sessionId, eventOpts);
    const last = events[events.length - 1];
    causalParent = last ? last.event_id : null;
  }
  return {
    sessionId,
    planVersion: body.planVersion ?? 1,
    causalParent,
    actor: body.actor,
  };
}

/**
 * resolveContext()'s counterpart for the lesson routes: the session comes from
 * the lesson, not from the caller (P9-36).
 *
 * A `sessionId` in the body is now optional, and when present it is checked
 * rather than used — the shipped client sends the lesson's own session
 * (ui/src/pages/LessonsPage.vue), so a disagreement means the caller believes
 * something false about where this lesson lives, and answering it by quietly
 * writing to the right log would hide that. `requireSession` runs before the
 * fold so an archived log says exactly that, naming the path it expected,
 * instead of readEvents' empty-log-shaped `lessons.unknown-lesson` (P9-28).
 */
async function lessonContext(
  db: SmithDb,
  lessonId: string,
  body: WriteEnvelope,
  eventOpts: EventOpts,
): Promise<EventContext> {
  const sessionId = lessonSession(db, lessonId);
  if (body.sessionId && body.sessionId !== sessionId) {
    throw new BadRequestError(
      'lessons.session-mismatch',
      `Lesson "${lessonId}" belongs to session "${sessionId}", not "${body.sessionId}".`,
      { lessonId, sessionId, requestedSessionId: body.sessionId },
    );
  }
  requireSession(sessionId, eventOpts);
  let causalParent = body.causalParent;
  if (causalParent === undefined) {
    const events = await readEvents(sessionId, eventOpts);
    causalParent = events[events.length - 1]?.event_id ?? null;
  }
  return { sessionId, planVersion: body.planVersion ?? 1, causalParent, actor: body.actor };
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
  const eventOpts: EventOpts = opts.stateDir ? { stateDir: opts.stateDir } : {};
  // D-159 again, at the door P9-36 opened. cli.ts fixed the CLI's paths into
  // the novelty gate to read factory/policies/scheduler.yml; this one still
  // fell through to lessons.ts's own constants, so Approve and Edit scored
  // duplicates against a bar the operator's policy file could not move. The
  // two agree today only because the shipped numbers equal the defaults.
  //
  // Read once at startup, not per request: a malformed file is a loud
  // `scheduler.invalid-policy` when the server boots, not a 500 the first
  // operator to click Approve discovers. Unguarded for the same reason
  // noveltyOptsFromFlags() is — a missing policy is an error, not a default.
  const lessonsPolicy = (opts.schedulerPolicy ?? loadSchedulerPolicy()).lessons;

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
  function sessionScope(c: Context): Pick<Scope, 'sessionId' | 'sessionIds'> {
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
    return { sessionId, sessionIds: projectedLineage(handle.db, sessionId) };
  }

  const app = new Hono();

  app.onError((err, c) => {
    const body = errorBody(err);
    const status = err instanceof SmithError ? errorStatus(err.code) : 500;
    return c.json(body, status);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Fold any newly-appended events into the projection before ANY api route
  // answers — see createRefresher(). /api/health is deliberately registered
  // above this so a liveness probe stays a constant-time no-op.
  const refresh = createRefresher(opts.dbPath, opts.stateDir ?? STATE_EVENTS_DIR, dbOpts);
  app.use('/api/*', async (_c, next) => {
    await refresh();
    await next();
  });

  // --- Reads: one route per §10 page query -----------------------------
  app.get('/api/overview', (c) => {
    const project = c.req.query('project');
    return c.json(overview(handle.db, { ...sessionScope(c), ...(project ? { project } : {}) }));
  });

  app.get('/api/timeline', (c) => {
    const taskId = c.req.query('task');
    const epicId = c.req.query('epic');
    const project = c.req.query('project');
    const causalChainFor = c.req.query('causalChainFor');
    const eventTypesParam = c.req.query('eventTypes');
    const decisionsOnly = c.req.query('decisionsOnly');
    return c.json(
      timeline(handle.db, {
        ...sessionScope(c),
        ...(taskId ? { taskId } : {}),
        ...(epicId ? { epicId } : {}),
        ...(project ? { project } : {}),
        ...(causalChainFor ? { causalChainFor } : {}),
        ...(eventTypesParam ? { eventTypes: eventTypesParam.split(',').filter(Boolean) } : {}),
        ...(decisionsOnly === 'true' ? { decisionsOnly: true } : {}),
      }),
    );
  });

  app.get('/api/kanban', (c) => {
    const epic = c.req.query('epic');
    const project = c.req.query('project');
    return c.json(kanban(handle.db, epic, { ...sessionScope(c), ...(project ? { project } : {}) }));
  });

  // The app shell's own poll — "is the factory still moving, and what has
  // arrived since I looked?". It sits under the refresh middleware like every
  // other read, so the frame's liveness reading and the page's data are folded
  // from the same event log at the same moment.
  app.get('/api/pulse', (c) => {
    const project = c.req.query('project');
    return c.json(pulse(handle.db, { ...sessionScope(c), ...(project ? { project } : {}) }));
  });

  app.get('/api/projects', (c) => {
    const result = overview(handle.db, sessionScope(c));
    return c.json(result.projects ?? []);
  });

  app.get('/api/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const detail = taskDetail(handle.db, taskId);
    if (!detail) throw new SmithError('task.not-found', `No task "${taskId}".`, { taskId });
    return c.json(detail);
  });

  app.get('/api/lessons', (c) => c.json(lessonsPage(handle.db, sessionScope(c))));

  app.get('/api/errors', (c) => {
    const project = c.req.query('project');
    return c.json(errorsPage(handle.db, { ...sessionScope(c), ...(project ? { project } : {}) }));
  });

  app.get('/api/analytics', (c) => {
    const project = c.req.query('project');
    const result: AnalyticsResult = analytics(handle.db, {
      ...sessionScope(c),
      ...(project ? { project } : {}),
    });
    return c.json(result);
  });

  app.get('/api/flow', (c) => {
    const project = c.req.query('project');
    const epic = c.req.query('epic');
    const planVersion = parsePlanVersion(c.req.query('planVersion'));
    return c.json(
      flowGraph(handle.db, {
        ...sessionScope(c),
        ...(project ? { project } : {}),
        ...(epic ? { epicId: epic } : {}),
        ...(planVersion !== undefined ? { planVersion } : {}),
      }),
    );
  });

  app.get('/api/roadmap', (c) => {
    const project = c.req.query('project');
    return c.json(roadmapPage(handle.db, { ...sessionScope(c), ...(project ? { project } : {}) }));
  });

  // --- Writes: waiver apply-batch + lesson approve/edit/reject only ----
  app.post('/api/waivers/apply-batch', async (c) => {
    const body = await c.req.json<WriteEnvelope & { decisions?: WaiverBatchDecision[] }>();
    const decisions = body.decisions ?? [];
    if (decisions.length === 0) {
      throw new BadRequestError(
        'waivers.bad-request',
        'Request body must include a non-empty "decisions" array.',
      );
    }
    const ctx = await resolveContext(body, eventOpts);
    const results = await applyBatch(decisions, ctx, eventOpts);
    await applyDb(opts.dbPath, ctx.sessionId, dbOpts);
    return c.json({ applied: results.length });
  });

  /** The one write path all three lesson routes share (P9-36). */
  async function transition(
    lessonId: string,
    toStatus: string,
    body: LessonWriteBody,
    extra: LessonTransitionExtra,
  ): Promise<{ lessonId: string; status: string; novelty: unknown }> {
    const ctx = await lessonContext(handle.db, lessonId, body, eventOpts);
    const result = await transitionLesson(lessonId, toStatus, ctx, eventOpts, {
      ...extra,
      ...(body.note ? { note: body.note } : {}),
      // Last, as cli.ts spreads noveltyOptsFromFlags() last: one place
      // answers "what threshold is in effect" and no route can take the
      // gate's shape from the request body.
      noveltyThreshold: lessonsPolicy.noveltyJaccardThreshold,
      shingleSize: lessonsPolicy.shingleSize,
      noveltyLengthAware: lessonsPolicy.noveltyLengthAware,
    });
    await applyDb(opts.dbPath, ctx.sessionId, dbOpts);
    return { lessonId, status: result.lessonStatus, novelty: result.novelty };
  }

  app.post('/api/lessons/:lessonId/approve', async (c) => {
    const body = await c.req.json<LessonWriteBody>().catch(() => ({}) as LessonWriteBody);
    return c.json(await transition(c.req.param('lessonId'), 'approved', body, {}));
  });

  app.post('/api/lessons/:lessonId/reject', async (c) => {
    const body = await c.req.json<LessonWriteBody>().catch(() => ({}) as LessonWriteBody);
    return c.json(await transition(c.req.param('lessonId'), 'invalidated', body, {}));
  });

  app.post('/api/lessons/:lessonId/edit', async (c) => {
    const lessonId = c.req.param('lessonId');
    const body = await c.req.json<LessonWriteBody>();
    if (!body.statement && !body.lessonType && !body.lessonScope) {
      throw new BadRequestError(
        'lessons.bad-request',
        'Edit requires at least one of "statement", "lessonType", "lessonScope".',
      );
    }
    const edit: LessonEdit = {
      ...(body.statement ? { statement: body.statement } : {}),
      ...(body.lessonType ? { lessonType: body.lessonType } : {}),
      ...(body.lessonScope ? { lessonScope: body.lessonScope } : {}),
    };
    // acceptDuplicate has to be forwarded, not defaulted on: it is the
    // operator's decision to keep a statement the novelty gate scored as a
    // duplicate, and transitionLesson records it on the event (P9-34).
    return c.json(
      await transition(lessonId, 'approved', body, {
        edit,
        ...(body.acceptDuplicate ? { acceptDuplicate: true } : {}),
      }),
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

  return { app, handle };
}

export function closeApp(handle: AppHandle): void {
  handle.handle.sqlite.close();
}
