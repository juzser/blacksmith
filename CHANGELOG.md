# Changelog

Blacksmith has **no versioned releases**. It runs from a clone, not from a
registry: `package.json` is `version: 0.0.0`, there are no git tags, and the
only supported revision is `main`. So this file is not a list of releases —
it is a list of what landed, in the order it landed, keyed to the milestones
in [`factory/specs/roadmap.md`](factory/specs/roadmap.md).

Dates are the day the roadmap first recorded a milestone as `completed`,
derived from the development history that preceded this repository. They mark
when the phase was declared done, which for the earliest phases is later than
when the work started — development began 2026-08-03.

Format loosely follows [Keep a Changelog](https://keepachangelog.com);
newest first.

## Unreleased

This repository is the public release of Blacksmith. The work was done in a
private repository and published here as a single initial commit, so the phase
entries below record development that predates this repo's git history rather
than appearing in it.

### Added

- **The dashboard can be asked about one run, and about that run's lineage.**
  D-263/D-264 taught the server to read `?session` and `?lineage` on every read
  route and then deliberately stopped there, because "a session picker in the
  UI is a feature in its own right". This is that feature. Every page that
  consumes the scope — Overview, Sessions, Timeline, Kanban, Flow, Errors,
  Analytics — carries a session picker in the topbar beside the project
  switcher, and picking a run adds a width control: **This session** or **With
  its lineage**. The choice rides in the route query, so a scoped view survives
  a reload and can be pasted to somebody else, and clearing the run clears the
  widening with it — `lineage` with no `session` is the pair the server
  refuses, and `SessionScope` makes it unrepresentable rather than unsent. It
  matters most on Sessions, the page the operator asked to be able to read when
  a screenful of dispatched wave-runners is on it: since D13 an epic spans three
  sessions, so "what did this epic do" is a question about a lineage and the
  dashboard had no way to ask it about anything narrower than the whole state
  dir. The rules live in `ui/src/lib/sessionScope.ts` under 46 unit tests, not
  in the `.vue` files that neither tsc nor biome checks here, and the topbar
  picker is fed by a new thin `/api/sessions` route rather than by a second
  shell-level caller of `/api/overview` — the two pages that poll that endpoint
  every 5s are also the two whose outage guards fail it deliberately.

- **An agent may now dispatch agents, and `factory/policies/delegation.yml`
  says which one.** D13 closed on "the orchestrator cannot be split"; this is
  the third and last step of splitting it. `.claude/agents/wave-runner.md` is
  a thirteenth role holding a scoped `Agent(coder, tester, …)` grant and
  running one admitted wave, so an epic can hand a wide wave away entirely
  instead of spending its own window on it. Every other template still holds
  no `Agent` at all. The grant is not free: `smith delegation check
  <session-id>` reports the topology and the run as two halves of one answer,
  because they fail apart — a sound topology can be disobeyed, and an obeyed
  one can be unsound. It refuses a role that dispatches itself, a worker that
  dispatches its own auditor from `crosscheck.yml`'s `role_isolation.pairs`,
  a finder that dispatches its own critic from `asymmetric_roles.pairs`, a
  template holding `Agent` that no grant names (and a grant naming a template
  that does not, D-191), and a scoped `Agent(…)` whose scope disagrees with
  the policy — the harness enforces the template at dispatch time while the
  audits read the policy, so a disagreement is a rule nobody applies. At run
  time it asserts the one thing the grant is bought with: a grantee opens its
  own session against the `dispatch_decision` that started it, **before** it
  dispatches anything. That is what keeps `smith tester check` and `smith
  dispatch check` sound, both of which read a second dispatch as evidence of
  a second turn and can only do so while the dispatching node owns the log it
  writes into. Fail-closed on `unverifiable` as well as on `violation`: a
  wave-runner that has not opened its log *yet* is not a pass, because it is
  the same silence a green would hide. The read folds the lineage (D-119),
  which here is the whole point — a wave-runner's dispatches land in its own
  log, so a session-scoped read would find the delegation it exists to audit
  absent and call that fine. `delegationCli.test.ts` drives the built binary
  over every status the verb can return, including the sibling-scoped control.

- **`/bs run` is two playbooks, so an epic stops carrying every wave's turns.**
  `.claude/skills/bs/SKILL.md` is now the epic tier — it plans, admits one wave
  (step 1) and closes the epic (steps 11-17) — and the new
  `.claude/skills/bs/wave.md` is the wave tier, carrying steps 2-10, worktrees
  through merge queue, and written to be thrown away when the wave lands. A
  wave opens a log of its own with `smith session start <wave-id> --continues
  <epic-session>#<n>` when it is too large for the epic's window, and runs
  inline in the epic session when it is not; both shapes are correct because
  `--continues` is what keeps the epic's own reads able to see the work. That
  is D13 step 2 — "each tier owns the log for what it dispatches" — and it is
  only safe because D-266 taught lineage to walk down as well as up. The
  concurrency and event-id rule moved with it, out of the epic tier's step 1
  and into the shared **Dispatch contract**, because the fan-out it describes
  now happens one tier below: a rule scoped narrower than the thing it guards
  is D-119's shape, and D-119 is how a `hold` with eleven open findings became
  a `go` with none. `factory/orchestrator/test/waveTier.test.ts` drives the
  built binary over the exact topology and pairs every claim with the control a
  session-scoped read would fail: `wave audit`, `budget alarm`, `tester check`
  and `judge outstanding` answer about a wave session's dispatches from the
  epic session that admitted them, and about nothing from a *sibling* wave.
  `effort.test.ts`'s knob guard widened with the split — it reads every `*.md`
  under `.claude/skills/bs/` rather than two sections of one file, because five
  of the eight effort knobs are spent in the tier that moved.

- **A roadmap that shows what the factory built, not how it was built.** A
  milestone now carries a `kind` — `product`, `dogfood` or `factory` — parsed
  from an optional `- kind:` bullet in `factory/specs/roadmap.md` and stored on
  the `milestones` row (migration `0010_milestone_kind`). Blacksmith's own
  phases are `factory` and the epic that builds a project to prove the factory
  works is `dogfood`; everything else is `product`. The Roadmap page draws
  `product` only, because the operator asking "where is my project" is not
  asking about the machine that is building it, and states the hidden count and
  the projects it belongs to rather than pretending the rows do not exist — a
  toggle brings them back. Three typed refusals guard the parse:
  `roadmap.invalid-kind` for a kind that is not one of the three,
  `roadmap.factory-kind-fixed` for an attempt to relabel Blacksmith's own
  phases, and `roadmap.conflicting-kind` for a project whose milestones
  disagree with each other, because a project is one kind of thing or the file
  is wrong.

- **Every board caps what it draws, and says what it capped.** Three canvases
  grew past the point where scrolling was a substitute for structure, and each
  is now bounded by a tested pure function rather than by the operator's
  patience:

  - Kanban columns draw ten tasks and a "view more" (`lib/kanban.ts`
    `capColumn`). The column header and the sub-status breakdown still count
    the WHOLE column, so the number in the header can never disagree with what
    the board is holding back (D-242).
  - A session band draws six agents and a disclosure for the rest
    (`lib/sessionsFlow.ts` `visibleAgents`), and a band that has more is
    allowed to grow taller than one that does not, so a wave of twelve
    subagents is one readable node instead of a clipped list.
  - A Flow wave wider than six tasks wraps into sub-columns instead of drawing
    one unbounded vertical stripe (`lib/flowLayout.ts` `wrapWaveColumn`),
    finished work folds behind a per-wave disclosure with the wave header still
    counting the whole wave, tasks are ordered by where their predecessors sit
    in the column to the left, and the node thins out at low zoom without the
    box ever changing size — the geometry the overlap check asserts holds at
    every tier. The page also gained the Toolbar every other scoped page has:
    it names the project, epic and plan version it is drawing, which the
    project switcher in the topbar had been setting silently, and an edge-type
    legend that doubles as a filter.

- **`smith event lineage` says who continued you** (D-266). The verb now
  prints `continued_by` beside `lineage`, and `lineage` is the full scope a
  lineage-wide fold reads — `[...ancestry, ...continued_by]` — so the display
  verb and the deciding verbs draw the same picture. `depth` stays the length
  of the ancestry alone: it has always meant "how many windows back does this
  go", and a fan-out is width, not depth. `sessionTree()` is the underlying
  read for callers that need the two halves apart, and
  `events.unreadable-session-log` is the new code for a log whose first line
  cannot be parsed — the one case where lineage refuses to answer rather than
  answering short.

- **A guard that the documented error codes are the raised ones** (D-265).
  `docErrorCodes.test.ts` is `docCommands.test.ts` one level down: that file
  holds the documented verbs to the shipped verbs, this one holds the
  documented *failures* to the shipped ones. An error code is a string literal
  in a constructor's first argument, referenced by nothing the compiler checks
  and named by hand in the guide's "Error code | What you actually did" tables
  — so a rename leaves every table reading true and answering wrong, and the
  operator who greps for the code the CLI just printed concludes the failure is
  undocumented rather than renamed. `test/helpers/errorCodeScan.ts` reads the
  vocabulary out of `factory/orchestrator/src` and `ui/server/src` in three
  textual shapes (`new <subclass>('<code>'`, a `super('<code>'` for the one
  subclass that builds its own, a `code:` field for the codes held in
  `lessons.ts`'s table) — 231 codes, 48 namespaces — and reports rather than
  drops any construction whose code it cannot read, so the scan cannot go
  blind in silence. The prose side gates on three things: dotted and
  code-shaped, a first segment something raises, and a last segment that is not
  a file extension, which is what keeps `lessons.ts` and `severity.yml` out of a
  guard whose namespaces are named after the modules that raise them. One
  genuine collision, `task.judges`, is excused by name with its reason and both
  halves of the excuse are checked. The instruction surface both guards read
  moved to `test/helpers/instructionSurface.ts` rather than being copied.

- **Opening a session is a command.** `smith session start <session-id>` writes
  the one `session-start` a log is allowed and prints the event id every write
  command needs as `--causal-parent`; `--continues <event-id>` opens it as the
  continuation of another session (P9-7's cross-session edge). This was the one
  write with no verb: every other command takes an envelope pointing at a prior
  event, and the first event could only be produced by hand-writing its JSON
  through `smith event append` — which the operator guide, `SKILL.md` and the
  agent constraints each spelled out, on one line, quoted for a shell. The
  verb exists rather than a rule inside the writer because `appendEvent` has to
  stay open (D-163): a second `session-start` with a null `causal_parent` into a
  log that already has a root satisfies every check the writer has, is receipted
  as a success, and is then read by nothing — `event lineage` and the timeline
  both take the *first* root. So the second root was not a second beginning; it
  was a line nobody would ever look at, written by someone who had been told
  they were starting fresh. A command whose only job is the root can refuse,
  and does, naming the last event in the log so the caller gets the anchor they
  actually wanted. `event append` keeps writing it and now warns on stderr,
  exit 0, in the same shape as its `on_timeline` and payload-`task_id`
  receipts.

- The factory can now answer **which repos it is answerable for**, and the
  watcher notices when the answer and the flags disagree. `smith projects list`
  reads the `- project:` bullets `smith new` writes into
  `factory/specs/roadmap.md` when it scaffolds a project, and prints this clone
  plus every declared project that has a checkout — ending in the `--project`
  line to paste into `smith daemon run|start` and `smith scheduler run|admit`.
  A repo on that list the daemon was not pointed at raises a new
  `unwatched-project` finding naming the flag that clears it. Repeating
  `--project` made the maintenance pass able to watch many repos; nothing
  turned the register the factory already keeps into that list, so a child
  project left off the line was not reported as missing — it read exactly like
  a repo whose dependencies were all current, which is the silent-omission
  failure one level up. This clone is always first and is never resolved by
  name: the roadmap's project *name* is a directory name, and looking it up
  beside this checkout can find an unrelated repository that happens to match,
  which would have the factory read somebody else's lockfile while reporting
  its own. A project the roadmap declares with no checkout is reported by
  nothing — there is no lockfile to read, so no flag could ever clear it, and
  an alarm that cannot return to zero is the thing the finding severities exist
  to prevent.
- The daemon now says **whose queue** each finding is in. Findings a scheduler
  proposal stands behind — `recheck`, `maintenance`, `growth-review` — carry an
  `admission` (`decision`, `code`, `reason`), and a tick reports `autoAdmitted`
  and `operatorHeld` beside `attention`. `smith scheduler admit` has rendered
  that verdict since Phase 9, per session, for somebody who types it; the
  watcher is the surface that runs unattended and it was the one place the
  answer was missing, so a recheck a `/bs report` wave clears on its own and a
  growth review that is structurally the operator's read as the same grey line.
  It is the same call into `autonomy.ts` against the same two files —
  `scheduler.yml`'s `autonomy:` and `crosscheck.yml`'s
  `plan_quorum.security_keywords` — so the unattended surface cannot drift from
  the one you type. Reporting only: the daemon still dispatches nothing, and an
  `auto` is a statement about policy rather than a thing that happened. A
  finding with no `admission` at all is one no proposal stands behind, or a
  direct `inspectSession`/`inspectFactory` call that passed no policy — absent
  reads as *nobody asked*, never as *anything may run*, because the one
  direction a missing policy must not quietly move a finding is towards `auto`.
  `admission` is deliberately outside the finding identity, so editing
  `scheduler.yml` cannot restart a six-day-old finding's clock.
- The daemon now knows **how long** each finding has been standing. Every
  finding carries `firstSeen` and `isNew`, and a tick reports `newAttention`
  beside `attention`: the number worth waking someone for, as against the
  number worth looking at. Until now the watcher recomputed everything from
  the log each tick and overwrote the last report, so a break thirty seconds
  old and one six days old read identically — the very distinction
  `FindingSeverity` draws one level up, missing at the level an operator
  actually triages on. Two ticks agree a finding is the same one when `kind`,
  `sessionId` and `subject` match; `detail` is excluded because it carries the
  moving parts, and including it would restart the clock on the
  longest-standing problems most often. The memory is one small, disposable
  `state/daemon/findings.json` — missing or corrupt reads as empty rather than
  failing a tick, because a watchdog that dies over its own scratch file is
  silent exactly when something is wrong.

- A `factory-width` daemon finding — the watcher now asks the question the
  repo rests on. `smith epic width` can answer it, but only when somebody
  types it, and a fact nobody is scheduled to look at is a fact the factory
  does not actually hold. Each tick's factory-wide pass now reports when the
  epic this factory closed **last** was admitted wide and dispatched serially
  (`attention`), or when closes exist and not one of them recorded a width at
  all (`info`). Deliberately the newest close and not the fold: closes are
  immutable, so an epic that ran narrow in March is narrow forever, and a
  finding over all of history would raise the same alarm every tick for the
  life of the repo over something nobody can go back and fix. An attention
  count that can never return to zero is worse than no count — it teaches an
  operator to stop reading it, and takes the real alarms with it. The newest
  close is a claim about now, it clears itself when a wide epic closes, and
  the history stays one `smith epic width` away. The narrow rule is
  `summariseEpicWidth`'s own, reused rather than restated, so the two can
  never come to disagree about what narrow means.

- `smith epic width` — the first command in this repo that is not scoped to a
  session. Four commands now bracket parallelism (`wave schedule`, `wave
  check`, `wave audit`, and the width `epic close` writes permanently into
  `epic-closed`), and every one of them answers about the log the operator
  happens to be standing in. The claim the repo actually makes — that a project
  here is built by many agents working a plan's tasks at the same time — is a
  claim about the workshop, and nothing could be asked it. So this folds every
  session in the state dir by default: a close is written wherever the epic
  finished, and a lineage-scoped default would answer the factory question with
  whatever slice of its own history the terminal happened to be inside,
  reporting a workshop of one narrow epic and forty wide ones as narrow.
  `--session` narrows back for anyone who wants the old question. It reads the
  closes rather than re-deriving from the waves, and the second reason is the
  one that matters: re-deriving cannot see a close that measured *nothing* —
  `wave audit` reports the waves that exist and has no way to report an epic
  whose close carried no width at all. Those closes are the honest answer to
  "how much of this do you actually know", so they get their own verdicts
  (`unmeasured`, `unreadable`) beside the wave ones and a hint that says so out
  loud, because "every epic closed narrow" and "no epic was ever measured" are
  opposite states of knowledge and a factory that has never measured itself
  must not read as a healthy one. An epic is graded on the *best* verdict its
  waves reached, not the worst — an epic that ran three waves wide and one
  serially is the factory working, and grading by the narrowest would report
  every real build as a failure — while `serialized` still names the epic and
  still fails the run. Exit codes are `wave audit`'s (1 on admitted-wide-ran-
  narrow, 2 when nothing could be judged), deliberately: a second rule for the
  same failure is a second answer waiting to disagree. `unwaved` and `single`
  are never faults, because a code that fires on every honest serial build is
  routed to /dev/null inside a week, taking the serialized one with it.

- `smith wave schedule` — the plan-time parallelism ceiling. Three commands
  bracketed wave width and all three took the plan as given: `wave check` says
  these tasks may run together, `wave next` says these can start now, and
  `wave audit` says this is what ran. None could answer the question that
  comes first — can this plan run wide *at all*? A plan whose tasks claim
  overlapping globs has a ceiling of one however many agents are free, and
  every gate downstream signs off on it: each wave of one is admitted, each
  runs faithful to its admission, and the epic serializes with nothing
  reporting a problem. The cost is decided at plan time and every check that
  could name it ran too late. So this replays the dispatcher — the same
  `computeNextWave` the real loop calls, its returned wave marked complete,
  again until nothing can start — which is what makes the reported ceiling the
  ceiling the dispatcher will hit rather than a second model of it that can
  drift. The distinction that makes the output actionable is which deferrals
  count: `dependency-pending` is the shape of the work and never a finding, so
  a plan serialized purely by its own declared edges exits `0` with no
  constraints; the other three reasons mean the task was ready that round and
  was held back only by the planner's claim geometry, and only those are
  collected. Exit 2 for width lost to something a re-slice could fix, exit 1
  — which outranks it — for a plan that stalls and cannot be finished as
  written. It deliberately computes no counterfactual depth: saying "re-slice
  these two and it runs in three rounds" would mean inventing the claims the
  planner would have drawn instead, and the dependency graph may bind next.
  Reads and simulates, writes nothing — every round after the first is work
  nobody did, and a log that recorded it would be claiming otherwise.
- `smith wave audit` — the read-back that says whether a wave admitted N wide
  actually *ran* N wide. The factory's central claim is that plan tasks are
  executed by many agents at once, and until now nothing in the repo could
  check it: `wave next` proposes a wave and `wave check` admits one, both
  statements about the future, and `wave-admitted` records the width that was
  *permitted*. A dispatcher that admits three tasks and then runs them one
  after another wrote exactly the same log as one that ran all three together.
  The evidence was already on the log, so this is a fold and not a new table —
  `dispatch_decision` says when an agent went live, its terminal event says
  when it stopped, and `agents-registry.ts` already folds that pair into
  intervals (reusing it rather than reading raw dispatches is what keeps a
  superseded or `epic-closed`-abandoned agent from leaving an interval open
  forever and scoring every later wave as parallel). Peak overlap against
  declared width gives the verdict. A task that ends at the instant the next
  begins counts as a handoff and not as concurrency, because otherwise a
  strictly serial dispatcher would score `parallel` on nothing but the clock's
  granularity — the exact lie the command exists to catch. `serialized` (work
  recorded, never once overlapping) and `unobserved` (a wave admitted with no
  dispatch under it at all) are different facts and get exit `1` and exit `2`
  respectively: scoring "cannot tell" as "ran narrow" would manufacture a
  broken factory out of a `--state-dir` pointed at the wrong place. `partial`
  deliberately does not fail — three admitted and two in flight is the factory
  working, and an exit code that cried about it would be routed to `/dev/null`
  inside a week, taking the `serialized` signal with it. Reads the whole
  lineage rather than one session, for the reason `wave next` and the budget
  check already do (D-119): a wave admitted in session 1 whose agents ran in
  session 2 would otherwise read as `unobserved`, reporting the factory broken
  on nothing but where the operator was standing. Writes nothing.
- `smith judge escalations` — the ledger of cross-provider disagreements the
  operator is still owed. Every quorum already wrote a `quorum-decision` event
  on `escalate`, and nothing read them back: the gate returned its escalation
  on the run's outcome, which is a moment and not a ledger, and it returned one
  to the caller only when an *active* judge took part — so a disagreement
  reached entirely in `mode: shadow` was recorded in the log and reported to
  nobody. This is a fold over the lineage rather than a projection table,
  because every fact it prints was already on the event and a second copy is a
  copy that can disagree with the first, and the lineage rather than one
  session because an escalation raised in one session is answered in the next
  (the same reason `judge outstanding` reads it that way). The three emitters
  write three payload shapes around one core, so they are told apart by the
  boolean each carries alone — `blocks`, `ready`, `sound` — and those mean
  opposite things, so they are normalised into one `held`: an escalation with
  `held: false` is the one to read first, because the quorum could not settle
  the case and the pipeline went ahead regardless. Findings are keyed on
  `fingerprint`, not `finding_id`, so two runs of one gate report one
  disagreement once. `disagreement` is listed case by case; the
  `insufficient-providers` cases are collapsed to a count and a hint, because
  that is one fact about `crosscheck.yml` repeated once per finding and listing
  it would bury the disagreements that are about the code. Exit `2` for that
  case exists so it cannot read as clean: with `min_providers: 2` and one
  active external, every finding escalates ungated, and answering `0` there
  would report the absence of a check as the absence of a problem.
- `scheduler.yml` `autonomy:` and `smith scheduler admit` — a name for what
  the scheduler may run without a person. Until now every proposal waited on
  the operator regardless of what it was, which is safe and does not scale: a
  patch bump and an auth-path recheck cost the same tick of attention.
  `src/autonomy.ts` classifies each proposal `auto` or `operator`, and every
  rule in it can only **deny** — there is no branch that promotes something
  the whitelist did not name, so "what runs without me?" is answerable by
  reading `scheduler.yml` alone. Growth review is denied ahead of the
  whitelist (architecture §12 keeps scope with the operator unconditionally),
  so listing its kind changes nothing. Security keywords are read from
  `crosscheck.yml` rather than copied, so promoting a word moves the
  cross-check trigger and this gate together. Every default fails closed: an
  absent block means off behind an empty whitelist, and a name outside the
  vocabulary throws rather than matching nothing quietly. The command enacts
  nothing — it prints the classification, appends no event and starts no
  agent, which is the same invariant the daemon holds, now held by a command
  a person types too. Rechecks are whitelisted by *reason*, never by
  confidence: a `RecheckProposal`'s confidence is the completed task's, and a
  low one is why the recheck exists, so gating on it would hold back exactly
  the rechecks worth running. `--policy` points the whole command at one file:
  it decides which proposals exist as well as who may say yes to them, so a
  downstream project's scheduler.yml is never half-read.
- `enabled: auto` on an external provider in `crosscheck.yml`, resolved against
  that provider's precondition on the box reading the file: a `cli` provider is
  on if its `command` is runnable, an `api` provider is on if its `api_key_env`
  is set. `enabled` is the one field in that file that describes a *machine*,
  and the file is checked in, so `enabled: true` is a claim about every clone —
  which is how CI, a box with no `codex` binary, correctly started failing
  `smith judge preflight` the day codex was promoted. `auto` lets one commit be
  right on both boxes without either editing the file. It reads installation,
  not authentication: `codex` on `PATH` does not mean `codex login` was run, so
  a box with the binary and no session still spends the call and records the
  failure. A declared `enabled: true` over a missing binary remains an unmet
  precondition — `auto` is an escape hatch, not an amnesty — and `auto` is
  refused on `kind: native`, which has nothing to probe. Preflight now
  distinguishes the two in words: "enabled: auto, and codex is not on PATH
  here" rather than "disabled in the policy", which would name a decision
  nobody made.
- `crosscheck.yml` `quorum_rule.accept_non_gating_actives`, and a `notes` list
  on `smith judge preflight` for the costs it covers. One external judge
  promoted to `active` against `min_providers: 2` cannot gate anything — the
  finder is excluded and one active cannot meet two — so preflight reported it
  as a problem and exited 1. The message already ended "or accept that these
  calls are shadow runs that cost like gating ones", but there was nowhere to
  say *accepted*, so a deliberate configuration failed its own health check
  forever. Declaring it moves that one advisory to `notes`; an unmet
  precondition stays a problem, and `gating.canDecide` still reports `false`,
  because the arithmetic did not change.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  a pull-request template, and this changelog.
- A Quickstart in the README, plus a docs index covering
  `docs/standards/mcp.md` and `docs/runbooks/providers.md`.
- `INSTALL.md` — the install detail lifted out of the README as an executable
  runbook, written so a Claude Code session can work through it end to end
  when the operator says *"install Blacksmith"*. `CLAUDE.md` declares it.
- Three operator guides carved out of the README, so each one can go deeper
  than a landing page should: `docs/guide/operator-loop.md` (the six steps you
  actually perform, plus the S1–S4 severity contract),
  `docs/guide/dashboard.md` (the eleven pages, what each answers, and why the
  screenshots are committed e2e fixtures) and `docs/guide/status.md` (built vs.
  planned per phase, and the four caveats that matter before relying on it).
  `docs/README.md` indexes all three.
- The cross-provider judges documented for an operator rather than an
  implementer, in `docs/runbooks/providers.md`: the four quorum triggers and
  the fact that nothing polls for two of them, the `enabled`/`mode` dials, how
  to read `smith stats providers` before a promotion, why one active provider
  still changes no outcome, and what a judge is shown — a finding's claim,
  never the file contents and never the diff.
- **The repository health pass**, which is mostly infrastructure a contributor
  meets on their first PR:
  - `.editorconfig` and `.gitattributes`, so the file types here agree on line
    endings and whitespace before Biome has an opinion about them.
  - A secret-scanning gate that exists rather than being described:
    `.gitleaks.toml` allowlisting the one synthetic fixture credential by
    *literal* rather than by path, so the rule stays armed over the specs that
    quote it; a `gitleaks dir .` step in `scripts/check.sh`; and a
    checksum-pinned install in CI (`GITLEAKS_VERSION` + `GITLEAKS_SHA256`, both
    literal in the workflow, so a swapped release cannot pass quietly).
    Verified by canary rather than assumed: the AWS key from the vendor docs is
    stoplisted and finds nothing, a random `ghp_` token trips it.
  - Coverage thresholds on all three suites, each scoped to the code the suite
    is about — `factory/orchestrator/src`, `ui/server/src/app.ts`, and
    `ui/src/lib` minus `api.ts` — and run by `scripts/check.sh`, so the floors
    are part of the gate rather than a command someone remembers.
  - `.github/`: three issue-template files (Discussions are off, so the
    template `config.yml` does not link to them), `dependabot.yml`, and
    `CODEOWNERS`.
  - `package.json` metadata a public repo needs (description, keywords,
    homepage, repository, bugs, author, license, `engines`, `bin`) and the
    scripts that were only ever in prose: `check`, `format`, `test:watch`, the
    three coverage variants, and a `prepare` that builds the orchestrator so
    `smith` works from a fresh clone without a separate build step.
- `ui/src/lib/waivable.ts` — the "is this finding waivable" rule, extracted so
  it is unit-tested rather than inlined in a `.vue` file no type-checker reads.
  `TaskDetailPage.vue` now delegates to it; seven tests cover the S1/S2 refusal
  and the S3/S4 cases.
- **Rule D in the P9-37 event-type lint.** The scanner already followed a
  literal *at* `event_type:` (A), a literal handed *to* an `eventType`
  parameter (B), and either of those naming a module-level constant (C).
  Rule D is the mirror of B: a helper handing an event type *back*. Findings
  are credited to the `return` in the defining file, not to the call site,
  because that is where the typo would be. Its body spans are found textually
  and bounded away from nested callbacks' returns, and the suite asserts out
  loud that the rule still fires — P9-22: a rule that finds nothing is
  indistinguishable from one that never ran.
- The scheduler's three proposals — `recheck-proposed`, `maintenance-proposed`,
  `growth-review-due` — now render on the operator timeline with an icon and a
  title naming the task, the outdated packages or the cadence, instead of a
  bare `event_type`. Architecture §12 has the scheduler propose and the
  operator dispose, so the timeline row *is* the offer being made.
- `CONTRIBUTING.md` gained a **What the gate does not cover** section and a
  coverage table; `SECURITY.md` gained the same gap. The one thing the gate
  structurally cannot check is now written where a contributor will meet it.

- **The guardrails moved out of bash and into a tested policy layer.** The
  data half is
  [`factory/policies/guardrails.yml`](factory/policies/guardrails.yml) —
  protected branch names, allowed roots, which commands count as a deploy,
  and the exact wording an agent sees when a rule fires. The deciding half is
  `factory/orchestrator/src/policy.ts`, in TypeScript, with unit tests. Two
  commands host it: `smith policy check --command '<cmd>'` answers what the
  rules would say without running anything (exit 1 on a deny, and the output
  names the rule), and `smith policy hook` is the PreToolUse body itself,
  reading a hook payload on stdin. Six S1 rules apply to every agent session —
  `push-to-protected`, `force-push`, `merge-into-protected`, `deploy-command`,
  `history-rewrite-on-protected`, `unbounded-rm`. Matchers deliberately stay
  out of the YAML: a rule whose matching logic is data is a rule nobody can
  write a test against, and this is the one gate where "we changed it and
  nothing checked" is not an acceptable failure mode. Nothing in the layer is
  shell-specific, which is the larger half of the Windows blocker in
  `INSTALL.md` § Known platform gaps.
- **A judge sandbox, so "judges are read-only" is enforcement rather than a
  sentence in a prompt.** `smith sandbox open <worktree-dir> --role <role>
  --task <id> --session <id>` takes a lease over one directory before the
  orchestrator hands it to one of the six read-only judge roles (grader,
  reviewer, verifier, spec-reviewer, security-reviewer, uiux); `smith sandbox
  close` releases it once the verdict is filed and `smith sandbox status`
  lists what is open. While a lease is open, three further S1 rules apply to
  commands run inside that directory, on top of the six above:
  `judge-network` (no `curl`/`wget`/`gh`/`git fetch`/package installs — a
  judge that cannot verify something records a finding, it does not go and
  fetch what it is missing), `judge-write` (no write except the judge's own
  verdict under `state/results/` or `state/artifacts/` — if the code needs
  changing, that is a finding, not an edit) and `judge-sandbox-escape`
  (`smith sandbox` itself: a lease the leaseholder can lift is not a lease).
  This is possible rather than aspirational because judge roles hold
  `Read, Grep, Glob, Bash` and no `Edit`/`Write`, so `Bash` is a judge's only
  write path and the hook already sits on every `Bash` call. The lease file
  lives under `state/sandboxes/` in the main clone rather than in the worktree
  being judged, and matches by containment, so a `cd` two directories down
  stays inside it while an ordinary coder session in the same repo sees none
  of these rules. `researcher` is deliberately outside: fetching is its job,
  and it fetches through `WebFetch`/`WebSearch` rather than `Bash`.
- **The tester is fenced to test files, so it cannot make a red test green by
  editing the subject.** A test whose author may edit what it covers is a test
  that grades itself, which is the same failure the fresh-context reviewer
  exists to prevent one gate later. `role_write_scopes` in
  [`factory/policies/guardrails.yml`](factory/policies/guardrails.yml) declares
  a role's `write_globs`, and the new S1 `role-write-scope` refuses a write
  outside them — for the tester: test and spec files, the test directories, and
  its own results under `state/`. It also refuses outright the verbs whose
  target a text matcher cannot pin down (`cp`, `mv`, `patch`, `sed -i`,
  editors) and the git subcommands that rewrite tracked content without naming
  a path (`apply`, `cherry-pick`, `reset`, `restore`, `checkout`, `stash`).
  What the tester keeps is deliberate: the network, because a suite installs
  and downloads browsers, and `git add`/`commit`, because its output contract
  *is* a commit on the task branch.
- **The guard hook now sits on `Write`, `Edit`, `MultiEdit` and `NotebookEdit`
  as well as `Bash`.** The judge sandbox could watch `Bash` alone because a
  judge holds no `Edit`/`Write` and a shell was therefore its only write path.
  A tester holds both, so a rule watching only `Bash` is a rule it routes
  around with the tool it was handed. `smith policy check --tool Write --file
  <path>` asks the same question of a file write that `--command` asks of a
  shell line, and the same globs decide both a redirect target and a
  `tool_input.file_path`. A directory is in scope when something inside it
  would be, so `mkdir -p …/test/fixtures` is allowed rather than refused —
  a false deny teaches an agent to route around the gate rather than trust it,
  which is why the refused-verb scan also blanks quoted spans before it runs
  (`git commit -m "test: cover the restore path"` is the tester doing exactly
  what its contract asks, not a `restore`).
- **`sandbox open` refuses a role `guardrails.yml` has no rules for**, rather
  than leasing one it cannot govern. `judge_sandbox.roles` is now declared
  data instead of a list hard-coded in TypeScript, and an unrecognised role
  falls back to the judge rules — the strictest set, because that is the only
  fallback that fails closed.
- **`smith wave check` now refuses a wave that cannot fit**, where it
  previously only checked that the claims were disjoint. It prices the wave
  against what the epic has already spent and refuses admission that would
  cross `epic.cap_tokens`; refuses a wave that would put more tasks in flight
  than `epic.max_in_flight_tasks` allows; and refuses one it cannot price at
  all rather than admitting it optimistically. `--budget-policy <file>` points
  at a different policy, and `--override-rationale <text>` admits a refused
  wave with the machine's verdict recorded beside the human's reason. Every
  admission — not only an overridden one — writes a `budget` block onto the
  `wave-admitted` event, because a log that records only failures cannot
  answer "was this wave ever checked?" for the waves that passed. The same
  reasoning keeps the status `unchecked` distinct from `ok` instead of
  collapsing them: one indistinguishable yes for "checked, and it fits" and
  "never checked" is the exact shape of the guard-hook bug below. A follow-up
  task minted by `findings raise` has claims but no declared budget
  (D-48/P9-31), so it is priced at `task.coder.cap_tokens` as a charge rather
  than waived; a task the *plan* declares with no `budget.tokens` is a
  different silence and is still refused.
- Tests for all three, and a build step that stops mis-reporting what ran.
  `factory/orchestrator/test/policy.test.ts` (71), `test/sandbox.test.ts`
  (19), `test/guardHook.test.ts` (14) and 20 more in `test/waveBudget.test.ts`.
  The hook tests drive the real script the way Claude Code does — payload on
  stdin, decision on stdout — over real leases opened through the built binary
  with no stubbed lease directory, so they fail if the wiring between the
  lease file, the payload's `cwd` and the rules is wrong even where every unit
  test passes. `test/globalSetup.ts` builds `dist/` once for the whole run
  rather than in a per-file `beforeAll`: two test files now exec the built CLI
  and vitest runs files in parallel, and a throwing `beforeAll` reports as
  "2 failed, 182 skipped" — a headline that reads like two broken tests when
  in fact no CLI assertion ran at all.

- **`smith tester check` asserts that a tester graded the code, not the coder.**
  `crosscheck.yml`'s `finder_ne_critic` compares *models*, which is the wrong
  question for a tester: a tester may legitimately run on the coder's model.
  The risk is a shared *turn* — a coder that writes and runs its own tests
  grades itself, and every gate downstream still goes green over it. So the
  policy gained a second block, `role_isolation.pairs` (one entry today:
  `coder` / `tester`), and the command asserts it against the log per
  `testgate-result`: a tester dispatched at or before the gate, after a coder
  dispatch, under a different `agent_id`, having reported before the gate ran.
  Statuses and exit codes match `dispatch check` and `escalation check` —
  `violation` and `unverifiable` both exit 1, because a check that cannot
  answer must not read as a pass.

  Two things make it a separate command rather than another `asymmetric_roles`
  pair. **Absence is the finding here**: in `dispatch check` a critic that
  never ran is `not-applicable` and exits 0, while a test gate that graded
  checks with no tester behind it is precisely the failure being hunted — two
  opposite defaults cannot live in one matcher. And the evidence is a
  *dispatch*, not a model: no role template grants `Agent`, so a
  `dispatch_decision` is written by the orchestrator once per agent it invokes
  and never by an agent about itself, which makes a second dispatch the only
  proof the log can hold that a second turn happened. A missing `agent_id`
  never downgrades a check — it is an optional event field, not part of the
  dispatch payload contract, so "not recorded" is read as not recorded and
  never as "same agent". 27 tests in `test/testerAudit.test.ts`; documented as
  operator-guide §2d.

- **An independent finder, so a quorum can raise a finding and not only drop
  one.** Everything the external tier did until now was subtractive:
  `quorum.ts`'s vocabulary is `confirm | refute`, a critic is handed one claim
  the native reviewer already raised and asked whether it survives, and the
  strongest available outcome is deleting it. That makes the second vendor a
  brake and never an eye — a bug the native reviewer's context did not surface
  is a bug no amount of cross-checking reaches, because nothing outside that
  context is ever asked to look.

  `src/crossFinding.ts` asks. A finder on a different vendor reads the same
  diff in a fresh context, returns evidence against the new
  `finding-evidence.schema.json`, and the two lists are reconciled into four
  outcomes: `corroborated` (same fingerprint — severity may rise per
  `severity_resolution`), `co-located` (same file and category, different
  claim — recorded, never merged), `independent-only` (mintable as a real
  finding) and `native-only` (**no effect, by rule**). That last one is the
  design: silence is not a refutation. The finder was never asked about a
  native claim, it was asked to read a diff, so its not mentioning something
  is absence of evidence — subtracting on it would let a truncated second
  opinion delete real findings. Refutation stays in the critic tier, where a
  judge is handed the claim itself. And an `independent-only` finding is
  minted, not privileged: it enters the gate as an ordinary finding and at
  S1/S2 meets the same `quorum_triggers` critic as any other, so an unshared
  third-party opinion still has to survive a refute pass before it blocks.

  The switch that matters is `send_diff`, and it ships `false`. A critic
  judges a *claim*, so quorum can send a summary and a failure scenario and
  never the source; a finder has nothing to read but the diff. Shipping
  worktree source to a third-party API is not a decision this code has
  standing to make quietly, so `smith crossfind run` **refuses** rather than
  degrading to a diffless "find bugs" prompt that would invent findings about
  code the model never saw — and `max_diff_bytes` refuses rather than
  truncating, for the same reason. `smith crossfind request` prints the exact
  payload without sending it, so the decision is made on the bytes.

  Three verbs: `request` (print, send nothing), `reconcile` (two saved lists,
  offline, no provider and no event — it answers under
  `SMITH_CROSSCHECK_OFFLINE` because it is pure) and `run` (dispatch, then
  reconcile). `run` and `reconcile` exit 1 when the result would change a
  gate, which under `mode: shadow` is never. Each run writes one
  `cross-finding-reconciled` event — outcome counts, providers run, skipped
  and failed, and the ids it would have minted; in shadow mode that event is
  the only thing a run produces, so it also gained a timeline row, because a
  shadow verdict nobody can see is a shadow deployment nobody can evaluate.
  41 tests (29 unit, 8 CLI, 4 UI); documented as providers-runbook §5.

  One of those CLI tests exists because the suite hid the feature from itself:
  `test/setup.ts` sets `SMITH_CROSSCHECK_OFFLINE` for the whole run and the
  CLI subprocess inherits it, so the first `crossfind run` test silently
  exercised the kill switch instead of the verb. The switch now has its own
  test asserting the refusal *names* the skipped provider — the runbook has
  warned since Phase 8 that a skipped provider leaves no trace, and a finder
  that found nothing reads exactly like a finder that never ran.

- **`smith judge preflight`** — the one provider question that can be answered
  without spending a judge call. It came out of running the cross-provider
  check live against the shipped `crosscheck.yml` to confirm the tier is
  actually wired: it is — `gate.ts` raised a trigger unprompted on a blocking
  finding, codex returned a schema-valid `refute` in 7.6s, and the quorum
  correctly declined to gate it (both externals are `mode: shadow`, and the
  native reviewer was `excluded_as_finder`, so the pool was empty and the
  finding kept blocking). What the same run also showed is the gap:
  `deepseek` ships `enabled: true`, so on a machine with no
  `DEEPSEEK_API_KEY` every trigger spawned a call that could not leave the
  box, caught it, and wrote an `ok: false` row. Nothing was unsafe — the
  quorum is fail-closed — but it is one doomed call per blocking finding, and
  the only surfaces that reported it (`judge-verdict` rows, `smith stats
  providers`) are readable *after* the calls are spent.

  The command reads the policy and asks only what is knowable locally: is the
  `api_key_env` variable set, is the `command` on `PATH`, and does the
  arithmetic of the promotions add up — one `mode: active` external against
  `min_providers: 2` is flagged, because with the native finder excluded that
  operator is paying a gating provider's bill for a shadow provider's
  influence. Exit 1 with a `problems` array, 0 when there is nothing to fix.

  Three deliberate non-behaviours. It never makes a judge call — a preflight
  that proved a provider answers by asking it something would cost exactly
  what it saves, so a resolvable `command` is reported as resolvable and
  never as authenticated. It never prints a key, only the variable *name*.
  And it ignores `SMITH_CROSSCHECK_OFFLINE`, which forces every provider off
  at load time and would therefore hide the misconfiguration being looked
  for; the switch is reported as `offlineSwitch` instead. Zero active
  externals is the shipped default and is never flagged. 15 tests (14 unit,
  1 CLI); documented as providers-runbook §1.

- **A spec-vs-goal gate: `smith epic goal` and `smith epic goal-check`.** Every
  gate that existed before this one reads text the planner produced — the plan,
  the diffs the plan asked for, the gate records those diffs earned. So all of
  them go green on a plan that decomposes the *wrong problem*: criteria met,
  tests passing, spec review closed, and the epic ships something nobody asked
  for. The one reference the planner did not write is the `- goal:` line of the
  roadmap milestone that owns the epic, and nothing read it.

  `smith epic goal` prints that goal split into clauses, and writes nothing —
  the split happens here rather than in a judge's head, so two runs of the same
  check answer the same question. `smith epic goal-check` records one verdict
  per clause, in the goal's order. `covered` must name live plan tasks; a
  clause credited to a task the plan does not have is refused
  (`goal-check.unknown-task`), because a clause delivered by a task that does
  not exist is a clause nothing delivers. `uncovered` mints an S2-major
  spec-scoped finding against the plan file, which no task diff can close —
  `smith plan amend` is the only answer. `out-of-scope` is the one verdict that
  makes a clause disappear, so it demands a reason and that reason is printed
  back to the epic judge verbatim. Everything validates before anything is
  written, the way `plan amend` does: a map that raises two findings and then
  names a phantom task on the third clause writes neither finding and no event.

  **The gate fails closed, and the blast radius is the point: an epic whose
  owning milestone states no `- goal:` line no longer closes.** `smith epic
  verdict` holds it, and `smith epic goal-check` refuses to run there
  (`cli.no-epic-goal`) rather than record a check against nothing. There is
  deliberately no `not-required` escape hatch of the kind
  `MCP_SURFACE_NOT_REQUIRED` gives the MCP surface gate — an epic can honestly
  owe no manifest, while "no goal is stated" is the absence of the only text
  this gate can grade against, and treating it as a pass would make the gate
  skippable by deleting a line from `factory/specs/roadmap.md`. The fix is that
  same one-line edit in reverse: give the milestone a goal, or add the epic to
  the `- epics:` list of a milestone that has one.

  A check goes stale two ways, the pair D-125 drew for the closing spec review:
  a plan version older than the live plan, and a goal digest the roadmap no
  longer states. The second is why `epic goal` prints a digest at all —
  rewording a goal invalidates a check exactly the way cutting a new plan
  version does, and without the digest a reworded goal would silently keep a
  green check. `dispatchAudit`'s `CRITIC_WORK_EVENTS` gained
  `goal-check-recorded` at the moment the event was written rather than after
  an incident: a recorded check with no dispatch behind it is `unverifiable`,
  and one dispatch cannot cover both a spec review and a goal check — nor can
  two dispatches fired before either record, since the second one falls
  outside its record's window. 64 tests (57 unit, 7 CLI); documented as
  operator-guide §7e, `/bs run` step 14, and a third dispatch shape in the
  `spec-reviewer` agent contract.

- **A lessons audit, so the corpus can be pruned on evidence rather than on
  taste** — `smith lessons audit <session-id>`. A lessons file only grows: every
  incident adds an entry, nothing ever removes one, and the corpus drifts into a
  set of standing instructions that contradict each other while the escalation
  match quietly stops reaching half of them. `findMatchingLesson` is
  first-match-wins, so corpus *order* is load-bearing, and an entry an earlier
  one provably covers can never fire again no matter how true it is.

  The audit answers that with two independent classes of evidence, and it never
  conflates them. **Structural** death is provable from the corpus text alone:
  `coversEntirely` decides whether an earlier same-category entry's glob
  contains this one's, and if it does the entry is `unreachable` and recommended
  `retire` — no run, no log, no sampling required. **Evidential** death needs the
  event log to prove the entry was actually *loaded*: an entry is `idle` only
  when decisions in its category, on files its glob covers, were recorded by an
  intake whose payload shows the gate was holding it, and went somewhere else.
  That denominator is why `SeverityDecisionRecord` gained `findingCategory` and
  `filePath` — without them a decision cannot be placed against an entry, and
  the audit counts it in `decisionsWithoutContext` rather than guessing.

  It recommends and does not act. `keep`, `review`, `retire`, `rescope`,
  `no-evidence` — and `no-evidence` is never a reason to drop an entry, which is
  the whole point of separating it from `retire`. Contradictions are reported
  rather than resolved: two entries whose statements pass a unigram-Jaccard
  topic threshold while their polarity differs get `review`, because reconciling
  two standing instructions is a human's call. `overlapsWith` is informational
  on purpose — overlap between globs is normal, and only provable containment
  kills. Exit 1 on anything but `clean`, so it can sit in a scheduled job.
  22 unit tests plus gate and CLI coverage.

- **Path claims that see past the file, to the symbols crossing between
  files** — `factory/orchestrator/src/symbols.ts` and `impact.ts`, surfaced as
  `smith claims impact` and folded into `smith wave check`. A path claim answers
  "did two tasks write the same file", and that question has a blind spot with a
  name: task A changes `parse()`'s signature in `src/a.ts`, task B calls
  `parse()` from `src/b.ts`, the two claim lists are disjoint, every gate is
  green, and integration is where the factory finds out. The conflict was never
  in a file — it lived on the edge between two files.

  `symbols.ts` is a scanner, not a compiler front end, and that is a constraint
  rather than a preference: `typescript@7.0.2` is the native rewrite, which
  ships `"main": null` and exports only `./lib/version.cjs` plus two `unstable`
  entry points. There is no `ts.createSourceFile` to call. So the module reads
  imports, exports and re-exports directly, records each export's clause text
  (everything up to the first depth-0 `;` or `{`, whitespace-collapsed) as its
  signature, and resolves specifiers with a `/dist/` → `/src/` fallback because
  this repo's own source imports its build paths.

  Two checks, and the difference between them is the difference between a risk
  and a fact. **`waveImpact` runs before dispatch, over declarations.** All it
  can see is that two tasks in one wave sit on either end of a compile-time
  edge; that is a reason to order them, not evidence anything is wrong, so it
  reports `coupled` and the wave is refused. There is deliberately **no
  override**: `validateWave` already refuses a wave holding both ends of a
  *declared* edge, so any crossing that reaches this check is between two tasks
  the plan declared *no* edge between — precisely the dependency the planner
  missed — and the remedy is to run them in separate waves, which is cheap.
  **`exportImpact` runs after the work, over a diff.** An export removed while a
  file outside the task's claims still imports it is not a risk but a `proven`
  break; a signature that changed is the weaker `possible` claim, because this
  module reads text and not types and says so.

  Holes are reported and never fatal — an unparseable file, an unresolved
  specifier, a claim matching nothing. Failing a wave for the scanner's blind
  spots would teach operators to reach for the override, which costs more than
  the check was ever worth. `wave check` gained `--repo <dir>` to name the
  checkout the graph is read from, and prints its verdict as `symbolImpact`
  beside the claim result. 27 impact tests, 47 scanner tests, 7 CLI tests.

- **A merge queue that pays for the tests the change can actually reach** —
  `factory/orchestrator/src/testSelect.ts`, wired into the queue and surfaced as
  `smith queue run --select-test-cmd '<cmd> {files}'`. The serial queue ran the
  full cumulative suite once per task, so a wave of ten tasks paid for the whole
  suite ten times over changes that were often disjoint. Selection reuses the
  symbol graph `smith claims impact` already builds: it takes the files the task
  actually committed (`git diff --name-only <integration>...HEAD`), walks the
  dependents edge backwards to closure, and keeps whatever in that closure looks
  like a test file. The chosen files are substituted into the operator's own
  template at `{files}` — the module never invents a command, because a test
  runner's invocation is not something a fold over a graph is entitled to guess.

  Every ambiguity resolves to running everything, and each fallback carries a
  reason: an unparseable file in the graph, a changed file the graph does not
  know, a change to a config or lockfile, an empty selection, a template that
  fails to render. A `TestRunReport` — `{ mode: 'selected' | 'full', ran, known,
  reasons }` — rides in the queue's per-task result whenever selection ran, so a
  selective run is never silently indistinguishable from a full one in the log;
  without `--select-test-cmd` the key is absent and the result shape is exactly
  what it was before. Two things it
  deliberately does not do: it never narrows a typecheck, which is whole-program
  by nature and cheap next to a suite; and a template without `{files}` is
  refused before the queue starts (`test-select.no-files-placeholder`) rather
  than quietly running the full suite and reporting it as a selective run.
  Selection happens *after* the rebase, so it sees the files the task will
  actually merge. 19 selection tests, 4 queue tests, plus CLI coverage.

- **`smith daemon` — the folds, without an open session** (Phase 10):
  `factory/orchestrator/src/daemon.ts` and the runbook that operates it,
  [`docs/runbooks/ops.md`](docs/runbooks/ops.md). Until now, *knowing* what the
  factory needed meant keeping a terminal open and re-running `smith budget
  alarm`, `smith scheduler run --dry` and `/bs status` by hand. The daemon runs
  those same folds on an interval — it does not reimplement them, so it and
  those commands cannot disagree — and writes what it found to
  `state/daemon/status.json`. Four verbs: `run` in the foreground (or `--once`),
  `start` detached, `status` (exit 1 when it is not running, so it drops into a
  health check), `stop`.

  A tick reports findings, each one `info` or `attention`: an epic over or near
  its budget cap, spend the log cannot attribute, an agent live past four hours
  with no result, error or supersession, a recheck or a cadence that is due,
  a log it could not read, a SQLite projection that failed. It also refreshes
  the read-model the dashboard serves, so an unattended dashboard stops going
  stale.

  **It watches; it does not drive.** It never dispatches an agent, never enters
  the merge queue, and never writes outside `state/daemon/` and the derived
  SQLite database — architecture §12 says a scheduler run "never dispatches an
  agent itself", and a process that outlives the operator's terminal is the last
  place to relax that. Dispatch stays skill-guided through `/bs run`. Phase 10's
  other half, the Cloudflare port of the dashboard, stays deferred and unspecced
  rather than being quietly counted as done. 30 daemon tests, 6 CLI tests.
  Documented for operators in `docs/guide/operator-guide.md` §4b and §11 and in
  the ops runbook, which carries the launchd, systemd and cron recipes.

- **A dashboard that shows its own pulse, without a toast** — the freshness
  indicator moved out of Overview and into the app shell (`ui/src/App.vue`,
  `composables/usePulse.ts`, `lib/navBadges.ts`), and the shell now polls
  `/api/pulse` every 5s on every page. It carries two clocks, because they
  answer two different questions and neither implies the other: `livenessLabel`
  says whether the *screen* is current, and the new `lastEventLabel` says how
  long ago the *factory* last emitted. On the nine pages that were not Overview,
  a frozen server used to look exactly like a quiet factory — the confusion
  Overview had already fixed for itself. The sidebar gained arrival badges
  (`Timeline 3`, `Errors 1`) counted from the first poll after you last visited
  that page; the collapsed rail draws a dot and puts the number in the
  accessible name instead. Only monotonic counters get one, so a badge can never
  disagree with itself; Lessons badges its pending *level* rather than an
  arrival count. The shell's Refresh reaches every mounted poller through a
  signal in `usePoll`, so it refreshes the page you are on rather than only the
  pulse.

  **Toasts on events, triggers and dispatches were considered and rejected.**
  `useToast` currently means one thing — *your own action landed* — and a toast
  fired from a diff between polls would mean something else while looking
  identical. It would also misreport *when*: the UI polls at 5s and 15s, so the
  toast times the poll, not the event, and a wave would storm the corner of the
  screen with ten of them at once. `usePoll` pauses while the tab is hidden, so
  those toasts would be lossy for something the event log records durably —
  a badge that is still there when you come back is the honest surface. And a
  *dispatch* toast would imply the dashboard drives the factory, which is
  exactly the line the daemon above is not allowed to cross. The reasoning is
  recorded where it will be found again: `lib/navBadges.ts`'s header,
  `ui/docs/design-spec.md` §A.6, and the `ui/docs/DESIGN.md` decision log.
  24 badge tests, plus `lastEventLabel` coverage; three new contrast pairs
  (48 checked, 0 failures). The wiring is asserted where only a browser can
  see it, in the new `ui/e2e/shell.spec.ts`: that the shell polls on a page
  that has no poll of its own, that its Refresh refetches the page you are on
  rather than only the indicator beside it, and that a counter growing while
  you were elsewhere reaches the rail and clears when you read it. A fold that
  is correct and never mounted still leaves you staring at a frozen server.

- **A worker can now argue with the spec, and only an operator can change it**
  — `factory/orchestrator/src/specChange.ts`, four operator verbs (`smith plan
  propose | proposals | approve | reject`), and a request schema at
  `factory/specs/schema/spec-change-request.schema.json`.
  A plan version was immutable and a worker that found the criterion itself
  wrong had two exits: build the wrong thing, or fail against a clause it had
  already disproved. There is now a third. A worker returns a
  `spec_change_request` in its `structured_output` — the criterion, the
  assumption that criterion makes, the evidence against it, the diff it
  proposes in `PlanChanges` shape, every other site with the same shape, and
  whether it is blocking. It rides in a returned field rather than an emitted
  event because **a worker cannot emit an event — only the node that
  dispatched it can** (architecture §15), so a returned field is the only
  signal that survives the worker dying mid-flight. It is the same shape, and
  the same reason, as `research_request`.

  **Immutability is not relaxed; the approval path is added.** A proposal moves
  no plan file. `spec-change-proposed` is data, not a command (D-33): no worker,
  judge or scheduler can approve one, `smith plan approve` is an operator
  command, and approving is what calls the existing `plan amend` with no guard
  loosened. Every version is still cut by `plan amend` alone and still recorded
  as `plan-version-created`. A proposal's diff is validated at *proposal* time
  — drafted onto the next version and run through the plan's own validator — so
  a diff that could never be applied is refused while the worker is still there
  to be told, rather than landing in an operator's queue to be discovered later.
  Twelve refusals carry codes, among them `spec-change.proposal-without-sites`,
  `.proposal-without-argument`, `.rejection-without-rationale` and
  `.approval-stale`.

  Four decisions worth naming. `sites` is asked of the worker and not typed at
  approval, because the worker is the one who just read the code (D-123);
  approval prints `sitesUnclaimed`, the sites the amended plan claims no task
  for, at the moment the operator is best placed to say whether that is a
  deliberate call. A proposal defaults to `S2-major`, deliberately above the
  `S3`/`S4` band `raiseFinding` consults the waiver list for, so a standing
  waiver cannot silence one (D-196). `--rationale` is required to reject and
  optional to approve: approval can fall back to the worker's own argument
  because it agrees with it, while a rejection is the operator saying something
  the log does not already contain. And staleness is computed against the plan
  on disk rather than stamped at proposal time, so a proposal that was open
  this morning is stale this afternoon with nothing written to it — refused at
  approval, where it can still stop you, and never applied blind.

  The event order is load-bearing. An approval is `spec-change-proposed`,
  `plan-version-created`, `finding-transitioned`, `spec-change-decided` — the
  decision written *last*, after the version it authorised exists, so a crash
  between them leaves a proposal still open against a plan that already moved,
  which is the stale case above and not a silent double-apply. A rejection is
  `spec-change-proposed`, `spec-change-decided`, `finding-transitioned`, and no
  version. Taxonomy v7 adds both types to `graph_event`; `smith daemon` reports
  an unanswered proposal as a finding — `attention` when the worker called it
  blocking, `info` when it did not — and the dashboard's timeline reads them in
  the worker's own words behind a new **Plan changes** filter. 25 module tests,
  6 CLI tests, 4 daemon tests, 7 timeline tests. Documented in
  `docs/guide/operator-guide.md` §6b, with every command and every JSON body in
  that section copied from a real run against the built CLI.
- **A contract gate over `.vue` single-file components**, closing the oldest
  gap `SECURITY.md` states. Nothing here type-checked an SFC and nothing could:
  `vue-tsc` needs Volar, Volar needs TypeScript's classic Node compiler API,
  and this repo runs the native port, which exposes none. So the gate asks the
  compiler that actually renders these files what it had to leave for runtime.
  `ui/test/sfc.ts` runs `compileScript` for the binding metadata and
  `compileTemplate` with it, then reads the generated render code:
  `_ctx.<name>` is a template identifier no binding provides,
  `_resolveComponent`/`_resolveDirective` are an unregistered component or
  directive, and an import mentioned by neither the script body nor the render
  code is dead — which restores template-aware what `biome.json` has to turn
  off for `**/*.vue`. A second pass walks every call site and compares what it
  passes against what the called SFC declares, props, events and slots alike.
  Vue's real fallthrough rules are encoded rather than assumed: `aria-*`,
  `data-*` and the HTML globals are legitimate on a component, so are native
  DOM listeners, `v-bind="obj"` makes a call site unknowable and nothing is
  claimed about it, and a component with a bound slot name has no knowable
  slot set. `ui/test/vueContract.test.ts` runs it over all 57 SFCs in
  `ui/src` and carries 22 unit tests besides, because a sweep that has never
  failed is a sweep nobody has proven fires. No new dependency, and no CI
  wiring — it is a test in the ui suite `scripts/check.sh` already runs.
- **The stack is an install-time answer, not a mandate**
  (`factory/policies/stack.yml`). Blacksmith used to ship one operator's
  answers, recorded 2026-08-03 and hand-compiled into `docs/standards/stack.md`
  as prose every scaffolded project was told to obey: Vue 3 + Vite, Workers +
  Hono, SQLite/D1 + Drizzle, and a design system that lives in a private
  repository. A stranger who cloned this repo inherited all of it, including
  the part they could not obtain. Now [`INSTALL.md`](INSTALL.md) Step 5 asks
  the fifteen questions once, the answers land in one commented YAML, and
  `smith new` reads that file rather than a standard. The shipped answers are
  the ones that assume least — `frontend: none`, `backend: none`,
  `design_system: none` — so a fresh clone inherits nobody's taste, and
  `stack.md` now documents what reads each field instead of dictating it.
  - `smith stack show` prints what this clone answered. `smith stack check`
    sorts every field into **honoured** (a shipped template reads it),
    **recorded** (nothing in `factory/scaffold/` reads it, but the agents do)
    and **refused**, and exits non-zero only on `refused` — a check that goes
    red for every operator whose stack is wider than the template tree is a
    check they learn to ignore.
  - An answer the templates cannot build makes `smith new` **refuse before it
    creates anything**, rather than quietly handing over the frontend they do
    ship: answering `frontend: react` and receiving Vue reads as the factory
    ignoring the interview it just ran. Both the scaffoldability check and the
    design-system resolution run ahead of the first `mkdirSync`, so a refusal
    leaves nothing behind to clean up.
  - `design_system` names a kit and `design_system_source` names a directory:
    `smith new --ui` copies that directory into the new project's `design/`
    verbatim and imports its tokens. Vendored, never referenced — a named
    source that is not on disk is a refusal, not a warning. And
    `src/styles/main.css` is generated from the `styling` and `design_system`
    answers rather than copied from a template, because its content follows
    from them.
  - Validation is written against YAML 1.2 as it actually reads: closed
    vocabularies check membership instead of truthiness (`off`, `no` and `yes`
    are all non-empty, all truthy), and free-text fields refuse a non-string
    outright, because an unquoted version arrives as a number.
    `factory/orchestrator/test/stack.test.ts` carries 18 tests over it.
  - `stack show` and `stack check` share one dispatch arm and branch on
    `action` inside it — a shape the help-table drift guard misread, handing
    that inner branch to the last bare namespace above it and so inventing a
    `new show` while losing the real `new`. The extractor in `usage.test.ts`
    now reads pair-form arms as well as bare ones, so only a bare namespace
    can own a nested action.
- **`WAIVABLE_SEVERITIES` is now pinned to the `blocks_merge` column it was
  always a restatement of.** `severity.yml` declares which levels block a
  merge and states the rule in its own `waiver_semantics` ("Only S3/S4
  findings are ever waived"); `waivers.ts` re-typed the answer as a literal,
  so an operator flipping a level's `blocks_merge` would move the merge gate
  and leave the waiver path answering from the old shape — a finding that no
  longer blocks a merge yet cannot be waived either. A drift guard rather
  than a runtime read on purpose: threading a `SeverityPolicy` through every
  `applyBatch` call site would let the merge axis decide the waiver axis by
  fiat, and the two are equal today by coincidence, not by definition. A
  second test asserts the comparison walks every level `severity.yml`
  declares, so a level missing from `SEVERITY_ORDER` cannot be silently
  excluded from the guard that is supposed to read it.
- **`paths.ts` now has to name every file in `factory/policies/`.** Ten of the
  eleven policy files had a constant there; `severity.yml` did not, because
  `severity.ts` spelled `${REPO_ROOT}/factory/policies/severity.yml` itself —
  the only path in the repo assembled by interpolation rather than
  `path.join`, and so the one loader that could not be held to the convention
  `budgets.test.ts`, `crosscheck.test.ts` and `scheduler.test.ts` all keep
  ("the loader's default and the paths.ts constant name one file"). The
  constant moved, `severity.ts` imports it, and that convention test now
  covers it. A new `paths.test.ts` compares the directory listing against the
  constants as sorted arrays — so both a policy file no module can name and
  two constants pointing at one file go red — plus a second test pinning that
  every policy path is built with `path.join`, because the first one keys on
  `path.dirname` and a stray separator would drop a constant out of the
  comparison unnoticed.
- **Two tests for the half of `NativeFindingRecord.file_path`'s claim that
  nothing checked.** The doc comment promises both that a pre-P9-15 record
  with no path is never co-located *and* that it "can still be corroborated —
  the fingerprint is a digest of the path it was raised on". Only the first
  half was pinned, and the two fail in opposite directions: if corroboration
  ever started reading the path column instead of the fingerprint, such a
  record would come back `native-only` beside an `independent-only` mint —
  the factory raising a duplicate of a finding it already holds — with no test
  going red. The second test carries a real path inside its fingerprint and
  still refuses to co-locate, so the first cannot be passing for the
  uninteresting reason that its digest was over an empty path.
- **`smith wave next` — the wave computed instead of guessed.** `wave check`
  answers a closed question, *may these ids run together*, and answers it well.
  But it only ever sees a set someone already picked, and the safest set to
  pick is always a set of one: a single task is disjoint with nothing, shares a
  hotspot with nothing, and crosses no import edge with nothing, so it passes
  every gate in the file. The gate cannot tell a deliberate wave of one from an
  orchestrator that never thought to ask for more, and both come back
  `valid: true`. So a factory whose whole claim is parallel execution had no
  command that computes parallelism — it had one that declines to forbid it.
  `waveLayers` in `graph.ts` already banded a plan by depth and its docblock
  already said the band means "these can run in parallel right now", but
  nothing outside the Flow page's layout ever imported it: the one function
  that knew the answer only ever drew it. `wave next` returns the widest
  admissible set, producers ordered ahead of the consumers that import them,
  and every task it left out with one of four named reasons
  (`dependency-pending`, `claim-overlap`, `serialize-hotspot`,
  `symbol-coupled`) and the ids that held it back — so a short wave arrives
  with its explanation rather than as a number to trust. It writes nothing and
  prices nothing: `wave check` stays the single command that admits a wave and
  the single place `max_in_flight_tasks` is enforced, because a proposer that
  also priced would have to choose which task to drop, and that is an
  operator's call. With `--session` it reads status from the lineage log rather
  than the plan file — a plan read from disk hours into a run still says `todo`
  about work that finished — and picks up the follow-ups `findings raise`
  minted into the log and into no plan file: tasks that exist, are admissible,
  and were being offered to nobody.
- **`/bs run` dispatches the wave, not the task.** The playbook said "one wave
  at a time" and then walked one task through the phases, which is a queue with
  extra steps. It now states the three rules that make the difference: issue
  each phase for every task in the wave as parallel tool calls in a single
  message (five coders in one message is five agents working; five messages of
  one coder is five agents waiting), let each task walk its phases at its own
  pace rather than holding a finished coder at a barrier until its neighbours
  catch up, and let a blocked task block only itself. The one place the wave
  rejoins is the merge queue, which is serial on purpose. It also names the
  rule that makes parallel `smith` writes safe to *use*: read each command's
  `event_id` from its own output, never by adding one to the last, because
  under fan-out the events in between belong to sibling tasks and a guessed
  `--causal-parent` names a real event that is not the parent.
- **`docs/guide/extending.md` gained an "Add a judge provider" section** — the
  page a public operator with a provider this repo has never heard of reaches
  first, and the one extension point it did not cover. It states the shape of
  both transport declarations, the four steps from key to promotion (name the
  env var, `smith judge preflight`, start in `mode: shadow`, calibrate before
  promoting), how to roll one back, and the two transport behaviours worth
  knowing before writing a config: the extractor takes the first *validating*
  JSON rather than the first parseable one, and a provider that fails is
  dropped from the quorum rather than taking the run down, which is what
  `smith stats providers` is for.

### Changed

- **The standing rule against nesting now cites a reason that is still
  true.** `docs/standards/agent-constraints.md` justified flat topology with
  a blocker that P9-7 removed on 2026-08-08: it said `causal_parent` is
  validated only within one session's log and that `EventInput` has no
  parent-session field, and it filed two-tier sessions under "waits on phase
  9". A `session-start` has been able to name a parent in another session's
  log for three weeks. The bullet above it — **No role template is granted
  `Agent`** — pointed at that paragraph for its justification, so a standing
  decision was resting on a reason that had expired, which is worse than an
  undocumented decision: an agent that reads it and checks reaches a
  different conclusion than the repo intends. The constraint itself is
  unchanged and still correct (no template in `.claude/agents/` grants
  `Agent`); what it now says is why it is still true, which is that a
  dispatched agent is not a session and so cannot own the log for what it
  dispatches. `dogfood-envkit-findings.md` D13 gets the `**Status:**` line it
  never had: step 1 fixed by P9-7 and by `smith session start` in the same
  breath, steps 2-3 open, and `.claude/skills/bs/` still holding one
  epic-level playbook and no disposable wave-level one — which is the tier
  split that finding is actually about. `agent-interviews.md` M-5 repeats the
  expired reason but is a dated record of what was decided on 2026-08-05, so
  it takes a dated addendum instead of a rewrite: the answer is unchanged,
  the reason under it is replaced, and the record of having chosen it stays
  intact.
- **The maintenance pass now watches every repo the factory is responsible
  for, and each finding says which one.** ⚠️ **Behaviour change to finding
  identity:** the `maintenance` subject is now `"<repo>: N package(s)"` rather
  than `"N package(s)"`, so every standing maintenance finding reads as new for
  exactly one tick after this lands. `--project` was singular on `smith daemon
  run|start` and `smith scheduler run|admit`, which made the operator choose
  between watching Blacksmith's own dependencies and one child project's — and
  a factory whose entire output is projects that stand on their own cannot
  maintain them one at a time. The flag now repeats (`--project . --project
  workspaces/envkit`), reads one lockfile per occurrence, and raises one
  proposal per repo; a repo that answers nothing costs that repo's reading and
  no other, because "when available" is a property of each lockfile rather than
  of the pass. Naming the repo is not decoration. `findingIdentity` is
  `[kind, sessionId, subject]` and every maintenance finding carries a null
  `sessionId` — it is about a directory, not a session — so the subject is the
  only field left that can tell two repos apart, and two repos one package
  behind used to collide on `"1 package(s)"`: one entry in the tick-to-tick
  memory for two repos, with whichever was written second inheriting the
  other's `firstSeen`. The count stays in front of the repo on purpose
  (`findingAge.ts`): a repo falling further behind is news, and absorbing it
  into a six-day-old timestamp hides the thing that just happened.
  `MaintenanceProposal` gains `projectDir`, resolved to an absolute path so `.`
  and the path it expands to cannot split one repo into two identities (the
  `taskWorktreeDir` precedent, D-42/P9-26); it reaches the append-only log
  through `maintenance-proposed`. `SchedulerRunInput.projectDir` and
  `InspectOptions.projectDir` are replaced by `projectDirs` outright rather
  than kept beside it — one way to say a thing is one thing to keep true.

- **`smith daemon status` no longer calls a wedged watcher healthy.** ⚠️
  **Behaviour change to a documented contract:** the health check
  `smith daemon status >/dev/null` now exits 1 for a daemon that holds its
  lock but has gone quiet, where it previously exited 0. Existing monitoring
  will start alarming on watchers it used to pass — that is the point.
  `running` has always meant *a process holds the lock and answers `kill -0`*,
  which is not the claim *something is watching*: a daemon wedged mid-tick
  answers `kill -0` exactly like a healthy one, so the probe ops.md documents
  passed for a watcher that had published nothing since Tuesday, which is
  precisely the condition a watcher exists to break. The report gains `stale`
  — true when a running daemon has published nothing for
  `max(intervalSeconds × 3, 60s)` — and the exit code is now `running &&
  !stale`. Three intervals is the miss-two-heartbeats rule, and the
  sixty-second floor is there because a tick costs what it costs however often
  it is asked for, so `--interval 1` must not report a daemon as wedged for
  doing exactly what it was told. Staleness is measured against the freshest
  evidence of life, the last tick **or** the lock's `startedAt`, so a daemon
  three seconds old is not stale for having published nothing while one that
  started an hour ago and never published is — the wedge on the first tick,
  which no `status.json` can show precisely because the wedge is what stopped
  the file existing. `stale` is always `false` when nothing is running, since
  `running: false` is the sharper statement and a flag with two readings is
  worse than none. The lock already carried `intervalSeconds`, so nothing
  about the pid file changed. `status.json` also gains `reportAgeSeconds`,
  `null` rather than `0` when nothing has ever ticked — zero is a real age
  and would read as *it just ticked*, the one claim a daemon that has
  published nothing must not be able to make.
- **`/bs status` asks the watcher before it folds the log.** The daemon has
  written `state/daemon/status.json` every tick since Phase 10, and nothing
  outside its own tests had ever read it: `.claude/skills/bs/SKILL.md` did not
  contain the word *daemon*. So the one surface that runs while no session is
  open reported to a console that never asked, and an operator opening
  `/bs status` after a weekend saw a live fold of the log with no way to know
  whether anything had been watching it. The playbook now runs
  `smith daemon status` first and renders `running`, `stale`,
  `reportAgeSeconds` and the last tick's `attention` / `newAttention` /
  `autoAdmitted` / `operatorHeld` before the `smith stats overview` digest —
  the triage split shipped for exactly this screen — with the standing rule
  that a `lastTick` from a stopped or stale daemon is never rendered as though
  it were current.

- **An epic close states how wide the epic actually ran.** The factory's
  central claim is that a plan is built by many agents working its tasks at
  the same time, and three commands interrogate it — `wave schedule` (can this
  plan run wide at all), `wave check` (admit a wave), `wave audit` (did the
  admitted wave run as wide as admitted). Every one of them is a command
  somebody has to remember to type, against a state dir that outlives nothing
  in particular. The close is the one moment no epic skips, and it recorded
  every closure a person decided, every command the assembled branch ran, the
  surface verdict and the goal coverage — and not one word about the claim the
  whole factory rests on. An epic that dispatched four admitted tasks strictly
  one at a time closed `go` on a record indistinguishable from one that ran
  four wide, and afterwards there was nothing left to ask. `EpicSummary` now
  carries a `concurrency` field — waves admitted, the count of each wave
  verdict including its zeros, the widest wave admitted against the most ever
  in flight, and the ids of the waves the log holds no dispatch for — folded
  by `auditWaveConcurrency` off the same lineage events the verdict already
  read, so it costs no second read and no second command. `smith epic verdict`
  prints it, `smith epic close` writes it into the `epic-closed` payload, and
  the judge prompt states it. It is **never a blocker**: width is not
  readiness, a plan whose tasks genuinely depend on one another has nothing to
  run side by side, and a gate that held such an epic would be refusing
  correct work for the shape of its dependency graph — so it has exactly the
  standing `waivedTasks` and `discretionaryFindings` have. The prompt carries
  that caveat explicitly, for the D-120 reason on a new axis: handed the
  number without it, a judge taking its refute mandate seriously would refute
  every narrow epic forever, which makes the verdict a constant rather than a
  measurement. What it names as refutable instead is a wave whose tasks were
  admitted and nothing shows them running. `null` is projected rather than
  dropped, because "nobody measured" must never read as "it ran fine". And
  because it blocks nothing, measuring it may not block either: `wave audit`
  refuses a `wave-admitted` event naming no tasks — right for the command
  whose whole job is that record, and a crash for a gate that only reports it
  — so the reader catches that refusal into a `problem` string and the epic
  closes, the way `resolveMcpSurface` reports an unreadable manifest instead
  of crashing the verdict meant to report it (D-21). When `problem` is set the
  counts beside it are zeros nobody measured, and the judge is told the record
  could not be read rather than handed a confident zero.

- **A new project lands beside this clone, not inside it.** `smith new` wrote
  its output to `workspaces/<name>` — a path inside the factory's own git
  tree, inside its ignore rules and its lint roots, and read as factory code
  by every tool that walks up from a file within it. A project that takes no
  dependency on the factory and carries no mark of it cannot begin life as a
  directory in it. The default is now `<repo-parent>/<name>`, `PROJECTS_DIR`
  in `paths.ts`, one level up from `REPO_ROOT`. Worktrees needed no change and
  got none: `taskWorktreeDir` already places a worktree beside whatever
  directory it is handed rather than at a path of its own choosing (D-42), so
  they follow the project out. `workspaces/` stays legal and stays gitignored
  — `--target-dir` still points anywhere — and the change that mattered was in
  `resolveMcpTarget` (D-133), which assumed a single root: it now searches an
  ordered list, the projects root then `workspaces/`, so a project scaffolded
  before this change is still found where it sits, and a name that exists
  under both roots is the ambiguity refusal it always should have been rather
  than a coin flip. `McpTargetOptions.workspacesDir` became `projectRoots`.
  One consequence is worth stating plainly because it reads backwards at
  first: `destructive_removal.allowed_roots` matches `workspaces`/`state` by
  name at the cwd's git toplevel, and a project outside this clone has
  neither, so recursive-force removal inside it is refused outright. The move
  tightens that surface rather than loosening it, and nothing in the factory
  leans on the allowance — `worktree.ts` retires a worktree with `git worktree
  remove`.

- **A project this factory builds leaves carrying no mark of the factory.**
  The scaffold output advertised its origin in nine template files and in the
  git history it wrote: an `AGENTS.md` that opened by naming the tool that
  scaffolded it and closed by pointing at the source repo's architecture spec,
  a `package.json` description, CI comments that explained themselves in terms
  of the factory's own bug reports, a `$schema` on `mcp.manifest.json`
  resolving to a domain the project does not own, an `mcp/README.md` telling
  the reader to run a factory CLI, and a first commit reading `Initial scaffold
  from Blacksmith (factory/policies/stack.yml)` signed by
  `black-smith <black-smith@localhost>`. None of it was actionable from inside
  the project — a reader who followed any of it left the repo they were in —
  and all of it made the output look like a dependent rather than a
  deliverable. The prose now explains the same decisions on the project's own
  terms, the manifest declares no schema it cannot serve, the first commit
  reads `Initial project scaffold`, and the fallback identity is
  `setup <setup@localhost>`, named for the branch it lands on. The one
  sanctioned exception is a `Built by blacksmith` line at the foot of the
  project's `README.md`, which is new — the scaffold shipped no README at all
  before, so a generated project's front door was whatever GitHub renders for
  a repo that has none. Two tests hold the line, and each is a distinct
  witness: one scans the shipped template tree, which is the only coverage the
  `mcp/` and `ui-tailwind/` layers get, and one scans a generated project,
  which is the only coverage for content that no template contains because
  code writes it — `src/styles/main.css` leaked a factory path that way, and
  the file scan could not have seen it.

- **Judge providers are resolved by transport, not by name.** The architecture
  says the judge tier is "provider-agnostic by contract" — "any model that can
  honor the contract can serve" — and the registry contradicted it. Dispatch
  opened with two name-keyed branches, `codex` and `deepseek`, each forwarding
  to a one-line module that called the same generic transport the file already
  ended with, and each refusing to run if its name was paired with the other
  transport. The forwarding modules added no behaviour; the refusals were the
  real cost, turning two ordinary strings into reserved words with opinions.
  An operator reaching Codex over an OpenAI-compatible endpoint, or running
  DeepSeek's open weights as a local command, wrote a correct `crosscheck.yml`
  and was told it was misconfigured — and an operator whose own provider
  happened to be called either name inherited a vendor's transport by
  coincidence of spelling. Both are configurations someone will write, and
  neither is wrong. The name is now data all the way through: it selects a
  config entry and labels the verdict, and `transport` alone decides what
  runs. `providers/codex.ts` and `providers/deepseek.ts` are deleted, adding a
  provider is a config entry and nothing else, and the two names in the
  shipped file are worked examples rather than reservations. No transport
  behaviour changed.
- **`guardrails.md` now states the removal rule the matcher actually
  enforces.** The contract read "`rm -rf` and equivalents are blocked outside
  `workspaces/` and `state/`", and two things make that untrue. The roots are
  matched by name at the top of whichever repository the command runs in —
  the git toplevel of its working directory, never this clone — so inside a
  task worktree, where a worker spends the whole task, neither root exists and
  every recursive-force `rm` is refused, its own `node_modules` included,
  while a project carrying its own top-level `state/` has the bound applied
  there instead. And "equivalents" claimed a reach the rule has never had: it
  reads the shape of an `rm` invocation as written, so `rimraf`, an
  `fs.rmSync` script, and `git clean` pass it untouched. Both halves were
  reproduced against real git fixtures through the context `smith policy
  hook` builds, rather than read off the source. No matcher, root, or verdict
  changed — the divergence was in the sentence, and `guardrails.yml`'s comment
  above `allowed_roots` carried the same one.
- **A project driven by Blacksmith no longer has to live under
  `workspaces/`.** Nothing in the runtime ever required it: every verb that
  touches a project's git takes the directory itself — `<project-dir>` as a
  positional on the `worktree` family, `--project <dir>` everywhere else —
  `smith new --target-dir` puts a new project wherever it is told, and since
  D-42 a worktree is a sibling of the project directory rather than a child,
  so it follows a clone that sits outside this repo. The instruction surface
  did require it. Seven command lines in the `/bs` playbook wrote
  `workspaces/<project>` where the CLI takes a path, which is the path an
  agent then typed, and `worktree create` was among them. The playbook now
  asks where the project lives once, at the top of a run, and carries that
  one answer through every command below; `AGENTS.md`, the `coder` role and
  the operator guide state `workspaces/` as an instance of the rule rather
  than as the rule. `smith new` still lands there when no `--target-dir` says
  otherwise, and this repo's own `workspaces/` is unchanged.
- **Nothing prescribes a design system any more, and the dashboard stopped
  naming a private one.** This repo's own kit was called HDS, after the
  private design system it was ported from, and the name had leaked into
  places that bind *other people's* projects: the `uiux` agent was told to
  write an "HDS-grounded" spec, `taxonomy.yml`'s finding vocabulary carried a
  `visual-hds` category, `severity.yml`'s S3 row read "visual regression vs
  HDS", and `ui/docs/DESIGN.md` opened by declaring this repository an adopter
  of a design system whose registry lives somewhere nobody outside can clone.
  - `visual-hds` → `visual-design`, named for the uiux spec the render departs
    from rather than for any one kit. `suggestCanonical` derives its
    suggestions from the vocabulary itself, so the rename retargets the
    typo-suggestion for free and the bare-tail rule still resolves `design` to
    exactly one candidate; no recorded event carried the old value.
  - The `uiux` agent looks the answer up instead of assuming it. Which design
    system a project has is a fact in `factory/policies/stack.yml`, a project
    scaffolded with a named kit carries it vendored at `design/`, and
    `design_system: none` is a complete answer — spec against the components
    and tokens the project already ships, and say in the spec that you did.
  - The dashboard's kit moved to the neutral namespace its tokens already
    used: `ui/src/components/hds/` → `components/ds/`, `hds-tokens.css` and
    `hds-components.css` → `ds-*`, and the `hds-` class prefix → `ds-` across
    `ui/src`, `ui/test`, `ui/e2e` and the four design gates. Every token was
    already `--ds-*`, so nothing collided. The port's provenance is now
    recorded once, in `ui/docs/DESIGN.md`, and reads as a footnote about where
    files came from rather than as somewhere to go — nothing under `ui/`
    reaches outside this repository at build or run time.
  - Section A of `docs/specs/black-smith-interview.md`, the stack questions,
    is a pointer to `INSTALL.md` and `stack.yml` instead of a second copy of
    them, because a second copy is a copy that drifts. The dated answers
    already recorded there stay: they are history, not a declaration.
- Demo project fixtures, screenshots and compiled lessons use neutral names
  (`demo-rpg`, `demo-hub`). Provider credentials are environment-only, named
  in `.env.example` and never committed.
- **Both external judges are now `enabled: true` in `mode: shadow`**, where
  Phase 8 shipped them `enabled: false`. Their verdicts are recorded and gate
  nothing until an operator promotes one to `mode: active`. The practical
  difference: with no credentials configured, each quorum case now records a
  caught transport failure instead of making no call at all, which reads as a
  `transportFailureRate` of 1.0 in `smith stats providers`. `README.md`,
  `INSTALL.md`, `docs/guide/operator-guide.md` and `factory/specs/roadmap.md`
  had all kept describing the old default.
- The product's name is written **Blacksmith**, one word, everywhere it is
  prose — 62 occurrences that read "Black Smith", including the dashboard's
  sidebar and `<title>`, so the committed e2e screenshots regenerated.
  Identifiers deliberately keep their hyphenated slug: the
  `docs/specs/black-smith-*.md` filenames, the `black-smith.dev/schema/*`
  `$id` URIs, `ui/src/assets/brand/black-smith.png`, the `package.json` name,
  and the project slug recorded in existing event logs are paths, contracts or
  data rather than prose.
- **The README is now a landing page, not a manual.** It went from 510 lines
  to ~220 by moving whole sections into files of their own rather than
  summarising them twice: the operator loop, the dashboard tour and the phase
  table each became a guide (see **Added**), the install detail was already in
  `INSTALL.md`, the cross-provider detail was already in
  `docs/runbooks/providers.md`, and the safety rules were already in
  `docs/standards/guardrails.md`. What stayed is what a first-time reader
  needs: what it is, why it is shaped this way, how to get it running, one
  screenshot, and a link per topic. The `## First commands` section was
  dropped outright — `smith --help` is generated from the same `COMMANDS`
  table the CLI dispatches on, so a hand-copied command list could only drift
  away from it.
- **The README is now written for a person deciding whether to use this**, not
  for an agent reading it as spec. The previous pass made it short; this one
  makes it a pitch. It opens with the failure it removes — two workers editing
  the same file, one quietly renegotiating the goal, a third reporting itself
  done — then answers it with seven features, each pairing one claim with the
  committed e2e screenshot that shows it (`ui/e2e/__screenshots__/phase-6b/`),
  so every capability line has a picture a reader can check it against. A nav
  row under the badges jumps to Features / Install / Using it / How it works /
  Safety / Status / Docs. Shape borrowed from the two repos the operator
  pointed at, `eneskirca/nodeterm` and `stablyai/orca`.
- **More README content moved out rather than being rewritten**, on the same
  rule as the pass above — a second copy is a copy that drifts. The ASCII
  pipeline diagram is gone because `docs/specs/black-smith-architecture.md` §3
  already draws that loop; the three install caveats are gone because
  `INSTALL.md` already carries them; the `## Cross-provider judges` section is
  gone because `docs/runbooks/providers.md` owns it. Each is now one link.
  `/bs mcp` was restored to the command table, which had listed eight of the
  nine commands `.claude/skills/bs/SKILL.md` defines.
- **Corrected the epic token cap everywhere it is still asserted as fact.**
  `budgets.yml` has declared `epic.cap_tokens: 4000000` since the 2026-08-11
  operator decision, but seven live places still said 2,000,000 and alarmed at
  1.4M: `.claude/agents/planner.md` (a prompt, so the planner was being handed
  a cap half the real one), `.claude/skills/bs/SKILL.md`'s status report,
  `docs/standards/agent-constraints.md`, `docs/guide/operator-guide.md` §9,
  `docs/guide/status.md`, `docs/runbooks/providers.md`, and the README. The
  same sweep replaced "concurrency is uncapped" with what is now true —
  uncapped *by default*, with `epic.max_in_flight_tasks` present and `null`,
  and still not the thing that bounds spend. Worked examples of past dogfood
  runs keep their original numbers: they are records of what the tool printed
  at the time, and editing them would falsify the record rather than fix it.
- `docs/guide/status.md`'s caveat on prompt-level budgets now says which half
  of it is deliberate — the per-task cap reports rather than blocks on
  purpose, because a self-policed cap becomes pressure on the work being
  measured — and which half was simply a gap. That gap closed later in this
  same block: `smith wave check` refuses the wave at admission rather than
  reporting the overrun afterwards (see **Added**), and the caveat was
  rewritten a second time to say so.
- Cross-references that pointed into README sections which no longer exist
  now point at the file that owns the content: `SECURITY.md` → `INSTALL.md`
  § Known platform gaps, `INSTALL.md` → `smith --help` and the operator
  guides, `docs/guide/operator-guide.md` → `docs/guide/operator-loop.md`.
- **Biome now lints `.vue` files**, which it had been configured out of. Three
  rules stay off for `**/*.vue` and say why in `biome.json`: `noUnusedImports`,
  `noUnusedVariables` and `useVueMultiWordComponentNames` all misfire when the
  linter cannot see a template using an import. Twenty-seven components
  reformatted on the first honest run. A warning for anyone editing that file:
  it is parsed as strict JSON, and a `//` comment does not error — it silently
  invalidates the block it sits in, which is how the `overrides` array came to
  be disabled while the lint reported 112 errors and nobody read the config.
- The Kanban filter gained a `scheduler` chip; the kind existed in the data and
  not in the control.

- **`.claude/hooks/guard.sh` is a 119-line transport shim**, where it was 174
  lines of bash implementing all six rules directly. It reads the PreToolUse
  payload from stdin, hands it to `smith policy hook` unchanged, relays that
  command's decision, and inspects neither — a transport shim that cannot
  parse its own output correctly is the failure this rewrite exists to remove,
  and this one never parses anything. Its one remaining judgment call is what
  to do when the policy layer cannot answer at all — a fresh clone with no
  `dist/`, no `node` on `PATH`, a CLI that exits non-zero — and the answer is
  `ask` rather than `deny`. `deny` there is a trap rather than a safety
  property: the first command of `INSTALL.md`'s self-install runbook is
  `pnpm install`, and the remedy for a missing build (`pnpm run build`) is
  itself a `Bash` call the hook has just refused, so the factory would be
  unrepairable from inside. On no path does it emit an `allow` envelope, because
  Claude Code reads a hook's `allow` as "skip the permission system for this
  call" — it outranks the operator's own `permissions.deny` list. Its command
  in `.claude/settings.json` is now quoted, so a project directory containing
  a space still resolves.
- The documents that describe any of this were updated with it, not after it:
  `docs/standards/guardrails.md` gained a **The judge sandbox** section and a
  preamble naming where the rules now live and what `smith policy check`
  answers; `SECURITY.md`'s judge-integrity and guard-hook bullets name both
  halves of the enforcement and put a shim that fails *open* in scope;
  `INSTALL.md` says the Windows blocker is now the shim rather than the rules,
  and that an unbuilt clone escalates every `Bash` call rather than guessing;
  `docs/guide/operator-loop.md` and `.gitattributes` point at the policy layer
  rather than at the bash; and `docs/specs/agent-interviews.md` N-10 — the
  interview question that observed "judges are read-only" was a sentence and
  not a rule — carries its answer.
- **The novelty gate now corrects its threshold for how long the two
  statements are** (P9-35 (a)). A statement of *n* words has *n-s+1* shingles
  and swapping one interior word destroys *s* of them, so nothing shorter than
  twenty-nine words could score 0.8 against its own near-copy — the gate built
  to stop lessons accumulating in slightly different words was, at its
  shipped defaults, an exact-duplicate detector. Each pair is now judged at
  `(n-2s+1)/(n+1)` for the **shorter** of the two statements, which is the
  worst of the three one-word edits and therefore the bar that catches all of
  them. Measured over the real 25-statement corpus: one word substituted 16/25
  → **25/25**, inserted 19/25 → **25/25**, deleted 19/25 → **25/25**, with no
  genuine pair newly judged redundant (highest real similarity 0.0238 against
  a lowest corrected bar of 0.400). Two-word rewrites stay 0/25 — the
  correction is calibrated to exactly one edit and says so rather than
  implying more. It never *raises* an operator's threshold, and below
  `2*shingle_size+1` words it stands aside entirely, because there a near-copy
  and two unrelated statements sharing one three-word run score identically
  and `novelty-rejected` is a terminal status. The knob is
  `lessons.novelty_length_aware` in `factory/policies/scheduler.yml`,
  validated as a real boolean because YAML 1.2 reads `off` as a truthy string
  — an operator switching the correction off would have switched it on. The
  bar a verdict was taken at now travels with the match, so a rejected
  candidate is no longer reported as "scores 0.65, threshold 0.8" in the CLI
  error, the approval-time `novelty` block, or the dashboard's notice.

### Fixed

- **YAGNI was enforced by a lens the reviewer was never given (D-267).**
  `docs/standards/agent-constraints.md` and `factory/policies/severity.yml`
  both named "the reviewer's `over-engineering` lens" as the thing enforcing
  the coder's YAGNI constraint. `.claude/agents/reviewer.md` — the only file a
  dispatched reviewer actually reads — carried a behavioral-drift lens and no
  over-engineering lens at all; the category survived as one string in a
  vocabulary list. Worse, the output contract made it unraisable anyway:
  `failure_scenario` requires `{inputs, expected, actual}` as "the wrong
  output or crash it produces", and over-engineered code returns the right
  answer, so the reviewer was instructed to drop the category itself. The
  same-mistake rule that escalates it S3 → S2 then handed it to a verifier
  that refutes by default anything without a wrong output. The lens now
  exists, with a closed tag vocabulary (`delete:`, `stdlib:`, `native:`,
  `yagni:`, `shrink:`) that each demand a **named replacement** — the
  "proposed simplification" the severity policy already promised, made
  checkable. Its failure scenario is read as a change rather than a crash
  (criterion + replacement → the shape asked for vs the shape shipped), with
  no schema widened, and the verifier is given the grounds that refute one: a
  second real call site, a test the replacement breaks, or a spec line
  requiring the abstraction. `.claude/agents/coder.md` gains the ladder the
  `stdlib:`/`native:` tags read against, so they flag a rung skipped rather
  than a rule never given. `test/docLenses.test.ts` now parses every lens a
  document attributes to a role — out of the markdown instruction surface and
  `factory/policies/*.yml` alike — and fails when the role's template does not
  carry it.

- **A lineage that only walked upward could not see the wave it dispatched
  (D-266).** P9-7 shipped lineage for a chain — a session that runs out of
  window and continues in a fresh one — and read from the new session the
  upward walk finds the whole epic. A parallel round is the same one event
  used sideways: an epic session dispatches wave sessions, each opened with
  `--continues <epic>#<idx>`. But the reads that decide anything about a round
  stand at the *parent* end — `epic close`, `wave audit`, `findings list`,
  `stats overview`, `dispatch check` — and from there the walk answered with a
  lineage of one. A wave raised a finding, the epic session listed findings
  and printed none, the epic closed clean. Which is D-119's failure mode
  reached from the other direction: a gate reading a narrower scope than the
  thing it guards is off for everything outside that scope, and nothing in its
  output says so. Lineage is now a tree: ancestors, self, then everything that
  continues self, breadth-first with ids sorted at each level. Downward from
  the session asked about and not from the root, so a wave folds in its own
  continuations and never its siblings — two waves running at once are two
  scopes, and a gate that could read its sibling's events would be gating on
  work it does not own. Finding the continuations asks every log in the state
  directory what it continues, the read `daemon.ts`'s `runTick` already pays
  for, paid down to an ~8KB probe of each log's first line with a full read as
  the fallback when the probe cannot answer — including when the first line is
  not the root, because `appendEvent` deliberately lets the root sit anywhere
  and the upward walk finds it with `.find()`. A log whose first line is not
  JSON throws `events.unreadable-session-log` rather than being skipped:
  dropping a child quietly would reintroduce exactly the blindness this
  closes. `projectedLineage` moved in the same step or the dashboard and the
  CLI would scope an epic differently again — the split D-264 exists to close.
  One deliberate change for readers that were already correct: a chain read
  from its *oldest* end now answers with the whole chain instead of with
  itself, which is what D-263 was already arguing for.

- **The dashboard drew the window, the CLI drew the epic (D-264).** D-263
  taught every projected read to take a lineage and gave `smith stats` the
  `--lineage` to ask for one, and said in the same breath what it had not
  done: the UI's HTTP surface still took a single `?session`. So the two ways
  of reading one projection disagreed — the CLI could see a whole epic, an API
  caller standing in a continuation session got the window and no sign that
  anything was missing. All ten read routes now build their session scope
  through one `sessionScope()` helper, the same shape as `scopedToSessions` a
  layer down and for the same reason: a route added later cannot opt out of
  the widening by forgetting a call. `?lineage=true` resolves the chain with
  the very `projectedLineage()` the CLI calls, off `events_raw`, so both
  surfaces draw the same scope from the same rows. `?lineage` without a
  `?session` is refused with 400 rather than read as every session at once —
  D-263's failure in the other direction — and a `lineage` that is neither
  `true` nor `false` is refused rather than ignored, because ignoring a
  widening flag hands back exactly the narrow answer the caller spelled it to
  avoid. The Vue client is deliberately unchanged: it scopes by project and
  never sends a session, so the parameter waits for a session picker rather
  than the picker waiting for it.

- **Half an epic, reported as a whole one (D-263).** P9-7 made an epic able to
  outlast the session that opened it — `causal_parent` may name another
  session's log when the event is the `session-start` — D-261 gave that edge a
  verb, and `SKILL.md` then recommended taking it whenever a context window
  runs out mid-epic. Every read in `db/queries.ts` still narrowed on a single
  session id with exact equality, so the continuation session asking about its
  own epic was answered with the part of it that fell inside that window, and
  told nothing about the rest. Not an error and not an empty page: a shorter
  kanban, a thinner timeline, an analytics number computed over a fraction of
  the runs — all of it looking exactly like a correct answer to a different
  question. `Scope` now takes `sessionIds` beside `sessionId`, one helper
  `scopedToSessions` is the single place equality widens to `inArray` so no
  later reader can opt out by forgetting one call site, and `projectedLineage`
  resolves the chain off `events_raw` rather than the log directory, because
  `smith stats` opens nothing but a database and the UI server has no
  filesystem to read. `smith stats <page> --session <id> --lineage` is the
  operator-facing half, on all nine pages at once; it walks ancestors only,
  exactly as `smith event lineage` does, stops at the first ancestor the
  projection has not folded so a partial `db rebuild` narrows the answer
  instead of failing it, and refuses to run without a `--session` rather than
  quietly reporting every session as one lineage.
- **A wave that ran two wide closed `serialized` on a slow enough runner
  (D-262).** The gate failed on `main` (run 33654242531) and again on a branch
  that had not touched any of this, both times on the same assertion in
  `epic.test.ts`, and passed every time locally. `appendEvent` stamps `ts` off
  the wall clock, and that fixture writes a whole epic — an admission, two
  dispatches, two terminals, three checks and the close — inside a single
  millisecond, while the width verdict is interval arithmetic over those
  stamps. So the assertion was settled by which side of a millisecond boundary
  each append happened to fall on: let the clock tick between the two
  dispatches and then let task-1's terminal share the millisecond task-2's
  dispatch landed in, and the two runs meet exactly end-to-start — which
  `peakOverlap` reads as a handoff rather than an overlap. That rule is
  deliberate and `waveConcurrency.test.ts` pins it, so nothing in
  `waveConcurrency.ts` changed. The fixture now fakes `Date` and steps it by a
  minute between dispatch and terminal, the way `db/milestones.test.ts`
  already does for the same reason. At the granularity a real run writes at
  the defect was never reachable — it was the test's clock throughout, which
  is why it read as an unrelated red gate on somebody else's pull request.
- **A daemon on a fresh clone left the dashboard empty.** `milestones` is the
  one projected table that is not folded out of the event log — it is a full
  replacement of `factory/specs/roadmap.md`, and `projector.ts` calls it "not
  session-scoped" in as many words. But the only thing a running daemon ever
  called to refresh it was `apply()`, once per session, inside the tick's loop
  over lineages. A clone with nothing in `state/events/` therefore got no
  read-model at all: not an empty Roadmap view, an unopened SQLite file. An
  operator could write a roadmap, start the watcher, open the dashboard, and
  find the Roadmap view and the project switcher blank until they happened to
  run `smith db rebuild` by hand — and the daemon never would, which is the
  wrong way round for the one process whose whole justification is that nobody
  is watching. A tick that folds no session now rebuilds instead, which on an
  empty log clears nothing and projects the roadmap; it stops being reachable
  the moment one session exists. `projected` still counts sessions folded and
  so still reads `0`, and a rebuild that throws raises the same clearable
  `projection-failed` finding as the per-session path, carrying `sessionId:
  null` because there is no session to blame. Found the same way as the entry
  below, one layer down: `smith stats roadmap` against this clone answered
  `[]` while `roadmap.md` declared 14 milestones across 2 projects.
- **A factory that had built nothing tended nothing.** The daemon's
  factory-wide pass — maintenance, `unwatched-project`, `growth-review`,
  `factory-width` — was skipped entirely on a tick that found no session in
  the event log. The gate was written for one of those four: a cadence
  reminder about work that has never started is noise, so a clone nobody has
  run a task in should not be told a growth review is due. But it took the
  other three with it, and two of them read the disk rather than the log.
  `pnpm outdated` answers on the registry's clock and a repo goes unwatched the
  moment it is scaffolded, so the window where the gate bit was exactly the
  window it must not: a fresh install, and a child project an hour old — where
  a missing `--project` flag and a stale lockfile are most likely and least
  likely to have been noticed. Pointing the shipped daemon at this clone found
  it: an empty `state/events/` produced a tick with zero findings and no
  reading of any lockfile. The cadence gate now sits on the growth-review
  branch alone, where it is a statement about elapsed history rather than a
  statement about the whole pass, and an idle daemon on an idle clone still
  reports an empty tick.
- **The parallel gate that could only ever admit one task.** `wave check`
  refuses a wave whose tasks share a `serialize_always_globs` hotspot, and it
  decided that by asking whether two globs *could* both match some hypothetical
  path. Under that reading `src/auth/**` shares a hotspot with
  `**/pnpm-lock.yaml`, because the checker cannot prove no file under that
  subtree will ever be named `pnpm-lock.yaml` — and subtree claims are the
  normal way to scope a task. So every realistic pair collided on a lockfile
  neither one touches, no wave wider than one was ever admissible, and the
  failure was invisible in the worst way: the gate returned `valid: true` for
  each singleton it was then handed. The check now asks whether a claim could
  actually name a protected file — one glob has to contain the other's concrete
  path. `src/auth/**` no longer collides; `packages/**/pnpm-lock.yaml` still
  does, and so does `**`, since a claim on everything is a claim on the
  lockfile too. The operator guide's advice to narrow claims to file extensions
  to avoid "spurious flags" was a workaround for this bug and is gone with it.
- **Five processes, five appends, one event id.** Event ids are derived on read
  from line position, so the log file itself was never at risk — but
  `appendEvent` returned an index it read *before* appending, and the promise
  chain that serialized appends was per-process by construction, its own
  docblock scoping it to "the single-process model this runtime is". Fanning
  out a wave ends that model: five tasks recorded in five `smith` invocations
  are five processes, five queues and five readers of the same line count.
  Reproduced before fixing — five concurrent appends returned `race-1#1` five
  times. What that costs is worse than a duplicate id. The caller feeds the
  returned id to the next command as `--causal-parent`, so the wrong parent
  names an event that genuinely exists, `validateCausalParent` accepts it, and
  the lineage is quietly mis-shaped; a wrong parent that validates is worse
  than one that fails. The read-validate-append sequence now happens inside a
  lock file beside the log (`open(..., 'wx')`, atomic on every filesystem this
  runs on), which is what makes the returned index true: it counts the lines
  another process wrote before us, because it is taken after that process let
  go. The in-process queue is kept as the fast path, so two appends in one
  process never touch the filesystem at all. Verified with eight concurrent
  `smith` processes: eight distinct ids, nine lines, no lock left behind. The
  lock is named `<session>.jsonl.lock`, which `listSessionIds` cannot see — it
  selects on `.jsonl` as the suffix, and this is not one.
- **A millisecond is not a side.** The escalation-ladder audit
  (`factory/orchestrator/src/escalation.ts`) asks one question five times —
  *which side of this failed round is that event on* — and answered it with a
  bare `<` or `>` on `ts`. But `appendEvent` stamps `new Date().toISOString()`,
  so two writes in one millisecond share a timestamp, and the two events this
  audit reasons about are exactly the pair written back to back: a
  `gate-outcome` and the `dispatch_decision` that answers it. On a tie the
  comparison is not a decision, it is whichever side the operator happens to be
  told about. Reproduced, the same one-line cause gave five different wrong
  answers. A correct `mid -> frontier` escalation was reported
  `not-applicable`, *"the rung was never exercised"* — the retry, tied with the
  round, was dropped by the after-search and picked up by the before-search as
  the round's own failing dispatch, so the rung read *"neither dispatched again
  nor reached the gate again"*. That is the D-249 inversion arriving by a
  second road, and `not-applicable` counts as OK: a ladder **retried on the
  same tier** was reported `not-applicable` too, and the whole report came back
  `ok: true`, so `smith audit escalation` exits 0 on a violated ladder. Rung 3
  was worse in the same direction — a task dispatched again in the third failed
  round's own millisecond, with no operator answer anywhere in the log, was
  reported `ok`, *"the bound held"*: a clean bill of health issued over a
  livelock. The errors run both ways. An operator answer sharing a millisecond
  with the retry it released fell outside a strict `ts` interval and was
  reported as a `violation` against an honest run, and a rung whose retry tied
  with its round could report `unverifiable`, *"no builder dispatch is recorded
  for that round"*, with the dispatch sitting in the log. All five sites now
  route through `compareLogOrder`, which falls through to the numeric log index
  — the line the log actually wrote. The comparator moved from
  `factory/orchestrator/src/db/queries.ts` up to
  `factory/orchestrator/src/events.ts`, beside `parseEventId`, so its promise
  from the entry below — that no two readers can answer the same question about
  the same two events differently — holds across the audits as well as the
  dashboard. Seven rows carry the behaviour, five of them tied to a site by
  breaking it: reverting any of the four dispatch/tiebreak/interval sites, or
  reducing the comparator's index tiebreak to a string compare, reddens exactly
  its own rows. The fifth site, the gate-round search, is changed by the same
  rule with **no row of its own** — the tie it breaks is two gate outcomes for
  one task inside one millisecond, which the gate cannot produce.
- **A clock is not a sequence.** The entry below gave two readers a rule for a
  tied `ts`: go to the log — session id, then the *numeric* index behind the
  `<session-id>#<index>` event id. Six more orderings in
  `factory/orchestrator/src/db/queries.ts` never got it, and each was its own
  way of not answering. **Four asked SQL**: `ORDER BY ts` in the live-agent
  fold, the timeline and a task's attempt list, and `ORDER BY ts, event_id` in
  the budget-at read. SQLite promises nothing about tied rows — it hands them
  back in whatever order the scan produced, which moves the moment a row is
  rewritten or the planner picks a different index — and appending `event_id`
  to the sort compares the log index as *text*, so `#9` lands after `#12` and
  the tiebreak inverts as soon as a session's log passes ten events. **Two
  asked JavaScript and got the same non-answer back.** `overview()`'s recent
  dispatches sorted newest-first on `ts` alone, and `Array.prototype.sort` is
  stable: a wave admitting twelve dispatches inside one millisecond compares 0
  across all of them, keeps the ascending order the rows arrived in, and the
  ten sliced off the front are the *oldest* ten of the burst — under a heading
  that says recent, with the two newest dispatches in the factory the two the
  operator cannot see. `kanban()` picked *the most recent dispatch for this
  task* with a strict `>`, which on a tie keeps whichever row the store handed
  over first, so a chip could name a role the task had already left. The
  live-agent fold is the one where scan order was not even a coin toss: that
  query rides `events_raw_type_idx`, which walks the `IN` list in alphabetical
  order of type name, so `dispatch_decision` reached the fold ahead of every
  terminal — `epic-closed` among them — whatever the log said. An agent
  dispatched *after* its epic closed was swept closed by it, and the historical
  half of the five-minute subtraction disagreed with the `agents` table the
  projector had folded from the same log, so the card announced an arrival that
  never happened. All six now route through the one comparator, so no two
  readings of the same two events can disagree. Six rows carry the behaviour,
  each checked by breaking the fix it guards: a mutation that restores any
  single site reddens exactly its own row.
- **A tie is not a coin toss.** Event timestamps are ISO strings stamped to the
  millisecond, and events appended in a burst routinely share one — in this
  repo's own fixture the last two events tie in roughly three builds out of
  eight, which is what made the `pulse()` row of the query suite flaky on
  `main`. Nothing downstream had an answer for a tie: `events_raw` carries no
  sequence column, and both readers `.all()` with no `ORDER BY`, so *the newest
  event* was really *whichever tied row the scan happened to reach in the order
  that suited the comparison*. The two callers spelled that comparison
  differently — `pulse()` kept the first row it saw on a tie (`>`),
  `runningSessions()` kept the last (`>=`) — which is **two opposite answers to
  the same question about the same two events**, one feeding the dashboard
  shell's five-second poll and the other the session list on the page under it.
  A tie now goes to the log instead of to the scan, through one predicate both
  callers share: an event id is `<session-id>#<index>` and that index *is* the
  event's place in its session's log, so the tie is broken on session id, then
  index. Across two sessions the session id settles nothing meaningful — they
  are separate files and nothing interleaves them — it is there so the answer
  is the same on every call rather than a re-roll of whatever order the rows
  arrived in. An id that will not parse cannot come from the projector, which
  copies `event_id` straight from `readEvents()`; it means a corrupt row, and it
  sorts low rather than throwing, because `/api/pulse` is polled on every page
  every five seconds and a bad row should cost the operator a wrong tie-break at
  worst, never the shell. Four rows carry the behaviour, each checked by
  breaking the fix it guards and watching it go red.
- **An intensifier is not an opposition.** `polarityDiffers` — the predicate
  that decides whether two lessons say opposite things — sorted marker words
  into polarities and reported a difference whenever the two sets differed.
  `always` sat in a polarity of its own, so **"Always retry the request on a
  network timeout" against a bare "Retry the request on a network timeout" was
  read as a contradiction**: one instruction said with more force, scored as
  its own reversal. The cost is not cosmetic. A contradiction sets
  `recommendationFor` to `review` overriding every other reading of the entry,
  and a single one makes the whole audit report `defective` — so a corpus could
  be declared structurally broken over an adverb. The predicate now asks one
  question of each statement — does it prohibit what it is about (`never`,
  `not`, `don't`, `do not`, `no longer`, `must not`) — and calls the pair an
  opposition only when exactly one of the two does. Dropping the `always`
  marker costs nothing on the case it was there for: `always X` against
  `never X` is still an opposition, because exactly one of them prohibits.
  Both consumers move together — the novelty gate's `polarityConflict`, which
  lets a genuine reversal through as novel instead of swallowing it as a
  duplicate, and `auditLessons`' all-pairs contradiction scan, where the same
  pair had been reported at 62% topic similarity.
- **Four refusals that read a spelling instead of a shape.** Every guardrail
  in this file errs toward denying, and that is the right direction — but a
  denial of something harmless is still a defect, and four of them had
  accumulated where a matcher learned one way to write a thing and treated the
  rest as unfamiliar. **`git commit -am "…"`** was denied for the words in its
  own message: the message exemption required whitespace before `-m`, so every
  clustered short flag missed it, as did git's attached `-mx`. The flag is now
  matched however git accepts it, with the `m` required to end the cluster —
  git's own rule, since `-am` takes the next argument and `-ma` takes `a`.
  **`git stash push` was read as a push to a protected branch**, because the
  word is right there and rule 1's subcommand match is deliberately loose. A
  stash reaches no remote. The pair `stash push` is now excluded, matched as
  that adjacency and nothing wider, per segment — so `git push origin stash`
  is still a push and so is the second half of `git stash push && git push`.
  This one had a tell worth recording: `git stash push -m "wip"` was *allowed*,
  because blanking the message appended `""` and pushed the segment's end out
  of reach of the bare-push heuristic. Whether the stash was refused turned on
  whether it carried a message, which is the kind of coincidence that says a
  rule is keying on the wrong thing. **An escaped quote ended a message
  early** — `"[^"]*"` stopped at the `\"` in `-m "he said \" and then …"`,
  leaving the tail to be scanned as if it were a command. The double-quoted
  form now counts `\"` as content, the way a shell does; the single-quoted
  form is left exact, because inside those a backslash really is just a
  backslash. **`smith policy check --command "<(...)"` was refused**, which
  closes the asymmetry the entry below left open: that span accepted
  single-quoted payloads only, and the single quote was standing in for the
  question actually being asked — does the shell run this before the binary
  sees it? Both blanked spans now ask `shellExpandsPayload` directly, so
  `--command "$(...)"` is still read as the command it really is while
  `--command "<(...)"` is answered instead of refused, on the one command whose
  entire job is answering without running. Unquoted payloads stay refused on
  purpose. Each widening carries a deny-direction test that was checked by
  breaking the fix it guards and watching it go red.
- **A message payload the shell *runs* is not prose — and process
  substitution is a third way to run one.** Blanking a `-m` payload before the
  rules scan it rests on one claim: the shell hands that text to git as it
  stands, so nothing in it executes. `shellExpandsPayload` checked the claim
  by looking for `$( )` and backticks, and stopped there. Process substitution
  runs a command just as eagerly — `git commit -m <(wrangler deploy)` forks
  the deploy, hands git the path `/dev/fd/63`, and the deploy has already
  happened by the time git has a message to read — so the scanner blanked a
  live command as free text and rule 4 saw nothing. All five subcommands whose
  `-m` is prose (`commit`, `merge`, `tag`, `stash`, `notes`), and `--message=`
  alongside `-m`; an `rm -rf` written the same way went past rule 6 too.
  **Three** openers, not two: the agent's shell here is zsh, which has bash's
  `<( )` and `>( )` plus one of its own — `=(cmd)` runs cmd, writes its output
  to a temp file and substitutes that path — so the spelling likeliest to be
  reached on this machine is the one a bash-only reading of the problem
  misses. Only rules 4 and 6 were actually defeated. Rules 1, 2, 3 and 5 came
  through the identical payload intact, but for an unremarkable reason rather
  than a property they hold: the blanking eats one whitespace-delimited token,
  what it removed was `<(wrangler` — the binary — and ` deploy)` stayed
  behind, so whether a rule survived turned on whether the token it keys on
  was the one eaten. `shellExpandsPayload` now asks the question in two parts,
  because quoting answers them along different lines: a command substitution
  still happens inside double quotes and a process substitution does not, so
  `-m "$(...)"` is still read as the command it is while `-m "<(...)"` is left
  as the prose it looks like, and single quotes go on silencing both. The
  other blanked span — the `--command` payload of `smith policy check` — never
  had the hole, because its regex accepts single-quoted payloads only. It is
  unchanged, and the asymmetry that leaves is recorded in the PR: a
  double-quoted `--command "<(...)"` is refused although nothing in it would
  run, which is an over-refusal on a dry-run command and so errs the safe way.
- **A redirection ends a command's arguments, not the command — and rule 3's
  exception read it as the end of everything.** `splitChainSegments` cuts a
  command at `<` and `>` as well as at `;&|`, and for every rule that
  *denies* that is the safe direction: a rule shown less of a command refuses
  more of it. The catch-up exception is the one rule that *allows*, and there
  the same cut is a hole. It judged `git pull --ff-only origin main
  >/dev/null --no-ff` on the text up to the `>` — which is exactly the
  catch-up it exists to permit — while the command git actually ran carried
  `--no-ff` and wrote the merge commit rule 3 exists to refuse. The flag
  allowlist in the entry below had just closed that spelling; a `>` in front
  of it re-opened it, and `git merge --ff-only origin/main >/dev/null
  --squash` with it. The same cut failed in the other direction too, on the
  first thing an operator types after a catch-up ships: `git pull --ff-only
  origin main 2>&1 | tail -6` split into a segment ending `main 2`, whose
  stray descriptor read as a third operand, so the exception refused its own
  ordinary use. `stripRedirections` now takes redirections and their targets
  out of the command *before* the exception splits it, and the exception
  splits on `COMMAND_SEPARATOR_CHARS` — the separators without `<>`. The
  order is the point: the `&` in `2>&1` belongs to the redirection, and only
  a reader that has already recognised it can tell it from the `&&` that
  really does start a second command, which is why
  `git pull --ff-only origin main 2>&1 && git merge feature-y` is still
  refused on its second half. Plumbing that hides nothing is allowed with the
  command it plumbs — `2>&1`, `>>log`, `</dev/null`, `&>/dev/null`, a pipe
  into `tail`. A descriptor spelled apart from its operator is not plumbing
  and is not treated as any: `git pull --ff-only origin main 2 > x` passes
  git a refspec called `2`, and stays refused. Every other rule still splits
  the old way, `<` and `>` included, because truncation is what they want.

- **Correct about where a merge lands, and still one act too wide: the
  catch-up that lands nothing.** Rule 3 judges a merge by the branch you are
  standing on, which is right, and then refused every merge there, which swept
  in the one that brings no work: `git pull --ff-only origin main` while on
  `main`. No commit is written and nothing arrives that the remote does not
  already publish — the pointer moves up to what has already been reviewed and
  merged. The cost was not theoretical. A local `main` could not be refreshed
  at all from inside a session: `git fetch origin` was allowed and moved only
  the remote-tracking ref, while every spelling that moved `main` itself was
  S1, so the ordinary act of getting current had to happen outside the gate.
  `checkMergeIntoProtected` now allows a segment that proves, in the command
  text alone, every part of a fast-forward to its own upstream: a plain
  `git merge`/`git pull`, with nothing spliced in front of the subcommand;
  `--ff-only` and no other flag; a source naming *this* branch on a remote
  listed in the new `catch_up_remotes` in `guardrails.yml` — `origin main`,
  or `origin/main` as one ref; and no second operand, since a second source
  is a second thing landing. The flags are an allowlist rather than a test
  for `--ff-only`, because the exception's own spelling is a prefix of
  commands that do the opposite: `git pull --ff-only origin main --no-ff`
  writes a real merge commit, the later flag winning. A flag the hook has
  not read is a claim it cannot make, so it is a denial — and so is
  `git -c merge.ff=false pull ...`, which is why the shape check wants the
  subcommand first. `catch_up_remotes` holds `origin` alone by default and
  the key is optional, so a guardrails.yml written before it existed gets
  that same strict reading rather than losing the rule. The branch comes from `HEAD` rather than a list, so
  the exception is `git pull --ff-only origin master` on `master`, and is not
  `origin main` there. Everything the rule exists for is untouched:
  `git merge feature-y`, `git pull origin feature-y`, a bare `git pull`, and
  `git merge --ff-only main` — a local ref that merely shares the name — are
  all still S1 on `main`, and so is a chain, because each segment is judged
  separately: `git pull --ff-only origin main && git merge feature-y` is
  refused on its second half rather than excused by its first. What the
  exception deliberately does not cover is a bare `git pull --ff-only`, whose
  source is `branch.<name>.merge` in a config file the hook cannot read. It is
  almost always the same catch-up, and "almost always" is the reasoning rule 3
  was corrected out of in **The merge rule read the wrong end of the command**
  below; an operator gets a spelling that is true on its face instead. Nor
  can it vouch for the remote beyond its name: `git remote set-url origin`
  points that name wherever it likes, and the hook reads the command line,
  not `.git/config` — which is why the allowlist is one entry long and
  widening it is a statement about the whole factory. The
  exception is live rather than shadowed only because **The same rule, written
  twice, and the copy that wins is the one that cannot see `HEAD`** below took
  the merge globs out of `permissions.deny` first — a matcher over command
  text would have gone on refusing `git merge --ff-only origin/main` for
  containing the word `main`. The deny message now names the allowed spelling,
  so a session that trips the rule is told the move that works, and
  `renderBranch` substitutes every `{branch}` rather than the first, which
  that message is the first message to need.
- **The same rule, written twice, and the copy that wins is the one that
  cannot see `HEAD`.** `.claude/settings.json` kept `Bash(git merge*main*)`
  and `Bash(git merge*master*)` in `permissions.deny` — the merge rule spelled
  a second time, one layer above the code, in a matcher that reads command
  text. That copy outranks the hook, so the fix in **The merge rule read the
  wrong end of the command** below did not take effect:
  `checkMergeIntoProtected` began judging a merge by the branch you are
  standing on while the glob went on judging it by whether the text said
  `main`. The deadlock that entry describes — a conflicted pull request whose
  one remedy is `git merge origin/main`, with force-push refused so a rebase
  leaves an unpushable branch — was still live on the branch that carried the
  cure, which is how this was found. The entries are removed rather than
  narrowed, because there is no narrower spelling to write: every ref a glob
  can see in a `git merge` is a source. What they matched was the refresh,
  merges *from* `main`, while `git merge feature-y` on `main` — the act they
  existed to stop — never contained the word and always passed. Inverted, not
  narrow, and worth nothing as a backstop. What is left states one principle:
  deny where the command text names a destination, which `git push origin
  main` does and `git merge` never can. Coverage goes up rather than down,
  since the hook also refuses `git pull origin feature-y` on `main`, which no
  entry here ever matched. `SECURITY.md` already describes this list as
  blocking "pushes to `main`, force-pushes, history rewriting, and unbounded
  deletion" — merges were never in its inventory, so the setting was the
  outlier and the document needed no edit.
- **The agent prompts stopped answering the install interview for the
  operator.** `factory/policies/stack.yml` made the stack an operator answer,
  and one prompt out of twelve looked it up. Fourteen lines still named this
  repo's own tools as if every project had them — eight in the prompts, four in
  the standards those prompts cite, two in the policy files a judge reads as
  its own definition of a severity. The coder was told "no style beyond the
  scaffold's Biome config", the tester to "run Playwright e2e" and to file
  "Playwright traces", the security reviewer that "gitleaks, pnpm audit already
  ran". The reviewer's pair was worse than cosmetic: "No style commentary —
  Biome's job" and `S4-nit` = "style/naming nits not caught by Biome"
  contradict each other on a project that answered `lint: none`, where nothing
  catches those nits and the reviewer had just been told to stay quiet about
  them — an entire finding category disappearing on any project without that
  one linter. Every line now points at the policy instead of guessing: the
  linter is "whatever `factory/policies/stack.yml` answers for `lint`",
  `test_e2e: none` is a complete answer that earns no e2e step rather than a
  reach for a runner the project does not have, and the mechanical scanners are
  named by what they do rather than by which binary this repo happens to run.
  `docs/standards/stack.md` files `test_e2e` under "read by agents and by
  nothing in the scaffold"; nothing read it, and now the tester does.
- **`scripts/check.sh` now holds that line.** Its new `Agent templates: stack
  neutrality` step reads the prompts, `docs/standards/`, and `severity.yml` and
  `taxonomy.yml`, and allows a tool the operator gets to choose only in the
  same block that names the policy doing the choosing — a block being one
  bullet, one table row or one paragraph, because exempting a ten-bullet list
  on the strength of a single citing bullet is not a rule. It reaches past the
  prompts because the prompts quote those files, and fixing only the quote
  leaves the drift in place one file over. The rest of `factory/policies/` is
  deliberately out: `guardrails.yml` has to name npm, pnpm, yarn and bun in
  order to match them, and a rule that fires on a matcher naming what it
  matches is a rule about nothing. The vocabulary is tethered rather than
  free-standing — every term it looks for must still appear in `stack.yml` — so
  an option renamed there fails this check instead of quietly disarming it.
- **Two tasks could edit a `yarn.lock` or a `bun.lock` at the same time.**
  `worktree.yml`'s `serialize_always_globs` is what keeps concurrent tasks off
  the shared-file hotspots, and it listed `pnpm-lock.yaml` and
  `package-lock.json` — the two lockfiles this repo happens to write. On a yarn
  or bun project the file two tasks collide over is theirs, and it was not on
  the list. All five names are now.
- **The e2e suite was green on every developer machine and red on CI, on a
  test that no CI-red change had touched.** `page.getByLabel('Epic')` in the
  Kanban spec matched two elements — the `<select aria-label="Epic">` it meant,
  and the `<section aria-label="All epics lane">` the board draws — because
  Playwright's label match is a case-insensitive *substring* by default, so a
  short accessible name is contained in every longer one on the page. That
  makes it a race rather than a failure: the locator resolves to one element
  before the board paints and to two after it, so the suite passed where it was
  watched and failed where it was not, and the diff that went red on it had not
  touched the UI at all. Six of the suite's ten label locators already carried
  `exact: true`, so the rule was known and merely unenforced anywhere; the
  other four now carry it, and `ui/test/e2eLabelLocators.test.ts` holds the
  rule for the ones written next. It is a source scan rather than another
  Playwright test on purpose — the ambiguity is only observable while the
  colliding element happens to be on screen, so no run of the suite can be
  trusted to reveal it, and reading the call is the only way to be sure. The 64
  `getByRole(…, { name })` locators are deliberately left alone: a role already
  narrows the match, and rewriting all 64 is not this change.
- **The same test also asserted nothing.** `selectedEpic` starts at `ALL_EPICS`
  (`''`), so from a bare `/kanban` the test named *"All epics" option boards
  tasks across every epic* selected the option that was already selected and
  asserted a lane that was already on screen. It passed over any board the page
  cared to draw, an empty one included, and the behaviour in its title had
  never been exercised. It now deep-links to a single epic, proves every card
  on the board belongs to that epic, and only then widens the picker — where it
  requires a card from an epic in a *different project* to appear, which is
  what makes "across every epic" a thing a card can be counted for rather than
  a heading to read. Checked by mutation rather than by passing: pointing the
  switch back at the scoped epic makes it fail, which the test it replaces
  could not detect.
- **The merge rule read the wrong end of the command, so it refused the
  routine refresh and waved through the act it exists to stop.** A merge has
  exactly one destination and it is never on the command line: it is wherever
  `HEAD` is, and every ref you type is a source. `checkMergeIntoProtected` read
  it backwards, denying any `git merge` whose text named `main`/`master`
  anywhere. One wrong assumption produced two opposite failures. The **false
  deny**: `git merge origin/main` on a side branch — how you bring a stale pull
  request up to date, and the exact opposite of merging into `main` — was
  refused, with a message telling the agent it had merged into `main`. The
  branch it hit hardest was a conflicted PR, where the fix is precisely that
  merge and force-push is refused too, so a rebase produces an unpushable
  branch: the gate left no legal move at all. The **false allow**: `git pull
  origin feature-y` while standing on `main` merges a feature branch into
  `main` and was permitted, because the rule only ever looked for the word
  `merge` — the same act, spelled with the commoner verb. `git pull --rebase
  origin main` on `main` slipped past rule 5 as well, since `bareWord` reads
  `--rebase` as hyphenated and therefore a different word. The rule now asks
  the one question it can answer honestly — *which branch am I standing on?* —
  and covers `git pull` as the same landing. Names only, not
  `protected_branches.patterns`, so the merge queue can keep landing task
  branches on `smith/<epic>/integration`; and `bareWord` still keeps
  `merge-base`, `merge-tree` and `pull-request` out. The copy names the branch
  you are on and points at the move that works instead of ending at "never
  allowed", the same standard the force-push entry below set. One consequence
  for **A commit that described a guardrail was refused for breaking it**
  below: `git merge "main"` is no longer denied on a side branch — quoting
  hides nothing there either, but there is nothing left to hide — so that test,
  and the two prose copies of the same illustration in `guardrails.md` and
  `policy.ts`, now make the point with `git push origin "main"`.
- **A commit message could run the push it was not allowed to make.** The
  rules blank a `-m`/`--message` payload before scanning, on the stated ground
  that a message is git's own prose field, so the blanking "buys no way past
  any rule". That holds for every payload the shell hands over as it stands,
  and fails for the one shape the shell runs first: a command substitution in a
  double-quoted message is expanded *before* git is executed, so the command in
  it really happens and its output is what becomes the message. The blanking
  was deleting the only real command on the line and leaving the rules to read
  the part that was genuinely prose — a protected push, a force push, a deploy
  or an unbounded `rm` wrapped that way was allowed by all six. Backticks are
  the same expansion in an older spelling, and an unquoted payload is expanded
  too. The blanking now stops where the shell starts: single quotes, which are
  the shell's own dividing line, so the test for "will this run" is the shell's
  test rather than a guess layered on top of it. Reading a payload is not
  refusing it — whatever the substitution contains is judged by the same six
  rules, so a message substituting `date` stays allowed.
- **The documented dry run was refused for every command worth asking about.**
  `smith policy check --command '<cmd>'` is how `guardrails.md` says to ask
  what the rules would say about a command *without running it*, and the guard
  hook scans the whole Bash string — so asking about a force push read as a
  force push, and asking about a protected push read as a protected push. The
  answer was reachable only for commands that did not need it. A gate whose own
  dry run is unreachable does not teach caution; it teaches an agent to find out
  by doing. The payload of `--command` on a `policy check` invocation is now
  blanked, resting on one fact and no other: that command parses, evaluates and
  prints, and has no path that runs what it was handed. It is keyed on the
  `policy check` subcommand pair rather than on a binary name, because the
  caller's spelling is `smith`, a package-manager script or the built entry
  point directly and a public repo cannot assume which — nor that an
  installation has not aliased it. It is single-quoted payloads only, for the
  same reason as above: `--command "$(...)"` is expanded by the caller's shell
  first, which makes the question anything but hypothetical. A real command
  chained after the question, or sharing its segment, is read as itself.

- **A redirect turned off the push-to-main gate.** The rules that read a
  command's *operands* — rule 1's destination ref, rule 6's `rm` paths — found
  them by splitting on `;`, `&` and `|` and then reading the segment's last
  whitespace-separated token. That is the destination only when the segment
  ends at the push, and a segment ends at the push only when nothing at all
  follows it. `git push origin main >` a log file handed the rule the log
  file's name; a trailing `#` comment handed it the comment; a second line
  handed it the last word of the second line; a command substitution handed it
  the ref with the closing paren stuck to it, which is nothing's name. Every
  one of those was allowed, on any branch, by the hook that exists to refuse
  them. The first shape is the one that matters: it is not an evasion, it is
  how anyone writes a quiet push, and a deny gate an ordinary redirect switches
  off is not a deny gate. Two changes, because either alone leaves a hole: the
  separator set widens from `;&|` to every character that ends the command a
  segment is about (those three plus a newline, `(`, `)`, `{`, `}`, `<`, `>`,
  `#` and a backtick), and the destination is now read as *every* non-flag
  operand after the `push` word rather than as the last token — needed because
  `2>&1` splits to a segment whose last token is `2`. Scanning all the operands
  needs no guess about which one is the destination, and over-refuses at worst,
  which is the direction this file errs in everywhere. The force-push and
  deploy rules were never affected: they match on a regex over the segment, not
  on its operands. One pre-existing **false** deny falls out of the same fix —
  `rm -rf workspaces/scratch >` a log file was refused, because the redirect
  target was read as one more path the `rm` was about and `/dev/null` is under
  no allowed root. `stripMessageFlagValues` deliberately keeps the old narrow
  split: parentheses are ordinary inside a commit message (`fix(policy): …`),
  and that function is about prose, not refs. Thirteen tests, four of them
  pinning what must still be allowed — a branch merely *containing* `main`, a
  refspec whose remote side is unprotected, and the two bounded removals. The
  187 policy tests that already existed pass unchanged.
- **A commit that described a guardrail was refused for breaking it.** The
  policy matchers scanned the whole command string for refs and command words,
  including the payload of `-m`/`--message` — which is git's own free-text
  field and never a ref. Five of the six base rules could be tripped by a
  sentence alone, with no push, merge, deploy or removal anywhere in the
  command: a commit message mentioning `push origin main` was a push to main, a
  message naming a deploy command was a deploy, `git merge <side-branch> -m
  "…onto main…"` was a merge into main (the word `merge` inside a message was
  enough to make an ordinary `git commit` one), and on a protected branch a
  message saying "rebase" was a history rewrite. This is the false deny the
  file already engineers against twice — the kind that teaches an agent to
  route around the gate rather than trust it — and it was found the hard way,
  by the hook refusing three of this change's own commands, once while writing
  the tests that now pin it. `stripMessageFlagValues` blanks the payload before
  the six rules scan, and only where git spends the flag on free text —
  `commit`, `merge`, `tag`, `stash`, `notes` — so a `-m` that means something
  else keeps its argument (`mkdir -m 755`, `git revert -m 1`, `git rebase -m`).
  It is deliberately narrower than the existing `stripQuotedSpans` in the same
  file: only a message goes, so a quoted *ref* is still read and `git merge
  "main"` is still denied. Fifteen tests, six of them asserting what a real
  command still trips.
- **Four documents promised a force-push rule narrower than the one enforced,
  and the denial itself was a dead end.** `AGENTS.md` said "never force-push
  shared branches", `CONTRIBUTING.md` said "a branch someone else may have
  pulled", `README.md` scoped it to "a protected branch", and
  `guardrails.md` listed `push --force` inside the bullet about `main` being
  untouchable — four ways of implying that a private branch is fair game. It
  never was: `checkForcePush` matches `--force`/`-f`/`--force-with-lease` on
  any `git push` and has since Phase 2, as `.claude/settings.json`'s deny list
  does independently. The gap that made this bite was the other half of
  `guardrails.md`, which allows `rebase`/`commit --amend` on a task branch
  before the merge queue without saying that a task branch *already pushed*
  therefore cannot be republished — so an agent could follow the documented
  workflow into a branch it had no way to update, and read a refusal that
  stopped at "never allowed" with no next move in it. The rules are unchanged,
  because the matcher reads command text and cannot tell a private branch from
  a shared one, and this is the deny gate where guessing wrong destroys work
  that does not come back. What changed is that the documents now say what is
  enforced — **a branch an agent has pushed is append-only**, review feedback
  becomes another commit, and republishing rewritten history is an operator
  action — and the `force-push` reason string says so at the moment it fires,
  the way `push-to-protected` has always ended with "Push a side branch and
  open a PR". Four new tests: three pinning that a task branch, an integration
  branch and a branch nobody has ever fetched are refused identically, and one
  reading the real `guardrails.yml` to hold the copy to naming a way forward.
  The queue's own rebase is untouched and stays legal — it runs inside the
  task's worktree and is never pushed anywhere, which is now written down as
  the reason the two rules do not collide.
- **`scripts/check.sh` failed on a clean checkout, for reasons no contributor
  had caused.** `vitest.config.ts` set no `testTimeout`, so the 5s default —
  sized for in-process unit tests — governed `cli.test.ts` and
  `guardHook.test.ts`, which drive the built binary through `spawnSync`. One
  `node dist/cli.js` boot costs ~1.4s before the command runs (module loading;
  `drizzle-orm/better-sqlite3` is ~0.9s of it), so a test that spawns
  twenty-three times spends ~35s on node startup with nothing wrong. On an
  ordinary machine that produced ~80 failures, every one a wall-clock timeout
  and not one an assertion — in the gate `AGENTS.md` tells every contributor to
  run before opening a PR. The suite already knew: twenty-six tests and hooks
  carried hand-written 20-40s overrides, one naming the cause outright ("ten
  sequential CLI process spawns — over vitest's 5s default on a CI runner").
  Those were twenty-six correct diagnoses of one global misconfiguration, and
  the spawning tests that never got one simply failed. `testTimeout` and
  `hookTimeout` are now set once, in `vitest.config.ts`, with the reason and
  the measurement written next to them; the twenty-six local overrides are
  gone, since a budget stated in twenty-seven places is twenty-six copies that
  drift. The budget is a hang-detector, not a performance assertion — it is
  loose on purpose, for the reason `policyHookEntry.test.ts` already gives for
  refusing to time the hook.
- **A public repo shipped two vendor judges switched on, for machines that
  have neither.** `crosscheck.yml` carried `codex` and `deepseek` at
  `enabled: true`, and `enabled` is the one field in that file that describes
  a *machine* rather than the contract — it answers "does this box have that
  judge", and for a box the repo has never seen the honest answer is no. The
  repo's own diagnostic said as much: `smith judge preflight` exited 1 on a
  fresh clone, naming a precondition unmet for a provider nobody had asked
  for. Nothing failed loudly, which was the problem — `quorum.ts` catches a
  provider error, and in `mode: shadow` the verdict gates nothing — so the
  cost was paid quietly: every quorum trigger, and `gate.ts` raises one on
  every blocking finding, spent two doomed calls and left two failure rows
  that read like an outage. Both now ship `enabled: false`, so nothing is
  invoked until an operator switches on the provider their own box actually
  has — which is the behaviour `enabledExternalProviders` already promised in
  its own doc comment ("an all-disabled policy (the shipped default) returns
  [] … no judge call, no events, no spend"). `judgePreflight.test.ts` pins the
  one verdict about the real file that reads the same on every box: the
  shipped policy is sound with nothing installed. The file's header, both
  PRECONDITION notes, the operator guide, the provider runbook and the Phase 8
  roadmap goal said the old default out loud and now say this one.
- **The guard hook loaded the entire orchestrator to answer a question about
  a command.** `.claude/hooks/guard.sh` fires on every `Bash`/`Write`/`Edit`/
  `MultiEdit`/`NotebookEdit` call an agent makes, which makes whatever it
  execs the most frequently run code in the repo. It execed
  `dist/cli.js policy hook`, and `cli.ts` is a router with 64 top-level
  imports — `db/projector.js`, and so `drizzle-orm`, among them. Loading that
  graph measured ~1.63s in front of ~39ms of actual policy work: a database
  layer loaded and thrown away once per guarded action, in front of every
  action every agent takes. The shim now execs `dist/policyHook.js`, an entry
  point whose import graph is the decision's alone, and the same payload
  through the same shim measures ~0.20s. `smith policy hook` still exists and
  behaves identically — both routes call `decideHookPayload` in the new
  `hookDecision.ts`, so there is no second copy of the decision to drift.
  `policyHookEntry.test.ts` pins both halves of that: parity with
  `cli.js policy hook` case by case, and a structural assertion that the
  hook's import graph cannot silently regain the database layer.
- **Every `smith` invocation loaded the database layer, including the ones
  that have nothing to do with a database.** `cli.ts` is a router, and it
  imported all sixty-odd of its modules at module scope — nine of which reach
  `db/schema.js`, and so drizzle-orm. That is a graph a CLI walks in full to
  answer `smith --help`, and it is the same defect the guard-hook entry above
  fixed by routing around `cli.ts` rather than by fixing `cli.ts`. The nine
  (`attribution`, `daemon`, `db/projector`, `db/queries`, `epic`, `gate`,
  `lessonAudit`, `lessons`, `scheduler`) are now `await import()`ed inside the
  branches that use them; `main()` was already async, so nothing else moved.
  Measured warm, median of five: `smith --help` 0.314s → **0.106s** and `smith
  policy check` 0.339s → **0.124s**, against an empty-node baseline of 0.027s —
  roughly two-thirds of the boot was a database nobody had asked for. `smith
  daemon status` stays at ~0.31s, which is the design and not a shortfall: it
  needs the layer, so it loads it, and it loads it exactly once. The effect
  compounds where the binary is spawned in a loop — `cli.test.ts` and
  `guardHook.test.ts` together run the same 248 tests in **159.7s** where they
  took **227.1s**, an A/B on one machine with only `cli.ts` swapped.
  Type-only imports of the same nine stay at the top of the file: tsc erases
  them, so `TickOptions` and `DbOpts` cost nothing at runtime and reading the
  file is no worse for having them. `test/cliBoot.test.ts` pins the result the
  way `policyHookEntry.test.ts` pins the hook's — by reading the built module
  graph rather than by timing it, because "it is fast" is a claim a loaded CI
  box can falsify without anything being wrong, while "it does not import the
  database layer" is the property actually wanted. The graph walker both tests
  use now lives once, in `test/helpers/moduleGraph.ts`.

- **The independent finder picked a vendor for operators who had named
  none.** `crosscheck.ts` defaulted `independent_finder.providers` to
  `['codex']`, so a `crosscheck.yml` that omitted the key — or a project whose
  policy file was written from scratch — got a finder pointed at one specific
  third-party CLI it had never been told about. On a box without that binary
  the failure then read `independent_finder.providers names "codex", and
  crosscheck.yml enables none of them`: a sentence quoting a choice the
  operator never made. The default is now the empty list, matching the OFF
  position `enabled`, `mode` and `send_diff` already ship in, and it is the
  last hardcoded vendor name in `factory/orchestrator/src/`. The shipped
  `factory/policies/crosscheck.yml` still names `codex` — explicitly, in the
  file an operator edits, where a vendor choice belongs.

  `runIndependentFinder()` refuses an empty list in its own words, before the
  loop. It used to reach the bottom of that loop having skipped nobody and
  render *"independent_finder.providers names , and crosscheck.yml enables
  none of them"* — a hole exactly where the operator's own words go. Naming
  nobody and naming only disabled providers are different mistakes with
  different repairs, and they now say so separately. Validation stays at run
  time, not parse time: as `IndependentFinder.providers` has always said, a
  policy naming a provider this box has not configured is still a readable
  policy, and one unusable feature should not fail the whole file.

- **The recursive-force `rm` gate read two flag spellings out of the many
  that mean the same removal** (rule 6, `unbounded-rm`). It matched the flags
  as a literal run directly after `rm` — `r` and `f` inside one lowercase
  token, or the two long flags side by side — so `rm -Rf src`, `rm -r -f src`
  and `rm --recursive -f src` deleted trees outside `workspaces/` and
  `state/` with the gate's blessing. `-R` is POSIX's own recursive spelling,
  and bundling is a convenience rather than part of what makes the removal
  dangerous. Detection is now two halves: is `rm` invoked in this chain
  segment, and do its flag tokens carry both recursive and force — read
  across the invocation instead of out of a single token — which also reads
  flags written after the path, where a shell accepts them and the old anchor
  did not look. Eleven cases in `policy.test.ts` pin the spellings, three of
  them the ones that must stay allowed (`-r` without force, `-f` without
  recursion, a command whose name merely ends in `rm`) so the gate did not
  widen past what it names, and thirty-two verdicts were re-driven through
  the context `smith policy hook` builds. The doc bullet under **Changed**
  was written one commit earlier and described the trigger as it then stood;
  it now says both flags, however spelled.
- **A playbook told an agent to run a verb that has never existed** (D-259).
  Step 14 of `.claude/skills/bs/SKILL.md`'s run playbook — the spec-vs-goal
  check that closes an epic — named `smith dispatch audit`. The verb is
  `smith dispatch check`; typing what the playbook said produced
  `Unknown command: dispatch audit` and exit 1, in the step a session reaches
  last. The wrong name came from the CLI's own file layout: the module behind
  the verb is `dispatchAudit.ts`. `usage.ts` and `cli.ts`'s dispatcher are
  pinned to each other from both directions and both were green, because both
  are about code — nothing read the prose as a command line, so the one
  surface an agent is handed was the only one where a verb's name was checked
  against nothing. `factory/orchestrator/test/docCommands.test.ts` now reads
  it as argv: every `smith …` invocation — and every `node …/cli.js …` one,
  which is how the pre-install guide has to write them — in every backtick
  span and fenced block of every instruction file, resolved against the same
  `COMMANDS` table `--help` prints, flags included. 423 of them across 43
  files. A pipe between two words names a command family rather than a
  pipeline, escaped or not; prose brackets and trailing punctuation are
  dropped; an inline span that wraps across a line break is still one span,
  which is how a tenth of these invocations are written; fenced lines stay
  line-anchored so a command cannot swallow the next line's flags. Runtime
  state and the records of the past are excluded by shape rather than by
  name — `docs/specs/dogfood-*`, `docs/specs/evidence/`, `*punch-list.md`,
  `CHANGELOG.md`, this entry among them — so tomorrow's record drops out on
  its own while tomorrow's governing spec is in by default. The parser is
  pinned against fixtures rather than the repo, the exclusion rule is
  asserted directly rather than sampled, and a floor assertion fails if the
  scanner ever stops reading. This is the converse of D-191, and the half
  that bites harder: a verb named in no document reaches no agent, but a
  verb the document invents reaches one and then fails in its hands.
- **D-159 again, at the door P9-36 opened: the dashboard ran the lesson
  novelty gate on library defaults, not on the operator's policy file.**
  `cli.ts` closed every CLI path into that gate against
  `factory/policies/scheduler.yml` — the file `architecture` §9.3 and
  `LessonsSchedulerPolicy` both call the single source of truth. Then P9-36
  gave the UI three lesson routes onto the same `transitionLesson()`, and that
  path never got the fix: Approve and Edit scored duplicates against
  `lessons.ts`'s own constants, so lowering the threshold in the policy file
  moved the CLI and left the dashboard where it was. Latent only because the
  shipped numbers happen to equal the defaults, which is precisely the state
  D-159 named a knob wired to nothing. `createApp()` now reads the policy once
  at startup and spreads it last into every transition, so a malformed file is
  a loud failure when the server boots rather than a 500 the first operator to
  click Approve discovers, and no request body can take the gate's shape.
  Tests may inject a policy; production omits it and reads the file.
- **A drift guard that could not detect drift.** `ui/test/waivable.test.ts`
  ran two tests titled "matches factory/orchestrator/src/waivers.ts …" that
  compared the UI's copy against a literal spelled out three lines above them
  — pinning the copy to itself. Editing `WAIVABLE_SEVERITIES` in the
  orchestrator left both green, which is the one thing the copy exists to make
  loud. The guards now re-derive the lists from `waivers.ts`'s source text
  (the UI bundle still cannot import the orchestrator, and `WAIVABLE_STATUSES`
  is not exported there — reading the file is what is left), and a third test
  pins the parse itself, so a regex that quietly stops matching cannot turn
  both guards into `[] === []`. The docblock in `ui/src/lib/waivable.ts` that
  claimed the protection was real is now a description of what happens.
- **Eight cards asked to be small and eight `<div>`s got an attribute**
  (D-258). `<Card size="sm">` at eight call sites in `AnalyticsPage.vue`,
  `OverviewPage.vue` and `TaskDetailPage.vue`, where `Card.vue` declares
  `title`, `description` and `padded` and nothing else — so Vue's fallthrough
  put the literal string on the root element, `<div class="hds-card"
  size="sm">`, where no stylesheet selects on it and no `.hds-card--sm` rule
  exists to be selected. The cards had rendered at full size since the file
  was written. The attributes are deleted rather than a compact variant
  invented: the cards already look the way they look, so the diff is provably
  visual-neutral, and shipping a design decision no design pass made would be
  the worse fix (D-229's precedent). The unmet intent is recorded as a finding
  instead. Found by the gate above, on its first run; e2e had photographed the
  wrong card 135 green tests at a time, because `shoot()` writes a screenshot
  and does not compare one.
- **Three scheduler event types were invisible to all three directions of the
  P9-37 lint at once** — undeclared, apparently unemitted, and unseen on the
  timeline — with every test green. `scheduler.ts` writes
  `event_type: eventTypeFor(proposal)`, and a call expression at that position
  was deliberately ignored by every rule the scanner had. Adding Rule D made
  the first direction fail with exactly those three types; declaring them then
  made the third fire ("written and never shown"); fixing that produced the
  timeline rows above. The lint written to catch this class of bug had the
  bug's own shape as its blind spot.
- Four exported error classes that nothing ever threw — `ProjectorError`,
  `GateError`, `QuorumError`, `TestGateError` — are gone, each replaced by a
  comment saying why its module does not throw. None of the four files contains
  a single `throw`: a gate failing is a verdict, a failed command is a
  `CheckResult` carrying the exit code and the output, a provider blowing up is
  a recorded transport failure, and a record the projector cannot fold is
  logged and skipped. The classes advertised an error mode that did not exist,
  and the one-error-class-per-module convention would have kept regrowing them.
- `docs/standards/guardrails.md` § CI described a gitleaks gate on every PR
  that did not exist. It exists now (see **Added**), so the line is a
  description again rather than an intention.

- **The guard hook had been allowing everything on macOS since Phase 2, in
  silence.** Its `extract_field` used a `\|` alternation inside a *basic*
  regular expression — a GNU-sed extension that BSD/macOS `sed` (the only
  `sed` on a stock Mac) does not implement. The substitution never matched,
  `tool_name` came out as `''`, and every rule below it fell through to allow,
  on every macOS run, with no error of any kind. Eight phases of "enforced by
  a local guard hook" were, on the machine this repo was developed on,
  enforced by `.claude/settings.json`'s deny list alone. No test noticed
  because no test existed. The rules were ported rather than repaired in
  place, and `test/guardHook.test.ts` now ends with the one assertion that
  would have caught it: on no path may the shim emit an `allow` envelope.
- **A chained command could walk past the git rules.** The bash took the
  *first* segment matching a git subcommand and stopped, so
  `git push origin feat/x; git push origin master` was read as a push to
  `feat/x` and allowed. `gitSegmentsFor` returns every matching segment, and
  `checkUnboundedRm` likewise checks each segment rather than the first `rm` —
  a chain is one tool call and every command in it runs.
- Path comparisons normalise Windows separators before testing a path against
  the allowed roots, closing a gap the bash version had in the same place.
- **`git merge-base` is not `git merge`.** A regex word boundary treats a
  hyphen as a boundary, so the merge rule fired on every hyphenated plumbing
  command whose name begins with a subcommand it watches — `git merge-base`
  above all, which is read-only, cannot merge anything, and is exactly what a
  script reaches for to ask how far a branch has diverged. The bash version
  had the same hole and never fired at all; this one refused a legitimate
  command the first time it was used. A subcommand now has to be a bare word
  with no hyphen on either side, which costs no coverage on `push`, `merge`
  or `rebase` and removes a class of false deny that teaches operators to
  route around the gate rather than trust it.

### Known gaps

- **Nothing hard-stops a dispatch that is already running.** `smith wave
  check` refuses a wave *at admission* — before anything is dispatched, the
  only moment a refusal costs nothing and distorts no work in progress — but
  an admitted wave that overruns its declared cost crosses the epic cap
  anyway, and `smith budget alarm` reports that after the fact. The
  150,000-tokens-per-task cap reports rather than blocks *by design*: a
  self-policed cap becomes pressure on the work being measured.
- **The role sandbox reads command text, not intent.** It is not a container,
  a seccomp profile, or a read-only mount, so a write smuggled through an
  interpreter (`python3 -c "open(...,'w')"`) is invisible to it and always
  will be. The `Write`/`Edit` half is exact — the path is an argument, not
  prose — but the `Bash` half stays a matcher, so a tester's write scope is
  enforced precisely on the tools it normally uses and approximately on the
  shell. `smith worktree fingerprint`/`verify` stays in the pipeline behind
  it to catch after the fact what the matcher cannot see up front; neither
  half is sold as the other.
- **`smith tester check` cannot tell whether the dispatched tester wrote the
  tests.** It answers "was a tester dispatched separately, and did it report,
  before this task's tests were graded?" — nothing in the log distinguishes a
  test file the tester authored from one it merely ran. `role-write-scope`
  fences where a leased tester may write, and the two are complementary rather
  than substitutes. It is also **CLI-only and not wired into `gate run`**,
  following the `dispatch check` / `escalation check` precedent: these audits
  read the log after the fact, and the operator runs them per round. Nothing
  blocks a merge on a `violation` — the check reports, and acting on it is a
  step in the loop, not an automatic stop.
- `.vue` single-file components are still not *type*-checked. `vue-tsc` needs
  Volar, Volar needs TypeScript's classic Node compiler API, and TypeScript
  7's native port does not expose one. The contract gate above knows a prop
  exists; it does not know a `string` was passed where a `number` was
  declared. UI logic stays in `ui/src/lib/*.ts` — checked, linted and
  unit-tested — to keep what remains small.

## Phase 10 — Deployment + ops — in progress

Three items were recorded here as deferred and not specced. Two have since
landed and are described under *Unreleased*: the ops runbook
(`docs/runbooks/ops.md`) and the background process, which shipped as the
`smith daemon` watcher rather than the always-on *dispatch* daemon this entry
first named — dispatch is still skill-guided through `/bs`. The Cloudflare
port of the dashboard stays deferred and unspecced; the dashboard is
local-only today.

## Phase 9 — Hardening — 2026-08-10

- Escalation ladders counted from the event log (`smith escalation check`),
  budget alarms (`smith budget alarm`), and a same-mistake KPI
  (`smith kpi same-mistake`) — three policies that had been prose nothing
  parsed.
- The MCP surface standard: `docs/standards/mcp.md`, `smith mcp init|check`,
  hard-gated at epic close.
- Lesson approve/reject verbs and dispatch-time lesson injection, closing the
  third ungated door into the factory's memory.
- Prompt-injection fencing for ingested text (`smith prompt wrap`), a judge
  worktree-immutability guard (`smith worktree fingerprint|verify`), and
  cross-session event edges.
- Producers for the five task-status events that had none, checks that run at
  the integration root rather than only inside task worktrees, and an epic
  close that is both a logged fact and a folded projection.
- The taxonomy stopped being hand-copied into four files that had all drifted.

P9-1..P9-37, with their close-out and the deliberate leftovers, are in
`docs/specs/phase-9-punch-list.md`.

## Phase 8 — Cross-provider judges — 2026-08-05

Provider adapters (Codex CLI, DeepSeek API), quorum policy, disagreement
analytics, and shadow-mode calibration. All four `crosscheck.yml` quorum
triggers have a host: blocking-finding and same-mistake fire automatically
from the gate; `smith epic verdict` and `smith plan quorum` are
operator-invoked. Both providers shipped `enabled: false` in this phase, were
switched on for a while, and ship `enabled: false` again today — see
**Unreleased** for why, and `docs/runbooks/providers.md` for the enabling and
promotion procedure.

## Phase 7 — Self-extension — 2026-08-05

Inferred tasks with a confidence policy, the scheduler, rechecks, the lessons
compilation loop, and the `/bs` operator skill.

## Phase 6 — UI (HDS) — 2026-08-05

The local dashboard: overview, timeline, and kanban first; lessons, errors,
and analytics second. Built on an in-repo design system with token, emoji,
hardcode, and contrast gates, and a Playwright screenshot suite.

## Phase 5 — State + analytics — 2026-08-04

SQLite projections rebuilt from the append-only event log, the timeline, and
the live agent registry.

## Phase 4 — Gates — 2026-08-04

Test gate, the reviewer/verifier chain, the severity policy, and the waiver
flow.

## Phase 3 — Loop runner + worktree engine — 2026-08-04

Dispatch from task specs, path-claim validation, worktree lifecycle, the
serial merge queue, and the event log everything else is projected from.

## Phase 2 — Skeleton + contracts — 2026-08-04

Repo layout, the spec/result/finding/lesson JSON Schemas, `taxonomy.yml`, and
the agent templates.

## Phase 1 — Interview + standards — 2026-08-04

The operator interview, `docs/standards/stack.md`, the per-agent constraint
blocks, and the pinned scaffold.

## Dogfooding

Running Blacksmith on Blacksmith produced most of what the gates and
policies now enforce. Those defect logs are kept in `docs/specs/`
(`dogfood-4-findings.md`, `dogfood-envkit-findings.md`,
`phase-9-punch-list.md`) and are referenced by id (D-###, P9-##) from commit
messages throughout this history.
