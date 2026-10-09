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
