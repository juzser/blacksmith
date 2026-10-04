// Date display default: DD/MM/YYYY (design-spec.md §9), pending explicit
// operator confirmation of UI language/date-format per §7 — recorded as a
// default, not asserted as final, in ui/docs/DESIGN.md.
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * "30 Sep 2026, 14:07:12" — the absolute-time text kit/RelativeTime.vue's
 * Tooltip shows (ds-spec.md §2.1's own literal example). Distinct from
 * formatDateTime() above (design-spec.md §9's "DD/MM/YYYY HH:MM", numeric
 * month, no seconds) — that shape stays put for the pages that already
 * render it; this one exists only for the new kit's RelativeTime tooltip,
 * whose spec'd example needs a month name, a comma, and seconds none of the
 * existing formatters produce.
 */
export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getDate();
  const month = SHORT_MONTHS[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day} ${month} ${d.getFullYear()}, ${hh}:${mi}:${ss}`;
}

/**
 * "12 Sep, 09:14" — RequestQuote.vue's timestamp (ds-review.html ~1239,
 * ~1300: short month name, 24h time, no year). Scoped to RequestQuote only
 * (DS4 S5c fix round 1, fix 4) — formatDateTime() above stays put for the
 * pages that already render its numeric-month shape.
 */
export function formatShortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getDate();
  const month = SHORT_MONTHS[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month}, ${hh}:${mi}`;
}

/**
 * "7 Sep" — LessonCard's "learned from <session> on <date>" (ds-review.html
 * ~1510: day + short month, no year, no leading zero). Scoped to LessonCard
 * only; formatDate() above stays put for the pages that already render its
 * DD/MM/YYYY shape.
 */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getDate();
  const month = SHORT_MONTHS[d.getMonth()];
  return `${day} ${month}`;
}

/**
 * `[how many of this unit make the next one, the suffix it renders as]`.
 *
 * The suffix is spelled out rather than taken from a unit word's first
 * letter: "minute" and "month" share theirs, so a row last touched three
 * months ago rendered "3m ago" -- the same string three minutes ago gets.
 *
 * 4.3452 weeks per month is 365/7/12, which puts twelve months at exactly a
 * year. The rounder 4.348 put them a fraction over, so a gap of precisely one
 * year fell short of the year bucket and came out as "11 months" -- the
 * largest month value the table can count to.
 */
const RELATIVE_UNITS: Array<[number, string]> = [
  [60, 's'],
  [60, 'm'],
  [24, 'h'],
  [7, 'd'],
  [4.3452, 'w'],
  [12, 'mo'],
  [Number.POSITIVE_INFINITY, 'y'],
];

/**
 * "3m ago" / "2h ago" / "5d ago" — compact relative timestamp for
 * Roadmap's mini-timeline (operator directive 4) and Timeline rows.
 * `nowIso` is injectable for deterministic tests; defaults to `Date.now()`.
 */
export function formatRelative(iso: string, nowIso?: string): string {
  const then = new Date(iso).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  if (Number.isNaN(then)) return iso;
  let diff = Math.max(0, (now - then) / 1000);
  if (diff < 5) return 'just now';
  for (const [size, suffix] of RELATIVE_UNITS) {
    if (diff < size) {
      const n = Math.floor(diff);
      return `${n}${suffix} ago`;
    }
    diff /= size;
  }
  return iso;
}

const RELATIVE_VERBOSE_UNITS: Array<[number, string]> = [
  [60, 's'],
  [60, 'min'],
  [24, 'h'],
  [7, 'd'],
  [4.3452, 'w'],
  [12, 'mo'],
  [Number.POSITIVE_INFINITY, 'y'],
];

/**
 * "5 min ago" / "2 h ago" / "3 d ago" — kit/RelativeTime.vue's visible text
 * (ds-spec.md §2.1's own literal examples; ds-review.html's rendered
 * .tip-trigger text matches exactly, e.g. "5 min ago", "2 h ago", "8 s ago").
 * Same tiering as formatRelative() above (same thresholds, same "just now"
 * <5s floor) but a different text shape: a space before "ago", and "min"
 * spelled out rather than the bare "m" formatRelative() already ships to
 * Roadmap's mini-timeline and Timeline rows. Kept as a second function
 * rather than changing formatRelative() itself: that function's callers are
 * outside DS0's scope (§5) and its own tests above pin the current "5m ago"
 * shape against pages already live — changing it would be a breaking,
 * out-of-scope behaviour change to already-shipped surfaces, not an
 * additive one.
 */
export function formatRelativeVerbose(iso: string, nowIso?: string): string {
  const then = new Date(iso).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  if (Number.isNaN(then)) return iso;
  let diff = Math.max(0, (now - then) / 1000);
  if (diff < 5) return 'just now';
  for (const [size, suffix] of RELATIVE_VERBOSE_UNITS) {
    if (diff < size) {
      const n = Math.floor(diff);
      return `${n} ${suffix} ago`;
    }
    diff /= size;
  }
  return iso;
}

/**
 * "Live" / "Live · last activity 5 min ago" / "Paused · last activity
 * 5 min ago" — the same derivation kit/LiveIndicator.vue's own template composes
 * inline (statusLabel + a conditional RelativeTime), factored out because
 * kit/MobileTopBar.vue's liveness dot (ds-spec.md §3.1) needs the identical
 * text as a plain string for its `aria-label`, not a live-ticking DOM node.
 */
export function formatLiveStatus(
  live: boolean,
  lastEventAt: string | null,
  nowIso?: string,
): string {
  const label = live ? 'Live' : 'Paused';
  if (!lastEventAt) return label;
  return `${label} · last activity ${formatRelativeVerbose(lastEventAt, nowIso)}`;
}

/**
 * One-line label for a long free-text field.
 *
 * `/api/flow` nodes carry `title = tasks.objective` (db/queries.ts:1406), and
 * an objective is a paragraph, not a label: on envkit-mcp-surface's plan-v3
 * the four live objectives measure 942–1472 characters. FlowPage rendered
 * that raw, so a single node grew to swallow the canvas. summarize() takes
 * the first sentence when one fits and otherwise hard-caps at a word
 * boundary; callers keep the untruncated text in a `title` attribute (and in
 * the sr-only table) so nothing is actually lost.
 *
 * A period only ends a sentence when whitespace or the string end follows it,
 * so `redact.ts` and `0.5` are not mistaken for boundaries.
 */
export function summarize(text: string, maxChars = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';

  const sentenceEnd = flat.search(/[.!?](\s|$)/);
  if (sentenceEnd !== -1 && sentenceEnd < maxChars) return flat.slice(0, sentenceEnd + 1);
  if (flat.length <= maxChars) return flat;

  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the word boundary if it does not throw away most of the
  // budget — a 90-char cap that lands mid-URL should still show ~90 chars.
  const body = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * "7s" / "3m" / "2h 13m" / "2d 4h" — how long something has been RUNNING, as
 * opposed to formatRelative()'s "…ago" for something that already happened.
 *
 * Operator directive (Phase 6b round 7): "mind the timestamps so they display
 * better". A live agent's `dispatchedAt` (api.ts LiveAgentEntry) was only
 * ever a native tooltip, so the one number that says "this one is stuck" —
 * how long it has been running — was invisible. Two units at most: the
 * seconds inside a 2-hour run are noise, and a ticking label has to stay
 * narrow enough not to reflow the row it sits in.
 *
 * A future timestamp clamps to "0s" rather than rendering a negative age:
 * server and browser clocks disagree by a second or two routinely, and
 * "-1s" would read as a bug in the dashboard rather than in the clocks.
 */
export function formatElapsed(fromIso: string, nowIso?: string): string {
  const then = new Date(fromIso).getTime();
  if (Number.isNaN(then)) return '';
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((now - then) / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** "1 task" / "2 tasks" — English-only, matches this app's single declared UI language (DESIGN.md). */
export function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * `[how many of this unit make the next one, the suffix it renders as]` —
 * same shape as RELATIVE_UNITS above, one tier per order of magnitude.
 *
 * The operator finds raw token integers (a 6-7 digit number is common past a
 * handful of tasks) too technical to read at a glance, so every place that
 * renders a bare count goes through this one formatter rather than each
 * call site rounding its own way. One decimal, and a trailing ".0" is
 * dropped ("5K", not "5.0K") so a round number does not read as more
 * precise than it is.
 */
const COMPACT_NUMBER_TIERS: Array<[number, string]> = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
];

export function formatCompactNumber(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? -1 : 1;
  for (const [index, [threshold, suffix]] of COMPACT_NUMBER_TIERS.entries()) {
    if (abs < threshold) continue;

    let roundedAbs = Math.round((abs / threshold) * 10) / 10;
    let effectiveSuffix = suffix;
    // Rounding can carry a value up to the next tier's floor (999950 rounds
    // to "1000K"); when it does, and a next tier up exists, re-derive the
    // rounded magnitude against that tier instead. B has no tier above it,
    // so "1000B" stands.
    const nextTier = COMPACT_NUMBER_TIERS[index - 1];
    if (roundedAbs >= 1000 && nextTier) {
      const [nextThreshold, nextSuffix] = nextTier;
      roundedAbs = Math.round((abs / nextThreshold) * 10) / 10;
      effectiveSuffix = nextSuffix;
    }

    const value = sign * roundedAbs;
    const str = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${str}${effectiveSuffix}`;
  }
  return String(n);
}

/**
 * "1.2M tokens" / "127K" / "43" — kit/CompactNumber.vue (ds-spec.md §2.1:
 * `value`, `unit?: "tok"`). The prop's own value is the short enum literal
 * "tok" (matches the spec's type spelling), but the word it renders is
 * spelled out in full ("tokens") — a deliberate difference from
 * formatMeasuredTokens() below, a narrower, already-shipped budget-caption
 * formatter whose "tok" abbreviation stays put for its own call sites. The
 * unit, when given, is appended even to an unsuffixed small number (spec
 * example "43" has no unit shown because that example passes none).
 */
export function formatCompactValue(value: number, unit?: 'tok'): string {
  const n = formatCompactNumber(value);
  return unit === 'tok' ? `${n} tokens` : n;
}

/**
 * "2K tok" — or, when one or more of the summed results has
 * `token_usage: { measured: false }` (issue #220), a floor rather than an
 * exact total: "≥2K tok · 3 not measured". `tokensSpent` must already be
 * the sum over the results that DID report usage; this only decides how to
 * caption it. A sum of nothing but unmeasured results renders "not measured"
 * — never "0 tok", which would read as "we spent nothing" rather than
 * "nobody counted". The exact integer is not lost — callers keep it in a
 * `title` tooltip — this only decides the headline text.
 */
export function formatMeasuredTokens(tokensSpent: number, unmeasured: number): string {
  if (unmeasured === 0) return `${formatCompactNumber(tokensSpent)} tok`;
  if (tokensSpent === 0) return 'not measured';
  return `≥${formatCompactNumber(tokensSpent)} tok · ${unmeasured} not measured`;
}

/**
 * A label short enough to sit on one dashboard row without wrapping or
 * fighting a sibling column for space — roughly the width design-spec's
 * single-line Row/Card titles budget elsewhere (summarize()'s own
 * sentence-length cap, above, lands in the same range).
 */
const SHORT_TASK_LABEL_MAX = 60;

/**
 * "Readme merge trim" — a human label for a bare taskId, for the rows that
 * have nothing better (queries.ts's `tasks` table carries no `title`; where
 * one is available and short enough, it wins over the derived slug).
 *
 * taskId is `<epic>/task-<n>-<slug>` (or occasionally just the slug, with no
 * epic segment): this takes the last path segment, drops the leading
 * `task-<n>-` ordinal so "task-29-readme-merge-trim" reads as the work, not
 * its position in the plan, then turns the remaining dashes into spaces and
 * capitalizes the first letter. The raw id is not lost — callers keep it in
 * a `title` tooltip.
 */
/**
 * The last `/`-separated segment of a task id — `KanbanTaskCard.vue`'s own
 * `shortId` computed, pulled out here so `WaveTaskCard.vue` (DS4 S3 fix
 * round 1 finding 4) can show the same id without a second copy of the
 * one-liner.
 */
export function shortTaskId(taskId: string): string {
  return taskId.split('/').pop() ?? taskId;
}

export function taskLabel(taskId: string, title?: string): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle && trimmedTitle.length <= SHORT_TASK_LABEL_MAX) return trimmedTitle;

  const lastSegment = taskId.split('/').pop() ?? taskId;
  const slug = lastSegment.replace(/^task-\d+-/, '');
  const spaced = slug.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * "50%" — or, when one or more of `tokensSpent`'s results has
 * `token_usage: { measured: false }` (issue #220), "≥50%": the true usage can
 * only be higher, never lower, than a sum missing some of its addends. A
 * project with no budget set renders "-" (there is no percentage to compute);
 * one whose results are all unmeasured renders "not measured", not the
 * fabricated "0%" that `tokensSpent / tokensBudget` would otherwise produce.
 */
export function formatBudgetPct(
  tokensSpent: number,
  tokensBudget: number | null,
  unmeasured: number,
): string {
  if (!tokensBudget) return '-';
  if (tokensSpent === 0 && unmeasured > 0) return 'not measured';
  const pct = Math.round((tokensSpent / tokensBudget) * 100);
  return unmeasured > 0 ? `≥${pct}%` : `${pct}%`;
}
