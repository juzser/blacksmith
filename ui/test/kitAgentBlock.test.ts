import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BLOCK = readFileSync(join(KIT, 'AgentBlock.vue'), 'utf8');
const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

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
    expect(BLOCK).toMatch(/tokenDisplay\(agent, props\.now \?\? liveNow\.value\)/);
    expect(BLOCK).toMatch(/<AgentStatusBadge[^>]*:agent="row\.agent"/);
  });

  it('never prints a bare 0 for unmeasured tokens', () => {
    expect(BLOCK).toMatch(/row\.tokens\.kind === 'measured'/);
    expect(BLOCK).toMatch(/CompactNumber/);
  });

  it('puts the title on its own line and time/tokens/badge on a fixed meta line below', () => {
    expect(BLOCK).toMatch(/<span class="bs-agentblock__doing">\{\{ row\.doing \}\}<\/span>/);
    const metaOpen = BLOCK.indexOf('<div class="bs-agentblock__meta">');
    const metaClose = BLOCK.indexOf('</div>', metaOpen);
    expect(metaOpen).toBeGreaterThan(-1);
    const meta = BLOCK.slice(metaOpen, metaClose);
    expect(meta).toMatch(/<RelativeTime/);
    expect(meta).toMatch(/bs-agentblock__tokens/);
    expect(meta).toMatch(/<AgentStatusBadge/);
  });

  it('is a fixed column layout, not a width-dependent wrap', () => {
    const rule = PRIMITIVES_CSS.match(/\.bs-agentblock__row \{([^}]*)\}/)?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/flex-direction:\s*column;/);
    expect(rule).not.toMatch(/flex-wrap:\s*wrap;/);
  });

  it('truncates only the token text with ellipsis, keeping the badge on the same line', () => {
    const rule = PRIMITIVES_CSS.match(/\.bs-agentblock__tokens \{([^}]*)\}/)?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/text-overflow:\s*ellipsis;/);
    const metaRule = PRIMITIVES_CSS.match(/\.bs-agentblock__meta \{([^}]*)\}/)?.[1];
    expect(metaRule).toBeTruthy();
    expect(metaRule).toMatch(/align-items:\s*center;/);
  });
});
