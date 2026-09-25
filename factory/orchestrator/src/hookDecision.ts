// The PreToolUse decision, on its own, so that the hot path can hold it
// without holding the rest of the orchestrator.
//
// `.claude/hooks/guard.sh` fires on every Bash/Write/Edit/MultiEdit/
// NotebookEdit call an agent makes, which makes whatever it execs the most
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
import {
  detectCurrentBranch,
  detectRepoRoot,
  evaluateCommand,
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
): HookDecisionOutput | null {
  const payload = JSON.parse(raw) as {
    tool_name?: unknown;
    tool_input?: { command?: unknown; file_path?: unknown };
    cwd?: unknown;
  };
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
        reason = decision.violations[0]?.reason ?? 'guardrails.yml denied this command.';
        break;
      }
    }
    if (reason !== null) break;
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
