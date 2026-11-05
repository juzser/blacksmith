# History: why Blacksmith was reduced

Until 0.7.0 Blacksmith was a factory: an orchestrator, a dashboard, fourteen agents and a command-line tool. In 1.0.0 it became a small plugin. The old tree is kept, untouched, at the git tag `factory-final`.

## What the old factory did

- Planned a feature as signed spec contracts, one per task, validated by a schema.
- Built each task in its own git worktree, by a coder agent restricted to the task's file claims.
- Put each result through gates: schema checks, tests, a reviewer, and a verifier that re-checked the reviewer's findings.
- Ranked findings by severity (S1 stops the line, S4 is logged only) and let a person waive some.
- Merged tasks through a queue into one integration branch and one pull request.
- Kept an event log per epic, with budgets, lessons distilled from errors, and cross-provider judges.
- Showed it all in a dashboard (`bs ui serve`) and a live status band (`bs-mod`), driven by the `bs` command and the `/bs` skill.

## The trial

Before deciding, the same five tasks were run twice on a small sample app: once in plain Claude Code, once through Blacksmith (one run per cell, so single runs). Every run passed its hidden check in both arms.

| | Plain Claude Code | Blacksmith |
|---|---|---|
| Tokens (five runs) | 0.53 M | 4.87 M (about 9.2 times) |
| Active time | 22 min | 194 min (about 8.8 times) |
| Interventions by the person | 0 | 28 |

Tokens are a floor (cache reads are not counted; see the methodology in the `factory-final` tag, `docs/trial/methodology.md`). Active time is the span of the run minus the time spent waiting for the person. A blind review of the outputs found them all merge-ready. Blacksmith's outputs were slightly better in three tasks, equal in one, and slightly worse in one. The edge came from the tests it wrote, not from the process around them.

That is a large cost for a small gain on tasks of this size. So the process was dropped and the few parts that helped were kept: explanations a person can follow, a confidence % on options, a second opinion from another model, the right model and effort per kind of task, and a compact rule. A small read-only audit and a verify-before-done rule stayed too.

## Get the old factory back

- From git: `git checkout factory-final`, then follow the `INSTALL.md` in that tree. This is 0.7.0 plus what merged after it ([list](../CHANGELOG.md#merged-after-070-never-published)).
- From npm: the last published version of the old command-line tool is `@juzser/blacksmith@0.7.0` (`npm i -g @juzser/blacksmith@0.7.0`). The package is marked deprecated, so npm prints a warning; it still installs.

Nothing from the old setup is removed from your projects automatically; see [INSTALL.md](../INSTALL.md#remove-the-old-setup).
