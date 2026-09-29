import { readFileSync } from 'node:fs';
import { JUDGE_REPORT_EVENT_TYPE } from './agents-registry.js';
import { AUDIT_AXES } from './audit.js';
import { sessionOwnerRole } from './delegation.js';
import { SmithError } from './errors.js';
import {
  appendEvent,
  type EventOpts,
  eventTaskId,
  readLineageEvents,
  type StoredEvent,
} from './events.js';
import { type CompiledSchemaSet, compileSchemas, validateEachShape } from './schemas.js';
import { isQualifiedTaskId, taskIdsMatch } from './taskId.js';
import { loadTaxonomy, type Taxonomy } from './taxonomy.js';

export class JudgeError extends SmithError {}

/**
 * A dispatched judge must report back, and the report is a file (D-31, D-20 /
 * P9-11).
 *
 * Wave 3 dispatched eight agents and five ended their turn on an announcement
 * of the next step they were about to take — "Now let's run the
 * prototype-pollution probes" — signalled `completed` to the layer above, and
 * wrote nothing. All five finished correctly on one resume, in 1–13 tool
 * calls, so the work was cheap and the silence was the entire defect. Wave 4
 * showed the sharper version: a reviewer that returned 36k tokens of fluent,
 * on-topic, technically accurate prose which was a fragment of its own
 * planning. An empty return is detectable. A plausible fragment is not.
 *
 * So completion here is never "the agent said something". It is "the artifact
 * exists and parses" — checked by this module, against a path the DISPATCH
 * declared in advance, so nobody gets to pick the finish line after the fact.
 *
 * The two halves are ordinary events, which is what lets anything downstream
 * notice a gap:
 *
 *   - dispatch: a `dispatch_decision` carrying `declared_artifact` and
 *     `round` on top of the three dimensions taxonomy.yml already requires of
 *     a dispatch. It is a normal dispatch record — agents-registry.ts folds it
 *     unchanged — and `declared_artifact` is what marks it as a turn that owes
 *     a report. A coder's dispatch declares no artifact and is not a judge.
 *   - report: a `judge-reported` carrying `agent_role`, `round`,
 *     `artifact_path` and `finding_count`.
 *
 * The difference between the two sets is `outstandingJudges()`, and the gate
 * refuses to score a task while it is non-empty.
 */
export const JUDGE_DISPATCH_EVENT_TYPE = 'dispatch_decision';
/**
 * Re-exported, not re-declared. The registry owns the terminal-event
 * vocabulary — this one next to `task-result-recorded` and `error-logged`,
 * which are the other two ways a turn can end — and a judge report is one of
 * its three. Two `= 'judge-reported'` literals in two modules is two places to
 * keep in sync, and the day they disagree the registry stops recognising the
 * report this file writes.
 */
export { JUDGE_REPORT_EVENT_TYPE };

/**
 * Every judge dispatched from the operator session runs on the native provider
 * at its top tier unless the caller says otherwise.
 *
 * The concrete model gets no such default (P9-23). Provider and tier are coarse
 * enough that a wrong default is visibly wrong; a model id is not, and this
 * verb is exactly how crosscheck.yml's finder_ne_critic pair (reviewer /
 * verifier) reaches the log. `smith dispatch check` compares those two ids, so
 * a defaulted one would have it compare two placeholders and report on a
 * session nobody ran.
 */
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_MODEL_TIER = 'frontier';

/** `--no-findings`: an operator attesting that a judge ran clean, recorded as an attestation and never as an artifact. */
const ATTESTED_BY = 'operator';

export interface EventContext {
  sessionId: string;
  planVersion: number;
  causalParent: string | null;
  actor?: string;
}

export interface JudgeDispatchInput {
  taskId: string;
  /** A taxonomy `agent` value; validated by appendEvent against the dispatch record's required dimensions. */
  role: string;
  /** 1-based. A judge re-dispatched for the same task opens a new round, and the earlier one stops being owed. */
  round: number;
  /** Where this judge will write its findings evidence. Declared now, checked later. */
  artifactPath: string;
  /**
   * The concrete model this judge runs on — required, presence-checked only
   * (taxonomy.yml keeps `model` open: model names change monthly). See the
   * DEFAULT_PROVIDER comment for why this one has no default.
   */
  model: string;
  provider?: string;
  modelTier?: string;
}

export interface JudgeReportInput {
  taskId: string;
  role: string;
  /** Defaults to the role's latest dispatched round. */
  round?: number;
  /** Defaults to the path the dispatch declared. */
  artifactPath?: string;
  /** The genuinely clean case, said out loud: no artifact, recorded as an operator attestation. */
  noFindings?: boolean;
}

/** One judge turn: a dispatch that declared an artifact, and whether its report has landed. */
export interface JudgeTurn {
  taskId: string;
  role: string;
  round: number;
  declaredArtifact: string;
  reported: boolean;
  /** The path the report actually named; null for an attestation. */
  reportedArtifact: string | null;
  /** True when the report was an operator attestation rather than a file on disk. */
  attested: boolean;
}

export interface JudgeReport {
  taskId: string;
  role: string;
  round: number;
  artifactPath: string | null;
  findingCount: number;
  attested: boolean;
}

/**
 * The turn a record belongs to, tolerating the two spellings of one task id.
 *
 * Both halves of a turn are stamped with whatever the operator typed:
 * `smith judge dispatch --task` and `smith gate run <task-id>` pass their
 * argument through verbatim, and neither qualifies it. Keyed on the raw
 * string, a dispatch recorded as `epic-1/task-1` and a gate run asking for
 * `task-1` were two different turns, so the fold handed back an empty set —
 * which `outstandingJudges` cannot tell apart from "every judge reported"
 * (D-183).
 *
 * A bare id that two epics both claim matches more than one turn, and this
 * returns none of them: closing one epic's judge with the other's report is
 * the failure this guard exists to prevent, and `buildTaskIdAliases` refuses
 * exactly the same ambiguity. Leaving both outstanding blocks the gate, and
 * the operator's remedy is to qualify the id.
 */
function findTurn(
  turns: readonly JudgeTurn[],
  taskId: string,
  role: string,
): JudgeTurn | undefined {
  const matching = turns.filter((t) => t.role === role && taskIdsMatch(t.taskId, taskId));
  return matching.length === 1 ? matching[0] : undefined;
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(payload: Record<string, unknown>, field: string): number | undefined {
  const value = payload[field];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Fold the dispatch set and the report set into one turn per (task, role).
 *
 * Two passes, not one, because the log's order is real: a round-1 report that
 * lands after a round-2 dispatch must NOT close round 2. Pass one settles
 * which round each role is on; pass two closes only a report that names that
 * round. The alternative — a single pass that resets `reported` on each new
 * dispatch — gets the same answer for a well-ordered log and the wrong one for
 * a log where a slow judge's report arrives late.
 *
 * A role's earlier rounds are superseded rather than kept outstanding: the
 * same rule agents-registry.ts already applies to a re-dispatched task, and
 * without it every re-poke would leave a permanent phantom in the outstanding
 * list.
 */
export function foldJudgeTurns(events: readonly StoredEvent[], taskId?: string): JudgeTurn[] {
  const turns: JudgeTurn[] = [];

  for (const { record } of events) {
    if (record.event_type !== JUDGE_DISPATCH_EVENT_TYPE) continue;
    // Both levels: the dispatch that owes a report may name its task only in
    // its payload (D-245), and a turn opened under no task is a report nobody
    // can ever close.
    const recordTaskId = eventTaskId(record);
    if (recordTaskId === null) continue;
    if (taskId !== undefined && !taskIdsMatch(recordTaskId, taskId)) continue;
    const role = stringField(record.payload, 'agent_role');
    const declaredArtifact = stringField(record.payload, 'declared_artifact');
    const round = numberField(record.payload, 'round');
    // No declared artifact, no report owed: this is a coder or a merger, not
    // a judge. `round` is required alongside it, so a half-formed payload is
    // ignored rather than folded into a turn nobody can ever close.
    if (role === undefined || declaredArtifact === undefined || round === undefined) continue;

    const existing = findTurn(turns, recordTaskId, role);
    if (existing !== undefined) {
      if (existing.round > round) continue;
      // The qualified spelling wins the row it names: it is the one a caller
      // can hand back to anything that needs the epic.
      existing.taskId = isQualifiedTaskId(existing.taskId) ? existing.taskId : recordTaskId;
      existing.round = round;
      existing.declaredArtifact = declaredArtifact;
      existing.reported = false;
      existing.reportedArtifact = null;
      existing.attested = false;
      continue;
    }
    turns.push({
      taskId: recordTaskId,
      role,
      round,
      declaredArtifact,
      reported: false,
      reportedArtifact: null,
      attested: false,
    });
  }

  for (const { record } of events) {
    if (record.event_type !== JUDGE_REPORT_EVENT_TYPE) continue;
    const recordTaskId = eventTaskId(record);
    if (recordTaskId === null) continue;
    if (taskId !== undefined && !taskIdsMatch(recordTaskId, taskId)) continue;
    const role = stringField(record.payload, 'agent_role');
    if (role === undefined) continue;
    const turn = findTurn(turns, recordTaskId, role);
    if (turn === undefined || turn.round !== numberField(record.payload, 'round')) continue;
    turn.reported = true;
    turn.reportedArtifact = stringField(record.payload, 'artifact_path') ?? null;
    turn.attested = record.payload.attested_by !== undefined && record.payload.attested_by !== null;
  }

  return [...turns].sort((a, b) => a.role.localeCompare(b.role));
}

/** The judges a task is still waiting on — the whole point of recording either half. */
export function outstandingJudges(turns: readonly JudgeTurn[]): JudgeTurn[] {
  return turns.filter((t) => !t.reported);
}

/**
 * Read the turns for one task out of its session's whole lineage.
 *
 * The lineage and not the session, because a judge turn is a promise with two
 * halves and nothing makes them land in the same operator session. An epic
 * that outgrows one session is the recommended shape (P9-7), so round 1
 * dispatches the reviewer and round 2 is where the report — and the gate that
 * reads this — arrives. Folding one session broke that in both directions:
 * `recordJudgeReport` refused a real report as `judges.not-dispatched`, and
 * `outstandingJudges` came back empty, which is the gate scoring a task whose
 * judge never reported. That is precisely the state P9-11 exists to refuse.
 *
 * D-119 swept every deciding fold onto `readLineageEvents` and missed this
 * one: the sweep found its callers by grep, and this file carried a NUL byte
 * that made grep skip it in silence (D-155). D-156 is the half that survived.
 */
export async function readJudgeTurns(
  taskId: string,
  ctx: Pick<EventContext, 'sessionId'>,
  opts: EventOpts = {},
): Promise<JudgeTurn[]> {
  return foldJudgeTurns(await readLineageEvents(ctx.sessionId, opts), taskId);
}

async function emit(
  eventType: string,
  payload: Record<string, unknown>,
  taskId: string,
  ctx: EventContext,
  opts: EventOpts,
): Promise<StoredEvent> {
  return appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: eventType,
      task_id: taskId,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload,
    },
    opts,
  );
}

/**
 * Who dispatched this session, read off the event graph -- the answer a
 * `dispatch_decision` written with no explicit `--actor` wants before it
 * falls back to `system` (issue #218).
 *
 * `smith judge dispatch` runs inside a wave-runner's own delegated session,
 * and the CLI does not thread an `--actor` through that call. Defaulting to
 * `system` was a placeholder, not a real writer, and `delegation.ts`'s rule 3
 * reads every `dispatch_decision` in a delegated session as a second author
 * unless its `actor` names the role that session belongs to. `sessionOwnerRole`
 * is the same lookup rule 3 already does when it decides whose session this
 * is, so a judge dispatch recorded through this default and a dispatch a
 * wave-runner writes itself land under the same actor -- there is nothing
 * left for rule 3 to flag. A session nothing dispatched (or a P9-7
 * continuation, which is not delegation) still falls through to `system`
 * unchanged, exactly as before.
 */
async function delegatedActor(sessionId: string, opts: EventOpts): Promise<string | undefined> {
  const events = await readLineageEvents(sessionId, opts);
  return sessionOwnerRole(events, sessionId) ?? undefined;
}

/**
 * Record that a judge was dispatched and what file it owes. Emitted by the
 * dispatcher BEFORE the agent runs — a dispatch recorded afterwards could only
 * ever describe judges that came back, which is the set that was never the
 * problem.
 */
export async function recordJudgeDispatch(
  input: JudgeDispatchInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<StoredEvent> {
  if (!Number.isInteger(input.round) || input.round < 1) {
    throw new JudgeError(
      'judges.invalid-round',
      `Judge rounds are 1-based integers; got ${JSON.stringify(input.round)}.`,
      { round: input.round, task_id: input.taskId, agent_role: input.role },
    );
  }
  if (input.artifactPath.trim() === '') {
    throw new JudgeError(
      'judges.no-declared-artifact',
      'A judge dispatch must declare the artifact it will write — that path is the finish line.',
      { task_id: input.taskId, agent_role: input.role },
    );
  }
  // appendEvent would reject this too, on taxonomy grounds. Caught here anyway,
  // so the message names the judge that was about to be dispatched instead of
  // the record type that failed validation.
  if (typeof input.model !== 'string' || input.model.trim() === '') {
    throw new JudgeError(
      'judges.no-model',
      `A judge dispatch must name the model it runs on: "${input.role}" is checked against the finder it followed by model id, not by tier (P9-23).`,
      { task_id: input.taskId, agent_role: input.role },
    );
  }

  // Explicit `--actor` is authoritative and skips this lookup entirely; only
  // an absent actor reaches for the delegated session's owner.
  const actor = ctx.actor ?? (await delegatedActor(ctx.sessionId, opts));

  return emit(
    JUDGE_DISPATCH_EVENT_TYPE,
    {
      agent_role: input.role,
      provider: input.provider ?? DEFAULT_PROVIDER,
      model_tier: input.modelTier ?? DEFAULT_MODEL_TIER,
      model: input.model,
      round: input.round,
      declared_artifact: input.artifactPath,
    },
    input.taskId,
    { ...ctx, actor },
    opts,
  );
}

/** The one judge whose artifact is a verdict document rather than a findings list. */
const GRADER_ROLE = 'grader';

/**
 * Count what a grader's result document holds against the task.
 *
 * The grader's contract is `state/results/<task-id>.grader-r<round>.json`:
 * `{run_status, structured_output: {round, criteria[], overall}}`, the file
 * `gate run --grader` reads. Its findings are the criteria it did not pass —
 * `fail` and `partial` both send the task back — so that is the count the
 * report carries. A `dead` grader is the grader's own word for "nothing here
 * is gradable" (`checkGraderVerdict`): it reported, and found nothing to
 * count. Anything else that is not a `criteria` array is some other shape and
 * gets `undefined`, so the caller refuses it the way it refuses every other
 * non-list. Schema validation stays with the gate: this decides whether the
 * grader *reported*, not whether its verdict holds.
 */
function graderFindingCount(parsed: unknown): number | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  if (document.run_status === 'dead') return 0;
  const structured = document.structured_output;
  if (typeof structured !== 'object' || structured === null) return undefined;
  const criteria = (structured as Record<string, unknown>).criteria;
  if (!Array.isArray(criteria)) return undefined;
  return criteria.filter(
    (c) =>
      !(typeof c === 'object' && c !== null && (c as Record<string, unknown>).status === 'pass'),
  ).length;
}

let cachedTaxonomyForSchemas: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

/**
 * Schemas only — no taxonomy is read on this path, unlike the `{taxonomy,
 * schemas}` pair `events.ts`/`findings.ts` each resolve for themselves.
 * `compileSchemas` still takes a taxonomy argument (it needs one to compile
 * at all), so one is loaded and cached to satisfy that, but nothing here ever
 * reads it back out.
 */
function resolveSchemas(opts: EventOpts): CompiledSchemaSet {
  if (opts.schemas) return opts.schemas;
  if (cachedSchemas === undefined) {
    if (cachedTaxonomyForSchemas === undefined) cachedTaxonomyForSchemas = loadTaxonomy();
    cachedSchemas = compileSchemas(cachedTaxonomyForSchemas);
  }
  return cachedSchemas;
}

function describeShapeFailures(
  failures: readonly { index: number; errors: readonly { message: string }[] }[],
): string {
  return failures
    .map((f) => `index ${f.index} (${f.errors.map((e) => e.message).join('; ')})`)
    .join(', ');
}

/**
 * `mintAuditId` (audit.ts) mints `<YYYYMMDD>-<8 hex>` — a day stamp and eight
 * hex characters joined by "-", never a "/". Audit.md's "Declare the artifact
 * before the call" names the task id an audit axis turn dispatches and
 * reports against as `<audit-id>.<axis>`. An ordinary task id is always
 * "<epic>/<bare>" (taskId.ts) — qualified with a "/" by construction — so the
 * two shapes cannot collide: this checks the exact mint format, not just the
 * absence of "/", so a coincidentally dotted bare task id still reads as
 * ordinary rather than as an axis.
 */
const AUDIT_AXIS_TASK_ID = new RegExp(`^\\d{8}-[0-9a-f]{8}\\.(${AUDIT_AXES.join('|')})$`);

function isAuditAxisTaskId(taskId: string): boolean {
  return AUDIT_AXIS_TASK_ID.test(taskId);
}

/**
 * Whether `role`'s array-shaped artifact, on this `taskId`, is finding-
 * evidence and should be schema-checked. An allow-list, not a blanket check
 * minus exceptions — each entry below was confirmed against the role's own
 * output contract (`.claude/agents/*.md`) and, for `judge dispatch`/`judge
 * report` specifically, `.claude/skills/bs/wave.md`'s list of the judges that
 * bracket ("uiux visual pass, grader, reviewer, verifier, security-reviewer").
 *
 * - `reviewer` (reviewer.md): its whole array is exactly the five
 *   finding-evidence keys.
 * - `security-reviewer` (security-reviewer.md): its per-task array is the
 *   same five keys as `reviewer`'s. Its OTHER artifact — the security axis of
 *   `/bs audit` — carries a sixth key, `confidence`, and drops
 *   `finding_category`, which `additionalProperties: false` rejects; that
 *   shape is validated on its own terms by `smith audit record`, not this
 *   schema. The two are told apart by `taskId`, not by role alone — an
 *   ordinary per-task security review has no other way to distinguish
 *   itself, and leaving the role exempt everywhere (as before) left real
 *   per-task security findings unvalidated.
 * - `GRADER_ROLE`: its declared artifact is a verdict OBJECT, handled by
 *   `graderFindingCount` below and never reaching this check. But `gate run
 *   --evidence <file> --found-by grader` (FD-1) can also close a grader turn
 *   with an ordinary finding-evidence ARRAY, distinct from the `--grader
 *   <file>` verdict-document path, so the role belongs here for that case.
 *
 * Every other role keeps the old count-only behaviour:
 * - `verifier` (verifier.md) reports `{finding_id, verdict, rationale,
 *   failure_scenario}` — echoing a finding back rather than describing a
 *   fresh one — a different, and never finding-evidence, shape by design.
 * - `uiux` (uiux.md): its artifact is always the OBJECT `{run_status,
 *   structured_output, artifacts}`, never an array, so this check never
 *   applies to it regardless of allow-listing.
 * - `auditor`: the other three audit axes, the same AuditEvidenceItem shape
 *   as security-reviewer's audit path — but auditor never reviews a single
 *   task (auditor.md: "never per-task, never for a diff"), so there is no
 *   taskId to gate on; it stays exempt unconditionally.
 * - `spec-reviewer` (spec-reviewer.md): not on the list. Neither of its two
 *   array artifacts — the pre-code/close spec review (finding-evidence
 *   shaped) and the spec-vs-goal coverage check (`{clause, verdict,
 *   taskIds?, reason?}`, not finding-evidence shaped) — currently reaches
 *   this function at all: `smith epic spec-review`/`smith epic goal-check`
 *   read them directly (cli.ts), never through `judge report`, and
 *   wave.md's judge-dispatch/report roster does not name spec-reviewer.
 *   Allow-listing the role here would be inert today and, because its two
 *   artifacts disagree on shape with no taskId to tell them apart the way
 *   security-reviewer's two are told apart, a latent wrong-rejection the day
 *   something does route the goal-coverage array through this same role
 *   string.
 * - anything this taxonomy does not yet name.
 */
function validatesFindingEvidence(role: string | undefined, taskId: string): boolean {
  if (role === 'reviewer' || role === GRADER_ROLE) return true;
  if (role === 'security-reviewer') return !isAuditAxisTaskId(taskId);
  return false;
}

/**
 * Read a judge's artifact and answer how many findings it holds.
 *
 * Three distinct failures, three distinct codes, because they are three
 * different things to do about it: the file is not there (re-poke the agent),
 * it is there and is prose (the agent narrated instead of reporting), it is
 * there and parses but is not a findings list (the agent wrote some other
 * shape).
 *
 * The grader is the one role whose declared shape is not a list: it writes a
 * verdict document, and refusing that document left its turn closable only by
 * a hand-written evidence file (FD-1). For `role === 'grader'`
 * the grader result document is accepted beside the list, and the count is
 * its non-pass criteria. No other role gets that reading — a reviewer that
 * wrote a verdict wrote the wrong shape.
 *
 * A findings-evidence array is schema-validated element-wise before it is
 * even counted (issue #233), but only for the roles `validatesFindingEvidence`
 * names: a malformed array used to close the turn on a finding_count that
 * `mintFindings` would later crash trying to mint from the same file, since
 * `findings raise --evidence`/`gate run --evidence` read the identical
 * artifact. Reusing `finding-evidence.schema.json` here keeps the two intake
 * paths agreeing on what "malformed" means, for the roles that actually write
 * that shape — a role whose real artifact is something else (verifier, an
 * audit axis) is not "malformed" for failing to look like a finding. An empty
 * array has nothing to validate, so `[]` still passes.
 */
export function readJudgeArtifact(
  artifactPath: string,
  role: string | undefined,
  taskId: string,
  opts: EventOpts = {},
): number {
  let raw: string;
  try {
    raw = readFileSync(artifactPath, 'utf8');
  } catch (err) {
    throw new JudgeError(
      'judges.artifact-missing',
      `Judge artifact "${artifactPath}" is not on disk. A judge whose turn ended without its declared file did not report; re-run it rather than scoring without it.`,
      { artifact_path: artifactPath, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JudgeError(
      'judges.artifact-unparseable',
      `Judge artifact "${artifactPath}" is not JSON. Prose in the artifact slot is the wave-4 failure exactly: fluent text that reads like a verdict and is not one.`,
      { artifact_path: artifactPath, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  if (Array.isArray(parsed)) {
    // Only the roles `validatesFindingEvidence` names actually write a
    // finding-evidence array; skipping the check for every other role does
    // not weaken issue #233's guarantee — anything that reaches
    // `mintFindings` is still validated in full before it is minted,
    // regardless of role.
    if (validatesFindingEvidence(role, taskId)) {
      const failures = validateEachShape(resolveSchemas(opts), 'finding-evidence', parsed);
      if (failures.length > 0) {
        throw new JudgeError(
          'judges.artifact-invalid-evidence',
          `Judge artifact "${artifactPath}" holds ${failures.length} item(s) that do not match finding-evidence.schema.json at ${describeShapeFailures(failures)}. Expected {file_path, finding_category, severity, summary, failure_scenario: {inputs, expected, actual}} (criterion_ref optional).`,
          { artifact_path: artifactPath, failures },
        );
      }
    }
    return parsed.length;
  }

  const graderCount = role === GRADER_ROLE ? graderFindingCount(parsed) : undefined;
  if (graderCount !== undefined) return graderCount;

  const accepted =
    role === GRADER_ROLE
      ? 'a findings-evidence array or the grader result document ({run_status, structured_output: {criteria: [...]}})'
      : 'a findings-evidence array';
  throw new JudgeError(
    'judges.artifact-not-a-list',
    `Judge artifact "${artifactPath}" parsed to ${parsed === null ? 'null' : typeof parsed}, not ${accepted}. An empty review is "[]", written out.`,
    { artifact_path: artifactPath, agent_role: role ?? null },
  );
}

function notDispatchedMessage(
  input: JudgeReportInput,
  turn: JudgeTurn | undefined,
  forRole: readonly JudgeTurn[],
): string {
  if (forRole.length > 1) {
    return `Task id "${input.taskId}" names a "${input.role}" turn in ${forRole.length} epics (${forRole.map((t) => t.taskId).join(', ')}). Report against the qualified id — closing one of them here would be a guess.`;
  }
  if (turn === undefined) {
    return `No judge dispatch for role "${input.role}" on ${input.taskId}. Record the dispatch first — a report with no dispatch behind it proves nothing about coverage.`;
  }
  return `Role "${input.role}" on ${input.taskId} is on round ${turn.round}, not round ${input.round}.`;
}

/**
 * Close a judge turn. Refuses unless the role was actually dispatched for the
 * round being reported, so a report cannot invent its own dispatch and make
 * the two sets agree by growing both.
 */
export async function recordJudgeReport(
  input: JudgeReportInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<JudgeReport> {
  const turns = await readJudgeTurns(input.taskId, ctx, opts);
  const forRole = turns.filter((t) => t.role === input.role);
  // More than one is a bare id that two epics both claim a turn for. Closing
  // either would be a guess, and `foldJudgeTurns` refuses the same ambiguity,
  // so the report emitted here would close nothing on the next read anyway.
  const turn = forRole.length === 1 ? forRole[0] : undefined;
  if (turn === undefined || (input.round !== undefined && input.round !== turn.round)) {
    throw new JudgeError('judges.not-dispatched', notDispatchedMessage(input, turn, forRole), {
      task_id: input.taskId,
      agent_role: input.role,
      round: input.round ?? null,
    });
  }

  const artifactPath = input.noFindings ? null : (input.artifactPath ?? turn.declaredArtifact);
  const findingCount =
    artifactPath === null ? 0 : readJudgeArtifact(artifactPath, input.role, input.taskId, opts);

  await emit(
    JUDGE_REPORT_EVENT_TYPE,
    {
      agent_role: input.role,
      round: turn.round,
      artifact_path: artifactPath,
      finding_count: findingCount,
      ...(input.noFindings ? { attested_by: ATTESTED_BY } : {}),
    },
    input.taskId,
    ctx,
    opts,
  );

  return {
    taskId: input.taskId,
    role: input.role,
    round: turn.round,
    artifactPath,
    findingCount,
    attested: input.noFindings === true,
  };
}
