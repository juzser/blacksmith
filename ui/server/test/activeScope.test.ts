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
    tokens: over.tokens ?? {},
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
    progress: null,
    ...over,
  };
}
function session(linked: unknown, over: Record<string, unknown> = {}) {
  return {
    cliSessionId: 'c1',
    startedAt: '2026-10-07T10:00:00.000Z',
    cwdLabel: 'project-a',
    subagentsRunning: 0,
    tokens: { used: 0, complete: true },
    linked: linked as LinkedIn,
    ...over,
  };
}
function cli(sessions: unknown[], state: ActiveScopeCli['state'] = 'ok'): ActiveScopeCli {
  return { state, readAt: NOW, sessions: sessions as ActiveScopeCli['sessions'] };
}
const fold = (c: ActiveScopeCli, stores: ActiveScopeStore[]) => computeActiveScope(c, stores, NOW);
const NO_SPEND = { tokensSpent: 0, tokensUnmeasured: 0, tasksDone: 0, tasksTotal: 0 };
const counts = (
  done: number,
  review: number,
  inProgress: number,
  todo: number,
  superseded = 0,
) => ({
  done,
  review,
  inProgress,
  todo,
  superseded,
});

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
      { storeId: 'st-b', epicId: 'epic-b', project: 'project-mapped', ...NO_SPEND },
      { storeId: 'st-b', epicId: 'epic-c', project: 'project-b', ...NO_SPEND },
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
      {
        storeId: 'home',
        project: 'project-a',
        liveSessions: 1,
        agentsWorking: 0,
        activeSessions: 0,
        agentsRunning: 0,
        agentsUnmeasured: 0,
        tokensSpent: 0,
        tokensUnmeasured: 0,
      },
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
        activeSessions: 0,
        agentsRunning: 0,
        agentsUnmeasured: 0,
        tokensSpent: 0,
        tokensUnmeasured: 0,
        tasksDone: 0,
        tasksTotal: 0,
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
      {
        storeId: 'home',
        project: 'project-a',
        liveSessions: 2,
        agentsWorking: 2,
        activeSessions: 2,
        agentsRunning: 2,
        agentsUnmeasured: 0,
        tokensSpent: 0,
        tokensUnmeasured: 0,
      },
    ]);
    expect(out.epics).toEqual([
      { storeId: 'home', epicId: 'epic-a', project: 'project-a', ...NO_SPEND },
    ]);
  });

  describe('an epic the running set does not hold (no task rows yet)', () => {
    const agent = { role: 'researcher', taskId: null, since: '2026-10-07T11:00:00.000Z' };
    const taskless = (over: Record<string, unknown> = {}) =>
      linkedEpic({
        factorySessionIds: ['f1'],
        factorySessionLastEventAt: { f1: '2026-10-07T11:00:00.000Z' },
        workingAgents: [agent],
        closed: false,
        ...over,
      });

    it('is active when this CLI session wrote into it since it started, within the idle window', () => {
      const out = fold(cli([session({ epics: [taskless()] })]), [store({ activelyRunning: [] })]);
      expect(out.epics).toEqual([
        { storeId: 'home', epicId: 'epic-a', project: 'project-a', ...NO_SPEND },
      ]);
      expect(out.factorySessions).toEqual([{ storeId: 'home', sessionId: 'f1' }]);
      expect(out.projects).toEqual([
        {
          storeId: 'home',
          project: 'project-a',
          liveSessions: 1,
          agentsWorking: 1,
          activeSessions: 1,
          agentsRunning: 1,
          agentsUnmeasured: 0,
          tokensSpent: 0,
          tokensUnmeasured: 0,
        },
      ]);
      expect(out.unlinkedSessions).toBe(0);
    });

    it('is not active when this CLI session wrote into it only before it started', () => {
      const out = fold(
        cli([
          session({
            epics: [taskless({ factorySessionLastEventAt: { f1: '2026-10-07T09:00:00.000Z' } })],
          }),
        ]),
        [store({ activelyRunning: [] })],
      );
      expect(out.epics).toEqual([]);
      expect(out.factorySessions).toEqual([]);
      expect(out.projects).toEqual([]);
    });

    it('is not active when its newest write since start is older than the idle window', () => {
      const run = (at: string) =>
        fold(
          cli([
            session(
              { epics: [taskless({ factorySessionLastEventAt: { f1: at } })] },
              { startedAt: '2026-09-20T00:00:00.000Z' },
            ),
          ]),
          [store({ activelyRunning: [] })],
        ).epics.map((e) => e.epicId);
      // NOW is 2026-10-07T12:00Z: exactly 7 days back is still inside, as for
      // the overview's idle rule; a millisecond more is outside.
      expect(run('2026-09-30T12:00:00.000Z')).toEqual(['epic-a']);
      expect(run('2026-09-30T11:59:59.999Z')).toEqual([]);
      expect(run('2026-09-29T11:00:00.000Z')).toEqual([]);
    });

    it('is not active when the store closed it, even with a fresh write', () => {
      const out = fold(cli([session({ epics: [taskless({ closed: true })] })]), [
        store({ activelyRunning: [] }),
      ]);
      expect(out.epics).toEqual([]);
      expect(out.factorySessions).toEqual([]);
      expect(out.projects).toEqual([]);
    });

    it.each([null, 'not-a-time'])(
      'is not active by a fresh write when startedAt is %s',
      (startedAt) => {
        const out = fold(cli([session({ epics: [taskless()] }, { startedAt })]), [
          store({ activelyRunning: [] }),
        ]);
        expect(out.epics).toEqual([]);
        expect(out.projects).toEqual([]);
      },
    );

    it('with no project it is listed, makes no project row and leaves the session linked', () => {
      const out = fold(cli([session({ epics: [taskless({ project: null })] })]), [
        store({ activelyRunning: [] }),
      ]);
      expect(out.epics).toEqual([
        { storeId: 'home', epicId: 'epic-a', project: null, ...NO_SPEND },
      ]);
      expect(out.factorySessions).toEqual([{ storeId: 'home', sessionId: 'f1' }]);
      expect(out.projects).toEqual([]);
      expect(out.unlinkedSessions).toBe(0);
      expect(out.liveSessions).toBe(1);
    });
  });

  describe('the fact strip totals', () => {
    const agent = { role: 'coder', taskId: 't1', since: '2026-10-07T11:00:00.000Z' };
    const facts = (out: ReturnType<typeof fold>) => ({
      activeSessions: out.activeSessions,
      agentsRunning: out.agentsRunning,
      agentsUnmeasured: out.agentsUnmeasured,
      tokensSpent: out.tokensSpent,
      tokensUnmeasured: out.tokensUnmeasured,
      tasksDone: out.tasksDone,
      tasksTotal: out.tasksTotal,
    });

    it('a session linked only to a closed epic is not active and adds nothing', () => {
      const out = fold(
        cli([
          session(
            {
              epics: [
                linkedEpic({ closed: true, workingAgents: [agent], progress: counts(1, 0, 0, 1) }),
              ],
            },
            { subagentsRunning: 3 },
          ),
        ]),
        [
          store({
            activelyRunning: ['epic-a'],
            tokens: { 'epic-a': { tokensSpent: 9, unmeasured: 1 } },
          }),
        ],
      );
      expect(out.liveSessions).toBe(1);
      expect(facts(out)).toEqual({
        activeSessions: 0,
        agentsRunning: 0,
        agentsUnmeasured: 0,
        ...NO_SPEND,
      });
    });

    it('two sessions on one epic count its tokens and tasks once', () => {
      const epic = linkedEpic({ progress: counts(3, 1, 1, 5, 2) });
      const out = fold(
        cli([
          session({ epics: [epic] }, { cliSessionId: 'c1' }),
          session({ epics: [epic] }, { cliSessionId: 'c2' }),
        ]),
        [
          store({
            activelyRunning: ['epic-a'],
            tokens: { 'epic-a': { tokensSpent: 1200, unmeasured: 2 } },
          }),
        ],
      );
      expect(facts(out)).toEqual({
        activeSessions: 2,
        agentsRunning: 0,
        agentsUnmeasured: 0,
        tokensSpent: 1200,
        tokensUnmeasured: 0,
        tasksDone: 3,
        tasksTotal: 10,
      });
      expect(out.epics).toEqual([
        {
          storeId: 'home',
          epicId: 'epic-a',
          project: 'project-a',
          tokensSpent: 1200,
          tokensUnmeasured: 2,
          tasksDone: 3,
          tasksTotal: 10,
        },
      ]);
    });

    it('two sessions on one epic are one group: the larger of their subagents and the factory agents', () => {
      const out = fold(
        cli([
          session(
            { epics: [linkedEpic({ workingAgents: [agent] })] },
            { cliSessionId: 'c1', subagentsRunning: 2 },
          ),
          session(
            { epics: [linkedEpic({ workingAgents: [agent, { ...agent, taskId: 't2' }] })] },
            { cliSessionId: 'c2', subagentsRunning: 3 },
          ),
          // Not on an active epic: its subagents are not this set's.
          session(null, { cliSessionId: 'c3', subagentsRunning: 4 }),
        ]),
        [store({ activelyRunning: ['epic-a'] })],
      );
      expect(out.activeSessions).toBe(2);
      expect(out.agentsRunning).toBe(5);
      expect(out.agentsUnmeasured).toBe(0);
      expect(out.projects).toMatchObject([
        { project: 'project-a', activeSessions: 2, agentsWorking: 2, agentsRunning: 5 },
      ]);
    });

    describe('agents are counted once per group of sessions and epics', () => {
      const w = (taskId: string) => ({ role: 'coder', taskId, since: '2026-10-07T11:00:00.000Z' });
      const run = (sessions: unknown[]) =>
        fold(cli(sessions), [store({ activelyRunning: ['epic-a', 'epic-b'] })]);

      it('one open Agent call and one working coder on its epic is 1', () => {
        const out = run([
          session({ epics: [linkedEpic({ workingAgents: [w('t1')] })] }, { subagentsRunning: 1 }),
        ]);
        expect(out.agentsRunning).toBe(1);
        expect(out.projects).toMatchObject([{ agentsRunning: 1 }]);
      });

      it('a wave-runner Agent call with three working coders is 3', () => {
        const out = run([
          session(
            { epics: [linkedEpic({ workingAgents: [w('t1'), w('t2'), w('t3')] })] },
            { subagentsRunning: 1 },
          ),
        ]);
        expect(out.agentsRunning).toBe(3);
        expect(out.projects).toMatchObject([{ agentsRunning: 3 }]);
      });

      it('two plain Agent calls and no factory agents is 2', () => {
        const out = run([session({ epics: [linkedEpic()] }, { subagentsRunning: 2 })]);
        expect(out.agentsRunning).toBe(2);
        expect(out.projects).toMatchObject([{ agentsRunning: 2 }]);
      });

      it('two sessions on two unrelated epics are two groups, summed', () => {
        const out = run([
          session(
            { epics: [linkedEpic({ workingAgents: [w('t1')] })] },
            { cliSessionId: 'c1', subagentsRunning: 1 },
          ),
          session(
            { epics: [linkedEpic({ epicId: 'epic-b', project: 'project-b' })] },
            { cliSessionId: 'c2', subagentsRunning: 2 },
          ),
        ]);
        expect(out.agentsRunning).toBe(1 + 2);
      });

      it('a session on two epics joins them into one group', () => {
        const out = run([
          session(
            {
              epics: [
                linkedEpic({ workingAgents: [w('t1')] }),
                linkedEpic({ epicId: 'epic-b', workingAgents: [w('t2')] }),
              ],
            },
            { cliSessionId: 'c1', subagentsRunning: 1 },
          ),
          session(
            { epics: [linkedEpic({ epicId: 'epic-b' })] },
            { cliSessionId: 'c2', subagentsRunning: 1 },
          ),
        ]);
        // One group: max(1 + 1 subagents, 2 factory agents).
        expect(out.agentsRunning).toBe(2);
      });

      it('a null subagentsRunning is unmeasured and the factory count still counts', () => {
        const out = run([
          session(
            { epics: [linkedEpic({ workingAgents: [w('t1'), w('t2')] })] },
            { subagentsRunning: null },
          ),
        ]);
        expect(out.agentsUnmeasured).toBe(1);
        expect(out.agentsRunning).toBe(2);
        expect(out.projects).toMatchObject([{ agentsRunning: 2, agentsUnmeasured: 1 }]);
      });
    });

    it('the same epic id in two stores is two epics, each with its own spend and agents', () => {
      const other = { id: 'store-b', label: 'project-b' };
      const out = fold(
        cli([
          session({
            epics: [
              linkedEpic({ workingAgents: [agent], progress: counts(1, 0, 0, 1) }),
              linkedEpic({
                store: other,
                project: 'project-b',
                workingAgents: [agent],
                progress: counts(2, 0, 1, 1),
              }),
            ],
          }),
        ]),
        [
          store({
            activelyRunning: ['epic-a'],
            tokens: { 'epic-a': { tokensSpent: 100, unmeasured: 0 } },
          }),
          store({
            id: 'store-b',
            label: 'project-b',
            activelyRunning: ['epic-a'],
            tokens: { 'epic-a': { tokensSpent: 200, unmeasured: 1 } },
          }),
        ],
      );
      expect(out.epics.map((e) => [e.storeId, e.epicId, e.tokensSpent])).toEqual([
        ['home', 'epic-a', 100],
        ['store-b', 'epic-a', 200],
      ]);
      expect(facts(out)).toEqual({
        activeSessions: 1,
        agentsRunning: 2,
        agentsUnmeasured: 0,
        tokensSpent: 300,
        tokensUnmeasured: 0,
        tasksDone: 3,
        tasksTotal: 6,
      });
    });

    it('a null subagentsRunning raises agentsUnmeasured and adds no agents', () => {
      const out = fold(
        cli([
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c1', subagentsRunning: null }),
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c2', subagentsRunning: 1 }),
        ]),
        [store({ activelyRunning: ['epic-a'] })],
      );
      expect(out.agentsRunning).toBe(1);
      expect(out.agentsUnmeasured).toBe(1);
      expect(out.projects).toMatchObject([{ agentsRunning: 1, agentsUnmeasured: 1 }]);
    });

    it('a project row counts only the sessions on its active epics', () => {
      const out = fold(
        cli([
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c1', subagentsRunning: 1 }),
          session(
            {
              epics: [
                linkedEpic({ epicId: 'epic-b', project: 'project-b' }),
                linkedEpic({ epicId: null }),
              ],
            },
            { cliSessionId: 'c2', subagentsRunning: 2 },
          ),
        ]),
        [store({ activelyRunning: ['epic-a', 'epic-b'] })],
      );
      const row = (project: string) => out.projects.find((p) => p.project === project);
      expect(row('project-a')).toMatchObject({
        liveSessions: 2,
        activeSessions: 1,
        agentsRunning: 1,
      });
      expect(row('project-b')).toMatchObject({
        liveSessions: 1,
        activeSessions: 1,
        agentsRunning: 2,
      });
      expect(out.activeSessions).toBe(2);
      expect(out.agentsRunning).toBe(3);
    });
  });

  describe('budget used: transcript tokens', () => {
    const tok = (used: number, complete = true) => ({ tokens: { used, complete } });
    const two = [store({ activelyRunning: ['epic-a', 'epic-b'] })];
    const epicB = linkedEpic({ epicId: 'epic-b', project: 'project-b' });
    const row = (out: ReturnType<typeof fold>, project: string) =>
      out.projects.find((p) => p.project === project);

    it('two sessions on one epic sum their transcript tokens', () => {
      const epic = linkedEpic();
      const out = fold(
        cli([
          session({ epics: [epic] }, { cliSessionId: 'c1', ...tok(100) }),
          session({ epics: [epic] }, { cliSessionId: 'c2', ...tok(250) }),
        ]),
        [store({ activelyRunning: ['epic-a'] })],
      );
      expect(out.tokensSpent).toBe(350);
      expect(out.tokensUnmeasured).toBe(0);
      expect(row(out, 'project-a')).toMatchObject({ tokensSpent: 350, tokensUnmeasured: 0 });
    });

    it('a session on two epics counts once', () => {
      const out = fold(cli([session({ epics: [linkedEpic(), epicB] }, tok(500))]), two);
      expect(out.tokensSpent).toBe(500);
    });

    it('a null or incomplete session adds to tokensUnmeasured and its known part still counts', () => {
      const out = fold(
        cli([
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c1', ...tok(70, false) }),
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c2', tokens: null }),
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c3', ...tok(30) }),
        ]),
        [store({ activelyRunning: ['epic-a'] })],
      );
      expect(out.tokensSpent).toBe(100);
      expect(out.tokensUnmeasured).toBe(2);
      expect(row(out, 'project-a')).toMatchObject({ tokensSpent: 100, tokensUnmeasured: 2 });
    });

    it('the factory figure wins when it is larger than the transcripts', () => {
      const out = fold(cli([session({ epics: [linkedEpic()] }, tok(100))]), [
        store({
          activelyRunning: ['epic-a'],
          tokens: { 'epic-a': { tokensSpent: 900, unmeasured: 0 } },
        }),
      ]);
      expect(out.tokensSpent).toBe(900);
      expect(row(out, 'project-a')?.tokensSpent).toBe(900);
      expect(out.epics[0]).toMatchObject({ tokensSpent: 900 });
    });

    it('the transcripts win when they are larger than the factory figure', () => {
      const out = fold(cli([session({ epics: [linkedEpic()] }, tok(1000))]), [
        store({
          activelyRunning: ['epic-a'],
          tokens: { 'epic-a': { tokensSpent: 900, unmeasured: 1 } },
        }),
      ]);
      expect(out.tokensSpent).toBe(1000);
      expect(out.epics[0]).toMatchObject({ tokensSpent: 900, tokensUnmeasured: 1 });
    });

    it('two unrelated groups are summed, each project row over its own sessions', () => {
      const out = fold(
        cli([
          session({ epics: [linkedEpic()] }, { cliSessionId: 'c1', ...tok(100) }),
          session({ epics: [epicB] }, { cliSessionId: 'c2', ...tok(40, false) }),
        ]),
        [
          store({
            activelyRunning: ['epic-a', 'epic-b'],
            tokens: { 'epic-b': { tokensSpent: 10, unmeasured: 0 } },
          }),
        ],
      );
      expect(out.tokensSpent).toBe(140);
      expect(out.tokensUnmeasured).toBe(1);
      expect(row(out, 'project-a')).toMatchObject({ tokensSpent: 100, tokensUnmeasured: 0 });
      expect(row(out, 'project-b')).toMatchObject({ tokensSpent: 40, tokensUnmeasured: 1 });
    });

    it('a project row groups only its own epics: a session shared with another project counts in both rows', () => {
      const out = fold(cli([session({ epics: [linkedEpic(), epicB] }, tok(500))]), two);
      expect(row(out, 'project-a')?.tokensSpent).toBe(500);
      expect(row(out, 'project-b')?.tokensSpent).toBe(500);
      expect(out.tokensSpent).toBe(500);
    });
  });

  describe('an active epic whose store gave no overview this poll', () => {
    const written = linkedEpic({
      store: { id: 'store-a', label: 'store-a' },
      factorySessionLastEventAt: { f1: '2026-10-07T11:00:00.000Z' },
    });

    it('counts as unmeasured spend, not as a measured zero', () => {
      const out = fold(cli([session({ epics: [written] })]), []);
      expect(out.epics).toHaveLength(1);
      expect(out.epics[0]?.tokensUnmeasured).toBeGreaterThanOrEqual(1);
      expect(out.tokensSpent).toBe(0);
      expect(out.tokensUnmeasured).toBeGreaterThanOrEqual(1);
      expect(out.projects[0]?.tokensUnmeasured).toBeGreaterThanOrEqual(1);
    });

    it('counts once however many sessions link it, and leaves a read store measured', () => {
      const other = linkedEpic({
        store: { id: 'store-b', label: 'store-b' },
        epicId: 'epic-b',
        project: 'project-b',
        factorySessionLastEventAt: { f1: '2026-10-07T11:00:00.000Z' },
      });
      const out = fold(
        cli([
          session({ epics: [written] }),
          session({ epics: [written, other] }, { cliSessionId: 'c2' }),
        ]),
        [store({ id: 'store-b', label: 'store-b', activelyRunning: ['epic-b'] })],
      );
      expect(out.tokensUnmeasured).toBe(1);
      const byEpic = Object.fromEntries(out.epics.map((e) => [e.epicId, e.tokensUnmeasured]));
      expect(byEpic).toEqual({ 'epic-a': 1, 'epic-b': 0 });
      const byProject = Object.fromEntries(
        out.projects.map((p) => [p.project, p.tokensUnmeasured]),
      );
      expect(byProject).toEqual({ 'project-a': 1, 'project-b': 0 });
    });

    it('a store that was read with no entry for the epic stays a measured zero', () => {
      const out = fold(cli([session({ epics: [written] })]), [
        store({ id: 'store-a', label: 'store-a', activelyRunning: ['epic-a'] }),
      ]);
      expect(out.tokensSpent).toBe(0);
      expect(out.tokensUnmeasured).toBe(0);
      expect(out.epics[0]?.tokensUnmeasured).toBe(0);
    });
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
