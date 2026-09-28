import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waiverDenialNote } from '../src/lib/waiverDenialNote.js';

const SRC = join(import.meta.dirname, '..', 'src');

describe('waiverDenialNote', () => {
  it('says nothing when the batch left nothing to carry', () => {
    expect(waiverDenialNote([])).toBe('');
  });

  it('names the one finding a denial left open', () => {
    expect(waiverDenialNote(['finding-1'])).toBe(
      ' Carry finding-1 in the next `plan amend --findings`, or it stays open.',
    );
  });

  it('names all of them and uses the plural pronoun for more than one', () => {
    expect(waiverDenialNote(['finding-1', 'finding-2'])).toBe(
      ' Carry finding-1, finding-2 in the next `plan amend --findings`, or they stay open.',
    );
  });
});

// .vue templates are read by neither tsc nor biome here, so the only thing
// holding the page to this module is a test that reads its source (D-216).
describe('TaskDetailPage asks this module rather than re-deriving the answer', () => {
  const src = readFileSync(join(SRC, 'pages', 'TaskDetailPage.vue'), 'utf8');

  it('imports waiverDenialNote', () => {
    expect(src).toContain('waiverDenialNote.js');
    expect(src).toContain('waiverDenialNote');
  });

  it('surfaces findingIdsToCarry on a denial rather than a fixed string alone', () => {
    expect(src).toContain('findingIdsToCarry');
  });
});
