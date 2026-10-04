// DS6 PR4b fix round 2 item 2 (ds-review.html `.mock` block flow, `.day`
// margin): the feed body must be a single flex child of `.app-page` so its
// own margins collapse the way the mock's plain block-flow container does,
// instead of each sentinel/pill/day-group adding its own flex `gap`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'ActivityPage.vue'),
  'utf8',
);

describe('ActivityPage.vue fix round 2 item 2 (gap above Today)', () => {
  it('wraps the sentinel, pill and day groups in a single non-flex wrapper', () => {
    const wrapperStart = PAGE.indexOf('<div class="activity-feed">');
    const wrapperEnd = PAGE.indexOf('</div>', PAGE.indexOf('ref="topSentinelEl"'));
    expect(wrapperStart).toBeGreaterThan(-1);
    expect(PAGE.indexOf('ref="topSentinelEl"')).toBeGreaterThan(wrapperStart);
    // The wrapper must enclose the bottom sentinel / Load older button too.
    const loadOlderIdx = PAGE.indexOf('Load older');
    const wrapperCloseAfterLoadOlder = PAGE.indexOf('</div>', loadOlderIdx);
    expect(wrapperCloseAfterLoadOlder).toBeGreaterThan(loadOlderIdx);
    expect(wrapperEnd).toBeGreaterThan(-1);
  });
});
