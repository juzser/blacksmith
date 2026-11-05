# Installing Blacksmith

An executable runbook. If the person asked you to install, set up or verify Blacksmith, run it top to bottom. What Blacksmith is: the [README](README.md).

## Part 0: rules for an agent running this file

- **Ask before touching the machine outside the clone.** Package installs (`brew`, `apt`, `npm i -g`), anything with `sudo`, plugin installs and marketplace adds (`claude plugin ...`, `/plugin ...`, which write into `~/.claude/`), and edits to the person's settings files all change their system. Propose the exact command and wait for a yes. Inside a clone you may just act.
- **Never report a step as passing without running it.** Paste the real output. A check that prints `SKIP` did not pass.
- Say which optional steps were skipped or declined. Do not "fix" the repo to make a check pass. After two failed attempts at one step, stop and ask.

## Step 1: install the plugin

Needs Claude Code (`claude --version`). After a yes:

```sh
claude plugin marketplace add juzser/blacksmith
claude plugin install blacksmith@blacksmith
```

If it says "already added" or "already installed" (an older version, such as 0.7.0, is present), update instead: `claude plugin marketplace update blacksmith`, then `claude plugin update blacksmith@blacksmith`, and restart.

For a checkout without installing, start sessions with `claude --plugin-dir /abs/path/to/blacksmith/plugin`. Start a new session afterwards. `claude plugin details blacksmith` should list 2 skills and 4 agents.

## Step 2: codex, for cross-check (optional)

Only if the person wants `/cross-check`. Read [docs/cross-check.md](docs/cross-check.md) first: it sends code to the codex vendor (and to DeepSeek only if the person opts in with `CROSSCHECK_PROVIDERS="codex deepseek"` and a `DEEPSEEK_API_KEY`). Check `codex --version`; if missing, a global install needs a yes first. The person runs `codex login` themselves. Without codex, `/cross-check` reports "skipped" and nothing breaks.

## Step 3: compact at 60% (optional)

Ask first. Merge into `~/.claude/settings.json` without replacing anything: read it, add the key under `env`, keep every other key, show the diff before writing.

```json
{ "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
```

If the key is already set lower, leave it. Why: [docs/usage.md](docs/usage.md#compact).

## Step 4: verify

Run each and show the output.

1. The rules reach the model: `claude -p "Quote the first rule heading you were given at session start, verbatim."` Expect `## 1. Talking to a person`. If not, the hook did not run: check `claude plugin details blacksmith` and start a fresh session.
2. If codex is set up: in a throwaway git repo with a one-line change, ask the person to run `/cross-check` (you do not: it sends code to other vendors). Expect findings or `cross-check: skipped (<reason>)`; a skip with a reason is honest, so say which.
3. In a clone of this repo, `bash scripts/check.sh` ends in `== PASS ==`. Read the tail: SKIP lines did not run.

## Remove the old setup

The older factory version may have left files. Say what you found and offer to remove them; **never remove them automatically.** The old `bs` command (`npm rm -g @juzser/blacksmith`, a global change: ask first); in projects where `bs init` ran, `.blacksmith/` (check it first: it may hold the person's roadmap), `.claude/bs-settings-record.json` and its lines in `.claude/settings.local.json` and `.git/info/exclude`; worktrees in `.wt/<project>/` (`git worktree list` first); `~/.blacksmith/`; the `bs-mod` and `pr-mod` plugins (`claude plugin uninstall bs-mod`, `claude plugin uninstall pr-mod`); and these keys in `~/.claude/settings.json` `env` or a project's settings, which the person removes by hand: `BS_PROMPT_HOOK`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (the old caps), and any `autoCompactWindow` or `modelSettings` entries `bs init` wrote. The old version stays available: [docs/history.md](docs/history.md).
