import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TOPBAR = readFileSync(join(KIT, 'MobileTopBar.vue'), 'utf8');
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

describe('kit/MobileTopBar.vue', () => {
  it('has no hamburger/nav trigger — the phone shell has no Sheet to open (ds-spec.md §3)', () => {
    expect(TOPBAR).not.toMatch(/Open navigation/);
    expect(TOPBAR).not.toMatch(/openNav/);
    expect(TOPBAR).not.toMatch(/<Sheet/);
  });

  it('the liveness dot carries the same text as an aria-label, not aria-hidden', () => {
    expect(TOPBAR).not.toMatch(/aria-hidden="true"/);
    expect(TOPBAR).toMatch(/:aria-label="dotLabel"/);
    expect(TOPBAR).toMatch(/formatLiveStatus/);
  });

  it('the overflow menu is labelled "More actions", not "More controls"', () => {
    expect(TOPBAR).not.toMatch(/More controls/);
    expect(TOPBAR.match(/More actions/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the overflow menu holds Pause, Switch theme and Settings as individual controls, not the whole LiveIndicator', () => {
    expect(TOPBAR).not.toMatch(/<LiveIndicator/);
    expect(TOPBAR).not.toMatch(/Refresh now/);
    const overflowStart = TOPBAR.indexOf('bs-mtopbar__overflow');
    expect(overflowStart).toBeGreaterThan(-1);
    const overflowBody = TOPBAR.slice(overflowStart);
    expect(overflowBody).toMatch(/togglePause/);
    expect(overflowBody).toMatch(/toggleTheme/);
    expect(overflowBody).toMatch(/Settings/);
  });

  it('shows a compact MobileProjectSwitcher only when the route is scoped', () => {
    expect(TOPBAR).toMatch(/<MobileProjectSwitcher\s+v-if="showProjectSwitcher"/);
    expect(TOPBAR).not.toMatch(/<ProjectSwitcher\s/);
  });

  it('the overflow renders as a labeled vertical menu (ds-review.html .ph-menu)', () => {
    expect(TOPBAR).toMatch(/role="menu"/);
    const overflowStart = TOPBAR.indexOf('bs-mtopbar__overflow"');
    const overflowBody = TOPBAR.slice(overflowStart);
    const menuitemCount = overflowBody.match(/role="menuitem"/g)?.length ?? 0;
    expect(menuitemCount).toBeGreaterThanOrEqual(3);
  });

  it('the pause menu item label flips between pause and resume', () => {
    expect(TOPBAR).toMatch(/Pause live updates/);
    expect(TOPBAR).toMatch(/Resume live updates/);
  });

  it('the Settings menu item stays disabled, and a Separator sits before the extra slot', () => {
    const overflowStart = TOPBAR.indexOf('bs-mtopbar__overflow"');
    const overflowBody = TOPBAR.slice(overflowStart);
    const settingsIdx = overflowBody.indexOf('Settings');
    expect(settingsIdx).toBeGreaterThan(-1);
    const settingsItem = overflowBody.slice(Math.max(0, settingsIdx - 200), settingsIdx + 50);
    expect(settingsItem).toMatch(/aria-disabled="true"/);

    const sepIdx = overflowBody.indexOf('<Separator');
    const extraIdx = overflowBody.indexOf('bs-mtopbar-overflow-extra');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(extraIdx).toBeGreaterThan(sepIdx);
  });

  it('no stale ds4-plan.md references remain (that file is not in the repo)', () => {
    expect(TOPBAR).not.toMatch(/ds4-plan\.md/);
  });
});

describe('.bs-mtopbar__project CSS (push-right onto a display: contents wrapper)', () => {
  it('does not put margin-left: auto directly on the display: contents wrapper, where it has no effect', () => {
    const match = CSS.match(/\.bs-mtopbar__project \{[\s\S]*?\}/);
    expect(match?.[0]).not.toMatch(/margin-left: auto/);
  });

  it("puts the push-right on .bs-mproject__trigger, the wrapper's one real flex item", () => {
    const match = CSS.match(/\.bs-mtopbar__project > \.bs-mproject__trigger \{[\s\S]*?\}/);
    expect(match?.[0]).toMatch(/margin-left: auto/);
  });
});
