# Epic spec — `bs-review`

- **Epic id:** `bs-review`
- **Plan:** `factory/specs/active/bs-review/plan.json`, plan version 1,
  status `draft`. The operator approved it on 2026-10-19 subject to the
  round-3 fixes, which this version carries. Nothing dispatches until it is
  filed.
- **Effort tier:** `medium` (epic cap 16,000,000 tokens in
  `factory/policies/budgets.yml`, alarm at 70%)
- **Project:** `black-smith` (this clone)
- **Provenance:** the operator-approved goal of 2026-10-14 and 2026-10-19
  (G1–G4, docs and positioning I0–I3 with I4–I6 folded in, the
  delegation-check continuation, the policy-rule follow-ups), and the code as
  read on `main` at `0e845840`
- **Shape:** 17 tasks, 5 rounds, widest 7. `claims impact` is clean.
  `wave schedule`: depth 5, widest 7, none stalled.
- **Coder budget:** task caps sum to 3,100,000 tokens (round 3 raised task-7
  from 200k to 210k). A first pass with review is about 8.0M, under the 11.2M
  alarm.

## What this epic is

The goal is to let Blacksmith show whether it is worth its cost compared with
plain Claude Code. It also makes Blacksmith easier to install, tightens two
enforcement checks, and then rewrites the public positioning on top of what
the epic built. No task needs a number from a trial run: every measured value
the docs carry reads `NOT MEASURED` until a real run exists, and a single
real run is labelled single-run.

## Workstreams and tasks

| Workstream | Tasks |
|---|---|
| G1 effectiveness metrics in `bs stats`, with the I5 opt-in export | 4 transcript tokens · 5 effectiveness fold · 6 export renderer · 7 CLI verbs |
| G2 trial kit: plain Claude Code vs Blacksmith, with the I6 methodology | 8 sample app · 9 task corpus · 10 recording harness · 11 methodology doc |
| G3 easier install, with I4 | 12 package ships the dashboard · 13 `bs doctor` install check · 17 next steps after `bs init` and the unbuilt-dashboard message |
| G4 opt-in plugin enforcement | 14 plugin policy hook behind `BS_PLUGIN_GUARD=1` |
| (b) delegation check on a continuation | 3 |
| Policy-rule follow-ups | 1 git configuration values · 2 xargs, shell pipes and a per-command history-rewrite check |
| I0–I3 docs and positioning (last) | 15 README first screen, quickstart, one description · 16 claims matrix and CHANGELOG |

Rounds:

1. 1, 3, 4, 6, 8, 12, 13
2. 2, 5, 9, 14, 17
3. 7, 10, 11
4. 15
5. 16

## Acceptance criteria (epic level)

Each criterion is proved by the tests or docs the named task adds.

1. **Tokens are measured, not estimated** (task-4, task-5, task-7).
   - Tokens per task and per role come from Claude Code transcripts by the
     dashboard Budget's definition: input + cache creation + output, no
     cache reads, deduplicated by message id + request id.
   - Each total carries `complete`; an incomplete total prints as "at least".
   - Tokens that match no dispatch are reported as unattributed and are
     never spread over tasks.
   - The dashboard Budget numbers do not change.
2. **Escaped defects and precision** (task-5, task-7).
   - An escaped defect is a finding or issue that names a task after its
     `wave-merged`, on a task whose gate passed. It counts when confirmed or
     fix-*, shows as pending while raised, and is excluded when refuted.
   - Precision per role is confirmed / (confirmed + refuted + waived), shown
     with its counts. It reads null with no decided finding.
3. **Opt-in export** (task-6, task-7).
   - `bs report export` writes redacted Markdown to stdout or `--out`, or
     the same content as JSON. Nothing is published.
   - Neither form holds a home-directory or temp path, or the user name in
     one, in any of task-6's forms. A dash-encoded slug is replaced whole by
     `<home-slug>`. Other absolute paths, such as `/usr/bin/git`, name no
     user and are kept as written. Neither form holds transcript text.
   - Both forms open with the notice "Review this export before you share
     it.": the Markdown first line, and the JSON `notice` key.
   - Passed, failed, not run and unknown stay distinct.
   - The JSON of existing `bs stats` and `bs report` only gains fields.
4. **Trial kit, no numbers** (task-8 to task-11).
   - The kit has a generic dependency-free sample app and five task kinds
     (REST endpoint, large refactor, multi-file bug, FE+BE feature, DB
     schema change). Each kind has one prompt for both arms and a hidden
     check in two directories its manifest names, `check/fail_to_pass/` and
     `check/pass_to_pass/`.
   - A self-check shows, test by test, that on the start state every
     fail_to_pass test fails and every pass_to_pass test passes.
   - A harness prepares, records and summarizes runs and never launches
     Claude. It reads the two check directories from the manifest.
   - A methodology doc and a results template carry `NOT MEASURED` for every
     number, pinned by a test.
5. **Install** (task-12, task-13, task-17).
   - The package `files` include `ui/dist` and `ui/server/dist`, and a
     prepack builds them.
   - `bs doctor [--json]` reports each check as ok, missing or unknown in
     plain words or JSON.
   - `bs init` stdout stays byte-for-byte the same; guidance goes to stderr.
   - The missing-CLI, missing-plugin and unbuilt-dashboard messages name the
     fix. For an installed package, the guidance and the unbuilt-dashboard
     message quote INSTALL.md's `/plugin` lines and its install line, and a
     test pins each one equal to the doc.
   - Nothing is published or version-bumped.
6. **Opt-in plugin enforcement** (task-14).
   - The plugin's PreToolUse hook does nothing unless `BS_PLUGIN_GUARD=1`.
   - When the switch is on, the hook runs the policy hook. If no policy hook
     is found, it asks with a clear message.
   - One doc names the switch and the deny rules. The environment variable
     `BS_PLUGIN_GUARD=1` is the only switch it documents. Its deny block
     equals the clone's `.claude/settings.json` list, pinned by a test.
   - No `factory/policies/*` edit.
7. **Delegation continuation** (task-3).
   - A `dispatch_decision` with `continuation_of` is answered by the
     session its original dispatch opened. The original can sit in an
     ancestor session, and its opened session can be known only through
     `openedElsewhere`.
   - The check reads `ok` when the original opened a session. Otherwise the
     original's status (`unverifiable` or `violation`) applies.
   - A fresh dispatch is judged exactly as before.
8. **Policy rules** (task-1, task-2).
   - The force-push rule reads a command line given in these places the same
     way it reads the command line typed directly:
     - a git configuration value: `-c`, `--config-env`, `GIT_CONFIG_*`,
       `GIT_PAGER`, `GIT_EXTERNAL_DIFF`, `-O`. This covers the git command
       itself, an earlier assignment on the line, and `env`.
       `GIT_CONFIG_PARAMETERS` is read in both entry spellings,
       `'key=value'` and `'key'='value'`, and in a value that mixes them;
     - git arguments supplied through `xargs`;
     - git output that a shell runs.
   - A value the rule cannot read is refused.
   - The history-rewrite rule reads each command on its own and allows a
     read-only search that names a rewrite word.
   - Every existing policy test passes unchanged.
9. **Docs last and backed** (task-15, task-16).
   - The README first screen opens with "From feature request to reviewable
     PR — with an AI engineering workflow." and has a workflow table
     compared with plain Claude Code.
   - `docs/guide/quickstart.md` exists.
   - package.json, the `blacksmith` marketplace entry, plugin.json and the
     README share one description, pinned by a test.
   - About, topics and plugin-hub listings are a proposal doc only.
   - A demo appears only from a real run labelled single-run. Otherwise the
     README shows a `NOT MEASURED` placeholder.
   - `docs/claims-matrix.md` maps every public claim to code or a test and
     states its limits. An unbacked claim is reworded or removed.
   - The test cuts the README first screen into claims by a stated rule that
     reads structure, not words. A table body row, a bullet, a sentence and a
     whole `<pre>` or prose fenced block are each one claim. A command fence
     is not a claim. A fixture case per unit shows the check fails when that
     claim has no row.
   - CHANGELOG Unreleased has the epic's entries, all written by task-16.

## Inherited constraints

- Open source:
  - no other project names, no client code, no absolute user paths;
  - fixtures use placeholder names.
- TDD.
  - The full root `pnpm run test` gates every task.
  - The typecheck variants and `biome check .` run separately.
  - Tasks touching `ui/server` also run `typecheck:server` and `test:server`.
  - Docs tasks run `bash scripts/check.sh` and name every SKIP.
- No new runtime dependency. hono and @hono/node-server move from
  devDependencies to dependencies (task-12), because the shipped dashboard
  server imports them at run time.
- CHANGELOG has one owner, task-16. Every other task leaves a user-facing note
  in its result.
- Wording of the policy-rule work is neutral behaviour description only.

## Claims map

- **Hubs.**
  - `policy.ts`: tasks 1 → 2.
  - `cli.ts`: tasks 13 → 17 → 7. `usage.ts`: tasks 13 → 7.
  - `package.json`: tasks 12 → 14 → 15 → 16.
  - `packaging.test.ts`: tasks 12 → 14.
  - README and the manifests: tasks 15 → 16.
  - CHANGELOG: task-16 only.
- **keeps_exports promises.**
  - `policy.ts`: tasks 1 and 2.
  - `delegation.ts`: task-3.
  - `ui/server/src/cliSessions.ts`: task-4.
  - `cli.ts`: tasks 7, 13 and 17. `usage.ts`: tasks 7 and 13.
- **Outside the root gates.** `trial/**` is not in npm `files`. The harness
  logic sits in `factory/orchestrator/src/trial/` so the root suite tests it.

## Operator answers (resolved 2026-10-19)

All six questions are answered. `open_questions` in `plan.json` is now empty.
The answers are recorded once, in the "Operator answers" planner note, and
here.

- **Dashboard dependencies.** hono and @hono/node-server move into
  `dependencies` (task-12). There is no bundling task, because the shipped
  dashboard server imports them at run time.
- **Milestone.** bs-review attaches to a new milestone, "worth-it evidence",
  not `agent-bench`. The orchestrator adds it to `roadmap.md`; this plan does
  not edit that file.
- **Trial runs and their spend.** Left to the operator, decided later. No
  task runs the trial.
- **Sample app location.** It stays in-repo under `trial/sample-app/`. A
  separate public repository is decided later.
- **The plugin-guard switch.** Only the tested switch, the environment
  variable `BS_PLUGIN_GUARD=1`, is documented. A settings-file `env` entry is
  not documented as a switch.
- **Policies.** No task edits `factory/policies/*`. A task that finds it
  needs one stops and asks.
