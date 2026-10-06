import { describe, expect, it } from 'vitest';
import { fitTitleText } from '../src/lib/kanban.js';

// A predicate that "fits" when the text is at most `max` characters long.
const within = (max: number) => (text: string) => text.length <= max;

describe('fitTitleText', () => {
  it('returns null when the full title fits', () => {
    expect(fitTitleText('short title', within(40), 8)).toBeNull();
  });

  it('cuts mid-word when no space is near the cut', () => {
    expect(fitTitleText('Internationalization', within(8), 8)).toBe('Interna…');
  });

  it('cuts at a word boundary within the slack', () => {
    expect(fitTitleText('alpha beta gamma delta', within(13), 8)).toBe('alpha beta…');
  });

  it('does not back up to a word boundary beyond the slack', () => {
    expect(fitTitleText('a bcdefghijklmnop', within(12), 3)).toBe('a bcdefghij…');
  });

  it('degrades to an ellipsis alone when nothing fits', () => {
    expect(fitTitleText('anything at all', within(1), 8)).toBe('…');
  });

  it('keeps a single unbroken long token cut, not dropped', () => {
    expect(fitTitleText('x'.repeat(200), within(30), 8)).toBe(`${'x'.repeat(29)}…`);
  });

  it('measures O(log n) times', () => {
    let calls = 0;
    const full = 'word '.repeat(400).trim();
    fitTitleText(
      full,
      (t) => {
        calls++;
        return t.length <= 700;
      },
      8,
    );
    expect(calls).toBeLessThanOrEqual(Math.ceil(Math.log2(full.length)) + 2);
  });
});
