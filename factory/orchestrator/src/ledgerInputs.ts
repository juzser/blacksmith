// The ledger's inputs (bs-check-tiers D6): one project's events across
// lineages, every task id qualified, and the claims map the guardrails read.
//
// Read-only. Every skip here is fail-safe and named: a plan that cannot be
// read only removes claims (its tasks then count as sensitive), and a session
// log that cannot be read marks the result degraded. Nothing is filtered by
// time: the window bounds travel beside the events and the caller applies
// them to the numbers only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { tryParseEventId } from './eventOrder.js';
import {
  eventTaskId,
  listSessionIds,
  mergeSessionLogs,
  readEvents,
  type SessionLog,
  type StoredEvent,
} from './events.js';
import { loadSensitivePathsPolicy } from './security.js';
import { epicOfTaskId, qualifyTaskId } from './taskId.js';

export class LedgerInputsError extends SmithError {}

/** What a task id becomes when no epic can be named for it. */
export const UNATTRIBUTED = 'unattributed';

const DAY_MS = 86_400_000;

export interface LedgerWarning {
  code: 'checks.plan-skipped' | 'checks.session-unreadable';
  path: string;
  reason?: string;
}

export interface LedgerInputsOptions {
  stateDir: string;
  /** The parent holding `<epic>/plan.json` and `<epic>/plan-v<n>.json`. */
  specsDir: string;
  sensitivePathsFile: string;
  now: Date;
  windowDays: number;
}

export interface LedgerInputs {
  events: StoredEvent[];
  window: { from: Date; to: Date };
  /** Qualified task id per event id, for every kept event that names a task. */
  taskIdOf: Map<string, string>;
  /** Claims per qualified task id; a task with no entry counts as sensitive. */
  taskClaims: Map<string, string[]>;
  sensitiveGlobs: string[];
  epics: string[];
  project: string;
  sessionsRead: number;
  warnings: LedgerWarning[];
  degraded: boolean;
}

interface PlanTask {
  taskId: string;
  claims: string[];
}

interface ReadPlan {
  project: string;
  rank: number;
  tasks: PlanTask[];
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The four fields the ledger reads, or the reason the file cannot be used. */
function parsePlan(text: string, epic: string, fileRank: number): ReadPlan | string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return `not JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const plan = doc as { project?: unknown; tasks?: unknown; version?: unknown } | null;
  if (typeof plan !== 'object' || plan === null) return 'not an object';
  if (typeof plan.project !== 'string' || plan.project.length === 0) return 'no project';
  if (!Array.isArray(plan.tasks)) return 'no tasks array';
  const tasks: PlanTask[] = [];
  for (const raw of plan.tasks as Array<{ task_id?: unknown; claims?: unknown } | null>) {
    if (typeof raw?.task_id !== 'string' || raw.task_id.length === 0)
      return 'a task has no task_id';
    if (!isStringList(raw.claims)) return `task ${raw.task_id} has no claims list`;
    const id = epicOfTaskId(raw.task_id) === null ? qualifyTaskId(epic, raw.task_id) : raw.task_id;
    tasks.push({ taskId: id, claims: [...raw.claims] });
  }
  const rank =
    typeof plan.version === 'number' && Number.isFinite(plan.version) ? plan.version : fileRank;
  return { project: plan.project, rank, tasks };
}

function planFiles(epicDir: string): Array<{ file: string; rank: number }> {
  const found: Array<{ file: string; rank: number }> = [];
  for (const name of readdirSync(epicDir).sort()) {
    if (name === 'plan.json') found.push({ file: name, rank: 0 });
    const versioned = /^plan-v(\d+)\.json$/.exec(name);
    if (versioned) found.push({ file: name, rank: Number(versioned[1]) });
  }
  return found;
}

/** The epic named by an event's own task id or payload, if any. */
function namedEpic(event: StoredEvent): string | null {
  const id = eventTaskId(event.record);
  const fromId = id === null ? null : epicOfTaskId(id);
  if (fromId !== null) return fromId;
  const fromPayload = (event.record.payload as Record<string, unknown> | undefined)?.epic_id;
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : null;
}

/** Every session in `id`'s lineage: its ancestors, itself and its continuations. */
function lineageOf(id: string, parentOf: Map<string, string>): string[] {
  const children = new Map<string, string[]>();
  for (const [child, parent] of parentOf)
    children.set(parent, [...(children.get(parent) ?? []), child]);
  const seen = new Set<string>([id]);
  const queue = [id];
  for (let up = parentOf.get(id); up !== undefined && !seen.has(up); up = parentOf.get(up)) {
    seen.add(up);
  }
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as string) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

function singleOf(set: ReadonlySet<string>): string | null {
  return set.size === 1 ? ([...set][0] as string) : null;
}

export async function gatherLedgerInputs(opts: LedgerInputsOptions): Promise<LedgerInputs> {
  const warnings: LedgerWarning[] = [];

  // Plans: only what the ledger needs; anything else is a named skip.
  const epics: string[] = existsSync(opts.specsDir)
    ? readdirSync(opts.specsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  const projects = new Set<string>();
  const latest = new Map<string, { rank: number; claims: string[] }>();
  let readable = 0;
  for (const epic of epics) {
    const epicDir = path.join(opts.specsDir, epic);
    for (const { file, rank } of planFiles(epicDir)) {
      const filePath = path.join(epicDir, file);
      const plan = parsePlan(readFileSync(filePath, 'utf8'), epic, rank);
      if (typeof plan === 'string') {
        warnings.push({ code: 'checks.plan-skipped', path: filePath, reason: plan });
        continue;
      }
      readable += 1;
      projects.add(plan.project);
      for (const t of plan.tasks) {
        const seen = latest.get(t.taskId);
        if (seen === undefined || plan.rank >= seen.rank)
          latest.set(t.taskId, { rank: plan.rank, claims: t.claims });
      }
    }
  }
  if (readable === 0) {
    throw new LedgerInputsError(
      'checks.no-plans',
      `No readable plan under ${opts.specsDir}; the ledger needs at least one <epic>/plan.json to know the project.`,
      { specs_dir: opts.specsDir },
    );
  }
  if (projects.size > 1) {
    throw new LedgerInputsError(
      'checks.mixed-projects',
      `Plans under ${opts.specsDir} name more than one project: ${[...projects].sort().join(', ')}.`,
      { specs_dir: opts.specsDir, projects: [...projects].sort() },
    );
  }
  const taskClaims = new Map<string, string[]>();
  for (const [id, { claims }] of latest) taskClaims.set(id, claims);

  // Sessions: every log in the state dir; an unreadable one degrades the result.
  const logs: SessionLog[] = [];
  let degraded = false;
  for (const sessionId of listSessionIds(opts.stateDir)) {
    try {
      logs.push({ sessionId, events: await readEvents(sessionId, { stateDir: opts.stateDir }) });
    } catch (err) {
      degraded = true;
      warnings.push({
        code: 'checks.session-unreadable',
        path: path.join(opts.stateDir, `${sessionId}.jsonl`),
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sessionEpics = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>();
  for (const { sessionId, events } of logs) {
    const named = new Set<string>();
    for (const event of events) {
      const epic = namedEpic(event);
      if (epic !== null) named.add(epic);
    }
    sessionEpics.set(sessionId, named);
    const start = events.find((e) => e.record.event_type === 'session-start');
    const parent = start?.record.causal_parent ? tryParseEventId(start.record.causal_parent) : null;
    if (parent !== null && parent.sessionId !== sessionId)
      parentOf.set(sessionId, parent.sessionId);
  }
  const lineageEpics = (sessionId: string): Set<string> => {
    const union = new Set<string>();
    for (const member of lineageOf(sessionId, parentOf)) {
      for (const epic of sessionEpics.get(member) ?? []) union.add(epic);
    }
    return union;
  };

  const wanted = new Set(epics);
  const kept = new Set<string>();
  const taskIdOf = new Map<string, string>();
  for (const { sessionId, events } of logs) {
    const own = sessionEpics.get(sessionId) ?? new Set<string>();
    const lineage = lineageEpics(sessionId);
    const sessionEpic = singleOf(own) ?? singleOf(lineage);
    const touches = [...lineage].some((e) => wanted.has(e));
    for (const event of events) {
      const epic = namedEpic(event) ?? singleOf(own);
      if (!touches && !(epic !== null && wanted.has(epic))) continue;
      kept.add(event.event_id);
      const id = eventTaskId(event.record);
      if (id === null) continue;
      if (epicOfTaskId(id) !== null) taskIdOf.set(event.event_id, id);
      else
        taskIdOf.set(
          event.event_id,
          sessionEpic === null ? UNATTRIBUTED : qualifyTaskId(sessionEpic, id),
        );
    }
  }

  // Follow-ups have no plan record; their claims travel on `task-added`.
  const ordered = mergeSessionLogs(logs).filter((e) => kept.has(e.event_id));
  for (const event of ordered) {
    if (event.record.event_type !== 'task-added') continue;
    const id = taskIdOf.get(event.event_id);
    const claims = (event.record.payload as Record<string, unknown> | undefined)?.claims;
    if (id === undefined || id === UNATTRIBUTED || !isStringList(claims)) continue;
    if (!/\/followup-/.test(id) || latest.has(id)) continue;
    taskClaims.set(id, [...claims]);
  }

  return {
    events: ordered,
    window: { from: new Date(opts.now.getTime() - opts.windowDays * DAY_MS), to: opts.now },
    taskIdOf,
    taskClaims,
    sensitiveGlobs: loadSensitivePathsPolicy(opts.sensitivePathsFile).globs,
    epics,
    project: [...projects][0] as string,
    sessionsRead: logs.length,
    warnings,
    degraded,
  };
}
