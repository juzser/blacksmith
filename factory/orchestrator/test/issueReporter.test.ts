import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldErrorEvents, renderComment, toIssueCommentFields } from '../src/errorIssues.js';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import type { CommandResult, CommandRunner } from '../src/gh.js';
import { runGit } from '../src/git.js';
import {
  ISSUE_REPORT_OUTCOMES,
  ISSUE_REPORT_PAYLOAD_KEYS,
  type IssueReportOutcome,
  previewOutcomes,
  reportErrors,
} from '../src/issueReporter.js';
import type { ProjectRef } from '../src/projects.js';

// No test in this file spawns a real process for `gh`; every invocation
// is a recorded call against a stub runner (nonfunctional clause 2).

const CLOCK = () => '2026-02-01T00:00:00.000Z';
const ENABLED = () => true;

interface RunnerCall {
  cmd: string;
  args: string[];
}

function bucketOf(call: RunnerCall): 'auth' | 'search' | 'create' | 'comment' | 'other' {
  if (call.args[0] === 'auth') return 'auth';
  if (call.args[0] === 'issue' && call.args[1] === 'list') return 'search';
  if (call.args[0] === 'issue' && call.args[1] === 'create') return 'create';
  if (call.args[0] === 'issue' && call.args[1] === 'comment') return 'comment';
  return 'other';
}

function readBodyFile(argv: string[]): string {
  const idx = argv.indexOf('--body-file');
  if (idx === -1) throw new Error('no --body-file in argv');
  return readFileSync(argv[idx + 1] as string, 'utf8');
}

interface StubOptions {
  auth?: 'ready' | 'missing' | 'unauthenticated' | 'unknown';
  /** Called once per search, `n` is the 1-based call index for THIS runner. */
  search?: (query: string, n: number) => CommandResult;
  create?: (title: string) => CommandResult;
  comment?: (issueNumber: string) => CommandResult;
}

function defaultSearch(): CommandResult {
  return { status: 0, stdout: '[]', stderr: '' };
}
function defaultCreate(): CommandResult {
  return { status: 0, stdout: 'https://github.com/o/r/issues/1\n', stderr: '' };
}
function defaultComment(): CommandResult {
  return { status: 0, stdout: '', stderr: '' };
}

function makeStub(opts: StubOptions = {}): {
  runner: CommandRunner;
  calls: RunnerCall[];
  bucket: (kind: 'auth' | 'search' | 'create' | 'comment') => RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  let searchN = 0;
  const runner: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'auth') {
      switch (opts.auth ?? 'ready') {
        case 'ready':
          return { status: 0, stdout: '', stderr: '' };
        case 'missing':
          return { status: null, stdout: '', stderr: '', spawnError: 'ENOENT' };
        case 'unauthenticated':
          return { status: 1, stdout: '', stderr: 'not logged in. run gh auth login' };
        case 'unknown':
          return { status: 1, stdout: '', stderr: 'gateway timeout' };
      }
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      searchN += 1;
      const q = args[args.indexOf('--search') + 1] ?? '';
      return (opts.search ?? defaultSearch)(q, searchN);
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const title = args[args.indexOf('--title') + 1] ?? '';
      return (opts.create ?? defaultCreate)(title);
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      const issueNumber = args[2] ?? '';
      return (opts.comment ?? defaultComment)(issueNumber);
    }
    throw new Error(`unexpected runner call: ${cmd} ${JSON.stringify(args)}`);
  };
  const bucket = (kind: 'auth' | 'search' | 'create' | 'comment') =>
    calls.filter((c) => bucketOf(c) === kind);
  return { runner, calls, bucket };
}

/** A search stub that finds nothing on the first call, and finds an open
 * issue whose body carries the exact fingerprint line on every call after. */
function foundAfterFirst(): (query: string, n: number) => CommandResult {
  return (query, n) => {
    if (n === 1) return { status: 0, stdout: '[]', stderr: '' };
    const body = `...\nFingerprint: ${query}\n`;
    return {
      status: 0,
      stdout: JSON.stringify([{ number: 7, body, url: `https://github.com/o/r/issues/7` }]),
      stderr: '',
    };
  };
}

describe('issueReporter.ts', () => {
  let stateDir: string;
  let repoDirs: string[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-issuereporter-'));
    repoDirs = [];
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await Promise.all(repoDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeRepo(remoteUrl: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'smith-issuereporter-repo-'));
    repoDirs.push(dir);
    runGit(dir, ['init', '-q', '-b', 'main']);
    runGit(dir, ['remote', 'add', 'origin', remoteUrl]);
    return dir;
  }

  /** Appends a real session-start plus one candidate-shaped event to `stateDir`
   * so the module's own `appendEvent` calls can resolve `causal_parent`. */
  async function seed(input: {
    sessionId: string;
    eventType: 'gate-outcome' | 'error-logged' | 'task-added';
    payload: Record<string, unknown>;
    taskId: string;
    project?: string;
    planVersion?: number;
    ts?: string;
  }): Promise<StoredEvent> {
    const planVersion = input.planVersion ?? 1;
    const root = await appendEvent(
      {
        session_id: input.sessionId,
        actor: 'system',
        event_type: 'session-start',
        plan_version: planVersion,
        causal_parent: null,
        payload: {},
        ...(input.project ? { project: input.project } : {}),
      },
      { stateDir },
    );
    return appendEvent(
      {
        session_id: input.sessionId,
        actor: 'system',
        event_type: input.eventType,
        task_id: input.taskId,
        plan_version: planVersion,
        causal_parent: root.event_id,
        payload: input.payload,
        ...(input.project ? { project: input.project } : {}),
      },
      { stateDir },
    );
  }

  async function fiveGateRounds(taskId: string, project?: string): Promise<StoredEvent[]> {
    const slug = taskId.replace(/\//g, '-');
    const out: StoredEvent[] = [];
    for (let n = 1; n <= 5; n += 1) {
      out.push(
        await seed({
          sessionId: `session-${slug}-${n}`,
          eventType: 'gate-outcome',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
          taskId,
          project,
          planVersion: n,
          ts: `2026-01-0${n}T00:00:00.000Z`,
        }),
      );
    }
    return out;
  }

  // --- AC1: one create, four comments, across five sessions/plan versions ---
  it('collapses five rounds of one broken gate into one create and four comments (AC1)', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const events = await fiveGateRounds('epic-1/task-a', 'black-smith');
    const { runner, bucket, calls } = makeStub({ search: foundAfterFirst() });

    const records = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(bucket('create')).toHaveLength(1);
    expect(bucket('comment')).toHaveLength(4);
    expect(records.map((r) => r.outcome)).toEqual([
      'opened',
      'commented',
      'commented',
      'commented',
      'commented',
    ]);
    // Evidence: the recorded argv list, paste-worthy.
    expect(calls.filter((c) => bucketOf(c) !== 'auth').map((c) => c.args.slice(0, 2))).toEqual([
      ['issue', 'list'],
      ['issue', 'create'],
      ['issue', 'list'],
      ['issue', 'comment'],
      ['issue', 'list'],
      ['issue', 'comment'],
      ['issue', 'list'],
      ['issue', 'comment'],
      ['issue', 'list'],
      ['issue', 'comment'],
    ]);
  });

  // --- AC2: all three sources dedup the same way ---
  it.each([
    [
      'gate-outcome',
      (_taskId: string) => ({ outcome: 'blocked', reason: 'tests-failed' }) as const,
    ],
    ['task-added', (_taskId: string) => ({ task_status: 'failed', epic_id: 'epic-1' }) as const],
    [
      'error-logged',
      (taskId: string) => ({
        error: 'execution.test-failure',
        severity: 'S2-major',
        task_ref: taskId,
      }),
    ],
  ] as const)(
    'dedups five rounds of a %s source into one create, four comments (AC2)',
    async (eventType, payload) => {
      const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
      const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
      const taskId = `epic-1/task-${eventType}`;
      const events: StoredEvent[] = [];
      for (let n = 1; n <= 5; n += 1) {
        events.push(
          await seed({
            sessionId: `session-${eventType}-${n}`,
            eventType,
            payload: payload(taskId),
            taskId,
            project: 'black-smith',
            planVersion: n,
          }),
        );
      }
      const { bucket, runner } = makeStub({ search: foundAfterFirst() });

      await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

      expect(bucket('create')).toHaveLength(1);
      expect(bucket('comment')).toHaveLength(4);
    },
  );

  // --- AC3: exact-match dedup only ---
  it('comments on an exact fingerprint-line match (AC3a)', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const events = await fiveGateRounds('epic-1/task-exact', 'black-smith').then((all) =>
      all.slice(0, 1),
    );
    const { runner, bucket } = makeStub({
      search: (query) => ({
        status: 0,
        stdout: JSON.stringify([{ number: 3, body: `Fingerprint: ${query}\n`, url: 'u' }]),
        stderr: '',
      }),
    });

    const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(record?.outcome).toBe('commented');
    expect(bucket('create')).toHaveLength(0);
  });

  it('opens a new issue when the fingerprint only appears as a substring (AC3b)', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const events = await fiveGateRounds('epic-1/task-substr', 'black-smith').then((all) =>
      all.slice(0, 1),
    );
    const { runner, bucket } = makeStub({
      search: (query) => ({
        status: 0,
        stdout: JSON.stringify([
          {
            number: 3,
            body: `unrelated prose mentioning ${query} inline, not the line format`,
            url: 'u',
          },
        ]),
        stderr: '',
      }),
    });

    const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(record?.outcome).toBe('opened');
    expect(bucket('create')).toHaveLength(1);
  });

  // --- AC4 gap: a search that exits 0 but returns something the module
  // cannot read as an issue list must fail DISTINGUISHABLY from a genuine
  // nonzero exit (reason: 'search-failed', covered by the "search fails" row
  // of the outcome table below). buildSearchIssuesArgv now requests --json,
  // so in real use this branch only fires on a malformed/short JSON payload —
  // the first case below stands in for that (e.g. gh printing a human table
  // because --json was somehow dropped, or a truncated response).
  it.each<{ name: string; stdout: string }>([
    {
      name: 'stdout is a gh issue-list human table, not JSON',
      stdout: '123\tOPEN\tSome bug title\tfactory-error\t2024-01-01T00:00:00Z\n',
    },
    { name: 'stdout is valid JSON but not an array', stdout: JSON.stringify({ items: [] }) },
    {
      name: 'stdout is an array but an item is missing body',
      stdout: JSON.stringify([{ number: 1 }]),
    },
    {
      name: 'stdout is an array but an item has a non-string body',
      stdout: JSON.stringify([{ number: 1, body: 42 }]),
    },
  ])(
    'search exits 0 with unreadable output: $name (AC4 search-unparseable branch)',
    async ({ stdout }) => {
      const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
      const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
      const events = await fiveGateRounds('epic-1/task-unreadable-search', 'black-smith').then(
        (all) => all.slice(0, 1),
      );
      const { runner, bucket } = makeStub({
        search: () => ({ status: 0, stdout, stderr: '' }),
      });

      const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

      expect(record?.outcome).toBe('failed');
      expect(record?.reason).toBe('search-unparseable');
      expect(bucket('create')).toHaveLength(0);
      expect(bucket('comment')).toHaveLength(0);
    },
  );

  // --- AC4: the full outcome table ---
  it('grades the full (outcome, reason) pairing table (AC4)', async () => {
    const okDir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const noOriginDir = await mkdtemp(path.join(tmpdir(), 'smith-issuereporter-noorigin-'));
    repoDirs.push(noOriginDir);
    runGit(noOriginDir, ['init', '-q', '-b', 'main']);

    const register: ProjectRef[] = [
      { name: 'black-smith', dir: okDir, self: true },
      { name: 'no-origin-project', dir: noOriginDir, self: false },
    ];

    type Row = {
      name: string;
      project?: string;
      register: ProjectRef[];
      enabled: (p: string) => boolean;
      stub: ReturnType<typeof makeStub>;
      history?: StoredEvent[];
      expected: { outcome: IssueReportOutcome; reason?: string };
      expectZeroWrites: boolean;
    };

    const noHitOnce = () => ({ status: 0, stdout: '[]', stderr: '' });

    const rows: Row[] = [];

    // 1. switch off
    rows.push({
      name: 'switch off',
      project: 'black-smith',
      register,
      enabled: () => false,
      stub: makeStub(),
      expected: { outcome: 'skipped-disabled', reason: 'switch-off' },
      expectZeroWrites: true,
    });
    // 2. project absent from the register
    rows.push({
      name: 'project absent',
      project: 'ghost-project',
      register,
      enabled: () => true,
      stub: makeStub(),
      expected: { outcome: 'skipped-no-remote', reason: 'no-checkout' },
      expectZeroWrites: true,
    });
    // 3. project present, no origin
    rows.push({
      name: 'no origin',
      project: 'no-origin-project',
      register,
      enabled: () => true,
      stub: makeStub(),
      expected: { outcome: 'skipped-no-remote', reason: 'no-origin' },
      expectZeroWrites: true,
    });
    // 4. gh missing
    rows.push({
      name: 'gh missing',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({ auth: 'missing' }),
      expected: { outcome: 'skipped-gh-missing', reason: 'gh-not-on-path' },
      expectZeroWrites: true,
    });
    // 5. gh unauthenticated
    rows.push({
      name: 'gh unauthenticated',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({ auth: 'unauthenticated' }),
      expected: { outcome: 'skipped-unauthenticated', reason: 'gh-unauthenticated' },
      expectZeroWrites: true,
    });
    // 6. gh unknown
    rows.push({
      name: 'gh unknown',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({ auth: 'unknown' }),
      expected: { outcome: 'failed', reason: 'gh-unknown' },
      expectZeroWrites: true,
    });
    // 8. search exits non-zero
    rows.push({
      name: 'search fails',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({ search: () => ({ status: 1, stdout: '', stderr: 'boom' }) }),
      expected: { outcome: 'failed', reason: 'search-failed' },
      expectZeroWrites: false,
    });
    // 9. exact match, comment succeeds
    rows.push({
      name: 'match, comment ok',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({
        search: (q) => ({
          status: 0,
          stdout: JSON.stringify([{ number: 9, body: `Fingerprint: ${q}\n`, url: 'u9' }]),
          stderr: '',
        }),
      }),
      expected: { outcome: 'commented' },
      expectZeroWrites: false,
    });
    // 10. exact match, comment fails
    rows.push({
      name: 'match, comment fails',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({
        search: (q) => ({
          status: 0,
          stdout: JSON.stringify([{ number: 10, body: `Fingerprint: ${q}\n`, url: 'u10' }]),
          stderr: '',
        }),
        comment: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      }),
      expected: { outcome: 'failed', reason: 'comment-failed' },
      expectZeroWrites: false,
    });
    // 11. no match, create succeeds
    rows.push({
      name: 'no match, create ok',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({ search: noHitOnce }),
      expected: { outcome: 'opened' },
      expectZeroWrites: false,
    });
    // 12. no match, create fails
    rows.push({
      name: 'no match, create fails',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: makeStub({
        search: noHitOnce,
        create: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      }),
      expected: { outcome: 'failed', reason: 'create-failed' },
      expectZeroWrites: false,
    });
    // 13. unstamped and unresolvable -- fail closed, never the factory's own project by default
    rows.push({
      name: 'project unresolved',
      project: undefined,
      register,
      enabled: () => true,
      stub: makeStub(),
      expected: { outcome: 'skipped-unresolved-project', reason: 'project-unresolved' },
      expectZeroWrites: true,
    });

    // 7. nothing new since the last report -- deduped-open, needs prior history.
    // Built by actually reporting once (recording a real `opened` event),
    // then reading the full log back as the second call's input -- the same
    // mechanism the idempotence test (AC9) exercises.
    const dedupEvent = await seed({
      sessionId: 'session-dedup-1',
      eventType: 'gate-outcome',
      payload: { outcome: 'blocked', reason: 'tests-failed' },
      taskId: 'epic-1/task-dedup',
      project: 'black-smith',
    });
    const firstStub = makeStub({ search: () => ({ status: 0, stdout: '[]', stderr: '' }) });
    await reportErrors([dedupEvent], () => true, register, firstStub.runner, CLOCK, { stateDir });
    const { readEvents: readEventsForDedup } = await import('../src/events.js');
    const dedupHistory = await readEventsForDedup('session-dedup-1', { stateDir });
    const historyStub = makeStub();
    rows.push({
      name: 'already reported, nothing new',
      project: 'black-smith',
      register,
      enabled: () => true,
      stub: historyStub,
      history: dedupHistory,
      expected: { outcome: 'deduped-open', reason: 'already-reported' },
      expectZeroWrites: true,
    });

    const table: Array<{ name: string; outcome: string; reason?: string }> = [];
    let recordCount = 0;
    let candidateCount = 0;

    for (const row of rows) {
      const events =
        row.history ??
        (await (async () => [
          await seed({
            sessionId: `session-row-${row.name.replace(/\s+/g, '-')}`,
            eventType: 'gate-outcome',
            payload: { outcome: 'blocked', reason: 'tests-failed' },
            taskId: `epic-1/task-${row.name.replace(/\s+/g, '-')}`,
            project: row.project,
          }),
        ])());
      candidateCount += 1;
      const records = await reportErrors(
        events,
        row.enabled,
        row.register,
        row.stub.runner,
        CLOCK,
        {
          stateDir,
        },
      );
      expect(records).toHaveLength(1);
      recordCount += records.length;
      const [record] = records;
      if (!record) throw new Error(`row "${row.name}" recorded no outcome`);
      table.push({ name: row.name, outcome: record.outcome, reason: record.reason });
      expect(record.outcome).toBe(row.expected.outcome);
      expect(record.reason).toBe(row.expected.reason);
      if (row.expectZeroWrites) {
        expect(row.stub.bucket('search')).toHaveLength(0);
        expect(row.stub.bucket('create')).toHaveLength(0);
        expect(row.stub.bucket('comment')).toHaveLength(0);
      }
    }

    // (a) already asserted per-row above.
    // (b) surjectivity: the set of outcomes seen equals the eight-word constant.
    const seen = new Set(table.map((r) => r.outcome));
    expect(seen).toEqual(new Set(ISSUE_REPORT_OUTCOMES));
    // (c) one record per candidate error, always -- no silent early return.
    expect(recordCount).toBe(candidateCount);
  });

  // --- AC5: two projects resolve to two repositories ---
  it('resolves two projects to two distinct repo slugs (AC5)', async () => {
    const factoryDir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const demoDir = await makeRepo('git@github.com:someone/demo-rpg.git');
    const register: ProjectRef[] = [
      { name: 'black-smith', dir: factoryDir, self: true },
      { name: 'demo-rpg', dir: demoDir, self: false },
    ];
    const events = [
      await seed({
        sessionId: 'session-demo',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-demo',
        project: 'demo-rpg',
      }),
      await seed({
        sessionId: 'session-factory',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-factory',
        project: 'black-smith',
      }),
    ];
    const { runner, calls } = makeStub();

    await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    const createArgvs = calls.filter((c) => bucketOf(c) === 'create').map((c) => c.args);
    expect(createArgvs).toHaveLength(2);
    expect(createArgvs.some((a) => a.includes('--repo') && a.includes('someone/demo-rpg'))).toBe(
      true,
    );
    expect(createArgvs.some((a) => a.includes('--repo') && a.includes('juzser/blacksmith'))).toBe(
      true,
    );
  });

  it('refuses a project the register does not name, with zero recorded argv (AC5b)', async () => {
    const register: ProjectRef[] = [];
    const events = [
      await seed({
        sessionId: 'session-unknown',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-unknown',
        project: 'unregistered-project',
      }),
    ];
    const { runner, calls } = makeStub();

    const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(record).toMatchObject({ outcome: 'skipped-no-remote', reason: 'no-checkout' });
    expect(calls).toHaveLength(0);
  });

  // --- AC6: the switch, and the factory's own default ---
  it('obeys the switch: one project on, one off', async () => {
    const onDir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const offDir = await makeRepo('git@github.com:someone/off-project.git');
    const register: ProjectRef[] = [
      { name: 'black-smith', dir: onDir, self: true },
      { name: 'off-project', dir: offDir, self: false },
    ];
    const events = [
      await seed({
        sessionId: 'session-on',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-on',
        project: 'black-smith',
      }),
      await seed({
        sessionId: 'session-off',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-off',
        project: 'off-project',
      }),
    ];
    const enabled = (p: string) => p !== 'off-project';
    const { runner, bucket } = makeStub();

    const records = await reportErrors(events, enabled, register, runner, CLOCK, { stateDir });

    expect(bucket('create')).toHaveLength(1);
    expect(records.find((r) => r.project === 'off-project')?.outcome).toBe('skipped-disabled');
  });

  it('skips with skipped-unresolved-project -- never a default report on the factory itself -- when a row is unstamped and unresolved', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const events = [
      await seed({
        sessionId: 'session-default-on',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-default',
      }),
    ];
    const { runner, bucket } = makeStub();

    const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(record?.outcome).toBe('skipped-unresolved-project');
    expect(bucket('create')).toHaveLength(0);
  });

  // --- AC7: the act is a fact -- allowlist and secret containment ---
  it('appends one issue-reported event per candidate, with the exact allowlisted key set', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const openedEvents = [
      await seed({
        sessionId: 'session-opened',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-opened',
        project: 'black-smith',
      }),
    ];
    const dedupEvents = [
      await seed({
        sessionId: 'session-payload-dedup',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-payload-dedup',
        project: 'black-smith',
      }),
    ];
    const failedEvents = [
      await seed({
        sessionId: 'session-payload-failed',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-payload-failed',
        project: 'black-smith',
      }),
    ];

    const openedRunner = makeStub({ search: () => ({ status: 0, stdout: '[]', stderr: '' }) });
    await reportErrors(openedEvents, ENABLED, register, openedRunner.runner, CLOCK, { stateDir });

    const { readEvents } = await import('../src/events.js');

    const dedupRunner = makeStub({ search: () => ({ status: 0, stdout: '[]', stderr: '' }) });
    await reportErrors(dedupEvents, ENABLED, register, dedupRunner.runner, CLOCK, { stateDir });
    const dedupFullLog = await readEvents('session-payload-dedup', { stateDir });
    const dedupRecords = await reportErrors(
      dedupFullLog,
      ENABLED,
      register,
      dedupRunner.runner,
      CLOCK,
      {
        stateDir,
      },
    );

    const failedRunner = makeStub({ auth: 'unknown' });
    await reportErrors(failedEvents, ENABLED, register, failedRunner.runner, CLOCK, { stateDir });

    expect(dedupRecords[0]?.outcome).toBe('deduped-open');
    const openedLog = await readEvents('session-opened', { stateDir });
    const dedupLog = await readEvents('session-payload-dedup', { stateDir });
    const failedLog = await readEvents('session-payload-failed', { stateDir });

    const openedPayload = openedLog.find((e) => e.record.event_type === 'issue-reported')?.record
      .payload;
    const dedupPayload = dedupLog.filter((e) => e.record.event_type === 'issue-reported').at(-1)
      ?.record.payload;
    const failedPayload = failedLog.find((e) => e.record.event_type === 'issue-reported')?.record
      .payload;

    const expectedKeys = {
      opened: [
        'error_class',
        'fingerprint',
        'issue_url',
        'latest_event_id',
        'outcome',
        'repo_slug',
        'source',
        'task_ref',
      ],
      'deduped-open': [
        'error_class',
        'fingerprint',
        'latest_event_id',
        'outcome',
        'reason',
        'repo_slug',
        'source',
        'task_ref',
      ],
      failed: [
        'error_class',
        'fingerprint',
        'latest_event_id',
        'outcome',
        'reason',
        'repo_slug',
        'source',
        'task_ref',
      ],
    } as const;

    // The allowlist itself: the sorted ten-key literal AC6 asserts against.
    expect([...ISSUE_REPORT_PAYLOAD_KEYS]).toEqual([
      'detail',
      'error_class',
      'fingerprint',
      'issue_url',
      'latest_event_id',
      'outcome',
      'reason',
      'repo_slug',
      'source',
      'task_ref',
    ]);

    for (const [label, payload] of [
      ['opened', openedPayload],
      ['deduped-open', dedupPayload],
      ['failed', failedPayload],
    ] as const) {
      expect(payload, label).toBeDefined();
      // Exact sorted key set, per representative row (AC7): a tenth key of
      // any name, or a missing required one, fails here. `detail` is
      // present exactly on `skipped-no-remote`, not on any of these three.
      expect(Object.keys(payload as object).sort()).toEqual([...expectedKeys[label]].sort());
      expect((payload as Record<string, unknown>).latest_event_id).toBeTruthy();
      expect((payload as Record<string, unknown>).detail).toBeUndefined();
    }
    expect((openedPayload as Record<string, unknown>).issue_url).toBeTruthy();
    expect((openedPayload as Record<string, unknown>).reason).toBeUndefined();
    expect((dedupPayload as Record<string, unknown>).issue_url).toBeUndefined();
    expect((dedupPayload as Record<string, unknown>).reason).toBe('already-reported');
    expect((failedPayload as Record<string, unknown>).issue_url).toBeUndefined();
    expect((failedPayload as Record<string, unknown>).reason).toBe('gh-unknown');
  });

  it('never lets a secret in event detail reach the payload or any argv (AC7 secret)', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const SECRET = 'SECRETLIKE-abc123';
    const events = [
      await seed({
        sessionId: 'session-secret',
        eventType: 'error-logged',
        payload: {
          error: 'execution.test-failure',
          severity: 'S2-major',
          task_ref: 'epic-1/task-secret',
          detail: SECRET,
        },
        taskId: 'epic-1/task-secret',
        project: 'black-smith',
      }),
    ];
    const { runner, calls } = makeStub();

    await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(SECRET);
      if (call.args.includes('--body-file')) {
        expect(readBodyFile(call.args)).not.toContain(SECRET);
      }
    }

    const { readEvents } = await import('../src/events.js');
    const log = await readEvents('session-secret', { stateDir });
    const reported = log.find((e) => e.record.event_type === 'issue-reported');
    expect(JSON.stringify(reported?.record.payload)).not.toContain(SECRET);
  });

  // --- AC8: the comment body is the renderer's output, byte for byte ---
  it('the comment body is renderComment()s output, strictly equal', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const events = await fiveGateRounds('epic-1/task-render', 'black-smith');
    const { runner, calls } = makeStub({ search: foundAfterFirst() });

    const records = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    const commentCall = calls.find((c) => bucketOf(c) === 'comment');
    if (!commentCall) throw new Error('no comment call recorded');
    const body = readBodyFile(commentCall.args);

    // The first comment call carries the second folded report: fold the same
    // seeded events through the pure fold and render the expected body from
    // it, then compare strictly -- one extra or missing byte fails here.
    const commentedRecord = records.find((r) => r.outcome === 'commented');
    if (!commentedRecord) throw new Error('no commented record');
    const { reports } = foldErrorEvents(events, CLOCK(), ENABLED);
    const report = reports.find((r) => r.latest_event_id === commentedRecord.latest_event_id);
    if (!report) throw new Error('no folded report for the commented record');
    expect(body).toBe(renderComment(toIssueCommentFields(report)));
  });

  it('never lets secret detail or a fenced diff reach an argv or the payload (AC8 secret)', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const SECRET = 'SECRETLIKE-abc123';
    const DIFF = '```diff\n- old\n+ new\n```';
    const events = [
      await seed({
        sessionId: 'session-secret-comment-1',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed', detail: `${SECRET}\n${DIFF}` },
        taskId: 'epic-1/task-secret-comment',
        project: 'black-smith',
      }),
    ];
    const { bucket: bucket1, runner: runner1 } = makeStub({
      search: () => ({ status: 0, stdout: '[]', stderr: '' }),
    });
    await reportErrors(events, ENABLED, register, runner1, CLOCK, { stateDir });

    const events2 = [
      await seed({
        sessionId: 'session-secret-comment-2',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed', detail: `${SECRET}\n${DIFF}` },
        taskId: 'epic-1/task-secret-comment',
        project: 'black-smith',
      }),
    ];
    const { runner: runner2, calls } = makeStub({
      search: (q) => ({
        status: 0,
        stdout: JSON.stringify([{ number: 1, body: `Fingerprint: ${q}\n`, url: 'u' }]),
        stderr: '',
      }),
    });
    await reportErrors(events2, ENABLED, register, runner2, CLOCK, { stateDir });
    void bucket1;

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(SECRET);
      expect(call.args.join(' ')).not.toContain(DIFF);
      if (call.args.includes('--body-file')) {
        const content = readBodyFile(call.args);
        expect(content).not.toContain(SECRET);
        expect(content).not.toContain(DIFF);
      }
    }
    const { readEvents } = await import('../src/events.js');
    const log = await readEvents('session-secret-comment-2', { stateDir });
    const reported = log.find((e) => e.record.event_type === 'issue-reported');
    expect(JSON.stringify(reported?.record.payload)).not.toContain(SECRET);
    expect(JSON.stringify(reported?.record.payload)).not.toContain(DIFF);
  });

  // --- AC9: idempotence ---
  it('is idempotent: a second call over the same log records zero creates, zero comments', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const events = [
      await seed({
        sessionId: 'session-idem',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-idem',
        project: 'black-smith',
      }),
    ];
    const { runner: runner1 } = makeStub({
      search: () => ({ status: 0, stdout: '[]', stderr: '' }),
    });
    await reportErrors(events, ENABLED, register, runner1, CLOCK, { stateDir });

    const { readEvents } = await import('../src/events.js');
    const fullLog = await readEvents('session-idem', { stateDir });

    const { runner: runner2, bucket } = makeStub();
    const secondRecords = await reportErrors(fullLog, ENABLED, register, runner2, CLOCK, {
      stateDir,
    });

    expect(bucket('create')).toHaveLength(0);
    expect(bucket('comment')).toHaveLength(0);
    expect(secondRecords.every((r) => r.outcome === 'deduped-open')).toBe(true);
  });
  // --- task 5 AC9: previewOutcomes is gh-free and event-free at its own
  // boundary. Under the null (preview routed through reportErrors) the
  // runner's gh branch throws at step 3 and the log grows by two.
  it('previews A as deduped-open and B with all three argv blocks, spawning no gh and appending nothing (AC9)', async () => {
    const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
    const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
    const candidate = (letter: string) =>
      seed({
        sessionId: `session-preview-${letter}`,
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: `epic-1/task-preview-${letter}`,
        project: 'black-smith',
      });
    // A: reported once for real (against a stub), so the log carries a prior
    // `issue-reported` whose fingerprint matches A. B: never reported.
    await reportErrors([await candidate('a')], ENABLED, register, makeStub().runner, CLOCK, {
      stateDir,
    });
    const bEvents = [await candidate('b')];
    const logsOnDisk = async () =>
      (await readEvents('session-preview-a', { stateDir })).length +
      (await readEvents('session-preview-b', { stateDir })).length;
    const combined = [...(await readEvents('session-preview-a', { stateDir })), ...bEvents];
    const countBefore = await logsOnDisk();

    // A stub whose gh branch would throw if reached at all.
    const calls: RunnerCall[] = [];
    const ghThrows: CommandRunner = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh') throw new Error(`previewOutcomes reached gh: ${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    };
    const records = await previewOutcomes(combined, ENABLED, register, ghThrows, CLOCK);
    expect(records).toHaveLength(2);
    const a = records.find((r) => r.task_ref === 'epic-1/task-preview-a');
    const b = records.find((r) => r.task_ref === 'epic-1/task-preview-b');
    if (!a || !b) throw new Error('both candidates must be previewed');

    // (a) A settled deduped-open/already-reported at step 4, no argv block.
    expect([a.outcome, a.reason, a.settled_at_step]).toEqual([
      'deduped-open',
      'already-reported',
      4,
    ]);
    expect([a.search_argv, a.create_argv, a.comment_argv]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    // (b) B carries the search argv and both candidate argvs, with the
    // rendered issue body and comment text.
    expect(b.settled_at_step).toBeUndefined();
    const search = [
      'issue',
      'list',
      '--repo',
      'juzser/blacksmith',
      '--state',
      'open',
      '--json',
      'number,body,url',
    ];
    expect(b.search_argv).toEqual([...search, '--search', b.fingerprint]);
    expect(b.create_argv?.slice(0, 4)).toEqual(['issue', 'create', '--repo', 'juzser/blacksmith']);
    expect(b.comment_argv?.slice(0, 2)).toEqual(['issue', 'comment']);
    expect(b.issue_body).toContain(`Fingerprint: ${b.fingerprint}`);
    const bReport = foldErrorEvents(bEvents, CLOCK(), ENABLED).reports[0];
    if (!bReport) throw new Error('B did not fold');
    expect(b.comment_text).toBe(renderComment(toIssueCommentFields(bReport)));
    expect(b.decision_note).toMatch(/search/);

    // (c) both records state step 3 was not performed.
    expect(a.step_3_gh_availability).toBe('not-performed');
    expect(b.step_3_gh_availability).toBe('not-performed');

    // (d) zero recorded invocations whose command is gh.
    expect(calls.filter((c) => c.cmd === 'gh')).toHaveLength(0);

    // (e) the on-disk event count is identical before and after.
    expect(countBefore).toBe(5);
    expect(await logsOnDisk()).toBe(countBefore);
  });

  // --- task 5 AC6: the register is required and fails at the boundary,
  // naming itself, rather than inside resolveProjectRepo.
  it('refuses with a message naming register when no register is supplied (AC6)', async () => {
    const payload = { outcome: 'blocked', reason: 'tests-failed' };
    const taskId = 'epic-1/task-no-register';
    const events = [
      await seed({ sessionId: 'session-no-register', eventType: 'gate-outcome', payload, taskId }),
    ];
    const { runner } = makeStub();
    const missing = undefined as unknown as ProjectRef[];
    const real = reportErrors(events, ENABLED, missing, runner, CLOCK, { stateDir });
    await expect(real).rejects.toThrow(/register/);
    await expect(previewOutcomes(events, ENABLED, missing, runner, CLOCK)).rejects.toThrow(
      /register/,
    );
  });

  // --- task 5: previewOutcomes' own steps 1 and 2, untouched by the AC9
  // fixture (which only ever reaches step 4 or the gh-reaching branch).
  it('previews skipped-disabled at step 1 and skipped-no-remote at step 2, with no argv either way', async () => {
    const off = await seed({
      sessionId: 'session-preview-off',
      eventType: 'gate-outcome',
      payload: { outcome: 'blocked', reason: 'tests-failed' },
      taskId: 'epic-1/task-preview-off',
      project: 'off-project',
    });
    const noRemote = await seed({
      sessionId: 'session-preview-no-remote',
      eventType: 'gate-outcome',
      payload: { outcome: 'blocked', reason: 'tests-failed' },
      taskId: 'epic-1/task-preview-no-remote',
      project: 'unregistered-project',
    });
    const isEnabled = (project: string) => project !== 'off-project';
    const { runner } = makeStub();
    const records = await previewOutcomes([off, noRemote], isEnabled, [], runner, CLOCK);

    const disabled = records.find((r) => r.task_ref === 'epic-1/task-preview-off');
    expect(disabled).toMatchObject({
      settled_at_step: 1,
      outcome: 'skipped-disabled',
      reason: 'switch-off',
    });
    expect(disabled?.search_argv).toBeUndefined();

    const noRemoteRecord = records.find((r) => r.task_ref === 'epic-1/task-preview-no-remote');
    expect(noRemoteRecord).toMatchObject({
      settled_at_step: 2,
      outcome: 'skipped-no-remote',
      reason: 'no-checkout',
    });
    expect(noRemoteRecord?.search_argv).toBeUndefined();
    expect(noRemoteRecord?.repo_slug).toBeUndefined();
  });

  // --- task 10 AC5: git-failed's detail reaches both reporter paths.
  it('carries git-failed and its detail on both reportErrors and previewOutcomes', async () => {
    const dir = await makeRepo('https://github.com/o/r.git');
    const configPath = path.join(dir, '.git', 'config');
    writeFileSync(configPath, `this is not a config line\n${readFileSync(configPath, 'utf8')}`);
    const register: ProjectRef[] = [{ name: 'corrupt-project', dir, self: false }];

    const events = [
      await seed({
        sessionId: 'session-git-failed',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-git-failed',
        project: 'corrupt-project',
      }),
    ];
    const { runner, calls } = makeStub();

    const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(record).toMatchObject({ outcome: 'skipped-no-remote', reason: 'git-failed' });
    expect(record?.detail).toMatch(/bad config line 1/);
    expect(record?.repo_slug).toBeUndefined();
    expect(record?.issue_url).toBeUndefined();
    expect(calls).toHaveLength(0);

    const { readEvents } = await import('../src/events.js');
    const log = await readEvents('session-git-failed', { stateDir });
    const payload = log.find((e) => e.record.event_type === 'issue-reported')?.record.payload as
      | Record<string, unknown>
      | undefined;
    expect(payload?.detail).toBe(record?.detail);

    const previewRunner = makeStub().runner;
    const [preview] = await previewOutcomes(events, ENABLED, register, previewRunner, CLOCK);

    expect(preview).toMatchObject({
      settled_at_step: 2,
      outcome: 'skipped-no-remote',
      reason: 'git-failed',
    });
    expect(preview?.detail).toBe(record?.detail);
    expect(preview?.search_argv).toBeUndefined();
    expect(preview?.create_argv).toBeUndefined();
    expect(preview?.comment_argv).toBeUndefined();
  });

  // --- task 10: detail travels on every skipped-no-remote arm, not only
  // git-failed -- no-checkout carries it too.
  it('carries the refusal detail on every skipped-no-remote, not only git-failed (no-checkout)', async () => {
    const register: ProjectRef[] = [];
    const events = [
      await seed({
        sessionId: 'session-no-checkout-detail',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-no-checkout-detail',
        project: 'unregistered-project',
      }),
    ];
    const { runner, calls } = makeStub();

    const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(record).toMatchObject({ outcome: 'skipped-no-remote', reason: 'no-checkout' });
    expect(record?.detail).toBe('no checkout registered for project "unregistered-project"');
    expect(calls).toHaveLength(0);

    const { readEvents } = await import('../src/events.js');
    const log = await readEvents('session-no-checkout-detail', { stateDir });
    const payload = log.find((e) => e.record.event_type === 'issue-reported')?.record.payload as
      | Record<string, unknown>
      | undefined;
    expect(payload?.detail).toBe('no checkout registered for project "unregistered-project"');

    const previewRunner = makeStub().runner;
    const [preview] = await previewOutcomes(events, ENABLED, register, previewRunner, CLOCK);

    expect(preview).toMatchObject({
      settled_at_step: 2,
      outcome: 'skipped-no-remote',
      reason: 'no-checkout',
    });
    expect(preview?.detail).toBe('no checkout registered for project "unregistered-project"');
  });

  // --- privacy leak guard: an unstamped row from a session or plan driving a
  // foreign project must never resolve to this factory's own repo. The
  // resolver is the optional last parameter `reportErrors`/`previewOutcomes`
  // do not yet accept: these fail to compile (thus to pass) until they do.
  describe('project resolution for unstamped rows (privacy leak guard)', () => {
    it("routes an unstamped row to its own project's registered repo, not the factory's, when a resolver is wired in", async () => {
      const factoryDir = await makeRepo('git@github.com:juzser/blacksmith.git');
      const foreignDir = await makeRepo('git@github.com:example-org/example-app.git');
      const register: ProjectRef[] = [
        { name: 'black-smith', dir: factoryDir, self: true },
        { name: 'example-app', dir: foreignDir, self: false },
      ];
      const events = [
        // Unstamped: no `project` field at all -- exactly what a session
        // driving a foreign project writes when nothing stamps the row.
        await seed({
          sessionId: 'session-foreign',
          eventType: 'gate-outcome',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
          taskId: 'epic-9/task-foreign',
        }),
      ];
      const resolveProject = (taskRef: string) =>
        taskRef.startsWith('epic-9/') ? 'example-app' : null;
      const { runner, bucket } = makeStub();

      const [record] = await reportErrors(
        events,
        ENABLED,
        register,
        runner,
        CLOCK,
        { stateDir },
        resolveProject,
      );

      expect(record?.project).toBe('example-app');
      const createArgvs = bucket('create').map((c) => c.args);
      expect(createArgvs).toHaveLength(1);
      expect(createArgvs[0]).toContain('example-org/example-app');
      expect(createArgvs.some((a) => a.includes('juzser/blacksmith'))).toBe(false);
    });

    it('skips with skipped-no-remote rather than defaulting to the factory repo when the foreign project has no registered checkout', async () => {
      const register: ProjectRef[] = [];
      const events = [
        await seed({
          sessionId: 'session-foreign-unregistered',
          eventType: 'gate-outcome',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
          taskId: 'epic-9/task-foreign',
        }),
      ];
      const resolveProject = (taskRef: string) =>
        taskRef.startsWith('epic-9/') ? 'example-app' : null;
      const { runner, calls } = makeStub();

      const [record] = await reportErrors(
        events,
        ENABLED,
        register,
        runner,
        CLOCK,
        { stateDir },
        resolveProject,
      );

      expect(record).toMatchObject({
        project: 'example-app',
        outcome: 'skipped-no-remote',
        reason: 'no-checkout',
      });
      expect(calls).toHaveLength(0);
    });

    it('skips with skipped-unresolved-project rather than defaulting to the factory project when no resolver is wired in (backward compatible)', async () => {
      const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
      const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
      const events = [
        await seed({
          sessionId: 'session-no-resolver',
          eventType: 'gate-outcome',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
          taskId: 'epic-9/task-no-resolver',
        }),
      ];
      const { runner, bucket } = makeStub();

      const [record] = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

      expect(record?.project).toBeNull();
      expect(record?.outcome).toBe('skipped-unresolved-project');
      expect(bucket('create')).toHaveLength(0);
    });

    it("does not let one run's own issue-reported project stamp leak into a later run's unresolved row in the same session (S1-a)", async () => {
      const dir = await makeRepo('git@github.com:juzser/blacksmith.git');
      const register: ProjectRef[] = [{ name: 'black-smith', dir, self: true }];
      const firstEvent = await seed({
        sessionId: 'session-loop',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-first',
      });
      // Run 1: nothing stamps this row, but a resolver (standing in for the
      // real self-fallback wired into the CLI) answers it -- appendIssueReported
      // then writes that answer onto the resulting issue-reported row's own
      // `project` field, exactly as the real resolver would.
      const resolverRun1 = (taskRef: string) =>
        taskRef === 'epic-1/task-first' ? 'black-smith' : null;
      await reportErrors(
        [firstEvent],
        ENABLED,
        register,
        makeStub().runner,
        CLOCK,
        { stateDir },
        resolverRun1,
      );
      const fullLog = await readEvents('session-loop', { stateDir });
      const secondEvent = await seed({
        sessionId: 'session-loop',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-second',
      });

      // Run 2: a resolver that cannot answer this different row directly.
      // The only way it could still resolve is by reading run 1's own
      // issue-reported stamp back off the shared session -- the feedback
      // loop this guards against.
      const { runner: runner2, bucket } = makeStub();
      const [record] = await reportErrors(
        [...fullLog, secondEvent],
        ENABLED,
        register,
        runner2,
        CLOCK,
        { stateDir },
        () => null,
      );

      expect(record?.project).toBeNull();
      expect(record?.outcome).toBe('skipped-unresolved-project');
      expect(bucket('create')).toHaveLength(0);
    });

    it("previewOutcomes resolves the same way: an unstamped foreign row previews against its own repo, never the factory's", async () => {
      const factoryDir = await makeRepo('git@github.com:juzser/blacksmith.git');
      const foreignDir = await makeRepo('git@github.com:example-org/example-app.git');
      const register: ProjectRef[] = [
        { name: 'black-smith', dir: factoryDir, self: true },
        { name: 'example-app', dir: foreignDir, self: false },
      ];
      const events = [
        await seed({
          sessionId: 'session-foreign-preview',
          eventType: 'gate-outcome',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
          taskId: 'epic-9/task-foreign-preview',
        }),
      ];
      const resolveProject = (taskRef: string) =>
        taskRef.startsWith('epic-9/') ? 'example-app' : null;
      const previewRunner = makeStub().runner;

      const [preview] = await previewOutcomes(
        events,
        ENABLED,
        register,
        previewRunner,
        CLOCK,
        resolveProject,
      );

      expect(preview?.project).toBe('example-app');
      expect(preview?.repo_slug).toBe('example-org/example-app');
    });

    it('a project stamp on the row always wins over the resolver, in both reportErrors and previewOutcomes', async () => {
      const stampedDir = await makeRepo('git@github.com:example-org/stamped-app.git');
      const register: ProjectRef[] = [{ name: 'stamped-app', dir: stampedDir, self: false }];
      const events = [
        await seed({
          sessionId: 'session-stamped',
          eventType: 'gate-outcome',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
          taskId: 'epic-9/task-stamped',
          project: 'stamped-app',
        }),
      ];
      const resolveProject = () => 'resolver-said-this';
      const { runner, bucket } = makeStub();

      const [record] = await reportErrors(
        events,
        ENABLED,
        register,
        runner,
        CLOCK,
        { stateDir },
        resolveProject,
      );

      expect(record?.project).toBe('stamped-app');
      expect(bucket('create').map((c) => c.args)[0]).toContain('example-org/stamped-app');
    });
  });
});
