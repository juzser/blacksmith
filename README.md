# Blacksmith

A small Claude Code plugin. It adds a few things and leaves the rest to Claude Code's defaults.

1. **Plain explanations.** Lead with the result, short sentences, jargon explained ([rules](docs/usage.md#rules)).
2. **Confidence on options.** Every option carries a confidence %, and the recommended one says what it rests on.
3. **`/cross-check`.** A read-only review of your change by codex, and DeepSeek if you opt in ([details and privacy](docs/cross-check.md)).
4. **`/audit`.** A read-only audit by axis (performance, code-quality, security), one agent per axis in parallel ([audit](docs/audit.md)).
5. **Four agents.** `planner`, `coder`, `reviewer` and `auditor`, each with its own model and effort ([agents](docs/usage.md#agents)).
6. **Compact rule.** Compact at about 60% of the context window ([compact](docs/usage.md#compact)).

## Install

Inside Claude Code:

```
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
```

From a shell: `claude plugin marketplace add juzser/blacksmith`, then `claude plugin install blacksmith@blacksmith`. Start a new session afterwards. To try a checkout without installing: `claude --plugin-dir ./plugin`.

An agent can follow [INSTALL.md](INSTALL.md) step by step; ask Claude to "install Blacksmith".

## What it does not do any more

Earlier versions were a factory (spec contracts, worktree orchestration, review gates, a dashboard, a `bs` command). It is gone; [docs/history.md](docs/history.md) says why and how to get it back from the `factory-final` tag.

## More

Usage: [docs/usage.md](docs/usage.md). See also [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Phrasing ideas drawn from ayghri/i-have-adhd (MIT). License: [MIT](LICENSE).
