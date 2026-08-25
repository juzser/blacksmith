import { describe, expect, it } from 'vitest';
import { topoSort, waveLayers } from '../src/graph.js';

describe('waveLayers (Phase 6b Flow page)', () => {
  it('nodes with no dependencies are wave 0', () => {
    const waves = waveLayers(['a', 'b', 'c'], []);
    expect([...waves.values()]).toEqual([0, 0, 0]);
  });

  it('a chain increments one wave per link', () => {
    const waves = waveLayers(
      ['t1', 't2', 't3'],
      [
        { task: 't2', dependsOn: 't1' },
        { task: 't3', dependsOn: 't2' },
      ],
    );
    expect(waves.get('t1')).toBe(0);
    expect(waves.get('t2')).toBe(1);
    expect(waves.get('t3')).toBe(2);
  });

  it('parallel branches of equal length land in the same wave', () => {
    const waves = waveLayers(
      ['root', 'left', 'right', 'join'],
      [
        { task: 'left', dependsOn: 'root' },
        { task: 'right', dependsOn: 'root' },
        { task: 'join', dependsOn: 'left' },
        { task: 'join', dependsOn: 'right' },
      ],
    );
    expect(waves.get('root')).toBe(0);
    expect(waves.get('left')).toBe(1);
    expect(waves.get('right')).toBe(1);
    expect(waves.get('join')).toBe(2);
  });

  it('a node takes the longest of multiple dependency paths, not the shortest', () => {
    const waves = waveLayers(
      ['a', 'b', 'c', 'd'],
      [
        { task: 'c', dependsOn: 'a' }, // short path: a -> c (wave 1)
        { task: 'b', dependsOn: 'a' },
        { task: 'c', dependsOn: 'b' }, // long path: a -> b -> c (wave 2)
        { task: 'd', dependsOn: 'c' },
      ],
    );
    expect(waves.get('c')).toBe(2); // longest path wins, not the short a->c edge
    expect(waves.get('d')).toBe(3);
  });

  it('returns an empty map for cyclic input rather than throwing', () => {
    const waves = waveLayers(
      ['a', 'b'],
      [
        { task: 'a', dependsOn: 'b' },
        { task: 'b', dependsOn: 'a' },
      ],
    );
    expect(waves.size).toBe(0);
  });
});

describe('topoSort', () => {
  it('orders independent nodes lexicographically', () => {
    const result = topoSort(['c', 'a', 'b'], []);
    expect(result).toEqual({ ok: true, order: ['a', 'b', 'c'] });
  });

  it('respects a simple dependency chain', () => {
    const result = topoSort(
      ['task-2', 'task-1', 'task-3'],
      [
        { task: 'task-2', dependsOn: 'task-1' },
        { task: 'task-3', dependsOn: 'task-2' },
      ],
    );
    expect(result).toEqual({ ok: true, order: ['task-1', 'task-2', 'task-3'] });
  });

  it('tie-breaks by task id among simultaneously-ready nodes', () => {
    const result = topoSort(
      ['z', 'y', 'x', 'root'],
      [
        { task: 'z', dependsOn: 'root' },
        { task: 'y', dependsOn: 'root' },
        { task: 'x', dependsOn: 'root' },
      ],
    );
    expect(result).toEqual({ ok: true, order: ['root', 'x', 'y', 'z'] });
  });

  it('detects a direct cycle', () => {
    const result = topoSort(
      ['a', 'b'],
      [
        { task: 'a', dependsOn: 'b' },
        { task: 'b', dependsOn: 'a' },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cycle.sort()).toEqual(['a', 'b']);
  });

  it('detects an indirect (longer) cycle', () => {
    const result = topoSort(
      ['a', 'b', 'c'],
      [
        { task: 'a', dependsOn: 'b' },
        { task: 'b', dependsOn: 'c' },
        { task: 'c', dependsOn: 'a' },
      ],
    );
    expect(result.ok).toBe(false);
  });

  it('ignores edges referencing nodes outside the set', () => {
    const result = topoSort(['a'], [{ task: 'a', dependsOn: 'ghost' }]);
    expect(result).toEqual({ ok: true, order: ['a'] });
  });
});
