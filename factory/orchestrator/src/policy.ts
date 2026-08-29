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
  readonly allowedRemovalRoots: readonly string[];
  readonly deployCommands: readonly DeployCommandSpec[];
  readonly judgeSandbox: JudgeSandboxPolicy;
  /** Roles whose lease narrows their writes to a glob set instead of forbidding writes outright. */
  readonly roleWriteScopes: readonly RoleWriteScope[];
  /** Keyed by rule id (`push-to-protected`, etc.) — every id in `REQUIRED_RULE_IDS` is guaranteed present. */
  readonly rules: ReadonlyMap<string, GuardrailRule>;
}

interface RawGuardrailsYaml {
  protected_branches?: { names?: unknown; patterns?: unknown };
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
 */
const REQUIRED_RULE_IDS = [
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

/** Fold one `rules:` list into the shared id-keyed map. Used for the top-level list and the judge_sandbox one. */
function collectRules(raw: unknown, into: Map<string, GuardrailRule>, key: string): void {
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
  collectRules(doc.rules, rules, 'rules');
  collectRules(rawSandbox.rules, rules, 'judge_sandbox.rules');
  collectRules(rawScopes.rules, rules, 'role_write_scopes.rules');
  for (const requiredId of REQUIRED_RULE_IDS) {
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
  const match = new RegExp(`${bareWord('push')}(.*)$`, 'i').exec(segment);
  if (!match) return [];
  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && !t.startsWith('-'))
    .map((t) => t.replace(/^["']/, '').replace(/["']$/, ''));
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

function isProtectedBranchName(branch: string, policy: GuardrailPolicy): boolean {
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

function renderBranch(template: string, branch: string): string {
  return template.replace('{branch}', branch);
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
const INSPECTED_TOOLS: readonly string[] = ['Bash'];

/**
 * Tools whose `file_path` this policy inspects — the write path that does
 * not go through a shell. Nothing here has a command to match, so only the
 * lease rules can fire on them; the base six are all about shell commands
 * and no-op on an empty one.
 */
const INSPECTED_FILE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function requireRule(policy: GuardrailPolicy, id: string): GuardrailRule {
  const rule = policy.rules.get(id);
  if (!rule) {
    // Unreachable once a policy has passed parseGuardrailPolicy (which
    // requires every id in REQUIRED_RULE_IDS) — this is a defensive
    // safety-net, not a real code path.
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
 * merge "main"` is still a merge into main and `wrangler "deploy"` is still a
 * deploy. Hiding a real target in here would mean passing it where git reads
 * prose, which costs the target its meaning — so the blanking buys no way past
 * any rule.
 *
 * Narrow in three more ways, each one a place where `-m` is not prose:
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
 * - **The flag must be followed by `=` or whitespace**, so `-m"main"` is left
 *   alone rather than treated as a message.
 *
 * The value is blanked rather than deleted, so token boundaries survive for
 * the scans that read the last token of a segment.
 */
const MESSAGE_FLAG_RE = /(^|\s)(-m|--message)(=|\s+)("[^"]*"|'[^']*'|\S+)/g;

/** The git subcommands whose `-m`/`--message` takes free text, and nothing else. */
const MESSAGE_SUBCOMMANDS = ['commit', 'merge', 'tag', 'stash', 'notes'];

function stripMessageFlagValues(command: string): string {
  // Split keeping the separators, so the segments can be rejoined untouched.
  return command
    .split(/([;&|])/)
    .map((segment) =>
      MESSAGE_SUBCOMMANDS.some((sub) => isGitSubcommand(segment, sub))
        ? segment.replace(MESSAGE_FLAG_RE, '$1$2$3""')
        : segment,
    )
    .join('');
}

/** Rule 1: push to main/master — destination ref, checked precisely; or a bare push while already on a protected branch. */
function checkPushToProtected(
  command: string,
  branch: string,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  if (!isGitSubcommand(command, 'push')) return null;
  const rule = requireRule(policy, 'push-to-protected');
  const pushSegments = gitSegmentsFor(command, 'push');
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

/** Rule 2: force push (`--force` / `--force-with-lease` / `-f`). Case-sensitive, same as guard.sh (its `grep -Eq` has no `-i`). */
const FORCE_PUSH_RE = /(--force(-with-lease)?\b|(^|\s)-[a-zA-Z]*f[a-zA-Z]*(\s|$))/;

function checkForcePush(command: string, policy: GuardrailPolicy): PolicyViolation | null {
  if (!isGitSubcommand(command, 'push')) return null;
  if (!FORCE_PUSH_RE.test(command)) return null;
  return violation(requireRule(policy, 'force-push'));
}

/** Rule 3: merge into main/master by name, or a bare merge while already on one. */
function checkMergeIntoProtected(
  command: string,
  branch: string,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  if (!isGitSubcommand(command, 'merge')) return null;
  const rule = requireRule(policy, 'merge-into-protected');
  const namesAlt = policy.protectedBranchNames.map(escapeRegExp).join('|');
  // Anchored the same way as the gate above, so a chained
  // `git merge-base HEAD origin/main; git merge some-feature` does not read
  // the plumbing call's argument as the real merge's destination.
  const destRe = new RegExp(`${bareWord('merge')}.*\\b(${namesAlt})\\b`, 'i');
  if (destRe.test(command)) {
    return violation(rule);
  }
  if (isProtectedBranchName(branch, policy)) {
    return violation(rule, renderBranch(rule.reasonOnCurrentBranch ?? rule.reason, branch));
  }
  return null;
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
  const rewrites =
    isGitSubcommand(command, 'rebase') ||
    /\bcommit\b.*--amend\b/i.test(command) ||
    /\bfilter-(branch|repo)\b/i.test(command);
  if (!rewrites) return null;
  const rule = requireRule(policy, 'history-rewrite-on-protected');
  return violation(rule, renderBranch(rule.reason, branch));
}

/** Rule 6 detection, half one: is `rm` invoked as a command in this segment? Looser than "first token", so `sudo rm …` still matches; stricter than a bare substring, so the `rm` inside `charm`/`confirm` is not this rule's business. */
const RM_INVOKE_RE = /(^|[;&|]|\s)rm\s+/;
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
 * Every character that ends the command a segment is about. `;&|` are the
 * three guard.sh knew, and for a long time this file knew no others — which
 * left the rules that read a segment's *operands* (rule 1's destination ref,
 * rule 6's paths) reading whatever the next piece of shell syntax put in
 * front of them:
 *
 * - `>` `<` start a redirection, whose target is a file the command writes,
 *   never one of its operands. This is the one that mattered: `git push
 *   origin main > /dev/null` is not an evasion, it is how a quiet push is
 *   written, and it was allowed.
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
const SEPARATOR_CHARS = ';&|\\n(){}<>#`';

/**
 * Every separated segment of a command, so a chain can be inspected one
 * invocation at a time — and so a rule reading a segment's operands is looking
 * at that command's operands and nothing else.
 */
function splitChainSegments(command: string): string[] {
  return command.split(new RegExp(`[${SEPARATOR_CHARS}]`));
}

/** The `rm <args>` run up to the next separator, ported from guard.sh's `grep -Eo 'rm[[:space:]]+[^;&|]*'` and widened with it. Applied per chain segment (see `checkUnboundedRm`), so "up to the next separator" and "to the end of the string" mean the same thing by the time this runs — the negated class is belt and braces, kept in step with the split so the two can never disagree about where a command ends. */
const RM_ARGS_RE = new RegExp(`rm\\s+([^${SEPARATOR_CHARS}]*)`);

function extractRmArgs(segment: string): string[] {
  const match = RM_ARGS_RE.exec(segment);
  if (!match) return [];
  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
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
 * Rule 6: a recursive-force `rm` outside `allowed_roots`, however the two
 * flags are spelled (see `hasRecursiveForce`).
 *
 * Checks every chain segment independently, not just the first `rm` in the
 * whole command. guard.sh's own `grep -Eo 'rm[[:space:]]+[^;&|]*'` — and this
 * function, until this fix — stopped at the first match in the *whole*
 * command string, so `rm -rf workspaces/a; rm -rf src/important` read
 * `workspaces/a` (allowed), decided the command was fine, and never looked
 * at `src/important` at all. That is a deliberate behaviour change from a
 * straight port: closing a chained-command bypass that guard.sh always had,
 * not carrying it forward with new spelling.
 */
function checkUnboundedRm(
  command: string,
  repoRoot: string | null,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  const outOfBounds = splitChainSegments(command).some((segment) => {
    if (!RM_INVOKE_RE.test(segment)) return false;
    const args = extractRmArgs(segment);
    if (!hasRecursiveForce(args)) return false;
    return args.some((tok) => {
      if (tok.startsWith('-')) return false;
      return !isAllowedRemovalPath(normalizeRemovalPath(tok, repoRoot), policy);
    });
  });
  if (!outOfBounds) return null;
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
  id: string,
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
 * Without this the sandbox would be one `smith sandbox close` away from
 * being off, and `rm state/sandboxes/<hash>.json` is a removal under
 * `state/`, which the `unbounded-rm` rule above explicitly permits. The
 * refusal is unconditional on the lease directory rather than scoped to
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
  // command with its message payloads blanked — see `stripMessageFlagValues`.
  // The lease rules below keep the raw string: they read *targets* off the
  // command, and `-m` is not always prose down there (`mkdir -m 755 <dir>`
  // spends it on a mode), so blanking it could put an empty token where a
  // path belongs.
  const scanned = stripMessageFlagValues(command);
  const checks: Array<() => PolicyViolation | null> = [
    () => checkPushToProtected(scanned, branch, policy),
    () => checkForcePush(scanned, policy),
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
