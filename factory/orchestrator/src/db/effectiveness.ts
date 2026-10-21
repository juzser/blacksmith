// Effectiveness fold: tokens per task and role, escaped defects, finding
// precision. A fold over events the caller already holds plus an injected
// transcript reader; it writes nothing and finds no files of its own.
//
// Every number carries the ids it came from, so an export can show evidence
// without re-reading the log. Finding status is never re-derived: it comes
// from `foldFindings`.
import { readTokenUsage } from '../budgetAlarm.js';
import { eventTaskId, type StoredEvent } from '../events.js';
import { foldFindings } from '../findings.js';
import { taskIdsMatch } from '../taskId.js';
import type { SessionTokens } from '../transcriptTokens.js';

export type ReadTokens = (cliSessionId: string) => Promise<SessionTokens>;

export interface TokenTotal {
  used: number;
  /** False when any partial transcript fed this total: `used` is then a floor. */
  complete: boolean;
  agentIds: string[];
}

export interface EscapedItem {
  kind: 'finding' | 'issue';
  /** `counted` for a confirmed or fix-* finding (or an opened issue); `pending` while still raised. */
  state: 'counted' | 'pending';
  taskId: string;
  eventId: string;
  findingId?: string;
  status?: string;
  mergeEventId: string;
  gateEventId: string;
}

export interface Precision {
  /** confirmed / (confirmed + refuted + waived); null when nothing was decided. */
  value: number | null;
  confirmed: number;
  refuted: number;
  waived: number;
  ids: { confirmed: string[]; refuted: string[]; waived: string[] };
}

export interface Effectiveness {
  tokens: {
    byTask: Record<string, TokenTotal>;
    byRole: Record<string, TokenTotal>;
    unattributed: TokenTotal & { sessionIds: string[] };
    complete: boolean;
    resultsMeasured: number;
    resultsUnmeasured: number;
    resultEventIds: { measured: string[]; unmeasured: string[] };
  };
  escapedDefects: {
    count: number;
    pending: number;
    items: EscapedItem[];
    /** Refuted findings that matched the escape window, kept out of the count. */
    excluded: string[];
  };
  precision: Record<string, Precision>;
}

const PASSING = new Set(['pass', 'pass-with-waivers-pending']);
const CONFIRMED_LIKE = (s: string): boolean => s === 'confirmed' || s.startsWith('fix-');

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Event-supplied ids key plain objects, so read with `hasOwn` and write with
// `defineProperty`: `map['__proto__']` would reach `Object.prototype`.
function slot<T>(map: Record<string, T>, key: string, make: () => T): T {
  if (Object.hasOwn(map, key)) return map[key] as T;
  const v = make();
  Object.defineProperty(map, key, {
    value: v,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return v;
}

function bucket(map: Record<string, TokenTotal>, key: string): TokenTotal {
  return slot(map, key, () => ({ used: 0, complete: true, agentIds: [] }));
}

async function foldTokens(
  events: readonly StoredEvent[],
  readTokens: ReadTokens,
): Promise<Effectiveness['tokens']> {
  const owner = new Map<string, { task: string | null; role: string | null }>();
  const sessions: string[] = [];
  for (const { record } of events) {
    if (record.cli_session_id && !sessions.includes(record.cli_session_id)) {
      sessions.push(record.cli_session_id);
    }
    if (record.event_type !== 'dispatch_decision' || !record.agent_id) continue;
    if (owner.has(record.agent_id)) continue;
    owner.set(record.agent_id, {
      task: eventTaskId(record),
      role: str((record.payload as Record<string, unknown>).agent_role),
    });
  }

  const byTask: Record<string, TokenTotal> = {};
  const byRole: Record<string, TokenTotal> = {};
  const unattributed = {
    used: 0,
    complete: true,
    agentIds: [] as string[],
    sessionIds: [] as string[],
  };
  for (const cli of sessions) {
    const s = await readTokens(cli);
    let subTotal = 0;
    for (const a of s.subagents) {
      subTotal += a.used;
      const who = owner.get(a.agentId);
      const targets: TokenTotal[] = [];
      if (who?.task) targets.push(bucket(byTask, who.task));
      if (who?.role) targets.push(bucket(byRole, who.role));
      if (targets.length === 0) targets.push(unattributed);
      for (const t of targets) {
        t.used += a.used;
        t.agentIds.push(a.agentId);
        if (!a.complete) t.complete = false;
      }
    }
    // Whatever the session spent beyond its sub-agents is the main thread,
    // which no dispatch names: it is reported, never spread over tasks.
    unattributed.used += Math.max(0, s.used - subTotal);
    unattributed.sessionIds.push(cli);
    if (!s.complete) unattributed.complete = false;
  }

  const resultEventIds = { measured: [] as string[], unmeasured: [] as string[] };
  for (const { event_id, record } of events) {
    if (record.event_type !== 'task-result-recorded') continue;
    const read = readTokenUsage((record.payload as Record<string, unknown>).token_usage);
    (read.measured ? resultEventIds.measured : resultEventIds.unmeasured).push(event_id);
  }
  const totals = [...Object.values(byTask), ...Object.values(byRole), unattributed];
  return {
    byTask,
    byRole,
    unattributed,
    complete: totals.every((t) => t.complete),
    resultsMeasured: resultEventIds.measured.length,
    resultsUnmeasured: resultEventIds.unmeasured.length,
    resultEventIds,
  };
}

interface Merge {
  taskId: string;
  index: number;
  eventId: string;
}

function foldEscaped(
  events: readonly StoredEvent[],
  statusOf: Map<string, string>,
): Effectiveness['escapedDefects'] {
  const merges: Merge[] = [];
  events.forEach(({ event_id, record }, index) => {
    if (record.event_type !== 'wave-merged') return;
    const ids = (record.payload as { task_ids?: unknown }).task_ids;
    const named = new Set<string>(
      Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string' && i !== '') : [],
    );
    const own = eventTaskId(record);
    if (own !== null) named.add(own);
    for (const taskId of named) merges.push({ taskId, index, eventId: event_id });
  });

  // The merge a later event is "after", and the passing gate behind it.
  const windowFor = (taskId: string, at: number) => {
    const merge = merges.find((m) => taskIdsMatch(m.taskId, taskId));
    if (merge === undefined || at <= merge.index) return null;
    let gateId: string | null = null;
    let outcome: string | null = null;
    for (let i = 0; i < merge.index; i++) {
      const e = events[i];
      if (e === undefined || e.record.event_type !== 'gate-outcome') continue;
      const t = eventTaskId(e.record);
      if (t === null || !taskIdsMatch(t, merge.taskId)) continue;
      gateId = e.event_id;
      outcome = str((e.record.payload as Record<string, unknown>).outcome);
    }
    return outcome !== null && PASSING.has(outcome) && gateId !== null
      ? { merge: merge.eventId, gate: gateId }
      : null;
  };

  const items: EscapedItem[] = [];
  const excluded: string[] = [];
  const seen = new Set<string>();
  events.forEach(({ event_id, record }, index) => {
    const payload = record.payload as Record<string, unknown>;
    if (record.event_type === 'finding-raised') {
      const findingId = str(payload.finding_id);
      const taskId = eventTaskId(record);
      if (findingId === null || taskId === null || seen.has(findingId)) return;
      seen.add(findingId);
      const w = windowFor(taskId, index);
      if (w === null) return;
      const status = statusOf.get(findingId) ?? str(payload.finding_status) ?? 'raised';
      const base = { kind: 'finding' as const, taskId, eventId: event_id, findingId, status };
      if (CONFIRMED_LIKE(status)) {
        items.push({ ...base, state: 'counted', mergeEventId: w.merge, gateEventId: w.gate });
      } else if (status === 'raised') {
        items.push({ ...base, state: 'pending', mergeEventId: w.merge, gateEventId: w.gate });
      } else if (status === 'refuted') {
        excluded.push(findingId);
      }
    } else if (record.event_type === 'issue-reported') {
      const taskId = eventTaskId(record) ?? str(payload.task_ref);
      const outcome = str(payload.outcome);
      if (taskId === null || (outcome !== 'opened' && outcome !== 'commented')) return;
      const w = windowFor(taskId, index);
      if (w === null) return;
      items.push({
        kind: 'issue',
        state: 'counted',
        taskId,
        eventId: event_id,
        mergeEventId: w.merge,
        gateEventId: w.gate,
      });
    }
  });
  return {
    count: items.filter((i) => i.state === 'counted').length,
    pending: items.filter((i) => i.state === 'pending').length,
    items,
    excluded,
  };
}

function foldPrecision(findings: ReturnType<typeof foldFindings>): Record<string, Precision> {
  const out: Record<string, Precision> = {};
  for (const f of findings) {
    const role = f.found_by;
    if (typeof role !== 'string' || role === '') continue;
    const p = slot(out, role, () => ({
      value: null,
      confirmed: 0,
      refuted: 0,
      waived: 0,
      ids: { confirmed: [], refuted: [], waived: [] },
    }));
    const s = f.finding_status;
    const key = CONFIRMED_LIKE(s) ? 'confirmed' : s === 'refuted' || s === 'waived' ? s : null;
    if (key === null) continue;
    p[key] += 1;
    p.ids[key].push(f.finding_id);
  }
  for (const p of Object.values(out)) {
    const decided = p.confirmed + p.refuted + p.waived;
    p.value = decided === 0 ? null : p.confirmed / decided;
  }
  return out;
}

export async function effectiveness(
  events: readonly StoredEvent[],
  opts: { readTokens: ReadTokens },
): Promise<Effectiveness> {
  const findings = foldFindings([...events]);
  const statusOf = new Map(findings.map((f) => [f.finding_id, f.finding_status]));
  return {
    tokens: await foldTokens(events, opts.readTokens),
    escapedDefects: foldEscaped(events, statusOf),
    precision: foldPrecision(findings),
  };
}
