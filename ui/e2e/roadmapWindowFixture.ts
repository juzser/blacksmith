// UI spec Part 2 — a roadmap long enough to window. The shared fixture
// (global-setup.ts) declares one phase per project, so no window ever hides a
// lane there; this stub replaces `/api/roadmap` with two neutral projects:
// project-a's 8 phases with the 4th current (phase-1/2 hidden earlier,
// phase-7/8 hidden later), and project-b's 2 phases (nothing hidden).
// `/api/overview`'s per-project summaries are emptied too, so the fixture's
// own projects do not come back as phase-less epic sections around the stub.
import type { Page } from '@playwright/test';
import type { ActiveScopeResult } from '../src/lib/api.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';

interface StubPhase {
  milestoneId: string;
  project: string;
  sequence: number;
  status: 'planned' | 'in-progress' | 'completed';
  startedAt: string | null;
  finishedAt: string | null;
}

const ZERO_COUNTS = { done: 0, review: 0, inProgress: 0, todo: 0, superseded: 0 };

function phase(p: StubPhase) {
  return {
    ...p,
    name: `Phase ${p.milestoneId.replace('phase-', '')}`,
    goal: null,
    epicIds: [],
    tasksTotal: 0,
    tasksCompleted: 0,
    tokensSpent: 0,
    tokensBudget: null,
    unmeasured: 0,
    kind: 'product',
    epics: [],
    statusCounts: ZERO_COUNTS,
  };
}

// Dates sit before the pinned clock (fixtureClock.ts, 2026-01-15), so the
// done lanes read past and phase-4 reads now.
export const WINDOW_ROADMAP = [
  phase({
    milestoneId: 'phase-1',
    project: 'project-a',
    sequence: 1,
    status: 'completed',
    startedAt: '2025-11-03T09:00:00.000Z',
    finishedAt: '2025-11-21T09:00:00.000Z',
  }),
  phase({
    milestoneId: 'phase-2',
    project: 'project-a',
    sequence: 2,
    status: 'completed',
    startedAt: '2025-11-24T09:00:00.000Z',
    finishedAt: '2025-12-12T09:00:00.000Z',
  }),
  phase({
    milestoneId: 'phase-3',
    project: 'project-a',
    sequence: 3,
    status: 'completed',
    startedAt: '2025-12-15T09:00:00.000Z',
    finishedAt: '2026-01-02T09:00:00.000Z',
  }),
  phase({
    milestoneId: 'phase-4',
    project: 'project-a',
    sequence: 4,
    status: 'in-progress',
    startedAt: '2026-01-05T09:00:00.000Z',
    finishedAt: null,
  }),
  phase({
    milestoneId: 'phase-5',
    project: 'project-a',
    sequence: 5,
    status: 'planned',
    startedAt: null,
    finishedAt: null,
  }),
  phase({
    milestoneId: 'phase-6',
    project: 'project-a',
    sequence: 6,
    status: 'planned',
    startedAt: null,
    finishedAt: null,
  }),
  phase({
    milestoneId: 'phase-7',
    project: 'project-a',
    sequence: 7,
    status: 'planned',
    startedAt: null,
    finishedAt: null,
  }),
  phase({
    milestoneId: 'phase-8',
    project: 'project-a',
    sequence: 8,
    status: 'planned',
    startedAt: null,
    finishedAt: null,
  }),
  phase({
    milestoneId: 'phase-9',
    project: 'project-b',
    sequence: 1,
    status: 'completed',
    startedAt: '2025-10-06T09:00:00.000Z',
    finishedAt: '2025-10-24T09:00:00.000Z',
  }),
  phase({
    milestoneId: 'phase-10',
    project: 'project-b',
    sequence: 2,
    status: 'planned',
    startedAt: null,
    finishedAt: null,
  }),
];

export async function stubWindowRoadmap(page: Page): Promise<void> {
  await page.route('**/api/roadmap**', (route) => route.fulfill({ json: WINDOW_ROADMAP }));
  await page.route('**/api/overview**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.projects = [];
    await route.fulfill({ response, json: body });
  });
}

// `/api/active-scope` as the Roadmap's Active view reads it. The e2e server has
// no CLI session registry, so unstubbed it answers "unmeasured"; a test that
// needs a measured answer says which projects a live session is on.
export async function stubActiveScope(
  page: Page,
  activeProjects: string[] = [],
  over: Partial<ActiveScopeResult> = {},
  delayMs = 0,
): Promise<void> {
  const body: ActiveScopeResult = {
    measured: true,
    readAt: FIXTURE_NOW_ISO,
    liveSessions: Math.max(1, activeProjects.length),
    unlinkedSessions: 0,
    projects: activeProjects.map((project) => ({
      storeId: 'home',
      project,
      liveSessions: 1,
      agentsWorking: 0,
    })),
    epics: [],
    factorySessions: [{ storeId: 'home', sessionId: 'session-a' }],
    ...over,
  };
  await page.route('**/api/active-scope*', async (route) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ json: body });
  });
}
