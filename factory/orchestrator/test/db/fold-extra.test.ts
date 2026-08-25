import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldEpics, foldLessons, foldTasks, openDb, rebuild } from '../../src/db/projector.js';
import { analytics } from '../../src/db/queries.js';
import type { EventRecord, StoredEvent } from '../../src/events.js';
import { appendEvent } from '../../src/events.js';

function event(overrides: Partial<EventRecord> & { event_id: string }): StoredEvent {
  const { event_id, ...record } = overrides;
  return {
    event_id,
    record: {
      session_id: 'sess-extra',
      actor: 'system',
      event_type: 'note',
      plan_version: 1,
      causal_parent: null,
      payload: {},
      ts: '2026-08-01T00:00:00.000Z',
      ...record,
    },
  };
}

describe('foldTasks — task-superseded', () => {
  it('marks a task superseded, and a bare task_id with no other event still gets a row', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'task-superseded',
        task_id: 'epic-1/task-1',
        ts: '2026-08-01T00:00:00.000Z',
      }),
    ];
    const rows = foldTasks(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'epic-1/task-1', taskStatus: 'superseded' });
  });

  it('ignores a task-superseded event with no task_id', () => {
    const events = [event({ event_id: 'e1', event_type: 'task-superseded' })];
    expect(foldTasks(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D-49/P9-10. The same task reaches the fold under two id forms — qualified
// on task-added, bare on the wave events — and used to come out as two rows:
// one stuck at `todo` forever, one with no epic. The fold normalises at its
// boundary, so a task holds exactly one row whichever form the producer used.
// ---------------------------------------------------------------------------
describe('foldTasks — task id normalisation', () => {
  it('folds qualified and bare forms of one task into a single row', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'envkit/task-0',
        payload: { epic_id: 'envkit', task_status: 'todo' },
        ts: '2026-08-01T00:00:00.000Z',
      }),
      event({
        event_id: 'e2',
        event_type: 'wave-admitted',
        payload: { epic_id: 'envkit', task_ids: ['task-0'] },
        ts: '2026-08-01T00:01:00.000Z',
      }),
      event({
        event_id: 'e3',
        event_type: 'wave-merged',
        payload: { task_ids: ['task-0'] },
        ts: '2026-08-01T00:02:00.000Z',
      }),
    ];

    const rows = foldTasks(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: 'envkit/task-0',
      epicId: 'envkit',
      taskStatus: 'completed',
      branch: 'smith/envkit/task-0',
    });
  });

  it('sets epicId from a qualified id even when no payload carries epic_id', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'dispatch_decision',
        task_id: 'epic-4/task-7',
        ts: '2026-08-01T00:00:00.000Z',
      }),
    ];
    expect(foldTasks(events)[0]).toMatchObject({ taskId: 'epic-4/task-7', epicId: 'epic-4' });
  });

  it('leaves a bare id alone when two epics both claim it', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-a/task-0',
        payload: { epic_id: 'epic-a' },
        ts: '2026-08-01T00:00:00.000Z',
      }),
      event({
        event_id: 'e2',
        event_type: 'task-added',
        task_id: 'epic-b/task-0',
        payload: { epic_id: 'epic-b' },
        ts: '2026-08-01T00:01:00.000Z',
      }),
      event({
        event_id: 'e3',
        event_type: 'wave-merged',
        payload: { task_ids: ['task-0'] },
        ts: '2026-08-01T00:02:00.000Z',
      }),
    ];

    const rows = foldTasks(events).map((r) => ({ taskId: r.taskId, taskStatus: r.taskStatus }));
    // Guessing one of them would silently complete the wrong task; the
    // unresolvable id stays its own row and stays visible.
    expect(rows).toEqual([
      { taskId: 'epic-a/task-0', taskStatus: 'todo' },
      { taskId: 'epic-b/task-0', taskStatus: 'todo' },
      { taskId: 'task-0', taskStatus: 'completed' },
    ]);
  });
});

// D-23/P9-12. `wave-admitted` and `wave-merged` are wave-SCOPED: what they
// mean lives in `task_ids`. Four times during the dogfood run a wave event was
// hand-appended with the envelope's singular `task_id` filled in and
// `task_ids` left empty, and the fold read nothing at all — the keystrokes
// were silently a no-op and the board stayed wrong. The producers in
// taskEvents.ts always write `task_ids`; the fold accepts the record-level id
// as a one-element wave so a hand-written event means what it looks like it
// means.
describe('foldTasks — wave-scoped events (D-23 / P9-12)', () => {
  it('admits and merges every id in a multi-task wave', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'wave-admitted',
        ts: '2026-08-01T00:00:00.000Z',
        payload: { epic_id: 'epic-1', task_ids: ['epic-1/task-1', 'epic-1/task-2'] },
      }),
      event({
        event_id: 'e2',
        event_type: 'wave-merged',
        ts: '2026-08-01T01:00:00.000Z',
        payload: { task_ids: ['epic-1/task-1', 'epic-1/task-2'] },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.taskStatus)).toEqual(['completed', 'completed']);
  });

  it('leaves the other tasks of a wave alone when only one of them merges', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'wave-admitted',
        ts: '2026-08-01T00:00:00.000Z',
        payload: { epic_id: 'epic-1', task_ids: ['epic-1/task-1', 'epic-1/task-2'] },
      }),
      event({
        event_id: 'e2',
        event_type: 'wave-merged',
        task_id: 'epic-1/task-1',
        ts: '2026-08-01T01:00:00.000Z',
        payload: { task_ids: ['epic-1/task-1'] },
      }),
    ]);
    expect(rows[0]).toMatchObject({ taskId: 'epic-1/task-1', taskStatus: 'completed' });
    expect(rows[1]).toMatchObject({ taskId: 'epic-1/task-2', taskStatus: 'ready' });
  });

  it('falls back to the record-level task_id when task_ids is absent', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'wave-admitted',
        task_id: 'epic-1/task-1',
        ts: '2026-08-01T00:00:00.000Z',
        payload: { epic_id: 'epic-1' },
      }),
      event({
        event_id: 'e2',
        event_type: 'wave-merged',
        task_id: 'epic-1/task-1',
        ts: '2026-08-01T01:00:00.000Z',
        payload: {},
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'epic-1/task-1', taskStatus: 'completed' });
  });

  it('still records nothing for a wave event that names no task at all', () => {
    const rows = foldTasks([
      event({ event_id: 'e1', event_type: 'wave-merged', payload: { epic_id: 'epic-1' } }),
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('foldTasks — branch (D-23 / P9-12)', () => {
  it('prefers the branch the task-added payload declares', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: { epic_id: 'epic-1', branch: 'smith/epic-1/rename-me' },
      }),
    ]);
    expect(rows[0]?.branch).toBe('smith/epic-1/rename-me');
  });

  it('derives the conventional branch when the payload declares none', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: { epic_id: 'epic-1' },
      }),
    ]);
    expect(rows[0]?.branch).toBe('smith/epic-1/task-1');
  });
});

describe('foldTasks — task-added claims shape', () => {
  /**
   * event.schema.json validates `payload` as `type: object` and nothing
   * further — the body is deliberately free-form so a new event type is never
   * rejected at write time — and taskEvents.ts says so out loud by typing
   * `AddedTask.claims` as `unknown`. The fold casts the payload to a shape
   * with `claims?: string[]` and writes whatever it finds straight through:
   * projectSession() JSON.stringifies it into tasks.claims and taskDetail()
   * JSON.parses it back `as string[]`, so a bare string arrives at the board
   * still a string, and `v-for` renders one chip per character. waveTaskIds
   * already learned that a hand-appended payload fills in the singular field
   * ("that happened four times during the dogfood run"), and a claim set
   * written as one path is the same keystroke. A fold has to mean what the
   * writer meant, and it cannot tell what this one meant.
   */
  it('does not read a bare-string claims payload as a list of paths', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: { epic_id: 'epic-1', claims: 'src/widget.ts' },
      }),
    ]);
    expect(rows[0]?.claims).toBeNull();
  });

  /**
   * A half-readable list is the same hole as no list: keeping the strings out
   * of it would hand every reader a shorter set than the task declared and
   * call that what the task owns. gate.ts's loggedClaims() makes the same
   * call on the same payload, and the two registers have to agree.
   */
  it('does not read a claims list that is not all paths', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: { epic_id: 'epic-1', claims: ['src/widget.ts', 7] },
      }),
    ]);
    expect(rows[0]?.claims).toBeNull();
  });

  it('reads a proper claims list, and an unreadable one never clobbers it', () => {
    const rows = foldTasks([
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: { epic_id: 'epic-1', claims: ['src/widget.ts'] },
      }),
      event({
        event_id: 'e2',
        event_type: 'task-added',
        task_id: 'epic-1/task-1',
        payload: { epic_id: 'epic-1', claims: { 'src/widget.ts': true } },
      }),
    ]);
    expect(rows[0]?.claims).toEqual(['src/widget.ts']);
  });
});

describe('foldLessons — malformed candidate guard', () => {
  it('skips a lesson-candidate-raised event missing required fields', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'lesson-candidate-raised',
        payload: { lesson_id: 'lesson-x' }, // missing type/level/scope/statement
      }),
    ];
    expect(foldLessons(events)).toHaveLength(0);
  });

  it('ignores a lesson-status-changed for an unknown lesson_id', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'lesson-status-changed',
        payload: { lesson_id: 'no-such-lesson', to_status: 'approved' },
      }),
    ];
    expect(foldLessons(events)).toHaveLength(0);
  });

  it('applies lesson-edited fields onto an existing candidate, only overwriting what changed', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'lesson-candidate-raised',
        payload: {
          lesson_id: 'lesson-x',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_scope: 'claim-path',
          statement: 'Original statement.',
        },
      }),
      event({
        event_id: 'e2',
        event_type: 'lesson-edited',
        payload: { lesson_id: 'lesson-x', statement: 'Edited statement.' },
      }),
    ];
    const rows = foldLessons(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      statement: 'Edited statement.',
      lessonType: 'rule', // unchanged — the edit payload didn't touch it
      lessonScope: 'claim-path',
    });
  });

  it('keeps the statement a whitespace-only edit would blank, and trims the one it applies', () => {
    // transitionLesson trims the edited statement and then refuses an empty
    // one outright ('a lesson with nothing to say cannot be approved into
    // memory'), so `'   '` is a statement the writer will not produce. The
    // projector's `if (p.statement)` is a truthiness test, which is not the
    // same guard: it reads '   ' as a statement and overwrites a real one with
    // it. Replay is not the place to discover that the writer's rule was the
    // only thing holding — a fold has to mean what the writer meant.
    const raised = event({
      event_id: 'e1',
      event_type: 'lesson-candidate-raised',
      payload: {
        lesson_id: 'lesson-w',
        lesson_type: 'rule',
        lesson_level: 'principle',
        lesson_scope: 'stack-wide',
        statement: 'Original statement.',
      },
    });
    const edit = (statement: string) =>
      event({
        event_id: 'e2',
        event_type: 'lesson-edited',
        payload: { lesson_id: 'lesson-w', statement },
      });

    expect(foldLessons([raised, edit('   ')])[0]).toMatchObject({
      statement: 'Original statement.',
    });
    expect(foldLessons([raised, edit('  Edited statement.  ')])[0]).toMatchObject({
      statement: 'Edited statement.',
    });
  });

  it('ignores a lesson-edited event for an unknown lesson_id', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'lesson-edited',
        payload: { lesson_id: 'no-such-lesson', statement: 'x' },
      }),
    ];
    expect(foldLessons(events)).toHaveLength(0);
  });

  it('carries finding_category/claim_path through when the raise payload sets them (Phase 7)', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'lesson-candidate-raised',
        payload: {
          lesson_id: 'lesson-y',
          lesson_type: 'rule',
          lesson_level: 'principle',
          lesson_scope: 'claim-path',
          statement: 'Never hand-edit a lockfile.',
          finding_category: 'maintainability',
          claim_path: '**/pnpm-lock.yaml',
        },
      }),
    ];
    const rows = foldLessons(events);
    expect(rows[0]).toMatchObject({
      findingCategory: 'maintainability',
      claimPath: '**/pnpm-lock.yaml',
    });
  });

  it('defaults finding_category/claim_path to null when the raise payload omits them', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'lesson-candidate-raised',
        payload: {
          lesson_id: 'lesson-z',
          lesson_type: 'event',
          lesson_level: 'principle',
          lesson_scope: 'agent-role',
          statement: 'Escalation happened.',
        },
      }),
    ];
    const rows = foldLessons(events);
    expect(rows[0]).toMatchObject({ findingCategory: null, claimPath: null });
  });
});

describe('analytics() — recheck outcomes', () => {
  let stateDir: string;
  let dbDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-recheck-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-recheck-db-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('groups origin:recheck tasks by their final task_status', async () => {
    const sessionId = 'sess-recheck';
    const root = await appendEvent(
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
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'scheduler',
        event_type: 'task-added',
        task_id: 'epic-2/task-1',
        plan_version: 1,
        causal_parent: root.event_id,
        payload: {
          epic_id: 'epic-2',
          case: 'recheck',
          origin: 'recheck',
          task_status: 'blocked',
          objective: 'Re-check the previously merged feature.',
          claims: ['src/feature.ts'],
        },
      },
      { stateDir },
    );

    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    const handle = openDb(dbPath);
    const result = analytics(handle.db, { sessionId });
    handle.sqlite.close();

    expect(result.recheckOutcomes).toEqual([{ taskStatus: 'blocked', count: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// D-44/P9-27. Appending the close event is half the fix. projectSession()
// writes every event to events_raw, so a hand-written epic-closed is
// queryable there — but foldTasks()'s switch knows seven event types and ends
// `default: break;`, so nothing in the projection changed. The log and the
// projection disagreed, and the projection is what every human-facing surface
// reads.
// ---------------------------------------------------------------------------
describe('foldEpics — epic-closed (D-44/P9-27)', () => {
  const closeEvent = (overrides: Record<string, unknown> = {}, eventId = 'e1') =>
    event({
      event_id: eventId,
      event_type: 'epic-closed',
      task_id: 'epic-1/integration',
      actor: 'operator',
      ts: '2026-08-05T00:00:00.000Z',
      payload: {
        epic_id: 'epic-1',
        closed_by: 'verdict',
        machine_verdict: 'go',
        machine_reason: null,
        override_rationale: null,
        blockers: [],
        ...overrides,
      },
    });

  it('folds a close into one epic row', () => {
    const rows = foldEpics([closeEvent()]);
    expect(rows).toEqual([
      {
        epicId: 'epic-1',
        sessionId: 'sess-extra',
        epicStatus: 'closed',
        closedBy: 'verdict',
        machineVerdict: 'go',
        machineReason: null,
        overrideRationale: null,
        blockers: [],
        closedAt: '2026-08-05T00:00:00.000Z',
        eventId: 'e1',
        project: null,
      },
    ]);
  });

  it('keeps the override rationale and the blockers the operator overrode', () => {
    const rows = foldEpics([
      closeEvent({
        closed_by: 'operator-override',
        machine_verdict: 'hold',
        machine_reason: 'mechanical-blockers',
        override_rationale: 'known carry-forward defect',
        blockers: ['Task "epic-1/task-1" is not terminal-OK (status: escalated).'],
      }),
    ]);
    expect(rows[0]).toMatchObject({
      closedBy: 'operator-override',
      machineVerdict: 'hold',
      machineReason: 'mechanical-blockers',
      overrideRationale: 'known carry-forward defect',
      blockers: ['Task "epic-1/task-1" is not terminal-OK (status: escalated).'],
    });
  });

  it('takes the last close for an epic when it is closed more than once', () => {
    const rows = foldEpics([
      closeEvent({ closed_by: 'operator-override', machine_verdict: 'hold' }, 'e1'),
      closeEvent({ closed_by: 'verdict', machine_verdict: 'go' }, 'e2'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ closedBy: 'verdict', machineVerdict: 'go', eventId: 'e2' });
  });

  it('ignores a close with no epic_id rather than inventing one from task_id', () => {
    expect(foldEpics([closeEvent({ epic_id: undefined })])).toHaveLength(0);
  });

  // The real dogfood close (dogfood-envkit-1#69) was hand-written with
  // `envkit-config-loader/epic` as its task_id — an unreserved suffix. The
  // punch list keeps it that way on purpose, as a fixture. foldEpics reads
  // epic_id and never touches task_id, so the wrong id costs nothing here;
  // foldTasks must still refuse to mint a card for it.
  it('folds the real dogfood close, whose task_id is deliberately wrong', () => {
    const dogfood = event({
      event_id: 'dogfood-envkit-1#69',
      event_type: 'epic-closed',
      task_id: 'envkit-config-loader/epic',
      actor: 'operator',
      payload: {
        epic_id: 'envkit-config-loader',
        closed_by: 'operator-override',
        machine_verdict: 'hold',
        machine_reason: 'mechanical-blockers',
        override_rationale: 'Mechanical blockers are carry-forward defects, not shipping blockers.',
      },
    });

    const epics = foldEpics([dogfood]);
    expect(epics).toHaveLength(1);
    expect(epics[0]).toMatchObject({
      epicId: 'envkit-config-loader',
      epicStatus: 'closed',
      closedBy: 'operator-override',
      blockers: [],
    });

    expect(foldTasks([dogfood])).toEqual([]);
  });
});

// D-250. A task id the log only ever spells bare, with no `task-added` and no
// payload `epic_id` anywhere, cannot be attached to its epic from the event
// stream alone -- `buildTaskIdAliases` has nothing to match it against. It
// folds to its own epic-less, project-less row, so the project-scoped kanban
// (which filters on `project`) never draws it: in the shipped dogfood state
// `envkit-config-loader/task-4-api` is one of six plan tasks and only five
// cards reach the envkit board. The plan file the projector already loads for
// D-246's project backfill names the sixth.
describe('foldTasks — a bare id the log never qualifies (D-250)', () => {
  let specsDir: string;

  beforeEach(async () => {
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-fold-roster-'));
  });
  afterEach(async () => {
    await rm(specsDir, { recursive: true, force: true });
  });

  /** A plan file on disk, the way `plan ingest` would have left it. */
  async function writeRoster(epicId: string, taskIds: readonly string[]): Promise<void> {
    await mkdir(path.join(specsDir, epicId), { recursive: true });
    await writeFile(
      path.join(specsDir, epicId, 'plan-v1.json'),
      JSON.stringify({
        epic_id: epicId,
        version: 1,
        status: 'endorsed',
        tasks: taskIds.map((task_id) => ({ task_id })),
        edges: [],
      }),
      'utf8',
    );
  }

  /** The epic is asserted by a sibling task; the orphan carries nothing at all. */
  function orphanLog(): StoredEvent[] {
    return [
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'epic-a/task-0',
        payload: { epic_id: 'epic-a' },
        ts: '2026-08-01T00:00:00.000Z',
      }),
      event({
        event_id: 'e2',
        event_type: 'gate-outcome',
        task_id: 'task-4-api',
        payload: { gate: 'test', verdict: 'pass' },
        ts: '2026-08-01T00:01:00.000Z',
      }),
    ];
  }

  it('resolves it against the plan roster of an epic the log asserts', async () => {
    await writeRoster('epic-a', ['epic-a/task-0', 'epic-a/task-4-api']);

    const rows = foldTasks(orphanLog(), { specsDir }).map((r) => ({
      taskId: r.taskId,
      epicId: r.epicId,
    }));

    expect(rows).toEqual([
      { taskId: 'epic-a/task-0', epicId: 'epic-a' },
      { taskId: 'epic-a/task-4-api', epicId: 'epic-a' },
    ]);
  });

  it('leaves it bare when no roster claims it', async () => {
    await writeRoster('epic-a', ['epic-a/task-0']);

    const rows = foldTasks(orphanLog(), { specsDir }).map((r) => r.taskId);

    // Inventing an epic for it would be a guess; it stays its own row and
    // stays visible as the orphan it is.
    expect(rows).toEqual(['epic-a/task-0', 'task-4-api']);
  });

  it('leaves it bare when two rosters both claim it', async () => {
    await writeRoster('epic-a', ['epic-a/task-0', 'epic-a/task-4-api']);
    await writeRoster('epic-b', ['epic-b/task-1', 'epic-b/task-4-api']);

    const events = [
      ...orphanLog(),
      event({
        event_id: 'e3',
        event_type: 'task-added',
        task_id: 'epic-b/task-1',
        payload: { epic_id: 'epic-b' },
        ts: '2026-08-01T00:02:00.000Z',
      }),
    ];

    expect(foldTasks(events, { specsDir }).map((r) => r.taskId)).toEqual([
      'epic-a/task-0',
      'task-4-api',
      'epic-b/task-1',
    ]);
  });

  it('lets what the log asserts win over what a roster says', async () => {
    // Same precedence as D-246's project backfill: the plan is a fallback and
    // never an override. `epic-b`'s roster claims the id, but `epic-a`'s
    // `wave-admitted` names it beside its own epic -- the log wins.
    await writeRoster('epic-b', ['epic-b/task-4-api']);

    const events = [
      ...orphanLog(),
      event({
        event_id: 'e3',
        event_type: 'task-added',
        task_id: 'epic-b/task-1',
        payload: { epic_id: 'epic-b' },
        ts: '2026-08-01T00:02:00.000Z',
      }),
      event({
        event_id: 'e4',
        event_type: 'wave-admitted',
        payload: { epic_id: 'epic-a', task_ids: ['task-4-api'] },
        ts: '2026-08-01T00:03:00.000Z',
      }),
    ];

    expect(foldTasks(events, { specsDir }).map((r) => r.taskId)).toEqual([
      'epic-a/task-0',
      'epic-a/task-4-api',
      'epic-b/task-1',
    ]);
  });

  it('ignores a roster entry that is itself unqualified', async () => {
    // A hand-edited plan that spells one task both ways is not two rivals
    // claiming the id — the unqualified entry says nothing the bare id did
    // not already say, and must not stall the resolution as an ambiguity.
    await writeRoster('epic-a', ['epic-a/task-0', 'task-4-api', 'epic-a/task-4-api']);

    expect(foldTasks(orphanLog(), { specsDir }).map((r) => r.taskId)).toEqual([
      'epic-a/task-0',
      'epic-a/task-4-api',
    ]);
  });

  it('survives an epic with no plan directory at all', () => {
    // A spec dir that was never ingested must cost the projection nothing.
    expect(foldTasks(orphanLog(), { specsDir }).map((r) => r.taskId)).toEqual([
      'epic-a/task-0',
      'task-4-api',
    ]);
  });
});

// D-251. `error-logged` is the one event that names its subject in
// `payload.task_ref`, and twice in the shipped dogfood state that ref is the
// EPIC's own id, not a task under it. `touch()`'s guard enumerates only two
// non-task ref shapes -- `<epic>/integration` and `<epic>/plan-v<n>` -- so a
// bare epic id walks straight through it and mints a kanban card named after
// the epic, exactly the phantom `foldEpics` keeps itself off the task fold to
// avoid. The `errors` row is inserted independently of the task row, so
// refusing the card loses nothing.
describe('foldTasks — an error logged against the epic itself (D-251)', () => {
  function log(taskRef: string): StoredEvent[] {
    return [
      event({
        event_id: 'e1',
        event_type: 'task-added',
        task_id: 'demo-rpg-story-engine/task-1',
        payload: { epic_id: 'demo-rpg-story-engine' },
        ts: '2026-08-01T00:00:00.000Z',
      }),
      event({
        event_id: 'e2',
        event_type: 'error-logged',
        payload: {
          task_ref: taskRef,
          error: 'contract.schema-violation',
          severity: 'S2',
        },
        ts: '2026-08-01T00:01:00.000Z',
      }),
    ];
  }

  it('mints no card for a ref that names an epic the log asserts', () => {
    expect(foldTasks(log('demo-rpg-story-engine')).map((r) => r.taskId)).toEqual([
      'demo-rpg-story-engine/task-1',
    ]);
  });

  it('mints no card for an epic the log only ever names in a payload', () => {
    // `epic-closed` carries `epic_id` and no task id at all, so the epic set
    // cannot be read off task-id assertions alone.
    const events = [
      event({
        event_id: 'e1',
        event_type: 'epic-closed',
        payload: { epic_id: 'demo-rpg-story-engine' },
        ts: '2026-08-01T00:00:00.000Z',
      }),
      event({
        event_id: 'e2',
        event_type: 'error-logged',
        payload: {
          task_ref: 'demo-rpg-story-engine',
          error: 'contract.schema-violation',
          severity: 'S2',
        },
        ts: '2026-08-01T00:01:00.000Z',
      }),
    ];

    expect(foldTasks(events)).toEqual([]);
  });

  it('still blocks a real task under that same epic', () => {
    const rows = foldTasks(log('demo-rpg-story-engine/task-1'));
    expect(rows.map((r) => ({ taskId: r.taskId, taskStatus: r.taskStatus }))).toEqual([
      { taskId: 'demo-rpg-story-engine/task-1', taskStatus: 'blocked' },
    ]);
  });

  it("still folds a bare ref that is nobody's epic id", () => {
    // The guard is "this id IS an epic", not "this id is bare" -- an ordinary
    // unqualified task ref must keep its row.
    expect(foldTasks(log('task-7')).map((r) => r.taskId)).toEqual([
      'demo-rpg-story-engine/task-1',
      'task-7',
    ]);
  });
});
