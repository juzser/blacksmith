// Phase 6b e2e fixture extension: a SECOND project ("demo-hub") with TWO
// epics running in parallel waves, some agents still live (never
// terminated), and a mix of done/next tasks — so Roadmap/Flow/Projects
// render meaningfully dense data, on top of the existing single-project
// buildFixture() (factory/orchestrator/test/db/fixtures.ts, project
// "black-smith", left untouched — many unit tests assert its exact shape).
import type { EventOpts } from '../../factory/orchestrator/src/events.js';
import { appendEdge, appendEvent, readEvents } from '../../factory/orchestrator/src/events.js';
import { raiseFinding, transition } from '../../factory/orchestrator/src/findings.js';
import { recordJudgeRun } from '../../factory/orchestrator/src/quorum.js';

async function lastEventId(sessionId: string, opts: EventOpts): Promise<string> {
  const events = await readEvents(sessionId, opts);
  const last = events[events.length - 1];
  if (!last) throw new Error('multiProjectFixture: expected at least one event in the log');
  return last.event_id;
}

export const MULTI_PROJECT_SESSION_ID = 'sess-multiproject-fixture';
export const DEMO_HUB_PROJECT = 'demo-hub';
export const DEMO_HUB_EPIC_A = 'epic-9';
export const DEMO_HUB_EPIC_B = 'epic-10';

export async function buildMultiProjectFixture(opts: EventOpts): Promise<void> {
  const planVersion = 1;
  const project = DEMO_HUB_PROJECT;

  const root = await appendEvent(
    {
      session_id: MULTI_PROJECT_SESSION_ID,
      actor: 'user',
      event_type: 'session-start',
      plan_version: planVersion,
      causal_parent: null,
      project,
      payload: {},
    },
    opts,
  );
  let parent = root.event_id;

  // --- epic-9: a 3-wave chain (root -> mid -> leaf), root/mid done, leaf running ---
  const tasks9 = [
    {
      id: `${DEMO_HUB_EPIC_A}/task-1`,
      objective: 'Bootstrap the employee directory schema.',
      status: 'completed',
    },
    {
      id: `${DEMO_HUB_EPIC_A}/task-2`,
      objective: 'Add the directory search API.',
      status: 'completed',
    },
    {
      id: `${DEMO_HUB_EPIC_A}/task-3`,
      objective: 'Build the directory search UI.',
      status: 'in-progress',
    },
  ];
  for (const t of tasks9) {
    const added = await appendEvent(
      {
        session_id: MULTI_PROJECT_SESSION_ID,
        actor: 'planner',
        event_type: 'task-added',
        task_id: t.id,
        plan_version: planVersion,
        causal_parent: parent,
        project,
        payload: {
          epic_id: DEMO_HUB_EPIC_A,
          case: 'feature',
          origin: 'user',
          task_status: t.status,
          plan_version: planVersion,
          objective: t.objective,
          claims: [`src/${t.id.split('/')[1]}.ts`],
          budget_tokens: 1500,
        },
      },
      opts,
    );
    parent = added.event_id;
  }
  const edge9a = await appendEdge(
    {
      session_id: MULTI_PROJECT_SESSION_ID,
      actor: 'system',
      task_id: tasks9[1]?.id as string,
      plan_version: planVersion,
      causal_parent: parent,
      project,
      payload: { depends_on: tasks9[0]?.id },
    },
    { edge_type: 'artifact', edge_provenance: 'observed' },
    opts,
  );
  parent = edge9a.event_id;
  const edge9b = await appendEdge(
    {
      session_id: MULTI_PROJECT_SESSION_ID,
      actor: 'system',
      task_id: tasks9[2]?.id as string,
      plan_version: planVersion,
      causal_parent: parent,
      project,
      payload: { depends_on: tasks9[1]?.id },
    },
    { edge_type: 'artifact', edge_provenance: 'observed' },
    opts,
  );
  parent = edge9b.event_id;

  // task-1/task-2 dispatched and completed; task-3 dispatched and STILL LIVE (no terminal event).
  // task-2 runs on a second provider at the same tier, so the Analytics cost
  // buckets — keyed by the (model_tier, provider) pair — hold two rows for one
  // tier. That pair is what the §5.8 charts have to roll up (D-221).
  for (const [i, t] of tasks9.entries()) {
    const taskProvider = i === 1 ? 'codex' : 'claude';
    const dispatch = await appendEvent(
      {
        session_id: MULTI_PROJECT_SESSION_ID,
        actor: 'planner',
        event_type: 'dispatch_decision',
        task_id: t.id,
        plan_version: planVersion,
        causal_parent: parent,
        project,
        payload: {
          agent_role: 'coder',
          provider: taskProvider,
          model_tier: 'mid',
          model: taskProvider === 'codex' ? 'codex:default' : 'claude-sonnet-5',
          reason: t.objective,
        },
      },
      opts,
    );
    parent = dispatch.event_id;
    if (i < 2) {
      const result = await appendEvent(
        {
          session_id: MULTI_PROJECT_SESSION_ID,
          actor: 'coder',
          event_type: 'task-result-recorded',
          task_id: t.id,
          plan_version: planVersion,
          causal_parent: parent,
          project,
          payload: {
            task_id: t.id,
            run_status: 'done',
            structured_output: {},
            artifacts: [],
            token_usage:
              taskProvider === 'codex'
                ? { input_tokens: 3800, output_tokens: 1200, total_tokens: 5000 }
                : { input_tokens: 1000, output_tokens: 300, total_tokens: 1300 },
            agent: 'coder',
            provider: taskProvider,
            model_tier: 'mid',
          },
        },
        opts,
      );
      parent = result.event_id;
    }
    // i === 2 (task-3): dispatched, no terminal event -> still live in the agents registry.
  }

  // --- epic-10: two independent (parallel-wave) tasks, both dispatched and live ---
  const tasks10 = [
    { id: `${DEMO_HUB_EPIC_B}/task-1`, objective: 'Draft the growth-tracking data model.' },
    { id: `${DEMO_HUB_EPIC_B}/task-2`, objective: 'Draft the salary-band data model.' },
  ];
  for (const t of tasks10) {
    const added = await appendEvent(
      {
        session_id: MULTI_PROJECT_SESSION_ID,
        actor: 'planner',
        event_type: 'task-added',
        task_id: t.id,
        plan_version: planVersion,
        causal_parent: parent,
        project,
        payload: {
          epic_id: DEMO_HUB_EPIC_B,
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          plan_version: planVersion,
          objective: t.objective,
          claims: [`src/${t.id.split('/')[1]}.ts`],
          budget_tokens: 900,
        },
      },
      opts,
    );
    parent = added.event_id;
  }
  for (const [t, provider] of [[tasks10[0], 'codex'] as const, [tasks10[1], 'deepseek'] as const]) {
    if (!t) continue;
    const dispatch = await appendEvent(
      {
        session_id: MULTI_PROJECT_SESSION_ID,
        actor: 'planner',
        event_type: 'dispatch_decision',
        task_id: t.id,
        plan_version: planVersion,
        causal_parent: parent,
        project,
        payload: {
          agent_role: 'coder',
          provider,
          model_tier: 'small',
          model: `${provider}:default`,
          reason: t.objective,
        },
      },
      opts,
    );
    parent = dispatch.event_id; // both left live — parallel wave, both currently running.
  }

  // An epic-level dispatch: a planner works on the epic itself, so its payload
  // names `epic_id` and carries no task at all. Half the dispatches in a real
  // run are this shape — planner, spec-reviewer, scribe, epic-close judge — and
  // until D-234 the fold had nowhere to record it, so every one of them
  // rendered as "no task assigned" and vanished the moment a project was
  // selected. Left live, so the Overview and the Sessions graph both draw it.
  const epicPlanner = await appendEvent(
    {
      session_id: MULTI_PROJECT_SESSION_ID,
      actor: 'orchestrator',
      event_type: 'dispatch_decision',
      plan_version: planVersion,
      causal_parent: parent,
      project,
      payload: {
        agent_role: 'planner',
        provider: 'claude',
        model_tier: 'frontier',
        model: 'claude-opus-5',
        epic_id: DEMO_HUB_EPIC_B,
        reason: 'Plan the notifications epic.',
      },
    },
    opts,
  );
  parent = epicPlanner.event_id;

  // --- an S3 finding, confirmed and unwaived, on epic-9/task-3 — exercises
  // Task detail's Waive/Deny UI and the Projects hub's pending-review count.
  const waivableTaskId = tasks9[2]?.id;
  if (!waivableTaskId) throw new Error('multiProjectFixture: expected tasks9[2] to exist');
  await raiseFinding(
    {
      finding: {
        finding_id: 'finding-demo-hub-1',
        task_id: waivableTaskId,
        finding_category: 'maintainability',
        severity: 'S3-minor',
        finding_status: 'raised',
        summary: 'search debounce duplicated instead of extracted into a hook',
        failure_scenario: { inputs: 'n/a', expected: 'shared hook', actual: 'duplicated logic' },
        found_by: 'reviewer',
      },
      filePath: `src/${waivableTaskId.split('/')[1]}.ts`,
    },
    { sessionId: MULTI_PROJECT_SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  parent = await lastEventId(MULTI_PROJECT_SESSION_ID, opts);
  await transition(
    'finding-demo-hub-1',
    'confirmed',
    { sessionId: MULTI_PROJECT_SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  parent = await lastEventId(MULTI_PROJECT_SESSION_ID, opts);

  // --- two cross-provider judge runs that reached no verdict, for the two
  // reasons that are not the same reason (D-253). Both go through the real
  // producer, recordJudgeRun(), so the fixture cannot drift from the payload
  // the factory actually writes — dispatch + verdict, and the verdict closes
  // the judge (D-160), so neither adds a phantom live agent.
  //
  // The pair exists because the Timeline row for a failed judge used to read
  // "schema failure" for both, and no screenshot could catch that: no fixture
  // wrote a judge-verdict at all. The shipped logs have eight deepseek runs
  // killed by an unset DEEPSEEK_API_KEY — no request ever sent — rendered as a
  // provider whose answers do not parse.
  const judgedTaskId = tasks9[2]?.id;
  if (!judgedTaskId) throw new Error('multiProjectFixture: expected tasks9[2] to exist');
  for (const run of [
    {
      provider: 'deepseek',
      kind: 'verify' as const,
      code: 'provider.missing-api-key',
      message: 'DEEPSEEK_API_KEY is not set',
    },
    {
      provider: 'codex',
      kind: 'review' as const,
      code: 'provider.invalid-output',
      message: 'response did not match the judge schema',
    },
  ]) {
    await recordJudgeRun(
      {
        taskId: judgedTaskId,
        modelTier: 'frontier',
        model: `${run.provider}:default`,
        kind: run.kind,
        run: {
          provider: run.provider,
          mode: 'shadow',
          outcome: { ok: false, error: { code: run.code, message: run.message } },
        },
        native: {
          provider: 'claude',
          verdict: 'confirm',
          rationale: 'native judge confirmed the finding',
        },
      },
      { sessionId: MULTI_PROJECT_SESSION_ID, planVersion, causalParent: parent },
      opts,
    );
    parent = await lastEventId(MULTI_PROJECT_SESSION_ID, opts);
  }

  // ...and one that did answer, and agreed. Without it the Analytics
  // cross-check card would render two providers that both read "no verdict",
  // which cannot show that a null agreement rate is an absent measurement
  // rather than a zero (D-168) -- the one distinction the card exists to keep.
  // It also makes deepseek the fixture's mixed case: two runs, one verdict.
  await recordJudgeRun(
    {
      taskId: judgedTaskId,
      modelTier: 'frontier',
      model: 'deepseek:default',
      kind: 'verify',
      run: {
        provider: 'deepseek',
        mode: 'shadow',
        outcome: {
          ok: true,
          result: {
            provider: 'deepseek',
            kind: 'verify',
            output: { verdict: 'confirm', rationale: 'the reproduction holds on a clean checkout' },
            latency_ms: 8400,
          },
        },
      },
      native: {
        provider: 'claude',
        verdict: 'confirm',
        rationale: 'native judge confirmed the finding',
      },
    },
    { sessionId: MULTI_PROJECT_SESSION_ID, planVersion, causalParent: parent },
    opts,
  );
  parent = await lastEventId(MULTI_PROJECT_SESSION_ID, opts);
}
