// DS6 PR4b round 3 item 1 (ds-spec.md §4.3 "Live"): "pause on scroll" -- a
// poll's new rows only shift content the reader is looking at when they are
// already at the top. Scrolled away, they buffer and a "N new events" pill
// appears instead; activating it inserts them and scrolls to the top. Pure
// and DOM-free so it lands in the covered lib/ surface; ActivityPage.vue
// owns the IntersectionObserver that decides `atTop` and the scroll-to-top
// call on flush.
export class LiveFeedBuffer<T extends { eventId: string }> {
  private buffered: T[] = [];

  get pendingCount(): number {
    return this.buffered.length;
  }

  /**
   * Feed a poll's newer-than-cursor entries (newest first). At the top,
   * returns the entries to merge now -- including anything buffered from an
   * earlier poll, so returning to the top never leaves a stale pill count
   * behind -- and clears the buffer. Scrolled away, buffers them (newest
   * first) and returns null. An empty poll at the top still returns `[]`
   * (a real, if empty, merge) so the caller can tell it apart from "buffered
   * instead".
   */
  receive(entries: readonly T[], atTop: boolean): T[] | null {
    if (atTop) {
      const merged = [...entries, ...this.buffered];
      this.buffered = [];
      return merged;
    }
    if (entries.length > 0) this.buffered = [...entries, ...this.buffered];
    return null;
  }

  /** The pill's click handler: return and clear whatever is buffered. */
  flush(): T[] {
    const out = this.buffered;
    this.buffered = [];
    return out;
  }
}
