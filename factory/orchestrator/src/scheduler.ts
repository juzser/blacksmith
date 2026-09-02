// Deterministic scheduler pass (architecture §12 "Recheck scheduling" +
// "Scheduled growth passes"; `smith scheduler run`). Reads the event log
// (via db/projector.ts's already-owned task fold — no reason to re-derive
// task-lifecycle state a second time) and proposes work; it NEVER dispatches
// an agent and never widens scope itself — every output here is a
// `*-proposed`/`growth-review-due` event for a human or a later planner
// session to act on.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AutonomyPolicy } from './autonomy.js';
import { globsOverlap } from './claims.js';
import { foldTasks, type TaskFoldRow, taskIdCanonicalizer } from './db/projector.js';
import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import { SCHEDULER_POLICY_PATH } from './paths.js';

export class SchedulerError extends SmithError {}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface RecheckPolicy {
  mergeThreshold: number;
  daysElapsed: number;
  confidenceThreshold: number;
}

export interface MaintenancePolicy {
  autoScheduleConfidence: number;
  majorBumpConfidence: number;
  minorOrPatchConfidence: number;
}

export interface GrowthPolicy {
  cadenceDays: number;
}

/** lessons.ts's novelty gate (architecture §9.3) — same policy file, single source of truth. */
export interface LessonsSchedulerPolicy {
  noveltyJaccardThreshold: number;
  shingleSize: number;
  /** Correct the threshold for statement length before comparing (P9-35 (a)). */
  noveltyLengthAware: boolean;
}

export interface SchedulerPolicy {
  recheck: RecheckPolicy;
  maintenance: MaintenancePolicy;
  growth: GrowthPolicy;
  lessons: LessonsSchedulerPolicy;
  /** Who may say yes to what this pass proposes — see src/autonomy.ts. */
  autonomy: AutonomyPolicy;
}

interface RawSchedulerYaml {
  recheck?: {
    merge_threshold?: number;
    days_elapsed?: number;
    confidence_threshold?: number;
  };
  maintenance?: {
    auto_schedule_confidence?: number;
    major_bump_confidence?: number;
    minor_or_patch_confidence?: number;
  };
  growth?: { cadence_days?: number };
  lessons?: {
    novelty_jaccard_threshold?: number;
    shingle_size?: number;
    novelty_length_aware?: boolean;
  };
  // Deliberately typed loose: the whole job of the list checks below is to
  // catch a document that does not match this shape.
  autonomy?: {
    enabled?: boolean;
    auto_dispatch_kinds?: unknown;
    auto_dispatch_recheck_reasons?: unknown;
    confidence_floor?: number;
  };
}

/**
 * Every knob, checked rather than trusted (D-203 for the two `lessons` ones).
 *
 * `??` defaults on null/undefined only, so a YAML typo -- `days_elapsed:
 * fourteen`, `cadence_days: monthly` -- arrived at the comparison as itself,
 * with the declared `number` type saying otherwise. Nothing then failed. The
 * comparison simply answered differently, in a different direction at each
 * knob it reaches, which is the same defect cli.ts already reasoned out for a
 * mistyped `--now` (D-209):
 *
 *   - `999 >= 'fourteen'` is false, so a task untouched for three years never
 *     proposes `time-elapsed`. Fails CLOSED: the operator asks what is due and
 *     the typo answers "nothing".
 *   - `0.001 < 'monthly'` is false, so `proposeGrowthReview` never returns
 *     null and the review fires on every pass. Fails OPEN, from the same typo.
 *   - `shingle_size: 0` makes `shingles()` emit one empty gram per statement,
 *     so any two score a Jaccard of 1.0 and `smith dream` auto-rejects every
 *     checkpoint it extracts.
 *   - a non-numeric novelty threshold makes `score >= threshold` a NaN
 *     comparison, always false, so nothing is ever redundant.
 *
 * A wrong *number* still passes, deliberately: `days_elapsed: 1` proposes more
 * rechecks and the operator reads them, so it argues with itself in the open.
 * A wrong *type* argues in silence. Finiteness is part of the type check, not
 * a range rule -- `.inf` is a number that no count can ever reach.
 *
 * The refusal names the value because a policy file is hand-edited.
 */
const READS_SILENTLY =
  'A value the comparison cannot read does not fail the run, it changes what the run proposes.';
const VOIDS_THE_GATE =
  'The novelty gate reads this directly and a degenerate value voids it silently.';
const TRUTHY_IS_NOT_TRUE =
  'YAML 1.2 reads `on`/`off`/`yes`/`no` as strings, and every non-empty string is truthy — an operator who typed `off` would have switched the gate ON.';

function checkKnob(
  field: string,
  value: number,
  expected: string,
  note: string,
  ok: (n: number) => boolean = () => true,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !ok(value)) {
    throw new SchedulerError(
      'scheduler.invalid-policy',
      `scheduler.yml ${field} must be ${expected}; got ${JSON.stringify(value)}. ${note}`,
      { field, value },
    );
  }
  return value;
}

/** A knob whose only rule is that a comparison can read it. */
function count(field: string, value: number): number {
  return checkKnob(field, value, 'a finite number', READS_SILENTLY);
}

/** A knob the code branches on directly, where any string at all would read as `true`. */
function flag(field: string, value: boolean, note: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SchedulerError(
      'scheduler.invalid-policy',
      `scheduler.yml ${field} must be true or false; got ${JSON.stringify(value)}. ${note}`,
      { field, value },
    );
  }
  return value;
}

/**
 * The closed vocabularies the `autonomy:` whitelists draw from. Closed on
 * purpose: a name that matches nothing would fail closed, which is the safe
 * direction and exactly why it has to be loud — `maintenence` would leave
 * autonomy switched on and admitting nothing, and the log would say only that
 * the operator was never asked.
 */
const PROPOSAL_KINDS: readonly SchedulerProposal['kind'][] = [
  'recheck',
  'maintenance',
  'growth-review-due',
];
const RECHECK_REASONS: readonly RecheckReason[] = [
  'merge-threshold',
  'time-elapsed',
  'low-confidence',
];

const A_LIST_IS_NOT_A_STRING =
  'A bare scalar spreads into its characters here, so `recheck` would read as seven kinds that match nothing.';

/** A whitelist: a list of strings, every one of them a name this code knows. */
function vocabList(field: string, value: unknown, vocabulary: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SchedulerError(
      'scheduler.invalid-policy',
      `scheduler.yml ${field} must be a list of strings; got ${JSON.stringify(value)}. ${A_LIST_IS_NOT_A_STRING}`,
      { field, value },
    );
  }
  const entries = value as string[];
  const unknown = entries.filter((entry) => !vocabulary.includes(entry));
  if (unknown.length > 0) {
    throw new SchedulerError(
      'scheduler.invalid-policy',
      `scheduler.yml ${field} lists ${unknown.map((u) => JSON.stringify(u)).join(', ')}, which is not one of: ${vocabulary.join(', ')}. A name nothing matches disables silently.`,
      { field, value: unknown },
    );
  }
  return [...entries];
}

export function parseSchedulerPolicy(yamlText: string): SchedulerPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawSchedulerYaml;
  if (!doc.recheck || !doc.maintenance || !doc.growth) {
    throw new SchedulerError(
      'scheduler.invalid-policy',
      'scheduler.yml is missing one of recheck/maintenance/growth.',
    );
  }
  return {
    recheck: {
      mergeThreshold: count('recheck.merge_threshold', doc.recheck.merge_threshold ?? 5),
      daysElapsed: count('recheck.days_elapsed', doc.recheck.days_elapsed ?? 14),
      confidenceThreshold: count(
        'recheck.confidence_threshold',
        doc.recheck.confidence_threshold ?? 0.6,
      ),
    },
    maintenance: {
      autoScheduleConfidence: count(
        'maintenance.auto_schedule_confidence',
        doc.maintenance.auto_schedule_confidence ?? 0.8,
      ),
      majorBumpConfidence: count(
        'maintenance.major_bump_confidence',
        doc.maintenance.major_bump_confidence ?? 0.5,
      ),
      minorOrPatchConfidence: count(
        'maintenance.minor_or_patch_confidence',
        doc.maintenance.minor_or_patch_confidence ?? 0.9,
      ),
    },
    growth: { cadenceDays: count('growth.cadence_days', doc.growth.cadence_days ?? 30) },
    // Every default fails closed. A scheduler.yml written before autonomy
    // existed, or one a downstream project trimmed, must not inherit this
    // repo's answer to "what may run without me": absent means off, and off
    // means an empty whitelist behind it.
    autonomy: {
      enabled: flag('autonomy.enabled', doc.autonomy?.enabled ?? false, TRUTHY_IS_NOT_TRUE),
      autoDispatchKinds: vocabList(
        'autonomy.auto_dispatch_kinds',
        doc.autonomy?.auto_dispatch_kinds ?? [],
        PROPOSAL_KINDS,
      ),
      autoDispatchRecheckReasons: vocabList(
        'autonomy.auto_dispatch_recheck_reasons',
        doc.autonomy?.auto_dispatch_recheck_reasons ?? [],
        RECHECK_REASONS,
      ),
      confidenceFloor: checkKnob(
        'autonomy.confidence_floor',
        doc.autonomy?.confidence_floor ?? 0.8,
        'a number in [0, 1]',
        READS_SILENTLY,
        (n) => n >= 0 && n <= 1,
      ),
    },
    lessons: {
      noveltyJaccardThreshold: checkKnob(
        'lessons.novelty_jaccard_threshold',
        doc.lessons?.novelty_jaccard_threshold ?? 0.8,
        'a number in (0, 1]',
        VOIDS_THE_GATE,
        (n) => n > 0 && n <= 1,
      ),
      shingleSize: checkKnob(
        'lessons.shingle_size',
        doc.lessons?.shingle_size ?? 3,
        'an integer >= 1',
        VOIDS_THE_GATE,
        (n) => Number.isInteger(n) && n >= 1,
      ),
      noveltyLengthAware: flag(
        'lessons.novelty_length_aware',
        doc.lessons?.novelty_length_aware ?? true,
        TRUTHY_IS_NOT_TRUE,
      ),
    },
  };
}

export function loadSchedulerPolicy(filePath: string = SCHEDULER_POLICY_PATH): SchedulerPolicy {
  return parseSchedulerPolicy(readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// (a) Recheck proposals
// ---------------------------------------------------------------------------

export type RecheckReason = 'merge-threshold' | 'time-elapsed' | 'low-confidence';

export interface RecheckProposal {
  kind: 'recheck';
  taskId: string;
  epicId: string | null;
  reasons: RecheckReason[];
  mergeCount: number;
  daysElapsed: number;
  confidence: number;
}

interface TaskResultPayload {
  task_id?: string;
  structured_output?: { confidence?: number };
}

/**
 * task_id -> confidence from its task-result-recorded event, default 1 (full
 * confidence) when absent.
 *
 * Keyed by the canonical id, because `smith gate run <taskId>` stamps whatever
 * spelling the operator typed: the same task reaches the log qualified from
 * `task-added` and bare from its result. `proposeRechecks` reads this map with
 * the canonical id `foldTasks` folded the row under, so a raw key would miss,
 * fall back to full confidence, and make `low-confidence` unfireable (D-182).
 */
function confidenceByTask(events: readonly StoredEvent[]): Map<string, number> {
  const byTask = new Map<string, number>();
  const canonical = taskIdCanonicalizer(events);
  for (const { record } of events) {
    if (record.event_type !== 'task-result-recorded') continue;
    const p = record.payload as TaskResultPayload;
    const taskId = record.task_id ?? p.task_id;
    const confidence = p.structured_output?.confidence;
    if (taskId !== undefined && typeof confidence === 'number') {
      byTask.set(canonical(taskId), confidence);
    }
  }
  return byTask;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface TaskAddedRecheckPayload {
  recheck_of?: string;
}

interface RecheckDeclinedPayload {
  task_id?: string;
}

interface RecheckProposedPayload {
  taskId?: string;
}

/**
 * `taskId` -> the event-array index of its MOST RECENT `recheck-proposed`
 * event (this scheduler's own prior output — `runScheduler()` appends this
 * event type verbatim from `RecheckProposal`, which uses `taskId`, camelCase
 * — a deliberate deviation from this file's `task_id` snake_case elsewhere,
 * since the payload here isn't a required-taxonomy-dimension record; noted,
 * not renamed, to avoid an unrelated payload-shape change in this fix).
 */
function latestRecheckProposalIndex(events: readonly StoredEvent[]): Map<string, number> {
  const latest = new Map<string, number>();
  events.forEach(({ record }, index) => {
    if (record.event_type !== 'recheck-proposed') return;
    const p = record.payload as RecheckProposedPayload;
    if (p.taskId) latest.set(p.taskId, index);
  });
  return latest;
}

/**
 * A prior `recheck-proposed` for `taskId` counts as RESOLVED once one of two
 * events for it appears LATER in the log:
 *   (a) `task-added` whose payload.recheck_of === taskId — a real recheck
 *       task was created for it (the convention `/bs plan`'s playbook
 *       follows when it turns a proposal into a task), or
 *   (b) `recheck-declined` whose payload.task_id === taskId — the operator
 *       explicitly said no.
 * Deliberately NARROW: no other event touching taskId resolves a pending
 * proposal. Idempotency must fail closed — re-proposing the same recheck is
 * harmless noise the operator/planner can ignore; silently losing a real,
 * still-open recheck need because some unrelated event happened to
 * reference the task would not be.
 */
function isRecheckResolved(taskId: string, eventsAfterProposal: readonly StoredEvent[]): boolean {
  for (const { record } of eventsAfterProposal) {
    if (record.event_type === 'task-added') {
      const p = record.payload as TaskAddedRecheckPayload;
      if (p.recheck_of === taskId) return true;
    } else if (record.event_type === 'recheck-declined') {
      const p = record.payload as RecheckDeclinedPayload;
      if (p.task_id === taskId) return true;
    }
  }
  return false;
}

/**
 * §12 recheck policy over already-completed features: for each completed,
 * non-recheck-origin task, count LATER-completed tasks whose claims overlap
 * it (mergeCount), days elapsed since it completed, and its completion
 * confidence (from task-result-recorded, default 1). Proposes a recheck when
 * any one of the three thresholds trips; `reasons` lists every one that did
 * — UNLESS an earlier `recheck-proposed` for the same task is still
 * unresolved (isRecheckResolved), in which case it is skipped: re-running
 * this pass must never emit a duplicate proposal for the same open recheck.
 */
export function proposeRechecks(
  events: readonly StoredEvent[],
  now: Date,
  policy: RecheckPolicy,
): RecheckProposal[] {
  const tasks = foldTasks(events);
  const completed = tasks.filter((t) => t.taskStatus === 'completed' && t.origin !== 'recheck');
  const confidence = confidenceByTask(events);
  const latestProposalIndex = latestRecheckProposalIndex(events);

  const proposals: RecheckProposal[] = [];
  for (const task of completed) {
    const mergeCount = countLaterOverlappingMerges(task, tasks);
    const daysElapsed = (now.getTime() - Date.parse(task.updatedAt)) / MS_PER_DAY;
    const taskConfidence = confidence.get(task.taskId) ?? 1;

    const reasons: RecheckReason[] = [];
    if (mergeCount >= policy.mergeThreshold) reasons.push('merge-threshold');
    if (daysElapsed >= policy.daysElapsed) reasons.push('time-elapsed');
    if (taskConfidence < policy.confidenceThreshold) reasons.push('low-confidence');
    if (reasons.length === 0) continue;

    const priorIndex = latestProposalIndex.get(task.taskId);
    if (priorIndex !== undefined) {
      const eventsAfter = events.slice(priorIndex + 1);
      if (!isRecheckResolved(task.taskId, eventsAfter)) continue; // still pending -> skip, idempotent
    }

    proposals.push({
      kind: 'recheck',
      taskId: task.taskId,
      epicId: task.epicId,
      reasons,
      mergeCount,
      daysElapsed: Math.floor(daysElapsed),
      confidence: taskConfidence,
    });
  }
  return proposals.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function countLaterOverlappingMerges(task: TaskFoldRow, allTasks: readonly TaskFoldRow[]): number {
  if (!task.claims || task.claims.length === 0) return 0;
  let count = 0;
  for (const other of allTasks) {
    if (other.taskId === task.taskId) continue;
    if (other.taskStatus !== 'completed') continue;
    if (Date.parse(other.updatedAt) <= Date.parse(task.updatedAt)) continue;
    if (!other.claims || other.claims.length === 0) continue;
    const overlaps = task.claims.some((a) => other.claims?.some((b) => globsOverlap(a, b)));
    if (overlaps) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// (b) Maintenance-pass stub
// ---------------------------------------------------------------------------

export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
}

interface PnpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
}

export function parsePnpmOutdated(json: string): OutdatedPackage[] {
  const doc = JSON.parse(json) as Record<string, PnpmOutdatedEntry>;
  return Object.entries(doc)
    .filter(([, v]) => v.current && v.wanted && v.latest)
    .map(([name, v]) => ({
      name,
      current: v.current as string,
      wanted: v.wanted as string,
      latest: v.latest as string,
    }));
}

/** Best-effort `pnpm outdated --json` in `projectDir`; null when pnpm/lockfile is unavailable ("when available"). */
export function runPnpmOutdated(projectDir: string): OutdatedPackage[] | null {
  let stdout: string;
  try {
    // pnpm outdated exits 1 when it finds outdated packages — the JSON is
    // still on stdout, so a non-zero exit is read from the error, not treated
    // as failure. A genuinely missing pnpm/lockfile throws with no stdout.
    // stdio explicit for the same reason as git.ts: without it execFileSync
    // sends pnpm's stderr to the operator's terminal, and "No dependencies
    // found" on a fresh project reads as a factory failure (P9-16b).
    stdout = execFileSync('pnpm', ['outdated', '--json'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const withStdout = err as { stdout?: string };
    if (!withStdout.stdout) return null;
    stdout = withStdout.stdout;
  }
  try {
    return parsePnpmOutdated(stdout);
  } catch {
    return null; // not valid JSON — nothing to propose, not a crash
  }
}

function majorVersion(semver: string): number {
  const match = semver.replace(/^[^0-9]*/, '').match(/^(\d+)/);
  return match ? Number.parseInt(match[1] as string, 10) : 0;
}

export interface MaintenanceProposal {
  kind: 'maintenance';
  /**
   * The repo this proposal is about, as an absolute path.
   *
   * A factory that builds N projects has N+1 repos to keep current — its own
   * and every child's — and a proposal that does not say which one it read
   * cannot be acted on, or even told apart from the next one. Resolved rather
   * than stored as written, for the same reason `taskWorktreeDir` resolves
   * (D-42/P9-26): `.` and the absolute path name one repo, and a downstream
   * reader that keys on the string would otherwise see two.
   */
  projectDir: string;
  packages: OutdatedPackage[];
  confidence: number;
  autoSchedulable: boolean;
}

/** origin: inferred (agent-constraints.md "planner / Growth passes") — auto-schedulable only at high confidence. */
export function proposeMaintenance(
  projectDir: string,
  packages: readonly OutdatedPackage[],
  policy: MaintenancePolicy,
): MaintenanceProposal | null {
  if (packages.length === 0) return null;
  const hasMajorBump = packages.some((p) => majorVersion(p.latest) > majorVersion(p.current));
  const confidence = hasMajorBump ? policy.majorBumpConfidence : policy.minorOrPatchConfidence;
  return {
    kind: 'maintenance',
    projectDir: path.resolve(projectDir),
    packages: [...packages],
    confidence,
    autoSchedulable: confidence >= policy.autoScheduleConfidence,
  };
}

// ---------------------------------------------------------------------------
// (c) Product-growth review cadence
// ---------------------------------------------------------------------------

export interface GrowthReviewProposal {
  kind: 'growth-review-due';
  cadenceDays: number;
  lastReviewAt: string | null;
}

/**
 * Emits the TRIGGER only — architecture §12: "product-growth proposals
 * always wait for an operator tick"; the planner session (not this
 * scheduler) reads the living spec/analytics and proposes scope. Fires once
 * cadenceDays have elapsed since the last growth-review-due event in this
 * log (or immediately, if none has ever fired).
 */
export function proposeGrowthReview(
  events: readonly StoredEvent[],
  now: Date,
  policy: GrowthPolicy,
): GrowthReviewProposal | null {
  let lastReviewAt: string | null = null;
  for (const { record } of events) {
    if (record.event_type === 'growth-review-due') lastReviewAt = record.ts;
  }
  if (lastReviewAt === null) {
    return { kind: 'growth-review-due', cadenceDays: policy.cadenceDays, lastReviewAt: null };
  }
  const daysSince = (now.getTime() - Date.parse(lastReviewAt)) / MS_PER_DAY;
  if (daysSince < policy.cadenceDays) return null;
  return { kind: 'growth-review-due', cadenceDays: policy.cadenceDays, lastReviewAt };
}

// ---------------------------------------------------------------------------
// Full pass + event emission
// ---------------------------------------------------------------------------

export type SchedulerProposal = RecheckProposal | MaintenanceProposal | GrowthReviewProposal;

export interface SchedulerRunInput {
  events: readonly StoredEvent[];
  now?: Date;
  policy?: SchedulerPolicy;
  /**
   * Every repo to run `pnpm outdated --json` in; empty or omitted -> the
   * maintenance pass does not run at all.
   *
   * Plural because the factory's job is plural. Blacksmith builds projects
   * that stand on their own, and "maintains itself and its children" is not a
   * claim a single `--project` can carry: with one slot the operator chooses
   * between watching the factory's dependencies or one child's, and whichever
   * they do not choose goes unwatched with nothing saying so.
   */
  projectDirs?: readonly string[];
  /**
   * How to ask one repo what is behind. The single effect in an otherwise
   * pure pass, named so a test can answer for a repo that does not exist --
   * `pnpm outdated` needs a registry, and a test that reached one would be a
   * test that fails when the network does.
   */
  readOutdated?: (projectDir: string) => OutdatedPackage[] | null;
}

/** Pure: computes every proposal this pass would make, without touching the event log. */
export function computeProposals(input: SchedulerRunInput): SchedulerProposal[] {
  const policy = input.policy ?? loadSchedulerPolicy();
  const now = input.now ?? new Date();
  const readOutdated = input.readOutdated ?? runPnpmOutdated;

  const proposals: SchedulerProposal[] = [...proposeRechecks(input.events, now, policy.recheck)];

  // In the order the repos were given, and one repo's silence costs only that
  // repo: "when available" is a property of each lockfile, so a child project
  // that has never been installed must not take the reading on all the others
  // down with it.
  for (const projectDir of input.projectDirs ?? []) {
    const outdated = readOutdated(projectDir);
    if (!outdated) continue;
    const maintenance = proposeMaintenance(projectDir, outdated, policy.maintenance);
    if (maintenance) proposals.push(maintenance);
  }

  const growth = proposeGrowthReview(input.events, now, policy.growth);
  if (growth) proposals.push(growth);

  return proposals;
}

export interface SchedulerEventContext {
  sessionId: string;
  planVersion: number;
  causalParent: string;
  actor?: string;
}

/** event_type per proposal kind — free strings, same taxonomy precedent as dispatch_decision/gate-outcome. */
function eventTypeFor(proposal: SchedulerProposal): string {
  if (proposal.kind === 'recheck') return 'recheck-proposed';
  if (proposal.kind === 'maintenance') return 'maintenance-proposed';
  return 'growth-review-due';
}

/**
 * Runs computeProposals() and, unless `dryRun`, appends one event per
 * proposal (chained causal_parent) — the scheduler's only write. Never
 * dispatches an agent itself (architecture §12).
 */
export async function runScheduler(
  input: SchedulerRunInput,
  ctx: SchedulerEventContext,
  opts: EventOpts = {},
  dryRun = false,
): Promise<{ proposals: SchedulerProposal[]; eventIds: string[] }> {
  const proposals = computeProposals(input);
  const eventIds: string[] = [];
  if (!dryRun) {
    let parent = ctx.causalParent;
    for (const proposal of proposals) {
      const event = await appendEvent(
        {
          session_id: ctx.sessionId,
          actor: ctx.actor ?? 'system',
          event_type: eventTypeFor(proposal),
          plan_version: ctx.planVersion,
          causal_parent: parent,
          payload: proposal as unknown as Record<string, unknown>,
        },
        opts,
      );
      parent = event.event_id;
      eventIds.push(event.event_id);
    }
  }
  return { proposals, eventIds };
}
