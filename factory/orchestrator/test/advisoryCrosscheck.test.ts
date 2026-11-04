import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVISORY_EVENT_TYPE,
  ADVISORY_REPRODUCED_EVENT_TYPE,
  advisoryRequest,
  reproduceAdvisoryFinding,
  runAdvisoryCrosscheck,
  selectAdvisoryProvider,
  testFilesFromDiffNames,
} from '../src/advisoryCrosscheck.js';
import type { CliProviderConfig, CrosscheckPolicy } from '../src/crosscheck.js';
import { appendEvent, readEvents } from '../src/events.js';
import { foldFindings, listFindings, raiseFinding, transition } from '../src/findings.js';
import type { JudgeRequest, JudgeResult } from '../src/providers/types.js';
import { ProviderError } from '../src/providers/types.js';
import { crosscheckDefaults } from './helpers/crosscheckPolicy.js';

const BUDGET = { timeout_ms: 10_000, max_output_bytes: 100_000 };

function cli(name: string, overrides: Partial<CliProviderConfig> = {}): CliProviderConfig {
  return {
    name,
    kind: 'api',
    transport: 'cli',
    enabled: true,
    enabledSource: 'declared',
    mode: 'active',
    modelTier: 'mid',
    command: name,
    args: [],
    ...overrides,
  };
}

function policy(
  providers: CliProviderConfig[],
  sendDiff = true,
  finder: { providers?: string[]; maxDiffBytes?: number } = {},
): CrosscheckPolicy {
  const defaults = crosscheckDefaults();
  return {
    ...defaults,
    providers: {
      claude: { name: 'claude', kind: 'native', enabled: true },
      ...Object.fromEntries(providers.map((p) => [p.name, p])),
    },
    quorumRule: { agreement: '2-of-3', minProviders: 2, acceptNonGatingActives: false },
    independentFinder: {
      ...defaults.independentFinder,
      sendDiff,
      providers: finder.providers ?? providers.map((p) => p.name),
      ...(finder.maxDiffBytes === undefined ? {} : { maxDiffBytes: finder.maxDiffBytes }),
    },
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    file_path: 'src/a.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    summary: 'retry loop runs one time too few',
    failure_scenario: { inputs: 'n=3', expected: '3 retries', actual: '2 retries' },
    ...overrides,
  };
}

function result(output: unknown): JudgeResult {
  return { provider: 'codex', kind: 'review', output, latency_ms: 5 };
}

describe('selectAdvisoryProvider', () => {
  it('picks the first enabled external provider, in file order', () => {
    const p = policy([cli('codex'), cli('deepseek')]);
    expect(selectAdvisoryProvider(p, () => true)).toEqual({ name: 'codex' });
  });

  it('skips a disabled provider and one whose binary is missing', () => {
    const p = policy([cli('codex', { enabled: false }), cli('other'), cli('third')]);
    expect(selectAdvisoryProvider(p, (cmd) => cmd === 'third')).toEqual({ name: 'third' });
  });

  it('skips a shadow provider: only active ones are asked', () => {
    const p = policy([cli('codex', { mode: 'shadow' }), cli('deepseek')]);
    expect(selectAdvisoryProvider(p, () => true)).toEqual({ name: 'deepseek' });
  });

  it('never picks a provider outside independent_finder.providers', () => {
    const p = policy([cli('codex'), cli('deepseek')], true, { providers: ['deepseek'] });
    expect(selectAdvisoryProvider(p, () => true)).toEqual({ name: 'deepseek' });
    const none = policy([cli('codex')], true, { providers: [] });
    expect(selectAdvisoryProvider(none, () => true)).toMatchObject({
      name: null,
      reason: expect.stringContaining('independent_finder.providers'),
    });
  });

  it('says why when nobody is available', () => {
    const none = selectAdvisoryProvider(policy([cli('codex', { enabled: false })]), () => true);
    expect(none).toMatchObject({ name: null });
    expect(selectAdvisoryProvider(policy([cli('codex')]), () => false)).toMatchObject({
      name: null,
      reason: expect.stringContaining('codex'),
    });
  });
});

describe('advisoryRequest', () => {
  it('carries the criteria, the diff and the test files, and no check labels', () => {
    const request = advisoryRequest({
      taskId: 't-1',
      diffRef: 'aaa..bbb',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+const marker = 1;\n',
      criteria: ['retries are bounded at 3'],
      testFiles: [{ path: 'test/a.test.ts', content: 'it("bounded", () => {})' }],
      budget: BUDGET,
    });
    expect(request.kind).toBe('review');
    expect(request.schemaName).toBe('finding-evidence');
    expect(request.prompt).toContain('retries are bounded at 3');
    expect(request.prompt).toContain('const marker = 1;');
    expect(request.prompt).toContain('test/a.test.ts');
    expect(request.prompt).toContain('it("bounded"');
    expect(request.prompt).toMatch(/concrete input/i);
    expect(request.prompt).toMatch(/no test would fail/i);
    expect(request.prompt).not.toMatch(/pre-merge|post-merge|unit \(/i);
  });
});

describe('testFilesFromDiffNames', () => {
  it('keeps test and spec files only', () => {
    expect(
      testFilesFromDiffNames(['src/a.ts', 'test/a.test.ts', 'src/b.spec.tsx', 'pkg/tests/x.py']),
    ).toEqual(['test/a.test.ts', 'src/b.spec.tsx', 'pkg/tests/x.py']);
  });
});

describe('runAdvisoryCrosscheck', () => {
  let stateDir: string;
  let repo: string;
  let base: string;
  let head: string;
  const sessionId = 'sess-advisory';
  const ctx = () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0` });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'smith-advisory-'));
    repo = mkdtempSync(path.join(tmpdir(), 'smith-advisory-repo-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    mkdirSync(path.join(repo, 'src'));
    mkdirSync(path.join(repo, 'test'));
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const x = 0;\n');
    git('add', 'src/a.ts');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(repo, 'test/a.test.ts'), 'it("x", () => {});\n');
    git('add', 'src/a.ts', 'test/a.test.ts');
    git('commit', '-q', '-m', 'head');
    head = git('rev-parse', 'HEAD');
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

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const input = (runJudgeImpl: (name: string, req: JudgeRequest) => Promise<JudgeResult>) => ({
    taskId: 't-1',
    project: repo,
    base,
    head,
    criteria: ['x is one'],
    budget: BUDGET,
    policy: policy([cli('codex')]),
    runJudgeImpl,
    commandOnPathImpl: () => true,
  });

  it('sends the derived diff and test files, and records advisory findings once', async () => {
    let seen: JudgeRequest | undefined;
    const out = await runAdvisoryCrosscheck(
      input(async (_n, req) => {
        seen = req;
        return result([evidence()]);
      }),
      ctx(),
      { stateDir },
    );
    expect(seen?.prompt).toContain('+export const x = 1;');
    expect(seen?.prompt).toContain('test/a.test.ts');
    expect(out.status).toBe('ok');
    expect(out.provider).toBe('codex');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      advisory: true,
      finding_id: expect.stringMatching(/^f-t-1-/),
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const events = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.record.payload).toMatchObject({
      status: 'ok',
      provider: 'codex',
      base,
      head,
    });
  });

  it('the same evidence gets the same fingerprint on a rerun', async () => {
    const a = await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    const b = await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    expect(a.findings[0]?.fingerprint).toBe(b.findings[0]?.fingerprint);
  });

  it('skips with an event when no provider is available, and calls nobody', async () => {
    let called = false;
    const out = await runAdvisoryCrosscheck(
      {
        ...input(async () => {
          called = true;
          return result([]);
        }),
        policy: policy([cli('codex', { enabled: false })]),
      },
      ctx(),
      { stateDir },
    );
    expect(called).toBe(false);
    expect(out.status).toBe('skipped');
    expect(out.reason).toBeTruthy();
    const events = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
    );
    expect(events[0]?.record.payload).toMatchObject({ status: 'skipped' });
  });

  it('skips when the transport cannot reach the provider (auth failing)', async () => {
    const out = await runAdvisoryCrosscheck(
      input(async () => {
        throw new ProviderError('provider.auth-failed', 'not logged in');
      }),
      ctx(),
      { stateDir },
    );
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('not logged in');
  });

  it('records a failure after the send as failed, with sent: true and the code', async () => {
    for (const code of ['provider.timeout', 'provider.cli-failed']) {
      const out = await runAdvisoryCrosscheck(
        input(async () => {
          throw new ProviderError(code, 'boom');
        }),
        ctx(),
        { stateDir },
      );
      expect(out.status).toBe('failed');
      const events = (await readEvents(sessionId, { stateDir })).filter(
        (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
      );
      expect(events.at(-1)?.record.payload).toMatchObject({
        status: 'failed',
        sent: true,
        error_code: code,
      });
    }
  });

  it('marks sent: false on a skip before the call', async () => {
    await runAdvisoryCrosscheck(
      { ...input(async () => result([])), policy: policy([cli('codex', { enabled: false })]) },
      ctx(),
      { stateDir },
    );
    const events = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
    );
    expect(events[0]?.record.payload).toMatchObject({ status: 'skipped', sent: false });
  });

  it('skips with diff-too-large instead of crashing on a diff over the git buffer', async () => {
    writeFileSync(
      path.join(repo, 'src/big.ts'),
      `${'x'.repeat(79)}
`.repeat(20_000),
    );
    git('add', 'src/big.ts');
    git('commit', '-q', '-m', 'big');
    const bigHead = git('rev-parse', 'HEAD');
    let called = false;
    const run = (maxDiffBytes: number) =>
      runAdvisoryCrosscheck(
        {
          ...input(async () => {
            called = true;
            return result([]);
          }),
          head: bigHead,
          policy: policy([cli('codex')], true, { maxDiffBytes }),
        },
        ctx(),
        { stateDir },
      );
    const small = await run(100_000);
    expect(small.status).toBe('skipped');
    expect(small.reason).toContain('diff-too-large');
    expect(called).toBe(false);
    // Over git's default 1 MiB buffer but inside the policy cap: it must be sent.
    writeFileSync(
      path.join(repo, 'src/big2.ts'),
      `${'y'.repeat(79)}
`.repeat(20_000),
    );
    git('add', 'src/big2.ts');
    git('commit', '-q', '-m', 'big2');
    const out = await runAdvisoryCrosscheck(
      {
        ...input(async () => {
          called = true;
          return result([]);
        }),
        head: git('rev-parse', 'HEAD'),
        policy: policy([cli('codex')], true, { maxDiffBytes: 5_000_000 }),
      },
      ctx(),
      { stateDir },
    );
    expect(out.status).toBe('ok');
    expect(called).toBe(true);
  });

  it('skips an empty diff', async () => {
    const out = await runAdvisoryCrosscheck(
      { ...input(async () => result([])), head: base },
      ctx(),
      {
        stateDir,
      },
    );
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('empty diff');
  });

  it('counts test files against the same byte budget and reports what it dropped', async () => {
    writeFileSync(
      path.join(repo, 'test/huge.test.ts'),
      `${'z'.repeat(79)}
`.repeat(5_000),
    );
    git('add', 'test/huge.test.ts');
    git('commit', '-q', '-m', 'huge test');
    // The huge file predates the range, so only the test budget can exclude it.
    const rangeBase = git('rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const x = 2;\n');
    git('add', 'src/a.ts');
    git('commit', '-q', '-m', 'small change');
    let seen: JudgeRequest | undefined;
    const out = await runAdvisoryCrosscheck(
      {
        ...input(async (_n, req) => {
          seen = req;
          return result([]);
        }),
        base: rangeBase,
        head: git('rev-parse', 'HEAD'),
        testFiles: ['test/huge.test.ts', 'test/a.test.ts'],
        policy: policy([cli('codex')], true, { maxDiffBytes: 100_000 }),
      },
      ctx(),
      { stateDir },
    );
    expect(out.status).toBe('ok');
    expect(seen?.prompt).not.toContain('zzzzzzzzzz');
    expect(out.test_files_dropped).toEqual([
      { path: 'test/huge.test.ts', reason: expect.stringContaining('budget') },
    ]);
    expect(out.test_files).toContain('test/a.test.ts');
    const events = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
    );
    expect(events[0]?.record.payload).toMatchObject({
      test_files_dropped: [{ path: 'test/huge.test.ts' }],
    });
  });

  it('honours an explicit test-file list over the derived one', async () => {
    let seen: JudgeRequest | undefined;
    const out = await runAdvisoryCrosscheck(
      {
        ...input(async (_n, req) => {
          seen = req;
          return result([]);
        }),
        testFiles: ['src/a.ts'],
      },
      ctx(),
      { stateDir },
    );
    expect(out.test_files).toEqual(['src/a.ts']);
    expect(seen?.prompt).toContain('--- src/a.ts');
    expect(seen?.prompt).not.toContain('--- test/a.test.ts');
  });

  it('skips rather than sending source when the policy does not authorize the diff', async () => {
    let called = false;
    const out = await runAdvisoryCrosscheck(
      {
        ...input(async () => {
          called = true;
          return result([]);
        }),
        policy: policy([cli('codex')], false),
      },
      ctx(),
      { stateDir },
    );
    expect(called).toBe(false);
    expect(out.status).toBe('skipped');
    expect(out.reason).toContain('send_diff');
  });

  it('discards the result when the worktree moved during the call', async () => {
    const out = await runAdvisoryCrosscheck(
      input(async () => {
        writeFileSync(path.join(repo, 'src/a.ts'), 'export const x = 99;\n');
        return result([evidence()]);
      }),
      ctx(),
      { stateDir },
    );
    expect(out.status).toBe('discarded');
    expect(out.findings).toEqual([]);
    const events = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
    );
    expect(events[0]?.record.payload).toMatchObject({ status: 'discarded', findings: [] });
  });

  it('records malformed provider output as a failure instead of crashing', async () => {
    for (const bad of [
      () => {
        throw new ProviderError('provider.invalid-output', 'not JSON');
      },
      async () => result([evidence({ severity: 'S9-nonsense' })]),
    ]) {
      const out = await runAdvisoryCrosscheck(input(bad as never), ctx(), { stateDir });
      expect(out.status).toBe('failed');
      expect(out.findings).toEqual([]);
      expect(out.reason).toBeTruthy();
    }
    const events = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_EVENT_TYPE,
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.record.payload).toMatchObject({ status: 'failed' });
  });

  it('advisory findings are not findings, votes or judge verdicts until reproduced', async () => {
    await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    const events = await readEvents(sessionId, { stateDir });
    expect(events.some((e) => e.record.event_type === 'judge-verdict')).toBe(false);
    expect(events.some((e) => e.record.event_type === 'dispatch_decision')).toBe(false);
    expect(foldFindings(events.map((e) => ({ ...e })))).toEqual([]);
    expect(await listFindings(sessionId, {}, { stateDir })).toEqual([]);
  });

  it('reproduce raises the finding for real, confirmed, and records the evidence', async () => {
    const run = await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    const id = run.findings[0]?.finding_id as string;
    const out = await reproduceAdvisoryFinding(
      { findingId: id, evidence: 'test/probe.test.ts fails: expected 3 got 2' },
      ctx(),
      { stateDir },
    );
    expect(out.finding.finding_status).toBe('confirmed');
    const stored = await listFindings(sessionId, { taskId: 't-1' }, { stateDir });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ finding_id: id, finding_status: 'confirmed' });
    expect(stored[0]).not.toHaveProperty('advisory');
    const marks = (await readEvents(sessionId, { stateDir })).filter(
      (e) => e.record.event_type === ADVISORY_REPRODUCED_EVENT_TYPE,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.record.payload).toMatchObject({
      finding_id: id,
      evidence: 'test/probe.test.ts fails: expected 3 got 2',
    });
  });

  it('reproduce refuses an unknown id and empty evidence', async () => {
    const run = await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    const id = run.findings[0]?.finding_id as string;
    await expect(
      reproduceAdvisoryFinding({ findingId: 'f-nope', evidence: 'x' }, ctx(), { stateDir }),
    ).rejects.toMatchObject({ code: 'crosscheck.unknown-finding' });
    await expect(
      reproduceAdvisoryFinding({ findingId: id, evidence: '  ' }, ctx(), { stateDir }),
    ).rejects.toMatchObject({ code: 'crosscheck.reproduce-needs-evidence' });
  });

  it('reproduce is idempotent: a second call changes nothing', async () => {
    const run = await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    const id = run.findings[0]?.finding_id as string;
    await reproduceAdvisoryFinding({ findingId: id, evidence: 'probe' }, ctx(), { stateDir });
    const again = await reproduceAdvisoryFinding({ findingId: id, evidence: 'probe' }, ctx(), {
      stateDir,
    });
    expect(again.already_reproduced).toBe(true);
    const events = await readEvents(sessionId, { stateDir });
    expect(events.filter((e) => e.record.event_type === 'finding-raised')).toHaveLength(1);
    expect(
      events.filter((e) => e.record.event_type === ADVISORY_REPRODUCED_EVENT_TYPE),
    ).toHaveLength(1);
  });

  it('a retry after a crash before the mark does not reset a finding that moved on', async () => {
    const run = await runAdvisoryCrosscheck(
      input(async () => result([evidence()])),
      ctx(),
      { stateDir },
    );
    const f = run.findings[0] as (typeof run.findings)[number];
    // The crashed first attempt got as far as raise + confirm + fix-pending, but wrote no mark.
    await raiseFinding(
      {
        filePath: f.file_path,
        finding: {
          finding_id: f.finding_id,
          task_id: f.task_id,
          finding_category: f.finding_category,
          severity: f.severity,
          finding_status: 'raised',
          summary: f.summary,
          failure_scenario: f.failure_scenario,
          found_by: 'reviewer',
        },
      },
      ctx(),
      { stateDir },
    );
    await transition(f.finding_id, 'confirmed', ctx(), { stateDir });
    await transition(f.finding_id, 'fix-pending', ctx(), { stateDir });
    await reproduceAdvisoryFinding({ findingId: f.finding_id, evidence: 'probe' }, ctx(), {
      stateDir,
    });
    const stored = await listFindings(sessionId, { taskId: 't-1' }, { stateDir });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.finding_status).toBe('fix-pending');
  });
});
