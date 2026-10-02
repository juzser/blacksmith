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

// DS4 S4 — phone Roadmap (<=640px), gated on isPhoneWidth throughout (spec
// "Gate" line). Source-text scrape, same convention as the block above: no
// DOM harness in this vitest config, so the actual rendering is exercised by
// ui/e2e/roadmapMobile.spec.ts instead.
describe('RoadmapPage.vue — phone branch (DS4 S4)', () => {
  it('imports useViewport and hides the swimlane on phone', () => {
    expect(SFC).toMatch(/useViewport/);
    expect(SFC).toMatch(/<RoadmapSwimlane\s+v-if="!isPhoneWidth"/);
  });

  it("shows a phase-picker Select on phone, over the swimlane's own phase rows (R4)", () => {
    expect(SFC).toMatch(/phaseOptions/);
    expect(SFC).toMatch(/isPhoneWidth && !selectedEpicData/);
  });

  it("derives each selected epic's phase for the back link (R1)", () => {
    expect(SFC).toMatch(/epicPhase\(/);
    expect(SFC).toMatch(/phase: epicPhase/);
  });
});

describe('EpicBlock.vue — phone branch (DS4 S4)', () => {
  it('renders the phone phase-mode list only under isPhoneWidth', () => {
    expect(EPIC_BLOCK).toMatch(/useViewport/);
    expect(EPIC_BLOCK).toMatch(/<template v-if="isPhoneWidth">/);
    expect(EPIC_BLOCK).toMatch(/bs-roadmap-mobile__row/);
  });

  it('a row tap emits selectEpic, not a RouterLink into the link (R6)', () => {
    expect(EPIC_BLOCK).toMatch(/selectEpic:\s*\[epicId: string\]/);
    expect(EPIC_BLOCK).toMatch(/emit\('selectEpic', sec\.epicId\)/);
  });

  it('the waves <details> is a sibling of the row, not nested in it (R6)', () => {
    const rowBody = EPIC_BLOCK.match(/class="bs-roadmap-mobile__row"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(rowBody).not.toBe('');
    expect(rowBody).not.toMatch(/<details/);
  });

  it('passes only the current wave into the phase <details> compact WaveList (R3)', () => {
    expect(EPIC_BLOCK).toMatch(/sec\.waves\.filter\(\(w\) => w\.kind === 'current'\)/);
  });

  it('shows the back link only when the phase is known, at least --bs-touch tall (R1)', () => {
    expect(EPIC_BLOCK).toMatch(/RouterLink/);
    expect(EPIC_BLOCK).toMatch(/v-if="isPhoneWidth && epic\.phase"/);
    expect(EPIC_BLOCK).toMatch(/bs-roadmap-mobile__back/);
  });

  it('epic mode always renders WaveList in compact form on phone (R3)', () => {
    expect(EPIC_BLOCK).toMatch(/:compact="isPhoneWidth"/);
  });

  it('shows a Tag instead of ProgressBarMini for a zero-task row', () => {
    expect(EPIC_BLOCK).toMatch(/<Tag v-else tone="todo" size="sm">Todo<\/Tag>/);
  });

  it('uses mobileEpicStatusLine for the phone row status text', () => {
    expect(EPIC_BLOCK).toMatch(/mobileEpicStatusLine\(sec\)/);
  });
});
