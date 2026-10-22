// The PreToolUse decision, on its own, so that the hot path can hold it
// without holding the rest of the orchestrator.
//
// `.claude/hooks/guard.sh` fires on every Bash/Write/Edit/MultiEdit/
// NotebookEdit/Agent/Task call an agent makes, which makes whatever it execs the most
// frequently run code in this repo by orders of magnitude. It used to exec
// `dist/cli.js policy hook`; cli.ts imports the whole orchestrator at module
// scope, `db/projector.js` and so drizzle-orm among it, and that graph cost
// ~1.3s to load in front of ~39ms of policy work — a database layer loaded
// and thrown away once per guarded action. Splitting the decision out lets
// `policyHook.ts` be an entry point whose imports are only what deciding
// actually needs, while `cli.ts` keeps `smith policy hook` by calling the
// same function rather than a second copy of it.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { agentNameFor, roleOfAgentType } from './agentNames.js';
import { type BriefMarker, parseBriefMarker } from './briefMarker.js';
import { parseDeclaredArtifactLine } from './declaredArtifactLine.js';
import { JUDGE_ROLES } from './judgeRoles.js';
import {
  detectCurrentBranch,
  detectRepoRoot,
  evaluateCommand,
  isProtectedBranchName,
  loadGuardrailPolicy,
  type PolicyContext,
} from './policy.js';
import { activeSandboxFor, type SandboxLease } from './sandbox.js';

/** The `hookSpecificOutput` envelope Claude Code reads back from a PreToolUse hook. */
export interface HookDecisionOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'deny';
    readonly permissionDecisionReason: string;
  };
}

const JUDGE_ROLE_NAMES: ReadonlySet<string> = new Set(JUDGE_ROLES);

/**
 * A judge-role subagent dispatch must carry `Declared artifact: <absolute path>`
 * in its prompt, because judge-stop.sh reads the prompt (never a brief file) to
 * know what the judge owes. Same parser as judge-stop, so what is accepted here
 * is what it reads. Any other role, prefix or missing type is allowed silently.
 */
function decideAgentDispatch(
  input: { subagent_type?: unknown; prompt?: unknown } | undefined,
): HookDecisionOutput | null {
  const type = typeof input?.subagent_type === 'string' ? input.subagent_type : '';
  // Same mapping as judge-stop: `bs-reviewer`, `blacksmith:bs-reviewer` and the
  // bare pre-prefix names all reach the role. Another plugin's namespace
  // (`other:reviewer`) is not a Blacksmith agent, so it is skipped, not stripped.
  const colon = type.indexOf(':');
  if (colon !== -1 && type.slice(0, colon) !== 'blacksmith') return null;
  const role = roleOfAgentType(type);
  if (role === null || !JUDGE_ROLE_NAMES.has(role)) return null;
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const declared = parseDeclaredArtifactLine(prompt);
  if (declared !== null && path.isAbsolute(declared)) return null;
  const found =
    declared === null
      ? ''
      : ` The prompt has "${declared}", which is relative; the path must be absolute.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `A "${role}" dispatch must declare the artifact it writes. The prompt needs a line reading exactly ` +
        '`Declared artifact: <absolute path>` on its own line, not indented, and in the prompt itself ' +
        `(judge-stop reads the prompt, not a brief file the agent reads).${found} ` +
        '`judge dispatch` prints the line to paste, as `expected_line`.',
    },
  };
}

/**
 * Reads one PreToolUse payload and answers with the envelope to print, or
 * `null` to print nothing.
 *
 * Two outcomes, and the caller signals them apart by exit code:
 *   - a reachable decision: exit 0, and either this envelope on stdout or
 *     silence.
 *   - could not reach a decision at all: a throw, left to propagate, which
 *     the caller turns into a non-zero exit.
 *
 * A malformed payload takes the second path on purpose. guard.sh's own
 * `extract_field` used to return '' on anything it could not parse, which
 * read as "no tool_name" and let every rule fall through as a silent allow —
 * invisibly, since a BSD-vs-GNU `sed` incompatibility meant this had been
 * happening on every macOS run since Phase 2 (see guard.sh's header).
 * "Cannot parse the input" and "nothing to inspect" must never look the same
 * again: the first is failure, the second is a real allow, and only guard.sh's
 * fail-closed handling of a non-zero exit may turn "failure" into a denial.
 */
export function decideHookPayload(
  raw: string,
  fallbackCwd: string,
  /** Where judge leases live; the live `state/sandboxes` unless a test points elsewhere. */
  leaseDir?: string,
  /** Parsers for the diet rules; a test injects throwing ones. */
  dietDeps?: DietDeps,
): HookDecisionOutput | null {
  const parsed: unknown = JSON.parse(raw);
  // Diet rules (D4) run first and never throw: no match means the decision
  // path below runs exactly as before.
  const diet = dietDecision(parsed, dietDeps);
  if (diet !== null) return diet;
  const payload = parsed as {
    tool_name?: unknown;
    tool_input?: {
      command?: unknown;
      file_path?: unknown;
      subagent_type?: unknown;
      prompt?: unknown;
    };
    cwd?: unknown;
  };
  if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
    return decideAgentDispatch(payload.tool_input);
  }
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const command = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '';
  // A `Write`/`Edit`/`MultiEdit` payload carries no command; its target is
  // `tool_input.file_path`, absolute. Bash was the only tool worth inspecting
  // while every leased role was a judge, since judges hold no file tools and a
  // shell was their only write path. A tester holds both, so watching only
  // Bash would leave the rule to be routed around with the tool the role was
  // handed. Same shape as `command`: a missing or non-string field reads as
  // absent, never as a guess.
  const filePath =
    typeof payload.tool_input?.file_path === 'string' ? payload.tool_input.file_path : null;
  // Branch and repo root come from where the command would actually run.
  // Resolving them from this binary's own checkout would be wrong in the case
  // this factory spends most of its time in: guard.sh always execs the main
  // clone's dist, while the session issuing the command is usually inside a
  // per-task git worktree on a different branch. That gap is not academic —
  // `git rebase` on smith/<epic>/integration is a rule-5 denial, and the merge
  // queue performs rebases from a worktree standing on exactly that branch
  // while the main clone stands elsewhere. `fallbackCwd` covers a payload
  // without the field (a hand-driven invocation, or an older client), and a
  // cwd outside any repo resolves to ''/null, which denies an out-of-bounds
  // removal rather than allowing it.
  //
  // The payload's `cwd` is where the SESSION stands, though, and a command can
  // move before it acts. `cd <worktree> && git merge main` from a session in
  // the main clone runs on the worktree's side branch, so judging it on `main`
  // is a false deny; `cd <main clone> && git merge x` from a worktree session
  // is the matching false allow. So one narrow shape — `shortcutDirectories`
  // — is judged in its target alone, dropping `cwd`; that is the ONLY way this
  // function can ever be more lenient than judging `cwd`, so the shape is an
  // allowlist and anything it cannot read with certainty (including a target
  // that is not on a named branch of a repo) falls back. The fallback judges
  // `cwd` plus every directory the command names, and the command is denied
  // if ANY of them denies it, so it is never more lenient than `cwd` alone.
  // A command naming no directory change is judged on `cwd` alone, as before.
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : fallbackCwd;
  const policy = loadGuardrailPolicy();
  // The lease binds the session a judge was handed, so it is read from `cwd`
  // whatever the command does next: reading it only from the cd target would
  // let `cd <elsewhere> && curl …` leave the sandbox in one hop. A lease over
  // a target is checked too, so moving INTO a leased worktree is bound by it.
  // No lease is the ordinary case and costs one directory read.
  const sessionLease = activeSandboxFor(cwd, leaseDir);
  const locate = (dir: string) => ({
    dir,
    branch: detectCurrentBranch(dir),
    repoRoot: detectRepoRoot(dir),
  });
  const certain = MOVES_RE.test(command) ? shortcutDirectories(command, cwd)?.map(locate) : null;
  // `HEAD` is what a detached worktree's branch reads as — not a name a
  // protected-branch rule can ever match, and guardrails.md requires the
  // shortcut's target to sit on a named branch.
  const places =
    certain?.every((p) => p.branch !== '' && p.branch !== 'HEAD' && p.repoRoot !== null) === true
      ? certain
      : fallbackDirectories(command, cwd).map(locate);
  let reason: string | null = null;
  let firingRuleId: string | null = null;
  let firingDir: string | null = null;
  for (const { dir, branch, repoRoot } of places) {
    const targetLease = dir === cwd ? null : activeSandboxFor(dir, leaseDir);
    for (const sandbox of distinctLeases(sessionLease, targetLease)) {
      const context: PolicyContext = { toolName, command, branch, repoRoot, sandbox, filePath };
      const decision = evaluateCommand(context, policy);
      // guard.sh only ever surfaced one reason: each rule block()ed and exited
      // immediately on its own match, sequentially, so the first rule in
      // guard.sh's 1-6 order to fire is the only one an agent ever saw.
      // evaluateCommand's checks array preserves that order, so violations[0]
      // of the first denying evaluation reproduces guard.sh's visible
      // behaviour even though evaluateCommand (policy check's diagnostic
      // output) reports every rule that tripped.
      if (!decision.allowed) {
        const violation = decision.violations[0];
        reason = violation?.reason ?? 'guardrails.yml denied this command.';
        firingRuleId = violation?.ruleId ?? null;
        firingDir = dir;
        break;
      }
    }
    if (reason !== null) break;
  }
  // Rule 3 denying on the fallback (`certain === null`) because cwd itself is
  // protected is a guess dressed as fact when the command also named another
  // directory that is NOT protected: the fallback ran only because the shape
  // could not be read for certain, not because cwd is provably where this
  // runs. Swap in a reason that says so and names the readable shapes, so the
  // same merge can go through rewritten. Every other case — no named
  // directory, or a named directory that is protected too — keeps the
  // original reason unchanged.
  if (
    reason !== null &&
    firingRuleId === 'merge-into-protected' &&
    certain == null &&
    firingDir === cwd
  ) {
    const namedUnprotected = places.some(
      (p) =>
        p.dir !== cwd &&
        p.branch !== '' &&
        p.branch !== 'HEAD' &&
        p.repoRoot !== null &&
        !isProtectedBranchName(p.branch, policy),
    );
    if (namedUnprotected) {
      const cwdBranch = places.find((p) => p.dir === cwd)?.branch ?? '';
      reason = fallbackMergeReason(cwdBranch);
    }
  }
  if (reason === null) {
    // Allow prints NOTHING, on purpose, and this is not a cosmetic choice.
    // Claude Code reads an explicit `permissionDecision: "allow"` from a hook
    // as "skip the permission system for this call" — it outranks the
    // operator's own `permissions.deny` list and suppresses the approval
    // prompt. A guard hook that emitted it on every command it did not
    // recognise would therefore not be a guard at all: it would be a blanket
    // auto-approver for everything outside guardrails.yml's rules, which is a
    // strictly wider grant than the hook it replaces ever had. Empty stdout is
    // the protocol's "no opinion, carry on with the normal permission flow",
    // which is exactly what this layer means when no rule fires. The exit code
    // still separates "no opinion" (0, silent) from "could not decide"
    // (non-zero, which guard.sh turns into a deny), so silence here is never
    // load-bearing the way the old hook's was.
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOCKED: ${reason}`,
    },
  };
}

/**
 * Rule 3's fallback reason for the one case where "you are on {branch}"
 * states a guess as fact: the command named another directory, that
 * directory is NOT protected, and the only reason cwd was judged at all is
 * that the command's shape was not one `shortcutDirectories` can read for
 * certain — see its own doc comment for the two shapes it accepts. Says so
 * plainly, and names those shapes, rather than telling an agent already
 * standing on a side branch to "check out a side branch instead".
 */
function fallbackMergeReason(cwdBranch: string): string {
  return (
    `this command's shape is not one the guard can read for certain, so it ` +
    `was also judged against your session's own directory, which is on ` +
    `${cwdBranch}, a protected branch; git merge/pull is denied there. The ` +
    `guard reads \`cd <dir> && git <cmd> …\` — <dir> absolute or starting ` +
    `with \`./\`, joined only by \`&&\`, each command merge, pull or another ` +
    `read-safe git subcommand (not checkout or switch) — or a single ` +
    `\`git -C <dir> merge …\`; plain words only, no pipes, \`;\`, redirects, ` +
    `quotes or variables. Write it that way and the same merge is judged in ` +
    `<dir> alone.`
  );
}

/**
 * The one shape judged in its target alone, or `null` to fall back. An
 * allowlist, because this is the only path that drops `cwd` and so the only
 * one that can allow what `cwd` alone would deny:
 *
 *   - `cd <target> && <cmd> && <cmd> …`: a cd, then plain words joined by
 *     nothing but `&&` — so everything after runs in the target or not at
 *     all. A relative target must start with `./` or `../` (or be `.`/`..`),
 *     since a bare name is looked up on CDPATH first.
 *   - `git -C <target> <plain words>`, alone.
 *
 * A plain word is unquoted and uses only `PLAIN_WORD_RE`'s characters: no
 * `;`, `|`, `&`, newline, backslash, `$`, backtick, quote, parens, glob or
 * redirection. The target may also be one whole single- or double-quoted
 * span. Every `&&`-joined command after the target must be a `git`
 * invocation whose subcommand sits in `GIT_SUBCOMMAND_ALLOWLIST` —
 * positively, not a denylist of mover words: any plain word could be a shell
 * alias or function (zsh's autopushd defines `-` and `1`..`9` as `cd`
 * shortcuts), so nothing short of "must be a git builtin that cannot run a
 * command in another repo" is sound. `checkout` and `switch` are excluded
 * even though they only ever touch the repo they run in: either can move the
 * target onto a different branch mid-command, and the branch judged is read
 * once, before the command runs — `cd <W> && git checkout main && git merge
 * x` would be judged on W's branch before the checkout, not the `main` it
 * actually merges onto. Git builtins cannot be shadowed by a git alias; a
 * shell alias named `git` itself is out of scope. A mover flag
 * (`MOVER_FLAG_RE`), a short option bundling `x` or `s`
 * (`hasDangerousShortOption` — rebase `-x`/`-kx`, an arbitrary command; merge
 * or checkout `-s`, a strategy or search run off PATH as `git-<name>`), or a
 * long option starting `--e`/`--s` (`hasDangerousLongOption` — `--exec`,
 * `--strategy`, and their `=value` forms) still forfeits, and so does a git
 * location override anywhere. Returns the target lexically and physically
 * when the two differ (a cd is logical, git's chdir physical), and the
 * caller falls back too if any of them is not on a named branch of a repo.
 */
function shortcutDirectories(command: string, cwd: string): string[] | null {
  // No `.trim()`/split reliance below this line for a security decision: both
  // read NBSP, BOM and form-feed as whitespace and drop them, while a shell's
  // IFS does not — so a target's trailing NBSP would parse away to a clean,
  // different directory than the one the shell actually enters.
  if (NON_ASCII_RE.test(command)) return null;
  if (GIT_LOCATION_RE.test(command) || /[\r\n]/.test(command.trim())) return null;
  const segments = command
    .trim()
    .split('&&')
    .map((segment) => segment.trim().split(/[ \t]+/));
  const [first = [], ...rest] = segments;
  let target: string;
  let after: string[];
  if (first.length === 2 && first[0] === 'cd' && rest.length > 0) {
    target = first[1] ?? '';
    after = rest.flat();
    if (!/^\.{1,2}(?:\/|$)|^\//.test(unquote(target) ?? '')) return null;
    if (
      !rest.every(
        (segment) => segment[0] === 'git' && GIT_SUBCOMMAND_ALLOWLIST.has(segment[1] ?? ''),
      )
    )
      return null;
  } else if (segments.length === 1 && first[0] === 'git' && first[1] === '-C' && first.length > 3) {
    target = first[2] ?? '';
    after = first.slice(3);
    if (!GIT_SUBCOMMAND_ALLOWLIST.has(after[0] ?? '')) return null;
  } else {
    return null;
  }
  const plain = (word: string) =>
    PLAIN_WORD_RE.test(word) && !MOVER_WORDS.has(word) && !MOVER_FLAG_RE.test(word);
  if (!after.every(plain)) return null;
  if (after.some((word) => hasDangerousShortOption(word) || hasDangerousLongOption(word)))
    return null;
  if (!PLAIN_WORD_RE.test(target) && !/^'[^']*'$|^"[^"]*"$/.test(target)) return null;
  return literalDirectories(target, cwd);
}

/** Every directory a command names, plus `cwd` — the fail-closed fallback. */
function fallbackDirectories(command: string, cwd: string): string[] {
  const dirs = [cwd];
  for (const [, word = ''] of command.matchAll(TARGET_RE)) {
    // A relative hop is resolved against every directory found so far, so
    // `cd a && cd b` still reaches `a/b`: an extra candidate costs nothing
    // but a possible denial, and a missed one is a hole.
    for (const base of [...dirs]) {
      for (const target of literalDirectories(word, base) ?? []) {
        if (!dirs.includes(target)) dirs.push(target);
      }
    }
  }
  return dirs;
}

/**
 * Anything that could put a command somewhere other than where it started.
 * Deliberately loose — `echo cd` or `git commit -C HEAD` match too — because
 * a match only forfeits the no-move path, never a check.
 */
const MOVES_RE = /(?:^|[\s;&|(])(?:cd|pushd|popd)(?=$|[\s;&|)])|\s-C(?:\s|$)|[()`]/;

/** A word the shortcut reads as itself: nothing the shell would expand, split or redirect. */
const PLAIN_WORD_RE = /^[A-Za-z0-9_./:@%+,=-]+$/;

/**
 * Anything outside printable ASCII (tab allowed as a separator), forfeiting
 * the shortcut before any `.trim()`/split touches the command — see
 * `shortcutDirectories`'s note on why those cannot be trusted past this
 * point.
 */
const NON_ASCII_RE = /[^\t\x20-\x7E]/;

/**
 * Git builtins the shortcut may follow a `cd`/`-C` target with: read-only or
 * ordinary write commands that act on the repo they are invoked in, never on
 * another one, and that cannot themselves move the target onto a different
 * branch than the one just read. Deliberately excludes indirect executors
 * that run a git command somewhere else (`for-each-repo`, `submodule`),
 * anything that rewrites history destructively outside a plain invocation
 * (`filter-branch`, `filter-repo`, `worktree`, `bisect`), and `checkout`/
 * `switch` — either can move the target's branch mid-command, after
 * `shortcutDirectories`' caller has already read it once, so a later command
 * in the same chain would be judged on the branch the target left rather
 * than the one it moved to. A git builtin cannot be shadowed by a git alias,
 * which is what makes this allowlist sound.
 */
const GIT_SUBCOMMAND_ALLOWLIST = new Set([
  'status',
  'log',
  'diff',
  'show',
  'add',
  'commit',
  'merge',
  'rebase',
  'push',
  'fetch',
  'pull',
  'branch',
  'reset',
  'rev-parse',
  'tag',
  'stash',
]);

/**
 * A short option (`-x`, `-kx`, `-x./s`) that bundles `x` or `s` among its
 * option letters, read up to the first non-letter (a stuck argument, `=`, or
 * end of word) — `git rebase -x <cmd>`/`-kx<cmd>` runs an arbitrary command,
 * and `git merge -s <strategy>`/`git checkout -s` (`-s` is a bundlable short
 * flag on several subcommands) can run `git-<strategy>` off PATH. A plain
 * number (`-5`) is exempt, since `git log -5` is common and harmless.
 */
function hasDangerousShortOption(word: string): boolean {
  if (!word.startsWith('-') || word.startsWith('--')) return false;
  if (/^-\d+$/.test(word)) return false;
  const letters = /^-([A-Za-z]+)/.exec(word)?.[1] ?? '';
  return letters.includes('x') || letters.includes('s');
}

/**
 * A long option that could be `--exec`/`--exec=…` (rebase, arbitrary command)
 * or `--strategy`/`--strategy-option=…` (merge/rebase, runs `git-<name>` off
 * PATH) by prefix rather than exact match, since either can carry `=value`.
 * Over-forfeits `--edit`, `--squash`, and the like on purpose: forfeiting
 * only falls back to the full check, never widens what the shortcut allows.
 */
function hasDangerousLongOption(word: string): boolean {
  return word.startsWith('--e') || word.startsWith('--s');
}

/** Commands that can move the shell, or run a command string somewhere else. */
const MOVER_WORDS = new Set([
  'cd',
  'pushd',
  'popd',
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'env',
  'sudo',
  'xargs',
  'find',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
]);

/** Flags that move a command (`-C`, `--chdir`, `--directory`) or configure git (`-c`). */
const MOVER_FLAG_RE = /^(?:-C|-c$|--chdir|--directory)/;

/** Git location overrides: they point git at another repo whatever the cwd. */
const GIT_LOCATION_RE = /GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|--git-dir|--work-tree/;

/** One word: double-quoted, single-quoted, or bare up to a separator. */
const WORD = `("[^"]*"|'[^']*'|[^\\s;&|<>()]+)`;

/** Every `cd`/`pushd <word>` and every `-C <word>`, wherever it sits. */
const TARGET_RE = new RegExp(`(?:(?:^|[\\s;&|(])(?:cd|pushd)|\\s-C)\\s+${WORD}`, 'g');

/**
 * `word` with its quotes removed, or `null` when it is quoted any other way
 * than one whole span: `"a"/"b"` is two spans the shell splices, and reading
 * it as one quoted `a"/"b` names a different directory.
 */
function unquote(word: string): string | null {
  if (/^'[^']*'$/.test(word) || /^"[^"]*"$/.test(word)) return word.slice(1, -1);
  return /["'\\]/.test(word) ? null : word;
}

/**
 * `word` as an existing, enterable directory resolved against `base` —
 * lexically (where a logical `cd` lands) and physically (where git's chdir
 * lands, `..` after a symlink included), both when they differ — or `null`
 * when it is not a literal path: an expansion (`$`, backtick, `~`), a glob, a
 * flag or `-`, an escape, a quote this does not read, or a path that does not
 * resolve. A cd there fails and runs nothing after its `&&`, and this is not
 * the place to guess what it meant.
 */
function literalDirectories(word: string, base: string): string[] | null {
  const bare = unquote(word);
  if (bare === null || bare === '' || bare.startsWith('-') || /[$`~*?[\]\\]/.test(bare)) {
    return null;
  }
  const lexical = path.resolve(base, bare);
  try {
    // `native` is realpath(3); the JS realpathSync resolves `..` lexically first.
    const physical = realpathSync.native(path.isAbsolute(bare) ? bare : `${base}/${bare}`);
    if (!statSync(physical).isDirectory()) return null;
    accessSync(physical, constants.X_OK);
    if (lexical === physical || !isDirectory(lexical)) return [physical];
    return [lexical, physical];
  } catch {
    return null;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The leases to judge under — `[null]` for none, so one unleased evaluation still runs. */
function distinctLeases(
  session: SandboxLease | null,
  target: SandboxLease | null,
): (SandboxLease | null)[] {
  if (session === null) return [target];
  if (target === null || target.worktreeDir === session.worktreeDir) return [session];
  return [session, target];
}

// ---------------------------------------------------------------------------
// Diet rules (epic bs-optimize D4, decision 15). Both deny in every session,
// the operator's own included: nothing below reads a session or operator
// identity. A rule that cannot read its input, or throws, reports no match and
// the existing decision path runs as before.
// ---------------------------------------------------------------------------

/** Parsers `dietDecision` calls; injectable so a test can force them to throw. */
export interface DietDeps {
  readonly parseBriefMarker?: (text: string) => BriefMarker | null;
  /** Seconds of each foreground `sleep` of 2 s or more in a command (`Infinity` = unknown). */
  readonly findForegroundSleeps?: (command: string) => number[];
}

const blocked = (reason: string): HookDecisionOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

/**
 * Serves epic bs-optimize criterion 6: denies a marked brief sent to any agent
 * type but the marker role's `bs-<role>` / `blacksmith:bs-<role>`, and a
 * foreground Bash `sleep` of 2 s or more. Returns `null` (no match) for
 * everything else, for input it cannot read, and when a parser throws.
 */
export function dietDecision(payload: unknown, deps: DietDeps = {}): HookDecisionOutput | null {
  try {
    if (typeof payload !== 'object' || payload === null) return null;
    const { tool_name: tool, tool_input: input } = payload as {
      tool_name?: unknown;
      tool_input?: unknown;
    };
    if (typeof input !== 'object' || input === null) return null;
    if (tool === 'Agent' || tool === 'Task') return markedBriefDecision(input, deps);
    if (tool === 'Bash') return foregroundSleepDecision(input, deps);
  } catch {
    // Fail open: the existing decision path decides.
  }
  return null;
}

function markedBriefDecision(input: object, deps: DietDeps): HookDecisionOutput | null {
  const { prompt, subagent_type: type } = input as { prompt?: unknown; subagent_type?: unknown };
  if (typeof prompt !== 'string' || (type !== undefined && typeof type !== 'string')) return null;
  const marker = (deps.parseBriefMarker ?? parseBriefMarker)(prompt);
  if (marker === null) return null;
  const expected = agentNameFor(marker.role);
  if (type === expected || type === `blacksmith:${expected}`) return null;
  return blocked(
    `Blocked: this brief is marked for role \`${marker.role}\`; typed agents only (got ` +
      `${type === undefined ? 'no subagent_type' : `\`${type}\``}). Fix: dispatch to the matching ` +
      `\`${expected}\` (or \`blacksmith:${expected}\`).`,
  );
}

function foregroundSleepDecision(input: object, deps: DietDeps): HookDecisionOutput | null {
  const { command, run_in_background: background } = input as {
    command?: unknown;
    run_in_background?: unknown;
  };
  if (typeof command !== 'string' || background === true) return null;
  const sleeps = (deps.findForegroundSleeps ?? findForegroundSleeps)(command);
  if (sleeps.length === 0) return null;
  const longest = Math.max(...sleeps);
  const length = Number.isFinite(longest) ? `${longest} s` : 'unknown length';
  return blocked(
    `Blocked: foreground \`sleep\` of ${length}. Fix: use a background task or the Monitor tool instead of \`sleep\`.`,
  );
}

/** Longest command the sleep parser reads; a longer one is "cannot read", so no match. */
const MAX_COMMAND_LENGTH = 65_536;
const MAX_SHELL_DEPTH = 8;
const MIN_BLOCKING_SECONDS = 2;

/**
 * Serves epic bs-optimize criterion 6 (D4 verdict table): the seconds of every
 * foreground `sleep` of 2 s or more in `command`. Throws when the command
 * cannot be read (unbalanced quotes, an unterminated substitution, oversized).
 */
export function findForegroundSleeps(command: string): number[] {
  if (!command.includes('sleep')) return [];
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('command too long to read');
  return foregroundSleepsIn(command, 0).filter((s) => s >= MIN_BLOCKING_SECONDS);
}

interface Word {
  text: string;
  dynamic: boolean;
}
interface SimpleCommand {
  words: Word[];
  background: boolean;
}

/** Sleeps (any length) of the simple commands in `src` that block the call. */
function foregroundSleepsIn(src: string, depth: number): number[] {
  if (depth > MAX_SHELL_DEPTH) throw new Error('shell nesting too deep');
  const scanner = new ShellScanner(src, depth);
  scanner.parseList(false);
  const waits = scanner.commands.some((c) => c.words[0]?.text === 'wait');
  const out: number[] = [];
  for (const command of scanner.commands) {
    // A backgrounded sleep blocks nothing, unless a `wait` joins it in the foreground.
    if (command.background && !waits) continue;
    out.push(...sleepsOf(command.words, depth));
  }
  return out;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_FD_RE = /^\d+$/;
const NUMBER_RE = /^(\d+\.?\d*|\.\d+)([smhd]?)$/;
const UNIT_SECONDS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };
/** Words that start a command position without being the command. */
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '{']);
/** Wrappers that run the next command in the foreground; each may carry flags. */
const WRAPPERS = new Set(['time', 'nohup', 'exec', 'command']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
/** First words that open a command group, and the first word that closes each. */
const GROUP_PREFIX = new Set(['do', 'then', 'else', '!']);
const GROUP_CLOSER: Record<string, string> = {
  '{': '}',
  while: 'done',
  until: 'done',
  for: 'done',
  if: 'fi',
};

/** Sleeps one simple command runs, wrappers and a `-c` script included. */
function sleepsOf(words: readonly Word[], depth: number): number[] {
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) return [];
    if (ASSIGNMENT_RE.test(word.text)) {
      i++;
      continue;
    }
    if (word.dynamic) return [];
    const name = word.text.slice(word.text.lastIndexOf('/') + 1);
    if (KEYWORDS.has(word.text)) {
      i++;
    } else if (WRAPPERS.has(name)) {
      i++;
      while (/^-[A-Za-z]*$/.test(words[i]?.text ?? '')) i++;
    } else if (name === 'env') {
      i++;
      while (i < words.length) {
        const text = words[i]?.text ?? '';
        if (ASSIGNMENT_RE.test(text)) i++;
        else if (/^(-u|-C|--unset|--chdir)$/.test(text)) i += 2;
        else if (text.startsWith('-')) i++;
        else break;
      }
    } else if (name === 'timeout') {
      i++;
      while ((words[i]?.text ?? '').startsWith('-')) {
        i += /^(-s|-k|--signal|--kill-after)$/.test(words[i]?.text ?? '') ? 2 : 1;
      }
      i++; // the duration
    } else if (SHELLS.has(name)) {
      return shellScriptSleeps(words.slice(i + 1), depth);
    } else if (name === 'sleep') {
      return sleepDuration(words.slice(i + 1));
    } else {
      return [];
    }
  }
}

/** `bash -c '<script>'`, read one level of quoting deep; a script file is not read. */
function shellScriptSleeps(args: readonly Word[], depth: number): number[] {
  for (let j = 0; j < args.length; j++) {
    const text = args[j]?.text ?? '';
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(text)) {
      const script = args[j + 1];
      return script === undefined || script.dynamic
        ? []
        : foregroundSleepsIn(script.text, depth + 1);
    }
    if (!text.startsWith('-')) return [];
  }
  return [];
}

/** The summed operands of one `sleep`, as a one-element list; empty if it blocks nothing. */
function sleepDuration(operands: readonly Word[]): number[] {
  if (operands.length === 0) return [];
  if (operands.some((w) => w.dynamic || /^(infinity|inf)$/i.test(w.text)))
    return [Number.POSITIVE_INFINITY];
  let total = 0;
  for (const { text } of operands) {
    const match = NUMBER_RE.exec(text);
    if (match === null) return []; // `sleep` rejects it at once
    total += Number.parseFloat(match[1] as string) * (UNIT_SECONDS[match[2] as string] as number);
  }
  return [total];
}

/**
 * One left-to-right pass over a command line, splitting it into simple
 * commands. Linear in the input (no backtracking); `parseList` throws on input
 * it cannot read. It tracks quotes, comments, substitutions, redirections and
 * heredocs so that `sleep` as text is never mistaken for a command.
 */
class ShellScanner {
  pos = 0;
  readonly commands: SimpleCommand[] = [];

  constructor(
    private readonly src: string,
    private readonly depth: number,
  ) {}

  /** Parses to the end, or (for a `$(`/`<(` body) through its closing `)`. */
  parseList(untilParen: boolean): void {
    const src = this.src;
    let words: Word[] = [];
    let word: Word | null = null;
    let listStart = this.commands.length;
    let parens = 0;
    // Open groups, innermost last; `closedGroup` is the start of the group that
    // just closed, which a directly following `&` backgrounds as a whole.
    const groups: { closer: string; start: number }[] = [];
    let closedGroup: number | null = null;
    let skipNext = false;
    let heredoc: { strip: boolean } | null = null;
    const heredocs: { delimiter: string; strip: boolean }[] = [];

    const endWord = () => {
      if (word === null) return;
      if (heredoc !== null) heredocs.push({ delimiter: word.text, strip: heredoc.strip });
      else if (!skipNext) words.push(word);
      heredoc = null;
      skipNext = false;
      word = null;
    };
    const endCommand = () => {
      endWord();
      if (words.length > 0) {
        const first = words[0] as Word;
        if (words.length === 1 && !first.dynamic && groups.at(-1)?.closer === first.text) {
          closedGroup = (groups.pop() as { start: number }).start;
        }
        // Openers may follow `do`/`then`/`else`/`!` or each other (`do { `).
        for (const w of words) {
          if (w.dynamic) break;
          const closer = Object.hasOwn(GROUP_CLOSER, w.text) ? GROUP_CLOSER[w.text] : undefined;
          if (closer !== undefined) groups.push({ closer, start: this.commands.length });
          else if (!GROUP_PREFIX.has(w.text)) break;
        }
        this.commands.push({ words, background: false });
      }
      words = [];
    };
    const current = (): Word => {
      word ??= { text: '', dynamic: false };
      return word;
    };
    const redirect = () => {
      // A bare number just before the operator is the fd, not an argument.
      if (word !== null && !word.dynamic && REDIRECT_FD_RE.test(word.text)) word = null;
      else endWord();
    };

    while (this.pos < src.length) {
      const c = src.charAt(this.pos);
      // Only whitespace keeps a just-closed group adjacent to a following `&`.
      const justClosed = closedGroup;
      if (c !== ' ' && c !== '\t') closedGroup = null;
      if (c === ' ' || c === '\t') {
        endWord();
        this.pos++;
      } else if (c === '\\') {
        if (src.charAt(this.pos + 1) !== '\n') current().text += src.charAt(this.pos + 1);
        this.pos += 2;
      } else if (c === "'") {
        const close = src.indexOf("'", this.pos + 1);
        if (close === -1) throw new Error('unterminated single quote');
        current().text += src.slice(this.pos + 1, close);
        this.pos = close + 1;
      } else if (c === '"') {
        this.pos++;
        this.doubleQuoted(current());
      } else if (c === '$' || c === '`') {
        this.expansion(current());
      } else if (c === '#' && word === null) {
        const eol = src.indexOf('\n', this.pos);
        this.pos = eol === -1 ? src.length : eol;
      } else if (c === '\n') {
        endCommand();
        listStart = this.commands.length;
        this.pos++;
        for (const { delimiter, strip } of heredocs.splice(0)) this.skipHeredoc(delimiter, strip);
      } else if (c === ';') {
        endCommand();
        listStart = this.commands.length;
        this.pos++;
      } else if (c === '&' && src.charAt(this.pos + 1) === '&') {
        endCommand();
        this.pos += 2;
      } else if (c === '&' && src.charAt(this.pos + 1) === '>') {
        redirect();
        skipNext = true;
        this.pos += src.charAt(this.pos + 2) === '>' ? 3 : 2;
      } else if (c === '&') {
        endCommand();
        // A bare `(`/`{`/loop group is the unit `&` backgrounds, not its last list.
        const from = closedGroup ?? justClosed ?? listStart;
        for (let k = from; k < this.commands.length; k++) {
          (this.commands[k] as SimpleCommand).background = true;
        }
        listStart = this.commands.length;
        this.pos++;
      } else if (c === '|') {
        endCommand();
        this.pos += src.charAt(this.pos + 1) === '|' || src.charAt(this.pos + 1) === '&' ? 2 : 1;
      } else if ((c === '<' || c === '>') && src.charAt(this.pos + 1) === '(') {
        this.pos += 2;
        this.parseList(true);
        current().dynamic = true;
      } else if (c === '<' || c === '>') {
        redirect();
        let op = 1;
        while (src.charAt(this.pos + op) === c) op++;
        if (c === '<' && op === 2) {
          const strip = src.charAt(this.pos + 2) === '-';
          heredoc = { strip };
          op += strip ? 1 : 0;
        } else {
          skipNext = true;
          if (src.charAt(this.pos + op) === '&') op++;
        }
        this.pos += op;
      } else if (c === '(') {
        endCommand();
        listStart = this.commands.length;
        groups.push({ closer: ')', start: this.commands.length });
        parens++;
        this.pos++;
      } else if (c === ')') {
        endCommand();
        listStart = this.commands.length;
        this.pos++;
        if (parens > 0) {
          parens--;
          if (groups.at(-1)?.closer === ')')
            closedGroup = (groups.pop() as { start: number }).start;
        } else if (untilParen) return;
      } else {
        current().text += c;
        this.pos++;
      }
    }
    if (untilParen || parens > 0) throw new Error('unterminated substitution or group');
    endCommand();
  }

  /** A `"` string, opening quote already consumed; expansions inside run. */
  private doubleQuoted(into: Word): void {
    const src = this.src;
    while (this.pos < src.length) {
      const c = src.charAt(this.pos);
      if (c === '"') {
        this.pos++;
        return;
      }
      if (c === '\\') {
        into.text += src.charAt(this.pos + 1);
        this.pos += 2;
      } else if (c === '$' || c === '`') {
        this.expansion(into);
      } else {
        into.text += c;
        this.pos++;
      }
    }
    throw new Error('unterminated double quote');
  }

  /** A `$...` or backtick expansion at `pos`; substitutions are scanned for sleeps. */
  private expansion(into: Word): void {
    const src = this.src;
    const next = src.charAt(this.pos + 1);
    if (src.charAt(this.pos) === '`') {
      let end = this.pos + 1;
      while (end < src.length && src.charAt(end) !== '`') end += src.charAt(end) === '\\' ? 2 : 1;
      if (end >= src.length) throw new Error('unterminated backtick');
      this.scanInner(src.slice(this.pos + 1, end));
      this.pos = end + 1;
      into.dynamic = true;
    } else if (next === '(' && src.charAt(this.pos + 2) === '(') {
      let level = 0;
      let end = this.pos + 1;
      for (; end < src.length; end++) {
        const ch = src.charAt(end);
        if (ch === '(') level++;
        else if (ch === ')' && --level === 0) break;
      }
      if (end >= src.length) throw new Error('unterminated arithmetic');
      this.pos = end + 1;
      into.dynamic = true;
    } else if (next === '(') {
      this.pos += 2;
      this.parseList(true);
      into.dynamic = true;
    } else if (next === '{') {
      const close = src.indexOf('}', this.pos);
      if (close === -1) throw new Error('unterminated parameter expansion');
      this.pos = close + 1;
      into.dynamic = true;
    } else if (next === "'") {
      let end = this.pos + 2;
      while (end < src.length && src.charAt(end) !== "'") end += src.charAt(end) === '\\' ? 2 : 1;
      if (end >= src.length) throw new Error('unterminated $-quote');
      into.text += src.slice(this.pos + 2, end);
      this.pos = end + 1;
    } else if (/[A-Za-z_@*#?$!0-9-]/.test(next)) {
      this.pos += 2;
      while (/[A-Za-z0-9_]/.test(src.charAt(this.pos)) && /[A-Za-z_]/.test(next)) this.pos++;
      into.dynamic = true;
    } else {
      into.text += '$';
      this.pos++;
    }
  }

  /** Scans a backtick body; its commands join this scanner's list. */
  private scanInner(body: string): void {
    if (this.depth >= MAX_SHELL_DEPTH) throw new Error('shell nesting too deep');
    const inner = new ShellScanner(body, this.depth + 1);
    inner.parseList(false);
    this.commands.push(...inner.commands);
  }

  /** Skips heredoc body lines through the delimiter line (EOF ends it too). */
  private skipHeredoc(delimiter: string, strip: boolean): void {
    const src = this.src;
    while (this.pos < src.length) {
      const eol = src.indexOf('\n', this.pos);
      const end = eol === -1 ? src.length : eol;
      const line = src.slice(this.pos, end);
      this.pos = Math.min(end + 1, src.length);
      if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) return;
    }
  }
}
