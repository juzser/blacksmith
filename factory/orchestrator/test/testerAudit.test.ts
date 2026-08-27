import { describe, expect, it } from 'vitest';
import type { RoleIsolationPair } from '../src/crosscheck.js';
import type { StoredEvent } from '../src/events.js';
import { checkTesterIsolation, readTerminalRoleRecords } from '../src/testerAudit.js';

// ---------------------------------------------------------------------------
// The other half of "a worker never grades its own work". `finder_ne_critic`
// (dispatchAudit.ts) compares MODELS, which is the wrong question for a
// tester: it may legitimately run on the coder's model, and what it may not
// do is run in the coder's turn. The only evidence of a separate turn the log
// can hold is a separate `dispatch_decision` — no role template grants
// `Agent`, so a dispatch is written by the orchestrator once per agent it
// invokes, never by the agent about itself.
// ---------------------------------------------------------------------------

const PAIRS: RoleIsolationPair[] = [{ worker: 'coder', auditor: 'tester' }];

let seq = 0;

function at(n: number): string {
  return `2026-08-08T10:${String(n).padStart(2, '0')}:00.000Z`;
}

function dispatch(
  role: string,
  overrides: {
    taskId?: string | null;
    payloadTaskId?: string;
    ts?: string;
    agentId?: string;
  } = {},
): StoredEvent {
  const n = seq++;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'dispatch_decision',
      ...(overrides.taskId === null ? {} : { task_id: overrides.taskId ?? 'T-1' }),
      ...(overrides.agentId === undefined ? {} : { agent_id: overrides.agentId }),
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: overrides.ts ?? at(n),
      payload: {
        agent_role: role,
        provider: 'claude',
        model_tier: 'frontier',
        model: 'claude-opus-5',
        ...(overrides.payloadTaskId === undefined ? {} : { task_id: overrides.payloadTaskId }),
      },
    },
  };
}

function result(role: string, overrides: { taskId?: string; ts?: string } = {}): StoredEvent {
  const n = seq++;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: role,
      event_type: 'task-result-recorded',
      task_id: overrides.taskId ?? 'T-1',
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: overrides.ts ?? at(n),
      payload: { agent: role, run_status: 'done' },
    },
  };
}

function testgate(
  overrides: { taskId?: string | null; ts?: string; results?: unknown; pass?: boolean } = {},
): StoredEvent {
  const n = seq++;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'system',
      event_type: 'testgate-result',
      ...(overrides.taskId === null ? {} : { task_id: overrides.taskId ?? 'T-1' }),
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: overrides.ts ?? at(n),
      payload: {
        pass: overrides.pass ?? true,
        results:
          overrides.results === undefined
            ? [{ name: 'unit', pass: true, exitCode: 0 }]
            : overrides.results,
      },
    },
  };
}

/** The whole clean sequence: coder, tester, tester reports, gate runs. */
function isolatedRun(taskId = 'T-1'): StoredEvent[] {
  return [
    dispatch('coder', { taskId }),
    dispatch('tester', { taskId }),
    result('tester', { taskId }),
    testgate({ taskId }),
  ];
}

function run(events: StoredEvent[], taskId?: string) {
  return checkTesterIsolation(events, PAIRS, {
    sessionId: 'sess-1',
    ...(taskId === undefined ? {} : { taskId }),
  });
}

describe('checkTesterIsolation', () => {
  it('passes a task whose tests were dispatched to a tester of their own', () => {
    const report = run(isolatedRun());
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe('ok');
    expect(report.checks[0]?.taskId).toBe('T-1');
    expect(report.gatesExamined).toBe(1);
  });

  it('reports a violation when no tester was ever dispatched', () => {
    const report = run([dispatch('coder'), result('coder'), testgate()]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('violation');
    expect(report.checks[0]?.auditorEventId).toBeNull();
    expect(report.checks[0]?.detail).toContain('tester');
  });

  it('names the gate event the violation is about', () => {
    const gate = testgate();
    const report = run([dispatch('coder'), gate]);
    expect(report.checks[0]?.gateEventId).toBe(gate.event_id);
  });

  it('reports a violation when the tester was dispatched only after the gate ran', () => {
    const events = [dispatch('coder'), testgate(), dispatch('tester')];
    const report = run(events);
    expect(report.checks[0]?.status).toBe('violation');
  });

  it('counts the test checks the gate actually ran', () => {
    const report = run(isolatedRun());
    expect(report.checks[0]?.checksRun).toBe(1);
  });

  it('is not applicable when the gate ran no test checks at all', () => {
    const report = run([dispatch('coder'), testgate({ results: [] })]);
    expect(report.ok).toBe(true);
    expect(report.checks[0]?.status).toBe('not-applicable');
    expect(report.checks[0]?.checksRun).toBe(0);
  });

  it('is unverifiable when the gate payload names no result list', () => {
    const report = run([dispatch('coder'), testgate({ results: 'green' })]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('unverifiable');
  });

  it('is unverifiable when the test gate carries no task id', () => {
    const report = run([dispatch('coder'), testgate({ taskId: null })]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('unverifiable');
  });

  it('is unverifiable when a tester ran but the log names no coder before it', () => {
    const report = run([dispatch('tester'), result('tester'), testgate()]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.checks[0]?.workerEventId).toBeNull();
  });

  it('is unverifiable when the tester was dispatched and never reported', () => {
    const report = run([dispatch('coder'), dispatch('tester'), testgate()]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.checks[0]?.detail).toContain('never reported');
  });

  it('accepts an error-logged as the tester having reported', () => {
    // Built after the dispatches on purpose: a terminal event only reports
    // for a dispatch that preceded it, and `seq` is what orders these.
    const coder = dispatch('coder');
    const tester = dispatch('tester');
    const n = seq++;
    const errored: StoredEvent = {
      event_id: `sess-1#${n}`,
      record: {
        session_id: 'sess-1',
        actor: 'tester',
        event_type: 'error-logged',
        task_id: 'T-1',
        plan_version: 1,
        causal_parent: 'sess-1#0',
        ts: at(n),
        payload: { agent: 'tester', error: 'timeout', severity: 'S2' },
      },
    };
    const report = run([coder, tester, errored, testgate()]);
    expect(report.checks[0]?.status).toBe('ok');
  });

  it('refuses a coder and a tester logged under one agent id', () => {
    const events = [
      dispatch('coder', { agentId: 'agent-7' }),
      dispatch('tester', { agentId: 'agent-7' }),
      result('tester'),
      testgate(),
    ];
    const report = run(events);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('violation');
    expect(report.checks[0]?.detail).toContain('agent-7');
  });

  it('accepts distinct agent ids', () => {
    const events = [
      dispatch('coder', { agentId: 'agent-7' }),
      dispatch('tester', { agentId: 'agent-8' }),
      result('tester'),
      testgate(),
    ];
    expect(run(events).ok).toBe(true);
  });

  it('does not demand an agent id neither dispatch carries', () => {
    expect(run(isolatedRun()).ok).toBe(true);
  });

  // D-181: the log writes one task both qualified and bare.
  it('pairs a bare task id with its qualified spelling', () => {
    const events = [
      dispatch('coder', { taskId: 'epic-1/T-1' }),
      dispatch('tester', { taskId: 'T-1' }),
      result('tester', { taskId: 'epic-1/T-1' }),
      testgate({ taskId: 'epic-1/T-1' }),
    ];
    expect(run(events).ok).toBe(true);
  });

  it('reads a task id the dispatcher put in the payload instead', () => {
    const events = [
      dispatch('coder', { taskId: null, payloadTaskId: 'T-1' }),
      dispatch('tester', { taskId: null, payloadTaskId: 'T-1' }),
      result('tester'),
      testgate(),
    ];
    expect(run(events).ok).toBe(true);
  });

  it('does not let another task’s tester answer for this one', () => {
    const events = [
      dispatch('coder', { taskId: 'T-1' }),
      dispatch('tester', { taskId: 'T-2' }),
      result('tester', { taskId: 'T-2' }),
      testgate({ taskId: 'T-1' }),
    ];
    expect(run(events).checks[0]?.status).toBe('violation');
  });

  it('raises one check per gate, in log order', () => {
    const events = [...isolatedRun('T-1'), ...isolatedRun('T-2')];
    const report = run(events);
    expect(report.checks.map((c) => c.taskId)).toEqual(['T-1', 'T-2']);
    expect(report.gatesExamined).toBe(2);
  });

  it('re-gating a task checks the later gate on its own evidence', () => {
    const events = [
      dispatch('coder', { taskId: 'T-1' }),
      dispatch('tester', { taskId: 'T-1' }),
      result('tester', { taskId: 'T-1' }),
      testgate({ taskId: 'T-1' }),
      testgate({ taskId: 'T-1' }),
    ];
    const report = run(events);
    expect(report.checks).toHaveLength(2);
    expect(report.ok).toBe(true);
  });

  it('scopes to one task when asked, and ignores the others', () => {
    const events = [
      ...isolatedRun('T-1'),
      dispatch('coder', { taskId: 'T-2' }),
      testgate({ taskId: 'T-2' }),
    ];
    const report = run(events, 'T-1');
    expect(report.checks).toHaveLength(1);
    expect(report.ok).toBe(true);
    expect(report.taskId).toBe('T-1');
  });

  it('answers an empty pair list with one unverifiable check', () => {
    const report = checkTesterIsolation(isolatedRun(), [], { sessionId: 'sess-1' });
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe('unverifiable');
  });

  it('answers a log with no test gate at all with one unverifiable check', () => {
    const report = run([dispatch('coder'), result('coder')]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe('unverifiable');
    expect(report.gatesExamined).toBe(0);
  });

  it('counts the dispatches it read', () => {
    const report = run(isolatedRun());
    expect(report.dispatchesExamined).toBe(2);
  });

  it('echoes the session it was asked about', () => {
    expect(run(isolatedRun()).sessionId).toBe('sess-1');
  });
});

describe('readTerminalRoleRecords', () => {
  it('reads the role off a task result’s payload', () => {
    const records = readTerminalRoleRecords([result('tester')]);
    expect(records).toHaveLength(1);
    expect(records[0]?.role).toBe('tester');
  });

  it('falls back to the actor when the payload names no role', () => {
    const n = seq++;
    const bare: StoredEvent = {
      event_id: `sess-1#${n}`,
      record: {
        session_id: 'sess-1',
        actor: 'tester',
        event_type: 'task-result-recorded',
        task_id: 'T-1',
        plan_version: 1,
        causal_parent: 'sess-1#0',
        ts: at(n),
        payload: { run_status: 'done' },
      },
    };
    expect(readTerminalRoleRecords([bare])[0]?.role).toBe('tester');
  });

  it('ignores events that are not terminal', () => {
    expect(readTerminalRoleRecords([dispatch('tester'), testgate()])).toEqual([]);
  });
});
