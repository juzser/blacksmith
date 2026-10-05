// KanbanTaskCard.vue chip variant + duplicate-role gating (ui-polish audit
// findings 2 and 5, ds-spec.md §2 Tag/TaskCard). Source-text scrape, same
// style as kanbanTaskCardCompact.test.ts: no DOM harness in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'KanbanTaskCard.vue'),
  'utf8',
);

describe('KanbanTaskCard.vue — card chip variant (audit finding 2)', () => {
  it('does not hardcode variant="outline" on the card chips, so Tag renders its subtle default', () => {
    expect(SRC).not.toMatch(/variant="outline"/);
  });
});

describe('KanbanTaskCard.vue — footer dependency line (operator fix 2026-10-05)', () => {
  it('clamps the footer dependency text to one line with a native title tooltip', () => {
    expect(SRC).toMatch(
      /<span class="bs-kanban-card__footer-dep" :title="footerDependency">\{\{ footerDependency \}\}<\/span>/,
    );
  });
});

describe('KanbanTaskCard.vue — row 1 id stays on one line (operator fix 2026-10-05)', () => {
  it('carries the full task id as a title tooltip on the id element', () => {
    expect(SRC).toMatch(
      /<span class="bs-kanban-card__id" :title="task\.taskId">\{\{ shortId \}\}<\/span>/,
    );
  });
});

describe('KanbanTaskCard.vue — row 1 copy-id button (ds-review.html mock, ds-spec.md §2.2 TaskCard)', () => {
  it('renders a sm IconButton labelled "Copy task id" right after the id, before the AgentChip', () => {
    expect(SRC).toMatch(
      /<span class="bs-kanban-card__id"[^>]*>\{\{ shortId \}\}<\/span>\s*<IconButton\s+:icon="Copy"\s+:label="copyIdLabel"\s+size="sm"\s+@click="onCopyTaskId"\s*\/>\s*<AgentChip/,
    );
  });

  it('copies the full task.taskId to the clipboard via the shared clipboard helper', () => {
    expect(SRC).toMatch(/import\s*\{\s*copyToClipboard\s*\}\s*from\s*'\.\.\/lib\/clipboard\.js'/);
    expect(SRC).toMatch(/copyToClipboard\(props\.task\.taskId\)/);
  });

  it('uses useCopyFeedback for the idle/"Copied" label, seeded with "Copy task id"', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*useCopyFeedback\s*\}\s*from\s*'\.\.\/composables\/useCopyFeedback\.js'/,
    );
    expect(SRC).toMatch(/useCopyFeedback\('Copy task id'\)/);
  });

  it('stops the click from propagating to the card, so it never opens the peek panel', () => {
    expect(SRC).toMatch(
      /function onCopyTaskId\(event: MouseEvent\) \{\s*event\.stopPropagation\(\);/,
    );
  });
});

describe('KanbanTaskCard.vue — hide duplicate role label (audit finding 5)', () => {
  it('imports agentChip to know whether an AgentChip is already carrying the role', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bagentChip\b[^}]*\}\s*from\s*'\.\.\/lib\/kanban\.js'/);
  });

  it('gates showRoleLabel on there being no AgentChip for the task', () => {
    expect(SRC).toMatch(/showRoleLabel\s*=\s*computed\(\s*\(\)\s*=>[^;]*!chip\.value/);
  });
});
