import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/projector.js';
import { openDb, rebuild } from '../../src/db/projector.js';
import {
  EVENT_KINDS,
  type TimelineEntry,
  type TimelineFilter,
  timeline,
  timelineEventTypes,
} from '../../src/db/queries.js';

const SESSION_A = 'par-a';
const SESSION_B = 'par-b';
const BASE = Date.UTC(2030, 5, 1);
const DECISION_TYPES = new Set([
  'waiver-granted',
  'waiver-denied',
  'lesson-status-changed',
  'operator-note',
]);

interface Draft {
  eventType: string;
  actor?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
  /** Index of the causal parent within the session; defaults to the previous line. */
  parent?: number;
}

function toLine(session: string, project: string, index: number, ts: number, d: Draft): string {
  return `${JSON.stringify({
    session_id: session,
    actor: d.actor ?? 'system',
    event_type: d.eventType,
    plan_version: 1,
    causal_parent: d.eventType === 'session-start' ? null : `${session}#${d.parent ?? index - 1}`,
    payload: d.payload ?? {},
    ts: new Date(ts).toISOString(),
    project,
    ...(d.taskId ? { task_id: d.taskId } : {}),
  })}\n`;
}

/** Session A: 276 lines in project-a, epic-a, holding every timeline event type. */
function sessionADrafts(): Draft[] {
  const types = timelineEventTypes().filter((t) => t !== 'session-start');
  const drafts: Draft[] = [{ eventType: 'session-start' }];
  let lastPrompt = 0;
  for (let k = 1; k < 276; k += 1) {
    const eventType =
      k <= types.length
        ? (types[k - 1] as string)
        : (['operator-note', 'dispatch_decision', 'gate-outcome', 'error-logged', 'user_prompt'][
            k % 5
          ] as string);
    const draft: Draft = { eventType };
    if (DECISION_TYPES.has(eventType)) draft.actor = k % 2 === 0 ? 'operator' : 'system';
    if (eventType === 'user_prompt') {
      draft.payload = { prompt: `prompt ${k}` };
      draft.parent = 0;
      lastPrompt = k;
    } else if (eventType === 'dispatch_decision') {
      draft.payload = { parent_prompt_id: `${SESSION_A}#${lastPrompt}` };
      draft.taskId = `epic-a/task-${(k % 5) + 1}`;
    } else if (k % 4 === 0) {
      draft.taskId = `epic-a/task-${(k % 5) + 1}`;
    } else if (k % 7 === 0) {
      draft.payload = { epic_id: 'epic-a' };
    }
    drafts.push(draft);
  }
  // Epic reference by qualified task id alone (no payload epic_id).
  drafts.push({ eventType: 'gate-outcome', taskId: 'epic-a/task-1' });
  return drafts;
}

/** Session B: 23 lines in project-b, epic-b, plus the one line that names both epics. */
function sessionBDrafts(): Draft[] {
  const drafts: Draft[] = [{ eventType: 'session-start' }];
  drafts.push({ eventType: 'user_prompt', payload: { prompt: 'first b prompt' }, parent: 0 });
  drafts.push({ eventType: 'user_prompt', payload: { prompt: 'second b prompt' }, parent: 0 });
  for (let j = 3; j < 22; j += 1) {
    const eventType = ['operator-note', 'gate-outcome', 'dispatch_decision', 'error-logged'][j % 4];
    const draft: Draft = { eventType: eventType as string, taskId: `epic-b/task-${j % 3}` };
    if (eventType === 'dispatch_decision') {
      draft.payload = { parent_prompt_id: j === 6 ? `${SESSION_A}#5` : `${SESSION_B}#1` };
    }
    if (eventType === 'operator-note') draft.actor = j % 2 === 0 ? 'operator' : 'system';
    drafts.push(draft);
  }
  // Task id names epic-a, payload names epic-b: the task id wins, and this is
  // the only reference tying session B to epic-a.
  drafts.push({
    eventType: 'gate-outcome',
    taskId: 'epic-a/task-2',
    payload: { epic_id: 'epic-b' },
  });
  return drafts;
}

function tsOf(ordinal: number): number {
  // Three consecutive ordinals share one ts.
  return BASE + Math.floor(ordinal / 3) * 1000;
}

describe('timeline() paged answers equal the unpaged list', () => {
  let stateDir: string;
  let dbDir: string;
  let handle: DbHandle;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'smith-parity-events-'));
    dbDir = await mkdtemp(path.join(tmpdir(), 'smith-parity-db-'));
    const a = sessionADrafts();
    const b = sessionBDrafts();
    expect(a.length + b.length).toBe(300);
    // Session B's ts values interleave with A's, so ties span both sessions.
    await appendFile(
      path.join(stateDir, `${SESSION_A}.jsonl`),
      a.map((d, i) => toLine(SESSION_A, 'project-a', i, tsOf(i), d)).join(''),
      'utf8',
    );
    await appendFile(
      path.join(stateDir, `${SESSION_B}.jsonl`),
      b.map((d, i) => toLine(SESSION_B, 'project-b', i, tsOf(i * 12), d)).join(''),
      'utf8',
    );
    const dbPath = path.join(dbDir, 'smith.db');
    await rebuild(dbPath, 'all', { stateDir });
    handle = openDb(dbPath);
  });

  afterEach(async () => {
    handle?.sqlite.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  const paths: Array<[string, TimelineFilter]> = [
    ['none', {}],
    ['epic-a', { epicId: 'epic-a' }],
    ['epic-b', { epicId: 'epic-b' }],
    ['taskId', { taskId: 'epic-a/task-1' }],
    ['session', { sessionId: SESSION_B }],
    ['project-a', { project: 'project-a' }],
    ['project-b', { project: 'project-b' }],
    ['eventTypes', { eventTypes: ['operator-note', 'user_prompt', 'gate-outcome'] }],
    ...EVENT_KINDS.map((kind): [string, TimelineFilter] => [`kind ${kind}`, { kinds: [kind] }]),
    ['decisionsOnly', { decisionsOnly: true }],
    ['decisionsOnly epic-a', { decisionsOnly: true, epicId: 'epic-a' }],
    ['decisionsOnly epic-b', { decisionsOnly: true, epicId: 'epic-b' }],
    ['kinds with epic', { kinds: ['Dispatched', 'Prompt'], epicId: 'epic-b' }],
  ];

  it('holds every event type and a store large enough to page', () => {
    const all = timeline(handle.db, {});
    const types = new Set(all.map((e) => e.eventType));
    for (const t of timelineEventTypes()) expect(types.has(t), t).toBe(true);
    expect(all.length).toBe(300);
    // The precedence pins: the task id names epic-a, so the payload's epic-b does not count.
    const underB = timeline(handle.db, { epicId: 'epic-b' }).map((e) => e.taskId);
    expect(underB).not.toContain('epic-a/task-2');
    const underA = timeline(handle.db, { epicId: 'epic-a' }).map((e) => e.taskId);
    expect(underA).toContain('epic-a/task-2');
  });

  it.each(paths)(
    '%s: every before page and an after page match the unpaged slice',
    (_name, filter) => {
      const oldestFirst: TimelineEntry[] = timeline(handle.db, filter);
      const newestFirst = oldestFirst.slice().reverse();
      // A filter that matches nothing proves nothing about paging.
      expect(newestFirst.length).toBeGreaterThan(0);

      let cursor: string | undefined;
      for (let offset = 0; offset < newestFirst.length; offset += 8) {
        const page = timeline(handle.db, {
          ...filter,
          limit: 8,
          ...(cursor ? { before: cursor } : {}),
        });
        const want = newestFirst.slice(offset, offset + 8);
        expect(page).toEqual(want);
        // A filtered page fills whenever enough matching rows remain.
        if (newestFirst.length - offset >= 8) expect(page).toHaveLength(8);

        const last = page[page.length - 1] as TimelineEntry;
        const probe = timeline(handle.db, { ...filter, limit: 1, before: last.eventId });
        expect(probe.length === 1).toBe(offset + 8 < newestFirst.length);
        cursor = last.eventId;
      }

      const middle = oldestFirst[Math.floor(oldestFirst.length / 3)] as TimelineEntry;
      const at = oldestFirst.indexOf(middle);
      const after = timeline(handle.db, { ...filter, limit: 8, after: middle.eventId });
      expect(after).toEqual(oldestFirst.slice(at + 1, at + 9).reverse());
    },
  );
});
