# Design — the Blacksmith dashboard

The dashboard ships its own design kit, and it is complete inside this
repository: tokens in [`bs-tokens.css`](../src/styles/bs-tokens.css),
component CSS in [`bs-primitives.css`](../src/styles/bs-primitives.css), and
the Vue primitives under [`ui/src/components/kit/`](../src/components/kit/).
Nothing under `ui/` reaches outside this repository at build or run time, and
nothing here needs an account, a token, or a second clone. This file is the
kit's rulebook: on conflict between it and any older note below, this file
wins, because there is no upstream left to defer to.

**Provenance.** This kit (the "BS kit": `bs-` prefixed tokens and classes)
was authored in-repo, 2026-09-30, supersedes the HDS-derived kit retired the
same day — see git history for the prior file if a comparison is ever
needed. Every token in `bs-tokens.css` and every primitive under
`ui/src/components/kit/` was authored directly for this dashboard's own
redesign, not ported from an external design-system package — there is no
`knowledge/design-system/…` dependency to note here, unlike the kit this one
replaces. As of this PR (DS0, the redesign spec's §5 build order) the kit is
additive and inert: it ships beside the old kit, fully restyled and
gate-checked, but no page imports it yet — see "Reference pages" below.

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
- **Tokens copy:** `ui/src/styles/bs-tokens.css`, authored in-repo
  2026-09-30 (DS0) — not copied from any external file; see Provenance
  above. Component CSS lives beside it in `ui/src/styles/bs-primitives.css`.
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
  see "Verification" below).

## Primitive inventory (closed set)

Vendored under `ui/src/components/kit/`. This is the redesign spec's §2.1
list, built in DS0 (four batches over 2026-09-30) except `SectionHeading`
— see "Known deviations". Restyled on `bs-tokens.css`, gate-checked. DS1
(below) wires the shell-level rows (`SidebarNav`, `LiveIndicator`,
`ProjectSwitcher`, `Sheet`, `Breadcrumb`, plus the mobile-only
`MobileTopBar`/`MobileTabBar`) into `App.vue`; every other row stays
additive and inert until a page-wiring PR imports it.

| Primitive | Notes |
|---|---|
| Button | `variant: primary\|secondary\|ghost\|danger\|link`, `size: sm\|md`, optional leading `icon` |
| Icon | rebuilt on `@lucide/vue` (the old kit's hand-kept `icons.ts` SVG registry is retired); `size: 14\|16\|20`, stroke 1.75 at 14/16, 1.5 at 20 |
| IconButton | `label` required (no default — a missing one is a type error); additive `tone: default\|inverse` for controls on an inverted surface (Toast's dismiss button); `lint_icon_only.py` gate-enforces the label requirement on every call site, see "Gates wired" |
| Tooltip | rebuilt on `@floating-ui/dom`; `mode: describe\|label`; hover after 300ms, focus immediately, Escape dismisses |
| Tag | Lozenge's renamed successor (see "Status → Tag mapping"); `tone` covers the 7 status tones plus `neutral`; `variant: subtle\|bold\|outline` — `bold` reuses the tone's own text/subtle token pair as a solid fill (no third "-bold" token tier exists in `bs-tokens.css`) rather than inventing one, see Known deviations |
| Chip | `variant: assignee\|identity`, `color?: 1-6` indexes `--bs-chart-N` for the identity dot/border |
| Card | `padding: sm\|md\|lg`, `interactive?` |
| Input / Textarea / Select / RadioGroup | unchanged contract from the old kit, restyled |
| Dialog / AlertDialog / Popover / Toast | unchanged behaviour (focus trap, Esc, `role="status"`/`aria-live`), restyled |
| Tabs | unchanged (roving-tabindex, WAI-ARIA Tabs pattern); `:focus-visible` now uses the kit's shared box-shadow ring, not the old outline-based one — no `--bs-focus-width` token exists here, see Known deviations |
| Table | adds a `compact` density prop, absorbing the old kit's `Row`/`RowList` (see Known deviations) |
| Skeleton | `shape: line\|block\|circle`, `width?`, `height?` |
| EmptyState | `icon`, `title`, `body`; `action` is a named slot, not a prop |
| Banner | `tone: info\|warning\|danger`, `collapsible?` |
| PageHeader / Breadcrumb / Separator | ported, restyled |
| ProgressRing | 20px inline SVG ring (`r=8`, `pathLength=100`, 2.5px stroke), `.bs-pring`; additive `kind: budget\|ratio` (default `ratio`) selects the auto-tone threshold rule, additive `detail?` shows a describe-mode Tooltip with exact values when given — see Known deviations for the spec-vs-mockup sizing disagreement |
| ProgressBarMini | same contract and additive props as ProgressRing, `.pmini`/`.bs-pnum`, 56×6px track |
| ProgressBar | `segments: [{tone, value}]`, stacked; `.bs-pbar`/`.bs-pbar__seg` — no old-kit predecessor, class names newly invented (see Known deviations) |
| BarChart | gains additive `stacked`/`series`/`stackedBars` for a per-series stacked path (see Known deviations); otherwise ported |
| LineChart / Sparkline | ported (inline SVG, `role="img"` + `aria-label` + sr-only `<table>`); both, plus BarChart, now REQUIRE a `takeaway` prop (one-line prose summary) per the redesign spec's chart contract; Sparkline gains a wrapper `<div class="bs-chart bs-chart--spark">` to hold it (see Known deviations) |
| CompactNumber | `value`, `unit?: "tok"` — renders "1.2M tokens", "127K", "43" |
| RelativeTime | `iso`, `now?` (test seam); renders relative text in a `<time>`, absolute time in a describe-mode Tooltip |

Non-component shared files: `kit/types.ts` (shared prop/type definitions
used across the primitives above) and `kit/progressTone.ts` (the
tone-threshold and colour logic shared by `ProgressRing`/`ProgressBarMini`,
see its own header comment for the rationale).

## Gates wired

| Gate | Command | Wired |
|---|---|---|
| Hardcode lint | `python3 scripts/design/lint_hardcodes.py ui/src` | yes — `EXCLUDE_FILES` covers both kits' token/component CSS (`ds-tokens.css`/`ds-components.css`/`bs-tokens.css`/`bs-primitives.css`) plus `icons.ts`; escape hatch `ds-allow-hardcode` (unchanged name — a gate-authoring convention, not a token, kept the same for both kits) |
| Contrast | `node scripts/design/contrast_check.mjs` | yes — reads both `ds-tokens.css` and `bs-tokens.css` and checks pairs from each; the DS0 pairing set covers status-tag text/subtle × 7 tones × 2 themes, the live-indicator dot, roadmap now-line/pulsing dot, the Kanban assignee-chip text, 9 event-kind text/subtle pairs, event stripe/icon vs `--bs-surface-raised` at the 3:1 UI-graphic floor, and Prompt-row text/subtle/link vs `--bs-surface-sunken`, alongside the old kit's still-passing pairs |
| No-emoji | `python3 scripts/design/check_no_emoji.py ui/src` | yes — unchanged; scans by path, not by token/file name, so no bs- adaptation was needed |
| Token existence | `python3 scripts/design/check_tokens.py ui/src` | yes — `TOKEN_FILES`/`DEFINE_RE`/`JS_DEFINE_RE` accept both `ds-` and `bs-` prefixed tokens; escape hatch `ds-allow-undefined-token` (unchanged name, same convention as above) |
| Icon-only-control lint | `python3 scripts/design/lint_icon_only.py ui/src` | yes, new in DS0 — flags an `IconButton` call site without a `label`/`:label` and any icon-only `<button>`/`<a>` (rendering a single `<Icon>` and nothing else) without `aria-label`/`:aria-label` |
| Adherence lint | none vendored | no — still a gap, unchanged from the prior kit (see git history) |

All five wired gates run against **both** kits' files in the same pass —
`bash scripts/check.sh`'s design-system block did not need to change to add
the BS kit, only the scripts' own internals did.

## Status → Tag mapping

Not yet authored. `Tag.vue`'s `tone` prop (`done|review|progress|todo|
blocked|danger|warning|neutral`) is `Lozenge`'s named successor, but the
actual dimension → tone mapping (the old kit's evaluative/descriptive split,
`IdentityChip` interplay, the operator-directed exceptions, etc.) is
page-wiring-dependent: `ui/src/lib/taxonomy.ts` still drives every live page
against the old kit, unchanged by this PR. This section gets written when a
page-wiring PR migrates a page off `ui/src/components/ds/` onto `kit/`.

## Reference pages (normative)

None yet for page bodies. DS1 (below) wires the app shell — every page still
renders through `ui/src/components/ds/` inside it, unchanged. This table
gets its first row when a page-wiring PR migrates a page's own body onto
`kit/`, per the redesign spec's §5 build order.

## App shell (DS1)

`ui/src/App.vue` is rebuilt on the BS kit (ds-spec.md §3, §3.1): `SidebarNav`
(5 items — Home, Work, Activity, Cost & quality, Lessons — collapsible rail
≥1024px, off-canvas `Sheet` <768px), a topbar (`Breadcrumb` driven by
`router.ts`'s `meta.crumb`, `ProjectSwitcher`, `LiveIndicator` owning the
single Refresh + pause/theme/settings controls), and a phone shell ≤640px
(`MobileTopBar` + `MobileTabBar` + overflow menu). The 5 nav items route to
the existing pages (Home → Overview, Work → Kanban, Activity → Timeline,
Cost & quality → Analytics, Lessons → Lessons); every old route and deep
link keeps working, and page bodies are unrestyled — DS1 is shell-only.

`router.ts` carries `meta.crumb` on every named route so the topbar
breadcrumb derives from the route the instant navigation happens, not from a
page's fetched payload (§3's loading/empty/error pattern at shell level).
`usePoll.ts` gained `setLive`/`getIsLive`, a module-level flag `LiveIndicator`
Pause reads and writes, standing down the shared interval/stream triggers
app-wide without touching manual Refresh.

The old `ds/SidebarNav.vue`'s brand mark (`assets/brand/mark-96.png`) carries
over into `kit/SidebarNav.vue` unchanged — DS1 did not intend to drop the
app's identity mark, only the old two-clock topbar and per-page badges/
categories, neither of which the redesign spec's shell prop table carries.

The old `ds/` shell files (`ds/SidebarNav.vue`, the old `App.vue` topbar
markup) stay in the tree; DS9 deletes them.

## Repo-specific patterns

- **Breadcrumb composable:** `ui/src/composables/useBreadcrumb.ts` — each
  page calls `setBreadcrumb()` on mount.
- **Theme composable:** `ui/src/composables/useTheme.ts` —
  localStorage-first, falls back to `prefers-color-scheme`.
- **Poll composable:** `ui/src/composables/usePoll.ts` — Page Visibility API
  pause, used at 5s (the app shell's `/api/pulse`, Overview, Sessions) and 15s
  (Timeline, Kanban, Projects, Flow) per design-spec §8. Also exports
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

None of these composables changed for DS0 — the kit swap is presentational.

## Known deviations

- **Dark theme keys on `.dark`, not `data-theme` or an OS media query.**
  The redesign spec's §1.2 contradicts itself — its heading says "declared
  twice... under `@media (prefers-color-scheme: dark)`... once under the
  explicit `data-theme` attribute", but the app's real toggle
  (`ui/src/composables/useTheme.ts`) sets/clears a `.dark` class on
  `<html>`; no `data-theme` attribute exists anywhere in this codebase.
  `bs-tokens.css` declares one `:root.dark { ... }` block, matching the
  mechanism `ds-tokens.css` already uses for the old kit (`.dark {}`, no
  OS-preference fallback there either) — so a user's explicit light/dark
  choice is never overridden by their OS setting, and the two kits cannot
  drift into disagreeing about which selector means "dark".
- **Button's `disabled`/`loading` use `aria-disabled` + a click guard, never
  the native `disabled` attribute** — same reasoning `IconButton` already
  documents for its own `disabled?` prop: a natively disabled button drops
  out of the tab order and, if it was the focused element when loading
  started (the common submit-then-loading case), loses focus entirely. The
  loading label stays in the DOM with `opacity: 0` rather than
  `visibility: hidden` for the same reason — `visibility: hidden` removes an
  element from the accessibility tree, which would leave a loading button
  with no accessible name; `opacity: 0` keeps the label announced (paired
  with `aria-busy="true"`) while staying visually invisible and keeping its
  layout box, so the width-lock trick is unaffected.
- **Tag's `info` tone has no dedicated hex.** `IconButton`/`Banner`'s
  `tone: info|warning|danger` needs an `info` colour, but the redesign
  spec's 7-tone table (`done/review/progress/todo/blocked/danger/warning`)
  has no `info` row. `--bs-tone-info-text`/`-subtle` reuse `progress`'s blue
  — the least alarming, bluest tone already in the palette and already
  contrast-checked — rather than adding an eighth hue. Flagged as a spec
  gap; see `bs-tokens.css`'s own comment.
- **Tag's `neutral` tone likewise has no dedicated hex.** `Tag`'s prop list
  adds an 8th tone, `neutral`, not in the same 7-tone table.
  `--bs-tone-neutral-text`/`-subtle` alias directly to the existing
  `--bs-text-subtle`/`--bs-surface-sunken` pair (already contrast-checked)
  rather than picking a second, deliberately-similar grey.
- **Tag's `bold` variant has no third fill tier.** The old kit's Lozenge
  read a `-bold` background token plus a separate `-on-bold` foreground
  token; `bs-tokens.css` carries no such tier. `bold` instead uses the
  tone's own `-text` colour as a solid background with the `-subtle` tint
  (already a pale version of the same hue) as foreground — monochromatic,
  no new hex measured.
- **IconButton's `tone: 'default'|'inverse'` is additive**, not in the
  spec's props table — needed for `IconButton`s sitting on a deliberately
  inverted surface (`Toast`'s dismiss button: `background: var(--bs-text)`)
  where the default tone's colour would render as a dim grey icon.
- **ProgressRing/ProgressBarMini's `kind`/`detail` are additive.** `kind:
  budget|ratio` (default `ratio`) selects which auto-tone threshold rule
  applies when `tone` is omitted — a budget can exceed 100% (a real,
  meaningful "over budget" state), a plain ratio cannot by definition — and
  neither `value`/`max`/`label` lets a component tell which rule applies on
  its own. `detail?` renders a describe-mode Tooltip with the exact values
  the spec's prose describes (e.g. "127,402,118 of 180,000,000 tokens
  (71%)"), a sentence the component cannot derive from its other props and
  that is not itself in the props table; omitted, no Tooltip renders rather
  than one with misleading content. Centralized in `kit/progressTone.ts` so
  both components share one set of thresholds.
- **ProgressRing sizing: spec prose vs. mockup CSS disagree.** The
  redesign spec's literal prose gives a 20px ring, `r=8`, `pathLength=100`,
  2.5px stroke — the visual reference's own CSS instead defaults to
  18px/3px stroke, plus an undocumented `.pring.lg` 20px modifier, and no
  `size` prop appears anywhere in the spec's props table. Built at the
  spec prose's literal numbers; no `size`/`lg` prop was added. Flagged as a
  spec-vs-mockup mismatch rather than silently resolved either way.
- **ProgressBar's percentage read is deliberately unclamped.** The ring's
  visual fill is clamped 0-100 (it cannot draw past a full circle), but the
  percentage number beside it is not — a budget past 100% still reports its
  true value, e.g. "103%", per the spec's own worked example.
- **ProgressBar (`segments`) has no old-kit predecessor.** No stacked-bar
  markup exists in the visual reference to port from; its `.bs-pbar`/
  `.bs-pbar__seg` class names are new, not a port.
- **`.pring`/`.trk`/`.fil`/`.pnum`/`.pbar` were un-namespaced** (S3-3 review
  finding — contradicted this file's own "bs-* only" header). Renamed to
  `.bs-pring`/`.bs-trk`/`.bs-fil`/`.bs-pnum`/`.bs-pbar` (and its
  `.bs-pbar__seg` element). `.pmini`/`.ptrack` are unchanged — the finding
  named only those five. The ring's own `.bs-pnum` was also brought onto its
  own spec row (14px/400/`--bs-text`, §2.1) rather than ProgressBarMini's
  (12px/`--bs-text-subtle`), which it had been copying.
- **BarChart's `stacked`/`series`/`stackedBars` are additive and
  under-specified** — the spec names the prop shape but has no stacked-bar
  mockup or prose to port from. Minimal decision: a second, mutually
  exclusive render path selected by `stacked`, reusing the same column/
  track/x-axis structure with one `.bs-bars__bar--stack` segment per
  series, positioned by cumulative offset; segment colour comes from the
  caller-supplied `series[].tone`, the same tone-to-colour approach as
  `ProgressBar`.
- **The chart token palette shrank from 8 slots to 6** (`--bs-chart-1..6`
  replace the old kit's 8). `BarChart`/`LineChart`/`Sparkline` remain
  single-series by default (only `--bs-chart-1` is ever referenced in
  `bs-primitives.css`), so the narrower set doesn't block anything;
  `BarChart`'s stacked path takes its per-series colour from the caller's
  `series[].tone` instead of a chart-N token.
- **Sparkline gains a wrapper div.** The old component's root was a bare
  `<svg>`, with nowhere to put the now-required `takeaway` paragraph.
  `bs-chart--spark` keeps the wrapper's width auto/inline instead of the
  full-width column layout `BarChart`/`LineChart` use, preserving
  Sparkline's fixed 80×24 inline-trend sizing.
- **The old kit's `var(--bs-radius-sm, 4px)` fallback is dropped** from the
  ported chart CSS: `bs-tokens.css` always defines `--bs-radius-sm`, unlike
  the old kit's token file, so the fallback was dead weight.
- **Tabs' `:focus-visible` ring changed shape, not behaviour.** It now uses
  this kit's shared box-shadow focus ring instead of the old kit's
  outline-based one — there is no `--bs-focus-width` token in this palette
  to reproduce the old rule with.
- **Table absorbs Row/RowList's density switch.** The redesign spec folds
  the old kit's separate `Row`/`RowList` components into `Table`'s new
  `compact` prop ("two components doing one job") rather than porting them
  as their own primitives.
- **`SectionHeading` was not built — the spec contradicts itself on it.**
  §2.1's primitive table lists `SectionHeading` alongside `PageHeader`/
  `Breadcrumb`/`Separator` as "ported, re-styled", but the old→new mapping
  table (§2.3) marks it "none (unused, per DESIGN.md) — dropped, not
  ported". This build followed §2.3: no `SectionHeading.vue` exists under
  `kit/`, consistent with the old kit's own note that it was never used by
  any page. Flagged here rather than silently resolved either way — worth
  an explicit call before a page ever needs it.
- **§2.2 composites and §2.3-only primitives are out of DS0's scope.**
  `TaskCard`, `KanbanBoard`, `TimelineRow`, `IdentityChip`, `WaveList`,
  `RoadmapSwimlane`, `EpicBlock`, `AgentBlock`, and the rest of §2.2, plus
  primitives that appear only in §2.3's migration table and never in §2.1's
  own list (`MetricGrid`, `FilterChips`, `Sheet`, `StatCard`, `TwoColumn`,
  `Toolbar`) were not built here. §2.1 is this PR's exact boundary; the
  rest arrive with the page-wiring PRs that actually need them.
- **This kit has no e2e surface yet.** DS0 is additive and inert — no page
  imports `ui/src/components/kit/*` (verified: no
  `from '.*kit/'` reference exists outside `kit/` itself) — so Playwright
  has nothing of this kit's to exercise yet. That arrives with the first
  page-wiring PR.
- **Mobile overflow menu's page view options and "Open desktop view" are
  out of DS1 scope.** ds-spec.md §3.1 describes the ≤640px overflow menu as
  also carrying page-specific view options and a way back to the desktop
  layout; DS1 only wires the shell-level controls (Pause, theme, Settings)
  that `LiveIndicator` already owns. Page view options belong to each page's
  own DS; "Open desktop view" has no viewport-override mechanism yet.
  Deferred, not dropped.
- **Roadmap's epic-block session scoping is out of DS1 scope.** ds-spec.md
  §3 scopes the topbar session picker into Activity and "the epic block on
  Work → Roadmap"; DS1 makes the picker visible on both routes
  (`SESSION_SCOPABLE_ROUTES` in `lib/sessionScope.ts`) but `RoadmapPage.vue`
  does not yet read `useSessionContext()` — there is no epic block to scope
  yet. Likewise the picker's derived run titles and its 25-cap "Show more"
  affordance are unbuilt; `sessionOptions()` today just truncates at the cap
  silently. Both belong to the DS that builds the epic block.
- **Home's "Recent activity" section (ds-spec.md §4.1 point 1b) is
  deferred to DS6.** It needs the plain-language event lines DS6 builds for
  Activity; DS2 ships Home without the section rather than with raw event
  names. Deferred, not dropped.
- **Home's inbox is not the full §2.2 pattern yet.** It shows three kinds
  (waivers, escalations, lesson candidates); stop points, the unread dot and
  read-state weight (pattern 12) have no server source yet. Row titles are
  the server's task text, not a per-kind sentence.
- **Home's "Just finished" is per tab, not per operator session.** It lists
  closed epics this tab saw in flight since it loaded; a reload starts it
  empty. It sits under Running now rather than inside each project card,
  because a closed epic carries no project.
- **Home's budget outlier threshold (10x an epic's budget) is ours.**
  §4.1 point 4 names the case but no number. Outliers are left out of the
  ring and the total; the server's hour-over-hour delta still includes them.
- **Running now reads a new `epicsActivelyRunning` field, not
  `epicsInFlight`.** `epicsInFlight` keeps an epic whose only open task is
  `escalated`/`failed` reachable on Kanban/Flow (D-43/P9-27) — correct, an
  operator still needs to act on it, and that must not change. But nothing
  is actually running in it, so presenting it on "Running now" reads as a
  live agent that does not exist. `GET /api/overview` (whole-factory and
  per-project summaries) now also reports `epicsActivelyRunning`:
  `epicsInFlight` narrowed to epics with a task in a truly open status
  (`db/queries.ts`'s `activeEpics()`, the complement of
  `TERMINAL_TASK_STATUSES`). Home's "Running now" reads the narrower field;
  the escalated-only epic still surfaces under Needs you.

## Verification

As of the DS0 PR (2026-09-30): `pnpm run test:ui` — 74 test files, 891
tests, all passing (component tests are static source-text assertions
against `ui/vitest.config.ts`'s DOM-free `node` environment, not
`@vue/test-utils` mounts — see that config's own comment). All five wired
gates pass scanning both kits together: `check_tokens.py` (93 files, 1190
`var(--ds-/bs-...)` references, 228 declared tokens), `lint_hardcodes.py`
(138 files), `check_no_emoji.py` (143 files), `contrast_check.mjs` (130
pairs, 0 failures), `lint_icon_only.py` (88 files). `pnpm run
typecheck`/`typecheck:ui`/`typecheck:ui:test` and `pnpm run build:ui` all
pass. No new contrast measurement was needed beyond what's already folded
into the 130-pair count above — this PR ships no new colour that isn't
already one of `bs-tokens.css`'s declared, contrast-checked pairs.

The prior kit's own contrast-measurement history (hex/ratio values across
successive rounds) is preserved in git history for this file, not repeated
here — it describes tokens this file no longer governs.
