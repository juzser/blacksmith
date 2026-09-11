---
name: bs
description: Operator console for the Blacksmith factory — invoke as `/bs <subcommand>` (new, plan, run, audit, status, ui, waivers, lessons, report) to scaffold a project, plan or drive an epic through the loop, audit a project on four axes and cut an epic from what the operator accepts, check live status, open the dashboard, answer a waiver batch, triage lesson candidates, or get a progress digest. This file routes; each subcommand's playbook is a sibling file read when that verb runs. Use this whenever the operator wants to interact with Blacksmith itself, from a Claude Code session inside this repo.
---

# /bs — Blacksmith operator console

You (the orchestrator session running this skill) are the human's one interface
to the factory. Every subcommand below is a **playbook**, not a script: the
deterministic mechanics run through the real `smith` CLI
(`node factory/orchestrator/dist/cli.js <ns> <action> ...`, or `smith ...` once
linked — `pnpm build` first if `dist/` is stale); the judgment steps —
planning, spec review, coding, testing, reviewing — are separate Claude Code
sessions you dispatch from the matching `.claude/agents/<role>.md`. **This
skill never calls an LLM directly and never embeds a role prompt** — the
templates own that; duplicating them here would let this file drift out of
sync with the real contracts. Cite policy files (`factory/policies/*.yml`)
rather than restating their numbers.

**The project directory is an answer you ask for, not a path this file
knows.** A project this factory builds is not part of it: `smith new` puts one
*beside* this clone when no `--target-dir` says otherwise, and nothing
downstream reads that location — `workspaces/` inside the repo is still a legal
answer, just no longer the assumed one. Every verb that touches the project's
git takes the directory itself: `<project-dir>` as a positional on the
`worktree` family, `--project <dir>` on everything else. A task's worktrees
are placed beside whatever directory it was handed, so a project outside this
repo keeps its worktrees outside it too (`AGENTS.md` "Worktrees"). Ask for it
once, at the top of a run, and carry that one answer through every command
below — `<project-dir>` here means that answer, never a fixed path.

Every write command needs an event-log envelope: `--session <id>
--plan-version <n> --causal-parent <event-id> [--actor operator]`. Open a
session with `smith session start <session-id>` if one isn't already
running — it writes the root and prints the event id everything else hangs
off as `--causal-parent`. Run it once: it refuses a session that already
has a log, and names the last event in it so you have the anchor either way
(`docs/guide/operator-guide.md` §5). To continue an epic in a new session,
`smith session start <new-id> --continues <old-session>#<index>` (§5b). Once
you have, pass `--lineage` alongside `--session` on every `smith stats` read:
without it each page answers about the window you are standing in, not about
the epic.

**Record the operator's turn before you act on it**: `smith prompt record -
--session <id> --causal-parent <event-id>` (heredoc the words in, or pass a
file). It prints the event id — hang the dispatch it caused off that id as
`--causal-parent`, and the timeline draws "this work happened because a
person asked for it" instead of leaving a reader to infer it from clocks.
Store what they wrote, not a summary of it.

**Compact your own context at 60%** (`budgets.yml` `context_window`,
agent-constraints.md "context window"). You are the longest-lived session in
the factory — an epic outlasts your window. At 60% of it, compact: keep the
session id, the last `causal_parent` event id, the epic + live plan version,
which wave/step of the playbook you are on, and what is still open; drop
dispatched agents' raw returns and raw CLI JSON. All of it is re-readable —
`smith stats overview`, `smith event` and the task rows are the durable
memory, this transcript is not. Compact at 60%, not at 90%: the remaining
budget is what you need to actually finish the wave.

Concurrency and the event log: `smith` reads (`wave next`, `status`,
`budget alarm`) are free to run at any time. Writes to one session log are
serialized by the log itself across processes, so a burst of parallel
`smith` write-commands is safe — but each one's `event_id` comes back in
its own output, and **that is the only place to read it from**. Never
compute the next id by adding one: under fan-out the events between yours
belong to sibling tasks, and a `--causal-parent` you guessed will name a
real event that is not the parent, which validates and quietly mis-shapes
the lineage.

## Playbooks

Each subcommand is a file of its own beside this one, read when that verb
runs and not before. This console is the part every `/bs` turn pays for, so
it carries only what every verb needs — who you are, the envelope, the
operator's turn, the compaction rule, the id discipline above — and the
playbook carries the rest. Nothing here is restated in a playbook and
nothing in one playbook is restated in another: a second copy is a copy
that drifts.

| Subcommand | Purpose | Playbook |
|---|---|---|
| `/bs new <project> [--ui]` | Scaffold a new target project from the stack answers | [`new.md`](new.md) |
| `/bs mcp <project>` | Layer the MCP surface on and make its milestone due | [`mcp.md`](mcp.md) |
| `/bs plan <goal>` | Draft or re-plan an epic with the planner + spec-reviewer | [`plan.md`](plan.md) |
| `/bs run <epic>` | Admit a wave and drive it through the loop to merge | [`run.md`](run.md), the epic tier, which reads [`wave.md`](wave.md) for steps 2-10 |
| `/bs audit <project-dir>` | Audit a project on four axes, rank, decide at a hard stop, cut one epic | [`audit.md`](audit.md) |
| `/bs status` | Live agent count, budget burn, epic phase | [`status.md`](status.md) |
| `/bs ui` | Serve the local dashboard | [`ui.md`](ui.md) |
| `/bs waivers` | Answer the pending S3/S4 waiver batch for an epic | [`waivers.md`](waivers.md) |
| `/bs lessons` | Review pending lesson candidates | [`lessons.md`](lessons.md) |
| `/bs report` | Render/send the scribe's progress digest | [`report.md`](report.md) |

Two files in this directory are not subcommands. [`dispatch.md`](dispatch.md)
is the **dispatch contract**: what a prompt must carry, the lessons and
findings splices, return discipline, round counting and the escalation
ladder, the judge fingerprint and artifact rules, who owns the log. It binds
every agent any playbook dispatches, so read it before the first dispatch a
`plan`, `run`, `audit`, `lessons` or `report` makes — and not at all for a
verb that dispatches nothing. [`wave.md`](wave.md) holds steps 2-10 of `/bs run`, the
half that drives a single wave; it is read from inside a run, never invoked
on its own.
