import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import { REPO_ROOT, STATE_EVENTS_DIR } from '../src/paths.js';
import { checkSameMistakeKpi, lessonReach } from '../src/sameMistakeKpi.js';
import type { LessonRule } from '../src/severity.js';

// ---------------------------------------------------------------------------
// Architecture §9.7 calls same-mistake detection "the factory's key quality KPI
// (target: monotonically decreasing)". The escalation exists (severity.ts), the
// tag exists (`judgment.same-mistake`), and `analytics()` already counts the
// raw per-day rate. What has never existed is anything that reads that rate as
// a KPI — that is, something that says whether it is going down, and refuses to
// say anything at all when the number could not have been other than zero.
//
// The second half is the whole point. This rate reads 0.00 in three different
// worlds and the log distinguishes none of them:
//
//   1. nothing repeated                              — the good one
//   2. no lesson in the corpus can escalate anything — today's actual state
//   3. the gate ran without --lessons at all          — cli.ts:1110, optional flag
//
// So the report is built like budgetAlarm.ts: the reading AND the instrument,
// with an explicit `unverifiable` that outranks a clean-looking number. The
// asymmetry is the same shape too, mirrored. There, unmeasured spend could only
// make the bill bigger, so a crossing was a fact. Here, a recorded repeat is a
// fact — the instrument demonstrably fired — so a rise survives any hole. Zero
// repeats is a claim about the instrument, and only honest once the instrument
// is shown to work.
// ---------------------------------------------------------------------------

let seq = 0;

function stored(
  eventType: string,
  payload: Record<string, unknown>,
  day = '2026-08-10',
): StoredEvent {
  const n = seq++;
  return {
    event_id: `sess-1#${n}`,
    record: {
      session_id: 'sess-1',
      actor: 'system',
      event_type: eventType,
      task_id: 'epic-1/task-1',
      plan_version: 1,
      causal_parent: 'sess-1#0',
      ts: `${day}T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
      payload,
    },
  };
}

/** One gate intake. `sameMistake` of them repeated an approved lesson. */
function intake(
  day: string,
  decisions: number,
  sameMistake: number,
  lessonsEscalating: number | null = 3,
): StoredEvent {
  return stored(
    'severity-decisions',
    {
      decisions: Array.from({ length: decisions }, (_, i) => ({
        fingerprint: `fp-${seq}-${i}`,
        finding_id: `f-${seq}-${i}`,
        original_severity: 'S3-minor',
        severity: i < sameMistake ? 'S2-major' : 'S3-minor',
        action: i < sameMistake ? 'block' : 'waiver-batch',
        same_mistake: i < sameMistake,
        matched_lesson_id: i < sameMistake ? 'lesson-1' : null,
      })),
      // The instrument record. `null` reproduces every event written before
      // this field existed — dogfood-envkit-1's seven intakes, all of them.
      ...(lessonsEscalating === null ? {} : { lessons_escalating: lessonsEscalating }),
    },
    day,
  );
}

function rule(over: Partial<LessonRule> = {}): LessonRule {
  return {
    lessonId: 'lesson-1',
    scope: 'claim-path',
    category: 'correctness',
    claimPath: 'src/**',
    // Required, and `''` is the contract's "not applicable" — the value the
    // parser writes for every scope but the one that selects on it (D-129).
    agentRole: '',
    caseType: '',
    statement: 'never do the thing again',
    ...over,
  };
}

const CORPUS: readonly LessonRule[] = [rule(), rule({ lessonId: 'lesson-2' })];
const OPTS = { sessionId: 'sess-1' };

describe('lessonReach — what the corpus could ever detect', () => {
  it('counts a lesson as escalating only when it has a category AND a file-scoped scope', () => {
    const reach = lessonReach([
      rule({ lessonId: 'ok-claim-path' }),
      rule({ lessonId: 'ok-stack-wide', scope: 'stack-wide', claimPath: '**' }),
      rule({ lessonId: 'ok-security', scope: 'security', claimPath: 'src/auth/**' }),
    ]);
    expect(reach.total).toBe(3);
    expect(reach.escalating).toBe(3);
    expect(reach.categoriesCovered).toEqual(['correctness']);
  });

  it('a category-less lesson never escalates, whatever its scope (severity.ts:194)', () => {
    const reach = lessonReach([rule({ category: '' }), rule({ lessonId: 'l2', category: '' })]);
    expect(reach.escalating).toBe(0);
    expect(reach.withoutCategory).toBe(2);
    expect(reach.categoriesCovered).toEqual([]);
  });

  it('agent-role and case-type scopes never participate in the per-file match', () => {
    const reach = lessonReach([
      rule({ scope: 'agent-role' }),
      rule({ lessonId: 'l2', scope: 'case-type' }),
    ]);
    expect(reach.escalating).toBe(0);
    expect(reach.nonFileScoped).toBe(2);
  });

  // The state this KPI actually shipped into: fourteen approved lessons, none
  // of which carries a finding_category, so the numerator is pinned at zero by
  // the corpus rather than by the factory's conduct.
  it('reports the real committed lessons.md, whatever it currently holds', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { REPO_ROOT } = await import('../src/paths.js');
    const { parseLessons } = await import('../src/severity.js');
    const parsed = parseLessons(
      readFileSync(path.join(REPO_ROOT, 'factory', 'policies', 'lessons.md'), 'utf8'),
    );
    const reach = lessonReach(parsed);
    expect(reach.total).toBe(parsed.length);
    expect(reach.escalating).toBeLessThanOrEqual(reach.total);
    expect(reach.withoutCategory + reach.escalating).toBeLessThanOrEqual(
      reach.total + reach.nonFileScoped,
    );
  });
});

describe('checkSameMistakeKpi — windows', () => {
  it('an intake that decided nothing is a silent day, not a 0% day', () => {
    seq = 0;
    const report = checkSameMistakeKpi([intake('2026-08-06', 0, 0)], CORPUS, OPTS);
    // The bug this exists to not repeat: analytics() buckets the day anyway and
    // reports rate 0, so a gate that saw no findings reads identically to a
    // gate that saw findings and cleared them all.
    expect(report.windows).toEqual([]);
    expect(report.silentDays).toEqual(['2026-08-06']);
    expect(report.totalDecisions).toBe(0);
  });

  it('folds several intakes on one day into one window', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-06', 2, 1), intake('2026-08-06', 2, 0), intake('2026-08-06', 0, 0)],
      CORPUS,
      OPTS,
    );
    expect(report.windows).toHaveLength(1);
    expect(report.windows[0]).toMatchObject({
      day: '2026-08-06',
      intakes: 3,
      emptyIntakes: 1,
      decisions: 4,
      sameMistake: 1,
      rate: 0.25,
    });
  });

  it('orders windows oldest first, so the trend reads left to right', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-09', 4, 1), intake('2026-08-07', 4, 2)],
      CORPUS,
      OPTS,
    );
    expect(report.windows.map((w) => w.day)).toEqual(['2026-08-07', '2026-08-09']);
  });
});

describe('checkSameMistakeKpi — the verdict', () => {
  it('a falling rate across two measured windows is on-target', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 2), intake('2026-08-09', 4, 1)],
      CORPUS,
      OPTS,
    );
    expect(report.status).toBe('on-target');
    expect(report.monotonic).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('a flat rate is on-target — "monotonically decreasing" is read as non-increasing', () => {
    // A strictly decreasing rate is unsatisfiable the moment it reaches zero.
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 1), intake('2026-08-09', 4, 1)],
      CORPUS,
      OPTS,
    );
    expect(report.status).toBe('on-target');
  });

  it('a rising rate is off-target and fails the check', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 1), intake('2026-08-09', 4, 3)],
      CORPUS,
      OPTS,
    );
    expect(report.status).toBe('off-target');
    expect(report.monotonic).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('one measured window is insufficient-history, not on-target', () => {
    seq = 0;
    const report = checkSameMistakeKpi([intake('2026-08-07', 4, 1)], CORPUS, OPTS);
    expect(report.status).toBe('insufficient-history');
    expect(report.ok).toBe(false);
  });

  it('a session with no severity-decisions at all is unverifiable, never clean', () => {
    seq = 0;
    const report = checkSameMistakeKpi([stored('gate-outcome', { pass: true })], CORPUS, OPTS);
    expect(report.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });
});

describe('checkSameMistakeKpi — the instrument outranks the reading', () => {
  it('zero repeats against a corpus that can escalate nothing is unverifiable', () => {
    seq = 0;
    const blindCorpus = [rule({ category: '' }), rule({ lessonId: 'l2', scope: 'agent-role' })];
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 0), intake('2026-08-09', 4, 0)],
      blindCorpus,
      OPTS,
    );
    expect(report.reach.escalating).toBe(0);
    expect(report.status).toBe('unverifiable');
    expect(report.detail).toMatch(/escalate/i);
  });

  it('an intake that recorded no instrument count is a hole, so the window is unverifiable', () => {
    // Every severity-decisions event written before `lessons_escalating`
    // existed. The gate may have held the whole corpus or nothing at all; the
    // log does not say, and "0%" from a gate that held nothing is not a fact
    // about the factory's conduct.
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 0, null), intake('2026-08-09', 4, 0, null)],
      CORPUS,
      OPTS,
    );
    expect(report.intakesWithoutInstrumentRecord).toBe(2);
    expect(report.status).toBe('unverifiable');
  });

  it('an intake that ran with no escalating lesson loaded is a blind intake', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 0, 0), intake('2026-08-09', 4, 0, 3)],
      CORPUS,
      OPTS,
    );
    expect(report.blindIntakes).toBe(1);
    expect(report.status).toBe('unverifiable');
  });

  // The mirror of budgetAlarm's monotonicity argument. There a crossing was a
  // fact because holes only add spend; here a recorded repeat is a fact because
  // the instrument had to fire to record it. A rise therefore outranks every
  // hole, rather than being downgraded to "we cannot tell".
  it('a proven rise outranks an unreadable instrument', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 1, null), intake('2026-08-09', 4, 3, null)],
      CORPUS,
      OPTS,
    );
    expect(report.intakesWithoutInstrumentRecord).toBe(2);
    expect(report.status).toBe('off-target');
  });
});

describe('checkSameMistakeKpi — a rise needs a measurable baseline', () => {
  // The asymmetry above is right about the window the repeat was recorded in,
  // and says nothing about the one before it. A rise is a comparison, and the
  // baseline it is measured against is one of the three zeros this module
  // exists to refuse: a gate holding no escalating lesson decides
  // `same_mistake: false` for every finding, so its window reads 0.00 whatever
  // the work was. Calling that a rise reports the corpus as the factory's
  // conduct — the exact substitution the header refuses for the level.

  it('a rise from a blind window is unverifiable, not off-target', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 10, 0, 0), intake('2026-08-09', 10, 1, 3)],
      CORPUS,
      OPTS,
    );
    expect(report.monotonic).toBe(false);
    expect(report.provenRises).toEqual([]);
    expect(report.status).toBe('unverifiable');
    expect(report.detail).toMatch(/could not have recorded a repeat/i);
  });

  it('a rise from a window with no instrument record and no repeat is unverifiable', () => {
    // The mirror of "a proven rise outranks an unreadable instrument" above:
    // there the baseline recorded a repeat, so its instrument had demonstrably
    // fired. Here it recorded none, and the log does not say it could have.
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 0, null), intake('2026-08-09', 4, 3, null)],
      CORPUS,
      OPTS,
    );
    expect(report.monotonic).toBe(false);
    expect(report.status).toBe('unverifiable');
  });

  it('one blind intake is enough to disqualify the baseline it diluted', () => {
    // 2026-08-07 holds one equipped intake at 1-of-4 and one blind intake that
    // could only contribute zeros. The day reads 12.5%; the work the gate could
    // actually see read 25%. A "rise" to 25% on the 9th is that dilution.
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 1, 3), intake('2026-08-07', 4, 0, 0), intake('2026-08-09', 4, 1, 3)],
      CORPUS,
      OPTS,
    );
    expect(report.windows[0]?.rate).toBeCloseTo(0.125);
    expect(report.windows[1]?.rate).toBeCloseTo(0.25);
    expect(report.monotonic).toBe(false);
    expect(report.status).toBe('unverifiable');
  });

  it('a rise from a fully instrumented window is off-target and names the day', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 1, 3), intake('2026-08-09', 4, 3, 3)],
      CORPUS,
      OPTS,
    );
    expect(report.windows[0]?.uninstrumentedDecisions).toBe(0);
    expect(report.provenRises).toEqual(['2026-08-09']);
    expect(report.status).toBe('off-target');
    expect(report.ok).toBe(false);
  });

  it('a recorded repeat is itself the instrument record its intake never wrote', () => {
    // `same_mistake: true` cannot be written by a gate holding nothing to
    // escalate against. An intake that fired needs no separate attestation.
    seq = 0;
    const report = checkSameMistakeKpi(
      [intake('2026-08-07', 4, 1, null), intake('2026-08-09', 4, 3, null)],
      CORPUS,
      OPTS,
    );
    expect(report.intakesWithoutInstrumentRecord).toBe(2);
    expect(report.windows[0]?.uninstrumentedDecisions).toBe(0);
    expect(report.status).toBe('off-target');
  });
});

describe('checkSameMistakeKpi — the second trace', () => {
  // P9-32's lesson: an audit that reads one trace reports that trace's gaps as
  // the world's clean state. `quorum-decision` carries trigger_reason
  // "same-mistake" (gate.ts:359, 396) and is written by a different code path.
  it('counts same-mistake quorum decisions alongside the severity decisions', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [
        intake('2026-08-07', 4, 1),
        stored('quorum-decision', { trigger_reason: 'same-mistake' }, '2026-08-07'),
        stored('quorum-decision', { trigger_reason: 'blocking-finding' }, '2026-08-07'),
        intake('2026-08-09', 4, 0),
      ],
      CORPUS,
      OPTS,
    );
    expect(report.windows[0]?.quorumSameMistake).toBe(1);
    expect(report.windows[1]?.quorumSameMistake).toBe(0);
  });

  it('a quorum same-mistake on a day the decisions call clean is a disagreement', () => {
    seq = 0;
    const report = checkSameMistakeKpi(
      [
        intake('2026-08-07', 4, 0),
        stored('quorum-decision', { trigger_reason: 'same-mistake' }, '2026-08-07'),
        intake('2026-08-09', 4, 0),
      ],
      CORPUS,
      OPTS,
    );
    expect(report.traceDisagreements).toEqual(['2026-08-07']);
    expect(report.status).toBe('unverifiable');
  });
});

// The evidence below is `state/events/dogfood-envkit-1.jsonl`, and `state/` is
// gitignored: it exists on the machine that ran the dogfood and nowhere else.
// `readEvents()` answers a missing log with `[]` instead of throwing, so in a
// fresh checkout (CI, a new clone, a detached worktree) this test used to fail
// on `expected +0 to be 4` — the assertion was sound, the evidence was simply
// not there. Asserting 0 instead would be worse than the failure: the test
// would pass everywhere while reading nothing. So it skips, out loud, naming
// the file it wanted.
const DOGFOOD_LOG = path.join(STATE_EVENTS_DIR, 'dogfood-envkit-1.jsonl');

describe('checkSameMistakeKpi — the real dogfood log', () => {
  // Read-only, and the reason this verb exists. Seven severity-decisions
  // events, four of them empty, four decisions total, every one same_mistake
  // false, one calendar day. `stats analytics` reports that as a clean 0.00.
  it('reports dogfood-envkit-1 as unverifiable rather than 0% clean', async (ctx) => {
    if (!existsSync(DOGFOOD_LOG)) {
      ctx.skip(
        `no evidence in this checkout: ${path.relative(REPO_ROOT, DOGFOOD_LOG)} is gitignored`,
      );
      return;
    }
    const { readEvents } = await import('../src/events.js');
    const { parseLessons } = await import('../src/severity.js');
    const { readFileSync } = await import('node:fs');

    const events = await readEvents('dogfood-envkit-1');
    const lessons = parseLessons(
      readFileSync(path.join(REPO_ROOT, 'factory', 'policies', 'lessons.md'), 'utf8'),
    );
    const report = checkSameMistakeKpi(events, lessons, { sessionId: 'dogfood-envkit-1' });

    expect(report.totalDecisions).toBe(4);
    expect(report.totalSameMistake).toBe(0);

    // One calendar day, so one window — and no trend to read even if the
    // instrument had been sound. The four empty intakes fold into it rather
    // than becoming rate-0 datapoints of their own; `silentDays` stays empty
    // only because the same day also carried real decisions.
    expect(report.windows).toEqual([
      {
        day: '2026-08-06',
        intakes: 7,
        emptyIntakes: 4,
        decisions: 4,
        sameMistake: 0,
        rate: 0,
        quorumSameMistake: 0,
        // All four came from intakes predating `lessons_escalating`, and none
        // fired, so this window could never be the baseline of a proven rise.
        uninstrumentedDecisions: 4,
      },
    ]);
    expect(report.silentDays).toEqual([]);

    // Not one of the fourteen compiled lessons carries a finding_category, and
    // no intake recorded what the gate held. Zero was the only reading
    // available.
    expect(report.reach.escalating).toBe(0);
    expect(report.intakesWithoutInstrumentRecord).toBe(7);
    expect(report.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
  });
});
