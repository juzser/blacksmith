// Fix round items 1-2 (ActivityPage.vue): poll() had no in-flight guard of
// its own (the 15s tick and the shared Refresh button can both fire while a
// previous poll is still in flight, and both would merge the same batch --
// duplicate rows, a double-counted pill), and any of poll/loadOlder's
// in-flight requests could still resolve after a filter/session/project
// change already called load() again, splicing stale rows into a feed the
// caller has already replaced. One generation token answers both: load()
// bumps it on every fetch (including the first), and poll/loadOlder/load
// each capture a snapshot before their own fetch starts and drop the
// response if the generation moved on while it was in flight.
export class FeedGeneration {
  private generation = 0;
  private pollInFlight = false;

  /** Call before load()'s fetch starts. Also clears a stuck in-flight poll
   * flag -- a filter/session change invalidates whatever poll was running
   * under the previous generation, so it should never block the next one. */
  bump(): number {
    this.generation += 1;
    this.pollInFlight = false;
    return this.generation;
  }

  /** Capture before poll()'s or loadOlder()'s own fetch starts. */
  snapshot(): number {
    return this.generation;
  }

  /** True once a later bump() has superseded the snapshot's generation. */
  isStale(snapshot: number): boolean {
    return snapshot !== this.generation;
  }

  /** poll()'s own in-flight guard, separate from the generation token --
   * two overlapping poll triggers must fetch at most once between them.
   * Returns false, and does nothing, when a poll is already running. */
  startPoll(): boolean {
    if (this.pollInFlight) return false;
    this.pollInFlight = true;
    return true;
  }

  /** Call when poll()'s fetch settles (success or failure). */
  endPoll(): void {
    this.pollInFlight = false;
  }
}
