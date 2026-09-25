# Epic spec — `bs-audit-2`

- **Epic id** — `bs-audit-2`
- **Project** — `blacksmith` at `/Users/ser/scatola/jobs/projects/blacksmith`, and every worktree is placed beside that clone (`AGENTS.md` "Worktrees").
- **Roadmap milestone** — `bs-audit-2` in `factory/specs/roadmap.md`.
- **Provenance** — cut by `smith audit cut` from audit 20260925-49bffa9b (5 accepted findings: 2 S2-major, 3 S3-minor). Each finding carries this epic id in `.blacksmith/findings.jsonl`; `smith audit resolve` marks fixed only the ones a task in this plan still claims, and leaves the rest `deferred`.

## What this epic is

Audit 2: bounded judges, parallel feedback, dashboard origin guard. The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's `failure_scenario` says what a passing build must no longer do.

## Acceptance criteria

| # | Finding | Sev | Axis | File | What is wrong |
|---|---|---|---|---|---|
| 1 | `50acc356` | S3-minor | performance | `factory/orchestrator/src/daemon.ts` | runTick() re-reads and re-JSON.parses every session's full .jsonl event log from disk on every daemon tick, with no incremental/fingerprint caching, so the daemon's per-tick cost grows linearly and unboundedly with the factory's total historical event volume. |
| 2 | `d50d4c1f` | S3-minor | performance | `ui/server/src/app.ts` | Every dashboard write route that omits an explicit causalParent (waivers apply-batch, lessons approve/reject/edit) triggers a full read-and-parse of that session's entire event log via resolveContext()/lessonContext() just to read the id of the last event. |
| 3 | `4c610e7c` | S2-major | security | `ui/server/src/app.ts` | The dashboard's write endpoints (waiver apply-batch, lesson approve/reject/edit) have no CSRF protection: there is no Origin/Referer check and Hono's `c.req.json()` parses the request body as JSON regardless of the Content-Type header, so a cross-origin `text/plain` form POST (a CORS-exempt 'simple request' that needs no preflight) is accepted and executed. |
| 4 | `1b8fe398` | S3-minor | architecture | `.claude/skills/bs/wave.md` | The wave playbook's own loop (steps 2-10) never invokes the one instrument that measures whether a wave actually ran in parallel (auditWaveConcurrency/`smith wave check`, factory/orchestrator/src/waveConcurrency.ts), so the factory's central scaling claim goes unchecked for the entire time it could still be corrected. |
| 5 | `7ef3cd2f` | S2-major | architecture | `.claude/skills/bs/dispatch.md` | The one hard cap that bounds every subagent's work (`maxTurns`, enforced by the Claude Code harness itself) is transmitted into each dispatch prompt purely as prose the dispatching agent must copy correctly by hand from `.claude/agents/<role>.md` 'at dispatch time' — no module in factory/orchestrator/src validates that a dispatch's stated turn budget matches the template the harness will actually enforce, so the one enforcement path for this invariant is a human/LLM re-reading a file correctly every single time. |

## Findings in full

### `50acc356` — runTick() re-reads and re-JSON.parses every session's full .jsonl event log from disk on every daemon tick, with no incremental/fingerprint caching, so the daemon's per-tick cost grows linearly and unboundedly with the factory's total historical event volume.

- **Fingerprint** — `50acc356980f4dd8b80a542f95fbac04c57f9d6cb836885b79e9c16757ae19b0`
- **Axis / severity / confidence** — performance / S3-minor / 0.6
- **File** — `factory/orchestrator/src/daemon.ts`
- **Inputs** — A `smith daemon run` process left running (default DEFAULT_INTERVAL_SECONDS = 300s) against a state/events/ directory that has accumulated a year of epics — hundreds of session .jsonl files, some long-running lineages with tens of thousands of lines each.
- **Expected** — A background watcher whose steady-state per-tick cost is bounded by what changed since the previous tick (the same fingerprint-skip design ui/server/src/app.ts's createRefresher uses via stat-based `projected.get(sessionId) === fingerprint`), so ticks stay cheap indefinitely.
- **Actual** — `runTick` (factory/orchestrator/src/daemon.ts, around `for (const sessionId of listSessionIds(stateDir)) { logs.set(sessionId, await readEvents(sessionId, { stateDir })); }`) calls `readEvents`/`readEventsAtPath` for literally every session on every tick with no size/mtime gate, so each tick's I/O and JSON-parse cost is O(total bytes of every session log ever written), and that total only grows — the exact 'cache with no bound or invalidation' pattern the sibling module ui/server/src/app.ts already built a fix for but daemon.ts does not reuse.

### `d50d4c1f` — Every dashboard write route that omits an explicit causalParent (waivers apply-batch, lessons approve/reject/edit) triggers a full read-and-parse of that session's entire event log via resolveContext()/lessonContext() just to read the id of the last event.

- **Fingerprint** — `d50d4c1f7df66d5b4a0643e300448445d515cf53d4b5a9b4580170977c104b0a`
- **Axis / severity / confidence** — performance / S3-minor / 0.55
- **File** — `ui/server/src/app.ts`
- **Inputs** — An operator clicks 'approve' on a lesson, or applies a waiver batch, from the dashboard, in a session/epic whose event log has grown large (a long-running epic with thousands of dispatch/tool events).
- **Expected** — Getting the last event id to chain a new write onto costs work proportional to the write, not to the whole session's history — e.g. reading only the log's tail, or reusing a length/offset already known to the projector.
- **Actual** — `resolveContext` and `lessonContext` (ui/server/src/app.ts) both call `const events = await readEvents(sessionId, eventOpts); const last = events[events.length - 1];` — `readEvents` loads and JSON-parses the entire session .jsonl into memory to hand back one field of its final line, and this runs synchronously inside every write request that does not pass `causalParent` explicitly, so the click-to-write path re-pays the full log size on every single click.

### `4c610e7c` — The dashboard's write endpoints (waiver apply-batch, lesson approve/reject/edit) have no CSRF protection: there is no Origin/Referer check and Hono's `c.req.json()` parses the request body as JSON regardless of the Content-Type header, so a cross-origin `text/plain` form POST (a CORS-exempt 'simple request' that needs no preflight) is accepted and executed.

- **Fingerprint** — `4c610e7c3c2b1adf21bca4e01d155e1f595acfb58751e09c25644fbbc20a8add`
- **Axis / severity / confidence** — security / S2-major / 0.55
- **File** — `ui/server/src/app.ts`
- **Inputs** — While an operator has `smith ui serve` running locally (127.0.0.1:4680, documented as local-first/no-auth in index.ts), they visit an attacker-controlled web page in the same browser. That page auto-submits a hidden HTML form: `<form action="http://127.0.0.1:4680/api/lessons/<lessonId>/approve" method="POST" enctype="text/plain"><input name='{"note":"x","pad":"' value='"}'></form>` (or an equivalent `fetch(..., {mode:'no-cors', headers:{'Content-Type':'text/plain'}, body: '{...}'})`). Because the request is a CORS-simple request, the browser sends it cross-origin with no preflight and no CORS headers needed.
- **Expected** — A state-changing route reachable from any origin without authentication should verify the request originated from the dashboard UI itself (e.g. reject unrecognized Origin/Referer, require a same-origin/CSRF token, or at minimum refuse bodies whose Content-Type is not application/json) before calling transitionLesson()/applyBatch().
- **Actual** — app.ts's POST routes (`/api/lessons/:lessonId/approve`, `/reject`, `/edit`, `/api/waivers/apply-batch`) perform `await c.req.json()` and never inspect Origin/Referer or any anti-CSRF token anywhere in the file, so the forged cross-origin request is parsed and executed exactly like a same-origin one, silently approving/rejecting/editing a lesson or applying waiver decisions on the operator's behalf.

### `1b8fe398` — The wave playbook's own loop (steps 2-10) never invokes the one instrument that measures whether a wave actually ran in parallel (auditWaveConcurrency/`smith wave check`, factory/orchestrator/src/waveConcurrency.ts), so the factory's central scaling claim goes unchecked for the entire time it could still be corrected.

- **Fingerprint** — `1b8fe398e322ceb5e31fe752e14e18c5e0c57b067c331bae3dc3a6c83f1e0d20`
- **Axis / severity / confidence** — architecture / S3-minor / 0.55
- **File** — `.claude/skills/bs/wave.md`
- **Inputs** — A wave admits 5 tasks (`wave-admitted` names 5 task ids), but the wave-runner session dispatches their coders in 5 separate messages instead of one (in violation of wave.md's own 'One message, many dispatches' rule) — nothing in the code path stops or flags this while the wave is running.
- **Expected** — Given that dispatching many subagents in parallel is the operator's stated top priority for this factory, and waveConcurrency.ts exists specifically to detect exactly this failure mode ('a factory whose whole premise is many subagents running in parallel could serialise every wave it ever admitted and say nothing about it' - waveConcurrency.ts's own doc comment), the wave loop that can still fix it (steps 3-9, before merge) should surface the verdict.
- **Actual** — `auditWaveConcurrency`/`summariseWaveConcurrency` is wired into exactly two call sites: the ad hoc `smith wave check` CLI command (cli.ts:1742, operator-invoked, not part of any playbook step) and epic.ts's `summariseEpicConcurrency`, read only at epic close to grade the epic's verdict after every wave in it has already merged. wave.md's steps 2-10 (read in full) never call it, so a wave that ran its 5 coders one dispatch-message at a time is graded identically to one that ran them together until the epic ends, at which point the wasted parallelism can no longer be recovered — only reported.

### `7ef3cd2f` — The one hard cap that bounds every subagent's work (`maxTurns`, enforced by the Claude Code harness itself) is transmitted into each dispatch prompt purely as prose the dispatching agent must copy correctly by hand from `.claude/agents/<role>.md` 'at dispatch time' — no module in factory/orchestrator/src validates that a dispatch's stated turn budget matches the template the harness will actually enforce, so the one enforcement path for this invariant is a human/LLM re-reading a file correctly every single time.

- **Fingerprint** — `7ef3cd2f2286f9f0db4b34dd472e291d4e9ec1d2e74d2c6d0890e460aa754669`
- **Axis / severity / confidence** — architecture / S2-major / 0.5
- **File** — `.claude/skills/bs/dispatch.md`
- **Inputs** — A wave-runner (or planner-dispatching operator) composes a dispatch prompt for a role whose local template maxTurns was recently lowered (or was never re-read, e.g. after `smith agents sync` applied a per-box `SMITH_MAXTURNS_<ROLE>` override, which dispatch.md itself says 'reaches only agents spawned after it'), and states a turn budget in the prompt that is higher than what the harness will enforce.
- **Expected** — Since Claude Code enforces the template's maxTurns unconditionally and the agent 'cannot see how many turns it has left' (dispatch.md's own words), a mismatch between the prompt's stated budget and the enforced one should be caught before the dispatch spends any tokens — the same way `smith escalation check`, `smith delegation check` and `smith tester check` catch other prompt-vs-log mismatches after the fact for other invariants in this same contract.
- **Actual** — dispatch.md documents this exact failure already having happened in production ('a planner told 40 under a template saying 20 stopped twice with nothing written') and prescribes the fix as an instruction to read more carefully ('state the template's number, never a higher one'), not as a code check; no `smith` verb in the CLI surface validates a dispatch_decision's declared turn budget against the current `.claude/agents/<role>.md` maxTurns, so the same class of silent, zero-artifact failure remains fully reproducible by the same human/agent mistake that produced it once already.

## Operator-added scope

Accepted at the audit's hard stop on 2026-09-25 (`blacksmith-audit-2-2026-09-25#15`). These are not audit findings — no fingerprint, `audit resolve` never touches them — but they are acceptance criteria of this epic all the same. Ideas are cited by URL only; no code is taken from any of them.

| # | Criterion | Where it lands | Source of the idea |
|---|---|---|---|
| 6 | A judge-class agent (spec-reviewer, reviewer, verifier, grader, security-reviewer, auditor) cannot end its turn voluntarily while the artifact its dispatch declared does not exist: a `SubagentStop` hook in the template frontmatter returns `decision: "block"` with a reason naming the missing path. A harness `maxTurns` cap is not in scope — the hook cannot override it; that is `agent-resume`'s. | `.claude/agents/*.md` frontmatter, a hook script, `dispatch.md` artifact rule | Claude Code hooks, https://code.claude.com/docs/en/hooks |
| 7 | Plan ingest reports achievable parallel width mechanically: tasks whose claims are disjoint and which have no dependency edge between them are marked parallel, and the plan's widest admissible wave is printed, so a plan that serialises by accident is visible before `/bs run`. A small epic (few tasks, few claims — the threshold is the plan's to propose) takes a right-sized planning path, and every spec-review round is bounded by a short named review-focus list instead of an open hunt. | `factory/orchestrator/src/plan.ts` / `claims.ts` / `waveSchedule.ts`, `.claude/skills/bs/plan.md` | spec-kit `[P]` markers, https://github.com/github/spec-kit ; BMAD scale-adaptive planning, https://github.com/bmad-code-org/BMAD-METHOD ; task-master complexity analysis, https://github.com/eyaltoledano/claude-task-master ; superpowers writing-plans, https://github.com/obra/superpowers |

Out of scope, on purpose: a per-task pipeline that removes the wave barrier (vibe-kanban, ccswarm style). The operator asked for its trade-offs before deciding; it is not planned here.

## Notes for the planner

- Finding `1b8fe398` names the instrument `smith wave check`; that verb certifies at admission that a wave *could* run N wide. The one the finding means is `smith wave audit` (`report.md` step 5, `waveConcurrency.ts`), which says whether it *did*.
- Declined at the hard stop, not to be re-raised by this plan: `e47099f9` (`plan.ts` documented empty catch) and `36d3768e` (`judges.ts` fail-closed grader count).
