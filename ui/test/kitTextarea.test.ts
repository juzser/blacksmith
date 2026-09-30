// Textarea's contract (ds-spec.md §2.1 line 372: "Input / Textarea / Select /
// RadioGroup | unchanged contract from the old kit (native-element
// wrappers); ported, re-styled to new tokens | unchanged"). Ported from
// ui/src/components/ds/Textarea.vue verbatim except the class name and
// tokens. Same static source-text style as kitTag.test.ts: ui/vitest.config.ts
// is DOM-free by design, and DS0 adds no call site for Textarea (§5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TEXTAREA = readFileSync(join(KIT, 'Textarea.vue'), 'utf8');

describe('kit/Textarea.vue', () => {
  it("keeps the old kit's unchanged contract: modelValue, ariaLabel, optional rows", () => {
    expect(TEXTAREA).toMatch(
      /defineProps<\{\s*modelValue:\s*string;\s*ariaLabel:\s*string;\s*rows\?:\s*number;?\s*\}>\(\)/,
    );
  });

  it('emits update:modelValue', () => {
    expect(TEXTAREA).toMatch(
      /defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\];?\s*\}>\(\)/,
    );
  });

  it('defaults rows to 4, same as the old kit', () => {
    expect(TEXTAREA).toMatch(/:rows="props\.rows\s*\?\?\s*4"/);
  });

  it('renders a native textarea with the new bs-textarea class', () => {
    expect(TEXTAREA).toMatch(/<textarea\b/);
    expect(TEXTAREA).toMatch(/class="bs-textarea"/);
    expect(TEXTAREA).not.toMatch(/ds-textarea/);
  });

  it("reads value from HTMLTextAreaElement on input, matching the old kit's handler", () => {
    expect(TEXTAREA).toMatch(/e\.target as HTMLTextAreaElement/);
  });
});
