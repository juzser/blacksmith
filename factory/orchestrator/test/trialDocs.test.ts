import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths.js';

const METHODOLOGY = path.join(REPO_ROOT, 'docs', 'trial', 'methodology.md');
const RESULTS = path.join(REPO_ROOT, 'docs', 'trial', 'results.md');
const TASKS_DIR = path.join(REPO_ROOT, 'trial', 'tasks');

const RECORD_FIELDS = [
  'task_kind',
  'arm',
  'check',
  'tokens',
  'wall_clock_ms',
  'diff',
  'interventions',
  'cli_session_id',
  'recorded_at',
  'harness_version',
];

function bare(cell: string | undefined): string {
  return (cell ?? '').replace(/`/g, '');
}

function read(file: string): string {
  expect(existsSync(file), `${path.relative(REPO_ROOT, file)} must exist`).toBe(true);
  return readFileSync(file, 'utf8');
}

/** Task kinds on disk: every directory under trial/tasks/ that holds a manifest. */
function kindsOnDisk(): string[] {
  return readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(TASKS_DIR, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();
}

/** The body lines of the first Markdown table under a `## <heading>` section. */
function tableRows(md: string, heading: string): string[][] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  expect(start, `section "${heading}" must exist`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (l.startsWith('## ')) break;
    if (!l.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    rows.push(
      l
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim()),
    );
  }
  // Drop the header row and the separator row.
  return rows.slice(2);
}

describe('trial docs', () => {
  it('reads every metric cell in results.md as NOT MEASURED', () => {
    const md = read(RESULTS);
    const rows = tableRows(md, 'Results');
    const kinds = kindsOnDisk();
    expect(rows.length).toBeGreaterThanOrEqual(kinds.length * 2);
    for (const row of rows) {
      // The first two columns label the cell (task kind, arm); the rest are metrics.
      expect(kinds).toContain(bare(row[0]));
      expect(['plain', 'blacksmith']).toContain(bare(row[1]));
      expect(row.length).toBeGreaterThan(2);
      for (const cell of row.slice(2)) expect(cell).toBe('NOT MEASURED');
    }
    // Every kind appears once per arm.
    for (const kind of kinds) {
      for (const arm of ['plain', 'blacksmith']) {
        expect(rows.filter((r) => bare(r[0]) === kind && bare(r[1]) === arm)).toHaveLength(1);
      }
    }
  });

  it('puts no digit in results.md outside of headings and links', () => {
    const body = read(RESULTS)
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n')
      .replace(/\]\([^)]*\)/g, ']');
    expect(body).not.toMatch(/\d/);
  });

  it('names exactly the task kinds present under trial/tasks/', () => {
    const md = read(METHODOLOGY);
    const kinds = kindsOnDisk();
    expect(kinds.length).toBeGreaterThan(0);
    const named = tableRows(md, 'Task kinds').map((r) => bare(r[0]));
    expect(named.sort()).toEqual(kinds);
  });

  it('names both arms, every record field and the token definition', () => {
    const md = read(METHODOLOGY);
    for (const arm of ['plain', 'blacksmith']) expect(md).toContain(`\`${arm}\``);
    for (const f of RECORD_FIELDS) expect(md).toContain(`\`${f}\``);
    expect(md).toMatch(/cache reads/i);
    expect(md).toMatch(/message id/i);
    expect(md).toMatch(/request id/i);
  });

  it('states the operator decides the run, labels single runs and scopes agent-bench', () => {
    const md = read(METHODOLOGY);
    expect(md).toMatch(/operator's decision/);
    expect(md).toMatch(/single-run/);
    expect(md).toMatch(/^## .*agent-bench/m);
    expect(md).toMatch(/no epochs, no repeats, no error bars/i);
  });

  it('links trial/README.md and trial/tasks/ by repo-relative path', () => {
    const md = read(METHODOLOGY);
    expect(md).toContain('../../trial/README.md');
    expect(md).toContain('../../trial/tasks/');
  });
});
