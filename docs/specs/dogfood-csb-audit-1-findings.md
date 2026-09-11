# Dogfood findings — epic `csb-audit-1`

What the factory did when pointed at a project that is not this repo: a
Swift/macOS menu-bar app (`claude-status-bar-macos`), audited and patched
through epic `csb-audit-1` in session `csb-audit-1-2026-09-07`. The epic
shipped two tasks — task-1 merged at `d99b38c`, and task-2d (the fourth cut
of task-2, after 2b and 2c were superseded) merged at `da0b862` and graded
12/12 — and closed at event `#354` with `--override-rationale` over 24
non-terminal task rows. That override is the headline: the epic could not
close mechanically, and a good part of what follows is why.

Every item was observed in that session, not inferred. This is the **raw
evidence log**, numbered FD-1..FD-36 in the order the defects were hit and
kept in the words they were written in at the time. Two numbers are
deliberately empty: FD-29 was investigated and withdrawn, FD-31 restated FD-7
and is folded into it. Both keep their slot so the session's own references
to them stay resolvable.

The distillation an implementer should work from is a roadmap entry, not this
file. This file holds the repro.

Status legend: **confirmed** = reproduced with a command in-session ·
**observed** = seen once, no isolated repro · **open** = stated but unverified.

---

## FD-1 — a grader registered through `judge dispatch` cannot discharge — confirmed

`judge dispatch --role grader` records a judge turn, and `foldJudgeTurns`
mints an obligation the gate checks first: `outstandingJudges`
(`gate.ts:1144`) blocks before `graderVerdict` (`gate.ts:1181`) is even
read. But a grader returns a verdict document, not `FindingEvidence[]`, so
`judge report --role grader` refuses the file it wrote
(`judges.artifact-not-a-list`) and the obligation stays open. The task is
blocked `judges-outstanding` by a judge that finished.

Amended 2026-09-08: `judge report --role grader --artifact <FindingEvidence[]>`
does discharge, because `--artifact` overrides `turn.declaredArtifact`
(`judges.ts:425`). Round 1 used that: the grader's findings were re-shaped
into `grader-r2.evidence.json` and reported (`finding_count: 6` at `#151`).
It works, and it is a workaround that makes the grader look like a reviewer
on the record.

**Fix:** one of three, not all: `judge report` accepts a grader-verdict shape
for `--role grader`; `checkGraderVerdict` discharges the obligation itself;
or `judge dispatch` refuses `--role grader` by name and the grader is never
an obligation.

The lesson underneath: a schema landing does not update the reader that was
waiting for it.

---

## FD-2 — `claims check` misses a committed rename's source — confirmed

`collectCommittedChanges` (`claims.ts:737-746`) and the `--since` branch
(`claims.ts:806-820`) run `git diff --name-only` without `--no-renames`, so a
rename reports only its destination. The porcelain branch (`claims.ts:793-803`)
already pushes both sides of an `R`/`C` entry. `claims.test.ts:461` tests the
collector that has the handling, not the two that do not.

**Fix:** `--no-renames` on both `git diff` invocations, and a test that
renames a claimed file out of the claim.

---

## FD-3 — `claims check` reads clean on a task writing under `state/` — observed

`state/` is gitignored, so a task whose only writes land there exits 0 with
an empty `inClaim`. Nothing distinguishes "wrote only inside its claims" from
"wrote nothing git can see".

**Fix:** report ignored paths that changed, or at least count them.

---

## FD-4 — the `token_usage` split is unmeasurable — confirmed

`cli.ts:2527-2528` `requireIntFlag(flags, 'input-tokens' / 'output-tokens')`;
`result.schema.json` requires all three of `input_tokens`, `output_tokens`,
`total_tokens` under `additionalProperties: false`. The harness reports one
number per subagent (`subagent_tokens`). The orchestrator transcript
(16,631 lines) carries no sidechain; the agent-runner transcript (139 MB)
aggregates session-wide. There is no place the split exists to be read.
P9-17 moved the invention from the agent to the orchestrator; waves 2 and 3
had invented zeros and round numbers (D-18), and the orchestrator now invents
the same way with a straighter face (lesson `lesson-raised-c599f971488d`).

Workaround used: the measured **total** as `--input-tokens`, `0` as
`--output-tokens`, and the provenance in the `task-result-recorded` payload
(`token_total_measured`, `token_split_measurable: false`,
`token_provenance`) — events `#149`/`#150`.

**Fix:** `{ total_tokens }` alone is a legal `token_usage`. See FD-18 for the
schema side.

---

## FD-5 — the artifact-path rule is unstated, and the gate doubles a repo-relative path — confirmed

`.claude/agents/coder.md:134-135` says to write under
`state/artifacts/<task-id>/` and is silent about what `artifacts[].path`
should contain. The gate resolves the path relative to the artifact home, so
only a bare filename works. The round-2 coder wrote a repo-relative path and
the gate doubled it:

```
declared: state/artifacts/csb-audit-1/task-1-…/round2-signing-argv-test-output.txt
resolved: <repo>/state/artifacts/…/state/artifacts/…
```

Blocked `artifacts-missing` for a file that existed. The home is also not
the one the template names — it is `state/artifacts/<epic-id>/<task-suffix>/`.

**Fix:** state the rule at the field, correct the directory in the template,
and have the resolver detect a declared path that already starts with the
home rather than prepending it.

---

## FD-6 — `plan validate` accepts two tasks with one id, and lookups return the dead one — confirmed

plan-v2 carried the v1 task-1 (`superseded`) at index 0 and the v2 rewrite
(`todo`) at index 2 with the same `task_id`. `plan validate` → `{"valid":
true}`. `budgetFromFlags` (`cli.ts:730`) and `caseForDispatch` (`cli.ts:769`)
both use `.find(t => t.task_id === …)` and return the superseded entry.
`taskEvents.ts:251` uses `filter` and `:289` collects superseded ids, so the
event side knows; the dispatch side does not. The comment at `cli.ts:715-718`
says "Ambiguity still throws" — `resolveTaskId` only arbitrates bare-suffix
ambiguity, not this.

**Fix:** `plan validate` rejects two non-superseded tasks sharing an id;
every lookup filters `superseded` out or throws on more than one hit.

---

## FD-7 — the turn budget the prompt states is fiction — confirmed

The dispatch contract says to state the turn budget in the prompt because
the template's `maxTurns` is not read. Observed cap against stated budget:

| role | told | ran to |
|---|---|---|
| spec-reviewer ×12 | none | 15 |
| coder r1, r2 | 40 | 40 |
| tester | 30 | 30 |
| grader r1, r2 | none | 15 |
| planner v3 attempt 1 | 40 | **20** |
| reviewer | 20 | 20 |
| security-reviewer | 20 | **15** |
| verifier (`claude-opus-5`) | 20 | **15** |

The security-reviewer was cut at 15 with 16 tool uses, 49,723 tokens, 215 s,
and zero output. The planner was cut at 20 after reading a 505 KB plan file
(24 tool uses, 48,913 tokens, 227 s, zero output); re-dispatched with "the
cap is 20, write first" it finished in 5 tool uses. The verifier was cut at
15 after 24 tool uses, 50,962 tokens, 468 s, and had written an interim file
because it was told to write first. `coder.md` still ships `maxTurns: 40`
while `budgets.yml` says `max_turns` is no longer a budget field.

The write-first mandate held eight times running; the number never did. The
number is wrong in both directions — see FD-14 for the correction about
where the real cap comes from — so the fix is to stop stating it.

**Fix:** strike `maxTurns` from the templates or make it the number the
prompt carries (FD-14); the contract says "there is a cap, it may be as low
as 15, write your artifact before you finish exploring" and stops promising a
figure. Lesson `lesson-raised-b8db8efe922d`.

FD-31 restated this — "a declared budget is a fiction in both directions" —
and is folded here.

---

## FD-8 — `gate run --checks` is required and nothing declares the checks — confirmed

`gate run --checks <checks.json>` is mandatory; no `checks*.json` exists
anywhere in the repo, the plan's task keys (`task_id, epic_id, plan_version,
objective, output_schema_ref, acceptance_criteria, claims, budget, contract,
case, origin, task_status, agent_role, project`) do not carry one, and the
suite was invented per run. For this epic it was derived from the target's
`.github/workflows/ci.yml` (`swift build`, `swift test`,
`./scripts/hook-integration-test.sh`, `make signing-test`; the hook script
uses `mktemp -d` under a trap).

**Fix:** the plan declares the check suite per task, or the gate derives it
from the target's CI by a stated rule and records which.

---

## FD-9 — a near-miss key in `dispatch_decision` mints nothing, and a correct one is undischargeable — confirmed

`judges.ts:46` `JUDGE_DISPATCH_EVENT_TYPE` is `'dispatch_decision'`;
`foldJudgeTurns` (`judges.ts:183-241`) mints a judge turn from any such event
that carries `agent_role`, `declared_artifact` and `round`. Event `#168`
(grader round 3) spelled `declared_artifact` and became an obligation the
grader could not discharge (FD-1). Event `#170` (grader round 4) spelled
`artifact_declared` and minted nothing — no warning. The gate then blocked
`judges-outstanding` on a superseded round. Discharged by a correcting
`dispatch_decision` `#179` plus `judge report --no-findings` `#180`
(`attested_by: "operator"`), which is an attestation verb stretched over a
grader that did in fact run (round 4 verdict `overall: pass`, 12/12; its
findings raised at `#152`-`#157`).

**Fix:** refuse near-miss spellings of the minting keys at `event append`;
give the grader a discharge path of its own (FD-1).

---

## FD-10 — the escalation ladder counts every blocked gate as a failed round — confirmed

`escalation check` counts `gate-outcome blocked` regardless of which stage
blocked. Only 3 of the 10 gate stages assess the builder; task-1 collected
`#161 artifacts-missing` (FD-5) and `#178 judges-outstanding` (FD-9) — the
same commit `6978e9d2ebbf5b0f95cd10979b042b6971a5ca69` gated three times
(`commit-check-result` `#175`/`#183`, `commits_ahead: 2`) — and the check
reported rung 2 `unverifiable`, whose action is `sonnet -> opus`. Recorded as
`#190` `judgment.false-positive-finding`.

**Fix:** count only builder-assessing stages, or carry each block's `reason`
on the ladder so the operator can see it was the orchestrator's own mistake.

---

## FD-11 — `judge-verdict.schema.json` cannot carry a `finding_id` — confirmed

`required: ["verdict", "rationale"]`, `additionalProperties: false`. The
verifier is told to write `[{finding_id, verdict, rationale}]` and `judge
report` does not validate against the schema, so the mismatch is silent
until something reads it. Lesson `lesson-raised-576ea7016b55`.

**Fix:** a `verifier-verdicts.schema.json`, or `finding_id` optional in the
existing one.

---

## FD-12 — no verb records the operator's answer to a quorum escalation — confirmed

`judge escalations` folds `quorum-decision` (`quorumEscalations.ts:157`);
the producers are `gate.ts`, `epic.ts`, `planQuorum.ts`. No CLI verb appends
one carrying an operator answer. Two escalations were held for the epic's
whole life: `plan:csb-audit-1/plan-v1` (2026-09-08 — codex and deepseek
refuting `anchor exists`; the operator ruled to keep it) and
`finding:<fingerprint of 5071e0f4>` (2026-09-09). `judge escalations`
returns rc=2 forever; `crosscheck.yml` `quorum_rule.min_providers: 2` and a
third `escalation_reason: insufficient-providers` at `#209`.

**Fix:** `smith judge decide <key> --verdict <confirm|refute> --rationale
<text> --actor operator`, appending a `quorum-decision` with `decided_by:
operator`.

---

## FD-13 — `budget alarm` is `unverifiable` for three roles — confirmed

`budget alarm csb-audit-1-2026-09-07 --epic csb-audit-1` exits 1 with
`rolesWithoutCap: ["planner", "security-reviewer", "tester"]` and
`unattributedDispatches: 1`, `unattributedRoles: ["planner"]` (a
`dispatch_decision` with no epic). The measured half was fine:
`{"measuredTokens": 135372, "projectedTokens": 2305372, "capTokens":
4000000, "alarmTokens": 2800000, "taskCount": 24, "measuredTaskCount": 1}`.
Also: the session id is positional, and exit 1 is shared between
`unverifiable` and `at-risk`.

**Fix:** caps for the three roles in `budgets.yml`; refuse an epic-less
`dispatch_decision` at append time.

---

## FD-14 — the coder ran 40 turns against a stated 20 — confirmed, then corrected

Task-2 coder round 1 was told 20 and ran 40 turns, 43 tool uses, 67,324
tokens, 562 changed lines, zero commits. Two defects: the number in the
prompt is unreadable by the runtime, and understating it is not a safe
default — the coder spent the budget it did not know it had.

**Correction (same session):** the template's `maxTurns` **is** enforced by
the runtime for `Agent`-tool subagents. A grader stopped at exactly 15 tool
uses while its prompt said 40 (~84k tokens, no artifact; recovered by
resuming the same agent write-first). So the number to carry into the prompt
is the template's, and the agent cannot see how many it has left. The
contract's "Claude Code does not read `maxTurns`" (agent-interviews.md M-4)
is wrong for this dispatch path.

**Fix:** carry the template's `maxTurns` verbatim; add a commit-first
mandate for worktree roles; record the observed turn count on
`task-result-recorded`.

*Landed 2026-09-11* — after the planner was cut at 20 against a stated 40 a
second time, in the successor session `csb-signing-policy-1-2026-09-11`,
with nothing written: the dispatch contract, `budgets.yml`,
`agent-constraints.md`, `extending.md` and M-4 now say the template is the
ceiling and the prompt restates it; `scripts/check.sh` requires `maxTurns`
as a positive integer; `planner.md` went from 20 to 40. The turn count on
`task-result-recorded` stays a convention, not a schema field.

---

## FD-15 — the amendment machinery cannot express "the criterion is misworded and already satisfied" — observed

`proposeSpecChange` requires a non-empty obligation. A criterion whose
wording is wrong but whose intent the diff already meets has nothing to
oblige, so the only honest proposal is one that says "change the words, no
work follows", and the verb refuses that.

**Fix:** allow an amendment with an empty obligation when the proposal
carries evidence the criterion is met as intended.

---

## FD-16 — a plan pins a criterion to a path the task's claims do not cover — confirmed

Fired three times. First on the original criterion; then on `Package.swift`
(`swift build` emits "found 16 file(s) which are unhandled" for the
static-assertions fixtures, and silencing it needs an `.exclude`/`.copy`
entry in a file the task does not claim); then criterion 9 was raised as an
S2 spec finding for the same shape. `plan approve` reports `sitesUnclaimed`
and does not block on it.

**Fix:** `plan validate` fails a criterion naming a path outside the task's
claims, or `plan approve` blocks on `sitesUnclaimed`.

---

## FD-17 — `plan propose` mints its own finding, so the one raised for it becomes an orphan — confirmed

`plan propose` minted `f-csb-audit-1/task-2b-...-f6d4a6fe` at event `#262`;
the finding raised separately for the same defect,
`f-csb-audit-1/integration-61068462` (`#261`), was a redundant orphan from
that moment. Nothing says the verb mints. (`plan validate` also takes the
plan as a positional while its siblings take `--plan`.)

**Fix:** document that `plan propose` mints, and refuse a `--finding` that
names an already-raised finding for the same site.

---

## FD-18 — `result.schema.json` requires the split the meter cannot give — confirmed

The schema side of FD-4: `token_usage` requires `[input_tokens,
output_tokens, total_tokens]`; `stampResultEnvelope` (`results.ts:59`)
derives the total. Disclosed on task-2d as `--input-tokens 106794
--output-tokens 0` with `token_usage_split_note` at
`csb-audit-1-2026-09-07#281`.

**Fix:** allow total-only. One change, both findings.

---

## FD-19 — `security triggers` cannot see Swift — confirmed

On task-2d the trigger fired once, for the overlap of claim
`Tests/StatusBarCoreTests/Fixtures/static-assertions/**` with `**/auth/**`,
while `Sources/StatusBarCore/Accounts/LiveCredentialWriter.swift`,
`AccountCredentialVault.swift` and `TrustedApplicationGate.swift` — the files
that write Keychain ACLs — fired nothing. `sensitive-paths.yml` has no
`.swift` extension and no `Sources/**/Accounts/**` glob. `effort show`
detects security relevance from nonfunctional-clause keywords, so the two
instruments disagreed on the same task.

**Fix:** add `**/Accounts/**`, `**/*Credential*`, `**/*Keychain*`; say in
the trigger output that matching is overlap; make the two detectors read the
same source.

---

## FD-20 — the event log has two line shapes — observed

Some lines are `{"event_id", "record": {…}}` and some are the bare record.
Every reader in the session ended up as `r.get('record', r)`.

**Fix:** one shape, or a read verb that normalises.

---

## FD-21 — the `agent` enum has no `operator` — confirmed

`gate run --found-by` and `findings raise --found-by` validate against the
`agent` enum, which has 13 roles and no `operator`. A defect the operator
found by reading — `TrustedApplicationGate.swift:70`'s doc comment says an
empty input preserves the system-default ACL, and `SecAccess.h:125-128` says
NULL is the default while an empty CFArray is *no* applications — has no
truthful `--found-by` and stayed unraised for the epic's life.

**Fix:** add `operator`; `dispatch check` skips it (an operator is not a
dispatch).

---

## FD-22 — six read-only templates declare a result path the epic never used — observed

reviewer, verifier, grader, spec-reviewer, security-reviewer and uiux
declare `state/results/<task-id>.<role>.json`; the epic used
`state/artifacts/<task-id>/<task-id>-<role>-r<n>.json` because rounds
overwrite. `readJudgeArtifact` (`judges.ts:355`) reads the declared path
verbatim and `artifactHome` (`artifacts.ts:64`) governs only result
`artifacts[]`, so nothing broke — but the templates promise a layout the
factory does not enforce.

**Fix:** either enforce the template path with a round suffix, or drop it
from the templates and let `judge dispatch --artifact` be the only truth.

---

## FD-23 — there is no "deferred to a successor epic" state for a diff-scope finding — confirmed

`amend-pending` exists for exactly this shape but is gated to `scope: spec`.
A diff-scope S2 the operator consciously defers can be neither waived
(`findings.not-waivable`) nor amended (`findings.not-amendable`), so it must
be `expired`, which reads on the record as *abandoned* rather than *assigned
to epic X*, and `findings transition` takes no `--note` to say which.

The instance: `f-csb-audit-1/task-2d-…-ff08443c` (security-reviewer,
CONFIRMED, not retracted). `TrustedApplicationGate.defaultVerify` at
`Sources/StatusBarCore/Accounts/TrustedApplicationGate.swift:49-61` evaluates
`certificate leaf[subject.CN] exists`, which `csreq -r … -t` round-trips to
bare field-presence — any self-signed identity satisfies it. The operator's
decision was to land and tighten in a successor epic (`csb-signing-policy-1`:
`anchor apple generic and identifier "com.anthropic.claude-code"` for
`claude`, a pinned leaf-cert hash for the app); the risk is accepted because
the gate still refuses ad-hoc and unsigned callers. All of that meaning lives
in a `task-result-recorded` disclosure on `csb-audit-1/integration`, because
the state machine cannot carry it.

**Fix:** a `deferred` terminal state carrying `successor_epic`, reachable
from `confirmed` for any scope; `--note` on `findings transition`.

---

## FD-24 — the plan file is never rewritten as tasks land — confirmed

Two tasks in plan-v6 read `task_status: todo` while both were merged onto
integration (task-1 at `#252`, task-2d at `#309`). The event log is the
truth and the plan is a stale declaration; nothing reconciles them, and
`epic close` has to. Together with FD-25 the plan and the fold disagree in
both directions.

**Fix:** treat the plan as a declaration and never read `task_status` from
it after ingest; or write it back on `wave-merged`.

---

## FD-25 — `superseded` written into the plan never reaches the event log — confirmed

The reverse of FD-24. `plan amend` marks task-2/2b/2c `superseded` in the
plan file; no event carries that, so the gate and the projector see three
live rows the plan says are dead. "The plan is a declaration; the fold is
the state" — and the fold was never told.

**Fix:** `plan ingest` emits a `task-superseded` event per row it retires.

---

## FD-26 — `superseded` is terminal but not terminal-OK, so a superseding epic can never close mechanically — confirmed

`superseded` is terminal in the projector (`db/projector.ts:284`) but is not
a member of `TERMINAL_OK_TASK_STATUSES` (= `completed`, `waived`). Rows
task-2, task-2b, task-2c (the chain task-2 → 2b → 2c → 2d) block `epic close`
even though task-2d is graded 12/12 and merged. The epic closed at `#354`
with `--override-rationale`.

**Fix:** `superseded` joins `TERMINAL_OK_TASK_STATUSES` when a successor row
is itself terminal-OK.

---

## FD-27 — planner and spec-reviewer dispatches create permanent `in-progress` rows — confirmed

Dispatching a planner or spec-reviewer against a synthetic task ref folds a
row to `in-progress` via `dispatch_decision`, and no planner or
spec-reviewer dispatch ever produces a `wave-merged` or `gate-outcome` that
could move it on. Twenty-one of the epic's 24 non-terminal rows were these:
`csb-audit-1/plan-draft`, `/spec-review`, `/plan`, `/plan-r12`,
`/plan-r13-reviewer-a`, `/plan-r13-reviewer-b`, `/plan-r14`,
`/spec-review-r15`, `/plan-r16`, `/spec-review-r17`, `/spec-review-r17b`,
`/plan-r18`, `/spec-review-r19`, `/plan-r20`, `/spec-review-r21`,
`/plan-r22`, `/spec-review-r23`, `/plan-r24`, `/spec-review-r25`,
`/plan-r26`, `/spec-review-r27`. Mitigation found late: dispatch judges
against the reserved `<epic>/integration` ref, which creates no row.

**Fix:** a `dispatch_decision` for a role with no claims creates no task
row; or the playbook says to use the integration ref and the projector
refuses a synthetic ref by name.

---

## FD-28 — one field, three names — observed

The `dispatch_decision` payload key is `agent_role`, `taxonomy.yml` names the
enum `agent`, and the gate flag is `--agent`. That is exactly how a log query
silently returns zero rows.

**Fix:** one name, and a migration note for the log.

---

## FD-29 — withdrawn

Filed as "`epic verdict`'s `summary.openFindings[]` does not expose
`finding_id`/`finding_status`". It does; the probe read the wrong key. Kept
so `#`-references in the session log resolve.

---

## FD-30 — `plan amend` cuts a version without ingesting it, and a task whose amendment left no dead record stays frozen — confirmed

`f-…-task-1-…-fe117d83` sat `amend-pending` for the epic's life. Task-1 had
merged at `d99b38c51b6a4b98d7737713936c6569d5423468`, but its row was frozen
at `planVersion 1`: `row.planVersion` is written only by `task-added`, and
`emitTasksAdded`'s `amended` guard skips a task the amendment did not
re-add. `epic.ts:552-604` discharges `amend-pending` only when
`row.planVersion >= amendment version`, so the finding could never
discharge. The one `plan ingest` run reported "added 4, superseded 3,
skipped 1" — the skipped one was task-1. `37275cbb` (plan-v4 vs superseded
task-2) and `f6d4a6fe` (plan-v5 vs superseded task-2b) had the same shape
through FD-26. All four expired with disclosures on
`csb-audit-1/integration`.

The first filing of this ("`satisfiedAmendments` stayed `[]` with task-2d
`completed` at pv6") was the symptom; the row-version freeze is the cause.

**Fix:** `plan amend` ingests, or refuses to cut a version it will not
ingest; `emitTasksAdded` bumps `planVersion` on every live row the
amendment carries forward; a repair verb for a frozen row.

---

## FD-31 — folded into FD-7

"The dispatch contract tells the orchestrator to state the turn budget in
the prompt because the template's `maxTurns` is not read — but the harness's
own cap is lower than what the prompt can promise, so a declared budget is a
fiction in both directions." Same defect as FD-7, with FD-14's correction.

---

## FD-32 — `waivers pending` lists findings that are already closed — confirmed

`smith waivers pending <epic>` listed `fix-verified` and `refuted` findings
alongside the genuinely pending `raised` ones — 5 of its 8 rows for
`csb-audit-1` needed no decision at all.

**Fix:** filter to states a waiver can act on.

---

## FD-33 — `event append` prints a warning to stdout before its JSON receipt — confirmed

The warning is right (`task_id` belongs at the top level, not in the
payload) and it is emitted on the same stream as the machine-readable
receipt, so `smith event append … > receipt.json` is not JSON.

**Fix:** warnings to stderr.

---

## FD-34 — an error's remedy names a flag the verb does not have — confirmed

`waivers.stale-evidence`'s remedy text says `smith findings reverify
--finding <id>`; the CLI takes the id as a positional. Following the error
message verbatim fails.

**Fix:** the message, and a test that every remedy string in the error
catalogue parses against the CLI it names.

---

## FD-35 — `epic verdict`'s error response replaces the document — observed

On a flag error the whole verdict document is replaced by `{ error }`, so a
caller probing summary fields sees nothing everywhere rather than a flagged
error. Minor; the `usage` string inside the error is good.

**Fix:** error beside the document, or exit non-zero with the document
absent and the error alone — but not a document-shaped nothing.

---

## FD-36 — the command guard matches call text, not call semantics — observed (harness and hook)

The PreToolUse guard and the auto-mode classifier match the *text* of a
call, so a `--note` that quotes a dangerous command is refused exactly as if
it invoked one, and `git worktree remove --force` on a scratch worktree is
refused as a force-push. Audit notes routinely quote the code they describe.
The repo's own `.claude/settings.json` deny list has the same property.

**Fix:** none in this repo for the harness half; for the hook, match on the
argv position of the pattern rather than anywhere in the string.

---

## Loose gaps, not numbered

Each was hit once and is stated once. Most are a single line of code.

- `findings for-dispatch` returns `cli.missing-flag` with exit 0.
- `findings raise --scope spec` errors with rc=0; `findings list --scope <x>`
  for an unknown scope silently returns zero rows.
- `findings transition` returns no event id and takes no `--note`.
- `effort show` has no `--task`.
- `event append` accepts a `dispatch_decision` whose `task_id` is
  unprefixed (log line 272).
- The gate's budget check never blocks (`gate.ts:1375`).
- The "pristine state" criterion has to be captured at task start; nothing
  does.
- `budget alarm` takes the session id positionally and exits 1 on
  `at-risk` as well as on `unverifiable`.
- The `agent` enum has no `auditor` (the `/bs audit` role) — and no
  `operator` (FD-21).
- `finding_category` has no `architecture`, and all nine are code-shaped, so
  a process lesson can never escalate (`severity.ts` `canEscalate`).
- `finding.schema.json` requires `task_id`; an epic-level finding has none.
- `taxonomy.yml` carries no `event_type` vocabulary, so a misspelled event
  type is a new event type.
- `taxonomy.yml`'s `execution` group has no turn-cap class (FD-7).
- `task-result-recorded` payloads are not `model_tier`-validated.
- `worktree.ts` has no detached-worktree helper; every judge worktree was
  made by hand.
- vitest `globalSetup` runs a full-project `tsc`, so one type error anywhere
  reads as `No test files found`.
- `factory/specs/roadmap.md` is a merge-conflict magnet with no `smith
  roadmap` merge helper, and there is no `smith roadmap check`.
- `judge report` cannot distinguish a `[]` placeholder from a `[]` clean
  verdict.
- `lessons for-dispatch --plan` with a plan that has no matching task
  silently returns no `text` key.
- The coder template's 80% coverage floor has no instrument.
- `judge dispatch` defaults `model_tier` to `frontier`.
- `plan approve` reports `sitesUnclaimed` without blocking (FD-16).
- There is no `task` namespace: `smith task list` prints the global usage.
- `lessons compile` is a projection of local, gitignored state: it reads
  `state/smith.db`, which holds only the sessions whose event logs are still
  under `state/events/`. After a prune it silently dropped 24 committed
  approved entries (79 lines added, 81 removed against the committed file).
  The committed `factory/policies/lessons.md` is the record; the compiler
  treats it as output. Worked around by a union of old and new through the
  real `compileLessons`.

---

## The gap the playbook already records

`docs/specs/audit-command-scope.md:140-166` states it: nothing dispatches a
judge on another vendor's model, so `crosscheck.yml`'s
`quorum_rule.min_providers: 2` is met only when the orchestrator hand-runs
codex or deepseek. This epic did (plan-v1's `anchor exists` refutation came
from both), by hand, and FD-12 is what happened to the answer.

---

## Left in the target

Two residuals in `claude-status-bar-macos`, both blocked by FD-21 (no
truthful `--found-by` for an operator), both disclosed on
`csb-audit-1/integration`:

- `TrustedApplicationGate.swift:70`'s doc comment — *"An empty input returns
  `[]`, preserving today's system-default-ACL behaviour"* — is false against
  `SecAccess.h:125-128` (NULL = default; empty CFArray = no applications).
  Diff-introduced; no judge found it.
- `Package.swift`: `swift build` emits "found 16 file(s) which are
  unhandled" for the static-assertions fixtures (FD-16, second instance).
  Benign; silencing needs a `.exclude`/`.copy` entry in an unclaimed file.
