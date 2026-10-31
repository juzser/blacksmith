// Event fixtures for the check ledger (task-8). Every `testgate-result`,
// `integration-check` and `queue-tier-run` payload is built from a RunResult
// that a real `testgate.run` call returned with injected clock sources, and
// carries `results` and `environment` side by side exactly as gate.ts,
// integration.ts and queue.ts write them. No helper puts `environment` on a
// result: there is no such field.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StoredEvent } from '../../src/events.js';
import type { LedgerInputs } from '../../src/ledgerInputs.js';
import { type CheckCommand, type RunResult, run } from '../../src/testgate.js';

export const NOW = Date.parse('2026-10-30T12:00:00Z');
const DAY_MS = 86_400_000;
export const tsAgo = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString();

export interface CheckSpec {
  name: string;
  /** Whether the command exits 0. The command text never depends on it. */
  pass: boolean;
  /** `monotonic_ms` of the check's window; default 1000. */
  monotonicMs?: number;
  /** `wall_ms` of the window; default `monotonicMs`, so no clock gap. */
  wallMs?: number;
  /** Heavy check whose lock wait times out: it never runs (`heavy.wait-timeout`). */
  notRun?: boolean;
  /** Appended to the command as a comment, so the same name gets another `cmd_sha256`. */
  variant?: string;
}

/**
 * A real `testgate.run` over `specs`, in order, every check run. The command
 * of a name is the same whether it passes or fails (`test -f ok-<name>`), so
 * a pass and a fail of one check share one `cmd_sha256`.
 */
export async function realRun(specs: CheckSpec[]): Promise<RunResult> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ledger-run-'));
  const lockDir = mkdtempSync(path.join(tmpdir(), 'ledger-lock-'));
  writeFileSync(
    path.join(lockDir, 'heavy.lock'),
    JSON.stringify({ pid: 4242, token: 'other', label: 'other', startedAt: 'x', cwd: '/x' }),
  );
  const measured = specs.filter((s) => s.notRun !== true);
  const wall: number[] = [];
  const mono: number[] = [];
  for (const s of measured) {
    wall.push(0, s.wallMs ?? s.monotonicMs ?? 1000);
    mono.push(0, s.monotonicMs ?? 1000);
  }
  const next = (values: number[]) => () => {
    const v = values.shift();
    if (v === undefined) throw new Error('clock read more often than the fixture planned');
    return v;
  };
  try {
    const checks: CheckCommand[] = specs.map((s) => {
      if (s.pass && s.notRun !== true) writeFileSync(path.join(cwd, `ok-${s.name}`), '');
      return {
        name: s.name,
        cmd: `test -f ok-${s.name}${s.variant === undefined ? '' : ` # ${s.variant}`}`,
        heavy: s.notRun === true,
      };
    });
    return await run(checks, {
      cwd,
      runAll: true,
      heavyLock: { lockDir, pollMs: 5, maxWaitMs: 30, isPidAlive: () => true },
      environmentSources: {
        wallMs: next(wall),
        monotonicMs: next(mono),
        load1m: () => 0.5,
        cpus: () => 4,
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
}

interface EventBits {
  id: string;
  type: string;
  task?: string;
  payload: Record<string, unknown>;
  daysAgo?: number;
}

function event(b: EventBits): StoredEvent {
  return {
    event_id: b.id,
    record: {
      session_id: 'sess',
      actor: 'orchestrator',
      event_type: b.type,
      ...(b.task === undefined ? {} : { task_id: b.task }),
      plan_version: 1,
      causal_parent: null,
      payload: b.payload,
      ts: tsAgo(b.daysAgo ?? 1),
    },
  };
}

interface Common {
  run: RunResult;
  tree: string;
  daysAgo?: number;
}

/** A task gate's `testgate-result`: `results` and `environment` side by side. */
export function gateEvent(id: string, o: Common & { task: string }): StoredEvent {
  return event({
    id,
    type: 'testgate-result',
    task: o.task,
    daysAgo: o.daysAgo,
    payload: {
      pass: o.run.pass,
      results: o.run.results,
      environment: o.run.environment,
      tier: 'pre-merge',
      tree_sha: o.tree,
      deferred: [],
    },
  });
}

/** One `queue-tier-run`: the candidate's task ids, `results` and `environment` side by side. */
export function queueEvent(
  id: string,
  o: Common & { epic: string; taskIds: string[]; runId?: string },
): StoredEvent {
  return event({
    id,
    type: 'queue-tier-run',
    task: `${o.epic}/integration`,
    daysAgo: o.daysAgo,
    payload: {
      epic_id: o.epic,
      task_ids: o.taskIds,
      mode: 'step',
      run_id: o.runId ?? id,
      tree_sha: o.tree,
      pass: o.run.pass,
      results: o.run.results,
      environment: o.run.environment,
    },
  });
}

/** An `integration-check` record, with task-5's fields. */
export function integrationEvent(
  id: string,
  o: Common & { epic: string; tiers?: string[]; probeOf?: string },
): StoredEvent {
  return event({
    id,
    type: 'integration-check',
    task: `${o.epic}/integration`,
    daysAgo: o.daysAgo,
    payload: {
      epic_id: o.epic,
      branch: `bs/${o.epic}/integration`,
      head_sha: `head-${o.tree}`,
      pass: o.run.pass,
      results: o.run.results,
      tiers: o.tiers ?? ['pre-merge'],
      tiers_present: ['pre-merge'],
      tree_sha: o.tree,
      not_run: o.run.results.filter((r) => r.reason === 'heavy.wait-timeout').map((r) => r.name),
      environment: o.run.environment,
      ...(o.probeOf === undefined ? {} : { probe_of: o.probeOf }),
    },
  });
}

/** A queue landing: a `wave-merged` that names its run and adds no run of its own. */
export function mergedEvent(
  id: string,
  o: { task: string; preLandingRunId?: string; daysAgo?: number },
): StoredEvent {
  return event({
    id,
    type: 'wave-merged',
    task: o.task,
    daysAgo: o.daysAgo,
    payload: {
      task_ids: [o.task],
      merge_sha: 'a'.repeat(40),
      pre_landing: 'pre-merge-tier',
      ...(o.preLandingRunId === undefined ? {} : { pre_landing_run_id: o.preLandingRunId }),
    },
  });
}

/** A `wave-reverted` that confirms a culprit from a red record. */
export function revertedEvent(
  id: string,
  o: { task: string; epic: string; evidence: string[]; failingChecks: string[] },
): StoredEvent {
  return event({
    id,
    type: 'wave-reverted',
    task: o.task,
    payload: {
      epic_id: o.epic,
      revert_sha: 'b'.repeat(40),
      disposition: 'bounce',
      task_ids: [o.task],
      reverted_merge_sha: 'a'.repeat(40),
      failing_checks: o.failingChecks,
      evidence_event_ids: o.evidence,
    },
  });
}

/**
 * The four inputs of `checkLedger`, as task-13 builds them: every event names
 * its task through `taskIdOf` (a gate by its envelope; a queue or integration
 * record by the epic's reserved id), unless `unattributed` is asked for.
 */
export function ledgerInputs(
  events: StoredEvent[],
  claims: Record<string, string[]>,
  opts: { unattributed?: string[] } = {},
): Pick<LedgerInputs, 'events' | 'taskIdOf' | 'taskClaims' | 'sensitiveGlobs'> {
  const taskIdOf = new Map<string, string>();
  for (const e of events) {
    const task = e.record.task_id;
    if (task !== undefined) {
      taskIdOf.set(e.event_id, opts.unattributed?.includes(e.event_id) ? 'unattributed' : task);
    } else if (opts.unattributed?.includes(e.event_id)) {
      taskIdOf.set(e.event_id, 'unattributed');
    }
  }
  return {
    events,
    taskIdOf,
    taskClaims: new Map(Object.entries(claims)),
    sensitiveGlobs: ['src/auth/**'],
  };
}
