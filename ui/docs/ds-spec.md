# Blacksmith dashboard redesign — implementation-ready UI spec

Read against: `ui/docs/DESIGN.md`, `ui/docs/design-spec.md`, `ui/src/styles/ds-tokens.css`,
`ui/src/styles/ds-components.css`, `ui/src/components/ds/*`, `ui/src/pages/*`,
`scripts/design/{check_tokens.py,lint_hardcodes.py,check_no_emoji.py,contrast_check.mjs}`,
`scripts/check.sh`, `scratchpad/plan-ui-friendly.md`, `scratchpad/ui-audit.md`, and the live
dashboard at `http://127.0.0.1:4680` (curled for real payload shapes below). Fidelity is
component-level throughout: names and layout are specified, markup is the coder's.

**Language.** All dashboard UI copy is English: labels, headings, buttons, tags, empty
states, `aria-label`s and `title` tooltips. The one exception is verbatim operator prompts
(`RequestQuote`, §2.2, and "Prompt" rows in Activity, §4.3). They render exactly as typed,
in whatever language was typed, with a `lang` attribute when the language is known. They
are never translated or paraphrased.

This is a full replacement of the vendored HDS-derived kit with a new, in-repo-authored
kit ("BS kit"). Two new npm dependencies, both small and both for one job each (§2.5):
`lucide-vue-next` (ISC) for icons and `@floating-ui/dom` (MIT) for tooltip positioning.
Nothing else is added. `@vue-flow/core` becomes unused after Flow, Roadmap
and Sessions stop being node graphs (H, G, F below) — DS-9 removes the dependency from
`package.json`.

---

## 0. What must change in the design gates and docs, exactly

The gate scripts are pattern-matched against the CURRENT file names and token prefix. A
straight token-set swap without touching them either breaks the gates (they scan the old,
now-deleted files and find "no tokens declared") or silently checks nothing. Concretely:

**File renames** (both under `ui/src/styles/`):
- `ds-tokens.css` -> `bs-tokens.css`
- `ds-components.css` -> `bs-primitives.css`
- `ui/src/components/ds/` -> `ui/src/components/kit/` (directory rename; import paths
  updated by the coder in the same PR that moves each component — see §5 build order)

**Token prefix**: `--ds-` -> `--bs-` everywhere (CSS custom properties and every `var()`
reference). Rationale for a new prefix rather than reusing `--ds-`: the operator decision
is "drop the old design system... and replace it with a new one" — keeping the old prefix
on new values would read as the same kit with a palette edit, which is not what shipped,
and would make `git log`/`grep` unable to distinguish "still-HDS-derived" code from
BS-kit code during the phased rollout in §5.

**`scripts/design/check_tokens.py`** (DS0 PR, see §5):
- `TOKEN_FILES = ("ds-tokens.css", "ds-components.css")` -> `("bs-tokens.css", "bs-primitives.css")`
- `DEFINE_RE = re.compile(r"(--ds-[\w-]+)\s*:")` -> `(--bs-[\w-]+)\s*:`
- `JS_DEFINE_RE` and `REF_RE`: same `--ds-` -> `--bs-` substitution
- The escape-hatch comment string `ds-allow-undefined-token` is kept unchanged (not
  renamed to `bs-allow-undefined-token`): it is a gate-authoring convention, not a token
  name, and renaming it is pure churn with no behavior change. Note this explicitly in
  the PR so a reviewer does not read it as an inconsistency.

**`scripts/design/lint_hardcodes.py`**:
- `EXCLUDE_FILES = {"ds-tokens.css", "ds-components.css", "icons.ts"}` ->
  `{"bs-tokens.css", "bs-primitives.css", "icons.ts"}`
- `ds-allow-hardcode` escape-hatch string: unchanged, same reasoning as above.

**`scripts/design/contrast_check.mjs`**:
- `TOKENS_PATH` -> `ui/src/styles/bs-tokens.css`
- `varRe = /--ds-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g` -> `--bs-([\w-]+)`
- Every `rows.push` template literal that prints `` `--ds-${fgKey}` `` -> `` `--bs-${fgKey}` ``
- The entire list of `check(...)` calls at the bottom is rewritten, not just re-prefixed:
  those calls hard-code pairings that belong to components this redesign deletes
  (`IdentityChip`'s 8 `--ds-chart-N` slots, `FlowPage.vue`'s edge stroke and live-dot,
  `RoadmapPage.vue`'s old VueFlow canvas border). The replacement check list (§1, "Pairs
  the gate checks" table) covers every new colour-against-surface pairing this spec
  introduces: status-tag text/subtle-bg pairs (7 tones x 2 themes), the live-indicator
  dot against topbar surface, the roadmap now-line and pulsing dot against the timeline
  canvas, and the Kanban card's assignee-chip text against its tint background. It also
  covers the 9 event-kind text/subtle pairs (§1.1 `--bs-event-*`), each kind's stripe and
  icon colour against `--bs-surface-raised` (3:1 UI floor), and the Prompt row's text,
  subtle text and link against `--bs-surface-sunken`. The
  script's mechanics (parse `:root`/`.dark` blocks, WCAG relative-luminance formula,
  exit 1 on any failure) do not change.

**`scripts/design/check_no_emoji.py`**: no change. It scans `ui/src` by path, not by
token name or component file name, and the "AI-pattern tell" em/en-dash check already
skips comment lines. Confirmed by reading the script; nothing in this redesign moves it
outside `ui/src`.

**`scripts/check.sh`**: no change to the design block (lines ~424-458). It calls the four
scripts by their `scripts/design/*` path, which does not move; only the scripts' internal
contents change, per above.

**`ui/docs/DESIGN.md`**: rewritten as part of DS0 (§5) to describe the BS kit in place —
new Provenance paragraph ("authored in-repo, 2026-09-30, supersedes the HDS-derived kit
retired the same day — see git history for the prior file if a comparison is ever
needed"), a new Primitive inventory table (§2 below), and the Gates-wired table's file
paths updated to `bs-tokens.css` / `bs-primitives.css`. The Declarations section (variant,
UI language, date format, delete semantics, 390px responsive floor) is unchanged — none of
those are kit-specific, they are product decisions this redesign does not revisit.

**`ui/docs/design-spec.md`**: kept as a historical reference for the sections this
redesign does not touch (§2 responsive floor, §7 announcement/live-region conventions,
§9 date format) but its Primitive inventory and any HDS-specific component description
is superseded by `DESIGN.md`'s new table — add one line at the top of `design-spec.md`
under a `## Superseded` heading pointing at `DESIGN.md` for the current kit, rather than
rewriting 882 lines of a document that is otherwise still accurate. Say this explicitly in
the DS0 PR description so a reviewer does not read the untouched 880 lines as an oversight.

---

## 1. Tokens

Semantic names only; no numbered scale copied over from HDS's zinc/blue palette (the
hexes are close to Linear's because the brief asks for it, not because they are carried
over — every value below was picked and contrast-checked fresh for this file).

### 1.1 Colour — light theme (`:root`)

| Token | Hex | Role |
|---|---|---|
| `--bs-surface` | `#ffffff` | page background |
| `--bs-surface-sunken` | `#f7f7f8` | canvas / timeline track / code blocks |
| `--bs-surface-raised` | `#ffffff` | card background (differentiated from page by border+shadow, not fill) |
| `--bs-surface-overlay` | `#ffffff` | dialog / popover / toast |
| `--bs-border` | `#e4e4e7` | hairline default |
| `--bs-border-bold` | `#a1a1aa` | hairline on hover/focus-adjacent, table dividers under a header; outline of the selected chip / current wave |
| `--bs-surface-selected` | `#f4f4f5` | neutral selection fill: active nav item, selected filter chip, selected segment, selected roadmap row |
| `--bs-focus-ring` | `#53565c` | `:focus-visible` outline, 2px solid, 2px offset. Neutral, not the accent (§1.9) |
| `--bs-text` | `#0b0c0e` | body text |
| `--bs-text-subtle` | `#53565c` | secondary text (meta rows, timestamps) |
| `--bs-text-subtlest` | `#696c72` | tertiary text: meta, timestamps, placeholder (was `#75787e`, raised to clear 4.5:1 everywhere, §1.3) |
| `--bs-text-disabled` | `#a1a1aa` | disabled control text |
| `--bs-text-on-accent` | `#ffffff` | text on `--bs-accent` |
| `--bs-accent` | `#2a5adf` | primary button (one per screen), the unread dot, progress fills. Not links, not nav, not focus (§1.9) |
| `--bs-accent-hover` | `#1e46b8` | |
| `--bs-accent-pressed` | `#173a99` | |
| `--bs-accent-subtle` | `#eaf1ff` | the Prompt event tint only (same value as `--bs-event-prompt-subtle`). Not used for selection |
| `--bs-link-text` / `--bs-link-underline` | `var(--bs-text)` / `var(--bs-text-subtlest)` | links: text colour at rest, underline on hover in dense UI; prose links keep a permanent underline |
| `--bs-tooltip-bg` / `-text` / `-border` | `#26272b` / `#f4f4f5` / `#26272b` | `Tooltip` (§2.5): dark chip on light pages, 13.57:1 |
| `--bs-tone-done-text` | `#166534` / `--bs-tone-done-subtle` `#e9f7ee` | status tag: completed / waived |
| `--bs-tone-review-text` | `#7c3aed` / `--bs-tone-review-subtle` `#f4f0fe` | status tag: reviewing / grading / merging |
| `--bs-tone-progress-text` | `#1d4ed8` / `--bs-tone-progress-subtle` `#eaf1ff` | status tag: in-progress / ready |
| `--bs-tone-todo-text` | `#53565c` / `--bs-tone-todo-subtle` `#f1f1f2` | status tag: todo / draft / queued |
| `--bs-tone-blocked-text` | `#b45309` / `--bs-tone-blocked-subtle` `#fef3e0` | status tag: blocked / escalated / stalled |
| `--bs-tone-danger-text` | `#b91c1c` / `--bs-tone-danger-subtle` `#fdecec` | status tag: failed / dead; error rows |
| `--bs-tone-warning-text` | `#b45309` / `--bs-tone-warning-subtle` `#fef3e0` | warnings that are not yet failures (budget nearing limit) |
| `--bs-event-<kind>-text` / `--bs-event-<kind>-subtle` | prompt `#1e46b8`/`#eaf1ff`, dispatch `#0e7490`/`#e6f6f9`, returned `#166534`/`#e9f7ee`, finding `#7c3aed`/`#f4f0fe`, gate `#3730a3`/`#eef0ff`, merge `#9d174d`/`#fdeef5`, error `#b91c1c`/`#fdecec`, feedback `#92400e`/`#fef3e0`, system `#53565c`/`#f1f1f2` | Activity event kinds (`EventKindTag`, `TimelineRow`, §2.2). Prompt is the one blue kind and it is a tint, not a solid fill (was `#ffffff` on solid `#2a5adf`). `text` doubles as the row's 3px left stripe. Colour is never the only signal: every kind also carries its text tag. No kind carries an icon (§2.2 `EventKindTag`) |
| `--bs-chart-1..6` | `#2a5adf #16a34a #d97706 #7c3aed #dc2626 #0891b2` | project/epic identity colour (chips, roadmap lane accents) — 6, not 8, since the redesign drops per-severity chart slots; a 7th project cycles back to slot 1 with a different chip shape (see §2 `IdentityChip`) |

### 1.2 Colour — dark theme (`.dark`)

**Principle: dark mode is muted and low-chroma.** No pure-white text, no saturated fills,
no near-black page. Surfaces are warm-neutral greys a few steps apart; text is off-white;
every tone and event colour is desaturated so a board full of tags reads calm, while each
pair still clears 6:1. Selection is a lighter neutral surface, never a blue fill.

| Token | Hex | Was |
|---|---|---|
| `--bs-surface` | `#151619` | `#0c0d0f` |
| `--bs-surface-sunken` | `#111214` | `#050506` |
| `--bs-surface-raised` | `#1b1c1f` | `#141517` |
| `--bs-surface-overlay` | `#212226` | `#18191c` |
| `--bs-surface-selected` | `#26272b` | (new) |
| `--bs-border` | `#2c2d31` | `#232427` |
| `--bs-border-bold` | `#45474c` | `#3a3b3f` |
| `--bs-focus-ring` | `#b8bbc1` | `#6c9bff` |
| `--bs-text` | `#e3e4e6` | `#f3f4f6` |
| `--bs-text-subtle` | `#b8bbc1` | `#d4d4d8` |
| `--bs-text-subtlest` | `#9a9ea6` | `#a1a1aa` |
| `--bs-text-disabled` | `#5f6268` | `#52525b` |
| `--bs-text-on-accent` | `#151619` | `#0c0d0f` |
| `--bs-accent` | `#86a4e2` | `#6c9bff` |
| `--bs-accent-hover` | `#9db7eb` | `#8bb0ff` |
| `--bs-accent-pressed` | `#b2c8f3` | `#aecaff` |
| `--bs-accent-subtle` | `#1b2435` | `#122140` |
| `--bs-link-text` / `--bs-link-underline` | `var(--bs-text)` / `var(--bs-text-subtlest)` | (new) |
| `--bs-tooltip-bg` / `-text` / `-border` | `var(--bs-surface-selected)` / `var(--bs-text)` / `var(--bs-border-bold)` | (new) |
| done text/subtle | `#7bc990` / `#17291b` | `#4ade80` / `#0f2417` |
| review text/subtle | `#b6add9` / `#252131` | `#c4b5fd` / `#241a3d` |
| progress text/subtle | `#99b7da` / `#1a2532` | `#93c5fd` / `#122140` |
| todo text/subtle | `#b8bbc1` / `#232428` | `#d4d4d8` / `#1e1f22` |
| blocked text/subtle | `#d9b56b` / `#2c230f` | `#fbbf24` / `#3a2705` |
| danger text/subtle | `#e18d8a` / `#331d1c` | `#f87171` / `#3a1010` |
| warning text/subtle | `#d9b56b` / `#2c230f` | `#fbbf24` / `#3a2705` |
| event prompt text/subtle | `#92b1ef` / `#1b2435` (tint) | `#0c0d0f` / `#6c9bff` (solid) |
| event dispatch text/subtle | `#7cc2cb` / `#0c292c` | `#67e8f9` / `#0b2a30` |
| event returned text/subtle | `#7bc990` / `#17291b` | `#4ade80` / `#0f2417` |
| event finding text/subtle | `#b6add9` / `#252131` | `#c4b5fd` / `#241a3d` |
| event gate text/subtle | `#a8b2de` / `#1f2333` | `#a5b4fc` / `#1c1f3d` |
| event merge text/subtle | `#d5a3bd` / `#301d27` | `#f9a8d4` / `#3a1026` |
| event error text/subtle | `#e18d8a` / `#331d1c` | `#f87171` / `#3a1010` |
| event feedback text/subtle | `#d9b56b` / `#2c230f` | `#fbbf24` / `#3a2705` |
| event system text/subtle | `#b8bbc1` / `#232428` | `#d4d4d8` / `#1e1f22` |
| `--bs-chart-1..6` | `#86a4e2 #7bc990 #d9b56b #b6add9 #e18d8a #7cc2cb` | `#6c9bff #4ade80 #fbbf24 #c4b5fd #f87171 #22d3ee` |

The dark values are declared twice with identical content, under
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and under
`:root[data-theme="dark"]`, so the OS setting and the explicit toggle agree.

### 1.3 Measured contrast (WCAG AA; 4.5:1 text / 3:1 UI-graphic floor — this is the exact
table `contrast_check.mjs`'s rewritten check list encodes, see §0)

| Pair | Light | Dark |
|---|---|---|
| text / surface | 19.57:1 | 14.22:1 |
| text-subtle / surface | 7.36:1 | 9.40:1 |
| text-subtlest / surface | 5.26:1 | 6.73:1 |
| text-subtlest / surface-raised | 5.26:1 | 6.34:1 |
| text-subtlest / surface-sunken | 4.92:1 | 6.98:1 |
| text / surface-raised | 19.57:1 | 13.39:1 |
| text / surface-selected (active nav, selected chip) | 17.80:1 | 11.73:1 |
| accent / surface | 5.79:1 | 7.26:1 |
| text-on-accent / accent (button label) | 5.79:1 | 7.26:1 |
| focus-ring / surface (UI, 3:1 floor) | 7.36:1 | 9.40:1 |
| done text / done-subtle | 6.45:1 | 7.74:1 |
| review text / review-subtle | 5.09:1 | 7.44:1 |
| progress text / progress-subtle | 5.91:1 | 7.49:1 |
| todo text / todo-subtle | 6.52:1 | 8.06:1 |
| blocked text / blocked-subtle | 4.57:1 | 7.95:1 |
| danger text / danger-subtle | 5.66:1 | 6.28:1 |
| warning text / warning-subtle | 4.57:1 | 7.95:1 |
| event prompt text / prompt-subtle (tint) | 7.06:1 | 7.23:1 |
| event dispatch text / subtle | 4.83:1 | 7.62:1 |
| event returned text / subtle | 6.45:1 | 7.74:1 |
| event finding text / subtle | 5.09:1 | 7.44:1 |
| event gate text / subtle | 8.77:1 | 7.49:1 |
| event merge text / subtle | 7.03:1 | 7.37:1 |
| event error text / subtle | 5.66:1 | 6.28:1 |
| event feedback text / subtle | 6.45:1 | 7.95:1 |
| event system text / subtle | 6.52:1 | 8.06:1 |
| event stripe colour / surface-raised (UI, 3:1 floor) | >= 5.36:1 | >= 6.80:1 |
| text / prompt tint (Prompt row) | 17.26:1 | 12.22:1 |
| text-subtle / prompt tint (Prompt row meta) | 6.49:1 | 8.08:1 |
| tooltip text / tooltip bg | 13.57:1 | 11.73:1 |
| icon in `IconButton` (text-subtle) / surface | 7.36:1 | 9.40:1 |

Every text pair now clears 4.5:1 in both themes, so the old exception for
`--bs-text-subtlest` (4.43:1 light) is gone: raising it to `#696c72` makes it safe on
`surface`, `surface-raised` and `surface-sunken`, including `RequestQuote`'s meta line.
The dark tooltip sits on `surface-selected`, which is only 1.21:1 against the page; its
edge comes from `--bs-tooltip-border` (1.95:1) plus `--bs-shadow-md`, and the 11.73:1
text pair is what carries the content. `--bs-text-disabled` (light 2.56:1) is exempt as
disabled-control text under WCAG 1.4.3 and is never used for anything else.

### 1.4 Type scale

| Token | Size / line-height | Use |
|---|---|---|
| `--bs-text-xs` | 12px / 16px | meta, timestamps, table headers |
| `--bs-text-sm` | 13px / 20px | secondary body, card meta row |
| `--bs-text-base` | 14px / 20px | default body, table cells |
| `--bs-text-md` | 16px / 24px | card titles, section labels |
| `--bs-text-xl` | 20px / 28px | page H1 |
| `--bs-text-2xl` | 24px / 32px | rare — big stat numbers only |
| `--bs-font-weight-normal` / `-medium` / `-semibold` | 400 / 500 / 600 | 600 is for the one title of a block (below); 500 for table headers, tags, the active nav label and selected chip; 400 for everything else |

**Text hierarchy.** Every block (card, inbox row, wave header, table row, stat tile) uses
the same four levels. The levels differ by colour and size first, weight second.

| Level | Colour | Size | Weight | Example |
|---|---|---|---|---|
| Title | `--bs-text` | 14–16px (`base`/`md`), 20px for the one hero title of a card | 550–600 | "Approve waiver for 2 minor findings" |
| Body | `--bs-text` | 14px | 400 | the sentence on an Activity row |
| Description | `--bs-text-subtle` | 1px smaller than the title it sits under (13px under 14px) | 400 | "Checkout flow · review found 2 style issues; merge is waiting on you" |
| Meta | `--bs-text-subtlest` | 12px | 500 (400 inside a sentence) | "2 h ago", "shop-api", "Wave 3 of 4" counts |

**One bold per block.** A block has at most one element at 600: its title. Everything
else in it is 400 or 500. To make something stand out without bold, use colour
(`--bs-text` against `-subtle` neighbours) or size. Concretely: stat numbers, token totals
and percentages are 400 (a 22px stat value may stay 600 because its label is 400 and
nothing else in the tile is bold); wave headers bold only "Wave 3 of 4" and render
"· 3/5 done" at 400 in `--bs-text-subtle`; table headers, tags, pills, the active nav item
and the selected chip are 500, never 600; an unread inbox title is 600 and a read one is
500, so unread is the only thing in the row that is bold. Inline `<b>` inside a
description is not used.

System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif`),
one mono stack for ids/paths in "Details" affordances (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`).

### 1.5 Spacing (4px base)

`--bs-space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 24px, `-6` 32px, `-7` 48px.
(Note: the old kit's undeclared `--ds-space-5` bug from `check_tokens.py`'s own docstring
is exactly why this scale declares every step it names, including 5, up front.)

**Where each step goes.** Measured in the review page after the spacing audit; values are
the tokens, not ad-hoc pixels.

| Place | Value |
|---|---|
| Page side gutter | 32px (`-6`) desktop, 16px (`-4`) below 480px; content max-width 960px |
| Between page sections | 48px (`-7`) |
| Section heading to its content | 32px above (`-6`), 12px below (`-3`) |
| Card padding | 16px (`-4`); 20px for a page-level block such as `EpicBlock` |
| Gap between stacked cards | 12px (`-3`) |
| Gap between columns / side-by-side cards | 24px (`-5`) |
| List / inbox / event row padding | 12px 16px (`-3` `-4`) |
| Gap between rows inside a list | 12px, or a hairline with the row padding doing the spacing |
| Stat tiles gap | 16px (`-4`) |
| Table cell padding | 10px 12px |
| Day header in a feed | 20px above, 8px below |
| Main content area padding | 24px (`-5`) |

**Timeline geometry** (`RunHistoryTimeline`, Activity day groups). The rail and the dots
are drawn from one set of variables so their centres cannot drift apart:
`--tl-rail-x: 7px` (rail centre from the list's left edge), `--tl-rail-w: 2px`,
`--tl-dot: 12px`, `--tl-lh: 24px` (the entry's first-line height), `--tl-gap: 16px`
(between entries). The rail is `li::before` at `left: calc(var(--tl-rail-x) - var(--tl-rail-w)/2)`;
the dot is `li::after` at `left: calc(var(--tl-rail-x) - var(--tl-dot)/2)` and
`top: calc((var(--tl-lh) - var(--tl-dot))/2)`. Measured in the browser: rail left 6px +
2px wide, centre 7px; dot left 1px + 12px wide, centre 7px; dot top 6px on a 24px first
line, so it is centred on the first line of text. Entries carry no leading icon: rail dot,
then the outcome `Tag` and the text.

### 1.6 Radius

`--bs-radius-sm` 4px (chips, tags), `--bs-radius-md` 8px (cards, buttons, inputs),
`--bs-radius-lg` 12px (dialogs, popovers), `--bs-radius-full` 999px (avatars, dots).

### 1.7 Shadow

`--bs-shadow-sm` `0 1px 2px rgba(0,0,0,.04)` (card resting), `--bs-shadow-md`
`0 4px 12px rgba(0,0,0,.08)` (popover, dropdown), `--bs-shadow-lg`
`0 12px 32px rgba(0,0,0,.16)` (dialog). Dark theme reuses the same alpha values against a
near-black background rather than a separate light-source shadow set — flat elevation via
border, per the brief's "hairline border, subtle radius" language.

### 1.8 Motion

`--bs-duration-fast` 120ms, `--bs-duration-base` 200ms, `--bs-duration-slow` 400ms (the
roadmap "now-line" pulse only). `--bs-ease-standard` `cubic-bezier(.2,0,0,1)`.

```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important; scroll-behavior: auto !important; }
}
```
Every animated element in this spec (roadmap pulsing now-dot, current-sprint bar
animation, live-indicator dot, the Activity new-row highlight: a ~2.4s slide-in plus a
neutral `--bs-surface-selected` background that fades out, never an accent tint, per §1.9) MUST also carry a static fallback that alone conveys the
state (solid fill, a text label, or both) — never colour/motion as the only channel. This
directly satisfies plan-ui-friendly.md item G's "Respect prefers-reduced-motion."

### 1.9 Accent budget (less blue)

Blue means one thing: "this is the action" or "this is you". Everything else is neutral.

- **Primary button:** at most one `Button variant="primary"` per screen region; every
  other button is secondary or ghost.
- **Links:** `--bs-link-text` (the text colour), no underline at rest inside dense UI
  (rows, cards, tables), underline in `--bs-link-underline` on hover and focus. Links in
  running prose keep a permanent underline so they stay findable without colour.
- **Selection is neutral:** the active nav item, a selected filter chip, the selected
  segment of a segmented control, the current wave and the selected roadmap row use
  `--bs-surface-selected` plus, where an edge is needed, `--bs-border-bold`, with a 500
  label. Never `--bs-accent-subtle`, never an accent border.
- **Focus:** `:focus-visible { outline: 2px solid var(--bs-focus-ring); outline-offset: 2px }`,
  light `#53565c`, dark `#b8bbc1`. Neutral and high-contrast, not blue.
- **Events:** Prompt is the only blue event kind, and it is a tint (`--bs-event-prompt-subtle`
  background, `--bs-event-prompt-text` label), not a solid fill. The Prompt row itself sits on `--bs-surface-sunken`; a highlighted source
  prompt uses `--bs-surface-selected` plus a 4px stripe, not an accent fill.
- **Where accent stays:** the primary button, the unread dot, progress fills
  (`ProgressRing`, `ProgressBarMini`, `ProgressBar`), and the Prompt tint.

---

## 2. Component inventory

### 2.1 New primitives (`ui/src/components/kit/`)

| Component | Props / variants | States |
|---|---|---|
| `Button` | `variant: primary\|secondary\|ghost\|danger\|link`, `size: sm\|md`, `icon?` | default, hover, pressed, disabled, loading (spinner replaces label, width locked) |
| `IconButton` | `icon` (a Lucide component), `label` (required; becomes both `aria-label` and the tooltip text, §2.5), `size: sm (22px, no border) \| md (28px)`, `disabled?` (renders `aria-disabled="true"` so the tooltip still shows on focus) | same as Button; icon colour `--bs-text-subtle`, `--bs-text` on hover |
| `Icon` | `icon` (a Lucide component), `size: 14\|16\|20` (default 16), `label?` | decorative by default (`aria-hidden="true"`, `focusable="false"`); with `label` it renders `role="img"` + `aria-label`. Stroke 1.75 at 14/16, 1.5 at 20; colour is `currentColor`, so it inherits from the text it sits in. Full rules §2.5 |
| `Tag` | `tone: done\|review\|progress\|todo\|blocked\|danger\|warning\|neutral`, `size: sm\|md` | static (no interactive state; this is the redesign's "pastel status tag") |
| `Chip` | `variant: assignee\|identity`, `color?` (identity tone index 1-6), `avatarInitial?` | default, hover (assignee chip is a link to a role/agent) |
| `Card` | `padding: sm\|md\|lg`, `interactive?` (adds hover elevation + cursor) | default, hover (only if `interactive`), focus-visible |
| `Input` / `Textarea` / `Select` / `RadioGroup` | unchanged contract from the old kit (native-element wrappers); ported, re-styled to new tokens | unchanged |
| `Dialog` / `AlertDialog` / `Popover` / `Toast` | ported unchanged in behaviour (focus trap, Esc, `role="status"`/`aria-live`), re-styled | unchanged |
| `Tooltip` | rebuilt on `@floating-ui/dom`; `text`, `placement?` (default `top`), `mode: describe\|label` | hidden, shown (hover after 300ms, focus immediately), dismissed (Esc). Full contract §2.5 |
| `Tabs` | ported unchanged (roving-tabindex) | unchanged |
| `Table` | ported, re-styled; adds a `compact` density prop for the Activity page's dense event rows | unchanged |
| `Skeleton` | `shape: line\|block\|circle`, `width?`, `height?` | this is the primitive that fixes audit item 13 ("loading looks like empty") — every page's first paint before data arrives renders `Skeleton` blocks in place of counts/cards, never a bare "0" |
| `EmptyState` | `icon`, `title`, `body`, `action?` | ported; every empty state gets a specific `body` sentence per page (§4), never a generic "No data" |
| `Banner` | `tone: info\|warning\|danger`, `collapsible?` | ported; used for the projection-issue banner (§3) |
| `PageHeader` / `Breadcrumb` / `SectionHeading` / `Separator` | ported, re-styled | unchanged |
| `SegmentedControl` | `items: {label, to}[]`, `current?` (an item label: the control marks that item `aria-current="page"` itself, for query-only links where vue-router's exact-active cannot tell items apart), `touch?` (stays visible on phone with 44px items; the default control is hidden at <=640px) | default, hover (no underline), current (selected fill), focus-visible (inset 2px `--bs-focus-ring`; the container clips overflow). Default output with no `current` is unchanged. `ActivityScopeToggle` (Active/All, `aria-label="Activity scope"`) is its first `current` + `touch` use |
| `ProgressBar` | `segments: [{tone, value}]` (stacked, replaces the single-fill bar) | used by Epic detail's "13 of 25 tasks done" stacked bar and Roadmap's sprint fill; the overall % sits to its right as a `ProgressBarMini`-style number (12px, 400) |
| `ProgressRing` | `value`, `max?` (default 100), `tone?` (auto when omitted), `label` (required, plain sentence, e.g. "71% of token budget used") | 20px inline SVG ring (`r=8`, `pathLength=100`, 2.5px stroke): track `--bs-border`, fill in the tone colour; the % number sits to its right at 14px/400 `--bs-text`. Wrapper is `role="img"` + `aria-label`=`label`; hover/focus shows a `Tooltip` with the exact values ("127,402,118 of 180,000,000 tokens (71%)"). CSS class `.pring` |
| `ProgressBarMini` | same props as `ProgressRing` | 56×6px rounded track (`--bs-border`) with a tone fill, number to the right at 12px/400. Same a11y contract. CSS class `.pmini`, number `.pnum` |
| `BarChart` (prop addition) | gains an optional `stacked: boolean` + `series: [{key, tone}]` pair (pattern 10, §2.4c) — same inline-SVG/`role="img"`/sr-only-`<table>` accessible contract, same `takeaway` requirement, just a second render path for a per-role/per-tier stacked daily series instead of one bar per day |
| `RelativeTime` | `iso`, `now?` (test seam), `duration?` (reads "for 12 min" / "for 2 h" / "just now" instead, for how long something has been in its current state; `LiveSessionCard` only) | renders "5 min ago" / "2 h ago" / "3 d ago" inside a `<time datetime>`; the absolute time ("30 Sep 2026, 14:07:12") in a `Tooltip` (describe mode, the element is focusable), not a `title` attribute — the single implementation for every relative-time surface named in the brief |

**Progress tones and placement.** Tone is computed when `tone` is omitted: for a budget
(`max` is a budget) `< 90%` accent, `>= 90%` warning, `> 100%` danger (ring drawn full,
number reads the real value, e.g. "103%"); for a plain ratio (tasks done, agreement rate)
accent, and success once it reaches 100%. Colour is never alone: the number is always
shown and the `label` says "over budget" when it is. Use the **ring** for one stand-alone
ratio in a card or stat tile; use the **mini bar** inside table rows, lists and phase/wave
rows, where rows stack and the bars line up. Keep the plain-words text beside either
("127M of 180M tokens"); the visual replaces only the "(71%)" parenthetical. Pages:
Home "Running now" (ring, "10.6M of 10.3M tokens", 103% danger) and Budget (ring,
71%); Cost & quality "Second-opinion reviewers" (ring, 37%); Work -> Roadmap `EpicBlock`
epic rows and `WaveList` wave headers (mini bar, "3/5 done" + 60%); phase progress (the
stacked `ProgressBar` + the % number).
| `CompactNumber` | `value`, `unit?: "tok"` | renders "1.2M tokens", "127K", "43"; the single implementation for every token-count surface (fixes audit items 4, 12, Analytics) |
| `LineChart` / `BarChart` / `Sparkline` | ported (inline SVG, `role="img"` + `aria-label` + sr-only `<table>`), each REQUIRES a `takeaway` slot/prop that renders one sentence above the chart — enforced by the Analytics/Activity page contract in §4, not by the component itself refusing to render without one (no such runtime gate exists; a spec-reviewer/coder discipline, called out here so it is not missed) |

### 2.2 New composite / gap components

| Component | Role |
|---|---|
| `TaskCard` | Kanban and Wave-list card, five fixed rows (pattern 6, §2.4 second fold): (1) short `taskId` muted + `AgentChip` (operator 2026-10-06: the `Quote` icon is removed from row 1); (2) `title` (humanized), clamped 2 lines, followed by a small inline copy-task-id icon right after the last word (operator 2026-10-06; kept visible after the ellipsis when the 2-line title is cut); (3) optional one-line `summary`, togglable via display options; (4) chip row — `status` `Tag` only for a non-default status, `IdentityChip` only when not the active grouping, up to 2 `tags`/labels then "+N"; (5) meta row — role/assignee on the left (hidden when grouped by role), judge-round/attempt count or `RelativeTime` "updated X ago" on the right. Props: `taskId`, `title`, `summary`, `status`, `assignee`, `role`, `updatedAt`, `attemptCount`, `judgeRound`, `dependencies: [{taskId, title, status, edgeType}]`, `commentCount`, `prUrl?`, `screenshotCount?`, `groupBy` (controls which row-4/5 field is suppressed), `requestFirstLine?` (the linked request's first line; no row-1 `Quote` icon). The `AgentChip` carries the `Bot` icon; row 5 shows `Clock` + `RelativeTime`. Replaces `KanbanBoard`'s old `TaskCard` and Flow's DOM task node — one component for both surfaces. |
| `KanbanBoard` | Column layout, ported at the layout level, re-themed; "Completed" column collapsed by default per audit Kanban-5. Grouping is switchable (status/project/epic/role, each with a "none" column, pattern 6). Column header: status icon (Lucide, coloured by the column's tone, decorative), name, count pill, a column menu behind a sm `IconButton` `Ellipsis` "Column menu" with "Hide column", restorable from a "Hidden columns" control in the display-options popover (`KanbanDisplayOptions`, below). Empty column: one plain sentence, e.g. "No tasks in Blocked." Columns above `KANBAN_VIRTUALIZE_THRESHOLD` (a named constant, default 30, `ui/src/lib/constants.ts`) render virtualised. Follow-up fixes of one parent task stack into one `KanbanFollowupGroup` card per column once there are two or more ("3 fixes · Settings layout"; a native `<details>`, collapsed by default, open state kept per tab in `sessionStorage`); the group counts as one item toward "View N more", each fix row keeps the inline copy-id icon, and no card shows an id as text. A group shows at most 5 fix rows, then a "Show N more" row; a quick-look on a fix opens its group (revealing a row past the cap); the summary is one arrow-key stop and an open group's rows are stops too (arrows on a row move focus, the copy icon keeps its own keys). Audit-axis judge rows never reach the board. |
| `KanbanDisplayOptions` | Popover: one-line-summary on/off, group-by (status/project/epic/role), hidden-columns list. Per-viewer preference, persisted to `localStorage` under one namespaced key, read/write wrapped in `try`/`catch` with a hardcoded default (`{summary: true, groupBy: "status", hidden: []}`) used whenever storage throws or is unavailable (private browsing, quota). |
| `WaveList` | One row per wave: header "Wave N of M · X/Y done", `ProgressBar`, state tag (done/running/upcoming), collapsed-by-default for past waves, contains `TaskCard`s. Replaces the entire Flow page (plan item H). |
| `RoadmapSwimlane` | Milestone/phase rows with epic sub-rows, a months header, a "now" vertical line with a pulsing dot (static fallback: a solid line + "Now" label), bars: past faded solid / current solid animated / upcoming dashed. Replaces the VueFlow roadmap canvas (plan item G). No `@vue-flow` import. One instance per project section (`RoadmapProjectSection`), windowed to 1 earlier + the current + 2 later lanes; the current lane carries a "Current" `Tag` and `aria-current="step"`. Label rule: the lane name wraps to two lines, then ellipsizes (full name in `title`), and the Tag sits at the end of the label and never shrinks; the label column is 232px, 180px at tablet widths (<=900px) so the track stays >=430px at 768px. One track column serves every row, the axis and the now line: an epic row indents its name (14px, weight 400, subtle colour; text colour when selected), not the row, and an axis label near the right end ends at its tick so it stays inside the track. The empty track stays visible on a selected or hovered row (surface fill plus a border hairline). |
| `EpicBlock` | Sits below the project section holding the selection on Work -> Roadmap (last when none does) and follows its selection (replaces the old right-hand `RoadmapDetailPanel` and the separate Epic page). **Phase selected**: goal, "13 of 25 tasks done", stacked `ProgressBar`, exit criteria, then one section per epic in the phase (name, status `Tag`, "N of M tasks done", a "Show waves / Hide waves" `aria-expanded` toggle over that epic's `WaveList`); the in-progress epic is expanded, the rest collapsed; an epic with no tasks reads "No tasks tracked". **Epic selected**: epic name, project, status, progress, the "Epic started from" `RequestQuote`, the plan-version picker ("Plan: latest (v12) / earlier drafts"), then `WaveList`. |
| `AgentBlock` | One block per role inside a session's detail view: role's friendly name, then a list of its agents with one-line "what it is doing" (derived from last event), `RelativeTime` duration, in/out tokens via `CompactNumber`, or "not measured", plus an `AgentStatusBadge` per agent (pattern 13, §2.4c). Replaces the Sessions graph node (plan item F) and the per-node canvas entirely — no `@vue-flow` import on Sessions either. |
| `AgentStatusBadge` | Workload-axis-only badge (pattern 13, §2.4c): reads the same `agentActivity` value `AgentChip` does (`working`/`stalled`, `agents-registry.ts`'s `isWorkingAt`, `DEFAULT_STALE_HOURS`), plus `agentWaitingThresholdMs` (pattern 3, §2.4) to flag "queued longer than expected" as a named `anomaly` tone, never rendered as "busy" (a queue-depth problem is not a productivity signal). **Presence is not shown**: the projection has no per-agent heartbeat or online/offline signal today (only a dispatch-elapsed-time estimate), so this badge ships single-axis (workload only); a second, true presence axis is filed as a named follow-up, not invented here. |
| `SessionRow` | One row in the Sessions history list: run label (derived title, plan item B), project, started `RelativeTime`, duration, agent count, last step (humanized). |
| `TimelineRow` | **One shared row** for the Activity feed, Home "Recent activity" and the task-detail history (`RunHistoryTimeline` renders its entries with it), so the three cannot drift (replaces the earlier `TimelineRow`/`ActivityRow` drafts). Grid: body · time · chevron. Line 2 is always the muted **meta line** and the chevron opens the **expanded body**; both per kind in §4.3 "Meta line and details". **No leading kind icon**: the kind is carried by the `EventKindTag` and the 3px stripe, which is enough and keeps the rows aligned on text. Body line 1: `EventKindTag`, then for gates an extra status `Tag` "Passed" (done tone, `CircleCheck` icon) or "Failed" (danger tone, `CircleX` icon) — a status icon inside the tag, not a row icon, then a humanized sentence with the task as a link ("Coder on Show shipping fee before payment"). Line 2: the meta line (12px, weight 400, `--bs-text-subtle`, tabular numbers, at most 4 items; §4.3), ending in "because of your prompt at 10:05" for caused dispatches, a link to the nearest prompt row. The dispatch reason, finding summary and other long text live in the expanded body, not on line 2. 3px left stripe in the kind colour. Variants: `prompt` (the prompt tint `--bs-event-prompt-subtle`, verbatim quote, "Caused N dispatches shown here"), `new` (fading highlight, §1.8), `caused` / `source` (`--bs-surface-selected` background plus a 4px stripe while the source prompt is hovered or focused; neutral, not accent, §1.9), `compact` (title and meta each one line with ellipsis; Home), `rail` (inside `RunHistoryTimeline`: the rail dot replaces the stripe), `group` (a "Builder ×4" row whose body is its member `TimelineRow`s). |
| `EventKindTag` | `kind: prompt\|dispatch\|returned\|finding\|gate\|merge\|error\|feedback\|system`. Text label ("Prompt", "Dispatched", "Returned", "Finding", "Gate", "Merge", "Error", "Feedback", "System") on `--bs-event-<kind>-subtle`, text only: no glyph and no icon (the earlier `&ldquo;` `&rarr;` … glyph set is dropped). Colour + words are the signal. The tag has a describe-mode `Tooltip` with the kind's one-line meaning, e.g. "Dispatched: the factory handed a task to an agent." Kind is derived client-side from the event type (a lookup table in `ui/src/lib/eventKinds.ts`); rare types map to `system`. |
| `RequestQuote` | "Requested by you" block: label + timestamp, the operator's prompt **verbatim** (`blockquote`, `white-space: pre-wrap`, 3-line clamp, "Show more" `aria-expanded` toggle), "View in timeline" link to the prompt's Activity row. `origin` variant ("Epic started from", `--bs-border-bold` rule instead of accent) shows the epic's source prompt; it is added under the task's own quote when that quote is only a generic nudge (e.g. "continue"). Empty state: "No request recorded for this task". Sunken background, 3px accent left rule. Needs data (§4.7). |
| `LessonCard` | Rule/principle text, scope ("Applies to all projects" / project name), "learned from X on DATE", `timesPrevented` as "hasn't prevented a repeat yet" or "prevented N repeats". |
| `IdentityChip` | Ported concept, restyled to the new 6-slot `--bs-chart-N` palette (was 8); deterministic hash unchanged (`ui/src/lib/identityColor.ts`, only the palette array changes length) |
| `LiveIndicator` | Single instance in the topbar: one dot + "Live — last activity 5 min ago" text, replacing the two clocks / two Refresh audit finding (top 14). Owns the one Refresh action too (rendered as an icon button beside it, disabled while `live` is on). The "5 min ago" part is a `RelativeTime` with the absolute time in its tooltip. Beside it, `IconButton`s: `Pause` "Pause live updates", `RefreshCw` "Refresh" (`aria-disabled` while live, tooltip still shows), `Moon`/`Sun` "Switch to dark theme"/"Switch to light theme", `Settings` "Settings". |
| `ProjectSwitcher` | Topbar project select; unchanged contract, restyled |
| `SidebarNav` | 6 items: Home (`House`), Work (`Kanban`), Activity (`Activity`), Sessions (`History`), Cost & quality (`Coins`), Lessons (`Lightbulb`), each a 16px icon + label; `aria-current="page"` on the active one. A sm `IconButton` `PanelLeftClose` "Collapse sidebar" in the header. Collapsed rail: icon only, each link keeps its name as `aria-label` and shows it in a label-mode `Tooltip` placed right. Ported contract (collapsed rail + Sheet off-canvas below 768px), content changed per §3. |
| `LiveSessionCard` | Home "Live sessions" card (§4.1 item 1a), composed of `Card` + `Tag` + `RelativeTime` with no new tokens: title line (weight 500, `<project> · <epic id> · wave N`, opens the epic on Kanban) with a status `Tag` and "for N min"; a muted "Now" label per working agent (humanized role + task title link, 2 lines then "+ N more"); a "Next" line. Deviation: no kit component covers a live-CLI card, so the pattern table gains this row; the pre-code spec linked the title to Roadmap, shipped as Kanban because Roadmap does not read other projects' stores yet. Own idea; no old-kit equivalent. |
| `NeedsYouInbox` | One filterable list on Home combining pending waivers (only findings on completed tasks or closed epics, the ones the factory will no longer act on), escalations, stop points and lesson candidates into a single row shape (`kind`, `title`, `description`, `project`, `RelativeTime`, action). Row anatomy: unread dot, then a two-line text column (short `title` naming the decision; below it one `description` line in `--bs-text-subtle` 12px saying why the factory stopped and what happens when you act, ellipsis-truncated, full text in a describe-mode `Tooltip`), then the meta column (project/task, time; hidden below 480px), then the action. Filter chips: All / Waivers / Escalations / Stop points / Lesson candidates. **Grouped by project**: one group header per project, name + count ("shop-api · 2", 12px/500 `--bs-text-subtle`); the group holding the most urgent item comes first (escalation > waiver > stop point > lesson candidate, then oldest); projects with nothing pending are not shown; items with no project (lesson candidates that apply to all projects) go in a last group "All projects". When the topbar `ProjectSwitcher` has a project selected, only that project's group is shown, header kept; "All projects" is hidden then. Title weight: 600 unread, 500 read (§1.4). Own idea, grounded in the same "what needs a person" job the old "Needs you" rail already did — widened from a rail to the page-first list per pattern 1 below (deviation flagged in §4.1). |
| `AgentChip` | Small chip showing a task's current role + activity state (working / reviewing / **waiting** / idle), reusing `--bs-tone-*` for the state dot. Used on `TaskCard` and the task-detail header (pattern 3 below). Not a port — no old-kit equivalent (deviation flagged in §2.4). |
| `RunHistoryTimeline` | Small vertical timeline on the task-detail page: one entry per dispatch attempt, judge round, or result, each a `TimelineRow` (`rail` variant) with a humanized label, `RelativeTime`, outcome `Tag`, meta line and chevron. Rail dot + tag only, no leading icon; geometry in §1.5. Own idea (pattern 2 below); no old-kit equivalent. |
| `TaskPeekPanel` | Slide-over quick-look panel (`Dialog`-family: modal from 641px to 1023px and not offered at ≤640px (§3.1), non-modal anchored panel >=1024px) opened by clicking a `TaskCard` on Kanban or inside Work -> Roadmap's `EpicBlock`. Shows the same header facts as task detail (title, status, `AgentChip`, `RequestQuote` incl. the "Epic started from" fallback, summary) plus a "Open full page" link. Own idea (pattern 4 below); no old-kit equivalent. |

### 2.3 Old -> new mapping table

| Old (`ui/src/components/ds/`) | Pages importing it (grep) | New component / disposition |
|---|---|---|
| AlertDialog | LessonsPage | `AlertDialog` (ported) |
| Banner | Roadmap, Projects, Sessions, Analytics, Lessons, TaskDetail, Errors, Overview, Flow, Kanban, Timeline (11) | `Banner` (ported); Overview/Activity's projection banner gets the friendly copy in audit item 1 |
| BarChart | Analytics, Errors | `BarChart` (ported, gains `takeaway` requirement) |
| Breadcrumb | none currently | `Breadcrumb` (ported, now used — App shell §3) |
| Button | 10 of 11 pages | `Button` (ported) |
| Card | Analytics, Errors, Projects, TaskDetail, Overview | `Card` (ported) |
| Dialog | Lessons, Errors, TaskDetail | `Dialog` (ported); Errors' raw-JSON detail dialog is replaced by a real per-problem summary view (audit item 9), not just restyled |
| EmptyState | 11 pages | `EmptyState` (ported, every call site gets a specific `body`, §4) |
| FilterChips | Timeline, Flow | `FilterChips` (ported); Flow's usage moves to `WaveList`'s epic filter |
| Highlight | Overview | `Card` with a tint variant (folded in; `Highlight` retired as a separate component, one less primitive to maintain) |
| Icon | Errors, Timeline (+ everywhere via other components) | `Icon` (rebuilt on `lucide-vue-next`; the hand-kept `icons.ts` SVG registry is retired, each call site imports the named Lucide component, §2.5) |
| LineChart | Analytics, Errors | `LineChart` (ported, gains `takeaway`) |
| Lozenge | Roadmap, Sessions, TaskDetail, Errors, Lessons, Flow, Overview (7) | `Tag` (renamed — "Lozenge" is jargon nobody outside a design system says out loud; same subtle/bold/outline contract, mapped onto the 7 status tones in §1.1 instead of the old 6-family + severity split) |
| MetricGrid | Analytics, Overview | `MetricGrid` (ported); Analytics' usage shrinks to ~4 metrics (§4) |
| PageHeader | 11 pages | `PageHeader` (ported) |
| Popover | TaskDetail | `Popover` (ported) |
| RadioGroup | Lessons | `RadioGroup` (ported) |
| Row / RowList | Analytics, Errors, TaskDetail, Overview (+ RowList: 6) | `Table` in `compact` density (folded in — two components doing one job) |
| SectionHeading | none (unused, per DESIGN.md) | dropped, not ported |
| Select | Kanban, Flow | `Select` (ported); Flow's plan-version picker moves into `EpicBlock` on Work -> Roadmap (§4.2) |
| Separator | none currently | `Separator` (ported, still available) |
| Sheet | none currently (mobile sidebar only, via SidebarNav) | `Sheet` (ported) |
| SidebarNav | shell only | `SidebarNav` (ported, 6-item content) |
| Skeleton | 11 pages | `Skeleton` (ported, now load-bearing for audit item 13) |
| Sparkline | none currently | `Sparkline` (ported, available for Cost & quality's trend cells) |
| StatCard | Analytics, Overview | `StatCard` (ported); Overview's stat-card links go to their matching page instead of all `/flow` (audit item 8) |
| Table | Lessons, TaskDetail, Errors | `Table` (ported) |
| Tabs | TaskDetail | `Tabs` (ported) |
| Textarea | Lessons | `Textarea` (ported) |
| Toast | none currently (mounted once in App.vue) | `Toast` (ported) |
| Tooltip | none currently | `Tooltip` (rebuilt on `@floating-ui/dom`, §2.5) |
| TwoColumn | Analytics, Overview, TaskDetail | `TwoColumn` (ported) |
| — (no old equivalent) | Flow's DOM task node, IdentityChip | see `TaskCard`, `IdentityChip` above |
| — (no old equivalent) | Roadmap's VueFlow canvas, Flow's VueFlow canvas, Sessions' one-node VueFlow canvas | `RoadmapSwimlane` + `EpicBlock` (with `WaveList`), `AgentBlock` — all drop `@vue-flow/core` |

### 2.4 Deviations: five patterns adopted from studying another product's UI

Five UI-only patterns below are new to this kit, added on operator approval after a
study of another self-hostable agent-dispatch dashboard (multica-ai/multica, Apache-2.0 +
branding/hosting conditions). Per that license and per instruction: no code, component
names, copy text, token values or asset from that project is reused anywhere in this
spec or is to be reused during implementation — every name, wording and token above and
below is Blacksmith's own. What is borrowed is the idea/shape of five interactions, named
here as explicit deviations because they have no old-kit precedent, exactly as this
role's grounding rule requires:

1. **A single "needs a person" list, not a rail** (`NeedsYouInbox`, §4.1) — the old kit's
   "Needs you" rail already existed; the deviation is widening it to the page's first,
   full section and merging four existing categories (waivers/escalations/stop
   points/lesson candidates) into one filterable list instead of four separate widgets.
2. **A per-task run history timeline** (`RunHistoryTimeline`, §4.7) — no old page shows
   dispatch attempts/judge rounds as a timeline; today this data is only visible by
   reading raw event rows on the merged Activity feed filtered by hand.
3. **A named "waiting" agent state + an agent chip on the card itself** (`AgentChip`,
   §4.2/§4.7) — the old kit shows activity only as a status tag on the task, not a
   role+state chip, and has no distinct wording for an agent that has gone quiet.
4. **A quick-look side panel before the full page** (`TaskPeekPanel`, §4.2) — every
   existing surface (Kanban, Roadmap, Epic) links straight to the full Task detail page
   today; nothing peeks first.
5. **Paginated Activity with an infinite-scroll sentinel** (§4.3) — the existing Timeline
   page today renders its full result set in one unpaginated list (confirmed at 7,474
   events live, audit item Timeline-4); day-grouping plus a "Load older" button was
   already specced above, and this deviation only adds the sentinel-driven auto-load
   behind that same button, not a new visual language.

All five read from existing projection tables via new read-only queries/endpoints named
in §4 next to each pattern — none adds a new event type or writer, per the operator's
hard rule. All five keep the same token set, contrast floors, and `prefers-reduced-motion`
rules as the rest of this spec; §4 below states exactly which query backs each one.

### 2.4b Second fold: Kanban card/column ideas (also operator-approved)

Same source, same constraint (idea only — no code, component names, copy or token value
from that project is reused; every name below is Blacksmith's own), same three hard
rules (no new event type/writer, AA contrast and `prefers-reduced-motion` unaffected,
only `ds-spec.md` edited). Landed together in DS3 (§5) since they are all one component
(`TaskCard`/`KanbanBoard`), not five separate features:

6. **A fixed five-row `TaskCard` layout, chips shown only when they add information**
   — today's card has no fixed row order and shows every chip regardless of what the
   column or grouping already says. The fixed order is row 1 short id + `AgentChip`, row
   2 clamped title, row 3 optional summary, row 4 information-only chips, row 5 role/meta
   left + count-or-time right, specified in full in §2.2's `TaskCard` entry and §4.2
   below. Blacksmith's equivalent of a red overdue-date treatment is the existing
   `AgentChip` "waiting" state (pattern 3, §2.4) — reused here rather than inventing a
   second red-for-trouble convention, since this kit already has one.
7. **Switchable column grouping, with hidden columns and virtualisation named by a
   constant** — today's Kanban only groups by status. Group-by (status default/project/
   epic/role), a "Hide column" menu with a restore control, and a named virtualisation
   threshold (`KANBAN_VIRTUALIZE_THRESHOLD`, not a bare "30" typed at the call site) are
   new to this kit, specified in `KanbanBoard`/`KanbanDisplayOptions` (§2.2) and §4.2.
8. **Per-viewer display preferences in `localStorage`** — no old page persists a display
   preference; `KanbanDisplayOptions` does, guarded by `try`/`catch` with a hardcoded
   default so a viewer with storage disabled still gets a working board, not a crash.
9. **Arrow-key card navigation, explicitly no drag-and-drop** — stated as a deliberate
   difference in §4.2, not an omission: the factory's scheduler owns task state
   transitions, so a board that let an operator drag a card between columns would imply
   a control Blacksmith does not give them.

All four keep the same tokens/contrast/motion rules as the rest of this spec and read
from data the Kanban page already fetches (`/api/kanban`'s existing per-task fields) plus
one client-only preference store — no new endpoint, event type, or writer.

### 2.4c Third fold: cost, run history, inbox and agent-status ideas (also operator-approved)

Same source and same constraints as the first two folds — idea only (no code, component
names, copy or token value from that project is reused), no new event type or writer, AA
contrast and `prefers-reduced-motion` unaffected, only `ds-spec.md` edited. Two verified
facts bound every pattern below: `/api/analytics` today has no period parameter, no
per-day token series and no per-role breakdown (`factory/orchestrator/src/db/queries.ts:2195`,
`analytics()`); and no dollar figure is ever shown anywhere in this kit, because
`cost_usd` is parsed off a run's raw harness output and explicitly not yet surfaced past
that point (`factory/orchestrator/src/runner.ts:99` and `:212`, the field's own comment:
"Read from the raw payload but not (yet) surfaced on RunOutcome") — "Cost & quality" is a
token-cost page, not a dollar-cost page, and this fold does not add a writer to change
that.

10. **A period switch, daily token series and per-role/tier breakdown on Cost & quality**
    (§4.4) — today's Analytics has no period control and no time series at all, only a
    handful of scalar metrics. `PeriodSwitch` (7/30/90 days, §2.1) sits above a stacked
    `BarChart` (the new `stacked`/`series` prop, §2.1) of daily tokens by role or model
    tier, a horizontal `BarChart` of tokens per role/model tier for the selected period,
    and a breakdown `Table`. An unmeasured run is counted and rendered as its own "not
    measured" row/segment in every one of these — never silently dropped and never folded
    into a zero bar, so a high not-measured count is visible instead of making the
    factory look cheaper than it is.
11. **Per-task cost and time, above the run history** (§4.7) — no page today shows a
    task's token/time cost at a glance; a viewer must open every run's raw event. A small
    total bar (tokens · agent-time · elapsed) sits above `RunHistoryTimeline`'s entries,
    each entry itself gains a per-run token count and duration, and a per-agent summary
    table (one row per role: runs, tokens, time) sits below the timeline. Same
    "not measured" fallback per cell as pattern 10, for the same reason.
12. **`NeedsYouInbox` read/unread state** (§4.1) — the inbox pattern 1 already added has
    no concept of "already looked at this one"; every row reads identically on every
    visit. A per-viewer unread dot + heavier title weight, `localStorage`-backed
    (try/catch, default "all unseen"), and hover-parity row actions on `:focus-within`
    close both gaps without a server-side read-state table or an archive feature.
13. **Two-axis agent status: presence and workload** (§4.6) — today's Sessions page
    conflates "an agent is dispatched" with "an agent is working productively"; a queued
    task looks identical to one that is actually stuck. `AgentStatusBadge` (§2.2) grounds
    a workload axis in the same `agentActivity`/`agentWaitingThresholdMs` values
    `AgentChip` already uses, naming "queued longer than expected" as an anomaly tone
    rather than folding it into a generic "busy" state. The projection carries no
    per-agent heartbeat or online/offline signal (verified: no such field in
    `agents-registry.ts` or the events it writes, only a dispatch-elapsed-time estimate),
    so presence is not invented here — this ships workload-only, and true presence is
    named as a follow-up needing its own data source, not a UI gap to paper over.

None of the four adds a new event type or writer: 10 and 11 are new read shapes over
`task-result-recorded`/dispatch/judge-round rows the projection already holds (`/api/analytics`
gains a `period` query param plus per-day and per-role read paths; the task-runs endpoint
from pattern 2/DS3 gains per-run token/duration fields on the same read); 12 is
client-only `localStorage`; 13 reads fields `AgentChip` already reads. All four keep the
same tokens, AA contrast floors and `prefers-reduced-motion` rules as the rest of this
spec.

### 2.5 Icons and tooltips

**Dependencies** (the only two this redesign adds):
- `lucide-vue-next` (ISC): one consistent 24-grid outline icon set with per-icon Vue
  components, so tree-shaking ships only the icons imported and no sprite or font is loaded.
- `@floating-ui/dom` (MIT): framework-free positioning (`computePosition` + `flip`,
  `shift`, `offset`, `autoUpdate`) so tooltips stay on screen near edges without a UI kit.

**`Icon`.** Sizes 14 (inside tags and meta), 16 (default: buttons, nav, labels), 20 (card
hero titles). Stroke 1.75 at 14/16, 1.5 at 20. `stroke="currentColor"`, no fill, colour
inherited from the surrounding text so icons follow the text hierarchy (§1.4) and the
theme with no extra tokens. Vertical alignment: `vertical-align: -3px` at 16px beside 14px
text. Decorative by default (`aria-hidden="true" focusable="false"`); the text next to it
is the name. No emoji and no text glyphs as icons (`check_no_emoji.py` stays).

**Where icons go.** On action buttons, the nav, status tags and metadata labels, to be
scanned faster; never as the only carrier of a status (the tag text stays). **Not** on
timeline or activity rows: `TimelineRow`, Home "Recent activity" and
`RunHistoryTimeline` have no leading icon; the colour tag (plus stripe or rail dot)
carries the kind.

| Surface | Lucide icon(s) |
|---|---|
| Nav: Home / Work / Activity / Cost & quality / Lessons | `House` / `Kanban` / `Activity` / `Coins` / `Lightbulb` |
| Sidebar collapse | `PanelLeftClose` |
| Topbar: pause / refresh / theme / settings | `Pause` / `RefreshCw` / `Moon`, `Sun` / `Settings` |
| Status tags: Running, In progress / Done, Passed / Todo, Upcoming / Blocked / Failed / Review | `Loader` / `CircleCheck` / `CircleDashed` / `Ban` / `CircleX` / `Eye` |
| Kanban: column menu / display options / copy id / linked request | `Ellipsis` / `SlidersHorizontal` / `Copy` / `Quote` |
| Peek panel: open full page / close | `Maximize` / `X` |
| Agent chip, "agents working" | `Bot` |
| Meta labels: tokens / agent-time / elapsed, updated | `Coins` / `Timer` / `Clock` |
| Links out (PR on GitHub) | `ExternalLink` |
| Show / hide waves | `ChevronDown` / `ChevronUp` |
| Activity: filter chips / new-events pill | `Filter` / `ArrowUp` |
| Metric definition | `Info` |

**Icon-only rule.** A control that shows only an icon must have an `aria-label`, and must
show a `Tooltip` whose text is exactly that `aria-label`. `IconButton` enforces it by
taking one `label` prop for both. A lint check in DS0 flags an `<IconButton>` without
`label` and any icon-only `<button>`/`<a>` without `aria-label`.

**`Tooltip`.**
- Look: `--bs-tooltip-bg` / `--bs-tooltip-text` / 1px `--bs-tooltip-border`, 12px/16px
  (13px allowed for a two-line definition), weight 400, padding 4px 8px, max-width 280px
  with wrapping, `--bs-radius-sm`+2 = 6px radius, `--bs-shadow-md`. No arrow.
- Placement: `top` by default, `offset(6)`, `flip()` and `shift({padding: 8})`, positions
  kept live with `autoUpdate` while open. Collapsed nav uses `right`.
- Timing: opens after 300ms of hover, immediately on keyboard focus; closes on
  mouseleave/blur; `Esc` dismisses it without moving focus. Only one open at a time.
  Under reduced motion it appears without the fade.
- Semantics: `mode="label"` (icon-only controls) renders the bubble `aria-hidden="true"`,
  because the control's `aria-label` already is the name. `mode="describe"` (extra
  information on a focusable element) renders `role="tooltip"` with an id and sets
  `aria-describedby` on the trigger; non-interactive triggers get `tabindex="0"`.
- Touch: no hover, so information that matters is never tooltip-only; the tooltip adds
  exact values to a visible summary.
- Never put interactive content (links, buttons) in a tooltip; that is a `Popover`.

**Tooltip audit** (what gets one, by page; every entry is shown in the review mocks):

| What | Tooltip text (example) | Page(s) |
|---|---|---|
| Every icon-only button | its `aria-label`: "Pause live updates", "Refresh", "Switch to dark theme", "Settings", "Collapse sidebar", "Copy task id", "Copy epic id", "Column menu", "Open full page", "Close (Esc)", "Open integration PR on GitHub", "Pause" (feed) | Shell, Kanban, Roadmap, Task peek, Activity |
| Collapsed nav links | "Home", "Work", "Activity", "Cost & quality", "Lessons" | Shell |
| Relative times | absolute time: "30 Sep 2026, 14:07:12" | Topbar, Home, Kanban, Activity, Task detail |
| Compact numbers | exact value: "8,312 tokens", "748,210 tokens (median)", "412,318 tokens" | Kanban, Cost & quality, Task detail |
| Progress ring / mini bar | exact values: "127,402,118 of 180,000,000 tokens (71%)", "10,612,304 of 10,300,000 tokens (103%)" | Home, Cost & quality, Roadmap |
| Time ranges | "29 Sep 2026, 14:02 to 16:12" | Task detail totals |
| Truncated titles / descriptions | the full text | Home inbox, Kanban card |
| Linked-request icon | the prompt's first line, verbatim, with `lang` | Kanban, Task peek |
| Friendly role label | the raw role: "Role: coder" | Kanban, Activity |
| Agent "waiting" chip | "No output for 14 min. A nudge may help." | Kanban |
| Event kind tag | one-line meaning: "Dispatched: the factory handed a task to an agent." | Activity, Home |
| Metric names | a one-sentence definition, behind an `Info` icon button | Cost & quality |

Not given a tooltip: text that is already fully visible, buttons with a visible label, and
anything on touch-only paths.

---

## 3. App shell

**Sidebar** (`SidebarNav`, collapsible rail >=1024px, off-canvas `Sheet` <768px): Home,
Work, Activity, Sessions, Cost & quality, Lessons — exactly the 6 top-level items, no
fly-out menus. Each item is a 16px Lucide icon + label (§2.5). Active item:
`--bs-surface-selected` background, `--bs-text` label at `--bs-font-weight-medium`,
`aria-current="page"`; no accent fill, no accent border (§1.9). Collapsed: icons only,
each with `aria-label` and a right-placed tooltip of the same text.

Operator decision (2026-10-05): Work carries two always-visible level-2 items on
desktop — Kanban and Roadmap — indented under it, no fly-out (both render whenever the
rail itself is not collapsed; collapsing the rail hides them along with every other
label). Each level-2 item gets its own `aria-current="page"` and the active fill on its own
route, at the same 2rem row height as a top-level item. While either child is active, Work
reads `aria-current="true"` (the current section, not the page): bold text, no fill, so
parent and child never fuse into one highlighted block. Collapsing the rail still sends Work to
`/work/kanban`. The phone tab bar is unaffected: Work stays a single flat tab among the
6 (see the phone list above), and the page's own Kanban/Roadmap `SegmentedControl`
switcher still does the job there.

**Topbar**: left = `Breadcrumb` (updates on route change immediately — fixes audit item
13's stale-breadcrumb-during-load); center = nothing (no page title duplication, the H1
carries it); right = `ProjectSwitcher`, then `LiveIndicator` (single dot + "Live — last
activity 5 min ago" + icon buttons for pause, refresh, theme and settings, each with a
tooltip, §2.2 `LiveIndicator`), replacing the two clocks / two per-page
Refresh buttons, audit item 14). No session picker in the topbar globally — it is scoped
into Activity and the epic block on Work -> Roadmap only (the two surfaces that actually filter by run), per
the audit's IA note; when shown there it lists derived run titles (plan item B), not raw
ids, capped at the 25 most recent with "Show more" rather than a silent cutoff (audit
item 5).

**Loading vs empty vs error** (every page):
- Loading (first paint, no payload yet): `Skeleton` blocks in place of every count, stat
  and list row; breadcrumb already shows the destination page's name (App-level route
  meta, not payload-dependent); no "0" of anything is ever rendered before real data
  arrives. This is the fix for audit item 13 stated as a hard rule, not a suggestion.
- Empty (payload arrived, genuinely nothing there): page-specific `EmptyState` with a
  concrete sentence (§4 per page) — never a bare "No data" and never the generic "This
  factory has not built a project yet" copy that was flatly false for a project with 10+
  epics (audit item 7); the copy is generated from the same counts the page renders, so it
  cannot go stale independently of them.
- Error (request failed): `Banner` tone `danger`, "Could not load <page>. <Retry> button",
  collapsed detail with the raw error for the "Details" affordance.

The projection-issue banner (top of every page when `issues` is non-empty in the API
payload) reads: "1 old record (csb-audit-1, 7 Sep) could not be read; totals may be
slightly low." with a "Details" link that expands the raw `payload.artifacts is an
object, not an array` text — this is audit item 1, and it is a client-copy change only
(the data — `issue.sessionId`/`issue.eventId` — is already in the API).

### 3.1 Mobile (≤640px)

On a phone the dashboard is for **viewing**: see what needs you, see what is running, open a
task and read it. Configuration, bulk actions, charts, and multi-column layouts are desktop-only.
Every rule below applies at `max-width: 640px` (`--bs-bp-mobile`). Between 641px and 767px, the
desktop shell with the off-canvas sidebar `Sheet` from §3 still applies.

**Tokens** (on `:root`; they are theme-independent, so no dark copy is needed):

| Token | Value | Use |
|---|---|---|
| `--bs-bp-mobile` | 640px | Breakpoint (documentation token; the media query hard-codes the same value) |
| `--bs-m-gutter` | 16px | Left and right page padding |
| `--bs-m-gap` | 16px | Vertical gap between blocks; 20px is allowed between unrelated sections |
| `--bs-m-card-pad` | 12px | Card and list-row padding; up to 16px on stat tiles |
| `--bs-touch` | 44px | Minimum height and width of every tappable target |
| `--bs-tabbar-h` | 56px | Height of the bottom tab bar, excluding `env(safe-area-inset-bottom)` |

**Layout.** One column. Nothing sits side by side except:
- stat tiles, 2-up, or 3-up when each is a short number;
- a row's tag, at the right of the row's title line.

No horizontal page scroll at 375px. The only horizontal scroller is a tab/filter row (`.mtabs`),
which scrolls within itself.

**Navigation: bottom tab bar** (`MobileTabBar`). It replaces the sidebar and the sidebar `Sheet`:
- exactly the 6 destinations from §3: Home, Work, Activity, Sessions, Cost, Lessons ("Cost &
  quality" is shortened to "Cost" because of width). Sessions was added in DS8 on operator
  decision, so a run in progress is one tap away;
- icon above a label, fixed to the bottom, `--bs-tabbar-h` tall;
- active tab: `--bs-text` label with a 2px top rule in `--bs-text` and `aria-current="page"`.
  Following §1.9, there is no accent fill and no accent colour.

Why not a top hamburger menu:
- the IA has exactly 6 flat destinations, which still fits a tab bar without a "More" tab;
- the operator mostly switches between Home and Activity, and a tab bar makes that one tap in
  thumb reach instead of two taps at the top edge;
- the current page stays visible at all times, where a hamburger hides it.

**Top bar** (`MobileTopBar`, 56px), left to right:
- the page title, which replaces the breadcrumb;
- `ProjectSwitcher` as a compact button showing the project name and a chevron;
- the `LiveIndicator` dot only, with `aria-label` "Live — last activity 5 min ago";
- one "More actions" overflow button (ellipsis icon, 44×44).

The overflow menu holds the per-page secondary controls:
- Pause live updates;
- Switch theme;
- Settings;
- page view options, such as Kanban display and the Kanban/Roadmap switch;
- "Open desktop view".

Refresh is dropped on mobile, because live updates already cover it.

**Actions.** Each screen has at most one primary action. The only one is Home's "Decide" on the
most urgent Needs-you item, and it is full width and 44px tall. Everything else is navigation, which
opens a row, or lives in the overflow menu. The following are desktop-only:
- the Kanban card menu, copy id, and quick look (`TaskPeekPanel`); tapping a card opens the task
  page directly;
- activity filter chips beyond the tab row;
- approve/reject on waivers, which opens the waiver page instead;
- lesson editing.

**Touch and tooltips:**
- every tappable element is at least `--bs-touch` in both dimensions, including tab-bar items,
  overflow items, `<summary>` rows, tabs, and icon buttons;
- tooltips are not rendered on touch devices (`@media (hover: none)`), so each icon-only control
  carries its meaning in `aria-label` (§2.5) and never in the tooltip alone;
- on mobile, Floating UI is not initialised for tooltips, but it is still used for the overflow
  menu.

**Mobile row pattern** (`MobileRow`), used for every list on every page:
- line 1 is the title, truncated with an ellipsis, with the tag at the right;
- line 2 is the muted meta (`--bs-text-subtlest`): project/epic, role, and relative time;
- a user prompt may clamp to 2 lines;
- no leading icon;
- a kind stripe on the left edge (same as desktop, §4.3);
- no hover state;
- the whole row is the tap target.

**Collapse, don't cram:**
- groups (Needs-you per project, Roadmap waves, a task's per-role table) are `<details>` with a
  44px `<summary>`;
- the most urgent group is open and the rest are closed;
- long text (the task's request quote) clamps to 3 lines, with "Show more" below it.

**Existing desktop mocks at ≤640px.** When the desktop layout is squeezed, the secondary top-bar
icon buttons are hidden and the stat grid goes 2-up with `--bs-m-card-pad` padding. Both are
fallbacks. The phone frames below are the intended layout.

**Per screen** (the frames are in the review page, labelled "Example: phone 375px"):

| Screen | Shown | Merged | Hidden (desktop-only) | Actions |
|---|---|---|---|---|
| Shell | Top bar (title, project, Live dot, More); bottom tab bar | Pause, theme, settings, and desktop view go into the overflow menu | Sidebar, breadcrumb, refresh, clocks | Navigation only |
| Home | 3-up summary (Agents, project budget ring, factory ring); Needs you grouped by project; 4 recent activity rows plus "View all" | Needs-you groups collapse, with the most urgent open; activity is cut to 4 rows | Activity filter chips, project cards grid, cost chart | **Decide** (the only primary), on the top Needs-you item |
| Work (Kanban) | Column switcher as a tab row with counts; one column of compact cards (title, tag, meta) | 5 columns become 1 column chosen by tab | Display options and view switch go into overflow; card menu, copy id, quick look | Tap a card to open the task |
| Work (Roadmap) | Project sections as `<details>` (the one holding the selection open), each with a windowed phase picker (44px disclosure rows widen it, the current lane ends " (current)"); "13 of 25" plus ring; epic list with mini bars | Waves in a collapsed group | Swimlane, per-wave task lanes, session picker | Tap an epic to open it |
| Task | Title, status tag, meta; request quote clamped to 3 lines; 3-up stats (tokens, agent time, elapsed); tabs Asked / Findings / Outputs / History; one-line timeline rows | Per-role token table in "More: tokens by role" | Side panel, raw payloads, copy buttons | "Show more" on the quote |
| Activity | Filter as a tab row; one-line event rows with "because of" as meta; "Load older" | Kind filters become tabs; pause goes into overflow | Filter chips, row hover highlight, session picker | "Load older" (secondary) |
| Cost | 7/30/90-day tabs; 2-up stat tiles (tokens per task, second-opinion ring, and 2 "Not enough data yet"); tokens by role as a list with mini bars | Charts become a single role list | Token-trend chart, provider table | Navigation only |
| Lessons | Tabs Pending / Approved / Closed / All; one-line lesson rows | None | Editing, bulk approve | Tap a row to open the lesson |

---

## 4. Pages

Real example values below are from this session's own curl output against
`http://127.0.0.1:4680` (2026-09-30); every number is what the API actually returned, not
an invented mock.

### 4.1 Home (was Overview + Projects, merged per IA)

Sections, in order:
1. **`NeedsYouInbox`** (pattern 1, deviation §2.4) — shown first, above "Running now".
   One filterable list merging four existing categories that today live as separate,
   easy-to-miss widgets: pending waivers, escalations, stop points and lesson candidates
   awaiting review. Filter chips: All / Waivers / Escalations / Stop points / Lesson
   candidates. Each row: unread dot, `kind` tag, a short title naming the decision
   ("Approve waiver for 2 minor findings"), one description line under it saying why the
   factory stopped and what acting does ("Checkout flow · review found 2 style issues;
   merge is waiting on you"), project, `RelativeTime`, one action (Review / Approve /
   Open). Description sources: waiver = task title + the findings' summary text + "merge
   is waiting on you"; escalation = role + task id + escalation reason + "the task stays
   blocked until you choose"; lesson candidate = the proposed rule text. Any of these the
   inbox query does not already join is **needs data** (a read on projected rows, no
   writer); a row whose description is missing renders the title alone, never a
   placeholder. Source queries — all read-only, all against data already
   projected, no new event type or writer. Orchestrator-verified sources (2026-09-30):
   pending waivers = findings passing `awaitsWaiverDecision()` with `waiverId === null`
   (queries.ts ~1058/1086, the same rule behind today's `alerts.pendingWaivers`);
   escalations = task rows with `taskStatus === 'escalated'` (queries.ts ~1084; there is
   no escalations table); lesson candidates = whatever `/api/lessons` already lists as
   awaiting review. **Stop points have no projected row today** — the DS2 coder must
   find where a pending hard stop is recorded before listing it; if nothing projects it,
   ship the inbox with three kinds and file the fourth as a follow-up rather than adding
   a writer. These four are merged behind
   one new read endpoint, `GET /api/inbox`, so Home issues a single request instead of
   four (name it exactly this in the DS2 PR). Empty state: "Nothing needs you right now."
   — replaces the old "Needs you" rail's identical-intent but narrower copy (audit item
   Overview-9), now covering all four categories instead of just reviews/waivers/
   escalations.
   **Grouped by project** (operator request): the list is split into one group per
   project with a header "shop-api · 2"; the most urgent group first, empty projects
   hidden, project-less items (lesson candidates) in a last "All projects" group; with a
   project selected in the topbar only that group shows. Rules in §2.2 `NeedsYouInbox`.
   **Needs new data:** each `GET /api/inbox` row must carry `project` (waivers and
   escalations can take it from the task's project key; lesson candidates have no project
   column today, so they return `project: null` and land in "All projects"), plus the
   sort key (`kind` + `createdAt`) so the server returns groups in urgency order.
1a. **"Live sessions"** - directly under the inbox, above "Recent activity". One card
   per live, in-scope CLI session from `GET /api/cli-sessions`, titled
   `<project> · <epic id> · wave N` (the title opens the epic's Kanban board), with a status
   tag, a Now line per working agent (role + task title, max 2 then "+ N more"), and a Next
   line (the first open task of the current wave, in the wave's order; "Waiting on you" when the CLI is blocked on the operator or idle with no agent working; omitted when unknown, including an unnamed first task). The wave number is omitted unless a wave session name or a single admission fixes it. A session whose only epics are closed counts as unlinked. Unlinked sessions fall
   back to the working-folder label and session name. Empty state: "No live Blacksmith
   sessions" with "N other sessions hidden" when sessions were filtered out; when the CLI session registry does not exist on the machine it shows the same title with the body "Session tracking is not set up on this machine." and no count. Needs new data:
   a `focus` object on each card (`project`, `epicId`, `wave`, `now`, `next`).
1b. **"Recent activity"** — directly under the inbox: the 8 newest `TimelineRow`s in
   the `compact` variant — the **same component as Activity**, so the same `EventKindTag`,
   colour, meta line, per-row chevron and per-kind expanded body (§4.3 "Meta line and
   details"), no leading icon. Rows start collapsed. Differences from Activity: no "Expand
   all" toggle, 8 rows only, no filters. Header link "View all activity" to Activity. Phone:
   4 rows, the meta line ends with the time, the chevron is a 44px target and the body
   expands inline. Refreshes on the same `usePoll` trigger as
   Activity. **Needs new data**: `GET /api/timeline?limit=8` (the `limit` param from §4.3).
2. **"Running now"** — grouped by project (audit item 10 / plan B). Example, from
   `/api/projects`: a "shop-api" group card showing "28 agents working" (from
   `liveAgentCount`), "10.6M of 10.3M tokens" + a danger `ProgressRing` reading "103%" (label "103% of token budget used, over budget") (from
   `tokensByEpic`, summed over the in-flight epics that have a budget, `CompactNumber`; "not measured" and no ring when none of that spend is measured), and a "Just finished" row for any epic
   whose `closedEpics` entry is newer than its `inFlightEpics` entry disappeared this
   session — closes audit item 2 (the stale "shop-ux-1 finished, PR #558" case). Each
   project card links its "View ->" to Work filtered by that project, not to a dropped
   `/flow` route (audit item 8). An epic with no activity for more than 7 days (its
   tasks' last update, or the last event naming it by payload `epic_id`, by task id, or by
   a plan-ref id such as `<epic>/plan-r3`; `epicsIdle` carries each one and its idle
   days) is not running: it leaves the card and the Budget, stays in `epicsInFlight`,
   and reads "idle 18d" wherever its name is still listed: the Kanban epic picker, and
   on the Roadmap the swimlane rows, the phone picker, the phone epic rows, the phase
   mode epic sections and the epic-mode header. **Scope:** the shared Active/All
   `ActivityScopeToggle` sits on this section's heading row, right side (it scopes only this
   section; phone keeps it, 44px items). Which projects get a card does not change; the scope
   only hides or mutes them. A project is active iff a live CLI session drives it
   (`GET /api/active-scope`, the Sessions rule), not because of a time window. Under `?project=`
   the project is active when a live session drives it in any store (the view merges every
   store). Active shows only active cards plus one muted line under them, "N quiet projects ·
   Show all" (singular "1 quiet project"; "<project> is quiet · Show it" when one project is
   hidden; hidden at 0; the link is a 44px tap target on phone) that links to `?scope=all`. An
   active card's agents line counts the agents on epics a live session drives, the same number
   under All, and is hidden at 0 (never an unhelpful "0 agents working"); a quiet card keeps its
   working-agent count. Active edge lines replace the cards, each one muted line with "Show
   all": nothing live, "Nothing is active right now."; only unlinked sessions, "N live sessions,
   none on an epic" (only when no card is shown, Kanban's rule); a `?project=` with no live
   session, "No live session is on this project". Unmeasured (live sessions cannot be read here)
   draws every card, with "Live sessions can't be read here" under the heading and never a "none
   active" line. While the first scope answer is in flight under Active the section keeps its
   loading state. All lists every card, the quiet ones in `--bs-text-subtle`. "Just finished" is
   not scoped: a closed epic carries no project, and the scope lists only running epics. The
   Budget panel follows the cards on screen. It keeps its loading state while the first scope
   answer is in flight; when Active hides a card it drops the one-hour change sentence, and its
   empty line reads "No epic is running on an active project."
3. **"What the factory decided recently"** (renamed from "Recent dispatch decisions",
   audit Overview-5) — one line per dispatch: "Checker (DeepSeek, standard model):
   double-checking another model's review" style, from `/api/overview`'s
   `liveAgentEntries` + a friendly-role/tier lookup table (`ui/src/lib/roleLabels.ts`, new
   file, pure data, no API change).
4. **Budget** — "127M of 180M tokens" + a `ProgressRing` "71%" not "≥127113770 tok", "296 steps did not
   report their cost" not "296 not measured", "4 points lower than an hour ago" not "4pp"
   (audit item 4). The panel counts the epics "Running now" counts (the selected project's
   when a project is chosen) and nothing else, so its figures are the sum of the cards; with
   no epic running it reads "No epic is running." instead of a zero or an empty ring. The one
   outlier epic (factory-error-log, 107M tokens against a 1.185M budget) is flagged by name:
   "1 epic has a suspicious total: factory-error-log. Details." rather than silently
   dominating the percentage; the card's outlier line uses the same wording.

Data/API note: "Just finished" needs the `inFlightEpics()` staleness rule fixed
server-side (queries.ts:1078, audit item 2) — a pure data fix, not new fields, since
`closedEpics` is already returned and simply never rendered. `NeedsYouInbox` needs the new
`GET /api/inbox` read endpoint noted above (a merge of four existing queries, no schema
change).

### 4.2 Work — Kanban / Roadmap, one page with a two-way view switcher

The switcher is a segmented control, "Kanban / Roadmap". The former Epic page is not a
third view: it is folded into Roadmap's `EpicBlock` (below).

**Kanban view**: `KanbanBoard` of `TaskCard`s, five fixed rows (pattern 6, §2.4b), chips
shown only when they add information beyond what the column/grouping already states.
Example card, from live `/api/kanban` (`blocked` column,
`harness-codex-dispatch/task-a-skill-install-and-host-select`, `agentRole: "coder"`,
`agentModelTier: "mid"`, `agentActivity: "stalled"`, `tags: {case: "feature", origin:
"user", severity: "S2-major"}`):
- Row 1: muted short id "harness-codex-dispatch #a" + `AgentChip` reading "Coder ·
  waiting — a nudge may help" (the API's `agentActivity: "stalled"` is exactly the state
  this chip's "waiting" tone renders, per pattern 3), and at the right end a `&ldquo;`
  replaced by the Lucide `Quote` icon (`aria-label="Has a linked request"`, `Tooltip` = first line of the prompt) when the
  task links to an operator prompt — needs data, see §4.7.
- Row 2: humanized title clamped to 2 lines, e.g. "Add a codex skill-install CLI command"
  (derived from the ~200-word `title`/objective per plan item C — the humanizing rule
  itself is out of scope here, already covered there).
- Row 3: one-line summary (first sentence, or the planner-written `summary` field once
  it exists) — hidden entirely when the viewer's display options turn summaries off.
- Row 4: chips — a `Tag` for "Feature" (case) since it is not implied by column or
  grouping; a severity `Tag` "S2-major" since it is above the default; no status chip
  (the column is already "Blocked", so repeating it fails the "adds information" test);
  no project chip when the board is grouped by project; capped at 2 tags then "+N".
- Row 5: "Coder" on the left (hidden when grouped by role); on the right, "Attempt 2" if
  a `judgeRound`/`attemptCount` is present, else "updated 6 d ago" from `updatedAt`.

Dependency chain in words ("Waits for: nothing" or "Waits for: <title> (done), because it
edits the same files"), comment/finding count, "Open PR #N" if `prUrl` present, screenshot
icon + count when artifacts exist (plan item C) render below row 5 as the card's footer,
not counted among the five fixed rows (they are supplementary detail, not identity/state).

**Grouping** (pattern 7, §2.4b): a group-by switch — Status (default), Project, Epic,
Role — each with a "None" column for tasks lacking that property. `KanbanBoard`'s column
header: status/group icon, name, a count pill, and a column menu with "Hide column";
a "Hidden columns" control (in `KanbanDisplayOptions`, below) lists and restores any
hidden column so hiding is never a one-way trip. Empty column: one plain sentence, e.g.
"No tasks in Blocked." "Completed" stays collapsed by default within its column
regardless of grouping (audit Kanban-5). Epic-group column labels use friendly names:
"shop-api: UX pass 1 (finished)" style, open epics sorted first (audit Kanban-4) — needs a new
`title`/status-derived field, server-side. Columns with more than
`KANBAN_VIRTUALIZE_THRESHOLD` cards (a named constant, default 30, `ui/src/lib/
constants.ts` — never a bare "30" at the call site) render virtualised.

**Display options** (pattern 8, §2.4b): a `KanbanDisplayOptions` popover — one-line
summary on/off, group-by, hidden columns. Persisted to `localStorage` per viewer, write
and read both wrapped in `try`/`catch`; on any storage failure (quota, private mode,
disabled), fall back silently to the hardcoded default (summary on, grouped by status,
nothing hidden) rather than erroring the board.

**Keyboard** (pattern 9, §2.4b): arrow keys move focus between cards (within a column
with Up/Down, across columns with Left/Right); Space or Enter on a focused `TaskCard`
opens `TaskPeekPanel` (pattern 4, deviation §2.4): title, `AgentChip`, status tag,
one-line summary, and an "Open full page" link to Task detail; Escape closes it and
returns focus to the triggering card. The panel is a focus trap while open (reuses the
ported `Dialog` primitive's existing trap, §2.1); `Tab`/`Shift+Tab` cycle only inside it;
screen readers get `role="dialog"` `aria-modal="true"` and an `aria-label` naming the
task. No new data — `TaskPeekPanel` reads the same per-task payload the full page already
fetches, just rendered smaller. **Deliberately no drag-and-drop**: the factory's
scheduler is the only writer of task state, so no interaction on this board ever lets an
operator drag a card between columns or reorder one — right-click/long-press opens a
read-only context menu (Open full page, Open PR, Copy id) rather than a move affordance.

This same `TaskCard` and its keyboard model (peek + no drag) also apply inside Roadmap's
`EpicBlock`, below.

**Roadmap view** (URL `/work/roadmap`, selection in the query: `?phase=<milestoneId>` or
`?epic=<epicId>`): one section per project (`RoadmapSwimlane` each), `EpicBlock` after the section that holds the selection.

- **Swimlane.** Milestone/phase rows with their epics as indented sub-rows (a project
  without milestones falls back to epic-only lanes, per plan G). Months header, red
  now-line with a pulsing dot (static fallback: solid line labelled "Now"). Past bars
  faded solid, current bar solid+animated, upcoming dashed and labelled "not scheduled"
  when no planned dates exist. The selected row gets `--bs-surface-selected` background plus
  a 2px inset `--bs-border-bold` rule and `aria-current="true"` (neutral, §1.9). Below 768px the swimlane scrolls
  horizontally inside its own container (`overflow-x: auto`, `tabindex="0"`, labelled
  region, lane `min-width` 520px); the page itself never scrolls sideways, and
  `EpicBlock` stacks below.
- **Project sections.** One section per project, ordered running first, then most recent
  activity, ties alphabetical; the heading is hidden when the project filter picks one
  project. The heading carries the done count ("3 of 25 phases done", "All 25 phases
  done"; never "0 of 0", so none when a project has no phase). A project with epics in
  flight but no declared phase gets an epic-only section; with no phase anywhere the
  page shows one "Epics" section. Lanes keep declared order.
- **Window.** Each section shows 1 earlier lane + the current lane + 2 later lanes. The
  current lane is the one holding a running epic, else the first declared lane not done
  (else the last); it carries a "Current" `Tag` and `aria-current="step"`, and selecting
  another lane never moves it. Hidden lanes sit behind "Show N earlier lane(s)" / "Show N
  later lane(s)" disclosures (`aria-expanded`, `aria-controls`; "Show fewer ..." when open),
  rendered only when a side hides something. The open/closed state is kept per tab session
  (`sessionStorage`), per project and side. A `?phase=`/`?epic=` deep link into a hidden
  lane opens that side once, scrolls the row into view and focuses it; "Show fewer" is
  then respected until the link changes. Disclosure buttons are at least 24px tall on
  desktop, 44px on phone.
- **Default selection.** With no query param, select the current lane of the top section
  (the same section list the page renders, project filter included): the phase containing
  the in-progress epic, else the first declared phase not done, else the last; in an
  epic-only section, the in-progress epic, else its first.
- **Phase selected** -> `EpicBlock` shows the phase header — example from `/api/roadmap`'s
  "Phase 6 — UI (HDS)" milestone, goal text from `goal`, "13 of 25 tasks done" from
  `tasksCompleted`/`tasksTotal`, stacked `ProgressBar` (needs a new breakdown field; only a
  done/total pair exists today), exit criteria if declared in `roadmap.md` — then one
  section per epic in `MilestoneProgress.epicIds`: name, status `Tag`, "N of M tasks
  done", and its `WaveList` behind a "Show waves" toggle. The in-progress epic's section is
  expanded; others are collapsed. An epic with zero tasks reads "No tasks tracked".
- **Epic selected** -> `EpicBlock` shows the epic header (title, project, status,
  progress), the "Epic started from" `RequestQuote` (needs data, §4.7), the plan-version
  picker ("Plan: latest (v12) / earlier drafts", audit Flow-2's friendlier wording), then
  `WaveList` — one row per wave, "Wave 12 of 18 · 6/8 done", `ProgressBar`, current wave
  expanded and emphasised, past waves collapsed by default, upcoming dashed. Dependency
  edges in words per plan H's exact mapping (artifact/claim-order/regression-test/
  spec-clause -> "uses its output" / "edits the same files" / "its test guards this" /
  "same spec clause"). sr-only comparison table kept, epic filter kept.
- Clicking a `TaskCard` anywhere in `EpicBlock` opens `TaskPeekPanel` first, same as
  Kanban (pattern 4).

Fixes the false empty state (audit item 7: shop-api has 10+ epics but showed "has not built a
project yet") by deriving the empty state from the real per-project epic count instead of
a hardcoded sentence. Epic rows and wave headers show "N of M tasks done" plus a
`ProgressBarMini` with the %; the current wave is neutral-selected, not blue. And it fixes phase "0/1 (0%)" on a milestone with zero tasks (audit item
6) by showing "No tasks tracked" instead of the `tasksTotal || 1` forced fraction.

**Old links.** The dashboard has no `/epic/:id` route today; the epic surface is
`/flow?epic=<id>` and the roadmap is `/roadmap`. Both redirect (router-level, preserving
the query): `/flow?epic=<id>` -> `/work/roadmap?epic=<id>`, `/flow` -> `/work/roadmap`,
`/roadmap` -> `/work/roadmap`.

Data/API note: the merge itself needs **no new data**. `MilestoneProgress` already carries
`epicIds`, `tasksTotal` and `tasksCompleted`; each epic's waves, dependency edges (the edge
`type` field in the flow payload) and plan versions come from the existing
`/api/flow?epic=&planVersion=` read, one call per expanded epic. Optionally the server may
return per-epic status/progress inside the phase payload to avoid N calls — that would be
a new read shape (needs data), not required. Still needing new data, unchanged from
before: the stacked done/review/in-progress/todo breakdown, and the epic source prompt
(§4.7).

A `TaskCard` selected inside any `WaveList` row opens the same `TaskPeekPanel` described
under Kanban above (pattern 4) — one panel implementation, two trigger surfaces (Kanban,
`EpicBlock`), no per-page variant.

### 4.3 Activity (Timeline + Errors merged, live, "problems only" filter)

Single feed of `TimelineRow`s, newest first (audit Timeline-3), grouped by day with
"Today" / "Yesterday" / "29 Sep" headers (pattern 5, deviation §2.4).

**Event kinds.** Every row carries one of 9 kinds, each a text tag + colour token, no icon
(operator: the colour tag is enough), token (`EventKindTag`, §2.2; tokens §1.1): Prompt, Dispatched, Returned, Finding, Gate,
Merge, Error, Feedback, and System for rare types. Colour is never the only signal. Gate
rows add "Passed" / "Failed" as a status `Tag` with a `CircleCheck`/`CircleX` icon. Prompt rows are
the one blue kind, and only on the tag: an `EventKindTag` in the `--bs-event-prompt-subtle` tint. The row
itself sits on neutral `--bs-surface-sunken` (§1.9) and shows the operator's words verbatim (the one
language exception, see intro), long prompts clamped to 2 lines with "Show more" (audit
Timeline-5).

**Causality.** A Dispatched row names role, task (linked) and the dispatch `reason` in
plain words (`dispatches.reason`, already on `RecentDispatch.reason`), plus "because of
your prompt at 10:05", a link that scrolls to and focuses that Prompt row. Hovering or
focusing a Prompt row gives it the grey `--bs-surface-selected` background and a 4px stripe
(`source`), and gives every row it caused the same background (`caused`); the Prompt row's
meta line reads "Caused N dispatches shown here".

**Meta line and details** (`TimelineRow`, shared by Activity, Home and task history).
Collapsed (default): line 1 is the kind tag and the title; line 2 is the muted meta line —
at most 4 items joined by " · ", most useful first. On desktop the time stays in the time
column; on phone the time is the last meta item. The role is dropped from the meta line
when the title already names it. Expanded (chevron): a two-column `dl` (label
`--bs-text-subtle`, value `--bs-text`, 12px desktop / 13px phone). **Only fields that exist
are rendered — never an empty label, never "—".** A kind with no useful stats (System:
"Session … started") has no meta line and no chevron.

| Kind | Meta line (≤4, in order) | Expanded body (only if present) | Source |
|---|---|---|---|
| Dispatched | round · tokens · duration · "because of your prompt at HH:MM"; while running: round · "Running for 12 s" (ticks live) · because-of | Reason · Task (link →) · Model · Effort · Tokens in / out · Result | round, reason, role, model tier: `RecentDispatch` (queries.ts:845, api.ts:126). Tokens, duration, result: **new** — join to the run's `task_run_result` via `agents.terminalEventId` (schema.ts:130). Effort: **new**, not recorded anywhere; hidden until it is. |
| Returned | tokens · duration · result | Task · Model · Tokens in / out · Duration · Result | `task_run_result` / `task-result-recorded` payload: `token_usage`, `duration_ms`, `run_status` (existing; `{measured:false}` → the item is left out) |
| Finding (judge verdict) | role · round · verdict | Verdict · Criteria (passed / partial / failed) · Findings · Task · Model | `judge-reported`: `agent_role`, `round`, `overall`, `criteria_*`, `finding_count` (existing) |
| Gate | check name · "3 of 212 failed" / "212 of 212 passed" · round | Checks · Failed tests · Reason · Task | `gate-outcome`: `outcome`, `round`, `failed_criteria`, `reason` (existing); pass/fail counts from `testgate-result.results` — **new**: normalised counts |
| Merge | branch or task · files changed | Branch → integration branch · Commit · Changes (files · lines) · Tasks | `wave-merged`: `task_branch`, `integration_branch`, `merge_commit`, `files_changed`, `diff_lines_changed`, `task_ids` (existing) |
| Prompt | "You" · "Caused N dispatches" (Home desktop, where the title is the prompt) | full prompt (Home only; Activity already quotes it) · Caused (links) · Session | `user_prompt.prompt` (existing); caused count from the `causal_parent` walk (`nearestPromptId`, below) |
| Error | error kind · severity · "retried" | Kind · Severity · Detail · Agent · attempt · What happened next · Task | `error-logged`: `class`, `severity`, `agent_role`, `attempt` (existing); "what happened next" = the next event on the same causal chain (existing walk) |
| Feedback | "Waiver" / decision · subject | Decision · Note · Findings | `waiver-granted` / `waiver-denied`: `fingerprint`, `operator_note` (existing) |
| System | — (no meta, no chevron) | — | — |
| Group ("Builder ×4 in wave 3") | round · total tokens · longest duration | its member rows, each a collapsed `TimelineRow` with its own chevron | **new**: grouping rule (same role + same wave + same minute), client-side |

**Controls.** The chevron is an `IconButton` (`ChevronDown`, rotated −90° when collapsed,
`--bs-duration-fast`, no rotation under reduced motion) at the row's end, with
`aria-expanded`, `aria-controls` → the body's id, `aria-label` and tooltip "Show details" /
"Hide details" (the label and tooltip text always match). Enter and Space toggle it (it is a
native button). The row itself is not the toggle, so the task link and the "because of"
link keep working. Rows are collapsed by default; open/closed state is remembered per page
session only (`sessionStorage`, keyed by event id, gone when the tab closes; wrapped in
try/catch, so a blocked store just means everything starts collapsed). One "Expand all /
Collapse all" icon toggle (`ChevronsUpDown` / `ChevronsDownUp`, label and tooltip swap) sits
in the Activity toolbar, **desktop only** (hidden ≤640px) and **not on Home**. Rules 3/8/9
hold: no leading icon, a muted meta line, one bold element per row (the title). Phone: the
chevron is a 44px target in its own column; the body expands inline under the row, and links
inside it are 44px tall.

**Live.** Reuse `usePoll` unchanged: it refetches on the `/api/stream` SSE advance signal,
on the global refresh, and on a 15 000 ms interval fallback that runs only while the
stream is closed; it stops while the tab is hidden and fires once on return. No websocket,
no new dependency. The feed header shows a `LiveIndicator`-style "Live · updated 8 s ago".
New rows are prepended with the `new` highlight (§1.8; under reduced motion they appear
with no slide or flash — the "just now" time and the pill still mark them). **Pause on
scroll**: when the viewer has scrolled away from the top, new rows are buffered instead of
shifting the content being read, and a pill button "N new events" appears at the top of
the feed; activating it inserts them and scrolls to the top. The feed is `role="feed"`
with `aria-busy` during fetches; new-row arrival is announced politely through the
existing live region, at most once per poll.

**Filters.** Kind chips — Prompts / Dispatches / Reviews (Finding + Returned-from-judge) /
Gates / Errors — plus a task filter and an epic filter, all mirrored in the URL
(`/activity?kind=prompts,dispatches&epic=shop-ux-1&task=…`) so a link reproduces the view.
"Errors" is the old "Problems only" toggle: it narrows to error-class rows and surfaces the
class-summary cards above the list — example from `/api/errors`: "Ran out of context
window, 109 times, mostly minor" instead of three severity-split rows for the same class
(audit item 9, Errors-2). Each chart (errors-over-time, by-group) carries a one-sentence
takeaway above it, e.g. "Spike of 40 errors on 29 Sep, mostly context overruns during
shop-ux-1" (audit item 10), computed client-side.

**Paging.** Loads one page at a time, `GET /api/timeline?before=<cursor>&limit=50`
(cursor = the oldest event id already loaded), replacing today's single unpaginated
response (7,474 events in one call live, audit item Timeline-4). A "Load older" button sits
at the list's end; an `IntersectionObserver` sentinel auto-triggers the same fetch, and
the button stays as the keyboard/accessible primary control.

Data/API note — **needs new data** (all read-side; no new event type, no new writer):
- `/api/timeline` (app.ts:774 -> queries.ts `timeline()`, `TimelineFilter` at :1540) has
  today only `taskId`, `epicId`, `eventTypes`, `causalChainFor`, `decisionsOnly` — no
  cursor and no limit. It gains `after=<eventId>` (incremental polling: each poll fetches
  only rows newer than the newest one held), `before=<eventId>` and `limit=` (paging, and
  `limit=8` for Home's compact block).
- Each row gains `nearestPromptId`: the nearest `user_prompt` reached by walking
  `causal_parent` upward — the same walk as `RequestQuote` (§4.7).
- For the meta line and details (table above): each Dispatched row gains its run result,
  joined server-side through `agents.terminalEventId` → the `task_run_result` event
  (`token_usage` in/out, `duration_ms`, `run_status`), plus `dispatchedAt` so a running row
  can tick "Running for N s" on the client. Gate rows gain normalised pass/fail counts from
  `testgate-result.results`. Effort is not recorded anywhere today: it stays hidden until a
  writer exists (out of scope here). Group rows are formed client-side.
- Optional: a server-side `kind` per row; otherwise `ui/src/lib/eventKinds.ts` maps event
  type -> kind client-side.
- Last-seen/project/trend fields on the merged error-class rows (audit Errors-5).
Everything else is a client reshape of `/api/timeline` + `/api/errors`.

### 4.4 Cost & quality (Analytics, cut to ~4 metrics, plus a token-trend section)

This page shows token cost, never dollar cost: `cost_usd` is parsed off a run's raw
harness output and explicitly not yet surfaced past that point (`runner.ts:99`, `:212`),
so no projector or writer exists to put a dollar figure here — every value on this page
is a token count, and the page copy never implies otherwise.

`PeriodSwitch` (pattern 10, §2.4c) — 7 / 30 / 90 days, default 30 — sits at the top and
governs the two charts below it: a stacked `BarChart` of daily tokens (stack by role or a
second `PeriodSwitch`-adjacent toggle for model tier) for the selected period, and a
horizontal `BarChart` of total tokens per role/model tier for the same period. Below both,
a breakdown `Table` (compact): one row per role/model-tier pair, columns run count,
tokens, average tokens/run — mirroring `costByModelTierAndProvider`'s existing shape but
now scoped to the selected period. Every one of these three — the two charts and the
table — renders an unmeasured run as its own "not measured" segment/row, counted, never
dropped and never folded into a zero-token bar (verified: `analytics()`'s
`unmeasuredTaskCount` already exists per bucket, `queries.ts:2195` region — the period/
per-day/per-role read paths are new, the not-measured bookkeeping pattern is not).

Below the trend section, the four existing `StatCard`/`MetricGrid` cells stay, each with a
one-line takeaway underneath:
1. "Tokens per task" — "~750K tokens per task" (from `avgTokensPerTask`, `CompactNumber`),
   takeaway: "The strongest model costs about 27x the standard one per task" (from
   `costByModelTierAndProvider`'s frontier vs mid ratio, computed client-side).
2. "How often a lesson already learned was broken again" (same-mistake rate) — value or
   "Not enough data yet (needs N settled rechecks)" instead of a bare em dash (audit item
   12).
3. "How often a re-checked fix held" (recheck pass rate) — same not-enough-data rule.
4. "Second-opinion reviewers" (was "Cross-check quorum") — "agreed with the main reviewer
   37% of the time", shown as a `ProgressRing` "37%" beside the sentence, with an `Info`
   icon button whose tooltip defines the metric; from the existing `agree %`/`ms` values, msconverted to seconds
   ("27 s average").

"Cost per task by provider" is hidden outright when fewer than 2 providers have data (per
operator decision, plan-ui-friendly.md's decisions list) — confirmed from
`/api/analytics`'s `costByModelTierAndProvider`, which today has one dominant provider
(`claude`) and several zero-token stub rows (`codex`, `deepseek`, `anthropic` at 0
tokens) that would trigger the >=2-provider check falsely without also requiring
`totalTokens > 0` per provider — spec this exactly: "providers with `totalTokens > 0`"
is the count that gates the block, not raw row presence.

Data/API note: `/api/analytics` gains a `period` query param (`7d`/`30d`/`90d`), a
per-day token series keyed by role or model tier, and a per-role/model-tier breakdown for
the selected period — three new read paths over `task-result-recorded` rows the
projection already stores (verified today's response has none of the three: confirmed
live shape is `throughput`/`costByModelTierAndProvider`/`sameMistakeRateByDay`/
`recheckOutcomes`/`providerAgreement` only, no `period` param accepted). No new event
type or writer.

### 4.5 Lessons

`LessonCard` list, tabs "Pending review (0) / Approved / Closed (28) / All" — all four
tabs show a count including "Approved" (audit Lessons-1, needs the count field added to
that tab specifically). Empty state on Pending: "Nothing to review. The factory proposes
new lessons after it reviews its recent mistakes (runs automatically). Last checked
<relative time>." (audit item Lessons-2) — "last checked" is a new field. Card body:
"Applies to all projects - learned from csb-audit-1 on 7 Sep - hasn't prevented a repeat
yet" replacing the raw `rule`/`principle`/`provenanceEventIds` JSON dump.

### 4.6 Sessions (history list, reachable from Home/Activity, not in the nav)

Live CLI sessions are shown on Home (§4.1 item 1a), not on this page.

`SessionRow` list scoped by the shared Active/All toggle (`?scope=`, Active by default and
never written to the URL) beside Refresh. Active lists the sessions a live CLI session is
writing into (`GET /api/active-scope`'s `factorySessions`), not sessions with a working
agent: a session with no working agent but a live CLI session is active, one with working
agents and no live CLI session is quiet. Under the list, one muted line, the link a default
`--bs-link-text` link (no underline at rest, underline on hover/focus): "N quiet sessions ·
Show all" (hidden at 0); with no live CLI session at all, "Nothing is active right now. ·
Show all"; with live sessions but none on an epic, "N live sessions, none on an epic · Show
all" (while either of these two lines shows, the quiet count is not shown, so the line
carries the page's one Show all); when the live sessions cannot be read, Active lists everything unmuted, as All does,
with "Live sessions can't be read here" (the toggle stays); and, beside the list, "N active
projects are in another store (names) · see Home" for active projects the page cannot list.
Until the first answer arrives the page shows its loading skeleton, never an empty claim.
All adds the quiet sessions, muted by title colour only, after the active ones. A
selected session that turns quiet while Active stays listed (muted, not counted in the quiet
line) until another row is selected or the scope changes; narrowing All to Active with a
quiet session open clears the selection and `?session=`. Browser back/forward restores the
selection from `?session=`. Each row is humanized (derived title, humanized last-event,
humanized task slug, audit Sessions-3). Selecting a row opens the per-role agent view: one `AgentBlock`
per role (e.g. "Testers" block listing its 16 live agents from `/api/overview`'s
`liveAgents` breakdown, each with task title, duration via `RelativeTime`, in/out tokens
via `CompactNumber` or "not measured"). No canvas, no zoom controls, ever (audit
Sessions-1) — this is a hard rule, not a "hide below N nodes" threshold, since the
one-node-canvas-with-zoom-controls problem is the canvas existing at all.

Data/API note: the per-session agents endpoint is new (plan F) — it does not exist in
today's `/api/sessions` response (confirmed by curl: no per-agent token breakdown in that
payload today, only session-level `eventCount`/`liveAgentCount`).

### 4.7 Task detail page

H1: humanized title, e.g. "Watch this clone by default" — never the ~400-word objective
(audit item 3; confirmed from `/api/tasks/phase-10%2Ftask-1-watch-this-clone-by-default`,
whose `objective` field is a full paragraph). An `AgentChip` (pattern 3, deviation §2.4)
sits beside the H1 whenever a live agent is dispatched — same role+state chip as
`TaskCard`, including the "waiting" state and its shared threshold constant, so a task
reads the same whether seen on Kanban or on its own page. The branch name
(`smith/phase-10/task-1-watch-this-clone-by-default`) moves into a "Technical details"
disclosure, not shown beside the status tag as a false subtitle (audit item 2). Tabs:
"What was asked" (was "Spec contract"), "Findings", "Outputs" (was "Artifacts" — screenshots,
reports), "History". Facts row: "Type: bug fix - Plan revision 2" (from `caseTag`,
`planVersion` — confirmed present in the curled payload). "Requested by: you" is dropped
from it: the `RequestQuote` below says it with evidence.

**"Requested by you"** (`RequestQuote`, §2.2) sits directly under the facts row: the
operator prompt that led to this task, verbatim, with its timestamp ("29 Sep, 14:02"), a
3-line clamp with "Show more", and "View in timeline" (Activity filtered to the task,
scrolled to the prompt). When that prompt is a generic nudge (e.g. "continue"), an
"Epic started from" `origin` quote follows with the epic's source prompt. When no prompt
links, the block still renders with "No request recorded for this task" (today about 19
of 287 tasks).

Data note — **needs new data** (a read path only; no new event type, no new writer). The
prompts are stored verbatim already (`prompts` table, 211 rows), but no read path returns
them, and `dispatches.parent_prompt_id` is never populated (0 rows), so it cannot be used.
The link is a recursive walk up `causal_parent` from the task's events to the nearest
`user_prompt`; today that links 268 of 287 task ids. An epic's source prompt is the
earliest `user_prompt` in the epic's session lineage. One new query in `queries.ts`
serves three payloads: `/api/tasks/:taskId` (full prompt + timestamp + event id, plus the
epic source prompt), the epic/roadmap payload (epic source prompt), and `/api/kanban` rows
(a has-request flag + first line, for the card's quote icon).
"Files this task may change" (was "Claims") lists the `claims` array
(`factory/orchestrator/src/projects.ts`, etc. — confirmed 9 real paths in the sample).
"No retries - passed first time" when `attempts` is empty, an actual count otherwise
(audit item 6).

Above `RunHistoryTimeline`, a small total bar (pattern 11, §2.4c) sums the task's runs to
date in three cells — tokens (`CompactNumber`), agent-time, elapsed (both as durations) —
each "not measured" when the underlying runs carry no usable field, never a bare 0. Each
cell label carries its meta icon (`Coins`, `Timer`, `Clock`); the compact values have the
exact figure / time range in a tooltip (§2.5).

The "History" tab's top section is `RunHistoryTimeline` (pattern 2, deviation §2.4): one
entry per dispatch attempt, judge round, or result, each a `TimelineRow` in the `rail` variant — "Attempt 2:
Coder dispatched", "Judge round 1: reviewer approved", "Result: merged" — rail dot and tag,
no leading icon (geometry §1.5) — with a
`RelativeTime`, an outcome `Tag`, the meta line (pattern 11: round · `CompactNumber` tokens ·
duration, per the §4.3 table) and the same chevron and expanded body as Activity, "not measured" when the run's event carries neither,
replacing today's need to hand-filter the raw event log by task id to reconstruct this.
Source: a new read query, `GET /api/tasks/:taskId/runs`, filtering the existing
event-log projection by `taskId` for dispatch/judge-round/result event kinds already
written today, now also reading each event's `token_usage`/timing fields where present —
no new event type, no new writer, purely a scoped read on data already there. Below the
timeline, a per-agent summary `Table` (compact): one row per role that touched the task —
role, run count, tokens, time, same "not measured" fallback per cell — then the existing
event-level detail (previously the whole tab) still renders below that, now as
supporting detail rather than the tab's only content.

### 4.8 Epic page

No longer a page: merged into Work -> Roadmap (§4.2). Selecting an epic row (or opening
`/work/roadmap?epic=<id>`, or an old `/flow?epic=<id>` link) shows the epic in `EpicBlock`:
header facts (project, status tag, "13 of 25 tasks done" stacked progress, epic id in
"Details"), "Epic started from", plan picker, then `WaveList`.

---

## 5. Build order (small, independently mergeable PRs, gates green on every one)

**DS0 — tokens + primitives behind the old kit.** Add `ui/src/styles/bs-tokens.css`
(§1) and `ui/src/styles/bs-primitives.css`, plus `ui/src/components/kit/*` (all of §2.1's
ported primitives, re-styled), adding `lucide-vue-next` and `@floating-ui/dom` for `Icon`
and `Tooltip` (§2.5). Update `check_tokens.py`, `lint_hardcodes.py`,
`contrast_check.mjs` per §0 (they now scan BOTH the old and new file/token sets in this
one PR, since old pages still import the old kit at this point — the gate scripts already
have no problem with two token files coexisting, `check_tokens.py`'s `TOKEN_FILES` is a
tuple, list both `ds-tokens.css`/`ds-components.css` and `bs-tokens.css`/
`bs-primitives.css` here, then drop the `ds-*` pair in DS9). No page imports the new kit
yet — this PR is additive and inert. Pure UI/tooling, no data/API change.

**DS1 — App shell.** `SidebarNav` (5 items, new routes point at existing pages for now),
topbar (`LiveIndicator`, `ProjectSwitcher`, `Breadcrumb`), loading/empty/error pattern
(§3) wired at the `App.vue` / router level. Old pages still render inside the new shell
unchanged. Pure UI; the "1 live indicator" merge needs no new field (both old signals are
already in `/api/pulse` and `/api/overview`).

**DS2 — Home.** Merge Overview + Projects (§4.1), **plus pattern 1, `NeedsYouInbox`**
shown first. Needs the `inFlightEpics()` staleness fix (queries.ts:1078, a data/query
change, not a new field), the friendly role/tier label table (pure client data,
`ui/src/lib/roleLabels.ts`), and the new merged read endpoint `GET /api/inbox` (four
existing queries — waivers/escalations/stop-points/lesson-candidates — behind one
response shape, no new event type or writer), with a `description` line per row (needs
data where the query does not already join the source text, §4.1). Also the compact
"Recent activity" block (8 `TimelineRow`s, `compact`), which lands with DS6's
`EventKindTag`/`limit` — ship DS2 without it if DS6 has not merged, and add it in DS6.

**DS3 — Work: Kanban + Task detail.** `TaskCard`, `KanbanBoard` on the new kit, **plus
pattern 3 (`AgentChip` incl. the "waiting" state and its policy/constant threshold),
pattern 4 (`TaskPeekPanel`, opened from Kanban), and the second fold (§2.4b): pattern 6
(fixed five-row `TaskCard`, information-only chips), pattern 7 (switchable group-by —
status/project/epic/role, hidden-columns control, `KANBAN_VIRTUALIZE_THRESHOLD`),
pattern 8 (`KanbanDisplayOptions`, `localStorage`-backed, try/catch-guarded), and pattern
9 (arrow-key card navigation, Space/Enter/Escape on `TaskPeekPanel`, explicitly no
drag-and-drop)**; also lands the Task-detail page rebuild (§4.7), since it shares
`AgentChip` and gets **pattern 2 (`RunHistoryTimeline`)** in the same PR to avoid a page
that half-uses the new agent-state vocabulary. Needs the humanized-slug helper, the
optional `title`/`summary` task-spec fields (plan item C — schema + planner-template +
projector change), the epic-select friendly-label field (new field, audit Kanban-4), the
`agentWaitingThresholdMs` constant/policy key, the `KANBAN_VIRTUALIZE_THRESHOLD` constant,
and the new read endpoint `GET /api/tasks/:taskId/runs` (scoped read on the existing
event-log projection, no new event type or writer). **Card fields `/api/kanban` does not
return today** (verified live 2026-09-30: a task row carries only `taskId`, `taskStatus`,
`title`, `agentRole`, `agentModelTier`, `agentActivity`, `milestoneId`, `tags`): `updatedAt`,
`attemptCount`, `judgeRound`, `commentCount`, `prUrl`, `dependencies`, and a project key for
the cross-project board. DS3 adds them to the `/api/kanban` row read (projected columns
only, no writer); any the projection does not hold yet render as absent — the row-5 meta
falls back to nothing, never to a made-up "0". Epic grouping derives from the `taskId`
prefix; role grouping uses `agentRole`. The group-by/hidden-columns/display options
themselves are pure client state (`localStorage`), no server change. **Also `RequestQuote`**
on Task detail and `TaskPeekPanel` (incl. the "Epic started from" fallback and the empty
state) and the card's `Quote` icon — **needs new data**: the `causal_parent` walk to
the nearest `user_prompt` (§4.7) exposed on `/api/tasks/:taskId` and `/api/kanban` rows.

**DS4 — Work: Roadmap (incl. the former Epic view).** `RoadmapSwimlane` + `EpicBlock`
+ `WaveList`, the "Kanban / Roadmap" switcher, `?phase=`/`?epic=` selection in the URL,
default selection, the ≤640px epic list that replaces the swimlane (§3.1), and the `/roadmap` and `/flow?epic=`
redirects (§4.2). Drops the VueFlow roadmap canvas and `@vue-flow` from the Flow page
entirely (plans G and H); reuses `TaskPeekPanel` from DS3 on wave-row cards (pattern 4).
The merge itself adds no data need (existing `/api/roadmap` + `/api/flow`, and the
plain-words dependency-edge mapping is a client-side lookup on the existing edge `type`).
**Needs new data**: the real per-project epic count for the empty-state fix (audit item
7, likely already in `/api/roadmap`'s project grouping — confirm), the stacked
done/review/in-progress/todo breakdown (today only done/total), and the epic source
prompt for "Epic started from" (same read as DS3, on the epic/roadmap payload).

**DS5 — folded into DS4.** No separate PR; the number is kept so DS6-DS9 keep theirs.

**DS6 — Activity.** Merge Timeline + Errors, `TimelineRow` (meta line, chevron details, groups, "Expand all"; also swapped into Home and task history in this PR) + `EventKindTag` (9
kinds, `--bs-event-*` tokens added to `bs-tokens.css` and to `contrast_check.mjs`'s
pairs), day grouping, causality links and hover highlight, live updates through the
existing `usePoll` (new-row highlight, "Live · updated Ns ago", pause-on-scroll with the
"N new events" pill), URL-backed kind/task/epic filters, **plus pattern 5 (paginated load
with a "Load older" button and an infinite-scroll sentinel, replacing the unpaginated
7,474-event list)**, chart takeaways. **Needs new data**: `after=<eventId>`,
`before=` and `limit=` on `GET /api/timeline`, a per-row `nearestPromptId` (same
`causal_parent` walk as DS3), the dispatch→run-result join and normalised test counts (§4.3 table), optionally a server-side `kind`, and last-seen/project/trend
fields on the merged error-class rows (audit Errors-5) — all read-side, same tables, no
new event type or writer.

**DS7 — Cost & quality.** Cut Analytics to 4 metrics (§4.4), single-provider-block hiding
rule (client logic against existing `totalTokens > 0` per provider), "not enough data"
copy, **plus pattern 10 (§2.4c): `PeriodSwitch`, the daily token series and the per-role/tier
breakdown.** Not pure UI: `/api/analytics` gains a `period` param and three read paths (§4.4),
all over already-projected `task-result-recorded` rows, no new writer; unmeasured runs keep
counting via the existing `unmeasuredTaskCount`, never as 0.

**DS8 — Lessons + Sessions.** `LessonCard`, `AgentBlock`/`SessionRow`, drops the Sessions
VueFlow canvas, **plus pattern 13 (§2.4c): `AgentStatusBadge` on each `AgentBlock` row,
workload-axis only** (grounded in the existing `agentActivity`/`agentWaitingThresholdMs`
values `AgentChip` already reads, naming a too-long queue as an "anomaly" tone rather than
"busy") — **no presence axis**, since the projection carries no per-agent heartbeat or
online/offline signal today (verified: none in `agents-registry.ts` or the events it
writes); ship workload-only and file presence as a follow-up rather than inventing a
writer for it. Needs the new per-session agents endpoint (plan F) and a "last checked"
lessons-pass timestamp field (new field, audit Lessons-2).

**DS9 — Delete the old kit.** Remove `ui/src/components/ds/`, `ds-tokens.css`,
`ds-components.css`, the `@vue-flow/core` dependency from `package.json` (confirm no
remaining import first — Flow/Roadmap/Sessions were its only three consumers per this
session's grep). Drop the old-file entries from `check_tokens.py`'s `TOKEN_FILES` and
`lint_hardcodes.py`'s `EXCLUDE_FILES` (added back in DS0, removed here). Finish the
`ui/docs/DESIGN.md` rewrite (§0) and the `design-spec.md` superseded-pointer. Pure
deletion + docs; no data/API change.

Nine PRs in practice: DS5 is folded into DS4. Each PR above must leave `bash scripts/check.sh` green, including the four design gates,
before merge — DS0's dual-registration of both token files is exactly what makes that
possible for DS1 through DS8 without a big-bang cutover.
