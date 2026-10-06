import { describe, expect, it } from 'vitest';
import { groupFollowups } from '../src/lib/kanban.js';
import { storeKey } from '../src/lib/storeKey.js';

describe('storeKey', () => {
  it('keeps the bare id when a row has no store', () => {
    expect(storeKey({}, 'e1/t1')).toBe('e1/t1');
  });
  it('prefixes the store id so equal ids from two stores stay distinct', () => {
    const a = storeKey({ store: { id: 'home', label: 'home' } }, 'e1/t1');
    const b = storeKey({ store: { id: 'ab12cd34', label: 'project-b' } }, 'e1/t1');
    expect(a).toBe('home:e1/t1');
    expect(b).toBe('ab12cd34:e1/t1');
    expect(a).not.toBe(b);
  });
});

describe('groupFollowups across stores', () => {
  const task = (store: string, taskId: string, parent: string | null) => ({
    taskId,
    store: { id: store, label: store },
    parentTaskId: parent,
    parentTitle: null,
    updatedAt: '2026-01-01T00:00:00Z',
  });
  it('does not stack follow-ups of equal parent ids from different stores', () => {
    const items = groupFollowups(
      [task('home', 'e1/f1', 'e1/t1'), task('b', 'e1/f1', 'e1/t1')] as never[],
      'done',
    );
    expect(items.map((i) => i.kind)).toEqual(['task', 'task']);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });
});
