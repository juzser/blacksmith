import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { isActiveEpic, isActiveProject, isActiveSession } from '../src/lib/activeScope.js';
import type { ActiveScopeResult } from '../src/lib/api.js';

const scope: ActiveScopeResult = {
  measured: true,
  readAt: '2026-10-07T12:00:00.000Z',
  liveSessions: 2,
  unlinkedSessions: 0,
  projects: [{ storeId: 'home', project: 'project-a', liveSessions: 1, agentsWorking: 0 }],
  epics: [{ storeId: 'home', epicId: 'epic-a', project: 'project-a' }],
  factorySessions: [{ storeId: 'st-b', sessionId: 'f1' }],
};
const home = { store: { id: 'home', label: 'home' } };
const other = { store: { id: 'st-b', label: 'project-b' } };

describe('active-scope predicates', () => {
  it('match by storeKey, so a same-id epic in two stores is told apart', () => {
    expect(isActiveEpic(scope, home, 'epic-a')).toBe(true);
    expect(isActiveEpic(scope, other, 'epic-a')).toBe(false);
    expect(isActiveEpic(scope, home, 'epic-z')).toBe(false);
    expect(isActiveProject(scope, home, 'project-a')).toBe(true);
    expect(isActiveProject(scope, other, 'project-a')).toBe(false);
    expect(isActiveSession(scope, other, 'f1')).toBe(true);
    expect(isActiveSession(scope, home, 'f1')).toBe(false);
  });

  it('a row without a store reads as the home store', () => {
    expect(isActiveEpic(scope, {}, 'epic-a')).toBe(true);
  });

  it('an unmeasured or missing scope is never active', () => {
    expect(isActiveEpic({ ...scope, measured: false }, home, 'epic-a')).toBe(false);
    expect(isActiveEpic(null, home, 'epic-a')).toBe(false);
  });
});

describe('useActiveScope', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('two callers share one fetch per pulse tick', async () => {
    const fetchActiveScope = vi.fn(async () => scope);
    vi.doMock('../src/lib/api.js', async (orig) => ({
      ...(await orig<typeof import('../src/lib/api.js')>()),
      fetchActiveScope,
    }));
    const { useActiveScope } = await import('../src/composables/useActiveScope.js');
    const { pulseTick } = await import('../src/composables/usePulse.js');
    const a = useActiveScope();
    const b = useActiveScope();
    await vi.waitFor(() => expect(a.scope.value).toEqual(scope));
    expect(b.scope).toBe(a.scope);
    expect(fetchActiveScope).toHaveBeenCalledTimes(1);
    pulseTick.value += 1;
    await nextTick();
    await vi.waitFor(() => expect(fetchActiveScope).toHaveBeenCalledTimes(2));
    await nextTick();
    expect(fetchActiveScope).toHaveBeenCalledTimes(2);
  });

  it('reload() re-reads once; a reload during an in-flight read runs one more read after it', async () => {
    let release: () => void = () => {};
    let gate = false;
    const fetchActiveScope = vi.fn(async () => {
      if (gate) await new Promise<void>((r) => (release = r));
      return scope;
    });
    vi.doMock('../src/lib/api.js', async (orig) => ({
      ...(await orig<typeof import('../src/lib/api.js')>()),
      fetchActiveScope,
    }));
    const { useActiveScope } = await import('../src/composables/useActiveScope.js');
    const a = useActiveScope();
    await vi.waitFor(() => expect(a.scope.value).toEqual(scope));
    expect(fetchActiveScope).toHaveBeenCalledTimes(1);
    await a.reload();
    expect(fetchActiveScope).toHaveBeenCalledTimes(2);
    gate = true;
    const first = a.reload();
    await vi.waitFor(() => expect(fetchActiveScope).toHaveBeenCalledTimes(3));
    const second = a.reload();
    const third = a.reload();
    expect(fetchActiveScope).toHaveBeenCalledTimes(3);
    gate = false;
    release();
    await Promise.all([first, second, third]);
    expect(fetchActiveScope).toHaveBeenCalledTimes(4);
  });
});
