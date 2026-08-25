import { readFileSync } from 'node:fs';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { globsOverlap, synthesizeLiteralSegment } from './claims.js';
import { SmithError } from './errors.js';
import { SENSITIVE_PATHS_POLICY_PATH } from './paths.js';

export class SecurityError extends SmithError {}

export interface SensitivePathsPolicy {
  /** Claim globs that make a task worth a security review. */
  globs: string[];
  /** Claims that match a glob but are not worth the review — containment, not overlap. */
  exclude: string[];
  /** Taxonomy `case` values that fire the review regardless of claims. */
  cases: string[];
  /** Epic tags that fire the review; operator-supplied, since no epic-tag model exists yet. */
  epicTags: string[];
  /** Whether a scheduled recheck may fire the review at all. */
  scheduledRecheck: boolean;
}

export type SecurityTrigger =
  | { trigger: 'sensitive-claim-path'; claim: string; glob: string }
  | { trigger: 'case'; case: string }
  | { trigger: 'epic-tag'; tag: string }
  | { trigger: 'scheduled-recheck' };

export interface SecurityTriggerTask {
  task_id?: string;
  claims: readonly string[];
  case?: string;
}

export interface SecurityTriggerContext {
  /** Overrides the task spec's own `case` — for asking about an epic rather than a task. */
  case?: string;
  /** Tags the operator asserts for the epic; nothing in the schema records them yet. */
  epicTags?: readonly string[];
  /** True when this call *is* a scheduled recheck. The policy decides whether that counts. */
  scheduledRecheck?: boolean;
}

export interface SecurityTriggerResult {
  taskId: string | null;
  dispatchSecurityReviewer: boolean;
  triggers: SecurityTrigger[];
}

interface RawOtherTriggers {
  cases?: unknown;
  epic_cases?: unknown;
  epic_tags?: unknown;
  scheduled_recheck?: unknown;
}

interface RawSensitivePathsYaml {
  globs?: unknown;
  exclude?: unknown;
  other_triggers?: unknown;
}

/**
 * Every read below refuses a value of the wrong shape rather than substituting
 * an empty one, for the reason the empty-`globs` throw already gives: a trigger
 * the dispatcher cannot read does not fire weakly, it does not fire at all.
 * `cases: infra` is valid YAML and a plausible slip -- the key takes a list,
 * and a one-element list looks like a scalar -- and it turns
 * `dispatchSecurityReviewer` from true to false with an empty trigger list.
 *
 * A *wrong* value stays legal: `cases: [infrastructure]` fires nothing either,
 * but it is a sentence the operator wrote and can read back. Only shapes no
 * comparison can read are refused.
 */
const NEVER_FIRES =
  'A trigger the dispatcher cannot read does not fire weakly, it does not fire at all.';

/** Copied, not aliased: two parses must not share one array. */
function stringList(field: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SecurityError(
      'security.invalid-policy',
      `sensitive-paths.yml ${field} must be a list of strings; got ${JSON.stringify(value)}. ${NEVER_FIRES}`,
      { field, value },
    );
  }
  return [...(value as string[])];
}

function flag(field: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new SecurityError(
      'security.invalid-policy',
      `sensitive-paths.yml ${field} must be true or false; got ${JSON.stringify(value)}. ${NEVER_FIRES}`,
      { field, value },
    );
  }
  return value;
}

/** The block, not just its keys: a scalar here takes all three arms dark at once. */
function otherTriggers(value: unknown): RawOtherTriggers {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SecurityError(
      'security.invalid-policy',
      `sensitive-paths.yml other_triggers must be a block of keys; got ${JSON.stringify(value)}. ${NEVER_FIRES}`,
      { field: 'other_triggers', value },
    );
  }
  return value as RawOtherTriggers;
}

export function parseSensitivePathsPolicy(yamlText: string): SensitivePathsPolicy {
  const doc = (parseYaml(yamlText) ?? {}) as RawSensitivePathsYaml;
  const globs = stringList('globs', doc.globs);
  if (globs.length === 0) {
    throw new SecurityError(
      'security.invalid-policy',
      'sensitive-paths.yml has no globs — a path trigger with an empty glob list never fires.',
    );
  }
  const other = otherTriggers(doc.other_triggers);
  // `epic_cases` was the original spelling, written before it was clear that
  // `case` lives on the task spec and not on the epic. Both are read, and the
  // error names whichever spelling the file actually used.
  const usesCases = other.cases !== undefined && other.cases !== null;
  return {
    globs,
    exclude: stringList('exclude', doc.exclude),
    cases: usesCases
      ? stringList('other_triggers.cases', other.cases)
      : stringList('other_triggers.epic_cases', other.epic_cases),
    epicTags: stringList('other_triggers.epic_tags', other.epic_tags),
    scheduledRecheck: flag('other_triggers.scheduled_recheck', other.scheduled_recheck),
  };
}

export function loadSensitivePathsPolicy(
  filePath: string = SENSITIVE_PATHS_POLICY_PATH,
): SensitivePathsPolicy {
  return parseSensitivePathsPolicy(readFileSync(filePath, 'utf8'));
}

/** Stands in for "some filename" when a pattern ends in `/**`. */
const PROBE_SEGMENT = '__smith_probe__';

/**
 * Every literal a segment's brace set could pick, not just the leading one:
 * `*auth*.{ts,py}` -> ['*auth*.ts', '*auth*.py'].
 *
 * `synthesizeLiteralSegment` keeps only the first alternative, which is the
 * right call where it lives — it builds *a* candidate, and claims.ts asks
 * whether one exists. Here the alternatives are the policy's nine-language
 * extension list, so collapsing them to the leading `ts` made every file glob
 * in the file silently TypeScript-only: a `.py` or `.tsx` claim had no
 * candidate that could satisfy the glob at all (D-176).
 */
function braceAlternatives(segment: string): string[] {
  const brace = /\{([^{}]*)\}/.exec(segment);
  if (brace === null) return [segment];
  const whole = brace[0];
  return (brace[1] ?? '')
    .split(',')
    .flatMap((choice) => braceAlternatives(segment.replace(whole, () => choice)));
}

/**
 * The concrete filenames a pattern's own final segment would accept. A pattern
 * ending in `/**` accepts any filename and proposes the probe.
 */
function tailCandidates(pattern: string): string[] {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  if (last === '**') return [PROBE_SEGMENT];
  return braceAlternatives(last).map(synthesizeLiteralSegment);
}

/**
 * `dot: true` throughout: the two entries this policy most needs to catch are
 * `**\/*.env*` and `**\/.github/workflows/**`, and picomatch's default hides
 * every dotfile from `*` and `**`. A trigger that cannot see `.env` is not a
 * trigger.
 */
function matches(pattern: string, value: string): boolean {
  return picomatch(pattern, { dot: true })(value);
}

/**
 * Concrete paths built from a claim's static base plus a policy glob's literal
 * segments, one per filename either side proposes: `src/**` + `**\/auth/**` ->
 * `src/auth/__smith_probe__`, `ui/src/**\/*.tsx` + `**\/auth/**` ->
 * `ui/src/auth/x.tsx`.
 *
 * This is the case `globsOverlap` gives up on. Its `couldJointlyMatch` only
 * ever synthesizes a *tail* — `src/__smith_probe__` and `__smith_probe__` for
 * that pair — and neither satisfies both sides, so it answers "no overlap" for
 * a claim that plainly contains `src/auth/login.ts`. Policy globs are almost
 * all of the `**\/<literal>/**` shape, so that gap is the common case here, not
 * an edge one. It stays local to this module: `globsOverlap` is load-bearing
 * for wave scheduling, where a wider answer means more serialization.
 *
 * Residual, named rather than closed: when both sides constrain the filename
 * and neither side's proposal satisfies the other — claim `src/*.vue` against
 * `**\/*jwt*`, where the path that satisfies both is `src/jwt.vue` — no
 * candidate is synthesized and the answer is "no overlap". Closing it needs
 * real glob intersection rather than a probe. It errs toward not firing, which
 * is the unsafe direction here, so it is worth revisiting if the policy ever
 * grows an extension-free glob with no directory-shaped sibling.
 */
function sharesSynthesizedPath(claim: string, glob: string): boolean {
  const segments = glob.split('/').filter((s) => s.length > 0);
  const trailingGlobstar = segments[segments.length - 1] === '**';
  // The directories the glob names, without its own filename segment.
  const dirs = (trailingGlobstar ? segments : segments.slice(0, -1))
    .filter((s) => s !== '**')
    .map(synthesizeLiteralSegment);
  const base = picomatch
    .scan(claim)
    .base.split('/')
    .filter((s) => s.length > 0);
  // Both sides propose a filename, because either side may be the one that
  // constrains it: a glob ending in `**` leaves it free and the claim's own
  // tail is then the only constraint — which is how `ui/src/**/*.tsx` used to
  // miss `**/auth/**` while the narrower `ui/src/auth/Login.tsx` fired it,
  // the inversion this matcher exists to prevent (D-176). Widening the
  // candidate list cannot produce a false positive: a candidate still has to
  // satisfy both patterns.
  return [...tailCandidates(glob), ...tailCandidates(claim)].some((tail) => {
    const candidate = [...base, ...dirs, tail].join('/');
    if (candidate.length === 0) return false;
    return matches(claim, candidate) && matches(glob, candidate);
  });
}

/**
 * Overlap, not containment: a claim fires a glob when *some* real path
 * satisfies both. A task claiming `src/**` must fire against `**\/auth/**`
 * even though it is the wider pattern — containment-only matching is the
 * failure mode where a broadly scoped task escapes the review a narrowly
 * scoped one gets.
 *
 * The direct consequence, stated so it is not mistaken for a bug: an
 * open-ended `<dir>/**` claim fires every directory-shaped glob in the policy,
 * because such a claim really could add `<dir>/auth/session.ts` tomorrow. For
 * a security trigger that is the safe direction to err in.
 */
export function claimTouchesGlob(claim: string, glob: string): boolean {
  if (matches(glob, claim)) return true; // a literal claim sitting inside the glob
  if (globsOverlap(claim, glob)) return true;
  return sharesSynthesizedPath(claim, glob);
}

/**
 * Exclusions are containment, deliberately: a claim is silenced only when it
 * lies entirely inside an exclusion. Overlap here would let `**\/*.test.ts`
 * silence `src/**`, and every broadly scoped task could dodge the review by
 * claiming a tree that happens to hold a test file.
 */
function isExcluded(claim: string, exclude: readonly string[]): boolean {
  return exclude.some((pattern) => matches(pattern, claim));
}

/**
 * The security-reviewer's three dispatch triggers, computed instead of
 * remembered (agent-interviews.md N-7, punch list P9-4). A trigger that fires
 * only when the orchestrator remembers to check is not a trigger.
 *
 * At most one trigger per claim: the glob is evidence for "this claim is
 * sensitive", not an enumeration of every glob it could match.
 */
export function securityTriggers(
  task: SecurityTriggerTask,
  policy: SensitivePathsPolicy = loadSensitivePathsPolicy(),
  context: SecurityTriggerContext = {},
): SecurityTriggerResult {
  const triggers: SecurityTrigger[] = [];

  for (const claim of task.claims) {
    if (isExcluded(claim, policy.exclude)) continue;
    const glob = policy.globs.find((candidate) => claimTouchesGlob(claim, candidate));
    if (glob !== undefined) triggers.push({ trigger: 'sensitive-claim-path', claim, glob });
  }

  const taskCase = context.case ?? task.case;
  if (taskCase !== undefined && policy.cases.includes(taskCase)) {
    triggers.push({ trigger: 'case', case: taskCase });
  }

  for (const tag of context.epicTags ?? []) {
    if (policy.epicTags.includes(tag)) triggers.push({ trigger: 'epic-tag', tag });
  }

  if (context.scheduledRecheck === true && policy.scheduledRecheck) {
    triggers.push({ trigger: 'scheduled-recheck' });
  }

  return {
    taskId: task.task_id ?? null,
    dispatchSecurityReviewer: triggers.length > 0,
    triggers,
  };
}
