import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_BUDGET_ENV_NAMES,
  applyBudgetEnv,
  BUDGET_ENV_VARS,
  BudgetError,
  budgetEnvOverrides,
  checkTaskBudget,
  LEGACY_BUDGET_ENV_VARS,
  loadBudgetPolicy,
  PRICED_ROLES,
  parseBudgetPolicy,
  resolveBudgetTier,
  roleCapTokens,
  TASK_BUDGET_FIELD_READERS,
  unreadTaskBudgetFields,
} from '../src/budgets.js';
import { loadEffortPolicy } from '../src/effort.js';
import { BUDGETS_POLICY_PATH } from '../src/paths.js';

describe('budgets.ts', () => {
  it('parses the real repo budgets.yml', () => {
    const policy = loadBudgetPolicy(undefined, {});
    // The medium (default) tier. Raised from 2,000,000 on 2026-08-11 and to a
    // per-tier triplet on 2026-09-29; see budgets.yml's `epic.cap_tokens`.
    expect(policy.tier).toBe('medium');
    expect(policy.epic).toEqual({
      capTokens: 16_000_000,
      alarmRatio: 0.7,
      maxInFlightTasks: null,
    });
  });

  it('loadBudgetPolicy() reads the same file BUDGETS_POLICY_PATH points to', () => {
    const text = readFileSync(BUDGETS_POLICY_PATH, 'utf8');
    expect(parseBudgetPolicy(text)).toEqual(loadBudgetPolicy(undefined, {}));
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
    expect(loadBudgetPolicy(undefined, {}).epic.capTokens).not.toEqual(policy.epic.capTokens);
  });
});

describe('tier-scaled budgets', () => {
  // The tier is the epic's plan `effort` (effort.yml). budgets.yml declares
  // the medium task numbers once plus a scale, and the epic cap as an
  // explicit triplet.

  it('picks the small, medium and huge numbers from the shipped budgets.yml', () => {
    const small = loadBudgetPolicy(undefined, {}, 'small');
    const medium = loadBudgetPolicy(undefined, {}, 'medium');
    const huge = loadBudgetPolicy(undefined, {}, 'huge');
    expect([small.tier, medium.tier, huge.tier]).toEqual(['small', 'medium', 'huge']);
    expect([small.epic.capTokens, medium.epic.capTokens, huge.epic.capTokens]).toEqual([
      4_000_000, 16_000_000, 32_000_000,
    ]);
    expect(small.task.coder).toEqual({ capTokens: 110_000, capDiffLines: 350 });
    expect(medium.task.coder).toEqual({ capTokens: 220_000, capDiffLines: 700 });
    expect(huge.task.coder).toEqual({ capTokens: 440_000, capDiffLines: 1400 });
    expect(small.task['spec-reviewer'].capTokens).toBe(85_000);
    expect(huge.task['spec-reviewer'].capTokens).toBe(340_000);
    // The alarm ratio and the fan-out cap are not sized by tier.
    expect(small.epic.alarmRatio).toBe(medium.epic.alarmRatio);
    expect(huge.epic.maxInFlightTasks).toBe(medium.epic.maxInFlightTasks);
  });

  it('declares one medium cap per priced role, the judges split apart', () => {
    expect(loadBudgetPolicy(undefined, {}, 'medium').task).toEqual({
      coder: { capTokens: 220_000, capDiffLines: 700 },
      tester: { capTokens: 60_000 },
      planner: { capTokens: 110_000 },
      researcher: { capTokens: 80_000 },
      'spec-reviewer': { capTokens: 170_000 },
      grader: { capTokens: 110_000 },
      reviewer: { capTokens: 60_000 },
      verifier: { capTokens: 40_000 },
      'security-reviewer': { capTokens: 80_000 },
      auditor: { capTokens: 90_000 },
    });
  });

  it('falls back to effort.yml default_tier when the tier is absent or unknown', () => {
    const defaultTier = loadEffortPolicy().defaultTier;
    const expected = loadBudgetPolicy(undefined, {}, defaultTier);
    for (const tier of [undefined, null, '', 'enormous', 'Medium', 3]) {
      expect(resolveBudgetTier(tier)).toBe(defaultTier);
      expect(loadBudgetPolicy(undefined, {}, tier)).toEqual(expected);
    }
    expect(parseBudgetPolicy('').tier).toBe(defaultTier);
  });

  it('scales every task number by the declared scale, and reads a scalar epic cap for every tier', () => {
    const yml =
      'epic:\n  cap_tokens: 1000\ntask_tier_scale:\n  small: 0.25\n  medium: 1\n  huge: 3\n' +
      'task:\n  coder:\n    cap_tokens: 1000\n    cap_diff_lines: 100\n  planner:\n    cap_tokens: 10\n';
    const small = parseBudgetPolicy(yml, 'small');
    const huge = parseBudgetPolicy(yml, 'huge');
    expect(small.epic.capTokens).toBe(1000);
    expect(huge.epic.capTokens).toBe(1000);
    expect(small.task.coder).toEqual({ capTokens: 250, capDiffLines: 25 });
    expect(huge.task.coder).toEqual({ capTokens: 3000, capDiffLines: 300 });
    expect(huge.task.planner.capTokens).toBe(30);
  });

  it('refuses an epic cap triplet that leaves a tier out, and an unreadable scale', () => {
    expect(() =>
      parseBudgetPolicy('epic:\n  cap_tokens:\n    small: 1\n    medium: 2\n', 'huge'),
    ).toThrow(/epic\.cap_tokens\.huge/);
    expect(() => parseBudgetPolicy('task_tier_scale:\n  small: half\n', 'small')).toThrow(
      BudgetError,
    );
  });

  it('refuses an unknown key in an epic cap triplet, naming it', () => {
    const yml = 'epic:\n  cap_tokens:\n    small: 1\n    medium: 2\n    huge: 3\n    hughe: 4\n';
    for (const tier of ['small', 'medium', 'huge']) {
      expect(() => parseBudgetPolicy(yml, tier)).toThrow(BudgetError);
      expect(() => parseBudgetPolicy(yml, tier)).toThrow(/"hughe"/);
    }
  });

  it('refuses an effort.yml whose default_tier is missing or misspelled, re-reading it each call', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'budget-default-tier-'));
    const file = path.join(dir, 'effort.yml');
    try {
      writeFileSync(file, 'default_tier: huge\n');
      expect(resolveBudgetTier(undefined, file)).toBe('huge');
      writeFileSync(file, 'default_tier: small\n');
      expect(resolveBudgetTier(undefined, file)).toBe('small');
      writeFileSync(file, 'default_tier: meduim\n');
      expect(() => resolveBudgetTier(undefined, file)).toThrow(BudgetError);
      expect(() => resolveBudgetTier(undefined, file)).toThrow(/default_tier/);
      writeFileSync(file, 'security_floor: medium\n');
      expect(() => resolveBudgetTier(undefined, file)).toThrow(/default_tier/);
      expect(() => resolveBudgetTier(undefined, path.join(dir, 'missing.yml'))).toThrow(
        BudgetError,
      );
      // A named tier never needs the default.
      expect(resolveBudgetTier('small', path.join(dir, 'missing.yml'))).toBe('small');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('per-role judge caps', () => {
  it('prices each judge from its own cap, not one shared bucket', () => {
    const policy = loadBudgetPolicy(undefined, {}, 'medium');
    expect(roleCapTokens(policy, 'spec-reviewer')).toBe(170_000);
    expect(roleCapTokens(policy, 'grader')).toBe(110_000);
    expect(roleCapTokens(policy, 'reviewer')).toBe(60_000);
    expect(roleCapTokens(policy, 'verifier')).toBe(40_000);
    expect(roleCapTokens(policy, 'security-reviewer')).toBe(80_000);
    expect(roleCapTokens(policy, 'auditor')).toBe(90_000);
  });

  it('prices planner and tester, and leaves the roles budgets.yml does not name unpriced', () => {
    const policy = loadBudgetPolicy(undefined, {}, 'medium');
    expect(roleCapTokens(policy, 'planner')).toBe(110_000);
    expect(roleCapTokens(policy, 'tester')).toBe(60_000);
    for (const role of ['merger', 'uiux', 'scribe', 'wave-runner', 'nobody']) {
      expect(roleCapTokens(policy, role)).toBeNull();
    }
    expect([...PRICED_ROLES].sort()).toEqual(Object.keys(policy.task).sort());
  });

  it('still reads a legacy `task.judges` bucket for the four judges it named', () => {
    const policy = parseBudgetPolicy(
      'task:\n  judges:\n    cap_tokens: 12345\n  grader:\n    cap_tokens: 999\n',
      'medium',
    );
    expect(policy.task['spec-reviewer'].capTokens).toBe(12345);
    expect(policy.task.reviewer.capTokens).toBe(12345);
    expect(policy.task.verifier.capTokens).toBe(12345);
    // A role the file names itself beats the bucket.
    expect(policy.task.grader.capTokens).toBe(999);
    // The bucket never named these.
    expect(policy.task['security-reviewer'].capTokens).toBe(80_000);
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
    const policy = loadBudgetPolicy(undefined, {});
    expect(policy.task.coder).toEqual({ capTokens: 220_000, capDiffLines: 700 });
    expect(policy.task.researcher).toEqual({ capTokens: 80_000 });
    expect(policy.preCodeBudget).toEqual({ shareOfEpicBudgetMax: 0.15 });
  });

  it('falls back to the documented numbers when the blocks are absent', () => {
    const policy = parseBudgetPolicy('epic:\n  cap_tokens: 10\n');
    expect(policy.task.coder).toEqual({ capTokens: 220_000, capDiffLines: 700 });
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
    expect(policy.task.coder.capDiffLines).toBe(700);
    expect(policy.preCodeBudget.shareOfEpicBudgetMax).toBe(0.15);
  });
});

describe('env overrides on top of budgets.yml', () => {
  // budgets.yml is the committed default; a box's `.env` (or its exported
  // shell) may raise or lower a cap for that box alone without editing it.
  const base = parseBudgetPolicy('');

  it('overrides each documented knob, and only that knob', () => {
    const cases: Array<
      [string, string, (p: ReturnType<typeof parseBudgetPolicy>) => unknown, unknown]
    > = [
      ['SMITH_EPIC_CAP_TOKENS', '5000000', (p) => p.epic.capTokens, 5_000_000],
      ['SMITH_EPIC_ALARM_RATIO', '0.85', (p) => p.epic.alarmRatio, 0.85],
      ['SMITH_EPIC_MAX_IN_FLIGHT_TASKS', '4', (p) => p.epic.maxInFlightTasks, 4],
      ['SMITH_TASK_CODER_CAP_TOKENS', '200000', (p) => p.task.coder.capTokens, 200_000],
      ['SMITH_TASK_CODER_CAP_DIFF_LINES', '600', (p) => p.task.coder.capDiffLines, 600],
      ['SMITH_TASK_RESEARCHER_CAP_TOKENS', '90000', (p) => p.task.researcher.capTokens, 90_000],
      ['SMITH_TASK_TESTER_CAP_TOKENS', '61000', (p) => p.task.tester.capTokens, 61_000],
      ['SMITH_TASK_PLANNER_CAP_TOKENS', '111000', (p) => p.task.planner.capTokens, 111_000],
      [
        'SMITH_TASK_SPEC_REVIEWER_CAP_TOKENS',
        '171000',
        (p) => p.task['spec-reviewer'].capTokens,
        171_000,
      ],
      ['SMITH_TASK_GRADER_CAP_TOKENS', '112000', (p) => p.task.grader.capTokens, 112_000],
      ['SMITH_TASK_REVIEWER_CAP_TOKENS', '62000', (p) => p.task.reviewer.capTokens, 62_000],
      ['SMITH_TASK_VERIFIER_CAP_TOKENS', '41000', (p) => p.task.verifier.capTokens, 41_000],
      [
        'SMITH_TASK_SECURITY_REVIEWER_CAP_TOKENS',
        '81000',
        (p) => p.task['security-reviewer'].capTokens,
        81_000,
      ],
      ['SMITH_TASK_AUDITOR_CAP_TOKENS', '91000', (p) => p.task.auditor.capTokens, 91_000],
    ];
    expect(cases.map(([name]) => name).sort()).toEqual([...BUDGET_ENV_VARS].sort());
    for (const [name, value, read, expected] of cases) {
      const policy = applyBudgetEnv(base, { [name]: value });
      expect(read(policy)).toBe(expected);
      // Everything else is untouched.
      const again = applyBudgetEnv(policy, {});
      expect(again).toEqual(policy);
    }
  });

  it('leaves the policy exactly as parsed when nothing is set', () => {
    expect(applyBudgetEnv(base, {})).toEqual(base);
  });

  it('treats an empty value as no override', () => {
    expect(applyBudgetEnv(base, { SMITH_EPIC_CAP_TOKENS: '', SMITH_EPIC_ALARM_RATIO: '' })).toEqual(
      base,
    );
  });

  it('does not mutate the policy it was given', () => {
    const copy = structuredClone(base);
    applyBudgetEnv(base, { SMITH_EPIC_CAP_TOKENS: '9' });
    expect(base).toEqual(copy);
  });

  it('refuses an integer knob that is not a positive integer', () => {
    for (const bad of ['0', '-5', '4.5', '4e6', '4_000_000', '200k', 'abc', ' 12 x']) {
      expect(() => applyBudgetEnv(base, { SMITH_TASK_CODER_CAP_TOKENS: bad })).toThrow(BudgetError);
    }
  });

  it('refuses a ratio outside (0, 1]', () => {
    for (const bad of ['0', '1.01', '-0.2', '80%', 'NaN', 'Infinity', '']) {
      if (bad === '') continue; // empty is "no override", covered above
      expect(() => applyBudgetEnv(base, { SMITH_EPIC_ALARM_RATIO: bad })).toThrow(BudgetError);
    }
    expect(applyBudgetEnv(base, { SMITH_EPIC_ALARM_RATIO: '1' }).epic.alarmRatio).toBe(1);
  });

  it('names the variable and the bad value in the error, with a stable code', () => {
    try {
      applyBudgetEnv(base, { SMITH_EPIC_CAP_TOKENS: '4M' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetError);
      expect((err as BudgetError).code).toBe('budgets.invalid-env');
      expect((err as Error).message).toMatch(/SMITH_EPIC_CAP_TOKENS.*"4M"/);
    }
  });

  it('lists which names overrode a cap, names only', () => {
    expect(
      budgetEnvOverrides(base, {
        SMITH_EPIC_CAP_TOKENS: '5000000',
        SMITH_TASK_GRADER_CAP_TOKENS: '',
        SMITH_UNRELATED: '1',
      }),
    ).toEqual(['SMITH_EPIC_CAP_TOKENS']);
    expect(budgetEnvOverrides(base, {})).toEqual([]);
  });

  it('does not list a name set to the value budgets.yml already holds', () => {
    // `.env.example` ships every knob at its budgets.yml default, so a copied
    // `.env` sets them all; only a value that differs overrode anything.
    expect(
      budgetEnvOverrides(base, {
        SMITH_EPIC_CAP_TOKENS: String(base.epic.capTokens),
        SMITH_EPIC_ALARM_RATIO: String(base.epic.alarmRatio),
        SMITH_TASK_CODER_CAP_TOKENS: String(base.task.coder.capTokens + 1),
      }),
    ).toEqual(['SMITH_TASK_CODER_CAP_TOKENS']);
  });

  // bs-rename, operator decision 3: BS_<X> is the current name for every one
  // of these knobs, SMITH_<X> still works as a fallback, and BS_ wins when
  // both are set -- through the same envValue() chokepoint, so this holds
  // for every documented knob, not only the one exercised here.
  describe('BS_ names (bs-rename)', () => {
    it('accepts BS_EPIC_CAP_TOKENS in place of SMITH_EPIC_CAP_TOKENS', () => {
      const policy = applyBudgetEnv(base, { BS_EPIC_CAP_TOKENS: '5000000' });
      expect(policy.epic.capTokens).toBe(5_000_000);
    });

    it('prefers BS_EPIC_CAP_TOKENS over SMITH_EPIC_CAP_TOKENS when both are set', () => {
      const policy = applyBudgetEnv(base, {
        BS_EPIC_CAP_TOKENS: '5000000',
        SMITH_EPIC_CAP_TOKENS: '9000000',
      });
      expect(policy.epic.capTokens).toBe(5_000_000);
    });

    it('honours a BS_ tier-suffixed name the same way as its SMITH_ equivalent', () => {
      const huge = parseBudgetPolicy('', 'huge');
      expect(applyBudgetEnv(huge, { BS_EPIC_CAP_TOKENS_HUGE: '32000001' }).epic.capTokens).toBe(
        32_000_001,
      );
    });

    it('is detected as an override when set via BS_EPIC_CAP_TOKENS, reported under the knob\'s budgets.yml name', () => {
      // envValue()'s BS_/SMITH_ aliasing is transparent to supplierFor(): the
      // name reported is still the field's own (still-SMITH_-prefixed) name,
      // not whichever spelling happened to supply the value at runtime.
      expect(budgetEnvOverrides(base, { BS_EPIC_CAP_TOKENS: '5000000' })).toEqual([
        'SMITH_EPIC_CAP_TOKENS',
      ]);
    });
  });
});

describe('env overrides beat the tier', () => {
  it('an unsuffixed value wins over every tier budgets.yml declares', () => {
    for (const tier of ['small', 'medium', 'huge']) {
      const policy = loadBudgetPolicy(
        undefined,
        { SMITH_EPIC_CAP_TOKENS: '7000000', SMITH_TASK_AUDITOR_CAP_TOKENS: '123' },
        tier,
      );
      expect(policy.epic.capTokens).toBe(7_000_000);
      expect(policy.task.auditor.capTokens).toBe(123);
    }
  });
});

describe('per-tier env overrides (<NAME>_SMALL / _MEDIUM / _HUGE)', () => {
  const small = parseBudgetPolicy('', 'small');
  const medium = parseBudgetPolicy('', 'medium');
  const huge = parseBudgetPolicy('', 'huge');

  it('accepts a suffixed name for every budget name, and nothing unsuffixed beyond them', () => {
    for (const name of BUDGET_ENV_VARS) {
      for (const suffix of ['_SMALL', '_MEDIUM', '_HUGE']) {
        expect(ALL_BUDGET_ENV_NAMES).toContain(`${name}${suffix}`);
      }
    }
    for (const name of LEGACY_BUDGET_ENV_VARS) expect(ALL_BUDGET_ENV_NAMES).toContain(name);
  });

  it('a suffixed var beats the unsuffixed one for its own tier', () => {
    const env = { SMITH_EPIC_CAP_TOKENS: '5000000', SMITH_EPIC_CAP_TOKENS_HUGE: '32000001' };
    expect(applyBudgetEnv(huge, env).epic.capTokens).toBe(32_000_001);
    expect(
      applyBudgetEnv(medium, {
        SMITH_TASK_CODER_CAP_DIFF_LINES: '500',
        SMITH_TASK_CODER_CAP_DIFF_LINES_MEDIUM: '650',
      }).task.coder.capDiffLines,
    ).toBe(650);
  });

  it('an unsuffixed var still applies to a tier without a suffixed var of its own', () => {
    const env = { SMITH_EPIC_CAP_TOKENS: '5000000', SMITH_EPIC_CAP_TOKENS_HUGE: '32000001' };
    expect(applyBudgetEnv(small, env).epic.capTokens).toBe(5_000_000);
    expect(applyBudgetEnv(medium, env).epic.capTokens).toBe(5_000_000);
  });

  it('a suffixed var for another tier does not leak into this one', () => {
    const env = { SMITH_EPIC_CAP_TOKENS_SMALL: '1000', SMITH_TASK_GRADER_CAP_TOKENS_HUGE: '9' };
    expect(applyBudgetEnv(medium, env)).toEqual(medium);
    expect(applyBudgetEnv(huge, env).epic.capTokens).toBe(huge.epic.capTokens);
    expect(applyBudgetEnv(huge, env).task.grader.capTokens).toBe(9);
    expect(applyBudgetEnv(small, env).task.grader.capTokens).toBe(small.task.grader.capTokens);
  });

  it('refuses an invalid suffixed value the same way, even for a tier not in play', () => {
    for (const [name, value] of [
      ['SMITH_EPIC_CAP_TOKENS_MEDIUM', '4M'],
      ['SMITH_EPIC_CAP_TOKENS_HUGE', '4M'],
      ['SMITH_EPIC_ALARM_RATIO_SMALL', '80%'],
    ] as const) {
      try {
        applyBudgetEnv(medium, { [name]: value });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetError);
        expect((err as BudgetError).code).toBe('budgets.invalid-env');
        expect((err as Error).message).toContain(name);
      }
    }
  });

  it('lists the name that actually supplied the tier value', () => {
    expect(
      budgetEnvOverrides(huge, {
        SMITH_EPIC_CAP_TOKENS: '5000000',
        SMITH_EPIC_CAP_TOKENS_HUGE: '32000001',
        SMITH_EPIC_CAP_TOKENS_SMALL: '1',
      }),
    ).toEqual(['SMITH_EPIC_CAP_TOKENS_HUGE']);
    expect(budgetEnvOverrides(small, { SMITH_EPIC_CAP_TOKENS_HUGE: '32000001' })).toEqual([]);
  });

  it('reads the legacy judges bucket name below the per-role names', () => {
    const policy = applyBudgetEnv(medium, {
      SMITH_TASK_JUDGES_CAP_TOKENS: '55000',
      SMITH_TASK_GRADER_CAP_TOKENS: '66000',
    });
    expect(policy.task['spec-reviewer'].capTokens).toBe(55_000);
    expect(policy.task.reviewer.capTokens).toBe(55_000);
    expect(policy.task.verifier.capTokens).toBe(55_000);
    expect(policy.task.grader.capTokens).toBe(66_000);
    expect(policy.task.auditor.capTokens).toBe(medium.task.auditor.capTokens);
  });
});

describe('loadBudgetPolicy applies the env overlay', () => {
  it('overrides the file with the env it is given, so every consumer sees it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'smith-budgets-'));
    try {
      const file = path.join(dir, 'budgets.yml');
      writeFileSync(file, 'epic:\n  cap_tokens: 3000000\n  alarm_ratio: 0.5\n');
      expect(loadBudgetPolicy(file, {}).epic.capTokens).toBe(3_000_000);
      const policy = loadBudgetPolicy(file, { SMITH_EPIC_CAP_TOKENS: '6000000' });
      expect(policy.epic.capTokens).toBe(6_000_000);
      expect(policy.epic.alarmRatio).toBe(0.5);
      expect(() => loadBudgetPolicy(file, { SMITH_EPIC_ALARM_RATIO: '2' })).toThrow(BudgetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults the env to process.env', () => {
    const saved = process.env.SMITH_TASK_CODER_CAP_DIFF_LINES;
    process.env.SMITH_TASK_CODER_CAP_DIFF_LINES = '777';
    try {
      expect(loadBudgetPolicy().task.coder.capDiffLines).toBe(777);
    } finally {
      if (saved === undefined) delete process.env.SMITH_TASK_CODER_CAP_DIFF_LINES;
      else process.env.SMITH_TASK_CODER_CAP_DIFF_LINES = saved;
    }
  });
});
