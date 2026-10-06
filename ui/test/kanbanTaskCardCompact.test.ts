// KanbanTaskCard.vue compact mode (ds-spec.md §3.1 Work/Kanban row: "one
// column of compact cards (title, tag, meta)"). Source-text scrape, same
// style as needsYouInbox.test.ts: no DOM harness in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'KanbanTaskCard.vue'),
  'utf8',
);

describe('KanbanTaskCard.vue — compact prop (§3.1 Work/Kanban row)', () => {
  it('declares a compact prop', () => {
    expect(SRC).toMatch(/compact\?:\s*boolean/);
  });

  it('hides row 1 (agent chip) and the summary paragraph in compact mode', () => {
    expect(SRC).toMatch(
      /v-if="!compact && chip"\s+class="bs-kanban-card__row bs-kanban-card__row--1"/,
    );
    expect(SRC).toMatch(/v-if="showSummary && !compact"/);
  });

  it('hides the footer (dependencies, comments, PR link — the card menu surface) in compact mode', () => {
    expect(SRC).toMatch(
      /v-if="!compact[\s\S]*?hasWaiting[\s\S]*?"\s+class="bs-kanban-card__footer"/,
    );
  });

  it('caps chips to one in compact mode instead of the full set', () => {
    expect(SRC).toMatch(/compact \? 1 : /);
  });
});
