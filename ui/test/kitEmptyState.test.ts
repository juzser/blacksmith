// EmptyState — new explicit prop shape (DS0 batch A brief): `icon` (a
// required Lucide component, not the old optional string name), `title`
// and `body` (both required strings, replacing the old default-slot text),
// plus an optional `action` named slot (the old illustrationSrc/inline
// props are dropped entirely). Same static source-text style as
// kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const EMPTY_STATE = readFileSync(join(KIT, 'EmptyState.vue'), 'utf8');

describe('kit/EmptyState.vue', () => {
  it('declares icon as a required Lucide Component, title and body as required strings', () => {
    expect(EMPTY_STATE).toMatch(/icon:\s*Component/);
    expect(EMPTY_STATE).toMatch(/title:\s*string/);
    expect(EMPTY_STATE).toMatch(/body:\s*string/);
  });

  it('drops the old illustrationSrc/inline props', () => {
    expect(EMPTY_STATE).not.toMatch(/illustrationSrc/);
    expect(EMPTY_STATE).not.toMatch(/inline/);
  });

  it('renders icon/title/body as props, not slot content', () => {
    expect(EMPTY_STATE).toMatch(/<Icon[^>]*:icon="icon"/);
    expect(EMPTY_STATE).toMatch(/\{\{\s*title\s*\}\}/);
    expect(EMPTY_STATE).toMatch(/\{\{\s*body\s*\}\}/);
  });

  it('exposes an optional named "action" slot for a call-to-action button', () => {
    expect(EMPTY_STATE).toMatch(/<slot name="action"/);
  });

  it('uses bs-empty class names, not the old ds-empty ones', () => {
    expect(EMPTY_STATE).toMatch(/class="bs-empty"/);
    expect(EMPTY_STATE).not.toMatch(/ds-empty/);
  });
});
