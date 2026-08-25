// What a live agent is working on, in one string.
//
// D-234. Four render sites read `taskId ?? 'no task assigned'` — the Overview
// card, its LiveAgentGroupRow, the Sessions graph node and the Sessions
// sr-only table. Half the dispatches in a real run carry no task id at all:
// a planner, a spec-reviewer, a scribe and the epic-close judges are
// dispatched for the epic, so the whole of that fleet read as unassigned
// while it was working. `agents.epicId` now records that scope, and this is
// the one place that decides how it reads, so the graph node, the card and
// the screen-reader table can never say three different things about the same
// agent.
import type { LiveAgentEntry } from './api.js';

/**
 * `''` is not an id. An empty string is falsy here on purpose: a
 * wrong-shaped value that reaches a render without throwing is exactly the
 * failure this label exists to stop, and an empty task cell claims a scope
 * the log never recorded.
 */
export function agentScopeLabel(entry: Pick<LiveAgentEntry, 'taskId' | 'epicId'>): string {
  if (entry.taskId) return entry.taskId;
  if (entry.epicId) return `epic: ${entry.epicId}`;
  // Truthful, and still reachable: a dispatch that names neither a task nor
  // an epic is placed by nothing at all.
  return 'no task assigned';
}
