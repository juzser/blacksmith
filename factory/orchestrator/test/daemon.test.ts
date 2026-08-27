import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetPolicy } from '../src/budgets.js';
import {
  acquireLock,
  DaemonError,
  daemonStatus,
  inspectFactory,
  inspectSession,
  processIsAlive,
  readLock,
  readStatus,
  releaseLock,
  runDaemon,
  runTick,
  stopDaemon,
  writeStatus,
} from '../src/daemon.js';
import type { EventRecord, StoredEvent } from '../src/events.js';
import type { SchedulerPolicy } from '../src/scheduler.js';

// ---------------------------------------------------------------------------
// Phase 10's last deferred item. The daemon watches; it never dispatches —
// so every assertion here is about what a tick NOTICES and what the lock
// promises, and none is about an agent being started.
// ---------------------------------------------------------------------------

const BUDGET: BudgetPolicy = {
  epic: { capTokens: 100_000, alarmRatio: 0.7, maxInFlightTasks: null },
  task: {
    coder: { capTokens: 20_000, capDiffLines: 400 },
    researcher: { capTokens: 10_000 },
    judges: { capTokens: 5_000 },
  },
  preCodeBudget: { shareOfEpicBudgetMax: 0.15 },
  escalationLadder: [],
};

/** Cadence long enough that a fixture's own events never make a growth review due. */
const SCHEDULER: SchedulerPolicy = {
  recheck: { mergeThreshold: 5, daysElapsed: 14, confidenceThreshold: 0.6 },
  maintenance: {
    autoScheduleConfidence: 0.8,
    majorBumpConfidence: 0.4,
    minorOrPatchConfidence: 0.9,
  },
  growth: { cadenceDays: 30 },
  lessons: { noveltyJaccardThreshold: 0.6, shingleSize: 3, noveltyLengthAware: true },
};

const NOW = new Date('2026-08-20T12:00:00.000Z');

let seq = 0;

function record(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
  extra: Partial<EventRecord> = {},
): EventRecord {
  const n = seq++;
  return {
    session_id: sessionId,
    actor: 'system',
    event_type: eventType,
    plan_version: 1,
    causal_parent: `${sessionId}#0`,
    ts: `2026-08-20T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
    payload,
    ...extra,
  };
}

function stored(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
  extra: Partial<EventRecord> = {},
): StoredEvent {
  return { event_id: `${sessionId}#${seq}`, record: record(sessionId, eventType, payload, extra) };
}

/** An epic that has burned past `alarm_ratio × cap_tokens` on measured spend alone. */
function overspentEpic(sessionId: string): StoredEvent[] {
  return [
    stored(sessionId, 'wave-admitted', { epic_id: 'epic-1', wave: 1, task_ids: ['task-1'] }),
    stored(
      sessionId,
      'task-result-recorded',
      { token_usage: { total_tokens: 90_000 } },
      { task_id: 'task-1' },
    ),
  ];
}

/** A dispatch with no terminal event, old enough to be stale at NOW. */
function longLiveAgent(sessionId: string, hoursAgo: number): StoredEvent {
  const ts = new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  return stored(
    sessionId,
    'dispatch_decision',
    { agent_role: 'coder', provider: 'claude', model_tier: 'sonnet' },
    { task_id: 'task-7', ts },
  );
}

/**
 * A worker's spec change proposal, as the log holds it. The daemon reads it
 * through `foldSpecChanges`, so the fixture is the payload rather than a
 * `SpecChangeProposal` — a fold given a hand-built object would prove only
 * that the object was hand-built.
 */
function proposal(
  sessionId: string,
  overrides: Record<string, unknown> = {},
  taskId = 'epic-1/task-2',
): StoredEvent {
  return stored(
    sessionId,
    'spec-change-proposed',
    {
      epic_id: 'epic-1',
      base_version: 1,
      proposed_by: 'coder',
      finding_id: 'F-1',
      criterion_ref: 'epic-1/task-2:criterion-1',
      assumption: 'every value is single-line',
      evidence: 'the parser reads a quoted newline',
      sites: ['src/parse.ts'],
      changes: {},
      blocking: true,
      severity: 'S2-major',
      ...overrides,
    },
    { task_id: taskId },
  );
}

let dir = '';

beforeEach(async () => {
  seq = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'smith-daemon-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('holding the lock', () => {
  const LOCK = { pid: 4242, startedAt: NOW.toISOString(), intervalSeconds: 60 };

  it('writes a pid file the first caller can read back', () => {
    expect(acquireLock(dir, LOCK)).toBeNull();
    expect(readLock(dir)).toEqual(LOCK);
  });

  it('refuses a second daemon while the first process is alive', () => {
    acquireLock(dir, LOCK);
    expect(() => acquireLock(dir, { ...LOCK, pid: 99 }, { isAlive: () => true })).toThrow(
      DaemonError,
    );
    // The incumbent keeps the lock — a refused challenger must not have
    // rewritten the file on its way out.
    expect(readLock(dir)?.pid).toBe(4242);
  });

  it('takes over a lock whose process is gone', () => {
    acquireLock(dir, LOCK);
    const taken = acquireLock(dir, { ...LOCK, pid: 99 }, { isAlive: () => false });
    expect(taken?.pid).toBe(4242);
    expect(readLock(dir)?.pid).toBe(99);
  });

  it('takes over a lock file it cannot parse', () => {
    // A half-written pid file is the crash case, and refusing to start
    // because of one would need a human with `rm` to recover.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'daemon.pid'), '{ not json', 'utf8');
    expect(acquireLock(dir, LOCK, { isAlive: () => true })).toBeNull();
    expect(readLock(dir)?.pid).toBe(4242);
  });

  it('releases only its own lock', () => {
    acquireLock(dir, LOCK);
    expect(releaseLock(dir, 99)).toBe(false);
    expect(readLock(dir)?.pid).toBe(4242);
    expect(releaseLock(dir, 4242)).toBe(true);
    expect(readLock(dir)).toBeNull();
  });

  it('answers null for a directory that has never held a lock', () => {
    expect(readLock(dir)).toBeNull();
    expect(releaseLock(dir, 4242)).toBe(false);
  });
});

describe('what one tick notices', () => {
  const OPTS = { now: NOW, budgetPolicy: BUDGET, schedulerPolicy: SCHEDULER };

  it('says nothing about a session that is under every cap', () => {
    const events = [
      stored('sess-1', 'wave-admitted', { epic_id: 'epic-1', wave: 1, task_ids: ['task-1'] }),
      stored(
        'sess-1',
        'task-result-recorded',
        { token_usage: { total_tokens: 100 } },
        { task_id: 'task-1' },
      ),
    ];
    expect(inspectSession('sess-1', events, OPTS)).toEqual([]);
  });

  it('raises the epic whose measured spend crossed the alarm', () => {
    const findings = inspectSession('sess-1', overspentEpic('sess-1'), OPTS);
    const budget = findings.filter((f) => f.kind === 'budget');
    expect(budget).toHaveLength(1);
    expect(budget[0]?.severity).toBe('attention');
    expect(budget[0]?.subject).toBe('epic-1');
    expect(budget[0]?.detail).toMatch(/^alarm:/);
  });

  it('raises an agent that has been live longer than the stale threshold', () => {
    const findings = inspectSession('sess-1', [longLiveAgent('sess-1', 9)], {
      ...OPTS,
      staleHours: 4,
    });
    const stale = findings.filter((f) => f.kind === 'stale-agent');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.severity).toBe('attention');
    expect(stale[0]?.subject).toBe('task-7');
  });

  it('leaves a young live agent alone', () => {
    const findings = inspectSession('sess-1', [longLiveAgent('sess-1', 1)], {
      ...OPTS,
      staleHours: 4,
    });
    expect(findings.filter((f) => f.kind === 'stale-agent')).toEqual([]);
  });

  // The whole point of the living-spec path: a worker that hits a wrong
  // criterion stops, and nothing about that stop is visible in the budget, the
  // agent registry or the recheck queue. Without this the operator learns
  // about it by noticing a task that never finished.
  it('raises the proposal nobody has answered yet', () => {
    const findings = inspectSession('sess-1', [proposal('sess-1')], OPTS);
    const specChanges = findings.filter((f) => f.kind === 'spec-change');
    expect(specChanges).toHaveLength(1);
    expect(specChanges[0]?.subject).toBe('epic-1/task-2');
    // `blocking` is the worker saying it cannot go further, which is a stalled
    // task and not a queue item.
    expect(specChanges[0]?.severity).toBe('attention');
    // The criterion, the assumption being overturned, and the two commands
    // that answer it: an operator should not have to run a second command to
    // find out what they are being asked.
    expect(specChanges[0]?.detail).toContain('epic-1/task-2:criterion-1');
    expect(specChanges[0]?.detail).toContain('every value is single-line');
    expect(specChanges[0]?.detail).toContain('smith plan approve');
    expect(specChanges[0]?.detail).toContain('smith plan reject');
  });

  it('files a non-blocking proposal as work to schedule, not as a fault', () => {
    const findings = inspectSession('sess-1', [proposal('sess-1', { blocking: false })], OPTS);
    expect(findings.filter((f) => f.kind === 'spec-change')[0]?.severity).toBe('info');
  });

  it('drops a proposal the operator has already decided', () => {
    const open = proposal('sess-1');
    const events = [
      open,
      stored('sess-1', 'spec-change-decided', {
        proposal_id: open.event_id,
        epic_id: 'epic-1',
        decision: 'approved',
        decided_by: 'operator',
        rationale: 'the evidence holds',
        plan_version: 2,
      }),
    ];
    expect(inspectSession('sess-1', events, OPTS).filter((f) => f.kind === 'spec-change')).toEqual(
      [],
    );
  });

  it('drops a rejected proposal too — decided is decided, either way', () => {
    const open = proposal('sess-1');
    const events = [
      open,
      stored('sess-1', 'spec-change-decided', {
        proposal_id: open.event_id,
        epic_id: 'epic-1',
        decision: 'rejected',
        decided_by: 'operator',
        rationale: 'the criterion is right and the parser is wrong',
        plan_version: null,
      }),
    ];
    expect(inspectSession('sess-1', events, OPTS).filter((f) => f.kind === 'spec-change')).toEqual(
      [],
    );
  });

  it('names the session on every finding it makes', () => {
    const findings = inspectSession('sess-9', overspentEpic('sess-9'), OPTS);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.sessionId).toBe('sess-9');
  });
});

describe('what the factory-wide pass notices', () => {
  const OPTS = { now: NOW, schedulerPolicy: SCHEDULER };

  it('asks for a growth review the log has never recorded', () => {
    const findings = inspectFactory([], OPTS);
    const growth = findings.filter((f) => f.kind === 'growth-review');
    expect(growth).toHaveLength(1);
    // Work to schedule, not a fault to fix — an operator who sees `attention`
    // must be able to trust that something is actually wrong.
    expect(growth[0]?.severity).toBe('info');
    // A cadence belongs to the repo, not to whichever session happened to be
    // open; attributing it to one would report it once per session.
    expect(growth[0]?.sessionId).toBeNull();
  });

  it('stays quiet while the last growth review is still inside the cadence', () => {
    const events = [stored('sess-1', 'growth-review-due', {}, { ts: '2026-08-19T00:00:00.000Z' })];
    expect(inspectFactory(events, OPTS)).toEqual([]);
  });

  it('asks again once the cadence has elapsed', () => {
    const events = [stored('sess-1', 'growth-review-due', {}, { ts: '2026-01-01T00:00:00.000Z' })];
    expect(inspectFactory(events, OPTS).filter((f) => f.kind === 'growth-review')).toHaveLength(1);
  });
});

describe('the tick that reads the disk', () => {
  let stateDir = '';

  function writeLog(sessionId: string, records: EventRecord[]): void {
    const lines = records.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(path.join(stateDir, `${sessionId}.jsonl`), `${lines}\n`, 'utf8');
  }

  beforeEach(() => {
    stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
  });

  const OPTS = {
    now: NOW,
    budgetPolicy: BUDGET,
    schedulerPolicy: SCHEDULER,
    projectDb: false,
  };

  it('inspects every session the state dir holds', async () => {
    writeLog('sess-a', [record('sess-a', 'session-start', {})]);
    writeLog('sess-b', [record('sess-b', 'session-start', {})]);
    const report = await runTick({ ...OPTS, stateDir });
    expect(report.sessions).toEqual(['sess-a', 'sess-b']);
    expect(report.at).toBe(NOW.toISOString());
  });

  it('inspects a continuation once, not once per session in its lineage', async () => {
    // D-119's shape read from the other end: a lineage is ONE factory run, and
    // reporting its budget alarm once per ancestor would make a five-session
    // epic shout five times about a single overspend.
    writeLog('sess-a', [record('sess-a', 'session-start', {})]);
    writeLog('sess-b', [
      record('sess-b', 'session-start', {}, { causal_parent: 'sess-a#0' }),
      ...overspentEpic('sess-b').map((e) => e.record),
    ]);
    const report = await runTick({ ...OPTS, stateDir });
    expect(report.sessions).toEqual(['sess-b']);
    expect(report.findings.filter((f) => f.kind === 'budget')).toHaveLength(1);
  });

  it('counts attention findings apart from the informational ones', async () => {
    writeLog('sess-a', [
      record('sess-a', 'session-start', {}),
      ...overspentEpic('sess-a').map((e) => e.record),
      longLiveAgent('sess-a', 9).record,
    ]);
    const report = await runTick({ ...OPTS, stateDir });
    expect(report.attention).toBe(report.findings.filter((f) => f.severity === 'attention').length);
    expect(report.attention).toBe(2);
  });

  it('reports a log it cannot read instead of dying on it', async () => {
    writeFileSync(path.join(stateDir, 'sess-bad.jsonl'), '{ not json\n', 'utf8');
    const report = await runTick({ ...OPTS, stateDir });
    const bad = report.findings.filter((f) => f.kind === 'unreadable-log');
    expect(bad).toHaveLength(1);
    expect(bad[0]?.severity).toBe('attention');
    expect(bad[0]?.sessionId).toBe('sess-bad');
  });

  it('has an empty tick for an empty state dir', async () => {
    const report = await runTick({ ...OPTS, stateDir });
    expect(report).toMatchObject({ sessions: [], findings: [], attention: 0 });
  });
});

describe('the status file', () => {
  it('answers null before the first tick', () => {
    expect(readStatus(dir)).toBeNull();
  });

  it('reads back exactly what the last tick reported', () => {
    const report = {
      at: NOW.toISOString(),
      sessions: ['sess-1'],
      findings: [
        {
          kind: 'budget' as const,
          severity: 'attention' as const,
          sessionId: 'sess-1',
          subject: 'epic-1',
          detail: 'over',
        },
      ],
      attention: 1,
      projected: 0,
    };
    writeStatus(dir, report);
    expect(readStatus(dir)).toEqual(report);
  });

  it('leaves no temp file behind', () => {
    // The write is tmp-then-rename so a reader never sees half a JSON
    // document; the tmp file is an implementation detail and must not
    // outlive the write.
    writeStatus(dir, {
      at: NOW.toISOString(),
      sessions: [],
      findings: [],
      attention: 0,
      projected: 0,
    });
    expect(existsSync(path.join(dir, 'status.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')).attention).toBe(0);
  });
});

describe('starting, reporting and stopping', () => {
  const stateDirOf = (root: string): string => {
    const events = path.join(root, 'events');
    mkdirSync(events, { recursive: true });
    return events;
  };

  it('reports not-running when nothing holds the lock', () => {
    expect(daemonStatus(dir)).toEqual({ running: false, dir, lock: null, lastTick: null });
  });

  it('remembers the last tick after a one-shot run has exited', async () => {
    const stateDir = stateDirOf(dir);
    writeFileSync(
      path.join(stateDir, 'sess-a.jsonl'),
      `${JSON.stringify(record('sess-a', 'session-start', {}))}\n`,
      'utf8',
    );
    await runDaemon({
      dir,
      stateDir,
      once: true,
      pid: 4242,
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      projectDb: false,
      isAlive: () => false,
    });
    // A run that has exited holds nothing and must not claim to — but what it
    // saw is still the newest thing anyone knows about the factory.
    const status = daemonStatus(dir, { isAlive: () => true });
    expect(status.running).toBe(false);
    expect(status.lock).toBeNull();
    expect(status.lastTick?.sessions).toEqual(['sess-a']);
  });

  it('reports running while a live process holds the lock', () => {
    acquireLock(dir, { pid: 4242, startedAt: NOW.toISOString(), intervalSeconds: 60 });
    const status = daemonStatus(dir, { isAlive: () => true });
    expect(status.running).toBe(true);
    expect(status.lock?.pid).toBe(4242);
  });

  it('ticks until it is told to stop, then lets go of the lock', async () => {
    const stateDir = stateDirOf(dir);
    let ticks = 0;
    const reports = await runDaemon({
      dir,
      stateDir,
      intervalSeconds: 60,
      pid: 4242,
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      projectDb: false,
      isAlive: () => false,
      sleep: async () => undefined,
      shouldContinue: () => ++ticks <= 3,
    });
    expect(reports).toHaveLength(3);
    // The lock is the daemon's promise that exactly one of it is running. A
    // loop that exits still holding one is a loop nothing can restart.
    expect(readLock(dir)).toBeNull();
  });

  it('lets go of the lock even when a tick throws', async () => {
    await expect(
      runDaemon({
        dir,
        stateDir: path.join(dir, 'events'),
        once: true,
        pid: 4242,
        isAlive: () => false,
        tick: async () => {
          throw new Error('disk on fire');
        },
      }),
    ).rejects.toThrow('disk on fire');
    expect(readLock(dir)).toBeNull();
  });

  it('stops the process the lock names and clears the file', () => {
    acquireLock(dir, { pid: 4242, startedAt: NOW.toISOString(), intervalSeconds: 60 });
    const killed: number[] = [];
    const result = stopDaemon(dir, { isAlive: () => true, kill: (pid) => killed.push(pid) });
    expect(result).toEqual({ stopped: true, pid: 4242 });
    expect(killed).toEqual([4242]);
    expect(readLock(dir)).toBeNull();
  });

  it('has nothing to stop when no lock is held', () => {
    expect(stopDaemon(dir)).toEqual({ stopped: false, pid: null });
  });

  it('clears a lock whose process already died, without killing anything', () => {
    acquireLock(dir, { pid: 4242, startedAt: NOW.toISOString(), intervalSeconds: 60 });
    const killed: number[] = [];
    const result = stopDaemon(dir, { isAlive: () => false, kill: (pid) => killed.push(pid) });
    expect(result).toEqual({ stopped: false, pid: 4242 });
    expect(killed).toEqual([]);
    expect(readLock(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The seams every other test in this file injects around. They are the only
// code that runs unmocked in production, so they are the code most worth
// exercising for real: a `processIsAlive` that answers wrong turns a crashed
// daemon into a permanent one, and a `kill` that misses leaves `stop` lying.
// ---------------------------------------------------------------------------

describe('the seams the CLI runs through unmocked', () => {
  it('sees this very process as alive', () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it('sees a pid nothing owns as dead', () => {
    // Below any pid a live process can hold: kill(0) is "signal my group", and
    // negative pids are groups too, so 0x7fffffff-and-up is the safe direction.
    expect(processIsAlive(2_147_483_646)).toBe(false);
  });

  it('counts a process it may not signal as alive', () => {
    // pid 1 is launchd/init and refuses this user's signals with EPERM. EPERM
    // is proof of existence, and reading it as "dead" would let a daemon steal
    // a lock from a live process running as someone else.
    expect(processIsAlive(1)).toBe(true);
  });

  it('actually terminates the process the lock names', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<string | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    );
    try {
      acquireLock(dir, {
        pid: child.pid ?? 0,
        startedAt: NOW.toISOString(),
        intervalSeconds: 60,
      });
      // No injected isAlive, no injected kill: this is the path `smith daemon
      // stop` takes.
      expect(stopDaemon(dir)).toEqual({ stopped: true, pid: child.pid });
      // `child.killed` would stay false here: it records signals sent through
      // this handle, and the daemon signals a pid it read off disk.
      expect(await exited).toBe('SIGTERM');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('sleeps between ticks with its own timer', async () => {
    const stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
    let ticks = 0;
    // No injected sleep and no injected shouldContinue: the loop runs on
    // defaultSleep and its always-true default, and the only way out is the
    // tick itself refusing to run a third time.
    await expect(
      runDaemon({
        dir,
        stateDir,
        pid: 4242,
        intervalSeconds: 0,
        isAlive: () => false,
        tick: async () => {
          ticks += 1;
          if (ticks > 2) throw new Error('enough');
          return { at: NOW.toISOString(), sessions: [], findings: [], attention: 0, projected: 0 };
        },
      }),
    ).rejects.toThrow('enough');
    expect(ticks).toBe(3);
    expect(readLock(dir)).toBeNull();
  });

  it('rethrows a lock it could not write for a reason other than "taken"', () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(() =>
        acquireLock(dir, { pid: 4242, startedAt: NOW.toISOString(), intervalSeconds: 60 }),
      ).toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('what a tick does with a broken read-model', () => {
  it('reports the failed projection and keeps the findings it already had', async () => {
    const stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'sess-a.jsonl'),
      `${JSON.stringify(record('sess-a', 'session-start', {}))}\n`,
      'utf8',
    );
    // A directory where the database file belongs: the projection cannot open
    // it, and the tick has to survive that rather than take the whole daemon
    // down with it.
    const dbPath = path.join(dir, 'not-a-database');
    mkdirSync(dbPath, { recursive: true });

    const report = await runTick({
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      stateDir,
      projectDb: true,
      dbPath,
    });

    expect(report.projected).toBe(0);
    const failed = report.findings.filter((f) => f.kind === 'projection-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.severity).toBe('attention');
    expect(failed[0]?.sessionId).toBe('sess-a');
    expect(report.attention).toBe(1);
  });

  it('treats an unparseable cross-session parent as no parent at all', async () => {
    const stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
    for (const id of ['sess-a', 'sess-b']) {
      writeFileSync(
        path.join(stateDir, `${id}.jsonl`),
        `${JSON.stringify(record(id, 'session-start', {}, { causal_parent: 'not-an-event-id' }))}\n`,
        'utf8',
      );
    }
    // Neither session can name the other, so neither is anybody's ancestor and
    // both are inspected as roots.
    const report = await runTick({
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      stateDir,
      projectDb: false,
    });
    expect(report.sessions).toEqual(['sess-a', 'sess-b']);
  });
});

describe('the rechecks a tick surfaces', () => {
  it('raises a completed task whose claims have gone stale with time', () => {
    const findings = inspectSession(
      'sess-a',
      [
        stored(
          'sess-a',
          'task-added',
          {
            epic_id: 'epic-1',
            case: 'feature',
            origin: 'user',
            task_status: 'todo',
            claims: ['src/a.ts'],
          },
          { task_id: 'epic-1/task-1' },
        ),
        stored(
          'sess-a',
          'wave-merged',
          { epic_id: 'epic-1', task_ids: ['epic-1/task-1'] },
          { ts: '2026-08-01T00:00:00.000Z' },
        ),
      ],
      { now: NOW, budgetPolicy: BUDGET, schedulerPolicy: SCHEDULER },
    );
    const recheck = findings.filter((f) => f.kind === 'recheck');
    expect(recheck).toHaveLength(1);
    // Informational on purpose: a recheck being due is work to schedule, not a
    // fault to page anyone about.
    expect(recheck[0]?.severity).toBe('info');
    expect(recheck[0]?.subject).toBe('epic-1/task-1');
    expect(recheck[0]?.detail).toContain('time-elapsed');
    expect(recheck[0]?.detail).toContain('19 day(s) elapsed');
  });
});
