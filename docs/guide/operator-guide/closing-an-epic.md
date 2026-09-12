# Operator guide — Closing an epic

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 7. `smith plan quorum` + `smith epic verdict`

The gate raises its own quorum cases; these two are the ones you invoke.
Both rest on a quorum that ships one *voting* vendor short.
`crosscheck.yml` ships `codex: enabled: auto, mode: active` and
`deepseek: enabled: auto, mode: shadow`, so a box holding the `codex` binary
and a DeepSeek key runs two external judges and counts one, and a box with
neither runs none. Either way `min_providers: 2` is out of reach — no
quorum, no gating `judge-verdict` row from a second vendor, and the outcome
rests on the native verdict alone (`docs/runbooks/providers.md`). A shadow
provider is still invoked and still recorded; it forfeits its vote and
nothing else, so promoting deepseek after a calibration pass is the edit
that closes the gap. `smith judge preflight` says beforehand whether a
provider you switched on can be called at all, and
`SMITH_CROSSCHECK_OFFLINE=1` forces every external off for one command.

```bash
smith plan quorum --epic epic-1 --plan-version 1 \
  --session <session-id> --causal-parent <event-id> [--confidence 0.7]
```

Run it after the spec-reviewer round, before you sign a plan off. It first
evaluates `crosscheck.yml`'s three `plan_quorum` triggers deterministically
(`mechanical_oracles_first`) — epic budget at or above `budget_ratio` of
the `budgets.yml` per-epic cap, an infra case or a security-sensitive
role/clause, and a confidence below `confidence_threshold` (a task's own
`confidence`, or the planner's `--confidence` self-report). No trigger
fires ⇒ `endorsed`, no provider called:

```json
{"outcome":"endorsed","epicId":"epic-doc","version":1,"triggers":[]}
```

A trigger fires but no external provider is `enabled` ⇒ still `endorsed`
and still free, with the fired triggers reported so you can see what
*would* have been critiqued:

```json
{"outcome":"endorsed","epicId":"epic-doc","version":1,"triggers":[{"kind":"low-confidence","source":"planner","value":0.5,"threshold":0.8}]}
```

Both no-op paths still write a `quorum-decision` event (P9-23). They used
to write nothing, on the reasoning that nothing happened — but "the quorum
endorsed this plan" and "no quorum ever ran" then looked identical in the
log a month later, and only one of them is a reason to trust the plan. The
event carries the triggers that fired (`[]` on the first path) and an
`endorsed_by` naming *why* it was endorsed: `no-triggers`,
`default-no-provider`, or `quorum` when judges actually voted.

`--confidence` is validated, not parsed loosely — a malformed value is
rejected rather than silently read as `NaN` (which compares false against
the threshold and would disable the trigger) or as `0` (which would pin it
on):

```json
{"error":{"code":"cli.invalid-flag","message":"--confidence must be a number in [0, 1], got \"0,7\".","details":{"flag":"confidence","value":"0,7"}}}
```

It is **critique-only**: it never rewrites a plan. Exit 0 means nothing
needs you; exit 1 (`critiqued` or `escalated`) means read the critique
before approving. `escalated` with `reason: insufficient-providers` is the
fail-closed case — exactly one active external provider can never form a
quorum, because `finder_ne_critic` excludes the native claimant.

```bash
smith epic verdict --epic epic-1 --project ../my-project \
  --session <session-id> --causal-parent <event-id>
```

Run it after the last task in the plan lands and before you open the
integration PR. Mechanical oracles run first here too, and their verdict is
final — an epic with non-terminal tasks or open blocking findings is
`hold`ed without spending a judge call:

```json
{"outcome":"hold","epicId":"epic-doc","summary":{"epicId":"epic-doc","tasks":[],"nonTerminalTaskCount":0,"openFindings":[],"integration":{"check":null,"headSha":null},"blockers":["Epic \"epic-doc\" has no tasks in the event log — nothing to integrate."],"mechanicallyReady":false},"reason":"mechanical-blockers"}
```

Exit 1 means `hold` — the epic is not ready, so the PR waits. Its events
are stamped with the reserved `<epic>/integration` ref; `smith plan
quorum`'s use `<epic>/plan-v<n>`. Neither ref is a task, and neither ever
shows up as a kanban card.

`--project` is required, and the reason is the whole of §7a below: the
verdict reads the current head of `smith/<epic>/integration` so it can tell
whether the recorded integration-root check still covers the branch.

## 7a. `smith integration check` — the only command that sees the branch

Every gate in this factory runs inside a task worktree. Schema, tests, lint,
review: all of them are claims about a worktree, none about the branch those
worktrees merge into. The envkit dogfood epic closed with six green per-task
lint gates on an integration branch whose `pnpm lint` exited 1 without
reading a source file (D-42). The run that caught it took eleven seconds and
happened because a human typed it.

This is that run, made a logged fact:

```bash
git -C ../my-project checkout smith/epic-1/integration
smith integration check --epic epic-1 --project ../my-project \
  --checks checks.json \
  --session <session-id> --causal-parent <event-id>
```

`checks.json` is the same `[{"name":..., "cmd":...}]` shape `smith gate run
--checks` takes. Unlike the task gate, every check runs even after one fails
(`--run-all false` opts back into short-circuiting) — closing an epic, you
want the whole picture in one pass.

It **refuses** rather than guesses in four cases, all of which would
otherwise write down a pass nothing earned: an empty check list, an epic with
no integration branch, a project that is not currently on that branch (moving
your working tree for you is not this command's business), and a dirty tree
(the checks would certify something that is not the branch).

```json
{"epicId":"epic-1","branch":"smith/epic-1/integration","headSha":"8962df9...","pass":false,"results":[{"name":"lint","pass":false,"exitCode":1,"tail":"Found a nested root configuration..."}],"eventId":"sess-1#42","ts":"2026-08-07T09:00:00.000Z"}
```

Exit 1 means the assembled branch is broken; raise a finding and fix it as a
task. The record is pinned to the head sha it ran against, so a merge landing
afterwards makes it stale — and `smith epic verdict` then holds with
`is stale: it ran against <sha>, and … is now at <sha>` rather than trusting
a green that has outlived its truth.

## 7b. `smith epic close` — the verdict, written down

`epic verdict` is a probe: free, read-only, re-runnable, and it writes nothing
in the default zero-cost configuration. That is deliberate, and it left the
factory with no record of the one decision most worth keeping — the envkit
dogfood epic was held, and nothing in the log, the projector or the UI says the
verdict was ever run (D-43). `epic close` is the verb that makes the close a
fact.

```bash
smith epic close --epic epic-1 --project ../my-project \
  --session <session-id> --causal-parent <event-id>
```

It runs the same verdict first, then acts on it:

- **`go`** ⇒ appends an `epic-closed` event with `closed_by: "verdict"`, exit 0.
- **`hold`** ⇒ appends **nothing**, exit 1, and names the blockers:

```json
{"error":{"code":"epic.close-refused","message":"Refusing to close \"epic-doc\": the verdict is hold (mechanical-blockers). Pass --override-rationale to close over it.\n  - Task \"epic-doc/task-1\" is not terminal-OK (status: todo).\n  - Epic \"epic-doc\" has no integration-root check on record: …","details":{"epicId":"epic-doc","reason":"mechanical-blockers","blockers":["…"]}}}
```

- **`hold` + `--override-rationale "<why>"`** ⇒ closes anyway, exit 0, and keeps
  the machine verdict it overrode. Closing over a hold is your call to make;
  making it silently is not:

```json
{"epicId":"epic-doc","closedBy":"operator-override","machineVerdict":"hold","machineReason":"mechanical-blockers","overrideRationale":"Carry-forward defects only; tracked as D-99.","blockers":["Task \"epic-doc/task-1\" is not terminal-OK (status: todo)","…"],"summary":{…},"eventId":"demo-1#2","ts":"2026-08-07T05:57:25.885Z"}
```

The event carries the whole summary the verdict was computed from — tasks and
their statuses, open findings, the integration-root check and its head sha — so
the close can be audited later without re-deriving state that has since moved.
An empty or whitespace-only rationale is refused: an override with no reason is
a `go` wearing a costume.

That summary now also states **how wide the epic actually ran**, folded from
the same lineage the verdict already read:

```json
{"concurrency":{"waves":3,"verdicts":{"parallel":1,"partial":0,"serialized":2,"single":0,"unobserved":0},"widest":{"declared":4,"observed":1},"unobserved":[],"problem":null}}
```

`widest` reads "4 tasks admitted at the widest, 1 ever in flight at once" —
which is the shape of an epic that declared parallelism and then ran its plan
one task at a time. `smith wave audit` could always say that, and `smith wave
schedule` could say it before the run, but both are commands somebody has to
remember to type against a state dir that outlives nothing; the close is the
one moment no epic skips. `null` here means nobody measured — it is projected
rather than dropped so it can never be read as "it ran fine" — and `waves: 0`
means no wave was ever cut.

It is **never a blocker**, and the judge prompt says so out loud. Width is not
readiness: a plan whose tasks genuinely depend on one another has nothing to
run side by side, and a gate that held it would be refusing correct work for
the shape of its dependency graph. What the judge is told it *may* refute on
is a wave in `unobserved` — tasks that were admitted with no dispatch on record
at all, which is a declaration with no work behind it.

Because it never blocks, nothing about measuring it is allowed to block either.
`smith wave audit` *refuses* a `wave-admitted` event that names no tasks, which
is right for the command whose whole job is to judge that record; here the same
refusal would take down the close over a fact that decides nothing. So it is
caught and reported instead, in `problem`:

```json
{"concurrency":{"waves":0,"verdicts":{"parallel":0,"partial":0,"serialized":0,"single":0,"unobserved":0},"widest":{"declared":0,"observed":0},"unobserved":[],"problem":"wave-concurrency.missing-task-ids: wave-admitted \"sess-1#4\" names no tasks"}}
```

Read those zeros as *nobody counted*, not as *nothing happened*: when `problem`
is set the counts beside it were never measured. The judge is told the record
could not be read rather than handed a confident `Waves admitted: 0`, and the
epic still closes. Fix the malformed event and the next `smith epic verdict`
reads it — the close does not need re-running to learn the width, because the
width was never what the close turned on.

Closing against a session id with no event log is refused too, rather than
minting a fresh log whose first line is "this epic is closed" (D-45):

```json
{"error":{"code":"epic.unknown-session","message":"Refusing to close \"epic-doc\" against session \"no-such\", which has no event log: the close would be the first line of a log nobody is reading.","details":{"epicId":"epic-doc","sessionId":"no-such"}}}
```

After `smith db apply`, the epic leaves `epicsInFlight` and appears in
`closedEpics` — including in the override case above, where the epic's own task
is still `todo`:

```json
{"epicsInFlight":[],"closedEpics":[{"epicId":"epic-doc","closedBy":"operator-override","machineVerdict":"hold","machineReason":"mechanical-blockers","overrideRationale":"Carry-forward defects only; tracked as D-99.","blockers":["…"],"closedAt":"2026-08-07T05:57:25.885Z"}]}
```

A closed epic stays selectable in the Kanban and Flow epic pickers — a close
makes the board historical, not unreachable.

One close speaks for one epic. `smith epic width` (§7f) reads every close in
the state dir back and answers the question no single close can — whether this
factory builds in parallel, or has been narrow all along.

## 7c. `smith epic spec-review` — reading the plan against the code that exists

The spec-reviewer runs before the code is written, which is the only time it
can stop a bad plan cheaply — and the only time it cannot possibly see the
wave-3 defect above. That one was visible only once a parser existed to reveal
that two criteria contradicted each other. So there is a second dispatch, at
epic close, against composite behaviour:

```bash
smith epic spec-review --epic epic-1 --project ../my-project \
  --plan factory/specs/active/epic-1/plan-v1.json \
  --reviewed-by spec-reviewer [--reviewed-by-provider anthropic:claude-opus-5] \
  [--evidence spec-findings.json] \
  --session <session-id> --causal-parent <event-id>
```

It reads the head of `smith/<epic>/integration` itself and pins the record to
it — like `integration check`, and for the same reason: a review is evidence
about the commit it read and nothing else. With no such branch it **refuses**
(`cli.no-integration-branch`), because a review pinned to a head nobody could
read is a review nothing can be shown to cover.

The event is written even when the evidence is empty. "Ran and was clean" and
"never ran" are different facts, and `smith epic verdict` distinguishes them:
an epic with no closing spec review on record is **held**, and one whose review
read an older head is held as stale. There is deliberately no
`not-required` escape hatch here — an epic can legitimately owe no MCP
surface, but every epic has a plan, and every plan can be wrong in a way only
the finished code reveals.

A review reads two things, and goes stale two ways (D-125). The head it read is
one; the plan version it read is the other, checked against the live
`factory/specs/active/<epic>/plan-v*.json`. The two are independent — an
amendment can be cut before any commit implements it, so a review pinned to the
current head can still be a review of a plan the epic has moved off. An epic
with no readable plan file casts no plan vote at all, the same scope line
`undispatchedTasks` draws (D-126): most epics ran as punch-list branches with no
plan directory, and holding them on an absent file would make them unclosable.

It exits **0 even when it raises findings**: the review ran, and what it found
blocks the plan, not this command. `smith plan amend` (§6a) is what answers it,
and the amended plan then needs a fresh review, because the version this one
read no longer exists — `smith epic verdict` holds the epic until that fresh
review lands:

```
The closing spec review for "epic-1" is stale: it read plan v4, and the
epic's live plan is v5. Whatever the amendment changed has been reviewed
against no spec at all.
```

## 7d. `smith crossfind` — a second eye, not a second vote

Everything in §7 is **subtractive**. A quorum is handed a claim the native
reviewer already raised and asked whether it survives; the strongest thing it
can do is delete a finding. That is a brake, and it is worth having, but it
cannot reach a bug the native reviewer's context never surfaced — nothing
outside that context is asked to look.

`independent_finder` in `crosscheck.yml` is the other direction, and
`smith crossfind` is how you drive it. A finder on a different vendor reads
the diff in a fresh context and returns its own evidence; the two lists are
then reconciled.

```bash
smith crossfind run --task epic-1/task-1 \
  --diff /tmp/task-1.diff --diff-ref smith/epic-1/integration...task-1 \
  --session <id> --causal-parent <event-id>
```

Every reconciled pair lands in one of four outcomes, and only one of them can
do anything:

| Outcome | Meaning | Effect |
| --- | --- | --- |
| `corroborated` | both sides raised the same fingerprint | severity may rise (`severity_resolution`) |
| `co-located` | same file and category, different claim | none — recorded for you |
| `independent-only` | only the finder raised it | mintable as a real finding, and only while gating |
| `native-only` | only the native reviewer raised it | **none, ever** |

The last row is the rule the whole design turns on: **silence is not a
refutation.** The finder was never asked about that native claim — it was
asked to read a diff — so its not mentioning something is absence of evidence.
Subtracting on it would let a truncated or lazy second opinion delete real
findings, which is exactly the failure a second opinion is supposed to
prevent. If you want a claim refuted, that is §7's tier, where a judge is
handed the claim itself.

`co-located` is a hedge with a reason: nothing in this code can tell one bug
described twice from two bugs in one function. It is surfaced and merged by
nobody.

An `independent-only` finding is **minted, not privileged**. It enters the
gate as an ordinary finding carrying `found_by_provider`, and at S1/S2 it
meets the same `quorum_triggers` critic as any other — a third-party vendor's
unshared opinion still has to survive a refute pass before it blocks a task.

### The one switch to read before you enable anything

`send_diff` ships `false`, and `crossfind run` **refuses** rather than
degrading. A critic judges a claim, so §7 can send a summary and a failure
scenario and never the source; a finder has nothing to read but the diff.
Shipping worktree source to a third-party API is your decision, not the
gate's — and the fallback that was available (ask for bugs without showing
the code) is worse than no finder at all, because it produces confident
findings about code the model never saw. `max_diff_bytes` refuses rather than
truncating for the same reason: half a diff is the same failure in a smaller
package.

See the exact bytes first:

```bash
smith crossfind request --task epic-1/task-1 \
  --diff /tmp/task-1.diff --diff-ref smith/epic-1/integration...task-1
```

It prints the `JudgeRequest` and sends nothing. With `send_diff: false` it
refuses — and that refusal is the useful answer, because it tells you the
switch is still off.

`smith crossfind reconcile --task <id> --native <findings.json> --independent
<runs.json>` does the reconciliation over two files you already have: no
provider, no cost, no event. It is pure, so it answers under
`SMITH_CROSSCHECK_OFFLINE` as well.

`run` and `reconcile` exit **1 when the result would change a gate**, which
under `mode: shadow` is never, because nothing it says applies. Both write
one `cross-finding-reconciled` event — the outcome counts, which providers
ran, which were skipped, which failed, and the finding ids it would have
minted. In shadow mode that event is the *only* product of a run, so it is
what you read to decide whether to promote; it has its own timeline row for
that reason (`docs/runbooks/providers.md` §5).

Promotion is the same operator edit as any other provider, with one
arithmetic difference: `min_providers` does not apply. The finder is not
voting on a claim, so one provider is enough to raise — §7's fail-closed
"one active provider changes nothing" is a property of the quorum rule, not
of this block.

## 7e. `smith epic goal-check` — the plan against the goal it was cut from

Every gate up to here reads text the planner produced. The spec review reads
the plan; the task gates read the diffs the plan asked for; the epic verdict
reads what those gates recorded. All of them stay green when the plan
decomposes the *wrong problem* — the criteria are met, the tests pass, the
review closes, and the epic ships something nobody asked for.

The spec-vs-goal check reads the one reference the planner did not write: the
`- goal:` line of the roadmap milestone that owns the epic. Ask for the clause
list first — the split is done here, not left to the judge:

```bash
smith epic goal --epic epic-1 [--roadmap-path factory/specs/roadmap.md]
```

```json
{
  "milestoneId": "phase-1-config",
  "goal": "Load config from .env files. Reject unbalanced quotes.",
  "clauses": ["Load config from .env files.", "Reject unbalanced quotes."],
  "digest": "3f6c1a09b28e4d75"
}
```

It writes nothing — no event, no finding. Hand a judge the clause list and the
plan, take back one verdict per clause, in the goal's order, and record it:

```bash
smith epic goal-check --epic epic-1 \
  --plan factory/specs/active/epic-1/plan-v1.json \
  --coverage /tmp/coverage.json \
  --checked-by spec-reviewer [--checked-by-provider google:gemini-2.5-pro] \
  --session <session-id> --causal-parent <event-id>
```

`--coverage` is a JSON array, one entry per clause:

```json
[
  { "clause": "Load config from .env files.",
    "verdict": "covered", "taskIds": ["epic-1/task-1"] },
  { "clause": "Reject unbalanced quotes.",
    "verdict": "out-of-scope", "reason": "phase-2 owns the parser" }
]
```

Three verdicts, and each one costs something. `covered` must name live plan
tasks — a clause credited to a task the plan does not have is refused
(`goal-check.unknown-task`), because a clause delivered by a task that does not
exist is a clause nothing delivers. `uncovered` mints an **S2-major**
spec-scoped finding against the plan file itself, which no task diff can close:
`smith plan amend` (§6a) is the only answer. `out-of-scope` is the one verdict
that makes a clause disappear, so it demands a `reason` and that reason is
printed back to the epic judge verbatim — it is what an operator most needs to
read.

Everything validates before anything is written. A coverage map that raises two
findings and then names a phantom task on the third clause writes neither
finding and no event: a half-recorded check of a check that never finished is
worse than no check.

**This gate fails closed on a missing goal, and that is the point.** `smith
epic verdict` holds an epic with no check on record; it also holds one whose
owning milestone states no `- goal:` line at all, and `smith epic goal-check`
**refuses to run** there (`cli.no-epic-goal`) rather than record a check
against nothing. There is deliberately no `not-required` escape hatch — the MCP
surface gate has one because an epic can honestly owe no manifest, while "no
goal is stated" is the absence of the only text this gate can grade against.
Treating it as a pass would make the gate skippable by deleting a line from the
roadmap.

The blast radius is worth stating plainly: **an epic whose milestone has no
`- goal:` line does not close.** The fix is a one-line roadmap edit — give the
milestone a goal, or add the epic to the `- epics:` list of a milestone that
already has one.

A check goes stale two ways, the same two `epic spec-review` does (D-125) and
for the same reason:

```
The spec-vs-goal check for "epic-1" is stale: it graded plan v4, and the
epic's live plan is v5. Whatever the amendment changed has been checked
against no goal at all.
```

```
The spec-vs-goal check for "epic-1" is stale: it read a goal that digests to
9b1c…, and milestone "phase-1-config" now declares one that digests to 3f6c….
The plan has been checked against a goal the roadmap no longer states.
```

The second is why `epic goal` prints a digest: rewording the roadmap goal
invalidates a check exactly the way cutting a new plan version does.

Like `epic spec-review`, it exits **0 even when it raises findings** — the
check ran, and what it found blocks the plan, not this command. And like it,
the event is written even when every clause is covered: "ran and was clean" and
"never ran" are different facts, and only the first one closes an epic.

## 7f. `smith epic width` — does this factory build in parallel?

```bash
smith epic width [--session <session-id>] [--state-dir <dir>]
```

Reads, never writes. Every command in §2 answers half a question about one
run: `wave schedule` says how wide a plan *could* go, `wave check` admits a
wave, `wave audit` reads the log back to see whether the admission was
honoured, and `epic close` copies that reading permanently into `epic-closed`.
All four are scoped to the session you happen to be standing in. The claim this
repo makes — that a project here is built by many agents working a plan's tasks
at the same time — is a claim about the *workshop*, and until now nothing could
be asked it.

**So the default is every session in the state dir**, which no other read
command here does, and it is the whole point. A close is written wherever the
epic finished; a lineage-scoped default would answer the factory question with
whatever slice of its own history the operator's terminal happened to be inside
— and report a workshop of one narrow epic and forty wide ones as narrow.
`--session` narrows back to one lineage for anyone who wants the old question.

```json
{"epics":[{"epicId":"epic-1","eventId":"sess-2#31","closedAt":"2026-09-02T11:04:00.000Z","sessionId":"sess-2","project":"../my-project","closedBy":"verdict","machineVerdict":"go","verdict":"parallel","waves":3,"byVerdict":{"parallel":2,"partial":1,"serialized":0,"single":0,"unobserved":0},"widest":{"declared":4,"observed":4},"unobserved":[],"problem":null}],"verdicts":{"parallel":1,"partial":0,"serialized":0,"single":0,"unobserved":0,"unwaved":0,"unmeasured":0,"unreadable":0},"widest":{"declared":4,"observed":4},"serialized":[],"unobserved":[],"unmeasured":[],"hint":"","exitCode":0}
```

It folds the closes rather than re-deriving from the waves, for two reasons and
the second is the one that matters. A close **outlives its lineage**: the
`wave-admitted` and `dispatch_decision` events behind it sit in whichever
session ran the build, and the width was copied into the close precisely so it
would still be there afterwards. And re-deriving **cannot see a close that
measured nothing** — `wave audit` reports the waves that exist, and has no way
to report an epic whose close carried no width at all. Those closes are the
honest answer to "how much of this do you actually know", and a summary that
omitted them would report a factory of three measured epics exactly as
confidently as a factory of three hundred.

Each epic gets one verdict. Five of them are `wave audit`'s, read off the
record rather than recomputed; three are answers no wave can give:

| Verdict | What it means |
| --- | --- |
| `parallel` / `partial` / `serialized` / `single` / `unobserved` | The wave verdicts of §2, as the close recorded them. |
| `unwaved` | The close measured, and this epic never cut a wave. Never a fault — a one-task epic has no wave to cut. |
| `unmeasured` | The close carried no width. Nobody looked. This is not a narrow epic, it is an unknown one. |
| `unreadable` | A width was recorded that could not be read — either `epic close` already reported a `problem` folding it, or the payload is not the shape it should be. |

The epic's verdict is the **best** verdict any of its waves reached, not the
worst. The question is whether the epic ever ran wide; an epic that ran three
waves in parallel and one serially is the factory working, and grading it by
its narrowest wave would report every real build as a failure — which is how a
signal becomes a constant and then becomes noise. The narrow wave is not
thereby hidden: `serialized` names the epic, and the exit code still fails on
it.

Exit codes are `wave audit`'s, deliberately — an operator who learned that code
has learned this one, and a second rule for the same failure is a second answer
waiting to disagree:

- **1** — a closed epic whose record holds a wave that was admitted wider than
  one task and never ran two at once.
- **2** — nothing could be judged: an admitted wave with no work behind it, or
  no close carrying a width at all.
- **0** — otherwise.

What is **not** exit 1, and the discipline the whole command depends on: a
narrow epic. `unwaved` and `single` are not faults. Failing on those would fire
on every honest serial build in the repo, and a code that fires on everything
is routed to `/dev/null` inside a week — taking the serialized one with it.

Exit 2 with an empty `epics` list, or with every epic in `unmeasured`, is the
state a fresh factory is in, and it says so rather than passing:

```json
{"hint":"No close read here carried a width. Either these epics were closed before `smith epic close` recorded one, or the closes were written by hand — close a current epic with `smith epic close`, or read a live log back with `smith wave audit --session <id>`."}
```

"Every epic closed narrow" and "no epic was ever measured" are opposite states
of knowledge, and a factory that has never measured itself must not be able to
read as a healthy one.
