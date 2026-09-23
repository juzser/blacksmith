/**
 * `smith agents sync` — set each agent template's `maxTurns:` from the box's
 * env, or put it back to the committed value.
 *
 * A turn cap is per role, never per task: Claude Code reads it from the
 * template's frontmatter when it spawns the agent, so the only lever is the
 * template file itself. This rewrites that one line and nothing else. The
 * edit is local and left uncommitted on purpose — a raised cap on one box is
 * that box's business, and `--reset` restores what git HEAD says.
 *
 * SMITH_MAXTURNS_<ROLE> names the role upper-cased with `-` as `_`
 * (spec-reviewer → SMITH_MAXTURNS_SPEC_REVIEWER).
 */
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { GitCommandError, runGit, runGitRaw } from './git.js';
import { AGENTS_DIR } from './paths.js';

export class AgentsSyncError extends SmithError {}

export const MAXTURNS_ENV_PREFIX = 'SMITH_MAXTURNS_';

export function maxTurnsEnvName(role: string): string {
  return `${MAXTURNS_ENV_PREFIX}${role.toUpperCase().replaceAll('-', '_')}`;
}

export interface MaxTurnsChange {
  role: string;
  env: string;
  from: number;
  to: number;
  changed: boolean;
}

export interface AgentsSyncReport {
  mode: 'sync' | 'reset';
  dryRun: boolean;
  agentsDir: string;
  roles: string[];
  changes: MaxTurnsChange[];
}

type Env = Readonly<Record<string, string | undefined>>;

const MAX_TURNS_LINE = /^maxTurns:[ \t]*(\S*)[ \t]*$/m;

function listRoles(agentsDir: string): string[] {
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

/** The frontmatter block's bounds: the text between the leading `---` lines. */
function frontmatterBounds(text: string): { start: number; end: number } | null {
  const open = text.match(/^---\r?\n/);
  if (!open) return null;
  const start = open[0].length;
  const close = /^---[ \t]*$/m.exec(text.slice(start));
  if (!close) return null;
  return { start, end: start + close.index };
}

interface MaxTurnsSite {
  value: number;
  /** Absolute offsets of the value text inside the file. */
  from: number;
  to: number;
}

function findMaxTurns(text: string, file: string): MaxTurnsSite {
  const bounds = frontmatterBounds(text);
  const block = bounds ? text.slice(bounds.start, bounds.end) : '';
  const match = bounds ? MAX_TURNS_LINE.exec(block) : null;
  const raw = match?.[1] ?? '';
  if (!bounds || !match || !/^[0-9]+$/.test(raw)) {
    throw new AgentsSyncError(
      'agents.no-max-turns',
      `${file} has no frontmatter "maxTurns: <integer>" line to rewrite.`,
      { file },
    );
  }
  const valueStart = bounds.start + match.index + match[0].indexOf(raw, 'maxTurns:'.length);
  return { value: Number(raw), from: valueStart, to: valueStart + raw.length };
}

function withMaxTurns(text: string, site: MaxTurnsSite, value: number): string {
  return `${text.slice(0, site.from)}${value}${text.slice(site.to)}`;
}

function positiveInt(name: string, raw: string): number {
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentsSyncError(
      'agents.invalid-env',
      `${name} must be a positive integer (digits only); got ${JSON.stringify(raw)}.`,
      { variable: name },
    );
  }
  return value;
}

interface PlannedEdit {
  change: MaxTurnsChange;
  file: string;
  next: string;
}

function apply(edits: PlannedEdit[], dryRun: boolean): MaxTurnsChange[] {
  if (!dryRun) {
    for (const edit of edits) if (edit.change.changed) writeFileSync(edit.file, edit.next);
  }
  return edits.map((edit) => edit.change);
}

/**
 * Rewrite `maxTurns:` for every role whose SMITH_MAXTURNS_<ROLE> is set
 * (non-empty). Every name and value is checked, and every target file read,
 * before anything is written: one bad entry refuses the whole sync.
 */
export function syncAgentMaxTurns(
  options: { agentsDir?: string; env?: Env; dryRun?: boolean } = {},
): AgentsSyncReport {
  const agentsDir = options.agentsDir ?? AGENTS_DIR;
  const env = options.env ?? process.env;
  const dryRun = options.dryRun ?? false;
  const roles = listRoles(agentsDir);
  const byEnv = new Map(roles.map((role) => [maxTurnsEnvName(role), role]));

  const requested: Array<{ role: string; env: string; to: number }> = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(MAXTURNS_ENV_PREFIX)) continue;
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const role = byEnv.get(name);
    if (role === undefined) {
      throw new AgentsSyncError(
        'agents.unknown-role',
        `${name} names no agent template; valid roles: ${roles.join(', ')}.`,
        { variable: name, roles },
      );
    }
    requested.push({ role, env: name, to: positiveInt(name, raw) });
  }
  requested.sort((a, b) => a.role.localeCompare(b.role));

  const edits = requested.map(({ role, env: name, to }): PlannedEdit => {
    const file = path.join(agentsDir, `${role}.md`);
    const text = readFileSync(file, 'utf8');
    const site = findMaxTurns(text, file);
    return {
      change: { role, env: name, from: site.value, to, changed: site.value !== to },
      file,
      next: withMaxTurns(text, site, to),
    };
  });
  return { mode: 'sync', dryRun, agentsDir, roles, changes: apply(edits, dryRun) };
}

/**
 * Put every template's `maxTurns:` back to the value committed at git HEAD,
 * touching only that line — any other local edit to the file stays. Refuses
 * when the templates are not in a git checkout, rather than guess a default.
 */
export function resetAgentMaxTurns(
  options: { agentsDir?: string; dryRun?: boolean } = {},
): AgentsSyncReport {
  const agentsDir = options.agentsDir ?? AGENTS_DIR;
  const dryRun = options.dryRun ?? false;
  const roles = listRoles(agentsDir);

  let topLevel: string;
  try {
    topLevel = runGit(agentsDir, ['rev-parse', '--show-toplevel']);
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    throw new AgentsSyncError(
      'agents.reset-unavailable',
      `--reset needs git HEAD, but ${agentsDir} is not inside a git checkout.`,
      { agentsDir },
    );
  }

  const edits = roles.map((role): PlannedEdit => {
    const file = path.join(agentsDir, `${role}.md`);
    const rel = path.relative(topLevel, realpathSync(file)).split(path.sep).join('/');
    let committed: string;
    try {
      committed = runGitRaw(topLevel, ['show', `HEAD:${rel}`]);
    } catch (err) {
      if (!(err instanceof GitCommandError)) throw err;
      throw new AgentsSyncError(
        'agents.reset-unavailable',
        `--reset needs ${rel} at git HEAD, and it is not there.`,
        { file: rel },
      );
    }
    const to = findMaxTurns(committed, `HEAD:${rel}`).value;
    const text = readFileSync(file, 'utf8');
    const site = findMaxTurns(text, file);
    return {
      change: {
        role,
        env: maxTurnsEnvName(role),
        from: site.value,
        to,
        changed: site.value !== to,
      },
      file,
      next: withMaxTurns(text, site, to),
    };
  });
  return { mode: 'reset', dryRun, agentsDir, roles, changes: apply(edits, dryRun) };
}
