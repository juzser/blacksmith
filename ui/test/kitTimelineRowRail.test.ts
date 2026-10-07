// DS6 PR3 r3 (ds-spec.md §2.2/§1.5): the `rail` variant TimelineRow adds for
// `RunHistoryTimeline` — no stripe, a rail dot/line from the shared `--tl-*`
// geometry tokens instead, time via `RelativeTime`, an optional outcome
// `Tag`, same EventKindTag/meta-line/chevron rules as every other variant.
// Same DOM-free, source-text contract as kitTag.test.ts (ui/vitest.config.ts
// has no DOM; component behavior is Playwright's job, this is structure).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TIMELINE_ROW = readFileSync(join(KIT, 'TimelineRow.vue'), 'utf8');
const RUN_HISTORY = readFileSync(join(dirname(KIT), 'RunHistoryTimeline.vue'), 'utf8');

describe('kit/TimelineRow.vue rail variant', () => {
  it('declares an opt-in rail variant prop', () => {
    expect(TIMELINE_ROW).toMatch(/variant\?:\s*'rail'\s*\|\s*'compact';/);
  });

  it('declares the rail-only override props (TaskRun has no eventType/payload)', () => {
    expect(TIMELINE_ROW).toMatch(/titleOverride\?:\s*string;/);
    expect(TIMELINE_ROW).toMatch(/metaOverride\?:\s*string;/);
    expect(TIMELINE_ROW).toMatch(
      /tag\?:\s*\{\s*tone:\s*KitTone;\s*label:\s*string\s*\}\s*\|\s*null;/,
    );
  });

  it('title/meta prefer the override before falling back to titleFor/metaFor', () => {
    expect(TIMELINE_ROW).toMatch(/props\.titleOverride\s*\?\?\s*titleFor\(props\.entry\)/);
    expect(TIMELINE_ROW).toMatch(/props\.metaOverride\s*\?\?\n?\s*metaFor\(/);
  });

  it('binds the rail class only when variant is rail, same EventKindTag/meta/chevron markup', () => {
    expect(TIMELINE_ROW).toMatch(/'bs-timeline-row--rail': variant === 'rail'/);
    expect(TIMELINE_ROW).toMatch(/<EventKindTag :kind="kind" \/>/);
    expect(TIMELINE_ROW).toMatch(
      /<Tag v-if="statusTag" :tone="statusTag\.tone" variant="subtle" size="sm"/,
    );
  });

  it('renders the time column with RelativeTime on every variant (DS6 PR4b round 2 item 4)', () => {
    expect(TIMELINE_ROW).toMatch(/<RelativeTime class="bs-timeline-row__ts" :iso="entry\.ts" \/>/);
  });

  it('hides the dl "Task" pair on rows with no task, instead of "not measured"', () => {
    expect(TIMELINE_ROW).toMatch(/<template v-if="entry\.taskId">\s*<dt>Task<\/dt>/);
    expect(TIMELINE_ROW).toMatch(/<dd>\{\{ entry\.taskId \}\}<\/dd>/);
    expect(TIMELINE_ROW).not.toMatch(/not measured/);
  });

  it('stops the 1 s tick once the dispatch is past the stale window', () => {
    expect(TIMELINE_ROW).toMatch(/isPastStaleWindow\(props\.entry\.ts/);
    // The window check reads the reactive clock, not a bare `new Date()` that
    // Vue caches, and the interval is cleared when the row stops running.
    expect(TIMELINE_ROW).toMatch(/props\.ctx\?\.now \?\? tickNow\.value/);
    expect(TIMELINE_ROW).toMatch(/watch\(stillRunning,[\s\S]*?clearInterval\(timer\)/);
  });

  it('skips the dl "Task" row on rail rows (TaskRun carries no taskId)', () => {
    expect(TIMELINE_ROW).toMatch(/<template v-if="variant !== 'rail'">/);
  });
});

describe('RunHistoryTimeline.vue rail rendering', () => {
  it('renders each run through the kit TimelineRow, not its own row markup', () => {
    expect(RUN_HISTORY).toMatch(/<TimelineRow/);
    expect(RUN_HISTORY).not.toMatch(/class="timeline-row"/);
    expect(RUN_HISTORY).not.toMatch(/timeline-row__ktag/);
  });

  it('passes variant="rail" and the title/meta/tag overrides', () => {
    expect(RUN_HISTORY).toMatch(/variant="rail"/);
    expect(RUN_HISTORY).toMatch(/:title-override="label\(run\)"/);
    expect(RUN_HISTORY).toMatch(/:meta-override="tokens\(run\)"/);
    expect(RUN_HISTORY).toMatch(/:tag="outcomeTag\(run\)"/);
  });

  it('maps a judge-verdict run to the feedback row kind', () => {
    expect(RUN_HISTORY).toMatch(/'judge-verdict': 'feedback'/);
  });

  it('keeps list semantics (role="list", TimelineRow renders the <li>s)', () => {
    expect(RUN_HISTORY).toMatch(
      /<ol v-if="runs\.length > 0" class="bs-run-history timeline-feed" role="list">/,
    );
  });

  it('maps outcome to a Tag tone via runOutcomeKitTone, null when there is no outcome', () => {
    expect(RUN_HISTORY).toMatch(
      /function outcomeTag\(run: TaskRun\): \{ tone: KitTone; label: string \} \| null \{/,
    );
    expect(RUN_HISTORY).toMatch(/if \(run\.outcome === null\) return null;/);
    expect(RUN_HISTORY).toMatch(/runOutcomeKitTone\(run\.kind, run\.outcome\)/);
  });

  it('computes the gate status tag when no tag prop is given, never on the rail', () => {
    expect(TIMELINE_ROW).toMatch(/gateStatusTag\(props\.entry\)/);
    expect(TIMELINE_ROW).toMatch(/props\.variant !== 'rail'/);
    expect(TIMELINE_ROW).toMatch(/<Tag v-if="statusTag" :tone="statusTag\.tone"/);
    expect(TIMELINE_ROW).toMatch(/<Icon v-if="statusIcon" :icon="statusIcon"/);
  });

  it('keeps the chevron on a gate row whose meta is empty (Task/Session still show)', () => {
    expect(TIMELINE_ROW).toMatch(/meta\.value !== '' \|\| \(kind\.value === 'gate'/);
  });
});
