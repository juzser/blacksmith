import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openDb, rebuild } from '../../src/db/projector.js';
import { analytics, providerAgreement } from '../../src/db/queries.js';
import { appendEvent } from '../../src/events.js';
import type { JudgeResult } from '../../src/providers/types.js';
import { recordJudgeRun } from '../../src/quorum.js';

const SESSION_ID = 'sess-provider-agreement';

function okRun(
  provider: string,
  verdict: 'confirm' | 'refute',
  mode: 'shadow' | 'active' = 'shadow',
) {
  const result: JudgeResult = {
    provider,
    kind: 'verify' as const,
    output: { verdict, rationale: 'x' },
    latency_ms: 100,
  };
  return { provider, mode, outcome: { ok: true as const, result } };
}

function failedRun(
  provider: string,
  mode: 'shadow' | 'active' = 'shadow',
  code = 'provider.invalid-output',
) {
  return {
    provider,
    mode,
    outcome: { ok: false as const, error: { code, message: `failed: ${code}` } },
  };
}

describe('db/queries.ts providerAgreement()', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-provider-agreement-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-provider-agreement-db-'));
    await appendEvent(
      {
        session_id: SESSION_ID,
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
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId: SESSION_ID, planVersion: 1, causalParent: `${SESSION_ID}#0` });

  async function rebuildAndOpen(): Promise<DbHandle> {
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
    return handle;
  }

  it('rates each provider over the runs that answered, not every attempt', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };

    // codex: 2 runs, 1 agrees (confirm matches native), 1 disagrees.
    await recordJudgeRun(
      {
        taskId: 't-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: okRun('codex', 'confirm'),
        native,
      },
      ctx(),
      { stateDir },
    );
    await recordJudgeRun(
      {
        taskId: 't-2',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: okRun('codex', 'refute'),
        native,
      },
      ctx(),
      { stateDir },
    );

    // deepseek: 1 successful agreeing run + 1 schema failure.
    await recordJudgeRun(
      {
        taskId: 't-3',
        modelTier: 'mid',
        model: 'deepseek-reasoner',
        kind: 'verify',
        run: okRun('deepseek', 'confirm'),
        native,
      },
      ctx(),
      { stateDir },
    );
    await recordJudgeRun(
      {
        taskId: 't-4',
        modelTier: 'mid',
        model: 'deepseek-reasoner',
        kind: 'verify',
        run: failedRun('deepseek'),
        native,
      },
      ctx(),
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    const stats = providerAgreement(db);

    // deepseek answered once and that answer agreed, so its agreement rate is
    // 1 over 1 -- not 0.5 over 2. The schema failure produced no verdict to
    // agree or disagree with, and it is already counted where it belongs, in
    // schemaFailureRate. Charging it to the agreement rate too would report
    // the same failure twice, once as a broken transport and once as bad
    // judgement.
    expect(stats).toEqual([
      {
        provider: 'codex',
        runs: 2,
        verdicts: 2,
        agreementRate: 0.5,
        latencySamples: 2,
        meanLatencyMs: 100,
        schemaFailureRate: 0,
        transportFailureRate: 0,
        failuresByCode: {},
      },
      {
        provider: 'deepseek',
        runs: 2,
        verdicts: 1,
        agreementRate: 1,
        latencySamples: 1,
        meanLatencyMs: 100,
        schemaFailureRate: 0.5,
        transportFailureRate: 0,
        failuresByCode: { 'provider.invalid-output': 1 },
      },
    ]);
  });

  // The shape the factory's own log is in: five deepseek judge runs, every one
  // of them a schema failure, so nothing is known about how deepseek judges or
  // how fast it answers. Reporting either as 0 makes a provider that never
  // answered look like the fastest one on the board and like a consistent
  // dissenter -- two measurements off zero observations. D-31 settled this for
  // analytics()'s same-mistake rate ("silence is not assent"); the same rule
  // holds here.
  it('reports no rate for a provider that never produced a verdict (D-168)', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };
    for (const taskId of ['t-1', 't-2']) {
      await recordJudgeRun(
        {
          taskId,
          modelTier: 'mid',
          model: 'deepseek-reasoner',
          kind: 'verify',
          run: failedRun('deepseek'),
          native,
        },
        ctx(),
        { stateDir },
      );
    }

    const db = (await rebuildAndOpen()).db;
    expect(providerAgreement(db)).toEqual([
      {
        provider: 'deepseek',
        runs: 2,
        verdicts: 0,
        agreementRate: null,
        latencySamples: 0,
        meanLatencyMs: null,
        schemaFailureRate: 1,
        transportFailureRate: 0,
        failuresByCode: { 'provider.invalid-output': 2 },
      },
    ]);
  });

  // D-253, and the exact shape the factory's own log was in: every deepseek
  // run failed on `provider.missing-api-key`, which means no request was ever
  // sent -- there is no answer to call schema-invalid. Reporting these as
  // schema failures reads as "this provider's answers do not parse" and sends
  // the operator to the prompt and the schema, when the whole repair is one
  // environment variable. The two rates are separate because they name
  // different repairs, and `failuresByCode` names the one to make.
  it('separates a transport failure from a schema failure (D-253)', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };
    for (const taskId of ['t-1', 't-2', 't-3']) {
      await recordJudgeRun(
        {
          taskId,
          modelTier: 'mid',
          model: 'deepseek-reasoner',
          kind: 'verify',
          run: failedRun('deepseek', 'shadow', 'provider.missing-api-key'),
          native,
        },
        ctx(),
        { stateDir },
      );
    }
    await recordJudgeRun(
      {
        taskId: 't-4',
        modelTier: 'mid',
        model: 'deepseek-reasoner',
        kind: 'verify',
        run: failedRun('deepseek', 'shadow', 'provider.invalid-output'),
        native,
      },
      ctx(),
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    expect(providerAgreement(db)).toEqual([
      {
        provider: 'deepseek',
        runs: 4,
        verdicts: 0,
        agreementRate: null,
        latencySamples: 0,
        meanLatencyMs: null,
        schemaFailureRate: 0.25,
        transportFailureRate: 0.75,
        failuresByCode: {
          'provider.missing-api-key': 3,
          'provider.invalid-output': 1,
        },
      },
    ]);
  });

  // Every judge-verdict written before D-253 carries `schema_failure: true`
  // and no code at all. The log does not say why those runs failed, so the
  // fix does not get to guess: they are counted as failures, they are named
  // `unclassified`, and they are charged to neither rate. Reading the cause
  // back out of the rationale prose would be a parser over a message string
  // that no contract pins down.
  it('counts a pre-D-253 failure as unclassified rather than guessing', async () => {
    await appendEvent(
      {
        session_id: SESSION_ID,
        actor: 'system',
        event_type: 'judge-verdict',
        plan_version: 1,
        causal_parent: `${SESSION_ID}#0`,
        payload: {
          provider: 'deepseek',
          agent: 'verifier',
          model_tier: 'mid',
          model: 'deepseek-reasoner',
          ok: false,
          verdict: null,
          agreement_with_native: false,
          schema_failure: true,
          latency_ms: null,
        },
      },
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    expect(providerAgreement(db)).toEqual([
      {
        provider: 'deepseek',
        runs: 1,
        verdicts: 0,
        agreementRate: null,
        latencySamples: 0,
        meanLatencyMs: null,
        schemaFailureRate: 0,
        transportFailureRate: 0,
        failuresByCode: { unclassified: 1 },
      },
    ]);
  });

  it('scopes to one session', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };
    await recordJudgeRun(
      {
        taskId: 't-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: okRun('codex', 'confirm'),
        native,
      },
      ctx(),
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    expect(providerAgreement(db, { sessionId: SESSION_ID })).toHaveLength(1);
    expect(providerAgreement(db, { sessionId: 'no-such-session' })).toEqual([]);
  });

  it('filters by since (ISO date)', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };
    await recordJudgeRun(
      {
        taskId: 't-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: okRun('codex', 'confirm'),
        native,
      },
      ctx(),
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    expect(providerAgreement(db, {}, { since: farFuture })).toEqual([]);
    expect(providerAgreement(db, {}, { since: '2000-01-01' })).toHaveLength(1);
  });

  it('returns an empty array when no judge-verdict events exist', async () => {
    const db = (await rebuildAndOpen()).db;
    expect(providerAgreement(db)).toEqual([]);
  });

  // D-255. Every external provider in this factory participates as a judge and
  // never as a builder, so the only per-provider series analytics() carried --
  // cost, read off `task-result-recorded` -- named claude and nothing else, in
  // every session ever logged. The Analytics page's "Cross-check quorum" card
  // (design-spec.md 5.8, fed by "crosscheck.yml quorum results") had no data
  // to render because the API never sent any, and said so: "No quorum data
  // wired yet." The stats existed the whole time, behind `smith stats
  // providers`, which is a terminal an operator reading a dashboard is not in.
  it('carries the per-provider judge stats the page needs (D-255)', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };
    await recordJudgeRun(
      {
        taskId: 't-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: okRun('codex', 'confirm'),
        native,
      },
      ctx(),
      { stateDir },
    );
    await recordJudgeRun(
      {
        taskId: 't-2',
        modelTier: 'mid',
        model: 'deepseek-reasoner',
        kind: 'verify',
        run: failedRun('deepseek', 'shadow', 'provider.missing-api-key'),
        native,
      },
      ctx(),
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    // Same rows, same scope rules -- one computation, so the dashboard and the
    // CLI cannot disagree about how a provider is judging.
    expect(analytics(db).providerAgreement).toEqual(providerAgreement(db));
    expect(analytics(db).providerAgreement.map((s) => s.provider)).toEqual(['codex', 'deepseek']);
  });

  it('scopes the page judge stats the same way the CLI scopes them (D-255)', async () => {
    const native = { provider: 'claude', verdict: 'confirm' as const, rationale: 'native' };
    await recordJudgeRun(
      {
        taskId: 't-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: okRun('codex', 'confirm'),
        native,
      },
      ctx(),
      { stateDir },
    );

    const db = (await rebuildAndOpen()).db;
    expect(analytics(db, { sessionId: SESSION_ID }).providerAgreement).toHaveLength(1);
    expect(analytics(db, { sessionId: 'no-such-session' }).providerAgreement).toEqual([]);
  });
});
