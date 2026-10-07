import type { Page } from '@playwright/test';
import type { ActiveScopeResult } from '../src/lib/api.js';
import { FIXTURE_NOW_ISO } from './fixtureClock.js';

/** The `/api/active-scope` answer a stub serves: `activeEpics` are the epics a live CLI session drives. */
export function activeScopeBody(
  activeEpics: string[],
  over: Partial<ActiveScopeResult> = {},
): ActiveScopeResult {
  return {
    measured: true,
    readAt: FIXTURE_NOW_ISO,
    liveSessions: activeEpics.length,
    unlinkedSessions: 0,
    projects: [],
    epics: activeEpics.map((epicId) => ({ storeId: 'home', epicId, project: null })),
    factorySessions: [],
    ...over,
  };
}

// Pages follow the Active/All scope (`?scope=`). Which epics a live CLI session
// drives is not something the fixture db can say, so the answer is stubbed.
export async function stubActiveScope(
  page: Page,
  activeEpics: string[],
  over: Partial<ActiveScopeResult> = {},
) {
  const body = activeScopeBody(activeEpics, over);
  await page.route('**/api/active-scope*', (route) => route.fulfill({ json: body }));
}
