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
