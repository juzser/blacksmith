# Phase 10 — scope

Phase 9 got a punch list because a punch list is what a finished phase
leaves behind. Phase 10 gets this instead, and gets it first, because the
defect it is mostly about is not a bug in a file — it is that the factory
has never been pointed at itself, and a phase that closes without noticing
that would close on prose.

Every claim below was measured in the clone at `37db1c3`, not quoted from
the document that made it. Where a document and a file disagree, the file
is cited and the document is named as the defect.

## Where Phase 10 actually stands

`factory/specs/roadmap.md` carries `phase-10` at `status: in-progress` with
`epics: []`. Its goal line names three things:

| Goal item | State | Evidence |
| --- | --- | --- |
| Ops runbook | built | `docs/runbooks/ops.md`, 29 KB |
| Background process (`smith daemon`) | built | `factory/orchestrator/src/daemon.ts`; `daemon run\|start\|status\|stop` in `cli.ts` |
| Cloudflare port of the UI | struck to its own milestone, 2026-09-04 | still unspecced; now `cloudflare-port` at `status: planned` in `factory/specs/roadmap.md`, so the deferral is a record rather than a blocker |

So two of three landed and the third was never specced. That decision has
since been made: the third was struck to its own milestone on 2026-09-04.
But `epics: []` still means nothing in the read-model can show progress on
this phase either way. Architecture §16 does not have a Phase 10 at all — it
folds Cloudflare into Phase 9's "Hardening" line — so the roadmap is the only
place this phase exists.

That is the whole of the phase as declared. What follows is what the
evidence says it should also contain.

## P10-1 — The factory has never been switched on for itself

**Evidence.** `state/events/` holds one file, `maint-2026-09-03.jsonl`, and
that file holds one line: a `session-start` with an empty payload. The
derived read-model agrees — `state/smith.db` has 14 milestones and zero
tasks, zero epics, zero agents, zero findings, zero lessons. The daemon's
last pass, `state/daemon/status.json` at `2026-09-03T02:16:47Z`, raised
exactly one finding, and it is about this clone: `unwatched-project`, "This
clone is not in this pass, so nothing is reading its lockfile and no
maintenance proposal can ever name it."

**What it means.** Every instrument this repo built folds the event log:
`wave audit`, `kpi same-mistake`, `budget alarm`, the scheduler, the daemon.
On this clone they all fold one `session-start`. The dogfood evidence is
real, but it lives in `docs/specs/` prose and in a sibling clone's log — not
in a log these instruments can read. So the two axes the operator's mandate
puts last, that the system can maintain itself and its child projects, are
built and unexercised *here*: no epic, no wave, no dispatch, no recheck, no
compiled lesson. The phase table says "Built, merged" eight times, and not
one of those greens was produced by the factory running on this repository.

**The fix shape.** Run Phase 10 as a real epic through `/bs run`, on this
repo, with the items below as its tasks. That is not ceremony: it is the
only thing that converts "built" into "exercised" for the instruments, and
it is the only way `wave audit` ever gets a wave to audit. Add
`--project /Users/ser/scatola/jobs/projects/blacksmith` to the daemon and
scheduler passes so the clone stops being invisible to its own watcher.

**Whose call.** The operator's, and it is the fork that decides the shape of
everything else in this file.

**Settled 2026-09-04 — a real epic, epic id `phase-10`, through `/bs run`.**
The operator took the fork above: Phase 10 runs as a real epic on this repo,
not branch-by-branch the way Phase 9 did. This clone joins the daemon and
scheduler passes by default rather than through a hand-typed `--project`
flag, with `--no-self` as the way out. This is the decision taken, not a
claim that the code has merged — the merged proof is epic AC1 through AC3
and task-6's close-out.

## P10-2 — The guides say both judges ship off; codex is live

**Evidence.** `factory/policies/crosscheck.yml:75` reads `enabled: auto` for
codex, and `:91` reads `mode: active`. `docs/runbooks/providers.md:160-165`
was updated when that happened and states it plainly: "What ships today is
`deepseek: enabled: false` and `codex: enabled: auto, mode: active`." Four
sites in the live guides were not:

- `docs/guide/status.md:24` — "every external ships off"
- `docs/guide/status.md:48-49` — "Both Codex and DeepSeek are `enabled:
  false`"
- `docs/guide/operator-guide.md:2054-2055` — "ships `codex` and `deepseek`
  at `enabled: false`, so neither is invoked at all"
- `docs/guide/operator-guide.md:3307` — same claim, in "Limitations today"

`docs/guide/extending.md:110` describes what the knob does rather than what
this file holds, and is not drift.

**What it means.** This is the fourth repetition of one shape: a document
asserts something about another surface, and nothing reads the two back
together. D-259 caught it in command names, D-265 in error codes, D-267 in
review lenses, D-268 in the language rule. Here the claim is a *value in a
policy file*, and the reader who is misled is the operator deciding whether
their next epic gets cross-checked — a reader who is told "no call, no
spend" while a provider is live on their box.

**The fix shape.** Both halves, or neither is worth doing. Correct the four
sites, and add the fifth guard — read every `enabled:`/`mode:` claim the
live instruction surface makes about a named provider back against
`crosscheck.yml`. Per D-119 it asserts on its own walk as well as on the
repo, since a scanner that reaches nothing passes.

**Whose call.** Mine, on the operator's go — it is a defect with a fix, not
a fork.

**Status: fixed, 2026-09-04, branch `fix/a-value-nobody-read-back`** — the
four sites now state the shipped values, and `docPolicyValues.test.ts` holds
them. Recorded as [[D-269]]. This is the only P10 item shipped ahead of the
fork below, because it is a wrong operational fact in the first document an
operator reads.

## P10-3 — One active judge decides nothing, by construction

**Evidence.** `crosscheck.yml:163` sets `min_providers: 2`. The
operator-guide's own "Limitations today" already says what follows: "one
`mode: active` provider changes no outcomes — `finder_ne_critic` excludes
the claim's finder (the native reviewer today), leaving a below-quorum pool
that escalates instead of deciding; you need two." DeepSeek was off when this
was written, because its key "belongs to a runner, and the repo has never met
one" — true until 2026-09-04, when the operator became that runner. See the
settlement at the foot of this item for what the file declares now.

**What it means.** The mandate's second axis — a cross-prover check so that
no judgement is made in isolation — is installed and not load-bearing.
Codex being active buys recorded disagreement, which is worth having, and
buys zero gating power. The gap is not a bug; it is an unfunded position.

**The fix shape.** Two exits, and they are not equivalent. Fund a second
provider (`DEEPSEEK_API_KEY`, then the calibration pass in
`docs/runbooks/providers.md`), or change the quorum policy so one active
external can gate. The first costs money and sends claims to a second
vendor. The second weakens the rule that made the tier worth building.

**Whose call.** The operator's. Nothing in this repo has standing to pick
either one quietly, and `independent_finder` stays `enabled: false` with
`send_diff: false` regardless of which is chosen.

**Settled 2026-09-04 — fund the second judge, and hold it in shadow.** The
operator chose the first exit and paid for it: `DEEPSEEK_API_KEY` is on this
box and `crosscheck.yml` now ships `deepseek: enabled: auto, mode: shadow`.
`min_providers: 2` is untouched, which is the point — the quorum rule was not
weakened to make a number go green. Getting there needed a defect fixed first:
the key was in `.env`, where the runbook says to put it, and nothing loaded
`.env` into the process that reads it ([[D-270]]). What this buys today is a
second vendor called and recorded on every trigger and counting nothing;
`canDecide` is still `false` and a finding claude raises still falls to the
native verdict. Promotion to `mode: active` is one edit, and it is the
calibration pass in `docs/runbooks/providers.md` §3 that earns it — read the
recorded disagreement first. **This item stays open** until that pass runs:
funding the position is not the same as filling it.

## P10-4 — The Cloudflare port has to be built or struck

**Evidence.** The goal line calls it "deferred and unspecced". No design
exists, no upload path exists, and `.claude/settings.json` deny-lists the
two Cloudflare publish commands for agents. Architecture §16 lists it under
Phase 9, not Phase 10.

**What it means.** A milestone cannot honestly reach `completed` while a
third of its goal line was never designed. Leaving it in place means Phase
10 stays `in-progress` indefinitely and the roadmap stops describing the
state of the work.

**The fix shape.** Either spec it and build it inside this phase, or strike
it from `phase-10`'s goal line and give it a `planned` milestone of its own,
so the deferral is a record rather than a blocker.

**Whose call.** The operator's — this is a scope decision, not a defect.

**Settled 2026-09-04 — struck to its own milestone.** `factory/specs/roadmap.md`
now carries `cloudflare-port` at `status: planned` with the goal line the phase
never wrote, and Phase 10's goal line records the strike instead of carrying a
fourth deferral. The deferral is now a record rather than a blocker, which is
the whole difference: Phase 10 can reach `completed` on what it built.

## P10-5 — `envkit — mcp followup` is the only live test of the fourth axis

**Evidence.** `factory/specs/roadmap.md` carries `envkit-mcp-followup` at
`status: planned` with `epics: [envkit-mcp-followup]` — the only
non-completed milestone besides `phase-10`. Its goal line names three tasks,
two edges, one wave each, and three waivers carried forward from
`envkit-mcp-surface` that it exists to discharge.

**What it means.** "Maintain its child projects" is a claim about time, not
about a single run: the factory has to come back to a project it already
shipped and discharge what the first pass could not claim. This milestone is
that, and it is the only one on the board.

**The fix shape.** Run it. It also serves P10-1 — it produces the epic,
wave, dispatch and finding events that every instrument on this clone is
currently folding zero of.

**Whose call.** Sequencing is the operator's; the plan already exists.

**Settled 2026-09-04 — struck.** The item's premise is false for this
clone: `workspaces/` is empty, the only checkout inside the sibling clone
whose remote resolves to `juzser/maestro` has already run
`envkit-mcp-followup`. The fork this item posed — adopt envkit into this
clone, leave the rows while correcting their goal lines, or strike — was
answered strike. This is task-2's work, recorded as [[D-271]].

## P10-6 — Phase 10 has no epic id

**Evidence.** `- epics: []` on the `phase-10` milestone.

**What it means.** `roadmapPage()` joins milestones to tasks through that
list. An empty list is a milestone that can never show progress, however
much work lands. Phase 9 was built branch-by-branch and its roadmap entry
carries the same emptiness — which was defensible when the factory could not
yet run itself, and is exactly the thing P10-1 says should stop being true.

**The fix shape.** Give `phase-10` an epic id and plan the items above as
its tasks, or record in the goal line that this phase was built by hand.

**Whose call.** Follows directly from P10-1's answer.

**Settled 2026-09-04 — `- epics: [phase-10]`.** `roadmapPage()` joins
milestones to tasks through that list, so an empty list is a milestone that
can never show progress however much work lands. This is task-2's edit,
made as part of planning Phase 10 as an epic.

## Carried, not scope

- **P9-35(b)**, the embedding-similarity novelty gate, stays deliberately
  open — `docs/specs/phase-9-punch-list.md` records why.
- **`selectNav` drops the query scope.** `router.push(item.route)` pushes a
  bare path, so `?session=` and `?project=` are lost on sidebar navigation.
  Recorded in the D-264 addendum as wanting its own finding; still true.
- **The global `smith` shim resolves to the sibling clone.** Both repos
  declare the same `bin` name, so `/opt/homebrew/bin/smith` points at
  `black-smith`. Nothing in this repo's gate depends on it — the tests
  invoke `factory/orchestrator/dist/cli.js` directly — but an operator
  typing `smith` in this directory is driving the other repository.
  Repointing it is a change outside the clone and needs an explicit yes.

## The forks — all four settled, 2026-09-04

They were three, and only the first blocked the rest; a fourth, posed inside
P10-5, was settled the same date. The operator answered all four in one
pass; each answer is recorded at the item it governs, and this is the
index.

1. **Does Phase 10 run as a real epic on this repo, or as branch-by-branch
   items the way Phase 9 did?** — **A real epic, through `/bs run`.** P10-1's
   argument was accepted: an instrument that has never been pointed at
   anything is a claim, not a capability, and the only way to make Phase 10
   the first thing this factory builds for itself is to build it that way.
   This also answers P10-6, which follows from it — `phase-10` gets an epic
   id, and the items above become its task specs. The same decision adds
   `--project /Users/ser/scatola/jobs/projects/blacksmith` to the daemon and
   the scheduler, so the recheck and maintenance proposals the fourth axis
   is made of are computed over this clone rather than over nothing.
2. **Is the Cloudflare port in scope, or struck to its own milestone?** —
   **Struck.** See P10-4.
3. **Is a second judge funded, or does the quorum policy change?** —
   **Funded, and held in shadow.** See P10-3. The third answer the fork
   offered — neither, and axis two stays recorded-but-not-gating — was
   available and was not taken; what was taken is narrower than it looks,
   because a shadow judge still does not vote.
4. **Does `envkit-mcp-followup` get run inside this clone, or struck?** —
   **Struck.** See P10-5. The other two options — adopting envkit into this
   clone, or leaving the rows while correcting their goal lines — were
   available and not taken.

What is left after the forks is P10-1, P10-5 and P10-6, and they are one
piece of work: plan `phase-10` as an epic, run it, and let the events it
emits be the first real input the instruments have ever folded. What is
left after this one is P10-1 and P10-6, which are this epic's work, and
P10-5, which is struck.

## Close-out — this epic's own run, folded, 2026-09-04

This is the record of running this repository's instruments over Phase 10's
own event log — the epic P10-1 argued had never had a real input. It is not
more scope; it is the observation the earlier sections asked for. Every
number below came from a command run inside `smith/phase-10/task-6-fold-
what-this-epic-emitted`, against the host clone's own state, not this task's
worktree: `.gitignore` line 2 is `state/`, so the worktree starts with no
`state/events/` and no `state/smith.db`, and the fold below always names
`--state-dir /Users/ser/scatola/jobs/projects/blacksmith/state/events`
explicitly on every read-side command. That value — the `events/`
subdirectory itself, not its parent `state/` — is what `logPath` in
`factory/orchestrator/src/events.ts` actually joins the flag onto; pointing
it at `state/` instead throws `events.unknown-session`, which is how the
right value was found rather than assumed.

The session read is this epic's own. Listed before anything else was folded:

```
$ ls /Users/ser/scatola/jobs/projects/blacksmith/state/events
maint-2026-09-03.jsonl
phase-10-2026-09-04.jsonl
```

`phase-10-2026-09-04.jsonl` is the log this section folds throughout.

### Event count

```
$ wc -l /Users/ser/scatola/jobs/projects/blacksmith/state/events/phase-10-2026-09-04.jsonl
219 /Users/ser/scatola/jobs/projects/blacksmith/state/events/phase-10-2026-09-04.jsonl
```

219 events (JSONL, one per line — line count is event count). That is well
above the one-line null P10-1 measured at `84cd46f` (a single `session-start`
and nothing else), so the fold below reads the live log, not an empty
default.

### Wave audit — the differential

The null was measured, not assumed, by opening a fresh scratch session (a
`session-start` line and nothing else, the same shape the log held at
`84cd46f`) in a scratch `--state-dir` outside the repository and running the
same command against it:

```
$ node factory/orchestrator/dist/cli.js session start null-test \
    --state-dir <scratch>/events
$ node factory/orchestrator/dist/cli.js wave audit --session null-test \
    --state-dir <scratch>/events
{"waves":[],"serialized":[],"partial":[],"unobserved":[],
 "widest":{"declared":0,"observed":0},"hint":"","exitCode":0}
```

Exit 0, as `summariseWaveConcurrency` only returns 1 for a serialized wave
and 2 for an unobserved one — an empty admission list is neither.

Over this epic's own log:

```
$ node factory/orchestrator/dist/cli.js wave audit \
    --session phase-10-2026-09-04 --epic phase-10 \
    --state-dir /Users/ser/scatola/jobs/projects/blacksmith/state/events
```

Exit 0. Three waves admitted and observed, `"widest":{"declared":3,
"observed":3}`, `"serialized":[]`, `"partial":[]`, `"unobserved":[]`:

- Wave 1 (`#18`): task-1, task-2, task-3 declared, all three observed with
  `startedAt`/`endedAt` pairs — peak 3, verdict `parallel`.
- Wave 2 (`#156`): task-4, task-5 declared, both observed — peak 2, verdict
  `parallel`.
- Wave 3 (`#215`): task-6, task-7 declared, both observed with a
  `startedAt` and `endedAt: null` — peak 2, verdict `parallel`.

The measured widest is 3, at wave 1, matching the plan's number rather than
falling short of it.

**A plan defect, not a task defect.** Task-6's AC1 permits each half of
this differential "quoted or summarised with its numbers intact"; AC4, two
clauses later, demands the same differential be "quoted whole". This
section satisfies AC1: the null half above is quoted whole, and the epic
half is summarised into the wave-by-wave list with every number intact
(widest, declared, observed, per wave). It therefore fails AC4's stricter
wording for the epic half, because AC1 and AC4 state two different rules
for the same output and a single rendering cannot satisfy both. The
defect is in the plan, not in this record:
`factory/specs/active/phase-10/plan-v2.json` is an immutable plan
version, so it is not edited here, and the differential above is not
re-rendered to chase AC4 at the cost of AC1.

### Wave 3 — mid-wave, not graded here

Wave 3 is this task's own wave (task-6 beside task-7), and it is still open
at fold time: both tasks show `endedAt: null` in the audit above, and
`verdictFor` (`src/waveConcurrency.ts:181-187`) reads a `declared 2, peak 1`
shape as `serialized` whenever the sibling's dispatch event has not yet
landed — so any verdict this section drew from wave 3 would turn on dispatch
order, not on the property the check means to assert. What was observed:
declared 2, and as of this fold, 2 dispatch events landed (`#217` for task-6,
`#218` for task-7), so the audit above already reads wave 3 as `parallel`
with peak 2 — but that reading can still flip before both tasks close, and
is not this section's number to certify. Epic AC1's "after the last wave
merges" measurement belongs at epic close, the only point where that phrase
is true; this section states what wave 3 looked like mid-flight and defers
the graded number to the close.

### Read-model — epics and tasks tagged `phase-10`

Rebuilt from this run's own log into a scratch database (never the
worktree's `state/smith.db`, which `scripts/check.sh` — run later in this
task — creates as a test fixture with no relation to this clone's history,
and never the host clone's real `state/smith.db` either, since a `db
rebuild` writes):

```
$ node factory/orchestrator/dist/cli.js db rebuild --db <scratch>/rebuild.db \
    --session phase-10-2026-09-04 \
    --state-dir /Users/ser/scatola/jobs/projects/blacksmith/state/events
{"sessionsProcessed":1,"eventsApplied":219,"skippedFindings":[]}
```

219 events applied, matching the line count above exactly. Reading the
rebuilt projection:

```
$ node factory/orchestrator/dist/cli.js stats overview --db <scratch>/rebuild.db \
    --session phase-10-2026-09-04
```

`"epicsInFlight":["phase-10"]` — 1 epic, in flight, not yet closed
(`"closedEpics":[]`). The `phase-10` milestone entry in the same output
carries `"tasksTotal":10,"tasksCompleted":6"`. `stats kanban --epic phase-10`
breaks the 10 down: 6 `completed` (task-1, task-2, task-3, task-4, task-5,
task-8), 2 `in-progress` (task-6, task-7 — this task and its wave-mate), and
2 `todo` (two operator-facing follow-ups the epic minted, `followup-
bab1a179` and `followup-236629eb`). Against the measured null of zero epics
and zero tasks — nothing tagged `phase-10` existed before this epic ran —
this is epic AC2's evidence: 1 epic, 10 tasks, where there were none.

### Zeros, explained

- `smith epic width --session phase-10-2026-09-04 --state-dir
  .../state/events` returned `{"epics":[],...,"exitCode":2}` with the hint
  "No close read here carried a width. Either these epics were closed before
  `smith epic close` recorded one, or the closes were written by hand." This
  is a true zero, not a wrong-directory zero: `phase-10` has not closed yet
  (confirmed above, `closedEpics: []`), so there is no close record for the
  instrument to fold. Nothing else in this session's history has closed
  either — `epic width` folds close records specifically, not live waves,
  and the wave data above is what a live read of the same log gives instead.
- `smith kpi same-mistake phase-10-2026-09-04 --state-dir .../state/events`
  reported `"totalSameMistake":0` of `"totalDecisions":2`, `"status":
  "unverifiable"`, with the detail: none of the 24 compiled lessons this
  session loaded name a `finding_category` (24 of 24) or are file-scoped (2
  of 24), so none of them can escalate anything a repeat would trip, and 6
  of the session's 8 intakes ran with no escalating lesson loaded at all.
  The zero is a property of the lesson corpus this session had, not of
  whether a mistake repeated.
- `smith budget alarm phase-10-2026-09-04 --epic phase-10 --state-dir
  .../state/events` did not return zero, but did return `"status":
  "unverifiable"`, `"ok":false`, exit 1: 888,509 tokens measured across 7 of
  9 tasks, 1,988,509 projected, against a 2,800,000 alarm and a 4,000,000
  cap — under both, but `budgets.yml` declares no cap for the `planner` and
  `tester` roles, so their dispatches are in neither number, and three tasks
  (task-1, task-2, task-4) measured above the 150,000 the projection charges
  an unmeasured dispatch. Neither hole moves the conclusion here, since even
  the higher, uncapped figure stays under the alarm, but the instrument
  correctly refuses to call that "under" a claim about the record.
- `smith escalation check phase-10-2026-09-04 --state-dir .../state/events`
  returned `"ok":false`, exit 1, with one rung genuinely `"violation"`
  (task-3, rung 3: gated a fourth time after 3 failed rounds with no
  operator answer in between — `coordination.livelock`) and one
  `"unverifiable"` (task-3, rung 2: no builder dispatch recorded for that
  round, so the tier it ran on cannot be read back). This is data, not a
  finding this section raises — see the P10-3 note below on what is and is
  not this task's to act on; it is recorded here because AC7 asks for every
  non-zero output with its numbers intact, not only the zeros.

### Daemon and scheduler — the two instruments the fold missed

P10-1's five instruments are `wave audit`, `kpi same-mistake`,
`budget alarm`, the scheduler, and the daemon. The fold above ran the
first three; these two were run against this epic's own event log to
close that gap, each with `--dir` pointed at a scratch directory outside
this repository so no `daemon.log`, status file or lock lands in the
tree, and `scheduler admit` rather than `scheduler run`, since `admit`
classifies what is due without enacting anything:

```
$ node factory/orchestrator/dist/cli.js daemon run --once \
    --dir <scratch-dir> \
    --state-dir /Users/ser/scatola/jobs/projects/blacksmith/state/events
```

Exit 0. One tick, sessions `[maint-2026-09-03, phase-10-2026-09-04]`.
`maint-2026-09-03` raised one `budget` finding at `info`, "unverifiable:
No epic in this session has a task the log attributes to it" — this
epic's own log is `phase-10-2026-09-04`, and that is where the rest of
this fold stays. `phase-10-2026-09-04` raised five findings: a `budget`
finding at `attention` — "at-risk: 2,016,300 tokens measured across 10 of
11 task(s), 3,236,300 projected, against a 2,800,000 alarm and a
4,000,000 cap"; an `unattributed-spend` finding at `info` — "1
dispatch(es) (planner) name no epic, so their tokens are in no cap.
Attribute them or accept that the session total is a floor" — the same
planner dispatch the budget finding's own "Holes:" clause names; a
`stale-agent` finding at `attention` — "planner (claude/frontier) has
been live for 7.7h with no result, error or supersession — past the 4h
threshold"; and a `maintenance` and a `growth-review` finding, both
`info` and both `operator`-held. The tick's own counters: `attention: 2,
newAttention: 2, autoAdmitted: 0, operatorHeld: 2, projected: 2`.
`newAttention` is 2, not 0 — a first tick against an empty `--dir` has no
prior state to diff against, so every finding it raises comes back
`isNew: true`. No file this run wrote lands in the repository; `--dir`
named a scratch directory outside it.

```
$ node factory/orchestrator/dist/cli.js scheduler admit \
    --session phase-10-2026-09-04 \
    --state-dir /Users/ser/scatola/jobs/projects/blacksmith/state/events
```

Exit 0. Two admissions, both `operator`-held: a `maintenance` proposal
bumping 7 packages at confidence 0.5, below `autonomy.confidence_floor`
0.8; and a `growth-review-due` proposal on the 30-day cadence, held under
architecture §12's rule that a product-growth proposal always waits for
an operator tick. `scheduler admit` classifies only — it enacted neither.

### P10-3 input — crosscheck disagreement, recorded and not acted on

Two `judge-verdict` events fired this epic (`codex`, `mode: active`, and
`deepseek`, `mode: shadow`, both against `phase-10/plan-v1`), and both carry
`"agreement_with_native":false` — two disagreements out of two shadow/active
calls. One `quorum-decision` event escalated (`"outcome":"escalate"`,
`"escalation_reason":"insufficient-providers"`) and one `quorum-adjudication`
followed it, upholding part of deepseek's reading (plan-changed) and
rejecting codex's. This is the only crosscheck activity in the log — no
other `judge-verdict`, `quorum-decision` or `quorum-adjudication` event
appears. Promoting `deepseek` from `mode: shadow` to `mode: active` is the
operator's decision, not this task's or this epic's: the calibration pass
described in `docs/runbooks/providers.md` section 3, "Shadow mode +
calibration procedure", is what earns that promotion, and this epic did not
run it. `factory/policies/crosscheck.yml` was read for this section and not
written; the last commit to touch it (`438b19a`) predates this epic's base
(`d80d1ea`), and `git log` shows no commit inside the epic's own history
touching it either.

### Milestone count after the strike

```
$ grep -c '^- id:' factory/specs/roadmap.md
12
$ node factory/orchestrator/dist/cli.js stats overview --db <scratch>/rebuild.db \
    --session phase-10-2026-09-04
```
— `milestoneProgress` in that output carries 12 entries: `phase-1` through
`phase-10`, plus `cloudflare-port` and `factory-error-log`.

The count measured here is **12**, not the 10 this criterion states as its
expectation. `cloudflare-port` is the eleventh: the operator's decision of
2026-09-04 (recorded in "The forks", above, and in P10-4) struck the
Cloudflare port to its own `planned` milestone rather than carrying it
inside Phase 10, and that strike is itself a row this epic's own scoping
added to the roadmap. `factory-error-log` is the twelfth: commit `1a86f10`
appended `- id: factory-error-log` to `factory/specs/roadmap.md:103` after
this section's count was first written, and nothing here re-derived it
until this task's own run of the `grep -c` command above. The criterion's
expectation of 10 was written before either row existed; the earlier
"14 milestones" statements elsewhere in the repository (measured at
`37db1c3`) are historical and are not edited by this note — this section is
how they are superseded, going forward, without touching what they said at
the time they were measured. Re-run the `grep -c` command above to check
this count rather than trusting it: the file it counts has already grown
once since this section was first written.

### `scripts/check.sh`

Run whole from this task's worktree, in the background (the suite exceeds a
foreground shell's wall clock). Two runs were needed to get an
uncontaminated one: the first redirect landed on a scratchpad path shared
with the concurrently-running wave-mate (task-7), so its `== FAIL ==` (three
e2e failures, `net::ERR_CONNECTION_REFUSED` against the fixed port
`ui/e2e/global-setup.ts` binds) could not be attributed to this task's own
build with confidence and is not this section's number. A second run, to a
path unique to this task, with the port confirmed free
(`lsof -nP -iTCP:4681 -sTCP:LISTEN` empty) immediately before it started,
is:

```
== PASS ==
unit:   Test Files  108 passed (108)  /  Tests  3438 passed | 1 skipped (3439)
server: Test Files    2 passed (2)    /  Tests    40 passed (40)
ui:     Test Files   30 passed (30)   /  Tests   530 passed (530)
e2e:    140 passed (47.6s)
```

No step printed `SKIP`; every step printed `OK`. Counts are at or above the
stated baseline (unit 108 files / 3417 passed / 1 skipped — this run passed
3438, 21 more than the floor, with the same 1 skipped; server 2 files / 40
passed; ui 30 files / 530 passed; e2e 140 passed) on every axis.

### `state/` — nothing committed, nothing written to the log

No command in this fold wrote to the host clone's real event log: the line
count above (`wc -l`) is unchanged before and after this section was
written, and every writing command used a scratch `--state-dir` created
with `mktemp -d`, outside this repository. At the end of this task:

```
$ git status --porcelain state/
```
— empty.

### AC12 — the D number task-2 used

`docs/specs/dogfood-4-findings.md` carries `## D-271 — struck rows keep
their evidence in the record, not the roadmap`, and this file's own P10-5
section already cites `[[D-271]]`. Task-2 used D-271, so this criterion's
conditional does not fire; there is nothing to correct.
