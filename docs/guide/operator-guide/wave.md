# Operator guide — The wave

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 2. `smith wave check`

Before dispatching a wave of tasks concurrently, validate that their claims
are pairwise disjoint, that none share a `serialize_always_globs` hotspot
(`factory/policies/worktree.yml`), and that the plan does not order one of
them after another:

```bash
smith wave check factory/specs/active/epic-1/plan-v1.json epic-1/task-1 epic-1/task-2
```

```json
{"valid":true}
```

On failure you get `overlapViolations` (claims genuinely overlap — cut a
dependency edge and run serially instead) and/or `serializeAlwaysViolations`
(two tasks both touch a hub-file glob like `**/pnpm-lock.yaml`,
`src/types/**`, or `db/migrations/**` — never schedule them together even
if their own claims don't literally overlap) and/or `dependencyViolations`.

`dependencyViolations` is the answer to the remedy the other two hand you
(D-212). Cutting a dependency edge is also what narrows the claims, so a pair
serialized on the last run comes back claim-disjoint — and this check is what
keeps it serialized. Each entry is
`{"task":"epic-1/task-2","dependsOn":"epic-1/task-1","chain":[...]}`: the plan
orders `task` after `dependsOn`, so they cannot be in one wave. `chain` is the
shortest path of `depends_on` links between them, which matters because the
check is transitive — `{a, c}` under `c <- b <- a` is refused even though no
single edge names both, since leaving b out of the wave is what makes a and c
concurrent, not what makes them safe. Every `edge_type` counts: `artifact`,
`claim-order`, `spec-clause`, `regression-test` and `research-brief` all mean
"runs after". Split the wave and run the prerequisite first.

If the plan's `edges` is not a list of `{task, dependsOn}` records the wave is
refused with `claims.unreadable-edges` rather than checked, on the same
principle as an unreadable claim set: an edge list that cannot be read is not
an empty one, and empty is the answer that admits.

The hotspot check asks whether a claim could actually name a protected file:
one glob has to contain the other's concrete path. `src/auth/**` and
`**/pnpm-lock.yaml` share no hotspot, because nothing `src/auth/**` matches is
a lockfile the second glob is protecting. `packages/**/pnpm-lock.yaml` does,
and so does `**` — a claim on everything is a claim on the lockfile too.

It used to ask a looser question — whether the two globs *could* both match
some hypothetical path — and under that reading every claim ending in `/**`
shared every hotspot. The practical effect was invisible and total: realistic
subtree claims are the normal way to scope a task, so no wave wider than one
was ever admissible, and the gate said `valid: true` about each singleton it
was handed. Claims no longer need to be narrowed to route around it; scope
them to what the task writes.

After a task runs, `smith claims check <worktree-dir> <spec.json>` classifies
what that branch committed against the task's `claims[]`. The planner and the
scribe have no claims — they write outside any worktree, on an ordinary branch,
and hand their output back uncommitted — so they get the same classifier
through a different collector (P9-3):

```bash
smith claims check . --roots 'factory/specs/active/epic-1/**' --since "$BASE_SHA"
```

Exit 0 means every changed path (staged, unstaged and untracked alike) is
inside a root; exit 1 prints `violation.files` with
`contract.write-root-violation`. Repeat `--roots` for each root rather than
comma-joining them — a glob may contain a comma. `--since` is optional and
takes a sha captured before the dispatch: the planner holds `Bash`, so it can
commit its own work and leave a clean tree that a working-tree-only check would
call a pass.

### `smith wave next` — the wave you did not have to guess

`wave check` answers a closed question — may *these* task ids run together —
and answers it well. But it only ever sees a set someone already picked, and
the safest set to pick is always a set of one: a single task is disjoint with
nothing, shares a hotspot with nothing, and crosses no import edge with
nothing, so it passes every check above. The gate cannot tell a deliberate
wave of one from an orchestrator that never thought to ask for more, and both
come back `valid: true`. A factory whose whole claim is parallel execution
therefore had no command that computes parallelism; it had a command that
declines to forbid it.

```bash
smith wave next factory/specs/active/epic-1/plan-v1.json \
  --session <session-id> --repo <project-dir>
```

```json
{"epicId":"epic-1","wave":["task-3","task-4","task-6"],
 "deferred":[
   {"taskId":"task-1","reason":"symbol-coupled","blockedBy":["task-3"],
    "detail":"Imports symbols from task-3, which has not merged: the producer runs first."},
   {"taskId":"task-2","reason":"claim-overlap","blockedBy":["task-5"],
    "detail":"Claims overlap task-5 (src/db/** vs src/db/schema.ts)."}],
 "done":["task-7"],"occupied":["task-5"],"remaining":3}
```

`wave` is the widest set admissible right now, ordered so that a producer is
offered ahead of the consumer that imports it. Every task left out is in
`deferred` with one of four reasons — `dependency-pending`, `claim-overlap`,
`serialize-hotspot`, `symbol-coupled` — and the ids that held it back, so a
short wave always comes with its explanation. `done` is terminal work
(`completed`, `waived`); `occupied` is everything non-terminal that is not a
candidate, which includes `blocked` and `failed`: those are waiting on a
person, not on nothing, and their worktrees still hold their claims.

Three things it deliberately does not do.

It **writes nothing**. `wave-admitted` is what moves a task to `ready`, and
this command proposes rather than admits, so it is safe to ask at any moment
and safe to ask twice. `wave check` stays the single place a wave is admitted.

It **does not price the wave**. Cost and `max_in_flight_tasks` are `wave
check`'s verdict, and a proposer that also priced would have to decide which
task to drop — an operator's call, not a graph's. A proposed wave can still be
refused for cost on the next line; that is the gate working.

It **does not trust the plan file about status**. `task_status` in a plan is
the task's *initial* status, and a plan read from disk hours into a run still
says `todo` about work that finished. `--session` reads the live status from
the lineage log, and picks up follow-up tasks that `findings raise` minted
into the log and into no plan file — a task that exists, is admissible, and
would otherwise be offered to nobody.

Exit 1 means work remains and none of it can start: a stall worth reporting,
distinguished from the epic simply being finished, which is an empty `wave`
with `remaining: 0`.

### `smith wave audit` — did the wave that was admitted actually run wide?

`wave next` proposes a wave and `wave check` admits one. Both are statements
about the future, and both are written before a single agent starts. Nothing
read them back. A dispatcher that admits three tasks and then runs them one
after another produces exactly the same log line as one that ran all three at
once — `wave-admitted` records the width that was *permitted*, never the width
that happened — so the factory's central claim, that work is executed by many
agents in parallel, was the one claim it could not check on itself.

It can now, because the evidence was already there. `dispatch_decision` says
when an agent went live and its terminal event says when it stopped; folding
that pair per task gives the interval each task was actually running, and the
most intervals overlapping at any instant is the width the wave really had.

```bash
smith wave audit --session <session-id> [--epic epic-1] [--state-dir <dir>]
```

```json
{"waves":[{"eventId":"s1#1","admittedAt":"2026-09-02T09:49:50.925Z","epicId":"epic-1",
  "declared":["epic-1/task-1","epic-1/task-2","epic-1/task-3"],
  "observed":[
    {"taskId":"epic-1/task-1","startedAt":"...:51.320Z","endedAt":"...:52.107Z","roles":["coder"]},
    {"taskId":"epic-1/task-2","startedAt":"...:51.711Z","endedAt":"...:52.498Z","roles":["coder"]}],
  "unobserved":["epic-1/task-3"],"peak":2,"verdict":"partial"}],
 "serialized":[],"partial":["epic-1"],"unobserved":[],
 "widest":{"declared":3,"observed":2},"hint":"","exitCode":0}
```

Each wave gets one of five verdicts. `parallel` is peak concurrency at least
as wide as the wave was declared. `partial` is narrower than declared but more
than one at a time. `serialized` is work that was recorded and never once
overlapped. `single` is a wave of one, which cannot be either. `unobserved` is
a wave with no dispatch under any of its tasks at all.

The last two distinctions are the point of the command, so it is worth being
plain about them.

**`serialized` and `unobserved` are different facts and get different exit
codes.** Exit 1 says the dispatcher ran your wave one task at a time — that is
a factory not doing its job. Exit 2 says the wave was admitted and the log
shows no work for it, which is either a dispatcher that never started or
agents that ran outside the lineage being read; the two readings are a
different investigation and the command names both in `hint` rather than
guessing. Scoring "cannot tell" as "ran narrow" would have manufactured
failures out of a state dir pointed at the wrong place.

**`partial` does not fail.** Three admitted and two in flight is the factory
working — a dependency landed late, an agent finished early. An exit code that
cried about that would be routed to `/dev/null` inside a week and would take
the `serialized` signal with it.

Two smaller decisions that change what the numbers mean.

A task that finishes at the exact instant the next one starts counts as a
**handoff, not as concurrency**. Without that rule a strictly serial
dispatcher would score `parallel` on nothing but the clock's granularity,
which is precisely the lie this command exists to catch.

The audit reads the **whole lineage**, not the session that happens to ask, for
the same reason `wave next` and the budget check do (D-119). An epic's waves
are not confined to one session, and a wave admitted in session 1 whose agents
ran in session 2 would otherwise come back `unobserved` — the factory reported
broken on nothing but where the operator was standing.

An agent still running has no terminal event, and its task is treated as open
rather than as instantaneous: a wave audited mid-run reads as wide as it
currently is, not as narrow as its finished work. The command writes nothing,
so it is safe to ask at any moment and safe to ask twice.

### `smith wave schedule` — how wide can this plan *ever* run?

Three commands now bracket parallelism and all three take the plan as given.
`wave check` says these tasks may run together. `wave next` says these are the
ones that can start now. `wave audit` says here is what actually ran. None of
them can answer the question that comes first: is this plan capable of running
wide at all?

It is not a hypothetical. A plan whose tasks all claim overlapping globs has a
ceiling of one no matter how many agents are free, and every check downstream
signs off on it — each wave of one is admitted, each runs faithful to its
admission, and the epic serializes with nothing anywhere reporting a problem.
The cost is decided at plan time and every command that could have named it
runs too late to matter.

So this one replays the dispatcher against the plan. It calls the same
`computeNextWave` the real wave loop calls, marks the returned wave complete,
and calls it again until nothing more can start.

```bash
smith wave schedule factory/specs/active/epic-1/plan-v1.json \
  --session <session-id> --repo <project-dir>
```

```json
{"epicId":"epic-1",
 "rounds":[
   {"round":1,"tasks":["task-1","task-4"],
    "avoidable":[{"taskId":"task-2","reason":"claim-overlap","blockedBy":["task-1"],
                  "detail":"Claims overlap task-1 (src/db/** vs src/db/schema.ts)."}]},
   {"round":2,"tasks":["task-2"],"avoidable":[]},
   {"round":3,"tasks":["task-3"],"avoidable":[]}],
 "depth":3,"widest":2,"scheduled":4,"stalled":[],"occupied":[],
 "constraints":[{"reason":"claim-overlap","tasks":["task-2"],"blockedBy":["task-1"],
                 "detail":"Claims overlap task-1 (src/db/** vs src/db/schema.ts)."}],
 "hint":"This plan runs in 3 rounds, and some of that depth is claim geometry…",
 "exitCode":2}
```

`depth` is how many sequential waves the plan needs; `widest` is the most
tasks any one round starts, which is the parallelism ceiling — the number of
agents beyond which this plan cannot use another one. Because both come out of
the containment code itself rather than a second model of it, the ceiling
reported here is the ceiling the dispatcher will hit.

**The one distinction that makes the output actionable.** A task deferred
`dependency-pending` is waiting on work it genuinely needs. That is the shape
of the problem, not a defect: a chain of five real dependencies takes five
rounds and no re-slicing changes it, so a plan serialized purely by its own
declared edges exits `0` with an empty `constraints`. A task deferred for any
other reason had its dependencies satisfied, was ready to run that round, and
was held back only by how the planner drew the claims. Those are the ones
collected into `constraints`, and only those.

Exit `2` means the plan runs but loses width to something a re-slice could
fix. Exit `1` outranks it and means the plan **stalls** — `stalled` names
candidate tasks no round could ever start, which is a plan that cannot be
finished as written.

What it deliberately does **not** do is claim a counterfactual. It never says
"re-slice these two and the plan runs in three rounds instead of five",
because knowing that would mean inventing the claim geometry the planner would
have written instead, and the dependency graph may simply bind next. It names
which tasks were held back, by whom, and in which round; whether that is worth
re-planning is yours to decide, with the numbers to decide on.

Two notes on reading it mid-run. `occupied` lists non-terminal tasks that are
not candidates — mid-flight, or waiting on a person. The simulation can
complete a task but it cannot un-block one, so an occupied task holds its
claims in every round, and a candidate it overlaps will show up in `stalled`
with that task named in `blockedBy`. And the honest reading of the ceiling is
on a plan whose tasks have not been dispatched yet; asked halfway through a
run, the answer mixes in where the run currently stands.

Like `wave next`, it writes nothing — and here there is a second reason. Every
round after the first is a simulation, its tasks completed by nobody. A log
that recorded them would be claiming work that has not happened.

### The blind spot a claim has by construction (P9-3)

`wave check` also asks a second question, and it is not about globs. Two
tasks can hold claims that are pairwise disjoint, share no hotspot, and carry
no dependency edge, and still be unsafe to run together: task A changes
`parse()`'s signature in `src/a.ts`, task B calls `parse()` from `src/b.ts`,
every claim check is green, and integration is where the factory finds out.
The conflict was never in a file. It lived on the import edge between two
files, which is the one place a comparison of two lists of paths cannot look.

So the verdict carries a `symbolImpact` beside the claim result:

```json
{"valid":true,
 "symbolImpact":{"status":"coupled","ok":false,
   "crossings":[{"producer":"epic-1/task-a","consumer":"epic-1/task-b",
                 "exportedBy":"src/a.ts","importedBy":"src/b.ts",
                 "symbols":["parse"],"typeOnly":false,"dynamic":false}],
   "detail":"1 symbol crossing(s) across 1 task pair(s): run them in order, not in parallel."}}
```

`valid: true` and exit 1: read it as *"these claims really are disjoint, and
that is not enough"*. The remedy is the same one the other violations hand
you — split the wave and run the producer first.

There is no override for a crossing, and that is deliberate rather than an
oversight. The dependency check above already refuses a wave holding both ends
of an edge the plan *declared*, so any crossing that reaches this check is
between two tasks the plan declared **no** edge between: it is exactly the
dependency the planner missed. Refusing costs one extra wave; admitting costs
an integration conflict plus the round trip to find it. Only the budget verdict
is overridable (`--override-rationale`), because a cost ceiling is a judgement
call and a compile-time edge is not.

`--repo <dir>` names the checkout the graph is read from; it defaults to the
repository root. The claims say which files a task *may* write, and only the
tree says what those files import today, so the declarations are read off the
checkout rather than off the plan.

Two things this check reports without failing the wave. `exposure` names a
file outside every claim that imports from a claimed file — a consumer nobody
in this wave is watching, worth knowing and not evidence of anything.
`unanalyzed` and `unresolved` name the scanner's blind spots: a file it could
not parse, a specifier it could not resolve. Holes are never fatal here, on
purpose — failing a wave for the scanner's limits would teach operators to
reach for the override, which costs more than the check was ever worth.

### `smith claims impact` — the same two questions, asked directly

The gate above runs inside `wave check`. The same machinery is a verb, in two
forms, because the pre-run and post-run questions have genuinely different
answers.

**Before dispatch, over declarations:**

```bash
smith claims impact --plan factory/specs/active/epic-1/plan-v1.json task-a task-b
```

Identical to what `wave check` folds in — exit 1 on `coupled`. Useful while
cutting a plan, when you want the coupling answer without a session, a state
directory, or a budget policy.

**After the work, over a diff:**

```bash
smith claims impact "$WORKTREE" factory/specs/active/epic-1/task-1.json
```

```json
{"ok":false,
 "breaks":[{"severity":"proven","reason":"removed",
            "exportedBy":"src/a.ts","importedBy":"src/theirs.ts","symbols":["gone"]}],
 "detail":"1 importer(s) outside the claims lost a symbol they use."}
```

Here the finding is not a risk but a fact. The task removed an export, and a
file **outside its claims** still imports it: that is a break, and the branch
carries the proof. `severity` is the whole contract of this form:

- `proven` / `removed` — the symbol is gone and someone outside the claims
  imports it by name. Exit 1. Nothing to weigh.
- `possible` / `signature-changed` — the export survived but its declaration
  text changed. Exit 0. This is a text-level scanner, not a type checker: it
  compares each export's clause up to the first `;` or `{`, so a widened
  parameter type and a changed constant both read the same way. It says
  `possible` and means it.

A worktree is a full checkout, so it is both halves of the question at once —
the diff this task committed against its integration branch, and every importer
in the repository. Run it after the test gate and before merge-queue admission,
where a real break is still one task's problem.

### Why the scanner is hand-written

`factory/orchestrator/src/symbols.ts` reads imports and exports with its own
parser rather than calling into TypeScript, and the reason is not preference.
`typescript@7.0.2` is the native (tsgo) rewrite: it ships `"main": null`,
`"types": null`, and exports only `./lib/version.cjs` plus two `unstable`
entry points. `ts.createSourceFile` does not exist to be called. The scanner
also resolves a `/dist/` specifier back to `/src/` when the build path has no
file, because this repository's own source imports its build output.

That is why every verdict above is careful about what it claims: a scanner can
prove an export is gone, and cannot prove a type is compatible.
