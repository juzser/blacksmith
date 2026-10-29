# Epic bs-optimize — fewer tokens per merged task, more agents live at once

- **Epic id:** `bs-optimize`
- **Plan:** v1 (signed off 2026-10-22, `bs-optimize-2026-10-21#29`; `plan-v1.json` beside this file)
- **Effort tier:** huge. Spec review until clean, plan quorum always, grader 2 rounds, verifier on S1/S2 plus a 20% S3 spot check, closing spec review. Epic cap 32M. Coder task cap 440,000 tokens / 1,400 diff lines.
- **Project:** blacksmith
- **Base:** early start, by operator choice on 2026-10-22 (`bs-optimize-2026-10-21#31`): `bs/bs-optimize/integration` is stacked on the unmerged `bs/bs-review/integration` (`68cabfba`) merged with origin/main `73887585` (#486-#491), commit `a1c809bc`. When bs-review merges, main is merged in, claims are re-checked, and the integration PR targets main (run.md step 17). This plan was cut against the preview tree `b0c09e90` (origin/main `5d54ae0a` + the bs-review integration branch). Docs from PR #490 (harness concurrency caps) read from `23283f69`; `bs init` writing the caps (#491, `workroot.ts` `CONCURRENCY_CAPS`) read from `1cc1d525`.
- **Follows:** token-optimization decisions of 2026-10-21 (L1 merged in #489 and out of scope here), parallelism measurement of 2026-10-21.

Every worker reads this file before starting and updates the "Status" line of its own task at the bottom on completion.

## Goal

Cut the tokens spent per merged task and raise how many agents run at once inside one session, without lowering quality. Priority order, binding on every trade-off in this epic: **quality first, speed second, tokens third.**

Baseline (`state/benchmarks/token-epic-2026-10-21/baseline.json`) — the numbers this epic is meant to move. Measuring them is not a task.

| Metric | Baseline |
|---|---|
| Orchestrator share of spend | 40.6% |
| Lessons splice per brief | ~22 KB (58% of brief bytes); 115 lessons, none classified |
| `lessons for-dispatch` JSON output | ~53 KB (text 22.5 KB + `lessons` array 30.6 KB) |
| Wave-runner playbook read per dispatch | ~52 KB (dispatch.md + wave.md), PNGs sometimes Read |
| Waves holding one task | 86 / 153 |
| Busy time with one agent live | 67.6% (peak 10) |
| Gate share of active hours | 28%, ~10 min each, foreground |
| Single-Agent-call dispatch turns | 91% orchestrator, 76% wave-runner |
| Judge rounds run serially | 41% |
| Merge -> next admission (median) | 14.7 min |
| Foreground `sleep` calls | 1,070 (958 in wave-runners) |
| Coder re-dispatch spend / tester extras | ~103.5M / ~52.2M |

## Decisions taken by the operator (fixed — do not re-open)

1. **Lessons by error class (L2, design C).** Each lesson carries one `error_class` from `factory/policies/taxonomy.yml` `error`. Lessons whose class has *proven to recur* are spliced up front; the rest are read on demand when their class *repeats*. A lesson that fits no specific class gets the approved fallback class `other.unclassified` (decision 13); nothing else invents a class.
2. **Orchestrator diet (L3).** Typed `bs-*` agents only. A wave-runner reads only the playbook slice for its current step and never Reads PNGs. No model switch.
3. **`bs brief compose` (L4).** Fully automatic: the playbooks call it, and it folds in L2's selection.
4. **Parallelism "1A":** (a) gate runs in the background; (b) rolling admission; (c) grader + reviewer + security (when triggered) in one message after the tester; (d) every playbook batches independent dispatches in one message; (e) background waits instead of `sleep` loops, plus a per-machine heavy-test queue.
5. **`bs doctor` caps check.** Warn when `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` or `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` is unset or not above 20 / 10. Amended in round 2 for #491: the names and target value come from `CONCURRENCY_CAPS`, and the fix points first at re-running `bs init` and restarting Claude Code, then at the global route (INSTALL.md "Raise the concurrency caps").
6. Never trade quality for tokens (L5 rejected): no judge, gate check, round or verifier pass is dropped to save tokens.
7. No finer task split than this plan.
8. Measurement is not a task; acceptance criteria may name the baseline metric they move.
9. No 0.6.0 bump. CHANGELOG `## Unreleased` entries are in scope.
10. Early start (operator, 2026-10-22, `#31`): rounds 1-3 (T1-T9, T12) are coded now on the stacked base above; T10 and T11 start only after bs-review merges and claims are re-checked on that base.
11. Open source: no foreign project names in code, docs, tests or fixtures (`project-a`, `<project>`).
12. Tier huge, via `/bs plan` then `/bs run`.
13. **Class `Other`.** One taxonomy key is added: `other.unclassified` (new group `other` with the single class `unclassified`; the key has two parts because every `error` value is `group.class`). Every one of the 115 lessons gets a class; one that fits none gets `other.unclassified`. `other.unclassified` lessons are spliced only on recurrence or repeat, like every other class. A class later removed from the taxonomy is read as `other.unclassified`, with a `lessons for-dispatch` warning.
14. **Thresholds.** *Proven to recur* = 3 or more `error-logged` events of the class on distinct tasks within 30 days, store-wide. *Repeats in epic* = 1.
15. **Deny in every session**, the operator's own included: a marked brief sent to the wrong agent type, and a foreground `sleep` of 2 s or more. The deny reason names the rule and the fix.
16. **Cleanup.** A `bs cleanup` verb removes merged, idle task worktrees, their branches and orphan directories, by the safety rules in D10. `run.md` runs it at epic close. At epic close the epic session, and at wave end the wave-runner, stop their own still-running background tasks and idle subagents with TaskStop, under the rules in D10.

## Design this plan commits to

### D1. Lesson error class (T1, T3)

- **Taxonomy (T1):** `taxonomy.yml` `error` gains the group `other: [unclassified]`; `version` goes up by one with one history comment line (11 -> 12 on the preview base; T1 reads the current value at coding time). `docs/specs/black-smith-architecture.md` §8 mirrors the version and the error groups (`taxonomy.test.ts` compares them), and `taxonomy.test.ts`'s version pin moves to the same value. No other group or class changes. T1 owns every one of those files, so no other task can see a half-added key.
- `lesson.schema.json` gains optional `error_class` (string, `group.class` form, e.g. `execution.flaky-test`). Validated at write time against taxonomy `error`; an unknown value is refused with an error that names the value. The schema does not inline the enum (taxonomy rule).
- Store: a new drizzle migration, numbered next free (`0020` on the preview base; T1 reads `drizzle/meta/_journal.json` at coding time), adds a nullable `error_class` column to `lessons`; `src/db/schema.ts` and the projector fold carry it.
- `lessons raise` accepts an error class (`raiseLessonCandidate({..., errorClass})`); CLI flag `--error-class` is wired by T10.
- `compileLessons` renders `- error_class: <group.class>` under the scope bullet. When the store row has no class but the existing `lessons.md` entry does, the compiled entry keeps the file's value — that is what makes T3's backfill durable across `lessons compile` without a store migration. `parseLessons` (severity.ts) reads the bullet into the lesson rule.
- `LESSONS_MD_HEADER` gains one sentence saying what `error_class` is for.
- **T3 backfill** adds one `- error_class:` bullet to every one of the 115 entries in `factory/policies/lessons.md`. Statements are not touched. An entry that fits no specific class gets `other.unclassified`. There is no unclassified list: the test asserts every entry carries a class read from taxonomy.yml.
- **What counts as an entry:** a `###` block carrying a `- lesson_id:` bullet under a scope section. The format examples under `## Schema` are not entries. The test's fixture id list equals the file's ids exactly.
- **How T3 picks a class:** the class the failure the statement describes would be logged as in an `error-logged` event. When two fit, the one the statement's fix addresses. `other.unclassified` only when no class fits. Spot checks pinned by the test: `bs-audit-3-gate-timeout-under-load` -> `execution.env-failure` ("log it as an env failure"); `lesson-raised-720003607334` (merge conflict in a throwaway worktree) -> `integration.merge-conflict-textual`; plus three the coder names in the task result with the deciding sentence.

### D2. Selection by class (T2)

- New module `src/lessonRecurrence.ts`: `errorClassCounts(events, {now, windowDays})` folds `error-logged` events into per-class counts of distinct tasks, store-wide and per epic. **Event identity** (the event envelope has no `epic_id`: `event.schema.json` is `additionalProperties: false`):
  - *class* = `payload.error` (the `group.class` the event was logged with).
  - *task* = `eventTaskId(record) ?? payload.task_ref`: the envelope `task_id`, else `payload.task_id` (events.ts `eventTaskId`), else the error payload's own `task_ref`. This is the rule agents-registry.ts's `error-logged` fold already uses; it is reused, not re-implemented. Distinct-task counting uses this identity, so three events of one class on one task are one task.
  - *epic* = `payload.epic_id ?? epicOfTaskId(task)` (taskId.ts): `payload.epic_id` wins when both exist. An event with a task but no epic (an unqualified task id and no `payload.epic_id`) counts store-wide only, never toward an epic.
  - An event with no task identity is skipped: it counts toward no class, store-wide or per epic (decision 14 counts distinct tasks).
  - With no epic given, nothing counts as a repeat.
- New module `src/lessonEvents.ts` (T2): `readRecurrenceEvents(stateDir, {now, windowDays})` is the one store reader. **Store-wide means every session:** it lists every session id (`listSessionIds`, events.ts), skips a session file whose mtime is older than the window, reads each with `readEvents`, and keeps the `error-logged` events inside the window. A missing dir reads as []. **Why the skip is safe:** events.ts `appendEventLocked` stamps every event's `ts` with the current time before it appends the line, and the one path that keeps a caller's `ts` (`keptTs`, under `keepTs`) is limited to `prompts-` logs and refuses a `ts` in the future; so a session file's mtime is never earlier than its newest event's `ts`, up to the file system's timestamp granularity (milliseconds on Linux's coarse kernel clock, 1 s on HFS+), a margin that at the window's start can only drop an event. Only a tool outside Blacksmith that moves a file's mtime backwards (a copy that preserves old times, a manual `touch -t`) breaks the invariant, and then the reader undercounts, never overcounts. lessonEvents.test.ts pins it (AC3). **Cost bound:** one `stat` per session file and one `readEvents` per session file modified inside the window; a file older than the window is never opened (the test counts the calls). The CLI reads `STATE_EVENTS_DIR`; `lessonRecurrence.ts` stays pure.
- **Proven to recur** (spliced up front): at least **3** `error-logged` events of the class, on distinct tasks, in the last **30 days**, store-wide. **Repeats** (read on demand): at least **1** `error-logged` of the class in the dispatch's own epic. Each threshold is a constant with one named definition (`RECUR_MIN_TASKS = 3`, `RECUR_WINDOW_DAYS = 30`, `EPIC_REPEAT_MIN = 1`).
- `lessonsForDispatch` selection, in order:
  1. `agent-role` and `claim-path` scopes: unchanged and unfiltered (they are already narrow; P9-2 stays).
  2. A lesson's class is read from its `error_class`. A lesson with none (a later raise without `--error-class`), or with a class no longer in taxonomy.yml, is read as `other.unclassified`, and the result carries a warning naming the lesson id and the value found.
  3. A `stack-wide` / `case-type` / `security` lesson: spliced when its class recurs or repeats in this epic; otherwise **withheld**. `other.unclassified` follows this rule like every class; nothing is spliced merely for lacking a class.
- The rendered block ends with one line naming each withheld class with its count and the exact command to read it (`bs lessons for-dispatch --class <group.class>`).
- Return shape gains `withheld: [{lesson_id, error_class}]` and `warnings`. The `lessons` array (30.6 KB of the 53 KB) is omitted unless `full: true`; `class: '<group.class>'` returns exactly that class's lessons. Approved-only stays true by construction (the compiled file is still the only source).
- `security`-scope lessons follow the class rule for every role except the security-reviewer. A security-reviewer brief withholds no lesson of any scope (quality first).
- **On-demand happens automatically:** a bounce logs `error-logged` with its class, so the re-dispatch brief that `bs brief compose` builds next splices that class's lessons. No agent has to remember to ask.

### D3. Brief compose (T4, T5, T10)

- New module `src/briefMarker.ts` (T5): `formatBriefMarker({role, taskId, sessionId})` / `parseBriefMarker(text)` for a first-line HTML comment `<!-- bs-brief role=<role> task=<task-id> session=<session-id> -->`. One definition; T4 writes it, T5's hook reads it.
- New module `src/briefCompose.ts` (T4): `composeBrief({role, taskId?, planFile?, sessionId, worktree?, branch?, turnBudget?, specsDir, events, agentsDir, ...})` returns `{text, manifest}` and assembles, in `dispatch.md`'s "Carry into the prompt" order: marker; role + task id; the absolute worktree path and branch; the task spec entry verbatim; claims; token cap and diff cap; `Turn budget: N`, where N is the role template's `maxTurns` (`readTemplateMaxTurns`, agentsSync.ts) and a caller `turnBudget` that differs is refused (`brief.turns-mismatch`); the epic-spec path to read first; the lessons block (D2 selection); the findings block (`findingsForDispatch`, findingContext.ts); the return-discipline section; the envelope line; the judge fingerprint commands; `Declared artifact: <absolute path>` for judge roles and uiux only — **never** for a coder (#245). It refuses (named error) a missing worktree for a worktree role, a missing task in the plan, or a judge role with no artifact path.
- **Where the shared text comes from (nothing retyped):**
  - **Return discipline:** the `## Return discipline (agent-interviews.md M-6)` section of the shipped `dispatch.md` (`<REPO_ROOT>/.claude/skills/bs/dispatch.md`; a `dispatchDoc` option overrides the path in tests). Compose cuts it at run time with T5's `sliceSection` (D4) by that exact heading and splices it verbatim. A renamed heading fails compose with `playbook.unknown-section`, a duplicated one with `playbook.ambiguous-section`; compose never emits a brief without the section. T4's test runs against the real file, and T11 keeps the heading byte-identical. The T5 -> T4 edge already exists, so this adds no edge and no round.
  - **Envelope:** one line naming the fields the worker must not write, rendered from `ORCHESTRATOR_OWNED_RESULT_FIELDS` (results.ts), the constant `stampResultEnvelope` enforces with `results.agent-wrote-owned-field`. The rest of dispatch.md's envelope section is not spliced. It tells the dispatcher which `bs gate run` flags to pass, and its "**you** add `task_id` ..." would tell a worker to write the very fields the gate refuses.
  - **Heavy runs:** no text. The suite-running role templates carry the `heavy-run` fragment (D9), the rule's one home; a brief adds no copy.
- Output: the brief text plus `manifest.json` (spliced and withheld lesson ids, finding ids, byte counts per section) written to the path the caller names. Every composed brief passes `lintDispatchPrompt` (dispatchLint.ts) with `exitCode: 0`. That lint wants exactly one `Turn budget:` equal to the template's `maxTurns` and, for a judge, a ledger turn (`recordJudgeDispatch`) whose declared artifact equals the brief's `Declared artifact:` line. The test records those judge turns in a temporary store before linting. Compose reads no store: the caller passes the events (D2's `readRecurrenceEvents`).
- CLI `bs brief compose ...` (T10). Playbooks (T11) call it for every dispatch; hand-assembled briefs stop being the documented path.

### D4. Orchestrator diet guards (T5)

Both denies apply in **every session**, the operator's own interactive one included (decision 15); the hook reads no session or operator identity.

- `hookDecision.ts`, Agent PreToolUse:
  - a prompt carrying a brief marker must go to `subagent_type` `bs-<role>` / `blacksmith:bs-<role>` matching the marker's role; `general-purpose` or a different role is denied.
  - **What the operator sees:** a deny reason naming the rule and the fix, e.g. "Blocked: this brief is marked for role `coder`; typed agents only. Fix: dispatch to the matching `bs-coder` (or `blacksmith:bs-coder`)."
  - **What a marker is:** the whole first line of the prompt, after stripping one leading BOM, naming a known role. A marker on a later line, inside a code fence, or naming an unknown role is no marker.
  - Prompts without a marker keep today's behaviour (the judge-artifact rule stays as is).
- `hookDecision.ts`, Bash PreToolUse: a foreground `sleep` of 2 s or more is denied, by the verdict table below. The rule is per `sleep` invocation: the command line is parsed into simple commands, and each `sleep` that would block the call is judged on its own duration.
  - **What the operator sees:** "Blocked: foreground `sleep` of N s. Fix: use a background task or the Monitor tool instead of `sleep`."
  - **Exemptions** (decision 15), each a row below: a sleep under 2 s; `sleep` inside a script file the command runs (the hook parses the command line, not the script); a backgrounded sleep (`run_in_background: true`, or a segment ending in a single `&`); and, for the Agent rule, unmarked briefs. `timeout` is not a sleep.
  - **Duration:** operands are summed (`sleep 1 1` = 2 s); suffixes `s`, `m`, `h`, `d` and decimals are read; a variable operand, a substitution or `infinity` is unknown length and counts as 2 s or more.
  - **Verdict table** (every row is a test in hookDecision.test.ts):

    | Command | Verdict | Why |
    |---|---|---|
    | `sleep 2`, `sleep 30`, `sleep 2s`, `sleep 1m`, `sleep 1 1` | deny | foreground, 2 s or more |
    | `sleep 5 && x`, `x; sleep 5`, `x \|\| sleep 5`, `x` newline `sleep 5` | deny | chained, still foreground |
    | `sleep 5 \| cat` | deny | a pipe stage blocks the call |
    | `until test -f x; do sleep 5; done`, `while ...; do sleep 5; done` | deny | loop body, per-invocation rule |
    | `sleep 30 & wait` | deny | `wait` blocks on it in the foreground |
    | `timeout 30 sleep 30`, `nohup sleep 30`, `env X=1 sleep 30`, `X=1 sleep 30`, `command sleep 30`, `time sleep 30`, `exec sleep 30` | deny | wrapper runs the sleep in the foreground |
    | `echo $(sleep 3)`, `` echo `sleep 3` `` | deny | substitution runs in the foreground |
    | `bash -c 'sleep 30'`, `sh -c ...`, `zsh -c ...` | deny | parsed one level deep |
    | `sleep $N`, `sleep "$N"`, `sleep infinity` | deny | unknown or unbounded length |
    | `sleep 1`, `sleep 1.9`, `sleep 0.5` | allow | under 2 s |
    | `while ...; do sleep 1; done` | allow | each invocation under 2 s (decision 15) |
    | `sleep 30 &`, `nohup sleep 30 &`, any sleep with `run_in_background: true` | allow | backgrounded |
    | `sleep` (no operand) | allow | errors at once, blocks nothing |
    | `echo "sleep 30"`, `grep sleep f`, `git commit -m 'sleep 30'`, `nosleep 30`, `# sleep 30`, a heredoc body line `sleep 30` | allow | text, not a `sleep` command |
    | `./wait.sh`, `bash wait.sh`, `pnpm run x` | allow | sleep inside a script is not read |
    | `ssh host sleep 30`, `docker run img sleep 30`, `xargs sleep` | allow | an argument to another program |
    | `timeout 30 pnpm test` | allow | `timeout` is not a sleep |

- **Failure rule (both diet rules):** the rules live in an exported `dietDecision(payload, deps?)` with injectable parsers, called by `decideHookPayload` inside a try/catch. A parse failure (unbalanced quotes, an unterminated `$(`), a non-string or oversized field, or any throw means **no diet match**: the existing decision path (judge-artifact rule, policy evaluation) runs exactly as today. A diet rule never denies on input it could not read and never throws out of `decideHookPayload` (guard.sh turns a throw into an ask, which would put a prompt on every call). The parser is bounded: no regex backtracking on a 1 MB command.
- New module `src/playbookSlice.ts`. A cut, not a copy: tests run against the real files, so a renumbering or heading rename breaks the test, not the runner. Slice grammar (lines inside ``` fences are never headings or steps):
  - `sliceWaveStep(markdown, n)`: wave.md's steps are the top-level (column 0) numbered items `n. ` under `## The steps`; today they are 2-10 (there is no step 1). The slice runs from the line `n. ` to the next top-level numbered item or the next heading, else EOF. A step that does not exist raises `playbook.unknown-step`.
  - `sliceSection(markdown, heading)`: the exact `##` or `###` heading text, to the next heading of the same or a higher level, else EOF. An unknown heading raises `playbook.unknown-section`; a heading present twice raises `playbook.ambiguous-section`. Works on wave.md and dispatch.md alike.
  - CLI `bs playbook slice <wave|dispatch> --step <n> | --section "<heading>"` (T10).
  - Content outside the steps: the wave-runner reads wave.md's `You own the log for what you dispatch` and `Run the whole wave at once` once per wave with `--section`, then one step slice per step (T11).

### D5. Judges in one message (T6)

- grader, reviewer and security-reviewer (when `security triggers` says so) are dispatched in **one message** after the tester returns. Tests in `judges` / `judgePreflight` prove that concurrent dispatches of the three on one task keep distinct declared artifacts and fingerprints, count one round per (task id, role), and that preflight accepts the three in any arrival order.
- Grader bounce semantics (no quality loss): reviewer and security results from the same round are kept, raised as findings and spliced into the bounce brief; the verifier still runs on the reviewer's S1/S2 before the bounce brief is composed. No judge is skipped because another judge bounced. If the existing code forces an order, T6 removes that ordering and nothing else. Read on the preview base, `recordJudgeDispatch` refuses only on role, kind, round, artifact path and model, so no order is forced and T6 is expected to be tests-only. Its cases: all 6 arrival orders; reports closing in any order (`outstandingJudges`); a grader bounce leaving the reviewer's S2 finding `raised` for the verifier and the bounce brief; the epic-wide round count across sessions; preflight in parallel equals serial.

### D6. Rolling admission (T7, T10)

- New module `src/admission.ts`: `inFlightTasks(events, {epicId, planVersion})` returns task ids admitted (a `wave-admitted` event or a coder dispatch naming them) with no later terminal event for that task. Terminal: `wave-merged` naming the task, `task-superseded` naming it, or `epic-closed` for its epic. Not terminal: a bounce (blocked gate or grader bounce), a re-dispatch, a failed agent run; the task stays in flight through them. `computeNextWave` takes an `inFlight` set and puts those ids in `occupied` regardless of the plan file's `task_status` — this closes the ingest-resets-in-flight hazard (after `plan ingest` an in-flight task reads `todo`).
- `wave next` may be run at any time, including mid-wave: it admits any task whose dependencies are done and whose claims do not overlap an in-flight task. `wave check` refuses a task that is in flight with a named error (`wave.in-flight`; codes are scanned from source, so raising it is the registration). Wiring both into `nextWaveInputFrom` / the inline `wave check` is T10.
- run.md (T11): after every merge, run `wave next` and admit what it returns right away (rolling), instead of waiting for the whole wave to drain.

### D7. Heavy-test queue (T8, T10)

- New module `src/heavyLock.ts`: `withHeavyLock(fn, {lockDir, label, cwd, pollMs = 2000, maxWaitMs = 3600000, isPidAlive, env})`. One lock per machine (CPU and the hard-coded e2e port 4681 are per-machine, so a per-repo lock would still collide). Default dir `$BS_HEAVY_LOCK_DIR`, else `~/.blacksmith/locks`; every test injects a temporary dir. Lock semantics:
  - **File and atomicity:** `<lockDir>/heavy.lock` holds `{pid, token, label, startedAt, cwd}`. It is written to a temp file and published with `link()`, which fails `EEXIST` when held, so no waiter ever reads a half-written lock.
  - **Stale:** a live pid is never stolen, however old the lock; age is no evidence. A lock is reclaimed only when its pid is dead or the file is empty or unparseable. **Liveness:** heavyLock.ts exports `pidIsAlive(pid, kill = process.kill)`, the default `isPidAlive`: a pid is dead only when `kill(pid, 0)` throws `ESRCH`; `EPERM` (a live process another user owns, possible with a shared `$BS_HEAVY_LOCK_DIR`) and any other error mean alive. A `pid` that is not a positive integer is never probed (`kill` reads 0 and negatives as process groups); the lock is unparseable. Reclaim runs under a short `heavy.lock.reclaim` exclusive-create mutex (itself broken after 10 s), re-reads the lock and unlinks it only if the token is unchanged, so two reclaimers cannot both win.
  - **Timeout:** past `maxWaitMs` the waiter throws `heavy.wait-timeout` naming the holder's pid, label, cwd and start time, the time waited and the lock path; `fn` never runs. A reused pid (the holder died and the number was reissued) is bounded by this timeout, and the message says which file to inspect.
  - **Reentrancy:** `withHeavyLock` calls `fn(lease)` with `lease = {token, lockDir}`: its own token when it acquired, the live lock's token when it re-entered, and always the resolved lock dir. The dir resolves from `lockDir`, else `env.BS_HEAVY_LOCK_DIR`, else the default. When `env.BS_HEAVY_LOCK_TOKEN` equals the live lock's token in that dir, `fn` runs at once without acquiring or releasing.
  - **Passing the lease to the child:** `projectCommandEnv` (testgate.ts) strips every `BS_`/`SMITH_` variable from a project command's env. The one add-back is `heavyChildEnv(env, lease)`, exported from testgate.ts beside the strip it undoes: `projectCommandEnv(env)` plus `BS_HEAVY_LOCK_TOKEN` = `lease.token` and `BS_HEAVY_LOCK_DIR` = `lease.lockDir`, and nothing else from either namespace. `run` and the merge queue's `runTestCmd` (T8) and `bs heavy run` (T10, importing it) spawn their child with it. So a heavy check that itself calls `bs heavy run` re-enters the same lock, under a non-default lock dir too, instead of deadlocking or creating a second lock file. It lives in testgate.ts, not heavyLock.ts, because testgate.ts already imports heavyLock.ts; T10 writes no add-back of its own.
  - **Suite hermeticity:** the vitest setup file `factory/orchestrator/test/setup.ts` (T8) points `BS_HEAVY_LOCK_DIR` at a per-file temporary dir and deletes any inherited `BS_HEAVY_LOCK_TOKEN`. So no existing test that runs a `test`-named check through `run` (gate, integration and CLI tests), and no queue test, waits on a machine lock another session's gate holds.
  - **Release:** in a finally path, and only when the lock's token is still ours.
  - Waiting is a poll loop inside the process, never a shell `sleep`. `readHeavyLock(lockDir)` returns the record, `{corrupt: true}` for an unparseable file, or `undefined` (D10 and the TaskStop rule read it).
- `testgate.ts` (T8): `CheckCommand` gains optional `heavy?: boolean`. **Which checks are heavy:** exported `isHeavyCheck(check)`; an explicit boolean `heavy` wins; otherwise a check is heavy when its name is `unit` or `coverage` or starts with `test` or `e2e` (`test`, `test-server-coverage`, `e2e-phone` heavy; `lint`, `typecheck`, `typecheck:test` not). `run` wraps every heavy check in the lock, so `gate run` and `integration check` both get it from the same checks.json. `run` stays sequential in the order given, with its first-failure short-circuit unchanged: a heavy check takes the lock when its turn comes and releases it before the next check; an unmarked check never touches the lock and reports `lock_wait_ms` 0; `runCumulative` (full epic suite) is always heavy. Lock wait is reported as `lock_wait_ms` on the check result and not counted against `timeout_ms`; a wait timeout fails that check with the holder detail.
- **The merge queue is the third heavy path** (queue.ts, T8). `bs queue run --test-cmd` (wave.md step 10, the merge-queue step) runs the cumulative suite once per task (`step`) and once per batch candidate (`batchStep`), both through queue.ts's private `runTestCmd`. `runTestCmd` runs its command under `withHeavyLock` and spawns it with `heavyChildEnv(process.env, lease)` instead of `projectCommandEnv(process.env)`. Its rules:
  - **label** `queue-<task id>` for a task, `queue-batch-<first task id>` for a batch candidate;
  - **cwd** the worktree the suite runs in;
  - **env** `process.env`, so a queue started under a lease re-enters it;
  - **lock dir** resolved as `run` resolves it: `$BS_HEAVY_LOCK_DIR`, else the default.
  - **Call sites.** Both call sites inherit the lock through `runTestCmd` and only `await` it; neither wraps it again. `StepOptions` (taken by `step` and `batchStep`) gains an optional `heavyLock` (`lockDir`, `pollMs`, `maxWaitMs`, `isPidAlive`) for tests. `queue run` passes none, so cli.ts does not change for it.
  - **Timeout.** `runTestCmd` never catches `heavy.wait-timeout` as a test failure. The error propagates out of `step` / `batchStep`. That task or batch is not merged, and the queue writes no `tests-failed` outcome and no `execution.test-failure` event for it. Tasks the run merged before it are already logged `wave-merged` and stay merged on the integration branch. A batch candidate's worktree is still removed by its existing `finally`, so the awaited lock wait sits inside that `try`.
  - **The unit-level rejection is the contract.** `cli.ts` does not change: `bs queue run` fails with that code and the holder detail only because the rejection propagates out of its handler, like any other queue error, and it prints no outcomes for the tasks it merged first (`printJson` runs after the loop). The CLI exit is not a separate test; AC10's queue.test.ts cases pin the contract. How the wave-runner resumes after such a failure is D9's (wave.md step 10).
- CLI `bs heavy run --label <l> -- <cmd...>` and `bs heavy status` (T10) for agents running the full suite or e2e outside the gate, and for a session checking who holds the lock. `bs heavy run` returns the child's exit code, and exits 75 with the holder detail on `heavy.wait-timeout`. `readChecksFile` (cli.ts, T10) refuses a `heavy` that is present and not a boolean with `gate.invalid-check-heavy`, beside `gate.invalid-check-timeout`.

### D8. Doctor caps check (T9)

#491 made `bs init` write the caps (`CONCURRENCY_CAPS` in `src/workroot.ts`: both variables, target `1000`) into the project's `.claude/settings.local.json` (a clone of this repo carries them in its tracked `.claude/settings.json` instead, and `bs init` writes nothing there). This epic only **checks** them. T9's base must contain #491; if it does not, the task stops and reports rather than restating the names.

- `installCheck.ts` gains check id `concurrency-caps`. The variable names and the target value are imported from `CONCURRENCY_CAPS`; nothing restates the strings.
- Sources, first found wins: (1) the process environment of `bs doctor`; (2) the `env` block of `<project>/.claude/settings.local.json` (where `bs init` writes); (3) the `env` block of `<project>/.claude/settings.json`; (4) the `env` block of the user settings file at #491's `defaultUserSettingsPath` (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). Why these: they are the places the Claude Code harness reads these variables from, in the same precedence. A shell rc file is not read (not parseable reliably, and it is already reflected in (1) when set).
- JSON is read with #491's reader (`readJsonObject` / `envBlock`, exported from `workroot.ts` or wrapped by a small exported `readSettingsEnv(file)`), so there is one settings parser. T9's `workroot.ts` change is export-only; `bs init` behaves as before.
- Status `unknown` (a warning — `doctorExitCode` only fails on `missing`, so doctor's exit code does not change) when either variable is unset, not an integer (a value must match `/^[0-9]+$/`; `64k`, `1e3`, `-1` are not), or not above (compared as numbers, never as strings) the harness defaults 20 (subagents) / 10 (tool calls), two named constants in installCheck.ts. A value above the default but below the target (e.g. 64) is `ok`: the operator chose it. Detail names the variable, its value and its source. `fix` reads, in this order: re-run `bs init` in the project and restart Claude Code (it writes the target from `CONCURRENCY_CAPS`); or set both in the user settings `env` block (INSTALL.md "Raise the concurrency caps"). Unreadable or invalid JSON settings files are skipped with a note in detail, never a crash.
- `DoctorDeps` gains `env`, `home` and `readFile` so the check is pure under test.

### D9. Playbooks (T11)

- dispatch.md: "Carry into the prompt" becomes "run `bs brief compose`"; the hand-assembly list stays only as the description of what compose emits. Lessons splice section describes D2. Typed `bs-*` agents only. The `## Return discipline (agent-interviews.md M-6)` heading stays byte-identical, because compose slices it (D3).
- Every playbook that dispatches (`SKILL.md`, `run.md`, `wave.md`, `plan.md`, `audit.md`, `new.md`, `lessons.md`, others found by the doc test): independent dispatches go in one message.
- wave.md: step 6/7 — grader + reviewer + security in one message after the tester; the gate runs in the background (`run_in_background`) while the runner prepares the next step; waits are background tasks or the Monitor tool, never `sleep` loops; full-suite/e2e runs go through `bs heavy run` as the heavy-run fragment says, never around a verb that takes the lock itself; checks.json marks a heavy check with `"heavy": true` and the D7 name defaults apply otherwise. Each step names its `bs playbook slice` command; the step numbering (top-level `N. ` items 2-10) stays, so the slicer test stays green.
- **wave.md step 10, the merge queue.** D9 owns the wave-runner side of D7's timeout; D7 owns only the queue's contract.
  - `bs queue run` runs as a background task (`run_in_background`), and the runner waits on its completion notification or the Monitor tool. Its lock wait can last up to `maxWaitMs` (1 h by default), past the 10-minute cap of a foreground Bash call, and a foreground call killed at that cap would look like a real timeout.
  - When `bs queue run` fails (e.g. `heavy.wait-timeout`), it has printed no outcomes, so the runner reads the session's `wave-merged` events (`bs event tail <session-id>`, `payload.task_ids`), rebuilds `tasks.json` from the tasks not named there, and never re-queues a merged task: the queue would find no commit ahead (`certifyCommit`, `branch-not-advanced`) and log it `nothing-to-merge` with a blocked event. The runner reports the lock holder the error names, then re-runs once that holder is gone (`bs heavy status` no longer names it), or escalates to the epic session.
- `bs-wave-runner.md`: read the two common sections once per wave (`bs playbook slice wave --section ...`, D4) and `bs playbook slice wave --step <n>` for the current step only, never the whole of wave.md or dispatch.md; never Read PNGs (screenshots are the uiux/tester's to read; the runner passes paths). Its `tools` line gains `TaskStop` and `Monitor` (D10, D4).
- **Heavy runs in the agent templates.** The agents that run suites are the ones that must take the lock, so the rule lives in their templates. It is worded once, as the shared fragment `.claude/fragments/heavy-run.md`, and stamped by `node scripts/sync-shared-fragments.mjs` into the eleven templates that run a suite: bs-auditor, bs-coder, bs-grader, bs-merger, bs-reviewer, bs-security-reviewer, bs-spec-reviewer, bs-tester, bs-uiux, bs-verifier, bs-wave-runner. bs-planner and bs-researcher hold Bash but run no suite; bs-scribe has no Bash.
  - **The rule:** a full-suite or e2e command (the project's `test_unit` or `test_e2e` from `bs stack show`, a full-suite gate command the brief names, or a check `isHeavyCheck` marks heavy) runs as `bs heavy run --label <task-id>-<role> -- <cmd>`. `bs gate run`, `bs integration check` and `bs queue run` take the lock themselves and are never wrapped. Exit 75 is `heavy.wait-timeout`: the agent puts the holder it names in its result and does not retry blind. A scoped run of the agent's own new test file runs directly.
  - **One home:** composeBrief adds no copy (D3), and wave.md only points at it. templateFragments.test.ts lists `heavy-run` and its eleven carriers.
- run.md: rolling admission (D6); the cleanup step and the epic-close TaskStop rule (D10).
- INSTALL.md: "Raise the concurrency caps" names `bs doctor`'s `concurrency-caps` warning and says `bs init` writes the caps (a doc test pins both).
- CHANGELOG `## Unreleased`: one entry per user-visible change, `bs cleanup` included.

### D10. Cleanup (T12, T10, T11)

Why: worktrees and branches pile up. Measured on 2026-10-21: one project had 59 registered worktrees but 77 directories under its `.wt` folder (~18 orphans), and 50 of its 59 `bs/*` branches were already merged into main; two other projects' `.wt` folders held 26 and 124 entries. Why a CLI verb plus playbook steps and not an agent: removal must be deterministic and testable, and only the session that started a background task or subagent can see and stop it.

**Module (T12): `src/cleanup.ts`.** `planCleanup(opts)` builds the report; `runCleanup(opts)` runs it, a dry run unless `apply`. With `apply`, `runCleanup` builds the list itself in the same run that removes; no list is ever read from a file or an earlier run.

- **Report:** JSON, one item per candidate. Each item carries `kind`, path and/or branch, `action` (`remove`, `trash`, `prune`, `keep`, `manual`) and a `reason`. Every `keep` names the rule that kept it.
- **Inputs:**
  - `--project <dir>`.
  - `--epic <id>` (optional): limits worktree and branch targets to that epic. Orphan directories and the prune are project-wide in every run.
  - `--apply`.
  - The module also takes the event store's events, `now`, and injectable deps: git runner, fs, `isPidAlive` (default: T8's `pidIsAlive`, where only `ESRCH` means dead and `EPERM` or any other error means alive), `trash`, `platform`, heavy-lock dir.
- **Targets:**
  1. Registered worktrees on `bs/<epic>/<task>` branches (legacy `smith/` too), together with those branches. A task branch qualifies when it is merged into the epic's integration branch or into the default branch (`git merge-base --is-ancestor`).
  2. Directories under `<parent>/.wt/<project>/` that git does not register: their `.git` file points into this project's git dir, or they have no `.git` entry.
  3. `git worktree prune`.
- **Left alone:** detached or other registered worktrees, such as read-only previews.
- **Epic state:**
  - An `epic-closed` event closes an epic (`readClosedEpicWidths`, src/epicWidth.ts).
  - An epic named by events with no close is open.
  - An epic with no events counts as closed only when its integration branch is an ancestor of the default branch. Otherwise it is kept (`epic-unrecorded`).
- **No fetch:** merge checks read the local `<default>` and `origin/<default>` refs; `bs cleanup` never fetches. Before it runs, the run.md step does `git fetch --prune origin`.

**Safety rules — each one is a test in `cleanup.test.ts`:**

1. Skip anything active in the last **24 h**: the newest of the branch's last commit time, the worktree's index mtime, and the newest file mtime found by walking the tree without following symlinks. The walk stops at the first entry newer than 24 h (the item is active) and after 20,000 entries (the item is kept, `walk-capped`); an `EACCES` or `ENOENT` during the walk keeps the item (`unreadable`, with the path).
2. Skip every task of an open epic. Never remove an integration branch or its worktree before its PR merged, i.e. before the branch is an ancestor of the default branch.
3. Skip dirty worktrees (`git status --porcelain` non-empty) and report them.
4. Skip any worktree, directory or branch whose name contains `harness-codex-dispatch`.
5. Respect locks unless the lock records a pid that is dead:
   - the T8 heavy lock (`readHeavyLock`) when its cwd is inside the item;
   - git `index.lock`;
   - a worktree marked `locked`.

   A lock with no pid is always respected.
6. When unsure, keep the item and report why (an unreadable mtime, an unparseable lock, an unknown epic state).
7. Build the removal list in the same run that removes.
8. Delete only through these paths:
   - `git worktree remove`, without `--force` (git itself then refuses a dirty tree);
   - `git branch -d`, never `-D`, and only after rule 12's merge gate (a `-d` refusal is reported as `keep` with git's message);
   - `git worktree prune`;
   - for non-git directories on macOS, `/usr/bin/trash`. On any other platform such a directory is reported `manual` and nothing is removed.

   Never `rm -rf`.
9. Never touch a path outside `<parent>/.wt/<project>/` (checked with realpath), and never a branch outside the project's own `bs/` / `smith/` prefixes. Containment compares the realpath of the candidate with the realpath of the root, so a root that is itself a symlink is resolved first. An entry under the root that is a symlink is kept (`symlink`): never followed, trashed or removed.
10. Kill no process.
11. A directory holding its own `.git` *directory* is an independent repository: it is kept (`independent-repo`).
12. **Merge gate.** Immediately before each worktree removal and each branch deletion, `git merge-base --is-ancestor <branch> <target>` is re-run against the item's targets: the epic's integration branch, local `<default>`, `origin/<default>`. Merged into any one counts (each is landed history); when none holds, the item is kept (`not-merged`). This gate, not `git branch -d`, is the safety: `-d` checks only against the current HEAD or the upstream, so a main clone checked out on a non-default branch that contains the task branch would let `-d` delete unmerged work. The main clone's checked-out branch never decides whether something is merged. Order per worktree item: gate, `git worktree remove`, gate again, `git branch -d`. Work that lands after a gate is never lost: an uncommitted edit makes `git worktree remove` (no `--force`) refuse, and a commit made after the first gate fails the second, so the branch that holds it is kept. A removal or deletion that fails is reported as `keep` with git's message; it is never retried, forced, or followed by the branch deletion.

**Reuse.** `src/worktree.ts` (T12):

- export `detectDefaultBranch`;
- export `parseWorktreePorcelain`, extended to read `locked`, `detached` and `prunable` (each a bare line or the keyword plus a reason). A `locked` worktree is always kept: git's lock reason is free text and is never read for a pid, so it is a lock with no pid under rule 5. A `prunable` entry is left to `git worktree prune` and never passed to `git worktree remove`;
- `removeTaskWorktree` (already `git worktree remove` + `git branch -d`, no force) keeps working for its existing callers.

A non-git `--project` raises `cleanup.not-a-git-repo`.

**CLI (T10):** `bs cleanup --project <dir> [--epic <id>] [--apply]` is a thin call into `runCleanup` with the store's events. It prints the JSON report.

**Playbooks (T11):**

- **run.md, after step 17 (integration PR), a new step — cleanup:**
  1. Run `git fetch --prune origin`.
  2. Dry-run `bs cleanup --project <dir> --epic <id>`, then run it with `--apply`.
  3. Run the same dry-run/apply pair unscoped (`bs cleanup --project <dir>`) to pick up earlier epics' leftovers.
  4. Report what was removed and what was kept, and why.

  This epic's integration branch and its worktree stay, because the PR has not merged. They are removed by the next epic's close step (its unscoped pass) or by any later `bs cleanup --project <dir> --apply`, once the branch is an ancestor of the default branch. The playbook never tells an agent to delete by hand.
- **TaskStop at close and wave end:** the epic session at close (run.md), and the wave-runner at wave end (wave.md, `bs-wave-runner.md`), stop their own still-running background tasks and idle subagents (handed back, not being resumed) with TaskStop. Before stopping a background task, both of these must hold:
  - every output file the task was told to write ends with an `EXIT=<n>` line;
  - the task does not hold the heavy lock (`bs heavy status` names no holder whose label or cwd is that task's).

  Otherwise the session leaves the task running and says so. A session never stops a task it did not start.

## Acceptance criteria

Each criterion is testable and names the task(s) that own it. "Gate" below = the four commands every task runs from the repo root on its own tree, read to the end: `pnpm run test` (full root suite), `pnpm run typecheck`, `pnpm run typecheck:test`, `pnpm biome check .`.

1. **AC1 — class field (T1).** A lesson raised with `error_class: execution.flaky-test` round-trips raise -> store row -> `lessons compile` -> `lessons.md` bullet -> `parseLessons`; so does one raised with `other.unclassified`. Raising `execution.no-such-class` is refused and the error names `execution.no-such-class`. Recompiling a `lessons.md` whose entry carries a class its store row lacks keeps the class. taxonomy.yml carries `other: [unclassified]` at the base's version + 1 (12 on the preview base), mirrored in the architecture doc (taxonomy.test.ts passes). The new migration (next free number) applies on a fresh store and on one at the previous migration; every pre-existing `drizzle/*.sql` file is byte-identical.
2. **AC2 — backfill (T3).** Every one of the lesson entries in `factory/policies/lessons.md` carries exactly one `error_class` that is a class in taxonomy `error` (read from taxonomy.yml by the test), `other.unclassified` where no specific class fits; there is no list of exempt ids. No statement text changes (test compares statements against the pre-task file). The test's id list equals the file's lesson ids (the `## Schema` examples are not entries), and the D1 spot checks hold.
3. **AC3 — selection (T2).** With fixtures:
   - a classified stack-wide lesson whose class has 3 `error-logged` events on distinct tasks within 30 days is spliced;
   - with 2 such events store-wide and none in the epic it is withheld and named in the trailing line;
   - an event older than 30 days does not count;
   - store-wide is every session: a class on 2 tasks in session A and 1 task in session B within 30 days recurs (`readRecurrenceEvents` over a temporary state dir with two session files); a session file older than the window is not opened, and an event appended through `appendEvent` has a `ts` no later than its session file's mtime (the invariant that skip rests on, D2);
   - an event's epic is `payload.epic_id`, else the epic of its task (`eventTaskId(record) ?? payload.task_ref`, D2): an event of another epic is not a repeat, `payload.epic_id` wins over the task id's epic, and with no epic given nothing is;
   - an event carrying only the envelope `task_id` (no `payload.task_ref`) is counted, under that task id's epic; three events of one class on the same task are one task, not a recurrence; an event with no task identity is skipped; every fixture is an envelope `event.schema.json` accepts (no envelope `epic_id`);
   - the same lesson is spliced once its class has 1 `error-logged` in the dispatch's epic;
   - an `other.unclassified` lesson is withheld without recurrence or repeat, and spliced on either;
   - a lesson with no class, or with a class missing from taxonomy.yml, is read as `other.unclassified` and the result carries a warning naming it;
   - agent-role and claim-path lessons are never withheld;
   - a security-reviewer brief withholds nothing, of any scope; any other role's brief withholds a non-recurring `security`-scope lesson.
4. **AC4 — output weight (T2, T10).** `bs lessons for-dispatch` without `--full` omits the `lessons` array; `--class <c>` returns exactly that class; on the checked-in `lessons.md` with an empty event store, a coder for-dispatch on claim `factory/orchestrator/src/**` splices at most half the lessons-block bytes of the same call with every class treated as recurring (the pre-epic set; baseline ~22 KB). With `BS_HOME` pointing at a temporary store whose two sessions put one class on 3 distinct tasks, that class's lessons are spliced; `--epic <id>` turns on the repeat count. Moves: splice bytes per brief, for-dispatch output size.
5. **AC5 — brief compose (T4, T10).** `bs brief compose` for a coder, a tester, a grader and a reviewer on a fixture plan emits briefs that each give `lintDispatchPrompt` `exitCode: 0` (the grader's and reviewer's judge turns recorded first in a temporary store, with the same artifacts the briefs declare), carry the marker, the absolute worktree path, the spec entry verbatim, `Turn budget:` equal to the role template's `maxTurns` (a differing caller value fails `brief.turns-mismatch`; a grader brief without its ledger turn fails the lint), and the D2 lessons block; the grader/reviewer briefs carry `Declared artifact:` and the coder brief does not; missing worktree / unknown task / judge without artifact each fail with a named error. The manifest lists every spliced and withheld lesson id. Each brief carries dispatch.md's `## Return discipline (agent-interviews.md M-6)` section exactly as `sliceSection` cuts it from the real file, and an envelope line naming every `ORCHESTRATOR_OWNED_RESULT_FIELDS` member (imported by the test, not restated); a `dispatchDoc` with that heading renamed fails `playbook.unknown-section`.
6. **AC6 — diet guards (T5).** In every session (no case reads a session or operator identity):
   - the Agent hook denies a marked brief sent to `general-purpose` or to a different `bs-<role>`, with a reason naming the rule and "dispatch to the matching `bs-<role>`" with the expected type spelled out;
   - it allows the matching type (both prefix forms) and leaves unmarked briefs unchanged, including a marker on line 2, inside a fence, or naming an unknown role;
   - the Bash hook gives every row of the D4 verdict table its verdict, one test per row; each deny reason names the rule, the duration (or `unknown`) and "use a background task or the Monitor tool instead of `sleep`";
   - failure rule: with the parsers forced to throw, and on malformed payloads (non-string, empty, 1 MB, unbalanced quotes, unterminated `$(`), no call gets a diet deny, unrelated calls get today's decision, and `decideHookPayload` does not throw.

   Moves: orchestrator share, foreground sleeps.
7. **AC7 — slices (T5, T10, T11).** `bs playbook slice wave --step 4` prints wave.md from the line `4. ` up to, not including, the line `5. `; steps 1 and 11 fail `playbook.unknown-step`; the dispatch.md section "Fingerprint the worktree around every judge ..." keeps its fenced `# ...` lines and ends before the next `##`; an unknown section fails `playbook.unknown-section`, a duplicated one `playbook.ambiguous-section`; `bs-wave-runner.md` tells the runner to read slices only and never Read a PNG (doc test). Moves: wave-runner read bytes.
8. **AC8 — judges in one message (T6, T11).** Tests prove three judges dispatched in one round on one task keep distinct artifacts/fingerprints and count one round each in all 6 arrival orders; one judge's report does not close another's turn; preflight in parallel equals serial; a grader bounce leaves the reviewer's S2 finding `raised` for the verifier and the bounce brief; the round count is epic-wide across sessions. The task result names any case that failed before the change. wave.md says the three go in one message (doc test). Moves: serial judge rounds.
9. **AC9 — rolling admission (T7, T10, T11).** Reproduction test: admit task A, `plan ingest` (A reads `todo` in the plan file), `wave next` does not return A; `wave check` on A fails `wave.in-flight`; a task B whose dependency merged while C is still in flight is returned by `wave next`. A stays in flight after a bounce, a re-dispatch and a failed agent run, and leaves on `wave-merged`, `task-superseded` or `epic-closed` (one test each). run.md documents rolling admission. Moves: waves with one task, merge -> next admit.
10. **AC10 — heavy queue (T8, T10).** One test per D7 rule, each on a temporary lock dir:
    - two concurrent holders never overlap (recorded intervals); two waiters racing to reclaim one dead lock never both run;
    - a dead-pid lock and an empty or unparseable lock are reclaimed; a live pid is never stolen however old, and the waiter fails `heavy.wait-timeout` naming holder and lock path without running `fn`;
    - a lock whose probe throws `EPERM` (injected `kill`) is kept, never reclaimed; `ESRCH` reclaims it; `pidIsAlive` reads no throw, `EPERM` and any other code as alive and only `ESRCH` as dead;
    - a nested call carrying the holder's token runs at once; a different token waits; release happens after `fn` throws;
    - under a non-default lock dir, the child of a heavy check sees `BS_HEAVY_LOCK_TOKEN` and that `BS_HEAVY_LOCK_DIR`, and no other `BS_`/`SMITH_` variable; a nested `withHeavyLock` given only that child env (no `lockDir` option) runs at once and creates no lock file under the default dir; inside the suite `BS_HEAVY_LOCK_DIR` is a temporary dir and `BS_HEAVY_LOCK_TOKEN` is unset (setup.ts);
    - the default dir is `$BS_HEAVY_LOCK_DIR`, else `~/.blacksmith/locks`;
    - `readHeavyLock` / `bs heavy status` report the holder's pid, label, start time and cwd while held and nothing after release;
    - `isHeavyCheck` table (explicit flag wins; `test*`, `unit`, `coverage`, `e2e*` heavy; `lint`, `typecheck*` not); while another holder has the lock, a `run` of only unmarked checks (`lint`, `typecheck`) completes without waiting and each reports `lock_wait_ms` 0, and a `run` of `[lint, test]` runs in that order: `lint` at once (`lock_wait_ms` 0), then `test` waits for the release; the wait shows as `lock_wait_ms` and not against `timeout_ms`; `runCumulative` takes the lock;
    - the merge queue (`runTestCmd`, in queue.test.ts): a `step` and a `batchStep` whose test command copies `$BS_HEAVY_LOCK_DIR/heavy.lock` to a file see the lock held with label `queue-<task id>` / `queue-batch-<first task id>` and its token in `BS_HEAVY_LOCK_TOKEN`, and no lock is left after; while another holder has the lock, `step`'s command has not run (its marker file is absent) until the release, then the task merges; at a small `maxWaitMs`, with an `events` sink passed (without one `step` logs nothing, so a missing event proves nothing): `step` rejects with `heavy.wait-timeout`, its command never ran, there is no `tests-failed` outcome and the sink holds no `execution.test-failure` event; `batchStep` rejects with `heavy.wait-timeout` and leaves no candidate worktree behind (none in `git worktree list`, no `batch-*` directory: the `finally` ran); two tasks in order, task 1 merges and logs `wave-merged` into the sink, task 2's lock wait times out and rejects, and task 1 stays merged on the integration branch. `pollMs` and `isPidAlive` are injected; no real suite and no long sleep runs. The `bs queue run` exit is not a separate test (D7);
    - `bs heavy run -- node -e "..."` runs the command under the lock and returns its exit code, and exits 75 on a wait timeout; `bs heavy run` nested inside `bs heavy run` under a temporary `BS_HEAVY_LOCK_DIR` and a temporary HOME returns the inner exit code without waiting and leaves no lock file under `$HOME/.blacksmith/locks`; `gate run` on `"heavy": "false"` fails `gate.invalid-check-heavy`.
11. **AC11 — doctor caps (T9).** The test imports `CONCURRENCY_CAPS` rather than restating names or values.
    - With every source unset, `concurrency-caps` is `unknown`, the fix names re-running `bs init` and restarting Claude Code before the user-settings route, and doctor's exit code is unchanged.
    - Process env at the `CONCURRENCY_CAPS` target -> `ok`; process env 64/32 -> `ok`; `100` beats 20 as a number; `64k` or `1e3` -> `unknown` naming the value.
    - Only user settings at 20/10 -> `unknown` (not above). `$CLAUDE_CONFIG_DIR` moves the user settings path.
    - Precedence: project `settings.local.json` beats `settings.json`, which beats user settings.
    - Invalid JSON is skipped with a note, not thrown.
    - Existing workroot (`bs init`) tests pass unchanged.
12. **AC12 — playbooks (T11).** Doc tests pin: dispatch.md names `bs brief compose` as the way to build a brief; every dispatching playbook carries the one-message batching rule; wave.md says the gate runs in the background and waits are background tasks or the Monitor tool; no playbook tells an agent to `sleep`; typed `bs-*` agents only; every verb named exists (docCommands). CHANGELOG `## Unreleased` has an entry per feature. INSTALL.md's "Raise the concurrency caps" names the `concurrency-caps` warning and that `bs init` writes the caps. wave.md documents the checks.json `heavy` field and its name defaults. wave.md step 10 (pinned on its `sliceWaveStep` cut) says `bs queue run` runs as a background task, and that after it fails (e.g. `heavy.wait-timeout`) the runner reads the session's `wave-merged` events, rebuilds `tasks.json` from the tasks not yet merged, never re-queues a merged task, reports the holder the error names, and re-runs once it is gone or escalates to the epic session (D9). No foreign project name appears. The heavy-run rule (D9): `.claude/fragments/heavy-run.md` holds `bs heavy run --label`, exit 75 / `heavy.wait-timeout` with no blind retry, the `bs gate run` / `bs integration check` / `bs queue run` exclusion and the scoped-run exemption; it is stamped into the eleven suite-running templates (templateFragments.test.ts lists `heavy-run` and its carriers); playbookOptimize.test.ts fails when a Bash-holding template other than bs-planner and bs-researcher, or any template that says "run the suite", "full suite", "regression gate", `test_unit` or `test_e2e`, lacks the `heavy-run` region. dispatch.md keeps the `## Return discipline (agent-interviews.md M-6)` heading.
13. **AC13 — quality floor (all).** No judge, round, verifier pass or gate check is removed or made conditional by this epic (reviewed at each grader round); every task's gate is green.
14. **AC14 — cleanup verb (T12, T10).**
    - `cleanup.test.ts` has one test per D10 safety rule, using temporary git repos with real worktrees and injected `platform`, `trash`, `isPidAlive` and `now`. The rules: 24 h activity from each of the three sources; open epic kept; integration branch kept until merged into the default branch; dirty kept and reported; `harness-codex-dispatch` kept; heavy lock with a live pid kept and with a dead pid ignored; `index.lock` and git `locked` kept; dry run changes nothing; `--apply` rebuilds the list; the merge gate keeps an unmerged task branch, including when the main clone is checked out on a non-default branch that contains it; the 24 h walk stops at the first recent entry, keeps a tree past 20,000 entries (`walk-capped`) and keeps an unreadable one (`unreadable`); nothing outside `.wt/<project>/` touched; independent repository kept.
    - Rule 9, rule 12 and the porcelain reader also have one test each: a symlinked `.wt/<project>` root is resolved and a symlink entry pointing out of it is kept, not followed; an uncommitted edit made after the gate (injected git runner) makes `git worktree remove` refuse, the item is reported `keep` and its branch is not deleted; a commit made after the first gate fails the second; `locked` (bare and with a reason) and `prunable` lines parse, a `locked` worktree is kept and a `prunable` one is only pruned; a heavy lock whose holder's probe throws `EPERM` keeps the item.
    - It also has one test per D10 edge case below.
    - The CLI test shows: `bs cleanup --project <dir>` on a temporary repo prints a report and changes nothing; `--apply` removes a merged, idle task worktree of a closed epic and its branch; a non-git `--project` fails with `cleanup.not-a-git-repo`.
15. **AC15 — cleanup and TaskStop in the playbooks (T11).** Doc tests pin:
    - run.md's cleanup step comes after the integration-PR step, does a dry run before `--apply` (scoped, then unscoped), reports removed and kept items with reasons, says the integration branch stays until its PR merges and how it is cleaned later, and names no hand deletion;
    - the TaskStop rule appears in run.md (epic close), wave.md and `bs-wave-runner.md` (wave end), with the `EXIT=<n>` check, the heavy-lock check and "own tasks only";
    - `bs-wave-runner.md`'s tools list names `TaskStop` and `Monitor`;
    - CHANGELOG `## Unreleased` has the `bs cleanup` entry.

## Out of scope / non-goals

- L1 (1 h cache TTL) — merged in #489. L5 (any quality-for-tokens trade) — rejected.
- A model switch for any role. Finer task splitting. A 0.6.0 bump or release.
- Inventing any taxonomy class other than the approved `other.unclassified` (`Other`).
- Re-measuring the baseline (decision 8).
- Writing the harness caps (#491's `bs init` does that; this epic only checks them).
- Dashboard / UI changes. Every task is `ui_affecting: false`.
- Cleaning anything outside a project's own `.wt/<project>/` folder and branches: other repositories, `state/` folders, the event store, and remote branches.

## Edge cases

- Lesson whose class is later removed from taxonomy: compile keeps the bullet; selection reads it as `other.unclassified` (spliced only on recurrence or repeat) and `lessons for-dispatch` adds a warning naming the lesson and the stale class.
- Event store empty (fresh install): no class recurs, so only role + claim-path lessons splice, and the trailing line names every withheld class.
- `error-logged` events with no task identity (no envelope or payload `task_id`, no `payload.task_ref`): skipped, counted toward no class (D2); with one, distinct per task.
- Two sessions on one machine both at the gate or the merge queue, or one at each: the heavy lock serializes them; neither fails.
- Heavy lock held by a live pid past `maxWaitMs` (a hung suite, or a reused pid): the waiter fails `heavy.wait-timeout` naming the holder and the lock file; the lock is never stolen.
- `bs queue run` fails mid-run on `heavy.wait-timeout`: the tasks it merged first stay merged and logged `wave-merged`; the wave-runner re-queues only the rest (D9).
- A diet rule meets a command it cannot parse: no diet match; the existing hook path decides (D4 failure rule).
- Hook running without a marker (old briefs, hand dispatches): unchanged behaviour.
- `plan ingest` mid-wave: in-flight tasks stay occupied (D6).
- Settings files absent: doctor reports the variable as unset, not an error.
- **Cleanup — worktree directory exists but its branch is deleted:**
  - unregistered (its admin dir pruned): an orphan, moved to the Trash once idle 24 h on macOS, `manual` elsewhere (git cannot check an orphan for dirt; the 24 h rule and a recoverable Trash are the guard);
  - still registered with its branch ref missing: kept (`branch-missing`).
- **Cleanup — branch with no worktree:** a merged `bs/<epic>/<task>` branch of a closed epic is deleted with `git branch -d`; an unmerged one is kept and reported.
- **Cleanup — no `.wt` folder:** no orphan scan; branches and prune still run; the report says the folder is missing.
- **Cleanup — non-git project dir:** `cleanup.not-a-git-repo`, non-zero exit, nothing touched.
- **Cleanup — Linux (no Trash):** worktree and branch removal work as on macOS through git; orphan directories are reported `manual` and nothing is removed.
- **Cleanup — task branch merged into integration but not yet into main:** `git branch -d` may refuse. The worktree is removed (if idle and clean), the branch is kept and reported, and it goes on a later run after the integration PR merges.

## Claims map and round shape

| Task | Claims (abridged) | Depends on |
|---|---|---|
| T1 lesson-class-field | taxonomy.yml, architecture doc §8, taxonomy.test.ts, lesson.schema.json, db/schema.ts, drizzle (next free migration) + meta, db/projector.ts, severity.ts, lessons.ts, policies/lessons.md (header only) | — |
| T5 diet-guards | briefMarker.ts, hookDecision.ts, playbookSlice.ts | — |
| T6 concurrent-judges | judges.ts, judgePreflight.ts | — |
| T7 rolling-admission | admission.ts, waveNext.ts | — |
| T8 heavy-queue | heavyLock.ts, testgate.ts (`heavyChildEnv`), queue.ts (`runTestCmd`), queue.test.ts, test/setup.ts | — |
| T9 doctor-caps | installCheck.ts, workroot.ts (export-only), doctor tests | — |
| T2 lessons-by-class | lessonRecurrence.ts, lessonEvents.ts, lessons.ts | T1 |
| T3 lessons-backfill | policies/lessons.md | T1 |
| T12 cleanup | cleanup.ts, worktree.ts, cleanup/worktree tests | T8 |
| T4 brief-compose | briefCompose.ts | T2, T5 |
| T10 cli-hookup | cli.ts, usage.ts, cliOptimize/usage tests | T1, T2, T3, T4, T5, T7, T8, T9, T12 |
| T11 playbooks | .claude/skills/bs/*.md, the eleven suite-running agent templates (bs-wave-runner.md among them), .claude/fragments/heavy-run.md, templateFragments.test.ts, INSTALL.md, CHANGELOG.md, playbookSlice.test.ts | T6, T10 |

**Rounds:**

| Round | Tasks |
|---|---|
| 1 | T1, T5, T6, T7, T8, T9 (six wide) |
| 2 | T12, T2, T3 |
| 3 | T4 |
| 4 | T10 |
| 5 | T11 |

Why the shape:

- **cli.ts / usage.ts are hubs** (`serialize-always`). Every verb, `bs cleanup` and `bs heavy status` included, lands in T10 alone. That is why module tasks export functions that are tested directly, and T10 only wires them.
- **taxonomy.yml is a hub** claimed by T1 alone.
- **T12 waits on T8** because it reads the heavy lock through T8's `readHeavyLock` and takes T8's `pidIsAlive` as its default liveness probe.
- **T11 is last**, because docCommands fails a doc that names a verb that does not exist yet. That is also why the heavy-run fragment is T11's: docCommands scans the agent templates, and the fragment names `bs heavy run`, which exists only after T10.
- **The epic's own gates stay a bare `pnpm run test`.** `bs heavy run` does not exist until T8 and T10 merge, so no task's gate criterion names it.

**Read back from the project** (main clone `479e2a0f`, 2026-10-22, round 8, unchanged from round 6, which took claims 75 -> 77 and promised crossings 12 -> 15 with T8's queue.ts and queue.test.ts; rounds 7 and 8 changed no claim or edge):

- `bs claims impact` on all 12 ids -> `clean`, 0 unpromised crossings, 15 crossings on `keeps_exports` promises:
  - into cli.ts: T1, T5, T6, T7, T8 (testgate.ts, queue.ts), T9, T12;
  - T12 `worktree.ts` -> `db/projector.ts`, `queue.ts`, `queue.test.ts`;
  - T6 -> `dispatchLint.test.ts`.
- `bs wave schedule` -> depth 5, widest 6, size `{"tasks":12,"claims":77,"small":false}`.
- `claimsWithoutFiles`: T2, T3, T4 (their new files do not exist yet). Planned imports the analysis cannot see: T4's test -> judges.ts `recordJudgeDispatch` (existing export, under T6's `keeps_exports` promise); T4 -> agentsSync.ts and dispatchLint.ts, T2 `lessonEvents.ts` and `lessonRecurrence.ts` -> events.ts (`eventTaskId`) and taskId.ts (all unclaimed); T10 -> `lessonEvents.ts` (edge T2 -> T10); T12 `cleanup.ts` -> heavyLock.ts (`readHeavyLock`, `pidIsAlive`; edge T8 -> T12); T4 `briefCompose.ts` -> playbookSlice.ts (`sliceSection`; edge T5 -> T4) and results.ts (`ORCHESTRATOR_OWNED_RESULT_FIELDS`, unclaimed); T10 cli.ts -> testgate.ts `heavyChildEnv` (new export; edge T8 -> T10).
- Not analyzed: the main clone has no `installCheck.ts`, and its `workroot.ts` predates #491 (no `CONCURRENCY_CAPS`), so T9's import edges into installCheck.ts and into #491's workroot.ts additions were not analyzed; workroot.ts's existing exports were (the T9 crossing into cli.ts).

AC4's byte comparison is self-contained: the test renders the same call once with class selection and once with every class treated as recurring (the pre-epic set) and asserts the first is at most half the second.

**Fresh `claims impact` once bs-review lands, before T10 is admitted.** Re-run on the stacked base at early start (2026-10-22): status clean, 15 promised, depth 5 / widest 6. bs-review touches these files, or they are hubs it may reshape:

- T10: cli.ts, usage.ts;
- T11: dispatch.md, SKILL.md, wave.md, run.md, CHANGELOG.md, INSTALL.md, and any agent template or fragment bs-review rewords (the sync script restamps the regions);
- T9: installCheck.ts, workroot.ts, doctor tests;
- T5: hookDecision.ts;
- T1: db/schema.ts; the migration number and the taxonomy version are read at coding time (D1), so a base that moved on needs no plan change;
- T6: judges.ts, judgePreflight.ts.

Before T10 is admitted, re-run `bs claims impact --plan plan-v1.json <all ids> --repo <project>` and `bs wave schedule` on the base with bs-review merged.

## Operator answers (round 2)

- **Q1 — lessons that fit no class:** class `Other`. The key is `other.unclassified` (decision 13), added by T1. T3 classifies all 115 entries. `Other` lessons are spliced only on recurrence or repeat. A removed class falls back to `Other` with a warning.
- **Q2 — thresholds:** recur = 3 or more `error-logged` on distinct tasks within 30 days, store-wide; repeat = 1 in the epic (decision 14).
- **Q3 — hook scope:** deny in every session, the operator's own included. The deny reasons name the rule and the fix. The exemptions are sleep under 2 s, sleep inside a script, backgrounded sleep, and unmarked briefs (decision 15).
- **Cleanup:** `bs cleanup` (T12, T10), the run.md cleanup step and the TaskStop rules (T11) (decision 16).

No open questions remain.

## Status

- T1 – T12: todo.

## Closing review (plan v5) — changes

- f-bs-optimize/integration-aae952a5 — fixed by task-13 (`bs-optimize/task-13-slice-citations`): D4's `sliceSection` keeps exact match first and also accepts a heading's name without its trailing parenthetical when exactly one heading has that name (ambiguity still refused); `playbook.unknown-section` lists the playbook's sections. Every wave.md step citation becomes a `bs playbook slice dispatch --section "<name>"` that resolves: step 8's "Dispatch contract" becomes the two splice sections, and step 3's short name becomes the full name. The runner template's payload-contract pointer becomes the slice command for "The task id goes on the event, not in the payload". A drift guard (`playbookCitations.test.ts`) resolves every quoted citation in wave.md, dispatch.md and bs-wave-runner.md, and every citation into those two playbooks from any skill or agent file. Its scope is the two playbooks the slice verb serves, because the wave-runner is the only slice-only reader. Runs after task-14 and task-15, which share bs-wave-runner.md and wave.md with it.
- f-bs-optimize/integration-dcc5330f — fixed by task-14 (`bs-optimize/task-14-heavy-run-wait`): D9's heavy-run rule changes. A carrier starts the full suite or e2e in the background as `bs heavy run --label <task-id>-<role> -- <cmd>`, redirected to `<out>` with `; echo EXIT=$?`, and waits with the new read-only `bs heavy wait --file <out>`. The wait exits the run's code, so 75 is still `heavy.wait-timeout`, or exits 124 with `"done": false` once its own bound passes. The bound defaults to 540 s and anything above 570 s is refused, so no foreground call reaches the 600 s cap. `bs heavy run`, its 1 h default lock wait, and the lock held for the whole run are unchanged. The fragment is restamped into all eleven carriers, and a test proves the documented commands pass the diet hook and the judge sandbox.
- f-bs-optimize/integration-a2f0a33f — fixed by task-15 (`bs-optimize/task-15-queue-landing`): D7's merge-queue `step` now holds the heavy lock from certify-and-rebase through its merge, so queue runs take turns. It lands only on the integration head its suite ran on, and otherwise reports `integration-moved` with nothing landed; the batch path already landed this way. For D6, run.md drops "one wave at a time" and names the epic session as the only session that admits: after each `bs queue run` it ran returns `merged`, or at a dispatched runner's hand-back. wave.md step 10 says the queue takes turns and what `integration-moved` means. A deterministic test reproduces the verifier's interleaving.
- f-bs-optimize/integration-1e75d554 — fixed by task-16 (`bs-optimize/task-16-sleep-operands`): D4's duration rule reads each `sleep` operand the way strtod does (exponent, hex, a leading `+`, `inf`/`infinity`), followed by at most one `s`/`m`/`h`/`d`. An operand the reader cannot read is unknown length (deny), not an instant error. `sleep` with no operand stays allowed. policy.ts `PREFIX_OPERAND_RE` (factory/orchestrator/src/policy.ts:2301) has the same plain-decimal reader for prefix-word durations and is kept: on dc7db626 every guard rule still denied behind `timeout 1e1` / `timeout 0x10` (probed through dist/hookDecision.js).

### Pre-code review (v6 draft) — changes

1. fixed (task-14; replaces the 540 s default in the dcc5330f line above): `bs heavy wait` defaults to a 100000 ms bound, which fits the Bash tool's default 120 s timeout as written. The fragment shows `--max-wait-ms 540000` only beside a Bash `timeout` of 600000. A test imports the default (at most 110000) and fails by name on any fragment wait call whose bound plus 30 s exceeds the tool timeout the same sentence names.
2. fixed (task-14): the start command writes the exit code with `printf '\nEXIT=%s\n' "$?"`, so the `EXIT` line stands on its own even after output with no final newline. The fragment's stop rule: two `"done": false` in a row with no lock holder mean the run is gone, and the agent reports it with the tail instead of calling again. Both are tested, the second with a start whose shell is killed before `EXIT`.
3. fixed (task-14): `<out>` is new for every run (a run number `r<n>` in the name, never reused) and lives under `state/results/`, the directory the role's own result goes to. That is outside the worktree, so neither `git add -A` nor the judge fingerprint sees it, and it is never `state/artifacts/`. A not-yet-created file reads `missing: true`, never an old `EXIT`.
4. fixed (task-14): the printed tail is the last 40 lines before the `EXIT` line, cut to at most 8192 bytes, asserted on a 50 MB file.
5. fixed (task-14): `done` is the signal and the exit code alone is not. A file ending `EXIT=124` is `done: true` with exit 124 (tested), and the fragment says so.
6. fixed (all four gate lines): the harness loads `.claude/agents/` from the main clone, whose bs-coder.md carries no heavy-run region and whose CLI has no `heavy` verbs, so every gate line now says the full suite runs as the wave brief directs. The wave brief for tasks 14, 15 and 16 must carry two things. First, the start command, sent with Bash `run_in_background: true`: `node <integration worktree>/factory/orchestrator/dist/cli.js heavy run --label <task-id>-coder -- pnpm run test > <out> 2>&1; printf '\nEXIT=%s\n' "$?" >> <out>`, with `<out>` a new absolute path for each run outside the worktree. Second, a waiter that ends each foreground call within 100 s and uses no `sleep`: a node script the epic session writes outside the repo, polling `<out>` about every 2 s for a final `EXIT=<n>` line and printing not-done at 100 s, called again while not done. Task-13, admitted after task-14 merges, may use its own tree's built `heavy wait --file <out>` instead. The brief also says never to wrap `bs gate run`, `bs integration check` or `bs queue run`.
7. fixed (task-16): the bounded test drives the operand reader with 65000-character operands under hookDecision.ts MAX_COMMAND_LENGTH (65536, line 641; longer commands throw at line 652 before any operand is read). It covers digits, digits then `x`, `1` then `e`s, and `0x` then `p`s, asserts each verdict, and requires each in under 200 ms.
8. fixed (task-16): the decimal grammar is spelled out: `5`, `5.`, `5.25`, `.5`, then an optional exponent. A lone `.` is not a number. Rows added: `sleep .5` and `sleep 1.` allow, `sleep 5.` and `sleep .5e1` deny, `sleep .` unknown. Every operand the old reader (hookDecision.ts:682) read keeps its value.
9. fixed (task-15; replaces "or at a dispatched runner's hand-back" in the a2f0a33f line above): the epic session is the only admitter, right after every landing, in every shape. A `bs-wave-runner` is dispatched as a background agent, and the epic session watches `bs event tail <session-id> --lineage --follow` (usage.ts:381-386, which follows continuations) under the Monitor tool. On each `wave-merged` it runs `bs wave next` and admits at once, as a wave of its own. A runner never admits (bs-wave-runner.md:46). When the Agent call cannot run in the background, the wave runs inline or in a session the epic session drives, never as a blocking runner. This is a run.md criterion; claims and edges are unchanged.
10. fixed (task-15): the rebase (queue.ts:261) and the `--no-ff` merge (queue.ts:359), run under the hold, get the parent env plus the lease's `BS_HEAVY_LOCK_TOKEN` and `BS_HEAVY_LOCK_DIR`, so a project hook that calls `bs heavy run` re-enters. It is tested with a `post-merge` hook and a rebase hook recording the token.
11. fixed (task-15): a moved head wins over a conflict. `step` compares heads before any merge attempt and returns `integration-moved` without throwing, even when the outside commit also conflicts; the next `step` reports `rebase-conflict`. queue.test.ts:269-303 ('throws on a tree-less merge conflict and leaves the integration ref alone') is named as replaced, by the same setup expecting `integration-moved`, the ref left at the side commit and no merge worktree left behind.

### Verification review (v6 draft) — changes

1. fixed (task-15, criterion 5; refines pre-code item 9): wave.md step 10 states the split in plain words for its slice-only reader. Admitting the wave's own passed tasks into the merge queue (`bs queue run`) is the runner's job; admitting tasks to work (`bs wave next`, `bs wave check`) is the epic session's, and the runner never runs `bs wave next` to admit. The existing "before admitting", "keep going to admission" and "Then admit into the merge queue" (wave.md:372, :385, :395) stay merge-queue admission and are qualified as such where they could be read otherwise. The pin reads both halves inside the step-10 cut, and the existing step-10 pins pass unchanged.
2. fixed (task-15, criterion 6; refines pre-code item 10): git subprocesses under the hold (the rebase, the `--no-ff` merge) get `heavyChildEnv(process.env, lease)`, the suite child's rule: the parent env minus every `BS_`/`SMITH_` variable, plus `BS_HEAVY_LOCK_TOKEN` and `BS_HEAVY_LOCK_DIR`. The hook test also asserts that a `SMITH_`/`BS_` variable from the queue's env does not reach the hook.
3. fixed (task-14, criterion 5; replaces the run number of pre-code item 3): `<out>` is the path a foreground `mktemp` prints just before each start. The template sits under `state/results/` and names the task id and role, so every run gets a new, empty file and the agent keeps no counter across runs or re-dispatches. `mktemp` is in neither of guardrails.yml's judge write lists (lines 200, 210), and the hook test covers the `mktemp` step for an unleased session and under each judge lease. The end-to-end test shows two calls give two distinct empty files, and that a wait on a fresh one is not done.
4. fixed (task-14, criterion 1): the 8192-byte cut keeps the last bytes of the last 40 lines, so a failed suite's closing summary survives. The 50 MB test asserts that the tail is a suffix of the text before the `EXIT=` line and ends with its last line.

## Closing review (plan v6) — changes

- f-bs-optimize/integration-cdcd0b23 — fixed by task-17 (`bs-optimize/task-17-heavy-wait-steer`). D9's heavy-run wait keeps its 100000 ms default, and the plain `bs heavy wait --file <out>` stays the first wait line, so pre-code item 1 still holds for the bare command. The fragment gains one steer: every wait call is a turn, so once a `"done": false` names a `"holder"`, each next call is `bs heavy wait --file <out> --max-wait-ms 540000` with a Bash `timeout` of 600000. Every not-done result also carries `"next"` with the bound and Bash timeout for the next call: 540000 / 600000 when the file exists and a holder is named, otherwise 100000 / 120000. Exit codes and the stop rule are unchanged. A run queued for heavyLock.ts's full 3600000 ms, plus a 440 s suite, then costs 9 wait calls, 11 turns with the mktemp and the start, where it cost 43 before. A test derives that count from the fragment, from heavyWait.ts and from heavyLock.ts's now-exported DEFAULT_MAX_WAIT_MS, and holds it to at most half the smallest `maxTurns` among the region's carriers (25: bs-verifier, bs-uiux; bs-merger 30). No `maxTurns` changes. No carrier drops the fragment, because every Bash-holding judge template says `Bash` is there to run the suite (bs-verifier.md:22, bs-uiux.md:28).
- Refuted by the adversarial verifiers; do not re-raise: f-bs-optimize/integration-a30547de (a third `integration-moved` catch on the `--batch` path, pre-existing since #191 and out of scope), f-bs-optimize/integration-20b3fbf9 (wave.md's "completion notification or the Monitor tool" wait: the runner holds Monitor and is re-invoked by its shell's notification), f-bs-optimize/integration-e5ab5903 (the fragment's `<work-root>`), f-bs-optimize/integration-0659d0b8 (the `playbook slice` usage text), f-bs-optimize/integration-c99e2bc9 (two older wave.md sentences).

### Pre-code review (v7 draft) — changes

1. fixed (task-17, criterion 4; replaces "holds it to at most half the smallest `maxTurns`" in the cdcd0b23 line above): the bound covers every heavy run a carrier makes per dispatch, not one run. These are the stated runs per dispatch. coder 3: a full-suite gate run and two re-runs after fixes. tester 2: `test_unit` and `test_e2e`. merger 1: the cumulative regression gate. bs-merger.md:52-58 returns after that gate, and a re-run after the queue moved is the merge queue's own, under `bs queue run`. wave-runner 1. auditor, grader, reviewer, security-reviewer, spec-reviewer, uiux and verifier 1 each, for a probe. The test holds this table and cross-checks its keys against the carriers `parseSharedRegions` (templateFragments.ts) derives. For each carrier it asserts that runs × the 11-turn worst-case run fit in half its `maxTurns`, read through agentsSync.ts's `readTemplateMaxTurns`, so the other half stays for the role's work and its result. Under the text as written, a merger with ~10 conflict turns, its one gate behind the full 1 h queue and its result write and return uses 10 + 11 + 2 = 23 of 30. A tester uses 22 of its 60 on two queued runs.
2. fixed (task-17, criterion 3; replaces "the fragment gains one steer" in the cdcd0b23 line above): the steer replaces the old offer sentence ("Pass `bs heavy wait --file <out> --max-wait-ms 540000` only together with a Bash `timeout` of 600000."), so the long call appears once, and a pin counts it. Sizes are measured on the whitespace-flattened fragment, split after each '. ', with words as space-separated tokens. The steer sentence has at most 60 words. The rest of the fragment has at most 297, v6's 313 less the 16-word offer sentence, held in the test as a named constant. A 61-word steer and a word added to any other sentence each fail by name.
3. fixed (task-17, criteria 1 and 3): `next` wins. The steer makes `"next"` the deciding signal and names a held lock as the case where it gives 540000. It never states the long call as following from a named holder alone. A missing file with a live holder therefore gets `next` 100000 / 120000, and the agent keeps the short call. Both the module test and the fragment pin cover that case.
4. kept: the stop rule does not fire for an agent whose own start died while another holder keeps the lock. The cost: that agent reaches its turn cap without its result, as under v6, and the steer lengthens the blocked wall-clock from cap × 100 s to cap × 540 s. That is about 42 min becoming 3 h 45 min for a 25-turn carrier, and 50 min becoming 4 h 30 min for bs-merger. It is not bounded here because no instrument tells that run from a live queued one: a queued `bs heavy run` writes no lock record and nothing to `<out>` until it holds the lock. A bound needs a new waiter record in heavyLock.ts, or a rule that reads the agent's own background-task status, and either is a new mechanism beyond this finding, which concerns a live queued run's turn cost. A candidate for a later epic.
5. fixed (task-17, criteria 1-5): every new guard has a named mutation it must fail, with the failing output quoted in the result. M1a-M1e cover `next`: long with the holder null, long for a missing file, present on a done result, short on a corrupt record, short with a live holder. M2 is the queued run end to end. M3a-M3h cover the steer: no holder condition, no timeout, the offer sentence kept beside it, 61 words, another sentence grown, a bound that differs from `LONG_WAIT_MS`, `next` not named as deciding, the long call tied to a named holder alone. M4a-M4d cover the cost: the unfixed fragment, a 100000 steer bound, a carrier dropped from the derived list, tester runs raised to 3. M5 appends a foreground `sleep 5` to the steered call.

### Verification review (v7 draft) — changes

1. fixed (task-17, criterion 3; replaces the holder-alone clause in the cdcd0b23 line above and refines pre-code item 3): the clause "so once a `"done": false` names a `"holder"`, each next call is `bs heavy wait --file <out> --max-wait-ms 540000` with a Bash `timeout` of 600000" no longer stands. `"next"` governs the long call. Besides the pin that requires `"next"` as the decider (fails M3g), an order pin requires that, in the steer sentence, the first `"next"` comes before the long call and no `"holder"` comes before it. The holder condition therefore appears only after the long call, as the case where `next` gives 540000. The old clause with `"next"` added to its sentence passes the first pin and fails the order pin by name (M3h), so M3g and M3h give different failing outputs.
