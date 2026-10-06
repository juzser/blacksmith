// KanbanFollowupGroup.vue / KanbanBoard.vue source contracts for the follow-up
// group (spec 1.2/1.4): native <details> toggle, measured title fit shared with
// the card, compact rows without a per-row border, and auto-open on peek. Same
// source-scrape style as kanbanTaskCardCompact.test.ts: no DOM harness here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p: string[]) => readFileSync(join(UI, ...p), 'utf8');
const GROUP = read('components', 'KanbanFollowupGroup.vue');
const CARD = read('components', 'KanbanTaskCard.vue');
const BOARD = read('components', 'KanbanBoard.vue');
const CSS = read('styles', 'bs-primitives.css');

function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return CSS.slice(start, CSS.indexOf('}', start));
}

describe('KanbanFollowupGroup.vue — native <details> toggle (spec 1.4)', () => {
  it('does not cancel the summary click or duplicate aria-expanded on it', () => {
    expect(GROUP).not.toMatch(/@click\.prevent/);
    expect(GROUP).not.toMatch(/:aria-expanded/);
  });

  it('listens to the details toggle and emits only when the state differs from the prop', () => {
    expect(GROUP).toMatch(/<details[^>]*@toggle="onToggle"/);
    expect(GROUP).toMatch(/\.open\s*!==\s*props\.open/);
  });
});

describe('group title fit (spec 1.2: reuse the measured fit, no CSS clamp)', () => {
  it('uses the shared composable in both the card and the group', () => {
    expect(GROUP).toMatch(/useFittedTitle\(/);
    expect(CARD).toMatch(/useFittedTitle\(/);
    expect(GROUP).not.toMatch(/fitTitleText/);
    expect(CARD).not.toMatch(/fitTitleText/);
  });

  it('drops the CSS line clamp from the group title', () => {
    expect(rule('.bs-kanban-group__title')).not.toMatch(/line-clamp|-webkit-box/);
  });
});

describe('fix rows are compact rows, not cards (spec 1.2)', () => {
  it('has no per-row border box or radius', () => {
    const row = rule('.bs-kanban-group__row');
    expect(row).not.toMatch(/border:\s*1px/);
    expect(row).not.toMatch(/border-radius/);
  });
});

describe('auto-open on peek (spec 1.4)', () => {
  it('the board opens the group holding the peeked task, and the group reveals a hidden row', () => {
    expect(BOARD).toMatch(/watch\(\[peekTaskId/);
    expect(BOARD).toMatch(/findGroupMember\(/);
    expect(GROUP).toMatch(/revealTaskId/);
  });
});
