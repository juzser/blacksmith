// "There is nothing here" is a measurement, and only a request that returned
// can make one. Every page in this app keeps its list in a ref that starts
// empty, so on a failed fetch the count is still zero and an empty state
// chained off `count === 0` alone renders the all-clear -- "No errors logged
// yet", "No tasks match these filters", "No projects yet" -- on the strength
// of a request that never answered (D-226, and the same family as D-224 and
// D-225).
//
// `loading` is not the guard. It goes false on the failure path too, which is
// exactly why the failure path reaches the empty state at all.

/**
 * The all-clear. True only when the fetch has actually landed AND the thing it
 * landed is empty.
 *
 * `loaded` must be the fetch's own verdict: a payload ref that is null until a
 * response replaces it, or a flag written in the success path and nowhere
 * else. Passing `!loading` re-creates the bug this function exists to stop.
 */
export function canClaimEmpty(loaded: boolean, count: number): boolean {
  return loaded && count === 0;
}
