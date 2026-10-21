import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, ROADMAP_DEFAULT_PATH, STACK_POLICY_DEFAULT_PATH } from '../src/paths.js';
import { CONCURRENCY_CAPS, initWorkRoot, OVERLAY_FILES, seedFromShipped } from '../src/workroot.js';

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
  // Init also writes the caps into the project; keep that inside the temp dir.
  let sandbox: { projectDir: string; userSettingsPath: string; env: Record<string, string> };

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'smith-init-'));
    sandbox = {
      projectDir: path.join(workRoot, 'proj'),
      userSettingsPath: path.join(workRoot, 'none.json'),
      env: {},
    };
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('seeds the operator copy of every file the factory ships a default of', () => {
    const report = initWorkRoot({ ...sandbox, workRoot, repoRoot: REPO_ROOT });

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
    const report = initWorkRoot({ ...sandbox, workRoot, repoRoot: REPO_ROOT });

    expect(report.directories.length).toBeGreaterThan(0);
    for (const rel of report.directories) {
      expect(existsSync(path.join(workRoot, rel))).toBe(true);
    }
  });

  it('changes nothing on a second run', () => {
    initWorkRoot({ ...sandbox, workRoot, repoRoot: REPO_ROOT });
    writeFileSync(path.join(workRoot, OVERLAY_FILES[1] as string), 'language: rust\n', 'utf8');

    const again = initWorkRoot({ ...sandbox, workRoot, repoRoot: REPO_ROOT });

    expect(again.files.map((file) => file.status)).toEqual(['kept', 'kept']);
    expect(readFileSync(path.join(workRoot, OVERLAY_FILES[1] as string), 'utf8')).toBe(
      'language: rust\n',
    );
  });

  it('ignores the state it is about to write, since the work root sits in the operator repo', () => {
    const report = initWorkRoot({ ...sandbox, workRoot, repoRoot: REPO_ROOT });

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
    const report = initWorkRoot({ ...sandbox, workRoot, repoRoot: workRoot });

    expect(report.gitignore).toBe('not-applicable');
    expect(existsSync(path.join(workRoot, '.gitignore'))).toBe(false);
  });

  it('leaves an existing .gitignore as it found it', () => {
    writeFileSync(path.join(workRoot, '.gitignore'), 'mine\n', 'utf8');

    const report = initWorkRoot({ ...sandbox, workRoot, repoRoot: REPO_ROOT });

    expect(report.gitignore).toBe('kept');
    expect(readFileSync(path.join(workRoot, '.gitignore'), 'utf8')).toBe('mine\n');
  });
});

// ---------------------------------------------------------------------------
// Claude Code's two concurrency caps, written into the project.
//
// Claude Code reads them only from its own env or a settings `env` block, so
// `bs init` merges them into the project's local settings. Every case uses
// temp directories and injected inputs; the real ~/.claude and process.env are
// never consulted.
// ---------------------------------------------------------------------------

const [CAP_A, CAP_B] = Object.keys(CONCURRENCY_CAPS) as [string, string];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('initWorkRoot concurrency caps', () => {
  let dir: string;
  let project: string;
  let userSettings: string;
  let local: string;

  const init = (extra: Record<string, unknown> = {}) =>
    initWorkRoot({
      workRoot: path.join(project, '.blacksmith'),
      repoRoot: REPO_ROOT,
      projectDir: project,
      userSettingsPath: userSettings,
      env: {},
      ...extra,
    }).claudeCaps;
  const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-caps-'));
    // A machine-wide git ignore may already cover the file; the cases below
    // are about the repo's own exclude, so hide it.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    project = path.join(dir, 'proj');
    mkdirSync(project);
    git(project, 'init', '-q');
    userSettings = path.join(dir, 'user', 'settings.json');
    local = path.join(project, '.claude', 'settings.local.json');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the local file with both caps and keeps it out of git', () => {
    const caps = init();

    expect(caps.status).toBe('written');
    expect([...caps.added].sort()).toEqual([CAP_A, CAP_B].sort());
    expect(caps.restartNeeded).toBe(true);
    expect(caps.gitExclude).toBe('added');
    expect(readFileSync(local, 'utf8')).toBe(
      `${JSON.stringify({ env: CONCURRENCY_CAPS }, null, 2)}\n`,
    );
    expect(() => git(project, 'check-ignore', '-q', '.claude/settings.local.json')).not.toThrow();
  });

  it('keeps other keys and a cap already set, adding only the missing one', () => {
    put(local, JSON.stringify({ model: 'x', env: { FOO: '1', [CAP_A]: '50' } }));

    const caps = init();

    expect(caps.status).toBe('updated');
    expect(caps.added).toEqual([CAP_B]);
    expect(caps.kept).toEqual([CAP_A]);
    expect(readJson(local)).toEqual({
      model: 'x',
      env: { FOO: '1', [CAP_A]: '50', [CAP_B]: '1000' },
    });
  });

  it('writes nothing when the user settings already set both', () => {
    put(userSettings, JSON.stringify({ env: { [CAP_A]: '5', [CAP_B]: '5' } }));

    const caps = init();

    expect(caps.status).toBe('kept');
    expect(caps.added).toEqual([]);
    expect(caps.restartNeeded).toBe(false);
    expect(existsSync(local)).toBe(false);
  });

  it('keeps a cap set in the consulted env', () => {
    const caps = init({ env: { [CAP_A]: '7' } });

    expect(caps.added).toEqual([CAP_B]);
    expect(caps.kept).toEqual([CAP_A]);
    expect(readJson(local).env).toEqual({ [CAP_B]: '1000' });
  });

  it('keeps a cap set in the project settings.json', () => {
    put(path.join(project, '.claude', 'settings.json'), JSON.stringify({ env: { [CAP_B]: '3' } }));

    const caps = init();

    expect(caps.added).toEqual([CAP_A]);
    expect(caps.kept).toEqual([CAP_B]);
    expect(readJson(local).env).toEqual({ [CAP_A]: '1000' });
  });

  it('treats an unreadable user settings file as no source', () => {
    put(userSettings, '{not json');

    expect(init().added.length).toBe(2);
  });

  it('leaves a malformed local file untouched and reports it', () => {
    put(local, '{oops');

    const caps = init();

    expect(caps.status).toBe('unreadable');
    expect(caps.restartNeeded).toBe(false);
    expect(readFileSync(local, 'utf8')).toBe('{oops');
  });

  it('is idempotent: the second run keeps everything and the exclude line is not duplicated', () => {
    init();
    const before = readFileSync(local, 'utf8');

    const caps = init();

    expect(caps.status).toBe('kept');
    expect(caps.added).toEqual([]);
    expect([...caps.kept].sort()).toEqual([CAP_A, CAP_B].sort());
    expect(readFileSync(local, 'utf8')).toBe(before);
    const exclude = path.resolve(
      project,
      git(project, 'rev-parse', '--git-path', 'info/exclude').trim(),
    );
    const lines = readFileSync(exclude, 'utf8')
      .split('\n')
      .filter((line) => line.includes('settings.local.json'));
    expect(lines).toEqual(['/.claude/settings.local.json']);
  });

  it('writes the file outside a git repo and reports that', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'smith-caps-plain-'));
    try {
      const caps = initWorkRoot({
        workRoot: path.join(plain, '.blacksmith'),
        repoRoot: REPO_ROOT,
        projectDir: plain,
        userSettingsPath: userSettings,
        env: {},
      }).claudeCaps;

      expect(caps.status).toBe('written');
      expect(caps.gitExclude).toBe('not-a-repo');
      expect(existsSync(path.join(plain, '.claude', 'settings.local.json'))).toBe(true);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('does nothing in a clone, which carries the caps in its tracked settings', () => {
    const caps = init({ workRoot: project, repoRoot: project });

    expect(caps.status).toBe('not-applicable');
    expect(caps.restartNeeded).toBe(false);
    expect(existsSync(local)).toBe(false);
  });

  it('the tracked .claude/settings.json carries the same caps and keeps its other keys', () => {
    const tracked = readJson(path.join(REPO_ROOT, '.claude', 'settings.json'));
    expect(tracked.env).toEqual(CONCURRENCY_CAPS);
    expect(tracked.hooks).toBeDefined();
    expect(tracked.permissions).toBeDefined();
  });
});
