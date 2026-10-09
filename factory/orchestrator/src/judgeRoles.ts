/**
 * The epic criterion's six judge roles (task 5 and task 6 objectives both
 * name this exact set: spec-reviewer, reviewer, verifier, grader,
 * security-reviewer, auditor) -- the roles whose dispatch declares an
 * artifact and whose SubagentStop is guarded by judge-stop.sh.
 *
 * A leaf module with no local imports of its own, so both `dispatchLint.ts`
 * (which needs `readJudgeTurns` from `judges.ts`) and `judges.ts` (which
 * needs this set for `foldJudgeTurns` and `recordJudgeDispatch`) can import
 * it without forming a cycle between the two. `dispatchLint.ts` re-exports
 * this set for its existing callers (judgeStopHook.ts, pluginManifest tests)
 * — one array, never copied.
 *
 * Not the same six as dispatch.md's "Fingerprint the worktree around every
 * judge" list, which swaps `auditor` for `uiux`: that section is about
 * which judges run inside a task's worktree (auditor runs over a whole
 * project at HEAD, never per-task, so a worktree fingerprint does not apply
 * to it; uiux does run per-task). This list is about which roles owe a
 * declared artifact and a blocked Stop, and `auditor` is one of them.
 */
export const JUDGE_ROLES = [
  'reviewer',
  'verifier',
  'grader',
  'spec-reviewer',
  'security-reviewer',
  'auditor',
] as const;
export type JudgeRole = (typeof JUDGE_ROLES)[number];

/**
 * `JUDGE_ROLES` plus `uiux`: every role a `smith judge dispatch` / `smith
 * judge report` pair can open and close a turn for. wave.md's steps 5-7
 * bracket the uiux visual pass with those same two verbs, same as grader,
 * reviewer, verifier and security-reviewer (wave.md:242-253) — so
 * `foldJudgeTurns` and `recordJudgeDispatch` (judges.ts) need uiux in scope
 * too, or a real uiux dispatch throws `judges.non-judge-role` and its turn
 * never folds.
 *
 * Deliberately NOT folded into `JUDGE_ROLES` itself: that set's meaning
 * ("owes a declared-artifact line and a blocked Stop") stays exactly the six
 * roles it always was for `dispatchLint.ts`'s `checkArtifact()` and
 * `judgeStopHook.ts`'s SubagentStop guard — uiux's artifact is always the
 * OBJECT `{run_status, structured_output, artifacts}` (bs-uiux.md), never the
 * array shape those two callers check for, so widening `JUDGE_ROLES` itself
 * would start demanding a declared-artifact line and a blocked Stop uiux was
 * never designed to carry.
 */
export const JUDGE_TURN_ROLES = [...JUDGE_ROLES, 'uiux'] as const;
export type JudgeTurnRole = (typeof JUDGE_TURN_ROLES)[number];
