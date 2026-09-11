import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// factory/orchestrator/src/paths.ts -> repo root is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * What the factory *is*: the policies, schemas, scaffold, migrations and role
 * templates the CLI reads and never writes. Derived from this module's own
 * location, so under an npm install it is the package directory inside
 * `node_modules` -- which is the right answer, because every one of those
 * assets ships in the tarball. `packaging.test.ts` holds that claim.
 */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

/**
 * Is this module running out of the blacksmith clone, or out of an installed
 * copy of the package?
 *
 * `.git` is the signal because a tarball never carries one: npm strips it, and
 * `package.json#files` could not ship it if it tried. A linked worktree spells
 * it as a file rather than a directory, which `existsSync` reads either way.
 */
const IS_CLONE = existsSync(path.join(REPO_ROOT, '.git'));

/**
 * Where the work root goes when the CLI is not standing in a clone.
 *
 * A dot-directory rather than a bare `state/` and `factory/`, because under an
 * install the operator's own project is the working directory and two
 * top-level directories appearing in it are the tool making itself at home in
 * somebody else's repo. One is enough, and it is the same name the audit store
 * already uses (`<project>/.blacksmith/findings.jsonl`).
 */
const WORK_DIR_NAME = '.blacksmith';

/**
 * Where everything this CLI *writes* is rooted -- state, epic plans, the
 * operator's `.env`.
 *
 * Pure, and exported for the test: the constants below call it once at module
 * load, but the install case can only be stated by a test that passes its own
 * roots in. `env.SMITH_HOME` wins outright; otherwise a clone keeps writing
 * into itself, and an install writes beside the operator instead of into
 * `node_modules/@juzser/blacksmith`, which the next `npm i` replaces wholesale.
 *
 * The layout *under* the root is identical in both cases on purpose. A path
 * like `state/events/<session>.jsonl` is spelled in runbooks, in agent
 * templates and in `guardrails.yml`'s write roots, and all of those stay true
 * if only the anchor moves.
 */
export function resolveWorkRoot(
  repoRoot: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  isClone: boolean,
): string {
  const declared = env.SMITH_HOME?.trim();
  // An empty `SMITH_HOME=` is how an unset variable gets spelled by accident in
  // a shell profile or a CI matrix; resolved literally it would mean cwd.
  if (declared) return path.resolve(cwd, declared);
  return isClone ? repoRoot : path.join(cwd, WORK_DIR_NAME);
}

/**
 * Where `smith new` puts a project when `--target-dir` says nothing.
 *
 * Beside the clone, never inside it (D-42) -- but the parent of an *installed*
 * package is `node_modules/@juzser`, which is not a place a project may be
 * written. Without a clone "beside the clone" has no referent, and the honest
 * substitute is the directory the operator is standing in.
 */
export function resolveProjectsDir(repoRoot: string, cwd: string, isClone: boolean): string {
  return isClone ? path.dirname(repoRoot) : cwd;
}

export const WORK_ROOT = resolveWorkRoot(REPO_ROOT, process.cwd(), process.env, IS_CLONE);

/**
 * The operator's own `.env`, read at CLI start by `loadDotEnv`. Gitignored, and
 * the one place `docs/runbooks/providers.md` tells an operator to put a
 * provider key. Anchored on the work root, not on cwd: an agent runs `smith`
 * from a worktree, and the key belongs to the operator's clone -- and not on
 * REPO_ROOT either, since under an install that is a file `npm i` deletes.
 */
export const DOTENV_PATH = path.join(WORK_ROOT, '.env');

export const TAXONOMY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'taxonomy.yml');
export const SCHEMA_DIR = path.join(REPO_ROOT, 'factory', 'specs', 'schema');
export const SPECS_ACTIVE_DIR = path.join(WORK_ROOT, 'factory', 'specs', 'active');
export const STATE_EVENTS_DIR = path.join(WORK_ROOT, 'state', 'events');
/** Where a task's declared artifacts must live: `state/artifacts/<task-id>/` (P9-22). */
export const STATE_ARTIFACTS_DIR = path.join(WORK_ROOT, 'state', 'artifacts');
export const WORKTREE_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'worktree.yml');
export const STATE_DB_PATH = path.join(WORK_ROOT, 'state', 'smith.db');
/** The background watcher's lock and last tick: `state/daemon/{daemon.pid,status.json}`. */
export const STATE_DAEMON_DIR = path.join(WORK_ROOT, 'state', 'daemon');
export const DB_MIGRATIONS_DIR = path.join(REPO_ROOT, 'factory', 'orchestrator', 'drizzle');
export const ROADMAP_PATH = path.join(REPO_ROOT, 'factory', 'specs', 'roadmap.md');
export const SCAFFOLD_DIR = path.join(REPO_ROOT, 'factory', 'scaffold');
/**
 * `workspaces/` inside this clone. Still a legal place to keep a project, and
 * still searched for ones already there -- no longer where a new one goes.
 */
export const WORKSPACES_DIR = path.join(WORK_ROOT, 'workspaces');
/**
 * Where a project lands when nothing says otherwise: beside this clone.
 *
 * A project this factory builds is not a part of it -- it takes no dependency
 * on it and carries no mark of it -- and a project scaffolded under REPO_ROOT
 * contradicted that from the first commit: inside this clone's git tree, its
 * ignore rules and its lint roots, and read as factory code by every tool that
 * walks up from a file inside it. Beside, not within. A task's worktrees follow
 * it there on their own, since worktree.ts places them next to the project it
 * is handed rather than at a path of its own choosing.
 */
export const PROJECTS_DIR = resolveProjectsDir(REPO_ROOT, process.cwd(), IS_CLONE);
export const SCHEDULER_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'scheduler.yml');
export const LESSONS_MD_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'lessons.md');
/** The shipped role templates — read at dispatch for their `<!-- LESSONS:<scope> -->` markers (P9-2). */
export const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');
export const CROSSCHECK_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'crosscheck.yml');
/** Who may hold `Agent` — read by `smith delegation check` (delegation.ts, D13 step 3). */
export const DELEGATION_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'delegation.yml');
export const BUDGETS_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'budgets.yml');
/** How much judgment an epic buys — read by `smith effort show` (effort.ts). */
export const EFFORT_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'effort.yml');
/** The security-reviewer's dispatch triggers — read by `smith security triggers` (P9-4). */
export const SENSITIVE_PATHS_POLICY_PATH = path.join(
  REPO_ROOT,
  'factory',
  'policies',
  'sensitive-paths.yml',
);

/** The guard hook's rule data — read by `smith policy check`/`smith policy hook` (policy.ts). */
export const GUARDRAILS_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'guardrails.yml');

/**
 * The S1-S4 ladder and which levels block a merge (severity.ts).
 *
 * Declared here like every other policy file rather than inside severity.ts,
 * which held its own `${REPO_ROOT}/factory/policies/severity.yml` — a second
 * spelling of a path this module exists to spell once, and the only one built
 * by interpolation instead of path.join.
 */
export const SEVERITY_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'severity.yml');

/**
 * The operator's stack answers, recorded at install time (stack.ts).
 *
 * A declaration, not state: it is what this operator said they build with,
 * and the scaffolder reads it instead of the prose in docs/standards/stack.md
 * — which described one operator's stack as if it were everyone's.
 */
export const STACK_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'stack.yml');

/**
 * Open judge sandbox leases, one file per worktree (sandbox.ts).
 *
 * Under `state/` because a lease is state, not a declaration — and in the
 * main clone rather than the judge's own worktree, which is the point: a
 * judge cannot revoke its own guard by deleting a file it is not allowed to
 * reach.
 */
export const SANDBOX_LEASE_DIR = path.join(WORK_ROOT, 'state', 'sandboxes');
