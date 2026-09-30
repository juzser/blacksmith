import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'TaskCard.vue'),
  'utf8',
);

// Task 2 (friendly role labels): agentChip() (lib/kanban.ts) now returns a
// friendly `label` ("Builder · mid") alongside a raw `title` ("coder · mid").
// The card's IdentityChip already renders chip.label; it also needs the raw
// pair wired in as a title tooltip (IdentityChip forwards an unclaimed
// `title` onto its root element).
describe('TaskCard.vue — role labels', () => {
  it('keeps the raw role · tier as a title tooltip on the agent chip', () => {
    expect(SFC).toMatch(/<IdentityChip[^>]*:title="chip\.title"/s);
  });
});
