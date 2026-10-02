// KanbanBoard.vue column count tag (operator fix: filled subtle background,
// no border — not the outline variant). Source-text scrape, same style as
// kanbanBoardMobile.test.ts: no DOM harness in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'KanbanBoard.vue'),
  'utf8',
);

describe('KanbanBoard.vue — column count tag', () => {
  it('renders the column count as a subtle Tag, not outline (no border)', () => {
    expect(SRC).toMatch(/bs-kanban-col__count"\s+tone="neutral"\s+variant="subtle"/);
    expect(SRC).not.toMatch(/bs-kanban-col__count"[^>]*variant="outline"/);
  });
});
