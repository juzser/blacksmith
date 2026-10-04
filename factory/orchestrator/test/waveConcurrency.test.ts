import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import {
  auditWaveConcurrency,
  summariseWaveConcurrency,
  WAVE_VERDICTS,
} from '../src/waveConcurrency.js';

// ---------------------------------------------------------------------------
// The second half of the wave story. `wave next` computes the widest wave a
// plan admits and `wave check` admits one, and between them they are the whole
// of what this repo says about running tasks side by side -- both of them
// statements about the FUTURE. Nothing ever read the log back to ask whether
// the wave that was admitted four wide actually ran four wide, or whether the
// dispatcher took them one at a time and the parallelism existed only in the
// admission.
//
// That is the declarations-vs-state gap again (AGENTS.md), on the axis the
// factory is supposed to be about: a build "by many subagents running the
// plan's tasks in parallel" that quietly serialises is indistinguishable, from
// the outside, from one that did not.
//
// The facts were already all in the log. `wave-admitted` names the width that
// was promised; `dispatch_decision` and its terminal events say when each
// agent was actually live, and agents-registry.ts already folds exactly that
// pair into intervals. So this is a fold, not a new table.
// ---------------------------------------------------------------------------

let seq = 0;

function at(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `2026-09-02T00:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
}

function ev(
  eventType: string,
  ts: string,
  payload: Record<string, unknown>,
  taskId?: string,
  causalParent: string | null = null,
): StoredEvent {
  seq += 1;
  return {
    event_id: `e${seq}`,
    record: {
      session_id: 's1',
      actor: 'system',
      event_type: eventType,
      task_id: taskId,
      plan_version: 1,
      causal_parent: causalParent,
      payload,
      ts,
    },
  };
}

function admitted(ts: string, taskIds: string[], epicId: string | null = 'E1'): StoredEvent {
  return ev('wave-admitted', ts, {
    ...(epicId ? { epic_id: epicId } : {}),
    task_ids: taskIds,
  });
}

/** A dispatch carrying the three fields agents-registry.ts requires of one. */
function dispatch(ts: string, taskId: string, role = 'coder'): StoredEvent {
  return ev(
    'dispatch_decision',
    ts,
    { agent_role: role, provider: 'claude', model_tier: 'frontier', model: 'claude-opus-5' },
    taskId,
  );
}

function result(ts: string, taskId: string, role = 'coder'): StoredEvent {
  return ev('task-result-recorded', ts, { agent: role }, taskId);
}

/** A `wave-merged` for one task, as `emitWaveMerged` writes it. */
function merged(ts: string, taskId: string): StoredEvent {
  return ev('wave-merged', ts, { task_ids: [taskId] }, taskId);
}

/**
 * A dispatch carrying no task id, parented directly on a `wave-admitted`
 * event -- the shape a wave-runner's own agent takes when the epic admits a
 * wave and dispatches an off-lineage session to run it.
 */
function parentedDispatch(parentEventId: string, ts: string, role = 'coder'): StoredEvent {
  return ev(
    'dispatch_decision',
    ts,
    { agent_role: role, provider: 'claude', model_tier: 'frontier', model: 'claude-opus-5' },
    undefined,
    parentEventId,
  );
}

/** One task that ran from `from` to `to`, start to finish. */
function ran(from: number, to: number, taskId: string, role = 'coder'): StoredEvent[] {
  return [dispatch(at(from), taskId, role), result(at(to), taskId, role)];
}

describe('auditWaveConcurrency', () => {
  it('calls a wave parallel when every admitted task was in flight at once', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      ...ran(1, 9, 'E1-task-1'),
      ...ran(2, 8, 'E1-task-2'),
    ]);

    expect(waves).toHaveLength(1);
    expect(waves[0]?.declared).toEqual(['E1-task-1', 'E1-task-2']);
    expect(waves[0]?.peak).toBe(2);
    expect(waves[0]?.verdict).toBe('parallel');
    expect(waves[0]?.unobserved).toEqual([]);
    expect(waves[0]?.epicId).toBe('E1');
    expect(waves[0]?.admittedAt).toBe(at(0));
  });

  it('calls a wave serialized when the tasks ran one after another', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      ...ran(1, 5, 'E1-task-1'),
      ...ran(6, 9, 'E1-task-2'),
    ]);

    expect(waves[0]?.peak).toBe(1);
    expect(waves[0]?.verdict).toBe('serialized');
  });

  it('reads a handoff at the same instant as serial, not as overlap', () => {
    // t1 ends exactly when t2 begins. Counting that as concurrency is the
    // reading this command exists to refuse: a wave dispatched strictly one at
    // a time would score `parallel` on nothing but clock granularity.
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      ...ran(1, 5, 'E1-task-1'),
      ...ran(5, 9, 'E1-task-2'),
    ]);

    expect(waves[0]?.peak).toBe(1);
    expect(waves[0]?.verdict).toBe('serialized');
  });

  it('calls a wave partial when it ran narrower than it was admitted', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2', 'E1-task-3']),
      ...ran(1, 9, 'E1-task-1'),
      ...ran(2, 8, 'E1-task-2'),
      ...ran(10, 20, 'E1-task-3'),
    ]);

    expect(waves[0]?.peak).toBe(2);
    expect(waves[0]?.verdict).toBe('partial');
  });

  it('does not score a one-task wave against a parallelism it never claimed', () => {
    const waves = auditWaveConcurrency([admitted(at(0), ['E1-task-1']), ...ran(1, 9, 'E1-task-1')]);

    expect(waves[0]?.verdict).toBe('single');
  });

  it('separates a wave nothing ran from a wave that ran serially', () => {
    const waves = auditWaveConcurrency([admitted(at(0), ['E1-task-1', 'E1-task-2'])]);

    expect(waves[0]?.verdict).toBe('unobserved');
    expect(waves[0]?.observed).toEqual([]);
    expect(waves[0]?.unobserved).toEqual(['E1-task-1', 'E1-task-2']);
    expect(waves[0]?.peak).toBe(0);
  });

  it('names the admitted tasks the log holds no dispatch for', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2', 'E1-task-3']),
      ...ran(1, 9, 'E1-task-1'),
      ...ran(2, 8, 'E1-task-2'),
    ]);

    expect(waves[0]?.unobserved).toEqual(['E1-task-3']);
    expect(waves[0]?.peak).toBe(2);
    // Two of three overlapped, so the wave did run in parallel -- just not as
    // wide as it was admitted. The missing evidence is named, not folded into
    // the verdict.
    expect(waves[0]?.verdict).toBe('partial');
  });

  it('treats an agent that never reported as still running', () => {
    // No terminal event for task 1: it is live from :01 onwards, so task 2
    // dispatched at :06 overlaps it however late it starts.
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      dispatch(at(1), 'E1-task-1'),
      ...ran(6, 9, 'E1-task-2'),
    ]);

    expect(waves[0]?.peak).toBe(2);
    expect(waves[0]?.verdict).toBe('parallel');
    expect(waves[0]?.observed.find((t) => t.taskId === 'E1-task-1')?.endedAt).toBeNull();
  });

  it("spans a task's interval across every role that ran on it", () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      ...ran(1, 4, 'E1-task-1', 'coder'),
      ...ran(5, 12, 'E1-task-1', 'reviewer'),
      ...ran(10, 20, 'E1-task-2'),
    ]);

    const t1 = waves[0]?.observed.find((t) => t.taskId === 'E1-task-1');
    expect(t1?.startedAt).toBe(at(1));
    expect(t1?.endedAt).toBe(at(12));
    expect(t1?.roles).toEqual(['coder', 'reviewer']);
    // The coder was long done by :10, but the reviewer was not -- the task was
    // still work in progress, and that is what "in flight" means here.
    expect(waves[0]?.peak).toBe(2);
  });

  it('attributes a re-admitted task to the wave whose window its run falls in', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      ...ran(1, 5, 'E1-task-1'),
      ...ran(2, 6, 'E1-task-2'),
      admitted(at(10), ['E1-task-1', 'E1-task-3']),
      ...ran(11, 15, 'E1-task-1'),
      ...ran(20, 25, 'E1-task-3'),
    ]);

    expect(waves).toHaveLength(2);
    expect(waves[0]?.verdict).toBe('parallel');
    // The first wave must not borrow task 1's second run: that run belongs to
    // the admission that re-opened it, and counting it twice would let a later
    // parallel wave retro-fit an earlier serial one.
    expect(waves[0]?.observed.find((t) => t.taskId === 'E1-task-1')?.endedAt).toBe(at(5));
    expect(waves[1]?.verdict).toBe('serialized');
  });

  it('ignores dispatches that predate the admission', () => {
    const waves = auditWaveConcurrency([
      ...ran(1, 20, 'E1-task-1'),
      admitted(at(5), ['E1-task-1', 'E1-task-2']),
      ...ran(6, 9, 'E1-task-2'),
    ]);

    // Task 1's run started before anybody admitted it; the wave cannot claim
    // work that was already under way when it was cut.
    expect(waves[0]?.unobserved).toEqual(['E1-task-1']);
    expect(waves[0]?.verdict).toBe('serialized');
  });

  it('returns waves oldest first whatever order the log holds them in', () => {
    const waves = auditWaveConcurrency([
      admitted(at(30), ['E1-task-3']),
      admitted(at(10), ['E1-task-1']),
      admitted(at(20), ['E1-task-2']),
    ]);

    expect(waves.map((w) => w.admittedAt)).toEqual([at(10), at(20), at(30)]);
  });

  it('narrows to one epic when asked', () => {
    const waves = auditWaveConcurrency(
      [admitted(at(0), ['E1-task-1', 'E1-task-2']), admitted(at(10), ['E2-task-1'], 'E2')],
      { epicId: 'E2' },
    );

    expect(waves).toHaveLength(1);
    expect(waves[0]?.epicId).toBe('E2');
  });

  it('audits a wave whose admission named no epic', () => {
    const waves = auditWaveConcurrency([admitted(at(0), ['E1-task-1', 'E1-task-2'], null)]);

    expect(waves[0]?.epicId).toBeNull();
  });

  it('refuses a wave-admitted event that names no tasks', () => {
    expect(() => auditWaveConcurrency([ev('wave-admitted', at(0), { epic_id: 'E1' })])).toThrow(
      /wave-concurrency\.missing-task-ids/,
    );
  });

  it('ignores a dispatch the registry itself will not fold', () => {
    // agents-registry.ts skips a dispatch missing agent_role/provider/
    // model_tier -- the taxonomy requires all three. Such a task reads as
    // unobserved rather than as a zero-length run, because a dispatch nothing
    // can place in time is no evidence of when it ran.
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1-task-1', 'E1-task-2']),
      ev('dispatch_decision', at(1), { agent_role: 'coder' }, 'E1-task-1'),
      ...ran(2, 8, 'E1-task-2'),
    ]);

    expect(waves[0]?.unobserved).toEqual(['E1-task-1']);
  });

  // The bug this file exists to close: a wave-runner started with plain
  // `session start` has `causal_parent: null` on its root, so its own
  // dispatch_decisions never reach this fold -- but the epic's lineage still
  // holds `wave-merged` for the tasks it ran, or a dispatch_decision parented
  // directly on the admission. Either fact says work happened; `unobserved`
  // would say the opposite.
  it('classes a wave unlinked, not unobserved, when its tasks merged off-lineage', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['demo-epic/task-1', 'demo-epic/task-2']),
      merged(at(5), 'task-1'),
      merged(at(6), 'task-2'),
    ]);

    expect(waves[0]?.verdict).toBe('unlinked');
    expect(waves[0]?.observed).toEqual([]);
    expect(waves[0]?.unobserved).toEqual(['demo-epic/task-1', 'demo-epic/task-2']);
    expect(waves[0]?.peak).toBe(0);
  });

  it('matches wave-merged evidence across bare and qualified task id spellings', () => {
    // The merged event's task id is bare ("task-1"); the admission declared
    // it qualified ("demo-epic/task-1") -- the exact split D-130 exists for.
    // A second declared task with no evidence at all proves ANY match is
    // enough -- the wave does not need every task accounted for.
    const waves = auditWaveConcurrency([
      admitted(at(0), ['demo-epic/task-1', 'demo-epic/task-2']),
      merged(at(5), 'task-1'),
    ]);

    expect(waves[0]?.verdict).toBe('unlinked');
  });

  it('classes a wave unlinked when a dispatch is parented on its admission but carries no task id', () => {
    const admission = admitted(at(0), ['demo-epic/task-1', 'demo-epic/task-2']);
    const waves = auditWaveConcurrency([admission, parentedDispatch(admission.event_id, at(1))]);

    expect(waves[0]?.verdict).toBe('unlinked');
  });

  it('scopes merge evidence to the admission whose task id it matches', () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['demo-epic/task-1', 'demo-epic/task-2'], 'demo-epic'),
      admitted(at(10), ['demo-epic-w2/task-7', 'demo-epic-w2/task-8'], 'demo-epic-w2'),
      merged(at(5), 'task-1'),
    ]);

    // The merge names "task-1", which only matches the first admission's
    // declared tasks -- the second has neither a merge nor a dispatch behind
    // it, and stays unobserved rather than borrowing the first wave's proof.
    expect(waves[0]?.verdict).toBe('unlinked');
    expect(waves[1]?.verdict).toBe('unobserved');
  });

  it('does not let a bare merge under one epic credit another epic admitted in between', () => {
    // A/task-1 is admitted first; epic B is admitted later with a bare
    // "task-1" of its own and is the one that actually merges it. A has
    // nothing else on record, so it must stay unobserved rather than
    // borrowing B's merge through the bare-id fallback. Two declared tasks
    // each, so the wave is scored on evidence rather than on `single`.
    const waves = auditWaveConcurrency([
      admitted(at(0), ['A/task-1', 'A/task-2'], 'A'),
      admitted(at(3), ['task-1', 'task-9'], 'B'),
      merged(at(5), 'task-1'),
    ]);

    expect(waves[0]?.epicId).toBe('A');
    expect(waves[0]?.verdict).toBe('unobserved');
    expect(waves[1]?.epicId).toBe('B');
    expect(waves[1]?.verdict).toBe('unlinked');
  });

  it('does not credit a merge timestamped before the admission it would otherwise match', () => {
    const waves = auditWaveConcurrency([
      merged(at(5), 'task-1'),
      admitted(at(10), ['A/task-1', 'A/task-2'], 'A'),
    ]);

    expect(waves[0]?.verdict).toBe('unobserved');
  });

  it("sends a re-admitted task's merge to the latest preceding admission only", () => {
    const waves = auditWaveConcurrency([
      admitted(at(0), ['E1/task-1', 'E1/task-2'], 'E1'),
      admitted(at(10), ['E1/task-1', 'E1/task-2'], 'E1'),
      merged(at(15), 'task-1'),
    ]);

    expect(waves).toHaveLength(2);
    expect(waves[0]?.admittedAt).toBe(at(0));
    expect(waves[0]?.verdict).toBe('unobserved');
    expect(waves[1]?.admittedAt).toBe(at(10));
    expect(waves[1]?.verdict).toBe('unlinked');
  });

  it('scopes a parented dispatch to the admission event it names', () => {
    const first = admitted(at(0), ['demo-epic/task-1', 'demo-epic/task-2'], 'demo-epic');
    const second = admitted(at(10), ['demo-epic-w2/task-7', 'demo-epic-w2/task-8'], 'demo-epic-w2');
    const waves = auditWaveConcurrency([first, second, parentedDispatch(second.event_id, at(11))]);

    // The dispatch is parented on the SECOND admission's own event id; the
    // first has nothing on record at all and stays unobserved.
    expect(waves[0]?.verdict).toBe('unobserved');
    expect(waves[1]?.verdict).toBe('unlinked');
  });
});

describe('summariseWaveConcurrency', () => {
  it('scores a serialized wave as the failure it is', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([
        admitted(at(0), ['E1-task-1', 'E1-task-2']),
        ...ran(1, 5, 'E1-task-1'),
        ...ran(6, 9, 'E1-task-2'),
      ]),
    );

    expect(summary.serialized).toEqual(['E1']);
    expect(summary.exitCode).toBe(1);
    expect(summary.widest.declared).toBe(2);
    expect(summary.widest.observed).toBe(1);
  });

  it('scores a log that shows no wave running at all as unjudged, not clean', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([admitted(at(0), ['E1-task-1', 'E1-task-2'])]),
    );

    expect(summary.serialized).toEqual([]);
    expect(summary.unobserved).toHaveLength(1);
    expect(summary.exitCode).toBe(2);
    expect(summary.hint).toMatch(/dispatch_decision/);
    // And said only when there is something to say about.
    expect(summariseWaveConcurrency([]).hint).toBe('');
  });

  it('passes a wave that ran narrower than admitted but genuinely in parallel', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([
        admitted(at(0), ['E1-task-1', 'E1-task-2', 'E1-task-3']),
        ...ran(1, 9, 'E1-task-1'),
        ...ran(2, 8, 'E1-task-2'),
        ...ran(10, 20, 'E1-task-3'),
      ]),
    );

    // Reported, never failed: three declared and two in flight is the factory
    // working, and an exit code that cried about it would be ignored inside a
    // week.
    expect(summary.exitCode).toBe(0);
    expect(summary.partial).toEqual(['E1']);
  });

  it('passes a log with nothing but one-task waves', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([admitted(at(0), ['E1-task-1']), ...ran(1, 9, 'E1-task-1')]),
    );

    expect(summary.exitCode).toBe(0);
    expect(summary.waves).toHaveLength(1);
  });

  it('scores an empty log as clean rather than as a serial one', () => {
    const summary = summariseWaveConcurrency(auditWaveConcurrency([]));

    expect(summary.exitCode).toBe(0);
    expect(summary.waves).toEqual([]);
    expect(summary.widest.declared).toBe(0);
  });

  it('reports the widest wave the log ever actually ran', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([
        admitted(at(0), ['E1-task-1', 'E1-task-2']),
        ...ran(1, 9, 'E1-task-1'),
        ...ran(2, 8, 'E1-task-2'),
        admitted(at(30), ['E1-task-3', 'E1-task-4', 'E1-task-5']),
        ...ran(31, 39, 'E1-task-3'),
        ...ran(32, 38, 'E1-task-4'),
        ...ran(33, 37, 'E1-task-5'),
      ]),
    );

    expect(summary.widest.declared).toBe(3);
    expect(summary.widest.observed).toBe(3);
    expect(summary.exitCode).toBe(0);
  });

  it('names every serialized epic once, not once per wave', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([
        admitted(at(0), ['E1-task-1', 'E1-task-2']),
        ...ran(1, 5, 'E1-task-1'),
        ...ran(6, 9, 'E1-task-2'),
        admitted(at(20), ['E1-task-3', 'E1-task-4']),
        ...ran(21, 25, 'E1-task-3'),
        ...ran(26, 29, 'E1-task-4'),
      ]),
    );

    expect(summary.serialized).toEqual(['E1']);
    expect(summary.waves).toHaveLength(2);
  });

  it('separates a wave whose work merged off-lineage from one truly unobserved', () => {
    const summary = summariseWaveConcurrency(
      auditWaveConcurrency([
        admitted(at(0), ['demo-epic/task-1', 'demo-epic/task-2'], 'demo-epic'),
        merged(at(5), 'task-1'),
      ]),
    );

    expect(summary.unlinked).toEqual(['demo-epic']);
    expect(summary.unobserved).toEqual([]);
    // Work merged, so this is not the "nothing was judged" exit code.
    expect(summary.exitCode).toBe(0);
  });
});

describe('WAVE_VERDICTS', () => {
  // The order is neither alphabetical nor arbitrary. `epicWidth.ts` grades an
  // epic by the BEST verdict any of its waves reached, walking this list and
  // taking the first one with a count against it, so the list is widest first.
  // Restated by hand here on purpose: a sixth verdict appended to the end
  // would quietly become the worst outcome the factory knows about, and this
  // is what turns "where does it rank" into a decision somebody takes rather
  // than one the diff makes for them.
  it('is widest first, because that order is what grades an epic', () => {
    expect([...WAVE_VERDICTS]).toEqual([
      'parallel',
      'partial',
      'serialized',
      'single',
      'unlinked',
      'unobserved',
    ]);
  });

  // `WaveVerdict` is derived from this list, so every counter keyed by the
  // type gains a bucket the moment the list does, and no
  // `Record<WaveVerdict, number>` can be short one. The direction no type can
  // check is the opposite one: a verdict left in the list after the branch
  // that returned it was deleted is still a perfectly good string, and would
  // sit in every histogram at a permanent zero that reads like a measurement.
  // `verdictFor` is the only thing that mints a verdict, so its returns are
  // scraped back out of the source and held against the list.
  it('carries exactly the verdicts verdictFor can return', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'waveConcurrency.ts'),
      'utf8',
    );
    const body = /function verdictFor\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'verdictFor is still a function in waveConcurrency.ts').toBeDefined();

    const returned = new Set<string>();
    for (const m of (body as string).matchAll(/return '([a-z-]+)'/g)) returned.add(m[1] as string);
    expect([...returned].sort()).toEqual([...WAVE_VERDICTS].sort());
  });
});
