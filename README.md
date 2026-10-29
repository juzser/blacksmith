<div align="center">

<img src="ui/src/assets/brand/black-smith.png" alt="Blacksmith" width="170" />

# Blacksmith

**From feature request to reviewable PR — with an AI engineering workflow.**

Plan a feature as signed spec contracts, build each in its own git worktree, put the result through review and verification gates, and merge through a queue into one pull request.

You co-plan the spec. It decomposes, codes, tests, reviews, refutes itself —<br />
and hands you exactly one pull request.

[![CI](https://github.com/juzser/blacksmith/actions/workflows/ci.yml/badge.svg)](https://github.com/juzser/blacksmith/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-1f1f1f)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-1f1f1f)
![TypeScript](https://img.shields.io/badge/TypeScript-1f1f1f)

**[Features](#features) · [Install](#install) · [Using it](#using-it) ·
[How it works](#how-it-works) · [Safety](#safety) · [Status](#status) ·
[Docs](#docs)**

<pre>
goal → contracts you sign → one worktree per contract, run in parallel
     → schema · tests · reviewer · verifier → one pull request you merge
</pre>

<sub>Two touchpoints. Everything between them runs unattended.</sub>

</div>

**Compared with plain Claude Code**

| Step | Plain Claude Code | Blacksmith |
|---|---|---|
| Spec | You describe the work in chat | A planner drafts spec contracts, a spec-reviewer challenges them, and they are frozen when you sign |
| Plan | One session holds the plan in its context | Tasks with disjoint path claims, admitted in waves, each in its own git worktree |
| Review | The author checks its own work | A fresh-context reviewer that never saw the coder's session |
| Verification | You run the tests and read the diff | Schema check, tests and coverage evidence, then a verifier whose only job is to refute the reviewer |
| Merge | You merge what the session produced | A serial merge queue into one integration branch and one pull request that you merge |
| Long work | One session carries the work, with any subagents it starts; compaction summarizes it when the window fills, and what outlives the session is its transcript and the files it wrote | Plans, task states and gate results live on disk, so a new session picks the epic up from the log, and a wave too wide for one window runs in a session of its own |
| Course change | You or the session change the plan in chat, and the change lives in the conversation | A worker that finds a criterion wrong proposes a plan diff; you approve or reject it, and an approval cuts a new plan version |
| Lessons | You or the session record what to avoid in CLAUDE.md or memory, and later sessions read it | Errors are classified, a scribe drafts lesson candidates you approve, and each brief carries the lessons for its role and paths |

Demo: NOT MEASURED. No single-run recording is published yet.

Every claim from the tagline to here has a row in the
[claims matrix](docs/claims-matrix.md) that names the code, test or document
behind it, and a test fails when one has no row or a row cites a path that
does not exist. Further down the page, the matrix holds rows only for the
claims the 0.6.0 docs pass and later edits wrote or changed, kept by hand, and
the test checks only that the paths they cite exist.

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
<td colspan="2">

**More agents at once, fewer tokens per merged task, no check skipped**

Quality comes first, speed second, tokens third. After every merge, each task
whose dependencies are done and whose paths no task in flight claims is
admitted at once, rather than when the whole wave drains. Once the tester is
done, the grader, the reviewer and, when its triggers fire, the security
reviewer are dispatched together. `bs brief compose` builds every brief.
Full-suite and e2e runs take one lock per machine (`bs heavy run`), so agents
running at once queue for them instead of running them all together. In a
clone, or with the [plugin guard](docs/guide/plugin-guard.md) on, the policy
hook refuses a brief sent to the wrong agent type and a foreground `sleep` of
2 s or more, and names the fix. No judge, check, review round or verifier pass
is dropped to save tokens, and no model is downgraded.

Claude Code is set up for the width. `bs init` raises its caps of 20 subagents
and 10 parallel tool calls to 1000 each, and sets a 633k compact window, so a
session on a current 1M-token model compacts at the policy's 60%; `bs doctor`
warns when the caps are not raised. The wave-runner, the coder and the tester,
which wait minutes on test runs, keep a 1h prompt cache instead of the default
five minutes.

How wide it runs can be checked. Before anyone is dispatched,
`bs wave schedule` replays the plan and reports how many rounds it needs, its
widest round, and the tasks held back by their claims, a shared hotspot or an
import edge rather than by a dependency; it exits 1 when the plan stalls and 2
when tasks are held back that way. Once a wave lands, `bs wave audit` reads the
log back and says whether a wave admitted N wide ran N wide, and
`bs epic width` asks the same of every closed epic. All three only read; the
close records an epic's width without holding on it, though an external
judge, when one is enabled, may refute a wave that was admitted and shows no
work.

Only what the turn needs is loaded. Each `/bs` verb loads its own playbook when
it runs, and only the verbs that dispatch read the dispatch contract. A
wave-runner reads the wave and dispatch playbooks by slice:
`bs playbook slice` prints one wave step or one dispatch section.

Merge lanes are opt-in. `bs queue run --batch` groups claim-disjoint tasks
that do not depend on each other, tests each group once, and bisects a red
group so the tasks that pass still land. No playbook passes `--batch`, so by
default the queue tests and merges one task at a time.

</td>
</tr>

<tr valign="top">
<td width="50%">

**Nothing is dispatched without a contract**

Every task carries an objective, an output schema, acceptance criteria, a tool
allowlist, the exact paths it may touch and a token budget. The plan is frozen
the moment you sign it and versioned in the event log, so a worker cannot
quietly reinterpret the job. No contract, no dispatch.

A worker can still argue with it out loud. A coder or tester that finds a
criterion wrong returns a proposed plan diff; `bs plan propose` checks that
the diff yields a valid plan and records it without touching the plan, and
`bs plan proposals` lists it, marked stale once a newer plan version overtakes
the one it was drafted against. The answer is yours: `bs plan approve` cuts
the next version through `bs plan amend`, and `bs plan reject` requires a
rationale.

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
into one waiver question per epic, answered with `/bs waivers`. Only S3 and S4
are ever waivable.

A judge's verdict counts only if the worktree did not move under it. The
playbook brackets each judge of a task, and the audit's shared tree, with
`bs worktree fingerprint` and `bs worktree verify`, gitignored paths aside;
drift exits 1, and the playbook discards the verdict and dispatches the judge
again on a clean tree.

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

**Checked against your goal before the pull request**

Every task gate reads text the planner wrote, so they can all pass a plan that
solves the wrong problem. Before the integration PR, `bs epic goal-check`
records the plan checked clause by clause against the roadmap goal, the one
reference the planner did not write, and an uncovered clause raises a spec
finding. `bs integration check` runs the project's checks on the assembled
integration branch, not in a worktree, and `bs epic spec-review` records the
closing spec review read against that branch. `bs epic verdict` holds the epic
while a task is unfinished, a blocking finding is open, or the integration
check, the goal check or a closing review the tier requires is missing, failed
or stale; once those pass and an external judge is enabled, a cross-provider
quorum decides go or hold. `bs epic close` refuses a hold unless you give a
rationale, which it records.

</td>
<td>

**An epic outlives one context window**

`/bs run` has two tiers. The epic tier,
[`run.md`](.claude/skills/bs/run.md), admits waves and closes the epic; the
wave tier, [`wave.md`](.claude/skills/bs/wave.md), takes one wave from
worktrees to the merge queue. A wave that fits the epic session's window runs
inline. One too wide for that runs in a session of its own, driven by the epic
session or, when the wave would eat the window the epic needs, by the
`bs-wave-runner` agent. `bs session start --continues` links a new session to
the epic's log, `bs event lineage` prints the sessions on that line, and
`--lineage` makes a `bs stats` read answer for the whole epic rather than the
window you are in.

</td>
</tr>

<tr valign="top">
<td>

**It learns from its own errors**

Errors are classified against a taxonomy, and a scribe distills them into
lesson candidates you approve or reject with `/bs lessons`. Each approved
lesson carries one error class. A brief always carries the lessons for the
agent's role and for the paths it claims; a broader lesson goes in up front
only once its class has proven to recur (three tasks in 30 days) or has come up
in this epic, and the rest are named for the agent to read on demand. The
same-mistake rate tells you whether that is actually working. A loop you can
audit, not a memory you have to trust.

</td>
<td>

**A frontier planner, cheap workers**

Planning and judgment go to a frontier model; the bulk of the work goes to
small, fast tiers, many at once. Every session and every live agent is visible
with the tier that drew it, and cost breaks down per task, per tier and per
provider. `bs stats effectiveness` says what that bought: tokens per task and
per role, defects that escaped a passing gate, and how often each reviewing
role's findings held up, with NOT MEASURED where nothing was measured.

</td>
</tr>

<tr valign="top">
<td colspan="2">

**The log is the source of truth**

Every prompt, dispatch, gate result and error is an append-only event on disk.
The dashboard is a projection of that log, and `bs db rebuild` reconstructs
the entire database from the log alone. Nothing the factory did exists only in
a chat transcript.

Every event but a `session-start` names a parent event, and an append whose
parent is not already in the log is refused, so any record can be followed
back to a `session-start`
(`bs stats timeline --causal-chain-for <event-id>`).

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
- **A local, read-only dashboard** over the same event log — optional, in
  the package and in a clone; [its guide](docs/guide/dashboard.md) walks the
  pages.

## Install

Say **"install Blacksmith"** to a Claude Code session and it does the whole
thing: [`INSTALL.md`](INSTALL.md) is an executable runbook, and it stops to ask
before anything that touches your machine.

The [quickstart](docs/guide/quickstart.md) walks from install to a first epic.
By hand it is one command in a shell:

```bash
npm i -g @juzser/blacksmith
```

and two inside Claude Code:

```
/plugin marketplace add juzser/blacksmith
/plugin install blacksmith@blacksmith
```

Two optional plugin modules come from the same marketplace, bs-mod (a live
HUD of your epic above the prompt) and pr-mod (the repo's open pull requests),
and [`docs/guide/mods.md`](docs/guide/mods.md) has what each needs:

```
/plugin install bs-mod@blacksmith
/plugin install pr-mod@blacksmith
```

Then `bs init` in the project you want it to work on. That creates
`.blacksmith/` beside your code — the event log, your epic plans, a roadmap and
a `stack.yml` to answer. Outside it, `bs init` writes two files in the
project's `.claude/`, both kept out of git through `.git/info/exclude`:
`settings.local.json`, where it adds Claude Code settings only where you have
not set them yourself — the
[concurrency caps](INSTALL.md#raise-the-concurrency-caps) and the
[compact window](INSTALL.md#compact-earlier-on-1m-models) — and
`bs-settings-record.json`, its record of the keys it wrote. `BS_HOME` moves the
`.blacksmith/` root if you want one home for several projects. You now have
`/bs`; restart every running Claude Code session once so it reads those
settings.

**Both halves are required.** The package
([`@juzser/blacksmith`](https://www.npmjs.com/package/@juzser/blacksmith)) is the
deterministic `bs` CLI; the plugin is `/bs` and the fourteen agent roles it
dispatches, each named `bs-<role>` (`bs-coder`, `bs-reviewer`, and so on).
`bs` alone never gives you `/bs`, because Claude Code loads
skills from a project's `.claude/`, your `~/.claude/`, or a plugin — never from
`node_modules` — and a `/bs` with no `bs` on PATH can run nothing. Take
`latest`: `0.1.0` predates `bs init` and keeps state inside its own install
directory, which the next `npm i` replaces.

<details>
<summary><b>A clone instead — the whole factory</b></summary>

A clone is for hacking on Blacksmith itself, and for the one thing an install
does not carry by default: this repo's own enforcement.

```bash
git clone https://github.com/juzser/blacksmith.git && cd blacksmith
pnpm install --frozen-lockfile
pnpm run build                          # tsc -> factory/orchestrator/dist/
bash scripts/check.sh                   # the gate CI runs; ends in `== PASS ==`
```

Open a Claude Code session in the clone and you have `/bs` already, from the
checkout's own `.claude/` — **do not also install the plugin there.** You would
get two of everything (`bs` and `blacksmith:bs`, `bs-auditor` and
`blacksmith:bs-auditor`, once per role), pay the always-on cost twice, and the two
copies are free to disagree: the plugin's is a pinned checkout of `main`, the
project's is whatever branch you have out. `claude plugin disable blacksmith`
settles it. It also turns off the prompt recorder in that clone, which only
the plugin registers; a clone that wants its prompts recorded keeps the plugin
enabled and accepts the double listing
([INSTALL.md](INSTALL.md#the-install--bs-and-bs)).

Enforcement stays with the clone because this repo's `.claude/settings.json`
deny rules and its guard hook resolve paths against a checkout. The plugin's
`hooks/hooks.json` holds the non-blocking prompt-capture hook and the
[plugin guard](docs/guide/plugin-guard.md), which does nothing until you set
`BS_PLUGIN_GUARD=1` and then runs the package's `bs-policy-hook` in front of
your tool calls for the same policy decisions. The rest of that port is scoped
in [`docs/specs/plugin-port-scope.md`](docs/specs/plugin-port-scope.md).

`INSTALL.md` Part 2 is the long form of the clone above: per-platform
setup (macOS, Debian/Ubuntu, Fedora, Alpine, WSL2), the stack interview,
troubleshooting, and the known platform gaps stated rather than papered over.

</details>

## Using it

### Starting a new project

Blacksmith never builds inside itself. It builds a **separate project**, in
its own directory, with its own git history — and what comes out is not a
Blacksmith dependency. No config pointing back here, no docs about the
factory; one `Built by Blacksmith` line in its README is the whole trace.

Open a Claude Code session in the directory you ran `bs init` in, or in a
clone, and say **`/bs new my-app`**. If you would rather drive it yourself, it
is three commands. The path below is the copy `bs init` made; it sits under
`$BS_HOME` instead if you set one, and is `factory/policies/stack.yml` in a
clone:

```bash
$EDITOR .blacksmith/factory/policies/stack.yml   # your stack answers: language,
                                                 # frontend, database, deploy
                                                 # target. `none` is fine.
bs stack check                                   # which answers the templates
                                                 # honour, which they only
                                                 # record, which they refuse
bs new my-app --target-dir ~/code/my-app         # add --ui for a frontend
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

Underneath it is the `bs audit` family — `open`, `record`, `consolidate`,
`decide`, `cut`, `resolve`, `close` — and
[`docs/specs/audit-command-scope.md`](docs/specs/audit-command-scope.md) is the
contract each of them keeps.

### The loop

Day to day, from a Claude Code session in any project you ran `bs init` in,
or in a clone:

| Command | What it does |
|---|---|
| `/bs new <project> [--ui]` | Scaffold a new target project from your stack answers |
| `/bs mcp <project>` | Layer the MCP surface on and make its milestone due |
| `/bs audit <project-dir>` | Audit an existing project on four axes, rank, decide at a hard stop, cut one epic |
| `/bs use <project>` | Bind this session to one project; a reminder keeps the pipeline in front of its changes |
| `/bs plan <goal>` | Draft or re-plan an epic with the planner + spec-reviewer |
| `/bs run <epic>` | Admit a wave and drive it through the loop to merge |
| `/bs status` | Live agent count, budget burn, epic phase |
| `/bs ui` | Serve the local dashboard |
| `/bs waivers` | Answer the pending S3/S4 waiver batch for an epic |
| `/bs lessons` | Review pending lesson candidates |
| `/bs report` | Render the scribe's progress digest |

Each of those is a playbook, not a script: the deterministic half is a `bs`
command you can run yourself — `bs --help` lists all of them — and the
judgment half is a Claude Code session the playbook dispatches. That is also
the line between the two installs: the `bs` half travels in the package, the
playbooks in the plugin.

How `/bs` talks to you is written down, in the console's
[Talking to the operator](.claude/skills/bs/SKILL.md#talking-to-the-operator)
section. It replies in the language you write in and in plain words, opens
with the result or the decision you need to make, and puts commands, ids and
paths in a short technical part at the end, except a command you have to run.
A reply with more than one step numbers them, and when it offers options and
recommends one, every option carries a confidence figure. The same rules bind
the `/bs report` digest and the integration PR body; agent briefs and event
payloads are exempt.

→ **[The operator loop](docs/guide/operator-loop.md)** — the six steps, in the
order you meet them.<br />
→ **[Operator guide](docs/guide/operator-guide.md)** — the same ground with real
commands and real output.

## How it works

You describe a goal. A planner on a frontier model turns it into spec contracts
and a spec-reviewer hunts holes in them *before* you sign; signing freezes plan
v1. From there the loop admits a wave whose path claims do not overlap, sends
researcher and UI/UX work ahead of code where the epic needs it, and runs a
coder and a tester in each task's worktree. Then the grader, which holds the
result to its own acceptance criteria, the reviewer and, when triggered, the
security reviewer go out together; the gates run, and a serial merge queue
lands the task on `bs/<epic>/integration`. Each merge frees paths, and
`/bs run` admits the next task that fits right away instead of waiting for the
wave to drain. At the close, `bs cleanup` removes the task worktrees and
branches that are merged and have been idle for 24 hours, and keeps anything
it is unsure of. One epic, one integration PR, merged by you.

The fourteen roles, and when each one is dispatched:

| Role | What it does | When it is dispatched |
|---|---|---|
| `bs-planner` | Turns the goal into a plan of task specs, and renders the verdict against acceptance criteria | `/bs plan`, and again once every task is done |
| `bs-spec-reviewer` | Hunts holes in the spec | Before you sign; at the close against the assembled branch (on a small epic only after an amendment); and for the goal check |
| `bs-researcher` | Writes a research brief on an unknown | Only when a task needs one before code (never on a small epic), a worker asks for one, or `/bs plan` meets an unfamiliar repo |
| `bs-uiux` | Writes the UI spec, then checks the tester's screenshots against it | Only for a UI-affecting task: the spec before code, the visual pass once screenshots exist |
| `bs-coder` | Implements one task, tests first, in its worktree | Every task |
| `bs-tester` | Adds missing unit coverage, runs e2e, captures screenshots | Every task, after the coder |
| `bs-grader` | Scores the result against the task's acceptance criteria | Every task, after the tester: at most two rounds on a huge epic, one below |
| `bs-reviewer` | Reviews the diff read-only, in a fresh context | Every task, with the grader |
| `bs-security-reviewer` | Reviews a task's diff, or the whole project in an audit, for security | Only when `bs security triggers` fires for the task, and for the security axis of `/bs audit` |
| `bs-verifier` | Tries to refute the reviewer's findings | On S1 and S2 findings (S1 only on a small epic), plus a 20% sample of S3 on a huge one |
| `bs-merger` | Resolves a merge-queue conflict | Only when the automatic rebase fails |
| `bs-wave-runner` | Runs one wave, worktrees through merge queue, in a session of its own | Only when a wave would eat the window the epic session needs to reach its end |
| `bs-scribe` | Distills lesson candidates, writes the integration PR body and the `/bs report` digest | `/bs lessons` for raw candidates, `/bs report`, and the integration PR |
| `bs-auditor` | Reads a project on one axis: performance, code quality or architecture | Only in `/bs audit`, three at once |

→ The pipeline diagram and the reasoning behind each stage:
**[architecture §3 — The loop](docs/specs/black-smith-architecture.md#3-the-loop)**.

## Safety

In a clone, and in a plugin install with the
[plugin guard](docs/guide/plugin-guard.md) turned on, these rules are enforced
mechanically — a `PreToolUse` policy layer on every command an agent runs,
plus branch protection — not by trust. A default plugin install has that
layer off: there, branch protection and the rules the playbooks give the
agents are what hold. Full rules:
**[`docs/standards/guardrails.md`](docs/standards/guardrails.md)**.

- **Secrets are environment-only.** `.env.example` is the only committed env
  file (variable names, never a secret's value). Agents are told never to echo
  a credential, and in this repo a gitleaks scan in the CI gate blocks a merge
  that carries one. The event logger writes values as given; masking happens
  only at the few points that handle a known credential shape, such as URL
  userinfo in git errors.
- **Only you merge to `main`.** No agent may push or merge to a protected
  branch, and force-push is refused by that layer on every branch, protected
  or not — an agent's pushed branch is append-only. Task branches reach the
  integration branch solely through the serial merge queue.
- **No autonomous deploy or outbound sends.** Deploys, publishes and message
  sends each need per-invocation approval.
- **Budgets are declared per role and sized per effort tier.** A medium epic
  gets 16M tokens with an alarm at 70%, and a coder task 220K tokens and 700
  diff lines; a small epic gets half the task numbers and 4M, a huge one
  double and 32M. Every role that is dispatched has a price, the wave-runner,
  the merger and the scribe included, so `bs budget alarm` and `bs wave check`
  count all of them. Fan-out is bounded by the
  claim graph, and `max_in_flight_tasks` is available on top of it, off by
  default. Which of these *block* versus *report* is spelled out in
  [`factory/policies/budgets.yml`](factory/policies/budgets.yml) — the task cap
  reports on purpose.

Found a vulnerability? [`SECURITY.md`](SECURITY.md) — report privately, not in
a public issue.

## Status

Phases 1–9 are built and merged: loop runner, worktree engine, gates, state and
analytics, dashboard, self-extension, cross-provider judges, hardening. Phase 10
is half in: `bs daemon` watches the factory in the background and its ops
runbook is written; the hosted UI stays deferred. Beside the phases, `/bs audit`
is built: an existing project can be read on four axes and one epic cut from
what you accept.

The CLI is on npm as `@juzser/blacksmith`, at `0.6.0`. Two binaries are
the ones you run: `bs`, and `bs-run` (since `0.2.0`), which runs a rendered
turn on a `cli` harness such as Codex. `bs-prompt-hook` is the lean hook
entry that records operator prompts, and `bs-policy-hook` the policy hook the
opt-in plugin guard runs. `smith` and `smith-run` remain as
deprecated aliases. `0.1.1` was the first version that ran beside
you and knew it was a package, rather than out of the clone-shaped install
`0.1.0` was. The package is the `bs` binaries and what they read: policies,
schemas, migrations, scaffold templates and the agent role contracts, plus the
built dashboard. The plugin is `/bs`, the `bs-<role>` agents, the
prompt-capture hook and the plugin guard, off until you turn it on. A clone
adds the docs, the test suite and this repo's own enforcement;
[`docs/specs/plugin-port-scope.md`](docs/specs/plugin-port-scope.md) is the
record of how the port was scoped and what has shipped.

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
| [`docs/guide/quickstart.md`](docs/guide/quickstart.md) | From install to a first epic |
| [`docs/guide/operator-loop.md`](docs/guide/operator-loop.md) | The six steps you actually do |
| [`docs/guide/operator-guide.md`](docs/guide/operator-guide.md) | Every command, end to end, with output |
| [`docs/guide/status.md`](docs/guide/status.md) | What is real today |
| [`docs/guide/extending.md`](docs/guide/extending.md) | Adding agents, policies, taxonomy values |
| [`docs/specs/black-smith-architecture.md`](docs/specs/black-smith-architecture.md) | Why it is shaped this way |
| [`docs/specs/audit-command-scope.md`](docs/specs/audit-command-scope.md) | What `/bs audit` promises an audited project, and why |
| [`docs/specs/plugin-port-scope.md`](docs/specs/plugin-port-scope.md) | How `/bs` runs without a clone, and what the plugin leaves behind |
| [`docs/guide/dashboard.md`](docs/guide/dashboard.md) | The optional read-only dashboard, page by page |
| [`docs/guide/plugin-guard.md`](docs/guide/plugin-guard.md) | The policy guard a plugin install can turn on |
| [`docs/guide/mods.md`](docs/guide/mods.md) | The optional bs-mod HUD and pr-mod |
| [`docs/runbooks/providers.md`](docs/runbooks/providers.md) | Setting up the cross-provider judges |
| [`docs/runbooks/ops.md`](docs/runbooks/ops.md) | Running `bs daemon` unattended |
| [`docs/trial/methodology.md`](docs/trial/methodology.md) | How to compare plain Claude Code with Blacksmith, and what one run can show |
| [`docs/claims-matrix.md`](docs/claims-matrix.md) | What backs each claim this page makes |
| [`docs/README.md`](docs/README.md) | Everything else, one line each |

Agents read [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) instead — this
repo is self-governing, and the rules it runs under live there.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the details. Two things up front: the
gate is `bash scripts/check.sh` and it is the same script CI runs, so red
locally is red there; and several artifacts here are *generated* — see
[extending](docs/guide/extending.md) for which files you may hand-edit.

A pull request merges into `main` only when both CI checks are green, the gate
and the e2e job: a GitHub ruleset on the default branch requires them, with
no bypass. A maintainer can set a pull request to auto-merge
(`gh pr merge --auto`), and it lands once both checks pass.

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`SECURITY.md`](SECURITY.md) ·
[`CHANGELOG.md`](CHANGELOG.md)

## License

[MIT](LICENSE)
