import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactHome, checkArtifacts } from '../src/artifacts.js';

describe('artifactHome', () => {
  it('gives a task one home, under the artifacts dir and named for the task', () => {
    const home = artifactHome('epic-1/task-1', '/s/artifacts');
    expect(home).toBe(path.join('/s/artifacts', 'epic-1', 'task-1'));
  });

  it('refuses a task id that would climb out of the artifacts dir', () => {
    // task_id reaches the gate from a worker-written result file. A home
    // computed by joining it to a root is a path traversal waiting to happen,
    // and the gate then reports "verified" about somewhere else entirely.
    expect(() => artifactHome('../../etc', '/s/artifacts')).toThrow(/task/i);
  });

  it('refuses a task id that is missing or blank rather than aiming at the root', () => {
    // Measured, not imagined: 16 of the 21 files in state/results/ have no
    // task_id at all. An empty id resolves to the artifacts root, which
    // contains every task's home — so every one of them would then "pass" the
    // containment check, and the crash from an undefined one is a raw
    // TypeError from node:path rather than anything an operator can act on.
    expect(() => artifactHome('', '/s/artifacts')).toThrow(/task/i);
    expect(() => artifactHome(undefined as unknown as string, '/s/artifacts')).toThrow(/task/i);
    expect(() => artifactHome('   ', '/s/artifacts')).toThrow(/task/i);
  });
});

describe('checkArtifacts', () => {
  let artifactsDir: string;
  let home: string;
  const taskId = 'epic-1/task-1';

  beforeEach(async () => {
    artifactsDir = await mkdtemp(path.join(tmpdir(), 'smith-artifacts-'));
    home = artifactHome(taskId, artifactsDir);
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('accepts a relative path, resolved against the home', async () => {
    await writeFile(path.join(home, 'coverage.txt'), 'All files 98.99%\n');
    const check = checkArtifacts([{ type: 'coverage-report', path: 'coverage.txt' }], {
      taskId,
      artifactsDir,
    });
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(1);
    expect(check.issues).toEqual([]);
  });

  it('accepts an absolute path that is already inside the home', async () => {
    await writeFile(path.join(home, 'lint.txt'), 'exit 0\n');
    const check = checkArtifacts([{ type: 'lint-output', path: path.join(home, 'lint.txt') }], {
      taskId,
      artifactsDir,
    });
    expect(check.ok).toBe(true);
  });

  it('accepts a directory — an html coverage report is a real artifact', async () => {
    await mkdir(path.join(home, 'coverage'), { recursive: true });
    const check = checkArtifacts([{ type: 'coverage-report', path: 'coverage' }], {
      taskId,
      artifactsDir,
    });
    expect(check.ok).toBe(true);
  });

  it('reports a declared path that does not exist', () => {
    const check = checkArtifacts([{ type: 'test-output', path: 'test.txt' }], {
      taskId,
      artifactsDir,
    });
    expect(check.ok).toBe(false);
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0]).toMatchObject({ declared: 'test.txt', problem: 'missing' });
    expect(check.issues[0]?.resolved).toBe(path.join(home, 'test.txt'));
  });

  it('reports a path outside the home even when the file is right there on disk', async () => {
    // D-19 exactly: three artifacts under /tmp, all of them real at the time
    // and none of them durable. Existence is not the property being checked;
    // "still openable when someone reads the verdict" is.
    const stray = path.join(artifactsDir, 'stray.txt');
    await writeFile(stray, 'real, and swept next reboot\n');
    const check = checkArtifacts([{ type: 'test-output', path: stray }], { taskId, artifactsDir });
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatchObject({ declared: stray, problem: 'outside-home' });
  });

  it('calls a path outside the home outside-home, not missing, when it is both', () => {
    // The actionable half of "wrong place AND gone" is the wrong place: moving
    // it into the home is the fix, and re-creating it where it was is not.
    const check = checkArtifacts([{ type: 'log', path: '/tmp/does-not-exist-either.txt' }], {
      taskId,
      artifactsDir,
    });
    expect(check.issues[0]?.problem).toBe('outside-home');
  });

  it('reports every bad artifact, not just the first', () => {
    const check = checkArtifacts(
      [
        { type: 'test-output', path: 'a.txt' },
        { type: 'log', path: '/tmp/b.txt' },
        { type: 'log', path: 'c.txt' },
      ],
      { taskId, artifactsDir },
    );
    expect(check.checked).toBe(3);
    expect(check.issues.map((i) => i.declared)).toEqual(['a.txt', '/tmp/b.txt', 'c.txt']);
  });

  it('is a clean no-op for a task that declares no artifacts', () => {
    const check = checkArtifacts([], { taskId, artifactsDir });
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(0);
    expect(check.home).toBe(home);
  });

  it('follows a symlink out of the home, the way the operator reading it will', async () => {
    // The escape the lexical check cannot see. `../elsewhere/coverage.txt` is
    // refused; `evidence/coverage.txt`, where `evidence` is a link to the same
    // directory, is the same file said in a way that spells correctly. The
    // honest declaration fails and the concealing one passes — which is the
    // wrong way round for a check whose whole subject is durability (D-19).
    const outside = path.join(artifactsDir, 'elsewhere');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'coverage.txt'), 'All files 98.99%\n');
    await symlink(outside, path.join(home, 'evidence'));
    const check = checkArtifacts([{ type: 'coverage-report', path: 'evidence/coverage.txt' }], {
      taskId,
      artifactsDir,
    });
    expect(check.ok).toBe(false);
    expect(check.issues[0]).toMatchObject({
      declared: 'evidence/coverage.txt',
      problem: 'outside-home',
    });
    // Where it actually went, not where it spelled: an issue naming a path
    // that looks correct is one the operator cannot act on.
    expect(check.issues[0]?.resolved).toContain('elsewhere');
  });

  it('follows a symlinked file too, not just a symlinked directory', async () => {
    const stray = path.join(artifactsDir, 'stray.txt');
    await writeFile(stray, 'real, and swept next reboot\n');
    await symlink(stray, path.join(home, 'coverage.txt'));
    const check = checkArtifacts([{ type: 'coverage-report', path: 'coverage.txt' }], {
      taskId,
      artifactsDir,
    });
    expect(check.issues[0]?.problem).toBe('outside-home');
  });

  it('leaves a symlink that stays inside the home alone', async () => {
    // The fix is about where the bytes are, not about how the path is spelled.
    // A link from `latest.txt` to a run-stamped file beside it never leaves.
    await writeFile(path.join(home, 'test-run-3.txt'), 'exit 0\n');
    await symlink(path.join(home, 'test-run-3.txt'), path.join(home, 'latest.txt'));
    const check = checkArtifacts([{ type: 'test-output', path: 'latest.txt' }], {
      taskId,
      artifactsDir,
    });
    expect(check.ok).toBe(true);
  });

  it('reports a home that is itself a link out, on every artifact under it', async () => {
    // Same escape, one level up: the worker never leaves its home, its home
    // leaves state/artifacts. Relative paths then resolve inside a home that
    // is the worktree, and every one of them passes a containment check that
    // only ever compared strings.
    const elsewhereHome = path.join(artifactsDir, 'worktree');
    await mkdir(elsewhereHome, { recursive: true });
    await writeFile(path.join(elsewhereHome, 'coverage.txt'), 'All files 98.99%\n');
    const linkedTask = 'epic-1/task-linked';
    const linkedHome = artifactHome(linkedTask, artifactsDir);
    await mkdir(path.dirname(linkedHome), { recursive: true });
    await symlink(elsewhereHome, linkedHome);
    const check = checkArtifacts([{ type: 'coverage-report', path: 'coverage.txt' }], {
      taskId: linkedTask,
      artifactsDir,
    });
    expect(check.ok).toBe(false);
    expect(check.issues[0]?.problem).toBe('outside-home');
  });

  it('refuses a declaration that names the home itself instead of anything in it', () => {
    // `artifactHome` already refuses a blank task id, for the reason that a
    // blank one resolves to the root and would then pass on any path at all.
    // A blank artifact path is that same argument one level down: it resolves
    // to the home, which exists for every task that wrote anything, so it
    // passes as evidence of everything and of nothing.
    const check = checkArtifacts(
      [
        { type: 'coverage-report', path: '' },
        { type: 'log', path: '.' },
      ],
      { taskId, artifactsDir },
    );
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => i.problem)).toEqual(['no-path', 'no-path']);
  });

  it('escapes nothing when the home itself was never created', async () => {
    // A task that wrote no artifacts and declared none must not be forced to
    // mkdir a directory just to pass a check about its contents.
    await rm(home, { recursive: true, force: true });
    expect(checkArtifacts([], { taskId, artifactsDir }).ok).toBe(true);
  });
});
