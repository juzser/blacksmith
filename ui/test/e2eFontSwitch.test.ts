// BS_E2E_FONT=arial only reaches the pages of a spec whose `test` comes from
// ui/e2e/harness.ts. A spec that imports `test` from Playwright directly
// would silently skip it, so this fails the moment one does.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arialSwitchOn } from '../e2e/fontSwitch.js';

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e');

describe('BS_E2E_FONT switch', () => {
  it('is off when unset or empty, on for arial, and rejects anything else', () => {
    expect(arialSwitchOn({})).toBe(false);
    expect(arialSwitchOn({ BS_E2E_FONT: '' })).toBe(false);
    expect(arialSwitchOn({ BS_E2E_FONT: 'arial' })).toBe(true);
    expect(() => arialSwitchOn({ BS_E2E_FONT: 'Arial' })).toThrow(/BS_E2E_FONT/);
    expect(() => arialSwitchOn({ BS_E2E_FONT: 'helvetica' })).toThrow(/"helvetica"/);
  });

  it('no spec takes `test` straight from @playwright/test', async () => {
    const specs = (await readdir(e2eDir)).filter((f) => f.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of specs) {
      const src = await readFile(path.join(e2eDir, file), 'utf8');
      for (const m of src.matchAll(
        /^import\s+(?!type\b)([^;]*?)\s+from\s+'@playwright\/test'/gms,
      )) {
        if (/\btest\b/.test(m[1] ?? '')) offenders.push(file);
      }
    }
    expect(offenders, 'import { test } from "./harness.js" instead').toEqual([]);
  });
});
