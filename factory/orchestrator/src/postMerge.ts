import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type EventOpts, readLineageEvents } from './events.js';
import type { EventContext } from './findings.js';
import { GitCommandError, runGit as git } from './git.js';
import {
  IntegrationCheckError,
  type IntegrationCheckRecord,
  runIntegrationCheck,
} from './integration.js';
import {
  assertIntegrationBranch,
  type Culprit,
  findPostMergeCulprit,
  type PostMergeInput,
  type PostMergeOutcome,
  type ProbeStep,
} from './postMergeBisect.js';
import { type ResumeCulprit, resumeLandedReverts } from './postMergeResume.js';
import { landCandidate } from './queue.js';
import { recordWaveReverted, WaveRevertedError, waveRevertBlocker } from './revert.js';
import { isNotRun, selectTier } from './testgate.js';

/**
 * Spec D4's post-merge batch end to end: resume what crashed, find the culprit,
 * build its revert with `git revert -m 1`, test and record that exact commit
 * with the pre-merge and post-merge tiers, land it through the queue's landing
 * path, and only then write `wave-reverted`. The ref moves only in `landCandidate`.
 * A culprit whose revert cannot be tested that way (no pre-merge check) is reported
 * as `revert-not-applicable` with reason `no-pre-merge-checks`: nothing is built or landed.
 */
export type RevertOutcome =
  | PostMergeOutcome
  | 'reverted'
  | 'revert-recorded'
  | 'revert-not-applicable'
  | 'revert-conflict'
  | 'revert-red'
  | 'integration-dirty'
  | 'integration-moved';

export type PostMergeCulprit = Culprit & { reproduced: true };

export interface PostMergeRunResult {
  outcome: RevertOutcome;
  resumed: boolean;
  reason?: string;
  setup_failed?: { step: ProbeStep | 'revert'; commit: string };
  dependents?: string[];
  culprits: PostMergeCulprit[];
  revert_sha?: string;
  /** `red-at-base` caused only by landed bs reverts: their shas, so it is not read as predating the batch. */
  red_after_revert?: string[];
  event_ids: string[];
}

export interface PostMergeRunOpts extends EventOpts {
  /** Test seam: called once with the revert's scratch worktree path, right after it is created. */
  onScratch?: (scratchPath: string) => void;
}

/** The `.wt/<project>/` root runChecksAt names its scratch worktrees under. */
function scratchRoot(projectDir: string): string {
  const project = path.resolve(projectDir);
  return path.join(path.dirname(project), '.wt', path.basename(project));
}

/**
 * Whether `a` is an ancestor of `b`; only git's exit 1 is "no", any other fault throws.
 * A `b` the clone lacks has no ancestors here (`cat-file -e` exits 1 for a full name),
 * the rule the resume follows.
 */
function isAncestor(projectDir: string, a: string, b: string): boolean {
  try {
    git(projectDir, ['cat-file', '-e', b]);
  } catch (err) {
    if (err instanceof GitCommandError && err.status === 1) return false;
    throw err;
  }
  try {
    git(projectDir, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (err) {
    if (err instanceof GitCommandError && err.status === 1) return false;
    throw err;
  }
}

/** `failing` checks' output from the red record, in the shape the resume reads. */
function failedTail(
  events: readonly { event_id: string; record: { payload: unknown } }[],
  eventId: string,
  failing: readonly string[],
): string | null {
  const results = (
    events.find((e) => e.event_id === eventId)?.record.payload as { results?: unknown }
  )?.results;
  if (!Array.isArray(results)) return null;
  return results
    .filter((r) => r?.pass === false && failing.includes(String(r.name)))
    .map((r) => `${r.name}:\n${typeof r.tail === 'string' ? r.tail : ''}`)
    .join('\n');
}

/**
 * `git revert -m 1` of `mergeSha` on `head` in a detached scratch worktree,
 * amended to carry the four trailers. Returns the commit, or null on a conflict
 * (aborted). The worktree is always removed; the commit object stays.
 */
function buildRevert(
  projectDir: string,
  head: string,
  mergeSha: string,
  culprit: Culprit,
  onScratch: ((p: string) => void) | undefined,
): string | null {
  const dir = path.join(scratchRoot(projectDir), `scratch-${process.pid}-${randomUUID()}`);
  git(projectDir, ['worktree', 'add', '--detach', dir, head]);
  try {
    onScratch?.(dir);
    try {
      git(dir, ['revert', '-m', '1', '--no-edit', mergeSha]);
    } catch (error) {
      // A conflict leaves REVERT_HEAD behind; any other failure is not an answer.
      let inProgress = true;
      try {
        git(dir, ['rev-parse', '-q', '--verify', 'REVERT_HEAD']);
      } catch {
        inProgress = false;
      }
      if (!inProgress) throw error;
      git(dir, ['revert', '--abort']);
      return null;
    }
    const subject = git(projectDir, ['log', '-1', '--format=%s', mergeSha]);
    const message = [
      `Revert "${subject}"`,
      '',
      `Bs-Revert-Of: ${mergeSha}`,
      `Bs-Task: ${culprit.task}`,
      `Bs-Red-Record: ${culprit.red_record_event_id}`,
      `Bs-Failing-Checks: ${culprit.failing_checks.join(',')}`,
    ].join('\n');
    git(dir, ['commit', '--amend', '-q', '-m', message]);
    return git(dir, ['rev-parse', 'HEAD']);
  } finally {
    try {
      git(projectDir, ['worktree', 'remove', '--force', dir]);
    } catch {
      // The next run's dead-pid sweep removes whatever is left.
    }
  }
}

export async function runPostMerge(
  input: PostMergeInput,
  ctx: EventContext,
  runOpts: PostMergeRunOpts = {},
): Promise<PostMergeRunResult> {
  const { onScratch, ...opts } = runOpts;
  const { epicId, projectDir } = input;
  const liveTaskIds = input.tasks
    .filter((t) => t.task_status !== 'superseded')
    .map((t) => t.task_id);
  const integration = assertIntegrationBranch(projectDir, epicId);

  // (0) Finish any landed revert first: no state where a revert landed and the log keeps no record.
  let resume: Awaited<ReturnType<typeof resumeLandedReverts>>;
  try {
    resume = await resumeLandedReverts(
      { projectDir, epicId, integration, events: input.events, liveTaskIds },
      ctx,
      opts,
    );
  } catch (err) {
    const wrote = (err as { wrote?: { culprit?: ResumeCulprit }[] }).wrote ?? [];
    if (err instanceof Error) {
      Object.assign(err, {
        culprits: wrote.flatMap((w) => (w.culprit === undefined ? [] : [w.culprit])),
      });
    }
    throw err;
  }
  if (resume.resumed) {
    return {
      // `resumed` is true exactly when something was written, so never `nothing-to-resume`.
      outcome: resume.outcome as RevertOutcome,
      resumed: true,
      culprits: resume.wrote.flatMap((w) => (w.culprit === undefined ? [] : [w.culprit])),
      event_ids: [],
    };
  }

  // (1) The culprit.
  const found = await findPostMergeCulprit(input, ctx, opts);
  const event_ids = [...found.recordIds];
  const culprit: PostMergeCulprit | undefined =
    found.culprit === undefined ? undefined : { ...found.culprit, reproduced: true };
  const stop = (
    outcome: RevertOutcome,
    extra: Partial<PostMergeRunResult> = {},
  ): PostMergeRunResult => ({
    outcome,
    resumed: false,
    culprits: culprit === undefined ? [] : [culprit],
    event_ids,
    ...extra,
  });
  if (found.outcome === 'revert-has-dependents') {
    return stop('revert-has-dependents', { dependents: found.dependents ?? [] });
  }
  if (found.outcome !== 'culprit-found' || culprit === undefined) {
    return stop(found.outcome, {
      ...(found.outcome === 'setup-failed' && found.step !== undefined && found.commit !== undefined
        ? { setup_failed: { step: found.step, commit: found.commit } }
        : {}),
      ...(found.redAfterRevert === undefined
        ? {}
        : {
            red_after_revert: found.redAfterRevert,
            reason: `the head is red only after landed bs revert ${found.redAfterRevert.join(', ')}; no task merge is red`,
          }),
    });
  }
  const head = found.head as string;

  // (2) Preflight. R does not exist yet, so nothing can descend from it: no merge counts as a re-merge.
  const blocked = waveRevertBlocker(input.events, culprit.task, epicId, {
    revertSha: culprit.merge_sha,
    isAncestor: () => false,
    liveTaskIds,
  });
  if (blocked !== null) return stop('revert-not-applicable', { reason: blocked });
  // D4 tests R with the pre-merge tier before it lands (D10 refuses that tier empty
  // elsewhere): with no pre-merge check R cannot be tested, so nothing is built or landed.
  if (selectTier(input.checks, 'pre-merge').length === 0) {
    return stop('revert-not-applicable', { reason: 'no-pre-merge-checks' });
  }

  // (3) Build.
  const revert = buildRevert(projectDir, head, culprit.merge_sha, culprit, onScratch);
  if (revert === null) return stop('revert-conflict');

  // (4) Test R with the pre-merge tier, then the whole post-merge tier, through the one runner.
  const runner = input.runner ?? runIntegrationCheck;
  const test = async (tier: 'pre-merge' | 'post-merge'): Promise<IntegrationCheckRecord> => {
    const record = await runner(
      {
        epicId,
        projectDir,
        checks: [...input.checks],
        tier,
        workspace: 'scratch',
        commit: revert,
        ...(input.setupCmd === undefined ? {} : { setupCmd: input.setupCmd }),
      },
      ctx,
      opts,
    );
    event_ids.push(record.eventId);
    return record;
  };
  // Both tiers are non-empty here: the culprit came from a post-merge run, and step (2) refused an empty pre-merge tier.
  for (const tier of ['pre-merge', 'post-merge'] as const) {
    let record: IntegrationCheckRecord;
    try {
      record = await test(tier);
    } catch (error) {
      if (error instanceof IntegrationCheckError && error.code === 'integration.setup-failed') {
        return stop('setup-failed', {
          setup_failed: { step: 'revert', commit: revert },
          revert_sha: revert,
        });
      }
      throw error;
    }
    if (record.results.some(isNotRun)) return stop('lock-timeout', { revert_sha: revert });
    if (!record.pass) return stop('revert-red', { revert_sha: revert });
  }

  // (5) Land it. Nothing is written for any outcome but `landed`.
  const message = `bs post-merge: revert ${culprit.task}`;
  const landing = landCandidate(projectDir, integration.branch, head, revert, message);
  if (landing.outcome === 'integration-dirty') {
    return stop('integration-dirty', {
      revert_sha: revert,
      reason: `${landing.worktree} holds ${integration.branch} with uncommitted changes: ${landing.dirty.join(', ')}`,
    });
  }
  if (landing.outcome === 'integration-moved')
    return stop('integration-moved', { revert_sha: revert });

  // (6) Record it. A refusal or crash here is finished by the next call's resume.
  const events = await readLineageEvents(ctx.sessionId, opts);
  const tail = failedTail(events, culprit.red_record_event_id, culprit.failing_checks);
  try {
    const stored = await recordWaveReverted(
      {
        epic_id: epicId,
        integration_branch: integration.branch,
        revert_sha: revert,
        disposition: 'bounce',
        task_ids: [culprit.task],
        reverted_merge_sha: culprit.merge_sha,
        failing_checks: culprit.failing_checks,
        evidence_event_ids: [...new Set([culprit.red_record_event_id, ...event_ids])],
        log_tail: tail ?? '',
        red_record_event_id: culprit.red_record_event_id,
        evidence: tail === null ? 'trailers-only' : 'record',
        resumed: false,
      },
      ctx,
      { ...opts, isAncestor: (a, b) => isAncestor(projectDir, a, b), liveTaskIds },
    );
    event_ids.push(stored.event_id);
  } catch (error) {
    // Another batch recorded R first: it is recorded.
    if (!(error instanceof WaveRevertedError && error.code === 'revert.already-recorded'))
      throw error;
  }
  return stop('reverted', { revert_sha: revert });
}
