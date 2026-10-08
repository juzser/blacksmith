import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WORK_SRC = readFileSync(join(SRC_DIR, 'pages', 'WorkPage.vue'), 'utf8');
const MOBILE_TOPBAR_SRC = readFileSync(
  join(SRC_DIR, 'components', 'kit', 'MobileTopBar.vue'),
  'utf8',
);
const KANBAN_SRC = readFileSync(join(SRC_DIR, 'pages', 'KanbanPage.vue'), 'utf8');

describe('WorkPage.vue phone overflow (uiux spec §3)', () => {
  it('has one PageHeader titled Work, not per-view', () => {
    const headers = [...WORK_SRC.matchAll(/<PageHeader/g)];
    expect(headers).toHaveLength(1);
    expect(WORK_SRC).toMatch(/<PageHeader title="Work" \/>/);
  });

  it('teleports the View group to the shared overflow target, before <router-view>', () => {
    const template = WORK_SRC.slice(WORK_SRC.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '');
    const teleportIdx = template.indexOf('#bs-mtopbar-overflow-extra');
    const routerViewIdx = template.indexOf('<router-view');
    expect(teleportIdx).toBeGreaterThan(-1);
    expect(routerViewIdx).toBeGreaterThan(-1);
    expect(teleportIdx).toBeLessThan(routerViewIdx);
  });

  it('labels the View group "View" with two menuitemradio options, Kanban then Roadmap', () => {
    expect(WORK_SRC).toMatch(/role="group"/);
    expect(WORK_SRC).toMatch(/aria-label="View"/);
    expect(WORK_SRC).toMatch(/role="menuitemradio"/);
    expect(WORK_SRC).toMatch(/:aria-checked="currentView === opt\.value"/);
    expect(WORK_SRC).toMatch(
      /WORK_VIEWS\.map\(\(v\) => \(\{ value: v\.value, label: v\.label \}\)\)/,
    );
  });

  it('is not the kit RadioGroup/radiogroup — not a valid child of role="menu" (DS4 S1 round 6)', () => {
    expect(WORK_SRC).not.toMatch(/<RadioGroup/);
    expect(WORK_SRC).not.toMatch(/role="radiogroup"/);
    expect(WORK_SRC).not.toMatch(/input type="radio"/);
  });

  it('places a Separator after the View group, inside the same teleport', () => {
    const teleports = [...WORK_SRC.matchAll(/<Teleport[\s\S]*?<\/Teleport>/g)];
    const teleportBody =
      teleports.map((m) => m[0]).find((t) => t.includes('bs-mtopbar__viewgroup')) ?? '';
    const groupIdx = teleportBody.indexOf('bs-mtopbar__viewgroup');
    const sepIdx = teleportBody.indexOf('<Separator');
    expect(groupIdx).toBeGreaterThan(-1);
    expect(sepIdx).toBeGreaterThan(groupIdx);
  });
});

describe('Kanban drops Refresh on phone (existing rule, unchanged by S1)', () => {
  it('keeps the isPhoneWidth guard on the Refresh button', () => {
    expect(KANBAN_SRC).toMatch(/v-if="!isPhoneWidth"[\s\S]{0,80}Refresh/);
  });
});

describe('MobileTopBar closes its overflow on navigation', () => {
  it('closes on navigation through the router hook, not on the first navigation', () => {
    expect(MOBILE_TOPBAR_SRC).toMatch(
      /router\.afterEach\([\s\S]*navigationClosesOverflow\([\s\S]*closeOverflow\(\)/,
    );
  });
});
