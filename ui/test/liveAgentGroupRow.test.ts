import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'LiveAgentGroupRow.vue'),
  'utf8',
);

// Task 2 (friendly role labels): the group's disclosure trigger IdentityChip
// currently shows the raw taxonomy role. roleLabel() makes it read "Builder ·
// sonnet" instead of "coder · sonnet"; the raw pair stays reachable as a
// title tooltip (IdentityChip forwards an unclaimed `title` onto its root).
describe('LiveAgentGroupRow.vue — role labels', () => {
  it('imports roleLabel and routes the group chip label through it', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
    expect(SFC).toMatch(
      /:label="`\$\{roleLabel\(group\.agentRole\)\} · \$\{group\.modelTier\}`"/,
    );
  });

  it('keeps the raw role · tier as a title tooltip on the group chip', () => {
    expect(SFC).toMatch(
      /<IdentityChip[^>]*:title="`\$\{group\.agentRole\} · \$\{group\.modelTier\}`"/s,
    );
  });
});
