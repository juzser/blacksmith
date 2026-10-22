// bs-optimize epic criterion 2 (AC2): every checked-in lesson carries exactly
// one taxonomy error class, and the backfill leaves every statement untouched.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileLessons } from '../src/lessons.js';
import { parseLessons } from '../src/severity.js';
import { loadTaxonomy } from '../src/taxonomy.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LESSONS_PATH = path.join(REPO_ROOT, 'factory/policies/lessons.md');
const FIXTURE_PATH = path.join(__dirname, 'fixtures/lessons-statements.json');

const markdown = readFileSync(LESSONS_PATH, 'utf8');
const entries = parseLessons(markdown);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The taxonomy `error` dimension flattened to `group.class` strings. */
function taxonomyClasses(): Set<string> {
  const out = new Set<string>();
  for (const [group, classes] of Object.entries(loadTaxonomy().errorGroups)) {
    for (const cls of classes) out.add(`${group}.${cls}`);
  }
  return out;
}

/** Number of `- error_class:` bullets in each entry's block, keyed by lesson id. */
function bulletCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  let inScope = false;
  let id: string | null = null;
  for (const line of markdown.split('\n')) {
    if (/^## (agent-role|claim-path|case-type|stack-wide|security)\s*$/.test(line)) inScope = true;
    else if (/^## /.test(line)) inScope = false;
    if (!inScope) continue;
    if (/^### /.test(line)) id = null;
    const idMatch = line.match(/^- lesson_id:\s*(\S+)/);
    if (idMatch) {
      id = idMatch[1] as string;
      counts.set(id, 0);
    }
    if (id && /^- error_class:/.test(line)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

describe('lessons.md error_class backfill (bs-optimize AC2)', () => {
  it('every entry carries exactly one error_class bullet naming a taxonomy error class', () => {
    const valid = taxonomyClasses();
    const counts = bulletCounts();
    expect(entries.length).toBeGreaterThan(0);
    expect(counts.size).toBe(entries.length);
    for (const entry of entries) {
      expect(counts.get(entry.lessonId), `${entry.lessonId} bullet count`).toBe(1);
      expect(valid.has(entry.errorClass ?? ''), `${entry.lessonId}: ${entry.errorClass}`).toBe(
        true,
      );
    }
  });

  it('statements are byte-identical to the pre-backfill file, ids matching exactly', () => {
    expect(entries.map((e) => e.lessonId).sort()).toEqual(Object.keys(fixture).sort());
    for (const entry of entries) {
      expect(sha256(entry.statement), `${entry.lessonId} statement`).toBe(fixture[entry.lessonId]);
    }
  });

  it('lessons compile against an empty store leaves the file unchanged', () => {
    expect(compileLessons([], markdown)).toBe(markdown);
  });

  it('spot-checks classes whose statements name the failure outright', () => {
    const classOf = new Map(entries.map((e) => [e.lessonId, e.errorClass]));
    expect(classOf.get('bs-audit-3-gate-timeout-under-load')).toBe('execution.env-failure');
    expect(classOf.get('lesson-raised-720003607334')).toBe('integration.merge-conflict-textual');
    expect(classOf.get('lesson-raised-31b13840f6c5')).toBe('contract.schema-violation');
    expect(classOf.get('lesson-raised-612b6c33c722')).toBe('execution.env-failure');
    expect(classOf.get('lesson-raised-26ace63a7a67')).toBe('coordination.deadlock');
  });
});
