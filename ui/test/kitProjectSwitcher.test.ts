import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SWITCHER = readFileSync(join(KIT, 'ProjectSwitcher.vue'), 'utf8');

describe('kit/ProjectSwitcher.vue', () => {
  it('keeps the same modelValue/options contract the old inline Select used', () => {
    expect(SWITCHER).toMatch(/modelValue:\s*string/);
    expect(SWITCHER).toMatch(/options:\s*\{\s*value:\s*string;\s*label:\s*string\s*\}\[\]/);
    expect(SWITCHER).toMatch(/defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\]\s*\}>/);
  });

  it('labels itself Project for assistive tech', () => {
    expect(SWITCHER).toMatch(/aria-label="Project"/);
  });
});
