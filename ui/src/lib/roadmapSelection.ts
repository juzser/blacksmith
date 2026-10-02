// DS4 S2 — the swimlane's default-selection rule (signed-off spec §2), pure
// so RoadmapPage.vue is just wiring. Order: (1) the phase holding an actively
// running epic, (2) the most recent phase otherwise, (3) a no-phase project's
// in-progress epic (else its most recent), with the URL's own `?phase=`/
// `?epic=` always overriding the computed default.
import type { MilestoneProgress } from './api.js';

export interface RoadmapSelection {
  phaseId: string | null;
  epicId: string | null;
}

function byRecency(a: MilestoneProgress, b: MilestoneProgress): number {
  const at = a.startedAt !== null ? Date.parse(a.startedAt) : -Infinity;
  const bt = b.startedAt !== null ? Date.parse(b.startedAt) : -Infinity;
  if (at !== bt) return bt - at;
  return b.sequence - a.sequence;
}

export function defaultSelection(
  milestones: MilestoneProgress[],
  /** `overview.epicsActivelyRunning` — picks the phase to default to. */
  activeEpics: readonly string[],
  /** `selectableEpics(overview)` — in-flight epics first, then closed, newest first; the no-phase fallback. */
  selectableEpics: readonly string[],
  routeQuery: { phase?: string | null; epic?: string | null },
): RoadmapSelection {
  if (routeQuery.phase) return { phaseId: routeQuery.phase, epicId: null };
  if (routeQuery.epic) return { phaseId: null, epicId: routeQuery.epic };

  if (milestones.length > 0) {
    const running = milestones.find((m) => m.epicIds.some((e) => activeEpics.includes(e)));
    const chosen = running ?? [...milestones].sort(byRecency)[0];
    return { phaseId: chosen ? chosen.milestoneId : null, epicId: null };
  }

  return { phaseId: null, epicId: selectableEpics[0] ?? null };
}
