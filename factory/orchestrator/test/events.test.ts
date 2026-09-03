import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEdge,
  appendEvent,
  EventError,
  type EventRecord,
  eventTaskId,
  filterEvents,
  parseEventId,
  readEvents,
  requireSession,
  sessionLineage,
  startSession,
  tailEvents,
} from '../src/events.js';
import { loadTaxonomy } from '../src/taxonomy.js';

describe('events.ts', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-events-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('stamps ts and returns a stable event_id for the first (session-root) event', async () => {
    const { event_id, record } = await appendEvent(
      {
        session_id: 'sess-1',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: { prompt: 'build the loop runner' },
      },
      { stateDir },
    );
    expect(event_id).toBe('sess-1#0');
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.causal_parent).toBeNull();
  });

  describe('D-197: a session id is a file name, and the writer has to say so', () => {
    function root(session_id: string) {
      return {
        session_id,
        actor: 'operator-skill',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: { note: 'probe' },
      };
    }

    it('refuses an empty session id instead of minting an unparseable event id', async () => {
      await expect(appendEvent(root(''), { stateDir })).rejects.toThrow(EventError);
      // The id the unguarded writer used to hand back was '#0', which
      // parseEventId rejects — so the session's second event was impossible.
      expect(() => parseEventId('#0')).toThrow(EventError);
    });

    it('refuses a session id that is not one path segment', async () => {
      await expect(appendEvent(root('a/b/c'), { stateDir })).rejects.toThrow(EventError);
      await expect(appendEvent(root('../escaped'), { stateDir })).rejects.toThrow(EventError);
      await expect(appendEvent(root('.'), { stateDir })).rejects.toThrow(EventError);
      await expect(appendEvent(root('..'), { stateDir })).rejects.toThrow(EventError);
    });

    it('writes nothing anywhere when it refuses', async () => {
      // The state dir is one level down so the escape lands inside the
      // fixture's own temp tree rather than in the shared tmpdir.
      const nested = path.join(stateDir, 'events');
      await expect(appendEvent(root('../escaped'), { stateDir: nested })).rejects.toThrow(
        EventError,
      );
      expect(existsSync(path.join(stateDir, 'escaped.jsonl'))).toBe(false);
      expect(readdirSync(stateDir)).toEqual([]);
    });

    it('refuses the same ids on the read side, rather than answering []', async () => {
      await expect(readEvents('../escaped', { stateDir })).rejects.toThrow(EventError);
      expect(() => requireSession('a/b', { stateDir })).toThrow(EventError);
    });

    it('still accepts a session id holding a #, which parseEventId supports', async () => {
      const { event_id } = await appendEvent(root('sess#1'), { stateDir });
      expect(event_id).toBe('sess#1#0');
      expect(parseEventId(event_id)).toEqual({ sessionId: 'sess#1', index: 0 });
      expect(await readEvents('sess#1', { stateDir })).toHaveLength(1);
    });
  });

  // D-244. `task_id`, `agent_id` and `project` are the schema's three optional
  // identifier strings, and each one's contract is the same: absent, or it
  // names something. db/queries.ts reads an absent project as the default
  // 'black-smith'; agents-registry.ts reads an absent task id as an epic-level
  // dispatch. None of the three declared a minLength, so `''` validated and
  // was written as a *present* field naming nothing -- a project literally
  // called '', or a dispatch whose task no terminal event can ever match.
  // state/smith.db holds one of the latter, live for days.
  describe('D-244: an optional id is absent, or it names something', () => {
    const session_id = 'sess-empty-id';

    async function seedRoot() {
      await appendEvent(
        {
          session_id,
          actor: 'user',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: { prompt: 'probe' },
        },
        { stateDir },
      );
    }

    function child(extra: Record<string, unknown>) {
      return {
        session_id,
        actor: 'planner',
        event_type: 'dispatch_decision',
        plan_version: 1,
        causal_parent: `${session_id}#0`,
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
        ...extra,
      } as unknown as Parameters<typeof appendEvent>[0];
    }

    it('accepts the same event when the optional ids are simply absent', async () => {
      await seedRoot();
      const { event_id } = await appendEvent(child({}), { stateDir });
      expect(event_id).toBe(`${session_id}#1`);
    });

    it.each(['task_id', 'agent_id', 'project'])('refuses an empty %s', async (field) => {
      await seedRoot();
      await expect(appendEvent(child({ [field]: '' }), { stateDir })).rejects.toMatchObject({
        code: 'events.invalid-record',
      });
      // Refused means refused: the log still holds only the root.
      expect(await readEvents(session_id, { stateDir })).toHaveLength(1);
    });
  });

  it('rejects a null causal_parent on a non-root event', async () => {
    await expect(
      appendEvent(
        {
          session_id: 'sess-1',
          actor: 'planner',
          event_type: 'dispatch_decision',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    // Nothing was written.
    await expect(readEvents('sess-1', { stateDir })).resolves.toEqual([]);
  });

  it('rejects an OMITTED causal_parent the same typed way as a null one', async () => {
    // `causal_parent` is required by EventInput, so within the orchestrator the
    // compiler makes this unreachable. It is not unreachable in practice: every
    // event that arrives through `smith event append` crosses a JSON boundary
    // where the type guarantees nothing, and forgetting a field is the single
    // most likely way a hand-written or generated event is malformed.
    //
    // Both guards on this path test against `null` specifically, so undefined
    // falls through them into parseEventId(undefined) and the caller gets a raw
    // TypeError — "Cannot read properties of undefined (reading 'lastIndexOf')"
    // — with no `code` to branch on. The two shapes either side of it are typed
    // (`events.missing-causal-parent` for null, `events.malformed-event-id` for
    // a bad string), which is what makes this one a hole rather than a policy.
    const missingParent = {
      session_id: 'sess-undef',
      actor: 'planner',
      event_type: 'dispatch_decision',
      plan_version: 1,
      payload: {},
    } as unknown as Parameters<typeof appendEvent>[0];

    await expect(appendEvent(missingParent, { stateDir })).rejects.toThrow(EventError);
    // Asserted on the code, not just the class: the value of a typed error here
    // is that a caller can tell "you forgot the parent" from "the parent id is
    // malformed", and only the code carries that.
    await expect(appendEvent(missingParent, { stateDir })).rejects.toMatchObject({
      code: 'events.missing-causal-parent',
    });

    // Nothing was written.
    await expect(readEvents('sess-undef', { stateDir })).resolves.toEqual([]);
  });

  it('rejects an OMITTED causal_parent on a session-root event too', async () => {
    // The second path through the same hole, and the one the first test cannot
    // reach: for a session-start event the missing-parent guard is meant to pass
    // — null IS legal here — so the crash came from the *other* guard instead.
    // A fix that only taught the first guard about undefined would leave this
    // one throwing a TypeError and the first test would still be green.
    //
    // The error is a different, more specific code than the non-root case, and
    // that is right rather than an inconsistency: null is a legal value for a
    // root event, so "you omitted it" is a schema violation here, not a policy
    // one, and the schema names the field.
    const rootMissingParent = {
      session_id: 'sess-undef-root',
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      payload: {},
    } as unknown as Parameters<typeof appendEvent>[0];

    await expect(appendEvent(rootMissingParent, { stateDir })).rejects.toThrow(EventError);
    await expect(appendEvent(rootMissingParent, { stateDir })).rejects.toMatchObject({
      code: 'events.invalid-record',
    });

    await expect(readEvents('sess-undef-root', { stateDir })).resolves.toEqual([]);
  });

  it('rejects a causal_parent that is not a string, the same typed way', async () => {
    // The third value the same JSON boundary produces, and the likeliest of
    // the three to be written on purpose: the index alone. An event id is
    // `<session>#<index>`, so `42` is the half a writer remembers, and every
    // guard on this path is a `=== null` comparison that a number passes.
    //
    // It reached parseEventId(42), where `.lastIndexOf` does not exist on a
    // number, and came back as the D-135 shape -- a raw TypeError message and
    // a stack, with no `code`. Guarded in parseEventId rather than beside its
    // one caller: the function's whole contract is "this string is an event
    // id", and readEvents() parses a `causal_parent` straight off a log line
    // that nothing retypes on the way in.
    const numericParent = {
      session_id: 'sess-numeric',
      actor: 'planner',
      event_type: 'dispatch_decision',
      plan_version: 1,
      causal_parent: 42,
      payload: {},
    } as unknown as Parameters<typeof appendEvent>[0];

    await expect(appendEvent(numericParent, { stateDir })).rejects.toMatchObject({
      code: 'events.malformed-event-id',
    });
    // The message has to name what it was given, or "42 is not an event id"
    // is the one thing the writer already believes is false.
    await expect(appendEvent(numericParent, { stateDir })).rejects.toThrow(/42/);

    await expect(readEvents('sess-numeric', { stateDir })).resolves.toEqual([]);
  });

  it('rejects an event with an unknown taxonomy value in its edge and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-1',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-1',
          actor: 'system',
          event_type: 'edge-recorded',
          plan_version: 1,
          causal_parent: 'sess-1#0',
          payload: {},
          edge: { edge_type: 'not-real', edge_provenance: 'observed' },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-1', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('assigns sequential event ids and links causal_parent chains', async () => {
    const first = await appendEvent(
      {
        session_id: 'sess-2',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    const second = await appendEvent(
      {
        session_id: 'sess-2',
        actor: 'planner',
        event_type: 'dispatch_decision',
        plan_version: 1,
        causal_parent: first.event_id,
        payload: {
          agent_role: 'coder',
          provider: 'claude',
          model_tier: 'mid',
          model: 'claude-sonnet-5',
        },
      },
      { stateDir },
    );
    expect(second.event_id).toBe('sess-2#1');
    expect(second.record.causal_parent).toBe('sess-2#0');
  });

  it('reads back events in append order with matching event_ids', async () => {
    await appendEvent(
      {
        session_id: 'sess-3',
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
        session_id: 'sess-3',
        actor: 'planner',
        event_type: 'note',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: 'sess-3#0',
        payload: {},
      },
      { stateDir },
    );
    const events = await readEvents('sess-3', { stateDir });
    expect(events.map((e) => e.event_id)).toEqual(['sess-3#0', 'sess-3#1']);
    expect(events[1]?.record.task_id).toBe('epic-1/task-1');
  });

  it('returns an empty array reading a session with no log file', async () => {
    await expect(readEvents('never-seen', { stateDir })).resolves.toEqual([]);
  });

  it('tails the last N events', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(
        {
          session_id: 'sess-4',
          actor: 'system',
          event_type: i === 0 ? 'session-start' : 'note',
          plan_version: 1,
          causal_parent: i === 0 ? null : `sess-4#${i - 1}`,
          payload: { i },
        },
        { stateDir },
      );
    }
    const tail = await tailEvents('sess-4', 2, { stateDir });
    expect(tail.map((e) => e.record.payload.i)).toEqual([3, 4]);
  });

  it('filters events by task_id and plan_version', async () => {
    await appendEvent(
      {
        session_id: 'sess-5',
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
        session_id: 'sess-5',
        actor: 'coder',
        event_type: 'gate-result',
        task_id: 'epic-1/task-1',
        plan_version: 1,
        causal_parent: 'sess-5#0',
        payload: {},
      },
      { stateDir },
    );
    await appendEvent(
      {
        session_id: 'sess-5',
        actor: 'coder',
        event_type: 'gate-result',
        task_id: 'epic-1/task-2',
        plan_version: 2,
        causal_parent: 'sess-5#0',
        payload: {},
      },
      { stateDir },
    );

    const events = await readEvents('sess-5', { stateDir });
    expect(filterEvents(events, { taskId: 'epic-1/task-1' })).toHaveLength(1);
    expect(filterEvents(events, { planVersion: 2 })).toHaveLength(1);
    expect(filterEvents(events, {})).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // D-130. A task's record is written in both spellings — qualified
  // "<epic>/<task>" and bare "<task>" (D-46/P9-29) — and the split is not a
  // tail: in dogfood-mcp-1 the bare range sits interleaved inside the
  // qualified one. A raw `!==` therefore answered a query by the canonical id
  // with a well-formed, SHORTER record, and short is indistinguishable from
  // complete unless the caller already knows the true count.
  // -------------------------------------------------------------------------
  it('matches a task_id written in the other spelling (D-130)', async () => {
    await appendEvent(
      {
        session_id: 'sess-6',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    for (const taskId of ['epic-1/task-2', 'task-2', 'epic-1/task-2']) {
      await appendEvent(
        {
          session_id: 'sess-6',
          actor: 'coder',
          event_type: 'gate-result',
          task_id: taskId,
          plan_version: 1,
          causal_parent: 'sess-6#0',
          payload: {},
        },
        { stateDir },
      );
    }

    const events = await readEvents('sess-6', { stateDir });
    expect(filterEvents(events, { taskId: 'epic-1/task-2' })).toHaveLength(3);
    expect(filterEvents(events, { taskId: 'task-2' })).toHaveLength(3);
  });

  it('does not merge two qualified ids that differ only by epic (D-130)', async () => {
    await appendEvent(
      {
        session_id: 'sess-7',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    for (const taskId of ['epic-1/task-2', 'epic-2/task-2']) {
      await appendEvent(
        {
          session_id: 'sess-7',
          actor: 'coder',
          event_type: 'gate-result',
          task_id: taskId,
          plan_version: 1,
          causal_parent: 'sess-7#0',
          payload: {},
        },
        { stateDir },
      );
    }

    const events = await readEvents('sess-7', { stateDir });
    const matched = filterEvents(events, { taskId: 'epic-1/task-2' });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.record.task_id).toBe('epic-1/task-2');
  });

  // -------------------------------------------------------------------------
  // D-245. A task id is written in two places: the envelope's `task_id`, which
  // every machine producer stamps, and the payload's, which the hand-written
  // dispatch the operator skill documents carries instead. Two modules had
  // already found this and each fixed it privately; the rule belongs here,
  // next to the record shape it reads.
  // -------------------------------------------------------------------------
  describe('eventTaskId (D-245)', () => {
    function record(overrides: Partial<EventRecord>): EventRecord {
      return {
        session_id: 'sess-1',
        actor: 'system',
        event_type: 'dispatch_decision',
        plan_version: 1,
        causal_parent: null,
        payload: {},
        ts: '2026-08-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('reads the envelope when it names a task', () => {
      expect(eventTaskId(record({ task_id: 'epic-1/task-1' }))).toBe('epic-1/task-1');
    });

    it('falls back to the payload when the envelope carries no id', () => {
      expect(eventTaskId(record({ payload: { task_id: 'epic-1/task-1' } }))).toBe('epic-1/task-1');
    });

    // The envelope is the field every projector keys on, so it decides. A
    // payload that disagrees is a producer bug, not a second opinion.
    it('prefers the envelope when both name a task', () => {
      expect(
        eventTaskId(record({ task_id: 'epic-1/task-1', payload: { task_id: 'epic-9/task-9' } })),
      ).toBe('epic-1/task-1');
    });

    // D-244: an empty string names no task, at either level.
    it('treats an empty id at either level as no id', () => {
      expect(eventTaskId(record({ task_id: '', payload: { task_id: '' } }))).toBeNull();
      expect(eventTaskId(record({ task_id: '', payload: { task_id: 'epic-1/task-1' } }))).toBe(
        'epic-1/task-1',
      );
    });

    it('answers null when neither level names a task', () => {
      expect(eventTaskId(record({ payload: { agent_role: 'planner' } }))).toBeNull();
    });

    // D-135: the `string` in the type is a claim, not a guarantee — every
    // field here has been through a JSONL round-trip.
    it('ignores a payload task_id that is not a string', () => {
      expect(eventTaskId(record({ payload: { task_id: 42 } }))).toBeNull();
    });
  });

  it('scopes a task filter to an event whose id is only in the payload (D-245)', async () => {
    await appendEvent(
      {
        session_id: 'sess-8',
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
        session_id: 'sess-8',
        actor: 'coder',
        event_type: 'gate-result',
        plan_version: 1,
        causal_parent: 'sess-8#0',
        payload: { task_id: 'epic-1/task-2' },
      },
      { stateDir },
    );

    const events = await readEvents('sess-8', { stateDir });
    expect(filterEvents(events, { taskId: 'epic-1/task-2' })).toHaveLength(1);
  });

  it('appendEdge requires edge_type and edge_provenance and produces an edge-recorded event', async () => {
    await appendEvent(
      {
        session_id: 'sess-6',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    const { record } = await appendEdge(
      {
        session_id: 'sess-6',
        actor: 'system',
        plan_version: 1,
        causal_parent: 'sess-6#0',
        payload: {},
        task_id: 'epic-1/task-2',
      },
      { edge_type: 'artifact', edge_provenance: 'observed' },
      { stateDir },
    );
    expect(record.event_type).toBe('edge-recorded');
    expect(record.edge).toEqual({ edge_type: 'artifact', edge_provenance: 'observed' });
  });

  it('serializes concurrent appendEvent calls on one session into distinct sequential ids', async () => {
    await appendEvent(
      {
        session_id: 'race-sess',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendEvent(
          {
            session_id: 'race-sess',
            actor: 'system',
            event_type: 'note',
            plan_version: 1,
            causal_parent: 'race-sess#0',
            payload: { i },
          },
          { stateDir },
        ),
      ),
    );

    const ids = results.map((r) => r.event_id).sort();
    expect(ids).toEqual([
      'race-sess#1',
      'race-sess#2',
      'race-sess#3',
      'race-sess#4',
      'race-sess#5',
    ]);

    const events = await readEvents('race-sess', { stateDir });
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.event_id)).toEqual([
      'race-sess#0',
      'race-sess#1',
      'race-sess#2',
      'race-sess#3',
      'race-sess#4',
      'race-sess#5',
    ]);
  });

  it('waits out a writer in another process, and numbers itself after the line that one wrote', async () => {
    // The queue above orders appends inside ONE Node process, which was the
    // whole model while the queue, the gates and the CLI ran as one. A wave
    // dispatched in parallel ends that: every `smith` invocation is its own
    // process with its own queue, so the only thing left that can order two of
    // them is the log file itself. Holding the lock file and growing the log
    // behind our back is precisely what the other process looks like from here.
    const logFile = path.join(stateDir, 'cross-sess.jsonl');
    const lockFile = `${logFile}.lock`;
    await appendEvent(
      {
        session_id: 'cross-sess',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    const foreign = await open(lockFile, 'wx');
    let settled = false;
    const pending = appendEvent(
      {
        session_id: 'cross-sess',
        actor: 'system',
        event_type: 'note',
        plan_version: 1,
        causal_parent: 'cross-sess#0',
        payload: { from: 'us' },
      },
      { stateDir },
    ).then((result) => {
      settled = true;
      return result;
    });

    await appendFile(
      logFile,
      `${JSON.stringify({
        session_id: 'cross-sess',
        actor: 'system',
        event_type: 'note',
        plan_version: 1,
        causal_parent: 'cross-sess#0',
        payload: { from: 'them' },
        ts: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);

    await foreign.close();
    await rm(lockFile, { force: true });

    // #2, not #1: the index is read after the lock is held, so it counts the
    // line the other writer added. Returning #1 here is the whole bug — the id
    // is wrong, it names an event that exists, and the next command's
    // --causal-parent then points at the wrong parent and validates anyway.
    expect((await pending).event_id).toBe('cross-sess#2');
    const events = await readEvents('cross-sess', { stateDir });
    expect(events.map((e) => e.record.payload.from)).toEqual([undefined, 'them', 'us']);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('rejects a dispatch_decision with a nonsense agent_role/provider/model_tier and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-7',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-7',
          actor: 'planner',
          event_type: 'dispatch_decision',
          plan_version: 1,
          causal_parent: 'sess-7#0',
          payload: {
            agent_role: 'not-a-real-agent',
            provider: 'not-a-real-provider',
            model_tier: 'huge',
            model: 'claude-sonnet-5',
          },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-7', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('rejects a judge-verdict with a nonsense agent/provider/model_tier and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-7b',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-7b',
          actor: 'system',
          event_type: 'judge-verdict',
          plan_version: 1,
          causal_parent: 'sess-7b#0',
          payload: {
            agent: 'not-a-real-agent',
            provider: 'not-a-real-provider',
            model_tier: 'huge',
            model: 'claude-sonnet-5',
          },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-7b', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('accepts a schema/taxonomy-valid judge-verdict event', async () => {
    await appendEvent(
      {
        session_id: 'sess-7c',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-7c',
          actor: 'system',
          event_type: 'judge-verdict',
          plan_version: 1,
          causal_parent: 'sess-7c#0',
          payload: {
            task_id: 'epic-1/task-1',
            agent: 'verifier',
            provider: 'codex',
            model_tier: 'mid',
            model: 'codex:default',
            kind: 'verify',
            mode: 'shadow',
            ok: true,
            verdict: 'confirm',
            rationale: 'real issue',
            native_verdict: 'confirm',
            agreement_with_native: true,
            schema_failure: false,
            latency_ms: 100,
          },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-7c#1' });
  });

  it('rejects an error-logged event with an unknown severity and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-8',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-8',
          actor: 'coder',
          event_type: 'error-logged',
          plan_version: 1,
          causal_parent: 'sess-8#0',
          payload: {
            error: 'execution.test-failure',
            severity: 'S99-not-real',
            task_ref: 'epic-1/task-1',
          },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-8', { stateDir });
    expect(events).toHaveLength(1);
  });

  it('rejects a dispatch_decision that names no model and writes nothing (P9-23)', async () => {
    await appendEvent(
      {
        session_id: 'sess-model',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    // model_tier is not a model: opus and fable are both `frontier`, so the
    // tier can never answer "did the critic run on the finder's own model?".
    await expect(
      appendEvent(
        {
          session_id: 'sess-model',
          actor: 'system',
          event_type: 'dispatch_decision',
          plan_version: 1,
          causal_parent: 'sess-model#0',
          payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid' },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-model', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('accepts any non-empty model on a dispatch_decision: model names are not a closed vocabulary (P9-23)', async () => {
    await appendEvent(
      {
        session_id: 'sess-model-2',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    // Presence-only, deliberately: providers ship new model ids monthly, and
    // a taxonomy enum would reject tomorrow's model — which in practice
    // means the field gets dropped rather than the taxonomy bumped.
    await expect(
      appendEvent(
        {
          session_id: 'sess-model-2',
          actor: 'system',
          event_type: 'dispatch_decision',
          plan_version: 1,
          causal_parent: 'sess-model-2#0',
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            model: 'a-model-shipped-next-month',
          },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-model-2#1' });
  });

  it('accepts a schema/taxonomy-valid dispatch_decision and error-logged event', async () => {
    await appendEvent(
      {
        session_id: 'sess-9',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-9',
          actor: 'planner',
          event_type: 'dispatch_decision',
          plan_version: 1,
          causal_parent: 'sess-9#0',
          payload: {
            agent_role: 'coder',
            provider: 'claude',
            model_tier: 'mid',
            model: 'claude-sonnet-5',
          },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-9#1' });

    await expect(
      appendEvent(
        {
          session_id: 'sess-9',
          actor: 'coder',
          event_type: 'error-logged',
          plan_version: 1,
          causal_parent: 'sess-9#0',
          payload: {
            error: 'execution.test-failure',
            severity: 'S2-major',
            task_ref: 'epic-1/task-1',
          },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-9#2' });
  });

  it('rejects a dangling causal_parent (unknown event_id) and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-10',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-10',
          actor: 'system',
          event_type: 'note',
          plan_version: 1,
          causal_parent: 'bogus#9999',
          payload: {},
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-10', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('rejects a lesson-candidate-raised event with a garbage lesson_type and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-11',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-11',
          actor: 'scribe',
          event_type: 'lesson-candidate-raised',
          plan_version: 1,
          causal_parent: 'sess-11#0',
          payload: {
            lesson_id: 'lesson-1',
            lesson_type: 'not-a-real-type',
            lesson_level: 'principle',
            lesson_status: 'candidate',
            lesson_scope: 'claim-path',
            statement: 'Always do X.',
            provenance_event_ids: ['sess-11#0'],
          },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-11', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('accepts a schema/taxonomy-valid lesson-candidate-raised and lesson-status-changed event', async () => {
    await appendEvent(
      {
        session_id: 'sess-12',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-12',
          actor: 'scribe',
          event_type: 'lesson-candidate-raised',
          plan_version: 1,
          causal_parent: 'sess-12#0',
          payload: {
            lesson_id: 'lesson-1',
            lesson_type: 'rule',
            lesson_level: 'principle',
            lesson_status: 'candidate',
            lesson_scope: 'claim-path',
            statement: 'Always do X.',
            provenance_event_ids: ['sess-12#0'],
          },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-12#1' });

    await expect(
      appendEvent(
        {
          session_id: 'sess-12',
          actor: 'user',
          event_type: 'lesson-status-changed',
          plan_version: 1,
          causal_parent: 'sess-12#1',
          payload: { lesson_id: 'lesson-1', to_status: 'approved' },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-12#2' });
  });

  it('rejects a lesson-status-changed event with a garbage to_status and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-13',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-13',
          actor: 'user',
          event_type: 'lesson-status-changed',
          plan_version: 1,
          causal_parent: 'sess-13#0',
          payload: { lesson_id: 'lesson-1', to_status: 'not-a-real-status' },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-13', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('rejects a lesson-edited event with a garbage lesson_type and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-14',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-14',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-14#0',
          payload: { lesson_id: 'lesson-1', lesson_type: 'NOT-A-REAL-TYPE' },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-14', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('rejects a lesson-edited event with a garbage lesson_scope and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-15',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-15',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-15#0',
          payload: { lesson_id: 'lesson-1', lesson_scope: 'NOT-A-REAL-SCOPE' },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-15', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('accepts a lesson-edited event that only touches the statement (no taxonomy-tagged field present)', async () => {
    await appendEvent(
      {
        session_id: 'sess-16',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-16',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-16#0',
          payload: { lesson_id: 'lesson-1', statement: 'A sharper statement.' },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-16#1' });
  });

  it('accepts a lesson-edited event with valid lesson_type and lesson_scope', async () => {
    await appendEvent(
      {
        session_id: 'sess-17',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-17',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-17#0',
          payload: { lesson_id: 'lesson-1', lesson_type: 'fact', lesson_scope: 'stack-wide' },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-17#1' });
  });

  // D-129 gave `lesson-edited` two more taxonomy-valued fields, agent_role and
  // case_type, so that re-scoping a lesson to a selector scope can name the
  // selector in the same edit. PAYLOAD_PARTIAL_TAG_MAP was not extended with
  // them, so the boundary validates two of the payload's four tagged fields
  // and waves the other two through -- and foldLessons writes whatever
  // agent_role string it is given straight onto the row, exactly as that map's
  // own comment says of lesson_type. An approved lesson scoped to an agent
  // role no agent has is a lesson that reaches nobody, silently.
  it('rejects a lesson-edited event with a garbage agent_role and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-18',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-18',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-18#0',
          payload: {
            lesson_id: 'lesson-1',
            lesson_scope: 'agent-role',
            agent_role: 'NOT-AN-AGENT',
          },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-18', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('rejects a lesson-edited event with a garbage case_type and writes nothing', async () => {
    await appendEvent(
      {
        session_id: 'sess-19',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-19',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-19#0',
          payload: { lesson_id: 'lesson-1', lesson_scope: 'case-type', case_type: 'NOT-A-CASE' },
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-19', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('accepts a lesson-edited event whose agent_role and case_type are real tags', async () => {
    await appendEvent(
      {
        session_id: 'sess-20',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-20',
          actor: 'user',
          event_type: 'lesson-edited',
          plan_version: 1,
          causal_parent: 'sess-20#0',
          payload: { lesson_id: 'lesson-1', agent_role: 'coder', case_type: 'bugfix' },
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-20#1' });
  });

  // -------------------------------------------------------------------------
  // D-135. `foldFindings` reconstructs a Finding from the payload alone, so a
  // `finding-raised` payload that omits a required field is a bomb with a
  // delay fuse: the write succeeds, and the crash lands later in an unrelated
  // reader. Validate the payload against finding.schema.json at write time,
  // where the actor that produced the bad record is still on the stack.
  // -------------------------------------------------------------------------
  const validFindingPayload = {
    finding_id: 'f-epic-1/task-1-abc123',
    task_id: 'epic-1/task-1',
    fingerprint: 'abc123',
    file_path: 'src/foo.ts',
    finding_category: 'correctness',
    severity: 'S2-major',
    finding_status: 'raised',
    summary: 'src/foo.ts:42 off-by-one in loop bound',
    failure_scenario: { inputs: 'n=5', expected: '5 iterations', actual: '4 iterations' },
    found_by: 'reviewer',
  };

  it('rejects a finding-raised payload missing task_id and writes nothing (D-135)', async () => {
    await appendEvent(
      {
        session_id: 'sess-18',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    const { task_id: _omitted, ...withoutTaskId } = validFindingPayload;
    await expect(
      appendEvent(
        {
          session_id: 'sess-18',
          actor: 'reviewer',
          event_type: 'finding-raised',
          plan_version: 1,
          causal_parent: 'sess-18#0',
          payload: withoutTaskId,
        },
        { stateDir },
      ),
    ).rejects.toThrow(EventError);

    const events = await readEvents('sess-18', { stateDir });
    expect(events).toHaveLength(1); // only the root event
  });

  it('accepts a schema-valid finding-raised payload (D-135)', async () => {
    await appendEvent(
      {
        session_id: 'sess-19',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    await expect(
      appendEvent(
        {
          session_id: 'sess-19',
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: 'sess-19#0',
          payload: validFindingPayload,
        },
        { stateDir },
      ),
    ).resolves.toMatchObject({ event_id: 'sess-19#1' });
  });

  // D-215. `task-added` is the only event whose payload becomes a task row's
  // `task_status` (db/projector.ts's `row.taskStatus = p.task_status`); every
  // other assignment there is a literal from the closed vocabulary. Until
  // now nothing checked it at write time, so a typo persisted and the UI's
  // kanban fold, which has no bucket for a status it does not recognise,
  // dropped the task off the board entirely -- in "All" mode too.
  describe('D-215: a task-added payload carries taxonomy-valued fields', () => {
    async function root(sessionId: string): Promise<void> {
      await appendEvent(
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
    }

    async function addTask(
      sessionId: string,
      payload: Record<string, unknown>,
    ): Promise<{ event_id: string }> {
      return appendEvent(
        {
          session_id: sessionId,
          actor: 'planner',
          event_type: 'task-added',
          task_id: 'epic-1/task-1',
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload,
        },
        { stateDir },
      );
    }

    it('rejects a task_status outside the taxonomy and writes nothing', async () => {
      await root('sess-21');

      // Not a coined string: "in-review" is the plausible near-miss for the
      // vocabulary's `reviewing`, and it is what the board would silently
      // swallow.
      await expect(
        addTask('sess-21', {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'user',
          task_status: 'in-review',
        }),
      ).rejects.toThrow(EventError);

      const events = await readEvents('sess-21', { stateDir });
      expect(events).toHaveLength(1); // only the root event
    });

    it('rejects an origin outside the taxonomy and writes nothing', async () => {
      await root('sess-22');

      await expect(
        addTask('sess-22', {
          epic_id: 'epic-1',
          case: 'feature',
          origin: 'plan',
          task_status: 'todo',
        }),
      ).rejects.toThrow(EventError);

      const events = await readEvents('sess-22', { stateDir });
      expect(events).toHaveLength(1);
    });

    it('rejects a case outside the taxonomy and writes nothing', async () => {
      await root('sess-23');

      await expect(
        addTask('sess-23', {
          epic_id: 'epic-1',
          case: 'bug',
          origin: 'user',
          task_status: 'todo',
        }),
      ).rejects.toThrow(EventError);

      const events = await readEvents('sess-23', { stateDir });
      expect(events).toHaveLength(1);
    });

    it('accepts every task_status the taxonomy declares', async () => {
      await root('sess-24');

      // Read off taxonomy.yml rather than restated here: the point is that
      // the check is wired to `task_status` and not to a neighbouring
      // dimension. `plan_status` also holds "superseded", so a mis-wiring
      // would pass a spot-check on one value.
      const statuses = loadTaxonomy().dimensions.task_status ?? [];
      expect(statuses.length).toBeGreaterThan(0);

      for (const [i, taskStatus] of statuses.entries()) {
        await expect(
          appendEvent(
            {
              session_id: 'sess-24',
              actor: 'planner',
              event_type: 'task-added',
              task_id: `epic-1/task-${i}`,
              plan_version: 1,
              causal_parent: 'sess-24#0',
              payload: {
                epic_id: 'epic-1',
                case: 'feature',
                origin: 'user',
                task_status: taskStatus,
              },
            },
            { stateDir },
          ),
        ).resolves.toMatchObject({ event_id: `sess-24#${i + 1}` });
      }
    });

    // Presence stays `plan validate`'s job (task-spec.schema.json marks the
    // three required); this check is about the VALUE of a field that is
    // there, so a payload naming none of them is not this rule's business.
    it('accepts a task-added payload that names no taxonomy-valued field', async () => {
      await root('sess-25');

      await expect(
        addTask('sess-25', { epic_id: 'epic-1', objective: 'do the thing' }),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Opening a session was the one write with no verb. `appendEvent` is the open
  // write side on purpose (D-163) -- it must accept a type it has never heard
  // of rather than lose the record -- and that openness extends to the root:
  // a second `session-start`, `causal_parent: null`, into a log that already
  // has one is accepted, receipted `#1`, and exits 0. Nothing downstream reads
  // it. `sessionLineage` takes the FIRST root and the tree-of-sessions reading
  // in §7 assumes there is only one, so the second root is not a second
  // beginning -- it is a line nobody will ever look at, written by an operator
  // who thought they were starting fresh.
  //
  // The fix is a verb, not a rule inside the writer: a command whose whole job
  // is the root can be closed where `appendEvent` has to stay open.
  // ---------------------------------------------------------------------------
  describe('startSession: a session has one beginning', () => {
    it('opens a log that does not exist yet and hands back the id everything chains off', async () => {
      const { event_id, record } = await startSession('sess-open-1', { stateDir });

      expect(event_id).toBe('sess-open-1#0');
      expect(record.event_type).toBe('session-start');
      expect(record.causal_parent).toBeNull();
      expect(record.plan_version).toBe(1);
      // The operator is who starts a session by hand; an agent that starts one
      // says so, and the log keeps the difference.
      expect(record.actor).toBe('operator');
    });

    it('stamps the actor it was given', async () => {
      const { record } = await startSession('sess-open-2', { stateDir, actor: 'operator-skill' });
      expect(record.actor).toBe('operator-skill');
    });

    // Reads the log, not its own bookkeeping: the session this refuses was
    // opened the old way, by hand, which is the case that actually happens.
    it('refuses a session whose log already holds an event', async () => {
      await appendEvent(
        {
          session_id: 'sess-open-3',
          actor: 'operator',
          event_type: 'session-start',
          plan_version: 1,
          causal_parent: null,
          payload: {},
        },
        { stateDir },
      );

      await expect(startSession('sess-open-3', { stateDir })).rejects.toMatchObject({
        code: 'events.session-already-started',
      });

      // Refused before the write, not after it: an append-only log cannot take
      // one back, so the guard is worth nothing unless it runs first.
      expect(await readEvents('sess-open-3', { stateDir })).toHaveLength(1);
    });

    // The error has one job beyond refusing: say what to do instead. An
    // operator who reaches for `session start` on a live session wants the
    // anchor its next command needs, and the message names the event that is
    // already there.
    it('names the event the caller should have chained off', async () => {
      await startSession('sess-open-4', { stateDir });
      await expect(startSession('sess-open-4', { stateDir })).rejects.toThrow(/sess-open-4#0/);
    });

    // P9-7's continuation, which is the other legal shape of a root and was
    // three lines of hand-written JSON in the guide. The cross-session rules
    // are the writer's, unchanged -- this verb only fills the field.
    it('continues another session, and the lineage reads root first', async () => {
      await startSession('sess-open-5a', { stateDir });

      const { record } = await startSession('sess-open-5b', {
        stateDir,
        continues: 'sess-open-5a#0',
      });

      expect(record.causal_parent).toBe('sess-open-5a#0');
      expect(await sessionLineage('sess-open-5b', { stateDir })).toEqual([
        'sess-open-5a',
        'sess-open-5b',
      ]);
    });

    it('refuses to continue an event that is not there', async () => {
      await expect(
        startSession('sess-open-6', { stateDir, continues: 'sess-open-nowhere#0' }),
      ).rejects.toMatchObject({ code: 'events.unknown-causal-session' });

      // Nothing half-written: the session it refused to open has no log.
      expect(existsSync(path.join(stateDir, 'sess-open-6.jsonl'))).toBe(false);
    });

    // D-197 is the writer's rule and this verb inherits it rather than
    // restating it -- a session id is a file name before it is anything else.
    it('refuses a session id that is not a file name', async () => {
      await expect(startSession('../escape', { stateDir })).rejects.toMatchObject({
        code: 'events.malformed-session-id',
      });
    });
  });
});
