import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import {
  foldJudgeTurns,
  JudgeError,
  outstandingJudges,
  readJudgeArtifact,
  readJudgeTurns,
  recordJudgeDispatch,
  recordJudgeReport,
  type UiuxDeviation,
  uiuxDeviationsToEvidence,
} from '../src/judges.js';

describe('judges.ts', () => {
  let stateDir: string;
  let artifactDir: string;
  const sessionId = 'sess-judges';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-judges-'));
    artifactDir = await mkdtemp(path.join(tmpdir(), 'smith-judge-art-'));
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
    await rm(artifactDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
  const opts = () => ({ stateDir });

  // The shape `finding-evidence.schema.json` requires — the same shape
  // mintFindings validates on the raise side (issue #233). A judge's reported
  // array is read by the same rule, so a fixture standing in for "an artifact
  // with real findings" has to actually satisfy it, not just be an array.
  function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      file_path: 'src/a.ts',
      finding_category: 'correctness',
      severity: 'S2-major',
      summary: 'off-by-one in loop bound',
      failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
      ...overrides,
    };
  }

  async function dispatch(overrides: Record<string, unknown> = {}) {
    return recordJudgeDispatch(
      {
        taskId: 'epic-1/task-1',
        role: 'reviewer',
        round: 1,
        artifactPath: path.join(artifactDir, 'reviewer.json'),
        model: 'claude-opus-5',
        ...overrides,
      } as Parameters<typeof recordJudgeDispatch>[0],
      ctx(),
      opts(),
    );
  }

  async function turns(taskId = 'epic-1/task-1') {
    return foldJudgeTurns(await readEvents(sessionId, opts()), taskId);
  }

  describe('recordJudgeDispatch', () => {
    it('writes a dispatch_decision the agents registry can already fold', async () => {
      const stored = await dispatch();
      expect(stored.record.event_type).toBe('dispatch_decision');
      expect(stored.record.task_id).toBe('epic-1/task-1');
      expect(stored.record.payload).toMatchObject({
        agent_role: 'reviewer',
        provider: 'claude',
        model_tier: 'frontier',
        model: 'claude-opus-5',
        round: 1,
        declared_artifact: path.join(artifactDir, 'reviewer.json'),
      });
    });

    // `code-reviewer` is not a taxonomy agent at all, so it used to surface
    // taxonomy validation's own message; the judge-role check below now
    // catches it first (it is not one of the six judge roles either) with a
    // message that names the real problem instead.
    it('rejects a role that is not a judge role', async () => {
      await expect(dispatch({ role: 'code-reviewer' })).rejects.toBeInstanceOf(JudgeError);
      await expect(dispatch({ role: 'code-reviewer' })).rejects.toThrow(/judge/i);
    });

    // A coder dispatch that accidentally carries `--artifact`/`round` (e.g. a
    // copy-pasted judge dispatch command) must not open a judge turn the gate
    // can never close — `coder` IS a real taxonomy agent, just not a judge
    // one, so this is the case a taxonomy check alone would never catch.
    it('refuses a role that is a real taxonomy agent but not a judge', async () => {
      await expect(dispatch({ role: 'coder' })).rejects.toBeInstanceOf(JudgeError);
      await expect(dispatch({ role: 'coder' })).rejects.toThrow(/judge/i);
      expect(await turns()).toEqual([]);
    });

    // P9-23 made `model` a required dispatch dimension, and this is a dispatch.
    // The reason bites here specifically: `smith judge dispatch` is how the
    // reviewer and the verifier of crosscheck.yml's finder_ne_critic pair get
    // recorded, so a defaulted model would let `smith dispatch check` compare
    // two placeholders and answer a question nobody actually asked the log.
    it('refuses a dispatch that names no model — a defaulted one would launder the asymmetry audit (P9-23)', async () => {
      await expect(dispatch({ model: undefined })).rejects.toBeInstanceOf(JudgeError);
      await expect(dispatch({ model: '  ' })).rejects.toThrow(/model/i);
      expect(await turns()).toEqual([]);
    });

    it('rejects a round below 1 — rounds are 1-based, and 0 reads as "no round"', async () => {
      await expect(dispatch({ round: 0 })).rejects.toBeInstanceOf(JudgeError);
    });
  });

  // `uiux` is a real judge in practice — wave.md's steps 5-7 bracket its
  // visual pass with `smith judge dispatch`/`smith judge report` exactly like
  // grader, reviewer, verifier and security-reviewer — but it is not one of
  // JUDGE_ROLES's six (that set means "owes a declared-artifact line and a
  // blocked Stop", and uiux's artifact is never that array shape). Dispatch
  // and report still have to open and close a turn for it.
  describe('uiux dispatch/report (not a JUDGE_ROLES member, still opens a turn)', () => {
    it('refuses a uiux dispatch with no kind, naming both kinds, and writes no event', async () => {
      const before = (await readEvents(sessionId, opts())).length;
      const attempt = dispatch({ role: 'uiux', artifactPath: path.join(artifactDir, 'k.json') });
      await expect(attempt).rejects.toMatchObject({ code: 'judges.kind-required' });
      await expect(attempt).rejects.toThrow(/--kind spec.*--kind visual/s);
      expect((await readEvents(sessionId, opts())).length).toBe(before);
    });

    it('a uiux dispatch opens a turn and judge report --role uiux closes it', async () => {
      await dispatch({
        role: 'uiux',
        kind: 'visual',
        artifactPath: path.join(artifactDir, 'uiux.json'),
      });
      const open = await turns();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ role: 'uiux', round: 1, kind: 'visual' });

      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', noFindings: true },
        ctx(),
        opts(),
      );
      expect(report.attested).toBe(true);
      expect(outstandingJudges(await turns())).toEqual([]);
    });
  });

  // S2: a uiux task opens a pre-code spec turn and a post-test visual turn,
  // and the old (task, role) fold key let one silently erase the other.
  describe('uiux turn kinds (S2)', () => {
    function uiuxDocument(deviations: unknown[]): Record<string, unknown> {
      return {
        run_status: 'done',
        structured_output: { deviations },
      };
    }

    async function writeArtifact(file: string, document: unknown) {
      await writeFile(file, JSON.stringify(document));
    }

    it('spec and visual turns on one task coexist and close independently', async () => {
      const specArtifact = path.join(artifactDir, 'uiux-spec.json');
      const visualArtifact = path.join(artifactDir, 'uiux-visual.json');
      await dispatch({ role: 'uiux', kind: 'spec', artifactPath: specArtifact });
      await dispatch({ role: 'uiux', kind: 'visual', artifactPath: visualArtifact });

      const open = outstandingJudges(await turns());
      expect(open.map((t) => t.kind).sort()).toEqual(['spec', 'visual']);

      await writeArtifact(specArtifact, uiuxDocument([]));
      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', kind: 'spec', artifactPath: specArtifact },
        ctx(),
        opts(),
      );
      const afterSpec = outstandingJudges(await turns());
      expect(afterSpec).toHaveLength(1);
      expect(afterSpec[0]?.kind).toBe('visual');

      await writeArtifact(visualArtifact, uiuxDocument([{ severity: 'S3-minor' }]));
      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', kind: 'visual', artifactPath: visualArtifact },
        ctx(),
        opts(),
      );
      expect(outstandingJudges(await turns())).toEqual([]);
    });

    it('a real uiux visual object no longer throws, and its count equals its deviations', async () => {
      const file = path.join(artifactDir, 'uiux-visual-count.json');
      await writeArtifact(file, uiuxDocument([{ severity: 'S2-major' }, { severity: 'S3-minor' }]));
      expect(readJudgeArtifact(file, 'uiux', 'epic-1/task-1', 'visual', opts())).toBe(2);
    });

    it('a real uiux spec object reports 0', async () => {
      const file = path.join(artifactDir, 'uiux-spec-count.json');
      await writeArtifact(file, uiuxDocument([{ token: 'color.border.default' }]));
      expect(readJudgeArtifact(file, 'uiux', 'epic-1/task-1', 'spec', opts())).toBe(0);
    });

    it('legacy uiux events with no judge_kind still fold and close', async () => {
      const file = path.join(artifactDir, 'uiux-legacy.json');
      // Written straight to the log: the CLI no longer lets a new kindless
      // uiux dispatch through, but an old log still holds them.
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'user',
          event_type: 'dispatch_decision',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: {
            agent_role: 'uiux',
            provider: 'claude',
            model_tier: 'frontier',
            model: 'claude-opus-5',
            round: 1,
            declared_artifact: file,
          },
        },
        opts(),
      );
      const open = await turns();
      expect(open).toHaveLength(1);
      expect(open[0]?.kind).toBeNull();

      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', noFindings: true },
        ctx(),
        opts(),
      );
      expect(outstandingJudges(await turns())).toEqual([]);
    });

    it('a kindless report closes the one open turn when the other is already closed (spec first)', async () => {
      const specArtifact = path.join(artifactDir, 'order-spec-a.json');
      const visualArtifact = path.join(artifactDir, 'order-visual-a.json');
      await dispatch({ role: 'uiux', kind: 'spec', artifactPath: specArtifact });
      await writeArtifact(specArtifact, uiuxDocument([]));
      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', kind: 'spec', artifactPath: specArtifact },
        ctx(),
        opts(),
      );

      await dispatch({ role: 'uiux', kind: 'visual', artifactPath: visualArtifact });
      await writeArtifact(visualArtifact, uiuxDocument([]));
      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', artifactPath: visualArtifact },
        ctx(),
        opts(),
      );

      expect(outstandingJudges(await turns())).toEqual([]);
    });

    it('a kindless report closes the one open turn when the other is already closed (visual first)', async () => {
      const specArtifact = path.join(artifactDir, 'order-spec-b.json');
      const visualArtifact = path.join(artifactDir, 'order-visual-b.json');
      await dispatch({ role: 'uiux', kind: 'visual', artifactPath: visualArtifact });
      await writeArtifact(visualArtifact, uiuxDocument([]));
      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', kind: 'visual', artifactPath: visualArtifact },
        ctx(),
        opts(),
      );

      await dispatch({ role: 'uiux', kind: 'spec', artifactPath: specArtifact });
      await writeArtifact(specArtifact, uiuxDocument([]));
      await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'uiux', artifactPath: specArtifact },
        ctx(),
        opts(),
      );

      expect(outstandingJudges(await turns())).toEqual([]);
    });

    it('a kindless report after both uiux turns closed errors instead of re-reporting one', async () => {
      const specArtifact = path.join(artifactDir, 'closed-spec.json');
      const visualArtifact = path.join(artifactDir, 'closed-visual.json');
      await dispatch({ role: 'uiux', kind: 'spec', artifactPath: specArtifact });
      await dispatch({ role: 'uiux', kind: 'visual', artifactPath: visualArtifact });
      await writeArtifact(specArtifact, uiuxDocument([]));
      await writeArtifact(visualArtifact, uiuxDocument([]));
      for (const kind of ['spec', 'visual'] as const) {
        await recordJudgeReport(
          {
            taskId: 'epic-1/task-1',
            role: 'uiux',
            kind,
            artifactPath: kind === 'spec' ? specArtifact : visualArtifact,
          },
          ctx(),
          opts(),
        );
      }

      await expect(
        recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'uiux', noFindings: true },
          ctx(),
          opts(),
        ),
      ).rejects.toThrow(/already reported.*--kind/);
    });

    it('a report naming a kind that was never dispatched says which kinds were', async () => {
      await dispatch({
        role: 'uiux',
        kind: 'spec',
        artifactPath: path.join(artifactDir, 'only-spec.json'),
      });

      await expect(
        recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'uiux', kind: 'visual', noFindings: true },
          ctx(),
          opts(),
        ),
      ).rejects.toThrow(/"visual".*dispatched kinds: spec/);
    });

    it('an ambiguous report (two open uiux turns, no kind) errors clearly', async () => {
      await dispatch({
        role: 'uiux',
        kind: 'spec',
        artifactPath: path.join(artifactDir, 'a.json'),
      });
      await dispatch({
        role: 'uiux',
        kind: 'visual',
        artifactPath: path.join(artifactDir, 'b.json'),
      });

      await expect(
        recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'uiux', noFindings: true },
          ctx(),
          opts(),
        ),
      ).rejects.toThrow(/spec.*visual|visual.*spec/);
    });

    it('--kind on a non-uiux role is rejected', async () => {
      await expect(dispatch({ role: 'reviewer', kind: 'spec' })).rejects.toBeInstanceOf(JudgeError);
    });

    it('non-uiux artifacts that are neither a list nor the grader object still throw judges.artifact-not-a-list', async () => {
      const file = path.join(artifactDir, 'reviewer-bad.json');
      await writeArtifact(file, { not: 'a list' });
      try {
        readJudgeArtifact(file, 'reviewer', 'epic-1/task-1');
        throw new Error('expected readJudgeArtifact to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(JudgeError);
        expect((err as JudgeError).code).toBe('judges.artifact-not-a-list');
      }
    });
  });

  describe('uiuxDeviationsToEvidence', () => {
    it('maps a visual deviation onto the findings-evidence shape the gate consumes', () => {
      const deviation: UiuxDeviation = {
        screenshot: 'artifacts/screenshots/dashboard-dark-mobile.png',
        viewport: 'mobile',
        theme: 'dark',
        dimension: 'accessibility',
        severity: 'S2-major',
        expected: 'contrast ratio >= 4.5:1',
        observed: 'contrast ratio 2.1:1',
      };
      const [evidence] = uiuxDeviationsToEvidence([deviation]);
      expect(evidence).toMatchObject({
        file_path: deviation.screenshot,
        finding_category: 'a11y',
        severity: 'S2-major',
        failure_scenario: {
          inputs: 'viewport=mobile theme=dark',
          expected: deviation.expected,
          actual: deviation.observed,
        },
      });
    });

    it('maps a non-accessibility dimension to visual-design', () => {
      const [evidence] = uiuxDeviationsToEvidence([
        {
          screenshot: 'artifacts/screenshots/kanban-light-desktop.png',
          viewport: 'desktop',
          theme: 'light',
          dimension: 'layout_spacing',
          severity: 'S3-minor',
          expected: '16px gap',
          observed: '8px gap',
        },
      ]);
      expect(evidence?.finding_category).toBe('visual-design');
    });
  });

  describe('foldJudgeTurns', () => {
    it('opens one outstanding turn per dispatch that declared an artifact', async () => {
      await dispatch();
      await dispatch({
        role: 'security-reviewer',
        artifactPath: path.join(artifactDir, 'sec.json'),
      });
      const open = outstandingJudges(await turns());
      expect(open.map((t) => t.role).sort()).toEqual(['reviewer', 'security-reviewer']);
      expect(open.every((t) => t.reported === false)).toBe(true);
    });

    it('ignores a dispatch_decision that declared no artifact', async () => {
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: 'dispatch_decision',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            model: 'claude-sonnet-5',
          },
        },
        opts(),
      );
      expect(await turns()).toEqual([]);
    });

    // A hand-written or malformed event can carry `declared_artifact` and
    // `round` on a non-judge role's dispatch (the CLI-level refusal in
    // `recordJudgeDispatch` only stops the ordinary path). The fold has to
    // hold the same line, or a coder dispatch that leaked an artifact line
    // opens a turn nothing will ever close (`judges-outstanding` forever).
    it('ignores a dispatch_decision from a non-judge role even when it carries an artifact and round', async () => {
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: 'dispatch_decision',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            model: 'claude-sonnet-5',
            round: 1,
            declared_artifact: path.join(artifactDir, 'coder.json'),
          },
        },
        opts(),
      );
      expect(await turns()).toEqual([]);
    });

    it('scopes to the task asked about', async () => {
      await dispatch();
      await dispatch({ taskId: 'epic-1/task-2' });
      expect((await turns()).map((t) => t.taskId)).toEqual(['epic-1/task-1']);
    });

    // D-183. `smith gate run <taskId>` stamps whichever spelling the operator
    // typed, and the plan spells every id qualified. A raw `!==` answers "no
    // turns" for a bare ask, and `outstandingJudges` reads an empty set as
    // "every judge reported" — the gate scores a task whose judges never came
    // back, which is the exact state P9-11 exists to refuse.
    it('finds the turn when the gate asks with the bare id', async () => {
      await dispatch();
      const open = outstandingJudges(await turns('task-1'));
      expect(open.map((t) => t.taskId)).toEqual(['epic-1/task-1']);
    });

    it('finds the turn when the dispatch was stamped bare and the gate asks qualified', async () => {
      await dispatch({ taskId: 'task-1' });
      const open = outstandingJudges(await turns('epic-1/task-1'));
      expect(open.map((t) => t.role)).toEqual(['reviewer']);
    });

    it('folds a bare dispatch and its qualified re-dispatch into one turn', async () => {
      await dispatch({ taskId: 'task-1' });
      await dispatch({ round: 2, artifactPath: path.join(artifactDir, 'reviewer-r2.json') });
      const all = await turns('epic-1/task-1');
      expect(all).toHaveLength(1);
      expect(all[0]?.round).toBe(2);
    });

    it('closes a qualified dispatch with a report the operator spelled bare', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), '[]', 'utf8');
      await recordJudgeReport({ taskId: 'task-1', role: 'reviewer' }, ctx(), opts());
      expect(outstandingJudges(await turns())).toEqual([]);
    });

    it('leaves both outstanding when two epics claim the bare id a report names', async () => {
      // Guessing would close one epic's judge with the other epic's report.
      // buildTaskIdAliases refuses the same ambiguity; refusing here blocks the
      // gate, and the operator's remedy is to qualify the id.
      await dispatch();
      await dispatch({ taskId: 'epic-2/task-1' });
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: 'judge-reported',
          task_id: 'task-1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { agent_role: 'reviewer', round: 1, artifact_path: null, finding_count: 0 },
        },
        opts(),
      );
      const open = outstandingJudges(foldJudgeTurns(await readEvents(sessionId, opts())));
      expect(open.map((t) => t.taskId).sort()).toEqual(['epic-1/task-1', 'epic-2/task-1']);
    });

    it('supersedes a role earlier round with its latest one', async () => {
      await dispatch();
      await dispatch({ round: 2, artifactPath: path.join(artifactDir, 'reviewer-r2.json') });
      const all = await turns();
      expect(all).toHaveLength(1);
      expect(all[0]?.round).toBe(2);
      expect(all[0]?.declaredArtifact).toBe(path.join(artifactDir, 'reviewer-r2.json'));
    });

    it('leaves a round-1 report outstanding once round 2 is dispatched', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), '[]', 'utf8');
      await recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts());
      expect(outstandingJudges(await turns())).toEqual([]);

      await dispatch({ round: 2, artifactPath: path.join(artifactDir, 'reviewer-r2.json') });
      expect(outstandingJudges(await turns()).map((t) => t.round)).toEqual([2]);
    });
  });

  describe('recordJudgeReport', () => {
    it('closes the turn and counts the findings the artifact actually holds', async () => {
      await dispatch();
      await writeFile(
        path.join(artifactDir, 'reviewer.json'),
        JSON.stringify([validEvidence(), validEvidence({ file_path: 'src/b.ts' })]),
        'utf8',
      );
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer' },
        ctx(),
        opts(),
      );
      expect(report.findingCount).toBe(2);
      expect(report.attested).toBe(false);

      const stored = (await readEvents(sessionId, opts())).find(
        (e) => e.record.event_type === 'judge-reported',
      );
      expect(stored?.record.task_id).toBe('epic-1/task-1');
      expect(stored?.record.payload).toMatchObject({
        agent_role: 'reviewer',
        round: 1,
        artifact_path: path.join(artifactDir, 'reviewer.json'),
        finding_count: 2,
      });
      // Sibling verbs (audit record, judge dispatch) hand the operator the
      // event_id the append produced, so `--causal-parent` for the next
      // write is a copy-paste, not a log read. `judge report` owed the same:
      // the id on the result must be the id the judge-reported event was
      // actually appended under, not a guess reconstructed from the log.
      expect(report.event_id).toBe(stored?.event_id);
      expect(outstandingJudges(await turns())).toEqual([]);
    });

    // Issue #233: the same schema-shape check mintFindings runs before raising
    // a finding has to run here too, so a malformed artifact is caught when
    // the judge reports rather than surfacing as a crash somewhere downstream
    // that reads the finding_count this would have minted.
    it('refuses a report whose artifact array holds a schema-invalid item, and leaves the turn open', async () => {
      await dispatch();
      await writeFile(
        path.join(artifactDir, 'reviewer.json'),
        JSON.stringify([
          validEvidence(),
          { category: 'correctness', title: 'bad', evidence: 'blah', severity: 'S2-major' },
        ]),
        'utf8',
      );
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-invalid-evidence' });
      // The turn stays open: a failed report is not a report.
      expect(outstandingJudges(await turns())).toHaveLength(1);
    });

    it('still accepts an empty array artifact — an empty review is "[]", written out', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), '[]', 'utf8');
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer' },
        ctx(),
        opts(),
      );
      expect(report.findingCount).toBe(0);
    });

    // `/bs audit`'s four axes are the other array-shaped judge artifact: an
    // `AuditEvidenceItem` (`file_path`, `severity`, `summary`,
    // `failure_scenario`, `confidence`) that `smith audit record` validates
    // on its own terms, never `finding-evidence.schema.json` — it has no
    // `finding_category` and a `confidence` that schema's
    // `additionalProperties: false` does not allow.
    const auditEvidence = () => [
      {
        file_path: 'src/a.ts',
        severity: 'S2-major',
        summary: 'no input validation on the token endpoint',
        failure_scenario: { inputs: 'a', expected: 'b', actual: 'c' },
        confidence: 0.9,
      },
    ];

    it('does not apply finding-evidence shape checking to an "auditor" artifact — the other three axes never review a single task, so there is no taskId to gate on', async () => {
      await dispatch({ role: 'auditor', artifactPath: path.join(artifactDir, 'axis.json') });
      await writeFile(path.join(artifactDir, 'axis.json'), JSON.stringify(auditEvidence()), 'utf8');
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'auditor' },
        ctx(),
        opts(),
      );
      expect(report.findingCount).toBe(1);
    });

    // `security-reviewer` is dual-use: an ordinary per-task security review
    // (real finding-evidence, same five keys as `reviewer`) and the audit's
    // security axis (AuditEvidenceItem, above). The two are told apart by
    // taskId — an audit axis turn's is `<audit-id>.<axis>` (audit.md), never
    // the ordinary "<epic>/<bare>" shape (taskId.ts) — not by role alone.
    it('does not apply finding-evidence shape checking to a "security-reviewer" artifact on an audit axis task id', async () => {
      const auditTaskId = '20260929-a1b2c3d4.security';
      await dispatch({
        taskId: auditTaskId,
        role: 'security-reviewer',
        artifactPath: path.join(artifactDir, 'axis.json'),
      });
      await writeFile(path.join(artifactDir, 'axis.json'), JSON.stringify(auditEvidence()), 'utf8');
      const report = await recordJudgeReport(
        { taskId: auditTaskId, role: 'security-reviewer' },
        ctx(),
        opts(),
      );
      expect(report.findingCount).toBe(1);
    });

    it('applies finding-evidence shape checking to a "security-reviewer" artifact on an ordinary per-task id', async () => {
      await dispatch({
        role: 'security-reviewer',
        artifactPath: path.join(artifactDir, 'axis.json'),
      });
      await writeFile(path.join(artifactDir, 'axis.json'), JSON.stringify(auditEvidence()), 'utf8');
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'security-reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-invalid-evidence' });
      // The turn stays open: a failed report is not a report.
      expect(outstandingJudges(await turns())).toHaveLength(1);
    });

    // `verifier` (verifier.md) echoes a finding back rather than describing a
    // fresh one — `{finding_id, verdict, rationale, failure_scenario}` — a
    // shape that is never finding-evidence, on any taskId.
    it('does not apply finding-evidence shape checking to a "verifier" artifact', async () => {
      await dispatch({ role: 'verifier', artifactPath: path.join(artifactDir, 'verifier.json') });
      await writeFile(
        path.join(artifactDir, 'verifier.json'),
        JSON.stringify([
          {
            finding_id: 'f-1',
            verdict: 'confirmed',
            rationale: 'reproduced against the diff',
            failure_scenario: { inputs: 'a', expected: 'b', actual: 'c' },
          },
        ]),
        'utf8',
      );
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'verifier' },
        ctx(),
        opts(),
      );
      expect(report.findingCount).toBe(1);
    });

    it('refuses a declared artifact that is not on disk', async () => {
      await dispatch();
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-missing' });
      // The turn stays open: a failed report is not a report.
      expect(outstandingJudges(await turns())).toHaveLength(1);
    });

    it('refuses an artifact that exists but does not parse', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), "Now let's run the probes", 'utf8');
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-unparseable' });
    });

    it('refuses an artifact that parses but is not a findings array', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), '{"verdict":"looks fine"}', 'utf8');
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-not-a-list' });
    });

    it('accepts an explicit attestation with no artifact, and records it as one', async () => {
      await dispatch();
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer', noFindings: true },
        ctx(),
        opts(),
      );
      expect(report.attested).toBe(true);
      expect(report.findingCount).toBe(0);
      const stored = (await readEvents(sessionId, opts())).find(
        (e) => e.record.event_type === 'judge-reported',
      );
      expect(stored?.record.payload).toMatchObject({
        artifact_path: null,
        finding_count: 0,
        attested_by: 'operator',
      });
      expect(outstandingJudges(await turns())).toEqual([]);
    });

    it('refuses to report for a role that was never dispatched', async () => {
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.not-dispatched' });
    });

    it('refuses a round that was never dispatched, even when the role was', async () => {
      await dispatch();
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer', round: 2 }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.not-dispatched' });
    });

    it('lets an explicit --artifact override the declared path', async () => {
      await dispatch();
      const elsewhere = path.join(artifactDir, 'moved.json');
      await writeFile(elsewhere, '[]', 'utf8');
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer', artifactPath: elsewhere },
        ctx(),
        opts(),
      );
      expect(report.artifactPath).toBe(elsewhere);
      expect(report.findingCount).toBe(0);
    });

    // FD-1. The grader writes a verdict document, not a findings
    // list, so a grader dispatch minted an obligation that only a re-shaped
    // copy of the grader's own output could discharge — round 1 closed it
    // with a hand-written evidence file. The grader's result file is its
    // report; the criteria it did not pass are what it found.
    describe('for the grader', () => {
      const graderPath = () => path.join(artifactDir, 'grader-r1.json');
      const dispatchGrader = () => dispatch({ role: 'grader', artifactPath: graderPath() });
      const criterion = (status: string) => ({
        criterion: `criterion ${status}`,
        status,
        evidence: 'test/x.test.ts:1',
      });

      it('accepts the grader result document and counts the criteria that did not pass', async () => {
        await dispatchGrader();
        await writeFile(
          graderPath(),
          JSON.stringify({
            run_status: 'done',
            structured_output: {
              round: 1,
              criteria: [criterion('pass'), criterion('fail'), criterion('partial')],
              overall: 'fail',
            },
          }),
          'utf8',
        );
        const report = await recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'grader' },
          ctx(),
          opts(),
        );
        expect(report.findingCount).toBe(2);
        expect(report.attested).toBe(false);
        expect(outstandingJudges(await turns())).toEqual([]);
      });

      it('takes a dead grader as a report of nothing gradable, not as a missing report', async () => {
        await dispatchGrader();
        await writeFile(graderPath(), JSON.stringify({ run_status: 'dead' }), 'utf8');
        const report = await recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'grader' },
          ctx(),
          opts(),
        );
        expect(report.findingCount).toBe(0);
        expect(outstandingJudges(await turns())).toEqual([]);
      });

      it('still takes a findings array from the grader, so the round-1 workaround keeps working', async () => {
        await dispatchGrader();
        await writeFile(graderPath(), JSON.stringify([validEvidence()]), 'utf8');
        const report = await recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'grader' },
          ctx(),
          opts(),
        );
        expect(report.findingCount).toBe(1);
      });

      it('refuses a grader document that carries no criteria', async () => {
        await dispatchGrader();
        await writeFile(
          graderPath(),
          JSON.stringify({ run_status: 'done', structured_output: { overall: 'pass' } }),
          'utf8',
        );
        await expect(
          recordJudgeReport({ taskId: 'epic-1/task-1', role: 'grader' }, ctx(), opts()),
        ).rejects.toMatchObject({ code: 'judges.artifact-not-a-list' });
        expect(outstandingJudges(await turns())).toHaveLength(1);
      });

      it('does not let any other role hand in a grader document', async () => {
        await dispatch();
        await writeFile(
          path.join(artifactDir, 'reviewer.json'),
          JSON.stringify({
            run_status: 'done',
            structured_output: { round: 1, criteria: [criterion('pass')], overall: 'pass' },
          }),
          'utf8',
        );
        await expect(
          recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
        ).rejects.toMatchObject({ code: 'judges.artifact-not-a-list' });
      });
    });
  });

  // Issue #249. An artifact on disk proved only that SOME file existed at the
  // declared path. A capped judge whose earlier round left `[]` there, or a
  // placeholder nobody rewrote, closed its turn with zero findings. The report
  // now also asks whether the file was written during THIS turn.
  describe('artifact freshness (issue #249)', () => {
    const reviewerPath = () => path.join(artifactDir, 'reviewer.json');
    const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);
    const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

    it('refuses an artifact last written before the turn was dispatched, and leaves the turn open', async () => {
      await writeFile(reviewerPath(), '[]', 'utf8');
      await utimes(reviewerPath(), anHourAgo(), anHourAgo());
      await dispatch();
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-stale' });
      expect(outstandingJudges(await turns())).toHaveLength(1);
    });

    it('refuses the same stale file handed in through an explicit --artifact path', async () => {
      await dispatch();
      const elsewhere = path.join(artifactDir, 'moved.json');
      await writeFile(elsewhere, '[]', 'utf8');
      await utimes(elsewhere, anHourAgo(), anHourAgo());
      await expect(
        recordJudgeReport(
          { taskId: 'epic-1/task-1', role: 'reviewer', artifactPath: elsewhere },
          ctx(),
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'judges.artifact-stale' });
    });

    it('records the mtime of a declared artifact that already exists at dispatch, and nothing when it does not', async () => {
      const absent = await dispatch();
      expect(absent.record.payload).not.toHaveProperty('artifact_mtime_at_dispatch');

      // Whole seconds, so the value utimes stores is the value it reads back.
      const stamp = new Date(Math.floor(anHourAgo().getTime() / 1000) * 1000);
      await writeFile(path.join(artifactDir, 'reviewer-r2.json'), '[]', 'utf8');
      await utimes(path.join(artifactDir, 'reviewer-r2.json'), stamp, stamp);
      const present = await dispatch({
        round: 2,
        artifactPath: path.join(artifactDir, 'reviewer-r2.json'),
      });
      expect(present.record.payload.artifact_mtime_at_dispatch).toBe(stamp.getTime());
    });

    // The mtime check alone would pass a file dated in the future — a clock
    // skew or a `touch -d` — however stale its contents. Recording the mtime
    // the file had at dispatch catches it: a judge that wrote nothing leaves
    // that mtime exactly where it was.
    it('refuses an artifact that existed at dispatch and was never rewritten, even when its mtime is later than the dispatch', async () => {
      await writeFile(reviewerPath(), '[]', 'utf8');
      await utimes(reviewerPath(), inAnHour(), inAnHour());
      await dispatch();
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-stale' });
    });

    it('accepts an artifact that existed at dispatch once the judge has rewritten it', async () => {
      await writeFile(reviewerPath(), '[]', 'utf8');
      await utimes(reviewerPath(), anHourAgo(), anHourAgo());
      await dispatch();
      await writeFile(reviewerPath(), JSON.stringify([validEvidence()]), 'utf8');
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer' },
        ctx(),
        opts(),
      );
      expect(report.findingCount).toBe(1);
    });

    // The observed failure: round 1 wrote its artifact and reported; round 2
    // re-dispatched the same path, capped, and wrote nothing. Round 1's file
    // must not close round 2.
    it("does not let an earlier round's artifact close a re-dispatch of the same path", async () => {
      await dispatch();
      await writeFile(reviewerPath(), '[]', 'utf8');
      await recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts());
      // Round 1 finished an hour ago; round 2 reuses its path.
      await utimes(reviewerPath(), anHourAgo(), anHourAgo());
      await dispatch({ round: 2 });
      await expect(
        recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, ctx(), opts()),
      ).rejects.toMatchObject({ code: 'judges.artifact-stale' });
      expect(outstandingJudges(await turns()).map((t) => t.round)).toEqual([2]);
    });

    it('still takes an attestation, which names no file to date', async () => {
      await writeFile(reviewerPath(), '[]', 'utf8');
      await utimes(reviewerPath(), anHourAgo(), anHourAgo());
      await dispatch();
      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer', noFindings: true },
        ctx(),
        opts(),
      );
      expect(report.attested).toBe(true);
    });

    it('folds the dispatch time and the at-dispatch mtime into the turn', async () => {
      const stored = await dispatch();
      const [turn] = await turns();
      expect(turn?.dispatchedAt).toBe(stored.record.ts);
      expect(turn?.artifactMtimeAtDispatch).toBeNull();
    });
  });

  // D-156. `readJudgeTurns` folded one session where every other deciding fold
  // reads the lineage — the D-119 sweep found its callers by grep, and this
  // file was unreadable to grep at the time (D-155). Both halves of the
  // dispatch/report pair break at the session boundary, in opposite
  // directions: the report is refused as if it had no dispatch, and the
  // outstanding set the gate reads comes back empty.
  describe('a judge turn that spans two sessions (D-156)', () => {
    const child = 'sess-judges-round-2';
    const childCtx = () => ({ sessionId: child, planVersion: 1, causalParent: `${child}#0` });

    beforeEach(async () => {
      await appendEvent(
        {
          session_id: child,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: { continues: sessionId },
        },
        { stateDir },
      );
    });

    it('still owes the judge the previous session dispatched', async () => {
      await dispatch();
      const owed = outstandingJudges(await readJudgeTurns('epic-1/task-1', childCtx(), opts()));
      expect(owed.map((t) => t.role)).toEqual(['reviewer']);
    });

    it('accepts the report for a dispatch the previous session recorded', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), '[]', 'utf8');

      const report = await recordJudgeReport(
        { taskId: 'epic-1/task-1', role: 'reviewer' },
        childCtx(),
        opts(),
      );

      expect(report).toMatchObject({ role: 'reviewer', round: 1, findingCount: 0 });
    });

    it('closes the turn once the report lands in the second session', async () => {
      await dispatch();
      await writeFile(path.join(artifactDir, 'reviewer.json'), '[]', 'utf8');
      await recordJudgeReport({ taskId: 'epic-1/task-1', role: 'reviewer' }, childCtx(), opts());

      const owed = outstandingJudges(await readJudgeTurns('epic-1/task-1', childCtx(), opts()));
      expect(owed).toEqual([]);
    });
  });
});
