/**
 * Which findings the operator can actually waive from the dashboard.
 *
 * These two lists are a deliberate second copy of
 * `factory/orchestrator/src/waivers.ts`. The UI bundle cannot import from
 * the orchestrator's compiled output (`ui/tsconfig.json` scopes to `ui/`,
 * and the browser build must not pull in better-sqlite3), so the choice is
 * between a copy that a test pins and an inline literal that nothing pins.
 * `ui/test/waivable.test.ts` asserts both lists element-for-element; if the
 * policy moves, that test goes red rather than the UI going quietly wrong.
 *
 * Sources, in order of authority:
 *   - `factory/policies/severity.yml` waiver_semantics -- "Only S3/S4
 *     findings are ever waived. S1/S2 cannot be waived."
 *   - `waivers.ts` WAIVABLE_SEVERITIES / WAIVABLE_STATUSES -- what
 *     `applyBatch()` will accept, i.e. what a click can succeed at.
 *   - `db/queries.ts` overview()/projectSummary() -- the same predicate,
 *     which is what the "Needs you" banner counts.
 */
export const WAIVABLE_SEVERITIES: readonly string[] = ['S3-minor', 'S4-nit'];

/** finding_status values findings.ts LEGAL_TRANSITIONS allows a `waived` edge from. */
export const WAIVABLE_STATUSES: readonly string[] = ['raised', 'confirmed'];

/** The shape this needs: any finding row from `TaskDetail['findings']`. */
export interface WaivableFinding {
  severity: string;
  findingStatus: string;
  waiverId: string | null;
}

/**
 * True when the operator can decide this finding right now.
 *
 * The `waiverId === null` clause is the only part that is not policy: a
 * finding already carrying a decision is not pending, whatever its status
 * says, and offering the control again would post a second decision for a
 * fingerprint the log has already answered.
 */
export function isWaivable(f: WaivableFinding): boolean {
  return (
    WAIVABLE_SEVERITIES.includes(f.severity) &&
    WAIVABLE_STATUSES.includes(f.findingStatus) &&
    f.waiverId === null
  );
}
