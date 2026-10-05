// DS6 PR4c (ds-spec.md section 4.3): the Errors-kind view's class cards, one
// per `ErrorClassSummary` row from `fetchErrors`. Pure view-model shaping so
// the sentence and the severity-mix ordering are unit-tested without
// mounting the page.
import type { ErrorClassSummary } from './api.js';

export interface ErrorClassCardView {
  id: string;
  headline: string;
  severityMix: { severity: string; label: string; count: number; pillLabel: string }[];
  lastSeen: string;
  trend7d: number[];
  trendCaption: string;
}

/** "S3-minor" -> "minor", "S1-stop-the-line" -> "stop the line". */
export function severityShortLabel(severity: string): string {
  return severity.replace(/^S\d-/, '').split('-').join(' ');
}

/** "context-overrun" -> "Context overrun" (also used for error group ids). */
export function humanizeClass(kebab: string): string {
  if (!kebab) return kebab;
  const words = kebab.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Avoids the headline's count a second time: a single-severity class's
 * pill would just repeat it ("minor" next to "minor: 5" above), so show
 * only the label there; a multi-severity class still needs each count. */
export function severityPillLabel(label: string, count: number, severityCount: number): string {
  return severityCount === 1 ? label : `${label}: ${count}`;
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

/** One sentence naming the 7-day trend's direction, not its sum (the
 * headline and the pills already carry the count) — e.g. "Rising over the
 * last 7 days." A trend that is empty or all zero reads as unmeasured, not
 * a bare zero. */
export function trend7dCaption(trend7d: number[]): string {
  if (trend7d.length === 0 || sum(trend7d) === 0) return 'None in the last 7 days.';
  // Symmetric halves, dropping the middle point on an odd-length series, so
  // an equal-length comparison never reads as a direction by itself.
  const half = Math.floor(trend7d.length / 2);
  const firstHalf = sum(trend7d.slice(0, half));
  const secondHalf = sum(trend7d.slice(trend7d.length - half));
  if (firstHalf === secondHalf) return 'Steady over the last 7 days.';
  return secondHalf > firstHalf ? 'Rising over the last 7 days.' : 'Falling over the last 7 days.';
}

export function errorClassCardView(summary: ErrorClassSummary): ErrorClassCardView {
  const severityCount = Object.keys(summary.severityMix).length;
  const severityMix = Object.entries(summary.severityMix)
    .sort((a, b) => b[1] - a[1])
    .map(([severity, count]) => {
      const label = severityShortLabel(severity);
      return { severity, label, count, pillLabel: severityPillLabel(label, count, severityCount) };
    });
  const dominant = severityMix[0];
  const mostly = dominant ? `, mostly ${dominant.label}` : '';
  const headline = `${humanizeClass(summary.errorClass)}, ${summary.count} time${summary.count === 1 ? '' : 's'}${mostly}`;
  return {
    id: summary.id,
    headline,
    severityMix,
    lastSeen: summary.lastSeen,
    trend7d: summary.trend7d,
    trendCaption: trend7dCaption(summary.trend7d),
  };
}
