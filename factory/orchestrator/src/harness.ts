import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { AGENTS_DIR, REPO_ROOT } from './paths.js';
import { type GuardrailPolicy, loadGuardrailPolicy } from './policy.js';
import { loadTaxonomy, type Taxonomy } from './taxonomy.js';

/**
 * The worker harness port: *how* a turn runs, named at last.
 *
 * Every worker turn this factory has ever dispatched ran under one harness —
 * Claude Code's `Agent` tool — and nothing anywhere says so. It is true by
 * accident of deployment: the orchestrator is itself a Claude Code session, so
 * the only thing it can spawn is another one. `dispatch_decision` records the
 * role, the provider, the model tier and the model (P9-23), which is to say it
 * records *who answered* and with *what weight*, and never *what ran the
 * turn*. The two are independent axes and the factory has been folding them
 * into one:
 *
 *   - **provider** — taxonomy.yml `provider: [claude, codex, deepseek]` — is
 *     the vendor whose model produced the words.
 *   - **harness** — this module — is the program that held the session: gave
 *     the agent its tools, its working directory, its turn limit.
 *
 * `claude-code` + `claude` is the only pair that exists today. `codex-cli` +
 * `codex` is the pair that makes the distinction load-bearing, and the point
 * of writing the port before that pair exists is that the second harness
 * should be a config entry and an invocation shape, not a rewrite of dispatch.
 *
 * ## This module renders an invocation. It never runs one.
 *
 * Architecture §18 rule 3 — "nothing that observes may dispatch". `smith` is
 * an observer: it reads logs, folds them, and prints. If `smith harness plan`
 * spawned the process it describes, the CLI would close its own loop, and
 * every check that reads a `dispatch_decision` as evidence that a separate
 * session ran would be reading evidence `smith` produced about itself.
 *
 * So `planWorkerTurn()` returns a `WorkerInvocation` — a description, in JSON,
 * of a process someone else starts. The orchestrator session (or a runner that
 * is not Claude Code at all) reads it and acts. That separation is the whole
 * reason this is a port rather than a spawner.
 *
 * ## The default policy lives here, in code, on purpose
 *
 * There is no `factory/policies/harness.yml`, and this module does not name
 * one. Two reasons, both checkable:
 *
 *   - Writing a policy file is the operator's decision, not a side effect of
 *     adding a seam. The built-in policy below describes what the factory
 *     already does; it invents no capability.
 *   - paths.test.ts holds `factory/policies/` and `paths.ts` to each other in
 *     both directions — a constant with no file on disk fails the build. A
 *     path constant for a file we are not shipping would be exactly that.
 *
 * An operator who wants a second harness writes a YAML file wherever they like
 * and names it: `--policy <file>`, the same shape `stack show` already uses.
 * Absent that flag the built-in policy answers, which is the honest reading of
 * a factory that has one harness.
 *
 * ## A cli harness is outside the trust boundary; a judge gets no worktree
 *
 * `providers/types.ts` states the rule for external judge transports: they are
 * handed nothing but `prompt` — "no worktree paths, credentials beyond its own
 * key, or anything callable". A `cli` harness is the same kind of thing one
 * step over: a process this factory starts, on the far side of its own memory,
 * holding whatever the command line hands it. So the same boundary applies,
 * and `planWorkerTurn()` refuses to render a `cli` invocation that would put a
 * worktree path in a judge role's hands (§18 rule 5, "Judges read; they never
 * gain write access").
 *
 * An `in-process` harness is inside the boundary: a reviewer subagent does
 * read the worktree, under a lease `smith sandbox open` holds for exactly as
 * long as the verdict takes. The invocation says so — `sandboxRequired` is the
 * obligation, stated where the caller will see it rather than left to the
 * playbook to remember.
 *
 * Which roles are judges is not a list this file keeps. It is
 * guardrails.yml's `judge_sandbox.roles` and `role_write_scopes.scopes`, read
 * through policy.ts, which already refuses a role declared as both. A second
 * hand-written copy here would be a copy that drifts, and the direction it
 * would drift in is a judge quietly reclassified as a worker.
 *
 * ## Env is an allowlist of names. Values never pass through here.
 *
 * A harness that shells out needs credentials, and a rendered invocation is
 * printed as JSON to a terminal and into logs. So the invocation carries the
 * *names* a harness may read from the environment and never their values: the
 * runner applies the allowlist against its own `process.env`. Naming a path
 * and never a value is the same rule every artifact in this factory writes
 * under.
 */
export class HarnessError extends SmithError {}

/** The policy shape this module parses. Bumped when the YAML shape changes. */
export const HARNESS_POLICY_VERSION = 1;

/**
 * How a turn is held.
 *
 * `in-process` — the runner spawns a subagent inside its own session, from
 * `.claude/agents/<role>.md`. This is what every turn has always been.
 *
 * `cli` — the runner starts a separate program. Nothing in this repo does yet;
 * the shape exists so that the first one is configuration.
 */
export type HarnessKind = 'in-process' | 'cli';

/**
 * What a rendered invocation is allowed to interpolate. Closed on purpose: a
 * typo'd `{worktre}` in an args template would otherwise reach the runner as a
 * literal argument, and a harness would start in the wrong directory rather
 * than fail to start.
 */
const PLACEHOLDERS = ['prompt_file', 'worktree', 'role', 'task'] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];
const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

export interface HarnessConfig {
  readonly name: string;
  readonly kind: HarnessKind;
  /**
   * The taxonomy `agent` roles this harness serves. Empty means every role —
   * which is the honest default for an in-process harness, because the roles
   * it can run are exactly the ones that ship a template, and that is a fact
   * about `.claude/agents/`, not about the harness.
   */
  readonly roles: readonly string[];
  /** `cli` only; null on an in-process harness, which starts no program. */
  readonly command: string | null;
  /** `cli` only. Placeholders from `PLACEHOLDERS`, substituted at plan time. */
  readonly args: readonly string[];
  /** Environment variable *names* this harness may read. Never values. */
  readonly envAllowlist: readonly string[];
}

export interface HarnessPolicy {
  readonly version: number;
  /** The harness a request that names none gets. */
  readonly defaultHarness: string;
  readonly harnesses: readonly HarnessConfig[];
  /** Where the answer came from, so a surface can say which. */
  readonly source: 'built-in' | 'file';
}

/**
 * Today's factory, written down.
 *
 * One harness, serving every role, starting no program — because the Claude
 * Code `Agent` tool is a call inside the orchestrator's own session, not an
 * exec. `roles: []` rather than the fifteen taxonomy values: the constraint
 * that actually binds is whether `.claude/agents/<role>.md` exists, and
 * `planWorkerTurn()` checks that against the directory rather than against a
 * list here that would go stale the next time a role is added.
 */
export const BUILT_IN_HARNESS_POLICY: HarnessPolicy = Object.freeze({
  version: HARNESS_POLICY_VERSION,
  defaultHarness: 'claude-code',
  harnesses: Object.freeze([
    Object.freeze({
      name: 'claude-code',
      kind: 'in-process' as const,
      roles: Object.freeze([]) as readonly string[],
      command: null,
      args: Object.freeze([]) as readonly string[],
      envAllowlist: Object.freeze([]) as readonly string[],
    }),
  ]) as readonly HarnessConfig[],
  source: 'built-in' as const,
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawHarnessYaml {
  version?: unknown;
  default?: unknown;
  harnesses?: unknown;
}

function invalid(message: string, details?: Record<string, unknown>): HarnessError {
  return new HarnessError('harness.invalid-policy', message, details);
}

function requireStringArray(raw: unknown, key: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw invalid(`harness policy ${key} is not a list of strings.`);
  }
  return raw as string[];
}

/** Every placeholder an args template names, in order of appearance. */
function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string);
}

export function parseHarnessPolicy(yamlText: string): HarnessPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawHarnessYaml;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw invalid('harness policy is not a mapping.');
  }

  const version = doc.version ?? HARNESS_POLICY_VERSION;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw invalid('harness policy `version` is not an integer.');
  }

  const rawHarnesses = doc.harnesses;
  if (!Array.isArray(rawHarnesses) || rawHarnesses.length === 0) {
    throw invalid(
      'harness policy declares no `harnesses`. A file that names none says less than shipping no file at all, which is why the built-in policy is what answers when no --policy is given.',
    );
  }

  const harnesses: HarnessConfig[] = [];
  for (const [index, entry] of rawHarnesses.entries()) {
    const key = `harnesses[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`harness policy ${key} is not a mapping.`);
    }
    const item = entry as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== 'string' || name === '') {
      throw invalid(`harness policy ${key} is missing \`name\`.`);
    }
    if (harnesses.some((h) => h.name === name)) {
      throw invalid(`harness policy declares "${name}" twice.`, { harness: name });
    }
    const kind = item.kind;
    if (kind !== 'in-process' && kind !== 'cli') {
      throw invalid(
        `harness policy ${key} has kind "${String(kind)}"; it is one of in-process, cli.`,
        { harness: name },
      );
    }

    const args = requireStringArray(item.args, `${key}.args`);
    const command = item.command ?? null;
    if (kind === 'cli') {
      if (typeof command !== 'string' || command === '') {
        throw invalid(
          `harness policy ${key} is a cli harness with no \`command\`, so nothing would start.`,
          { harness: name },
        );
      }
    } else if (command !== null) {
      // An in-process harness runs inside the caller's session. A command here
      // would be a line nothing executes, read by the next person as a
      // promise the port does not keep.
      throw invalid(
        `harness policy ${key} is in-process but names a \`command\`; an in-process harness starts no program.`,
        { harness: name },
      );
    }

    for (const arg of args) {
      for (const found of placeholdersIn(arg)) {
        if (!(PLACEHOLDERS as readonly string[]).includes(found)) {
          throw invalid(
            `harness policy ${key}.args names {${found}}, which no invocation substitutes. Known placeholders: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
            { harness: name, placeholder: found },
          );
        }
      }
    }

    harnesses.push({
      name,
      kind,
      roles: requireStringArray(item.roles, `${key}.roles`),
      command: kind === 'cli' ? (command as string) : null,
      args,
      envAllowlist: requireStringArray(item.env, `${key}.env`),
    });
  }

  const declaredDefault = doc.default;
  const defaultHarness =
    declaredDefault === undefined || declaredDefault === null
      ? (harnesses[0] as HarnessConfig).name
      : declaredDefault;
  if (typeof defaultHarness !== 'string' || defaultHarness === '') {
    throw invalid('harness policy `default` is not a harness name.');
  }
  if (!harnesses.some((h) => h.name === defaultHarness)) {
    throw invalid(
      `harness policy names "${defaultHarness}" as the default, and declares no harness by that name.`,
      { harness: defaultHarness },
    );
  }

  return { version, defaultHarness, harnesses, source: 'file' };
}

/**
 * The built-in policy, or the file the caller named.
 *
 * No default path: see the header. An absent `filePath` is not a missing file,
 * it is the statement that this factory runs one harness.
 */
export function loadHarnessPolicy(filePath?: string): HarnessPolicy {
  if (filePath === undefined) return BUILT_IN_HARNESS_POLICY;
  if (!existsSync(filePath)) {
    throw new HarnessError(
      'harness.policy-not-found',
      `No harness policy at ${filePath}. Omit --policy to use the built-in one.`,
      { filePath },
    );
  }
  return parseHarnessPolicy(readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Roles: read out of guardrails.yml, never listed twice
// ---------------------------------------------------------------------------

/**
 * What a role is allowed to do with a worktree, as guardrails.yml already
 * says it.
 *
 * `judge` — `judge_sandbox.roles`: reads under a lease, writes only to
 * `state/results` and `state/artifacts`.
 * `write-scoped` — `role_write_scopes.scopes`: writes, narrowed by globs.
 * `worker` — neither: the roles whose job is to change the tree.
 */
export type RoleAccess = 'judge' | 'write-scoped' | 'worker';

export function roleAccess(
  role: string,
  guardrails: GuardrailPolicy = loadGuardrailPolicy(),
): RoleAccess {
  if (guardrails.judgeSandbox.roles.includes(role)) return 'judge';
  if (guardrails.roleWriteScopes.some((s) => s.role === role)) return 'write-scoped';
  return 'worker';
}

/** Where a role's prompt template lives, and whether it is there. */
function templateFor(role: string, agentsDir: string): { file: string; exists: boolean } {
  const file = path.join(agentsDir, `${role}.md`);
  return { file, exists: existsSync(file) };
}

function serves(harness: HarnessConfig, role: string): boolean {
  return harness.roles.length === 0 || harness.roles.includes(role);
}

// ---------------------------------------------------------------------------
// Planning a turn
// ---------------------------------------------------------------------------

export interface WorkerTurnRequest {
  /** Omit to get the policy's default harness. */
  readonly harness?: string;
  /** A taxonomy `agent` value. */
  readonly role: string;
  readonly taskId: string;
  /** The rendered prompt, already on disk. This module writes no prompts. */
  readonly promptFile: string;
  /** The tree the turn works in, or null for a turn that needs none. */
  readonly worktree?: string | null;
}

export interface HarnessOptions {
  readonly policy?: HarnessPolicy;
  readonly guardrails?: GuardrailPolicy;
  readonly taxonomy?: Taxonomy;
  readonly agentsDir?: string;
}

interface InvocationBase {
  readonly harness: string;
  readonly role: string;
  readonly taskId: string;
  readonly access: RoleAccess;
  readonly promptFile: string;
  readonly worktree: string | null;
  /**
   * True when the caller owes `smith sandbox open` before the turn starts and
   * `smith sandbox close` after the verdict — a judge role that has been given
   * a tree to read. Stated here so a runner that never read wave.md still
   * knows the obligation exists.
   */
  readonly sandboxRequired: boolean;
}

export type WorkerInvocation =
  | (InvocationBase & {
      readonly kind: 'in-process';
      /** The `Agent` tool's `subagent_type`, which is the role. */
      readonly subagentType: string;
      /** Repo-relative, so the invocation reads the same on every machine. */
      readonly template: string;
    })
  | (InvocationBase & {
      readonly kind: 'cli';
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string | null;
      /** Variable names, never values. See the header. */
      readonly envAllowlist: readonly string[];
    });

function substitute(
  template: string,
  values: Partial<Record<Placeholder, string | null>>,
  harness: string,
): string {
  return template.replace(PLACEHOLDER_RE, (_match, token: string) => {
    const value = values[token as Placeholder];
    if (value === undefined || value === null || value === '') {
      throw new HarnessError(
        'harness.missing-substitution',
        `Harness "${harness}" interpolates {${token}}, and this request carries no ${token.replace('_', ' ')}.`,
        { harness, placeholder: token },
      );
    }
    return value;
  });
}

/**
 * Describe the process that would run this turn. Start nothing.
 *
 * Every refusal below is a fact the caller could not have checked cheaply:
 * whether the role exists in the taxonomy, whether a template ships for it,
 * whether the harness serves it, and whether handing it a worktree would cross
 * the judge boundary. A runner that skips this call is not faster — it is
 * making the same four decisions with none of them written down.
 */
export function planWorkerTurn(
  request: WorkerTurnRequest,
  options: HarnessOptions = {},
): WorkerInvocation {
  const policy = options.policy ?? BUILT_IN_HARNESS_POLICY;
  const guardrails = options.guardrails ?? loadGuardrailPolicy();
  const taxonomy = options.taxonomy ?? loadTaxonomy();
  const agentsDir = options.agentsDir ?? AGENTS_DIR;

  const { role, taskId } = request;
  const agentRoles = taxonomy.dimensions.agent ?? [];
  if (!agentRoles.includes(role)) {
    throw new HarnessError(
      'harness.unknown-role',
      `"${role}" is not a taxonomy \`agent\` value, so no dispatch about it could be written even if the turn ran.`,
      { role },
    );
  }
  if (taskId === undefined || taskId === '') {
    throw new HarnessError(
      'harness.missing-task',
      'A worker turn is about a task; the invocation carries its id so the dispatch the caller writes can name the same one.',
      { role },
    );
  }
  if (request.promptFile === undefined || request.promptFile === '') {
    throw new HarnessError(
      'harness.missing-prompt',
      'A worker turn needs a prompt file. This port renders invocations, not prompts — write the prompt first (`smith prompt record`), then plan the turn that carries it.',
      { role },
    );
  }

  const name = request.harness ?? policy.defaultHarness;
  const harness = policy.harnesses.find((h) => h.name === name);
  if (harness === undefined) {
    throw new HarnessError(
      'harness.unknown',
      `No harness named "${name}". This policy declares: ${policy.harnesses.map((h) => h.name).join(', ')}.`,
      { harness: name, declared: policy.harnesses.map((h) => h.name) },
    );
  }
  if (!serves(harness, role)) {
    throw new HarnessError(
      'harness.role-not-served',
      `Harness "${harness.name}" serves ${harness.roles.join(', ')}, and not ${role}.`,
      { harness: harness.name, role },
    );
  }

  const worktree = request.worktree ?? null;
  const access = roleAccess(role, guardrails);
  const base: InvocationBase = {
    harness: harness.name,
    role,
    taskId,
    access,
    promptFile: request.promptFile,
    worktree,
    sandboxRequired: access === 'judge' && worktree !== null,
  };

  if (harness.kind === 'in-process') {
    const template = templateFor(role, agentsDir);
    if (!template.exists) {
      // D-191's reading, applied to the harness rather than to a grant: a
      // role with no template reaches no agent. `operator` is the standing
      // case — taxonomy.yml carries it as a `found_by` for a defect a person
      // read off the code, and it is never dispatched.
      throw new HarnessError(
        'harness.no-template',
        `${role} ships no template at ${path.relative(REPO_ROOT, template.file)}, so an in-process harness has no agent to start.`,
        { role, template: path.relative(REPO_ROOT, template.file) },
      );
    }
    return {
      ...base,
      kind: 'in-process',
      subagentType: role,
      template: path.relative(REPO_ROOT, template.file),
    };
  }

  if (access === 'judge' && worktree !== null) {
    // §18 rule 5, one step out from providers/types.ts. An external process
    // holding a worktree path holds write access to it; no lease this side of
    // the boundary can take that back.
    throw new HarnessError(
      'harness.judge-worktree',
      `Harness "${harness.name}" runs a separate program, and ${role} is a judge role. A judge outside this process gets the prompt and nothing else — a worktree path it holds is write access no sandbox lease can revoke (architecture §18 rule 5).`,
      { harness: harness.name, role },
    );
  }

  const values: Partial<Record<Placeholder, string | null>> = {
    prompt_file: request.promptFile,
    worktree,
    role,
    task: taskId,
  };
  return {
    ...base,
    kind: 'cli',
    command: harness.command as string,
    args: harness.args.map((arg) => substitute(arg, values, harness.name)),
    cwd: worktree,
    envAllowlist: harness.envAllowlist,
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface HarnessSummary {
  readonly name: string;
  readonly kind: HarnessKind;
  readonly isDefault: boolean;
  /** The roles this harness would actually render an invocation for, resolved. */
  readonly roles: readonly string[];
  readonly command: string | null;
  readonly envAllowlist: readonly string[];
}

export interface HarnessListing {
  readonly source: HarnessPolicy['source'];
  readonly version: number;
  readonly defaultHarness: string;
  readonly harnesses: readonly HarnessSummary[];
}

/**
 * What `smith harness list` prints: not the policy as written, but the policy
 * as it resolves. A harness whose `roles` is empty reads as "all" in YAML and
 * means "every role that ships a template" in practice, and the difference
 * between those two is the kind of thing an operator finds out at 2am
 * otherwise.
 */
export function summarizeHarnesses(options: HarnessOptions = {}): HarnessListing {
  const policy = options.policy ?? BUILT_IN_HARNESS_POLICY;
  const taxonomy = options.taxonomy ?? loadTaxonomy();
  const guardrails = options.guardrails ?? loadGuardrailPolicy();
  const agentsDir = options.agentsDir ?? AGENTS_DIR;
  const agentRoles = taxonomy.dimensions.agent ?? [];

  return {
    source: policy.source,
    version: policy.version,
    defaultHarness: policy.defaultHarness,
    harnesses: policy.harnesses.map((harness) => ({
      name: harness.name,
      kind: harness.kind,
      isDefault: harness.name === policy.defaultHarness,
      roles: agentRoles.filter((role) => {
        if (!serves(harness, role)) return false;
        if (harness.kind === 'in-process') return templateFor(role, agentsDir).exists;
        return roleAccess(role, guardrails) !== 'judge';
      }),
      command: harness.command,
      envAllowlist: harness.envAllowlist,
    })),
  };
}
