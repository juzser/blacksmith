import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const APP_SRC = readFileSync(join(SRC_DIR, 'App.vue'), 'utf8');
const NAV_SRC = readFileSync(join(SRC_DIR, 'nav.ts'), 'utf8');

describe('nav.ts Work item', () => {
  it('points at /work/kanban and carries a /work matchPrefix', () => {
    const match = NAV_SRC.match(/\{ id: 'work',[^}]*\}/);
    expect(match?.[0]).toMatch(/route: '\/work\/kanban'/);
    expect(match?.[0]).toMatch(/matchPrefix: '\/work'/);
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
});
