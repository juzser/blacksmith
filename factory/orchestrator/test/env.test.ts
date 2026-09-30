import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

describe('readEnv (bs-rename)', () => {
  it('reads the BS_ name when only it is set', () => {
    expect(readEnv({ BS_FOO: 'a' }, 'BS_FOO')).toBe('a');
  });

  it('falls back to the legacy SMITH_ name when BS_ is unset', () => {
    expect(readEnv({ SMITH_FOO: 'b' }, 'BS_FOO')).toBe('b');
  });

  it('prefers BS_ over SMITH_ when both are set', () => {
    expect(readEnv({ BS_FOO: 'a', SMITH_FOO: 'b' }, 'BS_FOO')).toBe('a');
  });

  it('returns undefined when neither is set', () => {
    expect(readEnv({}, 'BS_FOO')).toBeUndefined();
  });

  it('accepts the legacy SMITH_ name as the lookup key too, resolving the same pair', () => {
    expect(readEnv({ BS_FOO: 'a', SMITH_FOO: 'b' }, 'SMITH_FOO')).toBe('a');
    expect(readEnv({ SMITH_FOO: 'b' }, 'SMITH_FOO')).toBe('b');
    expect(readEnv({}, 'SMITH_FOO')).toBeUndefined();
  });

  it('leaves a name carrying neither prefix as a plain lookup', () => {
    expect(readEnv({ PLAIN: 'x' }, 'PLAIN')).toBe('x');
  });
});
