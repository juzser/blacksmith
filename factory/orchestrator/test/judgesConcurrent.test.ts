import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { findingsForDispatch } from '../src/findingContext.js';
import { listFindings, raiseFinding } from '../src/findings.js';
import {
  foldJudgeTurns,
  outstandingJudges,
  readJudgeTurns,
  recordJudgeDispatch,
  recordJudgeReport,
} from '../src/judges.js';

// Epic bs-optimize criterion 8 (code half): grader, reviewer and
// security-reviewer go out in one message on one task. Nothing here may depend
// on the order their dispatches or reports land in.
const ROLES = ['grader', 'reviewer', 'security-reviewer'] as const;
type Role = (typeof ROLES)[number];
const TASK = 'epic-1/task-1';

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('three judges on one task', () => {
  let stateDir: string;
  let artifactDir: string;
  const sessionId = 'sess-concurrent';
  const child = 'sess-concurrent-2';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-judges-conc-'));
    artifactDir = await mkdtemp(path.join(tmpdir(), 'smith-judges-conc-art-'));
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

  const opts = () => ({ stateDir });
  const ctxOf = (id: string) => ({ sessionId: id, planVersion: 1, causalParent: `${id}#0` });
  const artifactOf = (role: Role, round = 1) => path.join(artifactDir, `${role}-r${round}.json`);

  async function startChild(): Promise<void> {
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
  }

  function dispatch(role: Role, round = 1, id = sessionId) {
    return recordJudgeDispatch(
      { taskId: TASK, role, round, artifactPath: artifactOf(role, round), model: 'claude-opus-5' },
      ctxOf(id),
      opts(),
    );
  }

  const evidence = () => ({
    file_path: 'src/a.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    summary: 'off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
  });

  /** What each role writes: findings lists, and the grader's verdict document. */
  async function writeArtifact(role: Role, round = 1, failing = false): Promise<void> {
    const body =
      role === 'grader'
        ? {
            run_status: 'done',
            structured_output: {
              round,
              criteria: [{ criterion: 'c1', status: failing ? 'fail' : 'pass' }],
              overall: failing ? 'fail' : 'pass',
            },
          }
        : [];
    await writeFile(artifactOf(role, round), JSON.stringify(body), 'utf8');
  }

  const turnsNow = async () => foldJudgeTurns(await readEvents(sessionId, opts()), TASK);

  // (a)
  describe.each(permutations(ROLES))('dispatched in order %s, %s, %s', (...order) => {
    it('folds to three round-1 turns with three distinct declared artifacts', async () => {
      for (const role of order) await dispatch(role);
      const turns = await turnsNow();
      expect(turns.map((t) => t.role).sort()).toEqual([...ROLES].sort());
      expect(turns.every((t) => t.round === 1 && !t.reported)).toBe(true);
      expect(new Set(turns.map((t) => t.declaredArtifact)).size).toBe(3);
      for (const t of turns) expect(t.declaredArtifact).toBe(artifactOf(t.role as Role));
    });
  });

  // (b)
  describe.each(permutations(ROLES))('reports closing in order %s, %s, %s', (...order) => {
    it('leaves exactly the unreported roles outstanding, then none', async () => {
      for (const role of ROLES) await dispatch(role);
      const reported: string[] = [];
      for (const role of order) {
        await writeArtifact(role);
        await recordJudgeReport({ taskId: TASK, role }, ctxOf(sessionId), opts());
        reported.push(role);
        const owed = outstandingJudges(await readJudgeTurns(TASK, ctxOf(sessionId), opts()));
        expect(owed.map((t) => t.role).sort()).toEqual(
          ROLES.filter((r) => !reported.includes(r)).sort(),
        );
      }
      expect(outstandingJudges(await turnsNow())).toEqual([]);
    });
  });

  // (c)
  it('counts a second round per role after a grader bounce, and continues the count in a second session', async () => {
    for (const role of ROLES) await dispatch(role);
    for (const role of ROLES) {
      await writeArtifact(role, 1, role === 'grader');
      await recordJudgeReport({ taskId: TASK, role }, ctxOf(sessionId), opts());
    }
    for (const role of ROLES) await dispatch(role, 2);
    expect((await turnsNow()).map((t) => [t.role, t.round, t.reported])).toEqual([
      ['grader', 2, false],
      ['reviewer', 2, false],
      ['security-reviewer', 2, false],
    ]);

    await startChild();
    for (const role of ROLES) await dispatch(role, 3, child);
    const turns = await readJudgeTurns(TASK, ctxOf(child), opts());
    expect(turns.map((t) => [t.role, t.round])).toEqual([
      ['grader', 3],
      ['reviewer', 3],
      ['security-reviewer', 3],
    ]);
  });

  // (d)
  it("keeps the reviewer's S2 raised through the grader's bounce, for the verifier and the brief", async () => {
    for (const role of ROLES) await dispatch(role);
    const raised = await raiseFinding(
      {
        finding: {
          finding_id: 'f-reviewer-s2',
          task_id: TASK,
          finding_category: 'correctness',
          severity: 'S2-major',
          finding_status: 'raised',
          summary: 'off-by-one in loop bound',
          failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
          found_by: 'reviewer',
        },
        filePath: 'src/a.ts',
      },
      { ...ctxOf(sessionId), actor: 'system' },
      opts(),
    );
    if (raised.suppressed) throw new Error('unreachable');

    await writeFile(artifactOf('reviewer'), JSON.stringify([evidence()]), 'utf8');
    await writeArtifact('security-reviewer');
    await writeArtifact('grader', 1, true);
    const bounce = await recordJudgeReport(
      { taskId: TASK, role: 'grader' },
      ctxOf(sessionId),
      opts(),
    );
    expect(bounce.findingCount).toBe(1);
    await recordJudgeReport({ taskId: TASK, role: 'reviewer' }, ctxOf(sessionId), opts());
    await recordJudgeReport({ taskId: TASK, role: 'security-reviewer' }, ctxOf(sessionId), opts());

    // The verifier reads raised S1/S2 on the task.
    const seen = await listFindings(
      sessionId,
      { taskId: TASK, status: 'raised', severity: 'S2-major' },
      opts(),
    );
    expect(seen.map((f) => f.finding_id)).toEqual(['f-reviewer-s2']);

    // A task's own findings reach its fix round as scope, not as dispatch
    // context (findingsForDispatch excludes them by design), so the brief
    // block is read through the epic-level call and a sibling's call.
    const epicLevel = await findingsForDispatch({ sessionId, claims: [] }, opts());
    expect(epicLevel.findings.map((f) => f.finding_id)).toContain('f-reviewer-s2');
    const sibling = await findingsForDispatch(
      { sessionId, taskId: 'epic-1/task-2', claims: ['src/a.ts'] },
      opts(),
    );
    expect(sibling.findings.map((f) => f.finding_id)).toEqual(['f-reviewer-s2']);
  });
});
