/**
 * The SubagentStart / SubagentStop hooks (lean mode, scope §4 and §7).
 *
 * Every subagent a session runs, under any `/bs` verb, leaves two events:
 *   - `subagent-started`: role (`agent_type`) and the subagent's own `agent_id`,
 *     parented on the latest captured operator prompt of the log, else its root;
 *   - `subagent-stopped`: role, model, tokens and whether the transcript read
 *     whole, parented on that agent's own start (found by `agent_id`).
 * Both parents are explicit, so neither write depends on "the last event",
 * which is a sibling's under fan-out (architecture §18 rule 8). The fold in
 * agents-registry.ts reads the pair as live, then terminal.
 *
 * Which log: the same rule as prompt capture, with the store from
 * `resolveCaptureStore`. The epic main log the CLI session is driving, if it
 * has one; else the session's own log (`<cli id>`, the one `bs` verbs with the
 * env session default to) when it already exists; else `prompts-<cli id>`.
 * A hook never creates `<cli id>`: a later `bs session start <cli id>` would
 * refuse an open log.
 *
 * A recorder, never a gate: every failure returns null and writes nothing.
 * One exception to "nothing": a stop whose transcript cannot be read still
 * closes its start, with zero tokens and `complete: false`, because a start
 * left live refuses every later defaulted write in the session.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { roleOfAgentType } from './agentNames.js';
import {
  SUBAGENT_START_EVENT_TYPE as START,
  SUBAGENT_STOP_EVENT_TYPE as STOP,
} from './agents-registry.js';
import { loadBudgetPolicy, roleCapTokens } from './budgets.js';
import {
  appendWithin,
  autoRootInput,
  type EventInput,
  listSessionIds,
  readEvents,
  type StoredEvent,
} from './events.js';
import {
  type CaptureContext,
  CLI_ID,
  findMainLog,
  isObj,
  resolveCaptureStore,
  str,
} from './promptCapture.js';
import { readTranscriptUsage } from './transcriptTokens.js';

const FALLBACK_WINDOW_MS = 72 * 3600 * 1000;

export type SubagentMode = 'start' | 'stop';

const roleOf = (agentType: string): string =>
  roleOfAgentType(agentType, { bareAccepted: false }) ?? agentType;

/** Whole-number tokens with thousands separators, the one spelling the warning uses. */
const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * Record one hook payload. Returns the hook's stdout (a `systemMessage` JSON
 * line, only for a stop that crossed its role's cap) or null. Never throws.
 */
export async function recordSubagent(
  raw: string,
  mode: SubagentMode,
  ctx: CaptureContext,
): Promise<string | null> {
  try {
    return await record(raw, mode, ctx);
  } catch (err) {
    process.stderr.write(`bs subagent ${mode}: ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

async function record(
  raw: string,
  mode: SubagentMode,
  ctx: CaptureContext,
): Promise<string | null> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(input)) return null;
  const cli = str(input.session_id);
  const agentId = str(input.agent_id);
  const agentType = str(input.agent_type);
  if (cli === undefined || !CLI_ID.test(cli)) return null;
  if (agentId === undefined || agentId === '' || agentType === undefined || agentType === '') {
    return null;
  }
  const cwd = str(input.cwd) ?? ctx.cwd;

  let store = resolveCaptureStore({ ...ctx, cwd });
  if (store === null) {
    // Rule M3 needs a `/bs` command, which a subagent hook cannot see. The
    // session's prompt-capture log is the same evidence that `/bs` ran here.
    const m3 = resolveCaptureStore({ ...ctx, cwd, command: 'bs' });
    if (m3 !== null && existsSync(path.join(m3.eventsDir, `prompts-${cli}.jsonl`))) store = m3;
  }
  if (store === null) return null;
  const eventsDir = store.eventsDir;
  const opts = { stateDir: eventsDir, cliSessionId: cli };
  const role = roleOf(agentType);

  if (mode === 'start') {
    let floorMs = Date.now() - FALLBACK_WINDOW_MS;
    if (typeof input.transcript_path === 'string') {
      try {
        floorMs = statSync(input.transcript_path).birthtimeMs;
      } catch {
        // Keep the 72 h fallback.
      }
    }
    // The epic main log the session drives, else the session's own log, which
    // this creates with the auto-root #533 writes: the #533 guard reads
    // `<cli id>.jsonl`, so an agent recorded anywhere else would never refuse
    // a defaulted write while it is live.
    const target = (await findMainLog(eventsDir, cli, floorMs)) ?? cli;
    await appendWithin(
      target,
      (existing) => {
        const out: EventInput[] = [];
        if (existing.length === 0) out.push(autoRootInput(target));
        const prompt = [...existing].reverse().find((e) => e.record.event_type === 'user_prompt');
        const parent = prompt ?? existing[0];
        out.push({
          session_id: target,
          actor: 'system',
          event_type: START,
          agent_id: normalizeAgentId(agentId),
          plan_version: parent?.record.plan_version ?? 1,
          causal_parent: parent?.event_id ?? `${target}#0`,
          payload: { agent_role: role, agent_type: agentType, source: 'hook' },
          ...(parent?.record.project === undefined ? {} : { project: parent.record.project }),
        });
        return out;
      },
      opts,
    );
    return null;
  }

  // stop. The ids this agent can go by: the hook's own, and the one its
  // transcript file name carries (`agent-<id>.jsonl`).
  const transcriptPath = str(input.agent_transcript_path);
  const ids = new Set([normalizeAgentId(agentId)]);
  if (transcriptPath !== undefined) {
    const m = /^agent-(.+)\.jsonl$/.exec(path.basename(transcriptPath));
    if (m?.[1] !== undefined) ids.add(m[1]);
  }
  const usage = transcriptPath === undefined ? null : await readTranscriptUsage(transcriptPath);
  // A stop always writes. The hooks are async, so it can run before its own
  // start has landed: it goes where that start is, else where a start would,
  // and the fold pairs the two by agent id and occurrence in either order.
  const target =
    (await logHoldingAgent(eventsDir, cli, ids)) ??
    (await findMainLog(eventsDir, cli, Date.now() - FALLBACK_WINDOW_MS)) ??
    cli;

  const stored = await appendWithin(
    target,
    (existing) => {
      const out: EventInput[] = [];
      if (existing.length === 0) out.push(autoRootInput(target));
      const pending = pendingStart(existing, ids);
      const aid = pending?.aid ?? normalizeAgentId(agentId);
      const prior = existing
        .filter((e) => e.record.event_type === STOP && e.record.agent_id === aid)
        .at(-1);
      const before = cumulativeOf(prior);
      const now: Cumulative = {
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cache_creation: usage?.cacheCreationTokens ?? 0,
        cache_read: usage?.cacheReadTokens ?? 0,
        total: usage?.used ?? 0,
      };
      // A second firing of the same stop: every start has its stop and the
      // transcript has not moved since the previous one.
      if (pending === null && prior !== undefined && before.total === now.total) return [];
      const delta = (k: keyof Cumulative): number => Math.max(0, now[k] - before[k]);
      const prompt = [...existing].reverse().find((e) => e.record.event_type === 'user_prompt');
      const parent = pending?.start ?? prompt ?? existing[0];
      out.push({
        session_id: target,
        actor: 'system',
        event_type: STOP,
        agent_id: aid,
        plan_version: parent?.record.plan_version ?? 1,
        causal_parent: parent?.event_id ?? `${target}#0`,
        payload: {
          agent_role: role,
          agent_type: agentType,
          model: usage?.model ?? null,
          // This run only: one transcript spans every run of a resumed agent.
          input_tokens: delta('input'),
          output_tokens: delta('output'),
          cache_creation_tokens: delta('cache_creation'),
          cache_read_tokens: delta('cache_read'),
          total_tokens: delta('total'),
          // The transcript so far, kept apart so the next stop can subtract it.
          cumulative_tokens: now.total,
          cumulative: now,
          last_turn_tokens: usage?.lastTurnTokens ?? 0,
          complete: usage?.complete ?? false,
          source: 'hook',
        },
        ...(parent?.record.project === undefined ? {} : { project: parent.record.project }),
      });
      return out;
    },
    opts,
  );
  if (stored.every((e) => e.record.event_type !== STOP) || usage === null) return null;

  // budgets.yml's task caps are p90s of the Agent tool's reported total, which
  // is the final turn's size, so that is what they are compared with. The
  // summed spend is recorded too and is what spend by role adds up.
  const cap = capFor(role, ctx.env);
  if (cap === null || usage.lastTurnTokens <= cap) return null;
  return JSON.stringify({
    systemMessage: `Blacksmith: the ${role} subagent's last turn was ${fmt(usage.lastTurnTokens)} tokens (${fmt(usage.used)} summed over its run), over its task cap of ${fmt(cap)} (budgets.yml task.${role}). Recorded; nothing was stopped.`,
  });
}

type Cumulative = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  total: number;
};

/** What the transcript held at a previous stop; zero for none. */
function cumulativeOf(stop: StoredEvent | undefined): Cumulative {
  const zero: Cumulative = { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 };
  const c = stop?.record.payload.cumulative;
  if (!isObj(c)) return zero;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(c.input),
    output: n(c.output),
    cache_creation: n(c.cache_creation),
    cache_read: n(c.cache_read),
    total: n(c.total),
  };
}

/**
 * The start the next stop closes: the k-th stop of an agent id closes its k-th
 * start, so that is `starts[stops.length]`; the latest such across the ids.
 */
function pendingStart(
  existing: readonly StoredEvent[],
  ids: ReadonlySet<string>,
): { aid: string; start: StoredEvent } | null {
  let best: { aid: string; start: StoredEvent; at: number } | null = null;
  for (const aid of ids) {
    const starts = existing.filter(
      (e) => e.record.event_type === START && e.record.agent_id === aid,
    );
    const stops = existing.filter((e) => e.record.event_type === STOP && e.record.agent_id === aid);
    const start = starts[stops.length];
    if (start === undefined) continue;
    const at = existing.indexOf(start);
    if (best === null || at > best.at) best = { aid, start, at };
  }
  return best === null ? null : { aid: best.aid, start: best.start };
}

/** `agent-abc123` and `abc123` are one agent: the docs show both spellings. */
export function normalizeAgentId(id: string): string {
  return id.startsWith('agent-') && id.length > 'agent-'.length ? id.slice('agent-'.length) : id;
}

/**
 * The log that holds this agent: the one with a start still waiting for its
 * stop (the latest such, across every recent log), else any log that has the
 * agent's events at all (so a repeated stop finds its previous one).
 */
async function logHoldingAgent(
  eventsDir: string,
  cli: string,
  ids: ReadonlySet<string>,
): Promise<string | null> {
  const floor = Date.now() - FALLBACK_WINDOW_MS;
  const mentions = (id: string): boolean => {
    try {
      const text = readFileSync(path.join(eventsDir, `${id}.jsonl`), 'utf8');
      return [...ids].some((i) => text.includes(`"agent_id":${JSON.stringify(i)}`));
    } catch {
      return false;
    }
  };
  const logs = [cli, `prompts-${cli}`];
  for (const id of listSessionIds(eventsDir)) {
    if (logs.includes(id)) continue;
    try {
      if (statSync(path.join(eventsDir, `${id}.jsonl`)).mtimeMs >= floor) logs.push(id);
    } catch {
      // Unreadable: not a candidate.
    }
  }
  let waiting: { id: string; ts: string } | null = null;
  let seen: string | null = null;
  for (const id of logs.filter(mentions)) {
    seen ??= id;
    const pending = pendingStart(await readEvents(id, { stateDir: eventsDir }), ids);
    if (pending !== null && (waiting === null || pending.start.record.ts >= waiting.ts)) {
      waiting = { id, ts: pending.start.record.ts };
    }
  }
  return waiting?.id ?? seen;
}

function capFor(role: string, env: CaptureContext['env']): number | null {
  try {
    return roleCapTokens(loadBudgetPolicy(undefined, env), role);
  } catch {
    return null;
  }
}

export interface RoleSpend {
  role: string;
  agents: number;
  total_tokens: number;
  models: string[];
  /** The role's per-dispatch cap in budgets.yml; null for a role it does not price. */
  cap_tokens: number | null;
}

export interface SpendByRole {
  roles: RoleSpend[];
  total_tokens: number;
  /** Starts with no stop yet: their spend is not in the total. */
  still_running: number;
}

/**
 * Spend by role over a log, from the `subagent-stopped` events. A role is the
 * agent's role where it is a `bs-*` agent and its own type otherwise, so the
 * total covers everything the session ran.
 */
export function spendByRole(events: readonly StoredEvent[]): SpendByRole {
  const byRole = new Map<string, RoleSpend>();
  let started = 0;
  let stopped = 0;
  for (const { record } of events) {
    if (record.event_type === START) started += 1;
    if (record.event_type !== STOP) continue;
    stopped += 1;
    const p = record.payload;
    const role = str(p.agent_role) ?? 'unknown';
    let row = byRole.get(role);
    if (row === undefined) {
      row = { role, agents: 0, total_tokens: 0, models: [], cap_tokens: capFor(role, process.env) };
      byRole.set(role, row);
    }
    row.agents += 1;
    row.total_tokens += typeof p.total_tokens === 'number' ? p.total_tokens : 0;
    const model = str(p.model);
    if (model !== undefined && !row.models.includes(model)) row.models.push(model);
  }
  const roles = [...byRole.values()].sort(
    (a, b) => b.total_tokens - a.total_tokens || a.role.localeCompare(b.role),
  );
  return {
    roles,
    total_tokens: roles.reduce((n, r) => n + r.total_tokens, 0),
    still_running: Math.max(0, started - stopped),
  };
}
