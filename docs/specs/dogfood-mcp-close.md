# Dogfood close-out #2 — `envkit-mcp-surface`

The second epic driven end to end through the factory, and the first driven
through it *after* the 37 fixes that the first one paid for. The question this
run was built to answer was not "does the pipeline work" — dogfood #1 already
showed it does — but "which of Phase 9's claims are observable, and which are
only inferred from unit tests."

Companion documents: `docs/specs/dogfood-envkit-close.md` and
`docs/specs/dogfood-envkit-findings.md` (D-14…D-48, the first run),
`docs/specs/phase-9-punch-list.md` (P9-8…P9-36, the work that followed it).
Findings here continue that numbering at **D-49** and run to **D-115** (D-115
was added on 2026-08-13 while fixing D-109, not during the run).

Session log: `state/events/dogfood-mcp-1.jsonl`, 354 events. Every claim below
cites a command run in-session or a source line read in-session. Where a claim
is mine rather than the factory's, it says so.

---

## The headline

**The epic did not close, and that is the result.**

`smith epic close` refused, exit 1, with eleven open findings enumerated by id,
task, status and severity. No `--override-rationale` was passed, no
`epic-closed` event was written, and the roadmap milestone is still `planned`.

> **Superseded 2026-08-14.** The epic closed at `dogfood-mcp-1#403`, verdict
> `go`, and the milestone is now `completed`. The paragraph above stands as
> written — it was true when it was measured, and the refusal it records is
> still the correct refusal. What cleared the eleven findings is the next
> measurement, and it is worse than the refusal was good: see
> **[Epilogue](#epilogue--the-epic-closed-and-how-it-closed-is-the-finding)**
> at the end of this file.

That refusal is correct and it is the single most valuable thing the run
produced, because the branch it refused to close is *mechanically perfect*:
four tasks complete, four checks green at the integration root, a closing spec
review pinned to that exact head. The gate held anyway, on the strength of a
spec review that found the plan wrong in six major places after the code that
implements it already existed.

The second most valuable thing the run produced is the discovery that the
*other* gate on the same command — the MCP surface gate the operator asked for
on 2026-08-07 — never fired at all, and could not have (D-109; fixed
2026-08-13, see the resolution note under that finding).

---

## What shipped

An MCP surface for `envkit`, in `workspaces/envkit` on
`smith/envkit-mcp-surface/integration` at **`f45c241b`**. Four plan tasks, all
merged through the serial queue:

| task | files added |
|---|---|
| `task-1-redact-env-shape` | `src/mcp/redact.ts`, `test/mcp/redact.test.ts` |
| `task-2-path-guard` | `src/mcp/paths.ts`, `test/mcp/paths.test.ts` |
| `task-3-env-lint` | `mcp.manifest.json`, `src/mcp/server.ts`, `src/mcp/tools/env-lint.ts`, + 2 test files |
| `task-4-env-diff-keys` | `src/mcp/tools/env-diff-keys.ts`, `src/mcp/README.md`, + manifest/server/test updates |

### Verified state of the integration branch

`smith integration check --run-all`, run at the integration root, recorded as
event `#333`:

| check | exit | note |
|---|---|---|
| `lint` | 0 | biome, 23 files |
| `typecheck` | 0 | |
| `test` | 0 | 10 files, 252 tests |
| `build` | 0 | |

All four green, at `f45c241b`, at the integration root — not in a task
worktree. This is P9-26's fix (D-42 from run #1) working: run #1 could not make
this claim at all.

### The contract that changed

`smith mcp init` adds `@modelcontextprotocol/sdk` and `zod` to the project,
which breaks envkit's advertised zero-runtime-dependency contract. Put to the
operator mid-run; the decision was **keep it and write the new contract down**:

> envkit's contract becomes *zero deps in the core library, SDK + zod only on
> the MCP surface*.

Recorded at `dogfood-mcp-1#9`. The plan was already written that way, so
nothing was re-planned.

---

## The product finding: a cross-task collision no per-task gate could see

The closing spec review raised **10 findings** — 0×S1, 6×S2-major, 3×S3-minor,
1×S4-nit — against a branch whose four per-task gates had all passed.

| criterion | sev | what |
|---|---|---|
| task-1 AC[3] | S2 correctness | greedy `ENV_ASSIGNMENT` run destroys same-line pairs |
| task-1 AC[6] | S3 test-coverage | totality gap |
| task-2 AC[6] | S2 security | undocumented ancestor-symlink walk, traceable to no criterion |
| task-2 AC[7] | S4 | `ELOOP` inside the root reported as "outside the project" |
| task-3 AC[1] | S2 correctness | manifest is `0.2.0`, the criterion says `0.1.0` |
| task-3 AC[10] | S3 security | `SurfaceError` bypasses `redactError` |
| task-3 AC[12] | S2 test-coverage | the "NUL byte" test uses the literal string `'has nul'` |
| task-3 AC[12] | S3 test-coverage | totality gap |
| task-4 AC[8] | S2 security | unbounded key length + no content-type check → a near-1MiB content dump is reported as a key |
| task-4 AC[15] | S2 correctness | AC[15] forbids the edit AC[22] mandates |

**The task-3/task-4 pair is the headline.** Task-3's criterion pins the
manifest at `0.1.0`; task-4's mandates an edit that takes it to `0.2.0`. Both
tasks satisfied their own gate. The contradiction exists only in the union, and
it was found independently from both ends by two different shards of the
closing review. No per-task gate could have seen it, and no amount of per-task
rigour would have. That is the argument for the close-time spec review existing
at all, and this run is the first time it has paid for itself.

### Why the epic cannot simply be closed

Traced in source, not assumed:

- **6 × S2-major, all `finding_scope: spec`.** `LEGAL_TRANSITIONS`
  (`findings.ts:87`) permits `→ waived`, but `transition()` additionally gates
  it on `WAIVABLE_SEVERITIES` (`findings.ts:571-575`, `severity.yml`
  `waiver_semantics`: only S3/S4 are ever waived). No S2 can be waived. Their
  only exit is `amended` — a `plan amend` cutting v4.
- **4 × S3/S4 spec-scoped.** Amendable, or waivable on severity.
- **1 × S3-minor carrying no `finding_scope` at all**
  (`f-…task-1-redact-env-shape-c1218f44`), so `findingScope()` defaults it to
  `diff` (`findings.ts:100-108`). `amendPlan` explicitly refuses non-spec
  findings — *"it says the code is wrong; a new plan version is not how a diff
  defect gets fixed."* It cannot ride the v4 amendment. It must be fixed in
  code, or waived.

So one hold requires **two different exits**, and nothing in the refusal
message tells the operator that. Cutting v4 and re-running the four tasks
against amended criteria is a second full epic, not a closing step. The epic
stays open.

One thing checked before it was recorded as a defect, and found not to be one:
all ten spec findings are filed on `task_id: envkit-mcp-surface/integration`
while their `spec_ref.criterion_ref` names the real per-task criterion. That
split is deliberate — `cli.ts:1483-1487` skips reattribution for spec-scoped
findings because *"no task can hold the fix, because the fix is a plan
amendment"* — and `amendPlan` carries `criterion_ref` into its `amends[]` list,
so the amendment knows which clause moved.

---

## Findings against black-smith

### A. Gates that do not fire

**D-109 — the "hard gate at epic close" for MCP has two independent holes, and
either alone defeats it.** The operator's standing decision of 2026-08-07 was
*hard gate ở epic close*. This run observed `smith mcp check envkit` exit 1 on
MCP-M2 at the same moment `smith epic verdict` reported
`"mcp": {"required": false, "milestoneId": null, "check": null}`.

- *Hole 1 — satisfiable by omission.* `resolveMcpSurface` (`mcp.ts:542`)
  selects the milestone with
  `m.milestoneId.endsWith('-mcp-surface') && m.epicIds.includes(opts.epicId)`.
  `roadmap.md:94` declares the milestone with `epics: []`. The epic id is in no
  milestone's `epicIds`, so the function returns `MCP_SURFACE_NOT_REQUIRED` and
  `mcpBlockers` returns `[]` on its first line. An empty `epics:` list is the
  *default state of every milestone in the roadmap*.
- *Hole 2 — the roadmap rules can never reach the close.* Even with `epicIds`
  filled in, `resolveMcpSurface`'s `check` is `checkManifest(...)` alone, which
  emits MCP-P1/P2/T5. MCP-M1 and MCP-M2 come only from
  `checkRoadmapMcpMilestone`, which only the standalone `runMcpCheck` calls.
  The violation that is red right now lives in the half `epic close` cannot
  see.

Fixing either alone is insufficient. Both, plus the roadmap's epic ids, are
required before the operator's decision is true.

This finding **retracts D-108**, which I had asserted on my own authority from
reading `checkRoadmapMcpMilestone` and `mcpBlockers` without tracing how
`epic.ts` assembles its `mcp` input. D-108 described a close-time circularity —
the milestone would have to be marked `completed` before the epic that builds
it could close. There is no circularity, because there is no gate.

> **Resolved 2026-08-13, and the prescription above is half wrong.**
>
> *Hole 1 is fixed.* `resolveMcpSurface` now decides applicability with
> `epicIds.includes(epicId) || milestoneId === epicId`, `registerMcpMilestone`
> seeds `- epics: [<project>-mcp-surface]` instead of `[]`, and
> `roadmap.md:94` names the epic. Probed against the built binary: `smith epic
> verdict --epic envkit-mcp-surface` went from `"mcp": {"required": false}` to
> `"required": true, "milestoneId": "envkit-mcp-surface"`, while
> `envkit-config-loader` correctly stays `false`. The gate fires.
>
> *Hole 2 is refused, on evidence, and this retracts the "both are required"
> sentence above.* Piping the roadmap rules into `mcpBlockers` would not
> strengthen the gate — it would resurrect D-108 for real:
>
> - MCP-M1 cannot fire at close time. `required: true` means a surface
>   milestone was found, which is exactly what M1 tests for.
> - MCP-M2 fires while the surface milestone is not `completed`. Nothing in
>   this codebase ever writes a milestone status — `registerMcpMilestone` seeds
>   `planned`, `epic.ts` contains no reference to the roadmap at all (grepped),
>   and only a human edit moves it. So an MCP-M2 blocker would force the
>   operator to mark the surface **completed before** the gate would let them
>   close the epic that completes it, and the gate would then be checking an
>   assertion it had just compelled. D-108 was retracted for being moot, not
>   for being wrong; fixing hole 1 is what would make it true.
>
> The real residual gap is neither hole. **MCP-M2's enforcement point is the
> *final* milestone's close** — the standard's own words are "closes before the
> project's final milestone" — and no such gate exists; M2 is reachable only by
> running `smith mcp check <project>` by hand. envkit is the live case: its
> other two milestones are already `completed`, so M2 is red right now, and
> nothing structural would stop envkit being declared finished. Recorded as
> **D-115** rather than folded into D-109, because it is a gate that was never
> built rather than one that was built wrong.

**D-114 — the epic-level cross-check trigger is inert in the shipped
configuration.** `epic.ts:392-395`, Step 2: `if (providers.length === 0) return
{ outcome: 'go', ... }`. Both external providers are `enabled: false` in
`crosscheck.yml`, so a mechanically-ready epic returns `go` having run zero
judges and written zero events — and the output gives an operator no way to
distinguish a cross-checked `go` from an unjudged one.
`docs/runbooks/providers.md:62` lists this trigger in a table asserting that as
of Phase 8 all four "have a real host in the pipeline." The host exists; the
trigger does not fire.

**D-100 (carried, confirmed again)** `judges-outstanding` is satisfiable by
omission and write-only-on-failure. Same shape as D-109's hole 1: a gate whose
trigger condition is the presence of a declaration nobody is required to make.

**(d) (carried)** The S1/S2 cross-check quorum is inert for the same reason as
D-114.

### B. Logs that misdescribe themselves

**D-111 — `plan quorum` prints "endorsed" having judged nothing.** The command
printed `{"outcome": "endorsed"}`, exit 0, while its own event recorded
`outcome: "not-run"`, `participants: []`, `gating_participants: []`,
`decision: null`, `endorsed_by: "default-no-provider"` — for a plan that fired
four distinct security triggers. `usage.ts:65` promises "Exit 1 means the
operator must look first."

*Positive, in the same breath:* `endorsed_by` is an honest mitigation. P9-23
added it precisely so "endorsed by the shipped default" is distinguishable in
the log from "two providers voted confirm." It works. It is also the exact fix
D-114's epic path is missing — the pattern exists in this codebase and simply
was not applied there.

**D-112 — a hardcoded `trigger_reason` corrupts every quorum event.**
`planQuorum.ts:400` hardcodes `trigger_reason: 'low-confidence-plan'` in the
payload builder rather than deriving it from which triggers fired. This run
fired eight triggers, all `security`, and zero confidence triggers — no
`--confidence` was passed at all. The event nonetheless records
`low-confidence-plan`, with the contradicting `fired_triggers` list sitting in
the same payload. Every plan-quorum event in every session carries the same
wrong reason.

**D-102 (carried)** Gate stage events carry the caller-supplied `--actor`.

### C. `plan.tasks` counted without a `task_status` filter — D-77's blast radius

**D-77 (carried, sharpened).** Supersede-in-place leaves both the superseded
and the live record in `plan.tasks`. `plan-v3.json` holds 8 records for 4
tasks. Consumers that iterate `plan.tasks` without filtering
`task_status !== 'superseded'` double-count.

**D-113 — observed firing in a second consumer, with numbers.**
`planQuorum.ts:159` (budget sum), `:175` and `:208` (trigger scans) all iterate
unfiltered. Measured this run:

| quantity | all records | live only |
|---|---|---|
| task records | 8 | 4 |
| security triggers emitted | 8 | 4 |
| declared budget sum | 700,000 | 350,000 |
| ratio vs `epic.cap_tokens: 4,000,000` | 0.1750 | 0.0875 |

The budget trigger fires at ≥ 0.5, so it did **not** flip here and I am not
claiming it did. But the doubling means any plan whose live ratio lands in
**[0.25, 0.5)** will fire the budget trigger falsely after a single
supersede-in-place amendment. Wrong for a reason that happened not to matter
this time.

**D-89 (carried)** `plan ingest` on an amended plan flips every task to
`superseded`. **D-83** `plan amend` fixes only the record a finding names.
**D-85** the no-op-amendment warning cannot see a supersede-in-place. **D-92** a
`task_id` typo splits a task and invents a phantom. **D-90** the stale
`task_status` on task-1 is inert — this retires a blocker I asserted three
times on my own authority.

### D. Provider transport

**D-110 — the CLI transport cannot distinguish "not installed" from "returned
garbage."** `cli-transport.ts:93` registers `child.on('error', finish)` — the
same `finish` as the normal `close` handler. A spawn `ENOENT` therefore
resolves with `stdout: ''`, `timedOut: false`, `sizeExceeded: false`:
byte-identical to a judge that ran and printed nothing. The caller retries once,
then reports a schema failure.

`docs/runbooks/providers.md:17-20` tells the operator that if `codex login` was
never run, "every Codex judge call fails with `provider.timeout` or a nonzero
exit." Neither can happen for a missing binary — the error handler fires
immediately and clears the timer, and there is no exit code because there was
no process. The one diagnostic the runbook offers points away from the cause.

`which codex` on this machine: not found. Blast radius is low today because
both external providers are `enabled: false`; it matters the first time the
operator turns Codex on.

> **Resolved, and wider than stated here.** The operator did turn Codex on, and
> the first real call showed the scope was understated: `spawnOnce` discarded
> the exit code on *every* path, so no cause of process-level failure was
> reportable, not just a missing binary. See D-116 of the dogfood-3 run for
> the observed failure and the fix (`provider.cli-unavailable` /
> `provider.cli-failed`).

**D-104 — `.env` is documented and loaded by nothing.** No `dotenv` dependency,
no `--env-file`, no script that sources it. `api-transport.ts:21` reads
`process.env[config.apiKeyEnv]` at call time, so the working invocations are
`node --env-file=.env …` (Node ≥ 20.6) or `set -a; source .env; set +a`. Now
written into `.env.example`'s header rather than left for the next operator to
rediscover.

**D-105 — `.gitignore:18`'s `.env.*` also ignored `.env.example`,** making
`guardrails.md`'s ".env.example is the only committed env file" unenforceable.
Fixed in this branch with an `!.env.example` negation and a comment saying why.

**D-106 — `cli.ts:1829`'s `ui.not-built` error names the wrong command.** It
tells the operator to run `pnpm build:ui` when the missing file comes from
`pnpm build:server`.

*Status: fixed 2026-08-18* (D-154's branch, which met the same confusion from
the other side). The message now names `pnpm build:server`. The line has moved
to `cli.ts:1970`; the string is unchanged apart from the command.

### E. Usage strings that cannot run their own command

**D-107 — `epic verdict` cannot be invoked from its documented flags.**
`usage.ts:252` documents `--epic <id> --project <dir> [--roadmap-path <file>]`.
The CLI rejected the call twice — first `Missing required flag --session`, then
`Missing required flag --causal-parent` — because every command routes through
the shared `eventContextFromFlags`. Second instance of the class after
`epic spec-review --reviewed-by`.

`plan quorum`'s entry (`usage.ts:60-66`) is complete and correct, including both
flags. That counterexample is what makes the other two a defect rather than a
house style.

*Withdrawn from D-107:* my framing that this is "a read-only command demanding
write-only flags." I verified the observation (347 log lines before the verdict,
347 after) but generalised it wrongly. `epic.ts:381-385` shows the zero-event
outcome is a deliberate Step-1 early return on the mechanically-blocked path,
and Step 5 does append a `quorum-decision` event past it. `--causal-parent` is
genuinely load-bearing. Only the documentation half survives.

### F. The gate's evidence intake

Carried forward from earlier in this run, all confirmed by observation:

- **(a)/(a2)/(a3)** the gate's one-turn-per-run evidence intake, its opposite
  failure directions, and a double-close.
- **(b)** the gate never reads the findings store; **(c)** an out-of-band
  verifier verdict has no path into the gate.
- **(g)** `judge report` never checks the artifact matches its role's shape —
  **five live 3-byte `[]` instances** in this run's state.
- **(h)** `finding_status: refuted` is effectively unreachable; **D-96**
  `waived` is reachable only for S3/S4 (correcting the earlier flat "waived is
  unreachable" — `findings transition <id> waived` exists and works within
  `WAIVABLE_SEVERITIES`).
- **D-101** the budget stage fails open and silently without `--plan`.
- **D-78** grader-verdict is commit-blind; **D-82** rubric-blind; **D-84** the
  round counter is self-declared; **D-86** the result filename encodes the round
  but not the plan version.
- **D-80** repo-relative artifact declarations report `missing`; **D-81** the
  taxonomy error names `agent`, not `agent_role`.
- **D-93** a fourth `diff_lines` overrun recorded and passed.
- **D-95** the lesson corpus is inert. **D-88** `plan amend` never notifies the
  projection. **D-76** a verifier-ordered dedupe cannot land.
- **(e)** neither judge role file contains an attribution rule. **(f)** agent
  completion text is not a reliable signal that work landed.
- **D-98 (three instances)** no precedence rule between a role file's return
  contract and an orchestrator's request.
- **D-87 — `maxTurns` truncation is indistinguishable from completion. Nine
  firings this run.** The single most expensive defect in the run by wall-clock.
  **D-103** sharding does not defeat it, because the write is last: the closing
  spec review was sharded four ways *specifically* to dodge the turn budget, and
  three of the four shards still truncated before writing.
- **D-97** every per-dispatch token figure is a final-turn usage block and
  therefore a lower bound. Every budget number in this run is a floor.
- Smaller: the v8 text reporter omits fully-covered files; `vitest.config.ts`'s
  `thresholds.perFile: true`; two `wave-merged` events sharing
  `causal_parent #209`; `criterion_ref`'s documented format is unsatisfiable and
  checked for truthiness only; the four review shards disagree on `file_path`
  convention and one names a file that does not exist in the checkout, with
  nothing validating that `file_path` resolves; `pnpm install --frozen-lockfile`
  needs `--ignore-workspace` in a task worktree; the gate's two result-intake
  shapes are documented only in a source comment; `state/artifacts/` holds six
  directories for four tasks; and a fix built for one instance of a defect did
  not generalise to the next instance three steps later.

### G. Positives worth recording

Phase 9's fixes are not uniformly theatre. These were observed working:

- **The integration root is real.** All four checks ran at the integration
  root at a pinned sha. Run #1 could not make that claim (D-42/P9-26).
- **`epic verdict` and `epic close` agree.** The free read-only probe predicted
  the writing verb exactly — same eleven blockers, same reason.
- **The close refuses cleanly.** Exit 1, complete blocker list, no event
  written on refusal, escape hatch named but not taken.
- **`specReview.headSha` is pinned.** The verdict recognises the closing review
  as a review *of this branch*, not an older one. A stale review cannot be
  laundered into a close.
- **`nonTerminalTaskCount: 0`.** Contrast run #1, where D-28's id-convention
  split hid four of five merged tasks from the verdict entirely.
- **`endorsed_by` (P9-23)** distinguishes an unjudged endorsement from a real
  quorum in the log.
- **`attested` is modelled and persisted.** Schema-check and grader-verdict are
  the two gate stages that work as specified.

---

## The budget decision

Mid-run the epic budget alarm went red at 109% of the 2,000,000-token cap with
two of four tasks done — and those two were the *smallest* two in the plan. The
operator raised the cap to **4,000,000** (`budgets.yml:50`, 2026-08-11).

Recorded honestly in the policy file itself, because both caveats matter:

1. There is no per-epic override, so a number raised for one epic is raised for
   every epic black-smith will ever run.
2. A large share of the 1,529,963 tokens measured was **rework** — stopped
   dispatches and re-dispatches that `smith escalation check` recorded as ladder
   violations, three of them mine. The cap now accommodates waste as well as
   work. A cap sized from a badly-run epic is a ceiling measured at the wrong
   place.

`DEFAULT_EPIC_CAP_TOKENS` in `budgets.ts` was deliberately left at 2,000,000
rather than synced, with a comment saying so: a project that ships no policy at
all should get the conservative number and an alarm that fires early. That
divergence is a judgement call, and it is mine.

---

## What I got wrong

The run's own operator was a significant source of its noise. Recording this is
not ritual self-flagellation — several findings above would be misattributed to
the factory if this section did not exist.

**Dispatch errors that produced factory-looking failures:**

- The grader-shape failure on an earlier task was my own dispatch error, not a
  grader defect.
- My task-1 security dispatch prompt was a confound: it named what to look for.
- The round-3 grader dispatch violated `grader.md:96-99`.
- The task-3 gate's first BLOCK was my own omitted `--agent` flag.
- The task-4 `dispatch_decision` was rejected once for my own omitted `model`.
- Gate run 2's block was my own wrong `--artifacts-dir`; run 3's was my dispatch
  prompt contradicting `grader.md:61-78`; run 6's degraded pass was my own
  omitted `--plan` (which is how D-101 was found).
- Three escalation-ladder violations are mine, and they inflate the token
  figure the budget cap was then raised against.

**Analysis errors — a true observation with a false explanation attached, four
times:**

- `#334` — my plan-v3 duplicate check grepped `status` instead of `task_status`.
- `#348` — **D-108 retracted.** The MCP circularity I described does not exist;
  the real defect (D-109) is a gate that does not fire.
- `#350` — **D-107's framing withdrawn.** "A read-only command demanding
  write-only flags" was wrong; the zero-event path is a deliberate early return.
- `#353` — I expected `epic close` to exit 0 unconditionally because I had read
  its success-path `return 0`. It exits 1; a refusal throws.
- **D-99's central unsatisfiability claim was my own analysis error.**

That is one recurring failure mode, not four unrelated slips: reporting a
verified observation together with an unverified generalisation, in the same
breath and with the same confidence. All four were caught by re-reading source
rather than by anything the factory did — which is itself a finding about the
factory, not a comfort.

**Process failures:**

- My `#260` "operator verification" never validated the result file against its
  own schema.
- The plan-wide spec audit was attempted twice, **abandoned**, and never
  completed. That is why the closing review was sharded — and sharding did not
  fix it (D-103): three of four shards still truncated before writing.
- The "round 1" label on the post-v3 grading is my claim, not a system fact.

---

## What this run proves, and what it does not

**Proves:**

- The close-time spec review earns its cost. It found a cross-task contradiction
  (task-3/task-4 manifest version) that no per-task gate could see, from both
  ends independently.
- The finding-based half of the epic-close gate is real and refuses correctly.
- P9-26's integration-root fix works end to end.
- Phase 9's `endorsed_by`, `attested`, `specReview.headSha` and
  `nonTerminalTaskCount` fixes are observable, not just unit-tested.

**Does not prove:**

- Anything about cross-provider agreement. **Zero external judge calls ran** in
  this entire epic: both providers are `enabled: false`, `codex` is not
  installed, and no DeepSeek key was set. Every quorum in this run was a trigger
  evaluator and an event writer, never a quorum. Any claim that Phase 8's
  cross-check "works" remains untested by dogfooding.
- That the MCP surface is safe. `smith mcp check envkit` is **red** on MCP-M2,
  and no gate on any command reaches that rule. At the time of the run the
  epic-close gate was blind to *everything* (D-109, fixed since); it now fires
  on the manifest rules and is still, deliberately, blind to MCP-M2 — that rule
  belongs to a final-milestone gate nobody has built (D-115).
- That the token figures are accurate. Every one is a lower bound (D-97).
- That the lessons pipeline does anything. The corpus is still inert (D-95).

**Deliberately not done, and why.** I did not add the epic id to
`roadmap.md`'s `epics: []`, and I did not patch `resolveMcpSurface`. Either edit
mid-run changes the instrument during the measurement, and the roadmap edit
specifically would have marked the milestone's own work as tracked in order to
be allowed to grade it. The close ran against the factory as it actually is.
Both fixes belong to black-smith, not to this dogfood.

*Both landed in black-smith on 2026-08-13, after this run was closed and
without touching its event log — see the resolution note under D-109. The third
edit that note prescribed, wiring the roadmap rules into the close, was refused
with reasons rather than made.*

---

## Epilogue — the epic closed, and how it closed is the finding

Written 2026-08-14, against `state/events/dogfood-mcp-1.jsonl` at 404 events —
the same log this report read at 354. Everything above this line stands as
measured; nothing in it has been rewritten.

`smith epic close` succeeded at `dogfood-mcp-1#403`. `epic-closed`,
`closed_by: verdict`, `machine_verdict: go`, `blockers: []`,
`override_rationale: null` — no operator override, the machine said go. The
integration head moved from `f45c241b` to `049765c3`, `integration check`
passed against that exact sha, the closing spec review was pinned to it at plan
v5, and the roadmap milestone is now `completed`. The dogfood-3 findings carry the
full close-out.

So the gate that refused eleven findings ago let go. The question this epilogue
exists to answer is what changed in between — and the answer is in the log, not
in the code.

### Twenty-three findings, and how each one ended

Every `finding-raised` and `finding-transitioned` event in the session, tallied
by the status each finding finished in:

| exit | count | severities |
|---|---|---|
| `amended` | **14** | 9× S2, 4× S3, 1× S4 |
| `waived` | 3 | 2× S3, 1× S4 |
| `refuted` | 3 | 1× S1, 1× S2, 1× S3 |
| `fix-verified` | 3 | 2× S2, 1× S3 |

Twelve S2 findings were raised in this run. **Nine of them were closed by
writing a sentence in a plan file.** Two were closed by landing code and
verifying it. One was argued away. The unwaivable class — the one the severity
table protects hardest — took the cheapest exit five times more often than the
expensive one.

The four S3s and the S4 that also left through `amended` are the same fact from
the other side. Those were waivable; a waiver would have cost an operator
rationale and left the finding legible as *accepted, not fixed*. `amended` cost
nothing and rendered as closed. The cheapest exit did not merely attract the
findings that had no other exit — it attracted findings that did.

### What the amendments actually obligated

Four `plan-version-created` events, v2 through v5, discharging fourteen
findings between them. The log carries exactly four `task-added` events, and
all four are `"plan_version": 1`.

**Not one of the four amendments added a task the event log ever saw.** Task-5
— the v5 key bound, the only work in this epic that closed a real leak — exists
in plan v5 and in the merged code, and there is no event in this session that
records its creation. The verdict that certified the epic lists four tasks
(`non_terminal_task_count: 0`), and task-5 is not among them.

That is D-126 and D-127 standing next to each other, and it is the closing
argument for both. D-127 is the exit that costs nothing; D-126 is the reason
nobody could see it cost nothing, because the one task an amendment did produce
was invisible to the instrument that was supposed to be waiting for it.

### What the three waivers prove

The last three findings were not amended. They were waived — `integration-97825fcf`
(S3), `integration-c721a990` (S3), `integration-9b8279e9` (S4) — with rationales
attached and a named follow-up epic that has to claim `mcp.manifest.json` and
both tool files. Those three are the only findings in this run that leave a
reader an honest account of an unfixed defect.

They are also all S3/S4. The unwaivable class produced no such record, because
it never had to.

### Revised verdict on this run

The headline was right and is still right: the refusal was the most valuable
thing the run produced. What the run could not measure, because it ended at the
refusal, is whether the *un*-refusal is earned. It was not. Across the whole
run, three findings were fixed and verified, three were argued away, three were
honestly waived — and fourteen were closed by editing the document that defines
what "closed" means.

Both defects are numbered and fixed in black-smith: D-126 gives the live plan a
vote in the verdict's roster, and D-127 puts an `amend-pending` status between
the amendment and the close, gated on the obligated tasks actually landing at or
past the amendment's plan version. Under those rules this epic does not close on
2026-08-14, and the mechanism is worth stating exactly, because it is not the
one you would guess.

`diffPlans` reads a task whose live spec changed as **superseded**
(`plan.ts:506` — even a reordered-but-identical spec does). So each of these
fourteen amendments rewrote an acceptance criterion on an already-`completed`
task, and under the fix that obligates the amended task to land *again*, at or
past the amendment's own plan version. Not one did: every task in this epic
carries a single terminal record from its v1 run. The version clause — not the
terminal-status clause — is what refuses them, and this run is precisely the
shape it was written for. Fourteen findings sit at `amend-pending`; the
verdict's roster is five tasks; the epic holds open.

That is the correct outcome, and this run is the evidence for it. Recorded here
rather than only in the defect entries because a reader who stops at the
headline should learn that the gate held, and a reader who reaches the end
should learn what it cost to make it let go.
