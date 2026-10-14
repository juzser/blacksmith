// overview() cost: the dashboard polls it, so the work one call does must not
// grow with the number of projects, and runningSessions() must not read every
// event row. Proved by counts (fold runs, payload parses, rows read), never by
// timing.
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../src/agents-registry.js';
import {
  type DbHandle,
  openDb,
  projectSession,
  projectTasks,
  rebuild,
} from '../../src/db/projector.js';
import { overview, runningSessions } from '../../src/db/queries.js';
import type { StoredEvent } from '../../src/events.js';

vi.mock('../../src/agents-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agents-registry.js')>();
  return { ...actual, foldAgents: vi.fn(actual.foldAgents) };
});

const SESSION_ID = 'sess-cost-a';
const NOW = '2026-08-04T12:00:00.000Z';
const MIN = 60 * 1000;
const at = (minutesAgo: number): string =>
  new Date(Date.parse(NOW) - minutesAgo * MIN).toISOString();

/** Ten tasks, one epic each, spread round-robin over `projects`; the same events whatever the spread. */
function buildEvents(projects: string[]): StoredEvent[] {
  const events: StoredEvent[] = [];
  const push = (record: Partial<StoredEvent['record']> & { event_type: string }): void => {
    const n = events.length + 1;
    events.push({
      event_id: `${SESSION_ID}#${n}`,
      record: {
        session_id: SESSION_ID,
        actor: 'system',
        plan_version: 1,
        causal_parent: n === 1 ? null : `${SESSION_ID}#${n - 1}`,
        payload: {},
        ts: at(120 - n),
        ...record,
      },
    });
  };
  push({ event_type: 'session-start' });
  for (let k = 0; k < 10; k += 1) {
    const taskId = `epic-${k}/task-1`;
    const project = projects[k % projects.length];
    push({
      event_type: 'task-added',
      task_id: taskId,
      project,
      payload: {
        epic_id: `epic-${k}`,
        case: 'feature',
        origin: 'user',
        task_status: 'todo',
        budget_tokens: 1000,
      },
    });
    if (k < 4) {
      push({
        event_type: 'dispatch_decision',
        task_id: taskId,
        project,
        ts: at(k < 2 ? 10 : 2),
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      });
    }
    if (k % 2 === 0) {
      push({
        event_type: 'task-result-recorded',
        task_id: taskId,
        project,
        ts: at(k < 6 ? 90 : 30),
        payload: { task_id: taskId, token_usage: { total_tokens: 100 + k } },
      });
    }
  }
  return events;
}

describe('overview() cost per call', () => {
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-overview-cost-db-'));
    handle = openDb(path.join(dbDir, 'smith.db'));
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  function load(projects: string[]): void {
    const events = buildEvents(projects);
    projectSession(handle, SESSION_ID, events);
    projectTasks(handle, events);
  }

  /** Payload parses of Results the read made. */
  function resultParses(fn: () => void): number {
    const spy = vi.spyOn(JSON, 'parse');
    try {
      fn();
      return spy.mock.calls.filter(([s]) => typeof s === 'string' && s.includes('"token_usage"'))
        .length;
    } finally {
      spy.mockRestore();
    }
  }

  it('folds the agent registry once per call', () => {
    load(['project-a', 'project-b']);
    vi.mocked(registry.foldAgents).mockClear();
    overview(handle.db, {}, { nowIso: NOW });
    expect(vi.mocked(registry.foldAgents)).toHaveBeenCalledTimes(1);
  });

  it('parses the same number of Results for one project as for five', () => {
    load(['project-a']);
    const one = resultParses(() => overview(handle.db, {}, { nowIso: NOW }));
    handle.sqlite.close();
    handle = openDb(path.join(dbDir, 'smith-five.db'));
    load(['project-a', 'project-b', 'project-c', 'project-d', 'project-e']);
    const five = resultParses(() => overview(handle.db, {}, { nowIso: NOW }));
    expect(one).toBeGreaterThan(0);
    expect(five).toBe(one);
  });

  it('keeps the output of the per-project computation', () => {
    load(['project-a', 'project-b', 'project-c', 'project-d', 'project-e']);
    const result = overview(handle.db, {}, { nowIso: NOW });
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(GOLDEN));
  });
});

describe('runningSessions() reads an aggregate', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-overview-cost-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-overview-cost-rs-'));
    for (const session of ['cost-a', 'cost-b']) {
      let body = '';
      for (let i = 0; i < 500; i += 1) {
        body += `${JSON.stringify({
          session_id: session,
          actor: 'user',
          event_type: i === 0 ? 'session-start' : 'operator-note',
          plan_version: 1,
          causal_parent: i === 0 ? null : `${session}#0`,
          payload: { note: `n${i}` },
          ts: new Date(Date.UTC(2030, 0, 1) + i * 1000).toISOString(),
        })}\n`;
      }
      await appendFile(path.join(stateDir, `${session}.jsonl`), body, 'utf8');
    }
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('reads at most one events_raw row per session', () => {
    let rowsRead = 0;
    const realPrepare = handle.sqlite.prepare.bind(handle.sqlite);
    const spy = vi.spyOn(handle.sqlite, 'prepare').mockImplementation(((source: string) => {
      const stmt = realPrepare(source);
      if (!source.includes('"events_raw"')) return stmt;
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const rows = all(...args) as unknown[];
        rowsRead += rows.length;
        return rows;
      }) as typeof stmt.all;
      return stmt;
    }) as typeof handle.sqlite.prepare);
    try {
      const sessions = runningSessions(handle.db, {});
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.lastEventType === 'operator-note')).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(rowsRead).toBeLessThanOrEqual(2);
  });
});

// Captured from the per-project computation before the shared reads.
const GOLDEN =
  '{"liveAgents":[{"agentRole":"coder","provider":"claude","modelTier":"mid","count":2}],"liveAgentEntries":[{"id":"sess-cost-a#11","sessionId":"sess-cost-a","agentRole":"coder","provider":"claude","modelTier":"mid","taskId":"epic-3/task-1","epicId":"epic-3","dispatchedAt":"2026-08-04T11:58:00.000Z"},{"id":"sess-cost-a#6","sessionId":"sess-cost-a","agentRole":"coder","provider":"claude","modelTier":"mid","taskId":"epic-1/task-1","epicId":"epic-1","dispatchedAt":"2026-08-04T11:50:00.000Z"}],"liveAgentCount":2,"workingAgentCount":2,"stalledAgentCount":0,"runningSessions":[{"sessionId":"sess-cost-a","startedAt":"2026-08-04T10:01:00.000Z","lastEventAt":"2026-08-04T10:20:00.000Z","eventCount":20,"liveAgentCount":2,"workingAgentCount":2,"lastEventType":"dispatch_decision","lastStepRole":"coder","lastStepTaskId":"epic-3/task-1","lastStepTaskTitle":null,"projects":["project-a","project-b","project-c","project-d","project-e"],"title":"epic-0"}],"epicsInFlight":["epic-0","epic-1","epic-2","epic-3","epic-4","epic-5","epic-6","epic-7","epic-8","epic-9"],"epicsActivelyRunning":["epic-0","epic-1","epic-2","epic-3","epic-4","epic-5","epic-6","epic-7","epic-8","epic-9"],"epicsIdle":[],"closedEpics":[],"tokensByEpic":[{"epicId":"epic-0","tokensSpent":100,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-1","tokensSpent":0,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-2","tokensSpent":102,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-3","tokensSpent":0,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-4","tokensSpent":104,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-5","tokensSpent":0,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-6","tokensSpent":106,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-7","tokensSpent":0,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-8","tokensSpent":108,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-9","tokensSpent":0,"tokensBudget":1000,"unmeasured":0}],"milestoneProgress":[],"recentDispatches":[{"eventId":"sess-cost-a#11","ts":"2026-08-04T11:58:00.000Z","agentRole":"coder","provider":"claude","modelTier":"mid","taskId":"epic-3/task-1","taskTitle":null,"reason":null,"round":1},{"eventId":"sess-cost-a#8","ts":"2026-08-04T11:58:00.000Z","agentRole":"coder","provider":"claude","modelTier":"mid","taskId":"epic-2/task-1","taskTitle":null,"reason":null,"round":1},{"eventId":"sess-cost-a#6","ts":"2026-08-04T11:50:00.000Z","agentRole":"coder","provider":"claude","modelTier":"mid","taskId":"epic-1/task-1","taskTitle":null,"reason":null,"round":1},{"eventId":"sess-cost-a#3","ts":"2026-08-04T11:50:00.000Z","agentRole":"coder","provider":"claude","modelTier":"mid","taskId":"epic-0/task-1","taskTitle":null,"reason":null,"round":1}],"liveAgentCountDelta5m":0,"workingAgentCountDelta5m":0,"budgetUsedPctPointDelta1h":2.14,"projects":[{"project":"project-a","liveAgentCount":0,"workingAgentCount":0,"epicsInFlight":["epic-0","epic-5"],"epicsActivelyRunning":["epic-0","epic-5"],"epicsIdle":[],"tokensSpent":100,"tokensBudget":2000,"unmeasured":0,"tokensByEpic":[{"epicId":"epic-0","tokensSpent":100,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-5","tokensSpent":0,"tokensBudget":1000,"unmeasured":0}]},{"project":"project-b","liveAgentCount":1,"workingAgentCount":1,"epicsInFlight":["epic-1","epic-6"],"epicsActivelyRunning":["epic-1","epic-6"],"epicsIdle":[],"tokensSpent":106,"tokensBudget":2000,"unmeasured":0,"tokensByEpic":[{"epicId":"epic-1","tokensSpent":0,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-6","tokensSpent":106,"tokensBudget":1000,"unmeasured":0}]},{"project":"project-c","liveAgentCount":0,"workingAgentCount":0,"epicsInFlight":["epic-2","epic-7"],"epicsActivelyRunning":["epic-2","epic-7"],"epicsIdle":[],"tokensSpent":102,"tokensBudget":2000,"unmeasured":0,"tokensByEpic":[{"epicId":"epic-2","tokensSpent":102,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-7","tokensSpent":0,"tokensBudget":1000,"unmeasured":0}]},{"project":"project-d","liveAgentCount":1,"workingAgentCount":1,"epicsInFlight":["epic-3","epic-8"],"epicsActivelyRunning":["epic-3","epic-8"],"epicsIdle":[],"tokensSpent":108,"tokensBudget":2000,"unmeasured":0,"tokensByEpic":[{"epicId":"epic-3","tokensSpent":0,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-8","tokensSpent":108,"tokensBudget":1000,"unmeasured":0}]},{"project":"project-e","liveAgentCount":0,"workingAgentCount":0,"epicsInFlight":["epic-4","epic-9"],"epicsActivelyRunning":["epic-4","epic-9"],"epicsIdle":[],"tokensSpent":104,"tokensBudget":2000,"unmeasured":0,"tokensByEpic":[{"epicId":"epic-4","tokensSpent":104,"tokensBudget":1000,"unmeasured":0},{"epicId":"epic-9","tokensSpent":0,"tokensBudget":1000,"unmeasured":0}]}]}';
