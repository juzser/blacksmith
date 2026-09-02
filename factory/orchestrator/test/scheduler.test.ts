import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRecord, StoredEvent } from '../src/events.js';
import { readEvents } from '../src/events.js';
import { SCHEDULER_POLICY_PATH } from '../src/paths.js';
import {
  computeProposals,
  loadSchedulerPolicy,
  parsePnpmOutdated,
  parseSchedulerPolicy,
  proposeGrowthReview,
  proposeMaintenance,
  proposeRechecks,
  runPnpmOutdated,
  runScheduler,
  SchedulerError,
} from '../src/scheduler.js';

const POLICY = parseSchedulerPolicy(`
recheck:
  merge_threshold: 3
  days_elapsed: 10
  confidence_threshold: 0.6
maintenance:
  auto_schedule_confidence: 0.8
  major_bump_confidence: 0.5
  minor_or_patch_confidence: 0.9
growth:
  cadence_days: 30
`);

let seq = 0;

/** Builds a minimal StoredEvent — scheduler.ts's pure functions never validate against event.schema.json. */
function ev(partial: Partial<EventRecord> & { event_type: string }): StoredEvent {
  seq += 1;
  const record: EventRecord = {
    ts: partial.ts ?? '2026-08-01T00:00:00.000Z',
    session_id: 'sess-1',
    actor: partial.actor ?? 'system',
    event_type: partial.event_type,
    task_id: partial.task_id,
    plan_version: partial.plan_version ?? 1,
    causal_parent: partial.causal_parent ?? null,
    payload: partial.payload ?? {},
  };
  return { event_id: `sess-1#${seq}`, record };
}

function taskAdded(taskId: string, claims: string[], origin = 'user'): StoredEvent {
  return ev({
    event_type: 'task-added',
    task_id: taskId,
    payload: { epic_id: 'epic-1', case: 'feature', origin, task_status: 'todo', claims },
  });
}

function mergedAt(taskId: string, ts: string): StoredEvent {
  return ev({ event_type: 'wave-merged', ts, payload: { epic_id: 'epic-1', task_ids: [taskId] } });
}

/** Mirrors what runScheduler() actually appends for a RecheckProposal (payload.taskId, camelCase — see scheduler.ts's comment). */
function recheckProposed(taskId: string, ts = '2026-08-01T00:00:00.000Z'): StoredEvent {
  return ev({ event_type: 'recheck-proposed', ts, payload: { kind: 'recheck', taskId } });
}

/** A new recheck task explicitly created for `recheckOfTaskId` — resolves its pending proposal. */
function taskAddedRecheckOf(newTaskId: string, recheckOfTaskId: string, ts: string): StoredEvent {
  return ev({
    event_type: 'task-added',
    task_id: newTaskId,
    ts,
    payload: {
      epic_id: 'epic-1',
      case: 'recheck',
      origin: 'recheck',
      task_status: 'todo',
      claims: [],
      recheck_of: recheckOfTaskId,
    },
  });
}

/** The operator explicitly declined a recheck proposal for `taskId` — resolves it. */
function recheckDeclined(taskId: string, ts: string): StoredEvent {
  return ev({ event_type: 'recheck-declined', ts, payload: { task_id: taskId } });
}

describe('parseSchedulerPolicy / loadSchedulerPolicy', () => {
  it('parses knobs from YAML', () => {
    expect(POLICY.recheck).toEqual({
      mergeThreshold: 3,
      daysElapsed: 10,
      confidenceThreshold: 0.6,
    });
    expect(POLICY.growth).toEqual({ cadenceDays: 30 });
  });

  it('rejects a document missing a required section', () => {
    expect(() => parseSchedulerPolicy('recheck:\n  merge_threshold: 1\n')).toThrow(SchedulerError);
  });

  // D-203. The two lessons knobs feed the novelty gate directly, and both
  // degenerate values void it silently and in opposite directions: a
  // shingle_size of 0 shingles every statement to {""} so everything scores
  // 1.0 and every candidate is auto-rejected; a non-numeric threshold makes
  // every comparison NaN so nothing is ever redundant. `??` defaults only on
  // null/undefined, so neither was caught.
  const withLessons = (lessons: string): string =>
    `recheck:\n  merge_threshold: 3\nmaintenance:\n  auto_schedule_confidence: 0.8\ngrowth:\n  cadence_days: 30\nlessons:\n${lessons}`;

  it('rejects a shingle_size below 1 (every statement shingles to one empty gram)', () => {
    expect(() => parseSchedulerPolicy(withLessons('  shingle_size: 0\n'))).toThrow(SchedulerError);
    expect(() => parseSchedulerPolicy(withLessons('  shingle_size: -1\n'))).toThrow(SchedulerError);
  });

  it('rejects a non-integer shingle_size (a fractional window has no meaning)', () => {
    expect(() => parseSchedulerPolicy(withLessons('  shingle_size: 2.5\n'))).toThrow(
      SchedulerError,
    );
  });

  it('rejects a novelty threshold outside (0, 1]', () => {
    expect(() => parseSchedulerPolicy(withLessons('  novelty_jaccard_threshold: 0\n'))).toThrow(
      SchedulerError,
    );
    expect(() => parseSchedulerPolicy(withLessons('  novelty_jaccard_threshold: 1.5\n'))).toThrow(
      SchedulerError,
    );
  });

  it('rejects a non-numeric novelty threshold rather than comparing against NaN', () => {
    expect(() => parseSchedulerPolicy(withLessons('  novelty_jaccard_threshold: high\n'))).toThrow(
      SchedulerError,
    );
  });

  it('still accepts the boundary values a working gate uses', () => {
    const policy = parseSchedulerPolicy(
      withLessons('  novelty_jaccard_threshold: 1\n  shingle_size: 1\n'),
    );
    expect(policy.lessons).toEqual({
      noveltyJaccardThreshold: 1,
      shingleSize: 1,
      noveltyLengthAware: true,
    });
  });

  // The third lessons knob is a boolean, and the failure mode is the mirror
  // image of the numeric ones: YAML 1.2 reads `off`/`no` as strings, every
  // non-empty string is truthy, so an operator switching the length
  // correction OFF would have switched it on and been told nothing.
  it('rejects a length-aware knob that is not a boolean, however it reads', () => {
    for (const value of ['off', 'no', '"false"', '0']) {
      expect(() => parseSchedulerPolicy(withLessons(`  novelty_length_aware: ${value}\n`))).toThrow(
        SchedulerError,
      );
    }
  });

  it('accepts the correction being switched off, and defaults it on', () => {
    expect(
      parseSchedulerPolicy(withLessons('  novelty_length_aware: false\n')).lessons
        .noveltyLengthAware,
    ).toBe(false);
    expect(
      parseSchedulerPolicy(withLessons('  shingle_size: 3\n')).lessons.noveltyLengthAware,
    ).toBe(true);
  });

  // The same class one file over, already reasoned out for `--now` (D-209):
  // a value the comparison cannot read does not fail, it changes the answer,
  // and in a different direction at each knob it reaches. Only the two
  // `lessons` knobs above were checked. The six beside them were read with
  // `??`, which defaults on null/undefined only, so a YAML typo arrived at the
  // comparison as itself -- and the declared `number` type said otherwise.
  const withKnobs = (recheck: string, growth: string): string =>
    `recheck:\n${recheck}maintenance:\n  auto_schedule_confidence: 0.8\ngrowth:\n${growth}`;

  it('rejects a days_elapsed the comparison cannot read (nothing is ever due)', () => {
    // `999 >= 'fourteen'` is false, so a task untouched for three years never
    // proposes `time-elapsed`. Fails CLOSED: the operator asks what is due and
    // the typo answers "nothing".
    expect(() =>
      parseSchedulerPolicy(withKnobs('  days_elapsed: fourteen\n', '  cadence_days: 30\n')),
    ).toThrow(SchedulerError);
  });

  it('rejects a cadence_days the comparison cannot read (the review fires every run)', () => {
    // `0.001 < 'monthly'` is false, so `proposeGrowthReview` never returns
    // null and the growth review fires on every pass regardless of cadence.
    // Fails OPEN -- the opposite direction, from the same typo.
    expect(() =>
      parseSchedulerPolicy(withKnobs('  days_elapsed: 10\n', '  cadence_days: monthly\n')),
    ).toThrow(SchedulerError);
  });

  it('rejects an infinite knob, which is a number and compares like a wall', () => {
    // `.inf` survives `typeof value === 'number'`, so finiteness is the check
    // that matters: no merge count ever reaches it and the reason is unfirable.
    expect(() =>
      parseSchedulerPolicy(withKnobs('  merge_threshold: .inf\n', '  cadence_days: 30\n')),
    ).toThrow(SchedulerError);
  });

  it('names the field and the value, because the policy file is hand-edited', () => {
    expect(() =>
      parseSchedulerPolicy(withKnobs('  days_elapsed: fourteen\n', '  cadence_days: 30\n')),
    ).toThrow(/recheck\.days_elapsed.*"fourteen"/s);
  });

  it('still accepts a document that omits every optional knob', () => {
    // The check is on the value a knob has, not on the knob being present:
    // every default below is what `??` supplies, and all of them must survive.
    const policy = parseSchedulerPolicy(
      withKnobs('  merge_threshold: 3\n', '  cadence_days: 30\n'),
    );
    expect(policy.recheck.daysElapsed).toBe(14);
    expect(policy.recheck.confidenceThreshold).toBe(0.6);
    expect(policy.maintenance.majorBumpConfidence).toBe(0.5);
    expect(policy.maintenance.minorOrPatchConfidence).toBe(0.9);
  });

  it('loads the real factory/policies/scheduler.yml', () => {
    const policy = loadSchedulerPolicy(SCHEDULER_POLICY_PATH);
    expect(policy.recheck.mergeThreshold).toBeGreaterThan(0);
    expect(policy.growth.cadenceDays).toBeGreaterThan(0);
    // Pinned, not merely parsed: this list is the ceiling on what runs
    // without a person, so widening it should have to argue with a test.
    expect(policy.autonomy.autoDispatchKinds).not.toContain('growth-review-due');
    expect(policy.autonomy.autoDispatchRecheckReasons).not.toContain('low-confidence');
  });

  describe('the autonomy block', () => {
    // Absent means off, and off means empty: a clone that deletes the block,
    // or a scheduler.yml written before autonomy existed, must not inherit
    // this repo's answer to "what may run without me". Every default here
    // fails closed, so the only way to get auto-dispatch is to ask for it.
    it('defaults to nothing being auto-dispatchable when the block is absent', () => {
      const policy = parseSchedulerPolicy(withKnobs('  merge_threshold: 3\n', '  cadence_days: 30\n'));
      expect(policy.autonomy.enabled).toBe(false);
      expect(policy.autonomy.autoDispatchKinds).toEqual([]);
      expect(policy.autonomy.autoDispatchRecheckReasons).toEqual([]);
      expect(policy.autonomy.confidenceFloor).toBe(0.8);
    });

    it('reads a declared block', () => {
      const policy = parseSchedulerPolicy(`
recheck:
  merge_threshold: 3
maintenance:
  auto_schedule_confidence: 0.8
growth:
  cadence_days: 30
autonomy:
  enabled: true
  auto_dispatch_kinds: [recheck, maintenance]
  auto_dispatch_recheck_reasons: [merge-threshold, time-elapsed]
  confidence_floor: 0.9
`);
      expect(policy.autonomy).toEqual({
        enabled: true,
        autoDispatchKinds: ['recheck', 'maintenance'],
        autoDispatchRecheckReasons: ['merge-threshold', 'time-elapsed'],
        confidenceFloor: 0.9,
      });
    });

    // `auto_dispatch_kinds: recheck` (no brackets) spreads to
    // ['r','e','c','h','e','c','k'] — seven kinds that match nothing. It
    // would fail closed, which is the safe direction and exactly why it
    // needs to be loud: silence here reads as "autonomy is on" while
    // nothing is ever admitted.
    it('refuses a bare string where a list belongs', () => {
      expect(() =>
        parseSchedulerPolicy(
          withKnobs('  merge_threshold: 3\n', '  cadence_days: 30\n') +
            'autonomy:\n  auto_dispatch_kinds: recheck\n',
        ),
      ).toThrow(/auto_dispatch_kinds/);
    });

    // A closed vocabulary, so a typo is knowable. `maintenence` would
    // otherwise disable maintenance auto-dispatch in silence.
    it('refuses a kind or reason outside the vocabulary', () => {
      expect(() =>
        parseSchedulerPolicy(
          withKnobs('  merge_threshold: 3\n', '  cadence_days: 30\n') +
            'autonomy:\n  auto_dispatch_kinds: [maintenence]\n',
        ),
      ).toThrow(/maintenence/);
      expect(() =>
        parseSchedulerPolicy(
          withKnobs('  merge_threshold: 3\n', '  cadence_days: 30\n') +
            'autonomy:\n  auto_dispatch_recheck_reasons: [whenever]\n',
        ),
      ).toThrow(/whenever/);
    });

    // Same trap parseSchedulerPolicy already documents for the lessons flag:
    // YAML 1.2 reads `off` as the string "off", and every non-empty string is
    // truthy, so an operator switching autonomy off would have switched it on.
    it('refuses a non-boolean enabled', () => {
      expect(() =>
        parseSchedulerPolicy(
          withKnobs('  merge_threshold: 3\n', '  cadence_days: 30\n') +
            'autonomy:\n  enabled: "off"\n',
        ),
      ).toThrow(/autonomy.enabled/);
    });
  });
});

describe('proposeRechecks', () => {
  it('proposes nothing for a task with no later overlapping merges, recent and confident', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-02T00:00:00.000Z');
    expect(proposeRechecks(events, now, POLICY.recheck)).toEqual([]);
  });

  it('flags merge-threshold once enough LATER merges touch overlapping claims', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      taskAdded('epic-1/task-2', ['src/a.ts']),
      mergedAt('epic-1/task-2', '2026-08-01T01:00:00.000Z'),
      taskAdded('epic-1/task-3', ['src/a.ts']),
      mergedAt('epic-1/task-3', '2026-08-01T02:00:00.000Z'),
      taskAdded('epic-1/task-4', ['src/a.ts']),
      mergedAt('epic-1/task-4', '2026-08-01T03:00:00.000Z'),
    ];
    const now = new Date('2026-08-01T04:00:00.000Z'); // < 10 days, so time-elapsed does not also fire
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      taskId: 'epic-1/task-1',
      reasons: ['merge-threshold'],
      mergeCount: 3,
    });
  });

  it('flags time-elapsed once T days have passed', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-15T00:00:00.000Z'); // 14 days later
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals[0]).toMatchObject({ taskId: 'epic-1/task-1', reasons: ['time-elapsed'] });
  });

  it('flags low-confidence from the task-result-recorded payload', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      ev({
        event_type: 'task-result-recorded',
        task_id: 'epic-1/task-1',
        payload: { task_id: 'epic-1/task-1', structured_output: { confidence: 0.2 } },
      }),
      mergedAt('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-01T01:00:00.000Z');
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals[0]).toMatchObject({ reasons: ['low-confidence'], confidence: 0.2 });
  });

  it('flags low-confidence when the result event spells the task id bare', () => {
    // `smith gate run` stamps whichever spelling the operator typed, so the
    // same task reaches the log qualified from `task-added` and bare from its
    // result. foldTasks folds both into one row; the confidence lookup has to
    // agree with that row or the reason can never fire (D-182).
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      ev({
        event_type: 'task-result-recorded',
        task_id: 'task-1',
        payload: { task_id: 'task-1', structured_output: { confidence: 0.2 } },
      }),
      mergedAt('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-01T01:00:00.000Z');
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals[0]).toMatchObject({
      taskId: 'epic-1/task-1',
      reasons: ['low-confidence'],
      confidence: 0.2,
    });
  });

  it('refuses to guess a bare confidence two epics both claim that id for', () => {
    // The projector deliberately aliases nothing when a bare id is ambiguous;
    // guessing would charge one epic's low confidence to the other's task.
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      ev({
        event_type: 'task-added',
        task_id: 'epic-2/task-1',
        payload: {
          epic_id: 'epic-2',
          case: 'feature',
          origin: 'user',
          task_status: 'todo',
          claims: ['src/b.ts'],
        },
      }),
      ev({
        event_type: 'task-result-recorded',
        task_id: 'task-1',
        payload: { task_id: 'task-1', structured_output: { confidence: 0.2 } },
      }),
      mergedAt('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      ev({
        event_type: 'wave-merged',
        ts: '2026-08-01T00:00:00.000Z',
        payload: { epic_id: 'epic-2', task_ids: ['epic-2/task-1'] },
      }),
    ];
    const now = new Date('2026-08-01T01:00:00.000Z');
    expect(proposeRechecks(events, now, POLICY.recheck)).toEqual([]);
  });

  it('excludes tasks that are not completed, and tasks whose origin is already "recheck"', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']), // never merged -> not completed
      taskAdded('epic-1/task-2', ['src/b.ts'], 'recheck'),
      mergedAt('epic-1/task-2', '2026-01-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-01T00:00:00.000Z');
    expect(proposeRechecks(events, now, POLICY.recheck)).toEqual([]);
  });

  it('combines multiple reasons on the same task', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-01T00:00:00.000Z'); // long past days_elapsed
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals[0]?.reasons).toContain('time-elapsed');
  });

  it("is idempotent: running twice on the same log (second run sees the first run's own recheck-proposed event) proposes only once", () => {
    const baseEvents = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-01T00:00:00.000Z');

    const firstRun = proposeRechecks(baseEvents, now, POLICY.recheck);
    expect(firstRun).toHaveLength(1);
    expect(firstRun[0]?.taskId).toBe('epic-1/task-1');

    // Simulate runScheduler() having appended the proposal as an event —
    // this is exactly what a second `smith scheduler run` would read back.
    const eventsAfterFirstRun = [...baseEvents, recheckProposed('epic-1/task-1')];
    const secondRun = proposeRechecks(eventsAfterFirstRun, now, POLICY.recheck);
    expect(secondRun).toEqual([]); // no duplicate — still unresolved
  });

  it('proposes again once the prior recheck-proposed is resolved by a real recheck task', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
      recheckProposed('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      taskAddedRecheckOf('epic-1/task-5', 'epic-1/task-1', '2026-08-02T00:00:00.000Z'),
    ];
    // Criteria still trip (still time-elapsed) after the resolving event.
    const now = new Date('2026-08-20T00:00:00.000Z');
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.taskId).toBe('epic-1/task-1');
  });

  it('proposes again once the prior recheck-proposed is resolved by an explicit decline', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
      recheckProposed('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      recheckDeclined('epic-1/task-1', '2026-08-02T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-20T00:00:00.000Z');
    const proposals = proposeRechecks(events, now, POLICY.recheck);
    expect(proposals).toHaveLength(1);
  });

  it('does NOT resolve on an unrelated event referencing a different task (narrow predicate, fails closed)', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
      recheckProposed('epic-1/task-1', '2026-08-01T00:00:00.000Z'),
      taskAddedRecheckOf('epic-1/task-9', 'epic-1/task-OTHER', '2026-08-02T00:00:00.000Z'),
    ];
    const now = new Date('2026-08-20T00:00:00.000Z');
    expect(proposeRechecks(events, now, POLICY.recheck)).toEqual([]);
  });
});

describe('parsePnpmOutdated / proposeMaintenance', () => {
  it('parses pnpm outdated --json shape', () => {
    const json = JSON.stringify({
      lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
      vite: { current: '5.0.0', wanted: '5.0.0', latest: '6.0.0' },
    });
    expect(parsePnpmOutdated(json)).toEqual([
      { name: 'lodash', current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
      { name: 'vite', current: '5.0.0', wanted: '5.0.0', latest: '6.0.0' },
    ]);
  });

  it('returns null for a project with no pnpm workspace to run outdated against', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'smith-scheduler-'));
    try {
      expect(runPnpmOutdated(scratch)).toBeNull();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('returns null (never proposes) when there is nothing outdated', () => {
    expect(proposeMaintenance([], POLICY.maintenance)).toBeNull();
  });

  it('is auto-schedulable at high confidence for patch/minor-only bumps', () => {
    const proposal = proposeMaintenance(
      [{ name: 'lodash', current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }],
      POLICY.maintenance,
    );
    expect(proposal).toMatchObject({ confidence: 0.9, autoSchedulable: true });
  });

  it('is NOT auto-schedulable when a major-version bump is present', () => {
    const proposal = proposeMaintenance(
      [{ name: 'vite', current: '5.0.0', wanted: '5.0.0', latest: '6.0.0' }],
      POLICY.maintenance,
    );
    expect(proposal).toMatchObject({ confidence: 0.5, autoSchedulable: false });
  });
});

describe('proposeGrowthReview', () => {
  it('fires immediately when no growth-review-due event has ever been emitted', () => {
    const proposal = proposeGrowthReview([], new Date('2026-08-01T00:00:00.000Z'), POLICY.growth);
    expect(proposal).toEqual({ kind: 'growth-review-due', cadenceDays: 30, lastReviewAt: null });
  });

  it('does not fire again before the cadence elapses', () => {
    const events = [ev({ event_type: 'growth-review-due', ts: '2026-08-01T00:00:00.000Z' })];
    const now = new Date('2026-08-15T00:00:00.000Z'); // 14 days < 30
    expect(proposeGrowthReview(events, now, POLICY.growth)).toBeNull();
  });

  it('fires again once the cadence elapses', () => {
    const events = [ev({ event_type: 'growth-review-due', ts: '2026-08-01T00:00:00.000Z' })];
    const now = new Date('2026-09-05T00:00:00.000Z'); // 35 days
    expect(proposeGrowthReview(events, now, POLICY.growth)).toMatchObject({
      lastReviewAt: '2026-08-01T00:00:00.000Z',
    });
  });
});

describe('computeProposals (no projectDir -> maintenance pass skipped)', () => {
  it('combines recheck + growth-review-due proposals, deterministically', () => {
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
    ];
    const proposals = computeProposals({
      events,
      now: new Date('2026-08-01T00:00:00.000Z'),
      policy: POLICY,
    });
    expect(proposals.map((p) => p.kind).sort()).toEqual(['growth-review-due', 'recheck']);
  });
});

describe('runScheduler', () => {
  let stateDir: string;

  afterEach(() => {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it('dryRun computes proposals without appending events', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'smith-scheduler-run-'));
    const events = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
    ];
    const ctx = { sessionId: 'sess-run', planVersion: 1, causalParent: 'sess-run#0' };

    const result = await runScheduler(
      { events, now: new Date('2026-08-01T00:00:00.000Z'), policy: POLICY },
      ctx,
      { stateDir },
      true,
    );
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.eventIds).toEqual([]);
  });

  it('appends one chained event per proposal when not a dry run', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'smith-scheduler-run-'));
    const { appendEvent } = await import('../src/events.js');
    const root = await appendEvent(
      {
        session_id: 'sess-run2',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );

    const fixtureEvents = [
      taskAdded('epic-1/task-1', ['src/a.ts']),
      mergedAt('epic-1/task-1', '2026-01-01T00:00:00.000Z'),
    ];
    const ctx = { sessionId: 'sess-run2', planVersion: 1, causalParent: root.event_id };

    const result = await runScheduler(
      { events: fixtureEvents, now: new Date('2026-08-01T00:00:00.000Z'), policy: POLICY },
      ctx,
      { stateDir },
      false,
    );
    expect(result.eventIds.length).toBe(result.proposals.length);

    const logged = await readEvents('sess-run2', { stateDir });
    const proposalEvents = logged.filter((e) => e.record.event_type !== 'session-start');
    expect(proposalEvents.map((e) => e.record.event_type).sort()).toEqual(
      ['growth-review-due', 'recheck-proposed'].sort(),
    );

    // Verify the causal chain: every event, after the root, points at the
    // event immediately before it in the log.
    for (let i = 1; i < logged.length; i++) {
      expect(logged[i]?.record.causal_parent).toBe(logged[i - 1]?.event_id);
    }
  });
});

// pnpm itself must be reachable for runPnpmOutdated's "when available"
// fallback test above to be meaningful, not a false pass from a missing binary.
describe('environment sanity', () => {
  it('has pnpm on PATH', () => {
    expect(() => execFileSync('pnpm', ['--version'])).not.toThrow();
  });
});
