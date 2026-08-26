<div align="center">

<img src="ui/src/assets/brand/black-smith.png" alt="Blacksmith" width="170" />

# Blacksmith

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

You describe a goal. A planner on a frontier model turns it into spec
contracts. Cheap, fast workers execute each contract in its own git worktree.
Gates — not an agent's confidence — decide what merges. At the end you get a
single pull request to review, and **you** merge it.

Your job shrinks to two touchpoints: **agree on the spec**, then **review what
came back**. Everything in between runs unattended inside declared budgets.

<div align="center">

<img src="ui/e2e/__screenshots__/phase-6b/overview-desktop-dark.png" width="900" alt="Blacksmith Overview page: a 'Needs you' banner reading '1 waiver pending, 1 task escalated', counters for active agents, budget used, epics in flight and alerts, and a 'Now running' list of two live sessions" />

<sub>The one screen that asks something of you. The rest is the factory reporting in.</sub>

</div>

## What makes it different

- **Nothing is dispatched without a contract.** Every task carries an
  objective, an output schema, acceptance criteria, a tool allowlist and a
  budget. No contract, no dispatch.
- **Workers physically cannot collide.** Path claims are computed by static
  analysis, not assigned from epic prose. Disjoint claims run in parallel in
  separate worktrees; overlapping ones serialize. An out-of-claim edit fails
  the gate.
- **Merging is decided by gates, not by confidence.** Schema check → tests →
  a fresh-context reviewer that never sees the coder's session → an
  adversarial verifier whose only job is to refute the reviewer. S1 stops the
  line, S2 bounces to the coder, S3 batches into one question at the end.
- **No agent pushes to `main`.** Enforced by hooks and branch protection, not
  by trust. You merge, or nothing merges.

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

To drive an actual epic you also need the **Claude Code CLI** — the planner
and every worker run as Claude Code sessions.

**Rather not do this by hand?** Open a Claude Code session in the clone and
say *"install Blacksmith"*. It walks [`INSTALL.md`](INSTALL.md) with you and
asks before touching anything outside the clone. That file is also the
human-readable version: per-platform setup (macOS, Debian/Ubuntu, Fedora,
Alpine, WSL2), troubleshooting, and the known gaps stated rather than papered
over.

Three things worth knowing before you start:

- **It runs from a clone, not from npm.** The event log, the SQLite
  projection and every worker worktree live inside the checkout, so put the
  clone somewhere you're happy to keep it.
- **Nothing compiles.** The one native dependency ships prebuilds for macOS,
  Linux (glibc + musl) and Windows. No C/C++ toolchain required.
- **On Windows, use WSL2.** The three specific reasons are in
  [`INSTALL.md`](INSTALL.md).

## How it works

```
epic goal ──► PLANNER (frontier) ──► SPEC REVIEW ──► operator sign-off
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

Every prompt, dispatch, error and gate result is an append-only event. The
dashboard is a projection of that log — `smith db rebuild` reconstructs the
whole thing from the log alone.

The full design is [`docs/specs/black-smith-architecture.md`](docs/specs/black-smith-architecture.md).

## Using it

Day to day, from a Claude Code session opened in this repo:

| Command | What it does |
|---|---|
| `/bs new <project> [--ui]` | Scaffold a new target project |
| `/bs plan <goal>` | Draft or re-plan an epic with the planner |
| `/bs run <epic>` | Admit a wave and drive it through the loop |
| `/bs status` | Live agent count, budget burn, epic phase |
| `/bs ui` | Serve the local dashboard |
| `/bs waivers` | Answer the pending waiver batch |
| `/bs lessons` | Review pending lesson candidates |
| `/bs report` | Render the progress digest |

Underneath, everything is a `smith` command you can run yourself —
`smith --help` lists all of them.

→ **[The operator loop](docs/guide/operator-loop.md)** — the six steps, in the
order you meet them.<br />
→ **[The dashboard](docs/guide/dashboard.md)** — what the eleven pages show
you.<br />
→ **[Operator guide](docs/guide/operator-guide.md)** — the same ground with
real commands and real output.

## Safety model

Enforced mechanically by [`.claude/hooks/guard.sh`](.claude/hooks/guard.sh) +
branch protection, not by trust. Full rules in
[`docs/standards/guardrails.md`](docs/standards/guardrails.md).

- **Secrets are env-only.** `.env.example` is the only committed env file; the
  event logger redacts credential-shaped values before write.
- **Only the operator merges to `main`.** No agent push, force-push, or merge
  to `main`; task branches land in `smith/<epic>/integration` exclusively
  through the serial merge queue.
- **No autonomous deploy or outbound sends.** Deploys, publishes, HTTP POSTs
  and message sends all need per-invocation approval.
- **Budget caps.** 2M tokens per epic, 150K tokens / 400 diff lines per coder
  task, with a strict escalation ladder. Concurrency is uncapped — fan-out is
  bounded by the path-claim graph, cost by the token cap.

## Cross-provider judges

The factory grades its own judgment calls with a second opinion from a
different vendor's model — Codex over its CLI, DeepSeek over its API,
alongside the native Claude judge. They ship `enabled: true` but
`mode: shadow`: every verdict is recorded, none of them gates anything, until
you have read the numbers (`smith stats providers`) and promoted one
deliberately.

Setup, the calibration loop, promotion, rollback, cost and security notes:
**[`docs/runbooks/providers.md`](docs/runbooks/providers.md)**.

## Status

Phases 1–9 are built and merged: the loop runner, worktree engine, gates,
state and analytics, dashboard, self-extension, cross-provider judges and
hardening. Phase 10 — an always-on dispatch daemon and a hosted UI — is
planned, unspecced.

The one thing to know up front: **there is no daemon yet.** `/bs run` is a
playbook your Claude Code session follows; close the session and nothing
advances.

→ **[What is built, what is not](docs/guide/status.md)**, and the unflinching
version in [Limitations today](docs/guide/operator-guide.md#limitations-today).

## Docs

| Doc | For |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Getting it running, per platform |
| [`docs/guide/operator-loop.md`](docs/guide/operator-loop.md) | The six steps you actually do |
| [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) | Every command, end to end, with output |
| [`docs/guide/dashboard.md`](docs/guide/dashboard.md) | The dashboard tour |
| [`docs/guide/status.md`](docs/guide/status.md) | What is real today |
| [`docs/guide/extending.md`](docs/guide/extending.md) | Adding agents, policies, taxonomy values |
| [`docs/specs/black-smith-architecture.md`](docs/specs/black-smith-architecture.md) | Why it is shaped this way |
| [`docs/runbooks/providers.md`](docs/runbooks/providers.md) | The cross-provider judges |
| [`docs/README.md`](docs/README.md) | Everything else, one line each |

Agents read [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) instead —
this repo is self-governing, and its rules live there.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the details. Two things up front:
the gate is `bash scripts/check.sh` and it is the same script CI runs, so red
locally is red there; and several artifacts here are *generated* — see
[`docs/guide/extending.md`](docs/guide/extending.md) for which files you may
hand-edit.

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`SECURITY.md`](SECURITY.md) (report privately, not in a public issue) ·
[`CHANGELOG.md`](CHANGELOG.md)

## License

[MIT](LICENSE)
