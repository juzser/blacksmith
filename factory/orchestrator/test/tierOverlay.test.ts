import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import { type CheckCommand, commandDigest } from '../src/testgate.js';
import {
  OVERLAY_LOCK_WAIT_MS,
  type OverlayEntry,
  type OverlayState,
  overlayOwes,
  overlayPath,
  overlayReport,
  overlayWritable,
  readOverlay,
  reconcileOverlay,
  resolveEffectiveTiers,
  withOverlayLock,
  writeOverlay,
} from '../src/tierOverlay.js';

// Seams for the lock-breaking interleavings: a hook that runs inside the module's
// liveness probe, and one that runs right after one of its renames.
const seams = vi.hoisted(() => ({
  afterProbe: null as null | ((pid: number) => void),
  afterRename: null as null | (() => void),
  beforeLink: null as null | ((from: string, to: string) => void),
}));
vi.mock('../src/heavyLock.js', async (orig) => {
  const real = await orig<typeof import('../src/heavyLock.js')>();
  return {
    ...real,
    pidIsAlive: (pid: number): boolean => {
      const alive = real.pidIsAlive(pid);
      seams.afterProbe?.(pid);
      return alive;
    },
  };
});
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    linkSync: (from: string, to: string): void => {
      seams.beforeLink?.(from, to);
      real.linkSync(from, to);
    },
    renameSync: (from: string, to: string): void => {
      real.renameSync(from, to);
      seams.afterRename?.();
    },
  };
});

const roots: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'smith-overlay-')));
  roots.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(): string {
  const main = tmp();
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 't');
  writeFileSync(path.join(main, 'README.md'), 'x\n');
  writeFileSync(path.join(main, 'checks.json'), '[]\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  return main;
}

const overlayFile = (main: string): string => path.join(main, '.blacksmith', 'check-tiers.json');
const lockFile = (main: string): string => path.join(main, '.blacksmith', 'check-tiers.lock');
const gateFile = (main: string): string => `${lockFile(main)}.breaker`;
const CMD = 'pnpm run e2e';
const entry = (
  check: string,
  cmd = CMD,
  tier: OverlayEntry['tier'] = 'post-merge',
): OverlayEntry => ({
  check,
  cmd_sha256: commandDigest(cmd),
  tier,
  decided_by_event_id: 's#1',
  decided_at: '2026-10-31T00:00:00.000Z',
});
const state = (main: string): OverlayState => {
  const o = readOverlay(main);
  if (!('entries' in o)) throw new Error(`unreadable: ${o.unreadable}`);
  return o;
};
const rawOverlay = (main: string, doc: unknown): void => {
  mkdirSync(path.dirname(overlayFile(main)), { recursive: true });
  writeFileSync(overlayFile(main), typeof doc === 'string' ? doc : JSON.stringify(doc));
};
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  revision: 3,
  entries: [entry('e2e')],
  ...over,
});
const check = (name: string, cmd = CMD, tier?: CheckCommand['tier']): CheckCommand => ({
  name,
  cmd,
  ...(tier === undefined ? {} : { tier }),
});
const stored = (
  event_id: string,
  event_type: string,
  payload: Record<string, unknown>,
): StoredEvent => ({
  event_id,
  record: {
    session_id: 's',
    actor: 'operator',
    event_type,
    plan_version: 1,
    causal_parent: null,
    payload,
    ts: '2026-10-31T01:02:03.000Z',
  },
});
const decided = (id: string, name: string, to_tier: string, decision = 'approve'): StoredEvent =>
  stored(id, 'check-tier-decided', {
    check: name,
    cmd_sha256: commandDigest(CMD),
    to_tier,
    decision,
  });

afterEach(() => {
  vi.useRealTimers();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('location', () => {
  it('reads one overlay from a task worktree and from the main clone; none outside git', () => {
    const main = makeRepo();
    const wt = path.join(tmp(), 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'task', wt);
    expect(overlayPath(wt)).toBe(overlayFile(main));
    expect(overlayPath(main)).toBe(overlayFile(main));

    const plain = tmp();
    expect(overlayPath(plain)).toBeNull();
    const tiers = resolveEffectiveTiers([check('a'), check('b')], readOverlay(plain));
    expect(tiers.map((t) => [t.tier, t.tierSource])).toEqual([
      ['pre-merge', 'default'],
      ['pre-merge', 'default'],
    ]);
    expect(overlayWritable(plain)).toBe('not-a-repo');
    expect(() => writeOverlay(plain, { entries: [], expectedRevision: 0 })).toThrowError(
      expect.objectContaining({ code: 'checks.overlay-not-a-repo' }),
    );
  });
});

describe('validity', () => {
  const cases: [string, unknown, string][] = [
    ['a non-object', [], 'JSON object'],
    ['invalid JSON', '{nope', 'not valid JSON'],
    ['version 2', valid({ version: 2 }), 'version must be 1'],
    ['a negative revision', valid({ revision: -1 }), 'revision'],
    ['an empty check', valid({ entries: [{ ...entry('x'), check: '' }] }), 'check must be'],
    [
      'a 63-hex cmd_sha256',
      valid({ entries: [{ ...entry('x'), cmd_sha256: 'a'.repeat(63) }] }),
      'cmd_sha256',
    ],
    ['tier later', valid({ entries: [{ ...entry('x'), tier: 'later' }] }), 'tier must be'],
    ['an unknown key', valid({ extra: 1 }), 'unknown key "extra"'],
    [
      'an unknown entry key',
      valid({ entries: [{ ...entry('x'), extra: 1 }] }),
      'unknown key "extra"',
    ],
    [
      'a pending_event with another key',
      valid({
        entries: [
          {
            ...entry('x'),
            pending_event: { event_type: 'check-tier-promoted', payload: {}, x: 1 },
          },
        ],
      }),
      'pending_event has unknown key "x"',
    ],
    [
      'a pending_event of another type',
      valid({ entries: [{ ...entry('x'), pending_event: { event_type: 'other', payload: {} } }] }),
      'pending_event.event_type',
    ],
    [
      'a bad decided_at',
      valid({ entries: [{ ...entry('x'), decided_at: 'yesterday' }] }),
      'decided_at',
    ],
    ['a duplicate entry', valid({ entries: [entry('x'), entry('x')] }), 'repeats check "x"'],
  ];
  it.each(cases)('%s makes the overlay unreadable', (_name, doc, rule) => {
    const main = makeRepo();
    rawOverlay(main, doc);
    const read = readOverlay(main);
    expect(read).toHaveProperty('unreadable');
    expect((read as { unreadable: string }).unreadable).toContain(rule);
    expect(overlayWritable(main)).toBe('unreadable');
    const tiers = resolveEffectiveTiers([check('e2e')], read);
    expect(tiers[0]).toMatchObject({ tier: 'pre-merge', tierSource: 'default' });
  });

  it('reads a valid file back deep-equal, and an absent one as empty at revision 0', () => {
    const main = makeRepo();
    expect(readOverlay(main)).toEqual({ revision: 0, entries: [] });
    const full = {
      ...entry('e2e'),
      pending_event: { event_type: 'check-tier-promoted', payload: { check: 'e2e' } },
    };
    rawOverlay(main, valid({ entries: [full, entry('lint', 'pnpm lint', 'pre-release')] }));
    expect(readOverlay(main)).toEqual({
      revision: 3,
      entries: [full, entry('lint', 'pnpm lint', 'pre-release')],
    });
    expect(overlayWritable(main)).toBe('ok');
  });
});

describe('report precedence', () => {
  const overlay: OverlayState = { revision: 1, entries: [entry('e2e')] };
  const status = (checks: CheckCommand[]): string | undefined =>
    overlayReport(checks, overlay)[0]?.status;
  it('orders absent, shadowed, edited and active', () => {
    expect(status([check('other')])).toBe('orphaned');
    expect(status([check('e2e', CMD, 'post-merge')])).toBe('shadowed');
    expect(status([check('e2e', 'edited', 'pre-release')])).toBe('shadowed');
    expect(status([check('e2e', 'edited')])).toBe('orphaned');
    expect(status([check('e2e')])).toBe('active');
    expect(overlayReport([check('e2e')], { unreadable: 'x' })).toEqual([]);
  });
  it('gives an active entry its overlay tier, and a declared tier wins', () => {
    const [a] = resolveEffectiveTiers([check('e2e')], overlay);
    expect(a).toMatchObject({ tier: 'post-merge', tierSource: 'overlay' });
    const [d] = resolveEffectiveTiers([check('e2e', CMD, 'pre-release')], overlay);
    expect(d).toMatchObject({ tier: 'pre-release', tierSource: 'declared' });
    const [o] = resolveEffectiveTiers([check('e2e', 'edited')], overlay);
    expect(o).toMatchObject({ tier: 'pre-merge', tierSource: 'default' });
  });
});

describe('exclusion', () => {
  it('writes in a fresh repo without dirtying it or a tracked .gitignore', () => {
    const main = makeRepo();
    writeOverlay(main, { entries: [entry('e2e')], expectedRevision: 0 });
    expect(git(main, 'status', '--porcelain')).toBe('');
    const exclude = readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.includes('check-tiers'))).toHaveLength(1);
    expect(existsSync(path.join(main, '.gitignore'))).toBe(false);
    expect(state(main).revision).toBe(1);
    writeOverlay(main, { entries: [], expectedRevision: 1 });
    expect(readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8')).toBe(exclude);
  });

  it('keeps the lock, breaker gate, temp and tomb files bs leaves in .blacksmith out of git status', () => {
    const main = makeRepo();
    writeOverlay(main, { entries: [entry('e2e')], expectedRevision: 0 });
    const dir = path.dirname(overlayFile(main));
    for (const f of [
      'check-tiers.lock',
      'check-tiers.lock.breaker',
      `check-tiers.lock.${process.pid}-0.tmp`,
      'check-tiers.lock.breaker.stale-1-0',
      'check-tiers.json.tmp',
    ]) {
      writeFileSync(path.join(dir, f), '1\n');
    }
    expect(git(main, 'status', '--porcelain')).toBe('');
  });

  it('leaves another file in .blacksmith visible to git', () => {
    const main = makeRepo();
    writeOverlay(main, { entries: [], expectedRevision: 0 });
    writeFileSync(path.join(path.dirname(overlayFile(main)), 'notes.txt'), 'x\n');
    expect(git(main, 'status', '--porcelain')).toContain('.blacksmith/');
  });

  it('refuses a tracked overlay and leaves the file unchanged', () => {
    const main = makeRepo();
    rawOverlay(main, valid());
    git(main, 'add', '-f', '.blacksmith/check-tiers.json');
    git(main, 'commit', '-q', '-m', 'track');
    const before = readFileSync(overlayFile(main), 'utf8');
    expect(overlayWritable(main)).toBe('tracked');
    expect(() => writeOverlay(main, { entries: [], expectedRevision: 3 })).toThrowError(
      expect.objectContaining({ code: 'checks.overlay-tracked' }),
    );
    expect(readFileSync(overlayFile(main), 'utf8')).toBe(before);
  });

  it('refuses when the exclude file cannot be written, and writes no overlay', () => {
    const main = makeRepo();
    const exclude = path.join(main, '.git', 'info', 'exclude');
    mkdirSync(path.dirname(exclude), { recursive: true });
    writeFileSync(exclude, '# none\n');
    chmodSync(exclude, 0o444);
    try {
      expect(() => writeOverlay(main, { entries: [], expectedRevision: 0 })).toThrowError(
        expect.objectContaining({ code: 'checks.overlay-exclude-failed' }),
      );
    } finally {
      chmodSync(exclude, 0o644);
    }
    expect(existsSync(overlayFile(main))).toBe(false);
  });
});

describe('one writer at a time', () => {
  it('serialises two writers that read then add different entries', async () => {
    const main = makeRepo();
    const add = (name: string): Promise<void> =>
      withOverlayLock(main, async () => {
        const o = state(main);
        await new Promise((r) => setTimeout(r, 30));
        writeOverlay(main, { entries: [...o.entries, entry(name)], expectedRevision: o.revision });
      });
    await Promise.all([add('a'), add('b')]);
    const final = state(main);
    expect(final.entries.map((e) => e.check).sort()).toEqual(['a', 'b']);
    expect(final.revision).toBe(2);
    expect(existsSync(lockFile(main))).toBe(false);
  });

  it('refuses a stale revision as moved', () => {
    const main = makeRepo();
    writeOverlay(main, { entries: [], expectedRevision: 0 });
    expect(() => writeOverlay(main, { entries: [], expectedRevision: 0 })).toThrowError(
      expect.objectContaining({ code: 'checks.overlay-moved' }),
    );
  });

  it('breaks a lock whose pid is dead, without waiting', async () => {
    const main = makeRepo();
    mkdirSync(path.dirname(lockFile(main)), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(lockFile(main), `${dead}\n`);
    const ran = await withOverlayLock(main, () => 'ran', { waitMs: 0 });
    expect(ran).toBe('ran');
    expect(existsSync(lockFile(main))).toBe(false);
    expect(readdirSync(path.dirname(lockFile(main)))).toEqual([]);
  });

  it('breaks a lock whose content is not a pid (an empty file) at once', async () => {
    const main = makeRepo();
    mkdirSync(path.dirname(lockFile(main)), { recursive: true });
    writeFileSync(lockFile(main), '');
    const ran = await withOverlayLock(main, () => 'ran', { waitMs: 0 });
    expect(ran).toBe('ran');
    expect(readdirSync(path.dirname(lockFile(main)))).toEqual([]);
  });

  it('publishes the lock only with its whole content, never as an empty file', async () => {
    const main = makeRepo();
    const atLink: { lockExisted: boolean; tempBytes: string }[] = [];
    seams.beforeLink = (from, to) => {
      if (to === lockFile(main)) {
        atLink.push({ lockExisted: existsSync(to), tempBytes: readFileSync(from, 'utf8') });
      }
    };
    try {
      await withOverlayLock(main, () => undefined);
    } finally {
      seams.beforeLink = null;
    }
    expect(atLink).toEqual([{ lockExisted: false, tempBytes: `${process.pid}\n` }]);
    expect(readdirSync(path.dirname(lockFile(main)))).toEqual([]);
  });

  it('does not take a live holder lock that replaced the dead one it was about to break', async () => {
    const main = makeRepo();
    mkdirSync(path.dirname(lockFile(main)), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
    writeFileSync(lockFile(main), `${dead}\n`);
    let probes = 0;
    // Between the waiter's verdict (the holder is dead) and its break, another
    // writer broke the dead lock and took a new, live one (this process).
    seams.afterProbe = (pid) => {
      if (pid !== dead || probes++ > 0) return;
      rmSync(lockFile(main));
      writeFileSync(lockFile(main), `${process.pid}\n`);
    };
    // Should a break rename the lock aside, a third writer takes it in the gap.
    seams.afterRename = () => {
      if (!existsSync(lockFile(main))) writeFileSync(lockFile(main), `${process.ppid}\n`);
    };
    try {
      await expect(withOverlayLock(main, () => 'ran', { waitMs: 150 })).rejects.toMatchObject({
        code: 'checks.overlay-busy',
      });
    } finally {
      seams.afterProbe = null;
      seams.afterRename = null;
    }
    expect(readFileSync(lockFile(main), 'utf8')).toBe(`${process.pid}\n`);
  });

  describe('the breaker gate', () => {
    const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid as number;
    const dirOf = (main: string): string => path.dirname(lockFile(main));
    const staleLock = (main: string): number => {
      mkdirSync(dirOf(main), { recursive: true });
      const dead = deadPid();
      writeFileSync(lockFile(main), `${dead}\n`);
      return dead;
    };

    it('waits for a live breaker, then throws busy naming its pid, touching nothing', async () => {
      const main = makeRepo();
      const dead = staleLock(main);
      writeFileSync(gateFile(main), `${process.ppid}\n`);
      const fn = vi.fn();
      await expect(withOverlayLock(main, fn, { waitMs: 150 })).rejects.toMatchObject({
        code: 'checks.overlay-busy',
        message: expect.stringContaining(`pid ${process.ppid}`),
      });
      expect(fn).not.toHaveBeenCalled();
      expect(readFileSync(gateFile(main), 'utf8')).toBe(`${process.ppid}\n`);
      expect(readFileSync(lockFile(main), 'utf8')).toBe(`${dead}\n`);
    });

    it('evicts a dead breaker gate and breaks the lock with no wait', async () => {
      const main = makeRepo();
      staleLock(main);
      writeFileSync(gateFile(main), `${deadPid()}\n`);
      expect(await withOverlayLock(main, () => 'ran', { waitMs: 0 })).toBe('ran');
      expect(readdirSync(dirOf(main))).toEqual([]);
    });

    it('evicts a gate whose content is not a pid with no wait', async () => {
      const main = makeRepo();
      staleLock(main);
      writeFileSync(gateFile(main), '');
      expect(await withOverlayLock(main, () => 'ran', { waitMs: 0 })).toBe('ran');
      expect(readdirSync(dirOf(main))).toEqual([]);
    });

    it('puts back a live gate that replaced the dead one it was evicting, and waits for it', async () => {
      const main = makeRepo();
      staleLock(main);
      const dead = deadPid();
      writeFileSync(gateFile(main), `${dead}\n`);
      // Between the verdict (the gate holder is dead) and the eviction, another
      // evictor removed the dead gate and a live breaker published its own.
      seams.afterProbe = (pid) => {
        if (pid !== dead) return;
        seams.afterProbe = null;
        rmSync(gateFile(main));
        writeFileSync(gateFile(main), `${process.ppid}\n`);
      };
      try {
        await expect(withOverlayLock(main, () => 'ran', { waitMs: 0 })).rejects.toMatchObject({
          code: 'checks.overlay-busy',
          message: expect.stringContaining(`pid ${process.ppid}`),
        });
      } finally {
        seams.afterProbe = null;
      }
      expect(readFileSync(gateFile(main), 'utf8')).toBe(`${process.ppid}\n`);
      expect(readdirSync(dirOf(main)).sort()).toEqual([
        'check-tiers.lock',
        'check-tiers.lock.breaker',
      ]);
    });

    it('does not throw when its own gate was moved away before it released it', async () => {
      const main = makeRepo();
      const dead = staleLock(main);
      // An evictor that mistook this breaker's live gate for a dead one moved it.
      seams.afterProbe = (pid) => {
        if (pid !== dead || !existsSync(gateFile(main))) return;
        seams.afterProbe = null;
        renameSync(gateFile(main), `${gateFile(main)}.moved`);
      };
      try {
        expect(await withOverlayLock(main, () => 'ran', { waitMs: 0 })).toBe('ran');
      } finally {
        seams.afterProbe = null;
      }
      expect(existsSync(lockFile(main))).toBe(false);
    });

    it('evicts a live-pid gate that has outlived any breaker, so a leaked one never blocks', async () => {
      const main = makeRepo();
      staleLock(main);
      writeFileSync(gateFile(main), `${process.ppid}\n`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(gateFile(main), old, old);
      expect(await withOverlayLock(main, () => 'ran', { waitMs: 0 })).toBe('ran');
      expect(readdirSync(dirOf(main))).toEqual([]);
    });
  });

  it('makes a second call in the holder process wait, then throw busy with waitMs', async () => {
    const main = makeRepo();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = withOverlayLock(main, () => held);
    const fn = vi.fn();
    await expect(withOverlayLock(main, fn, { waitMs: 150 })).rejects.toMatchObject({
      code: 'checks.overlay-busy',
    });
    expect(fn).not.toHaveBeenCalled();
    release();
    await first;
    expect(existsSync(lockFile(main))).toBe(false);
  });

  it('keeps a default wait of OVERLAY_LOCK_WAIT_MS, no more and no less', async () => {
    expect(OVERLAY_LOCK_WAIT_MS).toBe(30000);
    const main = makeRepo();
    writeOverlay(main, { entries: [entry('e2e')], expectedRevision: 0 });
    const overlayBytes = readFileSync(overlayFile(main));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = withOverlayLock(main, () => held);
    const lockBytes = readFileSync(lockFile(main), 'utf8');
    expect(lockBytes).toBe(`${process.pid}\n`);
    const filesBefore = readdirSync(path.dirname(lockFile(main))).sort();

    const fn = vi.fn();
    let settled = false;
    const second = withOverlayLock(main, fn).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    void second.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(OVERLAY_LOCK_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    const err = (await second) as { code?: string; message?: string };
    expect(err.code).toBe('checks.overlay-busy');
    expect(err.message).toContain(String(process.pid));
    expect(err.message).toContain(String(OVERLAY_LOCK_WAIT_MS));

    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(overlayFile(main)).equals(overlayBytes)).toBe(true);
    expect(readFileSync(lockFile(main), 'utf8')).toBe(lockBytes);
    expect(readdirSync(path.dirname(lockFile(main))).sort()).toEqual(filesBefore);
    release();
    await first;
    expect(existsSync(lockFile(main))).toBe(false);
  });
});

describe('crash order and reconcile', () => {
  it('leaves the previous overlay byte-identical when the rename never happens', () => {
    const main = makeRepo();
    writeOverlay(main, { entries: [entry('a')], expectedRevision: 0 });
    const before = readFileSync(overlayFile(main));
    expect(() =>
      writeOverlay(
        main,
        { entries: [entry('a'), entry('b')], expectedRevision: 1 },
        {
          beforeRename: () => {
            throw new Error('crash');
          },
        },
      ),
    ).toThrow('crash');
    expect(readFileSync(overlayFile(main)).equals(before)).toBe(true);
    writeOverlay(main, { entries: [entry('a'), entry('b')], expectedRevision: 1 });
    expect(readdirSync(path.dirname(overlayFile(main)))).toEqual(['check-tiers.json']);
  });

  const pendingPayload = {
    check: 'e2e',
    cmd_sha256: commandDigest(CMD),
    from_tier: 'post-merge',
    to_tier: 'pre-merge',
  };

  it('owes the approved tier the overlay lacks and nothing for a consistent pair', () => {
    expect(overlayOwes({ revision: 0, entries: [] }, [])).toEqual({
      missing: [],
      pending: [],
      settled: [],
    });
    const log = [
      decided('s#1', 'e2e', 'post-merge'),
      decided('s#2', 'lint', 'pre-release', 'decline'),
    ];
    const owes = overlayOwes({ revision: 0, entries: [] }, log);
    expect(owes.missing).toEqual([
      {
        check: 'e2e',
        cmd_sha256: commandDigest(CMD),
        tier: 'post-merge',
        decided_by_event_id: 's#1',
        decided_at: '2026-10-31T01:02:03.000Z',
      },
    ]);
    expect(overlayOwes({ revision: 1, entries: owes.missing }, log)).toEqual({
      missing: [],
      pending: [],
      settled: [],
    });
    expect(overlayOwes({ unreadable: 'x' }, log)).toEqual({
      missing: [],
      pending: [],
      settled: [],
    });
  });

  it('never overwrites an entry that is ahead of the log with its pending promotion', () => {
    const ahead = {
      ...entry('e2e', CMD, 'pre-merge'),
      pending_event: { event_type: 'check-tier-promoted', payload: pendingPayload },
    };
    const owes = overlayOwes({ revision: 2, entries: [ahead] }, [
      decided('s#1', 'e2e', 'post-merge'),
    ]);
    expect(owes.missing).toEqual([]);
    expect(owes.pending).toEqual([ahead]);
    const logged = stored('s#2', 'check-tier-promoted', pendingPayload);
    const done = overlayOwes({ revision: 2, entries: [ahead] }, [
      decided('s#1', 'e2e', 'post-merge'),
      logged,
    ]);
    expect(done.pending).toEqual([]);
    expect(done.settled).toEqual([ahead]);
  });

  it('writes a missing approved tier and appends a pending event exactly once', async () => {
    const main = makeRepo();
    const stateDir = tmp();
    const start = await appendEvent(
      {
        session_id: 's',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir },
    );
    const ctx = {
      session_id: 's',
      actor: 'orchestrator',
      plan_version: 1,
      causal_parent: start.event_id,
    };
    await withOverlayLock(main, () =>
      reconcileOverlay(main, [decided('s#9', 'e2e', 'post-merge')], ctx, { events: { stateDir } }),
    );
    expect(state(main).entries.map((e) => [e.check, e.tier])).toEqual([['e2e', 'post-merge']]);

    const o = state(main);
    const pe = { event_type: 'check-tier-promoted', payload: pendingPayload };
    writeOverlay(main, {
      entries: [{ ...o.entries[0], tier: 'pre-merge', pending_event: pe }] as OverlayEntry[],
      expectedRevision: o.revision,
    });
    const log = [decided('s#9', 'e2e', 'post-merge')];
    await withOverlayLock(main, () => reconcileOverlay(main, log, ctx, { events: { stateDir } }));
    const appended = (await readEvents('s', { stateDir })).filter(
      (e) => e.record.event_type === 'check-tier-promoted',
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]?.record.payload).toEqual(pendingPayload);
    expect(state(main).entries[0]).not.toHaveProperty('pending_event');
    expect(state(main).entries[0]?.tier).toBe('pre-merge');

    const revision = state(main).revision;
    await withOverlayLock(main, () =>
      reconcileOverlay(main, [...log, ...appended], ctx, { events: { stateDir } }),
    );
    expect(state(main).revision).toBe(revision);
    expect(await readEvents('s', { stateDir })).toHaveLength(2);
  });

  it('only clears a pending event the log already holds, without appending it again', async () => {
    const main = makeRepo();
    const stateDir = tmp();
    const pe = { event_type: 'check-tier-promoted', payload: pendingPayload };
    writeOverlay(main, {
      entries: [{ ...entry('e2e', CMD, 'pre-merge'), pending_event: pe }],
      expectedRevision: 0,
    });
    const ctx = { session_id: 's', actor: 'orchestrator', plan_version: 1, causal_parent: null };
    await withOverlayLock(main, () =>
      reconcileOverlay(main, [stored('s#2', 'check-tier-promoted', pendingPayload)], ctx, {
        events: { stateDir },
      }),
    );
    expect(state(main).entries[0]).not.toHaveProperty('pending_event');
    expect(existsSync(path.join(stateDir, 's.jsonl'))).toBe(false);
  });
});

describe('the checks file is never written', () => {
  it('leaves a read-only checks file untouched across every export', async () => {
    const main = makeRepo();
    const file = path.join(main, 'checks.json');
    chmodSync(file, 0o444);
    const bytes = readFileSync(file);
    const mtime = statSync(file).mtimeMs;
    const checks = [check('e2e')];
    const ctx = { session_id: 's', actor: 'orchestrator', plan_version: 1, causal_parent: null };
    overlayPath(main);
    readOverlay(main);
    overlayWritable(main);
    await withOverlayLock(main, async () => {
      writeOverlay(main, { entries: [entry('e2e')], expectedRevision: 0 });
      await reconcileOverlay(main, [decided('s#1', 'e2e', 'post-merge')], ctx);
    });
    resolveEffectiveTiers(checks, readOverlay(main));
    overlayReport(checks, readOverlay(main));
    overlayOwes(readOverlay(main), []);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });
});

describe('no write, no lock', () => {
  it('throws not-a-repo outside git and creates nothing', async () => {
    const plain = tmp();
    const before = readdirSync(plain);
    await expect(withOverlayLock(plain, () => 1)).rejects.toMatchObject({
      code: 'checks.overlay-not-a-repo',
    });
    expect(readdirSync(plain)).toEqual(before);
  });

  it('creates .blacksmith for its lock and leaves no lock after fn returns or throws', async () => {
    const main = makeRepo();
    expect(overlayOwes(readOverlay(main), [])).toEqual({ missing: [], pending: [], settled: [] });
    expect(existsSync(path.join(main, '.blacksmith'))).toBe(false);
    await withOverlayLock(main, () => {
      expect(existsSync(lockFile(main))).toBe(true);
    });
    expect(readdirSync(path.join(main, '.blacksmith'))).toEqual([]);
    await expect(
      withOverlayLock(main, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(readdirSync(path.join(main, '.blacksmith'))).toEqual([]);
    expect(git(main, 'status', '--porcelain')).toBe('');
  });
});

beforeEach(() => {
  vi.useRealTimers();
});
