// What `bs new` scaffolds carries the CI flow: one gate script (`pnpm run
// check`), one CI job per tier, and a dormant sharded e2e workflow in the `ui`
// layer. Every test runs the real scaffold output: the gate script with `node`
// against stub commands, and the workflows' own `run:` lines with `bash`.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, SCAFFOLD_DIR } from '../src/paths.js';
import { scaffoldProject, TOOLCHAIN_STEPS } from '../src/scaffold.js';
import type { StackAnswers } from '../src/stack.js';
import { assertCheckTier, CHECK_TIERS, type CheckCommand, selectTier } from '../src/testgate.js';
import { runProcess } from './helpers/process.js';

let scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

const UI_STACK: StackAnswers = {
  language: 'typescript',
  frontend: 'vue',
  designSystem: 'none',
  designSystemSource: '',
  styling: 'plain-css',
  backend: 'none',
  database: 'none',
  orm: 'none',
  packageManager: 'pnpm',
  repoShape: 'single',
  lint: 'biome',
  testUnit: 'vitest',
  testE2e: 'playwright',
  ci: 'github-actions',
  hosting: 'unspecified',
};

/** A freshly scaffolded project (no git, no install) in a scratch directory. */
function fresh(ui: boolean): string {
  const workDir = mkdtempSync(path.join(tmpdir(), 'smith-scaffold-ci-'));
  scratchDirs.push(workDir);
  const targetDir = path.join(workDir, 'acme-ci');
  scaffoldProject({
    projectName: 'acme-ci',
    ui,
    targetDir,
    templateDir: SCAFFOLD_DIR,
    repoRoot: REPO_ROOT,
    skipGit: true,
    skipToolchain: true,
    ...(ui ? { stack: UI_STACK } : {}),
  });
  return targetDir;
}

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML has no static shape
type Doc = Record<string, any>;

function workflow(dir: string, file: 'ci.yml' | 'e2e.yml'): Doc {
  return parseYaml(readFileSync(path.join(dir, '.github', 'workflows', file), 'utf8')) as Doc;
}

/** `on` is a string key under YAML 1.2; the 1.1 boolean reading is tolerated. */
const onOf = (wf: Doc): Doc => wf.on ?? wf.true;

const repoCi = parseYaml(
  readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
) as Doc;

const writeChecks = (dir: string, value: unknown): void =>
  writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(value), 'utf8');

const setScripts = (dir: string, scripts: Record<string, string>): void => {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, ...scripts } }), 'utf8');
};

const check = (dir: string, args: string[]) =>
  runProcess('node', ['scripts/check.mjs', ...args], { cwd: dir });

const listOf = (dir: string, args: string[]): string[] => {
  const run = check(dir, [...args, '--list']);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim()) as string[];
};

const bash = (script: string, cwd: string, env: Record<string, string> = {}) =>
  runProcess('bash', ['-eo', 'pipefail', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
  });

/** The `run:` of the one step of `job` matching `pred`. */
function runOf(job: Doc, pred: (step: Doc) => boolean): string {
  const step = (job.steps as Doc[]).find(pred);
  expect(step, 'no such step').toBeDefined();
  return step?.run as string;
}

const trace = (dir: string): string[] => {
  const file = path.join(dir, 'trace.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

const echo = (word: string): string => `echo ${word} >> trace.txt`;

/** A GitHub Actions expression, `${{ body }}`. */
const expr = (body: string): string => `\${{ ${body} }}`;

const ifOf = (tier: string): string =>
  `\${{ !cancelled() && needs.tiers.outputs.${tier} != 'false' }}`;

/** Run the `tiers` job's step against `dir`; the outputs it wrote, one per line. */
function tiersStep(dir: string) {
  const script = runOf(workflow(dir, 'ci.yml').jobs.tiers, (s) =>
    String(s.run).includes('check.mjs'),
  );
  const out = path.join(dir, 'github-output.txt');
  writeFileSync(out, '', 'utf8');
  const run = bash(script, dir, { GITHUB_OUTPUT: out });
  return { run, outputs: readFileSync(out, 'utf8').split('\n').filter(Boolean) };
}

describe.each([false, true])('the scaffold CI flow (ui: %s)', (ui) => {
  it('writes the gate script, a `check` script and one CI job per tier', () => {
    const dir = fresh(ui);
    expect(existsSync(path.join(dir, 'scripts', 'check.mjs'))).toBe(true);
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.check).toBe('node scripts/check.mjs');

    const ci = workflow(dir, 'ci.yml');
    expect(ci.jobs.tiers).toBeDefined();
    for (const tier of CHECK_TIERS) {
      const job = ci.jobs[tier];
      expect(job.needs, `${tier} needs`).toBe('tiers');
      expect(job.if, `${tier} if`).toBe(ifOf(tier));
      const runs = (job.steps as Doc[]).map((s) => s.run ?? '');
      expect(runs, `${tier} steps`).toContain(`node scripts/check.mjs --tier ${tier} --ci`);
      // The gate script is the only check step beside the install.
      expect(runs.filter((r: string) => r !== '' && !r.startsWith('pnpm install'))).toEqual([
        `node scripts/check.mjs --tier ${tier} --ci`,
      ]);
    }
    expect(ci.concurrency.group).toBe(repoCi.concurrency.group);
    expect(ci.concurrency['cancel-in-progress']).toBe(repoCi.concurrency['cancel-in-progress']);
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(onOf(ci).push.branches).toEqual(expect.arrayContaining(['main', 'setup']));
    expect(onOf(ci).pull_request).toBeDefined();
  });

  it('scaffolds no checks.json and no layer holds one', () => {
    expect(existsSync(path.join(fresh(ui), 'checks.json'))).toBe(false);
  });
});

describe('the gate script follows bs (no drift)', () => {
  const entry = (name: string, tier?: unknown) => ({
    name,
    cmd: echo(name),
    ...(tier === undefined ? {} : { tier }),
  });

  it('selects exactly what selectTier selects, for every tier', () => {
    const dir = fresh(false);
    const checks: CheckCommand[] = [
      entry('a'),
      entry('b', 'post-merge'),
      entry('c', 'pre-release'),
      entry('d', 'pre-merge'),
      entry('e', 'post-merge'),
    ] as CheckCommand[];
    writeChecks(dir, checks);
    for (const tier of CHECK_TIERS) {
      expect(listOf(dir, ['--tier', tier]), tier).toEqual(
        selectTier(checks, tier).map((c) => c.name),
      );
    }
    expect(listOf(dir, ['--tier', 'all'])).toEqual(checks.map((c) => c.name));
    expect(listOf(dir, [])).toEqual(checks.map((c) => c.name));
  });

  it('refuses exactly the tier values assertCheckTier refuses', () => {
    const dir = fresh(false);
    for (const bad of ['post_merge', 'Pre-merge', '', null, 1, true]) {
      expect(() => assertCheckTier({ name: 'x', cmd: 'true', tier: bad } as never, 'f')).toThrow();
      writeChecks(dir, [entry('base'), entry('x', bad)]);
      const run = check(dir, ['--tier', 'pre-merge', '--list']);
      expect(run.status, `tier ${JSON.stringify(bad)}`).not.toBe(0);
      expect(run.stderr + run.stdout).toContain('checks.json');
    }
    for (const good of [...CHECK_TIERS, undefined]) {
      expect(() =>
        assertCheckTier({ name: 'x', cmd: 'true', tier: good } as never, 'f'),
      ).not.toThrow();
      writeChecks(dir, [entry('base'), entry('x', good)]);
      expect(check(dir, ['--tier', 'pre-merge', '--list']).status, String(good)).toBe(0);
    }
  });

  it("without checks.json lists the scaffold's own gates in TOOLCHAIN_STEPS order, all pre-merge", () => {
    const dir = fresh(false);
    const gates = TOOLCHAIN_STEPS.map((s) => s.name).filter((n) => n !== 'install');
    expect(gates).toHaveLength(5);
    expect(listOf(dir, [])).toEqual(gates);
    expect(listOf(dir, ['--tier', 'pre-merge'])).toEqual(gates);
    expect(listOf(dir, ['--tier', 'post-merge'])).toEqual([]);
    const script = readFileSync(path.join(dir, 'scripts', 'check.mjs'), 'utf8');
    for (const step of TOOLCHAIN_STEPS.filter((s) => s.name !== 'install')) {
      expect(script).toContain(step.name);
    }
  });
});

describe('the gate script run', () => {
  it('runs entries in file order, stops at the first red, and never needs GitHub Actions', () => {
    const dir = fresh(false);
    writeChecks(dir, [
      { name: 'one', cmd: echo('one') },
      { name: 'two', cmd: `${echo('two')}; exit 3` },
      { name: 'three', cmd: echo('three') },
    ]);
    const red = check(dir, []);
    expect(red.status).toBe(1);
    expect(trace(dir)).toEqual(['one', 'two']);

    writeChecks(dir, [
      { name: 'one', cmd: echo('x1') },
      { name: 'two', cmd: echo('x2') },
    ]);
    const green = check(dir, []);
    expect(green.status, green.stderr).toBe(0);
    expect(trace(dir)).toEqual(['one', 'two', 'x1', 'x2']);
  });

  it('ends a check at its timeout_ms and kills its process group', () => {
    const dir = fresh(false);
    writeChecks(dir, [{ name: 'slow', cmd: 'sleep 5', timeout_ms: 200 }]);
    const started = Date.now();
    const run = check(dir, []);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toContain('timed out');

    writeChecks(dir, [
      { name: 'slow', cmd: 'sleep 30 & echo $! > pid.txt; wait', timeout_ms: 300 },
    ]);
    // A survivor would hold the captured output open until it exits on its own.
    const groupStarted = Date.now();
    expect(check(dir, []).status).toBe(1);
    expect(Date.now() - groupStarted).toBeLessThan(5000);
    const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        runProcess('node', ['-e', 'setTimeout(()=>{},100)']);
      } catch {
        alive = false;
      }
    }
    expect(alive, 'the check left a child of its process group running').toBe(false);
  });

  it('refuses a checks.json that is not a non-empty array, naming the file', () => {
    const dir = fresh(false);
    for (const bad of [[], {}, 'x', null]) {
      writeChecks(dir, bad);
      const run = check(dir, []);
      expect(run.status, JSON.stringify(bad)).toBe(1);
      expect(run.stdout + run.stderr).toContain('checks.json');
    }
  });

  it('refuses invalid entries, with the rules bs applies', () => {
    const dir = fresh(false);
    for (const bad of [
      { name: 'x', cmd: 'true', heavy: 'false' },
      { name: 'x', cmd: 'true', timeout_ms: 0 },
      { name: 'x', cmd: 'true', timeout_ms: 1.5 },
      { name: 'x', cmd: 'true', timeout_ms: 2147483648 },
      { name: 'x' },
      { cmd: 'true' },
    ]) {
      writeChecks(dir, [bad]);
      expect(check(dir, ['--list']).status, JSON.stringify(bad)).toBe(1);
    }
    writeChecks(dir, [{ name: 'x', cmd: 'true', heavy: true, timeout_ms: 1000 }]);
    expect(check(dir, []).status).toBe(0);
  });

  it('never exits 0 on an empty selection', () => {
    const dir = fresh(false);
    writeChecks(dir, [{ name: 'a', cmd: echo('a') }]);
    for (const tier of ['post-merge', 'pre-release']) {
      const run = check(dir, ['--tier', tier]);
      expect(run.status, tier).toBe(1);
      expect(run.stdout).toContain(`no checks in tier ${tier}`);
      // A query, not a result: --list of an empty tier is `[]` and exit 0.
      expect(check(dir, ['--tier', tier, '--list']).stdout.trim()).toBe('[]');
      expect(check(dir, ['--tier', tier, '--list']).status).toBe(0);
    }
    expect(trace(dir)).toEqual([]);
  });

  it('refuses a file with no pre-merge entry for --tier pre-merge, and counts the e2e omission after', () => {
    const dir = fresh(true);
    writeChecks(dir, [{ name: 'later', cmd: echo('later'), tier: 'post-merge' }]);
    for (const extra of [[], ['--list'], ['--ci'], ['--ci', '--list']]) {
      const run = check(dir, ['--tier', 'pre-merge', ...extra]);
      expect(run.status, extra.join(' ')).toBe(1);
      expect(run.stdout + run.stderr).toContain('checks.json');
    }
    expect(trace(dir)).toEqual([]);

    setScripts(dir, { 'test:e2e': 'playwright test' });
    writeChecks(dir, [{ name: 'e2e', cmd: 'pnpm run test:e2e' }]);
    const list = check(dir, ['--tier', 'pre-merge', '--ci', '--list']);
    expect(list.status).toBe(0);
    expect(list.stdout.trim()).toBe('[]');
    const run = check(dir, ['--tier', 'pre-merge', '--ci']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('no checks in tier pre-merge');
  });
});

describe('the tiers job step', () => {
  it('writes one output per tier from the --ci lists, and fails on a refused file', () => {
    const dir = fresh(true);
    const first = tiersStep(dir);
    expect(first.run.status, first.run.stderr).toBe(0);
    expect(first.outputs).toEqual(['pre-merge=true', 'post-merge=false', 'pre-release=false']);
    expect(first.run.stdout).toMatch(/post-merge.*skipped/);

    writeChecks(dir, [
      { name: 'a', cmd: echo('a') },
      { name: 'b', cmd: echo('b'), tier: 'post-merge' },
    ]);
    expect(tiersStep(dir).outputs).toEqual([
      'pre-merge=true',
      'post-merge=true',
      'pre-release=false',
    ]);

    setScripts(dir, { 'test:e2e': 'playwright test' });
    writeChecks(dir, [{ name: 'e2e', cmd: 'pnpm run test:e2e' }]);
    expect(tiersStep(dir).outputs).toEqual([
      'pre-merge=false',
      'post-merge=false',
      'pre-release=false',
    ]);

    writeChecks(dir, [{ name: 'b', cmd: echo('b'), tier: 'post-merge' }]);
    expect(tiersStep(dir).run.status).not.toBe(0);
  });
});

describe('the CI command shape', () => {
  it("each tier job's run line selects exactly its own tier", () => {
    const dir = fresh(false);
    writeChecks(dir, [
      { name: 'pre', cmd: echo('pre') },
      { name: 'post', cmd: echo('post'), tier: 'post-merge' },
      { name: 'rel', cmd: echo('rel'), tier: 'pre-release' },
    ]);
    const ci = workflow(dir, 'ci.yml');
    for (const [tier, word] of [
      ['pre-merge', 'pre'],
      ['post-merge', 'post'],
      ['pre-release', 'rel'],
    ] as const) {
      rmSync(path.join(dir, 'trace.txt'), { force: true });
      const run = bash(
        runOf(ci.jobs[tier], (s) => String(s.run).includes('check.mjs')),
        dir,
      );
      expect(run.status, run.stderr).toBe(0);
      expect(trace(dir), tier).toEqual([word]);
    }
  });

  it('tolerates the `--` pnpm forwards, through node and through `pnpm run check`', () => {
    const dir = fresh(false);
    writeChecks(dir, [
      { name: 'pre', cmd: echo('pre') },
      { name: 'post', cmd: echo('post'), tier: 'post-merge' },
    ]);
    const direct = runProcess(
      'node',
      ['scripts/check.mjs', '--', '--tier', 'post-merge', '--list'],
      {
        cwd: dir,
      },
    );
    expect(JSON.parse(direct.stdout.trim())).toEqual(['post']);

    const viaPnpm = runProcess('pnpm', ['run', 'check', '--', '--tier', 'post-merge', '--list'], {
      cwd: dir,
    });
    expect(viaPnpm.status, viaPnpm.stderr).toBe(0);
    const json = viaPnpm.stdout.split('\n').filter((l) => l.startsWith('['));
    expect(json.map((l) => JSON.parse(l))).toEqual([['post']]);
  });
});

describe('nothing a project declares is dropped from CI', () => {
  const declared = (e2eCmd: string) => [
    { name: 'unit', cmd: echo('unit') },
    { name: 'e2e', cmd: e2eCmd, tier: 'post-merge' },
    { name: 'audit', cmd: echo('audit'), tier: 'pre-release' },
  ];

  /** Run every tier job whose --ci list is non-empty; names listed per tier. */
  function tierJobs(dir: string): Record<string, string[]> {
    const lists: Record<string, string[]> = {};
    for (const tier of CHECK_TIERS) {
      lists[tier] = listOf(dir, ['--tier', tier, '--ci']);
      if (lists[tier]?.length) expect(check(dir, ['--tier', tier, '--ci']).status).toBe(0);
    }
    return lists;
  }

  it('leaves `pnpm run test:e2e` to e2e.yml once, and runs every other entry exactly once', () => {
    const dir = fresh(true);
    setScripts(dir, { 'test:e2e': 'playwright test' });
    writeChecks(dir, declared('pnpm run test:e2e'));
    const e2e = workflow(dir, 'e2e.yml');
    const shardRun = runOf(e2e.jobs.shard, (s) => String(s.run).includes('test:e2e --shard'));

    const lists = tierJobs(dir);
    expect(lists).toEqual({ 'pre-merge': ['unit'], 'post-merge': [], 'pre-release': ['audit'] });
    expect(trace(dir)).toEqual(['unit', 'audit']);
    expect(shardRun.startsWith('pnpm run test:e2e')).toBe(true);

    const note = check(dir, ['--tier', 'post-merge', '--ci']);
    expect(note.stdout).toContain('test:e2e');
    expect(note.stdout).toMatch(/left to/);
    const step = tiersStep(dir);
    expect(step.outputs).toEqual(['pre-merge=true', 'post-merge=false', 'pre-release=true']);
  });

  it('runs an e2e entry with another command in its own tier job', () => {
    const dir = fresh(true);
    setScripts(dir, { 'test:e2e': 'playwright test' });
    writeChecks(dir, declared(echo('other-e2e')));
    expect(listOf(dir, ['--tier', 'post-merge', '--ci'])).toEqual(['e2e']);
    expect(check(dir, ['--tier', 'post-merge', '--ci']).status).toBe(0);
    expect(trace(dir)).toEqual(['other-e2e']);
    const shardRun = runOf(workflow(dir, 'e2e.yml').jobs.shard, (s) =>
      String(s.run).includes('--shard'),
    );
    expect(shardRun).toContain('pnpm run test:e2e');
  });

  it('leaves nothing out without the e2e workflow', () => {
    const dir = fresh(false);
    setScripts(dir, { 'test:e2e': 'playwright test' });
    writeChecks(dir, declared('pnpm run test:e2e'));
    expect(listOf(dir, ['--tier', 'post-merge', '--ci'])).toEqual(['e2e']);
  });

  it('runs the entry in its own tier job when e2e.yml is dormant (no test:e2e script)', () => {
    const dir = fresh(true);
    writeChecks(dir, declared('pnpm run test:e2e'));
    expect(listOf(dir, ['--tier', 'post-merge', '--ci'])).toEqual(['e2e']);
    const run = check(dir, ['--tier', 'post-merge', '--ci']);
    expect(run.status).toBe(1);
  });
});

describe('the dormant e2e workflow (ui layer)', () => {
  it('ships in the ui layer only', () => {
    expect(existsSync(path.join(fresh(true), '.github', 'workflows', 'e2e.yml'))).toBe(true);
    expect(existsSync(path.join(fresh(false), '.github', 'workflows', 'e2e.yml'))).toBe(false);
  });

  it('gates the shards behind one detect job that reads package.json', () => {
    const dir = fresh(true);
    const wf = workflow(dir, 'e2e.yml');
    expect(wf.jobs.shard.needs).toBe('detect');
    expect(wf.jobs.shard.if).toBe("needs.detect.outputs.present == 'true'");

    const script = runOf(wf.jobs.detect, (s) => s.id === 'detect');
    const out = path.join(dir, 'github-output.txt');
    writeFileSync(out, '', 'utf8');
    const dormant = bash(script, dir, { GITHUB_OUTPUT: out });
    expect(dormant.status, dormant.stderr).toBe(0);
    expect(dormant.stdout).toContain('present=false');
    expect(readFileSync(out, 'utf8').trim()).toBe('present=false');

    setScripts(dir, { 'test:e2e': 'playwright test' });
    writeFileSync(out, '', 'utf8');
    const live = bash(script, dir, { GITHUB_OUTPUT: out });
    expect(live.stdout).toContain('present=true');
    expect(readFileSync(out, 'utf8').trim()).toBe('present=true');
  });

  it('shards over [1, 2] without fail-fast, caches the browser, and uploads without failing the run', () => {
    const wf = workflow(fresh(true), 'e2e.yml');
    const shard = wf.jobs.shard;
    expect(shard.strategy['fail-fast']).toBe(false);
    expect(shard.strategy.matrix.shard).toEqual([1, 2]);
    const steps = shard.steps as Doc[];
    const e2e = steps.find((s) => s.id === 'e2e');
    expect(e2e?.run).toBe(`pnpm run test:e2e --shard=${expr('matrix.shard')}/2`);

    const version = steps.find((s) => String(s.run ?? '').includes('playwright --version'));
    const cache = steps.find((s) => String(s.uses ?? '').startsWith('actions/cache'));
    expect(cache?.with.path).toBe('~/.cache/ms-playwright');
    expect(cache?.with.key).toContain(`steps.${version?.id}.outputs.version`);
    const install = steps.find((s) => String(s.run ?? '').endsWith('playwright install chromium'));
    expect(install?.if).toBe(`steps.${cache?.id}.outputs.cache-hit != 'true'`);
    const deps = steps.find((s) =>
      String(s.run ?? '').endsWith('playwright install-deps chromium'),
    );
    expect(deps?.if).toBeUndefined();

    const upload = steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
    expect(upload?.if).toBe("always() && steps.e2e.conclusion != 'skipped'");
    expect(upload?.['continue-on-error']).toBe(true);
    expect(upload?.with['if-no-files-found']).toBe('warn');
  });

  it('has a summary job that is skipped while dormant and fails unless every shard passed', () => {
    const dir = fresh(true);
    const summary = workflow(dir, 'e2e.yml').jobs.e2e;
    expect(summary.needs).toEqual(['detect', 'shard']);
    expect(summary.if).toBe(expr("!cancelled() && needs.detect.outputs.present != 'false'"));
    const script = runOf(summary, (s) => String(s.run).includes('SHARDS_RESULT'));
    expect(bash(script, dir, { SHARDS_RESULT: 'success' }).status).toBe(0);
    for (const result of ['failure', 'skipped', 'cancelled']) {
      expect(bash(script, dir, { SHARDS_RESULT: result }).status, result).not.toBe(0);
    }
  });

  it('fires on exactly the events ci.yml fires on', () => {
    const dir = fresh(true);
    expect(onOf(workflow(dir, 'e2e.yml'))).toEqual(onOf(workflow(dir, 'ci.yml')));
    expect(onOf(workflow(dir, 'e2e.yml')).push.branches).toEqual(['main', 'setup']);
  });

  it('keeps its own concurrency group, with the same cancel rule', () => {
    const dir = fresh(true);
    const ci = workflow(dir, 'ci.yml').concurrency;
    const e2e = workflow(dir, 'e2e.yml').concurrency;
    expect(e2e.group).not.toBe(ci.group);
    expect(ci.group.startsWith('ci-')).toBe(true);
    expect(e2e.group).toBe(ci.group.replace(/^ci-/, 'e2e-'));
    expect(e2e['cancel-in-progress']).toBe(ci['cancel-in-progress']);
    expect(workflow(dir, 'e2e.yml').permissions).toEqual({ contents: 'read' });
  });
});

describe('no tier is assigned by the scaffold', () => {
  const ALLOWED = [
    'base/scripts/check.mjs',
    'base/.github/workflows/ci.yml',
    'base/README.md',
    'base/AGENTS.md',
  ].map((p) => p.split('/').join(path.sep));

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );

  it('names the tiers only where they are put on purpose, and holds no checks.json', () => {
    const files = walk(SCAFFOLD_DIR).map((f) => path.relative(SCAFFOLD_DIR, f));
    expect(files.filter((f) => path.basename(f) === 'checks.json')).toEqual([]);
    const holding = files.filter((f) =>
      CHECK_TIERS.some((t) => readFileSync(path.join(SCAFFOLD_DIR, f), 'utf8').includes(t)),
    );
    expect(holding.filter((f) => !ALLOWED.includes(f))).toEqual([]);
    // No absolute home path in a template.
    for (const f of files) {
      expect(readFileSync(path.join(SCAFFOLD_DIR, f), 'utf8'), f).not.toMatch(/\/(Users|home)\//);
    }
  });

  it('has the script itself, in the base layer', () => {
    expect(existsSync(path.join(SCAFFOLD_DIR, 'base', 'scripts', 'check.mjs'))).toBe(true);
  });
});
