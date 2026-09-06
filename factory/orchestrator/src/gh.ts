// The second half of the pure core for factory-error-log: WHICH repository a
// project belongs to, WHETHER `gh` can be used at all, and WHAT argv the
// three `gh` commands this epic ever runs would be. Nothing here spawns
// `gh`. No task in this epic may run `gh issue create` against a real
// tracker as part of its own acceptance -- opening a real issue to prove the
// code opens issues is a side effect no gate can undo -- so the thing every
// test in this module asserts on is the argv that WOULD have been run.
//
// SECURITY (this module's whole blast radius): the commands it composes run
// under a `gh` token with `repo` scope. It therefore never interpolates
// untrusted text into a command string, never sets `shell: true`, never logs
// a remote URL without `redactCredentials`, and never reads, stores, prints
// or passes a token itself -- `readOriginUrl` (git.ts) hands back whatever
// git reports, credentials included, and this module only ever extracts the
// host and slug out of it, discarding the rest.
//
// Issue bodies travel by `--body-file <temp file>`, not `--body <text>` and
// not stdin. `execFileSync` without `shell: true` never re-parses an argv
// element through a shell, so `--body` would already be safe from injection
// -- but gh's own flag parser still has to accept the value, and a body with
// embedded newlines or an argv-length limit is gh's problem, not a shell's.
// `--body-file` sidesteps both, and unlike stdin it keeps the injected
// runner's signature -- `(cmd, args) => result`, no stdin channel -- the same
// shape for every command this module builds.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitCommandError, readOriginUrl, redactCredentials } from './git.js';
import type { ProjectRef } from './projects.js';

/** A resolved slug. The only shape a caller should treat as "we know the repo". */
export interface RepoSuccess {
  readonly slug: string;
}

/**
 * The closed, named set of ways this module can fail to answer "which
 * repository". Never `null`, never an empty string, never a shared error --
 * D-133's rule: a well-formed wrong answer is worse than a refusal, and a
 * caller that cannot tell "no remote" from "not a repo" will report one as
 * the other.
 */
export type RepoRefusalReason =
  | 'no-checkout'
  | 'not-a-repo'
  | 'no-origin'
  | 'unparseable-remote'
  | 'non-github-host';

export interface RepoRefusal {
  readonly reason: RepoRefusalReason;
  readonly detail: string;
}

export type RepoResolution = RepoSuccess | RepoRefusal;

const HTTPS_RE = /^https?:\/\/(?:[^/@]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SSH_URL_RE = /^ssh:\/\/git@([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const SCP_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/;

function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
  for (const re of [HTTPS_RE, SSH_URL_RE, SCP_RE]) {
    const m = url.match(re);
    if (m) return { host: m[1] ?? '', owner: m[2] ?? '', repo: m[3] ?? '' };
  }
  return null;
}

/**
 * Turns a git remote URL into an `owner/repo` slug. Parses the https, scp-
 * style and `ssh://` forms, including an https URL carrying userinfo
 * credentials -- the credentials are never part of the returned value. A
 * host that is not `github.com` is refused, not guessed.
 */
export function slugFromRemoteUrl(url: string): RepoResolution {
  const parsed = parseRemote(url);
  const safeUrl = redactCredentials(url);
  if (!parsed) {
    return { reason: 'unparseable-remote', detail: `cannot parse remote URL: ${safeUrl}` };
  }
  if (parsed.host !== 'github.com') {
    return {
      reason: 'non-github-host',
      detail: `remote host "${parsed.host}" is not github.com: ${safeUrl}`,
    };
  }
  return { slug: `${parsed.owner}/${parsed.repo}` };
}

/**
 * Which repository the git checkout at `dir` belongs to. Reads `origin`
 * through git.ts's `readOriginUrl` and classifies a failure into the two
 * reasons it can mean (`not-a-repo`, `no-origin`) before handing a resolved
 * URL to `slugFromRemoteUrl`. Never throws for those two cases; a
 * `GitCommandError` this function does not recognise is a programming or
 * environment error and is rethrown rather than mis-filed under one of the
 * five named reasons.
 */
export function resolveRepoAtDir(dir: string): RepoResolution {
  let url: string;
  try {
    url = readOriginUrl(dir);
  } catch (err) {
    if (err instanceof GitCommandError) {
      if (/not a git repository/i.test(err.stderr)) {
        return { reason: 'not-a-repo', detail: `${dir} is not a git repository` };
      }
      return { reason: 'no-origin', detail: `${dir} has no "origin" remote` };
    }
    throw err;
  }
  return slugFromRemoteUrl(url);
}

/**
 * Which repository a named project belongs to, answered from a register
 * handed in -- never from a name lookup under `PROJECTS_DIR`/`WORKSPACES_DIR`
 * and never a fallback to this process's own directory. `projects.ts`
 * states why: this clone's parent can hold an unrelated checkout with an
 * unrelated remote, and a name lookup would read somebody else's repository
 * while reporting it as this project's own -- D-133's shape, aimed here at
 * an outward-facing side effect (an issue filed on the wrong tracker) that
 * no gate can undo. A project the register does not name is refused as
 * `no-checkout`, not answered with any other project's slug.
 */
export function resolveProjectRepo(
  project: string,
  register: readonly ProjectRef[],
): RepoResolution {
  const entry = register.find((r) => r.name === project);
  if (!entry) {
    return { reason: 'no-checkout', detail: `no checkout registered for project "${project}"` };
  }
  return resolveRepoAtDir(entry.dir);
}

/** One invocation's outcome: exit status, stdout, stderr, and never a throw. */
export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the child process never started -- node's own errno string, e.g. `'ENOENT'`. */
  readonly spawnError?: string;
}

/** Injected so no test in this epic ever runs a real command. */
export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

/** Not reachable from the test suite: every test in gh.test.ts passes a stub. */
function defaultRunner(cmd: string, args: string[]): CommandResult {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number | null; code?: unknown };
    const status = typeof e.status === 'number' ? e.status : null;
    const spawnError = typeof e.code === 'string' ? e.code : undefined;
    return {
      status,
      stdout: e.stdout ?? '',
      stderr: redactCredentials(e.stderr ?? ''),
      spawnError,
    };
  }
}

/**
 * The closed, named set of `gh` availability outcomes. A boolean collapses
 * "not installed" and "installed but not logged in" into one word, and makes
 * the operator's remedy (`brew install gh` versus `gh auth login`)
 * unguessable -- so this is at least three distinct outcomes plus an
 * explicit `unknown` for anything the other three do not recognise.
 */
export type GhAvailability =
  | { readonly outcome: 'ready' }
  | { readonly outcome: 'missing'; readonly reason: string }
  | { readonly outcome: 'unauthenticated'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

/** Classifies `gh` availability by driving `gh auth status` through the injected runner. */
export function classifyGh(runner: CommandRunner = defaultRunner): GhAvailability {
  const result = runner('gh', ['auth', 'status']);
  if (result.spawnError !== undefined) {
    return { outcome: 'missing', reason: `gh could not be run (${result.spawnError})` };
  }
  if (result.status === 0) {
    return { outcome: 'ready' };
  }
  const said = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (said.includes('not logged') || said.includes('auth login')) {
    return {
      outcome: 'unauthenticated',
      reason: result.stderr.trim() || result.stdout.trim(),
    };
  }
  return { outcome: 'unknown', reason: `gh auth status exited ${String(result.status)}` };
}

/**
 * Writes `body` to a fresh temp file and returns its path, for `--body-file`.
 * The body never becomes an argv element, so "no element of argv contains a
 * composed shell fragment" holds by construction.
 */
function writeBodyFile(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-gh-body-'));
  const file = path.join(dir, 'body.md');
  writeFileSync(file, body, 'utf8');
  return file;
}

/** Pure builder: the argv for `gh issue create`. Spawns nothing. */
export function buildCreateIssueArgv(repo: string, title: string, body: string): string[] {
  return ['issue', 'create', '--repo', repo, '--title', title, '--body-file', writeBodyFile(body)];
}

/** Pure builder: the argv for `gh issue list` restricted to open issues matching `query`. */
export function buildSearchIssuesArgv(repo: string, query: string): string[] {
  return [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--search',
    query,
    '--json',
    'number,title,url',
  ];
}

/** Pure builder: the argv for `gh issue comment`. Spawns nothing. */
export function buildCommentArgv(repo: string, issueNumber: number, body: string): string[] {
  return [
    'issue',
    'comment',
    String(issueNumber),
    '--repo',
    repo,
    '--body-file',
    writeBodyFile(body),
  ];
}
