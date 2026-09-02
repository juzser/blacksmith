import { EPIC_CLOSED_EVENT_TYPE } from './agents-registry.js';
import { type CrosscheckPolicy, loadCrosscheckPolicy } from './crosscheck.js';
import { foldTasks, type TaskFoldRow } from './db/projector.js';
import { SmithError } from './errors.js';
import {
  appendEvent,
  type EventOpts,
  readEvents,
  readLineageEvents,
  type StoredEvent,
} from './events.js';
import {
  AMEND_PENDING_STATUS,
  AMENDED_STATUS,
  type AmendmentDischarge,
  describeMalformedTaskId,
  type EventContext,
  type Finding,
  foldFindingsDetailed,
  isNonEmptyString,
  OPEN_FINDING_STATUSES,
  type SkippedFindingRecord,
  transition,
} from './findings.js';
import {
  type EpicGoalStatus,
  type GoalCheckStatus,
  goalCheckBlockers,
  latestGoalCheck,
} from './goalCheck.js';
import { type IntegrationCheckRecord, latestIntegrationCheck } from './integration.js';
import { type McpSurfaceStatus, mcpBlockers } from './mcp.js';
import { bareTaskId, latestPlanVersion, livePlanTasks, loadPlan, type PlanOpts } from './plan.js';
import type { JudgeBudget, JudgeRequest } from './providers/types.js';
import {
  enabledExternalProviders,
  nativeProviderName,
  type QuorumResult,
  runQuorumCase,
} from './quorum.js';
import { latestSpecReview, type SpecReviewStatus, specReviewBlockers } from './spec.js';
import { auditWaveConcurrency, type WaveConcurrency, type WaveVerdict } from './waveConcurrency.js';
import { RESERVED_TASK_ID } from './worktree.js';

/**
 * Third quorum_triggers host (factory/policies/crosscheck.yml): "epic-level
 * final verdict, before the integration PR opens". Same trigger-agnostic
 * quorum.ts engine gate.ts already uses for blocking-finding/same-mistake —
 * this module is a CALLER, not a variant of it.
 *
 * mechanical_oracles_first, applied literally: summarizeEpic() below is the
 * deterministic oracle and runs first; a mechanically-not-ready epic never
 * reaches a judge (§ runEpicVerdict step 1).
 *
 * §4 consequence of asymmetric_roles.finder_ne_critic (crosscheck.yml): the
 * readiness claim here is the native provider's own ("this epic is done"),
 * so native is always the finder and is always excluded from the gating
 * pool, exactly like any other claim. With quorum_rule.min_providers: 2:
 *   - 0 enabled externals: computeQuorum() would escalate
 *     insufficient-providers on EVERY mechanically-ready epic, since the
 *     gating pool is empty by construction. Calling runQuorumCase() at all
 *     in that case would be pure overhead for a foregone conclusion, so
 *     step 2 below short-circuits straight to `go` — this is the same
 *     "shipped default costs nothing" rule as gate.ts's resolveCrosscheck()
 *     returning null, and it is mandatory, not an optimisation.
 *   - exactly 1 active external: gating pool size 1 < 2 -> escalate
 *     insufficient-providers -> hold, every time. This is fail-closed and
 *     deliberate: the operator sees the reason and turns on a second
 *     provider or overrides by hand, rather than the epic silently going on
 *     the word of one external model.
 *   - 2+ active externals: a real quorum vote decides it.
 *   - shadow-only externals: verdicts are recorded (judge-verdict events)
 *     for calibration, but shadow mode has zero gating power — the outcome
 *     is whatever it would have been with no externals at all (`go`, since
 *     mechanical readiness already held).
 */

const TERMINAL_OK_TASK_STATUSES = new Set(['completed', 'waived']);

/** The terminal-OK status that is a decision rather than a completion (D-120). */
const WAIVED_TASK_STATUS = 'waived';

/**
 * Statuses that close a finding by DECIDING rather than by showing a fix
 * (D-120). Disjoint from OPEN_FINDING_STATUSES by construction — a finding is
 * open, earned-closed (`fix-verified`, `refuted`, `expired`), or one of these.
 * The gate does not block on them, which is precisely why the judge is told:
 * what nothing blocks on is what nobody re-reads.
 */
const DISCRETIONARY_FINDING_STATUSES = new Set(['waived', AMENDED_STATUS]);

export interface EpicTaskSummary {
  taskId: string;
  taskStatus: string;
}

/**
 * Whether the log actually holds the gate run a task's record claims (D-138).
 *
 * `gate run` writes both of these for the task it grades: the worker's Result
 * first (gate.ts's recordResult(), before the gate rules on it, so that even a
 * blocked task leaves its economy record) and then the outcome it rules. The
 * pair is what makes a gate record checkable — a `gate-outcome` payload is only
 * `{outcome, reason}`, which is as easy to type by hand as it is to earn, so
 * validating its SHAPE proves nothing. Its companion is what cannot be faked
 * without deciding to fake it.
 */
export interface TaskGateEvidence {
  /** A `gate-outcome` event exists for this task id. */
  gateOutcome: boolean;
  /** A `task-result-recorded` exists for the same task id. */
  resultRecorded: boolean;
}

/**
 * A folded task row plus its gate evidence — what summarizeEpic() grades.
 *
 * Carried ON the row rather than as another parameter beside `integration` and
 * `mcp`: the evidence is per-task, and a row type the fold's output does not
 * satisfy is a compile error at every caller rather than a defaulted argument
 * one of them forgets. withGateEvidence() is the only intended way to make one.
 */
export interface EpicTaskRow extends TaskFoldRow {
  gate: TaskGateEvidence;
}

const GATE_OUTCOME_EVENT = 'gate-outcome';
const TASK_RESULT_EVENT = 'task-result-recorded';

/**
 * Attach each row's gate evidence, folded from the same events the rows came
 * from — no new I/O, the same way latestIntegrationCheck() and
 * latestSpecReview() read the events runEpicVerdict already holds.
 *
 * Ids compare bare (D-46/P9-29): the fold row may carry `task-1` while the gate
 * stamped `epic-1/task-1`, and comparing raw would read every such task as
 * ungated — a false blocker is as bad here as the false pass this closes.
 */
export function withGateEvidence(
  tasks: readonly TaskFoldRow[],
  events: readonly StoredEvent[],
  epicId: string,
): EpicTaskRow[] {
  const gated = new Set<string>();
  const recorded = new Set<string>();
  for (const { record } of events) {
    if (!record.task_id) continue;
    if (record.event_type === GATE_OUTCOME_EVENT) gated.add(bareTaskId(epicId, record.task_id));
    else if (record.event_type === TASK_RESULT_EVENT)
      recorded.add(bareTaskId(epicId, record.task_id));
  }
  return tasks.map((t) => {
    const bare = bareTaskId(epicId, t.taskId);
    return { ...t, gate: { gateOutcome: gated.has(bare), resultRecorded: recorded.has(bare) } };
  });
}

export interface EpicFindingSummary {
  findingId: string;
  taskId: string;
  severity: string;
  findingStatus: string;
  summary: string;
}

export interface SatisfiedAmendment extends EpicFindingSummary {
  /**
   * The landed rows that discharge it — one per amends_task_ids entry, with the
   * version each landed under. Carried rather than recomputed because
   * transition() will not close an amendment on anything less: the caller has
   * to show the work, and this is the work (D-127).
   */
  satisfiedBy: AmendmentDischarge[];
  /**
   * D-21 Part 4. Set when `repairObligation` corrected a malformed
   * amends_task_ids entry for this finding before this discharge was
   * computed (findings.ts folds the LATEST finding-obligation-repaired event
   * onto amends_task_ids itself, last-decision-wins, mirroring isWaived) --
   * the reason the repair gave. A clean discharge must never read as
   * ordinary when the obligation it rested on was corrected: that is the
   * whole difference between an auditable repair and quietly dropping a
   * malformed entry from an S2 finding severity.yml says can never be
   * waived. Absent when the finding's obligation was never repaired.
   */
  repairedObligationReason?: string;
}

/**
 * How wide this epic actually ran, folded from the waves the log holds for it.
 *
 * The factory's central claim is that a project is built by many subagents
 * running the plan's tasks in parallel. Three commands already interrogate it —
 * `wave schedule` (how wide can this plan ever run), `wave check` (admit a
 * wave), `wave audit` (did the admitted wave run as wide as admitted) — and
 * every one of them is a command somebody has to remember to type, against a
 * state dir that outlives nothing in particular. The close is the one moment
 * no epic skips, and until this field it recorded every closure a person
 * decided, every command the assembled branch ran, and nothing at all about
 * the claim the factory exists to make. An epic that dispatched four admitted
 * tasks strictly one at a time closed `go` on a record indistinguishable from
 * one that ran four wide.
 *
 * NEVER a blocker, and the distinction is not squeamishness: width is not
 * readiness. A plan whose tasks genuinely depend on each other has nothing to
 * run side by side, and a gate that held such an epic would be refusing
 * correct work for the shape of its dependency graph. This has exactly the
 * standing `waivedTasks` and `discretionaryFindings` have — carried, shown to
 * the judge, recorded in the close, enforced by nothing.
 */
export interface EpicConcurrency {
  /** Waves admitted under this epic id. Zero means none was ever cut. */
  waves: number;
  /**
   * How many of those waves came back with each verdict. Every verdict is
   * keyed even at zero: "no wave ran in parallel" and "nobody counted" are
   * different answers, and a map that omits its zeroes cannot tell them apart.
   */
  verdicts: Record<WaveVerdict, number>;
  /** The widest wave admitted for this epic, against the most ever in flight. */
  widest: { declared: number; observed: number };
  /**
   * The `wave-admitted` event ids the log holds no dispatch for at all. Named
   * rather than counted because this is the one part of the fact a judge can
   * act on: those tasks were admitted and nothing shows them running, which is
   * a claim with nothing behind it rather than a narrow epic.
   */
  unobserved: string[];
  /**
   * Why the fold could not be rendered, or null when it was. `auditWaveConcurrency`
   * refuses a `wave-admitted` event that names no tasks — correctly, for the
   * command whose whole job is that record — and a throw reaching this gate
   * would take down `smith epic verdict` and `smith epic close` over a fact
   * that blocks nothing, which is the D-21 failure exactly. So the reader here
   * catches it, the same way resolveMcpSurface reports an unreadable manifest
   * instead of crashing the verdict meant to report it. When this is set the
   * counts below it are zeros nobody measured, not zeros anybody counted.
   */
  problem: string | null;
}

const WAVE_VERDICTS: readonly WaveVerdict[] = [
  'parallel',
  'partial',
  'serialized',
  'single',
  'unobserved',
];

/**
 * Reduce one epic's waves to the fact a close records. Pure, and separate from
 * `summariseWaveConcurrency` on purpose: that one scores an operator's audit
 * across every epic in a log and returns an exit code, and this one answers a
 * single epic with no verdict of its own to render.
 */
export function summariseEpicConcurrency(waves: readonly WaveConcurrency[]): EpicConcurrency {
  const verdicts = Object.fromEntries(WAVE_VERDICTS.map((v) => [v, 0])) as Record<
    WaveVerdict,
    number
  >;
  for (const wave of waves) verdicts[wave.verdict] += 1;
  return {
    waves: waves.length,
    verdicts,
    widest: {
      declared: waves.reduce((max, wave) => Math.max(max, wave.declared.length), 0),
      observed: waves.reduce((max, wave) => Math.max(max, wave.peak), 0),
    },
    unobserved: waves.filter((wave) => wave.verdict === 'unobserved').map((wave) => wave.eventId),
    problem: null,
  };
}

/** Nothing the log could be folded into a width, and why. */
const UNREADABLE_CONCURRENCY = (problem: string): EpicConcurrency => ({
  waves: 0,
  verdicts: Object.fromEntries(WAVE_VERDICTS.map((v) => [v, 0])) as Record<WaveVerdict, number>,
  widest: { declared: 0, observed: 0 },
  unobserved: [],
  problem,
});

/**
 * Fold the epic's waves off already-read events, reporting a refusal rather
 * than propagating it. See {@link EpicConcurrency.problem}: width never blocks
 * a close, so nothing about measuring it may be able to stop one.
 */
export function readEpicConcurrency(
  events: readonly StoredEvent[],
  epicId: string,
): EpicConcurrency {
  try {
    return summariseEpicConcurrency(auditWaveConcurrency(events, { epicId }));
  } catch (err) {
    return UNREADABLE_CONCURRENCY(err instanceof Error ? err.message : String(err));
  }
}

export interface EpicSummary {
  epicId: string;
  /** What the event log knows: one entry per folded task row. */
  tasks: EpicTaskSummary[];
  /** Folded rows that are not terminal-OK, PLUS every undispatchedTasks entry. */
  nonTerminalTaskCount: number;
  /** The plan version consulted, or null when the epic has no plan file (D-126). */
  planVersion: number | null;
  /**
   * Tasks the live plan still claims that the event log has never seen. Their
   * `taskStatus` is what the PLAN says, not what the log says — the log says
   * nothing, which is the defect (D-126).
   */
  undispatchedTasks: EpicTaskSummary[];
  /**
   * Terminal-OK tasks the log holds no completed gate run for (D-138): either
   * no `gate-outcome` at all, or one with no `task-result-recorded` beside it.
   * Their `taskStatus` is what the record CLAIMS; nothing shows it was earned.
   */
  ungatedTasks: EpicTaskSummary[];
  /**
   * Tasks that are terminal-OK because someone waived them, not because they
   * were done (D-120). Never a blocker — a waiver is a legitimate close — but
   * it is the one task outcome no gate re-derives, so the judge is shown it
   * separately rather than as another `waived` row in the status table.
   */
  waivedTasks: EpicTaskSummary[];
  openFindings: EpicFindingSummary[];
  /**
   * Findings closed by waiver or amendment (D-120): the closures a person
   * decided. `openFindings` drops them because they are closed, and that is the
   * right answer to "is this epic ready" and the wrong one to "should it be" —
   * an epic can be mechanically perfect and consist entirely of waivers.
   */
  discretionaryFindings: EpicFindingSummary[];
  /**
   * amend-pending findings whose amends_task_ids all landed terminal-OK at or
   * after amends_plan_version (D-127 Part B). Not a blocker — excluded from
   * `openFindings` and `blockers` — but not yet a fact either: nothing has
   * transitioned the finding to `amended`. closeEpic() is what does that,
   * reading this list rather than recomputing satisfaction itself.
   */
  satisfiedAmendments: SatisfiedAmendment[];
  integration: IntegrationStatus;
  mcp: McpSurfaceStatus;
  specReview: SpecReviewStatus;
  goalCheck: GoalCheckStatus;
  /**
   * How wide this epic ran, or null when the caller measured nothing. Null is
   * an answer — "nobody looked" must never read as "it ran fine". Never a
   * blocker; see {@link EpicConcurrency}.
   */
  concurrency: EpicConcurrency | null;
  blockers: string[];
  mechanicallyReady: boolean;
}

/**
 * The live task roster of a plan version, as `runEpicVerdict` resolved it —
 * `livePlanTasks(loadPlan(...))`, reduced to the two fields the gate reads.
 * Passed IN rather than loaded here so summarizeEpic stays pure.
 */
export interface EpicPlanRoster {
  version: number;
  tasks: readonly EpicTaskSummary[];
}

/**
 * What is known about the epic's assembled branch: the last recorded
 * integration-root check (integration.ts's fold) and where the branch head
 * actually is right now. Two fields, because a check is only evidence about
 * the commit it ran against — the pair is what makes "current" decidable.
 *
 * Kept as data rather than read here so this module stays git-free and
 * purely a fold over events; cli.ts reads the head and passes it in.
 */
export interface IntegrationStatus {
  check: IntegrationCheckRecord | null;
  headSha: string | null;
}

/**
 * D-42/P9-26: every gate this factory runs, runs inside a task worktree, so
 * every quality claim it makes is a claim about a worktree. The dogfood epic
 * reached a `ship` verdict with six green per-task gates and not one command
 * ever run against the assembled branch — which was broken, and stayed broken
 * until a human typed `pnpm lint` at the root. These blockers are the epic
 * gate refusing to certify what it has not seen: an assembled branch is
 * shippable only when the suite ran at the integration root, passed, and ran
 * against the commit the branch is on now.
 */
function integrationBlockers(epicId: string, integration: IntegrationStatus): string[] {
  const branch = `smith/${epicId}/${RESERVED_TASK_ID}`;
  const { check, headSha } = integration;

  if (check === null) {
    return [
      `Epic "${epicId}" has no integration-root check on record: no command has ever run against ${branch}. Per-task gates only ever saw a worktree (D-42).`,
    ];
  }

  // Unknown head: the record cannot be shown to cover anything. Fail closed —
  // the alternative is trusting a sha nobody can compare against.
  if (headSha === null) {
    return [
      `Could not read the head of ${branch}, so the integration-root check recorded at ${check.headSha.slice(0, 8)} cannot be shown to cover it.`,
    ];
  }

  if (check.headSha !== headSha) {
    return [
      `The integration-root check for "${epicId}" is stale: it ran against ${check.headSha.slice(0, 8)}, and ${branch} is now at ${headSha.slice(0, 8)}. Anything merged since is uncertified.`,
    ];
  }

  if (!check.pass) {
    const failed = check.results.filter((r) => !r.pass).map((r) => r.name);
    const named = failed.length > 0 ? failed.join(', ') : 'unnamed check(s)';
    return [
      `The integration-root check for "${epicId}" failed at ${headSha.slice(0, 8)}: ${named}.`,
    ];
  }

  return [];
}

/**
 * Pure readiness check, no I/O: given the epic's own task rows (foldTasks()
 * output, already filtered to this epic) and its findings (listFindings()
 * output), decide whether the epic is mechanically ready to open its
 * integration PR. "Terminal-OK" mirrors db/queries.ts's
 * MILESTONE_COMPLETE_TASK_STATUSES precedent (completed, waived) — a
 * superseded/failed/escalated/blocked/in-progress/etc. task is not one of
 * those, so it blocks. "Open" finding mirrors db/queries.ts's
 * OPEN_FINDING_STATUSES precedent (raised, confirmed, fix-pending,
 * fix-landed, amend-pending) — a finding only stops being open at
 * fix-verified, waived, or amended. `amend-pending` is the D-127 case: the
 * amendment is written but the tasks it names have not landed, so it is open
 * here until they do, and only then does closeEpic take it to `amended`.
 *
 * `integration` is REQUIRED, deliberately. An optional parameter defaulting
 * to "no check needed" would recreate the exact hole D-42/P9-26 closes: the
 * one caller that forgot it would get a `ship` verdict for an epic nothing
 * had ever been run against, and it would look like every other green run.
 * `mcp` is required for the same reason — pass MCP_SURFACE_NOT_REQUIRED to
 * say "this epic owes no surface" out loud, so a skip reads as a decision in
 * the diff rather than as an omission. `specReview` is required with no escape
 * value at all: an epic can legitimately owe no MCP surface, but every epic
 * has a plan, and only a review run after the code exists can see the defects
 * the code reveals (P9-9/D-33). `goalCheck` is required on the same terms and
 * for the sharper reason: every gate above it reads text the planner wrote, so
 * a plan that decomposes the wrong goal passes all of them, and the roadmap
 * goal is the only reference in this pipeline the planner did not author.
 *
 * `plan` is the epic's live plan roster, or null when it has no plan file.
 * D-126: without it the roster is the event-log fold alone, so a task the plan
 * claims and the log has no events for is not "not done" — it is absent, and
 * absence votes yes. `envkit-mcp-surface` closed `go` on a four-task roster
 * while its live plan v5 held five. The fifth had in fact been built and
 * merged, which is the point: the gate certified an epic it had no record of
 * the work for, and the code being there anyway was luck rather than evidence.
 * Null is a real answer, not a default: Phase 9's
 * epics were driven as punch-list branches with no plan file to consult, and a
 * plan that does not exist must cast no vote rather than an unclearable one.
 * The plan's own `task_status` never satisfies the gate — the plan file is
 * operator-writable and the log is hash-chained, so a plan row claiming
 * `completed` with nothing behind it is a claim, not evidence.
 *
 * `tasks` carries each row's gate evidence (D-138) — a bare foldTasks() row no
 * longer typechecks here, deliberately. `envkit-mcp-followup` closed `ship`
 * with three of its four tasks holding a `gate-outcome` someone had typed:
 * their session contains exactly one `task-result-recorded`, for the one task
 * actually replayed through the gate. The gate had been reading the record as
 * the thing it records. A task claimed done now has to show the run.
 *
 * `quarantined` is `foldFindingsDetailed`'s skipped list (D-135): records the
 * fold could not turn into findings. It defaults to `[]` — unlike `integration`
 * and `mcp`, which are required precisely so a forgotten argument cannot
 * manufacture a green — because omitting it leaves the gate exactly as
 * informed as it was before this parameter existed, and the one production
 * caller threads it from the same fold that produced `findings`.
 *
 * `concurrency` follows the same trailing-optional shape and for the same
 * reason, but its default carries a stronger claim: `null` means nobody
 * measured how wide this epic ran, and it is projected as `null` rather than
 * dropped so it can never be read as "it ran fine". It contributes nothing to
 * `blockers` — see {@link EpicConcurrency}.
 */
export function summarizeEpic(
  epicId: string,
  tasks: readonly EpicTaskRow[],
  findings: readonly Finding[],
  integration: IntegrationStatus,
  mcp: McpSurfaceStatus,
  specReview: SpecReviewStatus,
  goalCheck: GoalCheckStatus,
  plan: EpicPlanRoster | null = null,
  quarantined: readonly SkippedFindingRecord[] = [],
  concurrency: EpicConcurrency | null = null,
): EpicSummary {
  const taskSummaries: EpicTaskSummary[] = tasks.map((t) => ({
    taskId: t.taskId,
    taskStatus: t.taskStatus,
  }));
  const nonTerminal = taskSummaries.filter((t) => !TERMINAL_OK_TASK_STATUSES.has(t.taskStatus));

  // D-138: only tasks claimed done are asked for evidence. One still in flight
  // has not been gated yet and already blocks for not being terminal-OK —
  // repeating it here would make an in-progress task read like a forged one.
  const ungated = tasks.filter(
    (t) =>
      TERMINAL_OK_TASK_STATUSES.has(t.taskStatus) && !(t.gate.gateOutcome && t.gate.resultRecorded),
  );
  const ungatedTasks: EpicTaskSummary[] = ungated.map((t) => ({
    taskId: t.taskId,
    taskStatus: t.taskStatus,
  }));

  // Both registers spell ids either way (D-46/P9-29), so compare on the bare
  // form or every planned task reads as undispatched.
  const logged = new Set(taskSummaries.map((t) => bareTaskId(epicId, t.taskId)));
  const undispatchedTasks: EpicTaskSummary[] = (plan?.tasks ?? []).filter(
    (t) => !logged.has(bareTaskId(epicId, t.taskId)),
  );
  const toFindingSummary = (f: Finding): EpicFindingSummary => ({
    findingId: f.finding_id,
    taskId: f.task_id,
    severity: f.severity,
    findingStatus: f.finding_status,
    summary: f.summary,
  });

  const openFindings: EpicFindingSummary[] = [];
  const discretionaryFindings: EpicFindingSummary[] = [];
  const satisfiedAmendments: SatisfiedAmendment[] = [];
  const findingBlockers: string[] = [];
  for (const f of findings) {
    if (!OPEN_FINDING_STATUSES.has(f.finding_status)) {
      // Closed either way, so the readiness answer is the same; D-120 keeps
      // the two kinds of closed apart for the judge, which is the only reader
      // that can ask whether a waiver should have been one.
      if (DISCRETIONARY_FINDING_STATUSES.has(f.finding_status))
        discretionaryFindings.push(toFindingSummary(f));
      continue;
    }

    if (f.finding_status !== AMEND_PENDING_STATUS) {
      openFindings.push(toFindingSummary(f));
      findingBlockers.push(
        `Finding "${f.finding_id}" on "${f.task_id}" is still open (status: ${f.finding_status}, severity: ${f.severity}).`,
      );
      continue;
    }

    // D-127 Part B: an amend-pending finding is discharged by its own
    // obligation — every id in amends_task_ids landed terminal-OK at or after
    // amends_plan_version — not by the raw status alone. Ids compare bare
    // (D-46/P9-29): amends_task_ids comes from the plan side, the fold rows
    // from the event side, and the two registers spell ids either way.
    const obligationIds = f.amends_task_ids ?? [];
    const version = f.amends_plan_version;
    // The rows that did discharge, kept as they are found: closeEpic has to
    // hand them to transition() as evidence, and re-deriving them there would
    // be the same computation answering the same question twice.
    const satisfiedBy: AmendmentDischarge[] = [];
    // D-21: `amends_task_ids` is typed `string[]`, but it is folded off an
    // event payload nobody has validated — a malformed amendment (the same
    // supersede-as-array mistake `draftNextVersion` now refuses) could still
    // write a non-string entry, e.g. `[null, "epic-1/task-2"]`. `bareTaskId`
    // calls `.startsWith` on its argument, so passing the malformed entry to
    // it crashed `summarizeEpic` outright — and with it `smith epic verdict`
    // and `smith epic close` — rendering nothing at all. The house rule for a
    // check that cannot answer (dispatch check / escalation check's
    // `unverifiable`) is that it must not read as a pass: the malformed entry
    // is named as its own blocker below and never reaches `bareTaskId`, but it
    // still counts against discharge, so a corrupt amendment cannot silently
    // satisfy itself. The well-formed ids sharing its list are unaffected —
    // they are genuine obligations and are still evaluated normally.
    // D-21 Part 4 review finding (S3 behavioral-drift): this used to filter on
    // `typeof id !== 'string'` alone, so `""` read as well-formed here while
    // repairObligation's guard 1 (findings.ts) already calls it corrupt --
    // `bareTaskId`/`taskIdsMatch` can never match `""` to a real task id, so
    // an empty entry sat outstanding forever, never malformed and never
    // landable. isNonEmptyString is the shared definition now: epic.ts is the
    // side that had to move, not the guard.
    const malformedObligations = obligationIds.filter((id) => !isNonEmptyString(id));
    const wellFormedObligationIds = obligationIds.filter(isNonEmptyString);
    const outstanding =
      obligationIds.length === 0
        ? // An amendment naming no ids can never be satisfied. transition()'s
          // own amendment-without-obligation guard should have refused this at
          // the write (D-127), but a hand-edited or pre-guard record must not
          // silently read as done — null here, not [], is what distinguishes
          // "nothing to wait on" from "waiting on nothing outstanding".
          null
        : wellFormedObligationIds.filter((id) => {
            const bare = bareTaskId(epicId, id);
            const row = tasks.find((t) => bareTaskId(epicId, t.taskId) === bare);
            const landed =
              row !== undefined &&
              TERMINAL_OK_TASK_STATUSES.has(row.taskStatus) &&
              version !== undefined &&
              row.planVersion !== null &&
              row.planVersion >= version;
            if (landed && row.planVersion !== null)
              satisfiedBy.push({ taskId: row.taskId, planVersion: row.planVersion });
            return !landed;
          });

    if (malformedObligations.length === 0 && outstanding !== null && outstanding.length === 0) {
      satisfiedAmendments.push({
        ...toFindingSummary(f),
        satisfiedBy,
        // D-21 Part 4: never let a clean discharge read as ordinary when the
        // obligation it rested on was corrected -- carry the repair's own
        // reason, omitted entirely (not merely undefined) when there was none.
        ...(f.obligation_repair_reason !== undefined
          ? { repairedObligationReason: f.obligation_repair_reason }
          : {}),
      });
      continue;
    }

    openFindings.push(toFindingSummary(f));
    if (malformedObligations.length > 0) {
      findingBlockers.push(
        `Finding "${f.finding_id}" carries ${malformedObligations.length} malformed ` +
          `amends_task_ids entr${malformedObligations.length === 1 ? 'y' : 'ies'} ` +
          `(${malformedObligations.map(describeMalformedTaskId).join(', ')}), not a task id, so it cannot ` +
          'be checked as landed — this finding cannot be counted discharged. Repair or ' +
          'supersede the amendment record.',
      );
    }
    if (outstanding === null) {
      findingBlockers.push(
        `Finding "${f.finding_id}" is amend-pending but names no task ids to wait on — it can never be discharged this way; check how it entered amend-pending.`,
      );
    } else if (outstanding.length > 0) {
      findingBlockers.push(
        `Finding "${f.finding_id}" is amend-pending on plan v${version}: waiting on ${outstanding.join(', ')} to land terminal-OK at v${version} or later.`,
      );
    }
  }

  const blockers: string[] = [
    // An epic with no tasks is vacuously "all tasks done", which would let a
    // typo'd --epic (or an epic whose plan was never dispatched) sail through
    // as `go`. Nothing to integrate is a hold, not a pass.
    ...(taskSummaries.length === 0
      ? [`Epic "${epicId}" has no tasks in the event log — nothing to integrate.`]
      : []),
    ...nonTerminal.map((t) => `Task "${t.taskId}" is not terminal-OK (status: ${t.taskStatus}).`),
    ...undispatchedTasks.map(
      (t) =>
        `Task "${t.taskId}" is in plan v${plan?.version} but has no events in the log — nothing records it as dispatched, let alone done (plan status: ${t.taskStatus}).`,
    ),
    ...ungated.map((t) =>
      t.gate.gateOutcome
        ? `Task "${t.taskId}" is recorded ${t.taskStatus} and has a gate-outcome, but no task-result-recorded for it exists in the log. \`gate run\` writes both for the task it grades, so this outcome was written by hand — it is a claim, not a gate.`
        : `Task "${t.taskId}" is recorded ${t.taskStatus} with no gate-outcome in the log at all — nothing gated it. Run \`smith gate run\` for it, or supersede the record.`,
    ),
    ...findingBlockers,
    // A record the fold could not read is a finding of UNKNOWN status, and
    // the open/closed split above simply does not contain it. Treating it as
    // closed is absence read as a yes — the same error as counting an
    // undispatched task done (D-126).
    ...quarantined.map(
      (q) =>
        `Finding record ${q.event_id}${q.finding_id ? ` ("${q.finding_id}")` : ''} could not be read: ${q.reason}. Its status is unknown, so it cannot be counted as closed — repair or supersede the record before closing "${epicId}".`,
    ),
    ...integrationBlockers(epicId, integration),
    // docs/standards/mcp.md step 4: the surface milestone's epics do not close
    // while `smith mcp check` is red.
    ...mcpBlockers(epicId, mcp),
    // The roster is what knows the live plan version, so the review's own
    // plan_version has something to be stale against (D-125).
    ...specReviewBlockers(epicId, specReview, plan?.version ?? null),
    ...goalCheckBlockers(
      epicId,
      goalCheck,
      plan?.version ?? null,
      plan?.tasks.map((t) => t.taskId) ?? [],
    ),
  ];

  return {
    epicId,
    tasks: taskSummaries,
    // Undispatched tasks are unfinished work, so the one number the judge
    // prompt and the closed record both read has to include them.
    nonTerminalTaskCount: nonTerminal.length + undispatchedTasks.length,
    planVersion: plan?.version ?? null,
    undispatchedTasks,
    ungatedTasks,
    waivedTasks: taskSummaries.filter((t) => t.taskStatus === WAIVED_TASK_STATUS),
    openFindings,
    discretionaryFindings,
    satisfiedAmendments,
    integration,
    mcp,
    specReview,
    goalCheck,
    concurrency,
    blockers,
    mechanicallyReady: blockers.length === 0,
  };
}

const findingLine = (f: EpicFindingSummary): string =>
  `  ${f.findingId} (${f.taskId}, ${f.severity}, ${f.findingStatus}): ${f.summary}`;

/** An empty list rendered as nothing reads as a section the prompt forgot. */
const listOr = (lines: string[], empty = '  (none)'): string[] =>
  lines.length > 0 ? lines : [empty];

/**
 * Whether a recorded sha still covers the branch. Every caller here runs after
 * the matching blocker has already passed, so `(the current head)` is the
 * expected answer — the other two exist so that a record which somehow reached
 * a judge without covering anything says so rather than showing a bare sha the
 * judge has no way to place.
 */
function coverage(recorded: string, current: string | null): string {
  if (current === null) return ' (the current head could not be read)';
  if (current === recorded) return ' (the current head)';
  return ` (stale — the branch is now at ${current.slice(0, 8)})`;
}

/**
 * D-198. Both null branches used to say the same thing, and the violation
 * branch said `[object Object]` — `violations` holds records, and `join` calls
 * String() on each. The one sentence describing HOW a surface is red carried
 * nothing a judge could be wrong about, which is the material D-120 exists to
 * supply. mcpBlockers renders the same records correctly two functions over.
 */
function mcpVerdict(mcp: McpSurfaceStatus): string {
  if (mcp.check === null) {
    return mcp.problem === 'unreadable'
      ? 'no verdict could be rendered — the manifest exists and could not be read'
      : 'no verdict could be rendered — there is no manifest';
  }
  if (mcp.check.ok) return 'clean';
  const rules = mcp.check.violations.map((v) => `${v.rule} at ${v.path} — ${v.message}`);
  return `${mcp.check.violations.length} violation(s): ${rules.join('; ')}`;
}

/**
 * Pure prompt builder, mirrors quorum.ts's findingJudgeRequest() style and
 * trust boundary: never file contents or a diff — this module is a fold over
 * events and has no source to hand over.
 *
 * D-120 is why it carries more than the claim. The trigger fired twice on
 * byte-identical input (4 tasks completed, 0 non-terminal, 0 open findings) and
 * answered `refute` then `confirm`, same model, minutes apart. Neither answer
 * was derivable: the old prompt was a refute mandate, a status table, and the
 * sentence "you do not have file contents or the diff". A judge that takes the
 * mandate seriously must refute every epic forever; one that does not must
 * confirm every epic forever. Which you get is sampling noise, and the day a
 * provider is promoted to `mode: active` that coin acquires gating power.
 *
 * The fix is not a sharper mandate. It is material the judge can be WRONG
 * about, and the summary already holds it: which commands actually ran against
 * the assembled branch and how each exited, who closed the spec review and
 * against what, the MCP surface verdict, and every closure a person decided
 * rather than earned. summarizeEpic drops all of it from `blockers` because
 * none of it blocks — which is exactly the argument for showing it here. A
 * mechanically perfect epic can be a single `lint` command and four waivers,
 * and that is a judgement about a list, which is the one thing a judge can do
 * that a blocker cannot.
 *
 * NEVER include CheckResult.tail: it is the last 50 lines of combined
 * stdout+stderr from commands run at the integration root, and this prompt goes
 * to an external provider (guardrails.md, "No secrets in outputs"). The name
 * and the exit code are the refutable part; the output is not.
 */
export function epicVerdictJudgeRequest(summary: EpicSummary, budget: JudgeBudget): JudgeRequest {
  const taskLines =
    summary.tasks.length > 0
      ? summary.tasks.map((t) => `  ${t.taskId}: ${t.taskStatus}`).join('\n')
      : '  (no tasks)';
  // The plan's side of the roster, stated separately: these ids have no events
  // at all, so their status is what the plan claims, not what happened (D-126).
  const undispatchedLines =
    summary.undispatchedTasks.length > 0
      ? summary.undispatchedTasks
          .map((t) => `  ${t.taskId}: plan v${summary.planVersion} says ${t.taskStatus}`)
          .join('\n')
      : summary.planVersion === null
        ? '  (no plan file for this epic)'
        : '  (none)';
  const findingLines =
    summary.openFindings.length > 0 ? summary.openFindings.map(findingLine).join('\n') : '  (none)';

  // The assembled branch. `integrationBlockers` above holds the epic on every
  // shape but this one, so by the time a judge runs the check is present,
  // passing, and current — the refutable question left is what it RAN.
  const branch = `smith/${summary.epicId}/${RESERVED_TASK_ID}`;
  const { check, headSha } = summary.integration;
  const integrationLines =
    check === null
      ? [`  There is no integration-root check on record for ${branch}.`]
      : [
          `  Branch: ${branch}`,
          `  Checked at commit ${check.headSha.slice(0, 8)}${coverage(check.headSha, headSha)}, recorded ${check.ts}`,
          `  Result: ${check.pass ? 'passed' : 'FAILED'} — ${check.results.length} command${check.results.length === 1 ? '' : 's'} ran:`,
          // Name and exit code only — see this function's header on tail.
          ...listOr(
            check.results.map(
              (r) => `  ${r.name}: ${r.pass ? 'passed' : 'FAILED'} (exit ${r.exitCode})`,
            ),
            '  (none — the check recorded no commands at all)',
          ),
        ];

  const review = summary.specReview.review;
  const specReviewLines =
    review === null
      ? ['  There is no closing spec review on record for this epic.']
      : [
          `  Reviewed by: ${review.reviewedBy}`,
          `  Against commit ${review.headSha.slice(0, 8)}${coverage(review.headSha, summary.specReview.headSha)}, plan v${review.planVersion}`,
          `  Findings that review raised: ${review.findingIds.length}${review.findingIds.length > 0 ? ` (${review.findingIds.join(', ')})` : ''}`,
        ];

  const goalText = summary.goalCheck.goal;
  const goalRecord = summary.goalCheck.check;
  const goalCheckLines =
    goalText.goal === null
      ? [
          `  No roadmap milestone states a goal for this epic${goalText.milestoneId === null ? '' : ` (milestone ${goalText.milestoneId})`}.`,
        ]
      : [
          `  Goal (milestone ${goalText.milestoneId}): ${goalText.goal}`,
          ...(goalRecord === null
            ? ['  There is no spec-vs-goal check on record for this epic.']
            : [
                `  Checked by: ${goalRecord.checkedBy}, against plan v${goalRecord.planVersion}`,
                `  Goal digest read: ${goalRecord.goalDigest}${goalRecord.goalDigest === goalText.digest ? ' (current)' : ` — the roadmap now digests to ${goalText.digest}`}`,
                // Verdict per clause, in the goal's own order. An out-of-scope
                // dismissal prints its reason: it is the one verdict a judge
                // can use to make a clause disappear, so it is the one an
                // operator most needs to read back.
                ...goalRecord.coverage.map(
                  (entry, i) =>
                    `  Clause ${i + 1} [${entry.verdict}]: ${entry.clause}${
                      entry.verdict === 'covered'
                        ? ` — ${(entry.taskIds ?? []).join(', ')}`
                        : entry.verdict === 'out-of-scope'
                          ? ` — dismissed: ${entry.reason ?? ''}`
                          : ''
                    }`,
                ),
              ]),
        ];

  const mcpLine = !summary.mcp.required
    ? '  This epic owes no MCP surface.'
    : `  Milestone ${summary.mcp.milestoneId ?? '(unnamed)'}, manifest ${summary.mcp.manifestPath ?? '(none)'}: ${mcpVerdict(summary.mcp)}`;

  // The parallelism fact, stated whether or not it flatters the epic. Null is
  // rendered rather than dropped: a missing section reads as an older prompt,
  // and "nobody measured" is a different answer from "it ran one at a time".
  const concurrency = summary.concurrency;
  const concurrencyLines =
    concurrency === null
      ? ['  Nothing measured this. No wave record was read for this epic.']
      : concurrency.problem !== null
        ? [
            `  The wave record could not be read, so nothing here is a count: ${concurrency.problem}`,
          ]
        : concurrency.waves === 0
          ? ['  Waves admitted: 0 — no wave was ever cut under this epic id.']
          : [
              `  Waves admitted: ${concurrency.waves}`,
              `  Width: ${concurrency.widest.declared} admitted at the widest, ${concurrency.widest.observed} ever in flight at once`,
              `  Verdict per wave: ${WAVE_VERDICTS.map((v) => `${v} ${concurrency.verdicts[v]}`).join(', ')}`,
              `  Waves with no dispatch on record: ${concurrency.unobserved.length}`,
              ...listOr(
                concurrency.unobserved.map(
                  (id) => `  wave ${id}: admitted, and the log holds no dispatch on record for it`,
                ),
                '  (none — every admitted wave has work behind it)',
              ),
            ];

  const prompt = [
    'You are an adversarial critic in an automated epic-close gate.',
    `Epic "${summary.epicId}" is claimed ready to open its integration PR.`,
    'Your mandate is to REFUTE that claim: assume it is NOT ready until the',
    'evidence below forces you to agree. Confirm only if every task is',
    'genuinely done and no finding is genuinely still open.',
    '',
    `Epic: ${summary.epicId}`,
    `Tasks not yet terminal-OK: ${summary.nonTerminalTaskCount}`,
    'Tasks (from the event log):',
    taskLines,
    '',
    `Planned but never dispatched: ${summary.undispatchedTasks.length}`,
    undispatchedLines,
    '',
    `Open findings: ${summary.openFindings.length}`,
    findingLines,
    '',
    'The assembled branch — what actually ran against the merged code:',
    ...integrationLines,
    '',
    'Closing spec review (run after the code existed, P9-9/D-33):',
    ...specReviewLines,
    '',
    'Spec vs goal — the plan against the one reference the planner did not write:',
    ...goalCheckLines,
    '',
    'MCP surface:',
    mcpLine,
    '',
    'How wide this epic ran — this factory claims a plan is built by many',
    'agents working its tasks at the same time, and this is the log read back:',
    ...concurrencyLines,
    '  A narrow epic is not by itself a refutation: a plan whose tasks genuinely',
    '  depend on one another has nothing to run side by side, and refuting on',
    '  width alone would make your verdict a constant rather than a measurement.',
    '  What is refutable here is a wave whose tasks were admitted and nothing',
    '  shows them running: that is a declaration with no work behind it.',
    '',
    'Discretionary closures — decided by a person, not shown by the machine:',
    `Tasks waived rather than completed: ${summary.waivedTasks.length}`,
    ...listOr(summary.waivedTasks.map((t) => `  ${t.taskId}`)),
    `Findings closed by waiver or amendment: ${summary.discretionaryFindings.length}`,
    ...listOr(summary.discretionaryFindings.map(findingLine)),
    `Amendments this close will discharge: ${summary.satisfiedAmendments.length}`,
    ...listOr(
      summary.satisfiedAmendments.map(
        (f) =>
          `${findingLine(f)} — discharged by ${f.satisfiedBy
            .map((d) => `${d.taskId} at plan v${d.planVersion}`)
            .join(', ')}` +
          // D-21 Part 4: a clean discharge must never read as ordinary when
          // the obligation it rested on was corrected -- the judge is the
          // reader this honesty requirement exists for.
          (f.repairedObligationReason
            ? ` (obligation repaired: ${f.repairedObligationReason})`
            : ''),
      ),
    ),
    '',
    "What you have: the roster above and each task's status, the commands that",
    'ran against the assembled branch and whether each passed, the closing spec',
    'review, the MCP surface verdict, how wide the waves ran, and every closure',
    'a person decided.',
    'What you do NOT have: file contents, the diff for any task, or the output',
    'of any command — only its name and how it exited.',
    '',
    'Refute if a line above is inconsistent with the readiness claim, and name',
    'the line you are refuting. Do not refute merely because the diff is absent:',
    'that is true of every epic this gate will ever see, so it distinguishes',
    'nothing and makes your verdict a constant rather than a measurement.',
    '',
    'Return only JSON matching judge-verdict.schema.json:',
    '{"verdict": "confirm" | "refute", "rationale": "<one or two sentences>"}',
    '"confirm" = the epic is genuinely ready to open its integration PR.',
    '"refute" = it is not ready.',
  ].join('\n');

  return {
    kind: 'verify',
    taskId: `${summary.epicId}/${RESERVED_TASK_ID}`,
    inputRefs: { epic_id: summary.epicId },
    prompt,
    schemaName: 'judge-verdict',
    budget,
  };
}

/** A judge call is a network round-trip, not a test — same rationale and same numbers as
 * gate.ts's DEFAULT_JUDGE_BUDGET; not imported from there since gate.ts doesn't export it and
 * epic.ts must not depend on gate.ts (parallel quorum_triggers hosts, not a hierarchy). */
const DEFAULT_JUDGE_BUDGET: JudgeBudget = { timeout_ms: 120_000, max_output_bytes: 262_144 };

/** Injection seam for the cross-provider quorum, mirrors gate.ts's GateCrosscheckOptions. With
 * none of these set, runEpicVerdict() reads factory/policies/crosscheck.yml itself. */
export interface EpicCrosscheckOptions {
  policy?: CrosscheckPolicy;
  budget?: JudgeBudget;
  fetchImpl?: typeof fetch;
}

export interface EpicVerdictInput {
  epicId: string;
  /**
   * Where `smith/<epic>/integration` is right now, or null if it could not be
   * read. REQUIRED (D-42/P9-26): this module never shells out to git, so the
   * caller states the precondition, and null is fail-closed — an unreadable
   * head produces a blocker, never a pass.
   */
  integrationHeadSha: string | null;
  /**
   * Whether this epic owes an MCP surface, and what its manifest says
   * (docs/standards/mcp.md step 4). REQUIRED for the same reason as
   * integrationHeadSha — cli.ts resolves it via resolveMcpSurface(); every
   * other caller says MCP_SURFACE_NOT_REQUIRED out loud.
   */
  mcp: McpSurfaceStatus;
  /**
   * The goal the roadmap declares for this epic, or EPIC_GOAL_UNDECLARED.
   * REQUIRED, and with no not-required value: cli.ts resolves it via
   * resolveEpicGoal(), and an epic whose goal nobody wrote down is one nobody
   * can say succeeded — see goalCheck.ts's header for why that fails closed
   * where the MCP surface does not.
   */
  goal: EpicGoalStatus;
  /**
   * Where to look for the epic's plan file (D-126). Defaults to the repo's
   * `factory/specs/active/`; cli.ts threads `--specs-dir` through here, and
   * tests point it at a fixture. An epic with no plan directory is not an
   * error — see summarizeEpic.
   */
  planOpts?: PlanOpts;
  crosscheck?: EpicCrosscheckOptions;
}

export type EpicVerdictOutcome =
  | { outcome: 'go'; epicId: string; summary: EpicSummary; quorum?: QuorumResult }
  | {
      outcome: 'hold';
      epicId: string;
      summary: EpicSummary;
      reason: 'mechanical-blockers' | 'quorum-refuted' | 'disagreement' | 'insufficient-providers';
      quorum?: QuorumResult;
    };

function epicQuorumDecisionPayload(
  quorum: QuorumResult,
  epicId: string,
  finderProvider: string,
  ready: boolean,
): Record<string, unknown> {
  const gating = quorum.gating;
  return {
    task_id: `${epicId}/${RESERVED_TASK_ID}`,
    epic_id: epicId,
    finding_id: null,
    trigger_reason: 'epic-final-verdict',
    finder_provider: finderProvider,
    outcome: gating.outcome,
    decision: gating.outcome === 'decided' ? gating.decision : null,
    agreement: gating.outcome === 'decided' ? gating.agreement : null,
    gating_participants: gating.outcome === 'decided' ? gating.participants : [],
    escalation_reason: gating.outcome === 'escalate' ? gating.reason : null,
    rationales: gating.outcome === 'escalate' ? gating.rationales : [],
    participants: quorum.participants.map((p) => ({
      provider: p.provider,
      mode: p.mode,
      ok: p.ok,
      verdict: p.verdict,
      excluded_as_finder: p.excludedAsFinder,
    })),
    native_verdict: 'confirm',
    /** Whether the epic actually goes to integration after the quorum spoke. */
    ready,
  };
}

/**
 * Read the epic's latest plan version and reduce it to the roster the gate
 * reads. The only I/O between the plan file and summarizeEpic (D-126).
 *
 * A plan that cannot be read at all is treated as no plan rather than as a
 * thrown error: `epic verdict` is an operator's read-only question, and
 * failing it closed on a malformed file would make the answer unreachable
 * exactly when the operator most needs it. The blocker set is unchanged in
 * that case, and `planVersion: null` records that nothing was consulted.
 */
function resolvePlanRoster(epicId: string, planOpts: PlanOpts): EpicPlanRoster | null {
  const version = latestPlanVersion(epicId, planOpts);
  if (version === null) return null;
  try {
    const plan = loadPlan(epicId, version, planOpts);
    return {
      version,
      tasks: livePlanTasks(plan).map((t) => ({ taskId: t.task_id, taskStatus: t.task_status })),
    };
  } catch {
    return null;
  }
}

/**
 * Operator-invoked verdict for one epic: mechanical readiness first, then
 * (only when mechanically ready and it isn't free to skip) a cross-provider
 * quorum on the claim "this epic is ready to open its integration PR". Never
 * dispatches anything itself — the caller decides what to do with `go`/`hold`.
 */
export async function runEpicVerdict(
  input: EpicVerdictInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<EpicVerdictOutcome> {
  // Lineage (D-119). An epic is not a session: `validateCausalParent`'s own
  // header calls chaining a fresh session onto a full one "the documented way
  // to run a large epic", and this verdict read one session. Split the real
  // dogfood-mcp-1 log in two and `hold` on eleven open findings became `go` on
  // none — not a wrong number in a report, a close that the gate was built to
  // refuse.
  const events = await readLineageEvents(ctx.sessionId, opts);
  // Membership is the row's field, not a prefix test on its id (D-49/P9-10):
  // a task admitted under a bare id with the epic in its payload used to be
  // invisible here, and an epic with real work in it read "no tasks".
  // Gate evidence rides along from the same events (D-138) — no second read.
  // The fold reports the status a task's record CLAIMS; withGateEvidence says
  // whether the log holds the gate run behind the claim.
  const tasks = withGateEvidence(
    foldTasks(events).filter((t) => t.epicId === input.epicId),
    events,
    input.epicId,
  );
  // Folded from `events` rather than re-read via listFindings: the detailed
  // form is the only one that reports what it had to quarantine (D-135), and
  // the gate is precisely the caller that must not treat an unreadable
  // finding record as one fewer open finding.
  const { findings, skipped } = foldFindingsDetailed(events, { epic: input.epicId });
  const summary = summarizeEpic(
    input.epicId,
    tasks,
    findings,
    {
      check: latestIntegrationCheck(events, input.epicId),
      headSha: input.integrationHeadSha,
    },
    input.mcp,
    // Folded from the log this call already read, and pinned to the same head
    // as the integration check: the closing spec review reads the assembled
    // branch, so "current" means the same commit for both.
    {
      review: latestSpecReview(events, input.epicId),
      headSha: input.integrationHeadSha,
    },
    // Same shape, other axis: the recorded check comes from the log this call
    // already read, and the goal it is measured against comes from the
    // roadmap the caller resolved — a check is only evidence about the text it
    // read, so the pair is what makes "current" decidable.
    { check: latestGoalCheck(events, input.epicId), goal: input.goal },
    resolvePlanRoster(input.epicId, input.planOpts ?? {}),
    skipped,
    // Off the same lineage `events` every other fact here came from — the
    // wave record is in that log already, so measuring width costs this call
    // no second read and no second command anyone has to remember to type.
    readEpicConcurrency(events, input.epicId),
  );

  // Step 1 — mechanical_oracles_first, literally: a deterministic blocker is
  // final. Zero judge calls, zero events (read-only projection).
  if (!summary.mechanicallyReady) {
    return { outcome: 'hold', epicId: input.epicId, summary, reason: 'mechanical-blockers' };
  }

  const policy = input.crosscheck?.policy ?? loadCrosscheckPolicy();
  const providers = enabledExternalProviders(policy);

  // Step 2 — zero-cost-by-default short-circuit, see module header §4.
  if (providers.length === 0) {
    return { outcome: 'go', epicId: input.epicId, summary };
  }

  const nativeProvider = nativeProviderName(policy);
  const budget = input.crosscheck?.budget ?? DEFAULT_JUDGE_BUDGET;
  const rationale = `${input.epicId}: ${summary.tasks.length} task(s), all terminal-OK; 0 open findings.`;

  // Step 3 — the claim is native's own ("ready"); finder_ne_critic excludes
  // it from gating (§4).
  const quorum = await runQuorumCase(
    {
      taskId: `${input.epicId}/${RESERVED_TASK_ID}`,
      triggerReason: 'epic-final-verdict',
      finderProvider: nativeProvider,
      kind: 'verify',
      native: { provider: nativeProvider, verdict: 'confirm', rationale },
      providers,
      request: epicVerdictJudgeRequest(summary, budget),
      policy,
      quorumPolicy: { minProviders: policy.quorumRule.minProviders },
      fetchImpl: input.crosscheck?.fetchImpl,
    },
    ctx,
    opts,
  );

  // Step 4 — map the quorum's gating decision to go/hold. escalate only
  // holds when an ACTIVE judge actually ran (gate.ts's crossCheckFinding
  // rule, reused verbatim): shadow-only/all-failed participants have zero
  // gating power by construction, so there's nothing for an operator to
  // arbitrate and the epic goes exactly as it would have with 0 externals.
  const gating = quorum.gating;
  let outcome: EpicVerdictOutcome;
  if (gating.outcome === 'decided') {
    outcome =
      gating.decision === 'confirm'
        ? { outcome: 'go', epicId: input.epicId, summary, quorum }
        : { outcome: 'hold', epicId: input.epicId, summary, reason: 'quorum-refuted', quorum };
  } else {
    const hadActiveJudge = quorum.participants.some(
      (p) => p.mode === 'active' && p.ok && !p.excludedAsFinder,
    );
    outcome = hadActiveJudge
      ? { outcome: 'hold', epicId: input.epicId, summary, reason: gating.reason, quorum }
      : { outcome: 'go', epicId: input.epicId, summary, quorum };
  }

  // Step 5 — emit exactly once, for any case that actually ran a quorum.
  await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: 'quorum-decision',
      task_id: `${input.epicId}/${RESERVED_TASK_ID}`,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: epicQuorumDecisionPayload(
        quorum,
        input.epicId,
        nativeProvider,
        outcome.outcome === 'go',
      ),
    },
    opts,
  );

  return outcome;
}

/**
 * D-43/P9-27. Everything above is a read-only probe, and that is the point:
 * in the zero-cost default config BOTH of runEpicVerdict's terminal outcomes
 * return without appending anything, so asking "is this epic ready?" stays
 * free and repeatable. The cost is that the dogfood epic was declared
 * shippable, held on mechanical blockers, overridden by a human, merged and
 * tagged — and the log recorded none of it. The verdict was a conversation,
 * not a fact.
 *
 * `closeEpic` is the verb that makes it a fact. It runs the same probe and
 * then writes down what the probe said, who closed on it, and — when a human
 * closed over a hold — the blockers they overrode and why. An override stays
 * possible, because a human shipping over a known carry-forward defect is
 * legitimate; doing it silently is not.
 */
export class EpicCloseError extends SmithError {}

/**
 * Re-exported, not re-declared — the same reason judges.ts re-exports
 * `JUDGE_REPORT_EVENT_TYPE`. The registry folds this event now (D-187): it is
 * what closes the agents still open when the verdict lands, so two copies of
 * the literal would be two places to keep in sync, and the day they disagreed
 * the registry would stop recognising the close this file writes.
 */
export { EPIC_CLOSED_EVENT_TYPE };

export interface EpicCloseInput extends EpicVerdictInput {
  /**
   * Required to close over a `hold`, refused when blank. The whole value of
   * the record is the reason; an empty one is the same forgery class as
   * integration.ts recording a pass for an empty check list.
   */
  overrideRationale?: string;
}

export interface EpicCloseRecord {
  epicId: string;
  closedBy: 'verdict' | 'operator-override';
  /** What the machine said, preserved even when a human closed against it. */
  machineVerdict: 'go' | 'hold';
  machineReason: string | null;
  overrideRationale: string | null;
  /** The blockers standing at close time — empty on a `go`. */
  blockers: string[];
  summary: EpicSummary;
  eventId: string;
  ts: string;
}

/**
 * snake_case projection of the summary, so the payload reads like every other
 * event's.
 *
 * Every field is projected even when null or empty, for the reason spelled out
 * beside `plan_version` below: an absent key reads as an older event rather
 * than as nothing to report, and "nothing to report" is itself the answer a
 * reader of a close most often needs.
 */
function epicSummaryPayload(summary: EpicSummary): Record<string, unknown> {
  const { check, headSha } = summary.integration;
  const { review } = summary.specReview;
  const taskRef = (t: EpicTaskSummary) => ({ task_id: t.taskId, task_status: t.taskStatus });
  const findingRef = (f: EpicFindingSummary) => ({
    finding_id: f.findingId,
    task_id: f.taskId,
    severity: f.severity,
    finding_status: f.findingStatus,
    summary: f.summary,
  });
  return {
    tasks: summary.tasks.map((t) => ({ task_id: t.taskId, task_status: t.taskStatus })),
    non_terminal_task_count: summary.nonTerminalTaskCount,
    // Projected even when null/empty, for the same reason as spec_review below:
    // "which plan version was consulted, and did it claim anything the log
    // never saw" is exactly the question the envkit-mcp-surface close could not
    // be asked afterwards (D-126).
    plan_version: summary.planVersion,
    undispatched_tasks: summary.undispatchedTasks.map((t) => ({
      task_id: t.taskId,
      plan_task_status: t.taskStatus,
    })),
    // D-120/D-138: the closures nobody re-derives afterwards. The judge is
    // handed all of this (epicVerdictJudgeRequest), renders one verdict and is
    // gone; this event is the only reader left. Without these three lists,
    // "was this epic closed on waivers?" and "did any task close ungated?"
    // are answerable for the length of one prompt and unanswerable after —
    // and a `go` verdict is exactly the case where nothing else in the log
    // says so, because none of it blocked.
    ungated_tasks: summary.ungatedTasks.map(taskRef),
    waived_tasks: summary.waivedTasks.map(taskRef),
    open_findings: summary.openFindings.map(findingRef),
    discretionary_findings: summary.discretionaryFindings.map(findingRef),
    // D-127 Part B: satisfied amend-pending findings are not blockers, but
    // closeEpic() has not discharged them yet at the point this payload is
    // built for the verdict — projecting them here is what lets a reader see
    // "this close is about to turn these amend-pending findings into amended"
    // rather than inferring it from the finding-transitioned events after.
    satisfied_amendments: summary.satisfiedAmendments.map((f) => ({
      finding_id: f.findingId,
      task_id: f.taskId,
      severity: f.severity,
      finding_status: f.findingStatus,
      summary: f.summary,
      // The evidence, not just the verdict: transition() will refuse to close
      // these on anything less, so the record of the close carries the same
      // proof the gate demanded rather than making a reader re-fold the tasks.
      satisfied_by: f.satisfiedBy.map((row) => ({
        task_id: row.taskId,
        plan_version: row.planVersion,
      })),
      // D-21 Part 4: this record outlives the session -- it is what an
      // operator auditing the close months later actually reads -- so the
      // honesty requirement has to reach it, not only the live verdict
      // epicVerdictJudgeRequest hands the judge. Omitted entirely (not
      // merely null) when the finding's obligation was never repaired.
      ...(f.repairedObligationReason !== undefined
        ? { repaired_obligation_reason: f.repairedObligationReason }
        : {}),
    })),
    integration: {
      head_sha: headSha,
      check:
        check === null ? null : { branch: check.branch, head_sha: check.headSha, pass: check.pass },
    },
    // The blockers list already names a broken rule, but it does not say the
    // surface was checked, which manifest was read, or whether the epic was in
    // the surface milestone at all — and on a green surface it says nothing.
    //
    // Each violation is projected as its rule and path only. A violation's
    // `message` is manifest-derived text and this payload is persisted, which
    // is the same reason D-198 keeps the JSON parser's message out of an
    // mcpBlockers string.
    mcp: {
      required: summary.mcp.required,
      milestone_id: summary.mcp.milestoneId,
      manifest_path: summary.mcp.manifestPath,
      problem: summary.mcp.problem,
      check:
        summary.mcp.check === null
          ? null
          : {
              ok: summary.mcp.check.ok,
              violations: summary.mcp.check.violations.map((v) => ({ rule: v.rule, path: v.path })),
            },
    },
    // Projected even when null: "no closing spec review" is the fact the
    // epic-closed record most needs to carry, and an absent key would read
    // as an older event rather than as a missing review.
    spec_review:
      review === null
        ? null
        : {
            plan_version: review.planVersion,
            head_sha: review.headSha,
            reviewed_by: review.reviewedBy,
            finding_count: review.findingIds.length,
          },
    // Projected even at zero, and even as null, for the reason plan_version
    // gives above. This is the only record that outlives the close, and the
    // question it answers — did this epic actually run its plan in parallel,
    // or did it run the plan one task at a time and call it a factory — has no
    // other reader once the wave state dir is gone. Every key is spelled the
    // same either side: the field names are single words, so there is no
    // snake_case form of them to drift from.
    concurrency:
      summary.concurrency === null
        ? null
        : {
            waves: summary.concurrency.waves,
            verdicts: { ...summary.concurrency.verdicts },
            widest: { ...summary.concurrency.widest },
            unobserved: [...summary.concurrency.unobserved],
            problem: summary.concurrency.problem,
          },
    mechanically_ready: summary.mechanicallyReady,
  };
}

export async function closeEpic(
  input: EpicCloseInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<EpicCloseRecord> {
  // D-45: `event tail` answers a typo'd session id with [] and exit 0. Close
  // must not inherit that. Appending to an unknown session would create a
  // brand-new log whose first line is "this epic is closed" — a record that
  // is both true and unfindable, which is worse than the refusal.
  //
  // Deliberately `readEvents` and not the lineage read D-119 put everywhere
  // else. The question here is "does THIS session have a log", and only this
  // session's log answers it; a lineage read would be asking whether some
  // ancestor exists, which is not what the refusal below says. Nothing is lost
  // — every DECISION this function makes comes from runEpicVerdict, and that
  // reads the lineage.
  const events = await readEvents(ctx.sessionId, opts);
  if (events.length === 0) {
    throw new EpicCloseError(
      'epic.unknown-session',
      `Refusing to close "${input.epicId}" against session "${ctx.sessionId}", which has no event log: the close would be the first line of a log nobody is reading.`,
      { epicId: input.epicId, sessionId: ctx.sessionId },
    );
  }

  const rationale = input.overrideRationale?.trim() ?? '';
  if (input.overrideRationale !== undefined && rationale === '') {
    throw new EpicCloseError(
      'epic.close-refused',
      `Refusing to close "${input.epicId}" with a blank override rationale: the reason is the whole point of recording the override.`,
      { epicId: input.epicId },
    );
  }

  const verdict = await runEpicVerdict(input, ctx, opts);
  const blockers = verdict.outcome === 'hold' ? verdict.summary.blockers : [];

  if (verdict.outcome === 'hold' && rationale === '') {
    throw new EpicCloseError(
      'epic.close-refused',
      `Refusing to close "${input.epicId}": the verdict is hold (${verdict.reason}). Pass --override-rationale to close over it.\n${blockers.map((b) => `  - ${b}`).join('\n')}`,
      { epicId: input.epicId, reason: verdict.reason, blockers },
    );
  }

  // D-127 Part B: a satisfied amendment is not a blocker (summarizeEpic
  // already left it out of `blockers`/`openFindings`), but it is not a fact
  // yet either — nothing has told the finding it may leave amend-pending.
  // Discharge every satisfied amendment here, before the epic-closed event,
  // so a reader scanning the log in order sees the amendments land and THEN
  // the close that depended on them. This runs unconditionally, whether the
  // close is a clean verdict or an operator override over an unrelated
  // blocker: satisfaction was computed as a pure fact about the amendment
  // itself, independent of what else is or isn't wrong with the epic, so the
  // override question (should THIS close proceed) has no bearing on whether
  // THIS amendment already discharged.
  for (const amendment of verdict.summary.satisfiedAmendments) {
    await transition(amendment.findingId, AMENDED_STATUS, ctx, opts, {
      amendsSatisfiedBy: amendment.satisfiedBy,
    });
  }

  const closedBy = verdict.outcome === 'go' ? 'verdict' : 'operator-override';
  const machineReason = verdict.outcome === 'hold' ? verdict.reason : null;
  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? (closedBy === 'operator-override' ? 'operator' : 'system'),
      event_type: EPIC_CLOSED_EVENT_TYPE,
      // <epic>/integration, the established epic-level id. An unreserved
      // suffix like <epic>/epic escapes foldTasks()'s isReservedRef guard and
      // mints a phantom task row — which is exactly what the hand-written
      // dogfood close did (D-44).
      task_id: `${input.epicId}/${RESERVED_TASK_ID}`,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: input.epicId,
        closed_by: closedBy,
        machine_verdict: verdict.outcome,
        machine_reason: machineReason,
        override_rationale: closedBy === 'operator-override' ? rationale : null,
        blockers,
        summary: epicSummaryPayload(verdict.summary),
      },
    },
    opts,
  );

  return {
    epicId: input.epicId,
    closedBy,
    machineVerdict: verdict.outcome,
    machineReason,
    overrideRationale: closedBy === 'operator-override' ? rationale : null,
    blockers,
    summary: verdict.summary,
    eventId: stored.event_id,
    ts: stored.record.ts,
  };
}
