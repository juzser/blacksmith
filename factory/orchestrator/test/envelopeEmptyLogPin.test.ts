import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEvent,
  readEvents,
  setEnvelopeDefaults,
  startSession,
  validateEventEnvelope,
} from '../src/events.js';

// A command that starts on an EMPTY log pins the session root, not nothing: if
// another process writes to the log during the command, the command's event
// still hangs off the root (the tail when it started) and no refusal follows
// the outside write.

describe('pre-flight on an empty log', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-emptypin-'));
  });
  afterEach(async () => {
    setEnvelopeDefaults({});
    await rm(stateDir, { recursive: true, force: true });
  });

  const note = (parent: string | null) => ({
    session_id: 's',
    actor: 'system',
    event_type: 'note',
    plan_version: 1,
    causal_parent: parent,
    payload: {},
  });

  it('hangs the event off the root another process wrote meanwhile, with no refusal', async () => {
    let guardRan = false;
    setEnvelopeDefaults({
      parentFor: 's',
      parentGuard: () => {
        guardRan = true;
        throw new Error('the guard must not run after the pre-flight');
      },
    });
    await validateEventEnvelope(
      { session_id: 's', event_type: 'note', causal_parent: null },
      { stateDir },
    );
    // Another process, during the command's outside work.
    const root = await startSession('s', { stateDir });
    const other = await appendEvent(note(root.event_id), { stateDir });

    const stored = await appendEvent(note(null), { stateDir });
    expect(guardRan).toBe(false);
    expect(stored.record.causal_parent).toBe(root.event_id);
    expect(stored.record.causal_parent).not.toBe(other.event_id);
    expect(stored.record.envelope_defaulted).toEqual(['causal_parent']);
    expect((await readEvents('s', { stateDir })).map((e) => e.event_id)).toEqual([
      's#0',
      's#1',
      's#2',
    ]);
  });

  it('still writes the auto-root when the log is still empty at append time', async () => {
    setEnvelopeDefaults({ parentFor: 's' });
    await validateEventEnvelope(
      { session_id: 's', event_type: 'note', causal_parent: null },
      { stateDir },
    );
    const stored = await appendEvent(note(null), { stateDir });
    const events = await readEvents('s', { stateDir });
    expect(events.map((e) => e.record.event_type)).toEqual(['session-start', 'note']);
    expect(stored.record.causal_parent).toBe('s#0');
  });
});
