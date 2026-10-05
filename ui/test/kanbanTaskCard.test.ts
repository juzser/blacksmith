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
      /<span\s+v-if="hasWaiting"\s+class="bs-kanban-card__footer-dep"\s+:title="footerDependency"\s*>\{\{ footerDependency \}\}<\/span\s*>/,
    );
  });
});

describe('KanbanTaskCard.vue — row 1 drops the id text (operator fix 2026-10-05)', () => {
  it('does not render the id span in row 1 any more', () => {
    expect(SRC).not.toMatch(/<span class="bs-kanban-card__id"/);
  });

  it('does not render a "Copy task id" IconButton in row 1', () => {
    expect(SRC).not.toMatch(/:icon="Copy"/);
  });

  it('row 1 starts with the AgentChip, then the Quote trigger', () => {
    expect(SRC).toMatch(
      /class="bs-kanban-card__row bs-kanban-card__row--1">\s*<AgentChip[\s\S]*?<Tooltip[^>]*class="bs-kanban-card__quote"/,
    );
  });
});

describe('KanbanTaskCard.vue — title-line copy icon (operator fix 2026-10-05)', () => {
  it('renders a link IconButton right after the title text', () => {
    expect(SRC).toMatch(
      /class="bs-kanban-card__title">\s*\{\{ title \}\}\s*<IconButton\s+:icon="Link"\s+:label="copyIdLabel"\s+size="sm"\s+class="bs-kanban-card__title-copy"\s+@click="onCopyTaskId"/,
    );
  });

  it('seeds the tooltip label with the full task id plus "(click to copy)"', () => {
    expect(SRC).toMatch(
      /copyIdTooltip\s*=\s*computed\(\s*\(\)\s*=>\s*`\$\{props\.task\.taskId\}\s*\(click to copy\)`\s*\)/,
    );
    expect(SRC).toMatch(/useCopyFeedback\(copyIdTooltip\.value,\s*'Copied'\)/);
  });

  it('copies the full task.taskId to the clipboard via the shared clipboard helper', () => {
    expect(SRC).toMatch(/import\s*\{\s*copyToClipboard\s*\}\s*from\s*'\.\.\/lib\/clipboard\.js'/);
    expect(SRC).toMatch(/copyToClipboard\(props\.task\.taskId\)/);
  });

  it('stops the click from propagating to the card, so it never opens the peek panel', () => {
    expect(SRC).toMatch(
      /function onCopyTaskId\(event: MouseEvent\) \{\s*event\.stopPropagation\(\);/,
    );
  });

  it('gives the title medium font-weight via the design token', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__title');
    expect(block).toMatch(/font-weight:\s*var\(--bs-font-weight-medium\)/);
  });
});

describe('KanbanTaskCard.vue — footer hides "Waits for: nothing" with no dependencies (operator fix 2026-10-05)', () => {
  it('gates the footer-dep span on a dependency still being waited on, not on the raw array length', () => {
    expect(SRC).toMatch(
      /const hasWaiting = computed\(\(\) => hasWaitingDependency\(props\.task\.dependencies\)\)/,
    );
    expect(SRC).toMatch(/<span\s+v-if="hasWaiting"\s+class="bs-kanban-card__footer-dep"/);
    expect(SRC).not.toMatch(/task\.dependencies\.length > 0/);
  });
});

describe('KanbanTaskCard.vue — row 1 flex roles (operator follow-up fix 2026-10-05)', () => {
  it('makes the AgentChip the element that grows and ellipsises first, not the id', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-agent-chip');
    expect(block).toMatch(/flex:\s*1 1 auto/);
    expect(block).toMatch(/min-width:\s*0/);
    expect(block).not.toMatch(/max-width/);
  });

  it('keeps the Quote icon from ever shrinking', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-tooltip-trigger');
    expect(block).toMatch(/flex:\s*none/);
  });
});

describe('KanbanTaskCard.vue — row 1 Quote icon sits at the right edge with no chip (review follow-up S4, 2026-10-05)', () => {
  // AgentChip renders no element at all when it has nothing to show (its
  // template root is a `v-if="chip && text"` Tag — see AgentChip.vue), so a
  // chip-less row 1 only has the Quote trigger left in it.
  it('does not stretch row 1 with justify-content: space-between', () => {
    expect(PRIMITIVES_CSS).not.toMatch(
      /\.bs-kanban-card__row--1\s*\{\s*justify-content:\s*space-between;/,
    );
  });

  it('pins the Quote tooltip trigger to the right edge via margin-left: auto', () => {
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
