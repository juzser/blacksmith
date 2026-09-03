# Dogfood findings — epic `envkit-config-loader`

What the factory actually did when pointed at a real greenfield project, as
opposed to what its docs say it does. Every item below was observed in this
session, not inferred.

This is the **raw evidence log**, kept in the order the findings were hit and
in the words they were written in at the time. The distillation an implementer
should work from is `docs/specs/phase-9-punch-list.md` § "From the
`envkit-config-loader` dogfood" — items P9-8…P9-23 there each cite the D-number
they came from and this file holds the repro.

The run: `smith new envkit` → a six-task plan → four waves. Three waves
merged; wave 3 half-merged and wave 4 never started, because of D-39. That is
itself the headline result — the factory got a real epic most of the way home
and then deadlocked on a defect it has no vocabulary for.

Status legend: **confirmed** = reproduced with a command in-session ·
**observed** = seen once, no isolated repro · **open** = stated but unverified.

---

## D0 — `smith` has no usage output — confirmed

```
$ node factory/orchestrator/dist/cli.js
{"error":{"message":"Unknown command: "}}
$ node factory/orchestrator/dist/cli.js --help
{"error":{"message":"Unknown command: "}}
```

Every command's argument shape has to be read out of `cli.ts` or `SKILL.md`.
This cost real time in this session (see D5b) and it is the single cheapest
thing on this list to fix.

**Fix:** a `usage` branch listing `<ns> <action>` pairs and their positional/flag
shape. Exit 0 for `--help`, exit 1 with the same text for an unknown command.

---

## D1 — role templates are not dispatchable, so the model guarantee is unenforced — confirmed (structural)

`.claude/agents/` does not exist. The twelve role contracts live in
`.agents/templates/<role>.md` and are read *as prose by whoever remembers to
read them*. Their frontmatter — `model:`, `tools:`, `maxTurns:` — is inert.

Consequence, and it is the important one: the asymmetric-review rule
("spec-reviewer must be a different model than the planner") has **no mechanical
enforcement anywhere in the factory**. In this session it held only because the
operator session passed `model: sonnet` by hand on every spec-reviewer dispatch
against an opus planner. An operator who forgets gets same-model review and
nothing anywhere says so.

**Fix candidates:** (a) generate `.claude/agents/<role>.md` from the templates so
roles are dispatchable by name and frontmatter is honoured; or (b) if dispatch
stays skill-guided, have the dispatching command record the model per role in the
event log and let a gate assert planner-model ≠ reviewer-model.

**Status: fixed (a), 2026-08-05, PR #19** — the 12 templates now live in
`.claude/agents/` and are dispatchable by name, so `model:`/`tools:`/`effort:`
are honoured by the harness. Roster verified through interview M-1…M-8
(`docs/specs/agent-interviews.md`). Note (b) is *not* covered: nothing yet
asserts planner-model ≠ reviewer-model in the event log — that assertion stays
open for Phase 9.

---

## D2 — "claims from static analysis" is undefined on greenfield — confirmed

`budgets.yml` `effort_scaling` requires that fan-out happen "only when claims are
disjoint per static analysis (architecture §5)". On a scaffold with one source
file the import graph is one node and zero edges. Every claim in this plan was
authored by the planner from the spec, then checked mechanically for *overlap*
by `wave check` — which is a disjointness check, not static analysis.

Not a defect in this epic (the overlap check is the part that matters and it
works — see D8). It is a documentation defect: the rule as written cannot be
satisfied on a new repo, so it reads as satisfied-by-vacuum.

---

## D3 — the scaffold cannot run its own gates — confirmed

`smith new` produces a project that declares an 80 % coverage floor and ships:
no `pnpm-lock.yaml`, no `node_modules`, and no `@vitest/coverage-v8` in
`package.json`. The first thing any epic in a fresh project must do is a serial,
non-parallelisable toolchain task before any feature work can be dispatched.

That is exactly what happened here: `task-0-toolchain` exists solely to make the
gates runnable, it claims `package.json` + `pnpm-lock.yaml` + `vitest.config.ts`,
and because those are hot files every other task depends on it. Wave 1 is one
task wide for reasons that have nothing to do with the epic.

**Fix:** the scaffold should ship a lockfile and the coverage provider, or
`smith new` should run the install itself. Either way the cost belongs to
scaffolding, not to the first epic's budget.

---

### D3a — the scaffold's CI cannot pass as shipped — confirmed

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` and no
lockfile is committed (`git ls-files` in `workspaces/envkit` lists eight files,
none of them `pnpm-lock.yaml`). The first PR out of any epic therefore red-CIs
on step one unless that epic happens to create the lockfile. Here `task-0`
does, by accident of being a toolchain task — a feature-only epic would not.

Same root cause as D3, listed separately because it fails in a different place
(CI, on the PR) and would be diagnosed as a CI problem rather than a scaffold
problem.

### D3b — CI never runs coverage — confirmed

`ci.yml` runs `lint`, `typecheck`, `test`, `build`. It does not run
`test:coverage`. The 80 % floor — the one this epic spends a whole serial task
making per-file (D11) — is enforced **only** by the factory's own test gate
invoking `pnpm test:coverage`, never by CI on the PR. `task-0` is explicitly
forbidden from touching `ci.yml` (its AC-10), which is the right call for task
scope and leaves the gap open at the scaffold level where it belongs.

Also: `ci.yml`'s `push: branches: [main]` trigger can never fire in a repo whose
only branch is `setup` (D4). Cosmetic today, wrong after any rename.

**Status: fixed (D3, D3a, D3b), 2026-08-08, branch
`smith/phase-9/p9-19-scaffold-gates`** — `smith new` now installs and runs the
project's own gates in `ci.yml`'s order before it commits, so the lockfile is in
the scaffold's first commit and `--frozen-lockfile` has something to check; the
scaffold ships `@vitest/coverage-v8` and a `test:coverage` script, and CI runs
`test:coverage` in place of `test`. Reproducing D3 found it was worse than
written: install could not run *at all* under `workspaces/`, because pnpm walked
up to black-smith's own `pnpm-workspace.yaml` and failed with
`ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION` — the scaffold now carries its own
`pnpm-workspace.yaml` with `packages: ['.']`. Separately, a `--ui` scaffold
could not meet its own 80% floor on a clean tree (50% lines, `src/main.ts`
counted but unloadable in a node test); coverage now excludes the Vite mount
entrypoint and ambient declarations. Full write-up in P9-19 of the punch list.

---

## D4 — `smith new` leaves the project on branch `setup` — confirmed

```
$ git -C workspaces/envkit branch -a
* setup
$ git -C workspaces/envkit log --oneline
abbe7eb Initial scaffold from black-smith (docs/standards/stack.md)
```

There is no `main`/`master` in `workspaces/envkit` — one branch, one commit. The
integration branch will be cut from `setup`. Nothing has broken yet; flagged
because the merge queue and the integration-PR step have not run against this
shape before, and because `guardrails.md` reasons in terms of `main`/`master`
being untouchable — a repo with neither is outside the case the guardrail was
written for. It is also why D3b's `push: branches: [main]` trigger is dead.

**Status: addressed, 2026-08-08, branch `smith/phase-9/p9-19-scaffold-gates`** —
the scaffold still creates `setup`, deliberately: renaming it to `main` would
put every project's first push on the branch `guardrails.md` calls untouchable.
What changed is that `ci.yml` now triggers on `[main, setup]`, so the workflow
fires over the scaffold's whole life rather than only after the first merge —
the dead trigger is live, and a later rename to `main` keeps working.

---

## D5 — two ambiguities that cost time

**D5a — the plan-immutability boundary is ambiguous.** `writePlanFile()` refuses
to overwrite an existing plan file, but only on the `nextVersion()` path;
`validatePlan()` has no opinion. The `/bs plan` playbook writes the plan at
step 7, *after* review — yet a planner session naturally writes it at step 2 and
then has to edit it as review lands. Resolved here by editing `plan-v1.json` in
place across three rounds, which is legal because no `plan-version-created` event
has been logged and therefore nothing has admitted v1. Worth stating explicitly
in the playbook: **a plan file is mutable until its `plan-version-created` event
exists, and immutable after.**

**D5b — not a factory defect.** The operator session's first `plan validate` and
`wave check` invocations used `--epic/--plan-version/--tasks` flags that neither
command accepts; both failed with a `path` TypeError. `SKILL.md:102` and
`SKILL.md:118` document the positional form correctly. Operator error, recorded
so it is not miscounted as a finding — though it would not have happened if D0
were fixed.

---

## D6 — `plan validate` does not validate edge dimensions — confirmed, reproduced twice

`taxonomy.yml:166-168` declares:

```yaml
edge:
  - edge_type
  - edge_provenance
```

under `rules.required_dimensions`. A plan carrying

```json
{ "edge_type": "NOT-A-REAL-EDGE-TYPE", "edge_provenance": "NOT-A-REAL-PROVENANCE" }
```

validates clean:

```
$ node factory/orchestrator/dist/cli.js plan validate <bogus-plan>.json
{"valid":true}
exit=0
```

`validatePlan()` (`factory/orchestrator/src/plan.ts:144-154`) checks only that
each edge's `task` and `dependsOn` name real tasks. The declared dimensions are
never looked up in the taxonomy. Reproduced independently by the planner session
and by the operator session on a scratch copy of the plan.

**Why it matters here specifically:** the `task-1a`→`task-1b` serialisation is an
`edge_type: "claim-order"` edge. It is correct because it was *read* and because
`wave check` independently refuses to co-schedule the pair — not because anything
confirmed the edge type is a real vocabulary value. A typo there would be silent.

**Fix:** validate every edge's `edge_type`/`edge_provenance` against
`taxonomy.yml` inside `validatePlan()`, same as task specs already get via
`validateRecord()`.

---

## D7 — the factory ships no per-task output schemas — confirmed

`result.schema.json` requires `structured_output` and defines it as a bare
`{"type":"object"}`, described as "Task-specific payload; shape is defined by the
task spec's output_schema_ref, not by this envelope." But
`ls factory/specs/schema/` returns only `event`, `finding`, `judge-verdict`,
`lesson`, `result`, `task-spec` — **there are no per-task schemas at all**, so
every `output_schema_ref` a planner writes points at nothing and every
`structured_output` passes.

Raised by the spec-reviewer as a plan finding; adjudicated as a factory gap
instead — the plan cannot fix an absent schema directory, and the planner was
told to change nothing.

---

## D8 — what worked, verified rather than assumed

Recording these because a punch list of only failures misrepresents the run.

- **Claim-overlap detection works, and fails closed.** `wave check` on the two
  tasks that share `src/parse.ts` correctly refused, exit 1, naming both
  offending globs (`src/parse.ts`, `test/parse.test.ts`). This was run as a
  deliberate negative test, not observed in passing.
- **Both legal waves check clean** (`task-1a`+`task-2`, `task-1b`+`task-3`),
  exit 0.
- **The asymmetric review found real defects.** Two sonnet spec-review rounds
  against the opus planner returned 4 blocking S2s each; every one was verified
  against the file text before adjudication, and one round-2 concern was
  *withdrawn by the reviewer itself* on inspection ("not actually
  underspecified, contrary to the concern in the brief") — the loop corrects in
  both directions, which is the point of it.
- **The 400-line cap did its job — *as a prompt*.** Two independent sessions
  concluded the original `task-1-parse` could not fit (planner's own worry;
  reviewer's `fits_in_400: false` at a 450–570 line estimate). The
  policy-sanctioned response — split at spec time with a `claim-order` edge —
  was taken instead of a budget waiver, which is exactly what `budgets.yml`
  says should happen. **Correction after D12:** this worked because two agents
  read the policy and honoured it, *not* because anything enforced it. Nothing
  in the factory measures a diff against that cap. Read this as evidence that
  the written policy is clear enough to be followed, which is real but is not
  the same claim as "the cap did its job".

---

## D9 — the plan-quorum budget trigger under-measures the epic — confirmed

`crosscheck.yml` fires trigger 1 when
`sum(plan.tasks[].budget.tokens) >= budget_ratio(0.5) * epic.cap_tokens(2M)`,
i.e. at 1,000,000. This plan's task budgets sum to **545,000** — 27 % of the cap.
The trigger does not fire.

But the *epic* does not cost 545,000. Coder budgets are the only thing the
trigger can see; the planner's own tokens, three spec-review rounds, and three
judges per task on six tasks are all invisible to it. The worst-case projection
for this epic is **~1,635,000 — past `budgets.yml`'s 1.4M alarm ratio** — while
the trigger reads 27 % and stays quiet.

So the one automated check meant to catch "this plan is too expensive" is
structurally incapable of seeing the cost that actually breaches the alarm. It
measures the smaller half of the bill.

**Fix:** either compute the trigger against a projected total (task budgets +
judge fan-out × tasks + planning overhead), or rename the trigger honestly to
`coder_budget_ratio` and add a separate projected-epic-cost trigger. Today it
reads as an epic-budget guard and is not one.

*(Recorded as a prediction before running `smith plan quorum`. The run confirmed
it: trigger 1 did not fire.)*

---

## D10 — in the shipped configuration `plan quorum` leaves no audit trail — confirmed

The run:

```
$ smith plan quorum --epic envkit-config-loader --plan-version 1 \
    --session dogfood-envkit-1 --causal-parent dogfood-envkit-1#0 \
    --confidence 0.85 --actor operator
{"outcome":"endorsed", ..., "triggers":[ 6 security triggers ]}
exit=0
```

Six triggers fired — one `case: infra` arm (task-0) and five `credential`/
`secret` keyword arms (every other task). Then:

```
$ cat state/events/dogfood-envkit-1.jsonl
#0 session-start   actor=operator   parent=None
```

**Zero events.** `planQuorum.ts:425-429` returns early when
`enabledExternalProviders()` is empty, before the step-5 emit at line 489
("emit exactly once, for any case that actually ran a quorum"). This is
deliberate and documented in the module header. The consequence is not.

Both external providers ship `enabled: false` in `crosscheck.yml`, so **the
zero-provider path is the only path the factory can currently take**. In its
shipped configuration `smith plan quorum` is a no-op that returns exit 0 and
writes nothing. An operator reading the event log later cannot distinguish
"quorum ran, six security triggers fired, endorsed by default because no
provider was enabled" from "nobody ever ran the quorum". The event log is the
declared source of truth (architecture §7) and it holds no record of either.

`SKILL.md:93-96` already tells the operator to say plainly that a trigger fired
without a cross-provider check — so the *human* protocol covers this. The
machine record does not.

**Fix:** emit the quorum-decision event on the zero-provider path too, carrying
the fired triggers and an explicit `endorsed_by: "default-no-provider"` rather
than silently returning. The distinction between "checked and endorsed" and
"nothing checked it" is exactly what an audit trail is for.

---

## D11 — `coverage.thresholds.perFile` on the pinned vitest — RESOLVED at wave 1

The whole per-file coverage guarantee for this epic rested on `perFile` existing
and behaving in vitest 4.1.10. With no `node_modules` and no network this could
not be checked at plan time. `task-0` was therefore contracted to **prove it
differentially** — create a deliberately under-covered file under `src/`, observe
`pnpm test:coverage` fail *naming that file*, capture the output verbatim, delete
it, re-run green — and to stop with `execution.env-failure` rather than silently
shipping aggregate thresholds if the probe did not fail.

**Resolution: `perFile: true` is honoured on vitest 4.1.10 + @vitest/coverage-v8
4.1.10.** But the coder's proof was very nearly vacuous and its stated reasoning
is wrong. With the probe present the *aggregate* was 50% (1/2) — itself under the
80% bar — so a global-aggregate config would have failed the probe run too. The
coder's claim that "an aggregate threshold could not fail this way while the
well-covered `src/index.ts` remains at 100%" does not follow.

The grader settled it empirically with an A/B in a scratch copy of the repo:

- **with `perFile: true`** → `ERROR: Coverage for lines (0%) does not meet global
  threshold (80%) for src/__coverage-probe.ts` — the probe's *own* 0%, with a
  path suffix.
- **with `perFile` removed**, identical probe → the run *also fails*, but reads
  `ERROR: Coverage for lines (50%) does not meet global threshold (80%)` — the
  blended aggregate, **no path suffix**.

So the differentiator is the *percentage attributed and the path suffix*, not the
fact of failure. The proof holds; the coder's reasoning about why it holds did
not. Criterion 7's literal text ("fails naming that file") is satisfied.

**The transferable lesson is about acceptance-criteria design, not about vitest.**
A criterion of the form "do X and observe it fail" is only evidence if the
failure is *impossible* under the null hypothesis. Here the null (aggregate mode)
produced a failure too, and the criterion's author (me, at plan time) did not
notice. A differential criterion must name the *distinguishing signal in the
output*, not just the exit code — otherwise it grades as passed on a run that
proves nothing. Candidate rule-lesson for the planner/spec-reviewer templates:
*"a differential acceptance criterion must state what the failing output says
under the hypothesis AND under the null; if the two are the same text, the
criterion is vacuous."*

---

## D12 — `budgets.yml` says "enforced mechanically by the loop runner"; almost none of it is — confirmed

`budgets.yml:3-4` opens with: *"Token/turn/concurrency caps per tier … Enforced
mechanically by the loop runner."* Repo-wide grep for consumers, excluding
`node_modules`, `dist/` and tests:

| field | value | runtime host |
|---|---|---|
| `epic.cap_tokens` | 2,000,000 | **yes** — read once, by the plan-quorum budget trigger, and only as `sum(declared task budgets)`, never actual spend (D9) |
| `epic.alarm_ratio` | 0.7 → 1.4M | **no** — parsed into `BudgetPolicy`, asserted in `budgets.test.ts`, and read by no production path. Its only real host is `SKILL.md:200`, an instruction to a human |
| `task.coder.cap_tokens` | 150,000 | **no** — nothing reads it |
| `task.coder.cap_diff_lines` | 400 | **no** — `diff_lines`/`diffLines` appears **zero times** in `factory/orchestrator/src/`. Every `git diff` in the orchestrator is `--name-only`; nothing counts a line anywhere |
| `task.researcher` / `task.judges` caps | 60k / 40k tokens | **no** — and the near-miss is instructive: there *is* a `DEFAULT_JUDGE_BUDGET` at runtime (defined three times over, in `gate.ts:125`, `epic.ts:188`, `planQuorum.ts:257`), but it is `{timeout_ms: 120_000, max_output_bytes: 262_144}` — a wall-clock-and-response-size budget. No token cap for any judge exists in code |
| `concurrency.max_parallel_workers` | 8 | **no** — the string occurs once in the repo: in the policy file itself |
| `pre_code_budget`, `context_window`, `escalation_ladder` | — | **no** — prompt-level only, as `context_window`'s own comment admits ("mechanical with the phase-9 loop daemon") |

`budgets.ts`'s module header is honest about this — *"only `epic.cap_tokens` is
modeled … nothing else in budgets.yml is read anywhere yet."* The header of
`budgets.yml` is not. Two files in the same policy directory make opposite
claims about the same data, and the wrong one is the one an operator reads first.

**Why this matters beyond a doc fix.** Every budget number in a plan is a
declaration of intent, not a limit. At sign-off the operator is being shown
`budget: {tokens, diff_lines, max_turns}` per task; nothing will stop a worker
from exceeding any of them, and no event records that it did. The 1.4M alarm
that would otherwise be the natural guard on this epic's ~1.6M projection is an
eyeball rule, not a trip-wire. This also downgrades one D8 win: the 400-line cap
held because two agents read the policy and obeyed it, not because it was
enforced.

**Fix (Phase 9, ordered by value):**
1. Correct the `budgets.yml` header to say what is enforced today and what is
   prompt-level. One line, no code, removes a false guarantee.
2. Measure and record: have the merge queue capture `git diff --numstat` per
   task and emit the real diff size and token spend into the event log. This is
   cheap and turns every cap from unenforceable into at least *auditable* —
   which is also what D9 needs to compare declared budgets against actual spend.
3. Only then enforce, once there is data on what real tasks actually cost.

---

## D13 — the event log cannot express a cross-session causal edge, so the orchestrator cannot be split — confirmed (structural)

Surfaced by the roster interview (M-5/M-6), not by the envkit run, but it is the
same class of finding and it gates the fix for a real Phase 9 problem.

`/bs`'s own SKILL.md admits "an epic outlasts your window". The natural fix is
two-tier sessions: an epic-level session that plans and signs off, dispatching
*disposable per-wave sessions* that absorb their workers' returns and die with
them. The epic session then never accumulates a wave's worth of context at all.

That is blocked in `factory/orchestrator/src/events.ts`:

- `causal_parent` is validated only against events in the *same* session's log
  (`readEventsAtPath(filePath, input.session_id)`);
- `session-start` is the only event type allowed `causal_parent: null`;
- `EventInput` has no parent-session field at all.

So a wave session literally cannot record that it was spawned by the epic
session's decision at event X. Its log starts as an orphan and the causal chain
— the thing the event log exists to preserve — breaks silently at every session
boundary. This is also why no role template is granted `Agent` today: nesting
dispatch under an agent would break the same chain in the same place.

**Fix (Phase 9), smallest change that works:**
1. Add an optional `parent_event: "<session-id>#<index>"` to `EventInput`,
   accepted **only** on `session-start`, validated against the parent session's
   log. The cheap same-session `causal_parent` invariant is untouched; exactly
   one cross-session edge becomes expressible.
2. Split `/bs` into an epic-level playbook and a disposable wave-level one, so
   each tier owns the log for what it dispatches (the actual invariant — "flat
   topology" was only ever a proxy for it).
3. Only then consider scoped `Agent(...)` grants on role templates.

Until (1) lands: flat topology, and return discipline
(`{status, severity_counts, artifact_path}`) as the sole context control. No
concurrency cap — a cap pays the same total context cost spread over N batches
and buys latency with it.

**Status: step 1 fixed, 2026-08-08, branch `smith/phase-9/p9-7-cross-session`;
steps 2-3 open** — the cross-session edge shipped, arriving as `causal_parent`
itself rather than as the separate `parent_event` key sketched above: a
`session-start` may name a parent in another session's log, any other event
type naming one is `events.cross-session-parent-not-root`, and the read side
grew `sessionLineage` behind `smith event lineage <session-id>` and `smith
event tail <session-id> --lineage`. `smith session start <session-id>
[--continues <event-id>]` is the verb that writes the root (2026-09-03, PR
#66); before it the only way to open a log was to hand-append the root, which
is why the edge sat unused for a month. Step 2 has not started —
`.claude/skills/bs/` still holds a single epic-level SKILL.md and no
disposable wave-level playbook — so the tier split this finding is really
about is still ahead, and step 3 waits behind it. Splitting an epic across
*operator* sessions works today and SKILL.md documents it; splitting it across
*dispatched* ones does not.

---

## Environment note

`pnpm` is not on the default PATH in this session. Every invocation needs the
scratchpad `bin` shim prepended. Not a factory finding; recorded so the next
session does not rediscover it.

---

## D-14 — `task_id` is epic-qualified in the plan, bare everywhere in the mechanics

**Found:** 2026-08-06, creating wave 1's worktree, before any agent ran.

The planner wrote `envkit-config-loader/task-0-toolchain`. `smith plan
validate` accepted it (`{"valid":true}`) and `smith wave check` accepted it
too — nothing in `result.schema.json` constrains `task_id` beyond
`{"type": "string"}`, and there is no `spec.schema.json` at all
(`factory/specs/schema/` has result, finding, lesson — the spec shape lives
only in the planner template).

Every mechanical consumer then reads it as a **bare** id:

- `worktree.ts:61` — `taskBranchName(epic, taskId)` is
  `smith/${epic}/${taskId}`, so the qualified form yields
  `smith/envkit-config-loader/envkit-config-loader/task-0-toolchain`.
- `worktree.ts:98` — `worktreeDir = path.join(projectDir, 'wt', taskId)`,
  so a slash silently nests a directory level.
- `claims.ts:233` — `postRunCheck` takes `lastIndexOf('/')` off the branch
  name, so it would look for
  `smith/envkit-config-loader/envkit-config-loader/integration`, a branch
  that does not exist. The claim check does not fail loudly; it fails on a
  missing ref, which reads as an infrastructure error rather than a
  convention violation.
- `state/results/<task-id>.json` — a slash makes this a path into a
  subdirectory that nothing creates.

So two validators pass a value that four consumers cannot use, and the first
symptom would have been a git error three steps later with nothing pointing
back at the plan.

**Worked around in this run** by passing the bare `task-0-toolchain` to
`worktree create`/`gate run`/results, keeping the qualified `task_id` only
where the plan itself is the record.

**Fix (Phase 9):** pick one form and validate it. Cheapest is a `task_id`
pattern in a real `spec.schema.json` plus a `validatePlan` check that
`task_id` has no `/` — the epic is already carried by `epic_id` on every task,
so the qualification is redundant, not merely inconvenient. If the qualified
form is wanted instead, the four consumers above need a shared
`bareTaskId()` helper and `postRunCheck` needs to stop deriving the epic from
the branch name (which P9-3 already wants to do for other reasons).

---

## D-15 — `smith worktree create` with a relative project dir builds a doubled path

**Found:** 2026-08-06, wave 1, first worktree. **Severity: this is the
documented invocation.** `/bs run` step 2 says verbatim:
`smith worktree create workspaces/<project> <epic> <task-id>` — a relative
path — and that is the form that breaks.

`worktree.ts:98` builds `worktreeDir = path.join(projectDir, 'wt', taskId)`,
which for `projectDir = "workspaces/envkit"` is the repo-root-relative
`workspaces/envkit/wt/task-0-toolchain`. Line 100 then runs
`git worktree add ... <worktreeDir>` with `cwd: projectDir`, so git resolves
that relative path **again** against `workspaces/envkit`. Result:

    workspaces/envkit/workspaces/envkit/wt/task-0-toolchain

and the returned `worktreeDir` in the JSON is the un-doubled path, so the
value the operator records in `tasks.json` points at a directory that does
not exist. Nothing errors. `git worktree list` is the only place the truth
shows up.

Every downstream step then fails somewhere else: the coder is dispatched into
a missing directory, `gate run --worktree` reads the wrong tree, and
`queue run --tasks` gets a `worktreeDir` git cannot enter.

**Worked around** by passing an absolute `"$PWD/workspaces/envkit"`, which
resolves identically under any cwd and produced the correct
`workspaces/envkit/wt/task-0-toolchain`.

**Fix (Phase 9):** resolve `projectDir` to an absolute path at the top of
`createTaskWorktree`/`removeTaskWorktree`/`listStale` — `path.resolve()` is
idempotent on an already-absolute path, so this is a one-line change with no
behaviour change for callers already passing absolute. The regression test is
the doubled path itself: create with a relative dir, assert
`fs.existsSync(result.worktreeDir)`. And fix the `/bs` step-2 line, which
currently teaches the broken form.

## D-16 — `detectDefaultBranch` prints `fatal:` to stderr on a remoteless project

**Found:** same command. A freshly scaffolded project has no `origin`, so
`git symbolic-ref refs/remotes/origin/HEAD` (`worktree.ts:32`) writes

    fatal: ref refs/remotes/origin/HEAD is not a symbolic ref

straight to the operator's terminal before the `catch` at line 35 swallows
the error and falls through to `git branch --show-current`. The fallback is
correct and the command succeeds — but it prints `fatal:` on the happy path
of every project the operator has not yet pushed, which is exactly the state
`/bs new` leaves a project in (`commands.ghRepoCreate` is the operator's to
run, and they may never run it).

Related and worth stating because it surprised me: envkit's default branch is
**`setup`**, not `main` — that is what `/bs new` scaffolds — so
`smith/envkit-config-loader/integration` was correctly branched from `setup`
by the line-40 fallback, not by the line-46 `main`/`master` probe.

**Fix (Phase 9):** pass `stdio: ['ignore','pipe','ignore']` for that one
probe, or check `localBranchExists`-style with `git rev-parse --verify --quiet`
first. Cosmetic, but a stray `fatal:` in an autonomous run's log is the kind
of noise that trains an operator to ignore real ones.

## D-17 — a worktree under `workspaces/` inherits the host repo's pnpm workspace

**Found:** the wave-1 coder's first `pnpm install` inside
`workspaces/envkit/wt/task-0-toolchain` failed with

    ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION  packages field missing or empty

pnpm walks *up* looking for a workspace root. The worktree's own `.git` is a
pointer **file**, not a directory, so nothing stops the walk at the project
boundary; it climbed out of `workspaces/envkit/wt/task-0-toolchain` and found
black-smith's own `pnpm-workspace.yaml`, which declares only `allowBuilds` and
no `packages` array. The target project was therefore treated as a member of
the factory's workspace.

The coder worked around it with `pnpm install --ignore-workspace` and said so
in its `notes` — the right call, and it recorded the deviation instead of
hiding it. But it is a deviation from the spec that the *spec* should have
pre-empted, and the next coder in this epic will rediscover it from scratch.

This is not envkit's bug. It is a consequence of the factory hosting target
projects *inside its own repo tree* — any tool with an upward root-walk
(pnpm workspaces, nx, turbo, tsconfig `extends` chains, `.npmrc`, ESLint flat
config, Biome's own root discovery) can escape a `workspaces/<project>`
boundary the same way.

**Fix (Phase 9):** two candidates, not exclusive.
1. `smith new` writes a boundary marker into the scaffold — for pnpm that is a
   `pnpm-workspace.yaml` with `packages: ['.']` (or an `.npmrc` with
   `ignore-workspace-root-check`), which terminates the walk at the project
   root. Cheap, and it fixes the class for pnpm specifically.
2. The scaffold standard grows a "root-walk isolation" checklist item, and
   `/bs new`'s post-scaffold verification runs one `pnpm install` in the fresh
   project to prove the toolchain is usable *before* any epic is planned
   against it. Today the scaffold is never executed until a coder executes it,
   which is why this surfaced inside a graded task instead of at scaffold time.

Note the blast radius is bounded: envkit's `.github/workflows/ci.yml` runs
`pnpm install --frozen-lockfile` on a standalone checkout with no enclosing
workspace, so CI is unaffected. The breakage is local-only — which is worse in
one specific way: it will never show up in CI, only in every agent run.

> **Addendum 2026-08-11.** That last sentence was wrong about the *host* repo,
> and black-smith's own first CI run proved it: `pnpm install --frozen-lockfile`
> failed on the runner with this exact error. The file that broke the nested
> worktree was breaking every clean install of black-smith itself, and had been
> since 2026-08-04 — invisible because no machine here installs from scratch.
> `pnpm-workspace.yaml` is deleted (this is a single-package repo; the lockfile
> has one importer, and its `allowBuilds:` key never matched a pnpm 9 setting).
> The class survives for target projects, so fix candidate 1 above still stands
> — but write `packages: ['.']`, since a settings-only workspace file is itself
> the bug.

## D-18 — `token_usage` is agent-owned but unknowable to the agent

**Found:** the coder's result carries

    "token_usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

The N-1 envelope split gives the agent four keys (`run_status`,
`structured_output`, `artifacts`, `token_usage`) and the dispatcher four
(`task_id`, `agent`, `provider`, `model_tier`). But a subagent cannot observe
its own token consumption — there is no tool that reports it — so the one key
in the agent's half that it cannot honestly fill is `token_usage`. It wrote
zeros, which is the only thing it could do, and zeros are indistinguishable
from a genuinely free run.

The dispatcher *does* know: the Agent tool's own result reports
`subagent_tokens` (27,821 for this run). So the number exists on the
dispatcher's side of the split and the schema puts the field on the agent's
side.

This matters beyond bookkeeping. `budgets.yml`'s 150k token cap, the
`economy.budget-exceeded` error class and the escalation ladder all key off
per-task token spend; with zeros in every result, the budget alarm Phase 9
plans to build has nothing to alarm on, and the epic verdict cannot cite a
real cost.

**Fix (Phase 9):** move `token_usage` to the dispatcher's half of the
envelope — same treatment as `task_id`/`agent`/`provider`/`model_tier` — and
have the templates stop asking for it. Then `result.schema.json` should
require it to be non-zero, so a dispatcher that forgets to merge it fails the
schema check instead of silently logging a free run.

## D-19 — nothing constrains where an agent writes its artifacts

**Found:** the coder recorded three artifacts at `/tmp/probe-fail-output.txt`,
`/tmp/probe-pass-output.txt`, `/tmp/final-test.txt`. They exist and the
evidence in them is real, but `/tmp` is outside both the worktree and the
session scratchpad: it is not claim-checked, not captured with the branch, not
carried into the PR, and on macOS it is periodically swept. The gate reads the
result file, not the artifacts, so nothing notices when an `artifacts[].path`
has already evaporated.

`result.schema.json` types `artifacts` as `[{type, path, description?}]` with
no constraint on `path`, and no template says where artifacts belong.

**Fix (Phase 9):** give artifacts a home per task —
`state/artifacts/<task-id>/` is the natural one, alongside
`state/results/<task-id>.json` — state it in the templates, and have the gate
verify each declared `artifacts[].path` exists at schema-check time. An
artifact that cannot be opened when the verdict is written is not evidence.

---

## D-20 — judges stop mid-investigation and return a partial thought instead of a verdict

**Found, twice in one wave, on 2 of the 3 judges dispatched for `task-0`.**

The reviewer stopped after 20 tool calls and returned, as its final message,
`"This looks like a reasonable transitive closure. Let's check for
packageExtensionsChecksum…"` — a thought about what it was *about to do*. The
security-reviewer stopped after 21 tool calls with
`"Good — dependencies stays {}, exactly one script added … Now the lockfile."`
Both were resumed with an explicit "finish these three checks and return only
the JSON object" and both then produced a complete, well-formed verdict on the
first retry. Neither was out of budget; neither hit an error.

**Why it matters more than it looks.** The dispatcher here was a human-in-the-loop
operator session that noticed the truncation and resumed. The Phase 9 always-on
daemon will not be. Under `/bs run` step 9 the failure surfaces as an
unparseable judge response, and the two obvious mechanical behaviours are both
wrong:

- treat "no findings parsed" as **clean** → an unreviewed diff walks the gate
  with a `reviewer: clean` on the record. Silent, and the worst outcome.
- treat it as **blocked** → the round counter advances, the coder is bounced
  for a defect nobody alleged, and after two of these the tier escalates. Loud,
  expensive, and still wrong.

The truncation is also *invisible in the event log*: the `dispatch_decision`
was appended, the agent returned, no error class fits. `judgment.*` has
`hallucination`, `false-positive-finding`, `missed-finding` — none of them
covers "the judge never rendered a verdict at all".

**Fix (Phase 9), three parts:**

1. **Schema-validate every judge response, not just coder results.** Judge
   output is currently free prose that the dispatcher eyeballs. `result.schema.json`
   guards the worker envelope; there is no equivalent for a verdict. A judge
   response that does not parse against a `verdict.schema.json`
   (`{findings[], verdict, summary}`) is not a verdict.
2. **Make a non-verdict a distinct, retryable state — never `clean`, never
   `blocked`.** One automatic re-ask with the "return only the JSON" framing
   (which worked 2/2 here), and it must not consume a review round. Only a
   second failure escalates, and it escalates as a *dispatch* problem, not a
   code problem.
3. **Give it an error class.** `judgment.no-verdict` (or `execution.tool-failure`
   if the taxonomy PR is not worth it) so the rate is countable. If judges
   truncate at the rate seen in this single wave, the Phase 9 daemon needs that
   number on a dashboard before it is trusted to run unattended.

**Related:** [[D-18]] — both are cases where the envelope the dispatcher
receives is structurally valid (or absent) while being substantively empty, and
nothing downstream can tell the difference.

---

## D-21 — `event tail` returns `[]` + exit 0 for a typo'd session and for no session at all — confirmed

```
$ node factory/orchestrator/dist/cli.js event tail no-such-session-at-all --n 5
[]
exit=0
$ node factory/orchestrator/dist/cli.js event tail --n 5      # positional omitted entirely
[]
exit=0
```

`cli.ts:298` reads `positional[0] as string` — the `as string` is a lie when
nothing was passed, and `tailEvents(undefined, …)` yields an empty list rather
than an error. The signature is `event tail <session-id> --n <N>`; I first
invoked it as `--session … --limit …` (both wrong) and got `[]`, which I read
for a moment as "the session has no events" on a session that had seven.

**An empty result and a malformed query are the same output.** This is the same
class as D5b but strictly worse: D5b crashed with a TypeError, which at least
told me I was wrong. This one answers confidently.

**Fix:** `requireFlag`'s positional equivalent — fail with
`cli.missing-positional` and exit 1 when `positional[0]` is absent (the code
already has exactly this for flags, and it produced a clean error for `stats
kanban --epic` in this same session). Distinguishing "unknown session" from
"empty session" is a second, cheaper win: the events dir is listable.

---

## D-22 — `wave-merged` and `task-added` have no producer, so the task projection can never reach `completed` on its own — confirmed

`db/projector.ts` folds the `tasks` table from `task-added`, `wave-admitted`,
`dispatch_decision`, `gate-outcome`, `wave-merged`, `task-superseded`,
`error-logged`. Two of those seven have **no emitter anywhere in
`factory/orchestrator/src/`**:

```
$ grep -rn "wave-merged|wave-admitted" factory/orchestrator/src/
  db/queries.ts:662,663      (consumer)
  db/projector.ts:331,354    (consumer)
$ grep -rn "task-added" factory/orchestrator/src/
  scheduler.ts:180           (consumer)
```

`queue.ts` imports no event machinery at all (`grep -n "appendEvent" queue.ts`
→ nothing) and `queue run` takes no `--session`/`--causal-parent`. So the merge
queue — the one component that actually knows a task merged — is **mute**.

The projector's only path to `completed` is `wave-merged` (projector.ts:354).
`gate-outcome: pass` sets `merging` (projector.ts:351). Therefore **every task
in a real run terminates at `merging` forever** unless a human remembers to
hand-append `wave-merged`, which is exactly what I had to do here
(`dogfood-envkit-1#11`). The kanban's `completed` column is structurally
unreachable by machine.

Same for `task-added`: `plan.ts` emits nothing, so a validated plan's tasks
never enter the DB with their `epic_id`/`branch`/`claims`/`budget_tokens`. Rows
only spring into existence as a side effect of whatever wave/gate event first
names an id.

**Consequence, measured after a fully green wave:**

```
$ node dist/cli.js stats kanban --epic envkit-config-loader --session dogfood-envkit-1
[]
$ node dist/cli.js stats overview --session dogfood-envkit-1
  "epicsInFlight": [], "tokensByEpic": []
```

The epic's own kanban is **empty** and it reports **zero epics in flight** —
after planning six tasks, running a wave, passing five checks and landing a
merge commit. The Phase 6 UI would show an operator nothing at all.

**Fix (Phase 9):** `queue run` takes an event context and emits `wave-merged`
on `merged` (and an `integration.*` error event on `rebase-conflict`/
`tests-failed`); `plan validate`/plan admission emits one `task-added` per task
carrying `epic_id`, `branch`, `claims`, `budget_tokens`. Neither is more than a
few lines — the payload shapes the projector wants already exist. Until then,
every dashboard number in this repo is only as good as an operator's memory.

### D-22a — `epic_id` is empty on every projected task row

```
$ sqlite3 state/smith.db "select task_id, task_status, epic_id, branch from tasks;"
envkit-config-loader/task-0-toolchain|ready||
task-0-toolchain|completed||
```

Downstream of D-22: `epic_id` and `branch` are only ever set by the
`task-added` case (projector.ts:327-328), so nothing that filters or joins by
epic can work. That is precisely why `stats kanban --epic …` returns `[]`, and
why `roadmapPage()`'s milestone↔task join reports `tasksTotal: 0` for the
`envkit-config-loader` milestone that is mid-flight.

---

## D-14 (evidence added) — the epic-qualified vs bare task id split now has a measured cost

Previously recorded as a workaround. It is now a confirmed data defect:

```
$ sqlite3 state/smith.db "select task_id, task_status from tasks;"
envkit-config-loader/task-0-toolchain|ready
task-0-toolchain|completed
```

**One task, two rows, two different statuses.** The plan file uses
`envkit-config-loader/task-0-toolchain`; the mechanics (`gate run`, `queue
run`, worktree dirs, branch names) use the bare `task-0-toolchain`. My
`wave-admitted` payload carried the qualified id and the gate carried the bare
one, so `touch()` minted a row for each. The qualified row is stranded at
`ready` forever; a kanban would display the same task twice, in two columns.

**Fix:** pick one form and normalise at the event-log boundary. Bare ids are
already load-bearing in filesystem paths (worktree dirs, `state/results/*.json`),
so bare is the cheaper canonical choice, with `epic_id` carried as its own field
— which is what the `tasks` table already has a column for (D-22a).

---

## D-23 — the live-agent registry assumes one agent per task; the factory's own dispatch model breaks that assumption — confirmed

`agents-registry.ts:9-23` states the correlation rule and its justification:

> Correlation key is `task_id`: the most recent open dispatch for a task is
> closed by the next terminal event naming that task … **a real dispatcher never
> runs two agents on one task_id concurrently**, so an open-on-redispatch entry
> is stale bookkeeping, not a genuinely live agent.

That sentence is false in this repo. `/bs run` dispatches a coder, then a
grader, then a reviewer, then a conditionally a security-reviewer, then a
verifier — **all against the same `task_id`**, and the reviewer and
security-reviewer are explicitly dispatched *concurrently* (I dispatched them in
one message this wave, as the playbook intends).

Measured result after wave 1, in which all four agents completed successfully:

```
$ sqlite3 state/smith.db "select id, agent_role, status, terminal_type from agents;"
dogfood-envkit-1#3  coder              superseded  superseded
dogfood-envkit-1#4  grader             superseded  superseded
dogfood-envkit-1#5  reviewer           superseded  superseded
dogfood-envkit-1#6  security-reviewer  live
```

Three agents that finished clean are recorded as **superseded** — a status whose
taxonomy meaning is "replaced without reporting back", i.e. the analytics now
assert the coder never delivered. The fourth is **live** and will stay live
forever, because `task-result-recorded` — the documented terminal counterpart —
also has no producer (`grep -rn "task-result-recorded" src/` returns only
readers: `agents-registry.ts`, `scheduler.ts`, `db/schema.ts`). `detectStale()`
will fire on it indefinitely.

`overview()` correspondingly reported `liveAgentCount: 1` at a moment when four
agents were genuinely running.

**This is not a fold bug — the fold does exactly what its comment says.** The
defect is the model: `task_id` is not a unique key for a live agent. The natural
key is `(task_id, agent_role, round)`, which every `dispatch_decision` in this
session already carries in its payload (`agent_role`, `round`).

**Fix (Phase 9):**
1. Key `openByTask` on `(task_id, agent_role, round)`, not `task_id`. Supersede
   only on a *same-role, same-or-newer-round* redispatch — which is the case the
   comment was actually written to defend against.
2. Emit `task-result-recorded` when a judge/worker returns a schema-valid result
   — this is the same missing-producer class as [[D-22]], and the same fix
   closes the `live`-forever leak.

**Related:** [[D-18]] (token_usage), [[D-20]] (no-verdict), [[D-22]] (missing
producers). All four are the same underlying shape — **the event log is
specified far more completely than it is written.** The consumers (projector,
registry, scheduler, queries, UI) were all built against the full event
vocabulary; the producers cover maybe half of it, and the operator skill's prose
is silently carrying the rest. That gap is invisible until someone runs a real
epic, which is what this dogfood was for.

---

## D-24 — `worktree create` re-anchors a relative `projectDir`, creating a nested worktree and returning a path that does not exist

**Severity:** S2 — silent wrong-path creation; every downstream consumer of the
returned path breaks.
**Found:** wave 2 setup, dogfooding envkit-config-loader.
**Status:** mechanically confirmed; reproduced, then cleaned up by hand.

**What happened.** I ran, from the black-smith repo root:

```
node factory/orchestrator/dist/cli.js worktree create workspaces/envkit \
  envkit-config-loader task-1a-parse-core
```

Exit 0. It printed a worktree dir of `workspaces/envkit/wt/task-1a-parse-core`.
The directory it actually created was
`workspaces/envkit/workspaces/envkit/wt/task-1a-parse-core`. Same for
`task-2-coerce`. Two nested worktrees, two stray branches, exit 0, no warning.

**Root cause** — `factory/orchestrator/src/worktree.ts:87-103`:

```ts
const worktreeDir = path.join(projectDir, 'wt', taskId);
git(projectDir, ['worktree', 'add', '-b', branch, worktreeDir, integrationBranch]);
```

`path.join` preserves relativity: with `projectDir = "workspaces/envkit"` the
result is the *relative* string `workspaces/envkit/wt/task-1a-parse-core`. But
`git()` runs with `cwd: projectDir`. Git therefore resolves that relative path
**against `workspaces/envkit`**, not against the caller's cwd — so the path is
applied twice. The function then *returns* the un-anchored single-prefix string,
so the returned value and the created directory are two different places.

**Why it matters beyond the mess.** The returned path is the input to
everything downstream: `gate run --worktree <dir>`, the merge queue's
`worktreeDir`, `worktree remove`, and every agent prompt that says "work in this
directory". With a relative `projectDir`, all of those get a path that does not
exist — and `gate run` would then run its check commands in a non-existent cwd,
or worse, in a stale one that happens to exist from a prior absolute-path run.
The failure is not "it errored"; it is "it succeeded and lied".

**`worktree remove` compounds it.** `removeTaskWorktree` (line 107) recomputes
the same `path.join(projectDir, 'wt', taskId)` and passes it to
`git(projectDir, ['worktree', 'remove', …])` — so remove is *consistently*
wrong in the same direction and happens to find the nested dir. That symmetry is
why the bug can survive: create and remove agree with each other, and only a
third party (the gate, the queue, a human doing `ls`) sees the discrepancy.
`listStale` has the same construction.

**Fix (Phase 9):**
1. `path.resolve(projectDir, 'wt', taskId)` in `createTaskWorktree`,
   `removeTaskWorktree`, and `listStale`. `path.resolve` anchors against
   `process.cwd()` for a relative `projectDir`, which is the caller's intent,
   and is a no-op for an absolute one.
2. Better: resolve `projectDir` itself once at the top of each entry point
   (`const root = path.resolve(projectDir)`) and never touch the raw argument
   again — the same discipline the CLI already needs for `--worktree`.
3. Add a regression test that calls `worktree create` with a *relative*
   projectDir from a different cwd and asserts `fs.existsSync(returnedPath)`.
   The current tests presumably all pass absolute paths, which is exactly why
   this survived to a live run.

**Transferable lesson (rule candidate):** *a function that both computes a
filesystem path and hands that path to a child process with a different `cwd`
must resolve the path to absolute first — otherwise the path is interpreted
twice against two different roots, and the return value stops describing
reality.*

**Related:** [[D-14]] (the other "the string you hold is not the string the
system uses" defect this epic surfaced).

---

## D-25 — `sensitive-paths.yml` fires on `package.json` and misses `src/parse.ts`: the file-level globs are directory-only

**Severity:** S2 — the security-reviewer dispatch trigger is inverted on this
epic: it fires on the least security-relevant task and stays silent on the most.
**Found:** wave 2 dispatch planning, dogfooding envkit-config-loader.
**Status:** mechanically confirmed with picomatch against the file's own globs.

**How it was measured.** `sensitive-paths.yml` has no host in the orchestrator
(the file says so itself), so I evaluated its 43 globs directly with picomatch
4.0.5 — the same matcher the eventual host would use — against every claim in
this epic:

```
  --   src/parse.ts
  --   test/parse.test.ts
  --   src/coerce.ts
  --   test/coerce.test.ts
  --   src/validate.ts
  --   src/index.ts
FIRES  package.json  <- **/package.json
  --   pnpm-lock.yaml
```

**One task in six fires, and it is the wrong one.** `task-0-toolchain` — add a
dev dependency, set a coverage threshold — earned a security review because it
claimed `package.json`. `task-1a-parse-core`, which implements the parser for
files that hold credentials by definition, does not. Neither does
`task-3-validate`. The epic is a `.env` loader; if this policy cannot flag a
`.env` parser, it is not measuring what it says it measures.

I should be direct that this corrects my own reading: I had planned wave 2's
judge set on the assumption that `src/parse.ts` matched `**/parse*/**`, and
intended to dispatch a security-reviewer on that basis. The measurement says the
policy would not have told me to. I am still dispatching one — a `.env` parser
warrants it on the merits — but that decision is now visibly mine, not the
policy's, which is exactly the "judgment call made fresh on every dispatch"
state the file was written to end.

**Root cause — three distinct glob defects, not one:**

1. **Directory-only patterns where a file was meant.** `**/parse*/**`,
   `**/validat*/**`, `**/serializ*/**`, `**/deserializ*/**`, `**/upload*/**`,
   `**/sanitiz*/**`, `**/guard*/**`, `**/permission*/**`, `**/secret*/**`,
   `**/credential*/**`, `**/repositor*/**`, `**/webhook*/**` all require a
   *directory* component with that prefix. A single-file module — `parse.ts`,
   `validate.ts`, `secrets.ts` — never matches. The comment above the block says
   "Input parsing and deserialization — the untrusted-data boundary", so the
   intent is clearly the file too. Only the auth block got a file-level
   companion (`**/*session*.{ts,…}`), and only for `session`.

2. **`*parser*` does not match `parse.ts`.** The one file-level pattern in the
   parsing block requires the literal substring `parser`. The most common name
   for a parser module is `parse.ts`. The glob catches `xml-parser.ts` and
   misses `parse.ts`.

3. **`**/*.lock` misses the two most common lockfiles.** `pnpm-lock.yaml` and
   `package-lock.json` do not end in `.lock`; `yarn.lock`, `Cargo.lock` and
   `poetry.lock` do. This epic's lockfile only got reviewed because the same
   task also claimed `package.json` — coincidence, not policy.

**Fix (Phase 9), in the same PR that gives the file a host:**
1. Give every directory-only entry a file-level sibling:
   `**/parse*.{ts,tsx,js,jsx,py,go,rs,rb,java}`,
   `**/validat*.{…}`, `**/*sanitiz*.{…}`, `**/secret*.{…}`,
   `**/credential*.{…}`, `**/*upload*.{…}`, `**/*serializ*.{…}`. The auth block
   already demonstrates the pattern; it was simply not applied throughout.
2. Replace `**/*.lock` with an explicit list —
   `**/*.lock`, `**/pnpm-lock.yaml`, `**/package-lock.json`,
   `**/yarn.lock`, `**/*.lockb` — rather than a suffix rule that happens to
   miss the ecosystem this repo is written in.
3. **Add a fixture test to the host.** A `sensitive-paths.test.ts` with a table
   of paths that MUST fire (`src/parse.ts`, `src/auth.ts`, `pnpm-lock.yaml`,
   `src/validate.ts`) and MUST NOT fire (`src/index.ts`, `README.md`,
   `src/parse.test.ts`). Every glob file in this repo is currently unfalsifiable
   prose; this one is checkable, so check it. Without such a test, defect (1) is
   invisible for exactly as long as nobody happens to name a module `parse.ts`.
4. Consider whether `**/package.json` earns its place. It fired here on a
   dependency bump, which is a real supply-chain event — but if it fires on
   every `package.json` touch it will be the trigger that cries wolf, and the
   reviewer will learn to skim. Narrow it to changes in `dependencies` /
   `scripts` once there is a host that can read the diff, not just the claim.

**Transferable lesson (rule candidate):** *a `**/name*/**` glob matches a
directory, never a file of that name; any policy that means "code about X" must
list the file-level pattern explicitly beside the directory one, and must ship a
fixture test naming at least one path that MUST match and one that MUST NOT.*

**Related:** [[D-22]], [[D-23]] — same family: a policy file specified more
completely than the thing that reads it. Here there is no reader at all, which
is why the defect survived review: nothing could have failed.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-4-security-triggers`**
(punch list P9-4). The file has a host — `smith security triggers --task
<spec.json>`, `factory/orchestrator/src/security.ts` — and the globs were
rewritten with a file-level sibling beside every directory entry, plus the
lockfile trio `**/*.lock`, `**/*.lockb`, `**/*lock*.{yaml,json}`. Fix (3) is
`factory/orchestrator/test/security.test.ts`: the MUST-fire / MUST-NOT-fire
table above is a literal `it.each`, and the six envkit claim sets are a second
fixture asserting the exact set of tasks that fire. Re-measured on those claim
sets the score is four for six (both parse tasks, validate, and toolchain — the
latter now for `pnpm-lock.yaml`, not only `package.json`), with `src/coerce.ts`
and `src/index.ts` correctly silent. Two rows were added that this finding did
not predict: `.env.example` and `.github/workflows/ci.yml`, which picomatch's
default `dot: false` hides from `*` and `**` — the host passes `{ dot: true }`
everywhere for that reason. Fix (4) was declined for now and recorded as such:
`**/package.json` stays whole, because narrowing it to `dependencies`/`scripts`
needs a host that reads the diff, and this one reads claims.

---

## D-26 — An S3 raised in one wave cannot reach the task that reopens the same file

**Severity:** S2 · **Surfaced by:** wave 2 gate, `task-1a-parse-core`

Wave 2's reviewer raised a real S3 on `src/parse.ts`
(`f-task-1a-parse-core-472d9cba` — an indented `export` line folds the word
`export` into the key). `severity.yml` is explicit about what happens next:

```yaml
S3-minor:
  blocks_merge: false
  semantics: waivable — batched to operator at epic end
```

That is the correct policy in isolation. It is the wrong policy *in this
plan*, and the plan is what makes it wrong: **`task-1b-parse-quotes` (wave 3)
claims `src/parse.ts` and `test/parse.test.ts` — the same two files — and
rewrites the quoting rule wholesale.** So the sequence the factory will
actually execute is:

1. Wave 2 raises the S3 and defers it to epic end.
2. Wave 3 dispatches a coder into `src/parse.ts` with no knowledge of it.
3. That coder rewrites part of the file and leaves the defect untouched.
4. Epic end asks the operator to waive a finding in a file that has since
   been rewritten by someone who was never told.

Step 3 is the cheapest possible moment to fix it and the factory routes
around it. I checked whether any mechanism closes this loop:

```
$ grep -rn "fix-pending|openFindings|open_findings" factory/orchestrator/src/
factory/orchestrator/src/epic.ts:48   const OPEN_FINDING_STATUSES = ...
factory/orchestrator/src/epic.ts:93   const openFindings = findings...
factory/orchestrator/src/db/queries.ts:839  const OPEN_FINDING_STATUSES = ...
```

Both consumers are **epic-final**: `epic.ts` composes the verdict, `queries.ts`
feeds the dashboard. Nothing reads open findings at *dispatch* time. The
finding is stored correctly, fingerprinted correctly, and surfaced to nobody
who could act on it cheaply.

Note this is not the same gap as P9-2 (dispatch-time *lesson* injection).
Lessons are cross-epic and approved; this is an open finding inside the
*current* epic against a file the *current* plan is about to reopen. The
join is available with no new inference: intersect open findings' `file_path`
against the dispatching task's `claims[]`.

**Fix:** at dispatch, intersect open findings against the task's claims and
append the matches to the coder's brief as context — not as scope. The
distinction matters: silently widening a task's scope breaks plan
immutability and the diff cap. The brief should say "an open S3 exists in a
file you are about to edit; fix it if it falls naturally inside your diff,
otherwise leave it and say so." Then the epic-end waiver batch only ever asks
about findings nobody had a cheap chance to fix.

**Rule candidate:** *a finding deferred past the last task that touches its
file has been deferred past the point of being cheap; the deferral policy
must be aware of the plan, not just the severity.*

**Related:** [[D-14]] — same shape: a join that exists in the data and is
never computed.

---

## D-27 — `wave-merged` carries a singular record-level `task_id`

**Severity:** S3 · **Surfaced by:** hand-appending the wave-2 `wave-merged`
event

Wave 1 had exactly one task, so `#11` set the record-level `task_id` to
`task-0-toolchain` and the shape looked fine. Wave 2 has two, and the field
cannot be filled honestly: the record describes both merges, and the singular
field can name only one.

This is exactly what `taxonomy.yml` rule 2 forbids:

> One value per dimension — a record needing two values is two records or a
> wrongly-cut dimension; fix the taxonomy by PR, don't overload tags.

I omitted the field for `#29` and kept `task_ids` in the payload, which
`wave-admitted` (`#12`) already does — but that means the two wave events now
disagree about whether the record-level field is populated, and any consumer
grouping `wave-merged` by `task_id` silently drops multi-task waves rather
than erroring.

The reason this survived is the same reason as D-25: **the only producer is a
human hand-appending JSON**, so no code path ever had to decide. A single-task
wave is the degenerate case that makes the wrong shape look right, and wave 1
was a single-task wave.

Checking the consumer side settles which of the two carriers is the real one.
The projector's `wave-merged` arm reads the plural payload field and **nothing
else** (`db/projector.ts:353-360`):

```ts
case 'wave-merged': {
  const p = record.payload as { task_ids?: string[] };
  for (const taskId of p.task_ids ?? []) {
    touch(taskId, record.ts, record.session_id).taskStatus = 'completed';
  }
  break;
}
```

Compare the `gate-outcome` arm four lines above it, which opens with
`if (!record.task_id) break;`. So the record-level field is load-bearing for
task-scoped events and **dead weight on `wave-merged` — it has no reader at
all.** Wave 1's `#11` populated a field nothing consumes; wave 2's `#29`
omitted a field nothing consumes. Both fold identically, which is exactly why
the inconsistency produced no symptom and would have gone unnoticed without
someone hand-writing the second one.

**Fix:** drop the record-level `task_id` from wave-scoped events and make
`task_ids` the only carrier — the projector has already voted for that
carrier by only ever reading it. (The alternative, one record per merged task,
is defensible in the abstract but would mean rewriting a consumer that
currently works.) Then make the schema say so, so a future hand-appender
cannot re-add it. Whichever is chosen, add a projector test with a **two-task**
wave — a single-task fixture cannot catch this.

**Related:** [[D-22]] — no producer is the root cause; this is what the
missing producer failed to force a decision about.

## D-28 — The bare-vs-qualified task id split deadlocks the epic close, and fails in opposite directions on the two filters that matter

**Severity:** S1 · **Surfaced by:** probing the epic-close path mid-wave-3

[[D-14]] recorded that the plan uses epic-qualified task ids
(`envkit-config-loader/task-1a-parse-core`) while the whole mechanical layer —
gate run, queue `tasks.json`, `wave-merged` `payload.task_ids`, finding
`task_id` — uses bare ones (`task-1a-parse-core`). At the time the cost was a
translation step I did by hand. Closing the epic is where it stops being
cosmetic.

**Site 1 — the waiver batch silently comes back empty.**

```
$ smith waivers pending envkit-config-loader --session dogfood-envkit-1
[]
EXIT=0
```

Exit 0, empty array — indistinguishable from "this epic has nothing to waive".
But the epic *does* have an open waivable finding:

```
$ smith findings list --session dogfood-envkit-1
f-task-1a-parse-core-472d9cba | task-1a-parse-core | S3-minor | raised
```

`pendingBatch` calls `listFindings(sessionId, {epic})`, and the epic filter
(`findings.ts:355-356`) derives the epic by string-splitting the task id:

```ts
if (filter.epic !== undefined)
  results = results.filter((f) => f.task_id.split('/')[0] === filter.epic);
```

`'task-1a-parse-core'.split('/')[0]` is `'task-1a-parse-core'`. A controlled
pair confirms the filter is doing exactly that and nothing else:

```
$ smith findings list --session dogfood-envkit-1 --epic envkit-config-loader   -> []
$ smith findings list --session dogfood-envkit-1 --epic task-1a-parse-core     -> count = 1
```

The epic name matches nothing; the task id matches itself. The filter is not
an epic filter at all — it is an exact-match-on-the-first-path-segment filter
that happens to behave like an epic filter when ids are qualified.

**Site 2 — the verdict sees one phantom task and none of the real ones.**

`runEpicVerdict` (`epic.ts:257-259`) filters the task fold by prefix:

```ts
const epicPrefix = `${input.epicId}/`;
const tasks = foldTasks(events).filter((t) => t.taskId.startsWith(epicPrefix));
```

Running it (safe — `summarizeEpic` is a read-only projection and emits nothing
on the not-ready path; confirmed afterwards that the log still ended at `#32`):

```json
{"outcome":"hold","epicId":"envkit-config-loader",
 "summary":{"epicId":"envkit-config-loader",
   "tasks":[{"taskId":"envkit-config-loader/task-0-toolchain","taskStatus":"ready"}],
   "nonTerminalTaskCount":1,"openFindings":[],
   "blockers":["Task \"envkit-config-loader/task-0-toolchain\" is not terminal-OK (status: ready)."],
   "mechanicallyReady":false},
 "reason":"mechanical-blockers"}
EXIT=1
```

The fold itself explains it:

```
envkit-config-loader/task-0-toolchain      ready
task-0-toolchain                           completed
task-1a-parse-core                         completed
task-2-coerce                              completed
task-1b-parse-quotes                       ready
task-3-validate                            ready
```

`task-0-toolchain` is **two rows**. Wave 1's `wave-admitted` used the
qualified id, so the projector opened a row at `ready` and then never touched
it again — every later event for that task carried the bare id, which opened a
*second* row that went on to `completed`. The prefix filter keeps only the
abandoned half. So the epic reports one task, frozen at `ready`, that in
reality merged three waves ago; and it cannot see the three tasks that
genuinely did merge.

**The sharp part is that the two filters fail in opposite directions.** The
task filter failing *over*-blocks: it invents a blocker and holds. The finding
filter failing *under*-blocks: an open, unwaived, blocking-eligible finding
becomes `openFindings: []` and stops counting. Today the id convention is
uniformly bare for findings and mixed for tasks, so the over-block masks the
under-block and the epic merely deadlocks. Flip the convention — qualify task
ids consistently, which is the obvious "fix" — and the task filter starts
working while the findings filter keeps failing, and the epic returns **`go`
with an unwaived open finding**. The safe-looking repair converts a deadlock
into a false pass.

**Fix:** stop deriving epic membership from string surgery on the task id.
Carry `epic_id` as its own field on findings and on the task projection, and
filter on it. If the derivation must stay for back-compat, it needs a single
shared helper used by both call sites plus a guard that refuses an id whose
shape doesn't match the expected convention — a `split('/')[0]` that silently
returns the whole string when there is no `/` is the entire bug. Separately,
the projector should not be able to hold two rows for one task: normalize the
id at the projector boundary, or reject an event whose task id is not in the
plan.

**Rule candidate:** *an identifier that is parsed rather than passed will
eventually be parsed by two functions that disagree; the disagreement surfaces
at the join, which is always the last step, which is always the expensive
place to find it.*

**Related:** [[D-14]] — this is that split becoming load-bearing.
[[D-22]] — the hand-appended `wave-merged` is where the bare ids entered the
task fold.

## D-29 — The per-task `budget` block has no consumer anywhere in the orchestrator

**Severity:** S2 · **Surfaced by:** wave 3, `task-3-validate`

Every task in the plan carries a budget:

```json
"budget": { "tokens": 100000, "diff_lines": 260, "max_turns": 30 }
```

Nothing reads it.

```
$ grep -rn "max_turns\|maxTurns" factory/orchestrator/src   -> no matches
$ grep -rn "diff_lines\|diffLines" factory/orchestrator/src -> no matches
```

`diff_lines_changed` exists in exactly one place in the repo — as a declared
field in `factory/specs/schema/result.schema.json:66`. It is collected from the
agent and never compared to the cap that was supposed to bound it. The 78
`budget` hits in the orchestrator are all a *different* budget: `JudgeBudget`
(`timeout_ms`, `max_output_bytes`) and the plan-quorum `budget_ratio`.

So the per-task budget is prompt text. It is honoured exactly as far as the
agent chooses to honour it, and observably not further — `task-3-validate` ran
**40 tool uses against a `max_turns: 30` budget**. Nothing stopped it at 30 and
nothing noticed afterwards that it had gone past.

The `diff_lines` cap is worse than unenforced: it is *enforced by the agent on
itself*, which turns a budget into a pressure. `task-3-validate` spent its tail
shaving lines to land exactly on 260 and stopped mid-procedure to do it — its
final message was "One more line to trim." A cap the agent polices produces
exactly this: the agent trades finishing for compliance, and the orchestrator
gets neither the budget nor the work.

**Fix:** decide per field whether it is a *limit* or a *signal*. `max_turns`
is a limit and belongs in the dispatch harness, not the prompt. `diff_lines`
is better as a post-hoc signal than a live cap — compare
`diff_lines_changed` against it at gate time and raise a finding on overrun,
rather than asking the agent to self-truncate. `tokens` is already measurable
from `token_usage`; nothing compares it either. Whatever is chosen, a field in
the plan with zero readers should fail plan validation, not sit there looking
enforced.

**Rule candidate:** *a constraint stated only in a prompt is a request; if the
plan writes it down like a limit, something has to be able to say no.*

**Related:** [[D-30]] — the same task, and the same stop, produced the more
dangerous half of this.

## D-30 — The gate checks the working tree, the queue merges the branch: uncommitted work passes green and merges empty

**Severity:** S1 · **Surfaced by:** wave 3, `task-3-validate`

`task-3-validate` reported completion and stopped in this state:

```
$ git -C workspaces/envkit/wt/task-3-validate log --oneline -1
54654af Merge task-2-coerce into smith/envkit-config-loader/integration

$ git -C workspaces/envkit/wt/task-3-validate status --porcelain
A  src/validate.ts
A  test/validate.test.ts

$ git -C workspaces/envkit/wt/task-3-validate diff --stat 54654af
 src/validate.ts       | 106 +++++++++++
 test/validate.test.ts | 154 ++++++++++++++
 2 files changed, 260 insertions(+)
```

260 lines of real, working implementation — **staged, never committed**. The
branch head is still the integration commit it was cut from. No result
envelope was written either.

Now trace what the pipeline would have done with it, had I run the gate
instead of inspecting first.

`gate.ts` runs its checks against the **working tree** (`gate.ts:390`):

```ts
{ cwd: input.worktreeDir, ... }
```

and validates the result envelope against `result.schema.json`
(`gate.ts:367`). It looks at git *not at all* — there is no `git`, no
`commit`, no `status`, no dirty check anywhere in the file. `pnpm lint`,
`pnpm typecheck` and `pnpm test` all read the working tree, so all three go
green on the uncommitted files.

`queue.ts` then rebases and merges the **branch** (`queue.ts:77`, `99`):

```ts
execFileSync('git', ['rebase', integrationBranch], { cwd: task.worktreeDir, ... });
execFileSync('git', ['merge', '--no-ff', task.branch, '-m', `Merge ${task.taskId} into ${integrationBranch}`], ...);
```

`task.branch` at this moment points at `54654af`. The rebase is a no-op, the
merge is a no-op, and `queue run` returns `{outcome: 'merged', taskId:
'task-3-validate'}`. The `wave-merged` event then sets the task to
`completed`. The epic closes with a task that is green, merged, terminal-OK —
and contributed zero lines.

Every layer is individually correct and the composition is wrong: **the gate
and the queue disagree about what "the work" is.** The gate says working tree,
the queue says branch head, and nothing asserts they are the same thing. The
only reason this run didn't produce a phantom merge is that I looked at the
worktree by hand before running the gate.

Note this is invisible to every existing signal. The checks pass — genuinely,
on real code. The result schema validates. The diffstat the agent self-reports
is accurate. The merge succeeds. There is no error anywhere; the work simply
isn't in the commit.

**And the coder did not break its contract.** `.claude/agents/coder.md` has an
"Output contract" section that opens `Two parts, both mandatory`:

1. write `state/results/<task-id>.json`
2. return one line of JSON

Committing is not one of them. The word "commit" appears in `coder.md` exactly
twice, both inside the `research_request` escape hatch — *"an unknown is
returned, not signalled: commit whatever is already green, then stop"* — i.e.
the contract only mentions committing on the **abnormal** path, and says
nothing about it on the normal one. `docs/standards/agent-constraints.md:47-51`
repeats the same escape-hatch wording and likewise never requires a commit on
success.

So the branch that the merge queue merges is produced by no one. The coder is
not asked to write it, the gate does not check it, and the queue assumes it.
`task-3-validate` stopping uncommitted was not misbehaviour; it was the
contract being followed to the letter. That moves this out of "flaky agent" and
into "missing requirement", and it means the fix has two halves: the coder
contract must make the commit a mandatory third part of done, **and** the gate
must verify it rather than trust it. Only the second half is load-bearing —
an agent instruction is a request ([[D-29]]) — but without the first half the
gate would be failing agents for something no one told them to do.

**Fix:** make the gate assert the thing it is about to certify is the thing
that will be merged. Concretely, before running checks: fail if
`git status --porcelain` is non-empty in the worktree, and fail if the task
branch head equals the integration base it was cut from (a task that merges
nothing is a bug, not a pass). Both are two lines and neither needs a judge.
The stronger form — run the checks against a clean checkout of the branch head
rather than the worktree — closes it completely but costs a checkout per gate.

**Rule candidate:** *when one stage verifies state A and the next stage ships
state B, the pipeline is only correct by coincidence; the handoff has to name
which state is authoritative and the earlier stage has to check that one.*

**Related:** [[D-29]] — the budget pressure is what produced the stop that
exposed this. [[D-22]] — `wave-merged` having no mechanical producer is why
nothing else re-checks the merge afterwards.

## D-26 (evidence added) — the predicted miss happened, with the fix sitting five lines away

D-26 predicted that the open S3 on `src/parse.ts`
(`f-task-1a-parse-core-472d9cba`: `EXPORT_PREFIX` applied to the raw line
instead of the trimmed one) could not reach `task-1b-parse-quotes`, the wave-3
task that claims the same file. I dispatched wave 3 without injecting it, on
purpose, and recorded that decision in the `wave-admitted` event (`#30`) so the
run would produce real evidence rather than hide the gap.

It happened, and the shape is worse than "the coder didn't look at a file it
wasn't told about". The coder **rewrote that exact region** and preserved the
bug:

```ts
// before (task-1a, src/parse.ts:40)
const withoutExport = line.replace(EXPORT_PREFIX, '');

// after (task-1b, src/parse.ts:110-117)
const trimmed = rawLine.trim();

if (trimmed.length === 0 || trimmed.startsWith('#')) {
  ...
}

const withoutExport = rawLine.replace(EXPORT_PREFIX, '');
```

The variable was renamed (`line` → `rawLine`), the statement moved 77 lines
down, and `trimmed` — the correct operand, the whole content of the finding —
is computed **five lines above it** and already used on the line in between.
The coder had everything needed to fix this incidentally and did not, because
nothing in the dispatch told it there was anything to fix.

Verified live against the committed rewrite:

```
$ npx tsx -e "parseEnv('  export FOO=bar')"
values = {"export FOO":"bar"}
issues = []
```

Identical to the wave-2 probe. The finding survived a full rewrite of its own
enclosing function.

This upgrades the fix from "nice to have" to "the deferral is actively
lossy": deferring an S3 to epic end assumes the code it describes will still
be there at epic end. When a later task in the same epic claims the same file,
that assumption is already false — the finding now describes a file that no
longer exists in that form, and the operator waiving it at epic end is waiving
a description of deleted code. The batch is stale before it is ever shown.

**Severity revised:** S2 → **S2, but reclassify as correctness rather than
process.** The original framing was "the finding arrives too late to be
cheap". The real framing is "the finding may no longer be true, and nothing
re-checks it". A waiver batch that references rewritten code is not a
deferred decision, it is a decision made on stale evidence.

**Fix (unchanged in mechanism, sharper in urgency):** at dispatch, intersect
open findings' `file_path` against the dispatching task's `claims[]` and
attach the matches as *context, not scope*. Additionally, when a task merges
and its claims cover an open finding's `file_path`, the finding must be
re-verified against the new file state before it can be waived — its evidence
is now provably stale.

**Related:** [[D-14]], [[D-28]] — and note the finding is only reachable at all
if the epic filter works, which [[D-28]] shows it does not.

---

## D-31 — A judge that dies mid-procedure is indistinguishable from a judge that found nothing

**Severity: S1.** Wave 3 dispatched 8 agents (2 coders, 6 judges). **Five of
the 8 stopped mid-procedure** and every one of them signalled `completed` to
the layer above. Not one signalled failure.

Measured, from the task notifications:

| agent | tool uses | final message | file written? |
|---|---|---|---|
| coder task-3-validate | 40 | "One more line to trim." | no envelope, work uncommitted |
| grader task-3-validate | 18 | "Now let's runtime-probe the omission-of-optional-key…" | no |
| reviewer task-3-validate | 18 | *(no result field at all)* | no |
| security-reviewer task-3-validate | 17 | "Import resolution works. Now let's run the prototype-pollution and other probes." | no |
| security-reviewer task-1b (1st) | 17 | *(stopped)* | no |
| security-reviewer task-1b (2nd) | 17 | "Prototype pollution is clean… Now let's check ReDoS timing…" | no |

Every stop lands in the same place: an announcement of the next step. The
agent is not confused and not erroring — its turn simply ends, and the harness
reports the end of a turn as the end of a task. On resume, each one finished
the announced work correctly and in few calls (3, 9, 13, 1).

That is survivable here only because a human was watching. The factory has no
equivalent:

1. **Nothing records that a dispatched judge reported back**, so nothing can
   notice that one didn't. The event pair is declared and neither half fires
   on this path. `dispatch_decision` has exactly one emitter in
   `factory/orchestrator/src` — `quorum.ts:280`, inside `recordJudgeRun()`,
   the external-provider quorum path — so a judge dispatched the ordinary way,
   as a subagent out of the operator session, is never recorded as dispatched.
   Its declared terminal counterpart, `TASK_RESULT_EVENT_TYPE =
   'task-result-recorded'` (`agents-registry.ts:28`), has readers in
   `agents-registry.ts`, `scheduler.ts`, `db/projector.ts` and `db/queries.ts`
   and **no producer anywhere** ([[D-22]]), so even a recorded dispatch could
   not be closed.

   (Corrected while writing the punch list. The first pass of this item said
   `dispatch_decision` "occurs in the repo exactly once outside the dogfood
   log — `event.schema.json:31`, inside a description string … an example in
   prose, not an enum." That is wrong: `grep -rn "event_type:
   'dispatch_decision'" factory/orchestrator/src/` returns `quorum.ts:280`,
   and the registry, projector and queries all consume it. The conclusion is
   unchanged and the mechanism is sharper — the type is real, its producer
   covers only the provider-judge path, and its terminal half has no producer
   at all.)

2. **An absent evidence file is silently an empty one.** `cli.ts:323-329`:
   ```ts
   const findings = flags.evidence ? mintFindings(...) : [];
   ```
   No `--evidence` flag, or a flag pointing at a judge that died: zero
   findings, gate green. The three severity-0 outcomes — *judge ran and found
   nothing*, *judge died before writing*, *judge was never dispatched* — are
   the same value at the gate.

The wave-3 numbers make the cost concrete: had these five not been resumed by
hand, `task-3-validate` would have merged with a green gate, zero findings,
and no grader verdict — while the security review that was actually going to
find the `validateConfig(null, …)` TypeError ([[D-33]]) had stopped one probe
short of finding it.

**Rule candidate:** *a supervisor that cannot tell silence from assent will
eventually mistake a corpse for a quorum.*

**Fix.** Three parts, in order of how load-bearing they are:
- Add a `judge_reported` (or `agent_completed`) event type to the schema and
  emit one per judge, carrying `task_id`, `agent_role`, `round`, and the
  artifact path. Then `gate run` can require one event per dispatched judge
  and refuse to score a task whose dispatch set and report set differ.
- Make the evidence path **mandatory and existence-checked** per dispatched
  judge, so "no file" is an error, not `[]`. Distinguish `--evidence <file>`
  from an explicit `--no-findings <role>`.
- Have the dispatcher re-poke an agent whose turn ended without its declared
  artifact on disk, since the recovery is demonstrably cheap (1-13 tool calls)
  and fully reliable — this run resumed five for five.

**Related:** [[D-30]] (same shape: the layer above trusts a self-report the
layer below never contractually made), [[D-32]], [[D-34]].

---

## D-32 — `--evidence` takes one file and one attribution, but a task has many judges

**Severity: S2.** `gate run`'s evidence flags (`cli.ts:314-351`):

```
--evidence <file> --found-by <role> [--found-by-provider <p>]
```

One file, one role. Wave 3's `task-3-validate` came back with findings from
**two** different judges:

- `reviewer` → 1 S3-minor, a test-gap in `test/validate.test.ts`
- `security-reviewer` → 1 S3-minor, a live totality violation in `src/validate.ts`

To pass both through one gate run they must be concatenated into a single file
under a single `--found-by`, which makes the attribution of at least one of
them false. And attribution is not cosmetic here: it is the input to
same-mistake quorum and to any later "which role catches what" analysis. The
`--found-by-provider` flag exists precisely because the system wants to know
who found a thing — and then the surrounding CLI shape makes it unanswerable
whenever more than one role reports on the same task, which is the normal
case, not the edge case.

Two run-throughs of the same gate would be the honest workaround, but
`gate run` is not idempotent per task-round in a way that makes that safe, and
each run re-executes the full check set.

**Fix:** accept `--evidence` repeatably, pairing each occurrence with the
`--found-by`/`--found-by-provider` that follows it; or accept one file whose
records each carry their own `found_by`. The minting path already writes
per-finding provenance, so this is a CLI-surface limitation, not a model one.

**Related:** [[D-31]] (same flag, the absence case).

---

## D-33 — A judge found the spec wrong, and there is nowhere to file that

**Severity: S1.** `task-1b-parse-quotes`'s security-reviewer returned the first
**S2-major** of the whole dogfood run. Reproduced independently, from the task
worktree at `d5e29cf`:

```
input   : KEY_A="value one\nSECRET_TOKEN=abc123"\nKEY_C=after
values  : {"KEY_A":"value one\nSECRET_TOKEN=abc123","KEY_C":"after"}
issues  : []
SECRET_TOKEN is a key? false
```

A stray unbalanced quote swallows the following line whole. `SECRET_TOKEN`
never becomes a key — a caller reading it gets `undefined` and falls through
to whatever its default is — while the literal text `SECRET_TOKEN=abc123`
rides along inside `KEY_A`'s value to wherever that value is logged or
displayed. Zero issues raised. For a credentials loader that is a real
S2.

**And the implementation is exactly right.** `plan-v1.json`, task-1b:

> "A double-quoted value may span multiple physical lines; the newlines
> between the opening and closing quote are preserved in the value…"

The coder built what it was told to build. The defect is in the *plan*, which
is immutable by construction.

The factory has no route for this finding:

- Findings are keyed by `task_id`. There is no `plan_version`- or
  `criterion`-scoped finding.
- Waivers attach to findings, so waiving it files a spec defect under a task
  that is not responsible for it, and closes it.
- Blocking the gate punishes a coder with a clean diff and no legal way to
  comply — fixing it means contradicting an acceptance criterion, which the
  grader would then score `not-met`.

So the only two mechanical outcomes are *block the innocent* or *lose the
finding*. In this run the finding survives only because it is written down
here, by hand, outside the system.

This is the spec-reviewer's job, and the spec-reviewer ran **before** sign-off
against prose — it could not have run the parser, because the parser did not
exist. The knowledge that this spec clause is dangerous is only obtainable
after the code exists, at which point the spec is frozen and the only role
positioned to notice has already been retired for the epic.

**Rule candidate:** *immutability of the plan is a guarantee to the builder,
not to reality; a system that cannot record "the plan is wrong" will record it
as "the builder is wrong."*

**Fix:**
- Add a finding scope of `spec` — `{plan_version, task_id, criterion_ref}` —
  that is routed to the planner and the operator rather than back to the
  coder, and that does not block the task's gate.
- Let a spec finding be the mechanical trigger for a `plan-version-created`
  amendment, which is the one legitimate way to change an immutable plan.
- Dispatch the spec-reviewer a second time at epic close, on the composite
  behaviour, when the code that the spec describes finally exists.

**Related:** [[D-26]] (findings going stale against moving code), [[D-28]]
(the epic-level join that this would also have to survive).

---

## D-34 — The grader is dispatched, burns a model, writes a file, and nothing ever reads it

**Severity: S2.**

```
$ grep -rn "grader-r\|grader_r\|\.grader" factory/orchestrator/src --include='*.ts'
(no matches)
```

No code path in the orchestrator opens a grader verdict file. The grader runs
before the gates specifically so its rubric result can inform them, and the
result reaches the gates only if a human reads the file and retypes its
conclusion.

The consequence showed up immediately: the two graders in **the same wave,
same role, same prompt template** wrote two different shapes, and nothing
objected.

| file | top-level keys | verdict at | criteria |
|---|---|---|---|
| `task-1b-parse-quotes.grader-r1.json` | `task_id, round, verdict, criteria, notes` | `.verdict` = `pass` | 16, keyed `id/status/evidence` |
| `task-3-validate.grader-r1.json` | `run_status, structured_output, artifacts, token_usage` | `.structured_output.overall` = `pass` | 17, keyed `criterion/status/evidence` |

Both are defensible readings of the role brief — one wrote the verdict, the
other wrapped it in the standard result envelope. Nothing decides between
them, because nothing consumes them. A schema is only load-bearing if
something loads it.

Note this is *not* the same defect as [[D-31]]: there the file is missing and
the gate reads `[]`; here the file exists, is well-formed, contains a real
verdict, and is simply never opened.

**Fix:** give the grader verdict a schema in `factory/specs/schema/`
(`grader-verdict.schema.json`), have `gate run` take `--grader <file>`,
validate it, and treat `verdict: fail` or any `not-met` criterion as a gate
input rather than as prose. Until then, the honest thing to say is that the
grader is an advisory role with a human in its output path — which is worth
saying out loud in the operator guide, because the dispatch reason written
into the event log currently claims it runs "before the gates," which reads
as *feeding* them.

**Related:** [[D-31]], [[D-22]] (queue.ts emitting no events — same family:
a stage whose output has no consumer).

---

## D-32 addendum — dual attribution is reachable, but only by bypassing the CLI

The library can do what the CLI cannot. Calling `mintFindings` twice from
outside the orchestrator and concatenating the results produces correctly
attributed records:

```
$ node mint-dual.mjs task-3-findings.json
f-task-3-validate-01340ede | found_by=reviewer          | S3-minor | workspaces/envkit/test/validate.test.ts
f-task-3-validate-9fb78f53 | found_by=security-reviewer | S3-minor | workspaces/envkit/src/validate.ts
wrote 2
```

which `gate run --findings <file>` then accepts. So the defect is strictly the
CLI surface: `--evidence`/`--found-by` is a 1:1 pair where the domain is 1:N.

Two caveats keep this a finding rather than a workaround:
- It requires importing `factory/orchestrator/dist/findings.js` directly. No
  operator-facing document describes this, and the `--findings` flag's own
  comment scopes it to *"already-minted records (replays, fixtures,
  cross-check re-runs)"* — not the normal multi-judge path.
- It moves minting outside the process that emits the gate events, so the
  provenance the gate records is whatever the external script chose.

**Fix (unchanged):** make `--evidence` repeatable and positionally paired with
`--found-by`. The library is already correct.

---

## D-35 — The result envelope asks the agent for a number the agent cannot observe

**Severity: S2.** `result.schema.json` requires `token_usage` with
`input_tokens`, `output_tokens`, `total_tokens`, and `coder.md:78` restates
the shape. Both wave-3 coders complied — with invented numbers:

| envelope | `token_usage` as written |
|---|---|
| `task-1b-parse-quotes.json` | `{"input": 55000, "output": 12000}` |
| `task-3-validate.json` | `{"input": 60000, "output": 12000}` |
| `task-2-coerce.json` (wave 2, passed the gate) | `{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}` |

Real per-agent totals from the harness, this session:

```
in=14929   out=4335    total=19264
in=100714  out=50601   total=151315
in=373665  out=84363   total=458028
in=453155  out=56641   total=509796
...
```

Not one is round. Every agent-authored figure is round to the nearest 1000 or
5000, and the real coder runs are several times larger than what was claimed.
An agent cannot read its own token meter mid-run; `total_tokens` is doubly
unknowable. So the field has exactly two possible honest values — a fabricated
guess or a zero — and wave 2 chose zero while wave 3 chose the guess. **Both
pass the schema**, because a schema validates shape and never provenance.

This is the same dispatcher/agent split already settled for `agent`,
`provider` and `model_tier` (interview N-1): fields the agent cannot know are
written by the dispatcher, and evidence carrying them is a contract breach
(`ORCHESTRATOR_OWNED_FINDING_FIELDS`, `findings.ts:163-169`). `token_usage`
belongs on that list and is not on it. The wave-3 gate run caught the *key
names* — `schema-check-result` flagged `/token_usage must have required
property 'input_tokens'` — and would have waved through the fabrication
unchanged had the coders spelled the keys correctly, which is precisely what
wave 2 did.

The cost is not cosmetic: `token_usage` is the only per-task cost signal in
the envelope, so any future budget enforcement ([[D-29]]) or
cost-per-model-tier analysis would be built on numbers the agents made up.

**Rule candidate:** *never ask a component for a fact it has no instrument to
measure; it will not refuse, it will estimate, and the estimate will look
exactly like data.*

**Fix:** move `token_usage` into the dispatcher-owned half of the envelope,
add it to `ORCHESTRATOR_OWNED_FINDING_FIELDS`'s result-side equivalent so an
agent writing it is a breach rather than an input, and have the dispatcher
populate it from the harness's reported usage at merge time. Drop the field
from `coder.md`'s output contract in the same change, or agents will keep
filling it.

**Related:** [[D-29]] (the budget block with no consumer — same family: a
number the system records but nothing can act on), [[D-34]].

---

## D-36 — `gate run` reports `schema-invalid` and prints none of the errors

**Severity: S3.** The blocked gate, in full, on stdout:

```json
{"outcome":"blocked","taskId":"task-1b-parse-quotes","reason":"schema-invalid","testResult":null,"blockingFindings":[]}
```

The nine actual validation errors exist, but only in the event log, in the
preceding `schema-check-result` record — the operator has to know that record
exists, then run `event tail` and read past the `gate-outcome` to find it. The
`gate-outcome` payload is `{outcome, reason}` and nothing more.

For `tests-failed` the CLI does return `testResult` inline, so the asymmetry
is not a design position, just an omission on the schema arm.

**Fix:** include the `schema-check-result` errors on the returned outcome for
`reason: 'schema-invalid'`, exactly as `testResult` is included for
`tests-failed`.

## D-37 — The brief hands the judge a *pointer* to the vocabulary, and the vocabulary is checked last

**Severity: S2.** `task-3-validate`'s reviewer tagged its finding
`finding_category: "test-gap"`. There is no such value. The legal nine are
`factory/policies/taxonomy.yml:98-100`:

```yaml
finding_category: [correctness, security, a11y, performance, visual-hds,
                   behavioral-drift, test-coverage, over-engineering,
                   maintainability]
```

`test-gap` is a plausible synonym for `test-coverage`. The judge invented it
because nothing ever showed it the list. Compare the two adjacent lines of its
own brief, `.claude/agents/reviewer.md:78-82`:

```
- `finding_category` — a `finding_category` value from
  `factory/policies/taxonomy.yml`
- `severity` — the canonical string, written out in full:
  `S1-stop-the-line`, `S2-major`, `S3-minor`, `S4-nit`. Bare `"S2"` is
  rejected — the taxonomy has no such value
```

Severity is **enumerated inline**. Category is a **path to a file**. The judge
got severity right and category wrong. No judge brief in the repo enumerates
the nine; the most any of them shows is a single category named inside one
narrow rule:

| brief | of the nine, how many appear |
|---|---|
| `reviewer.md` | 1 — `behavioral-drift`, line 49, for one specific rule |
| `security-reviewer.md` | 0 (hardcodes `security`) |
| `grader.md` | 0 |
| `verifier.md` | 0 |
| `spec-reviewer.md` | 2 — `maintainability`/`security`, line 68, same shape |

(Corrected after re-grepping for the punch list: the first pass of this table
read "0" for `reviewer.md`. One literal is present. It does not change the
finding — a judge asked to pick from nine values is shown one of them.)

The validation timing repeats the same asymmetry. `mintFindings`
(`findings.ts:197-218`) validates **severity** at mint time, canonicalises a
bare `"S2"` to `"S2-major"`, and on failure *enumerates the legal values*:

```
`Finding evidence at index ${index} used unknown severity "${item.severity}". Valid: ${severities.join(', ')}.`
```

`finding_category` gets none of that. It is copied through untouched
(`findings.ts:224,231`) and first checked at **gate intake**, which fails the
entire run with an error that names no legal value at all:

```json
{"error":{"code":"findings.invalid-record","message":"Finding failed schema/taxonomy validation.","details":{"errors":[{"path":"/finding_category","message":"Unknown value \"test-gap\" for taxonomy dimension \"finding_category\"."}]}}}
```

So the field that was spelled out is validated early with a helpful message,
and the field that was a pointer is validated late with an unhelpful one. The
cost of the one-word typo was a full `gate run` — five checks, lint through
build — thrown away after it had already run.

**Fix:** three lines, all cheap. (a) Inline the nine values into every judge
brief exactly as severity already is. (b) Validate `finding_category` in
`mintFindings` beside severity, with the same `Valid: ...` enumeration. (c)
Add the same `startsWith`/synonym canonicalisation severity already enjoys.

**Rule candidate:** *a controlled vocabulary that is referenced but never
shown is a vocabulary the writer will reinvent; validate it where it is
written, not where it is read.*

## D-38 — Five green checks, and not one dependency installed

**Severity: S2 (latent).** `gate run task-3-validate` returned five passing
checks. The worktree's `node_modules` contains this, in full:

```
.vite
.vite-temp
```

No packages. No `.bin`. `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:coverage` and `pnpm build` all resolved their binaries by walking
*up* out of the worktree into **black-smith's own** `node_modules` — the
factory's toolchain, reviewing the factory's product. Wave 1 and 2 worktrees
(`task-0`, `task-1a`, `task-2`) do have real installs; wave 3's two do not.

This run was saved by coincidence. Every version matches exactly:

| tool | envkit declares | what actually ran |
|---|---|---|
| typescript | 7.0.2 | 7.0.2 |
| @biomejs/biome | 2.5.6 | 2.5.6 |
| vitest | 4.1.10 | 4.1.10 |

So the green is, this time, a true green. That is luck, not design. Nothing in
the gate asserts the worktree has its declared dependencies installed, so a
**version-skewed green is indistinguishable from a real one** — and the skew
would be invisible in exactly the situation the gate exists to catch: a
project pinning a compiler or linter different from the factory's.

**Fix:** make "dependencies installed as declared" a gate precondition — a
check that resolves each declared devDependency from inside the worktree and
fails closed if resolution escapes it. Cheapest version: assert
`node_modules/.bin` exists in the worktree before running any check.

**Rule candidate:** *a check that silently borrows its tools from the
inspector is measuring the inspector.*

## D-39 — An unwaivable finding against an immutable plan: the epic cannot close

**Severity: S1.** This is D-33 with the abstraction removed, an exact repro,
and a dead end at the end of it.

`task-1b-parse-quotes` passes all five checks — lint 0, typecheck 0, 115 tests
green, coverage 98.54% statements / 92.95% branches, build 0 — and is blocked:

```json
{"outcome":"blocked","reason":"findings","blockingFindings":[{"finding_id":"f-task-1b-parse-quotes-6e57a62e","severity":"S2-major","found_by":"security-reviewer"}],"quorumEscalations":[]}
```

The S2, reproduced verbatim just now against the real module:

```
values : {"KEY_A":"value one\nSECRET_TOKEN=abc123","KEY_C":"after"}
issues : []
SECRET_TOKEN is a key? false
```

A line that reads exactly like a credential assignment is swallowed into the
previous key's value, silently, and never becomes a key.

The finding is correct. The code is also correct. Acceptance criterion 3
**mandates** the swallowing — the quote closes at the end of the
`SECRET_TOKEN` line, so this is a well-formed multi-line value:

> a double-quoted value spanning at least two physical lines

The security-reviewer offered two remedies. The plan forbids both:

| remedy | blocked by |
|---|---|
| parse `SECRET_TOKEN` as its own key | criterion 3 — multi-line spans must work |
| raise an issue flagging the swallowed line | criterion 1 — *"`ParseIssueCode` gains no new member"* |

Criterion 1 is not a paraphrase; the implementation still reads
`export type ParseIssueCode = 'malformed-line' | 'unterminated-quote';`
(`src/parse.ts:11`), exactly the two members task-1a shipped.

And the finding cannot be set aside, `factory/policies/severity.yml:73`:

> Only S3/S4 findings are ever waived. S1/S2 cannot be waived; they must be
> fixed or the task returns through the escalation ladder

Enforced in code at `findings.ts:432`. So:

- the diff cannot be fixed — every fix violates an immutable criterion;
- the finding cannot be waived — S2 is categorically unwaivable;
- the gate returns exit 1, so the merge queue never admits the task;
- `quorumEscalations: []` — the escalation ladder had no external provider
  enabled, so the one advertised escape hatch did nothing.

**The epic cannot close through its own machinery.** Every remaining exit is
above the factory's head: amend the "immutable" plan to v2, hand-downgrade the
severity (no mechanism exists), or abandon a task whose diff is correct.

The deeper defect is that the factory has exactly one verdict for "this is
wrong" and points it at the builder. The judge found a **specification**
defect — the spec mandates a parser that silently eats credential lines — and
the only slot to file it in was a finding against `src/parse.ts`, whose author
did precisely what the spec demanded.

**Fix:** a `spec`-scoped finding that routes to the planner and the operator
instead of the task gate, blocking the *plan* rather than the diff, plus a
plan-amendment path that does not pretend v1 was immutable. Until that exists,
every spec defect will be recorded as a builder defect and will deadlock at
exactly this point.

**Rule candidate:** *a system that can only blame the builder will deadlock
the moment the plan is what is wrong — immutability of the plan is a promise
to the builder, not to reality.*

## D-40 — The gate's coverage evidence omits exactly the file the criterion names

Task-4-api's acceptance criterion C12 names a file explicitly: *"every file under
`src/**/*.ts`, **`src/index.ts` included**, is individually at or above 80%
lines, statements, functions and branches."* The gate ran `pnpm test:coverage`,
exited 0, and printed this table:

```
File         | % Stmts | % Branch | % Funcs | % Lines
All files    |   98.99 |    94.11 |     100 |   98.97
 coerce.ts   |   96.55 |    94.11 |     100 |   96.42
 parse.ts    |   99.18 |     90.9 |     100 |   99.16
```

`src/index.ts` — the file the task exists to add, and the file the criterion
names — is absent. So is `src/validate.ts`. The operator's honest reading is
that C12 is unverifiable from the gate's own output, and that the per-file
threshold is passing vacuously over unmeasured files.

It is not. The v8 text reporter suppresses rows for files at 100% on every
metric, and both files are at 100%. They *are* instrumented: the "All files"
denominator rises from 179 statements before task-4 to 199 after, and
`--coverage.reporter=json-summary` shows `src/index.ts` and `src/validate.ts`
at 100/100/100/100. With `thresholds.perFile: true` configured, exit 0 is
itself the proof that every included file cleared 80%.

The gate is therefore correct and its evidence is misleading — the worst
combination, because it is invisible until someone checks. Cost here: a full
investigation, including a coverage re-run on the pre-task-4 integration
branch to rule out a regression, before concluding nothing was wrong.

**Fix:** the coverage check should emit `json-summary` and attach
`coverage-summary.json` to the gate outcome, not scrape a human-oriented table
that hides its best rows. Any check whose criterion names a file must produce
a per-file number for that file.

**Rule candidate:** *evidence that omits the subject of the criterion is not
evidence; a gate that proves a claim by exit code alone makes every reader
re-derive the proof.*

## D-31 (evidence added) — the silent judge recurred, and its fragment would have passed as a verdict

Second occurrence in the same epic. The wave-4 reviewer burned 36k tokens over
17 tool calls and returned:

> "Node 22.23.1 available which supports type stripping. Let's write probe
> scripts importing directly from the worktree's compiled or via type-strip."

That is a fragment of its own planning. No artifact was written;
`state/results/task-4-api.reviewer.json` did not exist.

Two things this adds to the original finding.

First, **prompt-level mitigation does not close it.** The dispatch explicitly
named this exact failure mode — *"a previous judge in this epic returned
nothing at all and that is now a tracked defect"* — and it happened anyway, in
the very next wave.

Second, and worse than D-31's original framing: the return value was not
empty. It was fluent, on-topic, technically accurate prose. A factory that
treats a judge's final message as its verdict would have consumed that
sentence as a review and moved on. The only reason it was caught is that a
human read it and recognised planning text rather than a finding. An empty
return is a detectable failure; a plausible fragment is not.

Recovery was identical to the wave-3 instance: `SendMessage` resumed the agent
from its transcript, and it produced a complete, well-evidenced review (`[]`,
with seven attack classes probed and cleared) for 39k additional tokens. The
work had been done both times. Only the reporting was lost.

**Fix (sharpened):** completion must be defined as *the artifact file exists
and parses against the evidence schema*, never as *the agent returned text*. A
judge with no artifact is `errored` regardless of how good its prose was, and
the retry is a transcript resume, not a fresh run — resuming cost ~39k where a
re-run would have cost the full ~36k again and discarded correct work.

## D-41 — A blocking finding against a file the task is forbidden to touch

The wave-4 security reviewer found a real S2-major, and it is not in the diff
it was reviewing.

`src/parse.ts:119` splits on `/\r\n|\n/`. A bare CR is therefore not a line
separator, so a following assignment is absorbed into the previous value with
no issue raised. Reproduced independently through the new public entry point:

- `loadConfig('A=legit\rB=zzz', …)` → `ok: true`, zero errors, `A` holding the
  swallowed text, and `B` silently falling back to its schema default.
- The same inside a double-quoted span, which is the exact construct task-1b's
  S2 fix was written for — `looksLikeAssignment` never runs, because the
  swallowed content was never treated as a physical line.

So this is the task-1b bug class, still open, reachable through the API this
task just shipped. The plan specifies CRLF handling in nine separate places
and bare CR in none.

The problem is where to file it. `src/parse.ts` is not in task-4-api's claims —
C14 pins them to `["src/index.ts","test/index.test.ts"]`, and the claims
checker enforces it. parse.ts belongs to task-1b, merged two waves earlier.
And `intakeAndDecide` applies **no claims-scoping whatsoever**: it blocks
whichever task id was passed to `gate run`. Feeding this evidence into task-4's
gate would have blocked a correct diff on a defect it is structurally
forbidden to fix — an unbreakable deadlock, since the round-2 loop can only
send the finding back to a coder who cannot legally act on it.

Nor is there a correct place to file it. Findings can only be minted through
`gate run <taskId>`; there is no `smith findings raise`. task-1b is merged, so
re-gating it to attach the finding would mean re-running a closed task. **A
real S2 discovered in wave 4 has no home anywhere in the factory's own state.**
It survives only because a human wrote it into this document.

This is D-33 and D-39 seen from a third angle. D-33: the spec was wrong and
there was nowhere to file it. D-39: the finding was unwaivable against an
immutable plan. D-41: the finding is correctly attributed to a *file*, and the
factory has no way to turn that into an *owner*.

**Fix:** resolve a finding's owner from `file_path` against the plan's claims
map, not from the gate invocation. When the owning task is already merged, the
finding opens a follow-up task against the epic and blocks the *epic verdict*
rather than an unrelated diff. Add `smith findings raise` so a finding can
exist without a gate run.

**Rule candidate:** *the task being gated is not the task that owns the defect;
a factory that conflates them either blocks the innocent or loses the finding —
here it would have done both.*

**Status: fixed, 2026-08-07, branch `smith/phase-9/d41-bare-cr`** — routed
through the machinery P9-24 shipped rather than hand-fixed, so the routing
claim was tested on the case that motivated it. `smith findings raise
--evidence <file> --plan factory/specs/active/envkit-config-loader/plan-v1.json`
with no gate run resolved the owner from `src/parse.ts` and found a genuine
tie: task-1a and task-1b both claim that path literally, so it refused to pick
one and opened follow-up `envkit-config-loader/followup-4b70d608` with
`reason: "Two or more tasks claim this file with equal specificity"`. `smith
epic verdict --epic envkit-config-loader --project workspaces/envkit` then
returned `outcome: "hold"`, exit 1, blocking on the follow-up. The sentence
above — "a real S2 discovered in wave 4 has no home anywhere in the factory's
own state" — is no longer true, and the fix is that finding's first tenant
rather than a claim about one.

The bug itself was one expression. `parse.ts:119` now splits on
`/\r\n|\r|\n/`, CRLF first so it yields no phantom empty line; line numbering,
comment termination and task-1b's swallowed-assignment check all derive from
the split, so all four riders closed together. Six tests written red first —
five in `test/parse.test.ts`, one in `test/index.test.ts` asserting the D-41
headline through the public API — then 166/166 pass, typecheck and lint clean
under Node 22.23.1. The fix lives at `8c37519` in `workspaces/envkit`, which
is gitignored and has no remote, so it is local-only by construction.

Routing it also surfaced D-48: the follow-up task this created can be minted
but not advanced. See that entry, and P9-31 in
`docs/specs/phase-9-punch-list.md`.

## D-28 (evidence added) — the predicted deadlock happened, verbatim

With all five tasks merged to `smith/envkit-config-loader/integration`,
`smith epic verdict --epic envkit-config-loader` returned:

```json
{"outcome":"hold","summary":{"tasks":[{"taskId":"envkit-config-loader/task-0-toolchain","taskStatus":"ready"}],
 "nonTerminalTaskCount":1,"openFindings":[],
 "blockers":["Task \"envkit-config-loader/task-0-toolchain\" is not terminal-OK (status: ready)."],
 "mechanicallyReady":false},"reason":"mechanical-blockers"}
```

exit 1. Four of the five merged tasks are not merely unfinished in its view —
they are **absent from it entirely**. The event log records every execution
under a bare id (`task-0-toolchain`, `task-1a-parse-core`, `task-1b-parse-quotes`,
`task-2-coerce`, `task-3-validate`, `task-4-api`); the plan declares them
qualified (`envkit-config-loader/task-4-api`). The verdict reads the qualified
side, finds one lone record that happens to carry a qualified id and was left
at `ready`, and reports a one-task epic that never started.

The failure is worse than a false negative. An epic where every task merged
green and every finding is terminal renders as `nonTerminalTaskCount: 1` and
`openFindings: []` — the two numbers disagree about which epic they are
describing, and the one that looks reassuring is the one that is empty because
the lookup missed, not because the epic is clean.

The epic therefore cannot be closed through its own machinery. That is the
second structural deadlock in this run, and the two are independent: D-41 blocks
the finding from reaching a task, D-28 blocks the tasks from reaching a verdict.

**Fix (unchanged, now urgent):** one id convention, chosen and enforced at the
schema boundary, with a migration for the existing log. Until then
`smith epic verdict` cannot close any epic that ran through the real dispatch
path, which is every epic.

## D-42 — Six green lint gates, and the assembled branch cannot lint at all

Found while collecting closing evidence for the epic: run the project's own
`pnpm lint` on the integration branch, with all five tasks merged, and it exits
1 without examining a single source file.

```
× Found a nested root configuration, but there's already a root configuration.
i The other configuration was found in .../workspaces/envkit.
```

— once for each of the six task worktrees. The code is clean. Move `wt/` out
of the project root and the identical command reports `Checked 10 files in
55ms. No fixes applied.`, exit 0. The defect is the factory's worktree
placement, not any task's diff.

`factory/orchestrator/src/worktree.ts:98` hard-codes it:

```ts
const worktreeDir = path.join(projectDir, 'wt', taskId);
```

Every task worktree is a full checkout **inside the project root**, and every
checkout carries the project's own `biome.json`. A tool that walks down from
the root therefore finds seven root configs and refuses to run. `wt/` is
untracked and absent from `.gitignore`, so `vcs.useIgnoreFile: true` does not
rescue it.

The reason no gate caught this is the sharp part. Every gate runs its checks
with `cwd` set to the task's own worktree (`gate.ts:390`), and from inside
`wt/task-4-api/` the sibling worktrees are not descendants — there is nothing
to discover, so lint is genuinely exit 0. All six gates were correct. The
condition they cannot see is one that only exists at the root they never stand
in. **Green at every task gate, red when assembled**, with no task at fault and
no gate at fault.

It is tool-shaped rather than universal: `typecheck`, `test` and `build` all
pass from the integration root, because tsc and vitest are driven by explicit
config globs instead of a bare directory walk. The trigger is the shape
`<tool> .` run from the project root — which is exactly what a scaffolded
`lint` script is, and exactly what CI would run.

**Fix, in preference order.** (1) Place worktrees as a *sibling* of the project
rather than a child — `workspaces/.wt/<project>/<task-id>` — so no project-root
walk can ever reach them. This kills the whole class. (2) Failing that, have
`smith new` emit `wt/` into `.gitignore` and the scaffold's ignore globs, which
fixes biome specifically and leaves the next tool to rediscover it. (3) At
minimum, run the epic's checks once from the integration root before the epic
can close — the run that would have caught this took eleven seconds and had to
be initiated by hand.

The general lesson is (3), and it generalizes past this bug: **per-task gates
cannot certify an assembled branch.** The factory currently has no check that
ever executes at the integration root. Every quality claim it makes is a claim
about a worktree.

**Scope qualifier, checked rather than assumed:** `wt/` is untracked, so the
integration branch's tree contains no worktree copies and a fresh clone lints
clean. This would *not* have turned CI red. That makes it narrower than it
first appears and also more awkward: the red signal is the operator's local
run of the project's own documented command, and the green one is CI. An
operator who trusts the local run stops to debug a non-bug; one who trusts CI
never learns the local command is unusable. Either way the second half of the
finding is untouched — no check has ever run at the integration root, whatever
that root would have said.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-26-integration-root`** —
fix (1) and fix (3) both landed; see P9-26 in the punch list. Worktrees now go
to `workspaces/.wt/<project>/<task-id>`, and the six envkit worktrees created
before the change were migrated in place with `git worktree move`, so this
finding is no longer reproducible on the dogfood checkout: `pnpm lint` at
`workspaces/envkit` went exit 1 → exit 0 (`Checked 10 files in 29ms`), 159
tests still green. Fix (2) was deliberately skipped — a sibling path makes the
`.gitignore` entry redundant, and (2) was only ever the fallback. The second
half, the one that generalizes, is `smith integration check`: it runs the suite
at the project root against `smith/<epic>/integration` and records an
`integration-check` event pinned to a head sha, and `epic verdict` now blocks
while that record is missing, stale, or failing. Run against this epic's real
branch it reported `pass: true` over lint + test at `8962df9` — the first check
this factory has ever executed at an integration root.

## D-43 — The decision that stops an epic is the one decision that leaves no trace

`runEpicVerdict` (`epic.ts:263`) returns on a mechanical blocker before
reaching its only `appendEvent`, and says so deliberately:

```ts
// Step 1 — mechanical_oracles_first, literally: a deterministic blocker is
// final. Zero judge calls, zero events (read-only projection).
if (!summary.mechanicallyReady) {
  return { outcome: 'hold', epicId: input.epicId, summary, reason: 'mechanical-blockers' };
}
```

As a cost argument this is right: a cheap read-only probe you can re-run at
will should not litter the log. But the same branch is also the terminal
decision for an epic that cannot proceed, and that decision is invisible to the
event log, the projector and the UI. The dogfood epic was held, and nothing
anywhere in factory state records that the verdict was ever run, what it said,
or why. The `go` path is likewise silent when no external providers are enabled
(`epic.ts:274`) — so in the default zero-cost configuration, **both terminal
outcomes emit nothing**, and the only verdict that gets logged is the one that
spent money.

That inverts the property worth having. An epic's close is exactly the moment
you want durable, and the log currently records the expensive path rather than
the decisive one.

**Fix:** keep the read-only probe, but distinguish it from a close. Either an
explicit `--record` flag on `epic verdict`, or a separate `smith epic close`
verb that emits an `epic-closed` event carrying the verdict, the summary it was
computed from, and the blockers if any. Cheap probe stays free; the decision
that ends an epic becomes a fact in the log rather than terminal output that
scrolls away.

**Immediate consequence for this run:** closing the dogfood epic by hand
required hand-writing that event, which is precisely the hand-assembly P9-1
objects to for lessons. The operator appended it as `dogfood-envkit-1#69` on
2026-08-07; the prepared record is committed at
`docs/specs/dogfood-envkit-close-event.json`.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-27-epic-close`** — the
separate-verb option, so `epic verdict` stays the free read-only probe it was
designed to be. `smith epic close --epic <id> --project <dir>` runs the verdict
and then writes it down: `go` emits `epic-closed` with `closed_by: "verdict"`;
`hold` refuses with `epic.close-refused` and exit 1, naming the blockers, and
writes nothing; `hold --override-rationale "<why>"` emits with
`closed_by: "operator-override"`, keeping `machine_verdict`, `machine_reason`
and the blockers it was closed over, so an override is legible as an override
forever. A blank rationale is refused (same forgery class as the empty check
list). Rider from D-45: closing against a session with no log throws
`epic.unknown-session` rather than minting a log whose first line says the epic
is closed. `closeEpic` in `epic.ts`, `epic close` in `cli.ts`, 6 unit + 3 CLI
tests. D-44 below is the other half of the same branch; see P9-27 in
`docs/specs/phase-9-punch-list.md`.

## D-44 — The close event is a fact in the log that no projection folds

Appending `epic-closed` turned out to be necessary and not sufficient, which is
worth stating precisely because it changes the shape of the P9-27 fix.

Verified after the append: `db/projector.ts:543` inserts **every** event into
`eventsRaw` regardless of type, so `dogfood-envkit-1#69` is persisted and
queryable by event type. But the task-status fold — the switch at
`projector.ts:314` — knows exactly seven event types (`task-added`,
`wave-admitted`, `dispatch_decision`, `gate-outcome`, `wave-merged`,
`task-superseded`, `error-logged`) and ends in `default: break;`. `epic-closed`
falls through it. Nothing in `tasks`, nothing in the kanban, nothing in
`stats overview` reflects that the epic is closed.

So the log and the projection now disagree, and the projection is the one every
human-facing surface reads.

**Fix:** P9-27 is two changes, not one. Emit the event *and* give the projector
a case for it — at minimum an epic-level status the kanban and `stats` can
render. A close verb that writes a fact nothing folds is the same failure as
the silent verdict, one layer further in.

**Second-order detail for whoever implements it.** The hand-written event used
`task_id: "envkit-config-loader/epic"`. Every other epic-level event in the
codebase uses `` `${epicId}/${RESERVED_TASK_ID}` `` — and `RESERVED_TASK_ID` is
`'integration'` (`worktree.ts:10`), not `'epic'` (`epic.ts:177,221,284,326`).
The mismatch is inert today only because `epic-closed` never reaches `touch()`.
Add a projector case that calls `touch()` and the unreserved suffix stops being
filtered by the `isReservedRef` guard at `projector.ts:307`, minting a phantom
task row named `envkit-config-loader/epic`. Normalise the id in the fix, and
treat `#69` as a fixture that deliberately carries the wrong one.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-27-epic-close`** — folded
by a separate `foldEpics()` (`db/projector.ts`) into a new `epics` table
(migration `0006_bent_madelyne_pryor.sql`), not by a case in the task-status
switch. That is the point: `foldEpics` keys on `payload.epic_id` and never
touches `task_id`, so it cannot reach `touch()` and structurally cannot mint the
phantom task row this finding warns about — `#69` stays a fixture with the wrong
id, and a test asserts `foldTasks([#69])` is still `[]` while `foldEpics([#69])`
yields the real close. New events use `` `${epicId}/${RESERVED_TASK_ID}` ``.

The projection lie was in two more places than the finding names.
`epicsInFlight` was computed from non-terminal task statuses alone in **both**
`overview()` and `projectSummary()`, so an epic closed by override — precisely
the case where a task legitimately stays non-terminal — would have read as in
flight forever, even with the fold landed. Both now route through one
`inFlightEpics()` helper against the `epics` table, and `overview()` carries a
new `closedEpics[]`. In the UI, closing an epic drops it out of `epicsInFlight`
by design, so the Kanban and Flow pickers now build from `selectableEpics()`
(in flight, then closed newest-first) — otherwise recording a close would make
the closed epic's own board unreachable. An `epic-closed` with no `closed_by`
keeps its row as `closedBy: 'unspecified'` rather than being dropped; dropping
it would leave the epic reading as in flight, which is D-43 again.

## D-45 — A missing required argument is an empty success

`smith event tail` takes its session id as `positional[0]` with a bare cast and
no validation (`cli.ts`, `event`/`tail` branch). Run it without one and it
prints `[]` and exits `0`. An unknown session id does the same. So three
distinct states — *you forgot the argument*, *no such session*, and *the
session exists and is empty* — are indistinguishable, and the two failures both
look like the success.

Found by tripping over it: `event tail --session <id> --limit 2` returned `[]`,
which reads as an empty log. The flag parser only understands `--` flags and
treats the id as positional, so `--session` was consumed as a flag and no
positional remained. The correct invocation is `event tail <id> --n 2`, and it
returns the event fine.

Low severity, but it is the same family as D-31 and P9-11 — silence read as
success — and it sits in the verb an operator reaches for when they are already
unsure what the log contains. **Fix:** `requireFlag` has a positional twin
waiting to be written; use it wherever a positional is cast rather than checked,
and error on a session id with no log file rather than returning an empty array.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-28-require-positional`** —
the twin exists: `requirePositionals(positional, usage, required?)` reads the
argument names out of the usage line's `<placeholders>`, throws
`cli.missing-positional` naming the ones that are missing, and is applied at
all 15 verbs that were casting a positional (plus `queue run`'s three flags,
which moved to `requireFlag`). The session half is `requireSession` in
`events.ts`, wired into the seven log-backed verbs — reader-side and opt-in,
because `readEvents` has to keep answering `[]` for an absent log or
`appendEvent` cannot write a session's first event. Both `event tail` failures
in this finding now exit 1 with a named code; the third state, an
existing-but-empty log, still reports `[]` and 0, because that one is true.
Details and the red-run evidence are in P9-28.

## D-46 — Five of the seven events that drive task status have no producer

This one was found by pulling the thread on D-44, and it is the largest
structural finding of the run. It reframes D-28 as a symptom.

**What the projection says after the close.** `sqlite3 state/smith.db 'select
task_id, task_status from tasks where session_id="dogfood-envkit-1"'`, after a
clean `db rebuild` that applied all 70 events:

```
envkit-config-loader/task-0-toolchain | ready
task-0-toolchain                      | completed
task-1a-parse-core                    | completed
task-1b-parse-quotes                  | merging
task-2-coerce                         | completed
task-3-validate                       | completed
task-4-api                            | merging
```

Six tasks merged — verified against their branch heads, not inferred. The
projection shows four completed, two stuck mid-merge, and one phantom row that
never left `ready`. Every human-facing surface — kanban, `stats`, the UI —
reads this table.

**Why.** The projector's task-status fold (`db/projector.ts:314`) consumes
seven event types: `task-added`, `wave-admitted`, `dispatch_decision`,
`gate-outcome`, `wave-merged`, `task-superseded`, `error-logged`. An exhaustive
sweep of every `appendEvent` call site in `factory/orchestrator/src` (16 of
them, one of which is `cli.ts:292` — the `event append` verb, i.e. a human)
gives the producer set:

| emitter | event types |
|---|---|
| `gate.ts` | `quorum-decision`, `severity-decisions`, `schema-check-result`, `testgate-result`, `gate-outcome` |
| `quorum.ts` | `dispatch_decision`, `judge-verdict` |
| `epic.ts`, `planQuorum.ts` | `quorum-decision` |
| `findings.ts` | `finding-raised`, `finding-suppressed`, `finding-transitioned` |
| `waivers.ts` | `waiver-granted`, `waiver-denied` |
| `lessons.ts` | `lesson-candidate-raised`, `lesson-status-changed` |
| `scheduler.ts` | `recheck-proposed`, `maintenance-proposed`, `growth-review-due` |
| `events.ts` | `edge-recorded` |

Intersect the two sets and **only `dispatch_decision` and `gate-outcome` have a
producer.** `task-added`, `wave-admitted`, `wave-merged`, `task-superseded` and
`error-logged` have none anywhere in the orchestrator. `errors.ts` and
`plan.ts` call `appendEvent` zero times.

Confirmed by actor attribution on this run's log:

```
  2  wave-admitted   actor=operator          3  wave-merged  actor=operator
  1  wave-admitted   actor=operator-skill    3  gate-outcome actor=system
                                             5  gate-outcome actor=operator
```

Every `wave-merged` in the log was typed by a human. So was every
`wave-admitted`. Even `gate-outcome`, which *has* a producer, was hand-written
five times out of eight.

**The three projection defects are all the same defect.** The wave payloads:

```
#2  wave-admitted  ['envkit-config-loader/task-0-toolchain']
#11 wave-merged    ['task-0-toolchain']
#12 wave-admitted  ['task-1a-parse-core', 'task-2-coerce']
#29 wave-merged    ['task-1a-parse-core', 'task-2-coerce']
#30 wave-admitted  ['task-1b-parse-quotes', 'task-3-validate']
#56 wave-merged    ['task-3-validate']
```

The phantom row is `#2` admitting a qualified id that `#11` then merged under a
bare one. `task-1b-parse-quotes` is stuck because `#56` dropped it from a
payload that `#30` had admitted. `task-4-api` is stuck because wave 4 got no
`wave-merged` at all. Three different human omissions, in the three places a
human was the only available producer.

**This is what D-28 actually is.** "Two divergent task-id conventions" is not a
disagreement between two components — it is the absence of any component. No
producer means no convention to diverge from; the id is whatever was typed that
time. Fixing the schema boundary (P9-9) constrains the shape but still leaves a
human as the sole source of the events that move a task across the board.

**Fix:** give the five orphaned types producers. `queue.ts` already performs
the merge and appends nothing — it is the natural home for `wave-merged`;
`wave check` for `wave-admitted`; `plan validate`/plan ingestion for
`task-added`; `errors.ts` for `error-logged`. Then the id in the event is
minted from the plan rather than retyped, and D-28 stops being reachable by
hand. Until that lands, treat the kanban as narrative, not state.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-29-task-status-producers`**
— all five types have producers (`src/taskEvents.ts`, called from `plan ingest`,
`wave check` and `queue.ts`'s `step()`), and `queue run` now refuses to log a
merge without a `--plan` to mint the id from. `error-logged` comes from
`queue.ts` rather than `errors.ts`: `events.ts` imports `errors.ts`, and
constructing an error is not the same event as deciding a task is blocked by
it. Replaying this epic through the producers, with the same bare ids typed
here, yields **6 rows, all `completed`, no phantom** — against the 7/4/2/1 above.
See P9-29 in `docs/specs/phase-9-punch-list.md`.

## D-47 — An unsupported Node version is a segfault, not an error message

Found while running the pre-push checks for this branch, and it cost a full
false diagnosis before it was found. Recorded because the false diagnosis is
the finding.

`package.json` declares `"engines": { "node": ">=22" }`. Nothing enforces it:
there is no `.nvmrc`, no `.node-version`, and no `.npmrc` with
`engine-strict=true`, so pnpm treats the field as advisory. Meanwhile
`better-sqlite3` 13.0.2 ships a single prebuilt binary per platform —
`prebuilds/darwin-arm64.node`, built for NAPI 10. Node 22 exposes NAPI 10;
Node 20.14.0 exposes NAPI 9. Loading it there does not raise the usual "was
compiled against a different Node.js version" — it loads and then dies:

```
$ /Users/…/v20.14.0/bin/node dist/cli.js db rebuild --session dogfood-envkit-1
                                             exit=139   stdout empty  stderr empty
$ /Users/…/v22.23.1/bin/node dist/cli.js db rebuild --session dogfood-envkit-1
  {"sessionsProcessed":1,"eventsApplied":70}  exit=0
```

Exit 139 is SIGSEGV. There is no message on either stream.

**How it presented.** Under Node 20 the suite reports `Tests 3 failed`, all
three `AssertionError: expected 1 to be +0` at `cli.test.ts:181`, plus eight
`Worker exited unexpectedly`. Nothing in that output contains the word
`signal`, `SIGSEGV`, `node`, or `sqlite`. The mechanism is `runCli`
(`cli.test.ts:14-22`): `execFileSync` sets `status: null` and
`signal: 'SIGSEGV'` when a child dies from a signal, and the helper's
`e.status ?? 1` discards the signal and reports a clean exit 1. A crashed
process and a process that exited 1 are indistinguishable to every assertion
in the file. Under Node 22 the same suite is `36 passed (36) / 434 passed`,
exit 0.

**How it was misdiagnosed.** The pre-push run was made with `PATH` exported to
the nvm v20.14.0 bin — the same export used throughout this session to reach
`pnpm`, which is only installed there. Three failing tests were then confirmed
"pre-existing" by stashing the branch's changes and re-running on clean `HEAD`,
which reproduced them exactly. That check was sound and its conclusion —
"not caused by my edits" — was true. It was also useless, because both runs
shared the broken interpreter. An A/B/C isolation matrix over database paths
returned 139 for all three cases, including one that had genuinely exited 0
earlier in the same session under a different `node`. The variable under test
was never the database.

**This is the D-31 family at the toolchain layer.** D-31 is a judge whose
silence was read as success; this is a crash read as a failed assertion. Both
are a caller inferring an outcome from a channel that cannot express the
outcome that occurred.

**Fix (P9-30).** Three cheap layers, none of which requires touching
`better-sqlite3`: add `.nvmrc` pinning 22 and `.npmrc` with
`engine-strict=true` so the wrong runtime fails at install; add a startup
assertion in `cli.ts` that compares `process.versions.napi` against the
minimum the native dependency needs and exits with a named error; and fix
`runCli` to propagate `signal` so a crashed child never again reports as
exit 1. The third is the one that would have made this a five-minute finding.

**Status: fixed, 2026-08-07, branch `smith/phase-9/p9-30-runtime-guard`** — all
three layers shipped, plus a fourth the acceptance run forced: the `cli.ts`
assertion alone left the Node-20 suite failing *unevenly* (SQLite files killed
their worker, the rest passed clean), so the guard also sits at `openDb` and in
a vitest setup file. Under Node 20 the CLI now exits 1 with a named error
instead of 139 with two empty streams. See P9-30 in
`docs/specs/phase-9-punch-list.md` for the layer-by-layer account.

## D-48 — A follow-up task can be minted, but never advanced

Found by using P9-24 and P9-29 together for the first time, on D-41. Each
feature is correct on its own; the pair is not. P9-24 mints a task that is not
in any plan, and every instrument P9-29 built refuses to touch a task the plan
does not contain.

**The claims gap.** `recordReattribution` (`attribution.ts:162-171`) sets the
follow-up's claims to `[routed.input.filePath]` — the single file the finding
named. For D-41 that is `["src/parse.ts"]`. The regression test for a parser
bug does not live in the parser, so writing it is a contract violation by the
factory's own checker:

```
$ smith claims check workspaces/envkit <spec-from-the-task-added-payload>
{"inClaim":["src/parse.ts"],
 "outOfClaim":["test/index.test.ts","test/parse.test.ts"],
 "violation":{"error":"contract.claim-violation","files":["test/index.test.ts","test/parse.test.ts"]}}
exit 1
```

A task created to fix a bug cannot legally prove it fixed it. Every task in the
plan pairs its source file with its test file — task-1a and task-1b both claim
`["src/parse.ts","test/parse.test.ts"]` — so the shape the follow-up needs is
already written down one line away, in the very claims map that resolved its
owner.

**The producer gap, which is the worse half.** P9-29's whole point is that ids
are minted from the plan and never retyped, so `queue run --session` requires
`--plan` and resolves every id through `resolveTaskId` before any git runs. A
follow-up id is by construction absent from the plan:

```
$ smith queue run envkit-config-loader --plan …/plan-v1.json --tasks …
{"error":{"code":"plan.unknown-task",
 "message":"Plan \"envkit-config-loader\" v1 has no task \"envkit-config-loader/followup-4b70d608\".
            Known task ids: …/task-0-toolchain, …/task-1a-parse-core, …"}}
```

`emitTaskSuperseded` resolves through the plan too (`taskEvents.ts:271`), so
that exit is closed as well. The follow-up carries `task_status: "todo"`, which
is not in `TERMINAL_OK_TASK_STATUSES`, so it blocks the epic verdict — by
design, and correctly. But there is no producer that can move it off `todo`.
**The task is a permanent blocker with no legal path to done.** The only way to
clear it today is `smith event append` by hand, which is precisely the disease
P9-29 was built to cure — so the two fixes, applied together, reconstruct the
hand-written board one task at a time.

Neither gap is visible from either feature's own tests. P9-24's suite asserts
that the right task is minted; P9-29's asserts that plan ids are resolved. Both
pass. The defect lives in the sentence neither test states: *a minted task must
also be executable.*

**Where the finding was left, and why.** D-41 was transitioned
`raised → confirmed → fix-pending` and stopped there
(`state/events/dogfood-envkit-followup-1.jsonl`, events `#4` and `#5`).
`fix-landed` is a claim that the fix reached the integration branch, and it has
not: the follow-up cannot enter the merge queue, which is this finding. The two
ways to reach a terminal status today are to merge by hand — against the
guardrail — or to hand-write the terminal event, which is the same disease one
level up. Either would leave the log saying the fix landed while the machinery
that was supposed to land it is still broken. The finding stays at `fix-pending`
and the epic verdict stays held, because a blocked fix that reads as blocked is
the only honest state the log can be in until P9-31 ships.

**Fix (P9-31).** Give the follow-up the claims of the tasks that resolved its
ownership — the union of the candidates' claims when ambiguous, the owner's
claims when resolved, the file alone only when nobody claims it. And give
`resolveTaskId` a second source: a task the log has added is as real as a task
the plan declares, so the queue should accept an id it can find in either. The
acceptance test is this finding's own follow-up running end to end.

**Rule candidate:** *two features that each refuse to guess can still deadlock,
because refusing is not the same as agreeing on who decides; a system that mints
work in one component and validates it in another must share one answer to
"does this task exist", not two correct ones.*
