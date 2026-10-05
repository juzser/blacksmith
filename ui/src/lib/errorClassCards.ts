// DS6 PR4c (ds-spec.md section 4.3): the Errors-kind view's class cards, one
// per `ErrorClassSummary` row from `fetchErrors`. Pure view-model shaping so
// the sentence and the severity-mix ordering are unit-tested without
// mounting the page.
import type { ErrorClassSummary } from './api.js';

export interface ErrorClassCardView {
  id: string;
  headline: string;
  severityMix: { severity: string; label: string; count: number }[];
  lastSeen: string;
  trend7d: number[];
}

/** "S3-minor" -> "minor", "S1-stop-the-line" -> "stop the line". */
export function severityShortLabel(severity: string): string {
  return severity.replace(/^S\d-/, '').split('-').join(' ');
}

function humanizeClass(kebab: string): string {
  if (!kebab) return kebab;
  const words = kebab.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function errorClassCardView(summary: ErrorClassSummary): ErrorClassCardView {
  const severityMix = Object.entries(summary.severityMix)
    .sort((a, b) => b[1] - a[1])
    .map(([severity, count]) => ({ severity, label: severityShortLabel(severity), count }));
  const dominant = severityMix[0];
  const mostly = dominant ? `, mostly ${dominant.label}` : '';
  const headline = `${humanizeClass(summary.errorClass)}, ${summary.count} time${summary.count === 1 ? '' : 's'}${mostly}`;
  return {
    id: summary.id,
    headline,
    severityMix,
    lastSeen: summary.lastSeen,
    trend7d: summary.trend7d,
  };
}
