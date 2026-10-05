// KanbanTaskCard.vue chip variant + duplicate-role gating (ui-polish audit
// findings 2 and 5, ds-spec.md §2 Tag/TaskCard). Source-text scrape, same
// style as kanbanTaskCardCompact.test.ts: no DOM harness in this config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'KanbanTaskCard.vue'),
  'utf8',
);
const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = css.match(re)?.[1];
  expect(match).toBeTruthy();
  return match ?? '';
}

describe('KanbanTaskCard.vue — card chip variant (audit finding 2)', () => {
  it('does not hardcode variant="outline" on the card chips, so Tag renders its subtle default', () => {
    expect(SRC).not.toMatch(/variant="outline"/);
  });
});

describe('KanbanTaskCard.vue — footer dependency line (operator fix 2026-10-05)', () => {
  it('clamps the footer dependency text to one line with a native title tooltip', () => {
    expect(SRC).toMatch(
      /<span class="bs-kanban-card__footer-dep" :title="footerDependency">\{\{ footerDependency \}\}<\/span>/,
    );
  });
});

describe('KanbanTaskCard.vue — row 1 id stays on one line (operator fix 2026-10-05)', () => {
  it('carries the full task id as a title tooltip on the id element', () => {
    expect(SRC).toMatch(
      /<span class="bs-kanban-card__id" :title="task\.taskId">\{\{ shortId \}\}<\/span>/,
    );
  });
});

describe('KanbanTaskCard.vue — row 1 copy-id button (ds-review.html mock, ds-spec.md §2.2 TaskCard)', () => {
  it('renders a sm IconButton labelled "Copy task id" right after the id, before the AgentChip', () => {
    expect(SRC).toMatch(
      /<span class="bs-kanban-card__id"[^>]*>\{\{ shortId \}\}<\/span>\s*<IconButton\s+:icon="Copy"\s+:label="copyIdLabel"\s+size="sm"\s+@click="onCopyTaskId"\s*\/>\s*<AgentChip/,
    );
  });

  it('copies the full task.taskId to the clipboard via the shared clipboard helper', () => {
    expect(SRC).toMatch(/import\s*\{\s*copyToClipboard\s*\}\s*from\s*'\.\.\/lib\/clipboard\.js'/);
    expect(SRC).toMatch(/copyToClipboard\(props\.task\.taskId\)/);
  });

  it('uses useCopyFeedback for the idle/"Copied" label, seeded with "Copy task id"', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*useCopyFeedback\s*\}\s*from\s*'\.\.\/composables\/useCopyFeedback\.js'/,
    );
    expect(SRC).toMatch(/useCopyFeedback\('Copy task id'\)/);
  });

  it('stops the click from propagating to the card, so it never opens the peek panel', () => {
    expect(SRC).toMatch(
      /function onCopyTaskId\(event: MouseEvent\) \{\s*event\.stopPropagation\(\);/,
    );
  });
});

describe('KanbanTaskCard.vue — row 1 flex roles (operator follow-up fix 2026-10-05)', () => {
  it('caps the id at 50% with flex-shrink 0, so it never loses width to the chip', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-kanban-card__id');
    expect(block).toMatch(/flex:\s*0 0 auto/);
    expect(block).toMatch(/max-width:\s*50%/);
  });

  it('makes the AgentChip the element that grows and ellipsises first, not the id', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-agent-chip');
    expect(block).toMatch(/flex:\s*1 1 auto/);
    expect(block).toMatch(/min-width:\s*0/);
    expect(block).not.toMatch(/max-width/);
  });

  it('keeps the copy-id button and Quote icon from ever shrinking', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-tooltip-trigger');
    expect(block).toMatch(/flex:\s*none/);
  });
});

describe('KanbanTaskCard.vue — row 1 copy button sits next to the id with no chip (review follow-up S4, 2026-10-05)', () => {
  // AgentChip renders no element at all when it has nothing to show (its
  // template root is a `v-if="chip && text"` Tag — see AgentChip.vue), so a
  // chip-less row 1 only has the id, the copy button and the Quote
  // trigger. Whether that leaves the copy button ~12px from the id — a
  // layout computation this `environment: 'node'` suite has no DOM for —
  // is proved by ui/e2e/kanban.spec.ts "desktop: the copy-id button sits
  // right after the id on a card with no AgentChip". This only pins the
  // source rules that make that possible.
  it('does not stretch row 1 with justify-content: space-between', () => {
    expect(PRIMITIVES_CSS).not.toMatch(
      /\.bs-kanban-card__row--1\s*\{\s*justify-content:\s*space-between;/,
    );
  });

  // IconButton wraps its button in a Tooltip, so the copy button is a
  // `.bs-tooltip-trigger` too: margin-left: auto on that shared class pushed
  // the copy button to the right edge. Only the Quote trigger may carry it.
  it('pins only the Quote tooltip trigger to the right edge via margin-left: auto', () => {
    expect(SRC).toMatch(/<Tooltip[^>]*class="bs-kanban-card__quote"/);
    const quote = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-kanban-card__quote');
    expect(quote).toMatch(/margin-left:\s*auto/);
    const shared = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-tooltip-trigger');
    expect(shared).not.toMatch(/margin-left/);
  });
});

describe('KanbanTaskCard.vue — hide duplicate role label (audit finding 5)', () => {
  it('imports agentChip to know whether an AgentChip is already carrying the role', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bagentChip\b[^}]*\}\s*from\s*'\.\.\/lib\/kanban\.js'/);
  });

  it('gates showRoleLabel on there being no AgentChip for the task', () => {
    expect(SRC).toMatch(/showRoleLabel\s*=\s*computed\(\s*\(\)\s*=>[^;]*!chip\.value/);
  });
});
