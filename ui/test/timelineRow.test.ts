import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'TimelineRow.vue'),
  'utf8',
);

// Task 2 (friendly role labels): dispatch_decision is the one Timeline event
// type that carries an agent role. Mock-conformance brief item 6 dropped the
// trailing IdentityChip from this row -- the role/tier now renders as plain
// text on the meta line instead, so there is no chip left to carry a title
// tooltip (behaviour deleted, not moved: Kanban/Task detail keep the chip).
describe('TimelineRow.vue — role labels', () => {
  it('imports roleLabel and routes dispatchAgent.label through it', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
    expect(SFC).toMatch(
      /label: p\.model_tier \? `\$\{roleLabel\(p\.agent_role\)\} · \$\{p\.model_tier\}`/,
    );
  });

  it('renders the role · tier label on the meta line, not a trailing chip', () => {
    expect(SFC).not.toMatch(/<IdentityChip/);
    expect(SFC).toMatch(
      /<template v-if="dispatchAgent"> · \{\{ dispatchAgent\.label \}\}<\/template>/,
    );
  });
});

// Task 4 (humanized task label helper): metaFor() now humanizes the taskId
// it shows (lib/timelineDisplay.ts); the raw id stays reachable as a title
// tooltip on the row's meta line rather than disappearing.
describe('TimelineRow.vue — task label tooltip', () => {
  it('keeps the raw taskId as a title tooltip on the meta line', () => {
    expect(SFC).toMatch(
      /<span class="timeline-row__meta"[^>]*:title="entry\.taskId[^"]*"[^\s>]*\s*>\{\{ formatDateTime\(entry\.ts\) \}\} · \{\{ meta \}\}/,
    );
  });
});
