import { describe, expect, it } from 'vitest';
import { learnedFromLabel, lessonScopeLabel, preventedLabel } from '../src/lib/lessonLabels.js';

describe('lib/lessonLabels.ts', () => {
  describe('lessonScopeLabel', () => {
    it('reads stack-wide and security as "Applies to all projects"', () => {
      expect(
        lessonScopeLabel('stack-wide', { agentRole: null, claimPath: null, caseType: null }),
      ).toBe('Applies to all projects');
      expect(
        lessonScopeLabel('security', { agentRole: null, claimPath: null, caseType: null }),
      ).toBe('Applies to all projects');
    });

    it('reads agent-role as "Role: <agentRole>"', () => {
      expect(
        lessonScopeLabel('agent-role', { agentRole: 'coder', claimPath: null, caseType: null }),
      ).toBe('Role: coder');
    });

    it('reads claim-path as the path itself', () => {
      expect(
        lessonScopeLabel('claim-path', {
          agentRole: null,
          claimPath: 'ui/src/components/kit/**',
          caseType: null,
        }),
      ).toBe('ui/src/components/kit/**');
    });

    it('reads case-type as the case itself', () => {
      expect(
        lessonScopeLabel('case-type', { agentRole: null, claimPath: null, caseType: 'bug-fix' }),
      ).toBe('bug-fix');
    });

    it('falls back to the scope string itself when the selector field is missing', () => {
      expect(
        lessonScopeLabel('claim-path', { agentRole: null, claimPath: null, caseType: null }),
      ).toBe('claim-path');
    });
  });

  describe('preventedLabel', () => {
    it('says "Hasn\'t prevented a repeat yet" for 0', () => {
      expect(preventedLabel(0)).toBe("Hasn't prevented a repeat yet");
    });

    it('says "Prevented 1 repeat" (singular) for 1', () => {
      expect(preventedLabel(1)).toBe('Prevented 1 repeat');
    });

    it('says "Prevented N repeats" (plural) for N > 1', () => {
      expect(preventedLabel(3)).toBe('Prevented 3 repeats');
    });
  });

  describe('learnedFromLabel', () => {
    it('includes the formatted date when validFrom is set', () => {
      expect(learnedFromLabel('csb-audit-1', '2026-09-07T00:00:00.000Z')).toBe(
        'Learned from csb-audit-1 on 7 Sep',
      );
    });

    it('hides the date entirely when validFrom is null', () => {
      expect(learnedFromLabel('csb-audit-1', null)).toBe('Learned from csb-audit-1');
    });
  });
});
