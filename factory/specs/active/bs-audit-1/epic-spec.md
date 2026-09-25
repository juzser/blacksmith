# Epic spec — `bs-audit-1`

- **Epic id** — `bs-audit-1`
- **Project** — `black-smith` at `/Users/ser/scatola/jobs/projects/blacksmith`, and every worktree is placed beside that clone (`AGENTS.md` "Worktrees").
- **Roadmap milestone** — `bs-audit-1` in `factory/specs/roadmap.md`.
- **Provenance** — cut by `smith audit cut` from audit 20260925-f336f5e4 (7 accepted findings: 3 S2-major, 3 S3-minor, 1 S4-nit). Each finding carries this epic id in `.blacksmith/findings.jsonl`; `smith audit resolve` marks fixed only the ones a task in this plan still claims, and leaves the rest `deferred`.

## What this epic is

Self-audit 1 — event-log append cost, rename-blind claim diffs, one git entry point. The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's `failure_scenario` says what a passing build must no longer do.

## Acceptance criteria

| # | Finding | Sev | Axis | File | What is wrong |
|---|---|---|---|---|---|
| 1 | `d7c644db` | S2-major | performance | `factory/orchestrator/src/events.ts` | appendEvent() re-reads and re-JSON.parses the entire session event log on every single append (readEventsAtPath inside appendEventLocked), while holding both an in-process queue and a cross-process poll lock, so writing to a session log is O(n) per event and O(n^2) for a session of n events. |
| 2 | `0f3f9c23` | S3-minor | performance | `factory/orchestrator/src/worktree.ts` | listStale() spawns one synchronous `git merge-base --is-ancestor` subprocess per worktree entry in a loop instead of a single batched check, so merge-queue/worktree cleanup cost scales linearly with subprocess spawns rather than with one git invocation. |
| 3 | `ae8cb69e` | S2-major | architecture | `factory/orchestrator/src/queue.ts` | The queue module shells out to git directly with execFileSync instead of going through git.ts, the module the codebase documents as the one place this factory shells out to git, so queue git failures bypass credential redaction and the structured GitCommandError type. |
| 4 | `fd03e000` | S3-minor | architecture | `factory/orchestrator/src/diffstat.ts` | diffstat.ts calls execFileSync('git', ...) directly for rev-parse/diff/branch instead of through git.ts, duplicating the single git-invocation boundary the codebase declares for itself and losing that module's credential redaction and GitCommandError typing. |
| 5 | `160cc3d7` | S3-minor | architecture | `factory/orchestrator/src/commit.ts` | commit.ts, which certifies whether a task's work is safe to integrate, runs its own execFileSync('git', ...) calls rather than routing through git.ts, so the one module the codebase names as the sole git entry point has at least two siblings that re-implement direct git shell-outs. |
| 6 | `07c5d1b0` | S2-major | code-quality | `factory/orchestrator/src/claims.ts` | collectCommittedChanges, the collector behind postRunCheck (the claim-confinement check for a task worktree), runs `git diff --name-only` without `--no-renames`, so a rename that crosses a claim boundary is reported only by its destination path. |
| 7 | `ad9ea9ba` | S4-nit | code-quality | `factory/orchestrator/src/waveNext.ts` | The one-line helper nameList (ids.join(', ')) is duplicated verbatim in waveNext.ts and waveSchedule.ts rather than shared, so the two wave-scheduling files carry two independent copies of the same id-list formatting rule. |

## Findings in full

### `d7c644db` — appendEvent() re-reads and re-JSON.parses the entire session event log on every single append (readEventsAtPath inside appendEventLocked), while holding both an in-process queue and a cross-process poll lock, so writing to a session log is O(n) per event and O(n^2) for a session of n events.

- **Fingerprint** — `d7c644db76bca8bcb1b39f04c310e1c27286c0f1d15aff745ba7d3c63e045b89`
- **Axis / severity / confidence** — performance / S2-major / 0.62
- **File** — `factory/orchestrator/src/events.ts`
- **Inputs** — An epic wave dispatches many parallel task agents against one epic session; each dispatch_decision, trr, error-logged, judge-report and finding append (appendEvent is the sole write path used from 21 modules / 40+ call sites, e.g. gate.ts, judges.ts, findings.ts, taskEvents.ts, quorum.ts, epic.ts) reads the growing .jsonl file, splits it into lines and JSON.parses every prior line before appending the new one.
- **Expected** — Appending the k-th event to a session log should cost O(1) amortized (or at worst O(1) I/O plus a small constant), independent of how many events the session already holds, so a long-running epic with hundreds of events dispatching many subagents in parallel stays cheap to write to.
- **Actual** — Each append pays O(n) file read + line-split + JSON.parse of the entire existing log (once to compute `existing.length` for the new event index, and again inside validateCausalParent for cross-session parents), so total work to write n events into one session is O(n^2); this runs serialized under a 12ms-poll cross-process lock, so concurrent wave dispatch processes queue behind an append whose cost grows with every event already logged.

### `0f3f9c23` — listStale() spawns one synchronous `git merge-base --is-ancestor` subprocess per worktree entry in a loop instead of a single batched check, so merge-queue/worktree cleanup cost scales linearly with subprocess spawns rather than with one git invocation.

- **Fingerprint** — `0f3f9c234625ecfa85e4cae7e4b7e021837476720150f2278d255889500445f0`
- **Axis / severity / confidence** — performance / S3-minor / 0.4
- **File** — `factory/orchestrator/src/worktree.ts`
- **Inputs** — An epic wave with many concurrently dispatched tasks accumulates many task worktrees/branches under smith/<epic>/*; the wave/merge-queue step (wave.md "worktrees through merge queue") calls listStale(projectDir, epic) to find worktrees safe to reclaim.
- **Expected** — Determining which of N worktrees are merged into the integration branch should require close to one git call (e.g. `git branch --merged` or `for-each-ref`) regardless of N.
- **Actual** — listStale() runs `git worktree list --porcelain` once but then calls `git(projectDir, ['merge-base', '--is-ancestor', ...])` synchronously inside a for-loop, once per matching branch, so N worktrees means N blocking subprocess spawns on the path a wave runs between waves/merges.

### `ae8cb69e` — The queue module shells out to git directly with execFileSync instead of going through git.ts, the module the codebase documents as the one place this factory shells out to git, so queue git failures bypass credential redaction and the structured GitCommandError type.

- **Fingerprint** — `ae8cb69e6305e913987b989faef8af32682ce408e3fb99bf211410400a21a5c2`
- **Axis / severity / confidence** — architecture / S2-major / 0.6
- **File** — `factory/orchestrator/src/queue.ts`
- **Inputs** — A task branch whose remote/origin URL embeds a credential (as git.ts's own redactCredentials doc comment anticipates) and whose git merge --no-ff at queue.ts:220 fails (e.g. a non-fast-forward or lock contention) with a message that echoes the remote URL; the call has no surrounding try/catch
- **Expected** — Per git.ts's documented invariant, every git failure in the factory is caught, credential-redacted, and re-thrown as a typed GitCommandError so the queue's error handling and the operator-facing log stay consistent and secret-free
- **Actual** — execFileSync('git', [...]) at queue.ts:220 throws a raw Node ExecFileSyncException with unredacted stderr attached, uncaught by any local handler, propagating a differently-shaped, potentially credential-bearing error instead of the GitCommandError every other consumer of git.ts expects

### `fd03e000` — diffstat.ts calls execFileSync('git', ...) directly for rev-parse/diff/branch instead of through git.ts, duplicating the single git-invocation boundary the codebase declares for itself and losing that module's credential redaction and GitCommandError typing.

- **Fingerprint** — `fd03e000f84d29122a4e8c3a85977f37638708d83fe064e3d2d397c3f6d6de0c`
- **Axis / severity / confidence** — architecture / S3-minor / 0.5
- **File** — `factory/orchestrator/src/diffstat.ts`
- **Inputs** — diffstat.ts's git diff --numstat -z or git rev-parse call fails in a repo whose configured remote embeds a token (the exact case git.ts's redactCredentials exists to handle)
- **Expected** — Per git.ts's stated invariant (the one place this factory shells out to git), the failure is caught centrally, credentials in stderr are redacted, and a typed GitCommandError is thrown
- **Actual** — diffstat.ts's own execFileSync calls (lines ~180-222) run outside git.ts, so a failure surfaces raw, unredacted Node child_process error text instead of the factory's standard git error shape

### `160cc3d7` — commit.ts, which certifies whether a task's work is safe to integrate, runs its own execFileSync('git', ...) calls rather than routing through git.ts, so the one module the codebase names as the sole git entry point has at least two siblings that re-implement direct git shell-outs.

- **Fingerprint** — `160cc3d7f48139031530b42d1f25f1e70d6c5e3177d4c7cf4b3a37dbc08083db`
- **Axis / severity / confidence** — architecture / S3-minor / 0.5
- **File** — `factory/orchestrator/src/commit.ts`
- **Inputs** — git status --porcelain=v1 -z --untracked-files=all (commit.ts:108) fails on a corrupt or locked repo during commit certification
- **Expected** — Every git invocation in the factory goes through git.ts so failures are uniformly typed (GitCommandError) and credential-redacted, per that module's own documented invariant
- **Actual** — commit.ts owns a second, parallel git-shelling code path; a failure here throws whatever raw shape Node's execFileSync produces, not the GitCommandError the rest of the codebase is written to catch, so error handling downstream of commit certification silently diverges from the documented boundary

### `07c5d1b0` — collectCommittedChanges, the collector behind postRunCheck (the claim-confinement check for a task worktree), runs `git diff --name-only` without `--no-renames`, so a rename that crosses a claim boundary is reported only by its destination path.

- **Fingerprint** — `07c5d1b0f09083ce5ef4b7ceb1db9f39dc6954441c9f67bb3e1ece1196dbc1ec`
- **Axis / severity / confidence** — code-quality / S2-major / 0.5
- **File** — `factory/orchestrator/src/claims.ts`
- **Inputs** — A task worktree whose claims cover only src/allowed/**; the agent renames src/forbidden/secret.ts to src/allowed/secret.ts in its own commits, then postRunCheck(worktreeDir, claims) runs as the confinement check before the task is admitted to land.
- **Expected** — The rename's origin path (src/forbidden/secret.ts) is reported as a changed path outside the claim, so classifyChanges flags an out-of-claim violation and the gate refuses the task (the exact pattern the repo's own compiled lesson e543bb1a5d0b names for claim-confinement diffs built on git diff --name-only).
- **Actual** — git diff --name-only with rename detection enabled lists only the destination path, which sits inside the claim, so classifyChanges reports no violation and postRunCheck certifies the task as claim-clean even though it touched a path never granted to it.

### `ad9ea9ba` — The one-line helper nameList (ids.join(', ')) is duplicated verbatim in waveNext.ts and waveSchedule.ts rather than shared, so the two wave-scheduling files carry two independent copies of the same id-list formatting rule.

- **Fingerprint** — `ad9ea9bab5563a3cbfd8759a1bd8d4ecbdc7845fa78254bb317ce62d3c06f5d0`
- **Axis / severity / confidence** — code-quality / S4-nit / 0.6
- **File** — `factory/orchestrator/src/waveNext.ts`
- **Inputs** — A future change to how task-id lists render in admission/schedule hint text (truncation, sorting, quoting) is made only to the nameList copy inside waveSchedule.ts.
- **Expected** — Every hint string produced by the wave-scheduling code renders id lists identically, because there is a single nameList implementation shared by computeNextWave and scheduleWaves.
- **Actual** — waveNext.ts keeps its own separate nameList definition, so computeNextWave's deferral messages keep the old formatting while scheduleWaves's hints use the new one, with nothing in either file signalling the two have diverged.
