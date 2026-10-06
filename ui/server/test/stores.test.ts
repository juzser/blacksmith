// Store discovery on its own: which directories become stores, and how they dedupe.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverStores,
  eventsDirOf,
  gitTop,
  storeIdOf,
  storeRootAt,
  storeRootOf,
} from '../src/stores.js';

describe('store discovery', () => {
  let tmp: string;
  const mk = (...parts: string[]): string => {
    const dir = path.join(tmp, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bs-stores-')));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('walks up from a nested cwd to the git toplevel', () => {
    mk('project-b', '.git');
    const deep = mk('project-b', 'src', 'deep');
    expect(gitTop(deep)).toBe(path.join(tmp, 'project-b'));
    expect(gitTop(mk('elsewhere'))).toBeNull();
  });

  it('maps a linked worktree back to the main clone', () => {
    const main = mk('project-b');
    mk('project-b', '.git', 'worktrees', 'w1');
    const wt = mk('wt');
    writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/w1\n`);
    expect(gitTop(wt)).toBe(main);
  });

  it('finds a BS_HOME layout, preferring it over a clone layout', () => {
    const top = mk('project-b');
    mk('project-b', 'state', 'events');
    expect(storeRootAt(top)?.root).toBe(top);
    mk('project-b', '.blacksmith', 'state', 'events');
    expect(storeRootAt(top)).toEqual({ root: path.join(top, '.blacksmith'), label: 'project-b' });
    expect(storeRootAt(mk('plain'))).toBeNull();
  });

  it('reads an explicit --store dir as the state home itself', () => {
    mk('project-b', '.blacksmith', 'state', 'events');
    expect(storeRootOf(path.join(tmp, 'project-b', '.blacksmith'))?.label).toBe('project-b');
    mk('custom-home', 'state', 'events');
    expect(storeRootOf(path.join(tmp, 'custom-home'))?.label).toBe('custom-home');
    expect(storeRootOf(path.join(tmp, 'missing'))).toBeNull();
  });

  it('dedupes by realpath and leaves the home store out', () => {
    const b = mk('project-b');
    mk('project-b', '.git');
    mk('project-b', '.blacksmith', 'state', 'events');
    symlinkSync(b, path.join(tmp, 'link-to-b'));
    const home = mk('project-a');
    mk('project-a', '.git');
    mk('project-a', 'state', 'events');
    const found = discoverStores(
      [b, path.join(tmp, 'link-to-b'), mk('project-b', 'src'), home],
      [path.join(b, '.blacksmith')],
      eventsDirOf(home),
    );
    expect([...found.keys()]).toEqual([storeIdOf(eventsDirOf(path.join(b, '.blacksmith')))]);
    expect(storeIdOf(eventsDirOf(path.join(b, '.blacksmith')))).toMatch(/^[0-9a-f]{8}$/);
  });
});
