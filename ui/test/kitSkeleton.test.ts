// Skeleton — port of ds/Skeleton.vue plus a new `shape: line|block|circle`
// prop (DS0 batch A). width/height/radius keep using cssLength() unchanged
// (fixes bug D-223, per the batch brief). Same static source-text style as
// kitButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SKELETON = readFileSync(join(KIT, 'Skeleton.vue'), 'utf8');

describe('kit/Skeleton.vue', () => {
  it('declares shape as line|block|circle, defaulting to line', () => {
    expect(SKELETON).toMatch(/shape\?:\s*'line'\s*\|\s*'block'\s*\|\s*'circle'/);
    const match = SKELETON.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/shape:\s*'line'/);
  });

  it('keeps width/height/radius from the old contract', () => {
    expect(SKELETON).toMatch(/width\?:\s*string/);
    expect(SKELETON).toMatch(/height\?:\s*(?:number\s*\|\s*string|string\s*\|\s*number)/);
    expect(SKELETON).toMatch(/radius\?:\s*string/);
  });

  it('reuses cssLength unchanged, not a reimplementation', () => {
    expect(SKELETON).toMatch(/import\s*\{\s*cssLength\s*\}\s*from\s*'\.\.\/\.\.\/lib\/cssLength\.js';/);
  });

  it('forces a fully round shape for circle via a bs-skeleton--circle class', () => {
    expect(SKELETON).toMatch(/class="bs-skeleton"/);
    expect(SKELETON).toMatch(/bs-skeleton--\$\{.*shape.*\}/);
    expect(SKELETON).not.toMatch(/ds-skeleton/);
  });
});
