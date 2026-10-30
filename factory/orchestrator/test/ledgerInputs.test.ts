import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatherLedgerInputs } from '../src/ledgerInputs.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString();

interface Ev {
  type: string;
  task?: string;
  payload?: Record<string, unknown>;
  daysAgo?: number;
  parent?: string | null;
}

let root: string;
let stateDir: string;
let specsDir: string;
let sensitive: string;

function session(id: string, events: Ev[], raw?: string[]): void {
  const lines = events.map((e, i) =>
    JSON.stringify({
      session_id: id,
      actor: 'orchestrator',
      event_type: e.type,
      ...(e.task === undefined ? {} : { task_id: e.task }),
      plan_version: 1,
      causal_parent: e.parent === undefined ? (i === 0 ? null : `${id}#${i - 1}`) : e.parent,
      payload: e.payload ?? {},
      ts: iso(e.daysAgo ?? 1),
    }),
  );
  writeFileSync(path.join(stateDir, `${id}.jsonl`), `${[...lines, ...(raw ?? [])].join('\n')}\n`);
}

function plan(epic: string, file: string, body: unknown): void {
  mkdirSync(path.join(specsDir, epic), { recursive: true });
  writeFileSync(
    path.join(specsDir, epic, file),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

const task = (id: string, claims: string[]) => ({ task_id: id, claims });

function gather(windowDays = 30) {
  return gatherLedgerInputs({
    stateDir,
    specsDir,
    sensitivePathsFile: sensitive,
    now: new Date(NOW),
    windowDays,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ledger-inputs-'));
  stateDir = path.join(root, 'events');
  specsDir = path.join(root, 'specs');
  mkdirSync(stateDir);
  mkdirSync(specsDir);
  sensitive = path.join(root, 'sensitive.yml');
  writeFileSync(sensitive, 'globs:\n  - "src/auth/**"\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${p}|${st.mtimeMs}|${readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir);
  return out;
}

describe('gatherLedgerInputs', () => {
  it('keeps every event of the specs-dir epics across lineages, in or out of the window, and none of another epic', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['src/a/**'])] });
    plan('eb', 'plan.json', { project: 'proj', tasks: [task('eb/task-1', ['src/b/**'])] });
    session('s-a', [
      { type: 'session-start' },
      { type: 'testgate-result', task: 'ea/task-1', daysAgo: 2 },
      { type: 'testgate-result', task: 'ea/task-1', daysAgo: 400 },
    ]);
    session('s-b', [
      { type: 'session-start' },
      { type: 'testgate-result', task: 'eb/task-1', daysAgo: 5 },
    ]);
    session('s-c', [
      { type: 'session-start' },
      { type: 'testgate-result', task: 'ec/task-1', daysAgo: 1 },
    ]);

    const out = await gather();

    expect(out.events.map((e) => e.event_id).sort()).toEqual([
      's-a#0',
      's-a#1',
      's-a#2',
      's-b#0',
      's-b#1',
    ]);
    expect(out.sessionsRead).toBe(3);
    expect(out.epics.sort()).toEqual(['ea', 'eb']);
    expect(out.project).toBe('proj');
    expect(out.degraded).toBe(false);
    expect(out.warnings).toEqual([]);
    expect(out.sensitiveGlobs).toEqual(['src/auth/**']);
  });

  it('qualifies bare and qualified ids to one key that finds the same claims', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-3', ['src/a/**'])] });
    session('s-a', [
      { type: 'session-start', payload: { epic_id: 'ea' } },
      { type: 'testgate-result', task: 'task-3' },
      { type: 'testgate-result', task: 'ea/task-3' },
    ]);

    const out = await gather();

    expect(out.taskIdOf.get('s-a#1')).toBe('ea/task-3');
    expect(out.taskIdOf.get('s-a#2')).toBe('ea/task-3');
    expect(out.taskClaims.get('ea/task-3')).toEqual(['src/a/**']);
  });

  it('keeps a bare id as unattributed when the lineage names two epics', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    plan('eb', 'plan.json', { project: 'proj', tasks: [task('eb/task-1', ['y'])] });
    session('s-m', [
      { type: 'session-start' },
      { type: 'testgate-result', task: 'ea/task-1' },
      { type: 'testgate-result', task: 'eb/task-1' },
    ]);
    session('s-n', [
      { type: 'session-start', parent: 's-m#2' },
      { type: 'testgate-result', task: 'task-9' },
    ]);

    const out = await gather();

    expect(out.events.map((e) => e.event_id)).toContain('s-n#1');
    expect(out.taskIdOf.get('s-n#1')).toBe('unattributed');
    expect(out.taskClaims.has('unattributed')).toBe(false);
  });

  it('qualifies a bare id with the one epic its lineage names when its own session names none', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    session('s-a', [{ type: 'session-start' }, { type: 'testgate-result', task: 'ea/task-1' }]);
    session('s-n', [
      { type: 'session-start', parent: 's-a#1' },
      { type: 'testgate-result', task: 'task-9' },
    ]);

    const out = await gather();

    expect(out.taskIdOf.get('s-n#1')).toBe('ea/task-9');
  });

  it('keeps an event of an unrelated epic when its session lineage touches a specs epic', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    session('s-a', [{ type: 'session-start' }, { type: 'testgate-result', task: 'ea/task-1' }]);
    session('s-child', [
      { type: 'session-start', parent: 's-a#1' },
      { type: 'testgate-result', task: 'elsewhere/task-1' },
    ]);

    const out = await gather();

    expect(out.events.map((e) => e.event_id)).toContain('s-child#1');
    expect(out.taskIdOf.get('s-child#1')).toBe('elsewhere/task-1');
  });

  it('returns events 31 and 400 days old and the window bounds, filtering nothing by time', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    session('s-a', [
      { type: 'session-start', daysAgo: 500 },
      { type: 'testgate-result', task: 'ea/task-1', daysAgo: 31 },
      { type: 'testgate-result', task: 'ea/task-1', daysAgo: 400 },
    ]);

    const out = await gather(30);

    expect(out.events).toHaveLength(3);
    expect(out.window).toEqual({ from: new Date(NOW - 30 * DAY_MS), to: new Date(NOW) });
  });

  it('takes claims from the latest plan version and follow-up claims from task-added', async () => {
    plan('ea', 'plan.json', {
      project: 'proj',
      version: 1,
      tasks: [task('ea/task-1', ['old/**'])],
    });
    plan('ea', 'plan-v2.json', {
      project: 'proj',
      version: 2,
      tasks: [task('ea/task-1', ['new/**'])],
    });
    session('s-a', [
      { type: 'session-start' },
      {
        type: 'task-added',
        task: 'ea/followup-ab12cd34',
        payload: { epic_id: 'ea', claims: ['src/fix.ts'] },
      },
      {
        type: 'task-added',
        task: 'ea/task-1',
        payload: { epic_id: 'ea', claims: ['stale/**'] },
      },
    ]);

    const out = await gather();

    expect(out.taskClaims.get('ea/task-1')).toEqual(['new/**']);
    expect(out.taskClaims.get('ea/followup-ab12cd34')).toEqual(['src/fix.ts']);
  });

  it('skips a truncated plan with a named warning and reads an old-schema plan', async () => {
    plan('ea', 'plan.json', '{"project": "proj", "tasks": [{"task_id": "ea/ta');
    plan('eb', 'plan.json', {
      project: 'proj',
      tasks: [{ task_id: 'eb/task-1', claims: ['b/**'], legacy_field: true }],
    });
    session('s-a', [
      { type: 'session-start' },
      { type: 'task-added', task: 'ea/task-1', payload: { epic_id: 'ea', claims: ['a/**'] } },
      { type: 'testgate-result', task: 'ea/task-1' },
    ]);

    const out = await gather();

    expect(out.warnings).toEqual([
      expect.objectContaining({
        code: 'checks.plan-skipped',
        path: path.join(specsDir, 'ea', 'plan.json'),
      }),
    ]);
    expect(out.events.map((e) => e.event_id)).toContain('s-a#2');
    expect(out.taskClaims.has('ea/task-1')).toBe(false);
    expect(out.taskClaims.get('eb/task-1')).toEqual(['b/**']);
  });

  it('skips a plan that lacks a field it needs', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [{ task_id: 'ea/task-1' }] });
    plan('eb', 'plan.json', { project: 'proj', tasks: [task('eb/task-1', ['b'])] });

    const out = await gather();

    expect(out.warnings.map((w) => w.code)).toEqual(['checks.plan-skipped']);
    expect(out.epics.sort()).toEqual(['ea', 'eb']);
  });

  it('refuses plans that name two projects', async () => {
    plan('ea', 'plan.json', { project: 'one', tasks: [] });
    plan('eb', 'plan.json', { project: 'two', tasks: [] });

    await expect(gather()).rejects.toMatchObject({ code: 'checks.mixed-projects' });
  });

  it('refuses a specs dir with no readable plan', async () => {
    plan('ea', 'plan.json', '{ not json');

    await expect(gather()).rejects.toMatchObject({ code: 'checks.no-plans' });
  });

  it('marks the result degraded on a log with a non-JSON line and still returns the other sessions', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    session('s-a', [{ type: 'session-start' }, { type: 'testgate-result', task: 'ea/task-1' }]);
    session('s-bad', [{ type: 'session-start' }], ['this is not json']);

    const out = await gather();

    expect(out.degraded).toBe(true);
    expect(out.warnings).toEqual([
      expect.objectContaining({
        code: 'checks.session-unreadable',
        path: path.join(stateDir, 's-bad.jsonl'),
      }),
    ]);
    expect(out.events.map((e) => e.event_id)).toEqual(['s-a#0', 's-a#1']);
    expect(out.sessionsRead).toBe(1);
  });

  it('changes nothing in the state dir or the specs dir', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    session('s-a', [{ type: 'session-start' }, { type: 'testgate-result', task: 'ea/task-1' }]);
    const before = [...snapshot(stateDir), ...snapshot(specsDir)];

    await gather();

    expect([...snapshot(stateDir), ...snapshot(specsDir)]).toEqual(before);
  });

  it('ranks plans by file name when they carry no version field', async () => {
    plan('ea', 'plan-v10.json', { project: 'proj', tasks: [task('ea/task-1', ['ten/**'])] });
    plan('ea', 'plan-v2.json', { project: 'proj', tasks: [task('ea/task-1', ['two/**'])] });

    const out = await gather();

    expect(out.taskClaims.get('ea/task-1')).toEqual(['ten/**']);
  });

  it('qualifies a bare plan task id with its epic directory', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('task-1', ['a/**'])] });

    const out = await gather();

    expect(out.taskClaims.get('ea/task-1')).toEqual(['a/**']);
  });

  it('drops a session that touches no specs epic and keeps unattributed events of a kept one', async () => {
    plan('ea', 'plan.json', { project: 'proj', tasks: [task('ea/task-1', ['x'])] });
    session('s-a', [
      { type: 'session-start', payload: { epic_id: 'ea' } },
      { type: 'budget-alarm' },
      { type: 'testgate-result', task: 'ea/task-1' },
    ]);
    session('s-other', [{ type: 'session-start' }, { type: 'testgate-result', task: 'task-4' }]);

    const out = await gather();

    expect(out.events.map((e) => e.event_id)).toEqual(['s-a#0', 's-a#1', 's-a#2']);
    expect(out.taskIdOf.has('s-a#1')).toBe(false);
  });

  it('lets a plan that names a follow-up id win over its task-added record', async () => {
    plan('ea', 'plan.json', {
      project: 'proj',
      tasks: [task('ea/followup-ab12cd34', ['plan/**'])],
    });
    session('s-a', [
      { type: 'session-start' },
      {
        type: 'task-added',
        task: 'ea/followup-ab12cd34',
        payload: { epic_id: 'ea', claims: ['record/**'] },
      },
    ]);

    const out = await gather();

    expect(out.taskClaims.get('ea/followup-ab12cd34')).toEqual(['plan/**']);
  });
});
