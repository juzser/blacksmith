// Static source-text check, same style as kitDialog.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TOAST = readFileSync(join(KIT, 'Toast.vue'), 'utf8');

describe('kit/Toast.vue', () => {
  it('reads toasts/dismiss from useToast', () => {
    expect(TOAST).toMatch(/import\s*\{\s*useToast\s*\}\s*from\s*'\.\.\/\.\.\/composables\/useToast\.js';/);
    expect(TOAST).toMatch(/useToast\(\)/);
  });

  it('region is role=status aria-live=polite', () => {
    expect(TOAST).toMatch(/role="status"/);
    expect(TOAST).toMatch(/aria-live="polite"/);
  });

  it('dismisses via an inverse-tone IconButton labelled Dismiss, not a raw button', () => {
    expect(TOAST).toMatch(/<IconButton[\s\S]*?label="Dismiss"[\s\S]*?tone="inverse"/);
    expect(TOAST).not.toMatch(/<button/);
  });
});
