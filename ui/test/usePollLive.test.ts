// usePoll's lifecycle hooks need a mounted component to run (onMounted/
// onBeforeUnmount), which ui/vitest.config.ts's `environment: node` cannot
// provide — same limit every kit*.test.ts works around (see
// kitBreadcrumb.test.ts's header). The real pause behaviour is e2e's job
// (ui/e2e/shell.spec.ts); this locks the source-level contract: setLive(false)
// stands the automatic interval/stream triggers down without touching a
// manual refresh.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'composables', 'usePoll.ts'),
  'utf8',
);

describe('usePoll.ts live/pause', () => {
  it('exports setLive/getIsLive for kit/LiveIndicator.vue to drive', () => {
    expect(SRC).toMatch(/export function setLive\(live: boolean\): void/);
    expect(SRC).toMatch(/export function getIsLive\(\)/);
  });

  it('gates the interval tick and the stream watcher on isLive', () => {
    const intervalBody = SRC.slice(
      SRC.indexOf('timer = setInterval'),
      SRC.indexOf('}, intervalMs)'),
    );
    expect(intervalBody).toMatch(/if \(!isLive\.value\) return;/);
    const streamWatch = SRC.slice(SRC.indexOf('watch(advanceSignal'));
    expect(streamWatch).toMatch(/if \(!isLive\.value\) return;/);
  });

  it('never gates the manual refresh signal on isLive', () => {
    const manualWatch = SRC.slice(
      SRC.indexOf('watch(refreshSignal'),
      SRC.indexOf('watch(advanceSignal'),
    );
    expect(manualWatch).not.toMatch(/isLive/);
  });
});
