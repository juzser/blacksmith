import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import { creditableTaskIds } from '../src/goalCheck.js';
import { loadEarlierPlans, type PlanFile } from '../src/plan.js';

const EPIC = 'epic-a';
const A = `${EPIC}/task-a`;
const B = `${EPIC}/task-b`;
const C = `${EPIC}/task-c`;

const plan = (version: number, tasks: [string, string][]): PlanFile =>
  ({
    epic_id: EPIC,
    version,
    status: 'active',
    edges: [],
    tasks: tasks.map(([task_id, task_status]) => ({ task_id, task_status })),
  }) as unknown as PlanFile;

const ev = (
  event_type: string,
  task_id?: string,
  payload: Record<string, unknown> = {},
): StoredEvent => ({
  event_id: `sess-x#${event_type}`,
  record: {
    session_id: 'sess-x',
    actor: 'system',
    event_type,
    task_id,
    plan_version: 1,
    causal_parent: null,
    payload,
  } as unknown as StoredEvent['record'],
});
const merged = (...ids: string[]) => ev('wave-merged', undefined, { task_ids: ids });

describe('creditableTaskIds', () => {
  // v1 carried A and B; an amendment dropped the finished A (draftNextVersion
  // removes a completed, unsuperseded id outright) and kept B.
  const v1 = plan(1, [
    [A, 'completed'],
    [B, 'todo'],
  ]);
  const v2 = plan(2, [[B, 'todo']]);

  it('credits the latest live tasks and nothing else when no log is given', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [])).toEqual([B]);
  });

  it('credits a task dropped from the latest version once the log reports it finished', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [merged(A)]).sort()).toEqual([A, B]);
  });

  it('never trusts a plan row that says completed without a merge in the log', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [])).not.toContain(A);
  });

  it('refuses an id the log superseded after its last merge', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [merged(A), ev('task-superseded', A)])).toEqual([B]);
  });

  it('refuses an id that is superseded in the latest version, merged or not', () => {
    const latest = plan(2, [
      [A, 'superseded'],
      [B, 'todo'],
    ]);
    expect(creditableTaskIds(EPIC, latest, [v1], [merged(A)])).toEqual([B]);
  });

  it('refuses an id whose only earlier record is a superseded one', () => {
    const earlier = plan(1, [
      [A, 'superseded'],
      [B, 'todo'],
    ]);
    expect(creditableTaskIds(EPIC, v2, [earlier], [merged(A)])).toEqual([B]);
  });

  it('ignores a finished id the log spells bare', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [merged('task-a')])).toEqual([B]);
  });

  it('ignores a finished id the log qualifies under another epic', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [merged('epic-z/task-a')])).toEqual([B]);
  });

  it('refuses an id that no plan version ever held, however finished the log says it is', () => {
    expect(creditableTaskIds(EPIC, v2, [v1], [merged(C)])).toEqual([B]);
  });
});

describe('loadEarlierPlans', () => {
  let specsDir: string;
  beforeEach(async () => {
    specsDir = await mkdtemp(path.join(tmpdir(), 'smith-earlier-plans-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(specsDir, EPIC), { recursive: true });
  });
  afterEach(async () => {
    await rm(specsDir, { recursive: true, force: true });
  });

  it('reads the versions below the given one and skips a version it cannot read', async () => {
    await writeFile(
      path.join(specsDir, EPIC, 'plan-v1.json'),
      JSON.stringify(plan(1, [[A, 'completed']])),
    );
    await writeFile(path.join(specsDir, EPIC, 'plan-v2.json'), '{ not json');
    await writeFile(
      path.join(specsDir, EPIC, 'plan-v4.json'),
      JSON.stringify(plan(4, [[B, 'todo']])),
    );
    const earlier = loadEarlierPlans(EPIC, 4, { specsDir });
    expect(earlier.map((p) => p.version)).toEqual([1]);
  });

  it('returns nothing when the epic has no plan directory', () => {
    expect(loadEarlierPlans('epic-none', 3, { specsDir })).toEqual([]);
  });
});
