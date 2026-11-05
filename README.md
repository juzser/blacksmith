# Blacksmith

A small plugin for Claude Code. Claude Code's defaults already do most of the work, so Blacksmith adds only what they leave out: a few always-on rules, two commands you run yourself, and four agents.

Day to day there is nothing to learn. You work in Claude Code as usual, and the rules apply on their own.

## What you get

### Rules in every session

One short file, [plugin/rules.md](plugin/rules.md). A hook loads it when a session starts, on resume, after `/clear` and after a compact.

| Rule | What you notice |
|---|---|
| Plain explanations | Claude leads with the result, in short sentences and in your language. Jargon is explained and technical details come last. |
| Confidence on options | Every option shows a %, and the recommended one says what its figure rests on. |
| Verify before done | Claude does not say "done", "fixed" or "passing" until it has run the command that shows it. |
| The right agent for the job | Planning goes to a stronger model, routine coding and review to a cheaper one. |
| Compact early | Near 60% of the context window, Claude asks you to compact and says what to keep. [One setting](docs/usage.md#compact) makes it automatic. |

### Two commands you run yourself

Claude cannot start these: `/audit` is costly and `/cross-check` sends code to other vendors. After a non-trivial change Claude offers `/cross-check`, and the choice is yours.

- **`/cross-check [base] [criteria]`** asks a different model to review your change: codex, read-only, plus DeepSeek if you opt in. For example, `/cross-check main "rejects empty input"`. A finding counts only once Claude reproduces it. Without codex it reports "skipped" and nothing breaks ([setup](docs/cross-check.md)).
- **`/audit [axis ...] [path]`** reads the project for performance, code-quality and security problems, one agent per axis in parallel. For example, `/audit` or `/audit security src/`. It changes nothing, and your `CLAUDE.md` counts: a design it documents as deliberate is not a finding ([details](docs/audit.md)).

### Four agents

`planner` splits bigger work into parts. `coder` builds one part, test-first, in its own git worktree. `reviewer` reads a diff with fresh eyes. `auditor` covers one axis of `/audit`. Each has its own model and effort ([routing, and how to change it](docs/usage.md#agents)).

## Install

Inside Claude Code:

```
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
```

Then start a new session. `claude plugin details blacksmith` should list 2 skills and 4 agents.

From a shell: `claude plugin marketplace add juzser/blacksmith`, then `claude plugin install blacksmith@blacksmith`. To try a checkout without installing: `claude --plugin-dir ./plugin`. An agent can do all of this from [INSTALL.md](INSTALL.md): ask Claude to "install Blacksmith".

## What leaves your machine

Only `/cross-check` sends your code to another vendor, and only when you run it. By default that is codex, which can read any file in the repo. DeepSeek gets the diff, the changed tests and your criteria, and only if you opt in. [Exactly what goes where](docs/cross-check.md#privacy).

## Why it is small

Until 0.7.0 Blacksmith was a factory: an orchestrator, a dashboard, fourteen agents and a `bs` command. Then the same five tasks were run in plain Claude Code and through the factory, one run each. Both passed every check, and a blind review found the code about equal. The factory took about nine times the tokens and the time.

So 1.0.0 keeps the few parts that helped and leaves the rest to Claude Code. A new piece has to give a reason the defaults do not cover. [The numbers and the full story](docs/history.md).

## Coming from 0.x

1.0.0 breaks 0.x on purpose: the `bs` command, `/bs`, the dashboard, `bs-mod` and `pr-mod` are gone. Follow the [upgrade steps](CHANGELOG.md#upgrading-from-0x). The old factory stays reachable at the git tag `factory-final` and as `@juzser/blacksmith@0.7.0` on npm ([how](docs/history.md#get-the-old-factory-back)).

## More

- [Usage](docs/usage.md): how the rules load, how to turn them off or override them, agents, compact.
- [Cross-check](docs/cross-check.md) and [audit](docs/audit.md).
- [Changelog](CHANGELOG.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md).

Phrasing ideas drawn from ayghri/i-have-adhd (MIT). License: [MIT](LICENSE).
