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
 * `smith policy check` and `smith policy hook` (cli.ts) are the two callers;
 * `policy hook` is what `.claude/hooks/guard.sh` now execs into.
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
  /** Keyed by rule id (`push-to-protected`, etc.) — every id in `REQUIRED_RULE_IDS` is guaranteed present. */
  readonly rules: ReadonlyMap<string, GuardrailRule>;
}

interface RawGuardrailsYaml {
  protected_branches?: { names?: unknown; patterns?: unknown };
  destructive_removal?: { allowed_roots?: unknown };
  deploy_commands?: unknown;
  judge_sandbox?: {
    write_roots?: unknown;
    network_commands?: unknown;
    network_subcommands?: unknown;
    target_write_commands?: unknown;
    refused_write_commands?: unknown;
    git_write_subcommands?: unknown;
    rules?: unknown;
  };
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
 * report nothing wrong.
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

  const rules = new Map<string, GuardrailRule>();
  collectRules(doc.rules, rules, 'rules');
  collectRules(rawSandbox.rules, rules, 'judge_sandbox.rules');
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
    rules,
  };
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
 */
function isGitSubcommand(command: string, subcommand: string): boolean {
  return new RegExp(`\\bgit\\b[^;&|]*\\b${subcommand}\\b`, 'i').test(command);
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
  const re = new RegExp(`\\bgit\\b.*\\b${word}\\b`, 'i');
  return command.split(/[;&|]/).filter((s) => re.test(s));
}

/**
 * Last whitespace-separated token of a command segment, quotes stripped —
 * used to read the destination ref/refspec of a push precisely (last token,
 * or the right-hand side of a `<local>:<remote>` refspec) rather than a loose
 * substring match that would false-block e.g. `git push origin
 * fix-main-config`. Ported from guard.sh's `last_token`.
 */
function lastToken(segment: string): string {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
  const token = tokens[tokens.length - 1] ?? '';
  return token.replace(/^["']/, '').replace(/["']$/, '');
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
}

/**
 * Tools whose `command` string this policy inspects. Only `Bash` is in scope
 * today, but that is a fact about which tools *have* a shell command to
 * inspect, not a hardcoded branch in `evaluateCommand` — a second Bash-like
 * tool added later is a one-line change here, not new control flow.
 */
const INSPECTED_TOOLS: readonly string[] = ['Bash'];

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

/** Rule 1: push to main/master — destination ref, checked precisely; or a bare push while already on a protected branch. */
function checkPushToProtected(
  command: string,
  branch: string,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  if (!isGitSubcommand(command, 'push')) return null;
  const rule = requireRule(policy, 'push-to-protected');
  const pushSegments = gitSegmentsFor(command, 'push');
  if (pushSegments.some((segment) => isProtectedRef(lastToken(segment), policy))) {
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
  const destRe = new RegExp(`\\bmerge\\b.*\\b(${namesAlt})\\b`, 'i');
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

/** Rule 6 detection: `rm -rf`/`-fr`/`--recursive --force`/`--force --recursive`. No `-i`, matching guard.sh. */
const RM_DETECT_RE =
  /(^|[;&|]|\s)rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\b/;
/** The `rm <args>` run up to the next chain separator, ported from guard.sh's `grep -Eo 'rm[[:space:]]+[^;&|]*'`. Applied per chain segment (see `checkUnboundedRm`), so "up to the next separator" and "to the end of the string" mean the same thing by the time this runs. */
const RM_ARGS_RE = /rm\s+([^;&|]*)/;

function extractRmArgs(segment: string): string[] {
  const match = RM_ARGS_RE.exec(segment);
  if (!match) return [];
  return (match[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
}

/**
 * Every `;`/`&`/`|`-separated segment of a command, so a chained-rm command
 * can be inspected one `rm` invocation at a time. Splitting is naive (it does
 * not understand quoting), the same trade-off guard.sh's own chain-separator
 * handling made everywhere else in this module.
 */
function splitChainSegments(command: string): string[] {
  return command.split(/[;&|]/);
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
 * Rule 6: `rm -rf`/`-fr`/`--recursive --force` outside `allowed_roots`.
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
    if (!RM_DETECT_RE.test(segment)) return false;
    return extractRmArgs(segment).some((tok) => {
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
 * Three shapes, deliberately not unified. A redirection has one readable
 * target, so it is checked against the allowlist. `mkdir`/`tee`/`touch` take
 * nothing but targets, so every non-flag argument is checked. Everything
 * else that writes is refused outright rather than path-checked, because
 * deciding which token of `cp a b` is the target — or of `install -m 644 a b
 * c` — is more machinery than the zero legitimate cases justify.
 */
function checkJudgeWrite(
  command: string,
  lease: SandboxLease,
  repoRoot: string | null,
  policy: GuardrailPolicy,
): PolicyViolation | null {
  const { writeRoots, targetWriteCommands, refusedWriteCommands, gitWriteSubcommands } =
    policy.judgeSandbox;
  const outOfBounds = (token: string): boolean =>
    !isUnderWriteRoot(normalizeRemovalPath(token, repoRoot), writeRoots);

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
 * for gate failures). Only tools in `INSPECTED_TOOLS` are evaluated; every
 * other tool call, and an empty command, allows trivially.
 */
export function evaluateCommand(
  context: PolicyContext,
  policy: GuardrailPolicy = loadGuardrailPolicy(),
): PolicyDecision {
  if (!INSPECTED_TOOLS.includes(context.toolName) || context.command.trim() === '') {
    return { allowed: true, violations: [] };
  }
  const { command, branch, repoRoot } = context;
  const checks: Array<() => PolicyViolation | null> = [
    () => checkPushToProtected(command, branch, policy),
    () => checkForcePush(command, policy),
    () => checkMergeIntoProtected(command, branch, policy),
    () => checkDeployCommand(command, policy),
    () => checkHistoryRewriteOnProtected(command, branch, policy),
    () => checkUnboundedRm(command, repoRoot, policy),
  ];
  // The judge rules are additive: a judge is bound by everything an ordinary
  // session is bound by, and by these on top. They are appended rather than
  // substituted so there is no arrangement of leases under which a command
  // is checked by fewer rules than it would have been with no lease at all.
  const lease = context.sandbox ?? null;
  if (lease !== null) {
    checks.push(
      () => checkJudgeNetwork(command, lease, policy),
      () => checkJudgeWrite(command, lease, repoRoot, policy),
      () => checkJudgeSandboxEscape(command, lease, policy),
    );
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
