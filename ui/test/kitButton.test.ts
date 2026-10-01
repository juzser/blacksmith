// Button's contract (ds-spec.md §2.1): `variant: primary|secondary|ghost|
// danger|link`, `size: sm|md`, `icon?`, states "default, hover, pressed,
// disabled, loading (spinner replaces label, width locked)". Same static
// source-text style as kitIconButton.test.ts: ui/vitest.config.ts is
// DOM-free by design, and DS0 adds no call site for Button (§5, "no page
// imports the new kit yet"), so there is nothing yet for vueContract.test.ts
// to check a real usage against — these assertions read the .vue file's own
// text instead.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BUTTON = readFileSync(join(KIT, 'Button.vue'), 'utf8');
const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

describe('kit/Button.vue', () => {
  it('declares the five variants from §2.1, nothing else', () => {
    const match = BUTTON.match(/variant\?:\s*'([^']+)'(?:\s*\|\s*'([^']+)')*/);
    expect(match).not.toBeNull();
    expect(BUTTON).toMatch(
      /variant\?:\s*'primary'\s*\|\s*'secondary'\s*\|\s*'ghost'\s*\|\s*'danger'\s*\|\s*'link';/,
    );
  });

  it('declares the two sizes from §2.1, nothing else', () => {
    expect(BUTTON).toMatch(/size\?:\s*'sm'\s*\|\s*'md';/);
  });

  it('takes icon as an optional Lucide component, like IconButton', () => {
    expect(BUTTON).toMatch(/icon\?:\s*Component;/);
  });

  it('defaults variant to primary and size to md', () => {
    const match = BUTTON.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/variant:\s*'primary'/);
    expect(match?.[1]).toMatch(/size:\s*'md'/);
  });

  it('guards clicks via aria-disabled + a click handler, never the native disabled attribute (S2-4: native disabled drops focus while loading)', () => {
    expect(BUTTON).toMatch(/:aria-disabled="isBlocked\s*\?\s*'true'\s*:\s*undefined"/);
    expect(BUTTON).not.toMatch(/:disabled=/);
    expect(BUTTON.match(/<button\b[^>]*>/)?.[0]).not.toMatch(/\bdisabled\b/);
    expect(BUTTON).toMatch(/if\s*\(isBlocked\.value\)\s*return;/);
  });

  it('sets aria-busy while loading, so a screen reader announces the pending state', () => {
    expect(BUTTON).toMatch(/:aria-busy="loading\s*\?\s*'true'\s*:\s*undefined"/);
  });

  it("renders the loading spinner from a real Lucide component, not a string icon name, matching Icon's icon prop contract", () => {
    expect(BUTTON).toMatch(/import\s*\{\s*LoaderCircle\s*\}\s*from\s*'@lucide\/vue';/);
    expect(BUTTON).toMatch(/<Icon[^>]*:icon="LoaderCircle"/);
  });

  it('keeps the label in the DOM while loading (hidden, not removed) so the button width does not change', () => {
    expect(BUTTON).toMatch(/bs-btn__label--hidden/);
    expect(BUTTON).not.toMatch(/v-if="!loading"[^>]*>\s*<slot/);
  });

  it('never hardcodes a Lucide icon size other than the shared 14|16|20 scale', () => {
    const sizes = [...BUTTON.matchAll(/:size="(\d+)"/g)].map((m) => Number(m[1]));
    for (const size of sizes) {
      expect([14, 16, 20]).toContain(size);
    }
  });
});

// Visual-pass follow-up: the mobile home screenshot showed the "Decide"
// button underlined like a plain link. Button.vue's root element is
// `role`-agnostic — NeedsYouInbox.vue puts `.bs-btn.bs-btn--primary` on a
// RouterLink, which renders as a real `<a>` — so a `.bs-btn` that sets no
// text-decoration falls through to the browser's default anchor underline.
// `.bs-btn--link` (a sibling modifier, untouched here) intentionally adds
// the underline back on hover; that is a different, deliberate case.
describe('.bs-btn primitive (bs-primitives.css) — anchor-safe', () => {
  it('drops the default underline so any anchor wearing .bs-btn renders as a button, not a link', () => {
    const rule = PRIMITIVES_CSS.match(/\.bs-btn\s*\{([^}]*)\}/)?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/text-decoration:\s*none;/);
  });
});
