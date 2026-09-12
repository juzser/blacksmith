# Operator guide — Setting up

One part of [the operator guide](../operator-guide.md). Section numbers
are the guide's, not this file's: `§5` means the same thing here as it
does wherever else this repo cites it.

## 0. Build once

```bash
pnpm install --frozen-lockfile
pnpm run build   # tsc -> factory/orchestrator/dist/
```

Every example uses `node factory/orchestrator/dist/cli.js <namespace> <action>
...`. If you've linked the package (`pnpm link`), substitute `smith` for
`node factory/orchestrator/dist/cli.js`.

## 0a. `smith effort show` — how much judgment this epic buys

Effort is a per-**epic** tier, not a per-project setting: the same repo runs a
`small` internal-tool epic and a `huge` one. It is chosen at `/bs plan` time,
written onto the plan file as a top-level `"effort"`, and read once at the top
of `/bs run`. `factory/policies/effort.yml` holds the three tiers; this verb
computes which one applies and what it buys, so nobody has to remember the
table:

```bash
smith effort show --effort small            # before a plan file exists
smith effort show --plan factory/specs/active/epic-1/plan-v1.json
```

```json
{"requested":"small","requestedFrom":"flag","defaultTier":"medium",
 "effective":"small","floorApplied":false,"securityFloor":"medium",
 "securityFloorEvaluated":false,"securityTriggers":[],
 "reason":"the flag asked for \"small\"; the security floor was not evaluated — no plan was supplied, so this is the tier's profile and not a decision about a specific epic.",
 "profile":{"summary":"Internal tools, scripts, one-file chores — work whose blast radius is the operator's own afternoon. Fast, and still gated.",
  "preCodeResearch":"never","preCodeUiux":"when-ui-criterion",
  "specReviewRounds":"single-pass","planQuorum":"when-triggered",
  "graderRounds":1,"verifierSeverities":["S1-stop-the-line"],
  "verifierS3SpotCheckRatio":0,"closingSpecReview":"when-plan-amended"},
 "invariants":["the gate pipeline — schema check, grader verdict, tests, coverage evidence, findings intake, severity decision (`smith gate run`)", "…7 more"]}
```

**Exit code is 0 whenever the command can answer** — a tier is a plan for the
run, not a verdict on it, so this reads like `security triggers` and not like
`wave check`. A tier the policy does not define is the one failure: `--effort
tiny` exits 1 with `effort.unknown-tier` rather than quietly falling back to
the default, the same way a typo'd field fails `plan validate` instead of
being ignored.

`profile` is what the tier buys, one field per step that a tier scales:
`preCodeResearch` and `preCodeUiux` gate the pre-code briefs at `/bs run`
step 3, `specReviewRounds` and `planQuorum` scale `/bs plan` steps 3–4,
`graderRounds` the rubric loop at step 6, `verifierSeverities` +
`verifierS3SpotCheckRatio` the adversarial verifier at step 7, and
`closingSpecReview` the closing review at step 13. `huge` is today's flow
written down unchanged; `medium` and `small` subtract from it.

`invariants` is what no tier may touch, and it is returned in full (elided
above): the gate pipeline, the integration check, claim disjointness and
worktree isolation, the security-reviewer's own triggers, the operator's plan
sign-off, the epic verdict, the event log and the escalation ladder run
identically at every tier. A `small` epic is faster because it deliberates
less, never because it verifies less.

**Read `effective`, not `requested`.** An epic whose live tasks fire
`crosscheck.yml`'s `plan_quorum` security triggers is floored at
`security_floor` no matter what was asked for — an internal tool that touches
auth is not a small epic:

```json
{"requested":"small","requestedFrom":"plan","defaultTier":"medium",
 "effective":"medium","floorApplied":true,"securityFloor":"medium",
 "securityFloorEvaluated":true,
 "securityTriggers":[{"kind":"security","taskId":"epic-1/task-1","matchType":"case","matchedValue":"infra"}],
 "reason":"the plan asked for \"small\"; raised to \"medium\" by the security floor — 1 security trigger(s) fired on this plan's live tasks (crosscheck.yml plan_quorum)."}
```

The floor only ever raises: ask for `huge` on a security-sensitive epic and you
get `huge`. `floorApplied` says outright that a request was overridden, so
nobody has to notice it by diffing two tables. Triggers are read from the
plan's **live** tasks — a superseded task is history, and an epic must not be
held at a higher tier by an ask it has already withdrawn.

`securityFloorEvaluated` is the field to check before trusting an empty
`securityTriggers`. Without `--plan` the floor is not evaluated at all, and
`[]` there means "not looked at", not "looked at and clean" — the same
distinction the closing spec review draws in §7. `requestedFrom` names who
chose: `flag` (a `--effort` that beats the plan file), `plan`, or `default`
(nobody chose, and `defaultTier` applies). `--policy` and `--crosscheck` point
at alternate policy files for a what-if.

## 0b. `smith new` — the project the factory builds in

The factory does not build inside itself. Everything from §1 on assumes a
**target project** that already exists somewhere else on disk, with its own git
history and its own gates. This is the one-time step that creates it.

Your stack answers come first, because `smith new` reads them rather than
asking:

```bash
smith stack show    # what factory/policies/stack.yml currently answers
smith stack check   # which of those answers the shipped templates honour
```

```json
{"ok":true,"answers":[
  {"field":"language","value":"typescript","support":"honoured",
   "note":"The base template scaffolds TypeScript."},
  {"field":"database","value":"none","support":"recorded",
   "note":"Nothing in factory/scaffold reads this. Read by the planner and coder, when a task needs storage."}]}
```

`support` is the field to read, and `recorded` is the value worth reading
twice. Those answers reach the agents — the planner and the coder are told
what you build with — but nothing in `factory/scaffold/` implements them, so
the scaffold will not contain them. A `refused` answer is different: it makes
`smith new` exit **1 before creating anything**, and `ok` goes false. That is
the whole point — `frontend: react` does not get you the Vue frontend the
templates do ship.

```bash
smith new my-app --target-dir ~/code/my-app     # --ui adds the frontend
```

```json
{"targetDir":"/Users/you/code/my-app","filesWritten":["package.json","..."],
 "branch":"setup","toolchain":{"status":"verified","steps":[...]},
 "commitIdentity":"machine",
 "commands":{
   "ghRepoCreate":"gh repo create my-app --private --source=/Users/you/code/my-app --remote=origin --push=false",
   "push":"git -C /Users/you/code/my-app push -u origin setup"}}
```

One call copies `factory/scaffold/` (TypeScript strict, Biome, Vitest, a CI
workflow), layers the frontend if `--ui`, vendors a design system if
`stack.yml` names a source for one, then runs `pnpm install`, `lint`,
`typecheck`, `test:coverage` and `build` — `ci.yml`'s order, so the lockfile
lands in the first commit and no epic ever needs a serial `task-0-toolchain`
(P9-19). It commits the result on a `setup` branch and appends a bootstrap
milestone to `factory/specs/roadmap.md`.

Read `toolchain.status`:

| Status | What it means |
|---|---|
| `verified` | Every gate passed. Plan the first epic against it |
| `failed` | `failedStep` names the gate; that step's `output` is the tail and its `command` is the exact line to re-run. Exit **1**, tree left in place to fix |
| `skipped` | `--skip-toolchain` was passed. `reason` says so. Nothing was proven — do not report a green |

`commitIdentity` is the other field worth a glance: it says whose name went on
the first commit — the machine's git identity, or the placeholder this repo
had to invent because the machine had none configured.

Without `--target-dir` the project lands beside this clone, in
`<repo-parent>/<project>`. That is a default, not a requirement: `projectDir`
is read as a path everywhere downstream, and because worktrees are siblings of
the project (§3) a clone anywhere on disk works.

**The last two commands are yours.** `commands.ghRepoCreate` and
`commands.push` are printed and not run. Creating a remote and pushing a
brand-new repository is an operator action — `guardrails.md` forbids an agent
session from doing either, and `/bs new` prints them for you to run rather
than running them.

The MCP surface is **not** part of this step. `smith mcp init <project>` layers
it on later, at the mandatory `<project> — mcp surface` milestone, once the
tools worth exposing are known; running it on day one would produce a manifest
declaring nothing, which is the rubber stamp the standard exists to prevent
(`docs/standards/mcp.md`).

What ships out of the factory carries no trace of it: no dependency on this
repo, no Blacksmith-shaped config, no docs about the loop that built it — one
`Built by Blacksmith` line in the project's README, and that is all.

## 1. Plan JSON → `smith plan validate`

A plan file is one **immutable plan version** for an epic: `epic_id`,
`version`, `status`, an array of `tasks` (each a full
`task-spec.schema.json` record — `task_id`, `objective`, `output_schema_ref`,
`acceptance_criteria`, `claims`, `budget`, `contract`, `case`, `origin`,
`task_status`), and `edges`.

```bash
smith plan validate factory/specs/active/epic-1/plan-v1.json
```

```json
{"valid":true}
```

Exit code `0` on `valid: true`, `1` otherwise — wire this into whatever
drives your loop so an invalid plan never reaches wave admission. A failing
validation returns the AJV error list under `errors` (same pattern
`wave check`, `gate run`, etc. use throughout — the CLI's convention is
"structured JSON out, exit code carries pass/fail").

`smith plan diff <v1.json> <v2.json>` renders the diff between two plan
versions — the re-planning decision itself, reviewable in the timeline
(architecture §12).
