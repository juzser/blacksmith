#!/usr/bin/env node
// Thin CLI router: one subcommand per orchestrator module operation. No
// framework — plain argv parsing. Logic lives in the modules; this file only
// wires stdin/argv to them and prints JSON.
//
// One rule about the import list below: **nothing that reaches the database
// layer is imported at module scope.** `db/schema.js` pulls in drizzle-orm,
// which roughly triples what booting this file costs, and a static import here
// charges that to every invocation of the binary — `smith --help` and `smith
// policy check` as much as `smith stats overview`. The nine modules that reach
// it (`attribution`, `daemon`, `db/projector`, `db/queries`, `epic`, `gate`,
// `lessonAudit`, `lessons`, `scheduler`) are `await import()`ed inside the
// branches that use them, which is why `main()` is async. Type-only imports of
// the same modules are fine and stay up here: tsc erases them, so they cost
// nothing at runtime. `test/cliBoot.test.ts` reads the built graph and fails if
// the database layer creeps back into it.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ParsedArgs, parseArgs } from './args.js';
import { checkBudgetAlarm } from './budgetAlarm.js';
import type { TaskBudget } from './budgets.js';
import { type BudgetPolicy, loadBudgetPolicy } from './budgets.js';
import {
  type ClaimedTask,
  collectCommittedChanges,
  loadWorktreePolicy,
  type ProposedWaveTask,
  postRunCheck,
  validateWave,
  type WaveTask,
  writeRootCheck,
} from './claims.js';
import { collectCoverageEvidence } from './coverage.js';
import { loadCrosscheckPolicy } from './crosscheck.js';
import {
  type IndependentRun,
  independentFinderRequest,
  type NativeFindingRecord,
  reconcile,
  runIndependentFinder,
} from './crossFinding.js';
import type { TickOptions } from './daemon.js';
import type { DbOpts } from './db/projector.js';
import { checkDispatchAsymmetry } from './dispatchAudit.js';
import { loadEffortPolicy, resolveEffort } from './effort.js';
import { SmithError } from './errors.js';
import { checkEscalationLadder } from './escalation.js';
import {
  appendEvent,
  type EventOpts,
  filterEvents,
  listSessionIds,
  mergeSessionLogs,
  readEvents,
  readLineageEvents,
  requireSession,
  type StoredEvent,
  sessionLineage,
  startSession,
  tailEvents,
} from './events.js';
import { findingsForDispatch } from './findingContext.js';
import type { EventContext, FindingEvidence, MintContext, RaiseFindingInput } from './findings.js';
import {
  AMEND_PENDING_STATUS,
  AMENDED_STATUS,
  findingScope,
  listFindings,
  mintFindings,
  OPEN_FINDING_STATUSES,
  raiseFinding,
  repairObligation,
  reverifyFinding,
  SPEC_FINDING_SCOPE,
  transition as transitionFinding,
} from './findings.js';
import { type ClauseCoverage, recordGoalCheck, resolveEpicGoal } from './goalCheck.js';
import { decideHookPayload } from './hookDecision.js';
import {
  checkWorktreeImmutable,
  fingerprintWorktree,
  type WorktreeFingerprint,
} from './immutability.js';
import { collectExportDiffs, exportImpact, waveImpact } from './impact.js';
import { integrationHeadSha, runIntegrationCheck } from './integration.js';
import { judgePreflight } from './judgePreflight.js';
import {
  outstandingJudges,
  readJudgeTurns,
  recordJudgeDispatch,
  recordJudgeReport,
} from './judges.js';
import { addMcpSurface, resolveMcpSurface, runMcpCheck } from './mcp.js';
import { LESSONS_MD_PATH, REPO_ROOT, SANDBOX_LEASE_DIR, STATE_DB_PATH } from './paths.js';
import {
  diffPlans,
  livePlanTasks,
  type PlanChanges,
  type PlanFile,
  type PlanOpts,
  resolveTaskId,
  type TaskSpecRecord,
  validatePlan,
} from './plan.js';
import { runPlanQuorum } from './planQuorum.js';
import {
  detectCurrentBranch,
  detectRepoRoot,
  evaluateCommand,
  loadGuardrailPolicy,
} from './policy.js';
import { recordUserPrompt } from './prompts.js';
import { checkBrief, type IngestKind, wrapIngested } from './provenance.js';
import { runJudge } from './providers/index.js';
import type { JudgeBudget, JudgeRequest } from './providers/types.js';
import { admit, adopt, step } from './queue.js';
import { stampResultEnvelope } from './results.js';
import { checkRuntime } from './runtime.js';
import { checkSameMistakeKpi } from './sameMistakeKpi.js';
import {
  activeSandboxFor,
  closeSandbox,
  listSandboxes,
  openSandbox,
  type SandboxLease,
} from './sandbox.js';
import { registerProjectInRoadmap, scaffoldProject } from './scaffold.js';
import {
  loadSensitivePathsPolicy,
  type SecurityTriggerTask,
  securityTriggers,
} from './security.js';
import { parseLessons } from './severity.js';
import { amendPlan, recordSpecReview } from './spec.js';
import {
  approveSpecChange,
  listSpecChanges,
  proposeSpecChange,
  rejectSpecChange,
  type SpecChangeRequest,
  type SpecChangeStatus,
} from './specChange.js';
import { checkStack, loadStackAnswers } from './stack.js';
import { buildSymbolGraph, collectSources } from './symbols.js';
import {
  emitEdgesRecorded,
  emitTasksAdded,
  emitWaveAdmitted,
  readAddedTasks,
  type WaveAdmissionBudget,
} from './taskEvents.js';
import { checkTesterIsolation } from './testerAudit.js';
import type { CheckCommand } from './testgate.js';
import { assertSelectableTestCmd } from './testSelect.js';
import {
  COMMANDS,
  type CommandDoc,
  flagSpecFor,
  helpText,
  isDocumented,
  positionalNames,
  usageFor,
  usageLine,
  usageText,
} from './usage.js';
import { applyBatch, pendingBatch, type WaiverBatchDecision } from './waivers.js';
import {
  blocksAdmission,
  checkWaveBudget,
  type ProposedWaveBudget,
  type WaveBudgetCheck,
} from './waveBudget.js';
import { computeNextWave, liveWaveTasks, type NextWaveInput } from './waveNext.js';
import {
  createTaskWorktree,
  listStale,
  RESERVED_TASK_ID,
  removeTaskWorktree,
  taskBranchName,
} from './worktree.js';

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

/** A task spec's `budget.tokens` when it is a usable positive number, else null. */
function declaredTokens(budget: unknown): number | null {
  if (typeof budget !== 'object' || budget === null) return null;
  const tokens = (budget as { tokens?: unknown }).tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/**
 * What this wave will cost, task by task, priced from what declared it.
 *
 * Plan-declared tasks are priced from livePlanTasks, never `plan.tasks`
 * (D-126/D-184): a superseded spec lives on in the array under the same
 * `task_id`, so pricing off the raw list would read whichever copy came first
 * rather than the one that is in force.
 *
 * Two different silences, and they get two different answers.
 *
 * A task the plan declares but leaves unpriced comes back `null` — not 0,
 * because those are opposite claims (0 says "this costs nothing", null says
 * "nobody said"), and only null makes the wave unverifiable. That refusal is
 * safe to make because it is also cheap to fix: `task-spec.schema.json`
 * REQUIRES `budget.tokens`, so a plan reaching here without one never passed
 * `smith plan validate`, and `wave check` reads its plan with a bare cast
 * (see claims.ts's `ProposedWaveTask`) rather than re-validating it. The
 * unpriced spec is the finding.
 *
 * A task NO plan declares is the other silence. A follow-up minted by
 * `findings raise` exists only in the log, which records its claims but never
 * its budget (D-48/P9-31) — there was never a field for anyone to fill in.
 * Refusing it would close the factory's own repair path: the follow-up would
 * be admissible only by hand-editing a plan it was invented precisely to
 * avoid, which is the same shape of failure as guard.sh's `deny`-on-
 * unavailable — not safe, only stuck. So the policy prices it instead, at the
 * coder task cap, which is the most such a task is permitted to spend before
 * D-29's overrun record fires. That is a real number checked against a real
 * cap, not a waiver: a wave of ten follow-ups is ten coder caps, and it is
 * refused when ten of them will not fit.
 */
function declaredWaveBudgets(
  plan: PlanFile,
  taskIds: readonly string[],
  policy: BudgetPolicy,
): ProposedWaveBudget[] {
  const priced = new Map<string, number | null>(
    livePlanTasks(plan).map((spec) => [spec.task_id, declaredTokens(spec.budget)]),
  );
  // `has` rather than `??`: an id the plan declares at null is unpriced, an id
  // the plan never mentions at all is log-only. Collapsing them would make the
  // plan defect above unreportable.
  return taskIds.map((taskId) => ({
    taskId,
    tokens: priced.has(taskId) ? (priced.get(taskId) ?? null) : policy.task.coder.capTokens,
  }));
}

/**
 * The gate's verdict in the log's snake_case shape, written on every admission.
 *
 * `override_rationale` is passed only when a human actually overrode a
 * blocking status, so an admission that simply fit is never recorded as a
 * decision somebody had to make.
 */
function admissionBudget(check: WaveBudgetCheck, rationale?: string): WaveAdmissionBudget {
  return {
    status: check.status,
    cap_tokens: check.capTokens,
    projected_tokens: check.projectedTokens,
    wave_tokens: check.waveTokens,
    headroom_tokens: check.headroomTokens,
    ...(rationale !== undefined ? { override_rationale: rationale } : {}),
  };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined) {
    throw new SmithError('cli.missing-flag', `Missing required flag --${name}.`, { flag: name });
  }
  return value;
}

/**
 * requireFlag for a flag that must parse as a number, so `--input-tokens abc`
 * is named here rather than travelling as NaN into a token_usage the schema
 * then rejects for the wrong reason.
 */
function requireIntFlag(flags: Record<string, string>, name: string): number {
  const raw = requireFlag(flags, name);
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new SmithError('cli.non-numeric-flag', `--${name} must be an integer, got "${raw}".`, {
      flag: name,
      value: raw,
    });
  }
  return value;
}

/**
 * requireIntFlag's optional twin, for a count that also has to be in range.
 *
 * D-210. `event tail --n` read its count with a bare Number.parseInt and
 * checked nothing, which fails in both directions at once: `--n abc` is NaN,
 * and `all.slice(Math.max(0, len - NaN))` is `slice(0)` -- the WHOLE log, from
 * the verb whose usage line promises "the last n records" -- while `--n 0` and
 * `--n -5` make the offset larger and print nothing, which is exactly the
 * "your session is empty" answer P9-28 built requireSession to prevent.
 *
 * Number(), not parseInt(), for the reason `plan quorum --confidence` already
 * documents for parseFloat: parseInt stops at the first character it cannot
 * use and returns the prefix, so `--n 1e2` is 1 rather than 100, `--n 0x10` is
 * 0, and `--port 8080abc` is 8080. Every one of those is a typo answered
 * confidently with the wrong number instead of being named.
 */
function boundedIntFlag(
  flags: Record<string, string>,
  name: string,
  range: { min: number; max?: number },
): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const value = Number(raw.trim() === '' ? Number.NaN : raw);
  const max = range.max;
  if (!Number.isInteger(value) || value < range.min || (max !== undefined && value > max)) {
    const bound = max === undefined ? `at least ${range.min}` : `${range.min}-${max}`;
    throw new SmithError(
      'cli.invalid-flag',
      `--${name} must be a whole number ${bound}, got "${raw}".`,
      { flag: name, value: raw },
    );
  }
  return value;
}

/**
 * The same two numbers gate.ts, epic.ts and planQuorum.ts each declare for
 * themselves, and for their reason: a judge call is a network round-trip, not
 * a test. Declared here rather than imported because none of those three
 * exports it, and cli.ts depending on a gate module for a default would make
 * the CLI a fourth caller of the gate rather than a peer of it.
 */
const DEFAULT_JUDGE_BUDGET: JudgeBudget = { timeout_ms: 120_000, max_output_bytes: 262_144 };

/**
 * A judge budget the operator may narrow from the command line.
 *
 * Both bounds are floors, not ceilings, on purpose: a `--timeout-ms 0` would
 * make every call fail as a timeout and read as a provider that refuses to
 * answer, and a `--max-output-bytes 0` would truncate every verdict to nothing
 * and read as a provider that answered with silence. Those are the two
 * failures this repo works hardest to keep distinguishable, so neither is
 * reachable by typo.
 */
function judgeBudgetFromFlags(flags: Record<string, string>): JudgeBudget {
  return {
    timeout_ms: boundedIntFlag(flags, 'timeout-ms', { min: 1 }) ?? DEFAULT_JUDGE_BUDGET.timeout_ms,
    max_output_bytes:
      boundedIntFlag(flags, 'max-output-bytes', { min: 1 }) ??
      DEFAULT_JUDGE_BUDGET.max_output_bytes,
  };
}

/**
 * requireFlag's twin for positional arguments (P9-28).
 *
 * Every verb below used to take its positionals as `positional[0] as string` —
 * a cast, which checks nothing. The `undefined` then travelled: into
 * readFileSync, which blames a path argument rather than the argument you
 * forgot; into git, run in an undefined directory; and worst, into a log read
 * that returned `[]` and exited 0, so `smith event tail` with no session id
 * reported success and an empty session. Flags have been checked since the
 * first commit; positionals were not checked at all.
 *
 * The names come out of the command's documented positionals, so the error can
 * name the argument that is missing AND print the line that would have worked,
 * with no second list to drift out of sync. Since P9-21 that line comes from
 * usage.ts rather than a literal typed here, which is what lets `--help` print
 * the same text a mistake earns you.
 *
 * `required` is passed only where a verb needs fewer positionals than it
 * documents — after P9-21 that is `wave check <plan.json> <task-id>...` alone,
 * which checks the plan path here and keeps its own, better `cli.empty-wave`
 * message for the variadic tail. The two other overrides died with the split:
 * `worktree verify --before <fingerprint.json>` needed one because its flag's
 * placeholder used to sit in the counted string.
 *
 * Surplus positionals stay accepted on purpose: `wave check` is variadic and
 * `smith new` spends its first token on the project name, so an arity check
 * would reject valid lines. Rejecting *unexpected* arguments is a different
 * question from this one, and this is not it.
 *
 * An empty-string argument counts as missing: `smith gate run ""` is the same
 * mistake as `smith gate run`, usually an unset shell variable, and the empty
 * id would otherwise travel exactly as far as `undefined` did.
 */
function requirePositionals(positional: string[], doc: CommandDoc, required?: number): string[] {
  const usage = usageLine(doc);
  const names = positionalNames(doc);
  const missing = names.slice(0, required ?? names.length).filter((_, i) => !positional[i]);
  if (missing.length > 0) {
    const which = missing.map((name) => `<${name}>`).join(' ');
    throw new SmithError(
      'cli.missing-positional',
      `Missing required argument${missing.length > 1 ? 's' : ''} ${which}. Usage: ${usage}`,
      { missing, usage },
    );
  }
  return positional;
}

/**
 * Every gate/findings/waivers command writes to the same session log, so they
 * share this shape.
 *
 * `--plan-version` goes through boundedIntFlag (D-210's class): the bare
 * `Number.parseInt` this replaced stamped `--plan-version 2.9` into the
 * persisted envelope as plan 2, `9e9` as 9 and `3x` as 3, and the truthiness
 * test in front of it turned an explicitly empty `--plan-version ""` into the
 * default 1. Only `abc` ever reached the event schema, which then blamed the
 * record for a malformed field rather than the flag that malformed it. This is
 * the shared envelope for twenty-odd verbs and the number outlives the typo, so
 * a fence read back tomorrow is the first place anyone would notice.
 */
function eventContextFromFlags(flags: Record<string, string>): EventContext {
  return {
    sessionId: requireFlag(flags, 'session'),
    planVersion: boundedIntFlag(flags, 'plan-version', { min: 1 }) ?? 1,
    causalParent: requireFlag(flags, 'causal-parent'),
    actor: flags.actor,
  };
}

/**
 * `--state-dir` overrides the events log directory (defaults to the real
 * state/events/ dir, unchanged, when the flag is absent) — lets tests
 * exercise `event append`/`event tail` without littering the real state/
 * dir across runs.
 */
function eventOptsFromFlags(flags: Record<string, string>): EventOpts {
  return flags['state-dir'] ? { stateDir: flags['state-dir'] } : {};
}

/** Where plan version files are read from and written to; defaults to factory/specs/active. */
function planOptsFromFlags(flags: Record<string, string>): PlanOpts {
  return flags['specs-dir'] ? { specsDir: flags['specs-dir'] } : {};
}

/**
 * The one reader for every flag usage.ts documents as `<iso>` (D-209).
 *
 * usage.ts states of its flag column: "Documentation only -- never parsed."
 * That was true of the value as well. `scheduler run --now`, `dream --since`
 * and `stats providers --since` each took the operator's string and handed it
 * straight to a Date or to a SQL comparison, so a typo did not fail -- it
 * changed the answer, in a different direction at each of the three:
 *
 *   --now: `new Date('now')` is Invalid Date, and every comparison against
 *   the NaN behind it is false. proposeRechecks never pushes `time-elapsed`
 *   (fails CLOSED -- the operator asks what is due and a typo answers
 *   "nothing"), while proposeGrowthReview never returns null (fails OPEN --
 *   the review fires on every run regardless of cadence). Worse, the recheck
 *   proposal object IS the payload runScheduler persists, and Math.floor(NaN)
 *   serialises to null, so `daysElapsed: null` outlives the typo in an
 *   append-only log that event.schema.json accepts as-is (`payload` is an
 *   unconstrained object).
 *
 *   dream --since: `Date.parse(ts) < NaN` is false, so no event is ever
 *   skipped and the whole log is distilled instead of the window asked for.
 *
 *   stats providers --since: the value goes into `gte(eventsRaw.ts, since)`,
 *   a LEXICAL comparison. Every stored ts starts with a digit, so any word
 *   sorts above all of them and the report is silently empty.
 *
 * Strict ISO 8601, not "whatever Date accepts", because the parseable inputs
 * are the dangerous ones: V8 reads '01/10/2026' as a US M/D/Y date, so the
 * dd/mm/yyyy operator gets January 10 with no error and no way to see it. A
 * shape check is the only thing that separates that from the date they meant.
 *
 * Returns a Date so the one caller needing an instant gets one; the two
 * comparing against stored timestamps take .toISOString(), which also
 * normalises an offset like +07:00 to the Z form those timestamps are in --
 * the lexical comparison above is only meaningful between like forms.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isoDateFlag(flags: Record<string, string>, name: string): Date | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const parsed = ISO_INSTANT.test(trimmed) ? new Date(trimmed) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new SmithError(
      'cli.invalid-flag',
      `--${name} must be an ISO 8601 instant, got "${raw}". The form is ` +
        '2026-08-20 or 2026-08-20T14:30:00Z. Words like "now" are not dates, and ' +
        'a slashed date is read as US month/day/year, so 01/10/2026 is January ' +
        '10 -- both change the result silently instead of failing.',
      { flag: name, value: raw },
    );
  }
  return parsed;
}

/**
 * Same override, for `db rebuild`/`db apply` — they read the same events log
 * `event append` writes.
 *
 * `--roadmap-path` belongs here too: both verbs rebuild the whole milestones
 * table from a roadmap file, and unset it falls back to black-smith's own
 * factory/specs/roadmap.md. Dropping the flag therefore did not mean "keep the
 * existing milestones" — it meant "replace this db's milestones with
 * black-smith's", which is a silent data swap for any db but this repo's.
 *
 * `--specs-dir` travels for the same reason and is the same flag `plan`
 * already takes: the projector reads an epic's plan file to answer what
 * project its pre-D-232 events never stamped (D-246), and unset it reads this
 * repo's factory/specs/active — another tree's epics, and no answer.
 */
function dbOptsFromFlags(flags: Record<string, string>): DbOpts {
  return {
    ...(flags['state-dir'] ? { stateDir: flags['state-dir'] } : {}),
    ...(flags['roadmap-path'] ? { roadmapPath: flags['roadmap-path'] } : {}),
    ...(flags['specs-dir'] ? { specsDir: flags['specs-dir'] } : {}),
  };
}

/**
 * The novelty gate's two numbers (D-159). architecture §9.3 documents them as
 * living in factory/policies/scheduler.yml, and `LessonsSchedulerPolicy` calls
 * that file the single source of truth — but every path into the gate used to
 * fall back to lessons.ts's own constants, so the file was a knob wired to
 * nothing. `--policy` overrides the path the same way it does on `dispatch
 * check` and friends; unguarded like `computeProposals`, because a missing or
 * malformed policy is a loud `scheduler.invalid-policy`, not a default.
 *
 * `--novelty-threshold` still wins where it is accepted: a one-run override of
 * the standing policy is exactly what an operator reaches for mid-review. It is
 * folded in here rather than spread over the result at each call site (D-208),
 * so one place answers "what threshold is in effect" and no later caller can
 * take the override without its check. `dream` accepts no such flag, and D-132's
 * unknown-flag guard throws in main() before any handler runs, so reading it
 * here cannot smuggle the flag into a command that does not advertise it.
 */
async function noveltyOptsFromFlags(flags: Record<string, string>): Promise<{
  noveltyThreshold: number;
  shingleSize: number;
  noveltyLengthAware: boolean;
}> {
  const override = noveltyThresholdOverride(flags);
  // Async only to keep scheduler.ts out of the boot graph — see the header.
  // Every caller is a lessons/dream branch that is already awaiting something.
  const { loadSchedulerPolicy } = await import('./scheduler.js');
  const { noveltyJaccardThreshold, shingleSize, noveltyLengthAware } = loadSchedulerPolicy(
    flags.policy,
  ).lessons;
  // No flag for the length correction, deliberately: it decides HOW the
  // threshold is read, and an operator who wants a different bar for one run
  // already has --novelty-threshold to say so in the units they are thinking
  // in. A second flag that silently re-scales the first is a worse override.
  return { noveltyThreshold: override ?? noveltyJaccardThreshold, shingleSize, noveltyLengthAware };
}

/**
 * The override held to the range its own source of truth is held to (D-208).
 * parseSchedulerPolicy refuses a novelty_jaccard_threshold outside (0, 1] and
 * says why -- "the novelty gate reads this directly and a degenerate value
 * voids it silently" -- but `--novelty-threshold`, which replaces that exact
 * number, went through a bare Number.parseFloat and was checked by nothing, so
 * the flag could express precisely the values the file may not hold.
 *
 * Both ends are silent. No Jaccard score can reach 80, so the percent-for-
 * fraction typo fails OPEN: the duplicate gate never fires, a verbatim
 * re-statement is logged as a `candidate` with exit 0 and no novelty-rejected
 * event, and once approved it joins the corpus every later check scores
 * against. A 0 -- what parseFloat('0,7') silently returns -- fails closed and
 * rejects unrelated lessons as duplicates.
 *
 * Number(), not parseFloat(), for the reason `plan quorum --confidence`
 * already documents: parseFloat stops at the first bad character, so '80%'
 * and '0,7' are accepted as numbers instead of being named as typos.
 */
function noveltyThresholdOverride(flags: Record<string, string>): number | undefined {
  const raw = flags['novelty-threshold'];
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new SmithError(
      'cli.invalid-flag',
      `--novelty-threshold must be a number in (0, 1], got "${raw}". It overrides ` +
        'scheduler.yml lessons.novelty_jaccard_threshold, which is held to the same ' +
        'range: a Jaccard score never exceeds 1, so a larger value passes every ' +
        'duplicate and a zero rejects every candidate.',
      { flag: 'novelty-threshold', value: raw },
    );
  }
  return value;
}

/**
 * The plan's claims map, as the ownership input routeFindings takes (D-41/P9-24).
 * `TaskSpecRecord.claims` is `unknown` — the plan's own schema is what
 * guarantees it is a string array, so validating it a second time here would
 * only add a second opinion. A task without claims owns no file, and is
 * dropped rather than defaulted to owning everything.
 */
function ownershipFromPlan(plan: PlanFile): ClaimedTask[] {
  return plan.tasks
    .filter((task) => Array.isArray(task.claims))
    .map((task) => ({ task_id: task.task_id, claims: task.claims as string[] }));
}

/** `--plan <file>` is optional everywhere findings are raised; without it, ownership is unknown. */
function ownershipFromFlags(flags: Record<string, string>): ClaimedTask[] | undefined {
  return flags.plan ? ownershipFromPlan(readJsonFile<PlanFile>(flags.plan)) : undefined;
}

/** One `--evidence` file with the judge it is attributed to. */
interface EvidenceSource {
  file: string;
  foundBy: string;
  foundByProvider?: string;
}

/**
 * Pair every `--evidence <file>` with the `--found-by`/`--found-by-provider`
 * written after it (D-32/P9-13).
 *
 * A task normally has several judges. `task-3-validate` came back with a test
 * gap from the reviewer and a totality violation from the security-reviewer,
 * and the old single-valued read (`flags.evidence` + `requireFlag(flags,
 * 'found-by')`) could only file both under one name — so one of the two
 * attributions was false. That is not a label: `found_by` feeds the
 * same-mistake quorum trigger and every "which role catches what" question the
 * factory asks of its own log.
 *
 * Positional pairing, not a parallel-arrays convention: `--evidence a --evidence
 * b --found-by x --found-by y` reads as two lists that happen to be the same
 * length until the day one of them is not, and then it silently swaps two
 * judges' names.
 *
 * A `--found-by` seen BEFORE any `--evidence` is the default for the sources
 * that name no judge of their own. That is exactly the pre-P9-13 line
 * (`--found-by reviewer --evidence file.json`), which the skill, the operator
 * guide and every existing caller write, and flags were order-independent when
 * they wrote it — a strict "role must follow evidence" rule would turn all of
 * them into errors overnight.
 *
 * An evidence file with neither is refused, naming the file. Falling back to
 * the nearest judge is the misattribution this whole item exists to remove, and
 * it would be silent.
 */
function evidenceSources(args: ParsedArgs): EvidenceSource[] {
  const drafts: { file: string; foundBy?: string; foundByProvider?: string }[] = [];
  let defaultFoundBy: string | undefined;
  let defaultProvider: string | undefined;

  for (const { key, value } of args.ordered) {
    if (key === 'evidence') {
      drafts.push({ file: value });
      continue;
    }
    if (key !== 'found-by' && key !== 'found-by-provider') continue;
    // Attaches to the evidence file it follows; before the first one, it is the
    // default. Last occurrence wins within a source, as it does everywhere else
    // in this parser.
    const open = drafts.at(-1);
    if (key === 'found-by') {
      if (open) open.foundBy = value;
      else defaultFoundBy = value;
    } else if (open) open.foundByProvider = value;
    else defaultProvider = value;
  }

  return drafts.map((draft) => {
    const foundBy = draft.foundBy ?? defaultFoundBy;
    if (foundBy === undefined) {
      throw new SmithError(
        'cli.missing-flag',
        `--evidence ${draft.file} has no --found-by. Each evidence file needs the judge role that produced it, written after it: --evidence <file> --found-by <role>.`,
        { flag: 'found-by', evidence: draft.file },
      );
    }
    const foundByProvider = draft.foundByProvider ?? defaultProvider;
    return { file: draft.file, foundBy, ...(foundByProvider ? { foundByProvider } : {}) };
  });
}

/**
 * Mint every `--evidence` file's findings under its own judge. Shared by `gate
 * run` and `findings raise` because they have the same judges — fixing one and
 * not the other would leave the misattribution wherever the operator happened
 * to be standing when they recorded the finding.
 */
function mintFromEvidence(
  args: ParsedArgs,
  taskId: string,
  scope: Pick<MintContext, 'spec'> = {},
): RaiseFindingInput[] {
  return evidenceSources(args).flatMap((source) =>
    mintFindings(readJsonFile<FindingEvidence[]>(source.file), {
      taskId,
      foundBy: source.foundBy,
      ...(source.foundByProvider ? { foundByProvider: source.foundByProvider } : {}),
      ...scope,
    }),
  );
}

/**
 * The gated task's declared caps, read off the same `--plan` the gate already
 * takes for ownership (D-41/P9-24) — no new flag, because a budget the gate can
 * check is by definition one the plan already stated.
 *
 * A task the plan does not name gets `undefined` rather than an error: a
 * follow-up minted by `findings raise` (D-48/P9-31) is real, gateable work that
 * no plan version has been cut for yet, and refusing to gate it would be a
 * worse answer than reporting its budget as not-declared. Ambiguity still
 * throws — two tasks the id could equally mean is a question, not an absence.
 */
function budgetFromFlags(flags: Record<string, string>, taskId: string): TaskBudget | undefined {
  if (!flags.plan) return undefined;
  const plan = readJsonFile<PlanFile>(flags.plan);
  let resolved: string;
  try {
    resolved = resolveTaskId(plan, taskId);
  } catch (err) {
    if (err instanceof SmithError && err.code === 'plan.unknown-task') return undefined;
    throw err;
  }
  const budget = plan.tasks.find((t) => t.task_id === resolved)?.budget;
  return typeof budget === 'object' && budget !== null ? (budget as TaskBudget) : undefined;
}

/**
 * The claim globs one dispatch is scoped to, read off the plan (P9-2). Only
 * claim-path-scoped lessons use them, so a role that declares no such scope
 * may omit `--plan` entirely; a `--plan` that names a task it does not contain
 * is an error rather than an empty claims list, which would silently drop
 * every claim-path lesson the task was supposed to see.
 */
function claimsForDispatch(flags: Record<string, string>): string[] {
  if (!flags.plan) return [];
  const taskId = requireFlag(flags, 'task');
  const owner = ownershipFromPlan(readJsonFile<PlanFile>(flags.plan)).find(
    (t) => t.task_id === taskId,
  );
  if (!owner) {
    throw new SmithError('cli.task-not-in-plan', `No task ${taskId} in ${flags.plan}.`, {
      taskId,
      plan: flags.plan,
    });
  }
  return owner.claims;
}

/**
 * The taxonomy `case` one dispatch is scoped to (D-129) — the selector a
 * `case-type` lesson is filtered by, read off the same immutable plan the
 * claims come from so the two cannot disagree. `--case-type` overrides it for
 * a dispatch that has no plan file to point at.
 *
 * Absent both, this returns '' and `lessonsForDispatch` warns rather than
 * injecting every case's lessons — an unknown case is not a wildcard.
 */
function caseForDispatch(flags: Record<string, string>): string {
  if (flags['case-type']) return flags['case-type'];
  if (!flags.plan) return '';
  const taskId = requireFlag(flags, 'task');
  const task = readJsonFile<PlanFile>(flags.plan).tasks.find((t) => t.task_id === taskId);
  if (!task) {
    throw new SmithError('cli.task-not-in-plan', `No task ${taskId} in ${flags.plan}.`, {
      taskId,
      plan: flags.plan,
    });
  }
  return typeof task.case === 'string' ? task.case : '';
}

/**
 * The MCP half of the epic gate (docs/standards/mcp.md step 4). Kept here
 * rather than inside epic.ts for the same reason integrationHeadSha is: epic.ts
 * is a fold over events and stays filesystem-free, so the caller reads the
 * roadmap and the manifest and states the result.
 */
function mcpSurfaceFor(epicId: string, projectDir: string, flags: Record<string, string>) {
  return resolveMcpSurface({
    epicId,
    projectDir,
    ...(flags['roadmap-path'] ? { roadmapPath: flags['roadmap-path'] } : {}),
  });
}

/**
 * The goal half of the epic gate. Same division of labour as mcpSurfaceFor:
 * the roadmap read happens out here so epic.ts stays a fold over values it was
 * handed, and `--roadmap-path` points both halves at the same file.
 */
function epicGoalFor(epicId: string, flags: Record<string, string>) {
  return resolveEpicGoal({
    epicId,
    ...(flags['roadmap-path'] ? { roadmapPath: flags['roadmap-path'] } : {}),
  });
}

/**
 * Most commands are `smith <namespace> <action> ...` (`plan validate`, `wave
 * check`, ...). A few Phase-7 commands are `smith <namespace> <positional>
 * [--flags]` with no action word at all (`smith new <project> [--ui]`,
 * `smith dream [--since ...]`) — telling the two apart on a flag-shaped
 * second token (starts with `--`) keeps every existing two-word command's
 * parsing byte-identical while letting the one-word commands' first
 * positional/flag land in `rest` instead of being swallowed as `action`.
 */
/**
 * The spellings that mean "tell me what this does" rather than "do it". `help`
 * has to be in the namespace slot's vocabulary because `smith --help` parses as
 * a namespace: splitNamespaceAction treats the first token as the namespace
 * whatever it looks like, and asking it to special-case flags would change how
 * every other command parses.
 */
const HELP_WORDS = new Set(['help', '--help', '-h']);

function splitNamespaceAction(argv: string[]): {
  namespace: string | undefined;
  action: string | undefined;
  rest: string[];
} {
  const [namespace, ...restAll] = argv;
  const second = restAll[0];
  if (second !== undefined && !second.startsWith('--')) {
    return { namespace, action: second, rest: restAll.slice(1) };
  }
  return { namespace, action: undefined, rest: restAll };
}

/**
 * Everything a wave computation reads about a plan: the plan itself with the
 * log's follow-ups merged in, the worktree policy, the import crossings
 * between its tasks, and the live status register.
 *
 * Assembled in one place because `wave next` and `wave schedule` have to read
 * the same plan. Two copies of this would be two definitions of what "the
 * plan" is, and the day they drifted the two commands would answer truthfully
 * about different plans -- the failure that is hardest to see, because both
 * outputs stay internally consistent.
 */
async function nextWaveInputFrom(
  planFile: string,
  flags: Record<string, string>,
): Promise<NextWaveInput> {
  const planOnDisk = readJsonFile<PlanFile>(planFile);
  // D-48/P9-31, the rule `wave check` already follows: a follow-up minted by
  // `findings raise` lives in the log and in no plan file. A scheduler that
  // read only the plan would never propose it — the task would exist, be
  // admissible by id, and be offered to nobody. The plan wins for an id both
  // registers know, since a re-cut plan is the newer statement of its claims.
  const events = flags.session
    ? // Lineage-wide (D-119) for the same reason the budget check is: an
      // epic's tasks are not confined to the session that happens to ask.
      await readLineageEvents(flags.session as string, eventOptsFromFlags(flags))
    : [];
  // Imported here rather than at module scope: `db/projector.js` reaches
  // `db/schema.js` and drizzle behind it, and cliBoot.test.ts holds that out
  // of the graph every `smith` invocation pays — `smith --help` included.
  // Without a session there are no events to fold, so the cost is not even
  // paid by every wave read.
  const statusById = new Map<string, string>();
  if (events.length > 0) {
    const { foldTasks } = await import('./db/projector.js');
    for (const row of foldTasks(events)) statusById.set(row.taskId, row.taskStatus);
  }
  const logged = flags.session
    ? await readAddedTasks({ sessionId: flags.session as string }, eventOptsFromFlags(flags))
    : [];
  const planIds = new Set(planOnDisk.tasks.map((t) => t.task_id));
  const followUps: TaskSpecRecord[] = logged
    .filter((t) => !planIds.has(t.taskId))
    .map((t) => ({
      task_id: t.taskId,
      // The log is the only register that holds this task's status, so a
      // missing row means nobody has moved it — which is `todo`, not done.
      task_status: statusById.get(t.taskId) ?? 'todo',
      plan_version: planOnDisk.version,
      // As written, never `?? []` (D-48): substituting an empty list for a
      // claims value nothing can read hands the comparison the one claim set
      // that overlaps nobody, and admits the unreadable task as a disjoint one.
      claims: t.claims,
    }));
  const plan: PlanFile =
    followUps.length > 0
      ? { ...planOnDisk, tasks: [...planOnDisk.tasks, ...followUps] }
      : planOnDisk;

  // P9-3, the same second question `wave check` asks: two tasks whose claims
  // are disjoint can still be coupled by an import edge between the files
  // those claims match. `wave check` uses the answer to REFUSE a wave someone
  // proposed; the callers here order one instead — the producer is admitted
  // and the consumer deferred with the crossing named, which is the remedy an
  // operator would have applied by hand after the refusal.
  //
  // Through `liveWaveTasks` so the graph is handed claim sets read by the
  // same function that refuses an unreadable one.
  const graph = buildSymbolGraph(collectSources(flags.repo ?? REPO_ROOT));
  const crossings = waveImpact(graph, liveWaveTasks(plan)).crossings;

  return {
    plan,
    policy: loadWorktreePolicy(),
    crossings,
    // The log outranks the plan file on status (D-18b): `task_status` in a
    // plan is the task's INITIAL status, and a plan read from disk hours
    // into a run still says `todo` about work that finished.
    statusById,
  };
}

async function main(): Promise<number> {
  // Refuse an unsupported runtime before anything opens the database. The
  // native binding crashes lazily — `new Database()`, not import — so a check
  // here still runs, and a subcommand that happens to avoid SQLite must not
  // be allowed to "work" on a runtime where the rest of the CLI segfaults:
  // partial support is exactly how D-47 stayed hidden.
  const runtime = checkRuntime();
  if (!runtime.supported) {
    // Prose on stderr so a human sees it even when stdout is piped into a
    // JSON parser; the structured form still goes to stdout for callers.
    process.stderr.write(`smith: unsupported runtime\n${runtime.reason ?? ''}\n`);
    printJson({ error: { code: 'unsupported-runtime', message: runtime.reason } });
    return 1;
  }

  const { namespace, action, rest } = splitNamespaceAction(process.argv.slice(2));
  // Parse against what this command declares, not against "anything starting
  // with --" (D-131/D-132). A documented command gets a spec; an undocumented
  // one gets `undefined` and the old permissive parse, because its argv has to
  // survive long enough to print `Unknown command` rather than a flag error
  // about a command that does not exist.
  const args = parseArgs(rest, flagSpecFor(namespace, action));
  const { positional, flags, repeated } = args;

  // `smith help gate run` and `smith gate run --help` ask the same question, so
  // they get the same answer: `help` in the namespace slot shifts the topic one
  // token right, and every other form is the `--help` flag parseArgs already saw.
  const helpWord = namespace !== undefined && HELP_WORDS.has(namespace);
  const topic = helpText(
    helpWord ? action : namespace,
    helpWord ? (action === undefined ? undefined : rest[0]) : action,
  );
  if ((helpWord || flags.help === 'true') && topic !== undefined) {
    process.stdout.write(topic);
    return 0;
  }

  // Refuse before dispatch what usage.ts does not describe. This is the half of
  // "the table and the dispatcher agree" that a test cannot enforce — a command
  // added below without a line above cannot run at all, so the help can never
  // be silently incomplete. (test/usage.test.ts enforces the other half.)
  if (!isDocumented(namespace, action)) {
    // Prose on stderr, structured error on stdout — same split as the runtime
    // check above, so a `| jq` pipeline still parses while a human still reads.
    process.stderr.write(topic ?? usageText());
    const given = [namespace, action].filter(Boolean).join(' ');
    printJson({
      error: { message: given === '' ? 'No command given.' : `Unknown command: ${given}` },
    });
    return 1;
  }

  // Same two-step resolution as flagSpecFor, so the usage line printed is the
  // one whose flags were actually enforced. Shared by both refusals below.
  const doc =
    COMMANDS.find((d) => d.command === `${namespace} ${action}`) ??
    COMMANDS.find((d) => d.command === namespace);

  // D-132. Before this, every `--`-prefixed token went into a bag and each call
  // site reached in for the keys it knew; nothing asked whether a key had been
  // understood by anyone. A typo, a flag borrowed from another subcommand and a
  // correct flag were the same observable event — exit 0, and the default
  // quietly used. It is also what made D-131 dangerous rather than annoying:
  // `--target-dir=<path>` degraded into an unknown flag named
  // `target-dir=<path>`, and this is the check that was not there to catch it.
  if (args.unknown.length > 0) {
    const named = args.unknown.map((f) => `--${f}`).join(', ');
    throw new SmithError(
      'cli.unknown-flag',
      `Unknown flag${args.unknown.length > 1 ? 's' : ''} for "${[namespace, action].filter(Boolean).join(' ')}": ${named}.`,
      {
        flag: args.unknown[0],
        flags: args.unknown,
        ...(doc ? { usage: usageLine(doc) } : {}),
      },
    );
  }

  // The other half of D-132. That check asks whether a flag was declared; this
  // one asks whether the declaration was honoured. A flag documented `--task
  // <task-id>` and written bare parsed as the string 'true', and 'true' is a
  // legal value for every flag whose value is a bare string — so the failure
  // was not an error but an answer: an actor named "true" in the append-only
  // log, a session filed under `true.jsonl`, an empty timeline that read as
  // "this task did nothing". cli.ts already carried one hand-written guard
  // against this shape, for `--no-findings`; eighty value-taking flags across
  // sixty-seven commands had none.
  if (args.missingValue.length > 0) {
    const named = args.missingValue.map((f) => `--${f}`).join(', ');
    throw new SmithError(
      'cli.missing-flag-value',
      `${named} ${args.missingValue.length > 1 ? 'each take a value' : 'takes a value'} and ` +
        `${args.missingValue.length > 1 ? 'were' : 'was'} given none.`,
      {
        flag: args.missingValue[0],
        flags: args.missingValue,
        ...(doc ? { usage: usageLine(doc) } : {}),
      },
    );
  }

  if (namespace === 'plan' && action === 'validate') {
    // The cast is unchanged everywhere below, but it is no longer load-bearing:
    // requirePositionals is what makes it true, and it runs first.
    const [planFile] = requirePositionals(positional, usageFor('plan validate')) as [string];
    const plan = readJsonFile<PlanFile>(planFile);
    const result = validatePlan(plan);
    printJson(result);
    return result.valid ? 0 : 1;
  }

  if (namespace === 'plan' && action === 'diff') {
    const [fileA, fileB] = requirePositionals(positional, usageFor('plan diff')) as [
      string,
      string,
    ];
    const vA = readJsonFile<PlanFile>(fileA);
    const vB = readJsonFile<PlanFile>(fileB);
    printJson(diffPlans(vA, vB));
    return 0;
  }

  if (namespace === 'plan' && action === 'quorum') {
    // Critique-only (planQuorum.ts module header): exit 0 means nothing
    // needs the operator (no trigger fired, or endorsed); exit 1 means the
    // operator must look (critiqued or escalated) before approving the plan.
    const epicId = requireFlag(flags, 'epic');
    // Required for this verb, unlike the shared envelope where it defaults to
    // 1: a quorum is a critique of one specific plan version.
    requireFlag(flags, 'plan-version');
    // Number(), not parseFloat(): both are validated, but parseFloat() would
    // silently accept a garbage suffix — parseFloat('0,7') is 0, not NaN, so a
    // European-decimal typo would read as "zero confidence" and fire trigger 3
    // on every plan. Number('0,7') is NaN and is rejected below. A bare NaN
    // must never reach runPlanQuorum() either: `NaN < threshold` is false, so
    // an unparseable value would fail OPEN — trigger 3's planner arm just never
    // fires and the plan sails through uncritiqued. A gate trigger must be
    // neither disabled nor pinned on by a typo.
    const rawConfidence = flags.confidence?.trim();
    const plannerConfidence = rawConfidence ? Number(rawConfidence) : undefined;
    if (
      (flags.confidence !== undefined && !rawConfidence) ||
      (plannerConfidence !== undefined &&
        (!Number.isFinite(plannerConfidence) || plannerConfidence < 0 || plannerConfidence > 1))
    ) {
      throw new SmithError(
        'cli.invalid-flag',
        `--confidence must be a number in [0, 1], got "${flags.confidence}".`,
        { flag: 'confidence', value: flags.confidence },
      );
    }
    const ctx = eventContextFromFlags(flags);
    // D-211: the version comes off `ctx`, not off a second read of the flag.
    // This verb used to parse `--plan-version` twice with two parsers that
    // disagree — a bare `Number.parseInt` chose the plan FILE to critique,
    // while boundedIntFlag inside eventContextFromFlags chose the plan_version
    // stamped on every event the run appends. D-210 settled the notation:
    // `1e2` is an unambiguous numeric literal for 100, and answering with the
    // 1 of its first character is the defect. So `--plan-version 1e2`
    // critiqued v1 and logged v100, with no error anywhere — and
    // planQuorum.ts's `inputRefs.plan_version`, which reads the version out of
    // the loaded FILE, then disagreed with the envelope around it. A record
    // that names two different plans is worse than one that fails: reading it
    // back, neither number can be trusted. One read, one number.
    const version = ctx.planVersion;
    const outcome = await runPlanQuorum(
      { epicId, version, ...(plannerConfidence !== undefined ? { plannerConfidence } : {}) },
      ctx,
      eventOptsFromFlags(flags),
    );
    printJson(outcome);
    return outcome.outcome === 'endorsed' ? 0 : 1;
  }

  if (namespace === 'plan' && action === 'ingest') {
    // D-46/P9-29: where a task starts existing as far as the log — and so
    // the DB, the kanban and every dashboard number — is concerned. Before
    // this, a task row only sprang into being as a side effect of whatever
    // wave or gate event first happened to name an id, with no epic, no
    // claims and no budget. Idempotent, because ingesting the plan again
    // (a resumed session, a v(n+1) that carries tasks forward) is normal.
    const [planFile] = requirePositionals(positional, usageFor('plan ingest')) as [string];
    const plan = readJsonFile<PlanFile>(planFile);
    const ctx = eventContextFromFlags(flags);
    const opts = eventOptsFromFlags(flags);
    const written = await emitTasksAdded(plan, ctx, opts);
    // D-254: the arrows, after the nodes. The plan declares a DAG and the
    // scheduler has always read it off the file, but nothing wrote it to the
    // log -- so the db's `edges` table was empty and every operator-facing
    // view of the graph showed a flat list. Counted in the output for the
    // same reason `added` is: an ingest that silently wrote none is exactly
    // what went unnoticed.
    const edges = await emitEdgesRecorded(plan, ctx, opts);
    const added = written.filter((e) => e.record.event_type === 'task-added').length;
    printJson({
      epic: plan.epic_id,
      version: plan.version,
      added,
      superseded: written.length - added,
      skipped: plan.tasks.length - added,
      edges: edges.length,
    });
    return 0;
  }

  // P9-9/D-33: the one legitimate way to change an immutable plan. It refuses
  // to cut a version that cites no spec finding, so "the plan changed" is
  // always answerable with "which finding said it was wrong".
  if (namespace === 'plan' && action === 'amend') {
    const plan = readJsonFile<PlanFile>(requireFlag(flags, 'plan'));
    // Comma-split, not repeated: a finding id has no commas, and an amendment
    // routinely cites several at once.
    const findingIds = requireFlag(flags, 'findings')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    // Same comma split, for the same reason: a path has no commas either, and
    // the whole point of D-123 is that this list is routinely longer than one.
    const sites = requireFlag(flags, 'sites')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const changes = flags.changes ? readJsonFile<PlanChanges>(flags.changes) : undefined;
    const result = await amendPlan(
      {
        plan,
        findingIds,
        rationale: requireFlag(flags, 'rationale'),
        sites,
        ...(changes ? { changes } : {}),
      },
      eventContextFromFlags(flags),
      { ...eventOptsFromFlags(flags), ...planOptsFromFlags(flags) },
    );
    // No no-op warning here any more. A pure carry-forward used to be legal
    // and merely suspicious — the shape a forgotten --changes takes — so the
    // CLI printed a warning and cut the version anyway. Since D-127 an
    // amendment that adds and supersedes nothing is refused by `amendPlan`
    // itself, before the version exists: the cited finding would have had
    // nothing to wait on. The check belongs there and not here, because the
    // library is where the finding is transitioned; a guard living only in
    // the CLI would let any other caller close an unwaivable finding with an
    // identical plan version.
    printJson({
      epic: result.plan.epic_id,
      version: result.plan.version,
      previousVersion: plan.version,
      findingIds,
      sites,
      // Printed at authorship, not only recorded for the close: the operator
      // who just named these is the one best placed to say whether a site with
      // no task behind it is a deliberate call or a forgotten one.
      sitesUnclaimed: result.sitesUnclaimed,
      diff: result.diff,
    });
    return 0;
  }

  // The worker's half of the same wall. A coder cannot emit an event and
  // cannot mint a spec-scoped finding, so it returns a spec_change_request in
  // its structured_output and the node that dispatched it runs this. Nothing
  // here writes a plan file: `plan amend` above stays the only path to a
  // version, and this only records that someone asked for one.
  if (namespace === 'plan' && action === 'propose') {
    const plan = readJsonFile<PlanFile>(requireFlag(flags, 'plan'));
    // A file, not a flag soup: `changes` alone is a nested object, and the
    // worker already returned the whole request as JSON. Asking the dispatcher
    // to re-type it into flags would be asking it to paraphrase the worker.
    const request = readJsonFile<SpecChangeRequest>(requireFlag(flags, 'request'));
    const proposal = await proposeSpecChange(
      {
        plan,
        taskId: requireFlag(flags, 'task'),
        proposedBy: requireFlag(flags, 'proposed-by'),
        ...(flags['proposed-by-provider']
          ? { proposedByProvider: flags['proposed-by-provider'] }
          : {}),
        request,
      },
      eventContextFromFlags(flags),
      { ...eventOptsFromFlags(flags), ...planOptsFromFlags(flags) },
    );
    printJson(proposal);
    return 0;
  }

  if (namespace === 'plan' && action === 'proposals') {
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    // Same P9-28 rule the findings verbs follow: an empty list is an answer
    // about the proposals, and it must not double as the answer about a
    // session that was never opened.
    requireSession(sessionId, eventOpts);
    const proposals = await listSpecChanges(
      sessionId,
      {
        epicId: flags.epic,
        taskId: flags.task,
        status: flags.status as SpecChangeStatus | undefined,
      },
      { ...eventOpts, ...planOptsFromFlags(flags) },
    );
    // Printed whole, diff included. The operator's next move is a yes or a no
    // on a plan diff, and a listing that made them go and read the proposal
    // event by hand to see it would have answered the wrong question.
    printJson(proposals);
    return 0;
  }

  // "Duyệt nhanh" is one command, and it is one command without any guard
  // being relaxed: `amendPlan` still demands a rationale, findings, and
  // sites. Approval supplies them from what the worker already recorded.
  if (namespace === 'plan' && action === 'approve') {
    const [proposalId] = requirePositionals(positional, usageFor('plan approve')) as [string];
    const plan = readJsonFile<PlanFile>(requireFlag(flags, 'plan'));
    const result = await approveSpecChange(
      {
        proposalId,
        plan,
        decidedBy: requireFlag(flags, 'decided-by'),
        ...(flags.rationale ? { rationale: flags.rationale } : {}),
      },
      eventContextFromFlags(flags),
      { ...eventOptsFromFlags(flags), ...planOptsFromFlags(flags) },
    );
    printJson({
      proposalId,
      epic: result.plan.epic_id,
      version: result.plan.version,
      previousVersion: plan.version,
      findingIds: [result.proposal.findingId],
      sites: result.proposal.sites,
      sitesUnclaimed: result.sitesUnclaimed,
      diff: result.diff,
    });
    return 0;
  }

  if (namespace === 'plan' && action === 'reject') {
    const [proposalId] = requirePositionals(positional, usageFor('plan reject')) as [string];
    // --rationale is required here and optional on approve, which is not an
    // inconsistency: approval can fall back to the worker's own argument
    // because approval agrees with it. A rejection is the operator saying
    // something the log does not already contain.
    const proposal = await rejectSpecChange(
      {
        proposalId,
        decidedBy: requireFlag(flags, 'decided-by'),
        rationale: requireFlag(flags, 'rationale'),
      },
      eventContextFromFlags(flags),
      { ...eventOptsFromFlags(flags), ...planOptsFromFlags(flags) },
    );
    printJson(proposal);
    return 0;
  }

  if (namespace === 'wave' && action === 'check') {
    // `required: 1` — the variadic tail has its own, better message below.
    const [planFile] = requirePositionals(positional, usageFor('wave check'), 1) as [string];
    const plan = readJsonFile<PlanFile>(planFile);
    // D-46/P9-29: every id is minted from the plan, not taken as typed. The
    // old code filtered the plan's tasks by `taskIds.includes(t.task_id)`,
    // so a wave named in the other id convention matched NOTHING and
    // validateWave([]) pronounced the empty set admissible — a wave could
    // pass this check without a single one of its tasks having been looked
    // at. resolveTaskId turns that silence into a named error.
    const typedIds = positional.slice(1);
    if (typedIds.length === 0) {
      throw new SmithError(
        'cli.empty-wave',
        'Usage: smith wave check <plan.json> <task-id>... — a wave with no tasks is not a wave.',
        { plan: plan.epic_id },
      );
    }
    // D-48/P9-31: a follow-up task exists only in the log, so the log is the
    // second register an id may be found in — and the place its claims come
    // from. Read only when there is a session to read; the plan wins for an
    // id both know, since a re-cut plan is the newer statement of its claims.
    const logged = flags.session
      ? await readAddedTasks({ sessionId: flags.session as string }, eventOptsFromFlags(flags))
      : [];
    const taskIds = typedIds.map((typed) =>
      resolveTaskId(
        plan,
        typed,
        logged.map((t) => t.taskId),
      ),
    );
    // Neither register is narrowed on the way in. `?? []` used to stand here
    // and on the line above, and it fires on a missing claims field but not on
    // a claims field holding the wrong thing: a plan writing `"claims":
    // "src/api/**"` reached the comparison as a string and was iterated by
    // character. Both defaults said "claims nothing", which validateWave read
    // as "disjoint from everyone" — the answer that admits the wave. The shape
    // is that function's to judge, once, where the comparison happens.
    const claimsById = new Map<string, unknown>(logged.map((t) => [t.taskId, t.claims]));
    for (const t of plan.tasks) {
      claimsById.set(t.task_id, t.claims);
    }
    const tasks: ProposedWaveTask[] = taskIds.map((id) => ({
      task_id: id,
      claims: claimsById.get(id),
    }));
    const policy = loadWorktreePolicy();
    // D-212: the plan has been in hand since the top of this verb, and it is
    // the register that says which of these tasks may not run beside which.
    const result = validateWave(tasks, policy, plan.edges);

    // P9-3: the claim check compares two lists of globs. This compares the
    // edges between the files those globs match, which is where the conflict
    // a disjoint claim list cannot see actually lives — task A changes
    // `parse()`, task B calls it, neither writes the other's file. A crossing
    // between two tasks the plan declared no edge between is a dependency the
    // planner missed, so the wave is refused and the remedy is to run them in
    // order. (A crossing the plan DID declare never reaches here: validateWave
    // above already refuses a wave holding both ends of a declared edge.)
    //
    // Only asked of a wave that survived the claim check: validateWave is what
    // proves the claims are readable at all, and a wave already refused is
    // better named by the failure an operator can act on first.
    const symbolImpact = result.valid
      ? waveImpact(
          buildSymbolGraph(collectSources(flags.repo ?? REPO_ROOT)),
          // Readable by construction — validateWave threw otherwise.
          tasks as WaveTask[],
        )
      : null;
    const coupled = symbolImpact !== null && !symbolImpact.ok;

    // The epic budget gate, checked after the claim check so a wave that fails
    // both is still named by the failure an operator can act on first — and so
    // the claim errors above keep their exact wording. Two separate questions:
    // `valid` answers "may these run beside each other", `budget` answers "can
    // this epic afford to start them", and the JSON carries both because a
    // wave refused for cost is not an invalid wave.
    //
    // Upstream of every dispatch on purpose. D-29 rules that the *task* cap
    // must only record an overrun, because a self-policed cap on work already
    // running becomes pressure on the work being measured. Wave admission is
    // the other side of that line: nothing in the wave has been dispatched
    // yet, so refusing here distorts no work — it decides whether the work
    // begins.
    const rationaleFlag = flags['override-rationale'];
    const rationale = rationaleFlag?.trim() ?? '';
    if (rationaleFlag !== undefined && rationale === '') {
      // Mirrors epic.ts's close-refused check (D-43/P9-27): the reason is the
      // whole point of recording an override, and a blank one would leave the
      // log saying a human decided this with nothing to say what they decided.
      throw new SmithError(
        'cli.blank-override-rationale',
        'Refusing to admit this wave with a blank --override-rationale: the reason is the whole point of recording the override.',
        { plan: plan.epic_id },
      );
    }
    const budgetEvents = flags.session
      ? // D-119: lineage-wide, not this session's own log — an epic's spend is
        // the sum of every session that worked on it.
        await readLineageEvents(flags.session as string, eventOptsFromFlags(flags))
      : [];
    const budgetPolicy = loadBudgetPolicy(flags['budget-policy']);
    const budget = checkWaveBudget(
      budgetEvents,
      budgetPolicy,
      declaredWaveBudgets(plan, taskIds, budgetPolicy),
      { sessionId: flags.session ?? '', epicId: plan.epic_id },
    );
    const overridden = rationale !== '' && blocksAdmission(budget.status);
    const blocked = blocksAdmission(budget.status) && !overridden;

    // Log only an admissible wave, and only after it is known to be one:
    // `wave-admitted` is what moves a task to `ready`, so writing it for a
    // wave that just failed its claim-disjointness check would record an
    // admission that never happened. `--dry` asks the question without
    // answering it in the log.
    if (result.valid && !coupled && !blocked && flags.dry !== 'true') {
      await emitWaveAdmitted(
        plan,
        taskIds,
        eventContextFromFlags(flags),
        eventOptsFromFlags(flags),
        admissionBudget(budget, overridden ? rationale : undefined),
      );
    }
    printJson({ ...result, symbolImpact, budget });
    return result.valid && !coupled && !blocked ? 0 : 1;
  }

  if (namespace === 'wave' && action === 'next') {
    const [planFile] = requirePositionals(positional, usageFor('wave next')) as [string];
    const result = computeNextWave(await nextWaveInputFrom(planFile, flags));
    printJson(result);
    // Writes nothing on purpose. `wave-admitted` is what moves a task to
    // `ready`, and this command proposes rather than admits — recording an
    // admission here would move tasks nobody had yet agreed to start, and
    // leave `wave check` re-admitting what the log already said was admitted.
    //
    // The cost question is deliberately not asked here. `wave check` refuses a
    // wave the epic cannot afford, and it stays the only place that verdict is
    // rendered — a proposer that also priced the wave would be a second opinion
    // about the same fact, and would have to decide which task to drop, which
    // is an operator's call and not a graph's. So a proposed wave can still be
    // refused for cost on the next line of the playbook; that is the gate
    // working, not the proposal being wrong.
    //
    // Exit 1 names a stall, not an empty answer: work is left, and none of it
    // can begin. A loop driving waves needs that distinguished from the epic
    // simply being finished, which is an empty wave with nothing remaining.
    return result.wave.length > 0 || result.remaining === 0 ? 0 : 1;
  }

  if (namespace === 'wave' && action === 'schedule') {
    const [planFile] = requirePositionals(positional, usageFor('wave schedule')) as [string];
    // Static would be fine — waveSchedule.js reaches nothing waveNext.js has
    // not already put on the boot path — but the input assembly it is handed
    // may dynamically import `db/projector.js`, so the await is here anyway.
    const { scheduleWaves } = await import('./waveSchedule.js');
    const schedule = scheduleWaves(await nextWaveInputFrom(planFile, flags));
    printJson(schedule);
    // Writes nothing, for the reason `wave next` writes nothing and one more:
    // every round after the first is a simulation. The tasks it marks complete
    // were completed by nobody, and a log that recorded them would be claiming
    // work that has not happened.
    return schedule.exitCode;
  }

  if (namespace === 'wave' && action === 'audit') {
    // Dynamic for P9-2 (test/cliBoot.test.ts): the module reaches
    // agents-registry.ts, and nothing that only `wave audit` needs should be
    // on the path every `smith --help` walks.
    const { auditWaveConcurrency, summariseWaveConcurrency } = await import('./waveConcurrency.js');
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(sessionId, eventOpts);
    // Lineage-wide, for the reason `wave next` and the budget check already
    // are (D-119): an epic's waves are not confined to the session that
    // happens to ask, and a wave admitted in session 1 whose agents ran in
    // session 2 would read as `unobserved` -- the factory reported broken on
    // nothing but where the operator stood.
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency(await readLineageEvents(sessionId, eventOpts), {
        epicId: typeof flags.epic === 'string' ? flags.epic : undefined,
      }),
    );
    printJson(summary);
    return summary.exitCode;
  }

  if (namespace === 'new') {
    // `smith new <project> [--ui]` — action doubles as the positional
    // project name here (splitNamespaceAction), never a subcommand word.
    // `--target-dir`/`--roadmap-path` override the real projects root and
    // factory/specs/roadmap.md paths (same override pattern as
    // `--state-dir` elsewhere in this file) so tests never touch either.
    if (!action) {
      // Checked all along, but filed under the flag code; one kind of mistake,
      // one code (P9-28). The project name cannot go through
      // requirePositionals because splitNamespaceAction spends it on `action`.
      const usage = usageLine(usageFor('new'));
      throw new SmithError(
        'cli.missing-positional',
        `Missing required argument <project>. Usage: ${usage}`,
        { missing: ['project'], usage },
      );
    }
    const result = scaffoldProject({
      projectName: action,
      ui: flags.ui === 'true',
      ...(flags['target-dir'] ? { targetDir: flags['target-dir'] } : {}),
      // P9-19: `smith new` installs the toolchain and runs the project's own
      // gates before it commits, so the first epic planned here starts against
      // a repo whose checks are known to pass. --skip-toolchain is for an
      // offline operator; the report then says `skipped`, never a green.
      ...(flags['skip-toolchain'] === 'true' ? { skipToolchain: true } : {}),
    });
    registerProjectInRoadmap(action, flags['roadmap-path']);
    printJson(result);
    // Red gates are reported, not hidden: the tree stays for the operator to
    // fix, and the exit code says the toolchain was not proven.
    return result.toolchain.status === 'failed' ? 1 : 0;
  }

  if (namespace === 'mcp' && action === 'init') {
    // Deliberately not folded into `smith new`: the MCP surface is due at the
    // END of a project, when the tools it should expose are known, and the
    // milestone this registers is what makes that due date real. Scaffolding it
    // on day one would ship a manifest declaring nothing, which is exactly the
    // rubber-stamp the standard exists to prevent.
    const [projectName] = requirePositionals(positional, usageFor('mcp init')) as [string];
    const result = addMcpSurface({
      projectName,
      ...(flags['target-dir'] ? { targetDir: flags['target-dir'] } : {}),
      ...(flags['roadmap-path'] ? { roadmapPath: flags['roadmap-path'] } : {}),
    });
    printJson(result);
    return 0;
  }

  // The verdict `smith epic close` gates on, rendered on its own so it can be
  // read before the gate refuses. Exit 1 on red — same convention as `plan
  // validate` and `gate run`, so CI needs no output parsing.
  if (namespace === 'mcp' && action === 'check') {
    const [projectName] = requirePositionals(positional, usageFor('mcp check')) as [string];
    const report = runMcpCheck({
      projectName,
      ...(flags['target-dir'] ? { targetDir: flags['target-dir'] } : {}),
      ...(flags['roadmap-path'] ? { roadmapPath: flags['roadmap-path'] } : {}),
    });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'scheduler' && action === 'run') {
    const { computeProposals, runScheduler } = await import('./scheduler.js');
    const sessionId = requireFlag(flags, 'session');
    const dry = flags.dry === 'true';
    requireSession(sessionId, eventOptsFromFlags(flags));
    // The lineage (D-119). The scheduler's idempotency is positional — a
    // proposal counts as resolved when the events resolving it appear LATER in
    // the log — so a session-scoped read from a continuation finds none of the
    // parent's proposals and re-proposes every recheck the epic already ran.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const now = isoDateFlag(flags, 'now') ?? new Date();
    // `repeated`, not `flags`: --project may name several repos, and the
    // last-occurrence-wins read would silently watch only the final one.
    const input = { events, now, ...(repeated.project ? { projectDirs: repeated.project } : {}) };

    if (dry) {
      printJson({ proposals: computeProposals(input) });
      return 0;
    }

    const ctx = eventContextFromFlags(flags);
    const result = await runScheduler(
      input,
      {
        sessionId: ctx.sessionId,
        planVersion: ctx.planVersion,
        causalParent: ctx.causalParent as string,
        actor: ctx.actor,
      },
      eventOptsFromFlags(flags),
      false,
    );
    printJson(result);
    return 0;
  }

  // The other half of a scheduler tick. `run --dry` answers "what is due";
  // this answers "which of that may proceed without me", and answers it out
  // loud, in one place, from scheduler.yml's `autonomy:` block alone.
  //
  // It enacts nothing. Splitting the classification out of the dispatch is
  // the whole safety property: an operator can read what the policy would
  // have let run, and argue with it, before any of it moves. So this appends
  // no event, writes no worktree and starts no agent -- exactly the daemon's
  // invariant, held by the command a person types too.
  if (namespace === 'scheduler' && action === 'admit') {
    const { computeProposals, loadSchedulerPolicy } = await import('./scheduler.js');
    const { admitProposals } = await import('./autonomy.js');
    // Kept out of the boot graph on purpose: db/projector.js reaches
    // db/schema.js, and test/cliBoot.test.ts pins that `smith --help` never
    // pays for it. A top-level import here would be invisible until that test
    // failed (P9-2).
    const { foldTasks } = await import('./db/projector.js');

    const sessionId = requireFlag(flags, 'session');
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage, for the same reason `run` reads it: proposal idempotency is
    // positional, so a session-scoped read from a continuation would classify
    // proposals the parent already resolved.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const now = isoDateFlag(flags, 'now') ?? new Date();
    // Read once and passed down both halves. `--policy` has to govern which
    // proposals exist as well as who may say yes to them: a file that retuned
    // `recheck.days_elapsed` but was consulted only for `autonomy:` would
    // classify proposals the operator's own policy never made.
    const policy = loadSchedulerPolicy(flags.policy);
    const proposals = computeProposals({
      events,
      now,
      policy,
      ...(repeated.project ? { projectDirs: repeated.project } : {}),
    });

    // A RecheckProposal names a task and no paths, so without this the
    // security match would see an opaque id and clear a recheck of
    // src/auth/session.ts. The claims come from the log, through the same
    // fold every other reader uses.
    const claimsByTask = new Map<string, readonly string[]>();
    for (const task of foldTasks(events)) {
      if (task.claims && task.claims.length > 0) claimsByTask.set(task.taskId, task.claims);
    }

    const admissions = admitProposals(proposals, policy.autonomy, {
      // One list, read from crosscheck.yml rather than copied into
      // scheduler.yml: promoting a word has to move the cross-check trigger
      // and this gate together, or a keyword added in one place quietly
      // stops meaning anything in the other.
      securityKeywords: loadCrosscheckPolicy(flags.crosscheck).planQuorum.securityKeywords,
      claimsByTask,
    });
    printJson({ admissions });
    return 0;
  }

  // The background watcher (Phase 10). Four verbs and one invariant: none of
  // them dispatches an agent, merges a branch or writes to a worktree. A
  // process that outlives the operator's terminal is the last place to relax
  // the rule that a human admits work.
  if (namespace === 'daemon' && action === 'run') {
    const { DEFAULT_DAEMON_DIR, DEFAULT_INTERVAL_SECONDS, runDaemon } = await import('./daemon.js');
    const dir = flags.dir ?? DEFAULT_DAEMON_DIR;
    const interval =
      flags.interval === undefined ? DEFAULT_INTERVAL_SECONDS : Number(flags.interval);
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new SmithError(
        'cli.invalid-flag',
        `--interval must be a whole number of seconds greater than zero, got "${flags.interval}".`,
        { flag: 'interval', value: flags.interval ?? null },
      );
    }
    // The register that judges `--project`, supplied here rather than defaulted
    // inside the fold: this is where the flags are read, so this is where the
    // list they should have covered belongs. A tick handed no register raises
    // no `unwatched-project`, which keeps inspectFactory's answer a function of
    // its arguments.
    const { factoryProjects } = await import('./projects.js');
    const tickOpts: TickOptions = {
      ...eventOptsFromFlags(flags),
      ...(repeated.project ? { projectDirs: repeated.project } : {}),
      readProjects: () => factoryProjects(),
      ...(flags.db ? { dbPath: flags.db } : {}),
      ...(flags['no-db'] === 'true' ? { projectDb: false } : {}),
    };

    // SIGTERM has to reach the sleep, not just the flag: a daemon woken only
    // by the next tick would ignore `smith daemon stop` for up to an interval,
    // and an operator who waits that long reaches for `kill -9` — which is
    // exactly the exit that strands the lock.
    let stopping = false;
    let wake: (() => void) | null = null;
    const requestStop = (): void => {
      stopping = true;
      wake?.();
    };
    process.once('SIGTERM', requestStop);
    process.once('SIGINT', requestStop);

    const reports = await runDaemon({
      dir,
      intervalSeconds: interval,
      ...tickOpts,
      ...(flags.once === 'true' ? { once: true } : {}),
      shouldContinue: () => !stopping,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, ms);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        }),
    });
    const last = reports[reports.length - 1];
    printJson({ ticks: reports.length, dir, ...(last === undefined ? {} : { last }) });
    return 0;
  }

  if (namespace === 'daemon' && action === 'start') {
    const { DaemonError, DEFAULT_DAEMON_DIR, readLock } = await import('./daemon.js');
    const dir = flags.dir ?? DEFAULT_DAEMON_DIR;
    const held = readLock(dir);
    if (held !== null) {
      // Let acquireLock own the liveness question — one implementation of
      // "is that pid still there" rather than a second opinion here.
      throw new DaemonError(
        'daemon.already-running',
        `A daemon (pid ${held.pid}, started ${held.startedAt}) already holds ${dir}. ` +
          'Run `smith daemon stop` first, or `smith daemon status` to see what it last found.',
        { pid: held.pid, dir },
      );
    }
    mkdirSync(dir, { recursive: true });
    // `ignore` would discard the one account of why a detached daemon died.
    const logFd = openSync(path.join(dir, 'daemon.log'), 'a');
    const argv = [
      'daemon',
      'run',
      '--dir',
      dir,
      ...(flags.interval === undefined ? [] : ['--interval', flags.interval]),
      // One `--project` per repo, so the detached child watches every repo the
      // operator named rather than the last one they typed.
      ...(repeated.project ?? []).flatMap((dir) => ['--project', dir]),
      ...(flags.db === undefined ? [] : ['--db', flags.db]),
      ...(flags['no-db'] === 'true' ? ['--no-db'] : []),
      ...(flags['state-dir'] === undefined ? [] : ['--state-dir', flags['state-dir']]),
    ];
    const child = spawn(process.execPath, [process.argv[1] as string, ...argv], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    // The child writes the lock under its OWN pid; this one is the spawn's
    // answer, and `smith daemon status` is what confirms the lock exists.
    printJson({ started: true, pid: child.pid ?? null, dir, log: path.join(dir, 'daemon.log') });
    return 0;
  }

  if (namespace === 'daemon' && action === 'status') {
    const { DEFAULT_DAEMON_DIR, daemonStatus } = await import('./daemon.js');
    const dir = flags.dir ?? DEFAULT_DAEMON_DIR;
    const report = daemonStatus(dir);
    printJson(report);
    // Exit 1 when nothing is watching, so a health check is `smith daemon
    // status >/dev/null` rather than a JSON parse in a shell script. A stale
    // daemon fails it too: one wedged mid-tick still holds its lock and still
    // answers `kill -0`, so a probe that only asked `running` reported the
    // silence as fine -- which is the exact condition a watcher exists to
    // break. The JSON still separates the two, for a reader that cares which.
    return report.running && !report.stale ? 0 : 1;
  }

  if (namespace === 'daemon' && action === 'stop') {
    const { DEFAULT_DAEMON_DIR, stopDaemon } = await import('./daemon.js');
    const dir = flags.dir ?? DEFAULT_DAEMON_DIR;
    printJson(stopDaemon(dir));
    return 0;
  }

  // What the factory is answerable for, read off the register it already keeps:
  // `registerProjectInRoadmap` writes a `- project:` bullet for every project
  // it scaffolds. Without this the `unwatched-project` finding would name a
  // repo and leave the operator to reconstruct the rest of the list by hand.
  if (namespace === 'projects' && action === 'list') {
    const { factoryProjects } = await import('./projects.js');
    const refs = factoryProjects(flags.roadmap === undefined ? {} : { roadmapPath: flags.roadmap });
    const flagLine = refs.map((ref) => `--project ${ref.dir}`).join(' ');
    if (flags.json) {
      printJson({ projects: refs, flags: flagLine });
    } else {
      // The flag line last, because it is the line the operator copies, and a
      // thing to copy is easier to find at the bottom than in the middle.
      for (const ref of refs) {
        process.stdout.write(`${ref.self ? '*' : ' '} ${ref.name}\t${ref.dir}\n`);
      }
      process.stdout.write(`\n${flagLine}\n`);
    }
    return 0;
  }

  if (namespace === 'worktree' && action === 'create') {
    const [projectDir, epic, taskId] = requirePositionals(
      positional,
      usageFor('worktree create'),
    ) as [string, string, string];
    printJson(createTaskWorktree(projectDir, epic, taskId));
    return 0;
  }

  if (namespace === 'worktree' && action === 'rm') {
    const [projectDir, epic, taskId] = requirePositionals(positional, usageFor('worktree rm')) as [
      string,
      string,
      string,
    ];
    removeTaskWorktree(projectDir, epic, taskId);
    printJson({ removed: true, epic, taskId });
    return 0;
  }

  // The judge-immutability guard (P9-5): fingerprint before the judge runs,
  // verify after. Six judge roles are read-only in prose and hold `Bash` in
  // fact (agent-interviews.md N-10) — this turns the sentence into a check.
  if (namespace === 'worktree' && action === 'fingerprint') {
    const [worktreeDir] = requirePositionals(positional, usageFor('worktree fingerprint')) as [
      string,
    ];
    printJson(fingerprintWorktree(worktreeDir));
    return 0;
  }

  if (namespace === 'worktree' && action === 'verify') {
    // No `required` override any more: `--before <fingerprint.json>` is a flag,
    // and since P9-21 flags live outside the counted string.
    const [worktreeDir] = requirePositionals(positional, usageFor('worktree verify')) as [string];
    const before = readJsonFile<WorktreeFingerprint>(requireFlag(flags, 'before'));
    const result = checkWorktreeImmutable(worktreeDir, before);
    printJson(result);
    // Unlike `security triggers`, drift is a violation, not an instruction:
    // the judge's result is not trustworthy once it moved what it judged.
    return result.unchanged ? 0 : 1;
  }

  if (namespace === 'worktree' && action === 'stale') {
    const [projectDir, epic] = requirePositionals(positional, usageFor('worktree stale')) as [
      string,
      string,
    ];
    printJson(listStale(projectDir, epic));
    return 0;
  }

  // P9-6: the two ends of ingested text. `prompt wrap` fences a payload before
  // it enters a prompt; `research check` keeps a brief's citations separable
  // from its recommendation on the way back out.
  if (namespace === 'prompt' && action === 'wrap') {
    const [file] = requirePositionals(positional, usageFor('prompt wrap'), 1) as [string];
    const block = wrapIngested({
      // `-` reads stdin's usual role here: the payload is often a fetch that
      // was never a file. Kept explicit rather than implicit so a file named
      // `-` is a caller error, not a silent stdin read.
      text: file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8'),
      kind: requireFlag(flags, 'kind') as IngestKind,
      source: requireFlag(flags, 'source'),
    });
    if (flags.json) {
      printJson(block);
    } else {
      // The default output is the block itself, because the caller is composing
      // a prompt: piping JSON into one would fence the escaping in quotes.
      process.stdout.write(`${block.text}\n`);
    }
    return 0;
  }

  // D-142: the writer `user_prompt` never had. Five readers folded the type —
  // the prompts table, the Decisions lens, the escalation window, the UI's
  // Prompts filter — and the only way one reached a log was a person hand-
  // writing `smith event append`, which nobody did. It sits beside `prompt
  // wrap` because both are about what enters a prompt honestly: wrap labels
  // borrowed text, record puts the operator's own on the record.
  if (namespace === 'prompt' && action === 'record') {
    const [file] = requirePositionals(positional, usageFor('prompt record'), 1) as [string];
    // Same `-` convention as `prompt wrap`, and for a stronger reason: an
    // operator turn is typed, not filed, so stdin is the ordinary case here
    // and a heredoc is how it arrives.
    const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
    const stored = await recordUserPrompt(
      text,
      eventContextFromFlags(flags),
      eventOptsFromFlags(flags),
    );
    // The event id, not the record: what the caller does next is pass it as
    // `--causal-parent` to the dispatch this prompt caused, which is the edge
    // that makes the interleaved timeline (architecture §7) real rather than
    // inferred from timestamps.
    printJson({ event_id: stored.event_id, record: stored.record });
    return 0;
  }

  if (namespace === 'research' && action === 'check') {
    const result = checkBrief(readJsonFile<unknown>(requireFlag(flags, 'brief')));
    printJson(result);
    // A brief whose claims are uncited, or whose recommendation rests on
    // nothing in it, is a contract violation like a failed claims check —
    // not a dispatch instruction, so the exit code is the verdict.
    return result.ok ? 0 : 1;
  }

  if (namespace === 'queue' && action === 'run') {
    const [epic] = requirePositionals(positional, usageFor('queue run')) as [string];
    // Same disease as the positionals, on the flag side, in the one verb that
    // runs git: `flags.project as string` put an undefined cwd into every
    // command step() shells out to.
    const projectDir = requireFlag(flags, 'project');
    const testCmd = requireFlag(flags, 'test-cmd');
    const tasksFile = requireFlag(flags, 'tasks');
    // D-260: the narrowed command is validated here, once, before any git
    // runs. A template with no `{files}` would otherwise render as the full
    // suite on every task while the outcome said `selected` — a gate that
    // lies about its own coverage is worse than a slow one.
    const selectTestCmd = flags['select-test-cmd'] as string | undefined;
    if (selectTestCmd !== undefined) assertSelectableTestCmd(selectTestCmd);
    const tasks =
      readJsonFile<Array<{ taskId: string; branch: string; worktreeDir: string }>>(tasksFile);
    // D-46/P9-29: the queue is the only component that knows a branch landed,
    // and it used to say so to stdout and nowhere else — which is why the
    // projector's `completed` column was unreachable by machine. `--session`
    // is what turns the run into a fact; without it the queue still runs, and
    // still tells nobody.
    const events = flags.session
      ? { ctx: eventContextFromFlags(flags), ...eventOptsFromFlags(flags) }
      : undefined;
    // `--tasks` is hand-written, so its ids are whatever was typed. Minting
    // them from the plan before any git runs is the whole point of P9-29: a
    // bare id here would put `wave-merged` in the log under a spelling the
    // plan never used, which is how the dogfood epic folded one task instead
    // of six. Refuse the run whole rather than merge some and mislabel them.
    if (events && !flags.plan) {
      throw new SmithError(
        'cli.missing-flag',
        'queue run --session also needs --plan <plan.json>: a merge may only be logged under the task id the plan declares.',
        { epic },
      );
    }
    if (flags.plan) {
      const plan = readJsonFile<PlanFile>(flags.plan as string);
      // …and the plan is not the only register: a follow-up minted by
      // `findings raise` is in the log alone, and refusing it here is what
      // left D-41's own follow-up unmergeable (D-48/P9-31).
      const logged = flags.session
        ? await readAddedTasks({ sessionId: flags.session as string }, eventOptsFromFlags(flags))
        : [];
      const loggedIds = logged.map((t) => t.taskId);
      for (const task of tasks) task.taskId = resolveTaskId(plan, task.taskId, loggedIds);
      // D-186: the ids are the plan's now, so the order can be too. `--tasks`
      // is hand-written, and merging in the order someone typed lets a task
      // land before the task it declares `depends_on` — the epic's cumulative
      // gate then runs against an integration branch missing the prerequisite,
      // and blames the wrong branch when it goes red. `admit()` exists for
      // exactly this and had no caller until here; a follow-up the plan never
      // declared carries no edges, so it just sorts by id among its peers.
      const order = admit(
        tasks.map((t) => ({ task_id: t.taskId })),
        plan.edges.map((e) => ({ task: e.task, dependsOn: e.dependsOn })),
      );
      // Stable: two tasks the plan does not order keep the order admit gave
      // them, and a duplicated id is still run twice rather than dropped.
      tasks.sort((a, b) => order.indexOf(a.taskId) - order.indexOf(b.taskId));
    }
    const outcomes = [];
    let allMerged = true;
    for (const task of tasks) {
      const outcome = await step(task, {
        projectDir,
        epic,
        testCmd,
        ...(selectTestCmd !== undefined ? { selectTestCmd } : {}),
        ...(events ? { events } : {}),
      });
      outcomes.push(outcome);
      if (outcome.outcome !== 'merged') {
        allMerged = false;
        break;
      }
    }
    printJson(outcomes);
    return allMerged ? 0 : 1;
  }

  if (namespace === 'queue' && action === 'adopt') {
    const [typedTaskId] = requirePositionals(positional, usageFor('queue adopt')) as [string];
    const projectDir = requireFlag(flags, 'project');
    const mergeCommit = requireFlag(flags, 'merge-commit');
    // Every flag here is required, unlike `queue run`'s optional session: this
    // verb's entire output is one `wave-merged`, so a run without a session to
    // write it into has done nothing, and a run without a plan would write it
    // under whatever id was typed — the D-46/P9-29 mislabelling, reintroduced
    // by the command that exists to repair its aftermath.
    const plan = readJsonFile<PlanFile>(requireFlag(flags, 'plan'));
    const sessionId = requireFlag(flags, 'session');
    const logged = await readAddedTasks({ sessionId }, eventOptsFromFlags(flags));
    const taskId = resolveTaskId(
      plan,
      typedTaskId,
      logged.map((t) => t.taskId),
    );
    const outcome = await adopt(
      // The branch is derived, never typed. A `--branch` override would let the
      // operator hand this the OTHER task's branch — which really is a parent of
      // the merge — and adopt any task with it, which is the forgery the whole
      // verb exists to prevent. Deriving it from the plan-resolved id means the
      // branch and the id it is logged under cannot disagree.
      { taskId, branch: taskBranchName(plan.epic_id, taskId) },
      {
        projectDir,
        epic: plan.epic_id,
        mergeCommit,
        events: { ctx: eventContextFromFlags(flags), ...eventOptsFromFlags(flags) },
      },
    );
    printJson(outcome);
    return 0;
  }

  if (namespace === 'session' && action === 'start') {
    const [sessionId] = requirePositionals(positional, usageFor('session start')) as [string];
    // Every other write verb takes `--session` and `--causal-parent` and can
    // therefore assume a log. This is the one that cannot, so it is the one
    // command in the CLI whose whole argument list is what it is about.
    printJson(
      await startSession(sessionId, {
        ...eventOptsFromFlags(flags),
        ...(flags.actor === undefined ? {} : { actor: flags.actor }),
        ...(flags.continues === undefined ? {} : { continues: flags.continues }),
      }),
    );
    return 0;
  }

  if (namespace === 'event' && action === 'append') {
    const [json] = requirePositionals(positional, usageFor('event append')) as [string];
    const input = JSON.parse(json);
    const result = await appendEvent(input, eventOptsFromFlags(flags));
    // D-163. `event_type` is open here and closed in timeline(): the schema
    // keeps the write side free so an unknown type is never rejected and lost,
    // and the read side filters to timelineEventTypes() so the operator's
    // screen stays a timeline rather than a firehose. Both are deliberate.
    // What was missing is any word to the writer that they had landed on the
    // far side of that line — this command accepted nineteen improvised types
    // from the factory's own operator skill, receipted every one as success,
    // and none of the 25 records ever reached the screen. Exit stays 0: the
    // write worked, and refusing it is precisely what the open side prevents.
    // Loaded here rather than at the top of the branch, for the reason `ui
    // serve` states below: the append is the command, and a malformed payload
    // should cost a message rather than the module loading it never needed.
    // `timelineEventTypes()` reads the taxonomy and no database, but it lives
    // beside the queries that do.
    const { timelineEventTypes } = await import('./db/queries.js');
    const onTimeline = timelineEventTypes().includes(result.record.event_type);
    if (!onTimeline) {
      process.stderr.write(
        `warning: event_type "${result.record.event_type}" is not read by the operator timeline. ` +
          `${result.event_id} is written and durable, but timeline() filters it out under every ` +
          'filter. Use a gate_event/graph_event value from factory/policies/taxonomy.yml, or add ' +
          'the type to FREE_TIMELINE_EVENT_TYPES in factory/orchestrator/src/db/queries.ts.\n',
      );
    }
    // D-245. The same shape of receipt, for the other half of the record the
    // writer can get silently wrong. `task_id` is read at the top level, beside
    // `session_id`; SKILL.md used to list the dispatch payload's fields and say
    // nothing about where the task id went, so 29 hand-written dispatches
    // across two dogfood sessions put it inside `payload` instead. Every
    // reader now takes it from either level, but only the top-level field is a
    // column, so a payload-only id answers no task-scoped query typed against
    // the DB. Exit stays 0: the write is valid and durable, and the id is not
    // lost -- it is just in the slower place.
    const payloadTaskId = (result.record.payload as Record<string, unknown> | undefined)?.task_id;
    const envelopeTaskId = result.record.task_id;
    if (
      typeof payloadTaskId === 'string' &&
      payloadTaskId.length > 0 &&
      (typeof envelopeTaskId !== 'string' || envelopeTaskId.length === 0)
    ) {
      process.stderr.write(
        `warning: "${payloadTaskId}" names a task from inside the payload, and the event's own ` +
          `task_id is empty. ${result.event_id} is written and durable, and the folds read both ` +
          'levels, but only the top-level field is indexed. Put task_id beside session_id, at the ' +
          'top level of the JSON.\n',
      );
    }
    // D-261. The third of these receipts, for the field the two above do not
    // cover: a log has one root, and this command is structurally unable to be
    // what enforces that. `causal_parent: null` on a `session-start` is exactly
    // what the writer's rule permits, so a second one into a log that already
    // has a root passes every check and comes back as a success -- and no
    // reader ever looks at it. `sessionLineage` takes the FIRST root, and the
    // tree-of-sessions reading the cross-session edge rests on assumes one
    // entry point per session. Exit stays 0 for the same reason it does above:
    // the record is valid and durable, and refusing it is not this side's job.
    // `smith session start` is the side that can refuse.
    if (
      result.record.event_type === 'session-start' &&
      result.event_id !== `${result.record.session_id}#0`
    ) {
      process.stderr.write(
        `warning: this session-start is ${result.event_id}, not ${result.record.session_id}#0 — ` +
          `session "${result.record.session_id}" was already open. The record is written and ` +
          'durable, but a log has one root and readers take the first, so nothing will read this ' +
          'one. Use `smith session start`, which refuses instead of receipting, and chain off the ' +
          'event that is already there.\n',
      );
    }
    printJson({ ...result, on_timeline: onTimeline });
    return 0;
  }

  if (namespace === 'event' && action === 'tail') {
    const [sessionId] = requirePositionals(positional, usageFor('event tail')) as [string];
    const n = boundedIntFlag(flags, 'n', { min: 1 }) ?? 20;
    const opts = eventOptsFromFlags(flags);
    // P9-28: and the id has to name a session that exists. This is the verb an
    // operator reaches for when they are not sure what the log holds, so "your
    // session is empty" was the one wrong answer it could give to a typo.
    requireSession(sessionId, opts);
    // P9-7: --lineage reads the epic rather than the session. An epic split
    // across operator sessions has its recent history in whichever session ran
    // last, and the plain tail would show only that one.
    //
    // Through readLineageEvents since D-119, which merges the logs by `ts`
    // rather than concatenating them root-first. On a tail that matters: the
    // last n events of a concatenation are the last n of the LAST session, so
    // an operator resuming an epic saw its newest events padded with nothing
    // from before the split. Now `--lineage` tails the epic in time order.
    let events = flags.lineage
      ? (await readLineageEvents(sessionId, opts)).slice(-n)
      : await tailEvents(sessionId, n, opts);
    if (flags.task) events = filterEvents(events, { taskId: flags.task });
    printJson(events);
    return 0;
  }

  if (namespace === 'event' && action === 'lineage') {
    const [sessionId] = requirePositionals(positional, usageFor('event lineage')) as [string];
    const lineage = await sessionLineage(sessionId, eventOptsFromFlags(flags));
    printJson({ session: sessionId, lineage, depth: lineage.length, root: lineage[0] });
    return 0;
  }

  if (namespace === 'dispatch' && action === 'check') {
    // P9-23: crosscheck.yml's finder_ne_critic, asserted against the log
    // instead of trusted. Fail-closed — `unverifiable` exits 1 exactly like a
    // violation, because a check that cannot answer must not read as a pass;
    // see dispatchAudit.ts for why each status means what it means.
    // required: 1 — `<id>` and `<path>` in the usage line are flag values,
    // and requirePositionals reads every `<placeholder>` positionally.
    const [sessionId] = requirePositionals(positional, usageFor('dispatch check'), 1) as [string];
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage-wide (D-119): a finder dispatched before the session split and
    // its critic after it is precisely the pairing this check exists to catch,
    // and one session's log holds half of it.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const pairs = loadCrosscheckPolicy(flags.policy).asymmetricRoles.pairs;
    const report = checkDispatchAsymmetry(events, pairs, {
      sessionId,
      ...(flags.task ? { taskId: flags.task } : {}),
    });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'tester' && action === 'check') {
    // The other half of `dispatch check`: that one asks whether the critic ran
    // on the finder's model, this one asks whether a tester ran at all, in a
    // turn of its own, before the gate that graded its tests. Same fail-closed
    // contract — `unverifiable` exits 1 — and testerAudit.ts says why absence
    // is a violation here where it is `not-applicable` there.
    // required: 1 — `<id>` and `<path>` in the usage line are flag values.
    const [sessionId] = requirePositionals(positional, usageFor('tester check'), 1) as [string];
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage-wide (D-119), for `dispatch check`'s reason: a coder dispatched
    // before a session split and its tester after it is exactly the pairing
    // this check reads, and one session's log holds half of it.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const pairs = loadCrosscheckPolicy(flags.policy).roleIsolation.pairs;
    const report = checkTesterIsolation(events, pairs, {
      sessionId,
      ...(flags.task ? { taskId: flags.task } : {}),
    });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'escalation' && action === 'check') {
    // P9-32: budgets.yml's escalation_ladder, asserted against the log instead
    // of trusted. Same fail-closed contract as `dispatch check` — see
    // escalation.ts, including what the rung-3 check does and does not claim.
    // required: 1 — `<id>` and `<path>` in the usage line are flag values.
    const [sessionId] = requirePositionals(positional, usageFor('escalation check'), 1) as [string];
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage-wide (D-119), for `dispatch check`'s reason: a ladder is climbed
    // rung by rung over an epic, and reading one session shows a run that
    // started at rung 2 as one that skipped rung 1.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const ladder = loadBudgetPolicy(flags.policy).escalationLadder;
    const report = checkEscalationLadder(events, ladder, {
      sessionId,
      ...(flags.task ? { taskId: flags.task } : {}),
    });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'claims' && action === 'check') {
    // Two populations, one classifier (P9-3). `--roots` is the write-root
    // mode: a role that works outside a worktree — the planner
    // (factory/specs/active/<epic-id>/**) and the scribe (state/lessons/**) —
    // has no claims to read from a spec, no task branch to diff, and hands its
    // output back uncommitted. `--since <ref>` widens the window to what the
    // role committed itself; the planner holds Bash, so it can.
    const roots = repeated.roots;
    if (roots !== undefined) {
      const [rootDir] = requirePositionals(positional, usageFor('claims check --roots')) as [
        string,
      ];
      const result = writeRootCheck(rootDir, roots, flags.since ? { since: flags.since } : {});
      printJson(result);
      return result.violation ? 1 : 0;
    }

    const [worktreeDir, specFile] = requirePositionals(
      positional,
      usageFor('claims check spec'),
    ) as [string, string];
    const spec = readJsonFile<ClaimedTask>(specFile);
    const result = postRunCheck(worktreeDir, spec.claims);
    printJson(result);
    return result.violation ? 1 : 0;
  }

  if (namespace === 'claims' && action === 'impact') {
    // The blind spot a path claim has by construction (P9-3). `claims check`
    // compares two lists of globs; this compares the edges between the files
    // those globs match, which is where "task A changed parse(), task B calls
    // it" actually lives. Two forms, and the difference is what they can
    // prove — see impact.ts's header.
    if (flags.plan !== undefined) {
      const plan = readJsonFile<PlanFile>(flags.plan);
      // Same refusal as `wave check`, for the same reason: validating the
      // empty set answers "admissible" about a wave nobody described.
      if (positional.length === 0) {
        throw new SmithError(
          'cli.empty-wave',
          'Usage: smith claims impact --plan <plan.json> <task-id>... — a wave with no tasks is not a wave.',
          { plan: plan.epic_id },
        );
      }
      const claimsById = new Map(plan.tasks.map((task) => [task.task_id, task.claims]));
      const tasks: WaveTask[] = positional.map((typed) => {
        const id = resolveTaskId(plan, typed);
        const claims = claimsById.get(id);
        if (!Array.isArray(claims) || claims.some((claim) => typeof claim !== 'string')) {
          throw new SmithError(
            'claims.unreadable-claims',
            `Task "${id}" does not declare its claims as a list of globs.`,
            { task_id: id, received: claims === undefined ? 'undefined' : typeof claims },
          );
        }
        return { task_id: id, claims };
      });
      // The declarations are read off the checkout, not off the plan: a claim
      // says which files a task may write, and only the tree says what those
      // files import today.
      const graph = buildSymbolGraph(collectSources(flags.repo ?? REPO_ROOT));
      const report = waveImpact(graph, tasks);
      printJson(report);
      return report.ok ? 0 : 1;
    }

    const [worktreeDir, specFile] = requirePositionals(
      positional,
      usageFor('claims impact spec'),
    ) as [string, string];
    const spec = readJsonFile<ClaimedTask>(specFile);
    // The worktree is a full checkout, so it is both halves of the question:
    // the diff this task committed, and everyone in the repo who imports it.
    const diffs = collectExportDiffs(worktreeDir, collectCommittedChanges(worktreeDir));
    const graph = buildSymbolGraph(collectSources(worktreeDir));
    const report = exportImpact(graph, diffs, spec.claims);
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'effort' && action === 'show') {
    // How much judgment this epic buys, computed instead of remembered — the
    // same "ask, do not recall" contract `security triggers` above has. Always
    // exits 0 when it can answer: a tier is a plan for the run, not a verdict
    // on it. `--effort` answers for a tier the plan does not carry yet, which
    // is the case `/bs plan` is in when it picks one.
    const policy = loadEffortPolicy(flags.policy);
    const securityPolicy = loadCrosscheckPolicy(flags.crosscheck).planQuorum;
    const planFile = flags.plan;
    printJson(
      resolveEffort(policy, securityPolicy, {
        ...(planFile ? { plan: readJsonFile<PlanFile>(planFile) } : {}),
        ...(flags.effort !== undefined ? { override: flags.effort } : {}),
      }),
    );
    return 0;
  }

  if (namespace === 'security' && action === 'triggers') {
    // The security-reviewer's dispatch condition, computed instead of
    // remembered (P9-4). Always exits 0 when it can answer: a fired trigger is
    // a dispatch instruction, not a violation — read `dispatchSecurityReviewer`.
    const spec = readJsonFile<SecurityTriggerTask>(requireFlag(flags, 'task'));
    const result = securityTriggers(spec, loadSensitivePathsPolicy(flags.policy), {
      case: flags.case,
      epicTags: repeated['epic-tag'],
      scheduledRecheck: flags.recheck === 'true',
    });
    printJson(result);
    return 0;
  }

  // The judge sandbox (A3). `worktree fingerprint`/`verify` above detect a
  // judge that wrote; these three refuse it up front. The orchestrator opens a
  // lease before handing a worktree to a judge and closes it when the verdict
  // is in; while one is open, `policy hook` adds guardrails.yml's three
  // `judge-*` rules to the six that always apply. The judge itself is refused
  // all three of these verbs by `judge-sandbox-escape` — they are the
  // orchestrator's, which is the only reason the lease means anything.
  if (namespace === 'sandbox' && action === 'open') {
    const [worktreeDir] = requirePositionals(positional, usageFor('sandbox open')) as [string];
    const lease = openSandbox(
      {
        worktreeDir,
        role: requireFlag(flags, 'role'),
        taskId: requireFlag(flags, 'task'),
        sessionId: requireFlag(flags, 'session'),
        // The clock is read here rather than inside sandbox.ts so the module
        // stays pinnable by a test — the same reason `openedAt` is an input.
        openedAt: flags.at ?? new Date().toISOString(),
      },
      flags['lease-dir'] ?? SANDBOX_LEASE_DIR,
    );
    printJson(lease);
    return 0;
  }

  if (namespace === 'sandbox' && action === 'close') {
    // Exit 0 whether or not a lease was there. Closing is the orchestrator's
    // cleanup path, and it runs after a judge that crashed just as much as
    // after one that finished; making "already closed" an error would turn
    // tidying up into a second failure to handle.
    const [worktreeDir] = requirePositionals(positional, usageFor('sandbox close')) as [string];
    const closed = closeSandbox(worktreeDir, flags['lease-dir'] ?? SANDBOX_LEASE_DIR);
    printJson({ closed, worktreeDir });
    return 0;
  }

  if (namespace === 'sandbox' && action === 'status') {
    // With --worktree: the lease that would bind a command run there, which is
    // the question the hook asks. Without: every open lease, which is the
    // question an operator asks when a judge is stuck or a wave died holding
    // one.
    const leaseDir = flags['lease-dir'] ?? SANDBOX_LEASE_DIR;
    if (flags.worktree) {
      const lease = activeSandboxFor(flags.worktree, leaseDir);
      printJson({ worktree: flags.worktree, sandbox: lease });
      return 0;
    }
    printJson({ sandboxes: listSandboxes(leaseDir) });
    return 0;
  }

  if (namespace === 'stack' && (action === 'show' || action === 'check')) {
    // The install interview's answers, read back (`show`) and priced against
    // what factory/scaffold/ can actually build (`check`).
    //
    // `check` exits 1 only on a `refused` answer — one `smith new` will stop
    // on. A `recorded` mismatch is deliberately green: an operator whose stack
    // is wider than the template tree has not misconfigured anything, and a
    // check that went red for them would be a check they learned to ignore.
    const answers = loadStackAnswers(flags.policy);
    if (action === 'show') {
      printJson(answers);
      return 0;
    }
    const report = checkStack(answers);
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'policy' && action === 'check') {
    // Dry run of the guard hook (`policy hook`, below) against one command
    // line instead of a live PreToolUse payload — "would this be blocked?"
    // before an agent or operator actually runs it. Branch/repoRoot default
    // to what the checkout actually is, same as the hook itself resolves
    // them, so a caller only needs --branch/--tool to ask a hypothetical
    // ("what if I were on main") rather than the real one.
    // --command stays required even for a file tool, because the answer to
    // "what would the hook say" depends on both halves of the payload and a
    // caller who omits one is usually asking the wrong question. `--command
    // ''` is the file-tool form: nothing to run, a path to check.
    const command = requireFlag(flags, 'command');
    const toolName = flags.tool ?? 'Bash';
    // The other half of a PreToolUse payload: `tool_input.file_path`, which
    // is what a `Write`/`Edit` call carries instead of a command. Only the
    // role write scopes read it today — see policy.ts's PolicyContext.
    const filePath = flags.file ?? null;
    // Resolved from the caller's cwd, not from the checkout this binary was
    // built in: an operator asking "would this be denied?" means from where
    // they are standing, and in this repo that is routinely a worktree on a
    // different branch than the main clone. Same reason as `policy hook`
    // below, which has the stricter version of the problem.
    const repoRoot = detectRepoRoot(process.cwd());
    const branch = flags.branch ?? detectCurrentBranch(process.cwd());
    // Same shape as --branch: without it, the real lease over the caller's cwd,
    // so `policy check` answers what the hook would actually answer from here.
    // With it, a hypothetical — "what would a reviewer session be refused?" —
    // which is how an operator reads the judge rules without having to stage a
    // judge to read them.
    const sandbox: SandboxLease | null = flags.sandbox
      ? {
          worktreeDir: repoRoot ?? process.cwd(),
          role: flags.sandbox,
          taskId: '(hypothetical)',
          sessionId: '(hypothetical)',
          openedAt: new Date().toISOString(),
        }
      : activeSandboxFor(process.cwd(), flags['lease-dir'] ?? SANDBOX_LEASE_DIR);
    const decision = evaluateCommand(
      { toolName, command, branch, repoRoot, sandbox, filePath },
      loadGuardrailPolicy(),
    );
    printJson(decision);
    return decision.allowed ? 0 : 1;
  }

  if (namespace === 'policy' && action === 'hook') {
    // The PreToolUse hook body, kept as a command because guard.sh's header,
    // the docs and cli.test.ts all name it — but the shim no longer execs it.
    // It execs `dist/policyHook.js`, an entry point over the same function
    // whose import graph is the decision's alone; this router carries 64
    // top-level imports, ~1.3s of them the database layer, in front of ~39ms
    // of policy work, and the hook pays that on every guarded tool call. Both
    // paths call decideHookPayload, so a second copy cannot drift out of
    // agreement with the one actually guarding the repo.
    //
    // The contract, which policyHook.ts mirrors exactly: exit 0 with the deny
    // envelope on stdout, exit 0 in silence for an allow, and let a malformed
    // payload throw out through main()'s catch for a non-zero exit. See
    // hookDecision.ts for why each of those three is what it is.
    const output = decideHookPayload(readFileSync(0, 'utf8'), process.cwd());
    if (output) printJson(output);
    return 0;
  }

  if (namespace === 'gate' && action === 'run') {
    const { runGate } = await import('./gate.js');
    const [taskId] = requirePositionals(positional, usageFor('gate run')) as [string];
    const worktreeDir = requireFlag(flags, 'worktree');
    const checks = readJsonFile<CheckCommand[]>(requireFlag(flags, 'checks'));
    // The result file has the same two intake shapes as findings below, and for
    // the same reason. With `--agent`, `--result` is the worker's half —
    // run_status/structured_output/artifacts — and the dispatcher stamps the
    // five fields it owns, token_usage included: an agent cannot read its own
    // meter, so a token count it writes is invented (D-18/P9-17). Without
    // `--agent` the file is taken as a complete document, which is what a
    // replay or a fixture hands over.
    const resultFile = readJsonFile<unknown>(requireFlag(flags, 'result'));
    const result = flags.agent
      ? stampResultEnvelope(resultFile, {
          taskId,
          agent: flags.agent,
          provider: requireFlag(flags, 'provider'),
          modelTier: requireFlag(flags, 'model-tier'),
          inputTokens: requireIntFlag(flags, 'input-tokens'),
          outputTokens: requireIntFlag(flags, 'output-tokens'),
        })
      : resultFile;
    // Two intake shapes. `--evidence` is what judges actually produce
    // (interview N-2): evidence only, with the orchestrator minting
    // finding_id/task_id/found_by/finding_status here. It repeats, once per
    // judge at this gate (D-32/P9-13). `--findings` stays for already-minted
    // records (replays, fixtures, cross-check re-runs).
    const findingsInput = [
      ...(flags.findings ? readJsonFile<RaiseFindingInput[]>(flags.findings) : []),
      ...mintFromEvidence(args, taskId),
    ];
    const lessons = flags.lessons ? parseLessons(readFileSync(flags.lessons, 'utf8')) : [];
    const ctx = eventContextFromFlags(flags);

    // --plan is what lets the gate answer "whose finding is this" from the
    // file rather than from who happened to be at the gate (D-41/P9-24).
    // Optional: a gate run without a plan keeps every finding on --task, which
    // is the pre-P9-24 behaviour, not a silent misattribution.
    const ownership = ownershipFromFlags(flags);
    // P9-18: the same file also carries what the task said it would cost, so
    // the gate can compare the declaration against the measurement. `--base`
    // is for callers that know the exact base they branched from (the merge
    // queue does); without it the diff is measured against the integration
    // branch the task-branch name implies.
    const budget = budgetFromFlags(flags, taskId);

    // P9-11: handing the gate a judge's evidence IS that judge reporting.
    // Doing it here means the common path — dispatch, judge writes its file,
    // `gate run --evidence` — closes the turn in one command instead of two,
    // and forgetting the second one can no longer block a task whose judge
    // did everything right. A `--found-by` role with no dispatch behind it
    // has no turn to close and takes the pre-P9-11 path untouched.
    //
    // D-158: the turns to close are the paired sources, not `flags.evidence`
    // and `flags['found-by']`. Those are last-occurrence-wins, so a gate run
    // carrying two judges' files — the shape D-32/P9-13 taught the minting
    // path — closed the second judge's turn and left the first outstanding,
    // blocking the gate on a judge that had just handed in its evidence. One
    // close per role: a judge that splits its findings across two files still
    // owes one turn, and a second report against it would be a duplicate.
    const evidenceGiven = evidenceSources(args);
    if (evidenceGiven.length > 0) {
      const turns = await readJudgeTurns(taskId, ctx, eventOptsFromFlags(flags));
      const closed = new Set<string>();
      for (const { foundBy, file } of evidenceGiven) {
        if (closed.has(foundBy)) continue;
        if (!turns.some((t) => t.role === foundBy && !t.reported)) continue;
        closed.add(foundBy);
        await recordJudgeReport(
          { taskId, role: foundBy, artifactPath: file },
          ctx,
          eventOptsFromFlags(flags),
        );
      }
    }

    // P9-11: the genuinely clean case, said out loud. A judge that found
    // nothing writes `[]` and reports through `smith judge report`; this flag
    // is for the operator who ran one outside the factory, and it records an
    // attestation as an attestation — artifact_path null, attested_by
    // operator — rather than dressing it up as a file that was never written.
    for (const role of repeated['no-findings'] ?? []) {
      // `parseArgs` renders a valueless flag as the string 'true'. Attesting a
      // role called "true" would close nothing (no such dispatch exists) and
      // say so nowhere, so a bare --no-findings is a usage error instead.
      if (role === 'true') {
        throw new SmithError(
          'cli.no-findings-needs-role',
          '--no-findings names the judge role it attests for, e.g. --no-findings security-reviewer.',
          { usage: 'smith gate run <task-id> --no-findings <role>' },
        );
      }
      await recordJudgeReport({ taskId, role, noFindings: true }, ctx, eventOptsFromFlags(flags));
    }

    // --grader is the grader's own result file (state/results/<task-id>
    // .grader-r<round>.json). Optional for the same reason as --plan: an ad-hoc
    // gate run has no rubric result to hand over, and inventing one would be
    // worse than skipping the stage (D-34/P9-14).
    const graderVerdict = flags.grader ? readJsonFile<unknown>(flags.grader) : undefined;

    const outcome = await runGate(
      {
        taskId,
        result,
        worktreeDir,
        checks,
        findingsInput,
        lessons,
        runAll: flags['run-all'] === 'true',
        ...(ownership ? { ownership } : {}),
        // --base is the ref the queue would merge into, normally
        // smith/<epic>/integration. One flag, two readers: the commit
        // certificate asks whether the branch carries commits the base does
        // not (D-30/P9-8), the budget check measures the diff against it
        // (P9-18). Optional like --plan — without it the gate still refuses an
        // uncommitted worktree and still measures the diff, it just falls back
        // to the base the task-branch name implies.
        ...(flags.base ? { baseRef: flags.base } : {}),
        ...(graderVerdict !== undefined ? { graderVerdict } : {}),
        ...(budget ? { budget } : {}),
        ...(flags['artifacts-dir'] ? { artifactsDir: flags['artifacts-dir'] } : {}),
      },
      ctx,
      eventOptsFromFlags(flags),
    );
    printJson(outcome);
    return outcome.outcome === 'blocked' ? 1 : 0;
  }

  // D-40/P9-25: the gate's coverage evidence, without staging a gate run.
  // This is the verb the D-40 investigation wanted and did not have — it took
  // a coverage re-run on the pre-task-4 integration branch to establish what
  // one lookup in coverage-summary.json says outright.
  if (namespace === 'coverage' && action === 'check') {
    const [worktreeDir] = requirePositionals(positional, usageFor('coverage check')) as [string];
    // Whose claims to judge is a question with no safe default: judging the
    // whole plan's claims at one task's gate is D-41 again, and judging none
    // silently would report `complete: true` on no evidence at all. So --plan
    // demands --task, and neither means "the total, and no subjects".
    const claims = flags.plan ? claimsForDispatch(flags) : [];
    const evidence = await collectCoverageEvidence({
      worktreeDir,
      claims,
      ...(flags.summary ? { summaryPath: flags.summary } : {}),
    });
    printJson({
      summary_path: evidence.summaryPath,
      present: evidence.present,
      complete: evidence.complete,
      files_measured: evidence.filesMeasured,
      total: evidence.total,
      subjects: evidence.subjects.map((s) => ({
        path: s.path,
        status: s.status,
        lines_pct: s.coverage?.lines.pct ?? null,
        statements_pct: s.coverage?.statements.pct ?? null,
        functions_pct: s.coverage?.functions.pct ?? null,
        branches_pct: s.coverage?.branches.pct ?? null,
      })),
      detail: evidence.detail,
    });
    return evidence.complete ? 0 : 1;
  }

  // P9-33: the consumer `epic.alarm_ratio` never had. Read-only over the log —
  // it reports where spend stands, it does not stop anything. Exit 1 on a
  // crossing OR on a record too holey to prove there wasn't one.
  if (namespace === 'budget' && action === 'alarm') {
    // required: 1 — `<id>` and `<path>` in the usage line are flag values, and
    // requirePositionals reads every `<placeholder>` positionally.
    const [sessionId] = requirePositionals(positional, usageFor('budget alarm'), 1) as [string];
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage-wide (D-119). Spend is an epic's, not a session's: reading one
    // session reports half an epic's cost as the whole of it, and reports it
    // under an alarm threshold it may already have crossed.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const report = checkBudgetAlarm(events, loadBudgetPolicy(flags.policy), {
      sessionId,
      ...(flags.epic ? { epicId: flags.epic } : {}),
    });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  // The consumer architecture §9.7's "monotonically decreasing same-mistake
  // rate" never had. Read-only over the log, like `budget alarm` — and like it,
  // exit 1 both on a rate that rose and on a record that cannot show it didn't.
  // `--lessons` defaults to the committed corpus because the corpus IS half the
  // measurement: a rate of zero against lessons that can escalate nothing is a
  // fact about the corpus, not about the work.
  if (namespace === 'kpi' && action === 'same-mistake') {
    const [sessionId] = requirePositionals(positional, usageFor('kpi same-mistake'), 1) as [string];
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage-wide (D-119): a same-mistake RATE measured over half the work is
    // a different number, and the half it drops is the earlier one — the half
    // that holds the first occurrence every repeat is counted against.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const lessons = parseLessons(readFileSync(flags.lessons ?? LESSONS_MD_PATH, 'utf8'));
    const report = checkSameMistakeKpi(events, lessons, { sessionId });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  // D-42/P9-26: the one command that runs against the ASSEMBLED branch rather
  // than a task worktree. Every other gate in this CLI runs inside a worktree,
  // so without this every quality claim the factory makes is a claim about a
  // worktree — and the epic gate below now refuses to ship until this has run.
  if (namespace === 'integration' && action === 'check') {
    const epicId = requireFlag(flags, 'epic');
    const projectDir = requireFlag(flags, 'project');
    const checks = readJsonFile<CheckCommand[]>(requireFlag(flags, 'checks'));
    const ctx = eventContextFromFlags(flags);
    const record = await runIntegrationCheck(
      {
        epicId,
        projectDir,
        checks,
        // Unlike the per-task gate, the default here is the whole picture:
        // --run-all false opts back into short-circuiting.
        runAll: flags['run-all'] !== 'false',
      },
      ctx,
      eventOptsFromFlags(flags),
    );
    printJson(record);
    return record.pass ? 0 : 1;
  }

  if (namespace === 'epic' && action === 'verdict') {
    const { runEpicVerdict } = await import('./epic.js');
    const epicId = requireFlag(flags, 'epic');
    // --project is required (D-42/P9-26): the verdict cannot be rendered
    // without knowing where the integration branch actually is, and an
    // optional flag would silently mean "no check needed".
    const projectDir = requireFlag(flags, 'project');
    const ctx = eventContextFromFlags(flags);
    const outcome = await runEpicVerdict(
      {
        epicId,
        integrationHeadSha: integrationHeadSha(projectDir, epicId),
        mcp: mcpSurfaceFor(epicId, projectDir, flags),
        goal: epicGoalFor(epicId, flags),
        // D-126: the live plan is a voter. Without this the roster is the
        // event-log fold alone, and a task an amendment added but nobody
        // dispatched is invisible rather than unfinished.
        planOpts: planOptsFromFlags(flags),
      },
      ctx,
      eventOptsFromFlags(flags),
    );
    printJson(outcome);
    return outcome.outcome === 'hold' ? 1 : 0;
  }

  // D-43/P9-27: `epic verdict` above stays the free read-only probe; this is
  // the verb that writes the close down. A hold closes only with
  // --override-rationale, and then the log carries the machine's verdict, the
  // blockers overridden, and the human's reason.
  if (namespace === 'epic' && action === 'close') {
    const { closeEpic } = await import('./epic.js');
    const epicId = requireFlag(flags, 'epic');
    const projectDir = requireFlag(flags, 'project');
    const ctx = eventContextFromFlags(flags);
    const record = await closeEpic(
      {
        epicId,
        integrationHeadSha: integrationHeadSha(projectDir, epicId),
        mcp: mcpSurfaceFor(epicId, projectDir, flags),
        goal: epicGoalFor(epicId, flags),
        planOpts: planOptsFromFlags(flags),
        ...(flags['override-rationale'] !== undefined
          ? { overrideRationale: flags['override-rationale'] }
          : {}),
      },
      ctx,
      eventOptsFromFlags(flags),
    );
    printJson(record);
    return 0;
  }

  // P9-9/D-33: the closing spec review. The pre-code review reads a plan
  // against nothing; this one reads it against the code that now exists, which
  // is the only reading that can see the defects the code reveals. It is
  // pinned to the integration head so `epic verdict` can tell a review of this
  // branch from a review of an older one.
  if (namespace === 'epic' && action === 'spec-review') {
    const epicId = requireFlag(flags, 'epic');
    const projectDir = requireFlag(flags, 'project');
    const plan = readJsonFile<PlanFile>(requireFlag(flags, 'plan'));
    // Evidence, not identity (interview N-2): the reviewer reports what it
    // read; the plan version and the head it was read at come from here.
    const evidence = flags.evidence ? readJsonFile<FindingEvidence[]>(flags.evidence) : [];
    // No branch, no review. The whole point of this dispatch is that it reads
    // the code that now exists; recording one against a head that could not be
    // read would produce a review nothing can be shown to cover.
    const headSha = integrationHeadSha(projectDir, epicId);
    if (headSha === null) {
      throw new SmithError(
        'cli.no-integration-branch',
        `Could not read the head of smith/${epicId}/integration in ${projectDir}. The closing spec review reads the assembled branch, so there is nothing to review yet.`,
        { epicId, projectDir },
      );
    }
    const record = await recordSpecReview(
      {
        epicId,
        planVersion: plan.version,
        headSha,
        reviewedBy: requireFlag(flags, 'reviewed-by'),
        ...(flags['reviewed-by-provider']
          ? { reviewedByProvider: flags['reviewed-by-provider'] }
          : {}),
        evidence,
      },
      eventContextFromFlags(flags),
      eventOptsFromFlags(flags),
    );
    printJson(record);
    // Exit 0 even when it found something: the review ran, and a spec finding
    // blocks the plan, not this command. `plan amend` is what answers it.
    return 0;
  }

  // The spec-vs-goal check. Every gate before it reads text the planner wrote;
  // this one reads the roadmap goal the operator wrote before planning began,
  // so a plan that decomposes the wrong problem stops being invisible.
  if (namespace === 'epic' && action === 'goal-check') {
    const epicId = requireFlag(flags, 'epic');
    const plan = readJsonFile<PlanFile>(requireFlag(flags, 'plan'));
    const goal = epicGoalFor(epicId, flags);
    // Refuse rather than record a check against nothing. The blocker for an
    // undeclared goal is already in the epic gate; producing an event here
    // would be a record of a check that had no reference text.
    if (goal.goal === null || goal.milestoneId === null) {
      throw new SmithError(
        'cli.no-epic-goal',
        `No roadmap milestone states a goal for "${epicId}", so there is nothing to check its plan against. Give the milestone that owns it a \`- goal:\` line in factory/specs/roadmap.md, or add the epic to an existing milestone's \`- epics:\` list.`,
        { epicId, milestoneId: goal.milestoneId },
      );
    }
    const coverage = readJsonFile<ClauseCoverage[]>(requireFlag(flags, 'coverage'));
    const record = await recordGoalCheck(
      {
        epicId,
        milestoneId: goal.milestoneId,
        goal: goal.goal,
        planVersion: plan.version,
        livePlanTaskIds: livePlanTasks(plan).map((spec) => spec.task_id),
        checkedBy: requireFlag(flags, 'checked-by'),
        ...(flags['checked-by-provider']
          ? { checkedByProvider: flags['checked-by-provider'] }
          : {}),
        coverage,
      },
      eventContextFromFlags(flags),
      eventOptsFromFlags(flags),
    );
    printJson(record);
    // Exit 0 for the reason `epic spec-review` does: the check ran, and an
    // uncovered clause blocks the plan rather than this command. `plan amend`
    // is what answers it.
    return 0;
  }

  // The clause list a coverage map has to answer, printed so a judge dispatch
  // (or an operator writing one by hand) does not have to guess how
  // goalClauses() splits the goal. Read-only: no event, no finding.
  if (namespace === 'epic' && action === 'goal') {
    const epicId = requireFlag(flags, 'epic');
    printJson(epicGoalFor(epicId, flags));
    return 0;
  }

  if (namespace === 'epic' && action === 'width') {
    // Dynamic for P9-2 (test/cliBoot.test.ts): epicWidth.js reaches
    // waveConcurrency.js and through it agents-registry.js, and nothing only
    // this command needs belongs on the path every `smith --help` walks.
    const { summariseEpicWidth } = await import('./epicWidth.js');
    const eventOpts = eventOptsFromFlags(flags);
    const sessionId = typeof flags.session === 'string' ? flags.session : null;

    // The default is every session, which no other read command here does, and
    // it is the whole point: `wave audit` answers "did the waves in the log I
    // am standing in run wide", and this answers "does this factory build in
    // parallel". A close is written wherever the epic finished, so a
    // lineage-scoped default would answer the factory question with whatever
    // subset of its own history the operator happened to be inside — and
    // report a workshop of one narrow epic and forty parallel ones as narrow.
    // --session narrows back to one lineage for anyone who wants that instead.
    let events: StoredEvent[];
    if (sessionId === null) {
      const ids = listSessionIds(eventOpts.stateDir);
      events = mergeSessionLogs(
        await Promise.all(
          ids.map(async (id) => ({ sessionId: id, events: await readEvents(id, eventOpts) })),
        ),
      );
    } else {
      requireSession(sessionId, eventOpts);
      events = await readLineageEvents(sessionId, eventOpts);
    }

    const summary = summariseEpicWidth(events);
    printJson(summary);
    return summary.exitCode;
  }

  // D-41/P9-24: a finding can exist without a gate run. The wave-4 security
  // reviewer's S2 was about a file nobody at that gate could touch, and the
  // only verb that could record it was `gate run` — so recording it at all
  // meant blocking a diff that could not contain the fix. This raises the
  // finding on its own, routed to whoever claims the file.
  if (namespace === 'findings' && action === 'raise') {
    const { recordReattribution, routeFindings } = await import('./attribution.js');
    const plan = flags.plan ? readJsonFile<PlanFile>(flags.plan) : undefined;
    // Ownership has to come from somewhere. --task names it outright; --plan
    // makes the epic the fallback owner, which resolveFindingOwner can only
    // improve on. With neither, there is no honest task_id to stamp.
    // The epic is a fallback, never a real owner: decideFindingAttribution
    // returns `gated` only when the owner equals this id, and an epic id never
    // equals a task id — so a plan-only raise always resolves or escalates.
    const defaultTaskId = flags.task ?? plan?.epic_id;
    if (defaultTaskId === undefined) {
      throw new SmithError(
        'cli.missing-flag',
        'findings raise needs --task, --plan, or both to attribute the finding.',
        { flag: 'task' },
      );
    }
    const ownership = plan ? ownershipFromPlan(plan) : undefined;
    const ctx = eventContextFromFlags(flags);
    const opts = eventOptsFromFlags(flags);

    // P9-9/D-33. Scope is a property of the dispatch, not of each item: one
    // review reads one thing. --plan is required for a spec raise because the
    // version reviewed is read from the plan file rather than typed — a spec
    // finding against the wrong version points at a criterion that never moved.
    if (flags.scope !== undefined && flags.scope !== 'spec' && flags.scope !== 'diff') {
      throw new SmithError(
        'cli.invalid-flag',
        `--scope must be "diff" or "spec", got "${flags.scope}".`,
        { flag: 'scope', value: flags.scope },
      );
    }
    const specDispatch = flags.scope === 'spec';
    if (specDispatch && plan === undefined) {
      throw new SmithError(
        'cli.missing-flag',
        'findings raise --scope spec needs --plan: a spec finding names the plan version whose criterion it read.',
        { flag: 'plan' },
      );
    }
    // Scope is decided by the dispatch, and a pre-built draft was minted by
    // some other dispatch. Accepting one here would put a diff finding into a
    // spec batch and report it as spec-scoped when it is not.
    if (specDispatch && flags.findings) {
      throw new SmithError(
        'cli.invalid-flag',
        'findings raise --scope spec takes --evidence, not --findings: scope belongs to the dispatch, and a pre-built draft was minted under a different one.',
        { flag: 'findings' },
      );
    }

    // A spec finding is owned by the epic, not by whoever claims the file it
    // cites — same id recordSpecReview stamps, so the two routes into the log
    // are indistinguishable to everything downstream.
    const mintTaskId = specDispatch && plan ? `${plan.epic_id}/${RESERVED_TASK_ID}` : defaultTaskId;

    const findingsInput = [
      ...(flags.findings ? readJsonFile<RaiseFindingInput[]>(flags.findings) : []),
      // The mint id, not the default one: a spec finding belongs to the epic
      // (D-33), and the dispatch's scope rides along with it so every finding
      // in the batch is spec-scoped by construction.
      ...mintFromEvidence(
        args,
        mintTaskId,
        specDispatch && plan ? { spec: { planVersion: plan.version } } : {},
      ),
    ];

    // A spec dispatch never enters the routing. routeFindings would rewrite
    // task_id to whoever claims the file the finding happens to cite — and a
    // plan defect attributed to a task is exactly the deadlock D-33 exists to
    // end. gate.ts diverts for the same reason; this diverts one step earlier,
    // before attribution rather than after it.
    const routings = specDispatch
      ? findingsInput.map((input) => ({
          input,
          attribution: 'gated' as const,
          taskId: mintTaskId,
          epicId: plan?.epic_id ?? mintTaskId,
          fromTaskId: mintTaskId,
          reason: '',
          claims: [],
        }))
      : await routeFindings(
          findingsInput,
          {
            defaultTaskId,
            // The plan states the epic outright, so nothing has to read it back
            // out of `defaultTaskId` — which on a plan-only raise IS the epic id
            // and names no epic of its own (D-49/P9-10).
            ...(plan?.epic_id ? { epicId: plan.epic_id } : {}),
            ...(ownership ? { ownership } : {}),
          },
          ctx,
          opts,
        );
    const raised = [];
    for (const routing of routings) {
      const result = await raiseFinding(routing.input, ctx, opts);
      // A waived fingerprint is already settled, so it mints no follow-up
      // task — same rule the gate applies, for the same reason. A spec finding
      // is skipped for the other half of that rule (gate.ts's divert): no task
      // can hold the fix, because the fix is a plan amendment.
      const isSpec = !result.suppressed && findingScope(result.finding) === SPEC_FINDING_SCOPE;
      if (!result.suppressed && !isSpec) {
        await recordReattribution(routing, result.finding, ctx, opts);
      }
      raised.push({
        findingId: result.suppressed ? null : result.finding.finding_id,
        filePath: routing.input.filePath,
        taskId: routing.taskId,
        attribution: isSpec ? SPEC_FINDING_SCOPE : routing.attribution,
        suppressed: result.suppressed,
        reason: routing.reason,
      });
    }
    printJson(raised);
    return 0;
  }

  // `--state-dir` is threaded through every findings/waivers verb below.
  // It used to be parsed and dropped here, so `findings list --state-dir X`
  // answered about the real state/events/ log instead — an answer about a
  // different session, which is worse than an error (P9-15).
  if (namespace === 'findings' && action === 'list') {
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    // An empty list is an answer about the findings; it must not also be the
    // answer about the session (P9-28).
    requireSession(sessionId, eventOpts);
    const findings = await listFindings(
      sessionId,
      {
        taskId: flags.task,
        epic: flags.epic,
        status: flags.status,
        severity: flags.severity,
        category: flags.category,
      },
      eventOpts,
    );
    printJson(findings);
    return 0;
  }

  if (namespace === 'findings' && action === 'transition') {
    // Positionals first, then flags: argument order is the reading order, and
    // a usage error should name the first thing wrong on the line.
    const [findingId, newStatus] = requirePositionals(
      positional,
      usageFor('findings transition'),
    ) as [string, string];
    // D-136. Both amendment edges are gated on evidence this command line has
    // no way to carry: `amendsTaskIds` comes off a plan diff and
    // `amendsSatisfiedBy` off the task fold, and neither has a flag — by
    // design, since a hand-typed obligation is exactly the unchecked claim
    // D-127 closed. So every invocation naming them already fails; what it
    // failed with was a message about task ids the operator was never offered,
    // five guards into a log fold, which reads as a bug in their command line.
    // Refusing here, on the status alone, keeps argument order as the reading
    // order and lets the error name the verb that CAN take the edge.
    const AMENDMENT_ROUTES: Readonly<Record<string, string>> = {
      [AMEND_PENDING_STATUS]:
        '`smith plan amend` puts every finding it cites into "amend-pending", with the task ids the new plan version added or superseded as the obligation',
      [AMENDED_STATUS]:
        '`smith epic close` computes which of those tasks actually landed and discharges the finding with that evidence',
    };
    if (newStatus in AMENDMENT_ROUTES) {
      throw new SmithError(
        'cli.amendment-edge-unreachable',
        `"${newStatus}" is not reachable through "smith findings transition": the amendment path is entered and closed by the commands that can compute its evidence, never by hand. ${AMENDMENT_ROUTES[newStatus]}.`,
        { status: newStatus, findingId },
      );
    }
    const ctx = eventContextFromFlags(flags);
    const finding = await transitionFinding(findingId, newStatus, ctx, eventOptsFromFlags(flags));
    printJson(finding);
    return 0;
  }

  // The dispatch-time half of P9-15, shaped exactly like `lessons
  // for-dispatch`: the caller composing a task prompt asks for the block and
  // splices it. `--plan` is required rather than optional here — without it
  // the claims list is empty, every finding fails the join, and the command
  // would answer "nothing is open in your files" when it never looked.
  if (namespace === 'findings' && action === 'for-dispatch') {
    const usage =
      'smith findings for-dispatch --session ... --plan plan.json --task task-id [--state-dir dir]';
    requireFlag(flags, 'plan');
    const taskId = requireFlag(flags, 'task');
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(sessionId, eventOpts);
    if (positional.length > 0) {
      throw new SmithError('cli.usage', `Unexpected argument. Usage: ${usage}`, { positional });
    }
    printJson(
      await findingsForDispatch({ sessionId, taskId, claims: claimsForDispatch(flags) }, eventOpts),
    );
    return 0;
  }

  // Re-dating a finding's evidence (P9-15). Deliberately its own verb and not
  // a `transition`: re-verification does not change finding_status, and the
  // two statuses it could be confused with mean something else entirely
  // (`confirmed` cannot be re-entered, `refuted` says the finding was wrong).
  if (namespace === 'findings' && action === 'reverify') {
    const [findingId] = requirePositionals(positional, usageFor('findings reverify')) as [string];
    const ctx = eventContextFromFlags(flags);
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(ctx.sessionId, eventOpts);
    await reverifyFinding(findingId, flags.note ?? '', ctx, eventOpts);
    printJson({ findingId, note: flags.note ?? '' });
    return 0;
  }

  // D-21 Part 4. Corrects a malformed amends_task_ids entry on a finding
  // parked at amend-pending -- the shape a malformed "plan amend" --changes
  // file can write (parts 1-3 of D-21 now refuse that at the source, but the
  // log is append-only). Never a hand-typed obligation: repairObligation's own
  // guards refuse anything this verb is not meant to do.
  if (namespace === 'findings' && action === 'repair-obligation') {
    const [findingId] = requirePositionals(positional, usageFor('findings repair-obligation')) as [
      string,
    ];
    // Comma-split, not repeated: a task id has no commas, and a repaired
    // obligation routinely names more than one (D-136's --findings precedent).
    //
    // Unlike --findings/--sites, a stray empty SEGMENT is not filtered out
    // here (D-21 Part 4 review, S4 behavioral-drift): "a,,b" used to filter
    // down to ['a', 'b'], so repairObligation's guard 6 -- every replacement
    // id must be a non-empty string -- was implemented and unit-tested but
    // unreachable through this command line; an operator's typo'd double
    // comma was silently corrected instead of refused. Only the flag's own
    // value being entirely blank (nothing typed at all, the one shape a
    // string flag can use to mean "zero entries") maps to an empty list, so
    // guard 3 (cannot empty) stays reachable too.
    const replaceWithRaw = requireFlag(flags, 'replace-with');
    const replaceWith =
      replaceWithRaw.trim() === '' ? [] : replaceWithRaw.split(',').map((id) => id.trim());
    const ctx = eventContextFromFlags(flags);
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(ctx.sessionId, eventOpts);
    const finding = await repairObligation(
      { findingId, replaceWith, reason: requireFlag(flags, 'reason') },
      ctx,
      eventOpts,
    );
    printJson(finding);
    return 0;
  }

  if (namespace === 'waivers' && action === 'pending') {
    const [epic] = requirePositionals(positional, usageFor('waivers pending')) as [string];
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(sessionId, eventOpts);
    const pending = await pendingBatch(epic, { sessionId }, eventOpts);
    printJson(pending);
    return 0;
  }

  if (namespace === 'waivers' && action === 'apply') {
    const [decisionsFile] = requirePositionals(positional, usageFor('waivers apply')) as [string];
    const decisions = readJsonFile<WaiverBatchDecision[]>(decisionsFile);
    const ctx = eventContextFromFlags(flags);
    const results = await applyBatch(decisions, ctx, eventOptsFromFlags(flags));
    printJson(results);
    return 0;
  }

  if (namespace === 'lessons' && action === 'candidates') {
    const { openDb } = await import('./db/projector.js');
    const { lessonsPage } = await import('./db/queries.js');
    const dbPath = flags.db ?? STATE_DB_PATH;
    const handle = openDb(dbPath);
    try {
      const scope = flags.session ? { sessionId: flags.session } : {};
      printJson(lessonsPage(handle.db, scope).pending);
      return 0;
    } finally {
      handle.sqlite.close();
    }
  }

  // The hand-authored entrance to the pipeline (P9-34). `smith dream` only
  // ever sees four checkpoint shapes in a log, so a rule derived by reading a
  // whole run had no way in except `smith event append`, which applies no
  // novelty check at all. Exit 1 on a novelty rejection: the candidate is
  // logged either way, but the operator must look before assuming it landed.
  if (namespace === 'lessons' && action === 'raise') {
    const { raiseLessonCandidate } = await import('./lessons.js');
    const eventOpts = eventOptsFromFlags(flags);
    const ctx = eventContextFromFlags(flags);
    requireSession(ctx.sessionId, eventOpts);
    const result = await raiseLessonCandidate(
      {
        statement: requireFlag(flags, 'statement'),
        lessonType: requireFlag(flags, 'lesson-type'),
        lessonScope: requireFlag(flags, 'lesson-scope'),
        provenanceEventIds: requireFlag(flags, 'provenance')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
        provenanceSessionId: flags['provenance-session'],
        evidence: flags.evidence,
        findingCategory: flags['finding-category'],
        claimPath: flags['claim-path'],
        agentRole: flags['agent-role'],
        caseType: flags['case-type'],
        lessonId: flags['lesson-id'],
      },
      ctx,
      eventOpts,
      await noveltyOptsFromFlags(flags),
    );
    printJson(result);
    return result.novel ? 0 : 1;
  }

  // `approve` and `reject` are the same verb with the destination fixed
  // (P9-1): reject maps to `invalidated`, the status ui/server's reject route
  // already writes. Both refuse a transition LEGAL_LESSON_TRANSITIONS does
  // not allow rather than letting a hand-typed envelope poison the memory.
  //
  // P9-34/P9-35: an approval also carries the novelty review — `--statement`
  // is scored by the same gate `raise` uses, and even an unedited approval
  // reports what the text most resembles, because the gate only catches a
  // near-verbatim re-statement and the operator is the rest of the check.
  // Exit 1 when the text that just landed in memory is not novel: it landed
  // either way, but that is a "look at this", not a clean run.
  if (namespace === 'lessons' && (action === 'approve' || action === 'reject')) {
    const { transitionLesson } = await import('./lessons.js');
    const [lessonId] = requirePositionals(positional, usageFor(`lessons ${action}`)) as [string];
    const eventOpts = eventOptsFromFlags(flags);
    const ctx = eventContextFromFlags(flags);
    requireSession(ctx.sessionId, eventOpts);
    const row = await transitionLesson(
      lessonId,
      action === 'approve' ? 'approved' : 'invalidated',
      ctx,
      eventOpts,
      {
        note: flags.note,
        edit: {
          statement: flags.statement,
          lessonType: flags['lesson-type'],
          lessonScope: flags['lesson-scope'],
          agentRole: flags['agent-role'],
          caseType: flags['case-type'],
        },
        acceptDuplicate: flags['accept-duplicate'] === 'true',
        ...(await noveltyOptsFromFlags(flags)),
      },
    );
    printJson(row);
    return row.novelty && !row.novelty.novel ? 1 : 0;
  }

  if (namespace === 'lessons' && action === 'compile') {
    const { openDb } = await import('./db/projector.js');
    const { lessonsPage } = await import('./db/queries.js');
    const { compileLessons } = await import('./lessons.js');
    const dbPath = flags.db ?? STATE_DB_PATH;
    const outPath = flags.out ?? LESSONS_MD_PATH;
    const handle = openDb(dbPath);
    try {
      const scope = flags.session ? { sessionId: flags.session } : {};
      const approved = lessonsPage(handle.db, scope).approved;
      const markdown = compileLessons(
        approved.map((l) => ({
          lessonId: l.lessonId,
          lessonScope: l.lessonScope,
          statement: l.statement,
          findingCategory: l.findingCategory,
          claimPath: l.claimPath,
          agentRole: l.agentRole,
          caseType: l.caseType,
        })),
      );
      writeFileSync(outPath, markdown, 'utf8');
      printJson({ outPath, lessonsCompiled: approved.length });
      return 0;
    } finally {
      handle.sqlite.close();
    }
  }

  // The dispatch-time half of the lessons loop (P9-2): the caller composing a
  // role prompt asks for the block and splices it. Claims come from the
  // immutable plan rather than a repeated `--claim` flag — parseArgs keeps one
  // value per flag, and a claim glob may itself contain a comma (`src/{a,b}/**`),
  // so neither repetition nor splitting can carry a claims list faithfully.
  if (namespace === 'lessons' && action === 'for-dispatch') {
    const { lessonsForDispatch } = await import('./lessons.js');
    const [role] = requirePositionals(positional, usageFor('lessons for-dispatch')) as [string];
    printJson(
      lessonsForDispatch(role, claimsForDispatch(flags), {
        ...(flags['agents-dir'] ? { agentsDir: flags['agents-dir'] } : {}),
        ...(flags.lessons ? { lessonsPath: flags.lessons } : {}),
        caseType: caseForDispatch(flags),
      }),
    );
    return 0;
  }

  // The other half of the lessons loop, and the one it never had: `lessons.md`
  // only ever grows, and nothing read an entry back to ask whether it still
  // does anything. Read-only over both the log and the corpus — it recommends
  // `retire`, it does not retire, because a lesson is a standing instruction a
  // human wrote and §9.6 reserves supersession for a human's call. Exit 1 on
  // anything but `clean`, for the same reason `kpi same-mistake` does: a corpus
  // that cannot be read is not a corpus that is fine.
  if (namespace === 'lessons' && action === 'audit') {
    const { auditLessons } = await import('./lessonAudit.js');
    const [sessionId] = requirePositionals(positional, usageFor('lessons audit'), 1) as [string];
    requireSession(sessionId, eventOptsFromFlags(flags));
    // Lineage-wide (D-119), and here the reason is sharper than elsewhere: the
    // question is whether an entry has EVER fired, and a session-scoped read
    // answers "not in this half of the epic" while printing `retire`.
    const events = await readLineageEvents(sessionId, eventOptsFromFlags(flags));
    const lessons = parseLessons(readFileSync(flags.lessons ?? LESSONS_MD_PATH, 'utf8'));
    const report = auditLessons(events, lessons, { sessionId });
    printJson(report);
    return report.ok ? 0 : 1;
  }

  if (namespace === 'dream') {
    const { dream } = await import('./lessons.js');
    const sessionId = requireFlag(flags, 'session');
    // Before the lineage read, so a typo costs a message and not a full log walk.
    const since = isoDateFlag(flags, 'since')?.toISOString();
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(sessionId, eventOpts);
    // Lineage-wide (D-119). Dreaming is the pass that distils what went wrong
    // into lessons, and what went wrong belongs to the epic: an error logged
    // before a session split, and the retry that fixed it after, are one story
    // that a session-scoped read tells in halves. `--since` still bounds it.
    const events = await readLineageEvents(sessionId, eventOpts);
    const ctx = eventContextFromFlags(flags);

    const result = await dream(
      events,
      {
        sessionId: ctx.sessionId,
        planVersion: ctx.planVersion,
        causalParent: ctx.causalParent as string,
        actor: ctx.actor,
      },
      eventOpts,
      { since, ...(await noveltyOptsFromFlags(flags)) },
    );
    printJson(result);
    return 0;
  }

  // D-31, D-20 / P9-11. The two halves of a judge turn and the gap between
  // them. Dispatch declares the file; report proves it exists and parses;
  // outstanding is the difference, and exits non-zero while it is non-empty so
  // a re-poke loop can branch on the status instead of parsing stdout.
  if (namespace === 'judge' && action === 'dispatch') {
    const stored = await recordJudgeDispatch(
      {
        taskId: requireFlag(flags, 'task'),
        role: requireFlag(flags, 'role'),
        round: boundedIntFlag(flags, 'round', { min: 1 }) ?? 1,
        artifactPath: requireFlag(flags, 'artifact'),
        // Required, unlike --provider/--model-tier below: P9-23's dispatch
        // asymmetry audit compares model ids, and this verb records one half of
        // the reviewer/verifier pair it checks.
        model: requireFlag(flags, 'model'),
        ...(flags.provider ? { provider: flags.provider } : {}),
        ...(flags['model-tier'] ? { modelTier: flags['model-tier'] } : {}),
      },
      eventContextFromFlags(flags),
      eventOptsFromFlags(flags),
    );
    printJson(stored);
    return 0;
  }

  if (namespace === 'judge' && action === 'report') {
    // Optional here, unlike on dispatch, so an absent --round must stay absent
    // rather than defaulting: recordJudgeReport reads the dispatched round when
    // the caller names none. A present one is still a count (D-210's class) --
    // `--round abc` used to reach the reporter as NaN and come back as "is on
    // round 1, not round NaN", which blames the round for what the flag did.
    const reportRound = boundedIntFlag(flags, 'round', { min: 1 });
    const report = await recordJudgeReport(
      {
        taskId: requireFlag(flags, 'task'),
        role: requireFlag(flags, 'role'),
        ...(reportRound === undefined ? {} : { round: reportRound }),
        ...(flags.artifact ? { artifactPath: flags.artifact } : {}),
        // Here the role is already named by --role, so the valueless spelling
        // is the right one and 'true' means what it says.
        ...(flags['no-findings'] === 'true' ? { noFindings: true } : {}),
      },
      eventContextFromFlags(flags),
      eventOptsFromFlags(flags),
    );
    printJson(report);
    return 0;
  }

  if (namespace === 'judge' && action === 'outstanding') {
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(sessionId, eventOpts);
    const open = outstandingJudges(
      await readJudgeTurns(requireFlag(flags, 'task'), { sessionId }, eventOpts),
    );
    printJson(open);
    return open.length > 0 ? 1 : 0;
  }

  if (namespace === 'judge' && action === 'escalations') {
    // Kept out of the boot graph by habit rather than by need -- the module
    // imports nothing at runtime -- so that a later dependency added to it
    // cannot quietly cost `smith --help` a database (P9-2, test/cliBoot.test.ts).
    const { openQuorumEscalations, summariseEscalations } = await import('./quorumEscalations.js');
    const sessionId = requireFlag(flags, 'session');
    const eventOpts = eventOptsFromFlags(flags);
    requireSession(sessionId, eventOpts);
    // The lineage and not the session: an escalation raised in one operator
    // session is owed until answered, and the answer routinely lands in the
    // next one (judges.ts:248 -- an epic outgrowing one session is the
    // recommended shape). Folding one session would report a settled case as
    // open, and an open one as nothing at all.
    const summary = summariseEscalations(
      openQuorumEscalations(await readLineageEvents(sessionId, eventOpts)),
    );
    printJson(summary);
    return summary.exitCode;
  }

  if (namespace === 'judge' && action === 'preflight') {
    // The one provider question that can be answered without spending a call.
    // Deliberately ahead of `judge run` in this file for the same reason it is
    // ahead of it in the runbook: an operator reaching for a calibration call
    // to find out why a provider keeps failing usually needed this instead.
    const report = judgePreflight(flags.policy);
    printJson(report);
    return report.problems.length > 0 ? 1 : 0;
  }

  if (namespace === 'judge' && action === 'run') {
    // Manual invocation for calibration (docs/runbooks/providers.md) — never
    // touches the event log or quorum.ts; `--shadow` is an output-only note
    // for the operator's own bookkeeping (crosscheck.yml's provider `mode`
    // is the only thing that ever grants real gating power).
    const providerName = requireFlag(flags, 'provider');
    const request = readJsonFile<JudgeRequest>(requireFlag(flags, 'request'));
    const result = await runJudge(providerName, request);
    printJson({ ...result, shadow: flags.shadow === 'true' });
    return 0;
  }

  if (namespace === 'crossfind') {
    // crosscheck.yml's `independent_finder`, driven by hand. Three verbs, and
    // the split between them is the operator mandate made operable: `request`
    // shows exactly what would leave the machine WITHOUT sending it, `run`
    // sends it, and `reconcile` needs no provider at all.
    const policy = loadCrosscheckPolicy(flags.policy);

    if (action === 'request') {
      // Read-only and network-free by construction: it builds the JudgeRequest
      // and prints it. Every refusal independentFinderRequest() can raise —
      // send_diff false, empty diff, oversized diff — fires here too, so an
      // operator can find out what the policy forbids before spending a call.
      const request = independentFinderRequest({
        taskId: requireFlag(flags, 'task'),
        diff: readFileSync(requireFlag(flags, 'diff'), 'utf8'),
        diffRef: requireFlag(flags, 'diff-ref'),
        ...(repeated.criterion ? { criteria: repeated.criterion } : {}),
        budget: judgeBudgetFromFlags(flags),
        policy: policy.independentFinder,
      });
      printJson(request);
      return 0;
    }

    if (action === 'reconcile') {
      // Offline calibration: two saved lists in, one report out, no provider
      // invoked and nothing appended to the log. This is the verb to run over
      // a shadow-mode backlog before deciding whether to flip `mode: active`.
      const report = reconcile({
        taskId: requireFlag(flags, 'task'),
        native: readJsonFile<NativeFindingRecord[]>(requireFlag(flags, 'native')),
        independent: readJsonFile<IndependentRun[]>(requireFlag(flags, 'independent')),
        policy: policy.independentFinder,
      });
      printJson(report);
      return report.gates ? 1 : 0;
    }

    if (action === 'run') {
      const sessionId = requireFlag(flags, 'session');
      const taskId = requireFlag(flags, 'task');
      const eventOpts = eventOptsFromFlags(flags);
      requireSession(sessionId, eventOpts);
      // Lineage-wide (D-119), like every other read of a task's findings: a
      // finding raised before a session split is still a finding this diff has
      // to be reconciled against.
      const native = (await listFindings(sessionId, { taskId }, eventOpts)).filter((f) =>
        flags.status === undefined
          ? OPEN_FINDING_STATUSES.has(f.finding_status)
          : f.finding_status === flags.status,
      );
      // Built separately from the run for the reason RunIndependentFinderInput
      // says: `crossfind request` and `crossfind run` must assemble the same
      // bytes, so the thing the operator inspected is the thing that is sent.
      const request = independentFinderRequest({
        taskId,
        diff: readFileSync(requireFlag(flags, 'diff'), 'utf8'),
        diffRef: requireFlag(flags, 'diff-ref'),
        ...(repeated.criterion ? { criteria: repeated.criterion } : {}),
        budget: judgeBudgetFromFlags(flags),
        policy: policy.independentFinder,
      });
      const result = await runIndependentFinder(
        { taskId, request, native, policy },
        eventContextFromFlags(flags),
        eventOpts,
      );
      // `raise` is printed, never minted (crossFinding.ts's contract): which
      // findings enter a gate is the operator's call, and `smith findings
      // raise` is where they make it.
      printJson({
        report: result.report,
        runs: result.runs,
        raise: result.raise,
        reconciled_event_id: result.reconciledEventId,
        native_considered: native.length,
      });
      return result.report.gates ? 1 : 0;
    }
  }

  if (namespace === 'ui' && action === 'serve') {
    // Before the dynamic import below, so a mistyped port costs a message and
    // not a build: unbuilt, ui.not-built preempted the parse and the operator
    // was told to run pnpm build:server for a typo that would still be there
    // afterwards. Built, listen() threw ERR_SOCKET_BAD_PORT -- exit 1, but a
    // Node stack trace on stdout with no error.code, the one shape every other
    // error from this CLI has.
    const port = boundedIntFlag(flags, 'port', { min: 1, max: 65535 }) ?? 4680;
    // ui/server is a separate TS project (ui/server/tsconfig.json) built to
    // ui/server/dist/index.js — dynamically imported here (via a computed,
    // non-literal specifier, so tsc never tries to fold it into THIS
    // project's rootDir) rather than statically imported, so `smith`'s own
    // build/bin contract (factory/orchestrator/dist/cli.js) stays untouched
    // whether or not the UI has been built. See ui/server/src/app.ts's
    // header comment for why ui/server depends on the BUILT orchestrator
    // dist/, not this file's src/ tree.
    const serverEntry = path.join(REPO_ROOT, 'ui', 'server', 'dist', 'index.js');
    let mod: {
      serve: (opts: {
        port: number;
        dbPath: string;
        stateDir?: string;
        roadmapPath?: string;
        specsDir?: string;
      }) => {
        close: () => void;
      };
    };
    try {
      mod = await import(pathToFileURL(serverEntry).href);
    } catch (err) {
      throw new SmithError(
        'ui.not-built',
        `ui/server is not built (expected ${serverEntry}). Run "pnpm build:server" first.`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    const dbPath = flags.db ?? STATE_DB_PATH;
    const stateDir = flags['state-dir'];
    // --roadmap-path travels with --db/--state-dir, and dropping it was not a
    // missing feature but a silent data swap: the read path re-projects each
    // session on the first request (app.ts's createRefresher), and apply()
    // rebuilds the whole milestones table from a roadmap file while it is
    // there. Unset, that file falls back to black-smith's own
    // factory/specs/roadmap.md — so serving another project's db showed this
    // repo's roadmap from the first page load onward.
    const roadmapPath = flags['roadmap-path'];
    // Same argument for --specs-dir: createRefresher re-projects on every
    // request, and the plan files it consults to place an unstamped epic
    // (D-246) must be the served db's, not this repo's.
    const specsDir = flags['specs-dir'];
    mod.serve({
      port,
      dbPath,
      ...(stateDir ? { stateDir } : {}),
      ...(roadmapPath ? { roadmapPath } : {}),
      ...(specsDir ? { specsDir } : {}),
    });
    return 0;
  }

  if (namespace === 'db' && action === 'rebuild') {
    const { rebuild: rebuildDb } = await import('./db/projector.js');
    const dbPath = flags.db ?? STATE_DB_PATH;
    const sessions = flags.session ? [flags.session] : 'all';
    // A named session must exist; `all` legitimately finds nothing (P9-28).
    if (flags.session) requireSession(flags.session, eventOptsFromFlags(flags));
    const result = await rebuildDb(dbPath, sessions, dbOptsFromFlags(flags));
    printJson(result);
    return 0;
  }

  if (namespace === 'db' && action === 'apply') {
    const { apply: applyDb } = await import('./db/projector.js');
    const dbPath = flags.db ?? STATE_DB_PATH;
    const sessionId = requireFlag(flags, 'session');
    // Applying a session that has no log would report 0 events applied and
    // exit 0 — a successful-looking no-op is the worst possible answer for a
    // command whose whole job is "make the DB match the log" (P9-28).
    requireSession(sessionId, eventOptsFromFlags(flags));
    const result = await applyDb(dbPath, sessionId, dbOptsFromFlags(flags));
    printJson(result);
    return 0;
  }

  if (namespace === 'stats') {
    const { openDb } = await import('./db/projector.js');
    const {
      analytics,
      errorsPage,
      kanban,
      lessonsPage,
      overview,
      providerAgreement,
      roadmapPage,
      taskDetail,
      timeline,
    } = await import('./db/queries.js');
    const dbPath = flags.db ?? STATE_DB_PATH;
    const handle = openDb(dbPath);
    try {
      const scope = flags.session ? { sessionId: flags.session } : {};
      if (action === 'overview') {
        printJson(overview(handle.db, scope));
        return 0;
      }
      if (action === 'timeline') {
        printJson(
          timeline(handle.db, {
            ...scope,
            taskId: flags.task,
            epicId: flags.epic,
            causalChainFor: flags['causal-chain-for'],
          }),
        );
        return 0;
      }
      if (action === 'kanban') {
        const epic = requireFlag(flags, 'epic');
        printJson(kanban(handle.db, epic, scope));
        return 0;
      }
      if (action === 'task') {
        const taskId = requireFlag(flags, 'task');
        const detail = taskDetail(handle.db, taskId);
        printJson(detail);
        return detail ? 0 : 1;
      }
      if (action === 'lessons') {
        printJson(lessonsPage(handle.db, scope));
        return 0;
      }
      if (action === 'errors') {
        printJson(errorsPage(handle.db, scope));
        return 0;
      }
      if (action === 'analytics') {
        printJson(analytics(handle.db, scope));
        return 0;
      }
      if (action === 'roadmap') {
        printJson(roadmapPage(handle.db, scope));
        return 0;
      }
      if (action === 'providers') {
        const since = isoDateFlag(flags, 'since')?.toISOString();
        printJson(providerAgreement(handle.db, scope, { since }));
        return 0;
      }
    } finally {
      handle.sqlite.close();
    }
  }

  // Unreachable while usage.ts and the branches above agree, because
  // isDocumented rejected everything they do not both name — but a function
  // returning `Promise<number>` has to return on every path, and an
  // unreachable `throw` would be a worse answer than the honest one. What
  // keeps the two in agreement is test/usage.test.ts, not this line.
  printJson({
    error: {
      message: `Unknown command: ${[namespace, action].filter(Boolean).join(' ')}`,
    },
  });
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // A SmithError is a designed answer: its code names the failure and its
    // details name the record, so a stack would only add noise. Anything else
    // is a bug, and D-135 is what that costs — `{"message":"Cannot read
    // properties of undefined (reading 'indexOf')"}` was the entire output of
    // a failed `smith findings list`, with no file, no line and no clue which
    // of the three helpers that call `.indexOf` had thrown. The stack is the
    // only part of an unexpected error worth having.
    const details =
      err instanceof SmithError
        ? { code: err.code, message: err.message, details: err.details }
        : {
            message: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && err.stack ? { stack: err.stack.split('\n') } : {}),
          };
    printJson({ error: details });
    process.exitCode = 1;
  });
