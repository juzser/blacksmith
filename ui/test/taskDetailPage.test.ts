import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'TaskDetailPage.vue'),
  'utf8',
);
const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

describe('TaskDetailPage.vue — screenshot gallery', () => {
  it('polls live via usePoll rather than a one-off onMounted load', () => {
    expect(SFC).toMatch(/from '\.\.\/composables\/usePoll\.js'/);
    expect(SFC).toMatch(/usePoll\(load, 15000\)/);
  });

  it('renders image artifacts through the /api/artifacts route, not a raw declared path', () => {
    expect(SFC).toMatch(/\/api\/artifacts\/\$\{encodeURIComponent\(a\.id\)\}/);
  });

  it('splits artifacts into an image gallery and a non-image list', () => {
    expect(SFC).toContain('imageArtifacts');
    expect(SFC).toContain('otherArtifacts');
  });

  it('treats a screenshot type or an image extension as a thumbnail, nothing narrower', () => {
    expect(SFC).toMatch(/a\.type === 'screenshot'/);
    expect(SFC).toMatch(/IMAGE_EXTENSIONS\.test\(a\.path\)/);
  });

  // Operator request: "Output và history trong task detail nên xếp ngược
  // lại, recent lên trên" — Outputs newest first. The order comes from the
  // server (`taskDetail()`'s artifact query, queries.ts), not a client sort:
  // `imageArtifacts`/`otherArtifacts` must only `filter`, which preserves
  // whatever order `detail.artifacts` already carries, never re-sort it.
  it('derives imageArtifacts/otherArtifacts with a filter only, preserving the server order', () => {
    expect(SFC).toMatch(
      /const imageArtifacts = computed\(\(\) => detail\.value\?\.artifacts\.filter\(isImageArtifact\) \?\? \[\]\);/,
    );
    expect(SFC).toMatch(
      /const otherArtifacts = computed\(\s*\(\) => detail\.value\?\.artifacts\.filter\(\(a\) => !isImageArtifact\(a\)\) \?\? \[\],?\s*\);/,
    );
  });

  // Operator fix: the crumb reads the plain taskId, but PageHeader's title
  // is taskLabel() (the task name when there is one) — not a pure
  // duplicate, so this page opts out of the default sr-only title.
  it('keeps its PageHeader title visible, since it differs from the crumb', () => {
    expect(SFC).toMatch(/<PageHeader[\s\S]{0,200}title-visible/);
  });

  // Operator request: History newest first, day groups newest day on top.
  // `fetchTimelinePage({ task, limit: 200 })` already returns newest-first
  // (`timeline()`'s paged mode, queries.ts), and `groupByDay` only
  // partitions a list into same-day runs in the order it is given — so
  // `historyDayGroups` must feed it `history.value` untouched, no
  // `.slice().reverse()` or `.sort()` of its own.
  it('groups History by day straight off history.value, no client-side re-sort', () => {
    expect(SFC).toMatch(/groupByDay\(history\.value, new Date\(\)\.toISOString\(\)\)/);
    expect(SFC).not.toMatch(/history\.value\s*\.(slice\(\)\.reverse|sort)\(/);
  });
});

// Task 2 (friendly role labels), re-skinned onto the kit in DS3 item 4: the
// Agents rail row renders roleLabel()'s friendly string ("Builder") directly
// as always-visible text rather than behind an IdentityChip + hover tooltip
// (the kit has no IdentityChip equivalent, and a tooltip is only needed to
// recover text a compact chip hides — this row shows the full "role · tier"
// text already, so there is nothing left for a title attribute to add).
describe('TaskDetailPage.vue — role labels', () => {
  it('imports roleLabel', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
  });

  it('labels the Agents rail row with the friendly role label, not the raw taxonomy role', () => {
    expect(SFC).toContain('{{ roleLabel(a.agentRole) }} · {{ a.modelTier }}/{{ a.provider }}');
  });
});

// Task 4 (humanized task label helper): a task with no objective used to
// head the page with its raw id ("epic-9/task-29-readme-merge-trim").
// taskLabel() humanizes it instead; PageHeader has no spare prop for a
// tooltip (its own `title` prop IS the heading), so the raw id stays
// reachable via the Details rail's always-visible "Task ID" field, not a
// hover tooltip.
//
// This block cannot mount TaskDetailPage with @vue/test-utils: that package
// is not a dependency of this repo (no entry in package.json/pnpm-lock.yaml,
// nothing under node_modules/@vue), and ui/vitest.config.ts deliberately runs
// this suite under `environment: 'node'` — there is no DOM here to mount
// into. Per that config's own comment, component/page behavior is Playwright
// (ui/e2e/*.spec.ts) territory; adding a DOM environment and a new test
// dependency to cover one page here would be a second, competing way to test
// component behavior in a suite that is explicitly scoped to pure-logic
// units. So this stays a source-text assertion like its siblings above, now
// covering the fallback path added for the long-objective case.
describe('TaskDetailPage.vue — humanized task label', () => {
  it('imports taskLabel and heads the page with it', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/format\.js'/);
    expect(SFC).toContain('taskLabel(detail.task.taskId, detail.task.objective)');
    expect(SFC).toMatch(
      /<PageHeader\s+:title="taskLabel\(detail\.task\.taskId, detail\.task\.objective\)"/,
    );
  });

  it('passes a description to PageHeader only when the objective differs from the heading', () => {
    expect(SFC).toMatch(
      /:description="objectiveDescription\(detail\.task\.taskId, detail\.task\.objective\)"/,
    );
    expect(SFC).toMatch(
      /function objectiveDescription\(taskId: string, objective: string \| null\): string \| undefined \{/,
    );
  });

  it('falls back to undefined once the trimmed objective equals the derived label', () => {
    expect(SFC).toMatch(
      /return trimmed === taskLabel\(taskId, objective\) \? undefined : trimmed;/,
    );
  });
});

// Visual-pass items 2-4 (§4.7): the branch tag beside the status, and the
// "Spec contract" dl card, read as false subtitle / raw-data cruft the
// operator does not need up front; RunHistoryTimeline sat on the wrong tab.
describe('TaskDetailPage.vue — DS visual pass restructure (items 2-4)', () => {
  const TEMPLATE = SFC.slice(SFC.indexOf('<template>'));

  it('no longer shows the branch as a visible Tag beside the status', () => {
    expect(TEMPLATE).not.toMatch(/<Tag v-if="detail\.branch"/);
  });

  it('collapses branch, origin and epic behind a "Technical details" disclosure', () => {
    expect(TEMPLATE).toMatch(/<details class="bs-task-detail__tech-details">/);
    expect(TEMPLATE).toMatch(/<summary>Technical details<\/summary>/);
    expect(TEMPLATE).toMatch(/detail\.branch/);
    expect(TEMPLATE).toMatch(/detail\.task\.origin/);
    expect(TEMPLATE).toMatch(/detail\.task\.epicId/);
  });

  it('replaces the "Spec contract" dl card with a compact facts row', () => {
    expect(TEMPLATE).not.toMatch(/Card title="Spec contract"/);
    expect(TEMPLATE).toMatch(/class="bs-task-detail__facts"/);
  });

  it('builds the facts row as "Type: … · Plan revision N" from caseTag and planVersion', () => {
    expect(SFC).toMatch(/const factsRowText = computed/);
    expect(SFC).toMatch(/Type: \$\{detail\.value\.task\.caseTag\}/);
    expect(SFC).toMatch(/Plan revision \$\{detail\.value\.task\.planVersion\}/);
  });

  it('lists claims under "Files this task may change", not a bare "Claims" dt', () => {
    expect(TEMPLATE).toMatch(/Card title="Files this task may change"/);
    expect(TEMPLATE).not.toMatch(/<dt>Claims<\/dt>/);
  });

  it('moves RunHistoryTimeline out of the overview tab', () => {
    const overview = TEMPLATE.slice(TEMPLATE.indexOf('#overview'), TEMPLATE.indexOf('#findings'));
    expect(overview).not.toMatch(/RunHistoryTimeline/);
    expect(overview).not.toMatch(/Card title="Run history"/);
  });

  it('puts RunHistoryTimeline at the top of History, above the TimelineRow list', () => {
    const history = TEMPLATE.slice(TEMPLATE.indexOf('#history'));
    const order = ['<RunHistoryTimeline', '<TimelineRow'].map((marker) => history.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // A screenshot of the rendered disclosure showed "Technical details" with
  // no triangle: `display: flex` on a <summary> drops the browser's native
  // ::marker (it only renders for the default `list-item` display), so a
  // closed disclosure read as inert text with no affordance that it opens.
  // NeedsYouInbox.vue's own summary.bs-inbox__group-head rule already hit
  // this and documents the fix in its own comment ("flex drops the
  // disclosure marker") — this rule must follow the same `list-item` +
  // line-height shape, not flex + align-items, to keep the marker visible.
  it('keeps the native disclosure marker on the Technical details summary (list-item, not flex)', () => {
    const rule = PRIMITIVES_CSS.match(/\.bs-task-detail__tech-details summary \{([^}]*)\}/)?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/display:\s*list-item;/);
    expect(rule).not.toMatch(/display:\s*flex;/);
  });
});

describe('TaskDetailPage.vue — humanized status tag (audit finding 6)', () => {
  it('imports titleCase from lib/kanban.js, reusing the Kanban card humanizer', () => {
    expect(SFC).toMatch(/import\s*\{[^}]*\btitleCase\b[^}]*\}\s*from\s*'\.\.\/lib\/kanban\.js'/);
  });

  it('never interpolates the raw taskStatus slug directly inside a status Tag', () => {
    expect(SFC).not.toMatch(/<Tag[^>]*>\s*\{\{\s*detail\.task\.taskStatus\s*\}\}/);
  });

  it('wraps the status tag text in titleCase()', () => {
    expect(SFC).toMatch(/\{\{\s*titleCase\(detail\.task\.taskStatus\)\s*\}\}/);
  });
});

describe('TaskDetailPage.vue — mobile title row wrap (audit finding 3, §3.1)', () => {
  it('wraps .bs-ph__titlerow to a column at the mobile breakpoint so the H1 and tags do not share a row', () => {
    const rule = PRIMITIVES_CSS.match(
      /@media \(max-width: 640px\) \{\s*\.bs-ph__titlerow \{([^}]*)\}/,
    )?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/flex-direction:\s*column;/);
  });
});
