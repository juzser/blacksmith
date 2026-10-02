// router.ts's own routes execute createWebHistory() at import time, which
// needs `window` — unavailable under the DOM-free `environment: node`
// Vitest config (same limit projectScope.test.ts already works around by
// reading source text instead of importing the module).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'router.ts'),
  'utf8',
);

/** [route name, route object body] for every named route, in source order. */
function routeBodies(): [string, string][] {
  const names = [...SRC.matchAll(/name:\s*'([\w-]+)'/g)].map((m) => m[1] as string);
  const chunks = SRC.split(/name:\s*'[\w-]+'/).slice(1);
  return names.map((name, i) => [name, chunks[i] as string]);
}

describe('router.ts meta.crumb', () => {
  it('gives every named route a meta.crumb, derived from the route not a fetch', () => {
    for (const [name, body] of routeBodies()) {
      expect(body, `route ${name} is missing meta: { crumb }`).toMatch(/meta:\s*\{\s*crumb:/);
    }
  });

  it('renames the shell routes to their SidebarNav labels', () => {
    const byName = new Map(routeBodies());
    expect(byName.get('overview-global')).toMatch(/crumb: \(\) => \[\{ label: 'Home' \}\]/);
    expect(byName.get('work-kanban')).toMatch(/crumb: \(\) => \[\{ label: 'Work' \}\]/);
    expect(byName.get('work-roadmap')).toMatch(/crumb: \(\) => \[\{ label: 'Work' \}\]/);
    expect(byName.get('timeline')).toMatch(/crumb: \(\) => \[\{ label: 'Activity' \}\]/);
    expect(byName.get('analytics')).toMatch(/crumb: \(\) => \[\{ label: 'Cost & quality' \}\]/);
    expect(byName.get('lessons')).toMatch(/crumb: \(\) => \[\{ label: 'Lessons' \}\]/);
  });

  it('derives task-detail crumb from route params, not page data', () => {
    const byName = new Map(routeBodies());
    const body = byName.get('task-detail') ?? '';
    expect(body).toMatch(/label: 'Work', to: '\/work\/kanban'/);
    expect(body).toMatch(/label: String\(r\.params\.taskId\)/);
  });
});

describe('router.ts Home (ds-spec.md §4.1)', () => {
  it('renders HomePage on both Overview routes and no longer routes to Overview or Projects pages', () => {
    const byName = new Map(routeBodies());
    expect(byName.get('overview-global')).toMatch(/pages\/HomePage\.vue/);
    expect(byName.get('overview-project')).toMatch(/pages\/HomePage\.vue/);
    expect(SRC).not.toMatch(/OverviewPage|ProjectsPage/);
  });

  it('redirects / and /projects through homeRedirect, keeping the deep-link query', () => {
    expect(SRC).toMatch(/\{ path: '\/', redirect: homeRedirect \}/);
    expect(SRC).toMatch(/\{ path: '\/projects', redirect: homeRedirect \}/);
  });
});
