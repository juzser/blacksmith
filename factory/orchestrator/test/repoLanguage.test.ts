import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';
import { excludedBecause, filesUnder } from './helpers/instructionSurface.js';

// ---------------------------------------------------------------------------
// D-268. AGENTS.md: "All artifacts in this repo (docs, code, commits, agent
// prompts) are English." Nothing read that rule back, so it drifted the way an
// unchecked rule always drifts -- not by anyone deciding against it, but one
// comment at a time. Quoting the operator's directive verbatim is the obvious
// thing to do when you have just been given one, and by Phase 10 it had
// reached 109 lines across 38 files: the *reason* for a design decision was
// unreadable to anyone who does not read Vietnamese, in a repo whose whole
// claim is that what it builds stands on its own.
//
// The directive is still cited -- "Operator directive (Phase 10):" -- and the
// verbatim original still exists in git history and the event log. What lives
// in the source is the instruction, in the language the source is written in.
//
// Records of the past are excluded, on `instructionSurface.ts`'s existing
// rule: a dogfood finding quoting a bug report *is* the report, and rewriting
// it would be editing the record rather than the repo.
// ---------------------------------------------------------------------------

/**
 * Vietnamese-only letters. Two ranges, and neither is "non-ASCII": this repo
 * writes em dashes, curly quotes, arrows and `>=` in prose on purpose, so a
 * bare non-ASCII scan would fail on the house style itself.
 *
 * U+1EA0-U+1EF9 (Latin Extended Additional) is used by no other language here,
 * and the seven base letters after it are the ones Vietnamese adds to the
 * Latin alphabet. A word carrying none of them -- "tiep tuc" -- is not caught,
 * and is not what happened: every one of the 109 lines was a diacritic-bearing
 * quotation.
 */
// Written as escapes, not as the letters themselves: this file is inside the
// surface it scans, and a guard that has to exempt itself is a guard with a
// hole in it.
const VIETNAMESE = /[\u1EA0-\u1EF9\u0102\u0103\u01A0\u01A1\u01AF\u01B0\u0110\u0111]/;

/**
 * The extensions a human writes prose into. Not a filter on "text files" --
 * a lockfile is text and holds no prose -- and deliberately not open-ended,
 * because the failure this guard must not have is scanning a binary and
 * reporting mojibake as a defect.
 *
 * `.js` is absent because the repo has none outside build output: source is
 * TypeScript and the loose scripts are `.mjs`. The floor test below would
 * fail on it, which is the point -- this list names what is here, not what
 * a repo might have.
 */
const PROSE_EXTENSIONS = [
  '.css',
  '.html',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.ts',
  '.vue',
  '.yaml',
  '.yml',
];

function hasProseExtension(name: string): boolean {
  return PROSE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Repo-relative prose files, minus runtime state and records of the past. */
function proseFiles(): string[] {
  return filesUnder(REPO_ROOT, hasProseExtension)
    .map((full) => path.relative(REPO_ROOT, full))
    .filter((rel) => excludedBecause(rel) === undefined);
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const rel of proseFiles()) {
    // `split('\n')`, never `splitlines()`'s equivalent: a JS `split` on the
    // newline is what keeps these indices agreeing with an editor's gutter.
    const lines = readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (VIETNAMESE.test(text)) found.push({ file: rel, line: index + 1, text: text.trim() });
    });
  }
  return found;
}

describe('the repo speaks one language', () => {
  it('reads every kind of file a directive could have been quoted into', () => {
    // The guard on the guard. A scan of zero files passes silently, and so
    // does a scan that quietly stops covering `.vue` -- which is where a
    // third of the drift lived (D-119: a gate scoped narrower than the thing
    // it guards). So assert the walk still reaches each extension, rather
    // than trusting an empty result.
    const seen = new Set(proseFiles().map((rel) => path.extname(rel)));
    expect([...PROSE_EXTENSIONS].filter((ext) => !seen.has(ext))).toEqual([]);
  });

  it('carries no Vietnamese outside the record of the past', () => {
    expect(offences().map((o) => `${o.file}:${o.line}: ${o.text.slice(0, 72)}`)).toEqual([]);
  });
});
