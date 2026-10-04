import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BLOCK = readFileSync(join(KIT, 'AgentBlock.vue'), 'utf8');

describe('kit/AgentBlock.vue', () => {
  it('declares agentRole/agents props', () => {
    expect(BLOCK).toMatch(/agentRole:\s*string/);
    expect(BLOCK).toMatch(/agents:\s*SessionAgent\[\]/);
  });

  it('labels the role with the friendly roleLabel word', () => {
    expect(BLOCK).toMatch(/from '\.\.\/\.\.\/lib\/roleLabels\.js'/);
    expect(BLOCK).toMatch(/roleLabel\(agentRole\)/);
  });

  it('shows each agent doing its last step, a RelativeTime duration, tokens, and a status badge', () => {
    expect(BLOCK).toMatch(/lastStepLabel\(agent\.lastEventType\)/);
    expect(BLOCK).toMatch(/<RelativeTime[^>]*:iso="row\.agent\.dispatchedAt"/);
    expect(BLOCK).toMatch(/tokenDisplay\(agent\)/);
    expect(BLOCK).toMatch(/<AgentStatusBadge[^>]*:agent="row\.agent"/);
  });

  it('never prints a bare 0 for unmeasured tokens', () => {
    expect(BLOCK).toMatch(/row\.tokens\.kind === 'measured'/);
    expect(BLOCK).toMatch(/CompactNumber/);
  });
});
