import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CheckState,
  redact,
  renderCheckState,
  renderChecksTable,
  renderMetricsTable,
} from '../src/reportExport.js';

const HOME = { homeDir: '/opt/example-home' };

describe('redact', () => {
  const cases: Array<[string, string, string]> = [
    ['/Users form', '/Users/example-user/repo/x.ts', '<home>/repo/x.ts'],
    ['/home form', '/home/example-user/repo', '<home>/repo'],
    ['/root alone', '/root', '<home>'],
    ['/root with a subpath', '/root/x', '<home>/x'],
    ['Windows backslash', 'C:\\Users\\example-user\\repo', '<home>\\repo'],
    ['Windows forward slash', 'D:/Users/example-user/repo', '<home>/repo'],
    ['Windows JSON-escaped', 'C:\\\\Users\\\\example-user\\\\repo', '<home>\\\\repo'],
    ['file:// URL over /Users', 'file:///Users/example-user/x', 'file://<home>/x'],
    ['file:// URL over a Windows path', 'file:///C:/Users/example-user/x', 'file:///<home>/x'],
    ['-Users- slug', 'projects/-Users-example-user-repo-x/a.jsonl', 'projects/<home-slug>/a.jsonl'],
    ['-home- slug', '-home-example-user-repo-x', '<home-slug>'],
    ['slug ended by a space', 'a -Users-example-user-x b', 'a <home-slug> b'],
    ['slug ended by a double quote', '"-home-example-user-x"', '"<home-slug>"'],
    ['slug ended by a single quote', "'-home-example-user-x'", "'<home-slug>'"],
    ['slug ended by a backtick', '`-Users-example-user-x`', '`<home-slug>`'],
    ['/private/tmp root', '/private/tmp/run-1/out.txt', '<tmp>'],
    ['/tmp root', 'see /tmp/run-1/out.txt now', 'see <tmp> now'],
    ['/var/folders root', '/var/folders/ab/cd/T/x', '<tmp>'],
    ['/private/var/folders root', '/private/var/folders/ab/cd/T/x', '<tmp>'],
    ['injected home outside /Users and /home', '/opt/example-home/repo/x.ts', '<home>/repo/x.ts'],
  ];

  for (const [name, input, expected] of cases) {
    it(`replaces the ${name}`, () => {
      expect(redact(input, HOME)).toBe(expected);
    });
  }

  it('keeps no part of a slug', () => {
    const out = redact('projects/-Users-example-user-repo-x/a.jsonl', HOME);
    expect(out).not.toContain('example');
    expect(out).not.toContain('user');
  });

  it('keeps /rootfs/x, repo-relative paths, ~/x and other absolute paths', () => {
    for (const kept of [
      '/rootfs/x',
      'src/reportExport.ts',
      'repo/tmp/x',
      '~/x',
      '/usr/bin/git',
      '/api/tasks',
    ]) {
      expect(redact(kept, HOME)).toBe(kept);
    }
  });

  it('leaves a string with no path unchanged', () => {
    expect(redact('3 of 4 checks passed', HOME)).toBe('3 of 4 checks passed');
  });

  it('is idempotent, including for a home segment named tmp or home', () => {
    const text = [
      '/Users/example-user/tmp/x /home/example-user/home/y /root/Users/z',
      'C:\\Users\\example-user\\r file:///tmp/a -Users-example-user-x /opt/example-home/tmp/q',
    ].join(' ');
    const once = redact(text, HOME);
    expect(once).not.toContain('example');
    expect(redact(once, HOME)).toBe(once);
  });

  for (const homeDir of ['', '/']) {
    it(`ignores homeDir ${JSON.stringify(homeDir)} and still applies the fixed forms`, () => {
      expect(redact('/usr/bin/git /opt/x/y', { homeDir })).toBe('/usr/bin/git /opt/x/y');
      expect(redact('/Users/example-user/repo', { homeDir })).toBe('<home>/repo');
    });
  }

  it('matches a homeDir only as a whole path segment', () => {
    expect(redact('/opt/example-homes/x', HOME)).toBe('/opt/example-homes/x');
  });
});

describe('renderCheckState', () => {
  const states: CheckState[] = ['passed', 'failed', 'not-run', 'unknown'];

  it('gives each of the four states a distinct label', () => {
    const labels = states.map((s) => renderCheckState(s));
    expect(new Set(labels).size).toBe(4);
    expect(labels).toEqual(['passed', 'failed', 'not run', 'unknown']);
  });

  it('renders an absent state as "not run"', () => {
    expect(renderCheckState(undefined)).toBe('not run');
    expect(renderCheckState(null)).toBe('not run');
  });

  it('renders passed for nothing but the passed state', () => {
    for (const odd of ['', 'ok', 'PASSED', 0, true, {}]) {
      expect(renderCheckState(odd as unknown as CheckState)).not.toBe('passed');
    }
    expect(renderCheckState('passed')).toBe('passed');
  });
});

describe('section renderers', () => {
  it('renders a metrics table with NOT MEASURED for null and unmeasured values, never 0', () => {
    const out = renderMetricsTable(
      'Metrics',
      [
        { label: 'tokens', value: 1200 },
        { label: 'cost', value: null },
        { label: 'wall time', value: undefined },
        { label: 'ratio', value: Number.NaN },
        { label: 'zero is a measurement', value: 0 },
      ],
      HOME,
    );
    expect(out).toContain('## Metrics');
    expect(out).toContain('| tokens | 1200 |');
    expect(out).toContain('| cost | NOT MEASURED |');
    expect(out).toContain('| wall time | NOT MEASURED |');
    expect(out).toContain('| ratio | NOT MEASURED |');
    expect(out).toContain('| zero is a measurement | 0 |');
  });

  it('renders a per-task checks table keeping the four states distinct', () => {
    const out = renderChecksTable(
      'Checks',
      [
        { task: 't1', check: 'unit', state: 'passed' },
        { task: 't1', check: 'lint', state: 'failed', detail: 'a | b\nc' },
        { task: 't2', check: 'unit' },
        { task: 't2', check: 'e2e', state: 'unknown' },
      ],
      HOME,
    );
    expect(out).toContain('| t1 | unit | passed |');
    expect(out).toContain('| t1 | lint | failed | a \\| b c |');
    expect(out).toContain('| t2 | unit | not run |');
    expect(out).toContain('| t2 | e2e | unknown |');
  });
});

describe('rendered output carries no path form', () => {
  // Independent of the redactor: one pattern and one fixture per form.
  const forms: Array<[string, RegExp, string]> = [
    ['/Users', /\/Users\/example-user/, 'cwd /Users/example-user/repo'],
    ['/home', /\/home\/example-user/, 'cwd /home/example-user/repo'],
    ['/root', /\/root(?![A-Za-z0-9._-])/, 'cwd /root/repo'],
    ['C:\\Users', /[A-Za-z]:\\Users\\example-user/, 'cwd C:\\Users\\example-user\\repo'],
    ['C:/Users', /[A-Za-z]:\/Users\/example-user/, 'cwd C:/Users/example-user/repo'],
    ['escaped C:', /[A-Za-z]:\\\\Users\\\\example-user/, 'cwd C:\\\\Users\\\\example-user\\\\repo'],
    ['file://', /file:\/\/\/(?:Users|home)\/example-user/, 'at file:///home/example-user/repo'],
    ['-Users- slug', /-(?:Users|home)-[^\s/"'\x60]*/, 'in -Users-example-user-repo-x'],
    ['-home- slug', /-(?:Users|home)-[^\s/"'\x60]*/, 'in -home-example-user-repo-x'],
    ['/private/tmp', /\/private\/tmp\//, 'out /private/tmp/run-1/log'],
    ['/tmp', /\/tmp\//, 'out /tmp/run-1/log'],
    ['/var/folders', /\/var\/folders\//, 'out /var/folders/ab/cd/T/log'],
    ['/private/var/folders', /\/private\/var\/folders\//, 'out /private/var/folders/ab/cd/T/log'],
    ['homeDir', /\/opt\/example-home/, 'cwd /opt/example-home/repo'],
  ];

  for (const [name, pattern, fixture] of forms) {
    it(`${name} is absent from both renderers`, () => {
      expect(pattern.test(fixture)).toBe(true);
      const checks = renderChecksTable(
        `T ${fixture}`,
        [{ task: fixture, check: fixture, state: 'failed', detail: fixture }],
        HOME,
      );
      const metrics = renderMetricsTable(
        `T ${fixture}`,
        [{ label: fixture, value: 1, unit: fixture }],
        HOME,
      );
      expect(pattern.test(checks)).toBe(false);
      expect(pattern.test(metrics)).toBe(false);
      if (name.endsWith('slug')) {
        for (const out of [checks, metrics]) {
          expect(out).not.toContain('example');
          expect(out).not.toContain('user');
        }
      }
    });
  }
});

describe('module imports', () => {
  it('has no filesystem, network or os import', () => {
    const src = readFileSync(new URL('../src/reportExport.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '(?:node:)?(?:fs|os|net|http|https|child_process)[^']*'/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
