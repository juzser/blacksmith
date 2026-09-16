# Epic spec — `vam-audit-1`

- **Epic id** — `vam-audit-1`
- **Project** — `vam` at `/Users/ser/scatola/jobs/projects/vam`, and every worktree is placed beside that clone (`AGENTS.md` "Worktrees").
- **Roadmap milestone** — `vam-audit-1` in `factory/specs/roadmap.md`.
- **Provenance** — cut by `smith audit cut` from audit 20260914-5fe9088c (3 accepted findings: 3 S3-minor). Each finding carries this epic id in `.blacksmith/findings.jsonl`; `smith audit resolve` marks them fixed when the epic closes.

## What this epic is

vam — audit wave 1 (error formatting, poll back-pressure, adapter boundary). The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's `failure_scenario` says what a passing build must no longer do.

## Acceptance criteria

| # | Finding | Sev | Axis | File | What is wrong |
|---|---|---|---|---|---|
| 1 | `6acbe3a3` | S3-minor | performance | `src/adapter/useCanvas.ts` | The 4-second poll loop fires the next overview+timeline fetch on a fixed timer with no in-flight guard, so a slow or degraded black-smith backend causes concurrent request piles that never drain, and an explicit refresh() (fired on every write) stacks more on top instead of coalescing. |
| 2 | `4de3c5cb` | S3-minor | architecture | `src/panels/ReviewQueue.tsx` | ReviewQueue.tsx and canvas/actions.ts import ApiFinding/ApiLesson wire-format types directly from adapter/api.ts instead of a domain-layer abstraction, breaking the project's own consistently-applied rule that no UI component learns which system (black-smith) it is looking at. |
| 3 | `7d3536a4` | S3-minor | code-quality | `src/canvas/Canvas.tsx` | The same error-unwrapping ternary (SmithApiError -> code:message, else Error -> message, else String(cause)) is written out verbatim twice in one file instead of being factored into a shared helper. |

## Findings in full

### `6acbe3a3` — The 4-second poll loop fires the next overview+timeline fetch on a fixed timer with no in-flight guard, so a slow or degraded black-smith backend causes concurrent request piles that never drain, and an explicit refresh() (fired on every write) stacks more on top instead of coalescing.

- **Fingerprint** — `6acbe3a3e27f88e0464cf1c31ec987f0ee365b9b13dc63a3a8678a6d80b01b40`
- **Axis / severity / confidence** — performance / S3-minor / 0.65
- **File** — `src/adapter/useCanvas.ts`
- **Inputs** — black-smith's /api/overview (or one of the per-session /api/timeline calls) starts answering in more than 4000ms — e.g. under load, over a slow link, or simply because the design's own '3-5 repos of 1-3 sessions' grows past what the server was sized for — while the vam tab stays open for an extended session.
- **Expected** — A poll tick should skip or supersede itself while the previous tick is still in flight, so the number of concurrent overview+timeline request sets stays bounded (at most one or two in flight) regardless of how long the server takes to answer or how often the operator triggers refresh() by answering waivers/prompts.
- **Actual** — useEffect's setInterval calls load() unconditionally every POLL_MS (4000ms) with no check on whether the prior load() promise has settled, and refresh() (called from every write success via source.onWrote()) does the same; the only guard is a generation ref that discards a stale response's setState after the fact, so every tick still starts a fresh overview() plus one timeline() per running session, and the count of outstanding fetches grows without bound for as long as the response time exceeds the tick interval — exhausting the browser's per-origin connection pool and starving the review-queue's own requests, with no test in useCanvas.test.tsx covering this overlap case.

### `4de3c5cb` — ReviewQueue.tsx and canvas/actions.ts import ApiFinding/ApiLesson wire-format types directly from adapter/api.ts instead of a domain-layer abstraction, breaking the project's own consistently-applied rule that no UI component learns which system (black-smith) it is looking at.

- **Fingerprint** — `4de3c5cbb86b29248607af9e151fb1283a209363d3b702da9342082f0845091d`
- **Axis / severity / confidence** — architecture / S3-minor / 0.62
- **File** — `src/panels/ReviewQueue.tsx`
- **Inputs** — black-smith reshapes its findings/lessons wire schema (e.g. renames a field on the server-side Finding or Lesson type, or changes fingerprint/severity encoding), the kind of change adapter/to-canvas.ts exists specifically to absorb for sessions and decisions.
- **Expected** — Per the adapter-boundary principle stated in to-canvas.ts ('the whole reason CanvasModel exists is so this file can be the only place that knows what a dispatch_decision is... no component ever learns which system it is looking at'), only adapter-layer code should need to change; UI components should be insulated via a domain type.
- **Actual** — panels/ReviewQueue.tsx (ReviewQueueProps, WaiverRow, LessonRow) and canvas/actions.ts import ApiFinding and ApiLesson directly from adapter/api.ts, so the same wire-format change forces edits in two UI-layer files that have no equivalent of to-canvas.ts's translation step, unlike the Session/Decision/Command path which is fully insulated.

### `7d3536a4` — The same error-unwrapping ternary (SmithApiError -> code:message, else Error -> message, else String(cause)) is written out verbatim twice in one file instead of being factored into a shared helper.

- **Fingerprint** — `7d3536a437fc5280c80bf456a37285d295daeb2fc8bbbd2a9c82ebe411a939fb`
- **Axis / severity / confidence** — code-quality / S3-minor / 0.75
- **File** — `src/canvas/Canvas.tsx`
- **Inputs** — A developer changes how SmithApiError should be displayed (e.g. adds a status-code prefix) in the `sendPrompt` catch block at line ~460 but does not know the identical block exists again in `answer` at line ~501.
- **Expected** — One shared formatting function so a change to error presentation applies everywhere a SmithApiError can surface, keeping the two write paths (prompt send, waiver/lesson answer) consistent.
- **Actual** — The two inline copies can and do drift independently; the file already carries two hand-written copies of the same three-way instanceof chain with no single source of truth for 'how vam shows a refusal'.

