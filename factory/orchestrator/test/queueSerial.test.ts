import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents } from '../src/events.js';
import { batchStep, type QueueTask, type StepOutcome, step } from '../src/queue.js';
import type { TaskEventContext } from '../src/taskEvents.js';
import { createTaskWorktree } from '../src/worktree.js';
import { git as runGitFixture } from './helpers/process.js';

// Finding f-bs-optimize/integration-a2f0a33f: queue steps of one epic must take
// turns from rebase through merge, and a task lands only on the integration
// head its suite ran on. Ordering is forced through the injected lock knobs and
// a test-owned lock record, never through sleeps.

const EPIC = 'epic-1';
const INTEGRATION = `bs/${EPIC}/integration`;

function git(cwd: string, args: string[]): string {
  return runGitFixture(cwd, args).trim();
}

describe('queue landing is serialised and compare-and-swap', () => {
  let root: string;
  let projectDir: string;
  let lockDir: string;
  let stateDir: string;
  let outDir: string;
  const sessionId = 'sess-serial';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-queue-serial-'));
    projectDir = path.join(root, 'project');
    lockDir = path.join(root, 'locks');
    stateDir = path.join(root, 'state');
    outDir = path.join(root, 'out');
    await mkdir(outDir);
    const originDir = path.join(root, 'origin.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', originDir]);
    git(root, ['clone', '-q', originDir, projectDir]);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    const files: Record<string, string> = {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'c.txt': 'c\n',
      'api.txt': 'api-v1\n',
      'use.txt': 'plain\n',
    };
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(projectDir, name), text);
    }
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-q', '-m', 'init']);
    git(projectDir, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeTask(taskId: string, file: string, text: string): QueueTask {
    const wt = createTaskWorktree(projectDir, EPIC, taskId);
    writeFileSync(path.join(wt.worktreeDir, file), text);
    git(wt.worktreeDir, ['commit', '-q', '-am', `edit ${file}`]);
    return { taskId: `${EPIC}/${taskId}`, branch: wt.branch, worktreeDir: wt.worktreeDir };
  }

  function script(name: string, lines: string[]): string {
    const file = path.join(root, name);
    writeFileSync(file, `${lines.join('\n')}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  /** A lock record owned by the test; the pid is fake, `isPidAlive` says it lives. */
  function holdLock(dir: string): { release: () => void } {
    execFileSync('mkdir', ['-p', dir]);
    const lockFile = path.join(dir, 'heavy.lock');
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 2_000_000_000,
        token: 'test-owned-token',
        label: 'test-owner',
        startedAt: new Date().toISOString(),
        cwd: root,
      }),
    );
    return { release: () => unlinkSync(lockFile) };
  }

  /** An `isPidAlive` for one waiter: always alive, and tells the test it probed. */
  function probe(): { isPidAlive: () => boolean; probed: Promise<void> } {
    let mark: () => void = () => undefined;
    const probed = new Promise<void>((resolve) => {
      mark = resolve;
    });
    return {
      isPidAlive: () => {
        mark();
        return true;
      },
      probed,
    };
  }

  const lockKnobs = (isPidAlive: () => boolean = () => true) => ({
    lockDir,
    pollMs: 2,
    isPidAlive,
  });

  async function makeEvents(): Promise<{ ctx: TaskEventContext; stateDir: string }> {
    const rootEvent = await appendEvent(
      {
        session_id: sessionId,
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    return {
      ctx: { sessionId, planVersion: 1, causalParent: rootEvent.event_id, actor: 'system' },
      stateDir,
    };
  }

  async function logged() {
    const all = await readEvents(sessionId, { stateDir });
    return all
      .filter((e) => e.record.event_type !== 'session-start')
      .map((e) => ({
        type: e.record.event_type,
        taskId: e.record.task_id,
        payload: e.record.payload as Record<string, unknown>,
      }));
  }

  describe('two queue runs of one epic', () => {
    it('never interleave a rebase and its merge: each suite runs on the head it lands on', async () => {
      const b = makeTask('task-b', 'api.txt', 'api-v2\n');
      const c = makeTask('task-c', 'use.txt', 'relies-on-api-v1\n');
      const base = git(projectDir, ['rev-parse', INTEGRATION]);
      const treeLog = path.join(outDir, 'trees.log');
      // Red on a tree holding both changes; every tree it runs on is recorded.
      const suite = script('suite.sh', [
        `git rev-parse 'HEAD^{tree}' >> '${treeLog}'`,
        'if grep -q api-v2 api.txt && grep -q relies-on-api-v1 use.txt; then exit 1; fi',
      ]);

      const held = holdLock(lockDir);
      const pb = probe();
      const pc = probe();
      const runB = step(b, {
        projectDir,
        epic: EPIC,
        testCmd: `sh '${suite}'`,
        heavyLock: lockKnobs(pb.isPidAlive),
      });
      const runC = step(c, {
        projectDir,
        epic: EPIC,
        testCmd: `sh '${suite}'`,
        heavyLock: lockKnobs(pc.isPidAlive),
      });
      // Both steps have reached the held lock; only now does the owner let go.
      await Promise.all([pb.probed, pc.probed]);
      held.release();
      const outcomes = (await Promise.all([runB, runC])).map((o) => o.outcome).sort();

      expect(outcomes).toEqual(['merged', 'tests-failed']);
      const tested = new Set(readFileSync(treeLog, 'utf8').split('\n').filter(Boolean));
      const landings = git(projectDir, [
        'rev-list',
        '--first-parent',
        INTEGRATION,
        `^${base}`,
      ]).split('\n');
      expect(landings).toHaveLength(1);
      for (const commit of landings) {
        expect(tested.has(git(projectDir, ['rev-parse', `${commit}^{tree}`]))).toBe(true);
      }
    });
  });

  for (const mode of ['no-worktree', 'holder-worktree'] as const) {
    describe(`a head moved by an outside writer (${mode})`, () => {
      let holderDir: string;
      let marker: string;

      beforeEach(() => {
        holderDir = path.join(root, 'holder');
        marker = path.join(outDir, 'moved.marker');
      });

      /** The suite command: moves the integration branch once, behind the queue's back. */
      function mover(file: string, text: string): string {
        const lines = [`[ -e '${marker}' ] && exit 0`, `touch '${marker}'`];
        if (mode === 'holder-worktree') {
          lines.push(
            `cd '${holderDir}'`,
            `printf '${text}\\n' > '${file}'`,
            `git add '${file}'`,
            "git commit -q -m 'outside writer'",
          );
        } else {
          lines.push(
            `cd '${projectDir}'`,
            `export GIT_INDEX_FILE='${path.join(outDir, 'side.index')}'`,
            `git read-tree refs/heads/${INTEGRATION}`,
            `blob=$(printf '${text}\\n' | git hash-object -w --stdin)`,
            `git update-index --add --cacheinfo 100644,$blob,'${file}'`,
            `c=$(git commit-tree $(git write-tree) -p refs/heads/${INTEGRATION} -m 'outside writer')`,
            `git update-ref refs/heads/${INTEGRATION} $c`,
          );
        }
        return `sh '${script('mover.sh', lines)}'`;
      }

      function openHolder(): void {
        if (mode === 'holder-worktree') {
          git(projectDir, ['worktree', 'add', '-q', holderDir, INTEGRATION]);
        }
      }

      it('returns integration-moved, lands nothing and logs both heads', async () => {
        const task = makeTask('task-1', 'a.txt', 'a-edited\n');
        const events = await makeEvents();
        const before = git(projectDir, ['rev-parse', INTEGRATION]);
        openHolder();

        const out = await step(task, {
          projectDir,
          epic: EPIC,
          testCmd: mover('outside.txt', 'outside'),
          events,
          heavyLock: lockKnobs(),
        });

        expect(out).toEqual({ outcome: 'integration-moved', taskId: task.taskId });
        const after = git(projectDir, ['rev-parse', INTEGRATION]);
        expect(git(projectDir, ['log', '-1', '--format=%s', after])).toBe('outside writer');
        expect(git(projectDir, ['rev-parse', `${after}^`])).toBe(before);
        const log = await logged();
        const blocked = log.filter(
          (e) => e.type === 'error-logged' && e.payload.error === 'execution.env-failure',
        );
        expect(blocked).toHaveLength(1);
        expect(String(blocked[0]?.payload.detail)).toContain(before);
        expect(String(blocked[0]?.payload.detail)).toContain(after);
        expect(log.some((e) => e.type === 'wave-merged')).toBe(false);
      });

      it('rebases onto the moved head, re-runs the suite and merges on the next step', async () => {
        const task = makeTask('task-1', 'a.txt', 'a-edited\n');
        const cmd = mover('outside.txt', 'outside');
        openHolder();
        const first = await step(task, {
          projectDir,
          epic: EPIC,
          testCmd: cmd,
          heavyLock: lockKnobs(),
        });
        expect(first.outcome).toBe('integration-moved');

        const second = await step(task, {
          projectDir,
          epic: EPIC,
          testCmd: cmd,
          heavyLock: lockKnobs(),
        });

        expect(second.outcome).toBe('merged');
        expect(git(projectDir, ['show', `${INTEGRATION}:outside.txt`])).toBe('outside');
        expect(git(projectDir, ['show', `${INTEGRATION}:a.txt`])).toBe('a-edited');
      });

      it('wins over a conflict: integration-moved, no throw; the next step reports rebase-conflict', async () => {
        const task = makeTask('task-1', 'a.txt', 'from-task\n');
        const cmd = mover('a.txt', 'from-outside');
        openHolder();
        const first: StepOutcome = await step(task, {
          projectDir,
          epic: EPIC,
          testCmd: cmd,
          heavyLock: lockKnobs(),
        });
        expect(first.outcome).toBe('integration-moved');
        const moved = git(projectDir, ['rev-parse', INTEGRATION]);

        const second = await step(task, {
          projectDir,
          epic: EPIC,
          testCmd: cmd,
          heavyLock: lockKnobs(),
        });

        expect(second).toMatchObject({ outcome: 'rebase-conflict', conflictingFiles: ['a.txt'] });
        expect(git(projectDir, ['rev-parse', INTEGRATION])).toBe(moved);
      });
    });
  }

  describe('the hold is released on every exit of a step', () => {
    const lockFile = (): string => path.join(lockDir, 'heavy.lock');

    it('after merged, tests-failed and integration-moved', async () => {
      const ok = makeTask('task-ok', 'a.txt', 'a-edited\n');
      const red = makeTask('task-red', 'b.txt', 'b-edited\n');
      const moving = makeTask('task-moving', 'c.txt', 'c-edited\n');
      const knobs = { lockDir, pollMs: 2, isPidAlive: () => true };

      expect(
        (await step(ok, { projectDir, epic: EPIC, testCmd: 'true', heavyLock: knobs })).outcome,
      ).toBe('merged');
      expect(existsSync(lockFile())).toBe(false);

      expect(
        (await step(red, { projectDir, epic: EPIC, testCmd: 'false', heavyLock: knobs })).outcome,
      ).toBe('tests-failed');
      expect(existsSync(lockFile())).toBe(false);

      const side = script('side.sh', [
        `cd '${projectDir}'`,
        `export GIT_INDEX_FILE='${path.join(outDir, 'side.index')}'`,
        `git read-tree refs/heads/${INTEGRATION}`,
        `c=$(git commit-tree $(git write-tree) -p refs/heads/${INTEGRATION} -m outside)`,
        `git update-ref refs/heads/${INTEGRATION} $c`,
      ]);
      const out = await step(moving, {
        projectDir,
        epic: EPIC,
        testCmd: `sh '${side}'`,
        heavyLock: knobs,
      });
      expect(out.outcome).toBe('integration-moved');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('after a rebase-conflict that throws nothing', async () => {
      const task = makeTask('task-1', 'a.txt', 'from-task\n');
      const holderDir = path.join(root, 'holder');
      git(projectDir, ['worktree', 'add', '-q', holderDir, INTEGRATION]);
      writeFileSync(path.join(holderDir, 'a.txt'), 'from-outside\n');
      git(holderDir, ['commit', '-q', '-am', 'outside conflicting']);
      const out = await step(task, {
        projectDir,
        epic: EPIC,
        testCmd: 'true',
        heavyLock: lockKnobs(),
      });
      expect(out.outcome).toBe('rebase-conflict');
      expect(existsSync(lockFile())).toBe(false);
    });

    it('a step that times out on the lock leaves a foreign hold untouched', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-edited\n');
      const held = holdLock(lockDir);
      const before = git(projectDir, ['rev-parse', INTEGRATION]);
      await expect(
        step(task, {
          projectDir,
          epic: EPIC,
          testCmd: 'true',
          heavyLock: { ...lockKnobs(), maxWaitMs: 20 },
        }),
      ).rejects.toMatchObject({ code: 'heavy.wait-timeout' });
      expect(readFileSync(lockFile(), 'utf8')).toContain('test-owned-token');
      expect(git(projectDir, ['rev-parse', INTEGRATION])).toBe(before);
      held.release();
    });
  });

  describe('git hooks the queue starts under its hold', () => {
    let holderDir: string;

    beforeEach(() => {
      holderDir = path.join(root, 'holder');
    });

    function hook(name: string, file: string): void {
      const hooksDir = path.join(projectDir, '.git', 'hooks');
      const p = path.join(hooksDir, name);
      writeFileSync(p, `#!/bin/sh\nenv > '${file}'\n`);
      chmodSync(p, 0o755);
    }

    async function envOf(file: string): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return out;
    }

    it('see the held lock and none of the queue’s own BS_/SMITH_ variables', async () => {
      // The integration branch moves ahead so the rebase is a real one.
      const task = makeTask('task-1', 'a.txt', 'a-edited\n');
      git(projectDir, ['worktree', 'add', '-q', holderDir, INTEGRATION]);
      git(holderDir, ['commit', '-q', '--allow-empty', '-m', 'integration ahead']);
      const mergeEnv = path.join(outDir, 'merge.env');
      const rebaseEnv = path.join(outDir, 'rebase.env');
      hook('post-merge', mergeEnv);
      hook('pre-rebase', rebaseEnv);
      const lockCopy = path.join(outDir, 'lock-copy.json');

      const saved = { bs: process.env.BS_QUEUE_PROBE, smith: process.env.SMITH_QUEUE_PROBE };
      process.env.BS_QUEUE_PROBE = 'leak-bs';
      process.env.SMITH_QUEUE_PROBE = 'leak-smith';
      let out: StepOutcome;
      try {
        out = await step(task, {
          projectDir,
          epic: EPIC,
          testCmd: `cp "$BS_HEAVY_LOCK_DIR/heavy.lock" '${lockCopy}'`,
          heavyLock: lockKnobs(),
        });
      } finally {
        if (saved.bs === undefined) delete process.env.BS_QUEUE_PROBE;
        else process.env.BS_QUEUE_PROBE = saved.bs;
        if (saved.smith === undefined) delete process.env.SMITH_QUEUE_PROBE;
        else process.env.SMITH_QUEUE_PROBE = saved.smith;
      }

      expect(out.outcome).toBe('merged');
      const token = (JSON.parse(await readFile(lockCopy, 'utf8')) as { token: string }).token;
      for (const file of [mergeEnv, rebaseEnv]) {
        expect(existsSync(file), file).toBe(true);
        const env = await envOf(file);
        expect(env.BS_HEAVY_LOCK_TOKEN).toBe(token);
        expect(env.BS_HEAVY_LOCK_DIR).toBe(lockDir);
        expect(env.BS_QUEUE_PROBE).toBeUndefined();
        expect(env.SMITH_QUEUE_PROBE).toBeUndefined();
      }
    });
  });

  describe('the batch path', () => {
    it('leaves every task integration-moved when a step lands between the build and the land', async () => {
      const a = makeTask('task-a', 'a.txt', 'a-edited\n');
      const b = makeTask('task-b', 'b.txt', 'b-edited\n');
      const s = makeTask('task-s', 'c.txt', 'c-edited\n');
      const batchLock = path.join(root, 'batch-locks');
      const stepLock = path.join(root, 'step-locks');
      const held = holdLock(batchLock);
      const pb = probe();

      const batch = batchStep([a, b], {
        projectDir,
        epic: EPIC,
        testCmd: 'true',
        heavyLock: { lockDir: batchLock, pollMs: 2, isPidAlive: pb.isPidAlive },
      });
      // The candidate is built once the batch is waiting for its suite's lock.
      await pb.probed;
      const landed = await step(s, {
        projectDir,
        epic: EPIC,
        testCmd: 'true',
        heavyLock: { lockDir: stepLock, pollMs: 2, isPidAlive: () => true },
      });
      expect(landed.outcome).toBe('merged');
      const afterStep = git(projectDir, ['rev-parse', INTEGRATION]);
      held.release();
      const result = await batch;

      expect(result.outcomes.map((o) => o.outcome)).toEqual([
        'integration-moved',
        'integration-moved',
      ]);
      expect(git(projectDir, ['rev-parse', INTEGRATION])).toBe(afterStep);
      expect(git(projectDir, ['show', `${INTEGRATION}:a.txt`])).toBe('a');
      expect(git(projectDir, ['show', `${INTEGRATION}:b.txt`])).toBe('b');
    });
  });

  describe('an update-ref failure with the head unchanged', () => {
    function staleLock(): string {
      const lock = path.join(projectDir, '.git', 'refs', 'heads', `${INTEGRATION}.lock`);
      writeFileSync(lock, '');
      return lock;
    }

    it('step rethrows the original git error, logs nothing and leaves the ref (tree-less)', async () => {
      const task = makeTask('task-1', 'a.txt', 'a-edited\n');
      const events = await makeEvents();
      const before = git(projectDir, ['rev-parse', INTEGRATION]);
      const lock = staleLock();
      try {
        await expect(
          step(task, { projectDir, epic: EPIC, testCmd: 'true', events, heavyLock: lockKnobs() }),
        ).rejects.toThrow(/\.lock/);
        expect(git(projectDir, ['rev-parse', INTEGRATION])).toBe(before);
        const log = await logged();
        expect(
          log.some((e) => e.type === 'error-logged' && e.payload.error === 'execution.env-failure'),
        ).toBe(false);
      } finally {
        rmSync(lock, { force: true });
      }
    });

    it('batchStep rethrows the original git error instead of marking tasks integration-moved', async () => {
      const a = makeTask('task-a', 'a.txt', 'a-edited\n');
      const b = makeTask('task-b', 'b.txt', 'b-edited\n');
      const before = git(projectDir, ['rev-parse', INTEGRATION]);
      const lock = staleLock();
      try {
        await expect(
          batchStep([a, b], { projectDir, epic: EPIC, testCmd: 'true', heavyLock: lockKnobs() }),
        ).rejects.toThrow(/\.lock/);
        expect(git(projectDir, ['rev-parse', INTEGRATION])).toBe(before);
      } finally {
        rmSync(lock, { force: true });
      }
    });
  });
});
