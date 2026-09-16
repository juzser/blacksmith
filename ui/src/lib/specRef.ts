/**
 * The one line that tells an operator what a spec finding is about.
 *
 * A spec finding is minted against a criterion of a plan version
 * (findings.ts `SpecRef`), and the criterion is what the operator has to
 * re-read to answer it — a diff finding points at a file, a spec finding
 * points at a sentence in the plan. The projection carries the three columns;
 * this is the label the task page and the timeline both print, so the two
 * cannot disagree about how a spec finding reads.
 *
 * Returns null for a diff finding, and for an absent scope: findings.ts
 * `findingScope()` reads absence as `diff`, and so does this.
 */
export function specRefLabel(f: {
  findingScope?: string | null;
  specPlanVersion?: number | null;
  criterionRef?: string | null;
}): string | null {
  if (f.findingScope !== 'spec') return null;
  const parts = ['spec'];
  if (f.specPlanVersion !== null && f.specPlanVersion !== undefined) {
    parts.push(`plan v${f.specPlanVersion}`);
  }
  if (f.criterionRef) parts.push(f.criterionRef);
  return parts.join(' · ');
}
