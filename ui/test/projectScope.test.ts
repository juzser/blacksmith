import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCOPABLE_ROUTES } from '../src/lib/projectScope.js';

// D-216. The topbar project switcher is the ONLY control that sets the scope
// these pages read, so "which routes show it" and "which pages call
// useProjectContext()" are the same list stated twice. This derives the
// second list from the sources instead of restating it, so adding a page
// that reads the scope — or dropping the read from one that does — fails
// here rather than shipping a page whose scope cannot be set or cleared.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** [route name, page component file] for every named route in router.ts. */
function routedPages(): [string, string][] {
  const src = readFileSync(join(SRC, 'router.ts'), 'utf8');
  // `name` always precedes `component` inside a route object, so a lazy
  // match pairs each name with its own page and never the next one's.
  const pairs = [...src.matchAll(/name:\s*'([\w-]+)',[\s\S]*?pages\/([\w.]+\.vue)/g)];
  return pairs.map((m) => [m[1] as string, m[2] as string]);
}

function readsProjectScope(pageFile: string): boolean {
  return readFileSync(join(SRC, 'pages', pageFile), 'utf8').includes('useProjectContext');
}

describe('D-216: the project switcher is shown exactly where the scope is read', () => {
  it('parses every named route in router.ts', () => {
    const names = routedPages().map(([name]) => name);
    // The redirect-only '/' route carries no name, so it is absent by design.
    expect(names).toEqual([
      'projects',
      'overview-global',
      'overview-project',
      'sessions',
      'timeline',
      'kanban',
      'roadmap',
      'flow',
      'lessons',
      'errors',
      'analytics',
      'task-detail',
    ]);
  });

  it('shows the switcher on every route whose page reads the scope', () => {
    const shouldScope = routedPages()
      .filter(([, page]) => readsProjectScope(page))
      .map(([name]) => name);
    const missing = shouldScope.filter((name) => !SCOPABLE_ROUTES.has(name));
    expect(missing).toEqual([]);
  });

  it('hides the switcher on every route whose page ignores the scope', () => {
    const shouldNotScope = routedPages()
      .filter(([, page]) => !readsProjectScope(page))
      .map(([name]) => name);
    const shown = shouldNotScope.filter((name) => SCOPABLE_ROUTES.has(name));
    expect(shown).toEqual([]);
  });

  it('names no route that router.ts does not define', () => {
    const known = new Set(routedPages().map(([name]) => name));
    expect([...SCOPABLE_ROUTES].filter((name) => !known.has(name))).toEqual([]);
  });
});
