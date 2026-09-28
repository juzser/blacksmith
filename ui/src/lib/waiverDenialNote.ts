/**
 * Denying a waiver does not close the finding. `applyWaiverBatch`'s
 * `findingIdsToCarry` (waivers.ts) lists every finding the batch left open
 * with no further move of its own -- and the toast is the only place a
 * denial's outcome is stated, so it has to say which ones still need
 * carrying forward, not just that the click worked (#221).
 *
 * Returns a trailing clause with a leading space, so a caller can append it
 * straight onto a base sentence like "Denied 1 waiver." -- and an empty
 * string when there is nothing to carry, so that concatenation is a no-op.
 */
export function waiverDenialNote(findingIdsToCarry: readonly string[]): string {
  if (findingIdsToCarry.length === 0) return '';
  const pronoun = findingIdsToCarry.length === 1 ? 'it stays' : 'they stay';
  return ` Carry ${findingIdsToCarry.join(', ')} in the next \`plan amend --findings\`, or ${pronoun} open.`;
}
