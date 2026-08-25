/**
 * The element at `index`, or a failure that names how many there actually are.
 *
 * Under `noUncheckedIndexedAccess` every `xs[i]` is `T | undefined`, so a test
 * that indexes into a result whose shape it has just asserted has to restate
 * the claim for the type checker. `xs[i]?.field` would satisfy it and change
 * what fails: the matcher then reports an `undefined` field where the real
 * claim — that there is an element at `i` at all — was never made. This makes
 * that claim once, and fails on it in its own words.
 */
export function nth<T>(xs: readonly T[], index: number): T {
  const value = xs[index];
  if (value === undefined) {
    throw new Error(`expected an element at [${index}], but the list holds ${xs.length}`);
  }
  return value;
}
