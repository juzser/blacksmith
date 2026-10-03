import { describe, expect, it } from 'vitest';
import { isTextClamped } from '../src/lib/clamp.js';

describe('lib/clamp.ts isTextClamped()', () => {
  it('is false when the content fits exactly', () => {
    expect(isTextClamped(60, 60)).toBe(false);
  });

  it('is false when the content is shorter than the box', () => {
    expect(isTextClamped(40, 60)).toBe(false);
  });

  it('is true when the content overflows the box', () => {
    expect(isTextClamped(120, 60)).toBe(true);
  });
});
