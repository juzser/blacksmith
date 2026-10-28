# Trial methodology: plain Claude Code versus Blacksmith

This document fixes how the trial is designed and what it records, before any
run exists. It contains no result. The results template is
[results.md](results.md); every number in it reads NOT MEASURED until a run
fills it.

Running the trial, and the spend it causes, is the operator's decision. Nothing
in the repository runs it, and no document here assumes it has been run. The
harness that prepares and records a run is described in
[trial/README.md](../../trial/README.md); the task corpus lives under
[trial/tasks/](../../trial/tasks/).

## The question

For the same coding task, given the same prompt and the same starting
repository, does a session driven through Blacksmith produce a different
outcome from a plain Claude Code session, and at what cost in tokens, time,
diff size and operator effort? The trial measures these quantities for the runs
the operator chooses to make. It does not assume a direction.

## The two arms

Both arms start from a fresh copy of the sample app, prepared by the harness
from the same task directory, with the same start state and the same prompt
text. The prompt is copied verbatim from the task's prompt file; neither arm
gets extra hints.

| Arm | How it is run |
| --- | --- |
| `plain` | A Claude Code session in the prepared directory, given the prompt as written. No Blacksmith plugin, plan or factory verbs are used. |
| `blacksmith` | A Claude Code session in the prepared directory with Blacksmith installed, given the same prompt as written. The session may use the factory's own flow (plan, dispatch, gate, report) as it normally would. |

The harness `prepare` step prints the prompt and the command to run; it never
launches Claude Code itself. The operator starts each session by hand, so the
decision to spend is theirs for every single run.

## Task kinds

Five task kinds ship in [trial/tasks/](../../trial/tasks/). Each directory holds
a manifest, a prompt and a hidden check split into two parts.

| Kind | Start state |
| --- | --- |
| `db-schema-change` | The sample app as shipped. |
| `fe-be-feature` | The sample app as shipped. |
| `large-refactor` | The sample app as shipped. |
| `multi-file-bug` | The sample app with the task's start patch applied. |
| `rest-endpoint` | The sample app as shipped. |

Each kind carries two checks, borrowed from the SWE-bench split:

- FAIL_TO_PASS: files that fail on the start state and must pass for the work
  to count as done. If these stay red, the run did nothing.
- PASS_TO_PASS: files that pass on the start state and must stay passing. If
  these go red, the run broke something that worked.

A run's check outcome is `passed` only when every FAIL_TO_PASS and every
PASS_TO_PASS file passes. One failing file in either group is `failed`. A check
that could not run is `not-run`, and a check that errored is `unknown`;
neither is ever read as `passed`. The checks are hidden: the agent is not shown
them, and the harness runs them only at record time.

## Metrics

Recorded for both arms:

- Check outcome: `passed`, `failed`, `not-run` or `unknown`, as above.
- Transcript tokens: the sum over the run's transcript of input tokens, cache
  creation input tokens and output tokens. Cache reads are not counted. A
  response repeated in the transcript under the same message id and request id
  counts once. This is the same definition the dashboard budget uses. The total
  carries a completeness flag: when a transcript file is missing, unreadable or
  holds an unparseable line, the total is a floor and is reported as "at
  least", never as an exact figure. With no transcript found the value is NOT
  MEASURED.
- Wall clock: the span between the first and last timestamp of the run's main
  transcript, or NOT MEASURED when no transcript is found. It is never
  estimated.
- Diff size: files changed, lines added and lines removed against the start
  commit.
- Operator interventions: the number of times the operator had to step in,
  entered by hand when the run is recorded. When it is not entered it reads NOT
  MEASURED; it is never inferred from the transcript.

For the `blacksmith` arm only, the factory's own log also supports the
effectiveness metrics: tokens per task and per role with an unattributed bucket
and its completeness, escaped defects (a defect a later stage found that an
earlier gate had passed), and review precision per role. The `plain` arm has no
factory log, so it has no counterpart for these. They are read next to the arm
comparison and never substituted for the shared metrics above.

## Record fields

The harness appends one JSON line per run with exactly these fields:

| Field | Meaning |
| --- | --- |
| `task_kind` | The task directory name. |
| `arm` | `plain` or `blacksmith`. |
| `check` | `passed`, `failed`, `not-run` or `unknown`. |
| `tokens` | The token total and its completeness flag, or null. |
| `wall_clock_ms` | The transcript span in milliseconds, or null. |
| `diff` | Files changed, lines added and lines removed. |
| `interventions` | The operator's count, or null. |
| `cli_session_id` | The Claude Code session id the run was read from. |
| `recorded_at` | When the record was written. |
| `harness_version` | The harness version that wrote it. |

A missing value is stored as null and printed as NOT MEASURED. The summary
labels every cell with its run count and says "single-run" for a cell holding
one run.

## What a single run can and cannot show

A cell with one run is labelled single-run. It shows that the run happened and
what that run produced. It does not show a typical outcome, a difference between
arms, or that either arm is better. Model output varies between sessions, so one
run per cell cannot separate an arm's effect from chance. The summary computes
no mean and no ratio from fewer than one recorded run per cell, and a figure
built from single runs is never described as a finding about Blacksmith.

## Threats to validity

- Variance. Two sessions on the same prompt can differ; one run per cell cannot
  bound that.
- Corpus size. Five kinds on one small sample app say little about other
  codebases, languages or task sizes.
- Prompt sensitivity. A prompt written for one task may favour one way of
  working. The identical prompt controls for the text, not for its fit.
- Operator effect. The operator starts both arms and counts interventions by
  hand, so the count depends on their judgement and attention.
- Hidden checks. A passing check shows the named behaviour works, not that the
  change is well made or maintainable.
- Model and tooling drift. The model, the Claude Code version and the
  Blacksmith version can change between runs; record them next to the results.
- Token floor. A missing transcript makes a total a floor, and the two arms may
  lose different amounts, since a factory run spawns sub-agent transcripts.
- Order and learning. An operator who has seen one arm's run may prompt or judge
  the other differently.

## Relation to agent-bench

The roadmap's agent-bench milestone is a different thing: a benchmark that lets
the factory answer whether a change to itself made it better, with machine
gradable criteria and a resumable harness over a fixed corpus. This trial
overlaps it in two ways only: it borrows the FAIL_TO_PASS and PASS_TO_PASS
split for its checks, and it keeps a small fixed task corpus.

It is not that benchmark. It has no epochs, no repeats, no error bars and no
statistical claim. What is left to agent-bench is repeated runs per cell,
variance estimates, regression tracking across factory versions and any
conclusion about whether a change helped. A trial table, however full, is
evidence of what those runs recorded and nothing more.
