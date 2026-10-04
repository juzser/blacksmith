import { describe, expect, it, vi } from 'vitest';
import { nextRovingTabId } from '../src/lib/rovingTabs.js';

function keyEvent(key: string) {
  return { key, preventDefault: vi.fn() };
}

describe('lib/rovingTabs.ts nextRovingTabId()', () => {
  const ids = ['all', 'prompt', 'dispatch', 'error'];

  it('moves right, wrapping from the last id to the first', () => {
    expect(nextRovingTabId(keyEvent('ArrowRight'), ids, 'prompt')).toBe('dispatch');
    expect(nextRovingTabId(keyEvent('ArrowRight'), ids, 'error')).toBe('all');
  });

  it('moves left, wrapping from the first id to the last', () => {
    expect(nextRovingTabId(keyEvent('ArrowLeft'), ids, 'dispatch')).toBe('prompt');
    expect(nextRovingTabId(keyEvent('ArrowLeft'), ids, 'all')).toBe('error');
  });

  it('jumps to the first id on Home and the last on End', () => {
    expect(nextRovingTabId(keyEvent('Home'), ids, 'error')).toBe('all');
    expect(nextRovingTabId(keyEvent('End'), ids, 'all')).toBe('error');
  });

  it('calls preventDefault only when it handles the key', () => {
    const handled = keyEvent('ArrowRight');
    nextRovingTabId(handled, ids, 'all');
    expect(handled.preventDefault).toHaveBeenCalledOnce();

    const ignored = keyEvent('Tab');
    nextRovingTabId(ignored, ids, 'all');
    expect(ignored.preventDefault).not.toHaveBeenCalled();
  });

  it('returns null for a key it does not handle', () => {
    expect(nextRovingTabId(keyEvent('Tab'), ids, 'all')).toBeNull();
  });

  it('returns null when the current id is not in the list', () => {
    expect(nextRovingTabId(keyEvent('ArrowRight'), ids, 'missing')).toBeNull();
  });
});
