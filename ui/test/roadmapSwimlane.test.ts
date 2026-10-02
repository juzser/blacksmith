import { describe, expect, it } from 'vitest';
import type { MilestoneProgress } from '../src/lib/api.js';
import {
  barState,
  buildAxisMarks,
  buildEpicOnlySwimlane,
  buildMonthMarks,
  buildSwimlane,
  chooseTickUnit,
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

  it('never pins the now-line to the right edge, even when every bar runs to today (fix round 1 #2)', () => {
    const milestones = [
      milestone({
        milestoneId: 'phase-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
        epics: [{ epicId: 'epic-a', startedAt: '2026-01-10T00:00:00.000Z', finishedAt: null }],
      }),
    ];
    const lane = buildSwimlane(milestones, NOW);
    expect(lane.nowOffset).toBeLessThan(100);
  });

  it('exposes axis marks within the fitted bounds', () => {
    const milestones = [
      milestone({
        milestoneId: 'phase-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
      }),
    ];
    const lane = buildSwimlane(milestones, NOW);
    expect(lane.months.length).toBeGreaterThan(0);
    for (const m of lane.months) {
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.left).toBeLessThanOrEqual(100);
    }
  });

  it('fits the axis to the real span instead of forcing a two-month minimum (fix round 2 #1)', () => {
    // A project spanning a handful of days around NOW used to still padded
    // out to a forced two-calendar-month axis, collapsing every bar to
    // MIN_BAR_WIDTH. Two epics with genuinely different real durations must
    // now render genuinely different (and much wider than the old 2%
    // floor) bar widths.
    const milestones = [
      milestone({
        milestoneId: 'phase-1',
        startedAt: '2026-01-10T00:00:00.000Z',
        finishedAt: null,
        epicIds: ['epic-long', 'epic-short'],
        epics: [
          {
            epicId: 'epic-long',
            startedAt: '2026-01-10T00:00:00.000Z',
            finishedAt: '2026-01-14T00:00:00.000Z',
          },
          {
            epicId: 'epic-short',
            startedAt: '2026-01-13T00:00:00.000Z',
            finishedAt: '2026-01-14T00:00:00.000Z',
          },
        ],
      }),
    ];
    const lane = buildSwimlane(milestones, NOW);
    const long = lane.rows.find((r) => r.id === 'epic-long')?.bar;
    const short = lane.rows.find((r) => r.id === 'epic-short')?.bar;
    expect(long?.width).toBeGreaterThan(20);
    expect(short?.width).toBeGreaterThan(5);
    expect(long?.width ?? 0).toBeGreaterThan(short?.width ?? 0);
  });
});

describe('chooseTickUnit (fix round 2 #1)', () => {
  it('picks day ticks for a short span', () => {
    expect(chooseTickUnit({ start: 0, end: 1000 * 60 * 60 * 24 * 10 })).toBe('day');
  });

  it('picks week ticks for a medium span', () => {
    expect(chooseTickUnit({ start: 0, end: 1000 * 60 * 60 * 24 * 60 })).toBe('week');
  });

  it('picks month ticks for a long span', () => {
    expect(chooseTickUnit({ start: 0, end: 1000 * 60 * 60 * 24 * 200 })).toBe('month');
  });
});

describe('buildAxisMarks (fix round 2 #1)', () => {
  it('dispatches to day-stepped marks for a short span', () => {
    const bounds = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 5) };
    const marks = buildAxisMarks(bounds);
    expect(marks.length).toBeGreaterThan(1);
    expect(marks[0]?.left).toBe(0);
  });

  it('dispatches to month marks for a long span (same as buildMonthMarks)', () => {
    const bounds = { start: Date.UTC(2026, 0, 15), end: Date.UTC(2026, 6, 10) };
    expect(buildAxisMarks(bounds)).toEqual(buildMonthMarks(bounds));
  });
});

describe('buildMonthMarks', () => {
  it('returns one mark per calendar month boundary within bounds, left-to-right', () => {
    const bounds = {
      start: Date.UTC(2026, 0, 15),
      end: Date.UTC(2026, 2, 10),
    };
    const marks = buildMonthMarks(bounds);
    expect(marks.map((m) => m.label)).toEqual(['Jan', 'Feb', 'Mar']);
    expect(marks[0]?.left).toBe(0);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!.left).toBeGreaterThan(marks[i - 1]!.left);
    }
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
