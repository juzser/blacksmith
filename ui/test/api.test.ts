import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ClosedEpic,
  fetchAnalytics,
  fetchErrors,
  fetchTimelinePage,
  type OverviewResult,
  selectableEpics,
} from '../src/lib/api.js';

// D-43/P9-27: closing an epic drops it out of `epicsInFlight` by design.
// The picker on Kanban/Flow is how an operator reaches a board at all, so a
// just-closed epic must stay selectable — otherwise recording the close makes
// the epic's own history unreachable, which is a worse bug than the one fixed.
function closed(epicId: string, closedAt: string): ClosedEpic {
  return {
    epicId,
    closedBy: 'verdict',
    machineVerdict: 'go',
    machineReason: null,
    overrideRationale: null,
    blockers: [],
    closedAt,
  };
}

function overview(epicsInFlight: string[], closedEpics: ClosedEpic[]): OverviewResult {
  return {
    liveAgents: [],
    liveAgentEntries: [],
    liveAgentCount: 0,
    workingAgentCount: 0,
    stalledAgentCount: 0,
    runningSessions: [],
    epicsInFlight,
    epicsActivelyRunning: epicsInFlight,
    epicsIdle: [],
    closedEpics,
    tokensByEpic: [],
    alerts: { escalations: 0, pendingWaivers: 0 },
    milestoneProgress: [],
    recentDispatches: [],
    liveAgentCountDelta5m: 0,
    workingAgentCountDelta5m: 0,
    budgetUsedPctPointDelta1h: null,
  };
}

describe('lib/api.ts — selectableEpics (D-43/P9-27)', () => {
  it('lists running epics before idle ones, each in overview order, then closed', () => {
    const ov = overview(
      ['epic-idle-1', 'epic-run', 'epic-idle-2', 'epic-run-2'],
      [closed('epic-done', '2026-08-07T00:00:00.000Z')],
    );
    ov.epicsIdle = [
      { epicId: 'epic-idle-1', idleDays: 18 },
      { epicId: 'epic-idle-2', idleDays: 21 },
    ];
    expect(selectableEpics(ov)).toEqual([
      'epic-run',
      'epic-run-2',
      'epic-idle-1',
      'epic-idle-2',
      'epic-done',
    ]);
  });

  it('keeps a closed epic selectable, after the ones still in flight', () => {
    const ov = overview(['epic-b', 'epic-a'], [closed('epic-done', '2026-08-07T00:00:00.000Z')]);
    expect(selectableEpics(ov)).toEqual(['epic-b', 'epic-a', 'epic-done']);
  });

  it('lists closed epics newest first and never twice', () => {
    const ov = overview(
      ['epic-a'],
      [
        closed('epic-late', '2026-08-07T00:00:00.000Z'),
        closed('epic-early', '2026-08-01T00:00:00.000Z'),
      ],
    );
    expect(selectableEpics(ov)).toEqual(['epic-a', 'epic-late', 'epic-early']);
  });

  it('does not repeat an epic that is both closed and still holding work', () => {
    const ov = overview(['epic-a'], [closed('epic-a', '2026-08-07T00:00:00.000Z')]);
    expect(selectableEpics(ov)).toEqual(['epic-a']);
  });

  it('tolerates an overview from a server that predates closedEpics', () => {
    // The field is required on today's contract, so an older server's payload
    // can only be spelled by taking it back off — that missing field is the
    // whole subject of this test, not a convenience of writing it.
    const ov = overview(['epic-a'], []) as Omit<OverviewResult, 'closedEpics'> & {
      closedEpics?: ClosedEpic[];
    };
    ov.closedEpics = undefined;
    expect(selectableEpics(ov as OverviewResult)).toEqual(['epic-a']);
  });
});

describe('S9: the sessions list on the Activity and Cost & quality fetches', () => {
  const urls: string[] = [];
  const stub = () => {
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(u);
        return { ok: true, json: async () => ({}) };
      }),
    );
  };
  afterEach(() => vi.unstubAllGlobals());

  it('writes one sessions= per id, keeps a comma in an id, and omits the param when undefined', async () => {
    stub();
    await fetchTimelinePage({ limit: 5, sessions: ['sess-a', 'sess-c,x'] });
    await fetchErrors(undefined, undefined, ['sess-a', 'sess-b']);
    await fetchAnalytics(undefined, undefined, '30d', ['sess-a']);
    await fetchTimelinePage({ limit: 5 });
    await fetchErrors();
    await fetchAnalytics(undefined, undefined, '30d');
    const q = (u: string) => new URL(u, 'http://x').searchParams;
    expect(q(urls[0] as string).getAll('sessions')).toEqual(['sess-a', 'sess-c,x']);
    expect(q(urls[1] as string).getAll('sessions')).toEqual(['sess-a', 'sess-b']);
    expect(q(urls[2] as string).getAll('sessions')).toEqual(['sess-a']);
    for (const u of urls.slice(3)) expect(u).not.toContain('sessions');
  });
});
