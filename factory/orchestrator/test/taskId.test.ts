import { describe, expect, it } from 'vitest';
import {
  bareTaskId,
  epicOfTaskId,
  isQualifiedTaskId,
  qualifyTaskId,
  requireEpicOfTaskId,
  TaskIdError,
  taskIdsMatch,
} from '../src/taskId.js';

// ---------------------------------------------------------------------------
// D-49/P9-10. Four call sites derived epic membership with `split('/')[0]`,
// which returns the WHOLE string for an unqualified id — so a bare "task-0"
// read as the epic "task-0", and every downstream comparison against a real
// epic silently missed. One helper, and the unqualified case answers `null`
// instead of a plausible lie.
// ---------------------------------------------------------------------------

describe('epicOfTaskId', () => {
  it('returns the epic segment of a qualified id', () => {
    expect(epicOfTaskId('epic-1/task-2')).toBe('epic-1');
  });

  it('returns null — never the whole string — for an unqualified id', () => {
    expect(epicOfTaskId('task-2')).toBeNull();
  });

  it('takes the first segment when the bare part itself contains a slash', () => {
    expect(epicOfTaskId('epic-1/followup-abc/extra')).toBe('epic-1');
  });

  it('returns null for an empty epic segment', () => {
    expect(epicOfTaskId('/task-2')).toBeNull();
  });

  it('returns null for an empty bare segment', () => {
    expect(epicOfTaskId('epic-1/')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(epicOfTaskId('')).toBeNull();
  });
});

describe('isQualifiedTaskId', () => {
  it('is true exactly when epicOfTaskId can answer', () => {
    for (const id of ['epic-1/task-2', 'epic-1/followup-abc/extra']) {
      expect(isQualifiedTaskId(id)).toBe(true);
    }
    for (const id of ['task-2', '/task-2', 'epic-1/', '']) {
      expect(isQualifiedTaskId(id)).toBe(false);
    }
  });
});

describe('bareTaskId', () => {
  it('strips the epic segment', () => {
    expect(bareTaskId('epic-1/task-2')).toBe('task-2');
  });

  it('keeps everything after the first slash', () => {
    expect(bareTaskId('epic-1/followup-abc/extra')).toBe('followup-abc/extra');
  });

  it('returns an unqualified id unchanged', () => {
    expect(bareTaskId('task-2')).toBe('task-2');
  });
});

// ---------------------------------------------------------------------------
// D-135. These helpers are typed `(taskId: string)`, but the values reaching
// them come off a JSONL payload, where the type is a claim rather than a
// guarantee. A record whose task_id was never written arrived as `undefined`
// and `undefined.indexOf` threw a bare TypeError from inside `split()` — no
// code, no task id, no hint of which record. An answer of "no epic" is the
// truthful reply to "what epic is this non-id in?", and it leaves the caller
// free to report the bad record instead of dying on it.
// ---------------------------------------------------------------------------

describe('non-string input', () => {
  const nonStrings: unknown[] = [undefined, null, 42, {}, []];

  it('epicOfTaskId answers null instead of throwing', () => {
    for (const value of nonStrings) {
      expect(epicOfTaskId(value as string)).toBeNull();
    }
  });

  it('isQualifiedTaskId answers false instead of throwing', () => {
    for (const value of nonStrings) {
      expect(isQualifiedTaskId(value as string)).toBe(false);
    }
  });

  it('bareTaskId answers the empty string — never the non-string it was given', () => {
    // `''` is the string-typed "no answer": returning the input unchanged
    // would hand a caller a non-string through a `: string` signature, and
    // `''` cannot collide with any real task id at a comparison site.
    for (const value of nonStrings) {
      expect(bareTaskId(value as string)).toBe('');
    }
  });

  it('requireEpicOfTaskId still throws a typed error, not a TypeError', () => {
    try {
      requireEpicOfTaskId(undefined as unknown as string);
      throw new Error('expected requireEpicOfTaskId to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskIdError);
      expect((err as TaskIdError).code).toBe('task-id.unqualified');
    }
  });
});

describe('qualifyTaskId', () => {
  it('qualifies a bare id', () => {
    expect(qualifyTaskId('epic-1', 'task-2')).toBe('epic-1/task-2');
  });

  it('is idempotent on an id already qualified under the same epic', () => {
    expect(qualifyTaskId('epic-1', 'epic-1/task-2')).toBe('epic-1/task-2');
  });

  it('refuses an id already qualified under a different epic', () => {
    expect(() => qualifyTaskId('epic-2', 'epic-1/task-2')).toThrowError(TaskIdError);
    try {
      qualifyTaskId('epic-2', 'epic-1/task-2');
    } catch (err) {
      expect((err as TaskIdError).code).toBe('task-id.epic-mismatch');
    }
  });
});

describe('requireEpicOfTaskId', () => {
  it('returns the epic for a qualified id', () => {
    expect(requireEpicOfTaskId('epic-1/task-2')).toBe('epic-1');
  });

  it('throws task-id.unqualified rather than inventing an epic', () => {
    try {
      requireEpicOfTaskId('task-2');
      throw new Error('expected requireEpicOfTaskId to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskIdError);
      expect((err as TaskIdError).code).toBe('task-id.unqualified');
      expect((err as TaskIdError).details.task_id).toBe('task-2');
    }
  });
});

// ---------------------------------------------------------------------------
// D-130 wrote this rule inside events.ts, where only `filterEvents` could
// reach it, and the fold in findings.ts went on comparing raw. The rule is
// about what a task id means, so it belongs to the module that owns that
// question (D-143).
// ---------------------------------------------------------------------------
describe('taskIdsMatch', () => {
  it('matches a bare id against its qualified spelling', () => {
    expect(taskIdsMatch('task-2', 'epic-1/task-2')).toBe(true);
    expect(taskIdsMatch('epic-1/task-2', 'task-2')).toBe(true);
  });

  it('matches identical ids of either spelling', () => {
    expect(taskIdsMatch('epic-1/task-2', 'epic-1/task-2')).toBe(true);
    expect(taskIdsMatch('task-2', 'task-2')).toBe(true);
  });

  // Two ids that each name an epic are two tasks that share a bare name.
  // Folding them together would trade a silent omission for a silent merge.
  it('keeps the same bare name in two epics apart', () => {
    expect(taskIdsMatch('epic-1/task-2', 'epic-2/task-2')).toBe(false);
  });

  it('does not match different tasks', () => {
    expect(taskIdsMatch('epic-1/task-2', 'epic-1/task-3')).toBe(false);
    expect(taskIdsMatch('task-2', 'task-3')).toBe(false);
  });

  // D-135's lesson: the `string` in the signature is a claim, not a guarantee.
  it('answers false for an id that is missing or not a string', () => {
    expect(taskIdsMatch(undefined, 'epic-1/task-2')).toBe(false);
    expect(taskIdsMatch(undefined, undefined)).toBe(false);
    expect(taskIdsMatch(42 as unknown as string, 'epic-1/task-2')).toBe(false);
    expect(taskIdsMatch('', 'epic-1/task-2')).toBe(false);
  });
});
