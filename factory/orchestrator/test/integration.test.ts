import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import {
  IntegrationCheckError,
  integrationHeadSha,
  latestIntegrationCheck,
  runIntegrationCheck,
} from '../src/integration.js';
import { git as runGitFixture } from './helpers/process.js';

// ---------------------------------------------------------------------------
// D-42/P9-26, second half. Moving the worktrees out of the project root fixes
// the one tool that went red; it does not fix the reason nobody noticed. Every
// check this factory runs — schema, tests, lint, review — runs inside a task
// worktree, so every quality claim it makes is a claim about a worktree. The
// assembled integration branch had never had a single command run against it
// when the epic was declared shippable; the run that caught D-42 took eleven
// seconds and happened because a human typed it.
// ---------------------------------------------------------------------------

/** Trimmed — several assertions here compare a sha or a branch name directly. */
function git(cwd: string, args: string[]): string {
  return runGitFixture(cwd, args).trim();
}

describe('integration.ts', () => {
  let root: string;
  let projectDir: string;
  let stateDir: string;
  const sessionId = 'sess-integration';
  const epicId = 'epic-1';
  const branch = 'smith/epic-1/integration';

  const ctx = () => ({
    sessionId,
    planVersion: 1,
    causalParent: `${sessionId}#0`,
    actor: 'system',
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-integration-'));
    projectDir = path.join(root, 'project');
    stateDir = path.join(root, 'events');

    git(root, ['init', '-q', '-b', 'main', projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(projectDir, 'README.md'), '# project\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['checkout', '-q', '-b', branch]);

    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs the checks at the project root and records the result as an event', async () => {
    const outcome = await runIntegrationCheck(
      { epicId, projectDir, checks: [{ name: 'lint', cmd: 'test -f README.md' }] },
      ctx(),
      { stateDir },
    );

    expect(outcome.pass).toBe(true);
    expect(outcome.branch).toBe(branch);
    expect(outcome.headSha).toBe(git(projectDir, ['rev-parse', 'HEAD']));

    const events = await readEvents(sessionId, { stateDir });
    const recorded = events.filter((e) => e.record.event_type === 'integration-check');
    expect(recorded).toHaveLength(1);
    const payload = recorded[0]?.record.payload as Record<string, unknown>;
    expect(payload.epic_id).toBe(epicId);
    expect(payload.pass).toBe(true);
    expect(payload.head_sha).toBe(outcome.headSha);
    // <epic>/integration is the established task-id for epic-level events
    // (epic.ts's quorum-decision uses it, foldTasks() skips it).
    expect(recorded[0]?.record.task_id).toBe(`${epicId}/integration`);
  });

  it('records a failing check as a failure rather than throwing', async () => {
    const outcome = await runIntegrationCheck(
      {
        epicId,
        projectDir,
        checks: [
          { name: 'lint', cmd: 'exit 3' },
          { name: 'test', cmd: 'true' },
        ],
      },
      ctx(),
      { stateDir },
    );

    expect(outcome.pass).toBe(false);
    // runAll defaults true at the integration root: the operator wants the
    // whole picture of the assembled branch, not just the first thing to break.
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]?.exitCode).toBe(3);

    const events = await readEvents(sessionId, { stateDir });
    const recorded = events.filter((e) => e.record.event_type === 'integration-check');
    expect(recorded).toHaveLength(1);
    expect((recorded[0]?.record.payload as Record<string, unknown> | undefined)?.pass).toBe(false);
  });

  // testgate.run([]) returns pass: true for an empty list — correct there, and
  // a silent forgery here. "No checks configured" must never read back as
  // "the assembled branch passed its checks".
  it('refuses an empty check list instead of recording a vacuous pass', async () => {
    await expect(
      runIntegrationCheck({ epicId, projectDir, checks: [] }, ctx(), { stateDir }),
    ).rejects.toThrow(IntegrationCheckError);

    const events = await readEvents(sessionId, { stateDir });
    expect(events.filter((e) => e.record.event_type === 'integration-check')).toHaveLength(0);
  });

  // The checks run against the working tree, so the working tree has to BE the
  // integration branch. Checking it out here would be a destructive git op on
  // the operator's own clone; refusing is the honest half.
  it('refuses to certify when the project is not on the integration branch', async () => {
    git(projectDir, ['checkout', '-q', 'main']);

    await expect(
      runIntegrationCheck({ epicId, projectDir, checks: [{ name: 'lint', cmd: 'true' }] }, ctx(), {
        stateDir,
      }),
    ).rejects.toThrow(/integration branch/i);
  });

  it('refuses to certify a dirty working tree', async () => {
    await writeFile(path.join(projectDir, 'uncommitted.txt'), 'not in any commit\n');

    await expect(
      runIntegrationCheck({ epicId, projectDir, checks: [{ name: 'lint', cmd: 'true' }] }, ctx(), {
        stateDir,
      }),
    ).rejects.toThrow(/dirty|uncommitted/i);
  });

  // D-178: the dirty read only tests the output for truthiness, so a git config
  // that hides untracked files hid the whole check — and untracked-only is the
  // ordinary shape of a tree someone forgot to commit.
  it('refuses a dirty tree through a status.showUntrackedFiles=no config (D-178)', async () => {
    git(projectDir, ['config', 'status.showUntrackedFiles', 'no']);
    await writeFile(path.join(projectDir, 'uncommitted.txt'), 'not in any commit\n');

    await expect(
      runIntegrationCheck({ epicId, projectDir, checks: [{ name: 'lint', cmd: 'true' }] }, ctx(), {
        stateDir,
      }),
    ).rejects.toThrow(/dirty|uncommitted/i);
  });

  it('refuses when the epic has no integration branch at all', async () => {
    await expect(
      runIntegrationCheck(
        { epicId: 'epic-never-planned', projectDir, checks: [{ name: 'lint', cmd: 'true' }] },
        ctx(),
        { stateDir },
      ),
    ).rejects.toThrow(IntegrationCheckError);
  });

  it('integrationHeadSha returns the branch head, or null when the branch is absent', () => {
    expect(integrationHeadSha(projectDir, epicId)).toBe(git(projectDir, ['rev-parse', 'HEAD']));
    expect(integrationHeadSha(projectDir, 'epic-never-planned')).toBe(null);
  });

  it('latestIntegrationCheck folds the last check for the epic, ignoring other epics', async () => {
    const events0 = await readEvents(sessionId, { stateDir });
    expect(latestIntegrationCheck(events0, epicId)).toBe(null);

    await runIntegrationCheck(
      { epicId, projectDir, checks: [{ name: 'lint', cmd: 'exit 1' }] },
      ctx(),
      { stateDir },
    );
    await writeFile(path.join(projectDir, 'fix.txt'), 'fixed\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'fix']);
    const second = await runIntegrationCheck(
      { epicId, projectDir, checks: [{ name: 'lint', cmd: 'true' }] },
      ctx(),
      { stateDir },
    );

    const events = await readEvents(sessionId, { stateDir });
    const latest = latestIntegrationCheck(events, epicId);
    expect(latest?.pass).toBe(true);
    expect(latest?.headSha).toBe(second.headSha);
    expect(latestIntegrationCheck(events, 'other-epic')).toBe(null);
  });
});
