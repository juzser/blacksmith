// WaveList.vue's `compact` prop (DS4 S4 R3). Source-text scrape, same style
// as kanbanBoardMobile.test.ts: no DOM harness in this config — the
// behavioral split (desktop byte-identical, phone one line per wave, no
// cards) is exercised by ui/e2e/roadmap.spec.ts and roadmapMobile.spec.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'WaveList.vue'),
  'utf8',
);

describe('WaveList.vue — compact prop (DS4 S4 R3)', () => {
  it('defaults compact to false', () => {
    expect(SRC).toMatch(/compact\?:\s*boolean/);
    expect(SRC).toMatch(/\{\s*compact:\s*false\s*\}/);
  });

  it('shows a ProgressBarMini on every wave when compact, only on past waves otherwise', () => {
    expect(SRC).toMatch(/v-if="compact \|\| wave\.kind === 'past'"/);
  });

  it('never renders the full bar or WaveTaskCards when compact', () => {
    expect(SRC).toMatch(/v-if="!compact && wave\.kind === 'current'"/);
  });

  // S4 fix round 1 #4 — compact wave rows kept .wave card chrome (border
  // box, background). Compact must render flat rows like the mock's .mrow:
  // no card, a border-bottom separator only. The `wave-list--compact`
  // modifier class carries the override, not a change to the per-wave
  // element/class names, so desktop output (compact=false) stays untouched.
  it('adds a wave-list--compact modifier class only when compact, leaving per-wave classes untouched', () => {
    expect(SRC).toMatch(/class="wave-list"\s+:class="\{\s*'wave-list--compact':\s*compact\s*\}"/);
  });
});
