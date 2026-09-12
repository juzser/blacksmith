# Docs index

Every doc in `docs/` and every policy in `factory/policies/`, one line each.
Read on demand — nothing here is meant to be preloaded (`AGENTS.md`
"progressive disclosure"). The specs directory has its own index,
[`specs/README.md`](specs/README.md), because the files there are not all
the same kind: it says which are contracts, which are scopes, and which are
records of the past that are cited by id and never opened whole.

| Doc | Description | Audience |
|---|---|---|
| [`specs/black-smith-architecture.md`](specs/black-smith-architecture.md) | Full architecture spec (v3, 17 sections): loop, worktrees, cross-check, taxonomy, gates, self-extension, PR flow, stack standard, build order, evidence base | operator, contributor, agent |
| [`specs/black-smith-interview.md`](specs/black-smith-interview.md) | The operator interview: the stack half runs at install time and lands in `factory/policies/stack.yml`; the rest (budgets, severity calibration, gates) compiled into `standards/agent-constraints.md` | operator |
| [`specs/agent-interviews.md`](specs/agent-interviews.md) | Per-agent-role interview; answers compile into `standards/agent-constraints.md` and, from Phase 2, into `.claude/agents/`. Cited by id — start from the index below | operator, contributor |
| [`specs/agent-interviews-index.md`](specs/agent-interviews-index.md) | One row per interview id (`P-1`..`N-12`): the lines it spans, the heading it sits under, one clause on what it decided, and the two ids both called `M-1` | operator, contributor, agent |
| [`specs/phase-10-scope.md`](specs/phase-10-scope.md) | Phase 10 as measured rather than as declared: the six defects (P10-1..P10-6) found by pointing the factory at itself, the four forks and their answers, and the close-out of the epic that fixed them | operator, contributor |
| [`specs/audit-command-scope.md`](specs/audit-command-scope.md) | The `/bs audit` contract: four fixed read-only axes, what "writes nothing to the project" means when `.blacksmith/` is state, why consolidation clusters rather than merges, the hard stop, the append-only findings store with 90-day declines, and the seven `smith audit` verbs | operator, contributor, agent |
| [`specs/README.md`](specs/README.md) | Every file under `specs/` by kind — contract, scope, or record of the past — with the cite-by-id recipe for the records, so nobody opens a 782 kB file to check one finding | operator, contributor, agent |
| [`standards/stack.md`](standards/stack.md) | What the install interview's stack answers mean, who reads each one, and which the shipped templates honour, record, or refuse — the answers themselves live in `factory/policies/stack.yml` | operator, contributor |
| [`standards/agent-constraints.md`](standards/agent-constraints.md) | Per-agent constraint blocks (TDD strictness, coverage floor, severity calibration, budgets, context-window compaction) — source of truth until fully baked into templates | contributor, agent |
| [`standards/guardrails.md`](standards/guardrails.md) | Hard rules the factory enforces mechanically (secrets, git actions, filesystem, deploy/outbound, CI) — violations are S1 unless stated otherwise | operator, contributor, agent |
| [`standards/mcp.md`](standards/mcp.md) | The MCP surface every shipped project must declare — stdio by default, read-only tools by default, hard-gated at epic close; rule ids MCP-P1, MCP-T4, … are the contract | operator, contributor, agent |
| [`guide/operator-loop.md`](guide/operator-loop.md) | The six steps of the operator loop, in the order you meet them: plan, sign off, run, waivers, review the PR, lessons — with the S1–S4 severity contract, and the two forms of step 0 (`/bs new` for a project that does not exist, `/bs audit` for one that does) | operator |
| [`guide/operator-guide.md`](guide/operator-guide.md) | Deep operator walkthrough: real `smith` commands end to end, gate outcomes, severity/waiver semantics, budget escalation ladder, lesson approval, current limitations | operator |
| [`guide/dashboard.md`](guide/dashboard.md) | Dashboard tour: the eleven pages and what each answers, how to serve it, why the screenshots are committed e2e fixtures, rebuilding the projection | operator |
| [`guide/status.md`](guide/status.md) | What is built vs. planned, phase by phase, and the four caveats that matter before you rely on it (the daemon watches but never dispatches, operator-invoked checks, shadow judges, admission-time budget caps) | operator |
| [`guide/extending.md`](guide/extending.md) | Contributor guide: add an agent template, change the taxonomy, add a policy, docs-mirror invariants, event-log vs projections, test conventions | contributor |
| [`runbooks/ops.md`](runbooks/ops.md) | Phase 10 background watcher: what `smith daemon` does and refuses to do, the four verbs, finding kinds, its lock/status/log files, launchd + systemd + cron recipes, the exit-1 health check, state backup | operator |
| [`runbooks/providers.md`](runbooks/providers.md) | Phase 8 cross-provider judges: Codex/DeepSeek key + auth setup, enabling, shadow-mode calibration procedure, promotion, rollback, cost, security | operator |

## `factory/policies/` (machine-read at runtime)

| File | Description | Audience |
|---|---|---|
| [`../factory/policies/taxonomy.yml`](../factory/policies/taxonomy.yml) | Closed, versioned, multi-dimension controlled vocabulary; mirrors architecture §8 value-for-value | contributor, agent |
| [`../factory/policies/budgets.yml`](../factory/policies/budgets.yml) | Token/turn caps per tier, escalation ladder, effort-scaling rules, context-window compaction | operator, contributor |
| [`../factory/policies/severity.yml`](../factory/policies/severity.yml) | S1–S4 gate rules: what each severity does at the gate (blocks, bounces, waivers, logs) | operator, contributor |
| [`../factory/policies/worktree.yml`](../factory/policies/worktree.yml) | Path-claim + merge-queue policy: worktree/branch patterns, serialize-always globs, conflict-resolution ladder | contributor, agent |
| [`../factory/policies/crosscheck.yml`](../factory/policies/crosscheck.yml) | Multi-provider cross-check policy: quorum triggers, plan quorum, asymmetric finder/critic roles, per-provider transport (`cli`/`api`) + shadow/active `mode`, the independent finder and its `send_diff` lock (Phase 8, `docs/runbooks/providers.md`) | operator, contributor, agent |
| [`../factory/policies/lessons.md`](../factory/policies/lessons.md) | Generated, committed: compiled approved lessons, sectioned by scope, injected step-wise into agent dispatch | operator, agent |
| [`../factory/policies/scheduler.yml`](../factory/policies/scheduler.yml) | Phase 7: recheck thresholds, maintenance-pass confidence, growth-review cadence, lessons novelty-gate threshold | operator, contributor |
| [`../factory/policies/effort.yml`](../factory/policies/effort.yml) | Effort tiers (`small`/`medium`/`huge`) per epic: how many judgment steps an epic buys, and the invariants a tier may never scale away | operator, contributor |
| [`../factory/policies/sensitive-paths.yml`](../factory/policies/sensitive-paths.yml) | The claim globs that trigger a security-reviewer dispatch, so the decision is declared once rather than made fresh per task | contributor, agent |

## Repository-level docs (outside `docs/`)

| File | Description | Audience |
|---|---|---|
| [`../README.md`](../README.md) | The landing page: why it exists, the features with screenshots, install (clone or npm), and the `/bs` commands — everything past that is a link, because details that live in two files drift | everyone |
| [`../INSTALL.md`](../INSTALL.md) | Executable install runbook: requirements, per-platform setup, verification, optional extras, troubleshooting, known platform gaps — written so a Claude Code session can run it end to end | operator, contributor, agent |
| [`../AGENTS.md`](../AGENTS.md) | The router and operating rules agents read first | agent |
| [`../CLAUDE.md`](../CLAUDE.md) | Claude Code entry point: routes to `AGENTS.md` for rules and to `INSTALL.md` for the self-install runbook — declares nothing of its own | agent |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | How a human contributes: the gate to run, where each kind of change goes, commit and PR conventions | contributor |
| [`../SECURITY.md`](../SECURITY.md) | How to report a vulnerability privately, what is in and out of scope, and the known gaps | everyone |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Contributor Covenant v2.1 and how to report a concern | everyone |
| [`../CHANGELOG.md`](../CHANGELOG.md) | What landed, by milestone — the CLI is versioned on npm as `@juzser/blacksmith`, the factory itself is not | everyone |
| [`../ui/docs/design-spec.md`](../ui/docs/design-spec.md) | The dashboard's design spec; lives under `ui/`, not `docs/`, because the design gates read it from there | contributor |
