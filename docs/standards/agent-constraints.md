# Per-Agent Constraint Blocks

> Compiled from the operator interview on 2026-08-03. Phase 2 bakes each
> block into the matching agent template in `.claude/agents/`; until then
> this file is the source of truth.

## planner

- Autonomy: **spec sign-off per epic** — after the operator approves the epic
  spec, execute freely within budget; never start an epic unapproved.
- Inferred tasks: auto-schedule at **confidence ≥ 0.8**; below that, park as
  `todo` for an operator tick. Every inferred task must map to an acceptance
  criterion.
- Budget: **may never extend an epic's budget** — extension is always an
  operator question.
- Growth passes (v3.1): maintenance-pass proposals may auto-schedule at
  high confidence; **product-growth proposals always wait for an operator
  tick** — the planner proposes scope, never widens it.

## coder

- TDD: **strict for logic** (failing test exists before implementation,
  gate-enforced); tests-in-same-task for UI glue.
- Coverage: **80% floor on claimed logic paths**.
- Dependencies: install from the **curated allowlist** freely; anything else
  is an operator question. The allowlist grows only via approved lessons.
  Prefer stdlib/existing deps: a new dependency must displace meaningful
  code, not save a dozen lines.
- Comments/docs: English only; no style beyond the scaffold's Biome config.

### Effort discipline (anti-over-engineering, defaults applied 2026-08-03)

- **Token cap: 150k per task.** Hitting the cap is not failure — the coder
  stops, reports what's done, and the task returns to the planner for
  re-scoping (`budget-exceeded`, no retry at the same scope).
- **Diff cap: ≤400 changed lines** per task, excluding lockfiles/generated
  files. Projected overrun → stop and return to planner to split; a merged
  diff over cap fails the gate.
- **Strict YAGNI.** Code exactly the acceptance criteria. A new abstraction
  needs ≥2 real call sites within the same epic; no config options, generics,
  layers, or extension points the spec didn't ask for; new patterns must come
  from the spec, not the coder. No TODO scaffolding for imagined futures, no
  drive-by refactors.
- **Context discipline.** Read only claimed paths + files the spec
  references. Repo-wide exploration is the researcher's job, on the
  researcher's budget. A worker cannot emit an event (dispatch topology,
  below), so an unknown is returned, not signalled: commit whatever is already
  green, then stop with `run_status: dead` and a `research_request` field in
  `structured_output` — `{question, blocking: true|false, tried}`. The
  dispatcher reads it, dispatches the researcher, and re-dispatches the worker
  with the brief attached; committing first is what makes that a resume rather
  than a redo.
- **Spec discipline.** The same return path carries the other kind of blocker:
  not an unknown, but a criterion the code contradicts. A worker that finds one
  commits what is green and returns a `spec_change_request` —
  `{criterion_ref, assumption, evidence, changes, sites, blocking}`, schema at
  `factory/specs/schema/spec-change-request.schema.json` — rather than coding
  to its own reading of what the spec meant. The dispatcher records it with
  `smith plan propose`; that writes no plan version, and the operator's
  `smith plan approve` is what cuts one. This is rung three of the escalation
  ladder made reachable from inside a task: without it a wrong criterion has
  only two outcomes, a worker quietly widening it or a coder bounced a defect
  it has nothing to fix (D-33).
- **Enforcement:** token/diff caps enforced by the loop runner (mechanical);
  YAGNI enforced by the reviewer's `over-engineering` lens — findings are
  **`S3-minor`** (waiver batch, with a proposed simplification) and escalate
  to `S2-major` via the same-mistake rule once a matching lesson is approved.

## tester

- Unit per task; **e2e at epic level** against the epic's acceptance criteria.
- Screenshots for every UI-affecting task: desktop + mobile (390px),
  light + dark, max 4 per feature — attached as PR artifacts.
- A flaky test introduced by a task is **`S2-major`** (see reviewer).

## reviewer / verifier

Severity calibration (operator-defined, 2026-08-03):

Severity values are written out in full, exactly as `taxonomy.yml` spells
them. A bare `"S2"` is not a taxonomy value and is rejected at mint time
(`findings.non-canonical-severity`).

| Severity | Blocks merge | Classes |
|---|---|---|
| **`S2-major`** (block) | yes | security / data loss · broken core flow · **a11y WCAG AA failure** · **new flaky test** |
| **`S3-minor`** (waiver) | no — batched question at epic end | visual regression vs HDS · perf regression >20% · everything minor-but-real |
| **`S4-nit`** | no | style/naming nits not caught by Biome |

- `S1-stop-the-line` remains reserved for exactly that (repo corruption,
  secret leak).
- Waiver answers are stored by finding fingerprint — never re-ask.
- Same-mistake findings (matching an approved lesson) escalate one level.
- **Behavioral-drift lens (v3):** the reviewer explicitly checks changed
  input validation and error handling against surrounding code — the
  measured driver of agent-code debt that static metrics miss. Category
  `behavioral-drift`, default `S3-minor`; `S2-major` when it touches a core
  flow.
- **Kill-rate scoring (v3):** reviewer quality is tracked as findings that
  survive adversarial verification and land as verified fixes — volume of
  raised findings is not a metric. Finder and critic are different models.

## grader (v3)

- Rubric loop between "worker done" and the gates: grades output against the
  task's acceptance criteria rubric, bounces it back with specific gaps,
  **max 2 rounds**, then passes whatever exists to the gates (the gates, not
  the grader, decide pass/fail).
- Grader never edits code and never talks to the operator.

## security-reviewer (v3.1)

- **Conditional dispatch only** — never per-task by default. Triggers:
  claims intersect sensitive paths (auth/session/secrets/crypto/
  input-parsing/network boundary); epic is `case: infra` or
  security-tagged; scheduled recheck of sensitive claim paths.
- Read-only tools; kill mandate — findings need a concrete attack
  scenario (attacker input → effect) or they die before the queue.
- Mechanical scanners (gitleaks, pnpm audit) are the always-on layer and
  their output is not repeated as findings.

## scribe (digest duties, v3.2)

- Weekly progress digest + immediate milestone-completion report, sent to
  the operator's Slack DM: shipped / in-flight / blocked / budget burn /
  next milestone. <=300 words, links into the dashboard.

## merger

- Auto-rebase → merger agent → **escalate to operator** when both sides
  changed the same logic. Never silently resolve semantic conflicts.
- Dispatched into the failing task's **existing** worktree (`queue.ts`'s
  `worktreeDir`), with claims scoped to that step's `conflictingFiles`. The
  queue aborts its own rebase before dispatching, so the merger replays
  `git rebase <integration>` to recreate the conflict.
- **The merger never lands the merge.** It resolves, `git rebase --continue`s,
  and returns; the task re-enters the serial queue, which stays the single
  place a merge into the integration branch can happen. On a semantic
  conflict: `git rebase --abort`, return `escalate`.

## model & effort assignment (factory-wide, 2026-08-05)

Set in the frontmatter of every `.claude/agents/*.md`. Recorded from the
roster verification interview (`agent-interviews.md` M-1 → M-3).

| effort | model | roles |
|---|---|---|
| `xhigh` | opus | planner, verifier |
| `high` | sonnet | spec-reviewer, security-reviewer |
| `medium` | sonnet | coder, tester, reviewer, merger, researcher, uiux |
| `low` | sonnet | grader |
| `low` | haiku | scribe |

- **Judge asymmetry is bought where it decides truth, not everywhere.**
  `verifier` is the only judge on opus: it is the one role whose verdict can
  kill a finding outright, so it must not share a model with the reviewer
  that raised it (finder != critic, §6). `grader` stays sonnet/`low` — it
  runs a bounded rubric loop and never decides pass/fail.
- `spec-reviewer` and `security-reviewer` sit at `high`, not `xhigh`: both
  are bounded scans against a written artifact, not open-ended judgment.
- `researcher` and `uiux` are `medium` rather than `low` because both make
  judgment calls — researcher on external source quality (it holds
  `WebFetch`/`WebSearch`), uiux on HDS design fit.
- **`maxTurns` is inert.** Zero of the 31 agents in the official plugin
  marketplace set it and the Agent tool exposes no turns parameter. The key
  stays in the templates as recorded intent; the turn budget is delivered
  where an agent can actually read it — the `/bs` skill's dispatch contract.

## dispatch topology (factory-wide, 2026-08-05)

- **The dispatching node owns the event log for what it dispatches.** It
  emits `dispatch_decision` before the call and `task-result-recorded` (or
  `error-logged`) after — never the dispatched agent itself, which cannot
  report its own mid-flight death.
- **No role template is granted `Agent`.** Flat topology today: one session
  dispatches, one log, one unbroken causal chain. Scoped grants like
  `Agent(tester, grader)` are a real capability and are deliberately not
  used yet — see below for why.
- **Blocker on nesting** (`factory/orchestrator/src/events.ts`):
  `causal_parent` is validated only within a single session's log,
  `session-start` is the only event allowed `causal_parent: null`, and
  `EventInput` has no parent-session field. A second session therefore
  cannot record that session A's decision at event X spawned it — the chain
  breaks silently at the session boundary. Two-tier sessions wait on an
  optional `parent_event: "<session-id>#<index>"` (phase 9).
- **Return discipline is mandatory under uncapped fan-out.** Every worker
  writes its full result to `state/results/<task-id>.json` and returns only
  `{status, severity_counts, artifact_path}`. The dispatcher reads the file
  when it needs detail; a wave of 200 costs 200 short lines.
- Return discipline is the answer to context pressure, **not** a concurrency
  cap. What exhausts an orchestrator is being long-lived across a whole
  epic, not how many workers land at once — a cap pays the same total
  context cost spread over N sequential batches, and buys latency with it.

## budgets (factory-wide)

- **Per-epic cap: 4,000,000 tokens** (planner + all workers + judges).
  Raised from 2,000,000 by operator decision on 2026-08-11 — the reasoning,
  and the two things the raise does not fix, sit beside the number in
  `budgets.yml`. Alarm at 70% (2.8M): planner must re-plan remaining work to
  fit or ask. Epics that can't fit are split into multiple epics at spec time.
- Concurrency: **uncapped by default** (2026-08-05). Parallelism is bounded by
  the path-claim graph — disjoint claims fan out, overlapping claims get a
  dependency edge and run serially — not by a worker count. Hundreds of
  concurrent workers is a supported shape; cost stays bounded by the per-epic
  token cap above, which fan-out does not increase. `epic.max_in_flight_tasks`
  exists for an operator who wants a wall-clock or rate-limit bound of their
  own — a provider's concurrent-request limit, a laptop's CPU count — and is
  `null` unless they set one. It is not the mechanism that bounds spend.
- Escalation ladder: after 2 failed rounds on a task, escalate coder
  sonnet → opus **automatically** (logged); after 3, escalate to operator.

## context window (factory-wide, added 2026-08-05)

- **Auto-compact at 60%.** Every session that builds — planner, coder,
  tester, researcher, uiux, scribe, and the operator-side `/bs` loop session
  — compacts its context when it reaches **60%** of the model's window. Not
  at 90%, not when a tool call starts failing.
- **Why 60%, not later:** the remaining 40% is the room needed to *act* on
  the summary. A session that compacts at 90% knows what to do and has no
  budget left to do it — that is what produces re-read loops, dropped
  constraints, and half-applied edits.
- **Compaction is a handoff, not a summary.** Keep: epic/task ids and the
  live plan version, claimed globs, decisions taken and why, done vs.
  remaining, open questions. Drop: raw file contents, raw tool output,
  superseded reasoning — those are on disk or in the event log and can be
  re-read on demand.
- **Compaction never resets a budget.** Tokens spent before it still count
  against the task/epic caps in `budgets.yml`; compacting is not a way around
  the 150k coder cap.
- **One compaction per task.** A second means the task is over-scoped: stop
  and return `economy.budget-exceeded` to the planner for splitting, exactly
  as a token-cap hit does. Chained compactions are how a session quietly
  loses the contract it was given.
- **Judges and the merger never compact — they narrow.** reviewer, verifier,
  grader, spec-reviewer, security-reviewer and merger hold evidence rather
  than build on it: a judge that compacts summarizes away the diff it is
  judging, and a merger that compacts loses one side of the conflict. At 60%
  a judge returns a verdict on the evidence it holds (or reports insufficient
  evidence); the merger escalates to the operator.
- **Durable state goes to the event log, not the context window**
  (architecture §7). Anything that must survive a compaction is an event or a
  result artifact. The window is working memory; the log is memory.
- Enforcement is prompt-level today (baked into `.claude/agents/*`);
  it becomes mechanical with the phase-9 loop daemon.

## cross-check (phase 8)

- Providers: **Codex (OpenAI) + DeepSeek**; keys to be provisioned at
  phase 8 kickoff.
- Quorum triggers (all four, nothing more): `S1-stop-the-line`/`S2-major`
  findings before blocking ·
  epic final verdict · same-mistake findings · low-confidence planner
  verdicts.

## notifications

- **Slack DM for blocking items** (escalations, waiver batches, PR-ready);
  dashboard for everything else.
- Operator reviews **only the integration PR per epic**; task PRs remain
  readable for audit.
- Lesson candidates: **weekly batch review** in the UI.
