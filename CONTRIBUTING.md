# Contributing to Blacksmith

Thanks for looking. Blacksmith is a small Claude Code plugin; contributions should keep it small. The operating rules for people and agents alike are in [AGENTS.md](AGENTS.md); this page is the short version for a first pull request.

## Before you start

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
bash scripts/check.sh
```

You need bash, git and node. Without the `claude` CLI the plugin validators print `SKIP`; the rest runs. If `check.sh` is not `== PASS ==` on a fresh clone, that is a bug: please open an issue.

## Sending a change

1. Branch from `main` as `feat/<slug>`, `fix/<slug>` or `chore/<slug>`.
2. Write the failing test first where there is a testable surface (`plugin/test/run.sh` for the plugin), then the change.
3. Run `bash scripts/check.sh` and paste its tail into the PR. It is the same file CI runs, as the job `gate (scripts/check.sh)`. A red gate is not merged.
4. Add a line to [CHANGELOG.md](CHANGELOG.md) under Unreleased if users will notice.

## Layout and the gate

```
plugin/               the plugin: rules.md, hooks/, agents/, skills/, test/
.claude-plugin/       marketplace.json: lists the plugin
scripts/check.sh      the gate
scripts/check-md-links.mjs, test-md-links.sh   the markdown link check and its test
docs/                 usage, cross-check, audit, history
```

`bash scripts/check.sh` runs `plugin/test/run.sh`, checks that the JSON parses and that every marketplace `source` exists (the main entry must be `./plugin`), runs `sh -n` on the plugin's scripts, checks that every relative link in a tracked `.md` file resolves to a tracked path, and, when `claude` is on PATH, runs `claude plugin validate plugin`. Without `claude` that prints `SKIP`: read the tail, not the exit code. It must end in `== PASS ==`. CI runs the same file as the job `gate (scripts/check.sh)`. Try the plugin from a checkout with `claude --plugin-dir ./plugin`.

## What fits

Changes to the plugin's pieces (rules, confidence %, cross-check, audit, agents, compact) and to the docs. A new feature has to give a reason that Claude Code's own defaults do not cover. [docs/history.md](docs/history.md) explains why the earlier, larger design was dropped.

## House rules

Name no other project or product, keep personal paths and credentials out, and link instead of copying a fact. Releases, tags, npm and repository settings are the maintainer's. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
