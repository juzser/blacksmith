import { describe, expect, it } from 'vitest';
import { assertNotHeld, HeldByPostMergeError } from '../src/admission.js';

const A = 'e1/task-a';
const B = 'e1/task-b';

describe('assertNotHeld', () => {
  it('refuses a held task with wave.held-by-post-merge, naming the task and each merge', () => {
    const held = new Map([[A, ['e1/task-x', 'e1/task-y']]]);
    let caught: unknown;
    try {
      assertNotHeld(A, held);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HeldByPostMergeError);
    const error = caught as HeldByPostMergeError;
    expect(error.code).toBe('wave.held-by-post-merge');
    expect(error.message).toContain(A);
    expect(error.message).toContain('e1/task-x');
    expect(error.message).toContain('e1/task-y');
  });

  it('passes a task that is not held, and every task when nothing is held', () => {
    expect(() => assertNotHeld(B, new Map([[A, ['e1/task-x']]]))).not.toThrow();
    expect(() => assertNotHeld(A, new Map())).not.toThrow();
  });

  it('matches qualified and bare ids the way assertNotInFlight does', () => {
    expect(() => assertNotHeld('task-a', new Map([[A, ['e1/task-x']]]))).toThrow(
      HeldByPostMergeError,
    );
    expect(() => assertNotHeld(A, new Map([['task-a', ['e1/task-x']]]))).toThrow(
      HeldByPostMergeError,
    );
  });
});
