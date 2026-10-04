// Static source-text check, same style as kitTabs.test.ts — the SFC itself
// carries no logic beyond calling the already-tested lessonLabels helpers,
// so this asserts the wiring: every sentence ds-spec.md §4.5 calls for
// comes from one of those helpers, and compact/clickable toggle the markup
// the shell table (ds-spec.md:807) and the list each need.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const CARD = readFileSync(join(KIT, 'LessonCard.vue'), 'utf8');

describe('kit/LessonCard.vue', () => {
  it('declares lesson/compact/clickable props and a click emit', () => {
    expect(CARD).toMatch(/lesson:\s*LessonRecord/);
    expect(CARD).toMatch(/compact\?:\s*boolean/);
    expect(CARD).toMatch(/clickable\?:\s*boolean/);
    expect(CARD).toMatch(/click:\s*\[\]/);
  });

  it('renders the rule, the scope label, the learned-from line, and the prevented line', () => {
    expect(CARD).toMatch(/lesson\.statement/);
    expect(CARD).toMatch(/lessonScopeLabel\(/);
    expect(CARD).toMatch(/learnedFromLabel\(/);
    expect(CARD).toMatch(/preventedLabel\(/);
  });

  // ds-review.html .mm: the phone meta line uses the short wording, never
  // the desktop card's full sentence helpers.
  it('uses the short-form helpers in the compact meta line', () => {
    const compactBlock = CARD.slice(CARD.indexOf('v-if="compact"'), CARD.indexOf('v-else'));
    expect(compactBlock).toMatch(/shortLearnedFromLabel\(/);
    expect(compactBlock).toMatch(/shortPreventedLabel\(/);
    expect(compactBlock).not.toMatch(/[^t]learnedFromLabel\(/);
    expect(compactBlock).not.toMatch(/[^t]preventedLabel\(/);
  });

  // ds-spec.md shell table (:807) names "one-line lesson rows"; the binding
  // mock (ds-review.html .mrow) is the two-line grid that actually ships.
  it('has a compact grid layout distinct from the full card', () => {
    expect(CARD).toMatch(/v-if="compact"/);
    expect(CARD).toMatch(/bs-lessoncard--compact/);
  });

  // clickable switches the root element rather than wrapping a second time,
  // so the same markup serves both the list row and the Dialog's read-only body.
  it('renders as a button only when clickable', () => {
    expect(CARD).toMatch(/:is="clickable \? 'button' : 'div'"/);
  });

  // ds-review.html ~1491 mobile Lessons row: title, then scope tag, then the
  // muted meta line, in that DOM order (the compact row has no CSS `order`
  // override, so markup order is visual order).
  it('orders the compact row as statement, then scope tag, then meta', () => {
    const compactBlock = CARD.slice(CARD.indexOf('v-if="compact"'), CARD.indexOf('v-else'));
    const statementIndex = compactBlock.indexOf('bs-lessoncard__statement');
    const tagIndex = compactBlock.indexOf('<Tag');
    const metaIndex = compactBlock.indexOf('bs-lessoncard__meta');
    expect(statementIndex).toBeGreaterThan(-1);
    expect(tagIndex).toBeGreaterThan(statementIndex);
    expect(metaIndex).toBeGreaterThan(tagIndex);
  });
});
