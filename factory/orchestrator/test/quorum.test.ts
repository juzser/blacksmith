import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldAgents, liveAgents } from '../src/agents-registry.js';
import type { CrosscheckPolicy } from '../src/crosscheck.js';
import { appendEvent, readEvents } from '../src/events.js';
import type { JudgeResult } from '../src/providers/types.js';
import {
  computeQuorum,
  deriveVerdict,
  type ExternalJudgeRun,
  type ProviderVerdict,
  type QuorumCase,
  recordJudgeRun,
  runQuorumCase,
} from '../src/quorum.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-judge-cli.mjs');

function native(overrides: Partial<ProviderVerdict> = {}): ProviderVerdict {
  return { provider: 'claude', verdict: 'confirm', rationale: 'native says so', ...overrides };
}

function externalOk(
  provider: string,
  mode: 'shadow' | 'active',
  verdict: 'confirm' | 'refute',
): ExternalJudgeRun {
  const result: JudgeResult = {
    provider,
    kind: 'verify',
    output: { verdict, rationale: `${provider} says ${verdict}` },
    latency_ms: 10,
  };
  return { provider, mode, outcome: { ok: true, result } };
}

function externalFailed(provider: string, mode: 'shadow' | 'active'): ExternalJudgeRun {
  return {
    provider,
    mode,
    outcome: { ok: false, error: { code: 'provider.timeout', message: 'boom' } },
  };
}

function baseCase(overrides: Partial<QuorumCase> = {}): QuorumCase {
  return {
    taskId: 'epic-1/task-1',
    triggerReason: 'blocking-finding',
    finderProvider: 'coder-session', // never equal to any judge provider by default
    native: native(),
    external: [],
    ...overrides,
  };
}

describe('quorum.ts deriveVerdict', () => {
  it('review kind: non-empty findings -> confirm', () => {
    const result: JudgeResult = { provider: 'codex', kind: 'review', output: [{}], latency_ms: 1 };
    expect(deriveVerdict(result).verdict).toBe('confirm');
  });

  it('review kind: empty findings -> refute', () => {
    const result: JudgeResult = { provider: 'codex', kind: 'review', output: [], latency_ms: 1 };
    expect(deriveVerdict(result).verdict).toBe('refute');
  });

  it('verify kind: reads the verdict field directly', () => {
    const result: JudgeResult = {
      provider: 'deepseek',
      kind: 'verify',
      output: { verdict: 'refute', rationale: 'no real issue' },
      latency_ms: 1,
    };
    expect(deriveVerdict(result)).toEqual({
      provider: 'deepseek',
      verdict: 'refute',
      rationale: 'no real issue',
    });
  });
});

describe('quorum.ts computeQuorum (table-driven)', () => {
  it('2-of-3 agreement: native + two active externals all confirm -> decided confirm', () => {
    const result = computeQuorum(
      baseCase({
        external: [
          externalOk('codex', 'active', 'confirm'),
          externalOk('deepseek', 'active', 'confirm'),
        ],
      }),
    );
    expect(result.gating).toEqual({
      outcome: 'decided',
      decision: 'confirm',
      agreement: '3-of-3',
      participants: ['claude', 'codex', 'deepseek'],
    });
  });

  it('exact 2-of-3 split still decides by majority', () => {
    const result = computeQuorum(
      baseCase({
        native: native({ verdict: 'confirm' }),
        external: [
          externalOk('codex', 'active', 'confirm'),
          externalOk('deepseek', 'active', 'refute'),
        ],
      }),
    );
    expect(result.gating).toMatchObject({
      outcome: 'decided',
      decision: 'confirm',
      agreement: '2-of-3',
    });
  });

  it('split with no majority (2 active gating participants, one each way) escalates as disagreement', () => {
    const result = computeQuorum(
      baseCase({
        finderProvider: 'claude', // exclude native — leaves exactly codex vs deepseek, a true tie
        external: [
          externalOk('codex', 'active', 'confirm'),
          externalOk('deepseek', 'active', 'refute'),
        ],
      }),
    );
    expect(result.gating.outcome).toBe('escalate');
    if (result.gating.outcome === 'escalate') {
      expect(result.gating.reason).toBe('disagreement');
      expect(result.gating.rationales.map((r) => r.provider).sort()).toEqual(['codex', 'deepseek']);
    }
  });

  it('shadow mode: external verdicts are recorded but have zero gating power', () => {
    const result = computeQuorum(
      baseCase({
        native: native({ verdict: 'confirm' }),
        external: [
          externalOk('codex', 'shadow', 'refute'),
          externalOk('deepseek', 'shadow', 'refute'),
        ],
      }),
    );
    // Gating uses native alone, regardless of what the (disagreeing) shadow judges said.
    expect(result.gating).toEqual({
      outcome: 'decided',
      decision: 'confirm',
      agreement: 'native-only',
      participants: ['claude'],
    });
    // But every shadow participant IS recorded for calibration analytics.
    expect(result.participants).toEqual([
      {
        provider: 'claude',
        mode: 'native',
        ok: true,
        verdict: 'confirm',
        rationale: 'native says so',
        excludedAsFinder: false,
      },
      {
        provider: 'codex',
        mode: 'shadow',
        ok: true,
        verdict: 'refute',
        rationale: 'codex says refute',
        excludedAsFinder: false,
      },
      {
        provider: 'deepseek',
        mode: 'shadow',
        ok: true,
        verdict: 'refute',
        rationale: 'deepseek says refute',
        excludedAsFinder: false,
      },
    ]);
  });

  it('a mix of shadow and active: only the active judge (plus native) gates', () => {
    const result = computeQuorum(
      baseCase({
        native: native({ verdict: 'confirm' }),
        external: [
          externalOk('codex', 'shadow', 'refute'),
          externalOk('deepseek', 'active', 'confirm'),
        ],
      }),
    );
    expect(result.gating).toMatchObject({
      outcome: 'decided',
      decision: 'confirm',
      agreement: '2-of-2',
    });
  });

  it('finder == critic: native excluded from gating when claude is the finder', () => {
    const result = computeQuorum(
      baseCase({
        finderProvider: 'claude',
        external: [
          externalOk('codex', 'active', 'confirm'),
          externalOk('deepseek', 'active', 'confirm'),
        ],
      }),
    );
    expect(result.gating).toMatchObject({
      outcome: 'decided',
      decision: 'confirm',
      agreement: '2-of-2',
    });
    const nativeParticipant = result.participants.find((p) => p.mode === 'native');
    expect(nativeParticipant?.excludedAsFinder).toBe(true);
  });

  it('finder == critic: an external critic sharing the finder provider is excluded even if active', () => {
    const result = computeQuorum(
      baseCase({
        finderProvider: 'codex',
        native: native({ verdict: 'confirm' }),
        external: [
          externalOk('codex', 'active', 'refute'),
          externalOk('deepseek', 'active', 'confirm'),
        ],
      }),
    );
    // Only native + deepseek gate; codex's verdict never counts despite being active.
    expect(result.gating).toMatchObject({ outcome: 'decided', agreement: '2-of-2' });
    const codexParticipant = result.participants.find((p) => p.provider === 'codex');
    expect(codexParticipant?.excludedAsFinder).toBe(true);
  });

  it('insufficient providers: one active participant alone cannot form a quorum', () => {
    const result = computeQuorum(
      baseCase({
        finderProvider: 'claude', // exclude native, leaving only one active external
        external: [externalOk('codex', 'active', 'confirm')],
      }),
    );
    expect(result.gating).toMatchObject({ outcome: 'escalate', reason: 'insufficient-providers' });
  });

  it('insufficient providers: native excluded as finder and zero active externals escalates (not native-only)', () => {
    const result = computeQuorum(baseCase({ finderProvider: 'claude', external: [] }));
    expect(result.gating).toEqual({
      outcome: 'escalate',
      reason: 'insufficient-providers',
      rationales: [],
    });
  });

  it('a failed external run (schema failure) never joins the gating pool, even in active mode', () => {
    const result = computeQuorum(
      baseCase({
        native: native({ verdict: 'confirm' }),
        external: [externalFailed('codex', 'active'), externalOk('deepseek', 'active', 'confirm')],
      }),
    );
    expect(result.gating).toMatchObject({ outcome: 'decided', agreement: '2-of-2' });
    const codexParticipant = result.participants.find((p) => p.provider === 'codex');
    expect(codexParticipant).toMatchObject({ ok: false, verdict: null });
  });
});

describe('quorum.ts recordJudgeRun / runQuorumCase (integration)', () => {
  let stateDir: string;
  const sessionId = 'sess-quorum';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-quorum-'));
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

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  it('records a dispatch_decision + judge-verdict event pair for a successful run', async () => {
    const run = externalOk('codex', 'shadow', 'confirm');
    await recordJudgeRun(
      {
        taskId: 'epic-1/task-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run,
        native: native(),
      },
      ctx(),
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const dispatch = events.find((e) => e.record.event_type === 'dispatch_decision');
    const verdict = events.find((e) => e.record.event_type === 'judge-verdict');
    expect(dispatch?.record.payload).toMatchObject({
      agent_role: 'verifier',
      provider: 'codex',
      model_tier: 'mid',
      // P9-23: the concrete model, not just the tier — this is the field the
      // finder_ne_critic audit actually compares.
      model: 'codex:default',
    });
    expect(verdict?.record.causal_parent).toBe(dispatch?.event_id);
    expect(verdict?.record.payload).toMatchObject({
      provider: 'codex',
      agent: 'verifier',
      model_tier: 'mid',
      model: 'codex:default',
      mode: 'shadow',
      ok: true,
      verdict: 'confirm',
      native_verdict: 'confirm',
      agreement_with_native: true,
      schema_failure: false,
      // D-253: a run that answered carries no error code. `null`, not absent:
      // an absent field reads the same as an old event written before the
      // field existed, and providerAgreement() has to tell those apart.
      error_code: null,
    });
  });

  // Retitled under D-253. `externalFailed` raises `provider.timeout` -- a
  // transport failure, not a schema one -- and the old title called it a
  // schema failure because the payload had no other word for it.
  it('records a failed run with a null verdict and its provider error code', async () => {
    const run = externalFailed('codex', 'active');
    await recordJudgeRun(
      {
        taskId: 'epic-1/task-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run,
        native: native(),
      },
      ctx(),
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const verdict = events.find((e) => e.record.event_type === 'judge-verdict');
    expect(verdict?.record.payload).toMatchObject({
      ok: false,
      verdict: null,
      schema_failure: true,
      error_code: 'provider.timeout',
    });
  });

  // D-168. On a failed run there is no external verdict to compare, so
  // `agreement_with_native: false` is not an observation -- it is a placeholder
  // wearing an observation's clothes, and the next reader to group by it counts
  // a provider that never answered as one that dissented. `null` is how a
  // record says the question has no answer, the same choice the line below it
  // already makes for `latency_ms`.
  it('writes a null agreement, not false, when the run reached no verdict (D-168)', async () => {
    await recordJudgeRun(
      {
        taskId: 'epic-1/task-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: externalFailed('codex', 'active'),
        native: native(),
      },
      ctx(),
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const verdict = events.find((e) => e.record.event_type === 'judge-verdict');
    const payload = verdict?.record.payload as { agreement_with_native: unknown };
    expect(payload.agreement_with_native).toBeNull();
  });

  it('still writes a boolean agreement when the run did reach a verdict', async () => {
    await recordJudgeRun(
      {
        taskId: 'epic-1/task-1',
        modelTier: 'mid',
        model: 'codex:default',
        kind: 'verify',
        run: externalOk('codex', 'active', 'confirm'),
        native: native(),
      },
      ctx(),
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const verdict = events.find((e) => e.record.event_type === 'judge-verdict');
    const payload = verdict?.record.payload as { agreement_with_native: unknown };
    expect(payload.agreement_with_native).toBe(true);
  });

  // D-253. runQuorumCase()'s catch already computes a code for every failure
  // -- `provider.missing-api-key` reads nothing like `provider.invalid-output`
  // -- and recordJudgeRun() dropped it, leaving one boolean where fourteen
  // codes had been. Downstream that boolean is spelled "schema failure", so
  // the factory's deepseek judge, which never made a single HTTP request
  // because its key was never exported, was reported for eight days as a
  // provider whose answers do not parse. The operator was pointed at the
  // prompt; the fix was one environment variable.
  it('keeps a precondition failure distinguishable from a schema one (D-253)', async () => {
    await recordJudgeRun(
      {
        taskId: 'epic-1/task-1',
        modelTier: 'mid',
        model: 'deepseek-reasoner',
        kind: 'verify',
        run: {
          provider: 'deepseek',
          mode: 'shadow',
          outcome: {
            ok: false,
            error: {
              code: 'provider.missing-api-key',
              message:
                'Environment variable "DEEPSEEK_API_KEY" is not set (required for provider "deepseek").',
            },
          },
        },
        native: native(),
      },
      ctx(),
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const verdict = events.find((e) => e.record.event_type === 'judge-verdict');
    expect(verdict?.record.payload).toMatchObject({
      ok: false,
      verdict: null,
      error_code: 'provider.missing-api-key',
    });
  });

  // D-160. The dispatch_decision above is written precisely so a judge run
  // lands in the live-agent registry (architecture §7), which means the
  // registry has to be able to close it again. Nothing else ever will: an
  // external judge writes no Result and closes no judge turn. Asserted
  // through the real emitter because the closing key is the payload field
  // name — `agent`, not `agent_role` — and a unit test with a hand-built
  // event would keep passing if this emitter ever renamed it.
  it('leaves no judge live in the agent registry (D-160)', async () => {
    for (const provider of ['deepseek', 'codex']) {
      await recordJudgeRun(
        {
          taskId: 'epic-1/task-1',
          modelTier: 'mid',
          model: `${provider}:default`,
          kind: 'verify',
          run: externalOk(provider, 'active', 'confirm'),
          native: native(),
        },
        ctx(),
        { stateDir },
      );
    }

    const agents = foldAgents(await readEvents(sessionId, { stateDir }));
    expect(agents.map((a) => ({ provider: a.provider, status: a.status }))).toEqual([
      { provider: 'deepseek', status: 'done' },
      { provider: 'codex', status: 'done' },
    ]);
    expect(liveAgents(agents)).toHaveLength(0);
    // Both providers share the verifier role (KIND_TO_AGENT keys on kind), so
    // the second dispatch would have superseded the first had its verdict not
    // already closed it — a judge that answered, filed as abandoned.
    expect(agents.every((a) => a.terminalType === 'result')).toBe(true);
  });

  it('runQuorumCase invokes each provider, records events, and decides', async () => {
    const policy: CrosscheckPolicy = {
      ...crosscheckDefaults(),
      providers: {
        claude: { name: 'claude', kind: 'native', enabled: true },
        codex: {
          name: 'codex',
          kind: 'api',
          transport: 'cli',
          enabled: true,
          mode: 'active',
          modelTier: 'mid',
          command: 'node',
          args: [FIXTURE, 'success'],
        },
      },
      quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
    };

    const result = await runQuorumCase(
      {
        taskId: 'epic-1/task-1',
        triggerReason: 'blocking-finding',
        finderProvider: 'coder-session',
        kind: 'verify',
        native: native({ verdict: 'confirm' }),
        providers: ['codex'],
        request: {
          kind: 'verify',
          taskId: 'epic-1/task-1',
          inputRefs: {},
          prompt: 'judge it',
          schemaName: 'judge-verdict',
          budget: { timeout_ms: 5000, max_output_bytes: 100_000 },
        },
        policy,
      },
      ctx(),
      { stateDir },
    );

    // Fixture 'success' always returns verdict: confirm — agrees with native.
    expect(result.gating).toMatchObject({ outcome: 'decided', decision: 'confirm' });

    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === 'judge-verdict')).toBe(true);
  });

  it('runQuorumCase skips disabled providers entirely (never invoked, never recorded)', async () => {
    const policy: CrosscheckPolicy = {
      ...crosscheckDefaults(),
      providers: {
        claude: { name: 'claude', kind: 'native', enabled: true },
        codex: {
          name: 'codex',
          kind: 'api',
          transport: 'cli',
          enabled: false,
          mode: 'shadow',
          modelTier: 'mid',
          command: 'node',
          args: [FIXTURE, 'success'],
        },
      },
      quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
    };

    const result = await runQuorumCase(
      {
        taskId: 'epic-1/task-1',
        triggerReason: 'blocking-finding',
        finderProvider: 'coder-session',
        kind: 'verify',
        native: native({ verdict: 'confirm' }),
        providers: ['codex'],
        request: {
          kind: 'verify',
          taskId: 'epic-1/task-1',
          inputRefs: {},
          prompt: 'judge it',
          schemaName: 'judge-verdict',
          budget: { timeout_ms: 5000, max_output_bytes: 100_000 },
        },
        policy,
      },
      ctx(),
      { stateDir },
    );

    expect(result.gating).toMatchObject({
      outcome: 'decided',
      decision: 'confirm',
      agreement: 'native-only',
    });
    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === 'judge-verdict')).toBe(false);
  });
});
