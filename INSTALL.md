# Installing Blacksmith

An executable runbook. If you are an agent and the person asked you to install, set up or verify Blacksmith, run it top to bottom. What Blacksmith is: the [README](README.md).

## Part 0: rules for an agent running this file

- **Ask before touching the machine outside the clone.** Package installs (`brew`, `apt`, `dnf`, `npm i -g`), anything with `sudo`, plugin installs and marketplace adds (`claude plugin ...`, `/plugin ...`, which write into `~/.claude/`), and edits to the person's settings files all change their system. Propose the exact command and wait for a yes. Anything inside a clone you may just do.
- **Never report a step as passing without running it.** Paste the real output. A check that prints `SKIP` did not pass.
- Say which optional steps were skipped or declined. Do not "fix" the repo to make a check pass. After two failed attempts at one step, stop and ask.

## Step 1: install the plugin

Needs Claude Code. Check `claude --version`, then run (after a yes):

```sh
claude plugin marketplace add juzser/blacksmith
claude plugin install blacksmith@blacksmith
```

Inside a session the same is `/plugin marketplace add juzser/blacksmith` then `/plugin install blacksmith@blacksmith`. For a local checkout without installing, start sessions with `claude --plugin-dir /abs/path/to/blacksmith/plugin`. Start a new session afterwards. `claude plugin details blacksmith` should list 1 skill and 5 agents.

## Step 2: codex, for cross-check (optional)

Only if the person wants `/cross-check`. Read [docs/cross-check.md](docs/cross-check.md) first: it sends code to the codex vendor (and to DeepSeek only if the person opts in with `CROSSCHECK_PROVIDERS="codex deepseek"` and a `DEEPSEEK_API_KEY`). Check `codex --version`. If it is missing, this is a global install, so propose the command and ask first. Then the person logs in with `codex login` (they do this; it opens a browser). Without codex, `/cross-check` reports "skipped" and nothing breaks.

## Step 3: compact at 60% (optional)

Ask first. Merge this into the person's `~/.claude/settings.json` without replacing anything: read the file, add the key under `env`, keep every other key and every existing `env` entry, and show the diff before writing.

```json
{ "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
```

If the key is already set to a lower value, leave it. Why: [docs/compact.md](docs/compact.md).

## Step 4: pr-mod (optional)

A pull-request pane and band. Needs the `gh` CLI signed in (`gh auth status`) and a Claude Code build that loads plugin modules. After a yes:

```sh
claude plugin install pr-mod@blacksmith
```

More: [mods/pr-mod/README.md](mods/pr-mod/README.md).

## Step 5: verify

Run each and show the output.

1. The rules reach the model. Run:
   `claude -p "Quote the first rule heading you were given at session start, verbatim."`
   Expect `## 1. Talking to a person` (the rules file's first heading). If the model says it has no such rule, the hook did not run: check `claude plugin details blacksmith` and start a fresh session.
2. If codex is set up: make a one-line scratch change in a throwaway git repo, then run `/cross-check` in a session there. Expect findings, or a line starting `cross-check: skipped (<reason>)`. A skip with a reason is an honest result; say which.
3. In a clone of this repo, `bash scripts/check.sh` ends in `== PASS ==`. Read the tail: SKIP lines mean a step did not run.

## Remove the old setup

If the person used the older factory version, these may still exist. Say what you found and offer them. They can remove each by hand. **Never remove them automatically.**

- The old `bs` command: `npm rm -g @juzser/blacksmith` (a global change: ask first).
- In each project where `bs init` ran: the `.blacksmith/` folder (event logs, plans, policies), `.claude/bs-settings-record.json`, the concurrency and compact lines `bs init` wrote into `.claude/settings.local.json`, and its lines in `.git/info/exclude`. Check before deleting: `.blacksmith/factory/` may hold the person's own roadmap and answers.
- Beside such projects: worktrees in `.wt/<project>/` (list them with `git worktree list` first) and the lock folder `~/.blacksmith/`.
- The optional `bs-mod` plugin: `claude plugin uninstall bs-mod`.

The old version stays available: see [docs/history.md](docs/history.md).
