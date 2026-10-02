import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'RoadmapPage.vue'),
  'utf8',
);

// Fix round 4 #1: an epic-only project (no milestones) fell through to a
// fabricated `taskCountLabel(0, 0)` for its default-selected epic, reading
// "No tasks tracked" even when that epic has 2 of 3 tasks done. The real
// counts must come from the same `epicFlows` source `epicSections` reads,
// with a loading state while that epic's own flow is still in flight.
describe('RoadmapPage.vue — standalone-epic task count (fix round 4 #1)', () => {
  it('never fabricates a zero-task label for the selected epic', () => {
    expect(SFC).not.toMatch(/taskCountLabel\(0,\s*0\)/);
  });

  it('reads the selected epic tasks from epicFlows, the same source epicSections uses', () => {
    expect(SFC).toMatch(/const selectedEpicData = computed/);
    expect(SFC).toMatch(/epicFlows\.value\.get\(selectedEpic\.value\)/);
  });

  it('shows a loading state before the flow resolves, not an empty-state guess', () => {
    expect(SFC).toMatch(/selectedEpicData\.loading/);
    expect(SFC).toMatch(/<Skeleton v-if="selectedEpicData\.loading"/);
  });

  it('only renders "No tasks tracked" once the flow really has zero tasks', () => {
    expect(SFC).toMatch(/selectedEpicData\.total > 0/);
    expect(SFC).toMatch(/'No tasks tracked'/);
  });
});
