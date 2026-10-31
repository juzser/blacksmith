import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import { DEFAULT_MAX_WAIT_MS } from '../src/heavyLock.js';
import {
  certifyChecks,
  INTEGRATION_CHECK_EVENT,
  integrationHeadSha,
  lastTieredRecordId,
  latestIntegrationCheck,
  latestIntegrationCheckAt,
  runChecksAt,
  runIntegrationCheck,
} from '../src/integration.js';
import { SPEC_REVIEW_EVENT } from '../src/spec.js';
import { type CheckCommand, checkDigest, SLEEP_GAP_MS } from '../src/testgate.js';
import { git as runGitFixture } from './helpers/process.js';

function git(cwd: string, args: string[]): string {
  return runGitFixture(cwd, args).trim();
}

const sessionId = 'sess-tiers';
const epicId = 'epic-1';
const branch = 'bs/epic-1/integration';

describe('integration tiers', () => {
  let root: string;
  let projectDir: string;
  let stateDir: string;
  let counter: string;
  let children: ChildProcess[];

  const ctx = () => ({
    sessionId,
    planVersion: 1,
    causalParent: `${sessionId}#0`,
    actor: 'system',
  });
  const opts = () => ({ stateDir });
  const ran = async (): Promise<string[]> =>
    existsSync(counter) ? (await readFile(counter, 'utf8')).split('\n').filter(Boolean) : [];
  const count = (name: string): CheckCommand => ({ name, cmd: `echo ${name} >> ${counter}` });
  const log = () => readEvents(sessionId, opts());
  const records = async () =>
    (await log()).filter((e) => e.record.event_type === INTEGRATION_CHECK_EVENT);
  const payloadOf = (e: StoredEvent | undefined) =>
    (e?.record.payload ?? {}) as Record<string, unknown>;
  const lastPayload = async () => payloadOf((await records()).at(-1));
  const scratchRoot = () => path.join(root, '.wt', 'project');
  const worktrees = () =>
    git(projectDir, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '));

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'smith-integration-tiers-'));
    projectDir = path.join(root, 'project');
    stateDir = path.join(root, 'events');
    counter = path.join(root, 'counter.txt');
    children = [];
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
      opts(),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const c of children) c.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  const tiered = (): CheckCommand[] => [
    { ...count('lint-a'), tier: 'pre-merge' },
    { ...count('lint-b'), tier: 'post-merge' },
    { ...count('lint-c'), tier: 'pre-release' },
  ];
  const input = (checks: CheckCommand[], extra: Record<string, unknown> = {}) => ({
    epicId,
    projectDir,
    checks,
    ...extra,
  });

  describe('tier selection at the clone root', () => {
    it('runs only the named tier and records tiers, tiers_present, tree and digests', async () => {
      const out = await runIntegrationCheck(input(tiered(), { tier: 'post-merge' }), ctx(), opts());
      expect(await ran()).toEqual(['lint-b']);
      expect(out.tiers).toEqual(['post-merge']);
      expect(out.tiersPresent).toEqual(['pre-merge', 'post-merge', 'pre-release']);
      const p = await lastPayload();
      expect(p.tiers).toEqual(['post-merge']);
      expect(p.tiers_present).toEqual(['pre-merge', 'post-merge', 'pre-release']);
      expect(p.tree_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(p.tree_sha).toBe(git(projectDir, ['rev-parse', 'HEAD^{tree}']));
      const result = (p.results as Record<string, unknown>[])[0];
      expect(result?.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result?.check_sha256).toBe(checkDigest(tiered()[1] as CheckCommand));
    });

    it('runs every check for `all`', async () => {
      await runIntegrationCheck(input(tiered(), { tier: 'all' }), ctx(), opts());
      expect(await ran()).toEqual(['lint-a', 'lint-b', 'lint-c']);
    });

    it('lists every tier present when no tier is given', async () => {
      const out = await runIntegrationCheck(input(tiered()), ctx(), opts());
      expect(out.tiers).toEqual(['pre-merge', 'post-merge', 'pre-release']);
    });

    it('keeps the clone-root refusals without a tier', async () => {
      git(projectDir, ['checkout', '-q', 'main']);
      await expect(runIntegrationCheck(input(tiered()), ctx(), opts())).rejects.toMatchObject({
        code: 'integration.wrong-branch',
      });
      git(projectDir, ['checkout', '-q', branch]);
      await writeFile(path.join(projectDir, 'dirty.txt'), 'x');
      await expect(runIntegrationCheck(input(tiered()), ctx(), opts())).rejects.toMatchObject({
        code: 'integration.dirty-tree',
      });
      expect(await ran()).toEqual([]);
    });

    it('throws no-checks naming the tier when the selection is empty, and writes nothing', async () => {
      const checks = [{ ...count('lint-a'), tier: 'pre-merge' as const }];
      await expect(
        runIntegrationCheck(input(checks, { tier: 'post-merge' }), ctx(), opts()),
      ).rejects.toMatchObject({
        code: 'integration.no-checks',
        message: expect.stringContaining('post-merge'),
      });
      expect(await records()).toHaveLength(0);
    });
  });

  describe('remaining', () => {
    const seedPostMerge = async () => {
      await runIntegrationCheck(input(tiered(), { tier: 'post-merge' }), ctx(), opts());
      await rm(counter);
    };

    it('runs only the checks the head has no certified result for', async () => {
      await seedPostMerge();
      const out = await runIntegrationCheck(input(tiered(), { tier: 'remaining' }), ctx(), opts());
      expect(await ran()).toEqual(['lint-a', 'lint-c']);
      expect(out.tiers).toEqual(['pre-merge', 'pre-release']);
      expect(out.tiersPresent).toEqual(['pre-merge', 'post-merge', 'pre-release']);
    });

    it('runs a check whose command was edited', async () => {
      await seedPostMerge();
      const edited = tiered().map((c) =>
        c.name === 'lint-b' ? { ...c, cmd: `${c.cmd} # edited` } : c,
      );
      await runIntegrationCheck(input(edited, { tier: 'remaining' }), ctx(), opts());
      expect(await ran()).toEqual(['lint-a', 'lint-b', 'lint-c']);
    });

    it('does not rerun a check whose tier alone moved', async () => {
      await seedPostMerge();
      const moved = tiered().map((c) =>
        c.name === 'lint-b' ? { ...c, tier: 'pre-release' as const } : c,
      );
      await runIntegrationCheck(input(moved, { tier: 'remaining' }), ctx(), opts());
      expect(await ran()).toEqual(['lint-a', 'lint-c']);
    });

    it('selects again a check whose last result for the digest is a fail after a pass', async () => {
      await seedPostMerge();
      const b = tiered()[1] as CheckCommand;
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'system',
          event_type: INTEGRATION_CHECK_EVENT,
          plan_version: 1,
          causal_parent: `${sessionId}#0`,
          payload: {
            epic_id: epicId,
            branch,
            head_sha: git(projectDir, ['rev-parse', 'HEAD']),
            pass: false,
            results: [
              { name: 'lint-b', pass: false, exitCode: 1, tail: '', check_sha256: checkDigest(b) },
            ],
          },
        },
        opts(),
      );
      await runIntegrationCheck(input(tiered(), { tier: 'remaining' }), ctx(), opts());
      expect(await ran()).toEqual(['lint-a', 'lint-b', 'lint-c']);
    });

    it('throws nothing-remaining naming the head when everything is certified, and runs nothing', async () => {
      await runIntegrationCheck(input(tiered(), { tier: 'all' }), ctx(), opts());
      await rm(counter);
      const before = (await records()).length;
      const head = git(projectDir, ['rev-parse', 'HEAD']);
      await expect(
        runIntegrationCheck(input(tiered(), { tier: 'remaining' }), ctx(), opts()),
      ).rejects.toMatchObject({
        code: 'integration.nothing-remaining',
        message: expect.stringContaining(head),
      });
      expect(await ran()).toEqual([]);
      expect(await records()).toHaveLength(before);
    });

    it('still throws no-checks for an empty list', async () => {
      await expect(
        runIntegrationCheck(input([], { tier: 'remaining' }), ctx(), opts()),
      ).rejects.toMatchObject({ code: 'integration.no-checks' });
    });
  });

  describe('runChecksAt', () => {
    it('gives concurrent runs distinct directories', async () => {
      const pwdOf = (n: number): CheckCommand => ({
        name: `pwd-${n}`,
        cmd: `pwd > ${root}/pwd-${n}.txt && sleep 0.3`,
      });
      const [a, b] = await Promise.all([
        runChecksAt(projectDir, 'HEAD', [pwdOf(1)]),
        runChecksAt(projectDir, 'HEAD', [pwdOf(2)]),
      ]);
      expect(a.pass && b.pass).toBe(true);
      const d1 = (await readFile(`${root}/pwd-1.txt`, 'utf8')).trim();
      const d2 = (await readFile(`${root}/pwd-2.txt`, 'utf8')).trim();
      expect(d1).not.toBe(d2);
      expect(path.basename(d1)).toMatch(/^scratch-\d+-/);
    });

    const deadPid = (): number => {
      const dead = spawnSync('true');
      return dead.pid;
    };

    it('removes a registered scratch worktree of a dead pid before the next run', async () => {
      const stale = path.join(scratchRoot(), `scratch-${deadPid()}-old`);
      git(projectDir, ['worktree', 'add', '--detach', stale, 'HEAD']);
      const result = await runChecksAt(projectDir, 'HEAD', [count('lint-a')]);
      expect(result.pass).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(worktrees()).toHaveLength(1);
    });

    it('carries on when removing a dead pid scratch worktree fails', async () => {
      const stuck = path.join(scratchRoot(), `scratch-${deadPid()}-stuck`);
      git(projectDir, ['worktree', 'add', '--detach', stuck, 'HEAD']);
      git(projectDir, ['worktree', 'lock', stuck]);
      const result = await runChecksAt(projectDir, 'HEAD', [count('lint-a')]);
      expect(result.pass).toBe(true);
      expect(existsSync(stuck)).toBe(true);
    });

    it('leaves a scratch worktree of a live pid alone', async () => {
      const child = spawn('sleep', ['30']);
      children.push(child);
      const live = path.join(scratchRoot(), `scratch-${child.pid}-mine`);
      git(projectDir, ['worktree', 'add', '--detach', live, 'HEAD']);
      await runChecksAt(projectDir, 'HEAD', [count('lint-a')]);
      expect(existsSync(live)).toBe(true);
    });

    it('runs outside the clone, removes the scratch dir and leaves the clone untouched', async () => {
      await writeFile(path.join(projectDir, 'untracked.txt'), 'x');
      const snapshot = () => [
        git(projectDir, ['status', '--porcelain']),
        git(projectDir, ['branch', '--show-current']),
      ];
      const before = snapshot();
      const result = await runChecksAt(projectDir, 'HEAD', [
        { name: 'where', cmd: `pwd > ${root}/where.txt` },
      ]);
      const where = (await readFile(`${root}/where.txt`, 'utf8')).trim();
      expect(result.pass).toBe(true);
      expect(where.startsWith(projectDir)).toBe(false);
      expect(existsSync(where)).toBe(false);
      expect(snapshot()).toEqual(before);
      expect(worktrees()).toHaveLength(1);
    });

    it('removes the worktree when a check times out', async () => {
      const result = await runChecksAt(projectDir, 'HEAD', [{ name: 'slow', cmd: 'sleep 5' }], {
        timeoutMs: 1,
      });
      expect(result.pass).toBe(false);
      expect(worktrees()).toHaveLength(1);
    });

    it('returns setupFailed for a failing setup command and runs no check', async () => {
      const result = await runChecksAt(projectDir, 'HEAD', [count('lint-a')], {
        setupCmd: 'exit 3',
      });
      expect(result).toMatchObject({
        setupFailed: true,
        results: [],
        environment: [],
        pass: false,
      });
      expect(result.setup?.exitCode).toBe(3);
      expect(await ran()).toEqual([]);
      expect(worktrees()).toHaveLength(1);
    });

    it('returns setupFailed when declared dependencies are not installed', async () => {
      await writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ dependencies: { left: '1.0.0' } }),
      );
      git(projectDir, ['add', 'package.json']);
      git(projectDir, ['commit', '-q', '-m', 'deps']);
      const result = await runChecksAt(projectDir, 'HEAD', [count('lint-a')]);
      expect(result.setupFailed).toBe(true);
      expect(result.setup).toBeNull();
      expect(result.deps?.ok).toBe(false);
      expect(result.results).toEqual([]);
      expect(await ran()).toEqual([]);
    });

    it('runs a passing setup before the checks, inside the scratch worktree', async () => {
      const result = await runChecksAt(
        projectDir,
        'HEAD',
        [{ name: 'lint-a', cmd: 'test -f marker.txt' }],
        { setupCmd: 'touch marker.txt' },
      );
      expect(result.setupFailed).toBe(false);
      expect(result.setup?.pass).toBe(true);
      expect(result.pass).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(existsSync(path.join(projectDir, 'marker.txt'))).toBe(false);
    });
  });

  describe('scratch runs through runIntegrationCheck', () => {
    const scratch = (checks: CheckCommand[], extra: Record<string, unknown> = {}) =>
      input(checks, { workspace: 'scratch', commit: 'HEAD', ...extra });

    it('throws setup-failed with setup and deps, writes no record and runs no check', async () => {
      const failing = runIntegrationCheck(
        scratch([count('lint-a')], { setupCmd: 'exit 3' }),
        ctx(),
        opts(),
      );
      await expect(failing).rejects.toMatchObject({
        code: 'integration.setup-failed',
        details: {
          epicId,
          commit: git(projectDir, ['rev-parse', 'HEAD']),
          setup: { pass: false, exitCode: 3 },
          deps: null,
        },
      });
      await writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ dependencies: { left: '1.0.0' } }),
      );
      git(projectDir, ['add', 'package.json']);
      git(projectDir, ['commit', '-q', '-m', 'deps']);
      await expect(
        runIntegrationCheck(scratch([count('lint-a')]), ctx(), opts()),
      ).rejects.toMatchObject({
        code: 'integration.setup-failed',
        details: { setup: null, deps: { ok: false } },
      });
      expect(await records()).toHaveLength(0);
      expect(await ran()).toEqual([]);
    });

    it('runs a passing setup in the scratch worktree before the checks', async () => {
      const out = await runIntegrationCheck(
        scratch([{ name: 'lint-a', cmd: 'test -f marker.txt' }], { setupCmd: 'touch marker.txt' }),
        ctx(),
        opts(),
      );
      expect(out.pass).toBe(true);
    });

    it('records a commit that is not on the branch under its full sha, and certifies it there only', async () => {
      git(projectDir, ['checkout', '-q', '-b', 'side']);
      await writeFile(path.join(projectDir, 'side.txt'), 'side\n');
      git(projectDir, ['add', 'side.txt']);
      git(projectDir, ['commit', '-q', '-m', 'side']);
      const full = git(projectDir, ['rev-parse', 'HEAD']);
      git(projectDir, ['checkout', '-q', branch]);
      const integrationHead = git(projectDir, ['rev-parse', 'HEAD']);

      const out = await runIntegrationCheck(
        scratch([count('lint-a')], { commit: full.slice(0, 8) }),
        ctx(),
        opts(),
      );
      const p = await lastPayload();
      expect(p.head_sha).toBe(full);
      expect(p.tree_sha).toBe(git(projectDir, ['rev-parse', `${full}^{tree}`]));
      expect(p.branch).toBe(branch);
      expect(out.headSha).toBe(full);
      const q = [{ name: 'lint-a', checkSha256: checkDigest(count('lint-a')) }];
      const events = await log();
      expect(certifyChecks(events, epicId, full, q)[0]?.certified).toBe(true);
      expect(certifyChecks(events, epicId, integrationHead, q)[0]?.certified).toBe(false);

      git(projectDir, ['merge', '-q', '--ff-only', 'side']);
      expect(integrationHeadSha(projectDir, epicId)).toBe(full);
      expect(certifyChecks(events, epicId, full, q)[0]?.certified).toBe(true);
    });

    it('succeeds on a clone that is on another branch with a dirty tree and changes nothing', async () => {
      git(projectDir, ['checkout', '-q', 'main']);
      await writeFile(path.join(projectDir, 'dirty.txt'), 'x');
      const before = [
        git(projectDir, ['status', '--porcelain']),
        git(projectDir, ['branch', '--show-current']),
      ];
      const out = await runIntegrationCheck(scratch([count('lint-a')]), ctx(), opts());
      expect(out.branch).toBe(branch);
      expect([
        git(projectDir, ['status', '--porcelain']),
        git(projectDir, ['branch', '--show-current']),
      ]).toEqual(before);
    });

    it('refuses bad input before anything runs, is written or is created', async () => {
      const refusals: [Record<string, unknown>, string, string][] = [
        [{ workspace: 'scratch' }, 'integration.bad-input', 'commit'],
        [{ commit: 'HEAD' }, 'integration.bad-input', 'commit'],
        [{ setupCmd: 'true' }, 'integration.bad-input', 'setupCmd'],
        [{ probeOf: '' }, 'integration.bad-input', 'probeOf'],
        [{ workspace: 'scratch', commit: 'nope' }, 'integration.unknown-commit', 'nope'],
        [{ workspace: 'scratch', commit: '--all' }, 'integration.unknown-commit', '--all'],
      ];
      for (const [extra, code, named] of refusals) {
        await expect(
          runIntegrationCheck(input([count('lint-a')], extra), ctx(), opts()),
        ).rejects.toMatchObject({ code, message: expect.stringContaining(named) });
      }
      expect(await records()).toHaveLength(0);
      expect(await ran()).toEqual([]);
      expect(existsSync(path.join(root, '.wt'))).toBe(false);
    });

    it('keeps branch-missing for a scratch run', async () => {
      git(projectDir, ['checkout', '-q', 'main']);
      git(projectDir, ['branch', '-q', '-D', branch]);
      await expect(
        runIntegrationCheck(scratch([count('lint-a')], { commit: 'main' }), ctx(), opts()),
      ).rejects.toMatchObject({ code: 'integration.branch-missing' });
    });
  });

  describe('not-run checks and environment evidence', () => {
    it('lists a heavy check whose lock wait timed out in not_run', async () => {
      const lockDir = path.join(root, 'locks');
      await mkdir(lockDir, { recursive: true });
      const holder = spawn('sleep', ['30']);
      children.push(holder);
      await writeFile(
        path.join(lockDir, 'heavy.lock'),
        JSON.stringify({
          pid: holder.pid,
          token: randomUUID(),
          label: 'other',
          startedAt: new Date().toISOString(),
          cwd: root,
        }),
      );
      vi.stubEnv('BS_HEAVY_LOCK_DIR', lockDir);
      vi.stubEnv('BS_HEAVY_LOCK_TOKEN', '');
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      let settled = false;
      const pending = runIntegrationCheck(
        input([{ name: 'unit', cmd: 'true', heavy: true }, count('lint-a')]),
        ctx(),
        opts(),
      ).finally(() => {
        settled = true;
      });
      while (!settled) {
        await vi.advanceTimersByTimeAsync(DEFAULT_MAX_WAIT_MS);
        await new Promise((r) => setImmediate(r));
      }
      const out = await pending;
      expect(out.notRun).toEqual(['unit']);
      expect((await lastPayload()).not_run).toEqual(['unit']);
      expect(out.pass).toBe(false);
      const env = (await lastPayload()).environment as { name: string; window: string }[];
      expect(env.map((e) => [e.name, e.window])).toEqual([
        ['unit', 'none'],
        ['lint-a', 'command'],
      ]);
    });

    const gapSources = (gaps: number[]) => {
      let call = 0;
      let t = 0;
      return {
        wallMs: () => {
          const i = call++;
          if (i % 2 === 1) t += gaps[(i - 1) / 2] ?? 0;
          return t;
        },
        monotonicMs: () => 0,
        load1m: () => 0,
        cpus: () => 1,
      };
    };
    const checks = (): CheckCommand[] => [
      { name: 'lint-a', cmd: 'exit 1' },
      { name: 'lint-b', cmd: 'true' },
    ];

    it('classifies a failed check whose own window shows the machine slept', async () => {
      const out = await runIntegrationCheck(
        input(checks(), { environmentSources: gapSources([SLEEP_GAP_MS, 0]) }),
        ctx(),
        opts(),
      );
      const p = await lastPayload();
      expect(p.error_class).toBe('execution.env-failure');
      expect((p.environment_evidence as { name: string }[]).map((e) => e.name)).toEqual(['lint-a']);
      expect(out.errorClass).toBe('execution.env-failure');
      expect(out.environmentEvidence?.map((e) => e.name)).toEqual(['lint-a']);
    });

    it('classifies nothing for a gap of 0, or a gap on a check that passed', async () => {
      for (const gaps of [
        [0, 0],
        [0, SLEEP_GAP_MS],
      ]) {
        await runIntegrationCheck(
          input(checks(), { environmentSources: gapSources(gaps) }),
          ctx(),
          opts(),
        );
        const p = await lastPayload();
        expect('error_class' in p).toBe(false);
        expect('environment_evidence' in p).toBe(false);
      }
    });

    it('holds no copy of the sleep rule', () => {
      const src = readFileSync(
        path.join(path.dirname(new URL(import.meta.url).pathname), '../src/integration.ts'),
        'utf8',
      );
      expect(src).not.toMatch(/clock_gap_ms|SLEEP_GAP_MS/);
    });
  });

  describe('record shape and probes', () => {
    const shape = async (extra: Record<string, unknown>) => {
      await runIntegrationCheck(
        input([count('lint-a'), { name: 'lint-b', cmd: 'exit 1' }], extra),
        ctx(),
        opts(),
      );
      return lastPayload();
    };

    it('carries environment beside results on clone, probe and scratch records', async () => {
      for (const extra of [{}, { probeOf: 'run-1' }, { workspace: 'scratch', commit: 'HEAD' }]) {
        const p = await shape(extra);
        const results = p.results as Record<string, unknown>[];
        const env = p.environment as Record<string, unknown>[];
        expect(env).toHaveLength(results.length);
        for (const [i, r] of results.entries()) {
          expect(env[i]?.name).toBe(r.name);
          expect(env[i]?.window).toBe('command');
          expect(typeof env[i]?.monotonic_ms).toBe('number');
          expect('environment' in r).toBe(false);
        }
      }
    });

    it('writes probe_of only when given, and a probe never certifies', async () => {
      const plain = await shape({});
      expect('probe_of' in plain).toBe(false);
      const scratchPlain = await shape({ workspace: 'scratch', commit: 'HEAD' });
      expect('probe_of' in scratchPlain).toBe(false);
      const probe = await shape({ probeOf: 'run-x' });
      expect(probe.probe_of).toBe('run-x');
      await expect(shape({ probeOf: '' })).rejects.toMatchObject({ code: 'integration.bad-input' });

      const head = git(projectDir, ['rev-parse', 'HEAD']);
      const q = [{ name: 'lint-a', checkSha256: checkDigest(count('lint-a')) }];
      const all = await log();
      const plainOnly = all.filter((e) => !('probe_of' in payloadOf(e)));
      expect(certifyChecks(plainOnly, epicId, head, q)[0]?.certified).toBe(true);
      const probesOnly = all.filter((e) => 'probe_of' in payloadOf(e));
      expect(probesOnly).toHaveLength(1);
      expect(certifyChecks(probesOnly, epicId, head, q)[0]?.certified).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure readers, over hand-built events.
// ---------------------------------------------------------------------------

const H = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
let seq = 0;

function ev(
  payload: Record<string, unknown>,
  extra: { id?: string; type?: string; ts?: string } = {},
): StoredEvent {
  seq += 1;
  return {
    event_id: extra.id ?? `e${seq}`,
    record: {
      ts: extra.ts ?? `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
      session_id: 's',
      actor: 'system',
      event_type: extra.type ?? INTEGRATION_CHECK_EVENT,
      plan_version: 1,
      causal_parent: null,
      payload,
    } as StoredEvent['record'],
  };
}

const res = (name: string, sha: string | undefined, over: Record<string, unknown> = {}) => ({
  name,
  pass: true,
  exitCode: 0,
  tail: '',
  ...(sha === undefined ? {} : { check_sha256: sha }),
  ...over,
});
const rec = (results: unknown, over: Record<string, unknown> = {}) => ({
  epic_id: 'epic-1',
  branch: 'bs/epic-1/integration',
  head_sha: H,
  pass: true,
  results,
  ...over,
});
const q = (name: string, checkSha256: string) => [{ name, checkSha256 }];
const NONE = { certified: false, reason: 'no-result', recordId: null, result: null };

describe('certifyChecks', () => {
  it('certifies a passing result under the queried digest with that record and element', () => {
    const r = res('x', 'd1');
    expect(certifyChecks([ev(rec([r]), { id: 'r1' })], 'epic-1', H, q('x', 'd1'))).toEqual([
      { certified: true, reason: null, recordId: 'r1', result: r },
    ]);
  });

  it('answers per query, in the queries order', () => {
    const events = [ev(rec([res('x', 'd1'), res('y', 'd2', { pass: false })]), { id: 'r1' })];
    const out = certifyChecks(events, 'epic-1', H, [
      { name: 'y', checkSha256: 'd2' },
      { name: 'x', checkSha256: 'd1' },
    ]);
    expect(out.map((c) => [c.certified, c.reason])).toEqual([
      [false, 'failed'],
      [true, null],
    ]);
  });

  it('keeps a result certified when a later record names other checks only', () => {
    const r = res('pre', 'd1');
    const events = [
      ev(rec([r, res('post', 'd2')]), { id: 'all' }),
      ev(rec([res('post', 'd2')]), { id: 'post-only' }),
    ];
    expect(certifyChecks(events, 'epic-1', H, q('pre', 'd1'))).toEqual([
      { certified: true, reason: null, recordId: 'all', result: r },
    ]);
  });

  it('lets the last result decide, by position and never by ts', () => {
    const pass = res('x', 'd1');
    const fail = res('x', 'd1', { pass: false });
    const early = '2026-01-01T00:00:01.000Z';
    const late = '2026-01-01T00:00:09.000Z';
    const passThenFail = [
      ev(rec([pass]), { id: 'p', ts: late }),
      ev(rec([fail]), { id: 'f', ts: early }),
    ];
    expect(certifyChecks(passThenFail, 'epic-1', H, q('x', 'd1'))).toEqual([
      { certified: false, reason: 'failed', recordId: 'f', result: fail },
    ]);
    const failThenPass = [
      ev(rec([fail]), { id: 'f', ts: late }),
      ev(rec([pass]), { id: 'p', ts: early }),
    ];
    expect(certifyChecks(failThenPass, 'epic-1', H, q('x', 'd1'))).toEqual([
      { certified: true, reason: null, recordId: 'p', result: pass },
    ]);
    const sameRecord = [ev(rec([pass, fail]), { id: 'one' })];
    expect(certifyChecks(sameRecord, 'epic-1', H, q('x', 'd1'))[0]?.reason).toBe('failed');
  });

  it('reads a lock-wait timeout, and a pass named in not_run, as not-run', () => {
    const timeout = res('x', 'd1', { pass: false, reason: 'heavy.wait-timeout' });
    expect(certifyChecks([ev(rec([timeout]), { id: 't' })], 'epic-1', H, q('x', 'd1'))).toEqual([
      { certified: false, reason: 'not-run', recordId: 't', result: timeout },
    ]);
    const passed = res('x', 'd1');
    expect(
      certifyChecks(
        [ev(rec([passed], { not_run: ['x'] }), { id: 'n' })],
        'epic-1',
        H,
        q('x', 'd1'),
      ),
    ).toEqual([{ certified: false, reason: 'not-run', recordId: 'n', result: passed }]);
  });

  it('reports changed for another digest, and no-result for the rest', () => {
    expect(certifyChecks([ev(rec([res('x', 'old')]))], 'epic-1', H, q('x', 'd1'))).toEqual([
      { certified: false, reason: 'changed', recordId: null, result: null },
    ]);
    expect(certifyChecks([ev(rec([res('x', undefined)]))], 'epic-1', H, q('x', 'd1'))).toEqual([
      NONE,
    ]);
    expect(
      certifyChecks([ev(rec([res('x', 'd1')], { head_sha: OTHER }))], 'epic-1', H, q('x', 'd1')),
    ).toEqual([NONE]);
    expect(
      certifyChecks([ev(rec([res('x', 'd1')], { epic_id: 'other' }))], 'epic-1', H, q('x', 'd1')),
    ).toEqual([NONE]);
    expect(certifyChecks([], 'epic-1', H, q('x', 'd1'))).toEqual([NONE]);
  });

  it('never lets a probe certify, whatever its probe_of holds', () => {
    for (const probe_of of ['run-1', 7]) {
      const events = [ev(rec([res('x', 'd1')], { probe_of }))];
      expect(certifyChecks(events, 'epic-1', H, q('x', 'd1'))).toEqual([NONE]);
    }
  });

  it('withholds on malformed evidence and never grants', () => {
    const cases: Record<string, StoredEvent> = {
      'results is not an array': ev(rec('nope')),
      'results is an object': ev(rec(res('x', 'd1'))),
      'head_sha is a number': ev(rec([res('x', 'd1')], { head_sha: 5 })),
      'element is null': ev(rec([null])),
      'name is a number': ev(rec([res('x', 'd1', { name: 5 })])),
    };
    for (const [name, event] of Object.entries(cases)) {
      expect(certifyChecks([event], 'epic-1', H, q('x', 'd1')), name).toEqual([NONE]);
    }
    const stringPass = res('x', 'd1', { pass: 'true' });
    expect(certifyChecks([ev(rec([stringPass]), { id: 's' })], 'epic-1', H, q('x', 'd1'))).toEqual([
      { certified: false, reason: 'failed', recordId: 's', result: stringPass },
    ]);
    const numericSha = res('x', 5 as unknown as string);
    expect(certifyChecks([ev(rec([numericSha]))], 'epic-1', H, q('x', 'd1'))).toEqual([NONE]);
  });

  it('returns an empty list for no queries', () => {
    expect(certifyChecks([ev(rec([res('x', 'd1')]))], 'epic-1', H, [])).toEqual([]);
  });
});

describe('latestIntegrationCheckAt and lastTieredRecordId', () => {
  const full = (id: string, over: Record<string, unknown> = {}) =>
    ev(rec([res('x', 'd1')], over), { id });

  it('returns the last non-probe record at the commit, projected like latestIntegrationCheck', () => {
    const events = [
      full('a'),
      full('b'),
      full('probe', { probe_of: 'r' }),
      full('elsewhere', { head_sha: OTHER }),
      ev({ epic_id: 'epic-1', head_sha: H }, { id: 'review', type: SPEC_REVIEW_EVENT }),
    ];
    const at = latestIntegrationCheckAt(events, 'epic-1', H);
    expect(at?.eventId).toBe('b');
    expect(Object.keys(at ?? {}).sort()).toEqual(
      ['branch', 'epicId', 'eventId', 'headSha', 'pass', 'results', 'ts'].sort(),
    );
    expect(at).toEqual({ ...latestIntegrationCheck([events[1] as StoredEvent], 'epic-1') });
    expect(latestIntegrationCheckAt(events, 'epic-1', 'c'.repeat(40))).toBeNull();
    expect(latestIntegrationCheckAt(events, 'other', H)).toBeNull();
  });

  it('leaves latestIntegrationCheck as main has it, on a mixed log', () => {
    const events = [
      ev({ epic_id: 'epic-1', head_sha: H, pass: true }, { id: 'old' }),
      full('new', { tiers: ['post-merge'] }),
      full('probe', { probe_of: 'r' }),
    ];
    expect(latestIntegrationCheck(events, 'epic-1')?.eventId).toBe('probe');
    expect(latestIntegrationCheck(events.slice(0, 1), 'epic-1')).toMatchObject({
      eventId: 'old',
      branch: '',
      results: [],
    });
  });

  it('finds no tiered record in a log written before tiers or for an unlabelled project', () => {
    const events = [
      full('old'),
      full('unlabelled', { tiers: ['pre-merge'], tiers_present: ['pre-merge'] }),
    ];
    expect(lastTieredRecordId(events, 'epic-1')).toBeNull();
    expect(lastTieredRecordId([], 'epic-1')).toBeNull();
  });

  it('names the last record that uses tiers, failing closed on a malformed one', () => {
    const base = full('base', { tiers_present: ['pre-merge'], tiers: ['pre-merge'] });
    const uses: Record<string, Record<string, unknown>> = {
      post: { tiers_present: ['pre-merge', 'post-merge'], tiers: ['pre-merge'] },
      release: { tiers_present: ['pre-merge', 'pre-release'] },
      probe: { probe_of: 'r', tiers_present: ['pre-merge'], tiers: ['pre-merge'] },
      string: { tiers_present: 'post-merge' },
      empty: { tiers_present: [] },
      unknown: { tiers: ['nightly'] },
    };
    for (const [id, over] of Object.entries(uses)) {
      expect(lastTieredRecordId([full(id, over), base], 'epic-1'), id).toBe(id);
    }
  });

  it('reads no other event type and no other epic', () => {
    const events = [
      full('mine', { tiers_present: ['post-merge'] }),
      ev(
        { epic_id: 'epic-1', head_sha: H, tiers_present: ['post-merge'] },
        { id: 'review', type: SPEC_REVIEW_EVENT },
      ),
      ev(rec([], { epic_id: 'other', tiers_present: ['post-merge'] }), { id: 'theirs' }),
    ];
    expect(lastTieredRecordId(events, 'epic-1')).toBe('mine');
    expect(latestIntegrationCheckAt(events, 'epic-1', H)?.eventId).toBe('mine');
  });
});
