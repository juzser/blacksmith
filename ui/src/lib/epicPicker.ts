// The epic <Select> that Kanban and Flow both carry, and the rule for what
// happens when the list behind it does not arrive.
//
// Both pages read their epics from /api/overview while their own data comes
// from a different endpoint, so the picker can fail on its own. It must fail
// on its own too: D-222 had the picker's fetch awaited first and unguarded,
// which meant a failed overview stopped the page's real fetch from ever
// running and left `loading` true with `error` null — the skeleton forever,
// a state the operator cannot tell from "still loading".
//
// The option list lived inline in both templates. .vue files are checked by
// neither tsc nor biome here, so a control assembled in a template has no
// gate on it at all; assembling it here is what makes the rules below
// assertable.
/** Structurally the option shape Select.vue declares. Declared here rather
 *  than imported because `shims.d.ts` types every `.vue` module as a default
 *  export only, so a named type cannot cross out of an SFC. */
export interface EpicOption {
  value: string;
  label: string;
}

/** The picker's "don't filter" choice. Empty, because that is what the epic
 *  query param and fetchKanban/fetchFlow already treat as "every epic". */
export const ALL_EPICS = '';

/** Shown when the epic list failed but the page's own data did not — the
 *  picker still works, it just cannot offer anything to narrow to. */
export const EPIC_LIST_UNAVAILABLE =
  'Epic list unavailable — showing every epic. The board itself loaded.';

/**
 * The picker's options: the all-epics escape hatch first, then the epics in
 * the order the overview reported them (in flight before closed, which is
 * the order an operator scans).
 *
 * An id equal to the sentinel is dropped rather than rendered: <option> is
 * keyed on its value and the v-model IS the value, so a second option
 * carrying `ALL_EPICS` would collide on both and make the picker's selection
 * ambiguous. Nothing upstream should produce one — this is the guarantee the
 * two callers get to rely on, not a suspicion about the projector.
 */
/**
 * The selection to keep when the list underneath the picker is replaced
 * wholesale — a project switch, where the epics on offer are a different set
 * entirely.
 *
 * A `<select>` shows nothing selected for a value that is not among its
 * options, so a retained foreign epic leaves the control reading "All epics"
 * while the page is still filtered to one epic of a project it is no longer
 * scoped to — the control and the filter disagreeing, silently. Falling back
 * to the sentinel makes them agree again, and "every epic of the project you
 * just switched to" is the only thing the operator could have meant.
 *
 * `ALL_EPICS` is never in `epics` (epicOptions() guarantees it), so the
 * sentinel falls through this on its own without a special case.
 */
export function retainedEpic(selected: string, epics: readonly string[]): string {
  return epics.includes(selected) ? selected : ALL_EPICS;
}

export function epicOptions(epics: readonly string[]): EpicOption[] {
  const seen = new Set<string>([ALL_EPICS]);
  const options: EpicOption[] = [{ value: ALL_EPICS, label: 'All epics' }];
  for (const epic of epics) {
    if (seen.has(epic)) continue;
    seen.add(epic);
    options.push({ value: epic, label: epic });
  }
  return options;
}
