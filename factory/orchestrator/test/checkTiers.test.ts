import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmithError } from '../src/errors.js';
import { withHeavyLock } from '../src/heavyLock.js';
import {
  assertCheckTier,
  CHECK_TIERS,
  type CheckCommand,
  checkDigest,
  checkTier,
  commandDigest,
  declaresLaterTier,
  isHeavyCheck,
  isNotRun,
  run,
  selectGateChecks,
  selectTier,
} from '../src/testgate.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('assertCheckTier', () => {
  it('accepts each of the three tiers and an absent tier', () => {
    for (const tier of CHECK_TIERS) {
      expect(() => assertCheckTier({ name: 'a', cmd: 'true', tier }, 'c.json')).not.toThrow();
    }
    expect(() => assertCheckTier({ name: 'a', cmd: 'true' }, 'c.json')).not.toThrow();
  });

  it('lists the tiers in order', () => {
    expect(CHECK_TIERS).toEqual(['pre-merge', 'post-merge', 'pre-release']);
  });

  it.each([['post_merge'], ['Pre-merge'], [''], [null], [1], [true]])(
    'refuses %j with gate.invalid-check-tier naming the entry and the file',
    (tier) => {
      let caught: unknown;
      try {
        assertCheckTier({ name: 'e2e', cmd: 'true', tier } as unknown as CheckCommand, 'my.json');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SmithError);
      expect((caught as SmithError).code).toBe('gate.invalid-check-tier');
      expect((caught as SmithError).message).toContain('"e2e"');
      expect((caught as SmithError).message).toContain('my.json');
    },
  );

  it('coexists with heavy and timeout_ms on one entry', () => {
    const entry: CheckCommand = {
      name: 'e2e',
      cmd: 'true',
      heavy: true,
      tier: 'post-merge',
      timeout_ms: 600000,
    };
    expect(() => assertCheckTier(entry, 'c.json')).not.toThrow();
    expect(isHeavyCheck(entry)).toBe(true);
  });
});

describe('tier selection', () => {
  const a: CheckCommand = { name: 'a', cmd: 'true' };
  const b: CheckCommand = { name: 'b', cmd: 'true', tier: 'post-merge' };
  const c: CheckCommand = { name: 'c', cmd: 'true', tier: 'pre-release' };
  const d: CheckCommand = { name: 'd', cmd: 'true', tier: 'pre-merge' };

  it('reads an absent tier as pre-merge', () => {
    expect(checkTier(a)).toBe('pre-merge');
    expect(checkTier(b)).toBe('post-merge');
  });

  it('keeps file order', () => {
    expect(selectTier([a, b, c, d], 'pre-merge').map((x) => x.name)).toEqual(['a', 'd']);
    expect(selectTier([d, c, b, a], 'pre-merge').map((x) => x.name)).toEqual(['d', 'a']);
    expect(selectTier([a, b, c, d], 'post-merge').map((x) => x.name)).toEqual(['b']);
  });

  it('declaresLaterTier is false for an unlabelled file and for an empty one', () => {
    expect(declaresLaterTier([a, d])).toBe(false);
    expect(declaresLaterTier([])).toBe(false);
    expect(declaresLaterTier([a, b])).toBe(true);
    expect(declaresLaterTier([c])).toBe(true);
  });

  it('selectGateChecks returns the pre-merge entries and the deferred ones in file order', () => {
    const { selected, deferred } = selectGateChecks([a, b, c, d], ['coverage']);
    expect(selected.map((x) => x.name)).toEqual(['a', 'd']);
    expect(deferred).toEqual([
      { name: 'b', tier: 'post-merge', tier_source: 'default' },
      { name: 'c', tier: 'pre-release', tier_source: 'default' },
    ]);
  });

  it('selectGateChecks reports the tier source the file reader set', () => {
    const { deferred } = selectGateChecks([a, { ...b, tierSource: 'declared' }], []);
    expect(deferred).toEqual([{ name: 'b', tier: 'post-merge', tier_source: 'declared' }]);
  });

  it('selectGateChecks returns both empty for an empty file (D10)', () => {
    expect(selectGateChecks([], ['coverage'])).toEqual({ selected: [], deferred: [] });
  });

  it('selectGateChecks refuses a non-empty file with no pre-merge entry', () => {
    expect(() => selectGateChecks([b, c], [])).toThrowError(
      expect.objectContaining({ code: 'gate.no-pre-merge-checks' }),
    );
  });

  it('selectGateChecks refuses a stage-bound check whose tier is later', () => {
    const coverage: CheckCommand = { name: 'coverage', cmd: 'true', tier: 'post-merge' };
    let caught: unknown;
    try {
      selectGateChecks([a, coverage], ['coverage']);
    } catch (err) {
      caught = err;
    }
    expect((caught as SmithError).code).toBe('gate.stage-check-deferred');
    expect((caught as SmithError).message).toContain('coverage');
  });

  it('selectGateChecks accepts a stage-bound check that stays pre-merge', () => {
    const coverage: CheckCommand = { name: 'coverage', cmd: 'true' };
    expect(selectGateChecks([coverage, b], ['coverage']).selected).toEqual([coverage]);
  });
});

describe('digests', () => {
  it('commandDigest is sha256 of the raw command', () => {
    expect(commandDigest('pnpm test')).toBe(sha('pnpm test'));
  });

  it('stamps cmd_sha256 and check_sha256 on every result, and distinguishes commands', async () => {
    const checks: CheckCommand[] = [
      { name: 'same', cmd: 'true', heavy: false },
      { name: 'same', cmd: 'true && true', heavy: false },
    ];
    const { results } = await run(checks, { cwd: process.cwd(), runAll: true });
    expect(results.map((r) => r.cmd_sha256)).toEqual(checks.map((c) => commandDigest(c.cmd)));
    expect(results.map((r) => r.check_sha256)).toEqual(checks.map((c) => checkDigest(c)));
    expect(results[0]?.cmd_sha256).not.toBe(results[1]?.cmd_sha256);
  });

  it('checkDigest follows command, heavy and timeout, never tier', () => {
    const base: CheckCommand = { name: 'x', cmd: 'true', heavy: false, timeout_ms: 1000 };
    const digest = checkDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(checkDigest({ ...base, cmd: 'false' })).not.toBe(digest);
    expect(checkDigest({ ...base, heavy: true })).not.toBe(digest);
    expect(checkDigest({ ...base, timeout_ms: 2000 })).not.toBe(digest);
    expect(checkDigest({ ...base, name: 'y' })).not.toBe(digest);
    expect(checkDigest({ ...base, tier: 'post-merge' })).toBe(digest);
    expect(checkDigest({ ...base, tierSource: 'declared' })).toBe(digest);
  });
});

describe('isNotRun', () => {
  let lockDir: string;
  beforeEach(() => {
    lockDir = mkdtempSync(path.join(tmpdir(), 'tiers-heavy-'));
  });
  afterEach(async () => {
    await rm(lockDir, { recursive: true, force: true });
  });

  it('is true for a lock-wait timeout and false for a check that ran and failed', async () => {
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
    try {
      const timedOut = await run([{ name: 'unit', cmd: 'true', heavy: true }], {
        cwd: process.cwd(),
        heavyLock: { lockDir, pollMs: 5, maxWaitMs: 1 },
      });
      expect(timedOut.results[0]?.reason).toBe('heavy.wait-timeout');
      expect(isNotRun(timedOut.results[0] as never)).toBe(true);
    } finally {
      release();
      await done;
    }
    const failed = await run([{ name: 'bad', cmd: 'exit 1', heavy: false }], {
      cwd: process.cwd(),
    });
    expect(failed.results[0]?.exitCode).toBe(1);
    expect(isNotRun(failed.results[0] as never)).toBe(false);
  });
});
