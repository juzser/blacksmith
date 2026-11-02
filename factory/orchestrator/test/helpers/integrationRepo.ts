// A temp repo shaped like an epic's integration branch, for the post-merge
// batch tests (task-7) and the tasks built on it.
//
// The clone stays on `main` the whole time. Every commit on the integration
// branch is made in a private builder worktree, so a library that must never
// touch the clone's branch, index or tree can be compared byte for byte
// before and after a call.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent, type EventOpts, readLineageEvents } from '../../src/events.js';
import { git as runGit } from './process.js';

/**
 * The four trailers of a bs revert commit. `undefined` takes the value the
 * builder derives for the merge it reverts, any string replaces it, and `null`
 * leaves the trailer out, so a caller can write a non-40-hex `Bs-Revert-Of`,
 * an unknown `Bs-Task`, an unparseable `Bs-Red-Record` or an empty
 * `Bs-Failing-Checks`.
 */
export interface RevertTrailers {
  revertOf?: string | null;
  task?: string | null;
  redRecord?: string | null;
  failingChecks?: string | null;
}

/** File contents by repo-relative path; `null` deletes the file. */
export type FileChanges = Record<string, string | null>;

export interface IntegrationRepo {
  root: string;
  projectDir: string;
  stateDir: string;
  epicId: string;
  sessionId: string;
  branch: string;
  /** The private worktree every integration commit is made in; it holds the branch until `release`. */
  builderDir: string;
  /** `<root>/.wt/project`, where scratch worktrees are made. */
  scratchRoot: string;
  git(args: string[], cwd?: string): string;
  ctx(): { sessionId: string; planVersion: number; causalParent: string; actor: string };
  opts(): EventOpts;
  events(): ReturnType<typeof readLineageEvents>;
  /** Merge `taskId`'s change into the integration branch with a `Merge <task> into <branch>` commit. */
  merge(taskId: string, files: FileChanges): string;
  /** A commit straight on the integration branch, with no merge commit. */
  handCommit(files: FileChanges, message: string): string;
  /** Revert the merge `mergeSha` with a bs revert commit carrying the four trailers. */
  revert(mergeSha: string, trailers?: RevertTrailers): string;
  /** Detach the builder so no worktree holds the integration branch; merge/revert are over after this. */
  release(): void;
  head(): string;
  forkPoint(): string;
  worktreeCount(): number;
  dispose(): Promise<void>;
}

export const MERGE_SUBJECT = (task: string, branch: string): string =>
  `Merge ${task} into ${branch}`;

export async function createIntegrationRepo(
  opts: { epicId?: string; sessionId?: string } = {},
): Promise<IntegrationRepo> {
  const epicId = opts.epicId ?? 'epic-1';
  const sessionId = opts.sessionId ?? 'sess-postmerge';
  const branch = `bs/${epicId}/integration`;
  const root = mkdtempSync(path.join(tmpdir(), 'smith-postmerge-'));
  const projectDir = path.join(root, 'project');
  const builderDir = path.join(root, 'builder');
  const stateDir = path.join(root, 'events');

  const git = (args: string[], cwd: string = projectDir): string => runGit(cwd, args).trim();
  const inBuilder = (args: string[]): string => git(args, builderDir);

  git(['init', '-q', '-b', 'main', projectDir], root);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(projectDir, 'README.md'), '# project\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  git(['branch', branch]);
  git(['worktree', 'add', '-q', builderDir, branch]);
  const eventOpts: EventOpts = { stateDir };
  await appendEvent(
    {
      session_id: sessionId,
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: {},
    },
    eventOpts,
  );
  const forkPoint = git(['rev-parse', 'main']);

  const applyChanges = (files: FileChanges): void => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(builderDir, file);
      if (content === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    inBuilder(['add', '--all']);
  };

  const repo: IntegrationRepo = {
    root,
    projectDir,
    stateDir,
    epicId,
    sessionId,
    branch,
    builderDir,
    scratchRoot: path.join(root, '.wt', 'project'),
    git,
    ctx: () => ({ sessionId, planVersion: 1, causalParent: `${sessionId}#0`, actor: 'system' }),
    opts: () => eventOpts,
    events: () => readLineageEvents(sessionId, eventOpts),
    merge(taskId, files) {
      const tmp = `tmp-${taskId}`;
      inBuilder(['checkout', '-q', '-b', tmp]);
      applyChanges(files);
      inBuilder(['commit', '-q', '-m', `${taskId}: change`]);
      inBuilder(['checkout', '-q', branch]);
      inBuilder(['merge', '--no-ff', '-q', tmp, '-m', MERGE_SUBJECT(taskId, branch)]);
      inBuilder(['branch', '-q', '-D', tmp]);
      return inBuilder(['rev-parse', 'HEAD']);
    },
    handCommit(files, message) {
      applyChanges(files);
      inBuilder(['commit', '-q', '-m', message]);
      return inBuilder(['rev-parse', 'HEAD']);
    },
    revert(mergeSha, trailers = {}) {
      const subject = inBuilder(['log', '-1', '--format=%s', mergeSha]);
      const derivedTask = / ?Merge (\S+) into /.exec(subject)?.[1] ?? 'unknown';
      const pick = (given: string | null | undefined, derived: string): string | null =>
        given === undefined ? derived : given;
      const lines = [
        ['Bs-Revert-Of', pick(trailers.revertOf, mergeSha)],
        ['Bs-Task', pick(trailers.task, derivedTask)],
        ['Bs-Red-Record', pick(trailers.redRecord, `${sessionId}#0`)],
        ['Bs-Failing-Checks', pick(trailers.failingChecks, 'post-check')],
      ].flatMap(([key, value]) => (value === null ? [] : [`${key}: ${value}`]));
      inBuilder(['revert', '-m', '1', '--no-commit', mergeSha]);
      const body = [`Revert "${subject}"`, ''];
      if (lines.length > 0) body.push(...lines);
      inBuilder(['commit', '-q', '-m', body.join('\n').trimEnd()]);
      return inBuilder(['rev-parse', 'HEAD']);
    },
    release: () => void inBuilder(['checkout', '-q', '--detach']),
    head: () => git(['rev-parse', branch]),
    forkPoint: () => forkPoint,
    worktreeCount: () =>
      git(['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((l) => l.startsWith('worktree ')).length,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
  return repo;
}
