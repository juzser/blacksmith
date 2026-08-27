import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as paths from '../src/paths.js';

const POLICIES_DIR = path.join(paths.REPO_ROOT, 'factory', 'policies');

describe('paths.ts', () => {
  // D-159's precondition, one level up. Every gate in this factory is supposed
  // to read a declaration out of factory/policies/, and paths.ts is where the
  // repo agrees on where those files are. A policy file with no constant here
  // is a file no module can name without spelling the path itself -- which is
  // how severity.yml came to carry its own `${REPO_ROOT}/factory/policies/
  // severity.yml` inside severity.ts, the one path in the repo built by
  // interpolation rather than path.join.
  //
  // Compared as sorted arrays rather than sets on purpose: two constants
  // pointing at one file is the same drift in the other direction, and a set
  // would swallow it.
  it('declares a constant for every file in factory/policies/, and none twice', () => {
    const onDisk = readdirSync(POLICIES_DIR)
      .filter((entry) => statSync(path.join(POLICIES_DIR, entry)).isFile())
      .sort();

    const declared = Object.values(paths)
      .filter((value): value is string => typeof value === 'string')
      .filter((value) => path.dirname(value) === POLICIES_DIR)
      .map((value) => path.basename(value))
      .sort();

    expect(declared).toEqual(onDisk);
  });

  // The filter above keys on path.dirname, so a constant assembled by string
  // interpolation with a stray separator would silently drop out of the
  // comparison and the guard would pass over a policy it never saw.
  it('builds every policy path with path.join, not interpolation', () => {
    const policyPaths = Object.entries(paths).filter(
      ([, value]) => typeof value === 'string' && value.includes(`${path.sep}policies${path.sep}`),
    );
    expect(policyPaths.length).toBeGreaterThan(0);
    for (const [name, value] of policyPaths) {
      expect(`${name}: ${value}`).toBe(`${name}: ${path.normalize(String(value))}`);
    }
  });
});
