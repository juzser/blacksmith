# Blacksmith — Agent Router

Autonomous agent factory: a planner on a top-tier model turns goals into spec
contracts; the factory instantiates workers on cheap fast models from
templates; gates (tests → review → adversarial verify → merge queue) decide
what lands. The operator only plans and reviews outcomes.

This repo is self-governing: its rules live here, not in any other repo.

## Read on demand (do not preload)

| Need | Read |
|---|---|
| Install / bootstrap / verify this repo (executable runbook) | `INSTALL.md` |
| Architecture — 17 numbered sections, 78 kB: read only the `§` a cite names (`grep -n '^## ' docs/specs/black-smith-architecture.md` is the map), never the whole file | `docs/specs/black-smith-architecture.md` |
| Operator interview (Phase 1) | `docs/specs/black-smith-interview.md` |
| Per-agent interviews (constraints per role) — cited by id (`N-9`, `M-6`); the ids are bold leads, not headings, so start from the index, which maps each id to its lines and heading: read the id's paragraph, not the file | `docs/specs/agent-interviews-index.md`, then `docs/specs/agent-interviews.md` |
| This operator's stack answers (install interview) | `factory/policies/stack.yml` |
| What reads those answers, and what the templates honour | `docs/standards/stack.md` |
| Per-agent constraints (compiled from interview) | `docs/standards/agent-constraints.md` |
| Guardrails: secrets/env, git, deploy (S1 on violation) | `docs/standards/guardrails.md` |
| Policies: taxonomy, budgets, severity, worktree, crosscheck | `factory/policies/` |
| Agent templates | `.claude/agents/` |
| Approved lessons (injected into agents) | `factory/policies/lessons.md` |
| Loop runner + worktree engine (taxonomy/schemas/events/plan/claims/worktree/queue/cli, TS strict + Vitest) | `factory/orchestrator/` |
| Operator console (`/bs new\|mcp\|plan\|run\|audit\|status\|ui\|waivers\|lessons\|report`) — the router; one playbook per verb beside it | `.claude/skills/bs/SKILL.md` |
| The dispatch contract every `/bs` playbook dispatches under | `.claude/skills/bs/dispatch.md` |
| `/bs run` — the epic tier (`run.md`) and steps 2-10, one wave, thrown away when it lands (`wave.md`) | `.claude/skills/bs/run.md`, `.claude/skills/bs/wave.md` |
| Operator guide — the index only; the guide is one file per question under `docs/guide/operator-guide/`, and its `§` numbers are guide-wide, so read the part a cite names | `docs/guide/operator-guide.md` |
| New-project scaffolder (`smith new`) | `factory/scaffold/`, `factory/orchestrator/src/scaffold.ts` |
| Recheck/maintenance/growth scheduler (`smith scheduler run`) | `factory/orchestrator/src/scheduler.ts`, `factory/policies/scheduler.yml` |
| Lessons pipeline (novelty gate, compile, `smith dream`) | `factory/orchestrator/src/lessons.ts` |
| Cross-provider judges (Codex/DeepSeek transports, quorum, shadow-mode calibration; `smith judge preflight`, `smith judge run`, `smith stats providers`) | `factory/orchestrator/src/providers/`, `src/quorum.ts`, `src/crosscheck.ts`, `factory/policies/crosscheck.yml`, `docs/runbooks/providers.md` |
| Who may dispatch, and what they owe for it (`smith delegation check`) | `factory/policies/delegation.yml`, `factory/orchestrator/src/delegation.ts` |
| Background watcher (`smith daemon run\|start\|status\|stop`) — folds the log on an interval, never dispatches | `factory/orchestrator/src/daemon.ts`, `docs/runbooks/ops.md` |
| Which spec is a contract, a scope, or a record of the past — the records (`D-nnn`, `P9-n`, `FD-n`) are cited by id and never loaded whole | `docs/specs/README.md` |
| Everything else under `docs/` and `factory/policies/` — one line per file, with who it is for | `docs/README.md` |

## Operating rules

- **Branches.** All work on `smith/<epic>/integration` integration branches
  (git ref constraint: `smith/<epic>` cannot coexist with
  `smith/<epic>/<task-id>`); tasks on `smith/<epic>/<task-id>`. Never push to
  `main`; `main` changes only via a reviewed PR. Never force-push at all — a
  branch you have pushed is append-only, and republishing rewritten history
  is the operator's call, not an agent's.
- **Worktrees.** Workers operate only inside their assigned worktree, and
  only within their spec's path claims; out-of-claim edits fail the gate. A
  worktree is a sibling of the project directory rather than a child of it
  (D-42), so it follows the project wherever that directory is: the shape is
  always `<project-parent>/.wt/<project>/<task-id>`, which for a project
  beside this repo — where `smith new` puts one — is outside this repo too.
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
