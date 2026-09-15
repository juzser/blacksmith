import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUILT_IN_HARNESS_POLICY,
  HarnessError,
  type HarnessPolicy,
  loadHarnessPolicy,
  parseHarnessPolicy,
  planWorkerTurn,
  roleAccess,
  summarizeHarnesses,
} from '../src/harness.js';
import { AGENTS_DIR } from '../src/paths.js';
import { loadGuardrailPolicy } from '../src/policy.js';
import { loadTaxonomy } from '../src/taxonomy.js';

// ---------------------------------------------------------------------------
// The worker-harness port.
//
// Two things are being held in place here, and they fail differently:
//
//   - the built-in policy has to keep describing the factory that exists. It
//     is the first written statement that every worker turn runs in-process
//     under Claude Code, and a policy that quietly grew a second harness
//     would be a claim about deployment that no deployment backs.
//   - the judge boundary has to survive the new axis. providers/types.ts
//     already hands an external judge transport nothing but a prompt; a `cli`
//     harness is the same kind of far side, so the same refusal has to hold
//     there, and it has to hold for the roles guardrails.yml calls judges
//     rather than for a list this test or harness.ts keeps of its own.
// ---------------------------------------------------------------------------

const taxonomy = loadTaxonomy();
const guardrails = loadGuardrailPolicy();
const AGENT_ROLES = taxonomy.dimensions.agent ?? [];

/** Every role with a template on disk — the ones an in-process harness can start. */
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

function request(overrides: Record<string, unknown> = {}) {
  return {
    role: 'coder',
    taskId: 'epic-1/task-1',
    promptFile: '/tmp/prompt.md',
    worktree: '/tmp/wt',
    ...overrides,
  } as Parameters<typeof planWorkerTurn>[0];
}

describe('the built-in policy is this factory, written down', () => {
  it('names exactly one harness, and it starts no program', () => {
    expect(BUILT_IN_HARNESS_POLICY.harnesses).toHaveLength(1);
    const only = BUILT_IN_HARNESS_POLICY.harnesses[0];
    expect(only?.name).toBe('claude-code');
    expect(only?.kind).toBe('in-process');
    expect(only?.command).toBeNull();
    expect(BUILT_IN_HARNESS_POLICY.defaultHarness).toBe('claude-code');
    expect(BUILT_IN_HARNESS_POLICY.source).toBe('built-in');
  });

  it('answers when no --policy names a file, because no policy file ships', () => {
    expect(loadHarnessPolicy()).toBe(BUILT_IN_HARNESS_POLICY);
  });

  it('refuses a --policy path that is not there, rather than silently defaulting', () => {
    // A typo'd path that fell back to the built-in policy would run the turn
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
    expect(listing.harnesses).toHaveLength(1);
    const served = [...(listing.harnesses[0]?.roles ?? [])].sort();
    expect(served).toEqual(AGENT_ROLES.filter((r) => TEMPLATED_ROLES.includes(r)).sort());
    expect(served).toContain('coder');
    expect(served).not.toContain('operator');
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
  it('refuses to hand a judge role a worktree path (§18 rule 5)', () => {
    for (const role of guardrails.judgeSandbox.roles) {
      try {
        planWorkerTurn(request({ harness: 'codex-cli', role }), { policy: CLI_POLICY });
        throw new Error(`expected a refusal for ${role}`);
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessError);
        expect((error as HarnessError).code).toBe('harness.judge-worktree');
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

  it('renders the argv exactly, substituting every placeholder', () => {
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

  it('lists a cli harness as serving no judge role', () => {
    const listing = summarizeHarnesses({ policy: CLI_POLICY });
    const codex = listing.harnesses.find((h) => h.name === 'codex-cli');
    expect(codex?.roles ?? []).toContain('coder');
    for (const role of guardrails.judgeSandbox.roles) {
      expect(codex?.roles ?? []).not.toContain(role);
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
      planWorkerTurn(request({ harness: 'codex-cli' }));
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
    ['roles that are not strings', 'harnesses: [{name: a, kind: in-process, roles: [1]}]'],
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
