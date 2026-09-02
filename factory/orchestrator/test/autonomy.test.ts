import { describe, expect, it } from 'vitest';
import { type AutonomyPolicy, admitProposals } from '../src/autonomy.js';
import type { SchedulerProposal } from '../src/scheduler.js';

/** The shape the operator chose: rechecks and maintenance may run themselves, growth never. */
const POLICY: AutonomyPolicy = {
  enabled: true,
  autoDispatchKinds: ['recheck', 'maintenance'],
  autoDispatchRecheckReasons: ['merge-threshold', 'time-elapsed'],
  confidenceFloor: 0.8,
};

const KEYWORDS = ['auth', 'secret', 'token', 'credential'] as const;

const ctx = (claims?: Record<string, string[]>) => ({
  securityKeywords: KEYWORDS,
  claimsByTask: new Map(Object.entries(claims ?? {})),
});

const recheck = (over: Partial<SchedulerProposal> = {}): SchedulerProposal =>
  ({
    kind: 'recheck',
    taskId: 'T-1',
    epicId: 'E-1',
    reasons: ['merge-threshold'],
    mergeCount: 6,
    daysElapsed: 3,
    confidence: 0.4,
    ...over,
  }) as SchedulerProposal;

const maintenance = (packages: string[], confidence: number): SchedulerProposal => ({
  kind: 'maintenance',
  packages: packages.map((name) => ({ name, current: '1.0.0', wanted: '1.1.0', latest: '1.1.0' })),
  confidence,
  autoSchedulable: confidence >= 0.8,
});

describe('admitProposals', () => {
  it('returns one admission per proposal, in the order given, and mutates nothing', () => {
    const proposals = [recheck(), maintenance(['left-pad'], 0.9)];
    const frozen = JSON.stringify(proposals);
    const admissions = admitProposals(proposals, POLICY, ctx());
    expect(admissions).toHaveLength(2);
    expect(admissions.map((a) => a.proposal.kind)).toEqual(['recheck', 'maintenance']);
    expect(JSON.stringify(proposals)).toBe(frozen);
  });

  describe('rechecks', () => {
    it('admits one whose every reason is whitelisted', () => {
      const [admission] = admitProposals([recheck()], POLICY, ctx());
      expect(admission?.decision).toBe('auto');
      expect(admission?.code).toBe('admitted');
    });

    // A recheck's `confidence` is the COMPLETED TASK's confidence, and a low
    // one is the reason the recheck exists (scheduler.ts proposeRechecks:
    // `taskConfidence < policy.confidenceThreshold` -> 'low-confidence').
    // Gating rechecks on `confidence >= floor` the way maintenance is gated
    // would therefore hold back exactly the rechecks that matter most and
    // wave through the routine ones. Reasons are the whitelist; confidence is
    // not consulted for this kind at all.
    it('admits one whose task finished at low confidence, when the reason is not that', () => {
      const [admission] = admitProposals(
        [recheck({ confidence: 0.1, reasons: ['time-elapsed'] } as Partial<SchedulerProposal>)],
        POLICY,
        ctx(),
      );
      expect(admission?.decision).toBe('auto');
    });

    it('holds one carrying a reason nobody whitelisted', () => {
      const [admission] = admitProposals(
        [
          recheck({
            reasons: ['merge-threshold', 'low-confidence'],
          } as Partial<SchedulerProposal>),
        ],
        POLICY,
        ctx(),
      );
      expect(admission?.decision).toBe('operator');
      expect(admission?.code).toBe('reason-not-whitelisted');
      expect(admission?.reason).toContain('low-confidence');
    });
  });

  describe('maintenance', () => {
    it('admits a minor bump at the floor', () => {
      const [admission] = admitProposals([maintenance(['left-pad'], 0.9)], POLICY, ctx());
      expect(admission?.decision).toBe('auto');
    });

    it('holds a major bump below the floor', () => {
      const [admission] = admitProposals([maintenance(['left-pad'], 0.5)], POLICY, ctx());
      expect(admission?.decision).toBe('operator');
      expect(admission?.code).toBe('below-confidence-floor');
    });
  });

  describe('the security surface always waits', () => {
    it('holds a maintenance proposal whose package name matches a keyword, at any confidence', () => {
      const [admission] = admitProposals([maintenance(['jsonwebtoken'], 0.9)], POLICY, ctx());
      expect(admission?.decision).toBe('operator');
      expect(admission?.code).toBe('security-surface');
      expect(admission?.reason).toContain('token');
    });

    it('holds a recheck whose claim paths match a keyword', () => {
      const [admission] = admitProposals([recheck()], POLICY, ctx({ 'T-1': ['src/auth/**'] }));
      expect(admission?.decision).toBe('operator');
      expect(admission?.code).toBe('security-surface');
      expect(admission?.reason).toContain('auth');
    });

    // The keyword list is crosscheck.yml's, read at the call site rather than
    // copied here: one list, so promoting a word to security-sensitive moves
    // both the cross-check trigger and this gate at once.
    it('matches case-insensitively, as plan_quorum does', () => {
      const [admission] = admitProposals([maintenance(['MyAuthLib'], 0.9)], POLICY, ctx());
      expect(admission?.decision).toBe('operator');
    });
  });

  describe('what no whitelist can admit', () => {
    it('holds a growth review even when the policy lists its kind', () => {
      const growth: SchedulerProposal = {
        kind: 'growth-review-due',
        cadenceDays: 30,
        lastReviewAt: null,
      };
      const permissive: AutonomyPolicy = {
        ...POLICY,
        autoDispatchKinds: ['recheck', 'maintenance', 'growth-review-due'],
      };
      const [admission] = admitProposals([growth], permissive, ctx());
      expect(admission?.decision).toBe('operator');
      expect(admission?.code).toBe('growth-never-auto');
    });

    it('holds a kind the policy left out', () => {
      const narrow: AutonomyPolicy = { ...POLICY, autoDispatchKinds: ['recheck'] };
      const [admission] = admitProposals([maintenance(['left-pad'], 0.9)], narrow, ctx());
      expect(admission?.decision).toBe('operator');
      expect(admission?.code).toBe('kind-not-whitelisted');
    });

    it('holds everything when autonomy is switched off', () => {
      const off: AutonomyPolicy = { ...POLICY, enabled: false };
      const admissions = admitProposals([recheck(), maintenance(['left-pad'], 0.9)], off, ctx());
      expect(admissions.every((a) => a.decision === 'operator')).toBe(true);
      expect(admissions.every((a) => a.code === 'autonomy-disabled')).toBe(true);
    });
  });
});
