# The operator loop

What you actually do, in the order you meet it. Six steps, two of which need
you; the rest is the factory's job.

This is the bridge between the README's summary and
[`operator-guide.md`](operator-guide.md), which walks the same ground with
real commands and real output. Read this first, that one when you want to
know exactly what a gate printed and why.

Everything here happens in a Claude Code session opened in this repo, where
the `/bs` skill ([`.claude/skills/bs/SKILL.md`](../../.claude/skills/bs/SKILL.md))
is your console:

| Command | What it does |
|---|---|
| `/bs new <project> [--ui]` | Scaffold a new target project from the stack standard |
| `/bs plan <goal>` | Draft or re-plan an epic with the planner |
| `/bs run <epic>` | Admit a wave and drive it through the loop |
| `/bs status` | Live agent count, budget burn, epic phase |
| `/bs ui` | Serve the local dashboard |
| `/bs waivers` | Answer the pending S3/S4 waiver batch for an epic |
| `/bs lessons` | Review pending lesson candidates |
| `/bs report` | Render or send the scribe's progress digest |

One thing to know up front: those playbooks are dispatch instructions for
your orchestrator session, **not a background daemon**. Nothing advances
while the session is closed. `smith daemon` runs in the background and will
tell you what the factory needs while you are away, but it watches and never
dispatches — see [Limitations today](operator-guide.md#limitations-today) and
[the ops runbook](../runbooks/ops.md).

## 1. Say what you want — `/bs plan <goal>`

Describe the goal in plain language. The planner
([`.claude/agents/planner.md`](../../.claude/agents/planner.md)) turns it into
an epic spec plus task specs, and a spec-reviewer goes hunting for holes in it
before you ever look. You get something concrete to react to instead of a
blank page.

## 2. Sign off — and the spec freezes

When the planner and spec-reviewer converge, you approve. That approval turns
the spec into **PLAN v1, immutable**. Nothing executes before it
([`agent-constraints.md`](../standards/agent-constraints.md): planner autonomy
is "sign-off per epic, then free within budget"). This is the most leveraged
minute in the loop — the spec is what every worker is held to for the rest of
the epic.

Changing a frozen plan is possible but deliberate: `smith plan amend` cuts a
new version, and it refuses to run without a spec finding that forced it. No
finding, no amendment.

## 3. Let it run — `/bs run <epic>`

You are out of the per-step loop from here (keep the session open, though —
the daemon watches, it does not dispatch). The scheduler admits a **wave**: tasks whose path claims
are disjoint and whose dependencies are satisfied. Each gets its own worktree
and runs coder → tester → grader → the gate pipeline (schema check, cumulative
tests, coverage evidence, reviewer, verifier). Whatever passes joins the
serial merge queue into `smith/<epic>/integration`.

Want to look in? `/bs status` gives you live agent count, budget burn and epic
phase; `/bs ui` serves the [dashboard](dashboard.md) if you would rather watch
it.

## 4. Answer one batch of questions — `/bs waivers`

S3 findings never block the line. They pile up into a **single batched
question per epic** — "ignore these?" — that you answer once. Your answer is
stored by finding fingerprint, so the same nit is never put to you twice.

The severity contract in full:

| | What it does at the gate |
|---|---|
| **S1** | Stops the line. Nothing merges until it is resolved. |
| **S2** | Blocks the task and bounces it back to the coder, same branch. |
| **S3** | Does not block. Batches into one waiver question at epic end. |
| **S4** | Logged only. |

Declared in [`factory/policies/severity.yml`](../../factory/policies/severity.yml);
the semantics from your chair are in
[operator-guide §8](operator-guide.md#8-severity--waiver-semantics-from-the-operators-chair).

## 5. Review the PR — the one thing you must read

One PR per epic, `smith/<epic>/integration` → your target repo's `main`. It
arrives with the acceptance-criteria checklist, screenshots (desktop + mobile
390px, light + dark, ≤4 per feature — [`docs/standards/stack.md`](../standards/stack.md)),
test results and any waivers granted.

**You merge it. Blacksmith never does.** No agent can push to `main`, and that
is enforced by the policy layer behind
[`.claude/hooks/guard.sh`](../../.claude/hooks/guard.sh) plus branch
protection, not by asking nicely. `smith policy check --command '<cmd>'`
answers what any of it would say, without running the command.

## 6. Teach it — `/bs lessons`

Errors and decision checkpoints become lesson candidates. Approve, edit or
reject them — in the UI's Lessons page or with
`smith lessons approve|reject` — then `smith lessons compile` writes the
approved ones into
[`factory/policies/lessons.md`](../../factory/policies/lessons.md), from where
they are injected into the matching agent's next dispatch.

That is the loop that closes: a mistake made once becomes a constraint the
next worker is handed. Whether it is working is a number —
`smith kpi same-mistake` — and it is on the dashboard's Analytics page.

The review surface is built; the *cadence* is yours to set — nothing prompts
you on a schedule.

## Where to go next

| You want | Read |
|---|---|
| The same loop with real commands and real output | [`operator-guide.md`](operator-guide.md) |
| Every `smith` command | `smith --help`, or [`operator-guide.md`](operator-guide.md) |
| What the dashboard shows | [`dashboard.md`](dashboard.md) |
| What is actually built vs. planned | [`status.md`](status.md) |
| Why the factory is shaped this way | [`../specs/black-smith-architecture.md`](../specs/black-smith-architecture.md) |
