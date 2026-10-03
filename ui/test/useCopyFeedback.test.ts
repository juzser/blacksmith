// DS4 S5c fix round 1, fix 8 — EpicBlock.vue's copy-id timer, extracted so
// "does it clear on unmount / re-click / epic-id change" is testable without
// a mounted component, same rationale as useFlashOnChange.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyFeedback } from '../src/composables/useCopyFeedback.js';

describe('composables/useCopyFeedback.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the idle label', () => {
    const { label } = useCopyFeedback('Copy epic id');
    expect(label.value).toBe('Copy epic id');
  });

  it('flashes "Copied" then reverts to the idle label', () => {
    const { label, flash } = useCopyFeedback('Copy epic id');
    flash();
    expect(label.value).toBe('Copied');
    vi.advanceTimersByTime(1499);
    expect(label.value).toBe('Copied');
    vi.advanceTimersByTime(1);
    expect(label.value).toBe('Copy epic id');
  });

  it('restarts the window on a second flash instead of stacking timers', () => {
    const { label, flash } = useCopyFeedback('Copy epic id');
    flash();
    vi.advanceTimersByTime(1000);
    flash();
    vi.advanceTimersByTime(1000);
    expect(label.value).toBe('Copied');
    vi.advanceTimersByTime(500);
    expect(label.value).toBe('Copy epic id');
  });

  it('reset() clears a pending flash and sets a new idle label', () => {
    const { label, flash, reset } = useCopyFeedback('Copy epic-1 id');
    flash();
    expect(label.value).toBe('Copied');
    reset('Copy epic-2 id');
    expect(label.value).toBe('Copy epic-2 id');
    vi.advanceTimersByTime(1500);
    expect(label.value).toBe('Copy epic-2 id');
  });

  it('stop() cancels a pending flash without changing the label', () => {
    const { label, flash, stop } = useCopyFeedback('Copy epic id');
    flash();
    stop();
    vi.advanceTimersByTime(1500);
    expect(label.value).toBe('Copied');
  });
});
