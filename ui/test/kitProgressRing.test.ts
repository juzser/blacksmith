// Static source-text check, same style as kitIconButton.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const RING = readFileSync(join(KIT, 'ProgressRing.vue'), 'utf8');

describe('kit/ProgressRing.vue', () => {
  it('declares label as a required prop, not optional', () => {
    expect(RING).toMatch(/\n\s*label:\s*string;/);
    expect(RING).not.toMatch(/\n\s*label\?:\s*string;/);
  });

  it('declares value as a required prop, max optional defaulting to 100', () => {
    expect(RING).toMatch(/\n\s*value:\s*number;/);
    expect(RING).toMatch(/max\?:\s*number;/);
    const match = RING.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/max:\s*100/);
  });

  it('declares an optional tone prop with no runtime default (auto-computed when omitted)', () => {
    expect(RING).toMatch(/tone\?:\s*ProgressTone;/);
    const match = RING.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match?.[1]).not.toMatch(/\btone\s*:/);
  });

  // kind: additive prop, not in ds-spec.md's literal props table — needed to
  // disambiguate the two auto-tone threshold rules in progressTone.ts.
  it('declares an additive kind prop, budget|ratio, defaulting to ratio', () => {
    expect(RING).toMatch(/kind\?:\s*ProgressKind;/);
    const match = RING.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match?.[1]).toMatch(/kind:\s*'ratio'/);
  });

  // detail: additive prop, not in ds-spec.md's literal props table — the
  // exact-values Tooltip sentence the component cannot derive on its own.
  it('declares an additive optional detail prop', () => {
    expect(RING).toMatch(/detail\?:\s*string;/);
  });

  it('imports the shared tone helper instead of duplicating threshold literals', () => {
    expect(RING).toMatch(
      /import \{[\s\S]*?\} from '\.\/progressTone\.js';/,
    );
    expect(RING).toMatch(/computeProgressTone/);
    expect(RING).toMatch(/clampedPercent/);
    expect(RING).toMatch(/progressToneColor/);
  });

  it('wraps in a describe-mode Tooltip only when detail is provided', () => {
    expect(RING).toMatch(/<Tooltip\s+v-if="detail"\s+mode="describe"\s+:text="detail">/);
    expect(RING).toMatch(/<span\s+v-else\s+class="pring"/);
  });

  it('carries role=img and aria-label on the pring wrapper itself, not the Tooltip trigger', () => {
    const wrapperOccurrences = RING.match(/class="pring" role="img" :aria-label="label"/g);
    expect(wrapperOccurrences).toHaveLength(2); // once inside Tooltip's slot, once in the v-else branch
  });

  it('draws a 20px ring per the spec literal default (18px/stroke-3 mockup mismatch is a documented deviation)', () => {
    expect(RING).toMatch(/viewBox="0 0 20 20"/);
    expect(RING).toMatch(/r="8"/);
    expect(RING).toMatch(/pathLength="100"/);
    expect(RING).not.toMatch(/\bsize\??:\s*'/); // no size/lg prop was added
  });

  it('uses the pring/trk/fil/pnum class names', () => {
    expect(RING).toMatch(/class="pring"/);
    expect(RING).toMatch(/class="trk"/);
    expect(RING).toMatch(/class="fil"/);
    expect(RING).toMatch(/class="pnum"/);
  });
});
