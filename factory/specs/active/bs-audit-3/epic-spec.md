# Epic spec — `bs-audit-3`

- **Epic id** — `bs-audit-3`
- **Project** — `black-smith`; every worktree is placed beside the clone the run is handed (`AGENTS.md` "Worktrees").
- **Roadmap milestone** — `bs-audit-3` in `factory/specs/roadmap.md`.
- **Provenance** — cut by `smith audit cut` from audit 20260927-b61eaa7e (2 accepted findings: 2 S3-minor). Each finding carries this epic id in `.blacksmith/findings.jsonl`; `smith audit resolve` marks fixed only the ones a task in this plan still claims, and leaves the rest `deferred`.

## What this epic is

Self-audit 3: UI read boundary and fail-closed daemon state. The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's `failure_scenario` says what a passing build must no longer do.

## Acceptance criteria

| # | Finding | Sev | Axis | File | What is wrong |
|---|---|---|---|---|---|
| 1 | `871ee8f7` | S3-minor | architecture | `ui/server/src/app.ts` | lessonSession() builds its own drizzle query directly against the `lessons` schema table instead of going through db/queries.ts, the module the file's own header comment declares as the single 1:1 wrapper boundary between the UI and the projection. |
| 2 | `442cd7f2` | S3-minor | code-quality | `factory/orchestrator/src/daemon.ts` | daemon.ts defines its own readJsonFile() that silently swallows any parse/read error and returns null, diverging from the fail-closed readJsonFile() in cli.ts that throws on malformed JSON, so a corrupted daemon lock/status/memory file is treated as absent rather than reported. |

## Findings in full

### `871ee8f7` — lessonSession() builds its own drizzle query directly against the `lessons` schema table instead of going through db/queries.ts, the module the file's own header comment declares as the single 1:1 wrapper boundary between the UI and the projection.

- **Fingerprint** — `871ee8f7aeb74814ce19e292499c8d3f03444edc440684fd33424ffaa3beefe8`
- **Axis / severity / confidence** — architecture / S3-minor / 0.6
- **File** — `ui/server/src/app.ts`
- **Inputs** — A future migration renames or reshapes a column on the `lessons` table (e.g. splits `sessionId` or changes its nullability) as part of a change reviewed only against db/queries.ts call sites, per the boundary the file documents ('read endpoints wrap db/queries.ts's page queries 1:1').
- **Expected** — Every place that reads lesson rows goes through db/queries.ts, so one audited call site catches the shape change and the UI keeps compiling or fails loudly at the single reviewed boundary.
- **Actual** — lessonSession() in ui/server/src/app.ts imports the `lessons` table and `eq` from drizzle-orm directly and hand-writes `.select({ sessionId: lessonsTable.sessionId }).from(lessonsTable).where(eq(lessonsTable.lessonId, lessonId))`, a second, unaudited read path into the schema that a reviewer checking only db/queries.ts call sites will not see, so the three lesson-review write routes (Approve/Reject/etc.) can silently break or return the wrong owning session.

### `442cd7f2` — daemon.ts defines its own readJsonFile() that silently swallows any parse/read error and returns null, diverging from the fail-closed readJsonFile() in cli.ts that throws on malformed JSON, so a corrupted daemon lock/status/memory file is treated as absent rather than reported.

- **Fingerprint** — `442cd7f2e14cc696ffc1a30b8a44979c8057e24c08ce440b854cef54b7b54ebe`
- **Axis / severity / confidence** — code-quality / S3-minor / 0.55
- **File** — `factory/orchestrator/src/daemon.ts`
- **Inputs** — The daemon's lock file (state/daemon/lock.json under a project dir) is left truncated or half-written by a crash mid-write, then `smith daemon status` or `smith daemon start` runs against that directory.
- **Expected** — A corrupted lock/status file should be surfaced as a read error (as the cli.ts readJsonFile equivalent does for --checks files) so the operator can tell 'no daemon' apart from 'daemon state unreadable', and readLock()/readStatus() should not silently masquerade a broken file as a clean absence.
- **Actual** — daemon.ts's local readJsonFile() catches every error (JSON.parse failure, permission error, anything) and returns null with no log line, so readLock() reports no lock at all and a second daemon can be started against the same directory, or readTickStatus()/readFindingMemory() silently reset to an empty/default state instead of surfacing the corruption.
