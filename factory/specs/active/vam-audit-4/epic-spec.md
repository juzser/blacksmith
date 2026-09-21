# Epic spec — `vam-audit-4`

- **Epic id** — `vam-audit-4`
- **Project** — `vam` at `/Users/ser/scatola/jobs/projects/vam`, and every worktree is placed beside that clone (`AGENTS.md` "Worktrees").
- **Roadmap milestone** — `vam-audit-4` in `factory/specs/roadmap.md`.
- **Provenance** — cut by `smith audit cut` from audit 20260918-add96a1c, 20260921-40a35af9 (5 accepted findings: 2 S2-major, 3 S3-minor). Each finding carries this epic id in `.blacksmith/findings.jsonl`; `smith audit resolve` marks them fixed when the epic closes.

## What this epic is

vam — audit wave 4 (renderer decomposition, concurrent transcript polling). The findings below were raised by the audit's axes, consolidated by path, and accepted by the operator one by one; nothing here was inferred. Each row is one acceptance criterion: the finding's `failure_scenario` says what a passing build must no longer do.

## Acceptance criteria

| # | Finding | Sev | Axis | File | What is wrong |
|---|---|---|---|---|---|
| 1 | `d67b7acf` | S3-minor | performance | `src/renderer/adapter/useCanvas.ts` | Concurrent `load()` calls triggered by a burst of `change` frames are not coalesced or in-flight-guarded, only guarded against writing stale state after the fact, so a burst of N frames can fire N overlapping full-reload request waves before any of them resolves. |
| 2 | `69465afa` | S3-minor | performance | `src/main/sources/claude-code/source.ts` | loadClaudeCodeProjects reads every distinct session's transcript sequentially (await inside a for-loop) instead of concurrently, so total poll latency scales linearly with the number of open sessions rather than with the slowest single read. |
| 3 | `12b20e80` | S2-major | architecture | `src/renderer/canvas/Canvas.tsx` | CanvasInner is a single ~5,100-line function component (lines 1576-6679 of 6799) that owns split-pane layout, drag/drop, session tab strip, usage polling, keyboard routing and source-switching state together, so no one concern can be unit-tested, reasoned about or changed in isolation. |
| 4 | `a14c7695` | S2-major | architecture | `src/renderer/panels/DetailPanel.tsx` | The exported DetailPanel function itself spans roughly 4,400 lines (3696-8088 of 8193) mixing composer/draft editing, bang-command and slash-command parsing, dictation, image paste, PR/Agents/Files/Terminal tab state and answer-delivery logic in one component body, despite each tab already having its own file (TerminalTab.tsx, FilesTab.tsx) that DetailPanel wraps. |
| 5 | `46270946` | S3-minor | code-quality | `src/renderer/panels/SessionList.tsx` | The `SessionList` component (line 734 to the end of the file at line 3279, ~2545 lines) is a single function body, the third file in the panels directory (after DetailPanel.tsx and Canvas.tsx) to hold its entire component logic in one undivided function scope. |

## Findings in full

### `d67b7acf` — Concurrent `load()` calls triggered by a burst of `change` frames are not coalesced or in-flight-guarded, only guarded against writing stale state after the fact, so a burst of N frames can fire N overlapping full-reload request waves before any of them resolves.

- **Fingerprint** — `d67b7acf3fe57f55fa97d1833821ccc1d2dbefca8d887b49e2aba99ccd2ef741`
- **Axis / severity / confidence** — performance / S3-minor / 0.4
- **File** — `src/renderer/adapter/useCanvas.ts`
- **Inputs** — Two or more `change` SSE frames arriving within one round-trip of `client.overview()`/`client.timeline()` (e.g. two sessions producing output within the same ~100ms window).
- **Expected** — A second change arriving while a reload is already in flight is coalesced into the in-flight request (or queued to run once, after it completes), so the number of concurrent overview+timeline waves stays bounded regardless of how many change frames land close together.
- **Actual** — Each `onChange`/`onHello` call starts its own `load()` unconditionally; the only protection (the `generation` ref) discards a stale result after the fact rather than preventing the redundant request wave from being sent, so the network briefly carries as many full overview+timeline bursts as there were change frames in the window. Read by inspection only; the real-world burst rate depends on the backend's emission pattern, which this audit could not observe or run.

### `69465afa` — loadClaudeCodeProjects reads every distinct session's transcript sequentially (await inside a for-loop) instead of concurrently, so total poll latency scales linearly with the number of open sessions rather than with the slowest single read.

- **Fingerprint** — `69465afa938afa20dce842164622d0f7bdcf93cd90179cfbc5dc86a1cd0409a1`
- **Axis / severity / confidence** — performance / S3-minor / 0.55
- **File** — `src/main/sources/claude-code/source.ts`
- **Inputs** — An operator with ~40-50 concurrently tracked agent sessions (the app's own use case) triggers the 10s poll (SOURCE_POLL_INTERVAL_MS in src/renderer/sources/useSourceModel.ts) that calls loadClaudeCodeProjects, which at src/main/sources/claude-code/source.ts lines ~363-368 does `for (const sessionId of new Set(agents.map(a => a.sessionId))) { ... await readTranscript(path, sessionId, nowMs); }` -- each readTranscript does a stat, a tail read of the transcript file, and a readdir+per-file reads for the subagent roster.
- **Expected** — Load latency should be roughly bounded by the slowest single session's file I/O (achievable with Promise.all across sessions, mirroring the deliberate single-read-per-file care documented elsewhere in this same file, e.g. readPublishedPanesAndProcessFacts's comment about avoiding redundant reads).
- **Actual** — Load latency is the SUM of every session's stat+tail-read+roster-read, executed one session at a time; with enough concurrent sessions (or a slow/network-backed home directory) the cumulative await chain can approach or exceed the 10s poll interval, causing overlapping polls, stale canvas state, and a UI that visibly lags session activity -- exactly the scaling axis (many concurrent agent sessions) this app is built around.

### `12b20e80` — CanvasInner is a single ~5,100-line function component (lines 1576-6679 of 6799) that owns split-pane layout, drag/drop, session tab strip, usage polling, keyboard routing and source-switching state together, so no one concern can be unit-tested, reasoned about or changed in isolation.

- **Fingerprint** — `12b20e80a1b24b44efa8443781ddeeaa4492a6aec518dc2251b01cb37f2d8a88`
- **Axis / severity / confidence** — architecture / S2-major / 0.62
- **File** — `src/renderer/canvas/Canvas.tsx`
- **Inputs** — A change to the drop-zone/drag-reorder logic inside CanvasInner (one of 70 useCallback closures and 11 useState hooks living in the same function body as tab-strip rendering, usage-bar polling and keyboard-jump-label logic)
- **Expected** — The drag/drop concern is a separable unit whose behavior can be exercised and reasoned about without loading or mentally simulating the rest of the canvas (tab strip, usage bar, source switching, keyboard jump mode)
- **Actual** — All state and callbacks are closures inside one 5,100-line function, so a change to any one concern can only be verified by re-rendering the whole CanvasInner component and there is no module boundary stopping an edit to drag/drop state from shadowing or accidentally capturing tab-strip state declared earlier in the same closure

### `a14c7695` — The exported DetailPanel function itself spans roughly 4,400 lines (3696-8088 of 8193) mixing composer/draft editing, bang-command and slash-command parsing, dictation, image paste, PR/Agents/Files/Terminal tab state and answer-delivery logic in one component body, despite each tab already having its own file (TerminalTab.tsx, FilesTab.tsx) that DetailPanel wraps.

- **Fingerprint** — `a14c7695ccda18835e6816d428d98fe86fbf031778512eae4bc5c034bcf6dc70`
- **Axis / severity / confidence** — architecture / S2-major / 0.55
- **File** — `src/renderer/panels/DetailPanel.tsx`
- **Inputs** — A maintainer needs to change how the composer's bang-command query (bangQuery/applyBang) resolves while the Agents tab (AgentsTab/AgentDetail) is rendered in the same file and shares the enclosing component's props and hook order
- **Expected** — Composer-parsing logic can be extracted and tested as a standalone unit, and a change to it carries no risk of shifting hook order or captured state used by the Agents/PRs/Files tab rendering that lives in the same function
- **Actual** — Composer parsing, PR tab rendering, Agents tab rendering and file/terminal tab wiring are all declared inside the same ~4,400-line function body, so the only way to validate a change is to exercise the whole DetailPanel component, and the 7 useState/13 useEffect hooks in that body are ordered dependencies a local edit can silently perturb

### `46270946` — The `SessionList` component (line 734 to the end of the file at line 3279, ~2545 lines) is a single function body, the third file in the panels directory (after DetailPanel.tsx and Canvas.tsx) to hold its entire component logic in one undivided function scope.

- **Fingerprint** — `46270946027b02ab72fc569daf60c6300a6c65df994c1908fcd1d9a92c84182b`
- **Axis / severity / confidence** — code-quality / S3-minor / 0.7
- **File** — `src/renderer/panels/SessionList.tsx`
- **Inputs** — A developer changes the keyboard-navigation logic inside SessionList to fix a filter-popover bug, in a function that also implements drag reordering, restore-strip timers, and row rendering for the whole session list.
- **Expected** — Keyboard-navigation state should be isolated (e.g. in its own hook) so a fix there cannot alter unrelated behaviour such as drag reordering or the restore-strip timer that share the same function.
- **Actual** — All of this logic lives in one 2545-line function scope with shared local state, so the change carries the same risk of unintended cross-feature interaction as the same pattern already flagged in DetailPanel.tsx and Canvas.tsx, and a reviewer cannot bound the blast radius of the edit without reading the entire component.
