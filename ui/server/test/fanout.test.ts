// The merge order of the Overview lists when more than one store reports: each
// list keeps the order a single store already gives it, with the store id as
// the tie-breaker.
import { describe, expect, it } from 'vitest';
import type { OverviewResult } from '../../../factory/orchestrator/src/db/queries.js';
import { mergeOverview } from '../src/fanout.js';

const part = (id: string, over: Record<string, unknown>) => ({
  store: { id, label: id },
  data: {
    liveAgents: [],
    liveAgentEntries: [],
    liveAgentCount: 0,
    workingAgentCount: 0,
    stalledAgentCount: 0,
    runningSessions: [],
    epicsInFlight: [],
    epicsActivelyRunning: [],
    epicsIdle: [],
    closedEpics: [],
    tokensByEpic: [],
    alerts: { escalations: 0, pendingWaivers: 0 },
    milestoneProgress: [],
    recentDispatches: [],
    liveAgentCountDelta5m: 0,
    workingAgentCountDelta5m: 0,
    budgetUsedPctPointDelta1h: null,
    ...over,
  } as unknown as OverviewResult,
});

describe('mergeOverview order', () => {
  it('sorts live agent entries newest dispatch first, store id breaking a tie', () => {
    const entry = (id: string, dispatchedAt: string) => ({ id, dispatchedAt });
    const merged = mergeOverview([
      part('b-store', { liveAgentEntries: [entry('b1', '2026-01-02'), entry('b2', '2026-01-01')] }),
      part('a-store', { liveAgentEntries: [entry('a1', '2026-01-02'), entry('a2', '2026-01-03')] }),
    ]);
    const ids = (merged.liveAgentEntries as { id: string }[]).map((e) => e.id);
    expect(ids).toEqual(['a2', 'a1', 'b1', 'b2']);
  });

  it('sorts milestone progress by sequence, store id breaking a tie', () => {
    const row = (milestoneId: string, sequence: number) => ({ milestoneId, sequence });
    const merged = mergeOverview([
      part('b-store', { milestoneProgress: [row('b-1', 1), row('b-2', 3)] }),
      part('a-store', { milestoneProgress: [row('a-1', 1), row('a-2', 2)] }),
    ]);
    const ids = (merged.milestoneProgress as { milestoneId: string }[]).map((m) => m.milestoneId);
    expect(ids).toEqual(['a-1', 'b-1', 'a-2', 'b-2']);
  });

  it('leaves a single store untouched', () => {
    const merged = mergeOverview([
      part('only', { milestoneProgress: [{ sequence: 2 }, { sequence: 1 }] }),
    ]);
    expect((merged.milestoneProgress as { sequence: number }[]).map((m) => m.sequence)).toEqual([
      2, 1,
    ]);
  });

  it('merges idle epics from every store, tagged, so a foreign idle epic is reported', () => {
    const merged = mergeOverview([
      part('home', { epicsIdle: [] }),
      part('store-b', { epicsIdle: [{ epicId: 'epic-a', idleDays: 9 }] }),
    ]);
    expect(merged.epicsIdle).toEqual([
      { epicId: 'epic-a', idleDays: 9, store: { id: 'store-b', label: 'store-b' } },
    ]);
  });

  it('keeps each store its own idle order and orders the stores by id', () => {
    const idle = (epicId: string, idleDays: number) => ({ epicId, idleDays });
    const merged = mergeOverview([
      part('store-b', { epicsIdle: [idle('epic-a', 9), idle('epic-z', 30)] }),
      part('store-a', { epicsIdle: [idle('epic-a', 12), idle('epic-m', 8)] }),
    ]);
    const rows = merged.epicsIdle as { epicId: string; store: { id: string } }[];
    expect(rows.map((e) => `${e.store.id}:${e.epicId}`)).toEqual([
      'store-a:epic-a',
      'store-a:epic-m',
      'store-b:epic-a',
      'store-b:epic-z',
    ]);
  });

  it('leaves a single store idle list as it came', () => {
    const merged = mergeOverview([
      part('only', {
        epicsIdle: [
          { epicId: 'epic-z', idleDays: 8 },
          { epicId: 'epic-a', idleDays: 30 },
        ],
      }),
    ]);
    expect((merged.epicsIdle as { epicId: string }[]).map((e) => e.epicId)).toEqual([
      'epic-z',
      'epic-a',
    ]);
  });
});
