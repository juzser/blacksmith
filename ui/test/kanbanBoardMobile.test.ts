// KanbanBoard.vue mobile column switcher (ds-spec.md §3.1 Work/Kanban row).
// Source-text scrape, same style as needsYouInbox.test.ts: no DOM harness in
// this config — interactive behaviour (tab switching, counts) is covered by
// lib/kanban.ts's defaultMobileColumnKey() unit tests and by the e2e spec.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'KanbanBoard.vue'),
  'utf8',
);

describe('KanbanBoard.vue — mobile column switcher (§3.1 Work/Kanban row)', () => {
  it('reads isPhoneWidth from the shared viewport composable, not a new breakpoint', () => {
    expect(SRC).toMatch(/from '\.\.\/composables\/useViewport\.js'/);
    expect(SRC).toMatch(/isPhoneWidth/);
  });

  it('renders a tab row with proper ARIA tab semantics, one tab per column, labelled with its count', () => {
    expect(SRC).toMatch(/v-if="isPhoneWidth"[\s\S]{0,200}role="tablist"/);
    expect(SRC).toMatch(/role="tab"/);
    expect(SRC).toMatch(/:aria-selected="/);
    expect(SRC).toMatch(/\{\{ col\.label \}\}[\s\S]{0,80}\{\{ col\.total \}\}/);
  });

  it('defaults the active mobile column via defaultMobileColumnKey()', () => {
    expect(SRC).toMatch(/defaultMobileColumnKey/);
  });

  it('shows only the active column on phone, every column on desktop', () => {
    expect(SRC).toMatch(/isColumnVisible/);
    expect(SRC).toMatch(/!isPhoneWidth\.value \|\| key === mobileActiveKey\.value/);
    expect(SRC).toMatch(/v-show="isColumnVisible\(col\.key\)"/);
  });

  it('hides the column head (status icon, title, count tag, the hide-column menu) on phone', () => {
    expect(SRC).toMatch(/v-if="!isPhoneWidth" class="bs-kanban-col__head"/);
  });

  it('no longer renders a standalone desktop toolbar row for the display-options trigger', () => {
    expect(SRC).not.toMatch(/bs-kanban-board__toolbar/);
  });

  it('renders compact cards on phone', () => {
    expect(SRC).toMatch(/:compact="isPhoneWidth"/);
  });

  it('navigates straight to the task on phone instead of opening the quick-look peek panel', () => {
    expect(SRC).toMatch(
      /function onCardSelect\(taskId: string, storeId\?: string\) \{[\s\S]{0,200}if \(isPhoneWidth\.value\) \{\s*emit\('select', taskId, storeId\);\s*return;\s*\}/,
    );
  });

  it('teleports the display-options control to the MobileTopBar overflow menu on phone, the page toolbar on desktop', () => {
    expect(SRC).toMatch(/<Teleport[\s\S]{0,60}isPhoneWidth[\s\S]{0,400}KanbanDisplayOptions/);
    expect(SRC).toMatch(/#bs-mtopbar-overflow-extra/);
    expect(SRC).toMatch(/#bs-kanban-page-toolbar-extra/);
  });

  it('gives each mobile tab a stable id and points it at its panel via aria-controls', () => {
    expect(SRC).toMatch(/:id="`bs-kanban-tab-\$\{col\.key\}`"/);
    expect(SRC).toMatch(/:aria-controls="`bs-kanban-panel-\$\{col\.key\}`"/);
  });

  it('marks the visible column section as the tabpanel for its active tab', () => {
    expect(SRC).toMatch(/:id="`bs-kanban-panel-\$\{col\.key\}`"/);
    expect(SRC).toMatch(
      /:role="isPhoneWidth && mobileActiveKey === col\.key \? 'tabpanel' : undefined"/,
    );
    expect(SRC).toMatch(
      /:aria-labelledby="isPhoneWidth && mobileActiveKey === col\.key \? `bs-kanban-tab-\$\{col\.key\}` : undefined"/,
    );
  });
});
