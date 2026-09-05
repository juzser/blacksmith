# Epic spec — `phase-10`

- **Epic id:** `phase-10` (the milestone id and the epic id are the same
  string; `ownsEpic` resolves it either way, and task-2 makes the join
  explicit)
- **Plan:** `factory/specs/active/phase-10/plan.json`, plan version 1, status
  `draft` — nothing dispatches until the operator signs this off
- **Effort tier:** `medium` (`factory/policies/effort.yml`) — spec review to
  clean, plan quorum when triggered, one grader round, verifier on S1/S2, a
  closing spec review, and every mechanical gate untouched
- **Project:** `black-smith` — this clone. The factory and the project under
  construction are the same checkout
- **Shape:** 7 tasks, 3 waves, widest 3

## What this epic is

Phase 10 built instruments and never pointed one of them at itself. Measured
in this clone at `84cd46f`: `state/events/` held one file with one
`session-start` line, `state/smith.db` held 14 milestones and zero epics,
zero tasks, zero agents, zero findings and zero lessons, and the daemon's
last pass raised exactly one finding — `unwatched-project`, about this clone.
Every instrument the repo built folds that log. On this clone they all fold
one line.

So this epic is not primarily a set of file changes. It is the first run of
the factory against itself, and its file changes are the ones that run
produces: a clone that its own watcher can see, a roadmap that stops
declaring a project it cannot reach, a register that says what it cannot
find, and a record of every decision taken along the way. The artefact that
matters most is the event log the run emits, because it is the first real
input the instruments have ever folded.

Two things follow from that and are stated here so they are not mistaken for
padding. First, every task is dispatched to `coder`, and there are two
separate reasons, because one argument does not cover both cases.

The prose tasks (2, 3, 5, 7) are not sent to `scribe` for a budget reason:
`factory/policies/budgets.yml` prices `coder`, `researcher` and the judges and
deliberately prices no `scribe`, so an epic that ran its documentation through
`scribe` would report *unverifiable* rather than under budget — an epic whose
purpose is to be measured should not choose the role the measurement cannot
price. That is an observation about `budgets.yml`, not a change to it.

Task-6 is `case: research` and is *not* sent to `researcher`, and the reason
is capability, not price. `budgets.yml:153-154` does price `researcher`, at
`cap_tokens: 60000`, so a pricing argument would be simply wrong here — an
earlier draft of this spec made it, and spec review caught it. The real reason
is the template: `.claude/agents/researcher.md` declares
`tools: Read, Grep, Glob, Bash, WebFetch, WebSearch` — no `Write`, no `Edit` —
and task-6 must commit a diff to `docs/specs/phase-10-scope.md`. `scribe` is
`tools: Read, Grep, Glob, Write`, so it could write the section but could not
run `scripts/check.sh`, which every task here owes. Folding the instruments is
research in its `case` and builder work in its hands, so it goes to `coder`
and is budgeted at the coder shape. A planner reading this epic as precedent
should take that sentence, not `case: research always means coder`.

Second, the waves are wide because the instruments need a wave to audit, and
they are wide on real claim boundaries — three files no other task in the
round touches — not by splitting one change in half. Where two tasks do look
alike (5 and 7), the reason they are two is written down below and is an
ordering argument, not a width one.

## Goal-clause coverage

`node factory/orchestrator/dist/cli.js epic goal --epic phase-10` returns six
clauses and digest `72112f1a441a6790`. Clause numbering is that command's
order.

| Clause | Coverage |
| --- | --- |
| 1 — "The three items Phase 9 carried on its goal line." | **Out of scope, retrospective.** It names what the phase inherited, not an obligation. No task. |
| 2 — Ops runbook built; `smith daemon` built as a watcher | **Out of scope as a deliverable, in scope as a document.** Both shipped (`docs/runbooks/ops.md`, `factory/orchestrator/src/daemon.ts`). Tasks 1 and 4 edit the runbook only where their own change makes a sentence false. |
| 3 — The daemon never dispatches, never enters the merge queue, never writes outside `state/daemon/` and the derived read-model | **A constraint, not a deliverable.** Carried as epic AC9 and as a nonfunctional clause on tasks 1 and 4. |
| 4 — Cloudflare struck to `cloudflare-port` on 2026-09-04 | **Out of scope, settled.** The milestone exists at `status: planned`. AC9 forbids reopening it. |
| 5 — The six P10 items run as a real epic on this repo | **This plan.** P10-1 → tasks 1, 4, 6 (AC1-AC3, AC6); P10-5 → task 2 (AC5); P10-6 → tasks 2, 3 (AC4); P10-2 → shipped, D-269; P10-3 → out of scope, reason below; P10-4 → struck. |
| 6 — P10-2 shipped ahead as `fix/a-value-nobody-read-back` (D-269) | **Out of scope, done.** `docPolicyValues.test.ts` guards it and AC8 runs it. |

### P10-3, and why it is out of scope with its input produced here

P10-3 is settled and open: the second judge is funded and held at
`mode: shadow`, and what remains is the calibration pass in
`docs/runbooks/providers.md` §3, which reads *recorded disagreement* before
anything is promoted. There is none on this clone — that is the same measured
fact as P10-1's. Running the pass inside this epic would mean reading a
corpus this epic has not finished producing. So task-6 records what
disagreement this run emitted, as the input a later pass can read, and
promotion to `mode: active` stays the operator's decision. AC9 forbids
touching `crosscheck.yml`.

## The P10-5 fork — answered, and what it settles

The fork was: this clone declares `envkit` and cannot reach it. Measured —
`workspaces/` is empty, the only envkit checkout on this box is inside the
sibling clone `black-smith`, whose remote now resolves to `juzser/maestro`,
and `envkit-mcp-followup` has already been run there (branch
`smith/envkit-mcp-followup/integration` at `924bab0`, four merged `task-*`
branches, `plan-v1.json` and `plan-v2.json` on disk).

**The operator answered on 2026-09-04, event `phase-10-2026-09-04#4`: option
one, strike the rows**, the way `cloudflare-port` was struck. The two options
not taken are on the record: adopting envkit into this clone, and leaving the
four rows while correcting their goal lines.

- It is **task-2**, and only task-2.
- **P10-5 is out of scope as work.** Nothing here runs
  `envkit-mcp-followup`; it already ran, in another factory.
- The strike must be a record, not a deletion. Three of the four milestones
  are `completed` and carry the only roadmap-level evidence that this
  factory's dogfood runs happened. Task-2 preserves every struck line
  verbatim in decision record D-271 **in the same commit as the removal**,
  because between a deletion and a later record there is a state where the
  evidence lives in git history alone, and this plan does not ship that
  state. AC5 is written so a grader can tell "struck and recorded" from
  "struck and lost".
- If the operator changes the answer to *adopt* at sign-off, that needs a
  **plan v2**: acquiring a checkout is work no task here covers.

## Acceptance criteria

Graded at `/bs run` step 14 and by `smith epic verdict`. Where a criterion is
differential, the text under the null and the text under the hypothesis are
both stated, because two identical texts would make it vacuous.

**AC1 — The instruments fold a real wave.** After the last wave merges,
`smith wave audit` over this epic's session log exits 0 and reports at least
3 waves with a widest of at least 3. Under the null — the log as it stood at
`84cd46f` — the same command prints `waves: []`, `serialized: []`,
`partial: []`, `unobserved: []` and `widest` declared 0 / observed 0, and
exits **0**, not 1: `summariseWaveConcurrency`
(`src/waveConcurrency.ts:326-343`) returns 1 only for a serialized wave and 2
only for an unobserved one, and an empty admission list is neither. Measured,
not assumed — an earlier draft asserted exit 1 and spec review ran the
command. The differential survives the correction, because zero waves and
three waves are still two different texts.

Evidence is owned in two places, deliberately. Task-6's close-out quotes the
null and the waves it can observe — 1 and 2, complete — and labels wave 3
mid-wave. The after-the-last-merge number is graded at the **epic close**,
which is the only point at which that phrase is true. The alternative was to
leave AC1 with task-6 under a stated precondition; it was not taken because
task-6 runs inside wave 3 alongside task-7, and `verdictFor`
(`src/waveConcurrency.ts:181-187`) reads wave 3's `declared 2, peak 1` as
`serialized` until task-7's dispatch lands, so the criterion's exit code
would turn on dispatch order rather than on the property it asserts. A
criterion that flips on luck is not a criterion.

**AC2 — The read-model holds this epic.** A rebuild of `state/smith.db` from
this run's log reports at least 1 epic and 7 tasks tagged `phase-10`. Under
the null, measured at `84cd46f`: 0 epics, 0 tasks, 14 milestones.

**AC3 — This clone is watched without an operator typing its own path.** A
daemon tick run with no `--project` flag and a scratch `--state-dir` raises
no `unwatched-project` finding whose subject is
`/Users/ser/scatola/jobs/projects/blacksmith`, and the same tick run with
`--no-self` raises none either and reads no lockfile for it — the second
clause gated by a task-1 test that asserts the tick's project list under
`--no-self` does not contain `REPO_ROOT`, so suppressing the finding while
still opening this clone's lockfile fails. Under the null,
`state/daemon/status.json` at `2026-09-03T02:16:47.709Z` holds exactly one
finding: kind `unwatched-project`, severity `attention`, that subject.
A child project the roadmap declares, with a checkout, named by no flag is
still reported — unchanged, and asserted by a test.

**AC4 — Phase 10 can show progress.** `factory/specs/roadmap.md`'s
`phase-10` milestone declares `- epics: [phase-10]`, and
`epic goal --epic phase-10` still digests to `72112f1a441a6790` — the goal
line is byte-identical, so no recorded spec-vs-goal check goes stale. Under
the null: `- epics: []`, which `roadmapPage()` joins to zero tasks however
much work lands.

**AC5 — The strike is recorded, not lost.** The four `- project: envkit`
milestones are absent from `factory/specs/roadmap.md` (milestone count 14 →
10) and `docs/specs/dogfood-4-findings.md` holds `## D-271` carrying every
removed line verbatim in a fenced block, plus the argument, the event id, and
the two options not taken. The differential a grader runs: `git show` of the
removal diffed against D-271's fenced block is empty. Under "struck and
lost", that diff is four milestones long.

**AC6 — The register stops lying by omission.** Given a roadmap that declares
a project with no checkout under either root, `smith projects list` reports
it as declared-and-missing, distinguishably from a resolved project, keeps it
out of the pasteable `--project` line, and exits 0. Under the null the same
input prints only the resolved rows — output identical to a roadmap that
never declared it. Graded on a fixture roadmap, because AC5 removes the live
instance from the shipped one inside this same epic.

**AC7 — Every decision is on the record.**
`docs/specs/dogfood-4-findings.md` gains D-271 (the strike), D-272 (the
watch-self default) and D-273 (the inventory/alarm split);
`CHANGELOG.md`'s `## Unreleased` names the landed work keyed to `phase-10`;
`docs/specs/phase-10-scope.md` carries settlement paragraphs on P10-1, P10-5
and P10-6 that append to the measured evidence rather than rewriting it. The
five doc guards (`docCommands`, `docErrorCodes`, `docLenses`,
`repoLanguage`, `docPolicyValues`) pass — over the instruction surface, which
`docs/specs/phase-10-scope.md` is inside and `CHANGELOG.md` and
`docs/specs/dogfood-*` are not: `recordOfThePast()`
(`test/helpers/instructionSurface.ts:53-60`) excludes them and
`docCommands.test.ts:421-422` asserts that exclusion by name. So the guard
cannot catch an invented `smith` verb in D-271, D-272 or D-273, and tasks 2,
5 and 7 each resolve every invocation they quote against
`node factory/orchestrator/dist/cli.js --help` themselves and record the
check. Task-6's section *is* inside the surface, so its quoted command lines
are parsed, flags included.

**AC8 — The gate is green on the assembled branch.** `scripts/check.sh` runs
whole; no step that was OK at `84cd46f` degrades to SKIP; suites report at
least their baselines — unit 108 files / 3417 passed / 1 skipped, server 2
files / 40 passed, ui 30 files / 530 passed, e2e 140 passed — with the counts
recorded verbatim. A count below baseline is a finding, never an adjusted
expectation.

**AC9 — Nothing widened.** No file under `factory/policies/` and no
`.claude/agents/` template changed; `crosscheck.yml` still ships `deepseek:
enabled: auto, mode: shadow` and `min_providers: 2`; the daemon still
dispatches nothing, enters no merge queue and writes nothing outside
`state/daemon/` and the derived read-model; no runtime state under `state/`
is committed; `cloudflare-port` is not reopened.

### How task-6 reaches the log it folds

`.gitignore` line 2 is `state/`, so the isolated worktree task-6 runs in
contains no `state/events/` and no `state/smith.db`. Instruments invoked with
their defaults there would fold an empty directory and return zeros that read
exactly like real ones — a well-formed wrong answer, D-133's shape, in the one
epic built to end it. So the task spec pins the mechanism rather than leaving
it to the coder: the session is `phase-10-2026-09-04`, confirmed by listing
the host clone's event directory first; every read-side invocation carries
`--state-dir /Users/ser/scatola/jobs/projects/blacksmith/state` explicitly
(all six commands accept it — `usage.ts` lines 156, 380, 461, 468, 513, 707);
writes still go to a scratch state dir outside the repo. And the section may
not be written at all unless the folded event count is quoted and exceeds the
null of one `session-start` line.

## Design judgements this plan makes

Both are the planner's calls, both must be argued in the task and beaten in
review if they are wrong, and both have a record task attached so the reason
survives the diff.

1. **This clone joins every daemon and scheduler pass by default (task-1).**
   `factoryProjects()` already returns it unconditionally as `self: true` —
   "the one entry that needs no roadmap and no search to be certain of" — so
   the flag an operator is nagged to type carries no information the process
   lacks, and an alarm whose only remedy is to restate a known fact is the
   alarm `docs/runbooks/ops.md` §3 argues trains you to stop reading. What
   the change must *not* touch is the header's first rule: this clone is
   `REPO_ROOT`, never a name lookup. And because a default nothing can refuse
   is policy baked into code, `--no-self` is part of the task, spelled the
   way `--no-db` already is.
2. **`smith projects list` reports a declared project it cannot find; the
   daemon still does not (task-4).** The header's rule — a declared project
   with no checkout is reported by nothing, because the finding would be one
   an operator cannot act on and can never clear — is an argument about an
   *interval alarm*. It is not an argument about a human-invoked inventory,
   which was asked a question and should answer it. This repo carrying four
   unreachable `- project: envkit` rows until somebody went looking is the
   evidence; `smith new` writes such a row for every project it scaffolds, so
   the state recurs by construction. Task-4 is `origin: inferred`,
   confidence 0.85, and it exists to protect AC6.

### Why tasks 5 and 7 are two tasks

They look like one task twice: same two claims, same shape — append a decision
record, verify a sibling's merged diff, extend `## Unreleased`. The split buys
no width worth having, and this spec will not pretend it does: a one-task wave
verdicts `single` under `waveConcurrency.ts:181`, never `serialized`, so
`smith wave audit` stays green whether wave 2 carries one task or two.

The reason is ordering. D-272 records task-1's behaviour and verifies it
against `cli.ts` and `projects.ts` on a branch task-4 has not yet re-edited,
so what it quotes is task-1's change and nothing else. Merged into wave 3, the
same verification would read both changes at once and could no longer say
which produced which behaviour — and the epic whose point is trustworthy
records would ship two records written against a state neither of them
describes. The alternative, one wave-3 record task writing D-272 and D-273
together, is cheaper by a dispatch and a merge; it was not taken for that
reason alone.

## Claims map and wave shape

`factory/orchestrator/src/cli.ts` is the hub file and is
**`serialize-always`**: it holds the scheduler's flag read (1550, 1607), the
daemon's (1653) and `projects list` (1764-1779). Exactly two tasks claim it,
tasks 1 and 4, and they are in different waves with a declared
`claim-order` edge — never a concurrent claim.
`factory/orchestrator/src/usage.ts` is the second hub and gets the same
treatment, claimed by the same two tasks across the same edge. It is in the
plan at all because `docCommands.test.ts:214-219` resolves every flag it
parses out of the instruction surface through `flagSpecFor()`: task-1 writes
`--no-self` into `docs/runbooks/ops.md`, and a flag documented but not
declared fails the guard AC8 runs. Task-4 claims it for its `projects list`
summary, and may leave it untouched if nothing there became false — stated as
a decision rather than discovered mid-flight as `error.spec.spec-gap`.

One correction is assigned across a task boundary on purpose:
`docs/runbooks/ops.md:88` offers `--project . --project workspaces/envkit` as
the worked example of watching a child project, and lines 109-124, 185 and 470
quote `dogfood-envkit-1` output. Task-2's strike is what falsifies those, but
task-2 does not hold the claim and tasks 1 and 4 are otherwise bound to touch
the runbook only where their *own* change made a sentence false — so nobody
would have owned it. **Task-4 owns it**, by name, in its own criteria: after
the strike this clone declares no child project at all, so the example becomes
plainly illustrative or is marked historical, and the epic does not close with
a runbook aiming `--project` at a checkout that does not exist for a project
the factory just disclaimed. The same treatment is given to
the other three shared files: `docs/specs/dogfood-4-findings.md` (tasks 2, 5,
7 — the D-record collision is real, so the three are in three different
waves), `CHANGELOG.md` (tasks 5, 7) and `docs/specs/phase-10-scope.md`
(tasks 3, 6).

| Wave | Tasks | Disjoint on |
| --- | --- | --- |
| 1 | task-1, task-2, task-3 | orchestrator sources + runbook / roadmap + findings / scope doc |
| 2 | task-4, task-5 | orchestrator sources + runbook / findings + changelog |
| 3 | task-6, task-7 | scope doc / findings + changelog |

`smith wave schedule` must report `rounds: 3`, `widest: 3`. A `widest: 1`
plan would make `smith wave audit` exit 1 on the very log this epic exists to
produce.

## Budget

Declared task budgets sum to **530,000** tokens against an epic cap of
4,000,000 with the alarm at 2,800,000 (`factory/policies/budgets.yml`). Judge
dispatches are not in that sum: at `medium`, roughly three judge calls per
task at the 40,000 cap adds about 840,000, so the projection is near
1.4M — and that projection is a **floor**, not a total. Roles this epic will
dispatch that `budgets.yml` prices at nothing (merger, tester,
security-reviewer, the planner itself) are spend the alarm cannot attribute,
so `smith budget alarm` may report this epic *unverifiable* rather than
under. If the alarm fires at 70%, the response is to re-plan the remaining
tasks to fit or to ask — never to extend the cap, which is the operator's
call alone.

## What would need a plan v2

- The operator changing the P10-5 answer from *strike* to *adopt*.
- Task-1 or task-4 discovering that the change cannot be made without
  touching `factory/orchestrator/src/scheduler.ts` or a file outside its
  claims: that is `error.spec.spec-gap` back to the planner, not a widened
  claim.
- `smith wave schedule` reporting a widest below 3, or `wave check` refusing
  a wave: the slice is wrong and a new version cuts it again.
