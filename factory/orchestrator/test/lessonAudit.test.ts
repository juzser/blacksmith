import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import { auditLessons } from '../src/lessonAudit.js';
import type { LessonRule } from '../src/severity.js';

// ---------------------------------------------------------------------------
// `lessons.md` is append-mostly. Nothing in the factory has ever read an entry
// back and asked whether it does anything, so the corpus can only grow, and
// every entry in it is assumed to be earning its place because it was approved
// once.
//
// Two ways an entry stops earning it, and they need different evidence:
//
//   STRUCTURAL. `findMatchingLesson` (severity.ts) is first-match-wins. An
//   entry that comes after one which covers everything it covers can never be
//   returned — dead code in a file no compiler reads. This is provable from
//   the corpus alone: no log, no run, no waiting.
//
//   EVIDENTIAL. An entry that CAN fire and never has. This needs the log, and
//   the log has to be able to say the entry was loaded — otherwise "never
//   fired" and "was never present" are the same reading, and pruning on it
//   deletes the lessons that were merely never installed.
//
// So the report carries the instrument next to the reading, as
// sameMistakeKpi.ts does, and the asymmetry runs the same way: a recorded
// firing is a fact (the match had to happen to be written down), so `keep`
// survives any hole; `idle` is a claim about the record and needs the record
// to have been equipped.
// ---------------------------------------------------------------------------

let seq = 0;

function stored(eventType: string, payload: Record<string, unknown>): StoredEvent {
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
      ts: `2026-08-10T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
      payload,
    },
  };
}

interface DecisionSpec {
  category?: string;
  path?: string;
  matched?: string | null;
}

/** One gate intake, with the ids the gate actually held recorded next to it. */
function intake(decisions: DecisionSpec[], lessonIds: string[] | null = ['lesson-1']): StoredEvent {
  return stored('severity-decisions', {
    decisions: decisions.map((d, i) => ({
      fingerprint: `fp-${seq}-${i}`,
      finding_id: `f-${seq}-${i}`,
      original_severity: 'S3-minor',
      severity: 'S3-minor',
      action: 'waiver-batch',
      same_mistake: d.matched != null,
      matched_lesson_id: d.matched ?? null,
      ...(d.category === undefined ? {} : { finding_category: d.category }),
      ...(d.path === undefined ? {} : { file_path: d.path }),
    })),
    lessons_loaded: lessonIds?.length ?? 0,
    lessons_escalating: lessonIds?.length ?? 0,
    ...(lessonIds === null ? {} : { lesson_ids_escalating: lessonIds }),
  });
}

function rule(over: Partial<LessonRule> = {}): LessonRule {
  return {
    lessonId: 'lesson-1',
    scope: 'claim-path',
    category: 'correctness',
    claimPath: 'src/**',
    agentRole: '',
    caseType: '',
    statement: 'never widen a claim to make a conflict go away',
    ...over,
  };
}

const OPTS = { sessionId: 'sess-1' };

function entryFor(report: ReturnType<typeof auditLessons>, lessonId: string) {
  const found = report.entries.find((e) => e.lessonId === lessonId);
  if (!found) throw new Error(`no entry for ${lessonId}`);
  return found;
}

// ---------------------------------------------------------------------------
describe('auditLessons — dead by construction', () => {
  it('calls an entry unreachable when an earlier stack-wide entry covers it', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'wide', scope: 'stack-wide', claimPath: '**' }),
        rule({ lessonId: 'narrow', claimPath: 'src/db/**' }),
      ],
      OPTS,
    );
    const narrow = entryFor(report, 'narrow');
    expect(narrow.liveness).toBe('unreachable');
    expect(narrow.shadowedBy).toEqual(['wide']);
    expect(narrow.recommendation).toBe('retire');
    expect(report.status).toBe('defective');
    expect(report.ok).toBe(false);
  });

  it('shadows on an identical claim path', () => {
    const report = auditLessons(
      [],
      [rule({ lessonId: 'first' }), rule({ lessonId: 'second' })],
      OPTS,
    );
    expect(entryFor(report, 'second').shadowedBy).toEqual(['first']);
    expect(entryFor(report, 'first').shadowedBy).toEqual([]);
  });

  it('shadows a literal path an earlier glob matches', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'glob', claimPath: 'src/**' }),
        rule({ lessonId: 'literal', claimPath: 'src/db/queries.ts' }),
      ],
      OPTS,
    );
    expect(entryFor(report, 'literal').liveness).toBe('unreachable');
  });

  it('does not shadow across finding categories — the match is an equality', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'wide', scope: 'stack-wide', claimPath: '**' }),
        rule({ lessonId: 'other', category: 'security', claimPath: 'src/db/**' }),
      ],
      OPTS,
    );
    expect(entryFor(report, 'other').shadowedBy).toEqual([]);
    expect(entryFor(report, 'other').liveness).not.toBe('unreachable');
  });

  it('reports a partial overlap as contention, not as death', () => {
    // Neither glob provably contains the other, so part of the later entry's
    // range is still its own. Naming this "unreachable" would retire a live
    // lesson on a guess about glob algebra.
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'a', claimPath: 'src/**/*.ts' }),
        rule({ lessonId: 'b', claimPath: 'src/db/**' }),
      ],
      OPTS,
    );
    const b = entryFor(report, 'b');
    expect(b.shadowedBy).toEqual([]);
    expect(b.overlapsWith).toEqual(['a']);
    expect(b.recommendation).not.toBe('retire');
  });

  it('never retires an entry that cannot escalate — it works at dispatch instead', () => {
    // An agent-role entry is spliced into a role prompt by lessonsForDispatch.
    // It has no file to match and no category to equal, so this audit's whole
    // instrument is blind to it. Blind is not useless.
    const report = auditLessons(
      [],
      [rule({ lessonId: 'role', scope: 'agent-role', category: '', agentRole: 'coder' })],
      OPTS,
    );
    const role = entryFor(report, 'role');
    expect(role.escalates).toBe(false);
    expect(role.liveness).toBe('dispatch-only');
    expect(role.recommendation).toBe('no-evidence');
  });

  it('names a duplicated lesson id, which makes every attribution ambiguous', () => {
    const report = auditLessons(
      [],
      [rule({ claimPath: 'src/a/**' }), rule({ claimPath: 'src/b/**' })],
      OPTS,
    );
    expect(report.duplicateIds).toEqual(['lesson-1']);
    expect(report.status).toBe('defective');
  });
});

// ---------------------------------------------------------------------------
describe('auditLessons — contradiction', () => {
  const NEVER = 'never widen a claim to make a conflict go away';
  const ALWAYS = 'always widen a claim to make a conflict go away';

  it('flags two near-identical statements of opposite polarity over shared paths', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'a', claimPath: 'src/a/**', statement: NEVER }),
        rule({ lessonId: 'b', claimPath: 'src/a/**', statement: ALWAYS }),
      ],
      OPTS,
    );
    expect(entryFor(report, 'b').contradicts).toEqual(['a']);
    expect(entryFor(report, 'a').contradicts).toEqual(['b']);
    expect(entryFor(report, 'b').recommendation).toBe('review');
    expect(report.contradictions).toHaveLength(1);
    expect(report.status).toBe('defective');
  });

  it('does not flag a contradiction between entries that can never both apply', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'a', claimPath: 'src/a/**', statement: NEVER }),
        rule({ lessonId: 'b', claimPath: 'docs/**', statement: ALWAYS }),
      ],
      OPTS,
    );
    expect(entryFor(report, 'b').contradicts).toEqual([]);
    expect(report.contradictions).toEqual([]);
  });

  it('does not flag two unrelated statements that merely share a polarity marker', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'a', claimPath: 'src/a/**', statement: NEVER }),
        rule({
          lessonId: 'b',
          claimPath: 'src/a/**',
          statement: 'always run the migration before the backfill in staging first',
        }),
      ],
      OPTS,
    );
    expect(entryFor(report, 'b').contradicts).toEqual([]);
  });

  it('a contradiction outranks the entry also being shadowed', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'a', claimPath: 'src/**', statement: NEVER }),
        rule({ lessonId: 'b', claimPath: 'src/**', statement: ALWAYS }),
      ],
      OPTS,
    );
    const b = entryFor(report, 'b');
    expect(b.shadowedBy).toEqual(['a']);
    expect(b.recommendation).toBe('review');
  });
});

// ---------------------------------------------------------------------------
describe('auditLessons — what the log can show', () => {
  it('keeps an entry the gate is recorded as having matched', () => {
    const report = auditLessons(
      [intake([{ category: 'correctness', path: 'src/a.ts', matched: 'lesson-1' }])],
      [rule()],
      OPTS,
    );
    const entry = entryFor(report, 'lesson-1');
    expect(entry.firings).toBe(1);
    expect(entry.liveness).toBe('firing');
    expect(entry.recommendation).toBe('keep');
    expect(report.status).toBe('clean');
    expect(report.ok).toBe(true);
  });

  it('counts a firing even when the intake never said which ids it held', () => {
    // The asymmetry. `matched_lesson_id` cannot be written by a gate that did
    // not hold the lesson, so a firing attests to its own instrument and
    // survives an event predating `lesson_ids_escalating`.
    const report = auditLessons(
      [intake([{ category: 'correctness', path: 'src/a.ts', matched: 'lesson-1' }], null)],
      [rule()],
      OPTS,
    );
    expect(entryFor(report, 'lesson-1').liveness).toBe('firing');
    expect(report.intakesWithoutLessonIds).toBe(1);
  });

  it('calls an entry idle when its own decisions went to someone else', () => {
    const report = auditLessons(
      [
        intake(
          [
            { category: 'correctness', path: 'src/db/x.ts', matched: 'first' },
            { category: 'correctness', path: 'src/db/y.ts', matched: 'first' },
          ],
          ['first', 'second'],
        ),
      ],
      [
        rule({ lessonId: 'first', claimPath: 'src/**' }),
        rule({ lessonId: 'second', claimPath: 'src/db/**' }),
      ],
      OPTS,
    );
    const second = entryFor(report, 'second');
    expect(second.opportunities).toBe(2);
    expect(second.firings).toBe(0);
    expect(second.liveness).toBe('idle');
    expect(second.outmatchedBy).toEqual(['first']);
    expect(second.recommendation).toBe('rescope');
  });

  it('leaves an entry unmeasured when no decision ever fell in its scope', () => {
    const report = auditLessons(
      [intake([{ category: 'security', path: 'docs/x.md', matched: null }], ['lesson-1'])],
      [rule()],
      OPTS,
    );
    const entry = entryFor(report, 'lesson-1');
    expect(entry.opportunities).toBe(0);
    expect(entry.liveness).toBe('unmeasured');
    expect(entry.recommendation).toBe('no-evidence');
  });

  it('will not build an opportunity out of a decision with no category or path', () => {
    // Every event already on disk is this shape. Counting them as
    // opportunities would make every entry read `idle` on its first audit and
    // recommend deleting the whole corpus.
    const report = auditLessons([intake([{ matched: null }], ['lesson-1'])], [rule()], OPTS);
    expect(report.decisionsWithoutContext).toBe(1);
    expect(entryFor(report, 'lesson-1').opportunities).toBe(0);
    expect(entryFor(report, 'lesson-1').liveness).toBe('unmeasured');
  });

  it('will not count an opportunity from an intake that did not hold the entry', () => {
    const report = auditLessons(
      [intake([{ category: 'correctness', path: 'src/a.ts', matched: null }], ['other'])],
      [rule()],
      OPTS,
    );
    expect(entryFor(report, 'lesson-1').opportunities).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('auditLessons — the verdict', () => {
  it('is unverifiable when nothing in the log names the ids the gate held', () => {
    const report = auditLessons(
      [intake([{ category: 'correctness', path: 'src/a.ts', matched: null }], null)],
      [rule()],
      OPTS,
    );
    expect(report.status).toBe('unverifiable');
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('lesson_ids_escalating');
  });

  it('is unverifiable when no entry in the corpus can escalate at all', () => {
    const report = auditLessons(
      [],
      [rule({ scope: 'agent-role', category: '', agentRole: 'coder' })],
      OPTS,
    );
    expect(report.status).toBe('unverifiable');
  });

  it('reports a structural defect even when the log proves nothing', () => {
    const report = auditLessons(
      [],
      [
        rule({ lessonId: 'wide', scope: 'stack-wide', claimPath: '**' }),
        rule({ lessonId: 'narrow', claimPath: 'src/db/**' }),
      ],
      OPTS,
    );
    expect(report.status).toBe('defective');
    expect(report.detail).toContain('narrow');
  });

  it('is unverifiable, not clean, on an empty corpus', () => {
    const report = auditLessons([], [], OPTS);
    expect(report.entries).toEqual([]);
    expect(report.status).toBe('unverifiable');
  });

  it('counts every recommendation so the corpus has a shape, not just a list', () => {
    const report = auditLessons(
      [intake([{ category: 'correctness', path: 'src/a.ts', matched: 'lesson-1' }])],
      [rule(), rule({ lessonId: 'role', scope: 'agent-role', category: '', agentRole: 'coder' })],
      OPTS,
    );
    expect(report.counts.keep).toBe(1);
    expect(report.counts['no-evidence']).toBe(1);
    expect(report.counts.retire).toBe(0);
  });
});
