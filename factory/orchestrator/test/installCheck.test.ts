import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Check,
  CLAUDE_CHECK_COMMAND,
  type DoctorDeps,
  doctorExitCode,
  formatChecks,
  PLUGIN_INSTALL_COMMANDS,
  type RunResult,
  runChecks,
} from '../src/installCheck.js';
import { CONCURRENCY_CAPS } from '../src/workroot.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const done = (stdout: string, status = 0): RunResult => ({ status, stdout });
const FAKE_ROOT = '/path/to/install';

/** Everything healthy; each test overrides the one thing it probes. */
function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: 'v22.3.0',
    enginesNode: '>=22',
    bsVersion: '1.2.3',
    root: FAKE_ROOT,
    env: { ...CONCURRENCY_CAPS },
    home: '/home/u',
    readFile: () => {
      throw new Error('ENOENT');
    },
    exists: () => true,
    run: (cmd) => {
      if (cmd === 'claude') return done('Installed plugins:\n  blacksmith@blacksmith\n');
      return done('9.3.0\n');
    },
    ...over,
  };
}

function check(over: Partial<DoctorDeps>, id: string): Check {
  const found = runChecks(deps(over)).find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe('installCheck probes', () => {
  it('lists the probes in a fixed order', () => {
    expect(runChecks(deps()).map((c) => c.id)).toEqual([
      'node',
      'pnpm',
      'git',
      'bs',
      'claude',
      'plugin',
      'dashboard',
      'concurrency-caps',
    ]);
    expect(runChecks(deps()).every((c) => c.status === 'ok')).toBe(true);
  });

  it('node: ok at the engines floor, missing below it, unknown on an unreadable range', () => {
    expect(check({ nodeVersion: 'v22.0.0' }, 'node').status).toBe('ok');
    const old = check({ nodeVersion: 'v20.11.1' }, 'node');
    expect(old.status).toBe('missing');
    expect(old.fix).not.toBe('');
    expect(check({ enginesNode: '^22 || ^24' }, 'node').status).toBe('unknown');
    expect(check({ enginesNode: undefined }, 'node').status).toBe('unknown');
  });

  it.each(['pnpm', 'git'])('%s: ok, missing when not found, unknown on timeout', (tool) => {
    const run = (res: RunResult) => (cmd: string) => (cmd === tool ? res : deps().run(cmd, [], 1));
    expect(check({ run: run(done('1.0\n')) }, tool).status).toBe('ok');
    expect(check({ run: run({ status: null, stdout: '', error: 'ENOENT' }) }, tool).status).toBe(
      'missing',
    );
    expect(check({ run: run({ status: null, stdout: '', error: 'ETIMEDOUT' }) }, tool).status).toBe(
      'unknown',
    );
  });

  it('bs: reports the version, unknown when none is readable', () => {
    expect(check({}, 'bs').detail).toContain('1.2.3');
    expect(check({ bsVersion: undefined }, 'bs').status).toBe('unknown');
  });

  it('claude: ok, missing on ENOENT, unknown on timeout or odd exit', () => {
    const run = (res: RunResult) => (cmd: string) => (cmd === 'claude' ? res : done('1\n'));
    expect(check({ run: run(done('2.1.0 (Claude Code)\n')) }, 'claude').status).toBe('ok');
    const gone = check({ run: run({ status: null, stdout: '', error: 'ENOENT' }) }, 'claude');
    expect(gone.status).toBe('missing');
    expect(gone.fix).toContain(CLAUDE_CHECK_COMMAND);
    expect(
      check({ run: run({ status: null, stdout: '', error: 'ETIMEDOUT' }) }, 'claude').status,
    ).toBe('unknown');
    expect(check({ run: run(done('', 3)) }, 'claude').status).toBe('unknown');
  });

  describe('plugin', () => {
    const withList = (res: RunResult) => ({
      run: (cmd: string) => (cmd === 'claude' ? res : done('1\n')),
    });

    it('ok when the listing names blacksmith@blacksmith', () => {
      expect(
        check(withList(done('  blacksmith@blacksmith\n    Status: enabled\n')), 'plugin').status,
      ).toBe('ok');
    });

    it('missing when the listing is recognised and does not name it', () => {
      const other = check(withList(done('  bs-mod@blacksmith\n')), 'plugin');
      expect(other.status).toBe('missing');
      for (const cmd of PLUGIN_INSTALL_COMMANDS) expect(other.fix).toContain(cmd);
      expect(check(withList(done('No plugins installed.\n')), 'plugin').status).toBe('missing');
    });

    it('unknown on unparseable output, never ok', () => {
      expect(check(withList(done('\u001b[2J garbled <html>')), 'plugin').status).toBe('unknown');
      expect(check(withList(done('')), 'plugin').status).toBe('unknown');
    });

    it('unknown on a spawn error, a timeout or a failing exit', () => {
      expect(check(withList({ status: null, stdout: '', error: 'ENOENT' }), 'plugin').status).toBe(
        'unknown',
      );
      expect(
        check(withList({ status: null, stdout: '', error: 'ETIMEDOUT' }), 'plugin').status,
      ).toBe('unknown');
      expect(check(withList(done('blacksmith@blacksmith', 1)), 'plugin').status).toBe('unknown');
    });
  });

  it('dashboard: ok when both built outputs exist, missing otherwise', () => {
    expect(check({}, 'dashboard').status).toBe('ok');
    const missing = check({ exists: (p) => !p.includes('server') }, 'dashboard');
    expect(missing.status).toBe('missing');
    expect(missing.fix).not.toBe('');
  });

  it('exits non-zero only when a check is missing', () => {
    const ok: Check = { id: 'a', status: 'ok', detail: '', fix: '' };
    const unknown: Check = { ...ok, status: 'unknown' };
    expect(doctorExitCode([ok, unknown])).toBe(0);
    expect(doctorExitCode([ok, { ...ok, status: 'missing' }])).toBe(1);
  });

  it('INSTALL.md carries the exact commands the fixes quote', () => {
    const doc = readFileSync(path.join(REPO_ROOT, 'INSTALL.md'), 'utf8');
    expect(doc).toContain(CLAUDE_CHECK_COMMAND);
    for (const cmd of PLUGIN_INSTALL_COMMANDS) expect(doc).toContain(cmd);
    expect(doc).toContain('bs doctor');
  });
});

describe('installCheck extra edges', () => {
  it('plugin: a lookalike name is not blacksmith@blacksmith', () => {
    const run = (cmd: string) =>
      cmd === 'claude' ? done('  xblacksmith@blacksmith\n') : done('1\n');
    expect(check({ run }, 'plugin').status).toBe('missing');
  });

  it('plugin and claude probes ask for exactly the read-only commands', () => {
    const seen: string[] = [];
    runChecks(
      deps({
        run: (cmd, args) => {
          seen.push(`${cmd} ${args.join(' ')}`);
          return done('blacksmith@blacksmith\n');
        },
      }),
    );
    expect(seen).toContain('claude plugin list');
    expect(seen).toContain('claude --version');
    expect(seen.every((s) => /--version$|plugin list$/.test(s))).toBe(true);
  });

  it('node: accepts a full semver floor', () => {
    expect(check({ enginesNode: '>=22.0.0', nodeVersion: 'v21.9.0' }, 'node').status).toBe(
      'missing',
    );
    expect(check({ enginesNode: '>=22.0.0', nodeVersion: 'v22.1.0' }, 'node').status).toBe('ok');
  });

  it('formatChecks: one line per check, fix shown only when not ok', () => {
    const lines = formatChecks([
      { id: 'a', status: 'ok', detail: 'fine', fix: '' },
      { id: 'b', status: 'missing', detail: 'gone', fix: 'do this' },
    ])
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('->');
    expect(lines[1]).toContain('do this');
  });
});

describe('concurrency-caps', () => {
  const [SUB, TOOL] = Object.keys(CONCURRENCY_CAPS) as [string, string];
  const caps = (sub: string, tool: string) => ({ [SUB]: sub, [TOOL]: tool });
  const files = (map: Record<string, string>) => (file: string) => {
    const body = map[file];
    if (body !== undefined) return body;
    throw new Error('ENOENT');
  };
  const settings = (env: Record<string, string>) => JSON.stringify({ env });
  const local = path.join(process.cwd(), '.claude', 'settings.local.json');
  const proj = path.join(process.cwd(), '.claude', 'settings.json');
  const user = '/home/u/.claude/settings.json';
  const caps_ = (over: Partial<DoctorDeps>) => check(over, 'concurrency-caps');

  it('unset -> unknown, fix names bs init + restart before the user-settings route', () => {
    const c = caps_({ env: {} });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain(SUB);
    expect(c.fix.indexOf('bs init')).toBeGreaterThanOrEqual(0);
    expect(c.fix).toContain('restart Claude Code');
    expect(c.fix.indexOf('bs init')).toBeLessThan(c.fix.indexOf('user settings'));
    expect(c.fix).toContain('Raise the concurrency caps');
    expect(doctorExitCode([c])).toBe(0);
  });

  it('process env at the target, or at 64/32 -> ok', () => {
    expect(caps_({ env: { ...CONCURRENCY_CAPS } }).status).toBe('ok');
    expect(caps_({ env: caps('64', '32') }).status).toBe('ok');
  });

  it('compares numerically: "100" beats 20', () => {
    expect(caps_({ env: caps('100', '100') }).status).toBe('ok');
    expect(caps_({ env: caps('20', '10') }).status).toBe('unknown');
    expect(caps_({ env: caps('21', '11') }).status).toBe('ok');
  });

  it.each(['64k', '1e3', ' 64', '-1', ''])('non-integer %j -> unknown naming the value', (v) => {
    const c = caps_({ env: caps(v, '32') });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain(SUB);
    expect(c.detail).toContain(JSON.stringify(v));
  });

  it('only user settings at 20/10 -> unknown, naming the source', () => {
    const c = caps_({ env: {}, readFile: files({ [user]: settings(caps('20', '10')) }) });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain(user);
  });

  it('user settings above the defaults -> ok; CLAUDE_CONFIG_DIR moves the path', () => {
    const body = settings(caps('64', '32'));
    expect(caps_({ env: {}, readFile: files({ [user]: body }) }).status).toBe('ok');
    const moved = caps_({
      env: { CLAUDE_CONFIG_DIR: '/cfg' },
      readFile: files({ [user]: body }),
    });
    expect(moved.status).toBe('unknown');
    expect(
      caps_({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, readFile: files({ '/cfg/settings.json': body }) })
        .status,
    ).toBe('ok');
  });

  it('process env beats settings files; local beats project beats user', () => {
    const low = settings(caps('20', '10'));
    const high = settings(caps('64', '32'));
    const read = (map: Record<string, string>) => files(map);
    expect(caps_({ env: caps('64', '32'), readFile: read({ [local]: low }) }).status).toBe('ok');
    expect(caps_({ env: {}, readFile: read({ [local]: low, [proj]: high }) }).status).toBe(
      'unknown',
    );
    expect(caps_({ env: {}, readFile: read({ [local]: high, [proj]: low }) }).status).toBe('ok');
    expect(caps_({ env: {}, readFile: read({ [proj]: high, [user]: low }) }).status).toBe('ok');
    expect(caps_({ env: {}, readFile: read({ [proj]: low, [user]: high }) }).status).toBe(
      'unknown',
    );
  });

  it('invalid JSON is skipped with a note, never thrown', () => {
    const c = caps_({
      env: {},
      readFile: files({ [local]: '{not json', [user]: settings(caps('64', '32')) }),
    });
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('skipped');
    expect(c.detail).toContain(local);
  });

  it('accepts JSON numbers and rejects other JSON types in a settings env block', () => {
    const num = JSON.stringify({ env: { [SUB]: 64, [TOOL]: 32 } });
    expect(caps_({ env: {}, readFile: files({ [user]: num }) }).status).toBe('ok');
    const bool = JSON.stringify({ env: { [SUB]: true, [TOOL]: 32 } });
    const c = caps_({ env: {}, readFile: files({ [user]: bool }) });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain(SUB);
  });

  it('one variable low is enough to be unknown, and names only that one', () => {
    const c = caps_({ env: caps('64', '10') });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain(TOOL);
    expect(c.detail).not.toContain(`${SUB} is`);
  });

  it('echoes only the two variables it reads', () => {
    const c = caps_({
      env: {},
      readFile: files({
        [user]: JSON.stringify({ env: { ...caps('5', '5'), SECRET: 'hunter2' } }),
      }),
    });
    expect(JSON.stringify(c)).not.toContain('hunter2');
  });
});
