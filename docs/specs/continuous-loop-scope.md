# Continuous loop — scope

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
smith <loop command>
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

The durable findings file (§6, fork 4) stops being a nicety under the wide
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

## 6. Open forks for the operator

Four, after the operator closed the fifth (§3.6). None of these blocks the epic being cut; each is a question the plan will
reach and should be answered before it does.

1. **Interval for mechanism A.** The daemon defaults are a starting point,
   but a loop that spawns a full epic run is not a loop that folds an event
   log, and the right number is probably hours rather than minutes.
2. **What the loop does with a failed child.** Retry the same epic next
   iteration, hold it and move on, or stop the loop. The escalation ladder
   already answers this shape for tasks (bounded retry → higher model tier →
   operator); the question is whether an epic-level loop reuses the ladder or
   declares its own.
3. **`--max-turns` for the headless child.** A cap that is too low abandons a
   wave mid-flight, which is worse than not starting it. The budget is
   unbounded by decision; the turn limit is a different axis and still needs
   a number.
4. **Where `/bs audit`'s findings live.** Partly settled by §3.6 — a
   durable findings file is now required, because a loop that cuts its own
   epics must be able to tell a new finding from one it already raised. What
   remains open is the format and whether a declined finding expires.
