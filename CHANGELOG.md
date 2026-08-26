# Changelog

Blacksmith has **no versioned releases**. It runs from a clone, not from a
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

This repository is the public release of Blacksmith. The work was done in a
private repository and published here as a single initial commit, so the phase
entries below record development that predates this repo's git history rather
than appearing in it.

### Added

- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  a pull-request template, and this changelog.
- A Quickstart in the README, plus a docs index covering
  `docs/standards/mcp.md` and `docs/runbooks/providers.md`.
- `INSTALL.md` — the install detail lifted out of the README as an executable
  runbook, written so a Claude Code session can work through it end to end
  when the operator says *"install Blacksmith"*. `CLAUDE.md` declares it.
- A **Cross-provider checks** section in the README: the four quorum triggers
  and the fact that nothing polls for two of them, the `enabled`/`mode` dials,
  how to read `smith stats providers` before a promotion, why one active
  provider still changes no outcome, and what a judge is shown — a finding's
  claim, never the file contents and never the diff.

### Changed

- Demo project fixtures, screenshots and compiled lessons use neutral names
  (`demo-rpg`, `demo-hub`). Provider credentials are environment-only, named
  in `.env.example` and never committed.
- **Both external judges are now `enabled: true` in `mode: shadow`**, where
  Phase 8 shipped them `enabled: false`. Their verdicts are recorded and gate
  nothing until an operator promotes one to `mode: active`. The practical
  difference: with no credentials configured, each quorum case now records a
  caught transport failure instead of making no call at all, which reads as a
  `transportFailureRate` of 1.0 in `smith stats providers`. `README.md`,
  `INSTALL.md`, `docs/guide/operator-guide.md` and `factory/specs/roadmap.md`
  had all kept describing the old default.
- The product's name is written **Blacksmith**, one word, everywhere it is
  prose — 62 occurrences that read "Black Smith", including the dashboard's
  sidebar and `<title>`, so the committed e2e screenshots regenerated.
  Identifiers deliberately keep their hyphenated slug: the
  `docs/specs/black-smith-*.md` filenames, the `black-smith.dev/schema/*`
  `$id` URIs, `ui/src/assets/brand/black-smith.png`, the `package.json` name,
  and the project slug recorded in existing event logs are paths, contracts or
  data rather than prose.
- The README leads with the mark, a one-line claim and the dashboard
  screenshots; `## Installation` is two bullets — self-install or run the
  runbook yourself — instead of two prose paragraphs. The heading is unchanged
  because `CONTRIBUTING.md` links `README.md#installation`.

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
operator-invoked. Both providers shipped `enabled: false` in this phase;
they are `enabled: true` in `mode: shadow` today — see **Unreleased**, and
`docs/runbooks/providers.md` for the promotion procedure.

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

Running Blacksmith on Blacksmith produced most of what the gates and
policies now enforce. Those defect logs are kept in `docs/specs/`
(`dogfood-4-findings.md`, `dogfood-envkit-findings.md`,
`phase-9-punch-list.md`) and are referenced by id (D-###, P9-##) from commit
messages throughout this history.
