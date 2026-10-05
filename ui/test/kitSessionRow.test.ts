import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const ROW = readFileSync(join(KIT, 'SessionRow.vue'), 'utf8');
const PRIMITIVES_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'bs-primitives.css'),
  'utf8',
);

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

  it('marks the selected row with aria-current and the selected surface token', () => {
    expect(ROW).toMatch(/selected\?:\s*boolean/);
    expect(ROW).toMatch(/:aria-current="selected \? 'true' : undefined"/);
    expect(ROW).toMatch(/'bs-sessionrow--selected':\s*selected/);
  });

  it('uses --bs-surface-selected for the selected row, no accent fill', () => {
    const rule = PRIMITIVES_CSS.match(/\.bs-sessionrow--selected \{([^}]*)\}/)?.[1];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/background:\s*var\(--bs-surface-selected\);/);
  });
});
