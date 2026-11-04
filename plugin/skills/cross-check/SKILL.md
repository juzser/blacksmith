---
name: cross-check
description: Get a second opinion on a change from a different model (codex, read-only). Use after a non-trivial change, when the person asks for a cross-check or a second opinion. Sends the diff to the codex vendor, so run it only when the person has invoked it.
argument-hint: "[base-revision] [criteria]"
---

# Cross-check

One review by a different model, on the change as it stands. It is advisory.

## Steps

1. Pick the base. Use the argument if given, otherwise leave it empty and the script uses the merge-base with the default branch.
2. Gather the acceptance criteria from the arguments or the conversation: what the change must do, in a few lines.
3. Run the script. Its path is in this skill's directory:

   ```sh
   sh "${CLAUDE_SKILL_DIR}/cross-check.sh" "<base or empty>" "<criteria>"
   ```

   It sends `git diff <base>...HEAD`, the changed test files and the criteria to `codex exec -s read-only`, and prints the answer. Model and effort come from `CROSSCHECK_MODEL` (default `gpt-6-sol`) and `CROSSCHECK_EFFORT` (default `medium`). `CROSSCHECK_MAX_BYTES` (default 120000) caps the size.
4. If the output starts with `cross-check: skipped`, tell the person it was skipped and why, in plain words. Do not retry and do not block on it.
5. Otherwise try to reproduce each finding: write a failing test or run a probe with the concrete input it gave. Then report each one as:
   - reproduced and fixed;
   - reproduced, not fixed (say why);
   - not reproduced (say what you tried).

A finding you cannot reproduce is not a defect and blocks nothing. Do not run this again on the same diff unless the code changed.
