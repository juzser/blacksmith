# Blacksmith

A small Claude Code plugin. It adds five things and leaves everything else to Claude Code's defaults.

1. **Plain explanations.** Rules for explaining things to a person: lead with the result, short sentences, jargon explained ([rules](docs/rules.md)).
2. **Confidence on options.** Every option carries a confidence %, and the recommended one says what its figure rests on.
3. **Cross-check.** `/cross-check` asks codex (read-only) to review your change, and DeepSeek too if you opt in ([details and privacy](docs/cross-check.md)).
4. **Model and effort per task.** Five agents, `planner`, `coder`, `reviewer`, `researcher` and `scout`, each with its own model and effort ([agents](docs/agents.md)).
5. **Compact rule.** Compact at about 60% of the context window, keeping what matters ([compact](docs/compact.md)).

Also in this repo, and optional: [`mods/pr-mod`](mods/pr-mod/README.md), a pane and a band line for the repo's open pull requests.

## Install

Inside Claude Code:

```
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
```

The same from a shell: `claude plugin marketplace add juzser/blacksmith`, then `claude plugin install blacksmith@blacksmith`. Start a new session afterwards.

To try a checkout without installing anything: `claude --plugin-dir ./plugin`.

A step-by-step runbook an agent can follow, with the optional parts (codex, the 60% setting, pr-mod), is in [INSTALL.md](INSTALL.md). Ask Claude to "install Blacksmith" and it will read that file.

## What it does not do any more

Earlier versions were a factory: spec contracts, worktree orchestration, review gates, a merge queue, a dashboard and a `bs` command. Those are gone. [docs/history.md](docs/history.md) says why, with the trial numbers, and how to get the old version back from the `factory-final` tag.

## Docs

[docs/README.md](docs/README.md) is the index. [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md) cover the rest.

## Attribution

Phrasing ideas drawn from ayghri/i-have-adhd (MIT).

## License

[MIT](LICENSE).
