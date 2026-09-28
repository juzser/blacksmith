import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'ProjectsPage.vue'),
  'utf8',
);

// ui/tsconfig.json does not type-check .vue and biome.json does not lint it,
// so the source text is the only place this card can be held to
// formatBudgetPct rather than a hand-rolled `tokensSpent / tokensBudget`
// division that reads a mix of measured and unmeasured results (issue #220)
// as an exact percentage, or as a fabricated "0%" when none of it was
// measured (D-221's rule: derived display logic lives in lib/*.ts).
describe('ProjectsPage.vue — budget-used stat sources its label from lib/format.ts', () => {
  it('imports formatBudgetPct rather than hand-rolling the percentage', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/format\.js'/);
    expect(SFC).toContain('formatBudgetPct(');
  });

  it('divides tokensSpent by tokensBudget nowhere outside the helper call', () => {
    expect(SFC).not.toMatch(/tokensSpent\s*\/\s*.*tokensBudget/);
  });
});
