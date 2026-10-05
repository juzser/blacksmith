import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const APP_SRC = readFileSync(join(SRC_DIR, 'App.vue'), 'utf8');
const NAV_SRC = readFileSync(join(SRC_DIR, 'nav.ts'), 'utf8');

describe('nav.ts Work item', () => {
  // Work's entry now spans multiple lines (it carries a nested `children`
  // array, operator decision 2026-10-05), so this slices to the next
  // sibling entry rather than matching up to the first `}`.
  const workSection = NAV_SRC.slice(
    NAV_SRC.indexOf("id: 'work',"),
    NAV_SRC.indexOf("id: 'activity'"),
  );

  it('points at /work/kanban and carries a /work matchPrefix', () => {
    expect(workSection).toMatch(/route: '\/work\/kanban'/);
    expect(workSection).toMatch(/matchPrefix: '\/work'/);
  });

  it('carries two always-visible level-2 children (ds-spec.md §3, operator decision 2026-10-05)', () => {
    expect(workSection).toMatch(
      /children:\s*\[\s*\{ id: 'work-kanban', label: 'Kanban', route: '\/work\/kanban' \},\s*\{ id: 'work-roadmap', label: 'Roadmap', route: '\/work\/roadmap' \},\s*\]/,
    );
  });
});

describe('nav.ts Sessions item (DS8 PR3 item 5)', () => {
  it('points at /sessions', () => {
    const match = NAV_SRC.match(/\{ id: 'sessions',[^}]*\}/);
    expect(match?.[0]).toMatch(/route: '\/sessions'/);
  });

  it('sits after Activity, the other run-facing entry', () => {
    const ids = [...NAV_SRC.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids.indexOf('sessions')).toBe(ids.indexOf('activity') + 1);
  });
});

describe('App.vue activeId (nav highlighting)', () => {
  it('highlights work for task-detail, which has no route of its own in NAV_ITEMS', () => {
    expect(APP_SRC).toMatch(/route\.name === 'task-detail'\) return 'work'/);
  });

  it('falls back to matchPrefix when no exact route match exists', () => {
    expect(APP_SRC).toMatch(/it\.matchPrefix && route\.path\.startsWith\(it\.matchPrefix\)/);
  });

  it("matches a level-2 child's own route before falling back to the parent (operator decision 2026-10-05)", () => {
    expect(APP_SRC).toMatch(
      /const child = it\.children\?\.find\(\(c\) => c\.route === route\.path\);\s*\n\s*if \(child\) return child\.id;/,
    );
  });
});

describe('App.vue selectNav (nav highlighting)', () => {
  it('also resolves a level-2 child id, not only a top-level NAV_ITEMS id', () => {
    expect(APP_SRC).toMatch(
      /NAV_ITEMS\.flatMap\(\(it\) => it\.children \?\? \[\]\)\.find\(\(c\) => c\.id === id\)/,
    );
  });
});
