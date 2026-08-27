import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgePreflight } from '../src/judgePreflight.js';
import { CROSSCHECK_POLICY_PATH } from '../src/paths.js';

// A key name no runner sets, so "unmet" here means unmet and not "this box
// happens to be configured". Its value is never read for anything but
// emptiness -- the assertions below check the NAME is reported back, which is
// the whole contract: a preflight that printed a key would be a preflight that
// leaked one.
const ABSENT_KEY = 'SMITH_TEST_KEY_THAT_IS_NEVER_SET';
const PRESENT_KEY = 'SMITH_TEST_KEY_THAT_IS_SET';

describe('judgePreflight()', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'smith-preflight-'));
    process.env[PRESENT_KEY] = 'sk-not-a-real-key';
    delete process.env[ABSENT_KEY];
  });

  afterAll(async () => {
    delete process.env[PRESENT_KEY];
    await rm(scratch, { recursive: true, force: true });
  });

  /** Write one policy file and preflight it. */
  async function preflight(name: string, yamlText: string) {
    const file = path.join(scratch, `${name}.yml`);
    await writeFile(file, yamlText);
    return judgePreflight(file);
  }

  function apiProvider(name: string, mode: string, keyEnv: string, enabled = true): string {
    return `  ${name}:
    kind: api
    transport: api
    enabled: ${enabled}
    mode: ${mode}
    model_tier: mid
    base_url: https://example.invalid
    model: test-model
    api_key_env: ${keyEnv}
`;
  }

  function cliProvider(name: string, mode: string, command: string, enabled = true): string {
    return `  ${name}:
    kind: api
    transport: cli
    enabled: ${enabled}
    mode: ${mode}
    model_tier: mid
    command: ${command}
    args: ["exec"]
`;
  }

  const NATIVE = `providers:
  claude:
    kind: native
    enabled: true
`;

  it('fails an enabled API provider whose key env is unset', async () => {
    // The incident this command exists for: deepseek shipped `enabled: true`
    // on a box with no key, so every quorum trigger spent a call that never
    // reached the network. Nothing was unsafe -- it was pure latency and a log
    // that reads like an outage.
    const report = await preflight('missing-key', NATIVE + apiProvider('ds', 'shadow', ABSENT_KEY));
    const ds = report.providers.find((p) => p.provider === 'ds');
    expect(ds).toMatchObject({ status: 'unmet', precondition: ABSENT_KEY, transport: 'api' });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain(ABSENT_KEY);
  });

  it('passes an enabled API provider whose key env is set', async () => {
    const report = await preflight('has-key', NATIVE + apiProvider('ds', 'shadow', PRESENT_KEY));
    expect(report.providers.find((p) => p.provider === 'ds')?.status).toBe('ok');
    expect(report.problems).toEqual([]);
  });

  it('never prints the key it read, only the name it read it from', async () => {
    // The one thing a config checker must not do is help an operator paste a
    // secret into a bug report.
    const report = await preflight('no-leak', NATIVE + apiProvider('ds', 'active', PRESENT_KEY));
    expect(JSON.stringify(report)).not.toContain('sk-not-a-real-key');
    expect(JSON.stringify(report)).toContain(PRESENT_KEY);
  });

  it('says nothing about the key of a provider that is disabled', async () => {
    // An operator who turned deepseek off should not be told to go set
    // DEEPSEEK_API_KEY: `enabled: false` is the supported answer to a keyless
    // runner, not a state to be nagged out of.
    const report = await preflight(
      'disabled',
      NATIVE + apiProvider('ds', 'shadow', ABSENT_KEY, false),
    );
    expect(report.providers.find((p) => p.provider === 'ds')?.status).toBe('not-applicable');
    expect(report.problems).toEqual([]);
  });

  it('fails an enabled CLI provider whose command is not on PATH', async () => {
    const report = await preflight(
      'missing-cli',
      NATIVE + cliProvider('nope', 'shadow', 'smith-no-such-binary'),
    );
    const cli = report.providers.find((p) => p.provider === 'nope');
    expect(cli).toMatchObject({ status: 'unmet', precondition: 'smith-no-such-binary' });
    expect(report.problems[0]).toContain('smith-no-such-binary');
  });

  it('passes an enabled CLI provider whose command resolves', async () => {
    // `sh` is on PATH on every platform this factory claims to run on, and
    // resolving it exercises the PATH walk rather than the absolute-path
    // branch.
    const report = await preflight('has-cli', NATIVE + cliProvider('shell', 'shadow', 'sh'));
    expect(report.providers.find((p) => p.provider === 'shell')?.status).toBe('ok');
    expect(report.problems).toEqual([]);
  });

  it('does not claim a resolvable CLI binary is authenticated', async () => {
    // PATH says the binary exists. Nothing local says `codex login` was ever
    // run, and pretending otherwise would be the same false green this command
    // was written to remove.
    const report = await preflight('cli-auth', NATIVE + cliProvider('shell', 'shadow', 'sh'));
    expect(report.providers.find((p) => p.provider === 'shell')?.detail).toContain(
      'not knowable without spending a call',
    );
  });

  describe('the promotion arithmetic', () => {
    it('calls shadow-only a working configuration, not a problem', async () => {
      // The shipped default. Every cross-check is recorded and none can change
      // an outcome, which is the point of shadow mode -- flagging it would
      // make the honest default look broken.
      const report = await preflight(
        'shadow-only',
        NATIVE + apiProvider('a', 'shadow', PRESENT_KEY) + apiProvider('b', 'shadow', PRESENT_KEY),
      );
      expect(report.gating).toMatchObject({
        activeExternal: [],
        shadowExternal: ['a', 'b'],
        canDecide: false,
      });
      expect(report.problems).toEqual([]);
    });

    it('fails a single promotion, which can never decide anything', async () => {
      // min_providers is 2 and the native provider is excluded as the finder
      // on its own findings, so the gating pool is the actives alone: one
      // active provider returns insufficient-providers on every case, at the
      // full price of a gating call. The runbook has always said so in prose;
      // this is the first thing that checks it.
      const report = await preflight(
        'half-promoted',
        NATIVE + apiProvider('a', 'active', PRESENT_KEY) + apiProvider('b', 'shadow', PRESENT_KEY),
      );
      expect(report.gating).toMatchObject({ activeExternal: ['a'], canDecide: false });
      expect(report.problems).toHaveLength(1);
      expect(report.problems[0]).toContain('insufficient-providers');
    });

    it('passes two promotions, which can', async () => {
      const report = await preflight(
        'promoted',
        NATIVE + apiProvider('a', 'active', PRESENT_KEY) + apiProvider('b', 'active', PRESENT_KEY),
      );
      expect(report.gating).toMatchObject({
        activeExternal: ['a', 'b'],
        minProviders: 2,
        canDecide: true,
      });
      expect(report.problems).toEqual([]);
    });

    it('does not count an active provider it could not call', async () => {
      // The two failures compose: a promoted provider with no key is not a
      // gating provider, and reporting it as one would say the quorum can
      // decide when every call it makes dies before it is sent.
      const report = await preflight(
        'active-but-broken',
        NATIVE + apiProvider('a', 'active', PRESENT_KEY) + apiProvider('b', 'active', ABSENT_KEY),
      );
      expect(report.gating.activeExternal).toEqual(['a']);
      expect(report.gating.canDecide).toBe(false);
      expect(report.problems).toHaveLength(2);
    });
  });

  it('reads the file as written, ignoring SMITH_CROSSCHECK_OFFLINE', async () => {
    // test/setup.ts sets the switch for the whole suite, so this case is the
    // shipped condition rather than a contrived one. Applying the switch here
    // would report every external as disabled and hide exactly the
    // misconfiguration the command exists to find.
    expect(process.env.SMITH_CROSSCHECK_OFFLINE).toBeTruthy();
    const report = await preflight('offline', NATIVE + apiProvider('ds', 'shadow', ABSENT_KEY));
    expect(report.offlineSwitch).toBe(true);
    expect(report.providers.find((p) => p.provider === 'ds')?.enabled).toBe(true);
    expect(report.problems).toHaveLength(1);
  });

  it('reports the native provider as configuration-free', async () => {
    const report = await preflight('native', NATIVE);
    expect(report.providers).toEqual([
      {
        provider: 'claude',
        kind: 'native',
        transport: 'native',
        enabled: true,
        mode: 'native',
        precondition: null,
        status: 'ok',
        detail: expect.any(String),
      },
    ]);
    expect(report.problems).toEqual([]);
  });

  it('answers for the repo policy without calling a provider', async () => {
    // Runs against the real factory/policies/crosscheck.yml. It asserts shape,
    // not verdict: `enabled` tracks the machine, so pinning the outcome would
    // fail on whichever box has the keys.
    const report = judgePreflight();
    expect(report.policyPath).toBe(CROSSCHECK_POLICY_PATH);
    expect(report.providers.map((p) => p.provider)).toEqual(['claude', 'codex', 'deepseek']);
    expect(report.gating.minProviders).toBe(2);
    for (const problem of report.problems) expect(typeof problem).toBe('string');
  });
});
