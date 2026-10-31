// The check ledger (epic bs-check-tiers, spec D6): a pure, read-only fold over
// gate, queue, integration and revert events. It reads no file and writes
// nothing; the one outside fact it needs, the diff between two trees, comes
// through an injected reader. Where a fact cannot be read, the default
// protects a check (a real catch, a guard), never exposes it.
import { execFileSync } from 'node:child_process';
import type { StoredEvent } from './events.js';
import { type LedgerInputs, UNATTRIBUTED } from './ledgerInputs.js';
import { claimTouchesGlob } from './security.js';
import { epicOfTaskId } from './taskId.js';
import { type CheckEnvironment, isNotRun, sleptDuringCheck } from './testgate.js';

/** Spec D6, importance: "Window: last 30 days". */
export const LEDGER_WINDOW_DAYS = 30;

/** Spec D6, importance: the severity weight of a unique catch, S1 8, S2 4, S3 2, S4 1. */
export const SEVERITY_WEIGHTS = { S1: 8, S2: 4, S3: 2, S4: 1 } as const;

/** Spec D6: the five failure classes, in the order they are decided. */
export const FAILURE_CLASSES = ['not-run', 'env', 'flaky', 'real', 'unconfirmed'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Where a run came from; `probe` is an integration record with `probe_of`, `close` any other. */
export type LedgerSource = 'gate' | 'queue' | 'close' | 'probe';
const SOURCES: readonly LedgerSource[] = ['gate', 'queue', 'close', 'probe'];

export interface LedgerRow {
  event_id: string;
  event_type: string;
  source: LedgerSource;
  /** Position in the log, then in the record's results: the order "later" means. */
  seq: number;
  ts: string;
  name: string;
  /** Null for a row written before the digest existed (`name-only`). */
  cmd_sha256: string | null;
  identity: string;
  /** Qualified tasks the run belongs to; empty for an integration record. */
  tasks: string[];
  tiers: string[];
  tree_sha: string | null;
  outcome: 'pass' | 'fail' | 'not-run';
  /** `monotonic_ms` of the paired environment entry, else null (never 0). */
  duration_ms: number | null;
  class: FailureClass | null;
  catch: 'unique' | 'shadowed' | null;
  severity: 'S1' | 'S2' | null;
}

export interface LedgerCheck {
  name: string;
  cmd_sha256: string | null;
  identity: string;
  runs: number;
  minutes: number;
  unmeasured: number;
  not_run: number;
  median_minutes: number | null;
  flake_rate: number;
  importance: number;
  real_catches: number;
  unique_catches: number;
  s1_catches: number;
  s2_catches: number;
  unconfirmed: { event_id: string; severity: 'S1' | 'S2' }[];
  guards_sensitive: boolean;
  /** The D7 inputs R and M by source; `probe` is kept apart so D7 can exclude it. */
  by_source: Record<LedgerSource, { runs: number; minutes: number }>;
  event_ids: Record<
    | 'runs'
    | 'minutes'
    | 'unmeasured'
    | 'not_run'
    | 'flaky'
    | 'real_catches'
    | 'unique_catches'
    | 's1_catches'
    | 's2_catches'
    | 'unconfirmed'
    | 'guards_sensitive',
    string[]
  >;
}

export interface CheckLedger {
  rows: LedgerRow[];
  checks: LedgerCheck[];
  project: {
    post_merge_runs: number;
    post_merge_run_ids: string[];
    task_merges: number;
    epics_with_merges: number;
    merges_per_post_merge_run: number | null;
  };
}

export type LedgerFoldInputs = Pick<
  LedgerInputs,
  'events' | 'taskIdOf' | 'taskClaims' | 'sensitiveGlobs'
>;

export interface LedgerOptions {
  /** Applies to the numbers only; the sensitive-path guard's catch arm reads every event. */
  window: { from: Date; to: Date };
  /** The paths that differ between two trees. Default: `git diff --name-only --no-renames`. */
  treeDiff?: (a: string, b: string) => string[];
  /** Directory the default diff reader runs in. Default: the current directory. */
  projectDir?: string;
  /** A fix that touches only this path is no evidence of a real defect. Default `checks.json`. */
  checksFile?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const qualify = (id: string, epic: string | null): string =>
  epicOfTaskId(id) !== null ? id : epic === null ? UNATTRIBUTED : `${epic}/${id}`;

/** The environment entry paired with `results[i]`: same index and same name, else none. */
function pairedEntry(environment: unknown, i: number, name: string): CheckEnvironment | null {
  const e = Array.isArray(environment) ? environment[i] : undefined;
  if (!isObj(e) || e.name !== name) return null;
  if (e.window !== 'command' && e.window !== 'none') return null;
  if (typeof e.monotonic_ms !== 'number' || typeof e.clock_gap_ms !== 'number') return null;
  return e as unknown as CheckEnvironment;
}

interface RawRow extends LedgerRow {
  slept: boolean;
  /** The epic of an integration record, whose runs belong to no task. */
  epic: string | null;
}

function rowsOfEvent(ev: StoredEvent, taskIdOf: ReadonlyMap<string, string>, seq0: number) {
  const p = ev.record.payload;
  if (!Array.isArray(p.results)) return [];
  const type = ev.record.event_type;
  let source: LedgerSource;
  let tasks: string[];
  let tiers: string[];
  if (type === 'testgate-result') {
    source = 'gate';
    tasks = [taskIdOf.get(ev.event_id) ?? UNATTRIBUTED];
    tiers = str(p.tier) === null ? [] : [String(p.tier)];
  } else if (type === 'queue-tier-run') {
    source = 'queue';
    const epic = str(p.epic_id) ?? epicOfTaskId(taskIdOf.get(ev.event_id) ?? '');
    const ids = strs(p.task_ids);
    tasks = ids.length === 0 ? [UNATTRIBUTED] : ids.map((id) => qualify(id, epic));
    tiers = ['pre-merge'];
  } else if (type === 'integration-check') {
    source = 'probe_of' in p ? 'probe' : 'close';
    tasks = [];
    tiers = strs(p.tiers);
  } else {
    return [];
  }
  const notRunNames = new Set(strs(p.not_run));
  const tree = str(p.tree_sha);
  const out: RawRow[] = [];
  p.results.forEach((r: unknown, i: number) => {
    if (!isObj(r) || typeof r.name !== 'string' || typeof r.pass !== 'boolean') return;
    const notRun = isNotRun({ reason: str(r.reason) ?? undefined }) || notRunNames.has(r.name);
    const entry = pairedEntry(p.environment, i, r.name);
    const sha = str(r.cmd_sha256);
    out.push({
      event_id: ev.event_id,
      event_type: type,
      source,
      seq: seq0 + i,
      ts: ev.record.ts,
      name: r.name,
      cmd_sha256: sha,
      identity: `${r.name}@${sha ?? 'name-only'}`,
      tasks,
      tiers,
      tree_sha: tree,
      outcome: notRun ? 'not-run' : r.pass ? 'pass' : 'fail',
      duration_ms:
        entry !== null &&
        entry.window === 'command' &&
        Number.isFinite(entry.monotonic_ms) &&
        entry.monotonic_ms >= 0
          ? entry.monotonic_ms
          : null,
      class: null,
      catch: null,
      severity: null,
      slept: entry !== null && sleptDuringCheck(entry),
      epic: source === 'close' || source === 'probe' ? str(p.epic_id) : null,
    });
  });
  return out;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const uniq = (ids: string[]): string[] => [...new Set(ids)];

export function checkLedger(inputs: LedgerFoldInputs, opts: LedgerOptions): CheckLedger {
  const checksFile = opts.checksFile ?? 'checks.json';
  const treeDiff =
    opts.treeDiff ??
    ((a: string, b: string): string[] =>
      execFileSync(
        'git',
        ['-C', opts.projectDir ?? process.cwd(), 'diff', '--name-only', '--no-renames', a, b],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
        .split('\n')
        .filter((l) => l !== ''));

  const from = opts.window.from.getTime();
  const to = opts.window.to.getTime();
  const inWindow = (ts: string): boolean => {
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= from && t <= to;
  };
  // An unreadable timestamp can only widen what a guard sees, never narrow it.
  const guardWindow = (ts: string): boolean => !Number.isFinite(Date.parse(ts)) || inWindow(ts);

  // One pass over the log: run rows, revert confirmations, merges, post-merge runs.
  const rows: RawRow[] = [];
  const confirmed = new Map<string, { names: Set<string>; tasks: Set<string> }>();
  const mergeKeys = new Set<string>();
  const postMergeRuns: string[] = [];
  let seq = 0;
  for (const ev of inputs.events) {
    const type = ev.record.event_type;
    const p = ev.record.payload;
    rows.push(...rowsOfEvent(ev, inputs.taskIdOf, seq));
    seq += Array.isArray(p.results) ? p.results.length : 1;
    if (type === 'wave-reverted') {
      const epic = str(p.epic_id) ?? epicOfTaskId(inputs.taskIdOf.get(ev.event_id) ?? '');
      const tasks = strs(p.task_ids).map((id) => qualify(id, epic));
      for (const id of strs(p.evidence_event_ids)) {
        const hit = confirmed.get(id) ?? { names: new Set<string>(), tasks: new Set<string>() };
        for (const n of strs(p.failing_checks)) hit.names.add(n);
        for (const t of tasks) hit.tasks.add(t);
        confirmed.set(id, hit);
      }
    } else if (type === 'wave-merged' && inWindow(ev.record.ts)) {
      mergeKeys.add(inputs.taskIdOf.get(ev.event_id) ?? `${UNATTRIBUTED}:${ev.event_id}`);
    } else if (
      type === 'integration-check' &&
      !('probe_of' in p) &&
      strs(p.tiers).includes('post-merge') &&
      inWindow(ev.record.ts)
    ) {
      postMergeRuns.push(ev.event_id);
    }
  }

  const sensitiveMemo = new Map<string, boolean>();
  const sensitive = (task: string): boolean => {
    let hit = sensitiveMemo.get(task);
    if (hit === undefined) {
      const claims = task === UNATTRIBUTED ? undefined : inputs.taskClaims.get(task);
      hit =
        claims === undefined ||
        claims.length === 0 ||
        claims.some((c) => inputs.sensitiveGlobs.some((g) => claimTouchesGlob(c, g)));
      sensitiveMemo.set(task, hit);
    }
    return hit;
  };

  // Facts the classes are decided from.
  const live = rows.filter((r) => r.outcome !== 'not-run');
  const passedAt = new Set(
    live
      .filter((r) => r.outcome === 'pass' && r.tree_sha !== null)
      .map((r) => `${r.identity}|${r.tree_sha}`),
  );
  const passedIn = new Set(
    live.filter((r) => r.outcome === 'pass').map((r) => `${r.event_id}|${r.identity}`),
  );
  const passesOf = new Map<string, RawRow[]>();
  for (const r of live) {
    if (r.outcome !== 'pass') continue;
    const list = passesOf.get(r.name) ?? [];
    list.push(r);
    passesOf.set(r.name, list);
  }
  const diffTouches = new Map<string, boolean>();
  // A diff that cannot be read, or a tree that was not recorded, counts as a real change.
  const realChange = (a: string | null, b: string | null): boolean => {
    if (a === null || b === null) return true;
    const key = `${a}>${b}`;
    let hit = diffTouches.get(key);
    if (hit === undefined) {
      try {
        hit = treeDiff(a, b).some((path) => path !== checksFile);
      } catch {
        hit = true;
      }
      diffTouches.set(key, hit);
    }
    return hit;
  };
  // A run belongs to its tasks; an integration record, which names none, to its epic.
  const sharesTask = (a: RawRow, b: RawRow): boolean =>
    a.tasks.length === 0 || b.tasks.length === 0
      ? a.tasks.length === b.tasks.length && a.epic === b.epic
      : a.tasks.some((t) => b.tasks.includes(t));
  const fixedLater = (r: RawRow): boolean =>
    (passesOf.get(r.name) ?? []).some(
      (p) =>
        p.seq > r.seq &&
        (r.cmd_sha256 === null || p.identity === r.identity) &&
        (r.tree_sha === null || p.tree_sha === null || p.tree_sha !== r.tree_sha) &&
        sharesTask(r, p) &&
        realChange(r.tree_sha, p.tree_sha),
    );

  // Decision order: not-run, env, flaky, real, unconfirmed.
  for (const r of rows) {
    if (r.outcome === 'not-run') {
      r.class = 'not-run';
      continue;
    }
    if (r.outcome === 'pass') continue;
    const revert = confirmed.get(r.event_id);
    const reverted = revert?.names.has(r.name) === true;
    if (r.slept) r.class = 'env';
    else if (r.tree_sha !== null && passedAt.has(`${r.identity}|${r.tree_sha}`)) r.class = 'flaky';
    else if (reverted || fixedLater(r)) r.class = 'real';
    else r.class = 'unconfirmed';
    if (reverted && r.class === 'real' && revert !== undefined) r.tasks = [...revert.tasks];
    if (r.class === 'real' || r.class === 'unconfirmed') {
      r.severity = r.tasks.some(sensitive) ? 'S1' : 'S2';
    }
  }

  // Unique catch: every faster check was observed passing at the same tree.
  const medians = new Map<string, number>();
  const measuredBy = new Map<string, number[]>();
  for (const r of live) {
    if (r.cmd_sha256 === null || r.duration_ms === null) continue;
    measuredBy.set(r.identity, [...(measuredBy.get(r.identity) ?? []), r.duration_ms]);
  }
  for (const [id, ms] of measuredBy) medians.set(id, median(ms) as number);
  for (const r of rows) {
    if (r.class !== 'real') continue;
    const mine = medians.get(r.identity);
    const faster = [...medians].filter(
      ([id, m]) => mine !== undefined && m < mine && id !== r.identity,
    );
    const observed = (id: string): boolean =>
      passedIn.has(`${r.event_id}|${id}`) ||
      (r.tree_sha !== null && passedAt.has(`${id}|${r.tree_sha}`));
    r.catch = faster.every(([id]) => observed(id)) ? 'unique' : 'shadowed';
  }

  // Per identity.
  const groups = new Map<string, RawRow[]>();
  for (const r of rows) groups.set(r.identity, [...(groups.get(r.identity) ?? []), r]);
  const nameOnly = new Map<string, RawRow[]>();
  for (const r of rows) {
    if (r.cmd_sha256 === null) nameOnly.set(r.name, [...(nameOnly.get(r.name) ?? []), r]);
  }
  const ids = (rs: RawRow[]): string[] =>
    uniq([...rs].sort((a, b) => a.seq - b.seq).map((r) => r.event_id));

  const checks: LedgerCheck[] = [];
  for (const [identity, own] of groups) {
    const first = own[0] as RawRow;
    const measuredIdentity = first.cmd_sha256 !== null;
    // A name-only row counts toward catches and guards of every identity with its name.
    const protecting = measuredIdentity ? [...own, ...(nameOnly.get(first.name) ?? [])] : own;
    const counted = measuredIdentity
      ? own.filter((r) => r.outcome !== 'not-run' && inWindow(r.ts))
      : [];
    const timed = counted.filter((r) => r.duration_ms !== null);
    const minutesOf = (rs: RawRow[]): number =>
      rs.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / 60_000;
    const minutes = minutesOf(timed);
    const flaky = counted.filter((r) => r.class === 'flaky');
    const real = protecting.filter((r) => r.class === 'real' && inWindow(r.ts));
    const unique = own.filter((r) => r.catch === 'unique' && inWindow(r.ts));
    const unconfirmed = protecting.filter((r) => r.class === 'unconfirmed' && inWindow(r.ts));
    const guards = protecting.filter(
      (r) =>
        (r.outcome !== 'not-run' &&
          (r.source === 'gate' || r.source === 'queue') &&
          guardWindow(r.ts) &&
          r.tasks.some(sensitive)) ||
        ((r.class === 'real' || r.class === 'unconfirmed') && r.severity === 'S1'),
    );
    const bySource = Object.fromEntries(
      SOURCES.map((s) => {
        const rs = counted.filter((r) => r.source === s);
        return [
          s,
          { runs: rs.length, minutes: minutesOf(rs.filter((r) => r.duration_ms !== null)) },
        ];
      }),
    ) as LedgerCheck['by_source'];
    const s1 = real.filter((r) => r.severity === 'S1');
    const s2 = real.filter((r) => r.severity === 'S2');
    checks.push({
      name: first.name,
      cmd_sha256: first.cmd_sha256,
      identity,
      runs: counted.length,
      minutes,
      unmeasured: counted.length - timed.length,
      not_run: own.filter((r) => r.outcome === 'not-run' && inWindow(r.ts)).length,
      median_minutes: (() => {
        const m = median(timed.map((r) => r.duration_ms as number));
        return m === null ? null : m / 60_000;
      })(),
      flake_rate: counted.length === 0 ? 0 : flaky.length / counted.length,
      importance:
        minutes === 0
          ? 0
          : unique.reduce((s, r) => s + SEVERITY_WEIGHTS[r.severity ?? 'S2'], 0) / minutes,
      real_catches: real.length,
      unique_catches: unique.length,
      s1_catches: s1.length,
      s2_catches: s2.length,
      unconfirmed: unconfirmed.map((r) => ({
        event_id: r.event_id,
        severity: r.severity ?? 'S2',
      })),
      guards_sensitive: guards.length > 0,
      by_source: bySource,
      event_ids: {
        runs: ids(counted),
        minutes: ids(timed),
        unmeasured: ids(counted.filter((r) => r.duration_ms === null)),
        not_run: ids(own.filter((r) => r.outcome === 'not-run' && inWindow(r.ts))),
        flaky: ids(flaky),
        real_catches: ids(real),
        unique_catches: ids(unique),
        s1_catches: ids(s1),
        s2_catches: ids(s2),
        unconfirmed: ids(unconfirmed),
        guards_sensitive: ids(guards),
      },
    });
  }

  const merges = [...mergeKeys];
  return {
    rows,
    checks,
    project: {
      post_merge_runs: postMergeRuns.length,
      post_merge_run_ids: postMergeRuns,
      task_merges: merges.length,
      epics_with_merges: new Set(merges.map(epicOfTaskId).filter((e) => e !== null)).size,
      merges_per_post_merge_run:
        postMergeRuns.length === 0 ? null : merges.length / postMergeRuns.length,
    },
  };
}
