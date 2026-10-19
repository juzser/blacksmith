// The one definition of Claude Code transcript token spend, shared by the
// dashboard Budget and the per-session reader below.
//
// Spend of one assistant record = input_tokens + cache_creation_input_tokens
// + output_tokens. Cache reads are left out. A record repeated under the same
// message id and request id is one response and counts once. Only token
// fields, ids and a sub-agent's `subagent_type` are ever read; message text
// never reaches any output. Every total is `{used, complete}`: `complete` is
// false whenever an expected file was missing, unreadable or held an
// unparseable line, so `used` is a floor, never a guess.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { roleOfAgentType } from './agentNames.js';
import { loadTaxonomy } from './taxonomy.js';

const TOKEN_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'output_tokens'] as const;

interface AssistantParts {
  id: unknown;
  requestId: unknown;
  usage: Record<string, unknown>;
}

function assistantParts(rec: unknown): AssistantParts | null {
  if (typeof rec !== 'object' || rec === null) return null;
  const r = rec as { type?: unknown; requestId?: unknown; message?: unknown };
  if (r.type !== 'assistant') return null;
  const msg = r.message as { id?: unknown; usage?: unknown } | null | undefined;
  if (typeof msg !== 'object' || msg === null) return null;
  const usage = msg.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  return { id: msg.id, requestId: r.requestId, usage: usage as Record<string, unknown> };
}

/** Tokens one parsed transcript record spends; 0 for anything but an assistant record with usage. */
export function countRecordTokens(rec: unknown): number {
  const p = assistantParts(rec);
  if (p === null) return 0;
  let total = 0;
  for (const k of TOKEN_FIELDS) {
    const n = p.usage[k];
    if (typeof n === 'number' && Number.isFinite(n)) total += n;
  }
  return total;
}

/** message.id + requestId; null when the record has no string message id (it is then never deduplicated). */
export function dedupeKey(rec: unknown): string | null {
  const p = assistantParts(rec);
  if (p === null || typeof p.id !== 'string') return null;
  return `${p.id}\u0000${typeof p.requestId === 'string' ? p.requestId : ''}`;
}

export interface TranscriptFs {
  readFile(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
}

const nodeFs: TranscriptFs = {
  readFile: (file) => readFile(file, 'utf8'),
  readdir: (dir) => readdir(dir),
};

export interface SubagentTokens {
  agentId: string;
  role: string | null;
  used: number;
  complete: boolean;
}
export interface SessionTokens {
  used: number;
  complete: boolean;
  subagents: SubagentTokens[];
}

const PLAIN_TOKEN = /^[A-Za-z0-9_.-]+$/;
/** Non-empty, ASCII letters, digits, `-`, `_`, `.`, no `..`: so no separator and no absolute form. */
function isPlainToken(s: string): boolean {
  return PLAIN_TOKEN.test(s) && !s.includes('..');
}

/**
 * The one gate every path goes through: each segment must be a plain token
 * and the resolved result must sit inside `configDir`. Null means "do not open".
 */
function safeJoin(configDir: string, segments: string[]): string | null {
  if (!segments.every(isPlainToken)) return null;
  const root = path.resolve(configDir);
  const full = path.resolve(root, ...segments);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

const NOTHING_READ = (): SessionTokens => ({ used: 0, complete: false, subagents: [] });

interface Scan {
  used: number;
  complete: boolean;
  /** tool_use id -> subagent_type, collected only when asked for. */
  launches: Map<string, string>;
}

async function scanFile(
  fsr: TranscriptFs,
  file: string,
  wantLaunches: boolean,
): Promise<Scan | null> {
  let text: string;
  try {
    text = await fsr.readFile(file);
  } catch {
    return null;
  }
  const scan: Scan = { used: 0, complete: true, launches: new Map() };
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      scan.complete = false;
      continue;
    }
    const key = dedupeKey(rec);
    if (key === null || !seen.has(key)) {
      if (key !== null) seen.add(key);
      scan.used += countRecordTokens(rec);
    }
    if (wantLaunches) collectLaunches(rec, scan.launches);
  }
  return scan;
}

function collectLaunches(rec: unknown, into: Map<string, string>): void {
  if (typeof rec !== 'object' || rec === null) return;
  const content = (rec as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue;
    const blk = b as { type?: unknown; id?: unknown; input?: { subagent_type?: unknown } | null };
    if (blk.type !== 'tool_use' || typeof blk.id !== 'string') continue;
    const t = blk.input?.subagent_type;
    if (typeof t === 'string') into.set(blk.id, t);
  }
}

function roleFor(type: string | undefined, roles: ReadonlySet<string>): string | null {
  if (type === undefined) return null;
  const role = roleOfAgentType(type, { bareAccepted: false });
  return role !== null && roles.has(role) ? role : null;
}

async function listDir(fsr: TranscriptFs, dir: string): Promise<string[] | 'missing' | 'error'> {
  try {
    return await fsr.readdir(dir);
  } catch (e) {
    return (e as { code?: string }).code === 'ENOENT' ? 'missing' : 'error';
  }
}

/** Tokens of one CLI session: the main transcript plus every sub-agent transcript beside it. */
export async function readSessionTokens(opts: {
  configDir: string;
  cliSessionId: string;
  fs?: TranscriptFs;
  /** Taxonomy agent roles; defaults to the committed taxonomy. */
  roles?: readonly string[];
}): Promise<SessionTokens> {
  const { configDir, cliSessionId } = opts;
  const fsr = opts.fs ?? nodeFs;
  if (!isPlainToken(cliSessionId)) return NOTHING_READ();
  const projectsDir = safeJoin(configDir, ['projects']);
  if (projectsDir === null) return NOTHING_READ();
  const projects = await listDir(fsr, projectsDir);
  if (typeof projects === 'string') return NOTHING_READ();

  let mainScan: Scan | null = null;
  let projectDir = '';
  for (const p of projects) {
    const file = safeJoin(configDir, ['projects', p, `${cliSessionId}.jsonl`]);
    if (file === null) continue;
    mainScan = await scanFile(fsr, file, true);
    if (mainScan !== null) {
      projectDir = p;
      break;
    }
  }
  if (mainScan === null) return NOTHING_READ();

  let roles: ReadonlySet<string>;
  try {
    roles = new Set(opts.roles ?? loadTaxonomy().dimensions.agent ?? []);
  } catch {
    roles = new Set();
  }

  let complete = mainScan.complete;
  let used = mainScan.used;
  const subagents: SubagentTokens[] = [];
  const subDir = safeJoin(configDir, ['projects', projectDir, cliSessionId, 'subagents']);
  const listing = subDir === null ? 'error' : await listDir(fsr, subDir);
  if (listing === 'error') complete = false;
  else if (listing !== 'missing') {
    for (const name of [...listing].sort()) {
      const m = /^agent-(.*)\.jsonl$/.exec(name);
      if (m === null) continue;
      const agentId = m[1] ?? '';
      const file = safeJoin(configDir, ['projects', projectDir, cliSessionId, 'subagents', name]);
      if (file === null || !isPlainToken(agentId)) {
        complete = false;
        continue;
      }
      const scan = await scanFile(fsr, file, false);
      if (scan === null) {
        complete = false;
        subagents.push({ agentId, role: null, used: 0, complete: false });
        continue;
      }
      let role: string | null = null;
      let subComplete = scan.complete;
      const metaFile = safeJoin(configDir, [
        'projects',
        projectDir,
        cliSessionId,
        'subagents',
        `agent-${agentId}.meta.json`,
      ]);
      let toolUseId: unknown;
      try {
        if (metaFile === null) throw new Error('outside');
        toolUseId = (JSON.parse(await fsr.readFile(metaFile)) as { toolUseId?: unknown }).toolUseId;
      } catch {
        subComplete = false;
      }
      if (typeof toolUseId === 'string') role = roleFor(mainScan.launches.get(toolUseId), roles);
      used += scan.used;
      if (!subComplete) complete = false;
      subagents.push({ agentId, role, used: scan.used, complete: subComplete });
    }
  }
  return { used, complete, subagents };
}
