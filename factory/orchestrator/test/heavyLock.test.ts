import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmithError } from '../src/errors.js';
import {
  type HeavyLockRecord,
  pidIsAlive,
  readHeavyLock,
  resolveHeavyLockDir,
  withHeavyLock,
} from '../src/heavyLock.js';
import { heavyChildEnv } from '../src/testgate.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heavylock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lockFile = (): string => path.join(dir, 'heavy.lock');
const base = { label: 'test', cwd: '/work', pollMs: 5 };

function plant(over: Partial<HeavyLockRecord> = {}): HeavyLockRecord {
  const record: HeavyLockRecord = {
    pid: 4242,
    token: 'other-token',
    label: 'other',
    startedAt: '2020-01-01T00:00:00.000Z',
    cwd: '/elsewhere',
    ...over,
  };
  writeFileSync(lockFile(), JSON.stringify(record));
  return record;
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

describe('pidIsAlive', () => {
  it('reads no throw, EPERM and unknown codes as alive and only ESRCH as dead', () => {
    expect(pidIsAlive(1, () => true)).toBe(true);
    expect(
      pidIsAlive(1, () => {
        throw errno('EPERM');
      }),
    ).toBe(true);
    expect(
      pidIsAlive(1, () => {
        throw errno('EWEIRD');
      }),
    ).toBe(true);
    expect(
      pidIsAlive(1, () => {
        throw errno('ESRCH');
      }),
    ).toBe(false);
  });
});

describe('withHeavyLock', () => {
  it('never overlaps two concurrent holders', async () => {
    const intervals: Array<[number, number]> = [];
    const hold = (): Promise<void> =>
      withHeavyLock(
        async () => {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 40));
          intervals.push([start, Date.now()]);
        },
        { ...base, lockDir: dir },
      );
    await Promise.all([hold(), hold(), hold()]);
    expect(intervals).toHaveLength(3);
    intervals.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < intervals.length; i++) {
      expect((intervals[i] as [number, number])[0]).toBeGreaterThanOrEqual(
        (intervals[i - 1] as [number, number])[1],
      );
    }
  });

  it('reclaims a lock whose pid is dead', async () => {
    plant();
    let ran = false;
    await withHeavyLock(
      () => {
        ran = true;
      },
      { ...base, lockDir: dir, isPidAlive: () => false },
    );
    expect(ran).toBe(true);
  });

  it('keeps a lock whose probe throws EPERM and reclaims one whose probe throws ESRCH', async () => {
    plant();
    const probe = (code: string) => (pid: number) =>
      pidIsAlive(pid, () => {
        throw errno(code);
      });
    let ran = false;
    await expect(
      withHeavyLock(
        () => {
          ran = true;
        },
        { ...base, lockDir: dir, maxWaitMs: 30, isPidAlive: probe('EPERM') },
      ),
    ).rejects.toMatchObject({ code: 'heavy.wait-timeout' });
    expect(ran).toBe(false);
    expect((await readHeavyLock(dir)) as HeavyLockRecord).toMatchObject({ token: 'other-token' });

    await withHeavyLock(
      () => {
        ran = true;
      },
      { ...base, lockDir: dir, isPidAlive: probe('ESRCH') },
    );
    expect(ran).toBe(true);
  });

  it('never steals a live pid however old, and the timeout names holder and lock path', async () => {
    plant({ startedAt: '1999-01-01T00:00:00.000Z', pid: 4243, label: 'old-holder' });
    let ran = false;
    const err = await withHeavyLock(
      () => {
        ran = true;
      },
      { ...base, lockDir: dir, maxWaitMs: 30, isPidAlive: () => true },
    ).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(err).toBeInstanceOf(SmithError);
    const e = err as SmithError;
    expect(e.code).toBe('heavy.wait-timeout');
    for (const part of ['4243', 'old-holder', '/elsewhere', '1999-01-01', lockFile()]) {
      expect(e.message).toContain(part);
    }
  });

  it('reclaims an empty or unparseable lock file, reported corrupt before', async () => {
    writeFileSync(lockFile(), '');
    expect(await readHeavyLock(dir)).toEqual({ corrupt: true });
    writeFileSync(lockFile(), '{not json');
    expect(await readHeavyLock(dir)).toEqual({ corrupt: true });
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: -1, token: 't', label: 'l', startedAt: 's', cwd: 'c' }),
    );
    expect(await readHeavyLock(dir)).toEqual({ corrupt: true });
    let ran = false;
    await withHeavyLock(
      () => {
        ran = true;
      },
      { ...base, lockDir: dir, isPidAlive: () => true },
    );
    expect(ran).toBe(true);
  });

  it('never lets two waiters racing to reclaim one dead lock run at once', async () => {
    plant();
    let active = 0;
    let maxActive = 0;
    const contender = (): Promise<void> =>
      withHeavyLock(
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
        },
        { ...base, lockDir: dir, pollMs: 1, isPidAlive: (pid) => pid === process.pid },
      );
    await Promise.all([contender(), contender(), contender(), contender()]);
    expect(maxActive).toBe(1);
  });

  it('runs a nested call carrying the holder token without waiting', async () => {
    await withHeavyLock(
      async (lease) => {
        let ran = false;
        await withHeavyLock(
          () => {
            ran = true;
          },
          {
            ...base,
            lockDir: dir,
            maxWaitMs: 20,
            env: { BS_HEAVY_LOCK_TOKEN: lease.token },
          },
        );
        expect(ran).toBe(true);
        // The outer lock is still ours after the nested call.
        expect(await readHeavyLock(dir)).toMatchObject({ token: lease.token });
      },
      { ...base, lockDir: dir },
    );
    expect(await readHeavyLock(dir)).toBeUndefined();
  });

  it('waits when the token differs', async () => {
    await withHeavyLock(
      async () => {
        await expect(
          withHeavyLock(() => undefined, {
            ...base,
            lockDir: dir,
            maxWaitMs: 30,
            env: { BS_HEAVY_LOCK_TOKEN: 'someone-else' },
          }),
        ).rejects.toMatchObject({ code: 'heavy.wait-timeout' });
      },
      { ...base, lockDir: dir },
    );
  });

  it('re-enters from only the env heavyChildEnv built, under a non-default dir', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'heavyhome-'));
    try {
      await withHeavyLock(
        async (lease) => {
          const childEnv = heavyChildEnv({ PATH: '/bin', BS_OTHER: '1' }, lease);
          let ran = false;
          await withHeavyLock(
            () => {
              ran = true;
            },
            { ...base, maxWaitMs: 20, env: childEnv },
          );
          expect(ran).toBe(true);
        },
        { ...base, lockDir: dir },
      );
      expect(readdirSync(home)).toEqual([]);
      expect(resolveHeavyLockDir(undefined, { BS_HEAVY_LOCK_DIR: dir }, home)).toBe(dir);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('releases after fn throws', async () => {
    await expect(
      withHeavyLock(
        () => {
          throw new Error('boom');
        },
        { ...base, lockDir: dir },
      ),
    ).rejects.toThrow('boom');
    expect(await readHeavyLock(dir)).toBeUndefined();
  });

  it('does not remove a lock whose token is no longer ours', async () => {
    await withHeavyLock(
      () => {
        plant();
      },
      { ...base, lockDir: dir },
    );
    expect(await readHeavyLock(dir)).toMatchObject({ token: 'other-token' });
  });

  it('resolves the default dir from BS_HEAVY_LOCK_DIR, else <home>/.blacksmith/locks', () => {
    expect(resolveHeavyLockDir(undefined, { BS_HEAVY_LOCK_DIR: '/x/y' }, '/home/u')).toBe('/x/y');
    expect(resolveHeavyLockDir(undefined, {}, '/home/u')).toBe(
      path.join('/home/u', '.blacksmith', 'locks'),
    );
    expect(resolveHeavyLockDir('/explicit', { BS_HEAVY_LOCK_DIR: '/x/y' }, '/home/u')).toBe(
      '/explicit',
    );
  });

  it('reports pid, label, start time and cwd while held and undefined after release', async () => {
    mkdirSync(dir, { recursive: true });
    await withHeavyLock(
      async (lease) => {
        const held = (await readHeavyLock(dir)) as HeavyLockRecord;
        expect(held).toMatchObject({
          pid: process.pid,
          label: 'test',
          cwd: '/work',
          token: lease.token,
        });
        expect(Number.isNaN(Date.parse(held.startedAt))).toBe(false);
      },
      { ...base, lockDir: dir },
    );
    expect(await readHeavyLock(dir)).toBeUndefined();
  });
});
