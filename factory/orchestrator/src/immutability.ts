import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SmithError } from './errors.js';
import { runGit as git, runGitRaw } from './git.js';

export class ImmutabilityError extends SmithError {}

/** The taxonomy class raised when a judge moved the worktree it was judging. */
export const JUDGE_MUTATION_CODE = 'contract.judge-mutation';
export type JudgeMutationCode = typeof JUDGE_MUTATION_CODE;

const PORCELAIN_STATUS_WIDTH = 3; // "XY " — two status chars plus the separator
const HASH_LENGTH = 12;
const GONE = 'gone';
const HEAD_PATH = 'HEAD';

/** One path git already considers dirty or untracked, plus the bytes behind it. */
export interface FingerprintEntry {
  /** The two-character porcelain XY code (`" M"`, `"??"`, `"M "`, `" D"`, …). */
  status: string;
  /** Truncated sha256 of the working-tree bytes; null when the path is gone. */
  hash: string | null;
}

/**
 * What the worktree looked like the moment before a judge was dispatched.
 * Deliberately blind to gitignored paths — see fingerprintWorktree.
 */
export interface WorktreeFingerprint {
  head: string | null;
  branch: string | null;
  entries: Record<string, FingerprintEntry>;
}

export type DriftKind = 'head-moved' | 'branch-switched' | 'dirtied' | 'reverted' | 'modified';

export interface WorktreeDrift {
  kind: DriftKind;
  /** Repo-relative path, or `"HEAD"` for the two ref drifts. */
  path: string;
  before: string | null;
  after: string | null;
}

export interface ImmutabilityCheckResult {
  /** The verdict. Read this, not `drift.length`. */
  unchanged: boolean;
  drift: WorktreeDrift[];
  violation: { error: JudgeMutationCode; paths: string[] } | null;
}

function assertGitWorktree(worktreeDir: string): void {
  try {
    git(worktreeDir, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    throw new ImmutabilityError(
      'immutability.not-a-git-worktree',
      `${worktreeDir} is not a git worktree: ${err instanceof Error ? err.message : String(err)}`,
      { worktreeDir },
    );
  }
}

function headSha(worktreeDir: string): string | null {
  try {
    return git(worktreeDir, ['rev-parse', 'HEAD']);
  } catch {
    return null; // unborn branch — a worktree with no commits yet
  }
}

function currentBranch(worktreeDir: string): string | null {
  try {
    return git(worktreeDir, ['branch', '--show-current']) || null; // empty when detached
  } catch {
    return null;
  }
}

function hashFile(worktreeDir: string, relPath: string): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(worktreeDir, relPath)))
      .digest('hex')
      .slice(0, HASH_LENGTH);
  } catch {
    return null; // deleted, a directory, or unreadable — all "no bytes here"
  }
}

/**
 * Every path git currently reports as dirty or untracked, `-z`-parsed so
 * spaces and newlines in filenames survive. Renames and copies emit two
 * fields (destination then source); both are recorded, since a judge that
 * renamed a file moved two paths.
 */
function statusEntries(worktreeDir: string): Record<string, FingerprintEntry> {
  const output = runGitRaw(worktreeDir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);

  const fields = output.split('\0');
  const entries: Record<string, FingerprintEntry> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length <= PORCELAIN_STATUS_WIDTH) continue;
    const status = field.slice(0, 2);
    const target = field.slice(PORCELAIN_STATUS_WIDTH);
    entries[target] = { status, hash: hashFile(worktreeDir, target) };
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[i + 1];
      if (source) entries[source] = { status, hash: hashFile(worktreeDir, source) };
      i++;
    }
  }
  return entries;
}

/**
 * The state a judge must hand back untouched: HEAD, the checked-out branch,
 * and every dirty/untracked path with a hash of its bytes.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. **Content hashes, not just the status list.** Six roles (reviewer,
 *    verifier, grader, spec-reviewer, security-reviewer, uiux) are read-only
 *    in prose and hold `Bash` in fact (agent-interviews.md N-10), so the
 *    guarantee needs a check. A status-only fingerprint has a hole exactly
 *    where it matters: the coder leaves `src/parse.ts` dirty, the judge edits
 *    it again, and the porcelain line reads `" M src/parse.ts"` both times.
 *    The hash closes it.
 * 2. **No `--ignored`.** Judges run the suite — that is what `Bash` is for —
 *    and running it writes `node_modules/`, `dist/`, coverage caches. A guard
 *    that fired on those would be turned off within a day. Widening
 *    `.gitignore` is not an escape hatch: that edit is itself a tracked-file
 *    change, and ignore rules never apply to already-tracked files.
 *
 * The remaining hole is honest and small: an edit reverted byte-for-byte
 * before the judge exits is invisible to any before/after comparison.
 */
export function fingerprintWorktree(worktreeDir: string): WorktreeFingerprint {
  assertGitWorktree(worktreeDir);
  return {
    head: headSha(worktreeDir),
    branch: currentBranch(worktreeDir),
    entries: statusEntries(worktreeDir),
  };
}

function describe(entry: FingerprintEntry): string {
  return `${entry.status} ${entry.hash ?? GONE}`;
}

function assertFingerprint(value: WorktreeFingerprint): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.entries !== 'object' ||
    value.entries === null ||
    !('head' in value)
  ) {
    throw new ImmutabilityError(
      'immutability.invalid-fingerprint',
      'The before-fingerprint is not a WorktreeFingerprint ({ head, branch, entries }).',
      { received: value === null ? 'null' : typeof value },
    );
  }
}

/**
 * Compare the worktree as it stands now against the fingerprint taken before
 * a judge ran. Any difference is a violation: the judge is not the coder, and
 * the one path it may write is its own artifact under `state/results/`, which
 * lives outside the worktree.
 */
export function checkWorktreeImmutable(
  worktreeDir: string,
  before: WorktreeFingerprint,
): ImmutabilityCheckResult {
  assertFingerprint(before);
  const after = fingerprintWorktree(worktreeDir);

  const drift: WorktreeDrift[] = [];
  if (before.head !== after.head) {
    drift.push({ kind: 'head-moved', path: HEAD_PATH, before: before.head, after: after.head });
  }
  if (before.branch !== after.branch) {
    drift.push({
      kind: 'branch-switched',
      path: HEAD_PATH,
      before: before.branch,
      after: after.branch,
    });
  }

  for (const key of [
    ...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]),
  ].sort()) {
    const wasEntry = before.entries[key];
    const isEntry = after.entries[key];
    if (!wasEntry && isEntry) {
      drift.push({ kind: 'dirtied', path: key, before: null, after: describe(isEntry) });
    } else if (wasEntry && !isEntry) {
      drift.push({ kind: 'reverted', path: key, before: describe(wasEntry), after: null });
    } else if (wasEntry && isEntry && describe(wasEntry) !== describe(isEntry)) {
      drift.push({
        kind: 'modified',
        path: key,
        before: describe(wasEntry),
        after: describe(isEntry),
      });
    }
  }

  const unchanged = drift.length === 0;
  return {
    unchanged,
    drift,
    violation: unchanged
      ? null
      : { error: JUDGE_MUTATION_CODE, paths: [...new Set(drift.map((d) => d.path))] },
  };
}
