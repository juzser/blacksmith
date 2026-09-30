// Static source-text check, same style as kitProgressRing.test.ts.
// No old-kit predecessor and no mockup markup for this one — see the
// component's own header comment for what that means for its class names.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BAR = readFileSync(join(KIT, 'ProgressBar.vue'), 'utf8');

describe('kit/ProgressBar.vue', () => {
  it('declares a required segments array prop and a required label prop', () => {
    expect(BAR).toMatch(/segments:\s*Segment\[\];/);
    expect(BAR).toMatch(/\n\s*label:\s*string;/);
    expect(BAR).not.toMatch(/\n\s*label\?:\s*string;/);
  });

  it('sizes each segment against the sum of all segment values, floored at 100', () => {
    expect(BAR).toMatch(/Math\.max\([\s\S]*?100,?\s*\)/);
  });

  it('renders no built-in percentage number — the caller composes that separately', () => {
    expect(BAR).not.toMatch(/pnum/);
  });

  it('uses new pbar/pbar__seg class names (no mockup precedent to port from)', () => {
    expect(BAR).toMatch(/class="pbar"/);
    expect(BAR).toMatch(/class="pbar__seg"/);
  });

  it('reads role=img and aria-label off the label prop on the pbar wrapper', () => {
    expect(BAR).toMatch(/class="pbar" role="img" :aria-label="label"/);
  });
});
