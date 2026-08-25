import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events.js';
import {
  type FindingDraft,
  listFindings,
  raiseFinding,
  reverifyFinding,
  transition,
} from '../src/findings.js';
import {
  applyBatch,
  denyWaiver,
  grantWaiver,
  isWaived,
  pendingBatch,
  WaiverError,
} from '../src/waivers.js';

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    finding_id: 'finding-1',
    task_id: 'epic-1/task-1',
    finding_category: 'correctness',
    severity: 'S3-minor',
    finding_status: 'raised',
    summary: 'unused variable left behind',
    failure_scenario: { inputs: 'n/a', expected: 'no dead code', actual: 'dead code present' },
    found_by: 'reviewer',
    ...overrides,
  };
}

describe('waivers.ts', () => {
  let stateDir: string;
  const sessionId = 'sess-waivers';
  const rootCtx = { sessionId, planVersion: 1, causalParent: null };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-waivers-'));
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const ctx = () => ({ ...rootCtx, causalParent: `${sessionId}#0` });

  describe('isWaived round-trip', () => {
    it('is false with no decisions on the fingerprint', async () => {
      await expect(isWaived('fp-1', { sessionId }, { stateDir })).resolves.toBe(false);
    });

    it('becomes true after a grant, false again after a later deny', async () => {
      await grantWaiver('fp-1', 'accepted', ctx(), { stateDir });
      await expect(isWaived('fp-1', { sessionId }, { stateDir })).resolves.toBe(true);

      await denyWaiver('fp-1', 'reconsidered', ctx(), { stateDir });
      await expect(isWaived('fp-1', { sessionId }, { stateDir })).resolves.toBe(false);
    });

    it('is scoped per fingerprint', async () => {
      await grantWaiver('fp-1', 'accepted', ctx(), { stateDir });
      await expect(isWaived('fp-2', { sessionId }, { stateDir })).resolves.toBe(false);
    });
  });

  describe('grantWaiver reconciles finding_status (regression: used to stay "raised" forever)', () => {
    it('transitions the finding to waived and sets waiver_id after a grant', async () => {
      const raised = await raiseFinding(
        { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      const waiverEvent = await grantWaiver(raised.finding.fingerprint, 'ok', ctx(), { stateDir });

      const [finding] = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(finding?.finding_status).toBe('waived');
      expect(finding?.waiver_id).toBe(waiverEvent.event_id);
    });

    it('reconciles every finding sharing the granted fingerprint, not just one', async () => {
      const a = await raiseFinding(
        { finding: draft({ finding_id: 'f-dup-a' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      // Same file/category/summary -> same fingerprint; raised before any
      // waiver exists so it is NOT suppressed, giving two distinct findings
      // sharing one fingerprint (the case reconciliation must handle).
      const b = await raiseFinding(
        { finding: draft({ finding_id: 'f-dup-b' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (a.suppressed || b.suppressed) throw new Error('unreachable');
      expect(a.finding.fingerprint).toBe(b.finding.fingerprint);

      await grantWaiver(a.finding.fingerprint, 'ok', ctx(), { stateDir });

      const findings = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(findings.every((f) => f.finding_status === 'waived')).toBe(true);
    });

    it('does not reconcile a finding sharing the fingerprint but not itself waivable (non-S3/S4)', async () => {
      const waivable = await raiseFinding(
        {
          finding: draft({ finding_id: 'f-waivable', severity: 'S3-minor' }),
          filePath: 'src/a.ts',
        },
        ctx(),
        { stateDir },
      );
      const notWaivable = await raiseFinding(
        {
          finding: draft({ finding_id: 'f-not-waivable', severity: 'S2-major' }),
          filePath: 'src/a.ts',
        },
        ctx(),
        { stateDir },
      );
      if (waivable.suppressed || notWaivable.suppressed) throw new Error('unreachable');
      expect(waivable.finding.fingerprint).toBe(notWaivable.finding.fingerprint);

      await grantWaiver(waivable.finding.fingerprint, 'ok', ctx(), { stateDir });

      const findings = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      const byId = new Map(findings.map((f) => [f.finding_id, f]));
      expect(byId.get('f-waivable')?.finding_status).toBe('waived');
      expect(byId.get('f-not-waivable')?.finding_status).toBe('raised');
    });

    it('reopens a waived finding when the grant is later denied (D-180)', async () => {
      const raised = await raiseFinding(
        { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');
      const fingerprint = raised.finding.fingerprint;

      await grantWaiver(fingerprint, 'accepted', ctx(), { stateDir });
      const [waived] = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(waived?.finding_status).toBe('waived');

      await denyWaiver(fingerprint, 'reconsidered', ctx(), { stateDir });

      // isWaived() already answers "not waived" here. finding_status has to
      // agree, or the epic gate keeps reading a waiver the operator revoked.
      const [reopened] = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(reopened?.finding_status).toBe('raised');
      // The waiver that closed it is gone with it — a reopened finding
      // carrying the id of a revoked waiver is the same split state.
      expect(reopened?.waiver_id).toBeUndefined();
    });

    it('restores the status the finding held before the waiver, not just "raised"', async () => {
      const raised = await raiseFinding(
        { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      await transition('f-1', 'confirmed', ctx(), { stateDir });
      await grantWaiver(raised.finding.fingerprint, 'accepted', ctx(), { stateDir });
      await denyWaiver(raised.finding.fingerprint, 'reconsidered', ctx(), { stateDir });

      const [reopened] = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(reopened?.finding_status).toBe('confirmed');
    });

    it('leaves a finding waived by a decision this denial did not revoke', async () => {
      const a = await raiseFinding(
        { finding: draft({ finding_id: 'f-a' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      const b = await raiseFinding(
        { finding: draft({ finding_id: 'f-b', summary: 'a different nit' }), filePath: 'src/b.ts' },
        ctx(),
        { stateDir },
      );
      if (a.suppressed || b.suppressed) throw new Error('unreachable');

      await grantWaiver(a.finding.fingerprint, 'ok', ctx(), { stateDir });
      await grantWaiver(b.finding.fingerprint, 'ok', ctx(), { stateDir });
      await denyWaiver(a.finding.fingerprint, 'reconsidered', ctx(), { stateDir });

      const byId = new Map(
        (await listFindings(sessionId, {}, { stateDir })).map((f) => [f.finding_id, f]),
      );
      expect(byId.get('f-a')?.finding_status).toBe('raised');
      expect(byId.get('f-b')?.finding_status).toBe('waived');
    });

    it('denyWaiver does not change finding_status', async () => {
      const raised = await raiseFinding(
        { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      await denyWaiver(raised.finding.fingerprint, 'no', ctx(), { stateDir });

      const [finding] = await listFindings(sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(finding?.finding_status).toBe('raised');
    });
  });

  describe('pendingBatch', () => {
    it('includes only S3/S4 findings for the epic with no decision yet', async () => {
      const s3 = await raiseFinding(
        { finding: draft({ finding_id: 'f-s3', severity: 'S3-minor' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      const s4 = await raiseFinding(
        {
          finding: draft({ finding_id: 'f-s4', severity: 'S4-nit', summary: 'naming nit' }),
          filePath: 'src/b.ts',
        },
        ctx(),
        { stateDir },
      );
      await raiseFinding(
        { finding: draft({ finding_id: 'f-s2', severity: 'S2-major' }), filePath: 'src/c.ts' },
        ctx(),
        { stateDir },
      );
      await raiseFinding(
        {
          finding: draft({ finding_id: 'f-other-epic', task_id: 'epic-2/task-1' }),
          filePath: 'src/d.ts',
        },
        ctx(),
        { stateDir },
      );
      if (s3.suppressed || s4.suppressed) throw new Error('unreachable');

      const pending = await pendingBatch('epic-1', { sessionId }, { stateDir });
      const ids = pending.map((f) => f.finding_id).sort();
      expect(ids).toEqual(['f-s3', 'f-s4']);

      await grantWaiver(s3.finding.fingerprint, 'ok', ctx(), { stateDir });
      const pendingAfter = await pendingBatch('epic-1', { sessionId }, { stateDir });
      expect(pendingAfter.map((f) => f.finding_id)).toEqual(['f-s4']);
    });

    it('never re-surfaces a finding once denied', async () => {
      const raised = await raiseFinding(
        { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      await denyWaiver(raised.finding.fingerprint, 'not fixing this', ctx(), { stateDir });
      const pending = await pendingBatch('epic-1', { sessionId }, { stateDir });
      expect(pending).toEqual([]);
    });
  });

  describe('applyBatch', () => {
    it('validates every fingerprint exists before writing anything', async () => {
      const raised = await raiseFinding(
        { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (raised.suppressed) throw new Error('unreachable');

      await expect(
        applyBatch(
          [
            { fingerprint: raised.finding.fingerprint, decision: 'granted', operatorNote: 'ok' },
            { fingerprint: 'never-raised', decision: 'denied', operatorNote: 'n/a' },
          ],
          ctx(),
          { stateDir },
        ),
      ).rejects.toThrow(WaiverError);

      // The whole batch failed — nothing applied, including the valid entry.
      await expect(isWaived(raised.finding.fingerprint, { sessionId }, { stateDir })).resolves.toBe(
        false,
      );
    });

    it('rejects a granted decision for a non-waivable (S2) finding before any write, and does not suppress a later re-raise', async () => {
      const s2 = await raiseFinding(
        { finding: draft({ finding_id: 'f-s2', severity: 'S2-major' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      if (s2.suppressed) throw new Error('unreachable');

      await expect(
        applyBatch(
          [{ fingerprint: s2.finding.fingerprint, decision: 'granted', operatorNote: 'ok' }],
          ctx(),
          { stateDir },
        ),
      ).rejects.toThrow(WaiverError);

      // Nothing was written — the fingerprint is not waived.
      await expect(isWaived(s2.finding.fingerprint, { sessionId }, { stateDir })).resolves.toBe(
        false,
      );

      // A later re-raise of the identical finding is NOT suppressed as a
      // duplicate of a waiver that should never have been grantable.
      const reRaised = await raiseFinding(
        {
          finding: draft({ finding_id: 'f-s2-again', severity: 'S2-major' }),
          filePath: 'src/a.ts',
        },
        ctx(),
        { stateDir },
      );
      expect(reRaised.suppressed).toBe(false);
    });

    it('rejects the whole batch if any granted decision is non-waivable, even alongside a valid one', async () => {
      const s3 = await raiseFinding(
        { finding: draft({ finding_id: 'f-s3-ok', severity: 'S3-minor' }), filePath: 'src/b.ts' },
        ctx(),
        { stateDir },
      );
      const s2 = await raiseFinding(
        {
          finding: draft({ finding_id: 'f-s2-bad', severity: 'S2-major', summary: 'a real bug' }),
          filePath: 'src/c.ts',
        },
        ctx(),
        { stateDir },
      );
      if (s3.suppressed || s2.suppressed) throw new Error('unreachable');

      await expect(
        applyBatch(
          [
            { fingerprint: s3.finding.fingerprint, decision: 'granted', operatorNote: 'ok' },
            { fingerprint: s2.finding.fingerprint, decision: 'granted', operatorNote: 'ok' },
          ],
          ctx(),
          { stateDir },
        ),
      ).rejects.toThrow(WaiverError);

      await expect(isWaived(s3.finding.fingerprint, { sessionId }, { stateDir })).resolves.toBe(
        false,
      );
    });

    it('applies granted and denied decisions', async () => {
      const a = await raiseFinding(
        { finding: draft({ finding_id: 'f-a' }), filePath: 'src/a.ts' },
        ctx(),
        { stateDir },
      );
      const b = await raiseFinding(
        {
          finding: draft({ finding_id: 'f-b', summary: 'a different finding' }),
          filePath: 'src/b.ts',
        },
        ctx(),
        { stateDir },
      );
      if (a.suppressed || b.suppressed) throw new Error('unreachable');

      const results = await applyBatch(
        [
          { fingerprint: a.finding.fingerprint, decision: 'granted', operatorNote: 'ok' },
          { fingerprint: b.finding.fingerprint, decision: 'denied', operatorNote: 'no' },
        ],
        ctx(),
        { stateDir },
      );
      expect(results).toHaveLength(2);
      await expect(isWaived(a.finding.fingerprint, { sessionId }, { stateDir })).resolves.toBe(
        true,
      );
      await expect(isWaived(b.finding.fingerprint, { sessionId }, { stateDir })).resolves.toBe(
        false,
      );
    });

    // P9-15 (b): a waiver batch answered from evidence about code a later wave
    // rewrote is a decision made on deleted evidence.
    describe('stale evidence', () => {
      async function mergeOver(filePath: string, taskId = 'epic-1/task-2'): Promise<void> {
        await appendEvent(
          {
            session_id: sessionId,
            actor: 'system',
            event_type: 'wave-merged',
            task_id: taskId,
            plan_version: 1,
            causal_parent: `${sessionId}#0`,
            payload: { task_ids: [taskId], files_changed: [filePath] },
          },
          { stateDir },
        );
      }

      it('refuses a granted decision whose finding file a later wave rewrote, and writes nothing', async () => {
        const raised = await raiseFinding(
          { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
          ctx(),
          { stateDir },
        );
        if (raised.suppressed) throw new Error('unreachable');
        await mergeOver('src/a.ts');

        await expect(
          applyBatch(
            [{ fingerprint: raised.finding.fingerprint, decision: 'granted', operatorNote: 'ok' }],
            ctx(),
            { stateDir },
          ),
        ).rejects.toMatchObject({ code: 'waivers.stale-evidence' });

        await expect(
          isWaived(raised.finding.fingerprint, { sessionId }, { stateDir }),
        ).resolves.toBe(false);
      });

      it('names the remedy in the error so the operator is not left guessing', async () => {
        const raised = await raiseFinding(
          { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
          ctx(),
          { stateDir },
        );
        if (raised.suppressed) throw new Error('unreachable');
        await mergeOver('src/a.ts');

        const error = await applyBatch(
          [{ fingerprint: raised.finding.fingerprint, decision: 'granted', operatorNote: 'ok' }],
          ctx(),
          { stateDir },
        ).catch((err: WaiverError) => err);

        expect(error).toBeInstanceOf(WaiverError);
        expect((error as WaiverError).message).toContain('src/a.ts');
        expect((error as WaiverError).message).toContain('epic-1/task-2');
        expect((error as WaiverError).message).toContain('smith findings reverify --finding f-1');
      });

      it('lets the grant through once the finding has been re-verified', async () => {
        const raised = await raiseFinding(
          { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
          ctx(),
          { stateDir },
        );
        if (raised.suppressed) throw new Error('unreachable');
        await mergeOver('src/a.ts');
        await reverifyFinding('f-1', 'still reproduces after the rewrite', ctx(), { stateDir });

        await applyBatch(
          [{ fingerprint: raised.finding.fingerprint, decision: 'granted', operatorNote: 'ok' }],
          ctx(),
          { stateDir },
        );

        await expect(
          isWaived(raised.finding.fingerprint, { sessionId }, { stateDir }),
        ).resolves.toBe(true);
      });

      // A denial closes nothing and grants nothing — blocking it would only
      // strand the batch, since the remedy is re-verification either way.
      it('allows a denied decision on stale evidence', async () => {
        const raised = await raiseFinding(
          { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
          ctx(),
          { stateDir },
        );
        if (raised.suppressed) throw new Error('unreachable');
        await mergeOver('src/a.ts');

        const results = await applyBatch(
          [{ fingerprint: raised.finding.fingerprint, decision: 'denied', operatorNote: 'no' }],
          ctx(),
          { stateDir },
        );
        expect(results).toHaveLength(1);
      });

      it('does not block a grant when the merge touched other files', async () => {
        const raised = await raiseFinding(
          { finding: draft({ finding_id: 'f-1' }), filePath: 'src/a.ts' },
          ctx(),
          { stateDir },
        );
        if (raised.suppressed) throw new Error('unreachable');
        await mergeOver('src/elsewhere.ts');

        await applyBatch(
          [{ fingerprint: raised.finding.fingerprint, decision: 'granted', operatorNote: 'ok' }],
          ctx(),
          { stateDir },
        );

        await expect(
          isWaived(raised.finding.fingerprint, { sessionId }, { stateDir }),
        ).resolves.toBe(true);
      });
    });
  });
});
