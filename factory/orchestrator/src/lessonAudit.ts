// `lessons.md` only ever grows. Nothing in the factory reads an entry back and
// asks whether it still does anything, so approval is the last check a lesson
// ever faces, and a corpus that has been append-only for a hundred approvals is
// assumed to be a hundred lessons' worth of memory. It is not. Some of it is
// dead on arrival, and the two ways an entry dies need different evidence.
//
// STRUCTURAL DEATH, provable from the corpus alone. `findMatchingLesson`
// (severity.ts) is first-match-wins: it walks the corpus in order and returns
// the first entry whose category equals the finding's and whose glob covers the
// file. So corpus ORDER is load-bearing, and an entry that comes after one
// covering everything it covers can never be returned. That is dead code in a
// file no compiler reads — and the commonest instance of it is the one nobody
// would spot by eye, a `stack-wide` entry (`claim_path: **`) approved before a
// narrower entry in the same category, which silences every entry after it.
// This needs no log, no run, and no waiting: it is a property of the text.
//
// EVIDENTIAL DEATH: an entry that CAN fire and never has. This needs the log,
// and it needs the log to be able to say the entry was LOADED. Otherwise
// "never fired" and "was never installed" produce the same reading, and pruning
// on it deletes exactly the lessons that never got their chance. `--lessons` is
// optional (cli.ts), so a gate that ran without it decided every finding
// holding nothing at all.
//
// Hence the same construction sameMistakeKpi.ts uses: the instrument recorded
// next to the reading, and an `unverifiable` that outranks a clean-looking
// list. The asymmetry runs the same way too. A recorded firing is a FACT —
// `matched_lesson_id` cannot be written by a gate that did not hold the lesson,
// so `keep` survives any hole in the record, including every event written
// before `lesson_ids_escalating` existed. `idle` is a claim ABOUT the record,
// and is only honest once the record shows the entry was there to fire.
//
// Nothing here deletes anything. `retire` is a recommendation printed for an
// operator, because a lesson is a human's standing instruction and the case for
// dropping one is a case to be read, not a mutation to be applied. §9.6 already
// says as much about supersession: a contradiction needs a human's call.
import picomatch from 'picomatch';
import { globsOverlap } from './claims.js';
import type { StoredEvent } from './events.js';
import { jaccardSimilarity, polarityDiffers, shingles } from './lessons.js';
import { type LessonReach, lessonReach } from './sameMistakeKpi.js';
import { canEscalate, isFileScoped, type LessonRule, lessonCoversFile } from './severity.js';

/**
 * What the record says this entry does.
 *
 * Ordered by how much they bind: the first two are facts about the corpus and
 * hold whatever the log is missing, the last two are claims about the log.
 */
export type LessonLiveness =
  /** Can never be returned by the match: an earlier entry provably covers it. */
  | 'unreachable'
  /** Not part of the escalation match at all — it is spliced into prompts instead. */
  | 'dispatch-only'
  /** The gate is recorded as having matched it. */
  | 'firing'
  /** Decisions fell inside its scope, under a gate that held it, and went elsewhere. */
  | 'idle'
  /** Nothing in the record either way. */
  | 'unmeasured';

export type LessonRecommendation =
  /** It fires. */
  | 'keep'
  /** A human has to reconcile two standing instructions. */
  | 'review'
  /** It cannot fire, and the corpus proves it without reference to any run. */
  | 'retire'
  /** It could fire and does not; its glob or its position is wrong. */
  | 'rescope'
  /** This audit has nothing to say about it. Never a reason to drop one. */
  | 'no-evidence';

export type LessonAuditStatus = 'clean' | 'defective' | 'unverifiable';

export interface LessonAuditEntry {
  lessonId: string;
  scope: string;
  category: string;
  claimPath: string;
  /** Whether it participates in the escalation match at all (category AND file-scoped). */
  escalates: boolean;
  /**
   * Decisions in this entry's category, on a file its glob covers, recorded by
   * an intake the log shows was holding it. The denominator `idle` needs.
   */
  opportunities: number;
  /** Decisions the gate attributed to this entry by id. */
  firings: number;
  liveness: LessonLiveness;
  /**
   * Earlier same-category entries that PROVABLY cover everything this one
   * covers, so the first-match walk can never reach it. Proof only — see
   * `coversEntirely`.
   */
  shadowedBy: string[];
  /**
   * Earlier same-category entries whose glob overlaps this one's without
   * provably containing it. Informational: on the intersection the earlier
   * entry wins, on the rest this one is still live. Overlap is normal.
   */
  overlapsWith: string[];
  /** Entries the gate actually gave this one's opportunities to. Observed, not derived. */
  outmatchedBy: string[];
  /** Entries whose statement contradicts this one where both could apply. */
  contradicts: string[];
  recommendation: LessonRecommendation;
  detail: string;
}

export interface LessonContradiction {
  a: string;
  b: string;
  /** Word-overlap between the two statements, on the topic scale below. */
  similarity: number;
  reason: string;
}

export interface LessonAuditReport {
  sessionId: string;
  /** What the corpus could ever detect, independent of what it did. */
  reach: LessonReach;
  entries: LessonAuditEntry[];
  /** The same id approved twice — every `matched_lesson_id` for it is ambiguous. */
  duplicateIds: string[];
  contradictions: LessonContradiction[];
  /** Intakes whose payload does not name the ids the gate held. */
  intakesWithoutLessonIds: number;
  /** Decisions carrying no category or no path, which no entry can be placed against. */
  decisionsWithoutContext: number;
  counts: Record<LessonRecommendation, number>;
  status: LessonAuditStatus;
  detail: string;
  ok: boolean;
}

export interface LessonAuditOptions {
  sessionId: string;
  /**
   * How much two statements must share, as unigram Jaccard, before a polarity
   * difference between them is called a contradiction rather than a coincidence.
   * See `TOPIC_SIMILARITY_THRESHOLD` for why this is not the novelty threshold.
   */
  topicThreshold?: number;
}

/**
 * The bar for "these two statements are about the same thing".
 *
 * Deliberately NOT `scheduler.yml`'s `novelty_jaccard_threshold`, and the
 * difference is the whole reason this constant exists rather than a reuse.
 * The novelty gate asks "is this a near-verbatim restatement?" over word
 * TRIGRAMS at 0.8, and `checkNovelty` only consults polarity once that bar is
 * cleared. On trigrams, flipping one interior word — the sharpest contradiction
 * there is, "always X" against "never X" — changes three shingles out of n-2
 * and scores about 0.45 on a ten-word statement. So the guard is calibrated to
 * miss precisely the case it is named for, and does: `lessons.ts`'s header
 * already records the polarity marker list as a residual limitation, but the
 * threshold in front of it is the tighter of the two gates.
 *
 * Contradiction asks the weaker question — same subject, opposite instruction —
 * so it reads UNIGRAMS, where a one-word flip in a ten-word statement scores
 * 0.8 and two unrelated statements score near zero. 0.5 sits between them with
 * room on both sides.
 *
 * This does not make the polarity signal itself any better. Two statements that
 * contradict each other without using one of six marker words are still
 * invisible here, and always were.
 */
const TOPIC_SIMILARITY_THRESHOLD = 0.5;

/**
 * Whether `outer` provably covers every path `inner` covers — the condition
 * under which the first-match walk can never reach `inner`.
 *
 * Three cases, each a proof and not a heuristic:
 *   1. the same glob, so trivially the same set;
 *   2. `**`, which picomatch matches against every path, slashes included —
 *      the `stack-wide` scope's compiled claim path, and the case that matters;
 *   3. `inner` has no glob magic at all, so it denotes exactly one path, and
 *      `outer` either matches that path or does not.
 *
 * Everything else returns false and is reported as overlap instead. General
 * glob containment is not decidable by inspection, and the cost of guessing
 * wrong here is a recommendation to delete a live lesson — so this errs the
 * only direction it can afford to.
 */
export function coversEntirely(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  if (outer === '**') return true;
  if (!picomatch.scan(inner).isGlob) return picomatch(outer)(inner);
  return false;
}

/**
 * Whether two entries could ever both be in force. A contradiction between
 * entries that can never meet is not a contradiction.
 *
 * File-scoped pairs meet where their globs overlap. Role- and case-scoped
 * pairs meet on an equal selector, because that is what `lessonsForDispatch`
 * filters them by. A file-scoped entry and a role-scoped one do reach the same
 * prompt whenever that role's scope list holds both, but calling every such
 * pair a possible contradiction would put most of the corpus in front of the
 * polarity check, which is crude enough without being asked to arbitrate the
 * whole corpus against itself.
 */
function couldBothApply(a: LessonRule, b: LessonRule): boolean {
  if (isFileScoped(a) && isFileScoped(b)) return globsOverlap(a.claimPath, b.claimPath);
  if (a.scope === 'agent-role' && b.scope === 'agent-role') return a.agentRole === b.agentRole;
  if (a.scope === 'case-type' && b.scope === 'case-type') return a.caseType === b.caseType;
  return false;
}

interface DecisionRecord {
  matched_lesson_id?: string | null;
  finding_category?: string;
  file_path?: string;
}

interface DecisionsPayload {
  decisions?: DecisionRecord[];
  lesson_ids_escalating?: string[];
}

interface Tally {
  opportunities: number;
  firings: number;
  outmatchedBy: Set<string>;
}

function livenessFor(entry: {
  escalates: boolean;
  shadowedBy: string[];
  firings: number;
  opportunities: number;
}): LessonLiveness {
  // Order is precedence, and the two corpus-level readings come first because
  // they hold whatever the log says. An unreachable entry that somehow shows
  // firings would mean the corpus changed since those runs, not that the proof
  // is wrong — and `firings` is still reported next to it either way.
  if (!entry.escalates) return 'dispatch-only';
  if (entry.shadowedBy.length > 0 && entry.firings === 0) return 'unreachable';
  if (entry.firings > 0) return 'firing';
  if (entry.opportunities > 0) return 'idle';
  return 'unmeasured';
}

function recommendationFor(liveness: LessonLiveness, contradicts: string[]): LessonRecommendation {
  // A contradiction outranks everything else an entry could be. Two standing
  // instructions that disagree are a hazard whether or not either one fires,
  // and §9.6 reserves the resolution for a human, so no other reading here may
  // quietly close the question first.
  if (contradicts.length > 0) return 'review';
  switch (liveness) {
    case 'unreachable':
      return 'retire';
    case 'firing':
      return 'keep';
    case 'idle':
      return 'rescope';
    default:
      return 'no-evidence';
  }
}

function entryDetail(entry: Omit<LessonAuditEntry, 'detail'>): string {
  switch (entry.liveness) {
    case 'dispatch-only':
      return (
        `Not part of the escalation match — ${entry.category === '' ? 'it names no finding_category' : `its ${entry.scope} scope has no file to match against`}. ` +
        'It is spliced into role prompts instead, which this audit cannot measure.'
      );
    case 'unreachable':
      return (
        `Never reachable: ${entry.shadowedBy.join(', ')} come(s) earlier in the corpus with the ` +
        `same category and provably cover(s) every path "${entry.claimPath}" covers, and the ` +
        'match returns the first hit. Either drop this entry or narrow the earlier one.'
      );
    case 'firing':
      return `Matched ${entry.firings} recorded decision(s).`;
    case 'idle':
      return (
        `${entry.opportunities} decision(s) fell in this entry's category and inside its glob ` +
        `while the gate held it, and every one went to ${[...entry.outmatchedBy].join(', ')}. ` +
        'Its glob or its position in the corpus is wrong.'
      );
    default:
      return 'No decision in the record fell inside its scope; nothing here argues either way.';
  }
}

function describe(report: Omit<LessonAuditReport, 'detail' | 'ok'>): string {
  const head =
    `${report.entries.length} compiled lesson(s): ${report.counts.keep} firing, ` +
    `${report.counts.rescope} idle, ${report.counts.retire} unreachable, ` +
    `${report.counts.review} needing a human, ${report.counts['no-evidence']} unmeasured.`;

  const defects: string[] = [];
  const retiring = report.entries
    .filter((e) => e.recommendation === 'retire')
    .map((e) => e.lessonId);
  if (retiring.length > 0) {
    defects.push(
      `${retiring.join(', ')} can never be returned by the match — an earlier same-category ` +
        'entry covers everything they cover',
    );
  }
  const rescoping = report.entries
    .filter((e) => e.recommendation === 'rescope')
    .map((e) => e.lessonId);
  if (rescoping.length > 0) {
    defects.push(`${rescoping.join(', ')} had decisions inside their scope and matched none`);
  }
  if (report.contradictions.length > 0) {
    defects.push(
      `${report.contradictions.map((c) => `${c.a} vs ${c.b}`).join('; ')} give opposite ` +
        'instructions where both apply',
    );
  }
  if (report.duplicateIds.length > 0) {
    defects.push(
      `${report.duplicateIds.join(', ')} appear(s) twice, so every attribution to that id is ambiguous`,
    );
  }

  const holes: string[] = [];
  if (report.reach.escalating === 0) {
    holes.push(
      `none of the ${report.reach.total} entries can escalate anything ` +
        `(${report.reach.withoutCategory} name no finding_category, ` +
        `${report.reach.nonFileScoped} are not file-scoped), so no reading here is about the work`,
    );
  }
  if (report.intakesWithoutLessonIds > 0) {
    holes.push(
      `${report.intakesWithoutLessonIds} intake(s) record no lesson_ids_escalating, so the log ` +
        'cannot say which entries were loaded and an entry that never fired may never have been present',
    );
  }
  if (report.decisionsWithoutContext > 0) {
    holes.push(
      `${report.decisionsWithoutContext} decision(s) carry no finding_category or file_path and ` +
        'cannot be placed against any entry',
    );
  }

  const defectText = defects.length > 0 ? ` Defects: ${defects.join('; ')}.` : '';
  const holeText = holes.length > 0 ? ` Holes: ${holes.join('; ')}.` : '';

  switch (report.status) {
    case 'defective':
      return (
        `${head} The corpus contradicts or silences itself, and that is a property of the text ` +
        `rather than of any run, so it stands whatever the log is missing.${defectText}${holeText}`
      );
    case 'unverifiable':
      return (
        `${head} Nothing here shows an entry failing to earn its place, but neither can it show ` +
        `one earning it: the record cannot say what the gate was holding.${holeText}`
      );
    default:
      return `${head} Every entry is reachable, consistent, and accounted for in the record.`;
  }
}

/**
 * Read the compiled corpus back and say, per entry, whether it can fire, whether
 * it has, and whether it disagrees with anything else in the file.
 *
 * Read-only over the log and over `lessons.md` — it recommends, and removes
 * nothing. Fails the report on anything but `clean`, for the reason
 * sameMistakeKpi.ts fails on anything but `on-target`: a corpus that cannot be
 * read is not a corpus that is fine.
 */
export function auditLessons(
  events: readonly StoredEvent[],
  lessons: readonly LessonRule[],
  options: LessonAuditOptions,
): LessonAuditReport {
  const topicThreshold = options.topicThreshold ?? TOPIC_SIMILARITY_THRESHOLD;

  // --- the log --------------------------------------------------------------
  const tallies = new Map<string, Tally>();
  const tallyFor = (id: string): Tally => {
    let tally = tallies.get(id);
    if (tally === undefined) {
      tally = { opportunities: 0, firings: 0, outmatchedBy: new Set() };
      tallies.set(id, tally);
    }
    return tally;
  };

  let intakesWithoutLessonIds = 0;
  let decisionsWithoutContext = 0;

  for (const { record } of events) {
    if (record.event_type !== 'severity-decisions') continue;
    const payload = record.payload as DecisionsPayload;
    const held = payload.lesson_ids_escalating;
    if (!Array.isArray(held)) intakesWithoutLessonIds += 1;
    const heldSet = new Set(Array.isArray(held) ? held : []);

    for (const decision of payload.decisions ?? []) {
      const matched = decision.matched_lesson_id ?? null;
      // A firing attests to its own instrument: the id could not have been
      // written by a gate that did not hold the lesson. So it is counted before
      // any check on what else this event recorded, and counted even when the
      // event predates every field below it.
      if (matched !== null) tallyFor(matched).firings += 1;

      const category = decision.finding_category;
      const filePath = decision.file_path;
      if (typeof category !== 'string' || typeof filePath !== 'string') {
        decisionsWithoutContext += 1;
        continue;
      }
      // An opportunity is only an opportunity for an entry the gate was
      // holding. Without that, "did not match" is a statement about the
      // dispatch and not about the entry.
      for (const lesson of lessons) {
        if (!heldSet.has(lesson.lessonId)) continue;
        if (!canEscalate(lesson)) continue;
        if (lesson.category !== category) continue;
        if (!lessonCoversFile(lesson, filePath)) continue;
        const tally = tallyFor(lesson.lessonId);
        tally.opportunities += 1;
        if (matched !== null && matched !== lesson.lessonId) tally.outmatchedBy.add(matched);
      }
    }
  }

  // --- the corpus -----------------------------------------------------------
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const lesson of lessons) {
    if (seen.has(lesson.lessonId)) {
      if (!duplicateIds.includes(lesson.lessonId)) duplicateIds.push(lesson.lessonId);
    }
    seen.add(lesson.lessonId);
  }

  const contradictions: LessonContradiction[] = [];
  const contradictsBy = new Map<string, string[]>();
  const unigrams = lessons.map((lesson) => shingles(lesson.statement, 1));
  for (let i = 0; i < lessons.length; i += 1) {
    for (let j = i + 1; j < lessons.length; j += 1) {
      const a = lessons[i] as LessonRule;
      const b = lessons[j] as LessonRule;
      if (!couldBothApply(a, b)) continue;
      if (!polarityDiffers(a.statement, b.statement)) continue;
      const similarity = jaccardSimilarity(unigrams[i] as Set<string>, unigrams[j] as Set<string>);
      if (similarity < topicThreshold) continue;
      contradictions.push({
        a: a.lessonId,
        b: b.lessonId,
        similarity,
        reason:
          `${(similarity * 100).toFixed(0)}% word overlap with opposing imperative polarity, ` +
          'over scopes that can both be in force at once',
      });
      contradictsBy.set(a.lessonId, [...(contradictsBy.get(a.lessonId) ?? []), b.lessonId]);
      contradictsBy.set(b.lessonId, [...(contradictsBy.get(b.lessonId) ?? []), a.lessonId]);
    }
  }

  const counts: Record<LessonRecommendation, number> = {
    keep: 0,
    review: 0,
    retire: 0,
    rescope: 0,
    'no-evidence': 0,
  };

  const entries: LessonAuditEntry[] = lessons.map((lesson, index) => {
    const shadowedBy: string[] = [];
    const overlapsWith: string[] = [];
    if (canEscalate(lesson)) {
      for (let j = 0; j < index; j += 1) {
        const prior = lessons[j] as LessonRule;
        // Exactly the conditions the match walk applies, in the order it
        // applies them: an entry it skips cannot shadow anything.
        if (!canEscalate(prior)) continue;
        if (prior.category !== lesson.category) continue;
        if (coversEntirely(prior.claimPath, lesson.claimPath)) shadowedBy.push(prior.lessonId);
        else if (globsOverlap(prior.claimPath, lesson.claimPath)) overlapsWith.push(prior.lessonId);
      }
    }

    const tally = tallies.get(lesson.lessonId) ?? {
      opportunities: 0,
      firings: 0,
      outmatchedBy: new Set<string>(),
    };
    const escalates = canEscalate(lesson);
    const liveness = livenessFor({
      escalates,
      shadowedBy,
      firings: tally.firings,
      opportunities: tally.opportunities,
    });
    const contradicts = contradictsBy.get(lesson.lessonId) ?? [];
    const recommendation = recommendationFor(liveness, contradicts);
    counts[recommendation] += 1;

    const partial: Omit<LessonAuditEntry, 'detail'> = {
      lessonId: lesson.lessonId,
      scope: lesson.scope,
      category: lesson.category,
      claimPath: lesson.claimPath,
      escalates,
      opportunities: tally.opportunities,
      firings: tally.firings,
      liveness,
      shadowedBy,
      overlapsWith,
      outmatchedBy: [...tally.outmatchedBy].sort(),
      contradicts,
      recommendation,
    };
    return { ...partial, detail: entryDetail(partial) };
  });

  const reach = lessonReach(lessons);
  // Corpus defects first, and they outrank every hole: shadowing, contradiction
  // and a duplicated id are all properties of the text, provable with no log at
  // all, so a record too thin to measure liveness cannot soften them. Only once
  // the text is clean does the quality of the record decide the verdict.
  const structurallyDefective =
    contradictions.length > 0 || duplicateIds.length > 0 || counts.retire > 0;
  const status: LessonAuditStatus = structurallyDefective
    ? 'defective'
    : counts.rescope > 0
      ? 'defective'
      : reach.escalating === 0 ||
          intakesWithoutLessonIds > 0 ||
          decisionsWithoutContext > 0 ||
          entries.length === 0
        ? 'unverifiable'
        : 'clean';

  const partial: Omit<LessonAuditReport, 'detail' | 'ok'> = {
    sessionId: options.sessionId,
    reach,
    entries,
    duplicateIds,
    contradictions,
    intakesWithoutLessonIds,
    decisionsWithoutContext,
    counts,
    status,
  };

  return { ...partial, detail: describe(partial), ok: status === 'clean' };
}
