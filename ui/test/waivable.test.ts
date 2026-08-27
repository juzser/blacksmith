import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isWaivable, WAIVABLE_SEVERITIES, WAIVABLE_STATUSES } from '../src/lib/waivable';

const WAIVERS_TS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../factory/orchestrator/src/waivers.ts',
);

/**
 * Re-derive one of waivers.ts's lists from its SOURCE TEXT rather than
 * re-typing it here.
 *
 * The two tests below used to compare the UI copy against a literal spelled
 * out in this file, under headings that promised a comparison with
 * waivers.ts. That pins the UI copy to this file and nothing else: editing
 * WAIVABLE_SEVERITIES in the orchestrator left both green, which is exactly
 * the drift the copy exists to make loud. The UI bundle still cannot import
 * the orchestrator (see src/lib/waivable.ts), and WAIVABLE_STATUSES is not
 * even exported there — reading the file is what is left.
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

  it('matches factory/orchestrator/src/waivers.ts WAIVABLE_STATUSES', () => {
    expect([...WAIVABLE_STATUSES]).toEqual(orchestratorList('WAIVABLE_STATUSES'));
  });

  // The parse itself, pinned: without this, a regex that silently stops
  // matching turns both guards above into `[] === []` and the drift they
  // exist to catch goes green again.
  it('reads real lists out of waivers.ts, and says so when the shape moves', () => {
    expect(orchestratorList('WAIVABLE_SEVERITIES')).toEqual(['S3-minor', 'S4-nit']);
    expect(orchestratorList('WAIVABLE_STATUSES')).toEqual(['raised', 'confirmed']);
    expect(() => orchestratorList('WAIVABLE_NOTHING')).toThrow(/no `const WAIVABLE_NOTHING/);
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
