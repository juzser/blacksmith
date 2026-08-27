import path from 'node:path';
import { fileURLToPath } from 'node:url';

// factory/orchestrator/src/paths.ts -> repo root is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

export const TAXONOMY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'taxonomy.yml');
export const SCHEMA_DIR = path.join(REPO_ROOT, 'factory', 'specs', 'schema');
export const SPECS_ACTIVE_DIR = path.join(REPO_ROOT, 'factory', 'specs', 'active');
export const STATE_EVENTS_DIR = path.join(REPO_ROOT, 'state', 'events');
/** Where a task's declared artifacts must live: `state/artifacts/<task-id>/` (P9-22). */
export const STATE_ARTIFACTS_DIR = path.join(REPO_ROOT, 'state', 'artifacts');
export const WORKTREE_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'worktree.yml');
export const STATE_DB_PATH = path.join(REPO_ROOT, 'state', 'smith.db');
/** The background watcher's lock and last tick: `state/daemon/{daemon.pid,status.json}`. */
export const STATE_DAEMON_DIR = path.join(REPO_ROOT, 'state', 'daemon');
export const DB_MIGRATIONS_DIR = path.join(REPO_ROOT, 'factory', 'orchestrator', 'drizzle');
export const ROADMAP_PATH = path.join(REPO_ROOT, 'factory', 'specs', 'roadmap.md');
export const SCAFFOLD_DIR = path.join(REPO_ROOT, 'factory', 'scaffold');
export const WORKSPACES_DIR = path.join(REPO_ROOT, 'workspaces');
export const SCHEDULER_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'scheduler.yml');
export const LESSONS_MD_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'lessons.md');
/** The shipped role templates — read at dispatch for their `<!-- LESSONS:<scope> -->` markers (P9-2). */
export const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');
export const CROSSCHECK_POLICY_PATH = path.join(REPO_ROOT, 'factory', 'policies', 'crosscheck.yml');
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
export const SANDBOX_LEASE_DIR = path.join(REPO_ROOT, 'state', 'sandboxes');
