// DS6 PR4b round 2 item 2 (Load older sentinel): the IntersectionObserver
// callback can fire repeatedly while the sentinel stays in view, so the
// "load older" trigger (sentinel or the fallback button) needs a guard
// against re-entrant fetches, pure and DOM-free so it lands in the covered
// lib/ surface (ui/vitest.config.ts excludes composables and .vue files).
import { describe, expect, it } from 'vitest';
import { LoadOlderGate } from '../src/lib/activityPaging.js';

describe('LoadOlderGate', () => {
  it('allows a load when there is an older page and nothing in flight', () => {
    const gate = new LoadOlderGate('cursor-1');
    expect(gate.canLoad).toBe(true);
    expect(gate.start()).toBe(true);
  });

  it('refuses a second start while a load is already in flight', () => {
    const gate = new LoadOlderGate('cursor-1');
    expect(gate.start()).toBe(true);
    expect(gate.canLoad).toBe(false);
    expect(gate.start()).toBe(false);
  });

  it('allows the next load once the in-flight one finishes', () => {
    const gate = new LoadOlderGate('cursor-1');
    gate.start();
    gate.finish('cursor-2');
    expect(gate.canLoad).toBe(true);
    expect(gate.start()).toBe(true);
  });

  it('stops once nextBefore is null, even after finish', () => {
    const gate = new LoadOlderGate('cursor-1');
    gate.start();
    gate.finish(null);
    expect(gate.canLoad).toBe(false);
    expect(gate.start()).toBe(false);
  });

  it('starts refused outright when there is no older page', () => {
    const gate = new LoadOlderGate(null);
    expect(gate.canLoad).toBe(false);
    expect(gate.start()).toBe(false);
  });
});
