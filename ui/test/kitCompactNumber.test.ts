// CompactNumber's contract (ds-spec.md §2.1): `value`, `unit?: "tok"`;
// renders "1.2M tokens", "127K", "43" — the single implementation for every
// token-count surface (fixes audit items 4, 12, Analytics). No Tooltip is
// named in this row (unlike RelativeTime/ProgressRing, whose rows explicitly
// say "in a Tooltip"): the design page's tooltip-wrapped compact-number
// instances (e.g. "8.3K tok" / "412,318 tokens") are a call-site composition
// for a future PR, not part of this primitive. Same static source-text style
// as kitButton.test.ts: ui/vitest.config.ts is DOM-free by design, and DS0
// adds no call site for CompactNumber (§5). formatCompactValue (lib/format.ts)
// carries the actual formatting and has its own full test coverage; this
// file only checks that the component renders that value as text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const COMPACT_NUMBER = readFileSync(join(KIT, 'CompactNumber.vue'), 'utf8');

describe('kit/CompactNumber.vue', () => {
  it('declares value as a required number prop and unit as the optional "tok" literal', () => {
    expect(COMPACT_NUMBER).toMatch(/value:\s*number;/);
    expect(COMPACT_NUMBER).toMatch(/unit\?:\s*'tok';/);
  });

  it('formats with formatCompactValue, not formatCompactNumber or formatMeasuredTokens directly', () => {
    expect(COMPACT_NUMBER).toMatch(
      /import\s*\{\s*formatCompactValue\s*\}\s*from\s*'..\/..\/lib\/format\.js';/,
    );
    expect(COMPACT_NUMBER).not.toMatch(/formatCompactNumber\(/);
    expect(COMPACT_NUMBER).not.toMatch(/formatMeasuredTokens\(/);
  });

  it('passes both value and unit through to formatCompactValue', () => {
    expect(COMPACT_NUMBER).toMatch(/formatCompactValue\(\s*(props\.)?value,\s*(props\.)?unit\s*\)/);
  });

  it("renders no Tooltip: the spec's row names none, unlike RelativeTime/ProgressRing", () => {
    expect(COMPACT_NUMBER).not.toMatch(/Tooltip/);
  });
});
