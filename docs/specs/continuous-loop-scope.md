# Continuous loop — scope

<!-- PLANNED-NAMESPACE: loop -->

This file specifies `smith loop` before it exists; the marker above tells
`docCommands.test.ts` so, and fails the day the CLI declares the namespace.

Requested by the operator 2026-09-07, in two sentences that split the work in
half and must not be collapsed back together:

> Blacksmith itself, the factory, needs to run internally on my machine, and
> self-improve only on my machine. Build the mechanism yourself, and do not
> limit the budget.
>
> `bs audit` and maintaining outside projects can follow option A. But the
> user needs to trigger it through a command.

Two mechanisms, one bridge, and a list of things that do not move. This file
is the scope the epic is cut from; it decides shape and boundaries, not
implementation.

## 1. What is already built, and the one link that is missing

The chain from "something is due" to "an agent is working on it" exists
almost end to end, and it has exactly one hole:

| Link | Host | State |
| --- | --- | --- |
| A process that outlives the terminal | `smith daemon run\|start` | built |
| Detect what is due | `smith scheduler run --dry` | built |
| Decide who says yes | `smith scheduler admit` + `autonomy.ts` | built |
| **Turn an admitted proposal into a running wave** | — | **missing** |
| Run one wave, worktrees through merge queue | `/bs run` + `wave.md` | built |
| Merge the PR | a person | built, and stays a person |

The missing link is missing for a technical reason, not an oversight.
Dispatch is a playbook that an interactive Claude Code session executes with
the `Agent` tool; `smith` is a Node CLI and cannot call `Agent`. No amount of
TypeScript in this repo can start a dispatch. That is the same fact that
answered Docker and service-exposure with "no" in
[`plugin-port-scope.md`](plugin-port-scope.md).

## 2. The bridge: a headless session is a dispatching node

Claude Code in print mode (`claude -p`) is a real session: it loads the
project's skills and it holds the `Agent` tool. Probed on this machine
2026-09-07 — `claude` 2.1.263, `claude -p --permission-mode plan --max-turns
3` returned `bs=yes Agent=yes`, exit 0.

So the executor is a child process, not a new dispatch engine:

```
smith loop <action>
  └─ spawn: claude -p "/bs run <epic>"   ← this session holds Agent
       └─ Agent(wave-runner) …          ← the existing playbook, unchanged
```

Nothing about `/bs run`, `wave.md`, the gates, the merge queue or the event
log changes. The loop supplies a session where the playbook already knows
what to do; it does not reimplement the playbook.

`delegation.yml` already contemplates this shape: `wave-runner` is the one
role granted `Agent`, and a grantee opening its own session via `smith
session start <id> --continues <dispatch-event-id>` is a real dispatching
node with a real log. A headless session is that, spawned by a process
instead of by an operator.

## 3. Mechanism A — the factory's own self-improvement loop

**Scope: this machine, this checkout, unattended, unbounded budget.**

### 3.1 It is not the daemon

`daemon.ts` opens with a refusal, and it is load-bearing:

> This daemon never dispatches an agent, never merges, never writes to a
> worktree … and a process that survives the operator's terminal is the last
> place to relax that.

The loop does not relax it. `smith loop` is a **separate process** with a
separate lock, separate directory and separate lifecycle. The daemon keeps
watching and keeps not dispatching. Nothing is added to `daemon.ts`, and the
sentence above stays true after this epic as it was before it.

The reason to keep them apart is not tidiness. The daemon's whole safety
case is that its write surface is `state/daemon/` plus a derived SQLite
read-model — both gitignored, both deletable, neither able to touch a
worktree. Folding a dispatcher into it would make that sentence false and
retire the only cheap answer to "what can the always-on process do to my
repo?"

### 3.2 Shape

```
smith loop run     [--interval <s>] [--once] [--dir <dir>] [--max-turns <n>]
smith loop start   [--interval <s>] [--dir <dir>]     # detached, logs to <dir>/loop.log
smith loop status  [--dir <dir>]
smith loop stop    [--dir <dir>]
```

One iteration:

1. `scheduler run --dry` — what does the log say is owed.
2. `scheduler admit` — classify each proposal `auto` or `operator`.
3. Every `operator` proposal is **reported and skipped**. The loop never
   promotes one; `autonomy.ts` can only deny, and the loop must not become
   the branch that grants.
4. For each `auto` proposal, spawn one `claude -p` child carrying the `/bs
   run` prompt for its epic, with a fresh session id, and record a
   `loop-iteration-started` event before the spawn and its outcome after.
5. Wait for the child. Fold what it wrote. Sleep the interval. Repeat.

Serial by default: one child at a time. Fan-out inside a wave is the
playbook's business and is already bounded by the claim graph; a loop that
runs two epics at once would put two merge queues against one integration
branch, which is a coordination error the factory has a name for.

### 3.3 Local-only, and how that is enforced rather than promised

"Self-improve only on my machine" is a constraint that has to survive the
plugin port, where Blacksmith becomes something other people install. Three
enforcements, none of which is a comment:

- **A marker outside version control.** The loop refuses to start unless
  `state/loop/enabled` exists. `state/` is gitignored and is declared runtime
  output (AGENTS.md, "declarations vs state"), so the marker cannot travel in
  a clone, a tarball or an npm package. A fresh clone of this repo has the
  code and does not have permission to run it.
- **Self only.** The self-improve loop targets `REPO_ROOT` and nothing else.
  `projects.ts` already treats the factory's own checkout as `REPO_ROOT`
  rather than a name lookup; the loop reuses that and refuses a `--project`
  pointing anywhere else. Outside projects are mechanism B, which is
  operator-triggered by design.
- **Excluded from the plugin package.** `plugin-port` must not ship `smith
  loop`'s self-improve path. This is a dependency between the two milestones
  and is recorded in both.

### 3.4 Budget: unbounded, and where the number goes

The operator's decision is explicit — no budget limit for the factory's own
loop. Implemented as **a per-epic budget override**, not as a raised global
cap. `budgets.yml` already names the absence of one as a follow-up worth
having, in its own words:

> there is no per-epic override, so a number raised for one epic is raised
> for every epic black-smith will ever run

So: `epic.cap_tokens` gains an optional per-epic override, the self-improve
loop sets it to unbounded for the epics it starts, and every other epic keeps
the 4,000,000 cap and the 0.7 alarm ratio exactly as they are. A decision
made for one loop does not silently widen the factory.

Unbounded means `smith wave check` will not refuse a wave of the loop's own
epics on cost. It does **not** mean unmeasured: `smith budget alarm` still
counts spend and still reports it, and `smith loop status` surfaces the
running total. The operator asked not to be stopped, not to be blinded.

### 3.5 Where the loop stops

At the merge queue. The headless session runs the wave, passes the gates,
and opens the PR. **A person merges it.** The operator waived the budget
ceiling and said nothing about this one, and `scheduler.yml` records it as
the reason auto-dispatch was safe to switch on in the first place:

> PRs are still merged by a person, which is the backstop that makes this
> safe to widen.

Also unchanged: `growth-review-due` is denied ahead of the whitelist
(architecture §12 keeps scope with the operator, unconditionally), and any
proposal whose claims or package names match a `crosscheck.yml` security
keyword waits for a person whatever its confidence.

The honest description of mechanism A is therefore not "a factory that never
stops". It is: **the operator's tick is removed from everything between "this
is due" and "here is a PR", and kept for the PR.**

### 3.6 How wide "self-improve" reaches

Settled by the operator 2026-09-07, against the narrow reading this scope
first assumed: **wide**. Mechanism A may run `/bs audit` on the factory
itself, turn findings into epics, and run them — it is not limited to epics a
person planned.

That decision makes the remaining constraints load-bearing rather than
decorative, because the merge is now the *only* human checkpoint between "the
factory noticed something" and "the factory changed itself". Four bounds, and
they are the price of the wide reading rather than a hedge against it:

- **A severity floor on what may be cut automatically.** Only S1 and S2
  findings, or a finding two axes reached independently, may become an
  auto-cut epic. S3 and S4 queue for the operator. An unbounded budget with a
  nit-level trigger is how a loop spends a night on cosmetics, and the
  manual audit of 2026-09-07 produced 29 S3 and 7 S4 against 9 S2 — the ratio
  is the argument.
- **One epic, one PR, one human merge.** §3.5 stands and is not batchable
  here. A loop that cut ten epics overnight and asked for one merge would have
  moved the checkpoint rather than kept it.
- **Protected declarations.** The loop may *propose* a change to the files
  that bound it — `factory/policies/scheduler.yml`, `autonomy.ts`,
  `budgets.yml`, `delegation.yml`, `.claude/settings.json`, and the
  `state/loop/enabled` marker — and such an epic classifies `operator`,
  never `auto`. This is not a distrust of the loop; it is the observation
  that a self-improving process permitted to widen its own leash has no fixed
  point, and the operator's decision was to widen what the loop may *build*,
  not what it may *permit itself*.
- **Growth-review still never auto-classifies.** Architecture §12 keeps scope
  with the operator unconditionally, and a finding that changes what the
  factory *is* rather than how well it does what it already does is a growth
  question wearing an audit's clothes.

The durable findings file (§6.4) stops being a nicety under the wide
reading: without it the loop re-discovers the same S2 every run and cuts the
same epic again.

## 4. Mechanism B — audit and maintain an outside project, on command

**Scope: any project this factory can reach, triggered by the operator, never
by a timer.**

The operator's second sentence settles what option A's original sketch left
open. There is no launchd job and no cron entry. The loop body is still a
headless session; the *start* is a command the operator types.

That removes the sharpest risk in the original proposal — an unattended timer
acting on a repo the factory did not build — at no cost to the thing the
operator actually wanted, which is not having to sit through every wave.

### 4.1 `/bs audit <project>`

The command this scope exists to make real. Requested 2026-09-06:

> a command to audit any project, from producing insight through fixing
> issues, optimizing performance, weighing strengths and weaknesses,
> architecture

Four axes, fixed by the operator on 2026-09-07: **performance, code quality,
architecture, security**. One agent per axis, dispatched in parallel against
a read-only checkout, each returning findings in the severity grammar of
`factory/policies/severity.yml` (S1-stop-the-line … S4-nit) with a location,
evidence, a failure scenario and a confidence.

Then, and this is the part that is not a fan-out:

1. **Consolidate.** Findings that different axes reached by different routes
   are folded into one. The manual run of this command on 2026-09-07 found
   the same line, `AppState.swift:546`, from the architecture axis and the
   code-quality axis independently — convergence is the strongest ranking
   signal the audit produces and it is lost if the axes are merely
   concatenated.
2. **Rank** by severity, then by convergence, then by confidence.
3. **Stop and ask.** The audit reports; the operator chooses what becomes an
   epic. This is a hard stop, not a default-yes with an opt-out.
4. **Hand to the planner** — one roadmap milestone with `- project: <name>`
   and `- kind: product`, one epic spec, then `/bs run`.

The audit itself writes nothing to the audited project. It reads, it reports,
and every change after that arrives through the normal loop: worktree,
claims, gates, PR, human merge.

A calibration note worth keeping, because the manual run proved it matters:
the audited project's own `CLAUDE.md` is ground truth for what is *not* a
defect. Deliberate choices documented there — a design that looks wrong and
is load-bearing — must be read before an axis reports them as findings, or
the audit spends its first round being refuted.

### 4.2 `/bs maintain <project>`

The recurring half. Same trigger rule: the operator runs it. It asks the
scheduler what is due for that project, classifies with the same
`autonomy.ts`, presents `auto` and `operator` separately, and — once the
operator says go — carries the run through headless sessions so the operator
is not the loop.

The difference from mechanism A is only who starts it and how often, which is
why both are one epic rather than two.

## 5. Out of scope

- **No timer for outside projects.** Explicitly settled by the operator's
  second sentence. If it is ever wanted, it is a separate decision with its
  own risk argument.
- **No dispatch inside `smith daemon`.** §3.1.
- **No auto-merge.** §3.5.
- **No promotion path in `autonomy.ts`.** Its module header promises that
  every rule can only deny and that the whitelist in `scheduler.yml` bounds
  the blast radius. A loop that could widen it would retire that promise, and
  the promise is the reason auto-dispatch is safe to have at all.
- **No self-improve loop in the plugin.** §3.3.
- **Not a service, not a container.** Unchanged from `plugin-port-scope.md`.

## 6. The four forks, closed 2026-09-10

All four were put to the operator and all four were answered. They are
recorded here as decisions rather than questions, because a decision that
lives only in a transcript is a decision the next session has to re-take.

### 6.1 Mechanism A runs back-to-back, with no interval

**Decision: no interval.** When one iteration finishes, the next begins.

There is no timer to tune because the loop is not sampling a condition — it
is working a queue. An interval is the right shape for a poller (`smith
daemon` folds an event log every few minutes because nothing is asking it to)
and the wrong shape for a worker: an hour's wait after a wave that took
forty minutes is an hour in which the queue it just measured goes stale.

What ends the loop is §3.5, not a clock: the queue is empty, the next epic
classifies `operator`, or the infrastructure failed. **A loop paced by its own
stop conditions cannot run away in a way an interval would have caught** —
the ceiling is the whitelist in `scheduler.yml` and the human merge, both of
which bind identically at any cadence.

### 6.2 A failed child reuses the escalation ladder

**Decision: reuse it, one tier up.** `budgets.yml`'s `escalation_ladder`
already answers this shape for a task, and an epic is not different enough to
earn a second ladder:

1. **Retry once at the same tier.** A first failure is usually the spec, not
   the model (dispatch contract, "Round counting and escalation") — and that
   argument does not weaken when the unit is an epic.
2. **Escalate to opus.** Logged in the `dispatch_decision` with the reason,
   the same as a task escalation, so the cost is attributable afterwards.
3. **Stop and report.** Not "hold it and move on": an epic that failed twice
   has an unmerged branch and a half-answered finding, and a loop that steps
   over it accumulates exactly the debt nobody is watching. The loop stops
   and the operator reads one report, which is rung 3 of the ladder as
   written.

A second, epic-specific ladder was the alternative and was rejected for the
reason `smith escalation check` exists at all: a rule that is checkable is
worth more than a rule that is tailored, and that check counts
`gate-outcome`/`blocked` rounds against the one ladder in `budgets.yml`.

### 6.3 `--max-turns 300` for the headless child

**Decision: 300.**

The cap is a runaway guard, not a budget — the budget is unbounded by §3.4,
and the two axes must not be conflated. 300 is chosen to sit well above a
real wave and well below an unbounded spin: the manual runs this scope was
written from spent tens of turns per task and low hundreds per wave, so a
wave that reaches 300 has stopped converging rather than merely being large.

Two consequences, both deliberate:

- **A cut is an `error-logged` event, not a silent exit.** §6.2's ladder then
  applies to it like any other failure — `taxonomy.yml`'s `execution` group
  has no class for a turn-cap cutoff today, which is a gap the implementing
  epic has to close rather than route around.
- **The number is true only where the harness reads it.** An `Agent`-tool
  subagent is capped by its template's `maxTurns`, which Claude Code enforces
  (agent-interviews.md M-4, corrected 2026-09-11). A headless child is not
  dispatched through a template, so nothing caps it but the invocation
  itself: for it the number is the flag on the command line, not a line in
  a spec.

### 6.4 Findings live in `<project>/.blacksmith/findings.jsonl`

**Decision: append-only JSONL under the audited project's own state root, and
a `declined` finding expires after 90 days.**

- **Location.** `<project>/.blacksmith/` is already the `STATE_ROOT` the
  operator approved for the plugin port (`plugin-port-scope.md`, PP-1). An
  audit's findings are state a run produced *about that project*, so they
  belong with that project — not in the factory clone, which under a plugin is
  a read-only marketplace cache that may be replaced on the next update.
- **Format: append-only JSONL.** The same shape as the event log, for the same
  reason: two writers appending lines cannot corrupt each other's records, and
  a history that is only ever added to can be replayed. Status changes are
  new lines, never edits — the current state of a finding is a fold over its
  lines, exactly as `finding-transitioned` folds in `state/events/`.
- **Dedupe.** By fingerprint, so a re-audit recognises a finding it already
  raised. This is what §3.6 requires of the wide reading: without it the loop
  re-cuts the same epic every iteration.
- **`declined` expires after 90 days.** A finding the operator declined is a
  judgment about the code as it stood, and code moves. Ninety days is long
  enough that a re-audit does not nag about a decision from last week, and
  short enough that a decline cannot silently become a permanent exemption
  nobody revisits. An expired decline returns as a fresh finding, not as a
  reopened one — it must argue its case against the code that exists now.

Note what this file is **not**: it is not a waiver store. A waiver is a
factory-side act with an audit trail in the event log
(`waiver-granted`/`waiver-denied`); a decline here is an operator's answer to
an audit's question about their own project, and it expires.
