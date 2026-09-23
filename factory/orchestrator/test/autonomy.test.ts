import { describe, expect, it } from 'vitest';
import { type AutonomyPolicy, admitProposals } from '../src/autonomy.js';
import { SCHEDULER_POLICY_PATH } from '../src/paths.js';
import type { SchedulerProposal } from '../src/scheduler.js';
import { loadSchedulerPolicy } from '../src/scheduler.js';

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
  projectDir: '/repo/a',
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

// ---------------------------------------------------------------------------
// The error-report proposal writes to an external tracker under an
// authenticated `gh` token. That is a security decision, so every assertion
// below is on the DECISION value — a branch merely being reached proves
// nothing about what an unattended process would have done.
// ---------------------------------------------------------------------------

describe('error-report proposals', () => {
  const errorReport = (confidence: number): SchedulerProposal =>
    ({
      kind: 'error-report',
      fingerprint: '0123456789abcdef',
      project: 'black-smith',
      source: 'error-logged',
      errorClass: 'economy.budget-exceeded',
      taskRef: 'epic-1/task-3',
      sessionId: 'sess-1',
      latestEventId: 'sess-1#4',
      occurrences: 2,
      confidence,
    }) as SchedulerProposal;

  it("holds a report at 0.95 confidence, above the floor: the tracker write is the operator's", () => {
    const [admission] = admitProposals([errorReport(0.95)], POLICY, ctx());
    expect(admission?.decision).toBe('operator');
    expect(admission?.code).toBe('tracker-write-never-auto');
    expect(admission?.reason).toMatch(/gh/);
    expect(admission?.reason).toMatch(/repo/);
  });

  it('is absent from the shipped scheduler.yml auto_dispatch_kinds', () => {
    const shipped = loadSchedulerPolicy(SCHEDULER_POLICY_PATH);
    expect(shipped.autonomy.autoDispatchKinds).not.toContain('error-report');
  });

  it('is still held when a hand-built policy lists the kind — the refusal is in code', () => {
    const permissive: AutonomyPolicy = {
      ...POLICY,
      autoDispatchKinds: ['recheck', 'maintenance', 'error-report'],
    };
    const [admission] = admitProposals([errorReport(0.95)], permissive, ctx());
    expect(admission?.decision).toBe('operator');
    expect(admission?.code).toBe('tracker-write-never-auto');
  });

  // errorIssues.ts's fail-closed fold mints proposals with project: null when
  // nothing can resolve one (scheduler.ts's ErrorReportProposal.project is
  // string | null for exactly this reason). The refusal must not depend on
  // the project being a resolved string.
  it('still holds a report whose project never resolved (project: null)', () => {
    const unresolved = { ...errorReport(0.95), project: null } as SchedulerProposal;
    const [admission] = admitProposals([unresolved], POLICY, ctx());
    expect(admission?.decision).toBe('operator');
    expect(admission?.code).toBe('tracker-write-never-auto');
  });
});
