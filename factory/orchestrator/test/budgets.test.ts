import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BudgetError,
  checkTaskBudget,
  loadBudgetPolicy,
  parseBudgetPolicy,
  TASK_BUDGET_FIELD_READERS,
  unreadTaskBudgetFields,
} from '../src/budgets.js';
import { BUDGETS_POLICY_PATH } from '../src/paths.js';

describe('budgets.ts', () => {
  it('parses the real repo budgets.yml', () => {
    const policy = loadBudgetPolicy();
    // Raised from 2,000,000 by operator decision 2026-08-11; see the comment
    // on budgets.yml's `epic.cap_tokens` for the measurement behind it.
    expect(policy.epic).toEqual({
      capTokens: 4_000_000,
      alarmRatio: 0.7,
      maxInFlightTasks: null,
    });
  });

  it('loadBudgetPolicy() reads the same file BUDGETS_POLICY_PATH points to', () => {
    const text = readFileSync(BUDGETS_POLICY_PATH, 'utf8');
    expect(parseBudgetPolicy(text)).toEqual(loadBudgetPolicy());
  });

  it('defaults epic.cap_tokens to the conservative floor, NOT to the repo cap', () => {
    const policy = parseBudgetPolicy('other_key: true\n');
    // 2,000,000 on purpose while budgets.yml declares 4,000,000: the fallback
    // serves a project that shipped no policy, and it should alarm early
    // rather than inherit a ceiling this repo raised for its own reasons.
    // The divergence is documented at DEFAULT_EPIC_CAP_TOKENS. Not a bug.
    expect(policy.epic).toEqual({
      capTokens: 2_000_000,
      alarmRatio: 0.7,
      maxInFlightTasks: null,
    });
    expect(loadBudgetPolicy().epic.capTokens).not.toEqual(policy.epic.capTokens);
  });
});

describe('epic.max_in_flight_tasks', () => {
  // The one field allowed to say "no cap" rather than declare a number, so it
  // is the one field where an unreadable value could pass for the deliberate
  // null and silently switch `smith wave check`'s fan-out gate off.

  it('reads a declared number', () => {
    expect(parseBudgetPolicy('epic:\n  max_in_flight_tasks: 6\n').epic.maxInFlightTasks).toBe(6);
  });

  it('keeps an explicit null as null, the documented "no fan-out limit"', () => {
    expect(
      parseBudgetPolicy('epic:\n  max_in_flight_tasks: null\n').epic.maxInFlightTasks,
    ).toBeNull();
  });

  it('treats an absent field as null too, so a policy predating it still parses', () => {
    expect(parseBudgetPolicy('epic:\n  cap_tokens: 10\n').epic.maxInFlightTasks).toBeNull();
  });

  it('rejects a value that is neither a number nor null, rather than reading it as null', () => {
    // `'none'` and `'6'` are both how a human writes this by hand. Read as
    // null, either would turn the fan-out gate off while the file says it is
    // on -- the failure mode the other cap fields throw to avoid.
    expect(() => parseBudgetPolicy('epic:\n  max_in_flight_tasks: none\n')).toThrow(BudgetError);
    expect(() => parseBudgetPolicy("epic:\n  max_in_flight_tasks: '6'\n")).toThrow(
      /epic\.max_in_flight_tasks.*"6"/s,
    );
  });
});

describe('per-role caps (P9-18)', () => {
  it('models the caps budgets.yml declares, so they can be compared to something', () => {
    const policy = loadBudgetPolicy();
    expect(policy.task).toEqual({
      coder: { capTokens: 150_000, capDiffLines: 400 },
      researcher: { capTokens: 60_000 },
      judges: { capTokens: 40_000 },
    });
    expect(policy.preCodeBudget).toEqual({ shareOfEpicBudgetMax: 0.15 });
  });

  it('falls back to the documented numbers when the blocks are absent', () => {
    const policy = parseBudgetPolicy('epic:\n  cap_tokens: 10\n');
    expect(policy.task.coder).toEqual({ capTokens: 150_000, capDiffLines: 400 });
    expect(policy.preCodeBudget.shareOfEpicBudgetMax).toBe(0.15);
  });
});

describe('TASK_BUDGET_FIELD_READERS (P9-18)', () => {
  it('names, for each budget field, the mechanism that actually reads it', () => {
    expect(TASK_BUDGET_FIELD_READERS.tokens).toEqual(expect.stringContaining('token_usage'));
    expect(TASK_BUDGET_FIELD_READERS.diff_lines).toEqual(expect.stringContaining('diff'));
  });

  it('records max_turns as having no reader: nothing in the factory can enforce it', () => {
    expect(TASK_BUDGET_FIELD_READERS.max_turns).toBeNull();
  });

  it('lists the fields a plan declares that nothing can enforce', () => {
    expect(unreadTaskBudgetFields({ tokens: 150_000, diff_lines: 400, max_turns: 30 })).toEqual([
      'max_turns',
    ]);
    expect(unreadTaskBudgetFields({ tokens: 150_000, diff_lines: 400 })).toEqual([]);
  });
});

describe('checkTaskBudget (P9-18)', () => {
  const budget = { tokens: 150_000, diff_lines: 400 };

  it('finds nothing when measured spend is under both caps', () => {
    expect(checkTaskBudget({ budget, tokensUsed: 90_000, diffLines: 120 })).toEqual([]);
  });

  it('treats spend exactly at the cap as within budget', () => {
    expect(checkTaskBudget({ budget, tokensUsed: 150_000, diffLines: 400 })).toEqual([]);
  });

  it('reports the token overrun with both numbers, not just a boolean', () => {
    expect(checkTaskBudget({ budget, tokensUsed: 150_001, diffLines: 10 })).toEqual([
      { field: 'tokens', cap: 150_000, measured: 150_001 },
    ]);
  });

  it('reports a diff overrun the same way', () => {
    expect(checkTaskBudget({ budget, tokensUsed: 10, diffLines: 981 })).toEqual([
      { field: 'diff_lines', cap: 400, measured: 981 },
    ]);
  });

  it('reports both when both blew, in declaration order', () => {
    expect(checkTaskBudget({ budget, tokensUsed: 200_000, diffLines: 981 })).toEqual([
      { field: 'tokens', cap: 150_000, measured: 200_000 },
      { field: 'diff_lines', cap: 400, measured: 981 },
    ]);
  });

  it('skips a field it has no measurement for, rather than reading absent as zero', () => {
    expect(checkTaskBudget({ budget })).toEqual([]);
    expect(checkTaskBudget({ budget, diffLines: 981 })).toEqual([
      { field: 'diff_lines', cap: 400, measured: 981 },
    ]);
  });

  // Third instance of the class crosscheck.yml and scheduler.yml were just
  // held to, and the likeliest one to actually be typed: `200k` and `80%` are
  // how a human writes these numbers everywhere else. Each case below was
  // reproduced against the real parse before it was written.

  it('rejects a cap_tokens no comparison can read (nothing is ever over cap)', () => {
    // `10_000_000 >= '200k'` is false, so an epic ten times over its cap is
    // reported `under`. The cap does not loosen -- it stops existing.
    expect(() => parseBudgetPolicy('epic:\n  cap_tokens: 200k\n')).toThrow(BudgetError);
  });

  it('rejects an alarm_ratio that makes the threshold NaN, which persists as null', () => {
    // checkBudgetAlarm computes `Math.floor(capTokens * alarmRatio)` and puts
    // it in the report. `Math.floor(NaN)` serialises to null, so the record
    // says there was no alarm threshold and outlives the typo that made it.
    expect(() => parseBudgetPolicy('epic:\n  alarm_ratio: 80%\n')).toThrow(BudgetError);
  });

  it('rejects an unreadable per-role cap, on every role that declares one', () => {
    expect(() => parseBudgetPolicy('task:\n  coder:\n    cap_tokens: 50k\n')).toThrow(BudgetError);
    expect(() => parseBudgetPolicy('task:\n  coder:\n    cap_diff_lines: four hundred\n')).toThrow(
      BudgetError,
    );
    expect(() => parseBudgetPolicy('task:\n  researcher:\n    cap_tokens: 60k\n')).toThrow(
      BudgetError,
    );
    expect(() => parseBudgetPolicy('task:\n  judges:\n    cap_tokens: 40k\n')).toThrow(BudgetError);
    expect(() => parseBudgetPolicy('pre_code_budget:\n  share_of_epic_budget_max: 15%\n')).toThrow(
      BudgetError,
    );
  });

  it('names the field and the value, because the policy file is hand-edited', () => {
    expect(() => parseBudgetPolicy('epic:\n  cap_tokens: 200k\n')).toThrow(
      /epic\.cap_tokens.*"200k"/s,
    );
  });

  it('still accepts a document that omits every knob', () => {
    // The check is on the value a knob has, not on the knob being present:
    // every default below is what `??` supplies, and all of them must survive.
    const policy = parseBudgetPolicy('escalation_ladder:\n  rungs: []\n');
    expect(policy.epic.capTokens).toBe(2_000_000);
    expect(policy.epic.alarmRatio).toBe(0.7);
    expect(policy.task.coder.capDiffLines).toBe(400);
    expect(policy.preCodeBudget.shareOfEpicBudgetMax).toBe(0.15);
  });
});
