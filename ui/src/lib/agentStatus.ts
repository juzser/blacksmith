// Sessions page (ds-spec.md §4.6, pattern 13 AgentStatusBadge): maps a
// SessionAgent's server-side `status` plus its own clock age into one of the
// 5 badge states the spec names, and its `tokens` union into what the token
// line should say. Kept as pure functions so the badge mapping is
// unit-tested without mounting AgentStatusBadge.vue.
import type { SessionAgent } from './api.js';
import { isPastStaleWindow } from './liveness.js';
import { roleLabel } from './roleLabels.js';
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
 * through — but it shares liveness.ts's isPastStaleWindow(), the one spelling
 * of the 4h boundary this dashboard is allowed to have.
 */
export function agentStatus(agent: SessionAgent, nowIso: string): AgentStatus {
  if (agent.status === 'done') return { state: 'done', label: 'Done', tone: 'done' };
  if (agent.status === 'error') return { state: 'failed', label: 'Failed', tone: 'danger' };
  if (agent.status === 'superseded' || agent.status === 'abandoned') {
    return { state: 'stopped', label: 'Stopped', tone: 'neutral' };
  }
  if (isPastStaleWindow(agent.dispatchedAt, nowIso)) {
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
 * different fact from "this provider never reports them". A pending row past
 * the stale window says nothing: the badge beside it already reads "No result
 * after 4h", and "Running" would contradict it.
 */
export function tokenDisplay(agent: SessionAgent, nowIso: string): TokenDisplay {
  const tokens = agent.tokens;
  if (tokens.state === 'measured') {
    return { kind: 'measured', input: tokens.input, output: tokens.output };
  }
  if (tokens.state === 'unmeasured') return { kind: 'text', text: 'not measured' };
  if (tokens.state === 'pending' && !isPastStaleWindow(agent.dispatchedAt, nowIso)) {
    return { kind: 'text', text: 'Running' };
  }
  return { kind: 'none' };
}

/**
 * Gates the Sessions poll: only a live row still inside the stale window can
 * change by asking again; a weeks-old dead row would keep the poll alive forever.
 */
export function hasWorkingAgents(
  roles: readonly { agents: readonly SessionAgent[] }[],
  nowIso: string,
): boolean {
  return roles.some((r) => r.agents.some((a) => agentStatus(a, nowIso).state === 'working'));
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
export function lastStepLabel(
  lastEventType: string | null,
  dispatch: { role: string | null; task: string | null } = { role: null, task: null },
): string {
  if (lastEventType === null) return 'No events yet';
  // A dispatch's role and task are known to the sessions API, so the row can
  // say who was sent where instead of a bare "Dispatched Agent".
  if (lastEventType === 'dispatch_decision' && dispatch.role !== null) {
    const who = `Dispatched ${roleLabel(dispatch.role)}`;
    return dispatch.task ? `${who} · ${dispatch.task}` : who;
  }
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
