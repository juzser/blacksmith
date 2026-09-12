# Operator guide — Findings and spec defects

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 6. `smith findings list`

```bash
smith findings list --session <session-id> [--task <task-id>] [--epic <epic>] [--status <finding_status>] [--severity <severity>] [--category <finding_category>]
```

Returns the **current state** of every finding raised in that session — a
fold over `finding-raised`/`finding-transitioned` events, not a mutable
store. `smith findings transition <findingId> <newStatus> --session ... 
--plan-version ... --causal-parent ...` moves a finding through its legal
state machine (`raised → confirmed → fix-pending → fix-landed →
fix-verified`, with `waived`/`expired` reachable as terminal branches per
`finding.schema.json`). A finding closes only at `fix-verified` or `waived`
— a review that fired without uptake is not a closed finding
(`severity.yml`).

The **amendment edges are not typeable**, and the command refuses them by name
(D-136). `amend-pending` and `amended` are both gated on evidence a command
line cannot carry: the task ids an amendment owes come off a plan diff, and the
proof they landed comes off the task fold. `smith plan amend` computes the
first, `smith epic close` the second — see §6a. Typing them by hand would be
the unchecked claim D-127 closed, so the table lists them and this verb does
not offer them.

## 6a. Spec findings + `smith plan amend` — when the plan is what is wrong

Every verb above records a finding against a diff, and a finding against a
diff blocks the diff. The envkit epic deadlocked on the case that breaks:
`task-1b-parse-quotes` passed all five checks and was blocked by one correct
S2 whose fix acceptance criterion 3 mandated and criterion 1 forbade. S1/S2
are categorically unwaivable, the plan is immutable, and the factory's only
verdict for "this is wrong" pointed at a coder who had nothing to change
(D-33/D-39).

A spec finding is the other route. It says the plan is wrong, so it blocks the
plan:

```bash
smith findings raise --scope spec --plan factory/specs/active/epic-1/plan-v1.json \
  --evidence spec-findings.json --found-by spec-reviewer \
  --session <session-id> --causal-parent <event-id>
```

`--scope` belongs to the dispatch, not to each item: one review reads one
thing, and a `criterion_ref` in the evidence of an ordinary diff review is
dropped rather than promoted. Under `--scope spec` every evidence item **must**
name a `criterion_ref`, and `--plan` is mandatory — the reviewer knows which
criterion it read, but only the dispatcher knows which plan version it was
reading, and a spec finding stamped with a typed version points at a criterion
that never moved.

The finding is owned by `<epic>/integration`, never by whoever claims the file
it cites. It mints no follow-up task and triggers no reattribution, and
`smith gate run` reports it in `specFindings` without failing the diff. That
is the whole point: no task's diff can contain the fix.

The fix is a new plan version:

```bash
smith plan amend --plan factory/specs/active/epic-1/plan-v1.json \
  --findings f-epic-1-integration-1a2b3c4d,f-epic-1-integration-5e6f7a8b \
  --rationale "criterion-3 mandated multi-line quoted values that criterion-1's ParseIssueCode freeze made unfixable; v2 drops the multi-line clause" \
  --sites src/parse.ts,src/lex.ts \
  [--changes changes.json] [--specs-dir factory/specs/active] \
  --session <session-id> --causal-parent <event-id>
```

This is the **only** legitimate way to change an immutable plan, and it
refuses three times. An amendment that cites no spec finding is rejected: "the
plan changed" with no recorded cause makes the immutability decorative. An
amendment with a blank rationale is rejected: the diff already records what
moved, and only the rationale records why. An amendment that names no `--sites`
is rejected: a finding names where a defect was *noticed*, and the amendment
has to answer where the shape *lives* (D-123). It also refuses to cite a `diff`
finding — that one says the code is wrong, and a new plan version is not how a
diff defect gets fixed.

`--sites` is not checked for completeness — nothing can check that. What it
does is record the author's answer, and split it: any named site that no task
this version adds or supersedes claims comes back on stdout as `sitesUnclaimed`
and is stored in the `plan-version-created` payload. A site with no task behind
it is **not** an error; the fix for a shape in one file legitimately lands in
another. Refusing would put a price on naming a site, and the next author would
pay it by naming fewer — which is the defect this exists to catch, not the
cure. So the closing spec review reads the scope decision off the event instead
of reconstructing it, and asks whether the set was right rather than whether
anybody wrote one down.

Everything validates before anything is written, because nothing in this
codebase deletes a plan file. On success it writes `epic-1/plan-v2.json`,
appends `plan-version-created` naming each finding and the criterion it moved,
and transitions those findings to **`amend-pending`** — carrying the task ids
the new version added or superseded as the obligation each finding now waits
on. `amend-pending` is not the exit; it is the promise. The exit is `amended`,
and only `smith epic close` writes it, after computing which of those task ids
actually landed at that plan version or later. An amendment that obligates
nothing would discharge its finding the moment it was written, which is D-127,
and is why neither edge can be typed at `smith findings transition`.

`--changes` takes the same `{added, supersede, newEdges}` shape `nextVersion`
uses. Omitting it is legal — a criterion can be reworded without moving a
task — but it is also the shape a forgotten `--changes` takes, so an amendment
whose diff moves no task prints a `warning` in the JSON and a line on stderr
rather than silently cutting an identical version.

## 6b. Worker-proposed spec changes — the third exit

§6a assumes a judge found the wrong criterion. Usually the worker finds it
first, and until now that worker had nowhere to put it. A spec-scoped finding
can only be minted by a judge dispatched with `--scope spec` against a plan
version, a coder mid-flight is not one, and a worker cannot emit an event at
all — so a wrong criterion had two outcomes, both bad: a worker quietly
widening it to something it could satisfy, or a coder bounced a defect it had
nothing to fix (D-33).

The worker's exit is a returned field, the same shape `research_request`
takes and for the same reason — a worker that stops mid-flight cannot emit
anything, so the only signal that survives its own failure case is one it
returns. It commits what is green, stops with `run_status: dead`, and puts a
`spec_change_request` in `structured_output`:
`{criterion_ref, assumption, evidence, changes, sites, blocking}`, schema at
`factory/specs/schema/spec-change-request.schema.json`. `sites` is **every**
place that wrong assumption's shape occurs, not only the one it hit — the
worker just read that code and you did not (D-123).

The node that dispatched it records the request. This writes no plan version:

```bash
smith plan propose --plan factory/specs/active/epic-1/plan-v1.json \
  --task epic-1/task-1b-parse-quotes --proposed-by coder \
  --request worker-request.json \
  --session envkit-quotes --causal-parent envkit-quotes#0
```

`--request` is a file rather than a flag soup because `changes` is a nested
object and the worker already returned the whole request as JSON; re-typing it
into flags would be asking the dispatcher to paraphrase the worker. The
command validates the diff the way `plan amend` does — by drafting the next
version and running the plan's own validator over it — so a proposal that
could never be applied is refused before it reaches your queue rather than
after. On success it raises the spec-scoped finding an approval will later
cite, writes `spec-change-proposed`, and prints the proposal back with the
`diff` it computed (`changes` elided below — it is the worker's whole task
spec):

```json
{"proposalId":"envkit-quotes#2","epicId":"epic-1","taskId":"epic-1/task-1b-parse-quotes",
 "baseVersion":1,"proposedBy":"coder","findingId":"f-epic-1/task-1b-parse-quotes-4dde708d",
 "criterionRef":"epic-1/task-1b-parse-quotes:criterion-1",
 "assumption":"a .env value never spans two physical lines",
 "evidence":"src/parse/env.ts:41 reads line by line and never rewinds",
 "sites":["src/parse/env.ts","src/lex/scan.ts"],"changes":{"supersede":{"…":{}}},
 "diff":{"added":[],"removed":[],"superseded":["epic-1/task-1b-parse-quotes"],
         "carried":["epic-1/task-1a-lex"]},
 "blocking":true,"severity":"S2-major","status":"open","decision":null,
 "ts":"2026-08-27T11:42:52.072Z"}
```

The `proposalId` is the id of the `spec-change-proposed` event itself, which is
why it is what `approve` and `reject` take: the thing being answered is the
record of the ask, not a row in a side table that could disagree with the log.
`severity` is the dispatcher's default (`S2-major`) unless the worker had a
view — deliberately above the waivable band, so a proposal cannot be silenced
by an existing waiver (D-196).

What is waiting:

```bash
smith plan proposals --session envkit-quotes [--epic epic-1] [--status open]
```

`--status` is `open`, `approved`, `rejected` or **`stale`**. Stale is the
second question, and the one only this command answers: the proposal was
written against v1, an amendment has since cut v2, and the diff no longer
describes the plan it would be applied to. Staleness is computed against the
plan on disk, not stamped at proposal time, so a proposal that was open this
morning is stale this afternoon without anything having been written to it —
and the refusal is at approval, where it can still stop you:

```json
{"error":{"code":"spec-change.approval-stale","message":"Spec change proposal
envkit-quotes#7 was drafted against \"epic-1\" v1, and the plan has since moved
to v2. Its diff has not been checked against the newer version — re-propose
against v2 rather than applying it blind.","details":{"proposalId":
"envkit-quotes#7","baseVersion":1,"planVersion":1,"latestVersion":2}}}
```

Ask the worker again against the version that now exists. The listing prints
each proposal whole, diff included, because your next move is a yes or a no on
a plan diff and a listing that made you go and read the event by hand would
have answered the wrong question.

Answering is one command each:

```bash
smith plan approve envkit-quotes#2 --plan factory/specs/active/epic-1/plan-v1.json \
  --decided-by operator [--rationale "the parser is right and the criterion is not"] \
  --session envkit-quotes --causal-parent envkit-quotes#2

smith plan reject envkit-quotes#2 --decided-by operator \
  --rationale "criterion-1 is right; the parser is what is wrong" \
  --session envkit-quotes --causal-parent envkit-quotes#2
```

Approval prints what the amendment did, in `plan amend`'s own shape:

```json
{"proposalId":"envkit-quotes#2","epic":"epic-1","version":2,"previousVersion":1,
 "findingIds":["f-epic-1/task-1b-parse-quotes-4dde708d"],
 "sites":["src/parse/env.ts","src/lex/scan.ts"],"sitesUnclaimed":["src/lex/scan.ts"],
 "diff":{"added":[],"removed":[],"superseded":["epic-1/task-1b-parse-quotes"],
         "carried":["epic-1/task-1a-lex"]}}
```

Read `sitesUnclaimed` before you move on. The worker named two places the wrong
assumption's shape occurs and the amended plan only claims one of them, so
`src/lex/scan.ts` has the same bug and no task pointed at it. That is printed at
approval and not only recorded, because you are the one who just agreed the
assumption was wrong and are best placed to say whether the second site is a
deliberate call or a forgotten one.

Rejection prints the proposal, now `"status":"rejected"` and carrying a
`decision` whose `planVersion` is `null` — the shape of "answered, cut
nothing". Approval runs `plan amend` with the worker's own finding, sites and
diff, and no guard is relaxed to do it: the amendment still cites a spec
finding, still carries a rationale, still names sites, and still refuses to
obligate nothing (D-127). The version is cut by `plan amend` alone, so every
version stays immutable and every one of them is in the log — approval is what
*calls* the amendment, not a second way to write one. `--rationale` is optional
here and falls back to the argument the worker recorded, because approving is
agreeing with it; on `reject` it is required, since the log already holds the
case for and a rejection is the only place the case against gets written down.
A rejection refutes the finding and cuts no version.

Both decisions write `spec-change-decided`, which is what closes the proposal.
`smith daemon` reports an unanswered one — `attention` when the worker called
it `blocking` and `info` when it did not (`docs/runbooks/ops.md`). In the log,
an approval is four events in this order: `spec-change-proposed`,
`plan-version-created`, `finding-transitioned`, `spec-change-decided` — the
decision is written last, after the version it authorised exists, so a crash
between them leaves a proposal still open against a plan that already moved,
which is the `stale` case above and not a silent double-apply. A rejection is
`spec-change-proposed`, `spec-change-decided`, `finding-transitioned`, and no
version. The dashboard's **Plan changes** filter selects all of them.
