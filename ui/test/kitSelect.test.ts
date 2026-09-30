// Select's contract (ds-spec.md §2.1 line 372, unchanged from the old kit).
// Ported from ui/src/components/ds/Select.vue verbatim except the class name
// and tokens. Same static source-text style as kitTag.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SELECT = readFileSync(join(KIT, 'Select.vue'), 'utf8');

describe('kit/Select.vue', () => {
  it('exports the same SelectOption shape as the old kit', () => {
    expect(SELECT).toMatch(
      /export interface SelectOption\s*\{\s*value:\s*string;\s*label:\s*string;\s*\}/,
    );
  });

  it("keeps the old kit's unchanged contract: modelValue, options, ariaLabel", () => {
    expect(SELECT).toMatch(/modelValue:\s*string;/);
    expect(SELECT).toMatch(/options:\s*SelectOption\[\];/);
    expect(SELECT).toMatch(/ariaLabel:\s*string;/);
  });

  it('emits update:modelValue', () => {
    expect(SELECT).toMatch(
      /defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\];?\s*\}>\(\)/,
    );
  });

  it('renders a native select with the new bs-select class, one option per entry', () => {
    expect(SELECT).toMatch(/<select\b/);
    expect(SELECT).toMatch(/class="bs-select"/);
    expect(SELECT).not.toMatch(/ds-select/);
    expect(SELECT).toMatch(/v-for="opt in props\.options"/);
  });

  it("reads value from HTMLSelectElement on change, matching the old kit's handler", () => {
    expect(SELECT).toMatch(/e\.target as HTMLSelectElement/);
  });
});
