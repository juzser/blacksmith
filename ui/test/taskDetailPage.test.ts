import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'TaskDetailPage.vue'),
  'utf8',
);

describe('TaskDetailPage.vue — screenshot gallery', () => {
  it('polls live via usePoll rather than a one-off onMounted load', () => {
    expect(SFC).toMatch(/from '\.\.\/composables\/usePoll\.js'/);
    expect(SFC).toMatch(/usePoll\(load, 15000\)/);
  });

  it('renders image artifacts through the /api/artifacts route, not a raw declared path', () => {
    expect(SFC).toMatch(/\/api\/artifacts\/\$\{encodeURIComponent\(a\.id\)\}/);
  });

  it('splits artifacts into an image gallery and a non-image list', () => {
    expect(SFC).toContain('imageArtifacts');
    expect(SFC).toContain('otherArtifacts');
  });

  it('treats a screenshot type or an image extension as a thumbnail, nothing narrower', () => {
    expect(SFC).toMatch(/a\.type === 'screenshot'/);
    expect(SFC).toMatch(/IMAGE_EXTENSIONS\.test\(a\.path\)/);
  });
});
