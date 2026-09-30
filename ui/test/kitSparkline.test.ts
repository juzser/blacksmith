// Static source-text check, same style as kitLineChart.test.ts. Ported from
// ds/Sparkline.vue with a renamed line class, a required takeaway, and a
// new wrapper div — the old component was a bare <svg> root, which leaves
// nowhere to put the takeaway paragraph.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const SPARK = readFileSync(join(KIT, 'Sparkline.vue'), 'utf8');

describe('kit/Sparkline.vue', () => {
  it('keeps the ported values/label props', () => {
    expect(SPARK).toMatch(/values:\s*number\[\];/);
    expect(SPARK).toMatch(/\n\s*label:\s*string;/);
  });

  it('declares a required takeaway prop (TypeScript-required, not runtime-enforced)', () => {
    expect(SPARK).toMatch(/\n\s*takeaway:\s*string;/);
    expect(SPARK).not.toMatch(/\n\s*takeaway\?:\s*string;/);
  });

  it('adds a wrapper div and renders the takeaway paragraph above the svg', () => {
    const wrapperIdx = SPARK.indexOf('<div class="bs-chart');
    const takeawayIdx = SPARK.indexOf('<p class="bs-chart__takeaway">{{ takeaway }}</p>');
    const svgIdx = SPARK.indexOf('<svg');
    expect(wrapperIdx).toBeGreaterThan(-1);
    expect(takeawayIdx).toBeGreaterThan(wrapperIdx);
    expect(svgIdx).toBeGreaterThan(takeawayIdx);
  });

  it('renames the line class to the bs- prefix, none of the old name remains', () => {
    expect(SPARK).toMatch(/class="bs-chart__line"/);
    expect(SPARK).not.toMatch(/class="ds-chart__line"/);
  });

  it('keeps the fixed 80x24 intrinsic size, unbound from design tokens', () => {
    expect(SPARK).toMatch(/width = 80/);
    expect(SPARK).toMatch(/height = 24/);
  });
});
