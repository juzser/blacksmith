import {
  appendEdge,
  appendEvent,
  type EventOpts,
  readLineageEvents,
  type StoredEvent,
} from './events.js';
import type { EventContext } from './findings.js';
import { type PlanFile, resolveTaskId, type TaskSpecRecord } from './plan.js';
import { taskBranchName } from './worktree.js';

/**
 * Producers for the five task-status events (architecture §7) that
 * db/projector.ts's foldTasks() consumes.
 *
 * D-46/P9-29: `task-added`, `wave-admitted`, `wave-merged`,
 * `task-superseded` and `error-logged` were all folded by the projector and
 * emitted by nothing — the only way one reached the log was a human typing
 * `smith event append`. So the `tasks` table was not a projection of what
 * the factory did; it was a projection of what someone remembered to write
 * down afterwards, which is how the dogfood epic ended with a phantom row
 * (see resolveTaskId in plan.ts).
 *
 * These functions are deliberately thin. They own two things and no more:
 * minting the task id from the plan, and shaping the payload the projector
 * actually reads. The DECISION each event records — that a wave is
 * admissible, that a branch merged, that a task is blocked — belongs to the
 * component that makes it (wave check, queue.ts's step()), which calls in
 * here at the moment it makes it. An emitter that decided anything itself
 * would be a second opinion about the same fact, which is the class of bug
 * this file exists to remove.
 */

/**
 * The envelope fields every task event in one run shares. Deliberately the
 * same `EventContext` every other writer already threads through the CLI —
 * a second, near-identical shape would drift, and `--session`/`--causal-parent`
 * mean the same thing here as they do for a finding. `causalParent` stays
 * nullable because appendEvent is what enforces "null only for the session
 * root"; re-stating that as a type would only force callers to cast.
 */
export interface TaskEventContext extends EventContext {
  /** Optional `project` envelope field, for a multi-project state dir. */
  project?: string;
}

/** The `error-logged` payload's own fields; `task_ref` is filled in from the id. */
export interface TaskErrorInput {
  /** Taxonomy error class, `group.class` (e.g. `execution.test-failure`). */
  error: string;
  severity: string;
  detail?: string;
}

function envelope(
  ctx: TaskEventContext,
  eventType: string,
  payload: Record<string, unknown>,
  taskId?: string,
) {
  return {
    session_id: ctx.sessionId,
    actor: ctx.actor ?? 'system',
    event_type: eventType,
    plan_version: ctx.planVersion,
    causal_parent: ctx.causalParent,
    payload,
    ...(taskId ? { task_id: taskId } : {}),
    ...(ctx.project ? { project: ctx.project } : {}),
  };
}

/**
 * The project this write belongs to: what the caller declared, else what the
 * plan does.
 *
 * D-232. Every plan file under factory/specs/ carries a `project`, and until
 * now nothing at runtime read it -- `plan ingest` handed the plan straight to
 * emitTasksAdded, which used it for the epic id and the task specs and let the
 * project fall on the floor. Every event of a demo-rpg run therefore landed
 * with no project at all, and db/queries.ts's projectOf() resolves an absent
 * one to the default: a whole epic filed under black-smith, missing from the
 * board of the project it was actually part of.
 *
 * The plan is the fallback and not an override, because a caller holding a
 * project knows something the file cannot -- and an absent value stays absent
 * rather than becoming the default here, which is events.ts's rule: the log
 * records what was stamped, and the read helpers do the resolving.
 */
function planScoped(ctx: TaskEventContext, plan: PlanFile): TaskEventContext {
  const project = ctx.project ?? plan.project;
  return project === undefined ? ctx : { ...ctx, project };
}

function addedPayload(plan: PlanFile, task: TaskSpecRecord): Record<string, unknown> {
  const budget = task.budget as { tokens?: number } | undefined;
  // A task spec is a `Record<string, unknown>`, so its `epic_id` is only a
  // string by convention. `taskBranchName` needs a real one, and a task
  // carrying anything else belongs to the plan's epic by default.
  const epicId = typeof task.epic_id === 'string' ? task.epic_id : plan.epic_id;
  return {
    epic_id: epicId,
    case: task.case,
    origin: task.origin,
    task_status: task.task_status,
    plan_version: task.plan_version,
    objective: task.objective,
    claims: task.claims,
    budget_tokens: budget?.tokens,
    // D-23/P9-12. Declared here rather than derived by the reader: the board
    // wants a branch link the moment a task is added, which is well before a
    // worktree exists, and worktree.ts's convention is the one that decides
    // what `smith worktree create` will actually cut. Reading it off the same
    // function that creates it means the two cannot say different things.
    branch: taskBranchName(epicId, task.task_id),
  };
}

/**
 * Collect the task ids that already have an event of `eventType` in this
 * session's LINEAGE. Ingesting a plan twice — a re-run, a resumed session, v2
 * of a plan that carries v1's tasks forward — must not double-write history,
 * and the log itself is the only honest record of what has already been said.
 *
 * The lineage and not one session, since D-119: "a resumed session" is exactly
 * the case a session-scoped read got wrong. Re-ingesting the plan from a
 * continuation found none of the parent's `task-added` events and wrote the
 * whole plan a second time, which is the double-write this guard is for.
 */
async function idsAlreadyEmitted(
  eventType: string,
  ctx: TaskEventContext,
  opts: EventOpts,
): Promise<Set<string>> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  const ids = new Set<string>();
  for (const { record } of events) {
    if (record.event_type === eventType && record.task_id) ids.add(record.task_id);
  }
  return ids;
}

/**
 * The highest `plan_version` each task id has already been *added* under.
 *
 * D-18. `idsAlreadyEmitted` answers "has this id been added at all", which is
 * the wrong question after an amendment: `draftNextVersion` supersedes a task
 * by REUSING its id (D-121), so v(n+1) carries the dead copy beside a live one
 * at the higher version. Keyed on the id alone, that live record is invisible,
 * the amended task keeps the `plan_version` it was first added under, and
 * `satisfiedAmendments` (epic.ts) — which requires `planVersion >= version` for
 * every id the amendment names — can never discharge the finding that forced
 * the amendment. Epic 1 read that deadlock as "ingest was never run"; running
 * it correctly, at both versions, still deadlocks without this.
 *
 * A missing or non-numeric `plan_version` reads as `-Infinity`, so a task added
 * before this field was carried is re-added once by any plan that names one
 * rather than being frozen out.
 */
async function addedPlanVersions(
  ctx: TaskEventContext,
  opts: EventOpts,
): Promise<Map<string, number>> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  const highest = new Map<string, number>();
  for (const { record } of events) {
    if (record.event_type !== 'task-added' || !record.task_id) continue;
    const raw = (record.payload as { plan_version?: unknown }).plan_version;
    const version =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;
    const seen = highest.get(record.task_id);
    if (seen === undefined || version > seen) highest.set(record.task_id, version);
  }
  return highest;
}

/**
 * A task the log knows about: the id it was added under, and its claims.
 *
 * `claims` is `unknown` because that is what the log can hold. `addedPayload`
 * copies it out of a `Record<string, unknown>` task spec (it guards `epic_id`
 * with a `typeof` and passes `claims` through), and `event.schema.json`
 * declares `payload` a free-form object, so nothing between the plan and here
 * has ever checked its shape. Narrowing it at the reader would only pick a
 * default on the writer's behalf; the readers below disagree about which
 * default is safe, so each one says so where it reads.
 */
export interface AddedTask {
  taskId: string;
  claims: unknown;
}

/**
 * Read the lineage's log as a register of tasks — every id a `task-added`
 * has introduced, with the claims it was introduced with.
 *
 * D-48/P9-31: a follow-up minted by `findings raise` exists in the log and in
 * no plan file, so the log has to be readable as a register or that task is
 * unaddressable by every producer that resolves through a plan. Claims are
 * carried, not just ids: a wave admitting a task with an empty claim set has
 * admitted a task allowed to touch nothing, which fails at the first edit
 * rather than at admission, where the mistake actually is. They are carried
 * AS WRITTEN for the same reason: substituting `[]` for a claims value this
 * could not read handed `validateWave` the one claim set that overlaps
 * nothing, so an unreadable task was admitted as a disjoint one.
 *
 * Later events win on a repeated id (a re-add carries the newer claims), and
 * first-appearance order is kept so the register reads in log order.
 *
 * Lineage-wide (D-119). This register is what makes a follow-up task
 * addressable at all, and a task the parent session minted does not stop
 * existing because the epic continued somewhere else — a claims check that
 * cannot find the task it is checking is a claims check that passes.
 */
export async function readAddedTasks(
  // Reading takes only the session — a caller that is not writing should not
  // have to invent a causal parent to ask what exists.
  ctx: Pick<TaskEventContext, 'sessionId'>,
  opts: EventOpts = {},
): Promise<AddedTask[]> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  const byId = new Map<string, AddedTask>();
  for (const { record } of events) {
    if (record.event_type !== 'task-added' || !record.task_id) continue;
    byId.set(record.task_id, { taskId: record.task_id, claims: record.payload?.claims });
  }
  return [...byId.values()];
}

/**
 * One record per task id, in plan order: the id's live spec, or its last
 * record when every record for the id is dead.
 *
 * D-184. `plan.tasks` is not a backlog. `draftNextVersion` keeps each
 * superseded copy of a task *beside* the record that replaced it, under the
 * same `task_id` (D-121), so a v(n+1) file is routinely longer than the work
 * it describes — envkit-mcp-surface's plan-v5.json holds 13 records for 5
 * live tasks, four ids appearing three times each. This is the same rule
 * `liveSpec`/`livePlanTasks` apply in plan.ts, and for the same reason D-126
 * gave: reading the raw list answers with whichever copy happened to be
 * written last. It is repeated here rather than imported because the dead
 * ids matter to this caller — `livePlanTasks` drops them, and an id whose
 * every record is dead is exactly the one that needs a `task-superseded`.
 */
function specsToIngest(plan: PlanFile): TaskSpecRecord[] {
  const seen = new Set<string>();
  const specs: TaskSpecRecord[] = [];
  for (const t of plan.tasks) {
    if (seen.has(t.task_id)) continue;
    seen.add(t.task_id);
    const records = plan.tasks.filter((r) => r.task_id === t.task_id);
    const live = records.filter((r) => r.task_status !== 'superseded');
    // Last, not first: among the records still alive the later one is the
    // amendment, which is what `liveSpec` means by "the live spec". `?? t`
    // is unreachable — `records` always holds `t` — and is written rather
    // than asserted so the array access needs no cast to stay honest.
    const pool = live.length > 0 ? live : records;
    specs.push(pool[pool.length - 1] ?? t);
  }
  return specs;
}

/**
 * Write the plan's backlog into the log: one `task-added` per task id the
 * session has not already recorded, plus a `task-superseded` for any id the
 * plan has no live spec left for (a v(n+1) cut records that as plan state,
 * and the projector needs it as an event to reach the same conclusion).
 *
 * Per id, not per record — see `specsToIngest`. Emitting the dead copies too
 * would say two false things at once: that a task the plan still lists as
 * `todo` was superseded, and that a 5-task backlog is 13 tasks.
 *
 * Returns only the events it actually appended, so a caller can report "5
 * added, 0 already present" truthfully rather than guessing from the plan.
 */
export async function emitTasksAdded(
  plan: PlanFile,
  ctx: TaskEventContext,
  opts: EventOpts = {},
): Promise<StoredEvent[]> {
  const added = await addedPlanVersions(ctx, opts);
  const superseded = await idsAlreadyEmitted('task-superseded', ctx, opts);
  const scoped = planScoped(ctx, plan);
  const written: StoredEvent[] = [];

  // The ids the plan marks as superseded-and-replaced: a dead record beside a
  // live one under the same id is how `draftNextVersion` records an amendment.
  const supersededIds = new Set(
    plan.tasks.filter((r) => r.task_status === 'superseded').map((r) => r.task_id),
  );

  for (const task of specsToIngest(plan)) {
    const taskId = task.task_id;
    // Re-add only when the live spec has genuinely moved forward: an id absent
    // from the log, or one whose live record now carries a HIGHER plan_version
    // than anything added for it. Equal versions stay idempotent — the same
    // plan ingested twice is still one `task-added` — and a lower version is a
    // stale file, not an amendment, so it is ignored rather than honoured.
    const recorded = added.get(taskId);
    const liveVersion = task.plan_version;
    // D-18b. A higher version alone is not enough: `draftNextVersion` restamps
    // EVERY task with the new plan_version, carried ones included, so keying on
    // the number would re-add tasks whose spec never changed. The amendment's
    // own marker is what counts — an id the amendment touched carries a dead
    // record beside its live one, which is exactly what `supersededIds` holds.
    const amended =
      recorded !== undefined &&
      supersededIds.has(taskId) &&
      typeof liveVersion === 'number' &&
      liveVersion > recorded;
    if (recorded === undefined || amended) {
      written.push(
        await appendEvent(envelope(scoped, 'task-added', addedPayload(plan, task), taskId), opts),
      );
    }
    if (task.task_status === 'superseded' && !superseded.has(taskId)) {
      written.push(
        await appendEvent(
          envelope(scoped, 'task-superseded', { epic_id: plan.epic_id }, taskId),
          opts,
        ),
      );
    }
  }

  return written;
}

/** One arrow's identity in the log: who depends on whom, and in what sense. */
function edgeKey(task: string, dependsOn: string, edgeType: string): string {
  return `${task}\u0000${dependsOn}\u0000${edgeType}`;
}

/**
 * The edges this session's LINEAGE has already recorded, keyed by the triple
 * `edgeKey` spells rather than by task id the way `idsAlreadyEmitted` is.
 *
 * A task has as many arrows as it has dependencies, so a task-keyed register
 * would record the first and drop the rest. And the third component is not
 * decoration: demo-rpg-chapter-reading's plan-v1 declares both an `artifact`
 * and a `claim-order` handoff between the same two tasks, which are two
 * different claims about one pair and belong in the log as two events.
 *
 * The lineage and not one session, for D-119's reason -- a resumed session
 * re-ingests the plan it was resumed into, and a session-scoped read would
 * see none of what its parent already wrote.
 */
async function edgesAlreadyRecorded(ctx: TaskEventContext, opts: EventOpts): Promise<Set<string>> {
  const events = await readLineageEvents(ctx.sessionId, opts);
  const keys = new Set<string>();
  for (const { record } of events) {
    if (record.event_type !== 'edge-recorded' || !record.task_id || !record.edge) continue;
    const dependsOn = (record.payload as { depends_on?: unknown }).depends_on;
    if (typeof dependsOn !== 'string') continue;
    keys.add(edgeKey(record.task_id, dependsOn, record.edge.edge_type));
  }
  return keys;
}

/**
 * Write the plan's DAG into the log: one `edge-recorded` per dependency the
 * plan declares that this lineage has not already recorded.
 *
 * D-254. `emitTasksAdded` above ingests the nodes; this ingests the arrows,
 * and until it existed nothing in production ever wrote an `edge-recorded`
 * event at all. The consequence was not a missing feature but a wrong answer:
 * the db's `edges` table was empty in every real session, so the Flow page
 * drew a DAG with no dependencies and laid all 26 tasks out in a single wave,
 * and the Roadmap's mini-timeline reported `dependencyReady` for every next-up
 * task -- vacuously true over an empty dependency list. The scheduler was
 * never wrong, because it reads `plan.edges` from the file directly; only
 * every surface an operator looks at was.
 *
 * Both ends are resolved against the plan before anything is appended, so a
 * plan whose DAG names a task it does not contain is refused whole. That is
 * `emitWaveAdmitted`'s rule and `validatePlan`'s rule; an arrow written to a
 * ghost would be dropped silently by every reader instead of seen by anyone.
 */
export async function emitEdgesRecorded(
  plan: PlanFile,
  ctx: TaskEventContext,
  opts: EventOpts = {},
): Promise<StoredEvent[]> {
  const resolved = plan.edges.map((e) => ({
    task: resolveTaskId(plan, e.task),
    dependsOn: resolveTaskId(plan, e.dependsOn),
    edge_type: e.edge_type,
    edge_provenance: e.edge_provenance,
  }));

  const recorded = await edgesAlreadyRecorded(ctx, opts);
  const scoped = planScoped(ctx, plan);
  const written: StoredEvent[] = [];

  for (const edge of resolved) {
    const key = edgeKey(edge.task, edge.dependsOn, edge.edge_type);
    // Guards the plan against itself as well as against a re-ingest: an edge
    // the file states twice verbatim says nothing the first one did not.
    if (recorded.has(key)) continue;
    recorded.add(key);
    written.push(
      await appendEdge(
        envelope(
          scoped,
          'edge-recorded',
          { epic_id: plan.epic_id, depends_on: edge.dependsOn },
          edge.task,
        ),
        { edge_type: edge.edge_type, edge_provenance: edge.edge_provenance },
        opts,
      ),
    );
  }

  return written;
}

/**
 * What the epic budget gate saw at the moment this wave was admitted, in the
 * log's own snake_case shape.
 *
 * Recorded on every admission, not only on an overridden one. An event log
 * that carries a record only when a check FAILED cannot answer "was this wave
 * ever checked?" for the waves that passed — absence would mean both "the
 * gate said yes" and "no gate ran", which is the same one-yes-for-two-reasons
 * failure `blocksAdmission` keeps `unchecked` separate from `ok` to avoid.
 *
 * `override_rationale` is present only when a human actually overrode a
 * refusal, so an admission that simply fit is never dressed up as a decision
 * somebody had to make.
 */
export interface WaveAdmissionBudget {
  status: string;
  cap_tokens: number;
  projected_tokens: number;
  wave_tokens: number;
  headroom_tokens: number;
  override_rationale?: string;
}

/**
 * Record that a wave was admitted. Every id is resolved against the plan and
 * the log's own register BEFORE anything is appended, so a wave naming one
 * task that does not exist is refused whole rather than half-written — a
 * partially admitted wave is precisely the state that has no owner and no way
 * back. The register is read here rather than passed in (D-48/P9-31) so no
 * caller can forget it and quietly lose the ability to admit a follow-up.
 */
export async function emitWaveAdmitted(
  plan: PlanFile,
  typedIds: string[],
  ctx: TaskEventContext,
  opts: EventOpts = {},
  budget?: WaveAdmissionBudget,
): Promise<StoredEvent> {
  const logged = (await readAddedTasks(ctx, opts)).map((t) => t.taskId);
  const taskIds = typedIds.map((typed) => resolveTaskId(plan, typed, logged));
  return appendEvent(
    envelope(planScoped(ctx, plan), 'wave-admitted', {
      epic_id: plan.epic_id,
      task_ids: taskIds,
      ...(budget ? { budget } : {}),
    }),
    opts,
  );
}

/**
 * Record that one task's branch landed on the integration branch. One event
 * per task, carrying a single-element `task_ids`, rather than one event per
 * wave: a merge queue that gets three tasks in and fails on the fourth has
 * genuinely merged three, and the log should say so. A wave-shaped event
 * could only be written after the whole wave finished, which is exactly when
 * a crash would lose it.
 *
 * `filesChanged` is what the merge actually rewrote (P9-15). Optional because
 * only the queue can compute it and only after the merge commit exists; a
 * caller that cannot supply it writes the event without the field rather than
 * with an empty list, so "no file list here" and "this merge changed nothing"
 * stay distinguishable to the staleness check reading them back.
 */
export async function emitWaveMerged(
  taskId: string,
  ctx: TaskEventContext,
  opts: EventOpts = {},
  filesChanged?: readonly string[],
): Promise<StoredEvent> {
  const payload: Record<string, unknown> = { task_ids: [taskId] };
  if (filesChanged !== undefined) payload.files_changed = [...filesChanged];
  return appendEvent(envelope(ctx, 'wave-merged', payload, taskId), opts);
}

/**
 * Record that a task is blocked by a classified error. `error` must be a
 * taxonomy error class — appendEvent enforces that, and a `coordination.`
 * prefix is what makes the projector escalate rather than block, so a
 * mis-typed class is a wrong status, not just a wrong label.
 */
export async function emitTaskBlocked(
  taskId: string,
  error: TaskErrorInput,
  ctx: TaskEventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  return appendEvent(
    envelope(
      ctx,
      'error-logged',
      {
        error: error.error,
        severity: error.severity,
        task_ref: taskId,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
      taskId,
    ),
    opts,
  );
}

/**
 * The id of the follow-up task an unownable finding opens against its epic
 * (D-41/P9-24). Derived from the fingerprint so it is stable: re-running the
 * same gate over the same evidence re-derives the same id and
 * `emitFollowUpTask` recognises it as already written, rather than minting a
 * second task for one bug.
 *
 * The `followup-` prefix keeps it clear of db/projector.ts's `isReservedRef`
 * guard, which drops any id whose last segment is `integration` or a
 * `plan-v<n>` plan ref — a follow-up that the projector refused to
 * materialise would block nothing.
 */
export function followUpTaskId(epicId: string, fingerprint: string): string {
  return `${epicId}/followup-${fingerprint.slice(0, 8)}`;
}

export interface FollowUpTaskInput {
  epicId: string;
  /** From `followUpTaskId`; passed in so the caller can attach findings to it. */
  taskId: string;
  objective: string;
  /** The file the finding is anchored to — the only claim a follow-up starts with. */
  claims: string[];
}

/**
 * Record a follow-up task for a finding no open task can own: the file's
 * owner already merged, two tasks claim it equally, or nobody claims it at
 * all. `origin: escalation` because that is literally what happened — the
 * gate could not settle it and handed it up to the epic.
 *
 * Returns null when the session already carries this task, so a re-run is a
 * no-op rather than a duplicate. The task is `todo`, which is not terminal-OK,
 * so epic.ts's `summarizeEpic` blocks the epic verdict on it until an operator
 * plans or waives it — the "blocks the epic verdict instead of an unrelated
 * diff" half of P9-24, using the machinery that was already there.
 */
export async function emitFollowUpTask(
  input: FollowUpTaskInput,
  ctx: TaskEventContext,
  opts: EventOpts = {},
): Promise<StoredEvent | null> {
  const added = await idsAlreadyEmitted('task-added', ctx, opts);
  if (added.has(input.taskId)) return null;

  return appendEvent(
    envelope(
      ctx,
      'task-added',
      {
        epic_id: input.epicId,
        case: 'bugfix',
        origin: 'escalation',
        task_status: 'todo',
        plan_version: ctx.planVersion,
        objective: input.objective,
        claims: input.claims,
      },
      input.taskId,
    ),
    opts,
  );
}

/**
 * Record that a task was replaced by a later plan version. Resolves against
 * the log's register too (D-48/P9-31): superseding is one of the two terminal
 * exits a follow-up needs, and a follow-up is never in the plan.
 */
export async function emitTaskSuperseded(
  plan: PlanFile,
  typed: string,
  ctx: TaskEventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  const logged = (await readAddedTasks(ctx, opts)).map((t) => t.taskId);
  const taskId = resolveTaskId(plan, typed, logged);
  return appendEvent(
    envelope(planScoped(ctx, plan), 'task-superseded', { epic_id: plan.epic_id }, taskId),
    opts,
  );
}
