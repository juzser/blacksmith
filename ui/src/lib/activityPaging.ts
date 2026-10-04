// DS6 PR4b round 2 item 2 (Load older sentinel): guards the "load older"
// trigger (the IntersectionObserver sentinel, or the fallback button) so a
// sentinel that stays in view while the next page loads can't fire a second
// fetch, and so neither trigger fires once there is no older page left.
export class LoadOlderGate {
  private loading = false;
  private nextBefore: string | null;

  constructor(nextBefore: string | null) {
    this.nextBefore = nextBefore;
  }

  get canLoad(): boolean {
    return !this.loading && this.nextBefore !== null;
  }

  /** Call before starting a fetch. Returns false, and does nothing, when a
   * load is already in flight or there is no older page to fetch. */
  start(): boolean {
    if (!this.canLoad) return false;
    this.loading = true;
    return true;
  }

  /** Call when the fetch settles (success or failure) with the page's new
   * nextBefore, or the unchanged one on failure, to allow a retry. */
  finish(nextBefore: string | null): void {
    this.loading = false;
    this.nextBefore = nextBefore;
  }
}
