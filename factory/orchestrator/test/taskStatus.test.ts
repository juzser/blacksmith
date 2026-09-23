import { describe, expect, it } from 'vitest';
import {
  HELD_OPEN_BY_AN_OPERATOR,
  TERMINAL_OK_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
} from '../src/taskStatus.js';
import { loadTaxonomy } from '../src/taxonomy.js';

// ---------------------------------------------------------------------------
// All three rosters here are hand-declared, and the vocabulary they read is
// declared somewhere else entirely. TERMINAL_OK_TASK_STATUSES is hand-written
// on purpose -- "ended well" is a judgement about what a status MEANS, and
// deriving it by subtracting a failure side would default an unclassified one
// to *well*, which is the direction that costs a worktree. What a guard can
// still hold is that the judgement is made about statuses that exist, and
// that a status called terminal-OK is one the projector refuses to overwrite.
// ---------------------------------------------------------------------------
describe('the terminal readings of task_status answer to the declaration', () => {
  const declared = new Set(loadTaxonomy().dimensions.task_status);

  it.each([...TERMINAL_TASK_STATUSES])('%s is a task_status taxonomy.yml declares', (status) => {
    expect(declared.has(status)).toBe(true);
  });

  it.each([...TERMINAL_OK_TASK_STATUSES])('%s is terminal, not only terminal-OK', (status) => {
    // A success status added to the OK set and not to the one above it
    // would be a task the log still overwrites: `wave-admitted` resets a
    // non-terminal row to `ready`, so an epic re-planning a wave would
    // reopen work that had finished.
    expect(TERMINAL_TASK_STATUSES.has(status)).toBe(true);
  });

  // HELD_OPEN_BY_AN_OPERATOR arrived a roster later than the two above (#165
  // against #159) and neither leg grew with it. That matters more for this one
  // than for either sibling, because claims.ts does not read it as a roster --
  // it SUBTRACTS it: CLOSED_TO_FURTHER_WORK is every terminal status except
  // these. A member spelled here under a name the dimension no longer declares
  // subtracts nothing, so a task an operator is still holding reads as closed,
  // and a finding about its files mints a follow-up task competing for claims
  // that task still holds -- the outcome the docblock says this exception
  // exists to prevent.
  //
  // The one other statement of the judgement, claims.test.ts's hand-typed
  // `heldOpenByAnOperator`, cannot see that on its own. It is there to make a
  // DISAGREEMENT between the two visible, and a rename in taxonomy.yml leaves
  // both stale in the same direction, where no disagreement is left to see.
  // Tying this side to the declaration is what turns that silent pair back
  // into one loud failure.
  it.each([...HELD_OPEN_BY_AN_OPERATOR])(
    '%s is held open under a name taxonomy.yml declares',
    (status) => {
      expect(declared.has(status)).toBe(true);
    },
  );

  it.each([...HELD_OPEN_BY_AN_OPERATOR])('%s is held open out of a terminal status', (status) => {
    // Subtracting a non-terminal status from the terminal roster removes
    // nothing, so the exception would read as made and have no effect at all.
    expect(TERMINAL_TASK_STATUSES.has(status)).toBe(true);
  });
});
