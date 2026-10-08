// Sessions reads every store: the client half. The query strings and the
// selection helpers run for real; SessionsPage is checked as source text
// because ui/vitest.config.ts has no DOM (same contract as
// analyticsAllStores.test.ts).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActiveScopeResult, fetchSessionAgents, fetchSessions } from '../src/lib/api.js';
import {
  isSessionActive,
  isStaleResponse,
  selectedSessionFromQuery,
  sessionsInScope,
} from '../src/lib/sessionsSelection.js';
import { storeKey } from '../src/lib/storeKey.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = readFileSync(join(SRC, 'pages', 'SessionsPage.vue'), 'utf8');

const home = { id: 'home', label: 'home' };
const other = { id: 'ab12cd34', label: 'project-b' };
type Row = { sessionId: string; store: { id: string; label: string } };
const rows: Row[] = [
  { sessionId: 'sess-a', store: home },
  { sessionId: 'sess-a', store: other },
  { sessionId: 'sess-b', store: other },
];

describe('query strings', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('fetchSessions writes stores=all and fetchSessionAgents writes store, only when asked', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(u);
        return { ok: true, json: async () => ({}) };
      }),
    );
    await fetchSessions(undefined, undefined, 'all');
    await fetchSessions();
    await fetchSessionAgents('sess-a', undefined, 'ab12cd34');
    await fetchSessionAgents('sess-a');
    expect(urls).toEqual([
      '/api/sessions?stores=all',
      '/api/sessions',
      '/api/sessions/sess-a/agents?store=ab12cd34',
      '/api/sessions/sess-a/agents',
    ]);
  });
});

describe('a session id that repeats between stores', () => {
  it('selects by the id and store pair, and no store means the home store', () => {
    expect(selectedSessionFromQuery({ session: 'sess-a' }, rows)).toBe(
      storeKey(rows[0] as Row, 'sess-a'),
    );
    expect(selectedSessionFromQuery({ session: 'sess-a', store: 'ab12cd34' }, rows)).toBe(
      storeKey(rows[1] as Row, 'sess-a'),
    );
    // sess-b lives only in the other store: the home reading of the link finds nothing.
    expect(selectedSessionFromQuery({ session: 'sess-b' }, rows)).toBeNull();
    expect(selectedSessionFromQuery({ session: 'sess-a', store: 'zz' }, rows)).toBeNull();
  });

  it('pins only the selected store copy in Active', () => {
    const live: ActiveScopeResult = {
      measured: true,
      readAt: '',
      liveSessions: 0,
      unlinkedSessions: 0,
      projects: [],
      epics: [],
      factorySessions: [],
    };
    const shown = sessionsInScope(rows, 'active', storeKey(rows[1] as Row, 'sess-a'), live);
    expect(shown).toEqual([rows[1]]);
  });

  it('goes stale per store: the same id in another store is not the selection', () => {
    const selected = storeKey(rows[1] as Row, 'sess-a');
    expect(isStaleResponse(storeKey(rows[0] as Row, 'sess-a'), selected)).toBe(true);
    expect(isStaleResponse(storeKey(rows[1] as Row, 'sess-a'), selected)).toBe(false);
  });

  it('counts a foreign session as active when the active scope names it', () => {
    const live: ActiveScopeResult = {
      measured: true,
      readAt: '',
      liveSessions: 1,
      unlinkedSessions: 0,
      projects: [],
      epics: [],
      factorySessions: [{ storeId: 'ab12cd34', sessionId: 'sess-a' }],
    };
    expect(isSessionActive(live, rows[1] as Row)).toBe(true);
    expect(isSessionActive(live, rows[0] as Row)).toBe(false);
  });
});

describe('SessionsPage', () => {
  it('asks every store, and asks a foreign session for its roster with its store', () => {
    expect(page).toContain("fetchSessions(undefined, project.value, 'all')");
    expect(page).toContain('fetchSessionAgents(sel.sessionId, project.value, foreignStoreId(sel))');
  });

  it('keys the selection, row refs and staleness by storeKey', () => {
    expect(page).toContain('storeKey(s, s.sessionId)');
    expect(page).toContain('groupRowRef(group.project, storeKey(s, s.sessionId))');
  });

  it('writes the store beside the session only for a foreign one', () => {
    expect(page).toContain('const store = foreignStoreId(row);');
    expect(page).toContain('...(store ? { store } : {})');
  });

  it('no longer prints the other-store line', () => {
    expect(page).not.toMatch(/otherStore/);
    expect(page).not.toContain('another store');
  });
});
