# Operator guide — Severity, waivers and budget

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 8. Severity + waiver semantics, from the operator's chair

| Severity | Blocks merge | What you see |
|---|---|---|
| **S1** stop-the-line | yes, no bounded retry | Synchronous notification — repo corruption, secret leak, guardrail breach. Stop and look now. |
| **S2** major | yes | Bounces to coder automatically; after 2 failed rounds the coder escalates model tier (mid → frontier, logged); after 3, escalates to you |
| **S3** minor | no | Batched into **one** waiver question per epic — "ignore these?" |
| **S4** nit | no | Logged only, never surfaces to you |

Waiver batching:

```bash
bs waivers pending epic-1 --session <session-id>
```

Returns every S3/S4 finding for the epic that has **no** waiver decision
yet — a finding already granted or denied never resurfaces. Answer with:

```bash
bs waivers apply decisions.json --session <session-id> --plan-version 1 --causal-parent <event-id> --actor operator
```

`--actor` is not decoration. The dashboard server's decisions filter on the
timeline (`/api/timeline?decisionsOnly=true`; the Activity page shows no such
toggle) keeps a `waiver-granted`, `waiver-denied`, `lesson-status-changed` or
`operator-note` event only when its actor is a person, so that the factory's
own traffic under those same types stays out; `planSignOffCheckpoint` asks the
same of `plan-version-created` before a plan sign-off becomes a lesson
checkpoint. Three spellings count as a
person — `operator`, `user` (the default when a decision verb is given no
`--actor`) and
`operator-skill` (what the operator console passes). Anything else — `system`,
or an agent role such as `planner` or `scribe` — records the decision durably
but keeps it out of that filter. The list lives in
`factory/orchestrator/src/actors.ts` (D-164); add a spelling there, with its
reason, rather than in a caller.

`decisions.json` is `Array<{ fingerprint, decision: "granted" | "denied",
operatorNote }>`. A `granted` decision transitions every open finding
sharing that fingerprint to `waived` and suppresses future re-raises of the
exact same fingerprint (`finding-suppressed` event, not a duplicate
`finding-raised`). Only S3/S4 findings are ever waivable — attempting to
waive an S1/S2 finding is rejected (`findings.not-waivable`); it must be
fixed or go through the escalation ladder instead.

**Waived tasks.** A task can also be waived as a whole — its plan row carries
status `waived` — and a waived task has no gate run to show for it. The epic
close therefore holds it as a blocker, "waived without operator approval",
until you record the approval:

```bash
bs waivers approve-task epic-1/task-3 --note "superseded by task-5" --session <session-id> --plan-version 1 --causal-parent <event-id> --actor operator
```

The note is required, and the command refuses any actor other than the
operator spellings above. An approval event appended under another actor is
ignored by the gate. An approval is tied to the plan version it was given
under (`--plan-version`); if a later plan version waives the task again, record
a new approval. A waived task with an approval no longer blocks the close
and is listed under the epic's waived tasks.

**Same-mistake escalation.** A finding matching an approved lesson (same
claim path + `finding_category`) is auto-escalated one severity level and
tagged `judgment.same-mistake` — including over-engineering S3 → S2 once a
matching lesson is approved (`severity.yml`). This is the factory's key
quality KPI: same-mistake rate should trend to zero.

## 9. Budget alarms + the escalation ladder

- **Per-epic cap, sized per effort tier: 4,000,000 small / 16,000,000
  medium / 32,000,000 huge** (planner + all workers + judges). The tier is
  the one the epic runs at: the plan's `effort` (else `effort.yml`'s
  `default_tier`, medium), raised to `security_floor` when a live task trips
  a security trigger. `bs wave check` prints that tier beside the cap
  (`budget.tier`), and every `wave-admitted` event records it in its
  `budget` block, so the log alone says which tier a cap number was sized
  for (unless a bare env override pinned every tier to one cap); an
  admission logged before 2026-10-07 has no `tier`. The cap
  was raised from 2,000,000 to 4,000,000 on 2026-08-11 after the
  `envkit-mcp-surface` dogfood measured 1,529,963 tokens for its two
  *smallest* tasks, and sized per tier on 2026-09-29 after eight medium-tier
  dogfood epics (2026-09-14..29) peaked near 7.3M. Both were operator
  decisions, recorded beside the number in `budgets.yml`. Alarm at 70%
  (11.2M at medium): the planner must re-plan
  remaining work to fit, or ask you. Epics that can't fit are split into
  multiple epics at spec time — the cap is never silently extended. Checked
  by `bs budget alarm` (§9a); until 2026-08-10 nothing checked it at all.
- **Per-task caps (coder), medium tier: 220,000 tokens, ≤700 changed diff
  lines** (excluding lockfiles/generated files); half at small, double at
  huge. Every other priced role (tester, planner, researcher, the four judges,
  security-reviewer, auditor, uiux, wave-runner, merger, scribe) has its own
  per-tier token cap in `budgets.yml`. Hitting either is not a failure —
  the coder stops, reports what's done, and the task returns to the planner
  for re-scoping (`budget-exceeded`, no retry at the same scope).
- **Concurrency: uncapped by default.** Fan-out is limited by the path-claim
  graph, not by a worker count: disjoint claims run in parallel, overlapping
  claims get a dependency edge and run serially. Hundreds of concurrent workers
  is a supported shape — what bounds cost is the per-epic token cap, not
  headcount. Set `epic.max_in_flight_tasks` if you want a wall-clock or
  rate-limit ceiling of your own (a provider's concurrent-request limit, your
  laptop's CPU count); it is `null` — off — unless you set it.
- **Escalation ladder** (never skipped, never looped past its bound):
  1. Bounded retry on the same contract.
  2. 2 failed rounds → escalate model tier automatically (mid → frontier),
     logged.
  3. 3 failed rounds → escalate to you.

  Asserted against the log by `bs escalation check` (§2c) — the rungs
  carry a machine-readable `failed_rounds`/`enforce` half beside this prose.

(`factory/policies/budgets.yml`)

**Per-box overrides.** Each number above can be replaced on one machine without
editing `budgets.yml`: `BS_EPIC_CAP_TOKENS`, `BS_EPIC_ALARM_RATIO`,
`BS_EPIC_MAX_IN_FLIGHT_TASKS`, `BS_TASK_CODER_CAP_TOKENS`,
`BS_TASK_CODER_CAP_DIFF_LINES` and one `BS_TASK_<ROLE>_CAP_TOKENS` per
priced role, set in `.env` or exported (an exported value beats `.env`). Each
name also comes with `_SMALL`, `_MEDIUM` and `_HUGE` variants. Highest first:
the tier's suffixed name, then the bare name (which pins every tier), then
`budgets.yml`'s number for the tier. `.env.example` ships every bare name
empty and every tier variant commented out at its `budgets.yml` default. This is
per box, not per epic: while set, it applies to every epic that box runs. Every
verb reads the policy through one loader, so an override reaches all of them.
Integers must be positive and the ratio must lie in (0, 1]; anything else stops
the verb with `budgets.invalid-env`, naming the variable. `bs budget alarm`
and `bs wave check` add `budgetEnvOverrides` — the names, never the values,
of the knobs whose value differs from `budgets.yml` — so a report never passes
off a box's number as the committed one.

## 9a. `bs budget alarm` — the alarm, counted instead of remembered

`epic.alarm_ratio` sat in `budgets.yml` from Phase 1 with no reader. It parsed
into `BudgetPolicy`, a unit test asserted it, and no production path ever
compared it to anything (D-12's "no" row). Its only real host was a line in the
`/bs` playbook telling you to keep an eye on the number — so the alarm fired
when somebody remembered to look.

```bash
node factory/orchestrator/dist/cli.js budget alarm <session-id> \
  [--epic <id>] [--policy <path>]
```

Exit 0 only when every epic is `under`. Exit 1 otherwise, including when the
log is too incomplete to tell.

### Two numbers, because one of them is a floor

Each epic line carries `measuredTokens` and `projectedTokens`.

`measuredTokens` is what the log recorded, from two traces —
`task-result-recorded.token_usage.total_tokens` and the gate's copy in
`budget-check-result.tokensUsed`, the larger of the two rather than their sum,
since both describe one spend. **It is always a floor, never a total.** A judge
returns findings, not a Result, so a judge's tokens are in no result event and
never will be. Anything that reads `task-result-recorded` alone is reading the
builder's half of the bill and calling it the whole.

`projectedTokens` adds, for every dispatch whose tokens reached no result, the
cap `budgets.yml` declares for that role. `projectedFrom` shows the breakdown
so you can see which roles the projection is made of.

That asymmetry decides the status, and it is worth understanding before you
read one:

| status | meaning |
| --- | --- |
| `under` | The projection — measured spend plus each unmeasured dispatch priced at its role's cap — is below the alarm. The only status that clears. |
| `alarm` | Measured spend alone has reached `alarm_ratio × cap_tokens`. Re-plan the remaining work to fit, or extend the cap yourself. |
| `over-cap` | Measured spend alone has reached the cap. |
| `at-risk` | Measured spend is under the alarm and the projection is not. |
| `unverifiable` | Nothing has crossed, and the record has holes that could be hiding a crossing. |

A crossing is reported even when the record has holes, because unrecorded spend
can only make the bill bigger — a hole cannot un-cross a threshold. A
*non*-crossing gets no such benefit: it is only reported when the projection is
under too, which is why an epic with an unpriceable dispatch comes back
`unverifiable` rather than clean. And the projection is priced, not measured:
each cap is rounded up from a p90 of a dispatch's final-turn total, so a
dispatch can spend past it unseen — a role priced as a judge never records a
result to check it against.

### What makes an epic unverifiable

- **A role `budgets.yml` prices nowhere** (`rolesWithoutCap`). The policy prices
  `coder`, `tester`, `planner`, `researcher`, the four judges,
  `security-reviewer`, `auditor`, `uiux`, `wave-runner`, `merger` and
  `scribe`. (A policy file that still carries the pre-2026-09-29 shared
  `task.judges` bucket is read as the cap for each judge it does not price by
  name.) A dispatch of any other role, or of one a custom policy leaves out, is
  in neither number, so the projection has a hole. Every cap prices a
  dispatch's final-turn total, and a wave-runner's whole run is more than ten
  times its final turn.
- **A dispatch no epic can be charged for** (`unattributedDispatches`). Its
  tokens are in nobody's total, so no epic's "under" is trustworthy.
- **A task measured above the largest cap in the policy** (`tasksOverPrice`).
  The projection charges an unmeasured dispatch its declared cap, and the gate
  records an overrun without blocking on one — so a cap is a target, not a
  bound. Once a task in *this* epic has been measured spending more than the
  most the projection can charge, the epic's own log has falsified the price
  list the projection is built from (D-188). `envkit-mcp-surface/task-2-path-guard`
  recorded one coder round at 1,484,000 tokens against a 150,000 coder cap.

All three are reported rather than assumed free. Fixing the first two means
adding the missing cap or the missing `task_id`; the third is fixed by
recording the spend, not by raising the cap to cover it — a cap raised to fit
what was spent buys back the "ceiling" by giving up the budget.

### `at-risk` is D-9, made visible

On the `envkit-config-loader` dogfood epic, the plan's declared task budgets
summed to 545,000 against a 2,000,000 cap — 27%, comfortably under the 1.4M
alarm — while the run's real projection was over 1,150,000 and its true cost
higher still. `bs plan quorum`'s budget trigger sums *declared* budgets, so
the one automated check meant to catch "this plan is too expensive" measures the
smaller half of the bill. `at-risk` is the status for exactly that shape: the
visible half reads clear while the whole bill does not.

### What it reported on the dogfood log, before security-reviewer was priced

```
epic envkit-config-loader: 0 tokens measured across 0 of 5 task(s) (5 unmeasured),
1,150,000 projected, against a 1,400,000 alarm and a 2,000,000 cap.
status: unverifiable — budgets.yml declares no cap for security-reviewer.
```

**Zero measured** on an epic that really cost over a million tokens. That
session's log holds no `task-result-recorded` and no `budget-check-result` event
at all, so there is nothing to measure and the entire number is projection. An
alarm built on measured spend alone would have printed "0 / 1,400,000 — under"
and exited 0. That is the false clean this command exists to refuse.

A task's `total_tokens` below a small plausibility floor (a placeholder like
`0` or `1`, not a real agent turn) is treated the same way: as unmeasured,
not as near-zero spend.

### Limits, stated plainly

- It reads the log; it does not stop anything. `bs daemon` re-runs the same
  fold on an interval so an alarm reaches you without an open session
  ([`../runbooks/ops.md`](../../runbooks/ops.md)), but it does not dispatch and so
  cannot refuse the next wave either — acting on `alarm` is still your call.
- The projection prices each unmeasured dispatch at its role's *cap*, a p90
  rather than a maximum. So `at-risk` means "could cross", not "will", and
  `under` means "under on these prices", not a guarantee.
- Judge tokens never reach the event log, at any budget, so no number here is
  the real bill. `bs stats effectiveness` (§9b) reads every role's spend,
  judges included, from the Claude Code transcripts after the fact; this
  alarm does not read it.

## 9b. `bs stats effectiveness` — what the factory spent and what it caught

§9a prices what the log cannot see. This reads what was actually spent, from
the place Claude Code writes it down, and sets it beside what the reviewing
roles caught:

```bash
bs stats effectiveness --session <session-id> [--json]
bs stats effectiveness --lineage <session-id> [--json]
```

Name exactly one of the two: `--session` reads that one log, `--lineage` that
session and every session it continues. `--claude-config-dir` points at
another Claude Code config directory (the default is `$CLAUDE_CONFIG_DIR`,
then `~/.claude`). It reads, never writes, and prints three things.

**Tokens per task and per role**, read from the session transcripts and
matched to the dispatches in the log. Spend has one definition, the one the
dashboard's Home uses for Budget used: input, cache creation and output tokens,
cache reads left out, a response repeated under the same message and request
id counted once. Spend no dispatch accounts for, such as the main thread's own
turns, is reported as `unattributed` and never spread over tasks. A total fed
by a missing, unreadable or partial transcript reads "at least <n>": it is a
floor, never a guess. The wave-runner, coder and tester keep a 1h prompt
cache, so a pause of minutes between their own calls re-reads the cache
instead of writing it again; their templates set it, and
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` or the `subagentPromptCacheTtl`
setting overrides it.

**Escaped defects**: a finding or issue that names a task after its
`wave-merged`, on a task whose gate passed. It counts once confirmed or
fix-*, shows as pending while still raised, and is left out when refuted; a
recurring error counts once.

**Finding precision per reviewing role**: confirmed / (confirmed + refuted +
waived), shown with its counts. A role with no decided finding reads NOT
MEASURED, never 0.

```json
{"tokens":{"byTask":{},"byRole":{},"unattributed":{"used":0,"complete":false,"agentIds":[],"sessionIds":["<cli-session-id>"]},"complete":false,"resultsMeasured":0,"resultsUnmeasured":0,"resultEventIds":{"measured":[],"unmeasured":[]}},
 "escapedDefects":{"count":0,"pending":0,"items":[],"excluded":[],"uncounted":[]},
 "precision":{}}
```

That is a session with nothing measured yet: `complete: false` because a
transcript was missing, and every list empty rather than zero-filled.

**Sharing it is a separate, opt-in step.** `bs report export --session <id>`
writes the same numbers, with each task's checks shown as passed, failed, not
run or unknown, as Markdown on stdout or to `--out <file>` (`--json` for the
same content as JSON). It carries a report digest only when you hand it one
with `--digest <file>`, as `/bs report` does with the scribe's digest. Home
and temp paths and user names are replaced, transcript text is never read,
and nothing is sent anywhere. Its first line is "Review this export before you
share it." Read it before it leaves the machine; whether to share it is yours
to decide. `/bs report` offers it as its last step, only when you ask for a
file.
