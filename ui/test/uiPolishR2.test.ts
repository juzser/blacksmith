// UI polish round 2 (operator 2026-10-02, Vietnamese, see brief): Home's
// "Escalation"/"Waiver" tags read as unpadded, the link-variant Button spends
// the accent colour ds-spec.md §1.1 line 126 reserves for primary buttons,
// and "What the factory decided recently" underlines every row where dense
// UI (line 131) wants underline on hover only. Same static source-text style
// as kitButton.test.ts's own "anchor-safe" block: these are CSS rules, not
// component behaviour, so there is nothing to mount.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

// selector is a plain class name like ".bs-tag--sm" — escaped once here so
// call sites never juggle regex metacharacters themselves.
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = PRIMITIVES_CSS.match(re)?.[1];
  expect(match).toBeTruthy();
  return match ?? '';
}

describe('Tag sm/md horizontal padding (ds-spec.md §2.1/§2.5, line ~309)', () => {
  it('.bs-tag--sm has at least 6px of horizontal padding, not the 4px --bs-space-1', () => {
    const body = rule('.bs-tag--sm');
    const match = body.match(/padding:\s*0\s+var\(--bs-space-(\d)\)/);
    expect(match).toBeTruthy();
    const step = Number(match?.[1]);
    // --bs-space-1 is 4px, --bs-space-2 is 8px (bs-tokens.css) — anything
    // from step 2 up clears the 6px floor.
    expect(step).toBeGreaterThanOrEqual(2);
  });

  it('.bs-tag--md keeps at least 6px of horizontal padding too', () => {
    const body = rule('.bs-tag--md');
    const match = body.match(/padding:\s*0\s+var\(--bs-space-(\d)\)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(2);
  });

  it('does not change the sm/md tag heights', () => {
    expect(rule('.bs-tag--sm')).toMatch(/height:\s*16px;/);
    expect(rule('.bs-tag--md')).toMatch(/height:\s*20px;/);
  });
});

describe('.bs-btn--link uses link tokens, not accent (ds-spec.md §1.1 lines 126/131)', () => {
  it('never references --bs-accent', () => {
    const body = rule('.bs-btn--link');
    expect(body).not.toMatch(/--bs-accent\b/);
  });

  it('colours its text and underline from the link tokens', () => {
    const body = rule('.bs-btn--link');
    expect(body).toMatch(/color:\s*var\(--bs-link-text\);/);
    expect(body).toMatch(/text-decoration-color:\s*var\(--bs-link-underline\);/);
  });
});

describe('Dense-UI bare links underline on hover only (ds-spec.md §1.1 line 131)', () => {
  it('a plain <a>/RouterLink has no underline at rest', () => {
    // The shared rule is the bare element selector `a`, not any .bs-btn/.bs-tag
    // class — this read picks out the first top-level `a { ... }` block.
    const match = PRIMITIVES_CSS.match(/(?:^|\n)a\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match?.[1]).toMatch(/text-decoration:\s*none;/);
    expect(match?.[1]).toMatch(/color:\s*var\(--bs-link-text\);/);
  });

  it('underlines on :hover, coloured from --bs-link-underline', () => {
    const match = PRIMITIVES_CSS.match(/(?:^|\n)a:hover\s*\{([^}]*)\}/);
    expect(match).toBeTruthy();
    expect(match?.[1]).toMatch(/text-decoration:\s*underline;/);
  });
});

describe('.bs-iconbtn reaches the 44px touch target at the mobile breakpoint (ds-spec.md line 722)', () => {
  it('desktop (base rule) sizes are unchanged at 22px/28px', () => {
    expect(rule('.bs-iconbtn--sm')).toMatch(/width:\s*22px;/);
    expect(rule('.bs-iconbtn--md')).toMatch(/width:\s*28px;/);
  });

  it('a max-width: 640px block grows .bs-iconbtn to the --bs-touch hit area', () => {
    const blocks = [...PRIMITIVES_CSS.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}\n/g)];
    const withIconbtn = blocks.find(([, body]) => /\.bs-iconbtn\s*\{/.test(body ?? ''));
    expect(withIconbtn).toBeTruthy();
    const iconbtnRule = withIconbtn?.[1]?.match(/\.bs-iconbtn\s*\{([^}]*)\}/)?.[1];
    expect(iconbtnRule).toMatch(/min-width:\s*var\(--bs-touch\);/);
    expect(iconbtnRule).toMatch(/min-height:\s*var\(--bs-touch\);/);
  });
});
