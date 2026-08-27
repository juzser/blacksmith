# Blacksmith — Autonomous Agent Factory Architecture

> Status: DRAFT v3 — architecture spec for the standalone repo `black-smith`.
> Owner: Ser. Orchestration design derived from the dotagents ecosystem survey
> (bgreenwell/getsentry/iannuttall/aj47 conventions, AGENTS.md standard, Claude
> Code subagent format), Anthropic's published agent-engineering practices
> (§15), Hans operating experience, and the Apr–Aug 2026 research window
> (evidence base in §17).
>
> v3 changes (research-driven, 2026-08-03): immutable plan versions with an
> escalation ladder replace free-form graph rewriting; claims computed from
> static analysis with hub-file serialization; dependency edges as first-class
> events; spec-review stage before decomposition; grader loop; cumulative
> regression gate + living spec doc per epic; kill-rate-scored asymmetric
> cross-check; typed principle-level lessons with a novelty gate; taxonomy
> rebuilt as a multi-dimension controlled vocabulary (§8).
>
> Resolved decisions: repo name `black-smith`; runtime on Claude Code native
> machinery first (Agent SDK migration possible later); UI local-first, deployed
> to Cloudflare later; multi-provider cross-check (Codex, DeepSeek, …) planned
> as a first-class judge-tier capability (§6).

## 1. Purpose and operating model

Blacksmith is a factory that develops tools and projects autonomously. The
human's role is reduced to two touchpoints:

1. **Planning** — co-plan with the main planner agent until a spec is approved.
2. **Outcome review** — review PRs (with screenshots), approve/reject lessons,
   and answer severity-waiver questions.

Everything between those touchpoints — research, task decomposition, coding,
testing, review, merging into an integration branch, logging, analytics — runs
without human intervention, inside enforced budgets and gates.

### Design principles

- **Intelligence lives in the spec, not the worker.** Top-tier models
  (Fable/Opus) do planning and spec-writing; cheap fast models (Haiku/Sonnet)
  execute against contracts. A tighter spec buys a smaller worker model.
- **Specs are contracts.** Every dispatch carries input, output schema,
  acceptance criteria, tool allowlist, and budget. Schema violations retry
  mechanically without planner involvement.
- **Unlimited kinds, unlimited concurrency, bounded cost.** The factory can
  instantiate any number of agent *types* at runtime from templates, and any
  number of live instances of each type. Live parallelism is bounded by the
  path-claim graph, not by a worker count; what policy caps is per-run token
  totals, so cost stays bounded however wide the fan-out goes.
- **Everything observable.** Every prompt, dispatch decision, error, and state
  transition is an event in an append-only log that the UI renders.
- **Mistakes are made once.** Errors become lesson candidates; approved lessons
  are compiled back into agent templates and review checklists.
- **No single point of view on critical judgments.** The judge tier is
  provider-agnostic by contract, so verdicts that matter can be cross-checked
  by non-Claude models (anti tunnel vision, §6).
- **One stack, every project.** New target repos are scaffolded from a single
  operator-approved stack standard (§14); deviations need a planner-written
  justification.

## 2. Repository layout

```
black-smith/
├── AGENTS.md                     # thin router (progressive disclosure)
├── .agents/
│   ├── templates/                # agent templates, one .md each (committed)
│   │   ├── planner.md            #   fable/opus — plan, spec, verdict
│   │   ├── researcher.md         #   sonnet — targeted research briefs
│   │   ├── coder.md              #   sonnet — TDD implementation in a worktree
│   │   ├── tester.md             #   sonnet — test authoring + e2e/screenshot
│   │   ├── grader.md             #   sonnet — rubric loop on worker output
│   │   ├── spec-reviewer.md      #   judge — spec deficiency hunt (≠ planner model)
│   │   ├── reviewer.md           #   sonnet — fresh-context diff review
│   │   ├── verifier.md           #   sonnet — adversarial claim verification
│   │   ├── security-reviewer.md  #   sonnet — deep security review (conditional dispatch)
│   │   ├── merger.md             #   sonnet — merge-queue conflict resolution
│   │   ├── scribe.md             #   haiku — logs, summaries, PR bodies
│   │   └── uiux.md               #   sonnet — HDS spec before UI features
│   ├── generated/                # runtime-instantiated agents (gitignored)
│   ├── skills/                   # shared skills (SKILL.md dirs), reserved for
│   │                              #   non-Claude-Code-native shared instructions
│   └── settings/                 # MCP servers, model presets, permissions
├── .claude/
│   └── skills/bs/SKILL.md        # the /bs operator console (Phase 7) — Claude
│                                  #   Code's own skill-discovery convention
├── factory/
│   ├── orchestrator/             # loop runner (dispatch, gates, merge queue)
│   │   └── providers/            # judge-tier adapters: claude, codex, deepseek (§6)
│   ├── scaffold/                 # new-project repo template (stack standard, §14)
│   ├── specs/
│   │   ├── schema/               # JSON Schemas: spec, result, finding, lesson
│   │   ├── active/               # live spec instances per epic/task
│   │   └── roadmap.md            # milestones → epics map, planner-maintained (§12)
│   ├── scheduler/                # recheck + dynamic-research scheduling
│   └── policies/
│       ├── taxonomy.yml          # controlled vocabulary (§8)
│       ├── budgets.yml           # token/turn caps per tier (§2, §4)
│       ├── severity.yml          # gate rules per severity (§11)
│       ├── worktree.yml          # path-claim + merge-queue policy (§5)
│       ├── crosscheck.yml        # multi-provider quorum policy (§6)
│       └── lessons.md            # compiled approved lessons (generated, committed)
├── state/                        # runtime state (gitignored)
│   ├── smith.db                  # SQLite — sessions, tasks, events, lessons
│   └── events/*.jsonl            # append-only event log (source of truth)
├── ui/                           # HDS dashboard (§10)
├── workspaces/                   # target-repo clones + worktrees (gitignored)
└── docs/
    └── standards/
        ├── stack.md              # unified stack standard (generated from interview)
        └── interview.md          # operator interview → constraints per agent (§14)
```

Target projects live under `workspaces/<project>/` as clones of their own
repos; Blacksmith never develops inside its own repo tree. Committed files
are declarations; everything generated at runtime is gitignored (dotagents
convention: tool-native/generated dirs are build outputs).

### Agent template format

Claude Code subagent format — YAML frontmatter + body-as-system-prompt:

```yaml
---
name: coder
description: Implements one task spec TDD-first inside an assigned worktree.
model: sonnet            # planner: fable|opus; scribe: haiku
tools: Read, Edit, Write, Bash, Grep, Glob
maxTurns: 40
---
<system prompt: role, contract rules, lessons digest injection point>
```

The **factory instantiates** concrete agents by merging a template with a spec:
it writes `.agents/generated/<task-id>.md` (template + task-scoped context +
narrowed tool list + output schema) and dispatches it. Templates are the only
hand-maintained agent files; there is no fixed roster limit.

## 3. The loop

```
user prompt ──► PLANNER (fable/opus) — drafts epic spec + acceptance criteria
                  │
              SPEC REVIEW (different model): hunt spec deficiencies —
                  │  omissions, ambiguities, implicit security/validation
                  │  planner fixes → operator signs off → PLAN v1 (immutable)
                  ▼
              BACKLOG (kanban: todo → ready)
                  │  scheduler admits a WAVE of ready tasks
                  │  (claims disjoint per static analysis, deps met)
                  ▼
              FACTORY: instantiate agents from templates ── fan-out
                  │  researcher / uiux (pre-code) → coder+tester (worktree)
                  ▼
              GRADER: rubric loop on worker output (bounded rounds)
                  ▼
              GATES: schema check → commit check → cumulative tests
                  │  → reviewer (+uiux on UI)
                  │  → verifier  (mechanical oracles first; cross-provider
                  │     second opinion per crosscheck.yml)
                  │  pass → merge queue (dependency order) → integration branch
                  │  fail S1/S2 → back to coder (same branch, bounded retries)
                  │  fail S3 → waiver batch to user; S4 → logged, never asked
                  ▼
              PLANNER verdict on epic acceptance criteria
                  │  gaps found → PLAN v(n+1): a NEW immutable plan version
                  │  with inferred tasks (§12) — never mutation of the live one
                  ▼
              Integration PR to target repo main + screenshots → USER reviews
```

Termination per epic: acceptance criteria pass, budget exhausted, or K=2
consecutive rounds with no new progress (dry counter) → escalate to user.
Recovery follows a strict escalation ladder — retry → alternate approach →
new plan version → operator — never unbounded replanning loops (§12).

## 4. Model tiering

| Tier | Agents | Model | Rationale |
|---|---|---|---|
| Plan/verdict | planner | fable / opus | deepest reasoning; writes the contracts |
| Build | coder, tester, researcher, uiux, merger | sonnet | code-capable, cheap enough to fan out |
| Judge | reviewer, verifier, grader, spec-reviewer, security-reviewer | sonnet (effort high) + cross-provider (§6) | independence matters more than size; spec-reviewer never runs on the planner's model; security-reviewer dispatches conditionally (§11) |
| Mechanical | scribe, log summarizer | haiku | format/extract/summarize only |

Model is set in template frontmatter; the factory may override per-dispatch
(e.g. escalate a coder to opus after two failed rounds on the same task —
"escalation ladder" policy in `budgets.yml`).

## 5. Worktree partitioning (no overlap, no conflicts)

The core rule: **conflicts are prevented at planning time, not resolved at
merge time.**

1. **Path claims — computed, not guessed.** Every task spec declares
   `claims:` — a list of file globs it may touch. The planner does not assign
   claims from epic text alone: before decomposition the factory runs cheap
   **static analysis** on the target repo (import/dependency graph), and the
   planner partitions along low-cohesion cut lines (community detection over
   the dependency graph — the empirically winning granularity, §17: Co-Coder).
   **Hub files** (structurally central: types, config, shared fixtures) are
   never split across concurrent tasks — they become serialization points
   (single owner or merge-queue-regenerated). The factory validates that
   concurrently scheduled tasks have **disjoint claim sets**; overlapping
   tasks get a dependency edge and run serially instead. Claims are enforced
   at runtime: a post-run check diffs the worktree against its claims;
   out-of-claim edits fail the gate (error `contract.claim-violation`) and
   bounce back to the coder.
2. **One worktree per task.** `workspaces/.wt/<project>/<task-id>/` on branch
   `smith/<epic>/<task-id>`, created fresh from the integration branch head
   (git ref constraint: `smith/<epic>` cannot coexist with
   `smith/<epic>/<task-id>` — see point 3), deleted after merge. Nothing
   long-lived; a stale worktree is a bug. The worktree is a **sibling** of the
   project, not a child of it: a worktree is a full checkout carrying the
   project's own tool config, and inside the root that is an extra root config
   for every tool that walks down from it (D-42 — six worktrees turned the
   epic's `pnpm lint` red at the integration root while all six per-task lint
   gates were green, because from inside a worktree the siblings are not
   descendants).
3. **Integration branch per epic.** `smith/<epic>/integration` in the target
   repo (git ref constraint: `smith/<epic>` cannot coexist with
   `smith/<epic>/<task-id>`, so the integration branch is a sibling under the
   epic's ref prefix, not a leaf at `smith/<epic>` itself). Workers never
   touch `main`.
4. **Merge queue, serial.** Completed tasks merge into `smith/<epic>/integration` one at a
   time: rebase onto current head → run test gate → merge. If rebase conflicts
   (possible when a claim was serialized but files drifted): (a) automatic
   rebase attempt, which `git rebase --abort`s on conflict rather than leaving
   the worktree half-rebased; (b) dispatch `merger` into **that task's
   existing worktree** with both diffs + specs, claims scoped to the
   conflicted-file list the step reported — the merger replays the rebase to
   recreate the conflict, resolves, `git rebase --continue`s and returns
   **without landing anything**, so the task re-enters this same queue and the
   queue performs the only merge; (c) if merger's confidence is low or both
   sides changed the same logic → it aborts and escalates to the user with a
   side-by-side. Never auto-resolve semantic conflicts silently.
5. **Shared-file hotspots** (lockfiles, generated bundles, route registries):
   listed in `worktree.yml` as `serialize-always` globs — any task touching
   them is never scheduled concurrently with another such task; regenerable
   files (lockfiles) are instead regenerated at merge time by the queue, not
   edited by workers.

## 6. Multi-provider cross-check (anti tunnel vision)

Same-model review inherits the generator's blind spots. The judge tier is
therefore **provider-agnostic by contract**: reviewer/verifier are defined by
their I/O contract (input: diff + spec + prior findings; output: findings
JSON per schema), so any model that can honor the contract can serve.

- **Adapter layer** `factory/orchestrator/providers/`: `claude` (native,
  phase 1), `codex` (CLI/API), `deepseek` (API), extensible. Adapters
  normalize output to the findings schema; a schema-validating shim retries or
  rejects malformed responses. All external calls go through the same event
  log and budget accounting as native dispatches.
- **Cross-check policy** (`crosscheck.yml`) — when a second opinion fires:
  - any S1/S2 finding before it blocks a task (a false blocker is expensive);
  - planner verdicts below a confidence threshold;
  - epic-level final verdict before the integration PR opens;
  - `same-mistake` findings (highest-value place to remove bias).
- **Asymmetric roles, kill mandate.** The finder and the critic are always
  **different models**; the critic's mandate is to *refute* the finding, not
  confirm it (adversarial stage-gating kills ~80% of candidate findings
  before they cost a round-trip — §17: Refute-or-Promote). Reviewer quality
  is tracked as **kill-rate** (findings that survive adversarial review and
  land as fixes), not findings volume.
- **Mechanical oracles before model judgment.** Wherever a deterministic
  check exists (schema validation, mutation testing, coverage, type checks),
  it runs first and its verdict is final — LLM judgment is reserved for what
  machines can't decide.
- **Plan quorum.** One planner writes — several models critique. Beyond the
  spec-review stage, an epic plan that crosses a risk threshold (budget ≥ 50%
  of the per-epic cap, `case: infra`, security-sensitive tag, or a
  low-confidence planner verdict) gets critiqued by judges on two different
  providers before operator sign-off; disagreement surfaces both rationales.
  Committee-written plans stay prohibited — writes are single-threaded.
- **Diversity quorum.** Critical verdicts need 2-of-3 agreement across **at
  least two providers**. Disagreement → a third provider breaks the tie, or
  the case escalates to the operator with both rationales side by side.
- **Fix uptake is verified.** A confirmed finding is closed only when the fix
  *lands and re-passes the gate* (`finding_status: fix-verified`), never when
  the review merely fired — review precision without uptake is theater.
- **Phasing.** Phase 1 ships Claude-only judges (verifier already adversarial
  to the reviewer — cross-*session* diversity). The provider seam exists from
  day one so adding Codex/DeepSeek is config + adapter, not a redesign.
- **Trust boundary.** External providers judge; they never gain write access
  to worktrees or the factory. Their findings are data, not commands.
- **Phase 8 (built): transport + shadow mode.** `factory/orchestrator/src/
  providers/` implements the adapter layer — Codex over a CLI transport
  (`codex exec` headless, ChatGPT-subscription auth) and DeepSeek over an
  OpenAI-compatible API transport, both schema-validating + one-retry
  disciplined (`crosscheck.yml`'s `transport: cli|api` field selects which).
  Every provider additionally carries `mode: shadow|active`: `shadow`
  verdicts are recorded (`judge-verdict` events, `smith stats providers`)
  but have **zero gating power** — `src/quorum.ts`'s `computeQuorum()` falls
  back to the native verdict alone whenever no provider in a case is
  `active`. Promoting a provider is an operator edit of `crosscheck.yml`
  (`mode: active`), never a runtime write; calibration procedure and
  rollback: `docs/runbooks/providers.md`.

## 7. Session management + live analytics

Two storage layers, one source of truth:

- **`state/events/*.jsonl`** — append-only event log (NDJSON). Every record:
  `{ts, session_id, actor, event_type, task_id?, agent_id?, plan_version,
  causal_parent, payload, project?}`. The `causal_parent` chain + `plan_version` mean
  any failure renders as a **path through the task graph**, not grep
  archaeology. Durability invariant: **any component can crash and be
  reconstructed from the log alone** — the log is the factory's durable
  execution substrate.
  **Cross-session edges** (P9-7): a `session-start` may name a `causal_parent`
  in *another* session's log, which is what makes one epic across several
  operator sessions expressible — the real ceiling on epic size is the
  orchestrator's context window, since fan-out has no concurrency cap. The
  edge is allowed **only** on the session root: one entry edge per session
  keeps the log a tree of sessions, so "where did this session come from" is
  answered by one event and the lineage walk terminates. Every other event
  chains within its own session, as before.
  **`project`** (Phase 6b, multi-project hub): optional, a **plain string
  identifier — NOT a closed §8 taxonomy vocabulary value**. Projects are
  opened/closed by the operator far more often than any taxonomy dimension,
  so gating a new project behind a taxonomy-version PR would defeat the
  point of a hub that spans several. Absent on every event logged before
  Phase 6b and on any event that omits it going forward; `db/queries.ts`'s
  read helpers treat an absent/null `project` as the default project
  `'black-smith'`, never the event writer (`events.ts` persists exactly
  what it's given).
- **`task_id` is `<epic>/<task>`, and the epic is a field, not a parse**
  (D-49/P9-10). The plan mints qualified ids and `smith/<epic>/<task>` branch
  names are cut from them, so a qualified id *is* an epic assertion. But an id
  with no `/` names no epic at all: `taskId.ts` answers `null` for it rather
  than the whole string, and `requireEpicOfTaskId` throws
  `task-id.unqualified` where an epic is about to become durable (a finding's
  `epic_id`, a follow-up's `<epic>/followup-<fp>` id). Findings therefore
  **carry** `epic_id` (`finding.schema.json`, optional — records raised before
  the field existed have only the prefix) and the projector folds it onto every
  task row. Bare ids in older logs are normalised at the projector boundary,
  once, before any row exists: a bare id exactly one epic claims folds into the
  qualified row; one that two epics claim is left alone as its own row, because
  a visible ambiguity beats a confident wrong merge.
- **Dependency edges are first-class events.** "Task T consumed artifact A
  produced by task S" is recorded as an `edge-recorded` event with an
  `edge_type` and `edge_provenance` tag (§8). Dependency structure — not
  trace length — is the signal that predicts run failure and localizes
  faults (§17: GRADE), so it must be captured at write time, not
  reconstructed later.
- **`state/smith.db`** (SQLite) — projections rebuilt from events for fast UI
  queries: `sessions`, `prompts`, `dispatches`, `agents`, `tasks`, `edges`,
  `errors`, `lessons`, `reviews`, `waivers`, `artifacts`, `milestones`.
- **One stream, all consumers.** UI, CLI, and API tail the same event stream
  (`GET /runs/:id/events?follow=1` wire pattern); nothing renders from a
  side channel.

Tracked live per session: active agent count (by role/model/provider), queued
vs running vs done, token spend vs budget, current epic phase. The UI overview
answers at a glance: *what is running right now, on which model, on whose
budget, and why was it dispatched.*

### Prompt + decision timeline

Two event types render interleaved on one timeline (a hard requirement):

- `user_prompt` — the operator's message, stored **verbatim**.
- `dispatch_decision` — every orchestrator dispatch:
  `{agent_role, model, provider, task_id, spec_ref, reason (one sentence),
  parent_prompt_id}`.

Each dispatch links back to the prompt that ultimately caused it, so the
timeline reads: *you said X → planner decided Y → spawned coder-142 because Z*.
Errors and gate results attach to the same timeline.

`dispatch_decision`'s terminal counterpart (Phase 5 addition, factory/
orchestrator/src/db/projector.ts): `task-result-recorded`, emitted once a
worker's Result passes schema validation, payload = the full Result object
(result.schema.json's shape — `task_id`, `run_status`, `token_usage`,
`agent`, `provider`, `model_tier`, `artifacts`, …). An agent is live between
its `dispatch_decision` and whichever comes first of `task-result-recorded`
or an `error-logged` naming the same `task_id` (agents-registry.ts). No
taxonomy.yml change was needed — like `dispatch_decision` and `user_prompt`
above, `event_type` is a free string in event.schema.json, not a closed
§8 vocabulary value.

Phase 6a addition (same free-string precedent): `lesson-edited`, written
immediately before a `lesson-status-changed` to `approved` (§10's Lessons page —
"the edit is folded into a single 'Save & approve' commit"). Payload carries
only the fields the operator changed (`lesson_id` plus any of
`statement`/`lesson_type`/`lesson_scope`); `db/projector.ts`'s `foldLessons()`
merges them onto the existing candidate row. Both events come from
`lessons.ts`'s `transitionLesson()` — the CLI's `lessons approve|reject` and
`ui/server`'s three lesson routes are two front doors onto one gate (P9-36);
neither hand-assembles the envelope.

Phase 8 addition (same free-string precedent): `judge-verdict`, appended by
`src/quorum.ts`'s `recordJudgeRun()` immediately after each cross-provider
judge run's own `dispatch_decision` (its `causal_parent`) — one per external
judge invocation, whether it succeeded or failed after its transport's one
retry. Payload: `task_id`, `finding_id?`, `agent`/`provider`/`model_tier`
(taxonomy-validated — `events.ts`'s `PAYLOAD_DIMENSION_MAP`, mirroring
`dispatch_decision`'s own entry), `kind`, `mode` (`shadow`/`active`, this
provider's crosscheck.yml setting at run time), `ok`, `verdict`
(`confirm`/`refute`, null on failure), `rationale`, `native_verdict`,
`agreement_with_native`, `schema_failure`, `error_code` (the provider error
code on a failed run, `null` on a run that reached a verdict — D-253:
`schema_failure` alone cannot tell a rejected answer from a request that was
never sent, and the two name different repairs), `latency_ms`. `db/queries.ts`'s
`providerAgreement()` reads these straight off `events_raw` (no dedicated
projection table — the same pattern `analytics()` already uses for
`task-result-recorded`).

Phase 9 addition (same free-string precedent): `judge-reported`, appended by
`src/judges.ts`'s `recordJudgeReport()` — the terminal counterpart of a judge's
own `dispatch_decision`, one per judge per round. A judge dispatch declares the
file it will write (`declared_artifact` on the `dispatch_decision` payload);
the report proves that file landed, parsed, and is a list. Payload: `task_id`,
`agent_role`, `round`, `artifact_path` (null when the report is an
operator attestation), `finding_count`, `attested_by`. The pair is what makes
a silent judge visible: `foldJudgeTurns()` walks the log twice — dispatches
first, then reports — and `outstandingJudges()` is the set difference. `gate
run` refuses to score a task whose difference is non-empty
(`reason: judges-outstanding`), so an agent that ended its turn on an
announcement can no longer be read as zero findings. Tasks that never used
`judge dispatch` declare nothing, so the check is a no-op for them.

## 8. Taxonomy (`factory/policies/taxonomy.yml`)

Closed, versioned, multi-dimension controlled vocabulary. Every event, task,
error, finding, and lesson carries tags from these dimensions; the event
logger **rejects unknown tags at write time** so analytics stay aggregatable
across months of runs. Changing the taxonomy is a PR that bumps `version` —
never a runtime write. Analytics may group only by taxonomy dimensions.

```yaml
version: 7

# ── Work classification ─────────────────────────────────────────────
case:      [feature, bugfix, refactor, research, spec-review, recheck,
            chore, infra]
origin:    [user, inferred, recheck, lesson, escalation]
            # user      — operator asked for it
            # inferred  — planner added it to protect acceptance criteria
            # recheck   — scheduler re-opened a completed feature
            # lesson    — an approved lesson demanded follow-up work
            # escalation— created by the escalation ladder (e.g. re-scope)

# ── Actors ──────────────────────────────────────────────────────────
agent:     [planner, spec-reviewer, researcher, coder, tester, grader,
            reviewer, verifier, security-reviewer, merger, scribe, uiux]
provider:  [claude, codex, deepseek]
model_tier: [frontier, mid, small]        # fable/opus · sonnet · haiku

# ── Lifecycle (three distinct state machines — never conflated) ─────
task_status: [todo, ready, in-progress, grading, reviewing, merging,
              blocked, completed, waived, failed, escalated, superseded]
              # superseded — replaced by a task in a newer plan version
plan_status: [draft, in-review, active, superseded]   # plans are immutable
run_status:  [queued, running, done, dead]            # one worker run

# ── Graph (event-log first-class, §7) ───────────────────────────────
edge_type:       [artifact, claim-order, spec-clause, regression-test,
                  research-brief]
                  # artifact       — T consumes an output S produced
                  # claim-order    — serialized because claims overlapped
                  # spec-clause    — T implements a specific spec clause
                  # regression-test— T must keep S's tests green
                  # research-brief — T depends on a researcher brief
edge_provenance: [observed, declared, inferred]
                  # observed — runner saw the handoff happen
                  # declared — spec stated it up front
                  # inferred — reconstructed after the fact (lowest trust)
graph_event:     [plan-version-created, plan-version-superseded,
                  task-added, task-split, task-superseded, edge-recorded,
                  wave-admitted, wave-merged,
                  spec-change-proposed, spec-change-decided]
                  # spec-change-proposed — a worker hit a wrong assumption and
                  #                      returned a spec diff. Data, not a
                  #                      command: no plan file moves (D-33)
                  # spec-change-decided  — the operator approved or rejected
                  #                      one. Approval is what calls the
                  #                      amendment; the version is still cut
                  #                      by `plan amend` alone

# ── Gates (event-log first-class, §11 — added Phase 4) ───────────────
gate_event:      [schema-check-result, artifact-check-result,
                  commit-check-result, deps-check-result,
                  judges-outstanding, grader-verdict, budget-check-result,
                  testgate-result, coverage-evidence, integration-check,
                  spec-review-recorded, goal-check-recorded, quorum-decision,
                  finding-raised, finding-reverified, finding-suppressed,
                  finding-transitioned, finding-reattributed,
                  severity-decisions, waiver-granted, waiver-denied,
                  gate-outcome]
                  # schema-check-result — task Result vs result.schema.json
                  # artifact-check-result — every artifacts[].path in that
                  #                       Result, resolved against the task's
                  #                       home under state/artifacts/ and
                  #                       checked to exist. Emitted even when
                  #                       the task declared none: a check that
                  #                       only speaks up when it has something
                  #                       to say is indistinguishable, later,
                  #                       from a check that never ran (P9-22)
                  # commit-check-result — is there a commit here to score? the
                  #                       worktree is clean and its branch is
                  #                       ahead of the base (D-30, P9-8)
                  # deps-check-result   — the worktree owns the toolchain its
                  #                       checks are about to run (P9-16d);
                  #                       always logged, including when the
                  #                       project declares nothing to install
                  # judges-outstanding  — a judge this task dispatched through
                  #                       `smith judge dispatch` never reported
                  #                       back, so the gate refuses to score an
                  #                       unknown: a missing `--evidence` reads
                  #                       identically whether the judge found
                  #                       nothing or died mid-turn. Names each
                  #                       owed role/round. A task that
                  #                       dispatched no judges is unaffected —
                  #                       this refuses only where there is a
                  #                       promise on record (D-31/D-20, P9-11)
                  # grader-verdict      — the grader's rubric result vs
                  #                       grader-verdict.schema.json, and
                  #                       whether the acceptance criteria were
                  #                       met. Runs BEFORE the test gate: a
                  #                       not-met rubric bounces the diff
                  #                       whatever the suite says (D-34)
                  # budget-check-result — declared caps vs measured spend:
                  #                       token_usage off the Result, authored
                  #                       diff lines off git. Recorded, never
                  #                       blocking, and emitted even when the
                  #                       plan declared no budget or the diff
                  #                       could not be measured — "not-declared"
                  #                       and "unmeasurable" are outcomes, not
                  #                       silence (P9-18)
                  # testgate-result     — check-command run (test gate)
                  # coverage-evidence   — the numbers behind the green: which
                  #                       subject files the coverage summary
                  #                       actually measured, and whether it is
                  #                       complete. Emitted after the tests
                  #                       pass and before the findings are
                  #                       judged, because a green run that
                  #                       cannot name a number for the file the
                  #                       acceptance criterion is about has not
                  #                       answered it (D-40, P9-25)
                  # integration-check   — the check suite run at the PROJECT
                  #                       ROOT against smith/<epic>/integration,
                  #                       pinned to the head sha it covers.
                  #                       Every other gate event above is a
                  #                       claim about a task worktree; this is
                  #                       the only one about the assembled
                  #                       branch, and epic verdict holds
                  #                       without a current passing one (D-42)
                  # spec-review-recorded— a spec-reviewer dispatch finished,
                  #                       pinned to the head sha it read.
                  #                       Recorded even when it found nothing,
                  #                       so "ran and was clean" is
                  #                       distinguishable from "never ran"
                  # goal-check-recorded — the epic's plan was checked against
                  #                       the goal its roadmap milestone
                  #                       declares, clause by clause. The one
                  #                       gate whose reference text the planner
                  #                       did not author, so a plan that is
                  #                       internally consistent but answers the
                  #                       wrong question still fails it.
                  #                       Carries the goal digest it read, so a
                  #                       reworded goal invalidates the check
                  #                       the same way a new plan version does
                  # quorum-decision     — one cross-provider quorum case closed:
                  #                       who voted, on what, and whether the
                  #                       finding survived. Emitted exactly once
                  #                       per case, including when the case
                  #                       could not be decided — an
                  #                       `insufficient-providers` outcome is a
                  #                       recorded fact, not an absent one. Runs
                  #                       over findings at the task gate
                  #                       (gate.ts) and over plan-cut and
                  #                       epic-close verdicts (planQuorum.ts,
                  #                       epic.ts)
                  # finding-raised      — a new finding entered the log
                  # finding-reverified  — a human re-read an open finding
                  #                       against the current code. Not a
                  #                       finding_status change: `confirmed`
                  #                       cannot be re-entered and `refuted`
                  #                       means the finding was wrong, so
                  #                       "still reproduces" needs an event of
                  #                       its own. It re-dates the finding's
                  #                       evidence, which is what clears the
                  #                       stale-evidence bar on a waiver grant
                  #                       once a wave has merged over its file
                  #                       (P9-15)
                  # finding-suppressed  — raise attempt matched a waived
                  #                       fingerprint; logged, not appended
                  #                       as a duplicate raised finding
                  # finding-transitioned— finding_status state change
                  # finding-reattributed— the finding moved to the task that
                  #                       owns the file, or to a follow-up task
                  #                       minted for it when nobody open could
                  #                       take it. Without this event the log
                  #                       shows a finding sitting under a task
                  #                       that was never gated, and no trace of
                  #                       how it got there (attribution.ts)
                  # severity-decisions  — gate.ts's per-finding severity
                  #                       verdicts for one task (block /
                  #                       waiver-batch / log-only)
                  # waiver-granted/-denied — operator waiver-batch answer,
                  #                       keyed by finding fingerprint
                  # gate-outcome        — the composed gate pipeline's
                  #                       final structured result

# ── Errors: grouped two-level classes (always logged as group.class) ─
error:
  spec:         [spec-gap, spec-ambiguity, spec-conflict,
                 missing-nonfunctional]
                 # missing-nonfunctional — security/validation/authz clause
                 # absent from the contract (implicit clauses get dropped)
  contract:     [schema-violation, claim-violation, constraint-decay,
                 write-root-violation, judge-mutation, uncited-claim,
                 unsourced-recommendation, uncommitted-work]
                 # constraint-decay — agent stopped honoring a standing
                 # architectural constraint mid-epic
                 # write-root-violation — a role that works outside a worktree
                 # (planner, scribe) wrote outside its declared write root
                 # (P9-3); shipped as a code before it was a class
                 # judge-mutation — a read-only judge moved the worktree it
                 # was judging (P9-5, `smith worktree verify`)
                 # uncited-claim — a researcher finding with no citation, or a
                 # citation that is neither a repo path with a line number nor
                 # a URL actually fetched (P9-6, `smith research check`)
                 # unsourced-recommendation — a brief's recommendation names no
                 # finding, or names one the brief does not carry, so what came
                 # from fetched text is invisible (P9-6)
                 # uncommitted-work — a task reported done with work still in
                 # the working tree, or with a branch head no further along
                 # than the base it was cut from; the gate scored a worktree
                 # the queue would have merged as a no-op (D-30, P9-8)
  execution:    [test-failure, regression, flaky-test, tool-failure,
                 env-failure]
                 # regression — previously-passing behavior broken (the
                 # dominant multi-round failure mode)
  integration:  [merge-conflict-textual, merge-conflict-semantic,
                 stack-misorder]
                 # semantic — textually clean merge, broken behavior
  economy:      [budget-exceeded, diff-cap-exceeded, over-engineering,
                 context-overrun]
  judgment:     [hallucination, false-positive-finding, missed-finding,
                 reward-hacking, same-mistake, provider-disagreement]
                 # reward-hacking — letter of the tests, spirit of nothing
  coordination: [deadlock, livelock, starvation]
  memory:       [lesson-contamination, lesson-stale, poisoning-suspected]

# ── Review ──────────────────────────────────────────────────────────
finding_category: [correctness, security, a11y, performance, visual-hds,
                   behavioral-drift, test-coverage, over-engineering,
                   maintainability]
                   # behavioral-drift — changed input validation / error
                   # handling relative to surrounding code; invisible to
                   # static metrics, the measured driver of agent-code debt
finding_scope:    [diff, spec]
                   # diff — the code is wrong; the fix belongs in a task diff
                   # spec — the code is right and the PLAN is wrong. Routed to
                   # the planner and the operator, never to the task gate:
                   # blocking a diff that cannot legally contain the fix is
                   # the D-33 deadlock. A finding written before this
                   # dimension existed carries no scope and reads as `diff`.
finding_status:   [raised, refuted, confirmed, fix-pending, fix-landed,
                   fix-verified, waived, expired, amend-pending, amended]
                   # closes only at fix-verified, waived or amended — a review
                   # that fired without uptake is not a closed finding
                   # amended — a spec finding whose criterion moved in a new
                   # plan version. Spec-scoped only, and the one exit for an
                   # S1/S2 spec finding, which is categorically unwaivable
                   # amend-pending — that plan version has been cut and cites
                   # the finding, but the task ids the amendment added or
                   # superseded have not landed yet. A spec finding's
                   # `fix-pending`, and reachable only from raised/confirmed.
                   # Without it `amended` was reachable at plan-write time, so
                   # the unwaivable class closed on a sentence (D-127).
                   # `-> amended` is gated in transition() itself, not just in
                   # the epic-close sweep: the caller must show the obligated
                   # ids landed at >= the amendment's plan version, or the
                   # CLI reopens the same door the sweep closed
severity:         [S1-stop-the-line, S2-major, S3-minor, S4-nit]
                   # S1 — repo corruption, secret leak, guardrail breach
                   # S2 — blocks merge (security/data-loss, broken core
                   #      flow, a11y AA failure, new flaky test)
                   # S3 — real but waivable; batched to operator at epic end
                   # S4 — nits below Biome's radar; logged, never asked

# ── Lessons / memory (typed — one type per entry, never mixed) ──────
lesson_type:   [fact, event, rule]
                # fact  — stable truth about a repo/stack ("D1 lacks X")
                # event — dated occurrence ("epic-7 hit deadlock via Y")
                # rule  — imperative, checkable principle ("never edit
                #         lockfiles in workers")
lesson_level:  [principle]     # instance-level (transcript) entries are
                               # rejected at the gate — they cause
                               # capability collapse when accumulated
lesson_status: [candidate, novelty-rejected, pending-approval, approved,
                superseded, invalidated]
lesson_scope:  [agent-role, claim-path, case-type, stack-wide, security]
                               # `security` cuts across roles: coder, reviewer
                               # and security-reviewer all want the same auth
                               # lesson, so it is not an agent-role lesson
```

Dimension rules:

1. **Required dimensions per record type** (validated at write): task →
   case+origin+task_status; dispatch → agent+provider+model_tier+model
   (`model` is the concrete id §7 has always asked `dispatch_decision` to
   carry; presence-checked only, never a closed dimension, because model
   names turn over monthly and a frozen enum would reject next month's model
   — or, likelier, get the field dropped instead of the taxonomy bumped.
   The tier cannot answer *"did the critic run on the finder's model?"*:
   opus and fable are both `frontier`); error →
   error(group.class)+severity+task ref; finding → finding_category+
   severity+finding_status; lesson → lesson_type+lesson_level+lesson_status+
   lesson_scope+provenance event ids; edge → edge_type+edge_provenance.
2. **One value per dimension** — a record needing two values is two records
   or a wrongly-cut dimension; fix the taxonomy by PR, don't overload tags.
3. **Renames are supersessions**: a value is never deleted or renamed in
   place — it's marked deprecated in the YAML with a `superseded_by`, so old
   events stay queryable.
4. **`project` is deliberately NOT a taxonomy.yml dimension** (Phase 6b).
   Every dimension above is closed/versioned because analytics must
   aggregate consistently across months of runs; `project` is the opposite
   shape — operators add/retire projects routinely, and a hub spanning
   several of them needs that identifier to be as cheap to introduce as a
   new epic id. It is carried as a plain string on events, tasks, dispatches,
   errors, findings, milestones, and plans, validated only for presence
   (never against an enum), and defaults to `'black-smith'` when absent.

## 9. Error log + lessons loop

1. **Every gate failure and runtime error** is logged with taxonomy tags,
   task/agent refs, and the diff/output that triggered it. A scheduled
   offline **"dreaming" pass** additionally scans event logs for **decision
   checkpoints** (what was proposed, approved, modified, rejected — and why):
   those compound into the highest-value memory, not just error notes.
2. A **scribe** distills errors and decision checkpoints into **lesson
   candidates** — always **typed** (`fact` | `event` | `rule`, one type per
   entry; §8) and always **principle-level**: abstract, transferable,
   checkable. Instance-level transcripts are rejected at the gate — naive
   experience accumulation measurably *degrades* agents (§17).
3. A cheap **novelty gate** runs before the human sees anything: an
   embedding-density check scores each candidate — clearly-redundant →
   `novelty-rejected` (no-op), clearly-novel → queue, uncertain → one LLM
   merge step. The approval queue contains only genuinely new candidates
   (~3× cheaper write path, §17: SAGE). **Built (Phase 7):**
   `factory/orchestrator/src/lessons.ts`'s `checkNovelty()` implements the
   clearly-redundant/clearly-novel split with deterministic word-shingle
   Jaccard similarity (threshold in `factory/policies/scheduler.yml`'s
   `lessons:` block, default 0.8) — SAGE's "uncertain → one LLM merge step"
   middle tier is a documented future upgrade, not built yet.
4. **The operator reviews lessons in the UI** (approve / edit / reject).
   Nothing self-modifies without approval — unreviewed self-written memory
   is not just noise but an **attack surface** (memory poisoning, §17); the
   approval gate is the safety boundary.
5. Approved lessons are **compiled** into `factory/policies/lessons.md`,
   sectioned by scope, and **injected step-wise**: surfaced at the matching
   decision point (coder gets claim-path-scoped rules at dispatch; merger
   gets integration rules at queue time) rather than as a global preamble —
   step-wise injection measurably beats session-start injection (§17).
   Standing architectural constraints are **re-asserted in every task
   contract** (constraint-decay countermeasure), never stated once per epic.
6. **Bi-temporal supersession with provenance.** Every lesson carries
   `valid_from`, `superseded_by`, and pointers to the event-log entries that
   produced it. A lesson contradicted by a later run is `invalidated` with a
   pointer to the invalidating event — traceable rollback, never silent
   deletion (the git commit is the provenance record).
7. **Same-mistake detection:** the reviewer receives past findings for the
   same claim paths + the lessons digest. A finding matching an approved
   lesson is auto-escalated one severity level and tagged
   `judgment.same-mistake` — the factory's key quality KPI (target:
   monotonically decreasing).

## 10. UI — HDS dashboard

Built from the HDS kit (`knowledge/design-system/hds/`); the `black-smith`
repo is added to `knowledge/design-system/adopters.md` so uiux/reviewer gating
applies. **Local-first**: a local web app reading `state/smith.db` via a small
read-only API; lesson/waiver actions are the only writes. **Cloudflare
later**: the UI is built stack-compatible with Workers/Pages + D1 from day one
(§14 stack standard) so deployment is a port of the data layer (SQLite → D1),
not a rewrite; auth (Cloudflare Access) required before anything is exposed.

Pages:

| Page | Shows |
|---|---|
| **Projects** (Phase 6b, app default route `/`) | one card per project: live agents, open findings by severity, current epic + milestone progress, last activity, budget burn, epic identity chips |
| **Overview** | per-project at `/p/:project/overview`, or aggregated **global mode** at `/overview` — live agents (count by role/model/provider), tokens vs budget, epics in flight, **project progress per milestone**, alerts (escalations, waivers pending) |
| **Sessions** (Phase 10, `/sessions`) | the runs happening right now as a spatial canvas (Vue Flow): one band per running session, most recently active first, with the live agents it dispatched drawn beside it; edge motion only where the run AND the agent are both moving. Same `/api/overview` payload and same poll cadence as Overview's "Now running" card — a second rendering, never a second source of truth. Live agents whose session is absent from the payload are named in a banner rather than re-parented onto a run they did not belong to. Explicitly not terminals: a live PTY node would need a bidirectional socket and browser-issued command execution, which §8's no-WebSockets rule and the read-only API both forbid |
| **Timeline** | user prompts + dispatch decisions + gate events, interleaved, filterable by taxonomy and (Phase 6b) by project; a **"Decisions" lens** narrows to user prompts + operator-authored decision events (waivers, lesson status changes, and the operator's own `operator-note`s — D-213) + their causally-attached dispatches |
| **Kanban** | tasks by status (todo / in-progress / reviewing / blocked / completed), tag chips (case, origin, severity), **milestone filter/lane**, drag disabled — status changes only via factory events |
| **Task detail** | spec contract, claims, assigned agents, attempts, review findings, artifacts (screenshots), branch/PR links |
| **Roadmap** | milestones with goal statements, epic mapping, completion criteria, progress %, budget burn per milestone |
| **Flow** | the active plan version's task DAG rendered as an interactive graph (Vue Flow): task nodes colored by status, dependency edges styled by edge_type, gate/checkpoint nodes, wave bands showing which tasks and agents run in parallel right now, plan-version switcher with added/superseded diff |
| **Lessons** | pending candidates with evidence → approve / edit / reject; approved list with "times prevented" counter |
| **Errors** | error log grouped by taxonomy class, trend charts, provider-disagreement cases |
| **Analytics** | throughput, cost per task by model tier and provider, same-mistake rate, recheck outcomes |

**Milestones** (Phase 6a addition): declared in `factory/specs/roadmap.md`
(one `## <name>` block per phase, with `id`/`status`/`goal`/`epics` fields),
parsed by `factory/orchestrator/src/roadmap.ts` and projected into the
`milestones` table by `db/projector.ts`. `db/queries.ts`'s `roadmapPage()`
joins each milestone with its mapped epics' task/token stats; `overview()`
embeds the same rows as `milestoneProgress`. A milestone with no epics
mapped yet (`epics: []`) reports zero tasks, not an error — roadmap.md is
edited by hand as epics are scoped to phases. Phase 6b adds each milestone's
own `project` field (roadmap.md's `- project:` bullet, defaults
`'black-smith'`) — a milestone is declared for exactly one project.

**Multi-project hub + routing** (Phase 6b): `/` redirects to `/projects`,
the app's new default route (one card per project). `/overview` is
"global mode" (aggregates `overview()` across every project, plus a
per-project breakdown); `/p/:project/overview` scopes the same query to one
project. A topbar project-switcher `Select` propagates a `?project=` query
param that scopes Overview/Timeline/Kanban/Roadmap/Flow to one project
without changing route. Epic identity is rendered as a deterministic
`hash(epic id) -> --ds-chart-1..8` colour chip (one shared util), reused
across Overview/Kanban/Roadmap/Flow/Projects — chart-palette identity
colour, never a status tone.

**Phase 6a / 6b split**: Overview, Timeline, and Kanban ship in 6a (this
phase); Roadmap, Task detail, Lessons, Errors, and Analytics ship in 6b —
the 6a router shows their nav items disabled with a "Phase 6b" tooltip, and
`/tasks/:taskId` is a stub page. The `ui/server` read API and `milestones`
projection ship in 6a regardless (both Overview and the future Roadmap page
depend on them), ahead of the 6b page that visualizes `roadmapPage()`
directly.

## 11. Review + test rigor

- **Cumulative regression gate.** The merge queue runs the tests of **every
  previously merged task in the epic**, not just the incoming task's — the
  dominant multi-round failure mode is regression on previously-working
  behavior, and cumulative tests are one of the two empirically validated
  countermeasures (§17: EvoCode-Bench).
- **Living spec doc per epic.** Each epic carries a requirements/spec
  markdown that every worker must read before starting and update on
  completion; the planner owns its accuracy. The other validated
  countermeasure — it roughly **doubles** multi-round success (§17).
- **Test gate first, review second.** Coder works TDD; the tester agent owns
  e2e (Playwright) and must produce **screenshots for any UI-affecting task**
  — they become PR artifacts automatically.
- **Stack-aware landing.** Workers emit small stacked layers (≤200 lines
  each, within the 400-line task cap) rather than monolithic branch diffs;
  the merge queue lands stacks in dependency order (GitHub native stacked
  PRs; smaller layers review ~3× faster with materially fewer defects).
- **Security review is conditional depth.** A `security-reviewer` judge
  dispatches only when a task's claims touch sensitive paths
  (auth/session/secrets/crypto/input-parsing/network boundary), when the
  epic is `case: infra` or security-tagged, or on a scheduled recheck of
  sensitive claim paths — mechanical scanners (gitleaks, audit) stay the
  always-on layer; the judge finds what pattern-matching cannot.
- **Reviewer is fresh-context and independent** — never the coder's session,
  read-only tools. Verifier adversarially re-checks reviewer findings
  (prompted to *refute*) so plausible-but-wrong findings die before they cost
  a round-trip. Cross-provider second opinions per §6.
- **Severity gates** (`severity.yml`):
  - S1/S2 → hard block; bounce to coder on the same branch; after 2 failed
    rounds, escalate model tier; after 3, escalate to user.
  - S3 → does **not** block; batched into a single waiver question to the
    operator ("ignore these?"). Answers are stored as **waivers** keyed by
    finding fingerprint — the same finding is never asked twice, and waived
    findings are suppressed in future reviews of the same code.
  - S4 → does **not** block and is never batched to the operator; logged
    only (below Biome's radar, agent-constraints.md "reviewer / verifier").
- **Anti-repeat between turns:** every review round receives the previous
  rounds' findings for this task + approved lessons; re-introducing a fixed
  issue is `same-mistake`, auto S2.

## 12. Planner self-extension + dynamic research

The planner is allowed — required — to grow the backlog to protect the final
outcome. Growth happens through **immutable plan versions**, never by
mutating the live graph:

- **Plan versions.** A plan, once `active`, is frozen. Adding, splitting, or
  superseding tasks means cutting **plan v(n+1)** — a new immutable version
  that carries forward unfinished tasks, marks replaced ones `superseded`,
  and bumps `plan_version` on all subsequent events. Both versions stay in
  the log; the diff between them *is* the re-planning decision, reviewable
  in the timeline. Free-form runtime graph rewriting is the known failure
  mode of agent loops (unbounded replanning, mutable history — §17: SGH) and
  is prohibited.
- **Escalation ladder, strict.** Recovery from a failed/bounced task follows
  fixed rungs: (1) bounded retry on the same contract → (2) alternate
  approach within the same plan version → (3) new plan version → (4)
  operator. Each rung is an event; skipping rungs or looping on one rung
  past its bound is a `coordination` error.
- **No back-edges in engineering epics.** Cyclic revisitation pays off only
  in recovery-heavy exploratory work; forward prerequisite chains — most
  factory epics — get pure overhead from cycles (§17). Research-type epics
  may opt in explicitly.
- **Inferred tasks.** During any verdict or gate review, the planner may add
  tasks (in the next plan version) with `origin: inferred`, a rationale, and
  a **confidence score**. Policy: confidence ≥ threshold (default 0.8) →
  auto-scheduled; below → parked as `todo` pending operator tick in the
  kanban. Inferred tasks consume the epic's budget, never extend it.
- **Dynamic research during development.** A worker that hits an unknown
  commits its green work, stops with `run_status: dead`, and returns a
  `research_request` in `structured_output`. The dispatcher — which owns the
  event log, §8 — spawns a researcher, attaches the brief to the task spec,
  and re-dispatches the worker onto its existing commit. Sibling tasks never
  pause. (There is deliberately no `research-request` event type: a worker
  that dies mid-flight cannot emit anything, so signalling through a returned
  field is the only shape that survives its own failure case.)
- **Living spec: worker-proposed amendments.** The same exit carries the other
  mid-flight blocker. A worker that finds an acceptance criterion the code
  contradicts returns a `spec_change_request` in `structured_output` —
  `{criterion_ref, assumption, evidence, changes, sites, blocking}` — and the
  dispatcher records it with `smith plan propose`. That writes a
  `spec-change-proposed` event and raises the finding the amendment will
  later cite, and it writes **no plan version**: the proposal is data, not a
  command. `smith plan proposals` lists what is waiting with its diff;
  `smith plan approve <id>` runs `plan amend` with the worker's own finding,
  sites and rationale — one command, no guard relaxed — and `smith plan
  reject <id>` refutes the finding with the operator's reasons. Approval is
  what calls the amendment; the version is still cut by `plan amend` alone,
  so every version stays immutable and every one of them is in the log. A
  proposal written against a version a later amendment has already overtaken
  is **stale** and is refused rather than applied blind. This is rung three
  of the escalation ladder (§17) made reachable from inside a task: a
  spec-scoped finding can only be minted by a judge dispatched against a plan
  version, and a coder mid-flight is not one (D-33/P9-9).
- **Recheck scheduling** (`factory/scheduler/`, implementation at
  `factory/orchestrator/src/scheduler.ts`). Every completed feature gets
  a recheck policy: re-open a `recheck` task when (a) N later merges touch its
  claim paths, (b) T days elapse, or (c) its confidence score at completion
  was below a threshold. Recheck tasks re-run tests, re-review against current
  code, and may spawn deep research — this is how the project re-examines
  itself over time instead of only moving forward. Thresholds N/T/confidence
  are policy, not hardcoded: `factory/policies/scheduler.yml`'s `recheck:`
  block (defaults: 5 merges, 14 days, 0.6 confidence) — `smith scheduler run
  [--dry]` computes proposals over the event log and, unless `--dry`, emits
  a `recheck-proposed` event per candidate; it never dispatches an agent
  itself.
- **Scheduled growth passes.** Two scheduler-driven passes keep the project
  growing, not just self-correcting: a **maintenance pass** (dependency
  updates + security advisories → proposed maintenance epics;
  high-confidence ones auto-schedule — `scheduler.yml`'s `maintenance:`
  block, driven by `pnpm outdated --json` when available, a `maintenance-
  proposed` event) and a **product-growth pass** (planner reads the living
  spec, analytics, and recheck outcomes → proposes new epics with
  rationale — the scheduler only emits a cadence-driven `growth-review-due`
  *trigger* event, `scheduler.yml`'s `growth:` block, never the scope
  proposal itself). Product-growth proposals **always** wait for an
  operator tick regardless of confidence — the factory may propose scope,
  never widen it on its own.
- **Roadmap layer (v3.2).** `factory/specs/roadmap.md` maps milestones →
  epics with goal statements and completion criteria. The **planner
  maintains it** (updated at every epic verdict); any roadmap change is a
  scope change and waits for operator approval. The scribe reports against
  it: a weekly digest and an immediate milestone-completion report, both to
  the operator's Slack DM — progress is pushed, not only pulled from the
  dashboard.
- **Guardrails:** self-extension never widens scope past the epic's stated
  goal (planner must map every inferred task to an acceptance criterion), and
  the dry-counter still terminates the loop.

## 13. PR flow (outcome review)

1. Task PRs target the integration branch `smith/<epic>/integration`
   (internal, auto-merged by the queue after gates; git ref constraint:
   `smith/<epic>` cannot coexist with `smith/<epic>/<task-id>`, §5 point 3).
2. When the epic's acceptance criteria pass, the factory opens **one
   integration PR** `smith/<epic>/integration` → `main` of the target repo
   containing:
   - spec summary + acceptance-criteria checklist (auto-checked),
   - **screenshots / short capture of the feature** (tester's Playwright
     artifacts; before/after for changes),
   - test results, reviewer verdict, cross-check quorum result, waivers granted,
   - links to the timeline slice and task list in the Blacksmith UI.
3. The operator reviews on GitHub and merges. Blacksmith never merges to
   `main`.

## 14. Unified stack standard + operator interview

Every project Blacksmith creates uses **one stack**, fixed at repo-creation
time — consistency is what lets small models work reliably across projects
(lessons, claims, and scaffolds transfer; nothing is relearned per repo).

- **`docs/standards/stack.md`** — the canonical standard: language, frontend,
  styling (HDS adoption), backend/runtime, database, package manager, testing
  stack, lint/format, CI, hosting (Cloudflare-first), directory conventions.
  Generated from the operator interview below; versioned; the planner may
  deviate only with a written justification attached to the epic spec.
- **`factory/scaffold/`** — the new-repo template implementing the standard:
  pre-wired lint/test/CI, `AGENTS.md` router, HDS adoption kit when the
  project has UI, claims-friendly directory layout. `smith new <project>`
  instantiates it, then installs and runs the project's own gates in `ci.yml`'s
  order before the first commit, reporting `toolchain: verified|failed|skipped`
  and exiting 1 on a red one — so no epic has to open with a serial
  toolchain task (P9-19). Scaffold drift is fixed in the template, not per-repo.
- **`docs/standards/interview.md`** — a structured operator interview
  (companion doc: `black-smith-interview.md` beside this spec). Its answers
  produce (a) `stack.md` and (b) **per-subagent constraint blocks** compiled
  into agent templates: coder (TDD strictness, coverage floor, dependency
  policy), tester (e2e scope, screenshot spec), reviewer (severity
  calibration — what the operator considers S2 vs S3), planner (autonomy
  level, confidence threshold), uiux (HDS strictness), merger (escalation
  preference), budgets (per-epic token caps), cross-check
  (providers, quorum triggers), notifications (channel, waiver batching
  cadence). The interview is re-runnable; answers are diffed and re-compiled.

## 15. Practices adopted from Anthropic's agent engineering

Distilled from *Building Effective Agents*, the multi-agent research system
write-up, Claude Code best-practice docs, and *Writing Tools for Agents* —
each mapped to a Blacksmith mechanism:

1. **Simplest pattern that works; add autonomy only when measured better.**
   Blacksmith is deliberately a *workflow* (orchestrator-workers +
   evaluator-optimizer), not a free-running agent swarm: deterministic loop
   runner, bounded gates, model-driven steps only where judgment is needed.
2. **Orchestrator-workers with explicit delegation contracts.** The research
   system's core lesson: subagent failures trace to vague delegation. Every
   dispatch carries objective, output format, tool guidance, and effort
   scaling ("this is a 3-call task" vs "this deserves 30 turns") — encoded
   here as the spec contract + `maxTurns` + budget per dispatch.
3. **Effort scaling rules.** Explicit heuristics for how many agents/calls a
   task deserves, in `budgets.yml` — small fixes get one coder, epics get
   fan-out. Multi-agent token burn (~15× chat) means the loop must justify
   itself per task; the scheduler prefers the cheapest shape that meets the
   acceptance criteria.
4. **Separate context windows, structured returns.** Workers return
   schema-validated results, never transcripts; orchestrator context stays
   lean across many rounds (the reason Hans itself survives long sessions).
5. **Evaluator-optimizer as the inner loop.** Generate → independent evaluate
   → feed findings back — the reviewer/verifier/coder cycle of §11, with
   end-state judging (does the outcome meet acceptance criteria) rather than
   step-by-step judging.
6. **Verification targets, not "done".** Agents are told what proof of
   completion looks like (tests green, screenshot captured, schema valid);
   "it works" without the artifact fails the gate.
7. **Progressive disclosure for context.** Thin `AGENTS.md` router + on-demand
   detail files in every scaffolded repo — CLAUDE.md kept lean, details pulled
   when needed (dotagents convention, also Claude Code guidance).
8. **Tools are prompts.** Few, well-named tools per agent; tool descriptions
   written as carefully as system prompts; results returned token-efficient
   and structured. Generated agents get the *narrowest* toolset that satisfies
   their spec.
9. **Plan before code, course-correct early.** Planner phase is mandatory and
   separate from execution; gates fire at the earliest cheap moment (schema
   check before tests, tests before review) so bad work dies young.
10. **Checkpointed, resumable runs.** The event log is the source of truth;
    the loop resumes from the last event after a crash instead of restarting
    the epic (rainbow-deployment mindset: never orphan running work on
    upgrade).
11. **Human gates where behavior changes.** Lessons (which rewrite agent
    prompts), taxonomy changes, sub-threshold inferred tasks, and semantic
    merge conflicts all stop at the operator — automation for the work,
    approval for the rules.

## 16. Build order (implementation phases)

1. **Interview + standards** — run the operator interview; compile
   `docs/standards/stack.md` + per-agent constraint blocks; pin the scaffold.
2. **Skeleton + contracts** — repo layout, spec/result/finding/lesson JSON
   Schemas, taxonomy.yml, agent templates (planner/coder/reviewer first).
3. **Loop runner + worktree engine** — dispatch from specs, path-claim
   validation, worktree lifecycle, serial merge queue, event log.
4. **Gates** — test gate, reviewer/verifier chain, severity policy, waiver
   flow (CLI prompt first, UI later).
5. **State + analytics** — SQLite projections, timeline, live agent registry.
6. **UI (HDS)** — overview + timeline + kanban first; lessons/errors/analytics
   second. Local-only; Cloudflare port when stable.
7. **Self-extension** — inferred tasks + confidence policy, scheduler,
   rechecks, lessons compilation loop. **Built (2026-08-04, in review):**
   `factory/scaffold/` + `smith new`, `factory/orchestrator/src/scheduler.ts`
   (`smith scheduler run [--dry]`, `factory/policies/scheduler.yml`),
   `factory/orchestrator/src/lessons.ts` (novelty gate, `smith lessons
   candidates`/`compile`, `smith dream [--since]`), and the `.claude/
   skills/bs/SKILL.md` operator console tying the deterministic mechanics
   above to the agent templates. Dispatch itself is skill-guided from the
   operator's Claude Code session; the Phase 10 `smith daemon` is a standalone
   background process, but a watcher — it folds the log and reports, and never
   dispatches (`docs/guide/operator-guide.md` "Limitations today",
   `docs/runbooks/ops.md`).
8. **Cross-provider judges** — provider adapters (codex, deepseek), quorum
   policy, disagreement analytics.
9. **Hardening** — escalation ladders, budget alarms, same-mistake KPI,
   runbooks, Cloudflare deployment (Workers/Pages + D1 + Access).

Each phase is itself an epic Blacksmith can eventually run on its own
codebase — the factory bootstraps itself from phase 3 onward.

## 17. Evidence base (Apr–Aug 2026 research window)

Key sources behind the v3 changes; consult before revising the mechanisms
they justify.

- **Immutable plan versions + escalation ladder**: SGH, "From Agent Loops to
  Structured Graphs" (arXiv 2604.11378); execution lineage (2605.06365);
  cycles pay only in recovery-heavy regimes (2604.22820).
- **Claims from static analysis, hub-file serialization**: Co-Coder,
  "When Parallelism Pays Off" (2606.00953) — +14% pass, 2.1× wall-clock,
  −35% API cost from cohesion-aware partitioning.
- **Dependency edges predict failure**: GRADE (2606.22741) — dependency
  structure hits ROC-AUC 0.805 for run-failure prediction and Top-3 0.614
  fault localization where trace length carries no signal.
- **Fan-out buys wall-clock + isolation, never reasoning**: equal-budget
  study (2604.02460, DPI argument); Cognition "Multi-Agents: What's Actually
  Working" (Apr 2026) — writes single-threaded, extra agents contribute
  intelligence, not actions.
- **Deadlock is protocol, not model quality**: DPBench (2602.13255) —
  ordered resource acquisition drives 90% deadlock to ~0; TraceFix
  (2605.07935) — TLA+-checked protocols halve deadlock/livelock.
- **Regression + living spec doc**: EvoCode-Bench (2605.24110) — >50%
  capability loss by round 5, dominant failure is regression; a persistent
  requirements doc doubles success.
- **Volume gates over prompting**: "AI-Generated Smells" (2605.02741) —
  volume predicts structural decay, detailed prompting does not mitigate,
  green tests are decoupled from architecture quality. Behavioral drift in
  agent-code maintenance: 2606.21804.
- **Adversarial kill-scored review, finder ≠ critic**: Refute-or-Promote
  (2604.19049) — 79–83% of candidate findings killed pre-disclosure;
  mechanical oracles over LLM-as-judge: 2607.23002.
- **Spec critique is the weakest capability**: SpecBench (2605.30314) — best
  agent 44.4% at finding spec deficiencies; implicit security clauses get
  dropped (2606.00167); constraint decay (2605.06445).
- **Typed, principle-level, gated memory**: MemGuard (2605.28009) — 97.7% of
  unverifiability errors from write-time type mixing; capability collapse
  from instance-level accumulation + step-wise injection wins (2606.04703);
  novelty gate (SAGE, 2605.30711); memory poisoning as attack surface
  (2605.15338, 2604.16548); provenance graphs for memory ops (MemTrace,
  2605.28732).
- **Industry primitives (build policy, not plumbing)**: Claude Code native
  worktree isolation, Dynamic Workflows, grader loops ("Performance
  Outcomes"), "Dreaming" memory consolidation, per-agent cost attribution
  (May–Jun 2026); Warren ephemeral-run + NDJSON event-stream model
  (successor to Overstory); GitHub native stacked PRs (public preview
  2026-07-30); Cloudflare Workflows V2 + Dynamic Workflows (runtime-defined
  durable graphs).
