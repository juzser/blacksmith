import { readFileSync } from 'node:fs';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { runGit, runGitRaw } from './git.js';
import { WORKTREE_POLICY_PATH } from './paths.js';

export class ClaimsError extends SmithError {}

function splitPathSegments(p: string): string[] {
  return p.split('/').filter(Boolean);
}

function isSegmentPrefix(a: string[], b: string[]): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * One concrete string that would satisfy a glob's final path segment: `*`/`?`
 * become a literal placeholder character, a brace set picks its first
 * alternative, a bracket class picks a placeholder — enough to construct a
 * real candidate path, not to enumerate every string the segment accepts.
 */
export function synthesizeLiteralSegment(segment: string): string {
  return segment
    .replace(/\{([^,}]+)(,[^}]*)?\}/g, '$1')
    .replace(/\[[^\]]*\]/g, 'x')
    .replace(/\*/g, 'x')
    .replace(/\?/g, 'x');
}

/** A concrete final-path-segment candidate satisfying `pattern`. */
function syntheticTail(pattern: string): string {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  if (last === '**') return '__smith_probe__'; // pattern ends in /** — any filename qualifies
  return synthesizeLiteralSegment(last);
}

function joinBaseAndTail(base: string, tail: string): string {
  return base ? `${base}/${tail}` : tail;
}

/**
 * When neither prefix-containment nor a literal-path check settles it (both
 * sides still have glob magic, e.g. "src/**" vs "**\/config.ts" or
 * "src/**\/*.ts" vs "**\/*.ts"): synthesize concrete candidate paths from
 * each pattern's own literal parts (base of one + synthesized tail of the
 * other, in both directions) and test whether any candidate satisfies BOTH
 * patterns at once. This is an existence check, not exhaustive glob-language
 * intersection — good enough to disprove overlap only when every candidate
 * genuinely fails one side (e.g. disjoint literal extensions).
 */
function couldJointlyMatch(globA: string, globB: string, baseA: string, baseB: string): boolean {
  const matchA = picomatch(globA);
  const matchB = picomatch(globB);
  const candidates = [
    joinBaseAndTail(baseA, syntheticTail(globB)),
    joinBaseAndTail(baseB, syntheticTail(globA)),
  ];
  return candidates.some((candidate) => matchA(candidate) && matchB(candidate));
}

/**
 * Practical glob-vs-glob overlap check: two globs overlap when one's static
 * (non-glob) root path is a path-segment prefix of the other's — the
 * standard "directory ownership" heuristic (claims are directory/file-
 * subtree grants, not arbitrary regex sets) — or, when at least one side has
 * no static prefix at all (globstar-anchored, e.g. "**\/pnpm-lock.yaml"),
 * when a literal path on the other side actually matches it, or a
 * synthesized joint-match candidate satisfies both patterns simultaneously.
 * Errs conservative: only concludes "no overlap" once every check has
 * failed to produce a shared match.
 */
export function globsOverlap(globA: string, globB: string): boolean {
  if (globA === globB) return true;

  const scanA = picomatch.scan(globA);
  const scanB = picomatch.scan(globB);
  const baseA = splitPathSegments(scanA.base);
  const baseB = splitPathSegments(scanB.base);

  if (baseA.length > 0 && baseB.length > 0) {
    return isSegmentPrefix(baseA, baseB) || isSegmentPrefix(baseB, baseA);
  }

  if (!scanA.isGlob && picomatch(globB)(globA)) return true;
  if (!scanB.isGlob && picomatch(globA)(globB)) return true;
  if (!scanA.isGlob || !scanB.isGlob) return false; // one side literal and it didn't match -> disjoint

  return couldJointlyMatch(globA, globB, scanA.base, scanB.base);
}

export interface ClaimedTask {
  claims: string[];
  task_id?: string;
}

export interface GlobPair {
  globA: string;
  globB: string;
}

export interface ClaimOverlapResult {
  overlaps: boolean;
  offendingGlobs: GlobPair[];
}

export function claimsOverlap(taskA: ClaimedTask, taskB: ClaimedTask): ClaimOverlapResult {
  const offendingGlobs: GlobPair[] = [];
  for (const globA of taskA.claims) {
    for (const globB of taskB.claims) {
      if (globsOverlap(globA, globB)) offendingGlobs.push({ globA, globB });
    }
  }
  return { overlaps: offendingGlobs.length > 0, offendingGlobs };
}

export interface WorktreePolicy {
  serializeAlwaysGlobs: string[];
}

export function loadWorktreePolicy(filePath: string = WORKTREE_POLICY_PATH): WorktreePolicy {
  const doc = parseYaml(readFileSync(filePath, 'utf8')) as {
    serialize_always_globs?: { globs?: string[] };
  };
  const globs = doc.serialize_always_globs?.globs;
  if (!Array.isArray(globs)) {
    throw new ClaimsError(
      'claims.invalid-worktree-policy',
      `${filePath} is missing serialize_always_globs.globs.`,
    );
  }
  return { serializeAlwaysGlobs: globs.map(String) };
}

/** Which of the policy's serialize-always globs does this task's claim set touch? */
function touchesSerializeAlways(task: ClaimedTask, serializeAlwaysGlobs: string[]): string[] {
  const touched = new Set<string>();
  for (const claim of task.claims) {
    for (const guard of serializeAlwaysGlobs) {
      if (globsOverlap(claim, guard)) touched.add(guard);
    }
  }
  return [...touched];
}

export interface WaveTask extends ClaimedTask {
  task_id: string;
}

export interface OverlapViolation {
  taskA: string;
  taskB: string;
  offendingGlobs: GlobPair[];
}

export interface SerializeAlwaysViolation {
  taskA: string;
  taskB: string;
  glob: string;
}

/** One dependency edge of the plan, reduced to the only two fields this gate reads. */
export interface WaveEdge {
  task: string;
  dependsOn: string;
}

/**
 * Two tasks the plan orders, proposed for the same wave. `chain` is the
 * shortest path of `depends_on` links from `task` down to `dependsOn`, so an
 * operator can see *which* declaration ordered them when no edge joins the
 * pair directly.
 */
export interface DependencyViolation {
  task: string;
  dependsOn: string;
  chain: string[];
}

export type WaveValidationResult =
  | { valid: true }
  | {
      valid: false;
      overlapViolations: OverlapViolation[];
      serializeAlwaysViolations: SerializeAlwaysViolation[];
      dependencyViolations: DependencyViolation[];
    };

/**
 * A wave as its caller has it, before this gate has read it.
 *
 * `WaveTask.claims` is `string[]`, and that is a promise the type system
 * cannot keep. `task-spec.schema.json` does declare claims an array of
 * strings with `minItems: 1`, but `validatePlan` is reached from exactly one
 * command (`smith plan validate`): `wave check` reads the same file with a
 * bare `JSON.parse(...) as PlanFile`, and its other register is a
 * `task-added` payload, which `event.schema.json` declares as a free-form
 * object. Both hand this function whatever JSON holds. `unknown` here is the
 * type saying what is true at the door; past `readClaimList` it is a real
 * `WaveTask` again, so nothing downstream has to ask twice.
 */
export interface ProposedWaveTask {
  task_id: string;
  claims: unknown;
}

/** A closed vocabulary, so it can be named in an error without quoting a value. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}

/**
 * Refuse a claim set no comparison can read, before it is compared.
 *
 * The codebase already settles claims-shape questions by asking which
 * direction is safe for the reader asking them. `ownershipFromPlan` drops an
 * unreadable set because "a task without claims owns no file, and is dropped
 * rather than defaulted to owning everything"; spec.ts drops one because that
 * "leaves its sites unclaimed rather than silently covered". Both are right,
 * and both answer a question whose safe direction is *less*.
 *
 * This gate asks the opposite question — may these tasks edit the repo at the
 * same time — and its safe direction is *no*. An empty claim set is pairwise
 * disjoint with every other task in the wave, so defaulting to `[]` here does
 * not fail safe: it returns the single answer that cannot be re-checked
 * afterwards, because by then the wave is already running in parallel
 * worktrees. A claim written as a bare string is worse than empty, since
 * iterating a string yields its characters and 's' overlaps no path: the gate
 * reports a disjointness it computed from letters.
 *
 * The unreadable value is never quoted back. It comes from an unvalidated
 * plan file or from the append-only log, and an error message is not where
 * file content gets to appear (D-198) — the type is a closed vocabulary, the
 * value is not.
 */
function readClaimList(task: ProposedWaveTask): WaveTask {
  const { claims } = task;
  if (!Array.isArray(claims)) {
    throw new ClaimsError(
      'claims.unreadable-claims',
      `Task "${task.task_id}" declares claims as ${describeType(claims)}, not a list of globs, ` +
        'so this wave cannot be checked for claim overlap. Claims are a list of path globs ' +
        '(task-spec.schema.json); a single glob is a one-element list, not a bare string.',
      { task_id: task.task_id, received: describeType(claims) },
    );
  }
  const badIndex = claims.findIndex((glob) => typeof glob !== 'string');
  if (badIndex !== -1) {
    throw new ClaimsError(
      'claims.unreadable-claims',
      `Task "${task.task_id}" declares claim ${badIndex} as ` +
        `${describeType(claims[badIndex])}, not a path glob, so this wave cannot be checked ` +
        'for claim overlap.',
      { task_id: task.task_id, index: badIndex, received: describeType(claims[badIndex]) },
    );
  }
  if (claims.length === 0) {
    throw new ClaimsError(
      'claims.empty-claims',
      `Task "${task.task_id}" claims no files, so it is disjoint from every other task in the ` +
        'wave for the reason that it may not edit anything. Admitting it defers the mistake to ' +
        'the first out-of-claim edit; task-spec.schema.json requires at least one claim.',
      { task_id: task.task_id },
    );
  }
  return { task_id: task.task_id, claims: claims as string[] };
}

/**
 * Refuse an edge list no traversal can read, before it is traversed.
 *
 * Same door as `readClaimList`, and the same reason: `wave check` reads the
 * plan with a bare `JSON.parse(...) as PlanFile`, so `edges` holds whatever
 * JSON held. The safe direction here is the one that costs a re-plan, not the
 * one that costs a wave — a value that is not a list of edges must not
 * iterate to zero pairs, because zero pairs is the answer that admits.
 *
 * The unreadable value is never quoted back (D-198): the type is a closed
 * vocabulary, plan-file content is not.
 */
function readEdgeList(edges: unknown): WaveEdge[] {
  if (!Array.isArray(edges)) {
    throw new ClaimsError(
      'claims.unreadable-edges',
      `The plan declares edges as ${describeType(edges)}, not a list of dependency edges, so ` +
        'this wave cannot be checked for tasks the plan orders. Edges are a list of ' +
        '{ task, dependsOn } records; a plan that declares none declares an empty list.',
      { received: describeType(edges) },
    );
  }
  return edges.map((edge, index) => {
    const record = edge as { task?: unknown; dependsOn?: unknown } | null | undefined;
    if (typeof record?.task !== 'string' || typeof record?.dependsOn !== 'string') {
      throw new ClaimsError(
        'claims.unreadable-edges',
        `Edge ${index} declares task as ${describeType(record?.task)} and dependsOn as ` +
          `${describeType(record?.dependsOn)}; both are task ids, so this wave cannot be ` +
          'checked for tasks the plan orders.',
        {
          index,
          task: describeType(record?.task),
          dependsOn: describeType(record?.dependsOn),
        },
      );
    }
    return { task: record.task, dependsOn: record.dependsOn };
  });
}

/**
 * Which tasks in the wave does the plan order after another task in the wave?
 *
 * Transitive, not direct: `{a, c}` under `c <- b <- a` has no edge joining its
 * own two members, and b's absence from the wave is what makes a and c
 * concurrent, not what makes them safe. Every edge counts, whatever its
 * `edge_type` — `artifact`, `claim-order`, `spec-clause`, `regression-test`
 * and `research-brief` all mean "runs after" (factory/policies/taxonomy.yml).
 *
 * A breadth-first walk gives the shortest chain, and `visited` bounds it: the
 * plan may hold a cycle (only `smith plan validate` rejects those) and this
 * gate must still answer.
 */
function findDependencyViolations(
  tasks: readonly WaveTask[],
  edges: readonly WaveEdge[],
): DependencyViolation[] {
  const inWave = new Set(tasks.map((task) => task.task_id));
  const dependencies = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = dependencies.get(edge.task);
    if (existing) existing.push(edge.dependsOn);
    else dependencies.set(edge.task, [edge.dependsOn]);
  }

  const violations: DependencyViolation[] = [];
  for (const task of tasks) {
    const visited = new Set<string>([task.task_id]);
    let frontier: string[][] = [[task.task_id]];
    while (frontier.length > 0) {
      const next: string[][] = [];
      for (const chain of frontier) {
        // A task the plan never mentions has no dependencies, which is not the
        // same fact as "an empty list of them" -- so ask the map, and skip.
        const deps = dependencies.get(chain[chain.length - 1] as string);
        if (!deps) continue;
        for (const dep of deps) {
          if (visited.has(dep)) continue;
          visited.add(dep);
          const extended = [...chain, dep];
          if (inWave.has(dep)) {
            violations.push({ task: task.task_id, dependsOn: dep, chain: extended });
          }
          // Kept walking either way: a prerequisite inside the wave may itself
          // sit above another one.
          next.push(extended);
        }
      }
      frontier = next;
    }
  }
  return violations;
}

/**
 * Verify a proposed wave (NOT computing the largest admissible set — that is
 * the planner's job): tasks must be pairwise claim-disjoint, none may touch a
 * serialize-always glob concurrently with another task in the wave, and none
 * may be one the plan orders after another task in the same wave.
 *
 * `edges` is required rather than defaulted, and that is the point of D-212.
 * `factory/policies/worktree.yml` — the file this gate's own policy comes
 * from — states the remedy it exists to make stick: "tasks with overlapping
 * claims are never scheduled concurrently; they get a dependency edge
 * (edge_type: claim-order) and run serially instead". Cutting that edge is
 * also what narrows the claims, so the plan that took the advice is the plan
 * whose claims this gate then has nothing left to object to. A caller that
 * cannot supply the plan's edges is a caller that cannot answer the question.
 *
 * Every claim set is read before any pair is compared, so a wave carrying one
 * unreadable set is refused as unanswerable rather than answered from the
 * pairs that happened to be readable.
 */
export function validateWave(
  proposed: readonly ProposedWaveTask[],
  policy: WorktreePolicy,
  edges: unknown,
): WaveValidationResult {
  const tasks = proposed.map(readClaimList);
  const dependencyViolations = findDependencyViolations(tasks, readEdgeList(edges));
  const overlapViolations: OverlapViolation[] = [];
  const serializeAlwaysViolations: SerializeAlwaysViolation[] = [];

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const taskA = tasks[i] as WaveTask;
      const taskB = tasks[j] as WaveTask;

      const overlap = claimsOverlap(taskA, taskB);
      if (overlap.overlaps) {
        overlapViolations.push({
          taskA: taskA.task_id,
          taskB: taskB.task_id,
          offendingGlobs: overlap.offendingGlobs,
        });
      }

      const touchedA = touchesSerializeAlways(taskA, policy.serializeAlwaysGlobs);
      const touchedB = touchesSerializeAlways(taskB, policy.serializeAlwaysGlobs);
      for (const glob of touchedA) {
        if (touchedB.includes(glob)) {
          serializeAlwaysViolations.push({ taskA: taskA.task_id, taskB: taskB.task_id, glob });
        }
      }
    }
  }

  if (
    overlapViolations.length === 0 &&
    serializeAlwaysViolations.length === 0 &&
    dependencyViolations.length === 0
  ) {
    return { valid: true };
  }
  return { valid: false, overlapViolations, serializeAlwaysViolations, dependencyViolations };
}

export interface FindingOwnerCandidate {
  taskId: string;
  claim: string;
}

export type FindingOwnership =
  | { owner: 'resolved'; taskId: string; claim: string }
  | { owner: 'ambiguous'; candidates: FindingOwnerCandidate[] }
  | { owner: 'unclaimed' };

/** Repo-relative, forward-slashed, no leading "./" — the form claims are written in. */
function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Does one claim glob cover one file path? Exported because ownership
 * resolution (below), dispatch-time finding context and the stale-evidence
 * check all ask exactly this question, and two implementations of "does this
 * task's claims cover this finding's file" would be two different answers to
 * one question — a bug, not a duplication (P9-15).
 */
export function claimCoversPath(claim: string, filePath: string): boolean {
  return picomatch(claim)(normalizeRepoPath(filePath));
}

/**
 * How specifically a claim names a path, most significant component first:
 * an exact literal claim ("src/parse.ts") outranks any glob, and among globs
 * the one with the deeper static base ("src/parser/**" over "src/**") wins.
 * Deliberately coarse — a finer scale would start inventing an ordering
 * between patterns that genuinely name the same file with equal precision,
 * which is the case this must report rather than resolve.
 */
function claimSpecificity(claim: string, normalizedPath: string): [number, number] {
  const scan = picomatch.scan(claim);
  const exact = !scan.isGlob && normalizeRepoPath(claim) === normalizedPath ? 1 : 0;
  return [exact, splitPathSegments(scan.base).length];
}

function compareSpecificity(a: [number, number], b: [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/**
 * Who owns a finding anchored to `filePath`: the task whose claims cover it,
 * read off the plan's claims map (D-41/P9-24). Ownership is a property of the
 * file, not of whichever task happened to be at the gate when a judge spoke —
 * gating on the latter blocks an unrelated diff and leaves the real owner
 * untouched.
 *
 * Two tasks can legitimately match the same file across different waves
 * (`validateWave` only enforces disjointness *within* a wave), so a
 * specificity tie-break settles the common case. A genuine tie is reported as
 * `ambiguous` rather than guessed — same precedent as `resolveTaskId`
 * (D-46/P9-29): an id nobody can pin down is an operator's call.
 */
export function resolveFindingOwner(
  filePath: string,
  tasks: readonly ClaimedTask[],
): FindingOwnership {
  const normalizedPath = normalizeRepoPath(filePath);

  // Best (most specific) matching claim per task, so one task listing both
  // "src/*.ts" and "src/**" is never ambiguous with itself.
  const best = new Map<string, { claim: string; score: [number, number] }>();
  for (const task of tasks) {
    const taskId = task.task_id;
    if (taskId === undefined) continue;
    for (const claim of task.claims) {
      if (!claimCoversPath(claim, normalizedPath)) continue;
      const score = claimSpecificity(claim, normalizedPath);
      const current = best.get(taskId);
      if (current === undefined || compareSpecificity(score, current.score) > 0) {
        best.set(taskId, { claim, score });
      }
    }
  }

  if (best.size === 0) return { owner: 'unclaimed' };

  const ranked = [...best.entries()].sort(([, a], [, b]) => compareSpecificity(b.score, a.score));
  const [topId, top] = ranked[0] as [string, { claim: string; score: [number, number] }];
  const tied = ranked.filter(([, entry]) => compareSpecificity(entry.score, top.score) === 0);
  if (tied.length > 1) {
    return {
      owner: 'ambiguous',
      candidates: tied.map(([taskId, entry]) => ({ taskId, claim: entry.claim })),
    };
  }
  return { owner: 'resolved', taskId: topId, claim: top.claim };
}

export type FindingAttribution =
  /** The gated task owns the file: block its diff, exactly as before P9-24. */
  | { attribution: 'gated' }
  /** A different task still open for work owns it: move the finding there. */
  | { attribution: 'reassigned'; taskId: string; claim: string }
  /** Nobody can act on it under an existing task: escalate to the epic. */
  | { attribution: 'follow-up'; reason: string };

/**
 * Task statuses that mean "this task's diff is closed to further work". A
 * finding routed to one of these has nobody to fix it — the branch already
 * landed (`completed`), the team already accepted the gap (`waived`), or a
 * later plan version replaced the task outright (`superseded`).
 *
 * `failed` and `escalated` are deliberately NOT here: those tasks are still
 * open work an operator is holding, and a finding about their files belongs
 * on them rather than on a new task competing for the same claims.
 */
const CLOSED_TO_FURTHER_WORK: ReadonlySet<string> = new Set(['completed', 'waived', 'superseded']);

/**
 * Where a finding should land, given who owns its file (D-41/P9-24).
 *
 * `statusOf` is a lookup rather than a map so the caller can defer reading the
 * event log until a finding actually resolves to somebody else — the common
 * case is a judge speaking about the very task at the gate, and that case
 * should cost nothing extra. An owner the log has never heard of counts as
 * open: a task in the plan but not yet in the log is `todo`, not merged.
 */
export function decideFindingAttribution(
  ownership: FindingOwnership,
  gatedTaskId: string,
  statusOf: (taskId: string) => string | undefined,
): FindingAttribution {
  if (ownership.owner === 'unclaimed') {
    return { attribution: 'follow-up', reason: 'No task in the plan claims this file.' };
  }
  if (ownership.owner === 'ambiguous') {
    // A tie is a reason to escalate only when nothing present can break it.
    // The task at the gate can: it is holding the file right now, and the
    // diff the judge just read is where the fix belongs. Escalating one of
    // the tied owners' own findings minted a follow-up competing for claims
    // that task still held, and — since gate.ts admits nothing but `gated`
    // into `blocking` — let the finding land un-blocked (D-173).
    if (ownership.candidates.some((c) => c.taskId === gatedTaskId)) {
      return { attribution: 'gated' };
    }

    const candidates = ownership.candidates
      .map((c) => `${c.taskId} (${c.claim})`)
      .sort()
      .join(', ');
    return {
      attribution: 'follow-up',
      reason: `Two or more tasks claim this file with equal specificity: ${candidates}.`,
    };
  }
  if (ownership.taskId === gatedTaskId) return { attribution: 'gated' };

  const status = statusOf(ownership.taskId);
  if (status !== undefined && CLOSED_TO_FURTHER_WORK.has(status)) {
    return {
      attribution: 'follow-up',
      reason: `Owning task ${ownership.taskId} is already ${status}.`,
    };
  }
  return { attribution: 'reassigned', taskId: ownership.taskId, claim: ownership.claim };
}

/**
 * The two contracts this file classifies against. They are the same check on
 * different populations — a worktree agent's `claims[]`, or the write root a
 * role holds outside any worktree — and they carry different codes because
 * the recourse differs: a claim violation bounces a task diff, a write-root
 * violation is a config change nobody reviewed.
 */
export type ClaimViolationCode = 'contract.claim-violation' | 'contract.write-root-violation';

export interface ClaimCheckResult {
  inClaim: string[];
  outOfClaim: string[];
  violation: { error: ClaimViolationCode; files: string[] } | null;
}

/** @deprecated Name kept for callers that predate the collector/classifier split (P9-3). */
export type PostRunCheckResult = ClaimCheckResult;

/**
 * The classifier half of the check (P9-3): given a changed-file set from
 * *some* collector, split it by pattern. Knows nothing about git, branches or
 * worktrees, which is the whole point — the planner and scribe write outside
 * any worktree on an ordinary branch, and before this split the matching logic
 * was reachable only through a collector that threw on their branch names.
 *
 * An empty pattern list puts every change out of bounds rather than passing
 * everything: a role with no declared write root is one that should not be
 * writing.
 */
export function classifyChanges(
  changedFiles: readonly string[],
  patterns: readonly string[],
  violationCode: ClaimViolationCode = 'contract.claim-violation',
): ClaimCheckResult {
  const isClaimed = patterns.length > 0 ? picomatch([...patterns]) : () => false;
  const inClaim: string[] = [];
  const outOfClaim: string[] = [];
  for (const file of changedFiles) {
    if (isClaimed(file)) inClaim.push(file);
    else outOfClaim.push(file);
  }
  return {
    inClaim,
    outOfClaim,
    violation: outOfClaim.length > 0 ? { error: violationCode, files: outOfClaim } : null,
  };
}

/**
 * Which integration branch a task worktree was cut from, by convention. Its own
 * export because the symbol-impact check (impact.ts) asks the same question of
 * the same worktree, and two derivations of one convention would be two
 * answers.
 *
 * Collector A (P9-3): what this task branch committed, against the integration
 * branch it was cut from — derived from the branch naming convention
 * smith/<epic>/<task-id> -> smith/<epic>/integration (worktree.yml
 * `integration_branch.pattern`; a bare "smith/<epic>" ref cannot coexist with
 * "smith/<epic>/<task-id>" refs in real git — D/F ref conflict).
 *
 * The convention is load-bearing here and that is fine: only an agent working
 * in a task worktree has a claims list, and only a task worktree is on such a
 * branch. What used to be wrong was that this was the *only* way to reach the
 * classifier.
 */
export function integrationBranchFor(worktreeDir: string): string {
  const branch = runGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const lastSlash = branch.lastIndexOf('/');
  if (lastSlash === -1) {
    throw new ClaimsError(
      'claims.cannot-derive-integration-branch',
      `Branch "${branch}" does not follow the smith/<epic>/<task-id> convention.`,
      { branch },
    );
  }
  return `${branch.slice(0, lastSlash)}/integration`;
}

export function collectCommittedChanges(worktreeDir: string): string[] {
  const integrationBranch = integrationBranchFor(worktreeDir);

  const diffOutput = runGit(worktreeDir, ['diff', '--name-only', `${integrationBranch}...HEAD`]);
  return diffOutput
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

export interface WorkingTreeChangeOptions {
  /**
   * A ref to also diff against, for the case where the role committed its own
   * work. Off by default: the planner and scribe hand their output back
   * uncommitted (the operator commits), so the working tree is the whole
   * window — and a default base would have to be guessed from the branch name,
   * which is exactly the coupling this split removes. The planner does hold
   * `Bash`, so pass the SHA from before the dispatch when you want to be sure.
   */
  since?: string;
}

/** `git status --porcelain -z` record: two status chars, a space, then the path. */
const PORCELAIN_STATUS_WIDTH = 3;

/**
 * Collector B (P9-3): everything uncommitted at `rootDir` —
 * staged, unstaged and untracked alike — with no branch-name convention and no
 * integration branch, so it works on `main` or any ordinary branch.
 *
 * `-z` rather than plain `--porcelain`: git quotes and backslash-escapes paths
 * with spaces or non-ASCII in the default format, and a quoted path silently
 * fails to match a claim glob it should have matched. `--untracked-files=all`
 * because a role's first write is usually a *new* file, and the default
 * `normal` mode would collapse a whole new directory into one entry.
 *
 * Renames report BOTH paths (git emits the new one, then the source): moving a
 * file out of a write root touches two paths, and reporting only the
 * destination hides the more serious half.
 *
 * Paths come back repo-root-relative — git's porcelain format is anchored to
 * the repo root regardless of cwd — which is the form claims and write roots
 * are written in, so a subdirectory root is safe to pass.
 */
export function collectWorkingTreeChanges(
  rootDir: string,
  options: WorkingTreeChangeOptions = {},
): string[] {
  const statusOutput = runGitRaw(rootDir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);

  const fields = statusOutput.split('\0');
  const changed: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length <= PORCELAIN_STATUS_WIDTH) continue;
    const status = field.slice(0, 2);
    changed.push(field.slice(PORCELAIN_STATUS_WIDTH));
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[i + 1];
      if (source) changed.push(source);
      i++;
    }
  }

  if (options.since !== undefined) {
    let diffOutput: string;
    try {
      diffOutput = runGit(rootDir, ['diff', '--name-only', options.since, '--']);
    } catch (cause) {
      throw new ClaimsError(
        'claims.cannot-resolve-since-ref',
        `git could not diff against "${options.since}": ${(cause as Error).message}`,
        { since: options.since, rootDir },
      );
    }
    for (const file of diffOutput.split('\n')) {
      const trimmed = file.trim();
      if (trimmed.length > 0) changed.push(trimmed);
    }
  }

  return [...new Set(changed)];
}

/**
 * Did an agent working in a task worktree stay inside its claims? Collector A
 * plus the classifier.
 */
export function postRunCheck(worktreeDir: string, claims: string[]): ClaimCheckResult {
  return classifyChanges(collectCommittedChanges(worktreeDir), claims);
}

/**
 * Did a role that writes *outside* a worktree stay inside its write root
 * (P9-3)? Collector B plus the classifier. The planner
 * (`factory/specs/active/<epic-id>/**`) and the scribe (`state/lessons/**`)
 * are the two: before this, their write roots existed as a sentence in a
 * template and nothing else, and the `/bs` contract could only tell the
 * operator to read `git status` themselves.
 */
export function writeRootCheck(
  rootDir: string,
  writeRoots: readonly string[],
  options: WorkingTreeChangeOptions = {},
): ClaimCheckResult {
  return classifyChanges(
    collectWorkingTreeChanges(rootDir, options),
    writeRoots,
    'contract.write-root-violation',
  );
}
