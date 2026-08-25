import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, runCumulative } from '../src/testgate.js';

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
    expect(result.results).toEqual([{ name: 'ok', pass: true, exitCode: 0, tail: '' }]);
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

  it('an empty check list trivially passes', async () => {
    const result = await run([], { cwd });
    expect(result.pass).toBe(true);
    expect(result.results).toEqual([]);
  });

  describe('runCumulative', () => {
    it('wraps the epic test command as a single named check', async () => {
      const result = await runCumulative('true', { cwd });
      expect(result.pass).toBe(true);
      expect(result.results).toEqual([{ name: 'cumulative', pass: true, exitCode: 0, tail: '' }]);
    });

    it('fails when the epic test command fails', async () => {
      const result = await runCumulative('false', { cwd });
      expect(result.pass).toBe(false);
    });
  });
});
