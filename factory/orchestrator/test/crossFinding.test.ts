import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliProviderConfig, CrosscheckPolicy, IndependentFinder } from '../src/crosscheck.js';
import {
  CROSS_FINDING_EVENT_TYPE,
  type IndependentRun,
  independentFinderRequest,
  type NativeFindingRecord,
  reconcile,
  runIndependentFinder,
} from '../src/crossFinding.js';
import { appendEvent, readEvents } from '../src/events.js';
import { computeFingerprint, type FindingEvidence } from '../src/findings.js';
import { decide, type LessonRule } from '../src/severity.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-judge-cli.mjs');

function evidence(overrides: Partial<FindingEvidence> = {}): FindingEvidence {
  return {
    file_path: 'src/a.ts',
    finding_category: 'correctness',
    severity: 'S3-minor',
    summary: 'off-by-one in the retry loop',
    failure_scenario: { inputs: 'n=3', expected: '3 retries', actual: '2 retries' },
    ...overrides,
  };
}

/** A stored finding whose fingerprint is the real digest of its own fields, as raiseFinding() would have written it. */
function native(overrides: Partial<NativeFindingRecord> = {}): NativeFindingRecord {
  const base = {
    finding_id: 'f-1',
    file_path: 'src/a.ts',
    finding_category: 'correctness',
    severity: 'S3-minor',
    summary: 'off-by-one in the retry loop',
    ...overrides,
  };
  return {
    ...base,
    fingerprint:
      overrides.fingerprint ??
      computeFingerprint({
        filePath: base.file_path ?? '',
        category: base.finding_category,
        summary: base.summary,
      }),
  };
}

function finder(overrides: Partial<IndependentFinder> = {}): IndependentFinder {
  return {
    enabled: true,
    mode: 'active',
    providers: ['codex'],
    sendDiff: true,
    maxDiffBytes: 120_000,
    severityResolution: 'highest-wins',
    ...overrides,
  };
}

function run(overrides: Partial<IndependentRun> = {}): IndependentRun {
  return { provider: 'codex', mode: 'active', evidence: [evidence()], ...overrides };
}

describe('crossFinding.ts reconcile — the additive direction', () => {
  it('corroborates a fingerprint both sides raised, and raises the severity to the worse reading', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ severity: 'S3-minor' })],
      independent: [run({ evidence: [evidence({ severity: 'S1-stop-the-line' })] })],
      policy: finder(),
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      outcome: 'corroborated',
      effect: 'raise-severity',
      native_severity: 'S3-minor',
      independent_severity: 'S1-stop-the-line',
      resolved_severity: 'S1-stop-the-line',
      applied: true,
      providers: ['codex'],
      gating_providers: ['codex'],
    });
    expect(report.severity_raises).toEqual([
      { fingerprint: report.entries[0]?.fingerprint, from: 'S3-minor', to: 'S1-stop-the-line' },
    ]);
    expect(report.gates).toBe(true);
    // Corroboration alone mints nothing: the finding already exists.
    expect(report.mintable).toHaveLength(0);
  });

  it('never LOWERS a severity: an independent finder that thinks it milder changes nothing', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ severity: 'S2-major' })],
      independent: [run({ evidence: [evidence({ severity: 'S4-nit' })] })],
      policy: finder(),
    });

    expect(report.entries[0]).toMatchObject({
      outcome: 'corroborated',
      effect: 'none',
      resolved_severity: null,
      applied: false,
    });
    expect(report.severity_raises).toHaveLength(0);
  });

  it('native-wins records the disagreement and acts on none of it', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ severity: 'S3-minor' })],
      independent: [run({ evidence: [evidence({ severity: 'S1-stop-the-line' })] })],
      policy: finder({ severityResolution: 'native-wins' }),
    });

    expect(report.entries[0]).toMatchObject({
      outcome: 'corroborated',
      effect: 'none',
      native_severity: 'S3-minor',
      // Still recorded — the operator reads the entry, the gate does not.
      independent_severity: 'S1-stop-the-line',
      applied: false,
    });
    expect(report.gates).toBe(false);
  });

  it('mints a finding only the independent finder raised', () => {
    const only = evidence({ file_path: 'src/b.ts', summary: 'unclosed handle on the error path' });
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [],
      independent: [run({ evidence: [only] })],
      policy: finder(),
    });

    expect(report.entries[0]).toMatchObject({
      outcome: 'independent-only',
      effect: 'raise-finding',
      applied: true,
      native_finding_id: null,
    });
    expect(report.mintable).toEqual([{ provider: 'codex', evidence: only }]);
  });

  // Rule 1 on the policy block: silence is absence of evidence, not refutation.
  it('leaves a native finding the finder did not mention exactly as it was', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ severity: 'S2-major' })],
      independent: [run({ evidence: [] })],
      policy: finder(),
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      outcome: 'native-only',
      effect: 'none',
      applied: false,
      native_severity: 'S2-major',
      providers: [],
    });
    expect(report.gates).toBe(false);
  });

  // Rule 2: nothing here can tell one bug described twice from two bugs in one function.
  it('records same file + same category with different wording as co-located, and never merges it', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ finding_id: 'f-9', summary: 'retry loop runs one time too few' })],
      independent: [run({ evidence: [evidence({ summary: 'retries are off by one' })] })],
      policy: finder(),
    });

    const coLocated = report.entries.find((e) => e.outcome === 'co-located');
    expect(coLocated).toMatchObject({
      effect: 'none',
      applied: false,
      // Deliberately unnamed: co-location is a location match, and naming one
      // of several natives would read as an identification.
      native_finding_id: null,
      // The natives it sits beside are listed, plural, precisely because the
      // entry is not claiming to have identified one of them.
      counterparts: ['f-9'],
    });
    // And the native it sits beside is NOT also reported as native-only: one
    // finding, one entry, or the counts say two bugs where there is one.
    expect(report.counts).toEqual({
      corroborated: 0,
      'co-located': 1,
      'independent-only': 0,
      'native-only': 0,
    });
    expect(report.mintable).toHaveLength(0);
  });

  it('co-locates across path spellings: ./src/a.ts and src/a.ts are one file', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ file_path: './src/a.ts', summary: 'a different sentence entirely' })],
      independent: [run({ evidence: [evidence({ file_path: 'src/a.ts' })] })],
      policy: finder(),
    });

    expect(report.entries[0]).toMatchObject({ outcome: 'co-located', file_path: 'src/a.ts' });
  });

  // D-191: `Finding.file_path` is optional because records raised before P9-15
  // carry none. Such a record is reconcilable but unreachable by either match:
  // its fingerprint was digested over an empty path, and co-location needs a
  // path to co-locate on. It survives untouched, which is rule 1 again.
  it('leaves a pre-P9-15 native record with no path alone, matching neither way', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ file_path: undefined })],
      // Identical category and wording, and still not the same finding: the
      // finder's evidence is about a file, and this record is about nowhere.
      independent: [run()],
      policy: finder(),
    });

    expect(report.entries.map((e) => e.outcome).sort()).toEqual([
      'independent-only',
      'native-only',
    ]);
    expect(report.entries.find((e) => e.outcome === 'native-only')?.file_path).toBeNull();
    expect(report.severity_raises).toHaveLength(0);
  });

  // The other half of NativeFindingRecord.file_path's claim: such a record
  // "can still be corroborated -- the fingerprint is a digest of the path it
  // was raised on". Only the never-co-located half was pinned, and the two
  // halves fail in opposite directions. If corroboration ever started reading
  // the path column instead of the fingerprint, this record would come back
  // `native-only` alongside an `independent-only` mint -- the factory raising
  // a duplicate of a finding it already holds, with no test going red.
  it('corroborates a pathless native record whose fingerprint still matches', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [
        // Raised on src/a.ts, so the digest is over that path; the column
        // itself is what a pre-P9-15 record lacks.
        native({
          file_path: undefined,
          fingerprint: computeFingerprint({
            filePath: 'src/a.ts',
            category: 'correctness',
            summary: 'off-by-one in the retry loop',
          }),
        }),
      ],
      independent: [run({ evidence: [evidence({ severity: 'S2-major' })] })],
      policy: finder(),
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      outcome: 'corroborated',
      effect: 'raise-severity',
      native_severity: 'S3-minor',
      resolved_severity: 'S2-major',
      applied: true,
      // The independent group's path, not the record's: the entry reports
      // where the finder looked, and the record says nowhere.
      file_path: 'src/a.ts',
    });
    expect(report.severity_raises).toHaveLength(1);
  });

  // ...and never co-located, even when the path it was raised on is exactly
  // the one the finder is describing. Co-location keys on the column, so the
  // record is invisible to it; the previous test's record could have been
  // excluded by its empty-path digest instead, which is why this one carries
  // a real path in its fingerprint and still does not co-locate.
  it('never co-locates a pathless native record, whatever it was raised on', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [
        native({
          file_path: undefined,
          fingerprint: computeFingerprint({
            filePath: 'src/a.ts',
            category: 'correctness',
            summary: 'off-by-one in the retry loop',
          }),
        }),
      ],
      // Same file, same category, different wording: co-location's exact
      // shape. A record carrying file_path: 'src/a.ts' would land here.
      independent: [
        run({ evidence: [evidence({ summary: 'the retry loop runs one time short' })] }),
      ],
      policy: finder(),
    });

    expect(report.entries.map((e) => e.outcome).sort()).toEqual([
      'independent-only',
      'native-only',
    ]);
    expect(report.counts['co-located']).toBe(0);
    // And the additive side still fires: the finder's claim is minted, which
    // is the cost of a record with no path -- a duplicate, not a silence.
    expect(report.entries.find((e) => e.outcome === 'independent-only')?.effect).toBe(
      'raise-finding',
    );
  });

  it('folds two providers on one fingerprint into one entry naming both', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [],
      independent: [
        run({ provider: 'codex', evidence: [evidence({ severity: 'S3-minor' })] }),
        run({ provider: 'deepseek', evidence: [evidence({ severity: 'S1-stop-the-line' })] }),
      ],
      policy: finder({ providers: ['codex', 'deepseek'] }),
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      outcome: 'independent-only',
      providers: ['codex', 'deepseek'],
      gating_providers: ['codex', 'deepseek'],
      // Worst reading in the group, always — `severity_resolution` arbitrates
      // native-vs-independent and has nothing to say about two finders.
      independent_severity: 'S1-stop-the-line',
    });
    // Credited to whoever raised it first, so `found_by_provider` names one vendor.
    expect(report.mintable).toEqual([
      { provider: 'codex', evidence: evidence({ severity: 'S3-minor' }) },
    ]);
  });

  it('takes the worse group severity even under native-wins', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [],
      independent: [
        run({ provider: 'codex', evidence: [evidence({ severity: 'S4-nit' })] }),
        run({ provider: 'deepseek', evidence: [evidence({ severity: 'S2-major' })] }),
      ],
      policy: finder({ providers: ['codex', 'deepseek'], severityResolution: 'native-wins' }),
    });

    expect(report.entries[0]?.independent_severity).toBe('S2-major');
  });

  it('accounts for every finding exactly once', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [
        native({ finding_id: 'f-1' }),
        native({ finding_id: 'f-2', file_path: 'src/c.ts', summary: 'leaks a file descriptor' }),
      ],
      independent: [
        run({
          evidence: [
            evidence(),
            evidence({ file_path: 'src/d.ts', summary: 'unchecked index' }),
            evidence({ file_path: 'src/c.ts', summary: 'descriptor never closed' }),
          ],
        }),
      ],
      policy: finder(),
    });

    expect(report.counts).toEqual({
      corroborated: 1,
      'co-located': 1,
      'independent-only': 1,
      'native-only': 0,
    });
    expect(report.entries).toHaveLength(3);
  });
});

describe('crossFinding.ts reconcile — shadow has zero gating power', () => {
  it('records every entry and applies none when the block is in shadow', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [native({ severity: 'S3-minor' })],
      independent: [
        run({ mode: 'shadow', evidence: [evidence({ severity: 'S1-stop-the-line' })] }),
        run({
          provider: 'deepseek',
          mode: 'shadow',
          evidence: [evidence({ file_path: 'src/z.ts', summary: 'null deref' })],
        }),
      ],
      policy: finder({ mode: 'shadow', providers: ['codex', 'deepseek'] }),
    });

    expect(report.entries).toHaveLength(2);
    expect(report.entries.map((e) => e.effect).sort()).toEqual(['raise-finding', 'raise-severity']);
    expect(report.entries.every((e) => e.applied)).toBe(false);
    expect(report.gates).toBe(false);
    expect(report.severity_raises).toHaveLength(0);
    expect(report.mintable).toHaveLength(0);
  });

  it('applies nothing a shadow PROVIDER raised, even when the block itself is active', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [],
      independent: [run({ mode: 'shadow' })],
      policy: finder(),
    });

    expect(report.entries[0]).toMatchObject({
      effect: 'raise-finding',
      providers: ['codex'],
      gating_providers: [],
      applied: false,
    });
    expect(report.mintable).toHaveLength(0);
  });

  it('applies an entry one active provider backs, even when a shadow one also raised it', () => {
    const report = reconcile({
      taskId: 'epic-1/task-1',
      native: [],
      independent: [
        run({ provider: 'deepseek', mode: 'shadow' }),
        run({ provider: 'codex', mode: 'active' }),
      ],
      policy: finder({ providers: ['deepseek', 'codex'] }),
    });

    expect(report.entries[0]).toMatchObject({
      providers: ['deepseek', 'codex'],
      gating_providers: ['codex'],
      applied: true,
    });
    // Credited to whoever raised it first, shadow or not — the mint is the
    // gate action, the credit is provenance.
    expect(report.mintable[0]?.provider).toBe('deepseek');
  });
});

describe('crossFinding.ts independentFinderRequest — the operator mandate', () => {
  const req = (overrides: Record<string, unknown> = {}) => ({
    taskId: 'epic-1/task-1',
    diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+const x = 1;\n',
    diffRef: 'smith/epic-1/integration...task-1',
    budget: { timeout_ms: 5000, max_output_bytes: 100_000 },
    policy: finder(),
    ...overrides,
  });

  it('refuses to send a diff `send_diff: false` never authorized', () => {
    expect(() => independentFinderRequest(req({ policy: finder({ sendDiff: false }) }))).toThrow(
      /send_diff/,
    );
    try {
      independentFinderRequest(req({ policy: finder({ sendDiff: false }) }));
    } catch (err) {
      expect((err as { code: string }).code).toBe('crossfind.diff-not-authorized');
    }
  });

  it('refuses an empty diff rather than prompting a finder with no code', () => {
    try {
      independentFinderRequest(req({ diff: '   \n  ' }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('crossfind.empty-diff');
    }
  });

  it('refuses an oversized diff rather than truncating it', () => {
    try {
      independentFinderRequest(
        req({ diff: 'x'.repeat(200), policy: finder({ maxDiffBytes: 100 }) }),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('crossfind.diff-too-large');
      expect((err as Error).message).toMatch(/200-byte diff/);
    }
  });

  it('asks for finding-evidence, carries the diff, and records how much of it was sent', () => {
    const request = independentFinderRequest(req({ criteria: ['retries are bounded'] }));

    expect(request.kind).toBe('review');
    expect(request.schemaName).toBe('finding-evidence');
    expect(request.inputRefs).toMatchObject({ diff_ref: 'smith/epic-1/integration...task-1' });
    expect(Number(request.inputRefs.diff_bytes)).toBeGreaterThan(0);
    expect(request.prompt).toContain('const x = 1;');
    expect(request.prompt).toContain('retries are bounded');
    // The mandate is to FIND, and the fresh context is the whole point: it is
    // never shown what the native reviewer said.
    expect(request.prompt).toContain('You have not been shown its');
    expect(request.prompt).toContain('Return [] if you find nothing');
  });
});

describe('crossFinding.ts runIndependentFinder', () => {
  let stateDir: string;
  const sessionId = 'sess-crossfind';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-crossfind-'));
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });

  const request = () =>
    independentFinderRequest({
      taskId: 'epic-1/task-1',
      diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+const x = 1;\n',
      diffRef: 'smith/epic-1/integration...task-1',
      budget: { timeout_ms: 10_000, max_output_bytes: 100_000 },
      policy: finder(),
    });

  /** A policy whose `codex` is the fake CLI judge, answering with the file at `answerPath`. */
  function codexFixture(answerPath: string, mode: 'shadow' | 'active'): CliProviderConfig {
    return {
      name: 'codex',
      kind: 'api',
      transport: 'cli',
      enabled: true,
      mode,
      modelTier: 'mid',
      command: 'node',
      args: [FIXTURE, 'echo-prompt', answerPath],
    };
  }

  function policyWith(
    codex: CliProviderConfig,
    overrides: Partial<IndependentFinder> = {},
  ): CrosscheckPolicy {
    return {
      ...crosscheckDefaults(),
      providers: {
        claude: { name: 'claude', kind: 'native', enabled: true },
        codex,
      },
      quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
      independentFinder: finder(overrides),
    };
  }

  async function answerFile(evidenceList: FindingEvidence[]): Promise<string> {
    const file = path.join(stateDir, 'answer.json');
    await writeFile(file, JSON.stringify(evidenceList));
    return file;
  }

  it('refuses to report "no findings" when the finder is switched off', async () => {
    await expect(
      runIndependentFinder(
        {
          taskId: 'epic-1/task-1',
          request: request(),
          native: [],
          policy: policyWith(codexFixture('/nonexistent', 'active'), { enabled: false }),
        },
        ctx(),
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'crossfind.disabled' });
  });

  it('refuses a "second opinion" from the native provider itself', async () => {
    await expect(
      runIndependentFinder(
        {
          taskId: 'epic-1/task-1',
          request: request(),
          native: [],
          policy: policyWith(codexFixture('/nonexistent', 'active'), { providers: ['claude'] }),
        },
        ctx(),
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'crossfind.native-finder' });
  });

  it('refuses an enabled finder that names nobody, and says so in those words', async () => {
    // Naming nobody and naming only disabled providers are different mistakes
    // with different repairs, and the empty case used to fall through to the
    // second sentence -- which rendered as `providers names , and crosscheck.yml
    // enables none of them`, a hole exactly where the operator's own words are
    // supposed to be.
    const failure = await runIndependentFinder(
      {
        taskId: 'epic-1/task-1',
        request: request(),
        native: [],
        policy: policyWith(codexFixture('/nonexistent', 'active'), { providers: [] }),
      },
      ctx(),
      { stateDir },
    ).then(
      () => null,
      (err: Error & { code?: string }) => err,
    );

    expect(failure?.code).toBe('crossfind.no-providers');
    expect(failure?.message).toContain('independent_finder.providers is empty');
    expect(failure?.message).not.toContain('names ,');

    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === CROSS_FINDING_EVENT_TYPE)).toBe(false);
    expect(events.some((e) => e.record.event_type === 'judge-verdict')).toBe(false);
  });

  it('refuses when every named provider is disabled, and writes no events', async () => {
    const codex = codexFixture('/nonexistent', 'active');
    codex.enabled = false;
    const policy = policyWith(codex);

    await expect(
      runIndependentFinder(
        { taskId: 'epic-1/task-1', request: request(), native: [], policy },
        ctx(),
        { stateDir },
      ),
    ).rejects.toMatchObject({ code: 'crossfind.no-providers' });

    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === CROSS_FINDING_EVENT_TYPE)).toBe(false);
    expect(events.some((e) => e.record.event_type === 'judge-verdict')).toBe(false);
  });

  it('runs a real finder, records it like any other judge, and drafts the finding it alone raised', async () => {
    const answer = await answerFile([
      evidence({ file_path: 'src/b.ts', summary: 'unclosed handle on the error path' }),
    ]);

    const result = await runIndependentFinder(
      {
        taskId: 'epic-1/task-1',
        request: request(),
        native: [native()],
        policy: policyWith(codexFixture(answer, 'active')),
      },
      ctx(),
      { stateDir },
    );

    expect(result.report.counts).toMatchObject({ 'independent-only': 1, 'native-only': 1 });
    expect(result.report.gates).toBe(true);
    expect(result.raise).toHaveLength(1);
    expect(result.raise[0]?.finding).toMatchObject({
      task_id: 'epic-1/task-1',
      found_by: 'reviewer',
      found_by_provider: 'codex',
      severity: 'S3-minor',
    });

    const events = await readEvents(sessionId, { stateDir });
    // Recorded exactly like a quorum critic: one dispatch, one verdict, so a
    // finder shows up in `smith stats providers` with everything else.
    const dispatch = events.find((e) => e.record.event_type === 'dispatch_decision');
    expect(dispatch?.record.payload).toMatchObject({
      agent_role: 'reviewer',
      provider: 'codex',
      model_tier: 'mid',
    });
    const verdict = events.find((e) => e.record.event_type === 'judge-verdict');
    expect(verdict?.record.payload).toMatchObject({
      provider: 'codex',
      kind: 'review',
      ok: true,
      // A finder judges no single finding: the honest value is null, not an
      // id borrowed from whatever the native reviewer happened to raise.
      finding_id: null,
      // Both sides said "there are bugs here" — the only agreement question a
      // finder can be asked, since neither answered the other's claim.
      native_verdict: 'confirm',
      agreement_with_native: true,
    });

    const reconciled = events.find((e) => e.record.event_type === CROSS_FINDING_EVENT_TYPE);
    expect(reconciled?.event_id).toBe(result.reconciledEventId);
    expect(reconciled?.record.payload).toMatchObject({
      task_id: 'epic-1/task-1',
      mode: 'active',
      severity_resolution: 'highest-wins',
      gates: true,
      providers: ['codex'],
      skipped_providers: [],
      failed_providers: [],
      mintable_finding_ids: [result.raise[0]?.finding.finding_id],
    });
  });

  it('records the reconciliation and drafts nothing in shadow mode', async () => {
    const answer = await answerFile([
      evidence({ file_path: 'src/b.ts', summary: 'unclosed handle on the error path' }),
    ]);

    const result = await runIndependentFinder(
      {
        taskId: 'epic-1/task-1',
        request: request(),
        native: [],
        policy: policyWith(codexFixture(answer, 'shadow'), { mode: 'shadow' }),
      },
      ctx(),
      { stateDir },
    );

    expect(result.report.entries).toHaveLength(1);
    expect(result.report.entries[0]).toMatchObject({ effect: 'raise-finding', applied: false });
    expect(result.report.gates).toBe(false);
    expect(result.raise).toHaveLength(0);

    const events = await readEvents(sessionId, { stateDir });
    const reconciled = events.find((e) => e.record.event_type === CROSS_FINDING_EVENT_TYPE);
    expect(reconciled?.record.payload).toMatchObject({ gates: false, mintable_finding_ids: [] });
  });

  it('keeps a failed provider distinguishable from a silent one', async () => {
    const garbage = codexFixture('/nonexistent', 'active');
    garbage.args = [FIXTURE, 'garbage'];
    const policy = policyWith(garbage);

    const result = await runIndependentFinder(
      { taskId: 'epic-1/task-1', request: request(), native: [native()], policy },
      ctx(),
      { stateDir },
    );

    expect(result.runs[0]?.outcome.ok).toBe(false);
    // The native finding stands: a finder that never answered refutes nothing.
    expect(result.report.counts).toMatchObject({ 'native-only': 1, 'independent-only': 0 });
    expect(result.report.gates).toBe(false);

    const events = await readEvents(sessionId, { stateDir });
    const reconciled = events.find((e) => e.record.event_type === CROSS_FINDING_EVENT_TYPE);
    expect(reconciled?.record.payload).toMatchObject({
      providers: ['codex'],
      failed_providers: ['codex'],
      skipped_providers: [],
    });
  });

  it('answers [] as a real answer: nothing raised, nothing subtracted', async () => {
    const answer = await answerFile([]);

    const result = await runIndependentFinder(
      {
        taskId: 'epic-1/task-1',
        request: request(),
        native: [native({ severity: 'S2-major' })],
        policy: policyWith(codexFixture(answer, 'active')),
      },
      ctx(),
      { stateDir },
    );

    expect(result.runs[0]?.outcome.ok).toBe(true);
    expect(result.report.entries).toEqual([
      expect.objectContaining({
        outcome: 'native-only',
        effect: 'none',
        native_severity: 'S2-major',
      }),
    ]);
    expect(result.raise).toHaveLength(0);
  });
});

describe('severity.ts decide — a corroborated severity is a real raise, not a note', () => {
  it('raises the finding to the corroborating finder`s severity', () => {
    const decision = decide(
      { finding_category: 'correctness', severity: 'S3-minor' },
      { filePath: 'src/a.ts', lessons: [], corroboratedSeverity: 'S2-major' },
    );

    expect(decision).toMatchObject({
      severity: 'S2-major',
      blocks: true,
      action: 'block',
      corroborated: true,
    });
  });

  it('ignores a milder corroboration', () => {
    const decision = decide(
      { finding_category: 'correctness', severity: 'S2-major' },
      { filePath: 'src/a.ts', lessons: [], corroboratedSeverity: 'S4-nit' },
    );

    expect(decision).toMatchObject({ severity: 'S2-major', corroborated: false });
  });

  it('escalates a repeat mistake on top of the corroborated severity, not under it', () => {
    const lessons: LessonRule[] = [
      {
        lessonId: 'L-1',
        scope: 'claim-path',
        category: 'correctness',
        claimPath: 'src/**',
        agentRole: '',
        caseType: '',
        statement: 'the retry loop has been off by one before',
      },
    ];

    const withoutFinder = decide(
      { finding_category: 'correctness', severity: 'S3-minor' },
      { filePath: 'src/a.ts', lessons },
    );
    expect(withoutFinder).toMatchObject({ severity: 'S2-major', sameMistake: true });

    const withFinder = decide(
      { finding_category: 'correctness', severity: 'S3-minor' },
      { filePath: 'src/a.ts', lessons, corroboratedSeverity: 'S2-major' },
    );
    // S3 -> S2 (corroborated) -> S1 (repeat). Reversed, this lands at S2 and
    // a repeated, twice-confirmed bug merges behind a waiver.
    expect(withFinder).toMatchObject({
      severity: 'S1-stop-the-line',
      sameMistake: true,
      corroborated: true,
    });
  });

  it('leaves every pre-crossfind decision untouched when no finder ran', () => {
    const decision = decide(
      { finding_category: 'correctness', severity: 'S3-minor' },
      { filePath: 'src/a.ts', lessons: [] },
    );

    expect(decision).toMatchObject({
      severity: 'S3-minor',
      action: 'waiver-batch',
      corroborated: false,
    });
  });
});
