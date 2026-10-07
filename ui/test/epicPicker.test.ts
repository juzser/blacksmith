// The epic picker is a control two pages share and neither can test: it is
// built inline in a .vue template, the one layer neither tsc nor biome reads
// here. D-222 was the fetch behind it; these hold the control itself.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActiveScopeResult } from '../src/lib/api.js';
import {
  ALL_EPICS,
  activeSelection,
  EPIC_LIST_UNAVAILABLE,
  epicOptions,
  idleLabel,
  idleLabelsById,
  pickerSelection,
  retainedEpic,
  withIdleLabels,
} from '../src/lib/epicPicker.js';

describe('lib/epicPicker.ts — idle epics', () => {
  it('words the idle label as whole days', () => {
    expect(idleLabel(18)).toBe('idle 18d');
  });

  it('suffixes an idle epic option, and only that one, keeping its value', () => {
    const options = epicOptions(['epic-1', 'epic-2'], [{ epicId: 'epic-2', idleDays: 18 }]);
    expect(options[1]).toEqual({ value: 'epic-1', label: 'epic-1' });
    expect(options[2]).toEqual({ value: 'epic-2', label: 'epic-2 · idle 18d' });
  });
});

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
  for (const name of ['KanbanPage.vue']) {
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

describe('idle labels on lists that are not the picker', () => {
  it('maps only idle epics to their label', () => {
    const labels = idleLabelsById([{ epicId: 'epic-a', idleDays: 18 }]);
    expect(labels).toEqual({ 'epic-a': 'idle 18d' });
    expect(labels['epic-b']).toBeUndefined();
  });

  it('appends the label to an idle epic option and keeps every other option as it was', () => {
    const labels = idleLabelsById([{ epicId: 'epic-a', idleDays: 18 }]);
    const options = [
      { value: '', label: 'Pick an epic' },
      { value: 'epic-a', label: 'epic-a' },
      { value: 'epic-b', label: 'epic-b' },
    ];
    expect(withIdleLabels(options, labels)).toEqual([
      { value: '', label: 'Pick an epic' },
      { value: 'epic-a', label: 'epic-a · idle 18d' },
      { value: 'epic-b', label: 'epic-b' },
    ]);
  });

  it('does not read an inherited property as a label', () => {
    expect(withIdleLabels([{ value: 'constructor', label: 'constructor' }], {})).toEqual([
      { value: 'constructor', label: 'constructor' },
    ]);
  });
});

describe('pickerSelection()', () => {
  const options = [{ value: 'epic-a', label: 'epic-a' }];

  it('keeps a selection that is among the options', () => {
    expect(pickerSelection('epic-a', options)).toBe('epic-a');
  });

  it('falls back to the placeholder value when the selection belongs to another section', () => {
    expect(pickerSelection('epic-z', options)).toBe('');
  });
});

describe('RoadmapProjectSection.vue picker value', () => {
  it('passes the effective selection, not the page-wide one, to the select', () => {
    const sfc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'components',
        'RoadmapProjectSection.vue',
      ),
      'utf8',
    );
    expect(sfc).toMatch(/:model-value="effectivePickerValue"/);
  });
});

describe('activeSelection()', () => {
  const scopeOf = (epics: { storeId: string; epicId: string }[], measured = true) =>
    ({
      measured,
      readAt: '',
      liveSessions: epics.length,
      unlinkedSessions: 0,
      projects: [],
      epics: epics.map((e) => ({ ...e, project: null })),
      factorySessions: [],
    }) as ActiveScopeResult;
  const home = { id: 'home', label: 'home' };
  const other = { id: 'store-b', label: 'store-b' };
  // epic-b is idle and epic-c closed: neither is in `scope.epics`.
  const list = ['epic-a', 'epic-b', 'epic-c'];
  const inFlight = [
    { epicId: 'epic-a', store: home },
    { epicId: 'epic-b', store: home },
  ];
  const scope = scopeOf([{ storeId: 'home', epicId: 'epic-a' }]);

  it('keeps only the epics a live session drives; idle and closed ones are absent', () => {
    expect(activeSelection(list, inFlight, scope, 'active', '')).toEqual(['epic-a']);
  });

  it('matches through the epic store, not by id alone', () => {
    const tags = [
      { epicId: 'epic-a', store: home },
      { epicId: 'epic-a', store: other },
    ];
    const only = (storeId: string) => scopeOf([{ storeId, epicId: 'epic-a' }]);
    expect(activeSelection(['epic-a'], tags, only('store-b'), 'active', '')).toEqual(['epic-a']);
    expect(
      activeSelection(
        ['epic-a'],
        [{ epicId: 'epic-a', store: home }],
        only('store-b'),
        'active',
        '',
      ),
    ).toEqual([]);
  });

  it('counts an untagged in-flight epic as the home store', () => {
    expect(activeSelection(['epic-a'], [{ epicId: 'epic-a' }], scope, 'active', '')).toEqual([
      'epic-a',
    ]);
  });

  it("returns today's list, unchanged, under All", () => {
    expect(activeSelection(list, inFlight, scope, 'all', '')).toEqual(list);
  });

  it('keeps a pinned epic that is not active, and ignores a pin the overview does not know', () => {
    expect(activeSelection(list, inFlight, scope, 'active', 'epic-b')).toEqual([
      'epic-a',
      'epic-b',
    ]);
    expect(activeSelection(list, inFlight, scope, 'active', 'epic-zzz')).toEqual(['epic-a']);
  });

  it('never answers "nothing active" for an unmeasured or missing scope', () => {
    expect(activeSelection(list, inFlight, scopeOf([], false), 'active', '')).toEqual(list);
    expect(activeSelection(list, inFlight, null, 'active', '')).toEqual(list);
  });
});

describe('epicOptions() without the all-epics choice', () => {
  it('lists only the epics, idle label kept', () => {
    expect(epicOptions(['epic-a', 'epic-b'], [{ epicId: 'epic-b', idleDays: 9 }], false)).toEqual([
      { value: 'epic-a', label: 'epic-a' },
      { value: 'epic-b', label: 'epic-b · idle 9d' },
    ]);
  });
});
