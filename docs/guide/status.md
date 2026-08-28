# Status — what is built, what is not

Blacksmith is built in phases, and the honest answer to "does it work yet"
differs per phase. This page is the summary. The unflinching version — every
place the framing is ahead of the code — is
[operator-guide "Limitations today"](operator-guide.md#limitations-today),
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
| 8. Cross-provider judges | Codex/DeepSeek adapters, quorum policy, shadow-mode calibration, an independent finder that can raise a finding and not only drop one | Built, merged — every external ships off, and one you switch on is still powerless until promoted |
| 9. Hardening | Escalation ladders, budget alarms, same-mistake KPI, MCP surface standard, prompt-injection fencing, cross-session event edges | Built, merged |
| 10. Deployment + ops | A background watcher (`smith daemon`) and its ops runbook; a Cloudflare port of the UI | Watcher + runbook built; the Cloudflare port stays deferred |

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

**3. The cross-provider judges ship off, and powerless after that.** Both
Codex and DeepSeek are `enabled: false` in
[`crosscheck.yml`](../../factory/policies/crosscheck.yml), so neither is
invoked at all — the tier is built and shipped inert, because which of the two
a machine can actually call is a fact about the machine and the repo has never
met yours. Switch on the one you have and it arrives in `mode: shadow`:
verdicts are recorded, and the factory still decides on the native Claude
judge alone. That is deliberate — you calibrate against recorded disagreement
before you give a second vendor a vote. `smith judge preflight` says
beforehand whether one you switched on can be reached at all. See
[`../runbooks/providers.md`](../runbooks/providers.md).

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
[operator-guide §6b](operator-guide.md#6b-worker-proposed-spec-changes--the-third-exit).

## Dogfooding record

Blacksmith is run on Blacksmith, and the defect logs from doing so are kept
rather than tidied away: `docs/specs/dogfood-4-findings.md`,
`docs/specs/dogfood-envkit-findings.md`, `docs/specs/phase-9-punch-list.md`.
They are large and internal. Most of what the gates and policies do exists
because one of those entries forced it — which is also the argument for
keeping them readable.
