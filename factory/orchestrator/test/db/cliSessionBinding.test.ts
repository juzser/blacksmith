import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import { cliSessionBindings, timeline } from '../../src/db/queries.js';

const CLI_A = '11111111-2222-4333-8444-555555555555';
const CLI_B = '22222222-3333-4444-8555-666666666666';
const CLI_C = '33333333-4444-4555-8666-777777777777';
const SESSION = 'prompts-0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';

function bound(ts: string, project: string, cli: string): string {
  return `${JSON.stringify({
    session_id: SESSION,
    actor: 'user',
    event_type: 'session-bound',
    plan_version: 1,
    causal_parent: null,
    payload: { project, source: 'hook' },
    project,
    cli_session_id: cli,
    ts,
  })}\n`;
}

describe('cliSessionBindings over a projected log', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-binding-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-binding-db-'));
    // The newest binding of A is written FIRST in the file, so only a
    // timestamp comparison (not file order) finds project-b.
    await appendFile(
      path.join(stateDir, `${SESSION}.jsonl`),
      `${JSON.stringify({
        session_id: SESSION,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: { kind: 'prompt-log' },
        ts: '2029-06-01T00:00:00.000Z',
      })}\n` +
        bound('2029-06-01T00:00:05.000Z', 'project-b', CLI_A) +
        bound('2029-06-01T00:00:01.000Z', 'project-a', CLI_A) +
        bound('2029-06-01T00:00:02.000Z', 'project-a', CLI_B),
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

  it('returns the newest binding per CLI session and nothing for an unbound one', () => {
    const rows = cliSessionBindings(handle.db, [CLI_A, CLI_B, CLI_C]);
    expect(rows).toEqual([
      { cliSessionId: CLI_A, project: 'project-b', boundAt: '2029-06-01T00:00:05.000Z' },
      { cliSessionId: CLI_B, project: 'project-a', boundAt: '2029-06-01T00:00:02.000Z' },
    ]);
  });

  it('returns [] for an empty id list', () => {
    expect(cliSessionBindings(handle.db, [])).toEqual([]);
  });

  it('guard (passes before and after this task): the timeline shows session-bound as kind Prompt', () => {
    const row = timeline(handle.db, {}).find((e) => e.eventType === 'session-bound');
    expect(row?.kind).toBe('Prompt');
  });
});
