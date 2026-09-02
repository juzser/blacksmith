import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiProviderConfig,
  CliProviderConfig,
  CrosscheckPolicy,
  PlanQuorumPolicy,
  ProviderConfig,
} from '../src/crosscheck.js';
import { appendEvent, readEvents } from '../src/events.js';
import type { PlanFile, TaskSpecRecord } from '../src/plan.js';
import {
  evaluatePlanQuorumTriggers,
  planQuorumJudgeRequest,
  runPlanQuorum,
} from '../src/planQuorum.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

// ---------------------------------------------------------------------------
// planQuorum.ts is the fourth quorum_triggers host (crosscheck.yml):
// "plan quorum" — critique-only. Same cross-provider quorum harness as
// epic.test.ts's describe block — copied deliberately rather than shared,
// since epic.ts's claim is epic-shaped and planQuorum.ts's is plan-shaped.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_CLI = path.join(here, 'fixtures', 'fake-judge-cli.mjs');
const DEEPSEEK_KEY_ENV = 'TEST_DEEPSEEK_API_KEY';

const testPlanQuorumPolicy: PlanQuorumPolicy = {
  budgetRatio: 0.5,
  confidenceThreshold: 0.8,
  securityCases: ['infra'],
  securityRoles: ['security-reviewer'],
  securityKeywords: [
    'auth',
    'authz',
    'authentication',
    'authorization',
    'credential',
    'secret',
    'token',
    'password',
    'crypto',
    'encryption',
    'tls',
    'injection',
    'xss',
    'csrf',
    'sandbox',
    'permission',
    'privilege',
    'sanitize',
    'escalation',
  ],
};

function codexProvider(overrides: Partial<CliProviderConfig> = {}): CliProviderConfig {
  return {
    name: 'codex',
    kind: 'api',
    transport: 'cli',
    enabled: true,
    mode: 'shadow',
    modelTier: 'mid',
    command: 'node',
    args: [JUDGE_CLI, 'refute'],
    ...overrides,
  };
}

function deepseekProvider(overrides: Partial<ApiProviderConfig> = {}): ApiProviderConfig {
  return {
    name: 'deepseek',
    kind: 'api',
    transport: 'api',
    enabled: true,
    mode: 'shadow',
    modelTier: 'mid',
    baseUrl: 'https://api.example.test',
    model: 'test-model',
    apiKeyEnv: DEEPSEEK_KEY_ENV,
    responseFormatJsonObject: true,
    ...overrides,
  };
}

function policyWith(...externals: ProviderConfig[]): CrosscheckPolicy {
  return {
    ...crosscheckDefaults(),
    providers: {
      claude: { name: 'claude', kind: 'native', enabled: true },
      ...Object.fromEntries(externals.map((p) => [p.name, p])),
    },
    quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
    planQuorum: testPlanQuorumPolicy,
  };
}

function judgingFetch(verdict: 'confirm' | 'refute') {
  return vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ verdict, rationale: `deepseek: ${verdict}` }) },
            },
          ],
        }),
        { status: 200 },
      ),
  );
}

// `TaskSpecRecord`, not `Record<string, unknown>`: every caller feeds the
// result to a validator, and many override a field with something deliberately
// invalid — which is what a validator suite is for. The cast is the one place
// that says so, instead of 46 call sites each restating it.
function task(overrides: Record<string, unknown> = {}): TaskSpecRecord {
  return {
    task_id: 'epic-1/task-1',
    epic_id: 'epic-1',
    plan_version: 1,
    objective: 'Do the thing.',
    output_schema_ref: 'result.schema.json',
    acceptance_criteria: ['it works'],
    claims: ['src/foo/**'],
    budget: { tokens: 100, diff_lines: 10, max_turns: 5 },
    contract: { functional_clauses: ['do the thing'], nonfunctional_clauses: [] },
    case: 'feature',
    origin: 'user',
    task_status: 'todo',
    ...overrides,
  } as TaskSpecRecord;
}

function basePlan(overrides: Partial<PlanFile> = {}): PlanFile {
  return {
    epic_id: 'epic-1',
    version: 1,
    status: 'active',
    tasks: [task()],
    edges: [],
    ...overrides,
  };
}

describe('planQuorum.ts evaluatePlanQuorumTriggers (pure)', () => {
  const epicCapTokens = 10_000; // budgetRatio 0.5 -> 5000-token threshold

  it('fires no trigger for a small, non-security, high-confidence plan', () => {
    const plan = basePlan();
    const triggers = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    expect(triggers).toHaveLength(0);
  });

  it('fires the budget trigger at >= ratio * cap, reporting sum/cap/ratio, and not below it', () => {
    const atThreshold = basePlan({
      tasks: [task({ budget: { tokens: 5000, diff_lines: 10, max_turns: 5 } })],
    });
    const fired = evaluatePlanQuorumTriggers(atThreshold, testPlanQuorumPolicy, epicCapTokens);
    const budgetTrigger = fired.find((t) => t.kind === 'budget');
    expect(budgetTrigger).toBeDefined();
    if (budgetTrigger?.kind !== 'budget') throw new Error('unreachable');
    expect(budgetTrigger.totalTokens).toBe(5000);
    expect(budgetTrigger.capTokens).toBe(epicCapTokens);
    expect(budgetTrigger.ratio).toBe(0.5);

    const belowThreshold = basePlan({
      tasks: [task({ budget: { tokens: 4999, diff_lines: 10, max_turns: 5 } })],
    });
    const notFired = evaluatePlanQuorumTriggers(
      belowThreshold,
      testPlanQuorumPolicy,
      epicCapTokens,
    );
    expect(notFired.some((t) => t.kind === 'budget')).toBe(false);
  });

  it('fires the security trigger when a task case is infra', () => {
    const plan = basePlan({ tasks: [task({ case: 'infra' })] });
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    const security = fired.find((t) => t.kind === 'security');
    expect(security).toBeDefined();
    if (security?.kind !== 'security') throw new Error('unreachable');
    expect(security.matchType).toBe('case');
    expect(security.matchedValue).toBe('infra');
    expect(security.taskId).toBe('epic-1/task-1');
  });

  it('fires the security trigger on a nonfunctional_clauses keyword match, reporting the matched clause', () => {
    const clause = 'Must validate the auth token before granting access.';
    const plan = basePlan({
      tasks: [
        task({ contract: { functional_clauses: ['do it'], nonfunctional_clauses: [clause] } }),
      ],
    });
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    const security = fired.find(
      (t) => t.kind === 'security' && t.matchType === 'nonfunctional_clause',
    );
    expect(security).toBeDefined();
    if (security?.kind !== 'security') throw new Error('unreachable');
    expect(security.matchedValue).toBe(clause);
    expect(security.matchedKeyword).toBeDefined();
    expect(clause.toLowerCase()).toContain((security.matchedKeyword as string).toLowerCase());
  });

  it('fires the low-confidence trigger when a task confidence is below threshold', () => {
    const plan = basePlan({ tasks: [task({ origin: 'inferred', confidence: 0.4 })] });
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    const low = fired.find((t) => t.kind === 'low-confidence');
    expect(low).toBeDefined();
    if (low?.kind !== 'low-confidence') throw new Error('unreachable');
    expect(low.source).toBe('task');
    expect(low.taskId).toBe('epic-1/task-1');
    expect(low.value).toBe(0.4);
    expect(low.threshold).toBe(0.8);
  });

  it('fires the low-confidence trigger from a planner self-reported confidence below threshold', () => {
    const plan = basePlan();
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens, {
      plannerConfidence: 0.5,
    });
    const low = fired.find((t) => t.kind === 'low-confidence' && t.source === 'planner');
    expect(low).toBeDefined();
    if (low?.kind !== 'low-confidence') throw new Error('unreachable');
    expect(low.value).toBe(0.5);
  });

  // D-185, carrying D-113. A plan version holds each superseded copy of a task
  // *beside* the record that replaced it, under the same `task_id` (D-121), so
  // `plan.tasks` is a history and not the plan's ask. All three triggers read
  // it raw. `livePlanTasks` is what plan.ts publishes for this, and D-126
  // already fixed one consumer that iterated the field instead.
  it('sums the budget the plan still asks for, not the budget of its dead copies', () => {
    const plan = basePlan({
      tasks: [
        task({ task_status: 'superseded', budget: { tokens: 4000, diff_lines: 10, max_turns: 5 } }),
        task({ budget: { tokens: 2000, diff_lines: 10, max_turns: 5 } }),
      ],
    });
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    // Raw the two records sum to 6000 and clear the 5000 threshold; the plan
    // asks for 2000. Firing a quorum on the difference spends two providers on
    // a budget nobody declared.
    expect(fired.some((t) => t.kind === 'budget')).toBe(false);
  });

  // envkit-mcp-surface/plan-v5.json on disk today: four ids carry
  // [superseded, superseded, todo], so each fires its clause match three
  // times. Measured on that file, the evaluator emits 14 security triggers
  // where 6 are real, naming task-2-path-guard three times identically.
  it('names a security-sensitive task once per match, not once per dead copy', () => {
    const clause = 'Must validate the auth token before granting access.';
    const withClause = { functional_clauses: ['do it'], nonfunctional_clauses: [clause] };
    const plan = basePlan({
      tasks: [
        task({ task_status: 'superseded', contract: withClause }),
        task({ task_status: 'superseded', contract: withClause }),
        task({ contract: withClause }),
      ],
    });
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    const security = fired.filter((t) => t.kind === 'security');
    expect(security).toHaveLength(1);
    expect(security[0]?.kind === 'security' && security[0].taskId).toBe('epic-1/task-1');
  });

  // The dead copy is where a plan's *withdrawn* judgements live: an amendment
  // that raised confidence from 0.4 to 0.9 is exactly the amendment that
  // should stop the trigger firing.
  it('reads confidence from the live spec, not from the copy that was replaced', () => {
    const plan = basePlan({
      tasks: [
        task({ task_status: 'superseded', origin: 'inferred', confidence: 0.4 }),
        task({ origin: 'inferred', confidence: 0.9 }),
      ],
    });
    const fired = evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens);
    expect(fired.filter((t) => t.kind === 'low-confidence')).toHaveLength(0);
  });

  // An id with no live record left is not part of the plan's ask at all —
  // unlike plan ingest (D-184), which still owes it a `task-superseded`.
  it('ignores an id whose every record is superseded', () => {
    const plan = basePlan({
      tasks: [
        task({ task_status: 'superseded', case: 'infra', origin: 'inferred', confidence: 0.1 }),
        task({ task_status: 'superseded', case: 'infra', origin: 'inferred', confidence: 0.1 }),
      ],
    });
    expect(evaluatePlanQuorumTriggers(plan, testPlanQuorumPolicy, epicCapTokens)).toEqual([]);
  });
});

describe('planQuorum.ts planQuorumJudgeRequest (the evidence the critic reads)', () => {
  const budget = { timeout_ms: 1_000, max_output_bytes: 4_096 };

  // D-185. The prompt is the whole of what the judge sees: it has no file
  // contents and no diff, and it is told to refute the plan until the evidence
  // forces agreement. Listing the amendment history as the plan hands it the
  // objectives the plan *withdrew* and a task count that is not the plan's.
  // plan-v5.json on disk would announce "Tasks: 13" for a 5-task plan.
  it('describes the plan the epic is asking for, not the records it amended away', () => {
    const plan = basePlan({
      tasks: [
        task({ task_status: 'superseded', objective: 'Ship it without the path guard.' }),
        task({ objective: 'Ship it with the path guard.' }),
        task({ task_id: 'epic-1/task-2', objective: 'Second task.' }),
      ],
    });
    const request = planQuorumJudgeRequest(plan, [], budget);

    expect(request.prompt).toContain('Tasks: 2');
    expect(request.prompt).toContain('Ship it with the path guard.');
    expect(request.prompt).not.toContain('Ship it without the path guard.');
  });

  it('says "(no tasks)" when every record in the plan has been superseded', () => {
    const plan = basePlan({ tasks: [task({ task_status: 'superseded' })] });
    const request = planQuorumJudgeRequest(plan, [], budget);
    expect(request.prompt).toContain('Tasks: 0');
    expect(request.prompt).toContain('(no tasks)');
  });
});

describe('planQuorum.ts runPlanQuorum (plan_quorum quorum trigger, critique-only)', () => {
  let stateDir: string;
  let specsDir: string;
  const sessionId = 'sess-plan-quorum';
  const epicId = 'epic-1';
  const originalKey = process.env[DEEPSEEK_KEY_ENV];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-plan-q-'));
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-plan-specs-'));
    process.env[DEEPSEEK_KEY_ENV] = 'sk-test-key';
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
    if (originalKey === undefined) delete process.env[DEEPSEEK_KEY_ENV];
    else process.env[DEEPSEEK_KEY_ENV] = originalKey;
    await rm(stateDir, { recursive: true, force: true });
    await rm(specsDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  async function writePlanFixture(plan: PlanFile) {
    const dir = path.join(specsDir, plan.epic_id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `plan-v${plan.version}.json`), JSON.stringify(plan, null, 2));
  }

  async function quorumEvents() {
    const events = await readEvents(sessionId, { stateDir });
    return {
      all: events,
      quorum: events.filter((e) => e.record.event_type === 'quorum-decision'),
      verdicts: events.filter((e) => e.record.event_type === 'judge-verdict'),
    };
  }

  it('endorses on zero triggers and still records the no-op, endorsed_by no-triggers with zero judge cost (P9-23)', async () => {
    const plan = basePlan();
    await writePlanFixture(plan);

    const outcome = await runPlanQuorum(
      {
        epicId,
        version: 1,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: { policy: policyWith() },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('endorsed');
    expect(outcome.triggers).toHaveLength(0);
    if (outcome.outcome !== 'endorsed') throw new Error('unreachable');
    expect(outcome.endorsedBy).toBe('no-triggers');
    // The mechanical oracle answered; the answer is on the log, not just in
    // the exit code. Zero judge calls is what makes it free, not silence.
    const { quorum, verdicts } = await quorumEvents();
    expect(quorum).toHaveLength(1);
    expect(quorum[0]?.record.payload).toMatchObject({
      endorsed_by: 'no-triggers',
      outcome: 'not-run',
      fired_triggers: [],
      sound: true,
    });
    expect(verdicts).toHaveLength(0);
  });

  it('endorses with triggers reported and records endorsed_by default-no-provider, still zero judge events (P9-23)', async () => {
    const plan = basePlan({ tasks: [task({ case: 'infra' })] });
    await writePlanFixture(plan);

    const outcome = await runPlanQuorum(
      {
        epicId,
        version: 1,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: { policy: policyWith() },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('endorsed');
    expect(outcome.triggers.length).toBeGreaterThan(0);
    if (outcome.outcome !== 'endorsed') throw new Error('unreachable');
    expect(outcome.endorsedBy).toBe('default-no-provider');
    const { quorum, verdicts } = await quorumEvents();
    expect(quorum).toHaveLength(1);
    const payload = quorum[0]?.record.payload as {
      endorsed_by: string;
      outcome: string;
      fired_triggers: unknown[];
      participants: unknown[];
      sound: boolean;
    };
    // The shipped crosscheck.yml has both externals disabled, so this is the
    // only path a shipped configuration can take: the record has to name the
    // triggers that fired and say who endorsed the plan despite them.
    expect(payload.endorsed_by).toBe('default-no-provider');
    expect(payload.outcome).toBe('not-run');
    expect(payload.fired_triggers.length).toBe(outcome.triggers.length);
    expect(payload.participants).toEqual([]);
    expect(payload.sound).toBe(true);
    expect(verdicts).toHaveLength(0);
  });

  it('never claims soundness without naming an endorser: every emitted quorum-decision with sound true carries endorsed_by (P9-23)', async () => {
    const plan = basePlan({ tasks: [task({ case: 'infra' })] });
    await writePlanFixture(plan);
    const fetchMock = judgingFetch('confirm');

    const outcome = await runPlanQuorum(
      {
        epicId,
        version: 1,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active', args: [JUDGE_CLI, 'success'] }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('endorsed');
    if (outcome.outcome !== 'endorsed') throw new Error('unreachable');
    expect(outcome.endorsedBy).toBe('quorum');
    const { quorum } = await quorumEvents();
    expect(quorum).toHaveLength(1);
    expect(quorum[0]?.record.payload).toMatchObject({
      endorsed_by: 'quorum',
      outcome: 'decided',
      decision: 'confirm',
      sound: true,
    });
  });

  it('critiques when two active externals both refute plan soundness, naming the fired triggers on the event', async () => {
    const plan = basePlan({ tasks: [task({ case: 'infra' })] });
    await writePlanFixture(plan);
    const fetchMock = judgingFetch('refute');

    const outcome = await runPlanQuorum(
      {
        epicId,
        version: 1,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active' }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('critiqued');
    const { quorum } = await quorumEvents();
    expect(quorum).toHaveLength(1);
    expect(quorum[0]?.record.payload).toMatchObject({ outcome: 'decided', decision: 'refute' });
    const payload = quorum[0]?.record.payload as { fired_triggers: unknown[] };
    expect(payload.fired_triggers.length).toBeGreaterThan(0);
  });

  it('escalates insufficient-providers when exactly one active external ran (fail-closed, §3)', async () => {
    const plan = basePlan({ tasks: [task({ case: 'infra' })] });
    await writePlanFixture(plan);

    const outcome = await runPlanQuorum(
      {
        epicId,
        version: 1,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: { policy: policyWith(codexProvider({ mode: 'active' })) },
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.outcome).toBe('escalated');
    if (outcome.outcome !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe('insufficient-providers');
  });

  it('is critique-only: after a refute, the plan file on disk is byte-identical and no plan-mutating event exists', async () => {
    const plan = basePlan({ tasks: [task({ case: 'infra' })] });
    await writePlanFixture(plan);
    const planPath = path.join(specsDir, epicId, 'plan-v1.json');
    const before = await readFile(planPath, 'utf8');
    const fetchMock = judgingFetch('refute');

    await runPlanQuorum(
      {
        epicId,
        version: 1,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: {
          policy: policyWith(
            codexProvider({ mode: 'active' }),
            deepseekProvider({ mode: 'active' }),
          ),
          fetchImpl: fetchMock,
        },
      },
      ctx(),
      { stateDir },
    );

    const after = await readFile(planPath, 'utf8');
    expect(after).toBe(before);
    const events = await readEvents(sessionId, { stateDir });
    const planMutatingTypes = new Set(['plan-version-created', 'plan-version-superseded']);
    expect(events.some((e) => planMutatingTypes.has(e.record.event_type))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // `trigger_reason` is the field a log reader scans to answer "why was this
  // plan critiqued". It was a constant. Every plan quorum in every session
  // recorded `low-confidence-plan`, including the two on dogfood-mcp-1 that
  // fired four security triggers each and no confidence trigger at all — that
  // run passed no confidence value for one to fire from. Filed as D-112
  // against the dogfood-mcp-close run and carried unfixed since.
  //
  // The rule these tests pin: the reason names the FIRST trigger that fired,
  // and `fired_triggers` lists the whole set in that same order. One
  // invariant instead of a precedence table — `trigger_reason` and
  // `fired_triggers[0]` name the same trigger, and a reader can check that.
  // -------------------------------------------------------------------------

  async function reasonFor(plan: PlanFile, plannerConfidence?: number) {
    await writePlanFixture(plan);
    await runPlanQuorum(
      {
        epicId,
        version: plan.version,
        planOpts: { specsDir },
        epicCapTokens: 10_000,
        crosscheck: { policy: policyWith() },
        ...(plannerConfidence === undefined ? {} : { plannerConfidence }),
      },
      ctx(),
      { stateDir },
    );
    const { quorum } = await quorumEvents();
    return quorum[0]?.record.payload as {
      trigger_reason: string | null;
      fired_triggers: string[];
    };
  }

  it('names the security trigger when security is what fired (D-112)', async () => {
    const payload = await reasonFor(basePlan({ tasks: [task({ case: 'infra' })] }));
    expect(payload.fired_triggers).toHaveLength(1);
    expect(payload.trigger_reason).toBe('security-plan');
  });

  it('names the budget trigger when the epic budget ratio is what fired (D-112)', async () => {
    const payload = await reasonFor(
      basePlan({ tasks: [task({ budget: { tokens: 5000, diff_lines: 10, max_turns: 5 } })] }),
    );
    expect(payload.fired_triggers).toHaveLength(1);
    expect(payload.trigger_reason).toBe('budget-plan');
  });

  it('still names low-confidence-plan when confidence is what fired (D-112)', async () => {
    const payload = await reasonFor(
      basePlan({ tasks: [task({ origin: 'inferred', confidence: 0.4 })] }),
    );
    expect(payload.fired_triggers).toHaveLength(1);
    expect(payload.trigger_reason).toBe('low-confidence-plan');
  });

  it('records no reason at all when no trigger fired (D-112)', async () => {
    const payload = await reasonFor(basePlan());
    expect(payload.fired_triggers).toEqual([]);
    // `null`, not a trigger name: the same honest-empty choice this payload
    // already makes for `decision` and `escalation_reason`. Nothing fired, so
    // there is no reason to name, and naming one would be the original bug.
    expect(payload.trigger_reason).toBeNull();
  });

  it('names the first fired trigger, the one fired_triggers leads with (D-112)', async () => {
    const payload = await reasonFor(
      basePlan({
        tasks: [task({ case: 'infra', budget: { tokens: 5000, diff_lines: 10, max_turns: 5 } })],
      }),
      0.5,
    );
    expect(payload.fired_triggers.length).toBeGreaterThan(2);
    expect(payload.fired_triggers[0]?.startsWith('budget:')).toBe(true);
    expect(payload.trigger_reason).toBe('budget-plan');
  });
});
