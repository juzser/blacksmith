// The closed readings of the `task_status` dimension, in one place.
//
// taxonomy.yml declares the vocabulary; these are the two questions the
// orchestrator asks *about* it that name a finite side. A roster belongs to
// the dimension, not to whichever consumer first needed one: these two lived
// in db/projector.ts and in waveNext.ts, epic.ts and db/queries.ts under four
// names, and two of those names were the same name for different sets.
//
// The module is deliberately a leaf — it imports nothing, and nothing added
// here may reach the database layer. waveNext.ts is in `dist/cli.js`'s static
// graph, so anything it imports is loaded by every `smith` invocation;
// cliBoot.test.ts pins that the db layer stays out of that graph, and it went
// red the moment these constants were read from db/projector.ts.

/**
 * The five `task_status` values that mean the work is over — the ones
 * db/projector.ts refuses to overwrite once a row reaches them. Read here
 * by a reader asking "is this task still open?" (db/queries.ts's
 * `inFlightEpics`) rather than keeping the complement by hand: taxonomy.yml
 * can declare a thirteenth status tomorrow, and the answer `!has()` gives for
 * one nobody has classified — still open — is the answer that loses nothing.
 *
 * Over is not the same as *well*: this set holds `failed` and `escalated`
 * too. A reader that needs the other question asks TERMINAL_OK_TASK_STATUSES
 * below, and the two are not interchangeable — waveNext.ts kept its own copy
 * of that one under *this* name until both moved here, and reading this set
 * there frees the claims on a worktree that still holds uncommitted work.
 */
export const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'superseded',
  'failed',
  'escalated',
  'waived',
]);

/**
 * The two terminal statuses that mean the work ended *well*: the task shipped,
 * or the operator decided it would not and waived it (D-120). Three modules
 * ask this question and each kept its own answer — waveNext.ts called it
 * TERMINAL_TASK_STATUSES, which is the name above for a different set;
 * epic.ts called it TERMINAL_OK_TASK_STATUSES; db/queries.ts called it
 * MILESTONE_COMPLETE_TASK_STATUSES. The three agreed because someone typed
 * the same two strings three times, not because anything held them together.
 *
 * Declared rather than subtracted from the set above, because "ended well" is
 * a judgement about what a status MEANS, and which way the default falls
 * decides what forgetting one costs. Subtracting a declared failure side
 * would read a thirteenth terminal status as *well* until someone classified
 * it: waveNext.ts would free the claims on a worktree nobody has finished
 * with, the roadmap bar would count the task done, and closeEpic would close
 * over it. Declared, an unclassified status is simply not done — every
 * reader fails closed, and the drift is visible instead of silent.
 */
export const TERMINAL_OK_TASK_STATUSES = new Set(['completed', 'waived']);
