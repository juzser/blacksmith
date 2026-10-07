import { describe, expect, it } from 'vitest';
import {
  type ActiveScopeCli,
  type ActiveScopeStore,
  computeActiveScope,
} from '../src/activeScope.js';

const NOW = '2026-10-07T12:00:00.000Z';

function store(over: Partial<ActiveScopeStore> & { id?: string; label?: string } = {}) {
  return {
    store: { id: over.id ?? 'home', label: over.label ?? 'home' },
    activelyRunning: over.activelyRunning ?? [],
    epicProjects: over.epicProjects ?? {},
  } satisfies ActiveScopeStore;
}

type LinkedIn = ActiveScopeCli['sessions'][number]['linked'];
function linkedEpic(over: Record<string, unknown> = {}) {
  return {
    store: { id: 'home', label: 'home' },
    epicId: 'epic-a',
    project: 'project-a',
    factorySessionIds: ['f1'],
    factorySessionLastEventAt: {} as Record<string, string>,
    workingAgents: [] as { role: string; taskId: string | null; since: string }[],
    ...over,
  };
}
function session(linked: unknown, over: Record<string, unknown> = {}) {
  return {
    cliSessionId: 'c1',
    startedAt: '2026-10-07T10:00:00.000Z',
    cwdLabel: 'project-a',
    linked: linked as LinkedIn,
    ...over,
  };
}
function cli(sessions: unknown[], state: ActiveScopeCli['state'] = 'ok'): ActiveScopeCli {
  return { state, readAt: NOW, sessions: sessions as ActiveScopeCli['sessions'] };
}
const fold = (c: ActiveScopeCli, stores: ActiveScopeStore[]) => computeActiveScope(c, stores, NOW);

describe('computeActiveScope', () => {
  it('a live session linked to a closed epic activates nothing', () => {
    const out = fold(cli([session({ epics: [linkedEpic()] })]), [store({ activelyRunning: [] })]);
    expect(out.measured).toBe(true);
    expect(out.liveSessions).toBe(1);
    expect(out.projects).toEqual([]);
    expect(out.epics).toEqual([]);
    expect(out.factorySessions).toEqual([]);
  });

  it('a linked epic idle over 7 days is not active (it is absent from the running set)', () => {
    const out = fold(cli([session({ epics: [linkedEpic({ epicId: 'epic-idle' })] })]), [
      store({ activelyRunning: ['epic-a'] }),
    ]);
    expect(out.epics).toEqual([]);
    expect(out.projects).toEqual([]);
  });

  it('an unlinked session whose cwdLabel is a project name activates nothing', () => {
    const out = fold(cli([session(null, { cwdLabel: 'project-a' })]), [
      store({ activelyRunning: ['epic-a'], epicProjects: { 'epic-a': 'project-a' } }),
    ]);
    expect(out.unlinkedSessions).toBe(1);
    expect(out.liveSessions).toBe(1);
    expect(out.projects).toEqual([]);
  });

  it('a foreign-store epic is keyed by its store; null project falls back to the overview then the label', () => {
    const foreign = { id: 'st-b', label: 'project-b' };
    const out = fold(
      cli([
        session({
          epics: [
            linkedEpic({ store: foreign, epicId: 'epic-b', project: null }),
            linkedEpic({ store: foreign, epicId: 'epic-c', project: null }),
          ],
        }),
      ]),
      [
        store({
          id: 'st-b',
          label: 'project-b',
          activelyRunning: ['epic-b', 'epic-c'],
          epicProjects: { 'epic-b': 'project-mapped' },
        }),
        store({ activelyRunning: ['epic-b'] }),
      ],
    );
    expect(out.epics).toEqual([
      { storeId: 'st-b', epicId: 'epic-b', project: 'project-mapped' },
      { storeId: 'st-b', epicId: 'epic-c', project: 'project-b' },
    ]);
    expect(out.projects.map((p) => [p.storeId, p.project]).sort()).toEqual([
      ['st-b', 'project-b'],
      ['st-b', 'project-mapped'],
    ]);
  });

  it('epicId null with a project activates the project only', () => {
    const out = fold(cli([session({ epics: [linkedEpic({ epicId: null })] })]), [store()]);
    expect(out.epics).toEqual([]);
    expect(out.projects).toEqual([
      { storeId: 'home', project: 'project-a', liveSessions: 1, agentsWorking: 0 },
    ]);
  });

  it.each(['absent', 'unreadable'] as const)(
    'state %s is unmeasured, never "nothing active"',
    (state) => {
      const out = fold(cli([session({ epics: [linkedEpic()] })], state), [
        store({ activelyRunning: ['epic-a'] }),
      ]);
      expect(out).toEqual({
        measured: false,
        readAt: NOW,
        liveSessions: 0,
        unlinkedSessions: 0,
        projects: [],
        epics: [],
        factorySessions: [],
      });
    },
  );

  it('factorySessions drops lineage members older than the CLI session; none qualifying keeps the newest', () => {
    const ids = ['f-old', 'f-new', 'f-mid'];
    const factorySessionLastEventAt = {
      'f-old': '2026-10-07T09:00:00.000Z',
      'f-new': '2026-10-07T11:00:00.000Z',
      'f-mid': '2026-10-07T10:30:00.000Z',
    };
    const run = (startedAt: string) =>
      fold(
        cli([
          session(
            { epics: [linkedEpic({ factorySessionIds: ids, factorySessionLastEventAt })] },
            { startedAt },
          ),
        ]),
        [store({ activelyRunning: ['epic-a'] })],
      ).factorySessions.map((f) => f.sessionId);
    expect(run('2026-10-07T10:00:00.000Z').sort()).toEqual(['f-mid', 'f-new']);
    expect(run('2026-10-07T11:30:00.000Z')).toEqual(['f-new']);
  });

  it('a member this CLI session wrote before it started does not count, whoever wrote it last', () => {
    const out = fold(
      cli([
        session(
          {
            epics: [
              linkedEpic({
                factorySessionIds: ['m1', 'm2'],
                factorySessionLastEventAt: {
                  m1: '2026-10-07T09:00:00.000Z',
                  m2: '2026-10-07T11:00:00.000Z',
                },
              }),
            ],
          },
          { startedAt: '2026-10-07T10:00:00.000Z' },
        ),
      ]),
      [store({ activelyRunning: ['epic-a'] })],
    );
    expect(out.factorySessions.map((f) => f.sessionId)).toEqual(['m2']);
  });

  it('a member with no known time never displaces one that has a time', () => {
    const out = fold(
      cli([
        session(
          {
            epics: [
              linkedEpic({
                factorySessionIds: ['a', 'b'],
                factorySessionLastEventAt: { a: '2026-10-07T09:00:00.000Z' },
              }),
            ],
          },
          { startedAt: '2026-10-07T10:00:00.000Z' },
        ),
      ]),
      [store({ activelyRunning: ['epic-a'] })],
    );
    expect(out.factorySessions.map((f) => f.sessionId)).toEqual(['a']);
  });

  it('with no time known for any member, the last one listed is the newest', () => {
    const out = fold(
      cli([
        session(
          { epics: [linkedEpic({ factorySessionIds: ['b', 'c'], factorySessionLastEventAt: {} })] },
          { startedAt: '2026-10-07T10:00:00.000Z' },
        ),
      ]),
      [store({ activelyRunning: ['epic-a'] })],
    );
    expect(out.factorySessions.map((f) => f.sessionId)).toEqual(['c']);
  });

  it('two live sessions on one project make one entry; a shared working agent counts once', () => {
    const agent = { role: 'coder', taskId: 't1', since: '2026-10-07T11:00:00.000Z' };
    const out = fold(
      cli([
        session({ epics: [linkedEpic({ workingAgents: [agent] })] }, { cliSessionId: 'c1' }),
        session(
          { epics: [linkedEpic({ workingAgents: [agent, { ...agent, taskId: 't2' }] })] },
          { cliSessionId: 'c2' },
        ),
      ]),
      [store({ activelyRunning: ['epic-a'] })],
    );
    expect(out.projects).toEqual([
      { storeId: 'home', project: 'project-a', liveSessions: 2, agentsWorking: 2 },
    ]);
    expect(out.epics).toEqual([{ storeId: 'home', epicId: 'epic-a', project: 'project-a' }]);
  });

  it('the body carries no prompt, doingNow, transcript, cwd or name keys at any depth', () => {
    const out = fold(
      cli([
        session(
          { epics: [linkedEpic({ prompt: 'x', name: 'n', transcript: 't', cwd: '/c' })] },
          {
            name: 'secret',
            cwd: '/abs/path',
            doingNow: { prompt: 'secret prompt' },
            prompt: 'p',
            transcript: 'tt',
          },
        ),
      ]),
      [store({ activelyRunning: ['epic-a'] })],
    );
    const keys: string[] = [];
    JSON.stringify(out, (k, v) => {
      keys.push(k);
      return v;
    });
    for (const banned of ['prompt', 'doingNow', 'transcript', 'cwd', 'name', 'cwdLabel']) {
      expect(keys).not.toContain(banned);
    }
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});
