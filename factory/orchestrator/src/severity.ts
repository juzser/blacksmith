import { readFileSync } from 'node:fs';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { REPO_ROOT } from './paths.js';

export class SeverityError extends SmithError {}

const SEVERITY_POLICY_PATH = `${REPO_ROOT}/factory/policies/severity.yml`;
/** Escalation order, worst first — the same order severity.yml/taxonomy.yml document values in. */
export const SEVERITY_ORDER: readonly string[] = [
  'S1-stop-the-line',
  'S2-major',
  'S3-minor',
  'S4-nit',
];

/**
 * Position in SEVERITY_ORDER, or `null` for a value that is not in it.
 *
 * `null` rather than a sentinel index, because both sentinels lie:
 * `Number.POSITIVE_INFINITY` makes an unknown severity the mildest thing in the
 * list and `-1` makes it the worst, and a caller that forgets to check gets a
 * confident wrong answer either way. Callers that must not silently pass an
 * unknown value — escalate() below — turn the `null` into a
 * `severity.unknown-severity` throw.
 */
export function severityRank(severity: string): number | null {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? null : index;
}

/**
 * The worse of two severities, worst-wins. Used by crossFinding.ts's
 * `highest-wins` resolution, where two providers raised the same fingerprint
 * and disagree on how bad it is.
 *
 * An unknown value on either side throws rather than losing the comparison:
 * mintFindings() already refuses a non-canonical severity, so an unknown one
 * here means a stored finding predates a taxonomy edit, and quietly treating it
 * as mild is how an S1 becomes an S4.
 */
export function worseSeverity(a: string, b: string): string {
  const rankA = severityRank(a);
  const rankB = severityRank(b);
  for (const [value, rank] of [
    [a, rankA],
    [b, rankB],
  ] as const) {
    if (rank === null) {
      throw new SeverityError('severity.unknown-severity', `Unknown severity "${value}".`, {
        severity: value,
      });
    }
  }
  return (rankA as number) <= (rankB as number) ? a : b;
}

export interface SeverityLevelPolicy {
  blocksMerge: boolean;
}

export interface SeverityPolicy {
  levels: Record<string, SeverityLevelPolicy>;
}

interface RawSeverityYaml {
  levels?: Record<string, { blocks_merge?: boolean }>;
}

export function parseSeverityPolicy(yamlText: string): SeverityPolicy {
  const doc = parseYaml(yamlText) as RawSeverityYaml;
  const rawLevels = doc.levels;
  if (!rawLevels || typeof rawLevels !== 'object') {
    throw new SeverityError('severity.invalid-document', 'severity.yml is missing `levels`.');
  }
  const levels: Record<string, SeverityLevelPolicy> = {};
  for (const [name, level] of Object.entries(rawLevels)) {
    if (typeof level.blocks_merge !== 'boolean') {
      throw new SeverityError(
        'severity.invalid-document',
        `severity.yml level "${name}" is missing boolean blocks_merge.`,
        { level: name },
      );
    }
    levels[name] = { blocksMerge: level.blocks_merge };
  }
  return { levels };
}

export function loadSeverityPolicy(filePath: string = SEVERITY_POLICY_PATH): SeverityPolicy {
  return parseSeverityPolicy(readFileSync(filePath, 'utf8'));
}

/** One `rule`-typed compiled-lessons entry, parsed from factory/policies/lessons.md. */
export interface LessonRule {
  lessonId: string;
  scope: string;
  category: string;
  /** Glob, matched with picomatch; "**" (covers everything) for stack-wide entries. */
  claimPath: string;
  /**
   * taxonomy `agent` value — the selector for an `agent-role`-scoped entry
   * (D-129). `''` for every other scope, and for a legacy `agent-role` entry
   * raised before the selector existed; such an entry selects NOTHING rather
   * than everything (see `lessonsForScope`).
   */
  agentRole: string;
  /** taxonomy `case` value — the same, for a `case-type`-scoped entry (D-129). */
  caseType: string;
  statement: string;
}

const ENTRY_HEADING = /^### /;
const SECTION_HEADING = /^## (.+)$/;
const BULLET = /^- ([a-z_]+):\s*(.*)$/;
/** An indented, non-bullet line — a continuation of the previous bullet's value. */
const CONTINUATION = /^\s+(\S.*)$/;

/**
 * taxonomy.yml `lesson_scope`, in compiled-section order — only entries under
 * one of these `##` sections are real lessons, which is also what stops a `##`
 * heading smuggled into a statement from minting one. Single source for both
 * the parse side (here) and the compile side (`lessons.ts` imports this);
 * `test/severity.test.ts` asserts it still matches taxonomy.yml.
 */
export const LESSON_SCOPES = [
  'agent-role',
  'claim-path',
  'case-type',
  'stack-wide',
  'security',
] as const;

const VALID_SCOPES: ReadonlySet<string> = new Set(LESSON_SCOPES);

/**
 * Parse the "Same-mistake entry format" documented in lessons.md itself
 * (§ Same-mistake entry format): a level-3 heading starts an entry, followed
 * by `- key: value` bullets until a blank line or the next heading. A bullet
 * value may wrap onto indented continuation lines (lessons.md's own example
 * does exactly this for `statement`) — those are appended, trimmed and
 * space-joined, to the bullet they follow; without this, a multi-line
 * statement round-trips silently truncated mid-sentence. Entries missing
 * statement/lesson_id are skipped, not fatal — lessons.md also carries
 * non-rule / placeholder content ("_(none yet)_", prose) this parser has no
 * business rejecting the whole file over. `finding_category` is OPTIONAL
 * (lesson.schema.json says so, and agent-role/case-type entries never carry
 * one) and parses as `''`: this file has two readers, the same-mistake match
 * below and dispatch-time injection (lessons.ts, P9-2), and dropping a
 * category-less entry here made every agent-role/case-type lesson — including
 * every lesson `smith dream` raises — compile into lessons.md and then reach
 * no one. `findMatchingLesson` skips the empty category explicitly, so
 * escalation still matches exactly what it matched before. Only
 * `###` headings inside a real `lesson_scope` section (`##
 * agent-role`/`claim-path`/`case-type`/`stack-wide`) are parsed as entries —
 * this also keeps the illustrative fenced example in lessons.md's own
 * "Same-mistake entry format" doc section (before any `##` scope heading)
 * from being parsed as a real lesson.
 *
 * Three bullets are SELECTORS — the one field a scope is filtered by at
 * dispatch (D-129): `claim_path` for `claim-path`, `agent_role` for
 * `agent-role`, `case_type` for `case-type`. Each is optional here and parses
 * to `''` when absent, except `claim_path`, which keeps its historical `'**'`
 * default. That asymmetry is deliberate and `lessonsForScope` depends on it: a
 * missing selector must match NOTHING rather than everything, so an entry that
 * names no role reaches no role instead of every one.
 */
export function parseLessons(markdown: string): LessonRule[] {
  const lines = markdown.split('\n');
  const rules: LessonRule[] = [];

  let scope = '';
  let current: Record<string, string> | null = null;
  let lastKey: string | null = null;

  function flush(): void {
    if (!current) return;
    const { lesson_id, finding_category, claim_path, agent_role, case_type, statement } = current;
    if (lesson_id && statement) {
      rules.push({
        lessonId: lesson_id,
        scope,
        category: finding_category ?? '',
        claimPath: claim_path ?? '**',
        agentRole: agent_role ?? '',
        caseType: case_type ?? '',
        statement,
      });
    }
    current = null;
    lastKey = null;
  }

  for (const line of lines) {
    const sectionMatch = line.match(SECTION_HEADING);
    if (sectionMatch) {
      flush();
      scope = (sectionMatch[1] as string).trim();
      continue;
    }
    if (ENTRY_HEADING.test(line)) {
      flush();
      current = VALID_SCOPES.has(scope) ? {} : null;
      continue;
    }
    if (current) {
      const bulletMatch = line.match(BULLET);
      if (bulletMatch) {
        const key = bulletMatch[1] as string;
        current[key] = (bulletMatch[2] as string).trim();
        lastKey = key;
        continue;
      }
      if (line.trim() === '') {
        // A blank line doesn't close the entry (only the next heading, or
        // EOF, does) but it does end any bullet's continuation run.
        lastKey = null;
        continue;
      }
      const continuationMatch = line.match(CONTINUATION);
      if (continuationMatch && lastKey) {
        const existingValue = current[lastKey] ?? '';
        current[lastKey] = `${existingValue} ${(continuationMatch[1] as string).trim()}`.trim();
      }
    }
  }
  flush();

  return rules;
}

/**
 * Scopes whose claim_path is meaningful for the per-file same-mistake match
 * (lessons.md convention). `security` is here because a security lesson is
 * written against the paths it guards ("src/auth/**") — a repeat security
 * finding on one of those paths is exactly what escalation is for. Left out, a
 * security lesson would compile and be read by agents but never escalate
 * anything (interview N-8).
 */
const FILE_SCOPED = new Set(['claim-path', 'stack-wide', 'security']);

/**
 * Whether this lesson's scope makes its `claim_path` mean anything. An
 * `agent-role`/`case-type` entry has no file to check a finding against, so it
 * never participates in the per-file match however it is written.
 */
export function isFileScoped(lesson: LessonRule): boolean {
  return FILE_SCOPED.has(lesson.scope);
}

/**
 * Whether this lesson's compiled `claim_path` covers `filePath` — the second
 * half of the escalation match, exported so `lessonAudit.ts` can ask the match
 * its own question rather than reimplementing the glob semantics beside it.
 */
export function lessonCoversFile(lesson: LessonRule, filePath: string): boolean {
  if (!isFileScoped(lesson)) return false;
  const isMatch = picomatch(lesson.claimPath);
  return isMatch(filePath);
}

/**
 * Whether this lesson can ever escalate anything — the two conditions of the
 * match below that depend on the lesson alone, not on the finding it is being
 * matched against.
 *
 *   1. It names a `finding_category`. The match is an equality against the new
 *      finding's category, so an entry naming none is skipped before its claim
 *      path is ever consulted. A category-less lesson (agent-role/case-type, or
 *      anything `smith dream` raised) is injected at dispatch and read by
 *      agents; it is simply never a *same mistake*, because there is no
 *      category for it to be the same mistake as.
 *   2. Its scope is file-scoped. `agent-role`/`case-type` entries have no file
 *      to check a finding against.
 *
 * Exported because the same-mistake KPI has to count the instrument as well as
 * the reading (sameMistakeKpi.ts), and a second copy of these two conditions is
 * a second thing to keep true — interview N-8, where the compile side and the
 * parse side each kept their own scope list and `security` vanished between
 * them with no error anywhere.
 */
export function canEscalate(lesson: LessonRule): boolean {
  return lesson.category !== '' && isFileScoped(lesson);
}

function findMatchingLesson(
  category: string,
  filePath: string,
  lessons: readonly LessonRule[],
): LessonRule | null {
  for (const lesson of lessons) {
    if (!canEscalate(lesson)) continue;
    if (lesson.category === category && lessonCoversFile(lesson, filePath)) return lesson;
  }
  return null;
}

function escalate(severity: string, policy: SeverityPolicy): string {
  const index = severityRank(severity);
  if (index === null) {
    throw new SeverityError('severity.unknown-severity', `Unknown severity "${severity}".`, {
      severity,
    });
  }
  const escalated = SEVERITY_ORDER[Math.max(0, index - 1)] as string;
  if (!policy.levels[escalated]) {
    throw new SeverityError(
      'severity.unknown-severity',
      `Escalated severity "${escalated}" is not defined in severity.yml.`,
      { severity: escalated },
    );
  }
  return escalated;
}

export type SeverityAction = 'block' | 'waiver-batch' | 'log-only';

export interface SeverityFinding {
  finding_category: string;
  severity: string;
}

export interface SeverityContext {
  filePath: string;
  lessons: readonly LessonRule[];
  /**
   * A severity an INDEPENDENT finder gave the same fingerprint
   * (crossFinding.ts, crosscheck.yml `independent_finder.severity_resolution:
   * highest-wins`). Applied before the lesson escalation, and only ever
   * upward: two reviewers who read the same code and disagreed about how bad
   * it is are not averaged, because taking the milder reading is how an S1
   * becomes an S3 by committee.
   *
   * Optional, and absent on every gate run that had no finder: a corroborated
   * severity is evidence the caller either has or does not, never something
   * this function may assume.
   */
  corroboratedSeverity?: string;
}

export interface SeverityDecision {
  /** Original severity, raised to a corroborating finder's reading and then escalated one level on a same-mistake match. */
  severity: string;
  blocks: boolean;
  action: SeverityAction;
  sameMistake: boolean;
  matchedLessonId: string | null;
  /** True when an independent finder's severity moved this finding. False when none was offered, or it was no worse. */
  corroborated: boolean;
}

function actionFor(severity: string, level: SeverityLevelPolicy): SeverityAction {
  if (level.blocksMerge) return 'block';
  return severity.startsWith('S3') ? 'waiver-batch' : 'log-only';
}

/**
 * Pure, deterministic gate decision for one finding: S1/S2 block, S3
 * waiver-batch, S4 log-only (severity.yml) — escalated one severity level,
 * up-capped at S1, when the finding matches an approved lesson for the same
 * file + category (architecture §9.7).
 */
export function decide(
  finding: SeverityFinding,
  context: SeverityContext,
  policy: SeverityPolicy = loadSeverityPolicy(),
): SeverityDecision {
  // Corroboration first, escalation second, and the order is the decision:
  // a repeat mistake is one level worse than whatever the finding actually
  // IS, so the two readings have to be reconciled before the lesson has
  // something to escalate. Reversed, a corroborated S2 that repeats a lesson
  // would land at S2 instead of S1.
  const corroborated =
    context.corroboratedSeverity === undefined
      ? finding.severity
      : worseSeverity(finding.severity, context.corroboratedSeverity);

  const matched = findMatchingLesson(finding.finding_category, context.filePath, context.lessons);
  const severity = matched ? escalate(corroborated, policy) : corroborated;

  const level = policy.levels[severity];
  if (!level) {
    throw new SeverityError('severity.unknown-severity', `Unknown severity "${severity}".`, {
      severity,
    });
  }

  return {
    severity,
    blocks: level.blocksMerge,
    action: actionFor(severity, level),
    sameMistake: matched !== null,
    matchedLessonId: matched?.lessonId ?? null,
    corroborated: corroborated !== finding.severity,
  };
}
