import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../src/lib/clipboard.js';

// DS4 S5c §4 — shared clipboard helper (EpicBlock's "Copy epic id", later
// Kanban too). No DOM clipboard in jsdom/node, so navigator.clipboard is
// stubbed per test.
describe('copyToClipboard() (DS4 S5c §4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves true once navigator.clipboard.writeText succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyToClipboard('epic-9')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('epic-9');
  });

  it('resolves false, never throws, when the write is rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyToClipboard('epic-9')).resolves.toBe(false);
  });
});
