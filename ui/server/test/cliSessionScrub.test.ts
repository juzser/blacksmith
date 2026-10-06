// Pins ui/server/test/setup.ts: fixtures here are written through the real event writer,
// which stamps CLAUDE_CODE_SESSION_ID when it is set. This suite is run from
// inside Claude Code as often as not, so the scrub is asserted, not assumed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendEvent } from '../../../factory/orchestrator/src/events.js';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ui server suite: CLI session scrub', () => {
  it('runs with CLAUDE_CODE_SESSION_ID scrubbed, so a plain append is unstamped', async () => {
    expect(process.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    const stateDir = await mkdtemp(path.join(tmpdir(), 'smith-cli-scrub-'));
    tempDirs.push(stateDir);
    const { record } = await appendEvent(
      {
        session_id: 'sess-scrubbed',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    expect(record).not.toHaveProperty('cli_session_id');
  });
});
