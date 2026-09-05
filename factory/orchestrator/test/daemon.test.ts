import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetPolicy } from '../src/budgets.js';
import type { AdmissionLens, DaemonFinding } from '../src/daemon.js';
import {
  acquireLock,
  DaemonError,
  daemonStatus,
  inspectFactory,
  inspectSession,
  processIsAlive,
  readFindingMemory,
  readLock,
  readStatus,
  releaseLock,
  runDaemon,
  runTick,
  stopDaemon,
  writeFindingMemory,
  writeStatus,
} from '../src/daemon.js';
import { openDb } from '../src/db/projector.js';
import { roadmapPage } from '../src/db/queries.js';
import type { EventRecord, StoredEvent } from '../src/events.js';
import { findingIdentity } from '../src/findingAge.js';
import { REPO_ROOT } from '../src/paths.js';
import { factoryProjects, resolveProjectDirs } from '../src/projects.js';
import { FACTORY_PROJECT } from '../src/roadmap.js';
import type { OutdatedPackage, SchedulerPolicy } from '../src/scheduler.js';

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
  // Off, and every fixture below is dated against that. The daemon DOES read
  // this block now -- `runTick` reports who may admit each finding -- so a
  // fixture that left it out would be a fixture that read the operator's real
  // scheduler.yml and changed verdict the day somebody edited it. Shut is also
  // what makes the crosscheck.yml read `runTick` still does for security
  // keywords inert here: `autonomy-disabled` is decided ahead of the keyword
  // match, so no fixture's answer depends on that file's contents. The tests
  // that care about admission pass their own lens instead.
  autonomy: {
    enabled: false,
    autoDispatchKinds: [],
    autoDispatchRecheckReasons: [],
    confidenceFloor: 0.8,
  },
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

  // A log with records in it and no growth review among them. Deliberately not
  // an empty log: "never recorded" is a fact about a factory that has done
  // something, while an empty log means nothing has ever happened here, and a
  // cadence reminder about work that has never started is noise a fresh clone
  // does not need.
  it('asks for a growth review the log has never recorded', () => {
    const findings = inspectFactory([stored('sess-1', 'session-start', {})], OPTS);
    const growth = findings.filter((f) => f.kind === 'growth-review');
    expect(growth).toHaveLength(1);
    // Work to schedule, not a fault to fix — an operator who sees `attention`
    // must be able to trust that something is actually wrong.
    expect(growth[0]?.severity).toBe('info');
    // A cadence belongs to the repo, not to whichever session happened to be
    // open; attributing it to one would report it once per session.
    expect(growth[0]?.sessionId).toBeNull();
  });

  // The other side of the same rule, and the reason the daemon no longer has to
  // suppress this whole pass to get it: a cadence is a claim about elapsed time
  // and an empty log gives it nothing to elapse from.
  it('asks for none at all when the log is empty', () => {
    expect(inspectFactory([], OPTS).filter((f) => f.kind === 'growth-review')).toEqual([]);
  });

  it('stays quiet while the last growth review is still inside the cadence', () => {
    const events = [stored('sess-1', 'growth-review-due', {}, { ts: '2026-08-19T00:00:00.000Z' })];
    expect(inspectFactory(events, OPTS)).toEqual([]);
  });

  it('asks again once the cadence has elapsed', () => {
    const events = [stored('sess-1', 'growth-review-due', {}, { ts: '2026-01-01T00:00:00.000Z' })];
    expect(inspectFactory(events, OPTS).filter((f) => f.kind === 'growth-review')).toHaveLength(1);
  });

  // ------------------------------------------------------------------------
  // The factory's own width. `smith epic width` answers this on demand over
  // all of history; the daemon asks it of the newest close only, and the
  // three tests after the first are all about that difference.
  // ------------------------------------------------------------------------

  const COUNTS = { parallel: 0, partial: 0, serialized: 0, single: 0, unobserved: 0 };

  /** An `epic-closed` carrying the concurrency block `epic close` writes. */
  function closed(
    epicId: string,
    at: string,
    concurrency: unknown,
    sessionId = 'sess-1',
  ): StoredEvent {
    return stored(
      sessionId,
      'epic-closed',
      {
        epic_id: epicId,
        closed_by: 'verdict',
        machine_verdict: 'ready',
        summary: { concurrency },
      },
      { ts: at },
    );
  }

  const ran = (verdict: 'parallel' | 'serialized', declared: number, observed: number) => ({
    waves: 1,
    verdicts: { ...COUNTS, [verdict]: 1 },
    widest: { declared, observed },
    unobserved: [],
    problem: null,
  });

  it('says nothing about width in a factory that has closed no epics', () => {
    const events = [stored('sess-1', 'growth-review-due', {}, { ts: '2026-08-19T00:00:00.000Z' })];
    expect(inspectFactory(events, OPTS).filter((f) => f.kind === 'factory-width')).toEqual([]);
  });

  it('raises attention when the epic this factory closed last ran narrow', () => {
    const events = [closed('epic-1', '2026-08-19T00:00:00.000Z', ran('serialized', 4, 1))];
    const width = inspectFactory(events, OPTS).filter((f) => f.kind === 'factory-width');

    expect(width).toHaveLength(1);
    // The one finding here that is a fault rather than work to schedule: a
    // wave was admitted wide and then dispatched one task at a time, which is
    // the repo's central claim not being met.
    expect(width[0]?.severity).toBe('attention');
    expect(width[0]?.subject).toBe('epic-1');
    // A close is written wherever the epic finished; the fact is about the
    // workshop, so attributing it to that session would report it as one
    // session's problem and repeat it per session.
    expect(width[0]?.sessionId).toBeNull();
    expect(width[0]?.detail).toContain('4');
  });

  it('goes quiet again once a later epic closes wide, with the narrow one still in the log', () => {
    // The load-bearing one. Closes are immutable and `smith epic width` folds
    // all of them, so a daemon reporting that fold would raise the same
    // attention every tick forever over an epic nobody can go back and fix —
    // and an attention count that can never reach zero teaches an operator to
    // stop reading it.
    const events = [
      closed('epic-1', '2026-08-18T00:00:00.000Z', ran('serialized', 4, 1)),
      closed('epic-2', '2026-08-19T00:00:00.000Z', ran('parallel', 3, 3)),
    ];
    expect(inspectFactory(events, OPTS).filter((f) => f.kind === 'factory-width')).toEqual([]);
  });

  it('still raises the newest close when an older one ran wide', () => {
    // The same rule in the other direction: recency is the rule, not "any
    // parallel epic anywhere clears the factory".
    const events = [
      closed('epic-1', '2026-08-18T00:00:00.000Z', ran('parallel', 3, 3)),
      closed('epic-2', '2026-08-19T00:00:00.000Z', ran('serialized', 4, 1)),
    ];
    const width = inspectFactory(events, OPTS).filter((f) => f.kind === 'factory-width');
    expect(width).toHaveLength(1);
    expect(width[0]?.subject).toBe('epic-2');
  });

  it('files a factory that has closed epics but never measured one as work to schedule', () => {
    // Not `attention`: nothing is known to be wrong. What is wrong is that
    // nothing is known — which is a different thing, and the reason
    // summariseEpicWidth refuses to let an unmeasured factory exit 0.
    const events = [closed('epic-1', '2026-08-19T00:00:00.000Z', undefined)];
    const width = inspectFactory(events, OPTS).filter((f) => f.kind === 'factory-width');

    expect(width).toHaveLength(1);
    expect(width[0]?.severity).toBe('info');
    expect(width[0]?.sessionId).toBeNull();
    expect(width[0]?.detail).toContain('smith epic close');
  });

  it('does not call a factory unmeasured while one close still carries a width', () => {
    const events = [
      closed('epic-1', '2026-08-18T00:00:00.000Z', ran('parallel', 3, 3)),
      closed('epic-2', '2026-08-19T00:00:00.000Z', undefined),
    ];
    expect(inspectFactory(events, OPTS).filter((f) => f.kind === 'factory-width')).toEqual([]);
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
          firstSeen: NOW.toISOString(),
          isNew: true,
        },
      ],
      attention: 1,
      newAttention: 1,
      autoAdmitted: 0,
      operatorHeld: 0,
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
      newAttention: 0,
      autoAdmitted: 0,
      operatorHeld: 0,
      projected: 0,
    });
    expect(existsSync(path.join(dir, 'status.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')).attention).toBe(0);
  });
});

describe('how long a finding has been standing', () => {
  // The watcher recomputes everything from the log every tick and overwrites
  // the last report, so without a memory it can say what is wrong and never
  // how long. These are about the one file that survives a tick.
  const OPTS = { now: NOW, budgetPolicy: BUDGET, schedulerPolicy: SCHEDULER, projectDb: false };

  const stateDir = (): string => {
    const events = path.join(dir, 'events');
    mkdirSync(events, { recursive: true });
    return events;
  };

  /** A log that cannot be parsed — the cheapest way to make a tick find something. */
  const brokenLog = (): string => {
    const events = stateDir();
    writeFileSync(path.join(events, 'sess-bad.jsonl'), '{ not json\n', 'utf8');
    return events;
  };

  it('dates every finding to now on the first tick, and counts them all as new', async () => {
    const report = await runTick({ ...OPTS, stateDir: brokenLog() });
    const bad = report.findings.filter((f) => f.kind === 'unreadable-log');

    expect(bad).toHaveLength(1);
    expect(bad[0]?.firstSeen).toBe(NOW.toISOString());
    expect(bad[0]?.isNew).toBe(true);
    // On a first tick the two counts agree by definition. They stop agreeing
    // the moment anything survives a tick, which is the point of having both:
    // `attention` is the number worth looking at, `newAttention` the number
    // worth waking someone for.
    expect(report.newAttention).toBe(report.attention);
  });

  it('keeps the original date for a finding that was already standing', async () => {
    const events = brokenLog();
    const first = await runTick({ ...OPTS, stateDir: events });
    const memory = {
      [findingIdentity(first.findings[0] as (typeof first.findings)[number])]:
        '2026-08-01T00:00:00.000Z',
    };

    const second = await runTick({ ...OPTS, stateDir: events, memory });
    expect(second.findings[0]?.firstSeen).toBe('2026-08-01T00:00:00.000Z');
    expect(second.findings[0]?.isNew).toBe(false);
    // Still worth looking at, no longer worth waking for.
    expect(second.attention).toBe(1);
    expect(second.newAttention).toBe(0);
  });

  it('reads an absent memory as an empty one', () => {
    // The first tick a daemon ever runs has no file to read, and that is not
    // an error condition.
    expect(readFindingMemory(dir)).toEqual({});
  });

  it('reads a corrupt memory as an empty one rather than failing the tick', () => {
    // Same doctrine as `unreadable-log`: a watchdog that dies on a bad file is
    // silent exactly when something is wrong. This file is disposable — losing
    // it costs one tick of ages and nothing else — so it must never be able to
    // stop a tick that would otherwise report a real problem.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'findings.json'), '{ not json', 'utf8');
    expect(readFindingMemory(dir)).toEqual({});
  });

  it('round-trips a memory through the disk', () => {
    const memory = { '["budget","sess-1","epic-1"]': '2026-08-01T00:00:00.000Z' };
    writeFindingMemory(dir, memory);
    expect(readFindingMemory(dir)).toEqual(memory);
    expect(existsSync(path.join(dir, 'findings.json.tmp'))).toBe(false);
  });

  it('carries the memory from one tick of the loop to the next', async () => {
    // The loop is what makes the memory real: runTick is handed a memory and
    // returns dated findings, and nothing else joins the two across an
    // interval.
    const events = brokenLog();
    const reports = await runDaemon({
      dir,
      stateDir: events,
      intervalSeconds: 0,
      pid: 4242,
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      projectDb: false,
      isAlive: () => false,
      sleep: async () => undefined,
      shouldContinue: (() => {
        let ticks = 0;
        return () => ++ticks <= 2;
      })(),
    });

    expect(reports).toHaveLength(2);
    expect(reports[0]?.findings[0]?.isNew).toBe(true);
    expect(reports[1]?.findings[0]?.isNew).toBe(false);
    expect(reports[1]?.findings[0]?.firstSeen).toBe(reports[0]?.findings[0]?.firstSeen);
    expect(reports[1]?.newAttention).toBe(0);
  });

  it('forgets a finding that has cleared, so its return reads as new', async () => {
    const events = brokenLog();
    const first = await runTick({ ...OPTS, stateDir: events });
    writeFindingMemory(dir, {});

    const back = await runTick({ ...OPTS, stateDir: events, memory: readFindingMemory(dir) });
    expect(first.findings[0]?.isNew).toBe(true);
    expect(back.findings[0]?.isNew).toBe(true);
  });
});

describe('starting, reporting and stopping', () => {
  const stateDirOf = (root: string): string => {
    const events = path.join(root, 'events');
    mkdirSync(events, { recursive: true });
    return events;
  };

  it('reports not-running when nothing holds the lock', () => {
    expect(daemonStatus(dir)).toEqual({
      running: false,
      stale: false,
      dir,
      lock: null,
      lastTick: null,
      reportAgeSeconds: null,
    });
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
          return {
            at: NOW.toISOString(),
            sessions: [],
            findings: [],
            attention: 0,
            newAttention: 0,
            autoAdmitted: 0,
            operatorHeld: 0,
            projected: 0,
          };
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

describe('who has to say yes to a finding', () => {
  // The watcher already says what is due. Until it also says who may admit it,
  // a recheck that a `/bs report` wave will clear on its own and a growth
  // review that is structurally the operator's read as the same grey line —
  // and the operator's own answer to "what can run without me?" (scheduler.yml
  // `autonomy:`) is visible only to somebody who types `smith scheduler admit`
  // per session. These are about carrying that answer into the unattended
  // surface, and about it staying a REPORT: nothing here dispatches.

  /** A completed task old enough for the recheck policy to want another look. */
  const rechecked = (claims: string[]): StoredEvent[] => [
    stored(
      'sess-a',
      'task-added',
      {
        epic_id: 'epic-1',
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
        claims,
      },
      { task_id: 'epic-1/task-1' },
    ),
    stored(
      'sess-a',
      'wave-merged',
      { epic_id: 'epic-1', task_ids: ['epic-1/task-1'] },
      { ts: '2026-08-01T00:00:00.000Z' },
    ),
  ];

  /** Autonomy as an operator who has opted in would write it. */
  const OPEN: AdmissionLens = {
    autonomy: {
      enabled: true,
      autoDispatchKinds: ['recheck', 'maintenance', 'growth-review-due'],
      autoDispatchRecheckReasons: ['merge-threshold', 'time-elapsed', 'low-confidence'],
      confidenceFloor: 0.8,
    },
    securityKeywords: ['auth', 'secret'],
  };

  const SHUT: AdmissionLens = {
    autonomy: { ...OPEN.autonomy, enabled: false },
    securityKeywords: OPEN.securityKeywords,
  };

  const opts = (admission: AdmissionLens) => ({
    now: NOW,
    budgetPolicy: BUDGET,
    schedulerPolicy: SCHEDULER,
    admission,
  });

  it('says nothing about admission when nobody asked', () => {
    // Absent has to read as "not consulted", never as "anything may run": the
    // one direction a missing policy must not silently move a finding is
    // towards auto.
    const findings = inspectSession('sess-a', rechecked(['src/a.ts']), {
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
    });
    const recheck = findings.find((f) => f.kind === 'recheck');
    expect(recheck).toBeDefined();
    expect(recheck?.admission).toBeUndefined();
  });

  it('admits a recheck whose every reason the operator whitelisted', () => {
    const findings = inspectSession('sess-a', rechecked(['src/a.ts']), opts(OPEN));
    const recheck = findings.find((f) => f.kind === 'recheck');
    expect(recheck?.admission?.decision).toBe('auto');
    expect(recheck?.admission?.code).toBe('admitted');
  });

  it('holds the same recheck when autonomy is switched off', () => {
    const findings = inspectSession('sess-a', rechecked(['src/a.ts']), opts(SHUT));
    const recheck = findings.find((f) => f.kind === 'recheck');
    expect(recheck?.admission?.decision).toBe('operator');
    expect(recheck?.admission?.code).toBe('autonomy-disabled');
  });

  it('holds a recheck of a security path even with every reason whitelisted', () => {
    // The claims come from the log through the same fold the CLI uses. Without
    // them a RecheckProposal names an opaque task id, and the watcher would
    // report `auto` for a proposal `smith scheduler admit` holds — a watcher
    // that contradicts the gate is worse than one that says nothing.
    const findings = inspectSession('sess-a', rechecked(['src/auth/session.ts']), opts(OPEN));
    const recheck = findings.find((f) => f.kind === 'recheck');
    expect(recheck?.admission?.decision).toBe('operator');
    expect(recheck?.admission?.code).toBe('security-surface');
    expect(recheck?.admission?.reason).toContain('src/auth/session.ts');
  });

  it('holds a growth review even when the kind is whitelisted', () => {
    const growth = inspectFactory([stored('sess-1', 'session-start', {})], {
      now: NOW,
      schedulerPolicy: SCHEDULER,
      admission: OPEN,
    });
    const finding = growth.find((f) => f.kind === 'growth-review');
    expect(finding?.admission?.decision).toBe('operator');
    expect(finding?.admission?.code).toBe('growth-never-auto');
  });

  it('leaves a finding no proposal stands behind unadmitted', () => {
    // A blown budget is a condition, not work anything may schedule. Giving it
    // an admission would invite an alert rule to read `operator` as "waiting on
    // a wave" rather than "the cap is gone".
    const narrowClose = stored(
      'sess-1',
      'epic-closed',
      {
        epic_id: 'epic-1',
        closed_by: 'verdict',
        machine_verdict: 'ready',
        summary: {
          concurrency: {
            waves: 1,
            verdicts: { parallel: 0, partial: 0, serialized: 1, single: 0, unobserved: 0 },
            widest: { declared: 4, observed: 1 },
            unobserved: [],
            problem: null,
          },
        },
      },
      { ts: '2026-08-19T00:00:00.000Z' },
    );
    const findings = inspectFactory([narrowClose], {
      now: NOW,
      schedulerPolicy: SCHEDULER,
      admission: OPEN,
    });
    const width = findings.find((f) => f.kind === 'factory-width');
    expect(width).toBeDefined();
    expect(width?.admission).toBeUndefined();
  });

  it('does not restart a finding clock when only its admission moves', () => {
    // Identity is kind, session and subject. An operator who edits
    // scheduler.yml changes who may say yes; the thing standing is the same
    // thing, and a six-day-old recheck must not read as new because of it.
    const open = inspectSession('sess-a', rechecked(['src/a.ts']), opts(OPEN));
    const shut = inspectSession('sess-a', rechecked(['src/a.ts']), opts(SHUT));
    const a = open.find((f) => f.kind === 'recheck');
    const b = shut.find((f) => f.kind === 'recheck');
    expect(a?.admission?.decision).not.toBe(b?.admission?.decision);
    expect(findingIdentity(a as never)).toBe(findingIdentity(b as never));
  });

  it('counts a tick in the two halves an operator triages on', async () => {
    const events = path.join(dir, 'events');
    mkdirSync(events, { recursive: true });
    writeFileSync(
      path.join(events, 'sess-a.jsonl'),
      `${rechecked(['src/a.ts'])
        .map((e) => JSON.stringify(e.record))
        .join('\n')}\n`,
      'utf8',
    );

    const report = await runTick({
      stateDir: events,
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      admission: OPEN,
      projectDb: false,
    });

    // One recheck admitted; the growth review the empty cadence makes due is
    // held. The two counts are the whole point: how much of this list drains
    // itself, and how much is actually mine.
    expect(report.autoAdmitted).toBe(1);
    expect(report.operatorHeld).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `running` has always meant "a process holds the lock", which is not the same
// claim as "something is watching". A daemon wedged mid-tick still holds its
// lock and still answers to `kill -0`, so the health check ops.md documents --
// `smith daemon status >/dev/null` -- passed for a watcher that had published
// nothing since Tuesday. These are about the gap between holding the lock and
// doing the job, and about a reader of `status.json` being told how old the
// answer it just read actually is.
// ---------------------------------------------------------------------------

describe('whether the watcher is actually watching', () => {
  const at = (secondsAgo: number): Date => new Date(NOW.getTime() - secondsAgo * 1000);

  /** A lock held by a live process, started `secondsAgo` before NOW. */
  function holding(secondsAgo: number, intervalSeconds = 300): void {
    acquireLock(dir, { pid: 4242, startedAt: at(secondsAgo).toISOString(), intervalSeconds });
  }

  /** A published tick dated `secondsAgo` before NOW. */
  function published(secondsAgo: number): void {
    writeStatus(dir, {
      at: at(secondsAgo).toISOString(),
      sessions: [],
      findings: [],
      attention: 0,
      newAttention: 0,
      autoAdmitted: 0,
      operatorHeld: 0,
      projected: 0,
    });
  }

  const status = (): ReturnType<typeof daemonStatus> =>
    daemonStatus(dir, { isAlive: () => true, now: NOW });

  it('says how old the last tick is, in the units an operator asks in', () => {
    published(90);
    expect(status().reportAgeSeconds).toBe(90);
  });

  it('reports no age at all when nothing has ever ticked', () => {
    holding(5);
    // Not zero. Zero is a real age and would read as "it just ticked" -- the
    // one thing a daemon that has never published must not be able to claim.
    expect(status().reportAgeSeconds).toBeNull();
  });

  it('calls a daemon healthy while its ticks are arriving', () => {
    holding(3600);
    published(120);
    const s = status();
    expect(s.running).toBe(true);
    expect(s.stale).toBe(false);
  });

  it('calls a daemon stale once it has missed two whole intervals', () => {
    holding(3600, 300);
    // 3 intervals is 900s; one tick late is a slow fold, two missed is a fault.
    published(901);
    expect(status().stale).toBe(true);
  });

  it('dates a daemon that has not ticked yet from when it started', () => {
    // No status file at all. A daemon three seconds old has not failed to
    // publish -- it has not been asked to yet, and calling that stale would
    // make every `daemon start` alarm on its own first second.
    holding(3);
    const s = status();
    expect(s.lastTick).toBeNull();
    expect(s.stale).toBe(false);
  });

  it('calls a daemon stale when it started long ago and never published', () => {
    // The wedged-on-the-first-tick case, and the one a status file cannot show
    // precisely because the wedge is what stopped the file existing.
    holding(4000, 300);
    expect(status().stale).toBe(true);
  });

  it('does not call a stopped daemon stale, but still dates its report', () => {
    // `running: false` is the sharper statement, and a `stale` that also meant
    // "nobody is home" would be a flag with two readings. The age stays, since
    // a reader of the report still has to know how much to trust it.
    published(99_999);
    const s = daemonStatus(dir, { isAlive: () => false, now: NOW });
    expect(s.running).toBe(false);
    expect(s.stale).toBe(false);
    expect(s.reportAgeSeconds).toBe(99_999);
  });

  it('gives a sub-minute interval a floor before calling it stale', () => {
    // A tick's cost is not proportional to the interval -- folding the log
    // takes what it takes -- so `--interval 1` would otherwise report a daemon
    // as wedged for doing exactly the work it was configured to do too often.
    holding(600, 1);
    published(45);
    expect(status().stale).toBe(false);
  });

  it('falls back to the default interval when the lock does not name one', () => {
    // D-21: a report that only states a fact must not crash over that fact. A
    // hand-edited pid file is a bad lock, not a reason to have no status.
    writeFileSync(
      path.join(dir, 'daemon.pid'),
      `${JSON.stringify({ pid: 4242, startedAt: at(3600).toISOString() })}\n`,
      'utf8',
    );
    published(2000);
    const s = status();
    expect(s.running).toBe(true);
    expect(s.stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One factory, many repos. `maintenance` is the only finding kind that is
// about a directory rather than about the log, so it is the only one a single
// tick can ask twice -- and therefore the only one whose subject has to carry
// which repo the answer came from.
// ---------------------------------------------------------------------------

describe('the maintenance pass across several repos', () => {
  const BEHIND: Record<string, OutdatedPackage[]> = {
    [path.resolve('/repo/self')]: [
      { name: 'lodash', current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
    ],
    [path.resolve('/repo/child')]: [
      { name: 'zod', current: '3.0.0', wanted: '3.0.1', latest: '3.0.1' },
    ],
  };
  const OPTS = {
    now: NOW,
    schedulerPolicy: SCHEDULER,
    projectDirs: ['/repo/self', '/repo/child'],
    readOutdated: (dir: string): OutdatedPackage[] | null => BEHIND[dir] ?? null,
  };

  it('reports one finding per repo, each naming the repo it is about', () => {
    const maintenance = inspectFactory([], OPTS).filter((f) => f.kind === 'maintenance');
    expect(maintenance).toHaveLength(2);
    expect(maintenance[0]?.subject).toContain(path.resolve('/repo/self'));
    expect(maintenance[1]?.subject).toContain(path.resolve('/repo/child'));
  });

  // The collision this pins: `findingIdentity` is [kind, sessionId, subject]
  // and every maintenance finding carries a null sessionId, so two repos one
  // package behind used to share the subject "1 package(s)" -- one entry in
  // the tick-to-tick memory for two repos, and whichever was written second
  // inherited the other's firstSeen.
  it('gives two repos that are equally behind two different identities', () => {
    const identities = inspectFactory([], OPTS)
      .filter((f) => f.kind === 'maintenance')
      .map(findingIdentity);
    expect(new Set(identities).size).toBe(2);
  });

  // findingAge.ts argues the count belongs in the subject: a repo falling
  // further behind is news, and absorbing it into a six-day-old timestamp
  // hides the thing that just happened. Naming the repo must not cost that.
  it('still reads as a new finding when the same repo falls further behind', () => {
    const before = inspectFactory([], OPTS).filter((f) => f.kind === 'maintenance')[0];
    const after = inspectFactory([], {
      ...OPTS,
      readOutdated: (): OutdatedPackage[] => [
        { name: 'lodash', current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
        { name: 'vite', current: '5.0.0', wanted: '5.0.0', latest: '5.0.1' },
      ],
    }).filter((f) => f.kind === 'maintenance')[0];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(findingIdentity(before as DaemonFinding)).not.toBe(
      findingIdentity(after as DaemonFinding),
    );
  });

  it('runs no maintenance pass at all when no repo was named', () => {
    const findings = inspectFactory([], { now: NOW, schedulerPolicy: SCHEDULER });
    expect(findings.filter((f) => f.kind === 'maintenance')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The claim the mandate makes -- this factory maintains itself AND the
// projects it built -- checked instead of asserted. `--project` can name every
// repo since the maintenance pass went plural; nothing until now noticed an
// operator who named fewer than all of them, and silence is the whole failure
// mode.
// ---------------------------------------------------------------------------
describe('the repos nothing is watching', () => {
  const REFS = [
    { name: 'black-smith', dir: '/repo/self', self: true },
    { name: 'envkit', dir: '/repo/envkit', self: false },
  ];
  const OPTS = { now: NOW, schedulerPolicy: SCHEDULER, readProjects: () => REFS };
  const unwatched = (opts: Partial<typeof OPTS> & Record<string, unknown> = {}): DaemonFinding[] =>
    inspectFactory([], { ...OPTS, ...opts }).filter((f) => f.kind === 'unwatched-project');

  it('names every responsible repo when no --project was given at all', () => {
    expect(unwatched().map((f) => f.subject)).toEqual(['/repo/self', '/repo/envkit']);
  });

  // AC1: the null measured, not assumed. `factoryProjects()` has always
  // returned this clone unconditionally as `self: true`, so an
  // `unwatched-project` finding for it carries no information the process
  // lacks -- restating a known fact is what ops.md argues trains an operator
  // to stop reading. `cli.ts`'s three call sites are what were fixed, by
  // feeding the fold `resolveProjectDirs()`'s answer instead of the flag as
  // typed; this asserts the fold itself draws the line the fix moved.
  it('an omitted --project used to leave this clone unwatched; the union feeds it none now', () => {
    const self = { name: FACTORY_PROJECT, dir: REPO_ROOT, self: true };
    const opts = { now: NOW, schedulerPolicy: SCHEDULER, readProjects: () => [self] };
    // The null: nothing was named, and nothing joined the pass for it either
    // -- exactly what an omitted `--project` used to fold to.
    expect(
      inspectFactory([], { ...opts, projectDirs: [] }).filter(
        (f) => f.kind === 'unwatched-project',
      ),
    ).toEqual([expect.objectContaining({ kind: 'unwatched-project', subject: REPO_ROOT })]);
    // The fix: cli.ts now feeds `resolveProjectDirs(undefined)`'s answer,
    // which puts REPO_ROOT in the pass by default.
    expect(
      inspectFactory([], { ...opts, projectDirs: resolveProjectDirs(undefined) }).filter(
        (f) => f.kind === 'unwatched-project',
      ),
    ).toEqual([]);
  });

  // Clearable in one flag, which is the test `factory-width` sets for any new
  // attention: an alarm that cannot return to zero teaches an operator to stop
  // reading the number, and takes the real alarms with it.
  it('drops a repo the moment the pass is pointed at it', () => {
    expect(unwatched({ projectDirs: ['/repo/self'] }).map((f) => f.subject)).toEqual([
      '/repo/envkit',
    ]);
  });

  it('says nothing once every repo is named', () => {
    expect(unwatched({ projectDirs: ['/repo/self', '/repo/envkit'] })).toEqual([]);
  });

  it('is attention, and about the repo rather than any session', () => {
    const first = unwatched()[0];
    expect(first?.severity).toBe('attention');
    expect(first?.sessionId).toBeNull();
  });

  // The subject is the resolved directory because it is both the only field
  // that can separate two repos -- sessionId is null, as it is for maintenance
  // -- and the exact string the operator has to paste to clear the finding.
  it('gives two unwatched repos two identities', () => {
    expect(new Set(unwatched().map(findingIdentity)).size).toBe(2);
  });

  it('says which flag clears it, and which project it is about', () => {
    const child = unwatched().find((f) => f.subject === '/repo/envkit');
    expect(child?.detail).toContain('envkit');
    expect(child?.detail).toContain('--project /repo/envkit');
  });

  // No register, no claim. inspectFactory reads policy files and the repos it
  // was handed; it does not go looking for a roadmap nobody asked it to read,
  // so a caller that supplies no reader gets the silence it had before.
  it('raises nothing when no register was supplied', () => {
    const findings = inspectFactory([], { now: NOW, schedulerPolicy: SCHEDULER });
    expect(findings.filter((f) => f.kind === 'unwatched-project')).toEqual([]);
  });

  // D-21: a watcher that dies over the fact it reports is silent exactly when
  // somebody is mid-edit in roadmap.md. factoryProjects already refuses to
  // throw; this pins that inspectFactory does not reintroduce the crash.
  it('survives a register that throws', () => {
    const findings = inspectFactory([], {
      now: NOW,
      schedulerPolicy: SCHEDULER,
      readProjects: () => {
        throw new Error('roadmap.md is half-written');
      },
    });
    expect(findings.filter((f) => f.kind === 'unwatched-project')).toEqual([]);
  });

  // AC3's gate: `--no-self` has to be read at the read layer, not only the
  // report layer, or an implementation could suppress the finding while
  // still opening this clone's lockfile. `readOutdated` is the one place
  // that would happen -- it is called once per `opts.projectDirs` entry --
  // so this asserts REPO_ROOT never reaches it once `resolveProjectDirs`
  // excluded it.
  it('--no-self keeps REPO_ROOT out of the directories the tick reads, not just the report', () => {
    // Simulates cli.ts's daemon-run site under `--no-self`: this clone drops
    // out of BOTH `projectDirs` and the register `readProjects` answers, the
    // same way the CLI's `self` guard filters `factoryProjects()`.
    const readDirs: string[] = [];
    const findings = inspectFactory([], {
      now: NOW,
      schedulerPolicy: SCHEDULER,
      readProjects: () => [],
      projectDirs: resolveProjectDirs(undefined, { self: false }),
      readOutdated: (dir) => {
        readDirs.push(dir);
        return null;
      },
    });
    expect(findings.filter((f) => f.kind === 'unwatched-project')).toEqual([]);
    expect(readDirs).not.toContain(REPO_ROOT);
  });

  // AC4: the daemon's rule (projects.ts's header) stays intact -- a
  // regression guard, not a differential, since the null was already true
  // and stays true. A fixture roadmap (never the shipped one, per
  // test/projects.test.ts) declares a project with no checkout under either
  // root; the real `factoryProjects()` -- not a mock -- already drops it, so
  // the same fold and the same options raise nothing about it, same as
  // before this task's change to projects.ts.
  it('raises nothing for a declared project with no checkout, same fold, same options', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'smith-daemon-missing-'));
    try {
      const roadmapPath = path.join(scratch, 'roadmap.md');
      const root = path.join(scratch, 'roots');
      mkdirSync(root);
      writeFileSync(
        roadmapPath,
        '# Roadmap\n\n## envkit-bootstrap\n- id: envkit-bootstrap\n' +
          '- status: completed\n- project: envkit\n- epics: []\n- goal: whatever.\n',
      );
      const refs = factoryProjects({ roadmapPath, roots: [root] });
      const findings = inspectFactory([], {
        now: NOW,
        schedulerPolicy: SCHEDULER,
        readProjects: () => refs,
        projectDirs: resolveProjectDirs(undefined),
      });
      expect(findings.filter((f) => f.kind === 'unwatched-project')).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// The register has to survive every hop between the flag and the fold --
// cli.ts -> runDaemon -> runTick -> inspectFactory -- and a dropped spread at
// any one of them is silent: the tick simply reports nothing, which is exactly
// what the finding exists to stop.
describe('a tick carries the register down to the fold', () => {
  let stateDir: string;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-register-'));
    stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'sess-a.jsonl'),
      `${JSON.stringify(record('sess-a', 'session-start', {}))}\n`,
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const OPTS = {
    now: NOW,
    budgetPolicy: BUDGET,
    schedulerPolicy: SCHEDULER,
    projectDb: false,
    readProjects: () => [{ name: 'envkit', dir: '/repo/envkit', self: false }],
  };

  it('reports an unwatched repo from runTick', async () => {
    const report = await runTick({ ...OPTS, stateDir });
    const unwatched = report.findings.filter((f) => f.kind === 'unwatched-project');
    expect(unwatched).toHaveLength(1);
    expect(unwatched[0]?.subject).toBe('/repo/envkit');
  });

  // Both halves, because only the pair is evidence: a runDaemon that dropped
  // the register would report nothing, and "nothing" is what the cleared case
  // asserts on its own.
  it('reports it from the loop too, and stops once the repo is named', async () => {
    const [silent] = await runDaemon({ dir, intervalSeconds: 1, once: true, ...OPTS, stateDir });
    expect(silent?.findings.filter((f) => f.kind === 'unwatched-project')).toHaveLength(1);

    const [watched] = await runDaemon({
      dir,
      intervalSeconds: 1,
      once: true,
      ...OPTS,
      stateDir,
      projectDirs: ['/repo/envkit'],
    });
    expect(watched?.findings.filter((f) => f.kind === 'unwatched-project')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The bug this closes, found by pointing the shipped daemon at this clone: the
// whole factory-wide pass was gated on there being a session in the log, so a
// factory that had not yet been used read no lockfile and named no unwatched
// repo. Nothing about `pnpm outdated` needs a session to have happened -- a
// dependency falls behind on the registry's clock, not on ours -- and the
// window where that gate bit is exactly the window it must not: a fresh clone,
// and a child project scaffolded an hour ago.
// ---------------------------------------------------------------------------
describe('a factory that has built nothing still has repos to tend', () => {
  let stateDir: string;
  let dir: string;

  // No session file anywhere. This is what `state/events` looks like on a
  // clone nobody has run a task in yet.
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-fresh-'));
    stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const OPTS = {
    now: NOW,
    budgetPolicy: BUDGET,
    schedulerPolicy: SCHEDULER,
    projectDb: false,
    readOutdated: (): OutdatedPackage[] => [
      { name: 'lodash', current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
    ],
    readProjects: () => [{ name: 'envkit', dir: '/repo/envkit', self: false }],
  };

  it('reads the lockfiles even with no session in the log', async () => {
    const report = await runTick({ ...OPTS, stateDir, projectDirs: ['/repo/self'] });
    expect(report.sessions).toEqual([]);
    expect(report.findings.filter((f) => f.kind === 'maintenance')).toHaveLength(1);
  });

  it('names a repo nothing is watching even with no session in the log', async () => {
    const report = await runTick({ ...OPTS, stateDir });
    const unwatched = report.findings.filter((f) => f.kind === 'unwatched-project');
    expect(unwatched).toHaveLength(1);
    expect(unwatched[0]?.subject).toBe('/repo/envkit');
  });

  // The half of the old gate that was right, kept: a cadence reminder about
  // work that has never started is noise a fresh clone does not need.
  it('still asks for no growth review on a factory with no history', async () => {
    const report = await runTick({ ...OPTS, stateDir });
    expect(report.findings.filter((f) => f.kind === 'growth-review')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same gate one layer down, in the read-model. `milestones` is the one
// projected table that is not a fold of the event log at all -- it is a full
// replacement of roadmap.md, and projector.ts says so in as many words -- and
// the only thing that refreshes it is `apply()`, which a tick called once per
// session. A clone with no session in the log therefore got no read-model at
// all: not an empty Roadmap view, an unopened database file. `smith db
// rebuild` filled it by hand and the daemon never did, which is the wrong way
// round for the one process whose whole justification is that nobody is
// watching.
// ---------------------------------------------------------------------------
describe('the read-model of a factory with no sessions', () => {
  let dir: string;
  let stateDir: string;
  let dbPath: string;
  let roadmapPath: string;

  // A roadmap is a declaration, not a record of work: this one is legible the
  // day the repo is cloned and nothing has run in it.
  const ROADMAP = [
    '# Roadmap',
    '',
    '## Phase A — Declared, not started',
    '- id: phase-a',
    '- status: planned',
    '- epics: []',
    '',
  ].join('\n');

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smith-fresh-db-'));
    stateDir = path.join(dir, 'events');
    mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(dir, 'smith.db');
    roadmapPath = path.join(dir, 'roadmap.md');
    writeFileSync(roadmapPath, ROADMAP, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Both readers stubbed empty: this block is about the projection, and a
  // fixture that also read the operator's real project register would answer
  // a different question every time somebody scaffolded a repo.
  const tick = (overrides: Partial<Parameters<typeof runTick>[0]> = {}) =>
    runTick({
      now: NOW,
      budgetPolicy: BUDGET,
      schedulerPolicy: SCHEDULER,
      stateDir,
      projectDb: true,
      dbPath,
      dbOpts: { roadmapPath },
      readOutdated: () => [],
      readProjects: () => [],
      ...overrides,
    });

  it('projects the roadmap with no session to hang it off', async () => {
    const report = await tick();
    expect(report.sessions).toEqual([]);

    const handle = openDb(dbPath);
    try {
      expect(roadmapPage(handle.db).map((m) => m.milestoneId)).toEqual(['phase-a']);
    } finally {
      handle.sqlite.close();
    }
  });

  // `projected` counts sessions folded, and none were. Refreshing a table that
  // was never session-scoped is not a session projection, and a number that
  // said otherwise would be one an operator could not reconcile with the
  // `sessions` list printed beside it.
  it('still reports no sessions projected', async () => {
    expect((await tick()).projected).toBe(0);
  });

  // Same promise as the per-session path: the read-model failing is a finding,
  // not a crash. It carries no session because there is no session to blame --
  // and it clears on the next tick that can open the file, so the attention
  // count it raises can come back down.
  it('reports a projection failure it cannot pin on any session', async () => {
    mkdirSync(dbPath, { recursive: true });

    const report = await tick();

    const failed = report.findings.filter((f) => f.kind === 'projection-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.severity).toBe('attention');
    expect(failed[0]?.sessionId).toBeNull();
    expect(failed[0]?.subject).toBe(dbPath);
    expect(report.attention).toBe(1);
  });

  it('leaves the database alone when the projection is switched off', async () => {
    await tick({ projectDb: false });
    expect(existsSync(dbPath)).toBe(false);
  });
});
