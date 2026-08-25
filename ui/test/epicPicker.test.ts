// The epic picker is a control two pages share and neither can test: it is
// built inline in a .vue template, the one layer neither tsc nor biome reads
// here. D-222 was the fetch behind it; these hold the control itself.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_EPICS,
  EPIC_LIST_UNAVAILABLE,
  epicOptions,
  retainedEpic,
} from '../src/lib/epicPicker.js';

describe('lib/epicPicker.ts — epicOptions', () => {
  it('offers the all-epics escape hatch first, so a picker is never empty', () => {
    expect(epicOptions([])).toEqual([{ value: ALL_EPICS, label: 'All epics' }]);
  });

  it('keeps the epics in the order the overview reported them', () => {
    expect(epicOptions(['epic-9', 'epic-1']).map((o) => o.value)).toEqual([
      ALL_EPICS,
      'epic-9',
      'epic-1',
    ]);
  });

  it('labels each epic by its id', () => {
    expect(epicOptions(['epic-9'])[1]).toEqual({ value: 'epic-9', label: 'epic-9' });
  });

  it('never emits two options with the same value', () => {
    // <option :key="opt.value">, and the v-model is the value — a second
    // option carrying the sentinel would collide on both.
    const values = epicOptions(['epic-9', 'epic-9', ALL_EPICS]).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([ALL_EPICS, 'epic-9']);
  });
});

describe('lib/epicPicker.ts — retainedEpic', () => {
  it('keeps a selection the new list still offers', () => {
    expect(retainedEpic('epic-9', ['epic-9', 'epic-10'])).toBe('epic-9');
  });

  it('drops a selection the new list does not offer', () => {
    // The control would show "All epics" for an option it does not have while
    // the page stayed filtered to epic-1 — the picker lying about the filter.
    expect(retainedEpic('epic-1', ['epic-9', 'epic-10'])).toBe(ALL_EPICS);
  });

  it('leaves the all-epics sentinel alone, including against an empty list', () => {
    expect(retainedEpic(ALL_EPICS, ['epic-9'])).toBe(ALL_EPICS);
    expect(retainedEpic(ALL_EPICS, [])).toBe(ALL_EPICS);
  });

  it('drops every selection when the new project has no epics at all', () => {
    expect(retainedEpic('epic-1', [])).toBe(ALL_EPICS);
  });

  it('agrees with epicOptions about what is selectable', () => {
    // The two are one control: anything retainedEpic keeps has to be an
    // option, or the <select> renders a selection it does not carry.
    const epics = ['epic-9', 'epic-10'];
    const values = epicOptions(epics).map((o) => o.value);
    for (const candidate of ['epic-9', 'epic-1', ALL_EPICS]) {
      expect(values).toContain(retainedEpic(candidate, epics));
    }
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
function page(name: string): string {
  return readFileSync(join(HERE, '..', 'src', 'pages', name), 'utf8');
}

describe('the epic-picker pages source their control and their fetch guard from lib', () => {
  for (const name of ['KanbanPage.vue', 'FlowPage.vue']) {
    it(`${name} builds its options through epicOptions()`, () => {
      const src = page(name);
      expect(src).toContain('epicOptions(');
      expect(src).not.toContain("label: 'All epics'");
    });

    it(`${name} reports an epic list it could not load`, () => {
      // Rendered through the shared constant, not a copy of its wording: two
      // pages telling the operator different things about the same failure is
      // the drift this test exists to stop.
      const src = page(name);
      expect(src).toContain('EPIC_LIST_UNAVAILABLE');
      expect(src).not.toContain(EPIC_LIST_UNAVAILABLE);
    });
  }
});
