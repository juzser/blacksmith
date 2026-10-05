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

describe('KanbanTaskCard.vue — hide duplicate role label (audit finding 5)', () => {
  it('imports agentChip to know whether an AgentChip is already carrying the role', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bagentChip\b[^}]*\}\s*from\s*'\.\.\/lib\/kanban\.js'/);
  });

  it('gates showRoleLabel on there being no AgentChip for the task', () => {
    expect(SRC).toMatch(/showRoleLabel\s*=\s*computed\(\s*\(\)\s*=>[^;]*!chip\.value/);
  });
});
