# The stack: one answer file, and what reads it

Blacksmith does not have a stack. Its operator does, and this is where that
distinction is spelled out.

The answers live in
[`factory/policies/stack.yml`](../../factory/policies/stack.yml), written
during the install interview ([`INSTALL.md`](../../INSTALL.md) Step 5). This
document explains what they mean, who reads them, and what happens when the
shipped templates cannot serve one — it does not restate the answers, because
a second copy is a copy that drifts.

> **This file used to be the stack.** It shipped one operator's 2026-08-03
> interview — Vue, Cloudflare Workers, D1, Drizzle, and a private design
> system — as a mandate on every project the factory scaffolds, in a public
> repo, where the design system in question was not obtainable. Answers are
> data. They are stored as data now.

## Reading the answers

```bash
smith stack show     # the parsed answers, as JSON
smith stack check    # what the shipped templates do with each one
```

`stack show` is the parse, not the file: it applies the defaults for anything
unanswered and refuses anything outside a closed vocabulary, so what it prints
is what the scaffolder and the agents actually see.

## Three verdicts

`smith stack check` prints one verdict per answer, and exits 1 only on the
third.

| Verdict | Meaning |
| --- | --- |
| `honoured` | `factory/scaffold/` implements this answer. |
| `recorded` | Nothing in the scaffold reads it; the agents do. |
| `refused` | `smith new` stops rather than scaffolding something else. |

**`recorded` is not a failure.** `database: postgres` does not make the
scaffolder write migrations — it makes the planner and the coder know what
they are writing against. The template tree is narrower than the space of
honest answers, and a check that went red for every operator in that gap is a
check they would learn to ignore, which is worse than no check.

**`refused` is a refusal, not a substitution.** The failure mode this exists
to prevent: answering `frontend: react` at install time and being handed a Vue
project, which reads as the factory ignoring the interview it just ran.
`requireScaffoldable` runs before `smith new` creates a directory, so a
refusal leaves nothing behind to clean up.

## What the templates honour today

Measured, not aspirational — `smith stack check` derives this from the same
table the scaffolder branches on:

- `language: typescript` — `factory/scaffold/base` is a TypeScript package.
- `frontend: none | vue` — `factory/scaffold/ui` layers Vue 3 + Vite on
  `--ui`. `none` is honoured by refusing `--ui`.
- `styling: plain-css | tailwind` — `factory/scaffold/ui-tailwind` layers the
  Vite plugin and the dependency over the same UI template, so a `plain-css`
  project never sees Tailwind in its lockfile.
- `design_system` — any name. With a `design_system_source`, that directory is
  vendored into `<project>/design/`.

Hardcoded at one value, and `recorded` when the answer differs:
`package_manager` (`pnpm`, in the toolchain run, `ci.yml` and
`pnpm-workspace.yaml`), `repo_shape` (`single`), `lint` (`biome`), `test_unit`
(`vitest`), `ci` (`github-actions`). The check names the file each one is
hardcoded in, so the gap is something an operator can act on rather than
something they have to discover.

Read by agents and by nothing in the scaffold: `backend`, `database`, `orm`,
`test_e2e`, `hosting`.

## Design systems are vendored, never referenced

`design_system_source` is copied into `<project>/design/` at scaffold time.
The project builds with that directory gone, offline, forever — a design
system a project cannot build without is a dependency on somebody else's
uptime, and on their willingness to keep granting access.

`design_system: none` is the shipped answer and the right one for most
projects: the project owns its components, and the uiux agent specs against
what is actually there.

A named source that does not exist is `refused`. The version this replaced
skipped a missing kit best-effort, which produced a project whose stylesheet
imported a directory that had never been written — while the scaffold
reported success.

## The generated style entry

`src/styles/main.css` is written by the scaffolder, not copied from a
template, because its whole content follows from two answers: whether Tailwind
is the utility layer, and whether a design system was vendored. A static
template can only be correct for one combination of those, and the one it used
to ship was `@import 'tailwindcss'` over a private kit's tokens — both
unconditional.

Nothing regenerates it. After `smith new`, it is the project's file.

## Directory conventions (scaffold)

```
<project>/
├── AGENTS.md          # thin router (progressive disclosure)
├── mcp.manifest.json  # declared MCP surface (mcp.md) — added at the mcp milestone
├── src/               # app code (claims-friendly: one feature = one subtree)
│   ├── mcp/           # MCP server + tools/ (`smith mcp init`, never hand-rolled)
│   └── styles/        # generated entry, then yours (UI projects)
├── test/              # unit mirrors src/; e2e/ for the e2e suite
├── design/            # vendored design system, when one is named (UI projects)
└── .github/workflows/ # CI
```

`src/mcp/` and the manifest arrive late, at the mandatory
`<project> — mcp surface` milestone — not at `smith new`. See
[mcp.md](mcp.md) for why, and for the rules the surface has to pass.

## Non-negotiables, which are not stack answers

These hold whatever the interview said, because they are about how work is
verified rather than what it is built with:

- **`strict: true`** wherever the language has a strict mode. The scaffolded
  `tsconfig.json` sets it.
- **A coverage floor of 80%** on the logic paths a task claims; no floor on
  generated files and UI glue.
- **Tests run in CI**, and the merge queue's gates run locally before that.
  CI is the public record, not the first place a gate runs.
- **Screenshots for UI work**: desktop + mobile (390px), light + dark, at most
  four per feature, attached to the integration PR.
- **Nothing listens beyond localhost without something authenticating in front
  of it.** [`mcp.md`](mcp.md) MCP-X2 spells this out for MCP surfaces, and its
  manifest field is literally `access.cloudflareAccess` — Cloudflare Access is
  the proxy this repo was built against. That field is the one place a stack
  answer (`hosting`) is not honoured: the rule is universal, the field name is
  not, and generalizing it is owed work rather than a decision already taken.

## Dashboard-specific dependencies

This repo's own dashboard, not a rule for scaffolded projects:
**@vue-flow/core** (MIT, bcakmakoglu/vue-flow) for the Flow page's plan-DAG
visualization. Nodes are DOM elements, so design tokens and a11y semantics
apply directly. Graph layout is computed from the orchestrator's own
topological utilities (layered by longest-path depth) — no separate layout
library.
