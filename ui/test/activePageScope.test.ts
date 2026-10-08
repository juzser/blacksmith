import { describe, expect, it } from 'vitest';
import { resolveActivePageScope } from '../src/composables/useActivePageScope.js';
import type { ActiveScopeResult } from '../src/lib/api.js';

const measured = (over: Partial<ActiveScopeResult> = {}): ActiveScopeResult => ({
  measured: true,
  readAt: '2026-10-07T12:00:00.000Z',
  liveSessions: 1,
  unlinkedSessions: 0,
  projects: [],
  epics: [],
  factorySessions: [{ storeId: 'home', sessionId: 'sess-a' }],
  ...over,
});
const base = { scope: 'active' as const, explicit: false, active: measured(), settled: true };

describe('resolveActivePageScope', () => {
  it('an explicit filter wins: no sessions, no toggle', () => {
    const r = resolveActivePageScope({ ...base, explicit: true });
    expect(r).toMatchObject({ mode: 'explicit', fetchable: true, showToggle: false });
    expect(r.sessions).toBeUndefined();
  });

  it('All fetches without sessions and shows the toggle', () => {
    const r = resolveActivePageScope({ ...base, scope: 'all' });
    expect(r).toMatchObject({ mode: 'all', fetchable: true, showToggle: true });
    expect(r.sessions).toBeUndefined();
  });

  it('Active holds while the scope is in flight, and fetches nothing', () => {
    const r = resolveActivePageScope({ ...base, active: null, settled: false });
    expect(r).toMatchObject({ mode: 'loading', fetchable: false });
  });

  it('Active with a failed read is unmeasured: fetch All, with the note', () => {
    for (const active of [null, measured({ measured: false })]) {
      const r = resolveActivePageScope({ ...base, active, settled: true });
      expect(r).toMatchObject({ mode: 'unmeasured', fetchable: true, showToggle: true });
      expect(r.sessions).toBeUndefined();
    }
  });

  it('Active past the 200-id cap falls back to unmeasured, never a truncated list', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ storeId: 'home', sessionId: `s${i}` }));
    expect(
      resolveActivePageScope({ ...base, active: measured({ factorySessions: many }) }).mode,
    ).toBe('unmeasured');
  });

  it('Active with home ids narrows to them', () => {
    const r = resolveActivePageScope({ ...base });
    expect(r).toMatchObject({ mode: 'narrowed', fetchable: true, sessions: ['sess-a'] });
  });

  it('Active, measured, no home session: empty, with the matching edge line', () => {
    const none = resolveActivePageScope({
      ...base,
      active: measured({ liveSessions: 0, factorySessions: [] }),
    });
    expect(none).toMatchObject({ mode: 'empty', fetchable: false, edge: 'nothing-live' });
    const unlinked = resolveActivePageScope({
      ...base,
      active: measured({ liveSessions: 2, unlinkedSessions: 2, factorySessions: [] }),
    });
    expect(unlinked.edge).toBe('none-on-epic');
    const elsewhere = resolveActivePageScope({
      ...base,
      active: measured({ factorySessions: [{ storeId: 'store-b', sessionId: 'f1' }] }),
    });
    expect(elsewhere).toMatchObject({ mode: 'empty', edge: 'none-here' });
  });

  it('the key moves with the mode and the id set, not with a fresh object', () => {
    const a = resolveActivePageScope({ ...base });
    const b = resolveActivePageScope({ ...base, active: measured({ readAt: 'later' }) });
    const c = resolveActivePageScope({
      ...base,
      active: measured({ factorySessions: [{ storeId: 'home', sessionId: 'sess-b' }] }),
    });
    expect(b.key).toBe(a.key);
    expect(c.key).not.toBe(a.key);
    expect(resolveActivePageScope({ ...base, scope: 'all' }).key).not.toBe(a.key);
  });
});
