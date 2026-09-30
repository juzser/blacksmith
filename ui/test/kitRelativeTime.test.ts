// RelativeTime's contract (ds-spec.md §2.1): `iso`, `now?` (test seam);
// renders "5 min ago" / "2 h ago" / "3 d ago" inside a `<time datetime>`; the
// absolute time ("30 Sep 2026, 14:07:12") in a `Tooltip` (describe mode, the
// element is focusable), not a `title` attribute. Same static source-text
// style as kitButton.test.ts: ui/vitest.config.ts is DOM-free by design, and
// DS0 adds no call site for RelativeTime (§5, "no page imports the new kit
// yet"), so there is nothing yet for a mounted test to check a real usage
// against — these assertions read the .vue file's own text instead. The
// underlying formatting logic (formatAbsolute/formatRelativeVerbose) has its
// own full behavioural coverage in ui/test/format.test.ts; this file only
// checks that the component wires that logic and Tooltip together correctly.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const RELATIVE_TIME = readFileSync(join(KIT, 'RelativeTime.vue'), 'utf8');

describe('kit/RelativeTime.vue', () => {
  it('declares iso as a required prop and now as the optional test seam', () => {
    expect(RELATIVE_TIME).toMatch(/iso:\s*string;/);
    expect(RELATIVE_TIME).toMatch(/now\?:\s*string;/);
  });

  it('formats the visible text with formatRelativeVerbose, not formatRelative', () => {
    expect(RELATIVE_TIME).toMatch(
      /import\s*\{[^}]*formatRelativeVerbose[^}]*\}\s*from\s*'..\/..\/lib\/format\.js';/,
    );
    expect(RELATIVE_TIME).not.toMatch(/[^.]formatRelative\(/);
  });

  it('formats the tooltip text with formatAbsolute', () => {
    expect(RELATIVE_TIME).toMatch(
      /import\s*\{[^}]*formatAbsolute[^}]*\}\s*from\s*'..\/..\/lib\/format\.js';/,
    );
  });

  it('falls back to a live clock via useNow when now is omitted, never reading Date.now() itself', () => {
    expect(RELATIVE_TIME).toMatch(
      /import\s*\{\s*useNow\s*\}\s*from\s*'..\/..\/composables\/useNow\.js';/,
    );
    expect(RELATIVE_TIME).toMatch(/props\.now\s*\?\?/);
    expect(RELATIVE_TIME).not.toMatch(/Date\.now\(\)/);
  });

  it('renders the relative text inside a <time datetime> element, not a plain span', () => {
    expect(RELATIVE_TIME).toMatch(/<time\s+:datetime="iso">/);
  });

  it('wraps the <time> in a describe-mode Tooltip carrying the absolute text, not a title attribute', () => {
    expect(RELATIVE_TIME).toMatch(/<Tooltip\s+mode="describe"\s+:text="absolute"/);
    expect(RELATIVE_TIME).not.toMatch(/title="/);
  });
});
