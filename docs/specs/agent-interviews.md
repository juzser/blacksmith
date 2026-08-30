# Per-Agent Interviews

> One careful interview per subagent role. Answers compile into that agent's
> constraint block in `docs/standards/agent-constraints.md` and, from
> Phase 2, into its template in `.claude/agents/`. Same rules as the main
> interview: recommended defaults marked, blank = accept default,
> re-answer anytime to recompile.
>
> **Recorded 2026-08-03 — coder effort discipline applied by default** (the
> operator skipped the interactive round, defaults locked in): token cap
> 150k/task · diff cap ≤400 lines · strict YAGNI · over-engineering = S3
> with same-mistake escalation. Override by re-answering C-1…C-4.

## planner

**P-1. Decomposition granularity.** Target task size when splitting an epic.
Recommended: tasks sized to the coder caps (≤400 diff lines, ≤150k tokens) —
if a task can't credibly fit, split further before dispatch.
> Answer:

**P-2. Spec depth.** What every task spec must contain beyond the contract
minimum (objective, schema, acceptance criteria, claims, budget).
Recommended: + file-level implementation sketch and named edge cases; no
code in specs.
> Answer:

**P-3. Research budget.** Max share of an epic budget spent on
research/uiux before any code. Recommended: 15%.
> Answer:

**P-4. Re-plan trigger.** When a bounced task (budget-exceeded/re-scope)
returns: re-split silently, or notify the operator when the same task
bounces twice? Recommended: notify on second bounce.
> Answer:

## coder

**C-1. Token cap per task.** ✅ **Recorded: 150k** (default applied
2026-08-03). Cap hit → stop, report, return to planner (`budget-exceeded`).
**C-2. Diff cap.** ✅ **Recorded: ≤400 changed lines** excluding
lockfiles/generated; projected overrun → return to planner to split.
**C-3. Abstraction policy.** ✅ **Recorded: strict YAGNI** — acceptance
criteria only; new abstraction needs ≥2 real call sites in the same epic; no
unspecced config options/generics/layers/patterns; no TODO scaffolding; no
drive-by refactors.
**C-4. Over-engineering severity.** ✅ **Recorded: S3** (waiver batch with a
proposed simplification), auto-S2 once a matching lesson is approved
(same-mistake rule).

**C-5. Context reading.** May the coder read outside its claims + spec refs?
Recommended: no — unknowns become `research-request` events.
> Answer:

## tester

**T-1. Test depth per severity of feature.** Same rigor for a chore as for a
core flow, or tiered? Recommended: tiered — core-flow tasks get edge-case
tests + e2e step; chores get happy-path only.
> Answer:

**T-2. Flake policy.** Quarantine-and-report or delete-and-block?
Recommended: new flaky test = S2 on the introducing task (already recorded);
pre-existing flakes get quarantined with a `recheck` task.
> Answer:

**T-3. Screenshot judgment.** Screenshots always (recorded: desktop+mobile,
light+dark, ≤4) — plus short screen-capture video for interaction-heavy
features? Recommended: video only when the acceptance criteria mention
interaction.
> Answer:

## reviewer

**R-1. Review scope.** Diff-only, or diff + blast radius (callers/callees of
changed code)? Recommended: diff + blast radius within the epic's claims.
> Answer:

**R-2. Finding budget.** Cap findings per round to force prioritization?
Recommended: top 10 by severity; the rest go to a non-blocking notes list.
> Answer:

**R-3. Style commentary.** Reviewer comments on style the project's linter
can't catch? Recommended: no where the linter enforces it — the reviewer
sticks to correctness, security, a11y, over-engineering, tests; where the
project has no linter, style goes in as `S4-nit` and never above.
> Answer:

## verifier

**V-1. Verification stance.** Refute-by-default on every finding, or only
S1/S2? Recommended: refute S1/S2 (they block); spot-check 20% of S3.
> Answer:

**V-2. Evidence bar.** A finding survives only with a concrete failure
scenario (inputs → wrong output)? Recommended: yes — "could be a problem"
dies at verify.
> Answer:

## merger

**M-1. Conflict confidence.** Merger self-resolves only when one side is
purely mechanical (rename/format)? Recommended: yes; anything semantic
escalates per guardrails.
> Answer:

## scribe

**S-1. Summary length caps.** PR bodies ≤300 words + artifacts; timeline
entries one sentence. Recommended: yes.
> Answer:

## researcher

**RS-1. Source policy.** Internal repo + official docs only, or broader web?
Recommended: official docs + repo first; broader web only when the brief
allows it explicitly.
> Answer:

**RS-2. Brief size cap.** Research output ≤600 words + citations,
structured. Recommended: yes.
> Answer:

## uiux

**U-1. Spec fidelity.** Pixel-level (exact tokens/spacings from the project's
design system) or component-level (name the components, coder fills in)?
Recommended: component-level, with tokens named only where the design deviates
from the design system's defaults. Which design system that is comes from
`factory/policies/stack.yml`, not from this file.
> Answer:

## M. Roster verification (opened 2026-08-05)

> Context: the 12 role templates moved from `.agents/templates/` to
> `.claude/agents/`, where Claude Code registers them as dispatchable
> subagent *types*. One file = one type, dispatched N times concurrently
> with N different prompts — the file is not a mold that emits one subagent
> per worker. Concurrency is now uncapped. That move makes a handful of
> choices load-bearing that were only cosmetic while the files sat inert.
> Every question below cites a fact verified against the files on
> 2026-08-05; answer only where you disagree with the recommendation.

### Model independence

**M-1. Verifier independence.** `verifier` is `sonnet` and its whole job is
to adversarially refute `reviewer` findings — but `reviewer` is also
`sonnet`. Same model on both sides of a refutation means correlated blind
spots: the verifier is most likely to miss exactly what the reviewer
missed. We already enforce this asymmetry one layer up — `spec-reviewer`'s
description says "never runs on the planner's own model" (planner `opus`,
spec-reviewer `sonnet`). Recommended: pin `verifier` off reviewer's model
(→ `opus`), same rule, applied consistently.
> Answer: ✅ Recorded 2026-08-05 — accepted. `verifier` is `opus`/`xhigh`,
> and its description now carries the rule the way `spec-reviewer` does:
> "never runs on the reviewer's own model."

**M-2. Grader independence.** `grader` (`sonnet`) grades `coder` (`sonnet`)
output — the same correlation, one tier down. Unlike M-1 the grader is
rubric-bounded (it checks acceptance criteria, it doesn't reason freely)
and it runs on *every* task, so it is the highest-volume role in the
factory. Recommended: leave `sonnet` — accept the correlation here and buy
independence only at the verifier, where it decides whether a finding is
real.
> Answer: ✅ Recorded 2026-08-05 — accepted. `grader` stays `sonnet`
> (`effort: low`). We buy independence once, where it decides truth.

### Frontmatter that is currently inert

**M-3. Reasoning effort.** Verified: `effort:` is a real subagent
frontmatter key (7 of 31 agents in the official plugin marketplace set it,
values `medium`/`xhigh`). None of our 12 set it, so all 12 inherit the
session default. This is the cheapest quality knob we have and it is
currently unused. Recommended: set it by tier — `xhigh` for planner,
spec-reviewer, verifier; `medium` for coder, tester, reviewer,
security-reviewer, merger; `low` for grader, scribe, researcher, uiux.
> Answer: ✅ Recorded 2026-08-05 — applied, with two roles raised above the
> recommendation. `researcher` and `uiux` go to `medium`, not `low`:
> researcher now holds real web access (M-7) and must judge source quality,
> and uiux renders HDS design judgment rather than formatting. Final table,
> as written into all 12 frontmatters:
>
> | effort | roles |
> | --- | --- |
> | `xhigh` | planner, verifier |
> | `high` | spec-reviewer, security-reviewer |
> | `medium` | coder, tester, reviewer, merger, researcher, uiux |
> | `low` | grader, scribe |
>
> `spec-reviewer` and `security-reviewer` sit at `high` rather than `xhigh`:
> both are bounded scans against a written artifact, not open-ended judgment.
> `verifier` keeps `xhigh` because it is the one role whose output can kill a
> finding outright (M-1).

**M-4. `maxTurns`.** Verified: all 12 of our templates carry `maxTurns`
(15–40), **zero** of the 31 official plugin agents use it, and the Agent
tool's schema exposes no turns parameter. So the key is almost certainly
inert — a turn cap nothing reads. (`scripts/check.sh` only requires
`name`/`description`/`model`/`tools` and tolerates extra keys, so it fails
nothing either way.) Options: (a) delete it · (b) keep it as recorded
intent · (c) keep it *and* restate the turn budget as a line in the
dispatch prompt, where the agent can actually see it. Recommended: (c) —
an inert key is a lie unless the prompt makes it true.
> Answer: ✅ Recorded 2026-08-05 — (c). The key stays as recorded intent;
> the turn budget is now carried into every dispatch by the `/bs` skill's
> "Dispatch contract" section, where the agent can actually read it.

### Topology under uncapped fan-out

**M-5. Who dispatches.** Verified: none of the 12 templates lists `Agent`
in `tools`, so today only the operator session can dispatch anything —
every worker in a wave reports back into one context. Also verified: the
`tools` field supports *scoped* grants like `Agent(coder, tester)`, so
delegation can be handed out per-role without opening the floodgates.
Options: (a) stay flat — operator dispatches all · (b) planner gets
`Agent(...)` and dispatches its own wave · (c) coder gets
`Agent(tester, grader)` and drives its own verification loop.
Recommended: (a) — the operator session is the only place that can emit
`dispatch_decision`/`task-result-recorded` around a call that may die
mid-flight, and nesting hides that failure.
> Answer: ✅ Recorded 2026-08-05 — (a) for now, but the recommendation's
> reasoning was wrong and is corrected here. "Only the operator session can
> emit the lifecycle events" is false: any session with `Bash` and the smith
> CLI can emit them, including a subordinate one. The real invariant is
> **the dispatching node must own the event log for what it dispatches** —
> flat topology was only ever a proxy for it.
>
> That distinction matters because the actual blocker is in the event log,
> not the topology. `factory/orchestrator/src/events.ts` validates
> `causal_parent` only *within* one session's file, `session-start` is the
> only event allowed `causal_parent: null`, and `EventInput` has no
> parent-session field. So a second session cannot record that it was
> spawned by session A's decision at event X — the causal chain silently
> breaks at the session boundary. Until that gap closes, (a) stands: one
> session dispatches, one log, one unbroken chain.
>
> Phase 9 target (two-tier sessions): add an optional
> `parent_event: "<session-id>#<index>"` valid only on `session-start` and
> validated against the parent's log, then split `/bs` into an epic-level
> playbook and a disposable wave-level one. A wave session then owns its own
> log for the workers it dispatches, and the invariant holds at both tiers.
> No role template gains `Agent` before that lands.

**M-6. Return discipline.** With concurrency uncapped, a wave of hundreds
of workers returning prose would drown the operator context before the
gates ever run. Recommended: every worker writes its full result to
`state/results/<task-id>.json` and returns **only**
`{status, severity_counts, artifact_path}` — the orchestrator reads the
file when it needs detail, and a wave of 200 costs 200 short lines.
> Answer: ✅ Recorded 2026-08-05 — return discipline accepted and written
> into the `/bs` skill's "Dispatch contract". **No concurrency cap is
> added**, which reverses nothing: the 2026-08-05 amendment that removed
> `max_parallel_workers` stands.
>
> The reason a cap is the wrong instrument: the operator context is not
> drowned by *how many* workers return at once, it is drowned by the session
> being long-lived across a whole epic — SKILL.md says so itself ("an epic
> outlasts your window"). Under return discipline a wave of 200 costs 200
> short lines, which a cap of 8 would spread over 25 sequential batches at
> the same total context cost and 25× the wall-clock. Capping buys nothing
> and pays for it in latency.
>
> The real fix is disposable per-wave sessions (see M-5): the wave session
> absorbs the returns and dies with them, so the epic-level session never
> accumulates them at all. That is Phase 9 work, gated on the event-log
> `parent_event` change. Until then: return discipline only.

### Tool grants that contradict the role

**M-7. Researcher web access.** `.claude/agents/researcher.md:16` states
its source policy as "internal repo + official docs first; broader web
only when…" — but its grant is `Read, Grep, Glob, Bash`, with no
`WebFetch` or `WebSearch`. A "research brief" can therefore only cite this
repo, or reach the web through `Bash`+`curl`, which is worse: unlogged and
outside any tool policy. Note `guardrails.md` bans outbound *sends*, not
read-only fetches. Recommended: add `WebFetch, WebSearch` and drop the
curl loophole by saying so in the template.
> Answer: ✅ Recorded 2026-08-05 — accepted, and the role's effort was raised
> with it. Grant is now `Read, Grep, Glob, Bash, WebFetch, WebSearch`, and
> the template carries the closing constraint verbatim: reach the web through
> `WebFetch`/`WebSearch` only, never `Bash` — `Bash` here is for reading the
> repo, nothing networked. Read-only fetches are allowed; *sending* anything
> outward stays S1 (`guardrails.md` "deploy/outbound") regardless of
> transport. Because the role now has to judge external source quality rather
> than just quote the repo, its effort went to `medium` instead of the `low`
> M-3 originally recommended.

**M-8. Scribe log access.** `scribe` is granted `Read, Write` only, yet
its description assigns it "the offline 'dreaming' pass over event logs"
and its body has it re-reading events by id on demand. With no `Grep` and
no `Glob` it cannot find an event in `state/events/*.jsonl` — it can only
read a path someone hands it whole, which for a multi-MB log is exactly
the context blowup the role was meant to prevent. Recommended: add
`Grep, Glob` (keep `Bash` out — it has no reason to run commands).
> Answer: ✅ Recorded 2026-08-05 — accepted. Grant is now
> `Read, Grep, Glob, Write`; `Bash` stays out. The template also states the
> access *pattern*, not just the grant: find events with `Grep`/`Glob`, then
> `Read` with an offset only where the full envelope is needed — never
> `Read` a log whole. The grant without the pattern would have left the
> context blowup one habit away.

## N. Per-role contract verification (opened 2026-08-05)

> Context: round M settled *which model each role runs on and what it may
> touch*. This round reads each of the 12 templates against the code that
> will actually consume its output, role by role. Two facts change the
> stakes: `gate.ts:367` validates every worker Result against
> `result.schema.json` **before tests run**, and `findings.ts:167` validates
> every finding against `finding.schema.json` — both schemas are
> `additionalProperties: false`. A template that names the wrong fields does
> not degrade gracefully; it fails the gate with `schema-invalid`. Each
> question below cites a fact verified against the files on 2026-08-05.

### Output contracts (the two blocking ones)

**N-1. Every role that returns a Result — the contract is 8 fields, the
templates name at most 4.** `result.schema.json` requires `task_id`,
`run_status`, `structured_output`, `artifacts`, `token_usage`, `agent`,
`provider`, `model_tier`, and forbids anything else. `coder.md` names four
of them; only `grader.md:40`, `researcher.md:48` and `uiux.md:44` mention
`structured_output` at all; **zero** of the 12 mention `run_status`,
`agent`, `provider` or `model_tier`. As written, wave 1 of the dogfood epic
fails `schema-check-result` before a single test runs.
Two ways to close it, and they are not equivalent:
(a) write the full 8-field contract into all 12 templates, or (b) have the
dispatcher fill the four envelope fields it already knows (`agent`,
`provider`, `model_tier` are in `DispatchPayload`; `task_id` it assigned)
and shrink the agent's job to `run_status` + `structured_output` +
`artifacts` + `token_usage`. (b) is less to get wrong per role and makes
`provider`/`model_tier` observed rather than self-reported — an agent
reporting its own model tier is exactly the field you cannot trust it on.
Recommended: **(b)**.
> Answer: ✅ Recorded 2026-08-05 — accepted, **(b)**. The dispatcher owns the
> envelope (`task_id`, `agent`, `provider`, `model_tier`); the agent returns
> `run_status`, `structured_output`, `artifacts`, `token_usage` and nothing
> else. Self-reported provenance is not evidence, and the dispatcher already
> holds all four in `DispatchPayload`.
>
> Amended 2026-08-08 (P9-17, from D-18/D-35): the line moved by one field.
> `token_usage` is now the dispatcher's too, so the agent returns
> `run_status`, `structured_output` and `artifacts`. The answer above drew
> the line at "self-reported provenance is not evidence" and then left the
> agent a number it cannot measure — wave 2 wrote zeros, wave 3 wrote round
> numbers, and both passed the schema. `stampResultEnvelope` refuses the
> merge if the agent writes any of the five.

**N-2. reviewer / verifier / spec-reviewer / security-reviewer — nobody is
told how to mint a finding.** `finding.schema.json` requires nine fields;
the four judge templates never mention `finding_id`, `fingerprint`,
`finding_status` or `found_by`. `fingerprint` is load-bearing beyond
validation: waiver answers are stored by fingerprint and never re-asked
(`agent-constraints.md:71`), so if each judge invents its own, the same
finding re-asks the operator every epic and the same-mistake escalation
never fires. `failure_scenario` is not a sentence either — it is an object
requiring `{inputs, expected, actual}`; `verifier.md` says only
"failure_scenario filled in". Recommended: judges return the *evidence*
fields (`finding_category`, `severity`, `summary`, the 3-part
`failure_scenario`) and the orchestrator mints `finding_id`,
`finding_status`, `found_by` and computes `fingerprint` by a fixed
recipe — a fingerprint an LLM chooses is not stable across two sessions
looking at the same defect.
> Answer: ✅ Recorded 2026-08-05 — accepted. Judges return evidence only
> (`finding_category`, `severity`, `summary`, the 3-part `failure_scenario`);
> the orchestrator mints `finding_id`, `finding_status`, `found_by` and
> computes `fingerprint` mechanically. A judge-chosen fingerprint would make
> the waiver store and the same-mistake rule both unreliable, and those are
> the two mechanisms that keep the operator from being re-asked.

**N-3. The severity strings in every template are not the taxonomy's.**
Canonical values are `S1-stop-the-line`, `S2-major`, `S3-minor`, `S4-nit`
(`taxonomy.yml:108`, enforced via `x-taxonomy`). A grep for those four
strings across `.claude/agents/*.md` and `docs/standards/*.md` returns
**nothing** — the templates and the severity table in
`agent-constraints.md:64-68` all write bare "S2"/"S3". Mechanical fix
(rewrite the strings) or contract fix (judges emit `S2` and the
orchestrator expands to the canonical value)? Recommended: **rewrite the
strings** — one enum, spelled one way, everywhere; an expansion layer is a
second place for the mapping to rot.
> Answer: ✅ Recorded 2026-08-05 — accepted. Canonical strings written out in
> full everywhere: the four judge templates and the severity table in
> `agent-constraints.md`. No expansion layer.

### Per-role gaps

**N-4. coder + grader — two loop bounds that nothing counts.**
`agent-constraints.md:176` says "after 2 failed rounds on a task, escalate
coder sonnet → opus **automatically** (logged); after 3, escalate to
operator", and `:86` gives the grader "**max 2 rounds**". Neither round
counter exists: `coder.md` pins `model: sonnet` and never mentions
escalation, the `/bs` dispatch playbook does not count rounds, and nothing
persists a per-task round number between dispatches. The Agent tool's
`model` parameter makes the escalation mechanically possible today — what's
missing is the counter and the decision. Recommended: derive the round
count from the event log (`dispatch_decision` events for the same
`task_id`) and put both ladders in the `/bs` dispatch contract, where the
dispatcher can read them. Is that the right host, or should it wait for the
phase-9 loop daemon?
> Answer: ✅ Recorded 2026-08-05 — accepted, with an explicit token
> constraint. Round count is derived from `dispatch_decision` events for the
> same `task_id`; both ladders live in the `/bs` dispatch contract now rather
> than waiting for the daemon. **Token discipline:** the opus escalation is
> the expensive branch and fires only after *two failed* rounds — never as a
> default, never on a first attempt, and logged when it does. The grader's
> 2-round cap is enforced as a hard stop for the same reason: it bounds
> spend, not just quality.

**N-5. coder + tester + researcher — `research-request` is not an event
type.** It appears in `coder.md:40`, `tester.md:37`, `researcher.md:3` and
`:40`, `black-smith-architecture.md:687` and `agent-constraints.md:45`. The
event types that exist are `dispatch_decision`, `task-result-recorded`,
`error-logged`, `session-start` — and nothing else
(`agents-registry.ts:26-29`). It also now collides with the dispatch
invariant settled in M-5: a worker does not own the event log, so it cannot
emit anything into it. So what does a coder actually do when it hits an
unknown? Recommended: it stops and returns `run_status: done` with the
request in `structured_output` (a `research_request` field); the dispatcher
reads it and dispatches the researcher. That keeps the "don't wander the
repo" discipline the constraint was written for, without inventing an event
type. Confirm, or should this become a fifth real event type?
> Answer: ✅ Recorded 2026-08-05 — accepted; **no fifth event type**. The
> worker stops and returns a `research_request` field in
> `structured_output`; the dispatcher reads it, dispatches the researcher,
> and re-dispatches the worker with the brief attached. **Token discipline:**
> the worker must commit its partial work before returning, so the
> re-dispatch resumes instead of redoing — a research-request that throws
> away a half-finished task pays for the same tokens twice. All six
> `research-request` references are rewritten to say this.

**N-6. tester + reviewer + uiux — the screenshots have no reader.** The
tester captures desktop + mobile, light + dark per UI-affecting task
(`agent-constraints.md:56-57`); the reviewer's S3 table lists "visual
regression vs HDS"; uiux writes the HDS spec the screenshots would be
judged against. But neither `reviewer.md` nor `uiux.md` says to open those
artifacts, and the review gate is described as diff + blast radius. Either
visual regression is a severity class nobody can raise, or one of the two
gets an explicit "read the screenshot artifacts against the uiux spec" step.
Recommended: give it to the **uiux** role as a post-test dispatch on
UI-affecting tasks only — the reviewer is already the highest-volume judge
and this is the one lens that needs the spec's author.
> Answer: ✅ Recorded 2026-08-05 — accepted, uiux owns it. **Token
> discipline:** this is an extra dispatch per UI task, so it is gated three
> ways — the task must be UI-affecting, screenshot artifacts must exist, and
> a uiux spec must exist for the epic. Any one missing, no dispatch. The
> uiux pass reads the spec and the images only, never the diff; the diff is
> already the reviewer's job and re-reading it here would double the cost of
> the most expensive input in the task.

**N-7. security-reviewer — trigger 1 has no evaluator.** Dispatch is
conditional on "claims intersect sensitive paths (auth/session/secrets/
crypto/input-parsing/network boundary)" (`:91-94`). Nothing computes that
intersection: there is no sensitive-path list in `factory/policies/`, and
the `/bs` playbook defers to the role's own description. So trigger 1 is an
operator's memory, and the failure mode is silent (the role simply never
runs). Triggers 2 and 3 are checkable — `case: infra` is a taxonomy value,
and a scheduled recheck is a case type. Recommended: put the sensitive-path
globs in `factory/policies/` as data, so the wave playbook can test a task's
claims against them the same way the claim graph is computed.
> Answer: ✅ Recorded 2026-08-05 — accepted. Sensitive-path globs become data
> in `factory/policies/`, tested against a task's claims with the same glob
> machinery as the claim graph. **Token discipline:** this is the cheapest
> answer available — a glob test costs zero tokens, whereas the only other
> way to make trigger 1 reliable is dispatching the security-reviewer on
> every task and letting it decide it wasn't needed.

**N-8. security-reviewer — its lesson scope does not exist.**
`security-reviewer.md:43` carries `<!-- LESSONS:security -->`. Valid scopes
are `agent-role`, `claim-path`, `case-type`, `stack-wide`
(`lessons.ts:158`, `taxonomy.yml:126`). `security` is none of them, so this
role's lesson block can never be populated — silently, forever, with no
error anywhere. Recommended: `agent-role`, matching the other four judges.
The alternative reading is that security lessons *should* be their own
scope (they cut across roles: a coder and a reviewer want the same auth
lesson) — if so, this is a taxonomy addition, not a template typo. Which?
> Answer: ✅ Recorded 2026-08-05 — **add the scope**. `security` joins
> `lesson_scope` in `taxonomy.yml` and `VALID_SCOPES` in `lessons.ts`. The
> cross-role reading is the right one: an auth lesson is wanted by the coder
> writing the handler, the reviewer reading it and the security-reviewer
> auditing it — collapsing it to `agent-role` would have delivered it to one
> of the three.

**N-9. All 12 — nothing reads the `LESSONS` markers at all.** Every
template carries one, `lessonsForScope()` exists and is tested
(`lessons.ts:328`, `lessons.test.ts:290-327`), and it has **zero**
production callers; a grep for `LESSONS:` outside `.claude/agents/` finds
nothing. Correction to the framing this question was first written with:
`lessons.md` is **not** a dead end — `gate run --lessons`
(`cli.ts:320` → `runGate`) parses it and feeds it to `severity.ts`'s
same-mistake match, which escalates a repeat finding one level. So the loop
punishes a repeated mistake; what it never does is *prevent* one, because no
lesson text reaches an agent's context before the agent works. That is the
half that is missing, and it is the half the factory's premise rests on.
It needs a decision on *where* injection happens, and there are only two
options: the dispatcher splices lessons into the prompt at dispatch time
(works today, flat topology, one host), or the templates are rendered
per-dispatch from a source file plus the lesson set (more faithful to the
marker, needs a render step that does not exist). Recommended: **splice at
dispatch**; the markers become documentation of where the text lands.
> Answer: ✅ Recorded 2026-08-05 — splice at dispatch, **and only approved
> lessons**. The operator reads every candidate and approves it before it can
> ever reach an agent's prompt; nothing auto-promotes. The approval gate is
> already half-built and the missing piece is small: `lesson_status` is
> carried by the `lesson-status-changed` event (`events.ts:167`), projected
> to the DB (`projector.ts:464`, default `candidate`), and
> `queries.ts:1039` already filters `approved` for `lessons compile`. What
> does not exist is the operator's verb — `cli.ts` has `lessons candidates`
> and `lessons compile` and nothing that moves a candidate to `approved`, so
> **no code path anywhere sets that status and `lessons compile` writes an
> empty file today**. Phase 9 lands three pieces in order: (1) a
> `smith lessons approve/reject <lesson-id>` verb emitting
> `lesson-status-changed`, (2) a review surface for the weekly batch, (3)
> injection at dispatch, reading only the compiled `lessons.md` — which by
> construction contains approved lessons only.

**N-10. grader, reviewer, verifier, spec-reviewer, security-reviewer, uiux,
researcher — "read-only" is prose, not a grant.** All seven say read-only
in their bodies (`reviewer.md:13` "read-only tools only", `grader.md:15`
"you grade, you never edit code") and all seven hold `Bash`, which writes:
`echo >`, `sed -i`, `tee`, `python -c`. `guard.sh` blocks destructive git
and `rm -rf` outside `workspaces/`/`state/` — it does not block file
writes. Dropping `Bash` is not free: the reviewer needs `git diff`, the
grader and testers' judges need to run the suite. Recommended: keep `Bash`,
change the wording from "read-only tools" to "you never modify the
worktree", and add a guard rule that blocks writes from judge sessions
rather than trusting the sentence. Or is prompt-level enough until the
phase-9 daemon?
> Answer: ✅ Recorded 2026-08-05 — accepted. `Bash` stays (a reviewer that
> cannot run `git diff` is useless); the wording changes from "read-only
> tools" to "you never modify the worktree", which is the property actually
> wanted; and a guard rule enforces it rather than the sentence.
> Shipped 2026-08-26: `judge-network`, `judge-write` and
> `judge-sandbox-escape` in `factory/policies/guardrails.yml`, scoped to one
> worktree by a lease the orchestrator opens (`smith sandbox open`) and the
> judge itself is refused the verbs to lift. Six of the seven; `researcher`
> stays outside it, because fetching is its job and it fetches through
> `WebFetch`/`WebSearch` rather than `Bash`.

**N-11. planner + scribe — unbounded `Write`.** coder and tester write only
inside their claimed globs, and an out-of-claim edit fails the gate with
`contract.claim-violation`. planner (`Write` for plan JSON + the living
spec) and scribe (`Write` for lesson candidates + PR bodies) have no claims
at all and no path prefix stated in either template. Recommended: state the
write roots in the templates — planner to `factory/specs/active/<epic>/`,
scribe to `state/lessons/` and PR-body scratch — and treat anything outside
as the same class of violation once there is a host to check it.
> Answer: ✅ Recorded 2026-08-05 — suggestion requested; here is the concrete
> one. **Why it matters:** coder and tester write inside a worktree and a
> stray edit is caught by `postRunCheck` (`claims.ts:227`) as
> `contract.claim-violation`. The planner has neither — it runs against the
> live repo checkout with no worktree and no claims, so a stray write lands
> straight in the operator's working tree and nothing ever looks at it. It is
> also the role most likely to make one: it reads widely to plan, so it is
> one bad inference away from "fixing" a file it only meant to read.
> **The fix, in three parts:**
> 1. Declare write roots as claims — reusing the existing concept, not a new
>    one: planner → `factory/specs/active/<epic-id>/**`; scribe →
>    `state/lessons/**` plus its PR-body scratch path.
> 2. Check them with existing machinery. `postRunCheck` cannot be reused
>    verbatim: it derives the integration branch from a
>    `smith/<epic>/<task-id>` branch name and diffs `integration...HEAD`, and
>    the planner has neither. So split it — leave the diff collector where it
>    is, extract the classifier (changed files + globs → in/out of claim +
>    `contract.claim-violation`), and add a second collector reading
>    `git status --porcelain` at the repo root. planner and scribe then fail
>    the same way a coder does, for ~20 lines and no new vocabulary.
> 3. Interim that works today with zero code: the `/bs` playbook snapshots
>    `git status --porcelain` before and after the planner dispatch and fails
>    on any path outside the root.
> Parts 1 and 3 land now; part 2 is phase-9 work.

**N-12. merger — which worktree?** `guardrails.md` says "no destructive git
ops outside a worker's own worktree". coder and tester get
`workspaces/<project>/wt/<task-id>`. `merger.md` says only that it operates
on the task branch merging into `smith/<epic>/integration`, and it holds
`Edit, Write, Bash` — the same write grant as a coder, with no worktree, no
claims, and by construction a conflicted tree touching both sides of a
merge. It is the one role that resolves a conflict by editing files it was
never assigned. Recommended: give the merger a dedicated worktree per queue
admission (`workspaces/<project>/wt/merge-<task-id>`), so the guardrail
sentence is true for it too and a failed resolution is thrown away with the
directory.
> Answer: ✅ Recorded 2026-08-05 — suggestion requested, and the
> recommendation above is **withdrawn**: a dedicated merge-worktree is not
> needed, because `queue.ts` already does most of this. The rebase runs in
> the task's **own** worktree (`queue.ts:77-78`), and `conflictingFiles()`
> (`queue.ts:55`) already computes the exact conflicted file list and returns
> it in the `rebase-conflict` outcome. So:
> 1. **Worktree:** dispatch the merger with the task's existing
>    `worktreeDir`. The guardrail sentence becomes true for it at no cost —
>    there was never a missing tree, only a missing dispatch parameter.
> 2. **Claims:** the merger's claim set *is* `conflictingFiles`, already
>    computed. An edit outside it fails exactly as a coder's would. This is
>    what makes its `Edit, Write` grant defensible.
> 3. **Replay:** `queue.ts:83` runs `git rebase --abort` before returning, so
>    the conflict is gone by dispatch time. Keep the abort — a tree left
>    mid-rebase when a dispatch dies is the worse failure — and have the
>    dispatch contract tell the merger to replay `git rebase <integration>`
>    to materialise the conflict it was called for.
> 4. **The merger never lands the merge.** It resolves, runs
>    `git rebase --continue`, and returns. The task re-enters the queue from
>    the top so tests and gates run on the *resolved* tree. Without this a
>    merger-resolved semantic conflict reaches integration with no gate
>    between it and the operator — the real danger in this role, more than
>    the missing worktree was.
> 5. **Escalation:** on a semantic conflict the merger runs
>    `git rebase --abort` and returns `escalate`. The tree is back to a known
>    state and nothing is lost.

## Calibration schedule (v3.1 — when these interviews get re-run)

Interviews are re-answered against evidence, not the calendar alone:

1. **First real-data checkpoint** — right after the first full epic flows
   through Phase-5 analytics: review per-agent kill-rate, same-mistake
   rate, bounce rate, and budget-exceeded counts; re-answer any row the
   data contradicts.
2. **Trigger-based** — an agent whose same-mistake rate rises, or whose
   findings are >50% refuted by the verifier for two consecutive epics,
   gets a targeted re-interview immediately.
3. **Steady state** — the weekly lesson review doubles as a 5-minute
   quality glance; a full re-interview (diff + recompile of the
   standards) every quarter or every ~10 epics, whichever comes first.
