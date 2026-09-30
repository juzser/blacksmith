import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'TaskDetailPage.vue'),
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
});

// Task 2 (friendly role labels): agentChipLabel() now renders roleLabel()'s
// friendly string ("Builder") rather than the raw taxonomy role ("coder");
// agentChipTitle() keeps the raw `role · tier` reachable as a tooltip on
// every IdentityChip built from it, and the Attempts row's own plain-text
// title gets the same friendly label directly.
describe('TaskDetailPage.vue — role labels', () => {
  it('imports roleLabel and routes agentChipLabel through it', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
    expect(SFC).toMatch(
      /function agentChipLabel\(role: string, modelTier: string \| null\): string \{\s*const label = roleLabel\(role\);/,
    );
  });

  it('keeps the raw role · tier as a title tooltip via agentChipTitle', () => {
    expect(SFC).toContain(
      'function agentChipTitle(role: string, modelTier: string | null): string {',
    );
    expect(SFC).toMatch(/:title="agentChipTitle\(a\.agentRole, a\.modelTier\)"/);
  });

  it('labels the Attempts row title, not just its trailing chip', () => {
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
