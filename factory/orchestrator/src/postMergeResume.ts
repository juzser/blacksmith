import type { EventOpts, StoredEvent } from './events.js';
import { parseEventId } from './events.js';
import type { EventContext } from './findings.js';
import { GitCommandError, runGit as git, writeMergeTree } from './git.js';
import { INTEGRATION_CHECK_EVENT, latestIntegrationCheckAt } from './integration.js';
import { assertIntegrationBranch, landedBsReverts, PostMergeError } from './postMergeBisect.js';
import {
  type RecordOnlyReason,
  recordWaveReverted,
  WAVE_REVERTED_EVENT,
  type WaveRevertedInput,
  waveRevertBlocker,
} from './revert.js';
import { epicOfTaskId, qualifyTaskId } from './taskId.js';
import { namesTask } from './taskLifecycle.js';

/**
 * Spec D4's resume: every bs revert commit that landed on the integration
 * branch ends with exactly one `wave-reverted`, a bounce when the task can
 * still be reopened and a record-only event otherwise. It reads git and the
 * log and never moves a ref; the only write is task-2's `recordWaveReverted`.
 */
export interface ResumeInput {
  projectDir: string;
  epicId: string;
  /** What task-7's `assertIntegrationBranch` returned. */
  integration: { branch: string };
  /** The epic's event lineage, in log order. */
  events: readonly StoredEvent[];
  /** The live plan's records whose `task_status` is not `superseded`. */
  liveTaskIds: readonly string[];
}

/** Rebuilt from a bs revert commit's trailers, in task-12's culprit shape. */
export interface ResumeCulprit {
  task: string;
  merge_sha: string;
  failing_checks: string[];
  red_record_event_id: string;
  reproduced: true;
}

export interface ResumeWrite {
  /** The task the trailers name, qualified; null when no usable id is named. */
  task: string | null;
  revert_sha: string;
  disposition: 'bounce' | 'record-only';
  reason?: RecordOnlyReason;
  culprit?: ResumeCulprit;
}

export interface ResumeResult {
  outcome: 'reverted' | 'revert-recorded' | 'nothing-to-resume';
  resumed: boolean;
  wrote: ResumeWrite[];
}

const HEX40 = /^[0-9a-f]{40}$/i;
const TIERS = ['pre-merge', 'post-merge'] as const;
/** The events that make a task known to the lineage. */
const KNOWN_BY = new Set(['task-added', 'wave-admitted', 'wave-merged']);

interface Trailers {
  revertOf: string | null;
  task: string | null;
  redRecord: string | null;
  failingChecks: string[];
  valid: boolean;
}

/**
 * The `Key: value` lines of the final paragraph. Mirrors the final-paragraph
 * split of `isBsRevertCommit` in postMergeBisect.ts, which exports no shared
 * helper; a test pins the two to agree.
 */
export function trailerValues(message: string): Map<string, string> {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const block = paragraphs.length > 1 ? (paragraphs.at(-1) ?? '') : '';
  const values = new Map<string, string>();
  for (const line of block.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0 && !values.has(line.slice(0, at))) {
      values.set(line.slice(0, at), line.slice(at + 1).trim());
    }
  }
  return values;
}

function parseTrailers(message: string, epicId: string): Trailers {
  const raw = trailerValues(message);
  const revertOf = raw.get('Bs-Revert-Of') ?? '';
  const taskRaw = raw.get('Bs-Task') ?? '';
  const redRecord = raw.get('Bs-Red-Record') ?? '';
  const failingChecks = (raw.get('Bs-Failing-Checks') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const taskEpic = epicOfTaskId(taskRaw);
  const taskOk =
    taskRaw !== '' && !/\s/.test(taskRaw) && (taskEpic === null || taskEpic === epicId);
  let redOk = true;
  try {
    parseEventId(redRecord);
  } catch {
    redOk = false;
  }
  return {
    revertOf: HEX40.test(revertOf) ? revertOf.toLowerCase() : null,
    task: taskOk ? qualifyTaskId(epicId, taskRaw) : null,
    redRecord: redOk ? redRecord : null,
    failingChecks,
    valid: HEX40.test(revertOf) && taskOk && redOk && failingChecks.length > 0,
  };
}

const payloadOf = (event: StoredEvent): Record<string, unknown> =>
  event.record.payload as Record<string, unknown>;

/**
 * Whether the commit `sha` really is the tested revert its trailers claim:
 * `revertOf` is a merge on the first-parent history, the commit's tree is what
 * `git revert -m 1 <revertOf>` makes of its parent, and passing non-probe
 * pre-merge and post-merge records exist at `sha`. Trailers alone prove none
 * of that, and a hand-made commit can carry all four.
 */
function provesRevert(
  projectDir: string,
  epicId: string,
  sha: string,
  revertOf: string,
  events: readonly StoredEvent[],
): boolean {
  // A root commit has no parent to revert over: the claim is false.
  if (git(projectDir, ['rev-list', '--parents', '-n', '1', sha]).split(' ').length < 2)
    return false;
  const merges = git(projectDir, ['rev-list', '--first-parent', '--min-parents=2', sha]);
  if (!merges.split('\n').includes(revertOf)) return false;
  // `git revert -m 1 M` on P is the three-way merge of P with M^1 over base
  // M. A commit with M^1's tree and M as its only parent gives merge-tree
  // that base without a worktree; the object is never referenced.
  const theirs = git(projectDir, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=bs',
    '-c',
    'user.email=bs@localhost',
    'commit-tree',
    `${revertOf}^1^{tree}`,
    '-p',
    revertOf,
    '-m',
    'revert preview',
  ]);
  let wanted: string;
  try {
    wanted = writeMergeTree(projectDir, `${sha}^`, theirs);
  } catch (err) {
    // Exit 1 is a conflict: the revert does not apply, so the claim is false.
    // Any other failure says nothing about the commit and must not be recorded.
    if (err instanceof GitCommandError && err.status === 1) return false;
    throw err;
  }
  if (wanted !== git(projectDir, ['rev-parse', `${sha}^{tree}`])) return false;
  return TIERS.every((tier) => {
    const covering = events.filter((e) => {
      const tiers = payloadOf(e).tiers;
      return Array.isArray(tiers) && tiers.includes(tier);
    });
    const record = latestIntegrationCheckAt(covering, epicId, sha);
    return (
      record?.pass === true &&
      record.results.length > 0 &&
      record.results.every((r) => r.pass === true)
    );
  });
}

function knownTask(events: readonly StoredEvent[], task: string, epicId: string): boolean {
  return events.some((e) => {
    if (!KNOWN_BY.has(e.record.event_type) || !namesTask(e.record, task)) return false;
    const epic = payloadOf(e).epic_id;
    return typeof epic === 'string' ? epic === epicId : true;
  });
}

/** The red record's failed-check output, or null when it cannot be read. */
function readRedRecord(
  events: readonly StoredEvent[],
  eventId: string | null,
  failing: readonly string[],
): string | null {
  const record = events.find((e) => e.event_id === eventId);
  if (record === undefined || record.record.event_type !== INTEGRATION_CHECK_EVENT) return null;
  const results = payloadOf(record).results;
  if (!Array.isArray(results)) return null;
  return results
    .filter(
      (r): r is { name: string; tail?: unknown } =>
        typeof r === 'object' &&
        r !== null &&
        (r as { pass?: unknown }).pass === false &&
        failing.includes(String((r as { name?: unknown }).name)),
    )
    .map((r) => `${r.name}:\n${typeof r.tail === 'string' ? r.tail : ''}`)
    .join('\n');
}

export async function resumeLandedReverts(
  input: ResumeInput,
  ctx: EventContext,
  opts: EventOpts = {},
): Promise<ResumeResult> {
  const { projectDir, epicId, liveTaskIds } = input;
  // The scan below reads this branch, so it is the one every event names.
  const { branch } = assertIntegrationBranch(projectDir, epicId);
  if (branch !== input.integration.branch) {
    throw new PostMergeError(
      'postmerge.not-integration-branch',
      `"${input.integration.branch}" is not the integration branch "${branch}" of epic "${epicId}" that the scan reads.`,
      { epicId, given: input.integration.branch, scanned: branch },
    );
  }
  const events = [...input.events];
  const isAncestor = (a: string, b: string): boolean => {
    try {
      git(projectDir, ['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  };
  const recorded = (sha: string): boolean =>
    events.some(
      (e) =>
        e.record.event_type === WAVE_REVERTED_EVENT &&
        String(payloadOf(e).revert_sha).toLowerCase() === sha,
    );

  const wrote: ResumeWrite[] = [];
  for (const commit of landedBsReverts(projectDir, epicId)) {
    const sha = commit.sha.toLowerCase();
    if (recorded(sha)) continue;
    const t = parseTrailers(commit.message, epicId);
    const proven =
      t.valid && t.revertOf !== null && provesRevert(projectDir, epicId, sha, t.revertOf, events);
    const known = proven && t.task !== null && knownTask(events, t.task, epicId);
    const reason: RecordOnlyReason | null = !proven
      ? 'invalid-trailers'
      : !known
        ? 'unknown-task'
        : waveRevertBlocker(events, t.task as string, epicId, {
            revertSha: sha,
            isAncestor,
            liveTaskIds,
          });

    const common = {
      epic_id: epicId,
      integration_branch: branch,
      revert_sha: sha,
      task_ids: t.task === null ? [] : [t.task],
      reverted_merge_sha: t.revertOf,
    };
    const tail = proven ? readRedRecord(events, t.redRecord, t.failingChecks) : null;
    let input_: WaveRevertedInput;
    if (reason === null) {
      input_ = {
        ...common,
        disposition: 'bounce',
        failing_checks: t.failingChecks,
        evidence_event_ids: [t.redRecord as string],
        log_tail: tail ?? '',
        red_record_event_id: t.redRecord as string,
        evidence: tail === null ? 'trailers-only' : 'record',
        resumed: true,
      };
    } else {
      input_ = {
        ...common,
        disposition: 'record-only',
        reason,
        failing_checks: tail === null ? [] : t.failingChecks,
        evidence_event_ids: tail === null ? [] : [t.redRecord as string],
        log_tail: tail ?? '',
        evidence: tail === null ? 'unreadable' : 'record',
      };
    }
    events.push(await recordWaveReverted(input_, ctx, { ...opts, isAncestor, liveTaskIds }));

    const write: ResumeWrite = {
      task: t.task,
      revert_sha: sha,
      disposition: input_.disposition,
    };
    if (reason !== null) write.reason = reason;
    if (reason === null || !['invalid-trailers', 'unknown-task', 'not-merged'].includes(reason)) {
      write.culprit = {
        task: t.task as string,
        merge_sha: t.revertOf as string,
        failing_checks: t.failingChecks,
        red_record_event_id: t.redRecord as string,
        reproduced: true,
      };
    }
    wrote.push(write);
  }

  const outcome =
    wrote.length === 0
      ? 'nothing-to-resume'
      : wrote.every((w) => w.disposition === 'bounce')
        ? 'reverted'
        : 'revert-recorded';
  return { outcome, resumed: wrote.length > 0, wrote };
}
