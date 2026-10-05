// Sessions page (ds-spec.md §4.6, pattern 13 AgentStatusBadge): maps a
// SessionAgent's server-side `status` plus its own clock age into one of the
// 5 badge states the spec names, and its `tokens` union into what the token
// line should say. Kept as pure functions so the badge mapping is
// unit-tested without mounting AgentStatusBadge.vue.
import type { SessionAgent } from './api.js';
import { AGENT_STALE_AFTER_MS } from './liveness.js';
import { titleFor } from './timelineDisplay.js';

export type AgentStatusState = 'working' | 'no-result' | 'done' | 'failed' | 'stopped';
export type AgentStatusTone = 'progress' | 'warning' | 'done' | 'danger' | 'neutral';

export interface AgentStatus {
  state: AgentStatusState;
  label: string;
  tone: AgentStatusTone;
}

/**
 * `agent.dispatchedAt` is the only clock SessionAgent carries for a `live`
 * row (no heartbeat), same limit liveness.ts's agentActivity() documents.
 * SessionAgent is not a LiveAgentEntry (no sessionId, provider is
 * nullable), so the age check is reimplemented here rather than called
 * through — but it reuses liveness.ts's AGENT_STALE_AFTER_MS, the one 4h
 * constant this dashboard is allowed to have.
 */
export function agentStatus(agent: SessionAgent, nowIso: string): AgentStatus {
  if (agent.status === 'done') return { state: 'done', label: 'Done', tone: 'done' };
  if (agent.status === 'error') return { state: 'failed', label: 'Failed', tone: 'danger' };
  if (agent.status === 'superseded' || agent.status === 'abandoned') {
    return { state: 'stopped', label: 'Stopped', tone: 'neutral' };
  }
  const then = new Date(agent.dispatchedAt).getTime();
  const nowMs = new Date(nowIso).getTime();
  const ageMs = Number.isNaN(then) || Number.isNaN(nowMs) ? 0 : Math.max(0, nowMs - then);
  // `>`, not `>=` — same boundary rule as liveness.ts's agentActivity().
  if (ageMs > AGENT_STALE_AFTER_MS) {
    return { state: 'no-result', label: 'No result after 4h', tone: 'warning' };
  }
  return { state: 'working', label: 'Working', tone: 'progress' };
}

export type TokenDisplay =
  | { kind: 'measured'; input: number; output: number }
  | { kind: 'text'; text: string }
  | { kind: 'none' };

/**
 * `unmeasured` never renders as 0 (D-169's "say the absence" rule): it gets
 * the word "not measured" instead of a number. `pending` says "Running" —
 * the agent is still working and tokens have not landed yet, which is a
 * different fact from "this provider never reports them".
 */
export function tokenDisplay(agent: SessionAgent): TokenDisplay {
  const tokens = agent.tokens;
  if (tokens.state === 'measured') {
    return { kind: 'measured', input: tokens.input, output: tokens.output };
  }
  if (tokens.state === 'unmeasured') return { kind: 'text', text: 'not measured' };
  if (tokens.state === 'pending') return { kind: 'text', text: 'Running' };
  return { kind: 'none' };
}

/**
 * "What it is doing" / "last step", for SessionRow and AgentBlock: both only
 * ever carry a bare `lastEventType`, never the full event payload, so this
 * runs the existing titleFor() (timelineDisplay.ts) with an empty payload
 * rather than re-deriving a second title vocabulary. Most event kinds fall
 * through titleFor's own default case (humanizeEventType) with an empty
 * payload the same way they would with a real one that happened to carry no
 * extra fields; the handful of kinds that read something out of the payload
 * (dispatch_decision's reason, a gate's verdict) just print their own prefix
 * with the detail blank, which is still a truthful "what kind of thing just
 * happened" one-liner.
 */
export function lastStepLabel(lastEventType: string | null): string {
  if (lastEventType === null) return 'No events yet';
  return titleFor({
    eventId: '',
    ts: '',
    eventType: lastEventType,
    taskId: null,
    agentId: null,
    planVersion: 0,
    causalParent: null,
    payload: {},
    project: null,
    actor: null,
    sessionId: '',
    sessionTitle: '',
  });
}
