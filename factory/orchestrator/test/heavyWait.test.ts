import { type ChildProcess, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roleOfTemplateFile } from '../src/agentNames.js';
import { readTemplateMaxTurns } from '../src/agentsSync.js';
import { DEFAULT_MAX_WAIT_MS } from '../src/heavyLock.js';
import {
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_WAIT_MS,
  heavyWait,
  LONG_WAIT_BASH_TIMEOUT_MS,
  LONG_WAIT_MS,
  MAX_WAIT_MS,
  TAIL_BYTES,
  TAIL_LINES,
} from '../src/heavyWait.js';
import { decideHookPayload, dietDecision } from '../src/hookDecision.js';
import { closeSandbox, openSandbox } from '../src/sandbox.js';
import { parseSharedRegions } from '../src/templateFragments.js';
import { runOrThrow, runProcess } from './helpers/process.js';

// Finding f-bs-optimize/integration-dcc5330f: `bs heavy wait` and the rewritten
// heavy-run fragment. Locks live in temp dirs (BS_HEAVY_LOCK_DIR / lockDir),
// never the machine's; every child the e2e cases start is killed in afterEach.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'factory', 'orchestrator', 'dist', 'cli.js');
const FRAGMENT = readFileSync(path.join(REPO_ROOT, '.claude', 'fragments', 'heavy-run.md'), 'utf8');

let dir: string;
let lockDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  // Real path: the policy compares against git's, and /var is a symlink on macOS.
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'heavywait-')));
  lockDir = path.join(dir, 'locks');
  mkdirSync(lockDir, { recursive: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL'); // the group this test started
      } catch {
        // already gone
      }
    }
  }
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outFile = (name = 'out.txt') => path.join(dir, name);

describe('heavyWait (the module)', () => {
  it.each([0, 3, 75, 124])('is done with exit %i on a file ending in EXIT=%i', async (code) => {
    const file = outFile();
    writeFileSync(file, `some output\n\nEXIT=${code}\n`);
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    expect(r).toMatchObject({ done: true, exit: code, tail: 'some output' });
  });

  it('is done when the EXIT line has no trailing newline', async () => {
    const file = outFile();
    writeFileSync(file, 'x\n\nEXIT=3');
    expect(await heavyWait({ file, maxWaitMs: 0, lockDir })).toMatchObject({
      done: true,
      exit: 3,
    });
  });

  it('is not done when the last line only ends in EXIT=0 after other text', async () => {
    const file = outFile();
    writeFileSync(file, 'tests passed EXIT=0');
    expect(await heavyWait({ file, maxWaitMs: 0, lockDir })).toMatchObject({ done: false });
  });

  it('is not done when an EXIT= line is followed by more output', async () => {
    const file = outFile();
    writeFileSync(file, 'a\n\nEXIT=0\nmore output\n');
    expect(await heavyWait({ file, maxWaitMs: 0, lockDir })).toMatchObject({ done: false });
  });

  it('returns not-done once its bound passes, with waited_ms, holder and idle_ms', async () => {
    const file = outFile();
    writeFileSync(file, 'still running\n');
    const started = Date.now();
    const r = await heavyWait({ file, maxWaitMs: 300, lockDir });
    expect(Date.now() - started).toBeLessThan(300 + 2000);
    expect(r).toMatchObject({ done: false, holder: null });
    if (r.done) throw new Error('unreachable');
    expect(r.waited_ms).toBeGreaterThanOrEqual(300);
    expect(r.idle_ms).toBeGreaterThanOrEqual(0);
    expect(r.missing).toBeUndefined();
  });

  it('names the live heavy-lock holder', async () => {
    const file = outFile();
    writeFileSync(file, 'still running\n');
    writeFileSync(
      path.join(lockDir, 'heavy.lock'),
      JSON.stringify({
        pid: process.pid,
        token: 't',
        label: 'task-1-coder',
        startedAt: '2026-01-01T00:00:00.000Z',
        cwd: dir,
      }),
    );
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    expect(r).toMatchObject({ done: false, holder: { pid: process.pid, label: 'task-1-coder' } });
  });

  it('reports a holder whose pid is dead as no holder', async () => {
    const file = outFile();
    writeFileSync(file, 'x\n');
    const dead = runProcess('node', ['-e', 'process.stdout.write(String(process.pid))']);
    writeFileSync(
      path.join(lockDir, 'heavy.lock'),
      JSON.stringify({
        pid: Number(dead.stdout),
        token: 't',
        label: 'gone',
        startedAt: '2026-01-01T00:00:00.000Z',
        cwd: dir,
      }),
    );
    expect(await heavyWait({ file, maxWaitMs: 0, lockDir })).toMatchObject({ holder: null });
  });

  it('is not done with missing: true when the file is still absent at the bound', async () => {
    const r = await heavyWait({ file: outFile('never'), maxWaitMs: 300, lockDir });
    expect(r).toMatchObject({ done: false, missing: true, holder: null });
  });

  it('notices EXIT= appearing while it polls', async () => {
    const file = outFile();
    writeFileSync(file, 'running\n');
    setTimeout(() => appendFileSync(file, '\nEXIT=5\n'), 100);
    const r = await heavyWait({ file, maxWaitMs: 5000, pollMs: 20, lockDir });
    expect(r).toMatchObject({ done: true, exit: 5 });
  });

  it('keeps the last 40 lines before the EXIT line', async () => {
    const file = outFile();
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(file, `${lines.join('\n')}\n\nEXIT=0\n`);
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    if (!r.done) throw new Error('not done');
    expect(r.tail.split('\n')).toEqual(lines.slice(-TAIL_LINES));
  });

  it('on a 50 MB file reads only the end: a bounded, suffix-true tail', async () => {
    const file = outFile('big.txt');
    const longLine = `${'y'.repeat(499)}\n`;
    const body = `${'x'.repeat(1023)}\n`.repeat(50 * 1024) + longLine.repeat(60);
    writeFileSync(file, `${body}last summary line\n\nEXIT=1\n`);
    expect(statSync(file).size).toBeGreaterThan(50 * 1024 * 1024);
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    if (!r.done) throw new Error('not done');
    expect(r.exit).toBe(1);
    expect(r.tail.split('\n').length).toBeLessThanOrEqual(TAIL_LINES);
    expect(Buffer.byteLength(r.tail)).toBeLessThanOrEqual(TAIL_BYTES);
    expect(`${body}last summary line`.endsWith(r.tail)).toBe(true);
    expect(r.tail.endsWith('last summary line')).toBe(true);
  });

  it('cuts a multi-byte character cleanly at the byte cap', async () => {
    const file = outFile();
    writeFileSync(file, `${'é'.repeat(6000)}\n\nEXIT=0\n`);
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    if (!r.done) throw new Error('not done');
    expect(Buffer.byteLength(r.tail)).toBeLessThanOrEqual(TAIL_BYTES);
    expect(r.tail).not.toContain('�');
  });
});

// ---- `next`: which bound the next call uses (finding f-bs-optimize/integration-cdcd0b23) ----

const LONG = { max_wait_ms: 540_000, bash_timeout_ms: 600_000 };
const SHORT = { max_wait_ms: 100_000, bash_timeout_ms: 120_000 };

describe('heavyWait names the next call’s bound', () => {
  const writeHolder = (content: string) => writeFileSync(path.join(lockDir, 'heavy.lock'), content);
  const liveRecord = () =>
    JSON.stringify({
      pid: process.pid,
      token: 't',
      label: 'someone-else',
      startedAt: '2026-01-01T00:00:00.000Z',
      cwd: dir,
    });

  it('keeps the default bound and the ceiling, and sizes the long pair to the tool timeout', () => {
    expect(DEFAULT_WAIT_MS).toBe(100_000);
    expect(MAX_WAIT_MS).toBe(570_000);
    expect(LONG_WAIT_MS).toBe(540_000);
    expect(LONG_WAIT_MS).toBeLessThanOrEqual(MAX_WAIT_MS);
    expect(LONG_WAIT_BASH_TIMEOUT_MS).toBe(600_000);
    expect(LONG_WAIT_BASH_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
    expect(LONG_WAIT_BASH_TIMEOUT_MS).toBeGreaterThanOrEqual(LONG_WAIT_MS + 30_000);
    expect(DEFAULT_BASH_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_WAIT_MS + 10_000).toBeLessThanOrEqual(DEFAULT_BASH_TIMEOUT_MS);
  });

  it('(a) carries the long pair on an existing file with a live holder', async () => {
    const file = outFile();
    writeFileSync(file, 'running\n');
    writeHolder(liveRecord());
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    expect(r).toMatchObject({ done: false, holder: { label: 'someone-else' }, next: LONG });
  });

  it('(b) carries the long pair when the lock record is corrupt', async () => {
    const file = outFile();
    writeFileSync(file, 'running\n');
    writeHolder('not json');
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    expect(r).toMatchObject({ done: false, holder: { corrupt: true }, next: LONG });
  });

  it('(c) carries the default pair when no holder is named', async () => {
    const file = outFile();
    writeFileSync(file, 'running\n');
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    expect(r).toMatchObject({ done: false, holder: null, next: SHORT });
  });

  it('(d) carries the default pair for a missing file even with a live holder', async () => {
    writeHolder(liveRecord());
    const r = await heavyWait({ file: outFile('never'), maxWaitMs: 0, lockDir });
    if (r.done) throw new Error('unreachable');
    expect(r.holder).not.toBeNull();
    expect(r).toMatchObject({ missing: true, next: SHORT });
  });

  it('(e) has no next key on a done result', async () => {
    const file = outFile();
    writeFileSync(file, 'x\n\nEXIT=0\n');
    writeHolder(liveRecord());
    const r = await heavyWait({ file, maxWaitMs: 0, lockDir });
    expect(r.done).toBe(true);
    expect('next' in r).toBe(false);
  });
});

// ---- the CLI ---------------------------------------------------------------------

function bs(args: string[], env: Record<string, string> = {}) {
  const run = runProcess('node', [CLI_PATH, ...args], {
    env: { ...process.env, BS_HEAVY_LOCK_DIR: lockDir, HOME: dir, ...env },
  });
  expect(run.signal).toBeNull();
  return run;
}

describe('bs heavy wait (the verb)', () => {
  it('prints done/exit/tail and exits with the file’s code, 75 passing through', () => {
    const file = outFile();
    writeFileSync(file, 'boom\n\nEXIT=75\n');
    const run = bs(['heavy', 'wait', '--file', file]);
    expect(run.status).toBe(75);
    expect(JSON.parse(run.stdout)).toEqual({ done: true, exit: 75, tail: 'boom' });
  });

  it('exits 124 with done: false at its bound', () => {
    const file = outFile();
    writeFileSync(file, 'running\n');
    const run = bs(['heavy', 'wait', '--file', file, '--max-wait-ms', '200']);
    expect(run.status).toBe(124);
    expect(JSON.parse(run.stdout)).toMatchObject({ done: false, holder: null });
  });

  it('prints next beside done: false and still exits 124', () => {
    const file = outFile();
    writeFileSync(file, 'running\n');
    const run = bs(['heavy', 'wait', '--file', file, '--max-wait-ms', '200']);
    expect(run.status).toBe(124);
    expect(JSON.parse(run.stdout)).toMatchObject({ done: false, next: SHORT });
  });

  it('keeps done: true on a suite that itself exited 124', () => {
    const file = outFile();
    writeFileSync(file, 'x\n\nEXIT=124\n');
    const run = bs(['heavy', 'wait', '--file', file]);
    expect(run.status).toBe(124);
    expect(JSON.parse(run.stdout)).toMatchObject({ done: true, exit: 124 });
  });

  it.each(['-1', '1.5', 'abc', String(MAX_WAIT_MS + 1)])(
    'refuses --max-wait-ms %s with cli.invalid-flag',
    (value) => {
      const file = outFile();
      writeFileSync(file, 'x\n');
      const run = bs(['heavy', 'wait', '--file', file, '--max-wait-ms', value]);
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain('cli.invalid-flag');
    },
  );

  it('accepts the 570000 ceiling and needs --file', () => {
    const file = outFile();
    writeFileSync(file, 'x\n\nEXIT=0\n');
    expect(bs(['heavy', 'wait', '--file', file, '--max-wait-ms', '570000']).status).toBe(0);
    expect(bs(['heavy', 'wait']).stdout + bs(['heavy', 'wait']).stderr).toContain(
      'cli.missing-flag',
    );
  });
});

// ---- the fragment's calls fit their tool timeout --------------------------------

/** Each `bs heavy wait` call the fragment shows (a line of its own, or a code span), with its sentence. */
function waitCalls(): { call: string; sentence: string }[] {
  const calls: { call: string; sentence: string }[] = [];
  for (const line of FRAGMENT.split('\n')) {
    if (line.startsWith('bs heavy wait ')) calls.push({ call: line.trim(), sentence: '' });
  }
  const flat = FRAGMENT.replace(/\s+/g, ' ');
  for (const m of flat.matchAll(/`(bs heavy wait [^`]*)`/g)) {
    const start = flat.lastIndexOf('. ', m.index) + 2;
    const end = flat.indexOf('. ', m.index);
    calls.push({ call: m[1] as string, sentence: flat.slice(start, end === -1 ? undefined : end) });
  }
  return calls;
}

/** The steer sentence: the one holding both a `"holder"` and a `--max-wait-ms` call. */
function steerSentence(): string {
  const flat = FRAGMENT.replace(/\s+/g, ' ');
  const found = flat.split('. ').find((s) => s.includes('--max-wait-ms') && s.includes('"holder"'));
  if (found === undefined)
    throw new Error('no steer sentence: no sentence pairs a holder with a --max-wait-ms call');
  return found;
}
const steerBound = (): number => Number(/--max-wait-ms (\d+)/.exec(steerSentence())?.[1]);
const steerTimeout = (): number =>
  Number(/Bash `timeout` (?:of )?(\d+)/.exec(steerSentence())?.[1]);
const steerCall = (): string =>
  /`(bs heavy wait [^`]*--max-wait-ms \d+)`/.exec(steerSentence())?.[1] as string;

describe('each bs heavy wait call the fragment shows fits its Bash tool timeout', () => {
  it('has a default bound inside the Bash default of 120000 ms with 10 s for start-up', () => {
    expect(DEFAULT_WAIT_MS).toBeLessThanOrEqual(110_000);
    expect(MAX_WAIT_MS).toBe(570_000);
  });

  it('shows at least the plain wait call and the long one', () => {
    const calls = waitCalls().map((c) => c.call);
    expect(calls.some((c) => !c.includes('--max-wait-ms'))).toBe(true);
    expect(calls.some((c) => c.includes('--max-wait-ms 540000'))).toBe(true);
  });

  it('steers to the bound and timeout the module exports', () => {
    expect(steerBound()).toBe(LONG_WAIT_MS);
    expect(steerTimeout()).toBe(LONG_WAIT_BASH_TIMEOUT_MS);
  });

  it('passes --max-wait-ms only beside a Bash timeout of at most 600000 that is >= bound + 30000', () => {
    for (const { call, sentence } of waitCalls()) {
      const bound = /--max-wait-ms (\d+)/.exec(call)?.[1];
      if (bound === undefined) continue;
      const timeout = /Bash `timeout` (?:of )?(\d+)/.exec(sentence)?.[1];
      expect(timeout, `${call}: no Bash timeout in its sentence`).toBeDefined();
      expect(Number(timeout), call).toBeLessThanOrEqual(600_000);
      expect(Number(timeout), call).toBeGreaterThanOrEqual(Number(bound) + 30_000);
      expect(Number(bound), call).toBeLessThanOrEqual(MAX_WAIT_MS);
    }
  });
});

// ---- a dispatch's heavy-run turns fit each carrier's cap ---------------------------

/** The epic's measured full suite, in ms. */
const SUITE_MS = 440_000;
/**
 * The heavy runs each carrier's template or brief directs in one dispatch
 * (epic spec, "Closing review (plan v6)", pre-code review (v7 draft), item 1).
 */
const HEAVY_RUNS_PER_DISPATCH: Record<string, number> = {
  coder: 3,
  tester: 2,
  merger: 1,
  'wave-runner': 1,
  auditor: 1,
  grader: 1,
  reviewer: 1,
  'security-reviewer': 1,
  'spec-reviewer': 1,
  uiux: 1,
  verifier: 1,
};

const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');
function carriers(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => /^bs-.*\.md$/.test(f))
    .filter((f) =>
      parseSharedRegions(readFileSync(path.join(AGENTS_DIR, f), 'utf8')).some(
        (r) => r.name === 'heavy-run',
      ),
    )
    .map((f) => roleOfTemplateFile(f) ?? f)
    .sort();
}

/** mktemp + start + the plain wait + the steered waits for the rest of the queue and the suite. */
function turnsPerRun(): number {
  return 3 + Math.ceil((DEFAULT_MAX_WAIT_MS + SUITE_MS - DEFAULT_WAIT_MS) / steerBound());
}

describe('a dispatch’s heavy-run turns fit each carrier’s cap', () => {
  it('the runs table names exactly the carriers the templates stamp', () => {
    const derived = carriers();
    const table = Object.keys(HEAVY_RUNS_PER_DISPATCH);
    expect(
      derived.filter((r) => !table.includes(r)),
      'carrier missing from the table',
    ).toEqual([]);
    expect(
      table.filter((r) => !derived.includes(r)),
      'table entry that is no carrier',
    ).toEqual([]);
  });

  it('costs one queued run at most 11 turns', () => {
    expect(DEFAULT_MAX_WAIT_MS).toBe(3_600_000);
    expect(turnsPerRun()).toBe(11);
  });

  it('leaves every carrier at least half its maxTurns for its own work', () => {
    const perRun = turnsPerRun();
    const failures: string[] = [];
    for (const role of carriers()) {
      const cap = readTemplateMaxTurns(AGENTS_DIR, role);
      const runs = HEAVY_RUNS_PER_DISPATCH[role];
      if (cap === undefined || runs === undefined) {
        failures.push(`bs-${role}: no maxTurns or no runs entry`);
        continue;
      }
      const limit = Math.floor(cap / 2);
      if (runs * perRun > limit)
        failures.push(
          `bs-${role}: ${runs} runs x ${perRun} turns = ${runs * perRun} against a limit of ${limit}`,
        );
    }
    expect(failures).toEqual([]);
  });
});

// ---- the fragment, executed -----------------------------------------------------

const LABEL = 'epic-task-coder';

/** The first fragment line that starts with `prefix`, placeholders filled, `bs` → this build. */
function fragmentLine(prefix: string, vars: Record<string, string>): string {
  const line = FRAGMENT.split('\n').find((l) => l.startsWith(prefix));
  if (line === undefined) throw new Error(`fragment has no line starting ${prefix}`);
  let out = line;
  for (const [k, v] of Object.entries(vars)) out = out.split(`<${k}>`).join(v);
  return out.replace(/\bbs heavy /g, `node ${CLI_PATH} heavy `);
}

const startCommand = (out: string, cmd: string, extra = ''): string => {
  const line = fragmentLine('bs heavy run', { 'task-id': 'epic-task', role: 'coder', cmd, out });
  return extra === '' ? line : line.replace('heavy run ', `heavy run ${extra} `);
};

/** A `sh -c` child in its own process group, under the temp lock dir and HOME. */
function startShell(command: string): ChildProcess {
  const child = spawn('sh', ['-c', command], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BS_HEAVY_LOCK_DIR: lockDir, HOME: dir },
  });
  children.push(child);
  return child;
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A suite stand-in: prints with no final newline, waits for `release`, exits with `code`. */
function suiteScript(code: number): { cmd: string; release: string } {
  const release = path.join(dir, 'release');
  const script = path.join(dir, 'suite.cjs');
  writeFileSync(
    script,
    `const fs = require('fs');
process.stdout.write('summary without newline');
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); process.exit(${code}); } }, 20);
`,
  );
  return { cmd: `node ${script}`, release };
}

describe('the fragment’s commands, run for real', () => {
  it('holds the lock for the whole run, then ends the file with EXIT=<n> on its own line', async () => {
    const out = outFile('run.out');
    writeFileSync(out, '');
    const { cmd, release } = suiteScript(7);
    startShell(startCommand(out, cmd));
    await until(() => bs(['heavy', 'status']).stdout.includes(LABEL), 'the lock to be held');
    const waiting = bs(['heavy', 'wait', '--file', out, '--max-wait-ms', '300']);
    expect(waiting.status).toBe(124);
    expect(JSON.parse(waiting.stdout)).toMatchObject({ done: false });
    writeFileSync(release, 'go');
    await until(() => /\nEXIT=7\n$/.test(readFileSync(out, 'utf8')), 'EXIT=7');
    const done = bs(['heavy', 'wait', '--file', out]);
    expect(done.status).toBe(7);
    expect(JSON.parse(done.stdout)).toMatchObject({ done: true, exit: 7 });
    expect(readFileSync(out, 'utf8').split('\n').at(-2)).toBe('EXIT=7');
    expect(JSON.parse(bs(['heavy', 'status']).stdout)).toEqual({});
  });

  it('a run queued behind a holder is told to wait long, then takes the lock and finishes', async () => {
    const out = outFile('queued.out');
    writeFileSync(out, '');
    const record = path.join(lockDir, 'heavy.lock');
    writeFileSync(
      record,
      JSON.stringify({
        pid: process.pid,
        token: 'mine',
        label: 'someone-else',
        startedAt: '2026-01-01T00:00:00.000Z',
        cwd: dir,
      }),
    );
    const { cmd, release } = suiteScript(3);
    startShell(startCommand(out, cmd));
    const waiting = bs(['heavy', 'wait', '--file', out, '--max-wait-ms', '300']);
    expect(waiting.status).toBe(124);
    const parsed = JSON.parse(waiting.stdout);
    expect(parsed).toMatchObject({ done: false, holder: { label: 'someone-else' } });
    expect(parsed.next).toEqual(LONG);
    await rm(record); // the record this test wrote
    await until(
      () => bs(['heavy', 'status']).stdout.includes(LABEL),
      'the queued run to take the lock',
    );
    writeFileSync(release, 'go');
    await until(() => /\nEXIT=3\n$/.test(readFileSync(out, 'utf8')), 'EXIT=3');
    const done = bs(['heavy', 'wait', '--file', out]);
    expect(done.status).toBe(3);
    expect(JSON.parse(done.stdout)).toMatchObject({ done: true, exit: 3 });
    expect(JSON.parse(bs(['heavy', 'status']).stdout)).toEqual({});
  });

  it('a start that cannot get the lock ends EXIT=75 and wait passes 75 and the holder through', async () => {
    const out = outFile('busy.out');
    writeFileSync(out, '');
    writeFileSync(
      path.join(lockDir, 'heavy.lock'),
      JSON.stringify({
        pid: process.pid,
        token: 'held',
        label: 'someone-else',
        startedAt: '2026-01-01T00:00:00.000Z',
        cwd: dir,
      }),
    );
    const child = startShell(startCommand(out, 'node -e 0', '--max-wait-ms 200'));
    await new Promise((r) => child.once('exit', r));
    expect(readFileSync(out, 'utf8').trimEnd().split('\n').at(-1)).toBe('EXIT=75');
    const done = bs(['heavy', 'wait', '--file', out]);
    expect(done.status).toBe(75);
    expect(done.stdout).toContain('someone-else');
    expect(done.stdout).toContain(String(process.pid));
  });

  it('a start whose shell is killed before EXIT= gives two not-done calls with no holder', async () => {
    const out = outFile('dead.out');
    writeFileSync(out, '');
    const { cmd } = suiteScript(0);
    const child = startShell(startCommand(out, cmd));
    await until(() => bs(['heavy', 'status']).stdout.includes(LABEL), 'the lock to be held');
    process.kill(-(child.pid as number), 'SIGKILL');
    await new Promise((r) => child.once('exit', r));
    for (let i = 0; i < 2; i++) {
      const r = bs(['heavy', 'wait', '--file', out, '--max-wait-ms', '200']);
      expect(r.status).toBe(124);
      expect(JSON.parse(r.stdout)).toMatchObject({ done: false, holder: null });
    }
  });

  it('the mktemp step prints two distinct paths to existing empty files', () => {
    const results = path.join(dir, 'state', 'results');
    mkdirSync(results, { recursive: true });
    const line = fragmentLine('mktemp', {
      'task-id': 'epic-task',
      role: 'coder',
      'work-root': dir,
    });
    const mint = () => runOrThrow('sh', ['-c', line]).stdout.trim();
    const a = mint();
    const b = mint();
    expect(a).not.toBe(b);
    for (const p of [a, b]) {
      expect(p.startsWith(`${results}${path.sep}`)).toBe(true);
      expect(path.basename(p)).toContain('epic-task-coder');
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBe(0);
    }
    const r = bs(['heavy', 'wait', '--file', a, '--max-wait-ms', '300']);
    expect(r.status).toBe(124);
    expect(JSON.parse(r.stdout)).toMatchObject({ done: false });
  });
});

// ---- nothing the hooks deny -----------------------------------------------------

describe('the hooks allow the fragment’s three commands', () => {
  const ROLES = ['reviewer', 'verifier', 'spec-reviewer', 'security-reviewer', 'grader', 'uiux'];

  function commands(repo: string) {
    const results = path.join(repo, 'state', 'results');
    const vars = { 'task-id': 'epic-task', role: 'coder', 'work-root': repo };
    const mktemp = fragmentLine('mktemp', vars);
    const out = path.join(results, 'epic-task-coder-AbCdEf');
    const start = fragmentLine('bs heavy run', { ...vars, cmd: 'pnpm run test', out });
    const wait = fragmentLine('bs heavy wait', { ...vars, out });
    return { mktemp, start, wait };
  }

  function repoWithResults(): string {
    const repo = path.join(dir, 'repo');
    mkdirSync(path.join(repo, 'state', 'results'), { recursive: true });
    runOrThrow('git', ['init', '-q', '-b', 'feat/x', repo]);
    return repo;
  }

  it('dietDecision denies none of them, foreground or background', () => {
    const { mktemp, start, wait } = commands(repoWithResults());
    expect(dietDecision({ tool_name: 'Bash', tool_input: { command: mktemp } })).toBeNull();
    expect(dietDecision({ tool_name: 'Bash', tool_input: { command: wait } })).toBeNull();
    expect(
      dietDecision({
        tool_name: 'Bash',
        tool_input: { command: start, run_in_background: true },
      }),
    ).toBeNull();
  });

  it('allows the steered long wait with a Bash timeout of 600000', () => {
    const repo = repoWithResults();
    const leases = path.join(dir, 'leases');
    const out = path.join(repo, 'state', 'results', 'epic-task-coder-AbCdEf');
    const command = steerCall().split('<out>').join(out);
    const input = { command, timeout: steerTimeout() };
    expect(input.timeout).toBe(600_000);
    expect(dietDecision({ tool_name: 'Bash', tool_input: input })).toBeNull();
    const body = JSON.stringify({ tool_name: 'Bash', tool_input: input, cwd: repo });
    expect(decideHookPayload(body, repo, leases)).toBeNull();
    for (const role of ROLES) {
      openSandbox(
        {
          worktreeDir: repo,
          role,
          taskId: 'epic/task',
          sessionId: `sess-steer-${role}`,
          openedAt: new Date().toISOString(),
        },
        leases,
      );
      try {
        expect(decideHookPayload(body, repo, leases), role).toBeNull();
      } finally {
        closeSandbox(repo, leases);
      }
    }
  });

  it('dietDecision denies the steered call once a foreground sleep rides along', () => {
    const command = `${steerCall().split('<out>').join('/tmp/x')}; sleep 5`;
    expect(
      dietDecision({ tool_name: 'Bash', tool_input: { command, timeout: 600_000 } }),
    ).not.toBeNull();
  });

  const payload = (command: string, cwd: string, background = false) =>
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command, ...(background ? { run_in_background: true } : {}) },
      cwd,
    });

  it('decideHookPayload allows them for an unleased session', () => {
    const repo = repoWithResults();
    const leases = path.join(dir, 'leases');
    const { mktemp, start, wait } = commands(repo);
    expect(decideHookPayload(payload(mktemp, repo), repo, leases)).toBeNull();
    expect(decideHookPayload(payload(wait, repo), repo, leases)).toBeNull();
    expect(decideHookPayload(payload(start, repo, true), repo, leases)).toBeNull();
  });

  it.each(ROLES)('decideHookPayload allows them under a %s judge lease', (role) => {
    const repo = repoWithResults();
    const leases = path.join(dir, 'leases');
    const { mktemp, start, wait } = commands(repo);
    openSandbox(
      {
        worktreeDir: repo,
        role,
        taskId: 'epic/task',
        sessionId: 'sess-heavy-wait',
        openedAt: new Date().toISOString(),
      },
      leases,
    );
    try {
      expect(decideHookPayload(payload(mktemp, repo), repo, leases)).toBeNull();
      expect(decideHookPayload(payload(wait, repo), repo, leases)).toBeNull();
      expect(decideHookPayload(payload(start, repo, true), repo, leases)).toBeNull();
    } finally {
      closeSandbox(repo, leases);
    }
  });
});
