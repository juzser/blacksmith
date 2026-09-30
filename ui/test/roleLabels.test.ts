import { describe, expect, it } from 'vitest';
import {
  dispatchDecisionLine,
  providerLabel,
  roleLabel,
  tierLabel,
} from '../src/lib/roleLabels.js';

// factory/policies/taxonomy.yml `agent` (version 11, ~line 25-27) is the
// closed vocabulary every dispatched role is drawn from. Hard-coded here
// (no yaml-parsing dependency exists in this project's UI tests) rather than
// read off disk — a comment is the tether back to the source of truth, and
// this list must be kept in step with it by hand.
const TAXONOMY_ROLES = [
  'planner',
  'spec-reviewer',
  'researcher',
  'coder',
  'tester',
  'grader',
  'reviewer',
  'verifier',
  'security-reviewer',
  'merger',
  'scribe',
  'uiux',
  'wave-runner',
  'auditor',
  'operator',
];

describe('lib/roleLabels.ts roleLabel()', () => {
  it('has an explicit, friendly label for every taxonomy.yml agent role', () => {
    for (const role of TAXONOMY_ROLES) {
      const label = roleLabel(role);
      expect(label).not.toBe(role);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('renders the operator-suggested labels', () => {
    expect(roleLabel('coder')).toBe('Builder');
    expect(roleLabel('tester')).toBe('Tester');
    expect(roleLabel('reviewer')).toBe('Code reviewer');
    expect(roleLabel('verifier')).toBe('Finding checker');
    expect(roleLabel('grader')).toBe('Quality grader');
    expect(roleLabel('security-reviewer')).toBe('Security reviewer');
    expect(roleLabel('spec-reviewer')).toBe('Plan reviewer');
    expect(roleLabel('planner')).toBe('Planner');
    expect(roleLabel('researcher')).toBe('Researcher');
    expect(roleLabel('uiux')).toBe('Designer');
    expect(roleLabel('merger')).toBe('Merge fixer');
    expect(roleLabel('scribe')).toBe('Note writer');
    expect(roleLabel('wave-runner')).toBe('Batch runner');
    expect(roleLabel('auditor')).toBe('Auditor');
    expect(roleLabel('operator')).toBe('You');
  });

  it('title-cases an unknown role rather than rendering it blank or raw', () => {
    expect(roleLabel('some-new-role')).toBe('Some New Role');
  });
});

// ds-spec.md §4.1 point 3 ("What the factory decided recently"): "Checker
// (DeepSeek, standard model): double-checking another model's review" style
// — friendly provider + model_tier names (taxonomy.yml `provider`/
// `model_tier`, version 11 ~line 37-38) on top of the role table above.
describe('lib/roleLabels.ts tierLabel()/providerLabel()', () => {
  it('has an explicit, friendly label for every taxonomy.yml model tier', () => {
    expect(tierLabel('frontier')).toBe('flagship model');
    expect(tierLabel('mid')).toBe('standard model');
    expect(tierLabel('small')).toBe('fast model');
  });

  it('falls back to the raw tier string rather than rendering blank', () => {
    expect(tierLabel('unknown-tier')).toBe('unknown-tier');
  });

  it('has an explicit, friendly label for every taxonomy.yml provider', () => {
    expect(providerLabel('claude')).toBe('Claude');
    expect(providerLabel('codex')).toBe('Codex');
    expect(providerLabel('deepseek')).toBe('DeepSeek');
  });

  it('falls back to the raw provider string rather than rendering blank', () => {
    expect(providerLabel('some-new-provider')).toBe('some-new-provider');
  });
});

describe('lib/roleLabels.ts dispatchDecisionLine()', () => {
  it('renders the operator-suggested "role (provider, tier): reason" style', () => {
    expect(
      dispatchDecisionLine({
        agentRole: 'verifier',
        provider: 'deepseek',
        modelTier: 'mid',
        reason: "double-checking another model's review",
      }),
    ).toBe("Finding checker (DeepSeek, standard model): double-checking another model's review");
  });
});
