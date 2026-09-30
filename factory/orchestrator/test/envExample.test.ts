/**
 * `.env.example` lists every SMITH_* tuning knob at its shipped default, so
 * the default now lives in two places: budgets.yml (or the agent template's
 * `maxTurns:`) and this file. This guard is what keeps the second copy from
 * drifting off the first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncAgentMaxTurns } from '../src/agentsSync.js';
import { BUDGET_ENV_VARS, type BudgetPolicy, parseBudgetPolicy } from '../src/budgets.js';
import { AGENTS_DIR, BUDGETS_POLICY_PATH, REPO_ROOT } from '../src/paths.js';

const assignments = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8')
  .split('\n')
  .map((line) => /^(SMITH_[A-Z0-9_]+)=(.*)$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => ({ name: m[1] as string, value: m[2] as string }));

const MAXTURNS = 'SMITH_MAXTURNS_';
const budgetLines = assignments.filter((a) => !a.name.startsWith(MAXTURNS));
const maxTurnsLines = assignments.filter((a) => a.name.startsWith(MAXTURNS));

// Parsed, not loaded: loadBudgetPolicy lays the running process's env on top,
// and this compares against the committed file alone. One policy per tier.
const policyText = readFileSync(BUDGETS_POLICY_PATH, 'utf8');
const shippedByTier = {
  small: parseBudgetPolicy(policyText, 'small'),
  medium: parseBudgetPolicy(policyText, 'medium'),
  huge: parseBudgetPolicy(policyText, 'huge'),
} as const;
const TIERS = ['small', 'medium', 'huge'] as const;
const shippedText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

const BUDGET_DEFAULT: Record<string, (p: BudgetPolicy) => number | null> = {
  SMITH_EPIC_CAP_TOKENS: (p) => p.epic.capTokens,
  SMITH_EPIC_ALARM_RATIO: (p) => p.epic.alarmRatio,
  SMITH_EPIC_MAX_IN_FLIGHT_TASKS: (p) => p.epic.maxInFlightTasks,
  SMITH_TASK_CODER_CAP_TOKENS: (p) => p.task.coder.capTokens,
  SMITH_TASK_CODER_CAP_DIFF_LINES: (p) => p.task.coder.capDiffLines,
  SMITH_TASK_TESTER_CAP_TOKENS: (p) => p.task.tester.capTokens,
  SMITH_TASK_PLANNER_CAP_TOKENS: (p) => p.task.planner.capTokens,
  SMITH_TASK_RESEARCHER_CAP_TOKENS: (p) => p.task.researcher.capTokens,
  SMITH_TASK_SPEC_REVIEWER_CAP_TOKENS: (p) => p.task['spec-reviewer'].capTokens,
  SMITH_TASK_GRADER_CAP_TOKENS: (p) => p.task.grader.capTokens,
  SMITH_TASK_REVIEWER_CAP_TOKENS: (p) => p.task.reviewer.capTokens,
  SMITH_TASK_VERIFIER_CAP_TOKENS: (p) => p.task.verifier.capTokens,
  SMITH_TASK_SECURITY_REVIEWER_CAP_TOKENS: (p) => p.task['security-reviewer'].capTokens,
  SMITH_TASK_AUDITOR_CAP_TOKENS: (p) => p.task.auditor.capTokens,
};

describe('.env.example budget knobs', () => {
  it('lists exactly the budget names the code accepts, once each', () => {
    const names = budgetLines.map((a) => a.name);
    expect([...names].sort()).toEqual([...BUDGET_ENV_VARS].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(BUDGET_DEFAULT).sort()).toEqual([...BUDGET_ENV_VARS].sort());
  });

  // A bare name pins every tier, so a copied .env.example that set one would
  // flatten small and huge onto the medium number. Each ships empty.
  it('ships every bare name empty, so copying the file overrides nothing', () => {
    for (const { name, value } of budgetLines) {
      expect(value, name).toBe('');
    }
  });
});

describe('.env.example per-tier budget knobs', () => {
  const text = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  const commented = new Set(
    text
      .split('\n')
      .map((line) => /^# ?(SMITH_[A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  );

  const commentedValue = new Map(
    text
      .split('\n')
      .map((line) => /^# ?(SMITH_[A-Z0-9_]+)=(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] as string, m[2] as string]),
  );

  it("shows each tier variant at that tier's budgets.yml value (empty where null)", () => {
    for (const name of BUDGET_ENV_VARS) {
      const read = BUDGET_DEFAULT[name];
      expect(read, name).toBeDefined();
      for (const tier of TIERS) {
        const variant = `${name}_${tier.toUpperCase()}`;
        expect(commentedValue.get(variant), variant).toBe(shippedText(read?.(shippedByTier[tier])));
      }
    }
  });

  it('lists every budget name with its _SMALL / _MEDIUM / _HUGE variant, commented out', () => {
    for (const name of BUDGET_ENV_VARS) {
      for (const suffix of ['_SMALL', '_MEDIUM', '_HUGE']) {
        expect(commented.has(`${name}${suffix}`), `${name}${suffix}`).toBe(true);
        expect(
          assignments.some((a) => a.name === `${name}${suffix}`),
          `${name}${suffix}`,
        ).toBe(false);
      }
    }
  });
});

describe('.env.example maxTurns knobs', () => {
  const templates = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort();

  it('has exactly one SMITH_MAXTURNS_* line per role template, and none for a non-role', () => {
    const names = maxTurnsLines.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(
      templates.map((role) => `${MAXTURNS}${role.toUpperCase().replaceAll('-', '_')}`).sort(),
    );
  });

  it("carries each role at its template's committed maxTurns", () => {
    for (const role of templates) {
      const text = readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
      const committed = /^maxTurns: (\d+)$/m.exec(text.split(/^---$/m)[1] ?? '')?.[1];
      const line = maxTurnsLines.find(
        (a) => a.name === `${MAXTURNS}${role.toUpperCase().replaceAll('-', '_')}`,
      );
      expect(line?.value, role).toBe(committed);
    }
  });

  it('is a no-op for `smith agents sync` on the shipped templates', () => {
    const env = Object.fromEntries(maxTurnsLines.map((a) => [a.name, a.value]));
    const report = syncAgentMaxTurns({ agentsDir: AGENTS_DIR, env, dryRun: true });
    expect(report.changes.length).toBe(templates.length);
    expect(report.changes.filter((c) => c.changed)).toEqual([]);
  });
});
