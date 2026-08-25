import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransportConfig } from '../../src/providers/api-transport.js';
import { runApiJudge } from '../../src/providers/api-transport.js';
import type { JudgeRequest } from '../../src/providers/types.js';
import { ProviderError } from '../../src/providers/types.js';

const ENV_VAR = 'TEST_DEEPSEEK_API_KEY';

function baseConfig(overrides: Partial<ApiTransportConfig> = {}): ApiTransportConfig {
  return {
    baseUrl: 'https://api.example.test',
    model: 'test-model',
    apiKeyEnv: ENV_VAR,
    responseFormatJsonObject: true,
    ...overrides,
  };
}

function baseRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    kind: 'verify',
    taskId: 'epic-1/task-1',
    inputRefs: {},
    prompt: 'judge this finding',
    schemaName: 'judge-verdict',
    budget: { timeout_ms: 5000, max_output_bytes: 100_000 },
    ...overrides,
  };
}

function chatCompletion(
  content: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
    { status: 200 },
  );
}

describe('providers/api-transport.ts', () => {
  const originalKey = process.env[ENV_VAR];

  beforeEach(() => {
    process.env[ENV_VAR] = 'sk-super-secret-value-do-not-leak';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalKey;
  });

  it('returns a schema-valid result on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatCompletion(JSON.stringify({ verdict: 'confirm', rationale: 'real' })));

    const result = await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);

    expect(result.output).toEqual({ verdict: 'confirm', rationale: 'real' });
    expect(result.provider).toBe('fake');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-super-secret-value-do-not-leak',
    );
  });

  it('throws a typed error on missing API key, naming the env var but never a value', async () => {
    delete process.env[ENV_VAR];
    const fetchMock = vi.fn();

    await expect(runApiJudge('fake', baseConfig(), baseRequest(), fetchMock)).rejects.toMatchObject(
      {
        code: 'provider.missing-api-key',
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    try {
      await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);
      throw new Error('expected runApiJudge to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const message = err instanceof Error ? err.message : '';
      expect(message).toContain(ENV_VAR);
    }
  });

  it('throws provider.auth-failed on 401, never echoing the key value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));

    let caught: unknown;
    try {
      await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.code).toBe('provider.auth-failed');
    const serialized = JSON.stringify({ message: err.message, details: err.details });
    expect(serialized).not.toContain('sk-super-secret-value-do-not-leak');
  });

  it('scrubs the key from a non-401 HTTP error body if it happened to be echoed back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('server saw key sk-super-secret-value-do-not-leak in request', {
        status: 500,
      }),
    );

    let caught: unknown;
    try {
      await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.code).toBe('provider.http-error');
    expect(JSON.stringify(err.details)).not.toContain('sk-super-secret-value-do-not-leak');
    expect(JSON.stringify(err.details)).toContain('[REDACTED]');
  });

  it('retries once with a nudge on schema-garbage output, and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletion('not json at all'))
      .mockResolvedValueOnce(
        chatCompletion(JSON.stringify({ verdict: 'refute', rationale: 'clean' })),
      );

    const result = await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);

    expect(result.output).toEqual({ verdict: 'refute', rationale: 'clean' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(secondInit.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[0]?.content).toContain('Return only valid JSON per schema.');
  });

  // The provider bills both calls. `smith judge run` prints raw_usage straight
  // to the operator, so reporting only the second one prices a calibration run
  // at less than it cost -- the same undercount D-207 fixed for per-epic spend.
  it('reports what both attempts cost when the retry is the one that succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        chatCompletion('not json at all', { prompt_tokens: 900, completion_tokens: 40 }),
      )
      .mockResolvedValueOnce(
        chatCompletion(JSON.stringify({ verdict: 'refute', rationale: 'clean' }), {
          prompt_tokens: 950,
          completion_tokens: 60,
        }),
      );

    const result = await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);

    expect(result.raw_usage).toEqual({ input_tokens: 1850, output_tokens: 100 });
  });

  // A provider that reports usage on one call and not the other still spent
  // the tokens it did report; dropping them because the other half is missing
  // would undercount for a second reason.
  it('keeps the attempt that reported usage when the other reports none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        chatCompletion('not json at all', { prompt_tokens: 900, completion_tokens: 40 }),
      )
      .mockResolvedValueOnce(
        chatCompletion(JSON.stringify({ verdict: 'refute', rationale: 'clean' })),
      );

    const result = await runApiJudge('fake', baseConfig(), baseRequest(), fetchMock);

    expect(result.raw_usage).toEqual({ input_tokens: 900, output_tokens: 40 });
  });

  it('throws provider.invalid-output when still invalid after the retry', async () => {
    // A fresh Response per call — mockResolvedValue would reuse one Response
    // instance across both calls, and a body stream can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () => chatCompletion('still not json'));

    await expect(runApiJudge('fake', baseConfig(), baseRequest(), fetchMock)).rejects.toMatchObject(
      {
        code: 'provider.invalid-output',
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws provider.network-error when fetch itself rejects (not an abort)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('DNS lookup failed'));

    await expect(runApiJudge('fake', baseConfig(), baseRequest(), fetchMock)).rejects.toMatchObject(
      {
        code: 'provider.network-error',
      },
    );
  });

  it('throws provider.timeout when the request is aborted', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    await expect(
      runApiJudge(
        'fake',
        baseConfig(),
        baseRequest({ budget: { timeout_ms: 20, max_output_bytes: 100_000 } }),
        fetchMock,
      ),
    ).rejects.toMatchObject({ code: 'provider.timeout' });
  });

  it('throws provider.malformed-response when the HTTP body itself is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not even json', { status: 200 }));

    await expect(runApiJudge('fake', baseConfig(), baseRequest(), fetchMock)).rejects.toMatchObject(
      {
        code: 'provider.malformed-response',
      },
    );
  });

  it('enforces the output size cap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion('x'.repeat(10)));

    await expect(
      runApiJudge(
        'fake',
        baseConfig(),
        baseRequest({ budget: { timeout_ms: 5000, max_output_bytes: 5 } }),
        fetchMock,
      ),
    ).rejects.toMatchObject({ code: 'provider.output-too-large' });
  });
});
