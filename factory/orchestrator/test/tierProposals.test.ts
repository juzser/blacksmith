import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLedger } from '../src/checkLedger.js';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import { gatherLedgerInputs, type LedgerInputsOptions } from '../src/ledgerInputs.js';
import { type CheckCommand, commandDigest, type RunResult } from '../src/testgate.js';
import {
  OVERLAY_LOCK_WAIT_MS,
  type OverlayEntry,
  type OverlayRead,
  overlayPath,
  readOverlay,
  resolveEffectiveTiers,
  withOverlayLock,
  writeOverlay,
} from '../src/tierOverlay.js';
import {
  applyTierDecisions,
  CHECK_TIER_BATCH_ANSWERED_EVENT,
  CHECK_TIER_DECIDED_EVENT,
  CHECK_TIER_PROMOTED_EVENT,
  currentProjectLog,
  DECLINE_QUIET_DAYS,
  itemBlocker,
  MIN_MEASURED_MINUTES,
  MIN_RUNS,
  type ProposalItem,
  pendingProposals,
  promoteAfterCatch,
  recordBatchHandOff,
  validateDecisions,
} from '../src/tierProposals.js';
import {
  gateEvent,
  integrationEvent,
  ledgerInputs,
  mergedEvent,
  NOW,
  revertedEvent,
  tsAgo,
} from './helpers/ledgerEvents.js';

const DAY_MS = 86_400_000;
const now = new Date(NOW);
const window = { from: new Date(NOW - 30 * DAY_MS), to: now };
const cmdOf = (name: string): string => `run ${name}`;
const shaOf = (name: string): string => commandDigest(cmdOf(name));

const roots: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'smith-proposals-')));
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
  writeFileSync(path.join(main, 'checks.json'), '[]\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  return main;
}

afterEach(() => {
  vi.useRealTimers();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A RunResult of one check, shaped as testgate.run returns it (results and environment
// side by side), without spawning a process.
function fakeRun(
  name: string,
  pass: boolean,
  minutes: number,
  o: { gapMs?: number; reason?: string } = {},
): RunResult {
  const mono = Math.round(minutes * 60_000);
  return {
    pass,
    results: [
      {
        name,
        pass,
        exitCode: pass ? 0 : 1,
        tail: '',
        cmd_sha256: shaOf(name),
        check_sha256: 'x',
        ...(o.reason === undefined ? {} : { reason: o.reason }),
      },
    ],
    environment: [
      {
        name,
        window: 'command',
        wall_ms: mono + (o.gapMs ?? 0),
        monotonic_ms: mono,
        clock_gap_ms: o.gapMs ?? 0,
        load_1m_start: 0,
        load_1m_end: 0,
        cpus: 4,
      },
    ],
  } as unknown as RunResult;
}

interface Hist {
  name: string;
  gate: number;
  close?: number;
  minutes: number;
  auth?: boolean;
}

/** Gate runs on distinct tasks, close runs, post-merge head runs of another check, merges. */
function history(
  hs: Hist[],
  o: { postMerge?: number; merges?: number } = {},
): { events: StoredEvent[]; claims: Record<string, string[]> } {
  const events: StoredEvent[] = [];
  const claims: Record<string, string[]> = {};
  for (const h of hs) {
    for (let i = 0; i < h.gate; i++) {
      const task = `e/${h.name}-${i}`;
      claims[task] = [h.auth === true ? 'src/auth/x.ts' : 'src/x.ts'];
      events.push(
        gateEvent(`fx#${h.name}-g${i}`, {
          run: fakeRun(h.name, true, h.minutes),
          tree: `t-${h.name}-${i}`,
          task,
          daysAgo: 1 + (i % 20),
        }),
      );
    }
    for (let i = 0; i < (h.close ?? 0); i++) {
      events.push(
        integrationEvent(`fx#${h.name}-c${i}`, {
          epic: 'e',
          run: fakeRun(h.name, true, h.minutes),
          tree: `c-${h.name}-${i}`,
          daysAgo: 2,
        }),
      );
    }
  }
  for (let i = 0; i < (o.postMerge ?? 5); i++) {
    events.push(
      integrationEvent(`fx#pm${i}`, {
        epic: 'e',
        run: fakeRun('smoke', true, 1),
        tree: `pm-${i}`,
        tiers: ['post-merge'],
        daysAgo: 2,
      }),
    );
  }
  const first = hs[0] as Hist;
  for (let i = 0; i < (o.merges ?? 1); i++) {
    events.push(mergedEvent(`fx#m${i}`, { task: `e/${first.name}-${i}`, daysAgo: 1 }));
  }
  return { events, claims };
}

const ledgerOf = (events: StoredEvent[], claims: Record<string, string[]>) =>
  checkLedger(ledgerInputs(events, claims), { window, treeDiff: () => ['src/a.ts'] });

const NO_OVERLAY: OverlayRead = { revision: 0, entries: [] };
const rawChecks = (...names: string[]): CheckCommand[] =>
  names.map((name) => ({ name, cmd: cmdOf(name) }));
const effective = (checks: CheckCommand[], overlay: OverlayRead = NO_OVERLAY) =>
  resolveEffectiveTiers(checks, overlay);

function pendingOf(
  events: StoredEvent[],
  claims: Record<string, string[]>,
  checks: CheckCommand[],
  extra: StoredEvent[] = [],
  o: { epicId?: string; writable?: 'ok' | 'not-a-repo' | 'tracked' | 'unreadable' } = {},
) {
  const all = [...events, ...extra];
  return pendingProposals(ledgerOf(all, claims), all, effective(checks), NO_OVERLAY, {
    epicId: o.epicId ?? 'e',
    writable: o.writable ?? 'ok',
    now,
  });
}

const UNIT = (over: Partial<Hist> = {}): Hist => ({
  name: 'unit',
  gate: 25,
  close: 1,
  minutes: 4.8,
  ...over,
});

let seqId = 0;
function logged(
  type: string,
  payload: Record<string, unknown>,
  o: { id?: string; ts?: string } = {},
): StoredEvent {
  seqId += 1;
  return {
    event_id: o.id ?? `lg#${seqId}`,
    record: {
      session_id: 'lg',
      actor: 'operator',
      event_type: type,
      plan_version: 1,
      causal_parent: null,
      payload,
      ts: o.ts ?? tsAgo(0),
    },
  };
}

describe('D7 formula', () => {
  it('prices keep, post-merge and pre-release from R, M, d, B and E', () => {
    const { events, claims } = history([UNIT()]);
    const out = pendingOf(events, claims, rawChecks('unit'));
    expect(out.items).toHaveLength(1);
    const item = out.items[0] as ProposalItem;
    expect(item.options.map((o) => [o.to_tier, o.minutes_saved])).toEqual([
      ['pre-merge', 0],
      ['post-merge', 100.8],
      ['pre-release', 120],
    ]);
    for (const o of item.options) {
      expect(o.runs_covered).toBe(26);
      expect(o.minutes_spent).toBe(124.8);
    }
    const basis = (item.options[1] as ProposalItem['options'][number]).basis;
    expect(basis.B).toEqual({ value: 5, kind: 'measured' });
    expect(basis.E).toEqual({ value: 1, kind: 'measured' });
    expect(basis.R.value).toBe(26);
    expect(basis.d.value).toBe(4.8);
    expect(basis.excluded).toEqual(['probes', 'not-run']);
    expect(item.proposal_id).toMatch(/^[0-9a-f]{16}$/);
    expect(item.from_tier).toBe('pre-merge');
    expect(item.cmd_sha256).toBe(shaOf('unit'));
  });

  it('estimates B from the merges when no post-merge run exists', () => {
    const { events, claims } = history([UNIT()], { postMerge: 0, merges: 20 });
    const item = pendingOf(events, claims, rawChecks('unit')).items[0] as ProposalItem;
    const post = item.options[1] as ProposalItem['options'][number];
    expect(post.minutes_saved).toBe(28.8);
    expect(post.basis.B).toEqual({ value: 20, kind: 'estimated' });
  });

  it('leaves probes and not-run results out of R and M', () => {
    const h = history([UNIT()]);
    const probe = integrationEvent('fx#probe', {
      epic: 'e',
      run: fakeRun('unit', true, 4.8),
      tree: 'pr',
      probeOf: 'fx#x',
      daysAgo: 2,
    });
    const notRun = gateEvent('fx#nr', {
      run: fakeRun('unit', false, 0, { reason: 'heavy.wait-timeout' }),
      tree: 'nr',
      task: 'e/unit-0',
      daysAgo: 2,
    });
    const item = pendingOf(h.events, h.claims, rawChecks('unit'), [probe, notRun])
      .items[0] as ProposalItem;
    expect(item.options[0]?.runs_covered).toBe(26);
  });
});

describe('who is proposed', () => {
  it('names its thresholds', () => {
    expect([MIN_RUNS, MIN_MEASURED_MINUTES, DECLINE_QUIET_DAYS]).toEqual([20, 30, 90]);
  });

  it('proposes nothing for 19 runs', () => {
    const { events, claims } = history([UNIT({ gate: 18, minutes: 4 })]);
    expect(pendingOf(events, claims, rawChecks('unit')).items).toEqual([]);
  });

  it('proposes nothing for 29 measured minutes', () => {
    const { events, claims } = history([UNIT({ gate: 20, close: 0, minutes: 1.45 })]);
    expect(pendingOf(events, claims, rawChecks('unit')).items).toEqual([]);
    const ok = history([UNIT({ gate: 20, close: 0, minutes: 1.5 })]);
    expect(pendingOf(ok.events, ok.claims, rawChecks('unit')).items).toHaveLength(1);
  });

  it('proposes nothing for a check with a real catch in the window', () => {
    const h = history([UNIT()]);
    const caught = [
      gateEvent('fx#fail', {
        run: fakeRun('unit', false, 4.8),
        tree: 'bad',
        task: 'e/unit-0',
        daysAgo: 0.5,
      }),
      gateEvent('fx#fix', {
        run: fakeRun('unit', true, 4.8),
        tree: 'fixed',
        task: 'e/unit-0',
        daysAgo: 0.2,
      }),
    ];
    expect(pendingOf(h.events, h.claims, rawChecks('unit'), caught).items).toEqual([]);
  });

  it('proposes nothing for an unconfirmed failure, a red never followed by a pass', () => {
    const h = history([UNIT()]);
    const red = [
      gateEvent('fx#red', {
        run: fakeRun('unit', false, 4.8),
        tree: 'bad',
        task: 'e/unit-0',
        daysAgo: 0.5,
      }),
    ];
    const ledger = ledgerOf([...h.events, ...red], h.claims);
    expect(ledger.checks.find((c) => c.name === 'unit')?.unconfirmed).toHaveLength(1);
    expect(pendingOf(h.events, h.claims, rawChecks('unit'), red).items).toEqual([]);
  });

  it('proposes nothing for a sensitive-path guard', () => {
    const { events, claims } = history([UNIT({ auth: true })]);
    expect(pendingOf(events, claims, rawChecks('unit')).items).toEqual([]);
  });

  it('proposes nothing for a stage-bound check such as coverage', () => {
    const { events, claims } = history([UNIT({ name: 'coverage' })]);
    expect(pendingOf(events, claims, rawChecks('coverage')).items).toEqual([]);
  });

  it('proposes nothing for a check that declares a tier, and a declared post-merge catch is a notice', () => {
    const h = history([UNIT()]);
    const declared: CheckCommand[] = [{ name: 'unit', cmd: cmdOf('unit'), tier: 'post-merge' }];
    expect(pendingOf(h.events, h.claims, declared).items).toEqual([]);
    const caught = [
      gateEvent('fx#fail', {
        run: fakeRun('unit', false, 4.8),
        tree: 'bad',
        task: 'e/unit-0',
        daysAgo: 0.5,
      }),
      gateEvent('fx#fix', {
        run: fakeRun('unit', true, 4.8),
        tree: 'fixed',
        task: 'e/unit-0',
        daysAgo: 0.2,
      }),
    ];
    const out = pendingOf(h.events, h.claims, declared, caught);
    expect(out.items).toEqual([]);
    expect(out.notices.map((n) => [n.code, n.check])).toEqual([
      ['checks.declared-tier-catch', 'unit'],
    ]);
  });

  it('proposes nothing for a live decision, and a decline is quiet for 90 days', () => {
    const { events, claims } = history([UNIT()]);
    const id = (pendingOf(events, claims, rawChecks('unit')).items[0] as ProposalItem).proposal_id;
    const decision = (decision: string, daysAgo: number) =>
      logged(
        CHECK_TIER_DECIDED_EVENT,
        { proposal_id: id, check: 'unit', decision },
        { ts: tsAgo(daysAgo) },
      );
    const items = (extra: StoredEvent) =>
      pendingOf(events, claims, rawChecks('unit'), [extra]).items;
    expect(items(decision('approve', 400))).toEqual([]);
    expect(items(decision('decline', 89))).toEqual([]);
    expect(items(decision('decline', 91))).toHaveLength(1);
  });

  it('orders items by post-merge savings, largest first, then by check, with importance', () => {
    const h = history([
      UNIT({ name: 'small', minutes: 2 }),
      UNIT({ name: 'big', minutes: 6 }),
      UNIT({ name: 'mid', minutes: 4 }),
      UNIT({ name: 'tie', minutes: 4 }),
    ]);
    const out = pendingOf(h.events, h.claims, rawChecks('small', 'big', 'mid', 'tie'));
    expect(out.items.map((i) => i.check)).toEqual(['big', 'mid', 'tie', 'small']);
    expect(out.items.map((i) => i.importance)).toEqual([0, 0, 0, 0]);
  });

  it('shows the importance of a check with a unique catch and does not propose it', () => {
    const h = history([UNIT()]);
    const caught = [
      gateEvent('fx#fail', {
        run: fakeRun('unit', false, 4.8),
        tree: 'bad',
        task: 'e/unit-0',
        daysAgo: 0.5,
      }),
      gateEvent('fx#fix', {
        run: fakeRun('unit', true, 4.8),
        tree: 'fixed',
        task: 'e/unit-0',
        daysAgo: 0.2,
      }),
    ];
    const ledger = ledgerOf([...h.events, ...caught], h.claims);
    expect(ledger.checks.find((c) => c.name === 'unit')?.importance).toBeGreaterThan(0);
    expect(pendingOf(h.events, h.claims, rawChecks('unit'), caught).items).toEqual([]);
  });

  it('reports no items and a notice when the overlay is not writable or the ledger is degraded', () => {
    const { events, claims } = history([UNIT()]);
    for (const writable of ['unreadable', 'tracked', 'not-a-repo'] as const) {
      const out = pendingOf(events, claims, rawChecks('unit'), [], { writable });
      expect(out.items).toEqual([]);
      expect(out.notices.map((n) => n.code)).toContain(`checks.overlay-${writable}`);
    }
    const ledger = { ...ledgerOf(events, claims), degraded: true };
    const out = pendingProposals(ledger, events, effective(rawChecks('unit')), NO_OVERLAY, {
      epicId: 'e',
      writable: 'ok',
      now,
    });
    expect(out.items).toEqual([]);
    expect(out.notices.map((n) => n.code)).toContain('checks.session-unreadable');
  });
});

describe('validateDecisions', () => {
  const { events, claims } = history([UNIT()]);
  const pending = pendingOf(events, claims, rawChecks('unit')).items;
  const item = pending[0] as ProposalItem;
  const good = {
    proposal_id: item.proposal_id,
    check: 'unit',
    decision: 'approve',
    to_tier: 'post-merge',
  };
  const reasons = (json: unknown) => validateDecisions(json, pending).map((f) => f.reason);

  it('accepts the D7 example shapes', () => {
    expect(validateDecisions([good], pending)).toEqual([]);
    expect(
      validateDecisions(
        [{ proposal_id: item.proposal_id, check: 'unit', decision: 'decline', note: 'later' }],
        pending,
      ),
    ).toEqual([]);
    expect(validateDecisions([], pending)).toEqual([]);
  });

  it.each([
    ['an unknown key', { ...good, extra: 1 }, /unknown key/],
    [
      'an unknown proposal_id',
      { ...good, proposal_id: 'ffffffffffffffff' },
      /unknown or decided proposal_id/,
    ],
    ['a check that does not match', { ...good, check: 'lint' }, /does not match/],
    ['an approve without to_tier', { ...good, to_tier: undefined }, /requires to_tier/],
    [
      'a to_tier that is not an option',
      { ...good, to_tier: 'pre-merge' },
      /not one of the options/,
    ],
    ['a decline with to_tier', { ...good, decision: 'decline' }, /must not carry to_tier/],
    ['a decision of neither kind', { ...good, decision: 'maybe' }, /approve or decline/],
    ['a non-object item', 7, /object/],
  ])('refuses %s', (_name, bad, reason) => {
    const out = reasons([bad]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(reason);
  });

  it('reports every failing item, not only the first, and keeps the valid ones out', () => {
    const out = validateDecisions(
      [{ ...good, extra: 1 }, good, { ...good, proposal_id: 'ffffffffffffffff' }],
      pending,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.reason).toMatch(/unknown key/);
    expect(out[0]?.proposal_id).toBe(item.proposal_id);
    expect(out[1]?.proposal_id).toBe('ffffffffffffffff');
  });

  it('accepts a string note on approve and refuses a note that is not a string', () => {
    expect(validateDecisions([{ ...good, note: 'ok' }], pending)).toEqual([]);
    expect(reasons([{ ...good, note: 5 }])[0]).toMatch(/note must be a string/);
  });

  it('refuses an approve to a tier outside the vocabulary and an id that is not a string', () => {
    expect(reasons([{ ...good, to_tier: 'whenever' }])[0]).toMatch(/not one of the options/);
    expect(reasons([{ ...good, proposal_id: 7 }])[0]).toMatch(/unknown or decided proposal_id/);
  });

  it('refuses an item that is decided, since a decided item is no longer pending', () => {
    const decided = { ...good, decision: 'decline', to_tier: undefined };
    expect(validateDecisions([decided], [])[0]?.reason).toMatch(/unknown or decided/);
  });

  it('refuses a duplicate and a value that is not an array', () => {
    expect(reasons([good, good])).toHaveLength(1);
    expect(reasons([good, good])[0]).toMatch(/duplicate/);
    expect(reasons({})[0]).toMatch(/array/);
  });
});

// ---- apply, promotion and the overlay -------------------------------------------------

interface World {
  repo: string;
  stateDir: string;
  events: StoredEvent[];
  claims: Record<string, string[]>;
  checks: CheckCommand[];
  ctx: { session_id: string; actor: string; plan_version: number; causal_parent: string | null };
  /** What the caller gathered its ledger with: project A's plans, epic `e`, the shared state dir. */
  gather: LedgerInputsOptions;
}

/** A plan file under the specs dir, which is what makes an epic (and its sessions) a project's. */
function planFor(specsDir: string, epic: string, project: string): void {
  mkdirSync(path.join(specsDir, epic), { recursive: true });
  writeFileSync(
    path.join(specsDir, epic, 'plan.json'),
    JSON.stringify({ project, version: 1, tasks: [] }),
  );
}

async function world(names = ['unit', 'lint', 'build']): Promise<World> {
  const repo = makeRepo();
  const stateDir = tmp();
  const specsDir = tmp();
  planFor(specsDir, 'e', 'A');
  const sensitivePathsFile = path.join(specsDir, 'sensitive.yml');
  writeFileSync(sensitivePathsFile, 'globs:\n  - "src/auth/**"\n');
  const start = await appendEvent(
    {
      session_id: 's',
      actor: 'user',
      event_type: 'session-start',
      plan_version: 1,
      causal_parent: null,
      payload: { epic_id: 'e' },
    },
    { stateDir },
  );
  const h = history(names.map((name) => UNIT({ name })));
  return {
    repo,
    stateDir,
    gather: { stateDir, specsDir, sensitivePathsFile, now, windowDays: 30 },
    events: h.events,
    claims: h.claims,
    checks: rawChecks(...names),
    ctx: { session_id: 's', actor: 'operator', plan_version: 1, causal_parent: start.event_id },
  };
}

const redOf = (name: string, task: string, tree: string, id: string): StoredEvent =>
  gateEvent(id, { run: fakeRun(name, false, 4.8), tree, task, daysAgo: 0.5 });
const passOf = (name: string, task: string, tree: string, id: string): StoredEvent =>
  gateEvent(id, { run: fakeRun(name, true, 4.8), tree, task, daysAgo: 0.2 });

async function applyIn(
  w: World,
  decisions: unknown,
  o: {
    extra?: StoredEvent[];
    actor?: string;
    repo?: string;
    epicId?: string;
    degraded?: boolean;
    /** A log read before an earlier call wrote, standing in for the caller's pre-lock read. */
    snapshot?: StoredEvent[];
  } = {},
) {
  const events = o.snapshot ?? [
    ...w.events,
    ...(o.extra ?? []),
    ...(await readEvents('s', { stateDir: w.stateDir })),
  ];
  return applyTierDecisions(
    decisions,
    {
      dir: o.repo ?? w.repo,
      checksFile: 'checks.json',
      epicId: o.epicId ?? 'e',
      effectiveChecks: effective(w.checks, readOverlay(o.repo ?? w.repo)),
      actor: o.actor ?? 'operator',
      ledger: { ...ledgerOf(events, w.claims), degraded: o.degraded },
      events,
      gather: w.gather,
      now,
    },
    w.ctx,
    { events: { stateDir: w.stateDir } },
  );
}

async function pendingNow(w: World, extra: StoredEvent[] = [], epicId = 'e') {
  const log = await readEvents('s', { stateDir: w.stateDir });
  const events = [...w.events, ...extra, ...log];
  return pendingProposals(
    ledgerOf(events, w.claims),
    events,
    effective(w.checks, readOverlay(w.repo)),
    readOverlay(w.repo),
    { epicId, writable: 'ok', now },
  );
}

const approve = (i: ProposalItem, to_tier = 'post-merge') => ({
  proposal_id: i.proposal_id,
  check: i.check,
  decision: 'approve',
  to_tier,
});
const logCount = async (w: World): Promise<number> =>
  (await readEvents('s', { stateDir: w.stateDir })).length;
const typesOf = async (w: World): Promise<string[]> =>
  (await readEvents('s', { stateDir: w.stateDir })).map((e) => e.record.event_type);
const overlayBytes = (repo: string): string | null => {
  const file = overlayPath(repo) as string;
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};
const overlayTiers = (repo: string): [string, string][] => {
  const o = readOverlay(repo);
  return 'entries' in o ? o.entries.map((e) => [e.check, e.tier]) : [];
};
const decidedEvent = (check: string, to_tier: string, id: string): StoredEvent =>
  logged(
    CHECK_TIER_DECIDED_EVENT,
    {
      proposal_id: `p-${check}`,
      check,
      cmd_sha256: shaOf(check),
      from_tier: 'pre-merge',
      to_tier,
      decision: 'approve',
      note: null,
    },
    { id },
  );
const entryOf = (check: string, tier: OverlayEntry['tier'], by: string): OverlayEntry => ({
  check,
  cmd_sha256: shaOf(check),
  tier,
  decided_by_event_id: by,
  decided_at: '2026-10-30T00:00:00.000Z',
});

describe('itemBlocker', () => {
  it('passes every pending item, so an approve-all answer on an unchanged log is accepted', async () => {
    const w = await world();
    const out = await pendingNow(w);
    expect(out.items).toHaveLength(3);
    const ledger = ledgerOf(w.events, w.claims);
    for (const i of out.items) {
      expect(itemBlocker(i, ledger, effective(w.checks), now)).toBeNull();
    }
    const res = await applyIn(
      w,
      out.items.map((i) => approve(i)),
    );
    expect(res.decided).toHaveLength(3);
    expect(overlayTiers(w.repo).sort()).toEqual([
      ['build', 'post-merge'],
      ['lint', 'post-merge'],
      ['unit', 'post-merge'],
    ]);
  });

  it('names a check not in the file, a declared tier and a stage-bound check', async () => {
    const w = await world(['unit', 'coverage']);
    const ledger = ledgerOf(w.events, w.claims);
    const item = (check: string): ProposalItem =>
      ({ check, cmd_sha256: shaOf(check), from_tier: 'pre-merge' }) as ProposalItem;
    expect(itemBlocker(item('unit'), ledger, effective([]), now)).toMatch(/not in the checks file/);
    const declared = effective([{ name: 'unit', cmd: cmdOf('unit'), tier: 'post-merge' }]);
    expect(itemBlocker(item('unit'), ledger, declared, now)).toMatch(/declares its tier/);
    expect(itemBlocker(item('coverage'), ledger, effective(rawChecks('coverage')), now)).toMatch(
      /gate stage/,
    );
  });
});

describe('applyTierDecisions: refusals', () => {
  it('refuses a non-object element as a shape failure, never a TypeError', async () => {
    const w = await world();
    const before = await logCount(w);
    const bytes = overlayBytes(w.repo);
    for (const bad of [null, 7, 'x', [1], true]) {
      const err = await applyIn(w, [bad]).catch((e) => e);
      expect(err.code).toBe('checks.apply-refused');
      expect(err.items).toEqual([
        { proposal_id: '', check: '', reason: 'a decision must be an object' },
      ]);
    }
    expect(await logCount(w)).toBe(before);
    expect(overlayBytes(w.repo)).toBe(bytes);
  });

  it('refuses on a degraded ledger as the call own cause, appending nothing', async () => {
    const w = await world();
    const items = (await pendingNow(w)).items;
    const before = await logCount(w);
    const bytes = overlayBytes(w.repo);
    const err = await applyIn(w, [approve(items[0] as ProposalItem)], { degraded: true }).catch(
      (e) => e,
    );
    expect(err.code).toBe('checks.session-unreadable');
    expect(err.items).toEqual([]);
    expect(await logCount(w)).toBe(before);
    expect(overlayBytes(w.repo)).toBe(bytes);
  });

  it('refuses a whole batch naming an item that gained an S2 catch, and an unconfirmed one', async () => {
    const w = await world();
    const items = (await pendingNow(w)).items;
    const unit = items.find((i) => i.check === 'unit') as ProposalItem;
    const lint = items.find((i) => i.check === 'lint') as ProposalItem;
    const build = items.find((i) => i.check === 'build') as ProposalItem;
    const before = await logCount(w);
    const bytes = overlayBytes(w.repo);

    const s2 = [
      redOf('unit', 'e/unit-0', 'bad', 'fx#r1'),
      passOf('unit', 'e/unit-0', 'ok', 'fx#p1'),
    ];
    const err = await applyIn(w, [approve(unit), approve(build)], { extra: s2 }).catch((e) => e);
    expect(err.code).toBe('checks.apply-refused');
    expect(err.items).toEqual([
      { proposal_id: unit.proposal_id, check: 'unit', reason: 'an S1 or S2 catch in the window' },
    ]);
    expect(await logCount(w)).toBe(before);
    expect(overlayBytes(w.repo)).toBe(bytes);

    const red = [redOf('lint', 'e/lint-0', 'bad2', 'fx#r2')];
    const err2 = await applyIn(w, [approve(lint)], { extra: red }).catch((e) => e);
    expect(err2.items).toEqual([
      {
        proposal_id: lint.proposal_id,
        check: 'lint',
        reason: 'an unconfirmed failure in the window',
      },
    ]);

    // Both failing in one batch: both named, each with its reason; the rest is then accepted.
    const both = await applyIn(w, [approve(unit), approve(lint), approve(build)], {
      extra: [...s2, ...red],
    }).catch((e) => e);
    expect(both.items.map((f: { check: string; reason: string }) => [f.check, f.reason])).toEqual([
      ['unit', 'an S1 or S2 catch in the window'],
      ['lint', 'an unconfirmed failure in the window'],
    ]);
    expect(await logCount(w)).toBe(before);
    const ok = await applyIn(w, [approve(build)], { extra: [...s2, ...red] });
    expect(ok.decided).toEqual([build.proposal_id]);
    expect(await typesOf(w)).toEqual([
      'session-start',
      CHECK_TIER_DECIDED_EVENT,
      CHECK_TIER_BATCH_ANSWERED_EVENT,
    ]);
  });

  it('repairs what was already owed on a refusal, and appends and writes none of the batch', async () => {
    const w = await world();
    const done = await appendEvent(
      {
        ...w.ctx,
        event_type: CHECK_TIER_DECIDED_EVENT,
        payload: {
          proposal_id: 'old',
          check: 'unit',
          cmd_sha256: shaOf('unit'),
          from_tier: 'pre-merge',
          to_tier: 'post-merge',
          decision: 'approve',
          note: null,
        },
      },
      { stateDir: w.stateDir },
    );
    expect(done.event_id).toBeTruthy();
    expect(overlayTiers(w.repo)).toEqual([]);
    const before = await logCount(w);
    const bad = {
      proposal_id: 'ffffffffffffffff',
      check: 'lint',
      decision: 'approve',
      to_tier: 'post-merge',
    };
    const err = await applyIn(w, [bad]).catch((e) => e);
    expect(err.items.map((f: { proposal_id: string }) => f.proposal_id)).toEqual([
      'ffffffffffffffff',
    ]);
    // reconcile's repair of the logged decision is the only change
    expect(overlayTiers(w.repo)).toEqual([['unit', 'post-merge']]);
    expect(await logCount(w)).toBe(before);
    expect((await pendingNow(w)).answered_in_epic).toBe(false);
    // on the now-consistent overlay a further refusal changes nothing
    const bytes = overlayBytes(w.repo);
    await applyIn(w, [bad]).catch(() => undefined);
    expect(overlayBytes(w.repo)).toBe(bytes);
    expect(await logCount(w)).toBe(before);
  });

  it('appends only the owed check-tier-promoted when a refusal repairs a stored pending_event', async () => {
    const w = await world();
    const payload = {
      check: 'unit',
      cmd_sha256: shaOf('unit'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'rr#1',
      decided_by_event_id: 'lg#d',
    };
    writeOverlay(w.repo, {
      entries: [
        {
          ...entryOf('unit', 'pre-merge', 'lg#d'),
          pending_event: { event_type: CHECK_TIER_PROMOTED_EVENT, payload },
        },
      ],
      expectedRevision: 0,
    });
    const err = await applyIn(w, [7]).catch((e) => e);
    expect(err.code).toBe('checks.apply-refused');
    const log = await readEvents('s', { stateDir: w.stateDir });
    expect(log.map((e) => e.record.event_type)).toEqual([
      'session-start',
      CHECK_TIER_PROMOTED_EVENT,
    ]);
    expect(log[1]?.record.payload).toEqual(payload);
  });

  it('refuses a non-operator and a non-array before the lock, so nothing is repaired', async () => {
    const w = await world();
    await appendEvent(
      {
        ...w.ctx,
        event_type: CHECK_TIER_DECIDED_EVENT,
        payload: {
          proposal_id: 'old',
          check: 'unit',
          cmd_sha256: shaOf('unit'),
          from_tier: 'pre-merge',
          to_tier: 'post-merge',
          decision: 'approve',
          note: null,
        },
      },
      { stateDir: w.stateDir },
    );
    const before = await logCount(w);
    const bytes = overlayBytes(w.repo);
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    const actor = await applyIn(w, [approve(item)], { actor: 'orchestrator' }).catch((e) => e);
    expect(actor.items).toEqual([]);
    expect(actor.code).toMatch(/^checks\./);
    const notArray = await applyIn(w, {}).catch((e) => e);
    expect(notArray.items).toEqual([]);
    expect(overlayBytes(w.repo)).toBe(bytes);
    expect(await logCount(w)).toBe(before);
    expect(existsSync(path.join(w.repo, '.blacksmith', 'check-tiers.lock'))).toBe(false);
  });

  it('refuses a lock still busy when the wait ends as checks.overlay-busy with no items', async () => {
    const w = await world();
    let release: () => void = () => undefined;
    const held = withOverlayLock(
      w.repo,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const call = applyIn(w, [])
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    // Steps until the call settles: under machine load its pre-lock reads can take
    // longer than a fixed number of steps, and a fake timer left pending never fires.
    for (let i = 0; i < 2000 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    vi.useRealTimers();
    const err = await call;
    expect(err.code).toBe('checks.overlay-busy');
    expect(err.items).toEqual([]);
    expect(await logCount(w)).toBe(1);
    release();
    await held;
  });

  it('refuses outside a repository without creating anything', async () => {
    const w = await world();
    const plain = tmp();
    const err = await applyIn(w, [], { repo: plain }).catch((e) => e);
    expect(err.code).toBe('checks.overlay-not-a-repo');
    expect(err.items).toEqual([]);
    expect(existsSync(path.join(plain, '.blacksmith'))).toBe(false);
    expect(await logCount(w)).toBe(1);
  });

  it('refuses before appending anything when the overlay is unreadable or tracked', async () => {
    for (const how of ['unreadable', 'tracked'] as const) {
      const w = await world();
      const file = overlayPath(w.repo) as string;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        how === 'unreadable' ? '{nope' : '{"version":1,"revision":0,"entries":[]}\n',
      );
      if (how === 'tracked') {
        git(w.repo, 'add', '-f', '.blacksmith/check-tiers.json');
        git(w.repo, 'commit', '-q', '-m', 'track');
      }
      const err = await applyIn(w, []).catch((e) => e);
      expect(err.code).toBe(`checks.overlay-${how}`);
      expect(err.items).toEqual([]);
      expect(await logCount(w)).toBe(1);
    }
  });
});

describe('applyTierDecisions: a valid batch', () => {
  it('appends one decision per item, then the overlay, never touching the checks file', async () => {
    const w = await world();
    const checksFile = path.join(w.repo, 'checks.json');
    const bytes = readFileSync(checksFile);
    const mtime = statSync(checksFile).mtimeMs;
    const items = (await pendingNow(w)).items;
    const [a, b] = items as [ProposalItem, ProposalItem];
    const out = await applyIn(w, [
      approve(a, 'pre-release'),
      { proposal_id: b.proposal_id, check: b.check, decision: 'decline', note: 'later' },
    ]);
    expect(out.decided).toEqual([a.proposal_id, b.proposal_id]);
    expect(out.pending).toEqual([items[2]?.proposal_id]);
    expect(await typesOf(w)).toEqual([
      'session-start',
      CHECK_TIER_DECIDED_EVENT,
      CHECK_TIER_DECIDED_EVENT,
      CHECK_TIER_BATCH_ANSWERED_EVENT,
    ]);
    const log = await readEvents('s', { stateDir: w.stateDir });
    expect(log[1]?.record.payload).toEqual({
      epic_id: 'e',
      proposal_id: a.proposal_id,
      check: a.check,
      cmd_sha256: a.cmd_sha256,
      from_tier: 'pre-merge',
      to_tier: 'pre-release',
      decision: 'approve',
      note: null,
    });
    expect(log[2]?.record.payload).toMatchObject({
      to_tier: null,
      decision: 'decline',
      note: 'later',
    });
    expect(log[3]?.record.payload).toEqual({
      epic_id: 'e',
      decided: [a.proposal_id, b.proposal_id],
      pending: [items[2]?.proposal_id],
    });
    expect(overlayTiers(w.repo)).toEqual([[a.check, 'pre-release']]);
    expect(readFileSync(checksFile).equals(bytes)).toBe(true);
    expect(statSync(checksFile).mtimeMs).toBe(mtime);
    // decided items do not resurface
    const after = (await pendingNow(w)).items.map((i) => i.check);
    expect(after).toEqual([items[2]?.check]);
  });

  it('leaves the checks file alone when git tracks it', async () => {
    const w = await world();
    const checksFile = path.join(w.repo, 'checks.json');
    expect(git(w.repo, 'ls-files', 'checks.json').trim()).toBe('checks.json');
    const bytes = readFileSync(checksFile);
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    await applyIn(w, [approve(item)]);
    expect(readFileSync(checksFile).equals(bytes)).toBe(true);
    expect(git(w.repo, 'status', '--porcelain', 'checks.json')).toBe('');
  });

  it('waits for a live lock holder with the default wait and then succeeds', async () => {
    const w = await world();
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    const held = withOverlayLock(
      w.repo,
      () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    );
    const t0 = Date.now();
    const out = await applyIn(w, [approve(item)]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(out.decided).toEqual([item.proposal_id]);
    await held;
  });
});

describe('applyTierDecisions: convergence after a crash', () => {
  it('writes an approved tier the log holds and the overlay lacks, once', async () => {
    const w = await world();
    const done = await appendEvent(
      {
        ...w.ctx,
        event_type: CHECK_TIER_DECIDED_EVENT,
        payload: {
          proposal_id: 'old',
          check: 'unit',
          cmd_sha256: shaOf('unit'),
          from_tier: 'pre-merge',
          to_tier: 'post-merge',
          decision: 'approve',
          note: null,
        },
      },
      { stateDir: w.stateDir },
    );
    expect(done.event_id).toBeTruthy();
    const logEvents = await readEvents('s', { stateDir: w.stateDir });
    expect(effective(w.checks, readOverlay(w.repo)).find((c) => c.name === 'unit')?.tier).toBe(
      'pre-merge',
    );
    expect(logEvents).toHaveLength(2);
    await applyIn(w, []);
    expect(overlayTiers(w.repo)).toEqual([['unit', 'post-merge']]);
    expect(await typesOf(w)).toEqual([
      'session-start',
      CHECK_TIER_DECIDED_EVENT,
      CHECK_TIER_BATCH_ANSWERED_EVENT,
    ]);
  });

  it('appends an owed check-tier-promoted exactly as stored, once', async () => {
    const w = await world();
    const payload = {
      check: 'unit',
      cmd_sha256: shaOf('unit'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'rr#1',
      decided_by_event_id: 'lg#d',
    };
    writeOverlay(w.repo, {
      entries: [
        {
          ...entryOf('unit', 'pre-merge', 'lg#d'),
          pending_event: { event_type: CHECK_TIER_PROMOTED_EVENT, payload },
        },
      ],
      expectedRevision: 0,
    });
    await applyIn(w, []);
    await applyIn(w, []);
    const log = await readEvents('s', { stateDir: w.stateDir });
    const promoted = log.filter((e) => e.record.event_type === CHECK_TIER_PROMOTED_EVENT);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.record.payload).toEqual(payload);
    const o = readOverlay(w.repo);
    expect('entries' in o && o.entries[0]).not.toHaveProperty('pending_event');
  });
});

describe('batch answered and hand-off', () => {
  it('records an empty answer for the epic it is given, and only for that epic', async () => {
    const w = await world();
    const out = await applyIn(w, []);
    expect(out.decided).toEqual([]);
    expect(await typesOf(w)).toEqual(['session-start', CHECK_TIER_BATCH_ANSWERED_EVENT]);
    expect((await pendingNow(w, [], 'e')).answered_in_epic).toBe(true);
    expect((await pendingNow(w, [], 'other')).answered_in_epic).toBe(false);
  });

  it('hands a refused reply off without a lock, and an accepted apply ends it', async () => {
    const w = await world();
    const refusal = await applyIn(w, {}).catch((e) => e);
    expect(refusal.items).toEqual([]);
    const before = await pendingNow(w);
    expect(before.answered_in_epic).toBe(false);
    expect(before.handed_off).toBeNull();

    const file = overlayPath(w.repo) as string;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"version":1,"revision":0,"entries":[]}\n');
    let release: () => void = () => undefined;
    const held = withOverlayLock(
      w.repo,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const lockFile = path.join(path.dirname(file), 'check-tiers.lock');
    const lockBytes = readFileSync(lockFile, 'utf8');
    const overlayBefore = overlayBytes(w.repo);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const call = recordBatchHandOff(
      'e',
      {
        code: refusal.code,
        decisionsPath: 'out/decisions.json',
        pending: before.items.map((i) => i.proposal_id),
      },
      w.ctx,
      { events: { stateDir: w.stateDir } },
    );
    await vi.advanceTimersByTimeAsync(OVERLAY_LOCK_WAIT_MS + 1000);
    const { eventId } = await call;
    vi.useRealTimers();
    expect(eventId).toBeTruthy();
    expect(readFileSync(lockFile, 'utf8')).toBe(lockBytes);
    expect(overlayBytes(w.repo)).toBe(overlayBefore);
    release();
    await held;
    const log = await readEvents('s', { stateDir: w.stateDir });
    const answered = log.filter((e) => e.record.event_type === CHECK_TIER_BATCH_ANSWERED_EVENT);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.event_id).toBe(eventId);
    expect(answered[0]?.record.payload).toEqual({
      epic_id: 'e',
      decided: [],
      pending: before.items.map((i) => i.proposal_id),
      handed_off: { code: refusal.code, decisions_path: 'out/decisions.json' },
    });

    const after = await pendingNow(w);
    expect(after.answered_in_epic).toBe(true);
    expect(after.items.map((i) => i.proposal_id)).toEqual(before.items.map((i) => i.proposal_id));
    expect(after.handed_off).toEqual({
      code: refusal.code,
      decisions_path: 'out/decisions.json',
      event_id: eventId,
    });

    await applyIn(w, [approve(after.items[0] as ProposalItem)]);
    const ended = await pendingNow(w);
    expect(ended.handed_off).toBeNull();
    expect(ended.items.map((i) => i.proposal_id)).not.toContain(after.items[0]?.proposal_id);
  });
});

// ---- automatic promotion --------------------------------------------------------------

interface Promo {
  w: World;
  events: StoredEvent[];
  culprit: { failing_checks: string[]; red_record_event_id: string; reproduced: true };
}

const PROMO_CTX = (w: World) => w.ctx;

async function promoWorld(
  o: { gapMs?: number; reason?: string; declared?: boolean; overlay?: boolean } = {},
): Promise<Promo> {
  const w = await world(['unit']);
  const decided = decidedEvent('unit', 'post-merge', 'lg#d');
  const red = integrationEvent('rr#1', {
    epic: 'e',
    run: fakeRun('unit', false, 5, o),
    tree: 'rt',
    tiers: ['post-merge'],
  });
  if (o.overlay !== false) {
    writeOverlay(w.repo, { entries: [entryOf('unit', 'post-merge', 'lg#d')], expectedRevision: 0 });
  }
  if (o.declared === true) w.checks = [{ name: 'unit', cmd: cmdOf('unit'), tier: 'post-merge' }];
  return {
    w,
    events: [decided, red],
    culprit: { failing_checks: ['unit'], red_record_event_id: 'rr#1', reproduced: true },
  };
}

const promote = (p: Promo, culprit = p.culprit, events = p.events) =>
  promoteAfterCatch(
    culprit,
    { dir: p.w.repo, checks: p.w.checks, events, gather: p.w.gather },
    PROMO_CTX(p.w),
    { events: { stateDir: p.w.stateDir } },
  );

describe('promoteAfterCatch', () => {
  it.each(['reverted', 'revert-has-dependents', 'revert-red'])(
    'promotes an overlay-demoted check back to pre-merge (%s)',
    async () => {
      const p = await promoWorld();
      expect(await promote(p)).toEqual([{ check: 'unit', result: 'promoted', reason: null }]);
      expect(overlayTiers(p.w.repo)).toEqual([['unit', 'pre-merge']]);
      const o = readOverlay(p.w.repo);
      expect('entries' in o && o.entries[0]).not.toHaveProperty('pending_event');
      const log = await readEvents('s', { stateDir: p.w.stateDir });
      expect(log.map((e) => e.record.event_type)).toEqual([
        'session-start',
        CHECK_TIER_PROMOTED_EVENT,
      ]);
      expect(log[1]?.record.payload).toEqual({
        epic_id: 'e',
        check: 'unit',
        cmd_sha256: shaOf('unit'),
        from_tier: 'post-merge',
        to_tier: 'pre-merge',
        catch_event_id: 'rr#1',
        decided_by_event_id: 'lg#d',
      });
    },
  );

  it('answers every other case whole', async () => {
    const declared = await promoWorld({ declared: true });
    expect(await promote(declared)).toEqual([
      { check: 'unit', result: 'declared-tier-wins', reason: null },
    ]);
    const env = await promoWorld({ gapMs: 40_000 });
    expect(await promote(env)).toEqual([
      { check: 'unit', result: 'not-promoted', reason: 'env-failure' },
    ]);
    const notRun = await promoWorld({ reason: 'heavy.wait-timeout' });
    expect(await promote(notRun)).toEqual([
      { check: 'unit', result: 'not-promoted', reason: 'not-run' },
    ]);
    const none = await promoWorld({ overlay: false });
    expect(await promote(none)).toEqual([
      { check: 'unit', result: 'not-promoted', reason: 'not-demoted' },
    ]);
    const lost = await promoWorld();
    expect(await promote(lost, lost.culprit, [lost.events[0] as StoredEvent])).toEqual([
      { check: 'unit', result: 'promotion-skipped', reason: 'red-record-unreadable' },
    ]);
    for (const p of [declared, env, notRun, none, lost]) {
      expect(await typesOf(p.w)).toEqual(['session-start']);
    }
  });

  it('does not undo an owed promotion it repaired when it promotes a second check', async () => {
    const w = await world(['unit', 'lint', 'build']);
    w.checks = rawChecks('unit', 'lint', 'build');
    const payload = {
      check: 'build',
      cmd_sha256: shaOf('build'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'rr#0',
      decided_by_event_id: 'lg#b',
    };
    writeOverlay(w.repo, {
      entries: [
        entryOf('unit', 'post-merge', 'lg#u'),
        entryOf('lint', 'post-merge', 'lg#l'),
        {
          ...entryOf('build', 'pre-merge', 'lg#b'),
          pending_event: { event_type: CHECK_TIER_PROMOTED_EVENT, payload },
        },
      ],
      expectedRevision: 0,
    });
    const red = integrationEvent('rr#1', {
      epic: 'e',
      run: {
        pass: false,
        results: [...fakeRun('unit', false, 5).results, ...fakeRun('lint', false, 5).results],
        environment: [
          ...(fakeRun('unit', false, 5).environment ?? []),
          ...(fakeRun('lint', false, 5).environment ?? []),
        ],
      } as unknown as RunResult,
      tree: 'rt',
      tiers: ['post-merge'],
    });
    const p: Promo = {
      w,
      events: [
        decidedEvent('unit', 'post-merge', 'lg#u'),
        decidedEvent('lint', 'post-merge', 'lg#l'),
        decidedEvent('build', 'post-merge', 'lg#b'),
        red,
      ],
      culprit: { failing_checks: ['unit', 'lint'], red_record_event_id: 'rr#1', reproduced: true },
    };
    expect((await promote(p)).map((a) => a.result)).toEqual(['promoted', 'promoted']);
    expect(overlayTiers(w.repo)).toEqual([
      ['unit', 'pre-merge'],
      ['lint', 'pre-merge'],
      ['build', 'pre-merge'],
    ]);
    expect((await typesOf(w)).filter((t) => t === CHECK_TIER_PROMOTED_EVENT)).toHaveLength(3);
  });

  it('answers a two-check culprit in failing_checks order', async () => {
    const w = await world(['unit', 'lint']);
    writeOverlay(w.repo, { entries: [entryOf('unit', 'post-merge', 'lg#d')], expectedRevision: 0 });
    w.checks = [
      { name: 'unit', cmd: cmdOf('unit') },
      { name: 'lint', cmd: cmdOf('lint'), tier: 'post-merge' },
    ];
    const red = integrationEvent('rr#1', {
      epic: 'e',
      run: {
        pass: false,
        results: [...fakeRun('unit', false, 5).results, ...fakeRun('lint', false, 5).results],
        environment: [
          ...(fakeRun('unit', false, 5).environment ?? []),
          ...(fakeRun('lint', false, 5).environment ?? []),
        ],
      } as unknown as RunResult,
      tree: 'rt',
      tiers: ['post-merge'],
    });
    const p: Promo = {
      w,
      events: [decidedEvent('unit', 'post-merge', 'lg#d'), red],
      culprit: { failing_checks: ['unit', 'lint'], red_record_event_id: 'rr#1', reproduced: true },
    };
    expect(await promote(p)).toEqual([
      { check: 'unit', result: 'promoted', reason: null },
      { check: 'lint', result: 'declared-tier-wins', reason: null },
    ]);
  });

  it('waits for a held lock with the default wait, then promotes', async () => {
    const p = await promoWorld();
    let release: () => void = () => undefined;
    const held = withOverlayLock(
      p.w.repo,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    setTimeout(() => release(), 1000);
    const t0 = Date.now();
    expect(await promote(p)).toEqual([{ check: 'unit', result: 'promoted', reason: null }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    await held;
  });

  describe('with the lock held past the wait', () => {
    it('answers the no-promotion cases without the lock or a reconcile, and the busy one as an answer', async () => {
      const w = await world(['unit', 'lint', 'build', 'env', 'idle']);
      const decided = [
        decidedEvent('unit', 'post-merge', 'lg#d'),
        decidedEvent('build', 'post-merge', 'lg#b'),
      ];
      writeOverlay(w.repo, {
        entries: [entryOf('unit', 'post-merge', 'lg#d')],
        expectedRevision: 0,
      });
      w.checks = [
        { name: 'unit', cmd: cmdOf('unit') },
        { name: 'lint', cmd: cmdOf('lint'), tier: 'post-merge' },
        { name: 'build', cmd: cmdOf('build') },
        { name: 'env', cmd: cmdOf('env') },
        { name: 'idle', cmd: cmdOf('idle') },
      ];
      const red = (id: string, name: string, o: { gapMs?: number; reason?: string } = {}) =>
        integrationEvent(id, {
          epic: 'e',
          run: fakeRun(name, false, 5, o),
          tree: id,
          tiers: ['post-merge'],
        });
      const events = [
        ...decided,
        red('rr#lint', 'lint'),
        red('rr#env', 'unit', { gapMs: 40_000 }),
        red('rr#nr', 'unit', { reason: 'heavy.wait-timeout' }),
        red('rr#build', 'idle'),
        red('rr#ok', 'unit'),
      ];
      const culprit = (check: string, rec: string) => ({
        failing_checks: [check],
        red_record_event_id: rec,
        reproduced: true as const,
      });
      const p = (c: ReturnType<typeof culprit>) =>
        promoteAfterCatch(c, { dir: w.repo, checks: w.checks, events, gather: w.gather }, w.ctx, {
          events: { stateDir: w.stateDir },
        });
      const lock = path.join(w.repo, '.blacksmith', 'check-tiers.lock');
      let release: () => void = () => undefined;
      const held = withOverlayLock(
        w.repo,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const lockBytes = readFileSync(lock, 'utf8');
      const overlayBefore = overlayBytes(w.repo);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const calls = [
        p(culprit('lint', 'rr#lint')),
        p(culprit('unit', 'rr#env')),
        p(culprit('unit', 'rr#nr')),
        p(culprit('idle', 'rr#build')),
        p(culprit('unit', 'rr#gone')),
        p(culprit('unit', 'rr#ok')),
      ];
      await vi.advanceTimersByTimeAsync(OVERLAY_LOCK_WAIT_MS + 1000);
      const answers = await Promise.all(calls);
      vi.useRealTimers();
      expect(answers).toEqual([
        [{ check: 'lint', result: 'declared-tier-wins', reason: null }],
        [{ check: 'unit', result: 'not-promoted', reason: 'env-failure' }],
        [{ check: 'unit', result: 'not-promoted', reason: 'not-run' }],
        [{ check: 'idle', result: 'not-promoted', reason: 'not-demoted' }],
        [{ check: 'unit', result: 'promotion-skipped', reason: 'red-record-unreadable' }],
        [{ check: 'unit', result: 'promotion-skipped', reason: 'checks.overlay-busy' }],
      ]);
      expect(readFileSync(lock, 'utf8')).toBe(lockBytes);
      expect(overlayBytes(w.repo)).toBe(overlayBefore);
      expect(await typesOf(w)).toEqual(['session-start']);
      release();
      await held;
    });
  });

  it('answers the cases reachable without an overlay and creates no .blacksmith', async () => {
    const w = await world(['unit', 'lint']);
    w.checks = [
      { name: 'unit', cmd: cmdOf('unit') },
      { name: 'lint', cmd: cmdOf('lint'), tier: 'post-merge' },
    ];
    const red = integrationEvent('rr#1', {
      epic: 'e',
      run: fakeRun('unit', false, 5),
      tree: 'rt',
      tiers: ['post-merge'],
    });
    const lintRed = integrationEvent('rr#2', {
      epic: 'e',
      run: fakeRun('lint', false, 5),
      tree: 'rt2',
      tiers: ['post-merge'],
    });
    const go = (check: string, rec: string) =>
      promoteAfterCatch(
        { failing_checks: [check], red_record_event_id: rec, reproduced: true },
        { dir: w.repo, checks: w.checks, events: [red, lintRed], gather: w.gather },
        w.ctx,
        { events: { stateDir: w.stateDir } },
      );
    expect(await go('lint', 'rr#2')).toEqual([
      { check: 'lint', result: 'declared-tier-wins', reason: null },
    ]);
    expect(await go('unit', 'rr#1')).toEqual([
      { check: 'unit', result: 'not-promoted', reason: 'not-demoted' },
    ]);
    expect(await go('unit', 'rr#gone')).toEqual([
      { check: 'unit', result: 'promotion-skipped', reason: 'red-record-unreadable' },
    ]);
    expect(existsSync(path.join(w.repo, '.blacksmith'))).toBe(false);
  });
});

describe('under the lock, apply and promotion read the current log', () => {
  it('a second apply of one decisions.json from one stale read is refused and appends nothing', async () => {
    const w = await world();
    const snapshot = [...w.events, ...(await readEvents('s', { stateDir: w.stateDir }))];
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    const first = await applyIn(w, [approve(item)], { snapshot });
    expect(first.decided).toEqual([item.proposal_id]);
    const before = await typesOf(w);
    const bytes = overlayBytes(w.repo);
    const second = await applyIn(w, [approve(item)], { snapshot }).catch((e) => e);
    expect(second.code).toBe('checks.apply-refused');
    expect(second.items.map((i: { reason: string }) => i.reason)).toEqual([
      'unknown or decided proposal_id',
    ]);
    expect(await typesOf(w)).toEqual(before);
    expect(before.filter((t) => t === CHECK_TIER_DECIDED_EVENT)).toHaveLength(1);
    expect(before.filter((t) => t === CHECK_TIER_BATCH_ANSWERED_EVENT)).toHaveLength(1);
    expect(overlayBytes(w.repo)).toBe(bytes);
  });

  it('an apply from a read taken before a promotion leaves the promoted check at pre-merge', async () => {
    const p = await promoWorld();
    const snapshot = [...p.w.events, ...p.events];
    expect(await promote(p)).toEqual([{ check: 'unit', result: 'promoted', reason: null }]);
    const res = await applyIn(p.w, [], { snapshot });
    expect(res.decided).toEqual([]);
    expect(overlayTiers(p.w.repo)).toEqual([['unit', 'pre-merge']]);
    expect(await typesOf(p.w)).toEqual([
      'session-start',
      CHECK_TIER_PROMOTED_EVENT,
      CHECK_TIER_BATCH_ANSWERED_EVENT,
    ]);
  });

  it('a promotion waiting on the lock sees the promotion made while it waited and appends no second one', async () => {
    const p = await promoWorld();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withOverlayLock(
      p.w.repo,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await inside;
    // Passes its unlocked reads (the overlay still says post-merge), then waits for the lock.
    const waiting = promote(p);
    const payload = {
      check: 'unit',
      cmd_sha256: shaOf('unit'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'rr#0',
      decided_by_event_id: 'lg#d',
    };
    // What the lock holder's own promotion leaves: overlay at pre-merge, its event logged.
    writeOverlay(p.w.repo, {
      entries: [entryOf('unit', 'pre-merge', 'lg#d')],
      expectedRevision: 1,
    });
    await appendEvent(
      { ...p.w.ctx, event_type: CHECK_TIER_PROMOTED_EVENT, payload },
      { stateDir: p.w.stateDir },
    );
    release();
    await held;
    expect(await waiting).toEqual([
      { check: 'unit', result: 'not-promoted', reason: 'not-demoted' },
    ]);
    expect(overlayTiers(p.w.repo)).toEqual([['unit', 'pre-merge']]);
    expect(await typesOf(p.w)).toEqual(['session-start', CHECK_TIER_PROMOTED_EVENT]);
  });
});

// A session log in the same state directory: by default another project's (epic `eb`,
// whose plan is not under project A's specs dir); with epic `e`, one of project A's.
async function foreignLog(
  stateDir: string,
  sessionId: string,
  events: { type: string; payload: Record<string, unknown> }[],
  epic = 'eb',
) {
  let parent = (
    await appendEvent(
      {
        session_id: sessionId,
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: { epic_id: epic },
      },
      { stateDir },
    )
  ).event_id;
  for (const e of events) {
    parent = (
      await appendEvent(
        {
          session_id: sessionId,
          actor: 'operator',
          event_type: e.type,
          plan_version: 1,
          causal_parent: parent,
          payload: e.payload,
        },
        { stateDir },
      )
    ).event_id;
  }
}

describe("under the lock, apply and promotion read only their own project's sessions", () => {
  it("project A's apply neither sees nor acts on project B's decision in the shared state dir", async () => {
    const w = await world();
    const item = (await pendingNow(w)).items.find((i) => i.check === 'unit') as ProposalItem;
    await foreignLog(w.stateDir, 'b', [
      {
        type: CHECK_TIER_DECIDED_EVENT,
        payload: {
          proposal_id: item.proposal_id,
          check: 'unit',
          cmd_sha256: shaOf('unit'),
          from_tier: 'pre-merge',
          to_tier: 'post-merge',
          decision: 'approve',
          note: null,
        },
      },
    ]);
    const empty = await applyIn(w, []);
    expect(empty.decided).toEqual([]);
    expect(overlayBytes(w.repo)).toBeNull();
    expect(empty.pending).toContain(item.proposal_id);
    const res = await applyIn(w, [approve(item, 'post-merge')]);
    expect(res.decided).toEqual([item.proposal_id]);
    const o = readOverlay(w.repo);
    const by = 'entries' in o ? o.entries.map((e) => e.decided_by_event_id) : [];
    expect(by).toHaveLength(1);
    expect(by[0]?.startsWith('s#')).toBe(true);
  });

  it("project A's promotion is not stopped by project B's promotion of the same check", async () => {
    const p = await promoWorld();
    await foreignLog(p.w.stateDir, 'b', [
      {
        type: CHECK_TIER_PROMOTED_EVENT,
        payload: {
          check: 'unit',
          cmd_sha256: shaOf('unit'),
          from_tier: 'post-merge',
          to_tier: 'pre-merge',
          catch_event_id: 'rr#9',
          decided_by_event_id: 'lg#d',
        },
      },
    ]);
    expect(await promote(p)).toEqual([{ check: 'unit', result: 'promoted', reason: null }]);
    expect(await typesOf(p.w)).toEqual(['session-start', CHECK_TIER_PROMOTED_EVENT]);
  });

  it('an unreadable line in its own session refuses apply as checks.session-unreadable, changing nothing', async () => {
    const w = await world();
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    const snapshot = [...w.events, ...(await readEvents('s', { stateDir: w.stateDir }))];
    const file = path.join(w.stateDir, 's.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n`);
    const bytes = readFileSync(file, 'utf8');
    const err = await applyIn(w, [approve(item)], { snapshot }).catch((e) => e);
    expect(err.code).toBe('checks.session-unreadable');
    expect(err.items).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(overlayBytes(w.repo)).toBeNull();
  });

  it('an unreadable line in its own session answers promotion-skipped, never a throw', async () => {
    const p = await promoWorld();
    const file = path.join(p.w.stateDir, 's.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n`);
    const bytes = readFileSync(file, 'utf8');
    const overlay = overlayBytes(p.w.repo);
    expect(await promote(p)).toEqual([
      { check: 'unit', result: 'promotion-skipped', reason: 'checks.session-unreadable' },
    ]);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(overlayBytes(p.w.repo)).toBe(overlay);
  });
});

const decidedPayload = (proposal_id: string, check = 'unit') => ({
  proposal_id,
  check,
  cmd_sha256: shaOf(check),
  from_tier: 'pre-merge',
  to_tier: 'post-merge',
  decision: 'approve',
  note: null,
});
const promotedPayload = (decidedBy: string, catchId = 'rr#0') => ({
  check: 'unit',
  cmd_sha256: shaOf('unit'),
  from_tier: 'post-merge',
  to_tier: 'pre-merge',
  catch_event_id: catchId,
  decided_by_event_id: decidedBy,
});
const typesIn = async (stateDir: string, sessionId: string): Promise<string[]> =>
  (await readEvents(sessionId, { stateDir })).map((e) => e.record.event_type);

describe('under the lock, apply and promotion read the project log task-13 gathers', () => {
  it('an apply sees a promotion made in a project session its snapshot never held, and neither undoes nor repeats it', async () => {
    const p = await promoWorld();
    const snapshot = [
      ...p.w.events,
      ...p.events,
      ...(await readEvents('s', { stateDir: p.w.stateDir })),
    ];
    // The previous lock holder, in session `p` (absent from the snapshot), promoted unit.
    writeOverlay(p.w.repo, {
      entries: [entryOf('unit', 'pre-merge', 'lg#d')],
      expectedRevision: 1,
    });
    await foreignLog(
      p.w.stateDir,
      'p',
      [{ type: CHECK_TIER_PROMOTED_EVENT, payload: promotedPayload('lg#d') }],
      'e',
    );
    const res = await applyIn(p.w, [], { snapshot });
    expect(res.decided).toEqual([]);
    expect(overlayTiers(p.w.repo)).toEqual([['unit', 'pre-merge']]);
    expect(await typesOf(p.w)).toEqual(['session-start', CHECK_TIER_BATCH_ANSWERED_EVENT]);
    expect(await typesIn(p.w.stateDir, 'p')).toEqual(['session-start', CHECK_TIER_PROMOTED_EVENT]);
  });

  it('a promotion waiting on the lock sees a promotion made in a project session its snapshot never held', async () => {
    const p = await promoWorld();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withOverlayLock(
      p.w.repo,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await inside;
    const waiting = promote(p);
    writeOverlay(p.w.repo, {
      entries: [entryOf('unit', 'pre-merge', 'lg#d')],
      expectedRevision: 1,
    });
    await foreignLog(
      p.w.stateDir,
      'p',
      [{ type: CHECK_TIER_PROMOTED_EVENT, payload: promotedPayload('lg#d') }],
      'e',
    );
    release();
    await held;
    expect(await waiting).toEqual([
      { check: 'unit', result: 'not-promoted', reason: 'not-demoted' },
    ]);
    expect(overlayTiers(p.w.repo)).toEqual([['unit', 'pre-merge']]);
    expect(await typesOf(p.w)).toEqual(['session-start']);
    expect(await typesIn(p.w.stateDir, 'p')).toEqual(['session-start', CHECK_TIER_PROMOTED_EVENT]);
  });

  it('an apply sees a race written into a snapshot session other than its own', async () => {
    const w = await world(['unit']);
    // Session `t`, a real log of project A, holds the approve the overlay entry names.
    await foreignLog(
      w.stateDir,
      't',
      [{ type: CHECK_TIER_DECIDED_EVENT, payload: decidedPayload('p-unit') }],
      'e',
    );
    const tLog = await readEvents('t', { stateDir: w.stateDir });
    const decided = tLog[1] as StoredEvent;
    writeOverlay(w.repo, {
      entries: [entryOf('unit', 'post-merge', decided.event_id)],
      expectedRevision: 0,
    });
    const snapshot = [...w.events, ...(await readEvents('s', { stateDir: w.stateDir })), ...tLog];
    // After the snapshot, the lock holder in `t` promoted unit.
    writeOverlay(w.repo, {
      entries: [entryOf('unit', 'pre-merge', decided.event_id)],
      expectedRevision: 1,
    });
    await appendEvent(
      {
        session_id: 't',
        actor: 'operator',
        event_type: CHECK_TIER_PROMOTED_EVENT,
        plan_version: 1,
        causal_parent: decided.event_id,
        payload: promotedPayload(decided.event_id),
      },
      { stateDir: w.stateDir },
    );
    const res = await applyIn(w, [], { snapshot });
    expect(res.decided).toEqual([]);
    expect(overlayTiers(w.repo)).toEqual([['unit', 'pre-merge']]);
    expect(await typesOf(w)).toEqual(['session-start', CHECK_TIER_BATCH_ANSWERED_EVENT]);
    expect(await typesIn(w.stateDir, 't')).toEqual([
      'session-start',
      CHECK_TIER_DECIDED_EVENT,
      CHECK_TIER_PROMOTED_EVENT,
    ]);
  });

  it('keeps an approve older than the ledger window: a 200-day-old decision the snapshot lacks is written, not re-proposed', async () => {
    const w = await world(['unit']);
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    const snapshot = [...w.events, ...(await readEvents('s', { stateDir: w.stateDir }))];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW - 200 * DAY_MS);
    await foreignLog(
      w.stateDir,
      't',
      [{ type: CHECK_TIER_DECIDED_EVENT, payload: decidedPayload(item.proposal_id) }],
      'e',
    );
    vi.useRealTimers();
    const old = (await readEvents('t', { stateDir: w.stateDir }))[1] as StoredEvent;
    expect(Date.parse(old.record.ts)).toBeLessThan(NOW - w.gather.windowDays * DAY_MS);
    const res = await applyIn(w, [], { snapshot });
    expect(res.pending).toEqual([]);
    expect(overlayTiers(w.repo)).toEqual([['unit', 'post-merge']]);
    const o = readOverlay(w.repo);
    expect('entries' in o && o.entries[0]?.decided_by_event_id).toBe(old.event_id);
  });

  it('refuses apply and skips promotion when any session log in the state dir is unreadable, changing nothing', async () => {
    const w = await world();
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    writeFileSync(path.join(w.stateDir, 'b2.jsonl'), 'not json\n');
    const err = await applyIn(w, [approve(item)]).catch((e) => e);
    expect(err.code).toBe('checks.session-unreadable');
    expect(err.items).toEqual([]);
    expect(await typesOf(w)).toEqual(['session-start']);
    expect(overlayBytes(w.repo)).toBeNull();

    const p = await promoWorld();
    writeFileSync(path.join(p.w.stateDir, 'b2.jsonl'), 'not json\n');
    const overlay = overlayBytes(p.w.repo);
    expect(await promote(p)).toEqual([
      { check: 'unit', result: 'promotion-skipped', reason: 'checks.session-unreadable' },
    ]);
    expect(await typesOf(p.w)).toEqual(['session-start']);
    expect(overlayBytes(p.w.repo)).toBe(overlay);
  });

  it('refuses apply and skips promotion when the plans name two projects, changing nothing', async () => {
    const w = await world();
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    planFor(w.gather.specsDir, 'x', 'B');
    const err = await applyIn(w, [approve(item)]).catch((e) => e);
    expect(err.code).toBe('checks.session-unreadable');
    expect(err.items).toEqual([]);
    expect(await typesOf(w)).toEqual(['session-start']);
    expect(overlayBytes(w.repo)).toBeNull();

    const p = await promoWorld();
    planFor(p.w.gather.specsDir, 'x', 'B');
    const overlay = overlayBytes(p.w.repo);
    expect(await promote(p)).toEqual([
      { check: 'unit', result: 'promotion-skipped', reason: 'checks.session-unreadable' },
    ]);
    expect(await typesOf(p.w)).toEqual(['session-start']);
    expect(overlayBytes(p.w.repo)).toBe(overlay);
  });
});

describe('every write carries the epic id, and the under-lock log is in time order', () => {
  /** Two overlay-demoted checks whose approves sit in project session `s`, and one red run failing both. */
  async function twoDemoted() {
    const w = await world(['unit', 'lint']);
    const ids: Record<string, string> = {};
    for (const check of ['unit', 'lint']) {
      ids[check] = (
        await appendEvent(
          {
            ...w.ctx,
            event_type: CHECK_TIER_DECIDED_EVENT,
            payload: decidedPayload(`p-${check}`, check),
          },
          { stateDir: w.stateDir },
        )
      ).event_id;
    }
    writeOverlay(w.repo, {
      entries: [
        entryOf('unit', 'post-merge', ids.unit as string),
        entryOf('lint', 'post-merge', ids.lint as string),
      ],
      expectedRevision: 0,
    });
    const u = fakeRun('unit', false, 5);
    const l = fakeRun('lint', false, 5);
    const run = {
      pass: false,
      results: [...u.results, ...l.results],
      environment: [...(u.environment ?? []), ...(l.environment ?? [])],
    } as unknown as RunResult;
    const red = integrationEvent('rr#2', { epic: 'e', run, tree: 'rt2', tiers: ['post-merge'] });
    return { w, red };
  }
  /** Session `g`: its own root, chained to nothing, naming no epic. */
  const noEpicCtx = async (w: World) => {
    const start = await appendEvent(
      {
        session_id: 'g',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir: w.stateDir },
    );
    return { ...w.ctx, session_id: 'g', causal_parent: start.event_id };
  };

  it('promotes both checks from a session that names no epic, and a later apply keeps both promoted', async () => {
    const { w, red } = await twoDemoted();
    const snapshot = [red, ...(await readEvents('s', { stateDir: w.stateDir }))];
    const answers = await promoteAfterCatch(
      { failing_checks: ['unit', 'lint'], red_record_event_id: 'rr#2', reproduced: true },
      { dir: w.repo, checks: w.checks, events: snapshot, gather: w.gather },
      await noEpicCtx(w),
      { events: { stateDir: w.stateDir } },
    );
    expect(answers.map((a) => a.result)).toEqual(['promoted', 'promoted']);
    expect(overlayTiers(w.repo).sort()).toEqual([
      ['lint', 'pre-merge'],
      ['unit', 'pre-merge'],
    ]);
    const g = (await readEvents('g', { stateDir: w.stateDir })).slice(1);
    expect(g.map((e) => e.record.event_type)).toEqual([
      CHECK_TIER_PROMOTED_EVENT,
      CHECK_TIER_PROMOTED_EVENT,
    ]);
    expect(g.map((e) => e.record.payload.epic_id)).toEqual(['e', 'e']);
    // A later caller whose snapshot never held `g` still reads both promotions.
    await applyIn(w, [], { snapshot: [...w.events, ...(await readEvents('s', w.gather))] });
    expect(overlayTiers(w.repo).sort()).toEqual([
      ['lint', 'pre-merge'],
      ['unit', 'pre-merge'],
    ]);
  });

  it("an apply's decision and batch events in a session that names no epic are the project's", async () => {
    const w = await world(['unit']);
    const item = (await pendingNow(w)).items[0] as ProposalItem;
    w.ctx = await noEpicCtx(w);
    await applyIn(w, [approve(item)]);
    const g = (await readEvents('g', { stateDir: w.stateDir })).slice(1);
    expect(g.map((e) => e.record.payload.epic_id)).toEqual(['e', 'e']);
    const gathered = (await gatherLedgerInputs(w.gather)).events.map((e) => e.event_id);
    expect(gathered).toEqual(expect.arrayContaining(g.map((e) => e.event_id)));
  });

  it('skips a promotion whose red record names no epic, changing nothing', async () => {
    const p = await promoWorld();
    delete (p.events[1] as StoredEvent).record.payload.epic_id;
    const overlay = overlayBytes(p.w.repo);
    expect(await promote(p)).toEqual([
      { check: 'unit', result: 'promotion-skipped', reason: 'red-record-unreadable' },
    ]);
    expect(await typesOf(p.w)).toEqual(['session-start']);
    expect(overlayBytes(p.w.repo)).toBe(overlay);
  });

  it('orders snapshot-only and gathered events by ts, session order on ties, each event once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const at = (iso: string) => vi.setSystemTime(Date.parse(iso));
      // world() writes s0, the session-start; pin it before 'a' so the order holds on any clock.
      at('2026-12-31T00:00:00Z');
      const w = await world(['unit']);
      const add = (type: string) =>
        appendEvent(
          { ...w.ctx, event_type: type, payload: { epic_id: 'e' } },
          { stateDir: w.stateDir },
        );
      at('2027-01-01T00:00:00Z');
      const a = await add(CHECK_TIER_BATCH_ANSWERED_EVENT);
      at('2027-01-03T00:00:00Z');
      const b1 = await add(CHECK_TIER_BATCH_ANSWERED_EVENT);
      const b2 = await add(CHECK_TIER_BATCH_ANSWERED_EVENT);
      const early = logged(
        CHECK_TIER_BATCH_ANSWERED_EVENT,
        {},
        { id: 'lg#early', ts: '2020-01-01T00:00:00.000Z' },
      );
      const mid = logged(
        CHECK_TIER_BATCH_ANSWERED_EVENT,
        {},
        { id: 'lg#mid', ts: '2027-01-02T00:00:00.000Z' },
      );
      const s0 = (await readEvents('s', w.gather))[0] as StoredEvent;
      const log = await currentProjectLog([early, a, mid], w.gather);
      expect(log?.map((e) => e.event_id)).toEqual([
        'lg#early',
        s0.event_id,
        a.event_id,
        'lg#mid',
        b1.event_id,
        b2.event_id,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('revertedEvent fixture stays usable', () => {
  it('confirms a red as a real catch so the item is blocked', () => {
    const h = history([UNIT()]);
    const red = redOf('unit', 'e/unit-0', 'bad', 'fx#red');
    const reverted = revertedEvent('fx#rev', {
      task: 'e/unit-0',
      epic: 'e',
      evidence: ['fx#red'],
      failingChecks: ['unit'],
    });
    expect(pendingOf(h.events, h.claims, rawChecks('unit'), [red, reverted]).items).toEqual([]);
  });
});
