// Tooltip's open/close state machine (ds-spec.md §2.5), kept free of the DOM
// the same way useFlashOnChange.ts earns its unit test: it owns a timer, and
// "does the 300ms hover delay actually wait, does focus skip it, does a
// second tooltip close the first one" is invisible in a screenshot.
//
// Floating-ui positioning (offset/flip/shift/autoUpdate) is Tooltip.vue's
// job, not this composable's — that needs a DOM this config deliberately
// lacks (ui/vitest.config.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTooltip } from '../src/composables/useTooltip.js';

describe('composables/useTooltip.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts hidden', () => {
    const { shown } = useTooltip();
    expect(shown.value).toBe(false);
  });

  it('opens after 300ms of hover, not before', () => {
    const { shown, scheduleShow } = useTooltip();
    scheduleShow();
    expect(shown.value).toBe(false);
    vi.advanceTimersByTime(299);
    expect(shown.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown.value).toBe(true);
  });

  it('never opens if the pointer leaves before the delay elapses', () => {
    const { shown, scheduleShow, hide } = useTooltip();
    scheduleShow();
    vi.advanceTimersByTime(150);
    hide();
    vi.advanceTimersByTime(1000);
    expect(shown.value).toBe(false);
  });

  it('opens immediately on keyboard focus, skipping the hover delay', () => {
    const { shown, showNow } = useTooltip();
    showNow();
    expect(shown.value).toBe(true);
  });

  it('closes on hide(), the mouseleave/blur/Escape handler', () => {
    const { shown, showNow, hide } = useTooltip();
    showNow();
    hide();
    expect(shown.value).toBe(false);
  });

  it('keeps only one tooltip open at a time', () => {
    const a = useTooltip();
    const b = useTooltip();
    a.showNow();
    expect(a.shown.value).toBe(true);
    b.showNow();
    expect(a.shown.value).toBe(false);
    expect(b.shown.value).toBe(true);
  });

  it('a hidden tooltip does not close an unrelated open one', () => {
    const a = useTooltip();
    const b = useTooltip();
    a.showNow();
    b.hide();
    expect(a.shown.value).toBe(true);
  });
});
