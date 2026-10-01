// KanbanPage.vue mobile Refresh drop (ds-spec.md §3.1 Shell row: Refresh is
// hidden on mobile everywhere). Source-text scrape, same style as
// taskDetailPageMobile.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'KanbanPage.vue'),
  'utf8',
);

describe('KanbanPage.vue — Refresh dropped on phone (§3.1 Shell row)', () => {
  it('reads isPhoneWidth from the shared viewport composable', () => {
    expect(SRC).toMatch(/from '\.\.\/composables\/useViewport\.js'/);
    expect(SRC).toMatch(/isPhoneWidth/);
  });

  it('hides the Refresh button at phone width', () => {
    expect(SRC).toMatch(
      /<Button v-if="!isPhoneWidth" variant="ghost" size="sm" :icon="RefreshCw" @click="refresh">Refresh<\/Button>/,
    );
  });
});
