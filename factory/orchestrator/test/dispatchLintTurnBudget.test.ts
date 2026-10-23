import { describe, expect, it } from 'vitest';
import { parseStatedTurns } from '../src/dispatchLint.js';

const L = 'Turn budget:';

describe('parseStatedTurns with several occurrences', () => {
  it('a single mid-line occurrence still parses', () => {
    expect(parseStatedTurns(`Role: coder. ${L} 40 and more text.`)).toBe(40);
  });

  it('two standalone lines give null', () => {
    expect(parseStatedTurns(`${L} 40\n\nbody\n${L} 40\n`)).toBeNull();
  });

  it('several mid-line occurrences plus one standalone line give the standalone number', () => {
    const p = `quote "${L} 5" and "${L} 9" in prose\n\n${L} 150\n\ntail`;
    expect(parseStatedTurns(p)).toBe(150);
  });

  it('several occurrences and no standalone line give null', () => {
    expect(parseStatedTurns(`a ${L} 5 b\nc ${L} 6 d`)).toBeNull();
  });

  it('a standalone line with a non-digit value gives null', () => {
    expect(parseStatedTurns(`quote ${L} 5 here\n${L} 12x\n`)).toBeNull();
  });

  it('a standalone line tolerates tabs and trailing blanks', () => {
    expect(parseStatedTurns(`quote ${L} 5 here\n${L}\t77 \t\n`)).toBe(77);
  });
});
