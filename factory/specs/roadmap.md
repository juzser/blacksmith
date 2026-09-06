# Blacksmith — Roadmap

Source of truth for the Overview/Roadmap dashboard pages' milestone
progress (`docs/specs/black-smith-architecture.md` §10, §16 "Build order").
Parsed by `factory/orchestrator/src/roadmap.ts`; projected into the
`milestones` table by `factory/orchestrator/src/db/projector.ts` and joined
with task/token stats by `factory/orchestrator/src/db/queries.ts`'s
`roadmapPage()`/`overview()`.

Four `envkit` milestones — bootstrap, config loader, MCP surface, MCP
follow-up — were struck from this file 2026-09-04: this clone's
`workspaces/` is empty and the only envkit checkout lives in a sibling
clone, so a project declared here could not be reached from here. The
removed rows are preserved verbatim, not lost, in
`docs/specs/dogfood-4-findings.md` (D-271).

Each milestone is a `## <name>` heading followed by bullet fields:
`id` (required, stable), `status` (required — `planned` | `in-progress` |
`completed`), `goal` (optional, one sentence), `epics` (optional, `[]` when
no epic has been mapped to this phase yet — the join yields zero tasks
until an epic is tagged here), `project` (optional, defaults to
`black-smith` — this clone), and `kind` (optional — `factory` | `dogfood` |
`product`).

`kind` describes the *project*, not the milestone, so one bullet anywhere in
a project's milestones settles all of them; a second copy would only be a
copy that drifts. It defaults to `factory` for `black-smith` and `product`
for everything else, which is why a project registered by `smith new` needs
no bullet at all. `dogfood` is the one value that must be written by hand:
a project built to exercise the factory looks, in the data, exactly like a
project built for its own sake — the difference is intent. The Roadmap page
shows `product` by default and hides the other two, so an operator asking
"what has this factory built" is not reading past the factory's own phases.

## Phase 1 — Interview + standards
- id: phase-1
- status: completed
- epics: []
- goal: Run the operator interview; compile stack.md and per-agent constraint blocks; pin the scaffold.

## Phase 2 — Skeleton + contracts
- id: phase-2
- status: completed
- epics: []
- goal: Repo layout, spec/result/finding/lesson JSON Schemas, taxonomy.yml, agent templates.

## Phase 3 — Loop runner + worktree engine
- id: phase-3
- status: completed
- epics: []
- goal: Dispatch from specs, path-claim validation, worktree lifecycle, serial merge queue, event log.

## Phase 4 — Gates
- id: phase-4
- status: completed
- epics: []
- goal: Test gate, reviewer/verifier chain, severity policy, waiver flow.

## Phase 5 — State + analytics
- id: phase-5
- status: completed
- epics: []
- goal: SQLite projections, timeline, live agent registry.

## Phase 6 — UI (HDS)
- id: phase-6
- status: completed
- epics: []
- goal: Overview + timeline + kanban first (6a); lessons/errors/analytics second (6b). Local-only shipped; Cloudflare port moved to Phase 9.

## Phase 7 — Self-extension
- id: phase-7
- status: completed
- epics: []
- goal: Inferred tasks + confidence policy, scheduler, rechecks, lessons compilation loop, /bs operator skill. Dispatch stays skill-guided — the always-on daemon is Phase 9.

## Phase 8 — Cross-provider judges
- id: phase-8
- status: completed
- epics: []
- goal: Provider adapters (codex CLI, deepseek API), quorum policy, disagreement analytics, shadow-mode calibration. All four crosscheck.yml quorum_triggers have a host: blocking-finding and same-mistake fire automatically from gate.ts; epic-final-verdict (`smith epic verdict`) and plan-quorum (`smith plan quorum`, critique-only) are operator-invoked. Both external providers ship `enabled: false` — never invoked until an operator switches on the one their own box has, and then in `mode: shadow`, recorded and gating nothing until promoted per docs/runbooks/providers.md.

## Phase 9 — Hardening
- id: phase-9
- status: completed
- epics: []
- goal: Escalation ladders, budget alarms, same-mistake KPI, the MCP surface standard, and the enforcement gaps specced in `docs/specs/phase-9-punch-list.md` (P9-1..P9-37, all fixed — close-out and the deliberate leftovers are in that file's "Phase 9 close-out" section). P9-1..P9-7 came from the subagent interviews: lessons approve/reject verb, dispatch-time lesson injection, postRunCheck split, a host for sensitive-paths.yml, the judge worktree-immutability guard, prompt-injection hardening, cross-session event edges. P9-8..P9-30 came from running a real epic end to end (see `docs/specs/dogfood-envkit-findings.md`, D-14..D-48) — the highest-value three being producers for the five task-status events that have none (D-46/P9-29, which subsumes the task-id convention of D-28), checks that run at the integration root rather than only inside task worktrees (D-42/P9-26), and an epic close that is both a logged fact and a folded projection (D-43/D-44/P9-27). P9-31..P9-37 came from the fixes themselves: two of them colliding (P9-31), the goal line's own escalation ladder turning out to be policy prose nothing parsed (P9-32, now counted from the log by `smith escalation check`), `epic.alarm_ratio` having no consumer (P9-33, now `smith budget alarm`), the same-mistake KPI having no instrument (`smith kpi same-mistake`), the novelty gate having no hand-authored entry point and being an exact-duplicate detector at its defaults (P9-34/P9-35), the UI's lesson-edit route being a third ungated door into memory (P9-36), and the taxonomy being hand-copied into four files that had all drifted (P9-37). The MCP surface standard (`docs/standards/mcp.md`, `smith mcp init|check`, hard-gated at epic close) also landed here, from the operator decisions of 2026-08-07 rather than from a punch-list item. Moved to Phase 10, untouched: runbooks beyond `docs/runbooks/providers.md`, the Cloudflare port, and the dispatch daemon. `epics: []` is accurate rather than unfilled — the phase was driven as punch-list items on branches, not as a planned epic.

## Phase 10 — Deployment + ops
- id: phase-10
- status: completed
- epics: [phase-10]
- goal: The three items Phase 9 carried on its goal line. Two landed, one stays deferred. **Ops runbook** — `docs/runbooks/ops.md`, so the factory can be operated without reading the operator guide end to end. **The background process** (moved from Phase 7, then Phase 9) — shipped as `smith daemon`, and shipped deliberately narrower than the "always-on dispatch daemon" the earlier phases named: it is a *watcher*. It folds the event log on an interval and reports budgets, stale agents, due rechecks and due cadences, so that *knowing* what the factory needs no longer requires an open session; it never dispatches an agent, never enters the merge queue, and never writes outside `state/daemon/` and the derived SQLite read-model. Dispatch stays skill-guided through `/bs` — architecture §12, not a gap. **The Cloudflare port of the UI** (moved from Phase 6, then Phase 9) is no longer carried here: the operator struck it to its own `planned` milestone on 2026-09-04 (`cloudflare-port`, below), so this phase closes on what it built rather than on what it deferred for a fourth time. What remains of Phase 10 comes from the four-axis mandate and is specced in `docs/specs/phase-10-scope.md` — six items, and by operator decision of 2026-09-04 they run as a real epic on this repo rather than as branch-by-branch punch-list items, because exercising the factory on itself is the only thing that turns a built instrument into an observed one. P10-2 shipped ahead of that decision as `fix/a-value-nobody-read-back` (D-269), being a wrong operational fact in the first document an operator reads.

## Cloudflare port of the UI
- id: cloudflare-port
- status: planned
- epics: []
- goal: A Cloudflare port of the dashboard — Workers/Pages + D1 + Access. Carried on the goal line of Phase 6, then Phase 9, then Phase 10 without ever being specced, and struck to its own milestone by operator decision 2026-09-04 so that Phase 10 closes on what it built. Nothing is designed yet: the dashboard is local-only, the two Cloudflare release commands are deny-listed for agents by `.claude/settings.json`, and no upload path exists for the SQLite read-model every page reads. `docs/specs/black-smith-architecture.md` §16 files it under "Hardening" and never gave it a phase of its own, which is how it survived three moves — this milestone is the first place it is a thing to plan rather than a thing to postpone.

## Factory error log — GitHub issues
- id: factory-error-log
- status: planned
- epics: []
- goal: When the factory fails while building a project, open a GitHub issue in that project's repo. Requested by the operator 2026-09-04, and scoped by their answer to the fork the request contained: the errors reported are **the factory's own build-time errors** — a gate that returns `blocked`, a task that reaches `task_status: failed`, and every `error-logged` event — not runtime errors of the shipped product. **No code is injected into a generated project**: a project this factory builds carries no reporter, no dependency and no trace of Blacksmith beyond the "Built by blacksmith" line in its README, which is the whole point of the factory contract, so the issue is opened by the factory's own side through `gh issue create` against the project's remote. **Default ON, with a per-project disable switch** — a project that does not want its issue tracker written to says so once and the mechanism stays silent for it. Deliberately not scoped here and left to the plan: which of the three sources deduplicates against an already-open issue, what the issue body may carry given that event payloads can quote logs and diffs (`docs/standards/guardrails.md` "Secrets, keys, tokens" governs, and nothing may reach an issue unredacted), and whether the daemon or the run itself is the producer. Runs as its own epic after `phase-10` closes, by operator decision — not folded into that phase's plan.
