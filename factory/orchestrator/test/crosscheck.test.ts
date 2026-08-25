import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CrosscheckError, loadCrosscheckPolicy, parseCrosscheckPolicy } from '../src/crosscheck.js';
import { CROSSCHECK_POLICY_PATH } from '../src/paths.js';

describe('crosscheck.ts', () => {
  it('parses the real repo crosscheck.yml', () => {
    // parse, not load: `enabled` is the one field that tracks a machine rather
    // than the repo — it declares which judge binaries this box actually has,
    // and flipping it is a supported operator action (runbook §2). Asserting
    // its value here made that action fail the suite. What is worth pinning is
    // the SHAPE the code depends on, which is the same on every box.
    const policy = parseCrosscheckPolicy(readFileSync(CROSSCHECK_POLICY_PATH, 'utf8'));
    expect(policy.providers.claude).toMatchObject({ name: 'claude', kind: 'native' });
    expect(policy.providers.codex).toMatchObject({
      name: 'codex',
      kind: 'api',
      transport: 'cli',
      mode: 'shadow',
      command: 'codex',
    });
    expect(policy.providers.deepseek).toMatchObject({
      name: 'deepseek',
      kind: 'api',
      transport: 'api',
      mode: 'shadow',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
    for (const [name, config] of Object.entries(policy.providers)) {
      expect(typeof config.enabled, `${name}.enabled`).toBe('boolean');
    }
    expect(policy.quorumRule).toEqual({ agreement: '2-of-3', minProviders: 2 });
    expect(policy.planQuorum).toEqual({
      budgetRatio: 0.5,
      confidenceThreshold: 0.8,
      securityCases: ['infra'],
      securityRoles: ['security-reviewer'],
      securityKeywords: expect.arrayContaining(['auth', 'secret', 'token']),
    });
    expect(policy.planQuorum.securityKeywords.length).toBeGreaterThan(5);
  });

  it('defaults plan_quorum when absent', () => {
    const yamlText = `
providers:
  claude:
    kind: native
    enabled: true
`;
    const policy = parseCrosscheckPolicy(yamlText);
    expect(policy.planQuorum).toEqual({
      budgetRatio: 0.5,
      confidenceThreshold: 0.8,
      securityCases: ['infra'],
      securityRoles: ['security-reviewer'],
      securityKeywords: expect.arrayContaining(['auth', 'secret', 'token']),
    });
  });

  it('loadCrosscheckPolicy() reads the same file CROSSCHECK_POLICY_PATH points to', () => {
    // The offline switch is on for the whole suite (test/setup.ts), and it is
    // the only thing load() changes about the file — so it has to come off to
    // check the path wiring, or this asserts nothing about which file was read.
    const previous = process.env.SMITH_CROSSCHECK_OFFLINE;
    delete process.env.SMITH_CROSSCHECK_OFFLINE;
    try {
      const text = readFileSync(CROSSCHECK_POLICY_PATH, 'utf8');
      expect(parseCrosscheckPolicy(text)).toEqual(loadCrosscheckPolicy());
    } finally {
      if (previous !== undefined) process.env.SMITH_CROSSCHECK_OFFLINE = previous;
    }
  });

  describe('the offline switch (SMITH_CROSSCHECK_OFFLINE)', () => {
    // Why this exists: with codex/deepseek flipped to `enabled: true` in the
    // working copy's crosscheck.yml, 18 tests in gate/epic/cli/specFindings
    // stopped asserting anything and started timing out at 5000ms — they were
    // really spawning `codex exec` and really POSTing to api.deepseek.com.
    // A unit suite whose verdict depends on which box it runs on is not a
    // suite; and reaching the network from one is a defect on its own.
    const yamlText = `
providers:
  claude: { kind: native, enabled: true }
  codex: { kind: api, transport: cli, command: codex, enabled: true }
  deepseek:
    kind: api
    transport: api
    enabled: true
    base_url: https://api.deepseek.com
    model: deepseek-reasoner
    api_key_env: DEEPSEEK_API_KEY
`;

    it('forces every external provider off when set, leaving the native judge alone', () => {
      const policy = parseCrosscheckPolicy(yamlText, { offline: true });
      expect(policy.providers.claude?.enabled).toBe(true);
      expect(policy.providers.codex?.enabled).toBe(false);
      expect(policy.providers.deepseek?.enabled).toBe(false);
    });

    it('changes nothing else about the provider it disables', () => {
      const online = parseCrosscheckPolicy(yamlText);
      const offline = parseCrosscheckPolicy(yamlText, { offline: true });
      expect({ ...offline.providers.deepseek, enabled: true }).toEqual(online.providers.deepseek);
    });

    it('is off by default, so the parser still reports the file as written', () => {
      expect(parseCrosscheckPolicy(yamlText).providers.codex?.enabled).toBe(true);
    });

    it('leaves this suite hermetic no matter what the local policy enables', () => {
      // The regression guard for the whole change: whatever crosscheck.yml
      // says on this machine, no test run may invoke an external provider.
      for (const [name, config] of Object.entries(loadCrosscheckPolicy().providers)) {
        if (config.kind === 'native') continue;
        expect(config.enabled, `${name} must not be invokable from a test`).toBe(false);
      }
    });
  });

  it('defaults mode to shadow and model_tier to mid when absent', () => {
    const yamlText = `
providers:
  codex:
    kind: api
    transport: cli
    command: codex
    enabled: true
`;
    const policy = parseCrosscheckPolicy(yamlText);
    expect(policy.providers.codex).toMatchObject({ mode: 'shadow', modelTier: 'mid', args: [] });
  });

  it('parses asymmetric_roles.pairs into checkable finder/critic pairs (P9-23)', () => {
    const policy = parseCrosscheckPolicy(`
providers:
  claude: { kind: native, enabled: true }
asymmetric_roles:
  finder_ne_critic: true
  pairs:
    - finder: planner
      critic: spec-reviewer
    - finder: reviewer
      critic: verifier
`);
    expect(policy.asymmetricRoles).toEqual({
      finderNeCritic: true,
      pairs: [
        { finder: 'planner', critic: 'spec-reviewer' },
        { finder: 'reviewer', critic: 'verifier' },
      ],
    });
  });

  it('defaults asymmetric_roles to the shipped pairs when the block is absent (P9-23)', () => {
    const policy = parseCrosscheckPolicy(`
providers:
  claude: { kind: native, enabled: true }
`);
    expect(policy.asymmetricRoles.finderNeCritic).toBe(true);
    expect(policy.asymmetricRoles.pairs).toEqual([
      { finder: 'planner', critic: 'spec-reviewer' },
      { finder: 'reviewer', critic: 'verifier' },
    ]);
  });

  it('the shipped crosscheck.yml declares the two pairs the role templates promise (P9-23)', () => {
    // spec-reviewer's template says "never runs on the planner's own model";
    // verifier's says "never runs on the reviewer's own model". Those two
    // sentences are the whole rule — this is their machine-readable form.
    expect(loadCrosscheckPolicy().asymmetricRoles.pairs).toEqual([
      { finder: 'planner', critic: 'spec-reviewer' },
      { finder: 'reviewer', critic: 'verifier' },
    ]);
  });

  it('defaults quorum_rule when absent', () => {
    const yamlText = `
providers:
  claude:
    kind: native
    enabled: true
`;
    const policy = parseCrosscheckPolicy(yamlText);
    expect(policy.quorumRule).toEqual({ agreement: '2-of-3', minProviders: 2 });
  });

  it('throws on an empty providers block', () => {
    expect(() => parseCrosscheckPolicy('providers: {}')).toThrow(CrosscheckError);
  });

  it('throws when a cli-transport provider has no command', () => {
    const yamlText = `
providers:
  codex:
    kind: api
    transport: cli
    enabled: true
`;
    expect(() => parseCrosscheckPolicy(yamlText)).toThrow(CrosscheckError);
  });

  it('throws when an api-transport provider is missing base_url/model/api_key_env', () => {
    const yamlText = `
providers:
  deepseek:
    kind: api
    transport: api
    enabled: true
`;
    expect(() => parseCrosscheckPolicy(yamlText)).toThrow(CrosscheckError);
  });

  it('throws when a provider is neither native nor a recognized transport', () => {
    const yamlText = `
providers:
  mystery:
    kind: api
    enabled: true
`;
    expect(() => parseCrosscheckPolicy(yamlText)).toThrow(CrosscheckError);
  });

  // Same class scheduler.yml's knobs were just held to: `??` defaults on
  // null/undefined only, so a YAML typo reaches the comparison as itself and
  // the gate answers differently instead of failing. Every case below was
  // reproduced against the real parse before it was written.
  const withPolicy = (block: string): string =>
    `providers:\n  claude: { kind: native, enabled: true }\n${block}`;

  it('rejects a min_providers no comparison can read (one judge decides a two-judge gate)', () => {
    // `1 < 'two'` is false, so the `insufficient-providers` escalation never
    // fires: computeQuorum walks on and returns a decided `1-of-1` confirm
    // for a gate the policy says needs two providers.
    expect(() => parseCrosscheckPolicy(withPolicy('quorum_rule:\n  min_providers: two\n'))).toThrow(
      CrosscheckError,
    );
  });

  it('rejects a budget_ratio no comparison can read (trigger 1 never fires)', () => {
    // `totalTokens >= 'half' * cap` is `n >= NaN`, always false, so a plan
    // may hold the whole epic budget and still skip the quorum.
    expect(() => parseCrosscheckPolicy(withPolicy('plan_quorum:\n  budget_ratio: half\n'))).toThrow(
      CrosscheckError,
    );
  });

  it('rejects a confidence_threshold no comparison can read (trigger 3 never fires)', () => {
    expect(() =>
      parseCrosscheckPolicy(withPolicy('plan_quorum:\n  confidence_threshold: high\n')),
    ).toThrow(CrosscheckError);
  });

  it('rejects a bare scalar where a list belongs, which spreads into characters', () => {
    // `[...'infra']` is ['i','n','f','r','a'], and the cases are matched with
    // Set.has -- so a task whose case IS infra stops tripping trigger 2.
    expect(() =>
      parseCrosscheckPolicy(withPolicy('plan_quorum:\n  security_cases: infra\n')),
    ).toThrow(CrosscheckError);
    expect(() =>
      parseCrosscheckPolicy(withPolicy('plan_quorum:\n  security_roles: security-reviewer\n')),
    ).toThrow(CrosscheckError);
  });

  it('rejects a scalar security_keywords, which fails the other way (everything matches)', () => {
    // Keywords match by substring, so ['a','u','t','h'] trips on "render a
    // nice table". The same typo that silences two arms floods the third.
    expect(() =>
      parseCrosscheckPolicy(withPolicy('plan_quorum:\n  security_keywords: auth\n')),
    ).toThrow(CrosscheckError);
  });

  it('rejects a list entry the matcher cannot compare against a string', () => {
    expect(() =>
      parseCrosscheckPolicy(withPolicy('plan_quorum:\n  security_cases: [infra, 7]\n')),
    ).toThrow(CrosscheckError);
  });

  it('names the field and the value, because the policy file is hand-edited', () => {
    expect(() => parseCrosscheckPolicy(withPolicy('plan_quorum:\n  budget_ratio: half\n'))).toThrow(
      /plan_quorum\.budget_ratio.*"half"/s,
    );
  });

  // The same class again, one field over. Every knob parseCrosscheckPolicy
  // hands to a comparison is checked -- except the booleans, which kept `??`.
  // `enabled` is the sharpest of them: the runbook calls `enabled: false` the
  // entire rollback step for an external judge, and the three readers
  // (quorum.ts's enabledExternalProviders and runQuorum, providers/index.ts's
  // runJudge) all ask it by truthiness. Reproduced against the compiled parse
  // and the real runJudge before any of this was written.
  const withCodex = (fields: string): string =>
    `providers:\n  claude: { kind: native, enabled: true }\n  codex:\n    kind: api\n    transport: cli\n    command: codex\n${fields}`;

  it.each([
    ['no', 'the YAML 1.1 spelling'],
    ['off', 'the other YAML 1.1 spelling'],
    ['"false"', 'quoted, so it is a string'],
    ['n', 'the abbreviation'],
  ])('rejects enabled: %s (%s), which leaves the judge switched on', (literal) => {
    // The `yaml` package is YAML 1.2: only false/False/FALSE are booleans.
    // Every literal here parses as a non-empty string, `?? false` does not
    // fire on it, and `!config.enabled` is false -- so the operator who wrote
    // the rollback watched the provider keep being dispatched.
    expect(() => parseCrosscheckPolicy(withCodex(`    enabled: ${literal}\n`))).toThrow(
      CrosscheckError,
    );
  });

  it('rejects a non-boolean enabled on a native provider by the same rule', () => {
    expect(() =>
      parseCrosscheckPolicy('providers:\n  claude: { kind: native, enabled: "true" }\n'),
    ).toThrow(CrosscheckError);
  });

  it('rejects args a spawn cannot pass, instead of failing at the child process', () => {
    // `spawn(command, 'exec')` throws ERR_INVALID_ARG_TYPE at dispatch time,
    // which quorum.ts catches and records as a provider error -- so a typo
    // here removes an external judge from the quorum without saying so.
    expect(() => parseCrosscheckPolicy(withCodex('    args: exec\n'))).toThrow(CrosscheckError);
    expect(() => parseCrosscheckPolicy(withCodex('    args: [exec, 7]\n'))).toThrow(
      CrosscheckError,
    );
  });

  it('rejects a model_tier that is not a string, which the event log stores as one', () => {
    expect(() => parseCrosscheckPolicy(withCodex('    model_tier: 3\n'))).toThrow(CrosscheckError);
  });

  it('rejects a response_format_json_object the request builder cannot read', () => {
    const apiProvider = (literal: string): string =>
      `providers:\n  claude: { kind: native, enabled: true }\n  deepseek:\n    kind: api\n    transport: api\n    base_url: https://example.invalid\n    model: m\n    api_key_env: X\n    response_format_json_object: ${literal}\n`;
    expect(() => parseCrosscheckPolicy(apiProvider('no'))).toThrow(CrosscheckError);
  });

  it('rejects a finder_ne_critic the assertion cannot read', () => {
    // This one fails toward MORE checking -- a truthy string keeps the rule
    // enforced -- but an operator who writes `no` and is not told still got
    // the opposite of what they wrote.
    expect(() =>
      parseCrosscheckPolicy(withPolicy('asymmetric_roles:\n  finder_ne_critic: no\n')),
    ).toThrow(CrosscheckError);
  });

  it('rejects a pairs entry the audit cannot check, instead of dropping it', () => {
    // The pair list is the only knob in this file that answered a wrong shape
    // by filtering rather than throwing. `critics:` is one keystroke from
    // `critic:`, and the entry it belongs to vanishes: dispatchAudit walks the
    // pairs that survived, finds nothing wrong with them, and reports ok --
    // over a shorter list than the operator wrote. The rule that went missing
    // here is the verifier's own ("never runs on the reviewer's own model"),
    // so a verifier dispatched on the reviewer's model passes an audit that
    // never looked. A half-readable list is the same hole as no list.
    expect(() =>
      parseCrosscheckPolicy(
        withPolicy(
          'asymmetric_roles:\n  pairs:\n    - finder: planner\n      critic: spec-reviewer\n    - finder: reviewer\n      critics: verifier\n',
        ),
      ),
    ).toThrow(CrosscheckError);
  });

  it('rejects a pairs value that is not a list of finder/critic maps', () => {
    // A bare scalar reached `.map` and threw a raw TypeError from inside the
    // parse -- the one wrong shape in this file that did not arrive as a
    // CrosscheckError naming the field. A list of bare role names is the
    // quieter half of the same slip: every entry loses both keys, the filter
    // empties the list, and `[] ?? DEFAULT` keeps the empty one.
    expect(() =>
      parseCrosscheckPolicy(withPolicy('asymmetric_roles:\n  pairs: verifier\n')),
    ).toThrow(CrosscheckError);
    expect(() =>
      parseCrosscheckPolicy(withPolicy('asymmetric_roles:\n  pairs: [reviewer, verifier]\n')),
    ).toThrow(CrosscheckError);
  });

  it('keeps an explicitly empty pairs list legal, and it does not become the defaults', () => {
    // dispatchAudit already has an answer for a policy that declares no pairs
    // -- one `unverifiable` check and `ok: false` -- so an operator writing
    // the empty list is saying something the audit can read back. Only shapes
    // no comparison can read are refused.
    const emptied = parseCrosscheckPolicy(withPolicy('asymmetric_roles:\n  pairs: []\n'));
    expect(emptied.asymmetricRoles.pairs).toEqual([]);
  });

  it('names the provider, the field and the value, because the file is hand-edited', () => {
    expect(() => parseCrosscheckPolicy(withCodex('    enabled: no\n'))).toThrow(
      /providers\.codex\.enabled.*"no"/s,
    );
  });

  it('keeps every spelling of a real boolean working', () => {
    // The check is on the shape, not on the operator's capitalisation: YAML
    // 1.2 reads all three of these as booleans, and the rollback must keep
    // working when it is written any of those ways.
    for (const [literal, expected] of [
      ['false', false],
      ['False', false],
      ['FALSE', false],
      ['true', true],
    ] as const) {
      const policy = parseCrosscheckPolicy(withCodex(`    enabled: ${literal}\n`));
      expect(policy.providers.codex?.enabled, literal).toBe(expected);
    }
    // Omitted is still the safe default, and still not an error.
    expect(parseCrosscheckPolicy(withCodex('')).providers.codex?.enabled).toBe(false);
  });

  it('still accepts a document that omits the block, and an empty list stays legal', () => {
    // The check is on the value a knob has, not on the knob being present --
    // and an explicitly empty list is an operator disabling one arm of
    // trigger 2 in writing, which the file should keep allowing.
    const defaulted = parseCrosscheckPolicy(withPolicy(''));
    expect(defaulted.planQuorum.budgetRatio).toBe(0.5);
    expect(defaulted.planQuorum.confidenceThreshold).toBe(0.8);
    expect(defaulted.planQuorum.securityCases).toEqual(['infra']);
    expect(defaulted.quorumRule.minProviders).toBe(2);

    const emptied = parseCrosscheckPolicy(withPolicy('plan_quorum:\n  security_cases: []\n'));
    expect(emptied.planQuorum.securityCases).toEqual([]);
  });
});
