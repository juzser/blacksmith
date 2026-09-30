import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const LIVE = readFileSync(join(KIT, 'LiveIndicator.vue'), 'utf8');

describe('kit/LiveIndicator.vue', () => {
  it('owns a single Refresh, Pause/Resume, theme toggle and Settings button', () => {
    expect(LIVE).toMatch(/label="Refresh now"/);
    expect(LIVE).toMatch(/:label="live \? 'Pause updates' : 'Resume updates'"/);
    expect(LIVE).toMatch(
      /:label="theme === 'dark' \? 'Switch to light theme' : 'Switch to dark theme'"/,
    );
    expect(LIVE).toMatch(/:icon="Settings"\s+label="Settings"/);
  });

  it('the theme toggle label flips with the theme prop', () => {
    expect(LIVE).toMatch(/theme === 'dark' \? Sun : Moon/);
  });

  it('Refresh is aria-disabled while a refresh it triggered is still pending', () => {
    expect(LIVE).toMatch(/:disabled="pending"/);
    expect(LIVE).toMatch(/pending\.value = true/);
  });

  it('Settings has no settings surface yet, so it stays permanently disabled', () => {
    expect(LIVE).toMatch(/<IconButton :icon="Settings" label="Settings" size="sm" disabled \/>/);
  });

  it('renders lastEventAt via the shared RelativeTime component', () => {
    expect(LIVE).toMatch(/<RelativeTime :iso="lastEventAt" :now="now"/);
  });
});
