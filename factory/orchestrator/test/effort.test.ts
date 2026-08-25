import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanQuorumPolicy } from '../src/crosscheck.js';
import {
  EFFORT_TIERS,
  type EffortPolicy,
  loadEffortPolicy,
  parseEffortPolicy,
  resolveEffort,
} from '../src/effort.js';
import { REPO_ROOT } from '../src/paths.js';
import type { PlanFile, TaskSpecRecord } from '../src/plan.js';

// ---------------------------------------------------------------------------
// effort.ts answers one question — "how much judgment does THIS epic buy?" —
// so that the /bs playbooks ask it instead of remembering it. Two properties
// carry the whole design and are asserted below over the shipped policy file
// rather than a fixture: `huge` is today's flow unchanged (so assigning no
// tier can never regress an epic in flight), and no tier may touch a
// mechanical oracle.
// ---------------------------------------------------------------------------

const securityPolicy: PlanQuorumPolicy = {
  budgetRatio: 0.5,
  confidenceThreshold: 0.8,
  securityCases: ['infra'],
  securityRoles: ['security-reviewer'],
  securityKeywords: ['auth', 'credential', 'token'],
};

function task(overrides: Record<string, unknown> = {}): TaskSpecRecord {
  return {
    task_id: 'epic-1/task-1',
    epic_id: 'epic-1',
    plan_version: 1,
    objective: 'Do the thing.',
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: ['src/foo/**'],
    budget: { tokens: 100, diff_lines: 10, max_turns: 5 },
    contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
    ...overrides,
  } as TaskSpecRecord;
}

function basePlan(overrides: Partial<PlanFile> = {}): PlanFile {
  return {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: [task()],
    edges: [],
    ...overrides,
  };
}

describe('loadEffortPolicy', () => {
  it('reads the shipped factory/policies/effort.yml', () => {
    const loaded = loadEffortPolicy();
    expect(Object.keys(loaded.tiers).sort()).toEqual([...EFFORT_TIERS].sort());
    expect(loaded.defaultTier).toBe('medium');
    expect(loaded.securityFloor).toBe('medium');
    expect(loaded.invariants.length).toBeGreaterThan(0);
  });

  it('ships `huge` as the flow SKILL.md already writes — a no-op tier, by design', () => {
    // The regression guard for the whole feature. If someone tunes `huge`,
    // every epic that never asked for a tier changes behaviour silently.
    const huge = loadEffortPolicy().tiers.huge;
    expect(huge.preCodeResearch).toBe('when-needed');
    expect(huge.preCodeUiux).toBe('when-ui-criterion');
    expect(huge.specReviewRounds).toBe('until-clean');
    expect(huge.planQuorum).toBe('always');
    expect(huge.graderRounds).toBe(2); // agent-constraints.md "grader (v3)"
    expect(huge.verifierSeverities).toEqual(['S1-stop-the-line', 'S2-major']);
    expect(huge.verifierS3SpotCheckRatio).toBe(0.2);
    expect(huge.closingSpecReview).toBe('always');
  });

  it('subtracts monotonically: small <= medium <= huge on every countable knob', () => {
    const { tiers } = loadEffortPolicy();
    expect(tiers.small.graderRounds).toBeLessThanOrEqual(tiers.medium.graderRounds);
    expect(tiers.medium.graderRounds).toBeLessThanOrEqual(tiers.huge.graderRounds);
    expect(tiers.small.verifierSeverities.length).toBeLessThanOrEqual(
      tiers.medium.verifierSeverities.length,
    );
    expect(tiers.medium.verifierSeverities.length).toBeLessThanOrEqual(
      tiers.huge.verifierSeverities.length,
    );
    expect(tiers.small.verifierS3SpotCheckRatio).toBeLessThanOrEqual(
      tiers.huge.verifierS3SpotCheckRatio,
    );
    // No tier may raise the grader's cap; agent-constraints.md sets it at 2.
    for (const tier of EFFORT_TIERS) {
      expect(tiers[tier].graderRounds).toBeLessThanOrEqual(2);
      expect(tiers[tier].graderRounds).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps every tier stopping the line on S1 — the one severity no tier may drop', () => {
    const { tiers } = loadEffortPolicy();
    for (const tier of EFFORT_TIERS) {
      expect(tiers[tier].verifierSeverities).toContain('S1-stop-the-line');
    }
  });

  it('rejects a policy missing a tier — a partial table is a silent default', () => {
    expect(() => parseEffortPolicy('version: 1\ntiers:\n  small: {}\n')).toThrowError(/medium/);
  });

  it('rejects an unknown knob value rather than degrading to the default', () => {
    const yaml = fullPolicyYaml().replace('plan_quorum: always', 'plan_quorum: sometimes');
    expect(() => parseEffortPolicy(yaml)).toThrowError(/sometimes/);
  });

  it('rejects a default_tier or security_floor that names no tier', () => {
    expect(() => parseEffortPolicy(fullPolicyYaml('gigantic'))).toThrowError(/gigantic/);
  });
});

describe('resolveEffort', () => {
  const policy = (): EffortPolicy => loadEffortPolicy();
  const resolve = (opts: Parameters<typeof resolveEffort>[2] = {}) =>
    resolveEffort(policy(), securityPolicy, opts);

  it('falls back to the policy default when the plan names no tier', () => {
    const resolved = resolve({ plan: basePlan() });
    expect(resolved.requested).toBeNull();
    expect(resolved.requestedFrom).toBe('default');
    expect(resolved.effective).toBe('medium');
    expect(resolved.floorApplied).toBe(false);
    expect(resolved.profile.planQuorum).toBe('when-triggered');
  });

  it("honours the plan's own tier over the default", () => {
    const resolved = resolve({ plan: basePlan({ effort: 'small' }) });
    expect(resolved.requested).toBe('small');
    expect(resolved.requestedFrom).toBe('plan');
    expect(resolved.effective).toBe('small');
    expect(resolved.profile.preCodeResearch).toBe('never');
    expect(resolved.profile.specReviewRounds).toBe('single-pass');
    expect(resolved.profile.closingSpecReview).toBe('when-plan-amended');
    expect(resolved.profile.verifierSeverities).toEqual(['S1-stop-the-line']);
  });

  it('lets an explicit ask beat the plan, and says which source won', () => {
    const resolved = resolve({ plan: basePlan({ effort: 'small' }), override: 'huge' });
    expect(resolved.requested).toBe('huge');
    expect(resolved.requestedFrom).toBe('flag');
    expect(resolved.effective).toBe('huge');
    expect(resolved.reason).toMatch(/flag/);
  });

  it('answers without a plan at all — /bs plan chooses the tier before the file exists', () => {
    const resolved = resolve({ override: 'small' });
    expect(resolved.effective).toBe('small');
    expect(resolved.securityFloorEvaluated).toBe(false);
    expect(resolved.securityTriggers).toHaveLength(0);
    // The empty trigger list must read as "not looked at", never as "clean".
    expect(resolved.reason).toMatch(/not evaluated/);
  });

  it('marks the floor evaluated once a plan is supplied, even a clean one', () => {
    const resolved = resolve({ plan: basePlan({ effort: 'small' }) });
    expect(resolved.securityFloorEvaluated).toBe(true);
    expect(resolved.reason).toMatch(/no security trigger fired/);
  });

  it('refuses a tier it cannot read instead of degrading to the default', () => {
    expect(() => resolve({ override: 'smal' })).toThrowError(/smal/);
    expect(() => resolve({ override: 'smal' })).toThrowError(/small, medium, huge/);
  });

  it('lifts a small epic to the security floor when its live tasks fire a security trigger', () => {
    const plan = basePlan({
      effort: 'small',
      tasks: [task({ case: 'infra' })],
    });
    const resolved = resolve({ plan });
    expect(resolved.requested).toBe('small');
    expect(resolved.effective).toBe('medium');
    expect(resolved.floorApplied).toBe(true);
    expect(resolved.securityTriggers).toHaveLength(1);
    expect(resolved.securityTriggers[0]?.matchType).toBe('case');
    expect(resolved.reason).toMatch(/security/i);
    // ...and the profile it returns is the floor's, not the request's.
    expect(resolved.profile.verifierSeverities).toEqual(['S1-stop-the-line', 'S2-major']);
  });

  it('fires the floor on a security keyword in a nonfunctional clause too', () => {
    const plan = basePlan({
      effort: 'small',
      tasks: [
        task({
          contract: {
            functional_clauses: ['do the thing'],
            nonfunctional_clauses: ['must not log the auth token'],
          },
        }),
      ],
    });
    const resolved = resolve({ plan });
    expect(resolved.effective).toBe('medium');
    expect(resolved.floorApplied).toBe(true);
  });

  it('floors an explicit --effort small too — the flag is not a way around it', () => {
    const plan = basePlan({ effort: 'huge', tasks: [task({ case: 'infra' })] });
    const resolved = resolve({ plan, override: 'small' });
    expect(resolved.requestedFrom).toBe('flag');
    expect(resolved.effective).toBe('medium');
    expect(resolved.floorApplied).toBe(true);
  });

  it('never lowers a tier: a huge epic that fires the floor stays huge', () => {
    const plan = basePlan({ effort: 'huge', tasks: [task({ case: 'infra' })] });
    const resolved = resolve({ plan });
    expect(resolved.effective).toBe('huge');
    expect(resolved.floorApplied).toBe(false);
    expect(resolved.securityTriggers).toHaveLength(1); // reported, not acted on
    expect(resolved.reason).toMatch(/already at or above/);
  });

  it('leaves a small epic small when nothing security-sensitive is in the plan', () => {
    const resolved = resolve({ plan: basePlan({ effort: 'small' }) });
    expect(resolved.effective).toBe('small');
    expect(resolved.floorApplied).toBe(false);
    expect(resolved.securityTriggers).toHaveLength(0);
  });

  it('reads live tasks only — a superseded security task is history, not the ask', () => {
    // D-113/D-185: a plan version keeps each superseded copy beside the record
    // that replaced it, under the same task_id. The tier must be decided
    // against what the plan is asking for now.
    const plan = basePlan({
      effort: 'small',
      tasks: [
        task({ case: 'infra', task_status: 'superseded' }),
        task({ case: 'feature', task_status: 'todo' }),
      ],
    });
    const resolved = resolve({ plan });
    expect(resolved.securityTriggers).toHaveLength(0);
    expect(resolved.effective).toBe('small');
  });

  it('returns the invariants alongside the profile so the caller cannot forget them', () => {
    const resolved = resolve({ plan: basePlan({ effort: 'small' }) });
    expect(resolved.invariants).toEqual(policy().invariants);
    expect(resolved.invariants.join(' ')).toMatch(/gate/i);
  });
});

/** The shipped policy, re-emitted as YAML so a test can corrupt one field. */
// ---------------------------------------------------------------------------
// D-191's lesson, applied before it can bite again: a verb that exists in
// code but is named in no governing document reaches no agent. A tier is
// worth nothing unless the two playbooks that spend the effort ask for it,
// and unless every knob this module returns is spent somewhere by name.
// ---------------------------------------------------------------------------

describe('the playbooks actually ask for the tier', () => {
  const skill = readFileSync(path.join(REPO_ROOT, '.claude/skills/bs/SKILL.md'), 'utf8');
  const section = (heading: string): string =>
    skill.slice(skill.indexOf(heading), skill.indexOf('\n## ', skill.indexOf(heading) + 1));
  const plan = section('## `/bs plan');
  const run = section('## `/bs run');

  it('makes `/bs plan` choose a tier, and `/bs run` read the one it chose', () => {
    expect(plan).not.toBe('');
    expect(run).not.toBe('');
    expect(plan).toContain('smith effort show');
    expect(run).toContain('smith effort show');
  });

  it('tells both playbooks to read `effective`, not what was asked for', () => {
    // The floor is the whole reason the two fields differ. A playbook that
    // reads `requested` runs a floored epic below its floor.
    expect(plan).toContain('effective');
    expect(run).toContain('effective');
  });

  it('spends every knob the profile returns, by name, somewhere in the flow', () => {
    // A knob nobody reads is a policy file lying about what it controls.
    const profile = loadEffortPolicy().tiers.small;
    const named = plan + run;
    for (const knob of Object.keys(profile).filter((key) => key !== 'summary')) {
      // Word-boundary, not substring: `profile.graderRoundsZZ` contains
      // `profile.graderRounds`, and a renamed knob is exactly the drift this
      // test exists to catch.
      expect(named, `profile.${knob} is never named in a playbook`).toMatch(
        new RegExp(`profile\\.${knob}\\b`),
      );
    }
  });

  it('promises the operator guide documents the verb it tells them to run', () => {
    const guide = readFileSync(path.join(REPO_ROOT, 'docs/guide/operator-guide.md'), 'utf8');
    expect(guide).toContain('smith effort show');
    expect(guide).toContain('factory/policies/effort.yml');
  });
});

function fullPolicyYaml(defaultTier = 'medium'): string {
  const tier = (name: string, body: string) => `  ${name}:\n${body}`;
  const knobs = [
    '    pre_code_research: when-needed',
    '    pre_code_uiux: when-ui-criterion',
    '    spec_review_rounds: until-clean',
    '    plan_quorum: always',
    '    grader_rounds: 2',
    '    verifier_severities: [S1-stop-the-line, S2-major]',
    '    verifier_s3_spot_check_ratio: 0.2',
    '    closing_spec_review: always',
  ].join('\n');
  return [
    'version: 1',
    `default_tier: ${defaultTier}`,
    'security_floor: medium',
    'tiers:',
    tier('huge', knobs),
    tier('medium', knobs),
    tier('small', knobs),
    'invariants:',
    '  - the gate pipeline',
  ].join('\n');
}
