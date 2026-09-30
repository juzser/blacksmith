// Static source-text check, same style as kitProgressRing.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const MINI = readFileSync(join(KIT, 'ProgressBarMini.vue'), 'utf8');

describe('kit/ProgressBarMini.vue', () => {
  it('declares the same value/max/tone/kind/label/detail props as ProgressRing', () => {
    expect(MINI).toMatch(/\n\s*value:\s*number;/);
    expect(MINI).toMatch(/max\?:\s*number;/);
    expect(MINI).toMatch(/tone\?:\s*ProgressTone;/);
    expect(MINI).toMatch(/kind\?:\s*ProgressKind;/);
    expect(MINI).toMatch(/\n\s*label:\s*string;/);
    expect(MINI).not.toMatch(/\n\s*label\?:\s*string;/);
    expect(MINI).toMatch(/detail\?:\s*string;/);
    const match = MINI.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match?.[1]).toMatch(/max:\s*100/);
    expect(match?.[1]).toMatch(/kind:\s*'ratio'/);
  });

  it('imports the shared tone helper instead of duplicating threshold literals', () => {
    expect(MINI).toMatch(/import \{[\s\S]*?\} from '\.\/progressTone\.js';/);
    expect(MINI).toMatch(/computeProgressTone/);
    expect(MINI).toMatch(/clampedPercent/);
    expect(MINI).toMatch(/progressToneColor/);
  });

  it('wraps in a describe-mode Tooltip only when detail is provided', () => {
    expect(MINI).toMatch(/<Tooltip\s+v-if="detail"\s+mode="describe"\s+:text="detail">/);
    expect(MINI).toMatch(/<span\s+v-else\s+class="pmini"/);
  });

  it('matches the directive-specified pmini/ptrack/pnum structure', () => {
    expect(MINI).toMatch(/class="pmini" role="img" :aria-label="label"/);
    expect(MINI).toMatch(/<span class="ptrack">/);
    expect(MINI).toMatch(/class="pnum"/);
  });
});
