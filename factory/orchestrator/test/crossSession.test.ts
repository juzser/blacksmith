// P9-7: an epic that outgrows one operator session has to be expressible.
// Fan-out is bounded by the claim graph rather than a concurrency cap, so the
// real ceiling on epic size is the orchestrator's context window, and the
// stated fix — split the epic across sessions — was blocked: causal_parent
// was validated against the appending session's own log, so a second session
// could never chain onto the first one's timeline.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, openDb } from '../src/db/projector.js';
import { timeline } from '../src/db/queries.js';
import { closeEpic, runEpicVerdict } from '../src/epic.js';
import {
  appendEvent,
  type EventError,
  type EventOpts,
  type EventRecord,
  parseEventId,
  readLineageEvents,
  sessionLineage,
} from '../src/events.js';
import { type FindingDraft, listFindings, raiseFinding, transition } from '../src/findings.js';
import { type EpicGoalStatus, goalDigest } from '../src/goalCheck.js';
import { MCP_SURFACE_NOT_REQUIRED } from '../src/mcp.js';
import { readAddedTasks } from '../src/taskEvents.js';
import { grantWaiver, isWaived } from '../src/waivers.js';

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return (err as EventError).code;
  }
  return undefined;
}

function codeOfSync(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as EventError).code;
  }
  return undefined;
}

/** A session with a root plus `count` chained events. Returns the last event id. */
async function seedSession(
  sessionId: string,
  count: number,
  opts: EventOpts,
  rootParent: string | null = null,
): Promise<string> {
  const root = await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: rootParent,
      payload: {},
    },
    opts,
  );
  let parent = root.event_id;
  for (let i = 0; i < count; i += 1) {
    const next = await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'user_prompt',
        plan_version: 1,
        causal_parent: parent,
        payload: { prompt: `${sessionId} step ${i}` },
      },
      opts,
    );
    parent = next.event_id;
  }
  return parent;
}

describe('parseEventId', () => {
  it('splits an event id into its session and index', () => {
    expect(parseEventId('sess-1#42')).toEqual({ sessionId: 'sess-1', index: 42 });
  });

  it('splits on the LAST # so a session id containing one still resolves', () => {
    expect(parseEventId('sess#weird#3')).toEqual({ sessionId: 'sess#weird', index: 3 });
  });

  it('rejects an id with no separator', () => {
    expect(codeOfSync(() => parseEventId('sess-1'))).toBe('events.malformed-event-id');
  });

  it('rejects an empty session part', () => {
    expect(codeOfSync(() => parseEventId('#3'))).toBe('events.malformed-event-id');
  });

  it('rejects a non-integer index', () => {
    expect(codeOfSync(() => parseEventId('sess-1#last'))).toBe('events.malformed-event-id');
  });

  it('rejects a negative index', () => {
    expect(codeOfSync(() => parseEventId('sess-1#-1'))).toBe('events.malformed-event-id');
  });
});

describe('cross-session causal_parent', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-cross-session-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("chains a second session's root onto an event in the first session", async () => {
    const tail = await seedSession('sess-a', 2, { stateDir });
    expect(tail).toBe('sess-a#2');

    const continuation = await appendEvent(
      {
        session_id: 'sess-b',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: tail,
        payload: { continues: 'sess-a' },
      },
      { stateDir },
    );

    expect(continuation.event_id).toBe('sess-b#0');
    expect(continuation.record.causal_parent).toBe('sess-a#2');
  });

  it('still rejects a same-session parent that does not exist', async () => {
    await seedSession('sess-a', 1, { stateDir });
    expect(
      await codeOf(() =>
        appendEvent(
          {
            session_id: 'sess-a',
            actor: 'user',
            event_type: 'user_prompt',
            plan_version: 1,
            causal_parent: 'sess-a#99',
            payload: {},
          },
          { stateDir },
        ),
      ),
    ).toBe('events.unknown-causal-parent');
  });

  it('rejects a cross-session parent whose session has no log at all', async () => {
    expect(
      await codeOf(() =>
        appendEvent(
          {
            session_id: 'sess-b',
            actor: 'user',
            event_type: 'session-start',
            plan_version: 1,
            causal_parent: 'sess-typo#0',
            payload: {},
          },
          { stateDir },
        ),
      ),
    ).toBe('events.unknown-causal-session');
  });

  it('rejects a cross-session parent index the other session never reached', async () => {
    await seedSession('sess-a', 1, { stateDir });
    expect(
      await codeOf(() =>
        appendEvent(
          {
            session_id: 'sess-b',
            actor: 'user',
            event_type: 'session-start',
            plan_version: 1,
            causal_parent: 'sess-a#7',
            payload: {},
          },
          { stateDir },
        ),
      ),
    ).toBe('events.unknown-causal-parent');
  });

  it('allows the cross-session edge only on the session root', async () => {
    await seedSession('sess-a', 1, { stateDir });
    await seedSession('sess-b', 0, { stateDir }, 'sess-a#1');

    expect(
      await codeOf(() =>
        appendEvent(
          {
            session_id: 'sess-b',
            actor: 'user',
            event_type: 'user_prompt',
            plan_version: 1,
            causal_parent: 'sess-a#0',
            payload: {},
          },
          { stateDir },
        ),
      ),
    ).toBe('events.cross-session-parent-not-root');
  });

  it('rejects a malformed causal_parent rather than treating it as cross-session', async () => {
    await seedSession('sess-a', 1, { stateDir });
    expect(
      await codeOf(() =>
        appendEvent(
          {
            session_id: 'sess-a',
            actor: 'user',
            event_type: 'user_prompt',
            plan_version: 1,
            causal_parent: 'no-hash-here',
            payload: {},
          },
          { stateDir },
        ),
      ),
    ).toBe('events.malformed-event-id');
  });

  it('leaves the root-null rule intact for non-root events', async () => {
    expect(
      await codeOf(() =>
        appendEvent(
          {
            session_id: 'sess-a',
            actor: 'user',
            event_type: 'user_prompt',
            plan_version: 1,
            causal_parent: null,
            payload: {},
          },
          { stateDir },
        ),
      ),
    ).toBe('events.missing-causal-parent');
  });

  it('writes nothing to the log when the cross-session parent is rejected', async () => {
    await codeOf(() =>
      appendEvent(
        {
          session_id: 'sess-b',
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: 'sess-nope#0',
          payload: {},
        },
        { stateDir },
      ),
    );
    // The rejected session must not exist on disk at all — a half-created log
    // would make the next attempt's index wrong.
    const lineage = await codeOf(() => sessionLineage('sess-b', { stateDir }));
    expect(lineage).toBe('events.unknown-session');
  });
});

describe('sessionLineage', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('returns just the session itself when it has no cross-session parent', async () => {
    await seedSession('sess-a', 1, { stateDir });
    expect(await sessionLineage('sess-a', { stateDir })).toEqual(['sess-a']);
  });

  it('returns root-first order across three chained sessions', async () => {
    await seedSession('sess-a', 1, { stateDir });
    await seedSession('sess-b', 1, { stateDir }, 'sess-a#1');
    await seedSession('sess-c', 1, { stateDir }, 'sess-b#1');
    expect(await sessionLineage('sess-c', { stateDir })).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('throws on an unknown session rather than answering with an empty lineage', async () => {
    expect(await codeOf(() => sessionLineage('sess-nope', { stateDir }))).toBe(
      'events.unknown-session',
    );
  });
});

describe('timeline() causal chain across a session boundary', () => {
  let stateDir: string;
  let dbDir: string;
  let db: ReturnType<typeof openDb>['db'];
  let sqlite: ReturnType<typeof openDb>['sqlite'];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-cross-timeline-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-cross-timeline-db-'));
    const dbPath = path.join(dbDir, 'smith.db');

    await seedSession('sess-a', 1, { stateDir });
    await seedSession('sess-b', 1, { stateDir }, 'sess-a#1');

    await apply(dbPath, 'sess-a', { stateDir });
    await apply(dbPath, 'sess-b', { stateDir });
    const handle = openDb(dbPath);
    db = handle.db;
    sqlite = handle.sqlite;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('walks past the session boundary back to the first session root', () => {
    const chain = timeline(db, { sessionId: 'sess-b', causalChainFor: 'sess-b#1' });
    expect(chain.map((e) => e.eventId)).toEqual(['sess-a#0', 'sess-a#1', 'sess-b#0', 'sess-b#1']);
  });

  it('still refuses a starting event that is not in the named session', () => {
    expect(timeline(db, { sessionId: 'sess-a', causalChainFor: 'sess-b#1' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D-119 (S1). `sessionLineage` shipped with P9-7 and was then read by exactly
// two call sites, both read-only display verbs. Every fold that *decided*
// something read one session — and reported its answer in the same words it
// would have used if it had read them all. Splitting the real `dogfood-mcp-1`
// log in two, findings in one file and everything else in the other, turned
// `hold` with eleven open findings into `go` with none.
// ---------------------------------------------------------------------------

describe('readLineageEvents (D-119)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-lineage-read-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /**
   * Logs written by hand, not through appendEvent: these cases are about how
   * two separately-clocked sessions merge, and appendEvent stamps `ts` from
   * the wall clock — several appends in a test land on the same millisecond.
   */
  async function writeLog(sessionId: string, records: Partial<EventRecord>[]): Promise<void> {
    const lines = records.map((r) =>
      JSON.stringify({
        session_id: sessionId,
        actor: 'user',
        event_type: 'user_prompt',
        plan_version: 1,
        causal_parent: null,
        payload: {},
        ...r,
      }),
    );
    await writeFile(path.join(stateDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }

  const at = (ts: string): Partial<EventRecord> => ({ ts });
  const rootAt = (ts: string, parent: string | null): Partial<EventRecord> => ({
    ts,
    event_type: 'session-start',
    causal_parent: parent,
  });

  it('reads only this session when it has no cross-session parent', async () => {
    await writeLog('sess-a', [
      rootAt('2026-01-01T00:00:00.000Z', null),
      at('2026-01-01T00:00:01.000Z'),
    ]);
    const events = await readLineageEvents('sess-a', { stateDir });
    expect(events.map((e) => e.event_id)).toEqual(['sess-a#0', 'sess-a#1']);
  });

  it("reads every ancestor's events, not just the session it was asked about", async () => {
    await writeLog('sess-a', [
      rootAt('2026-01-01T00:00:00.000Z', null),
      at('2026-01-01T00:00:01.000Z'),
    ]);
    await writeLog('sess-b', [
      rootAt('2026-01-01T01:00:00.000Z', 'sess-a#1'),
      at('2026-01-01T01:00:01.000Z'),
    ]);
    await writeLog('sess-c', [rootAt('2026-01-01T02:00:00.000Z', 'sess-b#1')]);

    const events = await readLineageEvents('sess-c', { stateDir });
    expect(events.map((e) => e.event_id)).toEqual([
      'sess-a#0',
      'sess-a#1',
      'sess-b#0',
      'sess-b#1',
      'sess-c#0',
    ]);
  });

  // Two sessions genuinely running at once — the parent kept working after the
  // continuation chained onto it. Whole-chunk concatenation would put every
  // parent event before every child event and hand a last-write-wins fold the
  // wrong winner.
  it('interleaves two sessions by timestamp', async () => {
    await writeLog('sess-a', [
      rootAt('2026-01-01T00:00:00.000Z', null),
      at('2026-01-01T00:00:02.000Z'),
      at('2026-01-01T00:00:04.000Z'),
    ]);
    await writeLog('sess-b', [
      rootAt('2026-01-01T00:00:01.000Z', 'sess-a#0'),
      at('2026-01-01T00:00:03.000Z'),
      at('2026-01-01T00:00:05.000Z'),
    ]);

    const events = await readLineageEvents('sess-b', { stateDir });
    expect(events.map((e) => e.event_id)).toEqual([
      'sess-a#0',
      'sess-b#0',
      'sess-a#1',
      'sess-b#1',
      'sess-a#2',
      'sess-b#2',
    ]);
  });

  // findings.ts's staleFindings is "strictly ordering-based … a timestamp
  // comparison across separately-clocked producers would not" give the right
  // answer. That caution holds: a session's own append order is authoritative
  // and nothing here may reorder it. The clock decides only which session goes
  // next, because between two sessions it is the one shared reference there is.
  it("never reorders a session's own events, even when its clock steps backwards", async () => {
    await writeLog('sess-a', [
      rootAt('2026-01-01T00:00:00.000Z', null),
      at('2026-01-01T00:00:09.000Z'),
      at('2026-01-01T00:00:03.000Z'),
    ]);
    await writeLog('sess-b', [rootAt('2026-01-01T00:00:20.000Z', 'sess-a#0')]);

    const events = await readLineageEvents('sess-b', { stateDir });
    expect(events.map((e) => e.event_id)).toEqual(['sess-a#0', 'sess-a#1', 'sess-a#2', 'sess-b#0']);
  });

  // P9-28's contract, deliberately inherited: readEvents answers [] for a log
  // that does not exist because appendEvent depends on "absent" meaning
  // "empty". This is a drop-in for the fold sites, so it must not start
  // throwing where readEvents returned. requireSession stays the opt-in.
  it('answers [] for a session with no log, exactly as readEvents does', async () => {
    expect(await readLineageEvents('sess-nope', { stateDir })).toEqual([]);
  });

  it('refuses a lineage that cycles rather than reading forever', async () => {
    await writeLog('sess-a', [rootAt('2026-01-01T00:00:00.000Z', 'sess-b#0')]);
    await writeLog('sess-b', [rootAt('2026-01-01T00:00:01.000Z', 'sess-a#0')]);
    expect(await codeOf(() => readLineageEvents('sess-b', { stateDir }))).toBe(
      'events.session-lineage-cycle',
    );
  });
});

// The defect itself, at the size it was measured: an epic whose findings sit in
// the session that raised them and whose work continues in a second session.
// `validateCausalParent`'s own header calls this "the documented way to run a
// large epic".
describe('an epic split across sessions cannot launder its findings (D-119)', () => {
  let stateDir: string;
  const parent = 'sess-round-1';
  const child = 'sess-round-2';
  const epicId = 'epic-1';
  const HEAD_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';

  const ctxOf = (sessionId: string) => ({
    sessionId,
    planVersion: 1,
    causalParent: `${sessionId}#0`,
  });

  function draft(): FindingDraft {
    return {
      finding_id: 'finding-1',
      task_id: `${epicId}/task-1`,
      finding_category: 'correctness',
      severity: 'S2-major',
      finding_status: 'raised',
      summary: 'the redactor echoes the key it was asked to hide',
      failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
      found_by: 'reviewer',
    };
  }

  // The roadmap goal the epic gate checks the plan against. It is held current
  // here for the same reason the integration run is: this suite is about a
  // finding surviving a session boundary, and every other gate has to be green
  // for that to be the thing under test.
  const GOAL_TEXT = 'Redact secrets before they reach a log line.';

  function goalStatus(): EpicGoalStatus {
    return {
      milestoneId: 'milestone-1',
      goal: GOAL_TEXT,
      clauses: [GOAL_TEXT],
      digest: goalDigest(GOAL_TEXT),
    };
  }

  async function emit(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
    taskId?: string,
  ) {
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'operator',
        event_type: eventType,
        ...(taskId === undefined ? {} : { task_id: taskId }),
        plan_version: 1,
        causal_parent: `${sessionId}#0`,
        payload,
      },
      { stateDir },
    );
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-launder-'));

    // Round 1 raises the finding and does nothing else. It stays open.
    await seedSession(parent, 0, { stateDir });
    await raiseFinding({ finding: draft(), filePath: 'src/redact.ts' }, ctxOf(parent), {
      stateDir,
    });

    // Round 2 continues the epic in a fresh operator session — the sequence the
    // architecture recommends, and the one that opened the hole.
    await appendEvent(
      {
        session_id: child,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: `${parent}#1`,
        payload: { continues: parent },
      },
      { stateDir },
    );
    await emit(
      child,
      'task-added',
      { epic_id: epicId, task_status: 'completed' },
      `${epicId}/task-1`,
    );
    await emit(
      child,
      'integration-check',
      {
        epic_id: epicId,
        branch: `smith/${epicId}/integration`,
        head_sha: HEAD_SHA,
        pass: true,
        results: [{ name: 'lint', pass: true, exitCode: 0, tail: '' }],
      },
      `${epicId}/integration`,
    );
    await emit(
      child,
      'spec-review-recorded',
      {
        epic_id: epicId,
        plan_version: 1,
        head_sha: HEAD_SHA,
        reviewed_by: 'spec-reviewer',
        finding_ids: [],
        finding_count: 0,
      },
      `${epicId}/integration`,
    );
    await emit(
      child,
      'goal-check-recorded',
      {
        epic_id: epicId,
        milestone_id: 'milestone-1',
        plan_version: 1,
        goal_digest: goalDigest(GOAL_TEXT),
        checked_by: 'spec-reviewer',
        coverage: [{ clause: GOAL_TEXT, verdict: 'covered', task_ids: [`${epicId}/task-1`] }],
        finding_ids: [],
        finding_count: 0,
      },
      `${epicId}/integration`,
    );
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('lists a finding raised in the previous session', async () => {
    const findings = await listFindings(child, { epic: epicId }, { stateDir });
    expect(findings.map((f) => f.finding_id)).toEqual(['finding-1']);
  });

  it('holds the verdict on the open finding instead of reporting zero', async () => {
    const outcome = await runEpicVerdict(
      { epicId, integrationHeadSha: HEAD_SHA, mcp: MCP_SURFACE_NOT_REQUIRED, goal: goalStatus() },
      ctxOf(child),
      { stateDir },
    );

    expect(outcome.summary.openFindings.map((f) => f.findingId)).toEqual(['finding-1']);
    expect(outcome.summary.mechanicallyReady).toBe(false);
    expect(outcome.outcome).toBe('hold');
    if (outcome.outcome !== 'hold') throw new Error('unreachable');
    expect(outcome.reason).toBe('mechanical-blockers');
  });

  it('refuses the close that the single-session read would have recorded as a clean verdict', async () => {
    expect(
      await codeOf(() =>
        closeEpic(
          {
            epicId,
            integrationHeadSha: HEAD_SHA,
            mcp: MCP_SURFACE_NOT_REQUIRED,
            goal: goalStatus(),
          },
          ctxOf(child),
          { stateDir },
        ),
      ),
    ).toBe('epic.close-refused');
  });

  // The verdict is the loudest of the folds, not the only one. Each of these
  // was a separate `readEvents(ctx.sessionId)` answering about half an epic,
  // and each answered wrongly in a different direction (D-119).
  it('transitions a finding raised in the previous session instead of calling it unknown', async () => {
    const moved = await transition('finding-1', 'confirmed', ctxOf(child), { stateDir });
    expect(moved.finding_status).toBe('confirmed');
  });

  it('honours a waiver the previous session granted', async () => {
    const [raised] = await listFindings(parent, {}, { stateDir });
    if (!raised) throw new Error('fixture: the parent session raised no finding');

    await grantWaiver(raised.fingerprint, 'operator accepted the risk', ctxOf(parent), {
      stateDir,
    });

    expect(await isWaived(raised.fingerprint, { sessionId: child }, { stateDir })).toBe(true);
  });

  it('sees a task the previous session added', async () => {
    await emit(
      parent,
      'task-added',
      { epic_id: epicId, task_status: 'todo', claims: ['src/redact.ts'] },
      `${epicId}/task-9`,
    );

    const added = await readAddedTasks({ sessionId: child }, { stateDir });
    expect(added.map((t) => t.taskId).sort()).toEqual([`${epicId}/task-1`, `${epicId}/task-9`]);
    expect(added.find((t) => t.taskId === `${epicId}/task-9`)?.claims).toEqual(['src/redact.ts']);
  });
});

// D-266: `--continues` was built for a chain -- an epic that outlives one
// operator window, continued in a fresh session and read from the newest end.
// The tier split D13 step 2 prescribes is not a chain but a fan-out: an epic
// session dispatching disposable per-wave sessions, each of which continues
// it. Read from the epic end -- which is where `epic close`, `wave audit` and
// every findings fold stand -- the walk only ever went up, so the epic session
// was blind to every session it had itself spawned, and reported that blindness
// in exactly the words it uses for an epic that never fanned out at all.
describe('a session that fans out into wave sessions (D-266)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-fanout-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** An epic session and the two wave sessions dispatched from its last event. */
  async function fanOut(): Promise<void> {
    const anchor = await seedSession('epic-s', 1, { stateDir });
    // Seeded out of id order on purpose: the answer is sorted, not arrival-ordered.
    await seedSession('wave-2', 1, { stateDir }, anchor);
    await seedSession('wave-1', 1, { stateDir }, anchor);
  }

  it('names every wave that continues the epic, not the epic alone', async () => {
    await fanOut();
    expect(await sessionLineage('epic-s', { stateDir })).toEqual(['epic-s', 'wave-1', 'wave-2']);
  });

  it('reaches a session a wave session spawned in turn', async () => {
    await fanOut();
    await seedSession('wave-1-retry', 1, { stateDir }, 'wave-1#1');
    expect(await sessionLineage('epic-s', { stateDir })).toEqual([
      'epic-s',
      'wave-1',
      'wave-2',
      'wave-1-retry',
    ]);
  });

  it('leaves a wave reading its own ancestry and not its siblings', async () => {
    await fanOut();
    expect(await sessionLineage('wave-1', { stateDir })).toEqual(['epic-s', 'wave-1']);
  });

  it('answers a plain chain from its newest end exactly as it did before', async () => {
    await seedSession('sess-a', 1, { stateDir });
    await seedSession('sess-b', 1, { stateDir }, 'sess-a#1');
    await seedSession('sess-c', 1, { stateDir }, 'sess-b#1');
    expect(await sessionLineage('sess-c', { stateDir })).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  // The other half of the same change. A chain is a tree that never branched,
  // so reading one from its oldest end used to answer with a scope of one --
  // and an operator resuming an epic has no way to know which end they are
  // standing on until they have already read the wrong scope.
  it('answers a plain chain from its oldest end with the whole chain', async () => {
    await seedSession('sess-a', 1, { stateDir });
    await seedSession('sess-b', 1, { stateDir }, 'sess-a#1');
    await seedSession('sess-c', 1, { stateDir }, 'sess-b#1');
    expect(await sessionLineage('sess-a', { stateDir })).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('ignores a session that continues nothing and is continued by nothing', async () => {
    await fanOut();
    await seedSession('unrelated', 1, { stateDir });
    expect(await sessionLineage('epic-s', { stateDir })).toEqual(['epic-s', 'wave-1', 'wave-2']);
  });

  // Set, not sequence: `seedSession` stamps `ts` from the wall clock and both
  // waves can land in the same millisecond, so the interleave is pinned below
  // with hand-written timestamps instead. What matters here is that the events
  // are read at all.
  it("reads the waves' events from the epic session", async () => {
    await fanOut();
    const events = await readLineageEvents('epic-s', { stateDir });
    expect(events.map((e) => e.event_id).sort()).toEqual([
      'epic-s#0',
      'epic-s#1',
      'wave-1#0',
      'wave-1#1',
      'wave-2#0',
      'wave-2#1',
    ]);
  });

  it('reads no sibling events from inside a wave session', async () => {
    await fanOut();
    const events = await readLineageEvents('wave-1', { stateDir });
    expect(events.map((e) => e.event_id).sort()).toEqual([
      'epic-s#0',
      'epic-s#1',
      'wave-1#0',
      'wave-1#1',
    ]);
  });

  // The merge rule does not change with the topology: across sessions the wall
  // clock is the only shared reference, so two waves working at the same time
  // interleave by `ts` rather than arriving one whole log after the other.
  it("interleaves two waves' events by timestamp, not one log after the other", async () => {
    async function writeLog(sessionId: string, records: Partial<EventRecord>[]) {
      const lines = records.map((r) =>
        JSON.stringify({
          session_id: sessionId,
          actor: 'operator',
          event_type: 'user_prompt',
          plan_version: 1,
          causal_parent: null,
          payload: {},
          ...r,
        }),
      );
      await writeFile(path.join(stateDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    }

    await writeLog('epic-t', [
      { event_type: 'session-start', ts: '2026-01-01T00:00:00.000Z' },
      { ts: '2026-01-01T00:00:01.000Z', causal_parent: 'epic-t#0' },
    ]);
    await writeLog('wave-a', [
      { event_type: 'session-start', causal_parent: 'epic-t#1', ts: '2026-01-01T00:00:02.000Z' },
      { ts: '2026-01-01T00:00:04.000Z', causal_parent: 'wave-a#0' },
    ]);
    await writeLog('wave-b', [
      { event_type: 'session-start', causal_parent: 'epic-t#1', ts: '2026-01-01T00:00:03.000Z' },
      { ts: '2026-01-01T00:00:05.000Z', causal_parent: 'wave-b#0' },
    ]);

    const events = await readLineageEvents('epic-t', { stateDir });
    expect(events.map((e) => e.event_id)).toEqual([
      'epic-t#0',
      'epic-t#1',
      'wave-a#0',
      'wave-b#0',
      'wave-a#1',
      'wave-b#1',
    ]);
  });

  it('refuses to read a lineage past a log whose first line is not JSON', async () => {
    await fanOut();
    await writeFile(path.join(stateDir, 'wave-3.jsonl'), 'not json at all\n', 'utf8');
    expect(await codeOf(() => sessionLineage('epic-s', { stateDir }))).toBe(
      'events.unreadable-session-log',
    );
  });

  it('lists a finding a wave session raised, from the session that closes the epic', async () => {
    await fanOut();
    await raiseFinding(
      {
        finding: {
          finding_id: 'finding-w1',
          task_id: 'epic-s/task-1',
          finding_category: 'correctness',
          severity: 'S1-stop-the-line',
          finding_status: 'raised',
          summary: 'the wave found a blocker the epic session never saw',
          failure_scenario: { inputs: 'n/a', expected: 'n/a', actual: 'n/a' },
          found_by: 'reviewer',
        },
        filePath: 'src/a.ts',
      },
      { sessionId: 'wave-1', planVersion: 1, causalParent: 'wave-1#1' },
      { stateDir },
    );
    const findings = await listFindings('epic-s', {}, { stateDir });
    expect(findings.map((f) => f.finding_id)).toEqual(['finding-w1']);
  });
});
