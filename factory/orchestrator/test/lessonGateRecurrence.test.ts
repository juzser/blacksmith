import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { templateFileFor } from '../src/agentNames.js';
import { GATE_BLOCKED_REASONS } from '../src/errorIssues.js';
import { appendEvent, type StoredEvent, startSession } from '../src/events.js';
import { readRecurrenceEvents } from '../src/lessonEvents.js';
import {
  errorClassCounts,
  GATE_BLOCK_ERROR_CLASSES,
  RECUR_WINDOW_DAYS,
} from '../src/lessonRecurrence.js';
import { lessonsForDispatch } from '../src/lessons.js';
import { loadTaxonomy, validateErrorClass } from '../src/taxonomy.js';
import { runProcess } from './helpers/process.js';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const WINDOW = { now: NOW, windowDays: RECUR_WINDOW_DAYS };
const RECENT = '2026-10-20T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
function gate(
  task: string | null,
  payload: Record<string, unknown>,
  opts: { ts?: string; session?: string } = {},
): StoredEvent {
  n += 1;
  return {
    event_id: `s:${n}`,
    record: {
      session_id: opts.session ?? 's',
      actor: 'orchestrator',
      event_type: 'gate-outcome',
      plan_version: 1,
      causal_parent: null,
      ts: opts.ts ?? RECENT,
      ...(task ? { task_id: task } : {}),
      payload: { outcome: 'blocked', reason: 'tests-failed', ...payload },
    },
  };
}
function logged(task: string, error: string): StoredEvent {
  n += 1;
  return {
    event_id: `s:${n}`,
    record: {
      session_id: 's',
      actor: 'orchestrator',
      event_type: 'error-logged',
      plan_version: 1,
      causal_parent: null,
      ts: RECENT,
      task_id: task,
      payload: { error, severity: 'S3-minor', task_ref: task },
    },
  };
}
const three = (payload: Record<string, unknown>) =>
  ['e1/a', 'e1/b', 'e2/c'].map((t) => gate(t, payload));
const tasksOf = (events: StoredEvent[], cls: string) => errorClassCounts(events, WINDOW).get(cls);

describe('GATE_BLOCK_ERROR_CLASSES', () => {
  it('holds exactly one entry per gate block reason', () => {
    expect(Object.keys(GATE_BLOCK_ERROR_CLASSES).sort()).toEqual([...GATE_BLOCKED_REASONS].sort());
  });

  it('maps every non-null entry to a class the taxonomy knows', () => {
    const taxonomy = loadTaxonomy();
    for (const value of Object.values(GATE_BLOCK_ERROR_CLASSES)) {
      if (value !== null) expect(() => validateErrorClass(taxonomy, value)).not.toThrow();
    }
  });

  it('holds the decided mapping', () => {
    expect(GATE_BLOCK_ERROR_CLASSES).toEqual({
      'schema-invalid': 'contract.schema-violation',
      'artifacts-missing': 'contract.schema-violation',
      'screenshots-missing': 'contract.schema-violation',
      'grader-invalid': 'contract.schema-violation',
      'not-committed': 'contract.uncommitted-work',
      'deps-missing': 'execution.env-failure',
      'tests-failed': 'execution.test-failure',
      'judges-outstanding': null,
      'uiux-spec-missing': null,
      'uiux-visual-missing': null,
      'screenshots-stale': null,
      'grader-fail': null,
      'coverage-evidence': null,
      findings: null,
    });
  });
});

describe('errorClassCounts over blocked gate-outcomes', () => {
  it('counts a blocked gate on three tasks under its reason class', () => {
    const c = tasksOf(three({}), 'execution.test-failure');
    expect(c?.tasks).toBe(3);
    expect(c?.epics.get('e1')).toBe(2);
  });

  it('counts a pass and a pass-with-waivers-pending nowhere', () => {
    const events = [
      ...three({ outcome: 'pass', reason: 'tests-failed' }),
      ...three({ outcome: 'pass-with-waivers-pending', reason: 'tests-failed' }),
    ];
    expect(errorClassCounts(events, WINDOW).size).toBe(0);
  });

  it('counts every non-null reason under its class and every null reason nowhere', () => {
    for (const reason of GATE_BLOCKED_REASONS) {
      const cls = GATE_BLOCK_ERROR_CLASSES[reason];
      const counts = errorClassCounts(three({ reason }), WINDOW);
      if (cls === null) expect(counts.size, reason).toBe(0);
      else expect(counts.get(cls)?.tasks, reason).toBe(3);
    }
  });

  it('counts a reason the map does not hold, or none, nowhere', () => {
    expect(errorClassCounts(three({ reason: 'not-a-reason' }), WINDOW).size).toBe(0);
    expect(errorClassCounts(three({ reason: undefined }), WINDOW).size).toBe(0);
    expect(errorClassCounts(three({ reason: 'toString' }), WINDOW).size).toBe(0);
  });

  it('lets a stamped error_class win over the reason class', () => {
    const counts = errorClassCounts(three({ error_class: 'execution.env-failure' }), WINDOW);
    expect(counts.get('execution.env-failure')?.tasks).toBe(3);
    expect(counts.has('execution.test-failure')).toBe(false);
  });

  it('falls back to the reason class on an empty or non-string error_class', () => {
    for (const error_class of ['', 7, null, {}]) {
      const counts = errorClassCounts(three({ error_class }), WINDOW);
      expect(counts.get('execution.test-failure')?.tasks, String(error_class)).toBe(3);
      expect(counts.size).toBe(1);
    }
  });

  it('lets a stamped error_class count even when the reason maps to null', () => {
    const counts = errorClassCounts(
      three({ reason: 'findings', error_class: 'execution.env-failure' }),
      WINDOW,
    );
    expect(counts.get('execution.env-failure')?.tasks).toBe(3);
  });

  it('counts a task blocked twice under one class once', () => {
    const counts = errorClassCounts([gate('e1/a', {}), gate('e1/a', {})], WINDOW);
    expect(counts.get('execution.test-failure')?.tasks).toBe(1);
  });

  it('counts a blocked env gate plus an error-logged env-failure on one task once', () => {
    const counts = errorClassCounts(
      [
        gate('e1/a', { error_class: 'execution.env-failure' }),
        logged('e1/a', 'execution.env-failure'),
      ],
      WINDOW,
    );
    expect(counts.get('execution.env-failure')?.tasks).toBe(1);
  });

  it('counts a task blocked under two classes once in each', () => {
    const counts = errorClassCounts(
      [gate('e1/a', {}), gate('e1/a', { reason: 'not-committed' })],
      WINDOW,
    );
    expect(counts.get('execution.test-failure')?.tasks).toBe(1);
    expect(counts.get('contract.uncommitted-work')?.tasks).toBe(1);
  });

  it('counts an unqualified task id store-wide under the id and toward no epic', () => {
    const counts = errorClassCounts(
      [
        gate('task-1', {}, { session: 'a' }),
        gate('task-1', {}, { session: 'b' }),
        gate('task-2', {}),
      ],
      WINDOW,
    );
    expect(counts.get('execution.test-failure')?.tasks).toBe(2);
    expect(counts.get('execution.test-failure')?.epics.size).toBe(0);
  });

  it('reads the task from payload.task_ref when the envelope has none, and skips a taskless gate', () => {
    const counts = errorClassCounts([gate(null, { task_ref: 'e1/a' }), gate(null, {})], WINDOW);
    expect(counts.get('execution.test-failure')?.tasks).toBe(1);
    expect(counts.get('execution.test-failure')?.epics.get('e1')).toBe(1);
  });

  it('reads the epic from payload.epic_id before the task id', () => {
    const counts = errorClassCounts([gate('e1/a', { epic_id: 'e9' })], WINDOW);
    expect(counts.get('execution.test-failure')?.epics.get('e9')).toBe(1);
    expect(counts.get('execution.test-failure')?.epics.has('e1')).toBe(false);
  });

  it('counts a gate exactly on the window boundary and not a millisecond older', () => {
    const edge = new Date(NOW.getTime() - RECUR_WINDOW_DAYS * DAY);
    const on = gate('e1/a', {}, { ts: edge.toISOString() });
    const older = gate('e1/b', {}, { ts: new Date(edge.getTime() - 1).toISOString() });
    expect(tasksOf([on], 'execution.test-failure')?.tasks).toBe(1);
    expect(errorClassCounts([older], WINDOW).size).toBe(0);
  });
});

describe('readRecurrenceEvents over blocked gate-outcomes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-gate-recur-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const line = (type: string, ts: string, payload: Record<string, unknown>) =>
    `${JSON.stringify({
      ts,
      session_id: 'x',
      actor: 'orchestrator',
      event_type: type,
      plan_version: 1,
      causal_parent: null,
      task_id: 'e1/a',
      payload,
    })}\n`;
  function session(id: string, lines: string[], ageDays = 1): void {
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.join(''));
    const when = new Date(NOW.getTime() - ageDays * DAY);
    utimesSync(file, when, when);
  }

  it('keeps blocked gates and error-logged in the window, drops older and passing ones', async () => {
    session('a', [
      line('gate-outcome', RECENT, { outcome: 'blocked', reason: 'tests-failed' }),
      line('gate-outcome', RECENT, { outcome: 'pass' }),
      line('gate-outcome', '2026-08-01T00:00:00.000Z', {
        outcome: 'blocked',
        reason: 'tests-failed',
      }),
      line('error-logged', RECENT, { error: 'execution.flaky-test', severity: 'S3-minor' }),
      line('result', RECENT, {}),
    ]);
    const events = await readRecurrenceEvents(dir, WINDOW);
    expect(events.map((e) => [e.record.event_type, e.record.payload.outcome])).toEqual([
      ['gate-outcome', 'blocked'],
      ['error-logged', undefined],
    ]);
  });

  it('keeps the cost bound: one stat per file, one read per in-window file, none for an old one', async () => {
    session(
      'old',
      [line('gate-outcome', RECENT, { outcome: 'blocked', reason: 'tests-failed' })],
      60,
    );
    session('new', [line('gate-outcome', RECENT, { outcome: 'blocked', reason: 'tests-failed' })]);
    session('new2', [line('gate-outcome', RECENT, { outcome: 'blocked', reason: 'tests-failed' })]);
    const stat = vi.fn((file: string) => ({ mtimeMs: statSync(file).mtimeMs }));
    const read = vi.fn(async (_id: string, _o: { stateDir: string }) => [] as StoredEvent[]);
    await readRecurrenceEvents(dir, WINDOW, { stat, readEvents: read });
    expect(stat).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(['new', 'new2']);
  });
});

const LESSONS_MD = `## stack-wide

### lesson-test: test failure

- lesson_id: lesson-test
- error_class: execution.test-failure
- statement: Test failure rule.
`;

describe('lessonsForDispatch with blocked gates', () => {
  let dir: string;
  let agentsDir: string;
  let lessonsPath: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-gate-lessons-'));
    agentsDir = path.join(dir, 'agents');
    mkdirSync(agentsDir);
    lessonsPath = path.join(dir, 'lessons.md');
    writeFileSync(lessonsPath, LESSONS_MD);
    writeFileSync(path.join(agentsDir, templateFileFor('coder')), '<!-- LESSONS:stack-wide -->\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (events: StoredEvent[], epicId?: string) =>
    lessonsForDispatch('coder', [], {
      agentsDir,
      lessonsPath,
      caseType: 'feature',
      now: NOW,
      events,
      full: true,
      ...(epicId ? { epicId } : {}),
    });
  const ids = (r: ReturnType<typeof run>) => (r.lessons ?? []).map((l) => l.lessonId);

  it('splices the class lesson on three blocked tests-failed gates and withholds nothing', () => {
    const r = run(three({}));
    expect(ids(r)).toEqual(['lesson-test']);
    expect(r.text).not.toContain('Withheld lessons');
  });

  it('withholds it on two, and on three non-failing outcomes', () => {
    expect(ids(run(three({}).slice(0, 2)))).toEqual([]);
    expect(ids(run(three({ outcome: 'pass' })))).toEqual([]);
  });

  it('makes the class repeat in the task id epic only', () => {
    const events = [gate('e1/a', {})];
    expect(ids(run(events, 'e1'))).toEqual(['lesson-test']);
    expect(ids(run(events, 'e2'))).toEqual([]);
    expect(ids(run(events))).toEqual([]);
  });
});

describe('lessons for-dispatch CLI over blocked gates', () => {
  const CLI = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'smith-gate-cli-'));
    mkdirSync(path.join(dir, 'agents'));
    writeFileSync(path.join(dir, 'lessons.md'), LESSONS_MD);
    writeFileSync(
      path.join(dir, 'agents', templateFileFor('coder')),
      '<!-- LESSONS:stack-wide -->\n',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function dispatch(stateDir: string) {
    const r = runProcess(
      'node',
      [
        CLI,
        'lessons',
        'for-dispatch',
        'coder',
        '--case-type',
        'feature',
        '--lessons',
        path.join(dir, 'lessons.md'),
        '--agents-dir',
        path.join(dir, 'agents'),
        '--state-dir',
        stateDir,
      ],
      { env: { ...process.env, BS_HOME: dir } },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { text: string };
  }

  it('splices on three blocked gates and withholds over an empty store', async () => {
    const stateDir = path.join(dir, 'events');
    mkdirSync(stateDir);
    expect(dispatch(stateDir).text).not.toContain('Test failure rule.');
    await startSession('sess', { stateDir });
    for (const t of ['p-a/task-1', 'p-b/task-2', 'p-c/task-3']) {
      await appendEvent(
        {
          session_id: 'sess',
          actor: 'orchestrator',
          event_type: 'gate-outcome',
          task_id: t,
          plan_version: 1,
          causal_parent: 'sess#0',
          payload: { outcome: 'blocked', reason: 'tests-failed' },
        },
        { stateDir },
      );
    }
    expect(dispatch(stateDir).text).toContain('Test failure rule.');
  });
});
