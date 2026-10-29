import { open } from 'node:fs/promises';
import {
  type HeavyLockRecord,
  pidIsAlive,
  readHeavyLock,
  resolveHeavyLockDir,
} from './heavyLock.js';

/** Inside the Bash tool's default 120 s timeout, with 10 s for process start. */
export const DEFAULT_WAIT_MS = 100_000;
/** For a Bash call whose `timeout` is raised to 600000 ms, with 30 s to spare. */
export const MAX_WAIT_MS = 570_000;
/** The bound `next` steers to while a run is queued or running. */
export const LONG_WAIT_MS = 540_000;
/** The Bash `timeout` the long bound needs: 30 s to spare, the tool's ceiling. */
export const LONG_WAIT_BASH_TIMEOUT_MS = 600_000;
/** The Bash tool's default timeout, which `DEFAULT_WAIT_MS` fits. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const TAIL_LINES = 40;
export const TAIL_BYTES = 8192;

const POLL_MS = 2000;
/** Read from the end: the EXIT line, blank lines after it, and TAIL_BYTES of text before it. */
const READ_BYTES = 4 * TAIL_BYTES;
const EXIT_LINE = /^EXIT=(\d{1,3})$/;

export interface HeavyWaitOptions {
  file: string;
  maxWaitMs?: number;
  pollMs?: number;
  lockDir?: string;
}

/** Which bound, and which Bash `timeout`, the next wait call uses. */
export interface NextWait {
  max_wait_ms: number;
  bash_timeout_ms: number;
}

export type HeavyWaitResult =
  | { done: true; exit: number; tail: string }
  | {
      done: false;
      waited_ms: number;
      holder: HeavyLockRecord | { corrupt: true } | null;
      idle_ms?: number;
      missing?: true;
      next: NextWait;
    };

type Probe =
  | { missing: true }
  | { missing: false; mtimeMs: number; exit?: { code: number; tail: string } };

type End = { missing: true } | { missing: false; mtimeMs: number; chunk: string; whole: boolean };

/** The last `READ_BYTES` of the file, and whether that chunk starts at the file's start. */
async function readEnd(file: string): Promise<End> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    throw err;
  }
  try {
    const { size, mtimeMs } = await handle.stat();
    const start = Math.max(0, size - READ_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    return { missing: false, mtimeMs, chunk: buf.toString('utf8'), whole: start === 0 };
  } finally {
    await handle.close();
  }
}

/** Keep at most the last TAIL_LINES lines and TAIL_BYTES bytes, never splitting a character. */
function boundTail(text: string): string {
  let tail = text.split('\n').slice(-TAIL_LINES).join('\n');
  const bytes = Buffer.from(tail, 'utf8');
  if (bytes.length > TAIL_BYTES) {
    let from = bytes.length - TAIL_BYTES;
    while (from < bytes.length && ((bytes[from] as number) & 0xc0) === 0x80) from++;
    tail = bytes.subarray(from).toString('utf8');
  }
  return tail;
}

async function probe(file: string): Promise<Probe> {
  const read = await readEnd(file);
  if (read.missing) return read;
  const lines = read.chunk.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  const match = EXIT_LINE.exec(last);
  // A chunk that starts mid-file cannot prove its first line begins a line.
  if (!match || (lines.length === 1 && !read.whole))
    return { missing: false, mtimeMs: read.mtimeMs };
  const before = lines.slice(0, -1).join('\n').replace(/\s+$/, '');
  return {
    missing: false,
    mtimeMs: read.mtimeMs,
    exit: { code: Number(match[1]), tail: boundTail(before) },
  };
}

async function currentHolder(
  lockDir: string | undefined,
): Promise<HeavyLockRecord | { corrupt: true } | null> {
  const held = await readHeavyLock(resolveHeavyLockDir(lockDir));
  if (held === undefined) return null;
  if ('corrupt' in held) return held;
  return pidIsAlive(held.pid) ? held : null;
}

/**
 * Poll `file` until its last non-empty line is exactly `EXIT=<n>`, or until
 * `maxWaitMs` passes. Read-only: no lock, no child process, no shell, and
 * only the end of the file is read.
 */
export async function heavyWait(opts: HeavyWaitOptions): Promise<HeavyWaitResult> {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const started = Date.now();
  for (;;) {
    const p = await probe(opts.file);
    if (!p.missing && p.exit) return { done: true, exit: p.exit.code, tail: p.exit.tail };
    const waited = Date.now() - started;
    if (waited >= maxWaitMs) {
      const holder = await currentHolder(opts.lockDir);
      // Long only for a file that exists and a named holder: queued or running.
      const next: NextWait =
        !p.missing && holder !== null
          ? { max_wait_ms: LONG_WAIT_MS, bash_timeout_ms: LONG_WAIT_BASH_TIMEOUT_MS }
          : { max_wait_ms: DEFAULT_WAIT_MS, bash_timeout_ms: DEFAULT_BASH_TIMEOUT_MS };
      return p.missing
        ? { done: false, waited_ms: waited, holder, missing: true, next }
        : {
            done: false,
            waited_ms: waited,
            holder,
            idle_ms: Math.max(0, Date.now() - p.mtimeMs),
            next,
          };
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, maxWaitMs - waited))));
  }
}
