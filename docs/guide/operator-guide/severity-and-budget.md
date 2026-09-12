# Operator guide — Severity, waivers and budget

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 8. Severity + waiver semantics, from the operator's chair

| Severity | Blocks merge | What you see |
|---|---|---|
| **S1** stop-the-line | yes, no bounded retry | Synchronous notification — repo corruption, secret leak, guardrail breach. Stop and look now. |
| **S2** major | yes | Bounces to coder automatically; after 2 failed rounds the coder escalates model tier (sonnet → opus, logged); after 3, escalates to you |
| **S3** minor | no | Batched into **one** waiver question per epic — "ignore these?" |
| **S4** nit | no | Logged only, never surfaces to you |

Waiver batching:

```bash
smith waivers pending epic-1 --session <session-id>
```

Returns every S3/S4 finding for the epic that has **no** waiver decision
yet — a finding already granted or denied never resurfaces. Answer with:

```bash
smith waivers apply decisions.json --session <session-id> --plan-version 1 --causal-parent <event-id> --actor operator
```

`--actor` is not decoration. The Timeline page's **Decisions** toggle shows a
`waiver-granted`, `waiver-denied`, `lesson-status-changed` or `operator-note`
event only when its actor is a person, so that the factory's own traffic under
those same types stays out; `planSignOffCheckpoint` asks the same of `plan-version-created`
before a plan sign-off becomes a lesson checkpoint. Three spellings count as a
person — `operator`, `user` (what the UI writes when no actor is passed) and
`operator-skill` (what the operator console passes). Anything else — `system`,
or an agent role such as `planner` or `scribe` — records the decision durably
but keeps it off the lens. The list lives in
`factory/orchestrator/src/actors.ts` (D-164); add a spelling there, with its
reason, rather than in a caller.

`decisions.json` is `Array<{ fingerprint, decision: "granted" | "denied",
operatorNote }>`. A `granted` decision transitions every open finding
sharing that fingerprint to `waived` and suppresses future re-raises of the
exact same fingerprint (`finding-suppressed` event, not a duplicate
`finding-raised`). Only S3/S4 findings are ever waivable — attempting to
waive an S1/S2 finding is rejected (`findings.not-waivable`); it must be
fixed or go through the escalation ladder instead.

**Same-mistake escalation.** A finding matching an approved lesson (same
claim path + `finding_category`) is auto-escalated one severity level and
tagged `judgment.same-mistake` — including over-engineering S3 → S2 once a
matching lesson is approved (`severity.yml`). This is the factory's key
quality KPI: same-mistake rate should trend to zero.

## 9. Budget alarms + the escalation ladder

- **Per-epic cap: 4,000,000 tokens** (planner + all workers + judges),
  raised from 2,000,000 on 2026-08-11 after the `envkit-mcp-surface` dogfood
  measured 1,529,963 tokens for its two *smallest* tasks. That raise was an
  operator decision, recorded beside the number in `budgets.yml` along with
  what it does not fix. Alarm at 70% (2.8M): the planner must re-plan
  remaining work to fit, or ask you. Epics that can't fit are split into
  multiple epics at spec time — the cap is never silently extended. Checked
  by `smith budget alarm` (§9a); until 2026-08-10 nothing checked it at all.
- **Per-task caps (coder): 150,000 tokens, ≤400 changed diff lines**
  (excluding lockfiles/generated files). Hitting either is not a failure —
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
  2. 2 failed rounds → escalate model tier automatically (sonnet → opus),
     logged.
  3. 3 failed rounds → escalate to you.

  Asserted against the log by `smith escalation check` (§2c) — the rungs
  carry a machine-readable `failed_rounds`/`enforce` half beside this prose.

(`factory/policies/budgets.yml`)

## 9a. `smith budget alarm` — the alarm, counted instead of remembered

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
so you can see which roles the ceiling is made of.

That asymmetry decides the status, and it is worth understanding before you
read one:

| status | meaning |
| --- | --- |
| `under` | The *projected* ceiling is below the alarm, so the real spend is too. The only status that clears. |
| `alarm` | Measured spend alone has reached `alarm_ratio × cap_tokens`. Re-plan the remaining work to fit, or extend the cap yourself. |
| `over-cap` | Measured spend alone has reached the cap. |
| `at-risk` | Measured spend is under the alarm and the projection is not. |
| `unverifiable` | Nothing has crossed, and the record has holes that could be hiding a crossing. |

A crossing is reported even when the record has holes, because unrecorded spend
can only make the bill bigger — a hole cannot un-cross a threshold. A
*non*-crossing gets no such benefit: "under" is only honest when the upper bound
is under too, which is why an epic with an unpriceable dispatch comes back
`unverifiable` rather than clean.

### What makes an epic unverifiable

- **A role `budgets.yml` prices nowhere** (`rolesWithoutCap`). The policy prices
  `coder`, `researcher`, and the four judges named at `task.judges`. It does not
  price `security-reviewer`, `merger`, `tester`, `uiux`, `planner` or `scribe`,
  all of which the factory dispatches. Those dispatches are in neither number,
  so the projection is not a ceiling.
- **A dispatch no epic can be charged for** (`unattributedDispatches`). Its
  tokens are in nobody's total, so no epic's "under" is trustworthy.
- **A task measured above the largest cap in the policy** (`tasksOverPrice`).
  The projection charges an unmeasured dispatch its declared cap, and the gate
  records an overrun without blocking on one — so a cap is a target, not a
  bound. Once a task in *this* epic has been measured spending more than the
  most the projection can charge, the epic's own log has falsified the price
  list the ceiling is built from (D-188). `envkit-mcp-surface/task-2-path-guard`
  recorded one coder round at 1,484,000 tokens against a 150,000 coder cap.

All three are reported rather than assumed free. Fixing the first two means
adding the missing cap or the missing `task_id`; the third is fixed by
recording the spend, not by raising the cap to cover it — a cap raised to fit
what was spent buys back the "ceiling" by giving up the budget.

### `at-risk` is D-9, made visible

On the `envkit-config-loader` dogfood epic, the plan's declared task budgets
summed to 545,000 against a 2,000,000 cap — 27%, comfortably under the 1.4M
alarm — while the run's real projection was over 1,150,000 and its true cost
higher still. `smith plan quorum`'s budget trigger sums *declared* budgets, so
the one automated check meant to catch "this plan is too expensive" measures the
smaller half of the bill. `at-risk` is the status for exactly that shape: the
visible half reads clear while the whole bill does not.

### What it reports on the dogfood log today

```
epic envkit-config-loader: 0 tokens measured across 0 of 5 tasks,
1,150,000 projected, against a 1,400,000 alarm and a 2,000,000 cap.
status: unverifiable — budgets.yml declares no cap for security-reviewer.
```

**Zero measured** on an epic that really cost over a million tokens. That
session's log holds no `task-result-recorded` and no `budget-check-result` event
at all, so there is nothing to measure and the entire number is projection. An
alarm built on measured spend alone would have printed "0 / 1,400,000 — under"
and exited 0. That is the false clean this command exists to refuse.

### Limits, stated plainly

- It reads the log; it does not stop anything. `smith daemon` re-runs the same
  fold on an interval so an alarm reaches you without an open session
  ([`../runbooks/ops.md`](../../runbooks/ops.md)), but it does not dispatch and so
  cannot refuse the next wave either — acting on `alarm` is still your call.
- The projection prices each unmeasured dispatch at its role's *cap*. That is an
  upper bound by construction, so `at-risk` means "could cross", not "will".
- Judge tokens are never recorded anywhere, at any budget. Until a dispatch
  harness writes them down, no number here is the real bill.
