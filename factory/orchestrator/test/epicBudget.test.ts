import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetTierForPlan, epicBudgetPolicies, latestPlan } from '../src/epicBudget.js';
import type { PlanFile } from '../src/plan.js';

const POLICY = `
epic:
  cap_tokens: {small: 1000, medium: 2000, huge: 4000}
task:
  coder: {cap_tokens: 100, cap_diff_lines: 10}
`;

type Task = Record<string, unknown>;

function fixture(): { root: string; specsDir: string; policyFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'epic-budget-'));
  const specsDir = path.join(root, 'specs');
  const write = (
    epicId: string,
    version: number,
    effort: string | undefined,
    tasks: Task[] = [],
  ) => {
    mkdirSync(path.join(specsDir, epicId), { recursive: true });
    writeFileSync(
      path.join(specsDir, epicId, `plan-v${version}.json`),
      JSON.stringify({ epic_id: epicId, version, ...(effort ? { effort } : {}), tasks }),
    );
  };
  write('epic-small', 1, 'medium');
  write('epic-small', 2, 'small', [{ task_id: 'epic-small/t1', case: 'feature' }]);
  write('epic-huge', 1, 'huge');
  write('epic-none', 1, undefined);
  // `small` asked for, but a live task trips a crosscheck.yml security trigger:
  // effort.yml's security_floor runs it at medium, and it is budgeted there.
  write('epic-secure', 1, 'small', [
    { task_id: 'epic-secure/t1', case: 'infra' },
    { task_id: 'epic-secure/t2', agent_role: 'coder' },
  ]);
  const policyFile = path.join(root, 'budgets.yml');
  writeFileSync(policyFile, POLICY);
  return { root, specsDir, policyFile };
}

function plan(effort: string | undefined, tasks: Task[]): PlanFile {
  return { epic_id: 'e', version: 1, ...(effort ? { effort } : {}), tasks } as unknown as PlanFile;
}

describe('the budget tier of a plan', () => {
  it('is the effective effort tier, after the security floor', () => {
    expect(budgetTierForPlan(plan('small', [{ task_id: 'e/t1', case: 'infra' }]))).toBe('medium');
    expect(
      budgetTierForPlan(plan('small', [{ task_id: 'e/t1', agent_role: 'security-reviewer' }])),
    ).toBe('medium');
    expect(budgetTierForPlan(plan('small', [{ task_id: 'e/t1', case: 'feature' }]))).toBe('small');
    expect(budgetTierForPlan(plan('huge', [{ task_id: 'e/t1', case: 'infra' }]))).toBe('huge');
  });

  it("reads a superseded task's trigger as withdrawn", () => {
    const p = plan('small', [
      { task_id: 'e/t1', case: 'infra', task_status: 'superseded' },
      { task_id: 'e/t1', case: 'feature' },
    ]);
    expect(budgetTierForPlan(p)).toBe('small');
  });

  it('is effort.yml default_tier with no plan or no effort', () => {
    expect(budgetTierForPlan(undefined)).toBe('medium');
    expect(budgetTierForPlan(plan(undefined, []))).toBe('medium');
  });

  it("falls back to the plan's own effort when the effort or security policy is unreadable", () => {
    const { root } = fixture();
    const missing = path.join(root, 'no-such.yml');
    const p = plan('small', [{ task_id: 'e/t1', case: 'infra' }]);
    expect(budgetTierForPlan(p, { crosscheckPolicyFile: missing })).toBe('small');
    expect(budgetTierForPlan(p, { effortPolicyFile: missing })).toBe('small');
  });
});

describe('epic budget policies', () => {
  it("reads the epic's latest plan version", () => {
    const { specsDir } = fixture();
    expect(latestPlan('epic-small', { specsDir })?.effort).toBe('small');
    expect(latestPlan('epic-none', { specsDir })?.effort).toBeUndefined();
    expect(latestPlan('no-such-epic', { specsDir })).toBeUndefined();
  });

  it('never treats an epic id from the log as a path', () => {
    const { specsDir } = fixture();
    expect(latestPlan('../specs/epic-small', { specsDir })).toBeUndefined();
    expect(latestPlan('..', { specsDir })).toBeUndefined();
  });

  it("sizes each epic's policy for its own tier, and the default tier without a plan", () => {
    const { specsDir, policyFile } = fixture();
    const policyFor = epicBudgetPolicies({ policyFile, env: {}, planOpts: { specsDir } });
    expect(policyFor('epic-small').tier).toBe('small');
    expect(policyFor('epic-small').epic.capTokens).toBe(1000);
    expect(policyFor('epic-small').task.coder.capTokens).toBe(50);
    expect(policyFor('epic-huge').epic.capTokens).toBe(4000);
    expect(policyFor('epic-none').tier).toBe('medium');
    expect(policyFor('no-such-epic').epic.capTokens).toBe(2000);
  });

  it('budgets a small epic that trips a security trigger at the floor tier', () => {
    const { specsDir, policyFile } = fixture();
    const policyFor = epicBudgetPolicies({ policyFile, env: {}, planOpts: { specsDir } });
    expect(policyFor('epic-secure').tier).toBe('medium');
    expect(policyFor('epic-secure').epic.capTokens).toBe(2000);
    expect(policyFor('epic-secure').task.coder.capTokens).toBe(100);
  });

  it("applies the env override for each epic's own tier", () => {
    const { specsDir, policyFile } = fixture();
    const policyFor = epicBudgetPolicies({
      policyFile,
      env: { SMITH_EPIC_CAP_TOKENS_HUGE: '9000', SMITH_EPIC_CAP_TOKENS: '3000' },
      planOpts: { specsDir },
    });
    expect(policyFor('epic-huge').epic.capTokens).toBe(9000);
    expect(policyFor('epic-small').epic.capTokens).toBe(3000);
  });
});
