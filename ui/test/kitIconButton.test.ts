// IconButton's a11y contract (ds-spec.md §2.1/§2.5) rests on `label` being a
// REQUIRED prop: TypeScript then refuses any call site that omits it, and
// vueContract.test.ts enforces that at every call site once one exists. This
// PR adds no call site (§5, DS0: "no page imports the new kit yet"), so that
// enforcement has nothing to bite on yet — these are static checks on the
// source text instead, the same style dsVariants.test.ts uses for a
// constraint TypeScript enforces but nothing else in the repo verifies stays
// true as the file is edited. Nothing here mounts IconButton: ui/vitest.config.ts
// is DOM-free by design (see useTooltip.test.ts's header comment), so the
// actual click/hover/focus behaviour is Playwright's job once a later PR
// gives it a page to render on.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const ICON_BUTTON = readFileSync(join(KIT, 'IconButton.vue'), 'utf8');

describe('kit/IconButton.vue', () => {
  it('declares label as a required prop, not optional', () => {
    expect(ICON_BUTTON).toMatch(/\n\s*label:\s*string;/);
    expect(ICON_BUTTON).not.toMatch(/\n\s*label\?:\s*string;/);
  });

  it('does not default label in withDefaults — a required prop has no default', () => {
    const match = ICON_BUTTON.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toMatch(/\blabel\s*:/);
  });

  it('takes label to both a Tooltip (mode="label") and the button aria-label, per the icon-only rule (§2.5)', () => {
    expect(ICON_BUTTON).toMatch(/<Tooltip\s+mode="label"\s+:text="label"/);
    expect(ICON_BUTTON).toMatch(/:aria-label="label"/);
  });

  it('renders aria-disabled rather than the native disabled attribute, so a focused tooltip still shows (§2.1)', () => {
    expect(ICON_BUTTON).toMatch(/:aria-disabled=/);
    expect(ICON_BUTTON).not.toMatch(/\sdisabled\s*(?:=|>|\/)/);
  });

  // tone (Batch C, Toast's dismiss button): Toast is a deliberately inverted
  // surface (background: var(--bs-text); color: var(--bs-surface), see
  // Toast.vue's own comment), and .bs-iconbtn's default colour/hover assume a
  // normal surface — a plain IconButton would render a dim grey icon on the
  // dark toast. tone is optional and defaults to 'default' so every existing
  // call site (none yet, but the contract) is unaffected.
  it('declares an optional tone prop, default|inverse, defaulting to default', () => {
    expect(ICON_BUTTON).toMatch(/tone\?:\s*'default'\s*\|\s*'inverse';/);
    const match = ICON_BUTTON.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/tone:\s*'default'/);
  });

  it('applies a bs-iconbtn--inverse class when tone is inverse', () => {
    expect(ICON_BUTTON).toMatch(/bs-iconbtn--inverse/);
  });
});
