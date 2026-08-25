// A size handed to a component from a template, turned into something the
// browser will actually accept.
//
// Vue passes a static attribute as a string, always: `height="240"` arrives
// as '240', not 240. `'240'` is not a CSS length, so `style="height: 240"`
// is dropped silently and the element collapses. That is D-223 — every
// skeleton in the product rendered at zero height, which is why a page stuck
// on `loading` looked like an empty page rather than a loading one.
//
// The rule is deliberately narrow: a value that is just a number means
// pixels, and anything else is passed through untouched, because a caller
// who wrote a unit, a percentage, a `var()` or a `calc()` meant it.

/** Normalize a size for an inline style. Returns undefined when there is
 *  nothing to write, so the declaration is omitted rather than emitted
 *  empty. */
export function cssLength(value: number | string | undefined): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? `${value}px` : undefined;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? `${trimmed}px` : trimmed;
}
