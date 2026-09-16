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

**[Features](#features) · [Install](#install) · [Using it](#using-it) ·
[How it works](#how-it-works) · [Safety](#safety) ·
[Dashboard](#the-dashboard) · [Status](#status) · [Docs](#docs)**

<pre>
goal → contracts you sign → one worktree per contract, run in parallel
     → schema · tests · reviewer · verifier → one pull request you merge
</pre>

<sub>Two touchpoints. Everything between them runs unattended.</sub>

</div>

## Why Blacksmith

Handing a whole feature to an agent tends to fail in the same place, and it is
rarely the code. Two workers edit the same file. One quietly renegotiates the
goal it was given. A third reports itself done, and you find out in review. The
usual remedy is to watch it work — which costs exactly what the automation was
supposed to buy.

Blacksmith removes the watching instead. A goal becomes a set of immutable spec
contracts. Each contract runs in its own git worktree, under a token budget,
over paths no other worker is allowed to touch. What merges is decided by gates
— a schema check, tests, a reviewer that never saw the coder's session, and a
verifier whose only job is to refute the reviewer.

Your job shrinks to two touchpoints: **agree on the spec**, then **review one
pull request**. Everything in between runs unattended.

## Features

<table>
<tr valign="top">
<td width="50%">

**Nothing is dispatched without a contract**

Every task carries an objective, an output schema, acceptance criteria, a tool
allowlist, the exact paths it may touch and a token budget. The plan is frozen
the moment you sign it and versioned in the event log, so a worker cannot
quietly reinterpret the job. No contract, no dispatch.

</td>
<td width="50%">

**Workers that cannot collide**

Path claims come from static analysis, not from epic prose. A wave is admitted
only once its tasks' claims are pairwise disjoint, which is what lets a whole
column run at the same time in separate worktrees; overlapping work serializes
instead. An edit outside a claim fails the gate rather than reaching the queue.

</td>
</tr>

<tr valign="top">
<td>

**Gates decide what merges, not confidence**

Schema check → tests → coverage evidence → a fresh-context reviewer that never
sees the coder's session → an adversarial verifier whose only job is to refute
the reviewer. S1 stops the line, S2 bounces back to the same branch, S3 batches
into one waiver question per epic. Only S3 and S4 are ever waivable.

</td>
<td>

**A second opinion from another vendor**

The factory grades its own judgment calls against models from a different
vendor — Codex over its CLI, DeepSeek over its API, beside the native Claude
judge. Both external judges ship `enabled: auto`: they join the quorum on a
machine that holds the credentials and are skipped on one that does not, so
which of them you get is a fact about your machine, not about this repo. A
judge earns its vote in **shadow mode** first — every verdict recorded, none
of them gating anything — and is promoted only once you have read the numbers.

</td>
</tr>

<tr valign="top">
<td>

**It learns from its own errors**

Errors are classified against a taxonomy, and a scribe distills them into
lesson candidates you approve or reject. Approved lessons splice into later
prompts — and the same-mistake rate tells you whether that is actually
working. A loop you can audit, not a memory you have to trust.

</td>
<td>

**A frontier planner, cheap workers**

Planning and judgment go to a frontier model; the bulk of the work goes to
small, fast tiers, many at once. Every session and every live agent is visible
with the tier that drew it, and cost breaks down per task, per tier and per
provider.

</td>
</tr>

<tr valign="top">
<td colspan="2">

**The log is the source of truth**

Every prompt, dispatch, gate result and error is an append-only event on disk.
The dashboard is a projection of that log, and `smith db rebuild` reconstructs
the entire database from the log alone. Nothing the factory did exists only in
a chat transcript.

</td>
</tr>
</table>

**Also in the box**

- **Project scaffolding.** `/bs new <project>` generates a target project from
  the stack you answered for at install time; `/bs mcp` layers an MCP surface
  onto it.
- **An audit that ends in an epic.** `/bs audit <project-dir>` reads a project
  that already exists on four axes, ranks what it finds, and cuts one epic from
  what you accept.
- **A factory that extends itself.** New agent roles, policies and taxonomy
  values are data files, not code — see
  [extending](docs/guide/extending.md).
- **One integration branch per epic**, one pull request at the end, merged by
  you.
- **A local dashboard**, eleven read-only pages over the same event log —
  optional, and [further down](#the-dashboard).

## Install

Two ways in, and they are **not** equivalent. A clone is what drives an epic.
The package is the `smith` CLI on a machine that has no clone.

### A clone — the whole factory

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
pnpm run build                          # tsc -> factory/orchestrator/dist/
node factory/orchestrator/dist/cli.js --help
```

Verify it with the same gate CI runs (this one also needs `python3` + PyYAML):

```bash
bash scripts/check.sh                   # ends in `== PASS ==` on a good install
```

Driving a real epic additionally needs the **Claude Code CLI** — the planner and
every worker run as Claude Code sessions. Open one **in the clone** and you have
`/bs`; that is the operator surface everything under [Using it](#using-it)
assumes.

**Rather not do this by hand?** Open a Claude Code session in the clone and say
*"install Blacksmith"*. [`INSTALL.md`](INSTALL.md) is an executable runbook: it
asks before touching anything outside the clone, and it doubles as the human
version — per-platform setup (macOS, Debian/Ubuntu, Fedora, Alpine, WSL2),
troubleshooting, and the known platform gaps stated rather than papered over.

### The package — `smith` inside a project you already have

The CLI is published as
[`@juzser/blacksmith`](https://www.npmjs.com/package/@juzser/blacksmith):

```bash
cd /path/to/your-project
npx @juzser/blacksmith init            # creates .blacksmith/ beside your code
npx @juzser/blacksmith --help          # or: npm i -g @juzser/blacksmith && smith --help
```

The tarball is the `smith` binary plus everything it reads at runtime — the
policies, the JSON Schemas, the scaffold templates, the roadmap default, the
agent role files, the database migrations. Installed, `smith` writes beside
**you**, not beside itself: state, epic plans and your `.env` go under
`.blacksmith/` in the directory you run it from, and `smith new` scaffolds
there too. `SMITH_HOME` overrides that root if you want one home for several
projects. (In a clone it still writes into the clone, as it always has — the
layout under the root is identical either way, which is what makes the two
installs one codebase.)

**What a package install does not give you is `/bs`.** `/bs` is not a CLI
command; it is a Claude Code **skill** — `.claude/skills/bs/`, a router and ten
playbooks that a session reads and follows. The playbooks ship in the tarball,
but they land under `node_modules/@juzser/blacksmith/`, which is not a place
Claude Code looks for skills or agent definitions. So a package gives you the
`smith` verbs and not the loop that drives them: validate plans, run the gates,
append events, read stats — yes; `/bs plan` and `/bs run` — from a clone.
Closing that gap is its own milestone, scoped and not yet cut:
[`docs/specs/plugin-port-scope.md`](docs/specs/plugin-port-scope.md).

> **The registry is one version behind.** The published version is
> `0.1.0`, and it predates all of the above: no `smith init`, no shipped
> roadmap for `smith new` to read, and it keeps state inside its own install
> directory, which the next `npm i` replaces. This section describes `0.1.1`,
> which is in this repo and not on npm yet. Until it is, take the clone.

## Using it

### Starting a new project

Blacksmith never builds inside itself. It builds a **separate project**, in
its own directory, with its own git history — and what comes out is not a
Blacksmith dependency. No config pointing back here, no docs about the
factory; one `Built by Blacksmith` line in its README is the whole trace.

Open a Claude Code session in this clone and say **`/bs new my-app`**. If you
would rather drive it yourself, it is three commands:

```bash
$EDITOR factory/policies/stack.yml   # your stack answers: language, frontend,
                                     # database, deploy target. `none` is fine.
smith stack check                    # which answers the templates honour,
                                     # which they only record, which they refuse
smith new my-app --target-dir ~/code/my-app     # add --ui for a frontend
```

The last call scaffolds (TS strict, Biome, Vitest, CI), installs, runs the
project's own gates, commits it on a `setup` branch, and registers a bootstrap
milestone. Read `toolchain` in the JSON it prints: `verified` means you may
plan against it. An answer the templates cannot build stops it **before
anything is created** rather than handing you something else.

Creating the remote and the first push are printed, not run — that is an
operator action, and no agent session here will do it for you:

```bash
gh repo create my-app --private --source ~/code/my-app
git -C ~/code/my-app push -u origin setup
```

Then `/bs plan <goal>` against it, and you are in the loop below. The MCP
surface comes later, at its own milestone (`/bs mcp my-app`), once there are
tools worth declaring.

→ **[Step 0 of the operator loop](docs/guide/operator-loop.md)** has the same
ground with the failure modes spelled out.

### Auditing an existing project

The other way in. A project that already exists — built here or not — is
audited, not scaffolded: say **`/bs audit <project-dir>`** and four judges read
it at `HEAD` on four fixed axes — performance, code quality, architecture,
security — from a detached, read-only worktree the command cuts and verifies
against its opening fingerprint before it removes it. The project's working
tree is never touched; the one thing the audit leaves behind is
`<project-dir>/.blacksmith/`, state rather than source, where the findings
accumulate across runs, so a second audit does not re-ask what the first one
settled — though a finding that comes back after its fix does, as a regression.

The returns are folded into one ranked list and **the command stops**. You
accept or decline each finding — a decline is remembered for 90 days — and
the accepted ones become one roadmap milestone and one epic spec. From there
it is the ordinary loop: `/bs plan` against that epic, then `/bs run`, and
closing the epic marks its findings fixed. There is no audit-specific run
path; the command's value is the insight and the ranking.

Underneath it is the `smith audit` family — `open`, `record`, `consolidate`,
`decide`, `cut`, `resolve`, `close` — and
[`docs/specs/audit-command-scope.md`](docs/specs/audit-command-scope.md) is the
contract each of them keeps.

### The loop

Day to day, from a Claude Code session opened in this repo:

| Command | What it does |
|---|---|
| `/bs new <project> [--ui]` | Scaffold a new target project from your stack answers |
| `/bs mcp <project>` | Layer the MCP surface on and make its milestone due |
| `/bs audit <project-dir>` | Audit an existing project on four axes, rank, decide at a hard stop, cut one epic |
| `/bs plan <goal>` | Draft or re-plan an epic with the planner + spec-reviewer |
| `/bs run <epic>` | Admit a wave and drive it through the loop to merge |
| `/bs status` | Live agent count, budget burn, epic phase |
| `/bs ui` | Serve the local dashboard |
| `/bs waivers` | Answer the pending S3/S4 waiver batch for an epic |
| `/bs lessons` | Review pending lesson candidates |
| `/bs report` | Render the scribe's progress digest |

Each of those is a playbook, not a script: the deterministic half is a `smith`
command you can run yourself — `smith --help` lists all of them — and the
judgment half is a Claude Code session the playbook dispatches. That is also
the line between the two installs: the `smith` half travels in the package, the
playbooks are read from a clone.

→ **[The operator loop](docs/guide/operator-loop.md)** — the six steps, in the
order you meet them.<br />
→ **[Operator guide](docs/guide/operator-guide.md)** — the same ground with real
commands and real output.

## How it works

You describe a goal. A planner on a frontier model turns it into spec contracts
and a spec-reviewer hunts holes in them *before* you sign; signing freezes plan
v1. From there the loop admits a wave whose path claims do not overlap, sends
researcher and UI/UX work ahead of code where the epic needs it, runs a coder
and a tester in a worktree, grades the result against its own acceptance
criteria, then puts it through the gates and a serial merge queue into
`smith/<epic>/integration`. One epic, one integration PR, merged by you.

→ The pipeline diagram and the reasoning behind each stage:
**[architecture §3 — The loop](docs/specs/black-smith-architecture.md#3-the-loop)**.

## Safety

Enforced mechanically — a `PreToolUse` policy layer on every command an agent
runs, plus branch protection — not by trust. Full rules:
**[`docs/standards/guardrails.md`](docs/standards/guardrails.md)**.

- **Secrets are environment-only.** `.env.example` is the only committed env
  file (variable names, never values), and the event logger redacts
  credential-shaped strings before write.
- **Only you merge to `main`.** No agent may push or merge to a protected
  branch, and force-push is refused on every branch, protected or not — an
  agent's pushed branch is append-only. Task branches reach the integration
  branch solely through the serial merge queue.
- **No autonomous deploy or outbound sends.** Deploys, publishes and message
  sends each need per-invocation approval.
- **Budgets are declared per role.** 4M tokens per epic with an alarm at 70%;
  150K tokens and 400 diff lines per coder task. Fan-out is bounded by the
  claim graph, and `max_in_flight_tasks` is available on top of it, off by
  default. Which of these *block* versus *report* is spelled out in
  [`factory/policies/budgets.yml`](factory/policies/budgets.yml) — the task cap
  reports on purpose.

Found a vulnerability? [`SECURITY.md`](SECURITY.md) — report privately, not in
a public issue.

## The dashboard

Optional, and deliberately small: `/bs ui` (or `smith ui serve`) binds eleven
read-only pages to `127.0.0.1`. They are a projection of the event log and
nothing else — `smith db rebuild` reconstructs them from it, `smith stats`
prints the same facts in a terminal, and nothing you click there dispatches an
agent. The factory runs without ever opening it.

<table>
<tr valign="top">
<td width="50%"><img src="ui/e2e/__screenshots__/phase-6b/overview-desktop-dark.png" width="100%" alt="Blacksmith Overview page: a 'Needs you' banner reading '1 waiver pending, 1 task escalated', counters for active agents, budget used, epics in flight and alerts, and a 'Now running' list of two live sessions" /><br /><sub><b>Overview</b> — the one screen that asks something of you.</sub></td>
<td width="50%"><img src="ui/e2e/__screenshots__/phase-6b/task-detail-desktop-dark.png" width="100%" alt="Task detail page for epic-9/task-3 showing a Spec contract card with case, origin, epic, plan version and claims, and an Attempts list naming each agent, provider and outcome" /><br /><sub><b>Task detail</b> — the contract, and every attempt against it.</sub></td>
</tr>
<tr valign="top">
<td><img src="ui/e2e/__screenshots__/phase-6b/flow-desktop-dark.png" width="100%" alt="Flow page: task cards arranged in three columns labelled Wave 0 (6 tasks), Wave 1 (2 tasks) and Wave 2 (1 task), joined by dashed dependency edges" /><br /><sub><b>Flow</b> — waves and the dependency edges that shaped them.</sub></td>
<td><img src="ui/e2e/__screenshots__/phase-6b/kanban-desktop-dark.png" width="100%" alt="Kanban board with Todo, In progress, Reviewing and Blocked columns; cards carry severity chips such as S2-major and agent chips such as coder - mid" /><br /><sub><b>Kanban</b> — what is moving, and what is stuck and why.</sub></td>
</tr>
<tr valign="top">
<td><img src="ui/e2e/__screenshots__/phase-6b/sessions-desktop-dark.png" width="100%" alt="Sessions page: two session cards, sess-fixture and sess-multiproject-fixture, joined by dashed edges to six live agent cards labelled coder - small, coder - mid and planner - frontier, each marked working" /><br /><sub><b>Sessions</b> — every live agent and the tier that drew it.</sub></td>
<td><img src="ui/e2e/__screenshots__/phase-6b/analytics-desktop-dark.png" width="100%" alt="Analytics page with throughput, cost-per-task, same-mistake-rate and recheck-pass-rate cards, bar charts of cost by model tier and by provider, and a cross-check quorum panel" /><br /><sub><b>Analytics</b> — cost per task, per tier, per provider, and the same-mistake rate.</sub></td>
</tr>
<tr valign="top">
<td><img src="ui/e2e/__screenshots__/phase-6b/lessons-desktop-dark.png" width="100%" alt="Lessons page listing lesson candidates with scope and status chips, each with approve and reject actions" /><br /><sub><b>Lessons</b> — candidates waiting on your approve or reject.</sub></td>
<td><img src="ui/e2e/__screenshots__/phase-6b/timeline-desktop-dark.png" width="100%" alt="Timeline page: an event list filtered by Prompts, Dispatches, Gate events, Scheduler and Errors chips, showing task-added, user_prompt and session-start entries with timestamps and task ids" /><br /><sub><b>Timeline</b> — the append-only log itself, filtered.</sub></td>
</tr>
</table>

Dark and light, desktop and mobile; errors by taxonomy category, roadmap
progress joined to real task and token counts, and per-project scoping.

→ **[The dashboard](docs/guide/dashboard.md)** — what each of the eleven pages
shows you. It is part of the clone, not of the package.

## Status

Phases 1–9 are built and merged: loop runner, worktree engine, gates, state and
analytics, dashboard, self-extension, cross-provider judges, hardening. Phase 10
is half in: `smith daemon` watches the factory in the background and its ops
runbook is written; the hosted UI stays deferred. Beside the phases, `/bs audit`
is built: an existing project can be read on four axes and one epic cut from
what you accept.

The CLI is on npm as `@juzser/blacksmith`, with the caveat
[Install](#the-package--smith-inside-a-project-you-already-have) states: the
registry carries `0.1.0`, the version that runs out of a clone-shaped install,
and `0.1.1` — the one that runs beside you and knows it is a package — is in
this repo and not published yet. Either way the package is the binary and what
it reads. The dashboard, the docs, the test suite and `/bs` itself come from a
clone; a plugin is what would move `/bs`, and it is
[scoped, not cut](docs/specs/plugin-port-scope.md).

The one thing to know up front: **the daemon watches, it does not drive.** It
tells you what the factory needs — budget alarms, agents that never came back,
rechecks and cadences that are due — without an open session. Doing the work is
still `/bs run`, a playbook your Claude Code session follows; close the session
and nothing advances.

→ **[What is built, what is not](docs/guide/status.md)**, and the unflinching
version in
[Limitations today](docs/guide/operator-guide/limitations.md#limitations-today).

## Docs

| Doc | For |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Getting it running, per platform |
| [`docs/guide/operator-loop.md`](docs/guide/operator-loop.md) | The six steps you actually do |
| [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) | Every command, end to end, with output |
| [`docs/guide/status.md`](docs/guide/status.md) | What is real today |
| [`docs/guide/extending.md`](docs/guide/extending.md) | Adding agents, policies, taxonomy values |
| [`docs/specs/black-smith-architecture.md`](docs/specs/black-smith-architecture.md) | Why it is shaped this way |
| [`docs/specs/audit-command-scope.md`](docs/specs/audit-command-scope.md) | What `/bs audit` promises an audited project, and why |
| [`docs/specs/plugin-port-scope.md`](docs/specs/plugin-port-scope.md) | What it would take to run `/bs` without a clone |
| [`docs/guide/dashboard.md`](docs/guide/dashboard.md) | The dashboard tour |
| [`docs/runbooks/providers.md`](docs/runbooks/providers.md) | Setting up the cross-provider judges |
| [`docs/runbooks/ops.md`](docs/runbooks/ops.md) | Running `smith daemon` unattended |
| [`docs/README.md`](docs/README.md) | Everything else, one line each |

Agents read [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) instead — this
repo is self-governing, and the rules it runs under live there.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the details. Two things up front: the
gate is `bash scripts/check.sh` and it is the same script CI runs, so red
locally is red there; and several artifacts here are *generated* — see
[extending](docs/guide/extending.md) for which files you may hand-edit.

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`SECURITY.md`](SECURITY.md) ·
[`CHANGELOG.md`](CHANGELOG.md)

## License

[MIT](LICENSE)
