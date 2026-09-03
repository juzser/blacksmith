import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { SmithError } from './errors.js';
import { STATE_EVENTS_DIR } from './paths.js';
import { type CompiledSchemaSet, compileSchemas, validateRecord } from './schemas.js';
import { taskIdsMatch } from './taskId.js';
import {
  loadTaxonomy,
  type Taxonomy,
  validateRequiredDimensions,
  validateTag,
} from './taxonomy.js';

export class EventError extends SmithError {}

export interface EventEdge {
  edge_type: string;
  edge_provenance: string;
}

export interface EventInput {
  session_id: string;
  actor: string;
  event_type: string;
  task_id?: string;
  agent_id?: string;
  plan_version: number;
  causal_parent: string | null;
  payload: Record<string, unknown>;
  edge?: EventEdge;
  /**
   * Phase 6b (architecture §8 note): a PLAIN STRING project identifier, NOT
   * a closed taxonomy.yml vocabulary value — projects come and go far more
   * often than any §8 dimension, so gating them behind a taxonomy PR would
   * defeat the point of a multi-project hub. Optional: absent events (and
   * every event logged before Phase 6b) are treated as the default project
   * 'black-smith' by db/queries.ts's read helpers, never by this writer —
   * the log stays a faithful record of what was actually stamped.
   */
  project?: string;
}

export interface EventRecord extends EventInput {
  ts: string;
}

export interface StoredEvent {
  event_id: string;
  record: EventRecord;
}

export interface EventOpts {
  stateDir?: string;
  taxonomy?: Taxonomy;
  schemas?: CompiledSchemaSet;
}

// Root events (session_id's first event) are the only ones allowed a null
// causal_parent (architecture §7).
/**
 * The one event type a log may open with, and the only one allowed to name a
 * `causal_parent` in another session's log. Exported since D-263 because
 * db/queries.ts walks the same edge off the projection and a second copy of
 * the literal is a second thing to keep in step.
 */
export const ROOT_EVENT_TYPE = 'session-start';

export interface ParsedEventId {
  sessionId: string;
  index: number;
}

/**
 * Split an event id into the session that owns it and its line index.
 *
 * Event ids have always been `<session-id>#<index>` — that shape is what makes
 * a cross-session reference resolvable at all (P9-7): given only the id, a
 * reader knows which log file to open. Splitting on the LAST `#` keeps a
 * session id that happens to contain one from silently resolving to the wrong
 * session.
 */
export function parseEventId(eventId: string): ParsedEventId {
  // Typed as a string and reached with whatever the writer sent. `smith event
  // append` JSON.parses its argument and hands it straight over, and
  // readEvents() takes a `causal_parent` off a log line that nothing retypes
  // on the way in. A number is the likeliest of those to be written on
  // purpose -- an event id is `<session>#<index>` and the index is the half
  // that is memorable -- and it used to reach `.lastIndexOf` and come back as
  // a bare TypeError with no `code`, the D-135 shape.
  if (typeof eventId !== 'string') {
    throw new EventError(
      'events.malformed-event-id',
      `${JSON.stringify(eventId) ?? String(eventId)} (${typeof eventId}) is not an event id. The form is <session-id>#<index>, e.g. dogfood-envkit-1#42.`,
      { event_id: eventId },
    );
  }
  const cut = eventId.lastIndexOf('#');
  const sessionId = cut === -1 ? '' : eventId.slice(0, cut);
  const rawIndex = eventId.slice(cut + 1);
  // Number.parseInt would accept "3abc"; an event id is exact or it is a typo.
  const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : Number.NaN;
  if (cut === -1 || sessionId.length === 0 || Number.isNaN(index)) {
    throw new EventError(
      'events.malformed-event-id',
      `"${eventId}" is not an event id. The form is <session-id>#<index>, e.g. dogfood-envkit-1#42.`,
      { event_id: eventId },
    );
  }
  return { sessionId, index };
}

/**
 * Where an event sits in the order the log actually wrote it.
 *
 * An event id is `<session-id>#<index>` and the index is the event's line in
 * its session's log, so within a session this *is* the order rather than a
 * proxy for it. Across sessions the logs are separate files that nothing
 * interleaves, so the session id is here to make the answer the same on every
 * call, not because one session precedes another.
 *
 * Total where parseEventId throws, and the fallback is unreachable by
 * construction — every id this sees came out of readEvents() or a projection
 * of it, and readEvents builds each one as `<session>#<index>`. It is here
 * because the readers on top of this are a dashboard `/api/pulse` polls every
 * 5s and two audits the operator runs on a whole log, and an id that somehow
 * would not parse should sort somewhere rather than take the caller down with
 * it. Where it lands is deliberately modest: an event whose place in the log
 * is unreadable does not get to win a tie on it.
 */
function logOrderOf(eventId: string): { sessionId: string; index: number } {
  try {
    return parseEventId(eventId);
  } catch {
    return { sessionId: eventId, index: -1 };
  }
}

/**
 * The order the log wrote two events in: negative when `a` came first,
 * positive when `b` did, zero only for the same event.
 *
 * `ts` is stamped at millisecond resolution (appendEvent, just below), so a
 * burst of appends routinely shares one: the test fixture's own last two
 * events tie in roughly one build in three, and a gate outcome and the retry
 * dispatched in answer to it are written back to back. Nothing else in the
 * record carries the sequence — `events_raw` has no such column and the JSONL
 * line has no such field — so on a tie `ts` has nothing left to say, and
 * nothing downstream of it does either. A `>` between two tied rows is not a
 * decision, it is whichever the scan reached first; `ORDER BY ts` is the same
 * non-answer spelled in SQL, since SQLite promises nothing about tied rows and
 * hands them back in physical order, which changes the moment a row is
 * rewritten; and a JS `.sort()` whose comparator returns 0 throughout is
 * stable, so it keeps that same scan order and passes it off as chronology.
 *
 * The log index behind the event id is what actually decides, and it has to be
 * read as a number: ordered as text — which is what `ORDER BY ts, event_id`
 * does — `#9` sorts after `#10`, so the tiebreaker inverts as soon as a
 * session's log passes ten events.
 *
 * It lives beside parseEventId rather than in any one reader because more than
 * one of them asks this question: the dashboard queries fold and sort rows,
 * escalation.ts walks a task's rounds looking for the dispatch on either side
 * of one. Every ordering a reader would call chronological routes through
 * here, so that no two of them can answer the same question about the same two
 * events differently — which is exactly what happened when the callers spelled
 * the comparison themselves, with opposite operators.
 */
export function compareLogOrder(
  a: { ts: string; eventId: string },
  b: { ts: string; eventId: string },
): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const left = logOrderOf(a.eventId);
  const right = logOrderOf(b.eventId);
  if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
  return left.index - right.index;
}

/**
 * Whether `a` is the later of two events — the one a reader means by "what
 * just happened".
 */
export function isLaterEvent(
  a: { ts: string; eventId: string },
  b: { ts: string; eventId: string },
): boolean {
  return compareLogOrder(a, b) > 0;
}

/**
 * The task an event names, read from both places one can be written.
 *
 * D-245. The envelope's `task_id` is the field every projector keys on, and
 * every machine producer stamps it. The payload copy is what a hand-written
 * dispatch carries: `.claude/skills/bs/SKILL.md` lists the dispatch payload's
 * four required fields and never says where the task id goes, so the operator
 * writes it in beside them. 15 of 19 dispatches in dogfood-envkit-1 and 14 of
 * 82 in dogfood-demo-rpg-1 name their task only there.
 *
 * Reading one level is not a partial answer, it is a wrong one. An agent whose
 * dispatch names no task cannot be reached by that task's terminal event, so
 * it reads "no task assigned" until the epic verdict sweeps it `abandoned`,
 * and the task itself never leaves `todo` on the board. budgetAlarm.ts (D-172)
 * and dispatchAudit.ts each found this and fixed it behind a private copy of
 * this function; the rule belongs to the module that owns the record shape, so
 * every reader of that shape can reach it -- the move D-143 made for
 * `taskIdsMatch`.
 *
 * The envelope wins when both are set: it is the indexed column, and a payload
 * that disagrees with it is a producer bug, not a second opinion. An empty
 * string names no task at either level (D-244), and neither does a non-string
 * -- every field here has been through a JSONL round-trip, where TypeScript
 * stopped watching (D-135).
 */
export function eventTaskId(record: EventRecord): string | null {
  if (typeof record.task_id === 'string' && record.task_id.length > 0) return record.task_id;
  const fromPayload = (record.payload as Record<string, unknown> | undefined)?.task_id;
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : null;
}

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

function resolveTaxonomyAndSchemas(opts: EventOpts): {
  taxonomy: Taxonomy;
  schemas: CompiledSchemaSet;
} {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(cachedTaxonomy);
  const taxonomy = opts.taxonomy ?? cachedTaxonomy;
  const schemas = opts.schemas ?? cachedSchemas;
  return { taxonomy, schemas };
}

/**
 * D-197: a session id is a file name before it is anything else.
 *
 * `logPath` interpolates the id straight into a path and `appendEvent` mints
 * `<id>#<index>` from it, so an id that is not one path segment breaks both
 * ends at once and neither end said so. `''` produced the id `#0`, which
 * parseEventId refuses — the session's own second event was impossible,
 * because causal_parent could not name its first. `'a/b/c'` and `'../x'`
 * appended happily (appendEventLocked mkdirs the parent, recursive), and read
 * back through the same id, so nothing local looked wrong: what breaks is
 * every reader that enumerates the directory instead of naming the id.
 * projector.ts's listSessionIds and the UI server's refresher both readdir
 * `state/events` non-recursively and keep entries ending in `.jsonl`, so a log
 * one directory down is not a session as far as the database and the
 * dashboard are concerned, and no row, no warning and no count records that a
 * log was skipped.
 *
 * The check is structural, not a charset: exactly the ids that would land
 * outside `<dir>/<id>.jsonl` are refused, and nothing else. `#` in particular
 * stays legal — parseEventId splits on the LAST one deliberately, and a `#`
 * cannot move a file.
 */
function requireSessionIdShape(sessionId: string): void {
  if (sessionId.length > 0 && sessionId !== '.' && sessionId !== '..') {
    if (path.basename(sessionId) === sessionId) return;
  }
  throw new EventError(
    'events.malformed-session-id',
    `"${sessionId}" is not a session id. A session id names one event log file, so it must be a single non-empty path segment — no "/", and not "." or "..".`,
    { session_id: sessionId },
  );
}

function logPath(sessionId: string, opts: EventOpts): string {
  requireSessionIdShape(sessionId);
  const dir = opts.stateDir ?? STATE_EVENTS_DIR;
  return path.join(dir, `${sessionId}.jsonl`);
}

async function readEventsAtPath(filePath: string, sessionId: string): Promise<StoredEvent[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, 'utf8');
  const lines = text
    .trimEnd()
    .split('\n')
    .filter((line) => line.length > 0);
  return lines.map((line, index) => ({
    event_id: `${sessionId}#${index}`,
    record: JSON.parse(line) as EventRecord,
  }));
}

/**
 * Per-log serialization *inside one process*: concurrent appendEvent calls on
 * the same session log must not derive the same line-count index or read a
 * stale event list for causal_parent lookup (TOCTOU). One promise chain per
 * resolved file path.
 *
 * This is the fast path, not the guarantee — see `withLogLock` below for the
 * part that holds across processes. Keeping both matters: the queue means the
 * common case of two appends in one process never touches the filesystem lock
 * at all, so nothing polls when nothing is contended.
 */
const fileQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // Store a rejection-swallowed continuation so one failed append never
  // permanently jams the queue for the next caller; the real outcome for
  // *this* call is still `next`, returned below.
  fileQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Cross-process serialization for one session log.
 *
 * `fileQueues` orders appends within a Node process, and for a long time that
 * was the whole story: queue, gates and CLI ran as one process per factory
 * session, so one promise chain was the only ordering anyone needed. Running a
 * wave in parallel ends that assumption. An orchestrator that dispatches five
 * tasks and records five events in five `smith` invocations has five
 * processes, five queues, and five independent readers of `existing.length` —
 * and they all read the same number.
 *
 * What that costs is subtle enough to be worth naming. The log survives: ids
 * are derived from line position at read time (`readEventsAtPath`), so five
 * concurrent appends leave five well-formed lines and the file reads back
 * correctly. It is the id handed *back* to each caller that is wrong, and the
 * caller feeds that id to the next command as `--causal-parent`. The wrong
 * parent then names an event that genuinely exists, so `validateCausalParent`
 * accepts it and the lineage is quietly mis-shaped. A wrong parent that
 * validates is worse than one that fails.
 *
 * Hence a lock file beside the log. `open(..., 'wx')` is atomic on every
 * filesystem this runs on: exactly one process creates it, everyone else gets
 * EEXIST and waits. The whole read-validate-append sequence happens inside it,
 * which is what makes the returned index true — it counts the lines another
 * process wrote before us, because it is taken after that process let go.
 *
 * The lock is named `<session>.jsonl.lock`, which `listSessionIds` does not
 * see: it selects on `.jsonl` as the suffix, and this is not one.
 */
const LOCK_POLL_MS = 12;

/**
 * A lock older than this belonged to a process that died holding it. The
 * window is generous on purpose: breaking a live lock reintroduces exactly the
 * race the lock exists to remove, while waiting too long only ever costs a
 * stalled append that an operator can see and retry.
 */
const LOCK_STALE_MS = 30_000;

/** How long to wait for a peer before calling the log jammed rather than busy. */
const LOCK_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Age of the lock file in milliseconds, or `undefined` if it went away while
 * we were asking — which is not an error but the good outcome: the holder
 * finished, and the next acquire attempt is the one that succeeds.
 */
async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function withLogLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await lockAgeMs(lockPath);
      if (age !== undefined && age > LOCK_STALE_MS) {
        // Best-effort: if a peer breaks it first, our next `wx` simply wins or
        // waits again. `force` keeps that harmless.
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new EventError(
          'events.log-busy',
          `Another process has held the log for ${filePath} longer than ${LOCK_TIMEOUT_MS}ms. ` +
            'Nothing was written. If no `smith` process is running, delete the stale lock file.',
          { lock_path: lockPath },
        );
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }

    try {
      // Written for a person reading a stuck lock, never read back by code.
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      return await task();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
}

// event_type -> which taxonomy record type its payload must satisfy, and how
// payload field names map onto that record type's required dimension names
// (architecture §7 payload shapes; taxonomy.yml rules.required_dimensions).
// Extend this map if/when another payload-typed event kind is emitted;
// edge-recorded is already covered separately via event.schema.json's
// x-taxonomy on the `edge` sub-object.
const PAYLOAD_DIMENSION_MAP: Record<
  string,
  { recordType: string; fieldMap: Record<string, string> }
> = {
  dispatch_decision: {
    recordType: 'dispatch',
    fieldMap: {
      agent: 'agent_role',
      provider: 'provider',
      model_tier: 'model_tier',
      // P9-23: the concrete model, not just its tier. Required, because an
      // optional field would be dropped exactly where it matters and the
      // absence would read as compliance; presence-only in taxonomy.ts,
      // because model ids are not a closed vocabulary.
      model: 'model',
    },
  },
  // Phase 8 addition (architecture §6/§7 note, providers/quorum.ts): one
  // per external judge run, `agent`/`provider`/`model_tier` payload fields
  // already match the taxonomy dimension names 1:1 (no renaming needed,
  // unlike dispatch_decision's agent_role -> agent), so fieldMap is an
  // identity map.
  'judge-verdict': {
    recordType: 'dispatch',
    fieldMap: { agent: 'agent', provider: 'provider', model_tier: 'model_tier', model: 'model' },
  },
  'error-logged': {
    recordType: 'error',
    fieldMap: { error: 'error', severity: 'severity', task_ref: 'task_ref' },
  },
  // Phase 5 addition (deviation, see db/projector.ts header comment): the
  // full lesson record — every dimension taxonomy.yml's rules.
  // required_dimensions.lesson demands is present on THIS event's payload.
  'lesson-candidate-raised': {
    recordType: 'lesson',
    fieldMap: {
      lesson_type: 'lesson_type',
      lesson_level: 'lesson_level',
      lesson_status: 'lesson_status',
      lesson_scope: 'lesson_scope',
      provenance_event_ids: 'provenance_event_ids',
    },
  },
};

// event_type -> a single taxonomy-valued payload field to check, for event
// kinds that carry only ONE dimension-tagged field rather than a full
// record (mirrors finding-transitioned's shape: a status change, not a new
// record — PAYLOAD_DIMENSION_MAP's required_dimensions check would
// wrongly demand the OTHER lesson fields that only the raise event carries).
const PAYLOAD_TAG_MAP: Record<string, { dimension: string; payloadField: string }> = {
  'lesson-status-changed': { dimension: 'lesson_status', payloadField: 'to_status' },
  // P9-11: the terminal half of a judge dispatch (judges.ts). It names a role
  // and nothing else dimension-valued — the provider and tier were settled by
  // the `dispatch_decision` this closes, and repeating them here would be a
  // second place for them to disagree.
  'judge-reported': { dimension: 'agent', payloadField: 'agent_role' },
};

// event_type -> several OPTIONAL taxonomy-valued payload fields, each
// validated only when present. Mirrors PAYLOAD_TAG_MAP, but for an event
// that carries a PARTIAL update over more than one dimension at once rather
// than exactly one field — lesson-edited's Edit action lets the operator
// change just the statement, just the type, just the scope, just the
// selector the scope names, or any combination (ui/server/src/app.ts's edit
// route), so neither
// PAYLOAD_DIMENSION_MAP (demands every field) nor PAYLOAD_TAG_MAP (checks
// exactly one) fits. Without this, `lessonType: "NOT-A-REAL-TYPE"` would
// persist silently — db/projector.ts's foldLessons() writes whatever
// lesson_type/lesson_scope string it is given, unchecked.
const PAYLOAD_PARTIAL_TAG_MAP: Record<
  string,
  ReadonlyArray<{ dimension: string; payloadField: string }>
> = {
  'lesson-edited': [
    { dimension: 'lesson_type', payloadField: 'lesson_type' },
    { dimension: 'lesson_scope', payloadField: 'lesson_scope' },
    // D-129 added these two so that re-scoping a lesson to a selector scope
    // can name the selector in the same edit. They are taxonomy-valued like
    // the two above and lessons.ts's transitionLesson checks them -- but a
    // writer's guard is not the log's, and everything the paragraph above
    // says of an unchecked lesson_type is true of these: foldLessons writes
    // the string it is given onto the row, and a lesson scoped to an agent
    // role no agent has is a lesson that reaches nobody, silently.
    //
    // The dimension names are the taxonomy's ('agent', 'case'), not the
    // payload field's -- same rename dispatch_decision's fieldMap makes.
    { dimension: 'agent', payloadField: 'agent_role' },
    { dimension: 'case', payloadField: 'case_type' },
  ],
  // D-215. taxonomy.yml's rules.required_dimensions names six record types;
  // `dispatch`, `error` and `lesson` are checked above and `edge` goes
  // through validateRequiredDimensions in plan.ts -- `task` was the one with
  // no write-time check anywhere, and `task-added` is the only event that
  // carries one. It matters more than the others, not less: db/projector.ts's
  // `row.taskStatus = p.task_status ?? row.taskStatus` is the ONLY place a
  // payload string becomes a task's status (every other assignment there is a
  // literal from this vocabulary), and ui/src/lib/kanban.ts folds that status
  // through a lookup with no bucket for a value it does not recognise -- so a
  // typo does not render oddly, it removes the task from the board, in "All"
  // mode too. `smith plan ingest` never calls validatePlan(), so the schema's
  // x-taxonomy on task-spec.schema.json is opt-in and this is the only stop.
  //
  // Partial rather than PAYLOAD_DIMENSION_MAP: presence of the three is
  // task-spec.schema.json's business and `plan validate`'s, and demanding
  // them here would reject the sparse `task-added` payloads that legitimately
  // carry only an epic and an objective. This rule is about the value of a
  // field that is present.
  'task-added': [
    { dimension: 'task_status', payloadField: 'task_status' },
    { dimension: 'case', payloadField: 'case' },
    { dimension: 'origin', payloadField: 'origin' },
  ],
};

/**
 * Every event_type the three maps above key on — a third hand-kept list of
 * event types, after the taxonomy's and queries.ts's. Exported so the P9-37
 * lint (test/eventTypes.test.ts) can hold it against the other two: a key here
 * that names no event anyone writes is a payload rule that never fires, and a
 * typo in the key is exactly that, silently.
 */
export const PAYLOAD_TAGGED_EVENT_TYPES: string[] = [
  ...Object.keys(PAYLOAD_DIMENSION_MAP),
  ...Object.keys(PAYLOAD_TAG_MAP),
  ...Object.keys(PAYLOAD_PARTIAL_TAG_MAP),
];

function checkTag(taxonomy: Taxonomy, eventType: string, dimension: string, value: unknown): void {
  try {
    validateTag(taxonomy, dimension, String(value));
  } catch (err) {
    throw new EventError(
      'events.invalid-payload-dimensions',
      `Event payload for "${eventType}" failed taxonomy validation: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { event_type: eventType },
    );
  }
}

function validatePayloadDimensions(taxonomy: Taxonomy, record: EventRecord): void {
  const mapping = PAYLOAD_DIMENSION_MAP[record.event_type];
  if (mapping) {
    const payload = record.payload;
    const mapped: Record<string, unknown> = {};
    for (const [dimensionField, payloadField] of Object.entries(mapping.fieldMap)) {
      mapped[dimensionField] = payload[payloadField];
    }

    try {
      validateRequiredDimensions(taxonomy, mapping.recordType, mapped);
    } catch (err) {
      throw new EventError(
        'events.invalid-payload-dimensions',
        `Event payload for "${record.event_type}" failed taxonomy validation: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { event_type: record.event_type },
      );
    }
    return;
  }

  const tagMapping = PAYLOAD_TAG_MAP[record.event_type];
  if (tagMapping) {
    const value = record.payload[tagMapping.payloadField];
    if (value === undefined) return; // presence is the caller's job, not ours
    checkTag(taxonomy, record.event_type, tagMapping.dimension, value);
    return;
  }

  const partialTagMapping = PAYLOAD_PARTIAL_TAG_MAP[record.event_type];
  if (partialTagMapping) {
    for (const { dimension, payloadField } of partialTagMapping) {
      const value = record.payload[payloadField];
      if (value === undefined) continue; // this partial update did not touch this field
      checkTag(taxonomy, record.event_type, dimension, value);
    }
  }
}

/**
 * Event types whose payload IS a schema-defined record, not free-form JSON.
 *
 * D-135. The event schema types `payload` as an open object, so the envelope
 * check passes on any payload at all. That is right for most event types —
 * the payload is a note for a human reader. It is wrong for the few whose
 * payload is later rehydrated into a typed object by a reader: `foldFindings`
 * rebuilds each Finding from `record.payload` alone, so a payload missing a
 * required field produces a Finding with `task_id: undefined`, and the crash
 * lands in whichever reader touches it first — three frames and possibly
 * three weeks from the actor that wrote it. Validating here puts the error
 * where the bad record is still attributable, and keeps the log's invariant
 * true for readers rather than merely hoped for.
 */
const TYPED_PAYLOAD_SCHEMAS: Record<string, string> = {
  'finding-raised': 'finding',
};

function validateTypedPayload(
  schemas: CompiledSchemaSet,
  taxonomy: Taxonomy,
  record: EventRecord,
): void {
  const schemaName = TYPED_PAYLOAD_SCHEMAS[record.event_type];
  if (schemaName === undefined) return;

  const result = validateRecord(schemas, taxonomy, schemaName, record.payload);
  if (!result.valid) {
    throw new EventError(
      'events.invalid-typed-payload',
      `Event payload for "${record.event_type}" failed "${schemaName}" schema validation. Readers rehydrate this payload into a typed record, so an incomplete one becomes a crash in a later reader rather than an error here.`,
      { event_type: record.event_type, schema: schemaName, errors: result.errors },
    );
  }
}

/**
 * P9-7: causal_parent may point into ANOTHER session's log, but only from a
 * session root.
 *
 * The concurrency ceiling on an epic is the orchestrator's context window —
 * fan-out is bounded by the claim graph, not by a cap — so the documented way
 * to run a large epic is to split it across operator sessions. That was
 * unexpressible: this check read only the appending session's own log, so a
 * second session's first event could never name the first session's timeline.
 *
 * The edge is restricted to `session-start` deliberately. One entry edge per
 * session makes the log a tree of sessions rather than a general graph: a
 * reader can answer "where did this session come from" by looking at one
 * event, and `sessionLineage` terminates. Letting any event point anywhere
 * would buy nothing the root edge does not already express.
 */
async function validateCausalParent(
  input: EventInput,
  opts: EventOpts,
  existing: StoredEvent[],
): Promise<void> {
  const parent = parseEventId(input.causal_parent as string);

  if (parent.sessionId === input.session_id) {
    if (!existing.some((e) => e.event_id === input.causal_parent)) {
      throw new EventError(
        'events.unknown-causal-parent',
        `causal_parent "${input.causal_parent}" does not reference an existing event in session "${input.session_id}".`,
        { causal_parent: input.causal_parent, session_id: input.session_id },
      );
    }
    return;
  }

  if (input.event_type !== ROOT_EVENT_TYPE) {
    throw new EventError(
      'events.cross-session-parent-not-root',
      `Only a "${ROOT_EVENT_TYPE}" event may name a parent in another session; "${input.event_type}" in session "${input.session_id}" named "${input.causal_parent}". Chain the session root to the other session, then chain this event locally.`,
      {
        causal_parent: input.causal_parent,
        session_id: input.session_id,
        event_type: input.event_type,
      },
    );
  }

  // Read outside the parent log's append queue. Safe because logs are
  // append-only: a concurrent append there can add events, never remove the
  // one we are about to point at.
  const parentPath = logPath(parent.sessionId, opts);
  if (!existsSync(parentPath)) {
    throw new EventError(
      'events.unknown-causal-session',
      `causal_parent "${input.causal_parent}" names session "${parent.sessionId}", which has no event log (expected ${parentPath}).`,
      { causal_parent: input.causal_parent, session_id: parent.sessionId, path: parentPath },
    );
  }

  const parentEvents = await readEventsAtPath(parentPath, parent.sessionId);
  if (!parentEvents.some((e) => e.event_id === input.causal_parent)) {
    throw new EventError(
      'events.unknown-causal-parent',
      `causal_parent "${input.causal_parent}" does not reference an existing event in session "${parent.sessionId}" (it holds ${parentEvents.length}).`,
      { causal_parent: input.causal_parent, session_id: parent.sessionId },
    );
  }
}

async function appendEventLocked(
  input: EventInput,
  opts: EventOpts,
  filePath: string,
): Promise<StoredEvent> {
  // EventInput requires causal_parent, so inside the orchestrator undefined is
  // unreachable. It is reachable from outside: every event appended through the
  // CLI crosses a JSON boundary where the type guarantees nothing, and omitting
  // a field is the likeliest way a hand-written event is malformed. Both guards
  // below used to compare against `null` alone, so an omitted parent fell
  // through them into parseEventId(undefined) and reached the caller as a raw
  // TypeError with no `code` — the one shape produced by accident was the one
  // shape with nothing to branch on. Normalise once so both guards read it.
  const causalParent = input.causal_parent ?? null;

  if (causalParent === null && input.event_type !== ROOT_EVENT_TYPE) {
    throw new EventError(
      'events.missing-causal-parent',
      `causal_parent may only be null for "${ROOT_EVENT_TYPE}" events (got event_type "${input.event_type}").`,
      { event_type: input.event_type },
    );
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readEventsAtPath(filePath, input.session_id);

  if (causalParent !== null) {
    await validateCausalParent(input, opts, existing);
  }

  const record: EventRecord = { ...input, ts: new Date().toISOString() };

  const { taxonomy, schemas } = resolveTaxonomyAndSchemas(opts);
  const result = validateRecord(schemas, taxonomy, 'event', record);
  if (!result.valid) {
    throw new EventError('events.invalid-record', 'Event failed schema/taxonomy validation.', {
      errors: result.errors,
    });
  }

  validatePayloadDimensions(taxonomy, record);
  validateTypedPayload(schemas, taxonomy, record);

  const index = existing.length;
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');

  return { event_id: `${input.session_id}#${index}`, record };
}

/**
 * Append one event. Stamps ts, validates via schemas.ts + taxonomy.ts
 * (including payload-level taxonomy dimensions for dispatch/error events),
 * enforces the causal_parent invariant (must reference a real prior event
 * in this session, null only for session-start), and serializes concurrent
 * appends to the same log — a rejected event never touches the log file.
 *
 * Serialized twice, deliberately: `enqueue` orders callers inside this
 * process, `withLogLock` orders this process against every other `smith`
 * running against the same log. A wave dispatched in parallel needs the
 * second one; see its docblock for what a missing lock actually costs.
 */
export async function appendEvent(input: EventInput, opts: EventOpts = {}): Promise<StoredEvent> {
  const filePath = logPath(input.session_id, opts);
  return enqueue(filePath, () =>
    withLogLock(filePath, () => appendEventLocked(input, opts, filePath)),
  );
}

export interface StartSessionOptions extends EventOpts {
  /**
   * Who is opening the session. Defaults to `operator`, which is who opens one
   * by hand; an agent that opens one says so, and the log keeps the difference.
   */
  actor?: string;
  /**
   * P9-7's cross-session edge: an event in ANOTHER session's log that this
   * session continues. The rules about it are `validateCausalParent`'s and are
   * not restated here -- this only fills the field.
   */
  continues?: string;
}

/**
 * Open a session: write the one `session-start` its log is allowed to hold.
 *
 * This exists because `appendEvent` cannot be the thing that enforces "one
 * root per log", and should not become it. That writer is open on purpose
 * (D-163): `event_type` is a free string so a type nobody has declared yet is
 * still recorded rather than lost, and the same openness reaches the root --
 * a second `session-start` with a null `causal_parent`, into a log that
 * already has one, satisfies every rule the writer has and is receipted as
 * `#1` with exit 0.
 *
 * Nothing downstream reads that second line. `sessionLineage` takes the FIRST
 * root, and the tree-of-sessions reading the whole cross-session edge is built
 * on assumes there is exactly one entry point per session. So the second root
 * is not a second beginning; it is a line no reader will ever look at, written
 * by someone who believed they were starting fresh and was told they had.
 *
 * A dedicated verb can be closed where the writer has to stay open, and that
 * is the whole design: the rule lives in the command whose only job is the
 * root, so `appendEvent` keeps the property that makes it safe to hand an
 * unknown record to.
 *
 * The emptiness check runs inside the same lock as the append, for the reason
 * `withLogLock` gives above: checking outside it would read a length another
 * process is in the middle of changing, and a guard that passes because it
 * looked a moment too early is worse than no guard, since it reports success.
 */
export async function startSession(
  sessionId: string,
  opts: StartSessionOptions = {},
): Promise<StoredEvent> {
  const filePath = logPath(sessionId, opts);
  const input: EventInput = {
    session_id: sessionId,
    actor: opts.actor ?? 'operator',
    event_type: ROOT_EVENT_TYPE,
    plan_version: 1,
    causal_parent: opts.continues ?? null,
    payload: {},
  };

  return enqueue(filePath, () =>
    withLogLock(filePath, async () => {
      const existing = await readEventsAtPath(filePath, sessionId);
      const last = existing[existing.length - 1];
      if (last !== undefined) {
        // Names the anchor rather than only the refusal. Someone who reaches
        // for this verb on a live session wants the event id their next
        // command needs as `--causal-parent`, and it is right here.
        throw new EventError(
          'events.session-already-started',
          `Session "${sessionId}" is already open — its log holds ${existing.length} event(s), the last being "${last.event_id}". A session log has one root, so there is nothing here to start. Chain your next command off "${last.event_id}", or pick a session id nothing has used.`,
          { session_id: sessionId, event_id: last.event_id, events: existing.length },
        );
      }
      return appendEventLocked(input, opts, filePath);
    }),
  );
}

/** Convenience wrapper for edge-recorded events (edge_type + edge_provenance required). */
export async function appendEdge(
  input: Omit<EventInput, 'edge' | 'event_type'> & { event_type?: string },
  edge: EventEdge,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  return appendEvent({ ...input, event_type: input.event_type ?? 'edge-recorded', edge }, opts);
}

/**
 * ONE session's log.
 *
 * Since D-119 this is the narrow reader, and the narrow scope is the thing a
 * caller has to ask for: anything that decides something about an epic wants
 * `readLineageEvents`, because an epic is allowed to span sessions and a fold
 * that stops at the session boundary answers `go` for the half it cannot see.
 * The remaining callers here want exactly one session and say so — the
 * projector (it writes rows keyed by session_id), `closeEpic`'s "does THIS
 * session have a log" guard, `walkLineage` itself, and the plain `event tail`.
 */
export async function readEvents(sessionId: string, opts: EventOpts = {}): Promise<StoredEvent[]> {
  return readEventsAtPath(logPath(sessionId, opts), sessionId);
}

/**
 * Assert that this session has a log at all.
 *
 * P9-28: `readEvents` answers `[]` for a log that does not exist, and it has
 * to — `appendEvent` reads the log to derive the next line index and to check
 * `causal_parent`, so a session's very first event depends on "absent" meaning
 * "empty". The cost lands on the reading side, which then cannot tell *no such
 * session* from *this session did nothing*, and every reader reported the
 * second: `smith event tail typo-in-the-id` printed `[]` and exited 0.
 *
 * So the check belongs here rather than inside readEvents, and readers opt
 * into it — precisely so writers keep the behaviour they need. It says nothing
 * about an existing-but-empty log; that one really is an empty session.
 */
export function requireSession(sessionId: string, opts: EventOpts = {}): void {
  const filePath = logPath(sessionId, opts);
  if (!existsSync(filePath)) {
    throw new EventError(
      'events.unknown-session',
      `No event log for session '${sessionId}' (expected ${filePath}). Check the id, or create the session with a session-start event.`,
      { session_id: sessionId, path: filePath },
    );
  }
}

/**
 * The chain of sessions this one continues, root first, ending with itself.
 *
 * P9-7's read side. A session's entry edge is the `causal_parent` of its
 * `session-start` event; when that names another session, this walk follows it
 * back. A session with no cross-session parent answers `[sessionId]` — a
 * lineage of one, not an empty list, because the session is always part of its
 * own lineage.
 */
export async function sessionLineage(sessionId: string, opts: EventOpts = {}): Promise<string[]> {
  // `require` — a caller naming a session by hand gets told when the name is
  // wrong. readLineageEvents does not, and its comment says why.
  return (await walkLineage(sessionId, opts, true)).map((s) => s.sessionId);
}

/**
 * One walk back up the causal_parent chain, root first, carrying each
 * session's log with it.
 *
 * Both readers need the same walk and the same cycle guard, and the walk has
 * to read every ancestor's log anyway to find its parent — so the events come
 * back with the ids rather than being read a second time by whoever wanted
 * them.
 */
async function walkLineage(
  sessionId: string,
  opts: EventOpts,
  require: boolean,
): Promise<{ sessionId: string; events: StoredEvent[] }[]> {
  const lineage: { sessionId: string; events: StoredEvent[] }[] = [];
  const seen = new Set<string>();
  let current: string | null = sessionId;

  while (current !== null) {
    if (seen.has(current)) {
      throw new EventError(
        'events.session-lineage-cycle',
        `Session lineage for "${sessionId}" revisits "${current}". A session-start's causal_parent chain must terminate; this log has been edited by hand.`,
        { session_id: sessionId, revisited: current },
      );
    }
    seen.add(current);
    if (require) requireSession(current, opts);

    const events = await readEvents(current, opts);
    lineage.unshift({ sessionId: current, events });

    const root = events.find((e) => e.record.event_type === ROOT_EVENT_TYPE);
    const parent = root?.record.causal_parent ?? null;
    const parentSession = parent === null ? null : parseEventId(parent).sessionId;
    current = parentSession === current ? null : parentSession;
  }

  return lineage;
}

/**
 * Every event in this session's lineage, in one causal order.
 *
 * D-119, the S1 this exists for: `sessionLineage` shipped with P9-7 and was
 * then read by exactly two call sites, both read-only display verbs. Every
 * fold that *decided* something — which findings are open, whether an epic may
 * close, whether a task result is a duplicate — read `readEvents(sessionId)`,
 * one session, and reported its answer in the same words it would have used
 * had it read them all. Splitting the real `dogfood-mcp-1` log in two, the
 * findings in one file and everything else in the other, turned `hold` with
 * eleven open findings into `go` with none. A gate that reads a narrower scope
 * than the thing it guards is off for everything outside that scope, and
 * nothing in its output says so.
 *
 * Order: by `ts` ACROSS sessions, by append position WITHIN one, never by `ts`
 * within one. findings.ts's staleFindings is "strictly ordering-based … a
 * timestamp comparison across separately-clocked producers would not" answer
 * correctly, and that caution holds — a session's own log is already the order
 * its writer appended in, and a clock that steps backwards mid-session must
 * not be able to hand a last-write-wins fold a different winner. Between two
 * sessions the wall clock is the only shared reference there is, and the
 * alternative — concatenating whole logs root-first — is strictly worse the
 * moment a parent keeps working after a continuation chains onto it. Ties go
 * to the older session, which is the direction causality runs.
 *
 * A session with no log answers `[]`, exactly as `readEvents` does and for the
 * same reason (P9-28): this is a drop-in at the fold sites, and making them
 * throw where they used to return would change what a session's first write
 * does. `requireSession` stays the opt-in it already was.
 */
export async function readLineageEvents(
  sessionId: string,
  opts: EventOpts = {},
): Promise<StoredEvent[]> {
  return mergeSessionLogs(await walkLineage(sessionId, opts, false));
}

/**
 * Every session that has a log in `stateDir`, sorted, with no log read.
 *
 * A session id is only ever a `<id>.jsonl` filename here, so this is the one
 * place that knows it — the projector kept a private copy and the daemon
 * wanted a third, and three answers to "what sessions exist" is how a reader
 * comes to inspect a set the writer never wrote.
 */
export function listSessionIds(stateDir: string = STATE_EVENTS_DIR): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

/** One session's id and its log, as `walkLineage` and `readAllSessionLogs` carry them. */
export interface SessionLog {
  sessionId: string;
  events: StoredEvent[];
}

/**
 * Several sessions' logs in one causal order, under `readLineageEvents`'s
 * ordering rule above: by `ts` ACROSS sessions, by append position WITHIN
 * one, ties to whichever log comes first in `logs`.
 *
 * Extracted from `readLineageEvents` for D-199, which needs the same order
 * over a set of sessions that is not a lineage — the projector's lessons
 * table is keyed globally, so it folds every session, not one chain. Two
 * copies of a k-way merge are two chances to answer a last-write-wins fold
 * with different winners, which is the failure this ordering exists to
 * prevent; callers pass their own set and share the one implementation.
 */
export function mergeSessionLogs(logs: readonly SessionLog[]): StoredEvent[] {
  // The overwhelmingly common shape, and the one every pre-D-119 caller had:
  // returned as-is so a single session's order is its own log's, untouched.
  const only = logs.length === 1 ? logs[0] : undefined;
  if (only) return only.events;

  // A k-way merge over the per-session cursors. Each session's events are
  // consumed in append order, so the merge can only interleave sessions — it
  // can never reorder one.
  const cursors = logs.map((s) => ({ events: s.events, next: 0 }));
  const total = cursors.reduce((n, c) => n + c.events.length, 0);
  const merged: StoredEvent[] = [];

  while (merged.length < total) {
    let pick: (typeof cursors)[number] | undefined;
    let head: StoredEvent | undefined;
    for (const cursor of cursors) {
      const candidate = cursor.events[cursor.next];
      if (candidate === undefined) continue; // this session is exhausted
      // Strict `<`: an equal timestamp leaves `pick` on the older session.
      if (head === undefined || candidate.record.ts < head.record.ts) {
        pick = cursor;
        head = candidate;
      }
    }
    // Unreachable — `total` counts exactly what the cursors hold — but a
    // silent infinite loop is the wrong way to be wrong about that.
    if (pick === undefined || head === undefined) break;
    merged.push(head);
    pick.next += 1;
  }

  return merged;
}

export async function tailEvents(
  sessionId: string,
  n: number,
  opts: EventOpts = {},
): Promise<StoredEvent[]> {
  const all = await readEvents(sessionId, opts);
  return all.slice(Math.max(0, all.length - n));
}

export interface EventFilter {
  taskId?: string;
  planVersion?: number;
}

export function filterEvents(events: StoredEvent[], filter: EventFilter): StoredEvent[] {
  return events.filter(({ record }) => {
    // D-130's two-spelling rule now lives in taskId.ts, where the findings
    // fold can reach it too (D-143).
    // D-245: from either level, or a `--task` scope drops the events whose
    // producer wrote the id in the payload.
    if (
      filter.taskId !== undefined &&
      !taskIdsMatch(eventTaskId(record) ?? undefined, filter.taskId)
    )
      return false;
    if (filter.planVersion !== undefined && record.plan_version !== filter.planVersion)
      return false;
    return true;
  });
}
