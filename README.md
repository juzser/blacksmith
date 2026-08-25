# Black Smith

Black Smith is an autonomous agent factory: a planner on a frontier model
turns a goal into spec contracts, template-instantiated workers on cheap
models execute each contract in an isolated git worktree, and deterministic
gates — schema check, tests, fresh-context review, adversarial verify —
decide what merges. The operator's job shrinks to two touchpoints: co-plan
the epic spec, then review outcomes (PRs with screenshots, waiver batches,
lesson candidates). Everything else — decomposition, coding, testing,
review, merging into an integration branch — runs unattended inside
enforced budgets and gates.

This repo is self-governing: its own rules live in [`AGENTS.md`](AGENTS.md),
not in any other repo.

MIT licensed · Node ≥ 22 · TypeScript · runs from a clone, not from npm.

## Quickstart

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
pnpm run build                          # tsc -> factory/orchestrator/dist/
node factory/orchestrator/dist/cli.js --help
```

That gets you the CLI. To run the composite gate this repo holds itself to,
you also need `python3` + PyYAML (see [What it needs](#what-it-needs)):

```bash
bash scripts/check.sh                   # ends in `== PASS ==` on a good install
```

To drive an actual epic you need the **Claude Code CLI** as well — the
planner and every worker run as Claude Code sessions. Full requirements,
per-platform setup, and the known gaps are in
[Installation](#installation); the operator loop is in
[Usage guide](#usage-guide-the-operator-loop).

## How it works

```
epic goal ──► PLANNER (fable/opus) ──► SPEC REVIEW ──► operator sign-off
                                                            │  PLAN v1 (immutable)
                                                            ▼
                                    BACKLOG ──► wave admitted (disjoint claims)
                                                            │
                              researcher/uiux ──► CODER + TESTER (worktree)
                                                            │
                              GRADER (rubric loop, bounded rounds)
                                                            │
              schema check ──► tests ──► REVIEWER ──► VERIFIER (refute)
                     │ pass                    │ fail S1/S2         │ fail S3/S4
                     ▼                         ▼                    ▼
              merge queue (serial,      bounce to coder       waiver batch /
              dependency order)         same branch            log only
                     │
                     ▼
        one integration PR per epic ──► operator reviews on GitHub
```

Each pillar has a deep doc:

- **Spec contracts** — every dispatch carries objective, output schema,
  acceptance criteria, tool allowlist, and budget; no dispatch without one.
  [`docs/specs/black-smith-architecture.md#1-purpose-and-operating-model`](docs/specs/black-smith-architecture.md)
- **Path claims + worktrees** — claims are computed from static analysis,
  not assigned from epic text; disjoint claims run concurrently, overlapping
  ones serialize. [`docs/specs/black-smith-architecture.md#5-worktree-partitioning-no-overlap-no-conflicts`](docs/specs/black-smith-architecture.md)
  · [`factory/policies/worktree.yml`](factory/policies/worktree.yml)
- **Gates + severity** — S1 stops the line, S2 blocks and bounces, S3
  batches into one waiver question at epic end, S4 is logged only.
  [`docs/specs/black-smith-architecture.md#11-review--test-rigor`](docs/specs/black-smith-architecture.md)
  · [`factory/policies/severity.yml`](factory/policies/severity.yml)
- **Event log** — every prompt, dispatch, error, and gate result is an
  append-only event; any component can be reconstructed from the log alone.
  [`docs/specs/black-smith-architecture.md#7-session-management--live-analytics`](docs/specs/black-smith-architecture.md)
- **Lessons** — errors and decision checkpoints become typed, principle-level
  lesson candidates; a novelty gate filters them; the operator approves
  before anything self-modifies. [`docs/specs/black-smith-architecture.md#9-error-log--lessons-loop`](docs/specs/black-smith-architecture.md)
- **Budgets** — per-epic token cap, per-task token/diff caps, a strict
  escalation ladder. Concurrency is uncapped: fan-out is bounded by the
  path-claim graph, cost by the token cap.
  [`factory/policies/budgets.yml`](factory/policies/budgets.yml)

## Status

| Phase | What | Status |
|---|---|---|
| 1. Interview + standards | Operator interview → `docs/standards/stack.md` + per-agent constraint blocks | Built, merged |
| 2. Skeleton + contracts | Repo layout, JSON Schemas, taxonomy, 12 agent templates | Built, merged |
| 3. Loop runner + worktree engine | Plan versions, claims validation, worktree lifecycle, serial merge queue, event log | Built, merged |
| 4. Gates | Schema check, test gate, severity policy, waiver flow (CLI) | Built, merged |
| 5. State + analytics | SQLite projections, `smith db`/`smith stats` | Built, merged |
| 6. UI (HDS) | Overview, timeline, kanban, Roadmap, Flow, Lessons, Errors, Analytics pages | Built, merged |
| 7. Self-extension | Scaffolder, `/bs` operator skill, scheduler, lessons compilation | Built, merged |
| 8. Cross-provider judges | Codex/DeepSeek adapters, quorum policy, shadow-mode calibration | Built, merged — all 4 triggers hosted (see note) |
| 9. Hardening | Escalation ladders, budget alarms, same-mistake KPI, the MCP surface standard, prompt-injection fencing, cross-session event edges | Built, merged |
| 10. Deployment + ops | Runbooks beyond providers, the Cloudflare port of the UI, an always-on dispatch daemon | Planned, unspecced |

> Phase 8 ships both judge transports, the quorum engine and all four
> trigger hosts, but both providers are `enabled: false` in
> [`factory/policies/crosscheck.yml`](factory/policies/crosscheck.yml) —
> nothing calls an external model until an operator opts in
> ([`docs/runbooks/providers.md`](docs/runbooks/providers.md)). Two triggers
> fire automatically from the gate (*blocking S1/S2 finding*,
> *same-mistake finding*); the other two are commands you run —
> `smith epic verdict` before an integration PR and `smith plan quorum` on a
> plan — and nothing invokes them for you. What is and
> isn't real is tracked in
> [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md#limitations-today).

## Installation

Black Smith runs **from a clone**, not as a globally installed package. The
event log (`state/events/`), the SQLite projection (`state/smith.db`), and
every worker worktree (`workspaces/`) live inside the checkout —
`factory/orchestrator/src/paths.ts` resolves all of them relative to the
repo root — so put the clone somewhere you're happy to keep it.

### What it needs

| Requirement | Why | Needed for |
|---|---|---|
| **Node ≥ 22** | `engines` in `package.json`; ESM + `node:` builtins throughout | everything |
| **pnpm 9.3.0** (lockfile v9 — the version local development runs and CI pins) | install and every `pnpm run` script | everything |
| **git ≥ 2.17** | `worktree add` / `remove` / `list --porcelain` *is* the isolation mechanism | running epics |
| **bash** | `scripts/check.sh` and `.claude/hooks/*.sh` | the check gate + guard hook |
| **python3 + PyYAML** | `check.sh` parses the policy YAML and resolves every schema's `x-taxonomy` reference | the check gate |
| **Claude Code CLI** | the planner and every worker run as Claude Code sessions/subagents | running epics |
| Codex CLI *(optional)* | Phase 8 cross-provider judge — `codex exec --json`, ChatGPT-subscription auth, no API key | only if you enable `codex` |
| `DEEPSEEK_API_KEY` in `.env` *(optional)* | Phase 8 API judge | only if you enable `deepseek` |
| Chromium for Playwright *(optional)* | `pnpm test:e2e` | UI e2e only — see the gap below |

**No C/C++ toolchain is required.** The one native dependency,
`better-sqlite3` (13.0.2), declares no `install`/`postinstall` script at
all: it ships prebuilt binaries for `darwin-{arm64,x64}`,
`linux-{arm64,x64}`, `linuxmusl-{arm64,x64}` and `win32-{arm64,x64}` and
picks one at `require` time (verified in
`node_modules/better-sqlite3/prebuilds/` after a clean
`pnpm install --frozen-lockfile` that took 1.6s — nothing compiles).
`@playwright/test` likewise has no postinstall, which is why installing
does not pull down browsers; `playwright install chromium` is an explicit,
separate step.

There is deliberately **no `pnpm-workspace.yaml`**. This is a single-package
repo (the lockfile has one importer, `.`), and pnpm 9 rejects a workspace
file that has no `packages:` key — which is exactly how the first CI run
failed, a week after such a file was committed carrying only build-script
settings. If you switch to pnpm 10+, which blocks dependency build scripts
by default, check `pnpm install`'s output rather than assuming this repo
still needs none.

### macOS (Apple Silicon and Intel)

```bash
brew install node@22 git          # or: nvm install 22
corepack enable                   # bundled with Node 22/24 → provides pnpm
                                  # (or: npm i -g pnpm@9.3.0)

# macOS ships python3 with the Xcode command line tools, but not PyYAML,
# and the system interpreter is PEP 668 "externally managed" — use a venv:
python3 -m venv .venv && .venv/bin/pip install pyyaml
source .venv/bin/activate         # check.sh calls plain `python3`
```

### Linux — glibc (Debian/Ubuntu, Fedora)

```bash
sudo apt install -y git bash python3 python3-yaml     # Debian/Ubuntu
# sudo dnf install git bash python3 python3-pyyaml    # Fedora/RHEL
# Node 22 via nvm or NodeSource, then:
corepack enable
```

### Linux — musl (Alpine)

```bash
apk add --no-cache nodejs npm git bash python3 py3-yaml
corepack enable
```

`bash` is not in a base Alpine image and `check.sh` genuinely needs it
(`BASH_SOURCE`, `set -o pipefail`, heredocs) — `sh` will not do. The musl
`better-sqlite3` prebuilds mean the rest still installs without a compiler.

### Windows

Use **WSL2** and follow the Linux instructions inside it. Native Windows is
not supported today, for three reasons that are in the code rather than in
a support policy:

- `scripts/check.sh` and `.claude/hooks/guard.sh` are bash scripts, and the
  guard hook is wired into Claude Code as
  `$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh` (`.claude/settings.json`) —
  with no bash on `PATH` the safety hook cannot run at all.
- The test gate spawns each check `detached: true` and kills the whole
  **POSIX process group** on timeout (`testgate.ts` `runOne()`, which exists
  precisely because a per-child kill leaked grandchildren). Windows has no
  equivalent, so a timed-out check would leak processes.
- Target-project test commands are run through `spawn(..., { shell: true })`,
  which on native Windows means `cmd.exe`, not the POSIX shell every policy
  and template assumes.

`better-sqlite3` itself is fine on Windows (prebuilt `win32-x64`/
`win32-arm64`) — the blockers are the shell scripts and process-group
handling, not the native module.

### Install and verify

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
bash scripts/check.sh      # policy YAML, JSON Schemas, agent template
                           # frontmatter, guard hooks, lint, typecheck, tests
pnpm run build             # tsc -> factory/orchestrator/dist/
```

`check.sh` ends with `== PASS ==` on a good install. It is the composite
gate: every policy YAML parses, every JSON Schema's `x-taxonomy`
annotations resolve against `taxonomy.yml`, every agent template has valid
frontmatter matching the taxonomy's `agent` dimension, every
`.claude/hooks/*.sh` passes `bash -n`, and — when `pnpm` is on `PATH` —
Biome, `tsc --noEmit`, the Vitest suite, the server/UI typechecks, the UI
build, and the design-system gates (hardcoded values, emoji, contrast,
token resolution). A green run today is **2,122 tests across 71 files** in
the orchestrator suite, plus **32** server and **331** UI tests — and, in a
separate Playwright job, **130** e2e tests across 11 specs.
Every step degrades to a printed `SKIP` rather than a false `OK`
when its tool is missing, so read the tail of the output, not just the exit
code.

`.github/workflows/ci.yml` runs this same script on every pull request and
every push to `main` — the file, not a copy of its command list, so the two
cannot drift. Two differences hold in CI: `PyYAML` is installed (the
policy/schema half needs it), and `CI=true` turns the "pnpm not on `PATH`"
`SKIP` into a failure, because a run that quietly skipped the whole
TypeScript half must not report green. A second job installs Chromium and
runs `pnpm test:e2e`, uploading the screenshots as a build artifact.

### Known platform gaps

Stated rather than papered over, in this repo's usual style:

- **`check.sh` still skips `pnpm test:e2e` locally.** Its guard looks for
  `${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium`, the container
  the UI was built in, and prints `SKIP pnpm test:e2e` when that file is
  absent. Running the specs directly does work now: after
  `pnpm exec playwright install chromium`, `pnpm test:e2e` picks up the
  per-user cache, because `ui/playwright.config.ts` only pins an
  `executablePath` when that path exists (override it with
  `PLAYWRIGHT_CHROMIUM_PATH`). CI takes the second route in its own job.
- **pnpm is not pinned for local development.** There is no
  `packageManager` field, so `corepack enable` gives you whatever pnpm your
  Node bundles. The lockfile is v9 and was written by pnpm 9.3.0, which is
  what CI pins; pnpm 10 blocks `better-sqlite3`'s postinstall unless you
  allow it explicitly.
- **CI is one Linux runner, not a matrix.** `.github/workflows/ci.yml`
  covers `ubuntu-latest` on the `.nvmrc` Node only. Every platform claim
  above still comes from reading the code plus a real install on macOS 26 /
  arm64; Linux is now tested for *this* repo's gate, and WSL2 remains
  reasoned rather than certified.

## First commands

Real `smith` CLI examples (verified end-to-end against a built
`dist/cli.js`; flags match `factory/orchestrator/src/cli.ts` exactly):

```bash
# Validate an immutable plan version against task-spec.schema.json
node factory/orchestrator/dist/cli.js plan validate factory/specs/active/epic-1/plan-v1.json

# Check a proposed wave: claims must be pairwise disjoint and not share a
# serialize-always hotspot (factory/policies/worktree.yml)
node factory/orchestrator/dist/cli.js wave check factory/specs/active/epic-1/plan-v1.json epic-1/task-1 epic-1/task-2

# Ask whether a task's claims fire the security-reviewer's dispatch triggers
# (factory/policies/sensitive-paths.yml); always exits 0, read the JSON
node factory/orchestrator/dist/cli.js security triggers --task factory/specs/active/epic-1/task-1.json

# Create a task's worktree (workspaces/.wt/<project>/<task-id>, branch smith/<epic>/<task-id>)
node factory/orchestrator/dist/cli.js worktree create workspaces/my-project epic-1 task-1

# Bracket a read-only judge: fingerprint before, verify after. Exit 1 means the
# judge moved the tree it was judging -> discard its result (contract.judge-mutation)
node factory/orchestrator/dist/cli.js worktree fingerprint workspaces/.wt/my-project/task-1 > before.json
node factory/orchestrator/dist/cli.js worktree verify workspaces/.wt/my-project/task-1 --before before.json

# Fence fetched/quoted text as data before it enters a prompt (P9-6). Reads a
# file or "-" for stdin; --kind is a closed list (web-fetch, issue-text, diff, ...)
node factory/orchestrator/dist/cli.js prompt wrap fetched.txt \
  --kind web-fetch --source https://example.com/docs/env

# Check a researcher's brief: every claim cited, every recommendation sourced.
# Exit 1 means the brief has violations; recommendation.provenance says whether
# the advice came from the repo, the web, or both
node factory/orchestrator/dist/cli.js research check --brief state/results/epic-1-task-1.json

# Continue one epic in a new session (P9-7): a session-start -- and only a
# session-start -- may name a causal_parent in another session's log. Read the
# chain root-first, or tail the whole epic instead of the newest session
node factory/orchestrator/dist/cli.js event lineage epic-7-session-2
node factory/orchestrator/dist/cli.js event tail epic-7-session-2 --lineage --n 40

# Run the gate pipeline for one task: schema check -> commit check -> tests ->
# findings -> severity decision. --base is the ref the merge queue will merge
# into; without it the gate cannot tell you the branch carries no commits.
node factory/orchestrator/dist/cli.js gate run epic-1/task-1 \
  --worktree workspaces/.wt/my-project/task-1 --base smith/epic-1/integration \
  --checks checks.json --result result.json --findings findings.json \
  --session <session-id> --plan-version 1 --causal-parent <event-id>
```

Once `package.json`'s `bin` entry is linked (`pnpm link` or a global
install), the same commands run as `smith plan validate ...`, `smith wave
check ...`, etc.

## Usage guide (the operator loop)

1. **Plan an epic.** Drive this from a Claude Code session in this repo
   using the `/bs` operator skill
   ([`.claude/skills/bs/SKILL.md`](.claude/skills/bs/SKILL.md), Phase 7):
   `/bs plan <goal>` dispatches the `planner` template
   ([`.claude/agents/planner.md`](.claude/agents/planner.md)) to draft
   an epic spec + task specs, a spec-reviewer hunts deficiencies, you sign
   off.

   | Command | Purpose |
   |---|---|
   | `/bs new <project> [--ui]` | Scaffold a new target project from the stack standard |
   | `/bs plan <goal>` | Draft/re-plan an epic with the planner |
   | `/bs run <epic>` | Admit a wave and drive it through the loop |
   | `/bs status` | Live agent count, budget burn, epic phase |
   | `/bs ui` | Serve the local HDS dashboard |
   | `/bs waivers` | Answer the pending S3/S4 waiver batch for an epic |
   | `/bs lessons` | Review pending lesson candidates |
   | `/bs report` | Render/send the scribe's progress digest |

   The skill's playbooks are dispatch instructions for the orchestrator
   session, not a background daemon — see `docs/guide/operator-guide.md`'s
   "Limitations today".

2. **Spec sign-off.** Once the planner and spec-reviewer converge, the epic
   spec becomes `PLAN v1` — immutable. Nothing executes before you approve
   it (`agent-constraints.md`: planner autonomy is "sign-off per epic, then
   free within budget").
3. **Waves + gates.** The scheduler admits a wave of claim-disjoint,
   dependency-satisfied tasks; each runs coder → tester → grader → gate
   pipeline (schema check, cumulative tests, reviewer, verifier) inside its
   own worktree. Passing tasks enter the serial merge queue into
   `smith/<epic>/integration`.
4. **Answering waiver batches.** S3 findings never block; they queue into
   one batched question per epic ("ignore these?"). Your answer is stored
   by finding fingerprint and never re-asked.
5. **Reviewing the integration PR.** One PR per epic, `smith/<epic>/integration`
   → target repo `main`, with the acceptance-criteria checklist,
   screenshots (desktop + mobile 390px, light + dark, ≤4 per feature — see
   `docs/standards/stack.md`), test results, and waivers granted. You merge
   it; Black Smith never does.
6. **Lessons review.** Approve, edit, or reject candidates — in the UI's
   Lessons page or with `smith lessons approve|reject` — before
   `smith lessons compile` writes them into
   [`factory/policies/lessons.md`](factory/policies/lessons.md), from where
   they are injected step-wise into the matching agent's dispatch. The
   review surface is built; the *cadence* is yours to set, nothing prompts
   you on a schedule.

Full walkthrough with real commands: [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md).

## Safety model (summary)

Distilled from [`docs/standards/guardrails.md`](docs/standards/guardrails.md);
enforced mechanically by [`.claude/hooks/guard.sh`](.claude/hooks/guard.sh) +
GitHub branch protection, not by trust:

- **Secrets are env-only.** `.env`/`.dev.vars`/`wrangler secret`/CI secrets;
  `.env.example` is the only committed env file; the event logger redacts
  credential-shaped values before write.
- **Only the operator merges to `main`.** No agent push, force-push, or
  merge to `main`/`master`; task branches land in
  `smith/<epic>/integration` exclusively through the serial merge queue.
- **No autonomous deploy or outbound sends.** `wrangler deploy`, `pages
  publish`, and any production-affecting command need explicit
  per-invocation approval; HTTP POSTs/Slack/email sends need approval too
  (judges' own provider API calls are the one exception).
- **Budget caps.** 2,000,000 tokens per epic (planner + all workers +
  judges), alarm at 70%; 150,000 tokens / 400 diff lines per coder task.
  Concurrency is uncapped — fan-out is bounded by the path-claim graph, not
  by a worker count. Caps are prompt-level today, not enforced by the loop
  runner ([`factory/policies/budgets.yml`](factory/policies/budgets.yml)).

## Docs index

| Doc | Description |
|---|---|
| [`docs/README.md`](docs/README.md) | Full docs index with audience tags |
| [`docs/specs/black-smith-architecture.md`](docs/specs/black-smith-architecture.md) | The architecture spec (v3, 17 sections) — start here for depth |
| [`docs/specs/black-smith-interview.md`](docs/specs/black-smith-interview.md) | Recorded operator interview → stack + budgets |
| [`docs/specs/agent-interviews.md`](docs/specs/agent-interviews.md) | Per-agent interview → constraint blocks |
| [`docs/standards/stack.md`](docs/standards/stack.md) | The one stack every scaffolded project uses |
| [`docs/standards/agent-constraints.md`](docs/standards/agent-constraints.md) | Per-agent constraint blocks (source of truth until templates fully bake them in) |
| [`docs/standards/guardrails.md`](docs/standards/guardrails.md) | Hard rules the factory enforces mechanically |
| [`docs/standards/mcp.md`](docs/standards/mcp.md) | The MCP surface every shipped project must declare (rule ids MCP-P1, MCP-T4, …) |
| [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) | Deep operator walkthrough with real commands |
| [`docs/guide/extending.md`](docs/guide/extending.md) | Contributor guide: templates, taxonomy, policies, tests |
| [`docs/runbooks/providers.md`](docs/runbooks/providers.md) | Enabling the Phase 8 cross-provider judges: auth, shadow-mode calibration, promotion, rollback |
| [`AGENTS.md`](AGENTS.md) | This repo's own thin router (progressive disclosure) |

`docs/specs/` also carries the dogfooding record — the defect logs and punch
lists from running Black Smith on Black Smith
(`dogfood-4-findings.md`, `dogfood-envkit-findings.md`,
`phase-9-punch-list.md`). They are large, internal, and kept deliberately:
most of what the gates and policies do exists because one of those entries
forced it.

## Contributing

- **How to contribute:** [`CONTRIBUTING.md`](CONTRIBUTING.md) — the gate you
  must run, commit and PR conventions, and where each kind of change goes.
- **Behaviour:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- **Vulnerabilities:** [`SECURITY.md`](SECURITY.md) — report privately, not
  in a public issue.
- **What changed:** [`CHANGELOG.md`](CHANGELOG.md).

Two things are worth knowing before you open a PR. First, the gate is
`bash scripts/check.sh` and it is the same script CI runs — if it is red
locally it will be red there. Second, several artifacts in this repo are
*generated* (`factory/policies/lessons.md`, `ui/e2e/__screenshots__/`,
`state/`); [`docs/guide/extending.md`](docs/guide/extending.md) says which
are hand-editable and which are not.

## License

[MIT](LICENSE) — see [`LICENSE`](LICENSE) for the full text.
