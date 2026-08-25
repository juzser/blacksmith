import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import {
  foldJudgeTurns,
  JudgeError,
  outstandingJudges,
  readJudgeTurns,
  recordJudgeDispatch,
  recordJudgeReport,
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

    it('rejects a role that is not a taxonomy agent', async () => {
      await expect(dispatch({ role: 'code-reviewer' })).rejects.toThrow(/taxonomy/i);
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
        JSON.stringify([{ filePath: 'src/a.ts', finding: {} }, { filePath: 'src/b.ts' }]),
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
      expect(outstandingJudges(await turns())).toEqual([]);
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
