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
