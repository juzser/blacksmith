# Operator guide — The queue and the gate

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 4. `smith queue run`

Drives a set of already-merged-locally task branches through the serial
merge queue for one epic:

```bash
smith queue run epic-1 \
  --project ../my-project \
  --test-cmd "pnpm test" \
  --tasks tasks.json
```

`tasks.json` is `Array<{ taskId, branch, worktreeDir }>`. Each task is
admitted one at a time: certify there is a commit to merge → rebase onto
the current integration-branch head → run the cumulative regression gate
(`--test-cmd`, standing in for "every previously merged task's tests in
this epic") → merge on green, bounce on red. The command stops at the
first non-`merged` outcome and exits `1`; prints the full outcome array
either way.

With `--plan`, *the merge order is the plan's, not the file's*: the ids are
resolved against the plan and the set is then sorted topologically by the
plan's dependency edges, tie-broken by task id, so a task never merges
before one it declares `depends_on` (D-186). A cycle is refused whole
(`queue.cyclic-dependency`). Without `--plan` — only allowed when you are
also not passing `--session` — the file's order is all there is.

The certification comes first because a rebase, a test run and a merge all
"succeed" against a branch that carries nothing — that is D-30, and §5a
tells the whole story. A task whose worktree is dirty or whose branch is
not ahead of `smith/<epic>/integration` returns `nothing-to-merge` and is
never rebased, so the uncommitted work is still sitting exactly where the
agent left it when you go look.

### 4a. `smith queue adopt` — the merge that happened without the queue

`wave-merged` is the only event the projector folds to `completed`, and
`queue run` writes it only for merges it made itself. So an epic merged by
hand has landed tasks and an empty log, and the only way to close it was to
`event append` the missing events — which is not evidence, it is typing.
That was D-137, found on `envkit-mcp-followup` with four such tasks.

```bash
smith queue adopt task-4 \
  --project ../my-project \
  --merge-commit 9f2c1ab \
  --plan plans/epic-1.json \
  --session sess-7 --causal-parent sess-7#0
```

It does not take your word for it. Before writing anything it checks, in
this order, that `smith/<epic>/integration` and the task's branch both
exist, that `--merge-commit` names a commit, that the commit is a merge,
that the merge is reachable from the integration branch, that the branch
head is one of the merge's parents, and that the branch carries a commit
that merge could have landed (D-30 again — a branch cut and never committed
to is the first parent of every merge made after it). Only then does it
emit the same `wave-merged` the queue would have, with the same
`files_changed`, read off the merge commit.

The branch is derived from the plan-resolved task id, never passed: a
`--branch` flag would let you hand it the *other* task's branch, which
really is a parent of that merge, and adopt any task with it. `--plan` and
`--session` are both required for the same reason `queue run --session`
requires `--plan` — the merge is logged under the id the plan declares, or
not at all. Every refusal exits `1` with a `queue.adopt-*` code and writes
no event: a mistyped sha is an operator error, not a blocked task.

### 4b. `--select-test-cmd` — paying for the tests the change can reach

The queue is serial and the regression gate is cumulative, so N tasks each
pay for the whole suite: the honest thing, and a quadratic one. `--select-test-cmd`
narrows the *gate*, never the contract.

```bash
smith queue run epic-1 \
  --project ../my-project \
  --test-cmd "pnpm test" \
  --select-test-cmd "pnpm vitest run {files}" \
  --tasks tasks.json
```

After the rebase — so the change set is the task's commits replayed on the
current integration head — the queue diffs the worktree against
`smith/<epic>/integration`, builds the same symbol graph `smith claims impact`
uses, and walks `dependents` out from the changed files until the frontier
stops growing. Whatever test files that reaches is what runs, through your
template with `{files}` replaced by the shell-quoted list.

Every ambiguity resolves to running everything. A changed file the scanner has
never seen, cannot read, or that is not source at all (a `.yml`, a lockfile, a
fixture) can affect anything; a module with a computed `import()` or an import
that never resolved is treated as reached by every change, because the scanner
cannot prove it is not; and a change that reaches *no* test is far more likely
a stale graph than genuinely uncovered code. In each case the run falls back to
`--test-cmd` with the reason attached rather than reporting a narrow pass.

That fallback is the whole design. A test gate that skips on error is not a
gate, so there is no path where a failure to build the graph turns into fewer
tests run — only into the full command, plus a line saying why.

Each outcome carries what actually happened, which is the part to read:

```json
{ "outcome": "merged", "taskId": "task-3",
  "tests": { "mode": "selected", "ran": ["src/config.test.ts"], "known": 41 } }
```

`mode: "full"` arrives with `reasons` when something forced it — `known` is
how many test files the graph knows about, so `ran: 1 of 41` is legible
without trusting the selection blindly. Drop `--select-test-cmd` and the
`tests` key disappears entirely: its presence means selection ran, its absence
means the full command was the only command there ever was.

Two things it deliberately does not do. It never narrows a typecheck: `tsc -p`
is a whole-program question, and a subset of files is a different, weaker one —
so keep `tsc` in `--test-cmd`, not in the selective template. And it never
invents the command: a `--select-test-cmd` without a `{files}` placeholder is
refused before the queue starts (`test-select.no-files-placeholder`) rather
than silently running your full suite and reporting it as a selective run.

## 5. `smith gate run`

The composed gate pipeline for one task: **schema check → artifact check →
commit check → deps check → outstanding-judge check → grader verdict → tests →
coverage evidence → findings intake → severity decision**. Every stage emits
its own event to the session's log before the next stage runs.

Everything ahead of the test run is a cheap refusal, and each one is a distinct
way a green suite would mean nothing. A schema-invalid result is an input error
and stays first. Then the artifacts it declares: a result whose evidence cannot
be opened is not worth a test run, and the operator would rather be told which
path than be told it late. A worktree with no commit to score (§5a) is next: a
rubric or a suite scored against work the merge will never see is scored
against nothing. Then the toolchain: a task worktree is a `git worktree`, and git does not copy
`node_modules` into one, so check commands resolve their binaries by walking up
into the *factory's* install and report the factory's toolchain passing (§5a). A
task still owing a judge report comes next — `--evidence` absent reads the same
whether the judge found nothing or died mid-turn. Then the grader's rubric: it
has already run, and if it says the acceptance criteria were not met the diff
bounces whatever the suite says, so paying for a full test run first is paying
for nothing. The expensive step is the one nobody should pay for while any of
those is true.

Two of these are opt-in by construction. A task that never used
`smith judge dispatch` (§3c) has an empty dispatch set, so that check is a pure
no-op for it; a gate run with no `--grader` file skips the rubric stage the same
way, which is the pre-D-34 pipeline.

```bash
smith gate run epic-1/task-1 \
  --worktree ../.wt/my-project/task-1 \
  --base smith/epic-1/integration \
  --checks checks.json \
  --result result.json \
  --grader state/results/epic-1-task-1.grader-r1.json \
  --agent coder --provider claude --model-tier mid \
  --input-tokens 19264 --output-tokens 4118 \
  --findings findings.json \
  --session <session-id> --plan-version 1 --causal-parent <event-id> --actor operator
```

- `result.json` — the worker's half of the `Result` envelope: `run_status`,
  `structured_output`, `artifacts`, and optionally `diff_lines_changed` and
  `notes`. The five envelope flags above stamp the fields the dispatcher owns
  — `task_id` (from the positional), `agent`, `provider`, `model_tier` and
  `token_usage`, whose `total_tokens` is computed from the two counts rather
  than accepted as a third number (P9-17). A result file that carries any of
  those five is refused with `results.agent-wrote-owned-field` before the gate
  runs: an agent cannot read its own meter, so a token count it wrote is
  invented, and the schema cannot tell an invented number from a measured one.
  Drop the five flags and `--result` is read as a complete
  `result.schema.json` document instead — the shape a replay or a fixture
  hands over.
- Every `artifacts[].path` must resolve inside the task's artifact home,
  `state/artifacts/<task-id>/`, and exist there — relative paths resolve
  against that home, directories are fine, and anything else blocks the task
  with `reason: "artifacts-missing"` before the tests are ever run. `/tmp`, a
  session scratchpad and a worktree all look durable at the moment the worker
  writes the result and are gone by the time anyone opens the verdict (D-19).
  `--artifacts-dir <dir>` moves the root, which is for tests and replays; the
  default is the repo's `state/artifacts`.
- `checks.json` — `Array<{ name, cmd }>`, run sequentially in the worktree
  (first failure short-circuits unless `--run-all`, which the task gate takes
  bare — its value would be read as the `<task-id>` positional).
- `--grader` — the grader's own result file for this task
  (`state/results/<task-id>.grader-r<round>.json`). Its `structured_output` is
  validated against `grader-verdict.schema.json`, and the rubric gates: any
  criterion that is not `pass` blocks the task before a single check command
  runs. **Optional** — omit it and the pipeline is schema check → tests →
  findings, which is what an ad-hoc gate run with no grading pass wants. The
  factory always passes it (`.claude/skills/bs/wave.md` step 7).
- `findings.json` — `Array<{ filePath, finding: {...} }>` from
  reviewer/verifier, matching `finding.schema.json` minus the computed
  `fingerprint`.
- `--base` — the ref the merge queue will merge this branch into, normally
  `smith/<epic>/integration`. Optional, and the one flag whose absence
  costs you something: see §5a.
- `--session`/`--plan-version`/`--causal-parent` are required on every
  gate/findings/waivers command — they're the event-log envelope
  (`session_id`, `plan_version`, `causal_parent`). `--causal-parent` must
  reference a real prior event in that session's log, so a session from
  scratch starts with `smith session start <session-id>`, which writes the
  root and prints the event id the next command hangs off. `session-start`
  is the only event type allowed a `null` causal_parent, and the only one
  allowed to name a parent in a *different* session (see §5a and §5b).

**Putting your own words in the log.** `smith prompt record <file|-> --session
<id> --causal-parent <event-id>` appends a `user_prompt` holding what you
typed, verbatim, and prints its event id:

```
$ smith prompt record - --session sess-1 --causal-parent 'sess-1#0' <<'EOF'
Build the widget and fix the flaky import.
EOF
{"event_id":"sess-1#1","record":{...}}
```

Pass that id as the `--causal-parent` of the dispatch it caused. That is the
whole point of the verb: the timeline (§7) interleaves prompts and dispatches,
and without the edge a reader can only guess which request a piece of work
answers. Whitespace-only text is refused rather than written, since a blank
row is indistinguishable from a real prompt once it is in the log.

Verified outcome shapes (this is exactly what the CLI printed against a
real fixture — see the guide's source history for the fixture files):

```json
{"outcome":"pass","taskId":"epic-1/task-1","testResult":{"results":[...],"pass":true}}
```

```json
{"outcome":"blocked","taskId":"epic-1/task-1","reason":"tests-failed","testResult":{...},"blockingFindings":[],"artifactIssues":[]}
```

```json
{"outcome":"pass-with-waivers-pending","taskId":"epic-1/task-1","testResult":{...},"pendingFindings":[{"finding_id":"f-...","severity":"S3-minor","finding_status":"raised","fingerprint":"...","...":"..."}]}
```

Exit code is `1` only for `outcome: "blocked"`; `pass` and
`pass-with-waivers-pending` both exit `0` — a pending waiver batch does not
block the merge queue, it queues an operator question (§8 below).

### What each gate outcome means, operator-side

| Outcome | Meaning | What happens next |
|---|---|---|
| `pass` | Schema valid, tests green, no findings | Task proceeds straight to the merge queue |
| `pass-with-waivers-pending` | Schema valid, tests green, only S3/S4 findings | Task proceeds to the merge queue; findings queue into the epic's waiver batch |
| `blocked` (`reason: "schema-invalid"`) | Worker's `Result` failed `result.schema.json` | Never reaches tests; bounce to the coder immediately |
| `blocked` (`reason: "artifacts-missing"`) | A declared artifact is outside `state/artifacts/<task-id>/` or absent | Never reaches tests; `artifactIssues` names each path and which of the two it is |
| `blocked` (`reason: "not-committed"`) | There is no commit here to score — see §5a | Never reaches tests; bounce to the coder to commit |
| `blocked` (`reason: "deps-missing"`) | The worktree declares dependencies but has no `node_modules/.bin` of its own | Never reaches tests; run `pnpm install` in the worktree and re-gate |
| `blocked` (`reason: "judges-outstanding"`) | A judge was dispatched and never reported | Never reaches tests; `outstandingJudges[]` names each role and the file it owes — re-poke it, then `smith judge report` (§3c) |
| `blocked` (`reason: "grader-invalid"`) | The grader's file is not shaped like a verdict (wrong place, missing evidence, round > 2) | Never reaches tests; re-run the grading pass — the diff has not been judged |
| `blocked` (`reason: "grader-fail"`) | A criterion came back `fail`/`partial`, or the grading run was `dead` | Never reaches tests; bounce to coder with the named gaps, or to the planner at round 2 |
| `blocked` (`reason: "tests-failed"`) | A check command exited non-zero | Bounce to coder on the same branch |
| `blocked` (`reason: "coverage-evidence"`) | A coverage check ran, and the numbers it produced don't cover a file this task's claims name | Fix the reporter or the include glob, not the code — see §5c |
| `blocked` (`reason: "findings"`) | An S1/S2 finding was raised | Bounce to coder on the same branch; `blockingFindings` lists exactly which |

## 5a. The commit check — why a green gate used to prove nothing (D-30)

In the dogfood run, `task-3-validate` reported done with 260 lines staged
and never committed. Its branch head was still the integration commit the
worktree was cut from. Schema, lint, typecheck, tests and coverage all ran
green — against the **working tree** — and then the merge queue merged the
**branch**, which carried nothing. The queue returned `merged`, the task
was marked complete, and not one line of that work exists in the repo.

The gate now certifies the commit before it scores anything:

| Certificate `reason` | What actually happened |
|---|---|
| `uncommitted-work` | Files are dirty, staged, or untracked. `dirty` names them. |
| `unborn-branch` | The branch has no commits at all. |
| `branch-not-advanced` | Head equals `--base`. The merge would be a no-op. |
| `unknown-base` | `--base` does not resolve in this worktree — usually a typo or an epic whose integration branch was never created. |
| `not-a-git-worktree` | The `--worktree` path is not a repo. |

Two consequences worth knowing before you see them:

- **The check runs before the check commands do.** A blocked commit check
  costs no test run, and `testResult` is `null`. If you were expecting a
  test failure and got `not-committed`, the tests never ran.
- **`--base` is optional but half-blind without it.** Omit it and the gate
  still refuses an uncommitted worktree, but it cannot tell you the branch
  carries no commits — `commitsAhead` comes back `null` (meaning "nobody
  asked"), not `0` (meaning "the branch is empty"). Pass the epic's
  integration branch on every real gate run.

`smith queue run` applies the same certificate independently, before it
rebases, and returns `{"outcome":"nothing-to-merge","reason":...,"dirty":[...]}`
with a `contract.uncommitted-work` error in the log. The gate refusing is
the fast feedback; the queue refusing is the guarantee — a task that merges
nothing can no longer report `merged`.

### The deps check — whose toolchain went green (P9-16)

Directly behind the certificate, and for the same reason. A task worktree is
a `git worktree` of the project, and git does not copy `node_modules` into
one. Wave 3 ran its gates anyway: `vitest` and `biome` resolved by walking
**up** out of the worktree into the factory's own install, so the green the
gate reported was the factory's toolchain passing, not the project's.

The tell was a `node_modules` inside the worktree holding only `.vite` and
`.vite-temp` — directories a vite run creates, with no `.bin` in sight —
which is why "does `node_modules` exist" is not the question worth asking.
The gate asks whether the worktree owns `node_modules/.bin`, and only when
the project's `package.json` declares dependencies at all:

| Worktree | Outcome |
|---|---|
| No `package.json`, or one that declares no dependencies | Passes — nothing to install |
| Declares dependencies, has `node_modules/.bin` | Passes |
| Declares dependencies, no `node_modules/.bin` | `blocked` / `deps-missing`; run `pnpm install` in the worktree |

`deps-check-result` is emitted on **every** path, including the no-op ones: a
check that decided there was nothing to check is a check that happened, and
the log has to be able to tell that apart from one that never ran.

## 5b. One epic across several sessions — `smith event lineage`

An epic bigger than the orchestrator's context window is finished by
starting a **new session** that continues the old one, not by shrinking the
epic. The continuation is one event: the new session's `session-start`
names an event in the previous session's log as its `causal_parent`.

```bash
# The last thing the old session logged — anything in its log works as the
# anchor; the last event is the honest one.
smith event tail epic-7-session-1 --n 1

# Open the continuation. Cross-session parents are allowed ONLY here, on the
# session root — every event after this one chains inside its own session.
smith session start epic-7-session-2 --continues 'epic-7-session-1#412'

# Read the tree. `lineage` is every session a lineage-wide fold reads;
# `continued_by` is the half below you; `depth` counts the ancestry alone,
# so depth 1 still means "this session started fresh".
smith event lineage epic-7-session-2
# {"session":"epic-7-session-2","lineage":[...],"depth":2,
#  "root":"epic-7-session-1","continued_by":[]}

# Tail the EPIC, not the session that happens to be running.
smith event tail epic-7-session-2 --lineage --n 40
```

Plain `smith event tail` shows only the named session, which after a split
is the newest slice of the epic and nothing before it — `--lineage` folds
the whole chain root-first and then takes the last `n`. The timeline
projection follows the same edge: a causal chain that runs back through the
split renders as one path, not two disconnected stubs.

**The same edge carries a fan-out, and it is read from the other end.** A
parallel round is one epic session dispatching several wave sessions, each
opened with `--continues <epic>#<idx>` — the same one event as a split, used
sideways. So `--lineage` reads *down* as well as up: from the epic session it
folds in every wave that continues it, and every wave those waves opened in
turn, which is what makes `epic close`, `findings list` and `stats overview`
answer about the round rather than about the empty log the dispatcher kept.

From inside a wave it does not widen to the siblings. A wave sees its own
ancestry and its own continuations and nothing else, because two waves running
at once are two scopes, and a gate that could read its sibling's events would
be gating on work it does not own.

```bash
# From the epic: the round. `continued_by` names the waves.
smith event lineage epic-7-session-1
# {"lineage":["epic-7-session-1","wave-a","wave-b"],"depth":1,
#  "continued_by":["wave-a","wave-b"]}

# From a wave: its own ancestry, not its sibling's.
smith event lineage wave-a
# {"lineage":["epic-7-session-1","wave-a"],"depth":2,"continued_by":[]}
```

**`--lineage` on the raw log has a twin on the projection.** Every `smith
stats` page takes `--session`, and `--session` alone is a question about the
window rather than about the epic: after a split, `stats kanban --epic epic-7
--session epic-7-session-2` returns the tasks session 2 recorded and says
nothing at all about the ones session 1 added to the same epic. Half an epic,
reported as a whole one. Add `--lineage` and every page is scoped to the whole
chain instead.

```bash
# Half the epic — whatever the second window happened to record.
smith stats kanban --epic epic-7 --session epic-7-session-2

# The epic. --lineage widens every stats page the same way.
smith stats kanban --epic epic-7 --session epic-7-session-2 --lineage
```

It resolves the chain off the projection, so it needs a `--db` and nothing
else — no access to the log directory, which is why the dashboard can draw the
same scope. It walks the same tree `smith event lineage` does: what this
session continues, plus everything that continued it. It stops at the first
ancestor the projection has not folded yet, so a partial `db rebuild` narrows
the answer rather than failing it. And it needs a `--session` to widen — on
its own it exits 1 with `cli.missing-flag` rather than quietly answering about
every session at once.

The UI server's read routes take the same pair. `?session=<id>` alone is the
window; `?session=<id>&lineage=true` is the epic, resolved through the same
code path, on all eleven routes at once — `/api/overview`, `/api/timeline`,
`/api/kanban`, `/api/pulse`, `/api/projects`, `/api/sessions`, `/api/lessons`,
`/api/errors`, `/api/analytics`, `/api/flow`, `/api/roadmap`. Both refusals
travel with it, as `400 scope.bad-request`: a `lineage` with no `session` has
nothing to widen, and a `lineage` spelled anything but `true` or `false` is
rejected rather than ignored, because ignoring it would hand back precisely
the narrow answer the caller asked not to get.

The dashboard sends the pair too. Every page that reads the scope — Overview,
Sessions, Timeline, Kanban, Flow, Errors, Analytics — carries a session picker
in the topbar beside the project switcher, and picking a run adds a second
control: **This session** or **With its lineage**. The choice rides in the URL
(`?session=<id>&lineage=true`), so a scoped view survives a reload and can be
pasted to somebody else. Clearing the run clears the widening with it. Three
pages deliberately have no picker: Roadmap and Lessons read repo-wide
artifacts — a milestone's progress is not a property of whichever run advanced
it — and the Projects hub is the page whose job is to sit above every scope
there is. The picker's own list is never scoped by the session selected in it,
so choosing one run never hides the others.

Two errors are worth recognising on sight:

| Error code | What you actually did |
|---|---|
| `events.cross-session-parent-not-root` | Pointed a mid-session event at another session. Only `session-start` may cross; re-anchor the chain locally. |
| `events.unknown-causal-session` | Named a session with no log at all — nearly always a typo'd session id, since the message prints the path it looked for. |
| `events.session-already-started` | Ran `smith session start` on a session that already has a log. A log has one root; the message names the last event in it, which is the `--causal-parent` you wanted. |

**Read `on_timeline` on every append receipt.** `event_type` is a free string
here on purpose: a closed list at write time would reject an event nobody had
declared yet and lose the record, which is worse than logging one nobody reads.
The timeline is closed on purpose too — it renders `FREE_TIMELINE_EVENT_TYPES`
plus the `gate_event` and `graph_event` dimensions, and drops everything else,
so the screen stays a timeline instead of a firehose. Both halves are right;
what used to be missing was any word to you that your event had landed on the
far side of the line. So the receipt now says so, and stderr says it louder:

```
$ smith event append '{"session_id":"sess-1","actor":"operator",
    "event_type":"plan-approved","plan_version":1,"causal_parent":"sess-1#0","payload":{}}'
warning: event_type "plan-approved" is not read by the operator timeline. sess-1#1 is
written and durable, but timeline() filters it out under every filter. …
{"event_id":"sess-1#1","record":{...},"on_timeline":false}
```

The same receipt covers the other thing this side cannot refuse: a
`session-start` appended into a log that already has a root. `causal_parent:
null` is precisely what the rule permits, so the write is valid and durable —
but `event lineage` and the timeline both take the *first* root, so nothing
will ever read the second one. stderr says so and points at `smith session
start`, which is the side that can refuse.

Exit stays 0 — the write succeeded, and refusing it is exactly what the open
write side exists to prevent. The record is in the log, `event tail` and
`event lineage` show it, and `db rebuild` projects it. It just will not appear
on any screen. Either reach for a taxonomy `gate_event`/`graph_event` value, or
if the type is one this factory should keep writing, add it to
`FREE_TIMELINE_EVENT_TYPES` in `factory/orchestrator/src/db/queries.ts` — with a
matching entry in the event-type lint, which will demand a reason.

## 5c. `smith coverage check` — evidence that names the file the criterion names

A coverage check that exits 0 is not, by itself, evidence about any particular
file. The v8 text reporter **suppresses rows for files at 100% on every
metric**, so a task's own new file disappears from the transcript exactly when
it is doing best. In D-40 that cost a full investigation — including a coverage
re-run on the pre-task branch to rule out a regression — to establish that
nothing was wrong.

So the gate stopped scraping the table. When `checks` contains a check named
`coverage` (override with `GateInput.coverage.checkName`), the gate reads
`coverage/coverage-summary.json` and attaches it to the outcome as
`coverageEvidence`, and emits it as a `coverage-evidence` event. This needs
`json-summary` in the reporter list — the scaffold's `vitest.config.ts` ships
with it:

```ts
reporter: ['text', 'text-summary', 'json-summary'],
```

The same evidence, without staging a gate run:

```bash
smith coverage check <worktree-dir> [--plan <plan.json> --task <task-id>] [--summary <path>]
```

Real output, run at this repo's root after `pnpm exec vitest run coverage.test --coverage`:

```json
{"summary_path":"coverage/coverage-summary.json","present":true,"complete":true,"files_measured":43,
 "total":{"lines":{"total":2844,"covered":88,"skipped":0,"pct":3.09},"...":"..."},
 "subjects":[{"path":"factory/orchestrator/src/coverage.ts","status":"measured","lines_pct":94.28,"statements_pct":93.42,"functions_pct":100,"branches_pct":87.23},
             {"path":"factory/orchestrator/test/coverage.test.ts","status":"not-instrumented","lines_pct":null,"statements_pct":null,"functions_pct":null,"branches_pct":null}],
 "detail":"43 files measured; 1 of 2 named files have a per-file number."}
```

Three statuses, because two would lie:

| Status | Means | Blocks? |
|---|---|---|
| `measured` | The summary has four numbers for this file | No |
| `unmeasured` | No row for it, **but siblings in its directory have one** — the coverage config reaches here and skipped the file the criterion names | Yes |
| `not-instrumented` | No row, and nothing in its directory has one — the file is outside the include glob. `test/*.test.ts` and `package.json` land here | No |

Glob claims (`src/**/*.ts`) are skipped: a glob names a region, and a region has
no single number a per-file criterion could cite. Only the **gated task's own**
claims are judged — blocking task-1 for a file task-2 owns is D-41 again — which
is why `--plan` demands `--task`. With neither, you get the total and no
subjects, which is a report, not a verdict.

Exit `1` when the evidence is incomplete, in either of the two ways it can be:

```json
{"...":"...","complete":false,
 "subjects":[{"path":"factory/orchestrator/src/nowhere.ts","status":"unmeasured","lines_pct":null,"...":"..."}],
 "detail":"no per-file number for factory/orchestrator/src/nowhere.ts — the criterion names a file the coverage run did not measure."}
```

```json
{"summary_path":"coverage/coverage-summary.json","present":false,"complete":false,"files_measured":0,"total":null,"subjects":[],
 "detail":"no coverage/coverage-summary.json after the coverage check — add \"json-summary\" to coverage.reporter in vitest.config.ts, because the text table hides every file at 100%."}
```

A missing summary blocks on purpose. `thresholds.perFile: true` proves every
*included* file cleared the bar and says nothing at all about a file that was
never included, and a configured coverage check that produces no
machine-readable artifact is the D-40 condition itself. The fix is one line in
`vitest.config.ts`, and blocking is what makes it get fixed. A gate with **no**
coverage check is untouched by any of this: no evidence field, no event, no
block.
