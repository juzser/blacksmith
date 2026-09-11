import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_AXES,
  AUDIT_STATUSES,
  AuditError,
  type AuditLine,
  auditStorePath,
  clusterByPath,
  DECLINE_EXPIRY_DAYS,
  type FoldedFinding,
  foldAuditStore,
  normalizeEvidence,
  rankClusters,
  readAuditStore,
  suppressedFingerprints,
} from '../src/audit.js';
import { computeFingerprint } from '../src/findings.js';

const NOW = new Date('2026-09-10T00:00:00.000Z');

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

/** The first element, or a loud failure: a test that reads an empty result should say so. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected at least one item, got none');
  return item;
}

function raised(overrides: Partial<AuditLine> = {}): AuditLine {
  const body = {
    axis: 'security' as const,
    severity: 'S2-major',
    file_path: 'src/foo.ts',
    summary: 'the gate admits any self-signed certificate',
    failure_scenario: { inputs: 'i', expected: 'e', actual: 'a' },
    confidence: 0.9,
    ...overrides,
  };
  return {
    fingerprint:
      overrides.fingerprint ??
      computeFingerprint({
        filePath: body.file_path,
        category: body.axis,
        summary: body.summary,
      }),
    status: 'raised',
    ts: daysBefore(1),
    ...body,
  } as AuditLine;
}

describe('the four axes', () => {
  it('are fixed at four and not operator-selectable', () => {
    expect([...AUDIT_AXES]).toEqual(['performance', 'code-quality', 'architecture', 'security']);
  });

  it('carries the five statuses of the spec table, and only those', () => {
    expect([...AUDIT_STATUSES]).toEqual(['raised', 'merged', 'accepted', 'declined', 'fixed']);
  });
});

describe('the store lives beside the project, not inside this clone', () => {
  it('is <project>/.blacksmith/findings.jsonl', () => {
    expect(auditStorePath('/somewhere/else/proj')).toBe(
      path.join('/somewhere/else/proj', '.blacksmith', 'findings.jsonl'),
    );
  });

  it('resolves a relative project dir to an absolute path', () => {
    expect(path.isAbsolute(auditStorePath('.'))).toBe(true);
  });
});

describe('normalizeEvidence', () => {
  const item = {
    file_path: './src/./foo.ts',
    severity: 'S3-minor',
    summary: 'src/foo.ts:42 allocates inside the loop',
    failure_scenario: { inputs: 'i', expected: 'e', actual: 'a' },
    confidence: 0.5,
  };

  it('normalizes the file path so the two stores can be joined by path', () => {
    const record = only(normalizeEvidence('performance', [item]));
    expect(record.file_path).toBe('src/foo.ts');
  });

  it('fingerprints on the axis, reusing the factory function unchanged', () => {
    const record = only(normalizeEvidence('performance', [item]));
    expect(record.fingerprint).toBe(
      computeFingerprint({
        filePath: 'src/foo.ts',
        category: 'performance',
        summary: item.summary,
      }),
    );
  });

  it('is stable across a line number moving in the summary', () => {
    const a = only(normalizeEvidence('performance', [item]));
    const b = only(
      normalizeEvidence('performance', [
        { ...item, summary: 'src/foo.ts:80 allocates inside the loop' },
      ]),
    );
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('refuses evidence that carries an identity field', () => {
    for (const field of ['fingerprint', 'status', 'axis', 'audit_id']) {
      expect(() => normalizeEvidence('performance', [{ ...item, [field]: 'x' }])).toThrowError(
        expect.objectContaining({ code: 'audit.evidence-carries-identity' }),
      );
    }
  });

  it('refuses a severity outside the taxonomy', () => {
    expect(() => normalizeEvidence('performance', [{ ...item, severity: 'S5-whatever' }])).toThrow(
      AuditError,
    );
  });

  it('refuses a confidence outside 0..1', () => {
    expect(() => normalizeEvidence('performance', [{ ...item, confidence: 1.4 }])).toThrowError(
      expect.objectContaining({ code: 'audit.confidence-out-of-range' }),
    );
  });

  it('refuses an axis outside the four', () => {
    expect(() => normalizeEvidence('correctness' as never, [item])).toThrowError(
      expect.objectContaining({ code: 'audit.unknown-axis' }),
    );
  });

  it('refuses an item missing a failure scenario leg', () => {
    expect(() =>
      normalizeEvidence('performance', [
        { ...item, failure_scenario: { inputs: 'i', expected: 'e' } as never },
      ]),
    ).toThrow(AuditError);
  });
});

describe('foldAuditStore — status is a line, never an edit', () => {
  it('folds a lone raised line to raised', () => {
    const folded = only(foldAuditStore([raised()], { now: NOW }));
    expect(folded.status).toBe('raised');
    expect(folded.expired).toBe(false);
  });

  it('lets the last status line win', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          { fingerprint: r.fingerprint, status: 'accepted', ts: daysBefore(2) },
          { fingerprint: r.fingerprint, status: 'declined', ts: daysBefore(1) },
        ],
        { now: NOW },
      ),
    );
    expect(folded.status).toBe('declined');
  });

  it('keeps the body from the raised line the decision lines do not carry', () => {
    const r = raised();
    const folded = only(
      foldAuditStore([r, { fingerprint: r.fingerprint, status: 'accepted', ts: daysBefore(1) }], {
        now: NOW,
      }),
    );
    expect(folded.summary).toBe(r.summary);
    expect(folded.axis).toBe('security');
    expect(folded.severity).toBe('S2-major');
  });

  it('keeps the whole history, in log order', () => {
    const r = raised();
    const folded = only(
      foldAuditStore([r, { fingerprint: r.fingerprint, status: 'accepted', ts: daysBefore(1) }], {
        now: NOW,
      }),
    );
    expect(folded.history.map((line) => line.status)).toEqual(['raised', 'accepted']);
  });

  it('carries --same-as through a merge decision', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          { fingerprint: r.fingerprint, status: 'merged', ts: daysBefore(1), same_as: 'deadbeef' },
        ],
        { now: NOW },
      ),
    );
    expect(folded.status).toBe('merged');
    expect(folded.sameAs).toBe('deadbeef');
  });

  it('carries the epic through accept and fix', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          { fingerprint: r.fingerprint, status: 'accepted', ts: daysBefore(3) },
          { fingerprint: r.fingerprint, status: 'fixed', ts: daysBefore(1), epic: 'csb-perf-1' },
        ],
        { now: NOW },
      ),
    );
    expect(folded.epic).toBe('csb-perf-1');
  });

  it('refuses a store line with no raised line to hang off', () => {
    expect(() =>
      foldAuditStore([{ fingerprint: 'orphan', status: 'accepted', ts: daysBefore(1) }], {
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: 'audit.decision-without-finding' }));
  });
});

describe('suppression — the rule that decides whether an axis may re-raise', () => {
  it('suppresses under raised, merged and accepted', () => {
    for (const status of ['raised', 'merged', 'accepted'] as const) {
      const r = raised();
      const lines: AuditLine[] =
        status === 'raised' ? [r] : [r, { fingerprint: r.fingerprint, status, ts: daysBefore(1) }];
      const folded = only(foldAuditStore(lines, { now: NOW }));
      expect(folded.suppressesReraise).toBe(true);
    }
  });

  it('suppresses under a decline that has not expired', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          {
            fingerprint: r.fingerprint,
            status: 'declined',
            ts: daysBefore(DECLINE_EXPIRY_DAYS - 1),
          },
        ],
        { now: NOW },
      ),
    );
    expect(folded.status).toBe('declined');
    expect(folded.expired).toBe(false);
    expect(folded.suppressesReraise).toBe(true);
  });

  it('stops suppressing once the decline is older than 90 days, at fold time', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          {
            fingerprint: r.fingerprint,
            status: 'declined',
            ts: daysBefore(DECLINE_EXPIRY_DAYS + 1),
          },
        ],
        { now: NOW },
      ),
    );
    expect(folded.status).toBe('declined');
    expect(folded.expired).toBe(true);
    expect(folded.suppressesReraise).toBe(false);
  });

  it('does not rewrite an expired decline into raised — the line still says declined', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          {
            fingerprint: r.fingerprint,
            status: 'declined',
            ts: daysBefore(DECLINE_EXPIRY_DAYS + 1),
          },
        ],
        { now: NOW },
      ),
    );
    expect(folded.status).not.toBe('raised');
  });

  it('does not suppress under fixed — a fingerprint that comes back is a regression', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          { fingerprint: r.fingerprint, status: 'accepted', ts: daysBefore(30) },
          { fingerprint: r.fingerprint, status: 'fixed', ts: daysBefore(2), epic: 'csb-perf-1' },
        ],
        { now: NOW },
      ),
    );
    expect(folded.suppressesReraise).toBe(false);
  });

  it('lets a regression return as a fresh raised line over a history that still shows fixed', () => {
    const r = raised();
    const folded = only(
      foldAuditStore(
        [
          r,
          { fingerprint: r.fingerprint, status: 'fixed', ts: daysBefore(30), epic: 'csb-perf-1' },
          { ...r, ts: daysBefore(1) },
        ],
        { now: NOW },
      ),
    );
    expect(folded.status).toBe('raised');
    expect(folded.history.map((line) => line.status)).toEqual(['raised', 'fixed', 'raised']);
  });

  it('names exactly the fingerprints an axis may not re-raise', () => {
    const open = raised({ summary: 'still open' });
    const done = raised({ summary: 'already fixed' });
    const stale = raised({ summary: 'declined long ago' });
    const suppressed = suppressedFingerprints(
      [
        open,
        done,
        { fingerprint: done.fingerprint, status: 'fixed', ts: daysBefore(5), epic: 'e1' },
        stale,
        {
          fingerprint: stale.fingerprint,
          status: 'declined',
          ts: daysBefore(DECLINE_EXPIRY_DAYS + 5),
        },
      ],
      { now: NOW },
    );
    expect([...suppressed]).toEqual([open.fingerprint]);
  });
});

describe('clusterByPath — convergence is a different key from dedupe', () => {
  it('clusters on the normalized file path, not on the fingerprint', () => {
    const a = raised({ axis: 'security', summary: 'ACL grants any signed binary' });
    const b = raised({ axis: 'architecture', summary: 'the gate owns two responsibilities' });
    const clusters = clusterByPath(foldAuditStore([a, b], { now: NOW }));
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.filePath).toBe('src/foo.ts');
    expect(clusters[0]?.members).toHaveLength(2);
  });

  it('counts convergence as distinct axes, so a singleton converges once', () => {
    const clusters = clusterByPath(foldAuditStore([raised()], { now: NOW }));
    expect(clusters[0]?.convergence).toBe(1);
  });

  it('does not call two findings from the same axis a convergence', () => {
    const a = raised({ axis: 'performance', summary: 'allocates inside the loop' });
    const b = raised({ axis: 'performance', summary: 'sorts on every render' });
    const clusters = clusterByPath(foldAuditStore([a, b], { now: NOW }));
    expect(clusters[0]?.members).toHaveLength(2);
    expect(clusters[0]?.convergence).toBe(1);
  });

  it('leaves a cluster nobody merged as several findings', () => {
    const a = raised({ axis: 'security', summary: 'one' });
    const b = raised({ axis: 'architecture', summary: 'two' });
    const clusters = clusterByPath(foldAuditStore([a, b], { now: NOW }));
    expect(clusters[0]?.members.map((m: FoldedFinding) => m.fingerprint).sort()).toEqual(
      [a.fingerprint, b.fingerprint].sort(),
    );
  });

  it('drops a merged member into its survivor rather than ranking it twice', () => {
    const a = raised({ axis: 'security', summary: 'one' });
    const b = raised({ axis: 'architecture', summary: 'two' });
    const clusters = clusterByPath(
      foldAuditStore(
        [
          a,
          b,
          {
            fingerprint: b.fingerprint,
            status: 'merged',
            ts: daysBefore(1),
            same_as: a.fingerprint,
          },
        ],
        { now: NOW },
      ),
    );
    expect(clusters[0]?.members).toHaveLength(1);
    expect(clusters[0]?.members[0]?.fingerprint).toBe(a.fingerprint);
    expect(clusters[0]?.mergedInto).toEqual([
      { fingerprint: b.fingerprint, sameAs: a.fingerprint },
    ]);
  });

  it('separates two different paths', () => {
    const a = raised({ file_path: 'src/a.ts', summary: 'one' });
    const b = raised({ file_path: 'src/b.ts', summary: 'two' });
    expect(clusterByPath(foldAuditStore([a, b], { now: NOW }))).toHaveLength(2);
  });
});

describe('rankClusters — severity first, then convergence, then confidence', () => {
  function cluster(members: AuditLine[]) {
    return clusterByPath(foldAuditStore(members, { now: NOW }));
  }

  it('never lets a high-confidence S4 outrank a two-axis S2', () => {
    const nit = raised({
      file_path: 'src/nit.ts',
      severity: 'S4-nit',
      confidence: 1,
      summary: 'a name could be clearer',
    });
    const majorA = raised({
      file_path: 'src/major.ts',
      severity: 'S2-major',
      axis: 'security',
      confidence: 0.4,
      summary: 'one',
    });
    const majorB = raised({
      file_path: 'src/major.ts',
      severity: 'S2-major',
      axis: 'architecture',
      confidence: 0.4,
      summary: 'two',
    });
    const ranked = rankClusters(cluster([nit, majorA, majorB]));
    expect(ranked[0]?.filePath).toBe('src/major.ts');
  });

  it('breaks a severity tie on convergence, descending', () => {
    const one = raised({ file_path: 'src/one.ts', axis: 'security', confidence: 1, summary: 'x' });
    const twoA = raised({
      file_path: 'src/two.ts',
      axis: 'security',
      confidence: 0.1,
      summary: 'y',
    });
    const twoB = raised({
      file_path: 'src/two.ts',
      axis: 'performance',
      confidence: 0.1,
      summary: 'z',
    });
    const ranked = rankClusters(cluster([one, twoA, twoB]));
    expect(ranked.map((c) => c.filePath)).toEqual(['src/two.ts', 'src/one.ts']);
  });

  it('breaks a severity-and-convergence tie on confidence, descending', () => {
    const low = raised({ file_path: 'src/low.ts', confidence: 0.2, summary: 'x' });
    const high = raised({ file_path: 'src/high.ts', confidence: 0.8, summary: 'y' });
    const ranked = rankClusters(cluster([low, high]));
    expect(ranked.map((c) => c.filePath)).toEqual(['src/high.ts', 'src/low.ts']);
  });

  it('is deterministic when severity, convergence and confidence all tie', () => {
    const a = raised({ file_path: 'src/a.ts', summary: 'x' });
    const b = raised({ file_path: 'src/b.ts', summary: 'y' });
    const forward = rankClusters(cluster([a, b])).map((c) => c.filePath);
    const backward = rankClusters(cluster([b, a])).map((c) => c.filePath);
    expect(forward).toEqual(backward);
  });

  it('takes a cluster severity from its most severe member', () => {
    const minor = raised({ file_path: 'src/mixed.ts', severity: 'S3-minor', summary: 'x' });
    const stop = raised({
      file_path: 'src/mixed.ts',
      axis: 'security',
      severity: 'S1-stop-the-line',
      summary: 'y',
    });
    const solo = raised({ file_path: 'src/solo.ts', severity: 'S2-major', summary: 'z' });
    const ranked = rankClusters(cluster([minor, stop, solo]));
    expect(ranked[0]?.filePath).toBe('src/mixed.ts');
    expect(ranked[0]?.severity).toBe('S1-stop-the-line');
  });

  it('ranks only what is still live — a fixed or declined finding is not offered again', () => {
    const live = raised({ file_path: 'src/live.ts', summary: 'x' });
    const done = raised({ file_path: 'src/done.ts', summary: 'y' });
    const ranked = rankClusters(
      cluster([
        live,
        done,
        { fingerprint: done.fingerprint, status: 'accepted', ts: daysBefore(1) },
      ]),
    );
    expect(ranked.map((c) => c.filePath)).toEqual(['src/live.ts']);
  });
});

describe('readAuditStore', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'audit-store-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reads an absent store as empty rather than throwing', () => {
    expect(readAuditStore(projectDir)).toEqual([]);
  });

  it('skips blank lines and preserves order', async () => {
    const storePath = auditStorePath(projectDir);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.dirname(storePath), { recursive: true });
    const a = raised({ summary: 'one' });
    const b = raised({ summary: 'two' });
    writeFileSync(storePath, `${JSON.stringify(a)}\n\n${JSON.stringify(b)}\n`);
    expect(readAuditStore(projectDir).map((line) => line.summary)).toEqual(['one', 'two']);
  });

  it('names the line it could not parse', async () => {
    const storePath = auditStorePath(projectDir);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, `${JSON.stringify(raised())}\nnot json\n`);
    expect(() => readAuditStore(projectDir)).toThrowError(
      expect.objectContaining({ code: 'audit.store-unparseable' }),
    );
  });

  it('round-trips what it wrote', async () => {
    const { appendAuditLines } = await import('../src/audit.js');
    const line = raised();
    appendAuditLines(projectDir, [line]);
    expect(readAuditStore(projectDir)).toEqual([line]);
    const text = await readFile(auditStorePath(projectDir), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
  });
});
