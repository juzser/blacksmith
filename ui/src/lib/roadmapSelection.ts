// DS4 S2 — the swimlane's default-selection rule (signed-off spec §2), pure
// so RoadmapPage.vue is just wiring. The URL's own `?phase=`/`?epic=` always
// overrides the computed default. Otherwise (UI spec Part 2): the current
// lane of the first project section (`buildRoadmapSections` order, running
// first) — the phase holding an actively running epic, else the first
// declared phase by `sequence` that is not completed, else the last phase;
// and a no-phase project's actively running epic, else its first selectable.
import type { ActiveScopeResult, MilestoneProgress, ProjectOverviewSummary } from './api.js';
import { buildRoadmapSections, filterActiveSections } from './roadmapWindow.js';

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
  /** The page's own section inputs, so the default lands in the section shown first. */
  overviewProjects?: readonly ProjectOverviewSummary[],
  projectFilter: string | null = null,
  /** Under Active: the scope answer, so the default lands in a section that survives the filter. */
  activeScope: ActiveScopeResult | null = null,
): RoadmapSelection {
  if (routeQuery.phase) return { phaseId: routeQuery.phase, epicId: null };
  if (routeQuery.epic) return { phaseId: null, epicId: routeQuery.epic };

  const first = filterActiveSections(
    buildRoadmapSections(
      milestones,
      selectableEpics,
      activeEpics,
      projectFilter ? undefined : overviewProjects,
      projectFilter,
    ),
    activeScope,
  )[0];
  if (first?.kind === 'phase') {
    return { phaseId: first.window.current?.milestoneId ?? null, epicId: null };
  }
  return { phaseId: null, epicId: first?.window.current ?? null };
}
