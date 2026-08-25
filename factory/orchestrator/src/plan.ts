import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type TaskBudget, unreadTaskBudgetFields } from './budgets.js';
import { SmithError } from './errors.js';
import { topoSort } from './graph.js';
import { SPECS_ACTIVE_DIR } from './paths.js';
import {
  type CompiledSchemaSet,
  compileSchemas,
  type ValidationIssue,
  validateRecord,
} from './schemas.js';
import {
  loadTaxonomy,
  type Taxonomy,
  TaxonomyError,
  validateRequiredDimensions,
} from './taxonomy.js';

export class PlanError extends SmithError {}

export interface PlanDependencyEdge {
  /** The task that depends on `dependsOn` (must run after it). */
  task: string;
  dependsOn: string;
  edge_type: string;
  edge_provenance: string;
}

/** A task spec as it lives inside a plan file; validated fully via schemas.ts. */
export type TaskSpecRecord = Record<string, unknown> & {
  task_id: string;
  task_status: string;
  plan_version: number;
};

/**
 * How much judgment an epic buys, cheapest first — factory/policies/effort.yml
 * declares what each tier means; this is only the closed list of names, kept
 * here beside the `PlanFile.effort` field it types. effort.ts is the semantic
 * owner and re-exports these; it cannot own the list itself, because plan.ts
 * would then have to import it to validate a plan and effort.ts already
 * (transitively) imports plan.ts.
 */
export const EFFORT_TIERS = ['small', 'medium', 'huge'] as const;

export type EffortTier = (typeof EFFORT_TIERS)[number];

export function isEffortTier(value: unknown): value is EffortTier {
  return typeof value === 'string' && (EFFORT_TIERS as readonly string[]).includes(value);
}

export interface PlanFile {
  epic_id: string;
  version: number;
  status: string; // taxonomy plan_status
  tasks: TaskSpecRecord[];
  edges: PlanDependencyEdge[];
  /**
   * Phase 6b: optional plain-string project identifier (architecture §8 —
   * NOT a closed taxonomy.yml vocabulary value, same rationale as
   * task-spec.schema.json's `project` field). A plan with no `project`
   * belongs to the default 'black-smith' project.
   */
  project?: string;
  /**
   * How much judgment this epic buys: 'small' | 'medium' | 'huge'
   * (factory/policies/effort.yml, read by `smith effort show`). Chosen at
   * `/bs plan` time and carried across amendments by `draftNextVersion` — a
   * plan v2 that silently reverted to the policy default would make the
   * operator's choice a per-version accident.
   *
   * Optional, and typed `string` rather than `EffortTier` on purpose: plan
   * files are JSON off disk, so the value is untrusted until `validatePlan`
   * checks it. effort.ts's `isEffortTier` is the narrowing.
   */
  effort?: string;
}

export interface PlanOpts {
  specsDir?: string;
  taxonomy?: Taxonomy;
  schemas?: CompiledSchemaSet;
}

export type PlanValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

/**
 * Pseudo task-id ref for a PLAN-level (not task-level) event: planQuorum.ts's
 * runPlanQuorum() stamps it onto the dispatch_decision/judge-verdict/
 * quorum-decision events its quorum case emits, so provider-agreement
 * analytics group a plan critique like any other dispatch. It is not a task —
 * db/projector.ts's foldTasks() refuses to materialise a row for it, exactly
 * as it does for worktree.ts's `<epic>/integration`. Lives here rather than in
 * planQuorum.ts so the projector can recognise the shape without importing a
 * quorum host (wrong dependency direction: db/ is below the hosts, not above).
 */
export function planRefTaskId(epicId: string, version: number): string {
  return `${epicId}/plan-v${version}`;
}

const PLAN_REF_PATTERN = /^plan-v\d+$/;

/** Counterpart to planRefTaskId(): does this task_id name a plan version rather than a task? */
export function isPlanRefTaskId(taskId: string): boolean {
  const last = taskId.split('/').pop();
  return last !== undefined && PLAN_REF_PATTERN.test(last);
}

/**
 * Mint a task id from the plan rather than trusting the one that was typed.
 *
 * D-46/P9-29: the dogfood epic ended with a phantom task row because one
 * human admitted `envkit/task-1-parse-quotes` and another merged
 * `task-1-parse-quotes`. Nothing in the system objected, because nothing in
 * the system owned the id — it was whatever reached the keyboard. There is
 * no "correct" convention to standardise on here; the plan file already IS
 * the register of what exists, so the fix is to make every producer resolve
 * through it. Both spellings map to the one string the plan holds, an id the
 * plan does not contain is a typed error rather than a silent miss, and an
 * id two tasks could equally mean is refused instead of guessed.
 *
 * D-48/P9-31: the plan is not the *only* register. A follow-up task minted by
 * `findings raise` is written to the event log and nowhere else — the plan
 * that was cut before the finding existed cannot name it. A resolver that
 * consults the plan alone therefore refuses the very task the factory has
 * just created, and the follow-up sits `todo` forever with `smith event
 * append` as its only exit. `alsoKnown` is that second register: ids the log
 * has added. A task found in either source is real; one found in neither is
 * still a typed error, and the message names both places it was looked for.
 */
/**
 * The epic-qualified/bare spelling rule of resolveTaskId, exported so callers
 * that compare ids across two registers — the plan file and the event log —
 * apply the same one. `epic-1/task-1` and `task-1` are the same task under
 * plan `epic-1`; `epic-2/task-1` is not.
 */
export function bareTaskId(epicId: string, taskId: string): string {
  return taskId.startsWith(`${epicId}/`) ? taskId.slice(epicId.length + 1) : taskId;
}

export function resolveTaskId(
  plan: PlanFile,
  typed: string,
  alsoKnown: readonly string[] = [],
): string {
  const qualified = `${plan.epic_id}/${typed}`;

  const known = [...plan.tasks.map((t) => t.task_id), ...alsoKnown];
  const matches = known.filter(
    (id) =>
      id === typed ||
      id === qualified ||
      bareTaskId(plan.epic_id, id) === bareTaskId(plan.epic_id, typed),
  );

  const unique = [...new Set(matches)];
  if (unique.length === 1) return unique[0] as string;

  if (unique.length === 0) {
    const fromLog =
      alsoKnown.length === 0 ? '' : ` Added by the log: ${[...new Set(alsoKnown)].join(', ')}.`;
    throw new PlanError(
      'plan.unknown-task',
      `Plan "${plan.epic_id}" v${plan.version} has no task "${typed}". Known task ids: ${plan.tasks
        .map((t) => t.task_id)
        .join(', ')}.${fromLog}`,
      { epicId: plan.epic_id, version: plan.version, typed },
    );
  }

  throw new PlanError(
    'plan.ambiguous-task',
    `Task id "${typed}" is ambiguous in plan "${plan.epic_id}" v${plan.version} — it could mean ${unique.join(
      ' or ',
    )}. Use the full id the plan lists.`,
    { epicId: plan.epic_id, version: plan.version, typed, candidates: unique },
  );
}

export interface PlanChanges {
  added?: TaskSpecRecord[];
  /** task_id -> the replacement task spec that supersedes it in the new version. */
  supersede?: Record<string, TaskSpecRecord>;
  newEdges?: PlanDependencyEdge[];
}

export interface PlanDiff {
  added: string[];
  removed: string[];
  superseded: string[];
  carried: string[];
}

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

function resolveTaxonomyAndSchemas(opts: PlanOpts): {
  taxonomy: Taxonomy;
  schemas: CompiledSchemaSet;
} {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(cachedTaxonomy);
  const taxonomy = opts.taxonomy ?? cachedTaxonomy;
  const schemas = opts.schemas ?? cachedSchemas;
  return { taxonomy, schemas };
}

function planFilePath(epicId: string, version: number, opts: PlanOpts): string {
  const dir = opts.specsDir ?? SPECS_ACTIVE_DIR;
  return path.join(dir, epicId, `plan-v${version}.json`);
}

const PLAN_FILE_PATTERN = /^plan-v(\d+)\.json$/;

/**
 * The highest plan version written for an epic, or null when the epic has no
 * plan directory — which is not an error. Phase 9 was driven as punch-list
 * branches rather than from plan files, and `epic verdict` must still be able
 * to close those epics (D-126: a missing plan casts no vote; a present one
 * does).
 */
export function latestPlanVersion(epicId: string, opts: PlanOpts = {}): number | null {
  const dir = path.join(opts.specsDir ?? SPECS_ACTIVE_DIR, epicId);
  if (!existsSync(dir)) return null;
  let latest: number | null = null;
  for (const entry of readdirSync(dir)) {
    const m = PLAN_FILE_PATTERN.exec(entry);
    if (m === null) continue;
    const version = Number(m[1]);
    if (latest === null || version > latest) latest = version;
  }
  return latest;
}

export function loadPlan(epicId: string, version: number, opts: PlanOpts = {}): PlanFile {
  const filePath = planFilePath(epicId, version, opts);
  if (!existsSync(filePath)) {
    throw new PlanError('plan.not-found', `No plan file at ${filePath}.`, { epicId, version });
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as PlanFile;
}

/**
 * Reduce an `output_schema_ref` to the name the compiled schema set knows it
 * by. `compileSchemas` keys on filename-minus-`.schema.json`, so a path, a
 * bare filename, a `$id` URL and a bare name all have to land on the same
 * key. Deliberately permissive about the shape of the ref and strict only
 * about whether the thing it names exists (P9-20 / D-7).
 */
function schemaRefName(ref: string): string {
  const last = ref.split(/[/\\]/).pop() ?? ref;
  return last.replace(/\.schema\.json$/, '').replace(/\.json$/, '');
}

/**
 * Append the legal vocabulary to a taxonomy rejection. validateTag already
 * carries `allowed` in its details and drops it from the sentence; a plan
 * author reading a validation report has no other way to see the list, and
 * "unknown value" without the list is the exact shape of the finding.
 */
function describeAllowed(err: TaxonomyError): string {
  const allowed = err.details.allowed;
  if (!Array.isArray(allowed) || allowed.length === 0) return '';
  return ` Valid: ${allowed.join(', ')}.`;
}

/**
 * Validate a plan: every task spec schema/taxonomy-valid, every declared
 * taxonomy dimension on an edge a real value in that vocabulary, dependency
 * edges reference real tasks, and the dependency graph is acyclic. A cycle is
 * fatal and thrown immediately (typed error) rather than accumulated —
 * everything else is collected and returned.
 *
 * P9-20 / D-6: taxonomy.yml has declared `edge_type` and `edge_provenance`
 * required on an edge since v2, and nothing checked membership at the point
 * of writing — a plan carrying `"edge_type": "NOT-A-REAL-EDGE-TYPE"`
 * validated clean. Task specs got this for free through validateRecord's
 * `x-taxonomy` pointers; edges have no schema, so they go through
 * validateRequiredDimensions directly rather than acquiring a second register
 * of what an edge must carry, which could then drift from taxonomy.yml's.
 */
export function validatePlan(plan: PlanFile, opts: PlanOpts = {}): PlanValidationResult {
  const { taxonomy, schemas } = resolveTaxonomyAndSchemas(opts);
  const errors: ValidationIssue[] = [];

  const taskIds = new Set(plan.tasks.map((t) => t.task_id));

  // The effort tier is a closed vocabulary (factory/policies/effort.yml), and
  // a typo in it is the worst kind of quiet: `smith effort show` would read
  // "hgue" as "no tier named" and hand back the policy default, so an epic the
  // operator meant to run at full depth would run at the default one instead.
  // Caught here, at plan time, where the file is still being written.
  if (plan.effort !== undefined && !isEffortTier(plan.effort)) {
    errors.push({
      path: '/effort',
      message: `Effort tier "${String(plan.effort)}" is not one of ${EFFORT_TIERS.join(', ')} (factory/policies/effort.yml). Omit the field to take the policy default.`,
    });
  }

  for (const t of plan.tasks) {
    const result = validateRecord(schemas, taxonomy, 'task-spec', t);
    if (!result.valid) {
      for (const issue of result.errors) {
        errors.push({ path: `/tasks/${t.task_id}${issue.path}`, message: issue.message });
      }
    }
    if (t.plan_version !== plan.version) {
      errors.push({
        path: `/tasks/${t.task_id}/plan_version`,
        message: `Task plan_version ${t.plan_version} does not match plan version ${plan.version}.`,
      });
    }
    // Shape is the schema's business; this only asks whether each declared
    // field has anything that can read it.
    const budget = (
      typeof t.budget === 'object' && t.budget !== null ? t.budget : {}
    ) as TaskBudget;
    for (const field of unreadTaskBudgetFields(budget)) {
      errors.push({
        path: `/tasks/${t.task_id}/budget/${field}`,
        message: `Budget field "${field}" has no mechanical reader: nothing in the factory can enforce it, so declaring it here states a limit the task will never be held to. Carry the number in the dispatch prompt instead, where it reads as the request it is (agent-interviews.md M-4).`,
      });
    }
    // D-7: the ref is what result.schema.json defers structured_output's shape
    // to, so a ref naming a schema the factory does not have is a check that
    // silently never runs. Reported here, at plan time, rather than at gate
    // intake where the task is already coded.
    const ref = t.output_schema_ref;
    if (typeof ref === 'string' && ref !== '' && !schemas.has(schemaRefName(ref))) {
      errors.push({
        path: `/tasks/${t.task_id}/output_schema_ref`,
        message:
          `output_schema_ref "${ref}" names no schema in factory/specs/schema. ` +
          `Available: ${[...schemas.keys()].sort().join(', ')}.`,
      });
    }
  }

  plan.edges.forEach((edge, index) => {
    if (!taskIds.has(edge.task)) {
      errors.push({ path: '/edges', message: `Edge references unknown task "${edge.task}".` });
    }
    if (!taskIds.has(edge.dependsOn)) {
      errors.push({
        path: '/edges',
        message: `Edge references unknown dependsOn "${edge.dependsOn}".`,
      });
    }
    try {
      validateRequiredDimensions(taxonomy, 'edge', edge as unknown as Record<string, unknown>);
    } catch (err) {
      // Accumulated, not thrown: a plan with three bad edges should name all
      // three in one pass, the way three bad task specs already do. Only a
      // cycle is fatal here.
      if (!(err instanceof TaxonomyError)) throw err;
      errors.push({
        path: `/edges/${index}`,
        message: `Edge ${edge.task} <- ${edge.dependsOn}: ${err.message}${describeAllowed(err)}`,
      });
    }
  });

  const topo = topoSort(
    [...taskIds],
    plan.edges.map((e) => ({ task: e.task, dependsOn: e.dependsOn })),
  );
  if (!topo.ok) {
    throw new PlanError(
      'plan.cyclic-dependency',
      `Plan "${plan.epic_id}" v${plan.version} has a cyclic dependency among tasks: ${topo.cycle.join(', ')}.`,
      { cycle: topo.cycle },
    );
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}

function writePlanFile(plan: PlanFile, opts: PlanOpts): void {
  const filePath = planFilePath(plan.epic_id, plan.version, opts);
  if (existsSync(filePath)) {
    throw new PlanError(
      'plan.version-exists',
      `Refusing to overwrite existing plan file ${filePath} — plans are immutable.`,
      { filePath },
    );
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

/**
 * The v(n+1) a set of changes WOULD produce: everything `nextVersion` does
 * except put it on disk.
 *
 * Split out for D-127. `amendPlan` has to know the diff before it can decide
 * whether the amendment is legal at all — an amendment that adds and
 * supersedes nothing obligates nothing, and a finding obligating nothing is
 * discharged the instant the version is cut. The diff is only computable
 * against the new version, so either that check runs after a plan file exists
 * (and nothing in this codebase deletes a plan file) or the construction is
 * available without the write. This is that. Pure and deterministic: the
 * caller that validates against the draft and then cuts through `nextVersion`
 * gets the same file both times.
 */

/**
 * A closed vocabulary, so it can be named in an error without quoting a
 * value (D-198). Exported so epic.ts's summarizeEpic can name the same
 * shape of corruption in a malformed `amends_task_ids` entry the same way.
 */
export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse a `changes.supersede` no map-shaped read can make, before
 * `draftNextVersion` iterates it as one.
 *
 * D-21: an operator passed `supersede` as an array of task-id strings.
 * `task_id in supersede` was false for every task (arrays have numeric
 * keys, not the task_id strings under test), and `Object.values(anArray)`
 * handed back the array's own elements — a bare string — which
 * `{ ...aString }` then spread character-by-character into a "task record"
 * with no `task_id` at all. That record reached `amendPlan`, which wrote it
 * to an immutable plan file and reported success; `smith plan validate`
 * rejected the file the tool had just produced. Refusing the shape here,
 * before anything is spread, is what closes that hole — and the message
 * names the map-vs-array mistake explicitly, since that is the mistake that
 * actually happened.
 */
function readSupersedeMap(
  epicId: string,
  version: number,
  supersede: unknown,
): Record<string, TaskSpecRecord> {
  if (supersede === undefined) return {};
  if (!isPlainObject(supersede)) {
    const arrayNote = Array.isArray(supersede)
      ? ' supersede is a map keyed by the task_id each entry replaces (e.g. ' +
        '{"epic-1/task-3": {...replacement}}) — a list of task ids is a different shape ' +
        'and replaces nothing.'
      : '';
    throw new PlanError(
      'plan.unreadable-supersede',
      `Refusing to draft plan "${epicId}" v${version}: changes.supersede is ${describeType(supersede)}, not a map of task_id to replacement task record.${arrayNote}`,
      { epicId, version, received: describeType(supersede) },
    );
  }
  for (const [key, value] of Object.entries(supersede)) {
    if (!isPlainObject(value) || typeof value.task_id !== 'string') {
      throw new PlanError(
        'plan.unreadable-supersede-entry',
        `Refusing to draft plan "${epicId}" v${version}: changes.supersede["${key}"] is ${describeType(value)}, not a task record carrying a string task_id.`,
        { epicId, version, key, received: describeType(value) },
      );
    }
  }
  return supersede as Record<string, TaskSpecRecord>;
}

/**
 * Same guard as `readSupersedeMap`, for `changes.added`: a plain list whose
 * entries are task-record-shaped objects carrying a string `task_id`. Same
 * treatment because the failure is the same shape of mistake — an entry this
 * codebase would otherwise spread into a plan file with no `task_id` to
 * identify it by.
 */
function readAddedList(epicId: string, version: number, added: unknown): TaskSpecRecord[] {
  if (added === undefined) return [];
  if (!Array.isArray(added)) {
    throw new PlanError(
      'plan.unreadable-added',
      `Refusing to draft plan "${epicId}" v${version}: changes.added is ${describeType(added)}, not a list of task records.`,
      { epicId, version, received: describeType(added) },
    );
  }
  added.forEach((t, index) => {
    if (!isPlainObject(t) || typeof t.task_id !== 'string') {
      throw new PlanError(
        'plan.unreadable-added-entry',
        `Refusing to draft plan "${epicId}" v${version}: changes.added[${index}] is ${describeType(t)}, not a task record carrying a string task_id.`,
        { epicId, version, index, received: describeType(t) },
      );
    }
  });
  return added as TaskSpecRecord[];
}

export function draftNextVersion(prev: PlanFile, changes: PlanChanges): PlanFile {
  const newVersion = prev.version + 1;
  const supersede = readSupersedeMap(prev.epic_id, newVersion, changes.supersede);

  const carried: TaskSpecRecord[] = [];
  for (const t of prev.tasks) {
    if (t.task_status === 'completed' && !(t.task_id in supersede)) {
      continue; // done; not carried into the live backlog
    }
    if (t.task_id in supersede) {
      carried.push({ ...t, task_status: 'superseded', plan_version: newVersion });
      continue;
    }
    carried.push({ ...t, plan_version: newVersion });
  }

  const replacements = Object.values(supersede).map((t) => ({ ...t, plan_version: newVersion }));
  const added = readAddedList(prev.epic_id, newVersion, changes.added).map((t) => ({
    ...t,
    plan_version: newVersion,
  }));

  const tasks = [...carried, ...replacements, ...added];
  // An edge may only name a task this version declares -- `validatePlan`'s own
  // rule. Dropping a completed task from the live backlog is what breaks it:
  // the id leaves, the edges pointing at it did not, and v(n+1) then failed the
  // validation the operator guide tells the operator to run, on an id the file
  // no longer mentions. Plans are immutable and nothing deletes one, so that
  // left no way out.
  //
  // Dropping the edge loses nothing: the only ids that leave are completed and
  // not superseded, so the ordering constraint is already discharged, and a
  // superseded task is carried forward (as `superseded`) and keeps its edges.
  // Applied to the CARRIED edges only -- an edge this amendment adds is
  // something the author wrote, and deleting it silently would answer a typo
  // with a plan that no longer says what they asked for. `validatePlan` names
  // that one instead.
  const declared = new Set(tasks.map((t) => t.task_id));
  const carriedEdges = prev.edges.filter((e) => declared.has(e.task) && declared.has(e.dependsOn));

  return {
    epic_id: prev.epic_id,
    version: newVersion,
    status: 'active',
    tasks,
    edges: [...carriedEdges, ...(changes.newEdges ?? [])],
    ...(prev.project ? { project: prev.project } : {}),
    ...(prev.effort ? { effort: prev.effort } : {}),
  };
}

/**
 * Cut plan v(n+1): carries forward unfinished tasks (bumping plan_version),
 * marks superseded tasks, adds new tasks, and writes the new immutable
 * version file. Never mutates the previous version's file.
 *
 * The only function in this codebase that puts a plan version on disk — which
 * is why `draftNextVersion` is exported for inspection and `writePlanFile`
 * is not: a caller that could write half of a version could write a version
 * no event explains.
 */
export function nextVersion(prev: PlanFile, changes: PlanChanges, opts: PlanOpts = {}): PlanFile {
  const newPlan = draftNextVersion(prev, changes);
  writePlanFile(newPlan, opts);
  return newPlan;
}

/**
 * The task id's live spec in a plan version: the last record that has not
 * been superseded, or undefined when every record for that id is dead.
 *
 * A plan version holds each superseded copy of a task *alongside* its
 * replacement, and both carry the same `task_id` whenever the amendment kept
 * the id (D-121) — so "the spec for this id" is only well defined once the
 * dead copies are set aside. Indexing the whole task list into a Map by id
 * silently answers with whichever record happened to be written last.
 */
function liveSpec(plan: PlanFile, id: string): TaskSpecRecord | undefined {
  let found: TaskSpecRecord | undefined;
  for (const t of plan.tasks) {
    if (t.task_id === id && t.task_status !== 'superseded') found = t;
  }
  return found;
}

/**
 * Every id's live spec, in plan order — the same `liveSpec` rule applied to
 * the whole file rather than one id, so a reader can ask "what does this plan
 * version still claim?" without re-deriving the supersede semantics.
 *
 * D-126: this is what `epic verdict` consults. `plan.tasks` itself is the
 * wrong answer to that question, because it also holds every dead record the
 * amendments left behind.
 */
export function livePlanTasks(plan: PlanFile): TaskSpecRecord[] {
  const seen = new Set<string>();
  const live: TaskSpecRecord[] = [];
  for (const t of plan.tasks) {
    if (seen.has(t.task_id)) continue;
    seen.add(t.task_id);
    const spec = liveSpec(plan, t.task_id);
    if (spec !== undefined) live.push(spec);
  }
  return live;
}

/**
 * What makes two records the same *spec*: everything except the version stamp
 * and the workflow status. `nextVersion` rewrites `plan_version` on every
 * record it carries, and a task moving todo → in-progress is not an
 * amendment; neither may register as a spec change.
 *
 * Nested key order is inherited from whichever JSON the record was parsed
 * from, so this compares as text rather than structurally. That is the safe
 * direction: a reordered-but-identical spec reads as *superseded*, which
 * tells the operator to look, whereas the failure being fixed here is a
 * changed spec reading as *carried*, which tells them not to.
 */
function specSignature(t: TaskSpecRecord): string {
  const entries = Object.entries(t)
    .filter(([k]) => k !== 'plan_version' && k !== 'task_status')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Diff two plan versions: added / removed / superseded / carried task ids.
 *
 * `superseded` means "this id's live spec was replaced between A and B",
 * which is the question an amendment is actually asking. It deliberately does
 * not read `task_status === 'superseded'` off a single record: `supersede` is
 * keyed by task_id and a replacement that keeps its id — the shape every real
 * amendment has used — leaves the plan holding a dead record and a live one
 * under the same key.
 */
export function diffPlans(vA: PlanFile, vB: PlanFile): PlanDiff {
  const aIds = new Set(vA.tasks.map((t) => t.task_id));
  const bIds = new Set(vB.tasks.map((t) => t.task_id));

  const added: string[] = [];
  const superseded: string[] = [];
  const carried: string[] = [];
  const removed: string[] = [];

  for (const id of bIds) {
    if (!aIds.has(id)) added.push(id);
  }

  for (const id of aIds) {
    if (!bIds.has(id)) {
      removed.push(id);
      continue;
    }
    const liveA = liveSpec(vA, id);
    const liveB = liveSpec(vB, id);
    // A live spec that lost its replacement (renamed away, or retired) counts
    // as superseded too — the id survives in the file only as a dead record.
    const same =
      liveA === undefined
        ? liveB === undefined
        : liveB !== undefined && specSignature(liveA) === specSignature(liveB);
    (same ? carried : superseded).push(id);
  }

  return { added, removed, superseded, carried };
}
