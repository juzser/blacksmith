// Drizzle schema for the SQLite projection layer (architecture §7, §10).
//
// Events (`state/events/*.jsonl`) are the source of truth; every table here
// is a DERIVED read-model rebuilt by db/projector.ts. Nothing outside the
// projector writes to these tables. Taxonomy-valued columns are stored as
// plain text — validation already happened at event-write time in events.ts
// (architecture §8: "the event logger rejects unknown tags at write time").
//
// One schema, both targets (docs/standards/stack.md): this file is the
// single source for SQLite locally and Cloudflare D1 later via Drizzle.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Every event ever appended, exactly as logged — the append-only substrate mirrored 1:1.
 *
 * `project` (Phase 6b, architecture §8 note): a PLAIN STRING identifier, not
 * a closed taxonomy vocabulary value — projects are opened/closed by the
 * operator far more often than any §8 dimension, and forcing a taxonomy PR
 * per new project would defeat the point of a multi-project hub. Nullable
 * for migration safety (every event logged before this column existed has
 * no value here); queries.ts's helpers COALESCE it to 'black-smith' so old
 * rows and new single-project fixtures both resolve to the same default
 * project rather than an ungrouped null bucket.
 */
export const eventsRaw = sqliteTable(
  'events_raw',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    eventType: text('event_type').notNull(),
    taskId: text('task_id'),
    agentId: text('agent_id'),
    planVersion: integer('plan_version').notNull(),
    causalParent: text('causal_parent'),
    payload: text('payload').notNull(), // JSON
    project: text('project'),
    // Phase 6b: who wrote the event (EventRecord.actor — 'user', 'system', or
    // an agent role/id), needed to tell an operator-authored decision event
    // (Timeline's "Decisions" lens, architecture §8) apart from a system/
    // agent one of the same event_type. Nullable for migration safety —
    // events logged before this column existed simply can't be attributed.
    actor: text('actor'),
  },
  (t) => [
    index('events_raw_session_idx').on(t.sessionId),
    index('events_raw_task_idx').on(t.taskId),
    index('events_raw_type_idx').on(t.eventType),
    index('events_raw_ts_idx').on(t.ts),
    index('events_raw_project_idx').on(t.project),
  ],
);

/** One row per session, folded from its session-start event + last-seen ts. */
export const sessions = sqliteTable('sessions', {
  sessionId: text('session_id').primaryKey(),
  startedAt: text('started_at').notNull(),
  lastEventAt: text('last_event_at').notNull(),
  eventCount: integer('event_count').notNull(),
});

/** `user_prompt` events (architecture §7), stored verbatim. */
export const prompts = sqliteTable(
  'prompts',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    prompt: text('prompt').notNull(),
    causalParent: text('causal_parent'),
  },
  (t) => [index('prompts_session_idx').on(t.sessionId)],
);

/** `dispatch_decision` events (architecture §7). */
export const dispatches = sqliteTable(
  'dispatches',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    taskId: text('task_id'),
    agentId: text('agent_id'),
    agentRole: text('agent_role').notNull(),
    provider: text('provider').notNull(),
    modelTier: text('model_tier').notNull(),
    specRef: text('spec_ref'),
    reason: text('reason'),
    parentPromptId: text('parent_prompt_id'),
    causalParent: text('causal_parent'),
    project: text('project'), // Phase 6b — see eventsRaw's project comment above.
  },
  (t) => [
    index('dispatches_session_idx').on(t.sessionId),
    index('dispatches_task_idx').on(t.taskId),
    index('dispatches_role_idx').on(t.agentRole),
    index('dispatches_provider_idx').on(t.provider),
    index('dispatches_model_tier_idx').on(t.modelTier),
    index('dispatches_project_idx').on(t.project),
  ],
);

/**
 * Live agent registry (agents-registry.ts owns the fold semantics): one row
 * per dispatch_decision, closed by whichever terminal event (task-result-
 * recorded / judge-reported / error-logged) comes next for the same
 * `(task_id, agent_role)`, superseded by a redispatch of that same pair
 * before any terminal event arrives, or abandoned by the `epic-closed` that
 * ended the run it belonged to (D-187). The pair, not `task_id` alone: `/bs run`
 * puts a coder, a grader, a reviewer and a security-reviewer on one task at
 * once (D-23/P9-12).
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(), // dispatch event_id
    sessionId: text('session_id').notNull(),
    taskId: text('task_id'),
    /** The epic this agent works on: an epic-level dispatch names one and has no task (D-234). */
    epicId: text('epic_id'),
    agentId: text('agent_id'),
    agentRole: text('agent_role').notNull(),
    /** Dispatch round — 1 for a worker whose dispatch declares none. Carried, not keyed on. */
    round: integer('round').notNull().default(1),
    provider: text('provider').notNull(),
    modelTier: text('model_tier').notNull(),
    dispatchedAt: text('dispatched_at').notNull(),
    terminalEventId: text('terminal_event_id'),
    terminalAt: text('terminal_at'),
    terminalType: text('terminal_type'), // 'result' | 'error' | 'superseded' | 'abandoned'
    status: text('status').notNull(), // 'live' | 'done' | 'error' | 'superseded' | 'abandoned'
  },
  (t) => [
    index('agents_session_idx').on(t.sessionId),
    index('agents_status_idx').on(t.status),
    index('agents_role_idx').on(t.agentRole),
    index('agents_epic_idx').on(t.epicId),
  ],
);

/** One row per task_id, folded from task-added, wave-admitted/merged, gate-outcome, and error events. */
export const tasks = sqliteTable(
  'tasks',
  {
    taskId: text('task_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    epicId: text('epic_id'),
    caseTag: text('case_tag'),
    origin: text('origin'),
    taskStatus: text('task_status').notNull(),
    planVersion: integer('plan_version'),
    objective: text('objective'),
    claims: text('claims'), // JSON array
    budgetTokens: integer('budget_tokens'),
    branch: text('branch'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    project: text('project'), // Phase 6b — see eventsRaw's project comment above.
  },
  (t) => [
    index('tasks_session_idx').on(t.sessionId),
    index('tasks_epic_idx').on(t.epicId),
    index('tasks_status_idx').on(t.taskStatus),
    index('tasks_project_idx').on(t.project),
  ],
);

/** `edge-recorded` events (architecture §7 dependency edges). */
export const edges = sqliteTable(
  'edges',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    taskId: text('task_id').notNull(),
    dependsOn: text('depends_on').notNull(),
    edgeType: text('edge_type').notNull(),
    edgeProvenance: text('edge_provenance').notNull(),
  },
  (t) => [index('edges_session_idx').on(t.sessionId), index('edges_task_idx').on(t.taskId)],
);

/** `error-logged` events. */
export const errors = sqliteTable(
  'errors',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    taskRef: text('task_ref'),
    agentId: text('agent_id'),
    errorGroup: text('error_group').notNull(),
    errorClass: text('error_class').notNull(),
    severity: text('severity').notNull(),
    detail: text('detail'),
    project: text('project'), // Phase 6b — see eventsRaw's project comment above.
  },
  (t) => [
    index('errors_session_idx').on(t.sessionId),
    index('errors_group_idx').on(t.errorGroup),
    index('errors_severity_idx').on(t.severity),
    index('errors_ts_idx').on(t.ts),
    index('errors_project_idx').on(t.project),
  ],
);

/** Current finding state — folded via findings.ts's listFindings(), REUSED not duplicated. */
export const findings = sqliteTable(
  'findings',
  {
    findingId: text('finding_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    taskId: text('task_id').notNull(),
    epicId: text('epic_id'),
    fingerprint: text('fingerprint').notNull(),
    findingCategory: text('finding_category').notNull(),
    severity: text('severity').notNull(),
    findingStatus: text('finding_status').notNull(),
    summary: text('summary').notNull(),
    foundBy: text('found_by').notNull(),
    foundByProvider: text('found_by_provider'),
    verifiedBy: text('verified_by'),
    verifiedByProvider: text('verified_by_provider'),
    sameMistakeOfLessonId: text('same_mistake_of_lesson_id'),
    waiverId: text('waiver_id'),
    raisedAt: text('raised_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    project: text('project'), // Phase 6b — see eventsRaw's project comment above.
  },
  (t) => [
    index('findings_session_idx').on(t.sessionId),
    index('findings_task_idx').on(t.taskId),
    index('findings_status_idx').on(t.findingStatus),
    index('findings_severity_idx').on(t.severity),
    index('findings_fingerprint_idx').on(t.fingerprint),
    index('findings_project_idx').on(t.project),
  ],
);

/** `waiver-granted` / `waiver-denied` events — folded via waivers.ts semantics, REUSED. */
export const waivers = sqliteTable(
  'waivers',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    fingerprint: text('fingerprint').notNull(),
    decision: text('decision').notNull(), // 'granted' | 'denied'
    operatorNote: text('operator_note'),
  },
  (t) => [
    index('waivers_session_idx').on(t.sessionId),
    index('waivers_fingerprint_idx').on(t.fingerprint),
  ],
);

/**
 * `lesson-candidate-raised` / `lesson-status-changed` events (Phase 5
 * deviation — see db/projector.ts header comment; the full lessons loop is
 * Phase 7, this table is forward-compatible with it).
 */
export const lessons = sqliteTable(
  'lessons',
  {
    lessonId: text('lesson_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    lessonType: text('lesson_type').notNull(),
    lessonLevel: text('lesson_level').notNull(),
    lessonStatus: text('lesson_status').notNull(),
    lessonScope: text('lesson_scope').notNull(),
    statement: text('statement').notNull(),
    validFrom: text('valid_from').notNull(),
    supersededBy: text('superseded_by'),
    invalidatedByEventId: text('invalidated_by_event_id'),
    provenanceEventIds: text('provenance_event_ids'), // JSON array
    evidence: text('evidence'),
    timesPrevented: integer('times_prevented').notNull().default(0),
    // Phase 7 (lessons.ts) — see lesson.schema.json's field comments: only
    // meaningful for a `rule`-typed, claim-path/stack-wide-scoped entry;
    // nullable, most lessons never set either.
    findingCategory: text('finding_category'),
    claimPath: text('claim_path'),
    // D-129: the selectors the other two selector scopes filter on at
    // dispatch. Nullable for the same reason claim_path is — each is
    // meaningful for exactly one scope — and null on every lesson raised
    // before the selectors existed.
    agentRole: text('agent_role'),
    caseType: text('case_type'),
  },
  (t) => [
    index('lessons_session_idx').on(t.sessionId),
    index('lessons_status_idx').on(t.lessonStatus),
  ],
);

/**
 * `epic-closed` events (D-43/D-44/P9-27). One row per closed epic — an epic
 * has no other lifecycle event, so there is no "open" row here and absence
 * means "not closed". Keyed on the payload's `epic_id`, never on task_id:
 * the hand-written dogfood close used `<epic>/epic` as its task_id, which is
 * not the reserved suffix, so anything routing through the task fold would
 * have minted a phantom task card for it.
 */
export const epics = sqliteTable(
  'epics',
  {
    epicId: text('epic_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    epicStatus: text('epic_status').notNull(),
    /** 'verdict' | 'operator-override' — who the close is attributable to. */
    closedBy: text('closed_by').notNull(),
    /** What the machine said, kept even when a human closed against it. */
    machineVerdict: text('machine_verdict'),
    machineReason: text('machine_reason'),
    overrideRationale: text('override_rationale'),
    blockers: text('blockers'), // JSON array
    closedAt: text('closed_at').notNull(),
    eventId: text('event_id').notNull(),
    project: text('project'),
  },
  (t) => [index('epics_session_idx').on(t.sessionId), index('epics_project_idx').on(t.project)],
);

/**
 * Parsed from `factory/specs/roadmap.md` (roadmap.ts) — NOT session-scoped:
 * one global roadmap, fully replaced (delete-all + reinsert) on every
 * rebuild()/apply() call by db/projector.ts's projectMilestones(). Cheap:
 * a handful of rows, re-parsed from a small committed file every time.
 */
export const milestones = sqliteTable(
  'milestones',
  {
    milestoneId: text('milestone_id').primaryKey(),
    name: text('name').notNull(),
    status: text('status').notNull(), // 'planned' | 'in-progress' | 'completed'
    sequence: integer('sequence').notNull(),
    goal: text('goal'),
    epicIds: text('epic_ids').notNull(), // JSON array
    // Phase 6b — see eventsRaw's project comment above. roadmap.ts defaults
    // an unspecified `- project:` bullet to 'black-smith' at parse time (not
    // left null here), since factory/specs/roadmap.md (ROADMAP_PATH) is a
    // hand-authored declaration, not an event replay — there is no "old row"
    // to migrate.
    project: text('project').notNull().default('black-smith'),
  },
  (t) => [index('milestones_project_idx').on(t.project)],
);

/** One row per artifact entry on a `task-result-recorded` event's payload. */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(), // `${event_id}#${index}`
    sessionId: text('session_id').notNull(),
    taskId: text('task_id').notNull(),
    eventId: text('event_id').notNull(),
    ts: text('ts').notNull(),
    type: text('type').notNull(),
    path: text('path').notNull(),
    description: text('description'),
  },
  (t) => [index('artifacts_session_idx').on(t.sessionId), index('artifacts_task_idx').on(t.taskId)],
);
