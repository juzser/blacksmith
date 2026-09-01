# __PROJECT_NAME__ — Agent Router

Thin router (progressive disclosure) — read detail files on demand, do not
preload this repo's whole context.

## Stack

TypeScript, `strict: true`. pnpm. Biome (lint + format). Vitest (unit tests).
GitHub Actions CI runs lint + typecheck + test + build on every PR
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

Every change clears the same five steps CI runs, and clears them locally
first: `pnpm run lint`, `pnpm run typecheck`, `pnpm run typecheck:test`,
`pnpm run test:coverage`, `pnpm run build`. Green here or it is not ready to
propose.
