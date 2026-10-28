import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SmithError } from './errors.js';

/** The holder record stored in `<lockDir>/heavy.lock`. */
export interface HeavyLockRecord {
  pid: number;
  token: string;
  label: string;
  startedAt: string;
  cwd: string;
}

/** What `fn` receives: the token it runs under and the resolved lock dir. */
export interface HeavyLease {
  token: string;
  lockDir: string;
}

export interface HeavyLockOptions {
  lockDir?: string;
  label: string;
  cwd: string;
  pollMs?: number;
  maxWaitMs?: number;
  isPidAlive?: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
}

const LOCK_FILE = 'heavy.lock';
const RECLAIM_FILE = 'heavy.lock.reclaim';
const RECLAIM_BREAK_MS = 10_000;
const DEFAULT_POLL_MS = 2000;
export const DEFAULT_MAX_WAIT_MS = 3_600_000;

/**
 * A pid is dead only when `kill(pid, 0)` throws `ESRCH`; `EPERM` (a live
 * process another user owns) and any other error mean alive. Serves epic
 * bs-optimize criterion 10 (lock rules).
 */
export function pidIsAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The lock dir: the explicit one, else `env.BS_HEAVY_LOCK_DIR`, else
 * `<home>/.blacksmith/locks`. Serves epic bs-optimize criterion 10.
 */
export function resolveHeavyLockDir(
  lockDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (lockDir !== undefined) return lockDir;
  const fromEnv = env.BS_HEAVY_LOCK_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(home, '.blacksmith', 'locks');
}

function parseRecord(text: string): HeavyLockRecord | undefined {
  try {
    const v = JSON.parse(text) as Partial<HeavyLockRecord> | null;
    if (
      v !== null &&
      typeof v === 'object' &&
      Number.isInteger(v.pid) &&
      (v.pid as number) > 0 &&
      typeof v.token === 'string' &&
      v.token !== '' &&
      typeof v.label === 'string' &&
      typeof v.startedAt === 'string' &&
      typeof v.cwd === 'string'
    ) {
      return v as HeavyLockRecord;
    }
  } catch {
    // unparseable
  }
  return undefined;
}

/**
 * The current holder, `{corrupt: true}` for an unparseable lock file, or
 * undefined when nothing holds the lock. Serves epic bs-optimize criterion 10.
 */
export async function readHeavyLock(
  lockDir: string,
): Promise<HeavyLockRecord | { corrupt: true } | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(lockDir, LOCK_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseRecord(text) ?? { corrupt: true };
}

/** Publish a lock atomically: temp file, then `link()` (EEXIST when held). */
async function tryAcquire(lockDir: string, record: HeavyLockRecord): Promise<boolean> {
  const tmp = path.join(lockDir, `.heavy.${record.token}.tmp`);
  await writeFile(tmp, JSON.stringify(record));
  try {
    await link(tmp, path.join(lockDir, LOCK_FILE));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function tokenOnDisk(lockDir: string): Promise<string | undefined> {
  const held = await readHeavyLock(lockDir);
  if (held === undefined) return undefined;
  return 'corrupt' in held ? '' : held.token;
}

/**
 * Remove the lock at `lockDir` only if its token is still `expected`, under
 * the short reclaim mutex so two reclaimers cannot both win.
 */
async function reclaim(lockDir: string, expected: string): Promise<void> {
  const mutex = path.join(lockDir, RECLAIM_FILE);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(mutex, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      const { mtimeMs } = await stat(mutex);
      if (Date.now() - mtimeMs > RECLAIM_BREAK_MS) await rm(mutex, { force: true });
    } catch {
      // gone already
    }
    await sleep(10);
    return;
  }
  try {
    if ((await tokenOnDisk(lockDir)) === expected) {
      await unlink(path.join(lockDir, LOCK_FILE)).catch(() => undefined);
    }
  } finally {
    await handle.close();
    await rm(mutex, { force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the machine-wide heavy lock, or re-enter it when
 * `env.BS_HEAVY_LOCK_TOKEN` is the live holder's token. A live pid is never
 * stolen; past `maxWaitMs` it throws `heavy.wait-timeout` and `fn` never
 * runs. Serves epic bs-optimize criterion 10 (lock rules).
 */
export async function withHeavyLock<T>(
  fn: (lease: HeavyLease) => Promise<T> | T,
  opts: HeavyLockOptions,
): Promise<T> {
  const env = opts.env ?? process.env;
  const lockDir = resolveHeavyLockDir(opts.lockDir, env);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const alive = opts.isPidAlive ?? pidIsAlive;
  const lockPath = path.join(lockDir, LOCK_FILE);
  await mkdir(lockDir, { recursive: true });

  const started = Date.now();
  const token = randomUUID();
  const record: HeavyLockRecord = {
    pid: process.pid,
    token,
    label: opts.label,
    startedAt: new Date().toISOString(),
    cwd: opts.cwd,
  };

  for (;;) {
    if (await tryAcquire(lockDir, record)) break;
    const held = await readHeavyLock(lockDir);
    if (held === undefined) continue; // released between link and read
    if ('corrupt' in held) {
      await reclaim(lockDir, '');
      continue;
    }
    const inherited = env.BS_HEAVY_LOCK_TOKEN;
    if (inherited !== undefined && inherited === held.token) {
      return fn({ token: held.token, lockDir });
    }
    if (!alive(held.pid)) {
      await reclaim(lockDir, held.token);
      continue;
    }
    const waited = Date.now() - started;
    if (waited >= maxWaitMs) {
      throw new SmithError(
        'heavy.wait-timeout',
        `heavy lock held by pid ${held.pid} (label ${held.label}, cwd ${held.cwd}, started ${held.startedAt}); ` +
          `waited ${waited}ms; inspect ${lockPath}`,
        {
          pid: held.pid,
          label: held.label,
          cwd: held.cwd,
          startedAt: held.startedAt,
          lockPath,
          waitedMs: waited,
        },
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - waited)));
  }

  try {
    return await fn({ token, lockDir });
  } finally {
    if ((await tokenOnDisk(lockDir)) === token) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
