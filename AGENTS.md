# Black Smith — Agent Router

Autonomous agent factory: a planner on a top-tier model turns goals into spec
contracts; the factory instantiates workers on cheap fast models from
templates; gates (tests → review → adversarial verify → merge queue) decide
what lands. The operator only plans and reviews outcomes.

This repo is self-governing: its rules live here, not in any other repo.

## Read on demand (do not preload)

| Need | Read |
|---|---|
| Install / bootstrap / verify this repo (executable runbook) | `INSTALL.md` |
| Full architecture | `docs/specs/black-smith-architecture.md` |
| Operator interview (Phase 1) | `docs/specs/black-smith-interview.md` |
| Per-agent interviews (constraints per role) | `docs/specs/agent-interviews.md` |
| Stack standard (compiled from interview) | `docs/standards/stack.md` |
| Per-agent constraints (compiled from interview) | `docs/standards/agent-constraints.md` |
| Guardrails: secrets/env, git, deploy (S1 on violation) | `docs/standards/guardrails.md` |
| Policies: taxonomy, budgets, severity, worktree, crosscheck | `factory/policies/` |
| Agent templates | `.claude/agents/` |
| Approved lessons (injected into agents) | `factory/policies/lessons.md` |
| Loop runner + worktree engine (taxonomy/schemas/events/plan/claims/worktree/queue/cli, TS strict + Vitest) | `factory/orchestrator/` |
| Operator console (`/bs new\|plan\|run\|status\|ui\|waivers\|lessons\|report`) | `.claude/skills/bs/SKILL.md` |
| New-project scaffolder (`smith new`) | `factory/scaffold/`, `factory/orchestrator/src/scaffold.ts` |
| Recheck/maintenance/growth scheduler (`smith scheduler run`) | `factory/orchestrator/src/scheduler.ts`, `factory/policies/scheduler.yml` |
| Lessons pipeline (novelty gate, compile, `smith dream`) | `factory/orchestrator/src/lessons.ts` |
| Cross-provider judges (Codex/DeepSeek transports, quorum, shadow-mode calibration; `smith judge run`, `smith stats providers`) | `factory/orchestrator/src/providers/`, `src/quorum.ts`, `src/crosscheck.ts`, `factory/policies/crosscheck.yml`, `docs/runbooks/providers.md` |

## Operating rules

- **Branches.** All work on `smith/<epic>/integration` integration branches
  (git ref constraint: `smith/<epic>` cannot coexist with
  `smith/<epic>/<task-id>`); tasks on `smith/<epic>/<task-id>`. Never push to
  `main`; `main` changes only via a reviewed PR. Never force-push shared
  branches.
- **Worktrees.** Workers operate only inside their assigned worktree
  (`workspaces/.wt/<project>/<task-id>`, a sibling of the project rather than
  a child of it — D-42) and only within their spec's path
  claims. Out-of-claim edits fail the gate.
- **Specs are contracts.** No dispatch without objective, output schema,
  acceptance criteria, tool allowlist, and budget.
- **Declarations vs state.** Committed files are declarations. `state/`,
  `workspaces/`, `.agents/generated/` are runtime output — gitignored, never
  hand-edited, safe to delete.
- **Language.** All artifacts in this repo (docs, code, commits, agent
  prompts) are English.
- **Commits.** Subject ≤72 chars, imperative, why-focused.
- **Human gates.** Lessons compilation, taxonomy changes, budget extensions,
  semantic merge conflicts, and sub-threshold inferred tasks always stop for
  operator approval. Everything else runs autonomously within budget.
