import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { computeFingerprint, listFindings } from '../src/findings.js';
import { nextVersion, type PlanChanges, type PlanFile } from '../src/plan.js';
import { PLAN_AMENDED_EVENT } from '../src/spec.js';
import {
  approveSpecChange,
  foldSpecChanges,
  listSpecChanges,
  proposeSpecChange,
  rejectSpecChange,
  SPEC_CHANGE_DECIDED_EVENT,
  SPEC_CHANGE_PROPOSED_EVENT,
  SpecChangeError,
  type SpecChangeRequest,
} from '../src/specChange.js';
import { grantWaiver } from '../src/waivers.js';

// ---------------------------------------------------------------------------
// The worker half of a living spec. D-33 gave the operator a way out of a spec
// defect — `amendPlan` cuts a new version against the finding that forced it —
// and left two gaps on the other side. A coder mid-flight cannot mint a
// spec-scoped finding at all (only a dispatch carrying `spec: {planVersion}`
// can), and even given one, the operator has to hand-author the `--changes`
// JSON: the content of the fix, which the worker who hit the wall knows and
// the operator does not.
//
// These tests pin the bridge. A worker returns a spec change request in its
// structured_output — the same shape as `research_request`, for the same
// reason: a worker cannot emit an event, so a returned field is the only
// signal that survives the worker dying mid-flight. The dispatcher records it
// as a PROPOSAL. Nothing moves until an operator approves, and approval is
// one command with no JSON authoring, because the diff and the argument are
// already on the event.
// ---------------------------------------------------------------------------

const TASK_ID = 'envkit/task-1b-parse-quotes';
const CRITERION = 'task-1b:criterion-3';

describe('specChange — a worker proposes, the operator decides', () => {
  let stateDir: string;
  let specsDir: string;
  const ctx = { sessionId: 'sess-change', planVersion: 1, causalParent: null };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-change-'));
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-change-plans-'));
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
    await rm(specsDir, { recursive: true, force: true });
  });

  const rootCtx = () => ({ ...ctx, causalParent: `${ctx.sessionId}#0` });
  const opts = () => ({ stateDir, specsDir });

  function planFixture(): PlanFile {
    return {
      epic_id: 'envkit',
      version: 1,
      status: 'active',
      tasks: [
        {
          task_id: TASK_ID,
          epic_id: 'envkit',
          plan_version: 1,
          objective: 'Parse quoted values.',
          output_schema_ref: 'result.schema.json',
          acceptance_criteria: ['multi-line double-quoted values are supported'],
          claims: ['src/parse.ts'],
          budget: { tokens: 1000, diff_lines: 100 },
          contract: { functional_clauses: ['parse quotes'], nonfunctional_clauses: [] },
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
        },
      ],
      edges: [],
    };
  }

  /** What the worker proposes: criterion 3 moved, so task-1b's spec is replaced. */
  function supersedeQuotes(): PlanChanges {
    const task = planFixture().tasks[0];
    if (task === undefined) throw new Error('unreachable');
    return {
      supersede: {
        [TASK_ID]: {
          ...task,
          acceptance_criteria: ['an unterminated double quote is a parse error'],
        },
      },
    };
  }

  function request(overrides: Partial<SpecChangeRequest> = {}): SpecChangeRequest {
    return {
      criterion_ref: CRITERION,
      assumption: 'a multi-line double-quoted value can be reassembled from the lines it spans',
      evidence:
        'src/parse.ts reads the file line by line from a stream that never rewinds, so the second line of a quoted value is consumed before the opening quote is known to be unbalanced',
      changes: supersedeQuotes(),
      sites: ['src/parse.ts'],
      blocking: true,
      ...overrides,
    };
  }

  const proposeInput = (overrides: Partial<SpecChangeRequest> = {}) => ({
    plan: planFixture(),
    taskId: TASK_ID,
    proposedBy: 'coder',
    request: request(overrides),
  });

  // -------------------------------------------------------------------------

  describe('proposeSpecChange — a worker returns a diff, and nothing moves', () => {
    it('raises a spec-scoped finding, records the proposal, and writes no plan file', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());

      expect(proposal.status).toBe('open');
      expect(proposal.baseVersion).toBe(1);
      expect(proposal.epicId).toBe('envkit');
      expect(proposal.taskId).toBe(TASK_ID);
      expect(proposal.blocking).toBe(true);

      // The anchor. `amendPlan` refuses an amendment that cites no spec
      // finding, so a proposal that raised none could never be approved.
      const findings = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.finding_id).toBe(proposal.findingId);
      expect(findings[0]?.finding_scope).toBe('spec');
      expect(findings[0]?.finding_status).toBe('raised');
      expect(findings[0]?.spec_ref).toEqual({ plan_version: 1, criterion_ref: CRITERION });
      expect(findings[0]?.task_id).toBe(TASK_ID);

      const events = await readEvents(ctx.sessionId, { stateDir });
      const proposed = events.filter((e) => e.record.event_type === SPEC_CHANGE_PROPOSED_EVENT);
      expect(proposed).toHaveLength(1);
      // The proposal's identity IS the event that recorded it — the same rule
      // SpecReviewRecord.eventId follows. Nothing new is minted.
      expect(proposal.proposalId).toBe(proposed[0]?.event_id);

      // A proposal is data, not a command (D-33). No version was cut.
      expect(existsSync(path.join(specsDir, 'envkit'))).toBe(false);
      expect(events.filter((e) => e.record.event_type === PLAN_AMENDED_EVENT)).toHaveLength(0);
    });

    it("carries the worker's argument and the applied diff, so approval reads rather than re-derives", async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());

      const events = await readEvents(ctx.sessionId, { stateDir });
      const proposed = events.find((e) => e.record.event_type === SPEC_CHANGE_PROPOSED_EVENT);
      expect(proposed?.record.task_id).toBe(TASK_ID);
      expect(proposed?.record.payload).toMatchObject({
        epic_id: 'envkit',
        base_version: 1,
        proposed_by: 'coder',
        criterion_ref: CRITERION,
        finding_id: proposal.findingId,
        blocking: true,
        sites: ['src/parse.ts'],
      });
      // Both halves of "duyệt nhanh": the diff the operator would otherwise
      // hand-author, and the argument they would otherwise have to reconstruct.
      expect(proposed?.record.payload.changes).toEqual(supersedeQuotes());
      expect(proposal.diff.superseded).toEqual([TASK_ID]);
      expect(proposal.assumption).toContain('reassembled');
      expect(proposal.evidence).toContain('never rewinds');
    });

    it('refuses a proposal that names no criterion', async () => {
      await expect(
        proposeSpecChange(proposeInput({ criterion_ref: '  ' }), rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-without-criterion' });
      expect(await readEvents(ctx.sessionId, { stateDir })).toHaveLength(1);
    });

    it('refuses a proposal that states no assumption or no evidence', async () => {
      // Whitespace, not empty: `minLength: 1` is satisfied by three spaces, so
      // this is the half of the argument guard the schema genuinely cannot
      // reach, and the half that would otherwise reach an operator as a
      // criterion overturned on a blank line.
      await expect(
        proposeSpecChange(proposeInput({ assumption: '  ' }), rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-without-argument' });
      await expect(
        proposeSpecChange(proposeInput({ evidence: '   ' }), rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-without-argument' });
    });

    it('refuses a proposal that names no site (D-123, asked where the worker knows)', async () => {
      // Same split as the argument guard: `minItems: 1` owns the empty array,
      // and a list of blanks is what survives it.
      await expect(
        proposeSpecChange(proposeInput({ sites: ['  '] }), rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-without-sites' });
    });

    it('refuses a request the published schema rejects, before any of its own guards', async () => {
      // The schema is the contract a worker is handed, so it has to be the
      // thing that answers a malformed request -- not a second reading of it
      // written out again here. These are the three shapes it owns alone: a
      // required field absent, a field it does not declare, and a severity
      // outside the taxonomy, which no guard in this module resolves.
      for (const bad of [
        { ...request(), assumption: '' },
        { ...request(), sites: [] },
        { ...request(), severity: 'S9-invented' },
        { ...request(), rationale: 'a field the schema does not declare' },
      ]) {
        await expect(
          proposeSpecChange(
            { ...proposeInput(), request: bad as SpecChangeRequest },
            rootCtx(),
            opts(),
          ),
        ).rejects.toMatchObject({ code: 'spec-change.proposal-malformed' });
      }
      // Nothing but the session-start root: a malformed request is refused
      // before the anchor finding is minted, so a rejected proposal leaves no
      // orphan finding waiting on an amendment nobody will cut.
      expect(await readEvents(ctx.sessionId, { stateDir })).toHaveLength(1);
    });

    it("refuses a diff that would not survive the plan's own validator", async () => {
      const task = planFixture().tasks[0];
      if (task === undefined) throw new Error('unreachable');
      // A `case` outside the closed vocabulary: the exact shape a hand-edited
      // or hallucinated diff produces, and exactly what `smith plan validate`
      // would reject about the file this approval would have written.
      const broken: PlanChanges = {
        supersede: { [TASK_ID]: { ...task, case: 'not-a-real-case' } },
      };
      await expect(
        proposeSpecChange(proposeInput({ changes: broken }), rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-invalid-draft' });
      expect(existsSync(path.join(specsDir, 'envkit'))).toBe(false);
    });

    it('refuses a diff that obligates nothing — an approval that discharges on the spot', async () => {
      await expect(
        proposeSpecChange(proposeInput({ changes: {} }), rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-without-obligation' });
    });

    it('refuses when a standing waiver would swallow the finding it needs as an anchor', async () => {
      // The fifth door in raiseFinding: a waiver keyed on this fingerprint
      // suppresses the raise and leaves no finding behind. recordSpecReview
      // skips a suppressed raise; here it is fatal, because the finding is not
      // a record of the proposal — it is the thing `amendPlan` cites, and a
      // proposal without one is permanently unapprovable.
      const suppressible = request({ severity: 'S3-minor' });
      const fingerprint = computeFingerprint({
        filePath: 'src/parse.ts',
        category: 'correctness',
        summary: `${CRITERION} rests on a wrong assumption: ${suppressible.assumption}`,
      });
      await grantWaiver(fingerprint, 'known and accepted for now', rootCtx(), { stateDir });

      await expect(
        proposeSpecChange({ ...proposeInput(), request: suppressible }, rootCtx(), opts()),
      ).rejects.toMatchObject({ code: 'spec-change.proposal-suppressed' });
    });
  });

  // -------------------------------------------------------------------------

  describe("listSpecChanges — the operator's queue", () => {
    it('folds one proposal per event, open until decided', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());

      const open = await listSpecChanges(ctx.sessionId, {}, opts());
      expect(open).toHaveLength(1);
      expect(open[0]?.proposalId).toBe(proposal.proposalId);
      expect(open[0]?.status).toBe('open');
      expect(open[0]?.decision).toBeNull();

      // The pure fold never says 'stale': staleness is a disk read, and a fold
      // that quietly touched the filesystem would make the projector's
      // re-fold of an old log disagree with the log.
      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(foldSpecChanges(events).map((p) => p.status)).toEqual(['open']);
    });

    it('marks a proposal stale once a newer plan version exists', async () => {
      await proposeSpecChange(proposeInput(), rootCtx(), opts());
      // Somebody else amended the plan in the meantime — the proposal was
      // drafted against v1 and v1 is no longer what the factory is building.
      nextVersion(planFixture(), supersedeQuotes(), { specsDir });

      const listed = await listSpecChanges(ctx.sessionId, {}, opts());
      expect(listed[0]?.status).toBe('stale');
      expect(await listSpecChanges(ctx.sessionId, { status: 'open' }, opts())).toHaveLength(0);
      expect(await listSpecChanges(ctx.sessionId, { status: 'stale' }, opts())).toHaveLength(1);
    });

    it('filters by epic and task', async () => {
      await proposeSpecChange(proposeInput(), rootCtx(), opts());
      expect(await listSpecChanges(ctx.sessionId, { epicId: 'envkit' }, opts())).toHaveLength(1);
      expect(await listSpecChanges(ctx.sessionId, { epicId: 'other' }, opts())).toHaveLength(0);
      expect(await listSpecChanges(ctx.sessionId, { taskId: TASK_ID }, opts())).toHaveLength(1);
      expect(
        await listSpecChanges(ctx.sessionId, { taskId: 'envkit/task-2' }, opts()),
      ).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("approveSpecChange — the operator's one command", () => {
    it('cuts v2 through amendPlan, records the decision, and opens the finding’s exit', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      const result = await approveSpecChange(
        { proposalId: proposal.proposalId, plan: planFixture(), decidedBy: 'operator' },
        rootCtx(),
        opts(),
      );

      expect(result.plan.version).toBe(2);
      expect(result.proposal.status).toBe('approved');
      expect(result.proposal.decision?.planVersion).toBe(2);

      const events = await readEvents(ctx.sessionId, { stateDir });
      const amendments = events.filter((e) => e.record.event_type === PLAN_AMENDED_EVENT);
      expect(amendments).toHaveLength(1);
      expect(amendments[0]?.record.payload).toMatchObject({
        epic_id: 'envkit',
        version: 2,
        previous_version: 1,
        amends: [{ finding_id: proposal.findingId, criterion_ref: CRITERION }],
        sites: ['src/parse.ts'],
      });

      const decided = events.filter((e) => e.record.event_type === SPEC_CHANGE_DECIDED_EVENT);
      expect(decided).toHaveLength(1);
      expect(decided[0]?.record.payload).toMatchObject({
        proposal_id: proposal.proposalId,
        decision: 'approved',
        decided_by: 'operator',
        plan_version: 2,
      });

      // The amendment opens the exit; the task ids it obligates walking
      // through it is what closes the finding (D-127).
      const findings = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(findings[0]?.finding_status).toBe('amend-pending');
      expect(findings[0]?.amends_task_ids).toEqual([TASK_ID]);
      expect(findings[0]?.amends_plan_version).toBe(2);

      // And the fold now agrees with the decision.
      const listed = await listSpecChanges(ctx.sessionId, {}, opts());
      expect(listed[0]?.status).toBe('approved');
    });

    it("composes the rationale from the worker's own argument when the operator supplies none", async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      await approveSpecChange(
        { proposalId: proposal.proposalId, plan: planFixture(), decidedBy: 'operator' },
        rootCtx(),
        opts(),
      );

      const events = await readEvents(ctx.sessionId, { stateDir });
      const rationale = events.find((e) => e.record.event_type === PLAN_AMENDED_EVENT)?.record
        .payload.rationale as string;
      // `amendPlan` refuses a blank rationale, and rightly: the diff records
      // what moved and only the rationale records why. Approval stays a single
      // command by REUSING the worker's recorded argument rather than by
      // relaxing that guard or inventing a sentence.
      expect(rationale).toContain(CRITERION);
      expect(rationale).toContain('reassembled');
      expect(rationale).toContain('never rewinds');
      expect(rationale).toContain('coder');
    });

    it("keeps the operator's rationale when they supply one", async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      await approveSpecChange(
        {
          proposalId: proposal.proposalId,
          plan: planFixture(),
          decidedBy: 'operator',
          rationale: 'Agreed — streaming was the point, so the criterion was wrong to assume it.',
        },
        rootCtx(),
        opts(),
      );

      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(
        events.find((e) => e.record.event_type === PLAN_AMENDED_EVENT)?.record.payload.rationale,
      ).toBe('Agreed — streaming was the point, so the criterion was wrong to assume it.');
    });

    it('refuses a proposal that was already decided', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      await approveSpecChange(
        { proposalId: proposal.proposalId, plan: planFixture(), decidedBy: 'operator' },
        rootCtx(),
        opts(),
      );
      await expect(
        approveSpecChange(
          { proposalId: proposal.proposalId, plan: planFixture(), decidedBy: 'operator' },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.already-decided' });
    });

    it('refuses a proposal whose base version has been overtaken', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      const v2 = nextVersion(planFixture(), supersedeQuotes(), { specsDir });

      // Approving against the plan the proposal was drafted from would try to
      // cut v2 a second time; `writePlanFile` refuses that with
      // `plan.version-exists`, which is a correct refusal with a useless
      // message. Fail closed here, naming the version to re-propose against.
      await expect(
        approveSpecChange(
          { proposalId: proposal.proposalId, plan: planFixture(), decidedBy: 'operator' },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.approval-stale' });

      // And approving against the newer plan is refused too: the diff was
      // computed against v1 and nobody has checked it still applies.
      await expect(
        approveSpecChange(
          { proposalId: proposal.proposalId, plan: v2, decidedBy: 'operator' },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.approval-stale' });
    });

    it('refuses a plan from a different epic', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      await expect(
        approveSpecChange(
          {
            proposalId: proposal.proposalId,
            plan: { ...planFixture(), epic_id: 'other' },
            decidedBy: 'operator',
          },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.approval-wrong-epic' });
    });

    it('refuses an unknown proposal id', async () => {
      await expect(
        approveSpecChange(
          { proposalId: 'sess-change#404', plan: planFixture(), decidedBy: 'operator' },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.unknown-proposal' });
    });
  });

  // -------------------------------------------------------------------------

  describe('rejectSpecChange — the criterion stands', () => {
    it('refutes the finding and records the decision', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      const rejected = await rejectSpecChange(
        {
          proposalId: proposal.proposalId,
          decidedBy: 'operator',
          rationale: 'The criterion is right: the stream is buffered upstream, so it can rewind.',
        },
        rootCtx(),
        opts(),
      );

      expect(rejected.status).toBe('rejected');
      const findings = await listFindings(ctx.sessionId, {}, { stateDir });
      expect(findings[0]?.finding_status).toBe('refuted');

      const events = await readEvents(ctx.sessionId, { stateDir });
      expect(events.filter((e) => e.record.event_type === PLAN_AMENDED_EVENT)).toHaveLength(0);
      expect(
        events.find((e) => e.record.event_type === SPEC_CHANGE_DECIDED_EVENT)?.record.payload,
      ).toMatchObject({
        proposal_id: proposal.proposalId,
        decision: 'rejected',
        plan_version: null,
      });
    });

    it('refuses a blank rationale — a rejection is the half a worker has to act on', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      await expect(
        rejectSpecChange(
          { proposalId: proposal.proposalId, decidedBy: 'operator', rationale: '  ' },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.rejection-without-rationale' });
    });

    it('rejects a stale proposal — a superseded diff still deserves an answer', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      nextVersion(planFixture(), supersedeQuotes(), { specsDir });

      const rejected = await rejectSpecChange(
        {
          proposalId: proposal.proposalId,
          decidedBy: 'operator',
          rationale: 'v2 already moved this criterion; the proposal is answered by that amendment.',
        },
        rootCtx(),
        opts(),
      );
      expect(rejected.status).toBe('rejected');
    });

    it('refuses a proposal that was already decided', async () => {
      const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
      await rejectSpecChange(
        {
          proposalId: proposal.proposalId,
          decidedBy: 'operator',
          rationale: 'The criterion is right.',
        },
        rootCtx(),
        opts(),
      );
      await expect(
        approveSpecChange(
          { proposalId: proposal.proposalId, plan: planFixture(), decidedBy: 'operator' },
          rootCtx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'spec-change.already-decided' });
    });
  });

  // -------------------------------------------------------------------------

  it('leaves a third path for an operator who agrees with the finding but not the diff', async () => {
    // Rejection means "the criterion stands", and refutes the finding. An
    // operator who agrees the criterion is wrong and dislikes the proposed
    // shape does not reject: they run `plan amend` citing the same still-raised
    // finding with their own --changes. That needs no code here, and this test
    // is what keeps it true.
    const proposal = await proposeSpecChange(proposeInput(), rootCtx(), opts());
    const findings = await listFindings(ctx.sessionId, {}, { stateDir });
    expect(findings[0]?.finding_status).toBe('raised');
    expect(findings[0]?.finding_scope).toBe('spec');
    expect(proposal.status).toBe('open');
  });
});

describe('SpecChangeError', () => {
  it('is a SmithError, so the CLI renders it like every other refusal', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-change-err-'));
    try {
      const err = new SpecChangeError('spec-change.test', 'message', {});
      expect(err.code).toBe('spec-change.test');
      expect(err).toBeInstanceOf(Error);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
