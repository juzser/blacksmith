// Cost & quality reads every store: the client half. The query string runs for
// real; AnalyticsPage is checked as source text because ui/vitest.config.ts has
// no DOM (same contract as activityAllStores.test.ts).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAnalytics } from '../src/lib/api.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = readFileSync(join(SRC, 'pages', 'AnalyticsPage.vue'), 'utf8');

describe('fetchAnalytics query string', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('writes stores=all only when asked', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(u);
        return { ok: true, json: async () => ({}) };
      }),
    );
    await fetchAnalytics(undefined, undefined, '30d', ['ab12cd34/sess-a'], 'all');
    await fetchAnalytics(undefined, undefined, '30d');
    const q = new URL(urls[0] as string, 'http://x').searchParams;
    expect(q.get('stores')).toBe('all');
    expect(q.getAll('sessions')).toEqual(['ab12cd34/sess-a']);
    expect(urls[1]).toBe('/api/analytics?period=30d');
  });
});

describe('AnalyticsPage reads every store', () => {
  it('asks for all stores unless a ?session= names one store', () => {
    expect(page).toContain('allStores: true');
    expect(page).toContain("view.value.mode === 'explicit' ? undefined : 'all'");
  });

  it('no longer prints the other-store line', () => {
    expect(page).not.toMatch(/otherStores/);
    expect(page).not.toContain('another store');
  });
});

describe('AnalyticsPage second-opinion card with nothing measured', () => {
  it('keeps null as null and swaps the ring for the not-enough-data text on both widths', () => {
    expect(page).not.toMatch(/agreementRate === null\s*\?\s*0/);
    expect(page).toContain('secondOpinion.value.agreementRate === null');
    const rings = page.match(/<ProgressRing\s+v-if="secondOpinionPct !== null"/g) ?? [];
    expect(rings).toHaveLength(2);
    expect(page.match(/<span v-else>Not enough data yet<\/span>/g)?.length).toBeGreaterThanOrEqual(
      4,
    );
  });
});
