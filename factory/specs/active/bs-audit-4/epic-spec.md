# Epic spec — `bs-audit-4`

- **Epic id** — `bs-audit-4`
- **Project** — `blacksmith`; every worktree is placed beside the clone the run is handed (`AGENTS.md` "Worktrees").
- **Roadmap milestone** — `bs-audit-4` in `factory/specs/roadmap.md`.
- **Provenance** — cut by `bs audit cut` from audit 20261013-4884ad6c (14 accepted findings: 4 S2-major, 9 S3-minor, 1 S4-nit). Each finding carries this epic id in `.blacksmith/findings.jsonl`; `bs audit resolve` marks fixed only the ones a task in this plan still claims, and leaves the rest `deferred`.

## What this epic is

Self-audit 4: dashboard read cost, route hardening, dead payloads. The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's `failure_scenario` says what a passing build must no longer do.

## Acceptance criteria

| # | Finding | Sev | Axis | File | What is wrong |
|---|---|---|---|---|---|
| 1 | `68ae1f67` | S2-major | security | `ui/server/src/app.ts` | The dashboard server mounts its shared request middleware route by route, on six /api routes only; the rest of /api (timeline, errors, analytics, sessions, roadmap, artifacts, stream) answers without it. Mount it once for the whole /api prefix. |
| 2 | `c45e3df9` | S3-minor | security | `mods/pr-mod/hooks/prs.ts` | fixConflictPrompt and fixCiPrompt put pull request metadata (title, branch names, CI check names) into the prompt they submit with JSON quoting only, not inside the data fence the factory's other prompts use for text that comes from outside. |
| 3 | `ea0b214d` | S3-minor | architecture | `docs/specs/black-smith-architecture.md` | The architecture contract still describes dashboard write routes (line 439 'three lesson routes', line 852 'lesson/waiver actions are the only writes', line 874 'approve / edit / reject') after the 2026-10-12 display-only decision, and cli.ts:4708 still cites 'ui/server's reject route'. |
| 4 | `0e7b073d` | S3-minor | architecture | `factory/orchestrator/src/taskEvents.ts` | The superseded/reinstated task rule is restated in three folds (projector foldTasks, taskEvents reinstatedWithoutSuccessor plus idsAlreadyEmitted, reinstate.ts) with different preconditions, and reinstatedWithoutSuccessor omits the 'wave-merged exists' check the projector enforces; two of the folds also dodge an import cycle with dynamic import(). |
| 5 | `4278ea53` | S3-minor | architecture | `factory/orchestrator/src/plan.ts` | draftNextVersion decides which tasks are 'finished' from the plan file's task_status, not from the event log the projector folds, so a plan-file and log disagreement silently supersedes finished work and a separate repair verb (reinstate) was added downstream. |
| 6 | `b4b7db1b` | S3-minor | code-quality | `ui/src/lib/liveness.ts` | liveness.ts exports lastEventLabel, longestRunningSince, activeSessionCount, hiddenSessionsLabel and hiddenAgentsLabel that no shipped UI code imports, so only their own unit tests keep them alive; the same test-only-export pattern recurs in format.ts, kanban.ts, agentScope.ts, taxonomy.ts and timelineDisplay.ts. |
| 7 | `515a7717` | S3-minor | code-quality | `factory/orchestrator/src/db/queries.ts` | overview() and projectSummary() both compute an alerts block (escalations and pendingWaivers, the latter by scanning every finding in scope) that the dashboard no longer reads after it went display-only; the pendingWaivers filter is also written out twice. |
| 8 | `14191ce5` | S3-minor | code-quality | `ui/server/src/activeScope.ts` | When an active epic has no entry in its store's token or running data (for example the store's overview was unreadable and fanOut skipped it), computeActiveScope reports tokensSpent 0 and tokensUnmeasured 0, which factStrip renders as a measured '0 tok' instead of 'Not measured'. |
| 9 | `d5b1cc5e` | S4-nit | code-quality | `ui/src/lib/homeView.ts` | factStrip derives the `quiet` flag by comparing the already-formatted display strings to the literals 'Not measured' and 'None', so a copy change to either word silently stops the tile from reading quiet. |
| 10 | `503e2f36` | S2-major | performance | `factory/orchestrator/src/db/projector.ts` | apply() re-reads and re-parses every session's whole event log, refolds tasks, findings, lessons and operator feedback globally, and reopens plus migrates the database each time any single session's log changes, so the dashboard refresh costs O(all events in all sessions) per change and O(sessions squared) on the first scan. |
| 11 | `38e415f2` | S2-major | performance | `factory/orchestrator/src/db/queries.ts` | timeline() loads every matching events_raw row with its full payload, JSON.parses all of them in toEntry, sorts and filters in JavaScript, and only then slices the requested page, so Home's limit-8 recent-activity poll costs O(all timeline events) and the paged route runs the whole query a second time for the more-probe. |
| 12 | `a2da2311` | S2-major | performance | `factory/orchestrator/src/db/queries.ts` | overview() is a whole-table JavaScript fold (runningSessions selects every events_raw row, liveAgentsAt re-folds and JSON-parses the full registry history twice, epicTokenMaps parses every task-result-recorded payload once per project) and runs uncached on every Home poll. |
| 13 | `01f294b6` | S3-minor | performance | `ui/server/src/app.ts` | /api/active-scope computes a full overview() per store only to read epicsActivelyRunning, epicsInFlight and tokensByEpic, and /api/overview then recomputes the same overview() in the same poll with no memo keyed on the projection state. |
| 14 | `5fec9fff` | S3-minor | performance | `factory/orchestrator/src/gate.ts` | The gate's per-finding loop calls isWaived, raiseFinding, recordReattribution and transition, and each of those reads the whole session lineage (including the continuation index that opens and probes every log in the state directory) before also paying appendEvent's own re-read, so one gate run costs findings x lineage reads. |

## Findings in full

### `68ae1f67` — The dashboard server mounts its shared request middleware route by route, on six /api routes only; the rest of /api (timeline, errors, analytics, sessions, roadmap, artifacts, stream) answers without it. Mount it once for the whole /api prefix.

- **Fingerprint** — `68ae1f67580f62095985aae57a7405f673f087c63af77eb557a02da938cd2139`
- **Axis / severity / confidence** — security / S2-major / 0.8
- **File** — `ui/server/src/app.ts`
- **Inputs** — Any request to an /api route other than /api/cli-sessions, /api/active-scope, /api/overview, /api/kanban, /api/projects and /api/tasks/*.
- **Expected** — Every /api route passes the same request middleware, mounted once for the whole /api prefix so that a route added later cannot miss it.
- **Actual** — The middleware is applied per route, only to /api/cli-sessions, /api/active-scope, /api/overview, /api/kanban, /api/projects and /api/tasks/*; /api/timeline, /api/errors, /api/analytics, /api/sessions, /api/roadmap, /api/artifacts and /api/stream answer without it.

### `c45e3df9` — fixConflictPrompt and fixCiPrompt put pull request metadata (title, branch names, CI check names) into the prompt they submit with JSON quoting only, not inside the data fence the factory's other prompts use for text that comes from outside.

- **Fingerprint** — `c45e3df92611ce33e52ec7bfdaf55215ce2e7eaf24dc8e8e178bc2af765c9602`
- **Axis / severity / confidence** — security / S3-minor / 0.3
- **File** — `mods/pr-mod/hooks/prs.ts`
- **Inputs** — A watched pull request whose title or CI check name is a full sentence rather than a short name.
- **Expected** — Text that comes from GitHub reaches the prompt inside the same data fence `bs prompt wrap` produces, labelled as data to read.
- **Actual** — quoted() collapses whitespace and JSON-escapes the string, so the text reaches the prompt as plain wording on a line of its own; register.tsx submits that prompt when the operator presses the fix key.

### `ea0b214d` — The architecture contract still describes dashboard write routes (line 439 'three lesson routes', line 852 'lesson/waiver actions are the only writes', line 874 'approve / edit / reject') after the 2026-10-12 display-only decision, and cli.ts:4708 still cites 'ui/server's reject route'.

- **Fingerprint** — `ea0b214ddaacb29283ebeafff88116c75fce8758fcf14ac79014288a4c54ce69`
- **Axis / severity / confidence** — architecture / S3-minor / 0.8
- **File** — `docs/specs/black-smith-architecture.md`
- **Inputs** — A planner or spec-reviewer reads section 10 of the architecture contract to cut a task touching the dashboard's lesson or waiver surface, then checks the code at HEAD 46003488.
- **Expected** — The contract says the dashboard is read-only: readOnlyGuard rejects every non-GET/HEAD on /api/*, and lessons/waivers move only through the /bs verbs.
- **Actual** — The contract (a binding spec, not a record of the past) says the dashboard has lesson/waiver write routes and an approve/edit/reject Lessons screen. A task cut from it would build against /api routes that answer 405, and the contradiction is only caught at review. The cli.ts comment names a reject route that no longer exists.

### `0e7b073d` — The superseded/reinstated task rule is restated in three folds (projector foldTasks, taskEvents reinstatedWithoutSuccessor plus idsAlreadyEmitted, reinstate.ts) with different preconditions, and reinstatedWithoutSuccessor omits the 'wave-merged exists' check the projector enforces; two of the folds also dodge an import cycle with dynamic import().

- **Fingerprint** — `0e7b073d0ed2bf1102381aacee2770dd400261f3e4f27eea7356aa664a9de7a8`
- **Axis / severity / confidence** — architecture / S3-minor / 0.55
- **File** — `factory/orchestrator/src/taskEvents.ts`
- **Inputs** — A task-superseded event for task T that never merged, followed by a hand-appended task-reinstated for T and no successor in any plan-version-created; then the next plan ingest.
- **Expected** — One shared predicate: projector and ingest agree on whether T was reinstated. Both either honour or ignore the event.
- **Actual** — The projector ignores the event (merged.has(T) is false), so T stays superseded in the projection. reinstatedWithoutSuccessor counts T as reinstated, so ingest declines to supersede it again. The log then reads as 'T reinstated' while the projection and wave scheduling still read 'T superseded', and no verb repairs it because reinstateTask refuses it (no merge). Each fold has to be edited together on any future rule change, and spec.ts to taskEvents.ts to reinstate.ts are tied by await import() to avoid a cycle.

### `4278ea53` — draftNextVersion decides which tasks are 'finished' from the plan file's task_status, not from the event log the projector folds, so a plan-file and log disagreement silently supersedes finished work and a separate repair verb (reinstate) was added downstream.

- **Fingerprint** — `4278ea537a8b818d837f91cdf03d99f3ec1c9357689ed6df86f8db0c7015f4a0`
- **Axis / severity / confidence** — architecture / S3-minor / 0.4
- **File** — `factory/orchestrator/src/plan.ts`
- **Inputs** — A task that merged (wave-merged in the log) while its plan-file task_status is still not 'completed', then plan amend / draftNextVersion drops or rewrites it.
- **Expected** — 'Finished' is derived once from the log, per section 18 rule 2 (status derived at read time), so a merged task is never superseded by an amendment.
- **Actual** — plan.ts treats the task as unfinished and emits task-superseded for a task the projector holds as completed. The operator must notice and run the new reinstate verb, whose preconditions live in reinstate.ts and the projector instead of at the source.

### `b4b7db1b` — liveness.ts exports lastEventLabel, longestRunningSince, activeSessionCount, hiddenSessionsLabel and hiddenAgentsLabel that no shipped UI code imports, so only their own unit tests keep them alive; the same test-only-export pattern recurs in format.ts, kanban.ts, agentScope.ts, taxonomy.ts and timelineDisplay.ts.

- **Fingerprint** — `b4b7db1b83f208e3b57a247bd4bb9ba7bbd52b6ddd05144279a2020cd665385a`
- **Axis / severity / confidence** — code-quality / S3-minor / 0.7
- **File** — `ui/src/lib/liveness.ts`
- **Inputs** — Search ui/src (components, pages, composables, other lib modules) for imports of the five liveness.ts exports after the display-only dashboard change (#459) and the Home fact strip (#460).
- **Expected** — Every exported helper has at least one non-test consumer, or is deleted together with its tests, so the test suite describes behaviour the dashboard actually has.
- **Actual** — The five exports have zero non-test references (only liveness.ts, its test and a prose mention in ui/docs/design-spec.md). A maintainer changing the live-session rules must keep dead functions and their tests green, and a green test says nothing about what Home renders.

### `515a7717` — overview() and projectSummary() both compute an alerts block (escalations and pendingWaivers, the latter by scanning every finding in scope) that the dashboard no longer reads after it went display-only; the pendingWaivers filter is also written out twice.

- **Fingerprint** — `515a7717140d5e4a25f825adeee38f2400f2197fac6ced836f9f671593856299`
- **Axis / severity / confidence** — code-quality / S3-minor / 0.5
- **File** — `factory/orchestrator/src/db/queries.ts`
- **Inputs** — Any GET /api/overview request (every Home load and refresh) against a store with many findings; grep the UI for readers of overview.alerts.
- **Expected** — Fields the server computes on each overview call have a reader, or the computation is dropped; one rule (needsOperatorWaiver) is applied in one place.
- **Actual** — alerts is summed in ui/server/src/fanout.ts and typed in ui/src/lib/api.ts, but nothing reads it; each overview call still runs allFindingsForScope(...).filter(...) at queries.ts:2028 and a second copy at :1804 for every project summary. The work and the duplicated filter exist only to feed a removed Needs-you surface.

### `14191ce5` — When an active epic has no entry in its store's token or running data (for example the store's overview was unreadable and fanOut skipped it), computeActiveScope reports tokensSpent 0 and tokensUnmeasured 0, which factStrip renders as a measured '0 tok' instead of 'Not measured'.

- **Fingerprint** — `14191ce57ae242cea6fd3487b642b070ac3ee8db1101eb65ba3f5434b805b0a8`
- **Axis / severity / confidence** — code-quality / S3-minor / 0.45
- **File** — `ui/server/src/activeScope.ts`
- **Inputs** — A live CLI session linked to an epic in a foreign store whose overview() throws; the session wrote into the epic since it started, so writtenSinceStart makes the epic active even though the store has no slice.
- **Expected** — The Budget used tile shows 'Not measured' or a floor marker, since no spend could be read for that epic.
- **Actual** — activeScope.ts:191-192 falls back with `spend?.tokensSpent ?? 0` and `spend?.unmeasured ?? 0`; homeView.factStrip sees tokensSpent 0 and tokensUnmeasured 0, so noTokens is false and the tile reads a confident zero. Only the separate storesUnread count hints that totals may be low.

### `d5b1cc5e` — factStrip derives the `quiet` flag by comparing the already-formatted display strings to the literals 'Not measured' and 'None', so a copy change to either word silently stops the tile from reading quiet.

- **Fingerprint** — `d5b1cc5e9c489709d6e6e1aaf69f53f2a88355dc09cfe41794a47a42faa2dd40`
- **Axis / severity / confidence** — code-quality / S4-nit / 0.5
- **File** — `ui/src/lib/homeView.ts`
- **Inputs** — A scope with tasksTotal 0 and a copy edit changing the empty tasks value from 'None' to 'No tasks'.
- **Expected** — The tile keeps its quiet styling because the underlying state (no tasks) is unchanged.
- **Actual** — homeView.ts:89 maps `quiet: tile.value === 'Not measured' || tile.value === 'None'`; the renamed value no longer matches, the tile renders as a loud figure, and no type or test on the state fails unless it also pins the string.

### `503e2f36` — apply() re-reads and re-parses every session's whole event log, refolds tasks, findings, lessons and operator feedback globally, and reopens plus migrates the database each time any single session's log changes, so the dashboard refresh costs O(all events in all sessions) per change and O(sessions squared) on the first scan.

- **Fingerprint** — `503e2f3697fe987d01552cb9650b900efdffc4c8ab8ab0c19a4e3b0c830c2c53`
- **Axis / severity / confidence** — performance / S2-major / 0.75
- **File** — `factory/orchestrator/src/db/projector.ts`
- **Inputs** — A dashboard server over a store with 200 session logs totalling about 200k events, one SSE client (the stream ticker scans every second), and one live session appending an event every few seconds. Also a cold start: the in-memory fingerprint map is empty, so the first API request scans all 200 sessions.
- **Expected** — A one-event append costs work proportional to that session or that event; a cold start reads each log once, about 200 log reads in total.
- **Actual** — Each changed fingerprint calls apply(), which opens the sqlite file and runs migrate(), runs readAllSessionLogs() over every listed session (JSON.parse of all 200k lines), mergeSessionLogs() sorts them, then projectTasks, projectFindings, projectLessons and projectOperatorFeedback each fold the full merged array and rewrite their tables whole, plus projectSession deletes and reinserts the whole changed session. A live session therefore triggers a full-history read and four global folds at up to 1 Hz; the cold scan does 200 applies x 200 log reads = 40,000 log reads, and every /api request joins that one in-flight scan, so the first page load waits for all of it.

### `38e415f2` — timeline() loads every matching events_raw row with its full payload, JSON.parses all of them in toEntry, sorts and filters in JavaScript, and only then slices the requested page, so Home's limit-8 recent-activity poll costs O(all timeline events) and the paged route runs the whole query a second time for the more-probe.

- **Fingerprint** — `38e415f25c5745721d0d9be04fba5724e5a21cea89e060b57436722e82443d45`
- **Axis / severity / confidence** — performance / S2-major / 0.8
- **File** — `factory/orchestrator/src/db/queries.ts`
- **Inputs** — Home page open on a store with about 200k events_raw rows (most of a timeline type); each 5 s poll or SSE advance fetches /api/timeline?limit=8, and the paged branch of timelineAllStores then calls timeline(db, {before: oldest, limit: 1}) to compute nextBefore.
- **Expected** — Eight rows read with an ORDER BY ts DESC LIMIT 9 style indexed query, a few milliseconds regardless of history length.
- **Actual** — select() with no LIMIT returns every row of the timeline event types including the payload column, inLogOrder sorts them in JS, toEntry JSON.parses every payload before any filtering, filterByProject and the kinds filter run over the full array, and paginate slices last. The more-probe repeats all of it, so each poll does two full-table parses on the single event loop, per store, and the cost grows with every event the factory ever logged.

### `a2da2311` — overview() is a whole-table JavaScript fold (runningSessions selects every events_raw row, liveAgentsAt re-folds and JSON-parses the full registry history twice, epicTokenMaps parses every task-result-recorded payload once per project) and runs uncached on every Home poll.

- **Fingerprint** — `a2da2311d9e3376ec1f46f8d46f1318ad8842e28db2e1a49b5480862e63454f7`
- **Axis / severity / confidence** — performance / S2-major / 0.65
- **File** — `factory/orchestrator/src/db/queries.ts`
- **Inputs** — Home page open on a store with about 200k events_raw rows and 5 projects; each poll fetches /api/overview and /api/active-scope (and the Projects and Sessions pages fetch it too), each of which calls overview().
- **Expected** — Per-poll database work close to constant (indexed lookups, or a result memoised until the projection advances), a few milliseconds.
- **Actual** — Each overview() call selects five columns of every events_raw row to find the last event per session (runningSessions), loads and JSON.parses all registry events up to the cutoff in liveAgentsAt (called once by liveAgentCountAt and again by workingAgentCountAt), repeats the pattern in tokensSpentAt and tokensBudgetedAt, and projectSummary repeats allAgentsForScope, allTasksForScope, epicTokenMaps and allFindingsForScope once per project. Cost grows linearly with history and blocks the event loop of the single-process server, so every concurrent request waits behind it.

### `01f294b6` — /api/active-scope computes a full overview() per store only to read epicsActivelyRunning, epicsInFlight and tokensByEpic, and /api/overview then recomputes the same overview() in the same poll with no memo keyed on the projection state.

- **Fingerprint** — `01f294b6b8cd05090896ba3db9ba306507d3c44e4a00a3476d5bea608670f852`
- **Axis / severity / confidence** — performance / S3-minor / 0.6
- **File** — `ui/server/src/app.ts`
- **Inputs** — Home page open with two stores registered; one poll tick fetches /api/overview, /api/active-scope, /api/cli-sessions and /api/timeline together.
- **Expected** — One overview computation per store per projection state shared by the endpoints that read it, or a narrow query for the three fields active-scope needs.
- **Actual** — /api/active-scope calls overview(db, {}, clock) for every store (the unfiltered whole-table fold), then /api/overview runs it again for the selected project; the two to three identical folds per tick per store run back to back on the event loop and multiply the cost of the overview() finding.

### `5fec9fff` — The gate's per-finding loop calls isWaived, raiseFinding, recordReattribution and transition, and each of those reads the whole session lineage (including the continuation index that opens and probes every log in the state directory) before also paying appendEvent's own re-read, so one gate run costs findings x lineage reads.

- **Fingerprint** — `5fec9ffff9c1709c27dc9ad621781f761f4d5ec603d4948040060df7355e6978`
- **Axis / severity / confidence** — performance / S3-minor / 0.5
- **File** — `factory/orchestrator/src/gate.ts`
- **Inputs** — bs gate run or judge report with 25 findings, in a state directory holding 200 session logs and an epic whose lineage spans several wave sessions of a few thousand events each.
- **Expected** — The lineage is read and folded once per gate run, or per finding only the appended delta is applied.
- **Actual** — For each finding: isWaived runs readLineageEvents, the raise runs appendEvent (a full read of the session log), emitFollowUpTask and transition each run readLineageEvents again. Each readLineageEvents does a readdir plus one bounded open/read per log (continuationIndex, about 200 here) and a full parse of every lineage log, so 25 findings cause on the order of 75 lineage reads and 15,000 file opens in one CLI invocation, which delays every wave step that gates.
