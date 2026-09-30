// Tooltip's a11y contract (ds-spec.md §2.5) — no test file existed for it
// before this PR (S3-4). Same static source-text style as kitButton.test.ts:
// ui/vitest.config.ts is DOM-free by design, so the actual hover/focus/Esc
// wiring is Playwright's job once a page renders Tooltip; these assertions
// check the source keeps the fixes for S2-1 (no double tab stop) and S3-1
// (keyboard-only open, Esc doesn't leak to an enclosing Dialog) in place.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TOOLTIP = readFileSync(join(KIT, 'Tooltip.vue'), 'utf8');

describe('kit/Tooltip.vue', () => {
  it('does not hardcode tabindex or aria-describedby on the wrapper (S2-1)', () => {
    expect(TOOLTIP).not.toMatch(/:tabindex="mode === 'describe' \? 0 : undefined"/);
    expect(TOOLTIP).not.toMatch(/:aria-describedby="mode === 'describe'/);
  });

  it('resolves a focusable descendant and only tabindex=0s the wrapper when there is none (S2-1)', () => {
    expect(TOOLTIP).toMatch(/describeTargetEl\.value = triggerRef\.value\.querySelector/);
    expect(TOOLTIP).toMatch(/wrapperTabindex\.value = describeTargetEl\.value \? undefined : 0;/);
    expect(TOOLTIP).toMatch(/:tabindex="wrapperTabindex"/);
  });

  it('sets aria-describedby on the resolved target imperatively, not on the wrapper in the template (S2-1)', () => {
    expect(TOOLTIP).toMatch(/describedEl\?\.setAttribute\('aria-describedby', tooltipId\)/);
    expect(TOOLTIP).toMatch(/describedEl\?\.removeAttribute\('aria-describedby'\)/);
  });

  it('opens only on a keyboard-focus-visible target, not any focusin (S3-1)', () => {
    expect(TOOLTIP).not.toMatch(/@focusin="showNow"/);
    expect(TOOLTIP).toMatch(/@focusin="onFocusIn"/);
    expect(TOOLTIP).toMatch(/target\?\.matches\?\.\(':focus-visible'\)/);
  });

  it('registers its Esc listener on the capture phase and stops propagation, so it wins the race against Dialog (S3-1)', () => {
    expect(TOOLTIP).toMatch(/document\.addEventListener\('keydown', onKeydown, true\)/);
    expect(TOOLTIP).toMatch(/document\.removeEventListener\('keydown', onKeydown, true\)/);
    expect(TOOLTIP).toMatch(/event\.stopPropagation\(\);/);
  });
});
