import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { STATE_ARTIFACTS_DIR } from './paths.js';

/**
 * One entry of `result.artifacts`, as `result.schema.json` types it. The schema
 * puts no constraint on `path` because JSON Schema cannot express "inside this
 * directory" — that constraint lives here, and the gate enforces it.
 */
export interface ArtifactDecl {
  type: string;
  path: string;
  description?: string;
}

/**
 * `outside-home` — the path leads somewhere other than the task's artifact
 * home. `/tmp`, a session scratchpad and a worktree are all this: real at the
 * moment of writing, gone by the time anyone reads the verdict (D-19). Leads,
 * not spells: a symlink out of the home is the same absence written in a way
 * that passes a string comparison (D-193).
 *
 * `missing` — the right place, nothing there.
 *
 * `no-path` — the declaration names the home itself rather than anything in
 * it. `""` and `"."` both resolve there, and the home exists for every task
 * that wrote anything, so such a declaration passes as evidence of everything.
 */
export type ArtifactProblem = 'outside-home' | 'missing' | 'no-path';

export interface ArtifactIssue {
  /** Verbatim what the result declared, so the operator can find the line to fix. */
  declared: string;
  /** Where that resolved to, so "why is this wrong" needs no second guess. */
  resolved: string;
  problem: ArtifactProblem;
}

export interface ArtifactCheck {
  /** The directory every one of this task's artifacts must resolve inside. */
  home: string;
  /** How many were declared — 0 is a result, not an absence (P9-23). */
  checked: number;
  issues: ArtifactIssue[];
  ok: boolean;
}

export interface ArtifactCheckOpts {
  taskId: string;
  /** Injection seam for tests; production is `state/artifacts`. */
  artifactsDir?: string;
}

/**
 * Where a task's artifacts belong: `state/artifacts/<task-id>/`, beside
 * `state/results/<task-id>.json`. One home per task, named by the task, so the
 * evidence for a verdict is findable from the verdict without a search.
 *
 * `taskId` arrives from a worker-written result file, so it is not trusted to
 * be a plain name: a `..` segment would compute a home outside the artifacts
 * dir, and every later check would then be reporting about somewhere else.
 */
export function artifactHome(taskId: string, artifactsDir: string = STATE_ARTIFACTS_DIR): string {
  return homeUnder(path.resolve(artifactsDir), taskId);
}

function homeUnder(root: string, taskId: string): string {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new SmithError(
      'artifacts.missing-task-id',
      `Cannot locate an artifact home without a task id (got ${JSON.stringify(taskId)}). A blank id resolves to ${root}, which holds every task's home — the check would then pass on any path at all.`,
      { task_id: taskId ?? null, artifacts_dir: root },
    );
  }
  const home = path.resolve(root, taskId);
  if (!contains(root, home)) {
    throw new SmithError(
      'artifacts.unsafe-task-id',
      `Task id '${taskId}' resolves outside the artifacts directory (${home}). A task id names a directory under ${root}; it cannot climb out of it.`,
      { task_id: taskId, artifacts_dir: root, resolved: home },
    );
  }
  return home;
}

/**
 * `realpathSync`, falling back to the lexical path. A path can exist and still
 * fail to resolve — a permission wall on a parent is enough — and the answer
 * to "did this leave the home" is then the lexical one rather than a throw out
 * of a check that is supposed to return an issue list.
 */
function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True when `child` is `root` itself or lives beneath it. */
function contains(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Check every path a result declares as evidence. Relative paths resolve
 * against the task's home, so `coverage.txt` means the obvious thing and the
 * short spelling is also the correct one.
 *
 * Two properties, in this order. Inside the home first: a path in the wrong
 * place is wrong whether or not the file happens to be there today, and saying
 * `missing` about a `/tmp` file that exists would be false. Then existence:
 * an artifact that cannot be opened when the verdict is written is not
 * evidence.
 *
 * Inside is asked twice, of two different things. `path.resolve` answers it
 * about the string, which is what refuses `../elsewhere/coverage.txt`.
 * `realpathSync` answers it about the file, which is what refuses the same
 * file reached through a symlink named `evidence/` — and refuses a home that
 * is itself a link into a worktree, where every relative path under it spells
 * correctly and none of it survives the branch (D-193).
 *
 * Directories pass. An html coverage report and a Playwright trace are real
 * artifacts and neither is a file. What this does not check is whether the
 * bytes support the claim — that is a reviewer's job, not a stat call's.
 */
export function checkArtifacts(
  artifacts: readonly ArtifactDecl[],
  opts: ArtifactCheckOpts,
): ArtifactCheck {
  const root = path.resolve(opts.artifactsDir ?? STATE_ARTIFACTS_DIR);
  const home = homeUnder(root, opts.taskId);
  const issues: ArtifactIssue[] = [];

  // Where the home really is, and where it is supposed to be. They differ when
  // the home is itself a link — into a worktree, say — and then every relative
  // path under it spells correctly while none of it outlives the branch. A
  // home that was never created cannot mislead anyone: nothing resolves
  // through it, so every declaration under it comes back `missing` below.
  const realHome = existsSync(home) ? realOf(home) : home;
  const expectedHome = existsSync(home) ? homeUnder(realOf(root), opts.taskId) : home;
  const homeEscaped = realHome !== expectedHome;

  for (const decl of artifacts) {
    const resolved = path.resolve(home, decl.path);
    if (resolved === home) {
      issues.push({ declared: decl.path, resolved, problem: 'no-path' });
      continue;
    }
    if (!contains(home, resolved)) {
      issues.push({ declared: decl.path, resolved, problem: 'outside-home' });
      continue;
    }
    if (homeEscaped) {
      const real = path.resolve(realHome, decl.path);
      issues.push({ declared: decl.path, resolved: real, problem: 'outside-home' });
      continue;
    }
    if (!existsSync(resolved)) {
      issues.push({ declared: decl.path, resolved, problem: 'missing' });
      continue;
    }
    // Asked of the file now, not of the string: `evidence/coverage.txt` is
    // inside the home lexically and outside it in every sense that matters
    // when `evidence` is a link. Report where it went, since an issue naming
    // a correct-looking path is one the operator cannot act on.
    const real = realOf(resolved);
    if (!contains(realHome, real)) {
      issues.push({ declared: decl.path, resolved: real, problem: 'outside-home' });
    }
  }

  return { home, checked: artifacts.length, issues, ok: issues.length === 0 };
}
