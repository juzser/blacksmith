import { describe, expect, it } from 'vitest';
import type { EpicDates, MilestoneProgress } from '../src/lib/api.js';
import {
  barState,
  buildAxisMarks,
  buildEpicOnlySwimlane,
  buildMonthMarks,
  buildSwimlane,
  chooseTickUnit,
  hasRoadmapContent,
  phaseStatusFromCounts,
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
    statusCounts: { done: 0, review: 0, inProgress: 0, todo: 0, superseded: 0 },
    ...overrides,
  };
}

function epic(overrides: Partial<EpicDates> & Pick<EpicDates, 'epicId'>): EpicDates {
  return {
    startedAt: null,
    finishedAt: null,
    statusCounts: { done: 0, review: 0, inProgress: 0, todo: 0, superseded: 0 },
    status: 'todo',
    project: 'demo',
    prUrl: null,
    sourcePrompt: null,
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
          epic({
            epicId: 'epic-a',
            startedAt: '2025-12-01T00:00:00.000Z',
            finishedAt: '2025-12-20T00:00:00.000Z',
          }),
          epic({ epicId: 'epic-b', startedAt: '2026-01-05T00:00:00.000Z', finishedAt: null }),
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
        epics: [
          epic({ epicId: 'epic-a', startedAt: '2026-01-10T00:00:00.000Z', finishedAt: null }),
        ],
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
          epic({
            epicId: 'epic-long',
            startedAt: '2026-01-10T00:00:00.000Z',
            finishedAt: '2026-01-14T00:00:00.000Z',
          }),
          epic({
            epicId: 'epic-short',
            startedAt: '2026-01-13T00:00:00.000Z',
            finishedAt: '2026-01-14T00:00:00.000Z',
          }),
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

  it('picks minute ticks for a span under about 2 hours (fix round 3 #2)', () => {
    expect(chooseTickUnit({ start: 0, end: 1000 * 60 * 10 })).toBe('minute');
  });

  it('picks hour ticks for a sub-day span (fix round 3 #2)', () => {
    expect(chooseTickUnit({ start: 0, end: 1000 * 60 * 60 * 6 })).toBe('hour');
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

  it('shows at least 3 readable ticks for a fixture that spans minutes (fix round 3 #2)', () => {
    const bounds = { start: Date.UTC(2026, 0, 15, 9, 0), end: Date.UTC(2026, 0, 15, 9, 10) };
    const marks = buildAxisMarks(bounds);
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect(marks.every((m) => /^\d{2}:\d{2}$/.test(m.label))).toBe(true);
  });

  it('shows at least 3 readable ticks for a sub-day span (fix round 3 #2)', () => {
    const bounds = { start: Date.UTC(2026, 0, 15, 0, 0), end: Date.UTC(2026, 0, 15, 6, 0) };
    const marks = buildAxisMarks(bounds);
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect(marks.every((m) => /^\d{2}:\d{2}$/.test(m.label))).toBe(true);
  });
});

describe('buildAxisMarks day ticks', () => {
  it('draws no tick for a midnight before the window opens', () => {
    const bounds = { start: Date.UTC(2026, 0, 3, 12), end: Date.UTC(2026, 0, 10) };
    const marks = buildAxisMarks(bounds);
    expect(marks[0]?.label).toBe('Jan 4');
    expect(marks.every((m) => m.left >= 0)).toBe(true);
    expect(marks.map((m) => m.left)).toEqual([...marks.map((m) => m.left)].sort((a, b) => a - b));
  });
});

describe('buildMonthMarks', () => {
  it('returns one mark per calendar month boundary within bounds, left-to-right', () => {
    const bounds = {
      start: Date.UTC(2026, 0, 15),
      end: Date.UTC(2026, 2, 10),
    };
    const marks = buildMonthMarks(bounds);
    expect(marks.map((m) => m.label)).toEqual(['Feb', 'Mar']);
    expect(marks[0]?.left).toBeGreaterThan(0);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!.left).toBeGreaterThan(marks[i - 1]!.left);
    }
  });

  it('keeps the mark for a window that opens exactly on the 1st', () => {
    const marks = buildMonthMarks({ start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 2, 10) });
    expect(marks.map((m) => m.label)).toEqual(['Jan', 'Feb', 'Mar']);
    expect(marks[0]?.left).toBe(0);
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

describe('bar tone follows status, not dates', () => {
  const counts = (c: Partial<EpicDates['statusCounts']>) => ({
    done: 0,
    review: 0,
    inProgress: 0,
    todo: 0,
    superseded: 0,
    ...c,
  });
  const phaseTone = (m: Partial<MilestoneProgress>) =>
    buildSwimlane([milestone({ startedAt: '2026-01-01T00:00:00.000Z', epicIds: [], ...m })], NOW)
      .rows[0]?.bar?.tone;

  it('an in-progress epic with a past date range keeps its tone and the past state', () => {
    const lane = buildSwimlane(
      [
        milestone({
          epicIds: ['epic-a'],
          epics: [
            epic({
              epicId: 'epic-a',
              startedAt: '2025-12-01T00:00:00.000Z',
              finishedAt: '2025-12-20T00:00:00.000Z',
              status: 'in_progress',
            }),
          ],
        }),
      ],
      NOW,
    );
    const bar = lane.rows.find((r) => r.id === 'epic-a')?.bar;
    expect(bar?.tone).toBe('in-progress');
    expect(bar?.state).toBe('past');
  });

  it('a done epic that starts in the future is tone done', () => {
    const lane = buildSwimlane(
      [
        milestone({
          epicIds: ['epic-a'],
          epics: [
            epic({ epicId: 'epic-a', startedAt: '2026-06-01T00:00:00.000Z', status: 'done' }),
          ],
        }),
      ],
      NOW,
    );
    expect(lane.rows.find((r) => r.id === 'epic-a')?.bar?.tone).toBe('done');
  });

  it('a phase with no tasks takes its declared status', () => {
    expect(phaseTone({ status: 'completed' })).toBe('done');
    expect(phaseTone({ status: 'in-progress' })).toBe('in-progress');
    expect(phaseTone({ status: 'planned' })).toBe('todo');
  });

  it('a completed phase with every task superseded is done', () => {
    expect(
      phaseTone({ status: 'completed', tasksTotal: 2, statusCounts: counts({ superseded: 2 }) }),
    ).toBe('done');
  });

  it('an in-progress phase of review + done tasks only is review', () => {
    expect(
      phaseTone({
        status: 'in-progress',
        tasksTotal: 3,
        statusCounts: counts({ done: 1, review: 2 }),
      }),
    ).toBe('review');
  });

  it('an in-progress phase with every live task done stays in-progress', () => {
    expect(
      phaseTone({
        status: 'in-progress',
        tasksTotal: 5,
        statusCounts: counts({ done: 3, superseded: 2 }),
      }),
    ).toBe('in-progress');
  });

  it('an in-progress phase with todo and in-progress tasks is in-progress', () => {
    expect(
      phaseTone({
        status: 'in-progress',
        tasksTotal: 3,
        statusCounts: counts({ todo: 1, inProgress: 1, done: 1 }),
      }),
    ).toBe('in-progress');
  });

  it('a completed phase with a task still in review is done', () => {
    expect(
      phaseTone({
        status: 'completed',
        tasksTotal: 2,
        statusCounts: counts({ done: 1, review: 1 }),
      }),
    ).toBe('done');
  });

  it('a planned phase with a task in progress is todo', () => {
    expect(
      phaseTone({
        status: 'planned',
        tasksTotal: 2,
        statusCounts: counts({ inProgress: 1, todo: 1 }),
      }),
    ).toBe('todo');
  });

  it('phaseStatusFromCounts still mirrors the server fold (its todo for no counts stays right)', () => {
    expect(phaseStatusFromCounts(counts({}), 0)).toBe('todo');
    expect(phaseStatusFromCounts(counts({ done: 2 }), 2)).toBe('done');
  });

  it('phaseStatusFromCounts reads some done with the rest to do as in progress, like the server fold', () => {
    expect(phaseStatusFromCounts(counts({ done: 1, todo: 1 }), 2)).toBe('in_progress');
    expect(phaseStatusFromCounts(counts({ done: 1, todo: 1, superseded: 1 }), 3)).toBe(
      'in_progress',
    );
    expect(phaseStatusFromCounts(counts({ todo: 2 }), 2)).toBe('todo');
  });

  it('a not-scheduled row still has no bar', () => {
    const lane = buildSwimlane([milestone({})], NOW);
    expect(lane.rows[0]?.bar).toBeNull();
  });
});
