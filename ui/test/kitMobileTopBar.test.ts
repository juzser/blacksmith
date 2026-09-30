import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TOPBAR = readFileSync(join(KIT, 'MobileTopBar.vue'), 'utf8');

describe('kit/MobileTopBar.vue', () => {
  it('opens navigation via a labelled hamburger button', () => {
    expect(TOPBAR).toMatch(/label="Open navigation"/);
  });

  it('the overflow menu contains the moved LiveIndicator controls', () => {
    const overflowStart = TOPBAR.indexOf('bs-mtopbar__overflow');
    const liveIndicatorIdx = TOPBAR.indexOf('<LiveIndicator');
    expect(overflowStart).toBeGreaterThan(-1);
    expect(liveIndicatorIdx).toBeGreaterThan(overflowStart);
  });

  it('shows a compact ProjectSwitcher only when the route is scoped', () => {
    expect(TOPBAR).toMatch(/<ProjectSwitcher\s+v-if="showProjectSwitcher"/);
  });
});
