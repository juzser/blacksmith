// Static source-text check, same style as kitProgressRing.test.ts. Ported
// from ds/BarChart.vue (ds-spec.md §2.1/§5) with renamed classes/tokens plus
// two additive prop groups — see the component's own header comment.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const CHART = readFileSync(join(KIT, 'BarChart.vue'), 'utf8');

describe('kit/BarChart.vue', () => {
  it('keeps the ported bars/label/height/format props', () => {
    expect(CHART).toMatch(/bars:\s*\{\s*label:\s*string;\s*value:\s*number\s*\}\[\];/);
    expect(CHART).toMatch(/\n\s*label:\s*string;/);
    expect(CHART).toMatch(/height\?:\s*number;/);
    expect(CHART).toMatch(/format\?:\s*\(v:\s*number\)\s*=>\s*string;/);
  });

  it('declares a required takeaway prop (TypeScript-required, not runtime-enforced)', () => {
    expect(CHART).toMatch(/\n\s*takeaway:\s*string;/);
    expect(CHART).not.toMatch(/\n\s*takeaway\?:\s*string;/);
  });

  it('renders the takeaway paragraph above the existing chart markup', () => {
    expect(CHART).toMatch(/<p class="bs-chart__takeaway">\{\{ takeaway \}\}<\/p>/);
  });

  it('declares additive stacked/series/stackedBars props, all optional', () => {
    expect(CHART).toMatch(/stacked\?:\s*boolean;/);
    expect(CHART).toMatch(/series\?:\s*\{\s*key:\s*string;\s*tone:\s*string\s*\}\[\];/);
    expect(CHART).toMatch(
      /stackedBars\?:\s*\{\s*label:\s*string;\s*values:\s*Record<string,\s*number>\s*\}\[\];/,
    );
    const match = CHART.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match?.[1]).toMatch(/stacked:\s*false/);
  });

  it('renames ds-chart/ds-bars classes to bs-chart/bs-bars, none of the old names remain', () => {
    expect(CHART).toMatch(/class="bs-chart"/);
    expect(CHART).toMatch(/class="bs-bars"/);
    expect(CHART).not.toMatch(/ds-chart|ds-bars/);
  });

  it('does not invent --bs-chart-7/-8 (the old kit had 8, bs-tokens.css only defines 6)', () => {
    expect(CHART).not.toMatch(/--bs-chart-7|--bs-chart-8/);
  });

  it('keeps the 8-bar cap and the sr-only data table a11y fallback', () => {
    expect(CHART).toMatch(/\.slice\(0,\s*8\)/);
    expect(CHART).toMatch(/class="sr-only"/);
    expect(CHART).toMatch(/role="img"/);
  });
});
