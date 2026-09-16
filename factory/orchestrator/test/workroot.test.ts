import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, ROADMAP_DEFAULT_PATH, STACK_POLICY_DEFAULT_PATH } from '../src/paths.js';
import { initWorkRoot, OVERLAY_FILES, seedFromShipped } from '../src/workroot.js';

// ---------------------------------------------------------------------------
// The write side of the overlay paths.ts declares.
//
// `resolveOverlayRead` answers "which copy do I read"; this module answers
// "make the copy I write exist". The two questions are separate because the
// read has no side effect and the write has to create a directory tree inside
// somebody else's repository -- and because the seeding has to be a no-op in a
// clone, where the personal copy and the shipped default are the same file.
//
// Every case below is written against temporary roots rather than the real
// ones. The install case is the only one that matters here and it cannot be
// observed from inside this checkout, where WORK_ROOT and REPO_ROOT are one
// directory; a suite that could only exercise the clone would be asserting
// that nothing happens.
// ---------------------------------------------------------------------------

describe('seedFromShipped', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-workroot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the shipped default when the operator has no copy yet', () => {
    const shipped = path.join(dir, 'pkg', 'stack.yml');
    const personal = path.join(dir, 'work', 'stack.yml');
    mkdirSync(path.dirname(shipped), { recursive: true });
    writeFileSync(shipped, 'language: typescript\n', 'utf8');

    const result = seedFromShipped(personal, shipped);

    expect(result.status).toBe('seeded');
    expect(readFileSync(personal, 'utf8')).toBe('language: typescript\n');
  });

  it('leaves an answered copy alone, so running init twice is not an undo', () => {
    // The failure this exists to prevent: an operator answers the
    // questionnaire, upgrades, runs `smith init` again out of habit, and finds
    // the defaults back. Idempotent means "changes nothing", not "re-seeds".
    const shipped = path.join(dir, 'pkg', 'stack.yml');
    const personal = path.join(dir, 'work', 'stack.yml');
    mkdirSync(path.dirname(shipped), { recursive: true });
    mkdirSync(path.dirname(personal), { recursive: true });
    writeFileSync(shipped, 'language: typescript\n', 'utf8');
    writeFileSync(personal, 'language: rust\n', 'utf8');

    expect(seedFromShipped(personal, shipped).status).toBe('kept');
    expect(readFileSync(personal, 'utf8')).toBe('language: rust\n');
  });

  it('copies nothing when both halves are the same file, which is every clone', () => {
    const only = path.join(dir, 'stack.yml');
    writeFileSync(only, 'language: typescript\n', 'utf8');

    expect(seedFromShipped(only, only).status).toBe('kept');
    expect(readFileSync(only, 'utf8')).toBe('language: typescript\n');
  });

  it('says so rather than inventing a file when the default is missing', () => {
    const shipped = path.join(dir, 'pkg', 'gone.yml');
    const personal = path.join(dir, 'work', 'gone.yml');

    expect(seedFromShipped(personal, shipped).status).toBe('missing-default');
    expect(existsSync(personal)).toBe(false);
  });
});

describe('initWorkRoot', () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'smith-init-'));
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('seeds the operator copy of every file the factory ships a default of', () => {
    const report = initWorkRoot({ workRoot, repoRoot: REPO_ROOT });

    expect(report.files.map((file) => file.status)).toEqual(['seeded', 'seeded']);
    for (const rel of OVERLAY_FILES) {
      expect(readFileSync(path.join(workRoot, rel), 'utf8')).toBe(
        readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
      );
    }
  });

  it('seeds the roadmap and the stack answers, named from paths.ts and nowhere else', () => {
    // The list is derived from the constants rather than retyped, so a third
    // overlay file added to paths.ts is seeded without touching this module.
    expect(OVERLAY_FILES).toEqual([
      path.relative(REPO_ROOT, ROADMAP_DEFAULT_PATH),
      path.relative(REPO_ROOT, STACK_POLICY_DEFAULT_PATH),
    ]);
  });

  it('creates the directories the CLI writes into', () => {
    const report = initWorkRoot({ workRoot, repoRoot: REPO_ROOT });

    expect(report.directories.length).toBeGreaterThan(0);
    for (const rel of report.directories) {
      expect(existsSync(path.join(workRoot, rel))).toBe(true);
    }
  });

  it('changes nothing on a second run', () => {
    initWorkRoot({ workRoot, repoRoot: REPO_ROOT });
    writeFileSync(path.join(workRoot, OVERLAY_FILES[1] as string), 'language: rust\n', 'utf8');

    const again = initWorkRoot({ workRoot, repoRoot: REPO_ROOT });

    expect(again.files.map((file) => file.status)).toEqual(['kept', 'kept']);
    expect(readFileSync(path.join(workRoot, OVERLAY_FILES[1] as string), 'utf8')).toBe(
      'language: rust\n',
    );
  });

  it('ignores the state it is about to write, since the work root sits in the operator repo', () => {
    const report = initWorkRoot({ workRoot, repoRoot: REPO_ROOT });

    expect(report.gitignore).toBe('written');
    // Read the rules, not the prose: the file explains itself in comments, and
    // a test that greps the whole text would be asserting the wording.
    const rules = readFileSync(path.join(workRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(rules).toContain('state/');
    // The answers are the opposite of state: they are a declaration this
    // operator made, and a team that shares the repo should share them.
    expect(rules.some((rule) => rule.startsWith('factory/'))).toBe(false);
  });

  it('never writes a .gitignore into a clone, where the work root is the repo', () => {
    // WORK_ROOT === REPO_ROOT in a checkout, and this repo already has a
    // .gitignore that means something. Appending to it -- or worse, replacing
    // it -- is how a convenience becomes a data loss.
    const report = initWorkRoot({ workRoot, repoRoot: workRoot });

    expect(report.gitignore).toBe('not-applicable');
    expect(existsSync(path.join(workRoot, '.gitignore'))).toBe(false);
  });

  it('leaves an existing .gitignore as it found it', () => {
    writeFileSync(path.join(workRoot, '.gitignore'), 'mine\n', 'utf8');

    const report = initWorkRoot({ workRoot, repoRoot: REPO_ROOT });

    expect(report.gitignore).toBe('kept');
    expect(readFileSync(path.join(workRoot, '.gitignore'), 'utf8')).toBe('mine\n');
  });
});
