import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CrosscheckPolicy } from '../../src/crosscheck.js';
import { runJudge } from '../../src/providers/index.js';
import type { JudgeRequest } from '../../src/providers/types.js';
import { crosscheckDefaults } from '../helpers/crosscheckPolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'fake-judge-cli.mjs');

function baseRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    kind: 'verify',
    taskId: 'epic-1/task-1',
    inputRefs: {},
    prompt: 'judge this',
    schemaName: 'judge-verdict',
    budget: { timeout_ms: 5000, max_output_bytes: 100_000 },
    ...overrides,
  };
}

function policyWith(overrides: CrosscheckPolicy['providers']): CrosscheckPolicy {
  return {
    ...crosscheckDefaults(),
    providers: { claude: { name: 'claude', kind: 'native', enabled: true }, ...overrides },
    quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
  };
}

describe('providers/index.ts runJudge', () => {
  it('throws on an unknown provider name', async () => {
    await expect(runJudge('nope', baseRequest(), { policy: policyWith({}) })).rejects.toMatchObject(
      {
        code: 'provider.unknown',
      },
    );
  });

  it('throws when asked to run the native provider through the transport layer', async () => {
    await expect(
      runJudge('claude', baseRequest(), { policy: policyWith({}) }),
    ).rejects.toMatchObject({ code: 'provider.not-external' });
  });

  it('throws when the provider is disabled', async () => {
    const policy = policyWith({
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
    });
    await expect(runJudge('codex', baseRequest(), { policy })).rejects.toMatchObject({
      code: 'provider.disabled',
    });
  });

  it('routes "codex" through the CLI transport', async () => {
    const policy = policyWith({
      codex: {
        name: 'codex',
        kind: 'api',
        transport: 'cli',
        enabled: true,
        mode: 'shadow',
        modelTier: 'mid',
        command: 'node',
        args: [FIXTURE, 'success'],
      },
    });
    const result = await runJudge('codex', baseRequest(), { policy });
    expect(result).toMatchObject({ provider: 'codex', output: { verdict: 'confirm' } });
  });

  it('routes "deepseek" through the API transport', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"refute","rationale":"ok"}' } }],
        }),
        { status: 200 },
      ),
    );
    process.env.TEST_INDEX_DEEPSEEK_KEY = 'k';
    const policy = policyWith({
      deepseek: {
        name: 'deepseek',
        kind: 'api',
        transport: 'api',
        enabled: true,
        mode: 'shadow',
        modelTier: 'mid',
        baseUrl: 'https://example.test',
        model: 'x',
        apiKeyEnv: 'TEST_INDEX_DEEPSEEK_KEY',
        responseFormatJsonObject: true,
      },
    });
    const result = await runJudge('deepseek', baseRequest(), { policy, fetchImpl: fetchMock });
    expect(result.output).toEqual({ verdict: 'refute', rationale: 'ok' });
  });

  // The names in the shipped crosscheck.yml are examples, not reservations.
  // This registry used to hard-code `codex` -> cli and `deepseek` -> api and
  // refuse any other pairing, which made two ordinary strings mean something
  // to a public operator who had never heard of either vendor. Both of these
  // are real configurations someone will write: Codex is reachable over an
  // OpenAI-compatible endpoint, and a locally-run DeepSeek is a command.
  it('runs a provider named "codex" over the API transport when that is what it declares', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"confirm","rationale":"ok"}' } }],
        }),
        { status: 200 },
      ),
    );
    process.env.TEST_INDEX_CODEX_KEY = 'k';
    const policy = policyWith({
      codex: {
        name: 'codex',
        kind: 'api',
        transport: 'api',
        enabled: true,
        mode: 'shadow',
        modelTier: 'mid',
        baseUrl: 'https://example.test',
        model: 'x',
        apiKeyEnv: 'TEST_INDEX_CODEX_KEY',
        responseFormatJsonObject: true,
      },
    });
    const result = await runJudge('codex', baseRequest(), { policy, fetchImpl: fetchMock });
    expect(result.provider).toBe('codex');
    expect(result.output).toMatchObject({ verdict: 'confirm' });
  });

  it('runs a provider named "deepseek" over the CLI transport when that is what it declares', async () => {
    const policy = policyWith({
      deepseek: {
        name: 'deepseek',
        kind: 'api',
        transport: 'cli',
        enabled: true,
        mode: 'shadow',
        modelTier: 'mid',
        command: 'node',
        args: [FIXTURE, 'success'],
      },
    });
    const result = await runJudge('deepseek', baseRequest(), { policy });
    expect(result.provider).toBe('deepseek');
    expect(result.output).toMatchObject({ verdict: 'confirm' });
  });

  it('resolves a future, unnamed provider purely by its declared transport (generic api fallback)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"confirm","rationale":"ok"}' } }],
        }),
        { status: 200 },
      ),
    );
    process.env.TEST_INDEX_FUTURE_KEY = 'k';
    const policy = policyWith({
      'a-future-api-provider': {
        name: 'a-future-api-provider',
        kind: 'api',
        transport: 'api',
        enabled: true,
        mode: 'shadow',
        modelTier: 'mid',
        baseUrl: 'https://example.test',
        model: 'x',
        apiKeyEnv: 'TEST_INDEX_FUTURE_KEY',
        responseFormatJsonObject: true,
      },
    });
    const result = await runJudge('a-future-api-provider', baseRequest(), {
      policy,
      fetchImpl: fetchMock,
    });
    expect(result.provider).toBe('a-future-api-provider');
    expect(result.output).toMatchObject({ verdict: 'confirm' });
  });

  it('resolves a future, unnamed provider purely by its declared transport (generic fallback)', async () => {
    const policy = policyWith({
      'a-future-provider': {
        name: 'a-future-provider',
        kind: 'api',
        transport: 'cli',
        enabled: true,
        mode: 'shadow',
        modelTier: 'mid',
        command: 'node',
        args: [FIXTURE, 'success'],
      },
    });
    const result = await runJudge('a-future-provider', baseRequest(), { policy });
    expect(result.provider).toBe('a-future-provider');
    expect(result.output).toMatchObject({ verdict: 'confirm' });
  });
});
