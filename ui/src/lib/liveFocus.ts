// What the operator's live CLI sessions are doing on the board: which cards a
// session works on now ("Now · Builder") and which one it picks up next
// ("Next"). Pure reads over `GET /api/cli-sessions`; the Kanban page and
// card lay the result out. Everything is keyed by store + task id, since a
// task id can repeat between two stores.
import { isDoneStatus } from './kanban.js';
import type { LiveCard, LiveLinkedEpic } from './liveSessions.js';
import { roleLabel } from './roleLabels.js';
import { HOME_STORE_ID, type StoreRef } from './storeKey.js';

type Keyed = { store?: StoreRef; taskId: string };
type MarkTask = Keyed & { taskStatus: string; agentActivity?: 'working' | 'stalled' | null };

export type TaskMark = { kind: 'now'; roles: string[] } | { kind: 'next' };

export interface LiveMarks {
  /** Roles working on a card, by `taskMarkKey`. */
  now: Map<string, string[]>;
  /** Cards a session picks up next, by `taskMarkKey`. */
  next: Set<string>;
  /** "<project> · <epic>" of each epic waiting on the operator. */
  waiting: string[];
}

/** The key a card and a session's task id meet on: store id + task id. */
export function taskMarkKey(row: Keyed): string {
  return `${row.store?.id ?? HOME_STORE_ID}:${row.taskId}`;
}

// A session may write a bare task id; the card's id is always `<epic>/<slug>`.
const qualified = (epicId: string, taskId: string): string =>
  taskId.includes('/') ? taskId : `${epicId}/${taskId}`;

function liveEpics(sessions: readonly LiveCard[]): LiveLinkedEpic[] {
  return sessions.flatMap((s) => (s.linked?.epics ?? []).filter((e) => !e.closed && e.epicId));
}

/** Card key -> the roles of the live agents a session has on it. A null task id marks nothing. */
export function matchNow(sessions: readonly LiveCard[]): Map<string, string[]> {
  const now = new Map<string, string[]>();
  for (const e of liveEpics(sessions)) {
    for (const a of e.workingAgents) {
      if (a.taskId === null || e.epicId === null) continue;
      const key = taskMarkKey({ store: e.store, taskId: qualified(e.epicId, a.taskId) });
      const roles = now.get(key) ?? [];
      if (!roles.includes(a.role)) roles.push(a.role);
      now.set(key, roles);
    }
  }
  return now;
}

/** "Now · Builder", "Now · Builder + Tester", "Now · Builder +2", with " · stalled" from the card. */
export function nowText(roles: readonly string[], activity: 'working' | 'stalled' | null): string {
  const [first, second, ...rest] = roles;
  let text = `Now · ${roleLabel(first ?? '')}`;
  if (second !== undefined) {
    text += rest.length === 0 ? ` + ${roleLabel(second)}` : ` +${roles.length - 1}`;
  }
  return activity === 'stalled' ? `${text} · stalled` : text;
}

/**
 * The cards sessions pick up next, and the epics that wait on the operator.
 * The focus epic (the newest one) takes its answer from `focus.next`; the
 * other live epics from `focusParts.nextTask`, and they never say "waiting".
 */
export function nextMark(sessions: readonly LiveCard[]): {
  tasks: Set<string>;
  waiting: string[];
} {
  const tasks = new Set<string>();
  const waiting = new Set<string>();
  for (const s of sessions) {
    const f = s.focus;
    if (f?.next?.kind === 'task') tasks.add(taskMarkKey({ store: f.store, taskId: f.next.taskId }));
    if (f?.next?.kind === 'waiting_on_you') {
      waiting.add(f.project ? `${f.project} · ${f.epicId}` : f.epicId);
    }
    for (const e of s.linked?.epics ?? []) {
      if (e.closed || e.epicId === null) continue;
      if (f && f.store.id === e.store.id && f.epicId === e.epicId) continue;
      const t = e.focusParts.nextTask;
      if (t) tasks.add(taskMarkKey({ store: e.store, taskId: qualified(e.epicId, t.taskId) }));
    }
  }
  return { tasks, waiting: [...waiting] };
}

export function liveMarks(sessions: readonly LiveCard[]): LiveMarks {
  const next = nextMark(sessions);
  return { now: matchNow(sessions), next: next.tasks, waiting: next.waiting };
}

/** A card's mark: Now when a session works on it (it wins over Next), else Next, else none. */
export function markFor(marks: LiveMarks | null, task: Keyed): TaskMark | null {
  if (!marks) return null;
  const key = taskMarkKey(task);
  const roles = marks.now.get(key);
  if (roles) return { kind: 'now', roles };
  return marks.next.has(key) ? { kind: 'next' } : null;
}

/**
 * Stable partition of one column: Now cards, then Next, then the rest in
 * their order. Finished tasks stay put. Runs before the column is capped, so
 * "show more" never hides a marker.
 */
export function orderLive<T extends MarkTask>(tasks: T[], marks: LiveMarks | null): T[] {
  if (!marks) return tasks;
  const rank = (t: T): number => {
    if (isDoneStatus(t.taskStatus)) return 2;
    const kind = markFor(marks, t)?.kind;
    return kind === 'now' ? 0 : kind === 'next' ? 1 : 2;
  };
  return tasks
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
}

/**
 * What a poll leaves behind: a good read replaces the sessions; a failed one
 * keeps the last good sessions for one cycle, then drops them to unknown
 * (null) rather than leave stale marks on the board.
 */
export function afterRead(
  prev: LiveCard[] | null,
  misses: number,
  read: LiveCard[] | 'failed',
): { sessions: LiveCard[] | null; misses: number } {
  if (read !== 'failed') return { sessions: read, misses: 0 };
  return { sessions: misses === 0 ? prev : null, misses: misses + 1 };
}
