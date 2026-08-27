# Blacksmith Dashboard — UI/UX Design Spec

## 0. Scope-gate note and spec gaps (read first)

**Adoption status.** `black-smith` has **no row in `knowledge/design-system/adopters.md`** and **no `docs/DESIGN.md`** yet — by the uiux scope gate, that makes it out of scope today. However, `black-smith-architecture.md` §10 explicitly commits to adoption ("the `black-smith` repo is added to `knowledge/design-system/adopters.md` so uiux/reviewer gating applies"), and this dispatch was made expressly to produce the spec that grounds that adoption. I proceeded on that basis, but **landing this feature must include, in the same PR**: the `adopters.md` row (variant `dashboard`, tokens copy path, version 3.0.0) and `ui/docs/DESIGN.md` from `adoption/DESIGN-md-template.md`, populated from §6 below. Until both land, `black-smith` is not a real adopter per the registry's own rule.

**Roadmap / milestone gap.** The dispatch brief describes §10 as containing a Roadmap page and milestone progress/lanes. I read the actual file: **§10's pages table has 7 rows (Overview, Timeline, Kanban, Task detail, Lessons, Errors, Analytics) — no Roadmap row**, and grepping the whole `docs/` tree for `Roadmap`/`milestone` returns nothing. There is no `milestones` table in §7's projection list and no `milestone` taxonomy dimension in §8/`taxonomy.yml`. This is a real product-spec gap, not a design-system gap — I can't map fields byte-exact to a data model that doesn't exist. I've written §5.4 (Roadmap) and the milestone-progress/milestone-lane pieces of Overview/Kanban as **PROVISIONAL**, clearly marked, with the minimal `milestones` projection I'd need the planner to add to §7 before a coder builds them. Recommend confirming with the operator before dispatching that work; everything else below is fully grounded.

**task_status column-count gap.** §10 says the Kanban page shows "tasks by status (todo / in-progress / reviewing / blocked / completed)" — 5 buckets — but `taxonomy.yml`'s `task_status` enum has 12 values (`todo, ready, in-progress, grading, reviewing, merging, blocked, completed, waived, failed, escalated, superseded`). §10 predates the v3 taxonomy rebuild. §5.3 proposes a grouping to reconcile the two; flagged for confirmation, not asserted as fact.

Everything else in this spec is grounded in the files read: `black-smith-architecture.md` §7/§8/§10, `factory/policies/taxonomy.yml`, `knowledge/design-system/profile/*.md`, and the HDS kit's `.prompt.md` component specs.

---

## 1. Variant and rationale

**`variant: dashboard`** (`profile/layouts-dashboard.md` + `profile/layouts.md` for everything inherited).

Justification: Overview is explicitly a stat-row + multi-feed landing page (§10: "live agents count, tokens vs budget, epics in flight, alerts") — that's Template 5A by definition. Errors and Analytics also want stacked chart/stat cards (5A/5B). Timeline, Kanban, Task detail, Lessons stay on the shared Templates 1/2/6, which `dashboard` inherits unchanged. No page needs `internal-tool`-only behavior.

---

## 2. App shell

```
┌────────────┬──────────────────────────────────────────────────────┐
│            │ Topbar (h-topbar, sticky top-0 z-10, bg-surface,      │
│  Sidebar   │  border-b border-line)                                │
│ (w-sidebar,│  [Breadcrumb ………………………]           [theme toggle]     │
│  bg-surface├──────────────────────────────────────────────────────┤
│  -sunken,  │                                                       │
│  border-r) │  Content — p-6, mx-auto w-full max-w-content          │
│            │  (Template 6 pages, if any later, opt out full-bleed) │
└────────────┴──────────────────────────────────────────────────────┘
```

**SidebarNav** (`w-sidebar` 240px, collapses to `w-sidebar-collapsed` 64px icon rail <1024px), two groups (avoids the "single-item group is noise" rule):

```jsx
<SidebarNav
  items={[
    { category: "Monitor" },
    { id: "overview",  label: "Overview",  icon: "layout-dashboard" },
    { id: "timeline",  label: "Timeline",  icon: "history" },
    { id: "errors",    label: "Errors",    icon: "alert-triangle" },
    { id: "analytics", label: "Analytics", icon: "bar-chart-3" },
    { category: "Work" },
    { id: "kanban",    label: "Kanban",    icon: "kanban" },
    { id: "roadmap",   label: "Roadmap",   icon: "map" },
    { id: "lessons",   label: "Lessons",   icon: "graduation-cap" },
  ]}
  activeId={route}
  onSelect={setRoute}
/>
```

Task detail is not a nav item — reached only by clicking a row/card (URL `/tasks/:taskId`), same as any Template 2 page reached from Template 1/board.

**Topbar.** Left: `Breadcrumb` via the shell's `useBreadcrumb()` composable — each page sets its own crumb (e.g. Kanban → `Kanban`; Task detail → `Kanban / <task id>`, or `Timeline / <task id>` if the referrer was Timeline, default `Kanban` on a direct deep link). Right: **theme toggle only**. No user menu, no sensitive-mask toggle — no auth (local-first, single operator) and no PII in this data (tasks/errors/lessons, not personal data), so `ux-conventions.md` §6 masking is **N/A**, stated explicitly rather than silently applying it.

**Routes:** `/`, `/timeline`, `/kanban`, `/roadmap`, `/tasks/:taskId`, `/lessons`, `/errors`, `/analytics`.

**Themes.** Both light and dark from `tokens.css` unchanged, byte-identical to master 3.0.0 (per `layouts-dashboard.md` inheritance: "every token in `tokens.css`/`tokens.md` byte-for-byte — no forked palette"). Theme toggle persists to `localStorage`, defaults to `prefers-color-scheme`.

**Responsive.** Desktop-first, optimal ≥1280px, supported to 1024px (sidebar auto-collapses), 768–1024px must not break. **Constraint override for this repo: must not break at 390px** (narrower than the design-system's stated non-goal floor of 768px). Concretely: Sidebar becomes an off-canvas `Sheet` triggered by a hamburger `Button` in the topbar below 768px (reuses the shell's existing mobile-sidebar use of `Sheet`, per `Sheet.prompt.md`: "Also used as the mobile sidebar"). `MetricGrid` already steps down to 2 columns container-aware. `Table`/board columns get horizontal scroll (`overflow-x-auto`) rather than compressing past illegibility — at 390px the Kanban board and any wide Table are horizontally scrollable, not reflowed into unreadable columns. `Toolbar` filters wrap to a second row (`flex-wrap gap-2`) below 640px. This is stated as a repo-specific responsive floor to record in `docs/DESIGN.md` (default is 1024px; this repo overrides to 390px per the dispatch constraint).

---

## 3. Taxonomy rendering rules

**Governing rule, stated once, applied everywhere:** only dimensions that are genuinely *evaluative* (they say "how is this going") get a colour-coded status Lozenge from the six families (`info/success/warning/danger/discovery/neutral`). Dimensions that are merely *descriptive/categorical* (they say "what kind of thing is this") render as **`outline` pill Lozenges** (the documented "meta badge" use — dates, kinds, counts) with **no status colour**, so the six-family vocabulary isn't diluted across dozens of tag types and a reviewer scanning for "is this bad?" only has six colours to learn, not twenty.

Evaluative → colour Lozenge (`subtle` in tables, `bold` for one dominant fact): `task_status`, `plan_status`, `run_status`, `severity`, `finding_status`, `lesson_status`.
Descriptive → `outline` pill Lozenge, no colour: `case`, `origin`, `agent` (role), `provider`, `model_tier`, `edge_type`, `edge_provenance`, `lesson_type`, `lesson_scope`.
Error `group.class` is neither — see below.

### 3.1 `task_status` → tone

| Value | Tone | Why |
|---|---|---|
| `todo`, `ready` | `neutral` | not started |
| `in-progress`, `grading`, `reviewing`, `merging` | `info` | active/automated work |
| `blocked`, `escalated` | `warning` | needs attention |
| `completed`, `waived` | `success` | landed (waived = closed via accepted waiver, still a successful terminal state — distinguish by text, not colour) |
| `failed` | `danger` | |
| `superseded` | `neutral` | replaced by a newer plan version, not a verdict |

### 3.2 `plan_status` → tone
`draft`→`neutral` · `in-review`→`info` · `active`→`success` · `superseded`→`neutral`.

### 3.3 `run_status` → tone
`queued`→`neutral` · `running`→`info` · `done`→`success` · `dead`→`danger`.

### 3.4 `severity` → tone + variant

| Value | Tone | Variant | Why |
|---|---|---|---|
| `S1-stop-the-line` | `danger` | `bold` | single dominant fact — "a danger wall" per `components.md` |
| `S2-major` | `danger` | `subtle` | |
| `S3-minor` | `warning` | `subtle` | |
| `S4-nit` | `neutral` | `subtle` | |

### 3.5 `finding_status` → tone

| Value | Tone |
|---|---|
| `raised` | `info` (new, needs triage) |
| `fix-pending`, `fix-landed` | `info` (active toward closure) |
| `confirmed` | `warning` (valid, not yet fixed) |
| `fix-verified`, `waived` | `success` |
| `refuted`, `expired` | `neutral` |

### 3.6 `lesson_status` → tone
`candidate`, `novelty-rejected`, `superseded` → `neutral` (distinguish by text) · `pending-approval` → `warning` · `approved` → `success` · `invalidated` → `danger`.

### 3.7 Error `group.class` — icon + label, never a colour Lozenge

Error group is a **category**, not a status — the actual "how bad" signal is `severity` (3.4), which already renders next to it. Giving 8 groups a colour Lozenge would either reuse the six status tones misleadingly (implying some error classes are inherently worse than others) or force a 7th/8th colour outside the token system. Instead: `lucide` icon (`size-icon-sm`, `text-fg-subtlest`, `aria-hidden`) + plain text label, in the Table's "Group" column, always paired with the severity Lozenge.

| Group | Icon |
|---|---|
| `spec` | `file-text` |
| `contract` | `file-check` |
| `execution` | `play` |
| `integration` | `git-merge` |
| `economy` | `coins` |
| `judgment` | `scale` |
| `coordination` | `users` |
| `memory` | `database` |

The sub-class (e.g. `judgment.same-mistake`) renders as `group · class` plain text next to the icon (`text-body`), not as a second badge.

### 3.8 Descriptive dimensions → `outline` Lozenge, plain text, no colour
`case`, `origin`, `agent` role, `provider`, `model_tier`, `edge_type`, `edge_provenance`, `lesson_type`, `lesson_scope` — rendered exactly as `<Lozenge variant="outline">value</Lozenge>`, sentence case, e.g. `feature`, `claude`, `frontend`.

---

## 4. Charts

| Question | Chart | Where |
|---|---|---|
| Trend over time | `LineChart` | Errors → "Errors over time"; Analytics → "Throughput trend" |
| Categorical comparison | `BarChart` | Errors → "By group" (8 categories, at the chart's cap); Analytics → "Cost per task by model tier", "Cost per task by provider" |
| Inline trend, no axes | `Sparkline` | Optional child of any StatCard on Overview/Analytics |
| Part-to-whole, ≤5 slices | `DonutChart` | Not used in v1 (no ≤5-bucket breakdown identified) — vendor it anyway, it's in the closed inventory and cheap to keep available |

Rules applied everywhere: charts live in `Card`s with a title + one description line; no illustration on a chart card ever; skeleton at the chart's own dimensions / Banner+Retry / empty line as its own remote-data zone; axis labels and legends `text-caption text-fg-subtlest`; horizontal gridlines only, `border-line`; numbers `tabular-nums`; no 3D/shadow/gradient on data marks; `--ds-chart-1..8` assigned in series order and never reused for status.

Errors "By group" `BarChart` is at the 8-series cap per `charts.md` ("Cap at 8 series... more than eight categories means the chart is the wrong shape") — this is the one place in the app that legitimately hits the ceiling; if a 9th group is ever added to the taxonomy, this chart must aggregate a tail into "Other" rather than grow past 8.

**Accessibility for inline-SVG charts** (no charting library, so no built-in a11y): every chart SVG gets `role="img"` and an `aria-label` one-sentence summary (e.g. `"Errors per day, last 30 days, rising from 4 to 12"`), plus a visually-hidden (`sr-only`) `<table>` sibling with the same series/categories/values, referenced via `aria-describedby`. This is required — a colour-only trend line with no text alternative fails WCAG 1.1.1.

---

## 5. Per-page specs

### 5.1 Overview — `/` — Template 5A

**Purpose:** at-a-glance state of the factory — what's running, on which model, on whose budget, and what needs the operator.

```
PageHeader:  [h1 "Overview"]
[page-level error line, if the whole overview failed to load]
Highlight (conditional — only if escalations/waivers pending):
  tint="amber" eyebrow="Needs you" title="3 waivers pending, 1 task escalated"
  action=<Button variant="inverse" size="sm">Review in Kanban</Button>
MetricGrid (cols=4, own zone):
  [Active agents] [Budget used] [Epics in flight] [Alerts]
Body (flex gap-6 lg:flex-row):
  Main (flex-1, own zone):
    Card "Live agents"              — RowList, role/model/provider/task/elapsed/run_status
    Card "Recent dispatch decisions"— RowList, agent→model, reason, ts, link
    Card "Milestone progress" [PROVISIONAL — see §5.4 gap note]
  Rail (w-rail, own zone):
    Rail Card "Epics in flight"     — compact rows, epic/plan_version/status cluster
    Rail Card "Pending your review" — waiver batches + lesson candidates, ghost "Review" buttons
```

**StatCards** (all four parts mandatory per `layouts-dashboard.md`: icon chip, label, value, delta — sparkline optional):

| Card | Value | Delta | `deltaTone` | Icon / tint |
|---|---|---|---|---|
| Active agents | live count | Δ vs 5 min ago | `neutral` (more agents isn't inherently good/bad) | `bot` / `blue` |
| Budget used | `%` of epic budget | pp change vs 1h ago | `warning` pinned (rising usage is never "success") | `coins` / `amber` |
| Epics in flight | count | Δ vs yesterday | `neutral` | `layers` / `mint` |
| Alerts | escalations + pending waivers | Δ vs yesterday | `danger` pinned when rising (backlog/problem count — never render success-green on an increase, per `Card.prompt.md`'s stat-card rule) | `triangle-alert` / `rose` |

**Fields (§7):** `agents` (role/model_tier/provider/run_status), `dispatches` projection (agent_role, model, provider, task_id, reason, ts), `tasks` (epic, plan_version, task_status), `waivers`/gate events (pending count).

**States:** stat row, main body, and rail are three independent remote-data zones per `layouts-dashboard.md`'s MUST rules — each renders its own skeleton/Banner+Retry/empty, none is implied by a sibling resolving. First-ever-run empty (zero events ever logged) is the app's one designated first-impression empty state: `EmptyState illustration="coffee"` — "Nothing running yet. Start the factory with a plan and this page fills in." Every other empty branch on this page (e.g. "no dispatches yet today") uses the plain icon, no illustration, per the illustration ration.

**Interactions:** Highlight action and rail "Review" buttons route to `/kanban` filtered to attention-needing tasks (waivers/escalations don't have their own page — the actual waiver approve/deny UI lives on Task detail, §5.5). Poll every 5s (see §7).

---

### 5.2 Timeline — `/timeline` — Template 1 shell, custom content zone

**Purpose:** chronological, filterable record of every prompt, dispatch, and gate event, with causal chains expandable in place.

```
PageHeader: [h1 "Timeline"]
Toolbar: [Search prompts/reasons] [Select: agent role] [Select: provider]
         [Select: event type]                          count="N events"  [Refresh]
FilterChips: case, severity, plan_version
CausalTimelineList (custom — see §6 gap):
  ● 27/07 14:02  "Add roadmap page to §10"                          (user_prompt)
    └ ▸ Dispatched uiux (sonnet/claude) for task-142 — spec before build
         ├ ▸ schema-check-result — pass
         └ ▾ finding-raised — S2, visual-hds                [expanded]
              ├ Table missing bordered grid
              └ (Lozenge: S2-major · danger subtle)
  ● 27/07 13:58  "Ship the Kanban board"                            (user_prompt)
[Load older events]  (ghost Button, cursor-paginated — see below)
```

**Fields (§7):** `user_prompt` (ts, session_id, text verbatim), `dispatch_decision` (agent_role, model, provider, task_id, spec_ref, reason, parent_prompt_id), `gate_event` subtypes — the ones this mock renders, not the whole dimension; the closed list is `gate_event` in `factory/policies/taxonomy.yml` and the timeline must render an unrecognised one rather than drop it (schema-check-result, testgate-result, finding-raised/-suppressed/-transitioned, severity-decisions, waiver-granted/-denied, gate-outcome).

**Row anatomy:** icon + tint is **decorative grouping by event kind only** (per `Timeline.prompt.md`: "tint is decorative grouping... not status — pair with a Lozenge when the state matters"): `user_prompt`=`message-circle`/blue, `dispatch_decision`=`send`/slate, `gate_event`=`shield-check` (pass), `shield-alert` (fail), or `circle-alert` (the payload records no verdict — D-169; a row may not infer one in either direction)/lilac. Actual outcome (severity, finding_status) renders as a Lozenge per §3, never via tint alone.

**Causal-chain expansion:** each dispatch/gate row that has children (via `parent_prompt_id` / `causal_parent`) gets a chevron `Button` (`variant="ghost" size="icon-xs"`) implementing the WAI-ARIA **Disclosure** pattern — `aria-expanded` + `aria-controls` on the button, `role="group"` on the revealed children, indented `pl-6` per depth level. Not a full Tree widget (roving tabindex not needed at this shallow, mostly 2–3-level depth) — Tab reaches each visible row/chevron in document order; Enter/Space toggles.

**Pagination:** the event log is append-only and ts-descending — no page numbers. A ghost `Button` "Load older events" at the list end fetches the next cursor page. This satisfies "paginate only when the API paginates" (it does, just cursor-style, not page-number `Pagination`).

**States:** loading = 6 shape-matched `Skeleton` rows (icon circle + 2 lines each); error = `Banner` + wired Retry replacing the list, Toolbar stays mounted (filters survive); empty = `EmptyState icon="history"` "No events match these filters." + ghost Button "Clear filters" (only shown when filters are active).

**Interactions:** click a dispatch/gate row with a `task_id` → navigate to `/tasks/:taskId`. Prompt rows don't navigate (expand only). Search matches prompt text and dispatch `reason`.

---

### 5.3 Kanban — `/kanban` — no single template fits; flagged composition

**Purpose:** read-only board of what's in flight right now, by status and (provisionally) milestone.

**Template note (flagged, not silently blended):** none of the six templates covers a board. Closest fit is Template 1's shell and row-click-navigates convention, composed with Template 6's full-bleed width-cap opt-out for the board itself (the board needs more than `max-w-content`'s 1400px once multiple status columns are visible). This is a proposed composition for operator/planner confirmation, not an assertion that it's already sanctioned.

```
PageHeader: [h1 "Kanban"]                                              [Refresh]
Toolbar: [Search title/id] [Select: Epic] [Select: Milestone] [Select: Agent]  count
FilterChips: case, severity, origin
Board (full-bleed, opts out of max-w-content, horizontal scroll):
┌ Milestone: "Phase 6 — UI" [PROVISIONAL] ──────────────────────────────────┐
│  Todo (4)      In progress (2)   Reviewing (5)    Blocked (1)  Completed (12)│
│  ┌────────┐    ┌────────┐        ┌────────┐       ┌────────┐  ┌────────┐   │
│  │TaskCard│    │TaskCard│        │TaskCard│        │TaskCard│  │TaskCard│   │
│  └────────┘    └────────┘        └────────┘        └────────┘  └────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
┌ Unscheduled ───────────────────────────────────────────────────────────────┐
│  … same 5 columns for tasks with no milestone …                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Status-column mapping (flagged, reconciles §10's 5 columns against `taxonomy.yml`'s 12-value `task_status`):**

| Column (§10) | `task_status` values folded in |
|---|---|
| Todo | `todo`, `ready` |
| In progress | `in-progress`, `grading` |
| Reviewing | `reviewing`, `merging` |
| Blocked | `blocked`, `escalated` |
| Completed | `completed`, `waived` |

`failed` and `superseded` are hidden from the default board (terminal/replaced, not "in flight") and only appear when the Toolbar's Status `Select` is set to "All" (adds two extra columns). This default-hide is a deliberate proposal, flagged for confirmation. Sub-status is shown as small text under the column count: e.g. "Reviewing 5 · Merging 2" (`text-caption text-fg-subtlest`).

**TaskCard** (composition of existing `Card`, not a gap): title (`text-body font-medium`, clamp 2 lines), `task_id` (`font-mono text-caption`), `case` outline Lozenge, `severity` colour Lozenge if an open finding exists, agent role outline Lozenge. Whole card is the click target (`role="link"`, `tabindex="0"`, `hover:` background wash per motion rules), navigates to `/tasks/:taskId` on Enter/click — same convention as Table row-click.

**No drag** is explicit and permanent: "status changes only via factory events" (§10). WCAG 2.5.7 (dragging alternative) is **N/A**, not satisfied-by-omission — there is no drag interaction to begin with, so nothing to provide an alternative for.

**Fields (§7):** `tasks` (task_status, case, origin, epic, plan_version, claims count), `edges` (dependency badges, optional), milestone (**PROVISIONAL**, no source table — see §5.4).

**States:** whole-board skeleton (3 skeleton lanes × 5 skeleton columns × 2–3 skeleton cards) / Banner+Retry replacing the board / `EmptyState` "No tasks match these filters." + "Clear filters".

**Interactions:** filters only; no context menu, no per-card actions (read-only, confirmed by the constraint that waiver/lesson actions are the app's only writes).

---

### 5.4 Roadmap — `/roadmap` — PROVISIONAL, Template 1

**This entire page is unconfirmed** — no `Roadmap` row exists in the current §10, no `milestones`/`epics` projection exists in §7, no `milestone` taxonomy dimension exists in §8. What follows is a best-effort proposal so the dev agent isn't blocked, not a grounded spec. **Do not build this without the planner adding the underlying data first** (minimal proposal: a `milestones` (or `epics`) projection — `id, name, plan_version, plan_status, acceptance_criteria_total, acceptance_criteria_met, started_at`).

```
PageHeader: [h1 "Roadmap"]
Toolbar: [Search name] [Select: plan_status]                          count
Table (bordered): Milestone | Status | Plan version | Progress | Tasks | Started
  each row → progress cell is a custom ProgressBar (§6 gap) showing
  acceptance_criteria_met / total; row click → /kanban?milestone=<id>
```

`Status` = `plan_status` Lozenge (§3.2). `Tasks` = mini Lozenge cluster of task_status counts for that milestone. States: standard Template 1 triplet.

---

### 5.5 Task detail — `/tasks/:taskId` — Template 2

**Purpose:** everything about one task — contract, agents, history, findings — and the only place waiver decisions happen.

```
PageHeader: [h1 task title]  [status: task_status Lozenge]      [Button "View branch" ↗]
Tabs: Overview | Findings | Artifacts | History
Body (flex gap-6):
  Main (flex-1, per-tab content, each its own zone):
    Overview tab:
      Card "Spec contract"  — DefinitionList: case, origin, claims (mono chips),
                               dependencies (edge_type/edge_provenance), acceptance refs
      Card "Attempts"       — RowList: agent, model/provider, start/end, run_status
    Findings tab:
      Table: Category | Severity (Lozenge) | Status (Lozenge) | Summary | Fingerprint
        row expands (Disclosure) → full description +
        [only when severity=S3 AND finding_status=confirmed AND unwaived]
        Button "Waive" (outline) · Button "Deny" (secondary)
          → Popover "Waive finding <fingerprint>? This can't be asked again." [Confirm]
    Artifacts tab:
      Rail-width image tile grid (custom, §6) — click → Dialog lightbox
      RowList: branch/PR links (Button variant="link", external icon)
    History tab:
      Card "History" — Timeline (in-inventory, flat, scoped to this task's own events)
  Rail (w-rail):
    Rail Card "Details"  — DefinitionList: task_id, epic, plan_version, task_status, origin, case
    Rail Card "Agents"   — compact rows: role, model_tier, provider, run_status
```

**Fields (§7):** `tasks` row (claims, case, origin, task_status, epic, plan_version), `dispatches` (attempts), `edges` (dependencies), `reviews` (findings: finding_category, severity, finding_status), `waivers` (fingerprint, granted/denied), `artifacts` (screenshots, branch/PR links).

**Waiver UI — the judgment call, stated explicitly:** a waiver is a policy decision, not data loss, so it does **not** get the full `AlertDialog` ceremony reserved for destructive/irreversible actions — but because "the same finding is never asked twice" (§8), a bare inline button felt too light for a decision with no UI undo. Resolution: single-step `Popover` confirm naming the exact fingerprint, then a `Toast` ("Waived 1 finding.") since the mutation keeps the user on the page. **Lesson reject** (§5.6), by contrast, does use `AlertDialog` — it discards a candidate with no natural undo path and there's direct precedent in the kit (`AlertDialog.prompt.md`'s "Reject N captures?").

**States:** Attempts/Findings/Artifacts/History are independent zones — a Findings-load failure must not blank Overview or vice versa.

**Interactions:** mutation race guard on Waive/Deny per `ux-conventions.md` §3 — disable the row's buttons AND guard `if (saving) return`; error clears on next successful attempt (Banner adjacent to the row, not a page-level Banner).

---

### 5.6 Lessons — `/lessons` — Template 1

**Purpose:** review lesson candidates before they rewrite agent prompts.

```
PageHeader: [h1 "Lessons"]
Status toggle: Button "Pending review (N)" (secondary when active) |
               Button "Approved" | Button "All"
  — a status filter over one list ships as a Button pair, not Tabs,
    per Tabs.prompt.md's own documented precedent
Toolbar: [Search] [Select: lesson_type] [Select: lesson_scope]        count
Table: Type (outline) | Scope (outline) | Summary/evidence excerpt |
       Status (Lozenge) | Times prevented (Approved view only, tabular-nums)
  row click → Dialog "Review lesson"
```

**Review Dialog:** full text (read-only, or `Textarea` when "Edit" is active), evidence links (provenance event IDs → deep-link into Timeline at that event), `lesson_scope` display, `lesson_type` as a `RadioGroup` (3 options — fits "small exclusive enum 2–4" exactly) shown only in Edit mode. Buttons: **Approve** (primary) · **Edit** (outline, toggles editable fields; the edit is folded into a single "Save & approve" commit, matching the taxonomy's lack of a distinct "edited" status between `pending-approval` and `approved` — flagged as a modeling decision, not a taxonomy fact) · **Reject** (destructive outline) → `AlertDialog` "Reject this lesson? This candidate won't be compiled into agent prompts." confirm label "Reject".

**Fields (§7/§8):** `lessons` (lesson_type, lesson_level=`principle` always, lesson_status, lesson_scope, provenance_event_ids, "times prevented" counter — mentioned explicitly in §10).

**States:** Pending-empty = `EmptyState icon="check-circle"` "Nothing waiting. New candidates appear after the next dreaming pass." (plain icon — this is a working page, not the app's designated first-impression illustration slot, which is Overview's).

---

### 5.7 Errors — `/errors` — Template 5B

**Purpose:** every gate failure and runtime error, grouped by taxonomy class, trended, with provider-disagreement surfaced.

```
PageHeader: [h1 "Errors"]
Toolbar: [Search] [Select: group] [Select: severity] [Select: agent]     count
Card "Errors over time"       — LineChart, count/day, last 30 days (own zone)
Card "By group"                — BarChart, 8 categories (own zone, at the 8-series cap)
Card "Provider disagreement"   — RowList, judgment.provider-disagreement only (own zone)
Card "Error log" (padded={false}) — Table, own zone:
  Time | Group·Class (icon+label) | Severity (Lozenge) | Task (link) | Message
  row click → Dialog "Error detail" (full diff/output payload, font-mono block)
  [Load more] cursor Button
```

**Fields (§7/§8):** `errors` table — `error` (group.class), `severity`, task ref, ts, diff/output payload.

**States:** each of the 4 cards is its own remote-data zone (chart skeleton at its own dimensions, Banner+Retry, empty line) — a chart resolving successfully must not stand in for the table failing, and vice versa.

---

### 5.8 Analytics — `/analytics` — Template 5A

**Purpose:** throughput, cost, and quality trend — is the factory getting better or worse.

```
MetricGrid (cols=4, own zone): [Throughput] [Cost/task] [Same-mistake rate] [Recheck pass rate]
Body:
  Main: Card "Cost per task by model tier" (BarChart) ·
        Card "Cost per task by provider" (BarChart) ·
        Card "Throughput trend" (LineChart)
  Rail: Rail Card "Recheck outcomes" · Rail Card "Cross-check quorum"
```

| StatCard | `deltaTone` | Why |
|---|---|---|
| Throughput | default (sign-based) | more tasks/day is neutral-to-good, default arrow reading is fine |
| Cost per task | pinned so rising renders non-success | cost is a problem-count-shaped metric |
| Same-mistake rate | pinned `success` on **negative** delta | the documented "falling reject rate" example from `Card.prompt.md` applies verbatim — down is good here |
| Recheck pass rate | default | rising pass rate is good, default reading holds |

**Fields (§7/§8):** dispatches (cost, model_tier, provider), `error.judgment.same-mistake` rate over time, recheck scheduler outcomes (§12), `crosscheck.yml` quorum results.

**States:** stat row / main / rail three independent zones, each chart its own zone within main.

---

## 6. Component inventory

### 6.1 Used, from the closed 48-primitive set

Core: `Button`, `Icon`, `Lozenge`, `Skeleton`, `Separator`.
Forms: `Field`, `Input`, `Select`, `RadioGroup`, `Textarea`.
Surfaces: `Card`, `StatCard`, `RowList`/`Row`, `Table`.
Layouts: `PageHeader`, `SectionHeading`, `Toolbar`, `FilterChips`, `MetricGrid`, `CardGrid`, `DefinitionList`, `Timeline`, `Highlight`, `EmptyState`.
Navigation: `AppShell`, `SidebarNav`, `Tabs`, `Breadcrumb`.
Overlays: `Dialog`, `AlertDialog`, `Popover`, `Tooltip`.
Feedback: `Banner`, `Toast`.
Charts: `Sparkline`, `LineChart`, `BarChart` (vendor `DonutChart` too — closed inventory, cheap to keep available even though v1 has no use for it).
Illustration: `Illustration` (one use — Overview's first-run empty state, `coffee`).

Not used in v1, vendor only if needed later: `Checkbox`, `Switch`, `Sheet` (only for the mobile off-canvas sidebar, not as a generic drawer), `DropdownMenu` (no per-row destructive actions exist anywhere in this read-mostly app), `SplitPanel`, `TwoColumn`, `Callout`, `FormFooter` (no standalone form pages).

### 6.2 Gaps — needs custom build on HDS tokens (flag explicitly, not silent inventions)

1. **`CausalTimelineList`** (Timeline page, §5.2). The kit's `Timeline` primitive is a flat dated list with no expand/collapse (`Timeline.prompt.md` shows a fixed `items[]`, no children). Causal-chain expansion needs the WAI-ARIA Disclosure pattern layered on top: build from `RowList`/`Timeline` row anatomy (icon, tint, title, meta) + a chevron `Button` toggling `aria-expanded`/`aria-controls`, indented children in a `role="group"`. Token-only, no new colours or radii.
2. **`KanbanBoard` with milestone lanes** (§5.3). Not one of the 48 primitives — nearest relative is `CardGrid`, which doesn't do multi-column-times-multi-lane layouts or horizontal scroll wells. Build from `Card` (per TaskCard) inside labelled column wells (`bg-surface-sunken`, matching the sidebar/table-header sunken convention) inside labelled lane sections (`SectionHeading`). No drag library — read-only, click-to-navigate only.
3. **`ProgressBar`** (Overview's milestone-progress widget and Roadmap's progress column, both PROVISIONAL). A single track/fill div (`bg-surface-sunken` track, `bg-primary` fill by percent, `text-caption` label) — trivial, but not in the 48-primitive list, so flagged rather than assumed. **This new fill/track colour pairing has not been contrast-verified** — run `contrast.py` against the chosen fill colour before shipping (see §7).

Everything else (TaskCard, screenshot tile grid, monospace error-payload block) is a straightforward composition of existing primitives (`Card`+`Lozenge`, bordered `<img>` tiles + `Dialog` lightbox, `<pre>` on `bg-surface-sunken`) and does not need inventory additions.

---

## 7. Accessibility

**App-wide:**
- `<html lang="en">` — English pending confirmation (no UI-language declaration found anywhere in `docs/`; `black-smith-interview.md` §A1 only covers TypeScript, not UI copy language; recommend the operator confirm this in the interview before `docs/DESIGN.md` is written, since the design system requires exactly one declared UI language).
- Skip-to-content link, visually hidden until `:focus-visible`, before the Sidebar in DOM order (WCAG 2.4.1).
- Landmarks: `<nav aria-label="Primary">` (Sidebar), implicit `banner` (Topbar), `<main>` per route, `<nav aria-label="Breadcrumb">`.
- Exactly one `<h1>` per route = the `PageHeader` title (WCAG 2.4.6/1.3.1) — Task detail's title is the task name, not "Task detail".
- Focus ring: `:focus-visible` only, the `--ds-focus-width` (3px) token, never `outline: none` without it.
- Icon-only controls (theme toggle, Timeline chevrons, DropdownMenu triggers if ever added): `aria-label` + `Tooltip`, ≥24×24px target (WCAG 2.5.8).
- Live/status regions: load-failure `Banner`s are `role="status" aria-live="polite"` (persistent, not urgent enough for `assertive`); `Toast` container `aria-live="polite"`. Poll-driven count changes (e.g. Toolbar's "N tasks") are debounced to at most one announcement per 10s, not announced on every 5s tick — avoids screen-reader spam from background refresh (WCAG 4.1.3 without over-announcing).
- `prefers-reduced-motion`: skeleton pulse and any poll-triggered highlight fall back to opacity-only, no travel; honored, never removes the focus indicator itself.

**Per-page notes:**

| Page | Keyboard path / focus order | Key ARIA notes |
|---|---|---|
| Overview | Header → Highlight action (if present) → stat row (4 cards, tab order left-right) → main feeds top-to-bottom → rail cards top-to-bottom | Each `StatCard` delta pill has a text equivalent, not colour-only (WCAG 1.4.1) |
| Timeline | Toolbar controls → FilterChips → event rows in ts order; each chevron reachable, Enter/Space toggles | Disclosure pattern (§5.2); `aria-expanded`/`aria-controls` on every chevron |
| Kanban | Toolbar → lane 1 (Todo top-to-bottom, then In progress, …) → lane 2, … | Each lane a `<section aria-label="<milestone> lane">`; each column an `<h3>` + `role="list"`; each card `role="listitem"` wrapping a real focusable element with `aria-label="<title>, <status>, opens task detail"` |
| Roadmap | Toolbar → table rows | Standard `Table` grid semantics (`<th scope="col">`) |
| Task detail | Header actions → Tabs (roving tabindex, Left/Right per `aria-patterns.md` #12) → active panel content → rail | `Tabs`/`tabpanel` roles exactly per the pattern; Waive/Deny buttons disabled during their own mutation (WCAG 3.2.2 — no unexpected context change without warning) |
| Lessons | Status toggle buttons → Toolbar → table rows → Dialog (focus-trapped, returns focus to the triggering row on close) | `AlertDialog` for Reject per pattern #5: focus to first control on open, trap, Esc closes, return focus to trigger |
| Errors | Toolbar → 4 cards in DOM order → table rows → detail Dialog | Chart `role="img"` + `aria-label` summary + `sr-only` data table (§4) |
| Analytics | Stat row → main charts → rail | Same chart a11y requirement as Errors |

**Target size:** every clickable row/card/TaskCard/chevron meets the 24×24px minimum (WCAG 2.5.8); TaskCards in particular must not shrink below that on the 390px viewport even with horizontal board scrolling.

**Verification not yet run** (no built code to test against, per the verification protocol — these are must-do-at-implementation, not claimed-done): contrast on the custom `ProgressBar` fill/track pairing (§6.2 item 3); a real-browser check of both themes at 1280px/1024px/390px; `lint_hardcodes.py`/`check_no_emoji.py`/adherence-lint output pasted into the PR per `ux-conventions.md` §9. All Lozenge tone/text pairs used here are the documented system pairs from `tokens.md`, already AA-verified at the token level — no new contrast work needed there as long as implementation uses the exact `--ds-<status>-subtle`/`-text`/`-bold` tokens and doesn't hand-pick alternates.

---

## 8. Out of scope (explicit, with reasoning)

- **No auth.** Local-first, single operator, no login page, no Template 4 usage. Cloudflare Access is future work per §10/§14 — out of this spec entirely.
- **No WebSockets — poll, stated per surface:**
  - **The app shell** (`/api/pulse`, added by §A.6): poll every **5s** on every page. This is the only poll that is not a page's own — it carries the freshness indicator and the nav arrival badges, both of which have to be true on pages that do not poll at all.
  - **Overview** (stat row + live-agents feed): poll every **5s** — this is explicitly the "what's running right now" page (§7 of the architecture doc), the one place sub-10s freshness matters.
  - **Timeline, Kanban**: poll every **15s**, paused via the Page Visibility API when the tab is hidden, plus a manual `Button` "Refresh" in the Toolbar (`Toolbar.prompt.md`'s documented `end` slot pattern) for on-demand freshness.
  - **Task detail, Lessons, Errors, Analytics**: **manual refresh only**, no auto-poll — these are pages the operator is actively reading/deciding on; a table or findings list re-sorting under their cursor mid-read is a worse UX than a slightly stale view with an explicit Refresh button.
  - **Why poll, not WebSockets:** the projections are read-only SQLite queries behind a small local API with no auth; a single local operator doesn't need sub-second push. §10's own "Cloudflare later" plan is explicitly a data-layer port (SQLite → D1) "not a rewrite" — plain HTTP polling carries over unchanged, while a WebSocket layer would need Durable Objects at the eventual Workers port, extra migration surface with no demonstrated UX need at v1.
  - **Mutation-race interaction with polling:** no optimistic UI anywhere — Waive/Deny/Approve/Edit/Reject disable their control and guard `if (saving) return` (per `ux-conventions.md` §3) until the server responds; the next poll tick (or the mutation's own response) is what updates the UI. This avoids a poll racing an in-flight write.

---

## 9. For `docs/DESIGN.md` (dev to fill in, from `adoption/DESIGN-md-template.md`)

- **Variant:** `dashboard`.
- **Tokens copy:** `ui/src/styles/hds-tokens.css` (suggested path), version 3.0.0, copied at implementation time.
- **UI language:** English — pending explicit operator confirmation (§7).
- **Date format:** `DD/MM/YYYY` display default unless the operator overrides.
- **Delete semantics:** N/A — no delete anywhere in this app (writes are limited to waiver/lesson decisions, none of which delete data).
- **Primitive inventory:** the §6.1 list, seeded from this spec.
- **Charts/illustrations:** `LineChart`/`BarChart`/`Sparkline` (+ `DonutChart` vendored unused); one Open Doodle, `coffee`, for Overview's first-run empty state only.
- **Status → Lozenge mapping:** §3 of this spec, copied verbatim into the template's mapping table.
- **Reference pages:** once built, `AppShell.vue`, the Template 5A/5B page-shell wrapper, and one page per template (Overview=5A, Kanban=board composition, Task detail=Template 2) become the repo's normative references.
- **Known deviations (dated, to record on landing):** Kanban's template composition (§5.3) and the 390px responsive floor override (§2) — both flagged in this spec as deliberate, reasoned deviations from the closest-fit template/policy, not silent drift.
---

## Addendum — Phase 6b: multi-project hub, Flow page, operator directives (2026-08-04)

Recorded per this phase's own dispatch instruction ("record the rules
below as the page's spec"). Everything below is additive to §1–§9 above,
which stays the normative spec for Overview/Timeline/Kanban/Task
detail/Lessons/Errors/Analytics's per-6a-round shapes; ui/docs/DESIGN.md's
"Known deviations" section is the authoritative, dated log of what shipped
vs what's still flagged — this addendum states the target, DESIGN.md states
reality.

### A.1 Multi-project hub + routing

- **Projects hub** (`/projects`, new app default — `/` redirects here): one
  card per project — live agents, open findings by severity (rolled into a
  single "pending review" count this round — S3/S4 raised/confirmed with no
  waiver, plus escalations), current epics-in-flight with identity chips,
  budget burn %, project identity chip. Clicking a card routes to
  `/p/:project/overview`.
- **Overview** splits into global mode (`/overview`, aggregates
  `overview()` across every project + a `projects[]` breakdown) and
  per-project mode (`/p/:project/overview`).
- **Project switcher**: a topbar `Select` (`useProjectContext.ts`), visible
  only on project-scoped routes
  (Overview/Sessions/Timeline/Kanban/Roadmap/Flow).
  On the Overview routes it navigates between `overview-global` and
  `overview-project`; everywhere else it sets/clears a `?project=` query
  param on the current route.
- **Timeline "Decisions" lens**: a Toolbar toggle Button (`aria-pressed`)
  narrowing the event list to `user_prompt` + operator-authored decision
  events (§A.4 below) + the `dispatch_decision` events causally attached to
  one of those (by `parent_prompt_id` or a direct `causal_parent` edge).

### A.2 Flow page (`/flow`, Template: custom graph composition, §6.2 gap)

**Purpose:** the active plan version's task DAG — what depends on what,
what's running right now, and which tasks could run in parallel.

```
PageHeader: [h1 "Flow"]                    [Epic Select] [Plan version Select]
Canvas (full-bleed, one column per wave, each headed by a wave-label node):
  custom DOM task nodes (Card-like: bg-surface-raised, border-line, card
    radius + raised shadow, fixed 232x132 box) — task_id (mono) + summarized
    title + task_status Lozenge (subtle) + agent-role outline pill when live
  edges styled by edge_type: artifact solid / claim-order dashed /
    spec-clause dotted / regression-test thin solid / research-brief thin dashed
  live pulse on running nodes (opacity-only under prefers-reduced-motion)
  Controls (zoom in/out, fit view) — built from @vue-flow/core's own
    useVueFlow() viewport methods, NOT the separate @vue-flow/controls
    package (not in docs/standards/stack.md's sanctioned list)
sr-only <table>: task | status | wave | depends-on (WCAG 1.1.1 alternative)
```

**Layout**: waves computed by `graph.ts`'s `waveLayers()` — longest-
path depth per node (a node's wave = `1 + max(wave of its dependencies)`,
or 0 with no dependencies) — exposed via `GET /api/flow`
(`db/queries.ts`'s `flowGraph()`). No separate layout library, per
docs/standards/stack.md; the positioning itself is `ui/src/lib/
flowLayout.ts`, kept out of the `.vue` file so it is unit-testable.

**Superseded by operator directive (round 11)** — "Flow node cần tách nhau
ra và hiển thị rõ ràng hơn":

- *Wave bands are gone.* This spec asked for "horizontal-layered background
  stripes", and they shipped as absolutely-positioned divs behind the
  canvas. That is unfixable as specified: a band is laid out in the page's
  pixels, the graph is drawn in the viewport's, so `fit-view-on-init` alone
  put the two out of register and any pan or zoom widened the gap — §A.4-5
  records the same defect. Each column is headed by a **wave-label node**
  instead, which is transformed with the column it labels.
- *Spacing is stated as `box + gap`.* The first implementation reserved 220px
  per wave for a node capped at 200px and 96px per row for a node measuring
  ~92px, leaving neighbours 20px and 4px apart — the DAG read as one block.
  `flowLayout.ts` now derives every step from the box (`NODE_WIDTH + COLUMN_GAP`,
  `NODE_HEIGHT + ROW_GAP`), so a node that grows a line cannot silently eat the
  separation, and `ui/test/flowLayout.test.ts` asserts no two boxes overlap.
- *Waves are centred on y = 0*, so a fan-out spreads either side of its source
  rather than hanging below it.

**Fields**: `tasks` (task_status, title, plan_version), `edges`
(edge_type, edge_provenance), agents (`liveAgentRole`, only when a
dispatch for that task is currently live).

**Interactions**: click a node → `/tasks/:taskId`. Epic/project filters
scope the query; plan-version `Select` re-queries a specific version
(§ui/docs/DESIGN.md's "plan-version diff is approximate" deviation).

**Not built this round** (flagged in DESIGN.md, not silently dropped):
MiniMap, diamond checkpoint nodes for gate outcomes, byte-exact
added-vs-superseded plan diff.

### A.3 Operator directives 1–4 (recorded verbatim intent; DESIGN.md
records what shipped)

1. Kanban cleanup: TaskCard = title + task_id + **at most 2 chips**
   (severity takes priority over case when an open finding exists);
   column wells get a visible border (not just a sunken colour wash);
   counts are `tabular-nums`, right-aligned; sub-status caption text only
   when a folded column has more than one raw `task_status` underneath.
2. Epic/project identity chips: `identityColor.ts`'s
   `hash(id) % 8 + 1 -> --ds-chart-N`, one deterministic slot per id,
   rendered via `IdentityChip.vue` (outline-Lozenge shell, chart-token
   border/text colour — never a status tone). Used on Projects, Overview
   (epics-in-flight rail), Roadmap (milestone's project + epic chips).
   Flow's nodes intentionally use `task_status` tone instead (a single
   Flow view is usually one epic/project already, so identity colour adds
   less signal there than status does).
3. "Pending your review" chips coloured by evaluative tone: waiver =
   `warning`, escalation = `danger`, lesson candidate = `discovery` — each
   a real Lozenge (not identity colour), wrapped in a ghost button that
   routes to Kanban/Lessons.
4. Roadmap milestone mini-timeline: `db/queries.ts`'s
   `milestoneTaskRefs()` — up to 3 most-recently-completed tasks (success-
   tone dot + relative timestamp, `formatRelative()`) and up to 3 next
   tasks (neutral dot, dependency-ready-first ordering via `edges`), both
   click-through to Task detail.

### A.4 Operator directives 5–7 (Phase 6b rounds 6–7)

Verbatim intent again; `ui/docs/DESIGN.md` records what shipped.

5. **Roadmap as a graph** — "Trong dashboard, phần roadmap, display theo
   dạng VueFlow". §5.4's provisional Table/card list is superseded: the
   page renders as a `@vue-flow/core` diagram using the same house pattern
   as §A.2's Flow page — custom DOM nodes on HDS tokens, `useVueFlow()`
   viewport controls in a `Panel` (never the unsanctioned
   `@vue-flow/controls`), no MiniMap, and an `sr-only <table>` carrying the
   ordering a DOM graph cannot express (WCAG 1.1.1).

   ```
   PageHeader: [h1 "Roadmap"]
   Toolbar: [Search name]                                       count
   Canvas (full-bleed):
     milestone nodes — name + plan_status Lozenge (§3.2) + project/epic
       IdentityChips + summarize()d goal (full text in the native title)
       + ProgressBar + the §A.3-4 Recent/Next mini-timeline
     edges: "next in sequence", dashed, --ds-text-subtlest
     Panel bottom-left: [zoom in] [zoom out] [Fit view]
   sr-only <table>: milestone | project | status | sequence | tasks done
   ```

   **Layout is dictated by the data, not by taste:** `MilestoneProgress`
   carries `sequence` and *no* dependency field, so the only edge this API
   justifies is next-in-sequence — drawn as one left-to-right chain per
   project lane (`ui/src/lib/roadmapFlow.ts`, kept pure so it is unit-
   tested under `ui/vitest.config.ts`'s node environment rather than only
   through Playwright). Lanes are identified by the project `IdentityChip`
   each node already carries, **not** by Flow's absolutely-positioned wave
   bands: those are painted in canvas coordinates and drift out of register
   the moment the operator pans.

6. **Flow nodes are summaries, not paragraphs** — "một block bị quá dài,
   và quá nhiều text, chỉ cần tóm tắt ngắn". A Flow node's `title` is
   `tasks.objective`, which runs 900–1500 characters on the live plan. The
   node label and its `aria-label` are `summarize()`d and the label is
   line-clamped; the full objective stays reachable three ways — the node's
   native tooltip, the `sr-only` table, and the Task detail page the node
   links to. Focusing a node should announce where it goes, not read out a
   paragraph.

7. **Overview liveness + elapsed time** — "Tôi cần nhìn được ở Dashboard
   cái gì đang chạy, một dạng real-time update, để ý đến các mốc thời gian
   để hiển thị tốt hơn". §8's "no WebSockets, poll every 5s" rule is
   unchanged — the gap was never freshness, it was *evidence* of freshness:
   a page whose server had died looked exactly like a quiet factory.

   - `LiveStatus.vue` in the PageHeader `actions` slot: state dot + label
     + manual Refresh. `livenessLevel()` (`ui/src/lib/liveness.ts`) grades
     the age of the **last successful load** against the page's own poll
     interval — `live` < 2 intervals, `lagging` < 6, `stale` beyond, and
     `connecting` before the first response. A failed poll therefore ages
     the indicator instead of resetting it, which is the case the operator
     most needs to see. Colour is never the only channel (the word is in
     the label), and the pulse animation runs only in the `live` state —
     an animation on a stale page is a lie about the page's state — and is
     dropped entirely under `prefers-reduced-motion`.
   - **Deliberately not `aria-live`**: the label re-renders every second,
     so a polite live region would queue an announcement per tick and bury
     everything else on the page.
   - **Elapsed runtimes**: `dispatchedAt` previously reached the DOM only
     as a native tooltip, so "this agent has been wedged for 40 minutes"
     was invisible. `formatElapsed()` renders it as text (two units at
     most: `7s` / `3m` / `2h 13m` / `2d 4h`) on every live-agent row, on
     the collapsed group row (the group's *longest* runtime), and in the
     card's one-line summary. Entries sort longest-running first — the
     stuck agent is invisible in dispatch order.
   - **The clock ticks, not just the data**: `useNow()` (1s) feeds every
     relative label its `nowIso`, so ages count up between fetches instead
     of freezing. It pauses with the tab like any other poll.
   - `usePoll` now refetches **immediately** when a hidden tab becomes
     visible again, then resumes its interval — returning to a tab hidden
     for an hour otherwise showed hour-old data for a further interval.

### A.5 Operator directive 8 (Phase 6b round 8)

8. **Roadmap connectors and the running node** — "Flow trong roadmap, hiển
   thị line nối giữa các node thẳng, có animation ở node đang running".
   Amends A.4-5's wireframe on two points; everything else there stands.

   - **Edges are `type: 'straight'`.** Vue Flow's default edge is a bezier,
     which reads as straight *only* when both handles share a `y`. A
     milestone node is content-sized — goal length and mini-timeline row
     count vary — so nodes in one lane share a top edge but not a height,
     their handles land at different `y`, and the bezier bowed. The edge
     type lives in `roadmapFlow.ts` beside the layout it belongs to, so it
     is unit-tested; the `.vue` file sets only the paint (dashed,
     `--ds-text-subtlest`, unchanged).
   - **The in-progress node pulses.** A.3-1's ruling — pulse a small
     dedicated dot, never the node — was about *opacity*: dimming a node
     full of text oscillates the contrast of every word in it. That
     objection does not apply to a ring drawn outside the border, so
     `.roadmap-node--live` animates `box-shadow` only, via a separate
     `hds-ring-pulse` keyframe, and the node's text contrast is constant.
     Flow's `.flow-node__live-dot` is unchanged — it marks a live *agent*,
     which is a different claim from "work is at this milestone".
   - **Motion is never the only channel.** The live border-colour is the
     static half of the signal and the node's Lozenge still says
     "in-progress" in words. Under `prefers-reduced-motion` the ring is
     *frozen*, not removed: dropping it would leave the live node less
     prominent for reduced-motion users than for everyone else.

---

### A.6 Operator directive 9 (shell liveness round)

9. **The toast question, answered no** — "Có nên thêm toast thông báo khi có
   event, trigger hoặc dispatch vừa xảy ra, để hệ thống có cảm giác đang
   chạy?" The need is real and the mechanism was wrong. What shipped instead
   keeps the feeling of a running system on a surface the operator can come
   back to.

   - **No toast on an event, a trigger or a dispatch.** `useToast` already
     means exactly one thing — *your* action landed — and it is used only by
     Task detail's waive/deny and Lessons' approve/reject. A toast the
     operator did not cause would overload that. Three further objections are
     properties of this transport, not matters of taste: the data arrives by
     poll (§8), so a toast fired off a diff reports when the *poll* noticed,
     not when the thing happened; a wave that lands ten events between two
     ticks either storms the corner or lies about the count; and `usePoll`
     pauses while the tab is hidden, which makes a toast lossy for something
     the event log records durably. The argument is kept in
     `ui/src/lib/navBadges.ts` rather than only here, next to the code that
     would have to be undone to reverse it.
   - **The freshness indicator moved into the topbar.** `LiveStatus` was
     Overview-only (§A.4 round 7). Every page polls, and on the other nine a
     frozen server was indistinguishable from a quiet factory — the exact
     confusion Overview had already fixed for itself. It now sits in the
     shell, fed by the shell's own 5s poll.
   - **Two clocks, not one.** Beside it, `last event <age> ago`.
     `livenessLabel()` answers "is my screen current"; `lastEventLabel()`
     answers "is the factory moving". They come apart in precisely the case
     the indicator exists for: a healthy server polled every five seconds
     reports `Live` indefinitely over a factory that has emitted nothing since
     Tuesday. Both are shown because neither implies the other. Hidden below
     768px, where the topbar has no room.
   - **Arrival badges on the nav rail.** Timeline and Errors badge *arrivals*
     — the difference between the current poll and the counter as of the last
     time the operator opened that page. Only monotonic counters qualify:
     subtract a level and the operator clearing one item produces a negative
     arrival. Lessons badges its pending *level*, rendered as itself. The
     count is capped at `99+`; the collapsed 64px rail has no room for that,
     so it draws a dot and the number reaches a screen reader through the
     button's accessible name instead — "Timeline, 3 new", never a bare `3`.
     The badge is `--ds-info-bold`, not `--ds-primary`: identical in light
     theme, but `--ds-primary` lightens in dark and takes `--ds-text-on-bold`
     to 3.68:1. Both new pairs are in `scripts/design/contrast_check.mjs`.
   - **The shell's Refresh refreshes the page, not just the shell.** Moving
     `LiveStatus` above the router made its Refresh button a lie — it would
     have reloaded the shell's pulse and left the page under it untouched.
     Rather than teach the shell what each page fetches, `usePoll` gained a
     module-level refresh signal that every mounted poller watches, so all
     four polling pages answer it with no per-page wiring. The watcher is
     registered inside `usePoll`'s setup call, so Vue's effect scope disposes
     it with the component and an unmounted page cannot be woken by it.
   - **Supersedes §2's "Right: theme toggle only."** The topbar's right side
     now carries the pulse readout, `LiveStatus`, the project `Select` (§A.1)
     and the theme toggle. Still no user menu and no masking toggle — the
     reasoning there is unchanged.
