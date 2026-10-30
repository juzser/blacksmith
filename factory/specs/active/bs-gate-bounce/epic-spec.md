# Epic bs-gate-bounce: fewer gate bounces

Status: **plan v7, the amendment that answers the closing review's round 3;
the epic closes under it.** The operator signed off v1 on 2026-10-23 (event
bs-gate-bounce-2026-10-23#30). v2 brought it up to main at `99e7fe64` and
added task-6 (operator answer 1a, bs-gate-bounce-run-2026-10-29#2). v3 and v4
each widened one task's claims, with its text to match, on an
operator-approved proposal: v3 gave task-3 `test/paperwork.test.ts`
(bs-gate-bounce-run-2026-10-29#71), and v4 gave task-4
`test/templateFragments.test.ts` (bs-gate-bounce-run-2026-10-29#103). v5
added task-7 for the five findings of the closing spec review
(bs-gate-bounce-run-2026-10-29#143). v6 added task-8 for the three findings
of that review's round 2 (bs-gate-bounce-run-2026-10-29#189, judge report
#190). v7 added task-9 for the three findings of the review's round 3
(bs-gate-bounce-run-2026-10-29#282, judge report #283). Tasks 1 to 9 are
merged, and so are task-8's three follow-ups (`followup-6903d792`,
`followup-0265fb47`, `followup-47b38469`), at integration head `ad8af20c`.
Effort tier: medium. The live epic cap is 52M tokens, with the alarm at
70% = 36.4M, set by the env override `SMITH_EPIC_CAP_TOKENS_MEDIUM`, as
`bs budget alarm` reports (`capTokens`, `budgetEnvOverrides`).
`budgets.yml`'s own medium cap, 16M with the alarm at 11.2M, is not the one
enforced.
Operator priority for every trade-off: quality first, then speed, then tokens.

This is the living spec for the epic. Every worker reads it before starting.
No worker edits it, because it sits outside every task's claims: each worker
puts one Progress line in its result `notes`, and the epic session copies it
in at merge. The planner owns its accuracy.

## Goal

The per-task gate (`bs gate run`) bounces too many tasks back to their
workers. This epic removes the two causes that keep repeating.

1. **Paperwork preflight.** Before the coder, tester or grader hands back,
   it runs the gate's own cheap validators over the part of the paperwork its
   own hand-off can already satisfy:
   - a schema-invalid result envelope (coder, tester);
   - a declared artifact that is missing, or that sits outside the task's
     artifact home (coder, tester);
   - uncommitted work or missing dependencies in the worktree (coder);
   - a screenshot that is missing or misnamed (tester);
   - a grader file with the wrong shape (grader). A well-formed fail verdict
     is not a paperwork problem.

   The wave-runner runs the full set before it calls `gate run`, with the
   gate line's own flags. That adds what only exists once it has dispatched
   and recorded the judges: an outstanding judge turn and a missing uiux spec
   or visual turn. The preflight is one read-only verb,
   `bs results check --as <coder|tester|grader|gate>`. It runs **no** test
   command.
2. **Root causes of `tests-failed`, `execution.flaky-test` and
   `execution.env-failure`.** Every fix makes a test or its environment
   deterministic. The gate records clock and load evidence for every check.
   When a failed check's own clock gap shows the machine slept, it
   classifies the block as an environment failure. Load is evidence only.
   The block still stands.
3. **A gate bounce counts toward its lesson class.** Added by the operator
   (answer 1a, bs-gate-bounce-run-2026-10-29#2). A lesson's error class
   recurs only through `error-logged` today, and a gate `blocked` writes
   only `gate-outcome`, so the most common failure never makes its class
   recur. A blocked gate outcome now counts toward the class its reason
   maps to, or toward the class the gate stamped on it.

## Evidence this rests on

Research briefs and results, under `state/artifacts/bs-gate-bounce/plan-v1/`
and `state/results/bs-gate-bounce.research-*.json`. Every recommendation
used here cites code and the event log, not web pages.

**Paperwork:** 106 of 221 blocked gates.

| Reason | Blocks | Cause |
|---|---|---|
| `schema-invalid` | 47 | 40 are unstamped envelopes: the `gate run` example in wave.md step 7 omits `--agent/--provider/--model-tier`, while step 5's `results record` example has them. 7 are worker shape errors. |
| `artifacts-missing` | 26 | 24 are text evidence that was declared but never written. 3 escape the artifact home. |
| `screenshots-missing` | 15 | 12 have a wrong path suffix. bs-tester.md allows a "description" fallback that the code never reads. |
| `grader-invalid` | 7 | 4 put the verdict outside `structured_output`, 1 is missing criteria fields, 2 have round > 2. |
| `uiux-visual-missing`, `uiux-spec-missing`, `screenshots-stale` | 7 | |
| `not-committed` | 4 | |

A bounce costs a median of 142 s, p90 1291 s, before counting the
re-dispatch.

**Tests:** 85 `tests-failed` blocks, 76 in dogfood epics and 9 in this repo.

| Cluster | Blocks |
|---|---|
| Unit timeouts under load | 35 |
| e2e under load, stale servers holding ports | 17 |
| Lint or typecheck failing because the coder ran only a scoped lint | 14 |
| Teardown and coverage-dir races | 4 |
| Machine sleep or heavy load in this repo | 5 |
| Wall-clock tests in this repo | 3 |

The two recurring tests named in this repo are:
- `test/cli.test.ts`, the daemon per-tick test. It needs two real ticks
  inside a 15 s wall-clock wait.
- `test/providers/cli-transport.test.ts`, the process-group timeout test.
  It uses a 200 ms timer that can fire before the fixture's grandchild.pid
  holds a parseable pid; the file can exist while it is still empty.

## Precondition: bs-optimize and bs-review landed first

Both epics have merged to main: bs-review as #499 and bs-optimize as #501.
Plan v1 was cut against the bs-optimize integration tip (`ced3feb5`). Plan v2
re-checked it against main at `99e7fe64` (the 0.6.0 release), which also
carries the split of the old CLI test file into one test file per command
family (#502). The overlap that held this epic back was:

| Task, open at v1 | Files it shared with this epic |
|---|---|
| bs-optimize task-10 | `cli.ts`, `usage.ts`. It also added `bs heavy run`, which the hand-back steps here name. |
| bs-optimize task-11 | `bs-coder.md`, `bs-tester.md`, `bs-grader.md`, the `heavy-run` shared fragment, `CHANGELOG.md` |
| bs-review tasks 7, 13, 17 | `cli.ts`, `usage.ts` |
| bs-review task 16 | `CHANGELOG.md` |

All of it is on main now. Each worktree in this epic is cut from main.

## Acceptance criteria

Each criterion is measurable and maps to the tasks that deliver it.

| # | Criterion | Tasks |
|---|---|---|
| AC1 | **One implementation, one stage set per role.** The paperwork verdicts come from functions in one module (`src/paperwork.ts`, which calls the existing validators in `artifacts.ts`, `commit.ts`, `uiuxGate.ts` and the schema validator). The gate calls the same functions. No validator logic is duplicated. Each role checks only what its hand-off can satisfy: coder = schema, artifacts, commit, deps; tester = schema, artifacts, its own screenshots; grader = grader shape; gate = every paperwork stage in the gate's order. For the gate, `screenshots-missing` is the uiux stage's verdict; the tester's own screenshot check uses the same screenshot-set function, so the two agree on the same shots. A stage not checked is reported as skipped, with why. A well-formed grader fail verdict is reported as a verdict and never blocks the preflight; the gate's own `grader-fail` block is unchanged. Parity tests run the gate and the preflight on each paperwork-defect fixture and require the same blocking reason: unstamped envelope, worker shape error, missing artifact, artifact outside the home, uncommitted worktree, missing deps, outstanding judge turn, three grader shapes, misnamed screenshot, missing combo, uiux spec missing, uiux visual missing. On the clean fixture both pass. In gate mode, the judge turns the gate line would close are dry-run with the same checks `judge report` makes, and count as reported. | task-1, task-2 |
| AC2 | **The preflight is read-only and runs no test command.** `bs results check` leaves the event log, the results directory, the worktree and its git index unchanged (it never refreshes the index or takes `index.lock`) and spawns no check command. In gate mode it parses the gate line's checks file but never runs it. It exits 0 only on pass and 1 on a block or a refused flag, prints one JSON document with the gate's own reason names, and turns malformed or hostile input into a named block, never a pass. It reports the artifact home it checked. `usage.ts` documents it. | task-2, task-7 |
| AC3 | **The gate still runs every check itself, in today's order.** Every existing assertion in `gate.test.ts`, `uiuxGate.test.ts`, `testgate.test.ts` and `artifacts.test.ts` still holds unchanged. None is removed, loosened or reordered. | task-1, task-3 |
| AC4 | **Workers and the wave-runner preflight before hand-off.** bs-coder.md, bs-tester.md and bs-grader.md give the exact per-role `bs results check --as <role>` line to run before returning. wave.md step 5's `results record` line, step 7's `gate run` line, step 7's `--as gate` preflight line and every per-role line carry one and the same `--artifacts-dir <work-root>/state/artifacts`, and wave.md says why the flag is explicit (finding 114d979e). The grader fixes shape only and never changes a verdict to get a clean preflight. wave.md step 7 runs `--as gate` with the gate line's flags before `gate run`. wave.md's `gate run` example carries `--agent/--provider/--model-tier` exactly as step 5's `results record` does. bs-tester.md states the `-<desktop\|mobile>-<light\|dark>.png` filename rule in both places it names screenshots and offers no description fallback in either (finding d66a6e78). The coder and tester hand-back names the gate's full command list: the full test command, typecheck, typecheck:test and a whole-repo `biome check .`, never a scoped path. Only the full test command (and e2e) goes through the template's heavy-run section, started with `bs heavy run` and waited for with `bs heavy wait`; lint and type checks run directly, as wave.md step 7's "Heavy checks" rule says. The heavy-run fragment is unchanged (finding dd43a7e5). `bs brief compose` writes each coder's, tester's and grader's filled line into its brief, with every value shell-quoted, the one `--artifacts-dir` steps 5 and 7 carry, and the result file the worker writes (the tester's own `state/results/<task-id>.tester.json`, never the coder's), and each coder's and tester's gate check commands, the heavy ones marked for the template's heavy-run section; it refuses to compose such a brief without them, and `bs dispatch lint` exits 1 on a coder, tester or grader brief that lacks them (findings fdeb317e, 9de7c928, c4cd9084, 99d9be8b, 65a64a1a, 13606fd6, 9c6ba61f). wave.md step 7 sends every preflight problem to the role that redoes the work, a grader's file to the grader's turn and never to `gate run`, and returns a worker's unreadable result at most once per task, whatever its role; step 9 bounces a blocked gate to the builder its reason names, the tester for `screenshots-missing` and `screenshots-stale` (findings 1e8e9e9b, 2afed53d, 4b5cc5cc). Step 9 gives every blocked reason, and each `judges-outstanding` and `coverage-evidence` case, exactly one answerer: the uiux reasons are a bounce to the uiux pass, a builder the ladder counts, and `grader-invalid` is the grader's turn. `bs brief compose` writes a follow-up's brief from the log's `task-added` record, with its own open findings as scope (block markers neutralised) and its preflight line and gate checks; every documented compose command carries the worker flags (findings 38ddc74d, 5c096bd9, 7d2c72ec, 9c1bb4d6, b3e3083c, 2d92075f, 105d3733, 05cec9f9). A test pins each of these. | task-4, task-7, task-8, task-9 |
| AC5 | **The gate records environment evidence.** The `testgate-result` payload carries, beside its check results and in their order, one evidence entry per check: wall-clock ms, monotonic ms and their gap; the 1-minute load average at start and end; the CPU count. The check results themselves keep their shape (finding 8de89739). A failed check whose own clock gap is at least `SLEEP_GAP_MS` (30 s) is blocked with reason `tests-failed`, and its `gate-outcome` also carries `error_class: execution.env-failure` and that evidence. Load never classifies; a gap on a passing check never classifies another check's failure. The outcome is never `pass`. Each check command runs exactly once per gate call. The clock window brackets the check's own process only: a heavy check's lock wait stays in `lock_wait_ms`, outside the gap, and a check whose lock wait timed out ran no command, carries an empty window and never classifies (finding b1e1257b). Tests use an injected clock, an injected load source and a temporary lock directory, never the machine's lock. | task-3; task-7 (the guide's env-failure section) |
| AC6 | **The wave-runner reads the classification without re-running.** wave.md says that an env-failure-classified block is logged as `error-logged` / `execution.env-failure` with the evidence. It raises no finding against the coder and does not automatically re-run the gate. Re-gating after the first failed round stays the orchestrator's existing decision, and a second env-classified block for the same task at the same HEAD goes to the operator. The block is a failed round on the escalation ladder like any other, and the ladder and its count are unchanged: a bare re-gate is open only after the first failed round; from the second, because the fault is not the builder's, the operator's logged answer comes first and only then, if the answer picks it, one builder dispatch on a strictly higher model tier (the answer may instead pick a re-scope under a new task id, or a waiver or closure), the rule every block no builder answers follows; and the third brings the operator (findings e1d0cbc4, 29686266, 446ee7cf). How `dispatch.md` describes the recurrence this record feeds is AC10's, not this row's (finding 6b79f994). | task-4, task-7, task-9 |
| AC7 | **The two named tests are deterministic in this repo.** The daemon per-tick test (now in `test/cliCrossfind.test.ts`, finding 7bca32cd) and the cli-transport process-group test no longer race a timer in the code under test: each waits on an event (a printed line; a pid file read and parsed, never its mere existence). The process-group test fails at once, saying so, if the judge call settles before the pid appears, instead of running to the test timeout. Every behaviour each one pinned is still pinned. No deadline or timeout is raised, and no production file changes. Each is shown to hold under an artificial startup delay. | task-5 |
| AC8 | **Nothing is weakened.** No diff in this epic adds `.skip`, `.todo`, `.fails`, `retry`, a quarantine list, or a larger timeout or deadline anywhere: `testTimeout`, `hookTimeout`, `timeout_ms`, the `waitForLines` default, `DEFAULT_TIMEOUT_MS`. No diff drops, weakens or reorders a gate stage, grader, judge, review round or verifier. Each task owns a diff-grep criterion: the coder pastes its output and justifies every hit, and the grader re-runs it. task-1's stage-order ladder test fails on any reorder of the paperwork stages. | all |
| AC9 | **Every task is marked factory-level or repo-level** in its summary, and the split below matches the plan. | plan |
| AC10 | **A blocked gate counts toward its lesson's error class.** Lesson recurrence counts a blocked `gate-outcome` as well as `error-logged`: under the `error_class` the gate stamped on it when it carries one (a slept run's `execution.env-failure` wins), else under the class its reason maps to in one exported map that holds every gate block reason. A reason mapped to no class counts nowhere. Distinct tasks per class, as today: a task blocked and logged under one class counts once, and an unqualified task id counts as it does for `error-logged` today (finding ae1aec38). The 30-day window, the 3-task threshold and the in-epic repeat are unchanged and apply to gate blocks too. The class is read at recurrence time, so the gate writes what it writes today. `dispatch.md`, the lessons guide and the limitations page state this and no longer say a gate block does not count. Tests written failing first pin: a blocked gate counts; an unmapped reason does not; the env override wins; one task counts once per class; the window; the in-epic repeat (findings a8609c17, 6b79f994). | task-6; task-3 pins the producer side |

## Factory-level and repo-level split

Factory-level fixes change the factory itself (worker templates, gate, CLI,
worktree setup), so they help every dogfood epic. Repo-level fixes change
only this repo's own tests. The plan prefers factory-level fixes. A
repo-level fix is in scope only for a named recurring failure.

| Task | Level | What changes |
|---|---|---|
| task-1-paperwork-validators | factory | gate validators extracted into one module; the gate calls it |
| task-2-results-check-verb | factory | the `bs results check` CLI verb |
| task-3-testgate-env-evidence | factory | the gate records clock and load evidence and classifies a slept run's block |
| task-4-handback-preflight-playbooks | factory | worker templates, wave playbook, gate docs, changelog |
| task-5-deterministic-named-tests | repo | the daemon per-tick test (`test/cliCrossfind.test.ts`) and the cli-transport timeout test; test files and the fixture only, no production change |
| task-6-gate-block-counts-toward-class | factory | lesson recurrence counts a blocked gate under its error class; the docs that stated the gap |
| task-7-close-review-fixes | factory | the closing review's fixes: `results check --as grader` takes the shared `--artifacts-dir` and the grader template says why; every preflight result maps to one branch, so a problem in an agent's file is a counted `gate run` round or a logged return bounded at one; the env-failure guide; the changelog wording |
| task-8-close-review-r2-fixes | factory | the closing review's round-2 fixes: a `grader-invalid` goes to the grader's turn, and a blocked gate bounces to the builder its reason names; `bs brief compose` writes each worker's preflight line and the gate's check commands, and `bs dispatch lint` fails a worker brief without them; one branch-4 return per task, in one sentence both docs share |
| task-9-close-review-r3-fixes | factory | the closing review's round-3 fixes: wave.md step 9 gives every blocked gate reason exactly one answerer, and a block no builder answers waits for the operator's answer from its second failed round; `bs brief compose` composes a follow-up's brief from the log, its own findings as scope and its preflight line and gate checks included; the documented compose commands carry the worker flags, and a test runs them |

Some recommended fixes were already delivered by bs-optimize, which merged
first (#501), so this epic does not repeat them:
- The heavy lock, which serializes full suites across worktrees: unit
  timeouts under load, e2e under load, and machine load in this repo.
- The cleanup rule that keeps any worktree whose directory holds the live
  heavy lock. That covers "a worktree or coverage dir removed mid-gate".

## Plan shape

### Plan v2 (history)

The shape v2 was cut with. v3 and v4 widened claims and kept it. Four waves,
widest three:

| Wave | Tasks | Why it waits |
|---|---|---|
| W1 | task-1, task-5, task-6 | nothing |
| W2 | task-3 | `gate.ts` is a hub file that task-1 and task-3 both edit, so they never run together. task-3 also pins that the field it writes is the one task-6 counts |
| W3 | task-2 | `cli.ts` imports `testgate.ts`, whose declarations task-3 changes, and `lessons.ts`, whose options interface task-6 re-documents; producers first. task-2 also adds one export to `judges.ts` and keeps every existing one |
| W4 | task-4 | documents and pins what tasks 1, 2, 3 and 5 built, and writes the changelog from the notes of tasks 1, 2, 3, 5 and 6 |

Read back from main with `bs claims impact` and `bs wave schedule`;
`plan.json`'s `planner_notes` record each crossing and how it is resolved.

### As merged

Into `bs/bs-gate-bounce/integration`, in this order: task-6 (`7fc9363f`),
task-5 (`721df7b8`), task-1 (`4ad38744`), task-3 (`06165e73`), task-2
(`5848c452`), the three follow-ups `followup-2782d7a8` (`c650a179`),
`followup-721ff26d` (`7c8a3b89`) and `followup-b5e0ec2a` (`ed5a1513`), then
task-4 (`6365aca3`). The integration check passed on `6365aca3`
(bs-gate-bounce-run-2026-10-29#137). Then, under plan v5, task-7
(`c917a05b`); under plan v6, task-8 (`1ebd02da`) and its three follow-ups
`followup-6903d792` (`e31063d9`), `followup-0265fb47` (`24f79cd3`) and
`followup-47b38469` (`f85c1b1c`). The closing review's round 3 read
`f85c1b1c`. Then, under plan v7, task-9 (`85ea8825`, integration
`ad8af20c`), the integration head the closing review's round 4 read.

### Plan v5

One task, task-7-close-review-fixes, with no edges: one wave, widest one. It
answers four of the closing review's five findings; the fifth is fixed in
this spec. Its fixes share queue-and-gate.md, the CHANGELOG and one test file,
so splitting them would only add tasks that cross on the same files. Read
back from the integration head with `bs claims impact` (clean, no crossings)
and `bs wave schedule` (one round, widest 1).

### Plan v6

One task, task-8-close-review-r2-fixes, with no edges: one wave, widest one. It
answers all three findings of the closing review's round 2. Its fixes share
wave.md, queue-and-gate.md and the hand-back tests, so splitting them would
only add tasks that cross on the same files. Read back from the integration
head `c917a05b` with `bs claims impact` (clean, no crossings) and
`bs wave schedule` (one round, widest 1). Task-8's reviewer raised three S4s,
each fixed in a follow-up outside the plan, after task-8:
`followup-6903d792`, `followup-0265fb47` and `followup-47b38469`.

### Plan v7

One task, task-9-close-review-r3-fixes, with no edges: one wave, widest one,
after task-8 and its three follow-ups. It answers all three findings of the
closing review's round 3 and the seven of the v7 draft's pre-code review. Its fixes share wave.md, the docs that print the
compose commands and the hand-back tests, so splitting them would only add
tasks that cross on the same files. Read back from the integration head
`f85c1b1c` with `bs claims impact` (clean, no crossings) and
`bs wave schedule` (one round, widest 1).

## Hard constraints

1. **Never** skip, quarantine, mark-flaky, auto-retry or loosen a test, or
   raise its timeout. **Never** drop, weaken or reorder a gate check, a
   grader, a judge, a review round or the verifier. A test that times out
   under load is fixed by making it deterministic or by removing the load,
   not by a longer timeout. Deterministic means event-driven waits, an
   injected clock, a mocked transport, per-test tmp dirs or port 0. The load
   is removed with the heavy lock.
2. When the machine sleeps, the gate may detect it from the failed
   check's own clock gap and record it with evidence (clock gap, load). It
   classifies the block as an environment failure. Load is evidence only. It
   must not pass the run and must not re-run it on its own. The block stands, and re-gating stays the orchestrator's
   existing decision.
3. The preflight reuses the gate's own validator functions: one
   implementation, called from both places. The gate still runs every check
   itself. The preflight is read-only and runs no test command. A test
   proves that the gate and the preflight return the same verdict on the
   same input.
4. Every fix is marked factory-level or repo-level, as in the table above.
5. Open source. No other project's name appears in any file this epic
   writes. Say "dogfood epics".
6. No task is cut finer than one coherent change with its own tests.
7. No role moves to a cheaper model tier.

## Rejected from the evidence

Three pieces of advice in the evidence conflict with the hard constraints.
None became a task.

- Research B's advice to "size `timeout_ms` for load" and to "re-run in
  full" conflicts with constraints 1 and 2.
- The compiled lesson `bs-audit-3-gate-timeout-under-load` advises raising
  `timeout_ms`. It conflicts with constraint 1, so the lesson does not apply
  to this epic's tasks. The heavy lock and deterministic tests replace it.

## Out of scope (later epics)

- Running `scripts/check.sh` steps in parallel.
- Cutting operator waits.
- The "sibling budget guard" cluster (6 blocks in dogfood epics). The
  evidence does not name a factory-level cause. See the open questions.
- e2e configuration inside dogfood repos (port 0 in their own playwright
  configs). This epic sets the rule in bs-tester.md; each repo's config is
  that repo's own work.
- A run-time check for the port-0 and stop-only-recorded-PIDs rule. In v1 it
  is a prompt-level rule, an accepted gap that queue-and-gate.md names; a
  violation surfaces only as a later `tests-failed` block.

## Open questions

Answered at the v1 sign-off (2026-10-23, answers 2A and 3A): load stays
evidence only and never classifies; the medium coder role cap in
`budgets.yml` stays 220k and the harness is unchanged. Still open:

- Sibling budget guards: is there a factory-level cause? Answering needs a
  research pass after this epic.
- `errorIssues.ts` maps a blocked gate to `gate.blocked.<reason>` and does
  not read the new `error_class`, so the issue tracker still reads an
  env-classified block as `gate.blocked.tests-failed`. task-6's map from a
  block reason to a lesson error class is a separate consumer and leaves
  those issue codes as they are.
- The merge queue's cumulative run (`integration.ts`) also builds check
  results. The epic records evidence on the per-task gate only; classifying
  the cumulative run would be a later task.

## Progress

One line per task, copied in by the epic session from the worker's result
`notes` at merge: task id, merged commit, and anything a later task must
know.

- task-6-gate-block-counts-toward-class: merged `a64e26cf` (integration `7fc9363f`). Blocked gate-outcomes count toward lesson recurrence through `GATE_BLOCK_ERROR_CLASSES`, `isRecurrenceEvent` and `recurrenceClassOf`, exported from `lessonRecurrence.ts`. `gate.ts` is untouched. `dispatch.md`, `lessons-and-daemon.md` and `limitations.md` state the end state.
- task-5-deterministic-named-tests: merged `9574f38f` (integration `721df7b8`). The daemon CLI per-tick test waits for one line (interval 3600) and SIGTERMs during the sleep. The cli-transport process-group timeout test uses fake `setTimeout`/`clearTimeout` and advances 200 ms only after `grandchild.pid` parses to a pid. The fixture's slow grandchild takes an optional start delay (argv[4]). No production change. One S3 raised (reviewer-r1-0): the per-tick loop checks only that `sessions`/`findings` are arrays, where the old test pinned `sessions == ['sess-cli']` on every line.
- task-1-paperwork-validators: merged `a13cc33e` (integration `4ad38744`). `src/paperwork.ts` holds one pure function per gate paperwork stage plus `checkPaperwork` with a stage set per role; `gate.ts` and `uiuxGate.ts` call it, with the lineage pinned by a characterization test. A tester's declared screenshots go to the screenshots stage only on a ui-affecting task; otherwise the artifacts stage checks them, matching `recordTaskResult`. The diff overran its cap at 2200 lines (operator-accepted, `#66`), and round 3 ran on the frontier tier under ladder rung 2 (two blocked rounds). task-2 and task-3 build on `checkPaperwork` and the fixtures in `test/helpers/paperworkFixtures.ts`.
- task-3-testgate-env-evidence: merged `bb3d099c` (integration `06165e73`), under plan v3 (proposal `#71`, operator-approved, adding `test/paperwork.test.ts` to the claims). `testgate.ts` records an index-aligned `RunResult.environment` per check: window `command`|`none`, wall/monotonic/gap, load, cpus. It exports `SLEEP_GAP_MS` (30000) and `sleptDuringCheck`. When a failed check's own clock gap shows sleep, `gate.ts` stamps `error_class: execution.env-failure` plus `environment_evidence` on testgate-result, gate-outcome and the blocked `GateOutcome`. The outcome stays blocked `tests-failed`, and nothing is re-run. `paperwork.test.ts`'s `lineageOf` renders `environment` as an entry count. task-4 writes the CHANGELOG paragraph from this line.
- task-2-results-check-verb: merged `52acd2c2` (integration `5848c452`). `bs results check <task-id> --as <coder|tester|grader|gate>` (cli.ts `runResultsCheck`) runs `checkPaperwork` read-only for each role. Gate mode takes the `gate run` line verbatim, parses its files with the gate intake, and dry-runs the judge closes through `judges.ts` `checkJudgeReport`, which `recordJudgeReport` also calls, and the shared `selectJudgeCloses`. The output is `{outcome, reason?, as, task_id, artifact_home, problems, skipped, not_run, verdicts?, warnings}`, exit 0 for a pass and 1 for blocked or refused. Gate mode takes reviewer artifacts via `--evidence`/`--found-by`, not `--findings`. The diff overran its cap at 1404/1100 lines, 1053 of them tests (recorded, not blocking). Two S3s raised: `721ff26d` and `b5e0ec2a`. task-4 cites the verb: the wave-runner runs `--as gate` before `gate run`, and each worker runs its own role's mode.
- Follow-ups (the operator's rule: S3s are fixed, not waived):
  - `followup-2782d7a8` merged `a3e6cac7`: the daemon in-process test pins `sessions` and `findings` on every tick.
  - `followup-721ff26d` merged `85a83068`: a shared `requireNoFindingsRole` makes `results check --as gate` fail like `gate run` on a bare `--no-findings`.
  - `followup-b5e0ec2a` merged `8d187bc7`: `results check --as gate --project` loads the crosscheck policy like `gate run`.
- task-4-handback-preflight-playbooks: merged `4c034f49` (integration `6365aca3`), under plan v4 (proposal `#103`, operator-approved, adding `test/templateFragments.test.ts` to the claims).
  - The coder, tester and grader templates carry a `handback-preflight` SHARED region, plus their own `bs results check --as <role>` line with `--artifacts-dir <work-root>/state/artifacts`.
  - The coder and tester run every gate check over the whole project at hand-back.
  - wave.md:
    - step 7 runs `--as gate` with the gate line's flags before `gate run`;
    - steps 5, 7 and 8 share one `--artifacts-dir`;
    - step 9 reads `execution.env-failure` as a failed ladder round, with no coder bounce and no automatic re-run.
  - queue-and-gate.md §5 and the CHANGELOG document all of this.
  - Templates name neither `bs heavy run`/`wait` nor pnpm/biome outside the SHARED regions: the stack-neutrality guard and contract clause 3 forbid it, and the reviewer agreed with that reading of AC5.
- task-7-close-review-fixes: merged `4badab90` (integration `c917a05b`), under plan v5 (the amendment that answers the closing review).
  - `bs results check --as grader` accepts `--artifacts-dir` and warns once that it only sets `artifact_home`.
  - Every intake problem carries `input`; judge problems are split into `judge-dispatch`, `judge-artifact` and `judge-internal`.
  - wave.md step 7 routes each preflight result to one of five branches. A branch-4 return is bounded at one per task by the playbook rule; no verb enforces it.
  - queue-and-gate.md §5 and the env-failure block match the code, and the CHANGELOG says what the release does.
  - Mixed case: a fresh grader file that is not a list shows three problems (intake `judge-artifact`, stage `judges-outstanding`, stage `grader-invalid`), all branch 2.
  - The diff ran to about 1003 lines over its 800 cap (recorded, not blocking).
- task-8-close-review-r2-fixes: merged `4584b83d` (integration `1ebd02da`), under plan v6 (the amendment that answers the closing review's round 2). The epic session wrote this line, because the coder's result carried no `notes`.
  - `grader-invalid` is in wave.md step 7 branch 2, answered by the grader's turn, never by `gate run` or a builder. Step 9 bounces to the builder whose output the reason names: the tester for the screenshots reasons, the coder otherwise.
  - `bs brief compose` takes `--provider`, `--model-tier`, `--base`, `--checks` and `--work-root`. It writes each coder, tester and grader brief's filled, shell-quoted `bs results check` line, plus a `gate_checks` list for the coder and tester, and refuses a missing or invalid value. `bs dispatch lint` refuses a coder, tester or grader brief without them.
  - The tester's own result file is `<work-root>/state/results/<task-id>.tester.json` in every template, playbook and standard that names it.
  - wave.md step 7 and queue-and-gate.md §5 carry one branch-4 counting sentence, word for word: one return per task, whatever the role.
  - The diff ran to 1397 insertions and 67 deletions against its 1400 cap (recorded, not blocking). Reviewer round 1 read only diffs and was not accepted; round 2 passed every criterion and raised two S4s on `test/handbackPreflight.test.ts`, each fixed in its own follow-up (the operator's rule: fixed, not waived).
  - `followup-6903d792` merged `9280e328` (integration `e31063d9`): the handback-preflight tests use one module-scope `REASON_BRANCH`. `R2_REASON_BRANCH` is gone, and a guard pins that the `satisfies` tie appears once.
  - `followup-0265fb47` merged `263edaf7` (integration `24f79cd3`): the test that the three task-8 templates leave their SHARED regions alone now compares each region with its fragment byte for byte, where before it only counted the regions. Its reviewer raised one S4, `47b38469`: the test's last assertion compares the fragment file with itself. That S4 is fixed in `followup-47b38469`.
  - `followup-47b38469` merged `553d7a1a` (integration `f85c1b1c`): that assertion is replaced by one that checks the region loop really compared `bs-tester.md`'s `handback-preflight` region.
- task-9-close-review-r3-fixes: merged `85ea8825` (integration `ad8af20c`), under plan v7 (the amendment that answers the closing review's round 3).
  - wave.md step 9 has one bullet per blocked gate reason, each with one answerer and no catch-all. The uiux reasons bounce to the uiux pass under the ladder's usual rungs. A block no builder answers stops for the operator from its second failed round. The env-failure bullet states that one order.
  - `bs brief compose` builds a follow-up's brief from its `task-added` record, with its own open findings as a scope section passed through `findingContext.ts` `flatten`.
  - The documented compose commands carry the worker flags, and `briefComposeDocs.test.ts` runs them.
  - The diff ran to 1481 lines against its 1200 cap (recorded, not blocking). The first queue run blocked on 10 load timeouts after the machine woke from hibernation (load 104), and the one re-run at load 17 merged. Reviewer round 1 left three big test files unread and was not accepted; round 2 passed every criterion with no findings.

## Re-check against main (round 3) — changes

Plan v2, one line per finding of the round-3 re-check and the operator's
added finding.

- f-bs-gate-bounce/integration-7bca32cd: fixed by task-5: it claims `test/cliCrossfind.test.ts`, where #502 moved the daemon per-tick test, instead of the removed `test/cli.test.ts`, and names that file in its objective, clauses and criteria; the test helpers are read, never edited.
- f-bs-gate-bounce/integration-dd43a7e5: fixed by task-4: only the full test command and e2e go through `bs heavy run`; lint and type checks run directly (wave.md step 7, "Heavy checks"); the heavy-run fragment and every template that carries it (eleven on main) stay unchanged and unclaimed.
- f-bs-gate-bounce/integration-49fd827f: fixed by tasks 1 to 6: every hand-back clause starts the full suite and `scripts/check.sh` in the background through `bs heavy run` and waits with `bs heavy wait`, as the heavy-run section says; build, typecheck and biome run directly.
- f-bs-gate-bounce/integration-b1e1257b: fixed by task-3: the clock window brackets the spawned process only, inside the lock callback; a `heavy.wait-timeout` result carries an empty window and never classifies; its tests use an injected clock and temporary lock directories.
- f-bs-gate-bounce/integration-114d979e: fixed by task-4: it adds one `--artifacts-dir <work-root>/state/artifacts` to step 5's record line, step 7's gate line, step 7's preflight line and every per-role line, and a test requires the same value on each.
- f-bs-gate-bounce/integration-2d51a713: fixed by task-2: its `cli.ts` citations are at `99e7fe64` and each names its symbol.
- f-bs-gate-bounce/integration-6b79f994: fixed by task-6: `dispatch.md` belongs to task-6 alone, whose text states the end state with or without task-4's step-9 record; task-4 does not claim it.
- f-bs-gate-bounce/integration-d66a6e78: fixed by task-4: both fallback sites in `bs-tester.md` go, the constraints list and the artifacts paragraph, and the test checks those two passages.
- f-bs-gate-bounce/integration-26aba0fc: fixed by the plan notes: the exposure note is the list `bs claims impact` prints, `heavyRun.ts` included.
- f-bs-gate-bounce/integration-ac25245f: fixed in this spec and the plan notes: the status line, the precondition section, the bs-optimize sentence and the answered open questions are in the past tense; the plan notes that stated future facts are restated at `99e7fe64`.
- f-bs-gate-bounce/integration-a8609c17: fixed by task-6 (AC10): a blocked gate counts toward the class its reason maps to, or toward its stamped `error_class`.

## Pre-code review (v2 draft) — changes

The pre-code review of the plan v2 draft raised five findings; each is
answered in the draft before ingest.

- f-bs-gate-bounce/integration-8de89739: fixed by task-3. The evidence is an `environment` array on RunResult, one entry per check result in the same order, and the `testgate-result` payload carries it. CheckResult gains no field, so the exact `toEqual` at test/testgate.test.ts:87-89 holds unchanged under AC3.
- f-bs-gate-bounce/integration-e1d0cbc4: fixed by task-4. wave.md step 9 and queue-and-gate.md say that an env-classified block is a failed round on the escalation ladder, counted by `escalation.ts` `readFailedRounds` as today: a bare re-gate only after the first failed round, a higher-tier builder dispatch from the second, the operator from the third. No code, ladder rung or `budgets.yml` change.
- f-bs-gate-bounce/integration-d16bc568: fixed by task-4 and the plan notes. The heavy-run region is named as "every template that carries it (eleven on main)", not ten.
- f-bs-gate-bounce/integration-07457ae1: fixed by task-6. Its text cites the error class, never a lesson id that embeds another project's name, and tells the worker not to copy lesson ids into code or notes.
- f-bs-gate-bounce/integration-ae1aec38: fixed by task-6. An unqualified task id on a blocked gate-outcome counts as it does for `error-logged` today: store-wide under the id string and toward no epic's repeat. A criterion pins it.
- f-bs-gate-bounce/integration-36f68ace: fixed by task-4, wording only. Criterion 7 and the wave.md step 9 text it asks for each say in one sentence that "no coder bounce" means no finding against the coder and no fix-round brief. From the second failed round, the ladder still requires a builder dispatch on a higher model tier before another gate round, as escalation.ts `checkModelTierRung` and `checkOperatorRung` enforce.

## Closing review (plan v4) — changes

Plan v5, one line per finding of the closing spec review (bs-gate-bounce-run-2026-10-29#143).

- f-bs-gate-bounce/integration-ea78e56c: fixed by task-7: `results check --as grader` accepts the shared `--artifacts-dir` and says in its output that the grader stage reads no artifact, so the grader lines in bs-grader.md and wave.md run as written and AC4 holds as signed off; bs-grader.md says why the line carries the flag and that the warning is expected; usage.ts and queue-and-gate.md state each mode's flags as the code accepts them (grader mode takes no envelope flags); a test runs the seven concrete preflight lines of the templates and wave.md through the built verb.
- f-bs-gate-bounce/integration-5f8da50c: fixed by task-7: wave.md step 7 maps every preflight result to one of five branches, keyed on the `input` each intake problem now names. The wave-runner's own line and a judge turn are not ladder rounds. A worker's file the gate blocks on goes through `gate run`, whose blocked `gate-outcome` `readFailedRounds` counts. A worker's result on which `gate run` throws before writing anything gets an `error-logged` / `contract.schema-violation` and at most one return per task, a builder dispatch whose `causal_parent` is that event and which obeys the ladder; a second goes to the epic session. A verb or log failure goes to the epic session, never an agent. The ladder is unchanged, and tests pin both premises in code.
- f-bs-gate-bounce/integration-7d2d0eff: fixed by task-7: queue-and-gate.md names the `testgate-result` payload's per-check `environment` array and says that `error_class` and `environment_evidence` hold only the failed checks whose own clock gap shows sleep.
- f-bs-gate-bounce/integration-acc5dbee: fixed by task-7: the CHANGELOG's task-6 bullet, and two sentences of the same shape (task-5's and the CLI-tests entry's), say what the release does, not what one diff avoided; task-7 gets its own entry.
- f-bs-gate-bounce/integration-b1e98459: fixed in this spec edit: the status line names plan v5 and what v3 and v4 widened, and "Plan shape" keeps the v2 table as history beside the merge order and task-7.

## Pre-code review (v5 draft) — changes

Three pre-code reviews of the plan v5 draft raised eight findings: round 1 as
bs-gate-bounce-run-2026-10-29#148 to #151, round 2 as #155 to #157, round 3
as #161. Each is answered in the draft before amend.

- f-bs-gate-bounce/integration-f945754b: fixed by task-7. `gate run` throws before `runGate` on a bad result, grader, evidence, uiux-visual or judge file, so those cannot be counted gate rounds. Only the reasons `runGate` blocks on go through `gate run` (branch 3); a worker's result the gate cannot read is branch 4, logged and returned at most once per task; a judge's file is branch 2, under the existing judge rules. Criterion 6 pins in code that branch 3 is counted and branch 4 writes no `gate-outcome`.
- f-bs-gate-bounce/integration-81ee8bc6: fixed by task-7. Each `PaperworkReason` and each intake `input` maps to exactly one of five branches once the line matches step 7's example; an input the list does not name goes to the epic session, and a named problem the line or a worker could have caused is the worker's.
- f-bs-gate-bounce/integration-0fb76701: fixed by task-7. The test runs exactly the seven concrete preflight lines, each with a literal mode, never the fragment's generic `--as <role>` line, and fills each placeholder with a value of its flag's type.
- f-bs-gate-bounce/integration-2381b9b1: fixed by task-7. bs-grader.md, outside its SHARED regions, says once why its line carries `--artifacts-dir` and that the warning about it is expected and not a problem to fix; task-7 claims bs-grader.md for that sentence.
- f-bs-gate-bounce/integration-45a7d16b: fixed by task-7. A branch-4 return is a builder dispatch: its `dispatch_decision` has the `error-logged` event as `causal_parent`, and the ladder applies to it unchanged (`checkModelTierRung`, `checkOperatorRung`). The `error-logged` carries the task in `task_id` and `task_ref` and the worker in `agent` and `agent_role`, so the bound of one return per task reads off the log's structure; before the operator answers there is exactly one return.
- f-bs-gate-bounce/integration-1ecb562b: fixed by task-7. The verb's `judges` label splits by error code: `judge-dispatch` for the wave-runner's own judge records (branch 1); `judge-artifact` for a judge's missing, stale or malformed file (branch 2); `judge-internal` for a log read or a non-judge error (branch 5). A crash inside `checkPaperwork` (`paperwork`) also goes to the epic session, never an agent.
- f-bs-gate-bounce/integration-ca1f180a: fixed by task-7. Criterion 6 pins the label the code prints for each fixture, `evidence` for a non-list evidence file among them, and `input` is described as where the problem came from: a flag's file or value, the task id and artifacts dir, or a step inside the verb.
- f-bs-gate-bounce/integration-246f97c8: fixed by task-7. A preflight result can hold problems from several branches (a handed-in grader file that is neither a list nor a grader document shows `judge-artifact` and `grader-invalid` together), and `gate run` throws before `runGate` while any intake problem remains. Criterion 5 adds a precedence: every intake problem is settled first, by its branch, then the stage reasons of branches 1 and 2, and a stage reason goes to `gate run` only when no intake problem shows. Criterion 6 pins the mixed grader file: the intake problem comes first, and `gate run` on it writes no `gate-outcome`.

## Closing review round 2 (plan v5) — changes

Plan v6, one line per finding of the closing spec review's round 2
(bs-gate-bounce-run-2026-10-29#189, judge report #190).

- f-bs-gate-bounce/integration-1e8e9e9b: fixed by task-8: `grader-invalid` moves to wave.md step 7 branch 2. The grader's turn answers it: the grader rewrites its file in the same round, or is re-run only while its round cap (step 6) leaves a round, and otherwise the task goes to the epic session; it never goes to `gate run` or to a builder. Step 9 bounces a blocked gate to the builder its reason names, the tester for `screenshots-missing` and `screenshots-stale`, and the mixed-case sentence names the three problems the code prints. queue-and-gate.md says the same. `readFailedRounds` and `checkModelTierRung` already count a tester bounce and its higher-tier tester dispatch, so escalation.ts does not change, and a test runs `bs escalation check` to show it.
- f-bs-gate-bounce/integration-fdeb317e: fixed by task-8: `bs brief compose` writes each coder's, tester's and grader's filled `bs results check` line, and each coder's and tester's gate check commands. The provider, the model tier, the coder's base and the checks file come from flags, and compose refuses a worker brief without them. `bs dispatch lint` refuses a brief, composed or hand-built, whose line is missing or holds a placeholder. The fragment and the coder and grader templates are unchanged; what they say becomes true.
- f-bs-gate-bounce/integration-2afed53d: fixed by task-8: wave.md step 7 and queue-and-gate.md §5 carry one counting sentence word for word: at most one branch-4 return per task, whatever the worker's role.

## Pre-code review (v6 draft) — changes

Three pre-code reviews of the plan v6 draft raised thirteen findings: round 1
seven (one S2, three S3, three S4), round 2 four (one S3, three S4), round 3
two (S4). Each is answered in the draft before amend.

- f-bs-gate-bounce/integration-9de7c928: fixed by task-8: the tester's result file is `<work-root>/state/results/<task-id>.tester.json`, the name the wave-runner already uses and run.md reads, never the coder's `<task-id>.json`. The composed line, a `Result file:` line beside it, bs-tester.md, dispatch.md's return discipline and wave.md step 5's record line all name it, and a test requires them to agree.
- f-bs-gate-bounce/integration-c4cd9084: fixed by task-8: `bs brief compose` refuses a coder or tester brief whose provider, model tier, base or checks are missing, naming each flag. It then runs the lint's own preflight check on its text and refuses one that fails, so every brief it writes passes `bs dispatch lint`, as the docs say.
- f-bs-gate-bounce/integration-99d9be8b: fixed by task-8: every value goes into the line through one shell-quoting function. A value with a newline or another control character is refused, and so are a provider and a model tier outside taxonomy.yml's lists. A test runs a composed line with a spaced work root through the shell.
- f-bs-gate-bounce/integration-4b5cc5cc: fixed in this spec: AC4 states what task-8 delivers. That is the composer and its refusals, the lint, step 7's routing of a grader's file to the grader's turn and the one-return-per-task bound, and step 9's bounce to the builder its reason names.
- f-bs-gate-bounce/integration-817add66: fixed by task-8: the lint matches the line's task id with `taskIdsMatch`, so a bare and a qualified spelling of one id agree.
- f-bs-gate-bounce/integration-8afd5c81: fixed by task-8: criterion 5 fixes the text form of the `preflight` and `gate_checks` sections (their heading lines and `- <name>: <command>`), and dispatch.md shows it, so a hand-built brief can satisfy the lint.
- f-bs-gate-bounce/integration-7ec14864: fixed by task-8: its own diff cap is 1400 lines, sized from its claims, and a criterion says an overrun is recorded and does not block the gate. The default caps do not change.
- f-bs-gate-bounce/integration-65a64a1a: fixed by task-8: the `gate_checks` heading no longer says to run each check exactly as written. It says to run a check marked heavy as the template's heavy-run section says, never bare, and compose marks a check `(heavy)` when testgate.ts `isHeavyCheck` says the gate treats it as heavy. The heading names no tool, and the lint pins it.
- f-bs-gate-bounce/integration-32682fce: fixed by task-8: compose refuses a `<...>` token only in a value it writes into the preflight line. A check's command is written verbatim whatever it holds, a line break included, as four-space-indented lines under its `- <name>:` line.
- f-bs-gate-bounce/integration-13606fd6: fixed by task-8: compose has no default work root. It refuses a coder, tester or grader brief without `--work-root`, and wave.md step 8 passes `--work-root <work-root>`, the value steps 5 and 7 carry. A test requires the composed `--artifacts-dir` to equal the step-7 gate line's, filled with the same value.
- f-bs-gate-bounce/integration-9c6ba61f: fixed by task-8: bs-wave-runner.md, docs/standards/agent-constraints.md and bs-uiux.md say the tester writes its own `state/results/<task-id>.tester.json`, each outside its SHARED regions. A test checks that no template, playbook or standard still gives the tester the coder's file.
- f-bs-gate-bounce/integration-b954029f: fixed by task-8: compose refuses a relative `--work-root` by name. `--worktree` and `--artifact` keep their existing refusals of a relative path, and the plan path in the line is the absolute path of the plan file compose read, so every path in the line is absolute.
- f-bs-gate-bounce/integration-7a110665: fixed by task-8: compose refuses a check whose `cmd` is missing, not a string, empty or only whitespace, naming the check. `gate run` cannot run the first three, because node's `spawn` throws on them, and it runs the last as a no-op. The lint counts a check only when its command holds a non-space character, so `no-checks` never counts a check with no command.

## Closing review round 3 (plan v6) — changes

Plan v7, one line per finding of the closing spec review's round 3
(bs-gate-bounce-run-2026-10-29#282, judge report #283).

- f-bs-gate-bounce/integration-38ddc74d: fixed by task-9: wave.md step 9 lists every reason the gate blocks on, one bullet each, with exactly one answerer and no catch-all: a named builder (the coder, the tester, the uiux pass, or the worker whose result it is), a judge turn, the wave-runner's own fix, or the epic session. Every blocked `gate-outcome` is a counted round. A block no builder answers is never bounced: a bare re-gate after its first failed round, and from the second the operator's logged answer before anything else runs on the task (see the v7 draft review below). The 'A blocked task blocks itself' rule and queue-and-gate.md's outcome table, which gains the two uiux rows, say the same. A test keys the map to the gate's own reason type with `satisfies`, and runs `bs escalation check` to show why the second non-builder round goes to the epic session.
- f-bs-gate-bounce/integration-5c096bd9: fixed by task-9: `bs brief compose` composes a follow-up's brief from its `task-added` record, the register `wave next` reads, with its claims, open findings, lessons, filled preflight line and gate checks; no value it needs is missing. waivers.md step 4 routes every follow-up through it and leaves only the acceptance criteria and the budget to the epic session, and `bs dispatch lint` refuses a follow-up brief without the line or the checks.
- f-bs-gate-bounce/integration-7d2c72ec: fixed by task-9: dispatch.md, wave.md step 8 and the worktrees-and-judges.md section 3d coder example carry the worker flags. A test runs every documented compose command through the built CLI, or, for a `<role>` line, checks that it names every flag compose's own refusal lists.

## Pre-code review (v7 draft) — changes

The pre-code review of the plan v7 draft raised seven findings: round 1 four
(one S2, two S3, one S4), answered in dispatch #292, and round 2 three (two S3,
one S4), answered in dispatch #298. Each is answered in the draft before amend.

- f-bs-gate-bounce/integration-9c1bb4d6: fixed by task-9: a composed follow-up brief carries the findings it exists to fix in its own `scope` section. Compose reads them the way `bs findings list --task <id>` does, keeps those still `raised`, `confirmed` or `fix-pending`, and writes each as one line of JSON. The context block from `findingsForDispatch` is unchanged, including its exclusion of the task's own findings. A follow-up that owns no open finding is refused. The CLI test mints the follow-up through real `bs findings raise` routing.
- f-bs-gate-bounce/integration-b3e3083c: fixed by task-9: the `coverage-evidence` evidence the gate already writes yields three cases, each with one answerer. `present` false is the reporter list, project configuration, so the epic session answers it. `present` true with no `unmeasured` subject means the gate read no claims for the id, so the wave-runner's gate line is the fix. An `unmeasured` subject is a file no test loads or one the include config skips, which the gate cannot tell apart, so the coder answers it, as before task-9. Probes of `bs coverage check` and two new assertions in `test/gate.test.ts` pin the three shapes.
- f-bs-gate-bounce/integration-29686266: fixed by task-9: probes of `bs escalation check` show that after a second failed round the ladder accepts only two things on one task id: stopping, or a strictly higher-tier builder dispatch. An operator's answer does not make a bare re-gate clean. So a block no builder answers stops on its id from its second failed round, and the operator's logged answer picks the next move: a re-scope under a new id, one higher-tier builder dispatch whose causal parent is that answer, or a waiver or closure. The env-failure bullet follows the same rule. `escalation.ts` and AC6's rungs do not change. The operator-first bound is a playbook rule, an accepted gap stated beside branch 4's.
- f-bs-gate-bounce/integration-2d92075f: fixed by task-9: `grader-invalid` has one answerer, the grader's turn, a judge turn like a `judges-outstanding` with no uiux turn outstanding. When no grader round is left, the grader cap's re-scope applies, in the same words in wave.md step 7 branch 2, step 9, queue-and-gate.md section 5 and its table row. The test fails if any step-9 bullet or table row names a second answerer.
- f-bs-gate-bounce/integration-105d3733: fixed by task-9: the uiux pass is a builder (escalation.ts `BUILDER_ROLES`). So `uiux-spec-missing`, `uiux-visual-missing` and a `judges-outstanding` whose `outstandingJudges` names a uiux turn are a bounce to the uiux pass, under the ladder's usual rungs: a strictly higher tier from the second failed round, and never the round-2 operator stop. The grader, reviewer, verifier and security-reviewer stay judge turns. Probes of `bs escalation check` with a uiux dispatch and with a reviewer dispatch pin both readings, and a test ties the builder kinds to `BUILDER_ROLES`.
- f-bs-gate-bounce/integration-446ee7cf: fixed by task-9: wave.md step 9's env-failure bullet and queue-and-gate.md's env-failure paragraph state one round-2 order, in the same words: the operator's answer first, and only then, if the answer picks it, one builder dispatch on a strictly higher tier. Task-4's pin `higher-tier builder dispatch from the second` changes by name, every other env-failure pin holds, and AC6 says the same.
- f-bs-gate-bounce/integration-05cec9f9: fixed by task-9: each scope line passes through findingContext.ts `flatten`, now exported rather than copied, so `<!--` and `-->` in reviewer text are neutralised as in the sibling findings block. A test composes a finding whose summary carries the END marker followed by a sentence.

## Closing review round 4 (plan v7) — changes

- f-bs-gate-bounce/integration-79b20de9: fixed in this spec edit: the status line says tasks 1 to 9 and task-8's three follow-ups are merged at integration head `ad8af20c` and that the epic closes under plan v7. "As merged" adds task-9 (`85ea8825`, integration `ad8af20c`), so the merge order matches Progress and `git log --first-parent`. The effort line gives the live cap, 52M tokens with the alarm at 36.4M, from the `SMITH_EPIC_CAP_TOKENS_MEDIUM` override, instead of `budgets.yml`'s 16M and 11.2M.
