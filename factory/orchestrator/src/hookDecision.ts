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
import { statSync } from 'node:fs';
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
export function decideHookPayload(raw: string, fallbackCwd: string): HookDecisionOutput | null {
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
  // is the matching false allow. `commandDirectories` answers where the
  // command can run — one directory only when that is statically certain,
  // otherwise every directory it names plus `cwd` — and the command is denied
  // if ANY of them denies it, so confused parsing can only add denials, never
  // remove one. A command naming no directory change is judged on `cwd`
  // alone, exactly as before.
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : fallbackCwd;
  const policy = loadGuardrailPolicy();
  // The lease binds the session a judge was handed, so it is read from `cwd`
  // whatever the command does next: reading it only from the cd target would
  // let `cd <elsewhere> && curl …` leave the sandbox in one hop. A lease over
  // a target is checked too, so moving INTO a leased worktree is bound by it.
  // No lease is the ordinary case and costs one directory read.
  const sessionLease = activeSandboxFor(cwd);
  let reason: string | null = null;
  for (const dir of commandDirectories(command, cwd)) {
    const targetLease = dir === cwd ? null : activeSandboxFor(dir);
    for (const sandbox of distinctLeases(sessionLease, targetLease)) {
      const context: PolicyContext = {
        toolName,
        command,
        branch: detectCurrentBranch(dir),
        repoRoot: detectRepoRoot(dir),
        sandbox,
        filePath,
      };
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
 * The directories `command` can run in, for the branch/repo-root/lease
 * lookups that decide it. Fail-closed by construction: the result always
 * contains `cwd` unless ONE directory is statically certain, and the caller
 * denies if any entry denies, so a form this cannot read costs at most a
 * denial the old cwd-only reading would also have made.
 *
 *   - No directory change anywhere (no cd/pushd/popd, `git -C`, subshell,
 *     substitution): `[cwd]`, i.e. exactly the pre-existing behaviour.
 *   - `cd <literal> && <rest>`, where the target is an existing directory
 *     and `<rest>` moves nowhere: `[target]`. Everything after a successful
 *     `&&` runs there, and a failed cd runs nothing after it.
 *   - A single `git -C <literal> …` and nothing chained to it: `[target]`.
 *     `-C` moves only its own invocation, so a chained second command would
 *     still run in `cwd` — which is why chaining sends it to the next case.
 *   - Anything else that moves: `cwd` plus every existing literal target the
 *     command names. A target this cannot read (`$X`, `~`, a glob, a
 *     substitution) is simply not added; `cwd` is still judged.
 */
function commandDirectories(command: string, cwd: string): string[] {
  if (!MOVES_RE.test(command)) return [cwd];
  const [, cdWord = '', cdRest = ''] = LEADING_CD_RE.exec(command) ?? [];
  if (cdWord !== '' && !MOVES_RE.test(cdRest)) {
    const target = literalDirectory(cdWord, cwd);
    if (target !== null) return [target];
  }
  const [, gitWord = '', gitRest = ''] = LONE_GIT_C_RE.exec(command) ?? [];
  if (gitWord !== '' && !/[;&|\n]/.test(command) && !MOVES_RE.test(gitRest)) {
    const target = literalDirectory(gitWord, cwd);
    if (target !== null) return [target];
  }
  const dirs = [cwd];
  for (const [, word = ''] of command.matchAll(TARGET_RE)) {
    // A relative hop is resolved against every directory found so far, so
    // `cd a && cd b` still reaches `a/b`: an extra candidate costs nothing
    // but a possible denial, and a missed one is a hole.
    for (const base of [...dirs]) {
      const target = literalDirectory(word, base);
      if (target !== null && !dirs.includes(target)) dirs.push(target);
    }
  }
  return dirs;
}

/**
 * Anything that could put a command somewhere other than where it started.
 * Deliberately loose — `echo cd` or `git commit -C HEAD` match too — because
 * a match only forfeits the single-directory fast path, never a check.
 */
const MOVES_RE = /(?:^|[\s;&|(])(?:cd|pushd|popd)(?=$|[\s;&|)])|\s-C(?:\s|$)|[()`]/;

/** One word: double-quoted, single-quoted, or bare up to a separator. */
const WORD = `("[^"]*"|'[^']*'|[^\\s;&|<>()]+)`;

/** `cd <word> && <rest>` as the whole command, leading whitespace aside. */
const LEADING_CD_RE = new RegExp(`^\\s*cd\\s+${WORD}\\s*&&([\\s\\S]*)$`);

/** `git -C <word> <rest>` as the whole command — `-C` straight after `git`. */
const LONE_GIT_C_RE = new RegExp(`^\\s*git\\s+-C\\s+${WORD}([\\s\\S]*)$`);

/** Every `cd`/`pushd <word>` and every `-C <word>`, wherever it sits. */
const TARGET_RE = new RegExp(`(?:(?:^|[\\s;&|(])(?:cd|pushd)|\\s-C)\\s+${WORD}`, 'g');

/**
 * `word` as an existing directory, resolved against `base`, or `null` when it
 * is not a literal path: an expansion (`$`, backtick, `~`), a glob, a flag or
 * `-`, or an escape this does not interpret. `null` also for a path that does
 * not exist or is not a directory — a cd there fails and runs nothing after
 * its `&&`, and this is not the place to guess what it meant.
 */
function literalDirectory(word: string, base: string): string | null {
  const quoted = /^(["']).*\1$/s.test(word);
  const bare = quoted ? word.slice(1, -1) : word;
  if (bare === '' || bare.startsWith('-') || /[$`~*?[\]\\]/.test(bare)) return null;
  const resolved = path.resolve(base, bare);
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
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
