import { readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { runGit } from './git.js';
import { GUARDRAILS_POLICY_PATH, REPO_ROOT } from './paths.js';
import type { SandboxLease } from './sandbox.js';

/**
 * Blacksmith's guard hook, moved off bash-and-regex-in-a-shell-script and
 * onto data (factory/policies/guardrails.yml) plus tested TypeScript
 * (here). `.claude/hooks/guard.sh` used to hold both: the rule content
 * (branch names, allowed roots, the message an agent sees) tangled together
 * with the matcher that decided whether a given command tripped it, and
 * neither half had a test. This module is the matcher half — every function
 * below is a direct, behaviour-preserving port of one piece of guard.sh, and
 * each one is exercised in test/policy.test.ts. Two things bash could not do
 * well are fixed in the port, not added to it: path normalization for the
 * `rm -rf` rule uses `path.resolve`/`path.relative` instead of shelling out
 * to `realpath -m` (which does not exist on every platform this runs on),
 * and that same normalization is `path.sep`-aware rather than bash's
 * `/`-only `case` glob — see `normalizeRemovalPath`.
 *
 * `smith policy check` and `smith policy hook` (cli.ts) are the two CLI
 * callers, both routed through `hookDecision.ts`; `.claude/hooks/guard.sh`
 * execs `dist/policyHook.js`, an entry point over that same decision whose
 * import graph is only what deciding needs.
 */
export class PolicyError extends SmithError {}

// ---------------------------------------------------------------------------
// guardrails.yml — parsed shape
// ---------------------------------------------------------------------------

export interface DeployCommandSpec {
  readonly command: string;
  readonly subcommands: readonly string[];
}

/**
 * The judge sandbox's data half (guardrails.yml `judge_sandbox`). These
 * rules apply only while a lease is open over the directory a command will
 * run in — see sandbox.ts for why a lease exists at all, and guardrails.yml
 * for why the lists are deliberately generous.
 */
export interface JudgeSandboxPolicy {
  /**
   * The roles this rule set is written for. A lease is matched to a rule set
   * by role, and an undeclared role falls back to *this* one — so the list
   * is not a gate, it is documentation plus the vocabulary
   * `smith sandbox open --role` validates against.
   */
  readonly roles: readonly string[];
  /** Repo-root-relative path prefixes a judge may write into, posix-separated as written in YAML. */
  readonly writeRoots: readonly string[];
  readonly networkCommands: readonly string[];
  readonly networkSubcommands: readonly DeployCommandSpec[];
  /** Write verbs whose every non-flag argument is a target, allowed when all of them are under a write root. */
  readonly targetWriteCommands: readonly string[];
  /** Write verbs refused outright, with no path check. */
  readonly refusedWriteCommands: readonly string[];
  readonly gitWriteSubcommands: readonly string[];
}

/**
 * A role that writes, but not everywhere (guardrails.yml `role_write_scopes`).
 *
 * The judge sandbox says "this role writes nothing", which is the whole
 * answer for a reviewer. It is no answer at all for a tester: a tester's job
 * is to write tests, and the isolation that matters is that it must not
 * write the implementation it is grading. Same lease machinery, a different
 * rule selected by role.
 */
export interface RoleWriteScope {
  readonly role: string;
  /** Repo-root-relative globs (picomatch, posix separators) this role may write. */
  readonly writeGlobs: readonly string[];
  /** Write verbs refused outright, because which of their tokens is the target is undecidable. */
  readonly refusedCommands: readonly string[];
  /** git subcommands that change tracked content without passing through a path-checked write. */
  readonly refusedGitSubcommands: readonly string[];
}

export interface GuardrailRule {
  readonly id: string;
  readonly severity: string;
  readonly reason: string;
  /**
   * The message for the "bare push/merge while already checked out on a
   * protected branch" trigger (rules push-to-protected, merge-into-protected
   * only) — `null` for every rule that has only one trigger. `{branch}` in
   * either message is a template placeholder, substituted by `renderBranch`
   * at decision time; it is not meant to be shown to anyone literally.
   */
  readonly reasonOnCurrentBranch: string | null;
}

export interface GuardrailPolicy {
  readonly protectedBranchNames: readonly string[];
  readonly protectedBranchPatterns: readonly string[];
  /** Remotes a protected branch may fast-forward itself to — rule 3's one exception. */
  readonly catchUpRemotes: readonly string[];
  readonly allowedRemovalRoots: readonly string[];
  readonly deployCommands: readonly DeployCommandSpec[];
  readonly judgeSandbox: JudgeSandboxPolicy;
  /** Roles whose lease narrows their writes to a glob set instead of forbidding writes outright. */
  readonly roleWriteScopes: readonly RoleWriteScope[];
  /** Keyed by rule id — exactly `EVALUATED_RULE_IDS`, no fewer and no more. */
  readonly rules: ReadonlyMap<string, GuardrailRule>;
}

interface RawGuardrailsYaml {
  protected_branches?: { names?: unknown; patterns?: unknown };
  catch_up_remotes?: unknown;
  destructive_removal?: { allowed_roots?: unknown };
  deploy_commands?: unknown;
  judge_sandbox?: {
    roles?: unknown;
    write_roots?: unknown;
    network_commands?: unknown;
    network_subcommands?: unknown;
    target_write_commands?: unknown;
    refused_write_commands?: unknown;
    git_write_subcommands?: unknown;
    rules?: unknown;
  };
  role_write_scopes?: { scopes?: unknown; rules?: unknown };
  rules?: unknown;
}

/**
 * The six rules guard.sh has always enforced, plus the three the judge
 * sandbox adds. `parseGuardrailPolicy` rejects a guardrails.yml missing any
 * of these outright, rather than silently loading a policy with fewer rules
 * than the file that shipped it — a guard-hook rule that fails to load is
 * not "off by default", it is a hole. The judge rules are required on the
 * same terms even though they fire only under a lease: a policy file that
 * cannot name them is a policy file that would run judges unguarded and
 * report nothing wrong. `role-write-scope` is required for the mirror of
 * that reason: it is the mechanism that keeps a tester out of the code it is
 * grading, and a policy that cannot name it either blocks the tester
 * entirely or lets it mark its own homework.
 *
 * The list is closed in both directions. Every id here must appear in
 * guardrails.yml, for the reasons above; and every id guardrails.yml declares
 * must appear here, because a rule is a row in that file *plus* a branch in
 * this one that looks the row up. A row with no branch parses, counts and
 * prints like the others and enforces nothing — the file says the door is
 * shut and no one is standing at it. So the name is what the evaluator
 * consults, not what the file happens to carry, and `GuardrailRuleId` below
 * makes the compiler hold every `requireRule`/`sandboxViolation` call site to
 * it. What no type can check is a stale entry — an id left here after its
 * branch was deleted — so policy.test.ts scrapes the call sites back out of
 * this file and holds them against the list.
 */
export const EVALUATED_RULE_IDS = [
  'push-to-protected',
  'force-push',
  'merge-into-protected',
  'deploy-command',
  'history-rewrite-on-protected',
  'unbounded-rm',
  'judge-network',
  'judge-write',
  'judge-sandbox-escape',
  'role-write-scope',
] as const;

/** A rule id this evaluator actually consults. Anything else is not a rule, just a row. */
export type GuardrailRuleId = (typeof EVALUATED_RULE_IDS)[number];

const EVALUATED_RULE_ID_SET: ReadonlySet<string> = new Set(EVALUATED_RULE_IDS);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!isStringArray(value)) {
    throw new PolicyError(
      'policy.invalid-document',
      `guardrails.yml is missing ${key} (a string list).`,
      { key },
    );
  }
  return value;
}

/**
 * `deploy_commands` and `judge_sandbox.network_subcommands` are the same
 * shape — a command word plus the subcommands that make it matter — so they
 * parse through one function rather than two copies that drift.
 */
function parseCommandSpecs(raw: unknown, key: string): DeployCommandSpec[] {
  if (!Array.isArray(raw)) {
    throw new PolicyError('policy.invalid-document', `guardrails.yml is missing ${key} (a list).`, {
      key,
    });
  }
  return raw.map((entry, index) => {
    const e = entry as { command?: unknown; subcommands?: unknown };
    if (typeof e.command !== 'string' || !isStringArray(e.subcommands)) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml ${key}[${index}] needs a string "command" and a string-list "subcommands".`,
        { key, index },
      );
    }
    return { command: e.command, subcommands: e.subcommands };
  });
}

/**
 * Fold one `rules:` list into the shared id-keyed map, used for the top-level
 * list and the two block-level ones. `declaredIn` remembers which block each
 * id came from, so a second definition can be refused by name rather than
 * overwriting the first: the folds run in source order, and a plain `set`
 * would leave the last block read holding the rule while the file still reads
 * as if the first one did.
 */
function collectRules(
  raw: unknown,
  into: Map<string, GuardrailRule>,
  declaredIn: Map<string, string>,
  key: string,
): void {
  if (!Array.isArray(raw)) {
    throw new PolicyError('policy.invalid-document', `guardrails.yml is missing ${key} (a list).`, {
      key,
    });
  }
  for (const entry of raw) {
    const r = entry as {
      id?: unknown;
      severity?: unknown;
      reason?: unknown;
      reason_on_current_branch?: unknown;
    };
    if (
      typeof r.id !== 'string' ||
      typeof r.severity !== 'string' ||
      typeof r.reason !== 'string'
    ) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml has a rule in ${key} missing a string id/severity/reason.`,
        { key, rule: entry },
      );
    }
    const already = declaredIn.get(r.id);
    if (already !== undefined) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml declares rule "${r.id}" in both ${already} and ${key}; a rule gets one definition, not two.`,
        { rule: r.id, declaredIn: already, redeclaredIn: key },
      );
    }
    declaredIn.set(r.id, key);
    into.set(r.id, {
      id: r.id,
      severity: r.severity,
      reason: r.reason,
      reasonOnCurrentBranch:
        typeof r.reason_on_current_branch === 'string' ? r.reason_on_current_branch : null,
    });
  }
}

/**
 * Parse guardrails.yml. Throws `PolicyError` on anything short of the full
 * shape — a guard-hook policy file with a typo'd key must fail loudly, not
 * load as a policy with an empty `rules` map that denies nothing.
 */
/**
 * `role_write_scopes.scopes` — one entry per role that writes under a lease.
 *
 * A role declared here must not also be a judge role: the two rule sets are
 * selected by role, so an overlap is a question with no answer, and guessing
 * one silently is exactly the kind of quiet mis-enforcement this whole
 * module exists to end.
 */
function parseRoleWriteScopes(raw: unknown, judgeRoles: readonly string[]): RoleWriteScope[] {
  if (!Array.isArray(raw)) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml is missing role_write_scopes.scopes (a list of role scopes).',
    );
  }
  const scopes: RoleWriteScope[] = [];
  for (const [index, entry] of raw.entries()) {
    const key = `role_write_scopes.scopes[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new PolicyError('policy.invalid-document', `guardrails.yml ${key} is not a mapping.`);
    }
    const item = entry as Record<string, unknown>;
    const role = item.role;
    if (typeof role !== 'string' || role === '') {
      throw new PolicyError('policy.invalid-document', `guardrails.yml ${key} is missing role.`);
    }
    if (judgeRoles.includes(role)) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml declares "${role}" as both a judge role and a write-scoped role; a role gets one rule set, not two.`,
        { role },
      );
    }
    if (scopes.some((s) => s.role === role)) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml declares role "${role}" twice under role_write_scopes.scopes.`,
        { role },
      );
    }
    const writeGlobs = requireStringArray(item.write_globs, `${key}.write_globs`);
    if (writeGlobs.length === 0) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml ${key}.write_globs is empty; a scope that permits nothing blocks the role instead of bounding it.`,
        { role },
      );
    }
    scopes.push({
      role,
      writeGlobs,
      refusedCommands: requireStringArray(item.refused_commands, `${key}.refused_commands`),
      refusedGitSubcommands: requireStringArray(
        item.refused_git_subcommands,
        `${key}.refused_git_subcommands`,
      ),
    });
  }
  return scopes;
}

/** What `catch_up_remotes` means when guardrails.yml does not say — the strict reading. */
const DEFAULT_CATCH_UP_REMOTES: readonly string[] = ['origin'];

export function parseGuardrailPolicy(yamlText: string): GuardrailPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawGuardrailsYaml;

  const names = doc.protected_branches?.names;
  if (!isStringArray(names)) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml is missing protected_branches.names (a string list).',
    );
  }
  const patterns = doc.protected_branches?.patterns;
  if (!isStringArray(patterns)) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml is missing protected_branches.patterns (a string list).',
    );
  }
  // The one optional key in this file. Every other field throws when it is
  // missing, because a policy that silently loses a rule is worse than one
  // that refuses to load — but this key only ever *narrows* rule 3, and a
  // guardrails.yml written before it existed should keep working. Absent
  // means the strict reading, not the permissive one.
  const catchUpRemotes = doc.catch_up_remotes ?? DEFAULT_CATCH_UP_REMOTES;
  if (!isStringArray(catchUpRemotes)) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml has a catch_up_remotes that is not a string list.',
    );
  }
  const allowedRoots = doc.destructive_removal?.allowed_roots;
  if (!isStringArray(allowedRoots)) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml is missing destructive_removal.allowed_roots (a string list).',
    );
  }

  const deployCommands = parseCommandSpecs(doc.deploy_commands, 'deploy_commands');

  const rawSandbox = doc.judge_sandbox;
  if (rawSandbox === undefined || rawSandbox === null) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml is missing judge_sandbox (the judge sandbox rule data).',
    );
  }
  const judgeSandbox: JudgeSandboxPolicy = {
    roles: requireStringArray(rawSandbox.roles, 'judge_sandbox.roles'),
    writeRoots: requireStringArray(rawSandbox.write_roots, 'judge_sandbox.write_roots'),
    networkCommands: requireStringArray(
      rawSandbox.network_commands,
      'judge_sandbox.network_commands',
    ),
    networkSubcommands: parseCommandSpecs(
      rawSandbox.network_subcommands,
      'judge_sandbox.network_subcommands',
    ),
    targetWriteCommands: requireStringArray(
      rawSandbox.target_write_commands,
      'judge_sandbox.target_write_commands',
    ),
    refusedWriteCommands: requireStringArray(
      rawSandbox.refused_write_commands,
      'judge_sandbox.refused_write_commands',
    ),
    gitWriteSubcommands: requireStringArray(
      rawSandbox.git_write_subcommands,
      'judge_sandbox.git_write_subcommands',
    ),
  };

  const rawScopes = doc.role_write_scopes;
  if (rawScopes === undefined || rawScopes === null) {
    throw new PolicyError(
      'policy.invalid-document',
      'guardrails.yml is missing role_write_scopes (the per-role write bounds).',
    );
  }
  const roleWriteScopes = parseRoleWriteScopes(rawScopes.scopes, judgeSandbox.roles);

  const rules = new Map<string, GuardrailRule>();
  const declaredIn = new Map<string, string>();
  collectRules(doc.rules, rules, declaredIn, 'rules');
  collectRules(rawSandbox.rules, rules, declaredIn, 'judge_sandbox.rules');
  collectRules(rawScopes.rules, rules, declaredIn, 'role_write_scopes.rules');
  for (const [declaredId, key] of declaredIn) {
    if (!EVALUATED_RULE_ID_SET.has(declaredId)) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml declares rule "${declaredId}" in ${key}, which nothing in the evaluator consults; a rule with no branch to fire it enforces nothing.`,
        { rule: declaredId, key },
      );
    }
  }
  for (const requiredId of EVALUATED_RULE_IDS) {
    if (!rules.has(requiredId)) {
      throw new PolicyError(
        'policy.invalid-document',
        `guardrails.yml is missing required rule "${requiredId}".`,
        { rule: requiredId },
      );
    }
  }

  return {
    protectedBranchNames: names,
    protectedBranchPatterns: patterns,
    catchUpRemotes,
    allowedRemovalRoots: allowedRoots,
    deployCommands,
    judgeSandbox,
    roleWriteScopes,
    rules,
  };
}

/**
 * Every role `smith sandbox open --role` accepts — the judge roles plus the
 * write-scoped ones. A role outside this list is a typo or an attempt to
 * pick a rule set by naming one that does not exist; sandbox.ts refuses it
 * at lease time so the mistake surfaces there rather than as silently
 * stricter enforcement three commands later.
 */
export function sandboxRoles(policy: GuardrailPolicy = loadGuardrailPolicy()): string[] {
  return [...policy.judgeSandbox.roles, ...policy.roleWriteScopes.map((s) => s.role)];
}

export function loadGuardrailPolicy(filePath: string = GUARDRAILS_POLICY_PATH): GuardrailPolicy {
  return parseGuardrailPolicy(readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// bash-equivalent matchers — one function per guard.sh helper, same name in
// spirit, same behaviour. See guard.sh's own comments for the trade-offs
// repeated here; they are not re-argued twice.
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Chain-aware subcommand detector, ported from guard.sh's `is_git_subcmd`.
 * Global flags (including value-taking ones like `-C <path>`) sit between
 * `git` and the subcommand, so this does not try to match position — it
 * requires `git` and the subcommand word to appear in the same chain segment
 * (no `;`, `&`, `|` between them). This is intentionally loose (same
 * trade-off as the `rm -rf` detector below): it can over-match a subcommand
 * word appearing elsewhere in the same segment (e.g. a commit message), but
 * it never under-matches on global-flag placement, which is the
 * security-relevant direction for a deny gate.
 *
 * The one place it is deliberately tight is the hyphen. `\b` treats `-` as a
 * boundary, so a bare `\bmerge\b` matches `git merge-base` — a read-only
 * plumbing command that cannot merge anything, and one this repo's own tooling
 * runs constantly. Every hyphenated `<subcommand>-*` in git is a separate
 * command from `<subcommand>`, so requiring the word to be neither preceded
 * nor followed by a hyphen costs no coverage on `push`, `merge` or `rebase`
 * and removes a class of false deny that teaches operators to route around
 * the gate.
 */
function isGitSubcommand(command: string, subcommand: string): boolean {
  return new RegExp(`\\bgit\\b[^;&|]*${bareWord(subcommand)}`, 'i').test(command);
}

/** `subcommand` as a whole word, excluding a hyphenated neighbour — see `isGitSubcommand`. */
function bareWord(word: string): string {
  return `(?<!-)\\b${word}\\b(?!-)`;
}

/**
 * EVERY chain segment containing `git ... <word>`, used to inspect the
 * destination ref precisely instead of loose substring matching. Ported from
 * guard.sh's `git_segment_for`, with the same deliberate behaviour change
 * `checkUnboundedRm` makes below: bash returned the *first* matching segment
 * and stopped, so `git push origin feat/x; git push origin main` was read as
 * a push to `feat/x`, allowed, and the second half never looked at. A chain
 * is one tool call and every command in it runs, so every command in it gets
 * inspected.
 */
function gitSegmentsFor(command: string, word: string): string[] {
  const re = new RegExp(`\\bgit\\b.*${bareWord(word)}`, 'i');
  return splitChainSegments(command).filter((s) => re.test(s));
}

/**
 * The refs a `git push` names: every token after the `push` word that is not a
 * flag, quotes stripped, so `isProtectedRef` can read a destination precisely
 * rather than by a substring match that would false-block `git push origin
 * fix-main-config`.
 *
 * Replaces guard.sh's `last_token`, which this file ported and which read the
 * destination as the segment's *last* whitespace-separated token. That is the
 * ref only when the segment ends at the push, and a segment ends at the push
 * only when nothing follows it — no redirect, no comment, no closing `)` of a
 * substitution. `git push origin main > /dev/null` handed the rule
 * `/dev/null`, and the most ordinary way to write a quiet push turned the gate
 * off. Reading every operand instead needs no guess about which one is the
 * destination: if any of them is a protected ref, the push is refused.
 *
 * Flags are dropped rather than paired with their values, so a flag that takes
 * one (`git push --repo main ...`) leaves that value in the list. That
 * over-refuses on a value spelled exactly `main`, which is the direction this
 * file errs in everywhere else.
 */
function pushOperands(segment: string): string[] {
  return gitOperands(segment, 'push');
}

/**
 * The same read, for any subcommand: every token after the subcommand word
 * that is not a flag, quotes stripped. `pushOperands` is this function under
 * the name rule 1 reads it by, and rule 3 reads a catch-up's source with it.
 * One parser, because a second copy of a rule's reading is a copy that drifts
 * out of step with the first.
 */
function gitOperands(segment: string, word: string): string[] {
  return gitTokens(segment, word)
    .filter((t) => !t.startsWith('-'))
    .map((t) => t.replace(/^["']/, '').replace(/["']$/, ''));
}

/**
 * Every token after the subcommand word, flags included and quotes intact.
 * Rule 3's exception needs to see the flags, not only the operands: a flag it
 * does not recognise is a command doing something the exception has not
 * proved.
 */
function gitTokens(segment: string, word: string): string[] {
  const match = new RegExp(`${bareWord(word)}(.*)$`, 'i').exec(segment);
  if (!match) return [];
  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
}

/**
 * Ported from guard.sh's `is_main_or_master_ref` `case` statement, but
 * data-driven off `policy.protectedBranchNames` instead of the two names
 * bash had hardcoded — same behaviour today (names is `[main, master]`),
 * but a rename doesn't need a second code change to take effect.
 */
function isProtectedRef(ref: string, policy: GuardrailPolicy): boolean {
  return policy.protectedBranchNames.some(
    (name) => ref === name || ref.endsWith(`:${name}`) || ref.endsWith(`:refs/heads/${name}`),
  );
}

/**
 * Exported so `hookDecision.ts` can tell, on the rule-3 fallback path,
 * whether a directory the command named is itself protected — the
 * difference between "the fallback found nowhere safe to land" (old reason
 * stands) and "the fallback denied cwd, but the named directory would have
 * been fine" (the reason needs to say so).
 */
export function isProtectedBranchName(branch: string, policy: GuardrailPolicy): boolean {
  return policy.protectedBranchNames.includes(branch);
}

/**
 * Rule 5's protected-branch test: main/master by name, or a shared
 * `smith/<epic>/integration` branch by pattern (task branches
 * `smith/<epic>/<task-id>` are exempt — rebase/amend there is the sanctioned
 * pre-merge-queue flow, worktree.yml). Ported from guard.sh's inline
 * `^smith/[^/]+/integration$|^(main|master)$`, generalized to whatever
 * `protected_branches.patterns` says instead of one hardcoded shape.
 */
function isProtectedForHistoryRewrite(branch: string, policy: GuardrailPolicy): boolean {
  if (isProtectedBranchName(branch, policy)) return true;
  return policy.protectedBranchPatterns.some((pattern) => picomatch(pattern)(branch));
}

/**
 * `replaceAll`, not `replace`: a template author writing `{branch}` twice
 * should get the branch twice, not the branch and then a literal `{branch}`
 * in the operator's face. Every message in guardrails.yml used it once, so
 * this changes no text today and stops the second use being a trap.
 */
function renderBranch(template: string, branch: string): string {
  return template.replaceAll('{branch}', branch);
}

// ---------------------------------------------------------------------------
// evaluateCommand and its per-rule checks
// ---------------------------------------------------------------------------

export interface PolicyViolation {
  readonly ruleId: string;
  readonly severity: string;
  readonly reason: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  /** Every rule that fired, not just the first — an operator debugging a denial should see all of it at once. */
  readonly violations: readonly PolicyViolation[];
}

export interface PolicyContext {
  readonly toolName: string;
  readonly command: string;
  /** Current branch, or `''` when it could not be determined — mirrors guard.sh's `current_branch()`, which prints `''` on failure rather than raising. */
  readonly branch: string;
  /** Repo root (`git rev-parse --show-toplevel`), or `null` outside a git repo — mirrors guard.sh's `REPO_ROOT`, used only by the `rm -rf` rule. */
  readonly repoRoot: string | null;
  /**
   * The judge sandbox lease covering this command, or `null`/absent when
   * there is none — `activeSandboxFor(cwd)` in sandbox.ts resolves it, and
   * `smith policy hook` passes what it finds.
   *
   * Optional rather than required, because "no lease" is not a degraded
   * reading of the situation — it is the ordinary one. Every coder, planner
   * and operator session runs with no lease, and for them the judge rules
   * are not skipped so much as inapplicable. The six rules above still
   * apply to every caller either way, so an omitted field can never turn
   * the guard hook off.
   */
  readonly sandbox?: SandboxLease | null;
  /**
   * The path a file tool (`Write`/`Edit`/…) is about to write, or
   * `null`/absent for a `Bash` call — Claude Code sends it as
   * `tool_input.file_path`, absolute; `smith policy check --file` takes it
   * relative or absolute.
   *
   * Bash was the only tool worth inspecting while every leased role was a
   * judge, because judges hold no `Edit`/`Write` and so a shell was their
   * only write path. A tester holds both, so a rule that watches only `Bash`
   * would be a rule the tester routes around by using the tool it was given.
   */
  readonly filePath?: string | null;
}

/**
 * Tools whose `command` string this policy inspects. Only `Bash` is in scope
 * today, but that is a fact about which tools *have* a shell command to
 * inspect, not a hardcoded branch in `evaluateCommand` — a second Bash-like
 * tool added later is a one-line change here, not new control flow.
 */
export const INSPECTED_TOOLS: readonly string[] = ['Bash'];

/**
 * Tools whose `file_path` this policy inspects — the write path that does
 * not go through a shell. Nothing here has a command to match, so only the
 * lease rules can fire on them; the base six are all about shell commands
 * and no-op on an empty one.
 *
 * Exported because this evaluator is not the only place that has to know
 * which tools write a file. `harness.ts` asks the same question from the
 * other side: a `cli` judge is refused a worktree unless its `judge_args`
 * deny every one of these, and a new write tool added here is a tool that
 * harness has to start denying on the same commit. Held to that shipped
 * policy, and to the guard hook's own `matcher`, by policy.test.ts.
 */
export const INSPECTED_FILE_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

function requireRule(policy: GuardrailPolicy, id: GuardrailRuleId): GuardrailRule {
  const rule = policy.rules.get(id);
  if (!rule) {
    // Unreachable once a policy has passed parseGuardrailPolicy (which
    // requires every id in EVALUATED_RULE_IDS) — this is a defensive
    // safety-net, not a real code path. Taking a `GuardrailRuleId` rather
    // than a string is the other half: a call site that invents an id the
    // roster does not carry does not compile, so the only way to reach a
    // rule from here is to have declared it as one.
    throw new PolicyError('policy.missing-rule', `guardrails.yml has no rule "${id}".`, {
      rule: id,
    });
  }
  return rule;
}

function violation(rule: GuardrailRule, reason: string = rule.reason): PolicyViolation {
  return { ruleId: rule.id, severity: rule.severity, reason };
}

/**
 * Blank the payload of git's message flags before the six rules below scan a
 * command for refs and command words.
 *
 * A commit or merge message is git's own free-text field: its words are prose,
 * never a ref and never a command. Scanning them anyway is how a commit whose
 * message *described a rule* came to be refused for breaking it — five of the
 * six rules could be tripped by a sentence alone, with no push, merge, deploy
 * or removal anywhere in the command. That is the false deny this file already
 * names twice as the one worth engineering against (see `isGitSubcommand`'s
 * hyphen carve-out and `stripQuotedSpans`): the kind that teaches an agent to
 * route around the gate rather than trust it.
 *
 * Deliberately narrower than `stripQuotedSpans`, which blanks every quoted
 * span. Only a message payload goes, so a quoted *ref* is still read: `git
 * push origin "main"` is still a push to main and `wrangler "deploy"` is still
 * a deploy. Hiding a real target in here would mean passing it where git reads
 * prose, which costs the target its meaning — so the blanking buys no way past
 * any rule.
 *
 * That last sentence holds only for a payload the shell hands over as it
 * stands, which is why `shellExpandsPayload` below gets to veto the blanking.
 *
 * Narrow in four more ways, each one a place where `-m` is not prose:
 *
 * - **Only where git spends `-m` on a message**, named subcommand by
 *   subcommand. `git rebase -m <upstream>` spells `--merge` and `git revert -m
 *   <parent-number>` picks a mainline, so their argument is a ref or a number
 *   that later scans must still see; `mkdir -m 755 <dir>` and `gh pr merge -m
 *   <branch>` are not git at all. A subcommand missing from this list is only
 *   scanned as it is today — the failure is a false deny, which is the
 *   direction this file errs in on purpose.
 * - **Segment by segment**, so `git commit -m "…" && git push origin main`
 *   blanks the message and still reads the push.
 * - **Only where the shell hands the payload over untouched** — see
 *   `shellExpandsPayload`. A payload the shell expands first is not the
 *   message, it is a command that has already run.
 *
 * It is deliberately *not* narrow about how `-m` was spelled. Git takes the
 * message from `-m x`, `-m=x`, `-mx` and `-amx` alike, so a scanner that only
 * knows the spaced form calls the other three prose-that-wasn't-exempted and
 * denies a commit for the words in its message. `git commit -am "…"` is the
 * common one, and it was denied. The letters before the `m` are matched as a
 * cluster and the `m` must end it, which is git's own rule: in `-am` the value
 * follows, in `-ma` the value *is* `a`.
 *
 * The double-quoted form counts an escaped quote as part of the payload, since
 * a shell does. Stopping at the `\"` in `-m "he said \" then ran it"` left the
 * tail exposed and the commit denied for it. Single quotes are left exact:
 * inside them a backslash is a backslash, so `'[^']*'` is already right and
 * teaching it about escapes would be teaching it a falsehood.
 *
 * The value is blanked rather than deleted, so token boundaries survive for
 * the scans that read the last token of a segment.
 */
const MESSAGE_FLAG_RE = /(^|\s)(-[a-zA-Z]*m|--message)(=|\s+|)("(?:\\.|[^"\\])*"|'[^']*'|\S+)/g;

/** The git subcommands whose `-m`/`--message` takes free text, and nothing else. */
const MESSAGE_SUBCOMMANDS = ['commit', 'merge', 'tag', 'stash', 'notes'];

/**
 * Does the payload open and close with this quote character?
 *
 * First and last character only. That is enough for the payloads
 * `MESSAGE_FLAG_RE` hands over and no more: it cannot tell a true pair from
 * one whose closing quote is a backslash-escaped literal, and it does not try.
 * Being wrong there costs a false deny, never a false allow, which is the
 * direction this file errs in everywhere else too.
 */
function isQuotedWith(payload: string, quote: string): boolean {
  return payload.length >= 2 && payload.startsWith(quote) && payload.endsWith(quote);
}

/**
 * Every opener that forks a command and substitutes a path to its stream. The
 * first two are bash's and zsh's alike; `=(` is zsh's own, and zsh is the shell
 * behind the agent's Bash tool, so it is the one most likely to be typed here.
 */
const PROCESS_SUBSTITUTIONS = ['<(', '>(', '=('];

/**
 * True when the shell runs part of this payload *before* handing the rest
 * over — the one case where blanking a payload hides a command rather than
 * prose.
 *
 * A message payload holding a command substitution does not *describe* that
 * command, it runs it: bash expands `$( )` inside double quotes before git is
 * executed at all, so the substituted command happens and its *output* is what
 * finally becomes the message. Blanking such a payload deleted the only real
 * command on the line and left the rules reading the part that was genuinely
 * prose. Backticks are the same expansion in an older spelling, and an
 * unquoted payload is expanded too.
 *
 * Process substitution is a third spelling and runs a command just as eagerly.
 * `git commit -m <(wrangler deploy)` forks the deploy, hands git the path
 * `/dev/fd/63`, and the deploy has already happened by the time git has a
 * message to read. What was blanked there is one whitespace-delimited token —
 * `<(wrangler`, the binary — leaving ` deploy)` behind, so rule 4 went looking
 * for a binary that had been deleted out from under it. Rules 1, 2, 3 and 5
 * came through the same deletion intact for the unremarkable reason that what
 * each of them keys on — a ref, a `--force` flag, a `merge`/`rebase`
 * subcommand — happened not to be the token that got eaten. That is a fact
 * about this payload's word order, not a property any of them hold.
 *
 * All three openers are listed in `PROCESS_SUBSTITUTIONS`, because which ones
 * exist is a fact about the shell that will run the command, not about bash.
 * The agent's shell here is zsh, which has bash's `<( )` and `>( )` and one
 * more of its own: `=(cmd)` runs cmd, writes its output to a temp file and
 * substitutes *that* path. It is the spelling most likely to be reached on
 * this machine and the one a bash-only reading of the problem misses.
 *
 * Quoting decides both kinds, and not along the same line, so the two are
 * asked separately. Single quotes are every shell's own: no expansion of any
 * kind happens inside them, so the payload is exactly the text it looks like.
 * Double quotes are narrower — a command substitution still happens inside
 * them, a process substitution does not — so `"$( )"` is a command while
 * `"<( )"`, `">( )"` and `"=( )"` are the prose they appear to be. Asking
 * "will the shell run this" with the shell's own rule is what keeps the answer
 * from being a guess layered on top of it.
 *
 * Two deliberate imprecisions, both erring toward reading more rather than
 * less, which is the direction the six rules are safe in:
 *
 * - `${VAR}` is left alone. A parameter expansion substitutes a value and runs
 *   no command, so it is prose with a hole in it.
 * - An escaped `\$(` inside double quotes is a literal `$(` to the shell, and
 *   is read here as live anyway. The cost is a false deny on a message that
 *   both escapes a substitution and spells out a guarded command, and the fix
 *   for it is the single quotes that were already the clearer way to write it.
 *
 * Reading a payload is not refusing it. Whatever the expansion contains is
 * judged by the same six rules as any other command, so a message that
 * substitutes `date` stays allowed: `date` is nobody's guarded command.
 */
function shellExpandsPayload(payload: string): boolean {
  // Single-quoted: literal to every shell, so nothing in it can run.
  if (isQuotedWith(payload, "'")) return false;
  // Command substitution, which double quotes do not suppress.
  if (payload.includes('$(') || payload.includes('`')) return true;
  // Process substitution, which they do.
  if (isQuotedWith(payload, '"')) return false;
  return PROCESS_SUBSTITUTIONS.some((opener) => payload.includes(opener));
}

function stripMessageFlagValues(command: string): string {
  // Split keeping the separators, so the segments can be rejoined untouched.
  return command
    .split(/([;&|])/)
    .map((segment) =>
      MESSAGE_SUBCOMMANDS.some((sub) => isGitSubcommand(segment, sub))
        ? segment.replace(MESSAGE_FLAG_RE, (match, lead, flag, sep, payload) =>
            shellExpandsPayload(payload) ? match : `${lead}${flag}${sep}""`,
          )
        : segment,
    )
    .join('');
}

/**
 * `smith policy check --command '<cmd>'` is how anyone asks what these rules
 * say about a command *without running it*. `guardrails.md` leads with it, and
 * the six rules refused it: the hook scans the whole Bash string, so asking
 * about a force push read as a force push and asking about a protected push
 * read as a protected push. Every command worth asking about was a command you
 * could not ask about. A gate whose own dry run is unreachable does not teach
 * caution, it teaches an agent to find out by doing.
 *
 * The exemption rests on one fact and no other: `policy check` parses,
 * evaluates and prints. It has no path that executes what it was handed — see
 * its handler in cli.ts. That is a narrower claim than "quoted text is data",
 * and it is the reason this cannot be widened to any other flag or binary.
 *
 * Narrow in four ways, each closing a way the exemption could be borrowed:
 *
 * - **Quoted payloads only, and only the quoting that leaves them inert.**
 *   `--command "$(…)"` is expanded by the shell before this binary is reached,
 *   so the command in it really runs and the question is not hypothetical.
 *   That is a fact about the payload, not about which quote surrounds it:
 *   double quotes stop a *process* substitution and not a *command* one, so
 *   the same predicate that rules on a message payload rules here —
 *   `shellExpandsPayload`. Keying on the single quote instead was a stand-in
 *   for that predicate, and it refused `--command "<(…)"`, which runs nothing:
 *   an over-refusal on the one command whose whole job is answering without
 *   running.
 * - **Segment by segment**, so a real command chained after the question is
 *   read as itself. Whatever shares the segment is read too: the payload is
 *   blanked, not the segment.
 * - **On the `policy check` subcommand pair, not on a binary name.** The
 *   caller's spelling is `smith`, a package-manager script, or the built entry
 *   point directly, and a public repo cannot assume which — or that an
 *   installation has not aliased it. Keying on the pair also keeps `--command`
 *   from meaning anything here when some other tool spells it.
 * - **An unquoted payload is left alone**, since where it ends is the caller's
 *   shell's business rather than this scanner's. Over-refusing is the
 *   direction this file errs in on purpose, and the fix is the quoting the
 *   docs already show.
 */
const POLICY_CHECK_RE = /(^|\s)policy\s+check(\s|$)/;

/** Only `--command` carries a command; `--file` carries a path and `--sandbox` a role name. */
const POLICY_CHECK_PAYLOAD_RE = /(^|\s)(--command)(=|\s+)('[^']*'|"(?:\\.|[^"\\])*")/g;

function stripPolicyCheckPayloads(command: string): string {
  // Split keeping the separators, so the segments can be rejoined untouched.
  return command
    .split(/([;&|])/)
    .map((segment) =>
      POLICY_CHECK_RE.test(segment)
        ? segment.replace(POLICY_CHECK_PAYLOAD_RE, (match, lead, flag, sep, payload) =>
            shellExpandsPayload(payload) ? match : `${lead}${flag}${sep}''`,
          )
        : segment,
    )
    .join('');
}

/**
 * `git stash push` writes to the stash. It reaches no remote, so nothing about
 * it is a push to a protected branch — but the word is right there, and the
 * loose `isGitSubcommand` read that this file wants everywhere else found it.
 *
 * Matched as the adjacent pair only, never as "a segment mentioning stash", so
 * `git push origin stash` is still read as the push it is. Filtering happens
 * per segment after the chain is split, so the second half of `git stash push
 * && git push` is untouched by this and still denied.
 */
const STASH_PUSH_RE = /\bgit\b[^;&|]*\bstash\s+push\b/i;

/** Rule 1: push to main/master — destination ref, checked precisely; or a bare push while already on a protected branch. */
function checkPushToProtected(
  command: string,
  branch: string,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  if (!isGitSubcommand(command, 'push')) return null;
  const rule = requireRule(policy, 'push-to-protected');
  const pushSegments = gitSegmentsFor(command, 'push').filter((s) => !STASH_PUSH_RE.test(s));
  if (
    pushSegments.some((segment) => pushOperands(segment).some((ref) => isProtectedRef(ref, policy)))
  ) {
    return violation(rule);
  }
  if (
    isProtectedBranchName(branch, policy) &&
    pushSegments.some((segment) => /push(\s+(origin|upstream))?\s*$/.test(segment))
  ) {
    return violation(rule, renderBranch(rule.reasonOnCurrentBranch ?? rule.reason, branch));
  }
  return null;
}

/**
 * Rule 2: force push (`--force` / `--force-with-lease` / `-f` / `--mirror`).
 * Case-sensitive, same as guard.sh (its `grep -Eq` has no `-i`).
 * `--force-if-includes` is already covered: it contains `--force` as a
 * prefix, and `\b` stops at the `-` that follows. `--mirror` shares nothing
 * with `--force`, so it needs its own alternative — a mirror push writes
 * every ref on the remote to match the local one, which is a force push on
 * every branch at once.
 */
const FORCE_PUSH_RE = /(--force(-with-lease)?\b|--mirror\b|(^|\s)-[a-zA-Z]*f[a-zA-Z]*(\s|$))/;

const GIT_PUSH_ANYWHERE_RE = new RegExp(`\\bgit\\b[\\s\\S]*${bareWord('push')}`, 'i');

/**
 * `$'...'` — bash's ANSI-C quoting — is decoded to real bytes before git (or
 * anything else) ever sees it: `\x2d` is `-`, `\146` is `f`, `\x70ush` is
 * `push`. A rule that scans the raw command text for `--force` or `push`
 * never finds either spelled this way, so every regex rule 2 runs is run
 * against this decoded reading instead of the raw segment.
 *
 * Only the escapes bash's own `$'...'` grammar defines are decoded: `\xHH`
 * hex, `\NNN` octal (1-3 digits), `\uHHHH` / `\UHHHHHHHH` Unicode, and the
 * single-letter escapes (`\n`, `\t`, `\\`, `\'`, `\"`, …). Anything else
 * inside the quotes is copied through unchanged — under-decoding only
 * leaves an escape sequence looking like itself, never invents a character
 * that helps an evasion.
 */
const ANSI_C_ESCAPE_RE =
  /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|n|t|r|a|b|f|v|e|E|\\|'|")/g;

function decodeAnsiCPayload(payload: string): string {
  return payload.replace(ANSI_C_ESCAPE_RE, (_match, esc: string) => {
    switch (esc[0]) {
      case 'x':
      case 'u':
      case 'U':
        return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'a':
        return '\x07';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case 'e':
      case 'E':
        return '\x1b';
      case '\\':
        return '\\';
      case "'":
        return "'";
      case '"':
        return '"';
      default:
        // Only octal digits reach here (the `[0-7]{1,3}` branch).
        return String.fromCharCode(Number.parseInt(esc, 8) & 0xff);
    }
  });
}

/**
 * Finds the unescaped `'` that closes a `$'` span starting at `start` (the
 * index right after the opening `$'`). A backslash inside the span escapes
 * whatever follows it, including a `'`, so `\'` never ends the span early.
 * Returns -1 when the span runs off the end of the segment unterminated.
 */
function findAnsiCQuoteEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === "'") return i;
    i += 1;
  }
  return -1;
}

/**
 * Replaces every `$'...'` span in a segment with its decoded content, so the
 * rule-2 checks below read what git will actually receive rather than the
 * quoted spelling. An unterminated span — no closing `'` before the segment
 * ends — cannot be decoded with confidence; `unterminated` tells the caller
 * to fail closed rather than silently reading past it. `opened` reports
 * whether any `$'` opener was read, for a caller that only needs to know
 * whether the construct is present.
 *
 * Two readings, chosen per segment. The quote-aware reading applies only
 * where it is certain to match bash: outside quotes a `$'` opens an ANSI-C
 * span, a plain `'...'` span is literal (a `$` that ends it, as in
 * `grep 'a$'`, is ordinary text and its closing `'` is not an opener), and a
 * backslash makes the next character ordinary. A plain `'` that is never
 * closed is copied through to the end of the segment. A segment holding a
 * construct that starts quoting of its own is read as before instead: every
 * `$'` pair is decoded wherever it sits. Those constructs are a backtick,
 * `$(`, `${`, `$$` (a parameter, so a `'` after it is a plain quote), `<<`
 * (a here-document body is not quoted text), `#` (a comment is not quoted
 * text), and a `$'` met inside double quotes (bash reads it as literal text).
 * When unsure, the segment gets the as-before reading.
 */
const UNCERTAIN_QUOTING = /`|\$\(|\$\{|\$\$|<<|#/;

/** The as-before reading: every `$'` pair is decoded, whatever surrounds it. */
function scanEveryAnsiCPair(segment: string): {
  text: string;
  unterminated: boolean;
  opened: boolean;
} {
  let result = '';
  let opened = false;
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === '$' && segment[i + 1] === "'") {
      opened = true;
      const end = findAnsiCQuoteEnd(segment, i + 2);
      if (end === -1) return { text: result + segment.slice(i), unterminated: true, opened };
      result += decodeAnsiCPayload(segment.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    result += segment[i];
    i += 1;
  }
  return { text: result, unterminated: false, opened };
}

function scanAnsiCQuoting(segment: string): {
  text: string;
  unterminated: boolean;
  opened: boolean;
} {
  if (UNCERTAIN_QUOTING.test(segment)) return scanEveryAnsiCPair(segment);
  let result = '';
  let opened = false;
  let inDouble = false;
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (c === '\\') {
      result += segment.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '$' && segment[i + 1] === "'") {
      if (inDouble) return scanEveryAnsiCPair(segment);
      opened = true;
      const end = findAnsiCQuoteEnd(segment, i + 2);
      if (end === -1) return { text: result + segment.slice(i), unterminated: true, opened };
      result += decodeAnsiCPayload(segment.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (!inDouble && c === "'") {
      const close = segment.indexOf("'", i + 1);
      const spanEnd = close === -1 ? segment.length : close + 1;
      result += segment.slice(i, spanEnd);
      i = spanEnd;
      continue;
    }
    if (c === '"') inDouble = !inDouble;
    result += c;
    i += 1;
  }
  return { text: result, unterminated: false, opened };
}

function decodeAnsiCQuoting(segment: string): { text: string; unterminated: boolean } {
  const { text, unterminated } = scanAnsiCQuoting(segment);
  return { text, unterminated };
}

/**
 * Joins a shell line continuation — a backslash immediately followed by a
 * newline — the way bash does before word splitting even starts: the pair
 * is deleted outright, wherever it sits, including mid-word (`gi\`<LF>`t`)
 * and inside double quotes, which is why `git` spelled with one hidden in
 * the middle reads as `git` to every scanner below rather than as two
 * fragments a literal-substring or exact-word match would miss.
 *
 * Two readings, chosen per command. A backslash and the character after it
 * are always one pair, so an escaped backslash never joins with the newline
 * after it.
 *
 * - A command holding none of the constructs `UNCERTAIN_QUOTING` lists is read
 *   with bash's own quoting, and a pair is kept (not joined) only where bash
 *   keeps it: inside a `'...'` span, which is fully literal, and inside a
 *   `$'...'` span, whose escapes `decodeAnsiCPayload` already reads through.
 *   Outside quotes a backslash escapes the next character, so `\'` opens no
 *   span. Inside double quotes a `'` and a `$'` are literal text and open
 *   nothing; only an unescaped `"` closes the span.
 * - A command holding one of those constructs (a backtick, `$(`, `${`, `$$`,
 *   `<<`, `#`) is read with no spans at all: every continuation is joined.
 *   Their quoting rules (a comment, a here-document body, a nested expansion,
 *   a parameter before a `'`) are not modelled here.
 * - A span that is never closed is read the second way from its opener on.
 *   Bash never runs that remainder.
 *
 * The second reading is the safe direction. Joining a pair bash keeps only
 * removes a newline from what the guard reads of a quoted string, and the
 * pairing rule above never changes how the characters after it pair with a
 * backslash, so it cannot move where any quote ends. Joining fewer pairs than
 * bash does is the only direction that can split a word the shell reads whole.
 */
function joinLineContinuations(command: string): string {
  const joinEvery = (text: string): string => {
    let out = '';
    let k = 0;
    // A quoted-delimiter here-document keeps its body literal, so its body lines are copied as written.
    const pending: HereDoc[] = [];
    while (k < text.length) {
      const atNewline = text[k] === '\n' && pending.length > 0;
      if (atNewline && !pending.every((doc) => doc.quoted)) pending.length = 0;
      else if (atNewline || text.startsWith('<<', k)) {
        const next = hereDocStep(text, k, pending, []);
        if (next === -1) return out + text.slice(k);
        if (next !== k) {
          out += text.slice(k, next);
          k = next;
          continue;
        }
      }
      if (text[k] === '\\') {
        if (text[k + 1] !== '\n') out += text.slice(k, k + 2);
        k += 2;
        continue;
      }
      out += text[k];
      k += 1;
    }
    return out;
  };
  if (UNCERTAIN_QUOTING.test(command)) return joinEvery(command);
  let result = '';
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === '\\') {
      if (command[i + 1] !== '\n') result += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      result += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      result += c;
      i += 1;
      continue;
    }
    if (c === "'" || (c === '$' && command[i + 1] === "'")) {
      const ansiC = c === '$';
      const open = ansiC ? i + 2 : i + 1;
      const end = ansiC ? findAnsiCQuoteEnd(command, open) : command.indexOf("'", open);
      if (end === -1) return result + joinEvery(command.slice(i));
      result += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    result += c;
    i += 1;
  }
  return result;
}

/**
 * Every way this segment could hand git an alias definition inline, without
 * checking what the alias resolves to:
 *
 * - `-c` or `-c<nospace>` naming an `alias.` key, quoted or not
 *   (`-c alias.p=`, `-calias.p=`, `-c 'alias.p=...'`).
 * - `--config-env` naming an `alias.` key, whose value is the *name* of an
 *   environment variable read later — never visible on this line at all.
 * - `GIT_CONFIG_PARAMETERS`, git's own serialisation of a whole `-c` list,
 *   assigned or exported.
 * - A `GIT_CONFIG_KEY_<n>=` pair whose value is an `alias.` key, or is a
 *   shell variable (`$V`, `${V}`) or command substitution (`` `cmd` ``,
 *   `$(cmd)`) this scanner cannot resolve — read alongside a
 *   `GIT_CONFIG_VALUE_<n>` this line may not even set.
 *
 * Issue #258's original fix denied an inline alias only when its value
 * visibly mentioned `push`. That is not a question this line can always
 * answer: the value can come from a shell variable, a named environment
 * variable read later, or a `GIT_CONFIG_VALUE_<n>` set nowhere near the key.
 * `git -c alias.st=status st` is refused for the same reason as everything
 * else in this file errs the same direction — a rule that cannot always
 * tell "harmless alias" from "force-push escape hatch" apart denies both,
 * because the cost of the false deny is smaller than the cost of the hole.
 */
function definesInlineGitAlias(segment: string): boolean {
  if (/(^|\s)-c\s*['"]?alias\./i.test(segment)) return true;
  if (/--config-env(=|\s+)['"]?alias\./i.test(segment)) return true;
  if (/\bGIT_CONFIG_PARAMETERS\b/.test(segment)) return true;
  if (/\bGIT_CONFIG_KEY_\d+=(['"]?)(alias\.|\$|`)/i.test(segment)) return true;
  return false;
}

/**
 * Quote removal is the last step of shell word expansion, and it glues
 * whatever sat on either side of a quote pair into one word: `--for""ce`,
 * `--for''ce` and `-"-"force` all reach git as `--force`, with no
 * `--force` substring ever appearing in the raw command text a regex would
 * scan. Stripping every quote character before the rule-2 checks run reads
 * the segment the way git will — the same "read it the way the shell will"
 * move the `$'...'` decode above and the `+refspec` backslash-strip below
 * already make. Stripping can only pull characters together, never hide
 * one, so it costs nothing a substring check over the raw text was not
 * already blind to.
 */
function stripSpliceQuotes(text: string): string {
  return text.replace(/['"]/g, '');
}

/**
 * A character the shell can still act on inside a word: an escape, a
 * variable or command expansion, a brace list, or a glob. Three rounds of
 * this rule chased individual tricks spelled with these characters — hex
 * escapes, quote-splicing, brace expansion — one at a time, and each fix
 * left the next spelling undetected. This is the fail-closed replacement:
 * rather than keep enumerating tricks, refuse to read a word built from any
 * of them at all.
 */
const SHELL_ACTIVE_CHAR_RE = /[\\$`{}*?[()<>!\n]/;

/**
 * True when `word` is exactly what it looks like to git: either free of
 * every character the shell could still act on, or a single matching pair
 * of quotes wrapped around such a word (`"feat"`, `'origin'` — the quotes
 * themselves removed, nothing shell-active left inside). Anything else — a
 * bare backslash, a `$`, a backtick, a brace, a glob character, or a quote
 * that does not open and close the whole word — means this rule cannot read
 * what git will actually receive, and it refuses rather than guess.
 */
function isPlainWord(word: string): boolean {
  if (word === '') return true;
  const quoted =
    word.length >= 2 &&
    ((word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"')));
  const inner = quoted ? word.slice(1, -1) : word;
  if (/['"]/.test(inner)) return false;
  return !SHELL_ACTIVE_CHAR_RE.test(inner);
}

const PLAIN_WORD_REASON =
  'write this git command with plain words — no quotes inside words, escapes, variables, braces or globs — so the guard can read exactly what git will receive';

/**
 * True when `word` is unreadable specifically because of an unexpanded
 * shell expansion — a `$name` parameter, a `${...}` form, a `$(...)`
 * command substitution, or a backtick span — rather than any other reason
 * `isPlainWord` refuses a word (a bare glob, a stray `<`/`>`, an embedded
 * newline). Rule 2 and rule 6 both recognise their command by its literal
 * word (`git`, `rm`); this is their shared read of "that word's true value
 * is unknowable here," narrowed to the expansion forms those two rules fail
 * closed on rather than every non-plain word, so a path argument elsewhere
 * in the same command — already its own, separately-read concern — is never
 * what trips this.
 */
function isUnexpandedCommandWord(word: DequotedWord): boolean {
  return !isPlainWord(word.raw) && /[$`]/.test(word.raw);
}

/** Subcommands the plain-word gate covers unconditionally. */
const FORCE_GATE_SUBCOMMANDS = ['push', 'rebase', 'reset', 'filter-branch', 'update-ref'];

const BRANCH_SHORT_FLAG_RE = /^-[a-zA-Z]+$/;

/**
 * `git branch` only rewrites or drops a ref when it forces or deletes one:
 * `-D`, `-f`, `-M` or `--force`, bundled or spelled long. Plain `-d` (delete
 * a merged branch) and `-m` (rename) are not covered — see the comment on
 * `checkForcePush` for why a delete without force is let through unread.
 */
function isForcingBranchCommand(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) => token === '--force' || (BRANCH_SHORT_FLAG_RE.test(token) && /[DfM]/.test(token)),
  );
}

/**
 * Same read as `gitTokens`, but bridges a real newline in the remainder —
 * `gitTokens`' `(.*)$` cannot, since `.` does not match `\n` and `$` without
 * a multiline flag only anchors at the true end of the string. A word split
 * across a line-continuation backslash-newline (`--for\`<LF>`ce`) still
 * needs to be read as two whitespace-joined pieces rather than dropped as no
 * match at all. Local to the gate rather than a change to `gitTokens`
 * itself, which rules 1 and 3 also read through.
 */
function wordsAfterSubcommand(text: string, subcommand: string): string[] {
  const match = new RegExp(`${bareWord(subcommand)}([\\s\\S]*)$`, 'i').exec(text);
  if (!match) return [];
  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
}

/**
 * `text` with every quoted span blanked to spaces of the same length, so a
 * quoted phrase cannot be misread as a real subcommand invocation. `--command
 * 'git push origin main'` and `git commit -m "... push origin main"` both
 * hold that literal text, but neither one runs it — one is describing a
 * command, the other is prose in a commit message. Lengths are preserved
 * only so this stays a drop-in swap for `text` in a regex test; nothing here
 * reads offsets.
 */
function blankQuotedSpans(text: string): string {
  return text.replace(/'[^']*'|"[^"]*"/g, (span) => ' '.repeat(span.length));
}

/**
 * `text` with the reading the plain-word gate needs: quoted spans blanked
 * (so a subcommand word only inside quotes is not "really" invoked) and
 * redirections removed (so `git push origin main > /dev/null` is not read as
 * having `>` and `/dev/null` for words). Used only to decide *whether* a
 * segment is covered — word extraction itself still reads real text, quotes
 * and all, through `isPlainWord`.
 */
function forceGateStructuralText(text: string): string {
  return stripRedirections(blankQuotedSpans(text));
}

/** Whether `text` reaches a git subcommand the plain-word gate must cover. */
function isCoveredForcePushSegment(text: string): boolean {
  const structural = forceGateStructuralText(text);
  if (FORCE_GATE_SUBCOMMANDS.some((subcommand) => isGitSubcommand(structural, subcommand))) {
    return true;
  }
  return (
    isGitSubcommand(structural, 'branch') &&
    isForcingBranchCommand(wordsAfterSubcommand(stripRedirections(text), 'branch'))
  );
}

/** True when every word after a covered subcommand in `text` is plain. */
function hasUnsafeWord(text: string): boolean {
  const structural = forceGateStructuralText(text);
  const wordsText = stripRedirections(text);
  for (const subcommand of FORCE_GATE_SUBCOMMANDS) {
    if (!isGitSubcommand(structural, subcommand)) continue;
    if (wordsAfterSubcommand(wordsText, subcommand).some((token) => !isPlainWord(token)))
      return true;
  }
  if (isGitSubcommand(structural, 'branch')) {
    const tokens = wordsAfterSubcommand(wordsText, 'branch');
    if (isForcingBranchCommand(tokens) && tokens.some((token) => !isPlainWord(token))) return true;
  }
  return false;
}

const EVAL_RE = /\beval\b/;
const SHELL_INTERPRETER_WORD_RE = /\b(?:sh|bash|zsh|env)\b/;
/** True when a `;`, `&` or `|`-free run holds an interpreter word with `-c` after it; read run by run, in one pass. */
const hasShellCWrapper = (segment: string): boolean =>
  segment.split(/[;&|]/).some((run) => {
    const found = SHELL_INTERPRETER_WORD_RE.exec(run);
    return found !== null && /-c\b/.test(run.slice(found.index + found[0].length));
  });
const FORCE_GATE_WORD_RE = /\b(push|rebase|reset|filter-branch|update-ref)\b/i;

/**
 * The dequoted payload of a segment wrapped in `eval`, or a `-c` string
 * handed to `sh`/`bash`/`zsh`/`env` — or `null` when `segment` is not one of
 * those wrappers at all, so a caller never mistakes "nothing to unwrap" for
 * an empty payload. Quotes and backslashes are stripped from the *whole*
 * segment, wrapper prefix included (`bash -c 'git rese""t --hard $(x)'`
 * names `git` and a spliced `reset` only once they're gone), which is also
 * why the result still reads correctly as one text to scan rather than an
 * isolated inner string. Shared so rule 2's and rule 6's own unexpanded-word
 * checks below read a nested shell's payload the same way
 * `isShellWrappedForceCandidate` and `checkUnboundedRm`'s wrapped-`rm` pass
 * already do, instead of a fourth copy of the same two lines.
 */
function dequoteShellWrappedSegment(segment: string): string | null {
  if (!EVAL_RE.test(segment) && !hasShellCWrapper(segment)) return null;
  // A line continuation is dropped outright, not just its backslash — rule
  // 6's callers (`hasUnknownRemovalCommandWord`, `shellWrappedRmPayload`)
  // reach this on a segment `joinLineContinuations` never ran over, so a
  // bare `.replace(/\\/g, '')` would leave the newline behind and still
  // split a flag cluster it glues back together (`-r\<LF>f` → `-r`, `<LF>`,
  // `f` instead of `-rf`).
  return stripSpliceQuotes(segment).replace(/\\\n/g, '').replace(/\\/g, '');
}

/**
 * `eval`, or a `-c` string handed to `sh`/`bash`/`zsh`/`env`, passes a whole
 * second command line to another shell to parse — a second chance for any
 * trick above to hide inside a string this rule would otherwise read as
 * inert text, without this scanner ever parsing the nested line itself.
 * Simplest fail-closed read: a segment naming one of those wrappers
 * alongside `git` and force-push-shaped subcommand text is refused outright,
 * rather than trusted to be read correctly.
 */
function isShellWrappedForceCandidate(segment: string): boolean {
  const dequoted = dequoteShellWrappedSegment(segment);
  if (dequoted === null) return false;
  return /\bgit\b/i.test(dequoted) && FORCE_GATE_WORD_RE.test(dequoted);
}

/**
 * One shell word of a segment, split the way a shell would: an unquoted
 * backslash escapes the next character, a single-quoted span is fully
 * literal, a double-quoted span lets a backslash escape the quote itself.
 * `raw` keeps the word exactly as written, for `isPlainWord`; `text` is the
 * same word with every quote and escaping backslash removed — what git
 * actually receives once the shell is done. This is what lets the gate find
 * a subcommand spelled `rese""t`, `p\ush` or `"reset"` as `reset`, where
 * `isGitSubcommand`'s literal-substring read cannot.
 */
interface DequotedWord {
  readonly raw: string;
  readonly text: string;
}

/** A run of characters `splitDequotedWords` takes into a word as they stand: no quote, backslash or blank. */
const PLAIN_WORD_RUN_RE = /[^\s'"\\]+/y;

function splitDequotedWords(segment: string): DequotedWord[] {
  const words: DequotedWord[] = [];
  let raw = '';
  let text = '';
  let inWord = false;
  const flush = () => {
    if (inWord) words.push({ raw, text });
    raw = '';
    text = '';
    inWord = false;
  };
  let i = 0;
  while (i < segment.length) {
    PLAIN_WORD_RUN_RE.lastIndex = i;
    const plain = PLAIN_WORD_RUN_RE.exec(segment)?.[0];
    if (plain !== undefined) {
      inWord = true;
      raw += plain;
      text += plain;
      i += plain.length;
      continue;
    }
    const c = segment.charAt(i);
    if (c === "'") {
      inWord = true;
      raw += c;
      i += 1;
      while (i < segment.length && segment.charAt(i) !== "'") {
        raw += segment.charAt(i);
        text += segment.charAt(i);
        i += 1;
      }
      if (i < segment.length) {
        raw += segment.charAt(i);
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inWord = true;
      raw += c;
      i += 1;
      while (i < segment.length && segment.charAt(i) !== '"') {
        if (segment.charAt(i) === '\\' && i + 1 < segment.length) {
          const escaped = segment.charAt(i + 1);
          raw += segment.charAt(i) + escaped;
          // A backslash-newline is a line continuation, deleted outright —
          // not a character the word's text carries, the same join
          // `joinLineContinuations` already does ahead of the callers that
          // run it first. This branch also reads segments nothing joins
          // first (rule 6's unjoined paths), so it has to hold on its own.
          if (escaped !== '\n') text += escaped;
          i += 2;
        } else {
          raw += segment.charAt(i);
          text += segment.charAt(i);
          i += 1;
        }
      }
      if (i < segment.length) {
        raw += segment.charAt(i);
        i += 1;
      }
      continue;
    }
    if (c === '\\' && i + 1 < segment.length) {
      const escaped = segment.charAt(i + 1);
      raw += c + escaped;
      // A line continuation alone starts nothing: `inWord` stays whatever
      // it already was, so a bare `\`-newline sitting between two real
      // words never pushes an empty word between them. Mid-word (`-r\<LF>f`)
      // `inWord` is already true from the characters before it, so this is
      // a no-op there — the flag cluster still comes out joined as `-rf`.
      if (escaped === '\n') {
        i += 2;
        continue;
      }
      inWord = true;
      text += escaped;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      i += 1;
      continue;
    }
    inWord = true;
    raw += c;
    text += c;
    i += 1;
  }
  flush();
  return words;
}

/** `git` global options that spend the *next* word on a value rather than folding it in with `=`, enough to walk past them to the subcommand. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--attr-source',
  '--super-prefix',
]);

/** The subcommand word of a `git` invocation found at `words[gitIndex]`, walking past global options the way `git` itself does. */
function gitSubcommandWord(words: readonly DequotedWord[], gitIndex: number): number {
  let i = gitIndex + 1;
  while (i < words.length) {
    const word = words[i];
    if (word === undefined) break;
    if (word.text.startsWith('-')) {
      i += GIT_GLOBAL_VALUE_FLAGS.has(word.text) ? 2 : 1;
      continue;
    }
    return i;
  }
  return -1;
}

/** Git builtins that only read: a same-named alias never replaces a builtin, and none of them writes a ref. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'grep',
  'log',
  'show',
  'diff',
  'status',
  'ls-files',
  'ls-tree',
  'blame',
  'shortlog',
  'rev-parse',
  'cat-file',
  'rev-list',
  'describe',
  'for-each-ref',
  'show-ref',
  'diff-tree',
]);

/** Global options that take no value, so the word after one is still the next option or the subcommand. */
const GIT_GLOBAL_FLAGS_WITHOUT_VALUE = new Set([
  '--no-pager',
  '-P',
  '-p',
  '--paginate',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
]);

const READ_ONLY_SEGMENT_FORBIDDEN_RE = /[;&|\n()`#<>{}]/;

/** Global options `isReadOnlyGitCommand` takes a value for; unlike `GIT_GLOBAL_VALUE_FLAGS`, it leaves out the ones whose value git can run. */
const READ_ONLY_GIT_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);

/** `--name=value` global options whose value is only a path or a name. */
const READ_ONLY_GIT_EQUALS_FLAGS = new Set(['--git-dir', '--work-tree', '--namespace']);

const GREP_PAGER_LONG_OPTION = '--open-files-in-pager';

/**
 * True when `word` (as written) holds a parameter expansion, a substitution
 * or an unquoted glob character, so the shell may turn it into something
 * else before git sees it. A single-quoted span, an escaped character and a
 * glob inside double quotes are literal and do not count.
 */
function hasUnreadableShellForm(word: string): boolean {
  let i = 0;
  while (i < word.length) {
    const c = word.charAt(i);
    if (c === '\\') {
      i += 2;
    } else if (c === "'") {
      const end = word.indexOf("'", i + 1);
      i = end === -1 ? word.length : end + 1;
    } else if (c === '"') {
      i += 1;
      while (i < word.length && word.charAt(i) !== '"') {
        const d = word.charAt(i);
        if (d === '$' || d === '`') return true;
        i += d === '\\' ? 2 : 1;
      }
      i += 1;
    } else if (c === '$' || c === '`' || c === '*' || c === '?' || c === '[') {
      return true;
    } else {
      i += 1;
    }
  }
  return false;
}

/** True when `text` is an option of `git grep` whose value git runs as a command. */
function isGrepPagerOption(text: string): boolean {
  if (/^-[^-]*O/.test(text)) return true;
  if (!text.startsWith('--')) return false;
  const name = text.split('=')[0] ?? '';
  return name.length >= 4 && GREP_PAGER_LONG_OPTION.startsWith(name);
}

/**
 * True when `segment` is provably one simple `git <read-only builtin> ...`
 * command, so a gated word (`push`, `reset`, ...) elsewhere in it is only an
 * argument to that builtin, such as a search term. Every condition falls back
 * to the plain-word gate's own answer when it does not hold:
 *  - no command separator, grouping, substitution, comment or redirection
 *    character anywhere, quoted or not, because `topLevelCommands` can hand
 *    back several commands as one segment when it cannot read the line;
 *  - exactly one `git` word, so no second invocation hides in the arguments;
 *  - `git` is the first word, so no assignment or wrapper changes what runs;
 *  - every word before the subcommand is a global option this function knows
 *    (a value-taking one is followed by a plain value), because an option it
 *    does not know may take a value and move the subcommand; `-c`,
 *    `--config-env`, `--exec-path` and any other `--name=value` form are not
 *    known, since a setting or path they give can make git run its value;
 *  - the subcommand is written plainly and is a read-only builtin;
 *  - for `grep`, no word after the subcommand is an `-O` / `--open-files-in-pager`
 *    option (git runs its value as a command) and none holds a parameter
 *    expansion, substitution or unquoted glob that could expand into one.
 * It can only turn a refusal of such a command into an allow; later layers
 * still read the words after the subcommand.
 */
function isReadOnlyGitCommand(segment: string): boolean {
  const stripped = stripRedirections(segment);
  if (READ_ONLY_SEGMENT_FORBIDDEN_RE.test(stripped)) return false;
  if ((segment.match(/\bgit\b/gi) ?? []).length !== 1) return false;
  const words = splitDequotedWords(stripped);
  if (words[0]?.raw !== 'git') return false;
  let i = 1;
  while (i < words.length) {
    const word = words[i];
    if (word === undefined || !word.text.startsWith('-')) break;
    if (!isPlainWord(word.raw)) return false;
    if (READ_ONLY_GIT_VALUE_FLAGS.has(word.text)) {
      const value = words[i + 1];
      if (value === undefined || !isPlainWord(value.raw)) return false;
      i += 2;
    } else if (
      READ_ONLY_GIT_EQUALS_FLAGS.has(word.text.split('=')[0] ?? '') &&
      word.text.includes('=')
    ) {
      i += 1;
    } else if (GIT_GLOBAL_FLAGS_WITHOUT_VALUE.has(word.text)) {
      i += 1;
    } else {
      return false;
    }
  }
  const subcommand = words[i];
  if (
    subcommand === undefined ||
    subcommand.raw !== subcommand.text ||
    !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand.text)
  ) {
    return false;
  }
  if (subcommand.text === 'grep') {
    for (const arg of words.slice(i + 1)) {
      if (isGrepPagerOption(arg.text) || hasUnreadableShellForm(arg.raw)) return false;
    }
  }
  return true;
}

const SUBCOMMAND_NOT_PLAIN_REASON =
  'the git subcommand is not written as a plain word, so the guard cannot tell what it runs — write it out plainly';

const UNKNOWN_COMMAND_WORD_REASON =
  'the command word here is an unexpanded parameter or substitution, so the guard cannot tell what it runs — write it out plainly';

/**
 * Rule 2's gap once some word of the segment is unreadable: neither the
 * exact `git` match above nor its `hidden` fallback (which still needs the
 * dequoted text to end in "git") can place a word that only resolves to
 * `git` once a shell expands `$G`, `$(...)` or a backtick span — this file
 * never evaluates one of those. So when any word of the segment is
 * unreadable this way (`isUnexpandedCommandWord`), the rest of it is read
 * for the shape rule 2 already guards against on a recognised push: a
 * `push` word together with a force flag (`FORCE_PUSH_RE`, the same test
 * the raw-text fallback below uses) or a `+refspec` operand
 * (`pushOperands`, the same read rule 1 uses for a push's destination).
 * Resolving the expansion itself is out of scope — an open-ended evaluator
 * is the wrong tool — so this is shape only, same as rule 6's analogue.
 *
 * Every word is scanned, not just the one in command position: a wrapper
 * (`sudo`, `env`, `timeout 5`, `xargs`, a bare `VAR=val` prefix, …), a group
 * (`( … )`), or a keyword (`{ … }`, `if … then … fi`) can all sit in front
 * of the unreadable word without moving it out of the segment, and an
 * open-ended wrapper list would miss whichever one is not on it. No
 * allowlist narrows this scan the way rule 6's does: a `push` word plus a
 * force flag or `+refspec` is never the shape of an everyday command, so
 * there is no ordinary first word to carve an exception for.
 *
 * Also checked against the segment's dequoted payload when it is a nested
 * shell (`sh -c '…'`, `bash -c "…"`, `eval '…'`): `splitDequotedWords` keeps
 * a quoted span's internal text as one word, which can hide a `-f` token or
 * even the `push` word itself inside it until the quotes are gone.
 */
function isUnknownForcePushShape(segment: string): boolean {
  const words = splitDequotedWords(segment);
  if (!words.some((word) => isUnexpandedCommandWord(word))) return false;
  if (!new RegExp(bareWord('push'), 'i').test(segment)) return false;
  if (FORCE_PUSH_RE.test(segment)) return true;
  return pushOperands(segment).some((ref) => ref.replace(/\\/g, '').startsWith('+'));
}

function hasUnknownForcePushCommandWord(segment: string): boolean {
  if (isUnknownForcePushShape(segment)) return true;
  const wrapped = dequoteShellWrappedSegment(segment);
  return wrapped !== null && isUnknownForcePushShape(wrapped);
}

/**
 * Round 6's fix for a subcommand word the shell will glue back together
 * before git ever sees it — quote-splicing (`rese""t`), a stray backslash
 * (`p\ush`, `\git`) or an expansion (`upd${x}ate-ref`) — none of which
 * `isCoveredForcePushSegment` can see, since it matches a literal substring
 * against text that still holds the quotes and backslashes. This reads the
 * segment as shell words instead: find the actual `git` word (whatever
 * wrapper precedes it — this needs no wrapper list, since it is looking for
 * `git` itself, not what comes before it), walk to its subcommand, and
 * refuse outright if that word cannot be read plainly — not just when it
 * happens to name a covered subcommand, since a word this unreadable could
 * be any of them. A subcommand read plainly and found covered still needs
 * every word after it plain, the same gate `hasUnsafeWord` already applies.
 *
 * The scan covers every word of the segment rather than stopping at the
 * first one that is not a recognised wrapper: a wrapper list is open-ended
 * (`sudo`, `env`, `time`, `timeout`, `nice`, `nohup`, `xargs`, `stdbuf`,
 * `ionice`, `command`, `exec`, a bare `VAR=val` prefix, and whatever the
 * next one is), so stopping early would miss a disguised `git` sitting
 * right after a wrapper this function does not recognise. `echo g\it` being
 * refused along with it is accepted — fail-closed over precise.
 */
function checkForcePushSubcommandWord(
  segment: string,
  words: readonly DequotedWord[],
  rule: GuardrailRule,
): PolicyViolation | null {
  const gitIndex = words.findIndex((word) => word.text.toLowerCase() === 'git');
  if (gitIndex === -1) {
    // Defence in depth for `joinLineContinuations` missing a spelling of its
    // own: a word whose dequoted text is not exactly `git` can still resolve
    // to it once the stray literal newline a shell trick left behind (not a
    // real word break — bash lets a quoted span carry a raw newline with no
    // backslash, which `joinLineContinuations` never touches) is stripped
    // out. Such a word is never plain — `isPlainWord` already refuses a bare
    // backslash or an embedded newline — so this only fires for a raw form
    // this rule could not read anyway; refuse it rather than silently pass
    // through. Only the newline itself is stripped, not every whitespace
    // character: an ordinary quoted argument can legitimately contain plain
    // spaces (a PR title, a commit message), and squeezing those out too
    // reads an innocent word ending in "...ing it" as ending in "git" —
    // issue #273.
    const hidden = words.some(
      (word) =>
        word.text.toLowerCase() !== 'git' &&
        !isPlainWord(word.raw) &&
        word.text.replace(/\r?\n/g, '').toLowerCase().endsWith('git'),
    );
    if (hidden) return violation(rule, SUBCOMMAND_NOT_PLAIN_REASON);
    if (hasUnknownForcePushCommandWord(stripRedirections(segment))) {
      return violation(rule, UNKNOWN_COMMAND_WORD_REASON);
    }
    return null;
  }
  // The `git` word itself, found above by its *dequoted* text, still needs
  // its raw spelling checked: a backslash inside it (`g\it`, `gi\t`) dequotes
  // to exactly `git` and so is found here, but it also breaks the literal
  // `\bgit\b` substring every raw-text check in this file scans for —
  // `GIT_PUSH_ANYWHERE_RE` chief among them, and, outside this file,
  // `isGitSubcommand`, which rules 1 (push-to-protected), 3
  // (merge-into-protected) and 5 (history-rewrite-on-protected) all read a
  // segment through. None of those ever sees a `git` word written this way,
  // so this refusal is their only defence against one — a future narrowing
  // of it must keep covering every subcommand those rules care about, not
  // just force-flagged pushes.
  const gitWord = words[gitIndex];
  if (gitWord !== undefined && !isPlainWord(gitWord.raw)) {
    return violation(rule, SUBCOMMAND_NOT_PLAIN_REASON);
  }
  const subcommandIndex = gitSubcommandWord(words, gitIndex);
  if (subcommandIndex === -1) return null;
  const subcommand = words[subcommandIndex];
  if (subcommand === undefined) return null;
  if (!isPlainWord(subcommand.raw)) return violation(rule, SUBCOMMAND_NOT_PLAIN_REASON);
  const name = subcommand.text.toLowerCase();
  const rest = words.slice(subcommandIndex + 1);
  const covered =
    FORCE_GATE_SUBCOMMANDS.includes(name) ||
    (name === 'branch' && isForcingBranchCommand(rest.map((word) => word.text)));
  if (covered && rest.some((word) => !isPlainWord(word.raw))) {
    return violation(rule, PLAIN_WORD_REASON);
  }
  return null;
}

const NOT_UNDERSTOOD_REASON =
  'this git command uses shell syntax the guard does not read (locale quoting, process substitution, an unterminated quote, expansion or here-document, a nesting too deep, a continuation or an odd redirection) — write it out plainly';

/** The end of the expansion starting at `start` (`$` or a backtick), or -1 when the reader does not model it. */
function expansionEnd(
  text: string,
  start: number,
  quoted: boolean,
  readBody: (body: string) => boolean,
): number {
  const next = text.charAt(start + 1);
  const substitution = (close: number | null, bodyStart: number): number =>
    close !== null && readBody(text.slice(bodyStart, close)) ? close + 1 : -1;
  if (text.charAt(start) === '`')
    return substitution(findBacktickClose(text, start + 1), start + 1);
  if (next === '(') return substitution(findBalancedParenClose(text, start + 2), start + 2);
  if (next === "'") return quoted ? -1 : findAnsiCQuoteEnd(text, start + 2) + 1 || -1;
  if (next === '"' && !quoted) return -1;
  if (next !== '{') return start + 1;
  // `${...}` with an operator or a subscript: read through to the closing brace.
  let inDouble = false;
  for (let i = start + 2; i < text.length; ) {
    const c = text.charAt(i);
    if (c === '}' && !inDouble) return i > start + 2 ? i + 1 : -1;
    const step =
      c === '$' || c === '`'
        ? expansionEnd(text, i, true, readBody)
        : c === "'" && !inDouble
          ? (skipQuotedSpan(text, i) ?? -1)
          : i + (c === '\\' ? 2 : 1);
    if (step === -1) return -1;
    inDouble = c === '"' ? !inDouble : inDouble;
    i = step;
  }
  return -1;
}

/** A run of characters `readShellWords` reads as plain word text: none opens a branch there. */
const PLAIN_RUN_RE = /[^ \t\n;|&()<>'"\\$`#]+/y;

/**
 * The one reader of a segment's shell words: plain text, quotes, escapes,
 * separators, ANSI-C quotes, `${ }` expansions, command and backtick
 * substitutions and here-documents (bodies handed to `readBody`), here-strings,
 * comments, and redirections with one-word targets (dropped). It returns `null`
 * for anything else (locale quoting, process substitution, an unterminated
 * quote, expansion or here-document, a refused body, a redirection without a
 * target) and the caller then asks about the whole command.
 */
function readShellWords(
  segment: string,
  readBody: (body: string) => boolean,
): DequotedWord[] | null {
  const words: DequotedWord[] = [];
  const pending: HereDoc[] = [];
  const unquoted: string[] = [];
  let raw = '';
  let text = '';
  let inWord = false;
  let dropNext = false;
  const add = (rawPart: string, textPart: string) => {
    raw += rawPart;
    text += textPart;
    inWord = true;
  };
  const flush = () => {
    if (inWord && !dropNext) words.push({ raw, text });
    if (inWord) dropNext = false;
    raw = '';
    text = '';
    inWord = false;
  };
  // An unquoted substitution is split at its blanks, so `$(git` reads as the
  // word the pre-existing disguised-word fallback looks for.
  const addExpansion = (start: number, end: number) => {
    const span = segment.slice(start, end);
    if (span.startsWith("$'")) return add(span, decodeAnsiCPayload(span.slice(2, -1)));
    span.split(/\s+/).forEach((piece, index) => {
      if (index > 0) flush();
      add(piece, piece);
    });
  };
  let i = 0;
  while (i < segment.length) {
    // A run of characters no branch below treats specially is added in one piece, not one by one.
    PLAIN_RUN_RE.lastIndex = i;
    const plain = PLAIN_RUN_RE.exec(segment)?.[0];
    if (plain !== undefined) {
      add(plain, plain);
      i += plain.length;
      continue;
    }
    const c = segment.charAt(i);
    const next = segment.charAt(i + 1);
    if (/[ \t]/.test(c)) {
      flush();
      i += 1;
    } else if (/[\n;|&()<>]/.test(c)) {
      if (dropNext && !inWord) return null;
      if (c === '<' || c === '>') {
        if (/^(?:<\(|>\()/.test(segment.slice(i))) return null;
        if (!dropNext && /^\d+$/.test(raw)) inWord = false;
        flush();
        const afterDoc = hereDocStep(segment, i, pending, []);
        if (afterDoc !== i) {
          i = afterDoc;
        } else {
          i += /^(?:<<<|>>|>&|<&|<>|>\||.)/.exec(segment.slice(i))?.[0].length ?? 1;
          dropNext = true;
        }
      } else {
        flush();
        const afterDoc = hereDocStep(segment, i, pending, unquoted);
        if (afterDoc === -1) return null;
        for (const text of unquoted.splice(0)) {
          const bodies = extractSubstitutionBodies(text, true);
          if (bodies === null || !bodies.every(readBody)) return null;
        }
        i = afterDoc === i ? i + 1 : afterDoc;
      }
    } else if (c === "'") {
      const end = segment.indexOf("'", i + 1);
      if (end === -1) return null;
      add(segment.slice(i, end + 1), segment.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      add('"', '');
      i += 1;
      while (segment.charAt(i) !== '"') {
        const d = segment.charAt(i);
        let end = i + 1;
        if (d === '$' || d === '`') end = expansionEnd(segment, i, true, readBody);
        else if (d === '\\') end = segment.charAt(i + 1) === '' ? -1 : i + 2;
        if (i >= segment.length || end === -1) return null;
        // A backslash-newline inside double quotes is removed, as the shell does.
        const joined = d === '\\' && segment.charAt(i + 1) === '\n';
        add(segment.slice(i, end), joined ? '' : segment.slice(d === '\\' ? i + 1 : i, end));
        i = end;
      }
      add('"', '');
      i += 1;
    } else if (c === '\\') {
      if (i + 1 >= segment.length) return null;
      if (next !== '\n') add(c + next, next);
      i += 2;
    } else if (c === '$' || c === '`') {
      const end = expansionEnd(segment, i, false, readBody);
      if (end === -1) return null;
      addExpansion(i, end);
      i = end;
    } else if (c === '#' && !inWord) {
      const end = segment.indexOf('\n', i);
      i = end === -1 ? segment.length : end;
    } else {
      add(c, c);
      i += 1;
    }
  }
  flush();
  return dropNext || pending.length > 0 ? null : words;
}

/** The value of a shell variable set on the command line, or `null` when its text cannot be read statically. */
type EnvValue = string | null;

const GIT_CONFIG_ENV_NAMES =
  'GIT_PAGER|GIT_EXTERNAL_DIFF|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\\d+|GIT_CONFIG_VALUE_\\d+|' +
  // The other variables git starts through the shell as command lines.
  'PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS';
const GIT_CONFIG_ENV_NAME_RE = new RegExp(`^(?:${GIT_CONFIG_ENV_NAMES})$`);
/** Any mention of a configuration variable in dequoted text. */
const GIT_CONFIG_ENV_MENTION_RE = new RegExp(`\\b(?:${GIT_CONFIG_ENV_NAMES})\\b`, 'g');
/** The key under which a declared variable name that cannot be read statically is recorded. */
const COMPUTED_VARIABLE_NAME = ' computed variable name';
const ASSIGNMENT_WORD_RE = /^([A-Za-z_]\w*)=/;

/** Builtins whose following words name variables they set, like `export`. */
const VARIABLE_DECLARING_BUILTIN_RE = /^(?:export|declare|typeset|local|readonly)$/;

const GIT_CONFIG_UNREADABLE_REASON =
  'a git configuration value here holds a parameter or substitution, so the guard cannot tell what git will run — write the value out plainly';

/** `env` options that take the next word as their value. */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);

/** The index where a segment's command starts: past leading `NAME=value` words and the `env` prefix. */
function commandStart(words: readonly DequotedWord[], from = 0): number {
  let start = from;
  while (start < words.length) {
    const text = words[start]?.text ?? '';
    if (ASSIGNMENT_WORD_RE.test(text)) {
      start += 1;
    } else if (text === 'env') {
      start += 1;
      while (start < words.length) {
        const operand = words[start]?.text ?? '';
        if (operand.startsWith('-')) start += ENV_VALUE_OPTIONS.has(operand) ? 2 : 1;
        else if (ASSIGNMENT_WORD_RE.test(operand)) start += 1;
        else break;
      }
    } else {
      break;
    }
  }
  return start;
}

/** The indexes of every `git` word (or a path ending in `/git`) of the segment; the one definition every caller uses. */
function gitWordIndexes(words: readonly DequotedWord[]): number[] {
  const start = commandStart(words);
  return words.flatMap((word, index) =>
    index >= start && !ASSIGNMENT_WORD_RE.test(word.text) && /(?:^|\/)git$/i.test(word.text)
      ? [index]
      : [],
  );
}

/** Whether any configuration variable the line has set holds a value that cannot be read statically. */
function hasUnreadableConfigValue(env: ReadonlyMap<string, EnvValue>): boolean {
  for (const [name, value] of env) {
    if (value === null && (GIT_CONFIG_ENV_NAME_RE.test(name) || name === COMPUTED_VARIABLE_NAME)) {
      return true;
    }
  }
  return false;
}

/**
 * Records the variables a run of words sets: `NAME=value` words and, after
 * `export` and like builtins, a bare configuration variable name (unreadable).
 * With `leadingOnly` the scan stops at the first other word. Returns how many
 * configuration variables it recorded.
 */
function readAssignments(
  words: readonly DequotedWord[],
  env: Map<string, EnvValue>,
  leadingOnly: boolean,
): number {
  let afterExport = false;
  let namesFollow = false;
  let inEnv = false;
  let isPrintf = false;
  let previous = '';
  let recorded = 0;
  for (const word of words) {
    // A word that names the variable it sets, with a parameter or substitution in the name, cannot be read.
    const nameField = word.raw.split('=')[0] ?? '';
    const sets =
      namesFollow || (isPrintf && previous === '-v') || (inEnv && word.raw.includes('='));
    if (/^\d*[<>&]/.test(word.text)) namesFollow = false;
    if (sets && !word.text.startsWith('-') && hasUnreadableShellForm(nameField)) {
      env.set(COMPUTED_VARIABLE_NAME, null);
    }
    previous = word.text;
    if (word.text === 'printf') isPrintf = true;
    if (word.text === 'env') inEnv = true;
    if (VARIABLE_DECLARING_BUILTIN_RE.test(word.text) || word.text === 'read') namesFollow = true;
    const name = ASSIGNMENT_WORD_RE.exec(word.text)?.[1] ?? null;
    const bareName = afterExport && GIT_CONFIG_ENV_NAME_RE.test(word.text) ? word.text : null;
    if (name !== null) {
      env.set(name, hasUnreadableShellForm(word.raw) ? null : word.text.slice(name.length + 1));
    } else if (VARIABLE_DECLARING_BUILTIN_RE.test(word.text)) {
      afterExport = true;
    } else if (bareName !== null) {
      env.set(bareName, null);
    } else if (leadingOnly && word.text !== 'env' && !afterExport && !namesFollow && !isPrintf) {
      break;
    }
    if (GIT_CONFIG_ENV_NAME_RE.test(name ?? bareName ?? '')) recorded += 1;
  }
  return recorded;
}

/**
 * Reads every git configuration value git runs as a command (`-c`,
 * `--config-env`, `git grep -O`, and the `GIT_PAGER` / `GIT_EXTERNAL_DIFF` /
 * `GIT_CONFIG_*` environment, however set) like a command line typed directly.
 * A value holding a parameter, substitution or backtick is refused, whatever its key.
 */
function checkGitConfigValues(
  words: readonly DequotedWord[],
  gitIndex: number,
  env: ReadonlyMap<string, EnvValue>,
  policy: GuardrailPolicy,
  rule: GuardrailRule,
): PolicyViolation | null {
  const unreadable = violation(rule, GIT_CONFIG_UNREADABLE_REASON);
  const checkValue = (value: EnvValue): PolicyViolation | null =>
    value === null ? unreadable : checkForcePush(value, policy);
  if (hasUnreadableConfigValue(env)) return unreadable;
  for (const [name, value] of env) {
    if (!GIT_CONFIG_ENV_NAME_RE.test(name) || /^GIT_CONFIG_(?:COUNT|KEY_)/.test(name)) continue;
    const found = checkValue(value);
    if (found) return found;
  }
  let i = gitIndex + 1;
  for (; i < words.length; i += 1) {
    const word = words[i];
    if (word === undefined || !word.text.startsWith('-')) break;
    const isConfigEnv = word.text.startsWith('--config-env');
    if (!word.text.startsWith('-c') && !isConfigEnv) {
      i += GIT_GLOBAL_VALUE_FLAGS.has(word.text) ? 1 : 0;
      continue;
    }
    let operand = word.text.slice(isConfigEnv ? '--config-env'.length : 2).replace(/^=/, '');
    if (operand === '') {
      operand = words[i + 1]?.text ?? '';
      if (hasUnreadableShellForm(words[i + 1]?.raw ?? '')) return unreadable;
      i += 1;
    } else if (hasUnreadableShellForm(word.raw)) {
      return unreadable;
    }
    const eq = operand.indexOf('=');
    if (eq === -1) continue;
    const rest = operand.slice(eq + 1);
    // A `--config-env` value comes from a named variable: unreadable unless this line sets it.
    const found = checkValue(isConfigEnv ? (env.get(rest) ?? null) : rest);
    if (found) return found;
  }
  const subcommand = words[i];
  if (subcommand?.text !== 'grep') return null;
  for (const arg of words.slice(i + 1)) {
    if (!isGrepPagerOption(arg.text)) continue;
    if (hasUnreadableShellForm(arg.raw)) return unreadable;
    const marker = arg.text.startsWith('--') ? arg.text.indexOf('=') : arg.text.indexOf('O');
    const found = marker === -1 ? null : checkValue(arg.text.slice(marker + 1));
    if (found) return found;
  }
  return null;
}

/** True when the segment's command word holds an expansion or substitution the guard cannot spell out. */
function hasUnreadableCommandWord(segment: string): boolean {
  const words = readShellWords(segment, () => true);
  if (words === null) return false;
  // The command word is read past a leading `!`, prefix words and an `env -S` value.
  const budget: EnvSplitBudget = { left: ENV_SPLIT_LIMIT, exceeded: false };
  const split: SplitWords = (all, from) => splitEnvCommand(all, from, budget, splitValueWords);
  const read = split(words, 0);
  let start = commandStart(read);
  while (read[start]?.text === '!') start += 1;
  const walked = walkPrefixWords(read, start, split, true);
  const commandWord = walked.words[walked.first];
  return commandWord !== undefined && hasUnreadableShellForm(commandWord.raw);
}

/**
 * The top-level commands of `command`, each with whether it is fed by a pipe
 * from an earlier command of the same pipeline that runs git.
 */
function segmentsWithGitPipe(
  command: string,
  texts: readonly string[] = topLevelCommands(command),
): Array<{ text: string; afterGitPipe: boolean }> {
  const parts: Array<{ text: string; afterGitPipe: boolean }> = [];
  let position = 0;
  let afterPipe = false;
  let pipelineRunsGit = false;
  for (const text of texts) {
    if (!afterPipe) pipelineRunsGit = false;
    parts.push({ text, afterGitPipe: afterPipe && pipelineRunsGit });
    pipelineRunsGit ||= /\bgit\b/i.test(text) || hasUnreadableCommandWord(text);
    const end = position + text.length;
    const pair = command.slice(end, end + 2);
    afterPipe = pair.startsWith('|') && pair !== '||';
    position = end + (pair === '&&' || pair === '||' ? 2 : 1);
  }
  return parts;
}

/** Where a line ends one command and starts the next, read without regard to quotes. */
const ROUGH_SEPARATOR_RE = /\|\||&&|;|\n|(?<!>)\|/;

/** `xargs` options that take the next word as their value. */
const XARGS_VALUE_OPTIONS = new Set([
  '-I',
  '-J',
  '-R',
  '-S',
  '-L',
  '-n',
  '-P',
  '-s',
  '-d',
  '-E',
  '-a',
  '--arg-file',
  '--delimiter',
  '--eof',
  '--max-args',
  '--max-chars',
  '--max-lines',
  '--max-procs',
  '--process-slot-var',
]);

const SHELL_INTERPRETER_RE = /^(?:sh|bash|zsh|dash|ksh)$/i;

const XARGS_GIT_REASON =
  'git run by xargs takes its subcommand and arguments from input, so the guard cannot tell what it runs — write the subcommand out plainly';
const GIT_OUTPUT_TO_SHELL_REASON =
  'git output is run by a shell here, so the guard cannot tell what it runs — write the commands out plainly';

/** Words that run the command after them; a shell behind one is read as the shell itself. */
const COMMAND_PREFIX_WORDS = new Set([
  'timeout',
  'command',
  'sudo',
  'nice',
  'nohup',
  'exec',
  'stdbuf',
  'time',
  'builtin',
]);

const PREFIX_OPERAND_RE = /^\d+(?:\.\d+)?[smhd]?$/;
// A short option word holding the letter c; two linear tests, no backtracking on a long word.
const isShellCommandFlag = (word: string): boolean => /^-[a-z]+$/i.test(word) && /c/i.test(word);

const baseName = (word: string | undefined): string => (word ?? '').split('/').pop() ?? '';
const isShellWord = (word: string | undefined): boolean =>
  SHELL_INTERPRETER_RE.test(baseName(word));

/** How many split-string options the guard reads in one segment; a segment past it is refused. */
const ENV_SPLIT_LIMIT = 64;
const ENV_SPLIT_LIMIT_REASON =
  'an env split-string here nests more options than the guard reads — write the command out plainly';
type EnvSplitBudget = { left: number; exceeded: boolean };

// A backslash-underscore outside quotes ends a word in an `env -S` value, as whitespace does.
const splitOnSpace = (value: string): string[] => value.split(/(?:\s|\\_)+/).filter(Boolean);
const VALUE_RUNS: Record<string, RegExp> = { '': /[^\s"'\\]+/y, "'": /[^']+/y, '"': /[^"\\]+/y };

/** The words of a split-string value, reading single quotes, double quotes and backslashes. */
function splitValueWords(value: string): string[] {
  const pieces: string[] = [];
  let current: string | null = null;
  let quote = '';
  for (let at = 0; at < value.length; at += 1) {
    const runs = VALUE_RUNS[quote] as RegExp;
    runs.lastIndex = at;
    let ch = runs.exec(value)?.[0] ?? (value[at] as string);
    at += ch.length - 1;
    if (quote ? ch === quote : ch === '"' || ch === "'") {
      quote = quote ? '' : ch;
      current ??= '';
      continue;
    }
    if (!quote && ch === '\\' && value[at + 1] === '_') {
      at += 1;
      if (current !== null) pieces.push(current);
      current = null;
      continue;
    }
    if (ch === '\\' && quote !== "'" && at + 1 < value.length) ch = value[++at] as string;
    else if (!quote && /\s/.test(ch)) {
      if (current !== null) pieces.push(current);
      current = null;
      continue;
    }
    current = (current ?? '') + ch;
  }
  if (current !== null) pieces.push(current);
  return pieces;
}

/**
 * Where `env` is the command word, its `-S` / `--split-string` value holds a
 * command line in one word; that word is replaced by the words it holds. An
 * `-S` anywhere else (an `xargs` option) is left alone.
 */
function splitEnvCommand(
  words: readonly DequotedWord[],
  from: number,
  budget: EnvSplitBudget,
  read: (value: string) => string[],
): readonly DequotedWord[] {
  let out = words;
  let i = from;
  while (i < out.length) {
    const text = out[i]?.text ?? '';
    if (ASSIGNMENT_WORD_RE.test(text)) {
      i += 1;
      continue;
    }
    if (text !== 'env') break;
    i += 1;
    while (i < out.length) {
      const operand = out[i] as DequotedWord;
      const t = operand.text;
      if (ASSIGNMENT_WORD_RE.test(t)) i += 1;
      else if (!t.startsWith('-')) break;
      else {
        const separate = t === '-S' || t === '--split-string' ? out[i + 1] : undefined;
        const inline = t.startsWith('--split-string=')
          ? t.slice('--split-string='.length)
          : /^-S./.test(t)
            ? t.slice(2)
            : undefined;
        const value = separate ? separate.text : inline;
        if (value === undefined) {
          i += ENV_VALUE_OPTIONS.has(t) ? 2 : 1;
          continue;
        }
        const used = separate ? 2 : 1;
        if (budget.left === 0) {
          budget.exceeded = true;
          return out;
        }
        budget.left -= 1;
        const raw = (separate ?? operand).raw;
        const pieces = read(value).map((piece) => ({ raw, text: piece }));
        out = out.slice(0, i).concat(pieces, out.slice(i + used));
      }
    }
  }
  return out;
}

/**
 * The command a segment runs once `COMMAND_PREFIX_WORDS` and `env` are read
 * past, with their flags, flag values, numbers, durations and assignments.
 * A flag after a prefix word may take the next word as its value, but never
 * `xargs`, `eval` or a shell. A word the walk cannot classify is not trusted to
 * be the command: the first of those later in the segment is taken instead.
 */
type SplitWords = (words: readonly DequotedWord[], from: number) => readonly DequotedWord[];
const isInputRunner = (word: string | undefined): boolean =>
  baseName(word) === 'xargs' || word === 'eval';

/**
 * Behind a prefix word the word after an option is read as the option's value
 * and as the command word. A walk with `at` set to -1 lists the option words
 * (`options`, at most one past the limit); a walk with `at` set to one of them
 * starts the command right after that option.
 */
const OPTION_READ_LIMIT = 16;
const OPTION_READ_LIMIT_REASON =
  'more options follow prefix words here than the guard reads — write the command out plainly';
type OptionBranch = { at: number; options: number[] };

function walkPrefixWords(
  start: readonly DequotedWord[],
  from: number,
  split: SplitWords,
  shellOnly: boolean,
  branch?: OptionBranch,
): { words: readonly DequotedWord[]; index: number; first: number } {
  let words = start;
  let index = from;
  let sawPrefix = false;
  for (;;) {
    const text = words[index]?.text ?? '';
    if (text === 'env') {
      words = split(words, index);
      index = commandStart(words, index);
    } else if (COMMAND_PREFIX_WORDS.has(baseName(text))) {
      index += 1;
      let afterFlag = false;
      while (index < words.length) {
        const next = words[index]?.text ?? '';
        if (
          isShellWord(next) ||
          (!shellOnly && isInputRunner(next)) ||
          next === 'env' ||
          COMMAND_PREFIX_WORDS.has(baseName(next))
        ) {
          break;
        }
        // Only stdbuf's short option can carry its value attached (`-oL`); behind the
        // other prefix words a short-option bundle takes the next word as its value.
        if (next.startsWith('-')) {
          if (branch?.at === index) {
            index += 1;
            break;
          }
          const after = words[index + 1]?.text;
          if (branch && after !== undefined && !PREFIX_OPERAND_RE.test(after)) {
            if (branch.options.length <= OPTION_READ_LIMIT) branch.options.push(index);
          }
          afterFlag = next.startsWith('--') || next.length <= 2 || baseName(text) !== 'stdbuf';
        } else if (afterFlag) afterFlag = false;
        else if (!PREFIX_OPERAND_RE.test(next) && !ASSIGNMENT_WORD_RE.test(next)) break;
        index += 1;
      }
    } else {
      break;
    }
    sawPrefix = true;
  }
  const first = index;
  if (
    sawPrefix &&
    index < words.length &&
    !isInputRunner(words[index]?.text) &&
    !isShellWord(words[index]?.text)
  ) {
    for (let at = index + 1; at < words.length; at += 1) {
      const word = (words[at] as DequotedWord).text;
      if (isShellWord(word) || (!shellOnly && isInputRunner(word))) {
        index = at;
        break;
      }
    }
  }
  return { words, index, first };
}

/**
 * Reads the command a segment runs (past assignments, `env`, `xargs` with its
 * options, and prefix words) the way the in-line form is read: `xargs git`
 * with a missing, unreadable or force-gated subcommand; a shell after a pipe
 * from git; a shell `-c` or `eval` on a substitution that runs git. The line
 * is read with the `env -S` value split into words (by its quotes, and by
 * whitespace alone) and as written; each of those both stopping at the first
 * `xargs` or `eval` and walking on to a later shell word.
 */
function checkXargsGitAndShellInput(
  words: readonly DequotedWord[],
  afterGitPipe: boolean,
  rule: GuardrailRule,
): PolicyViolation | null {
  let exceeded = false;
  let optionsExceeded = false;
  for (const shellOnly of [false, true]) {
    for (const read of [splitValueWords, splitOnSpace, null]) {
      const run = (branch: OptionBranch) => {
        const budget = { left: ENV_SPLIT_LIMIT, exceeded: false };
        const split: SplitWords = (all, from) =>
          read ? splitEnvCommand(all, from, budget, read) : all;
        const found = readRunCommand(words, afterGitPipe, rule, split, shellOnly, branch);
        exceeded ||= budget.exceeded;
        return found;
      };
      const listing: OptionBranch = { at: -1, options: [] };
      const found = run(listing);
      if (found) return found;
      optionsExceeded ||= listing.options.length > OPTION_READ_LIMIT;
      for (const at of listing.options.slice(0, OPTION_READ_LIMIT)) {
        const second = run({ at, options: [] });
        if (second) return second;
      }
    }
  }
  if (exceeded) return violation(rule, ENV_SPLIT_LIMIT_REASON);
  return optionsExceeded ? violation(rule, OPTION_READ_LIMIT_REASON) : null;
}

function readRunCommand(
  originalWords: readonly DequotedWord[],
  afterGitPipe: boolean,
  rule: GuardrailRule,
  split: SplitWords,
  shellOnly: boolean,
  branch: OptionBranch,
): PolicyViolation | null {
  let words = split(originalWords, 0);
  let index = commandStart(words);
  let viaXargs = false;
  for (;;) {
    const walked = walkPrefixWords(words, index, split, shellOnly, branch);
    words = walked.words;
    index = walked.index;
    if (baseName(words[index]?.text) !== 'xargs') break;
    viaXargs = true;
    index += 1;
    while (index < words.length && (words[index]?.text ?? '').startsWith('-')) {
      index += XARGS_VALUE_OPTIONS.has(words[index]?.text ?? '') ? 2 : 1;
    }
    words = split(words, index);
    index = commandStart(words, index);
  }
  const name = baseName(words[index]?.text);
  if (isShellWord(name)) {
    if (afterGitPipe) return violation(rule, GIT_OUTPUT_TO_SHELL_REASON);
    const rest = words.slice(index + 1);
    const runsGitInCommand =
      rest.some((word) => isShellCommandFlag(word.text)) &&
      rest.some((word) => /\$\(|`/.test(word.raw) && /\bgit\b/i.test(word.raw));
    if (runsGitInCommand) return violation(rule, GIT_OUTPUT_TO_SHELL_REASON);
  }
  if (name === 'eval') {
    const runsGit = words
      .slice(index + 1)
      .some((word) => /\$\(|`/.test(word.raw) && /\bgit\b/i.test(word.raw));
    return runsGit ? violation(rule, GIT_OUTPUT_TO_SHELL_REASON) : null;
  }
  if (viaXargs && hasUnreadableShellForm(words[index]?.raw ?? '')) {
    return violation(rule, UNKNOWN_COMMAND_WORD_REASON);
  }
  if (!viaXargs || name.toLowerCase() !== 'git') return null;
  const subcommandIndex = gitSubcommandWord(words, index);
  const subcommand = words[subcommandIndex]?.text.toLowerCase() ?? '';
  if (!/^[a-z][a-z0-9-]*$/.test(subcommand) || FORCE_GATE_SUBCOMMANDS.includes(subcommand)) {
    return violation(rule, XARGS_GIT_REASON);
  }
  return null;
}

/**
 * Rule 2's main defence: a plain-word gate, not a growing list of individual
 * shell tricks. In a segment that reaches `push`, `rebase`, `reset`,
 * `filter-branch`, `update-ref`, or `branch` when it forces or deletes a
 * ref, every word after the subcommand must be plain — see `isPlainWord`.
 * A word this rule cannot read safely is refused rather than guessed at; the
 * gate decides only readability, not force-ness, which the checks below
 * still do once the words are known safe to read. A segment that is provably
 * one read-only git builtin (`isReadOnlyGitCommand`) is not covered by the
 * gate, since there the gated word is only an argument; the checks below
 * still read it.
 */
function checkForcePush(
  command: string,
  policy: GuardrailPolicy,
  depth = 0,
  asWritten = false,
): PolicyViolation | null {
  const rule = requireRule(policy, 'force-push');
  // Joined first, so every rule-2 layer below — the shell-wrapper check, the
  // subcommand-word gate, and the plain-word gate over the words after it —
  // reads the command the way bash will run it, with no continuation left to
  // hide a subcommand word inside.
  // Variables set by earlier segments, carried to the git segments after them.
  const carried = new Map<string, EnvValue>();
  // Over the whole line: configuration variables mentioned and recorded, and whether it runs git.
  let mentions = 0;
  let recorded = 0;
  let runsGit = false;
  // A comment or here-document ends where the shell ends it, so a command
  // holding either is also read once with its continuations as written.
  if (asWritten && !(/\\\n/.test(command) && /<<|(^|[^$])#/.test(command))) return null;
  const parts = asWritten
    ? [{ text: command, afterGitPipe: false }]
    : segmentsWithGitPipe(joinLineContinuations(command));
  if (!asWritten) {
    // A line the top-level split cannot read is also read at every pipe and separator, for
    // the shell-input and xargs checks only.
    const joined = joinLineContinuations(command);
    if (splitTopLevelCommands(joined) === null) {
      for (const { text, afterGitPipe } of segmentsWithGitPipe(
        joined,
        joined.split(ROUGH_SEPARATOR_RE),
      )) {
        const words = readShellWords(text, () => true);
        const found = words && checkXargsGitAndShellInput(words, afterGitPipe, rule);
        if (found) return found;
      }
    }
  }
  for (const { text: segment, afterGitPipe } of parts) {
    if (isShellWrappedForceCandidate(segment)) return violation(rule);

    // A segment the reader does not understand is asked about when it could involve git.
    const nested: PolicyViolation[] = [];
    const words = readShellWords(segment, (body) => {
      if (depth >= MAX_SUBSTITUTION_DEPTH) {
        nested.push(violation(rule, NOT_UNDERSTOOD_REASON));
        return false;
      }
      const found = checkForcePush(body, policy, depth + 1);
      if (found) nested.push(found);
      return true;
    });
    if (nested[0]) return nested[0];
    if (words === null) {
      if (segment.replace(/['"\\]/g, '').match(/git/i)) {
        return violation(rule, NOT_UNDERSTOOD_REASON);
      }
      if (hasUnknownForcePushCommandWord(stripRedirections(segment))) {
        return violation(rule, UNKNOWN_COMMAND_WORD_REASON);
      }
      continue;
    }

    const runViolation = checkXargsGitAndShellInput(words, afterGitPipe, rule);
    if (runViolation) return runViolation;

    const subcommandWordViolation = checkForcePushSubcommandWord(segment, words, rule);
    if (subcommandWordViolation) return subcommandWordViolation;

    const decoded = decodeAnsiCQuoting(segment);
    // An unterminated `$'` span cannot be decoded with confidence — fail
    // closed rather than guess at what it hides, the same direction as
    // `topLevelCommands`' own fallback for a construct it cannot read.
    if (decoded.unterminated) {
      if (/\bgit\b/i.test(segment)) return violation(rule);
      continue;
    }
    if (definesInlineGitAlias(decoded.text)) return violation(rule);

    const gitIndexes = gitWordIndexes(words);
    const gitIndex = gitIndexes[0] ?? -1;
    const env = gitIndex === -1 ? carried : new Map(carried);
    const leading = gitIndex === -1 ? words : words.slice(0, gitIndex);
    recorded += readAssignments(leading, env, gitIndex === -1);
    // Counted on the dequoted text the assignments are read from.
    const dequoted = words.map((word) => word.text).join(' ');
    mentions += (dequoted.match(GIT_CONFIG_ENV_MENTION_RE) ?? []).length;
    const commandWord = words[commandStart(words)];
    runsGit =
      runsGit ||
      /\bgit\b/i.test(dequoted) ||
      (commandWord !== undefined && hasUnreadableShellForm(commandWord.raw));
    for (const index of gitIndexes) {
      const configViolation = checkGitConfigValues(words, index, env, policy, rule);
      if (configViolation) return configViolation;
    }

    // Subcommand detection reads the decoded text, so a subcommand word
    // hidden inside a `$'...'` span (`$'\x70ush'`) is still found. But a
    // `$'...'` span is itself one of the constructs the plain-word gate
    // exists to refuse — decoding it away first, then checking the decoded
    // words for plainness, would launder exactly what it is meant to catch.
    // So once a covered subcommand is found, an undecoded `$'...'` span
    // anywhere in the segment is already a plain-word failure on its own;
    // otherwise (no span at all) the raw segment is checked directly.
    // The one exemption: a read-only builtin that only names a gated word as
    // an argument (`git grep push -- 'x/*.ts'`) skips the plain-word block.
    // Every layer after it still reads the segment.
    const readOnlyBuiltin = decoded.text === segment && isReadOnlyGitCommand(segment);
    if (isCoveredForcePushSegment(decoded.text) && !readOnlyBuiltin) {
      if (decoded.text !== segment) return violation(rule, PLAIN_WORD_REASON);
      if (hasUnsafeWord(segment)) return violation(rule, PLAIN_WORD_REASON);
    }

    const text = stripSpliceQuotes(decoded.text);
    const withoutStash = text.replace(/\bstash\s+push\b/gi, 'stash');
    if (!GIT_PUSH_ANYWHERE_RE.test(withoutStash)) continue;
    if (FORCE_PUSH_RE.test(text)) return violation(rule);
    // A refspec operand starting with `+` forces the update the same way
    // `--force` does, with no flag on the line at all. Read the same way
    // rule 1 reads a push's destination: every non-flag operand of the push,
    // quotes stripped — and backslashes stripped too, since the shell
    // removes them before git ever sees the argument. `git push origin
    // \+feat` reaches git as `+feat`; scanning the raw `\+feat` for a
    // leading `+` misses it, so the operand is read the way git will.
    if (pushOperands(text).some((ref) => ref.replace(/\\/g, '').startsWith('+'))) {
      return violation(rule);
    }
  }
  // On a git line, a configuration variable named beyond the recorded assignments is refused.
  if (runsGit && (mentions > recorded || hasUnreadableConfigValue(carried))) {
    return violation(rule, GIT_CONFIG_UNREADABLE_REASON);
  }
  return null;
}

/**
 * The command's top-level commands, split only where the shell itself ends a
 * command: `;`, `&&`, `||`, `|` and an unescaped newline, outside quotes,
 * backticks and `$( )` / `( )`. A redirection (`>`, `2>&1`, `>|`), a lone `&`
 * and everything nested stay inside the command they belong to.
 *
 * Anything it cannot read with confidence returns the whole command as one
 * segment: an unbalanced quote or paren, or a construct it does not model —
 * ANSI-C `$'…'` quoting, `${…}` expansion (whose operands may hold `;` or
 * `&&`), a heredoc (`<<`, whose body is not shell syntax) or any `#` other
 * than `$#`. A comment's text may hold a lone quote, and a comment starts not
 * only after a space but right after `;`, `&` or `)` too, so every `#` that
 * could open one falls back rather than the scan guessing which do. That is
 * the pre-split reading, so a parse it gets wrong can only over-refuse, never
 * let a force flag through.
 */
function topLevelCommands(command: string): string[] {
  return splitTopLevelCommands(command) ?? [command];
}

/** Characters `splitTopLevelCommands` never reacts to, whatever quote or paren it is inside. */
const INERT_RUN_RE = /[^'"\\`()&|;\n$]+/y;

/** `topLevelCommands`' split, or `null` when the line holds something it cannot read with confidence. */
function splitTopLevelCommands(command: string): string[] | null {
  if (/\$\{|<<|(^|[^$])#/.test(command) || scanAnsiCQuoting(command).opened) return null;
  const segments: string[] = [];
  const stack: Array<'sq' | 'dq' | 'bt' | 'paren'> = [];
  let start = 0;
  let i = 0;
  const cut = (end: number, next: number) => {
    segments.push(command.slice(start, end));
    start = next;
  };
  while (i < command.length) {
    // Characters no state below reacts to are skipped in one step.
    INERT_RUN_RE.lastIndex = i;
    const inert = INERT_RUN_RE.exec(command)?.[0];
    if (inert !== undefined) {
      i += inert.length;
      continue;
    }
    const c = command[i];
    const top = stack[stack.length - 1];
    if (top === 'sq') {
      if (c === "'") stack.pop();
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (top === 'dq') {
      if (c === '"') stack.pop();
      else if (c === '`') stack.push('bt');
      else if (c === '$' && command[i + 1] === '(') {
        stack.push('paren');
        i += 1;
      }
      i += 1;
      continue;
    }
    if (top === 'bt' && c === '`') {
      stack.pop();
      i += 1;
      continue;
    }
    if (c === "'") stack.push('sq');
    else if (c === '"') stack.push('dq');
    else if (c === '`') stack.push('bt');
    else if (c === '(') stack.push('paren');
    else if (c === ')') {
      if (top !== 'paren') return null;
      stack.pop();
    } else if (stack.length === 0) {
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') {
        cut(i, i + 2);
        i += 2;
        continue;
      }
      if (c === ';' || c === '\n' || (c === '|' && command[i - 1] !== '>')) cut(i, i + 1);
    }
    i += 1;
  }
  if (stack.length > 0) return null;
  segments.push(command.slice(start));
  return segments;
}

/** Rule 3: `git merge` or `git pull` while standing on a protected branch — the only place a merge can land. */
function checkMergeIntoProtected(
  command: string,
  branch: string,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  // A merge has exactly one destination and it is never on the command line:
  // it is wherever HEAD is. Every ref you name is a source. So the only
  // question this rule can answer honestly is which branch you are standing
  // on. Reading an operand as the destination refused the routine
  // `git merge <base>` that refreshes a stale side branch — the opposite act.
  //
  // `git pull` is `git fetch` followed by that same merge, and it lands in the
  // same place, so it is the same rule. `bareWord` keeps `git merge-base`,
  // `git merge-tree` and `git pull-request` out: hyphenated names are
  // different commands, and the plumbing ones cannot merge anything.
  if (!isGitSubcommand(command, 'merge') && !isGitSubcommand(command, 'pull')) return null;
  // Names only, deliberately, not `protected_branches.patterns`: landing task
  // branches on `smith/<epic>/integration` is the merge queue's whole job.
  if (!isProtectedBranchName(branch, policy)) return null;
  // One exception, and it is the one act of merging that lands nothing:
  // fast-forwarding this branch to its own copy on a remote. No commit is
  // created and no work arrives that was not already published, so refusing
  // it protected nothing and cost the operator the ordinary refresh of a
  // local `main` — the only way to do it was outside the gate entirely.
  //
  // Judged per segment, because every command in a chain runs: an allowed
  // catch-up in front of `&& git merge feature-y` buys the merge nothing.
  const segments = catchUpSegments(command);
  if (
    segments.length > 0 &&
    segments.every((segment) => isUpstreamCatchUp(segment, branch, policy))
  ) {
    return null;
  }
  const rule = requireRule(policy, 'merge-into-protected');
  return violation(rule, renderBranch(rule.reasonOnCurrentBranch ?? rule.reason, branch));
}

/**
 * The only flag rule 3's exception knows how to read. Everything else — even
 * something harmless — falls back to the deny, because the exception's claim
 * is that the command lands nothing, and a flag it has never seen is a claim
 * it cannot make. `--no-ff` is the reason this is an allowlist and not a
 * `--ff-only` presence test: `git pull --ff-only origin main --no-ff` has the
 * exception's exact spelling in it and still writes a merge commit, since the
 * later flag wins.
 */
const CATCH_UP_FLAGS: readonly string[] = ['--ff-only'];

/** `git merge` / `git pull` and nothing in between — no `git -c ...`, no env prefix, no wrapper. */
const CATCH_UP_SHAPE_RE = /^git\s+(merge|pull)(?:\s|$)/;

/**
 * Is this segment a fast-forward of the branch you are standing on to its own
 * copy on a remote?
 *
 * The rule reads what the command line says, so the exception does too, and it
 * allows a segment only where the text itself proves every part: the command
 * is a plain `git merge`/`git pull` with nothing spliced in front of the
 * subcommand; its only flag is `--ff-only`; its source names *this* branch on
 * a remote the policy lists; and there is no other operand, since a second
 * source is a second thing landing. Anything the exception has not read is a
 * denial, not a shrug — that is the difference between a proof and a guess.
 *
 * What it deliberately leaves out is a bare `git pull --ff-only`, whose source
 * is `branch.<name>.merge` in a config file this rule cannot read. It is
 * almost always the same catch-up, and "almost always" is the reasoning rule 3
 * was just corrected out of — the operator gets a spelling that is true on its
 * face instead.
 *
 * And what it cannot prove even so: a remote is a name here, and `git remote
 * set-url origin <anywhere>` makes that name point wherever it likes. The
 * allowlist buys the operator a name they control, not a URL this gate has
 * verified — see docs/standards/guardrails.md.
 */
function isUpstreamCatchUp(segment: string, branch: string, policy: GuardrailPolicy): boolean {
  const subcommand = CATCH_UP_SHAPE_RE.exec(segment.trim())?.[1];
  if (!subcommand) return false;
  const tokens = gitTokens(segment, subcommand);
  const flags = tokens.filter((t) => t.startsWith('-'));
  if (!flags.includes('--ff-only')) return false;
  if (flags.some((flag) => !CATCH_UP_FLAGS.includes(flag))) return false;
  const operands = tokens
    .filter((t) => !t.startsWith('-'))
    .map((t) => t.replace(/^["']/, '').replace(/["']$/, ''));
  if (subcommand === 'pull') {
    // `git pull <remote> <branch>`: the source is two operands, spelled apart.
    return operands.length === 2 && isCatchUpRemote(operands[0], policy) && operands[1] === branch;
  }
  // `git merge <remote>/<branch>`: the same source, spelled as one ref. A bare
  // `main` is not it — that is a local ref that merely shares the name.
  if (operands.length !== 1) return false;
  const [remote, ...rest] = (operands[0] ?? '').split('/');
  return isCatchUpRemote(remote, policy) && rest.join('/') === branch;
}

function isCatchUpRemote(token: string | undefined, policy: GuardrailPolicy): boolean {
  return token !== undefined && policy.catchUpRemotes.includes(token);
}

/** Rule 4: deploy/publish commands (`deploy_commands` in guardrails.yml — wrangler deploy/publish, pages publish today). */
function checkDeployCommand(command: string, policy: GuardrailPolicy): PolicyViolation | null {
  const rule = requireRule(policy, 'deploy-command');
  for (const spec of policy.deployCommands) {
    const subcommandAlt = spec.subcommands.map(escapeRegExp).join('|');
    const re = new RegExp(`\\b${escapeRegExp(spec.command)}\\b.*\\b(${subcommandAlt})\\b`, 'i');
    if (re.test(command)) {
      return violation(rule);
    }
  }
  return null;
}

/** Rule 5: history rewrite (rebase / commit --amend / filter-branch|filter-repo) on a protected branch. */
function checkHistoryRewriteOnProtected(
  command: string,
  branch: string,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  if (!isProtectedForHistoryRewrite(branch, policy)) return null;
  const rewrites = (text: string) =>
    isGitSubcommand(text, 'rebase') ||
    /\bcommit\b.*--amend\b/i.test(text) ||
    /\bfilter-(branch|repo)\b/i.test(text);
  // Each top-level command is read on its own, and a read-only git command
  // (a search that names a rewrite word) is skipped. A line the splitter
  // cannot read is matched as a whole.
  const segments = splitTopLevelCommands(command);
  const found =
    segments === null
      ? rewrites(command)
      : segments.some((segment) => !isReadOnlyGitCommand(segment) && rewrites(segment));
  if (!found) return null;
  const rule = requireRule(policy, 'history-rewrite-on-protected');
  return violation(rule, renderBranch(rule.reason, branch));
}

/** A bundled short-flag token (`-rf`, `-Rvf`) as opposed to a long flag (`--force`) or a path. */
const RM_SHORT_FLAG_RE = /^-[a-zA-Z]+$/;

/**
 * Rule 6 detection, half two: does this `rm` carry both recursive and force?
 *
 * Read across the invocation's flag tokens rather than out of a single one,
 * because the spellings that mean the same removal are one case, not four:
 * bundled (`-rf`), split (`-r -f`), long (`--recursive --force`), and mixed
 * (`--recursive -f`). The predecessor of this function matched the flags as a
 * literal run directly after `rm`, which read `-rf` and `-fr` and nothing
 * else — so `rm -Rf src` and `rm -r -f src` were recursive-force removals the
 * gate did not see. `-R` counts: it is POSIX's own recursive spelling and
 * does exactly what `-r` does.
 *
 * `-i` is still ignored, matching guard.sh — an interactive prompt is not a
 * bound the factory can hold an agent to.
 */
function hasRecursiveForce(tokens: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  for (const token of tokens) {
    if (token === '--recursive') recursive = true;
    else if (token === '--force') force = true;
    else if (RM_SHORT_FLAG_RE.test(token)) {
      if (token.includes('r') || token.includes('R')) recursive = true;
      if (token.includes('f')) force = true;
    }
  }
  return recursive && force;
}

/**
 * The same recursive-force cluster `hasRecursiveForce` reads out of a
 * tokenised word list, asked instead of two independent, linear scans over
 * raw, unparsed text — one per flag, not one combined pattern — because
 * there is no word list left to read: the text has not been dequoted or
 * split, so a cluster split across tokens (`-r -f`, `-r --force`) has to be
 * found without that split ever happening. This is what a substitution body
 * falls back to once it cannot be delimited with confidence — an
 * unterminated quote, an unbalanced paren, or a nesting depth past
 * `MAX_SUBSTITUTION_DEPTH`.
 *
 * Each scan looks for its flag at the start of a token — the start of the
 * text, or just past whitespace, a quote, `(`, a backtick, `;`, `|` or `&` —
 * then either the flag's long spelling (`--recursive`, `--force`) or a
 * single hyphen followed by nothing but letters containing the flag's
 * letter (`-r`, `-R`, `-rf`, `-Rvf`). The long spelling is checked on its
 * own branch, gated on a second, literal hyphen, rather than folded into
 * the bundled-letter scan: `hasRecursiveForce` never reads `--force` as
 * carrying a recursive flag, because its own bundled-flag test
 * (`RM_SHORT_FLAG_RE`) is anchored to exactly one leading hyphen and
 * `--force` has two, so it only ever matches `--force`'s own exact-token
 * branch. A combined scan that let the recursive pattern walk into a second
 * hyphen would read `--force`'s own tail letters — `f`, `o`, `r`, `c`, `e` —
 * and find the `r` in "force", flagging a force-only invocation as
 * recursive too. Splitting the hyphen count the same way `hasRecursiveForce`
 * does keeps that false read out. Over-matching in every other direction (a
 * bundled flag that is not really `rm`'s, a comment mentioning both words)
 * is the same direction every fail-closed read in this file already takes.
 */
const TOKEN_START = String.raw`(?:^|[\s'"(\`;|&])`;
const RAW_RECURSIVE_FLAG_RE = new RegExp(`${TOKEN_START}-(?:-recursive\\b|[A-Za-z]*[rR][A-Za-z]*)`);
const RAW_FORCE_FLAG_RE = new RegExp(`${TOKEN_START}-(?:-force\\b|[A-Za-z]*f[A-Za-z]*)`);

/**
 * Outside single quotes, the shell turns a backslash followed by any
 * character into that character, and drops a backslash-newline outright —
 * its line continuation. `-\r` reads as `-r`, so the two flag regexes above
 * need to see the escape resolved, not the backslash that is still sitting
 * in front of the letter. This text is exactly the text whose quoting
 * could not be resolved with confidence (an unterminated quote, or a
 * nesting depth this scanner gave up delimiting), so there is no reliable
 * way to tell whether a given backslash sits inside single quotes, where
 * the shell would have left it untouched. Reading every backslash as an
 * escape is the same fail-closed direction the rest of this fallback
 * already takes: over-denying a backslash that was really inside single
 * quotes costs nothing here, and under-denying one that was not is the gap
 * this closes.
 */
function unescapeForFlagScan(text: string): string {
  return text.replace(/\\([\s\S])/g, (_match, ch: string) => (ch === '\n' ? '' : ch));
}

function hasRecursiveForceInText(text: string): boolean {
  const unescaped = unescapeForFlagScan(text);
  return RAW_RECURSIVE_FLAG_RE.test(unescaped) && RAW_FORCE_FLAG_RE.test(unescaped);
}

/**
 * The characters that separate one command in a chain from the next. `;&|`
 * are the three guard.sh knew, and for a long time this file knew no others
 * — which left the rules that read a segment's *operands* (rule 1's
 * destination ref, rule 6's paths) reading whatever the next piece of shell
 * syntax put in front of them:
 * - `(` `)` open and close a substitution or subshell — `echo $(git push
 *   origin main)` is a real push in a real tool call, and the `)` stuck to
 *   the ref made it `main)`, which is nothing's name.
 * - A backtick is the older spelling of the same thing.
 * - `#` starts a comment; everything after it is not a command at all.
 * - A newline separates two commands exactly as `;` does. A multi-line Bash
 *   payload is one tool call, and every line in it runs.
 * - `{` `}` group commands.
 *
 * Splitting stays naive about quoting, the same trade-off guard.sh made: a
 * separator inside a quoted string splits anyway. That direction over-refuses,
 * which is the one this file chooses everywhere.
 */
const COMMAND_SEPARATOR_CHARS = ';&|\\n(){}#`';

/**
 * `>` `<` start a redirection, whose target is a file the command writes,
 * never one of its operands. This is the one that mattered: `git push
 * origin main > /dev/null` is not an evasion, it is how a quiet push is
 * written, and it was allowed.
 *
 * They are kept apart from the separators above because cutting a command
 * here does not separate two commands, it *truncates* one — and the two
 * cuts differ on whether that is safe. A rule that refuses on what it sees
 * refuses more when it sees less, so every deny rule may cut here freely.
 * `checkMergeIntoProtected`'s exception *allows* on what it sees, and text
 * it never read is a claim it must not make: see `stripRedirections`.
 */
const REDIRECTION_CHARS = '<>';

/** Every character that ends the command a segment is about — what the deny rules split on. */
const SEPARATOR_CHARS = `${COMMAND_SEPARATOR_CHARS}${REDIRECTION_CHARS}`;

/**
 * Every separated segment of a command, so a chain can be inspected one
 * invocation at a time — and so a rule reading a segment's operands is looking
 * at that command's operands and nothing else.
 *
 * Joins line continuations first. The split below is a naive character class
 * that includes a bare newline, with no idea a backslash in front of one
 * means "this is not where the command ends" — left unjoined, `rm -r\<LF>f
 * /x` would split into `rm -r\` and `f /x` before either reached a word
 * splitter, and no fix inside one could ever reunite a flag cluster already
 * cut in half. `joinLineContinuations` is the same join `checkForcePush`
 * already runs first; every caller here gets it for the same reason.
 */
function splitChainSegments(command: string): string[] {
  return joinLineContinuations(command).split(new RegExp(`[${SEPARATOR_CHARS}]`));
}

/**
 * A redirection, with its target: an optional file descriptor or `&`, one of
 * the redirection operators, and then either a descriptor to duplicate
 * (`2>&1`, `<&-`) or a word to redirect to, glued or spaced (`>/dev/null`,
 * `> out`). The target stops at a separator so that `>out; git merge x` gives
 * back the `;` it was written with.
 *
 * Longest operators first: `>>` before `>`, `<<<` before `<<` before `<`.
 */
const REDIRECTION_RE = new RegExp(
  // The descriptor is optional, and a non-empty one starts at the head of a digit run only:
  // from every digit of a long run, `\d+` would scan to the run's end and fail, which is
  // quadratic in its length. The empty descriptor stays allowed everywhere, because a
  // replace resumes right after the previous match, which may end in a digit (`2>&1>f`).
  `(?:&|(?<!\\d)\\d+)?(?:>>|>|<<<|<<-?|<>|<)(?:&\\d*-?|\\s*[^\\s${COMMAND_SEPARATOR_CHARS}${REDIRECTION_CHARS}]*)`,
  'g',
);

/**
 * The command with its plumbing taken out — `git pull --ff-only origin main
 * 2>&1 | tail` becomes `git pull --ff-only origin main   | tail`.
 *
 * Removing redirections *before* splitting is the point, and the order is what
 * makes it correct: the `&` in `2>&1` belongs to the redirection, and only a
 * reader that has already recognised it can tell it from the `&&` that really
 * does start a second command.
 *
 * This is the exception's reading and nothing else's. Every deny rule keeps
 * splitting on `<` and `>`, where truncating a command is the safe direction.
 */
function stripRedirections(command: string): string {
  return command.replace(REDIRECTION_RE, ' ');
}

/**
 * The `git merge`/`git pull` commands in a chain, read for rule 3's exception:
 * plumbing removed, then split on the characters that actually separate two
 * commands.
 *
 * `gitSegmentsFor` is the same read for every rule that denies, and it would
 * hand this one a lie: `git pull --ff-only origin main >/dev/null --no-ff`
 * splits at the `>` into a segment that ends at `main`, which is exactly the
 * catch-up the exception allows — while the command git actually runs has
 * `--no-ff` on it and writes a merge commit.
 */
function catchUpSegments(command: string): string[] {
  const re = new RegExp(`\\bgit\\b.*(?:${bareWord('merge')}|${bareWord('pull')})`, 'i');
  return stripRedirections(command)
    .split(new RegExp(`[${COMMAND_SEPARATOR_CHARS}]`))
    .filter((s) => re.test(s));
}

/** Rule 6 detection, half one: is `rm` invoked as a command in this segment? Looser than "first token", so `sudo rm …` still matches; stricter than a bare substring, so the `rm` inside `charm`/`confirm` is not this rule's business. Used as a fallback alongside the whole-segment word scan below — see `checkUnboundedRm`. */
const RM_INVOKE_RE = /(^|[;&|]|\s)rm\s+/;

/** The `rm <args>` run up to the next separator, ported from guard.sh's `grep -Eo 'rm[[:space:]]+[^;&|]*'` and widened with it. Applied per chain segment (see `checkUnboundedRm`), so "up to the next separator" and "to the end of the string" mean the same thing by the time this runs — the negated class is belt and braces, kept in step with the split so the two can never disagree about where a command ends. */
const RM_ARGS_RE = new RegExp(`rm\\s+([^${SEPARATOR_CHARS}]*)`);

/**
 * True when any word of `segment` has basename `rm` and resolves to it only
 * once a backslash is undone (`r\m`, `/bin/r\m`, `./r\m`) — fails closed,
 * refused outright wherever it sits rather than parsed for its flags and
 * paths, since neither can be trusted from a word that was never written
 * plainly. Every word of the segment is scanned, not just the one in command
 * position: an open-ended list of wrappers (`sudo`, `env`, `time`, `xargs`,
 * `nohup`, `stdbuf`, `ionice`, `command`, `exec`, a bare `VAR=val` prefix…)
 * can sit in front of `rm`, so narrowing the scan to command position would
 * miss a disguised `rm` behind any wrapper not on that list. `echo r\m`
 * being refused along with it is accepted.
 */
function hasDisguisedRmWord(words: readonly DequotedWord[]): boolean {
  return words.some((word) => {
    const basename = word.text.split(/[\\/]/).pop() ?? word.text;
    return basename === 'rm' && !isPlainWord(word.raw);
  });
}

/**
 * The index of the first plain (non-disguised) word in `words` whose
 * basename is `rm` — `rm`, `/bin/rm`, `./rm` — or `-1` if there is none.
 * Reading this word's position, rather than just whether one exists, is
 * what lets `extractRmArgsFromWords` take the words that follow it instead
 * of re-deriving them from raw text.
 */
function plainRmWordIndex(words: readonly DequotedWord[]): number {
  return words.findIndex((word) => {
    if (!isPlainWord(word.raw)) return false;
    const basename = word.text.split(/[\\/]/).pop() ?? word.text;
    return basename === 'rm';
  });
}

/**
 * `rm`'s arguments, already dequoted, straight from the same word split that
 * found it. `RM_ARGS_RE` reads flags from the *raw* text
 * after a literal `rm `, so a quoted invocation like `"rm" -rf /x` was never
 * matched: the closing quote sits where the regex wants whitespace, the
 * match fails, and `-rf /x` is never seen at all. The word list has already
 * dequoted `"rm"` down to the plain word `rm` and split `-rf`/`/x` out as
 * their own words regardless of how `rm` itself was spelled, so slicing from
 * the word after it is both simpler and correct where the regex was not.
 */
function extractRmArgsFromWords(words: readonly DequotedWord[], rmIndex: number): string[] {
  return words.slice(rmIndex + 1).map((word) => word.text);
}

function extractRmArgs(segment: string): string[] {
  const match = RM_ARGS_RE.exec(segment);
  if (!match) return [];
  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
}

function isOutOfBoundsRemoval(
  args: readonly string[],
  repoRoot: string | null,
  policy: GuardrailPolicy,
): boolean {
  if (!hasRecursiveForce(args)) return false;
  return args.some((tok) => {
    if (tok.startsWith('-')) return false;
    return !isAllowedRemovalPath(normalizeRemovalPath(tok, repoRoot), policy);
  });
}

/**
 * Normalize an `rm` argument to a repo-root-relative path — the portable
 * replacement for guard.sh's `normalize_path`, which shelled out to
 * `realpath -m` when present and fell back to the raw string otherwise (no
 * `realpath` on a stock Windows install, which is one of the three named
 * reasons the guard hook needed WSL2). `path.resolve` needs no external
 * binary, and `path.relative` is `path.sep`-aware — unlike bash's `case
 * "$p" in "$REPO_ROOT"/*) … esac`, which only ever recognised `/` — so this
 * is also the fix for guard.sh's Windows-path-separator gap, not just its
 * missing-binary one.
 */
function normalizeRemovalPath(token: string, repoRoot: string | null): string {
  if (repoRoot === null) {
    // No repo root to make this relative to (guard.sh: `git rev-parse
    // --show-toplevel` failed, so `REPO_ROOT` was `''` and the `-n
    // "$REPO_ROOT"` guard skipped the prefix strip entirely). Absolutize
    // instead of returning the token as-is, so a bare relative token like
    // `workspaces` can never coincidentally read as an allowed root — the
    // same fail-closed behaviour bash got for free from comparing an
    // un-prefix-stripped absolute path against a bare `workspaces/*` glob.
    return path.resolve(token);
  }
  const absolute = path.resolve(repoRoot, token);
  const relative = path.relative(repoRoot, absolute);
  return relative === '' ? '.' : relative;
}

function isAllowedRemovalPath(normalizedPath: string, policy: GuardrailPolicy): boolean {
  const first = normalizedPath.split(path.sep)[0];
  // `path.relative` produces a leading `..` segment when the path climbs
  // above repoRoot, and an empty leading segment for an absolute path
  // (posix `/x` splits to `['', 'x']`) — neither is an allowed root name.
  return (
    first !== undefined &&
    first !== '' &&
    first !== '..' &&
    policy.allowedRemovalRoots.includes(first)
  );
}

/**
 * Whether `text` names `rm` outside `allowed_roots`, by itself — no chain
 * splitting, no wrapper unwrapping, just the three reads of one piece of
 * text: a disguised `rm` word anywhere is refused outright; a plain `rm`
 * word's flags come from the same word split that found it
 * (`extractRmArgsFromWords`), trusted directly; and the raw `RM_INVOKE_RE`
 * fallback — belt and braces for a spelling the word-level read might miss —
 * is read with less trust, since it is text `plainRmWordIndex` could not
 * place a word at. `RM_ARGS_RE` wants whitespace right after a literal `rm`,
 * so a quoted invocation like `"rm" -rf /x` leaves it with no match and
 * nothing to say was forced — handled for the plain-word case by reading
 * args from the words themselves, and for the raw-fallback case by failing
 * closed when it can find `rm` but not its flags, rather than reading
 * "found nothing" as "not forced".
 */
function rmOutOfBoundsInText(
  text: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
): boolean {
  const words = splitDequotedWords(text);
  if (hasDisguisedRmWord(words)) return true;
  const rmIndex = plainRmWordIndex(words);
  if (rmIndex !== -1) {
    return isOutOfBoundsRemoval(extractRmArgsFromWords(words, rmIndex), repoRoot, policy);
  }
  if (!RM_INVOKE_RE.test(text)) return false;
  const args = extractRmArgs(text);
  if (args.length === 0) return true;
  return isOutOfBoundsRemoval(args, repoRoot, policy);
}

/**
 * Rule 6's analogue of `checkForcePush`'s `isShellWrappedForceCandidate`: a
 * `-c` string handed to `sh`/`bash`/`zsh`/`env`, or `eval`, hides its payload
 * from a word-level read the same way it hides a force-push from rule 2 — a
 * pre-existing gap (`sh -c "rm -rf /x"` was allowed on every prior version).
 * Rather than parse the wrapped command a second time, hand the same
 * dequoted text back through `rmOutOfBoundsInText`: stripping every quote
 * character turns `sh -c "rm -rf /x"` into `sh -c rm -rf /x`, where `rm`
 * reads as an ordinary word like any other. A thin alias over
 * `dequoteShellWrappedSegment`, kept under this name since
 * `checkUnboundedRm`'s wrapped-`rm` pass below already reads by it.
 */
function shellWrappedRmPayload(segment: string): string | null {
  return dequoteShellWrappedSegment(segment);
}

/**
 * The index just past the quote that closes the one starting at `start`
 * (`text[start]` is `'` or `"`) — or `null` when the text ends first. Shared
 * by `findBalancedParenClose` and `findBacktickClose` so the two
 * substitution-delimiter scanners below read a quoted span inside a body the
 * same way, rather than a second copy of the same loop apiece.
 */
function skipQuotedSpan(text: string, start: number): number | null {
  if (text[start] === "'") {
    const end = text.indexOf("'", start + 1);
    return end === -1 ? null : end + 1;
  }
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === '\\' && i + 1 < text.length ? 2 : 1;
  }
  return i < text.length ? i + 1 : null;
}

const HERE_DOC_OPENER_RE = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w.-]+))/;

interface HereDoc {
  delimiter: string;
  strip: boolean;
  quoted: boolean;
}

/**
 * The here-document step the scanners share: a `<<` opener is recorded in
 * `pending`; at the line's newline the bodies are skipped and unquoted ones
 * pushed onto `unquoted`. Returns -1 for a body that never closes, `i` for neither.
 */
function hereDocStep(text: string, i: number, pending: HereDoc[], unquoted: string[]): number {
  if (text.startsWith('<<', i) && text.charAt(i + 2) !== '<') {
    const opener = HERE_DOC_OPENER_RE.exec(text.slice(i));
    if (opener === null) return i;
    const [all, strip, single, double, bare] = opener;
    pending.push({
      delimiter: single ?? double ?? bare ?? '',
      strip: strip === '-',
      quoted: bare === undefined || all.includes('\\'),
    });
    return i + all.length;
  }
  if (text.charAt(i) !== '\n' || pending.length === 0) return i;
  let pos = i + 1;
  for (const { delimiter, strip, quoted } of pending.splice(0)) {
    const lines: string[] = [];
    for (;;) {
      if (pos >= text.length) return -1;
      const lineEnd = text.indexOf('\n', pos);
      const line = text.slice(pos, lineEnd === -1 ? text.length : lineEnd);
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
      lines.push(line);
    }
    if (!quoted) unquoted.push(lines.join('\n'));
  }
  return pos;
}

/**
 * The index of the `)` that balances the `(` just before `start` — or `null`
 * when the text ends first, the same "cannot delimit this with confidence"
 * signal `topLevelCommands` falls back on for an unbalanced paren. A quoted
 * span inside the body is skipped whole (`skipQuotedSpan`), so a literal
 * `)` inside an argument, like the one in `$(echo ")")`, is never mistaken
 * for the substitution's own close.
 */
function findBalancedParenClose(text: string, start: number): number | null {
  let depth = 1;
  let i = start;
  const pending: HereDoc[] = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    const afterDoc = hereDocStep(text, i, pending, []);
    if (afterDoc !== i) {
      if (afterDoc === -1) return null;
      i = afterDoc;
      continue;
    }
    if (c === "'" || c === '"') {
      const next = skipQuotedSpan(text, i);
      if (next === null) return null;
      i = next;
      continue;
    }
    if (c === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * The index of the unescaped backtick that closes a backtick substitution
 * starting at `start` — reading through a quoted span the same way
 * `findBalancedParenClose` does, so a backtick inside a quoted argument
 * never ends the span early. `null` when no close is found before the text
 * ends.
 */
function findBacktickClose(text: string, start: number): number | null {
  let i = start;
  const pending: HereDoc[] = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    const afterDoc = hereDocStep(text, i, pending, []);
    if (afterDoc !== i) {
      if (afterDoc === -1) return null;
      i = afterDoc;
      continue;
    }
    if (c === "'" || c === '"') {
      const next = skipQuotedSpan(text, i);
      if (next === null) return null;
      i = next;
      continue;
    }
    if (c === '`') return i;
    i += 1;
  }
  return null;
}

/**
 * Every command substitution (`$(...)`), backtick substitution, and process
 * substitution (`<(...)`/`>(...)`) body in `segment` — the shell still runs
 * each of these while it builds an allowlisted command's argv, which
 * `isUnknownRemovalSegment`'s first-word allowlist does not account for on
 * its own: `cp` cannot run a second program from one of its own
 * *arguments*, but `echo $(X=rm; $X -rf /x)` never puts anything dangerous
 * in an argument — the shell runs `$X -rf /x` as a command in its own right
 * to decide what `echo` should print. A body inside single quotes is not a
 * substitution at all, since single quotes suppress every expansion, so
 * that span is skipped rather than read; one inside double quotes still
 * runs and is read the same as an unquoted one.
 *
 * Reads as a small quote-state machine — unquoted, single-quoted or
 * double-quoted — rather than `skipQuotedSpan`'s "skip the whole span" read
 * the two delimiter finders above use: a single-quoted span truly has
 * nothing left to find inside it, but a double-quoted one still runs a
 * `$(...)` or backtick substitution this scan must keep recognising, so it
 * cannot be skipped whole. The one thing double quotes change inside their
 * own span is that `'` is just a character, not a span of its own — an
 * apostrophe in `"it's $(...)"` used to be read as opening a fresh
 * single-quoted span, which this text never closes, so the whole scan gave
 * up and returned `null` for a segment that was perfectly readable. Process
 * substitution (`<(`/`>(`) is the other thing double quotes change: they
 * suppress it, so it is only recognised unquoted, matching
 * `shellExpandsPayload`'s read of the same two forms for rule 4's message
 * payload. A backslash escapes the next character in either the unquoted or
 * the double-quoted state, the same as a real shell. `$((` arithmetic is
 * left exactly as it reads today: this scan does not special-case it, so it
 * is still found as a `$(` whose body happens to start with its own `(`.
 *
 * `null` means some substitution in `segment` could not be delimited with
 * confidence — an unterminated quote or an unbalanced paren — so the caller
 * reads that as "cannot prove this is safe", not "found nothing".
 */
function extractSubstitutionBodies(segment: string, hereDocBody = false): string[] | null {
  const bodies: string[] = [];
  const pending: HereDoc[] = [];
  const unquoted: string[] = [];
  let i = 0;
  // The text of an unquoted here-document body reads like double-quoted text
  // whose quotes are literal: only its substitutions are live.
  let inDouble = hereDocBody;
  while (i < segment.length) {
    const c = segment[i];
    if (c === '\\' && i + 1 < segment.length) {
      i += 2;
      continue;
    }
    const afterDoc = inDouble ? i : hereDocStep(segment, i, pending, unquoted);
    if (afterDoc !== i) {
      if (afterDoc === -1) return null;
      for (const text of unquoted.splice(0)) {
        const inner = extractSubstitutionBodies(text, true);
        if (inner === null) return null;
        bodies.push(...inner);
      }
      i = afterDoc;
      continue;
    }
    if (!inDouble && c === "'") {
      const next = skipQuotedSpan(segment, i);
      if (next === null) return null;
      i = next;
      continue;
    }
    if (c === '"' && !hereDocBody) {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (c === '$' && segment[i + 1] === '(') {
      const close = findBalancedParenClose(segment, i + 2);
      if (close === null) return null;
      bodies.push(segment.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (c === '`') {
      const close = findBacktickClose(segment, i + 1);
      if (close === null) return null;
      bodies.push(segment.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (!inDouble && (c === '<' || c === '>') && segment[i + 1] === '(') {
      const close = findBalancedParenClose(segment, i + 2);
      if (close === null) return null;
      bodies.push(segment.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return bodies;
}

/**
 * Whether `segment` carries a removal the shell would run while building
 * another command's argv, even one behind a plain, allowlisted first word —
 * the gap a re-review found in `isUnknownRemovalSegment`'s allowlist: `echo`
 * cannot run a second program from an *argument*, but
 * `echo $(X=rm; $X -rf /x)` has the shell run `$X -rf /x` as a command in
 * its own right before `echo` ever sees a value to print. Each substitution
 * body found by `extractSubstitutionBodies` is checked as a full command
 * line of its own, by recursing into `isUnboundedRemovalCommand` — the same
 * literal-`rm`, unknown-word and nested-shell reads it runs on the outer
 * command — so a substitution nested inside a body is caught by that same
 * recursive call rather than a second extraction pass here.
 *
 * A body this scanner cannot delimit with confidence (an unbalanced paren, a
 * quote that never closes) is not read as "found nothing": the segment is
 * refused outright when it carries a recursive-force flag cluster anywhere
 * in its raw text, the same shape `isUnknownRemovalSegment` already refuses
 * an unreadable word for — read as a substring of the untouched text
 * (`hasRecursiveForceInText`), not a dequoted word list, because the same
 * quoting that defeated delimiting also defeats a clean word split: an
 * apostrophe stranded inside an unresolved double-quoted span is exactly
 * what left this body undelimitable in the first place, so the one word
 * list `splitDequotedWords` would produce here cannot be trusted either.
 *
 * `depth` counts how many substitution bodies deep this call already is —
 * zero at the outermost command, one past the first `$(...)`/backtick/
 * process substitution, and so on as each body recurses into
 * `isUnboundedRemovalCommand` below. Nesting is attacker-controlled and
 * unbounded (`$($($(...)))`), and following it one JS stack frame per level
 * throws past a few hundred levels — so once `depth` reaches
 * `MAX_SUBSTITUTION_DEPTH`, extraction stops outright rather than reading
 * whatever raw text is left: nesting sixteen levels deep is never a
 * legitimate agent command, and a check this far past the point it can
 * actually read the body has nothing to vouch for it with. Refusing here
 * does not depend on `hasRecursiveForceInText` finding anything — it denies
 * on depth alone, the same way an undelimitable body used to read as "found
 * nothing" if it happened to carry no flags. That keeps both the call stack
 * and the work done bounded, however deep the nesting actually goes.
 */
const MAX_SUBSTITUTION_DEPTH = 16;

function hasUnsafeSubstitution(
  segment: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
  depth = 0,
): boolean {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return true;
  const bodies = extractSubstitutionBodies(segment);
  if (bodies === null) return hasRecursiveForceInText(segment);
  return bodies.some((body) => isUnboundedRemovalCommand(body, repoRoot, policy, depth + 1));
}

/**
 * Plain first words that cannot hand their later arguments to another
 * program — the allowlist that keeps the every-word scan below from
 * refusing ordinary commands whose own flags happen to spell `-rf`/`-Rf`:
 * `cp -rf "$SRC" dst`, `ls -rf $DIR`, `chmod -Rf 755 $DIR`. None of these
 * runs a second program from an argument the way a wrapper (`sudo`, `env`,
 * `xargs`, `timeout 5`, a bare `VAR=val` prefix, …) or a nested shell can, so
 * an unreadable word later in the same line carries no risk here. `rm`
 * itself is deliberately left out of this set: a plain `rm` or `/bin/rm`
 * first word is exempted the same way, but keeps the allowed-roots analysis
 * above instead of skipping straight to "allowed" — see
 * `isUnknownRemovalSegment`.
 */
const REMOVAL_SAFE_FIRST_WORDS = new Set([
  'cp',
  'mv',
  'ls',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'mkdir',
  'touch',
  'cat',
  'echo',
  'printf',
  'grep',
]);

/**
 * Rule 6's gap once some word of the segment is unreadable: neither
 * `hasDisguisedRmWord` (which still needs a word's basename to resolve to
 * the literal `rm`) nor the rest of `rmOutOfBoundsInText` (which needs to
 * find an `rm` word at all) can place a word that only resolves to `rm` once
 * a shell expands `$X`, `$(...)` or a backtick span — this file never
 * evaluates one of those. So when any word of the segment is unreadable this
 * way (`isUnexpandedCommandWord`), the rest of it is read for the one shape
 * this rule already guards against: a recursive-force flag cluster
 * (`hasRecursiveForce`, the same flag parsing the plain-`rm` path above
 * uses). Resolving the expansion itself is out of scope — an open-ended
 * evaluator is the wrong tool — so this is shape only.
 *
 * Every word is scanned, not just the one in command position: a wrapper, a
 * group (`( … )`), or a keyword (`{ … }`, `if … then … fi`) can all sit in
 * front of the unreadable word without moving it out of the segment. That
 * widens what trips the check, so a first word that is plain and cannot run
 * another program (`REMOVAL_SAFE_FIRST_WORDS`), or dequotes to the literal
 * `rm`/`/bin/rm`, is exempted — anything else in first position, including
 * an unrecognised command, falls through to the refusal. Fail-closed over
 * precise, same direction as every other read in this file.
 *
 * Checked before any of that: `hasUnsafeSubstitution`. The allowlist above
 * only says a plain first word cannot run another program from its own
 * *arguments* — it says nothing about a command or process substitution
 * sitting in one of those arguments, which the shell still runs as a
 * command in its own right while it builds the argv. `echo $(X=rm; $X -rf
 * /x)` is exactly `echo`'s shape and nothing else, so the allowlist alone
 * would wave it through; the substitution check below is what actually
 * reads what the shell runs before `echo` sees a value to print.
 */
function isUnknownRemovalSegment(
  segment: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
  depth = 0,
): boolean {
  if (hasUnsafeSubstitution(segment, repoRoot, policy, depth)) return true;
  const words = splitDequotedWords(segment);
  const first = words[0];
  if (first !== undefined && isPlainWord(first.raw)) {
    const basename = first.text.split(/[\\/]/).pop() ?? first.text;
    if (basename === 'rm' || REMOVAL_SAFE_FIRST_WORDS.has(basename)) return false;
  }
  if (!words.some((word) => isUnexpandedCommandWord(word))) return false;
  return hasRecursiveForce(words.map((word) => word.text));
}

/**
 * Reads `topLevelCommands`, not `splitChainSegments`: the naive
 * single-character split above cuts `$(echo rm) -rf /x` apart at the very
 * `(`/`)`/backtick that make the word unreadable, landing the flag cluster
 * in a different "segment" than the word it belongs to and missing the
 * combination entirely.
 *
 * Each top-level segment is also checked as a nested shell's dequoted
 * payload (`sh -c '…'`, `bash -c "…"`, `eval '…'`): `splitDequotedWords`
 * keeps a quoted span's internal text as one word, which hides a `-rf`
 * token as a standalone token until the quotes are gone — see
 * `dequoteShellWrappedSegment`.
 */
function hasUnknownRemovalCommandWord(
  command: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
  depth = 0,
): boolean {
  return topLevelCommands(command).some((segment) => {
    if (isUnknownRemovalSegment(segment, repoRoot, policy, depth)) return true;
    const wrapped = dequoteShellWrappedSegment(segment);
    return wrapped !== null && isUnknownRemovalSegment(wrapped, repoRoot, policy, depth);
  });
}

/**
 * Rule 6's boolean core, pulled out of `checkUnboundedRm` so
 * `hasUnsafeSubstitution` can run the exact same check on a substitution
 * body: the literal-`rm` path (every chain segment read for a disguised or
 * plain `rm` outside `allowed_roots`) plus the unknown-word path
 * (`hasUnknownRemovalCommandWord`, which already folds in the nested-shell
 * path). `command` here is "a command line of its own" in the brief's
 * words — it may be the whole tool call, or it may be the text found inside
 * someone else's `$(...)`.
 *
 * Checks every chain segment independently, not just the first `rm` in the
 * whole command. guard.sh's own `grep -Eo 'rm[[:space:]]+[^;&|]*'` — and this
 * function, until an earlier fix — stopped at the first match in the *whole*
 * command string, so `rm -rf workspaces/a; rm -rf src/important` read
 * `workspaces/a` (allowed), decided the command was fine, and never looked
 * at `src/important` at all. That is a deliberate behaviour change from a
 * straight port: closing a chained-command bypass that guard.sh always had,
 * not carrying it forward with new spelling.
 */
function isUnboundedRemovalCommand(
  command: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
  depth = 0,
): boolean {
  const outOfBounds = splitChainSegments(command).some((segment) => {
    const decoded = decodeAnsiCQuoting(segment);
    // An unterminated `$'` span cannot be decoded with confidence — fail
    // closed rather than guess at what it hides, the same direction
    // `checkForcePush` takes for the same construct.
    if (decoded.unterminated) return /\brm\b/i.test(segment);
    if (rmOutOfBoundsInText(decoded.text, repoRoot, policy)) return true;
    const wrapped = shellWrappedRmPayload(decoded.text);
    return wrapped !== null && rmOutOfBoundsInText(wrapped, repoRoot, policy);
  });
  return outOfBounds || hasUnknownRemovalCommandWord(command, repoRoot, policy, depth);
}

/**
 * Rule 6: a recursive-force `rm` outside `allowed_roots`, however the two
 * flags are spelled (see `hasRecursiveForce`) — see
 * `isUnboundedRemovalCommand` for the check itself.
 */
function checkUnboundedRm(
  command: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  if (!isUnboundedRemovalCommand(command, repoRoot, policy)) return null;
  return violation(requireRule(policy, 'unbounded-rm'));
}

// ---------------------------------------------------------------------------
// judge sandbox — rules that apply only while a lease is open (sandbox.ts)
// ---------------------------------------------------------------------------

/**
 * Does `segment` invoke `word` as a command?
 *
 * Looser than "first token" (so `xargs curl …` and `sudo rm …` still match)
 * but stricter than the bare `\b<word>\b` the git matchers use, because
 * these lists contain two-letter words: `\bnc\b` matches inside `src/nc/`,
 * and a judge running `grep -r x src/nc/` being told it has no network
 * access is the kind of false refusal that gets a guard switched off.
 * Requiring whitespace or a chain separator on the left, and whitespace or
 * end-of-segment on the right, keeps path components out while keeping every
 * real invocation in.
 */
function hasCommandWord(segment: string, word: string): boolean {
  return new RegExp(`(^|[;&|(]|\\s)${escapeRegExp(word)}(\\s|$)`, 'i').test(segment);
}

/** `<command> … <one of subcommands>` within a single chain segment. */
function hasCommandSubcommand(segment: string, spec: DeployCommandSpec): boolean {
  if (!hasCommandWord(segment, spec.command)) return false;
  return spec.subcommands.some((sub) =>
    new RegExp(`\\b${escapeRegExp(sub)}\\b`, 'i').test(segment),
  );
}

/**
 * Remove heredoc bodies before looking for redirections.
 *
 * A judge's one legitimate write is its verdict, and the way an agent with
 * no `Write` tool produces a JSON file is `cat > state/results/x.json
 * <<'JSON' … JSON`. The body of that heredoc is prose the judge wrote, and
 * prose contains `>`. Without this, a finding that says "expected > 0"
 * parses as a redirection to a file named `0`, which is not under a write
 * root, and the judge is refused permission to file its own report. Strips
 * from the line introducing the delimiter to the line that closes it, or to
 * the end when it is never closed.
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const match = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (match) delimiter = match[1] ?? match[2] ?? match[3] ?? null;
  }
  return kept.join('\n');
}

/**
 * Targets of `>`/`>>` redirections. `2>&1` and friends are excluded by the
 * `(?!&)` lookahead — a duplicated file descriptor is not a path.
 */
const REDIRECT_TARGET_RE = />>?\s*(?!&)([^\s;&|<>]+)/g;

function redirectTargets(command: string): string[] {
  const targets: string[] = [];
  for (const match of stripHeredocBodies(command).matchAll(REDIRECT_TARGET_RE)) {
    const token = (match[1] ?? '').replace(/^["']/, '').replace(/["']$/, '');
    if (token !== '') targets.push(token);
  }
  return targets;
}

/** Non-flag arguments following `word` in `segment`, i.e. the paths a `mkdir`/`tee`/`touch` will write. */
function argumentsAfter(segment: string, word: string): string[] {
  const tokens = segment.trim().split(/\s+/);
  const index = tokens.findIndex((t) => t.toLowerCase() === word.toLowerCase());
  if (index === -1) return [];
  return tokens
    .slice(index + 1)
    .filter((t) => t !== '' && !t.startsWith('-'))
    .map((t) => t.replace(/^["']/, '').replace(/["']$/, ''));
}

/**
 * Is a repo-root-relative path inside one of `write_roots`?
 *
 * Segment-wise rather than string-prefix, so `state/results-of-mine` does
 * not read as inside `state/results`. Equality counts (`mkdir -p
 * state/results` is a judge preparing to write its verdict), and anything
 * that climbed above the repo root — `path.relative` renders that with a
 * leading `..`, and an absolute path with a leading empty segment — does
 * not.
 */
function isUnderWriteRoot(normalizedPath: string, roots: readonly string[]): boolean {
  const parts = normalizedPath.split(path.sep);
  if (parts[0] === undefined || parts[0] === '' || parts[0] === '..') return false;
  return roots.some((root) => {
    const rootParts = root.split('/').filter((p) => p !== '');
    return parts.length >= rootParts.length && rootParts.every((p, i) => parts[i] === p);
  });
}

/**
 * A probe segment appended to a path to ask "would anything *inside* this
 * directory be in scope?" — see `isWithinWriteScope`.
 */
const SCOPE_PROBE = '__scope_probe__';

/** Repo-root-relative, posix-separated — the shape `write_globs` are written in. */
function toRepoRelativePosix(token: string, repoRoot: string | null): string {
  return normalizeRemovalPath(token, repoRoot).split(path.sep).join('/');
}

/**
 * Is a repo-root-relative path inside a role's write scope?
 *
 * Globs rather than `write_roots`' path prefixes, because a tester's scope is
 * not a directory: a double-star test-file pattern is a shape, and the files
 * it names sit beside the implementation they cover.
 *
 * A directory counts as in scope when something inside it would be, which is
 * what the probe asks: `mkdir -p factory/orchestrator/test/fixtures` is a
 * tester preparing to write fixtures, and refusing it would be a false deny
 * — the kind that teaches an agent to route around the gate rather than
 * trust it. A path that climbed above the repo root (`path.relative` renders
 * that with a leading `..`, an absolute path with a leading empty segment)
 * is never in scope, whatever the globs say.
 */
function isWithinWriteScope(normalizedPath: string, globs: readonly string[]): boolean {
  const first = normalizedPath.split('/')[0];
  if (first === undefined || first === '' || first === '..' || normalizedPath === '.') return false;
  const isMatch = picomatch([...globs], { dot: true });
  return isMatch(normalizedPath) || isMatch(`${normalizedPath}/${SCOPE_PROBE}`);
}

/** `{role}` and `{write_roots}` in a judge rule's reason, same placeholder convention as `{branch}`. */
function renderSandboxReason(
  template: string,
  lease: SandboxLease,
  policy: GuardrailPolicy,
): string {
  return template
    .replace('{role}', lease.role)
    .replace('{write_roots}', policy.judgeSandbox.writeRoots.join(' or '));
}

function sandboxViolation(
  policy: GuardrailPolicy,
  id: GuardrailRuleId,
  lease: SandboxLease,
): PolicyViolation {
  const rule = requireRule(policy, id);
  return violation(rule, renderSandboxReason(rule.reason, lease, policy));
}

/** Judge rule 1: no outbound access — network clients, remote git, package installs. */
function checkJudgeNetwork(
  command: string,
  lease: SandboxLease,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  const { networkCommands, networkSubcommands } = policy.judgeSandbox;
  const reaches = splitChainSegments(command).some(
    (segment) =>
      networkCommands.some((word) => hasCommandWord(segment, word)) ||
      networkSubcommands.some((spec) => hasCommandSubcommand(segment, spec)),
  );
  return reaches ? sandboxViolation(policy, 'judge-network', lease) : null;
}

/**
 * Judge rule 2: the only write a judge may make is a redirection into a
 * write root.
 *
 * Four shapes, deliberately not unified. A file tool names its target
 * outright, so it is checked directly (judges hold no `Edit`/`Write` today,
 * but the rule answers for the role, not for the tool it reached for). A redirection has one readable
 * target, so it is checked against the allowlist. `mkdir`/`tee`/`touch` take
 * nothing but targets, so every non-flag argument is checked. Everything
 * else that writes is refused outright rather than path-checked, because
 * deciding which token of `cp a b` is the target — or of `install -m 644 a b
 * c` — is more machinery than the zero legitimate cases justify.
 */
function checkJudgeWrite(
  command: string,
  filePath: string | null,
  lease: SandboxLease,
  repoRoot: string | null,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  const { writeRoots, targetWriteCommands, refusedWriteCommands, gitWriteSubcommands } =
    policy.judgeSandbox;
  const outOfBounds = (token: string): boolean =>
    !isUnderWriteRoot(normalizeRemovalPath(token, repoRoot), writeRoots);

  if (filePath !== null && filePath !== '' && outOfBounds(filePath)) {
    return sandboxViolation(policy, 'judge-write', lease);
  }
  if (redirectTargets(command).some(outOfBounds)) {
    return sandboxViolation(policy, 'judge-write', lease);
  }
  const stripped = stripHeredocBodies(command);
  const writes = splitChainSegments(stripped).some((segment) => {
    if (refusedWriteCommands.some((word) => hasCommandWord(segment, word))) return true;
    if (/\bsed\b[^;&|]*\s-i(\.[^\s]*)?(\s|$)/i.test(segment)) return true;
    if (
      hasCommandWord(segment, 'git') &&
      gitWriteSubcommands.some((sub) => new RegExp(`\\b${escapeRegExp(sub)}\\b`, 'i').test(segment))
    ) {
      return true;
    }
    return targetWriteCommands.some(
      (word) => hasCommandWord(segment, word) && argumentsAfter(segment, word).some(outOfBounds),
    );
  });
  return writes ? sandboxViolation(policy, 'judge-write', lease) : null;
}

/**
 * Blank out quoted spans before scanning a segment for command words.
 *
 * Only the write-scope rule needs this *blanket* form — the six base rules
 * take the narrower `stripMessageFlagValues` above, which spares a quoted ref.
 * The write-scope rule needs the wider net because the role it governs
 * commits: `git commit -m "test: cover the restore path"` is a tester doing
 * exactly what its output contract asks, and refusing it because the message
 * says "restore" is the same class of false deny as refusing `git merge-base`
 * — the kind that teaches an agent to route around the gate rather than
 * trust it. A quoted span is an argument, never a command word.
 *
 * Replaced rather than deleted, so token boundaries survive. Targets keep
 * being read off the unstripped segment, since `tee "state/results/x"` is a
 * write whose target happens to be quoted.
 */
function stripQuotedSpans(segment: string): string {
  return segment.replace(/"[^"]*"|'[^']*'/g, '""');
}

/** `{role}` and `{write_globs}` in the role-write-scope rule's reason. */
function scopeViolation(
  policy: GuardrailPolicy,
  lease: SandboxLease,
  scope: RoleWriteScope,
): PolicyViolation {
  const rule = requireRule(policy, 'role-write-scope');
  return violation(
    rule,
    rule.reason.replace('{role}', lease.role).replace('{write_globs}', scope.writeGlobs.join(', ')),
  );
}

/**
 * Role rule: a write-scoped role writes inside its globs and nowhere else.
 *
 * The shapes mirror `checkJudgeWrite`, with two differences that follow from
 * the role actually being allowed to write. `rm` is path-checked rather than
 * refused, because deleting a stale test is ordinary tester work and its
 * arguments are all targets. `git add`/`commit` stay allowed, because the
 * tester's output contract *requires* a commit on the task branch — only the
 * git subcommands that change tracked content without passing a path check
 * (`apply`, `checkout`, `reset`, …) are refused, since those would put the
 * implementation back under the tester's control by the back door.
 *
 * `sed -i` and the verbs in `refused_commands` are refused outright for the
 * same reason the judge refuses them: deciding which token of `cp a b` is
 * the target is more machinery than the legitimate cases justify, and here
 * the role has `Edit` and `Write`, which *are* path-checked, as the better
 * route to the same edit.
 *
 * The known limit is the judge sandbox's, unchanged: this reads command
 * text, not intent. A write smuggled through an interpreter is invisible to
 * it, which is why `smith worktree fingerprint`/`verify` stays behind it.
 */
function checkRoleWriteScope(
  command: string,
  filePath: string | null,
  lease: SandboxLease,
  repoRoot: string | null,
  policy: GuardrailPolicy,
  scope: RoleWriteScope,
): PolicyViolation | null {
  const outOfScope = (token: string): boolean =>
    !isWithinWriteScope(toRepoRelativePosix(token, repoRoot), scope.writeGlobs);

  if (filePath !== null && filePath !== '' && outOfScope(filePath)) {
    return scopeViolation(policy, lease, scope);
  }
  if (redirectTargets(command).some(outOfScope)) {
    return scopeViolation(policy, lease, scope);
  }
  // Which verbs take nothing but targets is a fact about the verbs, not
  // about the role, so the judge sandbox's list is reused rather than
  // restated once per scope. `rm` joins them here only.
  const targetVerbs = [...policy.judgeSandbox.targetWriteCommands, 'rm'];
  const stripped = stripHeredocBodies(command);
  const writes = splitChainSegments(stripped).some((segment) => {
    const words = stripQuotedSpans(segment);
    if (scope.refusedCommands.some((word) => hasCommandWord(words, word))) return true;
    if (/\bsed\b[^;&|]*\s-i(\.[^\s]*)?(\s|$)/i.test(words)) return true;
    if (scope.refusedGitSubcommands.some((sub) => isGitSubcommand(words, sub))) return true;
    return targetVerbs.some(
      (word) => hasCommandWord(segment, word) && argumentsAfter(segment, word).some(outOfScope),
    );
  });
  return writes ? scopeViolation(policy, lease, scope) : null;
}

/**
 * Judge rule 3: a judge does not touch its own lease.
 *
 * Without this the sandbox would be one `bs sandbox close` (or its
 * deprecated `smith` alias) away from being off, and
 * `rm state/sandboxes/<hash>.json` is a removal under `state/`, which the
 * `unbounded-rm` rule above explicitly permits. The refusal is unconditional on the lease directory rather than scoped to
 * *this* lease: reading another judge's lease is no more a judge's business
 * than deleting its own.
 */
function checkJudgeSandboxEscape(
  command: string,
  lease: SandboxLease,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  const escapes = splitChainSegments(command).some((segment) => {
    if (/state[\\/]sandboxes/i.test(segment)) return true;
    if (!/\bsandbox\b/i.test(segment)) return false;
    return (
      hasCommandWord(segment, 'bs') ||
      hasCommandWord(segment, 'smith') ||
      hasCommandWord(segment, 'node') ||
      /\bcli\.js\b/i.test(segment)
    );
  });
  return escapes ? sandboxViolation(policy, 'judge-sandbox-escape', lease) : null;
}

/**
 * The guard hook's decision for one tool call: every guardrails.yml rule
 * that fires, not just the first (an agent — or an operator reading the
 * denial — should see every reason at once, the same way `smith check` does
 * for gate failures). Only tools in `INSPECTED_TOOLS` (a shell command) or
 * `INSPECTED_FILE_TOOLS` (a target path) are evaluated; every other tool
 * call, an empty command and an absent path all allow trivially.
 */
export function evaluateCommand(
  context: PolicyContext,
  policy: GuardrailPolicy = loadGuardrailPolicy(),
): PolicyDecision {
  const inspectsCommand = INSPECTED_TOOLS.includes(context.toolName);
  const inspectsPath = INSPECTED_FILE_TOOLS.includes(context.toolName);
  const filePath = inspectsPath ? (context.filePath ?? null) : null;
  if (!inspectsCommand && !inspectsPath) return { allowed: true, violations: [] };
  if (inspectsCommand && context.command.trim() === '') {
    return { allowed: true, violations: [] };
  }
  if (inspectsPath && (filePath === null || filePath.trim() === '')) {
    return { allowed: true, violations: [] };
  }
  const { command, branch, repoRoot } = context;
  // The six base rules look for refs and command words, so they read the
  // command with its message payloads blanked — see `stripMessageFlagValues` —
  // and with the payload of a `policy check` question blanked too, since
  // asking what a rule says is not doing the thing it says no to.
  // The lease rules below keep the raw string: they read *targets* off the
  // command, and `-m` is not always prose down there (`mkdir -m 755 <dir>`
  // spends it on a mode), so blanking it could put an empty token where a
  // path belongs.
  // Outermost quoting wins, so the question is blanked before the message
  // payloads inside it are looked at: `policy check --command 'git commit -m
  // "…"'` is one inert span, not a commit with a message.
  const scanned = stripMessageFlagValues(stripPolicyCheckPayloads(joinLineContinuations(command)));
  const checks: Array<() => PolicyViolation | null> = [
    () => checkPushToProtected(scanned, branch, policy),
    () => checkForcePush(scanned, policy) ?? checkForcePush(command, policy, 0, true),
    () => checkMergeIntoProtected(scanned, branch, policy),
    () => checkDeployCommand(scanned, policy),
    () => checkHistoryRewriteOnProtected(scanned, branch, policy),
    () => checkUnboundedRm(scanned, repoRoot, policy),
  ];
  // The judge rules are additive: a judge is bound by everything an ordinary
  // session is bound by, and by these on top. They are appended rather than
  // substituted so there is no arrangement of leases under which a command
  // is checked by fewer rules than it would have been with no lease at all.
  const lease = context.sandbox ?? null;
  if (lease !== null) {
    // One rule set per lease, selected by role. A role with no declared
    // write scope gets the judge rules — that covers the six judge roles
    // and, deliberately, anything unrecognised: `--role coder` is either a
    // typo or an attempt to pick a rule set, and the strictest set is the
    // safe answer to both. sandbox.ts refuses the unknown role outright at
    // lease time; this is the second line, for a lease file written by hand.
    const scope = policy.roleWriteScopes.find((s) => s.role === lease.role) ?? null;
    if (scope === null) {
      checks.push(
        () => checkJudgeNetwork(command, lease, policy),
        () => checkJudgeWrite(command, filePath, lease, repoRoot, policy),
      );
    } else {
      checks.push(() => checkRoleWriteScope(command, filePath, lease, repoRoot, policy, scope));
    }
    // Not role-dependent: a lease a leaseholder can lift is not a lease,
    // whichever rule set the role draws the rest of its bounds from.
    checks.push(() => checkJudgeSandboxEscape(command, lease, policy));
  }
  const violations = checks.map((check) => check()).filter((v): v is PolicyViolation => v !== null);
  return { allowed: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// git-derived context — used by `smith policy check` when --branch is not given
// ---------------------------------------------------------------------------

/** `git rev-parse --abbrev-ref HEAD`, or `''` outside a git repo / on a fresh repo with no commits — mirrors guard.sh's `current_branch()`. */
export function detectCurrentBranch(cwd: string = REPO_ROOT): string {
  try {
    return runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return '';
  }
}

/** `git rev-parse --show-toplevel`, or `null` outside a git repo — mirrors guard.sh's inline `REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '')"`. */
export function detectRepoRoot(cwd: string = REPO_ROOT): string | null {
  try {
    return runGit(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}
