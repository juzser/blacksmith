import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type JudgePreflight, judgePreflight } from '../src/judgePreflight.js';
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

  it('leaves the repo policy sound on a box that has nothing', () => {
    // The one verdict about the real file that reads the same on every box,
    // and the reason it is safe to assert where pinning `enabled` was not: it
    // says the policy is SOUND for whoever runs it, never that it switches
    // anything on. An operator who enabled a provider they have passes; a
    // clone that enabled none passes; the only configuration refused is one
    // enabled where it cannot be called -- which is what `problems` is for and
    // what `smith judge preflight` already exits 1 on.
    //
    // It failed the day it was written. The shipped file carried both
    // externals `enabled: true`, so a clone with no DeepSeek key and no
    // `codex` on PATH -- every fresh clone of a public repo -- spent two
    // doomed calls on every quorum trigger and logged two failures for them.
    expect(judgePreflight().problems).toEqual([]);
  });

  describe('a single promoted provider', () => {
    // The configuration this repo's own operator chose: one external judge
    // enabled and promoted, with min_providers still 2. It is a real trap —
    // on a finding the native judge raised, the finder is excluded, the
    // gating pool is the actives alone, and one active cannot meet two, so
    // the case escalates exactly as it did before the promotion while now
    // paying for the call. Worth failing on when nobody chose it.
    //
    // But the problem text itself ends "or accept that these calls are shadow
    // runs that cost like gating ones", and until now there was no way to say
    // "accepted" — so preflight exited 1 forever on a configuration its own
    // message called acceptable, which no scheduled health check can live
    // with. `accept_non_gating_actives` is that acceptance, declared in the
    // file where every other judging decision is declared.
    /**
     * Rewrites `enabled`/`mode` inside one provider block and leaves every
     * other block alone — the two lines are spelled identically under codex
     * and deepseek, and promoting both would change the arithmetic under test.
     */
    const promote = (text: string, provider: string): string => {
      const lines = text.split('\n');
      const start = lines.indexOf(`  ${provider}:`);
      const after = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
      const end = after === -1 ? lines.length : after;
      return lines
        .map((line, i) =>
          i > start && i < end
            ? line
                .replace(/^ {4}enabled:.*$/, '    enabled: true')
                .replace(/^ {4}mode:.*$/, '    mode: active')
            : line,
        )
        .join('\n');
    };

    /**
     * The fixture states its own preconditions rather than inheriting this
     * box's. `enabled` is the one field in crosscheck.yml that describes a
     * machine, so a clone without the codex binary flips it back — and these
     * tests are about the arithmetic of one active judge against
     * `min_providers: 2`, which is true wherever the file is read.
     */
    const policyWith = (accept: boolean): string =>
      promote(
        readFileSync(CROSSCHECK_POLICY_PATH, 'utf8').replace(
          /^ {2}accept_non_gating_actives: .*$/m,
          `  accept_non_gating_actives: ${accept}`,
        ),
        'codex',
      );

    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'smith-preflight-accept-'));
    });
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    const preflightOn = async (yamlText: string): Promise<JudgePreflight> => {
      const file = path.join(dir, 'crosscheck.yml');
      await writeFile(file, yamlText, 'utf8');
      return judgePreflight(file);
    };

    it('undeclared, the underpowered pool is a problem and never a note', async () => {
      const report = await preflightOn(policyWith(false));
      if (report.gating.activeExternal.length === 0 || report.gating.canDecide) return; // not this box
      expect(report.problems.some((p) => p.includes('min_providers'))).toBe(true);
      expect(report.notes).toEqual([]);
    });

    it('declared, it moves to notes and stops failing the command', async () => {
      const report = await preflightOn(policyWith(true));
      if (report.gating.activeExternal.length === 0 || report.gating.canDecide) return; // not this box
      expect(report.problems).toEqual([]);
      expect(report.notes.some((n) => n.includes('min_providers'))).toBe(true);
      // The acceptance buys silence about the arithmetic, never a claim that
      // the arithmetic changed: `canDecide` still reports what can gate.
      expect(report.gating.canDecide).toBe(false);
    });

    it('never launders an unmet precondition into a note', async () => {
      // Acceptance covers one sentence: "one active cannot meet two". A
      // provider enabled where it cannot be called is a different failure and
      // stays a problem no declaration can silence.
      const broken = policyWith(true).replace(
        /^ {4}command: codex$/m,
        '    command: no-such-judge-binary',
      );
      const report = await preflightOn(broken);
      expect(report.problems.some((p) => p.includes('no-such-judge-binary'))).toBe(true);
    });
  });
});
