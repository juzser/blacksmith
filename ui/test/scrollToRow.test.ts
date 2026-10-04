// This vitest config has no DOM (environment: 'node', see vitest.config.ts) —
// stub just the one global call this helper makes, rather than pulling in a
// DOM harness for a two-line function. Real scroll/highlight behavior is
// covered by Playwright (home.spec.ts, activity.spec.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollToTimelineRow } from '../src/lib/scrollToRow.js';

afterEach(() => {
  // @ts-expect-error -- test-only stub cleanup
  delete globalThis.document;
});

describe('scrollToTimelineRow', () => {
  it('scrolls the row with that event id into the center of view', () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn(() => ({ scrollIntoView }));
    // @ts-expect-error -- minimal stub, not a full Document
    globalThis.document = { getElementById };

    scrollToTimelineRow('evt-1');

    expect(getElementById).toHaveBeenCalledWith('activity-row-evt-1');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('is a no-op when the row is not currently on screen', () => {
    const getElementById = vi.fn(() => null);
    // @ts-expect-error -- minimal stub, not a full Document
    globalThis.document = { getElementById };

    expect(() => scrollToTimelineRow('missing')).not.toThrow();
  });
});
