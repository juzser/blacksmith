import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isWaivable, WAIVABLE_SEVERITIES, WAIVABLE_STATUSES } from '../src/lib/waivable';

const ORCHESTRATOR_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../factory/orchestrator/src',
);
const WAIVERS_TS = path.join(ORCHESTRATOR_SRC, 'waivers.ts');
const FINDINGS_TS = path.join(ORCHESTRATOR_SRC, 'findings.ts');

/**
 * Re-derive one of waivers.ts's lists from its SOURCE TEXT rather than
 * re-typing it here.
 *
 * The tests below used to compare the UI copy against a literal spelled
 * out in this file, under headings that promised a comparison with the
 * orchestrator. That pins the UI copy to this file and nothing else: editing
 * WAIVABLE_SEVERITIES in the orchestrator left both green, which is exactly
 * the drift the copy exists to make loud. The UI bundle still cannot import
 * the orchestrator (see src/lib/waivable.ts) — reading the file is what is
 * left.
 *
 * Deliberately strict about the declaration's shape: a renamed const or a
 * reformatted literal throws here instead of quietly matching nothing and
 * comparing against `[]`. The same idiom as usage.test.ts's
 * dispatchedCommands(), which regex-parses cli.ts for the same reason.
 */
function orchestratorList(name: string): string[] {
  const source = readFileSync(WAIVERS_TS, 'utf8');
  const declaration = new RegExp(
    `(?:export )?const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\];`,
  ).exec(source);
  if (!declaration) {
    throw new Error(
      `waivers.ts has no \`const ${name}: readonly string[] = [...]\` declaration. ` +
        'If it moved or changed shape, update this guard — do not delete it.',
    );
  }
  return (declaration[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * The `finding_status` values a waiver can be granted from, read off
 * findings.ts's LEGAL_TRANSITIONS source text.
 *
 * This guard used to read a `WAIVABLE_STATUSES` const in waivers.ts. That
 * const was a hand-copy of this table and is gone: findings.ts now derives the
 * roster from the table itself. So the guard follows the fact to where it is
 * decided rather than to the derivation of it — reading the derivation would
 * pin the UI copy to a `.map()` over the same source, one indirection further
 * from the thing `transition()` actually enforces.
 *
 * Strict about the row shape for the same reason as orchestratorList(): a
 * table that stopped parsing would hand both callers `[]` and compare the UI
 * copy against nothing at all. `source` is a seam for the negative control
 * below and nothing else — every real caller reads findings.ts.
 */
function waivableStatusesFromTable(source = readFileSync(FINDINGS_TS, 'utf8')): string[] {
  const table = /export const LEGAL_TRANSITIONS\s*:[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/.exec(
    source,
  );
  if (!table) {
    throw new Error(
      'findings.ts has no `export const LEGAL_TRANSITIONS: ... = Object.freeze({...});` ' +
        'declaration. If it moved or changed shape, update this guard — do not delete it.',
    );
  }
  const rows = [...(table[1] ?? '').matchAll(/^\s*'?([\w-]+)'?:\s*\[([^\]]*)\],/gm)];
  if (rows.length === 0) {
    throw new Error(
      'LEGAL_TRANSITIONS parsed to no rows at all. If the row shape moved, update this ' +
        'guard — do not delete it.',
    );
  }
  return rows.filter((row) => (row[2] ?? '').includes("'waived'")).map((row) => row[1] as string);
}

/**
 * The predicate has to agree with two things it cannot import: the
 * orchestrator's waivers.ts (which decides whether applyBatch accepts the
 * decision at all) and queries.ts's overview counter (which decides whether
 * the "Needs you" banner claims there is something to do). Divergence in
 * either direction is a UI that lies -- a banner counting work with no
 * control, or a control whose click the API rejects.
 */
const finding = (severity: string, findingStatus: string, waiverId: string | null = null) => ({
  severity,
  findingStatus,
  waiverId,
});

describe('waivable severities and statuses', () => {
  it('matches factory/orchestrator/src/waivers.ts WAIVABLE_SEVERITIES', () => {
    expect([...WAIVABLE_SEVERITIES]).toEqual(orchestratorList('WAIVABLE_SEVERITIES'));
  });

  it('matches the statuses findings.ts LEGAL_TRANSITIONS allows a waived edge from', () => {
    expect([...WAIVABLE_STATUSES]).toEqual(waivableStatusesFromTable());
  });

  // The parse itself, pinned: without this, a regex that silently stops
  // matching turns both guards above into `[] === []` and the drift they
  // exist to catch goes green again.
  it('reads real lists out of the orchestrator, and says so when a shape moves', () => {
    expect(orchestratorList('WAIVABLE_SEVERITIES')).toEqual(['S3-minor', 'S4-nit']);
    expect(waivableStatusesFromTable()).toEqual(['raised', 'confirmed']);
    expect(() => orchestratorList('WAIVABLE_NOTHING')).toThrow(/no `const WAIVABLE_NOTHING/);
    // A name-prefix is not the name. Unanchored, `LEGAL_TRANSITIONS` also
    // matches a `LEGAL_TRANSITIONS_ANYTHING` declared ahead of it, and the
    // guard reads that other table and stays green. Measured while writing
    // this: renaming the const in findings.ts left all eight tests passing
    // until the `:` landed in the pattern.
    expect(() =>
      waivableStatusesFromTable(
        "export const LEGAL_TRANSITIONS_ELSEWHERE: T = Object.freeze({\n  raised: ['waived'],\n});\n",
      ),
    ).toThrow(/no `export const LEGAL_TRANSITIONS:/);
    // And a table whose rows stopped parsing says so instead of answering `[]`.
    expect(() =>
      waivableStatusesFromTable('export const LEGAL_TRANSITIONS: T = Object.freeze({});\n'),
    ).toThrow(/parsed to no rows at all/);
  });
});

describe('isWaivable', () => {
  it('accepts every severity x status pair the overview counter counts', () => {
    for (const severity of WAIVABLE_SEVERITIES) {
      for (const status of WAIVABLE_STATUSES) {
        expect(isWaivable(finding(severity, status)), `${severity}/${status}`).toBe(true);
      }
    }
  });

  it('refuses S1/S2 -- severity.yml: those are fixed or escalated, never waived', () => {
    expect(isWaivable(finding('S1-stop-the-line', 'confirmed'))).toBe(false);
    expect(isWaivable(finding('S2-major', 'confirmed'))).toBe(false);
  });

  it('refuses a status transition() has no waived edge from', () => {
    expect(isWaivable(finding('S3-minor', 'fix-verified'))).toBe(false);
    expect(isWaivable(finding('S3-minor', 'waived'))).toBe(false);
    expect(isWaivable(finding('S3-minor', 'refuted'))).toBe(false);
  });

  it('refuses a finding that already carries a waiver', () => {
    expect(isWaivable(finding('S3-minor', 'confirmed', 'evt-9'))).toBe(false);
    expect(isWaivable(finding('S4-nit', 'raised', 'evt-9'))).toBe(false);
  });

  it('refuses an unknown severity rather than guessing it is minor', () => {
    expect(isWaivable(finding('S5-whatever', 'confirmed'))).toBe(false);
    expect(isWaivable(finding('', 'confirmed'))).toBe(false);
  });
});
