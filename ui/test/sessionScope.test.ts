// D-264's other half. `sessionScope(c)` on the server has read `?session` +
// `?lineage` since the CLI grew the same reading (D-263), and eleven routes
// spread it — but no page has ever sent either, so the widening the server
// implements has had no caller. These are the rules of the client half.
//
// Two of them are not taste calls:
//
//   - A `lineage` without a `session` is a 400 upstream ("a lineage is
//     resolved from a session, and every session at once is not one"). Here
//     it is not a runtime check, it is unrepresentable: SessionScope carries
//     `session` as a required field, so the pair the server refuses cannot be
//     built. readSessionScope() is the boundary that makes that true of the
//     URL bar too, and it is total — every value it returns is a request
//     /api/* accepts.
//
//   - Every session-taking fetch writes the pair through ONE helper. The
//     server's argument for that (app.ts) is that a widening flag cannot
//     afford to be lenient about its spelling; the client's is narrower and
//     harder: `session` and `lineage` are two params that mean one thing, and
//     a fetch written later that sets the first and forgets the second sends
//     a narrower scope than the operator selected, silently.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_SESSIONS,
  applySessionScope,
  readSessionScope,
  SCOPE_WIDTH_OPTIONS,
  SESSION_OPTION_CAP,
  SESSION_SCOPABLE_ROUTES,
  scopeWidth,
  sessionOptions,
  sessionScopeKey,
  WIDTH_LINEAGE,
  WIDTH_SESSION,
  withScopeWidth,
} from '../src/lib/sessionScope.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('lib/sessionScope.ts — readSessionScope', () => {
  it('reads no scope from a query that names no session', () => {
    expect(readSessionScope({})).toBeUndefined();
    expect(readSessionScope({ project: 'black-smith' })).toBeUndefined();
  });

  it('reads a bare session as the narrow scope', () => {
    expect(readSessionScope({ session: 'sess-a' })).toEqual({ session: 'sess-a' });
  });

  it('widens only on the exact spelling the server accepts', () => {
    expect(readSessionScope({ session: 'sess-a', lineage: 'true' })).toEqual({
      session: 'sess-a',
      lineage: true,
    });
    expect(readSessionScope({ session: 'sess-a', lineage: 'false' })).toEqual({
      session: 'sess-a',
    });
  });

  it('fails NARROW on a lineage it cannot read', () => {
    // The asymmetry is the point. Rendering less than was asked for is an
    // error the operator can see -- the width control reads "This session"
    // and one click fixes it. Rendering more is an error that looks like an
    // answer: a child wave's failure attributed to the parent session, with
    // nothing on screen saying the scope was widened on a guess.
    for (const lineage of ['yes', '1', '', 'TRUE', null, ['true'], 7]) {
      expect(readSessionScope({ session: 'sess-a', lineage })).toEqual({ session: 'sess-a' });
    }
  });

  it('drops a lineage that has no session to widen, rather than sending the 400', () => {
    // app.ts refuses this pair. The URL bar can produce it and has no caller
    // to tell, so the boundary absorbs it here instead of letting every page
    // on the route render a scope error.
    expect(readSessionScope({ lineage: 'true' })).toBeUndefined();
  });

  it('ignores an empty session, which is the all-sessions sentinel', () => {
    expect(readSessionScope({ session: ALL_SESSIONS })).toBeUndefined();
    expect(readSessionScope({ session: '' })).toBeUndefined();
  });

  it('ignores a repeated session param rather than picking one of them', () => {
    // `?session=a&session=b` is two answers to a single-choice control. Vue
    // Router hands it over as an array; guessing which half the operator
    // meant would be inventing a scope.
    expect(readSessionScope({ session: ['sess-a', 'sess-b'] })).toBeUndefined();
  });

  it('only ever returns a scope /api/* accepts', () => {
    const queries = [
      {},
      { session: 'sess-a' },
      { session: 'sess-a', lineage: 'true' },
      { session: 'sess-a', lineage: 'nonsense' },
      { lineage: 'true' },
      { session: '' },
    ];
    for (const query of queries) {
      const scope = readSessionScope(query);
      if (scope === undefined) continue;
      // The server's two refusals, restated as the invariant this function
      // owns: a lineage needs a session, and a session is never empty.
      expect(scope.session).not.toBe('');
      expect(scope.lineage === undefined || scope.lineage === true).toBe(true);
    }
  });
});

describe('lib/sessionScope.ts — applySessionScope', () => {
  it('writes nothing at all with no scope', () => {
    const q = new URLSearchParams();
    applySessionScope(q, undefined);
    expect(q.toString()).toBe('');
  });

  it('writes the session alone for the narrow scope', () => {
    const q = new URLSearchParams();
    applySessionScope(q, { session: 'sess-a' });
    expect(q.toString()).toBe('session=sess-a');
  });

  it('omits lineage=false, which is what the server defaults to anyway', () => {
    const q = new URLSearchParams();
    applySessionScope(q, { session: 'sess-a', lineage: false });
    expect(q.toString()).toBe('session=sess-a');
  });

  it('writes lineage=true in the one spelling the server reads', () => {
    const q = new URLSearchParams();
    applySessionScope(q, { session: 'sess-a', lineage: true });
    expect(q.get('lineage')).toBe('true');
  });

  it('leaves the other params on the query alone', () => {
    const q = new URLSearchParams();
    q.set('project', 'black-smith');
    applySessionScope(q, { session: 'sess-a', lineage: true });
    expect(q.get('project')).toBe('black-smith');
  });
});

describe('lib/sessionScope.ts — sessionScopeKey', () => {
  it('separates the two widths of one session', () => {
    // Pages watch this string, not the scope object: a computed rebuilding
    // {session} on every route change is a new reference each time, and a
    // watcher on it would re-fetch on an unrelated `?project=` edit.
    expect(sessionScopeKey({ session: 'sess-a' })).not.toBe(
      sessionScopeKey({ session: 'sess-a', lineage: true }),
    );
  });

  it('is stable across two equal scopes', () => {
    expect(sessionScopeKey({ session: 'sess-a', lineage: true })).toBe(
      sessionScopeKey({ session: 'sess-a', lineage: true }),
    );
  });

  it('gives the no-scope state a key of its own', () => {
    expect(sessionScopeKey(undefined)).toBe('');
    expect(sessionScopeKey(undefined)).not.toBe(sessionScopeKey({ session: 'sess-a' }));
  });
});

describe('lib/sessionScope.ts — the width control', () => {
  it('offers exactly the two widths app.ts implements', () => {
    expect(SCOPE_WIDTH_OPTIONS.map((o) => o.value)).toEqual([WIDTH_SESSION, WIDTH_LINEAGE]);
  });

  it('reads the width off the scope', () => {
    expect(scopeWidth({ session: 'sess-a' })).toBe(WIDTH_SESSION);
    expect(scopeWidth({ session: 'sess-a', lineage: true })).toBe(WIDTH_LINEAGE);
  });

  it('answers for the no-scope state rather than leaving the control blank', () => {
    // A <select> whose model-value is not among its options renders nothing
    // selected. The control is hidden without a session, but it must not be
    // the reason the shell has to know that.
    expect(SCOPE_WIDTH_OPTIONS.map((o) => o.value)).toContain(scopeWidth(undefined));
  });

  it('cannot be widened without a session to widen', () => {
    expect(withScopeWidth(undefined, WIDTH_LINEAGE)).toBeUndefined();
    expect(withScopeWidth(undefined, WIDTH_SESSION)).toBeUndefined();
  });

  it('round-trips every width it offers', () => {
    for (const option of SCOPE_WIDTH_OPTIONS) {
      const next = withScopeWidth({ session: 'sess-a' }, option.value);
      expect(scopeWidth(next)).toBe(option.value);
    }
  });

  it('narrows on a width it does not recognise', () => {
    // Same asymmetry as readSessionScope: an unreadable width is not a
    // licence to widen.
    expect(withScopeWidth({ session: 'sess-a', lineage: true }, 'sideways')).toEqual({
      session: 'sess-a',
    });
  });
});

function entry(sessionId: string, liveAgentCount = 0) {
  return { sessionId, liveAgentCount };
}

describe('lib/sessionScope.ts — sessionOptions', () => {
  it('offers the all-sessions escape hatch first, so a picker is never empty', () => {
    expect(sessionOptions([], ALL_SESSIONS)).toEqual([
      { value: ALL_SESSIONS, label: 'All sessions' },
    ]);
  });

  it('keeps the sessions in the order the overview reported them', () => {
    const options = sessionOptions([entry('sess-b'), entry('sess-a')], ALL_SESSIONS);
    expect(options.map((o) => o.value)).toEqual([ALL_SESSIONS, 'sess-b', 'sess-a']);
  });

  it('names the live agents under a session, which is what tells two apart', () => {
    // The operator's case is a screenful of dispatched wave-runners. An id
    // alone does not say which of them is still doing something.
    const options = sessionOptions([entry('sess-a', 3), entry('sess-b', 0)], ALL_SESSIONS);
    expect(options[1]).toEqual({ value: 'sess-a', label: 'sess-a · 3 live' });
    expect(options[2]).toEqual({ value: 'sess-b', label: 'sess-b' });
  });

  it('never emits two options with the same value', () => {
    const values = sessionOptions(
      [entry('sess-a'), entry('sess-a'), { sessionId: ALL_SESSIONS, liveAgentCount: 0 }],
      ALL_SESSIONS,
    ).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([ALL_SESSIONS, 'sess-a']);
  });

  it('caps the list, because every projected session is on it', () => {
    // runningSessions is every row in the `sessions` table, not the live
    // ones -- an old state dir has hundreds. A picker that long is a picker
    // nobody scrolls.
    const many = Array.from({ length: SESSION_OPTION_CAP + 20 }, (_, i) => entry(`sess-${i}`));
    const options = sessionOptions(many, ALL_SESSIONS);
    expect(options).toHaveLength(SESSION_OPTION_CAP + 1);
    expect(options[1]?.value).toBe('sess-0');
  });

  it('keeps the current selection selectable when the cap would drop it', () => {
    // D-43 again, one layer over: a <select> shows nothing selected for a
    // value it does not carry, so the control would read "All sessions"
    // while every page stayed filtered to sess-99 -- the picker lying about
    // the filter.
    const many = Array.from({ length: SESSION_OPTION_CAP + 20 }, (_, i) => entry(`sess-${i}`));
    const options = sessionOptions(many, `sess-${SESSION_OPTION_CAP + 5}`);
    expect(options.map((o) => o.value)).toContain(`sess-${SESSION_OPTION_CAP + 5}`);
  });

  it('keeps a selection the list does not know about at all', () => {
    // A session id typed into the URL, or one whose project scope no longer
    // shows it. Selectable, so it can be cleared.
    const options = sessionOptions([entry('sess-a')], 'sess-typed');
    expect(options.map((o) => o.value)).toEqual([ALL_SESSIONS, 'sess-a', 'sess-typed']);
  });

  it('does not repeat a selection the list already offers', () => {
    const values = sessionOptions([entry('sess-a')], 'sess-a').map((o) => o.value);
    expect(values).toEqual([ALL_SESSIONS, 'sess-a']);
  });
});

/** [route name, page component file] for every named route in router.ts. */
function routedPages(): [string, string][] {
  const src = readFileSync(join(SRC, 'router.ts'), 'utf8');
  const pairs = [...src.matchAll(/name:\s*'([\w-]+)',[\s\S]*?pages\/([\w.]+\.vue)/g)];
  return pairs.map((m) => [m[1] as string, m[2] as string]);
}

function readsSessionScope(pageFile: string): boolean {
  return readFileSync(join(SRC, 'pages', pageFile), 'utf8').includes('useSessionContext');
}

describe('D-264: the session picker is shown exactly where the scope is read', () => {
  // The same IFF that D-216 cost us for the project switcher, asserted before
  // it costs us anything: a picker on a page that ignores the scope is a
  // control that does nothing, and a page that reads a scope no control on it
  // can set is a filter the operator cannot clear.
  it('shows the picker on every route whose page reads the scope', () => {
    const shouldScope = routedPages()
      .filter(([, page]) => readsSessionScope(page))
      .map(([name]) => name);
    expect(shouldScope.filter((name) => !SESSION_SCOPABLE_ROUTES.has(name))).toEqual([]);
  });

  it('hides the picker on every route whose page ignores the scope', () => {
    const shouldNotScope = routedPages()
      .filter(([, page]) => !readsSessionScope(page))
      .map(([name]) => name);
    expect(shouldNotScope.filter((name) => SESSION_SCOPABLE_ROUTES.has(name))).toEqual([]);
  });

  it('names no route that router.ts does not define', () => {
    const known = new Set(routedPages().map(([name]) => name));
    expect([...SESSION_SCOPABLE_ROUTES].filter((name) => !known.has(name))).toEqual([]);
  });

  it('reaches at least the pages whose endpoints spread sessionScope(c)', () => {
    // Not one page per endpoint: roadmap and lessons take the param upstream
    // but read as repo-wide artifacts, the projects hub is the one page whose
    // job is to be above every scope, and /api/sessions is the picker's own
    // feed, which no page owns. Stated as a floor so a page cannot quietly
    // drop out of the set.
    for (const name of [
      'overview-global',
      'overview-project',
      'sessions',
      'timeline',
      'kanban',
      'flow',
      'errors',
      'analytics',
    ]) {
      expect([...SESSION_SCOPABLE_ROUTES]).toContain(name);
    }
  });
});

describe('every session-taking fetch sends the pair through applySessionScope', () => {
  const API = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8');
  /** Each `export function fetchX(...)` block, keyed by name. */
  const fetches = new Map<string, string>(
    API.split(/\nexport function /)
      .slice(1)
      .map((chunk) => [chunk.slice(0, chunk.indexOf('(')), chunk] as [string, string])
      .filter(([name]) => name.startsWith('fetch')),
  );
  const sessionTaking = [...fetches].filter(([, body]) => /\bsession\b/.test(body));

  it('finds the eleven fetches whose endpoint spreads sessionScope(c)', () => {
    expect(sessionTaking.map(([name]) => name).sort()).toEqual([
      'fetchAnalytics',
      'fetchErrors',
      'fetchFlow',
      'fetchKanban',
      'fetchLessons',
      'fetchOverview',
      'fetchProjects',
      'fetchPulse',
      'fetchRoadmap',
      // The picker's own feed. It never sends a session -- a list cut by the
      // selection it offers is a trapdoor -- but the route accepts one like
      // every other read, so the helper rule below binds it too.
      'fetchSessions',
      'fetchTimeline',
    ]);
  });

  for (const [name, body] of sessionTaking) {
    it(`${name} writes the scope through the helper, not by hand`, () => {
      expect(body).toContain('applySessionScope(');
      // The failure this stops is not a typo, it is a half-write: setting
      // `session` without `lineage` compiles, runs, returns data, and answers
      // a narrower question than the one on screen.
      expect(body).not.toContain("q.set('session'");
      expect(body).not.toContain("'?session=");
    });
  }
});
