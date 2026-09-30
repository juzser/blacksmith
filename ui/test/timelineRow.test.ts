import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'TimelineRow.vue'),
  'utf8',
);

// Task 2 (friendly role labels): dispatch_decision is the one Timeline event
// type that carries an agent role, rendered on its IdentityChip. The raw
// `role · tier` stays reachable as a title tooltip (IdentityChip forwards an
// unclaimed `title` onto its root element).
describe('TimelineRow.vue — role labels', () => {
  it('imports roleLabel and routes dispatchAgent.label through it', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
    expect(SFC).toMatch(/label: p\.model_tier \? `\$\{roleLabel\(p\.agent_role\)\} · \$\{p\.model_tier\}`/);
  });

  it('keeps the raw role · tier as a title tooltip on the dispatch agent chip', () => {
    expect(SFC).toMatch(/title: p\.model_tier \? `\$\{p\.agent_role\} · \$\{p\.model_tier\}`/);
    expect(SFC).toMatch(/<IdentityChip[^>]*:title="dispatchAgent\.title"/);
  });
});

// Task 4 (humanized task label helper): metaFor() now humanizes the taskId
// it shows (lib/timelineDisplay.ts); the raw id stays reachable as a title
// tooltip on the row's meta line rather than disappearing.
describe('TimelineRow.vue — task label tooltip', () => {
  it('keeps the raw taskId as a title tooltip on the meta line', () => {
    expect(SFC).toMatch(
      /<span class="timeline-row__meta"[^>]*:title="entry\.taskId[^"]*"[^>]*>\{\{ formatDateTime\(entry\.ts\) \}\} · \{\{ meta \}\}<\/span>/,
    );
  });
});
