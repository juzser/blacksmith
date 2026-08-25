// factory/policies/budgets.yml loader. Same parse-with-defaults pattern as
// crosscheck.ts/scheduler.ts: a RawXYaml on-disk snake_case shape mapped onto a
// typed camelCase policy.
//
// `epic.cap_tokens` is the field src/planQuorum.ts's budget trigger
// (crosscheck.yml plan_quorum.budget_ratio) reads, via the sum of *declared*
// task budgets. The per-role caps below are modeled as of P9-18 so the gate can
// compare a declared task budget against what the task actually spent — see
// checkTaskBudget. `escalation_ladder` is parsed as of P9-32 and asserted
// against the event log by src/escalation.ts. `context_window` and
// `effort_scaling` are still prompt-level: agents read them from their own
// templates, and nothing here parses them.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { BUDGETS_POLICY_PATH } from './paths.js';

export class BudgetError extends SmithError {}

export interface EpicBudgetPolicy {
  capTokens: number;
  alarmRatio: number;
}

export interface RoleBudgetPolicy {
  capTokens: number;
}

export interface CoderBudgetPolicy extends RoleBudgetPolicy {
  capDiffLines: number;
}

export interface TaskBudgetPolicy {
  coder: CoderBudgetPolicy;
  researcher: RoleBudgetPolicy;
  judges: RoleBudgetPolicy;
}

export interface PreCodeBudgetPolicy {
  shareOfEpicBudgetMax: number;
}

/**
 * One rung of `escalation_ladder.rungs`, loaded verbatim (P9-32).
 *
 * This loader stays dumb on purpose — it maps the on-disk shape and validates
 * nothing beyond types, exactly as it does for every other block. `enforce`
 * is a bare string, not the closed union: src/escalation.ts owns the set of
 * keywords it can act on, and an unrecognised one has to reach it as itself so
 * the audit can report `unverifiable` instead of silently reading as "this
 * rung declares no obligation".
 *
 * `failedRounds` is null when the rung declares no numeric threshold, and the
 * rung is kept rather than dropped for the same reason: a rung nobody can
 * evaluate is a finding, not an absence.
 */
export interface EscalationRung {
  rung: number;
  /** `failed_rounds`, or null when the rung declares no numeric threshold. */
  failedRounds: number | null;
  trigger: string;
  /** The obligation this rung imposes, in prose; null when it imposes none. */
  action: string | null;
  /** Machine-readable form of `action` — see src/escalation.ts. */
  enforce: string | null;
}

export interface BudgetPolicy {
  epic: EpicBudgetPolicy;
  task: TaskBudgetPolicy;
  preCodeBudget: PreCodeBudgetPolicy;
  /** Ascending by threshold; empty when budgets.yml declares no ladder. */
  escalationLadder: EscalationRung[];
}

interface RawEscalationRung {
  rung?: unknown;
  failed_rounds?: unknown;
  trigger?: unknown;
  action?: unknown;
  enforce?: unknown;
}

interface RawBudgetsYaml {
  epic?: { cap_tokens?: number; alarm_ratio?: number };
  task?: {
    coder?: { cap_tokens?: number; cap_diff_lines?: number };
    researcher?: { cap_tokens?: number };
    judges?: { cap_tokens?: number };
  };
  pre_code_budget?: { share_of_epic_budget_max?: number };
  escalation_ladder?: { rungs?: RawEscalationRung[] };
}

/**
 * Deliberately NOT the number budgets.yml declares (4,000,000 since
 * 2026-08-11) — the one default here that does not mirror the policy file.
 *
 * The other DEFAULT_* constants below match budgets.yml because nobody has
 * ever had cause to diverge them. This one has cause: the repo's cap was
 * raised by an operator decision sized from a single dogfood epic that
 * measured 1,529,963 tokens for two of four tasks, a figure inflated by
 * rework `smith escalation check` recorded as ladder violations. That is a
 * judgement about this repo's epics, not a floor to hand a project that
 * shipped no policy at all — such a project gets the conservative number and
 * an alarm that fires early, which is the failure direction to prefer.
 *
 * Do not "fix" the mismatch by syncing them.
 */
const DEFAULT_EPIC_CAP_TOKENS = 2_000_000;
const DEFAULT_EPIC_ALARM_RATIO = 0.7;
const DEFAULT_CODER_CAP_TOKENS = 150_000;
const DEFAULT_CODER_CAP_DIFF_LINES = 400;
const DEFAULT_RESEARCHER_CAP_TOKENS = 60_000;
const DEFAULT_JUDGES_CAP_TOKENS = 40_000;
const DEFAULT_PRE_CODE_SHARE_MAX = 0.15;

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The ladder in ascending threshold order.
 *
 * There is no default ladder. A budgets.yml that declares none yields `[]`,
 * and src/escalation.ts reports that as unverifiable — inventing the three
 * rungs here would let a policy file nobody wrote produce a clean audit.
 * Rungs with no numeric threshold sort last, after every rung that has one.
 */
function parseEscalationLadder(raw: RawEscalationRung[] | undefined): EscalationRung[] {
  const rungs = (raw ?? []).map((entry, index) => ({
    rung: typeof entry.rung === 'number' ? entry.rung : index + 1,
    failedRounds: typeof entry.failed_rounds === 'number' ? entry.failed_rounds : null,
    trigger: optionalString(entry.trigger) ?? '',
    action: optionalString(entry.action),
    enforce: optionalString(entry.enforce),
  }));
  return rungs.sort((a, b) => {
    if (a.failedRounds === b.failedRounds) return a.rung - b.rung;
    if (a.failedRounds === null) return 1;
    if (b.failedRounds === null) return -1;
    return a.failedRounds - b.failedRounds;
  });
}

/**
 * Every cap, checked rather than trusted -- the same guard crosscheck.ts and
 * scheduler.ts carry for their own policy files, and the likeliest of the
 * three to actually be typed: `200k` and `80%` are how a human writes these
 * numbers everywhere except here.
 *
 * `??` fills in on null/undefined only, so a YAML typo arrived at the
 * comparison as itself while the declared type still said `number`. Nothing
 * threw, and a cap that no comparison can read is not a loose cap -- it is no
 * cap at all:
 *
 *   - `cap_tokens: 200k` -- `10_000_000 >= '200k'` is false, so an epic ten
 *     times over budget is reported `under`.
 *   - `alarm_ratio: 80%` -- checkBudgetAlarm computes
 *     `Math.floor(capTokens * alarmRatio)`, so the alarm threshold is NaN and
 *     every comparison against it is false.
 *   - `cap_diff_lines: four hundred` -- a 99,999-line diff is under cap.
 *
 * The alarm case is the one that outlives its typo: NaN serialises to null,
 * so the report records that there was no alarm threshold rather than that
 * the policy could not be read. Same reason cli.ts refuses a `--now` it
 * cannot parse instead of writing `Math.floor(NaN)` into an append-only log
 * (D-209).
 *
 * A wrong *number* still passes: a 10-token cap stops the very first task and
 * says so. A wrong *type* stops nothing and says nothing.
 */
const NO_CAP_AT_ALL = 'A cap the comparison cannot read is not a loose cap, it is no cap at all.';

function capNumber(field: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BudgetError(
      'budgets.invalid-policy',
      `budgets.yml ${field} must be a finite number; got ${JSON.stringify(value)}. ${NO_CAP_AT_ALL}`,
      { field, value },
    );
  }
  return value;
}

export function parseBudgetPolicy(yamlText: string): BudgetPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawBudgetsYaml;
  return {
    epic: {
      capTokens: capNumber('epic.cap_tokens', doc.epic?.cap_tokens ?? DEFAULT_EPIC_CAP_TOKENS),
      alarmRatio: capNumber('epic.alarm_ratio', doc.epic?.alarm_ratio ?? DEFAULT_EPIC_ALARM_RATIO),
    },
    task: {
      coder: {
        capTokens: capNumber(
          'task.coder.cap_tokens',
          doc.task?.coder?.cap_tokens ?? DEFAULT_CODER_CAP_TOKENS,
        ),
        capDiffLines: capNumber(
          'task.coder.cap_diff_lines',
          doc.task?.coder?.cap_diff_lines ?? DEFAULT_CODER_CAP_DIFF_LINES,
        ),
      },
      researcher: {
        capTokens: capNumber(
          'task.researcher.cap_tokens',
          doc.task?.researcher?.cap_tokens ?? DEFAULT_RESEARCHER_CAP_TOKENS,
        ),
      },
      judges: {
        capTokens: capNumber(
          'task.judges.cap_tokens',
          doc.task?.judges?.cap_tokens ?? DEFAULT_JUDGES_CAP_TOKENS,
        ),
      },
    },
    preCodeBudget: {
      shareOfEpicBudgetMax: capNumber(
        'pre_code_budget.share_of_epic_budget_max',
        doc.pre_code_budget?.share_of_epic_budget_max ?? DEFAULT_PRE_CODE_SHARE_MAX,
      ),
    },
    escalationLadder: parseEscalationLadder(doc.escalation_ladder?.rungs),
  };
}

export function loadBudgetPolicy(filePath: string = BUDGETS_POLICY_PATH): BudgetPolicy {
  return parseBudgetPolicy(readFileSync(filePath, 'utf8'));
}

/** A task spec's `budget` block, in the plan's own snake_case shape. */
export interface TaskBudget {
  tokens: number;
  diff_lines: number;
  max_turns?: number;
}

/**
 * For each field a task budget may declare, the mechanism that reads it — or
 * `null` when nothing does.
 *
 * This registry exists so the answer is checkable rather than remembered.
 * D-29's finding was that all three fields looked enforced and none were; the
 * fix is not only to wire two of them up but to make the third's emptiness
 * visible, so plan validation can say "you wrote down a limit nobody can
 * apply" instead of the plan quietly implying otherwise.
 *
 * `max_turns` is null on purpose, and not because the wiring is pending: a turn
 * limit has to live in the dispatch harness, and the Agent tool exposes no
 * turns parameter (agent-interviews.md M-4, answered (c) on 2026-08-05 — the
 * number is carried into the dispatch prompt by the /bs skill, where it is a
 * request to the agent, not a limit on it).
 */
export const TASK_BUDGET_FIELD_READERS: Readonly<Record<keyof TaskBudget, string | null>> =
  Object.freeze({
    tokens: 'gate: compared against the result’s token_usage.total_tokens',
    diff_lines: 'gate: compared against the measured git diff (src/diffstat.ts)',
    max_turns: null,
  });

/**
 * Which of the fields this budget declares have no mechanical reader. Order
 * follows TASK_BUDGET_FIELD_READERS so the message is stable.
 */
export function unreadTaskBudgetFields(budget: TaskBudget): string[] {
  return (Object.keys(TASK_BUDGET_FIELD_READERS) as (keyof TaskBudget)[]).filter(
    (field) => budget[field] !== undefined && TASK_BUDGET_FIELD_READERS[field] === null,
  );
}

export interface BudgetOverrun {
  field: 'tokens' | 'diff_lines';
  cap: number;
  measured: number;
}

export interface TaskBudgetCheckInput {
  budget: TaskBudget;
  /** Total tokens the task actually spent, from the result's token_usage. */
  tokensUsed?: number;
  /** Authored lines changed, from src/diffstat.ts. */
  diffLines?: number;
}

/**
 * Declared budget vs. what the task actually spent.
 *
 * A field with no measurement is skipped rather than compared against zero: an
 * unmeasured budget and a budget that came in at nothing are different facts,
 * and only one of them is evidence of anything. Spend exactly at the cap is
 * within it — a cap of 400 permits 400.
 */
export function checkTaskBudget(input: TaskBudgetCheckInput): BudgetOverrun[] {
  const overruns: BudgetOverrun[] = [];
  const { budget, tokensUsed, diffLines } = input;

  if (tokensUsed !== undefined && tokensUsed > budget.tokens) {
    overruns.push({ field: 'tokens', cap: budget.tokens, measured: tokensUsed });
  }
  if (diffLines !== undefined && diffLines > budget.diff_lines) {
    overruns.push({ field: 'diff_lines', cap: budget.diff_lines, measured: diffLines });
  }
  return overruns;
}
