// Tag's contract (ds-spec.md §2.1 line 369, §2.5 line 444) — replaces the old
// kit's Lozenge ("jargon nobody outside a design system says out loud"), same
// subtle/bold/outline contract, mapped onto the 7 status tones in §1.1 plus
// the 8th "neutral" tone (a spec gap, same as Banner's "info" — see
// bs-tokens.css's own comment on --bs-tone-neutral-text). Static, no
// interactive state (§2.1: "static (no interactive state)"). Same static
// source-text style as kitButton.test.ts: ui/vitest.config.ts is DOM-free by
// design, and DS0 adds no call site for Tag (§5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TAG = readFileSync(join(KIT, 'Tag.vue'), 'utf8');

describe('kit/Tag.vue', () => {
  it('declares the 8 tones from §2.1 (7 status tones + neutral), nothing else', () => {
    expect(TAG).toMatch(
      /tone\?:\s*'done'\s*\|\s*'review'\s*\|\s*'progress'\s*\|\s*'todo'\s*\|\s*'blocked'\s*\|\s*'danger'\s*\|\s*'warning'\s*\|\s*'neutral';/,
    );
  });

  it('declares the three variants from §2.5 (subtle/bold/outline)', () => {
    expect(TAG).toMatch(/variant\?:\s*'subtle'\s*\|\s*'bold'\s*\|\s*'outline';/);
  });

  it('declares the two sizes from §2.1', () => {
    expect(TAG).toMatch(/size\?:\s*'sm'\s*\|\s*'md';/);
  });

  it('defaults tone to neutral, variant to subtle, size to md', () => {
    const match = TAG.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/tone:\s*'neutral'/);
    expect(match?.[1]).toMatch(/variant:\s*'subtle'/);
    expect(match?.[1]).toMatch(/size:\s*'md'/);
  });

  it('reads only the two existing bs-tone-<tone>-text/-subtle tokens (no invented "-bold" tier)', () => {
    expect(TAG).toMatch(/--bs-tone-\$\{.*tone.*\}-text/);
    expect(TAG).toMatch(/--bs-tone-\$\{.*tone.*\}-subtle/);
    expect(TAG).not.toMatch(/-bold`/);
    expect(TAG).not.toMatch(/var\(--(?:ds|bs)-text-on-bold/);
  });

  it('renders a static bs-tag base class plus variant/size modifier classes', () => {
    expect(TAG).toMatch(/class="bs-tag"/);
    expect(TAG).toMatch(/bs-tag--\$\{.*variant.*\}/);
    expect(TAG).toMatch(/bs-tag--\$\{.*size.*\}/);
  });

  it('is static: no click handler, no emits, no interactive ARIA role', () => {
    expect(TAG).not.toMatch(/defineEmits/);
    expect(TAG).not.toMatch(/@click/);
    expect(TAG).not.toMatch(/role="button"/);
  });
});
