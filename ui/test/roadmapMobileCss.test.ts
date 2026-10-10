// S4 fix round 1 — CSS-level fixes verified by the orchestrator (ds4-s4
// fix brief): status on its own line, a shrinkable id, the waves body
// scoped off a closed <details>, the chevron rotation, and the compact
// WaveList flat rows. Source-text scrape, same convention as
// kitMobileTopBar.test.ts: no DOM harness in this vitest config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('bs-primitives.css — roadmap mobile row status (fix round 1 #1)', () => {
  it('wraps the row so the status can take its own line', () => {
    expect(rule('.bs-roadmap-mobile__row')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('forces the status onto a full-width line, no longer truncated', () => {
    const decl = rule('.bs-roadmap-mobile__row-status');
    expect(decl).toMatch(/flex-basis:\s*100%/);
    expect(decl).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(decl).not.toMatch(/white-space:\s*nowrap/);
  });
});

describe('bs-primitives.css — roadmap mobile row id (fix round 1 #5)', () => {
  it('is shrinkable with ellipsis instead of flex-shrink:0', () => {
    const decl = rule('.bs-roadmap-mobile__row-id');
    expect(decl).not.toMatch(/flex-shrink:\s*0/);
    expect(decl).toMatch(/min-width:\s*0/);
    expect(decl).toMatch(/text-overflow:\s*ellipsis/);
    expect(decl).toMatch(/white-space:\s*nowrap/);
  });
});

describe('bs-primitives.css — roadmap mobile waves disclosure (fix round 1 #2, #3)', () => {
  it('moves body padding/border off the <details> element itself', () => {
    const decl = rule('.bs-roadmap-mobile__waves');
    expect(decl).not.toMatch(/padding:/);
    expect(decl).not.toMatch(/border-top:/);
  });

  it('scopes body padding to an inner wrapper, as the mock .mbody does', () => {
    expect(rule('.bs-roadmap-mobile__waves-body')).toMatch(/padding:/);
  });

  it("draws the divider under the summary only when open, like the mock's .mgroup[open] rule", () => {
    expect(CSS).toMatch(/\.bs-roadmap-mobile__waves\[open\]\s*>\s*summary\s*\{[^}]*border-bottom:/);
  });

  it('rotates the chevron when the <details> is open', () => {
    expect(CSS).toMatch(
      /\.bs-roadmap-mobile__waves\[open\]\s*>\s*summary\s+\.bs-roadmap-mobile__chev\s*\{[^}]*transform:\s*rotate\(180deg\)/,
    );
  });
});

describe('bs-primitives.css — WaveList compact flat rows (fix round 1 #4)', () => {
  it('strips the card chrome under the compact modifier, border-bottom only', () => {
    const decl = rule(
      '.wave-list--compact .wave,\\s*\\n?\\s*.wave-list--compact .wave.cur,\\s*\\n?\\s*.wave-list--compact .wave.next',
    );
    const compactBlock = CSS.slice(CSS.indexOf('.wave-list--compact .wave'));
    expect(compactBlock).toMatch(/border:\s*0/);
    expect(compactBlock).toMatch(/background:\s*none/);
    expect(compactBlock).toMatch(/border-bottom:\s*1px solid var\(--bs-border\)/);
    void decl;
  });

  it('keeps the compact row at the --bs-touch floor (roadmap.spec.ts touch-target regression)', () => {
    const compactBlock = CSS.slice(CSS.indexOf('.wave-list--compact .wave'));
    expect(compactBlock).toMatch(/min-height:\s*var\(--bs-touch\)/);
  });

  it('removes the separator on the last row', () => {
    expect(CSS).toMatch(/\.wave-list--compact \.wave:last-child\s*\{[^}]*border-bottom:\s*0/);
  });
});

describe('bs-primitives.css — current wave row on one line (fix round 2)', () => {
  it('lets .tb-right wrap onto a second line when the row cannot hold it, in compact mode only', () => {
    const decl = rule('.wave-list--compact .whead');
    expect(decl).toMatch(/flex:\s*1/);
    expect(decl).toMatch(/min-width:\s*0/);
    expect(decl).toMatch(/flex-wrap:\s*wrap/);
  });

  it('leaves the unscoped .whead untouched, so desktop stays byte-identical', () => {
    const decl = rule('.whead');
    expect(decl).toMatch(/flex-wrap:\s*wrap/);
    expect(decl).not.toMatch(/flex:\s*1/);
  });

  it('keeps the title at its natural width instead of ellipsizing it (fix round 3)', () => {
    const decl = rule('.wave-list--compact .wave__title');
    expect(decl).toMatch(/flex-shrink:\s*0/);
    expect(decl).toMatch(/white-space:\s*nowrap/);
    expect(decl).not.toMatch(/text-overflow:\s*ellipsis/);
  });

  it('keeps the title + done-count wrapper at its natural width instead of ellipsizing it (fix round 3)', () => {
    const decl = rule('.wave-list--compact .whead > span:first-child');
    expect(decl).toMatch(/flex-shrink:\s*0/);
    expect(decl).toMatch(/white-space:\s*nowrap/);
    expect(decl).not.toMatch(/text-overflow:\s*ellipsis/);
  });

  it('lets .tb-right take the remaining space instead of staying fixed (fix round 3)', () => {
    const decl = rule('.wave-list--compact .tb-right');
    expect(decl).toMatch(/flex:\s*1\s*1\s*auto/);
    expect(decl).toMatch(/min-width:\s*min-content/);
    expect(decl).toMatch(/flex-wrap:\s*nowrap/);
  });

  it('makes the track the element that shrinks, not the number (fix round 4)', () => {
    const pmini = rule('.wave-list--compact .tb-right .pmini');
    expect(pmini).toMatch(/flex:\s*1\s*1\s*auto/);
    expect(pmini).not.toMatch(/min-width:\s*0/);

    const track = rule('.wave-list--compact .tb-right .pmini .ptrack');
    expect(track).toMatch(/flex:\s*1\s*1\s*auto/);
    expect(track).toMatch(/min-width:\s*0/);
  });

  it('keeps the % and the Tag from shrinking in compact mode (fix round 3)', () => {
    const match = CSS.match(
      /\.wave-list--compact \.tb-right \.pmini \.bs-pnum,\s*\n?\s*\.wave-list--compact \.tb-right \.bs-tag\s*\{([^}]*)\}/,
    );
    expect(match?.[1]).toMatch(/flex-shrink:\s*0/);
  });
});
