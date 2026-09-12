# Operator guide — The wave and its dispatch audits

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

## 2a. `smith security triggers` — the security-reviewer's dispatch condition

The `security-reviewer` is conditional dispatch only, and its first trigger is
"the task's claims touch a sensitive path". That used to mean reading
`factory/policies/sensitive-paths.yml` and deciding by eye, which is the same as
saying some tasks got a security review and others didn't (P9-4). Ask instead:

```bash
smith security triggers --task factory/specs/active/epic-1/task-1.json
```

```json
{"taskId":"epic-1/task-1","dispatchSecurityReviewer":true,
 "triggers":[{"trigger":"sensitive-claim-path","claim":"src/parse.ts","glob":"**/*parse*.{ts,tsx,js,jsx,py,go,rs,rb,java}"}]}
```

**Exit code is 0 either way** when the command can answer — a fired trigger is a
dispatch instruction, not a violation, unlike `claims check` and `wave check`.
Read `dispatchSecurityReviewer`; dispatch the reviewer iff it is true. Each
trigger names its own evidence: the claim and the glob that fired it, so a
surprising result is arguable against the policy file rather than against a
boolean.

Matching is **overlap, not containment**: a task claiming `src/**` fires against
`**/auth/**`, because such a task really could add `src/auth/session.ts`
tomorrow. The consequence is that an open-ended `<dir>/**` claim fires most of
the directory globs in the policy — for a security trigger that is the safe
direction to err in, and it is another reason to scope claims narrowly. The
`exclude` list is the opposite: containment only, so `**/*.test.ts` silences
`src/parse.test.ts` but can never silence `src/**`.

A claim narrowed by *extension* overlaps for the same reason a wide directory
claim does: `ui/src/**/*.tsx` fires `**/auth/**` because it can add
`ui/src/auth/Login.tsx` tomorrow. One shape still slips through — both sides
constraining the filename in different ways, as in a `src/*.vue` claim against
`**/*jwt*` — and it errs toward *not* firing, so a claim that looks sensitive
while the verb stays quiet is still worth dispatching by judgement.

The other two triggers come out of the same call. `case` is read from the task
spec (`--case <name>` overrides it); epic tags and scheduled rechecks have no
home in the schema yet, so the operator asserts them:

```bash
smith security triggers --task <spec.json> --epic-tag security --recheck
smith security triggers --task <spec.json> --policy /path/to/other.yml
```

## 2b. `smith dispatch check` — was the critic actually adversarial?

`crosscheck.yml`'s `asymmetric_roles.finder_ne_critic` has said since Phase 1
that the spec-reviewer "never runs on the planner's own model" and the
verifier "never runs on the reviewer's own model". Nothing read it. Worse,
nothing *could* have: `dispatch_decision` recorded `model_tier`, and opus and
fable are both `frontier`, so the log had no way to answer the question even
if something had asked (P9-23).

Two things changed. `dispatch_decision` now requires a concrete `model`
alongside `model_tier`, and `crosscheck.yml` names the pairs it means instead
of only asserting that pairs exist. So the rule became checkable:

```bash
smith dispatch check <session-id> [--task <task-id>] [--policy <path>]
```

```json
{"sessionId":"s-1","taskId":null,"dispatchesExamined":2,"criticWorkExamined":1,
 "checks":[{"finder":"planner","critic":"spec-reviewer","criticEventId":"s-1#2","criticModel":"gpt-5-codex","finderEventId":"s-1#1","finderModel":"claude-opus-5","status":"ok","detail":"spec-reviewer ran on gpt-5-codex; planner ran on claude-opus-5."},
 {"finder":"reviewer","critic":"verifier","status":"not-applicable","criticEventId":null,"criticModel":null,"finderEventId":null,"finderModel":null,"detail":"No verifier dispatch in scope; the pair had nothing to check."}],
 "ok":true}
```

Every check names both events it compared, so a surprising verdict is
arguable against the log rather than against a boolean. Note the second
entry: the `reviewer`/`verifier` pair is reported as `not-applicable`, not
omitted. An audit that silently drops the pairs it had nothing to say about
produces a short clean report that looks the same whether the verifier ran
correctly or never ran at all.

Each critic dispatch is checked against **the latest finder dispatch at or
before its own timestamp** — not the newest one in the session. A re-plan on
a different model an hour later cannot retroactively make an earlier review
adversarial, and comparing against the newest finder would let exactly that
launder a violation into a pass. Every critic dispatch is checked, not just
the last: a session that got it wrong once did get it wrong once.

A violation names what it caught and exits 1:

```json
{"finder":"planner","critic":"spec-reviewer","criticEventId":"s-2#2","criticModel":"claude-opus-5","finderEventId":"s-2#1","finderModel":"claude-opus-5","status":"violation","detail":"spec-reviewer ran on claude-opus-5, the same model as the planner dispatch it followed."}
```

`model` is required at write time, so this cannot be dodged by omitting the
field — the append is refused, not accepted with a gap:

```json
{"error":{"code":"events.invalid-payload-dimensions","message":"Event payload for \"dispatch_decision\" failed taxonomy validation: Record type \"dispatch\" is missing required field \"model\".","details":{"event_type":"dispatch_decision"}}}
```

It is required rather than optional on purpose. An optional field is dropped
precisely where it matters most, and its absence would then read as
compliance — which is the failure this field exists to prevent. It is
*presence*-checked rather than drawn from a closed vocabulary for the mirror
reason: model ids turn over monthly, and an enum would either reject next
month's model or, far likelier, get the field quietly dropped instead of the
taxonomy bumped. A CLI-transport provider that genuinely does not know its
model records `<command>:default` rather than inventing an id.

Four statuses, and **exit 1 on two of them**:

| Status | Meaning | Counts as failure |
|---|---|---|
| `ok` | Critic and finder ran on different models | no |
| `violation` | Same model — the critique was not independent | **yes** |
| `unverifiable` | A dispatch records no model, the critic has no finder before it to compare against, or a recorded review has no dispatch behind it | **yes** |
| `not-applicable` | That critic neither ran nor recorded any work in scope | no |

`unverifiable` failing is the deliberate part. "I cannot tell" that exits 0 is
indistinguishable from "it held", and that confusion is the entire reason this
command exists. A policy declaring no pairs is itself `unverifiable`, for the
same reason: an audit nobody configured must not report a clean bill.

Pre-P9-23 events survive in the report with `model: null` rather than being
filtered out. The log is append-only and is never rewritten, and dropping them
would turn "this dispatch cannot be checked" into "no such dispatch happened"
— a cleaner-looking report than the history it describes.

### Reviews that arrive without a dispatch (D-124)

Critic work reaches the log by two routes, and this command reads both.
`smith epic spec-review` appends `spec-review-recorded` and no dispatch
record at all, so for a while a closing review nobody dispatched was not
`unverifiable` here — it was *invisible*, the pair read `not-applicable`, and
the report exited 0 on a session in which no critic had run.

Two commands write critic work this way, and the audit's domain
(`CRITIC_WORK_EVENTS` in `dispatchAudit.ts`) names both: `spec-review-recorded`
from `smith epic spec-review`, reading `reviewed_by`, and
`goal-check-recorded` from `smith epic goal-check` (§7e), reading `checked_by`.
The second was listed the day it was written rather than after its own D-124,
because enumerating the domain is not documentation here — it *is* the check,
and an event type missing from that map is a critic that can never be found
unaccounted for.

Each record in scope must now be answered for by a `spec-reviewer` dispatch
that preceded it, and each dispatch answers for at most one record. That last
clause is why a closing epic needs two `spec-reviewer` dispatches: the review
and the goal check are separate work, and one session cannot vouch for both.
Order matters as much as count, because the window is *(previous record of
this role, this record]* — dispatching both sessions up front and then typing
both commands leaves the second record with nothing inside its window, since
the earlier dispatch already answered for the first. Dispatch, record,
dispatch, record.
An unanswered record is reported as `unverifiable` against its own event id,
with `criticModel: null` — no dispatch chose a model, so there is nothing to
compare and the audit says so out loud:

```json
{"finder":"planner","critic":"spec-reviewer","criticEventId":"s-3#380","criticModel":null,"finderEventId":null,"finderModel":null,"status":"unverifiable","detail":"spec-reviewer recorded a spec review at 2026-08-16T09:12:04.881Z with no spec-reviewer dispatch behind it, so no model is on record and finder_ne_critic cannot be evaluated."}
```

One dispatch per record is the point. Letting an old dispatch vouch for every
later hand-recorded re-review is the same laundering the finder side already
refuses, and `found_by` cannot close the gap from the other end: it is
validated against the taxonomy `agent` dimension, so an operator-authored
review can only be labelled `spec-reviewer`, and read by that label alone an
independent reviewer appears to have run.

`criticWorkExamined` counts these records the way `dispatchesExamined` counts
dispatches — separately, so neither number claims coverage the other supplied.

## 2c. `smith escalation check` — did the ladder actually get climbed?

`budgets.yml`'s `escalation_ladder` has said since Phase 1 that two failed
rounds on a task escalate the model tier and three escalate to the operator,
and that rungs are "never skipped and never looped past their bound".
`budgets.ts` said in its own header that nothing parsed it. So a task could
fail four rounds on sonnet with the operator never told, and the log would look
identical to a task that climbed the ladder correctly (P9-32).

The rungs now carry a machine-readable half — `failed_rounds` and a closed
`enforce` keyword — beside the prose `trigger`/`action`, and this asserts them
against the log:

```bash
smith escalation check <session-id> [--task <task-id>] [--policy <path>]
```

```json
{"sessionId":"s-1","taskId":null,"roundsExamined":2,
 "checks":[{"taskId":"epic-1/task-1","rung":1,"triggerRounds":1,"failedRounds":2,"status":"not-applicable","triggerEventId":"s-1#2","detail":"Rung 1 declares no action (bounded retry on the same contract); there is nothing for the log to evidence."},
 {"taskId":"epic-1/task-1","rung":2,"triggerRounds":2,"failedRounds":2,"status":"ok","triggerEventId":"s-1#4","detail":"Retried on frontier after failing on mid."}],
 "ok":true}
```

A **failed round** is one `gate-outcome` with outcome `blocked`. A **retry** is
a `coder`, `tester` or `uiux` dispatch — the roles that produce the diff the
gate scores; `budgets.yml` already names the rest as judges and narrowing
roles, and a judge re-run is not another attempt at the work.

Every rung a task reached is reported, not only the highest. A task that
skipped the tier rung and then hit the operator rung *did* skip the tier rung,
and the ladder's own note calls that a coordination error.

Statuses and exit codes match `dispatch check` exactly — `violation` and
`unverifiable` both exit 1, for the same reason:

| Status | Meaning | Counts as failure |
|---|---|---|
| `ok` | The rung's obligation is evidenced in the log | no |
| `violation` | The rung tripped and the obligation was not met | **yes** |
| `unverifiable` | The log or the policy cannot answer — no ladder declared, an `action` with no `enforce`, an unknown `enforce` keyword, a dispatch with no `model_tier`, a blocked round with no task id | **yes** |
| `not-applicable` | The rung declares no action (rung 1), or it never tripped, or the failing round already ran at the top tier | no |

**What the rung-3 check does not claim.** Nothing in the log records the
handoff itself — no event says "the operator was told". So rung 3 asserts the
*bound*, not the notification: after the third failed round the task must not
run again until an operator answer appears (a `user_prompt`, or a waiver
granted or denied for the task). A task that simply stopped passes, and the
detail string says exactly that much:

> `3 failed rounds and nothing after them — the bound held. The log records no operator-handoff event, so this check asserts the bound, not the notification.`

Closing the other half needs a new event type, which is a taxonomy version bump
plus an architecture §8 edit — deliberately not folded into this change.

**"The task ran again" is read from two traces**, because either can be
missing: a builder `dispatch_decision`, and the next `gate-outcome`. Running
this against the dogfood log is what forced the second one in:

```json
{"taskId":"task-1b-parse-quotes","rung":2,"triggerRounds":2,"failedRounds":2,"status":"unverifiable","triggerEventId":"dogfood-envkit-1#45","detail":"The task was gated again at 2026-08-06T10:47:04.274Z after 2 failed rounds, but no builder dispatch is recorded for that round, so the tier it ran on is unknown."}
```

That task blocked twice, then passed, with no `dispatch_decision` event anywhere
against it — Phase 9's own D-46 gap. Reading dispatches alone reported it as
"never dispatched again, the rung was never exercised", which is a clean bill
of health issued over a hole in the record. It now exits 1 and names the hole.

## 2d. `smith tester check` — did a tester grade the code, or did the coder?

`dispatch check` above asks whether the critic ran on a different *model*. For
a tester that is the wrong question: a tester may legitimately run on the
coder's model, and forcing a second vendor onto it would buy nothing. The risk
is a different one — a coder that writes and runs its own tests grades itself,
and every gate downstream still goes green over it.

The thing that separates those two cases in the log is not a model, it is a
**turn**. A `dispatch_decision` is written by the node that dispatched and
never by an agent about itself, so a second dispatch is the only evidence the
log can hold that a second turn happened at all. (Who may be such a node is
`delegation.yml`, asserted by [§2e](#2e-smith-delegation-check--did-the-node-that-dispatched-own-its-log)
— run the two together.) `crosscheck.yml`'s `role_isolation.pairs` names the
pair (one entry: `coder` / `tester`), and this asserts it per test gate:

```bash
smith tester check <session-id> [--task <task-id>] [--policy <path>]
```

```json
{"sessionId":"s-1","taskId":null,"gatesExamined":2,"dispatchesExamined":3,
 "checks":[{"taskId":"epic-1/task-1","worker":"coder","auditor":"tester","gateEventId":"s-1#5","workerEventId":"s-1#1","auditorEventId":"s-1#3","status":"ok","checksRun":2,"detail":"tester was dispatched for epic-1/task-1 after coder and reported (task-result-recorded) before the gate graded 2 test check(s)."},
 {"taskId":"epic-1/task-2","worker":"coder","auditor":"tester","gateEventId":"s-1#7","workerEventId":null,"auditorEventId":null,"status":"violation","checksRun":1,"detail":"No tester was dispatched at or before the test gate for epic-1/task-2, so the 1 test check(s) it graded were written in some other role's turn — on this pipeline, coder's."}],
 "ok":false}
```

One check per `testgate-result` per pair, in log order. A gate passes only if a
tester was dispatched **at or before** it, after a coder dispatch, under a
different `agent_id`, and reported something (`task-result-recorded`,
`error-logged`, `judge-reported` or `judge-verdict`) before the gate ran. An
`error-logged` counts: a tester that ran and failed still ran in its own turn,
and demanding success here would conflate isolation with outcome.

| Status | Meaning | Counts as failure |
|---|---|---|
| `ok` | A tester was dispatched separately, after the coder, and reported before the gate | no |
| `violation` | No tester dispatch precedes the gate, or the two dispatches share one `agent_id` | **yes** |
| `unverifiable` | The gate names no task, records no result list, has no coder dispatch to be isolated from, or the tester never reported before it — also a policy declaring no pairs, and a session with no test gate at all | **yes** |
| `not-applicable` | The gate ran zero checks, so there was no verdict to grade | no |

**Absence is the finding here, and that is what makes this a separate command
rather than another `asymmetric_roles` pair.** In `dispatch check` a critic
that never ran is `not-applicable` and exits 0 — a session that dispatched no
verifier simply had nothing to verify. Here, a test gate that graded checks
with no tester behind it is precisely the failure being hunted, so the same
shape of evidence gets the opposite verdict. Two opposite defaults cannot live
in one matcher.

A missing `agent_id` never downgrades a check. It is an *optional* top-level
event field, not part of the dispatch payload contract, so "not recorded" is
read as not recorded and never as "same agent" — the alternative makes every
real log `unverifiable`. The same-id check therefore catches the case where the
dispatcher did stamp ids and they match, and stays silent otherwise.

**What it does not claim.** Nothing in the log distinguishes a test file the
tester authored from one it merely ran, so this answers "was a tester
dispatched separately, and did it report, before this task's tests were
graded?" — not "did that tester write the tests". `role-write-scope` in
`guardrails.yml` fences where a leased tester may write; the two checks are
complementary, not substitutes.

## 2e. `smith delegation check` — did the node that dispatched own its log?

The two checks above both read *a second dispatch* as proof of *a second
turn*. That reading has a premise: whoever writes a `dispatch_decision` owns
the log it lands in. While no role template held `Agent`, the premise was free
— only the operator session could dispatch, so it was true by construction.

It is no longer free. `factory/policies/delegation.yml` grants `Agent` to
`wave-runner`, so an epic can hand a whole wave to a dispatched agent instead
of spending its own window on it. This command is what keeps the premise true
under that grant, and it asks two questions that fail apart:

```bash
smith delegation check <session-id> [--task <task-id>] [--policy <path>] [--crosscheck <path>]
```

```json
{"session":"epic-1",
 "grants":{"grantsExamined":1,"templatesExamined":13,
  "checks":[{"role":"wave-runner","status":"ok","detail":"wave-runner may dispatch coder, tester, … and must open its own session first; its template holds `Agent` and the grant contradicts no crosscheck.yml pair."}],
  "ok":true},
 "log":{"sessionId":"epic-1","taskId":null,"dispatchesExamined":2,"delegatedSessions":1,
  "checks":[{"role":"wave-runner","sessionId":"wave-1","taskId":"T1","eventId":"epic-1#1","status":"ok","detail":"wave-runner was dispatched at epic-1#1 and opened session wave-1 against it, so the dispatches it writes are its own log's."}],
  "ok":true},
 "ok":true}
```

**`grants` is the topology**, and it reads files, not logs — the same answer
before a run as after one. It fails a grant whose role is not in the taxonomy,
a grant naming a target that is not, a template that lists `Agent` with no
grant behind it, a grant whose role ships no template (D-191, both
directions), a scoped `Agent(…)` whose scope disagrees with the policy, and
above all three shapes of self-judging: a role granted **itself**, a worker
granted its own **auditor** from `role_isolation.pairs`, or a finder granted
its own **critic** from `asymmetric_roles.pairs`. That last group is the whole
point. A `coder` granted `Agent(tester)` picks and prompts the agent that
grades it, and §2d goes green over a coder grading itself — widening one list
in one file would silently disarm a check in another.

**`log` is the run.** Every grantee dispatch is matched against a
`session-start` whose `causal_parent` is that dispatch's event id: that is what
`smith session start <wave-id> --continues <dispatch-event-id>` writes. A
grantee that dispatched from inside the dispatcher's session, or dispatched a
role outside its grant, is a `violation`.

| Status | Meaning | Counts as failure |
|---|---|---|
| `ok` | Every grant is sound, and every grantee opened its own log before dispatching inside its grant | no |
| `violation` | A grant hands a role its own judge, a template and the policy disagree, or a grantee dispatched without a log of its own | **yes** |
| `unverifiable` | A grantee was dispatched and has not opened its session *yet* — it still may, which is exactly why this is not a pass | **yes** |
| `not-applicable` | No grant exists and no template holds `Agent`, or no dispatch in this lineage involves a granted role | no |

Read lineage-wide (D-119), and here that is the point rather than a nicety:
the dispatches a wave-runner writes live in the wave's session, so a check
scoped to the epic's own log would report the delegation it exists to audit as
never having happened. Either id answers — `delegation check epic-1` walks
down into the wave, `delegation check wave-1` walks up to the epic.

**What it does not claim.** It does not read the wave's *work*, only its
bookkeeping: a wave-runner that opened its log correctly and then dispatched
ten coders at a plan nobody approved passes here. `wave audit` and the gates
are what grade that.
