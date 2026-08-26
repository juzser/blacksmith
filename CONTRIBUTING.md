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
| `biome check .` | lint + format |
| `tsc --noEmit` ×4 | orchestrator, its tests, the server, the UI and UI tests |
| `vitest run` ×3 | orchestrator, server, UI suites |
| `vite build` | the UI still builds |
| four design gates | hardcoded values, emoji, token resolution, contrast |
| `pnpm test:e2e` | Playwright, **if** a Chromium is present — otherwise `SKIP` |

Every step degrades to a printed `SKIP` rather than a false `OK` when its
tool is missing, so **read the tail of the output, not just the exit code**.
Locally, e2e usually says `SKIP`; run it explicitly once you have touched
anything under `ui/`:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Individual suites, when you do not want the full gate:

```bash
pnpm lint          # biome check .
pnpm typecheck     # tsc --noEmit
pnpm test          # orchestrator vitest
pnpm test:ui       # UI vitest
pnpm test:server   # server vitest (runs build:server first)
```

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

## Commits and PRs

From [`AGENTS.md`](AGENTS.md):

- **Language.** Everything in this repo — docs, code, comments, commit
  messages — is English.
- **Commits.** Subject ≤ 72 characters, imperative mood, and **why-focused**:
  say what forced the change, not what the diff already shows.
- **Branches.** Never push to `main`; `main` changes only through a reviewed
  PR. Never force-push a branch someone else may have pulled.

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
