import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, h, nextTick } from 'vue';
import type { ActiveScopeResult } from '../src/lib/api.js';

// A renderer with no-op node ops: enough to run setup() inside a real
// component instance in the node environment.
const nodeOps = {
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp() {},
} as never;

function scopeWith(liveSessions: number): ActiveScopeResult {
  return {
    measured: true,
    readAt: '2026-10-07T12:00:00.000Z',
    liveSessions,
    unlinkedSessions: 0,
    projects: [],
    epics: [],
    factorySessions: [],
  };
}

describe('useActiveScope watcher lifetime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps refreshing after the first caller component unmounts', async () => {
    let n = 0;
    const fetchActiveScope = vi.fn(async () => scopeWith(++n));
    vi.doMock('../src/lib/api.js', async (orig) => ({
      ...(await orig<typeof import('../src/lib/api.js')>()),
      fetchActiveScope,
    }));
    const { useActiveScope } = await import('../src/composables/useActiveScope.js');
    const { pulseTick } = await import('../src/composables/usePulse.js');
    const { createApp } = createRenderer(nodeOps);
    const app = createApp(
      defineComponent({
        setup() {
          useActiveScope();
          return () => h('div');
        },
      }),
    );
    app.mount({} as never);
    await vi.waitFor(() => expect(fetchActiveScope).toHaveBeenCalledTimes(1));
    app.unmount();

    pulseTick.value += 1;
    await nextTick();
    await vi.waitFor(() => expect(fetchActiveScope).toHaveBeenCalledTimes(2));

    const later = useActiveScope();
    await vi.waitFor(() => expect(later.scope.value?.liveSessions).toBe(2));
  });
});
