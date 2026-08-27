// Rebuild state/smith.db (SQLite projections) from state/events/*.jsonl.
//
// Events are the source of truth (architecture §7); this module is the
// ONLY writer of the tables in db/schema.ts. Two entry points:
//   - rebuild(): drop every table's rows and replay every session's full
//     event log from scratch. Idempotent — running it twice yields the
//     same rows.
//   - apply(): re-fold ONE session's current event log and refresh only
//     that session's rows, leaving every other session's projection
//     untouched ("incremental" in the sense that it never re-touches
//     unrelated sessions, not in the sense of appending a single event —
//     see the design note above projectSession below).
//
// Deviation (noted for the human, per the phase-5 task brief): the
// architecture doc describes dispatch_decision's terminal counterpart only
// in prose ("task result recorded"); no event type or payload shape for it
// exists anywhere in the codebase yet. This module introduces
// `task-result-recorded` (payload = the full Result object, i.e.
// result.schema.json's shape) as that terminal event, consumed here by
// agents-registry.ts's fold and by tasks/analytics below. No taxonomy.yml
// change was needed — event_type is a free string in event.schema.json
// (dispatch_decision, error-logged, session-start, edge-recorded, and
// every gate_event/graph_event value are already free strings by the same
// precedent) — but a short note was added to docs/specs/
// black-smith-architecture.md §7 documenting the new event kind, in the
// same place dispatch_decision/user_prompt are documented.
//
// A second, smaller deviation: `lesson-candidate-raised` /
// `lesson-status-changed` events (consumed by foldLessons below) are
// likewise new — Phase 7 owns the real lessons loop (novelty gate,
// operator approval UI) and will define these for real; this module's
// fold is forward-compatible with whatever Phase 7 emits, since it only
// depends on the taxonomy's already-existing lesson_type/lesson_level/
// lesson_status/lesson_scope vocabulary, not on any new taxonomy value.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  detectStale as detectStaleAgents,
  foldAgents,
  type StaleAgent,
} from '../agents-registry.js';
import {
  type EventRecord,
  eventTaskId,
  listSessionIds,
  mergeSessionLogs,
  readEvents,
  type SessionLog,
  type StoredEvent,
} from '../events.js';
import {
  foldFindingsDetailed,
  missingProjectionFields,
  type SkippedFindingRecord,
} from '../findings.js';
import { DB_MIGRATIONS_DIR, ROADMAP_PATH, STATE_DB_PATH, STATE_EVENTS_DIR } from '../paths.js';
import { isPlanRefTaskId, latestPlanVersion, loadPlan } from '../plan.js';
import { loadRoadmap, type MilestoneDef } from '../roadmap.js';
import { assertRuntimeSupported } from '../runtime.js';
import {
  bareTaskId,
  epicOfTaskId,
  isQualifiedTaskId,
  qualifyTaskId,
  taskIdsMatch,
} from '../taskId.js';
import { RESERVED_TASK_ID, taskBranchName } from '../worktree.js';
import * as schema from './schema.js';

// No ProjectorError: the projector never throws. A record it cannot fold in
// is logged and skipped, because a projection that dies on one bad row is a
// dashboard that dies on one bad row -- and the event log, not this file, is
// the thing that has to survive. Do not add one back for symmetry.

export type SmithDb = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  sqlite: Database.Database;
  db: SmithDb;
}

export interface DbOpts {
  stateDir?: string;
  migrationsDir?: string;
  /**
   * Overrides factory/specs/roadmap.md's path; defaults to the real repo file.
   * Not tests-only — `db rebuild`/`db apply`/`ui serve` expose it as
   * `--roadmap-path`, because every db but black-smith's own needs its own
   * roadmap projected into it (projectMilestones rewrites the whole table).
   */
  roadmapPath?: string;
  /**
   * Overrides factory/specs/active/'s path; defaults to the real repo dir.
   * Read to answer two questions the events alone can leave unanswered — what
   * project an epic belongs to (D-246, planProjectResolver below) and which
   * epic owns a task id the log only ever spelled bare (D-250,
   * planRosterAliases below) — never to project a plan into a table.
   * Exposed as `--specs-dir` for the same reason `--roadmap-path` is: a db
   * that is not black-smith's own is built from another tree.
   */
  specsDir?: string;
}

/** Open (creating if needed) the projection DB and ensure its schema is current. */
export function openDb(dbPath: string = STATE_DB_PATH, opts: DbOpts = {}): DbHandle {
  // The line below is where an unsupported runtime dies: the prebuilt binding
  // imports fine on Node 20 and then segfaults here, with both streams empty
  // (D-47). Assert immediately before it so every in-process consumer — not
  // just the CLI — gets a sentence instead of a signal.
  assertRuntimeSupported();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsDir ?? DB_MIGRATIONS_DIR });
  return { sqlite, db };
}

const ALL_TABLES = [
  schema.eventsRaw,
  schema.sessions,
  schema.prompts,
  schema.dispatches,
  schema.agents,
  schema.tasks,
  schema.epics,
  schema.edges,
  schema.errors,
  schema.findings,
  schema.waivers,
  schema.lessons,
  schema.artifacts,
  schema.milestones,
] as const;

/** Delete every row in every projection table (full "drop" for rebuild()). */
function clearAll(handle: DbHandle): void {
  handle.db.transaction((txDb) => {
    for (const table of ALL_TABLES) txDb.delete(table).run();
  });
}

/** Delete one session's rows from every table (used before re-projecting it). */
function clearSession(db: SmithDb, sessionId: string): void {
  db.delete(schema.eventsRaw).where(eq(schema.eventsRaw.sessionId, sessionId)).run();
  db.delete(schema.sessions).where(eq(schema.sessions.sessionId, sessionId)).run();
  db.delete(schema.prompts).where(eq(schema.prompts.sessionId, sessionId)).run();
  db.delete(schema.dispatches).where(eq(schema.dispatches.sessionId, sessionId)).run();
  db.delete(schema.agents).where(eq(schema.agents.sessionId, sessionId)).run();
  db.delete(schema.tasks).where(eq(schema.tasks.sessionId, sessionId)).run();
  db.delete(schema.epics).where(eq(schema.epics.sessionId, sessionId)).run();
  db.delete(schema.edges).where(eq(schema.edges.sessionId, sessionId)).run();
  db.delete(schema.errors).where(eq(schema.errors.sessionId, sessionId)).run();
  db.delete(schema.waivers).where(eq(schema.waivers.sessionId, sessionId)).run();
  db.delete(schema.artifacts).where(eq(schema.artifacts.sessionId, sessionId)).run();
  // `lessons` and `findings` are deliberately absent, like `milestones` —
  // projectLessons() and projectFindings() own those tables whole (D-199,
  // D-200). Deleting by session_id here would delete a row this session
  // raised and another session has since approved or closed.
}

/**
 * Fully replace the milestones table from factory/specs/roadmap.md (not
 * session-scoped — see schema.ts's milestones comment). Missing roadmap.md
 * is tolerated (leaves milestones empty) rather than fatal, so `db rebuild`
 * still works in a repo/state-dir that hasn't adopted a roadmap yet.
 *
 * A roadmap.md that fails to PARSE (malformed status, duplicate id, ...) is
 * likewise tolerated, deliberately: this runs after every session write
 * (rebuild()/apply(), the latter called by ui/server after every waiver/
 * lesson event) — a markdown typo must degrade the Roadmap/Overview
 * milestone data only, not the write path it happens to share a call site
 * with. Existing milestones rows are left as-is (stale, not wiped) rather
 * than the whole write erroring out; logged to stderr so it is visible.
 */
function projectMilestones(handle: DbHandle, opts: DbOpts): void {
  const roadmapPath = opts.roadmapPath ?? ROADMAP_PATH;
  if (!existsSync(roadmapPath)) return;

  let defs: MilestoneDef[];
  try {
    defs = loadRoadmap(roadmapPath);
  } catch (err) {
    console.error(
      `db/projector.ts projectMilestones(): roadmap.md failed to parse, ` +
        `skipping the milestones refresh (existing rows left as-is): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  handle.db.transaction((txDb) => {
    txDb.delete(schema.milestones).run();
    for (const m of defs) {
      txDb
        .insert(schema.milestones)
        .values({
          milestoneId: m.milestoneId,
          name: m.name,
          status: m.status,
          sequence: m.sequence,
          goal: m.goal,
          epicIds: JSON.stringify(m.epicIds),
          project: m.project,
        })
        .run();
    }
  });
}

interface UserPromptPayload {
  prompt?: string;
  text?: string;
}

interface DispatchPayload {
  agent_role?: string;
  provider?: string;
  model_tier?: string;
  spec_ref?: string;
  reason?: string;
  parent_prompt_id?: string;
}

interface ErrorPayload {
  error?: string;
  severity?: string;
  task_ref?: string;
  detail?: string;
}

interface ResultArtifact {
  type?: string;
  path?: string;
  description?: string;
}

interface ResultPayload {
  task_id?: string;
  artifacts?: ResultArtifact[];
}

interface WaiverPayload {
  fingerprint?: string;
  operator_note?: string;
}

/** Splits an `error.class` string into its group/class parts; tolerant of malformed values. */
function splitErrorClass(value: string | undefined): { group: string; cls: string } {
  const [group, cls] = (value ?? '').split('.');
  return { group: group ?? 'unknown', cls: cls ?? 'unknown' };
}

// ---------------------------------------------------------------------------
// tasks fold — no existing module owns task-lifecycle state (plan.ts is
// file-based, not event-sourced yet), so this is new logic, kept minimal
// and documented rather than borrowed from anywhere.
// ---------------------------------------------------------------------------

export interface TaskFoldRow {
  taskId: string;
  sessionId: string;
  epicId: string | null;
  caseTag: string | null;
  origin: string | null;
  taskStatus: string;
  planVersion: number | null;
  objective: string | null;
  claims: string[] | null;
  budgetTokens: number | null;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  /** Phase 6b — plain-string project identifier, see schema.ts's project comment. */
  project: string | null;
}

const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'superseded',
  'failed',
  'escalated',
  'waived',
]);

interface TaskAddedPayload {
  epic_id?: string;
  case?: string;
  origin?: string;
  task_status?: string;
  plan_version?: number;
  objective?: string;
  claims?: string[];
  budget_tokens?: number;
  /** D-23/P9-12: declared by the producer; `branchFor` only fills the gap. */
  branch?: string;
}

/**
 * Fallback for a `task-added` that declares no `branch` — every event logged
 * before D-23/P9-12 added the field, and any hand-appended one. The
 * convention itself lives in worktree.ts, which is what actually creates the
 * branch; deriving it here from a second copy of the string is how the two
 * would drift.
 */
/**
 * The paths a `task-added` says its task owns, or undefined when the payload
 * does not say it in a shape a reader can use.
 *
 * event.schema.json validates `payload` as `type: object` and stops there —
 * the body is free-form on purpose, so that a new event type is never
 * rejected at write time — which is why taskEvents.ts types the same field
 * `unknown`. The cast above says `string[]` and nothing checks it, so
 * whatever was written lands in tasks.claims and comes back out of
 * taskDetail() still cast to `string[]`: a claim set written as one bare path
 * reaches the board as a string and renders one chip per character.
 * waveTaskIds already learned that a hand-appended payload fills in the
 * singular field ("four times during the dogfood run"), and a single claim is
 * the same keystroke.
 *
 * Unreadable leaves the row's claims alone rather than becoming `[]`: the
 * column starts null meaning "no task-added told us what this owns", and that
 * is still true here, whereas an empty list would assert the task declares
 * nothing. A half-readable list is the same hole as no list — filtering it
 * would hand every reader a shorter set than the task declared and call that
 * what it owns — and gate.ts's loggedClaims() draws the line in the same
 * place on the same payload.
 */
function readClaims(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.every((c) => typeof c === 'string') ? (raw as string[]) : undefined;
}

function branchFor(epicId: string | null, taskId: string): string | null {
  if (!epicId) return null;
  return taskBranchName(epicId, taskId);
}

/**
 * Every (task id, epic) pair an event asserts: from the id itself when it is
 * qualified, from the payload's `epic_id` when it is not. `wave-admitted`
 * carries the epic beside a list of ids; `task-added`/`task-superseded` carry
 * it beside the one on the record.
 */
function epicAssertions(record: StoredEvent['record']): Array<[string, string | undefined]> {
  const payload = record.payload as { epic_id?: string; task_ids?: string[] } | undefined;
  const epicId = typeof payload?.epic_id === 'string' ? payload.epic_id : undefined;
  const taskId = eventTaskId(record);
  const ids = [
    ...(taskId ? [taskId] : []),
    ...(Array.isArray(payload?.task_ids)
      ? payload.task_ids.filter((v) => typeof v === 'string')
      : []),
  ];
  return ids.map((id) => [id, epicId]);
}

/**
 * Every epic id the log names: from any event's `epic_id`, and from the epic
 * half of every qualified task id it mentions.
 *
 * An epic id is not a task id — it never contains a `/` — so a set of them
 * can never shadow a qualified task. Two things below need it: the guard that
 * keeps an epic-shaped ref off the board (D-251), and the roster lookup that
 * only visits epics this log actually ran (D-250).
 */
function knownEpicIds(events: readonly StoredEvent[]): Set<string> {
  const epics = new Set<string>();
  for (const { record } of events) {
    const payload = record.payload as { epic_id?: string } | undefined;
    if (typeof payload?.epic_id === 'string' && payload.epic_id.length > 0) {
      epics.add(payload.epic_id);
    }
    for (const [id] of epicAssertions(record)) {
      const epic = epicOfTaskId(id);
      if (epic !== null) epics.add(epic);
    }
  }
  return epics;
}

/**
 * Bare id -> qualified id, read from the plan roster of every epic the log
 * names (D-250).
 *
 * `buildTaskIdAliases` can only match a bare id against a qualified spelling
 * some OTHER event supplied. A task whose every event is bare and carries no
 * `epic_id` — no `task-added`, just gate results, as `task-4-api` was through
 * the whole envkit dogfood run — has no such spelling, so it folds to its own
 * epic-less row and the project-scoped board never draws it. The plan roster
 * this projector already opens for `planProjectResolver` names it in full.
 *
 * Same tolerance as that resolver: a missing dir, a missing file, or one that
 * will not parse all mean "no answer", never a failed rebuild. The full
 * `plan.tasks` roster is read rather than `livePlanTasks` — a superseded task
 * is still that task, and its id still has to fold onto the right row.
 */
function planRosterAliases(
  epics: ReadonlySet<string>,
  specsDir: string | undefined,
): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>();
  for (const epicId of epics) {
    let roster: readonly string[] = [];
    try {
      const version = latestPlanVersion(epicId, { specsDir });
      if (version !== null) {
        roster = loadPlan(epicId, version, { specsDir }).tasks.map((t) => t.task_id);
      }
    } catch (err) {
      console.error(
        `db/projector.ts planRosterAliases(): plan file for "${epicId}" ` +
          `failed to load, leaving its task ids unresolved: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const id of roster) {
      if (!isQualifiedTaskId(id)) continue;
      const bare = bareTaskId(id);
      const set = candidates.get(bare) ?? new Set<string>();
      set.add(id);
      candidates.set(bare, set);
    }
  }
  return candidates;
}

/**
 * Bare id -> the one qualified id it must mean, built from every epic the log
 * asserts for it (D-49/P9-10), and from the plan rosters on disk for the ids
 * the log never qualifies anywhere (D-250).
 *
 * Producers disagree about the form: `task-added` writes `envkit/task-0`
 * while `wave-admitted`/`wave-merged` write `task-0` and put the epic in the
 * payload. Folded literally that is two rows for one task — one stuck at
 * `todo` with no epic, one `completed` with no objective — and every consumer
 * that counts tasks counts it twice.
 *
 * A bare id claimed by two different epics gets NO entry: merging it into
 * either would silently complete the wrong task, so it stays its own row and
 * stays visible as the ambiguity it is.
 */
function buildTaskIdAliases(
  events: readonly StoredEvent[],
  opts: Pick<DbOpts, 'specsDir'>,
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const register = (bare: string, qualified: string): void => {
    const set = candidates.get(bare) ?? new Set<string>();
    set.add(qualified);
    candidates.set(bare, set);
  };

  for (const { record } of events) {
    for (const [id, epicId] of epicAssertions(record)) {
      if (isQualifiedTaskId(id)) register(bareTaskId(id), id);
      else if (epicId !== undefined && id.length > 0) register(id, qualifyTaskId(epicId, id));
    }
  }

  // The roster is consulted only for a bare id NO event qualified. It is a
  // fallback and never an override — the same precedence D-246 gives the
  // plan's `project` — so a log that already answered keeps its answer, and a
  // roster entry can never turn a clean event-derived alias into an
  // ambiguity. An id the LOG left ambiguous stays ambiguous too: the plan
  // breaking that tie would quietly overrule two events that disagree.
  const fromPlan = planRosterAliases(knownEpicIds(events), opts.specsDir);

  const aliases = new Map<string, string>();
  for (const bare of new Set([...candidates.keys(), ...fromPlan.keys()])) {
    const qualified = candidates.get(bare) ?? fromPlan.get(bare) ?? new Set<string>();
    const [only] = [...qualified];
    if (qualified.size === 1 && only !== undefined && only !== bare) aliases.set(bare, only);
  }
  return aliases;
}

/**
 * The exact normalisation `foldTasks` applies to every id it folds.
 *
 * Exported because a consumer that keys its own map on raw log ids — the ids
 * as producers wrote them — must resolve them the same way, or its lookups
 * miss the rows `foldTasks` returns and silently fall back to a default
 * (D-182). One resolver, one answer.
 *
 * `opts.specsDir` is threaded through for the same reason: a caller that
 * resolves ids without it would miss D-250's roster-derived aliases and go
 * back to disagreeing with the rows in the db.
 */
export function taskIdCanonicalizer(
  events: readonly StoredEvent[],
  opts: Pick<DbOpts, 'specsDir'> = {},
): (taskId: string) => string {
  const aliases = buildTaskIdAliases(events, opts);
  return (taskId) => (isQualifiedTaskId(taskId) ? taskId : (aliases.get(taskId) ?? taskId));
}

/**
 * The tasks a wave-scoped event (`wave-admitted`, `wave-merged`) speaks for.
 *
 * D-23/P9-12: the payload's `task_ids` is authoritative — that is what the
 * producers in taskEvents.ts write, and a wave is a set. But an event
 * appended by hand naturally fills in the envelope's singular `task_id` and
 * leaves `task_ids` empty; that happened four times during the dogfood run
 * and the fold read nothing at all, so the board silently stayed wrong.
 * Reading the record-level id as a one-task wave makes those keystrokes mean
 * what they look like they mean, and costs the producers nothing: they emit
 * both (one `wave-merged` per merged task, carrying its own id).
 */
function waveTaskIds(record: EventRecord): string[] {
  const ids = (record.payload as { task_ids?: string[] }).task_ids;
  if (Array.isArray(ids) && ids.length > 0) return ids;
  const taskId = eventTaskId(record);
  return taskId ? [taskId] : [];
}

export function foldTasks(
  events: readonly StoredEvent[],
  opts: Pick<DbOpts, 'specsDir'> = {},
): TaskFoldRow[] {
  const byId = new Map<string, TaskFoldRow>();
  // Normalisation happens at this boundary, once, before any row exists —
  // so no later code has to ask which of two ids for one task it is holding.
  const canonical = taskIdCanonicalizer(events, opts);
  const epics = knownEpicIds(events);

  function touch(rawTaskId: string, ts: string, sessionId: string): TaskFoldRow {
    const taskId = canonical(rawTaskId);
    let row = byId.get(taskId);
    if (!row) {
      row = {
        taskId,
        sessionId,
        // A qualified id IS an epic assertion; reading it here means every
        // consumer can filter on the field instead of re-deriving it, and a
        // task whose only event is a dispatch still knows its epic.
        epicId: epicOfTaskId(taskId),
        caseTag: null,
        origin: null,
        taskStatus: 'todo',
        planVersion: null,
        objective: null,
        claims: null,
        budgetTokens: null,
        branch: null,
        createdAt: ts,
        updatedAt: ts,
        project: null,
      };
      // Three ref shapes are NOT tasks and must never surface as kanban
      // cards. The epic's own bare id, which `error-logged` writes into
      // `payload.task_ref` when the failure belongs to no single task (D-251)
      // — the phantom foldEpics() keeps itself off this fold to avoid; the
      // errors table takes that row straight from the event, so refusing the
      // card costs nothing. And two qualified-looking refs:
      // <epic>/integration (worktree.ts's RESERVED_TASK_ID, the epic's
      // integration branch — epic.ts's runEpicVerdict()) and <epic>/plan-v<n>
      // (plan.ts's planRefTaskId(), a plan version — planQuorum.ts's
      // runPlanQuorum()). Both hosts stamp their ref onto the
      // dispatch_decision/judge-verdict/quorum-decision events their quorum
      // case emits, so provider-agreement analytics can group by it like any
      // other dispatch (db/queries.ts's providerAgreement() reads eventsRaw
      // directly, never joins tasks, so it's unaffected either way). Every
      // event type that carries a task_id routes through this one touch()
      // choke point (task-added, wave-admitted, dispatch_decision,
      // gate-outcome, wave-merged, task-superseded, error-logged), so one
      // guard here is enough: build the row (callers below still mutate it
      // freely) but never register a reserved ref in byId, so it never
      // reaches foldTasks()'s returned rows or projectSession()'s tasks-table
      // insert loop.
      const isReservedRef =
        taskId.split('/').pop() === RESERVED_TASK_ID ||
        isPlanRefTaskId(taskId) ||
        epics.has(taskId);
      if (!isReservedRef) byId.set(taskId, row);
    }
    row.updatedAt = ts;
    return row;
  }

  for (const { record } of events) {
    // Resolved once, above the switch, for the same reason `touch()` is the
    // one place a row is born: a hand-written event names its task in the
    // payload and leaves the envelope null (D-245), and reading the envelope
    // alone dropped every such event on the floor — a dispatched task stayed
    // `todo` on the board and its `project` was never stamped.
    const eventTask = eventTaskId(record);
    switch (record.event_type) {
      case 'task-added': {
        if (!eventTask) break;
        const p = record.payload as TaskAddedPayload;
        const row = touch(eventTask, record.ts, record.session_id);
        // The id wins when it carries an epic: it is what every branch name
        // and finding is keyed on, and a payload that disagrees with it is a
        // producer bug, not a second opinion worth honouring.
        row.epicId = epicOfTaskId(row.taskId) ?? p.epic_id ?? row.epicId;
        row.caseTag = p.case ?? row.caseTag;
        row.origin = p.origin ?? row.origin;
        // D-18b. `task_status` in a plan file is only ever the task's INITIAL
        // status — nothing writes completion back into the document — so a
        // second `task-added` for the same id (which an amendment now emits, so
        // the amended task carries the new plan_version) would otherwise revert
        // a merged task to `todo`. A terminal status is a fact the log earned
        // from `wave-merged`; a static field in a plan file does not overrule
        // it. Same guard `dispatch_decision` and `error-logged` already apply.
        if (!TERMINAL_TASK_STATUSES.has(row.taskStatus))
          row.taskStatus = p.task_status ?? row.taskStatus;
        row.planVersion = p.plan_version ?? row.planVersion;
        row.objective = p.objective ?? row.objective;
        row.claims = readClaims(p.claims) ?? row.claims;
        row.budgetTokens = p.budget_tokens ?? row.budgetTokens;
        row.branch = p.branch ?? branchFor(row.epicId, row.taskId);
        row.project = record.project ?? row.project;
        break;
      }
      case 'wave-admitted': {
        const p = record.payload as { epic_id?: string };
        for (const taskId of waveTaskIds(record)) {
          const row = touch(taskId, record.ts, record.session_id);
          row.taskStatus = 'ready';
          row.epicId = epicOfTaskId(row.taskId) ?? p.epic_id ?? row.epicId;
        }
        break;
      }
      case 'dispatch_decision': {
        if (!eventTask) break;
        const row = touch(eventTask, record.ts, record.session_id);
        if (!TERMINAL_TASK_STATUSES.has(row.taskStatus)) row.taskStatus = 'in-progress';
        row.project = record.project ?? row.project;
        break;
      }
      case 'gate-outcome': {
        if (!eventTask) break;
        const p = record.payload as { outcome?: string };
        const row = touch(eventTask, record.ts, record.session_id);
        if (p.outcome === 'blocked') row.taskStatus = 'blocked';
        else if (p.outcome === 'pass-with-waivers-pending') row.taskStatus = 'reviewing';
        else if (p.outcome === 'pass') row.taskStatus = 'merging';
        break;
      }
      case 'wave-merged': {
        for (const taskId of waveTaskIds(record)) {
          touch(taskId, record.ts, record.session_id).taskStatus = 'completed';
        }
        break;
      }
      case 'task-superseded': {
        if (!eventTask) break;
        touch(eventTask, record.ts, record.session_id).taskStatus = 'superseded';
        break;
      }
      case 'error-logged': {
        const p = record.payload as ErrorPayload;
        // `task_ref` is this event's own spelling; eventTaskId covers the two
        // the rest of the log uses (D-245).
        const taskId = eventTask ?? p.task_ref;
        if (!taskId) break;
        const row = touch(taskId, record.ts, record.session_id);
        row.project = record.project ?? row.project;
        if (TERMINAL_TASK_STATUSES.has(row.taskStatus)) break;
        row.taskStatus = p.error?.startsWith('coordination.') ? 'escalated' : 'blocked';
        break;
      }
      default:
        break;
    }
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// lessons fold — see deviation note in this file's header comment.
// ---------------------------------------------------------------------------

export interface LessonFoldRow {
  lessonId: string;
  sessionId: string;
  lessonType: string;
  lessonLevel: string;
  lessonStatus: string;
  lessonScope: string;
  statement: string;
  validFrom: string;
  supersededBy: string | null;
  invalidatedByEventId: string | null;
  provenanceEventIds: string[];
  evidence: string | null;
  timesPrevented: number;
  /** Phase 7 (lessons.ts) — see lesson.schema.json's field comments. */
  findingCategory: string | null;
  claimPath: string | null;
  /** D-129 selectors — the field the entry's scope is filtered by at dispatch. */
  agentRole: string | null;
  caseType: string | null;
}

interface LessonRaisedPayload {
  lesson_id?: string;
  lesson_type?: string;
  lesson_level?: string;
  lesson_status?: string;
  lesson_scope?: string;
  statement?: string;
  valid_from?: string;
  superseded_by?: string | null;
  invalidated_by_event_id?: string | null;
  provenance_event_ids?: string[];
  evidence?: string;
  finding_category?: string;
  claim_path?: string;
  agent_role?: string;
  case_type?: string;
}

interface LessonStatusChangedPayload {
  lesson_id?: string;
  to_status?: string;
  superseded_by?: string;
  invalidated_by_event_id?: string;
}

/**
 * `lesson-edited` (ui/server addition, same deviation class as
 * lesson-candidate-raised/lesson-status-changed — see this file's header
 * comment): the Lessons review Dialog's "Edit" action, always immediately
 * followed by a `lesson-status-changed` to `approved` in the same request
 * (design-spec.md §5.6: "the edit is folded into a single 'Save & approve'
 * commit"). Only the fields the operator actually changed are present.
 */
interface LessonEditedPayload {
  lesson_id?: string;
  statement?: string;
  lesson_type?: string;
  lesson_scope?: string;
  /** D-129: re-scoping to a selector scope has to be able to name the selector in the same edit. */
  agent_role?: string;
  case_type?: string;
}

interface SeverityDecisionsPayload {
  decisions?: Array<{ same_mistake?: boolean; matched_lesson_id?: string | null }>;
}

export function foldLessons(events: readonly StoredEvent[]): LessonFoldRow[] {
  const byId = new Map<string, LessonFoldRow>();
  const prevented = new Map<string, number>();

  for (const { record } of events) {
    if (record.event_type === 'lesson-candidate-raised') {
      const p = record.payload as LessonRaisedPayload;
      if (!p.lesson_id || !p.lesson_type || !p.lesson_level || !p.lesson_scope || !p.statement) {
        continue;
      }
      byId.set(p.lesson_id, {
        lessonId: p.lesson_id,
        sessionId: record.session_id,
        lessonType: p.lesson_type,
        lessonLevel: p.lesson_level,
        lessonStatus: p.lesson_status ?? 'candidate',
        lessonScope: p.lesson_scope,
        statement: p.statement,
        validFrom: p.valid_from ?? record.ts,
        supersededBy: p.superseded_by ?? null,
        invalidatedByEventId: p.invalidated_by_event_id ?? null,
        provenanceEventIds: p.provenance_event_ids ?? [],
        evidence: p.evidence ?? null,
        timesPrevented: 0,
        findingCategory: p.finding_category ?? null,
        claimPath: p.claim_path ?? null,
        agentRole: p.agent_role ?? null,
        caseType: p.case_type ?? null,
      });
    } else if (record.event_type === 'lesson-status-changed') {
      const p = record.payload as LessonStatusChangedPayload;
      if (!p.lesson_id || !p.to_status) continue;
      const row = byId.get(p.lesson_id);
      if (!row) continue;
      row.lessonStatus = p.to_status;
      if (p.superseded_by) row.supersededBy = p.superseded_by;
      if (p.invalidated_by_event_id) row.invalidatedByEventId = p.invalidated_by_event_id;
    } else if (record.event_type === 'lesson-edited') {
      const p = record.payload as LessonEditedPayload;
      if (!p.lesson_id) continue;
      const row = byId.get(p.lesson_id);
      if (!row) continue;
      // Trimmed, and a whitespace-only statement ignored rather than
      // applied: transitionLesson trims the edit and then refuses an empty
      // result outright, so this is the writer's own rule read back. A fold
      // cannot refuse -- it is replaying what already happened -- so the
      // nearest true answer is to leave the statement the edit failed to say
      // anything better than, instead of blanking a real one to spaces.
      const statement = p.statement?.trim();
      if (statement) row.statement = statement;
      if (p.lesson_type) row.lessonType = p.lesson_type;
      if (p.lesson_scope) row.lessonScope = p.lesson_scope;
      if (p.agent_role) row.agentRole = p.agent_role;
      if (p.case_type) row.caseType = p.case_type;
    } else if (record.event_type === 'severity-decisions') {
      const p = record.payload as SeverityDecisionsPayload;
      for (const d of p.decisions ?? []) {
        if (d.same_mistake && d.matched_lesson_id) {
          prevented.set(d.matched_lesson_id, (prevented.get(d.matched_lesson_id) ?? 0) + 1);
        }
      }
    }
  }

  for (const [lessonId, count] of prevented) {
    const row = byId.get(lessonId);
    if (row) row.timesPrevented = count;
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Epics (D-44/P9-27)
// ---------------------------------------------------------------------------

export interface EpicFoldRow {
  epicId: string;
  sessionId: string;
  epicStatus: string;
  closedBy: string;
  machineVerdict: string | null;
  machineReason: string | null;
  overrideRationale: string | null;
  blockers: string[];
  closedAt: string;
  eventId: string;
  project: string | null;
}

interface EpicClosedPayload {
  epic_id?: string;
  closed_by?: string;
  machine_verdict?: string | null;
  machine_reason?: string | null;
  override_rationale?: string | null;
  blockers?: string[];
}

/**
 * D-44/P9-27. Appending the close event is half the fix. projectSession()
 * writes every event to events_raw, so a hand-written `epic-closed` was
 * queryable there — but foldTasks()'s switch knows seven event types and ends
 * `default: break;`, so nothing a human ever looks at changed. The log and the
 * projection disagreed, and the projection is what every surface reads.
 *
 * Deliberately its own fold, keyed on `payload.epic_id` and never on task_id:
 * the real dogfood close used `<epic>/epic`, an unreserved suffix that slips
 * past foldTasks()'s isReservedRef guard, so anything routed through the task
 * fold would mint a phantom task card named after the epic. Reading the id
 * from the payload makes that structurally impossible.
 *
 * Last close wins — re-closing an epic is a correction, not a second epic.
 */
export function foldEpics(events: readonly StoredEvent[]): EpicFoldRow[] {
  const byId = new Map<string, EpicFoldRow>();

  for (const { event_id, record } of events) {
    if (record.event_type !== 'epic-closed') continue;
    const p = record.payload as EpicClosedPayload;
    // No epic_id means there is no epic to attribute this to. Guessing one
    // out of task_id is exactly the inference this fold exists to avoid.
    if (!p.epic_id) continue;

    byId.set(p.epic_id, {
      epicId: p.epic_id,
      sessionId: record.session_id,
      epicStatus: 'closed',
      // An unattributed close still closed the epic — dropping the row would
      // leave it reading as in flight forever, which is the D-43 bug again.
      closedBy: p.closed_by ?? 'unspecified',
      machineVerdict: p.machine_verdict ?? null,
      machineReason: p.machine_reason ?? null,
      overrideRationale: p.override_rationale ?? null,
      blockers: Array.isArray(p.blockers) ? p.blockers : [],
      closedAt: record.ts,
      eventId: event_id,
      project: record.project ?? null,
    });
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Per-session projection
// ---------------------------------------------------------------------------

/**
 * Re-fold one session's CURRENT full event log into every table's rows for
 * that session. Both rebuild() and apply() call this — there is one fold
 * path, not two: "incremental" apply() re-derives the session's rows from
 * its complete history (readEvents() always returns the full log; findings.
 * ts's foldFindings() already works this way too) rather than patching a
 * single new event into partially-mutable state. That keeps this file the
 * single owner of every table's shape and makes rebuild/apply equivalence
 * trivial to prove (same function, same input) instead of two fold
 * implementations that can drift.
 */
/**
 * Where a row belongs when its own envelope does not say.
 *
 * D-233. Only the writers holding the plan stamp a project (taskEvents.ts,
 * D-232): a task's `task-added` carries one, and the dispatch, the result and
 * the error that follow it carry nothing, because the code that appends them
 * never saw the plan file. That is not a gap in the log -- events.ts is
 * deliberate that an absent project stays absent on the wire -- but it IS a
 * gap in these tables, because db/queries.ts's projectOf() resolves a NULL
 * column to the DEFAULT project. Left alone, every gate outcome and every
 * failure of a demo-rpg run reads back as black-smith's.
 *
 * A child row's project is its task's, which is exactly the rule the Scope
 * docblock in db/queries.ts already states (D-170). Derived from the same
 * foldTasks() the tasks table is written from, so the two can never disagree.
 *
 * This docblock used to claim projectFindings() below already applied that
 * same rule. It did not -- it looked its tasks up in a plain exact-key Map,
 * and 41 of the 56 findings in the shipped logs fell through the difference
 * (D-247). It calls this resolver now, so the claim is true.
 *
 * Membership asks taskIdsMatch and not Map.has: the log spells the same task
 * both qualified ("epic/task-1") and bare ("task-1"), and a spelling
 * difference is not a different task (D-130/D-143).
 */
function projectResolver(
  taskRows: readonly TaskFoldRow[],
): (taskId: string | null | undefined) => string | null {
  const exact = new Map(taskRows.map((t) => [t.taskId, t.project]));
  return (taskId) => {
    if (typeof taskId !== 'string') return null;
    const hit = exact.get(taskId);
    if (hit !== undefined) return hit;
    return taskRows.find((t) => taskIdsMatch(taskId, t.taskId))?.project ?? null;
  };
}

/**
 * What an epic's plan file says it belongs to, for the tasks whose own events
 * never said.
 *
 * D-246. taskEvents.ts's planScoped() stamps the project onto `task-added` at
 * write time (D-232), which repairs every run started after it and nothing
 * that came before -- and the real logs are mostly "before": not one of
 * dogfood-demo-rpg-1's thirteen task-added events carries a project. Those
 * rows fold to project NULL, projectResolver() hands the NULL down to every
 * dispatch and error under them, and db/queries.ts's projectOf() resolves the
 * lot to the DEFAULT project: the whole demo-rpg epic filed under
 * black-smith, its own board empty. That history cannot be repaired from the
 * log, because the log never held the answer. The plan file did, all along.
 *
 * Same source and same precedence as the write side -- what the envelope
 * declared, else what the plan does -- so a rebuild and a fresh run agree.
 * The plan is a fallback and never an override: an epic re-homed after its
 * plan was written keeps where its events put it.
 *
 * Tolerant in exactly the way projectMilestones() is tolerant of roadmap.md:
 * a missing dir, a missing file, a plan with no project, or one that will not
 * parse all mean "no answer", which leaves the row as it was. An unreadable
 * spec must not cost the operator the rest of the projection.
 */
function planProjectResolver(
  specsDir: string | undefined,
): (epicId: string | null) => string | null {
  const cache = new Map<string, string | null>();
  return (epicId) => {
    // A task with no epic has no plan file to ask. Both spellings of that
    // reach here: NULL from a `task-added` that named no epic, and '' from
    // the phantom rows a bare task id folds into.
    if (epicId === null || epicId === '') return null;
    const cached = cache.get(epicId);
    if (cached !== undefined) return cached;
    let project: string | null = null;
    try {
      const version = latestPlanVersion(epicId, { specsDir });
      if (version !== null) project = loadPlan(epicId, version, { specsDir }).project ?? null;
    } catch (err) {
      console.error(
        `db/projector.ts planProjectResolver(): plan file for "${epicId}" ` +
          `failed to load, leaving its project unresolved: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    cache.set(epicId, project);
    return project;
  };
}

/**
 * foldTasks() with D-246's plan-file backfill applied.
 *
 * Both folds of the task list go through here, because both answer the same
 * question and must not answer it differently: projectSession() derives the
 * tasks, epics, dispatches, artifacts and errors rows from one, and
 * projectFindings() folds the same events again for findings.project. Split
 * the backfill across only one of them and a single task reads as demo-rpg's
 * on the board and black-smith's on the errors page.
 */
function foldTasksWithPlanProject(events: readonly StoredEvent[], opts: DbOpts): TaskFoldRow[] {
  const projectFromPlan = planProjectResolver(opts.specsDir);
  return foldTasks([...events], { specsDir: opts.specsDir }).map((t) =>
    t.project === null ? { ...t, project: projectFromPlan(t.epicId) } : t,
  );
}

export function projectSession(
  handle: DbHandle,
  sessionId: string,
  events: StoredEvent[],
  opts: DbOpts = {},
): void {
  handle.db.transaction((txDb) => {
    clearSession(txDb, sessionId);

    if (events.length === 0) return;

    // Folded once, up here: the rows below inherit their project from it, and
    // the tasks table is written from the very same array further down. The
    // plan-file backfill lands here for that reason -- one insertion point,
    // and the tasks table, the epics table and every child row come with it.
    const taskRows = foldTasksWithPlanProject(events, opts);
    const projectForTask = projectResolver(taskRows);
    const projectForEpic = new Map(
      taskRows.flatMap((t) => (t.project === null ? [] : [[t.epicId, t.project] as const])),
    );
    /**
     * The project a row inherits from whatever its ref names, task or epic.
     *
     * Half the refs a real run writes name an epic and no task at all --
     * `<epic>/integration`, `<epic>/plan-v2`, `<epic>/epic`, or the bare epic
     * id -- and foldTasks() deliberately refuses to mint a task row for any of
     * them (D-250), so the task leg alone can never answer. Resolving through
     * it alone left those rows NULL, and queries.ts's projectOf() reads a NULL
     * back as the DEFAULT project, not as "unscoped": every one of them was
     * filed under black-smith, including the one stop-the-line error in the
     * shipped logs, which demo-rpg had raised (D-252).
     *
     * epicOfTaskId() answers for a qualified ref; `?? ref` covers the bare
     * spelling. It cannot mis-file: the map is keyed by epic id, so a bare
     * TASK id that names no epic simply misses and stays null.
     */
    const projectForRef = (ref: string | null | undefined): string | null =>
      typeof ref !== 'string'
        ? null
        : (projectForTask(ref) ?? projectForEpic.get(epicOfTaskId(ref) ?? ref) ?? null);

    const first = events[0] as StoredEvent;
    const last = events[events.length - 1] as StoredEvent;
    txDb
      .insert(schema.sessions)
      .values({
        sessionId,
        startedAt: first.record.ts,
        lastEventAt: last.record.ts,
        eventCount: events.length,
      })
      .run();

    for (const { event_id, record } of events) {
      // The JSONL is the archive; every table below is a projection of it, and
      // `project` here is already derived rather than copied. The task id gets
      // the same treatment: read from both levels (D-245), or a hand-written
      // dispatch lands in events_raw and dispatches with a null task and
      // answers no task-scoped query the operator can type.
      const eventTask = eventTaskId(record);
      txDb
        .insert(schema.eventsRaw)
        .values({
          eventId: event_id,
          sessionId: record.session_id,
          ts: record.ts,
          eventType: record.event_type,
          taskId: eventTask,
          agentId: record.agent_id ?? null,
          planVersion: record.plan_version,
          causalParent: record.causal_parent,
          payload: JSON.stringify(record.payload),
          project: record.project ?? projectForRef(eventTask),
          actor: record.actor,
        })
        .run();

      if (record.event_type === 'user_prompt') {
        const p = record.payload as UserPromptPayload;
        txDb
          .insert(schema.prompts)
          .values({
            eventId: event_id,
            sessionId: record.session_id,
            ts: record.ts,
            prompt: p.prompt ?? p.text ?? '',
            causalParent: record.causal_parent,
          })
          .run();
        continue;
      }

      if (record.event_type === 'dispatch_decision') {
        const p = record.payload as DispatchPayload;
        if (!p.agent_role || !p.provider || !p.model_tier) continue;
        txDb
          .insert(schema.dispatches)
          .values({
            eventId: event_id,
            sessionId: record.session_id,
            ts: record.ts,
            taskId: eventTask,
            agentId: record.agent_id ?? null,
            agentRole: p.agent_role,
            provider: p.provider,
            modelTier: p.model_tier,
            specRef: p.spec_ref ?? null,
            reason: p.reason ?? null,
            parentPromptId: p.parent_prompt_id ?? null,
            causalParent: record.causal_parent,
            project: record.project ?? projectForRef(eventTask),
          })
          .run();
        continue;
      }

      if (record.event_type === 'edge-recorded' && record.edge && eventTask) {
        const p = record.payload as { depends_on?: string };
        if (!p.depends_on) continue;
        txDb
          .insert(schema.edges)
          .values({
            eventId: event_id,
            sessionId: record.session_id,
            ts: record.ts,
            taskId: eventTask,
            dependsOn: p.depends_on,
            edgeType: record.edge.edge_type,
            edgeProvenance: record.edge.edge_provenance,
          })
          .run();
        continue;
      }

      if (record.event_type === 'error-logged') {
        const p = record.payload as ErrorPayload;
        if (!p.error || !p.severity) continue;
        const { group, cls } = splitErrorClass(p.error);
        txDb
          .insert(schema.errors)
          .values({
            eventId: event_id,
            sessionId: record.session_id,
            ts: record.ts,
            taskRef: p.task_ref ?? eventTask,
            agentId: record.agent_id ?? null,
            errorGroup: group,
            errorClass: cls,
            severity: p.severity,
            detail: p.detail ?? null,
            project: record.project ?? projectForRef(p.task_ref ?? eventTask),
          })
          .run();
        continue;
      }

      if (record.event_type === 'task-result-recorded') {
        const p = record.payload as ResultPayload;
        // Envelope first, like every other reader — this line used to prefer
        // the payload, the one place in the repo that resolved the pair the
        // other way round (D-245).
        const taskId = eventTask;
        if (!taskId) continue;
        (p.artifacts ?? []).forEach((artifact, index) => {
          if (!artifact.type || !artifact.path) return;
          txDb
            .insert(schema.artifacts)
            .values({
              id: `${event_id}#${index}`,
              sessionId: record.session_id,
              taskId,
              eventId: event_id,
              ts: record.ts,
              type: artifact.type as string,
              path: artifact.path as string,
              description: artifact.description ?? null,
            })
            .run();
        });
        continue;
      }

      if (record.event_type === 'waiver-granted' || record.event_type === 'waiver-denied') {
        const p = record.payload as WaiverPayload;
        if (!p.fingerprint) continue;
        txDb
          .insert(schema.waivers)
          .values({
            eventId: event_id,
            sessionId: record.session_id,
            ts: record.ts,
            fingerprint: p.fingerprint,
            decision: record.event_type === 'waiver-granted' ? 'granted' : 'denied',
            operatorNote: p.operator_note ?? null,
          })
          .run();
      }
    }

    for (const task of taskRows) {
      txDb
        .insert(schema.tasks)
        .values({
          taskId: task.taskId,
          sessionId: task.sessionId,
          epicId: task.epicId,
          caseTag: task.caseTag,
          origin: task.origin,
          taskStatus: task.taskStatus,
          planVersion: task.planVersion,
          objective: task.objective,
          claims: task.claims ? JSON.stringify(task.claims) : null,
          budgetTokens: task.budgetTokens,
          branch: task.branch,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          project: task.project,
        })
        .run();
    }

    for (const epic of foldEpics(events)) {
      txDb
        .insert(schema.epics)
        .values({
          epicId: epic.epicId,
          sessionId: epic.sessionId,
          epicStatus: epic.epicStatus,
          closedBy: epic.closedBy,
          machineVerdict: epic.machineVerdict,
          machineReason: epic.machineReason,
          overrideRationale: epic.overrideRationale,
          blockers: JSON.stringify(epic.blockers),
          closedAt: epic.closedAt,
          eventId: epic.eventId,
          // An epic-closed names an epic and no task, and epic.ts writes it
          // without a plan in hand -- its own tasks are the only thing that
          // can place it (D-233).
          project: epic.project ?? projectForEpic.get(epic.epicId) ?? null,
        })
        .run();
    }

    for (const agent of foldAgents(events)) {
      txDb
        .insert(schema.agents)
        .values({
          id: agent.id,
          sessionId: agent.sessionId,
          taskId: agent.taskId,
          epicId: agent.epicId,
          agentId: agent.agentId,
          agentRole: agent.agentRole,
          round: agent.round,
          provider: agent.provider,
          modelTier: agent.modelTier,
          dispatchedAt: agent.dispatchedAt,
          terminalEventId: agent.terminalEventId,
          terminalAt: agent.terminalAt,
          terminalType: agent.terminalType,
          status: agent.status,
        })
        .run();
    }

    // `lessons` is not written here — see projectLessons() (D-199).
  });
}

/**
 * Fully replace the lessons table from EVERY session's log at once, in one
 * causal order (mergeSessionLogs). Not session-scoped, the same shape as
 * projectMilestones() above, and for a reason the rest of this file's
 * per-session partition cannot express.
 *
 * D-199. A lesson is raised in one session and approved in another BY DESIGN:
 * lessons.ts's transitionLesson() reads the lineage on purpose, because
 * "approving from a continuation the candidate the parent session raised is
 * the ordinary shape of a long epic". Folding one session at a time handed
 * foldLessons() a `lesson-status-changed` for a lesson_id it had no row for,
 * and the fold correctly continued — the truncation happened before it, in
 * what it was given. The projection kept saying `candidate`, which is what
 * lessonsPage() buckets on and what `smith lessons compile` writes
 * factory/policies/lessons.md from, so the approval reached neither the
 * operator's screen nor an agent's prompt block.
 *
 * The lineage is not enough here. Session B's lineage reaches back to A, but
 * A's never reaches forward to B, so a fix that folds each session's lineage
 * still loses the approval the moment A is projected last — and
 * listSessionIds() sorts by filename, which is nothing causal. The table's
 * primary key is the lesson id, not (session, lesson): one global key, one
 * global fold.
 *
 * The row still carries the RAISING session's id, so `lessonsPage({ sessionId })`
 * keeps meaning "lessons raised here" and an approval never moves a lesson.
 *
 * One deliberate consequence: two sessions raising the same lesson_id used to
 * abort a rebuild on the table's UNIQUE constraint and now resolve last-raise-
 * wins, because that is already what foldLessons() does with two raises inside
 * one session. The rule is now the same on both sides of a session boundary
 * instead of quiet within one and fatal across.
 */
function projectLessons(handle: DbHandle, events: readonly StoredEvent[]): void {
  handle.db.transaction((txDb) => {
    txDb.delete(schema.lessons).run();
    for (const lesson of foldLessons(events)) {
      txDb
        .insert(schema.lessons)
        .values({
          lessonId: lesson.lessonId,
          sessionId: lesson.sessionId,
          lessonType: lesson.lessonType,
          lessonLevel: lesson.lessonLevel,
          lessonStatus: lesson.lessonStatus,
          lessonScope: lesson.lessonScope,
          statement: lesson.statement,
          validFrom: lesson.validFrom,
          supersededBy: lesson.supersededBy,
          invalidatedByEventId: lesson.invalidatedByEventId,
          provenanceEventIds: JSON.stringify(lesson.provenanceEventIds),
          evidence: lesson.evidence,
          timesPrevented: lesson.timesPrevented,
          findingCategory: lesson.findingCategory,
          claimPath: lesson.claimPath,
          agentRole: lesson.agentRole,
          caseType: lesson.caseType,
        })
        .run();
    }
  });
}

/**
 * finding_id -> (raised ts, most-recent-transition ts, the raising event's id),
 * read straight off the log. The event id is what a quarantine report hands the
 * operator to grep for (D-141) — a finding id alone does not locate the record
 * in an append-only log.
 */
interface FindingStamp {
  raisedAt: string;
  updatedAt: string;
  raisedByEventId: string;
  /**
   * The session the `finding-raised` event was written in — which is the row's
   * owner, not the session that last transitioned it (D-200).
   */
  sessionId: string;
}

function findingTimestamps(events: readonly StoredEvent[]): Map<string, FindingStamp> {
  const stamps = new Map<string, FindingStamp>();
  for (const { event_id, record } of events) {
    if (record.event_type === 'finding-raised') {
      const findingId = (record.payload as { finding_id?: string }).finding_id;
      if (findingId)
        stamps.set(findingId, {
          raisedAt: record.ts,
          updatedAt: record.ts,
          raisedByEventId: event_id,
          sessionId: record.session_id,
        });
    } else if (record.event_type === 'finding-transitioned') {
      const findingId = (record.payload as { finding_id?: string }).finding_id;
      const existing = findingId ? stamps.get(findingId) : undefined;
      if (findingId && existing) stamps.set(findingId, { ...existing, updatedAt: record.ts });
    }
  }
  return stamps;
}

/**
 * Fully replace the findings table from EVERY session's log at once, in one
 * causal order (mergeSessionLogs) — the same shape as projectLessons() above,
 * and for the same reason.
 *
 * D-200. A finding is raised in one session and closed in another BY DESIGN:
 * findings.ts's transition() reads the lineage on purpose, because "a finding
 * raised in the first session of a cross-session epic is otherwise not FOUND
 * from the second" (D-119), and it appends the `finding-transitioned` event to
 * the session it was called in. Folding one session at a time handed
 * foldFindingsDetailed() a transition for a finding_id it had no row for, and
 * the fold correctly continued — the truncation happened before it, in what it
 * was given. The projection kept the pre-transition status, which is what the
 * Kanban's worst-open-severity chip reads, so a refuted S2 kept flagging a task
 * nobody needed to look at and the board contradicted `smith findings list`.
 *
 * The lineage is not enough here, exactly as in projectLessons(): the
 * continuation's lineage reaches back to its parent, but the parent's never
 * reaches forward, so folding each session's lineage still loses the
 * transition whenever the parent is projected last — and listSessionIds()
 * sorts by filename, which is nothing causal. The table's primary key is the
 * finding id, not (session, finding): one global key, one global fold.
 *
 * The row still carries the RAISING session's id (the stamp's, no longer the
 * caller's), so a findings query scoped to a session keeps meaning "findings
 * raised here" and closing one never moves it.
 *
 * One deliberate consequence, again as in projectLessons(): two sessions
 * raising the same finding_id used to abort a rebuild on the table's primary
 * key and now resolve last-raise-wins, because that is already what
 * foldFindingsDetailed() does with two raises inside one session.
 *
 * Findings are folded via findings.ts's own fold — reused, not duplicated.
 *
 * Returns what it could not store. Three disjoint reasons, reported the same
 * way (D-141): the fold's own quarantine (D-135 — a payload the fold cannot
 * even dereference), records the fold returns happily but that cannot fill one
 * of the table's `notNull()` columns, and (since the fold is now global) a
 * finding whose raise is not in the projected logs at all, which has no
 * session to be owned by. The second kind used to abort the entire rebuild on
 * the first offender.
 */
function projectFindings(
  handle: DbHandle,
  events: readonly StoredEvent[],
  opts: DbOpts,
): SkippedFindingRecord[] {
  const { findings, skipped } = foldFindingsDetailed([...events]);
  const stamps = findingTimestamps(events);
  // A finding has no `project` of its own on the wire (findings.ts's raiseFinding()
  // predates Phase 6b) — derive it from its owning task's project, the same fold
  // projectSession() computes, so the value always matches tasks.project exactly.
  // Same helper as projectSession() for exactly that reason: the plan-file
  // backfill (D-246) has to reach both folds or the invariant is a lie.
  const taskRows = foldTasksWithPlanProject(events, opts);
  // projectResolver and not a Map lookup, for the reason its own docblock
  // gives: the log spells one task both `epic/task-1` and `task-1`, and a
  // spelling is not an identity (D-130/D-143). D-233 already routed every
  // other child row through it and named findings as following the same rule
  // — findings were the one table that did not (D-247).
  const projectForTask = projectResolver(taskRows);
  // And an epic-level fallback, because the merge queue raises findings
  // against `<epic>/integration`, a pseudo-task that never gets a task row:
  // no task lookup can ever answer for it, its epic always can, and the row
  // already stores that epic. On the shipped logs this is 37 of 56 findings.
  const projectForEpic = new Map(
    taskRows.flatMap((t) => (t.project === null ? [] : [[t.epicId, t.project] as const])),
  );
  const projectFromPlan = planProjectResolver(opts.specsDir);
  const rows: (typeof schema.findings.$inferInsert)[] = [];
  for (const finding of findings) {
    const stamp = stamps.get(finding.finding_id);
    const missing = missingProjectionFields(finding);
    if (missing.length > 0) {
      // Held back rather than inserted-with-nulls: a row that lies about what
      // it knows is worse than a row that is missing, and worse than the crash
      // this replaces only in that it is quiet. So it is named instead.
      skipped.push({
        event_id: stamp?.raisedByEventId ?? '?',
        finding_id: finding.finding_id,
        reason: `finding cannot be projected into the findings table: missing required string field(s): ${missing.join(', ')}`,
      });
      continue;
    }
    if (stamp === undefined) {
      // Unreachable through the fold, which only returns findings it saw a
      // `finding-raised` for — named rather than defaulted because the row's
      // owning session would otherwise be a guess, and `session_id` is the
      // column every scoped findings query filters on.
      skipped.push({
        event_id: '?',
        finding_id: finding.finding_id,
        reason:
          'finding cannot be projected into the findings table: no finding-raised event in the projected logs',
      });
      continue;
    }
    // The carried field first; the task id's prefix only as back-compat
    // for records raised before the field existed (D-49/P9-10).
    const findingEpicId = finding.epic_id ?? epicOfTaskId(finding.task_id);
    rows.push({
      findingId: finding.finding_id,
      sessionId: stamp.sessionId,
      taskId: finding.task_id,
      epicId: findingEpicId,
      project:
        projectForTask(finding.task_id) ??
        projectForEpic.get(findingEpicId) ??
        projectFromPlan(findingEpicId),
      fingerprint: finding.fingerprint,
      findingCategory: finding.finding_category,
      severity: finding.severity,
      findingStatus: finding.finding_status,
      summary: finding.summary,
      foundBy: finding.found_by,
      foundByProvider: finding.found_by_provider ?? null,
      verifiedBy: finding.verified_by ?? null,
      verifiedByProvider: finding.verified_by_provider ?? null,
      sameMistakeOfLessonId: finding.same_mistake_of_lesson_id ?? null,
      waiverId: finding.waiver_id ?? null,
      raisedAt: stamp.raisedAt,
      updatedAt: stamp.updatedAt,
    });
  }
  handle.db.transaction((txDb) => {
    txDb.delete(schema.findings).run();
    for (const row of rows) txDb.insert(schema.findings).values(row).run();
  });
  return skipped;
}

/**
 * Every named session's log, read once (D-199 — projectLessons), oldest
 * session first.
 *
 * The order is part of the contract, not tidiness. mergeSessionLogs breaks a
 * tie on `ts` by array position — for a lineage that is right, because
 * walkLineage hands it the chain root-first, but a SET of sessions has no
 * such order, and two events written in the same millisecond in two sessions
 * are exactly the case a global fold has to settle the same way every time.
 * "The session that started earlier" is the one causal reading available;
 * session id settles two logs that start in the same millisecond, so the
 * order is total and independent of how the caller listed them.
 */
async function readAllSessionLogs(
  sessionIds: readonly string[],
  stateDir: string,
): Promise<SessionLog[]> {
  const logs: SessionLog[] = [];
  for (const sessionId of sessionIds) {
    logs.push({ sessionId, events: await readEvents(sessionId, { stateDir }) });
  }
  logs.sort((a, b) => {
    const aStart = a.events[0]?.record.ts ?? '';
    const bStart = b.events[0]?.record.ts ?? '';
    if (aStart !== bStart) return aStart < bStart ? -1 : 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return logs;
}

export interface RebuildResult {
  sessionsProcessed: number;
  eventsApplied: number;
  /**
   * Findings that could not become rows, each named with the event that raised
   * it (D-141). ALWAYS present, `[]` when there were none: a caller reading the
   * counts above is reading a projection that is short by exactly this many,
   * and an absent field reads identically to a complete rebuild.
   *
   * Since D-200 the findings fold is global, so `apply()` reports every
   * session's quarantine rather than the applied session's — it rewrote the
   * whole table, and a report narrower than the write would understate what is
   * missing from it.
   */
  skippedFindings: SkippedFindingRecord[];
}

/**
 * Full rebuild: drop every table's rows, then replay every session (or the
 * given subset) from its complete event log. Idempotent by construction —
 * clearAll() + a deterministic fold of the same log always yields the same
 * rows.
 */
export async function rebuild(
  dbPath: string = STATE_DB_PATH,
  sessions: readonly string[] | 'all' = 'all',
  opts: DbOpts = {},
): Promise<RebuildResult> {
  const handle = openDb(dbPath, opts);
  try {
    clearAll(handle);
    const stateDir = opts.stateDir ?? STATE_EVENTS_DIR;
    const sessionIds = sessions === 'all' ? listSessionIds(stateDir) : [...sessions];

    // Read each log once: the per-session projection consumes them one at a
    // time, projectLessons() and projectFindings() need them all at once.
    const logs = await readAllSessionLogs(sessionIds, stateDir);

    let eventsApplied = 0;
    for (const { sessionId, events } of logs) {
      projectSession(handle, sessionId, events, opts);
      eventsApplied += events.length;
    }
    const merged = mergeSessionLogs(logs);
    const skippedFindings = projectFindings(handle, merged, opts);
    projectLessons(handle, merged);
    projectMilestones(handle, opts);
    return { sessionsProcessed: sessionIds.length, eventsApplied, skippedFindings };
  } finally {
    handle.sqlite.close();
  }
}

/**
 * Incremental refresh for one session: re-folds ITS current event log and
 * replaces only its rows, leaving every other session's projection intact.
 * Safe to call repeatedly while a session is still running (tailing).
 *
 * The three tables that are not session-scoped are rewritten whole on every
 * call: `milestones` from roadmap.md, and — from every session's log, which is
 * why this reads more than the one session it re-folds — `lessons` (D-199) and
 * `findings` (D-200).
 */
export async function apply(
  dbPath: string = STATE_DB_PATH,
  sessionId: string,
  opts: DbOpts = {},
): Promise<RebuildResult> {
  const handle = openDb(dbPath, opts);
  try {
    const stateDir = opts.stateDir ?? STATE_EVENTS_DIR;
    // A session whose first event has not landed yet has no file to list, and
    // readEvents answers `[]` for a log that does not exist (P9-28) — so
    // naming it anyway costs an empty read and keeps it in the global folds
    // below, which would otherwise drop the very session being applied.
    const listed = listSessionIds(stateDir);
    const logs = await readAllSessionLogs(
      listed.includes(sessionId) ? listed : [...listed, sessionId],
      stateDir,
    );
    const events = logs.find((l) => l.sessionId === sessionId)?.events ?? [];
    projectSession(handle, sessionId, events, opts);
    const merged = mergeSessionLogs(logs);
    const skippedFindings = projectFindings(handle, merged, opts);
    projectLessons(handle, merged);
    projectMilestones(handle, opts);
    return { sessionsProcessed: 1, eventsApplied: events.length, skippedFindings };
  } finally {
    handle.sqlite.close();
  }
}

export { detectStaleAgents as detectStale, type StaleAgent };
