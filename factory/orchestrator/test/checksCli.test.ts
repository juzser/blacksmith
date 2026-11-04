import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendEvent, readEvents, type StoredEvent } from '../src/events.js';
import { commandDigest, type RunResult } from '../src/testgate.js';
import { type OverlayEntry, withOverlayLock, writeOverlay } from '../src/tierOverlay.js';
import { createTaskWorktree } from '../src/worktree.js';
import { CLI_PATH, runCli } from './helpers/cliHarness.js';
import { gateEvent, integrationEvent, mergedEvent, NOW } from './helpers/ledgerEvents.js';
import { baseInput, createWorld } from './helpers/paperworkFixtures.js';
import { git as gitIn, startProcess } from './helpers/process.js';

// Epic bs-check-tiers task-10: the `bs checks` namespace (ledger, proposals,
// apply) and the overlay `readChecksFile` resolves for every verb that reads a
// checks file. Everything here runs the built binary against real git repos,
// real state dirs and real plan files.

const NOW_ISO = new Date(NOW).toISOString();
const SHA = /^[0-9a-f]{64}$/;

const roots: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'smith-checks-cli-')));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cmdOf = (name: string): string => `run ${name}`;
const shaOf = (name: string): string => commandDigest(cmdOf(name));
const pid16 = (check: string): string =>
  createHash('sha256')
    .update(`${check}|${shaOf(check)}|pre-merge`)
    .digest('hex')
    .slice(0, 16);

// A RunResult of one check shaped as testgate.run returns it, without a process.
function fakeRun(name: string, pass: boolean, minutes: number): RunResult {
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
      },
    ],
    environment: [
      {
        name,
        window: 'command',
        wall_ms: mono,
        monotonic_ms: mono,
        clock_gap_ms: 0,
        load_1m_start: 0,
        load_1m_end: 0,
        cpus: 4,
      },
    ],
  } as unknown as RunResult;
}

/**
 * The D7 example for each named check of one epic: 25 gate runs and 1 close run
 * of 4.8 minutes, five measured post-merge head runs, one merge.
 */
function history(epic: string, names: string[]): { events: StoredEvent[]; tasks: string[] } {
  const events: StoredEvent[] = [];
  const tasks: string[] = [];
  for (const name of names) {
    for (let i = 0; i < 25; i++) {
      const task = `${epic}/${name}-${i}`;
      tasks.push(task);
      events.push(
        gateEvent(`fx#${epic}-${name}-g${i}`, {
          run: fakeRun(name, true, 4.8),
          tree: `t-${epic}-${name}-${i}`,
          task,
          daysAgo: 1 + (i % 20),
        }),
      );
    }
    events.push(
      integrationEvent(`fx#${epic}-${name}-c`, {
        epic,
        run: fakeRun(name, true, 4.8),
        tree: `c-${epic}-${name}`,
        daysAgo: 2,
      }),
    );
  }
  for (let i = 0; i < 5; i++) {
    events.push(
      integrationEvent(`fx#${epic}-pm${i}`, {
        epic,
        run: fakeRun('smoke', true, 1),
        tree: `pm-${epic}-${i}`,
        tiers: ['post-merge'],
        daysAgo: 2,
      }),
    );
  }
  events.push(mergedEvent(`fx#${epic}-m`, { task: tasks[0] as string, daysAgo: 1 }));
  return { events, tasks };
}

interface Fx {
  root: string;
  project: string;
  specs: string;
  state: string;
  checks: string;
}

const gitOf = (cwd: string, ...args: string[]): string => gitIn(cwd, args);

function writeChecks(fx: Fx, file: unknown[]): void {
  writeFileSync(fx.checks, `${JSON.stringify(file)}\n`);
  gitOf(fx.project, 'add', 'checks.json');
  gitOf(fx.project, 'commit', '-q', '-m', 'checks');
}

function writePlan(specs: string, epic: string, project: string, tasks: string[]): void {
  mkdirSync(path.join(specs, epic), { recursive: true });
  writeFileSync(
    path.join(specs, epic, 'plan.json'),
    JSON.stringify({
      epic_id: epic,
      version: 1,
      project,
      tasks: tasks.map((task_id) => ({ task_id, claims: ['src/x.ts'] })),
    }),
  );
}

function writeSession(state: string, session: string, events: StoredEvent[]): void {
  mkdirSync(state, { recursive: true });
  const lines = events.map((e) => JSON.stringify({ ...e.record, session_id: session }));
  writeFileSync(path.join(state, `${session}.jsonl`), `${lines.join('\n')}\n`);
}

/** The operator's session: a root event the envelope flags can name as the causal parent. */
function writeOps(state: string): void {
  writeSession(state, 'ops', [
    {
      event_id: 'ops#0',
      record: {
        session_id: 'ops',
        actor: 'user',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
        ts: new Date(NOW - 86_400_000).toISOString(),
      },
    },
  ]);
}

/** A project repo, an event store holding one epic's D7 history and an empty-able specs dir. */
function makeFx(names: string[] = ['unit'], file?: unknown[]): Fx {
  const root = tmp();
  const project = path.join(root, 'project');
  mkdirSync(project);
  gitOf(project, 'init', '-q', '-b', 'main');
  gitOf(project, 'config', 'user.email', 't@example.com');
  gitOf(project, 'config', 'user.name', 't');
  const fx: Fx = {
    root,
    project,
    specs: path.join(root, 'specs'),
    state: path.join(root, 'state'),
    checks: path.join(project, 'checks.json'),
  };
  writeChecks(fx, file ?? names.map((name) => ({ name, cmd: cmdOf(name), heavy: false })));
  const h = history('e', names);
  writePlan(fx.specs, 'e', 'proj', h.tasks);
  writeSession(fx.state, 'sess', h.events);
  writeOps(fx.state);
  return fx;
}

const ENVELOPE = ['--session', 'ops', '--plan-version', '3', '--causal-parent', 'ops#0'];
const scope = (fx: Fx): string[] => [
  '--project',
  fx.project,
  '--specs-dir',
  fx.specs,
  '--state-dir',
  fx.state,
  '--now',
  NOW_ISO,
];
const ledgerCli = (fx: Fx, extra: string[] = []) =>
  runCli(['checks', 'ledger', ...scope(fx), ...extra]);
const proposalsCli = (
  fx: Fx,
  extra: string[] = [],
  env: string[] = ENVELOPE,
  procEnv?: Record<string, string>,
) =>
  runCli(
    ['checks', 'proposals', ...scope(fx), '--checks', fx.checks, '--epic', 'e', ...env, ...extra],
    procEnv,
  );
const applyCli = (fx: Fx, decisions: string, extra: string[] = [], env: string[] = ENVELOPE) =>
  runCli([
    'checks',
    'apply',
    decisions,
    ...scope(fx),
    '--checks',
    fx.checks,
    '--epic',
    'e',
    '--actor',
    'operator',
    ...env,
    ...extra,
  ]);
const json = (r: { stdout: string; stderr: string }) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`stdout is not one JSON document:\n${r.stdout}\n${r.stderr}`);
  }
};

const logFiles = (fx: Fx): string[] =>
  readdirSync(fx.state)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
const logLines = (fx: Fx): number =>
  logFiles(fx).reduce(
    (n, f) => n + readFileSync(path.join(fx.state, f), 'utf8').split('\n').filter(Boolean).length,
    0,
  );
const logged = (fx: Fx, type: string): { session: string; record: Record<string, unknown> }[] =>
  logFiles(fx).flatMap((f) =>
    readFileSync(path.join(fx.state, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event_type === type)
      .map((record) => ({ session: f, record })),
  );
const overlayFile = (project: string): string =>
  path.join(project, '.blacksmith', 'check-tiers.json');
const overlayBytes = (project: string): string | null =>
  existsSync(overlayFile(project)) ? readFileSync(overlayFile(project), 'utf8') : null;

async function seedOverlay(project: string, entries: OverlayEntry[]): Promise<void> {
  await withOverlayLock(project, () => writeOverlay(project, { entries, expectedRevision: 0 }));
}
const entryFor = (check: string, tier: OverlayEntry['tier'], over: Partial<OverlayEntry> = {}) => ({
  check,
  cmd_sha256: shaOf(check),
  tier,
  decided_by_event_id: 'ops#7',
  decided_at: '2026-10-29T00:00:00.000Z',
  ...over,
});

describe('bs checks ledger', () => {
  it('prints only the epics under --specs-dir, whichever other project shares the event store', () => {
    const fx = makeFx(['unit']);
    const other = history('f', ['lint']);
    const otherSpecs = path.join(fx.root, 'specs-other');
    writePlan(otherSpecs, 'f', 'elsewhere', other.tasks);
    writeSession(fx.state, 'sess-f', other.events);

    const mine = json(ledgerCli(fx));
    expect(mine.epics).toEqual(['e']);
    expect(mine.project).toBe('proj');
    const rows = mine.ledger.rows as { tasks: string[]; name: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tasks.every((t) => t.startsWith('e/')))).toBe(true);
    expect(rows.some((r) => r.name === 'lint')).toBe(false);
    expect(mine.degraded).toBe(false);
    expect(mine.warnings).toEqual([]);

    const theirs = json(runCli(['checks', 'ledger', ...scope(fx), '--specs-dir', otherSpecs]));
    expect(theirs.epics).toEqual(['f']);
    const theirNames = (theirs.ledger.rows as { name: string }[]).map((r) => r.name);
    expect(theirNames).toContain('lint');
    expect(theirNames).not.toContain('unit');
  });

  it('exits 1 with checks.mixed-projects when the plans under --specs-dir name two projects', () => {
    const fx = makeFx(['unit']);
    const other = history('f', ['lint']);
    writePlan(fx.specs, 'f', 'elsewhere', other.tasks);
    const run = ledgerCli(fx);
    expect(run.status).toBe(1);
    expect(json(run).error.code).toBe('checks.mixed-projects');
  });

  it('prints the overlay report with --checks (active, shadowed, orphaned) and none without it', async () => {
    const fx = makeFx(
      ['a', 'b'],
      [
        { name: 'a', cmd: cmdOf('a'), heavy: false },
        { name: 'b', cmd: cmdOf('b'), heavy: false, tier: 'pre-merge' },
      ],
    );
    await seedOverlay(fx.project, [
      entryFor('a', 'post-merge'),
      entryFor('b', 'post-merge'),
      entryFor('gone', 'pre-release', { cmd_sha256: 'c'.repeat(64) }),
    ]);
    const lines = logLines(fx);
    const bytes = overlayBytes(fx.project);

    const withChecks = json(ledgerCli(fx, ['--checks', fx.checks]));
    const report = withChecks.overlay as { check: string; status: string }[];
    expect(report.map((r) => [r.check, r.status]).sort()).toEqual([
      ['a', 'active'],
      ['b', 'shadowed'],
      ['gone', 'orphaned'],
    ]);
    const without = json(ledgerCli(fx));
    expect('overlay' in without).toBe(false);
    expect(without.ledger.rows.length).toBeGreaterThan(0);

    expect(logLines(fx)).toBe(lines);
    expect(overlayBytes(fx.project)).toBe(bytes);
  });
});

describe('bs checks proposals', () => {
  it("prints the D7 example's three options", () => {
    const fx = makeFx(['unit']);
    const run = proposalsCli(fx);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const out = json(run);
    expect(out.items).toHaveLength(1);
    expect(
      out.items[0].options.map((o: { to_tier: string; minutes_saved: number }) => [
        o.to_tier,
        o.minutes_saved,
      ]),
    ).toEqual([
      ['pre-merge', 0],
      ['post-merge', 100.8],
      ['pre-release', 120],
    ]);
    expect(out.items[0].proposal_id).toBe(pid16('unit'));
    expect(out.writable).toBe('ok');
    expect(out.answered_in_epic).toBe(false);
  });

  it('names the first missing required flag before anything is read or written', () => {
    const fx = makeFx(['unit']);
    const before = logLines(fx);
    // --causal-parent is optional (O-11) and --session falls back to
    // CLAUDE_CODE_SESSION_ID, which this test blanks; --plan-version stays required here.
    const all: [string, string][] = [
      ['--session', 'ops'],
      ['--plan-version', '3'],
      ['--causal-parent', 'ops#0'],
    ];
    for (const [i, [flag]] of all.entries()) {
      if (flag === '--causal-parent') continue;
      const env = all.filter((_, j) => j !== i).flat();
      const run = proposalsCli(fx, [], env, { CLAUDE_CODE_SESSION_ID: '' });
      expect(run.status, flag).toBe(1);
      expect(json(run).error.code).toBe('cli.missing-flag');
      expect(json(run).error.message).toContain(flag);
    }
    for (const flag of ['--checks', '--epic']) {
      const args = ['checks', 'proposals', ...scope(fx), ...ENVELOPE];
      if (flag === '--epic') args.push('--checks', fx.checks);
      else args.push('--epic', 'e');
      const run = runCli(args);
      expect(run.status, flag).toBe(1);
      expect(json(run).error.message).toContain(flag);
    }
    expect(logLines(fx)).toBe(before);
    expect(overlayBytes(fx.project)).toBeNull();
  });

  it('writes nothing on a consistent overlay', async () => {
    const fx = makeFx(['unit']);
    await seedOverlay(fx.project, [entryFor('other', 'post-merge')]);
    const lines = logLines(fx);
    const bytes = overlayBytes(fx.project);
    const run = proposalsCli(fx);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(logLines(fx)).toBe(lines);
    expect(overlayBytes(fx.project)).toBe(bytes);
  });

  it("appends exactly the promotion event an overlay entry owes, in the caller's envelope", async () => {
    const fx = makeFx(['unit']);
    const payload = {
      epic_id: 'e',
      check: 'unit',
      cmd_sha256: shaOf('unit'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'sess#4',
      decided_by_event_id: 'ops#7',
    };
    await seedOverlay(fx.project, [
      entryFor('unit', 'pre-merge', {
        pending_event: { event_type: 'check-tier-promoted', payload },
      }),
    ]);
    const lines = logLines(fx);
    const run = proposalsCli(fx);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(logLines(fx)).toBe(lines + 1);
    const promoted = logged(fx, 'check-tier-promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.session).toBe('ops.jsonl');
    expect(promoted[0]?.record).toMatchObject({
      session_id: 'ops',
      plan_version: 3,
      causal_parent: 'ops#0',
      payload,
    });
    const after = JSON.parse(overlayBytes(fx.project) as string);
    expect(after.entries[0].pending_event).toBeUndefined();
    expect(after.entries[0].tier).toBe('pre-merge');
  });

  it('repairs an approved tier the overlay lost to a crash: writes the entry, appends nothing, prints it effective', async () => {
    const fx = makeFx(['unit']);
    const decisions = path.join(fx.root, 'decisions.json');
    writeFileSync(
      decisions,
      JSON.stringify([
        { proposal_id: pid16('unit'), check: 'unit', decision: 'approve', to_tier: 'post-merge' },
      ]),
    );
    expect(applyCli(fx, decisions).status).toBe(0);
    // The state a crash between apply's events and its overlay write leaves.
    unlinkSync(overlayFile(fx.project));
    const lines = logLines(fx);
    const run = proposalsCli(fx);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(logLines(fx)).toBe(lines);
    const stored = JSON.parse(overlayBytes(fx.project) as string);
    expect(stored.entries.map((e: OverlayEntry) => [e.check, e.tier])).toEqual([
      ['unit', 'post-merge'],
    ]);
    const out = json(run);
    expect(out.overlay).toEqual([
      { check: 'unit', cmd_sha256: shaOf('unit'), tier: 'post-merge', status: 'active' },
    ]);
    expect(out.items).toEqual([]);
  });

  it('refuses a session with no log and leaves the log and the overlay unchanged', async () => {
    const fx = makeFx(['unit']);
    const payload = {
      epic_id: 'e',
      check: 'unit',
      cmd_sha256: shaOf('unit'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'sess#4',
      decided_by_event_id: 'ops#7',
    };
    await seedOverlay(fx.project, [
      entryFor('unit', 'pre-merge', {
        pending_event: { event_type: 'check-tier-promoted', payload },
      }),
    ]);
    const lines = logLines(fx);
    const bytes = overlayBytes(fx.project);
    const run = proposalsCli(
      fx,
      [],
      ['--session', 'nobody', '--plan-version', '3', '--causal-parent', 'nobody#0'],
    );
    expect(run.status).toBe(1);
    expect(logLines(fx)).toBe(lines);
    expect(overlayBytes(fx.project)).toBe(bytes);
  });

  it('waits for a lock another process holds and then appends the owed event', async () => {
    const fx = makeFx(['unit']);
    const payload = {
      epic_id: 'e',
      check: 'unit',
      cmd_sha256: shaOf('unit'),
      from_tier: 'post-merge',
      to_tier: 'pre-merge',
      catch_event_id: 'sess#4',
      decided_by_event_id: 'ops#7',
    };
    await seedOverlay(fx.project, [
      entryFor('unit', 'pre-merge', {
        pending_event: { event_type: 'check-tier-promoted', payload },
      }),
    ]);
    const lib = pathToFileURL(path.join(path.dirname(CLI_PATH), 'tierOverlay.js')).href;
    const holder = startProcess('node', [
      '--input-type=module',
      '-e',
      `import { withOverlayLock } from ${JSON.stringify(lib)};
       await withOverlayLock(${JSON.stringify(fx.project)}, async () => {
         console.log('held');
         await new Promise((r) => setTimeout(r, 1000));
       });`,
    ]);
    try {
      await holder.waitForLines(1);
      const lines = logLines(fx);
      const run = proposalsCli(fx);
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(logLines(fx)).toBe(lines + 1);
      expect(logged(fx, 'check-tier-promoted')).toHaveLength(1);
    } finally {
      await holder.stop();
    }
  });

  it('is read-only in a repo with no .blacksmith directory', () => {
    const fx = makeFx(['unit']);
    const listing = (): string[] => readdirSync(fx.project).sort();
    const exclude = path.join(fx.project, '.git', 'info', 'exclude');
    const excludeBefore = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null;
    const before = listing();
    const run = proposalsCli(fx);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(json(run).items).toHaveLength(1);
    expect(listing()).toEqual(before);
    expect(existsSync(path.join(fx.project, '.blacksmith'))).toBe(false);
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : null).toBe(excludeBefore);
  });

  it('answers a directory outside any git repository with no items and a not-a-repo notice', () => {
    const fx = makeFx(['unit']);
    const bare = path.join(tmp(), 'plain');
    mkdirSync(bare);
    const run = runCli([
      'checks',
      'proposals',
      ...scope(fx).map((a) => (a === fx.project ? bare : a)),
      '--checks',
      fx.checks,
      '--epic',
      'e',
      ...ENVELOPE,
    ]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const out = json(run);
    expect(out.items).toEqual([]);
    expect(out.writable).toBe('not-a-repo');
    expect(out.notices.map((n: { code: string }) => n.code)).toContain('checks.overlay-not-a-repo');
    expect(readdirSync(bare)).toEqual([]);
  });
});

describe('bs checks apply', () => {
  const decide = (fx: Fx, items: unknown): string => {
    const file = path.join(fx.root, `decisions-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(items));
    return file;
  };

  it('refuses a guardrail item with its reason in items and changes nothing', () => {
    const fx = makeFx(['unit', 'coverage']);
    const lines = logLines(fx);
    const file = decide(fx, [
      { proposal_id: pid16('coverage'), check: 'coverage', decision: 'decline' },
    ]);
    const run = applyCli(fx, file);
    expect(run.status).toBe(1);
    const out = json(run);
    expect(out.error.code).toBe('checks.apply-refused');
    expect(out.items).toEqual([
      {
        proposal_id: pid16('coverage'),
        check: 'coverage',
        reason: 'the check is bound to a gate stage',
      },
    ]);
    expect(logLines(fx)).toBe(lines);
    expect(overlayBytes(fx.project)).toBeNull();
  });

  it('applies a valid batch: one decision per item, the overlay, and a byte-identical tracked file', () => {
    const fx = makeFx(['unit']);
    const before = readFileSync(fx.checks, 'utf8');
    const file = decide(fx, [
      { proposal_id: pid16('unit'), check: 'unit', decision: 'approve', to_tier: 'post-merge' },
    ]);
    const run = applyCli(fx, file);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(logged(fx, 'check-tier-decided')).toHaveLength(1);
    expect(logged(fx, 'check-tier-batch-answered')).toHaveLength(1);
    const stored = JSON.parse(overlayBytes(fx.project) as string);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]).toMatchObject({ check: 'unit', tier: 'post-merge' });
    expect(stored.entries[0].cmd_sha256).toMatch(SHA);
    expect(readFileSync(fx.checks, 'utf8')).toBe(before);
    expect(gitOf(fx.project, 'status', '--porcelain')).toBe('');
  });

  it('refuses a non-operator actor', () => {
    const fx = makeFx(['unit']);
    const lines = logLines(fx);
    const run = applyCli(fx, decide(fx, []), ['--actor', 'wave-runner']);
    expect(run.status).toBe(1);
    expect(json(run).error.code).toBe('checks.apply-not-operator');
    expect(json(run).items).toEqual([]);
    expect(logLines(fx)).toBe(lines);
  });

  it('answers the batch with [] and proposals then reports answered_in_epic', () => {
    const fx = makeFx(['unit']);
    expect(json(proposalsCli(fx)).answered_in_epic).toBe(false);
    const run = applyCli(fx, decide(fx, []));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(logged(fx, 'check-tier-batch-answered')).toHaveLength(1);
    expect(json(proposalsCli(fx)).answered_in_epic).toBe(true);
  });

  describe('re-entry after a refusal', () => {
    it('hands a refusal with no items to the operator and records it so step 12 asks once', () => {
      const fx = makeFx(['unit']);
      const file = decide(fx, {});
      const refused = applyCli(fx, file);
      expect(refused.status).toBe(1);
      const out = json(refused);
      expect(out.error.code).toBe('checks.decisions-not-array');
      expect(out.items).toEqual([]);
      const bytes = overlayBytes(fx.project);
      const answered = logged(fx, 'check-tier-batch-answered').length;
      const lines = logLines(fx);

      const hand = applyCli(fx, file, ['--hand-off', out.error.code]);
      expect(hand.status, hand.stdout + hand.stderr).toBe(0);
      const printed = json(hand);
      expect(Object.keys(printed)).toEqual(['event_id']);
      expect(logLines(fx)).toBe(lines + 1);
      const events = logged(fx, 'check-tier-batch-answered');
      expect(events).toHaveLength(answered + 1);
      expect(events.at(-1)?.record.payload).toMatchObject({
        epic_id: 'e',
        decided: [],
        handed_off: { code: 'checks.decisions-not-array', decisions_path: file },
      });
      expect(((events.at(-1)?.record.payload ?? {}) as { pending?: string[] }).pending).toEqual([
        pid16('unit'),
      ]);
      expect(overlayBytes(fx.project)).toBe(bytes);

      const later = json(proposalsCli(fx));
      expect(later.answered_in_epic).toBe(true);
      expect(later.items).toHaveLength(1);
      expect(later.handed_off).toMatchObject({
        code: 'checks.decisions-not-array',
        decisions_path: file,
        event_id: printed.event_id,
      });
    });

    it('refuses a decisions file that is not valid JSON with a code and empty items, and hands it off', () => {
      const fx = makeFx(['unit']);
      const file = path.join(fx.root, 'decisions-broken.json');
      writeFileSync(file, '[');
      const lines = logLines(fx);
      const bytes = overlayBytes(fx.project);
      const refused = applyCli(fx, file);
      expect(refused.status).toBe(1);
      const out = json(refused);
      expect(out.error.code).toBe('checks.decisions-not-array');
      expect(out.items).toEqual([]);
      expect(logLines(fx)).toBe(lines);
      expect(overlayBytes(fx.project)).toBe(bytes);

      const hand = applyCli(fx, file, ['--hand-off', out.error.code]);
      expect(hand.status, hand.stdout + hand.stderr).toBe(0);
      expect(logLines(fx)).toBe(lines + 1);
    });

    it('names --hand-off when it has no value, and writes nothing', () => {
      const fx = makeFx(['unit']);
      const lines = logLines(fx);
      const run = applyCli(fx, decide(fx, {}), ['--hand-off']);
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toContain('hand-off');
      expect(logLines(fx)).toBe(lines);
    });
  });
});

describe('the overlay, resolved wherever a checks file is read', () => {
  const counterOf = (dir: string): string => path.join(dir, 'counter');
  const ran = (dir: string): string[] =>
    existsSync(counterOf(dir))
      ? readFileSync(counterOf(dir), 'utf8').split('\n').filter(Boolean)
      : [];

  async function world(file: (counter: string) => unknown[]) {
    const w = await createWorld();
    roots.push(w.stateDir, w.worktreeDir, w.artifactsDir, w.elsewhereDir);
    // A task worktree of the same repository: deps are present, the work is committed.
    const task = path.join(tmp(), 'task-wt');
    w.git(['worktree', 'add', '-q', '-b', 'smith/epic-1/task-1w', task, 'HEAD']);
    mkdirSync(path.join(task, 'node_modules', '.bin'), { recursive: true });
    const checks = path.join(w.elsewhereDir, 'checks.json');
    writeFileSync(checks, JSON.stringify(file(counterOf(w.elsewhereDir))));
    const result = path.join(w.elsewhereDir, 'result.json');
    writeFileSync(result, JSON.stringify(baseInput(w).result));
    const line = [
      '--worktree',
      task,
      '--checks',
      checks,
      '--result',
      result,
      '--base',
      'main',
      '--artifacts-dir',
      w.artifactsDir,
      '--session',
      w.sessionId,
      '--causal-parent',
      `${w.sessionId}#0`,
      '--state-dir',
      w.stateDir,
    ];
    return { w, task, checks, line };
  }

  const recording = (name: string, counter: string, extra: Record<string, unknown> = {}) => ({
    name,
    cmd: `echo ${name} >> '${counter}'`,
    heavy: false,
    ...extra,
  });
  const demote = (w: { worktreeDir: string }, name: string, counter: string) =>
    seedOverlay(w.worktreeDir, [
      {
        check: name,
        cmd_sha256: commandDigest(`echo ${name} >> '${counter}'`),
        tier: 'post-merge',
        decided_by_event_id: 'ops#7',
        decided_at: '2026-10-29T00:00:00.000Z',
      },
    ]);
  const deferredOf = async (w: { sessionId: string; stateDir: string }) => {
    const [event] = (await readEvents(w.sessionId, { stateDir: w.stateDir })).filter(
      (e) => e.record.event_type === 'testgate-result',
    );
    return ((event?.record.payload ?? {}) as { deferred?: unknown[] }).deferred;
  };

  it('defers an undeclared check the overlay moved, and reports tier_source overlay', async () => {
    const { w, task, line } = await world((c) => [recording('noop', c), recording('e2e', c)]);
    await demote(w, 'e2e', counterOf(w.elsewhereDir));
    const run = runCli(['gate', 'run', w.taskId, ...line], {}, undefined, task);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(ran(w.elsewhereDir)).toEqual(['noop']);
    expect(await deferredOf(w)).toEqual([
      { name: 'e2e', tier: 'post-merge', tier_source: 'overlay' },
    ]);
  });

  it('lets a declaration win over the overlay, and reports the entry shadowed', async () => {
    const { w, task, line, checks } = await world((c) => [
      recording('noop', c),
      recording('e2e', c, { tier: 'pre-merge' }),
    ]);
    await demote(w, 'e2e', counterOf(w.elsewhereDir));
    const run = runCli(['gate', 'run', w.taskId, ...line], {}, undefined, task);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(ran(w.elsewhereDir)).toEqual(['noop', 'e2e']);
    expect(await deferredOf(w)).toEqual([]);
    const preflight = runCli(
      ['results', 'check', w.taskId, '--as', 'gate', ...line],
      {},
      undefined,
      task,
    );
    expect(preflight.status, preflight.stdout + preflight.stderr).toBe(0);
    expect('selection' in json(preflight)).toBe(false);

    const fx = makeFx(['unit']);
    const proposals = runCli([
      'checks',
      'proposals',
      '--project',
      task,
      '--specs-dir',
      fx.specs,
      '--state-dir',
      fx.state,
      '--now',
      NOW_ISO,
      '--checks',
      checks,
      '--epic',
      'e',
      ...ENVELOPE,
    ]);
    expect(proposals.status, proposals.stdout + proposals.stderr).toBe(0);
    expect(json(proposals).overlay).toEqual([
      expect.objectContaining({ check: 'e2e', tier: 'post-merge', status: 'shadowed' }),
    ]);
  });

  it('prints that an unreadable overlay resolved every undeclared check to pre-merge', async () => {
    const { w, task, line } = await world((c) => [recording('noop', c), recording('e2e', c)]);
    mkdirSync(path.join(w.worktreeDir, '.blacksmith'));
    writeFileSync(overlayFile(w.worktreeDir), '{ not json');
    const run = runCli(['gate', 'run', w.taskId, ...line], {}, undefined, task);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).toContain('overlay is unreadable');
    expect(ran(w.elsewhereDir)).toEqual(['noop', 'e2e']);
  });

  it('gives bs results check --as gate the selection bs gate run makes', async () => {
    const { w, task, line } = await world((c) => [recording('noop', c), recording('e2e', c)]);
    await demote(w, 'e2e', counterOf(w.elsewhereDir));
    const preflight = runCli(
      ['results', 'check', w.taskId, '--as', 'gate', ...line],
      {},
      undefined,
      task,
    );
    expect(preflight.status, preflight.stdout + preflight.stderr).toBe(0);
    expect(json(preflight).selection).toEqual({
      selected: ['noop'],
      deferred: [{ name: 'e2e', tier: 'post-merge', tier_source: 'overlay' }],
    });
    runCli(['gate', 'run', w.taskId, ...line], {}, undefined, task);
    expect(await deferredOf(w)).toEqual(json(preflight).selection.deferred);
  });

  it('refuses with gate.no-pre-merge-checks in both verbs when every entry is demoted', async () => {
    const { w, task, line } = await world((c) => [recording('e2e', c)]);
    await demote(w, 'e2e', counterOf(w.elsewhereDir));
    const gate = runCli(['gate', 'run', w.taskId, ...line], {}, undefined, task);
    expect(gate.status).toBe(1);
    expect(json(gate).error.code).toBe('gate.no-pre-merge-checks');
    const preflight = runCli(
      ['results', 'check', w.taskId, '--as', 'gate', ...line],
      {},
      undefined,
      task,
    );
    expect(preflight.status).toBe(1);
    expect(json(preflight).problems[0].reason).toBe('gate.no-pre-merge-checks');
  });

  describe('bs brief compose --checks', () => {
    const plan = path.join(import.meta.dirname, 'fixtures', 'brief-compose-plan.json');
    async function compose() {
      const { w, task, checks } = await world((c) => [recording('noop', c), recording('e2e', c)]);
      await demote(w, 'e2e', counterOf(w.elsewhereDir));
      const out = path.join(w.elsewhereDir, 'brief.md');
      const run = runCli([
        'brief',
        'compose',
        '--role',
        'tester',
        '--session',
        w.sessionId,
        '--plan',
        plan,
        '--task',
        'project-a/task-1-widget',
        '--worktree',
        task,
        '--provider',
        'claude',
        '--model-tier',
        'mid',
        '--checks',
        checks,
        '--work-root',
        path.join(w.elsewhereDir, 'work'),
        '--state-dir',
        w.stateDir,
        '--out',
        out,
      ]);
      return { run, text: existsSync(out) ? readFileSync(out, 'utf8') : '' };
    }

    it("lists the pre-merge selection the gate runs when --worktree names the overlay's repo", async () => {
      const { run, text } = await compose();
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(text).toContain('- noop:');
      expect(text).not.toContain('- e2e:');
      expect(text).toContain('Deferred by tier, not run before hand-back: e2e (post-merge)');
      expect(run.stderr).not.toContain('overlay');
    });

    // Coder and tester briefs refuse to compose without a worktree (brief.worktree-required), so
    // the not-applied line is only ever seen with a role that lists no checks, such as a planner.
    it('says the overlay was not applied when --checks comes with no --worktree', async () => {
      const { w, checks } = await world((c) => [recording('noop', c)]);
      const specs = path.join(w.elsewhereDir, 'specs');
      mkdirSync(path.join(specs, 'project-a'), { recursive: true });
      writeFileSync(path.join(specs, 'project-a', 'epic-spec.md'), '# Epic\n');
      const run = runCli([
        'brief',
        'compose',
        '--role',
        'planner',
        '--epic',
        'project-a',
        '--session',
        w.sessionId,
        '--specs-dir',
        specs,
        '--checks',
        checks,
        '--work-root',
        path.join(w.elsewhereDir, 'work'),
        '--state-dir',
        w.stateDir,
      ]);
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stderr).toContain('overlay was not applied');
    });
  });
});

describe('bs queue run --checks reads the overlay of --project', () => {
  it('runs the pre-merge tier only when the overlay alone demotes a check', async () => {
    const root = tmp();
    const project = path.join(root, 'project');
    const origin = path.join(root, 'origin.git');
    gitOf(root, 'init', '-q', '--bare', '-b', 'main', origin);
    gitOf(root, 'clone', '-q', origin, project);
    gitOf(project, 'config', 'user.email', 'test@example.com');
    gitOf(project, 'config', 'user.name', 'Test');
    writeFileSync(path.join(project, 'a.txt'), 'a\n');
    gitOf(project, 'add', '.');
    gitOf(project, 'commit', '-q', '-m', 'init');
    gitOf(project, 'push', '-q', 'origin', 'main');

    const ranLog = path.join(root, 'ran.log');
    writeFileSync(ranLog, '');
    const script = (name: string): string => {
      const file = path.join(root, `${name}.sh`);
      writeFileSync(file, `echo '${name}' >> '${ranLog}'\nexit 0\n`);
      chmodSync(file, 0o755);
      return `sh '${file}'`;
    };
    const task = createTaskWorktree(project, 'epic-1', 'task-1');
    writeFileSync(path.join(task.worktreeDir, 'a.txt'), 'a-1\n');
    gitOf(task.worktreeDir, 'commit', '-q', '-am', 'edit a');

    const checks = [
      { name: 'unit', cmd: script('unit'), heavy: false },
      { name: 'e2e', cmd: script('e2e'), heavy: false },
    ];
    const checksFile = path.join(root, 'checks.json');
    writeFileSync(checksFile, JSON.stringify(checks));
    await seedOverlay(project, [
      entryFor('e2e', 'post-merge', { cmd_sha256: commandDigest(checks[1]?.cmd as string) }),
    ]);

    const state = path.join(root, 'state');
    const root0 = await appendEvent(
      {
        session_id: 'sess-q',
        actor: 'system',
        event_type: 'session-start',
        plan_version: 1,
        causal_parent: null,
        payload: {},
      },
      { stateDir: state },
    );
    const tasksFile = path.join(root, 'tasks.json');
    writeFileSync(
      tasksFile,
      JSON.stringify([
        { taskId: 'epic-1/task-1', branch: task.branch, worktreeDir: task.worktreeDir },
      ]),
    );
    const planFile = path.join(root, 'plan.json');
    writeFileSync(
      planFile,
      JSON.stringify({
        epic_id: 'epic-1',
        version: 1,
        status: 'active',
        tasks: [{ task_id: 'epic-1/task-1', claims: ['a.txt'] }],
        edges: [],
      }),
    );
    const run = runCli([
      'queue',
      'run',
      'epic-1',
      '--project',
      project,
      '--tasks',
      tasksFile,
      '--test-cmd',
      script('test-cmd'),
      '--select-test-cmd',
      `${script('select')} {files}`,
      '--checks',
      checksFile,
      '--session',
      'sess-q',
      '--causal-parent',
      root0.event_id,
      '--plan',
      planFile,
      '--state-dir',
      state,
    ]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(ranLog, 'utf8').split('\n').filter(Boolean)).toEqual(['unit']);
    const landing = (await readEvents('sess-q', { stateDir: state })).find(
      (e) => e.record.event_type === 'wave-merged',
    );
    expect(landing?.record.payload).toMatchObject({
      pre_landing: 'pre-merge-tier',
      test_cmd_not_run: true,
      select_test_cmd_not_run: true,
    });
  });
});
