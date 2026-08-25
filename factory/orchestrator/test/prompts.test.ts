import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectSession } from '../src/db/projector.js';
import * as schema from '../src/db/schema.js';
import { appendEvent, readEvents } from '../src/events.js';
import type { EventContext } from '../src/findings.js';
import { PromptError, recordUserPrompt } from '../src/prompts.js';

describe('recordUserPrompt (D-142)', () => {
  let stateDir: string;
  const sessionId = 'sess-d142';
  let ctx: EventContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-prompts-'));
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
    ctx = { sessionId, planVersion: 1, causalParent: root.event_id };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function prompts() {
    const events = await readEvents(sessionId, { stateDir });
    return events.filter((e) => e.record.event_type === 'user_prompt');
  }

  it('writes a user_prompt carrying the text under the key the projector folds', async () => {
    const stored = await recordUserPrompt('Fix the flaky import.', ctx, { stateDir });

    expect(stored.record.event_type).toBe('user_prompt');
    expect(stored.record.payload).toEqual({ prompt: 'Fix the flaky import.' });
    expect(stored.event_id).toBe(`${sessionId}#1`);
    expect((await prompts()).length).toBe(1);
  });

  // The architecture spec's word for what this event holds is "verbatim"
  // (§ Timeline): the operator's message as they wrote it. Leading and
  // trailing whitespace is theirs — a heredoc that ends in a newline, an
  // indented block pasted from a file. Only the emptiness check trims.
  it('stores the text verbatim, without trimming', async () => {
    const text = '  line one\n    indented\n\n';
    await recordUserPrompt(text, ctx, { stateDir });

    const [event] = await prompts();
    expect(event?.record.payload).toEqual({ prompt: text });
  });

  it("defaults the actor to 'user', the repo's operator actor", async () => {
    const stored = await recordUserPrompt('Ship it.', ctx, { stateDir });
    expect(stored.record.actor).toBe('user');
  });

  it('lets the caller name a different actor', async () => {
    const stored = await recordUserPrompt('Ship it.', { ...ctx, actor: 'operator' }, { stateDir });
    expect(stored.record.actor).toBe('operator');
  });

  // A prompt with no words in it is not a record of anything an operator
  // said, and every reader downstream renders it as an empty timeline row.
  // Refusing costs the caller one retry; accepting costs a blank row that
  // no later read can tell from a real prompt.
  it('refuses whitespace-only text, writing nothing', async () => {
    await expect(recordUserPrompt('   \n\t ', ctx, { stateDir })).rejects.toMatchObject({
      code: 'prompts.empty-prompt',
    });
    expect((await prompts()).length).toBe(0);
  });

  it('refuses the empty string', async () => {
    await expect(recordUserPrompt('', ctx, { stateDir })).rejects.toBeInstanceOf(PromptError);
    expect((await prompts()).length).toBe(0);
  });

  // The point of the fix, not a restatement of it: the finding is that five
  // readers fold a type nothing writes. This asserts the writer's output
  // reaches the first of them.
  it('lands in the prompts table when the session is projected', async () => {
    const stored = await recordUserPrompt('Fix the flaky import.', ctx, { stateDir });

    const dbPath = path.join(stateDir, 'smith.db');
    const handle = openDb(dbPath);
    projectSession(handle, sessionId, await readEvents(sessionId, { stateDir }));
    const rows = handle.db.select().from(schema.prompts).all();
    handle.sqlite.close();

    expect(rows).toMatchObject([
      { eventId: stored.event_id, sessionId, prompt: 'Fix the flaky import.' },
    ]);
  });

  it('chains from the prompt it is given as a parent', async () => {
    const first = await recordUserPrompt('Fix the flaky import.', ctx, { stateDir });
    const second = await recordUserPrompt(
      'And add a test.',
      { ...ctx, causalParent: first.event_id },
      { stateDir },
    );

    expect(second.record.causal_parent).toBe(first.event_id);
  });
});
