# Security Policy

## Supported versions

Only the latest release of the plugin, and the current `main`. Fixes land on `main`; there are no backport branches.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**. That opens a private advisory visible only to you and the maintainers.

Please include what an attacker can do (not only what looks wrong), the smallest reproduction you have, and the commit SHA or plugin version you saw it on. **Never put a credential in a report.** If one is needed to make sense of it, say so and it will be handled in the advisory thread.

You should get an acknowledgement within a few days. This is a small project: there is no bounty and no SLA.

## In scope

- **Cross-check.** `/cross-check` sends code to a third-party service. A path where it sends more than [documented](docs/cross-check.md), runs without the person invoking it, or lets codex write to the tree, is in scope.
- **The SessionStart hook.** `plugin/hooks/session-rules.sh` runs on every session start. A way to make it run something other than printing `rules.md` is in scope.
- **The audit.** `/audit` agents are read-only by instruction. A path where an audit changes the tree, or runs without the person starting it, is in scope.
- **Scripts.** Shell injection through a branch name, file name or criteria text passed to `cross-check.sh`.

## Out of scope

Behaviour of Claude Code or codex themselves; report those to their vendors. Prompt injection into a model that has no way to act beyond what the person already allowed.
