import { describe, expect, it } from 'vitest';
import type { ClosedEpic, EpicTokenSpend, OverviewResult, RecentDispatch } from '../src/lib/api.js';
import {
  budgetDeltaSentence,
  budgetRingLabel,
  budgetSummary,
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

function summary(
  project: string,
  workingAgentCount: number,
  epicsActivelyRunning: string[] = [],
): NonNullable<OverviewResult['projects']>[number] {
  return {
    project,
    liveAgentCount: workingAgentCount,
    workingAgentCount,
    epicsInFlight: epicsActivelyRunning,
    epicsActivelyRunning,
    tokensSpent: 5,
    tokensBudget: null,
    unmeasured: 0,
    alerts: { escalations: 0, pendingWaivers: 0 },
  };
}

describe('lib/homeView.ts runningNowCards()', () => {
  it('is active only with an agent working in the window, from overview.projects', () => {
    const o = overview({
      projects: [
        {
          ...summary('shop-api', 28, ['shop-1']),
          tokensSpent: 10_600_000,
          tokensBudget: 10_300_000,
        },
        summary('idle', 0),
      ],
    });
    const r = runningNowCards(o);
    expect(r.active).toEqual([
      {
        project: 'shop-api',
        workingAgents: 28,
        epics: ['shop-1'],
        tokens: { spent: 10_600_000, budget: 10_300_000, unmeasured: 0 },
      },
    ]);
    expect(r.quiet.map((c) => c.project)).toEqual(['idle']);
  });

  it('a project with an actively running epic but no working agent is quiet, not active', () => {
    const o = overview({
      projects: [summary('ghost', 0, ['ghost-1']), summary('live', 2, ['live-1'])],
    });
    const r = runningNowCards(o);
    expect(r.active.map((c) => c.project)).toEqual(['live']);
    expect(r.quiet).toEqual([
      {
        project: 'ghost',
        workingAgents: 0,
        epics: ['ghost-1'],
        tokens: { spent: 5, budget: null, unmeasured: 0 },
      },
    ]);
  });

  it('keeps the server order inside each group, so All lists active first, then quiet', () => {
    const o = overview({
      projects: [summary('a', 0), summary('b', 1), summary('c', 0), summary('d', 3)],
    });
    const r = runningNowCards(o);
    expect([...r.active, ...r.quiet].map((c) => c.project)).toEqual(['b', 'd', 'a', 'c']);
    expect(r.quiet).toHaveLength(2);
  });

  it('builds the single selected-project card from the scoped overview', () => {
    const o = overview({
      workingAgentCount: 3,
      epicsInFlight: ['e1'],
      epicsActivelyRunning: ['e1'],
      tokensByEpic: [epic('e1', 40, 100, 1)],
    });
    expect(runningNowCards(o, 'shop-api')).toEqual({
      active: [
        {
          project: 'shop-api',
          workingAgents: 3,
          epics: ['e1'],
          tokens: { spent: 40, budget: 100, unmeasured: 1 },
        },
      ],
      quiet: [],
    });
  });

  it('makes a selected project with no working agent a quiet card, even with a running epic', () => {
    const o = overview({
      workingAgentCount: 0,
      epicsInFlight: ['e1'],
      epicsActivelyRunning: ['e1'],
      tokensByEpic: [epic('e1', 40, 100)],
    });
    const r = runningNowCards(o, 'shop-api');
    expect(r.active).toEqual([]);
    expect(r.quiet).toEqual([
      {
        project: 'shop-api',
        workingAgents: 0,
        epics: ['e1'],
        tokens: { spent: 40, budget: 100, unmeasured: 0 },
      },
    ]);
  });

  it('is empty when there are no projects', () => {
    expect(runningNowCards(overview({}))).toEqual({ active: [], quiet: [] });
    expect(runningNowCards(overview({ projects: [] }))).toEqual({ active: [], quiet: [] });
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
