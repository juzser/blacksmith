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
