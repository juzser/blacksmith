// Static source-text check, same style as kitLessonCard.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const BADGE = readFileSync(join(KIT, 'AgentStatusBadge.vue'), 'utf8');

describe('kit/AgentStatusBadge.vue', () => {
  it('declares an agent prop and a now test seam', () => {
    expect(BADGE).toMatch(/agent:\s*SessionAgent/);
    expect(BADGE).toMatch(/now\?:\s*string/);
  });

  it('derives its tone and label from lib/agentStatus.js', () => {
    expect(BADGE).toMatch(/from '\.\.\/\.\.\/lib\/agentStatus\.js'/);
    expect(BADGE).toMatch(/agentStatus\(/);
  });

  it('renders through the kit Tag, bound to the derived tone', () => {
    expect(BADGE).toMatch(/<Tag\s+[^>]*:tone="/);
  });
});
