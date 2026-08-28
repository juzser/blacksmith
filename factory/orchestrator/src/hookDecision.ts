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
import {
  detectCurrentBranch,
  detectRepoRoot,
  evaluateCommand,
  loadGuardrailPolicy,
  type PolicyContext,
} from './policy.js';
import { activeSandboxFor } from './sandbox.js';

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
  // Branch and repo root come from where the command would actually run, which
  // the PreToolUse payload carries as `cwd`. Resolving them from this binary's
  // own checkout instead would be wrong in the case this factory spends most of
  // its time in: guard.sh always execs the main clone's dist, while the session
  // issuing the command is usually inside a per-task git worktree on a
  // different branch. That gap is not academic — `git rebase` on
  // smith/<epic>/integration is a rule-5 denial, and the merge queue performs
  // rebases from a worktree standing on exactly that branch while the main
  // clone stands elsewhere. The old bash hook got this right for free by
  // running `git rev-parse` in its own inherited cwd; the port has to ask for
  // it. `fallbackCwd` covers a payload without the field (a hand-driven
  // invocation, or an older client), and a cwd outside any repo resolves to
  // ''/null, which denies an out-of-bounds removal rather than allowing it.
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : fallbackCwd;
  const context: PolicyContext = {
    toolName,
    command,
    branch: detectCurrentBranch(cwd),
    repoRoot: detectRepoRoot(cwd),
    // Resolved from the same `cwd`, and for the same reason: the lease is keyed
    // by the worktree a judge was handed, and `cwd` is the only thing in a
    // PreToolUse payload that says where the command will run. No lease is the
    // ordinary case and costs one directory read.
    sandbox: activeSandboxFor(cwd),
    filePath,
  };
  const decision = evaluateCommand(context, loadGuardrailPolicy());
  if (decision.allowed) {
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
  // guard.sh only ever surfaced one reason: each rule block()ed and exited
  // immediately on its own match, sequentially, so the first rule in guard.sh's
  // 1-6 order to fire is the only one an agent ever saw. evaluateCommand's
  // checks array preserves that same order, so violations[0] reproduces
  // guard.sh's exact visible behaviour even though evaluateCommand (policy
  // check's diagnostic output) reports every rule that tripped, not just the
  // first.
  const first = decision.violations[0];
  const reason = first ? first.reason : 'guardrails.yml denied this command.';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOCKED: ${reason}`,
    },
  };
}
