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

describe('parseStatedTurns edge cases', () => {
  it('zero occurrences give null', () => {
    expect(parseStatedTurns('no budget here\nturn budget 5')).toBeNull();
  });

  it('the label is case sensitive', () => {
    expect(parseStatedTurns('turn budget: 9\nTurn Budget: 9')).toBeNull();
    expect(parseStatedTurns(`quote ${L} 5 x\nturn budget: 9\n${L} 20`)).toBe(20);
  });

  it('an indented line is not standalone', () => {
    expect(parseStatedTurns(`quote ${L} 5 x\n  ${L} 20\n`)).toBeNull();
  });

  it('a line with leading text is not standalone', () => {
    expect(parseStatedTurns(`- ${L} 5\n${L} 20 and then some\n`)).toBeNull();
  });

  it('a standalone line with an empty value gives null', () => {
    expect(parseStatedTurns(`quote ${L} 5 x\n${L}\n`)).toBeNull();
  });

  it('a negative or decimal standalone value gives null', () => {
    expect(parseStatedTurns(`q ${L} 5 x\n${L} -3\n`)).toBeNull();
    expect(parseStatedTurns(`q ${L} 5 x\n${L} 3.5\n`)).toBeNull();
  });

  it('quoted labels inside a lessons block and a findings block do not hide the standalone line', () => {
    const p = [
      '<!-- BEGIN COMPILED LESSONS -->',
      `- [lesson-x] the "${L} 40" line is set by the runtime`,
      '<!-- END COMPILED LESSONS -->',
      '- [f-1] (S3-minor, raised) composeBrief throws on the text "' + L + '" in an entry',
      '',
      `${L} 60`,
    ].join('\n');
    expect(parseStatedTurns(p)).toBe(60);
  });

  it('a standalone line at the very start or end of the prompt with no newline parses', () => {
    expect(parseStatedTurns(`${L} 12\nquote ${L} 5 x`)).toBe(12);
    expect(parseStatedTurns(`quote ${L} 5 x\n${L} 12`)).toBe(12);
  });

  it('a single standalone occurrence with a non-digit value gives null', () => {
    expect(parseStatedTurns(`${L} many`)).toBeNull();
  });

  it('CRLF line endings: a standalone line is still recognised', () => {
    expect(parseStatedTurns(`quote ${L} 5 x\r\n${L} 30\r\ntail\r\n`)).toBe(30);
  });
});
