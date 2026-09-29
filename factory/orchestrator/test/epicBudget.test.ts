import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { epicBudgetPolicies, latestPlanEffort } from '../src/epicBudget.js';

const POLICY = `
epic:
  cap_tokens: {small: 1000, medium: 2000, huge: 4000}
task:
  coder: {cap_tokens: 100, cap_diff_lines: 10}
`;

function fixture(): { specsDir: string; policyFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'epic-budget-'));
  const specsDir = path.join(root, 'specs');
  const write = (epicId: string, version: number, effort: string | undefined) => {
    mkdirSync(path.join(specsDir, epicId), { recursive: true });
    writeFileSync(
      path.join(specsDir, epicId, `plan-v${version}.json`),
      JSON.stringify({ epic_id: epicId, version, ...(effort ? { effort } : {}) }),
    );
  };
  write('epic-small', 1, 'medium');
  write('epic-small', 2, 'small');
  write('epic-huge', 1, 'huge');
  write('epic-none', 1, undefined);
  const policyFile = path.join(root, 'budgets.yml');
  writeFileSync(policyFile, POLICY);
  return { specsDir, policyFile };
}

describe('epic budget policies', () => {
  it("reads the effort of the epic's latest plan version", () => {
    const { specsDir } = fixture();
    expect(latestPlanEffort('epic-small', { specsDir })).toBe('small');
    expect(latestPlanEffort('epic-none', { specsDir })).toBeUndefined();
    expect(latestPlanEffort('no-such-epic', { specsDir })).toBeUndefined();
  });

  it('never treats an epic id from the log as a path', () => {
    const { specsDir } = fixture();
    expect(latestPlanEffort('../specs/epic-small', { specsDir })).toBeUndefined();
    expect(latestPlanEffort('..', { specsDir })).toBeUndefined();
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
