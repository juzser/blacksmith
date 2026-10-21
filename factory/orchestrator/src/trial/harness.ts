// Trial harness: prepare a workspace, record one run, summarize the recorded runs.
//
// Nothing here launches claude. A value the harness cannot measure is stored as
// null and printed as NOT MEASURED; it is never estimated. Tokens come from the
// shared transcript reader and are a floor whenever `complete` is false.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseNumstat } from '../diffstat.js';
import { readSessionTokens } from '../transcriptTokens.js';

export const HARNESS_VERSION = '1';
export const NOT_MEASURED = 'NOT MEASURED';

export const ARMS = ['plain', 'blacksmith'] as const;
export type Arm = (typeof ARMS)[number];
export const CHECKS = ['passed', 'failed', 'not-run', 'unknown'] as const;
export type CheckResult = (typeof CHECKS)[number];

export interface SpawnResult {
  /** Exit code; null when the process was killed or never started. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the process could not be started or timed out. */
  error?: boolean;
}
export type Spawner = (cmd: string, args: string[], opts: { cwd: string }) => SpawnResult;

export interface HarnessDeps {
  spawn: Spawner;
  now: () => Date;
  /** The directory holding `<kind>/manifest.json` for every task kind. */
  tasksDir: string;
  /** The sample application copied by `prepare`. */
  appDir: string;
}

export interface TrialRecord {
  task_kind: string;
  arm: Arm;
  check: CheckResult;
  tokens: { used: number; complete: boolean } | null;
  wall_clock_ms: number | null;
  diff: { files: number; added: number; removed: number };
  interventions: number | null;
  cli_session_id: string;
  recorded_at: string;
  harness_version: string;
}

const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

/** The real spawner: no shell, and no inherited git or test-runner state. */
export const nodeSpawner: Spawner = (cmd, args, opts) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') env[k] = v;
  }
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error ? { error: true } : {}),
  };
};

/** The directory Blacksmith's install creates in a prepared copy. */
const INSTALL_DIR = '.blacksmith';
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function checkKind(task: string): void {
  if (!PLAIN_NAME.test(task) || task.includes('..')) throw new Error(`invalid task kind: ${task}`);
}
function checkArm(arm: string): asserts arm is Arm {
  if (!(ARMS as readonly string[]).includes(arm)) {
    throw new Error(`invalid arm: ${arm} (expected plain or blacksmith)`);
  }
}

interface Manifest {
  prompt?: unknown;
  start_state?: unknown;
  fail_to_pass?: unknown;
  pass_to_pass?: unknown;
}

function loadManifest(deps: HarnessDeps, task: string): { taskDir: string; manifest: Manifest } {
  checkKind(task);
  const taskDir = path.join(deps.tasksDir, task);
  const file = path.join(taskDir, 'manifest.json');
  try {
    return { taskDir, manifest: JSON.parse(readFileSync(file, 'utf8')) as Manifest };
  } catch {
    throw new Error(`cannot read the manifest of task ${task}: ${file}`);
  }
}

/** A path named inside a task directory, or null when it points outside it. */
function inside(taskDir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '') return null;
  const full = path.resolve(taskDir, rel);
  return full.startsWith(path.resolve(taskDir) + path.sep) ? full : null;
}

function git(deps: HarnessDeps, cwd: string, args: string[], what: string): SpawnResult {
  const r = deps.spawn('git', args, { cwd });
  if (r.status !== 0 || r.error) {
    throw new Error(`${what} failed: ${(r.stderr || `exit ${r.status}`).trim()}`);
  }
  return r;
}

export function prepare(
  opts: { task: string; arm: string; dir: string; entry?: string },
  deps: HarnessDeps,
): string {
  checkArm(opts.arm);
  const arm = opts.arm;
  const { taskDir, manifest } = loadManifest(deps, opts.task);
  const dir = path.resolve(opts.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new Error(`directory is not empty: ${dir}`);
  const promptFile = inside(taskDir, manifest.prompt);
  if (promptFile === null) throw new Error(`task ${opts.task} names no prompt`);
  const prompt = readFileSync(promptFile, 'utf8');

  mkdirSync(dir, { recursive: true });
  cpSync(deps.appDir, dir, {
    recursive: true,
    filter: (src) => !src.split(path.sep).some((s) => s === 'node_modules' || s === '.git'),
  });
  if (manifest.start_state !== null && manifest.start_state !== undefined) {
    const patch = inside(taskDir, manifest.start_state);
    if (patch === null) throw new Error(`task ${opts.task} names a start state outside its folder`);
    git(deps, dir, ['apply', patch], 'applying the start state');
  }
  git(deps, dir, ['init', '-q'], 'git init');
  git(deps, dir, ['add', '-A'], 'git add');
  git(
    deps,
    dir,
    [
      '-c',
      'user.name=trial',
      '-c',
      'user.email=trial@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'trial start state',
    ],
    'git commit',
  );

  const entry = opts.entry ?? 'trial/harness/trial.mjs';
  return [
    `Prepared ${opts.task} (${arm}) in ${dir}`,
    '',
    ...(arm === 'blacksmith'
      ? ['Install Blacksmith in this directory before you start the session.', '']
      : []),
    'Run this yourself; the harness never starts claude:',
    `  cd ${dir} && claude`,
    '',
    'Give the session this prompt:',
    '----',
    prompt.trimEnd(),
    '----',
    '',
    'When the session is over, record it:',
    `  node ${entry} record --task ${opts.task} --arm ${arm} --dir ${dir} --cli-session <id> --results <file.jsonl>`,
    '',
  ].join('\n');
}

function testFiles(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const files = names.filter((n) => /\.test\.(js|mjs|cjs)$/.test(n)).sort();
  return files.length === 0 ? null : files.map((n) => path.join(dir, n));
}

/** Passing tests in TAP output: an `ok` line that is not skipped, todo, or the file itself. */
function passingTests(stdout: string, file: string): number {
  let n = 0;
  for (const line of stdout.split('\n')) {
    const m = /^\s*ok \d+ - (.*)$/.exec(line);
    if (m === null) continue;
    const name = m[1] ?? '';
    if (/#\s*(SKIP|TODO)\b/i.test(name)) continue;
    if (name === path.basename(file) || name === file) continue;
    n += 1;
  }
  return n;
}

function runChecks(deps: HarnessDeps, task: string, dir: string): CheckResult {
  const { taskDir, manifest } = loadManifest(deps, task);
  const files: string[] = [];
  for (const rel of [manifest.fail_to_pass, manifest.pass_to_pass]) {
    const d = inside(taskDir, rel);
    const found = d === null ? null : testFiles(d);
    if (found === null) return 'not-run';
    files.push(...found);
  }
  let unknown = false;
  for (const file of files) {
    const r = deps.spawn('node', ['--test', '--test-reporter=tap', file], { cwd: dir });
    if (r.error || r.status === null) unknown = true;
    else if (r.status !== 0) return 'failed';
    else if (passingTests(r.stdout, file) === 0) unknown = true;
  }
  return unknown ? 'unknown' : 'passed';
}

function diffStats(deps: HarnessDeps, dir: string): TrialRecord['diff'] {
  const root = git(
    deps,
    dir,
    ['rev-list', '--max-parents=0', 'HEAD'],
    'diff (finding the start commit)',
  )
    .stdout.trim()
    .split('\n')[0];
  if (!root) throw new Error('diff failed: no start commit');
  // The install directory is created after the start commit; keep it out of the numbers.
  const skip = `:(exclude)${INSTALL_DIR}`;
  git(deps, dir, ['add', '-N', '--', '.', skip], 'diff (marking new files)');
  const out = git(deps, dir, ['diff', '--numstat', '-z', root, '--', '.', skip], 'diff');
  const stats = parseNumstat(out.stdout);
  return {
    files: stats.length,
    added: stats.reduce((s, f) => s + f.added, 0),
    removed: stats.reduce((s, f) => s + f.deleted, 0),
  };
}

async function findMainTranscript(configDir: string, sid: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await readdir(path.join(configDir, 'projects'));
  } catch {
    return null;
  }
  for (const p of projects) {
    // Real project directories are the working path with separators turned into dashes.
    if (p === '.' || p === '..' || /[\\/\0]/.test(p)) continue;
    try {
      return await readFile(path.join(configDir, 'projects', p, `${sid}.jsonl`), 'utf8');
    } catch {}
  }
  return null;
}

function spanMs(transcript: string): number | null {
  const times: number[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
      const t = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
      if (Number.isFinite(t)) times.push(t);
    } catch {}
  }
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

export async function record(
  opts: {
    task: string;
    arm: string;
    dir: string;
    cliSession: string;
    claudeConfigDir: string;
    interventions?: number;
    results: string;
  },
  deps: HarnessDeps,
): Promise<TrialRecord> {
  checkArm(opts.arm);
  if (!PLAIN_NAME.test(opts.cliSession) || opts.cliSession.includes('..')) {
    throw new Error(`invalid cli session id: ${opts.cliSession}`);
  }
  if (
    opts.interventions !== undefined &&
    !(Number.isInteger(opts.interventions) && opts.interventions >= 0)
  ) {
    throw new Error('interventions must be a whole number of at least 0');
  }
  const dir = path.resolve(opts.dir);
  const check = runChecks(deps, opts.task, dir);
  const diff = diffStats(deps, dir);

  let tokens: TrialRecord['tokens'] = null;
  let wall: number | null = null;
  const transcript = await findMainTranscript(opts.claudeConfigDir, opts.cliSession);
  if (transcript !== null) {
    const t = await readSessionTokens({
      configDir: opts.claudeConfigDir,
      cliSessionId: opts.cliSession,
      roles: [],
    });
    tokens = { used: t.used, complete: t.complete };
    wall = spanMs(transcript);
  }

  const rec: TrialRecord = {
    task_kind: opts.task,
    arm: opts.arm,
    check,
    tokens,
    wall_clock_ms: wall,
    diff,
    interventions: opts.interventions ?? null,
    cli_session_id: opts.cliSession,
    recorded_at: deps.now().toISOString(),
    harness_version: HARNESS_VERSION,
  };
  mkdirSync(path.dirname(path.resolve(opts.results)), { recursive: true });
  appendFileSync(opts.results, `${JSON.stringify(rec)}\n`);
  return rec;
}

function isRecord(v: unknown): v is TrialRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.task_kind === 'string' &&
    (ARMS as readonly unknown[]).includes(r.arm) &&
    (CHECKS as readonly unknown[]).includes(r.check) &&
    typeof r.diff === 'object' &&
    r.diff !== null
  );
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (x: number): string => String(Math.round(x * 10) / 10);

/** What a cell's number is: one run, one measured run among several, or a mean. */
function label(measured: number, runs: number): string {
  if (runs === 1) return 'single run';
  if (measured === 1) return `single measured run of ${runs}`;
  return measured === runs ? `mean of ${runs} runs` : `mean of ${measured} of ${runs} runs`;
}

function cell(values: number[], runs: number, fmt: (x: number) => string, floor = false): string {
  if (values.length === 0) return NOT_MEASURED;
  return `${floor ? 'at least ' : ''}${fmt(mean(values))} (${label(values.length, runs)})`;
}

function row(arm: Arm, runs: TrialRecord[]): string {
  const n = runs.length;
  const counts = CHECKS.map((c) => [c, runs.filter((r) => r.check === c).length] as const)
    .filter(([, k]) => k > 0)
    .map(([c, k]) => `${k} ${c}`)
    .join(', ');
  const tok = runs.flatMap((r) => (r.tokens !== null && num(r.tokens.used) ? [r.tokens] : []));
  const wall = runs.map((r) => r.wall_clock_ms).filter(num);
  const inter = runs.map((r) => r.interventions).filter(num);
  const d = (k: 'files' | 'added' | 'removed') => mean(runs.map((r) => r.diff[k] ?? 0));
  const diff = `${round1(d('files'))} files, +${round1(d('added'))}, -${round1(d('removed'))} (${label(n, n)})`;
  const cells = [
    arm,
    n === 1 ? 'single run' : `${n} runs`,
    counts,
    cell(
      tok.map((t) => t.used),
      n,
      round1,
      tok.some((t) => !t.complete),
    ),
    cell(wall, n, (ms) => `${round1(ms / 1000)} s`),
    diff,
    cell(inter, n, round1),
  ];
  return `| ${cells.join(' | ')} |`;
}

export function summarize(opts: { results: string }): string {
  let text = '';
  try {
    text = readFileSync(opts.results, 'utf8');
  } catch {}
  const recs: TrialRecord[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRecord(v)) recs.push(v);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const out: string[] = [];
  if (recs.length === 0) out.push('No runs recorded.');
  const kinds = [...new Set(recs.map((r) => r.task_kind))].sort();
  for (const kind of kinds) {
    out.push(
      `## ${kind}`,
      '',
      '| Arm | Runs | Check | Tokens | Wall clock | Diff | Interventions |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const arm of ARMS) {
      const runs = recs.filter((r) => r.task_kind === kind && r.arm === arm);
      if (runs.length > 0) out.push(row(arm, runs));
    }
    out.push('');
  }
  if (recs.length > 0) {
    out.push(
      `Cells that say ${NOT_MEASURED} have no recorded value. Token counts are a floor, not a total.`,
    );
  }
  if (skipped > 0) {
    out.push(`${skipped} unreadable ${skipped === 1 ? 'line' : 'lines'} skipped.`);
  }
  return `${out.join('\n')}\n`;
}
