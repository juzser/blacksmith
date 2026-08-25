import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// ---------------------------------------------------------------------------
// A finding id is a citation key. Code comments, commit messages, PR bodies and
// branch names all reach for "D-140" expecting it to resolve to one defect, and
// nothing in the repo has ever checked that it does. It did not: two unrelated
// findings carried that number, and sixteen citations of it were split across
// both meanings with no way for a reader to tell which record a given comment
// meant (D-152).
//
// The corpus deliberately re-uses a number for a FOLLOW-UP to the same finding:
//
//   ## D-14 (evidence added) — the epic-qualified vs bare task id split ...
//   ## D-32 addendum — dual attribution is reachable, but only by ...
//
// Those extend one record rather than opening a second, so the marker between
// the number and the em dash is what separates a legitimate continuation from a
// collision. A primary record is `## D-<n> — `, and nothing else.
// ---------------------------------------------------------------------------

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const PRIMARY_HEADING = /^## D-(\d+) — /;

interface Heading {
  id: number;
  file: string;
  line: number;
  title: string;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...markdownFiles(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

function primaryHeadings(): Heading[] {
  const found: Heading[] = [];
  for (const file of markdownFiles(DOCS_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const match = PRIMARY_HEADING.exec(text);
      if (match) {
        found.push({
          id: Number(match[1]),
          file: path.relative(REPO_ROOT, file),
          line: index + 1,
          title: text.slice(match[0].length),
        });
      }
    });
  }
  return found;
}

describe('finding ids are citation keys', () => {
  it('no number opens two records', () => {
    const byId = new Map<number, Heading[]>();
    for (const heading of primaryHeadings()) {
      const bucket = byId.get(heading.id) ?? [];
      bucket.push(heading);
      byId.set(heading.id, bucket);
    }

    const collisions = [...byId.entries()]
      .filter(([, headings]) => headings.length > 1)
      .sort(([a], [b]) => a - b)
      .map(
        ([id, headings]) =>
          `D-${id} opens ${headings.length} records: ` +
          headings.map((h) => `${h.file}:${h.line}`).join(', '),
      );

    expect(collisions).toEqual([]);
  });

  it('reads the corpus it claims to read', () => {
    // A scan that finds nothing passes vacuously. The count is a floor, not an
    // assertion about today's total — findings only ever get added.
    expect(primaryHeadings().length).toBeGreaterThanOrEqual(70);
  });
});
