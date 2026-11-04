# AGENTS.md: operating rules for this repo

For any agent or person changing Blacksmith. Overview: [README.md](README.md). Docs index: [docs/README.md](docs/README.md).

## What this repo is

A small Claude Code plugin in `plugin/`, an optional module in `mods/pr-mod/`, a marketplace in `.claude-plugin/`, and the gate `scripts/check.sh`. Layout and the gate: [docs/development.md](docs/development.md). The old factory is gone; it lives at the `factory-final` tag ([history](docs/history.md)).

## Branches and worktrees

- Branch names are `feat/<slug>` or `fix/<slug>`, cut from `main`. Chores may use `chore/<slug>`.
- One worktree per agent, so two agents never share a checkout. Worktrees go in a folder outside the repo, or in `.claude/worktrees/`, which is git-ignored.
- Never push to `main`, never force-push, never merge your own PR unless the maintainer has said so for that PR. Deliver by pull request.
- Add only the files you changed to a commit; do not use `git add -A`.

## How to work

- Test first wherever there is a testable surface: write the failing test, watch it fail for the right reason, make it pass, then clean up.
- Verify before you say it is done. Run the command and read its output. Run `bash scripts/check.sh` before every push; it must end in `== PASS ==`, and a `SKIP` line is a step that proved nothing.
- Find the root cause before a fix. After two or three failed hypotheses, stop and re-examine the assumptions.
- Keep one source per fact. Link to the place that owns a fact instead of copying it. The link check in `scripts/check.sh` fails on a broken relative link.
- Keep the plugin stack-neutral and small. A new rule, agent or setting needs a reason that a Claude Code default does not already cover.

## Open-source hygiene

- Name no other project, company or person's product in any file, commit or PR text.
- No personal paths, emails or machine names. Use `$HOME`, `<repo>` and placeholders.
- No credentials, ever, including in examples.
- Commit messages are English, imperative, at most 72 characters in the subject, and say why.
- A change that users will notice gets a line in `CHANGELOG.md` under Unreleased.

## Decisions that stop for the maintainer

Do not decide these yourself; propose and wait: releases and version bumps, tags, npm publishing or deprecation, repository rulesets and required checks, security policy, license, and anything that changes what `plugin/rules.md` tells every session to do.
