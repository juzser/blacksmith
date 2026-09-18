import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBudgetPolicy } from '../src/budgets.js';
import {
  HARNESS_DEFAULT_MAX_OUTPUT_BYTES,
  HARNESS_POLICY_VERSION,
  HarnessError,
  type HarnessPolicy,
  loadHarnessPolicy,
  parseHarnessPolicy,
  planWorkerTurn,
  roleAccess,
  summarizeHarnesses,
} from '../src/harness.js';
import { AGENTS_DIR, HARNESS_POLICY_PATH, REPO_ROOT } from '../src/paths.js';
import { loadGuardrailPolicy } from '../src/policy.js';
import { loadTaxonomy } from '../src/taxonomy.js';

// ---------------------------------------------------------------------------
// The worker-harness port.
//
// Two things are being held in place here, and they fail differently:
//
//   - the shipped policy has to keep describing the factory that exists. It
//     is the first written statement that every worker turn runs in-process
//     under Claude Code by default, and a policy that quietly grew a second
//     harness without a test noticing would be a claim about deployment that
//     no deployment backs.
//   - the judge boundary has to survive the new axis. providers/types.ts
//     already hands an external judge transport nothing but a prompt; a `cli`
//     harness is the same kind of far side, so the same refusal has to hold
//     there unless the harness itself declares `judge_args` that make the
//     program read-only — and it has to hold for the roles guardrails.yml
//     calls judges rather than for a list this test or harness.ts keeps of
//     its own.
// ---------------------------------------------------------------------------

const taxonomy = loadTaxonomy();
const guardrails = loadGuardrailPolicy();
const AGENT_ROLES = taxonomy.dimensions.agent ?? [];

/** Every role with a template on disk — the ones any harness can start. */
const TEMPLATED_ROLES = readdirSync(AGENTS_DIR)
  .filter((entry) => entry.endsWith('.md'))
  .map((entry) => entry.slice(0, -'.md'.length))
  .sort();

const tmpDirs: string[] = [];
function policyFile(yamlText: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-harness-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'harness.yml');
  writeFileSync(file, yamlText, 'utf8');
  return file;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const CLI_POLICY: HarnessPolicy = parseHarnessPolicy(`
default: claude-code
harnesses:
  - name: claude-code
    kind: in-process
  - name: codex-cli
    kind: cli
    command: codex
    args: ["exec", "--cd", "{worktree}", "--prompt-file", "{prompt_file}", "--role", "{role}"]
    env: ["CODEX_API_KEY"]
`);

/** Declares judge_args, so a judge role may be handed a worktree (§18 rule 5's escape valve). */
const JUDGE_CAPABLE_POLICY: HarnessPolicy = parseHarnessPolicy(`
version: 2
default: claude-code
harnesses:
  - name: claude-code
    kind: in-process
  - name: codex-cli
    kind: cli
    command: codex
    args: ["exec", "-C", "{worktree}", "-m", "{model}", "-"]
    worker_args: ["-s", "workspace-write"]
    judge_args: ["-s", "read-only"]
    schema_args: ["--output-schema", "{schema_file}"]
    output: codex-json
    models: { frontier: gpt-5-high, mid: gpt-5-codex, small: gpt-5-mini }
    env: [HOME, PATH]
    timeout_ms: 900000
`);

function request(overrides: Record<string, unknown> = {}) {
  return {
    role: 'coder',
    taskId: 'epic-1/task-1',
    promptFile: '/tmp/prompt.md',
    worktree: '/tmp/wt',
    ...overrides,
  } as Parameters<typeof planWorkerTurn>[0];
}

describe('the shipped policy is this factory, written down', () => {
  it('names three harnesses, default claude-code, in-process, starting no program', () => {
    const policy = loadHarnessPolicy();
    expect(policy.version).toBe(2);
    expect(policy.defaultHarness).toBe('claude-code');
    expect(policy.source).toBe('default');
    expect([...policy.harnesses.map((h) => h.name)].sort()).toEqual([
      'claude-cli',
      'claude-code',
      'codex-cli',
    ]);
    const claudeCode = policy.harnesses.find((h) => h.name === 'claude-code');
    expect(claudeCode?.kind).toBe('in-process');
    expect(claudeCode?.command).toBeNull();
  });

  it('reads from HARNESS_POLICY_PATH (paths.ts), not a second copy in code', () => {
    const onDisk = readFileSync(HARNESS_POLICY_PATH, 'utf8');
    expect(parseHarnessPolicy(onDisk).harnesses).toHaveLength(3);
    expect(HARNESS_POLICY_VERSION).toBe(2);
  });

  it('refuses a --policy path that is not there, rather than silently defaulting', () => {
    // A typo'd path that fell back to the shipped policy would run the turn
    // under a harness the operator did not choose, and print a plan that
    // looks like the one they asked for.
    expect(() => loadHarnessPolicy('/nonexistent/harness.yml')).toThrow(HarnessError);
    try {
      loadHarnessPolicy('/nonexistent/harness.yml');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.policy-not-found');
    }
  });

  it('serves every role that ships a template, and no role that does not', () => {
    const listing = summarizeHarnesses();
    const claudeCode = listing.harnesses.find((h) => h.name === 'claude-code');
    const served = [...(claudeCode?.roles ?? [])].sort();
    expect(served).toEqual(AGENT_ROLES.filter((r) => TEMPLATED_ROLES.includes(r)).sort());
    expect(served).toContain('coder');
    expect(served).not.toContain('operator');
  });

  it('a --policy override still loads through the same loader', () => {
    const file = policyFile(`
default: codex-cli
harnesses:
  - name: codex-cli
    kind: cli
    command: codex
    args: ["{prompt_file}"]
`);
    const policy = loadHarnessPolicy(file);
    expect(policy.source).toBe('file');
    expect(policy.defaultHarness).toBe('codex-cli');
  });
});

describe('an in-process turn', () => {
  it('names the subagent type and the template it comes from', () => {
    const invocation = planWorkerTurn(request());
    expect(invocation.kind).toBe('in-process');
    if (invocation.kind !== 'in-process') throw new Error('unreachable');
    expect(invocation.harness).toBe('claude-code');
    expect(invocation.subagentType).toBe('coder');
    expect(invocation.template).toBe('.claude/agents/coder.md');
    expect(invocation.worktree).toBe('/tmp/wt');
    expect(invocation.access).toBe('worker');
    expect(invocation.sandboxRequired).toBe(false);
  });

  it('states the sandbox obligation when a judge role is given a tree to read', () => {
    // In-process judges do read the worktree — that is what `smith sandbox
    // open` is for. The invocation says the lease is owed rather than leaving
    // it to whoever remembers wave.md.
    const invocation = planWorkerTurn(request({ role: 'reviewer' }));
    expect(invocation.access).toBe('judge');
    expect(invocation.sandboxRequired).toBe(true);
  });

  it('owes no lease when the judge turn carries no worktree', () => {
    const invocation = planWorkerTurn(request({ role: 'reviewer', worktree: null }));
    expect(invocation.sandboxRequired).toBe(false);
  });

  it('refuses a role that ships no template (D-191), which is what refuses operator', () => {
    expect(TEMPLATED_ROLES).not.toContain('operator');
    expect(AGENT_ROLES).toContain('operator');
    try {
      planWorkerTurn(request({ role: 'operator' }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe('harness.no-template');
      expect((error as HarnessError).message).toContain('.claude/agents/operator.md');
    }
  });
});

describe('a cli turn is outside the trust boundary', () => {
  it('refuses to hand a judge role a worktree path when judge_args is empty (§18 rule 5)', () => {
    for (const role of guardrails.judgeSandbox.roles) {
      try {
        planWorkerTurn(request({ harness: 'codex-cli', role }), { policy: CLI_POLICY });
        throw new Error(`expected a refusal for ${role}`);
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessError);
        expect((error as HarnessError).code).toBe('harness.judge-worktree');
        expect((error as HarnessError).message).toContain('judge_args');
      }
    }
  });

  it('reads which roles those are from guardrails.yml, not from a second list', () => {
    // If harness.ts kept its own copy, the copy would drift, and the drift
    // that matters is a judge quietly reclassified as a worker.
    const judges = AGENT_ROLES.filter((role) => roleAccess(role, guardrails) === 'judge');
    expect(judges.sort()).toEqual([...guardrails.judgeSandbox.roles].sort());
    expect(judges).toContain('reviewer');
    expect(roleAccess('tester', guardrails)).toBe('write-scoped');
    expect(roleAccess('coder', guardrails)).toBe('worker');
  });

  it('serves a judge role that asks for nothing but the prompt', () => {
    // The boundary is about the worktree, not about the role: an external
    // judge reading a prompt and returning findings is exactly what
    // providers/types.ts already allows.
    const prompt = parseHarnessPolicy(`
harnesses:
  - name: codex-cli
    kind: cli
    command: codex
    args: ["exec", "--prompt-file", "{prompt_file}"]
`);
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'reviewer', worktree: null }),
      { policy: prompt },
    );
    expect(invocation.kind).toBe('cli');
    expect(invocation.worktree).toBeNull();
    expect(invocation.sandboxRequired).toBe(false);
  });

  it('renders the argv exactly, substituting every placeholder, worker_args appended', () => {
    const invocation = planWorkerTurn(request({ harness: 'codex-cli' }), { policy: CLI_POLICY });
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toEqual([
      'exec',
      '--cd',
      '/tmp/wt',
      '--prompt-file',
      '/tmp/prompt.md',
      '--role',
      'coder',
    ]);
    expect(invocation.cwd).toBe('/tmp/wt');
    expect(invocation.stdin).toBe('prompt');
    expect(invocation.template).toBe('.claude/agents/coder.md');
  });

  it('carries env variable names and never their values', () => {
    // A rendered invocation is printed as JSON, to a terminal and into logs.
    process.env.CODEX_API_KEY = 'sk-not-a-real-key-0xdeadbeef';
    try {
      const invocation = planWorkerTurn(request({ harness: 'codex-cli' }), { policy: CLI_POLICY });
      if (invocation.kind !== 'cli') throw new Error('unreachable');
      expect(invocation.envAllowlist).toEqual(['CODEX_API_KEY']);
      expect(JSON.stringify(invocation)).not.toContain('sk-not-a-real-key-0xdeadbeef');
    } finally {
      delete process.env.CODEX_API_KEY;
    }
  });

  it('refuses rather than interpolating an empty string for a missing worktree', () => {
    try {
      planWorkerTurn(request({ harness: 'codex-cli', worktree: null }), { policy: CLI_POLICY });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.missing-substitution');
    }
  });

  it('lists a cli harness as serving no judge role, when it declares no judge_args', () => {
    const listing = summarizeHarnesses({ policy: CLI_POLICY });
    const codex = listing.harnesses.find((h) => h.name === 'codex-cli');
    expect(codex?.roles ?? []).toContain('coder');
    for (const role of guardrails.judgeSandbox.roles) {
      expect(codex?.roles ?? []).not.toContain(role);
    }
  });
});

describe('judge_args is the escape valve: OS/tool-enforced read-only, declared by the harness', () => {
  it('renders a judge invocation with cwd = worktree and sandboxRequired: true when judge_args is non-empty', () => {
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'reviewer', schema: 'judge-verdict' }),
      { policy: JUDGE_CAPABLE_POLICY },
    );
    expect(invocation.kind).toBe('cli');
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.worktree).toBe('/tmp/wt');
    expect(invocation.cwd).toBe('/tmp/wt');
    expect(invocation.sandboxRequired).toBe(true);
    expect(invocation.args).toContain('read-only');
    expect(invocation.args).not.toContain('workspace-write');
  });

  it('renders -C <worktree> -m <model> - -s workspace-write --output-schema <abs path> for a worker role, tier from template', () => {
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'coder', schema: 'result' }),
      { policy: JUDGE_CAPABLE_POLICY },
    );
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    // coder.md declares `model: sonnet`, which maps to the mid tier.
    expect(invocation.tier).toBe('mid');
    expect(invocation.model).toBe('gpt-5-codex');
    expect(invocation.args).toEqual([
      'exec',
      '-C',
      '/tmp/wt',
      '-m',
      'gpt-5-codex',
      '-',
      '-s',
      'workspace-write',
      '--output-schema',
      path.join(REPO_ROOT, 'factory', 'specs', 'schema', 'result.schema.json'),
    ]);
  });

  it('renders -s read-only for the reviewer, still under the mid tier its template names', () => {
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'reviewer', schema: 'judge-verdict' }),
      { policy: JUDGE_CAPABLE_POLICY },
    );
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.tier).toBe('mid');
    expect(invocation.args).toContain('read-only');
    expect(invocation.args.slice(-2)).toEqual([
      '--output-schema',
      path.join(REPO_ROOT, 'factory', 'specs', 'schema', 'judge-verdict.schema.json'),
    ]);
  });

  it('accepts an explicit --tier that overrides the template mapping', () => {
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'coder', schema: 'result', tier: 'small' }),
      { policy: JUDGE_CAPABLE_POLICY },
    );
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.tier).toBe('small');
    expect(invocation.model).toBe('gpt-5-mini');
  });

  it('refuses an unknown schema name, listing the ones that exist', () => {
    try {
      planWorkerTurn(request({ harness: 'codex-cli', role: 'coder', schema: 'not-a-schema' }), {
        policy: JUDGE_CAPABLE_POLICY,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe('harness.unknown-schema');
      expect((error as HarnessError).message).toContain('result');
    }
  });

  it('carries the per-harness timeout, a default max_output_bytes, and the role cap_tokens', () => {
    const budgets = loadBudgetPolicy();
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'coder', schema: 'result' }),
      { policy: JUDGE_CAPABLE_POLICY },
    );
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.budget).toEqual({
      timeout_ms: 900000,
      max_output_bytes: HARNESS_DEFAULT_MAX_OUTPUT_BYTES,
      cap_tokens: budgets.task.coder.capTokens,
    });
  });

  it('lists a judge_args-capable cli harness as serving judge roles too', () => {
    const listing = summarizeHarnesses({ policy: JUDGE_CAPABLE_POLICY });
    const codex = listing.harnesses.find((h) => h.name === 'codex-cli');
    expect(codex?.roles ?? []).toContain('reviewer');
    expect(codex?.output).toBe('codex-json');
    expect(codex?.models).toEqual({
      frontier: 'gpt-5-high',
      mid: 'gpt-5-codex',
      small: 'gpt-5-mini',
    });
  });
});

describe('schema_args: appended only when the turn names a schema (F1)', () => {
  it('(a) shipped policy, codex-cli, coder, no schema: renders, argv ends "-" "-s" "workspace-write", no --output-schema', () => {
    const invocation = planWorkerTurn(request({ harness: 'codex-cli', role: 'coder' }));
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.args.slice(-3)).toEqual(['-', '-s', 'workspace-write']);
    expect(invocation.args).not.toContain('--output-schema');
    expect(invocation.schema).toBeNull();
  });

  it('(b) shipped policy, codex-cli, coder, schema: result: --output-schema <abs path> appended last', () => {
    const invocation = planWorkerTurn(
      request({ harness: 'codex-cli', role: 'coder', schema: 'result' }),
    );
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.args.slice(-5)).toEqual([
      '-',
      '-s',
      'workspace-write',
      '--output-schema',
      path.join(REPO_ROOT, 'factory', 'specs', 'schema', 'result.schema.json'),
    ]);
  });

  it('(c) shipped policy, codex-cli, reviewer, worktree given, no schema: -s read-only, cwd = worktree, sandboxRequired true', () => {
    const invocation = planWorkerTurn(request({ harness: 'codex-cli', role: 'reviewer' }));
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.args).toContain('read-only');
    expect(invocation.args).not.toContain('--output-schema');
    expect(invocation.cwd).toBe('/tmp/wt');
    expect(invocation.sandboxRequired).toBe(true);
  });

  it('(d) shipped policy, claude-cli, planner, no worktree: renders, cwd null, model from the template’s own tier', () => {
    const templateModelLine = readFileSync(path.join(AGENTS_DIR, 'planner.md'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('model:'));
    const templateModel = templateModelLine?.slice('model:'.length).trim();
    expect(templateModel).toBeTruthy();

    const invocation = planWorkerTurn(
      request({ harness: 'claude-cli', role: 'planner', worktree: null }),
    );
    if (invocation.kind !== 'cli') throw new Error('unreachable');
    expect(invocation.worktree).toBeNull();
    expect(invocation.cwd).toBeNull();
    expect(invocation.model).toBe(templateModel);
  });

  it('(e) parseHarnessPolicy rejects schema_args naming an unknown placeholder', () => {
    try {
      parseHarnessPolicy(
        'harnesses: [{name: a, kind: cli, command: x, args: ["{prompt_file}"], schema_args: ["{worktre}"]}]',
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe('harness.invalid-policy');
    }
  });

  it('a harness whose plain args interpolate {schema_file} still refuses with no schema named, telling the operator to pass --schema', () => {
    const policy = parseHarnessPolicy(`
harnesses:
  - name: a
    kind: cli
    command: x
    args: ["{prompt_file}", "--output-schema", "{schema_file}"]
`);
    try {
      planWorkerTurn(request({ harness: 'a' }), { policy });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe('harness.missing-substitution');
      expect((error as HarnessError).message).toContain('--schema <name>');
    }
  });
});

describe('an unknown --tier is refused (F2)', () => {
  it('refuses a tier the taxonomy does not know, naming the ones that exist', () => {
    try {
      planWorkerTurn(
        request({ tier: 'bogus' as unknown as Parameters<typeof planWorkerTurn>[0]['tier'] }),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe('harness.unknown-tier');
      expect((error as HarnessError).message).toContain('frontier');
      expect((error as HarnessError).message).toContain('mid');
      expect((error as HarnessError).message).toContain('small');
    }
  });
});

describe('what the port refuses before anything runs', () => {
  it('a role the taxonomy does not know', () => {
    try {
      planWorkerTurn(request({ role: 'archaeologist' }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.unknown-role');
    }
  });

  it('a harness the policy does not declare, naming the ones it does', () => {
    try {
      planWorkerTurn(request({ harness: 'ghostwriter-cli' }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.unknown');
      expect((error as HarnessError).message).toContain('claude-code');
    }
  });

  it('a harness that declares roles and was asked for another one', () => {
    const narrow = parseHarnessPolicy(`
harnesses:
  - name: tests-only
    kind: cli
    command: run-tests
    roles: ["tester"]
    args: ["{prompt_file}"]
`);
    try {
      planWorkerTurn(request({ harness: 'tests-only' }), { policy: narrow });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.role-not-served');
    }
  });

  it('a turn with no prompt file, because this port renders invocations and not prompts', () => {
    try {
      planWorkerTurn(request({ promptFile: '' }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.missing-prompt');
    }
  });

  it('a turn that names no task, because the dispatch written after it must name the same one', () => {
    try {
      planWorkerTurn(request({ taskId: '' }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).code).toBe('harness.missing-task');
    }
  });
});

describe('parsing a policy file', () => {
  it('reads one off disk through --policy', () => {
    const file = policyFile(`
default: codex-cli
harnesses:
  - name: codex-cli
    kind: cli
    command: codex
    args: ["{prompt_file}"]
`);
    const policy = loadHarnessPolicy(file);
    expect(policy.source).toBe('file');
    expect(policy.defaultHarness).toBe('codex-cli');
  });

  it('defaults to the first harness when none is named', () => {
    expect(parseHarnessPolicy('harnesses: [{name: a, kind: in-process}]').defaultHarness).toBe('a');
  });

  it('still parses a version-1 file with no output, models, worker_args, or judge_args', () => {
    const policy = parseHarnessPolicy(`
version: 1
harnesses:
  - name: a
    kind: cli
    command: x
    args: ["{prompt_file}"]
`);
    expect(policy.version).toBe(1);
    const only = policy.harnesses[0];
    expect(only?.output).toBe('text');
    expect(only?.models).toEqual({});
    expect(only?.judgeArgs).toEqual([]);
    expect(only?.timeoutMs).toBeNull();
    expect(only?.maxOutputBytes).toBeNull();
  });

  const rejects: Array<[string, string]> = [
    ['no harnesses at all', 'harnesses: []'],
    ['a harness with no name', 'harnesses: [{kind: in-process}]'],
    ['a kind that is neither', 'harnesses: [{name: a, kind: tmux}]'],
    [
      'the same name twice',
      'harnesses: [{name: a, kind: in-process}, {name: a, kind: in-process}]',
    ],
    ['a cli harness with no command', 'harnesses: [{name: a, kind: cli}]'],
    [
      'an in-process harness with a command',
      'harnesses: [{name: a, kind: in-process, command: x}]',
    ],
    ['a default that names no harness', 'default: b\nharnesses: [{name: a, kind: in-process}]'],
    [
      'a placeholder nothing substitutes',
      'harnesses: [{name: a, kind: cli, command: x, args: ["{worktre}"]}]',
    ],
    [
      'a placeholder in judge_args nothing substitutes',
      'harnesses: [{name: a, kind: cli, command: x, args: ["{prompt_file}"], judge_args: ["{worktre}"]}]',
    ],
    ['roles that are not strings', 'harnesses: [{name: a, kind: in-process, roles: [1]}]'],
    [
      'an output mode that is not one of the three',
      'harnesses: [{name: a, kind: cli, command: x, output: xml}]',
    ],
    [
      'a models tier that is not one of the three',
      'harnesses: [{name: a, kind: cli, command: x, models: {huge: x}}]',
    ],
  ];
  for (const [what, yamlText] of rejects) {
    it(`refuses ${what}`, () => {
      try {
        parseHarnessPolicy(yamlText);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessError);
        expect((error as HarnessError).code).toBe('harness.invalid-policy');
      }
    });
  }

  it('names the placeholders it does substitute, so the typo is fixable from the message', () => {
    try {
      parseHarnessPolicy('harnesses: [{name: a, kind: cli, command: x, args: ["{worktre}"]}]');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as HarnessError).message).toContain('{worktree}');
      expect((error as HarnessError).message).toContain('{prompt_file}');
      expect((error as HarnessError).message).toContain('{model}');
      expect((error as HarnessError).message).toContain('{schema_file}');
    }
  });
});

describe('load-bearing rule 3: this port describes a process, it does not start one', () => {
  it('holds nothing that could spawn one', () => {
    // `smith` is an observer, and an observer that can act closes its own
    // loop: it would dispatch the turn it later reads back as evidence that a
    // turn happened. The refusals above are only worth writing while the
    // module that renders the invocation cannot also run it.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'harness.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\b(spawnSync|execSync|execFileSync|spawn|execFile)\s*\(/);
  });
});
