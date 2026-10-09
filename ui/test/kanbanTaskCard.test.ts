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

  it('row 1 holds the Now/Next tag or the AgentChip and renders only when there is one (no empty band)', () => {
    expect(SRC).toMatch(
      /v-if="!compact && \(markText \|\| chip\)"\s+class="bs-kanban-card__row bs-kanban-card__row--1">[\s\S]*?<AgentChip v-else[^>]*\/>\s*<\/div>/,
    );
  });

  it('no longer renders the Quote icon, its tooltip, or imports them', () => {
    expect(SRC).not.toMatch(/Quote/);
    expect(SRC).not.toMatch(/<Tooltip/);
    expect(SRC).not.toMatch(/Has a linked request/);
    expect(PRIMITIVES_CSS).not.toMatch(/bs-kanban-card__quote/);
  });

  it('keeps the linked-request first line as the optional summary', () => {
    expect(SRC).toMatch(/showSummary\s*=\s*computed/);
    expect(SRC).toMatch(/task\.requestFirstLine/);
  });
});

describe('KanbanTaskCard.vue — title-line copy icon (operator fix 2026-10-05)', () => {
  it('renders the copy IconButton inline inside the title, glued to the last word', () => {
    expect(SRC).toMatch(
      /class="bs-kanban-card__title"[^>]*>\s*\{\{ titleHead \}\}\s*<span\s+class="bs-kanban-card__title-tail"\s*>\s*\{\{ titleTail \}\}\s*<IconButton\s+:icon="Link"\s+:label="copyIdLabel"\s+size="sm"\s+class="bs-kanban-card__title-copy"\s+@click="onCopyTaskId"/,
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

  it('keeps the copy button outside the open button, so its click never opens the card', () => {
    expect(SRC).not.toMatch(/stopPropagation|@click\.stop/);
    expect(SRC).not.toMatch(/role="link"|tabindex/);
  });

  it('gives the title medium font-weight via the design token', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__title');
    expect(block).toMatch(/font-weight:\s*var\(--bs-font-weight-medium\)/);
  });
});

describe('KanbanTaskCard.vue — title-copy icon flows inline with the title text (operator fix 2026-10-06)', () => {
  it('lays the title out as normal inline flow, not a flex row, and does not clamp it', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__title');
    expect(block).not.toMatch(/display:\s*flex/);
    expect(block).not.toMatch(/-webkit-line-clamp/);
    expect(block).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('keeps the last word and the icon together so the icon never wraps alone', () => {
    expect(rule(PRIMITIVES_CSS, '.bs-kanban-card__title-tail')).toMatch(/white-space:\s*nowrap/);
  });

  it('shrinks the icon to 12px with no resting chrome', () => {
    const btn = rule(PRIMITIVES_CSS, '.bs-kanban-card__title-copy .bs-iconbtn');
    expect(btn).toMatch(/width:\s*16px/);
    expect(btn).toMatch(/height:\s*16px/);
    expect(rule(PRIMITIVES_CSS, '.bs-kanban-card__title-copy .bs-icon')).toMatch(/width:\s*12px/);
  });

  it('keeps the 44px phone hit area without growing the line (negative margin)', () => {
    expect(PRIMITIVES_CSS).toMatch(
      /@media \(max-width: 640px\) \{\s*\.bs-kanban-card__title-copy \.bs-iconbtn \{[^}]*min-width:\s*var\(--bs-touch\)[^}]*margin:/,
    );
  });

  it('fits the title to 2 lines by measurement, keeping the icon after the ellipsis', () => {
    // The measurement lives in the composable the follow-up group shares.
    const FIT = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'composables',
        'useFittedTitle.ts',
      ),
      'utf8',
    );
    expect(SRC).not.toMatch(/TITLE_MAX/);
    expect(SRC).toMatch(/useFittedTitle\(/);
    expect(FIT).toMatch(/new ResizeObserver/);
    expect(FIT).toMatch(/\.disconnect\(\)/);
    expect(FIT).toMatch(/TITLE_LINES\s*=\s*2/);
    expect(FIT).toMatch(/fitTitleText\(/);
    expect(SRC).toMatch(/:title="fitted \? title : undefined"/);
    expect(SRC).toMatch(/aria-label="`\$\{title\}\$\{markLabel\}, opens task detail`"/);
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

describe('KanbanTaskCard.vue — row 1 flex roles (operator follow-up fix 2026-10-06)', () => {
  it('keeps the AgentChip at its natural content width, left-aligned, not stretched', () => {
    const block = rule(PRIMITIVES_CSS, '.bs-kanban-card__row--1 .bs-agent-chip');
    expect(block).toMatch(/flex:\s*0 1 auto/);
    expect(block).toMatch(/min-width:\s*0/);
    expect(block).toMatch(/max-width:\s*100%/);
    expect(block).not.toMatch(/flex:\s*1 1 auto/);
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

describe('KanbanTaskCard.vue — Now / Next mark', () => {
  it('shows the mark in the agent chip slot on desktop and in the single tag slot on phone', () => {
    expect(SRC).toMatch(/v-if="!compact && \(markText \|\| chip\)"/);
    expect(SRC).toMatch(/v-if="compact && mark && markText"/);
    expect(SRC).toMatch(/<AgentChip v-else/);
  });

  it('uses the progress tone for Now and the todo tone for Next', () => {
    expect(SRC).toMatch(/mark\.kind === 'now' \? 'progress' : 'todo'/);
  });

  it('names the mark in the open button label', () => {
    expect(SRC).toMatch(/\$\{title\}\$\{markLabel\}, opens task detail/);
    expect(SRC).toMatch(/', next'/);
    expect(SRC).toMatch(/, now \$\{/);
  });

  it('keeps the caption off phone cards and ellipsizes it', () => {
    expect(SRC).toMatch(/v-if="caption && !compact"/);
    expect(rule(PRIMITIVES_CSS, '.bs-kanban-card__caption')).toMatch(/text-overflow:\s*ellipsis/);
  });
});
