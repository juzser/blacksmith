# Unified Stack Standard

> Compiled from the operator interview on 2026-08-03 (answers: frontend,
> tooling, S2 calibration, epic budget; all other questions accepted the
> recommended defaults). Every project Black Smith scaffolds uses this stack.
> The planner may deviate only with a written justification attached to the
> epic spec. Re-run the interview to change anything here.

## Language

- **TypeScript everywhere, `strict: true`.** No plain JS in new code.

## Frontend

- **Vue 3 + Vite** — `<script setup lang="ts">`, Composition API.
  (Matches the operator's existing repos; lessons and HDS patterns transfer.)
- **Styling: HDS mandatory for all UI projects** — the HDS kit is
  vendor-copied into each scaffolded repo (never referenced from an external
  repo). **Tailwind CSS v4** as the utility layer under HDS tokens.

## Backend / runtime

- **Cloudflare Workers + Hono** as the default API runtime.
- Node 22 only when Workers can't serve (long-running processes, heavy
  binaries) — requires a deviation note in the epic spec.

## Database

- **SQLite locally / Cloudflare D1 deployed**, via **Drizzle ORM** — one
  schema, both targets.

## Repo shape + tooling

- **pnpm**; single repo per project (monorepo only at 3+ deployable units).
- **Biome** for lint + format (one tool, one config).

## Dashboard-specific dependencies

- **@vue-flow/core** (MIT, bcakmakoglu/vue-flow) — sanctioned for the Flow
  page's plan-DAG visualization. Nodes are DOM elements, so HDS tokens and
  a11y semantics apply directly. Graph layout is computed from the
  orchestrator's own topological utilities (layered by longest-path depth)
  — no separate layout library.

## Testing

- **Vitest** (unit) + **Playwright** (e2e + screenshots).
- Coverage floor: **80% on logic paths** claimed by a task; no floor on
  generated files and UI glue.
- Screenshot spec: desktop + mobile (390px), light + dark, max 4 shots per
  feature — attached to the integration PR.

## CI

- **GitHub Actions**: lint + typecheck + test + build on every PR. The merge
  queue's gates run locally; CI is the public record.

## Hosting

- **Cloudflare-first**: Pages/Workers + D1 + R2; Cloudflare Access before
  anything is exposed beyond localhost.

## Directory conventions (scaffold)

```
<project>/
├── AGENTS.md          # thin router (progressive disclosure)
├── mcp.manifest.json  # declared MCP surface (mcp.md) — added at the mcp milestone
├── src/               # app code (claims-friendly: one feature = one subtree)
│   └── mcp/           # MCP server + tools/ (`smith mcp init`, never hand-rolled)
├── server/            # Workers/Hono API (when present)
├── db/                # Drizzle schema + migrations
├── tests/             # unit mirrors src/; e2e/ for Playwright
├── hds/               # vendored HDS kit (UI projects)
└── .github/workflows/ # CI
```

`src/mcp/` and the manifest arrive late, at the mandatory
`<project> — mcp surface` milestone — not at `smith new`. See
[mcp.md](mcp.md) for why, and for the rules the surface has to pass.
