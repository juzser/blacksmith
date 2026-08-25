// The one place that knows what a task id is shaped like (D-49/P9-10).
//
// Task ids are "<epic>/<bare>" — plan.ts mints them, worktree.ts branches on
// them, findings.ts and the projector group by them. Four call sites derived
// the epic with `taskId.split('/')[0]`, and that expression has no failure
// mode: given an unqualified "task-0" it returns "task-0" and the caller
// reads it as an epic named "task-0". Nothing throws, nothing logs, and the
// comparison against the real epic quietly misses — the dogfood epic showed
// up in `smith epic verdict` as "has no tasks in the event log" while three
// tasks sat in it.
//
// So the derivation lives here once, and its unqualified answer is `null`,
// not a plausible lie. A caller that cannot proceed without an epic asks
// requireEpicOfTaskId() and gets a typed error naming the id.
import { SmithError } from './errors.js';

export class TaskIdError extends SmithError {}

const SEPARATOR = '/';

/**
 * Split a task id into its epic and bare halves, or null when it has no
 * usable epic segment. Both halves must be non-empty: "/task-2" and "epic-1/"
 * are malformed, not qualified.
 *
 * The bare half keeps every remaining separator ("epic-1/followup-ab/extra"
 * -> epic "epic-1", bare "followup-ab/extra"): the epic is the FIRST segment
 * by definition, and re-joining epic + bare must round-trip the input.
 *
 * D-135: the `string` in the signature is a claim, not a guarantee. Every id
 * that reaches these helpers has been through a JSONL round-trip, where a
 * field the writer never set arrives as `undefined` and TypeScript is no
 * longer watching. `undefined.indexOf` threw a bare TypeError with no code
 * and no id in it, from inside a reader three call frames from the bad
 * record. A non-string names no epic, which is exactly what `null` says.
 */
function split(taskId: string): { epicId: string; bare: string } | null {
  if (typeof taskId !== 'string') return null;
  const index = taskId.indexOf(SEPARATOR);
  if (index <= 0) return null;
  const epicId = taskId.slice(0, index);
  const bare = taskId.slice(index + 1);
  return bare.length === 0 ? null : { epicId, bare };
}

/** The epic a task id names, or null when the id does not name one. */
export function epicOfTaskId(taskId: string): string | null {
  return split(taskId)?.epicId ?? null;
}

/** Whether `epicOfTaskId` can answer for this id. */
export function isQualifiedTaskId(taskId: string): boolean {
  return split(taskId) !== null;
}

/**
 * The id without its epic prefix; an unqualified id is already bare.
 *
 * A non-string answers `''` rather than falling through to `?? taskId`, which
 * would hand the caller back a non-string through a `: string` signature —
 * the same class of lie this module exists to stop. `''` is safe at every
 * comparison site because no real task id is empty, so it can never make two
 * distinct records look like the same task.
 */
export function bareTaskId(taskId: string): string {
  if (typeof taskId !== 'string') return '';
  return split(taskId)?.bare ?? taskId;
}

/**
 * Whether two task ids name the same task, across both spellings.
 *
 * D-130. `task_id` is written both qualified ("<epic>/<task>") and bare
 * ("<task>") for the same task — D-46/P9-10 fixed the producers, but the log
 * is append-only, so every session opened before that fix carries both, and
 * they interleave rather than splitting cleanly at a cutover point. A raw
 * `!==` therefore answered a query by the canonical id with a well-formed
 * SUBSET of the task's history, and a short answer is indistinguishable from
 * a complete one unless the caller already knows the true count.
 *
 * Two qualified ids are still compared whole: "epic-a/task-2" and
 * "epic-b/task-2" are different tasks that happen to share a bare name, and
 * folding them together would trade a silent omission for a silent merge.
 * Only when at least one side is bare — where the epic is genuinely unknown
 * rather than different — do the bare halves decide it.
 *
 * D-143 moved the rule here from `events.ts`, where it was private and only
 * `filterEvents` could reach it while the findings fold went on comparing
 * raw. The rule is about what a task id *means*, so it belongs to the module
 * that owns that question — the same reason `epicOfTaskId` lives here rather
 * than at its four original call sites.
 */
export function taskIdsMatch(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  if (a === b) return true;
  if (isQualifiedTaskId(a) && isQualifiedTaskId(b)) return false;
  return bareTaskId(a) === bareTaskId(b);
}

/**
 * `<epicId>/<taskId>`, idempotent when the id already carries that epic.
 *
 * Throws rather than double-prefixing when the id is qualified under a
 * different epic: `smith/epic-2/epic-1/task-2` is not a branch name anyone
 * meant, and the mismatch is a real disagreement between two producers about
 * which epic owns the task — worth an error, not a silent pick.
 */
export function qualifyTaskId(epicId: string, taskId: string): string {
  const parts = split(taskId);
  if (parts === null) return `${epicId}${SEPARATOR}${taskId}`;
  if (parts.epicId === epicId) return taskId;
  throw new TaskIdError(
    'task-id.epic-mismatch',
    `Task id "${taskId}" is already qualified under epic "${parts.epicId}"; cannot re-qualify it under "${epicId}".`,
    { task_id: taskId, epic_id: epicId, qualified_under: parts.epicId },
  );
}

/**
 * The epic, or a typed error. For call sites where an epic is structurally
 * required — a follow-up task id, a branch name — and inventing one would
 * produce a valid-looking artifact pointed at nothing.
 */
export function requireEpicOfTaskId(taskId: string): string {
  const epicId = epicOfTaskId(taskId);
  if (epicId === null) {
    throw new TaskIdError(
      'task-id.unqualified',
      `Task id "${taskId}" carries no epic. Task ids are "<epic>/<task>" (plan.ts/worktree.ts); an epic cannot be derived from this one.`,
      { task_id: taskId },
    );
  }
  return epicId;
}
