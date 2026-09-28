import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'OverviewPage.vue'),
  'utf8',
);

describe('OverviewPage.vue — Budget used card sources its label from lib/format.ts', () => {
  // ui/tsconfig.json does not type-check .vue and biome.json does not lint
  // it, so the source text is the only place this card can be held to
  // formatMeasuredTokens rather than a hand-rolled reduce that folds an
  // unmeasured result (issue #220) in as a fabricated 0 (D-221's rule).
  it('imports formatMeasuredTokens rather than hand-rolling the label', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/format\.js'/);
    expect(SFC).toContain('formatMeasuredTokens(');
  });

  it('reduces tokensByEpic nowhere in the template', () => {
    expect(SFC).not.toMatch(/tokensByEpic\.reduce/);
  });
});
