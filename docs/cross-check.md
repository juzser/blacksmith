# Cross-check

`/cross-check [base] [criteria]` asks different models for one review of your change: codex (read-only agent) and DeepSeek (plain API), whichever are set up. The skill is [`plugin/skills/cross-check/SKILL.md`](../plugin/skills/cross-check/SKILL.md); the work is done by [`cross-check.sh`](../plugin/skills/cross-check/cross-check.sh). It runs only when you invoke it; Claude is not allowed to start it.

Both providers get the same prompt and run in parallel. The output has one group per provider, `## codex` and `## deepseek`, each holding that provider's findings or `skipped: <reason>`. A provider that is not set up is skipped and never blocks the other.

## Setup

- **codex.** Install it and log in (`codex login`). See [INSTALL.md](../INSTALL.md#step-2-codex-optional). With no `codex` on PATH it is skipped.
- **DeepSeek.** Export `DEEPSEEK_API_KEY` in your own shell, or put it under `env` in your user settings (`~/.claude/settings.json`). Do not put it in a file inside a repository. Needs `curl`, and `node` or `python3` to build and read the JSON. Without the key it is skipped.

The key is read from the environment only. It is written to a `0600` header file in the run's private temp directory and handed to `curl` with `-H @file`, so it never appears on a command line, and the file is removed when the run ends. The script never prints it, never prints raw response headers or an error body, and never reads a `.env` file.

## Settings

All optional, read from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `CROSSCHECK_PROVIDERS` | `codex deepseek` | which providers to run (space or comma separated) |
| `CROSSCHECK_MODEL` | `gpt-6-sol` | codex model, passed as `-m` |
| `CROSSCHECK_EFFORT` | `medium` | codex reasoning effort |
| `CROSSCHECK_DEEPSEEK_MODEL` | `deepseek-v4-pro` | DeepSeek model. It is pinned: a retired id is silently answered by another model |
| `CROSSCHECK_DEEPSEEK_URL` | `https://api.deepseek.com/chat/completions` | DeepSeek endpoint (OpenAI-compatible); also lets a test point at a fake server |
| `CROSSCHECK_MAX_BYTES` | `120000` | size cap for the diff plus changed tests |
| `CROSSCHECK_TIMEOUT` | `540` | seconds before the calls are stopped |
| `CROSSCHECK_GRACE` | `5` | seconds between the stop signal and a hard kill |

## Privacy

Source code leaves your machine only when you run this, and only to the providers that are set up.

- **codex vendor.** Codex starts as a read-only agent with `-C <your repo>`, so it can read any file in the repo it chooses to, and it loads the repo's agent instructions. Everything it reads goes to the codex vendor, together with the diff (uncommitted changes included), the changed test files and your criteria.
- **DeepSeek.** DeepSeek is a plain API call and cannot read your repo. It receives exactly the prompt: the diff (uncommitted changes included), the changed test files and your criteria, nothing else. That goes to DeepSeek's API at the URL above. To keep code from one of them, leave its credentials unset or list only the other in `CROSSCHECK_PROVIDERS`.

Nothing else in the plugin sends anything out.

## Limits

- **Cap.** Over `CROSSCHECK_MAX_BYTES` the skill skips before any call, because half a diff yields confident findings about code that is not there.
- **Timeout.** After `CROSSCHECK_TIMEOUT` seconds a running call and its child processes are stopped, and that provider reports "skipped".
- **Context.** Because DeepSeek sees only the prompt, its findings about code outside the diff and the changed tests are guesses; each still has to be reproduced.
- **Symlinks.** A changed test file that is a symlink is not sent, so a link cannot pull in a file from outside the repo.
- **Untracked files.** They are not in the diff and are not reviewed; the output warns with a count. Run `git add -N <file>` to include one.

## How findings are handled

Findings are advisory. Claude tries to reproduce each one with a failing test or a probe on the concrete input given, then reports it as reproduced and fixed, reproduced and not fixed, or not reproduced, naming the provider(s) that raised it. The same point from both providers counts once. A finding that does not reproduce is not a defect and blocks nothing. The skill does not re-run on the same diff unless the code changed.
