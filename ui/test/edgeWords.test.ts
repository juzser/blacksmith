import { describe, expect, it } from 'vitest';
import { edgeWords } from '../src/lib/edgeWords.js';

describe('edgeWords() (DS4 S3 §6)', () => {
  it('words every listed edgeType per spec §6', () => {
    expect(edgeWords('artifact')).toBe('uses its output');
    expect(edgeWords('claim-order')).toBe('runs after it (same files)');
    expect(edgeWords('spec-clause')).toBe('its test guards this');
    expect(edgeWords('regression-test')).toBe('its test guards this');
    expect(edgeWords('research-brief')).toBe('its research informs this');
  });

  it('falls back to a neutral phrase for an unknown edgeType', () => {
    expect(edgeWords('something-new')).toBe('depends on it');
  });
});
