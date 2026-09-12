# Agent interviews — index

[`agent-interviews.md`](agent-interviews.md) is 39 kB and is cited by id
(`agent-interviews.md N-9`, `M-6`), never whole. Its ids are bold inline
leads (`**N-9. …**`), not headings, so a cite cannot be resolved with
`grep -n '^## N-9'` the way an architecture `§` or a `D-nnn` can. This file
is the map: one row per id, the lines it spans, the heading it sits under,
and one clause on what it decided.

**Read the id's paragraph, not the file.** The line ranges below are the
`sed -n '<from>,<to>p' docs/specs/agent-interviews.md` an agent should run;
an item runs from its bold lead to the line before the next lead or heading.
If the file has been edited since this index was written, re-find the lead
with `grep -n '^\*\*N-9\.' docs/specs/agent-interviews.md` — the lead text is
stable, the line number is not. The test
`factory/orchestrator/test/agentInterviewsIndex.test.ts` fails when a row
here no longer points at its lead, so a stale range is loud rather than
silent.

## Two ids called `M-1`

The file defines `M-1` twice, with different meanings:

| Which | Lines | Heading | Meaning |
|---|---|---|---|
| merger `M-1` | 101-104 | `## merger` | Conflict confidence — the merger self-resolves only mechanical conflicts |
| roster `M-1` | 145-155 | `## M. Roster verification` › `### Model independence` | Verifier independence — the verifier must not share the reviewer's model |

A cite of `M-1` from outside the merger's own section means the roster one:
`docs/standards/agent-constraints.md` "M-1 → M-3" is the roster's M-1, M-2,
M-3. This index records the collision and does not fix it — renaming either
id is a content change to a signed interview, and a separate decision.

## Role questions (Phase 1) — lines 14-131

One `## <role>` section per role. Each item is a question with a
recommended answer and a `> Answer:` line; the coder's four carry a
recorded answer inline (`✅ Recorded`), the rest are recorded in
`docs/standards/agent-constraints.md`, which is the compiled output.

| Id | Lines | Heading | Question |
|---|---|---|---|
| `P-1` | 16-19 | `## planner` | Decomposition granularity — tasks sized to the coder caps, split further before dispatch |
| `P-2` | 21-25 | `## planner` | Spec depth — what a task spec carries beyond the contract minimum |
| `P-3` | 27-29 | `## planner` | Research budget — the share of an epic spent on research/uiux before code |
| `P-4` | 31-34 | `## planner` | Re-plan trigger — notify the operator on a task's second bounce |
| `C-1` | 38-39 | `## coder` | Token cap per task — recorded 150k; cap hit returns to the planner |
| `C-2` | 40-41 | `## coder` | Diff cap — recorded ≤400 changed lines; overrun returns to the planner to split |
| `C-3` | 42-45 | `## coder` | Abstraction policy — recorded strict YAGNI; a new abstraction needs ≥2 call sites in the epic |
| `C-4` | 46-48 | `## coder` | Over-engineering severity — recorded S3, auto-S2 once a matching lesson is approved |
| `C-5` | 50-52 | `## coder` | Context reading — the coder stays inside its claims and spec refs; unknowns become a research request |
| `T-1` | 56-59 | `## tester` | Test depth per feature severity — tiered: core flows get edge cases + e2e, chores happy-path |
| `T-2` | 61-64 | `## tester` | Flake policy — a new flaky test is S2 on the introducing task; pre-existing flakes are quarantined |
| `T-3` | 66-70 | `## tester` | Screenshot judgment — screenshots always; video only when the criteria mention interaction |
| `R-1` | 74-76 | `## reviewer` | Review scope — diff plus blast radius within the epic's claims |
| `R-2` | 78-80 | `## reviewer` | Finding budget — top 10 by severity per round; the rest go to a notes list |
| `R-3` | 82-86 | `## reviewer` | Style commentary — none where the linter enforces it; `S4-nit` at most elsewhere |
| `V-1` | 90-92 | `## verifier` | Verification stance — refute S1/S2 by default; spot-check 20% of S3 |
| `V-2` | 94-97 | `## verifier` | Evidence bar — a finding survives only with a concrete failure scenario |
| `M-1` (merger) | 101-104 | `## merger` | Conflict confidence — self-resolve only purely mechanical conflicts; semantic ones escalate |
| `S-1` | 108-110 | `## scribe` | Summary length caps — PR bodies ≤300 words; timeline entries one sentence |
| `RS-1` | 114-117 | `## researcher` | Source policy — repo and official docs first; broader web only when the brief allows it |
| `RS-2` | 119-121 | `## researcher` | Brief size cap — ≤600 words plus citations, structured |
| `U-1` | 125-130 | `## uiux` | Spec fidelity — component-level, tokens named only where the design deviates |

## M. Roster verification (opened 2026-08-05) — lines 132-354

What became load-bearing when the templates moved to `.claude/agents/` and
Claude Code started dispatching them as subagent types. Every item carries a
`> Answer: ✅ Recorded 2026-08-05` block; two carry later addenda (M-4
corrected 2026-09-11, M-5 superseded 2026-09-03).

| Id | Lines | Heading | Decision |
|---|---|---|---|
| `M-1` (roster) | 145-155 | `### Model independence` | Verifier independence — the verifier runs on a model other than the reviewer's |
| `M-2` | 157-165 | `### Model independence` | Grader independence — the grader stays on the coder's tier; rubric-bounded, highest-volume role |
| `M-3` | 169-192 | `### Frontmatter that is currently inert` | Reasoning effort — `effort:` set per tier on every template |
| `M-4` | 194-217 | `### Frontmatter that is currently inert` | `maxTurns` — corrected 2026-09-11: Claude Code does enforce it; the template is the limit and the prompt restates it |
| `M-5` | 221-295 | `### Topology under uncapped fan-out` | Who dispatches — the dispatching node must own the event log for what it dispatches; superseded by the `wave-runner` grant in `factory/policies/delegation.yml` |
| `M-6` | 297-319 | `### Topology under uncapped fan-out` | Return discipline — a worker writes its result file and returns only `{status, severity_counts, artifact_path}`; no concurrency cap |
| `M-7` | 323-339 | `### Tool grants that contradict the role` | Researcher web access — `WebFetch`/`WebSearch` granted; fetched text is data |
| `M-8` | 341-353 | `### Tool grants that contradict the role` | Scribe log access — `Grep`/`Glob` granted so it can find an event without being handed the log |

## N. Per-role contract verification (opened 2026-08-05) — lines 355-660

Each template read against the code that consumes its output; the two
result and finding schemas are `additionalProperties: false`, so a template
that names the wrong field fails the gate rather than degrading. Every item
carries a `> Answer: ✅ Recorded 2026-08-05` block.

| Id | Lines | Heading | Decision |
|---|---|---|---|
| `N-1` | 369-398 | `### Output contracts (the two blocking ones)` | The dispatcher owns the result envelope (`task_id`, `agent`, `provider`, `model_tier`); the agent returns the rest and nothing else |
| `N-2` | 400-420 | `### Output contracts (the two blocking ones)` | Judges return evidence only; the orchestrator mints `finding_id`, `finding_status`, `found_by` and computes `fingerprint` |
| `N-3` | 422-434 | `### Output contracts (the two blocking ones)` | Severity strings — the taxonomy's four canonical values written out in every template |
| `N-4` | 438-458 | `### Per-role gaps` | Round counting — derived from `dispatch_decision` events; the escalation ladder and the grader's 2-round cap live in the dispatch contract |
| `N-5` | 460-480 | `### Per-role gaps` | No fifth event type — a worker returns `research_request` in `structured_output` and the dispatcher acts on it |
| `N-6` | 482-499 | `### Per-role gaps` | Screenshots have a reader — uiux owns the post-test visual pass, gated three ways |
| `N-7` | 501-516 | `### Per-role gaps` | Security-reviewer trigger — sensitive-path globs are data in `factory/policies/sensitive-paths.yml`, evaluated by a command |
| `N-8` | 518-532 | `### Per-role gaps` | `security` joins the lesson scopes, read across roles |
| `N-9` | 534-565 | `### Per-role gaps` | Lessons are spliced at dispatch, and only approved ones; nothing auto-promotes |
| `N-10` | 567-588 | `### Per-role gaps` | Judges keep `Bash`; "you never modify the worktree" is the property, enforced by a guard and a fingerprint, not by prose |
| `N-11` | 590-621 | `### Per-role gaps` | Planner and scribe write roots — checked against a declared root after each return |
| `N-12` | 623-659 | `### Per-role gaps` | Merger worktree — the rebase runs in the task's own worktree; no dedicated merge worktree |

## Calibration schedule — lines 661-674

`## Calibration schedule (v3.1 — when these interviews get re-run)`: the
three re-interview triggers (first real-data checkpoint, per-agent trigger,
quarterly steady state). Not an id; cite the heading.
