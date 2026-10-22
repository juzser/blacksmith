import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HarnessDeps,
  nodeSpawner,
  prepare,
  record,
  type Spawner,
  type SpawnResult,
  summarize,
  type TrialRecord,
} from '../src/trial/harness.js';

const SID = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-01-02T03:04:05.000Z');

let root: string;
let tasksDir: string;
let appDir: string;
let work: string;

function put(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const PASSING = "import { test } from 'node:test';\ntest('really runs', () => {});\n";
const FAILING =
  "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('really fails', () => assert.equal(1, 2));\n";
const NO_TEST = 'process.exit(0);\n';

/** One task kind with non-default hidden-check directories. */
function writeTask(
  kind: string,
  opts: { startState?: string | null; f2p?: Record<string, string>; p2p?: Record<string, string> },
): void {
  const dir = path.join(tasksDir, kind);
  put(path.join(dir, 'prompt.md'), `Prompt for ${kind}.\n`);
  put(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      kind,
      title: kind,
      prompt: 'prompt.md',
      start_state: opts.startState ?? null,
      fail_to_pass: 'gates/must-flip',
      pass_to_pass: 'gates/must-hold',
      touched_areas: ['src'],
    }),
  );
  for (const [name, text] of Object.entries(opts.f2p ?? { 'a.test.js': PASSING })) {
    put(path.join(dir, 'gates/must-flip', name), text);
  }
  for (const [name, text] of Object.entries(opts.p2p ?? { 'b.test.js': PASSING })) {
    put(path.join(dir, 'gates/must-hold', name), text);
  }
}

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
}

/** A spawner that records every call; `reply` may override the answer per call. */
function fakeSpawner(reply?: (c: Call) => Partial<SpawnResult> | undefined): {
  spawn: Spawner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const spawn: Spawner = (cmd, args, opts) => {
    const c = { cmd, args, cwd: opts.cwd };
    calls.push(c);
    const over = reply?.(c);
    let stdout = '';
    if (cmd === 'node') {
      const src = readFileSync(args[args.length - 1] ?? '', 'utf8');
      const names = [...src.matchAll(/\b(?:test|it)\('([^']*)'/g)].map((m) => m[1]);
      stdout = names.map((n, i) => `ok ${i + 1} - ${n}\n`).join('');
    }
    if (cmd === 'git' && args[0] === 'rev-list') stdout = 'abc123\n';
    return { status: 0, stdout, stderr: '', ...over };
  };
  return { spawn, calls };
}

/** Real node for the check files, canned git: the answers do not depend on a repository. */
const withFakeGit: Spawner = (cmd, args, opts) =>
  cmd === 'git' ? fakeSpawner().spawn(cmd, args, opts) : nodeSpawner(cmd, args, opts);

function deps(spawn: Spawner): HarnessDeps {
  return { spawn, now: () => NOW, tasksDir, appDir };
}

function transcript(configDir: string, lines: object[], sid = SID, project = 'project-a'): void {
  put(
    path.join(configDir, 'projects', project, `${sid}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
}

function asst(id: string, ts: string, out: number): object {
  return {
    type: 'assistant',
    timestamp: ts,
    requestId: `req-${id}`,
    message: {
      id,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: out },
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'trial-harness-'));
  tasksDir = path.join(root, 'tasks');
  appDir = path.join(root, 'app');
  work = path.join(root, 'work');
  put(path.join(appDir, 'package.json'), '{"name":"app-under-test"}\n');
  put(path.join(appDir, 'src/index.js'), 'export const one = 1;\n');
  put(path.join(appDir, 'node_modules/dep/index.js'), 'skip me\n');
  mkdirSync(work);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepare', () => {
  it('prepare copies the app, commits once, prints prompt and command, and never spawns claude', () => {
    writeTask('kind-a', {});
    const { spawn, calls } = fakeSpawner();
    const out = prepare({ task: 'kind-a', arm: 'plain', dir: work }, deps(spawn));
    expect(existsSync(path.join(work, 'src/index.js'))).toBe(true);
    expect(existsSync(path.join(work, 'node_modules'))).toBe(false);
    expect(out).toContain('Prompt for kind-a.');
    expect(out).toContain(work);
    expect(calls.map((c) => c.cmd)).not.toContain('claude');
    expect(calls.every((c) => c.cmd === 'git')).toBe(true);
    expect(calls.some((c) => c.args.includes('commit'))).toBe(true);
    expect(calls.some((c) => c.args.includes('apply'))).toBe(false);
  });

  it('prepare applies the start-state diff with git apply and leaves one commit (real git)', () => {
    put(path.join(appDir, 'src/index.js'), 'export const one = 1;\n');
    const seed = path.join(root, 'seed');
    mkdirSync(seed);
    put(path.join(seed, 'src/index.js'), 'export const one = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: seed });
    execFileSync('git', ['add', '-A'], { cwd: seed });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'seed'],
      { cwd: seed },
    );
    writeFileSync(path.join(seed, 'src/index.js'), 'export const one = 2;\n');
    const patch = execFileSync('git', ['diff'], { cwd: seed, encoding: 'utf8' });
    writeTask('kind-b', { startState: 'start.patch' });
    put(path.join(tasksDir, 'kind-b/start.patch'), patch);
    const out = prepare({ task: 'kind-b', arm: 'blacksmith', dir: work }, deps(nodeSpawner));
    expect(readFileSync(path.join(work, 'src/index.js'), 'utf8')).toBe('export const one = 2;\n');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: work, encoding: 'utf8' });
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' })).toBe(
      '',
    );
    expect(out).toContain('Blacksmith');
  });

  it('prepare refuses a directory that is not empty and an unknown arm or kind', () => {
    writeTask('kind-a', {});
    put(path.join(work, 'x.txt'), 'x');
    const d = deps(fakeSpawner().spawn);
    expect(() => prepare({ task: 'kind-a', arm: 'plain', dir: work }, d)).toThrow(/not empty/);
    const fresh = path.join(root, 'fresh');
    expect(() => prepare({ task: 'kind-a', arm: 'other', dir: fresh }, d)).toThrow(/arm/);
    expect(() => prepare({ task: '../kind-a', arm: 'plain', dir: fresh }, d)).toThrow(/task/);
    expect(() => prepare({ task: 'missing', arm: 'plain', dir: fresh }, d)).toThrow(/manifest/);
  });

  it('prepare stops when the start state does not apply', () => {
    writeTask('kind-b', { startState: 'start.patch' });
    put(path.join(tasksDir, 'kind-b/start.patch'), 'not a patch');
    const { spawn } = fakeSpawner((c) =>
      c.args.includes('apply') ? { status: 1, stderr: 'bad patch' } : undefined,
    );
    expect(() => prepare({ task: 'kind-b', arm: 'plain', dir: work }, deps(spawn))).toThrow(
      /start state/,
    );
  });
});

describe('record', () => {
  const base = () => ({
    task: 'kind-a',
    arm: 'plain' as const,
    dir: work,
    cliSession: SID,
    claudeConfigDir: path.join(root, 'cfg'),
    results: path.join(root, 'out/results.jsonl'),
  });

  it('record runs the files of exactly the directories the manifest names, in the prepared copy', async () => {
    writeTask('kind-a', { f2p: { 'one.test.js': PASSING, 'two.test.js': PASSING } });
    const { spawn, calls } = fakeSpawner();
    const rec = await record(base(), deps(spawn));
    const runs = calls.filter((c) => c.cmd === 'node');
    expect(runs.map((c) => c.args)).toEqual([
      ['--test', '--test-reporter=tap', path.join(tasksDir, 'kind-a/gates/must-flip/one.test.js')],
      ['--test', '--test-reporter=tap', path.join(tasksDir, 'kind-a/gates/must-flip/two.test.js')],
      ['--test', '--test-reporter=tap', path.join(tasksDir, 'kind-a/gates/must-hold/b.test.js')],
    ]);
    expect(runs.every((c) => c.cwd === work)).toBe(true);
    expect(rec.check).toBe('passed');
  });

  it('record stores failed for one failing fail_to_pass file', async () => {
    writeTask('kind-a', { f2p: { 'a.test.js': PASSING, 'bad.test.js': FAILING } });
    const rec = await record(base(), deps(withFakeGit));
    expect(rec.check).toBe('failed');
  });

  it('record stores failed for one failing pass_to_pass file', async () => {
    writeTask('kind-a', { p2p: { 'b.test.js': PASSING, 'bad.test.js': FAILING } });
    const rec = await record(base(), deps(withFakeGit));
    expect(rec.check).toBe('failed');
  });

  it('record stores passed when every real check file passes', async () => {
    writeTask('kind-a', {});
    const rec = await record(base(), deps(withFakeGit));
    expect(rec.check).toBe('passed');
  });

  it('a check that runs no test is recorded as unknown', async () => {
    writeTask('kind-a', { f2p: { 'a.test.js': PASSING, 'empty.test.js': NO_TEST } });
    const rec = await record(base(), deps(withFakeGit));
    expect(rec.check).toBe('unknown');
  });

  it('a passing report that does not match the names the check declares is recorded as unknown', async () => {
    writeTask('kind-a', {});
    const { spawn } = fakeSpawner((c) =>
      c.cmd === 'node' ? { status: 0, stdout: 'ok 1 - any\n# pass 1\n' } : undefined,
    );
    const rec = await record(base(), deps(spawn));
    expect(rec.check).toBe('unknown');
  });

  it('an extra passing line beside the declared names is recorded as unknown', async () => {
    writeTask('kind-a', {});
    const { spawn } = fakeSpawner((c) =>
      c.cmd === 'node' ? { stdout: 'ok 1 - really runs\nok 2 - extra\n' } : undefined,
    );
    expect((await record(base(), deps(spawn))).check).toBe('unknown');
  });

  it('a skipped-only or todo-only check is recorded as unknown', async () => {
    const { spawn } = fakeSpawner((c) =>
      c.cmd === 'node' ? { stdout: 'ok 1 - case # SKIP\nok 2 - other # TODO\n' } : undefined,
    );
    writeTask('kind-a', {});
    expect((await record(base(), deps(spawn))).check).toBe('unknown');
  });

  it('record stores not-run when a named directory is missing or holds no test file', async () => {
    writeTask('kind-a', {});
    rmSync(path.join(tasksDir, 'kind-a/gates/must-hold'), { recursive: true });
    expect((await record(base(), deps(withFakeGit))).check).toBe('not-run');
    mkdirSync(path.join(tasksDir, 'kind-a/gates/must-hold'));
    put(path.join(tasksDir, 'kind-a/gates/must-hold/notes.txt'), 'no tests here');
    expect((await record(base(), deps(withFakeGit))).check).toBe('not-run');
  });

  it('record stores not-run for a manifest that is missing or names a path outside its task', async () => {
    writeTask('kind-a', {});
    put(
      path.join(tasksDir, 'kind-a/manifest.json'),
      JSON.stringify({ fail_to_pass: '../../outside', pass_to_pass: 'gates/must-hold' }),
    );
    expect((await record(base(), deps(withFakeGit))).check).toBe('not-run');
    await expect(record({ ...base(), task: 'nope' }, deps(withFakeGit))).rejects.toThrow(
      /manifest/,
    );
  });

  it('record stores unknown when the runner itself errors, never passed', async () => {
    writeTask('kind-a', {});
    const { spawn } = fakeSpawner((c) =>
      c.cmd === 'node' ? { status: null, error: true, stdout: '' } : undefined,
    );
    expect((await record(base(), deps(spawn))).check).toBe('unknown');
  });

  it('record keeps failed over unknown when both occur', async () => {
    writeTask('kind-a', { f2p: { 'a.test.js': NO_TEST, 'bad.test.js': FAILING } });
    expect((await record(base(), deps(withFakeGit))).check).toBe('failed');
  });

  it('record finds a transcript in a project directory named like a real one (leading dash)', async () => {
    writeTask('kind-a', {});
    const b = base();
    const realName = work.replace(/[\\/]/g, '-');
    expect(realName.startsWith('-')).toBe(true);
    transcript(
      b.claudeConfigDir,
      [asst('m1', '2026-01-01T10:00:00.000Z', 100), asst('m2', '2026-01-01T10:00:10.000Z', 50)],
      SID,
      realName,
    );
    const rec = await record(b, deps(fakeSpawner().spawn));
    expect(rec.tokens).toEqual({ used: 170, complete: true });
    expect(rec.wall_clock_ms).toBe(10000);
  });

  it('record asks for the TAP reporter so a passing run is not read as unknown', async () => {
    writeTask('kind-a', {});
    const { spawn, calls } = fakeSpawner((c) =>
      c.cmd === 'node' && !c.args.includes('--test-reporter=tap')
        ? { stdout: 'pass 1\n' }
        : undefined,
    );
    expect((await record(base(), deps(spawn))).check).toBe('passed');
    expect(
      calls.filter((c) => c.cmd === 'node').every((c) => c.args[1] === '--test-reporter=tap'),
    ).toBe(true);
  });

  it('record leaves the Blacksmith install directory out of the diff stats (real git)', async () => {
    writeTask('kind-a', {});
    prepare({ task: 'kind-a', arm: 'blacksmith', dir: work }, deps(nodeSpawner));
    put(path.join(work, '.blacksmith/factory/policies/stack.yml'), 'a\nb\nc\n');
    put(path.join(work, 'src/new.js'), 'export const two = 2;\n');
    const rec = await record({ ...base(), arm: 'blacksmith' }, deps(nodeSpawner));
    expect(rec.diff).toEqual({ files: 1, added: 1, removed: 0 });
  });

  it('record with no transcript stores tokens null and wall_clock_ms null', async () => {
    writeTask('kind-a', {});
    const rec = await record(base(), deps(fakeSpawner().spawn));
    expect(rec.tokens).toBeNull();
    expect(rec.wall_clock_ms).toBeNull();
    expect(rec.interventions).toBeNull();
  });

  it('record reads tokens through the transcript reader and wall clock from timestamps', async () => {
    writeTask('kind-a', {});
    const b = base();
    transcript(b.claudeConfigDir, [
      asst('m1', '2026-01-01T10:00:00.000Z', 100),
      asst('m2', '2026-01-01T10:01:30.500Z', 50),
    ]);
    const rec = await record({ ...b, interventions: 3 }, deps(fakeSpawner().spawn));
    expect(rec.tokens).toEqual({ used: 170, complete: true });
    expect(rec.wall_clock_ms).toBe(90500);
    expect(rec.interventions).toBe(3);
  });

  it('record does not estimate a wall clock from a single timestamp', async () => {
    writeTask('kind-a', {});
    const b = base();
    transcript(b.claudeConfigDir, [asst('m1', '2026-01-01T10:00:00.000Z', 100), { type: 'user' }]);
    const rec = await record(b, deps(fakeSpawner().spawn));
    expect(rec.tokens).toEqual({ used: 110, complete: true });
    expect(rec.wall_clock_ms).toBeNull();
  });

  it('record rejects a session id that is not a plain token and a bad interventions value', async () => {
    writeTask('kind-a', {});
    const d = deps(fakeSpawner().spawn);
    await expect(record({ ...base(), cliSession: '../x' }, d)).rejects.toThrow(/session/);
    await expect(record({ ...base(), interventions: -1 }, d)).rejects.toThrow(/interventions/);
    await expect(record({ ...base(), interventions: 1.5 }, d)).rejects.toThrow(/interventions/);
  });

  it('the record field set matches the plan list exactly', async () => {
    writeTask('kind-a', {});
    const rec = await record(base(), deps(fakeSpawner().spawn));
    expect(Object.keys(rec).sort()).toEqual(
      [
        'task_kind',
        'arm',
        'check',
        'tokens',
        'wall_clock_ms',
        'diff',
        'interventions',
        'cli_session_id',
        'recorded_at',
        'harness_version',
      ].sort(),
    );
    expect(Object.keys(rec.diff).sort()).toEqual(['added', 'files', 'removed']);
    expect(rec.recorded_at).toBe(NOW.toISOString());
    expect(rec.cli_session_id).toBe(SID);
  });

  it('record appends one JSON line per run to the results file', async () => {
    writeTask('kind-a', {});
    const b = base();
    await record(b, deps(fakeSpawner().spawn));
    await record({ ...b, arm: 'blacksmith' }, deps(fakeSpawner().spawn));
    const lines = readFileSync(b.results, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1] ?? '') as TrialRecord).arm).toBe('blacksmith');
  });

  it('record measures the diff against the start commit including new files (real git)', async () => {
    writeTask('kind-a', {});
    prepare({ task: 'kind-a', arm: 'plain', dir: work }, deps(nodeSpawner));
    writeFileSync(
      path.join(work, 'src/index.js'),
      'export const one = 1;\nexport const two = 2;\n',
    );
    put(path.join(work, 'src/new.js'), 'a\nb\nc\n');
    const rec = await record(base(), deps(nodeSpawner));
    expect(rec.diff).toEqual({ files: 2, added: 4, removed: 0 });
  });

  it('record fails loudly when git cannot measure the diff', async () => {
    writeTask('kind-a', {});
    const { spawn } = fakeSpawner((c) => (c.cmd === 'git' ? { status: 128 } : undefined));
    await expect(record(base(), deps(spawn))).rejects.toThrow(/diff/);
  });
});

describe('summarize', () => {
  const rec = (over: Partial<TrialRecord>): TrialRecord => ({
    task_kind: 'kind-a',
    arm: 'plain',
    check: 'passed',
    tokens: { used: 1000, complete: true },
    wall_clock_ms: 60000,
    diff: { files: 2, added: 10, removed: 4 },
    interventions: 1,
    cli_session_id: SID,
    recorded_at: NOW.toISOString(),
    harness_version: '1',
    ...over,
  });
  const file = () => path.join(root, 'r.jsonl');
  const write = (recs: unknown[]) =>
    writeFileSync(file(), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);

  it('summarize prints NOT MEASURED for every missing value and says single run', () => {
    write([rec({ tokens: null, wall_clock_ms: null, interventions: null, check: 'not-run' })]);
    const out = summarize({ results: file() });
    expect(out).toContain('single run');
    expect(out.match(/NOT MEASURED/g)?.length).toBeGreaterThanOrEqual(3);
    expect(out).not.toMatch(/mean/);
  });

  it('summarize labels each cell with its run count and means only measured values', () => {
    write([
      rec({ tokens: { used: 1000, complete: true } }),
      rec({ tokens: { used: 3000, complete: true } }),
      rec({ tokens: null }),
      rec({ arm: 'blacksmith', tokens: { used: 500, complete: false } }),
    ]);
    const out = summarize({ results: file() });
    expect(out).toContain('3 runs');
    expect(out).toContain('mean of 2 of 3 runs');
    expect(out).toContain('2000');
    expect(out).toContain('single run');
    expect(out).toContain('at least 500');
    expect(out).not.toMatch(/ratio|\d+(\.\d+)?x\b|%/);
  });

  it('summarize counts check outcomes and never shows passed for a not-run check', () => {
    write([rec({ check: 'not-run' }), rec({ check: 'unknown' }), rec({ check: 'failed' })]);
    const out = summarize({ results: file() });
    expect(out).toContain('1 failed');
    expect(out).toContain('1 not-run');
    expect(out).toContain('1 unknown');
    expect(out).not.toContain('passed');
  });

  it('summarize skips unreadable lines, says so, and handles an empty or missing file', () => {
    writeFileSync(file(), `${JSON.stringify(rec({}))}\nnot json\n{"task_kind":1}\n`);
    expect(summarize({ results: file() })).toContain('2 unreadable lines skipped');
    writeFileSync(file(), '');
    expect(summarize({ results: file() })).toContain('No runs recorded');
    expect(summarize({ results: path.join(root, 'absent.jsonl') })).toContain('No runs recorded');
  });

  it('summarize prints one table per task kind with a row per arm', () => {
    write([rec({}), rec({ arm: 'blacksmith' }), rec({ task_kind: 'kind-b' })]);
    const out = summarize({ results: file() });
    expect(out).toContain('## kind-a');
    expect(out).toContain('## kind-b');
    expect(out.indexOf('plain')).toBeLessThan(out.indexOf('blacksmith'));
    expect(readdirSync(root)).toContain('r.jsonl');
  });
});
