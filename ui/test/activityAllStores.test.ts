// Activity reads every store: the client half. Pure helpers and query strings
// run for real; TimelineRow and ActivityPage are checked as source text because
// ui/vitest.config.ts has no DOM (same contract as the kitTimelineRow* files).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveActivePageScope } from '../src/composables/useActivePageScope.js';
import { activeSessionIds } from '../src/lib/activeScope.js';
import { type ActiveScopeResult, fetchErrors, fetchTimelinePage } from '../src/lib/api.js';
import { sessionDividerBefore } from '../src/lib/timelineDisplay.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const scope: ActiveScopeResult = {
  measured: true,
  readAt: '2026-10-07T12:00:00.000Z',
  liveSessions: 2,
  unlinkedSessions: 0,
  projects: [],
  epics: [],
  factorySessions: [
    { storeId: 'home', sessionId: 'sess-a' },
    { storeId: 'ab12cd34', sessionId: 'sess-a' },
  ],
};

describe('activeSessionIds', () => {
  it('qualifies every store session so a reused id stays apart', () => {
    expect(activeSessionIds(scope)).toEqual(['ab12cd34/sess-a', 'home/sess-a']);
  });

  it('is null when unmeasured and empty when nothing is live', () => {
    expect(activeSessionIds(null)).toBeNull();
    expect(activeSessionIds({ ...scope, measured: false })).toBeNull();
    expect(activeSessionIds({ ...scope, factorySessions: [] })).toEqual([]);
  });
});

describe('resolveActivePageScope allStores', () => {
  const base = { scope: 'active' as const, explicit: false, active: scope, settled: true };

  it('hands over qualified ids from every store', () => {
    const r = resolveActivePageScope({ ...base, allStores: true });
    expect(r.mode).toBe('narrowed');
    expect(r.sessions).toEqual(['ab12cd34/sess-a', 'home/sess-a']);
  });

  it('without the option keeps the served store bare ids only', () => {
    expect(resolveActivePageScope(base).sessions).toEqual(['sess-a']);
  });
});

describe('timeline and errors query strings', () => {
  const urls: string[] = [];
  afterEach(() => vi.unstubAllGlobals());
  const stub = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(u);
        return { ok: true, json: async () => ({}) };
      }),
    );
  const q = (u: string | undefined) => new URL(u as string, 'http://x').searchParams;

  it('writes stores=all and store=<id> only when asked', async () => {
    urls.length = 0;
    stub();
    await fetchTimelinePage({ limit: 5, stores: 'all' });
    await fetchTimelinePage({ limit: 5, store: 'ab12cd34' });
    await fetchTimelinePage({ limit: 5 });
    await fetchErrors(undefined, undefined, undefined, 'all');
    await fetchErrors(undefined, undefined, undefined, undefined, 'ab12cd34');
    await fetchErrors();
    expect(q(urls[0]).get('stores')).toBe('all');
    expect(q(urls[0]).has('store')).toBe(false);
    expect(q(urls[1]).get('store')).toBe('ab12cd34');
    expect(q(urls[2]).toString()).not.toMatch(/store/);
    expect(q(urls[3]).get('stores')).toBe('all');
    expect(q(urls[4]).get('store')).toBe('ab12cd34');
    expect(urls[5]).toBe('/api/errors');
  });
});

describe('sessionDividerBefore across stores', () => {
  const row = (store: string, sessionId: string) =>
    ({ sessionId, store: { id: store, label: store } }) as Parameters<
      typeof sessionDividerBefore
    >[0][number];

  it('divides when the store changes even if the session id repeats', () => {
    const rows = [row('home', 's1'), row('ab12cd34', 's1'), row('ab12cd34', 's1')];
    expect(sessionDividerBefore(rows, 1)).toBe(true);
    expect(sessionDividerBefore(rows, 2)).toBe(false);
  });
});

describe('TimelineRow store-aware contract', () => {
  const row = read('components', 'kit', 'TimelineRow.vue');

  it('keys its ids and emits by storeKey, and tells selectTask which store', () => {
    expect(row).toContain('storeKey(props.entry, props.entry.eventId)');
    expect(row).toContain(':id="`activity-row-$' + '{rowKey}`"');
    expect(row).toContain("emit('toggle', rowKey)");
    expect(row).toContain("emit('selectTask', entry.taskId, store)");
    expect(row).toContain("emit('becauseOf', storeKey(props.entry, promptId))");
  });

  it('carries the foreign store on the Session link', () => {
    expect(row).toMatch(/\.\.\.\(store\.value \? \{ store: store\.value \} : \{\}\)/);
  });
});

describe('ActivityPage reads every store', () => {
  const page = read('pages', 'ActivityPage.vue');

  it('asks for all stores when no filter is explicit, one store when the URL names it', () => {
    expect(page).toContain('{ allStores: true }');
    expect(page).toContain("{ stores: 'all' as const }");
    expect(page).toContain('{ store: storeFilter.value }');
  });

  it('no longer prints the other-store line', () => {
    expect(page).not.toMatch(/otherStores/);
  });
});

describe('project naming in a multi-project feed', () => {
  const row = read('components', 'kit', 'TimelineRow.vue');
  const page = read('pages', 'ActivityPage.vue');

  it('shows a Project pair before Task only when the opt-in prop is set and a project exists', () => {
    expect(row).toContain('showProject?: boolean');
    expect(row).toMatch(
      /v-if="showProject && entry\.project"[\s\S]*<dt>Project<\/dt>[\s\S]*<dt>Task<\/dt>/,
    );
  });

  it('computes multi-project once, labels dividers with it and opens the feed with a divider', () => {
    expect(page).toContain('isMultiProjectFeed(entries.value)');
    expect(page).toContain('sessionDividerText(item.entry!, multiProject)');
    expect(page).toContain(':show-project="multiProject"');
    expect(page).toContain('firstRowKey');
  });
});
