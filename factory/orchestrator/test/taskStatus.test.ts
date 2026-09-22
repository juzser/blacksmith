import { describe, expect, it } from 'vitest';
import { TERMINAL_OK_TASK_STATUSES, TERMINAL_TASK_STATUSES } from '../src/taskStatus.js';
import { loadTaxonomy } from '../src/taxonomy.js';

// ---------------------------------------------------------------------------
// Both rosters here are hand-declared, and the vocabulary they read is
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
});
