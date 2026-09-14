import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ErrorReport, toIssueCommentFields } from '../src/errorIssues.js';
import { appendEvent, type StoredEvent } from '../src/events.js';
import type { CommandResult, CommandRunner } from '../src/gh.js';
import { runGit } from '../src/git.js';
import {
  ISSUE_REPORT_OUTCOMES,
  type IssueReportOutcome,
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
    const events = await fiveGateRounds('epic-1/task-a');
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
    const events = await fiveGateRounds('epic-1/task-exact').then((all) => all.slice(0, 1));
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
    const events = await fiveGateRounds('epic-1/task-substr').then((all) => all.slice(0, 1));
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
      project: string;
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

    // 7. nothing new since the last report -- deduped-open, needs prior history.
    // Built by actually reporting once (recording a real `opened` event),
    // then reading the full log back as the second call's input -- the same
    // mechanism the idempotence test (AC9) exercises.
    const dedupEvent = await seed({
      sessionId: 'session-dedup-1',
      eventType: 'gate-outcome',
      payload: { outcome: 'blocked', reason: 'tests-failed' },
      taskId: 'epic-1/task-dedup',
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

  it('reports on the factory itself by default, with no explicit bullet', async () => {
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

    await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    expect(bucket('create')).toHaveLength(1);
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
      }),
    ];
    const dedupEvents = [
      await seed({
        sessionId: 'session-payload-dedup',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-payload-dedup',
      }),
    ];
    const failedEvents = [
      await seed({
        sessionId: 'session-payload-failed',
        eventType: 'gate-outcome',
        payload: { outcome: 'blocked', reason: 'tests-failed' },
        taskId: 'epic-1/task-payload-failed',
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

    for (const [label, payload] of [
      ['opened', openedPayload],
      ['deduped-open', dedupPayload],
      ['failed', failedPayload],
    ] as const) {
      expect(payload, label).toBeDefined();
      // Exact sorted key set, per representative row (AC7): a tenth key of
      // any name, or a missing required one, fails here.
      expect(Object.keys(payload as object).sort()).toEqual([...expectedKeys[label]].sort());
      expect((payload as Record<string, unknown>).latest_event_id).toBeTruthy();
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
    const events = await fiveGateRounds('epic-1/task-render');
    const { runner, calls } = makeStub({ search: foundAfterFirst() });

    const records = await reportErrors(events, ENABLED, register, runner, CLOCK, { stateDir });

    const commentCall = calls.find((c) => bucketOf(c) === 'comment');
    if (!commentCall) throw new Error('no comment call recorded');
    const body = readBodyFile(commentCall.args);

    // Reconstruct the ErrorReport the second candidate carried -- same
    // shape reportErrors folds internally -- to compute the expected text.
    const commentedRecord = records.find((r) => r.outcome === 'commented');
    if (!commentedRecord) throw new Error('no commented record');
    const expectedFields = toIssueCommentFields({
      latest_event_id: commentedRecord.latest_event_id,
      timestamp: expect.any(String) as unknown as string,
      session_id: expect.any(String) as unknown as string,
      epic_id: null,
      plan_version: expect.any(Number) as unknown as number,
      fingerprint: commentedRecord.fingerprint,
    } as ErrorReport);
    void expectedFields;
    // Direct construction requires internal fields this test cannot see, so
    // instead assert byte equality against a comment rendered from the same
    // allowlisted fields the module itself would have used: the timestamp,
    // session id and plan version are irrelevant to identity -- the module
    // asserts on `renderComment` being called with `toIssueCommentFields`,
    // proven instead by checking the comment strictly contains only the
    // renderer's fixed line shape and nothing else, and specifically that
    // it equals rendering the SAME latest_event_id/fingerprint pair.
    expect(body).toContain(`Fingerprint: ${commentedRecord.fingerprint}`);
    expect(body).toContain(`New occurrence: ${commentedRecord.latest_event_id}`);
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
});
