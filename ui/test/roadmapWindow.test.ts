import { describe, expect, it } from 'vitest';
import type {
  ActiveScopeResult,
  EpicDates,
  MilestoneProgress,
  ProjectOverviewSummary,
} from '../src/lib/api.js';
import {
  buildRoadmapSections,
  currentLaneIndex,
  cutWindow,
  disclosureLabel,
  doneCountLabel,
  filterActiveSections,
  groupByProject,
  laneOptions,
  type RoadmapSection,
  sectionHolds,
  sectionSwimlane,
  selectionSide,
  windowExpandId,
  windowPickerId,
  windowRegionId,
} from '../src/lib/roadmapWindow.js';

// UI spec Part 2 — the roadmap split by project and windowed to the recent
// lanes: 1 before the current lane, the current lane, and the 2 after it.
function milestone(overrides: Partial<MilestoneProgress>): MilestoneProgress {
  return {
    milestoneId: 'phase-1',
    name: 'Phase 1',
    status: 'planned',
    sequence: 1,
    goal: null,
    epicIds: [],
    tasksTotal: 0,
    tasksCompleted: 0,
    tokensSpent: 0,
    tokensBudget: null,
    unmeasured: 0,
    project: 'project-a',
    kind: 'product',
    startedAt: null,
    finishedAt: null,
    epics: [],
    statusCounts: { done: 0, review: 0, inProgress: 0, todo: 0, superseded: 0 },
    ...overrides,
  };
}

function epicDates(overrides: Partial<EpicDates>): EpicDates {
  return {
    epicId: 'epic-a',
    startedAt: null,
    finishedAt: null,
    statusCounts: { done: 0, review: 0, inProgress: 0, todo: 0, superseded: 0 },
    status: 'todo',
    project: 'project-a',
    prUrl: null,
    sourcePrompt: null,
    ...overrides,
  };
}

/** `count` phases of one project, `phase-1`..`phase-N`, the first `done` completed. */
function lanes(count: number, done: number, project = 'project-a'): MilestoneProgress[] {
  return Array.from({ length: count }, (_, i) =>
    milestone({
      milestoneId: `phase-${i + 1}`,
      name: `Phase ${i + 1}`,
      sequence: i + 1,
      status: i < done ? 'completed' : 'planned',
      project,
    }),
  );
}

function summary(project: string, epicsInFlight: string[]): ProjectOverviewSummary {
  return {
    project,
    liveAgentCount: 0,
    workingAgentCount: 0,
    epicsInFlight,
    epicsActivelyRunning: [],
    epicsIdle: [],
    tokensByEpic: [],
    tokensSpent: 0,
    tokensBudget: null,
    unmeasured: 0,
    alerts: { escalations: 0, pendingWaivers: 0 },
  };
}

const ids = (ms: readonly MilestoneProgress[]) => ms.map((m) => m.milestoneId);

function phaseSection(section: RoadmapSection | undefined) {
  if (section?.kind !== 'phase') throw new Error('expected a phase section');
  return section;
}

describe('currentLaneIndex — the operator\'s "current lane" rule', () => {
  it('picks the lane holding an actively running epic, even past an open one', () => {
    const ls = lanes(5, 1).map((l, i) => (i === 3 ? { ...l, epicIds: ['epic-a'] } : l));
    expect(currentLaneIndex(ls, ['epic-a'])).toEqual({ index: 3, allDone: false });
  });

  it('falls back to the first lane by sequence that is not completed', () => {
    expect(currentLaneIndex(lanes(5, 2), [])).toEqual({ index: 2, allDone: false });
  });

  it('ignores an in-flight epic that is not actively running', () => {
    const ls = lanes(4, 1).map((l, i) => (i === 3 ? { ...l, epicIds: ['epic-a'] } : l));
    expect(currentLaneIndex(ls, ['epic-b'])).toEqual({ index: 1, allDone: false });
  });

  it('reads every lane done as the last lane, flagged all-done', () => {
    expect(currentLaneIndex(lanes(3, 3), [])).toEqual({ index: 2, allDone: true });
  });

  it('has no current lane when there are no lanes', () => {
    expect(currentLaneIndex([], [])).toEqual({ index: -1, allDone: false });
  });
});

describe('cutWindow — 1 before + current + 2 after', () => {
  it('hides both sides around a lane in the middle', () => {
    const w = cutWindow(lanes(8, 3), { index: 3, allDone: false });
    expect(ids(w.earlier)).toEqual(['phase-1', 'phase-2']);
    expect(ids(w.visible)).toEqual(['phase-3', 'phase-4', 'phase-5', 'phase-6']);
    expect(ids(w.later)).toEqual(['phase-7', 'phase-8']);
    expect(w.current?.milestoneId).toBe('phase-4');
  });

  it('has no earlier side when the current lane is the first', () => {
    const w = cutWindow(lanes(6, 0), { index: 0, allDone: false });
    expect(w.earlier).toEqual([]);
    expect(ids(w.visible)).toEqual(['phase-1', 'phase-2', 'phase-3']);
    expect(ids(w.later)).toEqual(['phase-4', 'phase-5', 'phase-6']);
  });

  it('shows what exists when fewer than 2 lanes follow, and never pads', () => {
    const w = cutWindow(lanes(5, 4), { index: 4, allDone: false });
    expect(ids(w.earlier)).toEqual(['phase-1', 'phase-2', 'phase-3']);
    expect(ids(w.visible)).toEqual(['phase-4', 'phase-5']);
    expect(w.later).toEqual([]);
  });

  it('keeps only the last lane when all are done, with no later side', () => {
    const w = cutWindow(lanes(4, 4), { index: 3, allDone: true });
    expect(ids(w.earlier)).toEqual(['phase-1', 'phase-2', 'phase-3']);
    expect(ids(w.visible)).toEqual(['phase-4']);
    expect(w.later).toEqual([]);
    expect(w.current?.milestoneId).toBe('phase-4');
  });

  it('is empty with no current lane', () => {
    expect(cutWindow([], { index: -1, allDone: false })).toEqual({
      earlier: [],
      visible: [],
      later: [],
      current: null,
    });
  });
});

describe("disclosureLabel — the two controls' exact copy", () => {
  it('counts the hidden lanes, singular for one', () => {
    expect(disclosureLabel('earlier', 8, false)).toBe('Show 8 earlier lanes');
    expect(disclosureLabel('earlier', 1, false)).toBe('Show 1 earlier lane');
    expect(disclosureLabel('later', 12, false)).toBe('Show 12 later lanes');
    expect(disclosureLabel('later', 1, false)).toBe('Show 1 later lane');
  });

  it('flips to "Show fewer" once expanded', () => {
    expect(disclosureLabel('earlier', 8, true)).toBe('Show fewer earlier lanes');
    expect(disclosureLabel('later', 1, true)).toBe('Show fewer later lanes');
  });
});

describe('doneCountLabel — the section heading count', () => {
  it('counts completed phases', () => {
    expect(doneCountLabel(lanes(25, 3))).toBe('3 of 25 phases done');
  });

  it('reads "All N phases done" when every phase is done', () => {
    expect(doneCountLabel(lanes(25, 25))).toBe('All 25 phases done');
  });

  it('is singular for one phase', () => {
    expect(doneCountLabel(lanes(1, 0))).toBe('0 of 1 phase done');
  });

  it('is absent with no phases — never "0 of 0"', () => {
    expect(doneCountLabel([])).toBeNull();
  });
});

describe('groupByProject', () => {
  it("splits by project and sorts each project's lanes by sequence", () => {
    const groups = groupByProject([
      milestone({ milestoneId: 'phase-3', sequence: 3, project: 'project-a' }),
      milestone({ milestoneId: 'phase-9', sequence: 9, project: 'project-b' }),
      milestone({ milestoneId: 'phase-1', sequence: 1, project: 'project-a' }),
    ]);
    expect(groups.map((g) => [g.project, ids(g.lanes)])).toEqual([
      ['project-a', ['phase-1', 'phase-3']],
      ['project-b', ['phase-9']],
    ]);
  });
});

describe('buildRoadmapSections — a label shared by two stores', () => {
  const rows = [
    milestone({
      milestoneId: 'phase-1',
      project: 'project-a',
      store: { id: 'store-a', label: 'checkout-a' },
    }),
    milestone({
      milestoneId: 'phase-1',
      project: 'project-a',
      store: { id: 'store-b', label: 'checkout-b' },
    }),
  ];

  it('keeps one section per store, named apart, each carrying its store', () => {
    const sections = buildRoadmapSections(rows, [], [], undefined, null);
    expect(sections.map((s) => [s.title, s.store?.id]).sort()).toEqual([
      ['project-a · checkout-a', 'store-a'],
      ['project-a · checkout-b', 'store-b'],
    ]);
    expect(new Set(sections.map((s) => s.key)).size).toBe(2);
  });

  it('leaves the title bare when the labels differ or there is no store', () => {
    const single = buildRoadmapSections(
      [milestone({ project: 'project-a' })],
      [],
      [],
      undefined,
      null,
    );
    expect(single.map((s) => [s.title, s.key, s.store])).toEqual([
      ['project-a', 'project-a', undefined],
    ]);
  });
});

describe('buildRoadmapSections — one section per project, in liveness order', () => {
  it('puts the project holding a running epic first', () => {
    const sections = buildRoadmapSections(
      [
        milestone({
          milestoneId: 'phase-1',
          project: 'project-a',
          startedAt: '2026-01-10T00:00:00.000Z',
        }),
        milestone({ milestoneId: 'phase-2', project: 'project-b', epicIds: ['epic-b'] }),
      ],
      [],
      ['epic-b'],
      undefined,
      null,
    );
    expect(sections.map((s) => s.project)).toEqual(['project-b', 'project-a']);
    expect(sections[0]?.running).toBe(true);
  });

  it('orders the rest by newest activity, then alphabetically', () => {
    const sections = buildRoadmapSections(
      [
        milestone({ milestoneId: 'phase-1', project: 'project-c' }),
        milestone({ milestoneId: 'phase-2', project: 'project-b' }),
        milestone({
          milestoneId: 'phase-3',
          project: 'project-a',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-02T00:00:00.000Z',
        }),
        milestone({
          milestoneId: 'phase-4',
          project: 'project-d',
          epics: [
            epicDates({
              epicId: 'epic-d',
              project: 'project-d',
              startedAt: '2026-01-05T00:00:00.000Z',
            }),
          ],
        }),
      ],
      [],
      [],
      undefined,
      null,
    );
    expect(sections.map((s) => s.project)).toEqual([
      'project-d',
      'project-a',
      'project-b',
      'project-c',
    ]);
  });

  it("cuts each project's own window and carries the heading count", () => {
    const section = phaseSection(buildRoadmapSections(lanes(8, 3), [], [], undefined, null)[0]);
    expect(section.title).toBe('project-a');
    expect(section.countLabel).toBe('3 of 8 phases done');
    expect(ids(section.window.visible)).toEqual(['phase-3', 'phase-4', 'phase-5', 'phase-6']);
    expect(section.window.current?.milestoneId).toBe('phase-4');
  });

  it('adds an epic section for an unscoped project that declares no phases', () => {
    const sections = buildRoadmapSections(
      lanes(2, 0),
      ['epic-a', 'epic-z'],
      [],
      [
        summary('project-a', ['epic-a']),
        summary('project-z', ['epic-z']),
        summary('project-y', []),
      ],
      null,
    );
    expect(sections.map((s) => [s.kind, s.project])).toEqual([
      ['phase', 'project-a'],
      ['epic', 'project-z'],
    ]);
  });

  it('shows the epic-only lanes as one section when nothing declares a phase', () => {
    const [section, ...rest] = buildRoadmapSections(
      [],
      ['epic-a', 'epic-b'],
      ['epic-b'],
      undefined,
      null,
    );
    expect(rest).toEqual([]);
    expect(section?.kind).toBe('epic');
    expect(section?.title).toBe('Epics');
    expect(section?.countLabel).toBeNull();
    expect(section?.window.current).toBe('epic-b');
    expect(section?.window.visible).toEqual(['epic-a', 'epic-b']);
  });

  it('windows the epic-only lanes only past 4 epics', () => {
    const epics = ['epic-a', 'epic-b', 'epic-c', 'epic-d', 'epic-e', 'epic-f'];
    const [section] = buildRoadmapSections([], epics, [], undefined, 'project-a');
    expect(section?.project).toBe('project-a');
    expect(section?.window.current).toBe('epic-a');
    expect(section?.window.visible).toEqual(['epic-a', 'epic-b', 'epic-c']);
    expect(section?.window.later).toEqual(['epic-d', 'epic-e', 'epic-f']);
  });

  it('has no sections at all with no phases and no epics', () => {
    expect(buildRoadmapSections([], [], [], undefined, null)).toEqual([]);
  });
});

describe('selectionSide — a deep link outside the window', () => {
  const section = phaseSection(
    buildRoadmapSections(
      lanes(8, 3).map((m) => (m.milestoneId === 'phase-8' ? { ...m, epicIds: ['epic-h'] } : m)),
      [],
      [],
      undefined,
      null,
    )[0],
  );

  it('reports the earlier side for a hidden earlier phase', () => {
    expect(selectionSide(section, { phaseId: 'phase-1', epicId: null })).toBe('earlier');
  });

  it('reports the later side for an epic whose phase is hidden later', () => {
    expect(selectionSide(section, { phaseId: null, epicId: 'epic-h' })).toBe('later');
  });

  it('is null inside the window or outside the section', () => {
    expect(selectionSide(section, { phaseId: 'phase-3', epicId: null })).toBeNull();
    expect(selectionSide(section, { phaseId: 'phase-99', epicId: null })).toBeNull();
  });

  it('knows which section holds a selection, hidden or not', () => {
    expect(sectionHolds(section, { phaseId: 'phase-1', epicId: null })).toBe(true);
    expect(sectionHolds(section, { phaseId: null, epicId: 'epic-h' })).toBe(true);
    expect(sectionHolds(section, { phaseId: 'phase-99', epicId: null })).toBe(false);
  });
});

describe('sectionSwimlane — only the shown lanes reach the swimlane', () => {
  const now = new Date('2026-01-15T00:00:00.000Z');
  const section = phaseSection(
    buildRoadmapSections(
      lanes(8, 3).map((m) => (m.milestoneId === 'phase-2' ? { ...m, epicIds: ['epic-b'] } : m)),
      [],
      [],
      undefined,
      null,
    )[0],
  );

  it('renders the window only while both sides are collapsed', () => {
    const view = sectionSwimlane(section, { earlier: false, later: false }, now);
    expect(view.swimlane.rows.map((r) => r.id)).toEqual([
      'phase-3',
      'phase-4',
      'phase-5',
      'phase-6',
    ]);
    expect(view.currentLane).toBe('phase-4');
    expect(view.regions.map((r) => [r.id, r.lanes.length])).toEqual([
      [windowRegionId('project-a', 'earlier'), 0],
      [null, 4],
      [windowRegionId('project-a', 'later'), 0],
    ]);
  });

  it("adds a side's lanes, with their epic rows, in place once expanded", () => {
    const view = sectionSwimlane(section, { earlier: true, later: false }, now);
    expect(view.swimlane.rows.map((r) => r.id)).toEqual([
      'phase-1',
      'phase-2',
      'epic-b',
      'phase-3',
      'phase-4',
      'phase-5',
      'phase-6',
    ]);
    const earlier = view.regions[0];
    expect(earlier?.lanes.map((l) => [l.head.id, l.rows.map((r) => r.id)])).toEqual([
      ['phase-1', ['phase-1']],
      ['phase-2', ['phase-2', 'epic-b']],
    ]);
  });

  it('lists the shown lanes for the phone picker', () => {
    const view = sectionSwimlane(section, { earlier: false, later: true }, now);
    expect(laneOptions(view.regions).map((o) => o.value)).toEqual([
      'phase-3',
      'phase-4',
      'phase-5',
      'phase-6',
      'phase-7',
      'phase-8',
    ]);
  });

  it('marks the current lane in the phone picker options', () => {
    const view = sectionSwimlane(section, { earlier: false, later: true }, now);
    const options = laneOptions(view.regions, view.currentLane);
    const current = options.filter((o) => o.label.endsWith(' (current)'));
    expect(current.map((o) => o.value)).toEqual([view.currentLane]);
  });

  it("omits a side's region when that side hides nothing", () => {
    const first = phaseSection(buildRoadmapSections(lanes(3, 0), [], [], undefined, null)[0]);
    const view = sectionSwimlane(first, { earlier: false, later: false }, now);
    expect(view.regions.map((r) => r.id)).toEqual([null]);
  });

  it('builds the epic-only swimlane for an epic section', () => {
    const [epicSection] = buildRoadmapSections([], ['epic-a', 'epic-b'], [], undefined, null);
    if (!epicSection) throw new Error('expected a section');
    const view = sectionSwimlane(epicSection, { earlier: false, later: false }, now);
    expect(view.swimlane.rows.map((r) => [r.kind, r.id])).toEqual([
      ['epic', 'epic-a'],
      ['epic', 'epic-b'],
    ]);
    expect(view.currentLane).toBe('epic-a');
  });
});

describe('window ids', () => {
  it('keys expand state per project and side', () => {
    expect(windowExpandId('project-a', 'earlier')).toBe('project-a:earlier');
    expect(windowExpandId('project-a', 'later')).toBe('project-a:later');
  });

  it('makes a DOM-safe region id from any project key', () => {
    expect(windowRegionId('project a/b', 'later')).toMatch(/^rm-window-[A-Za-z0-9_-]+-later$/);
  });

  it('names the phone picker the disclosures control there', () => {
    expect(windowPickerId('project a/b')).toMatch(/^rm-window-[A-Za-z0-9_-]+-picker$/);
  });

  it('keeps ids unique across keys that differ only in punctuation', () => {
    const ids = ['a.b', 'a-b', 'a b', 'a_b', 'epics', ''].flatMap((p) => [
      windowRegionId(p, 'earlier'),
      windowRegionId(p, 'later'),
      windowPickerId(p),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives the fallback Epics section a key no project name can take', () => {
    const [fallback] = buildRoadmapSections([], ['epic-a'], [], undefined, null);
    expect(fallback?.project).toBe('');
    expect(windowRegionId(fallback?.project ?? 'x', 'later')).not.toBe(
      windowRegionId('epics', 'later'),
    );
  });
});

// S7 — Active keeps only the sections a live CLI session is on; All, a null
// scope and an unmeasured one change nothing.
describe('filterActiveSections', () => {
  const scope = (over: Partial<ActiveScopeResult> = {}): ActiveScopeResult => ({
    measured: true,
    readAt: '2026-01-15T00:00:00.000Z',
    liveSessions: 2,
    unlinkedSessions: 0,
    projects: [
      { storeId: 'home', project: 'project-b', liveSessions: 1, agentsWorking: 0 },
      { storeId: 'other', project: 'project-c', liveSessions: 1, agentsWorking: 0 },
    ],
    epics: [],
    factorySessions: [],
    ...over,
  });
  const milestones = [
    milestone({
      milestoneId: 'a-1',
      project: 'project-a',
      epicIds: ['epic-a'],
      startedAt: '2026-01-10T00:00:00.000Z',
    }),
    milestone({ milestoneId: 'b-1', project: 'project-b', epicIds: ['epic-b'] }),
  ];
  const foreign = {
    project: 'project-c',
    epicsInFlight: ['epic-c'],
    epicsActivelyRunning: ['epic-c'],
  } as unknown as ProjectOverviewSummary;
  const all = buildRoadmapSections(milestones, [], [], [foreign], null);

  it('hides the idle project that sorts first under All', () => {
    expect(all[0]?.project).toBe('project-a');
    const shown = filterActiveSections(all, scope());
    expect(shown.map((s) => s.project)).toEqual(['project-b', 'project-c']);
  });

  it('returns the sections unchanged for a null or unmeasured scope', () => {
    expect(filterActiveSections(all, null)).toEqual(all);
    expect(filterActiveSections(all, scope({ measured: false, projects: [] }))).toEqual(all);
  });

  it('counts the phase-less "Epics" section active when one of its epics is', () => {
    const fallback = buildRoadmapSections([], ['epic-x', 'epic-y'], [], undefined, null);
    expect(filterActiveSections(fallback, scope())).toEqual([]);
    const withEpic = scope({ epics: [{ storeId: 'home', epicId: 'epic-y', project: null }] });
    expect(filterActiveSections(fallback, withEpic)).toEqual(fallback);
  });

  // Sessions' rule: a section the user is reading stays listed when its
  // project turns quiet, until another section is picked or the scope flips.
  it('keeps the named quiet section, in its place, when asked', () => {
    const shown = filterActiveSections(all, scope(), 'project-a');
    expect(shown.map((s) => s.project)).toEqual(['project-a', 'project-b', 'project-c']);
  });

  it('a kept project that is live, unknown or null changes nothing', () => {
    const plain = ['project-b', 'project-c'];
    expect(filterActiveSections(all, scope(), 'project-b').map((s) => s.project)).toEqual(plain);
    expect(filterActiveSections(all, scope(), 'project-z').map((s) => s.project)).toEqual(plain);
    expect(filterActiveSections(all, scope(), null).map((s) => s.project)).toEqual(plain);
  });

  it('an unmeasured scope still returns every section when a project is kept', () => {
    expect(filterActiveSections(all, scope({ measured: false }), 'project-a')).toEqual(all);
  });
});
