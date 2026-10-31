import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SmithError } from './errors.js';
import { appendEvent, type EventInput, type EventOpts, type StoredEvent } from './events.js';
import { pidIsAlive } from './heavyLock.js';
import { CHECK_TIERS, type CheckCommand, type CheckTier, commandDigest } from './testgate.js';
import { excludeFromGit } from './workroot.js';

// ---------------------------------------------------------------------------
// The learned-tier overlay (epic bs-check-tiers, spec D8).
//
// What bs learns about a check's tier lives in `<project-root>/.blacksmith/
// check-tiers.json`, a file bs owns and git never sees. The project's own
// checks file is the operator's declaration and is never opened for writing
// here. The event log is the source of truth; this file is its local
// materialisation, which the gate can read without the event store.
// ---------------------------------------------------------------------------

export class OverlayError extends SmithError {}

const OVERLAY_DIR = '.blacksmith';
const OVERLAY_FILE = 'check-tiers.json';
const LOCK_FILE = 'check-tiers.lock';
const TEMP_FILE = 'check-tiers.json.tmp';
// One pattern for everything bs keeps in .blacksmith/: the overlay, its temp, the
// lock and its reclaim mutex, so a crash leaves none of them visible to git.
const EXCLUDE_PATTERN = 'check-tiers.*';
const PROMOTED_EVENT = 'check-tier-promoted';
const DECIDED_EVENT = 'check-tier-decided';

/** How often a waiting writer looks at the lock again. */
export const OVERLAY_LOCK_POLL_MS = 100;

/**
 * How long a writer waits for the lock. Every holder keeps it for one
 * reconcile plus one atomic overlay write and a few event appends: milliseconds
 * on a quiet machine and seconds on a loaded one. 30 s outlasts any live
 * holder, so only a hung one makes a waiter give up. A lock left by a dead pid
 * is broken at once and never waited on.
 */
export const OVERLAY_LOCK_WAIT_MS = 30000;

export interface PendingEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

export interface OverlayEntry {
  check: string;
  cmd_sha256: string;
  tier: CheckTier;
  decided_by_event_id: string;
  decided_at: string;
  pending_event?: PendingEvent;
}

export interface OverlayState {
  revision: number;
  entries: OverlayEntry[];
}

export type OverlayRead = OverlayState | { unreadable: string };

export type OverlayWritable = 'ok' | 'not-a-repo' | 'tracked' | 'unreadable';

export type TierSource = 'declared' | 'overlay' | 'default';

export type OverlayReportStatus = 'active' | 'shadowed' | 'orphaned';

export interface OverlayReportItem {
  check: string;
  cmd_sha256: string;
  tier: CheckTier;
  status: OverlayReportStatus;
}

export interface OverlayOwes {
  /** Entries the log implies and the overlay lacks (to add or to correct). */
  missing: OverlayEntry[];
  /** Entries whose `pending_event` the log does not hold yet: append, then clear. */
  pending: OverlayEntry[];
  /** Entries whose `pending_event` the log already holds: clear only. */
  settled: OverlayEntry[];
}

export interface WriteOverlayOpts {
  /** Test seam: runs after the temp file is written and before the rename. */
  beforeRename?: () => void;
}

export interface ReconcileCtx {
  session_id: string;
  actor: string;
  plan_version: number;
  causal_parent: string | null;
}

export interface ReconcileOpts extends WriteOverlayOpts {
  events?: EventOpts;
}

/** The variables that make git look at a repository other than the one `cwd` is in. */
const GIT_LOCATING_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'] as const;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const v of GIT_LOCATING_VARS) delete env[v];
  return env;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The overlay file of the repository holding `dir`: always under the main
 * worktree, which is git's own answer: the first entry of `git worktree list`.
 * Null outside a git repository and when that entry is not a work tree (a bare
 * repository's entry is not one). A layout whose git dir records its work tree
 * elsewhere (a `--separate-git-dir` copy, a submodule) makes git list the git
 * dir or its parent first: git must call the entry a work tree, and from the main worktree
 * itself the entry must be the top level git reports. One layout stays
 * ambiguous for git too: seen from a linked worktree, a `--separate-git-dir`
 * named `.git` looks like an ordinary clone's directory.
 */
export function overlayPath(dir: string): string | null {
  try {
    const [first = ''] = git(dir, ['worktree', 'list', '--porcelain']).split('\n\n');
    const root = realpathSync((first.split('\n')[0] ?? '').slice('worktree '.length));
    if (git(root, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
    const [own = '', common = ''] = git(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
      '--git-common-dir',
    ])
      .trim()
      .split('\n');
    if (
      own === common &&
      realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim()) !== root
    ) {
      return null;
    }
    return path.join(root, OVERLAY_DIR, OVERLAY_FILE);
  } catch {
    return null;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  const key = Object.keys(obj).find((k) => !allowed.includes(k));
  return key === undefined ? null : key;
}

function pendingViolation(pe: unknown, at: string): string | null {
  if (!isObject(pe)) return `${at}.pending_event must be an object`;
  const extra = unknownKey(pe, ['event_type', 'payload']);
  if (extra !== null) return `${at}.pending_event has unknown key "${extra}"`;
  if (pe.event_type !== PROMOTED_EVENT) {
    return `${at}.pending_event.event_type must be "${PROMOTED_EVENT}"`;
  }
  if (!isObject(pe.payload)) return `${at}.pending_event.payload must be an object`;
  return null;
}

function entryViolation(e: unknown, at: string): string | null {
  if (!isObject(e)) return `${at} must be an object`;
  const extra = unknownKey(e, [
    'check',
    'cmd_sha256',
    'tier',
    'decided_by_event_id',
    'decided_at',
    'pending_event',
  ]);
  if (extra !== null) return `${at} has unknown key "${extra}"`;
  if (typeof e.check !== 'string' || e.check === '')
    return `${at}.check must be a non-empty string`;
  if (typeof e.cmd_sha256 !== 'string' || !HEX64.test(e.cmd_sha256)) {
    return `${at}.cmd_sha256 must be 64 lowercase hex characters`;
  }
  if (!CHECK_TIERS.includes(e.tier as CheckTier)) {
    return `${at}.tier must be one of ${CHECK_TIERS.join(', ')}`;
  }
  if (typeof e.decided_by_event_id !== 'string' || e.decided_by_event_id === '') {
    return `${at}.decided_by_event_id must be a non-empty string`;
  }
  if (
    typeof e.decided_at !== 'string' ||
    !ISO_TIME.test(e.decided_at) ||
    Number.isNaN(Date.parse(e.decided_at))
  ) {
    return `${at}.decided_at must be an ISO-8601 time`;
  }
  return e.pending_event === undefined ? null : pendingViolation(e.pending_event, at);
}

/** The first rule a parsed overlay breaks, or null when it is valid. */
function violation(doc: unknown): string | null {
  if (!isObject(doc)) return 'the overlay must be a JSON object';
  const extra = unknownKey(doc, ['version', 'revision', 'entries']);
  if (extra !== null) return `the overlay has unknown key "${extra}"`;
  if (doc.version !== 1) return 'version must be 1';
  if (!Number.isInteger(doc.revision) || (doc.revision as number) < 0) {
    return 'revision must be a non-negative integer';
  }
  if (!Array.isArray(doc.entries)) return 'entries must be an array';
  const seen = new Set<string>();
  for (const [i, e] of doc.entries.entries()) {
    const bad = entryViolation(e, `entries[${i}]`);
    if (bad !== null) return bad;
    const key = `${e.check}\u0000${e.cmd_sha256}`;
    if (seen.has(key)) {
      return `entries[${i}] repeats check "${e.check}" with the same cmd_sha256`;
    }
    seen.add(key);
  }
  return null;
}

/**
 * Read the overlay of the repository holding `dir`. Absent (or no repository)
 * is empty at revision 0; an invalid file is `{unreadable: <first violation>}`.
 * Never throws.
 */
export function readOverlay(dir: string): OverlayRead {
  const file = overlayPath(dir);
  if (file === null || !existsSync(file)) return { revision: 0, entries: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { unreadable: `the overlay is not valid JSON (${(err as Error).message})` };
  }
  const bad = violation(doc);
  if (bad !== null) return { unreadable: bad };
  const { revision, entries } = doc as OverlayState;
  return { revision, entries };
}

function isTracked(root: string, file: string): boolean {
  try {
    git(root, ['ls-files', '--error-unmatch', '--', file]);
    return true;
  } catch {
    return false;
  }
}

/** `ok`, or why a write would be refused. */
export function overlayWritable(dir: string): OverlayWritable {
  const file = overlayPath(dir);
  if (file === null) return 'not-a-repo';
  if (isTracked(path.dirname(path.dirname(file)), file)) return 'tracked';
  return 'unreadable' in readOverlay(dir) ? 'unreadable' : 'ok';
}

function notARepo(dir: string): OverlayError {
  return new OverlayError(
    'checks.overlay-not-a-repo',
    `"${dir}" is not inside a git repository, so there is no tier overlay to write.`,
    { dir },
  );
}

/**
 * Write the overlay at `expectedRevision + 1`, atomically (temp sibling, then
 * rename). Call it inside `withOverlayLock`, with the revision read there.
 * Refuses a location that is not a repository, is tracked, is unreadable or
 * cannot be excluded from git, and a file whose revision moved.
 */
export function writeOverlay(
  dir: string,
  next: { entries: OverlayEntry[]; expectedRevision: number },
  opts: WriteOverlayOpts = {},
): OverlayState {
  const file = overlayPath(dir);
  if (file === null) throw notARepo(dir);
  const root = path.dirname(path.dirname(file));
  if (isTracked(root, file)) {
    throw new OverlayError(
      'checks.overlay-tracked',
      `${file} is tracked by git; bs never edits a tracked file.`,
      { file },
    );
  }
  const current = readOverlay(dir);
  if ('unreadable' in current) {
    throw new OverlayError(
      'checks.overlay-unreadable',
      `${file} is unreadable: ${current.unreadable}. Fix or remove it first.`,
      { file, reason: current.unreadable },
    );
  }
  if (current.revision !== next.expectedRevision) {
    throw new OverlayError(
      'checks.overlay-moved',
      `${file} is at revision ${current.revision}, not the ${next.expectedRevision} this write read.`,
      { file, revision: current.revision, expected: next.expectedRevision },
    );
  }
  const invalid = violation({
    version: 1,
    revision: next.expectedRevision + 1,
    entries: next.entries,
  });
  if (invalid !== null) {
    throw new OverlayError(
      'checks.overlay-invalid',
      `Refusing to write ${file}: ${invalid}. Nothing was written.`,
      { file, reason: invalid },
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  // excludeFromGit spawns git synchronously with the ambient environment, so the
  // locating variables are removed from it for that one call and put back.
  const saved = GIT_LOCATING_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of GIT_LOCATING_VARS) delete process.env[v];
  let excluded: ReturnType<typeof excludeFromGit>;
  try {
    excluded = excludeFromGit(root, path.join(path.dirname(file), EXCLUDE_PATTERN));
  } finally {
    for (const [v, val] of saved) if (val !== undefined) process.env[v] = val;
  }
  if (excluded === 'tracked') {
    throw new OverlayError('checks.overlay-tracked', `${file} is tracked by git.`, { file });
  }
  if (excluded !== 'added' && excluded !== 'already-ignored') {
    throw new OverlayError(
      'checks.overlay-exclude-failed',
      `Could not keep ${file} out of git (${excluded}); nothing was written.`,
      { file, result: excluded },
    );
  }
  const state: OverlayState = { revision: next.expectedRevision + 1, entries: next.entries };
  const temp = path.join(path.dirname(file), TEMP_FILE);
  writeFileSync(temp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
  opts.beforeRename?.();
  renameSync(temp, file);
  return state;
}

// The lock: `check-tiers.lock` created with `wx`, whose whole content is the
// holder's pid. A lock whose pid is dead is removed under a short `wx` mutex and
// only while it still holds that same pid (the rule heavyLock.ts uses); a live
// pid's lock, this process's included, is never broken. A lock whose content is
// not a pid, or that cannot be read, is refused and never broken.

/** The largest pid a platform hands out (a 32-bit signed integer). */
const MAX_PID = 2147483647;

function lockRefused(file: string, why: string): OverlayError {
  return new OverlayError(
    'checks.overlay-lock-unusable',
    `${file} ${why}; nothing was written. Check no bs process is using it, then remove it.`,
    { file },
  );
}

/** The pid a lock file holds, or null when it is absent. Anything unreadable is refused. */
function readHolder(file: string): number | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw lockRefused(file, `could not be read (${code ?? (err as Error).message})`);
  }
  const m = /^(\d+)\n$/.exec(text);
  const pid = m === null ? Number.NaN : Number(m[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) {
    throw lockRefused(file, 'does not hold a pid');
  }
  return pid;
}

/** Remove `file`, which may already be gone. */
function unlinkIfPresent(file: string): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Create the lock holding this pid; false when it exists. */
function createLock(lock: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw lockRefused(lock, `could not be created (${code ?? (err as Error).message})`);
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch (err) {
    unlinkIfPresent(lock);
    throw err;
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Remove the lock of dead holder `pid`, only while it still holds `pid`, under a
 * short mutex so two breakers cannot both win. False when the mutex is taken.
 */
function reclaim(lock: string, pid: number): boolean {
  const mutex = `${lock}.reclaim`;
  let fd: number;
  try {
    fd = openSync(mutex, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw lockRefused(mutex, `could not be created (${(err as NodeJS.ErrnoException).code})`);
  }
  try {
    if (readHolder(lock) === pid) unlinkIfPresent(lock);
  } finally {
    closeSync(fd);
    unlinkIfPresent(mutex);
  }
  return true;
}

/** Take the lock now (null), or return the pid to wait for. */
function tryAcquire(lock: string): number | null {
  for (;;) {
    if (createLock(lock)) return null;
    const holder = readHolder(lock);
    if (holder === null) continue;
    if (pidIsAlive(holder) || !reclaim(lock, holder)) return holder;
  }
}

/** Remove the lock only while it still holds this process's pid. */
function release(lock: string): void {
  if (readHolder(lock) === process.pid) unlinkIfPresent(lock);
}

/**
 * Run `fn` as the only writer of the overlay of the repository holding `dir`.
 * Call it only when you may write; it creates `.blacksmith/` when absent and
 * leaves no lock file behind. A lock whose pid is dead is broken; a live one
 * (this process included) is waited for up to `waitMs`, then `checks.overlay-busy`.
 */
export async function withOverlayLock<T>(
  dir: string,
  fn: () => Promise<T> | T,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const file = overlayPath(dir);
  if (file === null) throw notARepo(dir);
  const waitMs = opts.waitMs ?? OVERLAY_LOCK_WAIT_MS;
  const lock = path.join(path.dirname(file), LOCK_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const holder = tryAcquire(lock);
    if (holder === null) break;
    if (Date.now() >= deadline) {
      throw new OverlayError(
        'checks.overlay-busy',
        `${lock} is held by pid ${holder}; gave up after ${waitMs} ms. Nothing was written.`,
        { lock, holder, wait_ms: waitMs },
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, OVERLAY_LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    release(lock);
  }
}

/**
 * Each check's effective tier: its declared one; else the overlay entry with
 * the same name and command digest; else `pre-merge`. An unreadable overlay
 * fills nothing, so a check never lands in a later tier by accident.
 */
export function resolveEffectiveTiers(
  checks: readonly CheckCommand[],
  overlay: OverlayRead,
): (CheckCommand & { tier: CheckTier; tierSource: TierSource })[] {
  return checks.map((c) => {
    if (c.tier !== undefined) return { ...c, tier: c.tier, tierSource: 'declared' };
    const hit =
      'entries' in overlay
        ? overlay.entries.find((e) => e.check === c.name && e.cmd_sha256 === commandDigest(c.cmd))
        : undefined;
    return hit === undefined
      ? { ...c, tier: 'pre-merge', tierSource: 'default' }
      : { ...c, tier: hit.tier, tierSource: 'overlay' };
  });
}

/** One status per overlay entry, by D8's single precedence. */
export function overlayReport(
  checks: readonly CheckCommand[],
  overlay: OverlayRead,
): OverlayReportItem[] {
  if (!('entries' in overlay)) return [];
  return overlay.entries.map((e) => {
    const check = checks.find((c) => c.name === e.check);
    let status: OverlayReportStatus = 'active';
    if (check === undefined) status = 'orphaned';
    else if (check.tier !== undefined) status = 'shadowed';
    else if (commandDigest(check.cmd) !== e.cmd_sha256) status = 'orphaned';
    return { check: e.check, cmd_sha256: e.cmd_sha256, tier: e.tier, status };
  });
}

const entryKey = (check: string, cmd: string): string => `${check}\u0000${cmd}`;

/** The tier each (check, command) ends in according to the approved events, in log order. */
function impliedEntries(events: readonly StoredEvent[]): Map<string, OverlayEntry> {
  const implied = new Map<string, OverlayEntry>();
  for (const { event_id, record } of events) {
    const p = record.payload;
    const decided = record.event_type === DECIDED_EVENT && p.decision === 'approve';
    if (!decided && record.event_type !== PROMOTED_EVENT) continue;
    const next = {
      check: p.check,
      cmd_sha256: p.cmd_sha256,
      tier: p.to_tier,
      decided_by_event_id: event_id,
      decided_at: record.ts,
    };
    // The rules readOverlay applies: an event that would make the file unreadable is skipped.
    if (entryViolation(next, 'event') !== null) continue;
    implied.set(entryKey(next.check as string, next.cmd_sha256 as string), next as OverlayEntry);
  }
  return implied;
}

/**
 * What the log and the overlay still owe each other. Pure. An entry carrying a
 * `pending_event` is ahead of the log (a promotion writes the overlay first),
 * so it is never overwritten from the log. An unreadable overlay owes nothing.
 */
export function overlayOwes(overlay: OverlayRead, events: readonly StoredEvent[]): OverlayOwes {
  const owes: OverlayOwes = { missing: [], pending: [], settled: [] };
  if (!('entries' in overlay)) return owes;
  const have = new Map(overlay.entries.map((e) => [entryKey(e.check, e.cmd_sha256), e]));
  for (const [key, want] of impliedEntries(events)) {
    const got = have.get(key);
    if (got === undefined || (got.tier !== want.tier && got.pending_event === undefined)) {
      owes.missing.push(want);
    }
  }
  for (const e of overlay.entries) {
    const pe = e.pending_event;
    if (pe === undefined) continue;
    const logged = events.some(
      (ev) =>
        ev.record.event_type === pe.event_type && isDeepStrictEqual(ev.record.payload, pe.payload),
    );
    (logged ? owes.settled : owes.pending).push(e);
  }
  return owes;
}

function strippedOf(e: OverlayEntry): OverlayEntry {
  const { pending_event: _drop, ...rest } = e;
  return rest;
}

/**
 * Inside the lock: re-read the overlay and write exactly what `overlayOwes`
 * reports. A promotion's overlay write comes before its event, so the event is
 * appended here as stored, once, and `pending_event` cleared after each append.
 */
export async function reconcileOverlay(
  dir: string,
  events: readonly StoredEvent[],
  ctx: ReconcileCtx,
  opts: ReconcileOpts = {},
): Promise<void> {
  const read = (): OverlayState => {
    const o = readOverlay(dir);
    return 'entries' in o ? o : { revision: 0, entries: [] };
  };
  const owes = overlayOwes(readOverlay(dir), events);
  let state = read();
  const store = (entries: OverlayEntry[]): void => {
    state = writeOverlay(dir, { entries, expectedRevision: state.revision }, opts);
  };
  if (owes.missing.length > 0) {
    const replaced = new Set(owes.missing.map((e) => entryKey(e.check, e.cmd_sha256)));
    store([
      ...state.entries.filter((e) => !replaced.has(entryKey(e.check, e.cmd_sha256))),
      ...owes.missing,
    ]);
  }
  const clear = (e: OverlayEntry): void =>
    store(
      state.entries.map((x) =>
        x.check === e.check && x.cmd_sha256 === e.cmd_sha256 ? strippedOf(x) : x,
      ),
    );
  for (const e of owes.settled) clear(e);
  for (const e of owes.pending) {
    const input: EventInput = { ...ctx, ...(e.pending_event as PendingEvent) };
    await appendEvent(input, opts.events);
    clear(e);
  }
}
