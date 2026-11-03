# __PROJECT_NAME__

## Getting started

```sh
pnpm install
pnpm test
```

## Checks

| Command | What it answers |
| --- | --- |
| `pnpm run lint` | Does it meet the style and correctness rules Biome enforces? |
| `pnpm run typecheck` | Does `src/` typecheck under `strict: true`? |
| `pnpm run typecheck:test` | Does `test/` typecheck too? |
| `pnpm run test:coverage` | Does the suite pass, and clear the coverage floor? |
| `pnpm run build` | Does it compile? |

`pnpm run check` runs all five in that order and stops at the first red. It is
the same script CI runs, so the gate needs nothing but Node and pnpm: GitHub
Actions is where it also runs, never a requirement. `pnpm run check -- --tier
post-merge` runs one tier; `--list` prints the names it would run.

## Tiers

By default every check is `pre-merge`. To run some checks later, commit a
`checks.json` at the project root:

```json
[
  { "name": "unit", "cmd": "pnpm run test:coverage" },
  { "name": "audit", "cmd": "pnpm audit --prod", "tier": "pre-release" }
]
```

`tier` is `pre-merge` (the default), `post-merge` or `pre-release`; any other
value is refused. An entry may also carry `timeout_ms`, which kills the check
after that long, and `heavy`, which this script accepts and ignores. The file
needs at least one `pre-merge` entry.

CI runs one job per tier on every pull request and push, in parallel. A tier
with nothing to run is skipped, never shown as passed. CI follows only the
tiers a committed `checks.json` declares: a tier chosen on someone's own
machine never reaches it. With `--ui`, `.github/workflows/e2e.yml` shards a
check named `e2e` whose command is `pnpm run test:e2e`, once `package.json` has
that script; until then it runs nothing.

See [`AGENTS.md`](AGENTS.md) for the conventions this project holds itself to.

---

Built by blacksmith
