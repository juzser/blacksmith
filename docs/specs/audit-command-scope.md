# `/bs audit` — scope

`continuous-loop-scope.md` §4.1 designed this command in six paragraphs and
left it there. This file is what an epic can be cut from: it decides where the
line between the deterministic half and the judgment half falls, what a
finding *is* when no task produced it, and which of the factory's existing
instruments the audit reuses rather than reinvents.

The operator's original request, 2026-09-06:

> a command to audit any project, from producing insight through fixing
> issues, optimizing performance, weighing strengths and weaknesses,
> architecture

and the shape settled 2026-09-07:

> Audit direction: optimize performance, code quality, architecture and
> security. It can produce insight first, then ask the user to approve the
> options, hand them to the planner and run the loop as usual.

Everything below is downstream of those two sentences. Where this file and
`continuous-loop-scope.md` §4.1 disagree, §4.1 is the older draft and this
file wins. It disagrees in exactly two places and both are named here, because
a reversal a reader has to discover for themselves is a reversal that gets
implemented twice:

- §4.1's *"the audit itself writes nothing to the audited project"* against
  fork 4's findings file living in `<project>/.blacksmith/`. This one is
  apparent rather than real, and §1.3 settles it.
- §4.1 step 1's *"findings that different axes reached by different routes are
  folded into one"* against this file's refusal to merge them. This one **is**
  real: §4.1 made consolidation a merge, §3.1 makes it a clustering that is
  handed over to be judged. §3.1 says why, and carries the reversal in its own
  text so it cannot be read as a refinement.

## 1. What the command is

### 1.1 A command, not a session

The trigger is the operator typing `/bs audit <project>`. No launchd job, no
cron entry, no dispatch inside `smith daemon`. That is `continuous-loop-scope.md`
§4's rule and it is unchanged: mechanism A may *call* an audit on the factory
itself, but an outside project is audited when a person asks.

### 1.2 The project directory is an answer you ask for

`PROJECTS_DIR = path.dirname(REPO_ROOT)` cannot survive the plugin port —
under a plugin the parent of the factory is a marketplace cache
(`plugin-port-scope.md`, PP-1). `/bs audit` is the first command written after
that was known, so it never grows the dependency: **the directory is a
positional**, resolved once, carried through every call.

`smith projects list` remains a convenience for the two projects this machine
already knows. It is not a gate: a directory that is a git repository and is
not this clone is auditable, listed or not.

### 1.3 "The audit writes nothing to the project" — what that means

§4.1 says the audit writes nothing to the audited project. Fork 4 says its
findings live in `<project>/.blacksmith/findings.jsonl`. Both hold, because
they are about different things:

- **The working tree is untouched.** No source edit, no commit, no branch, no
  formatter, no dependency install. This is the promise, and §2.2 enforces it
  rather than asking for it.
- **`.blacksmith/` is state, not source.** It is the `STATE_ROOT` the operator
  approved for the plugin port (PP-1), and the audit is the first thing to
  create one for an outside project. State a run produced belongs with the
  project it is about; the alternative is a findings file in the factory
  clone, which under a plugin may be replaced by the next update.

One consequence has to be handled rather than left: creating `.blacksmith/`
makes an untracked directory appear in the operator's `git status`. The audit
does **not** silently edit the project's `.gitignore`. It asks — once, folded
into the hard stop of §4, never as a stop of its own — whether to add the one
line, and reports the line either way.

## 2. The four axes

### 2.1 Fixed, and parameterised by nothing else

**performance · code quality · architecture · security.** Four, fixed. Not
operator-selectable in v1: a subset is an audit that answers a narrower
question than the one asked, and the ranking signal of §3.2 is *cross-axis
convergence*, which degrades with every axis dropped.

Each axis is one agent, dispatched in **parallel** with the others, under the
ordinary dispatch contract — lessons spliced, turn budget stated in the
prompt, artifact path declared before dispatch (`smith judge dispatch`), the
result written to a file rather than narrated back.

### 2.2 Read-only, enforced rather than promised

The axes run in a detached worktree of the project at its current HEAD, placed
beside the project the way every other worktree in this factory is
(`AGENTS.md` "Worktrees"), and removed at `smith audit close`.

Read-only is enforced with the instrument that already exists for judges —
`smith worktree fingerprint` before the dispatch, `smith worktree verify`
after it. An axis that moved what it was auditing has its result **discarded
and re-dispatched on a clean worktree**, exactly as the dispatch contract
requires of a reviewer. This is not belt-and-braces: every axis holds `Bash`,
and the same tool that runs a profiler writes files.

### 2.3 Calibration: the project's own `CLAUDE.md` is ground truth

Every axis prompt carries the audited project's `CLAUDE.md` (and any
`AGENTS.md`) verbatim, fenced as untrusted content via `smith prompt wrap
--kind file-excerpt`. A design that looks wrong and is documented as
deliberate is not a finding. An audit that skips this spends its first round
being refuted, which costs a full re-dispatch and teaches the operator that
the command is noisy.

The fence matters as much as the content: a project's `CLAUDE.md` is a file
this factory did not write, spliced into a prompt this factory composed.

### 2.4 Attribution, and the role that does not exist yet

`factory/policies/taxonomy.yml`'s `agent` enum has thirteen members and none
of them is an auditor, while every `dispatch_decision` names one. So:

- **Add `auditor` to the `agent` enum**, with one template
  `.claude/agents/auditor.md`. The axis is not a role — it travels in the
  dispatch prompt and in the store's own `axis` field — so one new template
  with three instantiations (performance, code quality, architecture), not
  three templates that would drift apart.
- **The security axis dispatches `security-reviewer`** unchanged, which
  already exists and already carries the threat-model discipline this axis
  needs. Reusing it costs nothing and inventing a second security prompt costs
  a divergence.

So: four axes, two templates — three `auditor` dispatches and one
`security-reviewer` dispatch. The `agent` field on the security axis's
`dispatch_decision` is therefore `security-reviewer`, not `auditor`: that
field names the template that actually ran, and anyone later querying
dispatches by agent needs it to be true. The axis is never carried by `agent`
for any of the four — it is carried by the store's `axis` field and by the
dispatch prompt.

Two adjacent gaps are recorded here rather than fixed here, because both are
factory defects with a life outside this command: `finding_category` has no
`architecture` value (architecture findings land as `maintainability` or
`over-engineering` when they reach the factory), and `taxonomy.yml` carries no
`event_type` vocabulary at all.

### 2.5 Providers

Axes run at the role's declared tier. Where a second provider's key is present
— `crosscheck.yml` already ships `deepseek: enabled: auto`, resolved against
the environment at call time — **at least one axis runs on it**. Four
independent readings of one codebase is precisely the case provider diversity
was built for, and an audit whose four axes share one model's blind spot
converges on agreement that means nothing.

Standing operator constraint: **fable is not used**, on any axis.

## 3. What happens to the four returns

This is the half that is not a fan-out, and it is where an audit differs from
four reviews.

### 3.1 Two different keys, and conflating them is the bug

**Dedupe key — the fingerprint.** `computeFingerprint(file, category,
normalized summary)`, the factory's existing function, reused rather than
reimplemented. It answers *"have I raised this before?"* across runs.

**Convergence key — the normalized file path.** It answers *"did more than one
axis reach this independently?"* within one run. It cannot be the fingerprint:
the manual audit of 2026-09-07 found `AppState.swift:546` from the
architecture axis and the code-quality axis in different words and different
categories, so their fingerprints differ by construction. Two axes agreeing is
the strongest ranking signal the audit produces, and a fingerprint match would
never see it.

The consequence is deliberate, and it is the reversal of
`continuous-loop-scope.md` §4.1 step 1 that the preamble names:
`smith audit consolidate` computes the path-clusters **and hands them over to
be judged**, it does not merge them. Two findings in one file are often two
defects, and a merge performed by a path match destroys the second one
silently — which is the worse of the two failures, because a duplicate row is
visible at the hard stop and a swallowed defect is not.

The deterministic half finds the candidates; the judgment half decides whether
a cluster is one finding or several. Naming that half precisely, because "it
is judged" is not an actor:

- **Who.** The `/bs audit` playbook session — the same session that dispatched
  the axes. Not an agent: the judgment is made in front of the operator, at
  the hard stop, where they can overrule it in one word.
- **On what.** `audit consolidate`'s cluster output, which prints each
  member's fingerprint, axis, severity, summary and failure scenario side by
  side. Same file, different axes, and the three fields are what distinguish
  "two routes to one defect" from "two defects that happen to share a file".
- **Persisted by what.** `smith audit decide --decision merge --same-as
  <surviving-fingerprint>`, which appends a `merged` line for each member
  folded into another. The survivor is then accepted or declined on its own,
  and carries the merged members' evidence into the epic criterion.

A cluster nobody merges stays several findings. That is the safe default in
the same direction as the rest of this section: the audit over-reports and
lets a person collapse it, rather than under-reporting and calling it tidy.

### 3.2 Ranking

Severity first, then convergence, then confidence. In that order and not
another: severity is the factory's own grammar (`severity.yml` — S1 stops the
line, S2 blocks, S3 is waivable, S4 is logged), convergence is evidence about
the finding's reality, and confidence is one agent's opinion of its own work.
A high-confidence S4 must never outrank a two-axis S2.

### 3.3 The hard stop

The ranked list goes to the operator and **the command stops**. This is a
stop, not a default-yes with an opt-out: the audit is about to spend a planner,
an epic and a wave on somebody else's codebase, and the one question worth an
operator's tick is which findings deserve that.

Per finding: **accept** (it becomes epic scope) or **decline** (it is recorded
as declined and expires in 90 days). The `.gitignore` question of §1.3 rides
along here.

## 4. The findings store

`<project>/.blacksmith/findings.jsonl`. Append-only JSONL, one JSON object per
line, folded to a current state by replay — the same shape and the same reason
as `state/events/*.jsonl`: two writers appending cannot corrupt each other,
and a history that is only added to can be re-read.

### 4.1 It is not a `finding.schema.json` record

`finding.schema.json` requires `task_id`. An audit finding has no task — no
task produced the code it is about, and none exists to bounce it back to. The
factory's finding record is task-shaped all the way down, and forcing an audit
finding into it would mean minting a fake task id, which is the kind of lie
that survives into a report.

So the store carries **its own record**, which borrows the vocabulary and not
the schema: `severity` (taxonomy `severity`), `axis` (the four), `file_path`
(normalized by `normalizeFilePath`, so the two stores can be joined by path),
`summary`, `failure_scenario` (`inputs`/`expected`/`actual`, the same three
keys — a finding without one dies at verify here too), `confidence` (0–1),
`fingerprint`, and the append metadata.

### 4.2 The audit never calls `smith findings raise`

This follows from §4.1 and is worth stating on its own, because it dissolves a
question that looks blocking: an audit finding does not become a factory
finding. It becomes **epic scope** — an acceptance criterion in a spec. The
factory's findings are then raised in the ordinary way, by the reviewer and
verifier judging the diffs that epic produces.

### 4.3 Status is a line, never an edit

`raised`, `merged`, `accepted`, `declined`, `fixed`. A status change appends a
new line naming the fingerprint and the new status. The current state of a
finding is a fold over its lines, exactly as `finding-transitioned` folds in
the event log.

**Every status names the verb that writes it.** A status vocabulary with a
member no verb reaches is a state an implementer must invent a route into, and
two implementers invent two:

| status | written by | means |
| --- | --- | --- |
| `raised` | `audit record` | an axis reported it and the fold did not suppress it |
| `merged` | `audit decide --decision merge --same-as <fp>` | the same defect as another member of its path-cluster (§3.1); the survivor carries it from here |
| `accepted` | `audit decide --decision accept` | it becomes epic scope (§5) |
| `declined` | `audit decide --decision decline` | the operator said no; expires in 90 days (§4.4) |
| `fixed` | `audit resolve --epic <epic-id>` | the epic that carried it closed |

`fixed` is the one that outlives the audit, and that is why it needs a verb of
its own rather than a clause in `audit close`: the audit closes in the same
sitting, the epic closes days later. The chain is `audit cut` stamping the
epic id it rendered onto each accepted finding, the epic running its ordinary
course, and `/bs run`'s epic-close step calling `audit resolve --epic
<epic-id>` — which appends one `fixed` line per finding that epic carried. If
that call never happens the store is stale but not wrong: the findings stay
`accepted`, which is exactly what they are.

**What the fold suppresses on a later run is decided by the folded status, not
by the fingerprint's mere presence.** `raised`, `merged` and `accepted`
suppress a re-raise — it is in the store, already judged or already in an
epic. `declined` suppresses it until it expires (§4.4). `fixed` does **not**:
a fingerprint that comes back after its epic closed is a regression, and the
one thing an audit must never do is stay quiet about one. It returns as a
fresh `raised` line, over a history that still shows the earlier `fixed`.

### 4.4 A decline expires after 90 days, at fold time

Ninety days is long enough that a re-audit does not re-ask about last week's
decision, and short enough that a decline cannot quietly become a permanent
exemption nobody revisits.

The expiry is computed **when the store is folded**, not by a sweeper: a
`declined` line older than 90 days is simply not applied. Nothing mutates,
nothing is deleted, the append-only property holds, and there is no background
job to forget to run.

An expired decline comes back as a **fresh** finding, not a reopened one. It
argues its case against the code as it now stands, which is the whole reason
the expiry exists — the decline was a judgment about code that has since
moved.

### 4.5 It is not a waiver store

A waiver is a factory-side act with an audit trail in the event log
(`waiver-granted`/`waiver-denied`), keyed by fingerprint, never re-asked. A
decline is the operator's answer to a question about their own project, and it
expires. Same word family, different objects; the store must not be described
as waivers in the UI or the report.

## 5. The handoff

Accepted findings become one roadmap milestone and one epic spec — `- project:
<name>`, `- kind: product` — and then `/bs run` takes over unchanged. There is
no audit-specific run path: the value of the command is the insight and the
ranking, and an epic it cut is an ordinary epic. The one thread back is the
epic id `audit cut` stamps onto each accepted finding, which is what lets
`audit resolve` mark them `fixed` when that epic closes (§4.3).

Scope discipline at the cut: **one epic**. An audit that accepted fourteen
findings produces one epic with fourteen criteria, not fourteen epics — the
merge is the operator's one checkpoint (`continuous-loop-scope.md` §3.5) and
fanning out epics moves that checkpoint rather than keeping it.

## 6. The command surface

Seven verbs under a new `smith audit` namespace, each documented in
`usage.ts`'s `COMMANDS` register before it is reachable (the dispatcher
refuses an undocumented command, and `test/usage.test.ts` asserts the reverse
inclusion).

| verb | does |
| --- | --- |
| `audit open <project-dir>` | resolve the project, create `.blacksmith/`, cut the detached read-only worktree, fingerprint it, print the axis manifest and the store's live findings as dedupe context |
| `audit record <project-dir> --axis <axis> --evidence <file>` | validate one axis's evidence, fingerprint each item, drop what the fold suppresses (§4.3), append the rest as `raised` |
| `audit consolidate <project-dir>` | fold the store, compute path-clusters, rank by severity → convergence → confidence, print the ranked list with each cluster's members side by side |
| `audit decide <project-dir> --fingerprint <fp> --decision accept\|decline\|merge [--same-as <fp>]` | append the operator's answer; `--same-as` is required by `merge` and refused by the other two |
| `audit cut <project-dir> --epic <epic-id>` | render the roadmap milestone and the epic spec from the accepted findings, stamping that epic id onto each of them |
| `audit resolve <project-dir> --epic <epic-id>` | append a `fixed` line for every finding that epic carried. Called from `/bs run`'s epic-close step, not from inside the audit — see §4.3 |
| `audit close <project-dir>` | `worktree verify`, remove the read-only worktree, close the audit in the event log |

**The project directory is a positional on every verb, not only on `open`.**
§1.2 resolves it once and carries it through every call; the CLI has to be
able to be told the same thing. Nothing here reads a cwd and nothing keeps a
"current audit" in a file on the side — a bare `audit record` with no project
named would have to guess, and §1.1 does not forbid two audits being open at
once (two projects are two `.blacksmith/` directories, with nothing shared
between them). Naming the project on every line is what makes those two
sequences of calls impossible to confuse, and it costs one positional.

Every write verb takes the ordinary event envelope (`--session`,
`--causal-parent`, `[--plan-version]`, `[--actor]`, `[--state-dir]`), because
an audit is a run and a run that leaves no trail cannot be reported on.

The judgment half is a playbook, not a script: `.claude/skills/bs/audit.md`,
read from a `## /bs audit <project>` section in `SKILL.md` — the same split
`/bs run` already uses for `wave.md`, and for the same reason. An audit
outlives the section that starts it.

## 7. `/bs maintain` is not in this file

`continuous-loop-scope.md` §4.2 sketches it and says the two are one epic
rather than two. That remains true of the *epic*; it is not true of the
*scope*, and folding maintain into this file would have doubled its length
around a command whose hard parts (the scheduler's due-list, `autonomy.ts`'s
classification, headless continuation) are almost disjoint from this one's.
It gets its own file when the epic reaches it.

## 8. Out of scope

- **No auto-fix.** The audit produces insight and an epic; the fixing is the
  epic's, under the ordinary gates. A command that audits and repairs in one
  breath has no place to stop and ask.
- **No axis selection, no fifth axis, in v1.** §2.1.
- **No writes to the project's working tree.** §1.3, §2.2.
- **No timer, no daemon dispatch.** §1.1.
- **No promotion path in `autonomy.ts`.** Its module header promises every
  rule can only deny; the audit adds no exception.
- **Not a report generator.** `smith stats` and `/bs report` already answer
  "what happened"; this command answers "what is wrong".
