import { execFileSync } from 'node:child_process';

/**
 * Why a worktree cannot be certified. Ordered by how directly the operator (or
 * the agent) can act on it: "commit your work" beats "your branch is empty",
 * because uncommitted work is *why* the branch is empty.
 */
export type CommitBlockReason =
  | 'not-a-git-worktree'
  | 'uncommitted-work'
  | 'unborn-branch'
  | 'unknown-base'
  | 'branch-not-advanced';

/** The taxonomy class raised when a task reports done with work still in the working tree. */
export const UNCOMMITTED_WORK_CODE = 'contract.uncommitted-work';
export type UncommittedWorkCode = typeof UNCOMMITTED_WORK_CODE;

const PORCELAIN_STATUS_WIDTH = 3; // "XY " — two status chars plus the separator

/**
 * What the gate can honestly say about the commit a task is asking to have
 * merged. Returned rather than thrown, like ImmutabilityCheckResult: a failed
 * certification is a gate outcome the caller reports, not an exception it has
 * to catch.
 */
export interface CommitCertificate {
  /** The verdict. Read this, not `dirty.length`. */
  certified: boolean;
  reason: CommitBlockReason | null;
  /** The sha the checks would actually be covering; null on an unborn branch or a non-repo. */
  head: string | null;
  /** null when HEAD is detached, or when there is no repo to ask. */
  branch: string | null;
  /** Repo-relative paths git considers dirty, staged, or untracked. */
  dirty: string[];
  /** The ref the branch must be ahead of, echoed back; null when the caller gave none. */
  baseRef: string | null;
  baseSha: string | null;
  /**
   * Commits on HEAD that are not on the base. `null` — not `0` — when no base
   * was given, so a reader can tell "the branch is empty" apart from "nobody
   * asked".
   */
  commitsAhead: number | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

function isGitWorktree(worktreeDir: string): boolean {
  try {
    git(worktreeDir, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

function headSha(worktreeDir: string): string | null {
  try {
    return git(worktreeDir, ['rev-parse', 'HEAD']);
  } catch {
    return null; // unborn branch — nothing has ever been committed here
  }
}

function currentBranch(worktreeDir: string): string | null {
  try {
    return git(worktreeDir, ['branch', '--show-current']) || null; // empty when detached
  } catch {
    return null;
  }
}

function resolveRef(worktreeDir: string, ref: string): string | null {
  try {
    return git(worktreeDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * Every path git currently reports as dirty, staged or untracked, `-z`-parsed
 * so spaces and newlines in filenames survive. Renames emit destination then
 * source; both count, since a rename left two paths uncommitted.
 *
 * Deliberately without `--ignored`: build output and node_modules are not work
 * the coder forgot to commit, and a gate that blocked on `dist/` would be
 * unusable in exactly the repos that need it most.
 *
 * `--untracked-files=all` for the two reasons its siblings in `claims.ts` and
 * `immutability.ts` already pass it, and one more that only bites here (D-178):
 * the default `normal` collapses a whole new directory into a single `src/`
 * entry, so a certificate promising to name every dirty path named a directory
 * instead; and the mode is *configurable*, so a repo, global, or system
 * `status.showUntrackedFiles = no` made untracked work invisible to the read
 * and this gate certified a worktree with uncommitted new files. Passing it
 * explicitly makes the setting unable to weaken the check — which is the whole
 * point of D-30. Untracked is not an edge case here: a task's first write is
 * usually a new file.
 */
function dirtyPaths(worktreeDir: string): string[] {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: worktreeDir,
    encoding: 'utf8',
  });

  const fields = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length <= PORCELAIN_STATUS_WIDTH) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(PORCELAIN_STATUS_WIDTH));
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[i + 1];
      if (source) paths.push(source);
      i++;
    }
  }
  return paths;
}

function blocked(
  reason: CommitBlockReason,
  rest: Omit<CommitCertificate, 'certified' | 'reason'>,
): CommitCertificate {
  return { certified: false, reason, ...rest };
}

/**
 * Certify that a task worktree holds a commit worth merging (P9-8 / D-30).
 *
 * The gate scores a worktree; the merge queue merges a *branch*. When a task
 * leaves its work staged-but-uncommitted, those are two different things: every
 * check goes green against the working tree while the merge is a no-op that
 * still reports success. This closes that gap from the cheap end — no checkout,
 * two git reads — by refusing to score a worktree that is dirty, and refusing
 * one whose branch head still equals the integration base it was cut from.
 *
 * `baseRef` is optional: an ad-hoc `gate run` against a repo with no
 * integration branch is not forced to invent one, and says `commitsAhead: null`
 * rather than pretending that half ran.
 */
export function certifyCommit(
  worktreeDir: string,
  opts: { baseRef?: string } = {},
): CommitCertificate {
  const baseRef = opts.baseRef ?? null;
  const empty = { head: null, branch: null, dirty: [], baseRef, baseSha: null, commitsAhead: null };

  if (!isGitWorktree(worktreeDir)) return blocked('not-a-git-worktree', empty);

  const branch = currentBranch(worktreeDir);
  const dirty = dirtyPaths(worktreeDir);
  const head = headSha(worktreeDir);

  // Dirt first: when a worktree is both dirty and unadvanced, the uncommitted
  // work is the cause and "commit it" is the whole fix.
  if (dirty.length > 0) {
    return blocked('uncommitted-work', {
      head,
      branch,
      dirty,
      baseRef,
      baseSha: null,
      commitsAhead: null,
    });
  }
  if (head === null) return blocked('unborn-branch', { ...empty, branch });

  if (baseRef === null) {
    return {
      certified: true,
      reason: null,
      head,
      branch,
      dirty,
      baseRef,
      baseSha: null,
      commitsAhead: null,
    };
  }

  const baseSha = resolveRef(worktreeDir, baseRef);
  if (baseSha === null) {
    return blocked('unknown-base', {
      head,
      branch,
      dirty,
      baseRef,
      baseSha: null,
      commitsAhead: null,
    });
  }

  const commitsAhead = Number(git(worktreeDir, ['rev-list', '--count', `${baseSha}..HEAD`]));
  if (commitsAhead === 0) {
    return blocked('branch-not-advanced', { head, branch, dirty, baseRef, baseSha, commitsAhead });
  }
  return { certified: true, reason: null, head, branch, dirty, baseRef, baseSha, commitsAhead };
}
