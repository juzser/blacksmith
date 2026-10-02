import { describe, expect, it } from 'vitest';
import type { MilestoneProgress } from '../src/lib/api.js';
import {
  barState,
  buildEpicOnlySwimlane,
  buildSwimlane,
  hasRoadmapContent,
  taskCountLabel,
} from '../src/lib/roadmapSwimlane.js';

const NOW = new Date('2026-01-15T09:12:00.000Z');

function milestone(overrides: Partial<MilestoneProgress>): MilestoneProgress {
  return {
    milestoneId: 'phase-1',
    name: 'Phase 1',
    status: 'in-progress',
    sequence: 1,
    goal: null,
    epicIds: [],
    tasksTotal: 0,
    tasksCompleted: 0,
    tokensSpent: 0,
    tokensBudget: null,
    unmeasured: 0,
    project: 'demo',
    kind: 'product',
    startedAt: null,
    finishedAt: null,
    epics: [],
    ...overrides,
  };
}

describe('barState', () => {
  it('reads past once finishedAt is set', () => {
    expect(
      barState(
        { startedAt: '2025-01-01T00:00:00.000Z', finishedAt: '2025-02-01T00:00:00.000Z' },
        NOW,
      ),
    ).toBe('past');
  });

  it('reads now when started but not finished and startedAt is not in the future', () => {
    expect(barState({ startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null }, NOW)).toBe('now');
  });

  it('reads upcoming when startedAt is in the future', () => {
    expect(barState({ startedAt: '2026-06-01T00:00:00.000Z', finishedAt: null }, NOW)).toBe(
      'upcoming',
    );
  });

  it('reads not-scheduled when both dates are null', () => {
    expect(barState({ startedAt: null, finishedAt: null }, NOW)).toBe('not-scheduled');
  });
});

describe('buildSwimlane', () => {
  it('builds one phase row plus one indented sub-row per epic, in epicIds order', () => {
    const milestones = [
      milestone({
        milestoneId: 'phase-1',
        name: 'Phase 1',
        epicIds: ['epic-a', 'epic-b'],
        startedAt: '2025-12-01T00:00:00.000Z',
        finishedAt: null,
        epics: [
          {
            epicId: 'epic-a',
            startedAt: '2025-12-01T00:00:00.000Z',
            finishedAt: '2025-12-20T00:00:00.000Z',
          },
          { epicId: 'epic-b', startedAt: '2026-01-05T00:00:00.000Z', finishedAt: null },
        ],
      }),
    ];
    const lane = buildSwimlane(milestones, NOW);
    expect(lane.rows.map((r) => [r.kind, r.id])).toEqual([
      ['phase', 'phase-1'],
      ['epic', 'epic-a'],
      ['epic', 'epic-b'],
    ]);
    expect(lane.rows[1]?.bar?.state).toBe('past');
    expect(lane.rows[2]?.bar?.state).toBe('now');
  });

  it('defaults a missing per-epic date row to not-scheduled', () => {
    const milestones = [milestone({ milestoneId: 'phase-1', epicIds: ['epic-a'], epics: [] })];
    const lane = buildSwimlane(milestones, NOW);
    expect(lane.rows[1]?.bar).toBeNull();
  });

  it('places the now-line within the computed bounds', () => {
    const milestones = [
      milestone({
        milestoneId: 'phase-1',
        startedAt: '2025-12-01T00:00:00.000Z',
        finishedAt: null,
      }),
    ];
    const lane = buildSwimlane(milestones, NOW);
    expect(lane.nowOffset).toBeGreaterThanOrEqual(0);
    expect(lane.nowOffset).toBeLessThanOrEqual(100);
  });
});

describe('buildEpicOnlySwimlane', () => {
  it('builds one not-scheduled row per epic for a project with no phases', () => {
    const lane = buildEpicOnlySwimlane(['epic-a', 'epic-b']);
    expect(lane.rows).toEqual([
      { kind: 'epic', id: 'epic-a', label: 'epic-a', bar: null },
      { kind: 'epic', id: 'epic-b', label: 'epic-b', bar: null },
    ]);
  });
});

describe('taskCountLabel (audit item 6)', () => {
  it('reads "No tasks tracked" for zero tasks, never a 0/1 or a percentage', () => {
    expect(taskCountLabel(0, 0)).toBe('No tasks tracked');
  });

  it('reads "N of M tasks done" otherwise', () => {
    expect(taskCountLabel(5, 2)).toBe('2 of 5 tasks done');
  });
});

describe('hasRoadmapContent (audit item 7)', () => {
  it('is true with at least one phase', () => {
    expect(hasRoadmapContent([milestone({})], [])).toBe(true);
  });

  it('is true with at least one selectable epic', () => {
    expect(hasRoadmapContent([], ['epic-a'])).toBe(true);
  });

  it('is false only when both sources are empty', () => {
    expect(hasRoadmapContent([], [])).toBe(false);
  });
});
