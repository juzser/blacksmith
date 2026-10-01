// MobileTopBar.vue — a Teleport target for page-specific overflow controls
// (ds-spec.md §3.1 Work/Kanban row: "display options ... move into the
// MobileTopBar overflow menu"). Same Teleport mechanism already used by
// kit/Dialog.vue/Sheet.vue/Toast.vue, not a new composable — MobileTopBar
// stays prop-only and has no page-specific knowledge of its own.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit', 'MobileTopBar.vue'),
  'utf8',
);

describe('MobileTopBar.vue — page overflow teleport target', () => {
  it('renders a named teleport target inside its overflow menu', () => {
    expect(SRC).toMatch(/id="bs-mtopbar-overflow-extra"/);
    expect(SRC).toMatch(/bs-mtopbar__overflow[\s\S]*id="bs-mtopbar-overflow-extra"/);
  });
});
