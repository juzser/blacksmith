import { eventTaskId, type StoredEvent } from './events.js';
import { epicOfTaskId } from './taskId.js';

/**
 * Live agent registry (architecture §7 "active agent count by role/model/
 * provider"). An agent is live between its `dispatch_decision` event and
 * whichever terminal event closes it: `task-result-recorded` (a worker's
 * schema-valid Result landed — Phase 5 addition, see db/projector.ts header
 * comment) or `error-logged` referencing the same task (an agent ref, per
 * the task's terminal-event options).
 *
 * D-23/P9-12 — the correlation key is `(task_id, agent_role)`, not `task_id`
 * alone. The old note here claimed "a real dispatcher never runs two agents
 * on one task_id concurrently"; `/bs run` does exactly that, deliberately,
 * up to four times per task (coder, grader, reviewer, security-reviewer).
 * Under the old key each dispatch superseded the previous one, so in wave 3
 * three agents that finished were recorded as abandoned and the fourth
 * stayed `live` forever. `agent_id` is still only a label — the role is what
 * the events already carry, so nothing new has to be threaded through.
 *
 * `round` rides along on the record because a judge redispatch is a genuine
 * second round and the UI should be able to say which one it is looking at.
 * It is deliberately NOT part of the key: a round-2 dispatch arriving while
 * round 1 is still open means round 1 was given up on, and keying on the
 * round would leave it live forever — the same bug, one level down.
 *
 * A second `dispatch_decision` for the same `(task_id, agent_role)` whose
 * prior dispatch is STILL open (no terminal event yet — the escalation ladder
 * redispatching without the first attempt reporting back) closes the old
 * entry as `superseded` rather than leaving it orphaned at `live`: one role
 * does not run twice on one task at once, so an open-on-redispatch entry is
 * stale bookkeeping, not a genuinely live agent — counting it would corrupt
 * the Overview live-agent count and detectStale().
 *
 * Terminal events name a role where they can: `task-result-recorded` carries
 * the Result's `agent`, `judge-reported` carries `agent_role`, `judge-verdict`
 * carries `agent` (D-160). One that names no role is a statement about the
 * whole task — the queue blocking it, the gate refusing it — and closes every
 * entry still open under that task, because after a task-level failure nobody
 * is still running.
 *
 * Above all of those sits `epic-closed` (D-187). Every close named so far
 * needs a task id to speak through, so an agent whose task simply never
 * reported — and an epic-level dispatch, which has no task id to speak
 * through at all — stayed `live` past the verdict, past the end of the run,
 * forever. The epic's own terminal event is the only thing that can say
 * otherwise, and it closes what is still open under that epic in that session
 * as `abandoned`: not superseded (nothing replaced them) and not an error
 * (they were never judged), just outrun by the run they belonged to.
 */

export const DISPATCH_EVENT_TYPE = 'dispatch_decision';
/** Phase 5 addition (deviation, noted in the final report): the terminal counterpart to dispatch_decision. */
export const TASK_RESULT_EVENT_TYPE = 'task-result-recorded';
/**
 * P9-11's judge half. A judge's return is its artifact, not a Result: it has
 * no `token_usage`, and minting a zeroed one purely to reuse
 * `task-result-recorded` would put fabricated numbers into the very rows
 * budget accounting sums. So the registry learns a second terminal event
 * rather than the event learning to lie.
 */
export const JUDGE_REPORT_EVENT_TYPE = 'judge-reported';
/**
 * The cross-provider judge's return (D-160). `recordJudgeRun` writes a real
 * `dispatch_decision` for every external judge, deliberately, so the run shows
 * up in the same registry and timeline as any other agent (architecture §7) —
 * but an external judge never writes a Result and never closes a judge turn,
 * so neither terminal event above could ever speak for it. Its terminal fact
 * is the `judge-verdict` chained off its own dispatch, and until this was
 * read, an API call that came back in eight seconds stayed `live` until the
 * end of the session and turned up in `detectStale` hours later.
 *
 * The role is under `agent`, not `agent_role` — the key `recordJudgeRun`
 * writes (quorum.ts) — which is why this close is spelled out rather than
 * folded in with judge-reported.
 */
export const JUDGE_VERDICT_EVENT_TYPE = 'judge-verdict';
export const ERROR_EVENT_TYPE = 'error-logged';
/**
 * The epic's own terminal fact (D-187). Every close above speaks for a single
 * task, so an agent whose task never reported — and an epic-level dispatch,
 * whose `task_id` is absent by design (event.schema.json: "absent for
 * session-level or epic-level events") and which therefore has no task any
 * close could name — stayed `live` for good. `epic-closed` is the one event
 * that says the run those agents belong to is over: whatever was still open
 * under that epic was abandoned when the verdict landed, not left running.
 */
export const EPIC_CLOSED_EVENT_TYPE = 'epic-closed';

/**
 * Every event type `foldAgents` acts on — the dispatch that opens an entry and
 * every terminal that closes one. Exported for callers that slice the event
 * log before folding it (D-161): a slice narrower than this list feeds the
 * fold a history in which agents are dispatched and never finish, and the
 * result is not a smaller answer but a wrong one. Anything that reuses the
 * fold has to reuse its alphabet too.
 */
export const REGISTRY_EVENT_TYPES = [
  DISPATCH_EVENT_TYPE,
  TASK_RESULT_EVENT_TYPE,
  JUDGE_REPORT_EVENT_TYPE,
  JUDGE_VERDICT_EVENT_TYPE,
  ERROR_EVENT_TYPE,
  EPIC_CLOSED_EVENT_TYPE,
] as const;

export type AgentStatus = 'live' | 'done' | 'error' | 'superseded' | 'abandoned';
export type TerminalType = 'result' | 'error' | 'superseded' | 'abandoned';

/** Runtime mirror of `AgentStatus` (a type-only union has nothing to iterate
 * at runtime) — lets ui/test/taxonomy.test.ts assert its status->tone map
 * covers this list exactly, same drift-guard pattern as roadmap.ts's
 * MILESTONE_STATUSES. */
export const AGENT_STATUSES: readonly AgentStatus[] = [
  'live',
  'done',
  'error',
  'superseded',
  'abandoned',
];

export interface AgentRecord {
  /** The dispatch event's id — stable identity for this live-agent instance. */
  id: string;
  sessionId: string;
  taskId: string | null;
  /**
   * The epic this agent was dispatched for, or null when nothing in the log
   * places it in one (D-234).
   *
   * Half of the dispatches in a real run name an epic and no task: a planner,
   * a spec-reviewer, a scribe and the epic-close judges all work on the epic
   * itself. Without this field their scope was simply lost -- every consumer
   * could only read `taskId: null` and render "no task assigned", and
   * db/queries.ts could only drop them from a project's totals.
   */
  epicId: string | null;
  agentId: string | null;
  agentRole: string;
  /** Dispatch round; 1 for a worker whose dispatch declares none. */
  round: number;
  provider: string;
  modelTier: string;
  dispatchedAt: string;
  terminalEventId: string | null;
  terminalAt: string | null;
  terminalType: TerminalType | null;
  status: AgentStatus;
}

interface DispatchPayload {
  agent_role?: string;
  /** Set by an epic-level dispatch, which has no task to be qualified by. */
  epic_id?: string;
  /** Written here by a hand-authored dispatch; see eventTaskId (D-245). */
  task_id?: string;
  provider?: string;
  model_tier?: string;
  round?: number;
  spec_ref?: string;
  reason?: string;
  parent_prompt_id?: string;
}

const STATUS_FOR_TERMINAL: Record<TerminalType, AgentStatus> = {
  result: 'done',
  error: 'error',
  superseded: 'superseded',
  abandoned: 'abandoned',
};

/** The open-entry key — the correlation pair, `(task_id, agent_role)`. */
function openKey(taskId: string, role: string): string {
  return `${taskId}\u0000${role}`;
}

function closeEntry(
  open: AgentRecord,
  eventId: string,
  ts: string,
  terminalType: TerminalType,
): void {
  open.terminalEventId = eventId;
  open.terminalAt = ts;
  open.terminalType = terminalType;
  open.status = STATUS_FOR_TERMINAL[terminalType];
}

/**
 * Close what this terminal event actually speaks for: one role when it names
 * one, every open entry under the task when it does not.
 */
function closeOpen(
  open: Map<string, AgentRecord>,
  taskId: string,
  role: string | null,
  eventId: string,
  ts: string,
  terminalType: TerminalType,
): void {
  if (role) {
    const entry = open.get(openKey(taskId, role));
    if (!entry) return;
    closeEntry(entry, eventId, ts, terminalType);
    open.delete(openKey(taskId, role));
    return;
  }
  for (const [key, entry] of open) {
    if (entry.taskId !== taskId) continue;
    closeEntry(entry, eventId, ts, terminalType);
    open.delete(key);
  }
}

/**
 * Fold a session's full event history into agent registry rows. Pure
 * function over the event list — used identically by db/projector.ts's
 * full rebuild and incremental apply paths (no separate incremental state
 * machine to drift from this one).
 */
export function foldAgents(events: readonly StoredEvent[]): AgentRecord[] {
  const open = new Map<string, AgentRecord>();
  // Dispatches with no task id have no correlation key, so they cannot live in
  // `open` — but they are still open, and `epic-closed` still speaks for them.
  let openEpicLevel: AgentRecord[] = [];
  const records: AgentRecord[] = [];

  for (const { event_id, record } of events) {
    if (record.event_type === DISPATCH_EVENT_TYPE) {
      const payload = record.payload as DispatchPayload;
      if (!payload.agent_role || !payload.provider || !payload.model_tier) continue;

      // Both levels, because a hand-written dispatch names its task in the
      // payload and leaves the envelope null (D-245) — and D-244's rule that
      // `task_id: ""` names no task now holds at either level. Read one level,
      // or read `''` as an id, and the agent is filed as epic-level while
      // every task-scoped terminal branch below stays guarded on the task id:
      // nothing can ever close it. taskId.ts draws the same line for `''`.
      const taskId = eventTaskId(record);

      // A still-open dispatch for the same (task, role) is superseded, not
      // left live forever — see the "second dispatch_decision" note above.
      // Different roles on one task run side by side and are left alone.
      if (taskId) {
        closeOpen(open, taskId, payload.agent_role, event_id, record.ts, 'superseded');
      }

      const agent: AgentRecord = {
        id: event_id,
        sessionId: record.session_id,
        taskId,
        // The payload's own claim first; otherwise the task id spells it. A
        // bare task id (D-130) places nothing, and guessing is what the id
        // rules exist to prevent, so it stays null.
        epicId: payload.epic_id ?? (taskId ? epicOfTaskId(taskId) : null),
        agentId: record.agent_id ?? null,
        agentRole: payload.agent_role,
        round: typeof payload.round === 'number' ? payload.round : 1,
        provider: payload.provider,
        modelTier: payload.model_tier,
        dispatchedAt: record.ts,
        terminalEventId: null,
        terminalAt: null,
        terminalType: null,
        status: 'live',
      };
      records.push(agent);
      if (taskId) open.set(openKey(taskId, payload.agent_role), agent);
      else openEpicLevel.push(agent);
      continue;
    }

    if (record.event_type === TASK_RESULT_EVENT_TYPE) {
      // The Result names its author in `agent` (result.schema.json's required
      // field). A hand-appended one that omits it still closes the task.
      const payload = record.payload as { agent?: string };
      // Both levels: result.schema.json names the task in the payload, and the
      // dispatch this closes may have named it only there too (D-245).
      const taskId = eventTaskId(record);
      if (taskId) {
        closeOpen(open, taskId, payload.agent ?? null, event_id, record.ts, 'result');
      }
      continue;
    }

    if (record.event_type === JUDGE_REPORT_EVENT_TYPE) {
      const payload = record.payload as { agent_role?: string };
      const taskId = eventTaskId(record);
      if (taskId) {
        closeOpen(open, taskId, payload.agent_role ?? null, event_id, record.ts, 'result');
      }
      continue;
    }

    if (record.event_type === JUDGE_VERDICT_EVENT_TYPE) {
      const payload = record.payload as { agent?: string; ok?: boolean };
      const taskId = eventTaskId(record);
      if (taskId) {
        // A run that produced no schema-valid verdict did not do its job, and
        // `ok: false` is how the log says so. Closing it as a result would let
        // a provider failing every call read exactly like one answering every
        // call — the distinction providerAgreement() exists to measure.
        const terminal: TerminalType = payload.ok === false ? 'error' : 'result';
        closeOpen(open, taskId, payload.agent ?? null, event_id, record.ts, terminal);
      }
      continue;
    }

    if (record.event_type === ERROR_EVENT_TYPE) {
      const payload = record.payload as { task_ref?: string; agent_role?: string };
      // `task_ref` is this event's own spelling; eventTaskId covers the two
      // the rest of the log uses (D-245).
      const taskId = eventTaskId(record) ?? payload.task_ref;
      if (taskId) {
        closeOpen(open, taskId, payload.agent_role ?? null, event_id, record.ts, 'error');
      }
      continue;
    }

    if (record.event_type === EPIC_CLOSED_EVENT_TYPE) {
      const payload = record.payload as { epic_id?: string };
      if (!payload.epic_id) continue;
      // Scoped to the session that closed the epic: another session's agents
      // are not this verdict's to speak for. Within it, the epic each entry
      // was dispatched for is now recorded (D-234), so the task-keyed half
      // asks that instead of matching the id's prefix by hand.
      for (const [key, entry] of open) {
        if (entry.sessionId !== record.session_id) continue;
        if (entry.epicId !== payload.epic_id) continue;
        closeEntry(entry, event_id, record.ts, 'abandoned');
        open.delete(key);
      }
      // The epic-level half keeps D-187's reasoning for an entry nothing
      // places -- no task id and no `epic_id` on its dispatch means no other
      // terminal event can ever name it, so the run's own verdict is the last
      // thing that can close it. But an entry that DID name an epic is placed,
      // and one session runs several epics in a row: sweeping the lot closed
      // the next epic's planner, live and working, on the previous epic's
      // verdict (D-234).
      openEpicLevel = openEpicLevel.filter((entry) => {
        if (entry.sessionId !== record.session_id) return true;
        if (entry.epicId !== null && entry.epicId !== payload.epic_id) return true;
        closeEntry(entry, event_id, record.ts, 'abandoned');
        return false;
      });
    }
  }

  return records;
}

export interface StaleAgent extends AgentRecord {
  liveHours: number;
}

/** Default staleness threshold (hours) when the caller doesn't specify one. */
export const DEFAULT_STALE_HOURS = 4;

/**
 * Still-live agents whose dispatch is older than `staleHours` as of `nowIso`
 * (architecture §4 "live agent registry ... stale detection"). Pure over
 * the fold's output — `nowIso` is threaded in rather than read from the
 * clock so this is deterministic and testable.
 */
export function detectStale(
  agents: readonly AgentRecord[],
  nowIso: string,
  staleHours: number = DEFAULT_STALE_HOURS,
): StaleAgent[] {
  const now = new Date(nowIso).getTime();
  const stale: StaleAgent[] = [];
  for (const agent of agents) {
    if (agent.status !== 'live') continue;
    const dispatchedMs = new Date(agent.dispatchedAt).getTime();
    const liveHours = (now - dispatchedMs) / (1000 * 60 * 60);
    if (liveHours > staleHours) stale.push({ ...agent, liveHours });
  }
  return stale;
}

/** Currently live agents (no terminal event yet), the overview page's "live agents" set. */
export function liveAgents(agents: readonly AgentRecord[]): AgentRecord[] {
  return agents.filter((a) => a.status === 'live');
}
