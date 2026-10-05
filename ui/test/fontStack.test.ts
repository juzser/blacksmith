// Chromium does not resolve `-apple-system` as a bare keyword the way
// Safari does, so when `--bs-font-sans` lost its `BlinkMacSystemFont`,
// `Roboto`, `Noto Sans` fallbacks screenshots across the suite silently
// narrowed their text and some lines stopped wrapping (analytics desktop,
// activity-errors mobile). This pins `--bs-font-sans` and `--bs-font-mono`
// in bs-tokens.css to the binding mock's stack, ui/docs/ds-review.html.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, '..', 'src', 'styles');
const DOCS = join(HERE, '..', 'docs');

const MOCK_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MOCK_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

describe('--bs-font-sans / --bs-font-mono match the ds-review mock', () => {
  const bsTokens = readFileSync(join(STYLES, 'bs-tokens.css'), 'utf8');
  const mock = readFileSync(join(DOCS, 'ds-review.html'), 'utf8');

  it('mock still declares the stacks this test pins', () => {
    expect(mock).toContain(`--bs-font: ${MOCK_SANS};`);
    expect(mock).toContain(`--bs-mono: ${MOCK_MONO};`);
  });

  it('bs-tokens.css --bs-font-sans matches the mock stack exactly', () => {
    expect(bsTokens).toContain(`--bs-font-sans: ${MOCK_SANS};`);
  });

  it('bs-tokens.css --bs-font-mono matches the mock stack exactly', () => {
    expect(bsTokens).toContain(`--bs-font-mono: ${MOCK_MONO};`);
  });
});
