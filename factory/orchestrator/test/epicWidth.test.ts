import { describe, expect, it } from 'vitest';
import { summariseEpicWidth, UNMEASURED_HINT } from '../src/epicWidth.js';
import type { StoredEvent } from '../src/events.js';
import { UNOBSERVED_HINT } from '../src/waveConcurrency.js';

// ---------------------------------------------------------------------------
// The third half of the wave story, and the one that answers the question the
// other two cannot be asked.
//
// `wave schedule` says how wide a plan COULD run, `wave check` admits a wave,
// `wave audit` reads one live log back to see whether it ran that wide, and
// `epic close` now writes the answer permanently into `epic-closed`. Every one
// of those is scoped to a session an operator is standing in. None of them can
// answer the question the factory is actually judged on -- does this workshop
// build in parallel, or has every epic it ever closed been narrow?
//
// That question is about closes, not waves. A close is the record that
// outlives its lineage: the wave events behind it may be in a session nobody
// reads any more, and the width is preserved in the close regardless. So this
// folds `epic-closed` payloads, not `wave-admitted` events -- reading the
// permanent record rather than re-deriving it, which is also the only way to
// see the fact re-derivation structurally cannot: an epic that closed
// measuring NOTHING. `wave audit` sees waves that exist; only the closes can
// say how many closes carried no width at all.
// ---------------------------------------------------------------------------

let seq = 0;

function at(minutes: number): string {
  return `2026-09-02T${String(minutes).padStart(2, '0')}:00:00.000Z`;
}

interface CloseSpec {
  epicId?: string | null;
  sessionId?: string;
  project?: string | null;
  closedBy?: string;
  machineVerdict?: string | null;
  /** `undefined` omits the key entirely; `null` projects an explicit null. */
  concurrency?: Record<string, unknown> | null;
  ts?: string;
}

function close(spec: CloseSpec = {}): StoredEvent {
  seq += 1;
  const summary: Record<string, unknown> = { tasks: [] };
  if (spec.concurrency !== undefined) summary.concurrency = spec.concurrency;
  return {
    event_id: `e${seq}`,
    record: {
      session_id: spec.sessionId ?? 's1',
      actor: 'orchestrator',
      event_type: 'epic-closed',
      plan_version: 1,
      causal_parent: null,
      ...(spec.project !== undefined ? { project: spec.project ?? undefined } : {}),
      payload: {
        ...(spec.epicId === null ? {} : { epic_id: spec.epicId ?? `epic-${seq}` }),
        closed_by: spec.closedBy ?? 'verdict',
        machine_verdict: spec.machineVerdict ?? 'go',
        summary,
      },
      ts: spec.ts ?? at(seq),
    },
  };
}

/** A recorded width, in the shape `epicSummaryPayload` projects it. */
function width(
  verdicts: Partial<Record<string, number>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const counts = { parallel: 0, partial: 0, serialized: 0, single: 0, unobserved: 0, ...verdicts };
  const waves = Object.values(counts).reduce((n, c) => n + c, 0);
  return {
    waves,
    verdicts: counts,
    widest: { declared: waves > 0 ? 3 : 0, observed: waves > 0 ? 3 : 0 },
    unobserved: [],
    problem: null,
    ...extra,
  };
}

describe('summariseEpicWidth', () => {
  it('reads the width off the close rather than re-deriving it from waves', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: width({ parallel: 2 }) }),
    ]);

    expect(summary.epics).toHaveLength(1);
    expect(summary.epics[0]?.epicId).toBe('E1');
    expect(summary.epics[0]?.verdict).toBe('parallel');
    expect(summary.epics[0]?.waves).toBe(2);
    expect(summary.exitCode).toBe(0);
  });

  // The whole reason this reads closes instead of re-running `wave audit`.
  // An epic that closed with no measurement leaves no wave to re-derive from,
  // so a re-derivation cannot see it at all -- it reports the same silence for
  // "this epic was never measured" and "this epic has no closes". Named, so a
  // factory whose closes are mostly blank cannot read as a healthy one.
  it('separates a close that measured nothing from a close that measured zero waves', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: null }),
      close({ epicId: 'E2' }), // the key is absent: an older close, before the field existed
      close({ epicId: 'E3', concurrency: width({}) }), // measured, and there were no waves
    ]);

    // Newest close first, like every other list here.
    expect(summary.unmeasured).toEqual(['E2', 'E1']);
    expect(summary.verdicts.unmeasured).toBe(2);
    expect(summary.verdicts.unwaved).toBe(1);
    expect(summary.epics.find((e) => e.epicId === 'E3')?.verdict).toBe('unwaved');
  });

  // D-120 on this axis. An epic whose tasks genuinely depend on one another
  // has nothing to run side by side, and failing on that would make the exit
  // code a constant -- it would fire on every honest serial epic in the repo
  // and be routed to /dev/null inside a week, taking the real signal with it.
  it('does not fail an epic that never cut a wave, or one that only ever cut single-task waves', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: width({}) }),
      close({ epicId: 'E2', concurrency: width({ single: 4 }) }),
    ]);

    expect(summary.epics.map((e) => e.verdict)).toEqual(['single', 'unwaved']);
    expect(summary.serialized).toEqual([]);
    expect(summary.exitCode).toBe(0);
  });

  // The refutation `wave audit` exits 1 on, read off the permanent record:
  // admitted wide, ran one at a time. Same rule, same code, so an operator who
  // learned one has learned the other.
  it('fails on an epic whose record holds a wave that was admitted wide and ran narrow', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: width({ parallel: 1 }) }),
      close({ epicId: 'E2', concurrency: width({ serialized: 1, single: 2 }) }),
    ]);

    expect(summary.serialized).toEqual(['E2']);
    expect(summary.exitCode).toBe(1);
  });

  // Best-of, not worst-of. The question is whether the epic ever ran wide;
  // one serial wave inside an otherwise-parallel epic is the factory working,
  // and grading the epic by its narrowest wave would report every real build
  // as a failure. The serial wave is still named in `serialized` -- the
  // verdict summarises, it does not suppress.
  it('grades an epic by the widest verdict its waves reached, and still names the narrow one', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: width({ parallel: 1, serialized: 1 }) }),
    ]);

    expect(summary.epics[0]?.verdict).toBe('parallel');
    expect(summary.serialized).toEqual(['E1']);
    expect(summary.exitCode).toBe(1);
  });

  // A wave admitted with nothing dispatched under it is a declaration with no
  // work behind it -- exactly what epic.ts tells the judge is refutable. It is
  // not the same failure as running narrow, so it does not share the code.
  it('exits 2 on a close holding a wave the log recorded no work for', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: width({ unobserved: 1 }, { unobserved: ['s1#4'] }) }),
    ]);

    expect(summary.unobserved).toEqual(['E1']);
    expect(summary.exitCode).toBe(2);
    expect(summary.hint).toBe(UNOBSERVED_HINT);
  });

  // Nothing judged is not the same answer as everything passing, and an empty
  // state dir returning 0 would make a factory that has never closed an epic
  // read as a factory that closes them all in parallel.
  it('exits 2 when no close carried a width anybody could read', () => {
    const empty = summariseEpicWidth([]);
    expect(empty.exitCode).toBe(2);
    expect(empty.hint).toBe(UNMEASURED_HINT);

    const blank = summariseEpicWidth([close({ epicId: 'E1' }), close({ epicId: 'E2' })]);
    expect(blank.exitCode).toBe(2);
    expect(blank.hint).toBe(UNMEASURED_HINT);
  });

  // The `problem` half of the close (D-21): the width could not be read, and
  // reporting it as zero waves would hand a reader a confident number nobody
  // measured. It is a data fault, not a narrow epic, so it never fails.
  it('reports a close whose width could not be read as unreadable, not as narrow', () => {
    const summary = summariseEpicWidth([
      close({
        epicId: 'E1',
        concurrency: {
          waves: 0,
          verdicts: { parallel: 0, partial: 0, serialized: 0, single: 0, unobserved: 0 },
          widest: { declared: 0, observed: 0 },
          unobserved: [],
          problem: 'wave-concurrency.missing-task-ids: wave-admitted "s1#4" names no tasks',
        },
      }),
    ]);

    expect(summary.epics[0]?.verdict).toBe('unreadable');
    expect(summary.epics[0]?.problem).toMatch(/names no tasks/);
    expect(summary.serialized).toEqual([]);
    expect(summary.exitCode).toBe(2);
  });

  // Last close wins, keyed on the payload's epic_id -- the rule foldEpics
  // already keeps. Re-closing an epic is a correction, and counting the
  // superseded close as a second epic would double every re-closed build.
  it('counts a re-closed epic once, taking the last close', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: width({ serialized: 1 }), ts: at(1) }),
      close({ epicId: 'E1', concurrency: width({ parallel: 1 }), ts: at(2) }),
    ]);

    expect(summary.epics).toHaveLength(1);
    expect(summary.epics[0]?.verdict).toBe('parallel');
    expect(summary.serialized).toEqual([]);
    expect(summary.exitCode).toBe(0);
  });

  // Same guard foldEpics keeps: an unattributed close has no epic to speak
  // for, and inferring one from task_id is the phantom-card bug D-43 fixed.
  it('drops a close that names no epic rather than inventing an id for it', () => {
    const summary = summariseEpicWidth([
      close({ epicId: null, concurrency: width({ parallel: 1 }) }),
      close({ epicId: 'E1', concurrency: width({ parallel: 1 }) }),
    ]);

    expect(summary.epics.map((e) => e.epicId)).toEqual(['E1']);
  });

  it('reports the widest width any closed epic reached', () => {
    const summary = summariseEpicWidth([
      close({
        epicId: 'E1',
        concurrency: width({ partial: 1 }, { widest: { declared: 5, observed: 2 } }),
      }),
      close({
        epicId: 'E2',
        concurrency: width({ parallel: 1 }, { widest: { declared: 3, observed: 3 } }),
      }),
    ]);

    expect(summary.widest).toEqual({ declared: 5, observed: 3 });
  });

  // Newest close first, for the reason `closedEpics` already orders that way:
  // the operator reading this wants the builds that just happened, and a
  // chronological list buries them under every epic the factory ever closed.
  it('orders the epics newest close first', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', ts: at(1), concurrency: width({ parallel: 1 }) }),
      close({ epicId: 'E2', ts: at(3), concurrency: width({ parallel: 1 }) }),
      close({ epicId: 'E3', ts: at(2), concurrency: width({ parallel: 1 }) }),
    ]);

    expect(summary.epics.map((e) => e.epicId)).toEqual(['E2', 'E3', 'E1']);
  });

  // A malformed payload is a fact about the log, not a reason to lose every
  // other close in it. Same shape as the close's own `problem` field: report
  // the one that cannot be read and keep reading the rest.
  it('reports a close whose recorded width is not the shape it should be', () => {
    const summary = summariseEpicWidth([
      close({ epicId: 'E1', concurrency: { waves: 'lots' } as unknown as Record<string, unknown> }),
      close({ epicId: 'E2', concurrency: width({ parallel: 1 }) }),
    ]);

    expect(summary.epics.find((e) => e.epicId === 'E1')?.verdict).toBe('unreadable');
    expect(summary.epics.find((e) => e.epicId === 'E1')?.problem).toMatch(/epic-width/);
    expect(summary.epics.find((e) => e.epicId === 'E2')?.verdict).toBe('parallel');
  });

  it('carries the close attribution, so a narrow epic can be traced to who closed it', () => {
    const summary = summariseEpicWidth([
      close({
        epicId: 'E1',
        sessionId: 's7',
        project: 'envkit',
        closedBy: 'operator-override',
        machineVerdict: 'no-go',
        concurrency: width({ serialized: 1 }),
      }),
    ]);

    expect(summary.epics[0]).toMatchObject({
      epicId: 'E1',
      sessionId: 's7',
      project: 'envkit',
      closedBy: 'operator-override',
      machineVerdict: 'no-go',
    });
  });
});
