import { describe, expect, it } from 'vitest';
import {
  type CheckLedger,
  checkLedger,
  FAILURE_CLASSES,
  LEDGER_WINDOW_DAYS,
  type LedgerCheck,
  SEVERITY_WEIGHTS,
} from '../src/checkLedger.js';
import type { StoredEvent } from '../src/events.js';
import { SLEEP_GAP_MS } from '../src/testgate.js';
import {
  gateEvent,
  integrationEvent,
  ledgerInputs,
  mergedEvent,
  NOW,
  queueEvent,
  realRun,
  revertedEvent,
} from './helpers/ledgerEvents.js';

const DAY_MS = 86_400_000;
const window = { from: new Date(NOW - LEDGER_WINDOW_DAYS * DAY_MS), to: new Date(NOW) };

const CLAIMS = {
  'e/task-1': ['src/x.ts'],
  'e/task-2': ['src/y.ts'],
  'e/auth': ['src/auth/session.ts'],
};

/** Diffs by `<a>><b>`; a pair not listed touches `src/x.ts`, and `throws` is unreadable. */
function diffs(table: Record<string, string[] | 'throws'> = {}) {
  return (a: string, b: string): string[] => {
    const hit = table[`${a}>${b}`];
    if (hit === 'throws') throw new Error('bad object');
    return hit ?? ['src/x.ts'];
  };
}

function ledgerOf(
  events: StoredEvent[],
  o: {
    claims?: Record<string, string[]>;
    treeDiff?: (a: string, b: string) => string[];
    unattributed?: string[];
  } = {},
): CheckLedger {
  return checkLedger(ledgerInputs(events, o.claims ?? CLAIMS, { unattributed: o.unattributed }), {
    window,
    treeDiff: o.treeDiff ?? diffs(),
    checksFile: 'checks.json',
  });
}

const entryOf = (ledger: CheckLedger, name: string, nth = 0): LedgerCheck => {
  const hit = ledger.checks.filter((c) => c.name === name)[nth];
  if (hit === undefined) throw new Error(`no ledger entry for ${name}`);
  return hit;
};
const rowsOf = (ledger: CheckLedger, name: string) => ledger.rows.filter((r) => r.name === name);

/** A pass at another tree for the same task, later in the log, as a fix leaves behind. */
const failThenPass = async (
  name: string,
  task: string,
  trees: [string, string],
  o: { daysAgo?: number; failMs?: number } = {},
): Promise<StoredEvent[]> => [
  gateEvent(`${name}-fail`, {
    task,
    tree: trees[0],
    daysAgo: o.daysAgo,
    run: await realRun([{ name, pass: false, monotonicMs: o.failMs }]),
  }),
  gateEvent(`${name}-pass`, {
    task,
    tree: trees[1],
    daysAgo: o.daysAgo,
    run: await realRun([{ name, pass: true }]),
  }),
];

const stripDigests = (e: StoredEvent): StoredEvent => ({
  ...e,
  record: {
    ...e.record,
    payload: {
      ...e.record.payload,
      results: (e.record.payload.results as Record<string, unknown>[]).map(
        ({ cmd_sha256, check_sha256, ...rest }) => rest,
      ),
    },
  },
});

describe('checkLedger failure classes', () => {
  it('gives each of the five fixtures its own class string', async () => {
    const events: StoredEvent[] = [
      gateEvent('g-env', {
        task: 'e/task-1',
        tree: 't-env',
        run: await realRun([{ name: 'envchk', pass: false, wallMs: 1000 + SLEEP_GAP_MS }]),
      }),
      gateEvent('g-flaky-fail', {
        task: 'e/task-1',
        tree: 't-flaky',
        run: await realRun([{ name: 'flakychk', pass: false }]),
      }),
      gateEvent('g-flaky-pass', {
        task: 'e/task-1',
        tree: 't-flaky',
        run: await realRun([{ name: 'flakychk', pass: true }]),
      }),
      ...(await failThenPass('realchk', 'e/task-1', ['t-real-a', 't-real-b'])),
      ...(await failThenPass('checkschk', 'e/task-1', ['t-cf-a', 't-cf-b'])),
      gateEvent('g-lock', {
        task: 'e/task-1',
        tree: 't-lock',
        run: await realRun([{ name: 'lockchk', pass: false, notRun: true }]),
      }),
    ];
    const ledger = ledgerOf(events, {
      treeDiff: diffs({ 't-cf-a>t-cf-b': ['checks.json'], 't-real-a>t-real-b': ['src/x.ts'] }),
    });
    expect(rowsOf(ledger, 'envchk')[0]?.class).toBe('env');
    expect(rowsOf(ledger, 'flakychk').find((r) => r.outcome === 'fail')?.class).toBe('flaky');
    expect(rowsOf(ledger, 'realchk').find((r) => r.outcome === 'fail')?.class).toBe('real');
    expect(rowsOf(ledger, 'checkschk').find((r) => r.outcome === 'fail')?.class).toBe(
      'unconfirmed',
    );
    expect(rowsOf(ledger, 'lockchk')[0]?.class).toBe('not-run');
    expect(rowsOf(ledger, 'flakychk').find((r) => r.outcome === 'pass')?.class).toBeNull();
  });

  it('exports the five class strings in decision order', () => {
    expect([...FAILURE_CLASSES]).toEqual(['not-run', 'env', 'flaky', 'real', 'unconfirmed']);
  });

  it('classes a fail never followed by a pass unconfirmed, with its run and minutes but no catch', async () => {
    const ledger = ledgerOf([
      gateEvent('g-open', {
        task: 'e/task-1',
        tree: 't1',
        run: await realRun([{ name: 'openchk', pass: false, monotonicMs: 120_000 }]),
      }),
    ]);
    const row = rowsOf(ledger, 'openchk')[0];
    expect(row?.class).toBe('unconfirmed');
    expect(row?.catch).toBeNull();
    const c = entryOf(ledger, 'openchk');
    expect(c).toMatchObject({
      runs: 1,
      minutes: 2,
      real_catches: 0,
      unique_catches: 0,
      importance: 0,
      flake_rate: 0,
    });
    expect(c.unconfirmed).toEqual([{ event_id: 'g-open', severity: 'S2' }]);
  });

  it('gives an unconfirmed failure S1 on a task claiming a sensitive path, and the guard still sees it 40 days on', async () => {
    const recent = ledgerOf([
      gateEvent('g-sec', {
        task: 'e/auth',
        tree: 't1',
        run: await realRun([{ name: 'secchk', pass: false }]),
      }),
    ]);
    expect(entryOf(recent, 'secchk').unconfirmed).toEqual([{ event_id: 'g-sec', severity: 'S1' }]);
    const old = ledgerOf([
      gateEvent('g-old', {
        task: 'e/auth',
        tree: 't1',
        daysAgo: 40,
        run: await realRun([{ name: 'oldchk', pass: false }]),
      }),
    ]);
    const c = entryOf(old, 'oldchk');
    expect(c.guards_sensitive).toBe(true);
    expect(c.unconfirmed).toEqual([]);
    expect(c.runs).toBe(0);
    expect(c.event_ids.guards_sensitive).toEqual(['g-old']);
  });

  it('decides a revert-confirmed red as real and takes the culprit task for its severity', async () => {
    const events = [
      integrationEvent('i-red', {
        epic: 'e',
        tree: 't-red',
        tiers: ['post-merge'],
        run: await realRun([{ name: 'pmchk', pass: false }]),
      }),
      revertedEvent('w-rev', {
        task: 'e/auth',
        epic: 'e',
        evidence: ['i-red'],
        failingChecks: ['pmchk'],
      }),
    ];
    const ledger = ledgerOf(events);
    const row = rowsOf(ledger, 'pmchk')[0];
    expect(row).toMatchObject({ class: 'real', severity: 'S1', tasks: ['e/auth'] });
  });
});

describe('checkLedger fixes of another task', () => {
  it('does not take a pass for another task, or of another command, as the fix', async () => {
    const ledger = ledgerOf([
      gateEvent('g-fail', {
        task: 'e/task-1',
        tree: 'ta',
        run: await realRun([
          { name: 'other-task', pass: false },
          { name: 'other-cmd', pass: false },
        ]),
      }),
      gateEvent('g-pass', {
        task: 'e/task-2',
        tree: 'tb',
        run: await realRun([{ name: 'other-task', pass: true }]),
      }),
      gateEvent('g-pass-2', {
        task: 'e/task-1',
        tree: 'tc',
        run: await realRun([{ name: 'other-cmd', pass: true, variant: 'v2' }]),
      }),
    ]);
    expect(rowsOf(ledger, 'other-task').find((r) => r.outcome === 'fail')?.class).toBe(
      'unconfirmed',
    );
    expect(rowsOf(ledger, 'other-cmd').find((r) => r.outcome === 'fail')?.class).toBe(
      'unconfirmed',
    );
  });
});

describe('checkLedger not-run', () => {
  it('counts a lock-wait timeout only as not_run, probes included', async () => {
    const locked = () => realRun([{ name: 'lockchk', pass: false, notRun: true }]);
    const ledger = ledgerOf([
      gateEvent('g-1', { task: 'e/task-1', tree: 't1', run: await locked() }),
      gateEvent('g-2', { task: 'e/task-1', tree: 't2', run: await locked() }),
      integrationEvent('i-probe', {
        epic: 'e',
        tree: 't3',
        probeOf: 'i-red',
        run: await locked(),
      }),
    ]);
    expect(entryOf(ledger, 'lockchk')).toMatchObject({
      runs: 0,
      minutes: 0,
      unmeasured: 0,
      real_catches: 0,
      unique_catches: 0,
      unconfirmed: [],
      not_run: 3,
      guards_sensitive: false,
    });
    expect(entryOf(ledger, 'lockchk').event_ids.not_run).toEqual(['g-1', 'g-2', 'i-probe']);
  });

  it('reads a name in the record not_run list as not-run', async () => {
    const e = gateEvent('g-1', {
      task: 'e/task-1',
      tree: 't1',
      run: await realRun([{ name: 'named', pass: false }]),
    });
    e.record.payload.not_run = ['named'];
    const ledger = ledgerOf([e]);
    expect(rowsOf(ledger, 'named')[0]?.class).toBe('not-run');
    expect(entryOf(ledger, 'named')).toMatchObject({ runs: 0, not_run: 1 });
  });
});

describe('checkLedger unique catch', () => {
  it('is unique when the faster check passed in the same run', async () => {
    const ledger = ledgerOf([
      gateEvent('g-a', {
        task: 'e/task-1',
        tree: 'ta',
        run: await realRun([
          { name: 'uf1', pass: true, monotonicMs: 500 },
          { name: 'uc1', pass: false, monotonicMs: 2000 },
        ]),
      }),
      gateEvent('g-b', {
        task: 'e/task-1',
        tree: 'tb',
        run: await realRun([
          { name: 'uf1', pass: true, monotonicMs: 500 },
          { name: 'uc1', pass: true, monotonicMs: 2000 },
        ]),
      }),
    ]);
    expect(rowsOf(ledger, 'uc1').find((r) => r.outcome === 'fail')).toMatchObject({
      class: 'real',
      catch: 'unique',
    });
    expect(entryOf(ledger, 'uc1').unique_catches).toBe(1);
  });

  it('is shadowed when the faster check was ordered after it and never observed', async () => {
    const ledger = ledgerOf([
      gateEvent('g-x', {
        task: 'e/task-1',
        tree: 'tx',
        run: await realRun([{ name: 'uf2', pass: true, monotonicMs: 500 }]),
      }),
      gateEvent('g-a', {
        task: 'e/task-1',
        tree: 'ta',
        run: await realRun([{ name: 'uc2', pass: false, monotonicMs: 2000 }]),
      }),
      gateEvent('g-b', {
        task: 'e/task-1',
        tree: 'tb',
        run: await realRun([{ name: 'uc2', pass: true, monotonicMs: 2000 }]),
      }),
    ]);
    const row = rowsOf(ledger, 'uc2').find((r) => r.outcome === 'fail');
    expect(row).toMatchObject({ class: 'real', catch: 'shadowed' });
    expect(entryOf(ledger, 'uc2')).toMatchObject({ real_catches: 1, unique_catches: 0 });
  });

  it('is unique when the faster check passed at the same tree in another record', async () => {
    const ledger = ledgerOf([
      gateEvent('g-a', {
        task: 'e/task-1',
        tree: 'ta',
        run: await realRun([{ name: 'uc3', pass: false, monotonicMs: 2000 }]),
      }),
      queueEvent('q-a', {
        epic: 'e',
        taskIds: ['e/task-1'],
        tree: 'ta',
        run: await realRun([{ name: 'uf3', pass: true, monotonicMs: 500 }]),
      }),
      gateEvent('g-b', {
        task: 'e/task-1',
        tree: 'tb',
        run: await realRun([{ name: 'uc3', pass: true, monotonicMs: 2000 }]),
      }),
    ]);
    expect(rowsOf(ledger, 'uc3').find((r) => r.outcome === 'fail')?.catch).toBe('unique');
  });

  it('weights importance by severity over measured minutes', async () => {
    const ledger = ledgerOf([
      gateEvent('g-a', {
        task: 'e/auth',
        tree: 'ta',
        run: await realRun([{ name: 'imp', pass: false, monotonicMs: 60_000 }]),
      }),
      gateEvent('g-b', {
        task: 'e/auth',
        tree: 'tb',
        run: await realRun([{ name: 'imp', pass: true, monotonicMs: 60_000 }]),
      }),
    ]);
    expect(SEVERITY_WEIGHTS).toEqual({ S1: 8, S2: 4, S3: 2, S4: 1 });
    expect(entryOf(ledger, 'imp')).toMatchObject({ minutes: 2, importance: 4, s1_catches: 1 });
  });
});

describe('checkLedger severity and the sensitive-path guard', () => {
  it('marks S1 and guarding for a catch on a sensitive task, and for exposure inside the window only', async () => {
    const events = [
      ...(await failThenPass('caught', 'e/auth', ['ta', 'tb'])),
      gateEvent('g-ran', {
        task: 'e/auth',
        tree: 'tc',
        run: await realRun([{ name: 'ranonly', pass: true }]),
      }),
      gateEvent('g-ran-old', {
        task: 'e/auth',
        tree: 'td',
        daysAgo: 40,
        run: await realRun([{ name: 'oldran', pass: true }]),
      }),
      gateEvent('g-plain', {
        task: 'e/task-1',
        tree: 'te',
        run: await realRun([{ name: 'plain', pass: true }]),
      }),
    ];
    const ledger = ledgerOf(events);
    expect(rowsOf(ledger, 'caught').find((r) => r.outcome === 'fail')?.severity).toBe('S1');
    expect(entryOf(ledger, 'caught')).toMatchObject({ guards_sensitive: true, s1_catches: 1 });
    expect(entryOf(ledger, 'ranonly').guards_sensitive).toBe(true);
    expect(entryOf(ledger, 'oldran').guards_sensitive).toBe(false);
    expect(entryOf(ledger, 'plain').guards_sensitive).toBe(false);
  });

  it('fails closed on an unattributed gate and on a task with no claims entry', async () => {
    const ledger = ledgerOf(
      [
        gateEvent('g-un', {
          task: 'e/task-1',
          tree: 't1',
          run: await realRun([{ name: 'unattr', pass: true }]),
        }),
        gateEvent('g-ec', {
          task: 'e/empty',
          tree: 't3',
          run: await realRun([{ name: 'emptyclaims', pass: true }]),
        }),
        gateEvent('g-nc', {
          task: 'e/no-claims',
          tree: 't2',
          run: await realRun([{ name: 'noclaims', pass: true }]),
        }),
      ],
      { unattributed: ['g-un'], claims: { ...CLAIMS, 'e/empty': [] } },
    );
    expect(entryOf(ledger, 'unattr').guards_sensitive).toBe(true);
    expect(entryOf(ledger, 'noclaims').guards_sensitive).toBe(true);
    expect(entryOf(ledger, 'emptyclaims').guards_sensitive).toBe(true);
  });
});

describe('checkLedger identity', () => {
  it('keeps one name with two command digests as two identities', async () => {
    const ledger = ledgerOf([
      gateEvent('g-1', {
        task: 'e/task-1',
        tree: 't1',
        run: await realRun([{ name: 'same', pass: true }]),
      }),
      gateEvent('g-2', {
        task: 'e/task-1',
        tree: 't2',
        run: await realRun([{ name: 'same', pass: true, variant: 'v2' }]),
      }),
    ]);
    const [a, b] = ledger.checks.filter((c) => c.name === 'same');
    expect(a?.cmd_sha256).not.toBe(b?.cmd_sha256);
    expect([a?.runs, b?.runs]).toEqual([1, 1]);
  });

  it('counts a name-only real catch toward the guard and adds no run or minute', async () => {
    const [fail, pass] = await failThenPass('nameonly', 'e/auth', ['ta', 'tb']);
    const ledger = ledgerOf([stripDigests(fail as StoredEvent), stripDigests(pass as StoredEvent)]);
    const c = entryOf(ledger, 'nameonly');
    expect(c.cmd_sha256).toBeNull();
    expect(c).toMatchObject({
      runs: 0,
      minutes: 0,
      unmeasured: 0,
      real_catches: 1,
      guards_sensitive: true,
    });
  });

  it('puts a name-only unconfirmed failure on the check of that name, guarding, with no run or minute', async () => {
    const ledger = ledgerOf([
      gateEvent('g-digest', {
        task: 'e/task-1',
        tree: 't0',
        run: await realRun([{ name: 'shared', pass: true }]),
      }),
      stripDigests(
        gateEvent('g-open', {
          task: 'e/auth',
          tree: 't1',
          run: await realRun([{ name: 'shared', pass: false, monotonicMs: 9000 }]),
        }),
      ),
    ]);
    const digest = ledger.checks.find((c) => c.name === 'shared' && c.cmd_sha256 !== null);
    expect(digest).toMatchObject({ runs: 1, minutes: 1000 / 60_000, guards_sensitive: true });
    expect(digest?.unconfirmed).toEqual([{ event_id: 'g-open', severity: 'S1' }]);
    const nameOnly = ledger.checks.find((c) => c.name === 'shared' && c.cmd_sha256 === null);
    expect(nameOnly).toMatchObject({ runs: 0, minutes: 0, guards_sensitive: true });
  });
});

describe('checkLedger duration', () => {
  it('is null without an environment array, on a name mismatch, and for window none', async () => {
    const noArray = gateEvent('g-1', {
      task: 'e/task-1',
      tree: 't1',
      run: await realRun([{ name: 'm1', pass: true }]),
    });
    delete noArray.record.payload.environment;
    const mismatch = gateEvent('g-2', {
      task: 'e/task-1',
      tree: 't2',
      run: await realRun([{ name: 'm2', pass: true }]),
    });
    (mismatch.record.payload.environment as { name: string }[])[0] = {
      ...(mismatch.record.payload.environment as { name: string }[])[0],
      name: 'other',
    };
    const none = gateEvent('g-3', {
      task: 'e/task-1',
      tree: 't3',
      run: await realRun([{ name: 'm3', pass: true }]),
    });
    (none.record.payload.environment as { window: string }[])[0] = {
      ...(none.record.payload.environment as { window: string }[])[0],
      window: 'none',
    };
    const measured = gateEvent('g-4', {
      task: 'e/task-1',
      tree: 't4',
      run: await realRun([{ name: 'm4', pass: true, monotonicMs: 6000 }]),
    });
    const ledger = ledgerOf([noArray, mismatch, none, measured]);
    for (const n of ['m1', 'm2', 'm3']) {
      expect(rowsOf(ledger, n)[0]?.duration_ms).toBeNull();
      expect(entryOf(ledger, n)).toMatchObject({ runs: 1, minutes: 0, unmeasured: 1 });
    }
    expect(entryOf(ledger, 'm4')).toMatchObject({ minutes: 0.1, unmeasured: 0 });
  });

  it('reads an event with a per-result environment as unmeasured, with no env class', async () => {
    const e = gateEvent('g-1', {
      task: 'e/task-1',
      tree: 't1',
      run: await realRun([{ name: 'legacy', pass: false, wallMs: 1000 + SLEEP_GAP_MS }]),
    });
    const environment = e.record.payload.environment as Record<string, unknown>[];
    e.record.payload.results = (e.record.payload.results as Record<string, unknown>[]).map(
      (r, i) => ({ ...r, environment: environment[i] }),
    );
    delete e.record.payload.environment;
    const ledger = ledgerOf([e]);
    expect(rowsOf(ledger, 'legacy')[0]).toMatchObject({
      duration_ms: null,
      class: 'unconfirmed',
    });
  });

  it('decides real when the tree diff cannot be read', async () => {
    const events = await failThenPass('unreadable', 'e/task-1', ['ta', 'tb']);
    const ledger = ledgerOf(events, { treeDiff: diffs({ 'ta>tb': 'throws' }) });
    expect(rowsOf(ledger, 'unreadable').find((r) => r.outcome === 'fail')?.class).toBe('real');
  });
});

describe('checkLedger event ids, purity and the window', () => {
  it('names the event ids behind every number and writes nothing', async () => {
    const events = [
      ...(await failThenPass('named', 'e/task-1', ['ta', 'tb'], { failMs: 3000 })),
      integrationEvent('i-1', {
        epic: 'e',
        tree: 'tc',
        run: await realRun([{ name: 'named', pass: true }]),
      }),
    ];
    const inputs = ledgerInputs(events, CLAIMS);
    const before = structuredClone(inputs);
    const ledger = checkLedger(inputs, { window, treeDiff: diffs(), checksFile: 'checks.json' });
    expect(inputs).toEqual(before);
    const c = entryOf(ledger, 'named');
    expect(c.event_ids.runs).toEqual(['named-fail', 'named-pass', 'i-1']);
    expect(c.event_ids.minutes).toEqual(['named-fail', 'named-pass', 'i-1']);
    expect(c.event_ids.real_catches).toEqual(['named-fail']);
    expect(c.event_ids.unique_catches).toEqual(['named-fail']);
  });

  it('keeps a 40-day-old catch on a sensitive task guarding while it adds nothing in the window', async () => {
    const events = [
      ...(await failThenPass('aged', 'e/auth', ['ta', 'tb'], { daysAgo: 40, failMs: 60_000 })),
    ];
    const c = entryOf(ledgerOf(events), 'aged');
    expect(c.guards_sensitive).toBe(true);
    expect(c).toMatchObject({
      runs: 0,
      minutes: 0,
      real_catches: 0,
      s1_catches: 0,
      s2_catches: 0,
      importance: 0,
    });
    const row = rowsOf(ledgerOf(events), 'aged').find((r) => r.outcome === 'fail');
    expect(row).toMatchObject({ class: 'real', severity: 'S1' });
  });
});

describe('checkLedger across record types', () => {
  it('measures a gate, a queue and an integration record, and splits R and M by source', async () => {
    const ledger = ledgerOf([
      gateEvent('g-1', {
        task: 'e/task-1',
        tree: 't1',
        run: await realRun([{ name: 'all', pass: true, monotonicMs: 61_000 }]),
      }),
      queueEvent('q-1', {
        epic: 'e',
        taskIds: ['e/task-1'],
        tree: 't2',
        run: await realRun([{ name: 'all', pass: true, monotonicMs: 62_000 }]),
      }),
      integrationEvent('i-1', {
        epic: 'e',
        tree: 't3',
        run: await realRun([{ name: 'all', pass: true, monotonicMs: 63_000 }]),
      }),
    ]);
    expect(ledger.rows.map((r) => r.duration_ms)).toEqual([61_000, 62_000, 63_000]);
    const c = entryOf(ledger, 'all');
    expect(c.by_source.gate).toEqual({ runs: 1, minutes: 61_000 / 60_000 });
    expect(c.by_source.queue).toEqual({ runs: 1, minutes: 62_000 / 60_000 });
    expect(c.by_source.close).toEqual({ runs: 1, minutes: 63_000 / 60_000 });
  });

  it('counts a red queue run whose check later passes at another tree for the task as a catch, once', async () => {
    const ledger = ledgerOf([
      queueEvent('q-red', {
        epic: 'e',
        taskIds: ['e/task-1'],
        tree: 'ta',
        runId: 'run-1',
        run: await realRun([{ name: 'qchk', pass: false }]),
      }),
      mergedEvent('m-0', { task: 'e/task-2' }),
      gateEvent('g-fix', {
        task: 'e/task-1',
        tree: 'tb',
        run: await realRun([{ name: 'qchk', pass: true }]),
      }),
      queueEvent('q-green', {
        epic: 'e',
        taskIds: ['e/task-1'],
        tree: 'tb',
        runId: 'run-2',
        run: await realRun([{ name: 'qchk', pass: true }]),
      }),
      mergedEvent('m-1', { task: 'e/task-1', preLandingRunId: 'run-2' }),
    ]);
    expect(
      rowsOf(ledger, 'qchk').find((r) => r.source === 'queue' && r.outcome === 'fail'),
    ).toMatchObject({ class: 'real' });
    const c = entryOf(ledger, 'qchk');
    expect(c.runs).toBe(3);
    expect(c.by_source.queue.runs).toBe(2);
    expect(c.real_catches).toBe(1);
  });

  it('reports post-merge runs, task merges, epics with merges and merges per post-merge run', async () => {
    const pm = (id: string, tree: string) =>
      realRun([{ name: 'pm', pass: true }]).then((run) =>
        integrationEvent(id, { epic: 'e', tree, tiers: ['post-merge'], run }),
      );
    const probe = integrationEvent('i-probe', {
      epic: 'e',
      tree: 'tp',
      tiers: ['post-merge'],
      probeOf: 'i-1',
      run: await realRun([{ name: 'pm', pass: true }]),
    });
    const ledger = ledgerOf([
      await pm('i-1', 't1'),
      probe,
      await pm('i-2', 't2'),
      mergedEvent('m-1', { task: 'e/task-1' }),
      mergedEvent('m-2', { task: 'e/task-2' }),
      mergedEvent('m-3', { task: 'f/task-1' }),
      mergedEvent('m-4', { task: 'f/task-2' }),
    ]);
    expect(ledger.project).toEqual({
      post_merge_runs: 2,
      post_merge_run_ids: ['i-1', 'i-2'],
      task_merges: 4,
      epics_with_merges: 2,
      merges_per_post_merge_run: 2,
    });
  });
});
