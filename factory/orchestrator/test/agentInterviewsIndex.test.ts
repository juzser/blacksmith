import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

// ---------------------------------------------------------------------------
// `docs/specs/agent-interviews.md` is cited by id (`N-9`, `M-6`) and never
// whole, but its ids are bold inline leads rather than headings, so a cite
// cannot be resolved with a heading grep the way a `D-nnn` can.
// `docs/specs/agent-interviews-index.md` is the map: one row per id with the
// line range the item spans. A line range goes stale the first time someone
// edits the file above it, and a stale range sends an agent to the wrong
// paragraph without any error -- so every row is checked here against the
// file it indexes, and completeness runs the other way too: every lead in
// the file has a row.
// ---------------------------------------------------------------------------

const INTERVIEWS_REL = 'docs/specs/agent-interviews.md';
const INDEX_REL = 'docs/specs/agent-interviews-index.md';

const interviewLines = (): string[] =>
  readFileSync(path.join(REPO_ROOT, INTERVIEWS_REL), 'utf8').split('\n');
const indexText = (): string => readFileSync(path.join(REPO_ROOT, INDEX_REL), 'utf8');

/** A bold inline lead: `**N-9. …**` at the start of a line. */
const LEAD = /^\*\*([A-Z]+-\d+)\. /;
/** A heading that ends the item before it. */
const HEADING = /^#{2,3} /;

interface Row {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly line: number;
}

/** Every table row of the index that names an id and a line range. */
function indexRows(markdown: string): Row[] {
  const rows: Row[] = [];
  markdown.split('\n').forEach((line, i) => {
    const m = /^\|[^|]*`([A-Z]+-\d+)`[^|]*\| (\d+)-(\d+) \|/.exec(line);
    if (m) rows.push({ id: m[1] as string, from: Number(m[2]), to: Number(m[3]), line: i + 1 });
  });
  return rows;
}

interface Item {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Every item in the interviews file, computed from the file itself: a lead
 * runs to the line before the next lead or heading, trailing blanks trimmed.
 */
function fileItems(lines: string[]): Item[] {
  const items: Item[] = [];
  lines.forEach((line, i) => {
    const m = LEAD.exec(line);
    if (!m) return;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (LEAD.test(lines[j] as string) || HEADING.test(lines[j] as string)) {
        end = j;
        break;
      }
    }
    while (end - 1 > i && (lines[end - 1] as string).trim() === '') end -= 1;
    items.push({ id: m[1] as string, from: i + 1, to: end });
  });
  return items;
}

describe('agent-interviews-index.md points at the leads it names', () => {
  const lines = interviewLines();
  const rows = indexRows(indexText());
  const items = fileItems(lines);

  it('has rows to check', () => {
    expect(rows.length).toBeGreaterThan(40);
  });

  it('every row starts on the bold lead of the id it names', () => {
    const wrong = rows
      .filter((row) => !new RegExp(`^\\*\\*${row.id}\\. `).test(lines[row.from - 1] ?? ''))
      .map(
        (row) =>
          `index line ${row.line}: ${row.id} says ${row.from}, which reads ${JSON.stringify((lines[row.from - 1] ?? '').slice(0, 40))}`,
      );
    expect(wrong).toEqual([]);
  });

  it('every row ends where the item ends -- the line before the next lead or heading', () => {
    const byFrom = new Map(items.map((item) => [item.from, item]));
    const wrong = rows
      .filter((row) => byFrom.get(row.from)?.to !== row.to)
      .map(
        (row) =>
          `${row.id}: index says ${row.from}-${row.to}, file says ${row.from}-${byFrom.get(row.from)?.to}`,
      );
    expect(wrong).toEqual([]);
  });

  it('every lead in the file has a row, including both ids called M-1', () => {
    const indexed = new Set(rows.map((row) => `${row.id}@${row.from}`));
    const missing = items
      .filter((item) => !indexed.has(`${item.id}@${item.from}`))
      .map((item) => `${item.id} at line ${item.from}`);
    expect(missing).toEqual([]);
    expect(items.filter((item) => item.id === 'M-1').map((item) => item.from)).toEqual([101, 145]);
  });

  it('a row repeated in the M-1 collision table says the same thing both times', () => {
    // The two `M-1` items appear twice on purpose: once in the collision
    // table at the top and once under their own section. Repetition is fine;
    // disagreement is not.
    const seen = new Map<number, Row>();
    const disagree = rows
      .filter((row) => {
        const first = seen.get(row.from);
        if (!first) {
          seen.set(row.from, row);
          return false;
        }
        return first.id !== row.id || first.to !== row.to;
      })
      .map(
        (row) =>
          `${row.id} at index line ${row.line} disagrees with the earlier row for file line ${row.from}`,
      );
    expect(disagree).toEqual([]);
    expect(
      [...seen.values()]
        .filter((row) => rows.filter((r) => r.from === row.from).length > 1)
        .map((row) => row.id),
    ).toEqual(['M-1', 'M-1']);
  });
});
