// Fix: TimelineRow's "Session" detail link opens the session it names
// instead of the plain /sessions list. SessionsPage (lib/sessionsSelection.ts)
// already supports `?session=<id>` deep links -- this just wires the link
// to carry it. Same DOM-free, source-text contract as the other
// kitTimelineRow*.test.ts files (ui/vitest.config.ts has no DOM).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TIMELINE_ROW = readFileSync(join(KIT, 'TimelineRow.vue'), 'utf8');

describe('kit/TimelineRow.vue Session detail link (deep link fix)', () => {
  it('links through a route object carrying the entry sessionId as a query param', () => {
    expect(TIMELINE_ROW).toMatch(
      /<RouterLink :to="sessionLink">\{\{ entry\.sessionTitle \}\}<\/RouterLink>/,
    );
  });

  it('falls back to the plain /sessions path when sessionId is empty', () => {
    expect(TIMELINE_ROW).toMatch(
      /const sessionLink = computed\(\(\) =>\s*props\.entry\.sessionId\s*\?\s*\{ path: '\/sessions', query: \{ session: props\.entry\.sessionId \} \}\s*:\s*'\/sessions',?\s*\);/,
    );
  });
});
