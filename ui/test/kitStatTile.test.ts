// StatTile (ds-spec.md §4.1 item 1): one read-only figure, the Analytics
// phone tile lifted into the kit. Same static source-text style as
// kitSkeleton.test.ts: ui/vitest.config.ts is DOM-free by design, and the
// call sites are pinned by vueContract.test.ts against componentApi().
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { componentApi } from './sfc';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '..', 'src', 'components', 'kit', 'StatTile.vue');
const SRC = readFileSync(FILE, 'utf8');
const TEMPLATE = SRC.slice(SRC.indexOf('<template>'));
const CSS = readFileSync(join(HERE, '..', 'src', 'styles', 'bs-primitives.css'), 'utf8');

/** Declarations of the first top-level rule for `selector`, comments dropped. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const body = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  expect(body, selector).toBeTruthy();
  return (body ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The bodies of every `@media <query> {…}` block, braces balanced. */
function mediaBlocks(css: string, query: string): string[] {
  const out: string[] = [];
  const head = `@media ${query} {`;
  let at = css.indexOf(head);
  while (at >= 0) {
    let depth = 1;
    let i = at + head.length;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(at + head.length, i - 1));
    at = css.indexOf(head, i);
  }
  return out;
}

/** `selector`'s declarations inside the `query` block that names it. */
function mediaRule(query: string, selector: string): string {
  const block = mediaBlocks(CSS, query).find((b) =>
    new RegExp(`(?:^|\\s)\\${selector}\\s*\\{`).test(b),
  );
  expect(block, `${query} ${selector}`).toBeTruthy();
  return rule(`\n${(block ?? '').replace(/^\s+/gm, '')}`, selector);
}

describe('kit/StatTile.vue', () => {
  it('takes a label and a value, with helper, quiet, floor and loading optional', () => {
    const api = componentApi(SRC, FILE);
    expect([...api.props].sort()).toEqual(
      ['floor', 'helper', 'label', 'loading', 'quiet', 'value'].sort(),
    );
    expect([...api.requiredProps].sort()).toEqual(['label', 'value']);
    expect(api.emits).toEqual([]);
  });

  it('renders one tile of a <dl>: a div holding a dt label, a dd value and a dd helper', () => {
    expect(TEMPLATE).toMatch(
      /^<template>\s*<div class="bs-stat">\s*<dt class="bs-stat__label">\{\{ label \}\}<\/dt>\s*<dd\s[^>]*class="bs-stat__value"/,
    );
    expect(TEMPLATE).toMatch(/<dd v-if="helper" class="bs-stat__helper">\{\{ helper \}\}<\/dd>/);
  });

  it('shows a floor as an aria-hidden "≥" and reads it as "at least"', () => {
    expect(TEMPLATE).toMatch(
      /<template v-if="floor"><span aria-hidden="true">≥<\/span><span class="sr-only">at least <\/span><\/template>\{\{ value \}\}/,
    );
  });

  it('stands a kit Skeleton in for the value while loading, one value line tall', () => {
    expect(SRC).toMatch(/import Skeleton from '\.\/Skeleton\.vue';/);
    expect(TEMPLATE).toMatch(
      /<Skeleton v-if="loading" [^>]*height="var\(--bs-leading-xl\)"[^>]*\/>\s*<template v-else>/,
    );
  });

  it('reads a word in the value slot quieter than a figure', () => {
    expect(TEMPLATE).toMatch(/:class="\{ 'bs-stat__value--nd': quiet \}"/);
    const nd = rule(CSS, '.bs-stat__value--nd');
    expect(nd).toMatch(/font-weight:\s*var\(--bs-font-weight-normal\);/);
    expect(nd).toMatch(/color:\s*var\(--bs-text-subtle\);/);
  });

  it('is plain information: no link, no button, nothing to click', () => {
    expect(TEMPLATE).not.toMatch(/<a\b|<button|RouterLink|@click|v-on|tabindex/);
    expect(SRC).not.toMatch(/defineEmits/);
  });
});

describe('.bs-stat-grid and .bs-stat (bs-primitives.css)', () => {
  it('lays four tiles across, 16px apart, with no <dl> margin', () => {
    const grid = rule(CSS, '.bs-stat-grid');
    expect(grid).toMatch(/display:\s*grid;/);
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
    expect(grid).toMatch(/gap:\s*var\(--bs-space-4\);/);
    expect(grid).toMatch(/margin:\s*0;/);
  });

  it('turns into a 2×2 grid, 8px apart, at 900px and below', () => {
    const grid = mediaRule('(max-width: 900px)', '.bs-stat-grid');
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(grid).toMatch(/gap:\s*var\(--bs-space-2\);/);
  });

  it('draws the tile from tokens: border, radius, raised surface, 16px padding', () => {
    const tile = rule(CSS, '.bs-stat');
    expect(tile).toMatch(/border:\s*1px solid var\(--bs-border\);/);
    expect(tile).toMatch(/border-radius:\s*var\(--bs-radius-md\);/);
    expect(tile).toMatch(/background:\s*var\(--bs-surface-raised\);/);
    expect(tile).toMatch(/padding:\s*var\(--bs-space-4\);/);
    expect(tile).toMatch(/min-width:\s*0;/);
  });

  it('sets the value large, semibold and tabular, and lets a long one wrap anywhere', () => {
    const value = rule(CSS, '.bs-stat__value');
    expect(value).toMatch(/font-size:\s*var\(--bs-text-xl\);/);
    expect(value).toMatch(/font-weight:\s*var\(--bs-font-weight-semibold\);/);
    expect(value).toMatch(/font-variant-numeric:\s*tabular-nums;/);
    expect(value).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(value).toMatch(/margin:/);
  });

  it('sets the helper small and subtle', () => {
    const helper = rule(CSS, '.bs-stat__helper');
    expect(helper).toMatch(/font-size:\s*var\(--bs-text-xs\);/);
    expect(helper).toMatch(/color:\s*var\(--bs-text-subtle\);/);
    expect(helper).toMatch(/margin:\s*0;/);
  });

  it('on phone pads the tile like a phone card, sets the value smaller and drops the helper', () => {
    expect(mediaRule('(max-width: 640px)', '.bs-stat')).toMatch(
      /padding:\s*var\(--bs-m-card-pad\);/,
    );
    expect(mediaRule('(max-width: 640px)', '.bs-stat__value')).toMatch(
      /font-size:\s*var\(--bs-text-lg\);/,
    );
    expect(mediaRule('(max-width: 640px)', '.bs-stat__helper')).toMatch(/display:\s*none;/);
  });
});
