import { describe, expect, it } from 'vitest';
import type {
  ActiveScopeResult,
  ClosedEpic,
  EpicTokenSpend,
  OverviewResult,
  RecentDispatch,
} from '../src/lib/api.js';
import {
  budgetDeltaSentence,
  budgetPanel,
  budgetRingLabel,
  budgetSummary,
  budgetView,
  cardTokensText,
  decisionLine,
  decisionsSpanStores,
  isBudgetOutlier,
  outlierSentence,
  type RunningCard,
  runningNowCards,
  sumTokens,
  tokensOfBudget,
  trackJustFinished,
  unmeasuredSentence,
} from '../src/lib/homeView.js';

function epic(
  epicId: string,
  tokensSpent: number,
  tokensBudget: number | null,
  unmeasured = 0,
): EpicTokenSpend {
  return { epicId, tokensSpent, tokensBudget, unmeasured };
}

function closed(epicId: string): ClosedEpic {
  return {
    epicId,
    closedBy: 'operator',
    machineVerdict: null,
    machineReason: null,
    overrideRationale: null,
    blockers: [],
    closedAt: '2026-09-30T10:00:00Z',
  };
}

function overview(over: Partial<OverviewResult>): OverviewResult {
  return {
    liveAgents: [],
    liveAgentEntries: [],
    liveAgentCount: 0,
    workingAgentCount: 0,
    stalledAgentCount: 0,
    runningSessions: [],
    epicsInFlight: [],
    epicsActivelyRunning: [],
    epicsIdle: [],
    closedEpics: [],
    tokensByEpic: [],
    alerts: { escalations: 0, pendingWaivers: 0 },
    milestoneProgress: [],
    recentDispatches: [],
    liveAgentCountDelta5m: 0,
    workingAgentCountDelta5m: 0,
    budgetUsedPctPointDelta1h: null,
    ...over,
  };
}

describe('lib/homeView.ts sumTokens()', () => {
  it('sums spent and unmeasured, and budget over the epics that have one', () => {
    expect(sumTokens([epic('a', 10, 100, 1), epic('b', 5, null, 2)])).toEqual({
      spent: 15,
      budget: 100,
      unmeasured: 3,
    });
  });

  it('reports no budget when no epic has one', () => {
    expect(sumTokens([epic('a', 10, null)]).budget).toBeNull();
    expect(sumTokens([]).budget).toBeNull();
  });
});

describe('lib/homeView.ts budget outliers', () => {
  it('flags an epic that spent more than ten times its budget', () => {
    expect(isBudgetOutlier(epic('x', 107_000_000, 1_185_000))).toBe(true);
    expect(isBudgetOutlier(epic('x', 10_000_000, 1_000_000))).toBe(false);
    expect(isBudgetOutlier(epic('x', 10_000_000, null))).toBe(false);
  });

  it('keeps outliers out of the totals and lists them apart', () => {
    const s = budgetSummary([epic('ok', 127, 180), epic('wild', 107_000, 1_000)]);
    expect(s.spent).toBe(127);
    expect(s.budget).toBe(180);
    expect(s.outliers.map((e) => e.epicId)).toEqual(['wild']);
  });
});

describe('lib/homeView.ts sentences', () => {
  it('says the hour-over-hour move in points, in words', () => {
    expect(budgetDeltaSentence(-4.2)).toBe('4 points lower than an hour ago');
    expect(budgetDeltaSentence(1)).toBe('1 point higher than an hour ago');
    expect(budgetDeltaSentence(0.3)).toBe('Same as an hour ago');
    expect(budgetDeltaSentence(null)).toBeNull();
  });

  it('counts steps that did not report their cost', () => {
    expect(unmeasuredSentence(296)).toBe('296 steps did not report their cost');
    expect(unmeasuredSentence(1)).toBe('1 step did not report its cost');
    expect(unmeasuredSentence(0)).toBeNull();
  });
});

describe('lib/homeView.ts runningNowCards()', () => {
  it('builds one card per project that has something running, from overview.projects', () => {
    const o = overview({
      projects: [
        {
          project: 'shop-api',
          liveAgentCount: 30,
          workingAgentCount: 28,
          epicsInFlight: ['shop-1'],
          epicsActivelyRunning: ['shop-1'],
          epicsIdle: [],
          tokensSpent: 10_600_000,
          tokensBudget: 10_300_000,
          unmeasured: 0,
          tokensByEpic: [epic('shop-1', 5_000_000, 10_300_000), epic('shop-old', 5_600_000, null)],
          alerts: { escalations: 0, pendingWaivers: 0 },
        },
        {
          project: 'idle',
          liveAgentCount: 0,
          workingAgentCount: 0,
          epicsInFlight: [],
          epicsActivelyRunning: [],
          epicsIdle: [],
          tokensSpent: 5,
          tokensBudget: null,
          unmeasured: 0,
          tokensByEpic: [],
          alerts: { escalations: 0, pendingWaivers: 0 },
        },
        {
          // F1: an epic whose only open task is escalated stays in
          // epicsInFlight (Kanban/Flow must still reach it) but drops out
          // of epicsActivelyRunning — nothing is actually running.
          project: 'stuck',
          liveAgentCount: 0,
          workingAgentCount: 0,
          epicsInFlight: ['stuck-1'],
          epicsActivelyRunning: [],
          epicsIdle: [],
          tokensSpent: 0,
          tokensBudget: null,
          unmeasured: 0,
          tokensByEpic: [],
          alerts: { escalations: 1, pendingWaivers: 0 },
        },
      ],
    });
    expect(runningNowCards(o, null, 'all').shown).toEqual([
      {
        project: 'shop-api',
        workingAgents: 28,
        epics: ['shop-1'],
        tokens: { spent: 5_000_000, budget: 10_300_000, unmeasured: 0, outliers: [] },
      },
    ]);
  });

  it('builds the single selected-project card from the scoped overview', () => {
    const o = overview({
      workingAgentCount: 3,
      epicsInFlight: ['e1'],
      epicsActivelyRunning: ['e1'],
      tokensByEpic: [epic('e1', 40, 100, 1)],
    });
    expect(runningNowCards(o, null, 'all', 'shop-api').shown).toEqual([
      {
        project: 'shop-api',
        workingAgents: 3,
        epics: ['e1'],
        tokens: { spent: 40, budget: 100, unmeasured: 1, outliers: [] },
      },
    ]);
  });

  function summary(over: Partial<NonNullable<OverviewResult['projects']>[number]>) {
    return {
      project: 'p',
      liveAgentCount: 1,
      workingAgentCount: 1,
      epicsInFlight: [],
      epicsActivelyRunning: [],
      epicsIdle: [],
      tokensSpent: 0,
      tokensBudget: null,
      unmeasured: 0,
      tokensByEpic: [],
      alerts: { escalations: 0, pendingWaivers: 0 },
      ...over,
    };
  }

  it('divides spend by budget over the budgeted in-flight epics only: an unbudgeted or closed epic adds to neither side', () => {
    const o = overview({
      projects: [
        summary({
          epicsInFlight: ['a', 'b'],
          epicsActivelyRunning: ['a', 'b'],
          epicsIdle: [],
          // The project-wide fold the server also sends: 2.1M against 350K.
          tokensSpent: 2_100_000,
          tokensBudget: 350_000,
          tokensByEpic: [
            epic('a', 84_000, 350_000),
            epic('b', 900_000, null),
            epic('closed-one', 1_116_000, null),
          ],
        }),
      ],
    });
    const [card] = runningNowCards(o, null, 'all').shown;
    expect(card?.tokens).toMatchObject({ spent: 84_000, budget: 350_000 });
    expect(Math.round(((card?.tokens.spent ?? 0) / (card?.tokens.budget ?? 1)) * 100)).toBe(24);
  });

  it('keeps a closed epic out of the card even when it has a budget', () => {
    const o = overview({
      projects: [
        summary({
          epicsActivelyRunning: ['a'],
          epicsIdle: [],
          tokensByEpic: [epic('a', 10, 100), epic('closed-one', 9_000, 20_000)],
        }),
      ],
    });
    expect(runningNowCards(o, null, 'all').shown[0]?.tokens).toMatchObject({
      spent: 10,
      budget: 100,
    });
  });

  it('treats an outlier epic exactly as the Budget panel does: out of the ratio, counted apart', () => {
    const epics = [epic('a', 40, 100), epic('wild', 11_000, 1_000)];
    const o = overview({
      projects: [summary({ epicsActivelyRunning: ['a', 'wild'], tokensByEpic: epics })],
    });
    const card = runningNowCards(o, null, 'all').shown[0];
    const panel = budgetSummary(epics);
    expect(card?.tokens).toEqual({
      spent: panel.spent,
      budget: panel.budget,
      unmeasured: panel.unmeasured,
      outliers: panel.outliers.map((e) => e.epicId),
    });
    expect(card?.tokens.outliers).toEqual(['wild']);
  });

  it('applies the same rule to the selected-project card', () => {
    const o = overview({
      workingAgentCount: 1,
      epicsActivelyRunning: ['a'],
      tokensByEpic: [epic('a', 10, 100), epic('closed-one', 9_000, 20_000)],
    });
    expect(runningNowCards(o, null, 'all', 'p').shown[0]?.tokens).toMatchObject({
      spent: 10,
      budget: 100,
    });
  });

  it('shows no card for a selected project with nothing running', () => {
    expect(runningNowCards(overview({}), null, 'all', 'shop-api').shown).toEqual([]);
  });

  it('shows no card for a selected project whose only open epic is escalated (F1)', () => {
    const o = overview({
      workingAgentCount: 0,
      epicsInFlight: ['stuck-1'],
      epicsActivelyRunning: [],
    });
    expect(runningNowCards(o, null, 'all', 'shop-api').shown).toEqual([]);
  });
});

describe('lib/homeView.ts runningNowCards() with the Active/All scope', () => {
  function proj(
    project: string,
    store: string | undefined,
    workingAgentCount: number,
    epics: string[],
  ) {
    return {
      project,
      ...(store ? { store: { id: store, label: store } } : {}),
      liveAgentCount: workingAgentCount,
      workingAgentCount,
      epicsInFlight: epics,
      epicsActivelyRunning: epics,
      epicsIdle: [],
      tokensSpent: 0,
      tokensBudget: null,
      unmeasured: 0,
      tokensByEpic: epics.map((e) => epic(e, 10, 100)),
      alerts: { escalations: 0, pendingWaivers: 0 },
    };
  }
  function scope(
    projects: { storeId: string; project: string; agentsWorking: number }[],
    over: Partial<ActiveScopeResult> = {},
  ): ActiveScopeResult {
    return {
      measured: true,
      readAt: '2026-10-07T10:00:00Z',
      liveSessions: projects.length,
      unlinkedSessions: 0,
      projects: projects.map((p) => ({ ...p, liveSessions: 1 })),
      epics: [],
      factorySessions: [],
      ...over,
    };
  }
  const two = overview({
    projects: [
      proj('project-a', undefined, 2, ['epic-a']),
      proj('project-b', undefined, 3, ['epic-b']),
    ],
  });
  const onlyA = scope([{ storeId: 'home', project: 'project-a', agentsWorking: 1 }]);

  it('hides a project with running epics but no live session under Active, counted quiet', () => {
    const r = runningNowCards(two, onlyA, 'active');
    expect(r.shown.map((c) => c.project)).toEqual(['project-a']);
    expect(r.quiet.map((c) => c.project)).toEqual(['project-b']);
  });

  it('shows it muted under All', () => {
    const r = runningNowCards(two, onlyA, 'all');
    expect(r.shown.map((c) => [c.project, c.quiet === true])).toEqual([
      ['project-a', false],
      ['project-b', true],
    ]);
    expect(r.quiet).toEqual([]);
  });

  it('gives an active project that isRunning drops no card and does not count it quiet', () => {
    const o = overview({
      projects: [proj('project-a', undefined, 0, []), proj('project-b', undefined, 3, ['epic-b'])],
    });
    const r = runningNowCards(
      o,
      scope([{ storeId: 'home', project: 'project-a', agentsWorking: 0 }]),
      'active',
    );
    expect(r.shown).toEqual([]);
    expect(r.quiet.map((c) => c.project)).toEqual(['project-b']);
  });

  it('keys by store: only the store the session is on is active', () => {
    const o = overview({
      projects: [
        proj('project-a', undefined, 1, ['epic-a']),
        proj('project-a', 'store-b', 1, ['epic-x']),
      ],
    });
    const r = runningNowCards(
      o,
      scope([{ storeId: 'store-b', project: 'project-a', agentsWorking: 1 }]),
      'active',
    );
    expect(r.shown.map((c) => c.store?.id)).toEqual(['store-b']);
    expect(r.quiet.map((c) => c.store?.id)).toEqual([undefined]);
  });

  it('shows an active card the scope agentsWorking, the same under Active and All; a quiet card keeps workingAgents', () => {
    const active = runningNowCards(two, onlyA, 'active').shown[0];
    const all = runningNowCards(two, onlyA, 'all').shown;
    expect(active?.workingAgents).toBe(1);
    expect(all[0]?.workingAgents).toBe(1);
    expect(all[1]?.workingAgents).toBe(3);
  });

  it('treats an unmeasured scope as All: every card, none muted, nothing quiet', () => {
    const r = runningNowCards(two, scope([], { measured: false }), 'active');
    expect(r.shown.map((c) => c.project)).toEqual(['project-a', 'project-b']);
    expect(r.shown.some((c) => c.quiet)).toBe(false);
    expect(r.quiet).toEqual([]);
    expect(runningNowCards(two, null, 'active').shown).toHaveLength(2);
  });

  it('applies the scope to the single selected-project card', () => {
    const o = overview({
      workingAgentCount: 3,
      epicsActivelyRunning: ['e1'],
      tokensByEpic: [epic('e1', 1, 2)],
    });
    expect(runningNowCards(o, onlyA, 'active', 'project-b').quiet).toHaveLength(1);
    expect(runningNowCards(o, onlyA, 'active', 'project-a').shown).toHaveLength(1);
  });

  it('matches the merged ?project= card by name: a live session in another store makes it active', () => {
    const o = overview({
      workingAgentCount: 3,
      epicsActivelyRunning: ['e1'],
      tokensByEpic: [epic('e1', 1, 2)],
    });
    const r = runningNowCards(
      o,
      scope([{ storeId: 'store-b', project: 'project-a', agentsWorking: 2 }]),
      'active',
      'project-a',
    );
    expect(r.quiet).toEqual([]);
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]?.workingAgents).toBe(2);
  });

  it('counts the merged ?project= card agents over every store that names it', () => {
    const o = overview({
      workingAgentCount: 3,
      epicsActivelyRunning: ['e1'],
      tokensByEpic: [epic('e1', 1, 2)],
    });
    const r = runningNowCards(
      o,
      scope([
        { storeId: 'home', project: 'project-a', agentsWorking: 1 },
        { storeId: 'store-b', project: 'project-a', agentsWorking: 2 },
      ]),
      'active',
      'project-a',
    );
    expect(r.shown[0]?.workingAgents).toBe(3);
  });
});

function card(epics: string[], tokens: Partial<RunningCard['tokens']>): RunningCard {
  return {
    project: 'project-a',
    workingAgents: 1,
    epics,
    tokens: { spent: 0, budget: null, unmeasured: 0, outliers: [], ...tokens },
  };
}

describe('lib/homeView.ts budgetPanel()', () => {
  it('sums the cards on screen: spend, budget, unmeasured steps and outliers', () => {
    expect(
      budgetPanel([
        card(['a'], { spent: 40, budget: 100, unmeasured: 2, outliers: ['wild'] }),
        card(['b'], { spent: 30, budget: 200, unmeasured: 1 }),
        card(['c'], { spent: 5, budget: null }),
      ]),
    ).toEqual({ spent: 75, budget: 300, unmeasured: 3, outliers: ['wild'] });
  });

  it('has a null budget when no card declares one', () => {
    expect(budgetPanel([card(['a'], { spent: 5 })])).toMatchObject({ spent: 5, budget: null });
  });

  it('is the sum over the shown cards epics: Active narrows it, All is every card', () => {
    const two = overview({
      projects: [
        {
          project: 'project-a',
          liveAgentCount: 1,
          workingAgentCount: 1,
          epicsInFlight: ['epic-a'],
          epicsActivelyRunning: ['epic-a'],
          epicsIdle: [],
          tokensSpent: 10,
          tokensBudget: 100,
          unmeasured: 0,
          tokensByEpic: [epic('epic-a', 10, 100)],
          alerts: { escalations: 0, pendingWaivers: 0 },
        },
        {
          project: 'project-b',
          liveAgentCount: 1,
          workingAgentCount: 1,
          epicsInFlight: ['epic-b'],
          epicsActivelyRunning: ['epic-b'],
          epicsIdle: [],
          tokensSpent: 20,
          tokensBudget: 200,
          unmeasured: 0,
          tokensByEpic: [epic('epic-b', 20, 200)],
          alerts: { escalations: 0, pendingWaivers: 0 },
        },
      ],
    });
    const live: ActiveScopeResult = {
      measured: true,
      readAt: '',
      liveSessions: 1,
      unlinkedSessions: 0,
      projects: [{ storeId: 'home', project: 'project-a', liveSessions: 1, agentsWorking: 1 }],
      epics: [],
      factorySessions: [],
    };
    expect(budgetPanel(runningNowCards(two, live, 'active').shown)).toMatchObject({
      spent: 10,
      budget: 100,
    });
    expect(budgetPanel(runningNowCards(two, live, 'all').shown)).toMatchObject({
      spent: 30,
      budget: 300,
    });
  });

  it('has no panel figures when no card has a running epic, never a zero', () => {
    expect(budgetPanel([])).toBeNull();
    expect(budgetPanel([card([], { spent: 0 })])).toBeNull();
  });
});

describe('lib/homeView.ts budgetView()', () => {
  it('is the quiet line and no figures when no epic is running', () => {
    expect(budgetView([], null)).toEqual({ kind: 'none', text: 'No epic is running.' });
  });

  it('shows figures over the cards, with the overview delta', () => {
    const view = budgetView(
      [
        card(['run-a'], { spent: 40_000, budget: 100_000, unmeasured: 2 }),
        card(['run-b'], { spent: 10_000, budget: 100_000 }),
      ],
      4,
    );
    if (view.kind !== 'figures') throw new Error('expected figures');
    expect(view.ring).toEqual({
      value: 50_000,
      max: 200_000,
      label: budgetRingLabel(50_000, 200_000),
    });
    expect(view.tokensText).toBe(tokensOfBudget({ spent: 50_000, budget: 200_000, unmeasured: 2 }));
    expect(view.deltaSentence).toBe('4 points higher than an hour ago');
    expect(view.unmeasuredSentence).toBe('2 steps did not report their cost');
    expect(view.outlierSentence).toBeNull();
  });

  it('names a running outlier and keeps it out of the ring', () => {
    const view = budgetView(
      [card(['run-a', 'run-wild'], { spent: 40, budget: 100, outliers: ['run-wild'] })],
      null,
    );
    if (view.kind !== 'figures') throw new Error('expected figures');
    expect(view.ring).toMatchObject({ value: 40, max: 100 });
    expect(view.outlierSentence).toBe(outlierSentence(['run-wild']));
    expect(view.outlierSentence).toContain('run-wild');
  });

  it('draws no ring when no running epic reported its cost', () => {
    const view = budgetView([card(['run-a'], { spent: 0, budget: 100, unmeasured: 3 })], null);
    if (view.kind !== 'figures') throw new Error('expected figures');
    expect(view.ring).toBeNull();
  });

  it('drops the whole-factory delta when Active hides a card, keeps it when not narrowed', () => {
    const cards = [card(['run-a'], { spent: 40, budget: 100 })];
    const narrowed = budgetView(cards, 4, true);
    if (narrowed.kind !== 'figures') throw new Error('expected figures');
    expect(narrowed.deltaSentence).toBeNull();
    const all = budgetView(cards, 4, false);
    if (all.kind !== 'figures') throw new Error('expected figures');
    expect(all.deltaSentence).toBe('4 points higher than an hour ago');
  });

  it('says no epic runs on an active project when narrowed, and no epic runs when not', () => {
    expect(budgetView([], 4, true)).toEqual({
      kind: 'none',
      text: 'No epic is running on an active project.',
    });
    expect(budgetView([], 4, false)).toEqual({ kind: 'none', text: 'No epic is running.' });
  });
});

describe('lib/homeView.ts trackJustFinished()', () => {
  // Fixed far outside closed()'s 24h window, so these session-tracking cases
  // are not accidentally satisfied by the F3 24h-window fallback below.
  const FAR_LATER = new Date('2026-10-10T10:00:00Z').getTime();

  it('reports a closed epic only once it was seen in flight in this session', () => {
    const seen = new Set<string>();
    expect(
      trackJustFinished(
        seen,
        overview({ epicsInFlight: ['a'], closedEpics: [closed('old')] }),
        FAR_LATER,
      ),
    ).toEqual([]);
    const next = overview({ epicsInFlight: [], closedEpics: [closed('a'), closed('old')] });
    expect(trackJustFinished(seen, next, FAR_LATER).map((e) => e.epicId)).toEqual(['a']);
  });

  it('does not report an epic that is still in flight', () => {
    const seen = new Set(['a']);
    expect(
      trackJustFinished(
        seen,
        overview({ epicsInFlight: ['a'], closedEpics: [closed('a')] }),
        FAR_LATER,
      ),
    ).toEqual([]);
  });

  it('reports an epic closed within the last 24h even on a fresh load (F3, no session state yet)', () => {
    // closed('a') carries closedAt 2026-09-30T10:00:00Z; "now" 6h later is
    // still within the 24h window, so a tab opened fresh (empty `seen`)
    // must still surface it — the morning-after case F3 exists for.
    const seen = new Set<string>();
    const now = new Date('2026-09-30T16:00:00Z').getTime();
    const o = overview({ epicsInFlight: [], closedEpics: [closed('a')] });
    expect(trackJustFinished(seen, o, now).map((e) => e.epicId)).toEqual(['a']);
  });

  it('does not report an epic closed more than 24h ago on a fresh load', () => {
    const seen = new Set<string>();
    const now = new Date('2026-10-02T11:00:00Z').getTime();
    const o = overview({ epicsInFlight: [], closedEpics: [closed('a')] });
    expect(trackJustFinished(seen, o, now)).toEqual([]);
  });
});

describe('lib/homeView.ts decisionLine()', () => {
  const base: RecentDispatch = {
    eventId: '1',
    ts: '2026-09-30T10:00:00Z',
    agentRole: 'coder',
    provider: 'claude',
    modelTier: 'mid',
    taskId: 'epic-a/task-3-settings-integrations',
    reason: 'first attempt',
    round: 1,
  };

  it('says the role and the short task name, nothing else', () => {
    expect(decisionLine(base)).toBe('Builder started on Settings integrations');
  });

  it('adds nothing for round 1 and " · round N" from round 2', () => {
    expect(decisionLine({ ...base, round: 1 })).not.toContain('round');
    expect(decisionLine({ ...base, round: 2 })).toBe(
      'Builder started on Settings integrations · round 2',
    );
  });

  it('reads "<Role> started" when there is no task', () => {
    expect(decisionLine({ ...base, taskId: null })).toBe('Builder started');
    expect(decisionLine({ ...base, taskId: null, round: 3 })).toBe('Builder started · round 3');
  });

  it('names a minted follow-up id "Follow-up fix" and never shows its hex', () => {
    const line = decisionLine({ ...base, taskId: 'followup-48bb6826' });
    expect(line).toBe('Builder started on Follow-up fix');
    expect(line).not.toContain('48bb6826');
  });

  it('never carries the reason, the provider or the model tier', () => {
    const long = `${'internal note r4 F-12 0a1b2c3 event 4412 '.repeat(10)}`;
    for (const provider of ['claude', 'codex', 'deepseek']) {
      for (const modelTier of ['frontier', 'mid', 'small']) {
        const line = decisionLine({ ...base, provider, modelTier, reason: long });
        expect(line).not.toContain('internal note');
        expect(line).not.toMatch(/Claude|Codex|DeepSeek|standard model|flagship model|fast model/i);
        expect(line.length).toBeLessThan(80);
      }
    }
  });
});

describe('lib/homeView.ts decisionsSpanStores()', () => {
  const row = (store?: { id: string; label: string }): RecentDispatch => ({
    eventId: '1',
    ts: '2026-09-30T10:00:00Z',
    agentRole: 'coder',
    provider: 'claude',
    modelTier: 'mid',
    taskId: null,
    reason: null,
    round: 1,
    store,
  });

  it('is false for one store, or for rows that carry no store', () => {
    expect(decisionsSpanStores([row(), row()])).toBe(false);
    expect(
      decisionsSpanStores([
        row({ id: 'store-a', label: 'project-a' }),
        row({ id: 'store-a', label: 'project-a' }),
      ]),
    ).toBe(false);
  });

  it('is true once the rows come from more than one store', () => {
    expect(
      decisionsSpanStores([
        row({ id: 'store-a', label: 'project-a' }),
        row({ id: 'store-b', label: 'project-b' }),
      ]),
    ).toBe(true);
  });
});

describe('lib/homeView.ts token wording', () => {
  it('reads spend against budget in compact numbers', () => {
    expect(tokensOfBudget({ spent: 127_113_770, budget: 180_000_000, unmeasured: 0 })).toBe(
      '127.1M of 180M tokens',
    );
    expect(tokensOfBudget({ spent: 4_000, budget: null, unmeasured: 0 })).toBe(
      '4K tokens, no budget set',
    );
  });

  it('labels the ring with the percentage and says when it is over budget', () => {
    expect(budgetRingLabel(71, 100)).toBe('71% of token budget used');
    expect(budgetRingLabel(10_600_000, 10_300_000)).toBe('103% of token budget used, over budget');
  });

  it('flags outliers in one sentence that names each epic', () => {
    expect(outlierSentence(['epic-a'])).toBe('1 epic has a suspicious total: epic-a.');
    expect(outlierSentence(['epic-a', 'epic-b'])).toBe(
      '2 epics have suspicious totals: epic-a, epic-b.',
    );
    expect(outlierSentence([])).toBeNull();
  });
});

describe('lib/homeView.ts cardTokensText()', () => {
  it('reads "X of Y tokens" when measured', () => {
    expect(cardTokensText({ spent: 84_000, budget: 350_000, unmeasured: 0, outliers: [] })).toBe(
      '84K of 350K tokens',
    );
  });

  it('never prints "0 of" for an unmeasured epic: the budget first, then that spend is not measured', () => {
    const text = cardTokensText({ spent: 0, budget: 4_100_000, unmeasured: 3, outliers: [] });
    expect(text).toBe('4.1M budget · spend not measured');
    expect(text).not.toMatch(/0 of/);
  });

  it('says no budget set when no in-flight epic declares one', () => {
    expect(cardTokensText({ spent: 0, budget: null, unmeasured: 0, outliers: [] })).toBe(
      'No budget set',
    );
  });
});
