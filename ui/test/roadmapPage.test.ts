import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages');
const componentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');
const SFC = readFileSync(join(pagesDir, 'RoadmapPage.vue'), 'utf8');
const EPIC_BLOCK = readFileSync(join(componentsDir, 'EpicBlock.vue'), 'utf8');
const SECTION = readFileSync(join(componentsDir, 'RoadmapProjectSection.vue'), 'utf8');

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
// ui/e2e/roadmapMobile.spec.ts instead. UI spec Part 2 moved the swimlane
// and the picker into one RoadmapProjectSection.vue per project.
describe('RoadmapPage.vue — phone branch (DS4 S4)', () => {
  it('imports useViewport and hides the swimlane on phone', () => {
    expect(SFC).toMatch(/useViewport/);
    expect(SECTION).toMatch(/useViewport/);
    expect(SECTION).toMatch(/<RoadmapSwimlane\s+v-if="!isPhoneWidth"/);
  });

  it("shows a phase-picker Select on phone, over the swimlane's own shown lanes (R4)", () => {
    expect(SECTION).toMatch(/laneOptions\(view\.value\.regions, view\.value\.currentLane\)/);
    expect(SECTION).toMatch(/<Select\s+v-else-if="showPicker"/);
    // Phase mode only: an epic selected in this section shows EpicBlock's back link instead.
    expect(SECTION).toMatch(/!\(props\.hostsSelection && props\.selectedEpic !== null\)/);
  });

  it("derives each selected epic's phase for the back link (R1)", () => {
    expect(SFC).toMatch(/epicPhase\(/);
    expect(SFC).toMatch(/phase: epicPhase/);
    expect(SFC).toMatch(/@back-to-phase="selectPhase"/);
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

  it('shows the back link only when the phase is known, emitting backToPhase imperatively (R1)', () => {
    expect(EPIC_BLOCK).toMatch(/backToPhase:\s*\[phaseId: string\]/);
    expect(EPIC_BLOCK).toMatch(/v-if="isPhoneWidth && epic\.phase"/);
    expect(EPIC_BLOCK).toMatch(/bs-roadmap-mobile__back/);
    expect(EPIC_BLOCK).toMatch(/emit\('backToPhase', epic\.phase\.milestoneId\)/);
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

  it('keeps the full epic id in a title attribute once the row shrinks it (S4 fix round 1 #5)', () => {
    expect(EPIC_BLOCK).toMatch(
      /<span class="bs-roadmap-mobile__row-id" :title="sec\.epicId">\{\{ sec\.epicId \}\}<\/span>/,
    );
  });

  it('marks the waves <details> summary with a rotating chevron, aria-hidden (S4 fix round 1 #3)', () => {
    const summaryBody = EPIC_BLOCK.match(/<summary>[\s\S]*?<\/summary>/)?.[0] ?? '';
    expect(summaryBody).not.toBe('');
    expect(summaryBody).toMatch(/<ChevronDown class="bs-roadmap-mobile__chev"/);
    expect(summaryBody).toMatch(/aria-hidden="true"/);
  });

  it('wraps the open waves body so a closed <details> is only the summary (S4 fix round 1 #2)', () => {
    expect(EPIC_BLOCK).toMatch(/<div class="bs-roadmap-mobile__waves-body">[\s\S]*?<WaveList/);
  });
});

// DS4 S5c — /api/roadmap's statusCounts/status/prUrl/sourcePrompt wired into
// the Roadmap UI. Same source-text-scrape convention: real rendering is
// exercised by ui/e2e/roadmap*.spec.ts.
describe('RoadmapPage.vue / EpicBlock.vue — server roadmap reads (DS4 S5c)', () => {
  it('prefers the server status over the flow-derived guess, in both selectedEpicData and epicSections', () => {
    expect(SFC).toMatch(/epicDatesFor\(milestones\.value/);
    expect(SFC).toMatch(
      /epicDates\s*\?\s*epicStatusFromServerStatus\(epicDates\.status\)\s*:\s*epicStatusFromFlow\(flow\)/,
    );
  });

  it('still keeps the flow fetch — waves come from nowhere else', () => {
    expect(SFC).toMatch(/fetchFlow/);
    expect(SFC).toMatch(/buildWaveList\(flow\)/);
  });

  it('passes statusCounts through to both EpicBlock call sites', () => {
    expect(SFC).toMatch(/:status-counts="selectedPhaseData\.statusCounts"/);
    expect(SFC).toMatch(/statusCounts: epicDates\?\.statusCounts/);
  });

  it('builds the stacked bar from statusCounts with a fallback for the single done/total bar', () => {
    expect(EPIC_BLOCK).toMatch(/function progressBar\(/);
    expect(EPIC_BLOCK).toMatch(/if \(counts\) return statusCountsBar\(counts\);/);
  });

  it('gates the "Epic started from" quote on sourcePrompt, rendering nothing when null', () => {
    expect(EPIC_BLOCK).toMatch(
      /<RequestQuote v-if="epic\.sourcePrompt" :quote="epic\.sourcePrompt" \/>/,
    );
  });

  it('renders "Copy epic id" via the shared clipboard helper', () => {
    expect(EPIC_BLOCK).toMatch(/copyToClipboard/);
    expect(EPIC_BLOCK).toMatch(/:label="copyLabel"/);
  });

  it('only renders the PR link for an https prUrl, as a real anchor opening in a new tab', () => {
    expect(EPIC_BLOCK).toMatch(/epic\.prUrl && isHttpsUrl\(epic\.prUrl\)/);
    expect(EPIC_BLOCK).toMatch(/target="_blank"/);
    expect(EPIC_BLOCK).toMatch(/rel="noopener noreferrer"/);
  });
});
