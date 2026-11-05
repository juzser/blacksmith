---
name: cross-check
description: Get a second opinion on a change from a different model (codex read-only; DeepSeek too when the person opts in). The person runs it after a non-trivial change. It sends the diff to each listed provider, and codex may also read files in the repo.
argument-hint: "[base-revision] [criteria]"
disable-model-invocation: true
---

# Cross-check

One review by a different model, on the change as it stands. It is advisory.

## Steps

1. Pick the base. Use the argument if given, otherwise pass an empty string and the script uses the merge-base with the default branch.
2. Gather the acceptance criteria from the arguments or the conversation: what the change must do, in a few lines.
3. Run the script with the criteria on stdin through a quoted heredoc, exactly in this form, so the shell never expands the text. Set the Bash tool timeout to 600000.

   ```sh
   sh "${CLAUDE_SKILL_DIR}/cross-check.sh" "" - <<'CROSSCHECK_CRITERIA_END'
   <criteria, pasted as they are>
   CROSSCHECK_CRITERIA_END
   ```

   Put the base revision between the empty quotes when there is one. The script sends the diff of the working tree against the base (uncommitted changes included, but not untracked files: tell the person to run `git add -N <file>` to include a new file) and the changed test files to each available provider and prints one group per provider (`## codex`, `## deepseek`). Codex runs as `codex exec -s read-only` and can read the repo. DeepSeek is an API call that sees only the prompt (diff, changed tests, criteria), not the repo. `CROSSCHECK_PROVIDERS` (default `codex`) picks the providers; DeepSeek runs only when it is named there (`codex deepseek`), so do not add it yourself. A listed provider that is not set up (no `codex`, no `DEEPSEEK_API_KEY`) shows `skipped: <reason>`. If the output notes that a DeepSeek key is set but DeepSeek is not enabled, pass that on to the person as an option; do not enable it for them. Models come from `CROSSCHECK_MODEL`, `CROSSCHECK_EFFORT` and `CROSSCHECK_DEEPSEEK_MODEL`. `CROSSCHECK_MAX_BYTES` (default 120000) caps the size. `CROSSCHECK_TIMEOUT` (default 540 seconds) stops a slow call.
4. If the output starts with `cross-check: skipped`, tell the person it was skipped and why, in plain words. Do not retry and do not block on it. If only some groups say `skipped:`, say which provider was skipped and why, then carry on with the rest.
5. Otherwise try to reproduce each finding, from every provider. A point both providers raise is one finding: report it once and name both. Treat a DeepSeek claim about code outside the diff and the changed tests with extra care, since it never saw that code. For each: write a failing test or run a probe with the concrete input it gave. Report each one as:
   - reproduced and fixed;
   - reproduced, not fixed (say why);
   - not reproduced (say what you tried).

A finding you cannot reproduce is not a defect and blocks nothing. Do not run this again on the same diff unless the code changed.
