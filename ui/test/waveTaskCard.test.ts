// DS4 S3 fix round 1 findings 1 and 4 — WaveTaskCard.vue rendered the raw
// status slug ("in-progress") instead of a humanized label, and showed no
// task id at all. Source-text scrape, same style as kanbanTaskCard.test.ts:
// no DOM harness in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'WaveTaskCard.vue'),
  'utf8',
);

describe('WaveTaskCard.vue — humanized status (fix round 1 finding 1)', () => {
  it('imports titleCase from lib/kanban.js, the same helper cardChips() uses', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\btitleCase\b[^}]*\}\s*from\s*'\.\.\/lib\/kanban\.js'/);
  });

  it('renders the status Tag through titleCase rather than the raw slug', () => {
    expect(SRC).toMatch(/<Tag[^>]*>\{\{\s*titleCase\(task\.taskStatus\)\s*\}\}<\/Tag>/);
  });
});

describe('WaveTaskCard.vue — task id shown (fix round 1 finding 4)', () => {
  it('imports shortTaskId from lib/format.js, the same helper KanbanTaskCard uses', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bshortTaskId\b[^}]*\}\s*from\s*'\.\.\/lib\/format\.js'/);
  });

  it('renders the id with the shared bs-kanban-card__id class', () => {
    expect(SRC).toMatch(/class="bs-kanban-card__id"/);
  });
});

// Kanban card title-copy fix (2026-10-05): KanbanTaskCard no longer renders
// the id text in row 1 at all (a link icon after the title copies it
// instead), so the row--1-scoped id rule is gone. WaveTaskCard still shares
// the base .bs-kanban-card__id class for its own Roadmap id and must keep
// its natural width.
describe('WaveTaskCard.vue — shared id class keeps its natural width', () => {
  const CSS = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
    'utf8',
  );

  it('the base .bs-kanban-card__id rule does not grow', () => {
    const base = CSS.match(/\n\.bs-kanban-card__id \{[\s\S]*?\}/);
    expect(base).not.toBeNull();
    expect(base?.[0]).not.toMatch(/flex:/);
  });

  it('no row-1-scoped id rule remains — the Kanban card no longer renders the id in row 1', () => {
    expect(CSS).not.toMatch(/\.bs-kanban-card__row--1 \.bs-kanban-card__id \{/);
  });
});
