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

CI runs all five on every pull request. Run them locally first — see
[`AGENTS.md`](AGENTS.md) for the conventions this project holds itself to.

---

Built by blacksmith
