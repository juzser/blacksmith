// AgentChip.vue label truncation (review follow-up S2, 2026-10-05):
// text-overflow does not apply to text sitting directly inside a flex
// container (.bs-tag/.bs-agent-chip are display: inline-flex), so the label
// was hard-clipped with no ellipsis. Source-text scrape, same style as
// kanbanTaskCard.test.ts: no DOM harness in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'AgentChip.vue'),
  'utf8',
);

describe('AgentChip.vue — label truncation (review follow-up S2)', () => {
  it('wraps the label text in its own .bs-agent-chip__text span so text-overflow can apply', () => {
    expect(SRC).toMatch(/<span class="bs-agent-chip__text">\{\{ text \}\}<\/span>/);
  });

  it('keeps the chip title tooltip unchanged', () => {
    expect(SRC).toMatch(/:title="chip\.title"/);
  });
});
