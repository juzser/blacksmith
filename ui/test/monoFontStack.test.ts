// The app's monospace token must resolve the same fallback chain as the
// binding mock's `--bs-mono` (ds-review.html), so a machine without
// SF Mono lands on Menlo/Consolas rather than the browser's default mono.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = readFileSync(join(UI, 'src', 'styles', 'bs-tokens.css'), 'utf8');
const MOCK = readFileSync(join(UI, 'docs', 'ds-review.html'), 'utf8');

function stack(source: string, name: string): string[] {
  const match = source.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(match, `${name} is declared`).not.toBeNull();
  return (match?.[1] ?? '').split(',').map((family) => family.trim());
}

describe('monospace font stack', () => {
  it('matches the mock --bs-mono fallback chain', () => {
    expect(stack(TOKENS, '--bs-font-mono')).toEqual(stack(MOCK, '--bs-mono'));
  });
});
