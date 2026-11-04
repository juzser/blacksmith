# Cross-check

`/cross-check [base] [criteria]` asks a different model, codex, for one read-only review of your change. The skill is [`plugin/skills/cross-check/SKILL.md`](../plugin/skills/cross-check/SKILL.md); the work is done by [`cross-check.sh`](../plugin/skills/cross-check/cross-check.sh). It runs only when you invoke it; Claude is not allowed to start it.

## Setup

Install codex and log in (`codex login`). See [INSTALL.md](../INSTALL.md#step-2-codex-optional). With no `codex`, the skill reports "skipped" with the reason and never blocks.

## Settings

All optional, read from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `CROSSCHECK_MODEL` | `gpt-6-sol` | codex model, passed as `-m` |
| `CROSSCHECK_EFFORT` | `medium` | reasoning effort |
| `CROSSCHECK_MAX_BYTES` | `120000` | size cap for the diff plus changed tests |
| `CROSSCHECK_TIMEOUT` | `540` | seconds before the call is stopped |
| `CROSSCHECK_GRACE` | `5` | seconds between the stop signal and a hard kill |

## Privacy

Source code leaves your machine only when you run this. Codex starts as a read-only agent with `-C <your repo>`, so it can read any file in the repo it chooses to, and it loads the repo's agent instructions. Everything it reads goes to the codex vendor, together with the diff (uncommitted changes included), the changed test files and your criteria. Nothing else in the plugin sends anything out.

## Limits

- **Cap.** Over `CROSSCHECK_MAX_BYTES` the skill skips, because half a diff yields confident findings about code that is not there.
- **Timeout.** After `CROSSCHECK_TIMEOUT` seconds codex and its child processes are stopped, and the skill reports "skipped".
- **Symlinks.** A changed test file that is a symlink is not sent, so a link cannot pull in a file from outside the repo.
- **Untracked files.** They are not in the diff and are not reviewed; the output warns with a count. Run `git add -N <file>` to include one.

## How findings are handled

Findings are advisory. Claude tries to reproduce each one with a failing test or a probe on the concrete input given, then reports it as reproduced and fixed, reproduced and not fixed, or not reproduced. A finding that does not reproduce is not a defect and blocks nothing. The skill does not re-run on the same diff unless the code changed.
