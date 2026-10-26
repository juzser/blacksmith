import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import {
  CLAUDE_SETTINGS_REVISION,
  CONCURRENCY_CAPS,
  claudeSettingsOutOfDate,
  initWorkRoot,
  OLD_WINDOW_MODELS,
  settingsRecordPath,
} from '../src/workroot.js';

// ---------------------------------------------------------------------------
// Claude Code's auto-compact window, written into the project.
//
// `context_window.auto_compact_ratio` is prompt-level; `autoCompactWindow` is
// the setting that makes Claude Code honour it. `bs init` adds it only when
// nothing anywhere sets it, and a record in the work root's state/ tells a
// value bs wrote from one the user chose. Temp directories and injected
// inputs throughout; the real ~/.claude, process.env and state/ are never
// consulted.
// ---------------------------------------------------------------------------

const [CAP_A, CAP_B] = Object.keys(CONCURRENCY_CAPS) as [string, string];
const WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const PCT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const perModel = (n: number) =>
  Object.fromEntries(OLD_WINDOW_MODELS.map((id) => [id, { autoCompactWindow: n }]));
const perModelRecord = (n: number) =>
  Object.fromEntries(OLD_WINDOW_MODELS.map((id) => [`modelSettings.${id}.autoCompactWindow`, n]));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('initWorkRoot auto-compact window', () => {
  let dir: string;
  let project: string;
  let userSettings: string;
  let projectSettings: string;
  let local: string;
  let workRoot: string;

  const run = (extra: Record<string, unknown> = {}) =>
    initWorkRoot({
      workRoot,
      repoRoot: REPO_ROOT,
      projectDir: project,
      userSettingsPath: userSettings,
      env: {},
      ...extra,
    });
  // The window alone: the caps are held off so the local file holds only what the case sets up.
  const heldCaps = { [CAP_A]: '1000', [CAP_B]: '1000' };
  const init = (extra: Record<string, unknown> = {}) =>
    run({ ...extra, env: { ...heldCaps, ...(extra.env as object | undefined) } }).claudeWindow;
  const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };
  const record = () => readJson(settingsRecordPath(workRoot));
  // A policy tree holding only budgets.yml, for a ratio other than the shipped one.
  const policyWith = (budgets: string): string => {
    const root = path.join(dir, 'policy');
    put(path.join(root, 'factory', 'policies', 'budgets.yml'), budgets);
    return root;
  };
  const ratio = (value: number) => `context_window:\n  auto_compact_ratio: ${value}\n`;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-window-'));
    // A machine-wide git ignore may already cover the file; hide it.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    project = path.join(dir, 'proj');
    mkdirSync(project);
    git(project, 'init', '-q');
    workRoot = path.join(project, '.blacksmith');
    userSettings = path.join(dir, 'user', 'settings.json');
    projectSettings = path.join(project, '.claude', 'settings.json');
    local = path.join(project, '.claude', 'settings.local.json');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the policy ratio of a 1M window at the top level, git-excluded', () => {
    const window = init();

    expect(window.status).toBe('written');
    expect(window.value).toBe(633000);
    expect(window.restartNeeded).toBe(true);
    expect(window.gitExclude).toBe('added');
    expect(readJson(local).autoCompactWindow).toBe(633000);
    expect(() => git(project, 'check-ignore', '-q', '.claude/settings.local.json')).not.toThrow();
  });

  it('derives the value from the shipped budgets.yml under repoRoot', () => {
    const window = init({ repoRoot: policyWith(ratio(0.45)) });

    expect(window.value).toBe(483000);
    expect(readJson(local).autoCompactWindow).toBe(483000);
  });

  it.each([
    ['an unreadable policy', undefined],
    ['no ratio', 'context_window: {}\n'],
    ['a ratio below the minimum', ratio(0.05)],
    ['a ratio above the maximum', ratio(1.5)],
  ])('writes nothing and says why for %s', (_name, budgets) => {
    const repoRoot = budgets === undefined ? path.join(dir, 'empty') : policyWith(budgets);

    const window = init({ repoRoot });

    expect(window.status).toBe('unavailable');
    expect(window.value).toBeUndefined();
    expect(window.reason).toMatch(/budgets\.yml|auto_compact_ratio/);
    expect(existsSync(local)).toBe(false);
  });

  it('keeps other keys in the local file', () => {
    put(local, JSON.stringify({ model: 'x' }));

    const window = init();

    expect(window.status).toBe('updated');
    expect(readJson(local)).toEqual({
      model: 'x',
      autoCompactWindow: 633000,
      modelSettings: perModel(153000),
    });
  });

  it('writes 153000 for each of the 8 old 200k models next to the top-level value', () => {
    const window = init();

    expect(window.modelValue).toBe(153000);
    expect(OLD_WINDOW_MODELS).toHaveLength(8);
    expect(readJson(local)).toEqual({
      autoCompactWindow: 633000,
      modelSettings: perModel(153000),
    });
  });

  it('skips the top-level key and every per-model key together when the user has a value', () => {
    put(
      userSettings,
      JSON.stringify({ modelSettings: { 'claude-opus-4-6': { effortLevel: 'x' } } }),
    );
    put(projectSettings, JSON.stringify({ autoCompactWindow: 300000 }));
    put(local, JSON.stringify({ model: 'x' }));

    const window = init();

    expect(window.status).toBe('skipped');
    expect(readJson(local)).toEqual({ model: 'x' });
  });

  it('merges into an existing model entry without dropping its sibling keys', () => {
    put(
      local,
      JSON.stringify({
        modelSettings: {
          'claude-opus-4-6': { effortLevel: 'high' },
          'some-other-model': { effortLevel: 'low' },
        },
      }),
    );

    init();

    const models = readJson(local).modelSettings;
    expect(models['claude-opus-4-6']).toEqual({ effortLevel: 'high', autoCompactWindow: 153000 });
    expect(models['some-other-model']).toEqual({ effortLevel: 'low' });
  });

  const sources: ReadonlyArray<{
    name: string;
    arrange: () => Record<string, unknown>;
    where: () => string;
    found: string;
  }> = [
    {
      name: 'the process env',
      arrange: () => ({ env: { [WINDOW_ENV]: '300000' } }),
      where: () => 'environment',
      found: '"300000"',
    },
    {
      name: 'the user settings top level',
      arrange: () => {
        put(userSettings, JSON.stringify({ autoCompactWindow: 300000 }));
        return {};
      },
      where: () => userSettings,
      found: '300000',
    },
    {
      name: 'the user opting out with "auto" at the top level',
      arrange: () => {
        put(userSettings, JSON.stringify({ autoCompactWindow: 'auto' }));
        return {};
      },
      where: () => userSettings,
      found: '"auto"',
    },
    {
      name: 'the process env opting out with "auto"',
      arrange: () => ({ env: { [WINDOW_ENV]: 'auto' } }),
      where: () => 'environment',
      found: '"auto"',
    },
    {
      name: 'a per-model value in the user settings',
      arrange: () => {
        put(
          userSettings,
          JSON.stringify({ modelSettings: { 'some-model': { autoCompactWindow: 300000 } } }),
        );
        return {};
      },
      where: () => userSettings,
      found: '300000',
    },
    {
      name: 'a user settings env block',
      arrange: () => {
        put(userSettings, JSON.stringify({ env: { [WINDOW_ENV]: '300000' } }));
        return {};
      },
      where: () => userSettings,
      found: '"300000"',
    },
    {
      name: 'the project settings.json',
      arrange: () => {
        put(projectSettings, JSON.stringify({ autoCompactWindow: 300000 }));
        return {};
      },
      where: () => projectSettings,
      found: '300000',
    },
    {
      name: 'a per-model value in the project settings.json',
      arrange: () => {
        put(
          projectSettings,
          JSON.stringify({ modelSettings: { m: { autoCompactWindow: 300000 } } }),
        );
        return {};
      },
      where: () => projectSettings,
      found: '300000',
    },
    {
      name: 'a per-model value in the local file',
      arrange: () => {
        put(local, JSON.stringify({ modelSettings: { m: { autoCompactWindow: 300000 } } }));
        return {};
      },
      where: () => local,
      found: '300000',
    },
    {
      name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in the process env',
      arrange: () => ({ env: { [PCT_ENV]: '60' } }),
      where: () => 'environment',
      found: '"60"',
    },
    {
      name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in a user settings env block',
      arrange: () => {
        put(userSettings, JSON.stringify({ env: { [PCT_ENV]: '60' } }));
        return {};
      },
      where: () => userSettings,
      found: '"60"',
    },
    {
      name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in the project settings.json',
      arrange: () => {
        put(projectSettings, JSON.stringify({ env: { [PCT_ENV]: '60' } }));
        return {};
      },
      where: () => projectSettings,
      found: '"60"',
    },
    {
      name: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in the local file',
      arrange: () => {
        put(local, JSON.stringify({ env: { [PCT_ENV]: '60' } }));
        return {};
      },
      where: () => local,
      found: '"60"',
    },
    {
      name: 'an env block in the local file',
      arrange: () => {
        put(local, JSON.stringify({ env: { [WINDOW_ENV]: '300000' } }));
        return {};
      },
      where: () => local,
      found: '"300000"',
    },
  ];

  it.each(sources)(
    'adds nothing when $name sets the window, and warns with file, value and recommendation',
    ({ arrange, where, found }) => {
      const extra = arrange();
      const before = existsSync(local) ? readFileSync(local, 'utf8') : undefined;

      const window = init(extra);

      expect(window.status).toBe('skipped');
      expect(window.restartNeeded).toBe(false);
      expect(window.warnings).toHaveLength(1);
      expect(window.warnings[0]).toContain(where());
      expect(window.warnings[0]).toContain(found);
      expect(window.warnings[0]).toContain('633000');
      expect(existsSync(local) ? readFileSync(local, 'utf8') : undefined).toBe(before);
    },
  );

  it('does not warn about a foreign value that already equals the recommendation', () => {
    put(userSettings, JSON.stringify({ autoCompactWindow: 633000 }));

    const window = init();

    expect(window.status).toBe('skipped');
    expect(window.warnings).toEqual([]);
    expect(existsSync(local)).toBe(false);
  });

  it('is idempotent: a second run changes no file and needs no restart', () => {
    run();
    const settings = readFileSync(local, 'utf8');
    const rec = readFileSync(settingsRecordPath(workRoot), 'utf8');

    const again = run();

    expect(again.claudeWindow.status).toBe('kept');
    expect(again.claudeWindow.restartNeeded).toBe(false);
    expect(again.claudeWindow.warnings).toEqual([]);
    expect(again.claudeCaps.restartNeeded).toBe(false);
    expect(readFileSync(local, 'utf8')).toBe(settings);
    expect(readFileSync(settingsRecordPath(workRoot), 'utf8')).toBe(rec);
  });

  it('records the project, the revision and every key it wrote, caps included', () => {
    run();

    expect(record()).toEqual({
      projectDir: project,
      revision: CLAUDE_SETTINGS_REVISION,
      written: {
        [`env.${CAP_A}`]: '1000',
        [`env.${CAP_B}`]: '1000',
        autoCompactWindow: 633000,
        ...perModelRecord(153000),
      },
    });
  });

  it('never writes the key into the tracked project settings.json', () => {
    put(projectSettings, JSON.stringify({ hooks: {} }));

    run();

    expect(readJson(projectSettings)).toEqual({ hooks: {} });
  });

  it('writes in a clone too, into the local file and never the tracked one', () => {
    const repo = path.join(dir, 'clone');
    put(path.join(repo, 'factory', 'policies', 'budgets.yml'), ratio(0.6));
    git(repo, 'init', '-q');

    const result = run({ workRoot: repo, repoRoot: repo, projectDir: repo });

    expect(result.claudeCaps.status).toBe('not-applicable');
    expect(result.claudeWindow.status).toBe('written');
    expect(readJson(path.join(repo, '.claude', 'settings.local.json'))).toEqual({
      autoCompactWindow: 633000,
      modelSettings: perModel(153000),
    });
    expect(existsSync(path.join(repo, '.claude', 'settings.json'))).toBe(false);
  });

  describe('a later run, with a record of what bs wrote', () => {
    it('updates a value bs wrote when the policy changed', () => {
      run();

      const window = init({ repoRoot: policyWith(ratio(0.5)) });

      expect(window.status).toBe('updated');
      expect(window.restartNeeded).toBe(true);
      expect(readJson(local).autoCompactWindow).toBe(533000);
      expect(record().written.autoCompactWindow).toBe(533000);
      expect(readJson(local).modelSettings).toEqual(perModel(133000));
      expect(window.warnings).toEqual([]);
    });

    it('re-running never skips or warns about the per-model keys bs wrote itself', () => {
      run();

      const window = init();

      expect(window.status).toBe('kept');
      expect(window.warnings).toEqual([]);
      expect(window.restartNeeded).toBe(false);
    });

    it('keeps a per-model value the user edited after bs wrote it, and warns', () => {
      run();
      const edited = readJson(local);
      edited.modelSettings['claude-opus-4-6'].autoCompactWindow = 90000;
      edited.modelSettings['claude-opus-4-6'].effortLevel = 'high';
      put(local, JSON.stringify(edited));

      const window = init();

      expect(window.warnings).toHaveLength(1);
      expect(window.warnings[0]).toContain('modelSettings.claude-opus-4-6.autoCompactWindow');
      expect(window.warnings[0]).toContain('90000');
      expect(window.warnings[0]).toContain('153000');
      expect(readJson(local).modelSettings['claude-opus-4-6']).toEqual({
        autoCompactWindow: 90000,
        effortLevel: 'high',
      });
    });

    it('does not add per-model keys over a top-level value the user set in the local file', () => {
      put(local, JSON.stringify({ autoCompactWindow: 400000 }));

      const window = init();

      expect(window.status).toBe('kept');
      expect(readJson(local)).toEqual({ autoCompactWindow: 400000 });
      expect(window.warnings).toHaveLength(1);
    });

    it('updates a cap bs wrote when it differs from the current value', () => {
      run();
      put(local, JSON.stringify({ ...readJson(local), env: { [CAP_A]: '50', [CAP_B]: '1000' } }));
      put(
        settingsRecordPath(workRoot),
        JSON.stringify({
          ...record(),
          written: { ...record().written, [`env.${CAP_A}`]: '50' },
        }),
      );

      const caps = run().claudeCaps;

      expect(caps.added).toEqual([CAP_A]);
      expect(caps.restartNeeded).toBe(true);
      expect(readJson(local).env[CAP_A]).toBe('1000');
      expect(record().written[`env.${CAP_A}`]).toBe('1000');
    });

    it('keeps a cap the user edited after bs wrote it', () => {
      run();
      put(local, JSON.stringify({ ...readJson(local), env: { [CAP_A]: '50', [CAP_B]: '1000' } }));

      const caps = run().claudeCaps;

      expect(caps.kept).toContain(CAP_A);
      expect(readJson(local).env[CAP_A]).toBe('50');
    });

    it('keeps a value the user edited after bs wrote it, and warns', () => {
      run();
      put(local, JSON.stringify({ ...readJson(local), autoCompactWindow: 400000 }));

      const window = init();

      expect(window.status).toBe('kept');
      expect(readJson(local).autoCompactWindow).toBe(400000);
      expect(window.warnings).toHaveLength(1);
      expect(window.warnings[0]).toContain(local);
      expect(window.warnings[0]).toContain('400000');
      expect(window.warnings[0]).toContain('633000');
    });

    it('keeps a value that has no record at all, and warns', () => {
      put(local, JSON.stringify({ autoCompactWindow: 400000 }));

      const window = init();

      expect(window.status).toBe('kept');
      expect(readJson(local).autoCompactWindow).toBe(400000);
      expect(window.warnings).toHaveLength(1);
      expect(record().written.autoCompactWindow).toBeUndefined();
    });

    it('adopts a pre-existing value equal to the current one, silently', () => {
      put(local, JSON.stringify({ autoCompactWindow: 633000, modelSettings: perModel(153000) }));

      const window = init();

      expect(window.status).toBe('kept');
      expect(window.warnings).toEqual([]);
      expect(window.restartNeeded).toBe(false);
      expect(record().written.autoCompactWindow).toBe(633000);
    });

    it('ignores a record made for another project dir', () => {
      run();
      put(settingsRecordPath(workRoot), JSON.stringify({ ...record(), projectDir: '/elsewhere' }));

      const window = init({ repoRoot: policyWith(ratio(0.5)) });

      expect(window.status).toBe('kept');
      expect(readJson(local).autoCompactWindow).toBe(633000);
      // Without a record, the top-level key and the 8 model keys are all the user's.
      expect(window.warnings).toHaveLength(1 + OLD_WINDOW_MODELS.length);
    });

    it('leaves a bs value alone once the user sets the window elsewhere', () => {
      run();
      put(userSettings, JSON.stringify({ modelSettings: { m: { autoCompactWindow: 300000 } } }));

      const window = init({ repoRoot: policyWith(ratio(0.5)) });

      expect(window.status).toBe('kept');
      expect(readJson(local).autoCompactWindow).toBe(633000);
      expect(window.warnings.length).toBeGreaterThan(0);
    });
  });

  it('leaves a malformed local file alone and reports it', () => {
    put(local, '{oops');

    const window = init();

    expect(window.status).toBe('unreadable');
    expect(readFileSync(local, 'utf8')).toBe('{oops');
  });

  it('reports failed and does not throw when .claude is a regular file', () => {
    put(path.join(project, '.claude'), 'not a dir');

    expect(init().status).toBe('failed');
  });

  describe('the out-of-date check behind the session-start hint', () => {
    it('is out of date with no record, current after init, and old once the revision moves', () => {
      mkdirSync(path.join(workRoot, 'state'), { recursive: true });
      expect(claudeSettingsOutOfDate(workRoot)).toBe(true);

      run();
      expect(claudeSettingsOutOfDate(workRoot)).toBe(false);

      put(settingsRecordPath(workRoot), JSON.stringify({ ...record(), revision: 0 }));
      expect(claudeSettingsOutOfDate(workRoot)).toBe(true);
    });

    it('treats an unparsable record as out of date', () => {
      put(settingsRecordPath(workRoot), '{nope');

      expect(claudeSettingsOutOfDate(workRoot)).toBe(true);
    });
  });
});
