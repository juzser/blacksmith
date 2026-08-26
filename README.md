<div align="center">

<img src="ui/src/assets/brand/black-smith.png" alt="Black Smith" width="170" />

# Black Smith

**An autonomous agent factory.**

You co-plan the spec. It decomposes, codes, tests, reviews, refutes itself —<br />
and hands you exactly one pull request.

[![CI](https://github.com/juzser/blacksmith/actions/workflows/ci.yml/badge.svg)](https://github.com/juzser/blacksmith/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-1f1f1f)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-1f1f1f)
![TypeScript](https://img.shields.io/badge/TypeScript-1f1f1f)

</div>

---

**One goal in. One integration PR out.**

A planner on a frontier model turns your goal into **spec contracts** —
objective, output schema, acceptance criteria, tool allowlist, budget. Nothing
is ever dispatched without one. Template-instantiated workers on cheap models
then execute each contract inside its own git worktree, so work with disjoint
path claims runs in parallel and physically cannot collide.

What merges is not decided by an agent's confidence. It is decided by gates:
schema check → tests → a fresh-context reviewer that never sees the coder's
session → an adversarial verifier whose only job is to refute the reviewer.
S1 stops the line, S2 bounces back to the coder, S3 queues into a single
batched question at the end of the epic.

Your job shrinks to two touchpoints: **co-plan the epic spec**, then **review
outcomes** — the integration PR with screenshots, the waiver batch, the lesson
candidates the factory distilled from its own errors. Decomposition, coding,
testing, review, merging into the integration branch: unattended, inside
declared budgets and enforced gates.

**No agent pushes to `main`.** You merge, or nothing merges.

This repo is self-governing and dogfooded — Black Smith is run on Black Smith,
and its own rules live in [`AGENTS.md`](AGENTS.md), not in any other repo.

MIT licensed · Node ≥ 22 · TypeScript · runs from a clone, not from npm.

<div align="center">

<img src="ui/e2e/__screenshots__/phase-6b/overview-desktop-dark.png" width="900" alt="Black Smith Overview page: a 'Needs you' banner reading '1 waiver pending, 1 task escalated', counters for active agents, budget used, epics in flight and alerts, and a 'Now running' list of two live sessions" />

<sub>The one screen that asks something of you. The rest is the factory reporting in.</sub>

</div>

## Quickstart

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
pnpm run build                          # tsc -> factory/orchestrator/dist/
node factory/orchestrator/dist/cli.js --help
```

That gets you the CLI. To run the composite gate this repo holds itself to,
you also need `python3` + PyYAML:

```bash
bash scripts/check.sh                   # ends in `== PASS ==` on a good install
```

To drive an actual epic you need the **Claude Code CLI** as well — the planner
and every worker run as Claude Code sessions.

Rather not do this by hand? Open a Claude Code session in the clone and say
*"install Black Smith"* — it walks [`INSTALL.md`](INSTALL.md) with you, asking
before it touches anything outside the clone. That file also carries the full
requirements, per-platform setup, troubleshooting and the known gaps; the
operator loop is in [Usage guide](#usage-guide-the-operator-loop).

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

## The dashboard

The factory writes an append-only event log, and the dashboard is a projection
of it — `smith db rebuild` reconstructs the whole thing from the log alone. It
is read-only on purpose: nothing you click here dispatches an agent.

```bash
pnpm build:server && pnpm build:ui   # ui/server/dist + ui/dist
smith ui serve                       # http://127.0.0.1:4680
```

From a Claude Code session, `/bs ui` does the same and prints the URL.

<table>
<tr>
<td width="50%"><img src="ui/e2e/__screenshots__/phase-6b/flow-desktop-dark.png" width="100%" alt="Flow page: task cards arranged in three columns labelled Wave 0 (6 tasks), Wave 1 (2 tasks) and Wave 2 (1 task), joined by dashed dependency edges" /></td>
<td width="50%"><img src="ui/e2e/__screenshots__/phase-6b/kanban-desktop-dark.png" width="100%" alt="Kanban board with Todo, In progress, Reviewing and Blocked columns; cards carry severity chips such as S2-major and agent chips such as coder - mid" /></td>
</tr>
<tr valign="top">
<td><b>Flow</b> — the plan as waves. Waves are layers of the dependency graph; a
wave is only admitted once its tasks' path claims are pairwise disjoint, which
is what lets everything in a column run at the same time.</td>
<td><b>Kanban</b> — where every task sits, what severity it carries, and which
model tier drew it. <code>Blocked</code> and <code>Reviewing</code> are the two
columns that can end up waiting on you.</td>
</tr>
<tr>
<td><img src="ui/e2e/__screenshots__/phase-6b/task-detail-desktop-dark.png" width="100%" alt="Task detail page for epic-9/task-3 showing a Spec contract card with case, origin, epic, plan version and claims, and an Attempts list naming each agent, provider and outcome" /></td>
<td><img src="ui/e2e/__screenshots__/phase-6b/analytics-desktop-dark.png" width="100%" alt="Analytics page with throughput, cost-per-task, same-mistake-rate and recheck-pass-rate cards, bar charts of cost by model tier and by provider, and a cross-check quorum panel" /></td>
</tr>
<tr valign="top">
<td><b>Task detail</b> — the contract a worker was actually handed: its case,
its plan version, and the exact paths it was allowed to touch. Under it, every
attempt, with the provider that ran it and how it ended.</td>
<td><b>Analytics</b> — cost per task by tier and by provider, plus the
same-mistake rate: the number that says whether the lessons loop is teaching it
anything.</td>
</tr>
</table>

Those are the committed e2e fixtures under
[`ui/e2e/__screenshots__/`](ui/e2e/__screenshots__), rendered and diffed by
`pnpm test:e2e` on every gate run. The data in them is synthetic; the pixels are
not a mockup.

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

Two ways in, both ending in the same place.

**Let Black Smith install itself.** Clone the repo, open a Claude Code session
inside it, and say *"install Black Smith"*. The session picks up
[`CLAUDE.md`](CLAUDE.md), works through the runbook in
[`INSTALL.md`](INSTALL.md) step by step, and stops to ask you before anything
touches your machine outside the clone.

**Or run it yourself.** [`INSTALL.md`](INSTALL.md) is that same runbook,
written to be read by a person too: per-platform prerequisites (macOS,
Debian/Ubuntu, Fedora, Alpine, WSL2), the optional extras, a troubleshooting
table, and the known platform gaps stated rather than papered over.

Five things worth knowing before you start:

- **It runs from a clone, not from npm.** The event log (`state/events/`), the
  SQLite projection (`state/smith.db`) and every worker worktree
  (`workspaces/`) live inside the checkout — `factory/orchestrator/src/paths.ts`
  resolves all of them relative to the repo root — so put the clone somewhere
  you're happy to keep it.
- **Nothing compiles.** The one native dependency, `better-sqlite3`, declares
  no install script and ships prebuilds for macOS, Linux (glibc + musl) and
  Windows. No C/C++ toolchain required.
- **`bash scripts/check.sh` is the real proof of a good install.** It is the
  same script CI runs, and it degrades to a printed `SKIP` rather than a false
  `OK` when a tool is missing — so read the tail of the output, not just the
  exit code.
- **To drive an actual epic you also need the Claude Code CLI** — the planner
  and every worker run as Claude Code sessions. The CLI and the gate work
  without it; you just can't dispatch the agents that do the work.
- **On Windows, use WSL2.** Native Windows is blocked by the bash safety hooks
  and by POSIX process-group handling in the test gate, not by the native
  module — the three specific reasons are in [`INSTALL.md`](INSTALL.md).

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

Day to day you do two things: **agree on the spec**, then **review what came
back**. Everything in between is the factory's job. Here is the whole loop, in
the order you actually meet it.

It all happens in a Claude Code session opened in this repo, where the `/bs`
skill ([`.claude/skills/bs/SKILL.md`](.claude/skills/bs/SKILL.md)) is your
console:

| Command | What it does |
|---|---|
| `/bs new <project> [--ui]` | Scaffold a new target project from the stack standard |
| `/bs plan <goal>` | Draft or re-plan an epic with the planner |
| `/bs run <epic>` | Admit a wave and drive it through the loop |
| `/bs status` | Live agent count, budget burn, epic phase |
| `/bs ui` | Serve the local HDS dashboard |
| `/bs waivers` | Answer the pending S3/S4 waiver batch for an epic |
| `/bs lessons` | Review pending lesson candidates |
| `/bs report` | Render or send the scribe's progress digest |

One thing to know up front: those playbooks are dispatch instructions for your
orchestrator session, **not a background daemon**. Nothing advances while the
session is closed — see the operator guide's "Limitations today".

### 1. Say what you want — `/bs plan <goal>`

Describe the goal in plain language. The planner
([`.claude/agents/planner.md`](.claude/agents/planner.md)) turns it into an
epic spec plus task specs, and a spec-reviewer goes hunting for holes in it
before you ever look. You get something concrete to react to instead of a
blank page.

### 2. Sign off — and the spec freezes

When the planner and spec-reviewer converge, you approve. That approval turns
the spec into **PLAN v1, immutable**. Nothing executes before it
(`agent-constraints.md`: planner autonomy is "sign-off per epic, then free
within budget"). This is the most leveraged minute in the loop — the spec is
what every worker is held to for the rest of the epic.

### 3. Let it run — `/bs run <epic>`

You are out of the per-step loop from here (keep the session open, though —
there is no daemon). The scheduler admits a **wave**: tasks whose path claims
are disjoint and whose dependencies are satisfied. Each gets its own worktree
and runs coder → tester → grader → the gate pipeline (schema check, cumulative
tests, reviewer, verifier). Whatever passes joins the serial merge queue into
`smith/<epic>/integration`.

Want to look in? `/bs status` gives you live agent count, budget burn and epic
phase; `/bs ui` serves the dashboard if you would rather watch it.

### 4. Answer one batch of questions — `/bs waivers`

S3 findings never block the line. They pile up into a **single batched
question per epic** — "ignore these?" — that you answer once. Your answer is
stored by finding fingerprint, so the same nit is never put to you twice.

### 5. Review the PR — the one thing you must read

One PR per epic, `smith/<epic>/integration` → your target repo's `main`. It
arrives with the acceptance-criteria checklist, screenshots (desktop + mobile
390px, light + dark, ≤4 per feature — `docs/standards/stack.md`), test results
and any waivers granted. **You merge it. Black Smith never does.**

### 6. Teach it — `/bs lessons`

Errors and decision checkpoints become lesson candidates. Approve, edit or
reject them — in the UI's Lessons page or with `smith lessons approve|reject`
— then `smith lessons compile` writes the approved ones into
[`factory/policies/lessons.md`](factory/policies/lessons.md), from where they
are injected into the matching agent's next dispatch. That is the loop that
closes: a mistake made once becomes a constraint the next worker is handed.

The review surface is built; the *cadence* is yours to set — nothing prompts
you on a schedule.

---

**Want the same walkthrough with real commands and real output?**
[`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) goes deep: gate
outcomes, severity and waiver semantics, the budget escalation ladder, lesson
approval, and an honest "what is and isn't real today".

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
| [`INSTALL.md`](INSTALL.md) | Install runbook — requirements, per-platform setup, verification, troubleshooting, known gaps |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code entry point — routes to `AGENTS.md` and the self-install runbook |
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
