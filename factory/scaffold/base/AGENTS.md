# __PROJECT_NAME__ — Agent Router

Thin router (progressive disclosure) — read detail files on demand, do not
preload this repo's whole context.

## Stack

TypeScript, `strict: true`. pnpm. Biome (lint + format). Vitest (unit tests).
GitHub Actions CI runs `scripts/check.mjs`, one job per tier, on every PR
(`.github/workflows/ci.yml`).

## Layout

| Path | What |
|---|---|
| `src/` | Application code |
| `test/` | Vitest unit tests, mirrors `src/` |

## Rules

- **TDD.** A failing test exists before the implementation that makes it
  pass — no production code without one.
- **Strict YAGNI.** Build exactly what the task spec asks for; no unspecced
  abstractions, config options, or drive-by refactors.
- **Language.** Code, comments, and commits are English.
- **Commits.** Subject <=72 chars, imperative, why-focused.

## Gate

Every change clears the same gate CI runs, and clears it locally first:
`pnpm run check`, which runs `pnpm run lint`, `pnpm run typecheck`,
`pnpm run typecheck:test`, `pnpm run test:coverage` and `pnpm run build` in
that order. Nothing here needs GitHub Actions: the script is the gate, locally
and in CI. A committed `checks.json` replaces that list and may place a check
in the `post-merge` or `pre-release` tier (default `pre-merge`); CI runs a job
per tier and skips a tier with nothing to run. Green here or it is not ready
to propose.
