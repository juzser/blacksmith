import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCaptureStore } from '../src/promptCapture.js';

// Every tree here is a temp dir. The resolver is read-only, but the fixtures
// stand in for a factory clone, so none of them may be the real one.
let base: string;
let clone: string;
let roadmapPath: string;

const milestone = (id: string, project?: string): string =>
  `\n## ${id}\n- id: ${id}\n- status: completed\n${
    project === undefined ? '' : `- project: ${project}\n`
  }- epics: []\n- goal: whatever.\n`;

const writeRoadmap = (file: string, ...projects: string[]): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# Roadmap\n${projects.map((p) => milestone(`m-${p}`, p)).join('')}`);
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
};

/** A checkout beside the clone, with or without its own store. */
const checkout = (name: string, opts: { store?: 'overlay' | 'plain' } = {}): string => {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (opts.store === 'overlay')
    mkdirSync(path.join(dir, '.blacksmith', 'state', 'events'), { recursive: true });
  if (opts.store === 'plain') mkdirSync(path.join(dir, 'state', 'events'), { recursive: true });
  return dir;
};

const resolve = (cwd: string, over: Partial<Parameters<typeof resolveCaptureStore>[0]> = {}) =>
  resolveCaptureStore({
    cwd,
    env: {},
    repoRoot: clone,
    isClone: true,
    roadmapPath,
    ...over,
  });

const real = (p: string): string => realpathSync(p);

beforeEach(() => {
  base = real(mkdtempSync(path.join(tmpdir(), 'bs-capture-')));
  clone = path.join(base, 'factory-clone');
  mkdirSync(path.join(clone, '.git'), { recursive: true });
  mkdirSync(path.join(clone, 'state', 'events'), { recursive: true });
  roadmapPath = path.join(clone, 'factory', 'specs', 'roadmap.md');
  writeRoadmap(roadmapPath, 'acme');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveCaptureStore: M1, M2, M3', () => {
  it('is a no-op for a cwd that belongs to no store', () => {
    const elsewhere = path.join(base, 'nowhere');
    mkdirSync(elsewhere);
    expect(resolve(elsewhere)).toBeNull();
  });

  it('M1: BS_HOME with a store wins over everything', () => {
    const home = path.join(base, 'home');
    mkdirSync(path.join(home, 'state', 'events'), { recursive: true });
    const acme = checkout('acme', { store: 'overlay' });
    expect(resolve(acme, { env: { BS_HOME: home } })).toEqual({
      eventsDir: path.join(home, 'state', 'events'),
      rule: 'M1',
    });
  });

  it('M2: a checkout with its own store resolves to it', () => {
    const beta = checkout('beta-app', { store: 'overlay' });
    expect(resolve(beta)).toEqual({
      eventsDir: path.join(beta, '.blacksmith', 'state', 'events'),
      rule: 'M2',
    });
  });

  it('M2: a plain state/events at the top counts too', () => {
    const beta = checkout('beta-app', { store: 'plain' });
    expect(resolve(path.join(beta))?.eventsDir).toBe(path.join(beta, 'state', 'events'));
  });

  it('M2: a linked worktree resolves to its main clone store', () => {
    const beta = checkout('beta-app', { store: 'overlay' });
    const wt = path.join(base, 'elsewhere-wt');
    git(beta, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
    expect(resolve(wt)).toEqual({
      eventsDir: path.join(beta, '.blacksmith', 'state', 'events'),
      rule: 'M2',
    });
  });

  it('M3: `bs` with a store under the work root resolves, anything else does not', () => {
    const elsewhere = path.join(base, 'nowhere');
    mkdirSync(elsewhere);
    expect(resolve(elsewhere, { command: 'bs' })).toEqual({
      eventsDir: path.join(clone, 'state', 'events'),
      rule: 'M3',
    });
    expect(resolve(elsewhere, { command: 'bs-mod' })).toBeNull();
    expect(resolve(elsewhere, { command: undefined })).toBeNull();
  });

  it('M3: a work root with no store is a no-op even for `bs`', () => {
    const elsewhere = path.join(base, 'nowhere');
    mkdirSync(elsewhere);
    expect(resolve(elsewhere, { command: 'bs', isClone: false })).toBeNull();
  });
});

describe('resolveCaptureStore: M4', () => {
  it('a declared checkout with no store resolves to the clone store, with its project', () => {
    const acme = checkout('acme');
    expect(resolve(acme)).toEqual({
      eventsDir: path.join(clone, 'state', 'events'),
      project: 'acme',
      rule: 'M4',
    });
  });

  it('a subdirectory of the declared checkout matches too', () => {
    const acme = checkout('acme');
    mkdirSync(path.join(acme, 'src'));
    expect(resolve(path.join(acme, 'src'))?.rule).toBe('M4');
  });

  it('a linked worktree of it, outside the projects dir, resolves the same', () => {
    const acme = checkout('acme');
    const outside = real(mkdtempSync(path.join(tmpdir(), 'bs-capture-wt-')));
    try {
      const wt = path.join(outside, 'acme-wt');
      git(acme, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
      expect(resolve(wt)).toEqual({
        eventsDir: path.join(clone, 'state', 'events'),
        project: 'acme',
        rule: 'M4',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a symlinked checkout path matches after realpath', () => {
    const acme = checkout('acme');
    const link = path.join(base, 'acme-link');
    symlinkSync(acme, link);
    expect(resolve(link)?.rule).toBe('M4');
  });

  it('an undeclared checkout is a no-op', () => {
    expect(resolve(checkout('beta-app'))).toBeNull();
  });

  it('a declared checkout with its own store keeps M2 and carries no project', () => {
    const acme = checkout('acme', { store: 'overlay' });
    const got = resolve(acme);
    expect(got?.rule).toBe('M2');
    expect(got).not.toHaveProperty('project');
  });

  it('BS_HOME set with no store under it is a no-op, not M4', () => {
    const acme = checkout('acme');
    expect(resolve(acme, { env: { BS_HOME: path.join(base, 'missing-home') } })).toBeNull();
  });

  it('isClone false (a packed install) is never M4', () => {
    expect(resolve(checkout('acme'), { isClone: false })).toBeNull();
  });

  it('an unreadable or invalid roadmap is a no-op', () => {
    const acme = checkout('acme');
    expect(resolve(acme, { roadmapPath: path.join(base, 'no-such-roadmap.md') })).toBeNull();
    writeFileSync(roadmapPath, '## not a roadmap\n- project: acme\n');
    expect(resolve(acme)).toBeNull();
  });

  it('M4 needs the clone to hold a store already', () => {
    rmSync(path.join(clone, 'state'), { recursive: true });
    expect(resolve(checkout('acme'))).toBeNull();
  });

  it('M3 loses to M4 when both apply, so only M4 knows the project', () => {
    expect(resolve(checkout('acme'), { command: 'bs' })?.rule).toBe('M4');
  });
});

describe('resolveCaptureStore: M4 and the checkout overlay roadmap (Q5b)', () => {
  const overlay = (dir: string): string =>
    path.join(dir, '.blacksmith', 'factory', 'specs', 'roadmap.md');

  it('a project declared only in its own overlay roadmap resolves to the clone store', () => {
    const gamma = checkout('gamma');
    writeRoadmap(overlay(gamma), 'gamma');
    expect(resolve(gamma)).toEqual({
      eventsDir: path.join(clone, 'state', 'events'),
      project: 'gamma',
      rule: 'M4',
    });
  });

  it('an overlay roadmap declaring another project is a no-op', () => {
    const gamma = checkout('gamma');
    writeRoadmap(overlay(gamma), 'beta-app');
    expect(resolve(gamma)).toBeNull();
  });

  it('...unless the clone roadmap declares the checkout', () => {
    const acme = checkout('acme');
    writeRoadmap(overlay(acme), 'beta-app');
    expect(resolve(acme)?.project).toBe('acme');
  });

  it('an invalid overlay roadmap does not break M4 from the clone roadmap', () => {
    const acme = checkout('acme');
    mkdirSync(path.dirname(overlay(acme)), { recursive: true });
    writeFileSync(overlay(acme), '\u0000 not a roadmap');
    expect(resolve(acme)?.project).toBe('acme');
  });

  it('with no overlay file the result is the clone roadmap result alone', () => {
    expect(resolve(checkout('gamma'))).toBeNull();
    expect(resolve(checkout('acme'))?.project).toBe('acme');
  });
});
