# Contributing to Blacksmith

Thanks for looking at this. Blacksmith is an autonomous agent factory that
is built by its own agents, so "contributing" here means two slightly
different things depending on who you are:

- **A person sending a PR.** Normal open-source flow — fork, branch, run the
  gate, open a PR. This document is for you.
- **An agent running inside the factory.** Your rules are
  [`AGENTS.md`](AGENTS.md) plus your template in `.claude/agents/` and the
  policies in `factory/policies/`. Those are stricter and they win.

Both paths end at the same gate.

## Before you start

Read [`INSTALL.md`](INSTALL.md) for the full requirement list, per-platform
setup and troubleshooting. The short version:

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
bash scripts/check.sh
```

If `scripts/check.sh` is not `== PASS ==` on a fresh clone, that is a bug —
please open an issue rather than working around it.

## The gate

**`bash scripts/check.sh` is the contract.** `.github/workflows/ci.yml`
invokes that same file rather than a transcription of its command list, so
there is no second list to drift. A PR whose gate is red will not be merged.

It runs, in order:

| Step | What it proves |
|---|---|
| PyYAML probe | the policy/schema half can run at all |
| `factory/policies/*.yml` | every policy file parses |
| `factory/specs/schema/*.json` | every JSON Schema parses |
| `x-taxonomy` resolution | every schema annotation names a real dimension in `taxonomy.yml` |
| agent frontmatter | the set of `.claude/agents/*.md` equals the taxonomy's `agent` dimension |
| `bash -n .claude/hooks/*.sh` | the safety hooks are syntactically valid |
| `gitleaks dir .` | no credential-shaped string is about to be committed |
| `biome check .` | lint + format |
| `tsc --noEmit` ×5 | orchestrator, its tests, the server, the UI, UI tests |
| `vitest run` ×3 | orchestrator, server, UI suites — each with coverage thresholds |
| `vite build` | the UI still builds |
| four design gates | hardcoded values, emoji, token resolution, contrast |
| `pnpm test:e2e` | Playwright, **if** a Chromium is present — otherwise `SKIP` |

Almost every step degrades to a printed `SKIP` rather than a false `OK` when
its tool is missing, so **read the tail of the output, not just the exit
code**. Three exceptions fail instead of skipping, because skipping them
would be the whole gate quietly not running:

- **PyYAML missing** — always a FAIL. Without it the policy and schema half
  of the gate cannot run at all, and a green tail would be a lie about eight
  steps rather than one.
- **pnpm missing, with `CI` set** — a SKIP is a reasonable local answer and
  never a reasonable one on a runner claiming to have gated the branch.
- **gitleaks missing, with `CI` set** — same rule. A secret scan that silently
  did not run is worse than no secret scan, because the badge says otherwise.

Locally, e2e usually says `SKIP`; run it explicitly once you have touched
anything under `ui/`:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Individual suites, when you do not want the full gate:

```bash
pnpm check         # the whole gate — bash scripts/check.sh
pnpm lint          # biome check .
pnpm format        # biome check --write . — the same rules, applied
pnpm typecheck     # tsc --noEmit
pnpm test          # orchestrator vitest
pnpm test:watch    # the same, in watch mode
pnpm test:ui       # UI vitest
pnpm test:server   # server vitest (runs build:server first)
```

`pnpm install` runs `prepare`, which builds the orchestrator — so `smith` is
on `node factory/orchestrator/dist/cli.js` from a fresh clone without a
separate build step.

### What the gate does not cover

Stated here rather than discovered by a contributor whose PR broke something
no step looks at:

- **`.vue` single-file components are not type-checked.** `tsc --noEmit ×5`
  covers every `.ts` file including the UI's, but the `<script setup lang="ts">`
  block inside an SFC needs `vue-tsc`, and `vue-tsc` needs Volar, which needs
  TypeScript's classic Node compiler API. This repo is on TypeScript 7's
  native port, whose JS entry point exposes no such API — `createProgram` and
  `createSourceFile` are both `undefined` — so `vue-tsc` cannot run here at
  all. The UI's logic therefore lives in `ui/src/lib/*.ts`, which *is* checked
  and *is* unit-tested, and SFCs stay as thin as that split allows.
- **SFCs are contract-checked instead**, by `ui/test/vueContract.test.ts` on
  top of `ui/test/sfc.ts`, which runs in the ui suite like any other test.
  It hands each SFC to Vue's own compiler and reads what the compiler had to
  defer: `_ctx.<name>` means the template names something no binding
  provides, `_resolveComponent`/`_resolveDirective` mean nothing registered
  it, and an import mentioned by neither the script body nor the generated
  render code is dead. A second pass walks each template's call sites and
  compares what they pass against what the called SFC declares — the check
  that would have caught eight `<Card size="sm">` where `Card` has no `size`
  (D-258). What it cannot do is types: it knows a prop exists, not that
  the value passed fits it.
- **Biome still does not lint SFC `<script>` blocks.** `noUnusedImports`,
  `noUnusedVariables` and `useVueMultiWordComponentNames` are disabled for
  `**/*.vue` in [`biome.json`](biome.json), because Biome cannot see a
  template using an import and reports every component's props as dead code.
  The unused-import half of that is now covered template-aware by the gate
  above; do not re-enable the Biome rules to chase the rest.
- **`biome.json` cannot carry comments.** It is parsed as strict JSON, and a
  `//` line does not error — it silently invalidates the block it sits in.
  The `overrides` array above was disabled that way for a while, with the
  lint reporting 112 errors and nobody reading the config as the cause. If
  you edit that file, validate it: `python3 -c "import json,sys;
  json.load(open('biome.json'))"`.
- **There is no root `pnpm-workspace.yaml`, on purpose.** This is one package
  with several `tsconfig`s, not a monorepo. An empty workspace file — one
  with no `packages:` key — makes pnpm 9 refuse to install at all
  (`ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION`), so adding one to "tidy up"
  breaks the clone for everyone. Do not add it.

## Where changes go

[`docs/guide/extending.md`](docs/guide/extending.md) is the real guide — it
has a section per change kind. The map:

| You want to | Read |
|---|---|
| Add or change an agent role | `docs/guide/extending.md` § Add an agent template |
| Add a vocabulary value anywhere | § Change the taxonomy — the taxonomy is closed and versioned, and four files mirror it |
| Add or change a policy | § Add a policy |
| Touch docs that mirror code | § Docs-mirror invariants |
| Add an event or a projection | § Event log vs. projections |
| Write tests | § Test conventions |
| Touch the UI | `ui/docs/design-spec.md` (**not** `docs/`), then the four design gates |

### Generated files — do not hand-edit

Committed does not mean hand-editable. These are outputs:

- `factory/policies/lessons.md` — written by `smith lessons compile`.
- `ui/e2e/__screenshots__/**.png` — written by `pnpm test:e2e`. Commit only
  the ones your change actually altered; revert the rest.
- `factory/specs/roadmap.md` milestone rows touched by `smith new` /
  `smith mcp init`.

And these are runtime state, gitignored, never hand-edited, safe to delete:
`state/`, `workspaces/`, `.agents/generated/` ([`AGENTS.md`](AGENTS.md)
"Declarations vs state").

## Tests

TDD is the house style and it is not decorative: write the failing test
first, watch it fail, implement the minimum, watch it pass. Test **behaviour,
not implementation details**. `docs/guide/extending.md § Test conventions`
has the specifics — where each suite lives, what a drift test is, and why
several of them exist.

A change that alters observable behaviour without a test that would have
caught the old behaviour is not finished.

### Coverage

All three suites enforce thresholds, and each is scoped to the code the
suite is actually about rather than to everything it happens to import:

| Suite | Scope | Thresholds |
|---|---|---|
| `pnpm test:coverage` | `factory/orchestrator/src` | 80 / 70 / 80 / 80 |
| `pnpm test:server:coverage` | `ui/server/src/app.ts` | 85 / 60 / 85 / 85 |
| `pnpm test:ui:coverage` | `ui/src/lib` (minus `api.ts`) | 80 / 80 / 80 / 80 |

`scripts/check.sh` runs the coverage variants, so the thresholds are part of
the gate and not a separate thing you can forget. The numbers are floors set
just under where the suites actually sit — they exist to catch a drop, not to
be a target to code toward. `ui/src/lib/api.ts` is excluded because it is
`fetch` wrappers whose only behaviour is the network call the unit suite
mocks; the branch coverage floor on the server is 60 for the same honest
reason, and raising it means testing error paths rather than editing this
table.

## Commits and PRs

From [`AGENTS.md`](AGENTS.md):

- **Language.** Everything in this repo — docs, code, comments, commit
  messages — is English.
- **Commits.** Subject ≤ 72 characters, imperative mood, and **why-focused**:
  say what forced the change, not what the diff already shows.
- **Branches.** Never push to `main`; `main` changes only through a reviewed
  PR. Don't force-push a branch someone else may have pulled — and note that
  an agent session is refused force-push on *every* branch, so a PR branch a
  Claude Code session opened here is append-only.

Good: `fix(registry): close the judge that answered`
Bad: `update registry.ts`

PRs use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).
Two asks that matter more here than in most repos:

1. **Say what you actually ran.** "Gate green" with no output pasted is not
   evidence. If you skipped e2e, say you skipped e2e.
2. **UI changes carry screenshots** — desktop and mobile (390px), light and
   dark, at most four per feature (`docs/standards/stack.md`). If a change
   has no UI surface, say that explicitly instead.

## Severity, if you are reviewing

This repo grades findings S1–S4 and the grades have mechanical
consequences ([`factory/policies/severity.yml`](factory/policies/severity.yml)):
**S1** stops the line, **S2** blocks and bounces the task back, **S3**
batches into a single waiver question at epic end, **S4** is logged only.
Guardrail violations ([`docs/standards/guardrails.md`](docs/standards/guardrails.md))
are S1 unless that document says otherwise.

## Security

Do not open a public issue for a vulnerability — see
[`SECURITY.md`](SECURITY.md).

Never commit a secret. `.env.example` is the only committed env file and it
carries variable **names**, never values. The event logger redacts
credential-shaped strings before write; do not rely on that instead of not
writing them.

## Code of conduct

By participating you agree to [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

Contributions are accepted under the [MIT License](LICENSE) that covers this
repository.
