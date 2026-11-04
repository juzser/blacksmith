# Cross-check

`/cross-check [base] [criteria]` asks a different model for one review of your change: codex (read-only agent) by default, and DeepSeek (plain API) when you opt in. The skill is [`plugin/skills/cross-check/SKILL.md`](../plugin/skills/cross-check/SKILL.md); the work is done by [`cross-check.sh`](../plugin/skills/cross-check/cross-check.sh). It runs only when you invoke it; Claude is not allowed to start it.

Providers run in parallel on the same prompt. The output has one group per provider that was asked for, `## codex` and `## deepseek`, each holding that provider's findings or `skipped: <reason>`. A listed provider that is not set up is skipped and never blocks the other.

## Setup

- **codex.** Install it and log in (`codex login`). See [INSTALL.md](../INSTALL.md#step-2-codex-optional). With no `codex` on PATH it is skipped.
- **DeepSeek (opt-in).** DeepSeek runs only when you name it: `CROSSCHECK_PROVIDERS="codex deepseek"`. Merely having `DEEPSEEK_API_KEY` exported for other tools sends nothing; the output then carries a one-line note saying how to turn it on. Export `DEEPSEEK_API_KEY` in your own shell, or put it under `env` in your user settings (`~/.claude/settings.json`); never in a file inside a repository. Needs `curl`, and `node` or `python3` to build and read the JSON. Listed without the key, it is skipped.

The key is read from the environment only, then removed from it, so codex and every other child process never see it. It is piped to `curl` on stdin (`-H @-`): no file on disk ever holds it and it is on no command line. The script never prints it, never prints raw response headers or an error body, and never reads a `.env` file. `curl` runs with `-q` (no `.curlrc`), `-g`, no `-L` (a redirect is never followed with the key), and `https` only. The endpoint must be an `https://` URL; `http://` is accepted only for `127.0.0.1` or `localhost`. Anything else is `skipped: bad deepseek URL`.

## Settings

All optional, read from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `CROSSCHECK_PROVIDERS` | `codex` | which providers to run (space or comma separated); DeepSeek runs only if named |
| `CROSSCHECK_MODEL` | `gpt-6-sol` | codex model, passed as `-m` |
| `CROSSCHECK_EFFORT` | `medium` | codex reasoning effort |
| `CROSSCHECK_DEEPSEEK_MODEL` | `deepseek-v4-pro` | DeepSeek model. It is pinned: a retired id is silently answered by another model |
| `CROSSCHECK_DEEPSEEK_URL` | `https://api.deepseek.com/chat/completions` | DeepSeek endpoint (OpenAI-compatible); also lets a test point at a fake server |
| `CROSSCHECK_MAX_BYTES` | `120000` | size cap for the diff plus changed tests |
| `CROSSCHECK_TIMEOUT` | `540` | seconds before the calls are stopped |
| `CROSSCHECK_GRACE` | `5` | seconds between the stop signal and a hard kill |

## Privacy

Source code leaves your machine only when you run this, and only to the providers you listed (codex by default).

- **codex vendor.** Codex starts as a read-only agent with `-C <your repo>`, so it can read any file in the repo it chooses to, and it loads the repo's agent instructions. Everything it reads goes to the codex vendor, together with the diff (uncommitted changes included), the changed test files and your criteria.
- **DeepSeek.** DeepSeek is a plain API call and cannot read your repo. It receives exactly the prompt: the diff (uncommitted changes included), the changed test files and your criteria, nothing else. That goes to DeepSeek's API at the URL above. To keep code from one of them, leave its credentials unset or list only the other in `CROSSCHECK_PROVIDERS`.

Nothing else in the plugin sends anything out.

## Limits

- **Cap.** Over `CROSSCHECK_MAX_BYTES` the skill skips before any call, because half a diff yields confident findings about code that is not there.
- **Timeout.** After `CROSSCHECK_TIMEOUT` seconds a running call and its child processes are stopped, and that provider reports "skipped".
- **Context.** Because DeepSeek sees only the prompt, its findings about code outside the diff and the changed tests are guesses; each still has to be reproduced.
- **Cancel.** If the run is interrupted (INT, TERM, HUP), the provider processes and the temp directory are cleaned up and the output says `skipped (cancelled)`. A hard KILL cannot be trapped. If it hits the script alone, the watchdog notices, stops the calls and removes the temp directory. If it hits the whole process group at once, the watchdog dies too and the temp directory (diff, test files and prompt; never the key) stays behind.
- **Output.** Control characters (escape, bell, and the UTF-8 C1 range U+0080 to U+009F) in a model's answer are dropped before printing; newlines and tabs stay.
- **Symlinks.** A changed test file that is a symlink is not sent, so a link cannot pull in a file from outside the repo.
- **Untracked files.** They are not in the diff and are not reviewed; the output warns with a count. Run `git add -N <file>` to include one.

## How findings are handled

Findings are advisory. Claude tries to reproduce each one with a failing test or a probe on the concrete input given, then reports it as reproduced and fixed, reproduced and not fixed, or not reproduced, naming the provider(s) that raised it. The same point from both providers counts once. A finding that does not reproduce is not a defect and blocks nothing. The skill does not re-run on the same diff unless the code changed.
