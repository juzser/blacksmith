import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActiveScopeResult, MilestoneProgress } from '../src/lib/api.js';
import { shortTaskName } from '../src/lib/format.js';
import {
  buildRoadmapSections,
  isLiveEpic,
  liveEntrySection,
  liveEpicKeys,
  pageHasLive,
  type RoadmapSection,
  sectionSwimlane,
} from '../src/lib/roadmapWindow.js';
import { waveLabel } from '../src/lib/waveList.js';

// Every live epic is "Current" on the Roadmap, and its running wave opens.
// The window cut still follows currentLaneIndex; only the marks widen.

function scope(
  epics: Array<{ storeId: string; epicId: string }>,
  measured = true,
): ActiveScopeResult {
  return {
    measured,
    readAt: '2026-01-15T00:00:00.000Z',
    liveSessions: epics.length,
    unlinkedSessions: 0,
    projects: [],
    epics: epics.map((e) => ({ ...e, project: null })),
    factorySessions: [],
  };
}

function phase(n: number, epicIds: string[] = []): MilestoneProgress {
  return {
    milestoneId: `phase-${n}`,
    name: `Phase ${n}`,
    sequence: n,
    status: n <= 3 ? 'completed' : 'planned',
    project: 'project-a',
    epicIds,
    epics: [],
    statusCounts: {},
    startedAt: null,
    finishedAt: null,
  } as unknown as MilestoneProgress;
}

const NOW = new Date('2026-01-15T00:00:00.000Z');
const OPEN = { earlier: false, later: false };

function section(lanes: MilestoneProgress[]): RoadmapSection {
  const s = buildRoadmapSections(lanes, [], [], undefined, null)[0];
  if (!s) throw new Error('no section');
  return s;
}

describe('liveEpicKeys', () => {
  it('keys a live epic by store and id, so one id in two stores stays two keys', () => {
    const live = liveEpicKeys(
      scope([
        { storeId: 'store-a', epicId: 'epic-a' },
        { storeId: 'store-b', epicId: 'epic-a' },
      ]),
    );
    expect(live.known).toBe(true);
    expect(live.keys.size).toBe(2);
  });

  it('matches only the store that holds the live epic', () => {
    const live = liveEpicKeys(scope([{ storeId: 'store-b', epicId: 'epic-a' }]));
    expect(isLiveEpic(live, 'store-b', 'epic-a')).toBe(true);
    expect(isLiveEpic(live, 'store-a', 'epic-a')).toBe(false);
    expect(isLiveEpic(live, 'store-a', 'epic-a', true)).toBe(true);
  });

  it('says unknown, not an empty live set, for an unmeasured or missing read', () => {
    expect(liveEpicKeys(scope([], false)).known).toBe(false);
    expect(liveEpicKeys(null).known).toBe(false);
    expect(liveEpicKeys(scope([])).known).toBe(true);
  });
});

describe('waveLabel', () => {
  const wave = { index: 1, total: 4, doneCount: 3, taskCount: 5 };

  it('spells Wave N of M with the done count', () => {
    expect(waveLabel(wave)).toBe('Wave 2 of 4 · 3/5 done');
  });

  it('drops the total when it is unknown, and never prints a 0 total', () => {
    expect(waveLabel({ ...wave, total: 0 })).toBe('Wave 2');
    expect(waveLabel({ index: 1 })).toBe('Wave 2');
    expect(waveLabel({ ...wave, total: 0 })).not.toMatch(/of 0/);
  });

  it('says Running, with no numbers, when no wave is known', () => {
    expect(waveLabel(null)).toBe('Running');
    expect(waveLabel({})).toBe('Running');
  });
});

describe('Current marks follow every live epic', () => {
  const lanes = [
    phase(1),
    phase(2),
    phase(3),
    phase(4),
    phase(5, ['epic-a']),
    phase(6, ['epic-b']),
    phase(7),
    phase(8),
  ];

  it('marks both lanes when two epics of one section are live', () => {
    const live = liveEpicKeys(
      scope([
        { storeId: 'home', epicId: 'epic-a' },
        { storeId: 'home', epicId: 'epic-b' },
      ]),
    );
    const view = sectionSwimlane(section(lanes), OPEN, NOW, live);
    expect(view.currentLanes).toEqual(['phase-5', 'phase-6']);
    expect(view.liveEpics).toEqual(['epic-a', 'epic-b']);
  });

  it('ignores a live epic of another store', () => {
    const live = liveEpicKeys(scope([{ storeId: 'store-b', epicId: 'epic-a' }]));
    const view = sectionSwimlane(section(lanes), OPEN, NOW, live);
    expect(view.currentLanes).toEqual([view.currentLane]);
  });

  it('keeps the single currentLaneIndex mark when nothing is live', () => {
    const live = liveEpicKeys(scope([]));
    const view = sectionSwimlane(section(lanes), OPEN, NOW, live);
    expect(view.currentLanes).toEqual(['phase-4']);
    expect(view.liveEpics).toEqual([]);
  });

  it('keeps the single mark when the read is unmeasured', () => {
    const live = liveEpicKeys(scope([{ storeId: 'home', epicId: 'epic-a' }], false));
    const view = sectionSwimlane(section(lanes), OPEN, NOW, live);
    expect(view.currentLanes).toEqual(['phase-4']);
  });
});

function inStore(m: MilestoneProgress, id: string, project: string): MilestoneProgress {
  return { ...m, project, store: { id, label: id } } as MilestoneProgress;
}

const OPEN_ALL = { earlier: true, later: true };

describe('one Current rule for the whole page', () => {
  const a = [1, 2, 3, 4, 5].map((n) =>
    inStore(phase(n, n === 5 ? ['epic-a'] : []), 'store-a', 'project-a'),
  );
  const b = [1, 2, 3, 4, 5].map((n) => inStore(phase(n), 'store-b', 'project-b'));
  const sections = () => buildRoadmapSections([...a, ...b], [], [], undefined, null);
  const byProject = (name: string) => {
    const s = sections().find((x) => x.project === name);
    if (!s) throw new Error('no section');
    return s;
  };

  it('marks nothing in a section with no live epic once any epic on the page is live', () => {
    const live = liveEpicKeys(scope([{ storeId: 'store-a', epicId: 'epic-a' }]));
    const pageLive = pageHasLive(sections(), live);
    expect(pageLive).toBe(true);
    const va = sectionSwimlane(byProject('project-a'), OPEN_ALL, NOW, live, pageLive);
    const vb = sectionSwimlane(byProject('project-b'), OPEN_ALL, NOW, live, pageLive);
    expect(va.currentLanes).toEqual(['phase-5']);
    expect(vb.currentLanes).toEqual([]);
  });

  it('keeps each section single Current mark when nothing on the page is live', () => {
    const live = liveEpicKeys(scope([]));
    expect(pageHasLive(sections(), live)).toBe(false);
    for (const name of ['project-a', 'project-b']) {
      const v = sectionSwimlane(byProject(name), OPEN_ALL, NOW, live, false);
      expect(v.currentLanes).toEqual([v.currentLane]);
      expect(v.currentLane).not.toBeNull();
    }
  });

  it('reads an unmeasured read as no live epic', () => {
    const live = liveEpicKeys(scope([{ storeId: 'store-a', epicId: 'epic-a' }], false));
    expect(pageHasLive(sections(), live)).toBe(false);
  });

  it('counts a live epic in a lane behind a closed disclosure, so no visible lane takes the mark', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      inStore(phase(n, n === 1 ? ['epic-a'] : []), 'store-a', 'project-a'),
    );
    const s = buildRoadmapSections(many, [], [], undefined, null)[0] as RoadmapSection;
    const live = liveEpicKeys(scope([{ storeId: 'store-a', epicId: 'epic-a' }]));
    const pageLive = pageHasLive([s], live);
    expect(pageLive).toBe(true);
    const closed = sectionSwimlane(s, { earlier: false, later: false }, NOW, live, pageLive);
    expect(closed.currentLanes).toEqual([]);
    const open = sectionSwimlane(s, OPEN_ALL, NOW, live, pageLive);
    expect(open.currentLanes).toEqual(['phase-1']);
  });
});

describe('a live epic is keyed by its own store in a merged section', () => {
  const epicOnly = () => buildRoadmapSections([], ['epic-a', 'epic-x'], [], undefined, null);

  it('finds the merged section for a foreign store live epic', () => {
    const found = liveEntrySection(epicOnly(), { storeId: 'store-b', epicId: 'epic-a' });
    expect(found?.kind).toBe('epic');
  });

  it('still refuses a store-bound section of another store', () => {
    const sections = buildRoadmapSections(
      [inStore(phase(1, ['epic-a']), 'store-a', 'project-a')],
      [],
      [],
      undefined,
      null,
    );
    expect(liveEntrySection(sections, { storeId: 'store-b', epicId: 'epic-a' })).toBeUndefined();
    expect(liveEntrySection(sections, { storeId: 'store-a', epicId: 'epic-a' })).toBeDefined();
  });
});

describe('WaveTaskCard name', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'WaveTaskCard.vue'),
    'utf8',
  );

  it('reads a plan id as its slug label and a minted id as Follow-up fix', () => {
    expect(shortTaskName('epic-a/task-3-wire-the-gate')).toBe('Wire the gate');
    expect(shortTaskName('epic-a/followup-1a2b3c4d')).toBe('Follow-up fix');
  });

  it('names the card from the id alone, never from the objective in title', () => {
    expect(SRC).toMatch(/shortTaskName\(props\.task\.taskId\)/);
    expect(SRC).not.toMatch(/props\.task\.title/);
    expect(SRC).not.toMatch(/taskLabel/);
  });
});
