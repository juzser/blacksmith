# Features in depth

The README's [Features](../../README.md#features) table gives each feature two
or three sentences. This page holds the rest: one section per cell, in the
README's order and under the same heading, so the link at the foot of a cell
lands on its section here. A section starts where its cell stops, so read the
cell first.

The [claims matrix](../claims-matrix.md) names what backs the sentences here
that the 0.6.0 docs pass or a later edit wrote or changed.

## More agents at once, fewer tokens per merged task, no check skipped

After every merge, each task whose dependencies are done and whose paths no
task in flight claims is admitted at once, rather than when the whole wave
drains. Once the tester is done, the grader, the reviewer and, when its
triggers fire, the security reviewer are dispatched together.
`bs brief compose` builds every brief. Full-suite and e2e runs take one lock
per machine (`bs heavy run`), so agents running at once queue for them instead
of running them all together. In a clone, or with the
[plugin guard](plugin-guard.md) on, the policy hook refuses a brief sent to the
wrong agent type and a foreground `sleep` of 2 s or more, and names the fix.

Claude Code is set up for the width. `bs init` raises its caps of 20 subagents
and 10 parallel tool calls to 1000 each, and sets a 633k compact window, so a
session on a current 1M-token model compacts at the policy's 60%; `bs doctor`
warns when the caps are not raised. The wave-runner, the coder and the tester,
which wait minutes on test runs, keep a 1h prompt cache instead of the default
five minutes.

How wide it runs can be checked. Before anyone is dispatched,
`bs wave schedule` replays the plan and reports how many rounds it needs, its
widest round, and the tasks held back by their claims, a shared hotspot or an
import edge rather than by a dependency; it exits 1 when the plan stalls and 2
when tasks are held back that way. Once a wave lands, `bs wave audit` reads the
log back and says whether a wave admitted N wide ran N wide, and
`bs epic width` asks the same of every closed epic. All three only read; the
close records an epic's width without holding on it, though an external
judge, when one is enabled, may refute a wave that was admitted and shows no
work.

Only what the turn needs is loaded. Each `/bs` verb loads its own playbook when
it runs, and only the verbs that dispatch read the dispatch contract. A
wave-runner reads the wave and dispatch playbooks by slice:
`bs playbook slice` prints one wave step or one dispatch section.

Merge lanes are opt-in. `bs queue run --batch` groups claim-disjoint tasks
that do not depend on each other, tests each group once, and bisects a red
group so the tasks that pass still land. No playbook passes `--batch`, so by
default the queue tests and merges one task at a time.

## Nothing is dispatched without a contract

A worker can still argue with the contract out loud. A coder or tester that
finds a criterion wrong returns a proposed plan diff; `bs plan propose` checks
that the diff yields a valid plan and records it without touching the plan,
and `bs plan proposals` lists it, marked stale once a newer plan version
overtakes the one it was drafted against. The answer is yours:
`bs plan approve` cuts the next version through `bs plan amend`, and
`bs plan reject` requires a rationale.

## Workers that cannot collide

`bs wave check` is what admits a wave, and it asks more than whether the
claims overlap. It refuses two tasks that both touch a serialize-always
hotspot in `factory/policies/worktree.yml`, such as a lockfile, and two tasks
the plan orders one after the other. Claims that are disjoint can still meet
on an import edge, where one task claims a file that another task's files
import from, so it also refuses a pair joined that way; `bs claims impact`
asks that question on its own. [The wave](operator-guide/wave.md) part of the
operator guide walks each of these checks.

## Gates decide what merges, not confidence

A worker runs its role's `bs results check` as the last step before it hands
back: the gate's own paperwork checks, read-only and with no test run, so a
missing file or field is fixed in that turn instead of costing a gate round.
When the gate still blocks, the wave playbook names one answerer for each
reason (the worker whose result it is, the uiux pass, a judge turn, the
wave-runner or the epic session), and a check whose clock shows the machine
slept is not bounced to the coder.

A judge's verdict counts only if the worktree did not move under it. The
playbook brackets each judge of a task, and the audit's shared tree, with
`bs worktree fingerprint` and `bs worktree verify`, gitignored paths aside;
drift exits 1, and the playbook discards the verdict and dispatches the judge
again on a clean tree.

## A second opinion from another vendor

A judge earns its vote in **shadow mode** first — every verdict recorded, none
of them gating anything — and is promoted only once you have read the numbers.
[The providers runbook](../runbooks/providers.md) covers key and auth setup,
enabling, shadow-mode calibration, promotion and rollback.

## Checked against your goal before the pull request

`bs integration check` runs the project's checks on the assembled integration
branch, not in a worktree, and `bs epic spec-review` records the closing spec
review read against that branch. `bs epic verdict` holds the epic while a task
is unfinished, a blocking finding is open, or the integration check, the goal
check or a closing review the tier requires is missing, failed or stale; once
those pass and an external judge is enabled, a cross-provider quorum decides
go or hold. `bs epic close` refuses a hold unless you give a rationale, which
it records.

## An epic outlives one context window

A wave too wide for the epic session's window runs in a session of its own,
driven by the epic session or, when the wave would eat the window the epic
needs, by the `bs-wave-runner` agent. `bs session start --continues` links a
new session to the epic's log, `bs event lineage` prints the sessions on that
line, and `--lineage` makes a `bs stats` read answer for the whole epic rather
than the window you are in.

## It learns from its own errors

Each approved lesson carries one error class. A brief always carries the
lessons for the agent's role and for the paths it claims; a broader lesson goes
in up front only once its class has proven to recur (three tasks in 30 days) or
has come up in this epic, and the rest are named for the agent to read on
demand.

## A frontier planner, cheap workers

`bs stats effectiveness` says what the spend bought: tokens per task and per
role, defects that escaped a passing gate, and how often each reviewing role's
findings held up, with NOT MEASURED where nothing was measured.

## The log is the source of truth

Every event but a `session-start` names a parent event, and an append whose
parent is not already in the log is refused, so any record can be followed
back to a `session-start`
(`bs stats timeline --causal-chain-for <event-id>`).
