# Epic spec — `bs-use`

- **Epic id:** `bs-use`
- **Plan:** `factory/specs/active/bs-use/plan-draft.json`, plan version 1,
  status `draft` — nothing dispatches until the operator signs this off
- **Effort tier:** `medium` (`factory/policies/effort.yml`; epic cap
  16,000,000 tokens in `factory/policies/budgets.yml`, alarm at 70%)
- **Project:** `black-smith` — this clone
- **Provenance:** operator decisions of 2026-10-13 (`/bs use` session
  binding: bind by one typed command, remind and never block, small changes
  bypass only on a recorded yes, generic, built on prompt capture), the
  research brief `state/results/bs-use.plan-research.json`, the code read
  at `1cdb9aaf` on `main`, and spec review round 1
  (`state/results/bs-use.spec-review.json`, seven findings, repaired in
  round 2)
- **Shape:** 6 tasks, 3 rounds, widest 4

## What this epic is

A Claude Code session started in the factory checkout often works on another
project the factory manages. Today nothing in the log says which one: the
prompt-capture hook files that session's prompts in the factory store's home
log `prompts-<cli-session-id>` with no project (rule M2 resolves the factory
checkout and stamps nothing), the live-session card on the dashboard shows a
project only when the session is driving an open epic, and nothing reminds
the session that a change to that project belongs in the factory pipeline.

This epic adds one operator act and two consequences of it.

- **The act.** The operator types `/bs use <project>` once. The existing
  `UserPromptSubmit` capture hook (`.claude/hooks/prompt-capture.sh` ->
  `dist/promptHook.js` -> `capturePrompt` in
  `factory/orchestrator/src/promptCapture.ts`) sees the typed text, resolves
  the name against the projects the factory knows (`factoryProjects`, the
  roadmap), and appends a `session-bound` event to the session's home log.
  That event is the binding. It lasts as long as the CLI session id does, and
  the newest one wins.
- **Filing.** Every prompt and option answer the session files in its home
  log from then on carries the bound project, so the timeline, the project
  filter and any later reader see that work under that project. The
  dashboard's live-session card names the bound project.
- **The reminder.** On every prompt turn of a bound session the same hook
  process prints a short reminder on plain stdout (the shape the capture line
  already uses to reach the model's context): the bound project, that
  questions are free, that every change to the project goes through the
  factory pipeline, and the one exception — a very small change, sized by
  numbers in a policy file, may skip the pipeline only after the session asks
  the operator with a fixed question that names the change and the operator
  picks the fixed yes. The hook records that yes, with the question it
  answered, as a `pipeline-bypass-approved` event.

Nothing here ever refuses or holds a prompt or a tool call. The binding is
recorded and reminded; it is never enforced by a block, and the plan adds no
switch that could later make it one.

## Decisions taken by the operator (fixed, not re-opened by this plan)

1. A session binds when the operator types `/bs use <project>` once; the
   binding lasts the CLI session's lifetime; its prompts and work are filed
   under that project.
2. Enforcement is a reminder, never a block. No hook, guard or verb refuses
   or holds a prompt or tool call because of the binding. No blocking guard,
   no opt-in blocking mode, no later strict switch.
3. Questions and answers are free and still recorded. Every change to the
   bound project goes through the factory pipeline (analysis, plan, run,
   checks, merge). A very small change may skip it only after the session
   asks the operator and gets a yes, and that yes is in the event log.
4. Generic: no project name is hard-coded anywhere — code, tests, fixtures,
   docs, skill. It works for any project the factory can resolve.
5. Built on prompt capture; no second capture path.

## Design this plan commits to

- **One source of truth.** The binding is the newest `session-bound` event
  with the session's `cli_session_id` in the home log `prompts-<cli>` of the
  store the turn's cwd resolves to. The capture reads it with the events
  reader (`readEvents`), as it already reads that log; the dashboard reads
  the projected copy in `events_raw` (`event_type = 'session-bound'`, newest
  per CLI session id); any later reader reads the same event. There is no
  second file, no environment variable and no table that holds a binding.
- **A bounded read for the reminder.** The reminder runs on every turn, so it
  does not read the whole log. It makes one read of at most
  `BINDING_TAIL_BYTES` (1 MiB) from the end of the home log and walks those
  records newest first. To keep that window enough on a long session, every
  `user_prompt` the hook files in a bound session's home log carries
  `payload.bound_to`, the event id of the binding in force when it was
  filed; a stamped prompt carries its record `project`, which is the bound
  project. The stamp points at the binding; it is not a second binding. The
  walk stops at the first `session-bound` event (its project), the first
  stamped hook prompt (its project) or the first unstamped hook prompt (not
  bound). So on a turn that is not a `/bs use` command the reminder's reads
  are: the store resolution the capture already does, at most 1 MiB of the
  home log, and the policy file. The roadmap's project list is read only on
  a `/bs use` turn. The capture's own reads of the log are as they are today.
- **Who writes it — the trust model.** The capture hook is the only writer of
  `session-bound` and `pipeline-bypass-approved`, from the operator's own
  typed prompt or `AskUserQuestion` answer, with actor `user`. A genuine
  `pipeline-bypass-approved` event has as its `causal_parent` a hook-captured
  answer `user_prompt` (payload `source: 'hook'`) whose `prompt_id` matches
  the event's `payload.prompt_id`; that is what an auditor checks. The skill
  playbook never writes either type, no verb is added that does, and
  `bs event append` refuses both with `events.hook-only-event-type`. It
  also refuses a hand-written `user_prompt` that carries `source: 'hook'`
  or a `bound_to` (plan v4). The binding is read from those fields, the
  hook writes them in-process, and `bs prompt record` writes neither. That
  refusal turns away those hand-written records and nothing else. It holds
  no prompt and no tool call, so it is not a block.
  What stays possible: a session with a shell can still hand the hook entry,
  or `bs prompt capture`, a payload it made up, and the record would look
  genuine. The record is audit evidence, not a security boundary, and this
  epic does not claim more (open question 9).
- **Where binding applies.** Only when the store resolves by rule M1, M2 or
  M4. A store found only by rule M3 (a bare `/bs` command in a directory
  whose work root has a store) is not one later non-command prompts resolve
  to, so a binding there could never be read back; the hook prints a fixed
  line saying the binding was not recorded instead.
- **Name resolution.** `/bs use <name>` matches `<name>` against the names
  `factoryProjects` returns, compared through `normalizeProjectName`; the
  stored project is the roadmap's own spelling. The factory itself is one of
  those names and binds like any other. A name with no match writes nothing
  and leaves an earlier binding standing.
- **Rebind and repeat.** A second `/bs use` naming another known project
  appends a new `session-bound` event; the newest wins. Naming the project
  already bound appends nothing. There is no unbind in this epic (open
  question 2).
- **Filing rule.** In a bound session, a `user_prompt` filed in the home log
  takes the binding's project ahead of its parent's, the declared project and
  the root's. A prompt filed in an epic log keeps that log's project exactly
  as today, so an epic's timeline never gains a second project.
- **Reminder content.** Built from the binding's project, fixed strings in
  `factory/orchestrator/src/sessionBinding.ts`, and the two numbers in the
  policy file (or, when the file cannot be read, its path) — and nothing
  else. Every line starts with the fixed prefix `"bs use: "`. It is the same on
  every turn (open question 4 asks whether to shorten it).
- **Very small, defined, and the operator's to tune.** A change that touches
  at most `max_files` files and at most `max_changed_lines` added plus
  removed lines. The numbers are operator-tunable through the overlay rule
  `factory/orchestrator/src/paths.ts` already applies to the roadmap,
  `lessons.md` and `stack.yml`: the shipped
  `factory/policies/session-binding.yml` (under `REPO_ROOT`) is the default,
  and a copy at `<work root>/factory/policies/session-binding.yml` (under
  `OVERLAY_ROOT`) wins when it exists, read through `resolveOverlayRead`. In
  a clone the two are the same file; in an install the copy survives an
  upgrade. The draft values are 1 file and 10 lines (open question 1). The
  reminder quotes the numbers; no prompt, playbook or doc restates them.
  When the file it reads is missing or invalid, the reminder still prints
  and says so in a line naming the file, and says no small-change bypass is
  available this turn, so every change goes through `/bs plan` and
  `/bs run`; `use.md` tells the session to pass that line to the operator.
- **The recorded yes, one per change.** The question is an
  `AskUserQuestion` whose header is the fixed string `BYPASS_HEADER` and
  whose chosen option is the fixed label `BYPASS_YES`, both stated in the
  reminder. The question text names the one change: the files it will touch
  and its estimated changed lines. One yes covers that one change; a second
  change asks a second question. The existing answer-mode capture
  (`PostToolUse` on `AskUserQuestion`) already files the answer as a
  `user_prompt` with actor `user`; in a bound session, when one answer row
  matches header and label exactly and its question is not empty, the same
  append also writes a `pipeline-bypass-approved` event: actor `user`,
  `payload.question` = the question text, `payload.prompt_id` = the tool use
  id, `causal_parent` = that answer's `user_prompt`, and record `project`
  and `payload.project` both equal to that `user_prompt`'s project. So in a
  home log the event carries the bound project, and in an epic log it
  carries the epic log's project, and an epic log stays single-project.
- **Plain stdout, exit 0, two independent steps.** The hook keeps the shape
  it has: plain text lines on stdout, exit status 0. It never prints a JSON
  hook response, so it never emits `decision`, `continue`,
  `hookSpecificOutput` or `permissionDecision`. In prompt mode it reads stdin
  once and runs two steps, the capture and the reminder, each in its own
  `try`/`catch` (`promptTurnLines` in
  `factory/orchestrator/src/bindingReminder.ts`): a capture that writes
  nothing (a duplicate, a harness text) or throws still leaves the reminder
  printed, and a reminder that throws still leaves the capture line printed
  and the prompt through.
- **One capture path.** `.claude/hooks/hooks.json` keeps exactly its two
  entries, the shim keeps `exit 0`, and no new bin, hook or entry point is
  added. The CLI verb `bs prompt capture` (the test surface in `cli.ts`)
  writes bindings through the same `capturePrompt` and is not taught to print
  the reminder; the plugin reaches the hook through the bin only.

## Acceptance criteria

Each criterion is a property of the shipped code, proved by a named test that
fails on `main` at `1cdb9aaf` and passes after the plan.

1. **Binding is recorded.** A prompt-mode payload whose prompt is
   `/bs use <name>`, where `<name>` matches a project `factoryProjects`
   returns, in a store resolved by M1, M2 or M4, leaves exactly one new
   `session-bound` event in the home log `prompts-<cli>`: actor `user`,
   `project` = the roadmap's spelling, `cli_session_id` = the payload's
   session id, `payload.project` equal to `project`, `causal_parent` naming an
   event of the same log. Naming the bound project again appends none; naming
   another known project appends one more, and `newestBinding` returns the
   newer.
2. **Bound work is filed under the project.** In a bound session, every
   `user_prompt` the hook files in the home log — typed prompts and option
   answers — carries the binding's `project` and `payload.bound_to` = that
   binding's event id, including the `/bs use` prompt itself; a prompt filed
   in an epic log keeps that log's project and carries no `bound_to`; an
   unbound session's records are unchanged.
3. **Unknown names change nothing.** `/bs use <name>` with no match, or with
   no name, appends no `session-bound` event and leaves an earlier binding
   standing; the hook prints fixed lines listing the known project names, and
   the printed text contains none of the typed prompt text.
4. **Every turn of a bound session is reminded, at a bounded cost.** A
   prompt-mode run of the hook in a bound session prints the reminder lines
   on stdout, each starting `"bs use: "`, built from the binding's project,
   fixed strings and the policy numbers only; they print when the capture
   wrote nothing (duplicate prompt, harness text) and when the capture threw,
   and the capture line prints when the reminder threw. The reminder reads at
   most `BINDING_TAIL_BYTES` (1 MiB) of the home log: with a home log of more
   than 4 MiB whose binding lies outside that window and whose early part
   holds a line that is not JSON, it still prints the bound project's
   reminder. An unbound session prints no reminder line; answer mode prints
   none.
5. **Nothing blocks.** For a bound session, an unbound session, an unknown
   name and an internal failure (an unreadable home log), the built hook
   `dist/promptHook.js` exits 0 and no stdout line parses as a JSON value —
   so none carries `decision`, `continue`, `hookSpecificOutput` or
   `permissionDecision`. `.claude/hooks/hooks.json` still holds exactly one
   `UserPromptSubmit` hook, `prompt-capture.sh`, and the shim still ends
   `exit 0` (`test/pluginManifest.test.ts` unchanged and green).
6. **"Very small" lives in a policy file the operator can override.**
   `factory/policies/session-binding.yml` holds `max_files` and
   `max_changed_lines`; the reminder quotes both; a test that writes other
   numbers into a temp policy file sees the reminder text change; with two
   distinct temp roots, the overlay copy is read when it exists and the
   shipped file otherwise; a missing or invalid file makes
   `loadBindingPolicy` return `{ok: false, file, problem}` without throwing,
   and the reminder names that file, says it is missing or invalid, and says
   no small-change bypass is available this turn.
7. **The bypass yes is recorded, for one change, by the hook alone.** In a
   bound session, an `AskUserQuestion` answer with a row whose header is
   `BYPASS_HEADER`, whose answer is `BYPASS_YES` and whose question is not
   empty leaves exactly one `pipeline-bypass-approved` event in the same log
   as the answer's `user_prompt`: actor `user`, `payload.question` = the
   question text, `causal_parent` = that `user_prompt`'s event id,
   `payload.prompt_id` = the tool use id, and record `project` and
   `payload.project` = that `user_prompt`'s project (in an epic log of
   another project, the epic log's project). Any other answer, an empty
   question, an unbound session, and a repeat of the same tool use id write
   none. `bs event append` of a `session-bound` or a
   `pipeline-bypass-approved` event exits 1 with
   `events.hook-only-event-type` and writes nothing. So does a `user_prompt`
   append whose payload carries `source: 'hook'` or a `bound_to` (plan v4).
   A `user_prompt` append with neither field still writes.
8. **Both event types are registered and visible.** `session-bound` and
   `pipeline-bypass-approved` are in `FREE_EVENT_TYPES`
   (`test/helpers/eventTypeScan.ts`, `writtenBy: 'src'`), so
   `test/eventTypes.test.ts` passes; both are in `FREE_TIMELINE_EVENT_TYPES`
   with an `eventKind` and a dashboard title, so they reach the timeline.
9. **The dashboard names the bound project.** The live-session card's
   `project` is the project of the newest `session-bound` event for that CLI
   session id in any readable store; with none it is what it is today (the
   newest open linked epic's project, or null).
10. **The skill routes `/bs use`.** `.claude/skills/bs/SKILL.md` lists
    `/bs use <project>` in its subcommand table and its description, and links
    `use.md`; `use.md` tells the session what to do with the hook's lines
    (confirm the binding, route changes through `/bs plan` and `/bs run`, ask
    the fixed question for a very small change, report an unrecorded binding,
    relay a missing or invalid policy line), requires the question to name the
    files the change will touch and its estimated changed lines, says one yes
    covers one change and a second change asks again, and says that the
    session never writes a binding or a bypass record itself and that nothing
    blocks. A test fails when `use.md` drops the one sentence that carries
    the fixed phrase "names every file the change will touch and its
    estimated changed lines" (the test expects it exactly once) or the
    phrase "one yes covers one change".
11. **Generic, checked in two layers.** No project name is a literal in the
    diff's code, tests, fixtures, docs or skill text; tests bind two
    different fixture names through the same path; resolution goes through
    `factoryProjects` and `normalizeProjectName` only. The mechanical layer is
    a hermetic test (`test/sessionBindingNames.test.ts`): it reads every
    `/bs use` argument in every file the plan adds or edits, and every
    `project:` / `"project":` value and `- project:` roadmap line in every
    file the plan adds, and fails on any value other than `project-a`,
    `project-b` or `<project>` (`nothing-here` for an unknown `/bs use`
    example). It reads repo files only — no roadmap, overlay or
    `factoryProjects` list — so it gives the same answer on CI as on a
    workstation. A `project:` or `"project":` value in a case a task adds
    to an existing test file follows the same rule but is not read by the
    scan (CI clones one commit deep, so the scan reads no git diff); that
    value, and a name in prose that fits none of those forms, are the
    reviewer gate's to catch.
12. **Documented.** The operator docs describe `/bs use`, the reminder, the
    policy file and its override, the bypass record, the append refusal and
    the dashboard label; the `/bs` verb lists in `CLAUDE.md` and in the
    `AGENTS.md` router table name `use`; the "Live sessions" section of
    `docs/guide/dashboard.md` says a bound session's card shows the bound
    project; and the doc tests (`test/docCommands.test.ts`,
    `test/operatorLanguage.test.ts`) stay green.

## Out of scope

- Any block, hold, refusal, opt-in strict mode or guard keyed on the binding.
  (`bs event append` refusing the two hook-only event types, and a
  hand-written `user_prompt` carrying the hook's fields (plan v4), refuses
  a record, not a prompt or a tool call. It is keyed on the record, not on
  a binding.)
- A proof of origin at the hook entry or in `bs prompt capture`. The records
  are audit evidence; a later check of a bypass event's parent is open
  question 9.
- Measuring a change after the fact against the small-change numbers. The
  threshold is what the reminder asks the session to respect; checking a diff
  against it is a later epic if the operator wants one (open question 6).
- Bounding the capture's own reads of the home log and epic logs; those are
  as they are at `1cdb9aaf`. This epic bounds only what it adds.
- Mirroring bound prompts into the bound project's own store; they stay in
  the store the cwd resolves to.
- An unbind verb, a binding that outlives its CLI session id, and carrying a
  binding to a session with a new id.
- `promptImport` (transcript backfill) reproducing bindings; a binding is a
  live act.
- Teaching `bs prompt capture` (the CLI verb) to print the reminder.
- Changing the project of prompts filed in an epic log.
- The bs-mod band and any dashboard surface other than the live-session card
  and the timeline titles.
- Adding a CLI verb or editing `usage.ts`. The one `cli.ts` change is the
  hook-only refusal in `bs event append` (plan v4: it also covers a
  hand-written `user_prompt` carrying the hook's fields).

## Claims map and round shape

| Task | Owns | Round | Depends on |
|---|---|---|---|
| task-1 binding rules | `src/sessionBinding.ts` (new), its test, `factory/policies/session-binding.yml` (new), `test/helpers/eventTypeScan.ts`, `src/db/queries.ts` (the two timeline-list entries and their `eventKind` only) | 1 | — |
| task-2 capture writes | `src/promptCapture.ts`, `test/promptCaptureBinding.test.ts` (new) | 2 | task-1 |
| task-3 reminder | `src/bindingReminder.ts` (new), `src/promptHook.ts`, `test/bindingReminder.test.ts` (new), `test/promptHookEntry.test.ts` | 2 | task-1; `keeps_exports` on task-2's `promptCapture.ts` |
| task-4 skill and append guard | `.claude/skills/bs/SKILL.md`, `.claude/skills/bs/use.md` (new), `test/skillUse.test.ts` (new), `src/cli.ts` (the `event append` refusal only), `test/eventAppendHookOnly.test.ts` (new) | 2 | task-1 |
| task-5 dashboard | `src/db/queries.ts`, `test/db/cliSessionBinding.test.ts` (new), `ui/server/src/cliSessions.ts`, `ui/server/test/cliSessions.test.ts`, `ui/src/lib/timelineDisplay.ts`, `ui/test/timelineDisplay.test.ts` | 2 | task-1 |
| task-6 flow, names, docs | `test/sessionBindingFlow.test.ts` (new), `test/sessionBindingNames.test.ts` (new), `README.md`, `docs/guide/operator-loop.md`, `docs/guide/operator-guide/queue-and-gate.md`, `CLAUDE.md`, `AGENTS.md`, `docs/guide/dashboard.md` | 3 | task-2, task-3, task-4, task-5 |

Paths under `src/` and `test/` are under `factory/orchestrator/`.
`queries.ts` is a hub. Task-1 and task-5 both edit it, one after the
other: task-5 depends on task-1, so the two claims never run together.
Task-1 takes the two `FREE_TIMELINE_EVENT_TYPES` entries and their
`eventKind` case because `test/eventTypes.test.ts` fails when a type is
declared in `FREE_EVENT_TYPES` but is neither shown on the timeline nor
excused, and it also fails when a timeline type is not declared. The
declaration and the timeline entry therefore have to land in the same task.
Task-5 adds only the `cliSessionBindings` reader. `promptCapture.ts` is
claimed by task-2 alone; task-3 imports only exports it already has.
`cli.ts` is a hub claimed by task-4 alone, for the refusal and nothing
else; `usage.ts` is claimed by no task. `paths.ts` gains one overlay pair for the policy file, claimed by
task-1 alone (plan v2: `test/paths.test.ts` requires a `paths.ts`
constant for every file in `factory/policies/`); `sessionBinding.ts`
imports and re-exports it.

## Open design questions (for the operator)

1. **The small-change numbers.** Draft: `max_files: 1`,
   `max_changed_lines: 10` (added plus removed), in the shipped
   `factory/policies/session-binding.yml`. An operator changes them with a
   copy at `<work root>/factory/policies/session-binding.yml`, the overlay
   rule the roadmap and `stack.yml` follow; in a clone the tracked file is
   that copy. Are the draft values right?
2. **Unbind.** No unbind in this epic; rebinding to another project is the
   only change. Should `/bs use` with no name, or a reserved word, unbind?
   (A reserved word would be the one name a project could not use.)
3. **Resumed sessions.** The binding is keyed on the CLI session id, so a
   resumed session that keeps its id stays bound and one that gets a new id
   does not. Is that the wanted lifetime?
4. **Reminder length.** The same full reminder every turn (draft) or a
   one-line form after the first turn of a binding?
5. **Card precedence.** The card shows the bound project ahead of the open
   linked epic's project. If a bound session drives an epic of another
   project, should the epic's project win instead?
6. **Checking the size.** Should a later epic measure a bypassed change
   against the policy numbers after the fact and raise a finding when it is
   larger (still never a block)?
7. **Bypass question wording.** Draft header `Small change` (the header chip
   holds 12 characters) and draft yes label `Yes, skip the pipeline`.
8. **Store per cwd.** The binding is read from the store the turn's cwd
   resolves to; a session that changes directory into another store's
   checkout reads that store and is unbound there. Acceptable?
9. **Checking a bypass record.** An auditor tells a genuine yes from another
   record by its `causal_parent` (a hook-captured answer `user_prompt`) and a
   matching `prompt_id`. Should a later epic add a check that raises a
   finding on a `pipeline-bypass-approved` event without that parent (still
   never a block)?
