import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebuild } from '../../../factory/orchestrator/src/db/projector.js';
import { appendEvent, readEvents } from '../../../factory/orchestrator/src/events.js';
import { loadSchedulerPolicy } from '../../../factory/orchestrator/src/scheduler.js';
import {
  buildFixture,
  EPIC_ID,
  SESSION_ID,
  TASK_1,
  TASK_2,
  TASK_4,
} from '../../../factory/orchestrator/test/db/fixtures.js';
import { closeApp, createApp } from '../src/app.js';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const ROADMAP_MD = `## Phase A
- id: phase-a
- status: in-progress
- epics: [${EPIC_ID}]
`;

describe('ui/server app.ts', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  let roadmapPath: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-app-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-app-db-'));
    roadmapPath = path.join(dbDir, 'roadmap.md');
    await writeFile(roadmapPath, ROADMAP_MD, 'utf8');
    await buildFixture({ stateDir });
    dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  function app() {
    return createApp({ dbPath, stateDir, roadmapPath });
  }

  /**
   * Raises a fresh `candidate` lesson in `sessionId` and re-projects. The
   * fixture's own `lesson-1` is already **approved**, so it can only be
   * rejected or superseded — every test of the legal approve path needs a
   * lesson that has not been through the door yet (P9-36).
   */
  async function seedCandidate(
    sessionId: string,
    lessonId: string,
    statement: string,
  ): Promise<void> {
    const existing = await readEvents(sessionId, { stateDir });
    // A log that does not exist yet has to start at its root: causal_parent
    // may only be null for `session-start`.
    let tip = existing[existing.length - 1]?.event_id;
    if (tip === undefined) {
      const root = await appendEvent(
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
      tip = root.event_id;
    }
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'scribe',
        event_type: 'lesson-candidate-raised',
        plan_version: 1,
        causal_parent: tip,
        payload: {
          lesson_id: lessonId,
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_status: 'candidate',
          lesson_scope: 'claim-path',
          // D-140: approval refuses a claim-path lesson with no glob, and
          // every lesson route here approves. claim_path is not editable
          // through the API, so a candidate raised without one can only be
          // rejected — which is the shape the finding asked for, not a gap.
          claim_path: '**/pnpm-lock.yaml',
          statement,
          valid_from: '2026-08-01T00:00:00.000Z',
          superseded_by: null,
          provenance_event_ids: [tip],
        },
      },
      { stateDir },
    );
    await rebuild(dbPath, 'all', { stateDir, roadmapPath });
  }

  async function post(route: string, body: unknown): Promise<Response> {
    const handle = app();
    try {
      return await handle.app.request(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } finally {
      closeApp(handle);
    }
  }

  it('GET /api/health', async () => {
    const handle = app();
    const res = await handle.app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    closeApp(handle);
  });

  it('GET /api/overview reflects the seeded fixture', async () => {
    const handle = app();
    const res = await handle.app.request('/api/overview');
    expect(res.status).toBe(200);
    const body = await json<{
      liveAgentCount: number;
      milestoneProgress: Array<{ milestoneId: string; tasksTotal: number }>;
    }>(res);
    expect(body.liveAgentCount).toBe(2);
    expect(body.milestoneProgress).toHaveLength(1);
    expect(body.milestoneProgress[0]).toMatchObject({ milestoneId: 'phase-a', tasksTotal: 4 });
    closeApp(handle);
  });

  /**
   * Dogfood round 2: the Overview's "Now running" card is fed by sessions,
   * not by the `agents` table's long-lived `live` rows — so the route has to
   * actually carry them over the wire.
   */
  it('GET /api/overview carries the running sessions the Now-running card reads', async () => {
    const handle = app();
    const body = await json<{
      runningSessions: Array<{ sessionId: string; lastEventAt: string; liveAgentCount: number }>;
    }>(await handle.app.request('/api/overview'));
    expect(body.runningSessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
    expect(body.runningSessions[0]).toMatchObject({ liveAgentCount: 2 });
    closeApp(handle);
  });

  it('GET /api/timeline filters by task', async () => {
    const handle = app();
    const res = await handle.app.request(`/api/timeline?task=${encodeURIComponent(TASK_1)}`);
    const body = await json<Array<{ taskId: string | null }>>(res);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((e) => e.taskId === TASK_1)).toBe(true);
    closeApp(handle);
  });

  it('GET /api/kanban supports both ?epic and an all-epics mode (Phase 6b)', async () => {
    const handle = app();
    const scoped = await handle.app.request(`/api/kanban?epic=${EPIC_ID}`);
    expect(scoped.status).toBe(200);

    const all = await handle.app.request('/api/kanban');
    expect(all.status).toBe(200);
    const body = await json<Array<{ tasks: Array<{ taskId: string }> }>>(all);
    expect(body.flatMap((c) => c.tasks)).not.toHaveLength(0);
    closeApp(handle);
  });

  it('GET /api/flow answers the DAG, and a readable planVersion narrows it', async () => {
    const handle = app();
    const unfiltered = await handle.app.request('/api/flow');
    expect(unfiltered.status).toBe(200);
    const graph = await json<{ nodes: Array<{ taskId: string }>; planVersions: number[] }>(
      unfiltered,
    );
    expect(graph.nodes).not.toHaveLength(0);
    expect(graph.planVersions).toEqual([1]);

    const pinned = await handle.app.request('/api/flow?planVersion=1');
    expect(pinned.status).toBe(200);
    const filtered = await json<{ nodes: Array<{ taskId: string }> }>(pinned);
    expect(filtered.nodes.map((n) => n.taskId)).toEqual(graph.nodes.map((n) => n.taskId));

    // An empty param is the picker's own "Current plan" option (value: ''),
    // and reads as the absent one. Unchanged, and asserted so it stays that way.
    const blank = await handle.app.request('/api/flow?planVersion=');
    expect(blank.status).toBe(200);
    expect((await json<{ nodes: unknown[] }>(blank)).nodes).toHaveLength(graph.nodes.length);
    closeApp(handle);
  });

  /**
   * `Number('v2')` is NaN, and `NaN !== undefined` is true -- so flowGraph()'s
   * version filter engaged with a bound that nothing compares less than:
   * every task dropped, 200 OK, an empty DAG. The Flow page is the only view
   * of the graph, so "this plan is empty" was indistinguishable from the
   * truth, and the D-165/D-167 fallback written to guarantee the page always
   * shows something was skipped -- the filter looked like it had been asked
   * for. `v2` is the spelling to expect, because the picker labels versions
   * `v2` while their values are `2`; the page keeps its version in memory
   * rather than in the URL, so the caller that gets here is one hitting the
   * read-only API directly.
   */
  it('GET /api/flow refuses a planVersion it cannot read, instead of emptying the DAG', async () => {
    const handle = app();
    for (const bad of ['v2', 'latest', '2x', 'NaN', 'Infinity', '1.5', '0', '-1']) {
      const res = await handle.app.request(`/api/flow?planVersion=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      const body = await json<{ error: { code: string; details: { planVersion: string } } }>(res);
      expect(body.error.code, bad).toBe('flow.bad-request');
      expect(body.error.details.planVersion, bad).toBe(bad);
    }
    closeApp(handle);
  });

  /**
   * Appends a dispatch straight to the event log and re-projects NOTHING —
   * exactly what the orchestrator does. The DB is downstream of the log, so
   * a dashboard that never re-projects never sees this.
   */
  async function appendDispatch(sessionId: string, taskId: string): Promise<void> {
    const existing = await readEvents(sessionId, { stateDir });
    let tip = existing[existing.length - 1]?.event_id;
    if (tip === undefined) {
      const root = await appendEvent(
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
      tip = root.event_id;
    }
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'planner',
        event_type: 'dispatch_decision',
        task_id: taskId,
        plan_version: 1,
        causal_parent: tip,
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          reason: 'dispatched after the server was already serving',
        },
      },
      { stateDir },
    );
  }

  function inProgress(columns: Array<{ taskStatus: string; tasks: Array<{ taskId: string }> }>) {
    return (columns.find((c) => c.taskStatus === 'in-progress')?.tasks ?? []).map((t) => t.taskId);
  }

  /**
   * Operator report: "Chưa thấy kanban update, inprogress chưa thấy task nào."
   *
   * createApp() opened one connection and every read route queried it, but
   * nothing on the read path ever re-projected — applyDb() was called only by
   * the two WRITE routes (waiver apply-batch, lesson transition). So the
   * dashboard served whatever the last `smith db apply` had left behind, and
   * every dispatch since then was invisible: the projector writes
   * `in-progress` only from a `dispatch_decision`, and the orchestrator
   * appends those to the event log, never to the DB. Polling made it worse,
   * not better — the same frozen snapshot, refetched forever.
   */
  it('serves a dispatch appended to the log after the server started', async () => {
    const handle = app();
    const lateTask = `${EPIC_ID}/task-9`;

    const before = await json<Array<{ taskStatus: string; tasks: Array<{ taskId: string }> }>>(
      await handle.app.request('/api/kanban'),
    );
    expect(before.flatMap((c) => c.tasks).map((t) => t.taskId)).not.toContain(lateTask);

    await appendDispatch(SESSION_ID, lateTask);

    const after = await json<Array<{ taskStatus: string; tasks: Array<{ taskId: string }> }>>(
      await handle.app.request('/api/kanban'),
    );
    expect(inProgress(after)).toContain(lateTask);
    closeApp(handle);
  });

  /**
   * The same defect one level up: a session whose log file did not exist at
   * startup. Fingerprinting only the sessions seen at boot would keep this
   * one invisible for the life of the process, which is the common case for
   * a dashboard left open across `smith run` invocations.
   */
  it('discovers a session whose log was created after the server started', async () => {
    const handle = app();
    await handle.app.request('/api/kanban');

    const lateTask = `${EPIC_ID}/task-10`;
    await appendDispatch('sess-started-later', lateTask);

    const after = await json<Array<{ taskStatus: string; tasks: Array<{ taskId: string }> }>>(
      await handle.app.request('/api/kanban'),
    );
    expect(inProgress(after)).toContain(lateTask);
    closeApp(handle);
  });

  it('GET /api/projects returns the per-project overview breakdown', async () => {
    const handle = app();
    const res = await handle.app.request('/api/projects');
    expect(res.status).toBe(200);
    const body = await json<Array<{ project: string }>>(res);
    expect(body.map((p) => p.project)).toEqual(['black-smith']);
    closeApp(handle);
  });

  // The topbar session picker's feed. It exists as a route of its own rather
  // than as one more caller of /api/overview because the shell fetches it on
  // every scopable page: the picker wants a list of ids, and the overview
  // payload it would otherwise have to ask for carries the stat row, the
  // epics in flight and the review queue with it. /api/projects set the
  // precedent -- a thin projection off the same query, one line wide.
  it('GET /api/sessions returns the picker feed, and never drifts from the overview it projects', async () => {
    const handle = app();
    const res = await handle.app.request('/api/sessions');
    expect(res.status).toBe(200);
    const body = await json<Array<{ sessionId: string; liveAgentCount: number }>>(res);
    expect(body.map((s) => s.sessionId)).toContain(SESSION_ID);

    const full = await json<{ runningSessions: unknown[] }>(
      await handle.app.request('/api/overview'),
    );
    expect(body).toEqual(full.runningSessions);
    closeApp(handle);
  });

  it('GET /api/sessions narrows to a project', async () => {
    const handle = app();
    const mine = await json<Array<{ sessionId: string }>>(
      await handle.app.request('/api/sessions?project=black-smith'),
    );
    expect(mine.map((s) => s.sessionId)).toContain(SESSION_ID);

    const elsewhere = await json<Array<{ sessionId: string }>>(
      await handle.app.request('/api/sessions?project=no-such-project'),
    );
    expect(elsewhere).toEqual([]);
    closeApp(handle);
  });

  it('GET /api/tasks/:taskId 200s for a known task, 404s for an unknown one', async () => {
    const handle = app();
    const found = await handle.app.request(`/api/tasks/${encodeURIComponent(TASK_1)}`);
    expect(found.status).toBe(200);
    const detail = await json<{ task: { taskId: string } }>(found);
    expect(detail.task.taskId).toBe(TASK_1);

    const notFound = await handle.app.request('/api/tasks/no-such-task');
    expect(notFound.status).toBe(404);
    closeApp(handle);
  });

  it('GET /api/lessons, /api/errors, /api/analytics, /api/roadmap all 200', async () => {
    const handle = app();
    for (const route of ['/api/lessons', '/api/errors', '/api/analytics', '/api/roadmap']) {
      const res = await handle.app.request(route);
      expect(res.status, route).toBe(200);
    }
    closeApp(handle);
  });

  it('POST /api/waivers/apply-batch wraps waivers.ts and refreshes the projection', async () => {
    const handle = app();
    // 'fp-never-waived' (used elsewhere in fixtures.ts) is a synthetic
    // fingerprint with no backing finding — applyBatch() validates against
    // real findings, so grab task-2's actual finding-2 fingerprint instead
    // (S3-minor — task-1's finding-1 is S2-major, non-waivable).
    const taskDetailRes = await handle.app.request(`/api/tasks/${encodeURIComponent(TASK_2)}`);
    const detail = await json<{ findings: Array<{ fingerprint: string }> }>(taskDetailRes);
    const fingerprint = detail.findings[0]?.fingerprint;
    if (!fingerprint) throw new Error('fixture: expected task-2 to have at least one finding');

    const res = await handle.app.request('/api/waivers/apply-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        decisions: [{ fingerprint, decision: 'granted', operatorNote: 'ok now' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await json<{ applied: number }>(res)).toEqual({ applied: 1 });

    // Projection was refreshed synchronously — a fresh GET sees it without a
    // separate `db apply` call.
    const events = await readEvents(SESSION_ID, { stateDir });
    expect(events.some((e) => e.record.event_type === 'waiver-granted')).toBe(true);
    closeApp(handle);
  });

  it('POST /api/waivers/apply-batch 400s granting a waiver over a non-waivable (S2) finding, and writes nothing', async () => {
    const handle = app();
    // finding-4 (task-4) is S2-major, still "confirmed" — never fixed or waived.
    const taskDetailRes = await handle.app.request(`/api/tasks/${encodeURIComponent(TASK_4)}`);
    const detail = await json<{ findings: Array<{ fingerprint: string; severity: string }> }>(
      taskDetailRes,
    );
    const finding = detail.findings.find((f) => f.severity === 'S2-major');
    if (!finding) throw new Error('fixture: expected task-4 to have an S2-major finding');

    const before = await readEvents(SESSION_ID, { stateDir });

    const res = await handle.app.request('/api/waivers/apply-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        decisions: [
          { fingerprint: finding.fingerprint, decision: 'granted', operatorNote: 'nope' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('waivers.non-waivable-severity');

    const after = await readEvents(SESSION_ID, { stateDir });
    expect(after).toHaveLength(before.length); // nothing written
    closeApp(handle);
  });

  it('POST /api/waivers/apply-batch 400s on an unknown fingerprint (wraps WaiverError)', async () => {
    const handle = app();
    const res = await handle.app.request('/api/waivers/apply-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        decisions: [{ fingerprint: 'fp-does-not-exist', decision: 'granted', operatorNote: 'x' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('waivers.unknown-fingerprint');
    closeApp(handle);
  });

  it('POST /api/lessons/:id/approve appends lesson-status-changed=approved', async () => {
    await seedCandidate(SESSION_ID, 'lesson-ui-1', 'Approve the candidate the UI is showing.');
    const res = await post('/api/lessons/lesson-ui-1/approve', { sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    const events = await readEvents(SESSION_ID, { stateDir });
    const last = events[events.length - 1];
    expect(last?.record.event_type).toBe('lesson-status-changed');
    expect(last?.record.payload).toMatchObject({ lesson_id: 'lesson-ui-1', to_status: 'approved' });
  });

  it('POST /api/lessons/:id/approve refuses an illegal transition and writes nothing (P9-36)', async () => {
    // The fixture's lesson-1 is already approved. The route used to hand-write
    // the event anyway — a second `to_status: approved` the state machine
    // forbids, which the CLI has refused since P9-1.
    const before = await readEvents(SESSION_ID, { stateDir });
    const res = await post('/api/lessons/lesson-1/approve', { sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('lessons.illegal-transition');
    expect(body.error.message).toContain('superseded, invalidated');
    expect(await readEvents(SESSION_ID, { stateDir })).toHaveLength(before.length);
  });

  it('POST /api/lessons/:id/edit runs the novelty gate, and acceptDuplicate records the override (P9-36)', async () => {
    const dupe = 'Always check the upper loop bound against array length, not a hardcoded value.';
    await seedCandidate(SESSION_ID, 'lesson-ui-1', 'Something else entirely, for now.');
    const before = await readEvents(SESSION_ID, { stateDir });

    // Re-stating lesson-1 verbatim is exactly what the gate exists to stop.
    const refused = await post('/api/lessons/lesson-ui-1/edit', {
      sessionId: SESSION_ID,
      statement: dupe,
    });
    expect(refused.status).toBe(409);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
      'lessons.edit-not-novel',
    );
    expect(await readEvents(SESSION_ID, { stateDir })).toHaveLength(before.length);

    const forced = await post('/api/lessons/lesson-ui-1/edit', {
      sessionId: SESSION_ID,
      statement: dupe,
      acceptDuplicate: true,
    });
    expect(forced.status).toBe(200);
    expect(await json<{ novelty: { novel: boolean; overridden: boolean } }>(forced)).toMatchObject({
      novelty: { novel: false, overridden: true, mostSimilarLessonId: 'lesson-1' },
    });
    const after = await readEvents(SESSION_ID, { stateDir });
    expect(after[after.length - 2]?.record.payload).toMatchObject({
      novelty_override: true,
      duplicate_of: 'lesson-1',
    });
  });

  // D-159 at the UI door. cli.ts made every CLI path into the novelty gate
  // read factory/policies/scheduler.yml; this route still fell through to
  // lessons.ts's own constants, and the two agree today only because the
  // shipped numbers equal the defaults. Nothing here asserts a specific
  // number -- the point is that moving the FILE moves the gate.
  //
  // One statement, two policies, opposite answers. The refusal runs FIRST
  // because it writes nothing: reversing the order would put the statement
  // into the corpus and make the second call a duplicate under any bar.
  it('runs the novelty gate at scheduler.yml lessons bar, not lessons.ts defaults (D-159)', async () => {
    // Overlaps the fixture's lesson-1 ("Always check the upper loop bound
    // against array length, not a hardcoded value.") enough to score above a
    // floor-level bar (0.24) and nowhere near the shipped 0.8. It carries the
    // same negation on purpose: checkNovelty keeps a scored duplicate novel
    // when the polarity conflicts, so a statement that drops the "not" comes
    // back novel under every bar and this test would prove nothing.
    const statement = 'Always check the upper loop bound when a rebuild is not incremental.';
    await seedCandidate(SESSION_ID, 'lesson-ui-1', 'Something else entirely, for now.');

    const shipped = loadSchedulerPolicy();
    const strict = createApp({
      dbPath,
      stateDir,
      roadmapPath,
      schedulerPolicy: {
        ...shipped,
        lessons: { ...shipped.lessons, noveltyJaccardThreshold: 0.01 },
      },
    });
    const refused = await strict.app.request('/api/lessons/lesson-ui-1/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, statement }),
    });
    expect(refused.status).toBe(409);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
      'lessons.edit-not-novel',
    );
    closeApp(strict);

    // Same statement, shipped policy: novel, so the edit lands. Without the
    // wiring both calls answer this way and the test above proves nothing.
    const accepted = await post('/api/lessons/lesson-ui-1/edit', {
      sessionId: SESSION_ID,
      statement,
    });
    expect(accepted.status).toBe(200);
  });

  it('POST /api/lessons/:id/* writes to the lesson OWN session log, never the one the body names (P9-36)', async () => {
    const other = 'sess-other-owner';
    await seedCandidate(other, 'lesson-elsewhere', 'A lesson raised in a different session.');
    const fixtureBefore = await readEvents(SESSION_ID, { stateDir });

    // A body naming someone else's session is refused, not silently obeyed.
    const mismatched = await post('/api/lessons/lesson-elsewhere/approve', {
      sessionId: SESSION_ID,
    });
    expect(mismatched.status).toBe(400);
    expect((await json<{ error: { code: string } }>(mismatched)).error.code).toBe(
      'lessons.session-mismatch',
    );
    expect(await readEvents(SESSION_ID, { stateDir })).toHaveLength(fixtureBefore.length);

    // With no sessionId at all, the lesson's own row decides the log.
    const ok = await post('/api/lessons/lesson-elsewhere/approve', {});
    expect(ok.status).toBe(200);
    const owned = await readEvents(other, { stateDir });
    expect(owned[owned.length - 1]?.record.payload).toMatchObject({
      lesson_id: 'lesson-elsewhere',
      to_status: 'approved',
    });
    expect(await readEvents(SESSION_ID, { stateDir })).toHaveLength(fixtureBefore.length);
  });

  it('POST /api/lessons/:id/approve says so when the lesson OWN log is gone (P9-36/P9-28)', async () => {
    const other = 'sess-archived';
    await seedCandidate(other, 'lesson-archived', 'A lesson whose log is about to vanish.');

    // One long-lived dashboard with the log removed under it — the window this
    // 409 exists for, and one that has to be built on purpose. Every request
    // re-projects the logs it can still see first (createRefresher), and since
    // D-199 `lessons` is refolded from all of them at once, so a reader that
    // starts after the deletion never sees this lesson at all. Here the GET
    // projects the log while it is still there; the delete lands after, and
    // nothing the POST can see has changed, so the stale row survives into it.
    const handle = app();
    try {
      expect((await handle.app.request('/api/lessons')).status).toBe(200);
      await rm(path.join(stateDir, `${other}.jsonl`), { force: true });

      const res = await handle.app.request('/api/lessons/lesson-archived/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(409);
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe('events.unknown-session');
      expect(body.error.message).toContain(other);
    } finally {
      closeApp(handle);
    }
  });

  it('POST /api/lessons/:id/approve 404s when the archived log is already refolded away (D-199)', async () => {
    const other = 'sess-archived';
    await seedCandidate(other, 'lesson-archived', 'A lesson whose log is already gone.');
    await rm(path.join(stateDir, `${other}.jsonl`), { force: true });

    // The other side of the window above: a reader that projects after the
    // deletion refolds `lessons` from the logs that remain, and this one is
    // not among them. 404 is the honest answer — the operator's list dropped
    // the card in the same refold, so there is nothing left to approve.
    const res = await post('/api/lessons/lesson-archived/approve', {});
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('lessons.not-found');
  });

  it('POST /api/lessons/:id/reject appends lesson-status-changed=invalidated', async () => {
    const handle = app();
    const res = await handle.app.request('/api/lessons/lesson-1/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    const events = await readEvents(SESSION_ID, { stateDir });
    const last = events[events.length - 1];
    expect(last?.record.payload).toMatchObject({ lesson_id: 'lesson-1', to_status: 'invalidated' });
    closeApp(handle);
  });

  it('POST /api/lessons/:id/approve|reject|edit 404 on a nonexistent lessonId and write nothing', async () => {
    const handle = app();
    const before = await readEvents(SESSION_ID, { stateDir });

    for (const route of ['approve', 'reject', 'edit'] as const) {
      const res = await handle.app.request(`/api/lessons/no-such-lesson/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, statement: 'x' }),
      });
      expect(res.status, route).toBe(404);
      const body = await json<{ error: { code: string } }>(res);
      expect(body.error.code, route).toBe('lessons.not-found');
    }

    const after = await readEvents(SESSION_ID, { stateDir });
    expect(after).toHaveLength(before.length); // nothing written by any of the 3 routes
    closeApp(handle);
  });

  it('POST /api/lessons/:id/edit appends lesson-edited then lesson-status-changed=approved', async () => {
    await seedCandidate(SESSION_ID, 'lesson-ui-1', 'A statement worth sharpening.');
    const res = await post('/api/lessons/lesson-ui-1/edit', {
      sessionId: SESSION_ID,
      statement: 'A sharper statement.',
    });
    expect(res.status).toBe(200);
    const events = await readEvents(SESSION_ID, { stateDir });
    const tail = events.slice(-2);
    expect(tail.map((e) => e.record.event_type)).toEqual([
      'lesson-edited',
      'lesson-status-changed',
    ]);
    expect(tail[1]?.record.causal_parent).toBe(tail[0]?.event_id);

    const handle = app();
    const lessons = await handle.app.request('/api/lessons');
    const body = await json<{ approved: Array<{ lessonId: string; statement: string }> }>(lessons);
    expect(body.approved.find((l) => l.lessonId === 'lesson-ui-1')?.statement).toBe(
      'A sharper statement.',
    );
    closeApp(handle);
  });

  it('POST /api/lessons/:id/edit 400s with no editable field', async () => {
    const handle = app();
    const res = await handle.app.request('/api/lessons/lesson-1/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(res.status).toBe(400);
    closeApp(handle);
  });

  it('POST /api/lessons/:id/edit 400s (not 500) on a garbage lessonType (fix-round, code #12)', async () => {
    await seedCandidate(SESSION_ID, 'lesson-ui-1', 'A statement with a fine type, for now.');
    const res = await post('/api/lessons/lesson-ui-1/edit', {
      sessionId: SESSION_ID,
      lessonType: 'NOT-A-REAL-TYPE',
    });
    const body = await json<{ error: { code: string } }>(res);
    // Still 400, and now caught one step earlier: routing through
    // transitionLesson() checks the tag BEFORE the first event is written,
    // rather than letting appendEvent's payload validation catch it (P9-36).
    expect(body.error.code).toBe('lessons.invalid-lesson-tag');
    expect(res.status).toBe(400);
  });

  it('a malformed roadmap.md (duplicate milestone id) does not break unrelated writes', async () => {
    const dupRoadmapPath = path.join(dbDir, 'dup-roadmap.md');
    await writeFile(
      dupRoadmapPath,
      '## Phase A\n- id: phase-a\n- status: planned\n\n## Phase A again\n- id: phase-a\n- status: completed\n',
      'utf8',
    );
    const handle = createApp({ dbPath, stateDir, roadmapPath: dupRoadmapPath });

    // Roadmap-backed reads degrade gracefully rather than 500ing — this
    // dbPath already has milestone rows from beforeEach's earlier rebuild()
    // against the GOOD roadmap.md, and a malformed roadmap.md leaves
    // existing rows in place (stale, not wiped — see projectMilestones()'s
    // doc comment) rather than blanking them.
    const overviewRes = await handle.app.request('/api/overview');
    expect(overviewRes.status).toBe(200);
    const roadmapRes = await handle.app.request('/api/roadmap');
    expect(roadmapRes.status).toBe(200);
    const roadmapBody = await json<Array<{ milestoneId: string }>>(roadmapRes);
    expect(roadmapBody.map((m) => m.milestoneId)).toEqual(['phase-a']);

    // An unrelated write (a valid waiver grant on task-2's S3-minor
    // finding — waivable, unlike task-1's S2) still succeeds — the
    // post-write projectMilestones() refresh no longer poisons it.
    const taskDetailRes = await handle.app.request(`/api/tasks/${encodeURIComponent(TASK_2)}`);
    const detail = await json<{ findings: Array<{ fingerprint: string }> }>(taskDetailRes);
    const fingerprint = detail.findings[0]?.fingerprint;
    if (!fingerprint) throw new Error('fixture: expected task-2 to have a finding');

    const waiverRes = await handle.app.request('/api/waivers/apply-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        decisions: [{ fingerprint, decision: 'granted', operatorNote: 'ok' }],
      }),
    });
    expect(waiverRes.status).toBe(200);
    closeApp(handle);
  });

  // ---------------------------------------------------------------------------
  // D-263, at the door. `smith stats --lineage` widens a projected read from
  // one session to the chain it continues; every read route here still took a
  // single `session` and nothing else, so an API caller standing in a
  // continuation session was answered with the window rather than the epic --
  // the same half-an-epic the CLI stopped reporting.
  // ---------------------------------------------------------------------------
  describe('?lineage widens a read from the window to the epic (D-263)', () => {
    const CONTINUATION = 'sess-continuation';
    const TASK_5 = `${EPIC_ID}/task-5`;

    /** A second session that continues the fixture's, carrying one more task
     * on the SAME epic -- the shape SKILL.md recommends when an epic outlasts
     * the window that opened it. */
    async function seedContinuation(): Promise<void> {
      const root = await appendEvent(
        {
          session_id: CONTINUATION,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: `${SESSION_ID}#0`,
          payload: {},
        },
        { stateDir },
      );
      await appendEvent(
        {
          session_id: CONTINUATION,
          actor: 'planner',
          event_type: 'task-added',
          task_id: TASK_5,
          plan_version: 1,
          causal_parent: root.event_id,
          payload: {
            epic_id: EPIC_ID,
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
            plan_version: 1,
            objective: 'Finish what the first window started.',
            claims: ['src/task-5.ts'],
            budget_tokens: 1000,
          },
        },
        { stateDir },
      );
      await rebuild(dbPath, 'all', { stateDir, roadmapPath });
    }

    async function kanbanTasks(query: string): Promise<string[]> {
      const handle = app();
      try {
        const res = await handle.app.request(`/api/kanban?epic=${EPIC_ID}&${query}`);
        expect(res.status).toBe(200);
        const body = await json<Array<{ tasks: Array<{ taskId: string }> }>>(res);
        return body
          .flatMap((c) => c.tasks)
          .map((t) => t.taskId)
          .sort();
      } finally {
        closeApp(handle);
      }
    }

    it('reads the whole epic where ?session alone reads one window of it', async () => {
      await seedContinuation();

      const window = await kanbanTasks(`session=${CONTINUATION}`);
      expect(window).toEqual([TASK_5]);

      const epic = await kanbanTasks(`session=${CONTINUATION}&lineage=true`);
      expect(epic).toContain(TASK_5);
      expect(epic).toContain(TASK_1);
      expect(epic.length).toBeGreaterThan(window.length);
    });

    it('widens the timeline and the flow graph the same way', async () => {
      await seedContinuation();
      const handle = app();
      try {
        const tasksOf = async (query: string): Promise<Set<string>> => {
          const res = await handle.app.request(`/api/timeline?${query}`);
          expect(res.status).toBe(200);
          const body = await json<Array<{ taskId: string | null }>>(res);
          return new Set(body.map((e) => e.taskId).filter((id): id is string => id !== null));
        };
        expect(await tasksOf(`session=${CONTINUATION}`)).toEqual(new Set([TASK_5]));
        expect(await tasksOf(`session=${CONTINUATION}&lineage=true`)).toContain(TASK_1);

        const nodes = async (query: string): Promise<number> => {
          const res = await handle.app.request(`/api/flow?epic=${EPIC_ID}&${query}`);
          expect(res.status).toBe(200);
          return (await json<{ nodes: unknown[] }>(res)).nodes.length;
        };
        expect(await nodes(`session=${CONTINUATION}&lineage=true`)).toBeGreaterThan(
          await nodes(`session=${CONTINUATION}`),
        );
      } finally {
        closeApp(handle);
      }
    });

    it('refuses ?lineage with no session to widen', async () => {
      const handle = app();
      try {
        const res = await handle.app.request('/api/overview?lineage=true');
        expect(res.status).toBe(400);
        const body = await json<{ error: { code: string } }>(res);
        expect(body.error.code).toBe('scope.bad-request');
      } finally {
        closeApp(handle);
      }
    });

    it('refuses a lineage value it cannot read rather than answering narrowly', async () => {
      // Silently ignoring `lineage=1` would hand back the window -- the exact
      // answer the caller asked not to get. A widening flag has to fail loud
      // where a narrowing one (`decisionsOnly`) can afford to fall through.
      const handle = app();
      try {
        const res = await handle.app.request(`/api/kanban?session=${SESSION_ID}&lineage=1`);
        expect(res.status).toBe(400);
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe('scope.bad-request');
      } finally {
        closeApp(handle);
      }
    });

    it('reads lineage=false as the absent flag', async () => {
      await seedContinuation();
      expect(await kanbanTasks(`session=${CONTINUATION}&lineage=false`)).toEqual([TASK_5]);
    });
  });

  describe('static-serve (uiDistDir)', () => {
    let distDir: string;

    beforeEach(async () => {
      // Stand in for ui/dist. Vite copies ui/public/* to the dist ROOT, not
      // into assets/ — which is the whole reason these routes need to exist.
      distDir = await mkdtemp(path.join(tmpdir(), 'smith-app-dist-'));
      await writeFile(
        path.join(distDir, 'index.html'),
        '<!doctype html><title>spa</title>',
        'utf8',
      );
      await writeFile(path.join(distDir, 'favicon.ico'), 'ICO-BYTES', 'utf8');
      await writeFile(path.join(distDir, 'apple-touch-icon.png'), 'PNG-BYTES', 'utf8');
      await writeFile(path.join(distDir, 'favicon-32.png'), 'PNG-BYTES-32', 'utf8');
    });

    afterEach(async () => {
      await rm(distDir, { recursive: true, force: true });
    });

    it('serves root-level static files instead of falling through to the SPA shell', async () => {
      const handle = createApp({ dbPath, stateDir, roadmapPath, uiDistDir: distDir });

      // The catch-all exists so deep links like /tasks/x reach the Vue
      // router. Before the root-file routes were added it also swallowed
      // /favicon.ico: the browser asked for an icon and got index.html with
      // content-type text/html, so the tab showed the default globe and
      // nothing anywhere reported an error.
      for (const file of ['favicon.ico', 'apple-touch-icon.png', 'favicon-32.png']) {
        const res = await handle.app.request(`/${file}`);
        expect(res.status, `${file} status`).toBe(200);
        const body = await res.text();
        expect(body, `${file} body`).not.toContain('<!doctype html>');
        expect(res.headers.get('content-type') ?? '', `${file} content-type`).not.toContain(
          'text/html',
        );
      }

      closeApp(handle);
    });

    it('still routes unknown paths to the SPA shell and leaves /api/ alone', async () => {
      const handle = createApp({ dbPath, stateDir, roadmapPath, uiDistDir: distDir });

      // The guard against over-correcting: a root-file route that shadowed
      // the catch-all would break every deep link in the dashboard.
      const deepLink = await handle.app.request('/tasks/task-1');
      expect(deepLink.status).toBe(200);
      expect(await deepLink.text()).toContain('<!doctype html>');

      // A root-level name that does not exist on disk is a SPA route, not a
      // 404 — /roadmap must not be mistaken for a missing static file.
      const spaRoute = await handle.app.request('/roadmap');
      expect(spaRoute.status).toBe(200);
      expect(await spaRoute.text()).toContain('<!doctype html>');

      // And the API still answers as JSON rather than the shell.
      const api = await handle.app.request('/api/roadmap');
      expect(api.status).toBe(200);
      expect(api.headers.get('content-type') ?? '').toContain('application/json');

      closeApp(handle);
    });
  });
});

// ---------------------------------------------------------------------------
// D-248. projectFindings() holds back a finding it cannot store and NAMES it:
// "a row that lies about what it knows is worse than a row that is missing,
// and worse than the crash this replaces only in that it is quiet. So it is
// named instead." db/projector.test.ts pins that contract on both verbs --
// "apply() reports the same quarantine as rebuild(), not a silently shorter
// table".
//
// The report only exists if someone reads it. `smith db rebuild` does
// (printJson). The dashboard is the only OTHER production caller of apply(),
// and it is the one an operator actually runs -- and createRefresher()
// discarded the return value entirely. Its catch block handles a THROW, which
// is exactly what D-141 stopped doing: the one path that used to shout was
// converted into a return value and this caller was never taught to read it.
// On the shipped dogfood logs that is 9 findings the Findings page does not
// have and does not say it does not have -- 18 quarantine records, because
// each of the nine was raised twice and each raise is short of a different
// required field. They are named once per finding, not once per record: the
// operator's question is which findings are missing, and the second reason
// for a finding already named adds no different answer.
// ---------------------------------------------------------------------------

describe('ui/server app.ts — a finding the projection cannot store', () => {
  let stateDir: string;
  let dbDir: string;
  let dbPath: string;
  /** How many quarantine records the seeded log actually produces for LEGACY_ID. */
  let seededSkips = 0;

  const LEGACY_ID = 'finding-legacy';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-app-skipped-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-app-skipped-db-'));
    await buildFixture({ stateDir });
    // Written straight to the log, bypassing appendEvent, for the reason
    // db/projector.test.ts gives: this is a record from before the write-time
    // guard existed and no test can produce one through the guarded path.
    // Everything but `fingerprint` is well-formed.
    const priorEvents = await readEvents(SESSION_ID, { stateDir });
    const legacy = {
      session_id: SESSION_ID,
      actor: 'reviewer',
      event_type: 'finding-raised',
      task_id: TASK_1,
      plan_version: 1,
      causal_parent: priorEvents.at(-1)?.event_id ?? null,
      ts: '2026-08-15T00:00:00.000Z',
      payload: {
        finding_id: LEGACY_ID,
        task_id: TASK_1,
        finding_category: 'correctness',
        severity: 'S2-major',
        finding_status: 'raised',
        summary: 'raised before findings carried a fingerprint',
        failure_scenario: { inputs: 'n=5', expected: '5 items', actual: '4 items' },
        found_by: 'reviewer',
      },
    };
    // Raised once BEFORE that, short of a different required field. This is
    // the shipped shape exactly: each of the nine quarantined findings was
    // raised twice, so a single fold hands back two records naming one
    // finding -- once from the fold (no `task_id`) and once from the
    // projection (no `fingerprint`).
    const { task_id: _omitted, ...withoutTaskId } = legacy.payload;
    const firstRaise = {
      ...legacy,
      ts: '2026-08-14T00:00:00.000Z',
      payload: withoutTaskId,
    };
    await appendFile(
      path.join(stateDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify(firstRaise)}\n${JSON.stringify(legacy)}\n`,
    );
    // A second session log, so one scan applies more than one -- the shipped
    // state dir has six.
    await appendEvent(
      {
        session_id: 'sess-second',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    dbPath = path.join(dbDir, 'smith.db');
    const seeded = await rebuild(dbPath, 'all', { stateDir });
    seededSkips = seeded.skippedFindings.filter((s) => s.finding_id === LEGACY_ID).length;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('names it on stderr rather than serving a silently shorter table', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const handle = createApp({ dbPath, stateDir });
    try {
      const res = await handle.app.request('/api/overview');
      expect(res.status).toBe(200);
    } finally {
      closeApp(handle);
      spy.mockRestore();
    }

    const warnings = written.join('');
    // The finding id is what an operator greps the log for, and the reason is
    // what tells them it is their data and not the server that is broken.
    // The reason named is the first one the fold reached, in log order.
    expect(warnings).toContain(LEGACY_ID);
    expect(warnings).toContain('missing required string field(s)');
  });

  it('names each quarantined finding once, not once per polled session', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const handle = createApp({ dbPath, stateDir });
    try {
      // ONE request, but the scan behind it applies both session logs, and
      // apply() folds every session at once (D-200) -- so it hands back the
      // same global quarantine each time. A caller that just forwards what it
      // is given names this finding once per session file in the state dir,
      // which is the spam the sibling warning already guards against with
      // `warned`.
      await handle.app.request('/api/overview');
    } finally {
      closeApp(handle);
      spy.mockRestore();
    }

    // Non-vacuity: the fixture has to be capable of naming it more than once
    // before "named once" means anything. Two records per fold, two folds.
    expect(seededSkips).toBeGreaterThan(1);
    const occurrences = written.join('').split(LEGACY_ID).length - 1;
    expect(occurrences).toBe(1);
  });
});
