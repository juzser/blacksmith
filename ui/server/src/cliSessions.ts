// Live Claude Code CLI sessions for `GET /api/cli-sessions`: which sessions are
// running, whether each is working / waiting for the operator / idle, what it
// is doing, and which factory run (epic, wave, progress) it drives.
//
// Inputs, all read-only and none of them a Blacksmith log:
// - `<configDir>/sessions/<pid>.json`, the CLI's own registry (name, busy|idle,
//   cwd, sessionId). Only names matching /^\d+\.json$/ are ever opened: the
//   same directory holds `<pid>.<hash>.key` files, which are secrets, so the
//   directory listing is filtered by name BEFORE any open and a key file is
//   never opened, stat'ed or echoed.
// - `<configDir>/projects/<cwd, "/" -> "-">/<sessionId>.jsonl`, the transcript,
//   read only in bounded slices (tail 256 KB, one retry at 1 MB, head 64 KB,
//   never a whole-file read) behind a (path, size, mtime) cache, so an
//   unchanged session costs one stat. Nothing from a transcript is logged.
// - the projection, via `cliSessionLinks` (events_raw.cli_session_id): the
//   stamp events.ts puts on every write made inside a CLI session.
//
// Scope (what counts as a Blacksmith session): cwd inside a known root, a
// `<root parent>/.wt/<root name>/` worktree or a `git worktree list` entry
// (`cwd`); a session that wrote a stamped event (`stamped`); or, for a session
// outside every root that predates the stamp, a transcript that mentions /bs
// (`heuristic`, linked stays null). The heuristic reads the transcript tail and
// also its HEAD (first 64 KB), since a /bs invocation usually sits at the start
// of a long session, beyond a 256 KB tail. And once a sessionId is in scope it
// stays in scope for the life of the server process (sticky), so a long
// discussion that scrolls the evidence away does not drop the card.
//
// Status is derived per request from the registry and the transcript and is
// never stored (architecture §18 rule 2). Every text field is capped at 280
// chars with control characters stripped; no absolute path, socket path or
// process start time is ever put in the response.
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { DbHandle } from '../../../factory/orchestrator/dist/db/projector.js';
import type { StatusCounts } from '../../../factory/orchestrator/dist/db/queries.js';
import {
  type CliSessionLink,
  cliSessionLinks,
  kanban,
  projectedLineage,
  runningSessions,
  sessionAgents,
  statusBucketForTaskStatus,
} from '../../../factory/orchestrator/dist/db/queries.js';
import { taskIdsMatch } from '../../../factory/orchestrator/dist/taskId.js';

export interface CliFs {
  readdir(p: string): Promise<string[]>;
  stat(p: string): Promise<{ size: number; mtimeMs: number }>;
  /** Does not follow a symlink: only a regular file is ever opened. */
  lstat(p: string): Promise<{ isFile(): boolean }>;
  open(p: string): Promise<Pick<FileHandle, 'read' | 'close'>>;
  realpath(p: string): Promise<string>;
}

const nodeFs: CliFs = {
  readdir: (p) => fsp.readdir(p),
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  // Non-blocking and no-follow, so a file swapped for a FIFO or a symlink
  // after the lstat check can neither block the read nor redirect it.
  open: (p) =>
    fsp.open(p, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0)),
  realpath: (p) => fsp.realpath(p),
};

export type CliConfigSource = 'flag' | 'env' | 'default' | 'none';
export type CliSessionStatus =
  | 'working'
  | 'waiting_answer'
  | 'waiting_operator'
  | 'idle'
  | 'unknown';

export interface LinkedEpic {
  rootSessionId: string;
  epicId: string | null;
  project: string | null;
  title: string | null;
  factorySessionIds: string[];
  /** The newest event this CLI session wrote into any of `factorySessionIds`. */
  lastEventAt: string;
  currentWave: { sessionId: string; taskIds: string[]; counts: StatusCounts } | null;
  progress: StatusCounts | null;
  workingAgents: { role: string; taskId: string | null }[];
}

export interface CliSessionCard {
  cliSessionId: string;
  pid: number;
  name: string | null;
  nameSource: string | null;
  startedAt: string | null;
  cwdLabel: string;
  inScopeBy: 'cwd' | 'stamped' | 'heuristic';
  status: CliSessionStatus;
  statusSince: string | null;
  doingNow: { prompt: string | null; assistant: string | null; lastTool: string | null } | null;
  next: string | null;
  transcript: 'ok' | 'missing' | 'tail-empty' | 'unreadable';
  linked: { epics: LinkedEpic[] } | null;
  parseIssues: string[];
}

export interface CliSessionsResponse {
  state: 'ok' | 'absent' | 'unreadable';
  configSource: CliConfigSource;
  readAt: string;
  formatWarning: string | null;
  hidden: { outOfScope: number; dead: number; unparsed: number; nonInteractive: number };
  sessions: CliSessionCard[];
}

export interface CliSessionsDeps {
  configDir: string | undefined;
  configSource: CliConfigSource;
  roots: readonly string[];
  nowIso: () => string;
  /** `process.kill(pid, 0)` by default (EPERM = alive). */
  isAlive?: (pid: number) => boolean;
  fs?: CliFs;
  /** Hand-made worktrees; `git worktree list` (cached 5 min) by default. */
  listWorktrees?: () => Promise<string[]>;
  /** Response cache window, 1 s by default. */
  cacheMs?: number;
  /** Compare paths case-insensitively; true on darwin and win32 by default. */
  foldCase?: boolean;
}

const SESSION_FILE_MAX = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const TAIL_RETRY_BYTES = 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TEXT_MAX = 280;
const VERSION_MAX = 32;
const KNOWN_VERSION = /^2\.1(\.|$)/;
const WORKTREES_TTL_MS = 5 * 60 * 1000;
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function gitWorktrees(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['worktree', 'list', '--porcelain'], { cwd, timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(
        out
          .split('\n')
          .filter((l) => l.startsWith('worktree '))
          .map((l) => l.slice('worktree '.length).trim()),
      );
    });
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

function clean(value: string): string {
  const flat = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  // Cut on code points, so a surrogate pair is never split.
  const points = Array.from(flat);
  return points.length > TEXT_MAX ? points.slice(0, TEXT_MAX).join('') : flat;
}

async function readSlice(fs: CliFs, file: string, pos: number, len: number): Promise<Buffer> {
  // A FIFO, device, directory or symlink is refused before any open.
  if (!(await fs.lstat(file)).isFile()) throw new Error('not a regular file');
  const fh = await fs.open(file);
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v !== null && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch {
      // a cut line or a format we do not know: skipped, never fatal
    }
  }
  return out;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: { command?: unknown };
}

function blocksOf(entry: Record<string, unknown>): Block[] {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

const BS_COMMAND = /<command-name>\s*\/bs\b/;
const BS_BASH = /(^|[\s;&|(])bs\s|orchestrator\/dist\/cli\.js/;

function mentionsBs(entries: Record<string, unknown>[]): boolean {
  for (const e of entries) {
    for (const b of blocksOf(e)) {
      if (e.type === 'user' && b.type === 'text' && BS_COMMAND.test(b.text ?? '')) return true;
      if (
        e.type === 'assistant' &&
        b.type === 'tool_use' &&
        b.name === 'Bash' &&
        typeof b.input?.command === 'string' &&
        BS_BASH.test(b.input.command)
      ) {
        return true;
      }
    }
  }
  return false;
}

function operatorText(raw: string): string | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(raw);
  if (name) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(raw);
    return clean(`${name[1] ?? ''} ${args?.[1] ?? ''}`) || null;
  }
  const trimmed = raw.trim();
  // Harness-injected records (reminders, local and shell command echoes,
  // task notifications, memory input) are not something the operator typed.
  if (
    trimmed === '' ||
    /^<(system-reminder|local-command|command-message|bash-input|bash-stdout|bash-stderr|task-notification|user-memory-input)/.test(
      trimmed,
    )
  ) {
    return null;
  }
  return clean(trimmed) || null;
}

interface Analysis {
  meaningful: boolean;
  last: 'user' | 'tool_result' | 'interrupt' | 'assistant_text' | 'assistant_tool' | null;
  pendingAsk: string | null;
  prompt: string | null;
  assistant: string | null;
  next: string | null;
  lastTool: string | null;
  bsMention: boolean;
}

function analyse(entries: Record<string, unknown>[]): Analysis {
  const a: Analysis = {
    meaningful: false,
    last: null,
    pendingAsk: null,
    prompt: null,
    assistant: null,
    next: null,
    lastTool: null,
    bsMention: mentionsBs(entries),
  };
  for (const e of entries) {
    if (e.isSidechain === true || e.isMeta === true || e.isCompactSummary === true) continue;
    if (e.type === 'user') {
      const blocks = blocksOf(e);
      if (blocks.some((b) => b.type === 'tool_result')) {
        a.meaningful = true;
        a.last = 'tool_result';
        for (const b of blocks) if (b.tool_use_id === a.pendingAsk) a.pendingAsk = null;
        continue;
      }
      const raw = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
      if (raw.trimStart().startsWith('[Request interrupted')) {
        a.meaningful = true;
        a.last = 'interrupt';
        continue;
      }
      const prompt = operatorText(raw);
      if (prompt !== null) {
        a.meaningful = true;
        a.last = 'user';
        a.prompt = prompt;
      }
    } else if (e.type === 'assistant') {
      for (const b of blocksOf(e)) {
        if (b.type === 'text' && (b.text ?? '').trim() !== '') {
          a.meaningful = true;
          a.last = 'assistant_text';
          const body = b.text ?? '';
          a.assistant = clean(body);
          const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim() !== '');
          a.next = clean(paragraphs[paragraphs.length - 1] ?? '') || null;
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          a.meaningful = true;
          a.last = 'assistant_tool';
          a.lastTool = clean(b.name);
          if (b.name === 'AskUserQuestion' && typeof b.id === 'string') a.pendingAsk = b.id;
        }
      }
    }
  }
  return a;
}

interface RegistryEntry {
  pid: number;
  cliSessionId: string;
  cwd: string;
  name: string | null;
  nameSource: string | null;
  startedAt: string | null;
  status: CliSessionStatus;
  statusSince: string | null;
  version: string | null;
  /** One `<field>: invalid` per registry field that was present but dropped. */
  parseIssues: string[];
}

// 8.64e15 ms is the largest instant a Date can hold; past it toISOString throws.
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 8.64e15
    ? new Date(v).toISOString()
    : null;
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? clean(v) : null;

function parseRegistry(
  filePid: number,
  raw: string,
): { entry: RegistryEntry; kind: string | null } | null {
  let j: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    j = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (j.pid !== filePid) return null;
  if (typeof j.sessionId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(j.sessionId)) return null;
  if (typeof j.cwd !== 'string' || !path.isAbsolute(j.cwd)) return null;
  const status: CliSessionStatus =
    j.status === 'busy' ? 'working' : j.status === 'idle' ? 'idle' : 'unknown';
  const version =
    typeof j.version === 'string'
      ? Array.from(clean(j.version)).slice(0, VERSION_MAX).join('') || null
      : null;
  const entry: RegistryEntry = {
    pid: filePid,
    cliSessionId: j.sessionId,
    cwd: j.cwd,
    name: strOrNull(j.name),
    nameSource: strOrNull(j.nameSource),
    startedAt: isoOrNull(j.startedAt),
    status,
    statusSince: isoOrNull(j.statusUpdatedAt),
    version,
    parseIssues: [],
  };
  // A field that is absent is not an issue; one that is present and was
  // dropped is, named by field only, never by value.
  const dropped: [string, boolean][] = [
    ['name', typeof j.name !== 'string'],
    ['nameSource', typeof j.nameSource !== 'string'],
    ['startedAt', entry.startedAt === null],
    ['status', status === 'unknown'],
    ['statusUpdatedAt', entry.statusSince === null],
    ['version', entry.version === null],
  ];
  for (const [field, lost] of dropped) {
    if (lost && j[field] !== undefined && j[field] !== null)
      entry.parseIssues.push(`${field}: invalid`);
  }
  return { kind: typeof j.kind === 'string' ? j.kind : null, entry };
}

interface TranscriptRead {
  state: CliSessionCard['transcript'];
  analysis: Analysis | null;
  headBs: boolean;
}

export function createCliSessionsReader(deps: CliSessionsDeps): {
  read(handle?: DbHandle): Promise<CliSessionsResponse>;
} {
  const fs = deps.fs ?? nodeFs;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const cacheMs = deps.cacheMs ?? 1000;
  const listWorktrees = deps.listWorktrees ?? (() => gitWorktrees(deps.roots[0] ?? '.'));

  const sticky = new Map<string, CliSessionCard['inScopeBy']>();
  const transcriptPaths = new Map<string, string>();
  const transcriptCache = new Map<
    string,
    { size: number; mtimeMs: number; read: TranscriptRead }
  >();
  let worktrees: { at: number; dirs: string[] } | null = null;
  let memo: { at: number; value: Promise<CliSessionsResponse> } | null = null;

  const foldCase = deps.foldCase ?? FOLD_CASE;
  const norm = (p: string): string => (foldCase ? p.toLowerCase() : p);
  const real = async (p: string): Promise<string> => {
    try {
      return await fs.realpath(p);
    } catch {
      return path.resolve(p);
    }
  };

  async function scopeRoots(): Promise<string[]> {
    const now = Date.now();
    if (worktrees === null || now - worktrees.at > WORKTREES_TTL_MS) {
      let dirs: string[] = [];
      try {
        dirs = await listWorktrees();
      } catch {
        dirs = [];
      }
      worktrees = { at: now, dirs };
    }
    const base = await Promise.all(deps.roots.map(real));
    const wtParents = base.map((r) => path.join(path.dirname(r), '.wt', path.basename(r)));
    const extra = await Promise.all(worktrees.dirs.map(real));
    return [...base, ...wtParents, ...extra];
  }

  function within(cwd: string, roots: readonly string[]): { root: string } | null {
    const c = norm(cwd);
    for (const r of roots) {
      const n = norm(r);
      if (c === n || c.startsWith(n.endsWith(path.sep) ? n : n + path.sep)) return { root: r };
    }
    return null;
  }

  function labelFor(cwd: string, hit: { root: string } | null): string {
    if (hit === null) return path.basename(cwd) || '.';
    const rel = path.relative(hit.root, cwd);
    if (rel === '') return path.basename(hit.root) || '.';
    // A case-folded match is not one to path.relative, which then climbs out
    // of the root: never an absolute or `..` label, the basename instead.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return path.basename(cwd) || '.';
    return rel;
  }

  async function findTranscript(configDir: string, e: RegistryEntry): Promise<string | null> {
    const cached = transcriptPaths.get(e.cliSessionId);
    const primary = path.join(
      configDir,
      'projects',
      e.cwd.replace(/\//g, '-'),
      `${e.cliSessionId}.jsonl`,
    );
    for (const candidate of [cached, primary]) {
      if (candidate === undefined) continue;
      try {
        await fs.stat(candidate);
        transcriptPaths.set(e.cliSessionId, candidate);
        return candidate;
      } catch {
        // try the next
      }
    }
    let dirs: string[];
    try {
      dirs = await fs.readdir(path.join(configDir, 'projects'));
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = path.join(configDir, 'projects', d, `${e.cliSessionId}.jsonl`);
      try {
        await fs.stat(candidate);
        transcriptPaths.set(e.cliSessionId, candidate);
        return candidate;
      } catch {
        // not in this dir
      }
    }
    return null;
  }

  async function readTranscript(configDir: string, e: RegistryEntry): Promise<TranscriptRead> {
    const file = await findTranscript(configDir, e);
    if (file === null) return { state: 'missing', analysis: null, headBs: false };
    try {
      const st = await fs.stat(file);
      const hit = transcriptCache.get(file);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.read;

      let analysis: Analysis | null = null;
      for (const window of [TAIL_BYTES, TAIL_RETRY_BYTES]) {
        const pos = Math.max(0, st.size - window);
        const buf = await readSlice(fs, file, pos, Math.min(window, st.size));
        let body = buf.toString('utf8');
        // A slice that starts mid-file starts mid-line: that line is dropped.
        if (pos > 0) body = body.slice(body.indexOf('\n') + 1);
        const a = analyse(parseLines(body));
        analysis = a;
        if (a.meaningful || pos === 0) break;
      }
      let headBs = false;
      if (analysis !== null && st.size > TAIL_BYTES) {
        const head = await readSlice(fs, file, 0, Math.min(HEAD_BYTES, st.size));
        headBs = mentionsBs(parseLines(head.toString('utf8')));
      }
      const result: TranscriptRead = {
        state: analysis?.meaningful ? 'ok' : 'tail-empty',
        analysis,
        headBs,
      };
      transcriptCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, read: result });
      return result;
    } catch {
      return { state: 'unreadable', analysis: null, headBs: false };
    }
  }

  function statusOf(e: RegistryEntry, t: TranscriptRead): CliSessionStatus {
    if (e.status !== 'idle') return e.status;
    const a = t.analysis;
    if (a === null || t.state !== 'ok') return 'idle';
    if (a.pendingAsk !== null) return 'waiting_answer';
    if (a.last === 'assistant_text') return 'waiting_operator';
    return 'idle';
  }

  function linkEpics(
    handle: DbHandle,
    links: readonly CliSessionLink[],
    scopeNow: string,
  ): LinkedEpic[] {
    // Grouped by epic root, and each group read through the ROOT's lineage:
    // a wave's own lineage stops at that wave, so its sibling waves -- and
    // their admissions, merges and agents -- would be missed.
    const groups = new Map<string, { lineage: string[]; ids: string[]; lastEventAt: string }>();
    for (const l of links) {
      const known = [...groups.values()].find((g) => g.lineage.includes(l.sessionId));
      let g = known;
      if (g === undefined) {
        const own = projectedLineage(handle.db, l.sessionId);
        const rootId = own[0] ?? l.sessionId;
        g = groups.get(rootId);
        if (g === undefined) {
          const lineage = rootId === l.sessionId ? own : projectedLineage(handle.db, rootId);
          g = {
            lineage: lineage.length > 0 ? lineage : [rootId],
            ids: [],
            lastEventAt: l.lastEventAt,
          };
          groups.set(rootId, g);
        }
      }
      g.ids.push(l.sessionId);
      if (l.lastEventAt > g.lastEventAt) g.lastEventAt = l.lastEventAt;
    }
    const out: LinkedEpic[] = [];
    for (const [rootId, g] of groups) {
      const marks = g.lineage.map(() => '?').join(',');
      const waves = (
        handle.sqlite
          .prepare(
            `select session_id, payload from events_raw where event_type = 'wave-admitted' and session_id in (${marks}) order by ts, event_id`,
          )
          .all(...g.lineage) as { session_id: string; payload: string }[]
      ).flatMap((r) => {
        try {
          const p = JSON.parse(r.payload) as { epic_id?: unknown; task_ids?: unknown };
          return [
            {
              sessionId: r.session_id,
              epicId: typeof p.epic_id === 'string' ? p.epic_id : null,
              taskIds: Array.isArray(p.task_ids)
                ? p.task_ids.filter((t): t is string => typeof t === 'string')
                : [],
            },
          ];
        } catch {
          return [];
        }
      });
      const pick = (sql: string): string | null => {
        const row = handle.sqlite.prepare(sql).get(...g.lineage) as
          | { e: string | null }
          | undefined;
        return row?.e ?? null;
      };
      const epicId =
        waves.filter((w) => w.epicId !== null).at(-1)?.epicId ??
        pick(
          `select epic_id as e from tasks where epic_id is not null and session_id in (${marks}) order by updated_at desc limit 1`,
        ) ??
        pick(
          `select epic_id as e from agents where epic_id is not null and session_id in (${marks}) order by dispatched_at desc limit 1`,
        );

      let progress: StatusCounts | null = null;
      let project: string | null = null;
      let currentWave: LinkedEpic['currentWave'] = null;
      if (epicId !== null) {
        const taskRows = kanban(handle.db, epicId, {}, { nowIso: scopeNow }).flatMap(
          (c) => c.tasks,
        );
        const fold = (rows: { taskStatus: string }[]): StatusCounts => {
          const c: StatusCounts = { done: 0, review: 0, inProgress: 0, todo: 0, superseded: 0 };
          for (const r of rows) c[statusBucketForTaskStatus(r.taskStatus)] += 1;
          return c;
        };
        progress = fold(taskRows);
        project = taskRows.find((t) => t.project !== null)?.project ?? null;
        // Task ids are compared the way the rest of the read side compares
        // them (taskIdsMatch): a wave written with bare ids still matches
        // the qualified ids its tasks carry, and the other way round.
        const merged = (
          handle.sqlite
            .prepare(
              `select payload from events_raw where event_type = 'wave-merged' and session_id in (${marks})`,
            )
            .all(...g.lineage) as { payload: string }[]
        ).flatMap((r) => {
          try {
            const p = JSON.parse(r.payload) as { epic_id?: unknown; task_ids?: unknown };
            if (typeof p.epic_id === 'string' && p.epic_id !== epicId) return [];
            return Array.isArray(p.task_ids)
              ? p.task_ids.filter((t): t is string => typeof t === 'string')
              : [];
          } catch {
            return [];
          }
        });
        const isMerged = (t: string): boolean => merged.some((m) => taskIdsMatch(m, t));
        const open = waves
          .filter((w) => w.epicId === epicId && w.taskIds.some((t) => !isMerged(t)))
          .at(-1);
        if (open) {
          const byId = new Map(taskRows.map((t) => [t.taskId, t]));
          const row = (t: string) => byId.get(t) ?? taskRows.find((r) => taskIdsMatch(r.taskId, t));
          currentWave = {
            sessionId: open.sessionId,
            taskIds: open.taskIds,
            counts: fold(open.taskIds.flatMap((t) => row(t) ?? [])),
          };
        }
      }

      const workingAgents: LinkedEpic['workingAgents'] = [];
      for (const sid of g.lineage) {
        for (const role of sessionAgents(handle.db, sid, { nowIso: scopeNow }).roles) {
          for (const ag of role.agents) {
            if (ag.status === 'live')
              workingAgents.push({ role: role.agentRole, taskId: ag.taskId });
          }
        }
      }

      out.push({
        rootSessionId: rootId,
        epicId,
        project,
        title:
          runningSessions(handle.db, { sessionId: rootId }, { nowIso: scopeNow })[0]?.title ?? null,
        factorySessionIds: [...new Set(g.ids)].sort(),
        lastEventAt: g.lastEventAt,
        currentWave,
        progress,
        workingAgents,
      });
    }
    // Newest first: the epic this CLI session wrote into last leads.
    return out.sort(
      (a, b) =>
        b.lastEventAt.localeCompare(a.lastEventAt) ||
        a.rootSessionId.localeCompare(b.rootSessionId),
    );
  }

  async function compute(handle?: DbHandle): Promise<CliSessionsResponse> {
    const readAt = deps.nowIso();
    const hidden = { outOfScope: 0, dead: 0, unparsed: 0, nonInteractive: 0 };
    const base = {
      configSource: deps.configSource,
      readAt,
      formatWarning: null,
      hidden,
      sessions: [],
    };
    if (deps.configDir === undefined) return { state: 'absent', ...base };
    const sessionsDir = path.join(deps.configDir, 'sessions');
    let names: string[];
    try {
      names = await fs.readdir(sessionsDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { state: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable', ...base };
    }

    const entries: RegistryEntry[] = [];
    // Filtered by name before any open: a `.key` sibling is never touched.
    for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
      const filePid = Number.parseInt(name, 10);
      let raw: string;
      try {
        const buf = await readSlice(fs, path.join(sessionsDir, name), 0, SESSION_FILE_MAX + 1);
        if (buf.length > SESSION_FILE_MAX) {
          hidden.unparsed += 1;
          continue;
        }
        raw = buf.toString('utf8');
      } catch {
        hidden.unparsed += 1;
        continue;
      }
      const parsed = parseRegistry(filePid, raw);
      if (parsed === null) {
        hidden.unparsed += 1;
      } else if (!isAlive(filePid)) {
        hidden.dead += 1;
      } else if (parsed.kind !== null && parsed.kind !== 'interactive') {
        hidden.nonInteractive += 1;
      } else {
        entries.push(parsed.entry);
      }
    }

    const odd = entries.find((e) => e.version !== null && !KNOWN_VERSION.test(e.version));
    const formatWarning =
      odd === undefined
        ? null
        : `Unrecognised Claude Code version ${(odd.version ?? '').split('.').slice(0, 2).join('.')}; session data may be incomplete.`;

    const roots = await scopeRoots();
    const links = handle
      ? cliSessionLinks(
          handle.db,
          entries.map((e) => e.cliSessionId),
        )
      : [];
    const factoryBy = new Map<string, CliSessionLink[]>();
    for (const l of links)
      factoryBy.set(l.cliSessionId, [...(factoryBy.get(l.cliSessionId) ?? []), l]);

    const cards: CliSessionCard[] = [];
    for (const e of entries) {
      const cwd = await real(e.cwd);
      const hit = within(cwd, roots);
      const t = await readTranscript(deps.configDir, e);
      const stamped = factoryBy.has(e.cliSessionId);
      let by: CliSessionCard['inScopeBy'] | null = hit ? 'cwd' : stamped ? 'stamped' : null;
      if (by === null && (t.analysis?.bsMention || t.headBs)) by = 'heuristic';
      if (by !== null) sticky.set(e.cliSessionId, by);
      else by = sticky.get(e.cliSessionId) ?? null;
      if (by === null) {
        hidden.outOfScope += 1;
        continue;
      }
      const a = t.state === 'ok' ? t.analysis : null;
      const ids = factoryBy.get(e.cliSessionId);
      cards.push({
        cliSessionId: e.cliSessionId,
        pid: e.pid,
        name: e.name,
        nameSource: e.nameSource,
        startedAt: e.startedAt,
        cwdLabel: labelFor(cwd, hit),
        inScopeBy: by,
        status: statusOf(e, t),
        statusSince: e.statusSince,
        doingNow: a ? { prompt: a.prompt, assistant: a.assistant, lastTool: a.lastTool } : null,
        next: a?.next ?? null,
        transcript: t.state,
        linked: handle && ids ? { epics: linkEpics(handle, ids, readAt) } : null,
        parseIssues: e.parseIssues,
      });
    }
    cards.sort((x, y) => (x.startedAt ?? '').localeCompare(y.startedAt ?? '') || x.pid - y.pid);
    return {
      state: 'ok',
      configSource: deps.configSource,
      readAt,
      formatWarning,
      hidden,
      sessions: cards,
    };
  }

  return {
    read(handle) {
      const now = Date.now();
      if (memo !== null && now - memo.at < cacheMs) return memo.value;
      const value = compute(handle);
      memo = { at: now, value };
      // A failed read must not be served again for the next second.
      value.catch(() => {
        if (memo?.value === value) memo = null;
      });
      return value;
    },
  };
}
