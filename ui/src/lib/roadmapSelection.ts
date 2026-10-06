// DS4 S2 — the swimlane's default-selection rule (signed-off spec §2), pure
// so RoadmapPage.vue is just wiring. The URL's own `?phase=`/`?epic=` always
// overrides the computed default. Otherwise (UI spec Part 2): the current
// lane of the first project section (`buildRoadmapSections` order, running
// first) — the phase holding an actively running epic, else the first
// declared phase by `sequence` that is not completed, else the last phase;
// and a no-phase project's actively running epic, else its first selectable.
import type { MilestoneProgress } from './api.js';
import { buildRoadmapSections } from './roadmapWindow.js';

export interface RoadmapSelection {
  phaseId: string | null;
  epicId: string | null;
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
    const first = buildRoadmapSections(milestones, [], activeEpics, undefined, null)[0];
    const current = first?.kind === 'phase' ? first.window.current : null;
    return { phaseId: current ? current.milestoneId : null, epicId: null };
  }

  const running = selectableEpics.find((e) => activeEpics.includes(e));
  return { phaseId: null, epicId: running ?? selectableEpics[0] ?? null };
}
