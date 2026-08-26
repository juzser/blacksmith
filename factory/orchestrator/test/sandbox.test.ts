import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeSandboxFor,
  closeSandbox,
  leasePathFor,
  listSandboxes,
  openSandbox,
  readSandbox,
  SandboxError,
  type SandboxLease,
} from '../src/sandbox.js';

// The lease half of the judge sandbox. policy.ts decides what a leased command
// may do; this module decides whether a command is leased at all, and every
// judge rule is downstream of that answer being right. Two properties carry the
// weight: a lease covers everything *inside* the worktree it names (or a `cd`
// into a subdirectory would step out of the sandbox), and it covers nothing
// outside it (or every coder session in the repo would be refused as a judge).

const OPENED_AT = '2026-08-26T00:00:00.000Z';

function input(worktreeDir: string, overrides: Partial<SandboxLease> = {}) {
  return {
    worktreeDir,
    role: 'reviewer',
    taskId: 'task-1',
    sessionId: 'sess-1',
    openedAt: OPENED_AT,
    ...overrides,
  };
}

describe('sandbox.ts (judge lease)', () => {
  let scratch: string;
  let leaseDir: string;
  let worktree: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'smith-sandbox-'));
    leaseDir = path.join(scratch, 'leases');
    worktree = path.join(scratch, 'wt');
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  describe('leasePathFor', () => {
    it('is stable for one worktree and distinct between two', () => {
      expect(leasePathFor(worktree, leaseDir)).toBe(leasePathFor(worktree, leaseDir));
      expect(leasePathFor(worktree, leaseDir)).not.toBe(
        leasePathFor(path.join(scratch, 'other'), leaseDir),
      );
    });

    it('keys on the resolved path, so two spellings of one worktree are one lease', () => {
      // Otherwise `smith sandbox close .` from inside the worktree would leave
      // the lease opened under an absolute path in place, and the next judge
      // would inherit a sandbox nobody meant to hand it.
      const spelled = path.join(worktree, 'ui', '..');
      expect(leasePathFor(spelled, leaseDir)).toBe(leasePathFor(worktree, leaseDir));
    });

    it('names a .json file under the lease directory', () => {
      const file = leasePathFor(worktree, leaseDir);
      expect(path.dirname(file)).toBe(leaseDir);
      expect(file.endsWith('.json')).toBe(true);
    });
  });

  describe('openSandbox', () => {
    it('creates the lease directory and writes the lease it returns', () => {
      const lease = openSandbox(input(worktree), leaseDir);
      expect(lease).toEqual({
        worktreeDir: worktree,
        role: 'reviewer',
        taskId: 'task-1',
        sessionId: 'sess-1',
        openedAt: OPENED_AT,
      });
      const onDisk = JSON.parse(readFileSync(leasePathFor(worktree, leaseDir), 'utf8'));
      expect(onDisk).toEqual(lease);
    });

    it('records the resolved worktree path, not the one it was handed', () => {
      const lease = openSandbox(input(path.join(worktree, 'ui', '..')), leaseDir);
      expect(lease.worktreeDir).toBe(worktree);
    });

    it('refuses a second lease on the same worktree, naming who holds the first', () => {
      // Two judges in one worktree means the second one's writes land inside
      // the first one's lease and neither verdict can be trusted. The answer is
      // a second worktree, so this is an error rather than an overwrite.
      openSandbox(input(worktree), leaseDir);
      let caught: unknown;
      try {
        openSandbox(input(worktree, { role: 'verifier', taskId: 'task-2' }), leaseDir);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SandboxError);
      expect((caught as SandboxError).code).toBe('sandbox.already-open');
      expect((caught as SandboxError).message).toContain('reviewer');
      expect((caught as SandboxError).message).toContain('task-1');
    });

    it('allows concurrent leases on different worktrees', () => {
      const second = path.join(scratch, 'wt2');
      mkdirSync(second);
      openSandbox(input(worktree), leaseDir);
      openSandbox(input(second, { taskId: 'task-2' }), leaseDir);
      expect(listSandboxes(leaseDir)).toHaveLength(2);
    });
  });

  describe('readSandbox / closeSandbox', () => {
    it('reads back nothing when no lease was opened', () => {
      expect(readSandbox(worktree, leaseDir)).toBeNull();
    });

    it('round-trips a lease and then removes it', () => {
      openSandbox(input(worktree), leaseDir);
      expect(readSandbox(worktree, leaseDir)?.role).toBe('reviewer');
      expect(closeSandbox(worktree, leaseDir)).toBe(true);
      expect(readSandbox(worktree, leaseDir)).toBeNull();
    });

    it('reports false rather than throwing when there is nothing to close', () => {
      // Closing is the orchestrator's cleanup path and it runs after a judge
      // that crashed just as much as after one that finished; making "already
      // closed" an error would turn tidying up into a second failure.
      expect(closeSandbox(worktree, leaseDir)).toBe(false);
    });

    it('rejects a lease file that is not a lease, instead of trusting its shape', () => {
      mkdirSync(leaseDir, { recursive: true });
      writeFileSync(leasePathFor(worktree, leaseDir), '{"role":"reviewer"}\n', 'utf8');
      expect(() => readSandbox(worktree, leaseDir)).toThrow(SandboxError);
    });
  });

  describe('listSandboxes', () => {
    it('is empty when the lease directory has never been created', () => {
      expect(listSandboxes(path.join(scratch, 'nothing-here'))).toEqual([]);
    });

    it('ignores files that are not leases', () => {
      openSandbox(input(worktree), leaseDir);
      writeFileSync(path.join(leaseDir, 'README.md'), 'not a lease\n', 'utf8');
      expect(listSandboxes(leaseDir)).toHaveLength(1);
    });
  });

  describe('activeSandboxFor', () => {
    it('covers the worktree root itself', () => {
      openSandbox(input(worktree), leaseDir);
      expect(activeSandboxFor(worktree, leaseDir)?.taskId).toBe('task-1');
    });

    it('covers a subdirectory, so a cd cannot step out of the sandbox', () => {
      openSandbox(input(worktree), leaseDir);
      const deep = path.join(worktree, 'factory', 'orchestrator');
      expect(activeSandboxFor(deep, leaseDir)?.taskId).toBe('task-1');
    });

    it('does not cover the parent of a leased worktree', () => {
      openSandbox(input(worktree), leaseDir);
      expect(activeSandboxFor(scratch, leaseDir)).toBeNull();
    });

    it('does not cover a sibling whose path merely starts with the same string', () => {
      // `<scratch>/wt-notes` is not inside `<scratch>/wt`, and a prefix test
      // rather than a path test would say it is.
      openSandbox(input(worktree), leaseDir);
      expect(activeSandboxFor(`${worktree}-notes`, leaseDir)).toBeNull();
    });

    it('returns nothing at all when no lease is open — the ordinary case', () => {
      expect(activeSandboxFor(worktree, leaseDir)).toBeNull();
    });

    it('picks the innermost lease when worktrees nest', () => {
      const inner = path.join(worktree, 'inner');
      mkdirSync(inner, { recursive: true });
      openSandbox(input(worktree), leaseDir);
      openSandbox(input(inner, { role: 'verifier', taskId: 'task-2' }), leaseDir);
      expect(activeSandboxFor(path.join(inner, 'src'), leaseDir)?.taskId).toBe('task-2');
      expect(activeSandboxFor(worktree, leaseDir)?.taskId).toBe('task-1');
    });
  });
});
