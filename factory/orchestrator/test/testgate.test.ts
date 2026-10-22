import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHeavyLock, withHeavyLock } from '../src/heavyLock.js';
import {
  heavyChildEnv,
  isHeavyCheck,
  maskCommandCredentials,
  run,
  runCumulative,
} from '../src/testgate.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe('testgate.ts', () => {
  it("runs a check without the factory's own SMITH_ variables", async () => {
    // Same rule as the merge queue: a check command is the project's, so the
    // factory's own namespace must not decide its verdict. Without the strip
    // `SMITH_HOME` reaches the child and moves WORK_ROOT off the worktree.
    const before = process.env.SMITH_HOME;
    process.env.SMITH_HOME = tmpdir();
    try {
      const result = await run(
        [{ name: 'env', cmd: '! env | grep -q "^SMITH_" && test -n "$PATH"' }],
        {
          cwd: process.cwd(),
        },
      );
      expect(result.pass).toBe(true);
    } finally {
      if (before === undefined) delete process.env.SMITH_HOME;
      else process.env.SMITH_HOME = before;
    }
  });

  it("runs a check without the factory's own BS_ variables", async () => {
    // Same strip, current name: `BS_HOME` is exactly as much the factory's
    // own namespace as `SMITH_HOME` was, and letting it through would move
    // WORK_ROOT off the worktree the same way.
    const before = process.env.BS_HOME;
    process.env.BS_HOME = tmpdir();
    try {
      const result = await run(
        [{ name: 'env', cmd: '! env | grep -q "^BS_" && test -n "$PATH"' }],
        {
          cwd: process.cwd(),
        },
      );
      expect(result.pass).toBe(true);
    } finally {
      if (before === undefined) delete process.env.BS_HOME;
      else process.env.BS_HOME = before;
    }
  });

  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'smith-testgate-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports a passing command with exitCode 0', async () => {
    const result = await run([{ name: 'ok', cmd: 'true' }], { cwd });
    expect(result.pass).toBe(true);
    expect(result.results).toEqual([
      { name: 'ok', pass: true, exitCode: 0, tail: '', lock_wait_ms: 0 },
    ]);
  });

  it('reports a failing command with a non-zero exitCode', async () => {
    const result = await run([{ name: 'bad', cmd: 'false' }], { cwd });
    expect(result.pass).toBe(false);
    expect(result.results[0]).toMatchObject({ name: 'bad', pass: false });
    expect(result.results[0]?.exitCode).not.toBe(0);
  });

  it('names the signal when a check crashes instead of failing (D-47)', async () => {
    // A check that dies by signal produced "exitCode 139, empty tail" — which
    // reads as "the tests failed" and sends the reader to the wrong subsystem.
    // The tail has to say the process was killed, and by what.
    const result = await run(
      [{ name: 'crasher', cmd: `${process.execPath} -e "process.kill(process.pid, 'SIGSEGV')"` }],
      { cwd },
    );
    expect(result.pass).toBe(false);
    expect(result.results[0]?.exitCode).not.toBe(0);
    expect(result.results[0]?.tail).toContain('SIGSEGV');
    expect(result.results[0]?.tail).toMatch(/killed|crash/i);
  });

  it('decodes a shell-reported 128+N exit into the signal it stands for', async () => {
    // When the shell does not exec the command in place, a signalled
    // grandchild reaches us as exit code 139, not as a signal. Same crash,
    // different shape — it has to read the same way.
    const result = await run([{ name: 'shell-reported', cmd: 'exit 139' }], { cwd });
    expect(result.results[0]?.exitCode).toBe(139);
    expect(result.results[0]?.tail).toContain('SIGSEGV');
    expect(result.results[0]?.tail).toContain('128+11');
  });

  it('leaves a 128+N code alone when N is not a known signal', async () => {
    const result = await run([{ name: 'odd', cmd: 'exit 190' }], { cwd });
    expect(result.results[0]?.exitCode).toBe(190);
    expect(result.results[0]?.tail).toBe('');
  });

  it('leaves an ordinary non-zero exit unannotated', async () => {
    const result = await run([{ name: 'plain', cmd: 'exit 2' }], { cwd });
    expect(result.results[0]?.exitCode).toBe(2);
    expect(result.results[0]?.tail).toBe('');
  });

  it('short-circuits after the first failure by default', async () => {
    const result = await run(
      [
        { name: 'first', cmd: 'false' },
        { name: 'second', cmd: 'true' },
      ],
      { cwd },
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.name).toBe('first');
    expect(result.pass).toBe(false);
  });

  it('runs every check when runAll is set, even after a failure', async () => {
    const result = await run(
      [
        { name: 'first', cmd: 'false' },
        { name: 'second', cmd: 'true' },
      ],
      { cwd, runAll: true },
    );
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.name)).toEqual(['first', 'second']);
    expect(result.pass).toBe(false);
  });

  it('passes when every check passes', async () => {
    const result = await run(
      [
        { name: 'a', cmd: 'true' },
        { name: 'b', cmd: 'true' },
      ],
      { cwd },
    );
    expect(result.pass).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it('kills a command that exceeds its per-command timeout and marks it failed', async () => {
    const result = await run([{ name: 'slow', cmd: 'sleep 5' }], { cwd, timeoutMs: 100 });
    expect(result.pass).toBe(false);
    expect(result.results[0]?.pass).toBe(false);
    expect(result.results[0]?.exitCode).toBe(-1);
  });

  it('kills the WHOLE process group on timeout, not just the immediate shell child', async () => {
    // Regression: execFileSync's built-in timeout only killed the sh child;
    // a grandchild backgrounded by the shell survived as an orphan
    // (reproduced manually — needed a manual kill -9 to clean up).
    const pidFile = path.join(cwd, 'grandchild.pid');
    const cmd = `sleep 30 & echo $! > "${pidFile}"; wait`;

    const result = await run([{ name: 'spawns-grandchild', cmd }], { cwd, timeoutMs: 200 });
    expect(result.pass).toBe(false);

    const grandchildPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    expect(Number.isNaN(grandchildPid)).toBe(false);

    const died = await waitUntil(async () => !processAlive(grandchildPid), 2000);
    expect(died).toBe(true);
  });

  it('captures only the last 50 lines of output in the tail', async () => {
    const cmd = 'for i in $(seq 1 80); do echo "line $i"; done';
    const result = await run([{ name: 'many-lines', cmd }], { cwd });
    expect(result.pass).toBe(true);
    const tailLines = result.results[0]?.tail.split('\n') ?? [];
    expect(tailLines.length).toBeLessThanOrEqual(50);
    expect(tailLines.at(-1)).toBe('line 80');
  });

  // The line bound is the only bound there is, and a bound on lines is not a
  // bound on size: a check that writes one enormous line without a newline is
  // one "line", so the tail returned it whole. Measured before the fix, a check
  // writing 5 MiB with no newline came back with a 5,242,880-byte `tail` from a
  // field documented as "Last 50 lines" — and every byte of it went into the
  // `testgate-result` event, which is append-only (D-189).
  const FLOOD = 'node -e "process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 65))"';
  const FLOOD_THEN_MARK =
    'node -e "process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 65)); process.stdout.write(Buffer.alloc(8, 90))"';

  it('bounds the tail of a check that writes one enormous line', async () => {
    const result = await run([{ name: 'flood', cmd: FLOOD }], { cwd, timeoutMs: 60_000 });
    expect(result.pass).toBe(true);
    expect(result.results[0]?.tail.length).toBeLessThan(200_000);
  });

  it('says it dropped output rather than passing a fragment off as the whole', async () => {
    const result = await run([{ name: 'flood', cmd: FLOOD }], { cwd, timeoutMs: 60_000 });
    expect(result.results[0]?.tail).toContain('[testgate] earlier output dropped');
  });

  it('keeps the END of a flooded stream, which is what a tail is for', async () => {
    const result = await run([{ name: 'flood', cmd: FLOOD_THEN_MARK }], { cwd, timeoutMs: 60_000 });
    expect(result.results[0]?.tail.endsWith('ZZZZZZZZ')).toBe(true);
  });

  it('leaves output that fits alone, unmarked', async () => {
    const result = await run([{ name: 'small', cmd: 'echo hello' }], { cwd });
    expect(result.results[0]?.tail).toBe('hello');
  });

  it('keeps the timeout note visible even when the check flooded its output', async () => {
    const cmd = 'node -e "setInterval(() => process.stdout.write(Buffer.alloc(65536, 65)), 1)"';
    const result = await run([{ name: 'noisy-hang', cmd }], { cwd, timeoutMs: 300 });
    expect(result.results[0]?.pass).toBe(false);
    expect(result.results[0]?.tail).toContain('timed out after 300ms');
    expect(result.results[0]?.tail.length).toBeLessThan(200_000);
  });

  it("honors a check's own timeout_ms over the run-level default, naming it in the note", async () => {
    // This repo's own full suite runs long enough on a loaded machine to trip
    // the shared 5-minute default (the bug this field exists to work around),
    // so a single slow check needs a bigger number without moving every other
    // check in the same file.
    const result = await run([{ name: 'slow', cmd: 'sleep 5', timeout_ms: 200 }], { cwd });
    expect(result.pass).toBe(false);
    expect(result.results[0]?.exitCode).toBe(-1);
    expect(result.results[0]?.tail).toContain('timed out after 200ms');
  });

  it('leaves a sibling check with no timeout_ms on the shared run-level default', async () => {
    const result = await run(
      [
        { name: 'short-timeout', cmd: 'sleep 5', timeout_ms: 150 },
        { name: 'no-override', cmd: 'sleep 0.3' },
      ],
      { cwd, timeoutMs: 5000, runAll: true },
    );
    expect(result.results[0]?.pass).toBe(false);
    expect(result.results[0]?.tail).toContain('timed out after 150ms');
    expect(result.results[1]?.pass).toBe(true);
    expect(result.results[1]?.exitCode).toBe(0);
  });

  it('an empty check list trivially passes', async () => {
    const result = await run([], { cwd });
    expect(result.pass).toBe(true);
    expect(result.results).toEqual([]);
  });

  describe('runCumulative', () => {
    it('wraps the epic test command as a single named check', async () => {
      const result = await runCumulative('true', { cwd });
      expect(result.pass).toBe(true);
      expect(result.results).toMatchObject([
        { name: 'cumulative', pass: true, exitCode: 0, tail: '' },
      ]);
    });

    it('fails when the epic test command fails', async () => {
      const result = await runCumulative('false', { cwd });
      expect(result.pass).toBe(false);
    });
  });
});

// A declared check command is stored beside its result, and that record goes to
// the event log, the CLI's JSON and an external judge provider. A project may
// state env inside the command string (projectCommandEnv's doc says so), so the
// value of anything that looks like a credential is masked before it is stored.
describe('testgate.ts maskCommandCredentials', () => {
  it('masks the password in a URL, keeping the rest of the command', () => {
    expect(maskCommandCredentials('DATABASE_URL=postgres://ci:pw@db/app pnpm test')).toBe(
      'DATABASE_URL=postgres://ci:***@db/app pnpm test',
    );
  });

  it('masks the value of a sensitive env assignment, unquoted or quoted', () => {
    expect(maskCommandCredentials('API_TOKEN=abc123 npm run e2e')).toBe(
      'API_TOKEN=*** npm run e2e',
    );
    expect(maskCommandCredentials(`SECRET_KEY='a b c' npm test`)).toBe('SECRET_KEY=*** npm test');
    expect(maskCommandCredentials('DB_PASSWORD="p w" npm test')).toBe('DB_PASSWORD=*** npm test');
    expect(maskCommandCredentials('export github_auth=xyz && npm test')).toBe(
      'export github_auth=*** && npm test',
    );
    expect(maskCommandCredentials('CI=1 PGPWD=x NODE_ENV=test npm test')).toBe(
      'CI=1 PGPWD=*** NODE_ENV=test npm test',
    );
  });

  it('masks the value of a sensitive long flag, in both forms', () => {
    expect(maskCommandCredentials('npm run e2e -- --token=abc123')).toBe(
      'npm run e2e -- --token=***',
    );
    expect(maskCommandCredentials('deploy --password abc123 --dry-run')).toBe(
      'deploy --password *** --dry-run',
    );
    expect(maskCommandCredentials('cli --api-key "a b" --record')).toBe(
      'cli --api-key *** --record',
    );
  });

  it('never takes a following flag or shell operator as the value of a bare flag', () => {
    expect(maskCommandCredentials('pnpm test --no-auth && pnpm lint')).toBe(
      'pnpm test --no-auth && pnpm lint',
    );
    expect(maskCommandCredentials('cli --auth --verbose')).toBe('cli --auth --verbose');
  });

  it('leaves a command with nothing sensitive in it exactly as written', () => {
    for (const cmd of [
      'pnpm test',
      'npm run build -- --filter x',
      'NODE_ENV=test vitest run --reporter=verbose',
      'echo hi && true',
    ]) {
      expect(maskCommandCredentials(cmd)).toBe(cmd);
    }
  });
});

describe('testgate.ts heavy lock', () => {
  let lockDir: string;
  beforeEach(() => {
    lockDir = mkdtempSync(path.join(tmpdir(), 'gate-heavy-'));
  });
  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });
  const heavyLock = (): { lockDir: string; pollMs: number } => ({ lockDir, pollMs: 5 });

  /** Hold the lock until `release()` is called; resolves once it is held. */
  async function holder(): Promise<{ release: () => void; done: Promise<void> }> {
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const heldP = new Promise<void>((r) => {
      held = r;
    });
    const done = withHeavyLock(
      () => {
        held();
        return new Promise<void>((r) => {
          release = r;
        });
      },
      { lockDir, label: 'other', cwd: '/x', pollMs: 5 },
    );
    await heldP;
    return { release: () => release(), done };
  }

  it('isHeavyCheck: explicit flag wins, then the name rule', () => {
    expect(isHeavyCheck({ name: 'lint', heavy: true })).toBe(true);
    expect(isHeavyCheck({ name: 'test', heavy: false })).toBe(false);
    for (const name of ['test', 'unit', 'coverage', 'test-server-coverage', 'e2e-phone']) {
      expect(isHeavyCheck({ name })).toBe(true);
    }
    for (const name of ['lint', 'typecheck', 'typecheck:test']) {
      expect(isHeavyCheck({ name })).toBe(false);
    }
  });

  it('runs unmarked checks without waiting while another holder has the lock', async () => {
    const h = await holder();
    try {
      const result = await run(
        [
          { name: 'lint', cmd: 'true' },
          { name: 'typecheck', cmd: 'true' },
        ],
        { cwd: process.cwd(), heavyLock: heavyLock() },
      );
      expect(result.pass).toBe(true);
      expect(result.results.map((r) => r.lock_wait_ms)).toEqual([0, 0]);
    } finally {
      h.release();
      await h.done;
    }
  });

  it('runs [lint, test] in order: lint at once, test waits for the release', async () => {
    const h = await holder();
    const order: string[] = [];
    const running = run(
      [
        { name: 'lint', cmd: 'true' },
        { name: 'test', cmd: 'true' },
      ],
      { cwd: process.cwd(), heavyLock: heavyLock() },
    ).then((r) => {
      order.push('run-done');
      return r;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(order).toEqual([]);
    order.push('release');
    h.release();
    const result = await running;
    await h.done;
    expect(order).toEqual(['release', 'run-done']);
    expect(result.results[0]?.lock_wait_ms).toBe(0);
    expect(result.results[1]?.lock_wait_ms).toBeGreaterThan(50);
    expect(result.pass).toBe(true);
  });

  it('does not count the lock wait against timeout_ms', async () => {
    const h = await holder();
    const running = run([{ name: 'test', cmd: 'true', timeout_ms: 100 }], {
      cwd: process.cwd(),
      heavyLock: heavyLock(),
    });
    await new Promise((r) => setTimeout(r, 300));
    h.release();
    const result = await running;
    await h.done;
    expect(result.pass).toBe(true);
    expect(result.results[0]?.lock_wait_ms).toBeGreaterThan(100);
  });

  it('fails the check with heavy.wait-timeout and the holder detail', async () => {
    const h = await holder();
    try {
      const result = await run([{ name: 'test', cmd: 'true' }], {
        cwd: process.cwd(),
        heavyLock: { ...heavyLock(), maxWaitMs: 30 },
      });
      expect(result.pass).toBe(false);
      expect(result.results[0]?.reason).toBe('heavy.wait-timeout');
      expect(result.results[0]?.tail).toContain('other');
      expect(result.results[0]?.tail).toContain(path.join(lockDir, 'heavy.lock'));
    } finally {
      h.release();
      await h.done;
    }
  });

  it('gives a heavy child the lease and strips every other BS_/SMITH_ variable', async () => {
    process.env.BS_OTHER = '1';
    process.env.SMITH_OTHER = '1';
    try {
      const out = path.join(lockDir, 'seen.txt');
      const lockCopy = `${out}.lock`;
      const result = await run(
        [
          {
            name: 'test',
            cmd: `printf '%s|%s|%s|%s' "$BS_HEAVY_LOCK_TOKEN" "$BS_HEAVY_LOCK_DIR" "$BS_OTHER" "$SMITH_OTHER" > '${out}'; cp '${path.join(lockDir, 'heavy.lock')}' '${lockCopy}'`,
          },
        ],
        { cwd: process.cwd(), heavyLock: heavyLock() },
      );
      expect(result.pass).toBe(true);
      const lock = JSON.parse(await readFile(lockCopy, 'utf8')) as { token: string };
      expect(await readFile(out, 'utf8')).toBe(`${lock.token}|${lockDir}||`);
      expect(await readHeavyLock(lockDir)).toBeUndefined();
    } finally {
      delete process.env.BS_OTHER;
      delete process.env.SMITH_OTHER;
    }
  });

  it('heavyChildEnv adds exactly the two lease variables to the stripped env', () => {
    const env = heavyChildEnv(
      { PATH: '/bin', BS_HOME: '/h', SMITH_X: '1', BS_HEAVY_LOCK_TOKEN: 'old' },
      { token: 't', lockDir: '/d' },
    );
    expect(env).toEqual({ PATH: '/bin', BS_HEAVY_LOCK_TOKEN: 't', BS_HEAVY_LOCK_DIR: '/d' });
  });

  it('runs inside the suite on a temporary lock dir with no inherited token', () => {
    expect(process.env.BS_HEAVY_LOCK_TOKEN).toBeUndefined();
    const dir = process.env.BS_HEAVY_LOCK_DIR as string;
    expect(path.resolve(dir).startsWith(path.resolve(tmpdir()))).toBe(true);
  });

  it('runCumulative takes the lock', async () => {
    const out = path.join(lockDir, 'cum.lock');
    const result = await runCumulative(`cp '${path.join(lockDir, 'heavy.lock')}' '${out}'`, {
      cwd: process.cwd(),
      heavyLock: heavyLock(),
    });
    expect(result.pass).toBe(true);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ pid: process.pid });
  });
});
