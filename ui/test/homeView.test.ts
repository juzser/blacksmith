import { describe, expect, it } from 'vitest';
import type { ClosedEpic, EpicTokenSpend, OverviewResult, RecentDispatch } from '../src/lib/api.js';
import {
  budgetDeltaSentence,
  budgetRingLabel,
  budgetSummary,
  cardTokensText,
  decisionLine,
  isBudgetOutlier,
  outlierSentence,
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
          tokensSpent: 0,
          tokensBudget: null,
          unmeasured: 0,
          tokensByEpic: [],
          alerts: { escalations: 1, pendingWaivers: 0 },
        },
      ],
    });
    expect(runningNowCards(o)).toEqual([
      {
        project: 'shop-api',
        workingAgents: 28,
        epics: ['shop-1'],
        tokens: { spent: 5_000_000, budget: 10_300_000, unmeasured: 0, outliers: 0 },
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
    expect(runningNowCards(o, 'shop-api')).toEqual([
      {
        project: 'shop-api',
        workingAgents: 3,
        epics: ['e1'],
        tokens: { spent: 40, budget: 100, unmeasured: 1, outliers: 0 },
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
    const [card] = runningNowCards(o);
    expect(card?.tokens).toMatchObject({ spent: 84_000, budget: 350_000 });
    expect(Math.round(((card?.tokens.spent ?? 0) / (card?.tokens.budget ?? 1)) * 100)).toBe(24);
  });

  it('keeps a closed epic out of the card even when it has a budget', () => {
    const o = overview({
      projects: [
        summary({
          epicsActivelyRunning: ['a'],
          tokensByEpic: [epic('a', 10, 100), epic('closed-one', 9_000, 20_000)],
        }),
      ],
    });
    expect(runningNowCards(o)[0]?.tokens).toMatchObject({ spent: 10, budget: 100 });
  });

  it('treats an outlier epic exactly as the Budget panel does: out of the ratio, counted apart', () => {
    const epics = [epic('a', 40, 100), epic('wild', 11_000, 1_000)];
    const o = overview({
      projects: [summary({ epicsActivelyRunning: ['a', 'wild'], tokensByEpic: epics })],
    });
    const card = runningNowCards(o)[0];
    const panel = budgetSummary(epics);
    expect(card?.tokens).toEqual({
      spent: panel.spent,
      budget: panel.budget,
      unmeasured: panel.unmeasured,
      outliers: panel.outliers.length,
    });
    expect(card?.tokens.outliers).toBe(1);
  });

  it('applies the same rule to the selected-project card', () => {
    const o = overview({
      workingAgentCount: 1,
      epicsActivelyRunning: ['a'],
      tokensByEpic: [epic('a', 10, 100), epic('closed-one', 9_000, 20_000)],
    });
    expect(runningNowCards(o, 'p')[0]?.tokens).toMatchObject({ spent: 10, budget: 100 });
  });

  it('shows no card for a selected project with nothing running', () => {
    expect(runningNowCards(overview({}), 'shop-api')).toEqual([]);
  });

  it('shows no card for a selected project whose only open epic is escalated (F1)', () => {
    const o = overview({
      workingAgentCount: 0,
      epicsInFlight: ['stuck-1'],
      epicsActivelyRunning: [],
    });
    expect(runningNowCards(o, 'shop-api')).toEqual([]);
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
    provider: 'anthropic',
    modelTier: 'mid',
    taskId: 'epic/task-3-show-fee',
    reason: 'first attempt',
    round: 2,
  };

  it('uses the recorded reason', () => {
    expect(decisionLine(base)).toMatch(/: first attempt$/);
  });

  it('falls back to the task and round when no reason was recorded', () => {
    expect(decisionLine({ ...base, reason: null })).toMatch(/: on Show fee, round 2$/);
    expect(decisionLine({ ...base, reason: null, taskId: null })).toMatch(/: round 2$/);
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

  it('flags outliers in one sentence', () => {
    expect(outlierSentence(1)).toBe('1 epic has a suspicious total.');
    expect(outlierSentence(2)).toBe('2 epics have suspicious totals.');
    expect(outlierSentence(0)).toBeNull();
  });
});

describe('lib/homeView.ts cardTokensText()', () => {
  it('reads "X of Y tokens" when measured', () => {
    expect(cardTokensText({ spent: 84_000, budget: 350_000, unmeasured: 0, outliers: 0 })).toBe(
      '84K of 350K tokens',
    );
  });

  it('never prints "0 of" for an unmeasured epic: it says not measured beside the budget', () => {
    const text = cardTokensText({ spent: 0, budget: 4_100_000, unmeasured: 3, outliers: 0 });
    expect(text).toContain('not measured');
    expect(text).toContain('4.1M');
    expect(text).not.toMatch(/0 of/);
  });

  it('says no budget set when no in-flight epic declares one', () => {
    expect(cardTokensText({ spent: 0, budget: null, unmeasured: 0, outliers: 0 })).toBe(
      'No budget set',
    );
  });
});
