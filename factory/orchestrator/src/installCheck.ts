/**
 * `bs doctor`: one install check, in plain words and in JSON.
 *
 * Every probe is a pure function over injected facts (the Node version, a
 * spawn function, a file-existence test), so a test supplies each outcome and
 * none of them runs the real `claude`. The real wiring is `realDeps`. Doctor
 * only reads: nothing here installs, updates or enables anything.
 *
 * `missing` means the thing is known to be absent; `unknown` means the probe
 * could not tell (a spawn error other than not-found, a timeout, output it does
 * not recognise). Only `missing` fails the exit code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CONCURRENCY_CAPS, defaultUserSettingsPath, parseSettingsEnv } from './workroot.js';

export type CheckStatus = 'ok' | 'missing' | 'unknown';

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
  /** One line telling the operator what to do; empty when the check is ok. */
  fix: string;
}

export interface RunResult {
  /** Exit code, or null when the child never produced one. */
  status: number | null;
  stdout: string;
  /** errno code (`ENOENT`, `ETIMEDOUT`) when the child did not run to completion. */
  error?: string;
}

export interface DoctorDeps {
  nodeVersion: string;
  /** `engines.node` from package.json, when readable. */
  enginesNode: string | undefined;
  bsVersion: string | undefined;
  root: string;
  /** The process environment. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** Reads a file as text; throws when it is absent. */
  readFile: (file: string) => string;
  exists: (file: string) => boolean;
  run: (cmd: string, args: string[], timeoutMs: number) => RunResult;
}

/** Quoted from INSTALL.md (Step 6 and the top of the file); a test pins the doc to these. */
export const CLAUDE_CHECK_COMMAND = 'claude --version';
export const PLUGIN_INSTALL_COMMANDS = [
  '/plugin marketplace add juzser/blacksmith',
  '/plugin install blacksmith@blacksmith',
];

/** Short on purpose: doctor must never hang on a stuck CLI. */
const TIMEOUT_MS = 5000;

/** Claude Code's own defaults; a cap must be above these to have been raised. */
const DEFAULT_SUBAGENT_CAP = 20;
const DEFAULT_TOOL_CALL_CAP = 10;

const ok = (id: string, detail: string): Check => ({ id, status: 'ok', detail, fix: '' });

/** A tool on PATH: ok on exit 0, missing when it cannot be found, unknown otherwise. */
function toolCheck(id: string, deps: DoctorDeps, args: string[], fix: string): Check {
  const res = deps.run(id, args, TIMEOUT_MS);
  if (res.error === 'ENOENT')
    return { id, status: 'missing', detail: `${id} not found on PATH`, fix };
  if (res.error !== undefined || res.status !== 0) {
    return { id, status: 'unknown', detail: `${id} did not answer ${args.join(' ')}`, fix };
  }
  return ok(id, res.stdout.trim().split('\n')[0] ?? '');
}

function nodeCheck(deps: DoctorDeps): Check {
  const fix = 'Install Node 22 or newer (INSTALL.md Part 1), e.g. nvm install 22';
  const floor = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(deps.enginesNode ?? '')?.[1];
  const major = /^v?(\d+)\./.exec(deps.nodeVersion)?.[1];
  if (floor === undefined || major === undefined) {
    return {
      id: 'node',
      status: 'unknown',
      detail: `cannot compare ${deps.nodeVersion} with engines "${deps.enginesNode ?? 'unreadable'}"`,
      fix,
    };
  }
  if (Number(major) < Number(floor)) {
    return {
      id: 'node',
      status: 'missing',
      detail: `${deps.nodeVersion} is older than the required >=${floor}`,
      fix,
    };
  }
  return ok('node', `${deps.nodeVersion} (needs >=${floor})`);
}

function pluginCheck(deps: DoctorDeps): Check {
  const fix = `Inside a Claude Code session run ${PLUGIN_INSTALL_COMMANDS.join(' then ')}`;
  const res = deps.run('claude', ['plugin', 'list'], TIMEOUT_MS);
  const unknown = (why: string): Check => ({ id: 'plugin', status: 'unknown', detail: why, fix });
  if (res.error !== undefined) return unknown(`claude plugin list did not run (${res.error})`);
  if (res.status !== 0) return unknown(`claude plugin list exited ${res.status}`);
  const out = res.stdout;
  if (/(^|[^\w@-])blacksmith@blacksmith\b/.test(out)) {
    return ok('plugin', 'blacksmith@blacksmith is installed');
  }
  // Missing needs positive evidence: a listing that names other plugins, or says there are none.
  if (/[\w-]+@[\w-]+/.test(out) || /no plugins/i.test(out)) {
    return {
      id: 'plugin',
      status: 'missing',
      detail: 'blacksmith@blacksmith is not installed',
      fix,
    };
  }
  return unknown('claude plugin list printed output doctor does not recognise');
}

function claudeCheck(deps: DoctorDeps): Check {
  return toolCheck(
    'claude',
    deps,
    ['--version'],
    `Install the Claude Code CLI (INSTALL.md Step 6), then confirm with ${CLAUDE_CHECK_COMMAND}`,
  );
}

function dashboardCheck(deps: DoctorDeps): Check {
  const wanted = [
    path.join(deps.root, 'ui', 'server', 'dist', 'index.js'),
    path.join(deps.root, 'ui', 'dist', 'index.html'),
  ];
  const absent = wanted.filter((f) => !deps.exists(f));
  if (absent.length === 0) return ok('dashboard', 'built dashboard files are present');
  return {
    id: 'dashboard',
    status: 'missing',
    detail: `not built: ${absent.map((f) => path.relative(deps.root, f)).join(', ')}`,
    fix: 'Run pnpm build:server and pnpm build:ui in the clone',
  };
}

/**
 * Epic criterion 11: both concurrency caps are set above the harness defaults.
 * Per variable the first source wins: process env, project settings.local.json,
 * project settings.json, user settings. Reads files only.
 */
function capsCheck(deps: DoctorDeps): Check {
  const fix =
    'Re-run bs init in the project and restart Claude Code (it writes the caps); ' +
    'or set both in the user settings env block (INSTALL.md "Raise the concurrency caps")';
  const projectDir = process.cwd();
  const files = [
    path.join(projectDir, '.claude', 'settings.local.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    defaultUserSettingsPath(deps.env, deps.home),
  ];
  const notes: string[] = [];
  const blocks = files.map((file) => {
    let text: string;
    try {
      text = deps.readFile(file);
    } catch {
      return undefined; // Absent: nothing to say.
    }
    const block = parseSettingsEnv(text);
    if (block === undefined) notes.push(`skipped invalid JSON in ${file}`);
    return block === undefined ? undefined : { file, block };
  });
  const problems: string[] = [];
  const seen: string[] = [];
  for (const name of Object.keys(CONCURRENCY_CAPS)) {
    const floor = name.includes('SUBAGENTS') ? DEFAULT_SUBAGENT_CAP : DEFAULT_TOOL_CALL_CAP;
    let value: unknown = deps.env[name];
    let source = 'process env';
    if (value === undefined) {
      for (const b of blocks) {
        if (b !== undefined && name in b.block) {
          value = b.block[name];
          source = b.file;
          break;
        }
      }
    }
    if (value === undefined) {
      problems.push(`${name} is not set`);
      continue;
    }
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
      problems.push(`${name} is ${JSON.stringify(value)} (not an integer) in ${source}`);
    } else if (Number(text) <= floor) {
      problems.push(`${name} is ${text} in ${source} (needs above ${floor})`);
    } else {
      seen.push(`${name}=${text} (${source})`);
    }
  }
  const tail = notes.length > 0 ? `; ${notes.join('; ')}` : '';
  if (problems.length === 0) return ok('concurrency-caps', `${seen.join(', ')}${tail}`);
  return {
    id: 'concurrency-caps',
    status: 'unknown',
    detail: `${problems.join('; ')}${tail}`,
    fix,
  };
}

export function runChecks(deps: DoctorDeps): Check[] {
  return [
    nodeCheck(deps),
    toolCheck('pnpm', deps, ['--version'], 'Run corepack enable (INSTALL.md Part 1)'),
    toolCheck('git', deps, ['--version'], 'Install git 2.38 or newer (INSTALL.md Part 1)'),
    deps.bsVersion === undefined
      ? {
          id: 'bs',
          status: 'unknown',
          detail: 'no version found in package.json',
          fix: 'Reinstall with npm i -g @juzser/blacksmith',
        }
      : ok('bs', deps.bsVersion),
    claudeCheck(deps),
    pluginCheck(deps),
    dashboardCheck(deps),
    capsCheck(deps),
  ];
}

export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === 'missing') ? 1 : 0;
}

/** One line per check, status first. */
export function formatChecks(checks: Check[]): string {
  return `${checks
    .map((c) => {
      const tail = c.status === 'ok' || c.fix === '' ? '' : ` -> ${c.fix}`;
      return `${c.status.padEnd(7)} ${c.id.padEnd(9)} ${c.detail}${tail}`;
    })
    .join('\n')}\n`;
}

export function realDeps(root: string): DoctorDeps {
  let pkg: { version?: string; engines?: { node?: string } } = {};
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    // Left empty: the node and bs probes then report unknown.
  }
  return {
    nodeVersion: process.version,
    enginesNode: pkg.engines?.node,
    bsVersion: pkg.version,
    root,
    env: process.env,
    home: homedir(),
    readFile: (file) => readFileSync(file, 'utf8'),
    exists: existsSync,
    run: (cmd, args, timeoutMs) => {
      const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
      const code = res.error ? (res.error as NodeJS.ErrnoException).code : undefined;
      return {
        status: res.status,
        stdout: res.stdout ?? '',
        ...(res.error ? { error: code ?? res.error.message } : {}),
      };
    },
  };
}
