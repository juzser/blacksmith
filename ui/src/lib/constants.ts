// DS3 §4.7 Slice A item 6 — pure constants the Kanban board and task-detail
// components (wired up in a later slice of this epic) share, so each magic
// number has one definition and one unit test rather than being duplicated
// per component.

/**
 * A column switches from rendering every card to a virtualized (windowed)
 * list once it holds more than this many tasks. The spec names this
 * constant without pinning a value; 30 is a conservative DOM-size guard,
 * well above KANBAN_PAGE_SIZE's 10-per-page reveal cap in lib/kanban.ts so
 * normal paged browsing never crosses it.
 */
export const KANBAN_VIRTUALIZE_THRESHOLD = 30;

/**
 * How long an agent can hold a task with no new activity before the UI
 * reads it as "waiting" rather than "working". The spec names this constant
 * without pinning a value; set to the orchestrator's own stale window
 * (`DEFAULT_STALE_HOURS = 4` in factory/orchestrator/src/agents-registry.ts)
 * converted to milliseconds, so client and server agree on what "stalled"
 * means.
 */
export const agentWaitingThresholdMs = 4 * 60 * 60 * 1000;
