# AGENTS.md: operating rules for this repo

For any agent or person changing Blacksmith. Overview: [README.md](README.md). Usage: [docs/usage.md](docs/usage.md).

## What this repo is

A small Claude Code plugin in `plugin/`, a marketplace in `.claude-plugin/`, and the gate `scripts/check.sh`. Layout: [CONTRIBUTING.md](CONTRIBUTING.md). The old factory lives at the `factory-final` tag ([history](docs/history.md)).

## Branches

- Branches are `feat/<slug>`, `fix/<slug>` or `chore/<slug>`, cut from `main`, one worktree per agent (in `.claude/worktrees/`, git-ignored, or outside the repo).
- Never push to `main`, never force-push, never merge your own PR unless the maintainer said so for that PR. Deliver by pull request.
- `git add` only the files you changed, never `-A`.

## How to work

- Test first: write the failing test, watch it fail for the right reason, make it pass.
- Verify before you say done: run `bash scripts/check.sh` before every push. It must end in `== PASS ==`; a `SKIP` line proved nothing.
- Root cause before a fix. After two or three failed hypotheses, re-examine your assumptions.
- One source per fact: link, do not copy. A change users will notice gets a line in `CHANGELOG.md`.
- Keep the plugin small and stack-neutral. A new rule, agent or setting needs a reason Claude Code's defaults do not cover.

## Open-source hygiene

Name no other project or company's product. No personal paths, emails or credentials. Commits are English, imperative, subject at most 72 characters, saying why.

## Stops for the maintainer

Propose and wait on: releases, version bumps, tags, repository rulesets and required checks, security policy, license, and anything that changes what `plugin/rules.md` tells every session to do.
