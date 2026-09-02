// Phase 10's background watcher (`smith daemon`). It closes the one gap the
// roadmap still names: knowing what the factory needs required an operator to
// keep a session open and re-run `smith status` by hand.
//
// What it is NOT is the more tempting thing. This daemon never dispatches an
// agent, never merges, never writes to a worktree; scheduler.ts says why in
// its own words ("Never dispatches an agent itself — architecture §12"), and a
// process that survives the operator's terminal is the last place to relax
// that. Its whole output is a list of findings and one refreshed projection.
//
// Everything it reports is derived from the event log by folds this repo
// already owns — budgetAlarm.ts for spend, agents-registry.ts for stalls,
// scheduler.ts for work that is due. Nothing here re-derives them, so the
// daemon and `smith status` can never disagree.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentRecord,
  DEFAULT_STALE_HOURS,
  detectStale,
  foldAgents,
} from './agents-registry.js';
import {
  type AdmissionCode,
  type AdmissionDecision,
  type AutonomyPolicy,
  admitProposals,
} from './autonomy.js';
import { checkBudgetAlarm } from './budgetAlarm.js';
import { type BudgetPolicy, loadBudgetPolicy } from './budgets.js';
import { loadCrosscheckPolicy } from './crosscheck.js';
import type { DbOpts } from './db/projector.js';
import { apply, foldTasks } from './db/projector.js';
import { summariseEpicWidth, UNMEASURED_HINT } from './epicWidth.js';
import { SmithError } from './errors.js';
import {
  listSessionIds,
  mergeSessionLogs,
  parseEventId,
  readEvents,
  type SessionLog,
  type StoredEvent,
} from './events.js';
import { type AgedFinding, ageFindings, type FindingMemory, memoryOf } from './findingAge.js';
import { STATE_DAEMON_DIR, STATE_DB_PATH, STATE_EVENTS_DIR } from './paths.js';
import {
  computeProposals,
  loadSchedulerPolicy,
  type SchedulerPolicy,
  type SchedulerProposal,
} from './scheduler.js';
import { foldSpecChanges } from './specChange.js';

export class DaemonError extends SmithError {}

/** A session log's first event, and the only one allowed to name another session. */
const ROOT_EVENT_TYPE = 'session-start';

const LOCK_FILE = 'daemon.pid';
const STATUS_FILE = 'status.json';
const MEMORY_FILE = 'findings.json';

export const DEFAULT_INTERVAL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingKind =
  | 'budget'
  | 'unattributed-spend'
  | 'stale-agent'
  | 'recheck'
  | 'spec-change'
  | 'maintenance'
  | 'growth-review'
  | 'factory-width'
  | 'unreadable-log'
  | 'projection-failed';

/**
 * `attention` means something is wrong now; `info` means there is work to
 * schedule. The split exists so an operator can treat a non-zero attention
 * count as a reason to look — which stops being true the moment a routine
 * cadence tick is filed under the same word.
 */
export type FindingSeverity = 'info' | 'attention';

/**
 * Who has to say yes before a finding can clear — autonomy.ts's answer,
 * carried into the surface that runs unattended.
 *
 * `smith scheduler admit` has answered this since Phase 9, per session, for
 * somebody who types it. The watcher is where it was missing and where it is
 * worth most: a recheck a `/bs report` wave will clear on its own and a growth
 * review that is structurally the operator's are the same grey line in a
 * status file, and the operator cannot tell which half of the list is theirs.
 *
 * Reporting only. This changes nothing about what the daemon does — it still
 * never dispatches, never merges and never writes to a worktree — and an
 * `auto` here is a statement about POLICY, not a thing that has happened or
 * will happen on its own. Something a person starts still has to run the wave.
 */
export interface FindingAdmission {
  decision: AdmissionDecision;
  code: AdmissionCode;
  /** Why, in the terms the operator would use to argue with it. */
  reason: string;
}

export interface DaemonFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** null when the finding belongs to the repo rather than to one session. */
  sessionId: string | null;
  subject: string;
  detail: string;
  /**
   * Set only on the findings a scheduler proposal stands behind — a recheck, a
   * maintenance bump, a growth review. A blown budget or a stalled agent is a
   * condition rather than work anything may schedule, and giving those an
   * admission would invite an alert rule to read `operator` as "queued behind
   * a person" when it means "the cap is gone".
   *
   * Absent also when no `AdmissionLens` was supplied. That reads as "nobody
   * asked", never as "anything may run": the one direction a missing policy
   * must not quietly move a finding is towards auto.
   */
  admission?: FindingAdmission;
}

/**
 * What `admitProposals` needs that the event log cannot supply.
 *
 * Two files meet here and neither is copied into the other: scheduler.yml says
 * what may run unattended, crosscheck.yml says which words make a change a
 * security surface. `smith scheduler admit` composes exactly this pair, and
 * the watcher has to compose the same one — a watcher that reported `auto` for
 * a proposal the gate holds would be worse than a watcher that said nothing.
 */
export interface AdmissionLens {
  /** scheduler.yml's `autonomy:` block, as `SchedulerPolicy.autonomy` carries it. */
  autonomy: AutonomyPolicy;
  /** crosscheck.yml `plan_quorum.security_keywords`, passed in, never copied. */
  securityKeywords: readonly string[];
}

/**
 * One admission per proposal, positionally — `admitProposals` returns them in
 * the order given, which is the only reason the callers may index alongside
 * their own loop.
 *
 * The claims are folded here rather than passed in because a `RecheckProposal`
 * names a task and no paths: without them the security match sees an opaque id
 * and clears a recheck of `src/auth/session.ts`. They come out of the same
 * `foldTasks` the CLI reads, from the events the caller already holds.
 */
function admitFor(
  proposals: readonly SchedulerProposal[],
  events: readonly StoredEvent[],
  lens: AdmissionLens | undefined,
): (FindingAdmission | undefined)[] {
  if (lens === undefined || proposals.length === 0) return proposals.map(() => undefined);
  const claimsByTask = new Map<string, readonly string[]>();
  for (const task of foldTasks(events)) {
    if (task.claims && task.claims.length > 0) claimsByTask.set(task.taskId, task.claims);
  }
  return admitProposals(proposals, lens.autonomy, {
    securityKeywords: lens.securityKeywords,
    claimsByTask,
  }).map(({ decision, code, reason }) => ({ decision, code, reason }));
}

export interface InspectOptions {
  now?: Date;
  budgetPolicy?: BudgetPolicy;
  schedulerPolicy?: SchedulerPolicy;
  staleHours?: number;
  /** Target repo for the maintenance pass; omitted -> `pnpm outdated` never runs. */
  projectDir?: string;
  /**
   * Who may say yes. Omitted -> findings carry no `admission` at all; see the
   * field's note on why absent must not read as `auto`.
   */
  admission?: AdmissionLens;
}

function staleSubject(agent: AgentRecord): string {
  return agent.taskId ?? agent.epicId ?? agent.agentId ?? agent.id;
}

/**
 * Everything one session's lineage says about itself: spend against the epic
 * cap, dispatches nobody can be billed for, agents that never came back, and
 * completed work the recheck policy says is due another look.
 *
 * Pure — `events` is already-read, `now` is threaded in. The disk work is
 * runTick's.
 */
export function inspectSession(
  sessionId: string,
  events: readonly StoredEvent[],
  opts: InspectOptions = {},
): DaemonFinding[] {
  const now = opts.now ?? new Date();
  const budgetPolicy = opts.budgetPolicy ?? loadBudgetPolicy();
  const schedulerPolicy = opts.schedulerPolicy ?? loadSchedulerPolicy();
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS;
  const findings: DaemonFinding[] = [];

  const budget = checkBudgetAlarm(events, budgetPolicy, { sessionId });
  for (const epic of budget.epics) {
    // `under` is the only status that is an answer rather than a question.
    if (epic.status === 'under') continue;
    findings.push({
      kind: 'budget',
      severity: epic.status === 'unverifiable' ? 'info' : 'attention',
      sessionId,
      subject: epic.epicId,
      // The status leads, and the numbers behind it are budgetAlarm's own
      // sentence — two files describing one spend in two registers is how the
      // daemon and `smith budget` start disagreeing.
      detail: `${epic.status}: ${epic.detail}`,
    });
  }
  if (budget.unattributedDispatches > 0) {
    findings.push({
      kind: 'unattributed-spend',
      severity: 'info',
      sessionId,
      subject: `${budget.unattributedDispatches} dispatch(es)`,
      detail:
        `${budget.unattributedDispatches} dispatch(es) (${budget.unattributedRoles.join(', ')}) ` +
        'name no epic, so their tokens are in no cap. Attribute them or accept that the ' +
        'session total is a floor.',
    });
  }

  for (const agent of detectStale(foldAgents(events), now.toISOString(), staleHours)) {
    findings.push({
      kind: 'stale-agent',
      severity: 'attention',
      sessionId,
      subject: staleSubject(agent),
      detail:
        `${agent.agentRole} (${agent.provider}/${agent.modelTier}) has been live for ` +
        `${agent.liveHours.toFixed(1)}h with no result, error or supersession — past the ` +
        `${staleHours}h threshold. Dispatched ${agent.dispatchedAt}.`,
    });
  }

  // A proposal nobody has answered. `blocking` is the worker's own word for
  // "I cannot go further without this", which makes an unanswered blocking
  // proposal a stalled task and not a queue item — the same split
  // research_request draws.
  //
  // Folded, never staleness-checked: `isStale` reads the plan directory and
  // this function is pure. The daemon's claim is that a decision is
  // outstanding, which stays true whether or not a later version has overtaken
  // the diff; `smith plan proposals` is where that second question is answered.
  for (const proposal of foldSpecChanges(events, { status: 'open' })) {
    findings.push({
      kind: 'spec-change',
      severity: proposal.blocking ? 'attention' : 'info',
      sessionId,
      subject: proposal.taskId,
      detail:
        `${proposal.proposedBy} proposes amending ${proposal.criterionRef}: ${proposal.assumption} ` +
        `(${proposal.severity}, ${proposal.blocking ? 'blocking' : 'non-blocking'}, ` +
        `${proposal.sites.length} site(s)). Answer it with \`smith plan approve ` +
        `${proposal.proposalId}\` or \`smith plan reject ${proposal.proposalId}\`.`,
    });
  }

  const proposals = computeProposals({ events, now, policy: schedulerPolicy });
  const admissions = admitFor(proposals, events, opts.admission);
  for (const [index, proposal] of proposals.entries()) {
    if (proposal.kind !== 'recheck') continue;
    const admission = admissions[index];
    findings.push({
      kind: 'recheck',
      severity: 'info',
      sessionId,
      subject: proposal.taskId,
      detail:
        `Recheck due (${proposal.reasons.join(', ')}): ${proposal.mergeCount} later overlapping ` +
        `merge(s), ${proposal.daysElapsed} day(s) elapsed, confidence ${proposal.confidence}.`,
      ...(admission === undefined ? {} : { admission }),
    });
  }

  return findings;
}

/**
 * The findings that belong to the repo and not to any one session: the growth
 * cadence and the dependency-maintenance pass.
 *
 * Split out of inspectSession deliberately. Both are answered from the whole
 * log, and a cadence attributed to a session is a cadence reported once per
 * session — five open sessions, five identical "growth review due" lines, none
 * of which is about that session.
 */
export function inspectFactory(
  events: readonly StoredEvent[],
  opts: InspectOptions = {},
): DaemonFinding[] {
  const now = opts.now ?? new Date();
  const policy = opts.schedulerPolicy ?? loadSchedulerPolicy();
  const findings: DaemonFinding[] = [];

  const proposals = computeProposals({
    events,
    now,
    policy,
    ...(opts.projectDir === undefined ? {} : { projectDir: opts.projectDir }),
  });

  const admissions = admitFor(proposals, events, opts.admission);

  for (const [index, proposal] of proposals.entries()) {
    const admission = admissions[index];
    if (proposal.kind === 'maintenance') {
      findings.push({
        kind: 'maintenance',
        severity: 'info',
        sessionId: null,
        subject: `${proposal.packages.length} package(s)`,
        detail:
          `${proposal.packages.map((p) => `${p.name} ${p.current}→${p.latest}`).join(', ')} ` +
          `(confidence ${proposal.confidence}, ` +
          `${proposal.autoSchedulable ? 'auto-schedulable' : 'needs an operator'}).`,
        ...(admission === undefined ? {} : { admission }),
      });
    } else if (proposal.kind === 'growth-review-due') {
      findings.push({
        kind: 'growth-review',
        severity: 'info',
        sessionId: null,
        subject: 'growth-review',
        detail:
          `A product-growth review is due on the ${proposal.cadenceDays}-day cadence ` +
          `(last: ${proposal.lastReviewAt ?? 'never'}). The planner reads the living spec; ` +
          'this is the trigger, not the scope.',
        ...(admission === undefined ? {} : { admission }),
      });
    }
    // Rechecks are deliberately dropped here: inspectSession already reports
    // each against the session that owns it, and a second copy with no session
    // is a duplicate an operator cannot act on.
  }

  // The claim this repo rests on, watched instead of waited on. `smith epic
  // width` answers it over all of history the moment somebody types it — and
  // nobody types it, which is the gap a watcher exists to close.
  //
  // Of the NEWEST close only, and that restriction is the whole design.
  // Closes are immutable and the fold covers every one of them, so reporting
  // the fold here would raise the same `attention` every tick forever over an
  // epic nobody can go back and fix. An attention count that cannot return to
  // zero is precisely what the FindingSeverity note above forbids: it teaches
  // an operator to stop reading the number, and takes the real alarms with it.
  // The newest close is a statement about now — it clears itself the moment a
  // wide epic closes, and all of the history stays one command away.
  const width = summariseEpicWidth(events);
  const newest = width.epics[0];
  if (newest !== undefined) {
    if (width.serialized.includes(newest.epicId)) {
      // The summary's own rule, reused rather than restated, so the daemon and
      // `smith epic width` cannot come to disagree about what narrow means.
      findings.push({
        kind: 'factory-width',
        severity: 'attention',
        sessionId: null,
        subject: newest.epicId,
        detail:
          `The last epic this factory closed ran narrow: its widest wave was admitted for ` +
          `${newest.widest.declared} tasks and ${newest.widest.observed} ran ` +
          `(closed ${newest.closedAt}, ${width.serialized.length} of ${width.epics.length} ` +
          'closes read here are narrow). `smith epic width` reads every close back; ' +
          '`smith wave audit --session <id>` reads the waves behind a live one.',
      });
    } else if (width.hint === UNMEASURED_HINT) {
      // Work to schedule, not a fault: nothing here is known to be wrong. What
      // is wrong is that nothing is known, which is a different thing and the
      // reason summariseEpicWidth refuses to let this state exit 0.
      findings.push({
        kind: 'factory-width',
        severity: 'info',
        sessionId: null,
        subject: 'unmeasured',
        detail:
          `${width.epics.length} epic(s) closed here and none recorded how wide it ran. ` +
          UNMEASURED_HINT,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

export interface TickReport {
  at: string;
  /** Lineage leaves inspected, sorted. An ancestor session is covered by its leaf. */
  sessions: string[];
  /** Each finding, dated against what the previous tick remembered. */
  findings: AgedFinding[];
  /** How many findings are `attention` — the number worth looking at. */
  attention: number;
  /**
   * How many `attention` findings this tick is the first to see — the number
   * worth WAKING someone for, as against `attention`, the number worth
   * looking at. A daemon ticking every five minutes reports the same standing
   * alarm 288 times a day, and an operator who has already seen it needs the
   * two counts kept apart to tell today's break from last week's.
   */
  newAttention: number;
  /**
   * How the findings split across the line the operator actually triages on:
   * how many the whitelist would admit, and how many are held for a person.
   *
   * Both are derivable from `findings` — exposed for the same reason
   * `attention` is, so an alert rule need not reimplement the fold and then
   * disagree with the daemon about what it means. Findings no proposal stands
   * behind count in neither: a blown budget is not queued behind anybody.
   *
   * `autoAdmitted` says the policy would allow it, NOT that it ran. The daemon
   * still dispatches nothing.
   */
  autoAdmitted: number;
  /** Findings a scheduler proposal stands behind that the policy holds. */
  operatorHeld: number;
  /** Sessions whose SQLite projection this tick refreshed. */
  projected: number;
}

export interface TickOptions extends InspectOptions {
  stateDir?: string;
  /**
   * What the last tick saw. Omitted, every finding reads as new — which is the
   * right answer for a one-off `--once` run with nothing before it.
   */
  memory?: FindingMemory;
  /** Refresh the read-model for every inspected session (default true). */
  projectDb?: boolean;
  dbPath?: string;
  dbOpts?: DbOpts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One pass over the state directory.
 *
 * Two rules hold it together. It reads every log ONCE and folds lineages in
 * memory, so a five-session lineage reports one budget alarm rather than five
 * (D-119's argument, read from the other end). And no single unreadable log or
 * failed projection ends the tick: both become findings, because a watchdog
 * that dies on the first corrupt line is a watchdog that is silent exactly
 * when something is wrong.
 */
export async function runTick(opts: TickOptions = {}): Promise<TickReport> {
  const now = opts.now ?? new Date();
  const stateDir = opts.stateDir ?? STATE_EVENTS_DIR;
  const findings: DaemonFinding[] = [];

  const logs = new Map<string, StoredEvent[]>();
  for (const sessionId of listSessionIds(stateDir)) {
    try {
      logs.set(sessionId, await readEvents(sessionId, { stateDir }));
    } catch (err) {
      findings.push({
        kind: 'unreadable-log',
        severity: 'attention',
        sessionId,
        subject: `${sessionId}.jsonl`,
        detail: `The log could not be read: ${errorMessage(err)}`,
      });
    }
  }

  const parentOf = new Map<string, string | null>();
  for (const [sessionId, events] of logs) {
    const root = events.find((e) => e.record.event_type === ROOT_EVENT_TYPE);
    const parentEventId = root?.record.causal_parent ?? null;
    let parent: string | null = null;
    if (parentEventId !== null) {
      try {
        parent = parseEventId(parentEventId).sessionId;
      } catch {
        parent = null;
      }
    }
    parentOf.set(sessionId, parent === sessionId ? null : parent);
  }

  const ancestors = new Set<string>();
  for (const parent of parentOf.values()) {
    if (parent !== null && logs.has(parent)) ancestors.add(parent);
  }
  const leaves = [...logs.keys()].filter((id) => !ancestors.has(id)).sort();

  const lineageOf = (leaf: string): SessionLog[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = leaf;
    while (current !== null && logs.has(current) && !seen.has(current)) {
      seen.add(current);
      chain.unshift(current);
      current = parentOf.get(current) ?? null;
    }
    return chain.map((sessionId) => ({ sessionId, events: logs.get(sessionId) ?? [] }));
  };

  // A tick reports the admission line by default, where `inspectSession` and
  // `inspectFactory` stay silent unless asked. The asymmetry is deliberate: a
  // caller who reaches for one function is answering their own question and
  // may not want two policy files read, whereas the whole point of a tick is
  // to be the surface nobody is watching — a status file that omitted the one
  // column saying whose queue a finding is in would be omitting it precisely
  // when it matters. Reading policy here also fails loudly at the top of the
  // tick rather than silently downgrading a finding to unadmitted.
  const admission = opts.admission ?? {
    autonomy: (opts.schedulerPolicy ?? loadSchedulerPolicy()).autonomy,
    securityKeywords: loadCrosscheckPolicy().planQuorum.securityKeywords,
  };

  const inspectOpts: InspectOptions = {
    now,
    admission,
    ...(opts.budgetPolicy === undefined ? {} : { budgetPolicy: opts.budgetPolicy }),
    ...(opts.schedulerPolicy === undefined ? {} : { schedulerPolicy: opts.schedulerPolicy }),
    ...(opts.staleHours === undefined ? {} : { staleHours: opts.staleHours }),
    ...(opts.projectDir === undefined ? {} : { projectDir: opts.projectDir }),
  };

  const projectDb = opts.projectDb ?? true;
  const dbPath = opts.dbPath ?? STATE_DB_PATH;
  const dbOpts: DbOpts = { stateDir, ...opts.dbOpts };
  let projected = 0;

  for (const leaf of leaves) {
    findings.push(...inspectSession(leaf, mergeSessionLogs(lineageOf(leaf)), inspectOpts));
    if (!projectDb) continue;
    try {
      await apply(dbPath, leaf, dbOpts);
      projected += 1;
    } catch (err) {
      findings.push({
        kind: 'projection-failed',
        severity: 'attention',
        sessionId: leaf,
        subject: dbPath,
        detail:
          `The read-model refresh failed: ${errorMessage(err)}. The event log is unaffected — ` +
          'it is the UI and `smith status` that are now stale.',
      });
    }
  }

  // The factory-wide pass only means anything once there is a factory to
  // review; an empty state dir must produce an empty tick, not a cadence
  // reminder about work that has never started.
  if (leaves.length > 0) {
    const all = [...logs.entries()].map(([sessionId, events]) => ({ sessionId, events }));
    findings.push(...inspectFactory(mergeSessionLogs(all), inspectOpts));
  }

  const aged = ageFindings(opts.memory ?? {}, findings, now);
  return {
    at: now.toISOString(),
    sessions: leaves,
    findings: aged,
    attention: aged.filter((f) => f.severity === 'attention').length,
    newAttention: aged.filter((f) => f.severity === 'attention' && f.isNew).length,
    autoAdmitted: aged.filter((f) => f.admission?.decision === 'auto').length,
    operatorHeld: aged.filter((f) => f.admission?.decision === 'operator').length,
    projected,
  };
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

export interface DaemonLock {
  pid: number;
  startedAt: string;
  intervalSeconds: number;
}

export function lockPath(dir: string): string {
  return path.join(dir, LOCK_FILE);
}

export function statusPath(dir: string): string {
  return path.join(dir, STATUS_FILE);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readLock(dir: string): DaemonLock | null {
  const lock = readJsonFile<DaemonLock>(lockPath(dir));
  if (lock === null || typeof lock.pid !== 'number') return null;
  return lock;
}

/** `kill(pid, 0)` — EPERM means a process exists that this user may not signal. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claim `dir` for `lock.pid`, returning the lock this one displaced (null when
 * there was nothing to displace, or nothing readable).
 *
 * Two daemons ticking the same state dir would double every projection write
 * and every finding, so a live incumbent is refused. A DEAD incumbent is not:
 * a crashed daemon leaves its pid file behind, and refusing to start until a
 * human runs `rm` would make the first crash permanent. Likewise an
 * unparseable file — half a JSON document is what a crash mid-write looks
 * like, and it is evidence of a dead writer, not a live one.
 */
export function acquireLock(
  dir: string,
  lock: DaemonLock,
  opts: { isAlive?: (pid: number) => boolean } = {},
): DaemonLock | null {
  const isAlive = opts.isAlive ?? processIsAlive;
  mkdirSync(dir, { recursive: true });
  const file = lockPath(dir);
  const body = `${JSON.stringify(lock, null, 2)}\n`;

  try {
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const incumbent = readLock(dir);
  if (incumbent !== null && isAlive(incumbent.pid)) {
    throw new DaemonError(
      'daemon.already-running',
      `A daemon (pid ${incumbent.pid}, started ${incumbent.startedAt}) already holds ${file}. ` +
        'Stop it with `smith daemon stop` before starting another.',
      { pid: incumbent.pid, lock_path: file },
    );
  }
  writeFileSync(file, body, 'utf8');
  return incumbent;
}

/** True when this call removed the lock; false when it belongs to someone else. */
export function releaseLock(dir: string, pid: number): boolean {
  const lock = readLock(dir);
  if (lock === null || lock.pid !== pid) return false;
  rmSync(lockPath(dir), { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// The status file
// ---------------------------------------------------------------------------

/** tmp-then-rename, so a reader polling this file never sees half a document. */
export function writeStatus(dir: string, report: TickReport): void {
  mkdirSync(dir, { recursive: true });
  const target = statusPath(dir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

export function readStatus(dir: string): TickReport | null {
  return readJsonFile<TickReport>(statusPath(dir));
}

// ---------------------------------------------------------------------------
// The finding memory
// ---------------------------------------------------------------------------

export function memoryPath(dir: string): string {
  return path.join(dir, MEMORY_FILE);
}

/**
 * The only state this daemon carries across ticks, and deliberately the least
 * it could carry: identity -> when it was first seen.
 *
 * Missing or corrupt reads as empty rather than throwing, for the same reason
 * `unreadable-log` is a finding and not a crash. A watchdog that dies over its
 * own scratch file is silent exactly when something is wrong, and the cost of
 * losing this one is a single tick that calls every standing finding new.
 */
export function readFindingMemory(dir: string): FindingMemory {
  return readJsonFile<FindingMemory>(memoryPath(dir)) ?? {};
}

/** tmp-then-rename, like the status file: a half-written memory reads as none. */
export function writeFindingMemory(dir: string, memory: FindingMemory): void {
  mkdirSync(dir, { recursive: true });
  const target = memoryPath(dir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

/**
 * How long a daemon may go quiet before the silence is itself the finding.
 *
 * Three intervals is the miss-two-heartbeats rule: one late tick is a slow fold
 * of a long log, two in a row is a fault. The floor is there because a tick's
 * cost is not proportional to the interval -- folding the event log takes what
 * it takes -- so `--interval 1` would otherwise report a daemon as wedged for
 * doing exactly the work it was told to do too often.
 */
const STALE_INTERVALS = 3;
const STALE_FLOOR_SECONDS = 60;

function staleToleranceSeconds(lock: DaemonLock): number {
  // D-21: a report that only states a fact must not crash over that fact, and a
  // hand-edited pid file is a bad lock rather than a reason to have no status.
  const interval =
    typeof lock.intervalSeconds === 'number' && lock.intervalSeconds > 0
      ? lock.intervalSeconds
      : DEFAULT_INTERVAL_SECONDS;
  return Math.max(interval * STALE_INTERVALS, STALE_FLOOR_SECONDS);
}

/** Seconds since `iso`, or null when there is no readable timestamp to date. */
function ageSeconds(now: Date, iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.round((now.getTime() - then) / 1000);
}

export interface DaemonStatusReport {
  /** A process holds the lock and answers `kill -0`. Not the same as watching. */
  running: boolean;
  /**
   * A daemon holds the lock and has published nothing within its own interval
   * budget -- the wedged watcher, which `running` alone cannot see, because a
   * daemon stuck mid-tick still answers `kill -0` exactly like a healthy one.
   *
   * Measured against the freshest evidence of life: the last tick, or the
   * lock's `startedAt` when there is no tick yet. So a daemon three seconds old
   * is not stale for having published nothing, and one that started an hour ago
   * and still has not published is -- which is the wedge a status file cannot
   * show, precisely because the wedge is what stopped the file existing.
   *
   * False when nothing is running. `running: false` is the sharper statement,
   * and a flag that also meant "nobody is home" would carry two readings.
   */
  stale: boolean;
  dir: string;
  lock: DaemonLock | null;
  lastTick: TickReport | null;
  /**
   * Seconds between the last published tick and now -- null when nothing has
   * ever ticked, which is NOT zero: zero is a real age and would read as "it
   * just ticked", the one claim a daemon that has published nothing must not
   * be able to make.
   *
   * Reported whether or not anything holds the lock, because a reader of
   * `status.json` has to know how much to trust what it just read regardless
   * of who wrote it or whether that writer is still alive.
   */
  reportAgeSeconds: number | null;
}

export function daemonStatus(
  dir: string,
  opts: { isAlive?: (pid: number) => boolean; now?: Date } = {},
): DaemonStatusReport {
  const isAlive = opts.isAlive ?? processIsAlive;
  const now = opts.now ?? new Date();
  const lock = readLock(dir);
  const lastTick = readStatus(dir);
  const running = lock !== null && isAlive(lock.pid);
  const reportAge = ageSeconds(now, lastTick?.at);

  // The freshest thing this daemon is known to have done. `min` rather than the
  // tick alone: a daemon that restarted after a long quiet spell has done
  // something more recent than its predecessor's last report, and dating it
  // from that report would alarm on a watcher that is two seconds old.
  const lockAge = lock === null ? null : ageSeconds(now, lock.startedAt);
  const ages = [reportAge, lockAge].filter((a): a is number => a !== null);
  const quietFor = ages.length === 0 ? null : Math.min(...ages);

  return {
    running,
    stale: running && lock !== null && quietFor !== null && quietFor > staleToleranceSeconds(lock),
    dir,
    lock,
    lastTick,
    reportAgeSeconds: reportAge,
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface RunDaemonOptions extends TickOptions {
  dir: string;
  intervalSeconds?: number;
  /** One tick, then exit — what `smith daemon run --once` and cron both want. */
  once?: boolean;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean;
  /** Injection seam: the loop's contract is what it does AROUND a tick. */
  tick?: (opts: TickOptions) => Promise<TickReport>;
}

/**
 * Deliberately NOT unref'd. An unref'd timer lets node decide the event loop
 * is empty and exit mid-sleep — skipping the `finally` below, and leaving a
 * lock behind naming a pid that is already gone.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Hold the lock, tick, publish, repeat.
 *
 * The `finally` is the point of the whole function: a loop that exits still
 * holding its lock — because a tick threw, because the operator hit ^C — is a
 * loop nothing can restart without a human deleting a file.
 */
export async function runDaemon(opts: RunDaemonOptions): Promise<TickReport[]> {
  const pid = opts.pid ?? process.pid;
  const intervalSeconds = opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const startedAt = (opts.now ?? new Date()).toISOString();
  const tick = opts.tick ?? runTick;
  const sleep = opts.sleep ?? defaultSleep;
  const shouldContinue = opts.shouldContinue ?? ((): boolean => true);

  acquireLock(
    opts.dir,
    { pid, startedAt, intervalSeconds },
    opts.isAlive === undefined ? {} : { isAlive: opts.isAlive },
  );

  const tickOptions: TickOptions = {
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.budgetPolicy === undefined ? {} : { budgetPolicy: opts.budgetPolicy }),
    ...(opts.schedulerPolicy === undefined ? {} : { schedulerPolicy: opts.schedulerPolicy }),
    ...(opts.staleHours === undefined ? {} : { staleHours: opts.staleHours }),
    ...(opts.projectDir === undefined ? {} : { projectDir: opts.projectDir }),
    ...(opts.stateDir === undefined ? {} : { stateDir: opts.stateDir }),
    ...(opts.projectDb === undefined ? {} : { projectDb: opts.projectDb }),
    ...(opts.dbPath === undefined ? {} : { dbPath: opts.dbPath }),
    ...(opts.dbOpts === undefined ? {} : { dbOpts: opts.dbOpts }),
  };

  // Read from disk rather than held in a variable, so a daemon restarted by
  // cron or by the operator picks up where the last process stopped. A tick
  // knows nothing about the interval it runs on; this is what joins two.
  const tickWithMemory = async (): Promise<TickReport> => {
    const report = await tick({ ...tickOptions, memory: readFindingMemory(opts.dir) });
    writeStatus(opts.dir, report);
    writeFindingMemory(opts.dir, memoryOf(report.findings));
    return report;
  };

  const reports: TickReport[] = [];
  try {
    if (opts.once === true) {
      reports.push(await tickWithMemory());
      return reports;
    }
    while (shouldContinue()) {
      reports.push(await tickWithMemory());
      await sleep(intervalSeconds * 1000);
    }
    return reports;
  } finally {
    releaseLock(opts.dir, pid);
  }
}

/**
 * SIGTERM the process the lock names, then clear the file.
 *
 * `stopped` answers "did this call signal a running daemon", so a stale lock
 * left by a crash reports `stopped: false` with the pid it cleared — the
 * operator learns the daemon was already gone rather than being told it was
 * just stopped.
 */
export function stopDaemon(
  dir: string,
  opts: { isAlive?: (pid: number) => boolean; kill?: (pid: number) => void } = {},
): { stopped: boolean; pid: number | null } {
  const isAlive = opts.isAlive ?? processIsAlive;
  const kill =
    opts.kill ??
    ((pid: number): void => {
      process.kill(pid, 'SIGTERM');
    });
  const lock = readLock(dir);
  if (lock === null) return { stopped: false, pid: null };

  const alive = isAlive(lock.pid);
  if (alive) kill(lock.pid);
  rmSync(lockPath(dir), { force: true });
  return { stopped: alive, pid: lock.pid };
}

/** Where `smith daemon` keeps its lock and its last tick, when nobody says otherwise. */
export const DEFAULT_DAEMON_DIR = STATE_DAEMON_DIR;
