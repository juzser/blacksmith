import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KANBAN_DISPLAY_OPTIONS,
  hasChosenKanbanGroupBy,
  type KanbanDisplayOptionsStorage,
  loadKanbanDisplayOptions,
  saveKanbanDisplayOptions,
} from '../src/lib/kanbanDisplayOptions.js';

// DS3 pattern 8 — localStorage is never touched directly: every call site
// takes a storage param so these are plain node-environment unit tests, no
// jsdom/localStorage polyfill needed.
function memoryStorage(initial: Record<string, string> = {}): KanbanDisplayOptionsStorage {
  const store = { ...initial };
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

function throwingStorage(): KanbanDisplayOptionsStorage {
  return {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
  };
}

describe('lib/kanbanDisplayOptions.ts — loadKanbanDisplayOptions()', () => {
  it('returns the hardcoded default when nothing is stored', () => {
    expect(loadKanbanDisplayOptions(memoryStorage())).toEqual(DEFAULT_KANBAN_DISPLAY_OPTIONS);
  });

  it('returns the stored value when present and well-formed', () => {
    const stored = { summary: false, groupBy: 'project' as const, hidden: ['Completed'] };
    const storage = memoryStorage({ 'bs.kanban.displayOptions': JSON.stringify(stored) });
    expect(loadKanbanDisplayOptions(storage)).toEqual(stored);
  });

  it('falls back to the default on malformed JSON', () => {
    const storage = memoryStorage({ 'bs.kanban.displayOptions': '{not json' });
    expect(loadKanbanDisplayOptions(storage)).toEqual(DEFAULT_KANBAN_DISPLAY_OPTIONS);
  });

  it('falls back to the default when a stored field has the wrong shape', () => {
    const storage = memoryStorage({
      'bs.kanban.displayOptions': JSON.stringify({ summary: 'yes', groupBy: 'status', hidden: [] }),
    });
    expect(loadKanbanDisplayOptions(storage)).toEqual(DEFAULT_KANBAN_DISPLAY_OPTIONS);
  });

  it('falls back to the default when storage access throws', () => {
    expect(loadKanbanDisplayOptions(throwingStorage())).toEqual(DEFAULT_KANBAN_DISPLAY_OPTIONS);
  });
});

describe('lib/kanbanDisplayOptions.ts — saveKanbanDisplayOptions()', () => {
  it('round-trips through the same storage', () => {
    const storage = memoryStorage();
    const options = { summary: false, groupBy: 'epic' as const, hidden: ['Todo'] };
    saveKanbanDisplayOptions(storage, options);
    expect(loadKanbanDisplayOptions(storage)).toEqual(options);
  });

  it('does not throw when storage access throws', () => {
    expect(() =>
      saveKanbanDisplayOptions(throwingStorage(), DEFAULT_KANBAN_DISPLAY_OPTIONS),
    ).not.toThrow();
  });
});

describe('lib/kanbanDisplayOptions.ts — hasChosenKanbanGroupBy()', () => {
  it('is false with nothing stored or storage throwing', () => {
    expect(hasChosenKanbanGroupBy(memoryStorage())).toBe(false);
    expect(hasChosenKanbanGroupBy(throwingStorage())).toBe(false);
  });

  it('stays false after a Summary toggle, which saves the default Group by', () => {
    const storage = memoryStorage();
    saveKanbanDisplayOptions(storage, { ...DEFAULT_KANBAN_DISPLAY_OPTIONS, summary: false });
    expect(hasChosenKanbanGroupBy(storage)).toBe(false);
  });

  it('is true for an options object saved by an older build with a non-default Group by', () => {
    const storage = memoryStorage({
      'bs.kanban.displayOptions': JSON.stringify({ summary: true, groupBy: 'project', hidden: [] }),
    });
    expect(hasChosenKanbanGroupBy(storage)).toBe(true);
    expect(loadKanbanDisplayOptions(storage).groupBy).toBe('project');
  });

  it('is false for a malformed stored value', () => {
    expect(hasChosenKanbanGroupBy(memoryStorage({ 'bs.kanban.displayOptions': '{nope' }))).toBe(
      false,
    );
  });
});
