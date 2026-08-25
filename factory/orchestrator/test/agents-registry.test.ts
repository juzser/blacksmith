import { describe, expect, it } from 'vitest';
import { detectStale, foldAgents, liveAgents } from '../src/agents-registry.js';
import type { EventRecord, StoredEvent } from '../src/events.js';

function event(overrides: Partial<EventRecord> & { event_id: string }): StoredEvent {
  const { event_id, ...record } = overrides;
  return {
    event_id,
    record: {
      session_id: 'sess-1',
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

function dispatch(
  eventId: string,
  taskId: string,
  ts: string,
  overrides: Record<string, unknown> = {},
): StoredEvent {
  return event({
    event_id: eventId,
    event_type: 'dispatch_decision',
    task_id: taskId,
    ts,
    payload: {
      agent_role: 'coder',
      provider: 'claude',
      model_tier: 'mid',
      model: 'claude-sonnet-5',
      ...overrides,
    },
  });
}

function result(eventId: string, taskId: string, ts: string): StoredEvent {
  return event({
    event_id: eventId,
    event_type: 'task-result-recorded',
    task_id: taskId,
    ts,
    payload: { task_id: taskId, run_status: 'done' },
  });
}

function errorLogged(eventId: string, taskId: string, ts: string): StoredEvent {
  return event({
    event_id: eventId,
    event_type: 'error-logged',
    task_id: taskId,
    ts,
    payload: { error: 'execution.test-failure', severity: 'S2-major', task_ref: taskId },
  });
}

function epicClosed(
  eventId: string,
  epicId: string,
  ts: string,
  overrides: Partial<EventRecord> = {},
): StoredEvent {
  return event({
    event_id: eventId,
    event_type: 'epic-closed',
    task_id: `${epicId}/epic`,
    ts,
    payload: { epic_id: epicId, closed_by: 'verdict', machine_verdict: 'go', blockers: [] },
    ...overrides,
  });
}

describe('agents-registry.ts', () => {
  // D-234. A planner, a spec-reviewer, a tester and a scribe are dispatched
  // for the epic, not for one task, so their dispatch carries `epic_id` and no
  // `task_id` -- and the fold dropped that field on the floor. Half of every
  // live agent in the real state/smith.db is one of these, and with no scope
  // at all recorded the Overview could only render them as "no task assigned"
  // and the project filter could only drop them.
  describe('epic scope (D-234)', () => {
    function epicDispatch(eventId: string, epicId: string, ts: string, role = 'planner') {
      return event({
        event_id: eventId,
        event_type: 'dispatch_decision',
        ts,
        payload: {
          agent_role: role,
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          epic_id: epicId,
        },
      });
    }

    it('keeps the epic an epic-level dispatch names', () => {
      const [agent] = foldAgents([epicDispatch('e1', 'epic-1', '2026-08-01T00:00:00.000Z')]);
      expect(agent).toMatchObject({ taskId: null, epicId: 'epic-1', status: 'live' });
    });

    // A task-scoped dispatch names no epic either, but its task id spells one.
    it("derives a task-scoped agent's epic from its task id", () => {
      const [agent] = foldAgents([dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z')]);
      expect(agent?.epicId).toBe('epic-1');
    });

    // Nothing places a bare task id in an epic, and guessing is what the id
    // rules exist to prevent (D-130).
    it('leaves the epic null when the task id is bare', () => {
      const [agent] = foldAgents([dispatch('e1', 'task-1', '2026-08-01T00:00:00.000Z')]);
      expect(agent?.epicId).toBeNull();
    });

    // The close used to sweep every epic-level agent in the session, on the
    // reasoning that one with no task id "belongs to the run by definition".
    // One session runs several epics in a row: the next epic's planner was
    // already dispatched, and this verdict has nothing to say about it.
    it("does not abandon another epic's epic-level agent", () => {
      const agents = foldAgents([
        epicDispatch('e1', 'epic-1', '2026-08-01T00:00:00.000Z'),
        epicDispatch('e2', 'epic-2', '2026-08-01T00:05:00.000Z'),
        epicClosed('e3', 'epic-1', '2026-08-01T00:10:00.000Z'),
      ]);
      expect(agents.map((a) => [a.id, a.status])).toEqual([
        ['e1', 'abandoned'],
        ['e2', 'live'],
      ]);
    });
  });

  // D-245. A task id is written in two places. Every machine producer stamps
  // the envelope's `task_id`; the hand-written dispatch the operator skill
  // documents puts it in the payload, because the skill lists the payload's
  // four fields and never says where the task id goes. 29 dispatches across
  // two real sessions carry only the payload one, and this fold read only the
  // envelope: each opened as an epic-level agent that no task-scoped terminal
  // event could reach, so it read "no task assigned" for the length of the
  // run and was swept `abandoned` by the epic verdict. budgetAlarm.ts and
  // dispatchAudit.ts had each already found this and fixed it privately.
  describe('a task id written only in the payload (D-245)', () => {
    function payloadDispatch(
      eventId: string,
      taskId: string,
      ts: string,
      role = 'coder',
    ): StoredEvent {
      return event({
        event_id: eventId,
        event_type: 'dispatch_decision',
        ts,
        payload: {
          agent_role: role,
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
          epic_id: 'epic-1',
          task_id: taskId,
        },
      });
    }

    it('scopes the agent to the task its payload names', () => {
      const [agent] = foldAgents([
        payloadDispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      ]);
      expect(agent).toMatchObject({
        taskId: 'epic-1/task-1',
        epicId: 'epic-1',
        status: 'live',
      });
    });

    it("closes on the task's own terminal event instead of running to the verdict", () => {
      const agents = foldAgents([
        payloadDispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
        result('e2', 'epic-1/task-1', '2026-08-01T00:10:00.000Z'),
        epicClosed('e3', 'epic-1', '2026-08-01T01:00:00.000Z'),
      ]);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        status: 'done',
        terminalEventId: 'e2',
        terminalType: 'result',
      });
    });

    it('supersedes the open row when the same role is redispatched for that task', () => {
      const agents = foldAgents([
        payloadDispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
        payloadDispatch('e2', 'epic-1/task-1', '2026-08-01T00:05:00.000Z'),
      ]);
      expect(agents.map((a) => [a.id, a.status])).toEqual([
        ['e1', 'superseded'],
        ['e2', 'live'],
      ]);
    });

    // The envelope is what every projector keys on, so it decides; a payload
    // that disagrees is a producer bug, not a second opinion (the rule
    // foldTasks already applies to `task-added`'s epic_id).
    it('reads the envelope first when both name a task', () => {
      const [agent] = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', {
          task_id: 'epic-9/task-9',
        }),
      ]);
      expect(agent?.taskId).toBe('epic-1/task-1');
    });

    // D-234's epic-level agents must stay epic-level: a payload with no task
    // id names no task, and an empty string names none either (D-244).
    it('leaves a dispatch with no task id in either place epic-level', () => {
      const agents = foldAgents([
        event({
          event_id: 'e1',
          event_type: 'dispatch_decision',
          ts: '2026-08-01T00:00:00.000Z',
          payload: {
            agent_role: 'planner',
            provider: 'claude',
            model_tier: 'mid',
            model: 'claude-sonnet-5',
            epic_id: 'epic-1',
            task_id: '',
          },
        }),
      ]);
      expect(agents[0]).toMatchObject({ taskId: null, epicId: 'epic-1' });
    });
  });

  it('opens a live agent on dispatch_decision and closes it on task-result-recorded', () => {
    const events = [
      dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      result('e2', 'epic-1/task-1', '2026-08-01T00:10:00.000Z'),
    ];
    const agents = foldAgents(events);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: 'e1',
      taskId: 'epic-1/task-1',
      status: 'done',
      terminalEventId: 'e2',
      terminalType: 'result',
    });
    expect(liveAgents(agents)).toHaveLength(0);
  });

  it('closes with status "error" on error-logged for the same task', () => {
    const events = [
      dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      errorLogged('e2', 'epic-1/task-1', '2026-08-01T00:05:00.000Z'),
    ];
    const agents = foldAgents(events);
    expect(agents[0]).toMatchObject({
      status: 'error',
      terminalType: 'error',
      terminalEventId: 'e2',
    });
  });

  it('leaves an agent live when no terminal event follows', () => {
    const events = [dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z')];
    const agents = foldAgents(events);
    expect(agents[0]?.status).toBe('live');
    expect(liveAgents(agents)).toHaveLength(1);
  });

  it('opens a fresh live entry for a retry after a task closes and redispatches', () => {
    const events = [
      dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      errorLogged('e2', 'epic-1/task-1', '2026-08-01T00:05:00.000Z'),
      dispatch('e3', 'epic-1/task-1', '2026-08-01T00:10:00.000Z'),
    ];
    const agents = foldAgents(events);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ id: 'e1', status: 'error' });
    expect(agents[1]).toMatchObject({ id: 'e3', status: 'live' });
  });

  it('supersedes a still-open dispatch when a second dispatch_decision lands on the same task_id before any terminal event (reviewer finding: prior bug orphaned the first row at "live" forever)', () => {
    const events = [
      dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      dispatch('e2', 'epic-1/task-1', '2026-08-01T00:05:00.000Z'), // redispatch, no terminal seen for e1
    ];
    const agents = foldAgents(events);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      id: 'e1',
      status: 'superseded',
      terminalType: 'superseded',
      terminalEventId: 'e2',
    });
    expect(agents[1]).toMatchObject({ id: 'e2', status: 'live' });

    // Exactly one live row after the redispatch...
    expect(liveAgents(agents)).toHaveLength(1);
    expect(liveAgents(agents)[0]?.id).toBe('e2');

    // ...and zero once the redispatch's own terminal event lands.
    const withResult = foldAgents([
      ...events,
      result('e3', 'epic-1/task-1', '2026-08-01T00:10:00.000Z'),
    ]);
    expect(liveAgents(withResult)).toHaveLength(0);
    expect(withResult).toHaveLength(2); // the fold never mutates/removes the superseded row
    expect(withResult[0]).toMatchObject({ id: 'e1', status: 'superseded' });
    expect(withResult[1]).toMatchObject({ id: 'e2', status: 'done', terminalEventId: 'e3' });
  });

  // D-23/P9-12. `/bs run` deliberately runs coder, grader, reviewer and
  // security-reviewer against ONE task. Keyed on task_id alone, the second
  // dispatch superseded the first, the third superseded the second, and the
  // fourth stayed live forever — three agents that finished were recorded as
  // abandoned, and one that was abandoned was recorded as running.
  // D-244. `task_id: ""` is a third state the fold never decided about. The
  // event schema accepts an empty string as a *present* field, and two
  // adjacent lines here then disagreed about what it meant: the record kept
  // `taskId: ''` while the open-agent bookkeeping filed the same dispatch as
  // task-less. Every task-scoped terminal branch is guarded on the task id, so
  // such an agent can never be closed by its own result -- one real coder
  // dispatch has been `live` for days in state/smith.db because of it.
  describe('the empty task id (D-244)', () => {
    it('reads an empty task id as no task, not as a task named ""', () => {
      const [agent] = foldAgents([dispatch('e1', '', '2026-08-01T00:00:00.000Z')]);
      expect(agent?.taskId).toBeNull();
    });

    // The dispatch still names its epic in the payload, so the agent keeps the
    // scope D-234 gave it even though its task id is unusable.
    it('keeps the epic the payload names when the task id is empty', () => {
      const [agent] = foldAgents([
        dispatch('e1', '', '2026-08-01T00:00:00.000Z', { epic_id: 'epic-1' }),
      ]);
      expect(agent).toMatchObject({ taskId: null, epicId: 'epic-1', status: 'live' });
    });

    // An empty string names no task, so it opens no per-task slot: a second
    // dispatch of the same role is another epic-level agent, not a
    // supersession of the first.
    it('does not supersede another empty-task-id dispatch of the same role', () => {
      const agents = foldAgents([
        dispatch('e1', '', '2026-08-01T00:00:00.000Z'),
        dispatch('e2', '', '2026-08-01T00:05:00.000Z'),
      ]);
      expect(agents.map((a) => a.status)).toEqual(['live', 'live']);
    });
  });

  describe('one task, several roles (D-23 / P9-12)', () => {
    it('keeps a concurrent coder and reviewer on the same task both live', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', { agent_role: 'coder' }),
        dispatch('e2', 'epic-1/task-1', '2026-08-01T00:01:00.000Z', { agent_role: 'reviewer' }),
      ]);
      expect(agents).toHaveLength(2);
      expect(liveAgents(agents)).toHaveLength(2);
      expect(agents.map((a) => a.status)).toEqual(['live', 'live']);
    });

    it('closes only the role its Result names', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', { agent_role: 'coder' }),
        dispatch('e2', 'epic-1/task-1', '2026-08-01T00:01:00.000Z', { agent_role: 'reviewer' }),
        event({
          event_id: 'e3',
          event_type: 'task-result-recorded',
          task_id: 'epic-1/task-1',
          ts: '2026-08-01T00:05:00.000Z',
          payload: { task_id: 'epic-1/task-1', run_status: 'done', agent: 'coder' },
        }),
      ]);
      expect(agents[0]).toMatchObject({
        agentRole: 'coder',
        status: 'done',
        terminalEventId: 'e3',
      });
      expect(agents[1]).toMatchObject({ agentRole: 'reviewer', status: 'live' });
    });

    it('closes a judge on its judge-reported (P9-11), not on the coder’s Result', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', {
          agent_role: 'security-reviewer',
          round: 2,
        }),
        event({
          event_id: 'e2',
          event_type: 'judge-reported',
          task_id: 'epic-1/task-1',
          ts: '2026-08-01T00:09:00.000Z',
          payload: { task_id: 'epic-1/task-1', agent_role: 'security-reviewer', round: 2 },
        }),
      ]);
      expect(agents[0]).toMatchObject({
        agentRole: 'security-reviewer',
        round: 2,
        status: 'done',
        terminalType: 'result',
        terminalEventId: 'e2',
      });
    });

    it('carries the dispatch round, defaulting to 1 for a worker that has none', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
        dispatch('e2', 'epic-1/task-2', '2026-08-01T00:00:00.000Z', {
          agent_role: 'grader',
          round: 3,
        }),
      ]);
      expect(agents[0]?.round).toBe(1);
      expect(agents[1]?.round).toBe(3);
    });

    it('supersedes on a same-role redispatch, whatever round it claims', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', {
          agent_role: 'security-reviewer',
          round: 1,
        }),
        dispatch('e2', 'epic-1/task-1', '2026-08-01T00:05:00.000Z', {
          agent_role: 'security-reviewer',
          round: 2,
        }),
      ]);
      expect(agents[0]).toMatchObject({ round: 1, status: 'superseded', terminalEventId: 'e2' });
      expect(agents[1]).toMatchObject({ round: 2, status: 'live' });
    });

    it('closes only the named role on a role-scoped error, and everything open on a task-scoped one', () => {
      const roleScoped = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', { agent_role: 'coder' }),
        dispatch('e2', 'epic-1/task-1', '2026-08-01T00:01:00.000Z', { agent_role: 'reviewer' }),
        event({
          event_id: 'e3',
          event_type: 'error-logged',
          task_id: 'epic-1/task-1',
          ts: '2026-08-01T00:05:00.000Z',
          payload: {
            error: 'execution.timeout',
            severity: 'S2-major',
            task_ref: 'epic-1/task-1',
            agent_role: 'reviewer',
          },
        }),
      ]);
      expect(roleScoped[0]).toMatchObject({ agentRole: 'coder', status: 'live' });
      expect(roleScoped[1]).toMatchObject({ agentRole: 'reviewer', status: 'error' });

      // No role on the payload means the queue or the gate blocked the whole
      // task — nobody is still running under it, so nobody stays live.
      const taskScoped = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', { agent_role: 'coder' }),
        dispatch('e2', 'epic-1/task-1', '2026-08-01T00:01:00.000Z', { agent_role: 'reviewer' }),
        errorLogged('e3', 'epic-1/task-1', '2026-08-01T00:05:00.000Z'),
      ]);
      expect(liveAgents(taskScoped)).toHaveLength(0);
      expect(taskScoped.map((a) => a.status)).toEqual(['error', 'error']);
    });
  });

  // D-160. A cross-provider judge is dispatched like any other agent —
  // recordJudgeRun writes a real `dispatch_decision` precisely so it lands in
  // this registry (architecture §7) — but its return is a `judge-verdict`,
  // which was not a terminal event here. So the call that came back in eight
  // seconds stayed `live` forever, and a second provider's dispatch closed the
  // first as `superseded`: two judges that both answered, recorded as one
  // abandoned and one still running.
  describe('the cross-provider judge (D-160)', () => {
    function verdict(
      eventId: string,
      taskId: string,
      ts: string,
      overrides: Record<string, unknown> = {},
    ): StoredEvent {
      return event({
        event_id: eventId,
        event_type: 'judge-verdict',
        task_id: taskId,
        ts,
        payload: {
          task_id: taskId,
          agent: 'verifier',
          provider: 'codex',
          model_tier: 'frontier',
          ok: true,
          verdict: 'confirm',
          schema_failure: false,
          ...overrides,
        },
      });
    }

    it('closes the judge that answered', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', {
          agent_role: 'verifier',
          provider: 'codex',
        }),
        verdict('e2', 'epic-1/task-1', '2026-08-01T00:00:08.000Z'),
      ]);
      expect(agents[0]).toMatchObject({
        agentRole: 'verifier',
        status: 'done',
        terminalType: 'result',
        terminalEventId: 'e2',
      });
      expect(liveAgents(agents)).toHaveLength(0);
    });

    // A provider that never produced a schema-valid verdict did not finish
    // its job, and the log says so in `ok`/`schema_failure`. Closing it as
    // `done` would let a silent 100% failure rate read as a clean quorum.
    it('closes a schema-failed run as an error, not a result', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', {
          agent_role: 'verifier',
          provider: 'codex',
        }),
        verdict('e2', 'epic-1/task-1', '2026-08-01T00:02:00.000Z', {
          ok: false,
          verdict: null,
          schema_failure: true,
        }),
      ]);
      expect(agents[0]).toMatchObject({ status: 'error', terminalType: 'error' });
    });

    // Every provider in one quorum shares a role — KIND_TO_AGENT maps the
    // kind, not the provider — so the second dispatch lands on the first's
    // (task, role) key. It may only supersede an entry that is genuinely
    // still open, which after its own verdict it is not.
    it('leaves two providers in one quorum both closed, neither superseded', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', {
          agent_role: 'verifier',
          provider: 'deepseek',
        }),
        verdict('e2', 'epic-1/task-1', '2026-08-01T00:00:08.000Z', { provider: 'deepseek' }),
        dispatch('e3', 'epic-1/task-1', '2026-08-01T00:00:09.000Z', {
          agent_role: 'verifier',
          provider: 'codex',
        }),
        verdict('e4', 'epic-1/task-1', '2026-08-01T00:00:17.000Z', { provider: 'codex' }),
      ]);
      expect(agents.map((a) => a.status)).toEqual(['done', 'done']);
      expect(detectStale(agents, '2026-08-01T09:00:00.000Z', 4)).toHaveLength(0);
    });
  });

  it('ignores a dispatch_decision missing required payload fields (should never happen post-schema-check, defensive)', () => {
    const events = [
      event({
        event_id: 'e1',
        event_type: 'dispatch_decision',
        task_id: 'epic-1/task-1',
        payload: { agent_role: 'coder' }, // missing provider/model_tier
      }),
    ];
    expect(foldAgents(events)).toHaveLength(0);
  });

  // D-187: the fold reads five event types and `epic-closed` is not one of
  // them, so the registry never learns that the run it is describing ended.
  // Every agent still open when the verdict landed stays `live` forever — and
  // an epic-level dispatch (`task_id` absent, which event.schema.json calls
  // out as legal: "absent for session-level or epic-level events") could never
  // have been closed by any of the five, because all five key on a task id.
  describe('the epic that closed (D-187)', () => {
    it('closes an agent still open under the epic that closed', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z', { agent_role: 'grader' }),
        epicClosed('e2', 'epic-1', '2026-08-01T01:00:00.000Z'),
      ]);
      expect(agents[0]).toMatchObject({
        status: 'abandoned',
        terminalType: 'abandoned',
        terminalEventId: 'e2',
        terminalAt: '2026-08-01T01:00:00.000Z',
      });
      expect(liveAgents(agents)).toEqual([]);
      expect(detectStale(agents, '2026-08-19T00:00:00.000Z', 4)).toEqual([]);
    });

    it('closes an epic-level dispatch, the one shape no other terminal can name', () => {
      const agents = foldAgents([
        event({
          event_id: 'e1',
          event_type: 'dispatch_decision',
          ts: '2026-08-01T00:00:00.000Z',
          payload: {
            agent_role: 'planner',
            provider: 'claude',
            model_tier: 'frontier',
            model: 'claude-opus-5',
          },
        }),
        epicClosed('e2', 'epic-1', '2026-08-01T01:00:00.000Z'),
      ]);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ taskId: null, agentRole: 'planner', status: 'abandoned' });
    });

    it('leaves an agent under a different epic alone', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-2/task-1', '2026-08-01T00:00:00.000Z'),
        epicClosed('e2', 'epic-1', '2026-08-01T01:00:00.000Z'),
      ]);
      expect(agents[0]).toMatchObject({ status: 'live', terminalEventId: null });
    });

    it("leaves another session's agent alone", () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
        epicClosed('e2', 'epic-1', '2026-08-01T01:00:00.000Z', { session_id: 'sess-2' }),
      ]);
      expect(agents[0]).toMatchObject({ status: 'live', terminalEventId: null });
    });

    it('does not re-stamp an agent that already reported', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
        result('e2', 'epic-1/task-1', '2026-08-01T00:30:00.000Z'),
        epicClosed('e3', 'epic-1', '2026-08-01T01:00:00.000Z'),
      ]);
      expect(agents[0]).toMatchObject({ status: 'done', terminalEventId: 'e2' });
    });
  });

  describe('detectStale', () => {
    it('flags a live agent whose dispatch is older than the threshold', () => {
      const agents = foldAgents([dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z')]);
      const stale = detectStale(agents, '2026-08-01T05:00:00.000Z', 4);
      expect(stale).toHaveLength(1);
      expect(stale[0]?.liveHours).toBeCloseTo(5, 5);
    });

    it('does not flag a live agent within the threshold', () => {
      const agents = foldAgents([dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z')]);
      const stale = detectStale(agents, '2026-08-01T02:00:00.000Z', 4);
      expect(stale).toHaveLength(0);
    });

    it('never flags an agent that already has a terminal event, however old', () => {
      const agents = foldAgents([
        dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z'),
        result('e2', 'epic-1/task-1', '2026-08-01T00:01:00.000Z'),
      ]);
      const stale = detectStale(agents, '2026-08-05T00:00:00.000Z', 4);
      expect(stale).toHaveLength(0);
    });

    it('uses the default stale-hours threshold when none is given', () => {
      const agents = foldAgents([dispatch('e1', 'epic-1/task-1', '2026-08-01T00:00:00.000Z')]);
      const stale = detectStale(agents, '2026-08-01T10:00:00.000Z');
      expect(stale).toHaveLength(1);
    });
  });
});
