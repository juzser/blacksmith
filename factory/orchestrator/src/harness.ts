import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type BudgetPolicy, loadBudgetPolicy } from './budgets.js';
import { SmithError } from './errors.js';
import { AGENTS_DIR, HARNESS_POLICY_PATH, REPO_ROOT } from './paths.js';
import { type GuardrailPolicy, INSPECTED_FILE_TOOLS, loadGuardrailPolicy } from './policy.js';
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
 * `claude-code` + `claude` was the only pair that existed when this port was
 * written. `codex-cli` + `codex` and `claude-cli` + `claude` are the pairs
 * that make the distinction load-bearing, and they are why the second and
 * third harnesses are config entries and an invocation shape, not a rewrite
 * of dispatch.
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
 * of a process someone else starts. `smith-run` (src/run-cli.ts) is that
 * someone else for a `cli` invocation: a separate executable that spawns the
 * program a `WorkerInvocation` describes and prints what happened, and opens
 * neither the event log nor the database, because starting a program and
 * observing what a session did are different jobs and this factory keeps
 * them in different binaries. The orchestrator session still writes the
 * event that records the turn — `smith-run` running one is not that turn
 * closing its own loop, any more than `codex` or `claude` running one is.
 *
 * ## The shipped policy lives in factory/policies/harness.yml
 *
 * It used to live here, in code, as a single frozen `HarnessConfig` this
 * module exported directly — the honest reading of a factory with exactly
 * one harness. That stopped being honest the day a second and third harness
 * needed declaring: a `BUILT_IN_HARNESS_POLICY` object and a shipped YAML
 * file would have said the same thing twice, in two languages, and the copy
 * that goes stale is never the one someone is looking at. So the code copy is
 * gone; `HARNESS_POLICY_PATH` (paths.ts) names the file that answers when
 * `--policy` is not given, and `source: 'default'` on the result says which
 * one that was.
 *
 * `--policy <file>` still overrides it, the same shape `stack show` uses.
 * paths.test.ts holds `factory/policies/` and `paths.ts` to each other in
 * both directions — a constant with no file on disk fails the build, and a
 * policy file with no constant does too. `harness.yml` and
 * `HARNESS_POLICY_PATH` had to land together for that reason.
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
 * gain write access") — *unless* the harness itself declares `judge_args`:
 * arguments that put the program into a mode where it cannot write, enforced
 * by the OS or the tool itself rather than by this factory (codex's
 * `-s read-only`, claude's `--disallowedTools Write,Edit,...`). That is not a
 * weaker promise than the in-process path's sandbox lease — it is a
 * differently-shaped one. An in-process judge runs under guard.sh with a
 * Bash tool in hand, and the lease is what stops it from writing; a cli judge
 * whose `judge_args` this factory has read as read-only never has the ability
 * to write at all, which a lease revocation cannot improve on. Rule 6's
 * fingerprint-before-and-after still runs either way, because a read-only
 * flag is what the harness promises, not what this factory has watched
 * happen. `judge_args` that do not read as read-only — absent, or present
 * and spent on something else — mean the harness makes no such promise, and
 * the refusal stands as before. Which flags read that way, for which
 * program, is declared at `judgeReadOnly` below; it is the one thing about
 * this escape valve that must not be taken on trust.
 *
 * `schema_args` is a smaller instance of the same shape: arguments appended
 * only when the request resolved a schema, so a turn that validates nothing
 * renders without them and a harness never carries an unconditional
 * `--output-schema` a schema-less turn cannot fill in.
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
export const HARNESS_POLICY_VERSION = 2;

/**
 * How a turn is held.
 *
 * `in-process` — the runner spawns a subagent inside its own session, from
 * `.claude/agents/<role>.md`. This is what every turn has always been.
 *
 * `cli` — the runner starts a separate program. `smith-run` is the runner;
 * this module only ever describes the process, never starts it.
 */
export type HarnessKind = 'in-process' | 'cli';

/** taxonomy.yml `model_tier: [frontier, mid, small]`, restated as a type. */
export type ModelTier = 'frontier' | 'mid' | 'small';
const MODEL_TIERS: readonly ModelTier[] = ['frontier', 'mid', 'small'];

/** `text` (default) leaves the raw output alone; the other two parse a known program's shape. */
export type HarnessOutputMode = 'text' | 'codex-json' | 'claude-json';
const OUTPUT_MODES: readonly HarnessOutputMode[] = ['text', 'codex-json', 'claude-json'];

/**
 * What a rendered invocation is allowed to interpolate. Closed on purpose: a
 * typo'd `{worktre}` in an args template would otherwise reach the runner as a
 * literal argument, and a harness would start in the wrong directory rather
 * than fail to start.
 */
const PLACEHOLDERS = ['prompt_file', 'worktree', 'role', 'task', 'model', 'schema_file'] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];
const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/** Per-harness output-size cap when the policy declares none: 2 MiB. */
export const HARNESS_DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

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
  /** Appended after `args` when the role being planned is a worker or write-scoped role. `cli` only. */
  readonly workerArgs: readonly string[];
  /** Appended after `args` when the role being planned is a judge. `cli` only, and the read-only escape valve — see the header. */
  readonly judgeArgs: readonly string[];
  /** Appended last, and only when the request resolved a schema (`--schema`). `cli` only — see the header. */
  readonly schemaArgs: readonly string[];
  /** Environment variable *names* this harness may read. Never values. */
  readonly envAllowlist: readonly string[];
  /** How the runner reads this harness's output. `in-process` harnesses ignore this. */
  readonly output: HarnessOutputMode;
  /** tier -> model id, for a harness whose `args` names `{model}`. Empty when the harness routes its own tiers (codex-cli ships none — see harness.yml). */
  readonly models: Partial<Record<ModelTier, string>>;
  /** Wall-clock budget in ms, or null when the policy declares none. */
  readonly timeoutMs: number | null;
  /** Output-size cap in bytes, or null to defer to HARNESS_DEFAULT_MAX_OUTPUT_BYTES. */
  readonly maxOutputBytes: number | null;
}

export interface HarnessPolicy {
  readonly version: number;
  /** The harness a request that names none gets. */
  readonly defaultHarness: string;
  readonly harnesses: readonly HarnessConfig[];
  /** Where the answer came from, so a surface can say which. */
  readonly source: 'default' | 'file';
}

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

function checkPlaceholders(args: readonly string[], key: string, name: string): void {
  for (const arg of args) {
    for (const found of placeholdersIn(arg)) {
      if (!(PLACEHOLDERS as readonly string[]).includes(found)) {
        throw invalid(
          `harness policy ${key} names {${found}}, which no invocation substitutes. Known placeholders: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
          { harness: name, placeholder: found },
        );
      }
    }
  }
}

function parseOutput(raw: unknown, key: string, name: string): HarnessOutputMode {
  if (raw === undefined || raw === null) return 'text';
  if (typeof raw !== 'string' || !(OUTPUT_MODES as readonly string[]).includes(raw)) {
    throw invalid(
      `harness policy ${key} has output "${String(raw)}"; it is one of ${OUTPUT_MODES.join(', ')}.`,
      { harness: name },
    );
  }
  return raw as HarnessOutputMode;
}

function parseModels(raw: unknown, key: string, name: string): Partial<Record<ModelTier, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`harness policy ${key} is not a mapping of tier to model id.`, { harness: name });
  }
  const models: Partial<Record<ModelTier, string>> = {};
  for (const [tier, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
      throw invalid(
        `harness policy ${key} names tier "${tier}"; it is one of ${MODEL_TIERS.join(', ')}.`,
        { harness: name, tier },
      );
    }
    if (typeof value !== 'string' || value === '') {
      throw invalid(`harness policy ${key}.${tier} is not a model id.`, { harness: name, tier });
    }
    models[tier as ModelTier] = value;
  }
  return models;
}

function parsePositiveIntOrNull(raw: unknown, key: string, name: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw invalid(`harness policy ${key} must be a positive number; got ${JSON.stringify(raw)}.`, {
      harness: name,
    });
  }
  return raw;
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
      'harness policy declares no `harnesses`. A file that names none says less than shipping no file at all, which is why the shipped policy is what answers when no --policy is given.',
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
    const workerArgs = requireStringArray(item.worker_args, `${key}.worker_args`);
    const judgeArgs = requireStringArray(item.judge_args, `${key}.judge_args`);
    const schemaArgs = requireStringArray(item.schema_args, `${key}.schema_args`);
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

    checkPlaceholders(args, `${key}.args`, name);
    checkPlaceholders(workerArgs, `${key}.worker_args`, name);
    checkPlaceholders(judgeArgs, `${key}.judge_args`, name);
    checkPlaceholders(schemaArgs, `${key}.schema_args`, name);

    harnesses.push({
      name,
      kind,
      roles: requireStringArray(item.roles, `${key}.roles`),
      command: kind === 'cli' ? (command as string) : null,
      args,
      workerArgs,
      judgeArgs,
      schemaArgs,
      envAllowlist: requireStringArray(item.env, `${key}.env`),
      output: parseOutput(item.output, `${key}.output`, name),
      models: parseModels(item.models, `${key}.models`, name),
      timeoutMs: parsePositiveIntOrNull(item.timeout_ms, `${key}.timeout_ms`, name),
      maxOutputBytes: parsePositiveIntOrNull(
        item.max_output_bytes,
        `${key}.max_output_bytes`,
        name,
      ),
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
 * The shipped policy (factory/policies/harness.yml), or the file the caller
 * named.
 *
 * No caching: every call re-reads and re-parses, the same choice
 * loadBudgetPolicy makes, so an operator editing `--policy <file>` between
 * two `smith harness plan` calls in the same process sees the edit.
 */
export function loadHarnessPolicy(filePath?: string): HarnessPolicy {
  if (filePath === undefined) {
    return { ...parseHarnessPolicy(readFileSync(HARNESS_POLICY_PATH, 'utf8')), source: 'default' };
  }
  if (!existsSync(filePath)) {
    throw new HarnessError(
      'harness.policy-not-found',
      `No harness policy at ${filePath}. Omit --policy to use the shipped one.`,
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

const TIER_BY_TEMPLATE_MODEL: Readonly<Record<string, ModelTier>> = Object.freeze({
  opus: 'frontier',
  sonnet: 'mid',
  haiku: 'small',
});

function modelLineOf(markdown: string): string | null {
  const line = markdown.split('\n').find((l) => l.startsWith('model:'));
  if (line === undefined) return null;
  const value = line.slice('model:'.length).trim();
  return value === '' ? null : value;
}

/**
 * Tier, when the request names none: read off the role template's own
 * frontmatter `model:` line and fold the model id it names (`opus`, `sonnet`,
 * `haiku`) through the tier taxonomy.yml's `model_tier` already gives that
 * vendor's weight class. PR 2 moves role templates to `factory/agents/` with
 * a `tier:` field of their own, which retires this mapping in favor of
 * reading it directly — this is the bridge until then, not a second source of
 * truth meant to outlive it.
 */
function tierFromTemplate(templateFile: string): ModelTier | null {
  if (!existsSync(templateFile)) return null;
  const model = modelLineOf(readFileSync(templateFile, 'utf8'));
  return model === null ? null : (TIER_BY_TEMPLATE_MODEL[model] ?? null);
}

const SCHEMA_DIR = path.join(REPO_ROOT, 'factory', 'specs', 'schema');
const SCHEMA_SUFFIX = '.schema.json';

/** `factory/specs/schema/<name>.schema.json`, checked against what actually ships. */
function resolveSchema(
  name: string | null | undefined,
  harnessName: string,
): { name: string; file: string } | null {
  if (name === undefined || name === null || name === '') return null;
  const file = path.join(SCHEMA_DIR, `${name}${SCHEMA_SUFFIX}`);
  if (!existsSync(file)) {
    const known = readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith(SCHEMA_SUFFIX))
      .map((f) => f.slice(0, -SCHEMA_SUFFIX.length))
      .sort();
    throw new HarnessError(
      'harness.unknown-schema',
      `Harness "${harnessName}" was asked to validate against schema "${name}", and factory/specs/schema/ ships no ${name}${SCHEMA_SUFFIX}. It ships: ${known.join(', ')}.`,
      { harness: harnessName, schema: name, known },
    );
  }
  return { name, file };
}

function capTokensFor(role: string, access: RoleAccess, budgets: BudgetPolicy): number | null {
  // Only these three named roles carry a cap in budgets.yml today — every
  // other role (security-reviewer, merger, tester, uiux, planner, scribe)
  // has none, and null says so rather than inventing a number nobody set.
  if (access === 'judge') return budgets.task.judges.capTokens;
  if (role === 'coder') return budgets.task.coder.capTokens;
  if (role === 'researcher') return budgets.task.researcher.capTokens;
  return null;
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
  /** Overrides the tier this port would otherwise derive from the role template's `model:` line. */
  readonly tier?: ModelTier;
  /** A name under factory/specs/schema/ to validate the answer against; omit to skip validation. */
  readonly schema?: string | null;
}

export interface HarnessOptions {
  readonly policy?: HarnessPolicy;
  readonly guardrails?: GuardrailPolicy;
  readonly taxonomy?: Taxonomy;
  readonly agentsDir?: string;
  readonly budgets?: BudgetPolicy;
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

/** `cli` only: the per-turn spend this invocation should not exceed. Snake_case, matching providers/types.ts's JudgeBudget. */
export interface HarnessBudget {
  readonly timeout_ms: number | null;
  readonly max_output_bytes: number;
  readonly cap_tokens: number | null;
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
      /** Repo-relative `.claude/agents/<role>.md`; smith-run prepends its body (frontmatter stripped) to the prompt on stdin. */
      readonly template: string;
      /** How smith-run should read this program's output. */
      readonly output: HarnessOutputMode;
      /** Resolved model id for `{model}`, or null when the harness names no model for this tier. */
      readonly model: string | null;
      /** From the request, or derived from the role template's `model:` line. Null when neither resolves. */
      readonly tier: ModelTier | null;
      /** Schema name the answer is validated against, or null when the request set none. */
      readonly schema: string | null;
      /** The only mode a cli harness reads a prompt in: the whole rendered turn, on stdin. */
      readonly stdin: 'prompt';
      readonly budget: HarnessBudget;
    });

function substitute(
  template: string,
  values: Partial<Record<Placeholder, string | null>>,
  harness: string,
): string {
  return template.replace(PLACEHOLDER_RE, (_match, token: string) => {
    const value = values[token as Placeholder];
    if (value === undefined || value === null || value === '') {
      const hint = token === 'schema_file' ? ' — pass --schema <name>' : '';
      throw new HarnessError(
        'harness.missing-substitution',
        `Harness "${harness}" interpolates {${token}}, and this request carries no ${token.replace('_', ' ')}${hint}.`,
        { harness, placeholder: token },
      );
    }
    return value;
  });
}

/**
 * Whether a `cli` harness's `judge_args` actually put the program in a mode
 * where it cannot write — and when they do not, which part is missing.
 *
 * `judge_args` is §18 rule 5's escape valve, and what it is supposed to
 * carry is specific: flags that make writing impossible, enforced by the OS
 * or the tool. What this file checked was whether the array was empty.
 * `judge_args: ["-m", "gpt-5-high"]` is not empty, and a reviewer planned
 * against it came back with `exec -C <worktree>` and codex's *default*,
 * writable sandbox — the whole of rule 5 spent on a model flag. A promise
 * nobody reads is not a promise; it is a length.
 *
 * So the flags are declared here, per program, and every other shape of
 * `judge_args` falls where an empty one already fell. That refusal is not a
 * new one: it is rule 5's, now reaching the configurations that only looked
 * like a promise. A harness whose read-only flag this factory cannot read
 * still runs every worker role, and still serves judges — without a worktree
 * in hand, which is what the refusal has always said.
 *
 * Adding a program below means checking what read-only means for it, not
 * trusting the name.
 */
type JudgeReadOnly =
  | { readonly promised: true; readonly flag: string }
  | { readonly promised: false; readonly reason: string };

/** `--flag value` or `--flag=value`. The last occurrence wins, as an argv does. */
function flagValue(args: readonly string[], names: readonly string[]): string | null {
  let found: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    for (const name of names) {
      if (arg === name) {
        const next = args[i + 1];
        if (next !== undefined) found = next;
      } else if (arg.startsWith(`${name}=`)) {
        found = arg.slice(name.length + 1);
      }
    }
  }
  return found;
}

/**
 * A Map rather than an object literal on purpose: the key is a program name
 * read off a policy file, and `Object.prototype` answers to several of them.
 */
const READ_ONLY_JUDGE_FLAGS = new Map<string, (args: readonly string[]) => JudgeReadOnly>([
  // codex brings its own sandbox: `read-only` is enforced by the OS, so the
  // worktree path the process holds is a path it can only read.
  [
    'codex',
    (args) => {
      const sandbox = flagValue(args, ['-s', '--sandbox']);
      if (sandbox === 'read-only') return { promised: true, flag: '-s read-only' };
      return {
        promised: false,
        reason:
          sandbox === null
            ? 'its judge_args name no `-s read-only`'
            : `its judge_args ask for the \`${sandbox}\` sandbox, which is not read-only`,
      };
    },
  ],
  // claude has no filesystem sandbox to ask for; it has the tools it is
  // given. Denying every tool that writes a file is the same promise by a
  // different mechanism — and which tools those are is policy.ts's roster,
  // read from there rather than typed again here.
  [
    'claude',
    (args) => {
      const denied = flagValue(args, ['--disallowedTools']);
      if (denied === null) {
        return { promised: false, reason: 'its judge_args name no `--disallowedTools`' };
      }
      const names = new Set(denied.split(',').map((name) => name.trim()));
      const left = INSPECTED_FILE_TOOLS.filter((tool) => !names.has(tool));
      if (left.length === 0) return { promised: true, flag: `--disallowedTools ${denied}` };
      return {
        promised: false,
        reason: `its judge_args leave ${left.join(', ')} in the judge's hands`,
      };
    },
  ],
]);

function judgeReadOnly(harness: HarnessConfig): JudgeReadOnly {
  if (harness.judgeArgs.length === 0) {
    return { promised: false, reason: 'it declares no judge_args at all' };
  }
  const program = harness.command === null ? '' : path.basename(harness.command);
  const recognise = READ_ONLY_JUDGE_FLAGS.get(program);
  if (recognise === undefined) {
    const known = [...READ_ONLY_JUDGE_FLAGS.keys()].join(' and ');
    return {
      promised: false,
      reason: `this factory cannot read a read-only flag for \`${program}\` (it reads ${known})`,
    };
  }
  return recognise(harness.judgeArgs);
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
  const policy = options.policy ?? loadHarnessPolicy();
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
  if (request.tier !== undefined && !(MODEL_TIERS as readonly string[]).includes(request.tier)) {
    throw new HarnessError(
      'harness.unknown-tier',
      `"${request.tier}" is not a model tier. It is one of ${MODEL_TIERS.join(', ')}.`,
      { tier: request.tier },
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

  // A template is required to start an agent under either kind: an in-process
  // harness reads it directly, and a cli harness's runner prepends its body
  // to the prompt on stdin (see WorkerInvocation.template). No template, no
  // agent to start, regardless of which program would have started it.
  const template = templateFor(role, agentsDir);
  if (!template.exists) {
    // D-191's reading, applied to the harness rather than to a grant: a
    // role with no template reaches no agent. `operator` is the standing
    // case — taxonomy.yml carries it as a `found_by` for a defect a person
    // read off the code, and it is never dispatched.
    throw new HarnessError(
      'harness.no-template',
      `${role} ships no template at ${path.relative(REPO_ROOT, template.file)}, so no harness has an agent to start.`,
      { role, template: path.relative(REPO_ROOT, template.file) },
    );
  }
  const templateRelative = path.relative(REPO_ROOT, template.file);

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
    return {
      ...base,
      kind: 'in-process',
      subagentType: role,
      template: templateRelative,
    };
  }

  const readOnly = access === 'judge' && worktree !== null ? judgeReadOnly(harness) : null;
  if (readOnly !== null && !readOnly.promised) {
    // §18 rule 5, one step out from providers/types.ts. An external process
    // holding a worktree path holds write access to it; no lease this side of
    // the boundary can take that back — unless the harness's own policy entry
    // declares judge_args that are read-only and not merely present. See the
    // header.
    throw new HarnessError(
      'harness.judge-worktree',
      `Harness "${harness.name}" runs a separate program, and ${role} is a judge role. A judge outside this process gets the prompt and nothing else — a worktree path it holds is write access no sandbox lease can revoke (architecture §18 rule 5). ${harness.name} could still serve ${role} a worktree if its policy entry declared judge_args that make the program read-only, but ${readOnly.reason}.`,
      { harness: harness.name, role, reason: readOnly.reason },
    );
  }

  const tier: ModelTier | null = request.tier ?? tierFromTemplate(template.file);
  const model: string | null = tier !== null ? (harness.models[tier] ?? null) : null;
  const schema = resolveSchema(request.schema, harness.name);

  const values: Partial<Record<Placeholder, string | null>> = {
    prompt_file: request.promptFile,
    worktree,
    role,
    task: taskId,
    model,
    schema_file: schema?.file ?? null,
  };

  const roleArgs = access === 'judge' ? harness.judgeArgs : harness.workerArgs;
  const rawArgs = [...harness.args, ...roleArgs, ...(schema !== null ? harness.schemaArgs : [])];
  const args = rawArgs.map((arg) => substitute(arg, values, harness.name));

  const budgets = options.budgets ?? loadBudgetPolicy();
  const budget: HarnessBudget = {
    timeout_ms: harness.timeoutMs,
    max_output_bytes: harness.maxOutputBytes ?? HARNESS_DEFAULT_MAX_OUTPUT_BYTES,
    cap_tokens: capTokensFor(role, access, budgets),
  };

  return {
    ...base,
    kind: 'cli',
    command: harness.command as string,
    args,
    cwd: worktree,
    envAllowlist: harness.envAllowlist,
    template: templateRelative,
    output: harness.output,
    model,
    tier,
    schema: schema?.name ?? null,
    stdin: 'prompt',
    budget,
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
  readonly output: HarnessOutputMode;
  readonly models: Partial<Record<ModelTier, string>>;
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
  const policy = options.policy ?? loadHarnessPolicy();
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
        if (!templateFor(role, agentsDir).exists) return false;
        if (roleAccess(role, guardrails) === 'judge') {
          return harness.kind === 'in-process' || judgeReadOnly(harness).promised;
        }
        return true;
      }),
      command: harness.command,
      envAllowlist: harness.envAllowlist,
      output: harness.output,
      models: harness.models,
    })),
  };
}
