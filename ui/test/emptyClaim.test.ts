import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canClaimEmpty } from '../src/lib/emptyClaim.js';

describe('canClaimEmpty', () => {
  it('lets a landed fetch report emptiness', () => {
    expect(canClaimEmpty(true, 0)).toBe(true);
  });

  it('refuses to call zero "empty" before the fetch lands', () => {
    // The whole point. Every list ref in this app starts at length 0, so a
    // fetch that failed and a database that is empty are the same number.
    expect(canClaimEmpty(false, 0)).toBe(false);
  });

  it('is false whenever there is something to show', () => {
    expect(canClaimEmpty(true, 1)).toBe(false);
    expect(canClaimEmpty(false, 1)).toBe(false);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'src', 'pages');

/**
 * The tag plus its attributes, across newlines — every one of these is written
 * multi-line in the pages, so a line-anchored match would read only the first
 * attribute and call the rest of the tag unconditional.
 */
const EMPTY_STATE_TAG = /<EmptyState\b[\s\S]*?>/g;
const CONDITION = /\sv-(?:if|else-if)="([^"]*)"/;
/** A condition that counts: `xs.length === 0`, `count === 0`, `!xs.length`. */
const COUNTS = /\.length|===\s*0|!==\s*0/;

describe('no page claims emptiness from a fetch that never landed', () => {
  // A page's list ref is empty before its first response and empty after a
  // failed one, so an empty state chained off the count alone renders "No
  // errors logged yet." on the strength of a request that never answered
  // (D-226). `canClaimEmpty` is where that distinction lives; this is the
  // gate that keeps the next page from skipping it. .vue templates are read
  // by neither tsc nor biome here, so nothing else would catch it.
  const guards: Array<{ file: string; condition: string }> = [];
  for (const name of readdirSync(PAGES).filter((n) => n.endsWith('.vue'))) {
    const src = readFileSync(join(PAGES, name), 'utf8');
    for (const tag of src.match(EMPTY_STATE_TAG) ?? []) {
      const condition = tag.match(CONDITION)?.[1];
      // `v-else` carries no condition of its own: it inherits the chain's,
      // and the branch above it is the one that had to wait for the data.
      if (condition === undefined) continue;
      guards.push({ file: name, condition });
    }
  }

  it('finds the guards at all, so a rename cannot make this test vacuous', () => {
    expect(guards.length).toBeGreaterThan(8);
  });

  for (const { file, condition } of guards.filter((g) => COUNTS.test(g.condition))) {
    it(`${file}: ${condition}`, () => {
      expect(condition).toContain('canClaimEmpty(');
    });
  }
});
