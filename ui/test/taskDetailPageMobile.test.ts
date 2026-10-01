// TaskDetailPage.vue mobile Refresh drop (ds-spec.md §3.1 Task row: Refresh
// is dropped on mobile so the H1 gets full width). Source-text scrape, same
// style as needsYouInbox.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'TaskDetailPage.vue'),
  'utf8',
);

describe('TaskDetailPage.vue — Refresh dropped on phone (§3.1 Task row)', () => {
  it('reads isPhoneWidth from the shared viewport composable', () => {
    expect(SRC).toMatch(/from '\.\.\/composables\/useViewport\.js'/);
  });

  it('hides the Refresh button at phone width', () => {
    expect(SRC).toMatch(
      /<Button v-if="!isPhoneWidth" variant="ghost" size="sm" :icon="RefreshCw" @click="refresh">Refresh<\/Button>/,
    );
  });
});
