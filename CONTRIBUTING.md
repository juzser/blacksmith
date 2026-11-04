# Contributing to Blacksmith

Thanks for looking. Blacksmith is a small Claude Code plugin; contributions should keep it small. The operating rules for people and agents alike are in [AGENTS.md](AGENTS.md); this page is the short version for a first pull request.

## Before you start

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
bash scripts/check.sh
```

You need bash, git and node. Without the `claude` CLI the plugin validators print `SKIP`; the rest runs. If `check.sh` is not `== PASS ==` on a fresh clone, that is a bug: please open an issue.

## Sending a change

1. Branch from `main` as `feat/<slug>` or `fix/<slug>`.
2. Write the failing test first where there is a testable surface (`plugin/test/run.sh` for the plugin), then the change.
3. Run `bash scripts/check.sh` and paste its tail into the PR. It is the same file CI runs, as the job `gate (scripts/check.sh)`. A red gate is not merged.
4. Add a line to [CHANGELOG.md](CHANGELOG.md) under Unreleased if users will notice.

The repo layout and what the gate checks are in [docs/development.md](docs/development.md).

## What fits

Changes to the five pieces (rules, confidence %, cross-check, agents, compact), to pr-mod, and to the docs. A new feature has to give a reason that Claude Code's own defaults do not cover. [docs/history.md](docs/history.md) explains why the earlier, larger design was dropped.

## House rules

Name no other project or product, keep personal paths and credentials out, and link instead of copying a fact. Releases, tags, npm and repository settings are the maintainer's. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
