import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages');
const componentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');
const SFC = readFileSync(join(pagesDir, 'RoadmapPage.vue'), 'utf8');
const EPIC_BLOCK = readFileSync(join(componentsDir, 'EpicBlock.vue'), 'utf8');

// Fix round 4 #1: an epic-only project (no milestones) fell through to a
// fabricated `taskCountLabel(0, 0)` for its default-selected epic, reading
// "No tasks tracked" even when that epic has 2 of 3 tasks done. The real
// counts must come from the epic's own flow fetch, with a loading state
// while that flow is still in flight.
//
// DS4 S3 moved the loading/zero-task/count rendering for the selected epic
// out of RoadmapPage.vue and into EpicBlock's epic-mode branch (spec §1), so
// the guard now spans both files: the page supplies real counts, the
// component renders the loading/zero-task states from them.
describe('RoadmapPage.vue — standalone-epic task count (fix round 4 #1)', () => {
  it('never fabricates a zero-task label for the selected epic', () => {
    expect(SFC).not.toMatch(/taskCountLabel\(0,\s*0\)/);
  });

  it('reads the selected epic tasks from its own flow fetch, not a fabricated default', () => {
    expect(SFC).toMatch(/const selectedEpicData = computed/);
    expect(SFC).toMatch(/epicModeFlow\.value/);
    expect(SFC).toMatch(/tasksTotal: flow\.nodes\.length/);
  });

  it('shows a loading state before the flow resolves, not an empty-state guess', () => {
    expect(SFC).toMatch(/loading: true/);
    expect(EPIC_BLOCK).toMatch(/<Skeleton v-if="epic\.loading"/);
  });

  it('only renders "No tasks tracked" once the flow really has zero tasks', () => {
    expect(EPIC_BLOCK).toMatch(/epic\.tasksTotal === 0/);
    expect(EPIC_BLOCK).toMatch(/No tasks tracked/);
  });
});
