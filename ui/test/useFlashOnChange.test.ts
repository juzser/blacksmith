// The one composable with a unit test. It earns the exception because it owns
// a timer: everything else under ui/src/composables/ needs a mounted component
// (usePoll's onMounted, useTheme's document), but this is a watcher plus a
// setTimeout, and "does the flash actually clear, and does a second change
// restart it rather than stack a second timer?" is exactly the kind of thing
// that is invisible in a screenshot and a leak in production.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useFlashOnChange } from '../src/composables/useFlashOnChange.js';

describe('composables/useFlashOnChange.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flash on the first read — arriving is not changing', async () => {
    const source = ref('a');
    const { flashing } = useFlashOnChange(() => source.value, 900);
    await nextTick();
    expect(flashing.value).toBe(false);
  });

  it('flashes when the signature changes, then clears itself', async () => {
    const source = ref('a');
    const { flashing } = useFlashOnChange(() => source.value, 900);
    source.value = 'b';
    await nextTick();
    expect(flashing.value).toBe(true);
    vi.advanceTimersByTime(899);
    expect(flashing.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(flashing.value).toBe(false);
  });

  it('restarts the window on a second change instead of stacking timers', async () => {
    const source = ref('a');
    const { flashing } = useFlashOnChange(() => source.value, 900);
    source.value = 'b';
    await nextTick();
    vi.advanceTimersByTime(800);
    source.value = 'c';
    await nextTick();
    // The first timer must not fire mid-way through the second flash.
    vi.advanceTimersByTime(800);
    expect(flashing.value).toBe(true);
    vi.advanceTimersByTime(100);
    expect(flashing.value).toBe(false);
  });

  it('stops watching and cancels a pending timer on stop()', async () => {
    const source = ref('a');
    const { flashing, stop } = useFlashOnChange(() => source.value, 900);
    source.value = 'b';
    await nextTick();
    expect(flashing.value).toBe(true);
    stop();
    expect(flashing.value).toBe(false);
    source.value = 'c';
    await nextTick();
    expect(flashing.value).toBe(false);
  });
});
