# Status — what is built, what is not

Blacksmith is built in phases, and the honest answer to "does it work yet"
differs per phase. This page is the summary. The unflinching version — every
place the framing is ahead of the code — is
[operator-guide "Limitations today"](operator-guide/limitations.md#limitations-today),
and it is worth reading before you rely on any of this.

The machine-readable source of the same milestones is
[`factory/specs/roadmap.md`](../../factory/specs/roadmap.md), which the
dashboard's Roadmap page parses.

## Phases

| Phase | What | Status |
|---|---|---|
| 1. Interview + standards | Operator interview → [`stack.md`](../standards/stack.md) + per-agent constraint blocks | Built, merged |
| 2. Skeleton + contracts | Repo layout, JSON Schemas, taxonomy, 12 agent templates | Built, merged |
| 3. Loop runner + worktree engine | Plan versions, claims validation, worktree lifecycle, serial merge queue, event log | Built, merged |
| 4. Gates | Schema check, test gate, severity policy, waiver flow (CLI) | Built, merged |
| 5. State + analytics | SQLite projections, `smith db` / `smith stats` | Built, merged |
| 6. UI | Overview, Timeline, Kanban, Roadmap, Flow, Lessons, Errors, Analytics | Built, merged |
| 7. Self-extension | Scaffolder, `/bs` operator skill, scheduler, lessons compilation | Built, merged |
| 8. Cross-provider judges | Codex/DeepSeek adapters, quorum policy, shadow-mode calibration, an independent finder that can raise a finding and not only drop one | Built, merged — ships `codex: enabled: auto, mode: active` and `deepseek: enabled: auto, mode: active` (deepseek promoted out of shadow 2026-09-14); a box that resolves both reaches `min_providers: 2`, a box that resolves one does not |
| 9. Hardening | Escalation ladders, budget alarms, same-mistake KPI, MCP surface standard, prompt-injection fencing, cross-session event edges | Built, merged |
| 10. Deployment + ops | A background watcher (`smith daemon`) and its ops runbook; a Cloudflare port of the UI | Watcher + runbook built; the Cloudflare port stays deferred |

Two things sit beside the phases rather than inside one. **`/bs audit`** is
built: an existing project is read on four axes from a detached worktree,
the findings are ranked, the operator decides at a hard stop, and one epic is
cut — [`../specs/audit-command-scope.md`](../specs/audit-command-scope.md)
is the contract. And the **CLI is on npm** as `@juzser/blacksmith`: the
`smith` binary and everything it reads at runtime — policies, schemas,
scaffold templates, agent role files, migrations. Not the dashboard and not
the docs. **`/bs` ships beside it, as a plugin**, because it is a Claude Code
skill and a session looks for one in a project's `.claude/`, in `~/.claude/`
or in a plugin — never under `node_modules`, so the tarball's copy of the
playbooks is in the wrong place by construction. This repository is its own
marketplace: `claude plugin marketplace add juzser/blacksmith`, then
`claude plugin install blacksmith@blacksmith`, and what it installs is the
same `.claude/` a clone uses. Install both halves — the package is the
deterministic verbs, the plugin is the loop that drives them. What the plugin
deliberately does not carry is the dashboard and this repo's own enforcement;
[`../specs/plugin-port-scope.md`](../specs/plugin-port-scope.md) is the
record. Installed, `smith`
writes under `.blacksmith/` in the directory you run it from, or wherever
`SMITH_HOME` points — true of every release since `0.1.1`; the registry
carries `0.3.0`.
`0.1.0`, the release before it, predates `smith init`, ships no roadmap for
`smith new` to read, and keeps state inside its own install directory.

## The five things to know before you rely on it

**1. The daemon watches; it does not drive.** `smith daemon` (Phase 10) runs
in the background and tells you what the factory needs — budget alarms, agents
that never came back, rechecks and cadences that are due — so knowing no longer
requires an open session. Running still does: `/bs run <epic>` is a playbook
your Claude Code session follows, and closing the session still stops the work.
Every deterministic mechanic underneath it — plan and wave validation, worktree
lifecycle, the gate pipeline, the merge queue, findings and waivers, the
scheduler, the lessons pipeline, the event log — is built, tested and reachable
from the CLI. An always-on loop that *dispatches* is not built, and is not a
line the daemon is allowed to cross. See
[`../runbooks/ops.md`](../runbooks/ops.md).

**2. Some checks only run when you run them.** `smith integration check` is
the only check that sees the *assembled* integration branch, and it is
operator-invoked. Same for the closing spec review. Skipping them no longer
buys a green epic — `smith epic verdict` holds without them — but nothing
runs them on your behalf.

**3. Two cross-provider judges run, and both of them vote.**
[`crosscheck.yml`](../../factory/policies/crosscheck.yml) ships
`codex: enabled: auto, mode: active` and
`deepseek: enabled: auto, mode: active`, so a box holding the `codex` binary
and a DeepSeek key calls both on every trigger and counts both. The second
vote was earned rather than assumed: deepseek ran in shadow until
2026-09-14 — invoked and recorded as a participant, forfeiting only its
vote — and the operator promoted it after reading a run of recorded
disagreement, which is the whole point of that mode. Two active externals
are what `min_providers: 2` asks for, so a finding claude raised is decided
by a quorum instead of falling to the native verdict — on a box that
resolves both. A box that resolves one is a gating pool of one once
`finder_ne_critic` excludes the finder: still below quorum, and the case
escalates with that vendor's rationale attached instead of being decided.
`auto` on both keeps the file honest on every box: no binary and no key
means no external judge and nothing to edit. The key may live in this clone's gitignored `.env`, which
the CLI reads at start and never lets override one already exported.
`smith judge preflight` says beforehand which of the two this box can reach.
See [`../runbooks/providers.md`](../runbooks/providers.md).

**4. The epic cap blocks at admission; nothing stops a dispatch mid-flight.**
`smith wave check` now refuses to admit a wave whose declared cost will not
fit under the epic's remaining headroom in
[`budgets.yml`](../../factory/policies/budgets.yml), and refuses one that
would put more tasks in flight than `max_in_flight_tasks` allows. That is the
whole enforcement: it happens *before* the wave is dispatched, which is the
only moment a refusal costs nothing and distorts no work in progress. An
operator who disagrees admits it anyway with `--override-rationale`, and the
log then carries the machine's verdict beside the human's reason.

What is still true: the 150,000-tokens-per-task cap is *designed* to report
rather than block — a self-policed cap becomes pressure on the work being
measured — and the loop runner does not hard-stop a dispatch that is already
running, at either cap. An epic can still cross its cap by overrunning inside
an admitted wave; `smith budget alarm` and `smith escalation check` are what
tell you, after the fact.

**5. A worker can argue with the spec, but only you can change it.** A plan
version is still immutable and still the contract a worker is graded against.
What is new is the third exit: a worker that finds the criterion itself wrong
stops and returns a `spec_change_request` — the criterion, the assumption it
makes, the evidence against it, the diff it proposes, and every other site with
the same shape. That is a *proposal*. It moves no plan file, and no worker,
judge or scheduler can approve it: `smith plan approve` is an operator command,
and approving is what calls `plan amend` with no guard relaxed. An unanswered
proposal is a queue item the daemon reports, and a blocking one is a stalled
task. See
[operator-guide §6b](operator-guide/findings.md#6b-worker-proposed-spec-changes--the-third-exit).

## Dogfooding record

Blacksmith is run on Blacksmith, and the defect logs from doing so are kept
rather than tidied away: `docs/specs/dogfood-4-findings.md`,
`docs/specs/dogfood-envkit-findings.md`, `docs/specs/phase-9-punch-list.md`,
and — the first run against a project that is not this repo —
`docs/specs/dogfood-csb-audit-1-findings.md`. They are large and internal.
Most of what the gates and policies do exists because one of those entries
forced it — which is also the argument for keeping them readable.
