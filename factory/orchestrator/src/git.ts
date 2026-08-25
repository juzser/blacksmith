import { execFileSync } from 'node:child_process';
import { SmithError } from './errors.js';

/**
 * The one place this factory shells out to git.
 *
 * P9-16(b)/D-24. `execFileSync` sends the child's stderr to the PARENT's
 * stderr unless `stdio` is given explicitly — the default is documented as
 * `'pipe'`, but stderr is inherited on top of it. Every module that had its
 * own two-line `git()` helper therefore printed git's chatter straight onto
 * the operator's terminal: `fatal: ref refs/remotes/origin/HEAD is not a
 * symbolic ref` for every project without a remote (which is every project
 * `smith new` creates), `Preparing worktree (new branch ...)` on each
 * dispatch, `warning: You appear to have cloned an empty repository.` The
 * factory speaks JSON on stdout; anything else on the terminal reads as a
 * failure that isn't one.
 *
 * Silencing a channel must not delete what was on it, which is the D-47
 * mistake one layer down. So stderr is captured and folded into the thrown
 * error: the operator sees nothing while git succeeds, and sees git's own
 * words the moment it doesn't.
 *
 * stdin is `'ignore'` rather than `'pipe'`: a git that decides to prompt —
 * for a credential, for an editor — would otherwise wait forever on input
 * that no unattended agent is going to type.
 */
export class GitCommandError extends SmithError {
  /** git's own stderr, credential-redacted. Empty when it said nothing. */
  readonly stderr: string;
  /** Exit code, or null when git was killed by a signal or never started. */
  readonly status: number | null;

  constructor(cwd: string, args: string[], status: number | null, stderr: string) {
    const said = stderr.trim();
    const how = status === null ? 'did not exit normally' : `exit ${status}`;
    super(
      'git.command-failed',
      `git ${args.join(' ')} failed in ${cwd} (${how})` +
        (said === '' ? ' and said nothing' : `: ${said}`),
      { cwd, args, status, stderr },
    );
    this.stderr = stderr;
    this.status = status;
  }
}

/** `https://user:token@host/…` → `https://user:***@host/…`, and the token-only form too. */
export function redactCredentials(text: string): string {
  return text.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+)@/g,
    (_match, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':');
      return colon === -1 ? `${scheme}***@` : `${scheme}${userinfo.slice(0, colon)}:***@`;
    },
  );
}

function exec(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; status?: number | null; code?: unknown };
    // A child that never spawned has no exit code; `code` carries the errno
    // string instead, and that is the only thing worth reporting.
    const status = typeof e.status === 'number' ? e.status : null;
    const said = e.stderr ?? (typeof e.code === 'string' ? `git could not be run (${e.code})` : '');
    throw new GitCommandError(cwd, args, status, redactCredentials(said));
  }
}

/** Run git and return its stdout, trailing newline removed. Throws GitCommandError. */
export function runGit(cwd: string, args: string[]): string {
  return exec(cwd, args).trim();
}

/**
 * Same, byte-for-byte. For `-z` output, where the record separator is a NUL
 * and the trailing one is part of the format rather than noise to trim.
 */
export function runGitRaw(cwd: string, args: string[]): string {
  return exec(cwd, args);
}
