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
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { roleOfAgentType } from './agentNames.js';
import {
  SUBAGENT_START_EVENT_TYPE as START,
  SUBAGENT_STOP_EVENT_TYPE as STOP,
} from './agents-registry.js';
import { loadBudgetPolicy, roleCapTokens } from './budgets.js';
import { appendWithin, type EventInput, ROOT_EVENT_TYPE, type StoredEvent } from './events.js';
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
  const home = `prompts-${cli}`;
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
    const main = await findMainLog(eventsDir, cli, floorMs);
    const target = main ?? (existsSync(path.join(eventsDir, `${cli}.jsonl`)) ? cli : home);
    await appendWithin(
      target,
      (existing) => {
        const out: EventInput[] = [];
        if (existing.length === 0) {
          out.push({
            session_id: target,
            actor: 'system',
            event_type: ROOT_EVENT_TYPE,
            plan_version: 1,
            causal_parent: null,
            payload: { kind: 'prompt-log' },
            ...(store?.project === undefined ? {} : { project: store.project }),
          });
        }
        const prompt = [...existing].reverse().find((e) => e.record.event_type === 'user_prompt');
        const parent = prompt ?? existing[0];
        out.push({
          session_id: target,
          actor: 'system',
          event_type: START,
          agent_id: agentId,
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

  // stop: the log that holds this agent's start.
  const candidates = [...new Set([cli, home])];
  const main = await findMainLog(eventsDir, cli, Date.now() - FALLBACK_WINDOW_MS);
  if (main !== null) candidates.unshift(main);
  const transcriptPath = str(input.agent_transcript_path);
  const usage = transcriptPath === undefined ? null : await readTranscriptUsage(transcriptPath);

  let written: StoredEvent | undefined;
  for (const target of candidates) {
    if (!existsSync(path.join(eventsDir, `${target}.jsonl`))) continue;
    const stored = await appendWithin(
      target,
      (existing) => {
        const start = existing.find(
          (e) => e.record.event_type === START && e.record.agent_id === agentId,
        );
        if (start === undefined) return [];
        const done = existing.some(
          (e) => e.record.event_type === STOP && e.record.agent_id === agentId,
        );
        if (done) return [];
        return [
          {
            session_id: target,
            actor: 'system',
            event_type: STOP,
            agent_id: agentId,
            plan_version: start.record.plan_version,
            causal_parent: start.event_id,
            payload: {
              agent_role: role,
              agent_type: agentType,
              model: usage?.model ?? null,
              input_tokens: usage?.inputTokens ?? 0,
              output_tokens: usage?.outputTokens ?? 0,
              cache_creation_tokens: usage?.cacheCreationTokens ?? 0,
              cache_read_tokens: usage?.cacheReadTokens ?? 0,
              total_tokens: usage?.used ?? 0,
              complete: usage?.complete ?? false,
              source: 'hook',
            },
            ...(start.record.project === undefined ? {} : { project: start.record.project }),
          },
        ];
      },
      opts,
    );
    if (stored.length > 0) {
      written = stored[0];
      break;
    }
  }
  if (written === undefined || usage === null) return null;

  const cap = capFor(role, ctx.env);
  if (cap === null || usage.used <= cap) return null;
  return JSON.stringify({
    systemMessage: `Blacksmith: the ${role} subagent used ${fmt(usage.used)} tokens, over its task cap of ${fmt(cap)} (budgets.yml task.${role}). Recorded; nothing was stopped.`,
  });
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
