// `page.getByLabel('Epic')` also matches `<section aria-label="All epics
// lane">`. Playwright's label match is a case-insensitive *substring* by
// default, so a short label is contained in every longer one on the page and
// the locator resolves to two elements the moment the second one renders.
//
// That makes it a race rather than a failure: whether it bites depends on
// whether the board has painted by the time the locator resolves. kanban's
// "All epics" test passed on every developer machine and failed on CI, which
// is the worst version of the bug — green where it was watched, red where it
// was not, and the diff that went red had not touched the UI at all.
//
// Six of the suite's ten label locators already carried `exact: true`, so the
// rule was known; it just was not written down anywhere that could enforce
// it. This is the enforcement, and it is a source scan rather than another
// Playwright test on purpose: the ambiguity is only observable while the
// colliding element happens to be on screen, so no run of the suite can be
// trusted to reveal it. Reading the call is the only way to be sure.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E = join(HERE, '..', 'e2e');

interface LabelCall {
  where: string;
  /** The argument list, from the opening paren to the one that closes it. */
  args: string;
}

/**
 * The argument list of the call starting at `from`, followed across line
 * breaks until its parentheses balance.
 *
 * Balancing rather than "this line plus the next" because that heuristic can
 * pass a bare call whose following line happens to carry an unrelated
 * `exact: true` — a scan that reports a violation it cannot see is worse than
 * no scan. Naive about parens inside string literals, which can only make the
 * span longer than it should be; the assertion below reads a fixed token out
 * of it, so a long span over-reports rather than under-reports.
 */
function argsFrom(lines: string[], line: number, from: number): string {
  let depth = 0;
  let out = '';
  for (let i = line; i < lines.length; i++) {
    const text = i === line ? (lines[i] ?? '').slice(from) : (lines[i] ?? '');
    for (const ch of text) {
      out += ch;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return out;
      }
    }
  }
  return out;
}

/** Every `getByLabel(...)` call in the suite, with the file and line it opens on. */
function labelLocators(): LabelCall[] {
  const found: LabelCall[] = [];
  for (const name of readdirSync(E2E).sort()) {
    if (!name.endsWith('.ts')) continue;
    const lines = readFileSync(join(E2E, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = line.indexOf('getByLabel(');
      if (at === -1) return;
      found.push({
        where: `${name}:${i + 1}`,
        args: argsFrom(lines, i, at + 'getByLabel'.length),
      });
    });
  }
  return found;
}

describe('e2e label locators', () => {
  it('finds the locators it is meant to be checking', () => {
    // A scan that silently matches nothing is a green test about nothing.
    // This is the floor: the suite does have label locators to check.
    expect(labelLocators().length).toBeGreaterThan(5);
  });

  it('every getByLabel is exact, so a short label cannot match a longer one', () => {
    const loose = labelLocators()
      // A regex argument is exempt: `exact` has no effect on one, and writing
      // the pattern is already the deliberate statement about how much of the
      // label has to match.
      .filter(({ args }) => !args.startsWith('(/'))
      .filter(({ args }) => !args.includes('exact: true'))
      .map(({ where, args }) => `${where}: getByLabel${args}`);
    expect(loose).toEqual([]);
  });
});
