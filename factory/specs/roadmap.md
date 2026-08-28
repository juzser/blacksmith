# Blacksmith — Roadmap

Source of truth for the Overview/Roadmap dashboard pages' milestone
progress (`docs/specs/black-smith-architecture.md` §10, §16 "Build order").
Parsed by `factory/orchestrator/src/roadmap.ts`; projected into the
`milestones` table by `factory/orchestrator/src/db/projector.ts` and joined
with task/token stats by `factory/orchestrator/src/db/queries.ts`'s
`roadmapPage()`/`overview()`.

Each milestone is a `## <name>` heading followed by bullet fields:
`id` (required, stable), `status` (required — `planned` | `in-progress` |
`completed`), `goal` (optional, one sentence), `epics` (optional, `[]` when
no epic has been mapped to this phase yet — the join yields zero tasks
until an epic is tagged here).

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
- status: in-progress
- epics: []
- goal: The three items Phase 9 carried on its goal line. Two landed, one stays deferred. **Ops runbook** — `docs/runbooks/ops.md`, so the factory can be operated without reading the operator guide end to end. **The background process** (moved from Phase 7, then Phase 9) — shipped as `smith daemon`, and shipped deliberately narrower than the "always-on dispatch daemon" the earlier phases named: it is a *watcher*. It folds the event log on an interval and reports budgets, stale agents, due rechecks and due cadences, so that *knowing* what the factory needs no longer requires an open session; it never dispatches an agent, never enters the merge queue, and never writes outside `state/daemon/` and the derived SQLite read-model. Dispatch stays skill-guided through `/bs` — architecture §12, not a gap. **The Cloudflare port of the UI** (moved from Phase 6, then Phase 9) stays deferred and unspecced: the dashboard is local-only, the two Cloudflare publish commands are deny-listed for agents by `.claude/settings.json`, and no upload path has been designed — this milestone records that it exists and is deferred, not that it is planned in detail.

## envkit — bootstrap
- id: envkit-bootstrap
- status: completed
- project: envkit
- epics: []
- goal: Scaffold landed in workspaces/envkit from docs/standards/stack.md; the first epic is planned and moved to its own milestone below.

## envkit — config loader
- id: envkit-config-loader
- status: completed
- project: envkit
- epics: [envkit-config-loader]
- goal: A zero-dependency .env loader — parse, coerce, validate, one public loadConfig API. PLAN v1 signed off by the operator 2026-08-06 (dogfood-envkit-1#1): six tasks, seven edges, four waves. All six merged through the serial queue to `smith/envkit-config-loader/integration` at 8962df9 — typecheck/test/build green in-session (4 files, 159 tests), lint red only from D-42's nested worktrees. Close-out report: `docs/specs/dogfood-envkit-close.md`. Closed by operator override at `dogfood-envkit-1#69` (`epic-closed`, 2026-08-07) because `smith epic verdict` returns hold/mechanical-blockers under D-28 and cannot see the epic. Ships with one known S2 carried forward — bare CR is not a line separator in src/parse.ts (D-41).

## envkit — mcp surface
- id: envkit-mcp-surface
- status: completed
- project: envkit
- epics: [envkit-mcp-surface]
- goal: Declare and harden the MCP surface — `smith mcp check` green against docs/standards/mcp.md. Required before the final milestone can close. Plan reached v5 through five amendments, every one of them discharging an S2 the closing spec review raised (S1/S2 are unwaivable; `plan amend` is their only exit). Five tasks: redact, path guard, env_lint, env_diff_keys, and the v5 key bound. Assembled at `smith/envkit-mcp-surface/integration` 049765c3 — `integration check` green in-session at `dogfood-mcp-1#383` (lint/typecheck/build exit 0, 281 tests passing), `mcp check` manifest-clean, closing spec review at `dogfood-mcp-1#386`. Closed at `dogfood-mcp-1#403` with verdict `go` and no blockers. Three findings carried forward as granted waivers rather than a sixth amendment: ENV_KEY and ECHOABLE_KEY do not agree and task-4's clause claiming they do is false (integration-97825fcf, S3, latent — no value reaches a client), mcp.manifest.json still describes an unconditional key listing neither tool has given since v4 and stayed at version 0.2.0 across both narrowings (integration-c721a990, S3), and the duplicated ECHOABLE_KEY is graded by nothing but a comment (integration-9b8279e9, S4). All three need a follow-up epic that claims mcp.manifest.json and both tool files. Process defects this run exposed are D-119..D-127 of the dogfood-3 run — notably that an amendment discharges its S2 the instant the plan file is written, and that a task added by an amendment is invisible to `epic verdict`, whose roster here is four tasks, not five.

## envkit — mcp followup
- id: envkit-mcp-followup
- status: planned
- project: envkit
- epics: [envkit-mcp-followup]
- goal: Discharge the three waivers `envkit-mcp-surface` carried forward, on the files that epic could not claim. Three tasks, two edges, one wave each: a shared `src/mcp/keys.ts` that both the redactor and the two tools derive their key shape from, the tools importing it and a pair-level test that grades both surfaces at once, then `mcp.manifest.json` reconciled with the exclusion behaviour it has not described since v4 and bumped 0.2.0 -> 0.3.0 under MCP-P2. The one real fork is recorded in the plan and was decided WIDEN, not narrow: `ENV_KEY` gains the leading digit rather than `ECHOABLE_KEY` losing it, because narrowing the echo bound would make the false comment true while leaving `redactText` blind to `9SECRET=hunter2` for every other caller — `redactError` runs over arbitrary thrown messages, not only .env documents — and redact.ts's docblock already commits to over-redaction as the accepted direction. Null hypotheses re-measured in-session at integration head `049765c` rather than quoted: `redactText('9SECRET=hunter2')` returns its input byte-identical, `grep -rn ECHOABLE src/ test/` returns five hits all in src/ and none in test/, and `smith mcp check envkit` is already ok/violations [] so the manifest task's check is a regression guard. Also the dogfood #4 run: the first epic to exercise the repaired amend-pending gate (D-119, D-121, D-122, D-126, D-127) on an instrument that has been fixed, so a clean run measures the fixes rather than assuming them.

