# Operator guide

The deep version of [the operator loop](operator-loop.md): a full walkthrough
with real `smith` commands, what each gate outcome means, severity/waiver
semantics from the operator's chair, budget alarms and the escalation ladder,
how lessons get approved, and today's limitations.

Every command in it was run against a built `factory/orchestrator/dist/cli.js`
on `main` while writing this doc; flag names and output shapes are copied
from the actual JSON the CLI printed, not from the source alone.

**This file is the index, not the guide.** The guide is the nine files under
[`operator-guide/`](operator-guide/) below. An operator reads it one question
at a time — "was the critic actually adversarial?", "why is the gate holding
this?" — and an agent handed the whole thing pays for the eight parts it did
not ask about, which is the same 180 kB every time. So the split is by *when
you reach for it*, in the loop's own order.

Section numbers did not change. §5 is still the `smith gate run` section, now
in [`operator-guide/queue-and-gate.md`](operator-guide/queue-and-gate.md), so
every citation of a section number elsewhere in this repo still names the text
it always named — only the file it lives in moved.

## [Setting up](operator-guide/setup.md)

Before the first dispatch: build the CLI, read what the epic's effort
tier buys, create the project the factory builds in, validate the plan.

- [0. Build once](operator-guide/setup.md#0-build-once)
- [0a. `smith effort show` — how much judgment this epic buys](operator-guide/setup.md#0a-smith-effort-show--how-much-judgment-this-epic-buys)
- [0b. `smith new` — the project the factory builds in](operator-guide/setup.md#0b-smith-new--the-project-the-factory-builds-in)
- [1. Plan JSON → `smith plan validate`](operator-guide/setup.md#1-plan-json--smith-plan-validate)

## [The wave and its dispatch audits](operator-guide/wave.md)

Admitting a wave, and the five audits that ask whether the dispatches
inside it were real ones.

- [2. `smith wave check`](operator-guide/wave.md#2-smith-wave-check)
- [2a. `smith security triggers` — the security-reviewer's dispatch condition](operator-guide/wave.md#2a-smith-security-triggers--the-security-reviewers-dispatch-condition)
- [2b. `smith dispatch check` — was the critic actually adversarial?](operator-guide/wave.md#2b-smith-dispatch-check--was-the-critic-actually-adversarial)
- [2c. `smith escalation check` — did the ladder actually get climbed?](operator-guide/wave.md#2c-smith-escalation-check--did-the-ladder-actually-get-climbed)
- [2d. `smith tester check` — did a tester grade the code, or did the coder?](operator-guide/wave.md#2d-smith-tester-check--did-a-tester-grade-the-code-or-did-the-coder)
- [2e. `smith delegation check` — did the node that dispatched own its log?](operator-guide/wave.md#2e-smith-delegation-check--did-the-node-that-dispatched-own-its-log)

## [Worktrees and judges](operator-guide/worktrees-and-judges.md)

Creating a task worktree, proving a judge did not edit what it judged,
fencing text that arrived from outside, and holding a dispatched judge
to a report.

- [3. `smith worktree create`](operator-guide/worktrees-and-judges.md#3-smith-worktree-create)
- [3a. `smith worktree fingerprint` / `verify` — the judge-immutability guard](operator-guide/worktrees-and-judges.md#3a-smith-worktree-fingerprint--verify--the-judge-immutability-guard)
- [3b. `smith prompt wrap` / `smith research check` — ingested text is data](operator-guide/worktrees-and-judges.md#3b-smith-prompt-wrap--smith-research-check--ingested-text-is-data)
- [3c. `smith judge dispatch` / `report` / `outstanding` — a dispatched judge must report back](operator-guide/worktrees-and-judges.md#3c-smith-judge-dispatch--report--outstanding--a-dispatched-judge-must-report-back)

## [The queue and the gate](operator-guide/queue-and-gate.md)

The merge queue and the gate: what each outcome means, why a green gate
used to prove nothing, one epic across several sessions, and evidence
that names the file a criterion names.

- [4. `smith queue run`](operator-guide/queue-and-gate.md#4-smith-queue-run)
- [5. `smith gate run`](operator-guide/queue-and-gate.md#5-smith-gate-run)
- [5a. The commit check — why a green gate used to prove nothing (D-30)](operator-guide/queue-and-gate.md#5a-the-commit-check--why-a-green-gate-used-to-prove-nothing-d-30)
- [5b. One epic across several sessions — `smith event lineage`](operator-guide/queue-and-gate.md#5b-one-epic-across-several-sessions--smith-event-lineage)
- [5c. `smith coverage check` — evidence that names the file the criterion names](operator-guide/queue-and-gate.md#5c-smith-coverage-check--evidence-that-names-the-file-the-criterion-names)

## [Findings and spec defects](operator-guide/findings.md)

Reading the finding list, amending a plan when the plan is what is
wrong, and the worker-proposed spec change.

- [6. `smith findings list`](operator-guide/findings.md#6-smith-findings-list)
- [6a. Spec findings + `smith plan amend` — when the plan is what is wrong](operator-guide/findings.md#6a-spec-findings--smith-plan-amend--when-the-plan-is-what-is-wrong)
- [6b. Worker-proposed spec changes — the third exit](operator-guide/findings.md#6b-worker-proposed-spec-changes--the-third-exit)

## [Closing an epic](operator-guide/closing-an-epic.md)

Quorum and verdict, the one check that sees the assembled branch, the
closing spec review, the second eye, the goal-check and the width
report.

- [7. `smith plan quorum` + `smith epic verdict`](operator-guide/closing-an-epic.md#7-smith-plan-quorum--smith-epic-verdict)
- [7a. `smith integration check` — the only command that sees the branch](operator-guide/closing-an-epic.md#7a-smith-integration-check--the-only-command-that-sees-the-branch)
- [7b. `smith epic close` — the verdict, written down](operator-guide/closing-an-epic.md#7b-smith-epic-close--the-verdict-written-down)
- [7c. `smith epic spec-review` — reading the plan against the code that exists](operator-guide/closing-an-epic.md#7c-smith-epic-spec-review--reading-the-plan-against-the-code-that-exists)
- [7d. `smith crossfind` — a second eye, not a second vote](operator-guide/closing-an-epic.md#7d-smith-crossfind--a-second-eye-not-a-second-vote)
- [7e. `smith epic goal-check` — the plan against the goal it was cut from](operator-guide/closing-an-epic.md#7e-smith-epic-goal-check--the-plan-against-the-goal-it-was-cut-from)
- [7f. `smith epic width` — does this factory build in parallel?](operator-guide/closing-an-epic.md#7f-smith-epic-width--does-this-factory-build-in-parallel)

## [Severity, waivers and budget](operator-guide/severity-and-budget.md)

What each severity buys, what a waiver costs, and the alarm that counts
a budget instead of remembering it.

- [8. Severity + waiver semantics, from the operator's chair](operator-guide/severity-and-budget.md#8-severity--waiver-semantics-from-the-operators-chair)
- [9. Budget alarms + the escalation ladder](operator-guide/severity-and-budget.md#9-budget-alarms--the-escalation-ladder)
- [9a. `smith budget alarm` — the alarm, counted instead of remembered](operator-guide/severity-and-budget.md#9a-smith-budget-alarm--the-alarm-counted-instead-of-remembered)

## [Lessons and the daemon](operator-guide/lessons-and-daemon.md)

How a lesson gets approved, whether it moved the repeat rate, which
entries still earn their place, and the same folds without an open
session.

- [10. How lessons get approved](operator-guide/lessons-and-daemon.md#10-how-lessons-get-approved)
- [10a. `smith kpi same-mistake` — the rate, and whether it could have been anything else](operator-guide/lessons-and-daemon.md#10a-smith-kpi-same-mistake--the-rate-and-whether-it-could-have-been-anything-else)
- [10b. `smith lessons audit` — which entries still earn their place](operator-guide/lessons-and-daemon.md#10b-smith-lessons-audit--which-entries-still-earn-their-place)
- [11. `smith daemon` — the same folds, without an open session](operator-guide/lessons-and-daemon.md#11-smith-daemon--the-same-folds-without-an-open-session)

## [Limitations today](operator-guide/limitations.md)

What this factory does not do yet, and which parts of that are a
decision rather than a gap.
