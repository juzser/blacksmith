import { SmithError } from './errors.js';
import { appendEvent, type EventOpts, type StoredEvent } from './events.js';
import type { EventContext } from './findings.js';
import { runGit as git } from './git.js';
import { type CheckCommand, type CheckResult, run } from './testgate.js';
import { integrationBranchName, RESERVED_TASK_ID } from './worktree.js';

/**
 * D-42/P9-26, second half. Moving the worktrees outside the project root
 * (worktree.ts) fixes the tool that went red; it does not fix the reason
 * nobody noticed for six tasks. Every check this factory runs — schema,
 * tests, lint, review — runs inside a task worktree, so every quality claim
 * it makes is a claim about a worktree. The assembled integration branch had
 * never had one command run against it when the epic was declared shippable.
 * The run that caught D-42 took eleven seconds and happened because a human
 * typed it.
 *
 * This module is that run, as a logged fact: the full check suite, executed
 * at the project root while the integration branch is checked out, recorded
 * as an `integration-check` event that epic.ts's verdict gate then requires.
 *
 * It REFUSES rather than acts in the two cases where acting would be worse
 * than stopping — a project that isn't on the integration branch (checking
 * it out would be a destructive git op on the operator's own clone) and a
 * dirty working tree (the checks would certify something that is not the
 * branch). Both are one operator command away from fixed, and both are
 * silent corruption of the record if guessed at.
 */
export class IntegrationCheckError extends SmithError {}

export const INTEGRATION_CHECK_EVENT = 'integration-check';

/** One recorded run of the check suite against an epic's assembled branch. */
export interface IntegrationCheckRecord {
  epicId: string;
  branch: string;
  /** The commit the checks actually ran against — what makes a record stale or current. */
  headSha: string;
  pass: boolean;
  results: CheckResult[];
  eventId: string;
  ts: string;
}

export interface IntegrationCheckInput {
  epicId: string;
  projectDir: string;
  checks: CheckCommand[];
  /**
   * Default TRUE, unlike the per-task gate. A task gate short-circuits
   * because the coder only needs the first thing to fix; the operator
   * closing an epic wants the whole picture of the assembled branch in one
   * pass.
   */
  runAll?: boolean;
  timeoutMs?: number;
}

function branchHead(projectDir: string, branch: string): string | null {
  try {
    return git(projectDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) || null;
  } catch {
    return null;
  }
}

/**
 * The current head of `smith/<epic>/integration`, or null when the epic has
 * no integration branch (never planned, never dispatched, wrong --epic).
 * Read here rather than inside epic.ts so the verdict stays git-free and
 * purely a fold over events — the CLI passes the sha in.
 */
export function integrationHeadSha(projectDir: string, epicId: string): string | null {
  return branchHead(projectDir, integrationBranchName(epicId));
}

/** Last-wins fold: the most recent recorded check for this epic, or null. */
export function latestIntegrationCheck(
  events: readonly StoredEvent[],
  epicId: string,
): IntegrationCheckRecord | null {
  let latest: IntegrationCheckRecord | null = null;
  for (const event of events) {
    if (event.record.event_type !== INTEGRATION_CHECK_EVENT) continue;
    const payload = event.record.payload as Record<string, unknown>;
    if (payload.epic_id !== epicId) continue;
    latest = {
      epicId,
      branch: String(payload.branch ?? ''),
      headSha: String(payload.head_sha ?? ''),
      pass: payload.pass === true,
      results: (payload.results ?? []) as CheckResult[],
      eventId: event.event_id,
      ts: event.record.ts,
    };
  }
  return latest;
}

/**
 * Run the check suite at the project root against the epic's assembled
 * integration branch and record the outcome as an event.
 *
 * A FAILING suite is a recorded failure, not a throw — that is the whole
 * point of the record. A suite that could not honestly be run at all (no
 * checks, wrong branch, dirty tree, no branch) throws instead, because the
 * one thing this must never do is write down a pass that nothing earned.
 */
export async function runIntegrationCheck(
  input: IntegrationCheckInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<IntegrationCheckRecord> {
  const { epicId, projectDir } = input;
  const branch = integrationBranchName(epicId);

  // testgate.run([]) returns pass: true for an empty list — correct there
  // (a task claiming no checks has nothing to short-circuit), and a silent
  // forgery here. "No checks configured" must never read back as "the
  // assembled branch passed its checks".
  if (input.checks.length === 0) {
    throw new IntegrationCheckError(
      'integration.no-checks',
      `Refusing to certify epic "${epicId}" with an empty check list: an empty suite would record a pass nothing ran for.`,
      { epicId, branch },
    );
  }

  const headSha = branchHead(projectDir, branch);
  if (headSha === null) {
    throw new IntegrationCheckError(
      'integration.branch-missing',
      `Epic "${epicId}" has no integration branch (${branch}) in ${projectDir} — there is nothing assembled to check.`,
      { epicId, branch, projectDir },
    );
  }

  let currentBranch: string;
  try {
    currentBranch = git(projectDir, ['branch', '--show-current']);
  } catch (cause) {
    throw new IntegrationCheckError(
      'integration.not-a-repo',
      `Could not read the current branch in ${projectDir}: ${String(cause)}`,
      { projectDir },
    );
  }

  // The checks run against the working tree, so the working tree has to BE
  // the integration branch. Checking it out for the operator would be a
  // destructive git op on their own clone (guardrails.md) — refuse instead.
  if (currentBranch !== branch) {
    throw new IntegrationCheckError(
      'integration.wrong-branch',
      `${projectDir} is on "${currentBranch || '(detached HEAD)'}", not the integration branch "${branch}". Check it out first — this command will not move your working tree for you.`,
      { epicId, branch, currentBranch, projectDir },
    );
  }

  // `--untracked-files=all` explicitly: the mode is configurable, and a
  // `status.showUntrackedFiles = no` anywhere in git's config chain made an
  // untracked-only tree read back as clean — which is exactly the tree someone
  // forgot to commit, certified under a head it does not match (D-178).
  const dirty = git(projectDir, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) {
    throw new IntegrationCheckError(
      'integration.dirty-tree',
      `${projectDir} has uncommitted changes; a check run against a dirty tree certifies something that is not ${branch} at ${headSha.slice(0, 8)}.`,
      { epicId, branch, projectDir, dirtyEntries: dirty.split('\n').length },
    );
  }

  const outcome = await run(input.checks, {
    cwd: projectDir,
    runAll: input.runAll ?? true,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });

  const stored = await appendEvent(
    {
      session_id: ctx.sessionId,
      actor: ctx.actor ?? 'system',
      event_type: INTEGRATION_CHECK_EVENT,
      task_id: `${epicId}/${RESERVED_TASK_ID}`,
      plan_version: ctx.planVersion,
      causal_parent: ctx.causalParent,
      payload: {
        epic_id: epicId,
        branch,
        head_sha: headSha,
        pass: outcome.pass,
        results: outcome.results,
      },
    },
    opts,
  );

  return {
    epicId,
    branch,
    headSha,
    pass: outcome.pass,
    results: outcome.results,
    eventId: stored.event_id,
    ts: stored.record.ts,
  };
}
