import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
  readonly modelValue?: number | undefined;
  /** Why no value could be derived from the policy. */
  readonly reason: string | undefined;
  /** A user value that differs from the recommendation, or a record that could not be saved. */
  readonly warnings: readonly string[];
  readonly gitExclude: ClaudeCapsReport['gitExclude'];
  /** True iff the file changed: a running session does not see it. */
  readonly restartNeeded: boolean;
}

/** A JSON object read from disk, or undefined when it is absent or not one. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Absent or malformed: the caller decides what that means.
  }
  return undefined;
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
  readonly projectDir: string;
  readonly revision: number;
  readonly written: SettingsWritten;
}

/**
 * What bs wrote, kept in the work root's `state/` (this machine's) rather than
 * in a Claude settings file, which must not carry keys Claude Code does not
 * know. It is what tells a value bs wrote from one the user chose.
 */
export function settingsRecordPath(workRoot: string): string {
  return path.join(workRoot, 'state', 'claude-settings.json');
}

function readSettingsRecord(workRoot: string): SettingsRecord | undefined {
  const parsed = readJsonObject(settingsRecordPath(workRoot));
  if (
    parsed === undefined ||
    typeof parsed.projectDir !== 'string' ||
    typeof parsed.revision !== 'number' ||
    !isObject(parsed.written)
  ) {
    return undefined;
  }
  return {
    projectDir: parsed.projectDir,
    revision: parsed.revision,
    written: parsed.written as SettingsWritten,
  };
}

/** One small file read: true when this work root has no record or an older one. */
export function claudeSettingsOutOfDate(workRoot: string): boolean {
  const record = readSettingsRecord(workRoot);
  return record === undefined || record.revision < CLAUDE_SETTINGS_REVISION;
}

const WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
// Claude Code applies this percentage on top of the configured window, so a
// bs-written window under a user's percentage would stack two ratios.
const PCT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const WINDOW_MIN = 100_000;
const WINDOW_MAX = 1_000_000;
// The window of the retired-generation models listed in OLD_WINDOW_MODELS.
const OLD_WINDOW = 200_000;
// Claude Code fires compaction at window minus 33000 (a 20000-token output
// reserve plus a 13000-token buffer), so adding it back makes a model compact
// at exactly the policy ratio of its own window.
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

const MODEL_KEY_SUFFIX = 'autoCompactWindow';
const modelRecordKey = (id: string): string => `modelSettings.${id}.${MODEL_KEY_SUFFIX}`;

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

interface WindowSetting {
  readonly where: string;
  readonly value: unknown;
  /** Warn whatever the value: it conflicts with any window bs would write. */
  readonly always?: boolean;
}

/**
 * Every place in one settings file that sets the window or the percentage on
 * top of it. `ignoreModels` are model ids whose entry is judged separately
 * (the ones bs writes in the local file).
 */
function windowSettings(
  file: string,
  settings: Record<string, unknown> | undefined,
  topLevel: boolean,
  ignoreModels: readonly string[] = [],
): WindowSetting[] {
  const found: WindowSetting[] = [];
  if (settings === undefined) return found;
  const fromEnv = envBlock(settings)[WINDOW_ENV];
  if (fromEnv !== undefined) found.push({ where: `${file} env.${WINDOW_ENV}`, value: fromEnv });
  const pct = envBlock(settings)[PCT_ENV];
  if (pct !== undefined) {
    found.push({ where: `${file} env.${PCT_ENV}`, value: pct, always: true });
  }
  if (topLevel && settings.autoCompactWindow !== undefined) {
    found.push({ where: `${file} autoCompactWindow`, value: settings.autoCompactWindow });
  }
  if (isObject(settings.modelSettings)) {
    for (const [model, entry] of Object.entries(settings.modelSettings)) {
      if (ignoreModels.includes(model)) continue;
      if (isObject(entry) && entry.autoCompactWindow !== undefined) {
        found.push({
          where: `${file} modelSettings.${model}.autoCompactWindow`,
          value: entry.autoCompactWindow,
        });
      }
    }
  }
  return found;
}

/** One key bs may write into the local file: the top-level one, or a model's. */
interface WindowKey {
  readonly recordKey: string;
  readonly label: string;
  readonly value: number;
  readonly read: (local: Record<string, unknown>) => unknown;
  readonly write: (local: Record<string, unknown>) => void;
}

function windowKeys(value: number, modelValue: number): WindowKey[] {
  const top: WindowKey = {
    recordKey: 'autoCompactWindow',
    label: 'autoCompactWindow',
    value,
    read: (local) => local.autoCompactWindow,
    write: (local) => {
      local.autoCompactWindow = value;
    },
  };
  const perModel = OLD_WINDOW_MODELS.map(
    (id): WindowKey => ({
      recordKey: modelRecordKey(id),
      label: modelRecordKey(id),
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
    }),
  );
  return [top, ...perModel];
}

/**
 * Add `autoCompactWindow` (top level, plus one entry for each old 200k model)
 * to `<projectDir>/.claude/settings.local.json`.
 *
 * Claude Code lets a later settings file's top-level value wipe the per-model
 * values of every earlier one, and a per-model value in a later file beat an
 * earlier top-level one, so bs writes only when nothing anywhere sets the
 * window, and all its keys together. A value the user set is never rewritten;
 * one bs wrote earlier (per the record) follows the policy and is never
 * counted as the user's.
 */
function setCompactWindow(
  projectDir: string,
  repoRoot: string,
  userSettingsPath: string,
  env: Readonly<Record<string, string | undefined>>,
  recordPath: string,
  written: SettingsWritten,
): ClaudeWindowReport {
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  const projectSettingsPath = path.join(projectDir, '.claude', 'settings.json');
  const base = { settingsPath, recordPath, warnings: [] as string[] };

  const recommended = recommendedWindow(repoRoot);
  if ('reason' in recommended) {
    return {
      ...base,
      status: 'unavailable',
      value: undefined,
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
    reason: undefined,
    gitExclude: 'not-applicable',
    restartNeeded: false,
    ...extra,
  });

  const exists = existsSync(settingsPath);
  const local = exists ? readJsonObject(settingsPath) : {};
  if (local === undefined) return outcome('unreadable');

  const others: WindowSetting[] = [
    ...(env[WINDOW_ENV] !== undefined
      ? [{ where: `the environment ${WINDOW_ENV}`, value: env[WINDOW_ENV] }]
      : []),
    ...(env[PCT_ENV] !== undefined
      ? [{ where: `the environment ${PCT_ENV}`, value: env[PCT_ENV], always: true }]
      : []),
    ...windowSettings(userSettingsPath, readJsonObject(userSettingsPath), true),
    ...windowSettings(projectSettingsPath, readJsonObject(projectSettingsPath), true),
    ...windowSettings(settingsPath, local, false, OLD_WINDOW_MODELS),
  ];
  const warn = (found: readonly WindowSetting[], recommendedValue: number): string[] =>
    found
      .filter((setting) => setting.always || String(setting.value) !== String(recommendedValue))
      .map(
        (setting) =>
          `${setting.where} is set to ${JSON.stringify(setting.value)}; bs recommends autoCompactWindow ${recommendedValue} and leaves autoCompactWindow as is`,
      );

  const keys = windowKeys(value, modelValue);
  const topKey = keys[0] as WindowKey;
  // The user's own top-level value in the local file also blocks the per-model
  // entries: they would override it for those models.
  const topOwn = topKey.read(local);
  const topUserOwned =
    topOwn !== undefined && topOwn !== value && written[topKey.recordKey] !== topOwn;
  const blocked = others.length > 0;

  const toWrite: WindowKey[] = [];
  const warnings: string[] = [];
  let present = 0;
  let skippedAny = false;
  if (blocked) warnings.push(...warn(others, value));
  for (const key of keys) {
    const own = key.read(local);
    if (own === undefined) {
      if (blocked || (key !== topKey && topUserOwned)) skippedAny = true;
      else toWrite.push(key);
    } else if (own === key.value) {
      // Already what we would write: adopt it so a later revision can move it.
      written[key.recordKey] = key.value;
      present += 1;
    } else if (written[key.recordKey] === own && !blocked) {
      toWrite.push(key);
      present += 1;
    } else {
      warnings.push(...warn([{ where: `${settingsPath} ${key.label}`, value: own }], key.value));
      present += 1;
    }
  }

  let status: ClaudeWindowReport['status'] = 'kept';
  if (toWrite.length > 0) status = exists ? 'updated' : 'written';
  else if (present === 0 && skippedAny) status = 'skipped';

  if (toWrite.length > 0) {
    const next: Record<string, unknown> = { ...local };
    for (const key of toWrite) key.write(next);
    try {
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      return outcome('failed');
    }
    for (const key of toWrite) written[key.recordKey] = key.value;
  }

  return outcome(status, {
    modelValue,
    warnings,
    gitExclude: existsSync(settingsPath)
      ? excludeFromGit(projectDir, settingsPath)
      : 'not-applicable',
    restartNeeded: toWrite.length > 0,
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
  // A record made for another project dir says nothing about this one.
  const previous = readSettingsRecord(workRoot);
  const written: SettingsWritten =
    previous?.projectDir === projectDir ? { ...previous.written } : {};
  const claudeCaps = raiseConcurrencyCaps(projectDir, userSettingsPath, env, inPlace, written);
  const recordPath = settingsRecordPath(workRoot);
  const claudeWindow = setCompactWindow(
    projectDir,
    repoRoot,
    userSettingsPath,
    env,
    recordPath,
    written,
  );

  // Rewritten only when it differs, so a run with nothing to change changes no file.
  const record = `${JSON.stringify({ projectDir, revision: CLAUDE_SETTINGS_REVISION, written }, null, 2)}\n`;
  let warnings = claudeWindow.warnings;
  try {
    if (!existsSync(recordPath) || readFileSync(recordPath, 'utf8') !== record) {
      writeFileSync(recordPath, record);
    }
  } catch {
    warnings = [...warnings, `could not save ${recordPath}; bs will ask for \`bs init\` again`];
  }

  return {
    workRoot,
    repoRoot,
    inPlace,
    directories: WORK_DIRS,
    files,
    gitignore,
    claudeCaps,
    claudeWindow: { ...claudeWindow, warnings },
  };
}
