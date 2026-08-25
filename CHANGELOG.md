# Changelog

Black Smith has **no versioned releases**. It runs from a clone, not from a
registry: `package.json` is `version: 0.0.0`, there are no git tags, and the
only supported revision is `main`. So this file is not a list of releases —
it is a list of what landed, in the order it landed, keyed to the milestones
in [`factory/specs/roadmap.md`](factory/specs/roadmap.md).

Dates are the day the roadmap first recorded a milestone as `completed`,
derived from the development history that preceded this repository. They mark
when the phase was declared done, which for the earliest phases is later than
when the work started — development began 2026-08-03.

Format loosely follows [Keep a Changelog](https://keepachangelog.com);
newest first.

## Unreleased

This repository is the public release of Black Smith. The work was done in a
private repository and published here as a single initial commit, so the phase
entries below record development that predates this repo's git history rather
than appearing in it.

### Added

- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  a pull-request template, and this changelog.
- A Quickstart in the README, plus a docs index covering
  `docs/standards/mcp.md` and `docs/runbooks/providers.md`.

### Changed

- Demo project fixtures, screenshots and compiled lessons use neutral names
  (`demo-rpg`, `demo-hub`). Provider credentials are environment-only, named
  in `.env.example` and never committed.

### Known gaps

- `docs/standards/guardrails.md` describes a gitleaks secret-scanning gate on
  every PR. `.github/workflows/ci.yml` does not run one. Treat that line as
  intent, not as an enforced control — see `SECURITY.md`.
- Budget caps in `factory/policies/budgets.yml` are prompt-level and counted
  after the fact; the loop runner does not hard-stop on them.

## Phase 10 — Deployment + ops — planned

Recorded as deferred, not specced: runbooks beyond
`docs/runbooks/providers.md`, the Cloudflare port of the dashboard (local-only
today), and an always-on dispatch daemon (dispatch is still skill-guided
through `/bs`).

## Phase 9 — Hardening — 2026-08-10

- Escalation ladders counted from the event log (`smith escalation check`),
  budget alarms (`smith budget alarm`), and a same-mistake KPI
  (`smith kpi same-mistake`) — three policies that had been prose nothing
  parsed.
- The MCP surface standard: `docs/standards/mcp.md`, `smith mcp init|check`,
  hard-gated at epic close.
- Lesson approve/reject verbs and dispatch-time lesson injection, closing the
  third ungated door into the factory's memory.
- Prompt-injection fencing for ingested text (`smith prompt wrap`), a judge
  worktree-immutability guard (`smith worktree fingerprint|verify`), and
  cross-session event edges.
- Producers for the five task-status events that had none, checks that run at
  the integration root rather than only inside task worktrees, and an epic
  close that is both a logged fact and a folded projection.
- The taxonomy stopped being hand-copied into four files that had all drifted.

P9-1..P9-37, with their close-out and the deliberate leftovers, are in
`docs/specs/phase-9-punch-list.md`.

## Phase 8 — Cross-provider judges — 2026-08-05

Provider adapters (Codex CLI, DeepSeek API), quorum policy, disagreement
analytics, and shadow-mode calibration. All four `crosscheck.yml` quorum
triggers have a host: blocking-finding and same-mistake fire automatically
from the gate; `smith epic verdict` and `smith plan quorum` are
operator-invoked. Both providers ship `enabled: false` — opting in is
documented in `docs/runbooks/providers.md`.

## Phase 7 — Self-extension — 2026-08-05

Inferred tasks with a confidence policy, the scheduler, rechecks, the lessons
compilation loop, and the `/bs` operator skill.

## Phase 6 — UI (HDS) — 2026-08-05

The local dashboard: overview, timeline, and kanban first; lessons, errors,
and analytics second. Built on an in-repo design system with token, emoji,
hardcode, and contrast gates, and a Playwright screenshot suite.

## Phase 5 — State + analytics — 2026-08-04

SQLite projections rebuilt from the append-only event log, the timeline, and
the live agent registry.

## Phase 4 — Gates — 2026-08-04

Test gate, the reviewer/verifier chain, the severity policy, and the waiver
flow.

## Phase 3 — Loop runner + worktree engine — 2026-08-04

Dispatch from task specs, path-claim validation, worktree lifecycle, the
serial merge queue, and the event log everything else is projected from.

## Phase 2 — Skeleton + contracts — 2026-08-04

Repo layout, the spec/result/finding/lesson JSON Schemas, `taxonomy.yml`, and
the agent templates.

## Phase 1 — Interview + standards — 2026-08-04

The operator interview, `docs/standards/stack.md`, the per-agent constraint
blocks, and the pinned scaffold.

## Dogfooding

Running Black Smith on Black Smith produced most of what the gates and
policies now enforce. Those defect logs are kept in `docs/specs/`
(`dogfood-4-findings.md`, `dogfood-envkit-findings.md`,
`phase-9-punch-list.md`) and are referenced by id (D-###, P9-##) from commit
messages throughout this history.
