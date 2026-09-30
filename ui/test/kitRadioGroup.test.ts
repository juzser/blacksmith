// RadioGroup's contract (ds-spec.md §2.1 line 372, unchanged from the old
// kit). Ported from ui/src/components/ds/RadioGroup.vue verbatim except the
// class names and tokens. Same static source-text style as kitTag.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const RADIOGROUP = readFileSync(join(KIT, 'RadioGroup.vue'), 'utf8');

describe('kit/RadioGroup.vue', () => {
  it('exports the same RadioOption shape as the old kit', () => {
    expect(RADIOGROUP).toMatch(
      /export interface RadioOption\s*\{\s*value:\s*string;\s*label:\s*string;\s*\}/,
    );
  });

  it("keeps the old kit's unchanged contract: modelValue, options, name, ariaLabel", () => {
    expect(RADIOGROUP).toMatch(/modelValue:\s*string;/);
    expect(RADIOGROUP).toMatch(/options:\s*RadioOption\[\];/);
    expect(RADIOGROUP).toMatch(/name:\s*string;/);
    expect(RADIOGROUP).toMatch(/ariaLabel:\s*string;/);
  });

  it('emits update:modelValue', () => {
    expect(RADIOGROUP).toMatch(
      /defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\];?\s*\}>\(\)/,
    );
  });

  it('renders role="radiogroup" with the new bs-radiogroup/bs-radio classes', () => {
    expect(RADIOGROUP).toMatch(/role="radiogroup"/);
    expect(RADIOGROUP).toMatch(/class="bs-radiogroup"/);
    expect(RADIOGROUP).toMatch(/class="bs-radio"/);
    expect(RADIOGROUP).not.toMatch(/ds-radiogroup|ds-radio\b/);
  });

  it('checks the radio matching modelValue, same as the old kit', () => {
    expect(RADIOGROUP).toMatch(/:checked="modelValue === opt\.value"/);
  });
});
