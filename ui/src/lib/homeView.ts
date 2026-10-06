// HomePage's pure half (ds-spec.md §4.1 points 2-4): the "Running now"
// cards, the "Just finished" rule, the decision lines and the Budget
// numbers, kept out of the .vue file so the DOM-free unit suite covers them.
import type { ClosedEpic, EpicTokenSpend, OverviewResult, RecentDispatch } from './api.js';
import { formatBudgetPct, formatCompactNumber, pluralize, taskLabel } from './format.js';
import { dispatchDecisionLine } from './roleLabels.js';

export interface TokenTotals {
  spent: number;
  /** Sum over the epics that declare a budget; null when none does. */
  budget: number | null;
  /** Results that did not report their token usage. */
  unmeasured: number;
}

/** The same fold the server's per-project summary does, over any epic list. */
export function sumTokens(epics: EpicTokenSpend[]): TokenTotals {
  let spent = 0;
  let budget: number | null = null;
  let unmeasured = 0;
  for (const e of epics) {
    spent += e.tokensSpent;
    unmeasured += e.unmeasured;
    if (e.tokensBudget !== null) budget = (budget ?? 0) + e.tokensBudget;
  }
  return { spent, budget, unmeasured };
}

/**
 * An epic whose spend is this many times its budget reads as a bookkeeping
 * error rather than a real overrun (§4.1 point 4's example: 107M against a
 * 1.185M budget, about 90x). The spec names the case but no threshold.
 */
export const OUTLIER_BUDGET_MULTIPLE = 10;

export function isBudgetOutlier(e: EpicTokenSpend): boolean {
  return (
    e.tokensBudget !== null &&
    e.tokensBudget > 0 &&
    e.tokensSpent > e.tokensBudget * OUTLIER_BUDGET_MULTIPLE
  );
}

/** Budget totals with outliers kept out of the percentage and listed apart. */
export function budgetSummary(
  epics: EpicTokenSpend[],
): TokenTotals & { outliers: EpicTokenSpend[] } {
  const outliers = epics.filter(isBudgetOutlier);
  return { ...sumTokens(epics.filter((e) => !isBudgetOutlier(e))), outliers };
}

/** "4 points lower than an hour ago" (audit item 4), never "4pp". */
export function budgetDeltaSentence(delta: number | null): string | null {
  if (delta === null) return null;
  const points = Math.round(Math.abs(delta));
  if (points === 0) return 'Same as an hour ago';
  return `${pluralize(points, 'point')} ${delta > 0 ? 'higher' : 'lower'} than an hour ago`;
}

/** "296 steps did not report their cost", never "296 not measured". */
export function unmeasuredSentence(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? '1 step did not report its cost'
    : `${count} steps did not report their cost`;
}

/** "127M of 180M tokens" (audit item 4), or the spend alone without a budget. */
export function tokensOfBudget(t: TokenTotals): string {
  const spent = formatCompactNumber(t.spent);
  return t.budget === null
    ? `${spent} tokens, no budget set`
    : `${spent} of ${formatCompactNumber(t.budget)} tokens`;
}

/** The ProgressRing's accessible label, e.g. "103% of token budget used, over budget". */
export function budgetRingLabel(spent: number, budget: number): string {
  const pct = Math.round((spent / budget) * 100);
  return `${pct}% of token budget used${spent > budget ? ', over budget' : ''}`;
}

/** "1 epic has a suspicious total: epic-a." — the outlier flag's sentence. */
export function outlierSentence(epicIds: readonly string[]): string | null {
  if (epicIds.length === 0) return null;
  const names = epicIds.join(', ');
  return epicIds.length === 1
    ? `1 epic has a suspicious total: ${names}.`
    : `${epicIds.length} epics have suspicious totals: ${names}.`;
}

export interface CardTokens extends TokenTotals {
  /** The running epics kept out of the ratio by isBudgetOutlier. */
  outliers: string[];
}

export interface RunningCard {
  project: string;
  workingAgents: number;
  epics: string[];
  tokens: CardTokens;
}

/**
 * The card is about work in flight, so its tokens cover only the epics it
 * counts (`epicsActivelyRunning`), and spend and budget are folded over the
 * same set: an epic with no budget adds to neither side, and an outlier is
 * handled by budgetSummary exactly as on the Budget panel.
 */
function cardTokens(all: EpicTokenSpend[], inFlight: string[]): CardTokens {
  const running = new Set(inFlight);
  const budgeted = all.filter((e) => running.has(e.epicId) && e.tokensBudget !== null);
  const { outliers, ...totals } = budgetSummary(budgeted);
  return { ...totals, outliers: outliers.map((e) => e.epicId) };
}

/**
 * The Budget panel: the figures the Running-now cards show, over the same
 * epic set (`epicsActivelyRunning`, which the server already scopes to the
 * selected project). Null when no epic is running, so the panel says so
 * rather than drawing a zero.
 */
export function budgetPanel(o: OverviewResult): CardTokens | null {
  if (o.epicsActivelyRunning.length === 0) return null;
  return cardTokens(o.tokensByEpic, o.epicsActivelyRunning);
}

/** What the Budget panel renders: one quiet line, or the figures. */
export type BudgetView =
  | { kind: 'none'; text: string }
  | {
      kind: 'figures';
      /** Drawn only for a measured ratio; null otherwise. */
      ring: { value: number; max: number; label: string } | null;
      tokensText: string;
      deltaSentence: string | null;
      unmeasuredSentence: string | null;
      outlierSentence: string | null;
    };

/** The Budget panel's decision, so HomePage.vue only renders it. */
export function budgetView(o: OverviewResult): BudgetView {
  const panel = budgetPanel(o);
  if (panel === null) return { kind: 'none', text: 'No epic is running.' };
  return {
    kind: 'figures',
    ring:
      panel.budget && cardShowsRing(panel)
        ? {
            value: panel.spent,
            max: panel.budget,
            label: budgetRingLabel(panel.spent, panel.budget),
          }
        : null,
    tokensText: cardTokensText(panel),
    deltaSentence: budgetDeltaSentence(o.budgetUsedPctPointDelta1h ?? null),
    unmeasuredSentence: unmeasuredSentence(panel.unmeasured),
    outlierSentence: outlierSentence(panel.outliers),
  };
}

/**
 * "84K of 350K tokens"; never "0 of" for spend nobody measured, which reads
 * "not measured · 4.1M budget" instead. Empty while the only budgeted epics
 * are outliers (the card's outlier sentence says so).
 */
export function cardTokensText(t: CardTokens): string {
  if (t.budget === null) return t.outliers.length > 0 ? '' : 'No budget set';
  if (t.spent === 0 && t.unmeasured > 0) {
    return `${formatBudgetPct(t.spent, t.budget, t.unmeasured)} · ${formatCompactNumber(t.budget)} budget`;
  }
  return tokensOfBudget(t);
}

/** The card's ring is drawn only for a measured ratio. */
export function cardShowsRing(t: CardTokens): boolean {
  return t.budget !== null && t.budget > 0 && !(t.spent === 0 && t.unmeasured > 0);
}

function isRunning(workingAgents: number, epics: string[]): boolean {
  return workingAgents > 0 || epics.length > 0;
}

/**
 * One card per project with work in flight or agents working. Unscoped, the
 * overview carries a per-project summary; scoped to one project it does not,
 * so that project's single card is built from the scoped per-epic spend.
 */
export function runningNowCards(o: OverviewResult, project?: string): RunningCard[] {
  if (project !== undefined) {
    if (!isRunning(o.workingAgentCount, o.epicsActivelyRunning)) return [];
    return [
      {
        project,
        workingAgents: o.workingAgentCount,
        epics: o.epicsActivelyRunning,
        tokens: cardTokens(o.tokensByEpic, o.epicsActivelyRunning),
      },
    ];
  }
  return (o.projects ?? [])
    .filter((p) => isRunning(p.workingAgentCount, p.epicsActivelyRunning))
    .map((p) => ({
      project: p.project,
      workingAgents: p.workingAgentCount,
      epics: p.epicsActivelyRunning,
      tokens: cardTokens(p.tokensByEpic, p.epicsActivelyRunning),
    }));
}

/** How long a closed epic stays under "Just finished" on a fresh load (F3). */
const JUST_FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * "Just finished" (§4.1 point 2): closed epics this tab saw in flight
 * earlier, plus (F3) anything closed in the last 24h regardless of session
 * state — a tab opened fresh the morning after a close starts with an empty
 * `seen` and would otherwise never show it. Records the current in-flight
 * set into `seen` as it goes, so the caller keeps one set for the life of
 * the page session.
 */
export function trackJustFinished(
  seen: Set<string>,
  o: OverviewResult,
  now: number = Date.now(),
): ClosedEpic[] {
  for (const id of o.epicsInFlight) seen.add(id);
  const inFlight = new Set(o.epicsInFlight);
  return o.closedEpics.filter(
    (e) =>
      !inFlight.has(e.epicId) &&
      (seen.has(e.epicId) || now - new Date(e.closedAt).getTime() < JUST_FINISHED_WINDOW_MS),
  );
}

/** A decision line; when no reason was recorded, the task and round stand in. */
export function decisionLine(d: RecentDispatch): string {
  const fallback = d.taskId ? `on ${taskLabel(d.taskId)}, round ${d.round}` : `round ${d.round}`;
  return dispatchDecisionLine({ ...d, reason: d.reason ?? fallback });
}
