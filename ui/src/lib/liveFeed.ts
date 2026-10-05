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

/** The "N new events" pill's own label -- always formats, since the pill
 * only ever renders once its caller has already checked count > 0. */
export function formatNewEventsCount(count: number): string {
  return count === 1 ? '1 new event' : `${count} new events`;
}

/** Fix round item 3: an empty poll while scrolled away must never announce
 * "0 new events" to the polite live region, and a poll that repeats an
 * unchanged pending count (another empty poll on top of an existing buffer)
 * must not re-announce the same text either -- only a genuine increase gets
 * a fresh announcement. */
export class NewEventsAnnouncer {
  private lastCount = 0;

  /** Call with the buffer's current pending count after each poll. Returns
   * the announcement text, or null to say nothing. */
  next(count: number): string | null {
    const grew = count > this.lastCount;
    this.lastCount = count;
    return grew ? formatNewEventsCount(count) : null;
  }

  /** Call whenever the pending count is cleared outside of a poll (load(),
   * applyPendingNew(), a top-of-feed merge) so the next genuine increase
   * still announces. */
  reset(): void {
    this.lastCount = 0;
  }
}
