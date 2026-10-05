// DS6 PR4c (ds-spec.md §4.3): every chart on the Errors view of Activity
// carries a one-sentence, client-computed takeaway above it (audit item
// 10). These two cover the errors-over-time LineChart and the
// errors-by-group BarChart; both are pure so they can be unit-tested without
// mounting a component.

export interface DayCount {
  day: string;
  count: number;
}

export interface GroupCount {
  label: string;
  count: number;
}

/** A count that isn't a finite number is unmeasured, not zero (D-168-style) — excluded, never read as 0. */
function isMeasured(n: number): boolean {
  return Number.isFinite(n);
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

/**
 * One sentence for the errors-over-time chart: describes the trend across
 * the window (rising, falling, flat) and, when a dominant error group is
 * known, names it — e.g. "Errors fell by half this week, mostly context
 * window runs."
 */
export function errorsOverTimeTakeaway(days: DayCount[], dominantGroupLabel?: string): string {
  const measured = days.filter((d) => isMeasured(d.count));
  const total = sum(measured.map((d) => d.count));
  if (measured.length === 0 || total === 0) return 'No errors recorded in this window.';

  const suffix = dominantGroupLabel ? `, mostly ${dominantGroupLabel}` : '';

  if (measured.length === 1) {
    const only = measured[0] as DayCount;
    return `${only.count} error${only.count === 1 ? '' : 's'} on ${only.day}${suffix}.`;
  }

  const mid = Math.floor(measured.length / 2);
  const firstHalf = sum(measured.slice(0, mid).map((d) => d.count));
  const secondHalf = sum(measured.slice(mid).map((d) => d.count));
  if (firstHalf === secondHalf) return `Errors held steady this week${suffix}.`;

  const direction = secondHalf < firstHalf ? 'fell' : 'rose';
  const ratio = firstHalf === 0 ? null : Math.abs(secondHalf - firstHalf) / firstHalf;
  const amount =
    ratio !== null && Math.abs(ratio - 0.5) < 0.05
      ? 'by half'
      : ratio !== null
        ? `by about ${Math.round(ratio * 100)}%`
        : `to ${secondHalf}`;
  return `Errors ${direction} ${amount} this week${suffix}.`;
}

/**
 * One sentence for the errors-by-group chart: names the most common group
 * and its share of the total — e.g. "context window is the most common
 * error, 60% of the total."
 */
export function errorsByGroupTakeaway(groups: GroupCount[]): string {
  const measured = groups.filter((g) => isMeasured(g.count));
  const total = sum(measured.map((g) => g.count));
  if (measured.length === 0 || total === 0) return 'No errors recorded in this window.';

  const sorted = [...measured].sort((a, b) => b.count - a.count);
  const top = sorted[0] as GroupCount;
  if (sorted.length === 1) return `All errors are ${top.label}.`;

  const pct = Math.round((top.count / total) * 100);
  return `${top.label} is the most common error, ${pct}% of the total.`;
}
