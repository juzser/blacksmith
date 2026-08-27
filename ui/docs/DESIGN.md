# Design — the Blacksmith dashboard

The dashboard ships its own design kit, and it is complete inside this
repository: tokens in [`ds-tokens.css`](../src/styles/ds-tokens.css),
component CSS in [`ds-components.css`](../src/styles/ds-components.css), and
the Vue primitives under [`ui/src/components/ds/`](../src/components/ds/).
Nothing under `ui/` reaches outside this repository at build or run time, and
nothing here needs an account, a token, or a second clone. This file is the
kit's rulebook: on conflict between it and any older note below, this file
wins, because there is no upstream left to defer to.

**Provenance.** The kit was ported in July–August 2026 from a private design
system, referred to as *HDS* in the dated notes and version history elsewhere
under `ui/`, and in the `knowledge/design-system/…` paths a handful of
comments still cite. That repository is not public and is not a dependency:
the port finished, the assets are in-tree, and those citations survive only so
a reader can tell which primitives were copied from a reference and which this
repo composed itself. Treat every such path as a footnote about where a file
came from, never as somewhere to go.

**This kit is the dashboard's, not the factory's.** What a *scaffolded* project
gets is whatever the operator answered for `design_system` at install time
(`factory/policies/stack.yml`), and `none` is a complete answer — see
[`../../docs/standards/stack.md`](../../docs/standards/stack.md). Nothing in
this file is prescribed to the projects Blacksmith builds.

## Declarations

- **Variant:** `dashboard` (`profile/layouts-dashboard.md` +
  `profile/layouts.md` for everything inherited). Justification: Overview is
  a stat-row + multi-feed landing page (Template 5A); Kanban is a flagged
  composition (§6.2 gap) rather than a stock template.
- **Tokens copy:** `ui/src/styles/ds-tokens.css`, version 3.0.0, copied
  2026-08-04, byte-identical to `knowledge/design-system/profile/tokens.css`
  above its repo-specific extension point (empty — no additive tokens were
  needed).
- **UI language:** English. No explicit operator confirmation was obtained
  in this dispatch (design-spec.md §7 flagged this as pending) — assumed
  from every other artifact in this repo being English-only
  (`docs/standards/agent-constraints.md`: "All artifacts in this repo... are
  English"). Confirm explicitly before Phase 6b if this assumption is wrong.
- **Date format:** `DD/MM/YYYY` display default (`ui/src/lib/format.ts`),
  per design-spec.md §9 — not yet operator-confirmed either.
- **Delete semantics:** N/A — no delete anywhere in this app. Writes are
  limited to waiver apply-batch and lesson approve/edit/reject; none delete
  data.
- **Responsive floor:** 390px (repo-specific override of the 1024px
  default), per design-spec.md §2 — the off-canvas Sheet sidebar activates
  below 768px, `Toolbar` filters wrap below 640px, and no page tested at
  390px reflows into illegibility (verify in a real browser at ship time —
  see "Verification not yet run" below).

## Primitive inventory (closed set)

Vendored under `ui/src/components/ds/`. Phase 6a built the subset needed
for Overview/Timeline/Kanban; Phase 6b built the rest of what the six new
pages need (Select/Textarea/RadioGroup/Tabs/Popover/Dialog/AlertDialog/
Toast/Sparkline/LineChart/BarChart), per this task's own instruction to
"prefer building these properly this phase" rather than keep disclosing
simplifications.

| Primitive | Since | Notes |
|---|---|---|
| Button | Phase 6a | variants: default/outline/secondary/ghost/destructive/link/inverse |
| Icon | Phase 6a | inline SVG registry (`ui/src/icons.ts`) — see "Known deviations" |
| Lozenge | Phase 6a | subtle/bold/outline/solid |
| Skeleton | Phase 6a | |
| Separator | Phase 6a | |
| Card / StatCard | Phase 6a | StatCard per `profile/components.md`'s composition description (no `StatCard.jsx` exists in the kit) |
| RowList / Row | Phase 6a | |
| Table | Phase 6a; used by Findings/Lessons/Errors (6b) | bordered |
| PageHeader | Phase 6a | |
| Toolbar | Phase 6a | |
| FilterChips | Phase 6a | |
| MetricGrid | Phase 6a | |
| TwoColumn | Phase 6a | |
| SectionHeading | Phase 6a | still not used by any page — kept vendored, unused |
| EmptyState | Phase 6a | |
| Banner | Phase 6a | `role="status" aria-live="polite"` per design-spec.md §7, not the kit's default `role="alert"` |
| Tooltip | Phase 6a | |
| SidebarNav | Phase 6a | Phase 6b: `disabled`/`disabledReason` state is no longer used — every nav item ships this phase |
| Breadcrumb | Phase 6a | |
| Highlight | Phase 6a | |
| Sheet | Phase 6a | mobile off-canvas sidebar only, per §6.1 |
| **Select** | **Phase 6b** | real primitive (`ui/src/components/ds/Select.vue`), a native `<select>` wrapper — closes the 6a "disclosed simplification" gap; used by the topbar project switcher, Kanban/Roadmap/Flow epic and plan-version pickers |
| Input | Disclosed simplification (unchanged) | raw `<input class="raw-input">` (Timeline/Roadmap search boxes) — a real `Field`/`Input` wrapper wasn't needed this round (no validation states) |
| **Textarea** | **Phase 6b** | Lessons' edit-mode statement field |
| **RadioGroup** | **Phase 6b** | Lessons' edit-mode `lesson_type` picker (3-option enum) |
| **Tabs** | **Phase 6b** | Task detail's Overview/Findings/Artifacts/History; WAI-ARIA roving-tabindex pattern (aria-patterns.md #12) |
| **Popover** | **Phase 6b** | Task detail's Waive confirm (design-spec.md §5.5's documented "single-step Popover, not full AlertDialog" judgment call) |
| **Dialog / AlertDialog** | **Phase 6b** | focus-trapped, Esc closes, focus returns to the triggering element; used by Task detail (artifact lightbox), Lessons (review Dialog, Reject AlertDialog), Errors (detail Dialog) |
| **Toast** | **Phase 6b** | `useToast.ts` composable + one `<Toast/>` region mounted in `App.vue`; `role="status" aria-live="polite"` |
| **Sparkline / LineChart / BarChart** | **Phase 6b** | inline SVG, no charting library; `role="img"` + `aria-label` + `sr-only` data `<table>` per WCAG 1.1.1 |
| DonutChart | Not built | still no ≤5-bucket breakdown identified in v1 — design-spec.md §4's own "vendor it anyway" note not acted on; YAGNI'd both rounds |
| Checkbox / Switch / DropdownMenu / SplitPanel / Callout / FormFooter | Not built | no page in this repo needs them yet (no per-row destructive menu, no standalone form page) |
| Illustration | Phase 6a | one use — Overview's first-run empty state (`coffee.svg`, vendored to `ui/src/assets/illustrations/`) |

Custom, gap components (design-spec.md §6.2, not in the 48-primitive set):
`CausalTimelineList` + `TimelineNodeList` (Timeline row disclosure),
`KanbanBoard` + `TaskCard` (board composition), `ProgressBar` (Overview's
milestone-progress fill/track, and Phase 6b's Roadmap progress cells).
Phase 6b additions: `IdentityChip` (operator directive 2 — deterministic
epic/project identity colour, `ui/src/lib/identityColor.ts`), Flow's custom
DOM task nodes (`FlowPage.vue`'s `#node-task` template, kit tokens only).

## Gates wired

| Gate | Command | Wired |
|---|---|---|
| Hardcode lint | `python3 scripts/design/lint_hardcodes.py ui/src` | **yes, Phase 6b fix-round** — vendored (not a `knowledge/design-system` runtime reference) into `scripts/design/`, wired into `bash scripts/check.sh`. Repo-specific `EXCLUDE_FILES` (documented in the script's own header): the two vendored `ds-tokens.css`/`ds-components.css` assets, and `icons.ts` (raw SVG path data the regex misreads as CSS). Everything else in `ui/src` is clean as of this commit. |
| Contrast | `node scripts/design/contrast_check.mjs` | **yes, Phase 6b fix-round** — a repo-specific script (not the generic one-pair-at-a-time `contrast.py` CLI), reads the real hex values straight from `ui/src/styles/ds-tokens.css` and checks the two pairings this phase's uiux findings flagged: `IdentityChip`'s 8 `--ds-chart-N` border/dot slots and Flow's edge stroke token, both against their surface, in both themes. `ProgressBar`'s fill/track pairing was measured by hand in the 6a round (recorded below) and isn't re-checked by this script — could be folded in later. |
| No-emoji | `python3 scripts/design/check_no_emoji.py ui/src` | **yes, Phase 6b fix-round** — vendored with one adaptation: the em/en-dash "AI-pattern tell" check now skips comment lines (JS `//` and HTML `<!-- -->`) instead of scanning every line of a `.vue`/`.tsx` file — the original flagged 30+ hits, all inside source-code doc comments (this repo's established comment style since Phase 6a), not rendered UI copy; the two genuine UI-copy hits it caught (`ProjectsPage.vue`) were fixed. |
| Token existence | `python3 scripts/design/check_tokens.py ui/src` | **yes, Phase 6b round 7** — repo-authored (no generic design-system-pack equivalent to copy), added after the same invalid-token bug (`--ds-space-5`, never declared, so `padding`/`gap` silently compute to their initial value instead of a build error) shipped twice: round 4's milestone-block padding, round 6's Roadmap SectionHeading gap. Scans every `var(--ds-...)` reference in `ui/src/**/*.{vue,css}` against every `--ds-*` declared in `ds-tokens.css`/`ds-components.css` PLUS every component-scoped runtime definition (a `.vue`'s `:style` object setting a custom property, e.g. `Highlight.vue`'s `--ds-btn-fg`/`--ds-btn-ground`) — both count as "defined", so only a genuinely wrong/missing token name fails. First run caught 8 real instances beyond the two already-known ones: 3 more `--ds-space-5` sites (`.kanban-lane`, `.kanban-lane__columns`, `.ds-dialog`), 3 `--ds-text-lg` sites (no "lg" step in the xs/sm/base/xl/2xl scale — fixed to `--ds-text-xl`), and `--ds-inverse-surface`/`--ds-inverse-text` on `.ds-toast` (never declared anywhere, always silently rendered via their own `var()` fallback — the phantom wrapper was dropped, same rendered result). |
| Adherence lint | none vendored | no — still a gap. The source kit's adherence config was never ported, and re-authoring it needs `oxlint` on the sanctioned dependency list first; `oxlint` also has no `.vue` SFC parser, the same blocker Biome has. |

Three of the four design-system gates are wired as of the Phase 6b fix-round
(closing the 6a-round gap recorded below unedited, for the record).

## Status → Lozenge mapping (app-wide, fixed)

Copied verbatim from design-spec.md §3 — see `ui/src/lib/taxonomy.ts` for the
implementation (unit-tested, `ui/test/taxonomy.test.ts`).

**Evaluative → colour Lozenge:**

| Dimension | Values | Tone |
|---|---|---|
| `task_status` | `todo`, `ready` | neutral |
| | `in-progress`, `grading`, `reviewing`, `merging` | info |
| | `blocked`, `escalated` | warning |
| | `completed`, `waived` | success |
| | `failed` | danger |
| | `superseded` | neutral |
| `plan_status` | `draft` | neutral |
| | `in-review` | info |
| | `active` | success |
| | `superseded` | neutral |
| `run_status` | `queued` | neutral |
| | `running` | info |
| | `done` | success |
| | `dead` | danger |
| `severity` | `S1-stop-the-line` | danger, **bold** |
| | `S2-major` | danger, subtle |
| | `S3-minor` | warning, subtle |
| | `S4-nit` | neutral, subtle |
| `finding_status` | `raised`, `fix-pending`, `fix-landed` | info |
| | `confirmed` | warning |
| | `fix-verified`, `waived` | success |
| | `refuted`, `expired` | neutral |
| `lesson_status` | `candidate`, `novelty-rejected`, `superseded` | neutral |
| | `pending-approval` | warning |
| | `approved` | success |
| | `invalidated` | danger |

**Descriptive → `outline` pill, no colour:** `origin`, `edge_type`,
`edge_provenance`, `lesson_type`, `lesson_scope`.

**Operator-directed exception (Phase 6b round 3, directive 5):** `case`,
`agent` role, and `model_tier` are descriptive dimensions per design-spec.md
§3's original rule above (outline pill, no colour) — the operator
explicitly overrode that for THESE three, wherever they render as a chip
(Kanban `TaskCard`, Task detail's Attempts/Agents/Case fields, Timeline's
`dispatch_decision` rows, Overview's Live-agents/Recent-dispatch rows):
they now use `IdentityChip`, the same deterministic hash(value) ->
`--ds-chart-1..8` accent as `project`/epic ids below (agent role and model
tier share ONE combined "role · tier" chip, hashed on role, so the same
role reads the same colour everywhere it appears). `provider` is
unaffected — still a plain outline pill, not named in the operator's
directive. Status/severity Lozenges are explicitly UNCHANGED — this is a
colour-identity extension for descriptive dimensions only, never a second
vocabulary layered onto the evaluative table above. No new
`contrast_check.mjs` pairing was needed for this reuse (same 8 chart-slot
border/dot checks already cover every value IdentityChip can render,
regardless of which dimension it's hashing); the one genuinely new pairing
this round is Flow's live-indicator dot (`--ds-info-bold` on
`--ds-surface-sunken`), added to that script's matrix (see below).

**Error `group.class`** — icon + plain text, never a colour Lozenge; Errors
page (Phase 6b) uses `taxonomy.ts`'s `errorGroupIcon()`.

**`project` is NOT part of this mapping** (Phase 6b, architecture §8): it is
a plain-string identifier, never a status/evaluative dimension, so it never
gets a colour Lozenge either — it renders via `IdentityChip`
(`ui/src/lib/identityColor.ts`'s deterministic `hash(id) -> --ds-chart-1..8`
slot), the same chart-palette identity system operator directive 2 uses for
epic ids (and, round 3's directive 5, case/agent-role/model-tier — see
above). Identity colour and status colour are visually and semantically
distinct vocabularies on purpose — never conflate a chart-series colour
with a Lozenge tone.

## Reference pages (normative)

`dashboard` variant:

| Template | Reference |
|---|---|
| App shell (+ Phase 6b project switcher) | `ui/src/App.vue` |
| 5A — overview, stat row + rail | `ui/src/pages/OverviewPage.vue` |
| Board composition (flagged §5.3 gap) | `ui/src/pages/KanbanPage.vue` |
| Template 1 shell + custom content zone | `ui/src/pages/TimelinePage.vue` |
| Template 2 (tabs, own-zone-per-tab) | `ui/src/pages/TaskDetailPage.vue` |
| 5A grid-of-cards hub (Phase 6b, no existing template names this exactly — closest fit, flagged) | `ui/src/pages/ProjectsPage.vue` |
| Custom graph composition (Phase 6b gap, §6.2) | `ui/src/pages/FlowPage.vue` |

## Repo-specific patterns

- **Breadcrumb composable:** `ui/src/composables/useBreadcrumb.ts` — each
  page calls `setBreadcrumb()` on mount.
- **Theme composable:** `ui/src/composables/useTheme.ts` —
  localStorage-first, falls back to `prefers-color-scheme`.
- **Poll composable:** `ui/src/composables/usePoll.ts` — Page Visibility API
  pause, used at 5s (the app shell's `/api/pulse`, Overview) and 15s
  (Timeline, Kanban, Sessions) per design-spec §8. Also exports
  `triggerGlobalRefresh()`: the shell's Refresh button sits above the
  router and cannot know what the page under it fetches, so it bumps a
  signal every mounted poller watches.
- **Pulse composable:** `ui/src/composables/usePulse.ts` — the shell's own
  poll, feeding the topbar freshness indicator and the nav arrival badges.
  Its pure half is `ui/src/lib/navBadges.ts`, which is where the
  badge-not-toast argument is recorded and is the only half under test
  (`ui/vitest.config.ts` covers `lib/`, not `composables/`).
- **Viewport composable:** `ui/src/composables/useViewport.ts` — drives
  sidebar collapse (<1024px) and the mobile Sheet (<768px).

## Known deviations

- **2026-08-04 — Biome does not lint or format `.vue` files.** No
  Vue-aware lint plugin (e.g. `eslint-plugin-vue`) was in this dispatch's
  sanctioned dependency list. Biome 2.5.6's recommended ruleset parses only
  the `<script>` block of an SFC, so every prop/emit/import used only in the
  `<template>` block reads as unused — confirmed at scale (24+ false-positive
  errors across nearly every component) before excluding `.vue` from
  `biome.json`'s `files.includes`. `.vue` files still get plain-text review
  and the app's own build/typecheck/e2e gates. Exit plan: adopt a Vue-aware
  linter when one is added to the sanctioned dependency list.
- **2026-08-04 — Icon set extends beyond the kit's vendored 42.** The
  SidebarNav/StatCard/Timeline vocabulary this dashboard needs (`history`,
  `bar-chart-3`, `kanban`, `map`, `graduation-cap`, `bot`, `coins`, `layers`,
  `message-circle`, `send`, `shield-check`, `shield-alert`) is not in
  the kit's vendored 42-icon subset. Added to `ui/src/icons.ts`
  from the same lucide set, same stroke conventions (24×24, stroke 2,
  round caps/joins), not pixel-verified against the real lucide SVGs.
- **CLOSED, Phase 6b — Overview's "Recent dispatch decisions" card.**
  `overview()` now returns `recentDispatches` (10 most recent, newest
  first); the card renders it.
- **CLOSED (mostly), Phase 6b — Kanban's title/agent-role fields and
  "all epics" mode.** `kanban()`'s `epicId` param is now optional and
  `KanbanTask` carries `title`/`agentRole`/`milestoneId`. **Still open:**
  full multi-lane-by-milestone board composition (the wireframe's
  "Milestone: X" sections spanning multiple epics in one board) — the page
  still renders one lane at a time (selected epic, or "All epics"); the
  data now exists (`milestoneId` per task) but composing it into a real
  multi-lane layout is a separately-scoped UI change. An agent Toolbar
  filter is also still not built (agent role is now on `KanbanTask`, but no
  Toolbar control filters by it yet).
- **2026-08-04 — The design's "three independent remote-data zones" rule
  (Overview's stat row / main / rail) is not literally satisfiable.** The
  API has one `overview()` call, not three; all three zones share this
  page's single load/error state. Flagged rather than faked with artificial
  per-zone fetches of the same endpoint.
- **Kanban's board composition** (Template 1 shell + Template 6 full-bleed
  opt-out, no single template covers a board) and the **390px responsive
  floor** — both already flagged as deliberate, reasoned deviations in
  design-spec.md §2/§5.3, not new to this file.
- **2026-08-04 — Timeline's Toolbar filters are simplified.** §5.2 describes
  three `Select` filters (agent role / provider / event type) plus a
  `FilterChips` row over `case`/`severity`/`plan_version`. Shipped instead:
  one text search (matches prompt text and dispatch `reason`, per §5.2's own
  documented fallback) and a `FilterChips` row over event *kind* only.
  `timeline()`'s rows don't carry `case`/`severity`/`plan_version` as
  top-level filterable columns — those live inside each event kind's own
  payload JSON — and agent role/provider are only present on
  `dispatch_decision` payloads, not every row. A real fix needs either a
  richer `timeline()` projection or client-side payload-aware filter
  builders; out of this round's scope.
- **CLOSED, Phase 6b — StatCard delta omission (Active agents / Budget
  used).** `overview()` now scans `events_raw` for a point-in-time snapshot
  (reusing `agents-registry.ts`'s own fold, not a re-derivation) and returns
  `liveAgentCountDelta5m` / `budgetUsedPctPointDelta1h`; both StatCards show
  a real delta. **Still `hint`-only (no query support yet):** Epics in
  flight (vs yesterday) and Alerts (vs yesterday) — those need a
  day-granularity snapshot, not a 5min/1h one; out of this round's scope.
- **2026-08-04 (fix-round) — PROVISIONAL milestone-progress card, now on
  real data.** Overview's "Milestone progress" card and the `ProgressBar`
  gap component (§6.2.3) were flagged PROVISIONAL in design-spec.md §0/§5.1
  pending a `milestones` projection that did not exist yet. That projection
  landed in this same branch (`factory/orchestrator/src/roadmap.ts` +
  `db/projector.ts`'s `projectMilestones()` + `db/queries.ts`'s
  `roadmapPage()`/`overview().milestoneProgress`) — the card now renders
  real `tasksCompleted`/`tasksTotal` per milestone, not placeholder data.
  Still provisional in one sense: milestone-to-epic mapping is manual
  (`factory/specs/roadmap.md`'s `epics:` field), so a milestone with no
  epic tagged to it reports 0/0 until an operator edits the file.

- **2026-08-04 (Phase 6b) — Flow's MiniMap/Controls.** `@vue-flow/minimap`
  and `@vue-flow/controls` are separate npm packages, not in
  `docs/standards/stack.md`'s sanctioned dependency list (only
  `@vue-flow/core` is sanctioned there); stack.md's own policy requires "a
  written justification attached to the epic spec" before deviating, which
  this dispatch has no authority to self-grant. Controls is built instead
  from `@vue-flow/core`'s own `useVueFlow()` viewport methods (zoom in/out,
  fit view) via its `Panel` component — no new dependency. MiniMap is
  skipped rather than faked or silently added.
- **2026-08-04 (Phase 6b) — Flow's checkpoint diamond nodes are not built.**
  The spec calls for diamond nodes representing gate-outcome checkpoints in
  the DAG; this round renders task nodes only (styled per the spec) and
  edges. `flowGraph()`'s response has no gate/checkpoint node shape yet —
  would need a new node kind in the query, not just the page.
- **2026-08-04 (Phase 6b) — Flow's plan-version diff is approximate.** The
  spec asks for "rendering added (chart-token outline) vs superseded
  (muted) diff" across plan versions. `tasks` is a single-row-per-task_id
  projection (Phase 5 design) — a task superseded at plan v(n+1) overwrites
  its own row rather than leaving v(n)'s row queryable, so there is no
  persisted "what did version N actually look like" to diff against byte-
  exact. The plan-version `Select` re-queries `flowGraph()` filtered to the
  chosen version's tasks and relies on `task_status === 'superseded'` for
  the muted/added visual split — an honest approximation given the current
  data model, not a full historical diff.
- **2026-08-04 (Phase 6b) — Analytics'/Lessons' project scoping is
  partial.** `analytics()`'s `throughput`/`recheckOutcomes` (task-table-
  derived) are project-scoped via the same `allTasksForScope()` helper as
  every other page; `costByModelTierAndProvider`/`sameMistakeRateByDay`
  (derived straight from `events_raw` `task-result-recorded`/
  `severity-decisions` payloads, not from the `tasks` table) are NOT yet
  project-filtered — same gap as `errorsPage()`'s pre-6b `byClass`/`byDay`
  had before this round widened `errors`'s own project column; those two
  analytics shapes read `eventsRaw` directly and would need the same
  `filterByProject()` pass. `lessonsPage()` is not project-scoped at all —
  `lessons` was intentionally left off the explicit "tasks/dispatches/
  errors/findings/milestones/events_raw" project-column list this task's
  brief named, since Phase 7 owns the real lessons loop's data model.
- **2026-08-04 (Phase 6b) — Timeline's "Decisions" lens omits plan
  sign-offs.** The operator's own description names "plan sign-offs" as a
  decision kind; this codebase has no event distinguishing an operator's
  plan-version sign-off from the planner's own automatic version cut (no
  `actor` differentiation exists on `plan-version-created`/`-superseded`
  today). The lens covers `user_prompt` + `waiver-granted`/`-denied` +
  `lesson-status-changed` (all reliably operator-attributed via the new
  `events_raw.actor` column) — flagged rather than guessed at a new event
  semantic.

- **2026-08-11 (Phase 6b round 6) — Roadmap is a VueFlow graph; §5.4's
  table/card layout is superseded, not deviated from.** design-spec.md
  §A.4-5 records the new shape. Same two flags as Flow carry over
  unchanged: no MiniMap and no `@vue-flow/controls` (viewport controls
  rebuilt from `useVueFlow()` in a `Panel`). One deviation is specific to
  this page: **edges are "next in sequence", not real dependencies.**
  `MilestoneProgress` has a `sequence` field and no dependency field, so a
  chain per project lane is the only edge the API can honestly justify —
  a milestone DAG would need the roadmap projection to carry
  `depends_on`, which it does not.
- **2026-08-11 (Phase 6b round 6) — Flow node labels are summarised.**
  Operator directive 6 ("một block bị quá dài… chỉ cần tóm tắt ngắn"). The
  node shows `summarize(title)`; the full `tasks.objective` stays in the
  node's native tooltip, the `sr-only` table, and Task detail. This is a
  deliberate lossy render, flagged because §A.2's wireframe says "title"
  without qualifying it.
- **2026-08-11 (Phase 6b round 7) — "real-time" means a graded polling
  indicator, not push.** Operator directive 7 asked for "một dạng real-time
  update"; design-spec.md §8's no-WebSockets reasoning is unchanged, so
  what shipped is `LiveStatus.vue` + `lib/liveness.ts` grading the age of
  the last *successful* load against the poll interval
  (live/lagging/stale/connecting), plus `formatElapsed()` runtimes on every
  live-agent row and a 1s `useNow()` clock so those ages move between
  fetches. Sub-second push is still out of scope, and this is honest about
  that: the label states the age rather than implying a live socket.
- **2026-08-11 (Phase 6b round 7) — the freshness label is deliberately
  not an `aria-live` region.** It re-renders once per second, so a polite
  live region would queue an announcement per tick and bury the rest of
  the page. Screen-reader users get the same information as plain text
  (with the full timestamp in the element's `title`) and an explicitly
  named "Refresh now" button; a WCAG 4.1.3 status-message treatment would
  need a debounced, state-change-only announcement, which is a separately
  scoped change.
- **2026-08-11 (Phase 6b round 7) — `usePoll` now refetches on tab
  re-show, for every page that uses it.** Previously returning to a tab
  hidden for an hour showed hour-old data for a further interval with
  nothing saying so. This changes Timeline and Kanban behaviour too, by
  design, not as a side effect.
- **2026-08-11 (Phase 6b round 8) — Roadmap edges are `straight`, not the
  default bezier.** Operator: "hiển thị line nối giữa các node thẳng". The
  bezier was not a styling choice, it was the Vue Flow default, and it only
  renders as a straight line when both handles share a `y`. Milestone nodes
  are content-sized, so same-lane nodes share a top edge but not a height —
  the handles were offset and the connector bowed. The edge type lives in
  `lib/roadmapFlow.ts` with the layout, so it is unit-tested rather than
  only visible in a screenshot.
- **2026-08-11 (Phase 6b round 8) — the in-progress milestone node pulses,
  reversing round 3's "never animate the node itself".** That earlier
  ruling was specifically about *opacity*: pulsing a node full of text
  oscillates the contrast of every word inside it, which is why Flow's
  pulse moved onto a 6px dot. A ring drawn outside the border does not
  touch text contrast, so `.roadmap-node--live` animates `box-shadow` only,
  through its own `ds-ring-pulse` keyframe. Flow's `.flow-node__live-dot`
  is untouched — it marks a live *agent*, a different claim. Under
  `prefers-reduced-motion` the ring is frozen at its start radius rather
  than removed, so reduced-motion users do not get a *less* prominent live
  node than everyone else.
- **2026-08-27 (shell liveness round) — "did something just happen" is a
  badge, not a toast.** Operator directive 9 asked for a toast on each
  event/trigger/dispatch "để hệ thống có cảm giác đang chạy". Declined, on
  transport grounds rather than taste: `useToast` already means "*your*
  action landed" (Task detail waive/deny, Lessons approve/reject) and a
  toast the operator did not cause overloads it; the data arrives by poll,
  so a diff-fired toast reports when the poll noticed rather than when the
  thing happened, and a wave landing ten events between two ticks either
  storms the corner or lies about the count; and `usePoll` pauses on a
  hidden tab, which makes a toast lossy for something the event log records
  durably. What shipped is a surface the operator can come back to — nav
  arrival badges (`lib/navBadges.ts`, where this argument is also kept, next
  to the code that would have to be undone to reverse it).
- **2026-08-27 (shell liveness round) — `LiveStatus` moved from Overview
  into the topbar, and gained a second clock.** Round 7 put it on Overview
  only; every page polls, and on the other nine a frozen server looked
  exactly like a quiet factory. It is now fed by one shell-level 5s
  `/api/pulse` poll. Beside it, `lastEventLabel()` — `livenessLabel()`
  answers "is my screen current", this answers "is the factory moving", and
  a healthy server reports `Live` indefinitely over a factory that has
  emitted nothing since Tuesday. Both shown; neither implies the other.
  Hidden below 768px, where the topbar has no room. This supersedes
  design-spec §2's "Right: theme toggle only".
- **2026-08-27 (shell liveness round) — only monotonic counters get an
  arrival badge.** Timeline and Errors badge the difference between the
  current poll and the counter as of the last time the operator opened that
  page. Lessons badges its pending *level*, drawn as itself, because
  approving one makes it fall and "-1 new" is not a thing that can have
  arrived. `arrivalsSince()` clamps at zero anyway, as a backstop for a
  projection rebuild the shell cannot see. A first poll with no baseline
  badges nothing — everything already in the log is history, and badging it
  would greet the operator with "99+ new" on every cold open.
- **2026-08-27 (shell liveness round) — the collapsed rail draws a dot, and
  the number lives in the accessible name.** The 64px icon rail has no room
  for `99+`, so it keeps only the fact that something is waiting. Expanded
  or collapsed, the badge glyph is `aria-hidden` and the count reaches a
  screen reader through the button's `aria-label` — "Timeline, 3 new",
  "Lessons, 3 pending" — because a bare `3` is not a claim. Same reasoning
  as round 7's freshness label: the number is never *only* in a glyph.
- **2026-08-27 (shell liveness round) — the shell's Refresh wakes every
  mounted poller, via a signal in `usePoll` rather than per-page wiring.**
  Hoisting `LiveStatus` above the router would have made its Refresh button
  a lie: it would reload the shell's pulse and leave the page under it
  untouched. `usePoll` now owns a module-level counter that
  `triggerGlobalRefresh()` bumps and every poller watches, so Overview,
  Timeline, Kanban and Sessions answer it with no edits of their own. The
  watcher is registered inside `usePoll`'s setup call, so Vue's effect scope
  disposes it with the component — an unmounted page cannot be woken.

**Verification** (per the design spec's own verification protocol):
- Contrast on `ProgressBar`'s fill/track pairing (`--ds-info-bold` fill on
  `--ds-surface-sunken` track): **measured 2026-08-04 — light 4.95:1, dark
  3.43:1.** Both pass WCAG 1.4.11 (non-text contrast, 3:1 minimum for UI
  components). Closed.
- **IdentityChip border/dot + Flow edge stroke (Phase 6b fix-round,
  2026-08-04): measured via `node scripts/design/contrast_check.mjs`, all
  18 pairs (8 chart slots x 2 themes + Flow edge x 2 themes) pass the 3:1
  UI-graphics floor** — full matrix:

  | Pair | Light | Dark |
  |---|---|---|
  | chart-1 border/dot vs surface | 5.17:1 | 3.85:1 |
  | chart-2 border/dot vs surface | 3.09:1 | 6.44:1 |
  | chart-3 border/dot vs surface | 3.39:1 | 5.88:1 |
  | chart-4 border/dot vs surface | 4.82:1 | 4.13:1 |
  | chart-5 border/dot vs surface | 5.70:1 | 3.49:1 |
  | chart-6 border/dot vs surface | 3.68:1 | 5.40:1 |
  | chart-7 border/dot vs surface | 5.02:1 | 3.96:1 |
  | chart-8 border/dot vs surface | 4.76:1 | 4.18:1 |
  | Flow edge stroke (`--ds-text-subtlest`) vs surface-sunken | 4.63:1 | 6.91:1 |

  (`IdentityChip`'s label TEXT is `--ds-text-subtlest` against the page
  surface, not a chart token — 4.83:1 light / 7.76:1 dark, already AA
  normal-text-verified as a token-level pairing used elsewhere in this app;
  not re-measured per-slot since it's slot-independent by construction.)
- **Flow live-indicator dot (Phase 6b round 3, operator directive 1,
  2026-08-04): `--ds-info-bold` on `--ds-surface-sunken`, added to
  `contrast_check.mjs`'s matrix — light 4.95:1, dark 3.43:1, both clear the
  3:1 UI-graphics floor.** Not a new colour pairing at the token level —
  it's the exact same pair as `ProgressBar`'s fill/track, hand-verified
  above; this just adds automated coverage for the new usage.
- **Chip identity-accent extension (Phase 6b round 3, operator directive
  5, 2026-08-04): no new `contrast_check.mjs` pairing required.**
  `case`/`agent`-role/`model_tier` chips (Kanban, Task detail, Timeline,
  Overview) reuse `IdentityChip` unchanged — same 8 chart-slot border/dot
  checks above already cover every value it can render, since the check is
  against the chart TOKEN, not the specific string being hashed.
- **LiveStatus freshness dot (Phase 6b round 7, operator directive 7,
  2026-08-11): three new colour-against-background pairings added to
  `contrast_check.mjs`; all six (3 states × 2 themes) clear the 3:1
  UI-graphics floor** — `--ds-success-bold` on `--ds-surface` 5.02:1 light
  / 3.97:1 dark, `--ds-warning-bold` 3.19:1 / 6.24:1, `--ds-danger-bold`
  4.83:1 / 4.12:1. Run: `node scripts/design/contrast_check.mjs` — 30 pairs
  checked, 0 failures. Colour is not the only channel: the state word is in
  the adjacent label. Roadmap's new canvas needed no new pair — its edge
  stroke/background is the same `--ds-text-subtlest` on
  `--ds-surface-sunken` already measured above for Flow.
- **Live node border/ring, inward side (Phase 6b round 8, operator
  directive 8, 2026-08-11): `--ds-info-bold` on `--ds-surface` — light
  5.17:1, dark 3.85:1, both clear the 3:1 UI-graphics floor.** Run: `node
  scripts/design/contrast_check.mjs` — 32 pairs checked, 0 failures. This
  pair had gone unmeasured since round 3: check 3 covers `--ds-info-bold`
  against the *canvas* (`--ds-surface-sunken`, the outward side of the
  border and where the ring is painted), but the same border against the
  node's own `--ds-surface` was never checked, on Roadmap or on Flow. It
  matters now because round 8 makes that border the static,
  reduced-motion-safe half of a state signal rather than decoration.
- **Nav arrival badges and the topbar pulse (shell liveness round,
  operator directive 9, 2026-08-27): three new pairings, all clear.** The
  expanded badge's count is real text, so it takes the 4.5:1 floor:
  `--ds-text-on-bold` on `--ds-info-bold` — 5.17:1 in *both* themes, since
  that token is `#2563eb` either way. That is also why the badge is not
  `--ds-primary`, the obvious choice: identical in light theme, but
  `--ds-primary` lightens in dark and drops white text to 3.68:1, under the
  floor. The collapsed rail's dot is a UI graphic: `--ds-info-bold` on
  `--ds-surface-sunken` — 4.95:1 light / 3.43:1 dark. The dot is painted
  with a 2px ring in that same sunken surface precisely so this is the pair
  that applies — it can sit on an active item, whose `--ds-primary-subtle`
  tint would put it at 2.84:1 in dark, under the 3:1 floor. The topbar
  pulse readout is `--ds-text-subtle` on `--ds-surface` — 7.73:1 light /
  13.46:1 dark, measured at the text floor rather than waved through as
  decoration. Run: `node scripts/design/contrast_check.mjs` — 48 pairs
  checked, 0 failures.
- Not yet run: a real-browser check of both themes at 1280px/1024px/390px
  beyond what Playwright's screenshots capture; the oxlint adherence gate
  (still blocked on a sanctioned-dependency addition, see "Gates wired").
