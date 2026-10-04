import { describe, expect, it } from 'vitest';
import { loadExpanded, saveExpanded, toggleExpanded } from '../src/lib/expandedRows.js';

// DS6 PR3 scope item 3: TimelineRow's "Show details" open state survives a
// reload (sessionStorage), keyed per-page so Activity and a task's history
// tab don't fight over the same ids.
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe('lib/expandedRows.ts', () => {
  it('loads an empty set when nothing was ever saved', () => {
    expect(loadExpanded(fakeStorage(), 'activity')).toEqual(new Set());
  });

  it('round-trips a saved set', () => {
    const storage = fakeStorage();
    saveExpanded(storage, 'activity', new Set(['ev-1', 'ev-2']));
    expect(loadExpanded(storage, 'activity')).toEqual(new Set(['ev-1', 'ev-2']));
  });

  it('ignores corrupt JSON rather than throwing', () => {
    const storage = fakeStorage();
    storage.setItem('bs-activity-expanded:activity', 'not json');
    expect(loadExpanded(storage, 'activity')).toEqual(new Set());
  });

  it('toggleExpanded adds an id that was absent', () => {
    expect(toggleExpanded(new Set(['a']), 'b')).toEqual(new Set(['a', 'b']));
  });

  it('toggleExpanded removes an id that was present', () => {
    expect(toggleExpanded(new Set(['a', 'b']), 'b')).toEqual(new Set(['a']));
  });
});
