import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const ROW = readFileSync(join(KIT, 'SessionRow.vue'), 'utf8');

describe('kit/SessionRow.vue', () => {
  it('declares a session prop and a clickable toggle with a click emit', () => {
    expect(ROW).toMatch(/session:\s*RunningSession/);
    expect(ROW).toMatch(/clickable\?:\s*boolean/);
    expect(ROW).toMatch(/click:\s*\[\]/);
  });

  it('falls back the title to the raw sessionId', () => {
    expect(ROW).toMatch(/session\.title\s*\?\?\s*(props\.)?session\.sessionId/);
  });

  it('shows the project, a RelativeTime start, duration, agent count, and last step', () => {
    expect(ROW).toMatch(/<RelativeTime[^>]*:iso="session\.startedAt"/);
    expect(ROW).toMatch(/session\.liveAgentCount/);
    expect(ROW).toMatch(/lastStepLabel\(props\.session\.lastEventType\)/);
  });

  it('renders as a button only when clickable, like LessonCard', () => {
    expect(ROW).toMatch(/:is="clickable \? 'button' : 'div'"/);
  });

  it('hides the agent count rather than showing a false 0 for a finished run', () => {
    expect(ROW).toMatch(/if\s*\(n\s*<=\s*0\)\s*return null/);
    expect(ROW).toMatch(/v-if="agentCountLabel"/);
  });
});
