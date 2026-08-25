import { describe, expect, it } from 'vitest';
import { ping } from '../src/index.js';

describe('ping', () => {
  it('returns pong', () => {
    expect(ping()).toBe('pong');
  });
});
