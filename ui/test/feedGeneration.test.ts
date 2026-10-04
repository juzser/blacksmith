// Fix round items 1-2 (ActivityPage.vue poll/loadOlder/load race): a request
// generation token plus poll()'s own in-flight flag, pure and DOM-free so it
// lands in the covered lib/ surface (ui/vitest.config.ts excludes composables
// and .vue files).
import { describe, expect, it } from 'vitest';
import { FeedGeneration } from '../src/lib/feedGeneration.js';

describe('FeedGeneration', () => {
  it('a fresh snapshot is never stale until the next bump', () => {
    const gen = new FeedGeneration();
    const snap = gen.snapshot();
    expect(gen.isStale(snap)).toBe(false);
  });

  it('bump() stales every snapshot taken before it', () => {
    const gen = new FeedGeneration();
    const snap = gen.snapshot();
    gen.bump();
    expect(gen.isStale(snap)).toBe(true);
  });

  it('a snapshot taken after bump() is not stale', () => {
    const gen = new FeedGeneration();
    gen.bump();
    const snap = gen.snapshot();
    expect(gen.isStale(snap)).toBe(false);
  });

  it('item 1: a second poll cannot start while one is already in flight', () => {
    const gen = new FeedGeneration();
    expect(gen.startPoll()).toBe(true);
    expect(gen.startPoll()).toBe(false);
  });

  it('item 1: a new poll can start once the in-flight one ends', () => {
    const gen = new FeedGeneration();
    gen.startPoll();
    gen.endPoll();
    expect(gen.startPoll()).toBe(true);
  });

  it('bump() also clears a stuck in-flight poll flag', () => {
    const gen = new FeedGeneration();
    gen.startPoll();
    gen.bump();
    expect(gen.startPoll()).toBe(true);
  });
});
