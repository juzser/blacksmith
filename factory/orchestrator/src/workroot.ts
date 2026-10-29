import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  REPO_ROOT,
  ROADMAP_DEFAULT_PATH,
  ROADMAP_PATH,
  SPECS_ACTIVE_DIR,
  STACK_POLICY_DEFAULT_PATH,
  STATE_ARTIFACTS_DIR,
  STATE_EVENTS_DIR,
  WORK_ROOT,
} from './paths.js';

// ---------------------------------------------------------------------------
// The work root, made to exist.
//
// `paths.ts` says where everything lives; this module is the one place that
// creates it. The distinction matters under an npm install, where the package
// directory and the work root are two different places: the tarball carries
// the factory's read-only assets, and the operator's own repository carries
// `.blacksmith/` -- the state the CLI writes and the two files the operator
// personalises. Nothing in the tarball may be written, because the next
// `npm i` replaces it wholesale.
//
// In a clone the two roots are the same directory and every function here is
// a no-op that reports it. That is not a degenerate case to be tolerated, it
// is the property that makes this safe to add mid-flight: an existing checkout
// behaves exactly as it did before this module existed.
// ---------------------------------------------------------------------------

/** What happened to one overlay file. */
export type SeedStatus = 'seeded' | 'kept' | 'missing-default';

export interface SeedResult {
  /** The copy that is read and written -- under the work root. */
  readonly personal: string;
  /** The copy that ships -- under the package. */
  readonly shipped: string;
  readonly status: SeedStatus;
}

/**
 * The files `paths.ts` declares twice: a default that ships and a copy the
 * operator then edits. Spelled relative to their own root, because the pairing
 * rule -- enforced in packaging.test.ts -- is that both halves are the same
 * relative path under two roots, which is what lets seeding be a plain copy.
 *
 * Derived from the constants rather than retyped, so a third overlay file
 * added to `paths.ts` is seeded without anyone remembering to edit this list.
 */
export const OVERLAY_FILES: readonly string[] = [
  path.relative(REPO_ROOT, ROADMAP_DEFAULT_PATH),
  path.relative(REPO_ROOT, STACK_POLICY_DEFAULT_PATH),
];

// `factory/policies/lessons.md` is the third overlay in `paths.ts` and is
// deliberately not in that list. The two above are seeded because INSTALL.md
// has the operator open them and edit them in place -- they must exist before
// anyone can answer. Nobody hand-edits lessons.md: it appears the first time
// `smith lessons compile` runs, and until then reading the shipped set is the
// right answer. Seeding a copy would freeze the lessons at install time and
// stop every later upgrade from delivering new ones.

/**
 * The directories the CLI writes into. Same derivation, same reason: the
 * relative spelling is `paths.ts`'s to decide, and this module should follow
 * it rather than hold a second opinion about where `state/events` is.
 */
const WORK_DIRS: readonly string[] = [
  path.relative(WORK_ROOT, STATE_EVENTS_DIR),
  path.relative(WORK_ROOT, STATE_ARTIFACTS_DIR),
  path.relative(WORK_ROOT, SPECS_ACTIVE_DIR),
];

/**
 * `state/` is a cache of the event log and `workspaces/` holds worktrees; both
 * are this machine's, not the project's. `factory/` is deliberately absent:
 * the roadmap and the stack answers are declarations the operator made, and a
 * team sharing the repository should share them.
 */
const WORK_ROOT_GITIGNORE = `# Written by \`bs init\`. Blacksmith's state is a cache of its event log
# and belongs to this machine; the answers under factory/ are declarations
# this project made, so they are tracked.
state/
workspaces/
.env
`;

/**
 * Give the operator their own copy of a file the factory ships a default of.
 *
 * Never overwrites: an operator who answers the stack questionnaire, upgrades,
 * and runs init again out of habit must not find the defaults back. And never
 * copies a file onto itself, which is the clone case -- there the personal
 * copy *is* the shipped default, and the honest report is that nothing needed
 * doing.
 */
export function seedFromShipped(personal: string, shipped: string): SeedResult {
  if (personal === shipped || existsSync(personal)) {
    return { personal, shipped, status: 'kept' };
  }
  if (!existsSync(shipped)) {
    // Not an throw: a missing default is a packaging defect, and the caller --
    // `smith init`, which is reporting a list -- can say which file is missing
    // more usefully than an exception thrown halfway through the list can.
    return { personal, shipped, status: 'missing-default' };
  }
  mkdirSync(path.dirname(personal), { recursive: true });
  copyFileSync(shipped, personal);
  return { personal, shipped, status: 'seeded' };
}

/**
 * The roadmap, guaranteed writable, returned.
 *
 * Used as the *default argument* of the functions that append to the roadmap,
 * so that an explicitly-passed path is never seeded -- a caller naming a file
 * is naming the file it means, and a missing one is still an error there.
 */
export function ensureWritableRoadmap(): string {
  seedFromShipped(ROADMAP_PATH, ROADMAP_DEFAULT_PATH);
  return ROADMAP_PATH;
}

/**
 * Claude Code's two harness concurrency caps and the value `bs init` gives
 * them. Claude Code reads them only from its own process env or a settings
 * `env` block -- never from Blacksmith's `.env`, and a plugin cannot ship
 * `env` -- so the only way to raise them without a manual step is to write
 * them into settings the project owns. This is the single source: the tracked
 * `.claude/settings.json` and INSTALL.md are tested against it.
 */
export const CONCURRENCY_CAPS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '1000',
  CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '1000',
};

export interface InitOptions {
  readonly workRoot?: string;
  readonly repoRoot?: string;
  /** The project `bs init` runs in. Not the work root, which sits inside it. */
  readonly projectDir?: string;
  /** Read-only: Claude Code's user settings, consulted for caps already set. */
  readonly userSettingsPath?: string;
  /** The environment consulted for caps already set. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ClaudeCapsReport {
  readonly settingsPath: string;
  readonly status: 'written' | 'updated' | 'kept' | 'not-applicable' | 'unreadable' | 'failed';
  /** Caps this run wrote. */
  readonly added: readonly string[];
  /** Caps already set somewhere, left exactly as they were. */
  readonly kept: readonly string[];
  readonly gitExclude:
    | 'added'
    | 'already-ignored'
    | 'tracked'
    | 'not-a-repo'
    | 'not-applicable'
    | 'failed';
  /** True iff something was added: a running session does not see it. */
  readonly restartNeeded: boolean;
}

export interface ClaudeWindowReport {
  readonly settingsPath: string;
  /** Where bs records what it wrote, so a later run can tell its keys from the user's. */
  readonly recordPath: string;
  /** What keeping the record out of git came to; absent when the record was not touched. */
  readonly recordGitExclude?: ClaudeCapsReport['gitExclude'];
  readonly status:
    | 'written'
    | 'updated'
    | 'kept'
    | 'skipped'
    | 'unavailable'
    | 'unreadable'
    | 'failed';
  /** The recommended `autoCompactWindow`; undefined when the policy gave none. */
  readonly value: number | undefined;
  /** The recommended per-model value for the old 200k models. */
  readonly modelValue: number | undefined;
  /** Why no value could be derived from the policy. */
  readonly reason: string | undefined;
  /** A user value that differs from the recommendation, or a record that could not be saved. */
  readonly warnings: readonly string[];
  readonly gitExclude: ClaudeCapsReport['gitExclude'];
  /** True iff the file changed: a running session does not see it. */
  readonly restartNeeded: boolean;
}

/** A JSON object parsed from text, or undefined when it is not one. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed: the caller decides what that means.
  }
  return undefined;
}

/** A JSON object read from disk, or undefined when it is absent or not one. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    return parseJsonObject(readFileSync(file, 'utf8'));
  } catch {
    return undefined; // Absent: the caller decides what that means.
  }
}

/**
 * The `env` block of a settings file's text, or undefined when the text is not
 * a JSON object. Serves epic criterion 11 (the doctor's concurrency-caps
 * check) with the same parser `bs init` uses.
 */
export function parseSettingsEnv(text: string): Record<string, unknown> | undefined {
  const settings = parseJsonObject(text);
  return settings === undefined ? undefined : envBlock(settings);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envBlock(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  const env = settings?.env;
  return isObject(env) ? env : {};
}

/**
 * Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json` when that is
 * set, else `~/.claude/settings.json`. Takes the env and home so a test never
 * reads the real ones.
 */
export function defaultUserSettingsPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return path.join(dir ? dir : path.join(home, '.claude'), 'settings.json');
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Keep the local settings file out of git without touching a tracked
 * `.gitignore`: `.git/info/exclude` is this clone's own and is never shared.
 */
function excludeFromGit(projectDir: string, file: string): ClaudeCapsReport['gitExclude'] {
  // Never let a git or filesystem hiccup take `bs init` down after the
  // settings file is already written.
  try {
    return tryExcludeFromGit(projectDir, file);
  } catch {
    return 'failed';
  }
}

function tryExcludeFromGit(projectDir: string, file: string): ClaudeCapsReport['gitExclude'] {
  try {
    if (git(projectDir, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      return 'not-a-repo';
    }
  } catch {
    return 'not-a-repo';
  }
  try {
    git(projectDir, ['check-ignore', '-q', file]);
    return 'already-ignored';
  } catch {
    // Exit 1 means not ignored; fall through and add it.
  }
  // check-ignore says nothing about a tracked file, and an exclude rule can
  // never apply to one.
  try {
    git(projectDir, ['ls-files', '--error-unmatch', '--', file]);
    return 'tracked';
  } catch {
    // Not tracked.
  }
  const exclude = path.resolve(
    projectDir,
    git(projectDir, ['rev-parse', '--git-path', 'info/exclude']).trim(),
  );
  const prefix = git(projectDir, ['rev-parse', '--show-prefix']).trim();
  const rule = `/${prefix}${path.relative(projectDir, file).split(path.sep).join('/')}`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  mkdirSync(path.dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${rule}\n`);
  return 'added';
}

/**
 * Merge the concurrency caps into `<projectDir>/.claude/settings.local.json`.
 *
 * A cap already set anywhere Claude Code looks -- its env, the user settings,
 * the project settings, or the local file -- is the operator's answer and is
 * kept whatever its value: never overwritten, never lowered. A file that is
 * not a JSON object is left alone and reported rather than failing init.
 */
function raiseConcurrencyCaps(
  projectDir: string,
  userSettingsPath: string,
  env: Readonly<Record<string, string | undefined>>,
  inPlace: boolean,
  written: SettingsWritten,
): ClaudeCapsReport {
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  // A clone carries the caps in its tracked .claude/settings.json.
  if (inPlace) {
    return {
      settingsPath,
      status: 'not-applicable',
      added: [],
      kept: [],
      gitExclude: 'not-applicable',
      restartNeeded: false,
    };
  }

  const exists = existsSync(settingsPath);
  const localSettings = exists ? readJsonObject(settingsPath) : {};
  if (localSettings === undefined) {
    return {
      settingsPath,
      status: 'unreadable',
      added: [],
      kept: [],
      gitExclude: 'not-applicable',
      restartNeeded: false,
    };
  }

  // An `env` that is present but not an object is the operator's, not ours to
  // replace.
  if (localSettings.env !== undefined && !isObject(localSettings.env)) {
    return {
      settingsPath,
      status: 'unreadable',
      added: [],
      kept: [],
      gitExclude: 'not-applicable',
      restartNeeded: false,
    };
  }

  const sources = [
    env,
    envBlock(readJsonObject(userSettingsPath)),
    envBlock(readJsonObject(path.join(projectDir, '.claude', 'settings.json'))),
    envBlock(localSettings),
  ];
  const added: string[] = [];
  const kept: string[] = [];
  for (const name of Object.keys(CONCURRENCY_CAPS)) {
    const key = `env.${name}`;
    const own = envBlock(localSettings)[name];
    if (own === CONCURRENCY_CAPS[name]) {
      // Already what we would write: adopt it so a later revision can move it.
      written[key] = CONCURRENCY_CAPS[name] as string;
      kept.push(name);
    } else if (own !== undefined && written[key] === own) {
      // Ours from an earlier revision and untouched since: bring it up to date.
      added.push(name);
    } else {
      (sources.some((source) => source[name] !== undefined) ? kept : added).push(name);
    }
  }

  if (added.length > 0) {
    const merged = { ...envBlock(localSettings) };
    for (const name of added) merged[name] = CONCURRENCY_CAPS[name];
    try {
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        `${JSON.stringify({ ...localSettings, env: merged }, null, 2)}\n`,
      );
      for (const name of added) written[`env.${name}`] = CONCURRENCY_CAPS[name] as string;
    } catch {
      // `.claude` is a file, or the directory is unwritable: report it rather
      // than fail `bs init`.
      return {
        settingsPath,
        status: 'failed',
        added: [],
        kept,
        gitExclude: 'not-applicable',
        restartNeeded: false,
      };
    }
  }

  return {
    settingsPath,
    status: added.length === 0 ? 'kept' : exists ? 'updated' : 'written',
    added,
    kept,
    gitExclude: existsSync(settingsPath)
      ? excludeFromGit(projectDir, settingsPath)
      : 'not-applicable',
    restartNeeded: added.length > 0,
  };
}

/**
 * Bumped whenever `bs init` changes what it writes into Claude Code settings.
 * `bs session start` compares it with the project's record to say "run
 * `bs init` again".
 */
export const CLAUDE_SETTINGS_REVISION = 1;

/** Key -> value bs wrote into the local settings: `autoCompactWindow`, `env.<NAME>`. */
type SettingsWritten = Record<string, string | number>;

interface SettingsRecord {
  readonly revision: number;
  readonly written: SettingsWritten;
}

/**
 * What bs wrote, kept beside the settings it describes: `<projectDir>/.claude/`
 * in a file of its own (Claude Code loads only `settings*.json`, so this one is
 * never read as settings). It is what tells a value bs wrote from one the user
 * chose. It lives with the project, not in the work root's `state/`, because
 * `state/` is safe to delete and losing the record would turn bs's lines into
 * the user's for good; being per-project directory it needs no key either.
 */
export function settingsRecordPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'bs-settings-record.json');
}

function readSettingsRecord(projectDir: string): SettingsRecord | undefined {
  const raw = readJsonObject(settingsRecordPath(projectDir));
  if (raw === undefined || typeof raw.revision !== 'number' || !isObject(raw.written)) {
    return undefined;
  }
  return { revision: raw.revision, written: raw.written as SettingsWritten };
}

/**
 * The project a directory belongs to: the main worktree's toplevel. Walks up to
 * `.git`; a `.git` file saying `gitdir: <main>/.git/worktrees/<name>` (a linked
 * worktree) leads back to `<main>`. Outside git it is the directory itself.
 * Only files are parsed, no `git` is spawned.
 */
export function findProjectRoot(startDir: string): string {
  const start = physicalDir(startDir);
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return dir;
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (match?.[1] !== undefined) {
        const gitdir = path.resolve(dir, match[1]);
        const worktrees = path.dirname(gitdir);
        const common = path.dirname(worktrees);
        if (path.basename(worktrees) === 'worktrees' && path.basename(common) === '.git') {
          return path.dirname(common);
        }
      }
      return dir;
    } catch {
      // No .git here; keep climbing.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** A symlinked or relative spelling of one project is still one project. */
function physicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

const WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
// Claude Code applies this percentage on top of the configured window, so a
// bs-written window under a user's percentage would stack two ratios.
const PCT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const WINDOW_MIN = 100_000;
const WINDOW_MAX = 1_000_000;
// The window of the retired-generation models listed in OLD_WINDOW_MODELS.
const OLD_WINDOW = 200_000;
// Claude Code fires compaction at window minus 33000: an output reserve of
// min(max output, 20000), which is 20000 for every current model, plus a
// 13000-token buffer. Adding it back makes a model compact at exactly the
// policy ratio of its own window.
const COMPACT_HEADROOM = 33_000;
// A closed set of retired-generation models with a 200k window, by Claude
// Code's canonical keys. They need their own value because the top-level one
// is clamped to their window (they would compact near 83%). New models are
// 1M-window and inherit the top-level value; do not extend this list.
export const OLD_WINDOW_MODELS: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-0',
  'claude-haiku-4-5',
];

const TOP_RECORD_KEY = 'autoCompactWindow';
const modelRecordKey = (id: string): string => `modelSettings.${id}.autoCompactWindow`;

/**
 * `context_window.auto_compact_ratio` of a 1M window (and of a 200k window for
 * the old models) plus the headroom, from the shipped policy. No fallback: a
 * policy that cannot be read, or a ratio Claude Code would reject, means no
 * key is written.
 */
function recommendedWindow(
  repoRoot: string,
): { value: number; modelValue: number } | { reason: string } {
  const file = path.join(repoRoot, 'factory', 'policies', 'budgets.yml');
  let ratio: unknown;
  try {
    const doc: unknown = parseYaml(readFileSync(file, 'utf8'));
    ratio =
      isObject(doc) && isObject(doc.context_window)
        ? doc.context_window.auto_compact_ratio
        : undefined;
  } catch {
    return { reason: `cannot read ${file}` };
  }
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    return { reason: `${file} has no numeric context_window.auto_compact_ratio` };
  }
  const value = Math.round(ratio * WINDOW_MAX) + COMPACT_HEADROOM;
  const modelValue = Math.round(ratio * OLD_WINDOW) + COMPACT_HEADROOM;
  for (const result of [value, modelValue]) {
    if (result < WINDOW_MIN || result > WINDOW_MAX) {
      return {
        reason: `auto_compact_ratio ${ratio} gives ${result}, outside ${WINDOW_MIN}-${WINDOW_MAX}`,
      };
    }
  }
  return { value, modelValue };
}

/** One key bs may write into the local file: the top-level one, or a model's. */
interface WindowKey {
  readonly recordKey: string;
  readonly value: number;
  readonly read: (local: Record<string, unknown>) => unknown;
  readonly write: (local: Record<string, unknown>) => void;
  /** Take bs's line out; an emptied model entry goes, its sibling keys stay. */
  readonly remove: (local: Record<string, unknown>) => void;
}

function windowKeys(value: number, modelValue: number): WindowKey[] {
  const top: WindowKey = {
    recordKey: TOP_RECORD_KEY,
    value,
    read: (local) => local.autoCompactWindow,
    write: (local) => {
      local.autoCompactWindow = value;
    },
    remove: (local) => {
      delete local.autoCompactWindow;
    },
  };
  const perModel = OLD_WINDOW_MODELS.map(
    (id): WindowKey => ({
      recordKey: modelRecordKey(id),
      value: modelValue,
      read: (local) => {
        const entry = isObject(local.modelSettings) ? local.modelSettings[id] : undefined;
        return isObject(entry) ? entry.autoCompactWindow : undefined;
      },
      write: (local) => {
        const models = isObject(local.modelSettings) ? { ...local.modelSettings } : {};
        const entry = models[id];
        models[id] = { ...(isObject(entry) ? entry : {}), autoCompactWindow: modelValue };
        local.modelSettings = models;
      },
      remove: (local) => {
        if (!isObject(local.modelSettings)) return;
        const models = { ...local.modelSettings };
        const { autoCompactWindow: _own, ...rest } = isObject(models[id]) ? models[id] : {};
        if (Object.keys(rest).length > 0) models[id] = rest;
        else delete models[id];
        if (Object.keys(models).length > 0) local.modelSettings = models;
        else delete local.modelSettings;
      },
    }),
  );
  return [top, ...perModel];
}

interface WindowSetting {
  readonly where: string;
  readonly value: unknown;
  /**
   * `file`: a value in a settings file, compared with what bs would write for
   * that very key. `window-env` beats every settings file and `pct-env` stacks
   * on the window: either conflicts with any window bs would write.
   */
  readonly kind: 'file' | 'window-env' | 'pct-env';
  /** What bs would write for this key; only for `file`. */
  readonly expected?: number;
}

/** An environment value counts only when non-empty, as `BS_HOME` does. */
const isSet = (value: unknown): boolean => value !== undefined && value !== '';

/**
 * Every window value that is the user's, wherever it sits: the two window
 * variables (the process env or a settings `env` block), and a top-level or
 * per-model `autoCompactWindow` in the user and project settings. In the local
 * file a value is the user's unless `owns` says the record proves bs wrote it
 * and it is unchanged.
 *
 * One entry per variable: a settings file is named in preference to the
 * process env, because that is where the user can change it.
 */
function userWindowValues(
  files: { readonly user: string; readonly project: string; readonly local: string },
  localSettings: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  owns: (recordKey: string, value: unknown) => boolean,
  target: { readonly value: number; readonly modelValue: number },
): WindowSetting[] {
  const sources: Array<{ file: string; settings: Record<string, unknown> | undefined }> = [
    { file: files.user, settings: readJsonObject(files.user) },
    { file: files.project, settings: readJsonObject(files.project) },
    { file: files.local, settings: localSettings },
  ];
  const found: WindowSetting[] = [];
  for (const name of [WINDOW_ENV, PCT_ENV]) {
    const kind = name === PCT_ENV ? 'pct-env' : 'window-env';
    const inFile = sources.find((source) => isSet(envBlock(source.settings)[name]));
    if (inFile !== undefined) {
      found.push({
        where: `${inFile.file} env.${name}`,
        value: envBlock(inFile.settings)[name],
        kind,
      });
    } else if (isSet(env[name])) {
      found.push({ where: `the environment ${name}`, value: env[name], kind });
    }
  }
  for (const { file, settings } of sources) {
    if (settings === undefined) continue;
    const isLocal = file === files.local;
    const top = settings.autoCompactWindow;
    if (top !== undefined && !(isLocal && owns(TOP_RECORD_KEY, top))) {
      found.push({
        where: `${file} autoCompactWindow`,
        value: top,
        kind: 'file',
        expected: target.value,
      });
    }
    if (!isObject(settings.modelSettings)) continue;
    for (const [model, entry] of Object.entries(settings.modelSettings)) {
      if (!isObject(entry) || entry.autoCompactWindow === undefined) continue;
      if (isLocal && owns(modelRecordKey(model), entry.autoCompactWindow)) continue;
      found.push({
        where: `${file} modelSettings.${model}.autoCompactWindow`,
        value: entry.autoCompactWindow,
        kind: 'file',
        expected: OLD_WINDOW_MODELS.includes(model) ? target.modelValue : target.value,
      });
    }
  }
  return found;
}

/** A settings value that already equals what bs would write for that key needs no word. */
const worthAWarning = (setting: WindowSetting): boolean =>
  setting.kind !== 'file' || setting.value !== setting.expected;

/** The user's whole recommended layout in one file: the top level and every old model. */
const hasFullLayout = (
  settings: Record<string, unknown> | undefined,
  target: { readonly value: number; readonly modelValue: number },
): boolean => {
  if (settings === undefined || settings.autoCompactWindow !== target.value) return false;
  const models = isObject(settings.modelSettings) ? settings.modelSettings : {};
  return OLD_WINDOW_MODELS.every((id) => {
    const entry = models[id];
    return isObject(entry) && entry.autoCompactWindow === target.modelValue;
  });
};

const localSettingsPath = (projectDir: string): string =>
  path.join(projectDir, '.claude', 'settings.local.json');
const projectSettingsFile = (projectDir: string): string =>
  path.join(projectDir, '.claude', 'settings.json');

/**
 * What `bs session start` should say about this project's Claude Code
 * settings, from the directory it runs in: `out-of-date` when `bs init` has not
 * run in the project at this revision; when it has and bs's own lines are still
 * in the local file, `overridden` (a user value in a settings file, which bs's
 * lines beat), `unused` (the window variable, which beats bs's lines) or
 * `stacked` (the percentage variable, which stacks on bs's window); else
 * undefined. The record is looked up as {@link recordCandidates} says. A few
 * small file reads; the caller never lets it fail.
 */
export function claudeSettingsHint(
  cwd: string,
  options: HintOptions = {},
): SettingsHint | undefined {
  return claudeSettingsAdvice(cwd, options)?.hint;
}

export type SettingsHint = 'out-of-date' | 'overridden' | 'unused' | 'stacked';
interface HintOptions {
  /** Where the home directory is; the record search never reaches it. */
  readonly home?: string;
  readonly userSettingsPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The directories whose record can speak for `cwd`, nearest first. The walk
 * goes up from the physical cwd and stops at the first directory holding `.git`
 * (after checking that directory itself), so a project never answers for a
 * repository nested in it. A submodule carries on from its superproject, under
 * the same rule; a linked worktree adds its main worktree root, and nothing
 * above it. Outside git the walk never looks at the home directory or above it,
 * and never at `/`. Only `.git` files are read, no `git` is spawned.
 */
function recordCandidates(start: string, home: string, depth = 0): string[] {
  const out: string[] = [];
  let dir = start;
  for (;;) {
    const parent = path.dirname(dir);
    if (dir === home || parent === dir) return out; // home, or `/`, is never a project
    out.push(dir);
    const dotGit = path.join(dir, '.git');
    let content: string | undefined;
    try {
      if (!statSync(dotGit).isDirectory()) content = readFileSync(dotGit, 'utf8');
      else return out;
    } catch {
      dir = parent;
      continue;
    }
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(content ?? '')?.[1];
    if (gitdir === undefined) return out;
    const target = path.resolve(dir, gitdir);
    const worktrees = path.dirname(target);
    const common = path.dirname(worktrees);
    if (path.basename(worktrees) === 'worktrees' && path.basename(common) === '.git') {
      return [...out, path.dirname(common)];
    }
    const modules = target.split(path.sep).lastIndexOf('modules');
    const parts = target.split(path.sep);
    if (modules > 0 && parts[modules - 1] === '.git' && depth < 8) {
      const superRoot = parts.slice(0, modules - 1).join(path.sep) || path.sep;
      return [...out, ...recordCandidates(superRoot, home, depth + 1)];
    }
    return out;
  }
}

/**
 * Like {@link claudeSettingsHint}, with the directory `bs init` has to run in.
 * That is where the record actually lives: the nearest directory of
 * {@link recordCandidates} that holds one, so a monorepo package, a submodule
 * or a subdirectory of a project outside git is named correctly. With no
 * record it is the project root. A few small file reads, no `git` spawn.
 */
export function claudeSettingsAdvice(
  cwd: string,
  options: HintOptions = {},
): { readonly hint: SettingsHint; readonly dir: string } | undefined {
  const root = findProjectRoot(cwd);
  const home = physicalDir(options.home ?? homedir());
  const dir = recordCandidates(physicalDir(cwd), home).find(
    (candidate) => readSettingsRecord(candidate) !== undefined,
  );
  const entry = dir === undefined ? undefined : readSettingsRecord(dir);
  if (dir === undefined || entry === undefined) return { hint: 'out-of-date', dir: root };
  if (entry.revision < CLAUDE_SETTINGS_REVISION) return { hint: 'out-of-date', dir };
  const hint = hintFor(dir, entry, options);
  return hint === undefined ? undefined : { hint, dir };
}

function hintFor(
  dir: string,
  entry: SettingsRecord,
  options: HintOptions,
): Exclude<SettingsHint, 'out-of-date'> | undefined {
  const env = options.env ?? process.env;
  const local = readJsonObject(localSettingsPath(dir));
  if (local === undefined) return undefined;
  const keys = windowKeys(0, 0);
  const stillThere = keys.some(
    (key) =>
      entry.written[key.recordKey] !== undefined &&
      key.read(local) === entry.written[key.recordKey],
  );
  if (!stillThere) return undefined;

  const userSettingsPath = options.userSettingsPath ?? defaultUserSettingsPath(env, homedir());
  const target = {
    value: Number(entry.written[TOP_RECORD_KEY]),
    modelValue: Number(entry.written[modelRecordKey(OLD_WINDOW_MODELS[0] as string)]),
  };
  const theirs = userWindowValues(
    { user: userSettingsPath, project: projectSettingsFile(dir), local: localSettingsPath(dir) },
    local,
    env,
    (recordKey, value) => entry.written[recordKey] === value,
    target,
  ).filter(worthAWarning);
  if (theirs.some((setting) => setting.kind === 'file')) return 'overridden';
  if (theirs.some((setting) => setting.kind === 'window-env')) return 'unused';
  return theirs.length > 0 ? 'stacked' : undefined;
}

/**
 * Put `autoCompactWindow` (top level, plus one entry for each old 200k model)
 * into `<projectDir>/.claude/settings.local.json`, or take bs's lines out.
 *
 * Claude Code lets a later settings file's top-level value wipe the per-model
 * values of every earlier one, and a per-model value in a later file beat an
 * earlier top-level one, so the nine keys stand or fall together. bs owns only
 * the keys its record proves it wrote and that are still unchanged; any other
 * window value, wherever it is and whatever it equals, is the user's and blocks
 * the whole set. A blocked set is not left in place (the local file would beat
 * the user's value): bs removes its own lines, and never anything else.
 */
function setCompactWindow(
  projectDir: string,
  repoRoot: string,
  userSettingsPath: string,
  env: Readonly<Record<string, string | undefined>>,
  recordPath: string,
  written: SettingsWritten,
  existedBefore: boolean,
): ClaudeWindowReport {
  const settingsPath = localSettingsPath(projectDir);
  const base = { settingsPath, recordPath, warnings: [] as string[] };

  const recommended = recommendedWindow(repoRoot);
  if ('reason' in recommended) {
    return {
      ...base,
      status: 'unavailable',
      value: undefined,
      modelValue: undefined,
      reason: recommended.reason,
      gitExclude: 'not-applicable',
      restartNeeded: false,
    };
  }
  const { value, modelValue } = recommended;
  const outcome = (
    status: ClaudeWindowReport['status'],
    extra: Partial<ClaudeWindowReport> = {},
  ): ClaudeWindowReport => ({
    ...base,
    status,
    value,
    modelValue,
    reason: undefined,
    gitExclude: 'not-applicable',
    restartNeeded: false,
    ...extra,
  });

  const local = existsSync(settingsPath) ? readJsonObject(settingsPath) : {};
  if (local === undefined) return outcome('unreadable');

  const keys = windowKeys(value, modelValue);
  const wanted = new Set(keys.map((key) => key.recordKey));
  // Only the record proves ownership. A value that merely equals the
  // recommendation may be the user's own layout, and retracting it would delete
  // what they wrote.
  const owns = (recordKey: string, current: unknown): boolean =>
    wanted.has(recordKey) && written[recordKey] === current;
  const target = { value, modelValue };
  const projectFile = projectSettingsFile(projectDir);
  const theirs = userWindowValues(
    { user: userSettingsPath, project: projectFile, local: settingsPath },
    local,
    env,
    owns,
    target,
  );

  let next: Record<string, unknown>;
  let changed: WindowKey[];
  let warnings: string[] = [];
  let status: ClaudeWindowReport['status'];
  if (theirs.length > 0) {
    changed = keys.filter((key) => {
      const own = key.read(local);
      return own !== undefined && owns(key.recordKey, own);
    });
    next = { ...local };
    for (const key of changed) key.remove(next);
    // Silent only when everything the user holds already is bs's recommended
    // layout, whole, in one file: there is nothing to tell them.
    const settingsOf = [userSettingsPath, projectFile, settingsPath].map((file) =>
      file === settingsPath ? local : readJsonObject(file),
    );
    const silent =
      theirs.every((setting) => !worthAWarning(setting)) &&
      settingsOf.some((settings) => hasFullLayout(settings, target));
    if (!silent) {
      const notes = [
        theirs.some((s) => s.kind === 'window-env') &&
          ` It beats every settings file, so bs's lines would go unused.`,
        theirs.some((s) => s.kind === 'pct-env') &&
          ` It stacks on the window, so a window under it would count the ratio twice.`,
      ]
        .filter((note) => note !== false)
        .join('');
      warnings = [
        `${theirs.map((s) => `${s.where} is ${JSON.stringify(s.value)}`).join('; ')}; bs leaves autoCompactWindow to you${
          changed.length > 0
            ? " and removed its own lines from the project's settings.local.json"
            : ''
        }.${notes} Recommended layout: autoCompactWindow ${value} and modelSettings.<id>.autoCompactWindow ${modelValue} for each of ${OLD_WINDOW_MODELS.join(', ')}, together in the file where your value lives and without ${PCT_ENV}; or remove your value and run \`bs init\` again`,
      ];
    }
    status = 'skipped';
    for (const key of keys) delete written[key.recordKey];
  } else {
    changed = keys.filter((key) => key.read(local) !== key.value);
    next = { ...local };
    for (const key of changed) key.write(next);
    for (const key of keys) written[key.recordKey] = key.value;
    status = changed.length === 0 ? 'kept' : existedBefore ? 'updated' : 'written';
  }

  if (changed.length > 0) {
    try {
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      return outcome('failed');
    }
  }

  return outcome(status, {
    warnings,
    gitExclude: existsSync(settingsPath)
      ? excludeFromGit(projectDir, settingsPath)
      : 'not-applicable',
    restartNeeded: changed.length > 0,
  });
}

export interface InitReport {
  readonly workRoot: string;
  readonly repoRoot: string;
  /** True in a clone, where the work root and the package are one directory. */
  readonly inPlace: boolean;
  readonly directories: readonly string[];
  readonly files: readonly SeedResult[];
  readonly gitignore: 'written' | 'kept' | 'not-applicable';
  readonly claudeCaps: ClaudeCapsReport;
  readonly claudeWindow: ClaudeWindowReport;
}

/**
 * Make a work root that the CLI can run against: the directories it writes
 * into, a copy of each file the operator is expected to edit, and -- only when
 * the work root is a directory of our own inside somebody else's repository --
 * a `.gitignore` saying which half of it is state.
 *
 * Idempotent by construction: every step asks whether it has already been
 * done. Running it twice is not an undo.
 */
export function initWorkRoot(options: InitOptions = {}): InitReport {
  const workRoot = options.workRoot ?? WORK_ROOT;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const inPlace = path.resolve(workRoot) === path.resolve(repoRoot);

  for (const rel of WORK_DIRS) {
    mkdirSync(path.join(workRoot, rel), { recursive: true });
  }

  const files = OVERLAY_FILES.map((rel) =>
    seedFromShipped(path.join(workRoot, rel), path.join(repoRoot, rel)),
  );

  // In a clone this is the repository's own .gitignore, which means something
  // already. Appending to it would be a surprise and replacing it would be
  // data loss, so the only correct move is to leave it entirely alone.
  let gitignore: InitReport['gitignore'] = 'not-applicable';
  if (!inPlace) {
    const ignorePath = path.join(workRoot, '.gitignore');
    if (existsSync(ignorePath)) {
      gitignore = 'kept';
    } else {
      writeFileSync(ignorePath, WORK_ROOT_GITIGNORE, 'utf8');
      gitignore = 'written';
    }
  }

  const env = options.env ?? process.env;
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const userSettingsPath = options.userSettingsPath ?? defaultUserSettingsPath(env, homedir());
  // The record lives in this project's own .claude/, so there is one per project.
  const previous = readSettingsRecord(projectDir);
  const written: SettingsWritten = previous === undefined ? {} : { ...previous.written };
  // The caps step creates the file, so "new" has to be read before it runs.
  const existedBefore = existsSync(localSettingsPath(projectDir));
  const claudeCaps = raiseConcurrencyCaps(projectDir, userSettingsPath, env, inPlace, written);
  const recordPath = settingsRecordPath(projectDir);
  const claudeWindow = setCompactWindow(
    projectDir,
    repoRoot,
    userSettingsPath,
    env,
    recordPath,
    written,
    existedBefore,
  );

  // The record follows the settings, never leads them: a run that could not
  // read or write the settings leaves it exactly as it was, and a run that
  // could not derive a value keeps the old revision so the `bs session start`
  // hint keeps asking for `bs init`.
  let warnings = claudeWindow.warnings;
  let recordGitExclude: ClaudeCapsReport['gitExclude'] | undefined;
  if (claudeWindow.status !== 'unreadable' && claudeWindow.status !== 'failed') {
    const advance = claudeWindow.status !== 'unavailable';
    const record = `${JSON.stringify(
      { revision: advance ? CLAUDE_SETTINGS_REVISION : (previous?.revision ?? 0), written },
      null,
      2,
    )}\n`;
    try {
      // Rewritten only when it differs, so a run with nothing to change changes no file.
      if (!existsSync(recordPath) || readFileSync(recordPath, 'utf8') !== record) {
        mkdirSync(path.dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, record);
      }
      // Kept out of git on every run, like settings.local.json: a project that
      // became a repository since the last run is caught here.
      recordGitExclude = excludeFromGit(projectDir, recordPath);
      if (recordGitExclude === 'failed' || recordGitExclude === 'tracked') {
        warnings = [
          ...warnings,
          recordGitExclude === 'tracked'
            ? `${recordPath} is tracked by git, so it cannot be excluded; untrack it with \`git rm --cached\``
            : `could not keep ${recordPath} out of git; add it to .git/info/exclude yourself`,
        ];
      }
    } catch {
      warnings = [...warnings, `could not save ${recordPath}; bs will ask for \`bs init\` again`];
    }
  }

  return {
    workRoot,
    repoRoot,
    inPlace,
    directories: WORK_DIRS,
    files,
    gitignore,
    claudeCaps,
    claudeWindow: {
      ...claudeWindow,
      warnings,
      ...(recordGitExclude === undefined ? {} : { recordGitExclude }),
    },
  };
}
