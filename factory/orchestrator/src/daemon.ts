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
import { checkBudgetAlarm } from './budgetAlarm.js';
import { type BudgetPolicy, loadBudgetPolicy } from './budgets.js';
import type { DbOpts } from './db/projector.js';
import { apply } from './db/projector.js';
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
import { computeProposals, loadSchedulerPolicy, type SchedulerPolicy } from './scheduler.js';
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
  | 'unreadable-log'
  | 'projection-failed';

/**
 * `attention` means something is wrong now; `info` means there is work to
 * schedule. The split exists so an operator can treat a non-zero attention
 * count as a reason to look — which stops being true the moment a routine
 * cadence tick is filed under the same word.
 */
export type FindingSeverity = 'info' | 'attention';

export interface DaemonFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** null when the finding belongs to the repo rather than to one session. */
  sessionId: string | null;
  subject: string;
  detail: string;
}

export interface InspectOptions {
  now?: Date;
  budgetPolicy?: BudgetPolicy;
  schedulerPolicy?: SchedulerPolicy;
  staleHours?: number;
  /** Target repo for the maintenance pass; omitted -> `pnpm outdated` never runs. */
  projectDir?: string;
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

  for (const proposal of computeProposals({ events, now, policy: schedulerPolicy })) {
    if (proposal.kind !== 'recheck') continue;
    findings.push({
      kind: 'recheck',
      severity: 'info',
      sessionId,
      subject: proposal.taskId,
      detail:
        `Recheck due (${proposal.reasons.join(', ')}): ${proposal.mergeCount} later overlapping ` +
        `merge(s), ${proposal.daysElapsed} day(s) elapsed, confidence ${proposal.confidence}.`,
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

  for (const proposal of proposals) {
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
      });
    }
    // Rechecks are deliberately dropped here: inspectSession already reports
    // each against the session that owns it, and a second copy with no session
    // is a duplicate an operator cannot act on.
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

  const inspectOpts: InspectOptions = {
    now,
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

export interface DaemonStatusReport {
  running: boolean;
  dir: string;
  lock: DaemonLock | null;
  lastTick: TickReport | null;
}

export function daemonStatus(
  dir: string,
  opts: { isAlive?: (pid: number) => boolean } = {},
): DaemonStatusReport {
  const isAlive = opts.isAlive ?? processIsAlive;
  const lock = readLock(dir);
  return {
    running: lock !== null && isAlive(lock.pid),
    dir,
    lock,
    lastTick: readStatus(dir),
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
