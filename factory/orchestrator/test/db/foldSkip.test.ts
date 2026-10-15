import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  feedbackFoldReads,
  findingsFoldReads,
  lessonsFoldReads,
  tasksFoldReads,
} from '../../src/db/foldPredicates.js';
import { openDb, openProjection, rebuild } from '../../src/db/projector.js';
import { appendEvent, type EventInput, type StoredEvent } from '../../src/events.js';
import { recordFeedback, resolveFeedback } from '../../src/feedback.js';
import { raiseFinding, transition } from '../../src/findings.js';

const PREDICATES = {
  tasks: tasksFoldReads,
  findings: findingsFoldReads,
  lessons: lessonsFoldReads,
  feedback: feedbackFoldReads,
} as const;
type Fold = keyof typeof PREDICATES;

const SESSIONS = ['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5'];
const TASK = 'epic-a/task-1';

/** The folds whose predicate accepts the record: the expectation, not a hand-written list. */
function foldsReading(event: StoredEvent): Fold[] {
  return (Object.keys(PREDICATES) as Fold[]).filter((f) => PREDICATES[f](event.record)).sort();
}

describe('db/projector.ts — a batch skips the global folds it cannot change', () => {
  let stateDir: string;
  let specsDir: string;
  let dbDir: string;
  let folds: string[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-skip-events-'));
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-skip-specs-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-skip-db-'));
    folds = [];
    roots = new Map();
  });

  afterEach(async () => {
    for (const dir of [stateDir, specsDir, dbDir]) await rm(dir, { recursive: true, force: true });
  });

  const opts = () => ({ stateDir, specsDir, onFold: (name: string) => folds.push(name) });
  // Every event hangs off its session's root; the folds never read the chain.
  let roots: Map<string, string>;
  const ctx = (sessionId: string) => ({
    sessionId,
    planVersion: 1,
    causalParent: roots.get(sessionId) as string,
  });

  function append(
    sessionId: string,
    event_type: string,
    extra: Partial<EventInput> = {},
  ): Promise<StoredEvent> {
    return appendEvent(
      {
        session_id: sessionId,
        actor: 'orchestrator',
        event_type,
        plan_version: 1,
        causal_parent: event_type === 'session-start' ? null : (roots.get(sessionId) as string),
        payload: {},
        ...extra,
      },
      { stateDir },
    );
  }

  async function startAll(): Promise<void> {
    for (const id of SESSIONS) roots.set(id, (await append(id, 'session-start')).event_id);
  }

  describe('by event type', () => {
    const rows: { label: string; make: (sessionId: string) => Promise<StoredEvent> }[] = [
      {
        label: 'a lesson candidate naming no task or epic',
        make: (s) =>
          append(s, 'lesson-candidate-raised', {
            payload: {
              lesson_id: 'lesson-a',
              lesson_type: 'rule',
              lesson_level: 'principle',
              lesson_status: 'candidate',
              lesson_scope: 'stack-wide',
              statement: 'Prove a test discriminates before trusting it.',
              valid_from: '2026-01-01T00:00:00.000Z',
              provenance_event_ids: ['finding-a'],
              evidence: 'demo',
            },
          }),
      },
      {
        label: 'operator feedback on a task',
        make: async (s) =>
          (
            await recordFeedback(
              { taskId: TASK, body: 'Please take another pass.', feedbackId: 'fb-a' },
              ctx(s),
              { stateDir },
            )
          ).event,
      },
      {
        label: 'a task-added event',
        make: (s) =>
          append(s, 'task-added', {
            task_id: 'epic-a/task-2',
            payload: { epic_id: 'epic-a', case: 'feature', origin: 'user', task_status: 'todo' },
          }),
      },
      {
        label: 'an event of a type no fold compares against, naming nothing',
        make: (s) => append(s, 'demo-hub-noted', { payload: { note: 'tick' } }),
      },
    ];

    it('runs, per appended event, only the folds whose predicate accepts it', async () => {
      await startAll();
      const projection = openProjection(path.join(dbDir, 'smith.db'), opts());
      try {
        await projection.applySessions(SESSIONS);
        expect([...folds].sort()).toEqual(['feedback', 'findings', 'lessons', 'tasks']);
        for (const [i, row] of rows.entries()) {
          const sessionId = SESSIONS[i] as string;
          const event = await row.make(sessionId);
          folds.length = 0;
          await projection.applySessions([sessionId]);
          expect([...folds].sort(), row.label).toEqual(foldsReading(event));
        }
      } finally {
        projection.close();
      }
    });
  });

  describe('parity with rebuild()', () => {
    interface Step {
      session: string;
      run: () => Promise<StoredEvent | undefined>;
    }

    function writePlan(epicId: string, project: string): void {
      mkdirSync(path.join(specsDir, epicId), { recursive: true });
      writeFileSync(
        path.join(specsDir, epicId, 'plan-v1.json'),
        JSON.stringify({ project, tasks: [] }),
      );
    }

    const finding = (id: string) => ({
      finding: {
        finding_id: id,
        task_id: TASK,
        finding_category: 'correctness',
        severity: 'S2-major',
        finding_status: 'raised',
        summary: `defect ${id}`,
        failure_scenario: { inputs: 'n=5', expected: '5', actual: '4' },
        found_by: 'reviewer',
      },
      filePath: 'src/widget.ts',
    });

    function steps(): Step[] {
      const at = (session: string, type: string, extra: Partial<EventInput> = {}): Step => ({
        session,
        run: () => append(session, type, extra),
      });
      return [
        // epic-b has no project in its log; its plan file answers.
        { session: 'sess-1', run: async () => void writePlan('epic-b', 'project-b') },
        at('sess-1', 'task-added', {
          task_id: TASK,
          project: 'project-a',
          payload: { epic_id: 'epic-a', case: 'feature', origin: 'user', task_status: 'todo' },
        }),
        at('sess-1', 'task-added', {
          task_id: 'epic-b/task-1',
          payload: { epic_id: 'epic-b', case: 'feature', origin: 'user', task_status: 'todo' },
        }),
        at('sess-2', 'wave-admitted', { payload: { epic_id: 'epic-a', task_ids: [TASK] } }),
        at('sess-2', 'dispatch_decision', {
          task_id: TASK,
          payload: { agent_role: 'coder', provider: 'claude', model_tier: 'mid', model: 'm' },
        }),
        at('sess-2', 'task-result-recorded', {
          task_id: TASK,
          payload: { task_id: TASK, run_status: 'done', structured_output: {}, artifacts: [] },
        }),
        at('sess-2', 'judge-reported', { task_id: TASK, payload: { agent_role: 'reviewer' } }),
        {
          session: 'sess-2',
          run: async () => {
            await raiseFinding(finding('finding-a'), ctx('sess-2'), { stateDir });
            return undefined;
          },
        },
        {
          session: 'sess-2',
          run: async () => {
            await transition('finding-a', 'confirmed', ctx('sess-2'), { stateDir });
            return undefined;
          },
        },
        at('sess-2', 'finding-obligation-repaired', {
          payload: { finding_id: 'finding-a', amends_task_ids: [TASK] },
        }),
        at('sess-2', 'gate-outcome', { task_id: TASK, payload: { outcome: 'pass', reason: null } }),
        at('sess-2', 'error-logged', {
          task_id: 'epic-b/task-1',
          payload: {
            error: 'coordination.deadlock',
            severity: 'S1-stop-the-line',
            task_ref: 'epic-b/task-1',
          },
        }),
        at('sess-2', 'wave-merged', { payload: { epic_id: 'epic-a', task_ids: [TASK] } }),
        at('sess-2', 'task-superseded', { task_id: 'epic-b/task-1', payload: {} }),
        at('sess-2', 'task-reinstated', { task_id: 'epic-b/task-1', payload: {} }),
        at('sess-4', 'lesson-candidate-raised', {
          payload: {
            lesson_id: 'lesson-a',
            lesson_type: 'rule',
            lesson_level: 'principle',
            lesson_status: 'candidate',
            lesson_scope: 'stack-wide',
            statement: 'Prove a test discriminates before trusting it.',
            valid_from: '2026-01-01T00:00:00.000Z',
            provenance_event_ids: ['finding-a'],
            evidence: 'demo',
          },
        }),
        at('sess-4', 'lesson-status-changed', {
          payload: { lesson_id: 'lesson-a', to_status: 'approved' },
        }),
        at('sess-4', 'lesson-edited', {
          payload: { lesson_id: 'lesson-a', statement: 'Prove a test discriminates.' },
        }),
        at('sess-4', 'severity-decisions', { task_id: TASK, payload: { decisions: [] } }),
        {
          session: 'sess-5',
          run: async () =>
            (
              await recordFeedback(
                { taskId: TASK, body: 'One more pass.', feedbackId: 'fb-a' },
                ctx('sess-5'),
                { stateDir },
              )
            ).event,
        },
        {
          session: 'sess-5',
          run: () =>
            resolveFeedback({ feedbackId: 'fb-a', resolution: 'dismissed' }, ctx('sess-5'), {
              stateDir,
            }),
        },
        // Names only an epic.
        at('sess-5', 'operator-note', { payload: { epic_id: 'epic-a', note: 'epic-only' } }),
        // The continuation: closes epic-a without having planned it, then gets an
        // append no predicate accepts.
        at('sess-3', 'epic-closed', {
          task_id: 'epic-a/integration',
          payload: {
            epic_id: 'epic-a',
            closed_by: 'verdict',
            machine_verdict: 'go',
            machine_reason: null,
            override_rationale: null,
            blockers: [],
          },
        }),
        at('sess-3', 'demo-hub-noted', { payload: { note: 'tick' } }),
      ];
    }

    const fmt = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : String(v));

    /** Every table but drizzle's bookkeeping, read from sqlite_master. */
    function dumpTables(dbPath: string): Map<string, Record<string, unknown>[]> {
      const handle = openDb(dbPath, { stateDir, specsDir });
      try {
        const names = (
          handle.sqlite
            .prepare(
              `select name from sqlite_master where type = 'table'
               and name not like 'sqlite_%' and name not like '%drizzle%' order by name`,
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
        const out = new Map<string, Record<string, unknown>[]>();
        for (const name of names) {
          const cols = handle.sqlite.prepare(`pragma table_info("${name}")`).all() as {
            name: string;
            pk: number;
          }[];
          const keys = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
          const order = (keys.length > 0 ? keys : cols).map((c) => `"${c.name}"`).join(', ');
          out.set(
            name,
            handle.sqlite.prepare(`select * from "${name}" order by ${order}`).all() as Record<
              string,
              unknown
            >[],
          );
        }
        return out;
      } finally {
        handle.sqlite.close();
      }
    }

    async function firstMismatch(
      batchDb: string,
      label: string,
      only?: string[],
    ): Promise<string | null> {
      const rebuiltDb = path.join(dbDir, 'rebuilt.db');
      await rm(rebuiltDb, { force: true });
      await rebuild(rebuiltDb, 'all', { stateDir, specsDir });
      const batch = dumpTables(batchDb);
      const rebuilt = dumpTables(rebuiltDb);
      for (const [table, want] of rebuilt) {
        if (only && !only.includes(table)) continue;
        const got = batch.get(table) ?? [];
        const keys = Object.keys(want[0] ?? got[0] ?? {});
        for (let i = 0; i < Math.max(got.length, want.length); i++) {
          const g = got[i];
          const w = want[i];
          if (g === undefined || w === undefined) {
            return `${label}: ${table} row ${i}: ${g === undefined ? 'missing in batch' : 'missing in rebuild'}`;
          }
          for (const col of keys) {
            if (JSON.stringify(g[col]) !== JSON.stringify(w[col])) {
              const id = String(w.epic_id ?? w.task_id ?? w.event_id ?? w.session_id ?? i);
              return `${label}: ${table} ${id} ${col}: ${fmt(g[col])} (batch) vs ${fmt(w[col])} (rebuild)`;
            }
          }
        }
      }
      return null;
    }

    it('leaves every table as rebuild() builds it after every append', async () => {
      await startAll();
      const batchDb = path.join(dbDir, 'batch.db');
      const projection = openProjection(batchDb, opts());
      try {
        await projection.applySessions(SESSIONS);
        expect(await firstMismatch(batchDb, 'cold')).toBeNull();
        for (const [i, step] of steps().entries()) {
          await step.run();
          await projection.applySessions([step.session]);
          expect(await firstMismatch(batchDb, `step ${i}`)).toBeNull();
        }
        const handle = openDb(batchDb, { stateDir, specsDir });
        try {
          const row = handle.sqlite
            .prepare(`select project from epics where epic_id = 'epic-a'`)
            .get() as { project: string | null };
          expect(row.project).toBe('project-a');
        } finally {
          handle.sqlite.close();
        }
      } finally {
        projection.close();
      }
    });

    const ALL_FOLDS = ['feedback', 'findings', 'lessons', 'tasks'];
    const logOf = (session: string) => path.join(stateDir, `${session}.jsonl`);

    // Per-session rows are not the folds' to keep; the cases that skip a re-projection compare these.
    const GLOBAL = ['tasks', 'findings', 'lessons', 'operator_feedback', 'epics'];

    // Each case leaves a stale table behind unless the batch runs every fold,
    // then applies a batch whose new events (if any) no predicate accepts.
    const fallbacks: {
      guard: string;
      run: (p: ReturnType<typeof openProjection>) => Promise<void>;
      only?: string[];
    }[] = [
      {
        guard: 'a log that shrank',
        run: async (p) => {
          const lines = readFileSync(logOf('sess-1'), 'utf8').trimEnd().split('\n');
          writeFileSync(logOf('sess-1'), `${lines.slice(0, -1).join('\n')}\n`);
          await p.applySessions(['sess-1']);
        },
      },
      {
        guard: 'a cached session whose log vanished',
        only: GLOBAL,
        run: async (p) => {
          unlinkSync(logOf('sess-1'));
          await append('sess-2', 'demo-hub-noted', { payload: { note: 'tick' } });
          await p.applySessions(['sess-2']);
        },
      },
      {
        guard: 'a previous batch that did not settle',
        only: GLOBAL,
        run: async (p) => {
          // A plan file changes on disk with no event, so only a full run sees it.
          writePlan('epic-b', 'project-b');
          writeFileSync(logOf('sess-6'), 'not json\n');
          await p.applySessions(['sess-6']);
          await append('sess-2', 'demo-hub-noted', { payload: { note: 'tick' } });
          await p.applySessions(['sess-2']);
          unlinkSync(logOf('sess-6')); // rebuild() cannot read it
        },
      },
    ];

    it.each(fallbacks)('runs every fold after $guard', async ({ guard, run, only }) => {
      await startAll();
      const projection = openProjection(path.join(dbDir, 'batch.db'), opts());
      try {
        await projection.applySessions(SESSIONS);
        for (const step of steps().slice(1, 3)) {
          await step.run();
          await projection.applySessions([step.session]);
        }
        folds.length = 0;
        await run(projection);
        expect([...new Set(folds)].sort(), guard).toEqual(ALL_FOLDS);
        expect(await firstMismatch(path.join(dbDir, 'batch.db'), guard, only)).toBeNull();
      } finally {
        projection.close();
      }
    });

    it("reports the last findings run's skipped findings when the fold is skipped", async () => {
      await startAll();
      // A finding from before fingerprints existed, written past the guarded path.
      appendFileSync(
        logOf('sess-2'),
        `${JSON.stringify({
          session_id: 'sess-2',
          actor: 'reviewer',
          event_type: 'finding-raised',
          task_id: TASK,
          plan_version: 1,
          causal_parent: roots.get('sess-2'),
          ts: '2026-08-15T00:00:00.000Z',
          payload: finding('finding-legacy').finding,
        })}\n`,
      );
      const projection = openProjection(path.join(dbDir, 'batch.db'), opts());
      try {
        const cold = await projection.applySessions(SESSIONS);
        expect(cold.skippedFindings.map((s) => s.finding_id)).toEqual(['finding-legacy']);
        folds.length = 0;
        await append('sess-3', 'demo-hub-noted', { payload: { note: 'tick' } });
        const next = await projection.applySessions(['sess-3']);
        expect(folds).toEqual([]);
        expect(next.skippedFindings).toEqual(cold.skippedFindings);
      } finally {
        projection.close();
      }
    });
  });
});
