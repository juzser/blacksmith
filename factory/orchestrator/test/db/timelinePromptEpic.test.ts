import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { timeline } from '../../src/db/queries.js';

const UUID = '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
const HOME = `prompts-${UUID}`;

/** One raw log line; the id is the line position, so callers number them. */
function line(
  session: string,
  index: number,
  eventType: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    session_id: session,
    actor: eventType === 'user_prompt' ? 'user' : 'system',
    event_type: eventType,
    plan_version: 1,
    causal_parent: index === 0 ? null : `${session}#0`,
    payload,
    ts: `2029-06-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    ...extra,
  })}\n`;
}

describe('timeline() epic filter keeps captured prompts', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-prompt-epic-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-prompt-epic-db-'));
    // epic-x's own log: a prompt captured straight into it, a task event, and
    // a dispatch that names a home-log prompt as its parent.
    await appendFile(
      path.join(stateDir, 'epic-x-main.jsonl'),
      line('epic-x-main', 0, 'session-start', {}) +
        line('epic-x-main', 1, 'task-added', { epic_id: 'epic-x' }, { task_id: 'epic-x/task-1' }) +
        line('epic-x-main', 2, 'user_prompt', { prompt: 'in the epic log' }) +
        line(
          'epic-x-main',
          3,
          'dispatch_decision',
          {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            parent_prompt_id: `${HOME}#1`,
          },
          { task_id: 'epic-x/task-1' },
        ),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, 'epic-y-main.jsonl'),
      line('epic-y-main', 0, 'session-start', {}) +
        line('epic-y-main', 1, 'task-added', { epic_id: 'epic-y' }, { task_id: 'epic-y/task-1' }),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, `${HOME}.jsonl`),
      line(HOME, 0, 'session-start', { kind: 'prompt-log' }) +
        line(HOME, 1, 'user_prompt', { prompt: 'named by a dispatch', source: 'hook' }) +
        line(HOME, 2, 'user_prompt', { prompt: 'nobody names me', source: 'hook' }),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  const promptIds = (epicId: string) =>
    timeline(handle.db, { epicId })
      .filter((e) => e.eventType === 'user_prompt')
      .map((e) => e.eventId)
      .sort();

  it('keeps a prompt that sits in the epic log', () => {
    expect(promptIds('epic-x')).toContain('epic-x-main#2');
  });

  it('keeps a home-log prompt that an event of the epic names', () => {
    expect(promptIds('epic-x')).toContain(`${HOME}#1`);
  });

  it('drops a home-log prompt nobody names, and does not leak either into another epic', () => {
    expect(promptIds('epic-x')).not.toContain(`${HOME}#2`);
    expect(promptIds('epic-y')).toEqual([]);
  });
});

describe('timeline() epic filter shows a prompt under every epic it led to', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-prompt-any-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-prompt-any-db-'));
    const dispatch = (session: string, i: number, task: string) =>
      line(
        session,
        i,
        'dispatch_decision',
        { agent_role: 'coder', provider: 'claude', model_tier: 'mid', parent_prompt_id: `${HOME}#1` },
        { task_id: task },
      );
    // One session log holding task entries of two epics, plus its own prompt.
    await appendFile(
      path.join(stateDir, 'mixed-main.jsonl'),
      line('mixed-main', 0, 'session-start', {}) +
        line('mixed-main', 1, 'task-added', { epic_id: 'epic-a' }, { task_id: 'epic-a/task-1' }) +
        line('mixed-main', 2, 'task-added', { epic_id: 'epic-b' }, { task_id: 'epic-b/task-1' }) +
        line('mixed-main', 3, 'user_prompt', { prompt: 'in the mixed log' }),
      'utf8',
    );
    // Two epics' dispatches both name one home-log prompt.
    await appendFile(
      path.join(stateDir, 'epic-a-main.jsonl'),
      line('epic-a-main', 0, 'session-start', {}) + dispatch('epic-a-main', 1, 'epic-a/task-1'),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, 'epic-b-main.jsonl'),
      line('epic-b-main', 0, 'session-start', {}) + dispatch('epic-b-main', 1, 'epic-b/task-1'),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, 'epic-c-main.jsonl'),
      line('epic-c-main', 0, 'session-start', {}) +
        line('epic-c-main', 1, 'task-added', { epic_id: 'epic-c' }, { task_id: 'epic-c/task-1' }),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, `${HOME}.jsonl`),
      line(HOME, 0, 'session-start', { kind: 'prompt-log' }) +
        line(HOME, 1, 'user_prompt', { prompt: 'named by two epics', source: 'hook' }),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  const ids = (epicId: string) =>
    timeline(handle.db, { epicId }).map((e) => e.eventId);

  it('shows a home-log prompt under each epic whose entries name it', () => {
    expect(ids('epic-a')).toContain(`${HOME}#1`);
    expect(ids('epic-b')).toContain(`${HOME}#1`);
  });

  it('shows a mixed session log prompt under both of its epics', () => {
    expect(ids('epic-a')).toContain('mixed-main#3');
    expect(ids('epic-b')).toContain('mixed-main#3');
  });

  it('keeps unlinked prompts out, and non-prompt entries on their own epic', () => {
    expect(ids('epic-c')).not.toContain(`${HOME}#1`);
    expect(ids('epic-c')).not.toContain('mixed-main#3');
    expect(ids('epic-b')).not.toContain('mixed-main#1');
    expect(ids('epic-a')).not.toContain('mixed-main#2');
  });
});
