// Static source-text check, same style as kitBarChart.test.ts. Ported from
// ds/LineChart.vue with renamed classes/tokens plus a required takeaway.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const CHART = readFileSync(join(KIT, 'LineChart.vue'), 'utf8');

describe('kit/LineChart.vue', () => {
  it('keeps the ported points/label/height/format props', () => {
    expect(CHART).toMatch(/points:\s*\{\s*label:\s*string;\s*value:\s*number\s*\}\[\];/);
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

  it('renames old chart classes to the bs- prefix, none of the old names remain', () => {
    expect(CHART).toMatch(/class="bs-chart"/);
    expect(CHART).toMatch(/class="bs-chart__gridline"/);
    expect(CHART).toMatch(/class="bs-chart__line"/);
    expect(CHART).toMatch(/class="bs-chart__point"/);
    expect(CHART).toMatch(/class="bs-chart__axisrow"/);
    expect(CHART).toMatch(/class="bs-chart__axislabel"/);
    expect(CHART).toMatch(/class="bs-chart__scale"/);
    expect(CHART).not.toMatch(/class="ds-chart/);
  });

  it('keeps gridlines, the path/point markers, and the sr-only data table a11y fallback', () => {
    expect(CHART).toMatch(/v-for="i in 3"/);
    expect(CHART).toMatch(/class="sr-only"/);
    expect(CHART).toMatch(/role="img"/);
  });
});
