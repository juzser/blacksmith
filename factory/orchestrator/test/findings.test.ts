import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import {
  computeFingerprint,
  type FindingDraft,
  FindingError,
  type FindingEvidence,
  foldFindings,
  foldFindingsDetailed,
  listFindings,
  mintFindings,
  raiseFinding,
  repairObligation,
  reverifyFinding,
  staleFindings,
  transition,
} from '../src/findings.js';
import { loadTaxonomy } from '../src/taxonomy.js';
import { grantWaiver } from '../src/waivers.js';

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    finding_id: 'finding-1',
    task_id: 'epic-1/task-1',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    summary: 'src/foo.ts:42 off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    found_by: 'reviewer',
    ...overrides,
  };
}

describe('computeFingerprint', () => {
  it('is stable across different line numbers in the summary', () => {
    const a = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'correctness',
      summary: 'src/foo.ts:42 off-by-one in loop bound',
    });
    const b = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'correctness',
      summary: 'src/foo.ts:99 off-by-one in loop bound',
    });
    expect(a).toBe(b);
  });

  it('is stable across whitespace/case drift in the summary', () => {
    const a = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'correctness',
      summary: 'Off-by-one   in loop bound',
    });
    const b = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'correctness',
      summary: 'off-by-one in loop  bound',
    });
    expect(a).toBe(b);
  });

  it('differs when finding_category differs', () => {
    const a = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'correctness',
      summary: 'off-by-one in loop bound',
    });
    const b = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'security',
      summary: 'off-by-one in loop bound',
    });
    expect(a).not.toBe(b);
  });

  it('differs when the file path differs', () => {
    const a = computeFingerprint({
      filePath: 'src/foo.ts',
      category: 'correctness',
      summary: 'off-by-one in loop bound',
    });
    const b = computeFingerprint({
      filePath: 'src/bar.ts',
      category: 'correctness',
      summary: 'off-by-one in loop bound',
    });
    expect(a).not.toBe(b);
  });

  it('treats "./" prefix and backslashes as equivalent path forms', () => {
    const a = computeFingerprint({
      filePath: './src/foo.ts',
      category: 'correctness',
      summary: 'off-by-one',
    });
    const b = computeFingerprint({
      filePath: 'src\\foo.ts',
      category: 'correctness',
      summary: 'off-by-one',
    });
    expect(a).toBe(b);
  });

  // Regression: a blanket `:\d+` strip collides free-text port numbers with
  // line-number refs — "on :8080" and "on :9090" are genuinely different
  // findings and must never fold into the same fingerprint (reviewer finding #3).
  it('does NOT strip a free-text port number — :8080 and :9090 must differ', () => {
    const a = computeFingerprint({
      filePath: 'src/server.ts',
      category: 'security',
      summary: 'debug endpoint exposed on :8080 without auth',
    });
    const b = computeFingerprint({
      filePath: 'src/server.ts',
      category: 'security',
      summary: 'debug endpoint exposed on :9090 without auth',
    });
    expect(a).not.toBe(b);
  });

  it("still strips a line ref anchored to the finding's own file path (full path or basename), keeping the path text itself", () => {
    const withLineRef = computeFingerprint({
      filePath: 'src/server.ts',
      category: 'correctness',
      summary: 'src/server.ts:8080 off-by-one',
    });
    const withoutLineRef = computeFingerprint({
      filePath: 'src/server.ts',
      category: 'correctness',
      summary: 'src/server.ts off-by-one',
    });
    expect(withLineRef).toBe(withoutLineRef);

    const basenameWithLineRef = computeFingerprint({
      filePath: 'src/server.ts',
      category: 'correctness',
      summary: 'server.ts:8080 off-by-one',
    });
    const basenameWithoutLineRef = computeFingerprint({
      filePath: 'src/server.ts',
      category: 'correctness',
      summary: 'server.ts off-by-one',
    });
    expect(basenameWithLineRef).toBe(basenameWithoutLineRef);
  });
});

// Interview N-2: a judge returns evidence, never identity. finding_id,
// task_id, found_by and finding_status are the orchestrator's to mint — a
// judge cannot know its own task id or which provider ran it, and a judge that
// invents a finding_id makes dedup impossible across re-review rounds.
describe('mintFindings', () => {
  const evidence: FindingEvidence = {
    file_path: 'src/foo.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    summary: 'off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
  };

  it('mints identity onto judge evidence and keeps the evidence verbatim', () => {
    const [minted] = mintFindings([evidence], {
      taskId: 'epic-1/task-1',
      foundBy: 'reviewer',
      foundByProvider: 'claude',
    });

    expect(minted?.filePath).toBe('src/foo.ts');
    expect(minted?.finding.task_id).toBe('epic-1/task-1');
    expect(minted?.finding.found_by).toBe('reviewer');
    expect(minted?.finding.found_by_provider).toBe('claude');
    expect(minted?.finding.finding_status).toBe('raised');
    expect(minted?.finding.finding_id).toMatch(/^f-epic-1\/task-1-[0-9a-f]{8}$/);
    expect(minted?.finding.summary).toBe('off-by-one in loop bound');
    expect(minted?.finding.failure_scenario).toEqual(evidence.failure_scenario);
  });

  it('mints the same finding_id for the same evidence and a different one per task', () => {
    const first = mintFindings([evidence], { taskId: 'epic-1/task-1', foundBy: 'reviewer' });
    const again = mintFindings([evidence], { taskId: 'epic-1/task-1', foundBy: 'reviewer' });
    const otherTask = mintFindings([evidence], { taskId: 'epic-1/task-2', foundBy: 'reviewer' });

    expect(first[0]?.finding.finding_id).toBe(again[0]?.finding.finding_id);
    expect(first[0]?.finding.finding_id).not.toBe(otherTask[0]?.finding.finding_id);
  });

  it('rejects evidence that carries its own identity instead of silently trusting it', () => {
    const withIdentity = { ...evidence, finding_id: 'reviewer-made-this-up' };
    expect(() =>
      mintFindings([withIdentity as FindingEvidence], {
        taskId: 'epic-1/task-1',
        foundBy: 'reviewer',
      }),
    ).toThrow(FindingError);
  });

  it('rejects a bare "S2" severity with the canonical value in the message', () => {
    const bareSeverity = { ...evidence, severity: 'S2' };
    expect(() =>
      mintFindings([bareSeverity], { taskId: 'epic-1/task-1', foundBy: 'reviewer' }),
    ).toThrow(/S2-major/);
  });

  // P9-20 / D-37: `test-gap` — a plausible synonym for `test-coverage` — cost
  // a full gate round in wave 3, because finding_category was copied through
  // mint untouched and first checked at gate intake, five checks later, with
  // an error naming no legal value. Severity was already validated here; the
  // category was not.
  describe('finding_category is validated beside severity', () => {
    it('rejects an unknown category and enumerates every legal value', () => {
      const bad = { ...evidence, finding_category: 'not-a-real-category' };
      let err: FindingError | undefined;
      try {
        mintFindings([bad], { taskId: 'epic-1/task-1', foundBy: 'reviewer' });
      } catch (e) {
        err = e as FindingError;
      }
      expect(err).toBeInstanceOf(FindingError);
      expect(err?.code).toBe('findings.non-canonical-finding-category');
      const said = String(err?.message);
      for (const value of [
        'correctness',
        'security',
        'a11y',
        'performance',
        'visual-design',
        'behavioral-drift',
        'test-coverage',
        'over-engineering',
        'maintainability',
      ]) {
        expect(said, `message omits "${value}"`).toContain(value);
      }
    });

    it('names the taxonomy value when the judge wrote a near-miss synonym', () => {
      // The exact wave-3 slip: one shared hyphen token, exactly one candidate.
      const testGap = { ...evidence, finding_category: 'test-gap' };
      expect(() =>
        mintFindings([testGap], { taskId: 'epic-1/task-1', foundBy: 'reviewer' }),
      ).toThrow(/test-coverage/);
    });

    it('names the taxonomy value for a bare suffix like "coverage" or "design"', () => {
      for (const [written, canonical] of [
        ['coverage', 'test-coverage'],
        ['design', 'visual-design'],
        ['drift', 'behavioral-drift'],
      ]) {
        expect(() =>
          mintFindings([{ ...evidence, finding_category: written as string }], {
            taskId: 'epic-1/task-1',
            foundBy: 'reviewer',
          }),
        ).toThrow(new RegExp(canonical as string));
      }
    });

    it('suggests nothing when the value resembles no taxonomy value', () => {
      const nonsense = { ...evidence, finding_category: 'zzzz' };
      expect(() =>
        mintFindings([nonsense], { taskId: 'epic-1/task-1', foundBy: 'reviewer' }),
      ).toThrow(/unknown finding_category "zzzz"/);
    });

    it('accepts every category the taxonomy declares', () => {
      const taxonomy = loadTaxonomy();
      for (const value of taxonomy.dimensions.finding_category ?? []) {
        const [minted] = mintFindings([{ ...evidence, finding_category: value }], {
          taskId: 'epic-1/task-1',
          foundBy: 'reviewer',
        });
        expect(minted?.finding.finding_category).toBe(value);
      }
    });

    it('reports which piece of evidence was wrong when a later one is bad', () => {
      expect(() =>
        mintFindings([evidence, { ...evidence, finding_category: 'test-gap' }], {
          taskId: 'epic-1/task-1',
          foundBy: 'reviewer',
        }),
      ).toThrow(/index 1/);
    });
  });
});

describe('findings.ts', () => {
  let stateDir: string;
  const ctx = { sessionId: 'sess-findings', planVersion: 1, causalParent: null };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-findings-'));
    await appendEvent(
      {
        session_id: ctx.sessionId,
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

  const rootCtx = () => ({ ...ctx, causalParent: `${ctx.sessionId}#0` });

  describe('raiseFinding', () => {
    it('validates via schema/taxonomy and appends a finding-raised event', async () => {
      const result = await raiseFinding({ finding: draft(), filePath: 'src/foo.ts' }, rootCtx(), {
        stateDir,
      });
      expect(result.suppressed).toBe(false);
      if (result.suppressed) throw new Error('unreachable');
      expect(result.finding.finding_status).toBe('raised');
      expect(result.finding.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const findings = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.finding_id).toBe('finding-1');
    });

    it('rejects a schema/taxonomy-invalid finding and writes nothing', async () => {
      await expect(
        raiseFinding(
          { finding: draft({ finding_category: 'not-a-real-category' }), filePath: 'src/foo.ts' },
          rootCtx(),
          { stateDir },
        ),
      ).rejects.toThrow(FindingError);

      const findings = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(findings).toHaveLength(0);
    });

    it('suppresses a re-raise of an already-waived fingerprint instead of duplicating it', async () => {
      // S3, not draft()'s S2 default: this is a test about dedup, and a waiver
      // over an S2 is a thing severity.yml never lets an operator grant.
      const waivable = { severity: 'S3-minor' };
      const first = await raiseFinding(
        { finding: draft(waivable), filePath: 'src/foo.ts' },
        rootCtx(),
        { stateDir },
      );
      if (first.suppressed) throw new Error('unreachable');

      await grantWaiver(first.finding.fingerprint, 'known issue, accepted', rootCtx(), {
        stateDir,
      });

      const second = await raiseFinding(
        { finding: draft({ ...waivable, finding_id: 'finding-2' }), filePath: 'src/foo.ts' },
        rootCtx(),
        { stateDir },
      );
      expect(second.suppressed).toBe(true);

      // Only the original raised finding is listed; the re-raise never duplicates it.
      const findings = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(findings).toHaveLength(1);

      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.some((e) => e.record.event_type === 'finding-suppressed')).toBe(true);
    });

    // D-196: the fingerprint is file + category + summary — deliberately blind
    // to severity, so that line-number and wording drift between re-review
    // rounds still dedups. A waiver is keyed by that same fingerprint, so a
    // grant made over an S3 answers for every severity the same sentence is
    // ever raised at. Every other door into "a waiver answers this finding"
    // checks severity first — pendingBatch, applyBatch,
    // reconcileFindingsToWaived, transition(-> waived). This one did not.
    describe('D-196: a waiver cannot suppress what it was never grantable over', () => {
      const SAME = {
        finding_category: 'security',
        summary: 'the session cookie is set without the Secure attribute',
      };

      async function waiveAtS3(): Promise<void> {
        const raised = await raiseFinding(
          { finding: draft({ ...SAME, severity: 'S3-minor' }), filePath: 'src/auth.ts' },
          rootCtx(),
          { stateDir },
        );
        if (raised.suppressed) throw new Error('unreachable');
        await grantWaiver(raised.finding.fingerprint, 'dev-only host, accepted', rootCtx(), {
          stateDir,
        });
      }

      it('raises an S2 re-read of a fingerprint waived at S3', async () => {
        await waiveAtS3();

        // severity.yml escalates the model tier after failed rounds; the
        // frontier reviewer reads the same line and calls it what it is.
        const escalated = await raiseFinding(
          {
            finding: draft({ ...SAME, finding_id: 'finding-2', severity: 'S2-major' }),
            filePath: 'src/auth.ts',
          },
          rootCtx(),
          { stateDir },
        );

        expect(escalated.suppressed).toBe(false);
        if (escalated.suppressed) throw new Error('unreachable');
        expect(escalated.finding.severity).toBe('S2-major');
      });

      it('raises an S1 re-read of a fingerprint waived at S3', async () => {
        await waiveAtS3();

        const stopTheLine = await raiseFinding(
          {
            finding: draft({
              ...SAME,
              finding_id: 'finding-3',
              severity: 'S1-stop-the-line',
            }),
            filePath: 'src/auth.ts',
          },
          rootCtx(),
          { stateDir },
        );

        expect(stopTheLine.suppressed).toBe(false);
      });

      it('still suppresses a re-read at the severity the waiver answered', async () => {
        await waiveAtS3();

        // The fix must not cost the waiver its actual job: the operator is
        // never asked the same S3 twice (severity.yml, waiver_semantics).
        const again = await raiseFinding(
          {
            finding: draft({ ...SAME, finding_id: 'finding-4', severity: 'S3-minor' }),
            filePath: 'src/auth.ts',
          },
          rootCtx(),
          { stateDir },
        );

        expect(again.suppressed).toBe(true);
      });
    });

    // P9-15: the file a finding is anchored to is the join key between an open
    // finding and the task about to reopen that file. Before this it survived
    // only inside computeFingerprint's digest — a one-way hash — so the join
    // the punch list calls "no inference at all" could not be computed at all.
    it('persists the anchoring file_path on the record and in the event payload', async () => {
      const result = await raiseFinding({ finding: draft(), filePath: 'src/foo.ts' }, rootCtx(), {
        stateDir,
      });
      if (result.suppressed) throw new Error('unreachable');
      expect(result.finding.file_path).toBe('src/foo.ts');

      const [listed] = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(listed?.file_path).toBe('src/foo.ts');

      const raised = (await readEvents(ctx.sessionId, { stateDir })).find(
        (e) => e.record.event_type === 'finding-raised',
      );
      expect(raised).toBeDefined();
      expect((raised?.record.payload as { file_path?: string } | undefined)?.file_path).toBe(
        'src/foo.ts',
      );
    });

    it('stores the path in the same normalized form the fingerprint is computed from', async () => {
      const result = await raiseFinding(
        { finding: draft(), filePath: './src\\foo.ts' },
        rootCtx(),
        { stateDir },
      );
      if (result.suppressed) throw new Error('unreachable');
      expect(result.finding.file_path).toBe('src/foo.ts');
    });
  });

  describe('listFindings', () => {
    beforeEach(async () => {
      await raiseFinding(
        {
          finding: draft({ finding_id: 'f-1', task_id: 'epic-1/task-1', severity: 'S2-major' }),
          filePath: 'src/a.ts',
        },
        rootCtx(),
        { stateDir },
      );
      await raiseFinding(
        {
          finding: draft({
            finding_id: 'f-2',
            task_id: 'epic-1/task-2',
            severity: 'S3-minor',
            finding_category: 'over-engineering',
          }),
          filePath: 'src/b.ts',
        },
        rootCtx(),
        { stateDir },
      );
      await raiseFinding(
        { finding: draft({ finding_id: 'f-3', task_id: 'epic-2/task-1' }), filePath: 'src/c.ts' },
        rootCtx(),
        { stateDir },
      );
    });

    it('filters by task, epic, severity, and category', async () => {
      expect(
        await listFindings(ctx.sessionId, { taskId: 'epic-1/task-1' }, { stateDir }),
      ).toHaveLength(1);
      expect(await listFindings(ctx.sessionId, { epic: 'epic-1' }, { stateDir })).toHaveLength(2);
      expect(await listFindings(ctx.sessionId, { epic: 'epic-2' }, { stateDir })).toHaveLength(1);
      expect(
        await listFindings(ctx.sessionId, { severity: 'S3-minor' }, { stateDir }),
      ).toHaveLength(1);
      expect(
        await listFindings(ctx.sessionId, { category: 'over-engineering' }, { stateDir }),
      ).toHaveLength(1);
      expect(await listFindings(ctx.sessionId, {}, { stateDir })).toHaveLength(3);
    });

    it('reflects finding_status after a transition', async () => {
      await transition('f-1', 'confirmed', rootCtx(), { stateDir });
      const findings = await listFindings(ctx.sessionId, { taskId: 'epic-1/task-1' }, { stateDir });
      expect(findings[0]?.finding_status).toBe('confirmed');
    });

    // D-49/P9-10: epic membership is a field, not string surgery.
    it('matches on epic_id when the task_id alone cannot say which epic', async () => {
      await raiseFinding(
        {
          finding: draft({ finding_id: 'f-bare', task_id: 'task-9', epic_id: 'epic-1' }),
          filePath: 'src/d.ts',
        },
        rootCtx(),
        { stateDir },
      );
      const inEpic1 = await listFindings(ctx.sessionId, { epic: 'epic-1' }, { stateDir });
      expect(inEpic1.map((f) => f.finding_id).sort()).toEqual(['f-1', 'f-2', 'f-bare']);
      expect(await listFindings(ctx.sessionId, { epic: 'epic-2' }, { stateDir })).toHaveLength(1);
    });

    it('never reads an unqualified task_id as its own epic', async () => {
      await raiseFinding(
        { finding: draft({ finding_id: 'f-orphan', task_id: 'task-9' }), filePath: 'src/e.ts' },
        rootCtx(),
        { stateDir },
      );
      // Pre-fix, split('/')[0] returned "task-9" and this matched.
      expect(await listFindings(ctx.sessionId, { epic: 'task-9' }, { stateDir })).toHaveLength(0);
    });
  });

  describe('epic_id on a minted finding (D-49/P9-10)', () => {
    const evidence: FindingEvidence = {
      file_path: 'src/foo.ts',
      finding_category: 'correctness',
      severity: 'S2-major',
      summary: 'src/foo.ts:42 off-by-one in loop bound',
      failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    };

    it('mintFindings carries the epic the task id names', () => {
      const [minted] = mintFindings([evidence], { taskId: 'epic-1/task-1', foundBy: 'reviewer' });
      expect(minted?.finding.epic_id).toBe('epic-1');
    });

    it('mintFindings omits epic_id rather than guessing one from a bare task id', () => {
      const [minted] = mintFindings([evidence], { taskId: 'task-1', foundBy: 'reviewer' });
      expect(minted?.finding.epic_id).toBeUndefined();
    });

    it('the raised event payload carries epic_id', async () => {
      await raiseFinding(
        {
          finding: draft({ finding_id: 'f-epic', task_id: 'epic-3/task-1' }),
          filePath: 'src/f.ts',
        },
        rootCtx(),
        { stateDir },
      );
      const events = await readEvents(ctx.sessionId, { stateDir });
      const raised = events.find(
        (e) => e.record.event_type === 'finding-raised' && e.record.task_id === 'epic-3/task-1',
      );
      expect((raised?.record.payload as { epic_id?: string } | undefined)?.epic_id).toBe('epic-3');
    });
  });

  describe('transition (lifecycle legality matrix)', () => {
    beforeEach(async () => {
      // S3-minor (waivable): isolates the state-machine SHAPE from the
      // separate severity gate on "-> waived" (covered in its own describe
      // block below) — a non-waivable severity here would make the
      // "raised -> waived" row fail for the wrong reason.
      await raiseFinding(
        { finding: draft({ severity: 'S3-minor' }), filePath: 'src/foo.ts' },
        rootCtx(),
        { stateDir },
      );
    });

    it.each([
      ['raised', 'confirmed', true],
      ['raised', 'refuted', true],
      ['raised', 'waived', true],
      ['raised', 'expired', true],
      ['raised', 'fix-pending', false],
      ['raised', 'fix-landed', false],
      ['raised', 'fix-verified', false],
      // D-127: `amended` is reachable only from `amend-pending`. This row is
      // the whole defect — it used to be legal, and it closed the one severity
      // class severity.yml refuses to waive in a single call.
      ['raised', 'amended', false],
    ])('raised -> %s is legal=%s', async (_from, to, legal) => {
      if (legal) {
        await expect(transition('finding-1', to, rootCtx(), { stateDir })).resolves.toMatchObject({
          finding_status: to,
        });
      } else {
        await expect(transition('finding-1', to, rootCtx(), { stateDir })).rejects.toThrow(
          FindingError,
        );
      }
    });

    it('walks the full confirmed -> fix-pending -> fix-landed -> fix-verified chain', async () => {
      await transition('finding-1', 'confirmed', rootCtx(), { stateDir });
      await transition('finding-1', 'fix-pending', rootCtx(), { stateDir });
      await transition('finding-1', 'fix-landed', rootCtx(), { stateDir });
      const finding = await transition('finding-1', 'fix-verified', rootCtx(), { stateDir });
      expect(finding.finding_status).toBe('fix-verified');
    });

    it('rejects a transition once a finding has reached a terminal state', async () => {
      await transition('finding-1', 'refuted', rootCtx(), { stateDir });
      await expect(transition('finding-1', 'confirmed', rootCtx(), { stateDir })).rejects.toThrow(
        FindingError,
      );
    });

    it('rejects transitioning an unknown finding id', async () => {
      await expect(
        transition('finding-ghost', 'confirmed', rootCtx(), { stateDir }),
      ).rejects.toThrow(FindingError);
    });
  });

  // D-127: the amendment path is two edges, not one. `amend-pending` records
  // which task ids the amendment made this finding's discharge condition;
  // `amended` is what those ids landing earns. Collapsing the two is how an
  // unwaivable S1/S2 spec finding used to close on a sentence in a plan file.
  describe('transition -> the amendment path (D-127)', () => {
    const SPEC_DRAFT: Partial<FindingDraft> = {
      finding_id: 'finding-spec',
      finding_scope: 'spec',
      spec_ref: { plan_version: 1, criterion_ref: 'epic-1/task-1:criterion-3' },
    };
    const OBLIGATIONS = ['epic-1/task-1', 'epic-1/task-4'];

    async function raiseSpec(): Promise<void> {
      await raiseFinding({ finding: draft(SPEC_DRAFT), filePath: 'src/foo.ts' }, rootCtx(), {
        stateDir,
      });
    }

    it('records the task ids the amendment owes on the way into amend-pending', async () => {
      await raiseSpec();
      const moved = await transition(
        'finding-spec',
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      expect(moved.finding_status).toBe('amend-pending');
      expect(moved.amends_task_ids).toEqual(OBLIGATIONS);
      expect(moved.amends_plan_version).toBe(2);
    });

    it('carries amends_task_ids and amends_plan_version through the fold', async () => {
      await raiseSpec();
      await transition(
        'finding-spec',
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      const [folded] = await listFindings(ctx.sessionId, { severity: 'S2-major' }, { stateDir });
      expect(folded?.finding_status).toBe('amend-pending');
      expect(folded?.amends_task_ids).toEqual(OBLIGATIONS);
      expect(folded?.amends_plan_version).toBe(2);
      // D-21 Part 4 regression: a finding with no finding-obligation-repaired
      // event in its history must fold byte-identically to before this verb
      // existed -- no obligation_repair_reason key at all, not merely undefined.
      expect(folded).not.toHaveProperty('obligation_repair_reason');
    });

    it('refuses an amend-pending that names no task ids', async () => {
      await raiseSpec();
      await expect(
        transition('finding-spec', 'amend-pending', rootCtx(), { stateDir }),
      ).rejects.toMatchObject({ code: 'findings.amendment-without-obligation' });
      await expect(
        transition('finding-spec', 'amend-pending', rootCtx(), { stateDir }, { amendsTaskIds: [] }),
      ).rejects.toMatchObject({ code: 'findings.amendment-without-obligation' });
    });

    // D-136. The refusal is right, but a reader who only has this message
    // cannot act on it: the obligation arrives from a plan diff, and no verb
    // but `plan amend` computes one. The sibling guard on `→ amended` already
    // names `smith epic close`; this one was the asymmetry.
    it('names the command that CAN supply the obligation', async () => {
      await raiseSpec();
      await expect(
        transition('finding-spec', 'amend-pending', rootCtx(), { stateDir }),
      ).rejects.toThrow(/smith plan amend/);
    });

    it('refuses to put a diff-scoped finding on the amendment path', async () => {
      // `draft()` with no finding_scope is a diff finding: the plan is not
      // what is wrong, so no plan version can answer it.
      await raiseFinding({ finding: draft(), filePath: 'src/foo.ts' }, rootCtx(), { stateDir });
      await expect(
        transition(
          'finding-1',
          'amend-pending',
          rootCtx(),
          { stateDir },
          { amendsTaskIds: OBLIGATIONS },
        ),
      ).rejects.toMatchObject({ code: 'findings.not-amendable' });
    });

    /** Every obligation landed terminal-OK at the version the amendment cut. */
    const DISCHARGED = [
      { taskId: 'epic-1/task-1', planVersion: 2 },
      { taskId: 'epic-1/task-4', planVersion: 2 },
    ];

    async function pending(): Promise<void> {
      await raiseSpec();
      await transition(
        'finding-spec',
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
    }

    it('closes at amended only once the amendment is pending', async () => {
      await raiseSpec();
      await expect(
        transition('finding-spec', 'amended', rootCtx(), { stateDir }),
      ).rejects.toMatchObject({ code: 'findings.illegal-transition' });

      await transition(
        'finding-spec',
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      const closed = await transition(
        'finding-spec',
        'amended',
        rootCtx(),
        { stateDir },
        { amendsSatisfiedBy: DISCHARGED },
      );
      expect(closed.finding_status).toBe('amended');
      // The obligations stay on the record: what closed it is still readable.
      expect(closed.amends_task_ids).toEqual(OBLIGATIONS);
    });

    // The transition table alone makes `amended` reachable only from
    // `amend-pending`, but reaching it still owed nothing: the check that the
    // obligated tasks actually landed lived in closeEpic and nowhere else, so
    // `smith findings transition <id> amended` discharged the unwaivable class
    // with no task built — D-127 again, through the operator's door. transition()
    // now demands the evidence, the way `-> waived` is gated here rather than in
    // waivers.ts, so the CLI and the sweep are held to one rule.
    it('refuses to close an amendment that shows no discharge evidence', async () => {
      await pending();
      await expect(
        transition('finding-spec', 'amended', rootCtx(), { stateDir }),
      ).rejects.toMatchObject({ code: 'findings.amendment-not-discharged' });
      await expect(
        transition('finding-spec', 'amended', rootCtx(), { stateDir }, { amendsSatisfiedBy: [] }),
      ).rejects.toMatchObject({ code: 'findings.amendment-not-discharged' });
    });

    it('refuses evidence that skips one of the obligated tasks', async () => {
      await pending();
      await expect(
        transition(
          'finding-spec',
          'amended',
          rootCtx(),
          { stateDir },
          { amendsSatisfiedBy: [{ taskId: 'epic-1/task-1', planVersion: 2 }] },
        ),
      ).rejects.toMatchObject({
        code: 'findings.amendment-not-discharged',
        details: { outstanding: ['epic-1/task-4'] },
      });
    });

    // The version clause, at the boundary. A task that landed under the plan the
    // amendment replaced did not land *because of* the amendment — that is the
    // D-125 shape, where a superseded task would otherwise satisfy the very
    // amendment that superseded it.
    it('refuses evidence from a plan version older than the amendment', async () => {
      await pending();
      await expect(
        transition(
          'finding-spec',
          'amended',
          rootCtx(),
          { stateDir },
          {
            amendsSatisfiedBy: [
              { taskId: 'epic-1/task-1', planVersion: 1 },
              { taskId: 'epic-1/task-4', planVersion: 2 },
            ],
          },
        ),
      ).rejects.toMatchObject({
        code: 'findings.amendment-not-discharged',
        details: { outstanding: ['epic-1/task-1'] },
      });
    });

    it('accepts evidence from a plan version past the amendment', async () => {
      await pending();
      const closed = await transition(
        'finding-spec',
        'amended',
        rootCtx(),
        { stateDir },
        {
          amendsSatisfiedBy: [
            { taskId: 'epic-1/task-1', planVersion: 3 },
            { taskId: 'epic-1/task-4', planVersion: 9 },
          ],
        },
      );
      expect(closed.finding_status).toBe('amended');
    });

    // D-46/P9-29: amends_task_ids comes off the plan, the evidence off the fold,
    // and the two registers spell ids either way.
    it('matches obligation ids bare', async () => {
      await pending();
      const closed = await transition(
        'finding-spec',
        'amended',
        rootCtx(),
        { stateDir },
        {
          amendsSatisfiedBy: [
            { taskId: 'task-1', planVersion: 2 },
            { taskId: 'epic-1/task-4', planVersion: 2 },
          ],
        },
      );
      expect(closed.finding_status).toBe('amended');
    });

    // The amendment-without-obligation guard refuses this at the write, so the
    // only way to hold such a record is a hand-edited or pre-guard log. It must
    // not read as "nothing outstanding, therefore done" — an amendment naming
    // nothing has no discharge condition and can never be satisfied, the same
    // reading summarizeEpic takes.
    it('refuses to discharge an amendment that names no task at all', async () => {
      await raiseSpec();
      await appendEvent(
        {
          session_id: ctx.sessionId,
          actor: 'operator',
          event_type: 'finding-transitioned',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: `${ctx.sessionId}#0`,
          payload: {
            finding_id: 'finding-spec',
            from_status: 'raised',
            to_status: 'amend-pending',
          },
        },
        { stateDir },
      );
      await expect(
        transition(
          'finding-spec',
          'amended',
          rootCtx(),
          { stateDir },
          { amendsSatisfiedBy: DISCHARGED },
        ),
      ).rejects.toMatchObject({ code: 'findings.amendment-not-discharged' });
    });

    it('records the evidence in the event, so the log says why it discharged', async () => {
      await pending();
      await transition(
        'finding-spec',
        'amended',
        rootCtx(),
        { stateDir },
        { amendsSatisfiedBy: DISCHARGED },
      );
      const events = await readEvents(ctx.sessionId, { stateDir });
      const last = events.at(-1)?.record;
      expect(last?.event_type).toBe('finding-transitioned');
      const payload = last?.payload as { amends_satisfied_by?: unknown };
      expect(payload.amends_satisfied_by).toEqual(DISCHARGED);
    });

    it('lets an epic boundary expire an amendment whose tasks never landed', async () => {
      await raiseSpec();
      await transition(
        'finding-spec',
        'amend-pending',
        rootCtx(),
        { stateDir },
        { amendsTaskIds: OBLIGATIONS, amendsPlanVersion: 2 },
      );
      const expired = await transition('finding-spec', 'expired', rootCtx(), { stateDir });
      expect(expired.finding_status).toBe('expired');
    });

    it('refuses to discharge a confirmed spec finding straight to amended', async () => {
      await raiseSpec();
      await transition('finding-spec', 'confirmed', rootCtx(), { stateDir });
      await expect(
        transition('finding-spec', 'amended', rootCtx(), { stateDir }),
      ).rejects.toMatchObject({ code: 'findings.illegal-transition' });
    });

    // D-21 Part 4. `f-demo-rpg-reading-interface/integration-3e6bd014` carries
    // `amends_task_ids: [null, "…/task-5-reader-memory"]` -- a malformed entry
    // parts 1-3 of D-21 now refuse at the source (`plan amend`), but the log is
    // append-only and this record predates the guard. No existing verb can
    // discharge it truthfully: `reverify` is not a status transition, `expired`
    // asserts the replacement work never landed (it did), a fresh `plan amend`
    // cannot re-enter `amend-pending` from `amend-pending`, and S2 is
    // categorically unwaivable. This verb repairs the malformed ENTRY, not the
    // obligation itself -- six guards, because it can discharge an unwaivable
    // finding.
    describe('repairObligation (D-21 Part 4)', () => {
      /** A finding parked at amend-pending with a malformed amends_task_ids entry -- the D-21 shape. */
      async function pendingMalformed(): Promise<void> {
        await raiseSpec();
        await transition(
          'finding-spec',
          'amend-pending',
          rootCtx(),
          { stateDir },
          {
            amendsTaskIds: [null, 'epic-1/task-4'] as unknown as string[],
            amendsPlanVersion: 2,
          },
        );
      }

      it('refuses to repair an obligation that is already well-formed (guard 1: repairs corruption only)', async () => {
        await pending(); // amends_task_ids: OBLIGATIONS, all well-formed strings.
        await expect(
          repairObligation(
            { findingId: 'finding-spec', replaceWith: OBLIGATIONS, reason: 'tidy up' },
            rootCtx(),
            { stateDir },
          ),
        ).rejects.toMatchObject({ code: 'findings.repair-not-corrupt' });
      });

      // Original obligation: [null, 'epic-1/task-4']. 'epic-1/task-4' is the
      // one well-formed id in it, and a repair that drops it is exactly how
      // "repair" would become a way to delete a real obligation.
      it('refuses a replacement that drops a well-formed id from the original (guard 2: cannot weaken)', async () => {
        await pendingMalformed();
        await expect(
          repairObligation(
            { findingId: 'finding-spec', replaceWith: ['epic-1/task-1'], reason: 'drop the null' },
            rootCtx(),
            { stateDir },
          ),
        ).rejects.toMatchObject({
          code: 'findings.repair-would-weaken',
          details: { dropped: ['epic-1/task-4'] },
        });
      });

      it('refuses to repair an obligation to an empty list (guard 3: cannot empty)', async () => {
        await pendingMalformed();
        await expect(
          repairObligation(
            { findingId: 'finding-spec', replaceWith: [], reason: 'nothing left to wait on' },
            rootCtx(),
            { stateDir },
          ),
        ).rejects.toMatchObject({ code: 'findings.repair-would-empty' });
      });

      describe('guard 4: reason required', () => {
        it.each([
          ['empty string', ''],
          ['whitespace only', '   '],
        ])('refuses a %s --reason', async (_label, reason) => {
          await pendingMalformed();
          await expect(
            repairObligation(
              { findingId: 'finding-spec', replaceWith: ['epic-1/task-4'], reason },
              rootCtx(),
              { stateDir },
            ),
          ).rejects.toMatchObject({ code: 'findings.repair-reason-required' });
        });
      });

      it('refuses to repair a finding that is not at amend-pending (guard 5)', async () => {
        await raiseSpec(); // status stays 'raised' -- never entered amend-pending.
        await expect(
          repairObligation(
            { findingId: 'finding-spec', replaceWith: ['epic-1/task-4'], reason: 'valid reason' },
            rootCtx(),
            { stateDir },
          ),
        ).rejects.toMatchObject({ code: 'findings.repair-not-pending' });
      });

      it('refuses a replacement entry that is not a non-empty string, naming its type and index (guard 6)', async () => {
        await pendingMalformed();
        await expect(
          repairObligation(
            {
              findingId: 'finding-spec',
              replaceWith: ['epic-1/task-4', null as unknown as string],
              reason: 'valid reason',
            },
            rootCtx(),
            { stateDir },
          ),
        ).rejects.toMatchObject({
          code: 'findings.repair-replacement-not-string',
          details: { index: 1, received: 'null' },
        });
      });

      // The happy path: repair drops only the malformed entry, keeps the real
      // obligation, and the finding can then discharge once that obligation
      // lands -- exactly the incident this verb exists to fix
      // (f-demo-rpg-reading-interface/integration-3e6bd014).
      it('repairs the malformed entry, then the finding discharges once its real obligation lands', async () => {
        await pendingMalformed(); // amends_task_ids: [null, 'epic-1/task-4'], v2.

        const repaired = await repairObligation(
          {
            findingId: 'finding-spec',
            replaceWith: ['epic-1/task-4'],
            reason:
              'drop the null entry written by a malformed plan amend; the real obligation is unaffected',
          },
          rootCtx(),
          { stateDir },
        );
        expect(repaired.amends_task_ids).toEqual(['epic-1/task-4']);
        expect(repaired.obligation_repair_reason).toBe(
          'drop the null entry written by a malformed plan amend; the real obligation is unaffected',
        );

        // Before the repair this call would see the malformed null as an
        // outstanding obligation and refuse to discharge -- now it sees only
        // the repaired, well-formed list.
        const closed = await transition(
          'finding-spec',
          'amended',
          rootCtx(),
          { stateDir },
          { amendsSatisfiedBy: [{ taskId: 'epic-1/task-4', planVersion: 2 }] },
        );
        expect(closed.finding_status).toBe('amended');
      });

      // D-21 Part 4: mirrors isWaived's waiver-granted/waiver-denied fold --
      // last decision wins. Writing the two finding-obligation-repaired
      // events directly (bypassing repairObligation's own guards, which would
      // refuse a second repair once the first left the obligation
      // well-formed) isolates the FOLD's behaviour from the guarded write
      // path, the same way the suite's existing 'refuses to discharge an
      // amendment that names no task at all' test does for finding-transitioned.
      it('folds the LATEST of two finding-obligation-repaired events onto amends_task_ids', async () => {
        await pendingMalformed(); // amends_task_ids: [null, 'epic-1/task-4'], v2.
        // beforeEach's session-start (#0), raiseSpec's finding-raised (#1) and
        // pendingMalformed's amend-pending finding-transitioned (#2) are
        // already in the log, so the first repair chains off #2.
        const firstRepair = await appendEvent(
          {
            session_id: ctx.sessionId,
            actor: 'operator',
            event_type: 'finding-obligation-repaired',
            task_id: 'epic-1/task-1',
            plan_version: 1,
            causal_parent: `${ctx.sessionId}#2`,
            payload: {
              finding_id: 'finding-spec',
              from_obligation: [null, 'epic-1/task-4'],
              to_obligation: ['epic-1/task-4'],
              malformed_entries: [{ index: 0, type: 'null' }],
              reason: 'first repair: drop the null',
            },
          },
          { stateDir },
        );
        await appendEvent(
          {
            session_id: ctx.sessionId,
            actor: 'operator',
            event_type: 'finding-obligation-repaired',
            task_id: 'epic-1/task-1',
            plan_version: 1,
            causal_parent: firstRepair.event_id,
            payload: {
              finding_id: 'finding-spec',
              from_obligation: ['epic-1/task-4'],
              to_obligation: ['epic-1/task-1', 'epic-1/task-4'],
              malformed_entries: [],
              reason: 'second repair: also name task-1',
            },
          },
          { stateDir },
        );

        const [folded] = await listFindings(ctx.sessionId, { severity: 'S2-major' }, { stateDir });
        expect(folded?.amends_task_ids).toEqual(['epic-1/task-1', 'epic-1/task-4']);
        expect(folded?.obligation_repair_reason).toBe('second repair: also name task-1');
      });
    });
  });

  describe('leaving waived is gated on proof the waiver was revoked (D-180)', () => {
    // `waived` used to be terminal, so a denied waiver left the finding closed
    // forever while isWaived() said otherwise. The exit exists now — but only
    // for a revocation that can be pointed at, never for a typed status.
    const waive = async (findingId: string) => {
      await raiseFinding(
        { finding: draft({ finding_id: findingId, severity: 'S3-minor' }), filePath: 'src/foo.ts' },
        rootCtx(),
        { stateDir },
      );
      await transition(findingId, 'waived', rootCtx(), { stateDir });
    };

    it('refuses to reopen a waived finding with no revocation named', async () => {
      await waive('finding-w1');
      try {
        await transition('finding-w1', 'raised', rootCtx(), { stateDir });
        expect.unreachable('expected transition to throw');
      } catch (err) {
        expect((err as FindingError).code).toBe('findings.waiver-revocation-unproven');
      }
    });

    it('refuses a status other than the one held before the waiver', async () => {
      await waive('finding-w2');
      try {
        await transition(
          'finding-w2',
          'confirmed',
          rootCtx(),
          { stateDir },
          {
            waiverRevokedBy: 'sess-findings#99',
          },
        );
        expect.unreachable('expected transition to throw');
      } catch (err) {
        expect((err as FindingError).code).toBe('findings.waiver-revocation-wrong-status');
      }
    });

    it('reopens to the pre-waiver status when the revocation is named', async () => {
      await waive('finding-w3');
      const reopened = await transition(
        'finding-w3',
        'raised',
        rootCtx(),
        { stateDir },
        {
          waiverRevokedBy: 'sess-findings#99',
        },
      );
      expect(reopened.finding_status).toBe('raised');
      expect(reopened.waiver_id).toBeUndefined();
    });
  });

  describe('transition -> waived is gated on severity (severity.yml waiver_semantics)', () => {
    // Regression: transition(id, 'waived') used to succeed for ANY severity.
    // Only S3/S4 are ever waivable; S1/S2 must throw a typed error instead.
    it.each([
      ['S1-stop-the-line', false],
      ['S2-major', false],
      ['S3-minor', true],
      ['S4-nit', true],
    ])('severity=%s: -> waived allowed=%s', async (severity, allowed) => {
      const findingId = `finding-${severity}`;
      await raiseFinding(
        { finding: draft({ finding_id: findingId, severity }), filePath: 'src/foo.ts' },
        rootCtx(),
        { stateDir },
      );

      if (allowed) {
        await expect(
          transition(findingId, 'waived', rootCtx(), { stateDir }),
        ).resolves.toMatchObject({ finding_status: 'waived' });
        return;
      }

      await expect(transition(findingId, 'waived', rootCtx(), { stateDir })).rejects.toThrow(
        FindingError,
      );
      try {
        await transition(findingId, 'waived', rootCtx(), { stateDir });
        expect.unreachable('expected transition to throw');
      } catch (err) {
        expect((err as FindingError).code).toBe('findings.not-waivable');
      }
    });
  });

  // P9-15 (b): a finding's evidence is a claim about code at a point in time.
  // Once a wave merges over the file it is anchored to, that evidence describes
  // code that no longer exists — and a waiver batch answered from it is a
  // decision made on deleted evidence.
  describe('staleFindings', () => {
    async function waveMerged(taskId: string, filesChanged?: string[]): Promise<void> {
      await appendEvent(
        {
          session_id: ctx.sessionId,
          actor: 'system',
          event_type: 'wave-merged',
          task_id: taskId,
          plan_version: 1,
          causal_parent: `${ctx.sessionId}#0`,
          payload: {
            task_ids: [taskId],
            ...(filesChanged ? { files_changed: filesChanged } : {}),
          },
        },
        { stateDir },
      );
    }

    async function taskAdded(taskId: string, claims: string[]): Promise<void> {
      await appendEvent(
        {
          session_id: ctx.sessionId,
          actor: 'system',
          event_type: 'task-added',
          task_id: taskId,
          plan_version: 1,
          causal_parent: `${ctx.sessionId}#0`,
          payload: { claims },
        },
        { stateDir },
      );
    }

    async function raiseOn(filePath: string, findingId = 'finding-1'): Promise<string> {
      const result = await raiseFinding(
        { finding: draft({ finding_id: findingId, severity: 'S3-minor' }), filePath },
        rootCtx(),
        { stateDir },
      );
      if (result.suppressed) throw new Error('unreachable');
      return result.finding.finding_id;
    }

    it('reports nothing when no wave has merged over the finding file', async () => {
      await raiseOn('src/parse.ts');
      await waveMerged('epic-1/task-9', ['src/other.ts']);

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.size).toBe(0);
    });

    it('marks a finding stale once a wave-merged names its file in files_changed', async () => {
      const findingId = await raiseOn('src/parse.ts');
      await waveMerged('epic-1/task-1b', ['src/parse.ts', 'src/other.ts']);

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.get(findingId)).toMatchObject({
        findingId,
        filePath: 'src/parse.ts',
        mergedTaskId: 'epic-1/task-1b',
        basis: 'files-changed',
        matched: 'src/parse.ts',
      });
    });

    it('ignores a merge that landed before the finding was raised', async () => {
      await waveMerged('epic-1/task-1b', ['src/parse.ts']);
      await raiseOn('src/parse.ts');

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.size).toBe(0);
    });

    // Events written before files_changed existed carry no file list at all.
    // Falling back to the merged task's claims keeps those runs answerable,
    // and the basis is reported so an operator can tell an exact answer from
    // an over-broad one.
    it("falls back to the merged task's claims when the event carries no files_changed", async () => {
      await taskAdded('epic-1/task-1b', ['src/*.ts']);
      const findingId = await raiseOn('src/parse.ts');
      await waveMerged('epic-1/task-1b');

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.get(findingId)).toMatchObject({
        mergedTaskId: 'epic-1/task-1b',
        basis: 'claims',
        matched: 'src/*.ts',
      });
    });

    it('reports nothing when the fallback claims do not cover the file either', async () => {
      await taskAdded('epic-1/task-1b', ['docs/**']);
      await raiseOn('src/parse.ts');
      await waveMerged('epic-1/task-1b');

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.size).toBe(0);
    });

    it('is cleared by a re-verification recorded after the merge', async () => {
      const findingId = await raiseOn('src/parse.ts');
      await waveMerged('epic-1/task-1b', ['src/parse.ts']);
      await reverifyFinding(findingId, 'still reproduces on the rewrite', rootCtx(), { stateDir });

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.size).toBe(0);
    });

    // D-191. The same unguarded `finding.file_path` deref as
    // findingContext.ts's, on the branch a merge takes when it carries no
    // files_changed. It never fired on this repo's own logs — the sessions
    // holding unanchored findings had no claims to look up for the merged
    // task, so `.find()` ran over an empty array — but the deref is there and
    // one task-added event is all it takes.
    it('skips a finding that carries no file path instead of throwing', async () => {
      await taskAdded('epic-1/task-1b', ['src/*.ts']);
      const prior = await readEvents(ctx.sessionId, { stateDir });
      await appendFile(
        path.join(stateDir, `${ctx.sessionId}.jsonl`),
        `${JSON.stringify({
          session_id: ctx.sessionId,
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: prior.at(-1)?.event_id ?? null,
          ts: '2026-08-01T00:00:00.000Z',
          payload: {
            ...draft({ finding_id: 'finding-unanchored' }),
            fingerprint: 'fp-unanchored',
          },
        })}\n`,
      );
      const anchored = await raiseOn('src/parse.ts', 'finding-anchored');
      await waveMerged('epic-1/task-1b');

      const stale = await staleFindings(ctx.sessionId, { stateDir });

      // The answerable finding is still answered; the unanswerable one is
      // absent rather than fatal.
      expect(stale.has(anchored)).toBe(true);
      expect(stale.has('finding-unanchored')).toBe(false);
    });

    it('is NOT cleared by a re-verification that predates the merge', async () => {
      const findingId = await raiseOn('src/parse.ts');
      await reverifyFinding(findingId, 'checked before the rewrite', rootCtx(), { stateDir });
      await waveMerged('epic-1/task-1b', ['src/parse.ts']);

      const stale = await staleFindings(ctx.sessionId, { stateDir });
      expect(stale.has(findingId)).toBe(true);
    });
  });

  describe('reverifyFinding', () => {
    it('appends a finding-reverified event carrying the finding, its file and the note', async () => {
      const raised = await raiseFinding({ finding: draft(), filePath: 'src/foo.ts' }, rootCtx(), {
        stateDir,
      });
      if (raised.suppressed) throw new Error('unreachable');

      await reverifyFinding('finding-1', 'still reproduces', rootCtx(), { stateDir });

      const event = (await readEvents(ctx.sessionId, { stateDir })).find(
        (e) => e.record.event_type === 'finding-reverified',
      );
      expect(event?.record.task_id).toBe('epic-1/task-1');
      expect(event?.record.payload).toMatchObject({
        finding_id: 'finding-1',
        fingerprint: raised.finding.fingerprint,
        file_path: 'src/foo.ts',
        note: 'still reproduces',
      });
    });

    // A re-verification is a claim about a specific finding's evidence; an id
    // the log never raised has no evidence to re-read, and silently writing the
    // event would clear a staleness the operator still owes an answer to.
    it('throws findings.unknown-finding for an id the log never raised', async () => {
      try {
        await reverifyFinding('nope', 'note', rootCtx(), { stateDir });
        expect.unreachable('expected reverifyFinding to throw');
      } catch (err) {
        expect((err as FindingError).code).toBe('findings.unknown-finding');
      }
    });

    // A re-verification does not move finding_status: `confirmed` cannot be
    // re-entered and `refuted` means the finding was wrong. Neither says
    // "someone re-read the evidence against the rewritten file".
    it('leaves finding_status untouched', async () => {
      await raiseFinding({ finding: draft(), filePath: 'src/foo.ts' }, rootCtx(), { stateDir });
      await reverifyFinding('finding-1', 'still reproduces', rootCtx(), { stateDir });

      const [listed] = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(listed?.finding_status).toBe('raised');
    });
  });
});

// ---------------------------------------------------------------------------
// D-135. `foldFindings` rebuilds each Finding from `record.payload` alone. A
// payload written without `task_id` folded to `task_id: undefined`, and the
// `--epic` filter then called `epicOfTaskId(undefined)`, which threw a bare
// TypeError out of `smith findings list`. Two properties are wanted, and the
// second is the one that matters: the fold must not throw on a malformed
// record, AND it must not silently swallow it either — a reader that quietly
// drops what it cannot parse reports a clean, short answer, which is the same
// failure the raw filter had in D-130.
// ---------------------------------------------------------------------------

describe('foldFindings on a malformed record', () => {
  const wellFormed = {
    finding_id: 'finding-ok',
    task_id: 'epic-1/task-1',
    fingerprint: 'abc123',
    file_path: 'src/foo.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    summary: 'src/foo.ts:42 off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    found_by: 'reviewer',
  };

  function stored(eventId: string, payload: Record<string, unknown>): StoredEvent {
    return {
      event_id: eventId,
      record: {
        session_id: 'sess-fold',
        actor: 'reviewer',
        event_type: 'finding-raised',
        plan_version: 1,
        causal_parent: 'sess-fold#0',
        payload,
        ts: '2026-08-15T00:00:00.000Z',
      },
    };
  }

  // A record already on disk from before the write-time guard existed. It
  // cannot be validated away retroactively, so the reader has to cope.
  const { task_id: _dropped, ...missingTaskId } = wellFormed;
  const events = [
    stored('sess-fold#1', wellFormed),
    stored('sess-fold#2', { ...missingTaskId, finding_id: 'finding-broken' }),
  ];

  it('filters by epic without throwing, and still returns the good finding', () => {
    const found = foldFindings(events, { epic: 'epic-1' });
    expect(found.map((f) => f.finding_id)).toEqual(['finding-ok']);
  });

  it('names the record it could not fold rather than dropping it in silence', () => {
    const { findings, skipped } = foldFindingsDetailed(events, { epic: 'epic-1' });
    expect(findings.map((f) => f.finding_id)).toEqual(['finding-ok']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.event_id).toBe('sess-fold#2');
    expect(skipped[0]?.reason).toContain('task_id');
  });

  it('reports a skipped record regardless of the filter that was applied', () => {
    expect(foldFindingsDetailed(events, {}).skipped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D-143. D-130 normalised the two task-id spellings in `filterEvents` and
// stopped there. This fold is the sibling reader, and it compares raw — so
// `findings list --task <epic>/<task>` answered 0 for a task with two findings,
// and the epic filter, which derives the epic from that same id, answered the
// close gate with an empty list for an epic holding three `raised` findings.
// ---------------------------------------------------------------------------
describe('foldFindings across the two task-id spellings (D-143)', () => {
  const base = {
    fingerprint: 'abc123',
    file_path: 'src/foo.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    summary: 'src/foo.ts:42 off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    found_by: 'reviewer',
  };

  function stored(eventId: string, payload: Record<string, unknown>): StoredEvent {
    return {
      event_id: eventId,
      record: {
        session_id: 'sess-spell',
        actor: 'reviewer',
        event_type: 'finding-raised',
        plan_version: 1,
        causal_parent: 'sess-spell#0',
        payload,
        ts: '2026-08-15T00:00:00.000Z',
      },
    };
  }

  // Exactly the shape `dogfood-envkit-1.jsonl` carries: raised before the
  // producers were qualified, so the id is bare and `epic_id` is absent.
  const bare = stored('sess-spell#1', {
    ...base,
    finding_id: 'f-bare',
    task_id: 'task-3-validate',
  });
  const qualified = stored('sess-spell#2', {
    ...base,
    finding_id: 'f-qualified',
    task_id: 'epic-1/task-3-validate',
  });

  describe('the task filter', () => {
    it('finds a bare-spelled finding by the canonical qualified id', () => {
      const found = foldFindings([bare], { taskId: 'epic-1/task-3-validate' });
      expect(found.map((f) => f.finding_id)).toEqual(['f-bare']);
    });

    it('finds a qualified finding by the bare id', () => {
      const found = foldFindings([qualified], { taskId: 'task-3-validate' });
      expect(found.map((f) => f.finding_id)).toEqual(['f-qualified']);
    });

    it('returns both spellings of the same task as one record', () => {
      const found = foldFindings([bare, qualified], { taskId: 'epic-1/task-3-validate' });
      expect(found.map((f) => f.finding_id)).toEqual(['f-bare', 'f-qualified']);
    });

    // The other half of D-130's rule: two ids that each name an epic are two
    // tasks, and folding them together trades a silent omission for a silent
    // merge.
    it('does not merge the same bare name across two epics', () => {
      const found = foldFindings([qualified], { taskId: 'epic-2/task-3-validate' });
      expect(found).toEqual([]);
    });
  });

  describe('the epic filter', () => {
    // The filter is right not to guess: a bare id is not evidence of belonging
    // to an epic of that name. What it may not do is let the gate read that
    // silence as "this epic has no findings".
    it('quarantines a finding whose epic cannot be resolved instead of dropping it', () => {
      const { findings, skipped } = foldFindingsDetailed([bare], { epic: 'epic-1' });
      expect(findings).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.event_id).toBe('sess-spell#1');
      expect(skipped[0]?.finding_id).toBe('f-bare');
      expect(skipped[0]?.reason).toContain('epic');
    });

    it('does not quarantine a finding that names its epic outright', () => {
      const withEpic = stored('sess-spell#3', {
        ...base,
        finding_id: 'f-epic-field',
        task_id: 'task-3-validate',
        epic_id: 'epic-1',
      });
      const { findings, skipped } = foldFindingsDetailed([withEpic], { epic: 'epic-1' });
      expect(findings.map((f) => f.finding_id)).toEqual(['f-epic-field']);
      expect(skipped).toEqual([]);
    });

    // A finding that provably belongs elsewhere is excluded, not quarantined:
    // the gate is only owed records it cannot place.
    it('excludes another epic without quarantining it', () => {
      const other = stored('sess-spell#4', {
        ...base,
        finding_id: 'f-other',
        task_id: 'epic-2/task-9',
      });
      const { findings, skipped } = foldFindingsDetailed([other], { epic: 'epic-1' });
      expect(findings).toEqual([]);
      expect(skipped).toEqual([]);
    });

    it('leaves an unfiltered fold alone — no epic was asked for, none is owed', () => {
      const { findings, skipped } = foldFindingsDetailed([bare], {});
      expect(findings.map((f) => f.finding_id)).toEqual(['f-bare']);
      expect(skipped).toEqual([]);
    });
  });
});
