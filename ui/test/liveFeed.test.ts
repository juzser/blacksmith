// DS6 PR4b round 3 item 1 (Activity live updates): "pause on scroll" buffers
// a poll's new rows instead of shifting content the viewer is reading, and
// surfaces a "N new events" pill; pure/DOM-free so it lands in the covered
// lib/ surface (ui/vitest.config.ts excludes composables and .vue files).
import { describe, expect, it } from 'vitest';
import { LiveFeedBuffer } from '../src/lib/liveFeed.js';

interface FakeEntry {
  eventId: string;
}

describe('LiveFeedBuffer', () => {
  it('merges immediately when the reader is at the top', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    const merged = buf.receive([{ eventId: 'e2' }, { eventId: 'e1' }], true);
    expect(merged).toEqual([{ eventId: 'e2' }, { eventId: 'e1' }]);
    expect(buf.pendingCount).toBe(0);
  });

  it('buffers instead of merging when the reader has scrolled away', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    const merged = buf.receive([{ eventId: 'e1' }], false);
    expect(merged).toBeNull();
    expect(buf.pendingCount).toBe(1);
  });

  it('accumulates across polls while still scrolled away, newest first', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    buf.receive([{ eventId: 'e1' }], false);
    buf.receive([{ eventId: 'e2' }], false);
    expect(buf.pendingCount).toBe(2);
    expect(buf.flush()).toEqual([{ eventId: 'e2' }, { eventId: 'e1' }]);
  });

  it('flush clears the buffer and resets the count', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    buf.receive([{ eventId: 'e1' }], false);
    const flushed = buf.flush();
    expect(flushed).toEqual([{ eventId: 'e1' }]);
    expect(buf.pendingCount).toBe(0);
    expect(buf.flush()).toEqual([]);
  });

  it('merging at the top also flushes anything buffered earlier', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    buf.receive([{ eventId: 'e1' }], false);
    const merged = buf.receive([{ eventId: 'e2' }], true);
    expect(merged).toEqual([{ eventId: 'e2' }, { eventId: 'e1' }]);
    expect(buf.pendingCount).toBe(0);
  });

  it('an empty poll at the top is a no-op, not an empty merge', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    expect(buf.receive([], true)).toEqual([]);
    expect(buf.pendingCount).toBe(0);
  });

  it('an empty poll while scrolled away does not touch the buffer', () => {
    const buf = new LiveFeedBuffer<FakeEntry>();
    buf.receive([{ eventId: 'e1' }], false);
    expect(buf.receive([], false)).toBeNull();
    expect(buf.pendingCount).toBe(1);
  });
});
