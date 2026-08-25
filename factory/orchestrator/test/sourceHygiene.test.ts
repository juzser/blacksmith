import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// ---------------------------------------------------------------------------
// A tracked text file with a NUL byte in it stops being a text file to every
// tool this repo reviews itself with.
//
//   git show --stat  ->  "judges.ts | Bin 13995 -> 14460 bytes"
//                        "1 file changed, 0 insertions(+), 0 deletions(-)"
//   GitHub's API     ->  the file comes back with additions 0, deletions 0 and
//                        no `patch` field, so a pull request shows no diff for
//                        it at all
//   grep / ripgrep   ->  skipped in silence: `rg -n openKey
//                        factory/orchestrator/src` exits 1 while the function
//                        is on line 99 of agents-registry.ts
//
// Two orchestrator modules carried one each, both the same idiom: a raw NUL
// typed straight into a template literal as a composite-key separator, where
// `\u0000` builds the identical string and stays legible to a byte scanner.
// The escape is the fix; this test is the guard (D-155).
//
// NUL and no other control byte: it is the one git, grep and ripgrep all read
// as "this is not text", and the only one with a demonstrated consequence
// here. A stray formfeed is untidy; a stray NUL hides the file from review.
// ---------------------------------------------------------------------------

/**
 * Extensions whose files are expected to hold NUL bytes. Everything else git
 * tracks is scanned, so a text format nobody thought of is covered by default
 * and a new binary asset type fails loudly until it is named here - the
 * visible failure direction rather than the silent one.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.ico']);

function trackedTextFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return output
    .split('\u0000')
    .filter((file) => file !== '')
    .filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();
}

describe('tracked sources stay text', () => {
  it('no source file carries a NUL byte', () => {
    const offenders: string[] = [];
    for (const file of trackedTextFiles()) {
      const bytes = readFileSync(path.join(REPO_ROOT, file));
      const at = bytes.indexOf(0);
      if (at === -1) continue;
      const line = bytes.subarray(0, at).toString('utf8').split('\n').length;
      offenders.push(`${file}:${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
