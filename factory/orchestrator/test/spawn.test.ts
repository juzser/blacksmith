import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnCapped } from '../src/spawn.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-judge-cli.mjs',
);
const BUDGET = { timeout_ms: 5000, max_output_bytes: 100_000 };

describe('spawn.ts spawnCapped', () => {
  it('keeps a multibyte character intact when it is split across stdout chunks', async () => {
    const out = await spawnCapped(
      { command: 'node', args: [FIXTURE, 'split-char', 'stdout'] },
      '',
      BUDGET,
    );
    expect(out.combined).toBe('a—b');
  });

  it('keeps a multibyte character intact when it is split across stderr chunks', async () => {
    const out = await spawnCapped(
      { command: 'node', args: [FIXTURE, 'split-char', 'stderr'] },
      '',
      BUDGET,
    );
    expect(out.stderr).toBe('a—b');
    expect(out.combined).toBe('a—b');
  });

  it('counts raw bytes against the cap, not characters', async () => {
    // 'a' + 3-byte dash + 'b' = 5 bytes; a 4-byte cap must trip.
    const out = await spawnCapped(
      { command: 'node', args: [FIXTURE, 'split-char', 'stdout'] },
      '',
      { timeout_ms: 5000, max_output_bytes: 4 },
    );
    expect(out.sizeExceeded).toBe(true);
  });
});
