import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SWITCHER = readFileSync(join(KIT, 'MobileProjectSwitcher.vue'), 'utf8');

describe('kit/MobileProjectSwitcher.vue', () => {
  it('takes the same modelValue/options v-model contract as ProjectSwitcher.vue', () => {
    expect(SWITCHER).toMatch(/modelValue:\s*string/);
    expect(SWITCHER).toMatch(/options:\s*\{\s*value:\s*string;\s*label:\s*string\s*\}\[\]/);
    expect(SWITCHER).toMatch(/defineEmits<\{\s*'update:modelValue':\s*\[value:\s*string\]\s*\}>/);
  });

  it('is a compact trigger + Popover list, not a native select', () => {
    expect(SWITCHER).not.toMatch(/<Select/);
    expect(SWITCHER).toMatch(/<Popover/);
    expect(SWITCHER).toMatch(/class="bs-mproject__trigger"/);
    expect(SWITCHER).toMatch(/ChevronDown/);
  });

  it('shows the currently selected project label on the trigger', () => {
    expect(SWITCHER).toMatch(
      /options\.find\(\(o\) => o\.value === props\.modelValue\)\?\.label \?\? props\.modelValue/,
    );
  });

  it('selecting an option emits update:modelValue and closes the popover', () => {
    expect(SWITCHER).toMatch(/emit\('update:modelValue', value\)/);
    expect(SWITCHER).toMatch(/open\.value = false/);
  });
});
