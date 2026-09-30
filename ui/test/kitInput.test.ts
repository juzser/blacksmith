// Input's contract (ds-spec.md §2.1 line 372: "Input / Textarea / Select /
// RadioGroup | unchanged contract from the old kit (native-element
// wrappers)"). The old kit has no Input.vue to port from — this models it on
// Textarea.vue's native-wrapper shape (modelValue + ariaLabel,
// update:modelValue on input), narrowed to <input>'s own type/placeholder.
// Same static source-text style as kitTag.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const INPUT = readFileSync(join(KIT, 'Input.vue'), 'utf8');

describe('kit/Input.vue', () => {
  it('declares modelValue, ariaLabel, optional type and placeholder', () => {
    expect(INPUT).toMatch(/modelValue:\s*string;/);
    expect(INPUT).toMatch(/ariaLabel:\s*string;/);
    expect(INPUT).toMatch(/placeholder\?:\s*string;/);
  });

  it('declares the five input types from the design decision, nothing else', () => {
    expect(INPUT).toMatch(
      /type\?:\s*'text'\s*\|\s*'email'\s*\|\s*'number'\s*\|\s*'search'\s*\|\s*'password';/,
    );
  });

  it('defaults type to text', () => {
    const match = INPUT.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/type:\s*'text'/);
  });

  it('emits update:modelValue', () => {
    expect(INPUT).toMatch(
      /defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\];?\s*\}>\(\)/,
    );
  });

  it('renders a native input with the bs-input class, type and placeholder bound', () => {
    expect(INPUT).toMatch(/<input\b/);
    expect(INPUT).toMatch(/class="bs-input"/);
    expect(INPUT).toMatch(/:type="type"/);
    expect(INPUT).toMatch(/:placeholder="placeholder"/);
  });

  it('reads value from HTMLInputElement on input', () => {
    expect(INPUT).toMatch(/e\.target as HTMLInputElement/);
  });
});
