---
name: cross-check
description: Get a second opinion on a change from a different model (codex, read-only). The person runs it after a non-trivial change. It sends the diff, and files codex chooses to read, to the codex vendor.
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

   Put the base revision between the empty quotes when there is one. The script sends the diff of the working tree against the base (uncommitted changes included, but not untracked files: tell the person to run `git add -N <file>` to include a new file) and the changed test files to `codex exec -s read-only`, and prints the answer. Model and effort come from `CROSSCHECK_MODEL` (default `gpt-6-sol`) and `CROSSCHECK_EFFORT` (default `medium`). `CROSSCHECK_MAX_BYTES` (default 120000) caps the size. `CROSSCHECK_TIMEOUT` (default 540 seconds) stops a slow call.
4. If the output starts with `cross-check: skipped`, tell the person it was skipped and why, in plain words. Do not retry and do not block on it.
5. Otherwise try to reproduce each finding: write a failing test or run a probe with the concrete input it gave. Then report each one as:
   - reproduced and fixed;
   - reproduced, not fixed (say why);
   - not reproduced (say what you tried).

A finding you cannot reproduce is not a defect and blocks nothing. Do not run this again on the same diff unless the code changed.
