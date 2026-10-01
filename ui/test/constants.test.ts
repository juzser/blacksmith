// DS3 §4.7 Slice A item 6 — pure constants the Kanban board and task-detail
// components (added in a later slice of this epic) share, so each has one
// definition and one unit test instead of a magic number per call site.
import { describe, expect, it } from 'vitest';
import { agentWaitingThresholdMs, KANBAN_VIRTUALIZE_THRESHOLD } from '../src/lib/constants.js';

describe('lib/constants.ts', () => {
  it('KANBAN_VIRTUALIZE_THRESHOLD is a positive whole number of cards', () => {
    expect(Number.isInteger(KANBAN_VIRTUALIZE_THRESHOLD)).toBe(true);
    expect(KANBAN_VIRTUALIZE_THRESHOLD).toBeGreaterThan(0);
  });

  it('agentWaitingThresholdMs is a positive whole number of milliseconds', () => {
    expect(Number.isInteger(agentWaitingThresholdMs)).toBe(true);
    expect(agentWaitingThresholdMs).toBeGreaterThan(0);
  });
});
